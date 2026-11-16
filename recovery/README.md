# Recovery images

Written only by **Repair** and **Factory erase**. Update never touches them.

| File | Flash offset | Source |
|---|---|---|
| `bootloader.bin` | `0x1000` | `firmware/.pio/build/esp32dev/bootloader.bin` (Afterglo-Fable, Arduino core 3.1.3 build of 2026-11-13) |
| `partitions.bin` | `0x8000` | same build; compiled `firmware/partitions_custom.csv` |
| `boot_app0.bin` | `0xe000` | `framework-arduinoespressif32/tools/partitions/boot_app0.bin`; resets the boot selector to app slot 0 |

The firmware itself is never shipped in this app. It is downloaded from the
`gamesum/firmware-update` manifest and written to `0x10000`.

Replace these files and rebuild the installer if `partitions_custom.csv`
changes or the firmware moves to a new Arduino core / bootloader.
