// Highlight-reel GIF exporter (canvas-native renderer).
//
// Rather than screenshot the live DOM frame-by-frame (slow and
// noisy), this module re-renders the highlight reel directly to
// an offscreen 2D canvas and feeds each rendered frame into
// `gifenc`. The visual style is a faithful Canvas2D port of the
// SVG-based on-page reel in `highlightReel.tsx`:
//
//   - Hex outlines (fill + thin stroke)
//   - Flat hex "cubes" (no faceted bevel; the on-screen reel
//     deliberately omits these for size)
//   - The placed cube's overshoot pop-in
//   - The line-wipe / flower-burst clearing animations, with
//     the same per-cell delays the live reel uses
//   - The "+N points" payoff text floating up out of the rosette
//   - The blinking REPLAY badge in the top-left
//
// Why this approach beats DOM screenshotting:
//   - Crisp vector output — no html2canvas rasterization noise
//   - Every frame is generated in ~1-3ms (vs ~600ms for
//     html2canvas), so we can encode at 30fps and finish in well
//     under a second on a typical laptop
//   - The animation timeline is fully deterministic; we don't
//     race the browser's paint loop to get specific phase frames

import type { CellId } from './game/hexTypes'
import {
  HEX_GEOMETRY,
  PHASE_PLACE_MS,
  PHASE_PLACE_TRIGGER_MS,
  PHASE_TOTAL_MS,
  computeClearingClasses,
  layoutForMode,
  type ReelLayout,
  type RunHighlightSnapshot,
} from './highlightReel'

// Output / encoding cadence. 30fps is overkill for the eye on a
// looping social GIF, but it keeps the file under ~80KB while
// reading as smooth motion. The total reel runtime is ~1.35s so
// we end up with ~40 frames per export.
const FPS = 30
const FRAME_INTERVAL_MS = 1000 / FPS

// Output resolution. Renders at ~4x the on-screen 150px reel
// height. We supersample further during render (see
// `RENDER_SCALE` in captureHighlightReelAsGif) and downsample
// at encode time so AA gradients along Monoton's thin tube
// strokes survive the palette quantization. Anything smaller
// than ~480px here collapses the double-tube strokes into a
// single chunky stroke and the watermark stops reading as
// Monoton.
const OUTPUT_HEIGHT = 600
// Outer padding around the rosette inside the dark background
// gradient. Matches the on-screen reel's breathing room so
// exports don't look cramped.
const OUTPUT_PADDING = 28
// Maximum colors in the quantized palette. Monoton's thin
// glyph strokes need a generous AA gradient (~8-12 indexed
// shades between text color and background) to read smoothly.
// 255 is the GIF spec ceiling (256 minus one reserved entry);
// going lower than ~200 makes the watermark look pixelated
// even at higher resolutions.
const MAX_PALETTE_COLORS = 255
// Internal supersample factor for the off-screen canvas. We
// render at `OUTPUT_HEIGHT * RENDER_SCALE` and the browser
// downsamples (via `drawImage`) into the encoded
// `OUTPUT_HEIGHT` canvas, giving us proper area-average
// anti-aliasing on the Monoton glyphs instead of the
// nearest-neighbor-style stair-step we'd get from rendering
// straight to the final size.
const RENDER_SCALE = 2

// CSS keyframe constants for the in-cube animations. Mirrored
// from the corresponding keyframes in `index.css` —
// `hexaclear-reel-placed`, `hexaclear-reel-clear`, and
// `hexaclear-reel-points`. Drift here = exports stop matching
// the on-screen reel's feel.
const PLACED_ANIM_MS = 320
const CLEAR_ANIM_MS = 540
const POINTS_ANIM_MS = 720
// Per-cell delays for the clearing-line cascade (mirrors
// `clearing-line-step-N` rules in index.css).
const LINE_STEP_DELAY_MS = 55
// Flower clears: ring cells lag the center by 60ms to sell the
// "burst from the middle" feel.
const FLOWER_RING_DELAY_MS = 60

// Visual palette. Hardcoded to the warm-wood default theme — the
// on-screen `.hexaclear-reel-cube` doesn't currently have per-
// theme overrides, so the GIF doesn't need them either. If we
// ever theme the reel cubes, swap these for `getComputedStyle`
// reads driven by the live `<polygon>` elements.
const COLOR_BG_TOP = 'rgba(20, 8, 2, 0.95)'
const COLOR_BG_BOTTOM = 'rgba(40, 16, 4, 0.95)'
const COLOR_HEX_FILL = 'rgba(34, 14, 4, 0.62)'
const COLOR_HEX_STROKE = 'rgba(255, 232, 163, 0.16)'
const COLOR_CUBE_BASE = '#c08049'
const COLOR_CUBE_PLACED = '#e0a060'
const COLOR_CUBE_STROKE = 'rgba(0, 0, 0, 0.35)'
const COLOR_POINTS = '#ffe8a3'
const COLOR_POINTS_GLOW = 'rgba(255, 212, 120, 0.55)'
// Watermark text — restyled from the original red REPLAY tag
// to a warm gold/brown that matches the global Cubekill title
// (`.hexaclear-title` in index.css). The text is "CUBEKILL.FUN"
// rendered in the Monoton title font so the GIF carries the
// brand wherever it gets shared. The earlier bordered "tag"
// background was dropped — the bare text reads cleaner on
// share surfaces.
const COLOR_STAMP_TEXT = '#ffe8a3'
const COLOR_STAMP_TEXT_SHADOW = '#b2481b'
const STAMP_TEXT = 'CUBEKILL.FUN'
// The title-bar font. Quoted so the canvas font shorthand
// parser treats `Monoton` as a font-family rather than mashing
// it into the comma-separated fallback list with extra
// whitespace. Without the quotes some Chromium builds render
// the fallback even when Monoton has loaded.
const STAMP_FONT_FAMILY = '"Monoton", system-ui, sans-serif'

export type CaptureProgress = {
  // 0..1 inclusive. 0 = just started, 1 = file ready.
  ratio: number
  // Human-readable phase label suitable for a button.
  label: 'recording' | 'encoding' | 'done'
}

type CaptureGifArgs = {
  snapshot: RunHighlightSnapshot
  onProgress?: (progress: CaptureProgress) => void
}

type CaptureMultiGifArgs = {
  // Ordered list of placements to encode into a single GIF, oldest
  // → newest. Mirrors the on-screen `<MultiHighlightReel>` preview.
  // Every snapshot is rendered with the same canvas geometry, so
  // they're expected to all share `mode` (true for any single-run
  // export, which is the only thing this surface ships today).
  snapshots: RunHighlightSnapshot[]
  onProgress?: (progress: CaptureProgress) => void
}

// Single-snapshot filename: includes the points so a folder of
// exports is easy to skim by score.
const buildFilename = (snapshot: RunHighlightSnapshot): string => {
  const points = Math.max(0, Math.floor(snapshot.pointsGained))
  const ts = buildTimestamp()
  return `cubekill-best-clear-${points}pts-${ts}.gif`
}

// Multi-snapshot filename: identifies the export as a recent-moves
// clip by the snapshot count rather than a score.
const buildMultiFilename = (snapshots: RunHighlightSnapshot[]): string => {
  const ts = buildTimestamp()
  return `cubekill-last-${snapshots.length}-moves-${ts}.gif`
}

const buildTimestamp = (): string =>
  new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[:-]/g, '')
    .replace('T', '-')

// Force-trigger a browser download for a Blob. The `<a>` element
// is created on the fly and removed immediately — no DOM litter.
// Used as the desktop / non-share fallback below.
const triggerDownload = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Save or share a GIF blob.
//
// On platforms that support sharing files via the Web Share API
// (iOS Safari and Android Chrome being the main targets), open
// the system share sheet — which exposes "Save Image" / "Save to
// Photos" / Messages / AirDrop / etc. as first-class targets. On
// mobile this lets the player drop the GIF straight into their
// camera roll with one tap instead of fishing through Downloads.
// On desktop or any browser without file-share support, fall
// back to the classic <a download> anchor click so the user
// always gets the file one way or the other.
//
// Notes:
//   • The web platform has no direct write-to-Photos API; the
//     share sheet's "Save Image" target is as close as we get.
//   • navigator.share() rejects with AbortError when the user
//     dismisses the sheet — that's not a failure, so we don't
//     fall back to a download in that case.
//   • Any other rejection from share() (DataError, NotAllowed,
//     unsupported file type, etc.) falls through to the anchor
//     download so the user still gets the file.
const saveOrShareGif = async (
  blob: Blob,
  filename: string,
  shareTitle: string,
): Promise<void> => {
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    let file: File | null = null
    try {
      file = new File([blob], filename, {
        type: blob.type || 'image/gif',
      })
    } catch {
      file = null
    }
    const canShareFiles =
      file !== null &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [file] })
    if (file && canShareFiles) {
      try {
        await navigator.share({ files: [file], title: shareTitle })
        return
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          // User dismissed the share sheet on purpose — respect
          // that and don't double-fire a download under them.
          return
        }
        // Any other failure falls through to the anchor
        // download so the user still ends up with the file.
      }
    }
  }
  triggerDownload(blob, filename)
}

// ────────────────────────────────────────────────────────────
// Easing
//
// CSS bezier curves we need to approximate, picked to *feel*
// right rather than be mathematically exact. The on-page
// renderer is the source of truth; players watching both side
// by side won't notice sub-frame timing differences but they
// will notice the wrong gestalt (e.g. a linear scale-in instead
// of an overshoot pop).
// ────────────────────────────────────────────────────────────

// cubic-bezier(0.4, 0.2, 0.2, 1) ≈ a classic easeOutCubic.
const easeOutCubic = (t: number): number => {
  const clamped = Math.min(1, Math.max(0, t))
  return 1 - Math.pow(1 - clamped, 3)
}

// cubic-bezier(0.18, 0.78, 0.32, 1) for the "+N" floats. Close
// enough to easeOutCubic for our purposes; the eye is reading
// the text content, not the precise tween shape.
const easeOutFloat = easeOutCubic

// Linear interp between numeric keyframes [progress, value].
// Used for the per-keyframe lerp inside `hexaclear-reel-placed`
// and `hexaclear-reel-clear`, which have an intermediate
// keyframe (60% / 35%) the eye reads as a beat of overshoot.
const interpolateKeyframes = (
  progress: number,
  keyframes: Array<[number, number]>,
  ease: (t: number) => number = easeOutCubic,
): number => {
  const p = Math.min(1, Math.max(0, progress))
  for (let i = 0; i < keyframes.length - 1; i++) {
    const [aStop, aVal] = keyframes[i]
    const [bStop, bVal] = keyframes[i + 1]
    if (p <= bStop) {
      const segLen = bStop - aStop
      if (segLen <= 0) return bVal
      const segT = (p - aStop) / segLen
      return aVal + (bVal - aVal) * ease(segT)
    }
  }
  return keyframes[keyframes.length - 1][1]
}

// ────────────────────────────────────────────────────────────
// Per-cell timing
// ────────────────────────────────────────────────────────────

// For a given cleared cell, derive the delay (ms after the
// "cleared" phase begins) before its scale-out animation should
// fire. Mirrors the CSS `clearing-line-step-N` and
// `clearing-flower-ring` rules.
const deriveClearDelay = (
  cellId: CellId,
  clearingClasses: Record<CellId, string[]>,
): number => {
  const classes = clearingClasses[cellId]
  if (!classes) return 0
  for (const cls of classes) {
    if (cls === 'clearing-flower-ring') return FLOWER_RING_DELAY_MS
    if (cls.startsWith('clearing-line-step-')) {
      const stepIdx = Number.parseInt(cls.slice('clearing-line-step-'.length), 10)
      if (Number.isFinite(stepIdx)) return stepIdx * LINE_STEP_DELAY_MS
    }
  }
  return 0
}

// ────────────────────────────────────────────────────────────
// Canvas geometry helpers
// ────────────────────────────────────────────────────────────

// Trace the six-sided cube polygon centered at (cx, cy). Same
// math as `buildHexPoints` in highlightReel.tsx, but expressed
// as canvas path ops so we can fill/stroke directly.
const traceHexPath = (
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
): void => {
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const angleRad = ((60 * i - 30) * Math.PI) / 180
    const x = cx + size * Math.cos(angleRad)
    const y = cy + size * Math.sin(angleRad)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

const traceRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void => {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

// ────────────────────────────────────────────────────────────
// Frame renderer
//
// Computes the visual state at time `t` (ms since reel start)
// and rasterizes it into the supplied 2D context. Pure of side
// effects beyond mutating the canvas pixels.
// ────────────────────────────────────────────────────────────

type RenderContext = {
  snapshot: RunHighlightSnapshot
  layout: ReelLayout
  clearingClasses: Record<CellId, string[]>
  placedSet: Set<CellId>
  clearingSet: Set<CellId>
  // Pixel scale from layout coords (the reel SVG's internal
  // viewBox) to canvas pixels. Computed once per export.
  pixelScale: number
  canvasWidth: number
  canvasHeight: number
}

const renderFrame = (
  ctx: CanvasRenderingContext2D,
  rc: RenderContext,
  t: number,
): void => {
  const {
    snapshot,
    layout,
    clearingClasses,
    placedSet,
    clearingSet,
    pixelScale,
    canvasWidth,
    canvasHeight,
  } = rc

  // 1. Background gradient — matches `.hexaclear-reel`.
  ctx.save()
  ctx.fillStyle = (() => {
    const g = ctx.createLinearGradient(0, 0, 0, canvasHeight)
    g.addColorStop(0, COLOR_BG_TOP)
    g.addColorStop(1, COLOR_BG_BOTTOM)
    return g
  })()
  // Rounded background so the GIF looks like a card when shared
  // outside the modal. Radius is in canvas pixels.
  traceRoundedRect(ctx, 0, 0, canvasWidth, canvasHeight, 16)
  ctx.fill()
  ctx.restore()

  // 2. Determine phase from t.
  const inPlaced = t >= PHASE_PLACE_TRIGGER_MS
  const inCleared = t >= PHASE_PLACE_MS
  const clearLocalT = inCleared ? t - PHASE_PLACE_MS : 0

  // 3. Set up the layout-coords transform: translate so the
  //    rosette is centered horizontally and vertically inside
  //    the canvas, then scale.
  ctx.save()
  const rosetteW = layout.width * pixelScale
  const rosetteH = layout.height * pixelScale
  const rosetteX = (canvasWidth - rosetteW) / 2
  const rosetteY = (canvasHeight - rosetteH) / 2
  ctx.translate(rosetteX, rosetteY)
  ctx.scale(pixelScale, pixelScale)

  // 4. Hex outlines for every cell. Drawn every frame — these
  //    are the static "board skeleton".
  for (const cell of layout.boardDef.cells) {
    const pos = layout.positions[cell.id]
    const cx = pos.x + layout.offsetX
    const cy = pos.y + layout.offsetY
    traceHexPath(ctx, cx, cy, HEX_GEOMETRY.HEX_SIZE)
    ctx.fillStyle = COLOR_HEX_FILL
    ctx.fill()
    ctx.strokeStyle = COLOR_HEX_STROKE
    ctx.lineWidth = 1
    ctx.stroke()
  }

  // 5. Cubes. Each cell's draw decision depends on the phase
  //    and any active animation. The branching here mirrors
  //    the React render in `highlightReel.tsx` —
  //    `fillNow` plus the `is-placed-now` / `clearing-*`
  //    class state — so the canvas and the on-screen reel
  //    agree on which cells are visible at any t.
  for (const cell of layout.boardDef.cells) {
    const pos = layout.positions[cell.id]
    const cx = pos.x + layout.offsetX
    const cy = pos.y + layout.offsetY
    const wasFilledBefore = snapshot.boardBefore[cell.id] === 'filled'
    const isPlaced = placedSet.has(cell.id)
    const isClearing = inCleared && clearingSet.has(cell.id)

    if (!inPlaced) {
      // 'before' phase: only pre-placement filled cells.
      if (wasFilledBefore) {
        drawCube(ctx, cx, cy, 1, 1, COLOR_CUBE_BASE)
      }
      continue
    }

    if (!inCleared) {
      // 'placed' phase: original cells + the placed piece's
      // pop-in animation.
      if (wasFilledBefore && !isPlaced) {
        drawCube(ctx, cx, cy, 1, 1, COLOR_CUBE_BASE)
      }
      if (isPlaced) {
        const localT = t - PHASE_PLACE_TRIGGER_MS
        const progress = localT / PLACED_ANIM_MS
        if (progress >= 1) {
          drawCube(ctx, cx, cy, 1, 1, COLOR_CUBE_PLACED)
        } else {
          const scale = interpolateKeyframes(progress, [
            [0, 0.4],
            [0.6, 1.18],
            [1, 1.0],
          ])
          const opacity = interpolateKeyframes(progress, [
            [0, 0],
            [0.6, 1],
            [1, 1],
          ])
          drawCube(ctx, cx, cy, scale, opacity, COLOR_CUBE_PLACED)
        }
      }
      continue
    }

    // 'cleared' phase.
    const baseColor = isPlaced ? COLOR_CUBE_PLACED : COLOR_CUBE_BASE
    if (isClearing) {
      const delay = deriveClearDelay(cell.id, clearingClasses)
      const localT = clearLocalT - delay
      if (localT < 0) {
        // Cell is queued but its delay hasn't elapsed — render
        // at full visibility.
        drawCube(ctx, cx, cy, 1, 1, baseColor)
      } else if (localT < CLEAR_ANIM_MS) {
        const progress = localT / CLEAR_ANIM_MS
        const scale = interpolateKeyframes(progress, [
          [0, 1],
          [0.6, 1.18],
          [1, 0.2],
        ])
        const opacity = interpolateKeyframes(progress, [
          [0, 1],
          [0.6, 0.6],
          [1, 0],
        ])
        drawCube(ctx, cx, cy, scale, opacity, baseColor)
      }
      // After CLEAR_ANIM_MS the cell is gone; nothing to draw.
    } else if (wasFilledBefore || isPlaced) {
      drawCube(ctx, cx, cy, 1, 1, baseColor)
    }
  }

  ctx.restore()

  // 6. "+N points" overlay during the cleared phase. The
  //    on-screen reel positions this absolutely in the middle
  //    of the board wrap, then translates it upward via the
  //    keyframe.
  if (inCleared && snapshot.pointsGained > 0) {
    const progress = clearLocalT / POINTS_ANIM_MS
    if (progress >= 0 && progress <= 1) {
      const opacity = interpolateKeyframes(
        progress,
        [
          [0, 0],
          [0.35, 1],
          [1, 0],
        ],
        easeOutFloat,
      )
      const translateY = interpolateKeyframes(
        progress,
        [
          [0, 8],
          [0.35, -10],
          [1, -24],
        ],
        easeOutFloat,
      )
      const textScale = interpolateKeyframes(
        progress,
        [
          [0, 0.7],
          [0.35, 1.1],
          [1, 1],
        ],
        easeOutFloat,
      )
      if (opacity > 0) {
        ctx.save()
        ctx.globalAlpha = opacity
        const centerX = canvasWidth / 2
        const centerY = canvasHeight / 2 + translateY * pixelScale
        ctx.translate(centerX, centerY)
        ctx.scale(textScale, textScale)
        // Font size scales off the output height so big GIFs
        // get proportionally bold text. 22px at the 360px
        // reference height matches the on-screen 1.4rem.
        const fontPx = Math.round(OUTPUT_HEIGHT / 16)
        ctx.font = `800 ${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`
        ctx.fillStyle = COLOR_POINTS
        ctx.shadowColor = COLOR_POINTS_GLOW
        ctx.shadowBlur = 10
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(`+${snapshot.pointsGained}`, 0, 0)
        ctx.restore()
      }
    }
  }

  // 7. Watermark badge — Monoton-set "CUBEKILL.FUN" pinned to
  //    the top-left. Mirrors the on-screen `.hexaclear-reel-stamp`
  //    so the GIF and the live reel both carry the brand
  //    consistently. No blink — the original REPLAY tag flashed
  //    to flag "this isn't live", but a watermark is identity
  //    and competing with the cube action for attention would
  //    cheapen both.
  ctx.save()
  // Sized so Monoton's tube-stroke glyphs have enough pixels to
  // read distinctly — going smaller makes the double-stroke
  // collapse into a single thick line and the font reads as a
  // generic sans-serif.
  const stampFontPx = Math.round(OUTPUT_HEIGHT / 20)
  ctx.font = `400 ${stampFontPx}px ${STAMP_FONT_FAMILY}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const stampLabel = STAMP_TEXT
  // Canvas2D didn't honor CSS `letter-spacing` historically, so
  // we draw glyph-by-glyph and insert the spacing manually. This
  // way the title font's wide-track look survives into the GIF.
  const letterSpacingPx = stampFontPx * 0.08
  const stampPaddingX = Math.round(OUTPUT_HEIGHT / 50)
  const stampPaddingY = Math.round(OUTPUT_HEIGHT / 110)
  const stampH = stampFontPx + stampPaddingY * 2
  const stampX = OUTPUT_PADDING / 2 + stampPaddingX
  const stampY = OUTPUT_PADDING / 2
  // No background plate anymore — the watermark sits directly
  // on the reel's gradient. Drop-shadow first, then the gold
  // glyph on top, same warm-orange offset the global title
  // uses (`.hexaclear-title`'s `0 2px 0 #b2481b`).
  const drawGlyphs = (
    color: string,
    offsetX: number,
    offsetY: number,
  ): void => {
    ctx.fillStyle = color
    let cursor = stampX + offsetX
    const baseY = stampY + stampH / 2 + offsetY
    for (const ch of stampLabel) {
      ctx.fillText(ch, cursor, baseY)
      cursor += ctx.measureText(ch).width + letterSpacingPx
    }
  }
  drawGlyphs(COLOR_STAMP_TEXT_SHADOW, 0, 1)
  drawGlyphs(COLOR_STAMP_TEXT, 0, 0)
  ctx.restore()
}

// Single cube draw. Pulled out so the per-phase branches above
// stay readable; identical to what the on-page CSS produces
// minus the bevel-less polygon stroke.
const drawCube = (
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  scale: number,
  opacity: number,
  color: string,
): void => {
  if (opacity <= 0 || scale <= 0) return
  ctx.save()
  ctx.globalAlpha = opacity
  ctx.translate(cx, cy)
  ctx.scale(scale, scale)
  traceHexPath(ctx, 0, 0, HEX_GEOMETRY.HEX_SIZE)
  ctx.fillStyle = color
  ctx.fill()
  ctx.strokeStyle = COLOR_CUBE_STROKE
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.restore()
}

/**
 * Render the highlight reel as an animated GIF and prompt the
 * user to save it. Resolves once the download is triggered (or
 * rejects on a fatal encode error). Pure of any side effects on
 * the live React reel — we re-render the snapshot from scratch
 * into an offscreen canvas, so the on-page replay doesn't
 * stutter while encoding.
 */
export const captureHighlightReelAsGif = async ({
  snapshot,
  onProgress,
}: CaptureGifArgs): Promise<void> => {
  if (typeof window === 'undefined') {
    throw new Error('GIF export is browser-only')
  }
  const gifenc = await import('gifenc')
  const { GIFEncoder, quantize, applyPalette } = gifenc

  // Make sure the Monoton title font (used by the corner
  // watermark) is fully loaded AND that the FontFaceSet thinks
  // it can be drawn before we start rasterizing. The global
  // `@import` in index.css fetches it on app boot, but the
  // actual font file is only fetched when something paints
  // Monoton text — and Canvas2D won't proactively trigger that
  // fetch, so an export attempted before the on-screen
  // watermark has rendered (or on a fresh hard reload) needs
  // an explicit kick. We:
  //   1. Call `document.fonts.load(...)` with the exact
  //      shorthand we'll be passing to ctx.font. This both
  //      requests the font file and resolves when the file's
  //      ready.
  //   2. Then `await document.fonts.ready` to be doubly sure
  //      the FontFaceSet has settled before we paint — Chromium
  //      historically caches a fallback glyph cache on the
  //      first ctx.font assignment, so painting too early can
  //      lock in the wrong glyphs even after the real font has
  //      since loaded.
  if (typeof document !== 'undefined' && document.fonts?.load) {
    try {
      await document.fonts.load(`400 16px "Monoton"`)
      await document.fonts.load(`400 32px "Monoton"`)
      if (document.fonts.ready) {
        await document.fonts.ready
      }
    } catch {
      // Font loading failures shouldn't block the export — the
      // badge will fall back to system-ui, which still reads as
      // "CUBEKILL.FUN" even if the glyph shapes look generic.
    }
  }

  const layout = layoutForMode(snapshot.mode)
  // Output dimensions: preserve aspect ratio of the rosette,
  // add a uniform breathing-room border for the background.
  const pixelScale = (OUTPUT_HEIGHT - OUTPUT_PADDING * 2) / layout.height
  const canvasWidth = Math.round(layout.width * pixelScale + OUTPUT_PADDING * 2)
  const canvasHeight = OUTPUT_HEIGHT

  // Render canvas: oversized by RENDER_SCALE so the browser
  // does proper area-average downsampling when we copy into
  // the encode canvas below. Without this step the Monoton
  // glyphs render straight to the encode resolution and the
  // thin tube strokes alias badly under palette quantization.
  const renderCanvas = document.createElement('canvas')
  renderCanvas.width = canvasWidth * RENDER_SCALE
  renderCanvas.height = canvasHeight * RENDER_SCALE
  const renderCtx = renderCanvas.getContext('2d')
  if (!renderCtx) {
    throw new Error('Could not acquire render 2D context')
  }
  // The render context is in upscaled coordinates; setting the
  // transform once lets us call `renderFrame` with the same
  // pixelScale as before — the supersample factor is folded
  // into the matrix.
  renderCtx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0)

  // Encode canvas: the final output resolution. We `drawImage`
  // the renderCanvas into this one with smoothing enabled,
  // which gives us the area-averaged downsample we want.
  const canvas = document.createElement('canvas')
  canvas.width = canvasWidth
  canvas.height = canvasHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    throw new Error('Could not acquire 2D context')
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  const rc: RenderContext = {
    snapshot,
    layout,
    clearingClasses: computeClearingClasses(snapshot),
    placedSet: new Set(snapshot.placedCellIds),
    clearingSet: new Set(snapshot.clearedCellIds),
    pixelScale,
    canvasWidth,
    canvasHeight,
  }

  // Tail-hold padding so the GIF loop ends on the "+N" payoff
  // for a beat before snapping back. Renders the very last
  // frame ~700ms longer than a normal frame.
  const tailHoldMs = 700
  const animatedDurationMs = PHASE_TOTAL_MS
  const animatedFrames = Math.ceil(animatedDurationMs / FRAME_INTERVAL_MS)
  // +1 for the tail freeze frame; we render it at the same time
  // as the last animated frame but encode it with a longer
  // per-frame delay.
  const totalFrames = animatedFrames + 1

  // Two-pass encode for smaller files at higher quality:
  //   Pass 1: render every frame's pixels, accumulate them into
  //           a single byte buffer, then quantize ONCE to derive
  //           a single palette covering every color in the
  //           animation. Per-frame palettes would each chew
  //           ~768 bytes for the color table plus the frame's
  //           own quantization artifacts where adjacent frames
  //           pick slightly different indexes for the same
  //           on-screen color (= flicker).
  //   Pass 2: re-apply that global palette per frame and write.
  //           The GIF reuses the global color table, so each
  //           frame's overhead is just the encoded image data.
  //
  // The memory cost is bounded: ~40 frames × ~300×300 × 4 bytes
  // ≈ 14MB peak, well within a single browser tab's budget.
  const rawFrames: Uint8ClampedArray[] = []
  for (let i = 0; i < totalFrames; i++) {
    const t = Math.min(animatedDurationMs, i * FRAME_INTERVAL_MS)
    // Two-step draw: 1) paint into the supersampled render
    // canvas (so Monoton's tube strokes get rasterized with the
    // full glyph cache resolution), 2) blit + downsample into
    // the encode canvas with `imageSmoothingQuality: 'high'`,
    // 3) snapshot the encode canvas's pixels for quantization.
    renderFrame(renderCtx, rc, t)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight)
    ctx.drawImage(
      renderCanvas,
      0,
      0,
      renderCanvas.width,
      renderCanvas.height,
      0,
      0,
      canvasWidth,
      canvasHeight,
    )
    const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight)
    rawFrames.push(new Uint8ClampedArray(imageData.data))
    if (onProgress) {
      onProgress({
        ratio: (i + 1) / totalFrames * 0.5,
        label: 'recording',
      })
    }
    // Yield to the event loop every ~6 frames so React can keep
    // updating the progress label and the page stays responsive
    // while we render. Without the yield the label would jump
    // straight from 0% to 100% and feel broken.
    if (i % 6 === 5) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  if (onProgress) {
    onProgress({ ratio: 0.55, label: 'encoding' })
  }

  // Build the global palette from the union of every frame's
  // pixels. We don't need to copy every byte; concatenating
  // into a single Uint8ClampedArray is enough for `quantize` to
  // see the full color distribution.
  const bytesPerFrame = canvasWidth * canvasHeight * 4
  const combined = new Uint8ClampedArray(bytesPerFrame * rawFrames.length)
  for (let i = 0; i < rawFrames.length; i++) {
    combined.set(rawFrames[i], i * bytesPerFrame)
  }
  const globalPalette = quantize(combined, MAX_PALETTE_COLORS, {
    format: 'rgba4444',
  })

  const gif = GIFEncoder()
  const baseDelayMs = Math.round(FRAME_INTERVAL_MS)
  for (let i = 0; i < rawFrames.length; i++) {
    const isTail = i === rawFrames.length - 1
    const indexed = applyPalette(rawFrames[i], globalPalette, 'rgba4444')
    gif.writeFrame(indexed, canvasWidth, canvasHeight, {
      palette: i === 0 ? globalPalette : undefined,
      // `first: true` on the opening frame writes the palette
      // as the GIF's global color table; subsequent frames
      // reuse it implicitly (no per-frame local color table).
      first: i === 0,
      delay: isTail ? tailHoldMs : baseDelayMs,
      transparent: false,
    })
    if (onProgress) {
      onProgress({
        ratio: 0.55 + (i + 1) / rawFrames.length * 0.42,
        label: 'encoding',
      })
    }
    if (i % 6 === 5) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  gif.finish()
  const bytes = gif.bytes()
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/gif' })
  const points = Math.max(0, Math.floor(snapshot.pointsGained))
  await saveOrShareGif(
    blob,
    buildFilename(snapshot),
    `Cubekill — Play of the Game (+${points})`,
  )
  if (onProgress) {
    onProgress({ ratio: 1, label: 'done' })
  }
}

/**
 * Render an ordered list of placements as a single animated GIF.
 * Each snapshot plays its full place-and-clear timeline back to
 * back; the last frame of each non-terminal snapshot is held for
 * a short beat so the eye can catch the score before the next
 * placement starts dropping in. The terminal snapshot's last
 * frame gets the same tail-hold as the single-snapshot exporter
 * so the GIF loop ends on a beat, not a snap.
 *
 * Shares all of the offscreen-canvas + global-palette machinery
 * with `captureHighlightReelAsGif`; the only difference is the
 * frame plan (per-snapshot timelines stitched together) and the
 * filename. Resolves once the download is triggered (or rejects
 * on a fatal encode error).
 */
export const captureMultiHighlightReelAsGif = async ({
  snapshots,
  onProgress,
}: CaptureMultiGifArgs): Promise<void> => {
  if (typeof window === 'undefined') {
    throw new Error('GIF export is browser-only')
  }
  if (snapshots.length === 0) {
    throw new Error('captureMultiHighlightReelAsGif called with no snapshots')
  }
  const gifenc = await import('gifenc')
  const { GIFEncoder, quantize, applyPalette } = gifenc

  if (typeof document !== 'undefined' && document.fonts?.load) {
    try {
      await document.fonts.load(`400 16px "Monoton"`)
      await document.fonts.load(`400 32px "Monoton"`)
      if (document.fonts.ready) {
        await document.fonts.ready
      }
    } catch {
      // Font failures shouldn't block — fallback is still readable.
    }
  }

  // All snapshots in a single run share `mode`, so the canvas
  // geometry is computed once. We also fall back to the first
  // snapshot's mode if a caller ever passes a mixed list — better
  // a slightly off rosette than a thrown error mid-export.
  const layout = layoutForMode(snapshots[0].mode)
  const pixelScale = (OUTPUT_HEIGHT - OUTPUT_PADDING * 2) / layout.height
  const canvasWidth = Math.round(layout.width * pixelScale + OUTPUT_PADDING * 2)
  const canvasHeight = OUTPUT_HEIGHT

  const renderCanvas = document.createElement('canvas')
  renderCanvas.width = canvasWidth * RENDER_SCALE
  renderCanvas.height = canvasHeight * RENDER_SCALE
  const renderCtx = renderCanvas.getContext('2d')
  if (!renderCtx) {
    throw new Error('Could not acquire render 2D context')
  }
  renderCtx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0)

  const canvas = document.createElement('canvas')
  canvas.width = canvasWidth
  canvas.height = canvasHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    throw new Error('Could not acquire 2D context')
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // Build one RenderContext per snapshot so the per-frame render
  // loop just indexes in.
  const contexts: RenderContext[] = snapshots.map((s) => ({
    snapshot: s,
    layout,
    clearingClasses: computeClearingClasses(s),
    placedSet: new Set(s.placedCellIds),
    clearingSet: new Set(s.clearedCellIds),
    pixelScale,
    canvasWidth,
    canvasHeight,
  }))

  // Frame plan. Rather than duplicate "hold" frames between
  // snapshots (which would inflate the GIF), we render exactly
  // one frame per timestep and let the GIF `delay` field hold
  // the last frame of each segment for an extended beat.
  const tailHoldMs = 700
  const interSnapshotGapMs = 220
  const baseDelayMs = Math.round(FRAME_INTERVAL_MS)
  const framesPerSnapshot = Math.ceil(PHASE_TOTAL_MS / FRAME_INTERVAL_MS)
  type FramePlan = { sIdx: number; localT: number; delayMs: number }
  const plan: FramePlan[] = []
  for (let s = 0; s < snapshots.length; s++) {
    for (let f = 0; f < framesPerSnapshot; f++) {
      const isLastFrameOfSnapshot = f === framesPerSnapshot - 1
      const isLastSnapshot = s === snapshots.length - 1
      const delayMs = isLastFrameOfSnapshot
        ? isLastSnapshot
          ? tailHoldMs
          : interSnapshotGapMs
        : baseDelayMs
      plan.push({
        sIdx: s,
        localT: Math.min(PHASE_TOTAL_MS, f * FRAME_INTERVAL_MS),
        delayMs,
      })
    }
  }

  const rawFrames: Uint8ClampedArray[] = []
  for (let i = 0; i < plan.length; i++) {
    const { sIdx, localT } = plan[i]
    renderFrame(renderCtx, contexts[sIdx], localT)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight)
    ctx.drawImage(
      renderCanvas,
      0,
      0,
      renderCanvas.width,
      renderCanvas.height,
      0,
      0,
      canvasWidth,
      canvasHeight,
    )
    const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight)
    rawFrames.push(new Uint8ClampedArray(imageData.data))
    if (onProgress) {
      onProgress({
        ratio: (i + 1) / plan.length * 0.5,
        label: 'recording',
      })
    }
    if (i % 6 === 5) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  if (onProgress) {
    onProgress({ ratio: 0.55, label: 'encoding' })
  }

  const bytesPerFrame = canvasWidth * canvasHeight * 4
  const combined = new Uint8ClampedArray(bytesPerFrame * rawFrames.length)
  for (let i = 0; i < rawFrames.length; i++) {
    combined.set(rawFrames[i], i * bytesPerFrame)
  }
  const globalPalette = quantize(combined, MAX_PALETTE_COLORS, {
    format: 'rgba4444',
  })

  const gif = GIFEncoder()
  for (let i = 0; i < rawFrames.length; i++) {
    const indexed = applyPalette(rawFrames[i], globalPalette, 'rgba4444')
    gif.writeFrame(indexed, canvasWidth, canvasHeight, {
      palette: i === 0 ? globalPalette : undefined,
      first: i === 0,
      delay: plan[i].delayMs,
      transparent: false,
    })
    if (onProgress) {
      onProgress({
        ratio: 0.55 + (i + 1) / rawFrames.length * 0.42,
        label: 'encoding',
      })
    }
    if (i % 6 === 5) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  gif.finish()
  const bytes = gif.bytes()
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/gif' })
  await saveOrShareGif(
    blob,
    buildMultiFilename(snapshots),
    `Cubekill — Last ${snapshots.length} moves`,
  )
  if (onProgress) {
    onProgress({ ratio: 1, label: 'done' })
  }
}
