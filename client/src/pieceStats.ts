// Per-piece-variant stats ("Piecetiary stats").
//
// Lightweight, retrospective per-rotation counters that surface on
// the Piecetiary tile detail view. Designed to feel like memory
// ("Layla has ended 12 runs") rather than goals to chase, so all
// flavor copy is phrased retrospectively and no count is exposed as
// a target.
//
// Local-first, mirrored silently into the player's account when
// they're signed in (see `calculatePieceStatsSyncDelta` below and
// the matching server-side merge in `convex/accountStats.ts`). The
// sync is invisible — there's no UI affordance for it — but means
// a player who signs in on a new device finds their accumulated
// piece history waiting.

import { ALL_PIECE_VARIANTS } from './game/pieces'
import type { PieceVariant } from './game/pieces'

export type PieceVariantStats = {
  /** Total times this variant has been placed on the board. */
  timesPlayed: number
  /** Placements that cleared one or more patterns. */
  clearsCaused: number
  /** Placements that cleared two or more patterns (i.e. combos). */
  combosJoined: number
  /** Placements that emptied the entire board. */
  boardClears: number
  /** Rubies cleared on placements of this variant. */
  rubiesCaptured: number
  /**
   * Sum of **clear bonus** points across every placement of this
   * variant. NOT the full score contribution — the per-cube
   * placement points (always `variant.size` per play) are derived
   * at read time so old saves don't need a migration. See
   * `averagePoints` for the conversion.
   */
  totalPointsGained: number
  /** Single highest pointsGained on a placement of this variant. */
  bestClear: number
  /**
   * "Killing hand" credit: incremented for every variant still in
   * the player's hand (or held buffer) at the moment a run ends.
   * Each variant gets credit at most once per game-over — if two
   * pieces of the same variant are still in hand, only one credit
   * is awarded.
   */
  killingHands: number
}

export type PieceStatsMap = Record<string, PieceVariantStats>

export const PIECE_STATS_STORAGE_KEY = 'cubic-piece-stats-v1'

export const emptyPieceVariantStats = (): PieceVariantStats => ({
  timesPlayed: 0,
  clearsCaused: 0,
  combosJoined: 0,
  boardClears: 0,
  rubiesCaptured: 0,
  totalPointsGained: 0,
  bestClear: 0,
  killingHands: 0,
})

// Coerce a parsed entry into a sanitized PieceVariantStats record.
// Used by `loadPieceStats` so a partial or malformed entry doesn't
// poison the whole map.
const sanitizePieceVariantStats = (raw: unknown): PieceVariantStats => {
  const base = emptyPieceVariantStats()
  if (!raw || typeof raw !== 'object') return base
  const partial = raw as Partial<Record<keyof PieceVariantStats, unknown>>
  const num = (value: unknown): number => {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  }
  return {
    timesPlayed: num(partial.timesPlayed),
    clearsCaused: num(partial.clearsCaused),
    combosJoined: num(partial.combosJoined),
    boardClears: num(partial.boardClears),
    rubiesCaptured: num(partial.rubiesCaptured),
    totalPointsGained: num(partial.totalPointsGained),
    bestClear: num(partial.bestClear),
    killingHands: num(partial.killingHands),
  }
}

// Best-effort loader. Same shape as `loadLifetimeStats`: any failure
// (parse error, malformed payload) returns an empty map so the rest
// of the app keeps running. Only the variant ids that exist today
// are kept; unknown ids (e.g. removed in a later release) are
// dropped silently.
export const loadPieceStats = (): PieceStatsMap => {
  try {
    if (typeof window === 'undefined') return {}
    const raw = window.localStorage.getItem(PIECE_STATS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const knownIds = new Set(ALL_PIECE_VARIANTS.map((v) => v.id))
    const out: PieceStatsMap = {}
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!knownIds.has(key)) continue
      out[key] = sanitizePieceVariantStats(value)
    }
    return out
  } catch {
    return {}
  }
}

export const savePieceStats = (map: PieceStatsMap): void => {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(
      PIECE_STATS_STORAGE_KEY,
      JSON.stringify(map),
    )
  } catch {
    // Quota exceeded / private browsing — best effort, drop the write.
  }
}

// Convenience: fetch a stats entry from the map, defaulting to a
// zeroed record. Doesn't mutate the map. Used by the UI to read
// stats for any variant without needing the caller to check
// presence first.
export const getPieceStats = (
  map: PieceStatsMap,
  variantId: string,
): PieceVariantStats => map[variantId] ?? emptyPieceVariantStats()

const cloneEntry = (entry: PieceVariantStats): PieceVariantStats => ({
  ...entry,
})

const upsert = (
  map: PieceStatsMap,
  variantId: string,
  patch: (entry: PieceVariantStats) => PieceVariantStats,
): PieceStatsMap => {
  const current = map[variantId] ?? emptyPieceVariantStats()
  return {
    ...map,
    [variantId]: patch(cloneEntry(current)),
  }
}

export type ApplyPiecePlacementArgs = {
  variantId: string
  pointsGained: number
  patternsClearedCount: number
  rubiesCleared: number
  boardCleared: boolean
}

export const applyPlacementToPieceStats = (
  map: PieceStatsMap,
  args: ApplyPiecePlacementArgs,
): PieceStatsMap =>
  upsert(map, args.variantId, (entry) => ({
    ...entry,
    timesPlayed: entry.timesPlayed + 1,
    totalPointsGained: entry.totalPointsGained + Math.max(0, args.pointsGained),
    bestClear: Math.max(entry.bestClear, args.pointsGained),
    clearsCaused:
      entry.clearsCaused + (args.patternsClearedCount > 0 ? 1 : 0),
    combosJoined:
      entry.combosJoined + (args.patternsClearedCount >= 2 ? 1 : 0),
    boardClears: entry.boardClears + (args.boardCleared ? 1 : 0),
    rubiesCaptured: entry.rubiesCaptured + Math.max(0, args.rubiesCleared),
  }))

// At game-over, credit every variant still sitting in the player's
// hand + held buffer with one "killing hand". Caller passes the
// flattened list of variant ids; we dedupe internally so a hand of
// three of the same variant only earns one credit.
export const applyGameOverToPieceStats = (
  map: PieceStatsMap,
  remainingVariantIds: string[],
): PieceStatsMap => {
  if (remainingVariantIds.length === 0) return map
  const deduped = Array.from(new Set(remainingVariantIds))
  let next = map
  for (const variantId of deduped) {
    next = upsert(next, variantId, (entry) => ({
      ...entry,
      killingHands: entry.killingHands + 1,
    }))
  }
  return next
}

// Average score per play, in real game-board points. Every
// placement of an N-cube variant scores at least N (the placement
// points awarded for putting cubes on the board), plus any clear
// bonus. `totalPointsGained` only accumulates the clear bonus —
// so we add `variant.size` here to surface the actual per-play
// average without needing to backfill historical saves.
export const averagePoints = (
  stats: PieceVariantStats,
  variant: PieceVariant,
): number => {
  if (stats.timesPlayed === 0) return 0
  const bonusAvg = stats.totalPointsGained / stats.timesPlayed
  return Math.round(bonusAvg + variant.size)
}

// =============================================================
// Account-sync helpers
// -------------------------------------------------------------
// Piece stats follow the same delta-based sync model as the
// lifetime stats: keep a baseline of "what the server last knew",
// upload the per-counter delta on sync, and the server reconciles
// by additive merge (counters) or max (bests). No UI surface —
// this is purely background sync behind the "Sync stats" account
// action that's already in the menu.
// =============================================================

const baselineKey = (accountId: string): string =>
  `cubic-piece-stats-sync-baseline-${accountId}`

// Per-account baseline of what the server already has. Used to
// compute the delta to upload on the next sync. Same shape as the
// live PieceStatsMap so we can reuse loadPieceStats's sanitizer
// without diverging the format.
export const loadPieceStatsSyncBaseline = (
  accountId: string,
): PieceStatsMap => {
  try {
    if (typeof window === 'undefined') return {}
    const raw = window.localStorage.getItem(baselineKey(accountId))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const knownIds = new Set(ALL_PIECE_VARIANTS.map((v) => v.id))
    const out: PieceStatsMap = {}
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!knownIds.has(key)) continue
      out[key] = sanitizePieceVariantStats(value)
    }
    return out
  } catch {
    return {}
  }
}

export const savePieceStatsSyncBaseline = (
  accountId: string,
  map: PieceStatsMap,
): void => {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(baselineKey(accountId), JSON.stringify(map))
  } catch {
    // Quota / private mode — best-effort, sync will just re-send
    // the same delta next time without harm.
  }
}

const positive = (n: number): number =>
  Number.isFinite(n) && n > 0 ? Math.floor(n) : 0

// Pure: compute (current - baseline) per variant per counter.
// Counters use saturating subtraction (max(0, ...)) and bests
// use max(current, baseline) → 0 if not improved, so a one-shot
// delta upload can be merged additively on the server without
// double-counting.
export const calculatePieceStatsSyncDelta = (
  current: PieceStatsMap,
  baseline: PieceStatsMap,
): PieceStatsMap => {
  const out: PieceStatsMap = {}
  for (const [variantId, cur] of Object.entries(current)) {
    const base = baseline[variantId] ?? emptyPieceVariantStats()
    const entry: PieceVariantStats = {
      timesPlayed: positive(cur.timesPlayed - base.timesPlayed),
      clearsCaused: positive(cur.clearsCaused - base.clearsCaused),
      combosJoined: positive(cur.combosJoined - base.combosJoined),
      boardClears: positive(cur.boardClears - base.boardClears),
      rubiesCaptured: positive(cur.rubiesCaptured - base.rubiesCaptured),
      totalPointsGained: positive(
        cur.totalPointsGained - base.totalPointsGained,
      ),
      bestClear: cur.bestClear > base.bestClear ? cur.bestClear : 0,
      killingHands: positive(cur.killingHands - base.killingHands),
    }
    // Skip entries that have no actual delta so the upload payload
    // stays small (44 variants × 8 counters of zeros adds up).
    if (
      entry.timesPlayed === 0 &&
      entry.clearsCaused === 0 &&
      entry.combosJoined === 0 &&
      entry.boardClears === 0 &&
      entry.rubiesCaptured === 0 &&
      entry.totalPointsGained === 0 &&
      entry.bestClear === 0 &&
      entry.killingHands === 0
    ) {
      continue
    }
    out[variantId] = entry
  }
  return out
}

// Server-side merge contract, mirrored locally so a successful
// sync returning the post-merge totals can be applied to local
// state and used as the new baseline in one step. The server
// implementation in `convex/accountStats.ts` MUST match this
// shape — additive for counters, max for `bestClear`.
export const mergePieceStatsMaps = (
  a: PieceStatsMap,
  b: PieceStatsMap,
): PieceStatsMap => {
  const out: PieceStatsMap = {}
  const ids = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const id of ids) {
    const left = a[id] ?? emptyPieceVariantStats()
    const right = b[id] ?? emptyPieceVariantStats()
    out[id] = {
      timesPlayed: left.timesPlayed + right.timesPlayed,
      clearsCaused: left.clearsCaused + right.clearsCaused,
      combosJoined: left.combosJoined + right.combosJoined,
      boardClears: left.boardClears + right.boardClears,
      rubiesCaptured: left.rubiesCaptured + right.rubiesCaptured,
      totalPointsGained: left.totalPointsGained + right.totalPointsGained,
      bestClear: Math.max(left.bestClear, right.bestClear),
      killingHands: left.killingHands + right.killingHands,
    }
  }
  return out
}
