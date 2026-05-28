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
  // When false, hides the "Watch again" / "Download GIF" action row.
  // Used by the multi-snapshot reel, which owns its own controls
  // and would render a confusingly-redundant action row otherwise.
  // Defaults to true (the standalone end-of-run modal needs them).
  showActions?: boolean
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

export const HighlightReel = ({
  snapshot,
  caption,
  showActions = true,
}: HighlightReelProps) => {
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
        {showActions && (
          /* Action pills float in the reel's bottom-right corner so
             they don't add a stacked row of vertical chrome to the
             host modal. The replay button stays a simple icon; the
             download button widens to surface progress text when
             encoding so the player still gets feedback even with
             the smaller footprint. */
          <div className="hexaclear-reel-overlay-actions">
            <button
              type="button"
              className="hexaclear-reel-replay"
              onClick={replay}
              aria-label="Watch best placement again"
              title="Watch again"
              disabled={isExportingGif}
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                width="14"
                height="14"
              >
                <path
                  d="M20 8a8 8 0 1 0 1.9 7.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                />
                <path
                  d="M21 3v6h-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className={[
                'hexaclear-reel-download',
                gifProgress !== null ? 'is-progress' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={downloadGif}
              aria-label="Download best placement as GIF"
              title="Download GIF"
              disabled={isExportingGif}
            >
              {gifProgress === null ? (
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  width="14"
                  height="14"
                >
                  <path
                    d="M12 4v11"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                  />
                  <path
                    d="M6 11l6 6 6-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M5 20h14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <span className="hexaclear-reel-overlay-progress">
                  {gifProgress.label === 'recording'
                    ? `${Math.round(gifProgress.ratio * 100)}%`
                    : gifProgress.label === 'encoding'
                      ? 'Saving…'
                      : 'Saved'}
                </span>
              )}
            </button>
          </div>
        )}
      </div>
      {caption !== undefined && caption !== '' && (
        <div className="hexaclear-reel-caption">{caption}</div>
      )}
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

// Cap on the rolling per-run move history kept for the pause-menu
// "Export recent moves" tool. Tuned to comfortably exceed the
// stepper's maximum (so we always have room to honour the player's
// chosen N) without growing without bound during a long endless
// session. Each entry is a RunHighlightSnapshot, a few hundred
// bytes of cell ids + a board copy.
// eslint-disable-next-line react-refresh/only-export-components
export const RUN_HISTORY_MAX = 25

// Stepper ceiling for the "Export recent moves as GIF" modal.
// Picked to keep file size reasonable: at ~30fps × 1.35s/snapshot
// × ~600px the 10-snapshot export tops out around 4–5MB before
// the global-palette pass compresses it. Going higher inflates
// the file faster than the visual payoff justifies.
// eslint-disable-next-line react-refresh/only-export-components
export const RUN_HISTORY_EXPORT_MAX = 10

// Beat between consecutive snapshots in the multi-reel preview.
// Short enough that the loop feels continuous, long enough to let
// the cleared cells settle before the next placement starts
// dropping in.
const MULTI_REEL_GAP_MS = 220

type MultiHighlightReelProps = {
  // Ordered list of placements to replay, oldest → newest. The
  // multi-reel cycles through them one at a time and loops back
  // to the start when the last one finishes.
  snapshots: RunHighlightSnapshot[]
  // Render-only mode: drops the embedded "Download GIF" action
  // and leaves it to the host modal to render its own download
  // button (the host already has the snapshot list and the
  // progress state, so duplicating the affordance here would be
  // out of sync).
  caption?: string
}

// Multi-placement preview. Wraps the single-snapshot
// `<HighlightReel>` and advances `currentIndex` on a timer, using
// a key change to remount the inner reel each cycle so its CSS
// keyframes re-fire from the top. Loops indefinitely while
// mounted — the host modal owns dismiss / count changes.
export const MultiHighlightReel = ({
  snapshots,
  caption,
}: MultiHighlightReelProps) => {
  const [currentIndex, setCurrentIndex] = useState(0)

  // Reset to the first snapshot whenever the list changes by
  // *content* (e.g. the player ticks the stepper up/down in the
  // export modal). We compare by content-derived signature, not
  // by reference, because callers commonly compute the snapshot
  // list inline (`history.slice(-N)`) — a new reference every
  // render that has the same contents shouldn't restart the
  // preview from the top.
  const snapshotsSignature = `${snapshots.length}:${snapshots
    .map((s) => `${s.placedCellIds.join('|')}:${s.pointsGained}`)
    .join(',')}`
  useEffect(() => {
    setCurrentIndex(0)
  }, [snapshotsSignature])

  // Advance to the next snapshot after each cycle. Re-armed on
  // every index change so the timing stays consistent even if the
  // host pauses / re-mounts us. Depends on the signature, not the
  // raw `snapshots` reference, for the same parent-recompute
  // reason called out above — depending on the raw reference would
  // cause every parent render to cancel and re-arm the timer,
  // making the preview look frozen.
  useEffect(() => {
    if (snapshots.length <= 1) return
    const id = window.setTimeout(() => {
      setCurrentIndex((idx) => (idx + 1) % snapshots.length)
    }, PHASE_TOTAL_MS + MULTI_REEL_GAP_MS)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotsSignature, currentIndex])

  if (snapshots.length === 0) {
    return (
      <div className="hexaclear-reel hexaclear-multi-reel hexaclear-multi-reel-empty">
        Play a few pieces first, then come back to export a clip.
      </div>
    )
  }

  // Index clamp: snapshots[] can shrink between renders if the
  // host's stepper drops below the current index — fall back to
  // the last available frame rather than crash with undefined.
  const safeIndex = Math.min(currentIndex, snapshots.length - 1)
  const current = snapshots[safeIndex]
  const total = snapshots.length
  const defaultCaption =
    total === 1
      ? `1 move · +${current.pointsGained}`
      : `Move ${safeIndex + 1} of ${total} · +${current.pointsGained}`

  return (
    <div className="hexaclear-multi-reel">
      <HighlightReel
        // The key change is what remounts the inner reel so its
        // phase machine fires cleanly for each snapshot. Without
        // it the next snapshot would inherit the previous
        // snapshot's `phase === 'cleared'` final state and skip
        // the place-and-clear animation entirely.
        key={`${safeIndex}-${total}`}
        snapshot={current}
        caption={caption ?? defaultCaption}
        showActions={false}
      />
    </div>
  )
}
