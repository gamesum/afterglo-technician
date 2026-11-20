// AFTERGLO Technician - the window.
//
// Three things can be written to a controller, in order of how much they touch:
//   Update        - firmware only, into both app slots. Settings untouched.
//   Repair        - bootloader + partition table + boot selector + firmware.
//                   Settings (NVS) and files (LittleFS) untouched.
//   Factory erase - wipes the whole chip, then Repair.
// Offsets come from firmware/partitions_custom.csv in gamesum/Afterglo-Fable.
// If that table ever changes, change them here and rebuild recovery/*.bin.
import { ESPLoader, Transport } from '../node_modules/esptool-js/bundle.js';

const D = window.Diagnose;
const tech = window.tech;

const ADDR = { bootloader: 0x1000, partitions: 0x8000, otadata: 0xe000, app0: 0x10000, app1: 0x190000 };

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  latest: null,     // result of tech.latestFirmware()
  phase: 'start',   // start | result
  startNote: null,  // message shown on the start screen (no controller found, unplugged...)
  usb: null,        // parsed startup log of the controller on USB
  lan: null,        // network details for that same controller, when reachable
  rawLog: '',
  lanList: [],
  port: null,
  working: false,
};

// ── Technical log ───────────────────────────────────────────────────────────
function log(line) {
  $('logWrap').hidden = false;
  const box = $('logBox');
  box.textContent += line.replace(/\s+$/, '') + '\n';
  if (box.textContent.length > 200000) box.textContent = box.textContent.slice(-150000);
  box.scrollTop = box.scrollHeight;
}

// ── Newest firmware ─────────────────────────────────────────────────────────
async function refreshLatest() {
  const pill = $('fwPill');
  try { S.latest = await tech.latestFirmware(); } catch (e) { S.latest = { ok: false, problem: e.message }; }
  const L = S.latest;
  if (!L.ok) {
    pill.className = 'fw-pill bad';
    pill.textContent = 'No internet: cannot get firmware';
  } else if (L.online) {
    pill.className = 'fw-pill ok';
    pill.textContent = 'Newest firmware: ' + L.version;
  } else {
    pill.className = 'fw-pill warn';
    pill.textContent = 'Offline. Using saved firmware ' + L.version + ' from ' + new Date(L.checkedAt).toLocaleDateString();
  }
  render();
}
const latestVersion = () => (S.latest && S.latest.ok ? S.latest.version : null);

// ── Working overlay ─────────────────────────────────────────────────────────
function working(title, step, pct, warn = true) {
  $('working').hidden = false;
  $('workTitle').textContent = title;
  $('workStep').textContent = step || '';
  $('workWarn').hidden = !warn;
  const bar = $('workBar');
  bar.parentElement.classList.toggle('pulse', pct == null);
  if (pct != null) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}
function doneWorking() { $('working').hidden = true; }

// ── Modal ───────────────────────────────────────────────────────────────────
function closeModal() { $('modalBack').hidden = true; $('modal').innerHTML = ''; }
function openModal(html, cls) {
  const m = $('modal');
  m.className = 'modal' + (cls ? ' ' + cls : '');
  m.innerHTML = html;
  $('modalBack').hidden = false;
  m.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));
  return m;
}
function message(title, body, cls) {
  openModal(`<h1>${esc(title)}</h1><p>${esc(body)}</p><div class="actions"><button class="btn btn-primary" data-close>OK</button></div>`, cls);
}

// ── USB ─────────────────────────────────────────────────────────────────────
async function pickPort() {
  try {
    return await navigator.serial.requestPort();
  } catch (e) {
    if (e && e.name === 'NotFoundError') return null;
    throw e;
  }
}

tech.onChoosePort(list => {
  const m = openModal(`<h1>More than one controller is plugged in</h1><p>Unplug the others, or pick the one to work on.</p>
    ${list.map(p => `<button class="lan-item" data-port="${esc(p.id)}"><strong>${esc(p.name)}</strong><small>${esc(p.port)}</small></button>`).join('')}
    <div class="actions"><button class="btn btn-ghost" id="portCancel">Cancel</button></div>`);
  m.querySelectorAll('[data-port]').forEach(b => b.addEventListener('click', () => { closeModal(); tech.choosePort(b.dataset.port); }));
  m.querySelector('#portCancel').addEventListener('click', () => { closeModal(); tech.choosePort(''); });
});

// Restarts the controller and collects what it prints while starting.
async function readStartupLog(port, onProgress) {
  await port.open({ baudRate: 115200 });
  let text = '';
  try {
    // RTS pulls the chip's enable pin low: a plain restart, not bootloader mode.
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(150);
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    const reader = port.readable.getReader();
    const dec = new TextDecoder();
    const t0 = Date.now();
    let startedAt = null, pending = null;
    try {
      for (;;) {
        const now = Date.now();
        const p = D.parseBootLog(text);
        if (p.started && !startedAt) startedAt = now;
        // After it reports started, give WiFi a few seconds to join.
        if (startedAt && (p.ip || now - startedAt > 9000)) break;
        if (!startedAt && (now - t0 > 16000 || p.boots >= 4)) break;
        if (!startedAt && !p.sawAnything && now - t0 > 7000) break;
        if (onProgress) onProgress(Math.min(95, ((now - t0) / 16000) * 100), p);
        pending = pending || reader.read();
        const r = await Promise.race([pending, sleep(200).then(() => 'tick')]);
        if (r === 'tick') continue;
        pending = null;
        if (r.done) break;
        text += dec.decode(r.value, { stream: true });
      }
    } finally {
      try { await reader.cancel(); } catch (_) {}
      try { reader.releaseLock(); } catch (_) {}
    }
  } finally {
    try { await port.close(); } catch (_) {}
  }
  return text;
}

function portBusyMessage(e) {
  const msg = (e && e.message) || String(e);
  if (/open|access|in use|denied/i.test(msg)) {
    return 'Could not open the USB connection. Another program may be using it (close PlatformIO, Arduino or any serial monitor), or the cable was unplugged.';
  }
  return msg;
}

async function checkController() {
  if (S.working) return;
  S.working = true;
  try {
    const port = await pickPort();
    if (!port) { S.phase = 'start'; S.startNote = 'none'; S.usb = null; S.lan = null; render(); return; }
    S.port = port;
    working('Checking the controller', 'Restarting it and reading its startup report (about 15 seconds)…', 0, false);
    const text = await readStartupLog(port, (pct, p) => working('Checking the controller', p.started ? 'Started. Waiting for it to join WiFi…' : 'Restarting it and reading its startup report…', pct, false));
    S.rawLog = text;
    log('--- startup report ---\n' + text.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ''));
    S.usb = D.parseBootLog(text);
    S.lan = null;
    S.phase = 'result';
    S.startNote = null;
    // If it is on the same network as this computer, ask it for the rest.
    const seen = S.usb.hostname && S.lanList.find(d => d.hostname === S.usb.hostname);
    const ip = S.usb.ip || (seen && seen.address);
    if (ip) {
      working('Checking the controller', 'Reading its settings over WiFi…', 97, false);
      try {
        await sleep(1500); // its web server comes up just after it joins
        const lan = await tech.lanQuery(ip);
        if (!S.usb.hostname || lan.device.hostname === S.usb.hostname) S.lan = lan;
      } catch (e) { log('Network read skipped: ' + e.message); }
    }
  } catch (e) {
    log('Check failed: ' + ((e && e.message) || e));
    message('Could not check the controller', portBusyMessage(e));
  } finally {
    S.working = false;
    doneWorking();
    render();
  }
}

// A controller that was checked and then swapped for another one must not be
// written using the first one's result.
navigator.serial.addEventListener('disconnect', () => {
  if (S.working) return; // the flasher reports its own failure
  if (S.phase === 'result') { S.phase = 'start'; S.usb = null; S.lan = null; S.port = null; S.startNote = 'unplugged'; closeModal(); render(); }
});

// Writes `files` ([{ name, data, address }]) to the chip.
async function writeToChip(port, files, { eraseAll, expectHostname, title }) {
  const transport = new Transport(port, false);
  const terminal = { clean() {}, writeLine: l => log(l), write: l => log(l) };
  const loader = new ESPLoader({ transport, baudrate: 460800, romBaudrate: 115200, terminal });
  const total = files.reduce((n, f) => n + f.data.length, 0);
  try {
    working(title, 'Connecting to the controller…', 3);
    const chip = await loader.main();
    log('Chip: ' + chip);
    // Every AFTERGLO controller uses the original ESP32. Anything else on the
    // cable is not ours: stop before a single byte is written.
    if (!loader.chip || loader.chip.CHIP_NAME !== 'ESP32') {
      throw new Error('This is not an AFTERGLO controller (found ' + ((loader.chip && loader.chip.CHIP_NAME) || 'an unknown chip') + '). Nothing was written.');
    }
    if (expectHostname) {
      const mac = String(await loader.chip.readMac(loader)).toLowerCase().replace(/[^0-9a-f]/g, '');
      const want = expectHostname.replace(/^ag-/, '').toLowerCase();
      if (mac.length === 12 && /^[0-9a-f]{6}$/.test(want) && mac.slice(6) !== want) {
        throw new Error('This is a different controller from the one that was checked. Nothing was written. Press Check controller first.');
      }
    }
    if (eraseAll) {
      working(title, 'Erasing the controller (up to a minute)…', null);
      await loader.eraseFlash();
    }
    const before = files.map((f, i) => files.slice(0, i).reduce((n, x) => n + x.data.length, 0));
    await loader.writeFlash({
      fileArray: files.map(f => ({ data: f.data, address: f.address })),
      flashSize: 'keep', flashMode: 'keep', flashFreq: 'keep',
      eraseAll: false, compress: true,
      reportProgress(i, written, size) {
        const done = before[i] + (size ? (written / size) * files[i].data.length : 0);
        working(title, 'Writing ' + files[i].name + '…', 8 + (done / total) * 84);
      },
      calculateMD5Hash: image => tech.md5(image),
    });
    working(title, 'Restarting the controller…', 94);
    await loader.after('hard_reset');
  } finally {
    try { await transport.disconnect(); } catch (_) {}
  }
}

// Shared by Update, Repair and Factory erase.
async function runWrite(kind) {
  if (S.working) return;
  S.working = true;
  tech.setBusy(true);
  const title = { update: 'Updating the controller', repair: 'Repairing the controller', erase: 'Erasing and reinstalling' }[kind];
  let wrote = false;
  try {
    working(title, 'Getting the firmware…', null, false);
    const fw = await tech.firmwareBytes();
    log(`Firmware ${fw.version} verified (sha256 ${fw.sha256.slice(0, 12)}…, ${fw.data.length} bytes)`);
    let files;
    if (kind === 'update') {
      // Same image into both slots, so it does not matter which one the
      // controller is currently running from. Same method as the website.
      files = [
        { name: 'firmware (1 of 2)', data: fw.data, address: ADDR.app0 },
        { name: 'firmware (2 of 2)', data: fw.data, address: ADDR.app1 },
      ];
    } else {
      const r = await tech.recoveryFiles();
      files = [
        { name: 'bootloader', data: r.bootloader, address: ADDR.bootloader },
        { name: 'partition table', data: r.partitions, address: ADDR.partitions },
        { name: 'boot selector', data: r.bootApp0, address: ADDR.otadata },
        { name: 'firmware', data: fw.data, address: ADDR.app0 },
      ];
    }
    // The strip setup as checked, so the write can never change it unnoticed.
    const stripBefore = S.usb && S.usb.ledType ? { ledType: S.usb.ledType, colorOrder: S.usb.colorOrder } : null;
    const port = S.port || await pickPort();
    if (!port) throw new Error('No controller found on USB. Plug it in and try again.');
    S.port = port;
    wrote = true;
    await writeToChip(port, files, {
      eraseAll: kind === 'erase', title,
      expectHostname: kind === 'update' && S.usb ? S.usb.hostname : null,
    });

    working(title, 'Checking that it starts on firmware ' + fw.version + '…', 96);
    await sleep(600);
    const text = await readStartupLog(port, null);
    S.rawLog = text;
    log('--- startup report after write ---\n' + text.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ''));
    S.usb = D.parseBootLog(text);
    S.lan = null;
    S.phase = 'result';
    doneWorking();
    render();
    const stripChanged = kind !== 'erase' && stripBefore && S.usb.started && S.usb.ledType &&
      (S.usb.ledType !== stripBefore.ledType || S.usb.colorOrder !== stripBefore.colorOrder);
    const appNote = S.latest && S.latest.minAppBuild
      ? ' The customer needs the AFTERGLO app updated (build ' + S.latest.minAppBuild + ' or newer) to use everything in it.'
      : '';
    if (stripChanged) {
      message('Updated, but the light type changed',
        'Before: ' + stripBefore.ledType.toUpperCase() + ' ' + stripBefore.colorOrder + '. Now: ' + S.usb.ledType.toUpperCase() + ' ' + S.usb.colorOrder +
        '. In the AFTERGLO app open Setup, LED settings, set it back to ' + stripBefore.ledType.toUpperCase() + ' ' + stripBefore.colorOrder +
        ' and save (the controller restarts into it). Tell the office.', 'danger');
    } else if (S.usb.started && S.usb.fw === fw.version) {
      const extra = kind === 'erase'
        ? ' It is now like a new controller: set it up again in the AFTERGLO app. Its run hours come back from the server once it is on WiFi.'
        : ' The customer\'s settings were kept, including the light type.';
      message('Done. The controller is on firmware ' + fw.version, 'It restarted and reported the new version.' + extra + appNote);
    } else if (S.usb.started) {
      message('Written, but it reports firmware ' + S.usb.fw, 'Expected ' + fw.version + '. Press Check controller again. If it still shows the old version, call the office.', 'danger');
    } else {
      message('Written, but the controller did not start', kind === 'update'
        ? 'Check its power, then open Advanced and use Repair controller.'
        : 'Check its power and press Check controller. If it still does not start, the controller is faulty: replace it.', 'danger');
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    log('FAILED: ' + msg);
    doneWorking();
    message(wrote ? 'It did not finish' : 'Nothing was changed',
      (wrote ? portBusyMessage(e) + ' The controller may not start until this is run again. Check the cable and press the same button again.' : msg), 'danger');
  } finally {
    S.working = false;
    tech.setBusy(false);
    doneWorking();
    render();
  }
}

// ── Confirmations ───────────────────────────────────────────────────────────
function confirmUpdate() {
  const a = D.assess(S.usb, S.lan, latestVersion());
  if (a.update.state !== 'available') return;
  const m = openModal(`<h1>Update this controller?</h1>
    <p>From firmware <b>${esc(a.fw)}</b> to <b>${esc(latestVersion())}</b>. Takes about two minutes.</p>
    <ul><li class="keep">Keeps WiFi, patterns, schedules and all settings</li><li>The lights will go off while it updates</li><li>Do not unplug it until it says Done</li></ul>
    <div class="actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="go">Update</button></div>`);
  m.querySelector('#go').addEventListener('click', () => { closeModal(); runWrite('update'); });
}

const FAMILY_CHECK = `<label class="check"><input type="checkbox" id="fam" /><span>This is a <b>roofline</b> controller. It is not an arch or tree controller. (Roofline firmware stops the third light output working on those.)</span></label>`;

function confirmRepair() {
  const a = D.assess(S.usb, S.lan, latestVersion());
  if (a.update.state === 'blocked') return message('Not for this controller', a.update.reason, 'danger');
  const healthy = S.usb && S.usb.started;
  const m = openModal(`<h1>Repair this controller?</h1>
    <p>Reinstalls the startup files and firmware ${esc(latestVersion() || '')}. Use it when a controller will not start.</p>
    ${healthy ? '<p class="lose">This controller is starting normally. Repair is probably not what it needs.</p>' : ''}
    <ul><li class="keep">Keeps WiFi, patterns, schedules and all settings</li><li>Takes about two minutes</li><li>Do not unplug it until it says Done</li></ul>
    ${FAMILY_CHECK}
    <div class="actions"><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="go" disabled>Repair</button></div>`);
  const go = m.querySelector('#go');
  m.querySelector('#fam').addEventListener('change', e => { go.disabled = !e.target.checked; });
  go.addEventListener('click', () => { closeModal(); runWrite('repair'); });
}

function confirmErase() {
  const a = D.assess(S.usb, S.lan, latestVersion());
  if (a.update.state === 'blocked') return message('Not for this controller', a.update.reason, 'danger');
  const healthy = S.usb && S.usb.started;
  const m = openModal(`<h1>Factory erase this controller?</h1>
    <p>This wipes the controller completely and installs firmware ${esc(latestVersion() || '')}. It cannot be undone.</p>
    ${healthy ? '<p class="lose">This controller is working. Erasing it is almost never the right fix. Try Update or Repair first.</p>' : '<p>Try <b>Repair</b> first. It fixes most controllers and keeps the customer\'s settings.</p>'}
    <ul>
      <li class="lose">Erases the WiFi connection: the customer has to set it up again in the app</li>
      <li class="lose">Erases every saved pattern, schedule and segment</li>
      <li class="lose">Erases the LED setup (counts, strip type, power supply size)</li>
      <li>Run hours come back from the server after it rejoins WiFi</li>
    </ul>
    ${FAMILY_CHECK}
    <div class="type-box"><span>Type <b>ERASE</b> to continue:</span><input type="text" id="word" autocomplete="off" spellcheck="false" /></div>
    <div class="actions"><button class="btn btn-primary" data-close>Cancel</button><button class="btn btn-danger" id="go" disabled>Erase everything</button></div>`, 'danger');
  const go = m.querySelector('#go'), fam = m.querySelector('#fam'), word = m.querySelector('#word');
  // The button only wakes up a few seconds after the dialog opens, so a
  // double-click on the link that opened it cannot land on it.
  let armed = false;
  setTimeout(() => { armed = true; sync(); }, 4000);
  function sync() { go.disabled = !(armed && fam.checked && word.value.trim() === 'ERASE'); }
  fam.addEventListener('change', sync);
  word.addEventListener('input', sync);
  go.addEventListener('click', () => { closeModal(); runWrite('erase'); });
}

// ── Screens ─────────────────────────────────────────────────────────────────
function factsRows(usb, lan) {
  const dev = lan && lan.device, net = lan && lan.network, leds = lan && lan.leds, st = lan && lan.state, sup = lan && lan.support, sch = lan && lan.schedule;
  const rows = [];
  const add = (k, v) => { if (v != null && v !== '') rows.push([k, v]); };
  add('Name', dev && dev.name);
  add('Serial number', dev && dev.serial);
  add('Controller ID', (dev && dev.hostname) || (usb && usb.hostname));
  add('Type', dev && dev.prop);
  add('MAC address', dev && dev.mac);
  add('WiFi network', net ? (net.ssid || 'Not set up') : null);
  add('WiFi signal', net && net.connected ? D.signalWords(net.rssi) : null);
  add('IP address', (lan && lan.address) || (usb && usb.ip) || (usb && usb.started ? 'Not on WiFi' : null));
  add('Clock', net ? (net.clockSynced ? 'Set (' + (net.timezone || 'no time zone') + ')' : 'Not set') : null);
  add('Lights right now', st ? (st.power ? 'On at ' + st.brightness + '%' : 'Off') : null);
  add('Next schedule', sch ? (sch.paused ? 'Schedules paused' : sch.next ? 'Turns ' + sch.next.action + ' ' + sch.next.date + ' at ' + sch.next.time : 'Nothing scheduled') : null);
  if (dev && Array.isArray(dev.zones)) add('LED count', dev.ledCount + ' (zones ' + dev.zones.join(' / ') + ')');
  else if (usb && usb.zones) add('LED count', (usb.zones[0] + usb.zones[1]) + ' (zones ' + usb.zones.join(' / ') + ')');
  add('Strip type', (leds && leds.ledType) || (usb && usb.ledType) ? ((leds && leds.ledType) || usb.ledType) + ', ' + ((leds && leds.colorOrder) || (usb && usb.colorOrder) || '') : null);
  add('White LED', leds && leds.whiteKelvin ? leds.whiteKelvin + 'K' : usb && usb.whiteKelvin ? usb.whiteKelvin + 'K' : null);
  add('Power supply setting', leds && leds.psuMilliamps ? (leds.psuMilliamps / 1000).toFixed(1) + ' A' : null);
  add('Remote support', sup ? (sup.enabled ? (sup.lastCheckinAgoS != null ? 'On, last contact ' + Math.round(sup.lastCheckinAgoS / 60) + ' min ago' : 'On, no contact yet') : 'Turned off') : null);
  return rows;
}

function fwTag(upd) {
  if (upd.state === 'current') return '<span class="tag ok">Up to date</span>';
  if (upd.state === 'available') return '<span class="tag warn">Update ready</span>';
  if (upd.state === 'newer') return '<span class="tag ok">Newer than released</span>';
  if (upd.state === 'blocked') return '<span class="tag bad">Do not update</span>';
  return '';
}

function resultHtml(usb, lan, opts) {
  const a = D.assess(usb, lan, latestVersion());
  const dev = lan && lan.device;
  const lit = dev ? dev.litSeconds : usb ? usb.litS : null;
  const powered = dev ? dev.poweredSeconds : usb ? usb.poweredS : null;
  const sub = a.findings.length === 0 ? 'No problems found.' : a.findings.length + (a.findings.length === 1 ? ' thing' : ' things') + ' to read below.';
  const rows = factsRows(usb, lan);
  return `
    <div class="health ${a.level}"><span class="dot"></span><div><h1>${esc(a.headline)}</h1><p>${esc(sub)}</p></div></div>
    <div class="big">
      <div><label>Firmware</label><strong>${esc(a.fw || 'Unknown')}</strong>${fwTag(a.update)}<small>${latestVersion() ? 'Newest is ' + esc(latestVersion()) : 'Newest not known (offline)'}</small></div>
      <div><label>Lights-on time</label><strong>${esc(D.fmtHours(lit))}</strong><small>Total time the lights have been lit</small></div>
      <div><label>Powered time</label><strong>${esc(D.fmtHours(powered))}</strong><small>Total time the controller has had power</small></div>
    </div>
    ${a.findings.length ? `<div class="findings">${a.findings.map(f => `<div class="finding ${f.level}"><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p><p class="do"><b>What to do:</b> ${esc(f.action)}</p></div>`).join('')}</div>` : ''}
    ${rows.length ? `<div class="section-label">Details</div><div class="facts">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}</div>` : ''}
    ${opts.usbNoteNoLan ? '<p class="hint">Connect this computer to the same WiFi as the controller to also see its WiFi signal, schedule and LED settings.</p>' : ''}`;
}

function renderUsbCard() {
  const el = $('usbCard');
  const L = S.latest;
  if (S.phase !== 'result') {
    const note = S.startNote === 'none'
      ? `<div class="notice bad"><b>No controller found on USB.</b><ul><li>Push the cable in firmly at both ends</li><li>Use a data cable. Many phone-charging cables carry power only</li><li>Try another USB port on this computer</li><li>A brand-new computer may need the USB driver (CP210x or CH340). Call the office</li></ul></div>`
      : S.startNote === 'unplugged' ? `<div class="notice"><b>The controller was unplugged.</b> Plug in the next one and press Check controller.</div>` : '';
    el.innerHTML = `<div class="start">
      <h1>Check a controller</h1>
      <ol class="steps">
        <li><b>1</b><span>Plug the controller into this computer with a USB cable.</span></li>
        <li><b>2</b><span>Press <b>Check controller</b>. It restarts (lights blink off for a moment) and reports its health, run time and firmware.</span></li>
        <li><b>3</b><span>If an update is ready, one button installs it. Settings are kept.</span></li>
      </ol>
      <button class="btn btn-primary" id="checkBtn">Check controller</button>
      ${note}
      <div class="notice info">Restarting a controller clears its one-time error codes. If it is on WiFi, look at it under <b>On this network</b> first: that does not disturb it.</div>
    </div>`;
    $('checkBtn').addEventListener('click', checkController);
    return;
  }
  const a = D.assess(S.usb, S.lan, latestVersion());
  const notStarted = S.usb && !S.usb.started;
  const canWrite = L && L.ok;
  let primary = '';
  if (a.update.state === 'available' && canWrite) primary = `<button class="btn btn-primary" id="updateBtn">Update to ${esc(latestVersion())}</button>`;
  else if (notStarted && canWrite && !S.usb.brownout) primary = `<button class="btn btn-primary" id="repairBtn">Repair controller</button>`;
  el.innerHTML = resultHtml(S.usb, S.lan, { usbNoteNoLan: !S.lan && S.usb && S.usb.started }) + `
    ${!canWrite ? '<div class="notice bad"><b>No firmware available.</b> Connect this computer to the internet once so it can download the newest firmware. Checking controllers still works.</div>' : ''}
    <div class="actions">${primary}<button class="btn btn-ghost" id="checkBtn">Check again</button><button class="btn btn-ghost" id="saveBtn">Save report</button><button class="btn btn-ghost" id="nextBtn">Next controller</button></div>
    ${canWrite ? `<details class="advanced"><summary>Advanced: repair or erase</summary><div class="adv-body">
      <div class="adv-item"><button class="btn-link" id="advRepair">Repair controller</button><p>For a controller that will not start. Reinstalls everything needed to start. Keeps the customer's settings.</p></div>
      <div class="adv-item"><button class="btn-link danger" id="advErase">Factory erase…</button><p>Last resort. Wipes WiFi, patterns, schedules and LED setup.</p></div>
    </div></details>` : ''}`;
  const on = (id, fn) => { const b = $(id); if (b) b.addEventListener('click', fn); };
  on('updateBtn', confirmUpdate);
  on('repairBtn', confirmRepair);
  on('advRepair', confirmRepair);
  on('advErase', confirmErase);
  on('checkBtn', checkController);
  on('saveBtn', () => saveReport(S.usb, S.lan, S.rawLog));
  on('nextBtn', () => { S.phase = 'start'; S.usb = null; S.lan = null; S.port = null; S.startNote = null; render(); });
}

function renderLan() {
  const el = $('lanList');
  if (!S.lanList.length) {
    el.innerHTML = '<div class="lan-empty">None found yet. They announce themselves every 10 seconds. This computer must be on the customer\'s WiFi.</div>';
    return;
  }
  const latest = latestVersion();
  el.innerHTML = S.lanList.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map(d => {
    const u = D.updateState(d.fw, d.prop, latest);
    const faults = (d.faults || []).length;
    return `<button class="lan-item" data-ip="${esc(d.address)}"><strong>${esc(d.name || d.hostname)}${faults ? `<span class="tag bad">${faults} error${faults > 1 ? 's' : ''}</span>` : ''}</strong>
      <small>Firmware ${esc(d.fw)}${u.state === 'available' ? ' (update ready)' : ''} · ${esc(D.fmtHours(d.litSeconds))} lit · ${esc(d.address)}</small></button>`;
  }).join('');
  el.querySelectorAll('[data-ip]').forEach(b => b.addEventListener('click', () => showLan(b.dataset.ip)));
}

async function showLan(ip) {
  $('ipError').textContent = '';
  working('Reading the controller', 'Asking ' + ip + ' for its status…', null, false);
  let lan;
  try { lan = await tech.lanQuery(ip); }
  catch (e) { doneWorking(); $('ipError').textContent = (e.message || String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); return; }
  doneWorking();
  const a = D.assess(null, lan, latestVersion());
  const m = openModal(resultHtml(null, lan, {}) + `
    ${a.update.state === 'available' ? '<p class="hint">To update it, plug it into this computer with USB and press Check controller.</p>' : ''}
    <div class="actions"><button class="btn btn-ghost" id="lanSave">Save report</button><button class="btn btn-primary" data-close>Close</button></div>`, 'wide');
  m.querySelector('#lanSave').addEventListener('click', () => saveReport(null, lan, ''));
}

function reportText(usb, lan, rawLog) {
  const a = D.assess(usb, lan, latestVersion());
  const dev = lan && lan.device;
  const out = [];
  out.push('AFTERGLO controller report', new Date().toLocaleString(), '');
  out.push('Result: ' + a.headline);
  out.push('Firmware: ' + (a.fw || 'unknown') + ' (newest ' + (latestVersion() || 'unknown') + ')');
  out.push('Lights-on time: ' + D.fmtHours(dev ? dev.litSeconds : usb && usb.litS));
  out.push('Powered time: ' + D.fmtHours(dev ? dev.poweredSeconds : usb && usb.poweredS), '');
  if (a.findings.length) { out.push('Findings:'); for (const f of a.findings) out.push('  [' + f.level + '] ' + f.title + ' - ' + f.detail + ' What to do: ' + f.action); out.push(''); }
  out.push('Details:');
  for (const [k, v] of factsRows(usb, lan)) out.push('  ' + k + ': ' + v);
  if (rawLog) out.push('', 'Startup log:', rawLog.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, ''));
  return out.join('\r\n');
}
async function saveReport(usb, lan, rawLog) {
  const id = (lan && lan.device && (lan.device.serial || lan.device.hostname)) || (usb && usb.hostname) || 'controller';
  await tech.saveReport('AFTERGLO ' + id + ' ' + new Date().toISOString().slice(0, 10) + '.txt', reportText(usb, lan, rawLog));
}

function render() { renderUsbCard(); renderLan(); }

// ── Start ───────────────────────────────────────────────────────────────────
$('ipForm').addEventListener('submit', e => { e.preventDefault(); const ip = $('ipInput').value.trim(); if (ip) showLan(ip); });
tech.onLanUpdate(list => { S.lanList = list; renderLan(); });
tech.lanList().then(list => { S.lanList = list; renderLan(); });
function showAppUpdate(v) {
  if (!v) return;
  $('appUpdateText').textContent = 'Version ' + v + ' of this tool is ready. It installs when you restart the app (about 20 seconds).';
  $('appUpdate').hidden = false;
}
$('appUpdateBtn').addEventListener('click', () => {
  if (S.working) return message('Finish the controller first', 'Wait until the controller is done, then restart.');
  tech.installUpdate();
});
tech.onUpdateReady(showAppUpdate);
tech.updateReady().then(showAppUpdate);
tech.appVersion().then(v => { $('foot').textContent = 'AFTERGLO Technician ' + v + ' · roofline controllers'; });
render();
refreshLatest();
setInterval(refreshLatest, 15 * 60 * 1000);
