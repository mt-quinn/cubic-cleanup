// Per-device stats: a per-run accumulator surfaced on the gameover
// modal, plus a lifetime profile rolled up across every run (each
// gameover folds the run's totals into the lifetime ones). All of
// it is local-only — there is no server mirror — and we deliberately
// do NOT backfill on first encounter so per-game averages aren't
// skewed by historical runs we couldn't actually measure.

import type { PieceStatsMap } from './pieceStats'
import {
  calculatePieceStatsSyncDelta,
  loadPieceStats,
  loadPieceStatsSyncBaseline,
} from './pieceStats'

type GameModeId = 'endless' | 'daily' | 'big'

export type RunStats = {
  // ms timestamp the run started; used as the t0 for the wall-clock
  // version of duration (`Date.now() - startedAt`). The headline
  // duration we surface is `activePlayMs` instead, which only ticks
  // while the game is actually being played.
  startedAt: number
  activePlayMs: number
  piecesPlaced: number
  cubesPlaced: number
  patternsCleared: number
  rubiesCleared: number
  boardClears: number
  // Max simultaneous patterns cleared in any one placement of this
  // run. A "1" means no multi-clear ever landed.
  bestCombo: number
  // Highest streak count reached in this run (the live streak ticks
  // up by 1 for each clearing placement and resets to 0 on a
  // non-clearing placement).
  bestStreak: number
  // Highest single-placement points awarded in this run.
  topPlacementPoints: number
}

export type LifetimeStats = {
  // ms timestamp this stats record was first created on this device.
  // Used as the "tracking since" line on the profile modal.
  startedTrackingAt: number
  totalActivePlayMs: number
  gamesPlayedEndless: number
  gamesPlayedDaily: number
  gamesPlayedCoop: number
  // PvP territory-race totals. Wins counts matches this device won;
  // shames counts matches that ended with no winner (everyone stuck).
  gamesPlayedPvp: number
  pvpWins: number
  pvpShames: number
  piecesPlaced: number
  cubesPlaced: number
  patternsCleared: number
  rubiesCleared: number
  boardClears: number
  // Aggregate score for scored modes (endless, big, co-op). Daily is
  // move-ranked rather than score-ranked, so it does not contribute to
  // Score/game. PvP is a territory race, not a score race, so it
  // contributes neither — only its own per-mode counters above.
  totalScore: number
  scoredGamesPlayed: number
  // Records (single best across the whole device).
  bestEndlessScore: number
  // Daily ranks ascending by moves; null until the first daily clear.
  bestDailyMoves: number | null
  bestCombo: number
  bestStreak: number
  bestSinglePlacement: number
  // Most rubies cleared in a single run. Rubies only appear in
  // endless / big / co-op, so daily runs never advance this record.
  bestRubiesInRun: number
  longestRunMs: number
  // Unique daily date keys (YYYY-M-D) cleared and played-but-not-cleared.
  // Stored as arrays for JSON compatibility; treated as Sets in code.
  dailyDaysCleared: string[]
  dailyDaysPlayed: string[]
  // Distinct co-op partner playerIds (excluding self) the device has
  // finished a co-op run with.
  coopPartnerIds: string[]
  // Per-day best move count, keyed by the same `YYYY-M-D` date keys
  // dailyDaysCleared uses. Synced to the account so signing in on a
  // fresh device pulls in every cleared day's best — without this
  // the history calendar would only ever show local clears.
  dailyBestMovesByDate: Record<string, number>
  // Per-variant Piecetiary counters. Local-first on read; on every
  // account sync we attach a per-variant delta to the payload (see
  // `calculateStatsSyncDelta`) so signing in on a new device
  // pulls back the merged totals. Optional in the type because
  // accounts created before this field shipped won't carry it on
  // their first round-trip; treat `undefined` as `{}`.
  pieceStats?: PieceStatsMap
}

const STATS_KEY = 'cubic-stats-v1'
const STATS_SYNC_ACCOUNT_KEY = 'cubic-stats-sync-account-id'
const STATS_SYNC_LAST_AT_KEY = 'cubic-stats-sync-last-at'

const statsSyncBaselineKey = (accountId: string) =>
  `cubic-stats-sync-baseline-${accountId}`

export const createEmptyRunStats = (now: number = Date.now()): RunStats => ({
  startedAt: now,
  activePlayMs: 0,
  piecesPlaced: 0,
  cubesPlaced: 0,
  patternsCleared: 0,
  rubiesCleared: 0,
  boardClears: 0,
  bestCombo: 1,
  bestStreak: 0,
  topPlacementPoints: 0,
})

export const createEmptyLifetimeStats = (
  now: number = Date.now(),
): LifetimeStats => ({
  startedTrackingAt: now,
  totalActivePlayMs: 0,
  gamesPlayedEndless: 0,
  gamesPlayedDaily: 0,
  gamesPlayedCoop: 0,
  gamesPlayedPvp: 0,
  pvpWins: 0,
  pvpShames: 0,
  piecesPlaced: 0,
  cubesPlaced: 0,
  patternsCleared: 0,
  rubiesCleared: 0,
  boardClears: 0,
  totalScore: 0,
  scoredGamesPlayed: 0,
  bestEndlessScore: 0,
  bestDailyMoves: null,
  bestCombo: 1,
  bestStreak: 0,
  bestSinglePlacement: 0,
  bestRubiesInRun: 0,
  longestRunMs: 0,
  dailyDaysCleared: [],
  dailyDaysPlayed: [],
  coopPartnerIds: [],
  dailyBestMovesByDate: {},
  pieceStats: {},
})

// Coerce a parsed JSON value into a sanitized
// `dailyBestMovesByDate` map. Drops non-string keys and any value
// that isn't a finite positive integer so a malformed entry can't
// corrupt the calendar.
const sanitizeDailyBestMovesMap = (
  raw: unknown,
): Record<string, number> => {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0) continue
    const num = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(num) && num > 0) {
      out[key] = Math.floor(num)
    }
  }
  return out
}

// Defensive loader: any malformed payload (parse error, wrong type,
// missing field) collapses to a fresh stats record so the rest of
// the app never crashes on a corrupted localStorage entry.
export const loadLifetimeStats = (): LifetimeStats => {
  try {
    if (typeof window === 'undefined') return createEmptyLifetimeStats()
    const raw = window.localStorage.getItem(STATS_KEY)
    if (!raw) return createEmptyLifetimeStats()
    const parsed = JSON.parse(raw) as Partial<LifetimeStats>
    if (!parsed || typeof parsed !== 'object') return createEmptyLifetimeStats()
    const base = createEmptyLifetimeStats()
    return {
      ...base,
      ...parsed,
      // Re-coerce array fields so a legacy stringified value can't
      // pollute the runtime view.
      dailyDaysCleared: Array.isArray(parsed.dailyDaysCleared)
        ? parsed.dailyDaysCleared.filter((s) => typeof s === 'string')
        : [],
      dailyDaysPlayed: Array.isArray(parsed.dailyDaysPlayed)
        ? parsed.dailyDaysPlayed.filter((s) => typeof s === 'string')
        : [],
      coopPartnerIds: Array.isArray(parsed.coopPartnerIds)
        ? parsed.coopPartnerIds.filter((s) => typeof s === 'string')
        : [],
      dailyBestMovesByDate: sanitizeDailyBestMovesMap(
        parsed.dailyBestMovesByDate,
      ),
      // Piece stats live in their own localStorage key
      // (`cubic-piece-stats-v1`); we don't try to deserialize them
      // out of the lifetime payload. Keep the field absent here so
      // the sync-delta path is the only place this map gets
      // attached to a LifetimeStats payload.
      // Cap the started-tracking-at to a sane value: if the stored
      // value is in the future or wildly old, fall back to "now" so
      // the profile modal doesn't show "tracking since 1970" or
      // "tracking since next Tuesday".
      startedTrackingAt:
        typeof parsed.startedTrackingAt === 'number' &&
        parsed.startedTrackingAt > 0 &&
        parsed.startedTrackingAt <= Date.now() + 1000
          ? parsed.startedTrackingAt
          : base.startedTrackingAt,
    }
  } catch {
    return createEmptyLifetimeStats()
  }
}

export const saveLifetimeStats = (stats: LifetimeStats): void => {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(STATS_KEY, JSON.stringify(stats))
  } catch {
    // Quota exceeded / disabled storage / private browsing — silently
    // skip. Stats are best-effort.
  }
}

const parseLifetimeStats = (raw: string | null): LifetimeStats | null => {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LifetimeStats>
    if (!parsed || typeof parsed !== 'object') return null
    const base = createEmptyLifetimeStats()
    return {
      ...base,
      ...parsed,
      dailyDaysCleared: Array.isArray(parsed.dailyDaysCleared)
        ? parsed.dailyDaysCleared.filter((s) => typeof s === 'string')
        : [],
      dailyDaysPlayed: Array.isArray(parsed.dailyDaysPlayed)
        ? parsed.dailyDaysPlayed.filter((s) => typeof s === 'string')
        : [],
      coopPartnerIds: Array.isArray(parsed.coopPartnerIds)
        ? parsed.coopPartnerIds.filter((s) => typeof s === 'string')
        : [],
      dailyBestMovesByDate: sanitizeDailyBestMovesMap(
        parsed.dailyBestMovesByDate,
      ),
      startedTrackingAt:
        typeof parsed.startedTrackingAt === 'number' &&
        parsed.startedTrackingAt > 0 &&
        parsed.startedTrackingAt <= Date.now() + 1000
          ? parsed.startedTrackingAt
          : base.startedTrackingAt,
    }
  } catch {
    return null
  }
}

export const loadStatsSyncAccountId = (): string | null => {
  try {
    if (typeof window === 'undefined') return null
    const raw = window.localStorage.getItem(STATS_SYNC_ACCOUNT_KEY)
    return raw && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

export const saveStatsSyncAccountId = (accountId: string): void => {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(STATS_SYNC_ACCOUNT_KEY, accountId)
  } catch {
    // Best-effort UI metadata.
  }
}

export const clearStatsSyncAccountId = (): void => {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.removeItem(STATS_SYNC_ACCOUNT_KEY)
  } catch {
    // Best-effort UI metadata.
  }
}

export const loadStatsSyncBaseline = (
  accountId: string,
): LifetimeStats | null => {
  try {
    if (typeof window === 'undefined') return null
    return parseLifetimeStats(
      window.localStorage.getItem(statsSyncBaselineKey(accountId)),
    )
  } catch {
    return null
  }
}

export const saveStatsSyncBaseline = (
  accountId: string,
  stats: LifetimeStats,
): void => {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(statsSyncBaselineKey(accountId), JSON.stringify(stats))
    window.localStorage.setItem(STATS_SYNC_LAST_AT_KEY, String(Date.now()))
  } catch {
    // Best-effort; stats still remain local.
  }
}

export const loadStatsSyncLastAt = (): number | null => {
  try {
    if (typeof window === 'undefined') return null
    const raw = window.localStorage.getItem(STATS_SYNC_LAST_AT_KEY)
    if (!raw) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

const positiveDelta = (current: number, baseline: number): number =>
  Math.max(0, Math.round(current - baseline))

const newSetValues = (current: string[], baseline: string[]): string[] => {
  const baselineSet = new Set(baseline)
  return Array.from(
    new Set(current.filter((value) => value && !baselineSet.has(value))),
  )
}

// Per-day best-moves delta: include any key where the local best is
// strictly fewer moves than the baseline (or where the baseline
// doesn't know about that day yet). Sent in the upload payload and
// merged on the server with a per-key min.
const newDailyBestEntries = (
  current: Record<string, number>,
  baseline: Record<string, number>,
): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(current)) {
    if (!Number.isFinite(value) || value <= 0) continue
    const prev = baseline[key]
    if (prev === undefined || value < prev) {
      out[key] = Math.floor(value)
    }
  }
  return out
}

// Compute the one-time local contribution to upload for an account. For a
// first sync there is no baseline, so the whole local profile is added; after
// a successful merge, the returned server snapshot becomes the baseline and
// future uploads contain only newly earned local totals.
//
// `pieceStatsDelta` is computed independently (caller provides it via the
// piece-stats baseline) and stitched onto the returned payload. Kept as a
// separate input rather than re-derived from `current.pieceStats` so the
// hot sync path doesn't have to also juggle the piece-stats baseline.
export const calculateStatsSyncDelta = (
  current: LifetimeStats,
  baseline: LifetimeStats | null,
  pieceStatsDelta?: PieceStatsMap,
): LifetimeStats => {
  const base = baseline ?? createEmptyLifetimeStats(current.startedTrackingAt)
  return {
    startedTrackingAt: current.startedTrackingAt,
    totalActivePlayMs: positiveDelta(
      current.totalActivePlayMs,
      base.totalActivePlayMs,
    ),
    gamesPlayedEndless: positiveDelta(
      current.gamesPlayedEndless,
      base.gamesPlayedEndless,
    ),
    gamesPlayedDaily: positiveDelta(
      current.gamesPlayedDaily,
      base.gamesPlayedDaily,
    ),
    gamesPlayedCoop: positiveDelta(current.gamesPlayedCoop, base.gamesPlayedCoop),
    gamesPlayedPvp: positiveDelta(current.gamesPlayedPvp, base.gamesPlayedPvp),
    pvpWins: positiveDelta(current.pvpWins, base.pvpWins),
    pvpShames: positiveDelta(current.pvpShames, base.pvpShames),
    piecesPlaced: positiveDelta(current.piecesPlaced, base.piecesPlaced),
    cubesPlaced: positiveDelta(current.cubesPlaced, base.cubesPlaced),
    patternsCleared: positiveDelta(
      current.patternsCleared,
      base.patternsCleared,
    ),
    rubiesCleared: positiveDelta(current.rubiesCleared, base.rubiesCleared),
    boardClears: positiveDelta(current.boardClears, base.boardClears),
    totalScore: positiveDelta(current.totalScore, base.totalScore),
    scoredGamesPlayed: positiveDelta(
      current.scoredGamesPlayed,
      base.scoredGamesPlayed,
    ),
    bestEndlessScore:
      current.bestEndlessScore > base.bestEndlessScore
        ? current.bestEndlessScore
        : 0,
    bestDailyMoves:
      current.bestDailyMoves !== null &&
      (base.bestDailyMoves === null || current.bestDailyMoves < base.bestDailyMoves)
        ? current.bestDailyMoves
        : null,
    bestCombo: current.bestCombo > base.bestCombo ? current.bestCombo : 1,
    bestStreak: current.bestStreak > base.bestStreak ? current.bestStreak : 0,
    bestSinglePlacement:
      current.bestSinglePlacement > base.bestSinglePlacement
        ? current.bestSinglePlacement
        : 0,
    bestRubiesInRun:
      current.bestRubiesInRun > base.bestRubiesInRun
        ? current.bestRubiesInRun
        : 0,
    longestRunMs: current.longestRunMs > base.longestRunMs ? current.longestRunMs : 0,
    dailyDaysCleared: newSetValues(
      current.dailyDaysCleared,
      base.dailyDaysCleared,
    ),
    dailyDaysPlayed: newSetValues(current.dailyDaysPlayed, base.dailyDaysPlayed),
    coopPartnerIds: newSetValues(current.coopPartnerIds, base.coopPartnerIds),
    dailyBestMovesByDate: newDailyBestEntries(
      current.dailyBestMovesByDate,
      base.dailyBestMovesByDate,
    ),
    pieceStats: pieceStatsDelta,
  }
}

// Convenience: build the piece-stats delta from local sources so
// the App.tsx sync path stays a single call instead of duplicating
// the load + diff dance across every sync site.
export const buildPieceStatsDelta = (
  accountId: string,
): PieceStatsMap => {
  const current = loadPieceStats()
  const baseline = loadPieceStatsSyncBaseline(accountId)
  return calculatePieceStatsSyncDelta(current, baseline)
}

type ApplyPlacementToRunStatsArgs = {
  // Number of cells the placed piece occupies (= piece size).
  piecePlacedCellsCount: number
  patternsClearedCount: number
  rubiesCleared: number
  boardCleared: boolean
  pointsGained: number
  // Streak value after the placement (matches gameState.streak).
  streakAfter: number
}

// Pure function: given a previous RunStats and the deltas from a
// single placement, return the next RunStats. Caller wires this into
// either the single-player placement reducer or the multiplayer
// "lastPlacement" effect (gated on byPlayerId === self there so
// partner placements don't double-count into our run totals).
export const applyPlacementToRunStats = (
  prev: RunStats,
  args: ApplyPlacementToRunStatsArgs,
): RunStats => ({
  ...prev,
  piecesPlaced: prev.piecesPlaced + 1,
  cubesPlaced: prev.cubesPlaced + args.piecePlacedCellsCount,
  patternsCleared: prev.patternsCleared + args.patternsClearedCount,
  rubiesCleared: prev.rubiesCleared + args.rubiesCleared,
  boardClears: prev.boardClears + (args.boardCleared ? 1 : 0),
  bestCombo: Math.max(prev.bestCombo, args.patternsClearedCount || 1),
  bestStreak: Math.max(prev.bestStreak, args.streakAfter),
  topPlacementPoints: Math.max(prev.topPlacementPoints, args.pointsGained),
})

type MultiplayerMode = 'coop' | 'pvp'

type FoldRunIntoLifetimeArgs = {
  mode: GameModeId
  isMultiplayer: boolean
  // Which multiplayer variant this finished run was. Null in solo
  // (must be null whenever isMultiplayer is false). Drives the per-
  // mode game counter and PvP win/shame attribution.
  mpMode: MultiplayerMode | null
  // True when the local device's player won the PvP match (i.e. the
  // server set winnerPlayerId to this device's playerId). Ignored in
  // co-op or solo.
  pvpSelfWon: boolean
  // True when a PvP match ended with no winner — i.e. every seated
  // player got stuck before anyone crossed the threshold (the
  // "SHAME" path). Ignored in co-op or solo.
  pvpShame: boolean
  // Final game-state values at gameover.
  finalScore: number
  finalMoves: number
  dailyCleared: boolean
  dailyDateKey: string | null
  // playerIds of the *other* players in the room when a co-op run
  // ends, so the lifetime profile can track distinct partners.
  coopPartnerIds: string[]
}

// Fold a finished run into the lifetime totals: bump per-mode game
// counts, sum the cumulative counters, refresh records, and merge
// the daily / co-op set fields. Pure function; caller persists the
// result via saveLifetimeStats().
export const foldRunIntoLifetime = (
  prev: LifetimeStats,
  run: RunStats,
  args: FoldRunIntoLifetimeArgs,
): LifetimeStats => {
  const next: LifetimeStats = {
    ...prev,
    totalActivePlayMs: prev.totalActivePlayMs + run.activePlayMs,
    piecesPlaced: prev.piecesPlaced + run.piecesPlaced,
    cubesPlaced: prev.cubesPlaced + run.cubesPlaced,
    patternsCleared: prev.patternsCleared + run.patternsCleared,
    rubiesCleared: prev.rubiesCleared + run.rubiesCleared,
    boardClears: prev.boardClears + run.boardClears,
    bestCombo: Math.max(prev.bestCombo, run.bestCombo),
    bestStreak: Math.max(prev.bestStreak, run.bestStreak),
    bestSinglePlacement: Math.max(
      prev.bestSinglePlacement,
      run.topPlacementPoints,
    ),
    bestRubiesInRun: Math.max(prev.bestRubiesInRun, run.rubiesCleared),
    longestRunMs: Math.max(prev.longestRunMs, run.activePlayMs),
  }

  // PvP is a territory race, not a score race, so it doesn't
  // contribute to totalScore / scoredGamesPlayed. Only co-op and the
  // single-player scored modes do.
  const isScoredRun =
    (args.isMultiplayer && args.mpMode === 'coop') ||
    args.mode === 'endless' ||
    args.mode === 'big'
  if (isScoredRun) {
    next.totalScore = prev.totalScore + args.finalScore
    next.scoredGamesPlayed = prev.scoredGamesPlayed + 1
  }

  // Per-mode game counter. Co-op rolls up under `gamesPlayedCoop`
  // regardless of board size; PvP under its own counter (plus win /
  // shame tallies). Solo big-board (no multiplayer) rolls up under
  // endless since it shares the endless scoring loop.
  if (args.isMultiplayer && args.mpMode === 'pvp') {
    next.gamesPlayedPvp = prev.gamesPlayedPvp + 1
    if (args.pvpSelfWon) {
      next.pvpWins = prev.pvpWins + 1
    } else if (args.pvpShame) {
      next.pvpShames = prev.pvpShames + 1
    }
  } else if (args.isMultiplayer) {
    next.gamesPlayedCoop = prev.gamesPlayedCoop + 1
    if (args.coopPartnerIds.length > 0) {
      const set = new Set(prev.coopPartnerIds)
      for (const id of args.coopPartnerIds) {
        if (id) set.add(id)
      }
      next.coopPartnerIds = Array.from(set)
    }
  } else if (args.mode === 'endless' || args.mode === 'big') {
    next.gamesPlayedEndless = prev.gamesPlayedEndless + 1
  } else if (args.mode === 'daily') {
    next.gamesPlayedDaily = prev.gamesPlayedDaily + 1
  }

  // Records that are mode-specific.
  if (
    !args.isMultiplayer &&
    (args.mode === 'endless' || args.mode === 'big')
  ) {
    if (args.finalScore > prev.bestEndlessScore) {
      next.bestEndlessScore = args.finalScore
    }
  }
  if (args.mode === 'daily' && args.dailyCleared && args.finalMoves > 0) {
    if (
      prev.bestDailyMoves === null ||
      args.finalMoves < prev.bestDailyMoves
    ) {
      next.bestDailyMoves = args.finalMoves
    }
  }

  // Daily play log: every run logs the day as "played" regardless
  // of clear, but only clears flip it to "cleared". Cleared days
  // also write their move count into dailyBestMovesByDate (per-key
  // min over any prior entry) so other signed-in devices can show
  // the right "best for this day" badge on the calendar.
  if (args.mode === 'daily' && args.dailyDateKey) {
    const playedSet = new Set(prev.dailyDaysPlayed)
    playedSet.add(args.dailyDateKey)
    next.dailyDaysPlayed = Array.from(playedSet)
    if (args.dailyCleared) {
      const clearedSet = new Set(prev.dailyDaysCleared)
      clearedSet.add(args.dailyDateKey)
      next.dailyDaysCleared = Array.from(clearedSet)
      if (args.finalMoves > 0) {
        const incumbent = prev.dailyBestMovesByDate[args.dailyDateKey]
        if (incumbent === undefined || args.finalMoves < incumbent) {
          next.dailyBestMovesByDate = {
            ...prev.dailyBestMovesByDate,
            [args.dailyDateKey]: Math.floor(args.finalMoves),
          }
        }
      }
    }
  }

  return next
}

// Display helper: format a duration in milliseconds as "Hh Mm Ss",
// trimming the leading zero unit ("5m 12s", "47s", "2h 15m"). Used
// on both the gameover modal and the profile stats modal.
export const formatDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// "Tracking since" friendly date helper. Renders e.g. "March 3, 2026"
// for the profile-stats header. Same long-month convention used by
// the daily history calendar so the chrome reads consistently
// across surfaces.
const LONG_MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

export const formatFriendlyDate = (timestamp: number): string => {
  const d = new Date(timestamp)
  const month = LONG_MONTH_NAMES[d.getMonth()]
  const day = d.getDate()
  const year = d.getFullYear()
  return `${month} ${day}, ${year}`
}

/**
 * Same as `formatFriendlyDate` but also appends the local-time
 * hour:minute (12-hour clock, no seconds) so timestamps that name a
 * specific event — e.g. "last synced at" — read precisely without
 * forcing the user to guess "today vs yesterday". Uses the local
 * timezone so the value lines up with the device clock.
 */
export const formatFriendlyDateTime = (timestamp: number): string => {
  const d = new Date(timestamp)
  const month = LONG_MONTH_NAMES[d.getMonth()]
  const day = d.getDate()
  const year = d.getFullYear()
  const hours24 = d.getHours()
  const minutes = d.getMinutes()
  const suffix = hours24 >= 12 ? 'PM' : 'AM'
  const hours12 = ((hours24 + 11) % 12) + 1
  const mm = minutes.toString().padStart(2, '0')
  return `${month} ${day}, ${year} at ${hours12}:${mm} ${suffix}`
}

// ===================================================================
// Recent-runs ring buffer
// -------------------------------------------------------------------
// The lifetime profile only keeps aggregates, which can't power a
// per-run trajectory ("are my last 20 runs trending up?"). This is a
// small, capped log of recent finished runs — local-only, best-effort,
// same defensive load pattern as the rest of this file. We append on
// every gameover (see App.tsx fold path) and read it on the stats
// dashboard to draw the trajectory sparklines.
// ===================================================================

export type RecentRunMode = 'endless' | 'daily' | 'coop' | 'pvp'

export type RecentRun = {
  // Normalized bucket the run belongs to. Solo big-board folds into
  // 'endless' (shares the endless scoring loop); co-op and pvp are
  // their own buckets.
  mode: RecentRunMode
  score: number
  moves: number
  durationMs: number
  patternsCleared: number
  rubiesCleared: number
  // ms timestamp the run ended.
  date: number
  // PvP only: did this device win the match. Undefined elsewhere.
  won?: boolean
}

const RECENT_RUNS_KEY = 'cubic-recent-runs-v1'
const RECENT_RUNS_CAP = 60

export const loadRecentRuns = (): RecentRun[] => {
  try {
    if (typeof window === 'undefined') return []
    const raw = window.localStorage.getItem(RECENT_RUNS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const modes = new Set(['endless', 'daily', 'coop', 'pvp'])
    return parsed
      .filter(
        (e): e is RecentRun =>
          !!e &&
          typeof e === 'object' &&
          modes.has((e as RecentRun).mode) &&
          Number.isFinite((e as RecentRun).date),
      )
      .slice(-RECENT_RUNS_CAP)
  } catch {
    return []
  }
}

// Append a finished run and persist the capped tail. Returns the new
// list so callers can keep state in lockstep without a re-read.
export const appendRecentRun = (run: RecentRun): RecentRun[] => {
  try {
    if (typeof window === 'undefined') return []
    const next = [...loadRecentRuns(), run].slice(-RECENT_RUNS_CAP)
    window.localStorage.setItem(RECENT_RUNS_KEY, JSON.stringify(next))
    return next
  } catch {
    return []
  }
}

// ===================================================================
// Stats-dashboard preferences (focus + pinned headline stats)
// -------------------------------------------------------------------
// Which focus the player last looked at, and the headline stats they
// pinned per focus. Local-only UI preference (no account mirror): it
// describes how this device wants to *view* the synced stats, not the
// stats themselves. Unknown focuses / non-string pins are dropped on
// load so a malformed entry can't break the dashboard.
// ===================================================================

export type DashboardFocus = 'overall' | 'endless' | 'daily' | 'pvp' | 'coop'

export type DashboardPrefs = {
  focus: DashboardFocus
  // Per-focus pinned headline stat keys. Absent focus = use the
  // focus's preset defaults.
  pins: Partial<Record<DashboardFocus, string[]>>
}

const DASHBOARD_PREFS_KEY = 'cubic-stats-dashboard-v1'
const DASHBOARD_FOCUSES = new Set<DashboardFocus>([
  'overall',
  'endless',
  'daily',
  'pvp',
  'coop',
])

export const loadDashboardPrefs = (): DashboardPrefs => {
  const fallback: DashboardPrefs = { focus: 'overall', pins: {} }
  try {
    if (typeof window === 'undefined') return fallback
    const raw = window.localStorage.getItem(DASHBOARD_PREFS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<DashboardPrefs>
    if (!parsed || typeof parsed !== 'object') return fallback
    const focus =
      typeof parsed.focus === 'string' &&
      DASHBOARD_FOCUSES.has(parsed.focus as DashboardFocus)
        ? (parsed.focus as DashboardFocus)
        : 'overall'
    const pins: Partial<Record<DashboardFocus, string[]>> = {}
    if (parsed.pins && typeof parsed.pins === 'object') {
      for (const [key, value] of Object.entries(parsed.pins)) {
        if (!DASHBOARD_FOCUSES.has(key as DashboardFocus)) continue
        if (!Array.isArray(value)) continue
        const clean = value.filter((v) => typeof v === 'string').slice(0, 4)
        if (clean.length > 0) pins[key as DashboardFocus] = clean
      }
    }
    return { focus, pins }
  } catch {
    return fallback
  }
}

export const saveDashboardPrefs = (prefs: DashboardPrefs): void => {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(DASHBOARD_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Best-effort UI preference.
  }
}
