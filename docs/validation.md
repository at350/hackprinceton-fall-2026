# What has been checked

This page separates what is tested from what is not, so nobody has to guess from the code.

## Tested, without the probe

| What | How | Where |
| --- | --- | --- |
| Serial protocol: valid lines parse, malformed ones are dropped | Unit tests on hand-written lines | `agent/tests/test_device.py` |
| Calibration: reference maps to the healthy level; half the voltage is 6.02 dB lower | Unit tests | `agent/tests/test_device.py` |
| Spot capture: 8 spots in order, one reading per hold, none while moving, noisy windows marked weak, re-scan of named spots | Unit tests on synthetic sample streams | `agent/tests/test_device.py` |
| Device bridge over HTTP, and the agent's client | Tests against a local server on a free port | `agent/tests/test_device.py` |
| `read_scan` and `request_rescan` in Device mode | Tests with the bridge client patched | `agent/tests/test_device_tools.py` |
| Dashboard status and spot progress | Unit tests on the pure helpers | `lib/device.test.mjs` |
| Dashboard in Device mode end to end | Headless browser against `python -m lucid.device --simulate`: Run scan stays disabled until calibrated, the 8 spots advance in order, the agent run is requested when they are in | Done once by hand on Nov 15, 2026; not an automated test |

The synthetic streams are steady signals with a little noise. They exercise the logic. They say nothing about the hardware.

## Not yet checked

- The firmware has not been compiled or flashed from this repository.
- The bridge has not read a real probe.
- No calibration has been taken on the real probe, so the volts-to-dB conversion is unverified on it.
- The head model's assumed signal sizes (for example a 4.4 dB coil drop for a 22 mL epidural bleed) are not measurements. Until the model is calibrated against bench readings, fit scores on real readings do not mean anything.
- Nothing here has been tested on a person. Lucid is a screening prototype, not a diagnostic device.

## Bench protocol

Run these in order once the probe is connected, and record the results in the tables. Leave a cell empty if the step was not done.

**1. Link check.** `python -m lucid.device status` reports a probe, and the hello line shows `"ads":true,"imu":true`.

**2. Signal versus noise.** Ten readings at one spot on the empty phantom, then ten with the target under the coil.

| | Mean coil (dB) | Std (dB) | Mean NIR | Std |
| --- | --- | --- | --- | --- |
| Empty phantom | | | | |
| Target under the coil | | | | |

**3. Blind localisation.** A teammate places the target (or leaves it out) without telling the person scanning. Ten trials.

| Trial | Target placed at | Lucid's result | Correct side? |
| --- | --- | --- | --- |
| 1 | | | |
| 2 | | | |
| 3 | | | |
| 4 | | | |
| 5 | | | |
| 6 | | | |
| 7 | | | |
| 8 | | | |
| 9 | | | |
| 10 | | | |

**4. Empty phantom.** Five scans with no target. Count how many end in "No bleed seen".

**5. Repeatability.** The same setup scanned three times. Note whether the region is the same each time.

Record the phantom's make-up (container, liquid, salt concentration, target) with the results, because a salt-water target is more conductive than blood and gives a larger signal than a real bleed would.
