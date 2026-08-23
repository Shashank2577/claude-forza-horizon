# Phase 1 — Events + Festival Map (Design Spec)

- **Date:** 2026-08-09
- **Project:** Horizon — open-world arcade racer (Three.js)
- **Status:** Approved (pending spec review)
- **Reference standard:** Forza Horizon (gauntlet-loop aim-prompt target)
- **Phases:** This is **Phase 1 of 3**. Phase 2 = game flow & menus; Phase 3 = progression & persistence.

## Context

The game is already a mature single-event build: driving physics (slip/launch/impact/airborne/nitro/surfaces), a 9000 m procedural road, a 12-checkpoint Road Race + Speed Trap + Danger Sign + Drift Zone PR stunts, AI rivals with rubber-banding and fold-immune ranking, a premium HUD, a festival hub, audio, and FX. The earlier "make it a game, not a sandbox" gap is largely closed; the next gap is **depth and structure** — turning one event into a drivable festival map with multiple events.

### Methodology (gauntlet-loop)

This project is built with the [gauntlet-loop](https://github.com/duolahypercho/gauntlet-loop) aim-prompt methodology (Matt Shumer's concise game-building prompt): fill a three-paragraph aim prompt with nouns, run it as instructions, fan out sub-agents on the **game**, run a **separate harsh critic** that blind-compares **in-game frames vs the real Forza Horizon**, and loop until the human stops it. The human is the brake.

Filled aim prompt for this project:

> Build an open-world racer at the level of Forza Horizon — utterly perfect, visually beautiful, AAA quality, from events and the festival map to progression and game flow. Fan out sub-agents per area; a separate harsh critic blind-compares in-game frames side-by-side with real Forza Horizon and keeps going until each is AAA. Do this in Three.js. Loop until it's utterly perfect.

**Tension resolved:** gauntlet-loop says "don't wrap it in a framework." This spec is a lightweight *design agreement* (what + how it fits), not a substitute for building. Execution stays pure-prompt: author the game, screenshot one frame, critic-vs-FH blind A/B, fix, repeat. No capture farms, no invented scoreboards.

### Confirmed decisions

- **Next-target priority** (user-selected): (1) events + festival map → (4) game flow & menus → (2) progression & persistence.
- **World topology** (user-selected): **B — add one closed festival circuit loop.** Chosen over "event layer only" (no lap race) and "full road network" (too large / stall-prone).

## Goal

Turn the single Road Race into a drivable overworld: a festival hub the player drives around, **five selectable events**, and an event-select loop — drive to an event node → enter → countdown → race → results → return to overworld. The headline addition is a true **Circuit / Lap race** on a new closed loop.

## Non-goals (deferred)

- Main menu, pause menu, results→next-event flow polish, gamepad/touch controls → **Phase 2**.
- Credits / XP / Influence, `localStorage` saves, unlocks → **Phase 3**. (Results card will be structured to accept rewards later, but no persistence in Phase 1.)
- Reworking `Road.js` into a road graph. The world road and the new circuit are both standalone ribbons.
- Car selection / garage (single hero car remains).
- Rival AI behavior changes (rubber-banding + bumps already exist; rivals are reused as-is).

## Architecture

The work has two halves: (a) a **refactor** of the monolithic `Race.js` into a composable event system, and (b) **new** systems (the circuit loop, the overworld state machine, event nodes).

### (a) Refactor `src/game/Race.js` → event system

`Race.js` today couples checkpoint progression, timing, the next-waypoint beacon, and all three PR stunts on the single world road. It is refactored into:

| New module | Responsibility | Source |
|---|---|---|
| `src/game/ProgressTracker.js` | Arc-length progress on any road; incremental fold-immune tracking (from `Race._trackProgress`); optional **lap wrap** for closed loops; teleport resync (the existing `>300 m` full-arc fallback). | Extracted from `Race.js` + `Rivals._arcAt`. |
| `src/game/stunts/SpeedTrap.js` | Speed Trap PR stunt (peak-speed window + star grading + readout board). | Extracted from `Race.js`. |
| `src/game/stunts/DangerSign.js` | Danger Sign PR stunt (launch ramp + big-air scoring). | Extracted from `Race.js`. |
| `src/game/stunts/DriftZone.js` | Drift Zone PR stunt (sustained-slip scoring). | Extracted from `Race.js`. |
| `src/game/Event.js` | Common base: `start(car)`, `update(dt, car)`, `reset()`, `finish()`, and a `state` snapshot the HUD reads. Owns a `ProgressTracker` + optional `Rivals` + optional stunts. | New. |
| `src/game/SprintRace.js` | N checkpoint gates on a road segment; split + total timers; finish rating. (The current Road Race, re-homed.) | From `Race.js` gate logic. |
| `src/game/CircuitRace.js` | Closed loop; **lap counting + per-lap times**; finish after N laps. | New. |
| `src/game/StuntEvent.js` | Wraps a single stunt as a standalone, retryable, scored event. | New. |

`Race.js` is removed once its responsibilities are fully distributed. `Rivals.js` is lightly changed: it gains `attach(event)` / `detach()` so it can re-grid at the active event's start and race on the active event's road (world or circuit). Its existing rubber-banding, bumps, and branch-aware ranking are reused unchanged.

### (b) New systems

| New module | Responsibility |
|---|---|
| `src/core/Circuit.js` | A closed-loop road beside the festival. Mirrors the `Road` API (`startSample`, `centerline`, `sampleAtDistance` with lap wrap, `distanceToCenterline`, `totalLength`). |
| `src/core/RoadBuilder.js` | Shared ribbon/curb geometry builders (`buildRibbon(samples, opts)`, `buildCurbs(samples, opts)`), extracted from `Road.js` so `Road` and `Circuit` share one implementation. `Road.js` is edited only to *call* these helpers — its centerline, shader injection, and behavior stay identical. |
| `src/game/Overworld.js` | The top-level game state machine + event registry + active-event owner. Replaces the `gameStarted` / `freeroam` booleans in `main.js`. |
| `src/world/EventNodes.js` | Glowing festival-map beacons at each event start; proximity detection + minimap markers. |

### `main.js` wiring changes

- Construct `circuit = new Circuit({ terrain, festival, seed })` and add to scene.
- Construct `overworld = new Overworld({ terrain, road, circuit, festival, seed })`; register the five events. `overworld` owns the single `Rivals` instance and the active `Event`.
- The frame loop calls `overworld.handleInput(input)` then `overworld.update(dt, car)`, which dispatches to the active event, rivals (event-permitting), and event nodes (freeroam only). HUD receives `overworld.state` (mode, active event state, prompt, nodes, popups).
- The existing start overlay becomes the overworld entry ("PRESS ENTER TO ENTER FESTIVAL").
- `window.__game` dev handle is updated to know the active road (so captures/teleports work post-refactor).

## The five events (Phase 1)

1. **Circuit** — 3 laps on the new closed loop, with rivals. Lap counter + current lap time on the HUD. *New headline event.*
2. **Sprint** — the existing 8820 m point-to-point road race, 12 checkpoints, with rivals. *Re-homed, not rebuilt.*
3. **Speed Trap** — standalone scored stunt (solo). *Extracted.*
4. **Danger Sign** — standalone scored stunt (solo). *Extracted.*
5. **Drift Zone** — standalone scored stunt (solo). *Extracted.*

Stunt logic is shared, so the three stunts also remain **passively scoreable while freeroaming** at zero extra cost (current behavior preserved).

## Circuit loop design

- **Shape:** a closed, noise-perturbed loop (~2–3 km lap) — kidney/oval, not a perfect circle, so it has a couple of overtaking zones and a couple of technical bends (Forza feel).
- **Placement:** beside the festival hub, offset from the world-road start along the start-sample right vector by enough to clear both the festival structures and the world road. Exact world coordinates are tuned during build using `window.__game` teleport + screenshots (no fixed TBD — a deterministic seed-derived placement, then tuned).
- **Geometry:** closed centerline → uniform arc-length resample → terrain drape + low-pass (same anti-jitter approach as `Road`) → asphalt ribbon + edge lines via `RoadBuilder`. Curbs optional in v1; can add on tight corners if the critic wants them.
- **Seam:** first and last centerline samples coincide; the ribbon closes without a visible gap; `sampleAtDistance` wraps modulo lap length.
- **API parity with `Road`** so `ProgressTracker`, `Rivals`, gates, and beacons work on it unchanged.

## Data flow / state machine

```
Overworld modes:  freeroam → armed (countdown) → racing → finished → freeroam

frame(now):
  input = controls.poll()
  overworld.handleInput(input)         // Enter near a node → arm; during countdown → no-op; R → reset
  driveInput = (mode === 'armed') ? FROZEN : input   // countdown freezes the car
  car.update(FIXED, driveInput, terrain)
  overworld.update(dt, car)
    ├─ state machine transitions (countdown timer, finish detection, return-to-freeroam)
    ├─ activeEvent?.update(dt, car)    // gates / beacon / stunts / laps / timing
    ├─ rivals.update(dt, car)          // only if activeEvent.hasRivals; on activeEvent.road
    └─ eventNodes.update(dt, car)      // proximity prompt; freeroam only
  hud.update({ car, fps, overworld.state, activeEvent: activeEvent?.state, rivals: rivals.state, camera })
```

`overworld.state` exposes: `mode`, `activeEventId`, `eventTitle`, `prompt` (proximity text or null), `nodes` (for minimap), `popups`, plus a passthrough of the active event's state (laps, splits, stunt scores, finish time, rating).

## Robustness (the bits that will be verified carefully)

- **Closed-loop progress tracking.** A closed loop is the worst case for "nearest centerline point" search. `ProgressTracker` in lap mode must never snap backward across the seam or double-count. Verified by driving repeated laps and confirming monotonic lap counting.
- **Two-road context.** `ProgressTracker`, `Rivals`, and the car's `setRoad` must all reference the *active* road. Starting an event sets `car.setRoad(activeEvent.road)`; rivals re-grid on that road. Guards prevent rivals chasing the wrong centerline.
- **Teleport resync.** Event start placement is a teleport; the existing `>300 m` full-arc resync handles it. Verified by entering each event and confirming the car is correctly placed and oriented on the start line.
- **Rivals gating.** Events without rivals (the three stunts) skip `rivals.update`; the field is hidden. Circuit/Sprint spawn/re-grid rivals.
- **Frame budget.** Adding the circuit mesh + event nodes must hold FPS; the existing adaptive quality + per-system culling should absorb it. Verified via the on-screen FPS meter and the existing quality tier.
- **Dev handle.** `window.__game` updated so automated captures work after the refactor.

## Verification (gauntlet-loop)

No unit-test framework exists (and none will be added — verification is in-game). For each component:

1. Author the change directly (delegated builders have stalled on this project before — direct authoring + on-disk verification).
2. Run the dev server (`npm run dev`), drive/capture **one** light in-game screenshot at the relevant state.
3. Harsh critic blind-compares the frame to a **real Forza Horizon** reference frame (circuit race, sprint, stunt) and states which looks better + what's short of AAA.
4. Fix, re-capture, repeat. Stop when the critic is wowed or the user says stop.

Milestone checks per event: countdown fires → gates trigger → **laps count and wrap correctly (circuit)** / splits tick (sprint) / scores register (stunts) → finish card shows correct results → return-to-overworld works → rivals grid on the correct road.

## Risks

- **Refactor blast radius.** `Race.js` is 877 lines and central. Mitigation: extract incrementally (ProgressTracker → stunts → events), keeping the game runnable at each step; the Sprint event is the regression canary (it must behave exactly as today).
- **Closed-loop tracking correctness.** Mitigation: explicit lap-count verification before calling the circuit done.
- **Scope creep into menus/progression.** Mitigation: Phase 1 non-goals are explicit; the results card carries reward *placeholders* only.

## Roadmap (subsequent specs)

- **Phase 2 — Game flow & menus:** main menu, pause menu, results → retry / next-event, gamepad support, optional touch controls.
- **Phase 3 — Progression & persistence:** credits / XP / Influence earned from events + stunts, `localStorage` saves, unlocks (cars, events, perks). Wires into the reward placeholders left in Phase 1.
