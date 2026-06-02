# Cubekill Theme Authoring Guide

> **Audience:** an LLM (or human) designing and building new visual themes for Cubekill.
> **Goal:** every new theme must be a *significant departure* from the base ("Wood")
> theme — a distinct, complete, premium product worth paying for — not a recolor.
>
> This guide is the authority on (1) what "significant departure" means and how it is
> measured, (2) the technical contract a theme must satisfy, (3) the full inventory of
> surfaces a theme must cover, (4) a deconstruction of the three shipped themes as
> reference cases, and (5) the hard constraints that must never be broken.

Code names in this repo are English-ASCII tokens. The three shipped themes are:

| Product name | Code `ThemeId` | Files |
|---|---|---|
| **Cubekill (default)** — "Wood" / base | `wood` | `client/src/index.css` (no `data-theme` needed), `App.tsx` wood branches |
| **Windows 98** | `win98` | `client/src/theme-win98.css`, `App.tsx` Win98 titlebar/LCD JSX |
| **Music Visualizer** | `audius` | `client/src/theme-audius.css`, `App.tsx` deck JSX + analyser loop |

Note: the legacy DOM/CSS class prefix is `hexaclear-*` and the play surface is
`.cubic-viewport`. The product was renamed; the class names were not. Keep using
`hexaclear-*` — do not rename classes when authoring a theme.

---

## 1. Philosophy: a theme is a product, not a palette

Themes are a **first-class identity surface** and a **monetization unit**. A buyer is
paying for the feeling of playing a *different-looking game*, not a swatch swap. The
test a reviewer (and the LLM) should apply before shipping:

> **The screenshot test.** Put a screenshot of the new theme next to the Wood theme.
> A stranger scrolling a store page must instantly read them as two different products.
> If the silhouette, materials, chrome, and mood don't change, it is not shippable.

> **The "what is this made of?" test.** Wood is carved warm cubes on a wood panel.
> Win98 is a beige OS dialog made of beveled gray chrome. Audius is a backlit glass
> instrument that breathes with music. Every new theme needs a *one-sentence material
> world* this concrete. If you can't write that sentence, the concept isn't ready.

The three shipped themes deliberately span an **escalating ladder of ambition**. Use
them as calibration for how far a paid theme should go (see §2 and §6).

---

## 2. The Departure Bar (the most important section)

A theme's "departure value" is the sum of how many of the following **transformation
axes** it changes relative to Wood. A recolor touches 1–2 axes and is **not** a paid
theme. The shipped themes each clear the bar by transforming many axes at once.

### 2.1 The transformation axes

1. **Palette & mood** — the color story and emotional register (warm/cozy vs cold/system vs neon/dark).
2. **Cube render mode** — *how a filled cell is drawn*. This is the single highest-impact axis. Options proven in-engine:
   - Isometric 3-face cube (Wood).
   - Flat single-fill tile with 2-tone bevel (Win98).
   - Translucent emissive cube that lets a background show through (Audius).
3. **Empty-cell treatment** — dimple, raised tile, wax pit, circuit socket, etc.
4. **Cell separation / rosette framing** — etched wood groove vs Win98 carved channel vs glass hairline. The 7-cell rosette boundary is a signature surface.
5. **Board panel / background** — warm radial wash vs flat inset gray vs reactive backlit glow.
6. **Chrome & layout** — does the theme *add or remove structural UI*? Win98 adds a fake OS titlebar + LCD score row. Audius adds a whole transport deck, track card, EQ meters, and search window. This axis separates "reskin" from "reinvention."
7. **Typography** — font family, smoothing, letter-spacing, casing. Wood = Nunito + Monoton display; Win98 = pixel MS Sans Serif + DSEG7 seven-segment LCD; numerals can become a hardware readout.
8. **Motion & feedback character** — Wood crossfades and glows; Win98 hard-snaps with no transitions; Audius pulses and hue-rotates with audio. The *feel* of placement/clear feedback changes even though timings are fixed (see §7).
9. **Score-tier / octave expression** — every theme inherits the tier hue-rotation engine but must re-express it (Wood = soft painterly; Win98 = punchy saturated system colors; see §5).
10. **Added behavior / runtime systems** — optional but the strongest moat. Audius streams real music and drives an analyser→CSS pipeline. A theme *can* add a JS system as long as it never touches game rules.
11. **Iconography & marks** — smiley (emoji vs raster `smiley.png`), ruby treatment, glyphs, favicon.

### 2.2 The tiers of a paid theme

| Tier | Axes transformed | Verdict | Example |
|---|---|---|---|
| **Reskin** | 1–3 (mostly palette) | ❌ Not a paid theme. Do not ship. | (none shipped) |
| **Re-theme** | ~4–7 incl. cube render mode + full chrome reskin | ✅ Minimum bar. Distinct product. | **Win98** |
| **Reinvention** | ~8+ incl. new chrome, new render mode, *and* a runtime system | ✅✅ Flagship. Premium price justified. | **Audius** |

**Rule for new paid themes: aim for Re-theme as the floor, Reinvention when the concept
supports a runtime hook.** A theme that only changes palette + background + fonts is a
free update, not a purchase.

### 2.3 What "significant" looks like, concretely

- **Win98 is significant because it changes the render model, not just colors.** It
  *hides the isometric cube entirely* (`.cube-face { display: none }`) and rebuilds the
  filled cell as a flat beveled tile, swaps every modal into an OS dialog with a navy
  titlebar, replaces the score with a seven-segment LCD, kills all transitions, and adds
  a fake window titlebar. ~3,400 lines of CSS. It re-skins *every* screen — not just the
  board.
- **Audius is significant because it adds a world and a system.** It layers an entire
  music-instrument UI (transport, track card, EQ, VU meters, search) on top of the game,
  makes the cubes translucent and emissive, and wires a Web Audio analyser to drive the
  whole palette in real time. It also adds real functionality (Audius streaming).

If a proposed theme cannot point to at least one transformation as bold as "hide the
cube faces and rebuild the cell" or "add a whole sub-UI," push the concept further
before writing code.

---

## 3. The technical contract

Themes are CSS-variable + `data-theme` driven. There is **no theme plugin API, registry,
or base class** — and intentionally so: switching is a single DOM write with no React
remount.

### 3.1 How a theme is wired (the five required touch-points)

1. **Register the id.** Extend the `ThemeId` union and the `THEME_OPTIONS` array in
   `App.tsx` (around lines 121–133):

   ```ts
   type ThemeId = 'wood' | 'win98' | 'audius' | 'yourtheme'

   const THEME_OPTIONS: { id: ThemeId; label: string }[] = [
     { id: 'wood', label: 'Cubekill (default)' },
     { id: 'win98', label: 'Windows 98' },
     { id: 'audius', label: 'Music Visualizer' },
     { id: 'yourtheme', label: 'Your Theme' },
   ]
   ```

2. **Create a scoped CSS file.** `client/src/theme-yourtheme.css`. Every rule is scoped
   under `[data-theme="yourtheme"]` (and tokens under `:root[data-theme="yourtheme"]`).
   Import it from `index.css` alongside the others:

   ```css
   @import url('./theme-win98.css');
   @import url('./theme-audius.css');
   @import url('./theme-yourtheme.css');
   ```

   All theme sheets are always loaded; inactive ones simply don't match. (If a theme gets
   very heavy — large fonts, many assets — consider lazy-loading, but match the existing
   pattern unless there's a measured reason not to.)

3. **Theme application is already handled.** A `useEffect` writes
   `document.documentElement.dataset.theme = theme`, persists to `localStorage`
   (`cubic-theme`), and swaps the favicon (`App.tsx` ~7450–7468). Add your favicon to the
   swap branch:

   ```ts
   const faviconHref =
     theme === 'win98' ? '/win_favicon.png'
       : theme === 'yourtheme' ? '/yourtheme_favicon.png'
       : '/favicon.png'
   ```

4. **Override cube palette tokens.** The cube faces resolve through CSS variables so a
   theme can repaint cubes without touching SVG. Defaults live in `:root` in `index.css`
   (~2233):

   ```css
   :root {
     --cube-top: #ffeaa3;   /* brightest plane */
     --cube-left: #f9a23f;  /* mid-tone */
     --cube-right: #a04a18; /* deepest shadow */
     --cube-stroke: rgba(40, 20, 10, 0.95);
     --score-tier-accent: #f9a23f;
     --cube-inverse-bright: #ffe9a6; /* preview-clear highlight */
     --cube-inverse-dim: #94633a;
   }
   ```

   Your theme's `:root[data-theme="yourtheme"]` block should define its own tokens.
   Define a private namespace (e.g. `--neon-*`) for theme-only tokens, and override the
   shared `--cube-*` tokens so any theme-unaware rule still resolves to a sensible color.

5. **Patch the JS branches.** A few behaviors are theme-aware in `App.tsx` and must be
   extended for full coverage:
   - `paletteForTier(tier, octave, theme)` (~546) — per-tier dynamic palette. Add a
     branch tuned to your theme (see §5).
   - `getScoreCounterEl()` (~704) — returns the DOM node the flying-score particle should
     land on. Add a selector for your theme's score readout if it differs from Wood's
     `.hexaclear-live-stat .value`.
   - PvP partner tinting (`tintCubeColor`, the `WOOD_CUBE_*` / `W98_*` constants ~606) —
     if your theme paints cubes with a different base color in multiplayer, add constants
     and a branch so partner cubes tint correctly.

### 3.2 Adding chrome (the structural-UI axis)

If your theme adds structural UI (Win98 titlebar, Audius deck), the JSX is
**always mounted** and shown/hidden purely by CSS, so theme swaps stay a single CSS
reflow with no React reconciliation. Pattern (from the Win98 titlebar, `App.tsx` ~9100):

```css
/* default: hidden */
.hexaclear-win98-titlebar { display: none; }
/* shown only under the theme */
[data-theme="win98"] .hexaclear-win98-titlebar { display: flex; }
```

Mount the extra DOM unconditionally in `App.tsx` and let the theme's CSS reveal it. Do
**not** gate it behind `theme === 'win98'` in JSX unless it carries heavy runtime cost
(the Audius deck does have runtime, but its *markup* still follows the show/hide-by-CSS
discipline where possible).

---

## 4. Surface inventory — the "nothing leaks" checklist

The single most common failure mode is a theme that nails the board but leaves a modal,
leaderboard, or settings panel looking like Wood. **A premium theme re-skins every
screen.** Win98 and Audius both spend the majority of their CSS on non-board surfaces.

Use this checklist. Each surface must read as the new theme:

**Shell & chrome**
- `.cubic-viewport`, `body` background
- `.hexaclear-root` (the app frame)
- `.hexaclear-header` + `.hexaclear-mode-toggle .mode-pill`, `.hexaclear-menu-button`
- Score/best readout: `.hexaclear-live-stat`, `.hexaclear-best-banner` (Wood) — or a
  theme-specific readout (Win98 `.hexaclear-win98-lcds`, Audius `.hexaclear-audius-readout`)
- Any added chrome your theme introduces (titlebar, deck, etc.)

**Board**
- `.hexaclear-board-wrapper` (panel), `.hexaclear-board`, background rect
- `.hexaclear-hex.empty`, `.hexaclear-hex.filled`, `.hexaclear-hex.filled.golden` (ruby)
- `.hexaclear-hex-cube` + `.cube-top/.cube-left/.cube-right/.cube-face` (or hide them)
- `.hexaclear-hex-bevels` + bevel highlight/shadow polylines
- `.hexaclear-slot-fill` (empty dimple inner hex)
- Rosette framing: `.hexaclear-flower-groove*`, `.hexaclear-flower-boundary*`
- Board outline: `.hexaclear-board-outline-back`, `.hexaclear-board-outline-front`
- Previews: `.preview-valid`, `.preview-invalid`, `.preview-clear`,
  `.preview-valid.preview-clear`, `.hexaclear-placement-ghost`
- Feedback: `.clearing` (+ `.clearing-line-step-N`, `.clearing-flower-center/ring`),
  `.invalid-drop`, `.ripple-overlay`, cube pulse/ripple overlays
- Labels: `.hexaclear-daily-number-centered`, ruby `+10` text

**Hand & hold**
- `.hexaclear-hand`, `.hexaclear-piece-button` (+ `.selected`, `.unplayable`, `.is-swap-target`)
- `.hexaclear-hold` (+ `.is-drop-active`), `.hexaclear-hold-label`
- `.hexaclear-hex.piece` (hand-piece cells), `.hexaclear-piece-cancel-mark`
- `.hexaclear-hand-status`

**Overlays / modals (re-skin all of them)**
- `.hexaclear-overlay` (backdrop), `.hexaclear-overlay-card`
- `.hexaclear-menu-card` + all `.hexaclear-menu-*` (zones, settings, nav cards, chips, heroes, danger button, sliders, checkboxes, selects)
- `.hexaclear-scores-card` + `.hexaclear-scores-*` (rows, values, tabs, rank chips, date/page steppers)
- `.hexaclear-stats-card` + `.hexaclear-profile-*`, `.hexaclear-performance-*`, `.hexaclear-mode-ledger-*`, `.hexaclear-statline-*`, `.hexaclear-record-*`
- `.hexaclear-scoring-card` + `.hexaclear-scoring-rule*`, `.hexaclear-piecetiary-cell`
- `.hexaclear-history-card` + `.hexaclear-history-cell` (today / cleared states)
- `.hexaclear-gameover-card` + `.hexaclear-gameover-*` (headline, sections, run-strip, run-stat)
- Highlight reel: `.hexaclear-reel-*` (hex, cube, points, caption) — recolor mini-board, keep ruby red
- `.hexaclear-account-card` + `.hexaclear-account-*`
- `.hexaclear-audio-unlock-card`
- Inputs everywhere: `.hexaclear-input`, range sliders (webkit + moz track/thumb), checkboxes, selects

**Multiplayer**
- Smiley: `.hexaclear-emote-trigger` (+ `.has-partner-emote`), `.hexaclear-emote-panel/option`, `.hexaclear-smiley-name`, `.hexaclear-smiley-rank`
- Co-op: `.hexaclear-coop-*` (cta, mode toggle/pill, status, code, share input)
- PvP: `.hexaclear-pvp-*` (row, track, track-fill, threshold, standings, win-tag, shame/win titles, sort toggle, scores)
- Spectator: `.hexaclear-spectator-banner*`
- Territory tints: `.pvp-tinted-self/partner`, `.hexaclear-hex-conflict-ring`, `.hexaclear-partner-ghost-fill`

**Score-tier / octave layers** — see §5.

> Tip: when in doubt, grep `theme-win98.css` for a class. Win98 is the most exhaustive
> reskin in the repo; if Win98 styles a surface, your theme probably must too.

---

## 5. Score-tier & octave system (must be re-expressed, never broken)

As the player's score climbs, the cube palette escalates. This is shared engine behavior;
each theme expresses it differently but must keep it working.

- **Tier** = every 1,000 points. **Octave** = `floor(tier / 5) + 1`, unlocking a new
  ambient layer.
- Hue rotates by the **golden angle** (`137.5°` per tier) so adjacent tiers never share a
  color family — `computeTierHue` / `paletteForTier` in `App.tsx` (~521–589).
- `paletteForTier(tier, octave, theme)` returns inline `--cube-*` overrides pushed onto
  the viewport. **Tier 0 returns `{}`** so daily mode / fresh runs fall through to your
  `:root` defaults. Your theme's resting look lives entirely in CSS tokens.
- Octave layers (CSS, in `index.css` ~2463+, additive):
  - octave-1: drifting tinted radial background wash
  - octave-2: empty-cell stroke tint
  - octave-3: cube edge-stroke tint
  - octave-4: per-face hue spread (handled in `paletteForTier`)
  - octave-5: drifting low-contrast hex background pattern
- **Wood** keeps tiers soft (78–82% saturation, bright top face — painterly). **Win98**
  pushes saturation to 92%+ with a darker lightness ramp (punchy system colors) and adds
  a `--w98-inverse-fill` that shifts per tier for the about-to-clear cells.

**Your theme must add a `paletteForTier` branch** that maps the golden-angle hue into its
own saturation/lightness band so escalation looks native. Example shape:

```ts
if (theme === 'yourtheme') {
  const sat = /* your saturation band */;
  return {
    '--cube-top':   `hsl(${topHue}, ${sat}%, /* L */%)`,
    '--cube-left':  `hsl(${baseHue}, ${sat}%, /* L */%)`,
    '--cube-right': `hsl(${rightHue}, ${sat}%, /* L */%)`,
    '--score-tier-accent': `hsl(${baseHue}, ${sat}%, /* L */%)`,
    '--cube-inverse-bright': `hsl(${inverseHue}, ${sat}%, /* L */%)`,
    '--cube-inverse-dim':    `hsl(${inverseHue}, ${sat}%, /* L */%)`,
    /* + any theme-private tokens that should track the tier */
  } as React.CSSProperties
}
```

If your theme has a strong identity color (Honeycomb = warm, Neon = cyan/magenta poles),
**constrain the hue range** so escalation enriches rather than fights the identity — the
design doc explicitly calls for this on both planned themes.

The shared `@property` color transitions (1600ms tier crossfade) and the tier/octave HUD
pulse animations come for free; do not disable them unless the theme's motion language
requires it (Win98 keeps the pulse but flattens transitions on cells).

---

## 6. Case studies: deconstructing the three shipped themes

### 6.1 Wood (base) — the reference everything departs from

- **Material:** warm carved cubes on a wood panel, cream/gold/amber over deep red-brown.
- **Cube:** isometric 3-face SVG (`--cube-top` bright cream, `--cube-left` mid amber,
  `--cube-right` deep red-brown). Empty = dark dimple `#1a0c06` with `#94633a` stroke.
- **Rosette:** etched 2-tone groove polylines (routed wood grain).
- **Panel:** radial wash `#5a341b → #28130a`, orange glow shadow.
- **Type:** Nunito body, Monoton display title in `#ffe8a3`. Rounded corners, soft shadows.
- **Motion:** smooth — `@property` palette crossfades, glows, tier pulse rings.
- **Takeaway for authors:** this is the "soft, warm, painterly, rounded" pole. To depart,
  move hard along the axes Wood sits gently on (sharpness, material, chrome, motion).

### 6.2 Win98 — the "Re-theme" exemplar (change the render model + reskin everything)

What makes it a real departure, technique by technique:

- **Strict palette** declared up front as a contract (`theme-win98.css` ~8–24): six
  Win98 system colors plus Minesweeper LCD red. A tight, documented palette is part of
  the identity.
- **Render model swap:** isometric cube faces are hidden (`.cube-face { display:none }`);
  the filled cell becomes a flat teal tile (`#008080`) with a 2-tone Minesweeper bevel.
  The raised/sunken 3D look is built from paired `box-shadow` insets + 4-tone
  `border-color` so a single element carries the full bevel with no extra wrappers.
- **Empty vs filled = raised vs pressed button.** Bevel polylines flip highlight/shadow
  on `.filled`. This is the whole visual grammar.
- **New chrome:** a fake OS titlebar (Min/Max/Close glyphs drawn in pure CSS) and an LCD
  score row using the self-hosted **DSEG7-Classic** seven-segment font, red-on-black,
  with a dim "all-8s" ghost layer underneath the lit digits.
- **Type:** pixel "MS Sans Serif" stack with `font-smoothing: none`; square corners
  everywhere (`border-radius: 0`).
- **Motion:** **hard snaps.** `transition: none` on cells — every state change paints in
  one frame, like real Minesweeper. (Crucially, this is done *without* `!important` on
  `fill`/`stroke` so keyframe clear animations still win — see §8.)
- **Total reskin:** every modal becomes a Win98 dialog (navy titlebar + beveled gray card
  + forced black text via a blanket `* { color: var(--w98-text) }` override), every button
  is a beveled push-button with a pressed `:active` state, leaderboards/stats/PvP/co-op
  all flatten to system chrome.
- **Tier expression:** same golden-angle hue, but 92%+ saturation and a per-tier
  `--w98-inverse-fill` for preview-clear cells.

### 6.3 Audius (Music Visualizer) — the "Reinvention" exemplar (add a world + a system)

- **Material:** a backlit glass instrument / light-table deck. Near-black
  (`#040309`) with cyan/teal cube palette (`--audius-cube-top: #cffff2`), amber accents,
  glassmorphic panels with inset highlights and colored glows.
- **New chrome (a whole sub-UI):** a transport deck (brand, mode bank, readouts), a
  floating track title card with progress + media controls, an EQ spectrum, side VU
  meter rails flanking the board, and a search window — none of which exist in other
  themes. This is the structural-UI axis taken to its limit.
- **Translucent emissive cubes:** filled cubes render at ~0.9 fill-opacity so the
  reactive background glows *through* them. Preview/ghost cells lean on white/translucent
  fills.
- **Runtime system (the moat):** a Web Audio analyser runs in `requestAnimationFrame`
  (~30fps, `App.tsx` ~7600–7825). It extracts bass/mid/treble/onset/intensity bands from
  the FFT, smooths them with envelopes, and writes them to CSS custom properties on the
  root: `--audius-bass/mid/treble/onset/intensity/breath`, `--audius-viz-hue`,
  `--audius-cube-hue-rotate`, `--audius-board-ambience`, meter scalars, etc.
- **GPU-cheap reactivity:** the cube layer gets **one** composited filter
  (`brightness/saturate/hue-rotate` driven by the vars) — not per-cube repaints. The cube
  subtree is static so the browser caches it as a texture and just re-runs the shader per
  frame. The ambient glow is a CSS layer driven by the hue var, not a per-frame canvas
  fill. **This is the performance pattern to copy for any reactive theme.**
- **Real functionality:** streams tracks from Audius (external API), with a search window
  and media transport. A theme is allowed to add genuine features as long as they never
  touch game rules.
- **Reduced-motion:** the reactive layer is fully neutralized under `.reduced-motion`
  (`filter: none`, overlays hidden). Non-negotiable — see §7.

---

## 7. Hard constraints (invariants that must never break)

A theme changes *appearance and ambient behavior only*. The following are off-limits:

1. **Game logic is identical.** Placement, clears, scoring, combo/streak, hold,
   game-over, modes — untouched. Themes never read or change `game/` modules.
2. **Animation timing is identical.** Line clears 220ms with 40ms-per-step stagger;
   flower center 260ms; ring delayed 190ms; invalid flash 520ms; etc. These are locked so
   audio + haptic + visual stay in sync **across themes**. You may change *colors* and
   *materials* of an animation, never its duration/stagger. (Win98 re-colors the clear via
   `hexaclear-w98-cell-unpress` but keeps the exact same 220/260/190ms timings.)
3. **Audio library is identical.** Don't add or remove SFX per theme (Audius adds *music
   playback* as a feature, which is separate from the SFX library).
4. **Board & piece geometry is identical.** 49/133 cells, the 7-rosette flower, 44 pieces,
   scoring patterns. Themes never move a hex.
5. **Hitboxes follow the visuals.** If you change a preview/cancel-mark's size, keep it in
   lock-step with the JS hit-test (Win98's cancel-mark inherits inset/size from the base
   rule specifically for this reason).
6. **Tier hue progression stays active** (you re-express it, you don't remove it — §5).
7. **Accessibility & reduced-motion.** Any continuous/reactive motion must be disabled
   under `.reduced-motion`. Maintain legible contrast (Win98 leans on this as a feature).
   Touch targets stay ≥ ~30px even when a theme shrinks chrome (Win98's narrow-viewport
   breakpoints enforce this).
8. **Mobile-first & performance.** The game is mobile-first. Reactive/animated effects
   must be GPU-composited (transform/opacity/filter on cached layers), never per-cell
   per-frame repaints. Test on a phone viewport.
9. **Code names are English-ASCII tokens** (`wood`, `win98`, `audius`, …). Keep the
   `hexaclear-*` class prefix.
10. **No remount on switch.** The theme must apply through CSS + `data-theme`. Always-mount
    any extra chrome and reveal it via CSS.

---

## 8. Best practices & known pitfalls (learned from the shipped themes)

- **Scope everything.** Every rule begins with `[data-theme="yourtheme"]` (tokens with
  `:root[data-theme="yourtheme"]`). Nothing should leak when the theme is inactive.
- **`!important` discipline on animated SVG properties.** Do **not** put `!important` on
  `fill` / `stroke` / `stroke-width` of cells. Per the cascade, `!important` author
  declarations beat *animation* declarations, which would silently disable the clear /
  ripple / invalid-flash keyframes. The `[data-theme]` attribute already adds enough
  specificity to beat Wood's non-important base rules. Reserve `!important` for things
  nothing animates (e.g. neutralizing a `filter`, forcing modal text color). This is the
  most subtle bug in the system — Win98 documents it heavily at `theme-win98.css` ~664.
- **Keep tier-awareness in fills.** Hardcoding a color (e.g. teal) freezes it at tier 0
  forever. Use `color-mix(in srgb, var(--your-tier-token) X%, …)` so previews/strokes
  track the escalating palette (Win98's `preview-valid` was hardcoded teal until it was
  switched to `color-mix` off `--w98-cube-fill`).
- **Use CSS variables for anything that escalates;** push per-frame or per-tier values
  from JS as inline custom properties on the viewport/root rather than rebuilding rules.
- **One compositor filter, not many.** For reactive themes, apply a single
  `filter`/`transform` to a cached static subtree (the whole board) and avoid neighborhood
  samplers (`blur`, `drop-shadow`) and per-element fill changes in the hot path. Advance a
  hue-rotate constant in JS instead of repainting (Audius pattern).
- **Don't fight `overflow: hidden`.** If your theme clips the board panel
  (`overflow: hidden` for rounded corners/glow), modals rendered inside it will be
  cropped. Audius solves this by pinning `.hexaclear-overlay` to `position: fixed; inset:0`.
- **Blanket text override for modals is acceptable** when the base theme uses many warm
  helper colors: `[data-theme="x"] .hexaclear-overlay-card * { color: …; opacity: 1; }`
  then re-assert special cases (titlebar text). Win98 does exactly this rather than chasing
  dozens of helper classes.
- **iOS/WebKit SVG filter caveat.** CSS shorthand filter functions (`invert()`,
  `hue-rotate()`) are ignored on inner SVG `<g>` elements on WebKit/iOS. Reference a real
  SVG `<filter>` in the board `<defs>` instead (Audius's about-to-clear highlight uses
  `filter: url(#audius-clear-invert)` for this reason).
- **Score-fly target.** If your theme relocates the score readout, update
  `getScoreCounterEl()` or the flying-score particle will land in the wrong place.
- **Test the full surface list (§4)** in: a fresh endless run, mid-run at a high tier, an
  open menu, the high-scores card, the stats card, the game-over screen (including the
  highlight reel), and a multiplayer room (co-op + PvP). These are the screens that most
  often leak base-theme styling.

---

## 9. Recipe: adding a new theme end-to-end

1. **Write the one-sentence material world** (the "what is this made of?" sentence) and a
   strict palette (6–10 named tokens). Pick which transformation axes (§2.1) you will move
   and confirm you clear the Re-theme bar (§2.2).
2. **Register** the `ThemeId` + `THEME_OPTIONS` entry, create `theme-yourtheme.css`,
   `@import` it, and add the favicon swap (§3.1).
3. **Define tokens** in `:root[data-theme="yourtheme"]`: override `--cube-*` and declare
   your private `--yourtheme-*` namespace.
4. **Style the board first** — empty/filled/ruby cells, cube render mode (faces or flat or
   translucent), bevels/grooves, panel/background, previews, clearing/invalid/ripple
   feedback. Verify clear animations still fire (§8 `!important` rule).
5. **Add chrome** if the concept calls for it (titlebar/deck/etc.), always-mounted and
   CSS-revealed (§3.2).
6. **Re-skin every overlay/menu/leaderboard/stats/gameover/MP surface** from the
   checklist (§4). This is the bulk of the work.
7. **Add the `paletteForTier` branch** so tier/octave escalation is native (§5). Patch
   `getScoreCounterEl` and PvP tint constants if needed.
8. **Add a runtime system only if it elevates the concept to Reinvention** (e.g. ambient
   particles for Honeycomb, scanline/grid layers for Neon). Keep it GPU-cheap and
   reduced-motion-safe (§7, §8).
9. **QA across the full screen list** (§8 last bullet), on a phone viewport, with
   reduced-motion on and off.
10. **Apply the screenshot test** (§1). If it doesn't read as a different product next to
    Wood, push further before shipping.

---

## 10. Idea seeds (pre-vetted concept directions)

The design improvements doc already sketches two concepts that clear the bar. Use them as
calibrated examples of "how specific a concept should be before coding":

- **Neon / Cyberpunk / Tron** — near-black bg, electric cyan primary, hot magenta
  secondary, lime accent. **Wireframe emissive cubes** (thin glowing edges, near-transparent
  face). Empty cells = dark sockets with a pulsing cyan stroke on hover. Rosette groove
  restyled as a PCB circuit trace. Ruby = magenta wireframe. Faux-LCD cyan-on-black score
  with bloom. Tier hue constrained to the cyan/magenta poles; octaves add scanline + grid
  layers. (Render-mode change + chrome restyle + tier reframing ⇒ Re-theme, leaning
  Reinvention if the scanline/grid system is built.)
- **Honeycomb / Beehive** — deep amber/honey radial wash, golden-yellow primary, wax-cream
  highlights, dark-brown structural lines. Isometric cube **textured** as honey/beeswax.
  Empty cells = translucent wax-cell pits with inner shadow. Rosette groove → embossed
  comb-wall. Ruby = "queen jewel" amber/ruby gradient or bee glyph. Tier hue constrained to
  the warm half of the wheel. Runtime delight: a single golden mote drifting every 6–10s
  (reduced-motion disables). (Material + texture + tier constraint + ambient system ⇒
  Re-theme, leaning Reinvention.)

When generating a brand-new concept, write it to this level of specificity — palette hex
values, cube render mode, empty-cell treatment, rosette treatment, ruby treatment, tier
constraint, and any runtime delight — *before* writing CSS.

---

## Appendix: key file map

| Concern | Location |
|---|---|
| `ThemeId`, `THEME_OPTIONS` | `client/src/App.tsx` ~121 |
| Theme apply + persist + favicon | `client/src/App.tsx` ~7450 |
| `paletteForTier`, `computeTierHue`, `computeScoreOctave` | `client/src/App.tsx` ~520–589 |
| `tintCubeColor`, `WOOD_CUBE_*`, `W98_*` | `client/src/App.tsx` ~606–696 |
| `getScoreCounterEl` | `client/src/App.tsx` ~704 |
| Audius analyser → CSS-var loop | `client/src/App.tsx` ~7600–7825 |
| Win98 titlebar JSX | `client/src/App.tsx` ~9100 |
| Audius deck JSX | `client/src/App.tsx` ~9480 |
| Base `:root` cube tokens | `client/src/index.css` ~2233 |
| `@property` tier color transitions | `client/src/index.css` ~2283 |
| Octave layer CSS | `client/src/index.css` ~2463+ |
| Win98 theme | `client/src/theme-win98.css` |
| Audius theme | `client/src/theme-audius.css` |
| Shipped-theme spec | `Documentation/Cubekill UX Design Document.md` §13 |
| Future-theme concepts | `Documentation/Cubekill Design Improvements.md` §3 |
