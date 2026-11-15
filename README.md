# Lucid

Dashboard for **Lucid**, a handheld brain-bleed screener (HackPrinceton Fall 2026, Healthcare track). A medic moves the device over 8 spots around the head; the laptop shows the bleed-likelihood map filling in, live device signals, region simulations ranked by fit, and an AI agent that explains the result and asks the medic to approve next steps. A second view shows the same agent run as an n8n-style workflow trace.

The dashboard is driven by a real LangChain deep agent in [`/agent`](agent/README.md): real plan steps, about 100 simulations filling the grid, and Approve / Reject pauses that resume the agent. Where the scans come from is the [mode](#modes): **Simulated device** (the default) replays the backend's mock scans; **Device** reads the Lucid device through a device bridge, which is not built yet.

For Photon's track the hand-off to the hospital is real. After the medic approves, the agent texts the on-call clinician the bleed map and a pre-alert over iMessage (Photon 2.0 beta), answers their texts on the same scan thread, and records ACCEPT or DECLINE; the dashboard shows all of it. The device, the scans and the patients are still simulated. How it works: [Hand-off over iMessage](agent/README.md#hand-off-over-imessage). How to run the demo: [`DEMO.md`](DEMO.md).

> The product name lives in one place: `PRODUCT_NAME` in `lib/config.ts`.

## Run it

Start the agent, then the dashboard:

```bash
cd agent
uv venv --python 3.12 && uv pip install -r requirements.txt
.venv/bin/langgraph dev --no-browser      # http://localhost:2024, assistant "lucid"
```

```bash
npm install
npm run dev
```

The agent needs `ANTHROPIC_API_KEY` (and `LANGSMITH_API_KEY` for traces) in `.env` at the repo root. Open http://localhost:3000; it opens in the mode used last (Simulated device the first time). Target screen is a 1440×900 laptop (one screen, no page scroll); it also adapts down to ~1050 px wide.

The switch in the middle of the header flips between **Dashboard** and **Agent trace** (modeled on n8n's Editor / Executions switch). A run keeps going in both views, and the chosen view stays put when a new scan starts.

## Modes

| Mode | Scans come from | Header |
|---|---|---|
| **Simulated device** (`?mode=simulated`) | The backend's mock scans; the live data card shows a mock signal stream | Mock scan picker and **Run scan** |
| **Device** (`?mode=device`) | The Lucid device, through the device bridge | **Run scan** once a device is connected |

Switch with the menu under the device status, top left. The mode is remembered in the browser (localStorage) and shown in the address bar as `?mode=simulated` or `?mode=device`; opening a link with `?mode=` picks that mode, and the old `?live=1` still opens Simulated device. Switching drops the current run, so nothing from the other mode stays on screen; the patient stays the same until the page is reloaded.

**Device mode needs the device bridge, which is not built yet.** Until then it shows the no-device state: the status reads **No device**, the scan panel says **No device connected** with the reason ("No device bridge running"), **Run scan** is disabled (hovering it gives the reason), and the live data card shows empty charts and dashes. Device presence comes from `deviceStatus()` in `lib/device.ts`, a stub for the bridge to answer.

Modes are defined once, in `MODES` in `lib/mode.ts`: an id, a label, a one-line description, `agent` (whether the real agent drives the dashboard) and `source` (`"mock"` or `"device"`). Adding a mode is one more entry there. The module also exports the current mode (`getMode`), `useMode`, `setMode` and `isAgentMode`. Switching to a mode with a different engine (`agent` differs) reloads the page, so `isAgentMode(getMode())` holds for a page load. The components read `store` from `lib/store.ts`, which is where an engine for a non-agent mode would be chosen; here it is always the live store.

## Running a scan

Pick a mock scan in the header (Temporal bleed, Clear, Uncertain) and press **Run scan**. About 35 s later the agent pauses with a card:

- **Temporal bleed** and **Clear** pause for the result; a bleed pauses again before the pre-alert.
- **Uncertain** first asks you to re-scan the two weak-contact spots (**Re-scanned** / **Skip**), then runs the search again and proposes a result.

Click any simulation card to open it: the head mesh with the bleed and the potential change the solver computed for each scan spot, the simulated reading against the real scan, and a live log of what that card's agent is doing. Typing in the chat while a card is open rejects it with your text as the reason. Running a second scan on the same page re-scans the same patient against the saved baseline.

With `PHOTON_PROJECT_ID` and `PHOTON_API_KEY` in `.env`, approving the pre-alert texts it by iMessage to the clinician who is on call. A third process, the bridge, carries their replies onto the scan thread:

```bash
cd agent && .venv/bin/python -m lucid.bridge
```

The agent panel then shows the hand-off status, the clinician's texts and the answers sent back. Without the keys the pre-alert is recorded as simulated. Start order, on-call setup and the two-minute script are in [`DEMO.md`](DEMO.md).

The UI connects with the LangGraph SDK (`useStream` in `components/LiveBridge.tsx`); `lib/live.ts` maps agent state onto the dashboard store, and `lib/solver.ts` fetches the solver output for the detail view (`components/SimDetail.tsx`). While a hand-off is open, `LiveBridge.tsx` also reads its Store record every 2 s and joins runs this page did not start (the bridge's, when the clinician texts), re-reading the thread if the run already ended or the join fails; `lib/handoff.ts` merges the record into `handoff` and decides what the hand-off row shows. Agent design, tools and skills: [`agent/README.md`](agent/README.md).

Types beyond the data contracts below (`lib/types.ts`): `ScanStatus` gained `"pending"` (no result stated before approval) and `"rejected"`; `AgentStep` gained optional `parent`; `ApprovalRequest` gained optional `title`, `detail`, `approveLabel`, `rejectLabel`; `Simulation` gained optional `pass`, `by`, `note`, `reading`, `misfit`; `ChatMessage.role` gained `"clinician"`, `"call"` and `"event"` (a channel event, not a person), and `ChatMessage` optional `relayed` and `call` (`CallEntry`); `DashState` gained optional `reading`, `activity`, `baseline` and `handoff`; its `t` is ms since **Run scan**. `Handoff` is new: `kind` (`"prealert"` or `"update"`), `to`, `sent_at`, `delivered_at`, `no_reply_at`, `channel`, `status` (`HandoffStatus`), `simulated`, `reply` (`HandoffReply`) and `call` (`HandoffCall`).

Dev aids: in dev builds, `?view=trace` opens the agent trace and `?thread=<id>` opens an existing agent thread instead of waiting for **Run scan**. In the browser console, `__lucidLive` is the store.

## Views

**Dashboard**

- **Left:** folder tabs. *Scan* has the verdict, a summary line, spot progress, and the brain with its heatmap and 8 spot markers. *Simulations* has one row per region agent and a grid of hypothesis cards, best fit pinned first.
- **Live data card:** rolling 10 s coil and NIR charts, a tilt dial (flat face, tick ring, a thin reticle marker for pitch and roll), and a signal-quality badge. With no device the header is the only status: the card shows empty charts and dashes, with no marker and no badge.
- **Agent panel:** one status row on top. Its 3×3 dot grid animates while the agent works, holds a pause shape while it waits for approval, and dims when idle; next to it are the current action, "Step n of m", and seconds on the current action. Clicking the row expands the plan, with tool calls nested under each step. Below that: streamed messages, an inline approval card when the agent pauses, and a composer. Once the medic approves a pre-alert, a hand-off row sits under the status row: who it went to and how far it got (Sent, Delivered, Accepted, Calling, No reply and so on); clicking it lists each step. The clinician's texts, Lucid's answers to them and any phone call show in the chat.

**Agent trace**

An n8n-style canvas of the same run, derived from the dashboard state by `deriveTrace` in `lib/trace.ts` (no separate data feed).

- **Main flow:** Lucid device → Read scan spots → Build likelihood map → Triage agent → Rank best fit → Medic approval → Send pre-alert. Edges light up with item counts as nodes finish.
- **Triage agent:** labelled connectors along its bottom edge for Chat Model, Memory, and Tool. The Tool connector holds the four region sub-agents (frontal, temporal, parietal, occipital) as pills; the `forward_sim` and `fit_score` tools feed each region agent.
- **Run states:** not run, running (spinning border), waiting (slow spin, on Medic approval), success (cyan border and check), rejected (orange border).
- **Node details** (right): status, start time, duration, and **Output / Input** tabs listing each field. The Triage agent opens on a **Reasoning** tab with its messages, and its Output is what it produced (verdict, best fit, recommendation).
- **Logs** (bottom): collapsed to one strip showing the latest entry; expand for one line per node start and finish. Clicking a row selects that node.
- **Canvas controls:** drag to pan, scroll to zoom; fit view / zoom in / zoom out buttons bottom left. Fits itself on resize.

## Project layout

```
app/                 Next.js App Router entry, fonts, global styles
components/
  ClientRoot.tsx     mounts the dashboard client-only (store, canvases, timers)
  Dashboard.tsx      frame + layout (sketch: big tabbed panel left, two panels right); swaps in the trace view
  Header.tsx         floating nav pill, device status with the mode menu, Dashboard / Agent trace switch, scan time, mock scan picker, Run scan
  LeftPanel.tsx      folder tabs: Scan / Simulations
  ScanTab.tsx        verdict, summary line, spot progress, brain view
  BrainView.tsx      brain render + heatmap canvas + scan-spot markers + active-spot arc
  SimulationsTab.tsx region agent rows + simulation grid
  LiveData.tsx       coil / NIR rolling charts, tilt dial, signal quality
  AgentPanel.tsx     status row with plan + tool calls, hand-off row, chat with the clinician's texts and calls, approval card, composer
  LiveBridge.tsx     useStream to the agent; while a hand-off is open, polls its Store record and joins the bridge's runs
  TracePage.tsx      agent trace view: canvas, node details panel, logs dock
  TraceCanvas.tsx    n8n-style node graph with pan, zoom and fit
  icons.tsx          Phosphor icons (light) as inline SVG, plus spinner, ring and signal bars
  ui.tsx             shared status maps, panel, text swap, heatmap colour scale
lib/
  types.ts           all data types (contracts below)
  mode.ts            the modes (Simulated device, Device): the list, the current mode, switching (tests: mode.test.mjs)
  device.ts          whether a mode has a device to scan with; deviceStatus() is the stub for the device bridge
  mock.ts            head geometry, scan spot names, region names, the simulated device's signal stream
  store.ts           the store the components read (the live store)
  live.ts            the live store: maps agent state and stream events onto the dashboard state
  trace.ts           derives the agent trace graph, run states and log from the dashboard state
  handoff.ts         the hand-off from thread state and Store record, its row badge and steps (tests: handoff.test.mjs)
  useDash.ts         React hook that subscribes to the store
  brain.ts           compositing the brain render with heat
  config.ts          product name, sample rate, chart window
public/renders/      generated brain renders and textures
```

## Data contracts

All types are in `lib/types.ts`; the simulated device's stream is in `lib/mock.ts`.

**Device sample** (~50 Hz)

```json
{ "t": 1234, "coil_db": -38.4, "nir": 0.61, "imu": { "pitch": 4.2, "roll": -1.0 }, "spot": 3, "quality": "good" }
```

`quality` is `"good" | "weak" | "bad"`. `spot` is 0–7. `t` is in ms; `pitch` and `roll` are in degrees.

**Scan update** (when a spot finishes; `map` is cumulative)

```json
{ "spot": 6, "done": true, "map": [[0.0, "...64x64, 0-1"]], "status": "bleed", "region": "L temporal", "volume_ml": 19, "confidence": 0.78 }
```

`status` is `"bleed" | "uncertain" | "clear"`. A map value of `0` means not scanned yet.

**Simulation**

```json
{ "id": "sim-14", "type": "epidural", "region": "L temporal", "volume_ml": 22, "status": "done", "score": 0.91, "map": [[0.0, "...32x32"]] }
```

`type` is `"epidural" | "subdural" | "intraparenchymal"`, `status` is `"queued" | "running" | "done"`, `volume_ml` is 5–40. The UI also uses `agent` (which region agent owns it: `"frontal" | "temporal" | "parietal" | "occipital"`) and `progress` (0–1 while running).

Map coordinates: axial view from above, nose up, patient's left on screen left; `[-1, 1]` in both axes, row 0 is the front.

## Design

Look and motion are taken from the references, not invented:

| Reference | Used for |
|---|---|
| [GenRevive](https://genrevive.peachworlds.com/) | The brain as one large, lit centerpiece with a cool rim light and a faint surface scan grid; glass cards at the edges |
| [Alpine Bio](https://www.alpbio.com/) | Switzer type; large tightly tracked statement (−0.05em) for the verdict; faint vertical guide lines; 25px / 600ms fade-up entrances |
| [Delta Cafés](https://deltacafes.com/en) | Floating translucent nav pill; filled pill CTA with a separate arrow circle and arrow-swap hover; small cards clustered over the image |
| [Koniku](https://koniku.fiftyseven.co/) | Mask-up swap for changing text and numbers; hover and expo easing curves; 9% white hairlines; tracked uppercase micro-labels |
| [Grainient](https://grainient.supply/) | App inside one large rounded frame; near-black field with a diffused grainy glow along the bottom (teal, violet, and a warm hint of the heat colour) |
| [Beautiful UI](https://www.beautifului.dev/) | Agent panel: one status row with a 3×3 dot grid (animates while working, pause shape while waiting, dim when idle) and shimmering label, expanding to the plan with nested tool calls and detail chips; word-by-word streaming; inline approval card; inset composer. Also the 44px region agent rows and 14px charcoal surfaces. 100–400ms timings with `cubic-bezier(.23,1,.32,1)` |
| [n8n](https://github.com/n8n-io/n8n) | Agent trace view and the header view switch: 16px dot grid, node shapes (96px nodes, rounded-left trigger, circular sub-nodes, agent tools as pills), dashed AI connectors, run-state borders, item-count labels on edges, node details tabs, fit / zoom controls. Values taken from n8n's open-source canvas code |

- **Font:** Switzer (Fontshare), one sans family, self-hosted in `app/fonts`. Its digits are tabular by default.
- **Icons:** [Phosphor](https://phosphoricons.com/), light weight (MIT), embedded as SVG paths in `components/icons.tsx`. No icon package is installed.
- **Colour:** 60-30-10, checked by measuring screenshot pixels: dark frame and brain stage (~55–58%), lighter tool surfaces and text (~34–35%), colour for state, heat and glow (~8–10%).
- **Status:** every status pairs an icon with a label (bleed and amber can look alike to colour-blind users).
- **Brain renders** in `public/renders/` were generated with an image model for this project.

## Notes

- If a change to `app/globals.css` doesn't show up while `npm run dev` is running, restart the dev server. The Tailwind/Turbopack loader in this setup doesn't always hot-reload that file.
- Branch `tilt-on-brain-view` (not merged) shows tilt on the brain view instead of the dial: a needle at the active spot and an amber "Tilted, hold flat" past 20°.

## Known limitations

The brain is a static 3D fsaverage6 cortex. It renders the supplied axial scan/preview map with an azimuthal projection; the projection displays the original likelihood values and does not infer a 3D lesion. Below the axial equator, brightness continues from scan coverage at the same azimuth on the rim; rim heat fades out over 12 degrees, without extrapolating a lesion down the side. Footprint-normalized sampling and a smooth radial transition avoid an equator outline. The 2D view is retained only for WebGL/model-loading failures. The offline closing leaves fold edges softer under magnification than the visual reference.
