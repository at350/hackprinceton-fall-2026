# Lucid

Dashboard for **Lucid**, a handheld brain-bleed screener (HackPrinceton Fall 2026, Healthcare track). A medic moves the device over 8 spots around the head; the laptop shows the bleed-likelihood map filling in, live device signals, region simulations ranked by fit, and an AI agent that explains the result and asks the medic to approve next steps. A second view shows the same agent run as an n8n-style workflow trace.

The dashboard runs in two modes. **Demo** (default) plays a scripted story with mocked data. **Live** (`?live=1`) is driven by a real LangChain deep agent in [`/agent`](agent/README.md): real plan steps, about 100 simulations filling the grid, and Approve / Reject pauses that resume the agent. There is no hardware yet; the agent reads mock scans.

> The product name lives in one place: `PRODUCT_NAME` in `lib/config.ts`.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000. Target screen is a 1440×900 laptop (one screen, no page scroll); it also adapts down to ~1150 px wide.

The demo starts on load and loops. **Play demo** (top right) restarts it from the beginning; the pause button freezes the story.

The switch in the middle of the header flips between **Dashboard** and **Agent trace** (modeled on n8n's Editor / Executions switch). The demo keeps running in both views, and the chosen view stays put when the demo restarts or loops.

## Live mode: the real agent

```bash
cd agent
uv venv --python 3.12 && uv pip install -r requirements.txt
.venv/bin/langgraph dev --no-browser      # http://localhost:2024, assistant "lucid"
```

Needs `ANTHROPIC_API_KEY` (and `LANGSMITH_API_KEY` for traces) in `.env` at the repo root. Then open http://localhost:3000/?live=1 (or set `NEXT_PUBLIC_LUCID_MODE=live`).

Pick a mock scan in the header (Temporal bleed, Clear, Uncertain) and press **Run scan**. About 30 s later the agent pauses with an approval card. A bleed pauses twice: once for the result, once before the pre-alert. Typing in the chat while a card is open rejects it with your text as the reason. Running a second scan on the same page re-scans the same patient against the saved baseline.

The UI connects with the LangGraph SDK (`useStream` in `components/LiveBridge.tsx`); `lib/live.ts` maps agent state onto the same store the demo uses. Agent design, tools and skills: [`agent/README.md`](agent/README.md).

Types changed for live mode (`lib/types.ts`): `ScanStatus` gained `"pending"` (no result stated before approval) and `"rejected"`; `AgentStep` gained optional `parent`; `ApprovalRequest` gained optional `title` and `detail`.

## The 2-minute demo story

| Time | What happens |
|---|---|
| 0:00 – 0:04 | Device goes Disconnected → Connecting → Device connected; live signals start |
| 0:04 | Agent greets and lays out its plan |
| 0:08 – 0:57 | 8 spots scan one by one; each finished spot lights up its part of the brain and adds heat. Spot 6 has weak contact and is re-scanned |
| ~0:51 | Bleed shows at L temporal; result card switches to **Bleed likely** |
| 0:59 – 1:25 | Tab switches to Simulations; 4 region agents run 24 hypotheses; best fit takes over at the top |
| 1:25 | Agent explains the best fit (epidural, L temporal, ~22 mL, fit 0.91) |
| ~1:31 | Tab switches back to Scan; result card shows the best fit (22 mL, 91% confidence) |
| 1:36 | Agent asks for approval to send a pre-alert. Story waits for **Approve / Reject** (auto-approves after 15 s so the loop keeps going) |
| 2:00 | Resets and loops |

You can also type to the agent; it answers from a few canned replies. After **Reject**, typing "re-scan" restarts the demo. Clicking a tab stops the demo from switching tabs for you until the next restart.

Dev aid (dev builds only): in the browser console, `__demo.seek(60000)` jumps the story to 1:00, and `__demo.setView("trace")` or `__demo.setView("dashboard")` switches the view. The store is exposed in `lib/demo.ts`. For screenshots, `?view=trace&t=90000` opens a view at a story time.

## Views

**Dashboard**

- **Left:** folder tabs. *Scan* has the verdict, a summary line, spot progress, and the brain with its heatmap and 8 spot markers. *Simulations* has one row per region agent and a grid of hypothesis cards, best fit pinned first.
- **Live data card:** rolling 10 s coil and NIR charts, a tilt dial (flat face, tick ring, a thin reticle marker for pitch and roll), and a signal-quality badge. While the device is disconnected the header is the only status: the card shows empty charts and dashes, with no marker and no badge.
- **Agent panel:** one status row on top. Its 3×3 dot grid animates while the agent works, holds a pause shape while it waits for approval, and dims when idle; next to it are the current action, "Step n of 5", and seconds on the current action. Clicking the row expands the plan, with tool calls nested under each step. Below that: streamed messages, an inline approval card when the agent pauses, and a composer.

**Agent trace**

An n8n-style canvas of the same run, derived from the demo state by `deriveTrace` in `lib/trace.ts` (no separate data feed).

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
  Header.tsx         floating nav pill, device status, Dashboard / Agent trace switch, scan time, demo clock and controls
  LeftPanel.tsx      folder tabs: Scan / Simulations
  ScanTab.tsx        verdict, summary line, spot progress, brain view
  BrainView.tsx      brain render + heatmap canvas + scan-spot markers + active-spot arc
  SimulationsTab.tsx region agent rows + simulation grid
  LiveData.tsx       coil / NIR rolling charts, tilt dial, signal quality
  AgentPanel.tsx     status row with plan + tool calls, chat, approval card, composer
  TracePage.tsx      agent trace view: canvas, node details panel, logs dock
  TraceCanvas.tsx    n8n-style node graph with pan, zoom and fit
  icons.tsx          Phosphor icons (light) as inline SVG, plus spinner, ring and signal bars
  ui.tsx             shared status maps, panel, text swap, heatmap colour scale
lib/
  types.ts           all data types (contracts below)
  mock.ts            all mock generators (head geometry, scan maps, simulations, device stream)
  demo.ts            the demo timeline engine (store + story events)
  trace.ts           derives the agent trace graph, run states and log from the demo state
  useDash.ts         React hook that subscribes to the demo store
  brain.ts           compositing the brain render with heat
  config.ts          product name, demo length, sample rate, chart window
public/renders/      generated brain renders and textures
```

## Data contracts

All types are in `lib/types.ts`; all mocks are in `lib/mock.ts`.

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

Demo mode uses the static 3D fsaverage6 cortex. Live mode uses the existing 2D brain so it displays the backend’s scan and preview maps faithfully, including clear, pending, and rejected results. Live 3D awaits a backend 3D bleed descriptor; the scripted demo lesion is never used in live mode.
