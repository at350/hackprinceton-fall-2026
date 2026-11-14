# Lucid signal tools

Three packages:
- `lucid_sim` simulates what the probe sends.
- `lucid_interp` interprets it: per-spot layers, a Fourier breakdown, a left/right screening flag, a 3D map of where the bleed most likely is, and a live mode.
- `lucid_ui` is the live web view for the demo.

## Live view (`lucid_ui`)

```bash
python -m lucid_ui                          # open http://localhost:8765, pick a head, press Start scan
python -m lucid_ui --serial /dev/ttys004    # the board (or `python -m lucid_sim stream --pty`)
python -m lucid_ui --replay runs/human_L_temporal.csv
python -m lucid_ui --port 8770              # if 8765 is taken
```

As readings come in:
- **Head.** A real cortex (FreeSurfer's fsaverage5 template, fitted inside the model skull) under a glass scalp, with the ten spots and the probe moving between them. Each of the **500 simulated heads** from the latest update is a particle. Heads that explain the readings without a bleed drift as frost around the scalp. Heads with a bleed fly inside, as embers, to where they put it. As evidence builds, the swarm condenses on the bleed, the cortex lights up with the chance of blood, and the camera turns to face it. For simulated heads, "Show the bleed the simulator placed" draws the true one for comparison.
- **Chance of bleed** after each spot, with the location estimate in words.
- **Next spot**, with why (finishes a pair, retake, confirming rescan) and what the simulations expect it to read.
- **Left against right.** One row per region: the 500 simulated heads' right − left difference as dots, the measured difference with 2 standard errors, and the ±3 standard-error lines. A table view is one click away.
- **Live signals**: coil (dB below air), reflected near-infrared, and probe motion, with time on a spot shaded.

Standard library server with Server-Sent Events, three.js 0.160 vendored in `lucid_ui/static/vendor` (MIT), so it runs offline. Fonts come from Google Fonts and fall back to system fonts. `lucid_ui/make_brain.py` rebuilds `static/brain.json` from nilearn's fsaverage5 files.

## TODO (hardware, blocks calibration)

- [ ] **Scope the peak voltage at the Schottky diode** at 3 MHz, probe in air (Analog Discovery 3 is enough). Set `CoilModel.drive_dbm` = 20·log10(Vpeak / 0.316) in `lucid_sim/channels.py`. At ≥ 0.32 V it works; about 1 V is better; around 0.1 V it can't see a bleed.
- [ ] **Get the Schottky part number** (BAT43, BAT85, 1N5817…) and set `saturation_a` and `ideality` for the `schottky` preset in `lucid_sim/hardware.py` from its datasheet. Only affects absolute conductivity by a few %, not the L/R flag.
- [ ] Bench calibration once the probe reads: air level, saline at known conductivity and spacer gaps, light leak vs gap, L/R spread on healthy volunteers (see the caveat below).

The interpreter reads only the raw frames, so it runs unchanged on real device logs.

## lucid_interp

```bash
python -m lucid_interp runs/demo.csv --plot runs/demo_interp.png --json runs/demo_interp.json
python -m lucid_interp runs/demo.log       # a raw serial log works too
python -m lucid_interp runs/demo.csv --render runs/demo_head.png   # 3D map of the likely bleed
```

```python
import lucid_interp as li
interp = li.interpret(frames)              # frames: DataFrame with the raw serial columns
interp.flag                                # status, side, regions, z, retake list, heart rate, text
interp.spots, interp.pairs, interp.layers  # tables per spot, per L/R pair, per spot and frequency
d = interp.decomposition("L-temporal", "ir_net_v")   # or "coil_loss_db", "ax_g", ...
d.components["pulse"], d.rms, d.peak_hz    # each band rebuilt with an inverse FFT
loc = li.locate(interp)                    # li.locate(interp, li.PRIORS["phantom"]) for the phantom
loc.summary                                # side, region, depth, volume, Bayes factor, text
loc.blood, loc.voxels                      # chance each 5 mm voxel is blood
loc.cloud_records()                        # the same as plain dicts, for a web front end
```

Steps:
1. **Air reference.** Tissue only ever lowers the coil reading, so the top of a rolling window is the probe in air. It's tracked through time, which cancels gain drift between spots.
2. **Contacts.** A stretch where the coil reads at least 0.4 dB below air counts as a contact. Contacts are matched to the planned spots in order.
3. **Clean samples.** A sample is dropped if the gyro shows motion, the accelerometer shows a jolt, the coil jumps away from its median, or room light starts leaking in. The settling and lifting edges are dropped too.
4. **Fourier breakdown.** The longest clean stretch is split into bands: drift, cardiac pulse, hand tremor, room-light flicker (aliased to 20 Hz on 60 Hz mains), and noise. Each band is rebuilt with an inverse FFT, and the bands add back up to the signal. This gives the heart rate (proof the probe is on living skin), tremor and flicker levels, and coil drift.
5. **Layer fit per spot.**
   - The gap (hair plus air) comes from how much room light leaks in with the LED off.
   - Tissue conductivity comes from inverting the coil model at that gap.
   - Optical density at 800 nm is corrected for the gap.
   - Every value has a standard error.
6. **Left/right test.** For each pair, z = (σR − σL) / se. The se includes the natural asymmetry of a healthy head (`asymmetry_sd`). A pair at |z| ≥ 3 raises a screening flag naming the side and region.

7. **Where in the head** (`locate`, `render`). A grid fit over every 5 mm voxel inside the skull. Each candidate bleed has a position, a lateral size and a conductivity contrast; the coil sensitivity falls off with distance as in the simulator, and contrast sets thickness. The fit uses only the L/R differences, integrates over size and contrast, and gives:
   - the chance each voxel is blood (the rendered cloud);
   - side, nearest region, depth and a rough volume, each with its spread;
   - a Bayes factor for "a bleed somewhere" against "healthy head".

   It is a model fit, not imaging: 5 surface pairs pin the side and region well but blur depth and size together. In simulation, healthy heads come out "none" every time; a 30 ml subdural lands within about 15 mm of its true edge with volume 45 ± 35 ml; the phantom balloon is placed under R-parietal (volume underestimated at about 55 ml, since spreads above 30 mm aren't in the grid).

8. **Live mode** (`lucid_interp.live`). Runs during the scan and updates each time the probe leaves a spot:
   - re-interprets everything so far and refits the bleed location from the finished pairs;
   - turns the fit into a running **chance of bleed** (starting from `--prevalence`, default 10%);
   - **simulates 500 heads** that fit the data so far (healthy, or bleeds drawn from the fit, each with natural asymmetry and noise, coil reading from the coil physics at the gap being seen) and predicts every remaining spot's conductivity and coil dB, healthy vs bleed;
   - checks each new spot against its prediction; one far off "changed the picture" and gets a **confirming rescan** suggestion (only a second reading tells a find from bad contact);
   - suggests the **next spot**: retakes, then confirmations, then the planned order, unless a finished pair has made another spot clearly more telling.

   ```bash
   python -m lucid_interp.live runs/demo.csv                       # replay a recording
   python -m lucid_sim stream --bleed L-temporal | python -m lucid_interp.live -
   python -m lucid_interp.live /dev/ttys004 --jsonl live.jsonl --render head.png   # board or `stream --pty`
   ```

   From Python (the app or the agents): `scan = LiveScan(); update = scan.feed(line)` per serial line; `update.text`, `update.p_bleed`, `update.next_spot`, `update.predictions`, `update.to_dict()`. Contacts are labelled in plan order, so when the operator goes somewhere else (a suggested spot or a rescan), the app calls `scan.follow(spot)` while the probe is in the air; a rescan is pooled with the first reading. `scan.finish()` gives the final update and blood map.

   In simulation, healthy heads stay near 10% with no confirm prompts; a 30 ml L-temporal subdural goes past 95% at the temporal pair; the phantom balloon hits 100% at the parietal pair.

Why not an inverse FFT across frequency to get depth: the detector keeps only amplitude (no phase), and at 3 MHz the field goes through the whole head. Frequency therefore doesn't map to depth. The inverse FFT is used on the time series instead, where it does separate physical sources.

Results on simulated scans (8 heads each, 30% of spots with handling problems):

| Scenario | Flagged | Side and region |
|---|---|---|
| Healthy human | 0/8 (no false alarms) | – |
| Healthy phantom | 0/8 (no false alarms) | – |
| 30 ml subdural, L-temporal | 7/8 | all right |
| 30 ml deep (intracerebral), R-frontal | 4/8 | all right |
| 10 ml under thick parietal hair | 1/8 | all right |
| Phantom, 100 ml balloon, R-parietal | 8/8 | all right |

Conductivity is within about 1% of the truth. Fewer than 0.3% of kept samples are truly bad.

**Caveat:** the interpreter uses the same physics as the simulator, so these numbers show the pipeline works, not that the probe does. The gap estimate is near-perfect for the same reason. Fill `Calibration` from bench measurements:
- air reading;
- saline of known conductivity at known spacer gaps;
- light leak versus gap;
- L/R spread on healthy volunteers.

`Calibration.mains_hz` must be 50 in 50 Hz countries; there, the flicker aliases onto DC and can't be separated.

## Coil detector

The AD8307 didn't arrive, so the board uses a diode peak detector: a diode, then a hold capacitor and load resistor, into ADS1115 A0. `hardware.DiodeDetector` models it with the standard peak-detector diode equation. It responds as the square of the input at small signals and linearly at large ones, and drifts with temperature. Presets:
- `schottky` (default);
- `1n4148` (silicon);
- `ad8307` (kept in case it turns up).

Pick one with `--detector` on either command line. It's also stored in the scenario `.json`.

How usable it is depends on the diode and on the RF level reaching it, not on the diode setup as such:

| Detector | Peak volts at input | mV per dB | Noise floor (dB) | Drift (dB per °C) | 30 ml bleed found (sim) |
|---|---|---|---|---|---|
| AD8307 | any | 25 | 0.04 | ~0 | 10/10 |
| Schottky | 0.32 V (AD9833 alone) | 29 | 0.035 | 0.037 | 10/10 |
| Schottky | 1.0 V | 110 | 0.009 | 0.010 | 10/10 |
| Schottky | 0.1 V | 2 | 0.5 | 0.14 | 0/10 |
| 1N4148 | 0.32 V | 2.4 | 0.4 | 0.07 | 0/10 |
| 1N4148 | 1.0 V | 101 | 0.010 | 0.014 | 10/10 |

There were no false alarms in any row: weak setups report "coil signal too weak" instead of guessing. Use a Schottky (BAT43, BAT85, 1N5711, 1N5817/5819) or get at least about 1 V peak onto the diode. Measure the peak voltage at the diode with a scope (the Analog Discovery 3 is enough).

The exact diode values matter little. Assuming the wrong diode, or even an AD8307, still finds the right side, because the left/right test is relative. Conductivity is then off by a few percent. Temperature drift is cancelled by re-reading air between spots.

# lucid_sim

Simulates what the Lucid probe sends over USB, so the data pipeline, signal QA, triage and agents can be built before the hardware works. Every frame comes with ground truth: which spot the probe is on, the real coil gap, any handling artifact, and whether the sample is good.

## Run

```bash
cd sim
pip install -r requirements.txt

# A scan of a human head with a 30 ml subdural under L-temporal and some handling problems
python -m lucid_sim generate -o runs/demo.csv --bleed L-temporal --artifacts 0.3 --serial runs/demo.log --plot runs/demo.png

# The demo: saline phantom with a 100 ml salt-water balloon at R-parietal
python -m lucid_sim generate -o runs/phantom.csv --medium phantom --bleed R-parietal --volume 100 --plot runs/phantom.png

# Live, like the Arduino on USB: prints a /dev/ttys... path that the app opens with pyserial
python -m lucid_sim stream --pty --loop --medium phantom --bleed R-parietal --volume 100

python -m pytest tests
```

In Python:

```python
import lucid_sim as ls

subject = ls.Subject(ls.HUMAN, [ls.Bleed("L-temporal", volume_ml=30, kind="subdural")], seed=1)
plan = ls.add_random_artifacts(ls.default_plan(hold_s=3), rate=0.3, seed=1)
session = ls.simulate(subject, plan, seed=1)   # DataFrame: raw columns + true_* columns
frames = ls.raw_frames(session)                # only what the device sends
units = ls.to_units(frames)                    # adds coil_dbm, ir_net_v, ax_g, gx_dps, ...
ls.pair_summary(session)                       # L/R means per region (uses ground truth)
```

Use `ls.read_serial_log(path)` / `ls.parse_frame(line)` + `ls.to_units` for the real device too.

## Serial format (proposed, firmware must match)

One line per sample at 100 Hz, integers, comma separated, optional `#` comment lines:

```
# lucid v1 t_ms,freq_hz,coil,ir,ir_amb,ax,ay,az,gx,gy,gz
```

| Column | Source | Units |
|---|---|---|
| `t_ms` | `millis()` | ms |
| `freq_hz` | AD9833 setting | Hz |
| `coil` | ADS1115 A0 (diode detector out), PGA ±4.096 V | counts, 125 µV each |
| `ir` | ADS1115 A1, LED on | counts |
| `ir_amb` | ADS1115 A1, LED off (taken just before `ir`) | counts |
| `ax ay az` | MPU-6050, ±2 g | raw, 16384 per g |
| `gx gy gz` | MPU-6050, ±250 °/s | raw, 131 per °/s |

## Ground-truth columns

`true_phase` (idle, transit, place, hold, lift), `true_spot` (e.g. `L-temporal`), `true_dwell`, `true_liftoff_mm`, `true_artifact` (slip, wobble, lift, shake), `true_good` (held, settled, no artifact, contact OK), `true_sigma`, `true_coil_overlap`, `true_coil_dbm` (before drift and noise), `true_drift_db`, `true_optical_od`. The `.json` next to each CSV has the scenario.

## What is modelled

- **Scan**: 5 L/R pairs (frontal, frontotemporal, temporal, parietal, occipital), L then R, with transits, placing and lifting. The probe pose follows smooth hand-like paths on a 90 mm sphere head.
- **Coil**: a resonant tank at 3 MHz with Q 30. Conductive tissue adds eddy-current loss, which lowers Q and so the amplitude. Loading falls off with the gap to the scalp and with depth. Blood is more conductive than the tissue around it, so the bleed side reads lower. The model also has warm-up drift, random drift, and the detector → ADS1115 conversion.
- **Optical**: reflected 800 nm light, with darkening from hair and bleed, a cardiac pulse, room-light leak through a poor seal, 120 Hz flicker (it aliases at 100 Hz), and LED crosstalk.
- **IMU**: gravity in the probe frame (supine or upright), motion from the actual path, hand tremor, bias and noise.
- **Subject variation**: region-to-region differences, small natural L/R asymmetry, and per-spot hair and skin, all fixed by the seed.
- **Artifacts**: slip, wobble, brief lift, shake and poor contact. `add_random_artifacts` sprinkles them over a plan.

## Caveats

The magnitudes are guesses and none have been checked against the real probe. Every number sits in `CoilModel`, `OpticalModel`, `ImuModel` and `Medium`, so recalibrate them once bench data exists. Specific gaps:

- **Coil sensitivity**: a 30 ml subdural gives about 0.4 dB of L/R difference. Healthy heads give under about 0.2 dB. A 100 ml phantom balloon gives about 2.5 dB.
- **Optical channel**: the LED and receiver sit close together, so this channel only sees shallow tissue. Its bleed signal is small next to hair and skin differences.
- **Frequency**: off resonance, the coil reading barely depends on tissue. Sweep close to `f0`.
- **Not modelled**: tissue permittivity (shifts in resonance), CSF, skull geometry, and dropped or garbled serial lines.
