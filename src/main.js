// AFTERGLO Technician - main process.
// Owns everything the window is not allowed to do itself: picking the USB
// port, downloading firmware, listening for controllers on the network.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dgram = require('dgram');

// Same feed the AFTERGLO app and afterglolighting.org/firmware.html read.
// SHARED CONTRACT: shape is { version, images: { <family>: { url, sha256, size, version } } }.
// See docs/firmware/README.md in the website repo before changing anything here.
// The v2 manifest: what current apps install. The original afterglo2_manifest.json
// is frozen at 1.3.1 for app builds older than 67 and must not be used here.
const MANIFEST_URL = 'https://raw.githubusercontent.com/gamesum/firmware-update/main/afterglo2_manifest_v2.json';
const RELEASE_PREFIX = 'https://github.com/gamesum/firmware-update/releases/download/';
const FAMILY = 'roofline';
const APP_SLOT_SIZE = 0x180000; // app0 / app1 in firmware/partitions_custom.csv
const BEACON_PORT = 4210;       // UDP broadcast of /api/v1/device every 10 s

// USB-serial chips found on controllers: CP210x, CH340/CH9102, FTDI, Espressif.
const USB_VENDORS = new Set([0x10c4, 0x1a86, 0x0403, 0x303a]);

let win = null;
let busy = false;           // a write to a controller is in progress
let pendingPortChoice = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function fwDir() {
  const d = path.join(app.getPath('userData'), 'firmware');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function fetchWithTimeout(url, ms, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

function validEntry(e) {
  return e && typeof e.url === 'string' && e.url.startsWith(RELEASE_PREFIX) &&
    /^[0-9a-f]{64}$/.test(e.sha256 || '') && Number.isInteger(e.size) &&
    e.size > 100000 && e.size <= APP_SLOT_SIZE;
}

// Newest published firmware. Falls back to the last copy this PC downloaded
// when GitHub cannot be reached, and says so.
async function latestFirmware() {
  const cachePath = path.join(fwDir(), 'manifest.json');
  let entry = null, online = false, problem = null;
  try {
    const res = await fetchWithTimeout(MANIFEST_URL + '?t=' + Date.now(), 15000, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const m = await res.json();
    const e = m.images && m.images[FAMILY];
    if (!validEntry(e)) throw new Error('The firmware list is not in the expected format.');
    entry = { version: e.version || m.version, url: e.url, sha256: e.sha256, size: e.size,
      minAppBuild: Number.isInteger(e.minAppBuild) ? e.minAppBuild : null, checkedAt: Date.now() };
    fs.writeFileSync(cachePath, JSON.stringify(entry));
    online = true;
  } catch (err) {
    problem = err.name === 'AbortError' ? 'Timed out' : err.message;
    try { entry = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (_) { entry = null; }
    if (entry && !validEntry(entry)) entry = null;
  }
  if (!entry) return { ok: false, problem };
  const binPath = path.join(fwDir(), entry.sha256 + '.bin');
  let downloaded = false;
  try { downloaded = sha256(fs.readFileSync(binPath)) === entry.sha256; } catch (_) {}
  return { ok: true, online, problem, downloaded, version: entry.version, sha256: entry.sha256, size: entry.size,
    minAppBuild: entry.minAppBuild || null, checkedAt: entry.checkedAt, url: entry.url };
}

// Returns the verified image bytes, downloading them if this PC has no copy.
async function firmwareBytes() {
  const info = await latestFirmware();
  if (!info.ok) throw new Error('Could not reach the firmware server and no firmware is saved on this computer. Connect to the internet and try again.');
  const binPath = path.join(fwDir(), info.sha256 + '.bin');
  try {
    const have = fs.readFileSync(binPath);
    if (sha256(have) === info.sha256) return { version: info.version, sha256: info.sha256, data: new Uint8Array(have) };
  } catch (_) {}
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithTimeout(info.url, 180000);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== info.size || sha256(buf) !== info.sha256) throw new Error('The download did not match its published checksum.');
      fs.writeFileSync(binPath, buf);
      return { version: info.version, sha256: info.sha256, data: new Uint8Array(buf) };
    } catch (err) { lastErr = err; }
  }
  throw new Error('Could not download firmware ' + info.version + ' (' + (lastErr && lastErr.message) + '). Nothing was written to the controller.');
}

// Bootloader, partition table and boot selector, built with the firmware and
// shipped inside this app (see recovery/README.md). Only Repair and Factory
// erase write these.
function recoveryFiles() {
  const dir = path.join(__dirname, '..', 'recovery');
  const read = n => new Uint8Array(fs.readFileSync(path.join(dir, n)));
  return { bootloader: read('bootloader.bin'), partitions: read('partitions.bin'), bootApp0: read('boot_app0.bin') };
}

// ── Controllers on the network ──────────────────────────────────────────────
const lanDevices = new Map(); // mac -> { ...device, address, seenAt }
function startBeaconListener() {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', () => { try { sock.close(); } catch (_) {} });
  sock.on('message', (msg, rinfo) => {
    if (msg.length > 2048) return;
    let d;
    try { d = JSON.parse(msg.toString('utf8')); } catch (_) { return; }
    if (!d || d.type !== 'afterglo' || typeof d.mac !== 'string') return;
    lanDevices.set(d.mac, { ...d, address: rinfo.address, seenAt: Date.now() });
    pushLan();
  });
  try { sock.bind(BEACON_PORT); } catch (_) {}
  setInterval(() => {
    let changed = false;
    for (const [mac, d] of lanDevices) if (Date.now() - d.seenAt > 45000) { lanDevices.delete(mac); changed = true; }
    if (changed) pushLan();
  }, 5000);
}
function pushLan() {
  if (win && !win.isDestroyed()) win.webContents.send('lan:update', [...lanDevices.values()]);
}

function isPrivateIp(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip || '');
  if (!m || m.slice(1).some(n => +n > 255)) return false;
  const [a, b] = [+m[1], +m[2]];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// Read-only on purpose: this tool never changes a controller's settings over
// the network. Only these GETs are ever sent.
const LAN_READS = { device: '/api/v1/device', network: '/api/v1/network', leds: '/api/v1/leds', state: '/api/v1/state', support: '/api/v1/support', schedule: '/api/v1/schedules/status' };
async function lanQuery(ip) {
  if (!isPrivateIp(ip)) throw new Error('That is not a local network address.');
  const out = {};
  // One at a time: the controller is a small device with few sockets.
  for (const [key, p] of Object.entries(LAN_READS)) {
    try {
      const res = await fetchWithTimeout('http://' + ip + p, key === 'device' ? 4000 : 3000);
      if (res.ok) out[key] = await res.json();
    } catch (_) {}
    if (key === 'device' && (!out.device || out.device.type !== 'afterglo')) {
      throw new Error('No AFTERGLO controller answered at ' + ip + '. Check this computer is on the same WiFi as the controller.');
    }
  }
  out.address = ip;
  return out;
}

// ── Window ──────────────────────────────────────────────────────────────────
function usbCandidate(p) {
  // Electron reports ids as strings; accept decimal or hex.
  const ids = [Number(p.vendorId), parseInt(p.vendorId, 16)];
  return ids.some(v => USB_VENDORS.has(v));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 940, minHeight: 640,
    backgroundColor: '#0F0F11', title: 'AFTERGLO Technician', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      sandbox: false, // preload uses Node's crypto for the flash checksum
    },
  });
  Menu.setApplicationMenu(null);
  const ses = win.webContents.session;

  // The window asks for "a controller"; we pick the port so the technician
  // never sees a list of COM numbers unless two controllers are plugged in.
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    const found = portList.filter(usbCandidate);
    if (found.length === 0) return callback('');
    if (found.length === 1) return callback(found[0].portId);
    pendingPortChoice = { callback, ids: new Set(found.map(p => p.portId)) };
    win.webContents.send('serial:choose', found.map(p => ({ id: p.portId, name: p.displayName || p.portName || 'USB device', port: p.portName || '' })));
  });
  ses.setPermissionCheckHandler((wc, permission) => permission === 'serial');
  ses.setDevicePermissionHandler(details => details.deviceType === 'serial');

  // Nothing in this app should ever navigate away or open a second window.
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('close', e => {
    if (!busy) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Keep it open', 'Close anyway'], defaultId: 0, cancelId: 0,
      title: 'A controller is being written',
      message: 'Firmware is being written to a controller right now.',
      detail: 'Closing the app or unplugging the cable now can leave the controller unable to start. Wait until it says it is finished.',
    });
    if (choice === 0) e.preventDefault();
  });
  win.once('ready-to-show', () => { win.show(); pushLan(); });
  win.loadFile(path.join(__dirname, 'index.html'));
  if (!app.isPackaged && process.env.AG_TECH_SCREENSHOT) {
    // Build check only (never in the installed app): render, optionally run a
    // line of script, save a picture, quit.
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.AG_TECH_SCREENSHOT_JS) {
        await win.webContents.executeJavaScript(process.env.AG_TECH_SCREENSHOT_JS, true).catch(e => console.error(e));
        await new Promise(r => setTimeout(r, 2500));
      }
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.AG_TECH_SCREENSHOT, img.toPNG());
      app.exit(0);
    }, Number(process.env.AG_TECH_SCREENSHOT_DELAY || 5000)));
    win.webContents.on('console-message', (e) => console.log('[window]', e.message));
  }
}

ipcMain.handle('fw:latest', () => latestFirmware());
ipcMain.handle('fw:bytes', () => firmwareBytes());
ipcMain.handle('recovery:files', () => recoveryFiles());
ipcMain.handle('lan:list', () => [...lanDevices.values()]);
ipcMain.handle('lan:query', (e, ip) => lanQuery(String(ip || '').trim()));
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.on('busy', (e, v) => { busy = !!v; });
ipcMain.on('serial:chosen', (e, id) => {
  if (!pendingPortChoice) return;
  const { callback, ids } = pendingPortChoice;
  pendingPortChoice = null;
  callback(ids.has(id) ? id : '');
});
ipcMain.handle('report:save', async (e, { suggestedName, text }) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save controller report',
    defaultPath: path.join(app.getPath('documents'), String(suggestedName || 'controller-report.txt').replace(/[^\w.\- ]/g, '_')),
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, String(text));
  shell.showItemInFolder(res.filePath);
  return res.filePath;
});

// ── Updates to this app ─────────────────────────────────────────────────────
// New versions are GitHub releases of gamesum/afterglo-technician (see
// "publish" in package.json). The download happens quietly in the background;
// it installs when the technician presses Restart, or the next time the app
// is closed. Never while a controller is being written.
let updateReady = null;
function startAppUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (_) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', () => {}); // offline is normal on a job site
  autoUpdater.on('update-downloaded', info => {
    updateReady = info.version;
    if (win && !win.isDestroyed()) win.webContents.send('app:update-ready', updateReady);
  });
  const check = () => { if (!busy) autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 5000);
  setInterval(check, 4 * 60 * 60 * 1000);
  ipcMain.on('app:install-update', () => { if (updateReady && !busy) autoUpdater.quitAndInstall(true, true); });
}
ipcMain.handle('app:update-ready', () => updateReady);

app.whenReady().then(() => { startBeaconListener(); createWindow(); startAppUpdates(); });
app.on('window-all-closed', () => app.quit());
