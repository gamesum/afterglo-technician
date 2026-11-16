// Pretends to be a controller on the network, for trying the app with no
// hardware: node test/fake-controller.js   (serves on port 80, beacons on 4210)
const http = require('http'), dgram = require('dgram'), os = require('os');
const ip = Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address))?.address;
if (!ip) { console.error('no private LAN address on this PC'); process.exit(1); }
const device = { type: 'afterglo', prop: 'roofline', name: 'Ward House', hostname: 'ag-a1b2c3', mac: 'AA:BB:CC:A1:B2:C3', ip, fw: '1.3.1', ledCount: 420, zones: [240, 180, 0], protocol: 1, litSeconds: 4567890, poweredSeconds: 9876543, faults: ['E07', 'E04'], serial: 'AG-000123' };
const routes = {
  '/api/v1/device': device,
  '/api/v1/network': { ssid: 'WardHome', connected: true, rssi: -83, clockSynced: false, timezone: 'America/Denver', ip },
  '/api/v1/leds': { ledType: 'UCS2904', colorOrder: 'RGBW', whiteKelvin: 6000, psuMilliamps: 11667 },
  '/api/v1/state': { power: true, brightness: 80 },
  '/api/v1/support': { enabled: true, lastStatus: 200, lastCheckinAgoS: 95 },
  '/api/v1/schedules/status': { paused: false, next: { action: 'on', date: '2026-11-16', time: '17:12' } },
};
http.createServer((q, r) => { const b = routes[q.url]; r.writeHead(b ? 200 : 404, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(b || { error: 'not found' })); }).listen(80, ip, () => console.log('fake controller at http://' + ip));
const s = dgram.createSocket('udp4');
setInterval(() => s.send(JSON.stringify(device), 4210, ip), 1500);
