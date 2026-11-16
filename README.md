# AFTERGLO Technician

Windows app for technicians: check a controller's health over USB or WiFi,
update it to the newest published firmware, and recover one that will not start.

## What it does

- **Check controller (USB)**: restarts the controller, reads its startup log and
  shows firmware version, lights-on hours, powered hours, error codes in plain
  English with what to do, LED setup and WiFi result. If the PC is on the same
  WiFi it adds signal strength, clock, schedule, power supply setting and more.
- **On this network**: controllers announce themselves (UDP 4210). Click one to
  see the same report without touching it. Read-only: no settings are changed.
- **Update**: firmware only, to both app slots. Keeps all settings.
- **Repair** (Advanced): bootloader, partition table, boot selector and firmware.
  Keeps all settings. For a controller that will not start.
- **Factory erase** (Advanced): wipes the chip, then Repair. Needs the word
  ERASE typed, a tick box and a 4 second wait.

## Where the firmware comes from

`https://raw.githubusercontent.com/gamesum/firmware-update/main/afterglo2_manifest.json`,
the same manifest the AFTERGLO app and afterglolighting.org/firmware.html use.
Whatever the `roofline` entry points at is "newest". Publishing a release
without updating the manifest does **not** change what this tool installs.
The download is checked against the manifest's sha256 and kept on the PC, so
the tool still works offline with the last version it downloaded.

## Guard rails

- Only roofline. A controller reporting `prop` arch/tree, or firmware 1.0.x, is
  refused (roofline firmware turns GPIO 13 into a relay and kills their zone 3).
- Never downgrades: a controller ahead of the manifest is left alone.
- Update only appears after a successful check, and only when one is needed.
- Before writing: chip must be an ESP32, and for Update its MAC must match the
  controller that was checked. Unplugging clears the result.
- After writing: every region is MD5-verified, then the controller is restarted
  and must report the new version.
- The window warns before closing mid-write.

## Develop

```
npm install
npm start                       # if it starts as plain Node, unset ELECTRON_RUN_AS_NODE
npm test                        # diagnosis logic
node test/fake-controller.js    # a pretend controller on this PC's LAN address
npm run dist                    # dist/AFTERGLO-Technician-Setup-<version>.exe
```

`src/diagnose.js` parses the firmware's serial log lines and `/api/v1` JSON.
If a `Serial.printf` line or field in Afterglo-Fable `firmware/src/main.cpp`
changes, update the parser and `test/diagnose.test.js`. Error code text mirrors
`firmware/ERRORS.md`. Flash offsets mirror `firmware/partitions_custom.csv`;
see `recovery/README.md`.

## Not signed

The installer is not code-signed. Windows SmartScreen shows "Windows protected
your PC" (More info > Run anyway), and a PC with Smart App Control turned on
will block it outright. A code-signing certificate fixes both.
