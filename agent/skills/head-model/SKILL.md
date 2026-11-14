---
name: head-model
description: The head model behind the simulations, what the device readings mean, how the search runs, the decision rule, and the limits of what a scan can show. Read when judging fits, or when asked how the result was worked out or how far to trust it.
---

# Head model, readings and limits

## The device

The medic places the device on 8 spots around the head, clockwise seen from above:

| Spot | Name | Spot | Name |
| --- | --- | --- | --- |
| 0 | Frontal | 4 | Occipital |
| 1 | R frontal | 5 | L parietal |
| 2 | R temporal | 6 | L temporal |
| 3 | R parietal | 7 | L frontal |

Each spot gives two numbers:

- Coil signal, in dB. About -38.2 dB over a healthy head. Blood conducts better than brain, so the signal drops over a bleed: roughly 4 dB under a 20 mL bleed near the surface, less for small or deep ones.
- NIR, unitless. About 0.612 over a healthy head. Blood absorbs near-infrared light, so NIR drops over a bleed, but only when the blood is near the surface. Light does not reach deep tissue.
- Contact: "good" or "weak". A weak spot counts less in the fit. Two or more weak spots on the side of interest is a reason to re-scan.

## The model

A coarse 2D slice of the head, seen from above, solved with pyEIT. Layers and conductivity in S/m: scalp 0.43, skull 0.015, CSF 1.79, brain 0.33, blood 0.7. A hypothesis puts one bleed in the slice and the model predicts all 8 readings.

| Type | Where | Signature |
| --- | --- | --- |
| Epidural | Lens against the inner skull, short arc | Strong, narrow coil drop; strong NIR drop |
| Subdural | Thin crescent along the skull, long arc | Coil drop spread over 2-3 spots; NIR drop over the same spots |
| Intraparenchymal | Round, inside the brain | Coil drop with little or no NIR change |

Regions: L/R frontal, temporal, parietal, occipital. Volumes: 5 to 40 mL in 5 mL steps.

## The search

A coarse sweep first: every type in every region at 10, 20, 30 and 40 mL. Each region agent then looks closer where its coarse scores point, adding the volumes in between. A second check tests rival explanations for the leading finding (other types in the same place, neighbouring regions, the opposite side) or, when nothing fits, the smallest bleeds everywhere. All of it is scored against the same scan, so a rival that fits changes the outcome.

## Decision rule

The tools enforce this. You may be more cautious than the rule, never less.

1. No bleed seen: the no-bleed model scores at least 0.80 and beats the best bleed hypothesis by at least 0.05.
2. Uncertain, re-scan: the best bleed hypothesis scores below 0.80, or it is within 0.05 of the best hypothesis in a different region or of the no-bleed model.
3. Bleed likely: otherwise. Report the best fit's region, volume and score.

The same type in the same region at a neighbouring volume is the same finding, not a rival. Report it as the volume range. A different type in the same region does not make the result uncertain: say which type fits best and that the other is second.

## Limits. Say these when they matter.

- 2D proxy model, not a validated solver. Volumes are estimates to about 5 mL at best.
- One bleed per hypothesis. Two bleeds, or bleeds on both sides, are not modelled and tend to show as a poor fit.
- Bleeds under about 5 mL, at the skull base, in the brainstem or the posterior fossa can be missed.
- The model cannot date a bleed or tell fresh blood from old.
- Thick hair, a scalp haematoma, or a moving patient weakens contact and lowers every fit.
- A re-scan is compared with the patient's own baseline. Growth of 5 mL or more between scans is worth reporting; less than that is within the model's resolution.
