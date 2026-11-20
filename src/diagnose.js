// Pure logic shared by the window (loaded with a <script> tag) and the tests
// (loaded with require). No DOM, no Node APIs.
//
// What the controller tells us, and where it comes from:
//   USB      - a one-way startup log (firmware/src/main.cpp Serial.printf lines).
//              The firmware takes no commands over USB.
//   Network  - GET /api/v1/device and friends, plus the UDP beacon on port 4210
//              (firmware/API.md in gamesum/Afterglo-Fable).
// If a log line or JSON field is renamed in the firmware, update the parser here.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Diagnose = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The only family this tool installs. Arch and tree controllers are held on
  // 1.0.15 on purpose: from 1.2.0 the roofline build drives GPIO 13 as a relay,
  // which would kill their third zone.
  const FAMILY = 'roofline';

  // Mirrors firmware/ERRORS.md. Codes are append-only there; add new ones here.
  const FAULTS = {
    E01: { level: 'warn', title: 'Brightness limit was enforced',
      meaning: 'Something asked the lights to go brighter than the built-in 80% limit and the controller held them back. The lights were never over the limit.',
      action: 'The lights are safe. Report it to the office with the firmware version.' },
    E02: { level: 'warn', title: 'Power budget exceeded',
      meaning: 'A zone tried to draw more current than its power supply is set up for, so the controller dimmed it.',
      action: 'Check that the LED count, strip type and power supply size set in the app (Setup > LEDs) match what is installed.' },
    E03: { level: 'warn', title: 'Off the WiFi',
      meaning: 'The controller has WiFi details saved but has been off the network for over a minute. Schedules and app control may not work.',
      action: 'Check the router is on and in range and that the WiFi password has not changed. Reconnect it through the app.' },
    E04: { level: 'warn', title: 'Clock not set, schedules will not run',
      meaning: 'The controller is on the network but could not get the time from the internet.',
      action: 'Check the router has a working internet connection. Some networks block time servers (NTP, UDP port 123).' },
    E05: { level: 'warn', title: 'A setting could not be saved',
      meaning: 'A change was not stored and will be lost on the next restart.',
      action: 'Restart the controller and make the change again. If it keeps happening, replace the controller.' },
    E06: { level: 'bad', title: 'Storage could not be opened',
      meaning: 'Patterns, schedules and settings cannot be saved.',
      action: 'Restart the controller. If the code comes back, the hardware has failed: replace the controller.' },
    E07: { level: 'bad', title: 'Power dipped (brownout)',
      meaning: 'The last restart happened because the supply voltage dropped. This is the power supply warning sign.',
      action: 'Check the power supply size against the LED load, its condition, and every power connection. Look for thin or long wire runs.' },
    E08: { level: 'warn', title: 'Controller froze and restarted itself',
      meaning: 'The last restart was the watchdog recovering from a freeze.',
      action: 'Once: no action. Repeatedly: report it to the office with the firmware version.' },
    E09: { level: 'warn', title: 'Firmware crashed and restarted',
      meaning: 'The last restart was a firmware crash.',
      action: 'Once: no action. Repeatedly: report it to the office with the firmware version.' },
    E10: { level: 'warn', title: 'Last firmware update failed',
      meaning: 'The controller is still running its previous firmware.',
      action: 'Update it with this tool.' },
  };

  function faultInfo(code) {
    return FAULTS[code] || { level: 'warn', title: 'Error ' + code,
      meaning: 'This code is newer than this tool.', action: 'Report it to the office.' };
  }

  // "1.10.0" > "1.9.3". Returns -1 / 0 / 1; anything unparseable sorts lowest.
  function cmpVersion(a, b) {
    const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  function fmtHours(seconds) {
    if (seconds == null || isNaN(seconds)) return 'Unknown';
    const h = seconds / 3600;
    if (h < 1) return Math.round(seconds / 60) + ' min';
    if (h < 100) return h.toFixed(1) + ' hours';
    return Math.round(h).toLocaleString('en-US') + ' hours';
  }

  function signalWords(rssi) {
    if (rssi == null || rssi === 0) return 'Unknown';
    if (rssi >= -60) return 'Strong (' + rssi + ' dBm)';
    if (rssi >= -70) return 'Good (' + rssi + ' dBm)';
    if (rssi >= -80) return 'Weak (' + rssi + ' dBm)';
    return 'Very weak (' + rssi + ' dBm)';
  }

  // Reads the text a controller prints over USB while it starts.
  function parseBootLog(text) {
    const r = {
      started: false, fw: null, hostname: null,
      litS: null, poweredS: null, meterCopiesOk: null, meterWillRestore: false,
      ledType: null, colorOrder: null, whiteMode: null, whiteKelvin: null, zones: null,
      ip: null, faults: [], errors: [], warnings: [],
      boots: 0, brownout: false, crashed: false, noApp: false,
      storageFormatted: false, storageFailed: false, sawAnything: false,
    };
    const active = new Set();
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/[A-Za-z]{3}/.test(line)) r.sawAnything = true;
      let m;
      if (/^rst:0x[0-9a-f]+ \(/i.test(line)) r.boots++;
      if (/brownout detector was triggered/i.test(line)) r.brownout = true;
      if (/Guru Meditation|abort\(\) was called|Backtrace:/i.test(line)) r.crashed = true;
      if (/flash read err|invalid header|No bootable app|invalid magic byte|ets_main\.c/i.test(line)) r.noApp = true;
      if ((m = /^AFTERGLO fw (\S+) up as (\S+)/.exec(line))) { r.started = true; r.fw = m[1]; r.hostname = m[2]; }
      else if ((m = /^Run hours: lit (\d+)s, powered (\d+)s \(copies: nvs (\d)(\d), file (\d)(\d)\)(.*)$/.exec(line))) {
        r.litS = +m[1]; r.poweredS = +m[2];
        r.meterCopiesOk = (+m[3]) + (+m[4]) + (+m[5]) + (+m[6]);
        r.meterWillRestore = /ask the server/.test(m[7]);
      }
      else if ((m = /^Run hours: restored (\d+)s powered \/ (\d+)s lit/.exec(line))) { r.poweredS = +m[1]; r.litS = +m[2]; r.meterWillRestore = false; }
      else if ((m = /^LEDs: (\S+) (\S+), white LED (\S+) @ (\d+)K, zones (\d+)\/(\d+)/.exec(line))) {
        r.ledType = m[1]; r.colorOrder = m[2]; r.whiteMode = m[3]; r.whiteKelvin = +m[4]; r.zones = [+m[5], +m[6]];
      }
      else if ((m = /^Network services up at (\d+\.\d+\.\d+\.\d+)/.exec(line))) r.ip = m[1];
      else if ((m = /^FAULT (E\d\d) (raised|cleared)/.exec(line))) { if (m[2] === 'raised') active.add(m[1]); else active.delete(m[1]); }
      else if ((m = /^LittleFS formatted: (\w+)/.exec(line))) { r.storageFormatted = true; if (m[1] !== 'ok') r.storageFailed = true; }
      else if (/^ERROR:/.test(line)) r.errors.push(line.replace(/^ERROR:\s*/, ''));
      else if (/^WARN:/.test(line)) r.warnings.push(line.replace(/^WARN:\s*/, ''));
    }
    r.faults = [...active].sort();
    return r;
  }

  // Can this tool put `latest` on a controller that reports `fw` / `prop`?
  //   current   - already on the newest
  //   available - older, safe to update
  //   newer     - ahead of what is published (bench unit): leave alone
  //   blocked   - wrong family: never write
  //   unknown   - we could not read a version
  function updateState(fw, prop, latest) {
    if (prop && prop !== FAMILY) {
      return { state: 'blocked', reason: 'This is a ' + prop + ' controller. This tool only installs ' + FAMILY + ' firmware, which would stop one of its light outputs working.' };
    }
    if (!fw) return { state: 'unknown' };
    // Every roofline controller is on 1.1 or later. A 1.0.x unit is an arch or
    // tree controller (or something we have not seen): do not touch it.
    if (cmpVersion(fw, '1.1.0') < 0) {
      return { state: 'blocked', reason: 'Firmware ' + fw + ' means this is probably an arch or tree controller. Roofline firmware would stop one of its light outputs working. Call the office before doing anything to it.' };
    }
    if (!latest) return { state: 'unknown' };
    const c = cmpVersion(fw, latest);
    if (c === 0) return { state: 'current' };
    if (c > 0) return { state: 'newer' };
    return { state: 'available' };
  }

  // Turns everything we know into a headline and a list of findings.
  // usb = parseBootLog() result or null; lan = { device, network, leds, state, support } or null.
  function assess(usb, lan, latest) {
    const findings = [];
    const add = (level, title, detail, action) => findings.push({ level, title, detail, action });
    const dev = lan && lan.device;
    const fw = (dev && dev.fw) || (usb && usb.fw) || null;
    const prop = (dev && dev.prop) || null;
    const upd = updateState(fw, prop, latest);

    if (usb && !usb.started && !dev) {
      if (!usb.sawAnything) {
        add('bad', 'Nothing came back from the controller',
          'It did not print anything after being restarted.',
          'Check it has power and the USB cable is a data cable (not charge-only). Then press Check controller again. If it is still silent, use Repair.');
      } else if (usb.brownout) {
        add('bad', 'Power is dipping while it starts',
          'The controller restarts because its supply voltage drops (brownout).',
          'This is a power problem, not a firmware problem. Check the power supply and wiring. Do not reinstall firmware for this.');
      } else {
        add('bad', 'The controller is not starting',
          usb.noApp ? 'It has no working firmware on it.' : usb.boots > 1 ? 'It restarted ' + usb.boots + ' times while we watched and never finished starting.' : 'It powered up but its firmware did not finish starting.',
          'Use Repair controller. It reinstalls the firmware and keeps the customer\'s settings.');
      }
    }

    const faults = new Set([...(usb ? usb.faults : []), ...((dev && dev.faults) || [])]);
    if (usb && usb.started && usb.brownout) faults.add('E07');
    for (const code of [...faults].sort()) {
      const f = faultInfo(code);
      add(f.level, code + ': ' + f.title, f.meaning, f.action);
    }
    if (usb && usb.started) {
      if (usb.boots > 1) add('warn', 'Restarted ' + usb.boots + ' times while starting', 'A healthy controller starts once.', 'Check the power supply and connections. If power is good, use Repair controller.');
      if (usb.storageFailed) add('bad', 'Storage failed', 'The controller could not prepare its storage.', 'Replace the controller.');
      else if (usb.storageFormatted) add('warn', 'Storage was reset', 'The controller had to wipe its file storage when it started.', 'Check the customer\'s settings are still there. If this repeats, replace the controller.');
      for (const e of usb.errors) add('warn', 'Controller reported an error', e, 'If it repeats after a restart, report it to the office.');
      if (usb.meterCopiesOk === 0 && !usb.meterWillRestore) add('warn', 'Run-time record missing', 'No saved copy of the hour counter was found.', 'Connect it to WiFi so it can recover its hours from the server.');
      if (!usb.ip && !dev) add('info', 'Not on WiFi yet', 'It did not join a network while we watched. A new or reset controller shows its own setup network (AFTERGLO-XXXX) instead.', 'If it should be on the customer\'s WiFi, set it up again from the app.');
    }
    const net = lan && lan.network;
    if (net) {
      if (net.connected && net.rssi && net.rssi < -80) add('warn', 'WiFi signal is very weak', 'Signal is ' + net.rssi + ' dBm at the controller.', 'Move the router or add a WiFi extender closer to the controller.');
      if (net.connected && net.clockSynced === false && !faults.has('E04')) add('info', 'Clock not set yet', 'Schedules cannot run until the controller gets the time.', 'Normal for the first minute after a restart. If it stays this way, check the internet connection.');
    }
    // fw 1.8.0: the controller guessed its strip type (an old install that
    // never recorded it). Wrong guesses show as rainbow or swapped colours.
    const leds = lan && lan.leds;
    if (leds && leds.typeConfirmed === false) {
      add('warn', 'Light type not confirmed',
        'This controller had to guess its light type (' + String(leds.ledType || '?').toUpperCase() + ' ' + (leds.colorOrder || '') + ').',
        'In the AFTERGLO app open Setup, LED settings and press Run light check. It takes 20 seconds.');
    }
    if (upd.state === 'blocked') add('bad', 'Do not update this controller', upd.reason, 'Leave its firmware alone.');
    if (upd.state === 'available') add('info', 'Firmware update available', 'It has ' + fw + '. The newest is ' + latest + '.', 'Press Update.');

    const worst = findings.some(f => f.level === 'bad') ? 'bad' : findings.some(f => f.level === 'warn') ? 'warn' : 'ok';
    let headline;
    if (worst === 'bad') headline = usb && !usb.started && !dev ? 'This controller is not working' : 'This controller needs attention';
    else if (worst === 'warn') headline = 'Working, with something to look at';
    else if (upd.state === 'available') headline = 'Healthy. An update is ready';
    else headline = 'Healthy';
    return { level: worst, headline, findings, fw, prop, update: upd };
  }

  return { FAMILY, FAULTS, faultInfo, cmpVersion, fmtHours, signalWords, parseBootLog, updateState, assess };
});
