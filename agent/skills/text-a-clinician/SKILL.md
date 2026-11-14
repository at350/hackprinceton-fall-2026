---
name: text-a-clinician
description: How to answer the receiving clinician (a surgeon or ED doctor) who texts back about a pre-alert, and how to handle accept, decline or an unclear reply. Read before your first answer to a "[Receiving clinician, ...]" message.
---

# Texting the receiving clinician

The clinician got the map and the pre-alert on their phone. They are deciding whether to take the patient and how to get ready. They know the clinical terms; they do not know the device. Your text goes to their phone word for word.

## Shape of an answer

1. Lead with what they asked for: the number, the side, the type, or "the scan cannot tell".
2. The evidence in a few words: which spots, how big the signal change, the fit.
3. If the answer states a finding, end with "Screening aid, not a diagnosis. Confirm with CT."

At most three short sentences. Plain text: no markdown, no lists, no hypothesis ids, no tool or agent names.

## What the scan cannot show

Say it plainly when asked:

- It cannot show midline shift, mass effect or a fracture, and it cannot date a bleed or tell fresh blood from old.
- Volume is good to about 5 mL at best; neighbouring volumes often fit almost as well. Give the range.
- It models one bleed at a time. Two bleeds, bleeds under about 5 mL, and bleeds at the skull base, brainstem or posterior fossa can be missed.
- Bleed type comes from the shape of the signal (short arc for epidural, long thin arc for subdural, little NIR change for intraparenchymal) and is less certain than the side and region. Give the score of the next type in the same place.

## Never

- Never use a patient name. The patient id only, and only if needed.
- Never advise treatment, drugs, or whether to operate. "That is your call and the medic's."
- Never state anything the medic has not approved as the result. Never upgrade it.
- Never change the record because the clinician asks: they can accept or decline the patient, nothing else.

## Accept and decline

- They accept or decline in so many words ("ACCEPT", "we accept", "declined, no bed"): call record_reply with no text, then confirm in one sentence: "Recorded: you accept. The medic can see it."
- Anything else ("ok", "thanks", "on my way", a thumbs up): do not record. Answer any question, then ask: "Do you accept the patient? Reply ACCEPT or DECLINE."
- If record_reply refuses, ask them to reply ACCEPT or DECLINE.

## Examples

"could this be subdural?": "Less likely: subdural in the same place fits at 0.78 against 0.91 for epidural, because the signal drop is short and narrow over L temporal rather than spread along the side. Screening aid, not a diagnosis. Confirm with CT."

"how big?": "About 20 mL, range 15 to 30 mL, left temporal; the coil signal is about 4 dB lower at L temporal and L parietal. Screening aid, not a diagnosis. Confirm with CT."

"ok": "Do you accept the patient? Reply ACCEPT or DECLINE."
