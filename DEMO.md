# Lucid demo runbook (Photon track)

Two minutes at the table. The medic approves on the laptop. The on-call surgeon's phone gets the bleed map and the pre-alert over iMessage. The surgeon asks one question, gets an answer from the scan, and accepts. A re-scan then texts them the change.

Real: the texts and the map image, sent through Photon's 2.0 beta. Simulated: the device, the three scans and the patients. The surgeon is a teammate's phone.

Voice: the phone call (path B below) is built and tested with the call stubbed. It has not rung a real phone yet. Use it only if the test call in the preflight rings.

## Roles

| Who | Where | Does |
|---|---|---|
| Medic | Laptop, dashboard | Talks to the judge, approves the cards, runs the re-scan |
| Surgeon | Clinician phone | Holds the phone where the judge can see it, types the texts |

## Start, in this order

Three terminals, from the repo root.

| # | Process | Command | Ready when |
|---|---|---|---|
| 1 | Agent server | `cd agent && .venv/bin/langgraph dev --no-browser` | It serves on http://localhost:2024 |
| 2 | Dashboard | `npm run dev` | http://localhost:3000/?live=1 loads |
| 3 | Bridge | `cd agent && .venv/bin/python -m lucid.bridge` | It logs `bridge up: LangGraph http://localhost:2024, reading texts since ...` |

Voice is on by default: the root `.env` holds all three Cartesia ids, so with the command above, 60 s of silence rings the clinician phone. For text only, start the bridge with voice off:

```bash
cd agent && CARTESIA_FROM_NUMBER_ID= .venv/bin/python -m lucid.bridge
```

## On call and off

- The clinician phone texts **On call** to the Photon line it was assigned. Within 2 to 3 s it gets: "You are on call for Lucid pre-alerts until you text OFF. I only message when a medic approves a hand-off."
- **Off** (or "off call") takes them off: "You are off call for Lucid pre-alerts. Text ON CALL to receive them again."
- By hand, from `agent/`: `.venv/bin/python -m lucid.photon oncall +1...` or `off +1...`. This works only for a phone that has texted the line in the last 30 days.
- See the roster: `.venv/bin/python -m lucid.photon roster`.
- The pre-alert goes to whoever came on call most recently. If the spare phone is on call too, have it text **Off**.
- Photon's shared line only texts someone who has texted it since the line was assigned to them. After any new assignment in Photon's dashboard, the phone must text again ("On call" does it).

## Preflight, ten minutes before

- [ ] **`agent/` is frozen.** Do not save any file under `agent/`: code, prompts, skills or README. `langgraph dev` reloads on any save there, and the reload cancels a scan in progress. Turn off editor auto-save. A page reload in the middle of a scan cancels it too.
- [ ] **Decide the text marker.** Without `LUCID_PHOTON_PREFIX`, the texts look like real clinical alerts. To mark them, add `LUCID_PHOTON_PREFIX="[Lucid demo] "` to the root `.env` before starting the agent server and the bridge (both read it at start). The "On call" confirmation then starts with the marker, which is the check.
- [ ] Agent server, dashboard and bridge are up, in that order.
- [ ] The clinician phone texts **On call** and gets the confirmation. `roster` shows it `ON CALL`, and nobody else is on call. **With the roster empty, nothing is sent at all:** the pre-alert card says "Nobody is on call, so no pre-alert will be sent."
- [ ] If voice is in: one test call rings the clinician phone. Tell whoever holds it first; calls cost money. From `agent/`: `.venv/bin/python -m lucid.voice call +1...`. If it does not ring, restart the bridge with voice off and use path A only.
- [ ] Laptop and phone are online. On the phone: Focus and Do Not Disturb off, the Lucid thread open, the ringer on if voice is in.
- [ ] The recording of a good run is ready to play.
- [ ] **A scan is waiting.** In one dashboard tab, pick **Temporal bleed**, press **Run scan**, and wait about 35 s for the card "Mark this scan Bleed likely?". Leave it there.
  - The surgeon must be on call before this card is approved: the pre-alert goes to whoever is on call at that moment, and the next card names them.
  - From here on, do not reload this tab. Each page load is a new patient, so after a reload the re-scan is a first scan and gets a full pre-alert, not an update.

## The two-minute script

Times are targets. The measured numbers are in the last section.

| Time | Medic (laptop) | Surgeon (phone) | Dashboard shows |
|---|---|---|---|
| 0:00 | "Lucid is the third person in the hand-off. A medic has just scanned a head injury. Lucid found a likely bleed, and it stops for me before anything leaves." | Phone face up, Lucid thread open | Card: "Mark this scan Bleed likely?" |
| 0:10 | Approves. A few seconds later the next card names the recipient: "Send pre-alert to the on-call clinician (+1 ... NNNN) by iMessage?" Says: "It names who gets it." Approves. | | |
| 0:15 | "The surgeon needs no app and no login." | Buzzes: the map image, then "Lucid pre-alert, patient ...", ending "Screening aid, not a diagnosis. Confirm with CT." and "Reply ACCEPT or DECLINE, or ask me about the scan." Shows it to the judge | Hand-off row "Pre-alert to …NNNN", badge Sent, then Delivered |
| 0:25 | "The surgeon can ask about the scan." | Texts: `could this be subdural?` The answer arrives 5 to 7 s later | The question under "Receiving clinician · iMessage", the answer under it with "Sent to the clinician by iMessage" |
| 0:35 | "The answer comes from this scan's own fit scores, on the same thread I am watching." | | |
| 0:40 | "Only the surgeon accepts or declines." | **Path A:** texts `ACCEPT`. Gets a one-line confirmation, for example "Recorded: you accept. The medic can see it." | Badge "Accepted" with the time |
| 0:50 | Presses **Run scan** again in the same tab. "Same patient, scanned again." While it runs (about 35 s), says the scope line and the fallback ladder below | | The search runs again |
| 1:25 | Card: "Mark this scan Bleed likely?", ending "The clinician who accepted this patient (+1 ... NNNN) will be told." Approves | | |
| 1:30 | "A re-scan sends the change, not a second alert." | Buzzes: "Lucid update, patient ...: re-scan N min after the first scan." Then and now, and whether it grew | Hand-off row "Update to …NNNN" |
| 1:40 | Closing line, then questions | | |

Notes on the script:

- The re-scan sends an update, not a second pre-alert. There is no pre-alert card on the re-scan.
- The minutes in the update are the real time since the first scan, which ran during the preflight. They will not say 15.
- A question is not an answer. Each text from the surgeon restarts the 60 s clock. If 60 s pass after the pre-alert or the surgeon's last text with no ACCEPT or DECLINE, the bridge acts once: with voice on, it rings the phone; with voice off, it tells the medic on the dashboard. In path A, text ACCEPT within 60 s of the question.
- Optional beat, about 7 s: the surgeon texts `ok` first and is asked to reply ACCEPT or DECLINE. Lucid does not take "ok" as an accept.
- Lucid's answers are written by the model, so their wording changes from run to run. The pre-alert's header, safety line and reply line, the update and the roster replies are fixed in code.

**Path B, voice (only if the preflight call rang).** It replaces ACCEPT and the re-scan. After the answer at 0:35, the surgeon does not reply. 60 s after the question, the dashboard shows "No reply after 60 s. Calling the on-call clinician." and the badge Calling. The phone rings from the Photon voice number, which is not the iMessage line. The agent opens: "This is Lucid, an automated screening aid, calling with a pre-alert from a medic. Do you have thirty seconds?" The surgeon asks one question, then says **"I accept"**. The word itself counts; "yes" alone is recorded as no decision. After the call the dashboard shows a Phone call card with the decision and a summary, and the recap arrives by text. With the 60 s wait, path B runs past two minutes. The bridge reads `LUCID_CALL_AFTER_S` (default 60); if it is shortened for the table, say so out loud.

**Scope, in one breath:** "The device, the scans and the patient are simulated, and the surgeon is my teammate. The texts and the map image are real, sent through Photon's 2.0 beta."
Voice, only after a real call has worked: "So is the call."

**Fallback ladder, while the re-scan runs:** "Nothing reaches the surgeon until the medic approves. If a text fails, the dashboard says so and tells the medic to use the radio. 'Ok' is not an accept; Lucid asks for the word. If the surgeon goes quiet for 60 seconds, the medic is told."
Voice, only after a real call has worked: "And Lucid phones the surgeon, then texts a recap of the call."

**Closing:** "No app, no login. The surgeon's phone was already in their pocket."

## When something goes wrong

| What you see | What to do |
|---|---|
| The phone does not buzz within about 10 s of the approval | Look at the hand-off row. "Sent" without "Delivered": the text is queued at Photon; give it a few seconds, then play the recording. "Not delivered": the dashboard has told the medic to hand off by radio. Say that this is the fallback, then play the recording |
| The card says "Nobody is on call", or the row says "No one on call" | Approve it: it records that nobody was on call and tells the medic to use the radio. Then the surgeon texts **On call** and waits for the confirmation. No confirmation: check the bridge is up, and remember a fresh text is needed after any new assignment. The scan on screen cannot pick up the new recipient: open a new tab and run a new scan (about 35 s, talk over it), or play the recording |
| Texts get no answer | Look at the bridge terminal. If it stopped, restart it with the same command (`cd agent && .venv/bin/python -m lucid.bridge`, with `CARTESIA_FROM_NUMBER_ID=` in front if voice is off). It resumes from its saved place: texts sent while it was down are answered, none twice. Restarting the bridge does not touch the agent server |
| The phone gets "The medic is deciding. I will reply shortly." | The scan thread is waiting at an approval card. Decide the card; the held text is answered after |
| The phone gets "No hand-off is open for you." | No pre-alert went to this phone on this line in the last 12 hours. Check the roster: the pre-alert went to whoever came on call most recently |
| The scan stops in the middle, or the dashboard loses the run | A file under `agent/` was saved, or the tab was reloaded. Reload, run a new scan and talk over the 35 s, or play the recording. The re-scan step is then a new patient |
| Voice: the phone does not ring, or the row says "Call failed" or "No answer" | The surgeon texts **ACCEPT**. After a failed or unanswered call the bridge also texts "I tried to call at ... about a pre-alert. Reply ACCEPT or DECLINE." |
| The phone rings in path A (the decision came late) | Answer and say "I accept", or decline the call and text ACCEPT. A decision by text wins over one from a call |
| The re-scan shows a pre-alert card instead of an update | The tab was reloaded (a new patient), or the first hand-off was not accepted. Say so and reject the card |
| The dashboard chat does not show the surgeon's text | The phone is the record. Show the phone |

## Measured in the build

From the build notes, on a real phone:

| Step | Time |
|---|---|
| Run scan to the first card | 34 to 38 s |
| Medic's approval to the map image and the pre-alert, both delivered | within 6 s |
| The surgeon's text to Lucid's answer, delivered | 5 to 7 s |
| "On call" or "Off" to the confirmation | 2 to 3 s |

The phone call has no measured numbers yet.

## Rehearsal log

| Run | Start | Path | Total time | What went wrong |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |

The recording of a good run: phone screen and dashboard together, under 90 s. Keep it out of the repo. Location: _to fill in_.
