# Deal-In & Living Board — Implementation Plan

> Cross-session working doc. Captures the specs agreed with Quinn (2026-06-11) for two
> juice features: the **Deal-In** (run-start choreography) and the **Living Board**
> (per-cell liveness display + critical-state pressure). Update the Status section as
> work lands. Specs here are *decided*, not proposals — change only with Quinn.

## Status

- [x] Deal-in: spec agreed
- [x] Deal-in: implemented (single-player triggers) — commit pending review, **do not push without approval**
- [ ] Deal-in: multiplayer room-join trigger (deferred — server state arrives async; needs "board empty + moves 0" gate)
- [ ] Deal-in: per-theme polish pass (win98 LCD readout beat, audius/glass/mondrian wordmarks)
- [ ] Living Board: liveness computation + two-phase state machine
- [ ] Living Board: default visual treatments
- [ ] Living Board: per-theme passes
- [ ] Announcer ("CLOSE CALL!" etc.): trigger slots wired, **no audio assets yet** — Quinn will supply voice lines later

Unrelated pre-existing WIP: `client/src/theme-glass.css` has uncommitted stained-glass
masonry tuning from an earlier session (see root `task_plan.md`/`findings.md`). Keep it
out of feature commits.

---

## Feature 1: The Deal-In (run-start choreography)

Plays on **fresh runs only**: New Game / reset, daily start (incl. archive days), mode
switch that creates a new game, tutorial exit, and cold load of a pristine (moves=0,
score=0) game. Resumed mid-run games restore instantly with no animation. Never plays
during tutorial stages.

Timeline (≈900ms perceived, state window 2100ms to cover hand tail):

1. **0–~570ms — board cascade.** Cells pop in (scale 0 → 1.07 → 1, ~230ms each)
   rosette by rosette: center flower first, then the six outer flowers clockwise by
   screen angle. Rosette stagger 45ms; within a rosette, cells order center-out
   (12ms stagger standard board, 5ms big board). Board chrome (panel, outline,
   grooves) stays static — only the playable surface cascades. Each rosette start
   plays a `click_up` tick pitch-stepped upward across the seven flowers
   (`playDealTick(i, 7)`, playbackRate 1.0→2.0, reduced gain).
2. **400–1650ms — hand deal.** Existing `hexaclear-hand-flyin` animation, base delay
   +400ms during deal-in (slot stagger 175ms unchanged).
3. **~620–990ms — chrome beat.** Wordmark brightness shimmer (360ms @ 620ms);
   score readout pop (240ms @ 750ms).

Skip: any `pointerdown` during the deal-in ends it immediately (cells snap to final,
hand animations fast-forward 400ms). Reduced motion: cell/chrome animations off, board
does a single 150ms fade, no audio ticks, state window 320ms.

Future hook: when Living Board lands, the cascade's final beat becomes "the light
sweeps on" (liveness lighting activates board-wide as the last rosette lands).

### Code map

- `client/src/App.tsx`
  - `buildBoardRenderData` (~line 1412): now computes `dealDelayByCellId` per mode
    (rosette order via `geometry.flowerCenters` + screen angle from `layout.positions`).
  - Deal-in state + `startDealIn` / `finishDealIn` near `handFlyInToken` (~3312).
  - Triggers: `resetGame`, `exitTutorial`, mode-switch fresh branches (~7546),
    `handleStartDailyForDateKey`, daily-restart button (~14580), mount-pristine effect.
  - Viewport class `is-dealing-in` (~9564); per-cell `--hexaclear-deal-delay` style var
    on the cell `<g>` (~11475).
  - Hand slot fly-in delay base (~17551).
- `client/src/audio.ts`: `playDealTick(step, steps)` — `clickUp` buffer, rate-shifted.
- `client/src/index.css`: `is-dealing-in` rules + keyframes
  (`hexaclear-cell-dealin`, title/stat beats, reduced-motion overrides) near the
  existing hand fly-in block.

---

## Feature 2: Living Board (liveness + pressure) — NOT YET BUILT

One derived value after every board/hand change: per-cell and total **valid placement
counts** for the current hand (reuse `hasAnyValidMove` machinery in
`game/gameLogic.ts:583`; ≤3 pieces × ≤49 anchors, compute once, memoize).

### Phase A — Liveness (normal play)

- An empty cell is **live** if ≥1 current hand piece has ≥1 valid placement covering it.
- Live cells: normal brightness + shared ambient "breath" (one global 4s sine phase,
  CSS-driven). Dead cells: theme-native dead state, still, 400ms transition.
  Two CSS vars per theme: `--cell-empty` / `--cell-empty-dead`. Default fallback:
  −30% lightness, slight desaturation.
- Dead **hand pieces** (zero fits): desaturate ~40%, 75% opacity, 2° droop sag.
  (An `unplayable` class already exists on hand buttons — extend, don't duplicate.)
- Relight rides the existing clear ripple outward (no new wave system).
- Per-theme dead cells: wood = unlit timber; glass = pane loses backlight; win98 =
  disabled-control grey; mondrian = grey, loses primary eligibility.

### Phase B — Critical state ("under threat")

- **Enter at ≤4 total valid placements; exit at ≥8 or on any clear** (hysteresis, no strobing).
- Onset beat: after the triggering placement resolves, 120ms full freeze, then ALL
  empty cells snap to alarm state **simultaneously**; a global 900ms pulse clock starts
  (cells + hand + score readout in sync).
- The alarm is **uniform = information-free**: no valid/invalid distinction per cell,
  and **dead-piece sag suspends** (hand differentiation would leak where the last fit
  lives). Player memory of the pre-critical map is earned knowledge.
- Audio: synthesized 55Hz sine thump per pulse (Web Audio oscillator, ~−18dB under
  master, no asset files) + master lowpass easing toward ~2.4kHz. Both cut instantly
  on exit. Reduced motion: pulses become static state change; thump stays.
- Exit: alarm cuts same-frame on the clear; map relights over 400ms on the ripple.
  This is the "CLOSE CALL!" announcer slot — wire trigger, leave audio empty.
- Per-theme alarm: wood = ember glow pulse in empty cells; win98 = pulsing red inset
  borders + LCD blinking like a VCR at 12:00; glass = irregular candle-gutter flicker;
  mondrian = thickened black borders + grey fill ticking toward red; audius =
  visualizer hue clamps red.

### Guards

- Disabled entirely during tutorial stages (near-complete boards would false-alarm).
- Thresholds absolute on big board.
- PvP territory tints render above dead-cell states at full strength; liveness uses
  the local player's hand on their own screen.
- Game-over at 0 fits fires exactly as today; critical exists only in the 1–4 window.
- Death sequence upgrade (with Living Board): remaining live cells gutter out one by
  one (~60ms stagger) + brief held silence before the existing desaturate wind-down.

### Design rationale (for future sessions)

Per-cell liveness is an approachability assist; the critical state deliberately
**revokes** the map at ≤4 fits so the endgame hunt-for-the-last-fit stays a human
skill. Uniformity of the alarm is load-bearing — any differentiation (cells OR hand)
reintroduces the answer key. Quinn's call, agreed 2026-06-11.

Relevant design-philosophy doc: `Documentation/Cubekill Design Improvements.md`
(no FOMO; don't raise cognitive load; juice is the product).

---

## Build order

1. ✅ Deal-in (this commit — await Quinn's review before push)
2. Living Board liveness computation + two-phase state machine
3. Default visual treatments (Phase A then Phase B)
4. Per-theme passes (deal-in chrome + living board together)
