const test = require('node:test');
const assert = require('node:assert');
const D = require('../src/diagnose.js');

const HEALTHY = [
  'ets Jul 29 2019 12:21:46', '', 'rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)',
  'Run hours: lit 432000s, powered 900000s (copies: nvs 11, file 11)',
  'Relay open — strips cut',
  'Network services up at 192.168.1.57',
  'AFTERGLO fw 1.3.1 up as ag-a1b2c3',
  'LEDs: UCS2904 RGBW, white LED exact @ 6000K, zones 240/180',
].join('\r\n');

test('healthy startup log', () => {
  const p = D.parseBootLog(HEALTHY);
  assert.equal(p.started, true);
  assert.equal(p.fw, '1.3.1');
  assert.equal(p.hostname, 'ag-a1b2c3');
  assert.equal(p.litS, 432000);
  assert.equal(p.poweredS, 900000);
  assert.equal(p.meterCopiesOk, 4);
  assert.equal(p.ip, '192.168.1.57');
  assert.deepEqual(p.zones, [240, 180]);
  assert.equal(p.boots, 1);
  const a = D.assess(p, null, '1.5.0');
  assert.equal(a.level, 'ok');
  assert.equal(a.update.state, 'available');
});

test('faults raised and cleared', () => {
  const p = D.parseBootLog(HEALTHY + '\nFAULT E07 raised\nFAULT E03 raised\nFAULT E03 cleared\n');
  assert.deepEqual(p.faults, ['E07']);
  const a = D.assess(p, null, '1.3.1');
  assert.equal(a.level, 'bad');
  assert.ok(a.findings.some(f => f.title.startsWith('E07')));
  assert.equal(a.update.state, 'current');
});

test('silent controller', () => {
  const a = D.assess(D.parseBootLog(''), null, '1.5.0');
  assert.equal(a.level, 'bad');
  assert.match(a.findings[0].title, /Nothing came back/);
});

test('boot loop with no app', () => {
  const log = 'rst:0x10 (RTCWDT_RTC_RESET),boot:0x13\nflash read err, 1000\nets_main.c 371\n'.repeat(3);
  const p = D.parseBootLog(log);
  assert.equal(p.started, false);
  assert.equal(p.noApp, true);
  assert.equal(p.boots, 3);
  assert.match(D.assess(p, null, '1.5.0').findings[0].action, /Repair/);
});

test('brownout loop is a power problem, not a firmware one', () => {
  const p = D.parseBootLog('rst:0xf (BROWNOUT_RST)\nBrownout detector was triggered\n');
  const a = D.assess(p, null, '1.5.0');
  assert.match(a.findings[0].action, /Do not reinstall/);
});

test('version compare', () => {
  assert.equal(D.cmpVersion('1.10.0', '1.9.3'), 1);
  assert.equal(D.cmpVersion('1.3.1', '1.3.1'), 0);
  assert.equal(D.cmpVersion('1.3.0', '1.3.1'), -1);
});

test('never update the wrong family, an old 1.0.x unit, or downgrade', () => {
  assert.equal(D.updateState('1.0.15', 'arch', '1.5.0').state, 'blocked');
  assert.equal(D.updateState('1.5.0', 'tree', '1.5.0').state, 'blocked');
  assert.equal(D.updateState('1.0.15', null, '1.5.0').state, 'blocked');
  assert.equal(D.updateState('1.7.0', 'roofline', '1.5.0').state, 'newer');
  assert.equal(D.updateState('1.3.1', 'roofline', '1.5.0').state, 'available');
  assert.equal(D.updateState(null, null, '1.5.0').state, 'unknown');
});

test('network data: faults and weak signal', () => {
  const lan = { device: { type: 'afterglo', prop: 'roofline', fw: '1.5.0', faults: ['E04'], litSeconds: 10, poweredSeconds: 20 }, network: { connected: true, rssi: -85, clockSynced: false } };
  const a = D.assess(null, lan, '1.5.0');
  assert.equal(a.level, 'warn');
  assert.ok(a.findings.some(f => /very weak/.test(f.title)));
  assert.ok(a.findings.some(f => f.title.startsWith('E04')));
});

test('hours formatting', () => {
  assert.equal(D.fmtHours(1800), '30 min');
  assert.equal(D.fmtHours(432000), '120 hours');
  assert.equal(D.fmtHours(36000), '10.0 hours');
  assert.equal(D.fmtHours(null), 'Unknown');
});

test('a guessed light type (fw 1.8.0 typeConfirmed:false) is flagged', () => {
  const lan = { device: { fw: '1.8.0', prop: 'roofline' }, leds: { ledType: 'rgbw', colorOrder: 'RGB', typeConfirmed: false } };
  const a = D.assess(null, lan, '1.8.0');
  assert.ok(a.findings.some(f => f.title === 'Light type not confirmed'));
  const ok = D.assess(null, { device: lan.device, leds: { ...lan.leds, typeConfirmed: true } }, '1.8.0');
  assert.ok(!ok.findings.some(f => f.title === 'Light type not confirmed'));
});

test('test mode: every sample reads the way its label says', async () => {
  const Demo = await import('../src/demo.js');
  const read = id => D.assess(D.parseBootLog(Demo.CASES.find(c => c.id === id).log('1.8.0')), null, '1.8.0');
  assert.equal(read('update').update.state, 'available');
  assert.equal(read('current').level, 'ok');
  assert.equal(read('faults').level, 'bad');
  assert.match(read('noapp').findings[0].action, /Repair/);
  assert.match(read('brownout').findings[0].action, /Do not reinstall/);
  assert.equal(D.parseBootLog(Demo.afterWrite('1.8.0')).fw, '1.8.0');
});
