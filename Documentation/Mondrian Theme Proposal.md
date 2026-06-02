# Mondrian — "De Stijl Grid" Theme Proposal (`mondrian`)

> **Status:** Approved concept, detailed for build. **Departure tier:** Re-theme.
> **Companion docs:** `Cubekill Theme Authoring Guide.md` (the technical contract + surface
> inventory + hard constraints) and `Cubekill Theme Concepts.md` (Part C, the source concept).
> This document is the build-ready expansion of that concept.
>
> **Scope decision:** the optional animated *Broadway Boogie Woogie* runtime (traveling
> squares at high octaves) is **deliberately cut** — too much work for a state most players
> never reach. Escalation is expressed as a **static density ramp** instead. This keeps the
> theme a clean **Re-theme** with no per-frame runtime system.

---

## 1. Material world (the one sentence)

A De Stijl / Neoplastic painting that plays itself — a **warm-white canvas partitioned by
heavy black orthogonal bars, filled by flat planes of pure primary red, blue, and yellow.**
Filled cells are saturated primary blocks; the rosette leading is the structural black; most
of the board breathes as open white space.

## 2. Why the core is unassailable

The game **is** a grid of cells that fill with color and resolve into completed lines — which
is exactly what a Mondrian is: an asymmetric grid of black lines partitioning a white field
with sparing blocks of pure primary color. A puzzle board filling with colored blocks bounded
by heavy black **is** the Neoplastic composition, so the mapping is **concept-level, not a
costume.**

The board's hex/rosette geometry isn't orthogonal, so the anchor is Mondrian's **language**
(flat primary planes bounded by heavy black), not his literal rectangle grid. This is
categorically different from:

- **Stained Glass** (`glass`) — figurative, jewel-saturated, radial, backlit, ornate.
- **Blueprint** (`blueprint`) — monochrome cyan line-art on blueprint blue, technical and
  diagrammatic.

Mondrian is high-key **white** ground, **only** three primaries plus black, flat hard-edged
painted planes, asymmetric balance.

### Naming & trademark (read before shipping)

Mondrian's paintings are public domain in most jurisdictions and the De Stijl / Neoplastic
visual language is a *style*, not something anyone owns. Even so:

- Ship under an **original descriptive name** — e.g. **"De Stijl"** or **"Neoplastic."**
- Keep the **artist's name out** of the store listing and in-app copy.
- **Do not reproduce a specific named painting 1:1.**
- The code `ThemeId` token stays English-ASCII: **`mondrian`**.

## 3. Transformation axes moved

| Axis | Mondrian move |
|---|---|
| Palette & mood | White + three primaries + black only |
| Cube render mode | Flat De Stijl color planes (anti-illusionistic) |
| Empty-cell treatment | Open warm-white canvas, hairline grid |
| Rosette framing | Heavy black structural bars / Boogie-Woogie tracks |
| Chrome & layout | Asymmetric black rules + primary accent blocks |
| Typography | Geometric grotesque (squared, even-weight) |
| Board panel / background | White canvas inside a black frame |
| Tier / octave expression | Hue **quantized** to nearest primary (no continuous sweep) |

Eight axes — clears the **Re-theme** bar comfortably. No per-frame runtime system; escalation
is a static density ramp (§6).

## 4. Strict palette (tokens)

```css
:root[data-theme="mondrian"] {
  --md-ground:    #f4f1e8;   /* warm-white canvas / unpainted field */
  --md-ground-2:  #eae6da;   /* faintly darker plate for panels */
  --md-line:      #141210;   /* the black grid line / leading / cube edges */
  --md-line-hi:   #000000;   /* heaviest structural bars */
  --md-red:       #c8252b;   /* primary red */
  --md-blue:      #1d3a8f;   /* primary blue (cobalt/ultramarine) */
  --md-yellow:    #f3c20b;   /* primary yellow (chrome yellow) */
  --md-grey:      #c9c5ba;   /* the occasional neutral plane */

  /* Cubes = flat De Stijl color planes bounded by heavy black. Faces carry
     near-flat value (the black edges do the structural work, not shading)
     so the isometric block reads as a painted plane. Resting (tier 0)
     palette = a red block. */
  --cube-top:    #d6342f;
  --cube-left:   #b62027;
  --cube-right:  #8f181d;
  --cube-stroke: var(--md-line);
  --score-tier-accent:    var(--md-yellow);
  --cube-inverse-bright:  #ffffff;          /* about-to-clear = drains to white */
  --cube-inverse-dim:     var(--md-grey);
}
```

**Discipline is the identity:** three primaries + black + warm white, nothing else. The
neutral grey appears sparingly for authentic De Stijl sparseness.

## 5. Render & surfaces

- **Cube — flat painted plane.** Keep the isometric faces but paint them as **flat primary
  planes**: minimal value difference between faces, **heavy opaque black** edge strokes
  (`--md-line`), and *no* gloss, gradient, or bevel (Neoplasticism is anti-illusionistic).
  The fill rotates through the three primaries per filled cell, with some cells left
  grey/neutral for authentic sparseness. The thick, matte, structural black edge is the star.
- **Empty cell — unpainted canvas.** The open warm-white field (`--md-ground`) with only a
  thin black hairline grid — a cell awaiting a block. Keep it a hair off-white against
  brighter filled planes so filled-vs-empty stays obvious.
- **Rosette framing — structural bars.** Reuse the `.hexaclear-flower-groove*` /
  `.hexaclear-flower-boundary*` polylines, restyled as thick `--md-line-hi` bars (some
  doubled) — the heavy black that anchors a Mondrian composition. Optionally drop a small
  primary accent square at the bar intersections (a De Stijl node accent).
- **Ruby — the fixed red plane.** Mondrian's boldest primary is already a natural "ruby." Keep
  the center jewel **red across all tiers** as a meaningful marker — a single pure `--md-red`
  plane.
- **Board panel — framed canvas.** A white canvas inside a black frame (a framed Mondrian).
  Compose the chrome with **asymmetric balance** — unequal corner blocks, no centered
  symmetry. With `overflow: hidden` for the framed canvas, **pin `.hexaclear-overlay` to
  `position: fixed; inset: 0`** so modals don't clip (the Audius fix).
- **Typography — geometric grotesque.** A squared, even-weight geometric grotesque; uppercase
  labels with thin black rules separating sections. Score readout becomes a primary-block
  plaque — update `getScoreCounterEl()` if it moves off `.hexaclear-live-stat .value`.

## 6. Tier & octave — the composition resolving

Mondrian's whole discipline is **only** three primaries, so **do not** sweep the continuous
golden-angle hue. Instead **quantize** the tier hue to the nearest of red / blue / yellow and
let escalation read as *more of the composition gaining color* — a fresh board looks like a
sparse early Mondrian and grows denser/busier as you climb. This is a **static density ramp:
each octave is a fixed CSS layer that turns on at its threshold** — no traveling pieces, no
per-frame loop.

| Octave | The canvas at this stage |
|---|---|
| 1 | The first primary blocks appear among the white. |
| 2 | The black grid thickens / doubles its key bars. |
| 3 | More cells take color; the asymmetric balance tightens. |
| 4 | The third primary enters — all of red/blue/yellow present (suppress the engine's default per-face hue spread; keep planes flat). |
| 5 | The busiest static state — a denser low-contrast block pattern washes the background (the existing octave-5 hex-pattern layer, recolored). Still no motion. |

**Clears = a line resolving.** Re-skin the clear so the completed line/rosette snaps to a
single pure primary, then drains to clean white. Keep the **exact** engine timings — 220ms
line + 40ms/step stagger, 260ms flower center, +190ms ring.

### `paletteForTier` branch — snap to a primary

```ts
if (theme === 'mondrian') {
  // Quantize the golden-angle hue to the nearest De Stijl primary instead
  // of letting it drift continuously through the wheel.
  const PRIMARIES = [
    { h: 0,   top: '#d6342f', left: '#b62027', right: '#8f181d' }, // red
    { h: 222, top: '#2f55c4', left: '#1d3a8f', right: '#142a6b' }, // blue
    { h: 48,  top: '#ffd21f', left: '#f3c20b', right: '#caa006' }, // yellow
  ]
  const nearest = PRIMARIES.reduce((a, b) =>
    hueDist(baseHue, b.h) < hueDist(baseHue, a.h) ? b : a)
  return {
    '--cube-top': nearest.top,
    '--cube-left': nearest.left,
    '--cube-right': nearest.right,
    '--score-tier-accent': 'var(--md-yellow)',
    '--cube-inverse-bright': '#ffffff', // about-to-clear drains to white
    '--cube-inverse-dim': 'var(--md-grey)',
  } as React.CSSProperties
}
```

Tier 0 must still return `{}` so fresh runs / daily mode fall through to the `:root` resting
look (a red block).

## 7. Multiplayer — primaries as teams

The PvP partner-tint system already exists (`tintCubeColor`, the `WOOD_CUBE_*` / `W98_*`
constants in `App.tsx`). Add a `mondrian` branch that assigns each player a fixed primary:
self = blue, partner = red, additional partners = yellow then grey. Territory tints
(`.pvp-tinted-self/partner`) and the conflict ring (`.hexaclear-hex-conflict-ring`) render as
flat primary planes with a heavy black border — the same idiom Win98 uses, repainted to De
Stijl. Because the primaries are the whole language, two-team play is nearly free and reads
instantly.

## 8. Risks & mitigations

- **White glare on OLED/mobile.** A bright-white ground can glare. Keep the empty field a hair
  off-white (`--md-ground`), not pure `#fff`, and lean on a min-saturation floor for the
  primaries so contrast holds.
- **Flat-vs-flat legibility.** Authentic sparseness can make filled-vs-empty subtle. Mitigate
  with heavy black edges on filled planes and a crisp black preview-valid stroke so the
  to-be-cleared state still reads.
- **Reads too close to Blueprint** (both grid-forward). Differentiate hard: full primary
  **color** vs monochrome cyan, **white** ground vs blueprint blue, flat painted **planes** vs
  thin line-art wireframe. The silhouette must read as filled color blocks, never drawn
  outlines.
- **Reduced-motion.** The theme is already static (no runtime layer), so there's little to
  disable; the clear becomes a single-frame color drain to white (mirroring how Win98 keeps
  clears legible without motion). **No `!important`** on animated cell `fill`/`stroke` — it
  would silently kill the clear keyframes (Authoring Guide §8).

## 9. Build order

1. Tokens + flat primary cube faces + heavy black edges.
2. White canvas field + hairline-grid empties + heavy black structural bars on
   grooves/boundary.
3. Red "ruby" plane + primary accent nodes at bar intersections.
4. Full modal reskin: white canvas, black rules, asymmetric primary blocks, geometric type
   (the bulk of the work — **every** overlay; see Authoring Guide §4 surface inventory).
5. `paletteForTier` primary-quantize + static octave density ramp (reuse existing octave CSS
   layers, recolored — no new runtime).
6. Glare/contrast + reduced-motion pass + the **differentiation pass vs Blueprint** + the
   screenshot test vs Wood.

## 10. Open decisions

- **Typeface.** Needs a squared, even-weight geometric grotesque. Pick a face already
  available to the project (or self-host one) before step 4.

---

*Honors the theme contract: scoped `[data-theme="mondrian"]` CSS, `hexaclear-*` classes,
untouched game logic and animation timings, re-expressed tier engine, full surface coverage.*
