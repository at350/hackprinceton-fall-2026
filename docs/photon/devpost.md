# Devpost text, Photon track

About 150 words. Paste everything below the line.

Voice is one line: the line that starts "Then Lucid phones the surgeon". Keep it only after a real call has worked on a real phone; otherwise delete that one line. The text reads the same without it.

---

Lucid is the third person in the hand-off.

Lucid is a handheld brain-bleed screener run by a LangChain deep agent. Once the medic approves the hand-off, it texts the on-call neurosurgeon the bleed map and a pre-alert over iMessage. Lucid answers the surgeon's questions in that thread from the scan's own fit scores, and records ACCEPT or DECLINE only when they use the word. The medic sees the exchange on the dashboard, from the same agent thread. After a re-scan the medic approves, the surgeon who accepted gets the change, not a second alert.

Nothing reaches the surgeon until the medic approves, and only the surgeon accepts or declines. Delivery is tracked, "ok" gets a request for the word, and 60 seconds of silence is flagged to the medic.
Then Lucid phones the surgeon through a Cartesia voice agent on a Photon number and texts a recap.

Why iMessage: the surgeon installs nothing and logs in to nothing.

Built on the Photon 2.0 beta and live on iMessage. Simulated: the device, its scans and the patients. The surgeon is a teammate.
