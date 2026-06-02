# Cubekill Theme Concepts & Implementation Notes

> **Companion to** `Cubekill Theme Authoring Guide.md`. The guide is the *how-to-build-any-theme*
> authority (the departure bar, the technical contract, the surface inventory, the hard
> constraints). This document holds **specific approved theme concepts** with enough
> implementation detail to start building.
>
> Read the guide first. Every concept here assumes its rules: scope all CSS under
> `[data-theme="…"]`, keep the `hexaclear-*` class prefix, never touch game logic or
> animation timings, re-skin **every** surface (§4 of the guide), re-express the
> score-tier/octave engine (§5), and keep reactive motion GPU-cheap and reduced-motion-safe.

## Naming & trademark (read before shipping any of these)

These are **paid** products, so legal exposure matters:

- **Piet Mondrian's** paintings are old enough to be public domain in most jurisdictions,
  and the *De Stijl / Neoplastic* visual language (white field, heavy black grid, flat
  primary planes) is a style, not something anyone owns. Even so, ship under an original
  descriptive name (e.g. **"De Stijl"** or **"Neoplastic"**), keep the artist's name out of
  the store listing and in-app copy, and don't reproduce a specific named painting 1:1.
- **"TRON"** is a Disney trademark; the film's specific marks/logos are protected. The
  *aesthetic* (a glowing dark grid, two light-teams, derez) is not ownable, but the name,
  logo, and lightcycle/identity-disc *names* are risky. Ship under an original name —
  this doc uses **"Grid / Lightwall."**
- Code `ThemeId` tokens stay English-ASCII: `glass`, `blueprint`, `mondrian`, `grid`.

---

## Concept index

| Product (suggested) | Token | Anchor | Departure tier | Build size |
|---|---|---|---|---|
| Stained Glass / Rose Window | `glass` | Visual + literal board↔rose-window mapping | Reinvention (with backlight) | Large |
| Blueprint / Drafting Table | `blueprint` | Visual + literal cube↔isometric-drawing mapping | Re-theme → Reinvention (redline layer) | Medium |
| Mondrian (De Stijl) | `mondrian` | Conceptual: a grid filling with flat primary planes *is* a Neoplastic composition (Broadway Boogie Woogie) | Re-theme | Medium |
| Grid / Lightwall *(flagship, fully specced below)* | `grid` | Conceptual: the game *is* a lightcycle grid; clears = derez | Reinvention | Large |

---

# Part A — Stained Glass / "Rose Window" (`glass`)

**Material world (one sentence).** A backlit Gothic cathedral rose window made of leaded
jewel glass, where filled cells are colored panes that light up and the rosette boundaries
are the black lead came.

**Why the core is unassailable.** The board is *already* a "flower of flowers" — one
central rosette ringed by six petal rosettes. That is the geometry of a rose window. The
theme reveals the board's own shape rather than decorating it. (Distinguish this clearly
from Mondrian below: this is **Gothic cathedral** — figurative, jewel-toned, radial,
backlit, ornate. Mondrian is **De Stijl** — flat planes of primary color on a high-key
white field, ruled by a heavy black grid; hard-edged and painterly, not architectural.)

**Transformation axes moved:** palette, cube render mode (translucent emissive), empty-cell
treatment, rosette framing, board/background, motion character (light flares), tier
expression, plus an optional backlight runtime → **Reinvention**.

### Tokens

```css
:root[data-theme="glass"] {
  --glass-came: #0a0a0c;          /* lead came / structural lines */
  --glass-backlight: #fff4d6;     /* warm light behind the window */
  --glass-stone: #2b2622;         /* surrounding stone/chrome */
  --glass-cobalt: #1b3a8f;
  --glass-emerald: #1f7a4d;
  --glass-gold:   #e0a92e;
  --glass-amethyst: #6a2c8f;
  --glass-ruby:   #9e1b32;        /* the central rose jewel / ruby cube */

  /* Shared cube tokens repainted as translucent jewel glass. Resting
     (tier 0) palette = the window's "default" leading. */
  --cube-top:   #6fa8ff;          /* lightest pane (cobalt lit) */
  --cube-left:  #2f6fd6;
  --cube-right: #16307a;
  --cube-stroke: var(--glass-came);
  --score-tier-accent: var(--glass-gold);
  --cube-inverse-bright: #ffe9a6;
  --cube-inverse-dim: #7a5a1a;
}
```

### Render & surfaces

- **Cube:** keep the isometric faces but render them **translucent** (reuse the Audius
  `fill-opacity` + backlit-glow technique). A `::before`/board-layer warm radial
  `--glass-backlight` glows *through* filled glass. Faces get a thin bright inner edge to
  read as beveled glass. Filled cells should glow brighter than empty.
- **Empty cells:** dark leaded voids — `--glass-came` socket with a faint inner shadow (a
  pane not yet "glazed").
- **Rosette framing:** `.hexaclear-flower-groove*` / `.hexaclear-flower-boundary*` → thick
  **opaque** black came (keep these high-contrast; they carry legibility while panes are
  translucent).
- **Ruby:** the central rose jewel — `--glass-ruby` glass with the strongest backlight and
  a faceted highlight. Keep it red across tiers (meaningful marker).
- **Board panel:** a stone cathedral frame (`--glass-stone`) around the lit window;
  `overflow: hidden` for the rounded window → **pin `.hexaclear-overlay` to `position:
  fixed; inset: 0`** so modals don't get clipped (the Audius fix).
- **Score readout:** an engraved brass plaque or illuminated-manuscript numerals; update
  `getScoreCounterEl()` if it isn't `.hexaclear-live-stat .value`.

### Tier / octave expression

- `paletteForTier(... 'glass')` rotates the golden-angle hue but **clamps to saturated
  jewel tones** (high saturation, mid lightness so panes stay rich, never pastel).
- Octaves raise **backlight intensity** and add a slow "sun crossing the window" sweep
  (a translucent gradient drifting across the board — GPU-composited transform/opacity).
- Clears = a **light flare**: re-skin the clear so the cleared line/rosette blooms white
  light through the came before the panes go dark. Keep the 220ms/40ms-stagger,
  260ms-center, 190ms-ring timings exactly.

### Reduced-motion & risk

- Reduced-motion: freeze the sun-sweep and flare; keep static backlight.
- **Risk — legibility.** Translucent panes over a glow can wash out filled-vs-empty and
  preview states on mobile. Mitigations: opaque came, a minimum pane opacity floor, and a
  crisp white preview-valid stroke (as Audius does).

### Build order

1. Tokens + translucent cube faces + backlight layer. 2. Came on grooves/boundary +
empty sockets. 3. Clear-as-light-flare re-skin. 4. Full modal/menu/leaderboard/MP reskin
to stone+glass. 5. `paletteForTier` branch + octave backlight ramp. 6. Reduced-motion +
mobile legibility pass.

---

# Part B — Blueprint / "Drafting Table" (`blueprint`)

**Material world.** A technical engineering drawing on blueprint paper: cubes are white/cyan
line-art isometric figures with dimension ticks, on a construction grid, with a corner
title block.

**Why the core is unassailable.** An isometric cube *is* an isometric orthographic
projection — the game's core art primitive is already a drafting primitive. The theme
admits what the cube has always been.

**Transformation axes moved:** palette, cube render mode (line-art/wireframe), empty-cell
(construction grid), rosette (dimensioned callout), chrome (title block), typography
(drafting/mono), tier expression (**redline accumulation**) → **Re-theme leaning
Reinvention**.

### Tokens

```css
:root[data-theme="blueprint"] {
  --bp-paper:   #0b3d91;   /* blueprint blue */
  --bp-paper-2: #0d326f;   /* darker plate for panels */
  --bp-line:    #d7e6ff;   /* primary draftsman line (near-white cyan) */
  --bp-grid:    #3a63b5;   /* faint construction grid */
  --bp-dim:     #ffce5a;   /* dimension lines / amber annotations */
  --bp-redline: #ff3b30;   /* revision markups */

  /* Cubes are line art: faces near-transparent, edges = --bp-line.
     The fill tokens are kept very low-alpha so a tier change still
     tints the faint wash inside the wireframe. */
  --cube-top:   rgba(215,230,255,0.10);
  --cube-left:  rgba(215,230,255,0.06);
  --cube-right: rgba(215,230,255,0.03);
  --cube-stroke: var(--bp-line);
  --score-tier-accent: var(--bp-dim);
  --cube-inverse-bright: #ffe08a;
  --cube-inverse-dim: #b07d12;
}
```

### Render & surfaces

- **Cube:** wireframe/line isometric — near-transparent faces, thin **emissive-cool**
  edge strokes (`--bp-line`), with tiny dimension ticks on edges. Enforce a **minimum
  stroke weight** so cubes stay legible at mobile cell sizes (the chief risk for line art).
- **Empty cells:** faint dotted/dashed **construction grid** (`--bp-grid`), like a drawing
  sheet awaiting linework.
- **Rosette framing:** groove → a **dimensioned boundary** with leader lines and a callout
  bubble (reuse the groove polylines, restyle as thin amber dimension lines).
- **Ruby:** a flagged "critical component" — `--bp-redline` callout with a leader.
- **Chrome:** a drafting **title block** in a corner of the board panel holding score/best
  (`SCALE · SHEET · SCORE`); border the board like a drawing frame with a thin double rule.
- **Score readout:** title-block field; update `getScoreCounterEl()` accordingly.
- **Type:** a monospaced/technical face; uppercase labels, tight tracking.

### Tier / octave expression (the clever part)

- `paletteForTier(... 'blueprint')` keeps cube linework cool, but **escalation accumulates
  redline markups**: higher tiers add revision clouds and red correction strokes over the
  board background (a CSS layer keyed off `data-score-octave`). So the tier engine reads as
  a drawing being progressively revised — narrative escalation, not just hue.
- Octave layers: 1 → faint title-block "REV A" stamp; 2 → grid densifies; 3 → amber
  dimension annotations appear; 4 → red revision clouds; 5 → "FOR CONSTRUCTION" diagonal
  stamp drifts across the sheet.

### Reduced-motion & risk

- Reduced-motion: redline clouds appear statically (no drifting stamp).
- **Risk — thin linework legibility.** Minimum stroke weight + a faint fill wash behind
  the wireframe + a high-contrast solid preview-valid edge.

### Build order

1. Paper + grid background + line-art cube. 2. Dimensioned grooves + redline ruby. 3.
Title-block chrome + score relocation. 4. Full modal reskin as drawing callouts/plates.
5. `paletteForTier` + redline octave layers. 6. Legibility + reduced-motion pass.

---

# Part C — Mondrian / "De Stijl Grid" (`mondrian`)

**Material world.** A De Stijl / Neoplastic composition: a warm-white canvas partitioned by
heavy black orthogonal lines, with cells filled by flat planes of pure primary red, blue,
and yellow. Filled cells are saturated primary blocks; the black lines are the structural
leading; most of the board breathes as open white space.

**Why the core is unassailable (and distinct from `glass` / `blueprint`).** The game *is* a
grid of cells that fill with color and resolve into completed lines — which is exactly what a
Mondrian is: an asymmetric grid of black lines partitioning a white field with sparing blocks
of pure primary color. *Broadway Boogie Woogie* reads almost literally as a grid puzzle board
— colored squares marching along yellow tracks in syncopated rhythm — so the mapping is
concept-level, not a costume. The board's hex/rosette geometry isn't orthogonal, so the anchor
is Mondrian's *language* — flat primary planes bounded by heavy black — rather than his literal
rectangle grid; cells become flat color planes and the grooves/boundary become the thick
structural bars. That is categorically different from Part A's Gothic cathedral (figurative,
jewel-saturated, radial, backlit) and from Part B's monochrome cyan line-art on blueprint blue
(technical, diagrammatic): Mondrian is high-key **white** ground, only three primaries plus
black, flat hard-edged painted planes, asymmetric balance.

**Transformation axes moved:** palette (white + three primaries + black), cube render (flat
De Stijl color planes), empty-cell (open white canvas), rosette (heavy black structural bars /
Boogie-Woogie tracks), chrome (asymmetric black rules + primary accent blocks), typography
(geometric grotesque), board framing (white canvas in a black frame) → **Re-theme** (an
optional Boogie-Woogie reactive layer pushes it toward Reinvention).

### Tokens

```css
:root[data-theme="mondrian"] {
  --md-ground:    #f4f1e8;   /* warm-white canvas / unpainted field */
  --md-ground-2:  #eae6da;   /* faintly darker plate for panels */
  --md-line:      #141210;   /* the black grid line / leading */
  --md-line-hi:   #000000;   /* heaviest structural bars */
  --md-red:       #c8252b;   /* primary red */
  --md-blue:      #1d3a8f;   /* primary blue (cobalt/ultramarine) */
  --md-yellow:    #f3c20b;   /* primary yellow (chrome yellow) */
  --md-grey:      #c9c5ba;   /* the occasional neutral plane */

  /* Cubes = flat De Stijl color planes bounded by heavy black. Faces
     carry near-flat value (the black edges do the structural work, not
     shading) so the isometric block reads as a painted plane. Resting
     (tier 0) palette = a red block. */
  --cube-top:   #d6342f;
  --cube-left:  #b62027;
  --cube-right: #8f181d;
  --cube-stroke: var(--md-line);
  --score-tier-accent: var(--md-yellow);
  --cube-inverse-bright: #ffffff;   /* about-to-clear = drains to white */
  --cube-inverse-dim: var(--md-grey);
}
```

### Render & surfaces

- **Cube:** keep the isometric faces but paint them as **flat primary planes** — minimal
  value difference between faces, **heavy opaque black** edge strokes (`--md-line`), and *no*
  gloss, gradient, or bevel (Neoplasticism is anti-illusionistic). The fill rotates through
  the three primaries per filled cell, with some cells left grey/neutral for authentic
  sparseness. The black edge is the star: thick, matte, structural.
- **Empty cells:** the open warm-white canvas (`--md-ground`) with only a thin black hairline
  grid — the unpainted field awaiting a block.
- **Rosette framing:** groove/boundary → the **heavy black structural bars** that anchor a
  Mondrian composition (reuse the groove polylines, restyle as thick `--md-line-hi` bars, some
  doubled). Optionally drop a small primary accent square at the bar intersections (the
  Boogie-Woogie node cue).
- **Ruby:** the single fixed **red** plane — Mondrian's boldest primary is already a natural
  "ruby"; keep it red across tiers.
- **Board panel:** a white canvas inside a black frame (a framed Mondrian); compose the chrome
  with **asymmetric balance** — unequal corner blocks, no centered symmetry. Use `overflow:
  hidden` for the framed canvas → **pin `.hexaclear-overlay` to `position: fixed; inset: 0`**
  so modals don't get clipped (the Audius fix).
- **Type:** a geometric grotesque (squared, even-weight); uppercase labels with thin black
  rules separating sections.

### Tier / octave expression (the clever part)

- `paletteForTier(... 'mondrian')` does **not** sweep the continuous golden-angle hue —
  Mondrian's whole discipline is *only* three primaries. So **quantize** the tier hue to the
  nearest of {red, blue, yellow} (snap to a primary), and let escalation read as **more of the
  composition gaining color** rather than a hue drift. Higher tiers = a busier, denser, more
  syncopated canvas (early sparse Mondrian → late *Broadway Boogie Woogie*).
- Octave layers = the composition resolving: 1 → the first primary blocks appear among the
  white; 2 → the black grid thickens / doubles its key bars; 3 → more cells take color and the
  asymmetric balance tightens; 4 → the third primary enters so all of red/blue/yellow are
  present (suppress the engine's default per-face hue spread — keep planes flat); 5 →
  **Broadway Boogie Woogie**: small colored squares travel the black/yellow tracks in
  syncopated rhythm (GPU-composited transform/opacity; reduced-motion disables).
- Clears = a line **resolving**: re-skin the clear so the completed line/rosette snaps to a
  single pure primary, then drains to clean white. Keep the 220ms/40ms-stagger, 260ms-center,
  190ms-ring timings exactly.

### Reduced-motion & risk

- Reduced-motion: no traveling Boogie-Woogie squares; the canvas is static.
- **Risk — high-key white glare + flat-vs-flat legibility.** A bright-white ground can glare on
  OLED/mobile, and Mondrian's authentic sparseness can make filled-vs-empty subtle. Mitigations:
  heavy black edges on filled planes, a min-saturation floor on the primaries, keep the empty
  field a hair off-white (`--md-ground`) against brighter filled planes, and a crisp black
  preview-valid stroke.
- **Risk — reads "too close to Blueprint" (both grid-forward).** Lean on what Blueprint is
  *not*: full primary **color** vs monochrome cyan, **white** ground vs blueprint blue, and flat
  painted **planes** vs thin line-art wireframe. The silhouette must read as filled color blocks,
  never as drawn outlines.

### Build order

1. Tokens + flat primary cube faces + heavy black edges. 2. White canvas field + hairline-grid
empties + heavy black structural bars on grooves/boundary. 3. Red "ruby" plane + primary accent
nodes at intersections. 4. Full modal reskin (white canvas, black rules, asymmetric primary
blocks, geometric type). 5. `paletteForTier` primary-quantize + octave density ramp (optional
Boogie-Woogie octave-5 layer). 6. Glare/contrast + reduced-motion pass + the **differentiation
pass vs Blueprint**.

---

# Part D — FLAGSHIP DEEP DIVE: Grid / "Lightwall" (`grid`)
### (the TRON-lightcycle-game theme)

This is the requested flagship. It is developed to full implementation depth because its
core concept is the strongest of the set: **the game already plays like a lightcycle
arena.** You lay down solid trails of light into a grid; lines and rosettes "derez" when
completed; everything is built of cubes — and *derez* in this universe is literally objects
shattering into glowing voxels. The theme doesn't dress up the game; it names what the game
mechanically already is.

> **Name/legal:** ship as **"Grid"** or **"Lightwall."** Do **not** use "TRON,"
> "lightcycle," "identity disc," or Disney logos in store/app copy. The aesthetic is fair
> game; the marks are not.

## D.1 Concept & why it's unassailable

- **Placing a piece = laying a light-wall segment** (the trail a lightcycle leaves).
- **Clearing a line/rosette = a derez** — the completed structure flashes white and
  shatters into light particles. The engine is *made of cubes*, so the canonical TRON derez
  (voxelized dissolve) is a perfect, native fit for the clear animation.
- **Multiplayer is two light-teams.** TRON's entire color language is a duel of two glowing
  teams (cyan vs orange). The game already has **PvP partner tinting** — so PvP maps onto
  cyan-vs-orange light teams with almost no conceptual stretch.
- **Score climbing = the Grid powering up.** Tier/octave escalation reads as more circuitry
  lighting, brighter walls, the arena coming online.

**Transformation axes moved:** palette, cube render (emissive light-wall voxel), empty-cell
(dark circuit socket), rosette (circuit-trace ring), board (the Game Grid void), chrome
(vector HUD), typography (segmented/vector), motion (rez-in / derez), tier expression
(power-up), PvP color language (light-teams), runtime (reactive grid glow) →
**Reinvention.**

## D.2 Material world

A pitch-black voxel arena floored with a faint perspective grid, lit only by glowing light
walls. Filled cubes are **emissive blocks of light** (a near-transparent dark face with a
hot glowing edge and an inner bloom), not lit-from-outside solids. The whole arena hums
with a slow circuit pulse and snaps to attention on clears.

## D.3 Tokens

```css
:root[data-theme="grid"] {
  --grid-void:    #02040a;     /* the arena floor / deep background */
  --grid-void-2:  #050b16;     /* panel plates */
  --grid-floor-line: #0e2230;  /* faint perspective floor grid */
  --grid-cyan:    #00e5ff;     /* player light-team (primary) */
  --grid-cyan-hi: #aef7ff;     /* hot core / rez highlight */
  --grid-orange:  #ff7a18;     /* opposing light-team / hazard */
  --grid-orange-hi: #ffd24a;
  --grid-white:   #d7faff;     /* derez flash / disc */

  /* Reactive scalars written from JS each frame (see D.8). Default 0
     so the resting arena is calm. */
  --grid-pulse: 0;             /* 0..1 ambient circuit breath */
  --grid-charge: 0;            /* 0..1 rises with score tier */

  /* Cubes = emissive light walls. Faces are dark + low alpha; the
     glow lives in the edge stroke + a board-level bloom layer, so a
     tier change recolors the light, not a solid fill. */
  --cube-top:   rgba(0,229,255,0.16);
  --cube-left:  rgba(0,229,255,0.10);
  --cube-right: rgba(0,229,255,0.05);
  --cube-stroke: var(--grid-cyan);
  --score-tier-accent: var(--grid-cyan);
  --cube-inverse-bright: var(--grid-orange);   /* about-to-derez = opposing color */
  --cube-inverse-dim: #8a3a06;
}
```

Design intent: **light lives in strokes and bloom layers, not fills.** This keeps the
arena dark and makes recoloring (tiers, light-teams) a stroke/glow change.

## D.4 Cube render — the light wall

- Faces near-transparent dark; the **edge stroke is the hot light** (`--cube-stroke`), with
  a tight inner bloom. Reuse the Audius lesson: a **single composited filter / bloom layer
  over the static cube subtree**, not per-cube glow repaints.
- Filled cube = a fully-lit wall segment. Adjacent filled cells should read as a continuous
  light wall (edges align), so a placed piece looks like one ribbon of light, not separate
  cubes. (The board already shares strokes between adjacent cells — lean into it.)
- **iOS/WebKit caveat:** CSS `filter` shorthands are ignored on inner SVG `<g>`. For any
  per-cell glow/invert (e.g. the about-to-derez highlight), reference a real
  `<filter id="grid-derez-glow">` in the board `<defs>` and use `filter: url(#…)` (exactly
  how Audius solved its clear-invert).

## D.5 Surfaces

- **Empty cells:** dark circuit sockets — `--grid-void` with a faint `--grid-cyan` hairline;
  on hover/preview the hairline **intensifies and pulses** (a circuit energizing).
- **Rosette framing:** groove/boundary → a **circuit-trace ring** (the groove polylines
  restyled as a glowing PCB trace with little nodes at the vertices). When a rosette is
  full, the trace lights solid just before derez.
- **Ruby → "power node" / disc:** a white-cyan glowing disc (evoking the identity disc
  without naming it). Keep it distinct from team colors; it's the high-value collectible.
- **Board panel = the Game Grid:** `--grid-void` with a faint perspective **floor grid**
  (`--grid-floor-line`) receding toward a horizon line; a slow ambient pulse driven by
  `--grid-pulse`. Use `overflow: hidden` + **fixed-position `.hexaclear-overlay`** so modals
  aren't clipped.
- **Chrome / HUD:** a vector readout — thin glowing rules, segmented numerals, uppercase
  tracking. Score relocated to a HUD bar; update `getScoreCounterEl()` to its node.
- **Hand & hold:** pieces render as light-wall segments in dark sockets; the hold pocket is
  a "garage" socket. Unplayable pieces dim to a dead/grey circuit.

## D.6 Signature animations (re-skin only — timings are FIXED)

Keep every duration/stagger from the engine (line clear 220ms + 40ms/step stagger; flower
center 260ms; ring +190ms; invalid flash 520ms) so audio + haptics stay locked. Re-skin:

- **Place = "rez-in":** the new piece's cubes flash white-cyan and snap to their lit state
  (a quick materialization). Use the existing placement hook; just recolor/scale.
- **Clear = "derez":** re-skin `clearing` / `clearing-line-step-N` /
  `clearing-flower-center` / `clearing-flower-ring`. The completed structure flashes
  `--grid-white`, then the cubes **shatter/dissolve into glowing voxels** as they fade
  (voxel particles are on-brand and the board is literally cubes). The about-to-derez
  preview-clear cells glow in the **opposing team color** (`--cube-inverse-bright` =
  orange) so the doomed cluster reads as "marked."
- **Invalid drop:** an orange "wall rejected" buzz flash (reuse the 520ms 2-pulse rhythm).
- **Ripple:** re-skin `.hexaclear-board-ripple-overlay` as an expanding **light pulse ring**
  across the floor grid (bright on clears, soft on plain placements).

## D.7 PvP — the two light-teams (high-value, low-cost)

The PvP partner-tint system already exists (`tintCubeColor`, `WOOD_CUBE_*` / `W98_*`
constants in `App.tsx` ~606, branched in the render code). Add a `grid` branch:

- **Self = cyan team, partner(s) = orange/other hues.** Add `GRID_SELF_STROKE = #00e5ff`
  and a partner base (e.g. `#ff7a18`); compute additional partners by hue-rotating in JS
  (the existing `tintCubeColor` path), assigning each a distinct glowing hue.
- **Territory tints / conflict ring** (`.pvp-tinted-self/partner`,
  `.hexaclear-hex-conflict-ring`): render as **colored light borders** on owned sockets and
  a chunky glowing conflict frame — the same idiom Win98 uses, recolored to neon.
- This turns TRON's core fiction (a two-team light duel) into a near-free PvP win.

## D.8 Tier / octave — "the Grid powers up" + the reactive runtime

- `paletteForTier(... 'grid')`: rotate the golden-angle hue but **bias toward the
  cyan↔magenta↔orange electric poles** (high saturation, high lightness on the stroke; keep
  fills near-transparent). The accent and `--cube-stroke` carry the tier color; the
  inverse/derez color stays the hot opposing pole.
- **Octave layers** = the arena coming online:
  - octave-1: floor grid brightens + ambient pulse begins.
  - octave-2: empty-socket hairlines energize.
  - octave-3: cube edge bloom intensifies.
  - octave-4: per-face hue spread (engine default) → light walls gain a subtle chromatic
    edge.
  - octave-5: scanlines + a denser circuit pattern drift across the floor.
- **Optional reactive runtime (pushes this to flagship Reinvention).** A tiny `rAF` loop
  writes `--grid-pulse` (a slow sine "circuit breath") and ramps `--grid-charge` from the
  score tier, so the whole arena visibly intensifies as you climb — **no analyser, no audio
  dependency.** Follow the Audius performance rules exactly:
  - one composited bloom/filter layer over the static cube subtree (no per-cube repaint),
  - drive everything through CSS custom properties on `.cubic-viewport` / root,
  - cap the loop (~30fps), and **fully neutralize under `.reduced-motion`** (`--grid-pulse:
    0`, no scanline drift, static charge).

## D.9 Reduced-motion

- No circuit breath, no scanline drift, no rez/derez particle motion. Cubes render as
  static lit walls; clears do a single-frame color drain (mirroring how Win98 keeps its
  clears legible without motion).

## D.10 Risks

1. **Pure-black contrast / OLED legibility:** ensure preview-valid uses a solid bright
   stroke and that empty vs filled is obvious without relying on bloom. Provide a minimum
   stroke contrast even on the dimmest sockets.
2. **Glow performance on mobile:** absolutely no per-cube box-shadow/drop-shadow in the hot
   path. One bloom layer, GPU-composited. Profile on a phone.
3. **"Too close to Audius?"** Both are dark + emissive. They diverge on concept (a *grid
   duel reacting to play* vs a *glass instrument reacting to music*), palette (electric
   cyan/orange vs cyan/teal/amber glass), and material (hard vector light walls vs soft
   glass deck). Keep the floor-grid perspective, light-team duel, and derez-shatter front
   and center so the difference is unmistakable.
4. **Legal:** original naming only (see top).

## D.11 Build order

1. Arena: `--grid-void` board + perspective floor grid + dark sockets.
2. Light-wall cube (transparent faces + hot edge stroke + one bloom layer; iOS `url(#…)`
   filter for per-cell highlight).
3. Circuit-trace rosette ring + power-node ruby.
4. Rez-in (place) + derez-shatter (clear) re-skins on the **fixed engine timings**;
   ripple → light pulse.
5. Full HUD + every modal/menu/leaderboard/stats/gameover/MP surface reskinned to vector
   neon (the bulk of the work — see guide §4).
6. PvP light-teams branch (`tintCubeColor` + territory/conflict tints).
7. `paletteForTier('grid')` electric-pole band + octave power-up layers.
8. Reactive `--grid-pulse`/`--grid-charge` runtime (GPU-cheap) + **reduced-motion
   neutralizer**.
9. Mobile perf + black-contrast legibility pass + the screenshot test vs Wood **and** vs
   Audius.

---

## Appendix — shared checklist (applies to all four)

For each theme, before "done," verify against the guide:

- [ ] `ThemeId` + `THEME_OPTIONS` entry; scoped CSS file `@import`ed; favicon swap branch.
- [ ] `:root[data-theme]` tokens override `--cube-*` and define a private namespace.
- [ ] Board, hand, hold, HUD all on-theme (guide §4).
- [ ] **Every** overlay re-skinned: menu, settings, scores, stats, scoring, history,
      gameover (+ highlight reel), account, audio-unlock, all inputs/sliders/checkboxes.
- [ ] Multiplayer: smiley/emote, co-op, PvP tracks/standings, spectator, territory tints.
- [ ] `paletteForTier(theme)` branch; octave layers re-expressed.
- [ ] `getScoreCounterEl()` updated if the score readout moved.
- [ ] No `!important` on animated cell `fill`/`stroke`/`stroke-width` (guide §8).
- [ ] Reactive motion GPU-composited + reduced-motion neutralized; mobile profiled.
- [ ] `overflow:hidden` board → `.hexaclear-overlay` pinned `fixed` if modals clip.
- [ ] Passes the screenshot test vs Wood (and vs Audius for the dark themes).
