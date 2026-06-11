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
- [x] Living Board: liveness computation + two-phase state machine (`computeBoardLiveness`
      in gameLogic.ts; critical enter/exit effect in App.tsx near `gameOverWindingDown`)
- [x] Living Board: default visual treatments (opacity-only, theme-safe) + critical audio
      (55Hz thump + master lowpass in audio.ts via `setCriticalAudio`)
- [ ] Living Board: per-theme passes (ember/win98-LCD-blink/candle-gutter/mondrian-red/audius-clamp)
- [ ] Living Board: death gutter-out (live cells extinguish one-by-one before wind-down) —
      deferred; current behavior is the pre-existing desaturate wind-down
- [ ] Living Board: multiplayer support — deferred, system fully disabled when `isMultiplayer`
- [ ] Announcer ("CLOSE CALL!" etc.): the critical-exit branch in App.tsx is the hook point,
      **no audio assets yet** — Quinn will supply voice lines later

Implementation deviations from spec (all minor, flag to Quinn if they read wrong):
- Onset freeze reuses the existing 90ms hitstop (spec said 120ms); alarm raises 120ms
  after the freeze starts.
- Dead-cell dimming stays during drag; the ghost preview classes visually dominate
  rather than the map being suppressed wholesale.
- The live-cell breath lives on the dimple (`.hexaclear-slot-fill`), not the hex
  polygon — the polygon's animation slot is contended (octave-2 tint drift, glass
  preview glows) and CSS animations don't compose.
- Exit-on-clear re-enters with a fresh onset if the board is still ≤4 after the clear
  settles (enter waits for `clearingCells` to drain).

Unrelated pre-existing WIP: `client/src/theme-glass.css` has uncommitted stained-glass
masonry tuning from an earlier session (see root `task_plan.md`/`findings.md`). Keep it
out of feature commits.

---

## Feature 1: The Deal-In (run-start choreography)

Plays on **fresh runs only**: New Game / reset, daily start (incl. archive days), mode
switch that creates a new game, tutorial exit, and cold load of a pristine (moves=0,
score=0) game. Resumed mid-run games restore instantly with no animation. Never plays
during tutorial stages.

Timeline (≈3.5s perceived, state window 3600ms; slowed 4x from the first cut at
Quinn's request — ceremonial, not snappy):

1. **0–~1.9s — board cascade.** Cells pop in (scale 0 → 1.07 → 1, ~520ms each)
   rosette by rosette: center flower first, then the six outer flowers clockwise by
   screen angle. Rosette stagger 180ms; within a rosette, cells order center-out
   (48ms stagger standard board, 20ms big board). Board chrome (panel, outline,
   grooves) stays static — only the playable surface cascades. Each rosette start
   plays a `click_up` tick pitch-stepped upward across the seven flowers
   (`playDealTick(i, 7)`, playbackRate 1.0→2.0, reduced gain).
2. **1.6–2.85s — hand deal.** Existing `hexaclear-hand-flyin` animation, base delay
   +1600ms during deal-in (slot stagger 175ms unchanged).
3. **2.4–3.5s — chrome beat.** Wordmark brightness shimmer (600ms @ 2400ms);
   score readout pop (480ms @ 3000ms).

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
