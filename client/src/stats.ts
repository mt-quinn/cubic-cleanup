// Per-device stats: a per-run accumulator surfaced on the gameover
// modal, plus a lifetime profile rolled up across every run (each
// gameover folds the run's totals into the lifetime ones). All of
// it is local-only — there is no server mirror — and we deliberately
// do NOT backfill on first encounter so per-game averages aren't
// skewed by historical runs we couldn't actually measure.

export type GameModeId = 'endless' | 'daily' | 'big'

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
  piecesPlaced: number
  cubesPlaced: number
  patternsCleared: number
  rubiesCleared: number
  boardClears: number
  // Aggregate score for scored modes (endless, big, co-op). Daily is
  // move-ranked rather than score-ranked, so it does not contribute to
  // Score/game.
  totalScore: number
  scoredGamesPlayed: number
  // Records (single best across the whole device).
  bestEndlessScore: number
  // Daily ranks ascending by moves; null until the first daily clear.
  bestDailyMoves: number | null
  bestCombo: number
  bestStreak: number
  bestSinglePlacement: number
  longestRunMs: number
  // Unique daily date keys (YYYY-M-D) cleared and played-but-not-cleared.
  // Stored as arrays for JSON compatibility; treated as Sets in code.
  dailyDaysCleared: string[]
  dailyDaysPlayed: string[]
  // Distinct co-op partner playerIds (excluding self) the device has
  // finished a co-op run with.
  coopPartnerIds: string[]
}

export const STATS_KEY = 'cubic-stats-v1'

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
  longestRunMs: 0,
  dailyDaysCleared: [],
  dailyDaysPlayed: [],
  coopPartnerIds: [],
})

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

export type ApplyPlacementToRunStatsArgs = {
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

export type FoldRunIntoLifetimeArgs = {
  mode: GameModeId
  isMultiplayer: boolean
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
    longestRunMs: Math.max(prev.longestRunMs, run.activePlayMs),
  }

  const isScoredRun =
    args.isMultiplayer || args.mode === 'endless' || args.mode === 'big'
  if (isScoredRun) {
    next.totalScore = prev.totalScore + args.finalScore
    next.scoredGamesPlayed = prev.scoredGamesPlayed + 1
  }

  // Per-mode game counter. Co-op rolls up under `gamesPlayedCoop`
  // regardless of board size; the solo big-board variant (no
  // multiplayer) currently rolls up under endless since it shares
  // the endless scoring loop.
  if (args.isMultiplayer) {
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
  // of clear, but only clears flip it to "cleared".
  if (args.mode === 'daily' && args.dailyDateKey) {
    const playedSet = new Set(prev.dailyDaysPlayed)
    playedSet.add(args.dailyDateKey)
    next.dailyDaysPlayed = Array.from(playedSet)
    if (args.dailyCleared) {
      const clearedSet = new Set(prev.dailyDaysCleared)
      clearedSet.add(args.dailyDateKey)
      next.dailyDaysCleared = Array.from(clearedSet)
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
