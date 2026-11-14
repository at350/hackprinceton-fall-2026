---
name: explain-to-medic
description: How to explain a scan result, a fit, or a comparison with the baseline to a medic in plain words. Read before writing the summary for a result, and before answering "why", "how sure" or "how big" questions.
---

# Explaining a result to a medic

The medic is busy, wearing gloves, and looking at a small screen. They need the finding, why you think so, and what to do next. Nothing else.

## Shape of a result message

1. The finding, in the result's exact name, with side, region and approximate size.
2. The evidence, as what the device measured: which spots, which signal, how big the change.
3. What else was tested and did not fit.
4. The next step.

Three or four short sentences. No headings, no lists, no markdown.

## Words

| Instead of | Say |
| --- | --- |
| hypothesis, forward simulation | "we tested 100 possible bleeds on a head model" |
| fit score 0.91 | "fit 0.91 out of 1" |
| null model | "the no-bleed model" |
| ipsilateral, contralateral | "same side", "other side" |
| conductivity perturbation | "the coil signal dropped" |
| hematoma expansion | "the bleed has grown" |

Use "L temporal", "R frontal" the way the dashboard does. Clinical terms a medic uses every day (epidural, subdural, CT, GCS) are fine.

## Evidence, from the readings

- Coil signal: lower over blood. Give the drop in dB against a healthy head and name the spots.
- NIR: lower over blood near the surface. A coil drop with little NIR change points to a deeper bleed.
- One side against the other: say which side differs.

## Examples

Bleed likely: "Bleed likely: epidural, left temporal, about 20 mL (fit 0.91 out of 1). The coil signal is about 4 dB lower over L temporal and L parietal, and NIR drops at the same spots. Right-side bleeds and the no-bleed model fit poorly. Screening aid, not a diagnosis. Confirm with CT."

No bleed seen: "No bleed seen in this scan. All 8 spots read within normal range and the no-bleed model fits at 0.95. This does not rule a bleed out. Screening aid, not a diagnosis. Re-scan if symptoms change."

Uncertain: "Uncertain, re-scan. Contact was weak at L parietal and L temporal, and two different bleeds fit about equally (0.62 and 0.60). Part the hair, press the device flat at those two spots, and scan again."

Re-scan against a baseline: "Compared with the scan 15 minutes ago, the best fit moved from about 20 mL to about 30 mL in the same place. That suggests the bleed is growing. Screening aid, not a diagnosis. Tell the receiving team."

## Answering questions

Answer the question asked, in one or two sentences, from the readings and scores you have. If you do not have it, say so. Do not repeat the whole result.
