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

The "Predicted" columns are what the head model gives for its calibration case (a 22 mL epidural bleed at the left temporal spot). They are targets to compare against, not measurements. The "Measured" columns are empty until someone reads the real probe.

| | Predicted coil (dB) | Measured coil (dB) | Measured std (dB) | Predicted NIR | Measured NIR | Measured std |
| --- | --- | --- | --- | --- | --- | --- |
| Empty phantom | -38.2 | | | 0.612 | | |
| Target under the coil | about -42.6 | | | about 0.54 | | |

A reading counts as steady when the coil's std is under 0.15 dB and the NIR's is under 0.010. These are the limits `spots.py` uses to mark a spot "weak".

**2b. Pattern across the eight spots.** One scan with the target at the left temporal spot.

| Spot | Predicted coil (dB) | Measured coil (dB) | Predicted NIR | Measured NIR |
| --- | --- | --- | --- | --- |
| Frontal | -38.2 | | 0.61 | |
| R frontal | -38.2 | | 0.61 | |
| R temporal | -38.2 | | 0.61 | |
| R parietal | -38.2 | | 0.61 | |
| Occipital | -38.2 | | 0.61 | |
| L parietal | -38.8 | | 0.61 | |
| L temporal | -42.6 | | 0.54 | |
| L frontal | -38.6 | | 0.61 | |

The shape to look for is one deep dip at the target spot, small dips at its two neighbours, and a flat line elsewhere. The NIR reading should drop only at the target spot.

**3. Blind localisation.** A teammate places the target (or leaves it out) without telling the person scanning. Ten trials. The placements below are a suggested mix of both sides, front and back, and three empty runs; the teammate shuffles the order.

| Trial | Target placed at | Lucid's result | Correct side? |
| --- | --- | --- | --- |
| 1 | L temporal | | |
| 2 | none | | |
| 3 | R parietal | | |
| 4 | L temporal | | |
| 5 | Occipital | | |
| 6 | none | | |
| 7 | R temporal | | |
| 8 | L frontal | | |
| 9 | R frontal | | |
| 10 | none | | |

Report the outcome as "N of 10", whatever N is.

**4. Empty phantom.** Five scans with no target. The expected result each time is "No bleed seen".

| Scan | Result |
| --- | --- |
| 1 | |
| 2 | |
| 3 | |
| 4 | |
| 5 | |

**5. Repeatability.** The same setup scanned three times. The region should be the same each time. A suggested tolerance for the coil reading at the target spot is 0.3 dB between scans (twice the weak-contact limit; this number is not in the code).

| Scan | Region reported | Coil at target spot (dB) |
| --- | --- | --- |
| 1 | | |
| 2 | | |
| 3 | | |

**Phantom record.**

| Container | Liquid | Salt concentration | Target | Target position and depth |
| --- | --- | --- | --- | --- |
| | | | | |

Record the phantom's make-up (container, liquid, salt concentration, target) with the results, because a salt-water target is more conductive than blood and gives a larger signal than a real bleed would.
