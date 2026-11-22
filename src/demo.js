// Test mode: every screen of the app without a controller plugged in.
// Seven clicks on the AFTERGLO name turn it on or off. Nothing is written to
// any hardware and no network controller is asked anything: the results
// below are made up, from real startup log lines (see test/diagnose.test.js).

const boot = (fw, extra = []) => [
  'ets Jul 29 2019 12:21:46', '', 'rst:0x1 (POWERON_RESET),boot:0x13 (SPI_FAST_FLASH_BOOT)',
  'Run hours: lit 432000s, powered 900000s (copies: nvs 11, file 11)',
  'Relay open — strips cut',
  'Network services up at 192.168.1.57',
  `AFTERGLO fw ${fw} up as ag-de0001`,
  'LEDs: UCS2904 RGBW, white LED exact @ 6000K, zones 240/180',
  ...extra,
].join('\r\n');

/** What Check controller finds, one per case the banner offers. */
export const CASES = [
  { id: 'update', label: 'Healthy, update ready', log: () => boot('1.3.1') },
  { id: 'current', label: 'Healthy, up to date', log: latest => boot(latest || '1.8.0') },
  { id: 'faults', label: 'Error codes', log: latest => boot(latest || '1.8.0', ['FAULT E07 raised', 'FAULT E04 raised']) },
  { id: 'noapp', label: 'Will not start', log: () => 'rst:0x10 (RTCWDT_RTC_RESET),boot:0x13\nflash read err, 1000\nets_main.c 371\n'.repeat(3) },
  { id: 'brownout', label: 'Power problem', log: () => 'rst:0xf (BROWNOUT_RST)\nBrownout detector was triggered\n'.repeat(2) },
  { id: 'none', label: 'Nothing plugged in', log: null },
];

/** The healthy startup log after an update or repair to [fw]. */
export const afterWrite = fw => boot(fw);

const lanDevice = (name, host, ipAddr, fw, faults = []) => ({
  type: 'afterglo', prop: 'roofline', name, hostname: host, address: ipAddr, ip: ipAddr, fw,
  ledCount: 420, zones: [240, 180, 0], protocol: 1, litSeconds: 4567890, poweredSeconds: 9876543, faults, serial: 'AG-DEMO-' + host.slice(-2),
});

/** Controllers "on this network" in test mode. */
export const LAN = [
  lanDevice('Test house (old firmware)', 'ag-de0011', '192.168.1.71', '1.3.1', ['E07']),
  lanDevice('Test house (up to date)', 'ag-de0012', '192.168.1.72', '1.8.0'),
];

/** What looking one up would return, same shape as main.js lanQuery. */
export function lan(ip, latest) {
  const d = LAN.find(x => x.address === ip) || { ...LAN[1], address: ip, ip };
  const device = { ...d, fw: d.fw === '1.8.0' && latest ? latest : d.fw };
  return {
    device,
    network: { ssid: 'TestHome', connected: true, rssi: -83, clockSynced: true, timezone: 'America/Denver', ip },
    leds: { ledType: 'UCS2904', colorOrder: 'RGBW', whiteKelvin: 6000, psuMilliamps: 11667 },
    state: { power: true, brightness: 80 },
    support: { enabled: true, lastStatus: 200, lastCheckinAgoS: 95 },
    schedule: { paused: false, next: { action: 'on', date: '2026-12-01', time: '17:12' } },
    address: ip,
  };
}
