// End-of-run highlight reel.
//
// The game tracks the single highest-scoring placement of each run
// (a "snapshot" captured at placement time) and surfaces it on the
// gameover modal as a small auto-playing replay. The replay is not
// a video — we re-render the pre-placement board state, drop the
// piece in, and animate the cleared cells the same way the live
// board does (using the shared `clearing-line` / `clearing-flower`
// CSS classes).
//
// This module deliberately uses a simplified renderer (flat hex
// tiles + scaled cube glyphs) rather than the production board so
// the reel stays small (~140-160px tall), self-contained, and
// theme-agnostic. The point of the reel is to remind the player of
// the moment, not to perfectly reproduce the visuals.

import { useCallback, useEffect, useRef, useState } from 'react'

import { getBoardDefinitionForMode } from './game/boardDefinition'
import type { GameMode, BoardState } from './game/gameLogic'
import type { CellId, Pattern } from './game/hexTypes'
import { captureHighlightReelAsGif } from './highlightReelGif'
import type { CaptureProgress } from './highlightReelGif'

// Geometry. Smaller than the main board's HEX_SIZE = 32 so the whole
// rosette fits comfortably in a modal-sized panel without forcing
// the user to scroll. The aspect ratio of the SVG is driven by the
// board itself.
const HEX_SIZE = 14
const HEX_W = HEX_SIZE * Math.sqrt(3)
const HEX_H = HEX_SIZE * 2

const axialToPixel = (q: number, r: number) => ({
  x: HEX_W * (q + r / 2),
  y: HEX_H * (r * 0.75),
})

const buildHexPoints = (cx: number, cy: number): string => {
  const points: string[] = []
  for (let i = 0; i < 6; i++) {
    const angleRad = ((60 * i - 30) * Math.PI) / 180
    const x = cx + HEX_SIZE * Math.cos(angleRad)
    const y = cy + HEX_SIZE * Math.sin(angleRad)
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`)
  }
  return points.join(' ')
}

// Snapshot of "the single best placement of this run". Captured at
// the moment of placement; rendered later when the gameover modal
// opens. Carries everything the reel needs to recompose the
// before/after state without re-running game logic.
export type RunHighlightSnapshot = {
  mode: GameMode
  // Board cells as they were the instant *before* the placement
  // landed. The reel renders this state first, then animates the
  // piece dropping in and the clears playing out.
  boardBefore: BoardState
  // Cell ids occupied by the placed piece (post-placement
  // footprint). Drawn as "freshly placed" cubes during phase 2.
  placedCellIds: CellId[]
  // Cell ids that participated in any clear caused by this
  // placement. Driven by the same animation classes the live
  // board uses so the timing/feel match.
  clearedCellIds: CellId[]
  // Patterns that cleared, used to drive per-cell animation
  // classes (line stagger vs flower center/ring). Trimmed to just
  // the fields the reel needs so we don't drag the full game
  // pattern type through localStorage if we ever persist this.
  clearedPatterns: Array<{
    type: 'line' | 'flower'
    cellIds: CellId[]
  }>
  // Points awarded by this single placement. Drives the headline
  // chip ("Best clear · +N points"). Doesn't include any
  // streak/tier multipliers beyond what the engine already
  // reported as `pointsGained`.
  pointsGained: number
  // True when this placement also cleared the entire board.
  // Reserved for a future flourish; not used by the MVP renderer.
  causedBoardClear: boolean
}

// Build a one-shot snapshot from the data already on hand inside
// the placement reducer. Pure factory; caller decides whether to
// keep it (i.e. compare its pointsGained against the current best).
// eslint-disable-next-line react-refresh/only-export-components
export const createHighlightSnapshot = (args: {
  mode: GameMode
  boardBefore: BoardState
  placedCellIds: CellId[]
  clearedCellIds: CellId[]
  clearedPatterns: Pattern[]
  pointsGained: number
  causedBoardClear: boolean
}): RunHighlightSnapshot => ({
  mode: args.mode,
  // Shallow copy the board so a later mutation of the live
  // game.board can't retroactively corrupt the snapshot.
  boardBefore: { ...args.boardBefore },
  placedCellIds: [...args.placedCellIds],
  clearedCellIds: [...args.clearedCellIds],
  clearedPatterns: args.clearedPatterns.map((p) => ({
    type: p.type,
    cellIds: [...p.cellIds],
  })),
  pointsGained: args.pointsGained,
  causedBoardClear: args.causedBoardClear,
})

// Phase timing. Phase 1 holds the pre-placement state so the player
// gets a beat to register what the board looked like; phase 2 pops
// the placed piece into view; phase 3 lets the clearing animation
// run. Total target ~1.6s, well within the doc's 1.5-2s window.
// Re-exported so the canvas-based GIF exporter can drive its
// frame timeline from the exact same numbers the live reel uses;
// drifting them would make exported GIFs feel different from the
// on-screen replay.
// eslint-disable-next-line react-refresh/only-export-components
export const PHASE_PLACE_MS = 350
// eslint-disable-next-line react-refresh/only-export-components
export const PHASE_CLEAR_MS = 720
// eslint-disable-next-line react-refresh/only-export-components
export const PHASE_TOTAL_MS = PHASE_PLACE_MS + PHASE_CLEAR_MS + 280
// The React effect that drives the on-screen phase progression
// uses this delay before flipping to "placed". The GIF exporter
// mirrors it so the captured `t=0..PHASE_PLACE_TRIGGER_MS` frames
// show the pre-placement board, matching the live reel.
// eslint-disable-next-line react-refresh/only-export-components
export const PHASE_PLACE_TRIGGER_MS = Math.max(40, PHASE_PLACE_MS * 0.4)

type ReelPhase = 'idle' | 'before' | 'placed' | 'cleared'

// eslint-disable-next-line react-refresh/only-export-components
export type ReelLayout = ReturnType<typeof layoutForMode>

// eslint-disable-next-line react-refresh/only-export-components
export const HEX_GEOMETRY = { HEX_SIZE, HEX_W, HEX_H } as const

// eslint-disable-next-line react-refresh/only-export-components
export const layoutForMode = (mode: GameMode) => {
  const boardDef = getBoardDefinitionForMode(mode)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  const positions: Record<CellId, { x: number; y: number }> = {}
  for (const cell of boardDef.cells) {
    const { x, y } = axialToPixel(cell.coord.q, cell.coord.r)
    positions[cell.id] = { x, y }
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const padding = HEX_SIZE * 1.4
  const offsetX = -minX + padding
  const offsetY = -minY + padding
  const width = maxX - minX + padding * 2
  const height = maxY - minY + padding * 2
  return { boardDef, positions, width, height, offsetX, offsetY }
}

type HighlightReelProps = {
  snapshot: RunHighlightSnapshot
  // Optional caption override; defaults to "Best clear · +N points".
  // Empty string suppresses the caption entirely (useful if the
  // surrounding modal already labels the panel).
  caption?: string
}

// Per-cell clearing classes for a snapshot. The line-clear cascade
// uses each cleared pattern's `cellIds` order to stagger cells via
// `clearing-line-step-N`. Flower clears split into a `center` (the
// pattern's first id) and `ring` (the rest). Exposed so the GIF
// exporter can resolve each cell's clear-step delay without
// duplicating the snapshot-walking logic.
// eslint-disable-next-line react-refresh/only-export-components
export const computeClearingClasses = (
  snapshot: RunHighlightSnapshot,
): Record<CellId, string[]> => {
  const out: Record<CellId, string[]> = {}
  for (const pattern of snapshot.clearedPatterns) {
    if (pattern.type === 'line') {
      pattern.cellIds.forEach((cellId, idx) => {
        ;(out[cellId] ||= []).push(
          'clearing-line',
          `clearing-line-step-${idx}`,
        )
      })
    } else {
      const centerId = pattern.cellIds[0]
      for (const cellId of pattern.cellIds) {
        ;(out[cellId] ||= []).push(
          cellId === centerId
            ? 'clearing-flower-center'
            : 'clearing-flower-ring',
        )
      }
    }
  }
  return out
}

export const HighlightReel = ({ snapshot, caption }: HighlightReelProps) => {
  const layout = layoutForMode(snapshot.mode)
  const placedSet = new Set(snapshot.placedCellIds)
  const clearingSet = new Set(snapshot.clearedCellIds)

  // Per-cell animation classes that mirror the live board: lines
  // stagger their cells by index for the wipe; flower centers vs
  // rings get different roles for the burst. Shared with the GIF
  // exporter via `computeClearingClasses` so both renderers stay
  // in lockstep — drift here would make exported GIFs reorder
  // clears relative to the on-screen replay.
  const clearingClasses = computeClearingClasses(snapshot)

  const [phase, setPhase] = useState<ReelPhase>('before')
  // Token bumps each time the player taps "Watch again" so React
  // remounts the animated cubes and re-fires their CSS keyframes.
  const [playToken, setPlayToken] = useState(0)
  const timeoutsRef = useRef<number[]>([])
  // GIF export progress, gating the "Download GIF" button's label
  // and disabling re-entrant clicks. Null = idle. The exporter
  // re-renders the snapshot into an offscreen canvas, so we don't
  // need a DOM ref to the on-screen reel here.
  const [gifProgress, setGifProgress] = useState<CaptureProgress | null>(null)
  const isExportingGif = gifProgress !== null && gifProgress.label !== 'done'

  const replay = useCallback(() => {
    setPlayToken((t) => t + 1)
  }, [])

  const downloadGif = useCallback(async () => {
    if (isExportingGif) return
    setGifProgress({ ratio: 0, label: 'recording' })
    try {
      await captureHighlightReelAsGif({
        snapshot,
        onProgress: setGifProgress,
      })
    } catch {
      // Best-effort; reset the button state and let the player
      // try again. Errors are silent on purpose — a failed
      // export is annoying, but a modal dialog about it would
      // be worse.
      setGifProgress(null)
      return
    }
    // After "Saved!" lingers visibly for a beat, snap back to idle.
    setTimeout(() => setGifProgress(null), 1500)
  }, [isExportingGif, snapshot])

  // Schedule the phase progression. Cleared timeouts are stored so
  // a re-run or unmount cancels the in-flight timers cleanly.
  useEffect(() => {
    timeoutsRef.current.forEach((id) => window.clearTimeout(id))
    timeoutsRef.current = []
    setPhase('before')
    const t1 = window.setTimeout(
      () => setPhase('placed'),
      Math.max(40, PHASE_PLACE_MS * 0.4),
    )
    const t2 = window.setTimeout(
      () => setPhase('cleared'),
      PHASE_PLACE_MS,
    )
    timeoutsRef.current.push(t1, t2)
    return () => {
      timeoutsRef.current.forEach((id) => window.clearTimeout(id))
      timeoutsRef.current = []
    }
  }, [playToken])

  const showPlaced = phase === 'placed' || phase === 'cleared'
  const showClearing = phase === 'cleared'

  return (
    <div className="hexaclear-reel" aria-label="Best-placement replay">
      <div className="hexaclear-reel-board-wrap">
        {/* The CUBEKILL.FUN watermark is intentionally only
            drawn into the saved GIF (see highlightReelGif.ts).
            On-screen, the reel sits inside the end-of-run modal
            where the player already knows what app they're in;
            stamping the brand here would just clutter the
            replay. */}
        <svg
          key={playToken}
          className="hexaclear-reel-svg"
          viewBox={`0 0 ${layout.width.toFixed(1)} ${layout.height.toFixed(1)}`}
          role="img"
          aria-label={`Replay of best placement, worth ${snapshot.pointsGained} points`}
        >
          {layout.boardDef.cells.map((cell) => {
            const pos = layout.positions[cell.id]
            const cx = pos.x + layout.offsetX
            const cy = pos.y + layout.offsetY
            const points = buildHexPoints(cx, cy)
            const wasFilledBefore =
              snapshot.boardBefore[cell.id] === 'filled'
            const isPlacedFootprint = placedSet.has(cell.id)
            const isClearing =
              showClearing && clearingSet.has(cell.id)
            const cellClasses = isClearing
              ? clearingClasses[cell.id] ?? []
              : []
            // A cell renders as "filled" if it was filled before
            // (still standing pre-clear) OR it just got placed and
            // we're past the "before" phase. Clearing cells still
            // render as filled until the keyframe finishes shrinking
            // them — the `clearing-line` CSS scales them out.
            const fillNow =
              isClearing ||
              (wasFilledBefore && !isClearing) ||
              (isPlacedFootprint && showPlaced)

            return (
              <g
                key={cell.id}
                className={[
                  'hexaclear-reel-cell',
                  fillNow ? 'is-filled' : 'is-empty',
                  isPlacedFootprint && showPlaced && !isClearing
                    ? 'is-placed-now'
                    : '',
                  ...cellClasses,
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <polygon
                  points={points}
                  className="hexaclear-reel-hex"
                />
                {fillNow && (
                  <polygon
                    points={points}
                    className="hexaclear-reel-cube"
                  />
                )}
              </g>
            )
          })}
        </svg>
        {showClearing && snapshot.pointsGained > 0 && (
          <span
            key={`points-${playToken}`}
            className="hexaclear-reel-points"
            aria-hidden="true"
          >
            +{snapshot.pointsGained}
          </span>
        )}
      </div>
      {caption !== '' && (
        <div className="hexaclear-reel-caption">
          {caption ?? `Best clear · +${snapshot.pointsGained} points`}
        </div>
      )}
      <div className="hexaclear-reel-actions">
        <button
          type="button"
          className="hexaclear-reel-replay"
          onClick={replay}
          aria-label="Watch best placement again"
          disabled={isExportingGif}
        >
          Watch again
        </button>
        <button
          type="button"
          className="hexaclear-reel-download"
          onClick={downloadGif}
          aria-label="Download best placement as GIF"
          disabled={isExportingGif}
        >
          {gifProgress?.label === 'recording'
            ? `Recording… ${Math.round(gifProgress.ratio * 100)}%`
            : gifProgress?.label === 'encoding'
              ? 'Encoding…'
              : gifProgress?.label === 'done'
                ? 'Saved!'
                : 'Download GIF'}
        </button>
      </div>
    </div>
  )
}

// Total reel runtime in ms, exported so the host can decide how
// long to keep an auto-advance hold (e.g. spectator carousel) before
// moving on. The MVP modal doesn't auto-advance — it just shows the
// reel inline and lets the player tap "Watch again" — but we keep
// this exported so future spectator UIs don't have to guess.
// eslint-disable-next-line react-refresh/only-export-components
export const HIGHLIGHT_REEL_DURATION_MS = PHASE_TOTAL_MS

// Used by the host: when computing whether to capture a new
// snapshot from a placement, this constant defines the minimum
// pointsGained worth considering. Below this it's not really a
// "best moment" — it's just a tiny clear. Default 1: any
// scoring placement is eligible at first, then the host's
// monotonic max keeps the snapshot's bar rising.
// eslint-disable-next-line react-refresh/only-export-components
export const HIGHLIGHT_REEL_MIN_POINTS = 1
