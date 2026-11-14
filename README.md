# Lucid

Dashboard for **Lucid**, a handheld brain-bleed screener (HackPrinceton Fall 2026, Healthcare track). A medic moves the device over 8 spots around the head; the laptop shows the bleed-likelihood map filling in, live device signals, region simulations ranked by fit, and an AI agent that explains the result and asks the medic to approve next steps.

This repo is the **front end only**. Every data source is mocked; there is no backend, hardware, or real agent yet.

> The product name lives in one place: `PRODUCT_NAME` in `lib/config.ts`.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000. Target screen is a 1440×900 laptop (one screen, no page scroll); it also adapts down to ~1150 px wide.

The demo starts on load and loops. **Play demo** (top right) restarts it from the beginning; the pause button freezes the story.

## The 2-minute demo story

| Time | What happens |
|---|---|
| 0:00 – 0:04 | Device goes Disconnected → Connecting → Device connected; live signals start |
| 0:04 | Agent greets and lays out its plan |
| 0:08 – 0:57 | 8 spots scan one by one; each finished spot lights up its part of the brain and adds heat. Spot 6 has weak contact and is re-scanned |
| ~0:51 | Bleed shows at L temporal; result card switches to **Bleed likely** |
| 0:59 – 1:25 | View switches to Simulations; 4 region agents run 24 hypotheses; best fit takes over at the top |
| 1:25 | Agent explains the best fit (epidural, L temporal, ~22 mL, fit 0.91) |
| 1:36 | Agent asks for approval to send a pre-alert. Story waits for **Approve / Reject** (auto-approves after 15 s so the loop keeps going) |
| 2:00 | Resets and loops |

You can also type to the agent; it answers from a few canned replies. Clicking a tab stops the demo from switching tabs for you until the next restart.

Dev aid: in the browser console, `__demo.seek(60000)` jumps the story to 1:00.

## Project layout

```
app/                 Next.js App Router entry, fonts, global styles
components/
  Dashboard.tsx      frame + layout (sketch: big tabbed panel left, two panels right)
  Header.tsx         floating nav pill, device status, patient, scan time, demo controls
  LeftPanel.tsx      folder tabs: Scan / Simulations
  ScanTab.tsx        verdict, spot progress, stat cards
  BrainView.tsx      brain render + heatmap canvas + scan-spot markers
  SimulationsTab.tsx region agent rows + simulation grid
  LiveData.tsx       coil / NIR rolling charts, tilt, signal quality
  AgentPanel.tsx     agent status, plan + tool-call trace, chat, approval, composer
lib/
  types.ts           all data types (contracts below)
  mock.ts            all mock generators (head geometry, scan maps, simulations, device stream)
  demo.ts            the demo timeline engine (store + story events)
  brain.ts           compositing the brain render with heat
public/renders/      generated brain renders and textures
```

## Data contracts

All types are in `lib/types.ts`; all mocks are in `lib/mock.ts`.

**Device sample** (~50 Hz)

```json
{ "t": 1234, "coil_db": -38.4, "nir": 0.61, "imu": { "pitch": 4.2, "roll": -1.0 }, "spot": 3, "quality": "good" }
```

`quality` is `"good" | "weak" | "bad"`.

**Scan update** (when a spot finishes; `map` is cumulative)

```json
{ "spot": 6, "done": true, "map": [[0.0, "...64x64, 0-1"]], "status": "bleed", "region": "L temporal", "volume_ml": 19, "confidence": 0.78 }
```

`status` is `"bleed" | "uncertain" | "clear"`. A map value of `0` means not scanned yet.

**Simulation**

```json
{ "id": "sim-04", "type": "epidural", "region": "L temporal", "volume_ml": 22, "status": "done", "score": 0.91, "map": [[0.0, "...32x32"]] }
```

`type` is `"epidural" | "subdural" | "intraparenchymal"`, `status` is `"queued" | "running" | "done"`, `volume_ml` is 5–40. The UI also uses `agent` (which region agent owns it) and `progress` (0–1 while running).

Map coordinates: axial view from above, nose up, patient's left on screen left; `[-1, 1]` in both axes, row 0 is the front.

## Design

Look and motion are taken from the references, not invented:

| Reference | Used for |
|---|---|
| [GenRevive](https://genrevive.peachworlds.com/) | The brain as one large, lit centerpiece with a cool rim light and a faint surface scan grid; glass cards at the edges |
| [Alpine Bio](https://www.alpbio.com/) | Switzer type; large tightly tracked statement (−0.05em) for the verdict; faint vertical guide lines; 25px / 600ms fade-up entrances |
| [Delta Cafés](https://deltacafes.com/en) | Floating translucent nav pill; filled pill CTA with a separate arrow circle and arrow-swap hover; small cards clustered over the image |
| [Grainient](https://grainient.supply/) | App inside one large rounded frame; near-black field with a diffused grainy glow along the bottom (teal, violet, and a warm hint of the heat colour) |
| [Beautiful UI](https://www.beautifului.dev/) | Agent panel: 3×3 dot loader + shimmering status, collapsible plan with nested tool calls and detail chips, word-by-word streaming, inline approval card, inset composer; 100–400ms timings with `cubic-bezier(.23,1,.32,1)` |

- **Font:** Switzer (Fontshare), one sans family, self-hosted in `app/fonts`. Its digits are tabular by default.
- **Colour:** 60-30-10, checked by measuring screenshot pixels: dark frame and brain stage (~55–58%), lighter tool surfaces and text (~34–35%), colour for state, heat and glow (~8–10%).
- **Status:** every status pairs an icon with a label (bleed and amber can look alike to colour-blind users).
- **Brain renders** in `public/renders/` were generated with an image model for this project.

## Notes

- If a change to `app/globals.css` doesn't show up while `npm run dev` is running, restart the dev server. The Tailwind/Turbopack loader in this setup doesn't always hot-reload that file.
