# Probe hardware

The probe is a handheld case with a coil at its front face, a light channel beside the coil, a tilt sensor, and an Arduino Uno that streams readings over USB.

## Parts

| Part | Role |
| --- | --- |
| Arduino Uno R3 | Controller; USB serial to the laptop |
| AD9833 module (25 MHz crystal) | Sine source that drives the coil at about 3 MHz |
| Magnet-wire coil, 70 mm head, wound in a 68 mm groove | The main sensor: its signal level changes with the conductivity of what is under it |
| Detector (Schottky diode) | Turns the coil's RF signal into a voltage that follows its height |
| ADS1115 | 16-bit ADC for the detector output (A0) and the IR receiver (A1) |
| 800 nm LED and IR receiver | Light channel, on the front face either side of the seam |
| GY-521 (MPU-6050) | Tilt, so the laptop can tell when the probe is held still |
| Copper tape or foil | Lines the case and forms a shield floor behind the coil |
| Nylon M3 fasteners | No metal near the coil |
| Printed enclosure | Two half-shells and an electronics tray (drawing: [`media/enclosure-section.png`](../media/enclosure-section.png)) |

Costs are not listed here because they have not been totalled.

## Wiring

The pin table the firmware expects is in [`firmware/README.md`](../firmware/README.md). Circuit drawing: [`media/circuit-diagram.png`](../media/circuit-diagram.png).

The detector's exact circuit (diode part, capacitor and load values) should be added here by whoever built it; the firmware only needs its output on ADS1115 A0, within 0 to 4 V.

## Signal path

1. The AD9833 puts a steady sine on the coil.
2. Conductive material near the coil loads it, which changes the signal's height.
3. The detector rectifies and smooths that into a DC voltage.
4. The ADS1115 digitises the voltage; the Uno sends it as `coil_v`.
5. The laptop converts `coil_v` to dB against a saved healthy reference (calibration), averages it per spot, and hands 8 spot readings to the agent.

The light channel is read with the LED on and again with it off, and the difference is sent as `nir_v`, so room light cancels.

## Calibration

The head model expects a healthy head to read -38.2 dB on the coil and 0.612 on the light channel. Calibration records what this probe reads on a healthy reference and maps that to those values:

    coil_db = -38.2 + 20 * log10(coil_v / coil_v_ref)
    nir     = 0.612 * nir_v / nir_v_ref

Redo it whenever the probe, the phantom or the room changes. The conversion assumes the detector's output follows the signal's amplitude, which a diode detector does once the signal is above the diode's turn-on voltage; if the coil signal is small, readings near the knee will be compressed.
