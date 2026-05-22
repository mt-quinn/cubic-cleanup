import { getAuthUserId } from '@convex-dev/auth/server'
import { mutation, query } from './_generated/server'
import { lifetimeStatsValidator } from './schema'

type LifetimeStats = typeof lifetimeStatsValidator.type

const now = () => Date.now()

const uniqueStrings = (values: readonly string[]): string[] =>
  Array.from(new Set(values.filter((v) => typeof v === 'string' && v.length > 0)))

const nonNegative = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

const saneTimestamp = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : now()

const sanitizeDailyBestMap = (
  raw: Record<string, number> | undefined,
): Record<string, number> => {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || key.length === 0) continue
    if (Number.isFinite(value) && value > 0) {
      out[key] = Math.floor(value)
    }
  }
  return out
}

const sanitizeStats = (stats: LifetimeStats): LifetimeStats => ({
  startedTrackingAt: saneTimestamp(stats.startedTrackingAt),
  totalActivePlayMs: nonNegative(stats.totalActivePlayMs),
  gamesPlayedEndless: nonNegative(stats.gamesPlayedEndless),
  gamesPlayedDaily: nonNegative(stats.gamesPlayedDaily),
  gamesPlayedCoop: nonNegative(stats.gamesPlayedCoop),
  gamesPlayedPvp: nonNegative(stats.gamesPlayedPvp ?? 0),
  pvpWins: nonNegative(stats.pvpWins ?? 0),
  pvpShames: nonNegative(stats.pvpShames ?? 0),
  piecesPlaced: nonNegative(stats.piecesPlaced),
  cubesPlaced: nonNegative(stats.cubesPlaced),
  patternsCleared: nonNegative(stats.patternsCleared),
  rubiesCleared: nonNegative(stats.rubiesCleared),
  boardClears: nonNegative(stats.boardClears),
  totalScore: nonNegative(stats.totalScore),
  scoredGamesPlayed: nonNegative(stats.scoredGamesPlayed),
  bestEndlessScore: nonNegative(stats.bestEndlessScore),
  bestDailyMoves:
    stats.bestDailyMoves === null ? null : nonNegative(stats.bestDailyMoves),
  bestCombo: Math.max(1, nonNegative(stats.bestCombo)),
  bestStreak: nonNegative(stats.bestStreak),
  bestSinglePlacement: nonNegative(stats.bestSinglePlacement),
  bestRubiesInRun: nonNegative(stats.bestRubiesInRun ?? 0),
  longestRunMs: nonNegative(stats.longestRunMs),
  dailyDaysCleared: uniqueStrings(stats.dailyDaysCleared),
  dailyDaysPlayed: uniqueStrings(stats.dailyDaysPlayed),
  coopPartnerIds: uniqueStrings(stats.coopPartnerIds),
  dailyBestMovesByDate: sanitizeDailyBestMap(stats.dailyBestMovesByDate),
})

const mergeStats = (server: LifetimeStats, delta: LifetimeStats): LifetimeStats => {
  const cleanServer = sanitizeStats(server)
  const cleanDelta = sanitizeStats(delta)
  return {
    startedTrackingAt: Math.min(
      cleanServer.startedTrackingAt,
      cleanDelta.startedTrackingAt,
    ),
    totalActivePlayMs:
      cleanServer.totalActivePlayMs + cleanDelta.totalActivePlayMs,
    gamesPlayedEndless:
      cleanServer.gamesPlayedEndless + cleanDelta.gamesPlayedEndless,
    gamesPlayedDaily: cleanServer.gamesPlayedDaily + cleanDelta.gamesPlayedDaily,
    gamesPlayedCoop: cleanServer.gamesPlayedCoop + cleanDelta.gamesPlayedCoop,
    gamesPlayedPvp:
      (cleanServer.gamesPlayedPvp ?? 0) + (cleanDelta.gamesPlayedPvp ?? 0),
    pvpWins: (cleanServer.pvpWins ?? 0) + (cleanDelta.pvpWins ?? 0),
    pvpShames: (cleanServer.pvpShames ?? 0) + (cleanDelta.pvpShames ?? 0),
    piecesPlaced: cleanServer.piecesPlaced + cleanDelta.piecesPlaced,
    cubesPlaced: cleanServer.cubesPlaced + cleanDelta.cubesPlaced,
    patternsCleared: cleanServer.patternsCleared + cleanDelta.patternsCleared,
    rubiesCleared: cleanServer.rubiesCleared + cleanDelta.rubiesCleared,
    boardClears: cleanServer.boardClears + cleanDelta.boardClears,
    totalScore: cleanServer.totalScore + cleanDelta.totalScore,
    scoredGamesPlayed:
      cleanServer.scoredGamesPlayed + cleanDelta.scoredGamesPlayed,
    bestEndlessScore: Math.max(
      cleanServer.bestEndlessScore,
      cleanDelta.bestEndlessScore,
    ),
    bestDailyMoves:
      cleanServer.bestDailyMoves === null
        ? cleanDelta.bestDailyMoves
        : cleanDelta.bestDailyMoves === null
        ? cleanServer.bestDailyMoves
        : Math.min(cleanServer.bestDailyMoves, cleanDelta.bestDailyMoves),
    bestCombo: Math.max(cleanServer.bestCombo, cleanDelta.bestCombo),
    bestStreak: Math.max(cleanServer.bestStreak, cleanDelta.bestStreak),
    bestSinglePlacement: Math.max(
      cleanServer.bestSinglePlacement,
      cleanDelta.bestSinglePlacement,
    ),
    bestRubiesInRun: Math.max(
      cleanServer.bestRubiesInRun ?? 0,
      cleanDelta.bestRubiesInRun ?? 0,
    ),
    longestRunMs: Math.max(cleanServer.longestRunMs, cleanDelta.longestRunMs),
    dailyDaysCleared: uniqueStrings([
      ...cleanServer.dailyDaysCleared,
      ...cleanDelta.dailyDaysCleared,
    ]),
    dailyDaysPlayed: uniqueStrings([
      ...cleanServer.dailyDaysPlayed,
      ...cleanDelta.dailyDaysPlayed,
    ]),
    coopPartnerIds: uniqueStrings([
      ...cleanServer.coopPartnerIds,
      ...cleanDelta.coopPartnerIds,
    ]),
    // Per-key min merge so the best run for any given day wins,
    // regardless of which device recorded it. Unknown-on-one-side
    // entries pass straight through.
    dailyBestMovesByDate: (() => {
      const out: Record<string, number> = {
        ...(cleanServer.dailyBestMovesByDate ?? {}),
      }
      for (const [key, value] of Object.entries(
        cleanDelta.dailyBestMovesByDate ?? {},
      )) {
        const incumbent = out[key]
        if (incumbent === undefined || value < incumbent) out[key] = value
      }
      return out
    })(),
  }
}

const emptyStats = (timestamp: number): LifetimeStats => ({
  startedTrackingAt: timestamp,
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
})

export const getMyStats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx)
    if (userId === null) return null
    const user = await ctx.db.get(userId)
    const row = await ctx.db
      .query('accountStats')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .first()
    return {
      userId,
      email: user?.email ?? null,
      stats: row?.stats ?? null,
    }
  },
})

export const mergeMyStats = mutation({
  args: {
    delta: lifetimeStatsValidator,
  },
  handler: async (ctx, { delta }) => {
    const userId = await getAuthUserId(ctx)
    if (userId === null) {
      throw new Error('You must be signed in to sync stats.')
    }
    const timestamp = now()
    const existingRows = await ctx.db
      .query('accountStats')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect()
    const primary = existingRows[0] ?? null
    const base = primary?.stats ?? emptyStats(timestamp)
    const merged = mergeStats(base, delta)
    if (primary) {
      await ctx.db.patch(primary._id, { stats: merged, updatedAt: timestamp })
      for (const row of existingRows.slice(1)) {
        await ctx.db.delete(row._id)
      }
    } else {
      await ctx.db.insert('accountStats', {
        userId,
        stats: merged,
        updatedAt: timestamp,
      })
    }
    return merged
  },
})
