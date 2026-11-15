# Probe firmware

`lucid_probe/lucid_probe.ino` runs on the Arduino Uno R3 inside the probe. It drives the coil, reads the two signals and the tilt sensor, and prints one JSON line per sample over USB serial.

## Flash it

1. Arduino IDE, board **Arduino Uno**, the probe's USB port.
2. Library Manager: install **Adafruit ADS1X15** (it pulls in Adafruit BusIO).
3. Open `lucid_probe/lucid_probe.ino` and upload.
4. Serial Monitor at **115200 baud** should show a hello line, then about 50 samples a second.

## Wiring the sketch expects

| Module | Bus | Uno pins |
| --- | --- | --- |
| AD9833 (coil drive) | SPI | D13 SCLK, D11 SDATA, D10 FSYNC |
| ADS1115 (16-bit ADC) | I2C, 0x48 | A4 SDA, A5 SCL |
| GY-521 / MPU-6050 (tilt) | I2C, 0x68 | A4 SDA, A5 SCL |
| Detector output (coil level) | analog | ADS1115 A0 |
| IR receiver | analog | ADS1115 A1 |
| 800 nm LED | digital | D7, through a series resistor |

The pin constants are at the top of the sketch. Change `PIN_NIR_LED` if the LED is on another pin.

## What it sends

```json
{"lucid":"probe","fw":"0.1.0","coil_hz":3000000,"ads":true,"imu":true}
{"t":1234,"coil_v":0.8123,"nir_v":0.4410,"pitch":4.2,"roll":-1.0}
```

- The first line is sent at boot and whenever the laptop sends `?`. `ads` or `imu` is `false` when that module did not answer on I2C.
- `t` is milliseconds since boot. `coil_v` is the detector output in volts. `nir_v` is the IR receiver with the LED on minus with it off, so room light cancels. `pitch` and `roll` are degrees, from the accelerometer.

The probe sends raw values only. Converting `coil_v` to dB, deciding when a spot is done and grading contact are done on the laptop, in [`agent/lucid/device`](../agent/lucid/device).

## Status

Written against the module datasheets. On first flash, check the hello line reports `"ads":true,"imu":true` and that `coil_v` moves when a conductive target is brought to the coil.
