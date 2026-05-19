import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

// Global leaderboard storage. Endless ranks by score (high → low),
// daily ranks by moves (low → high) within a calendar day. We dedupe
// new submissions on (playerId, savedAt) so the first-time backfill
// from a player's local storage doesn't double-count anything they've
// previously posted, and so an over-eager save click can't multiply
// the same run.

const MAX_NAME_LENGTH = 20
const ENDLESS_TOP_N = 100
const DAILY_TOP_N = 100

const sanitizeName = (raw: string): string => {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return 'Player'
  return trimmed.slice(0, MAX_NAME_LENGTH)
}

export const submitEndlessScore = mutation({
  args: {
    playerId: v.string(),
    name: v.string(),
    score: v.number(),
    savedAt: v.number(),
  },
  handler: async (ctx, { playerId, name, score, savedAt }) => {
    if (!Number.isFinite(score) || score < 0) return null
    const existing = await ctx.db
      .query('endlessScores')
      .withIndex('by_player_saved', (q) =>
        q.eq('playerId', playerId).eq('savedAt', savedAt),
      )
      .first()
    if (existing) return null
    await ctx.db.insert('endlessScores', {
      playerId,
      name: sanitizeName(name),
      score: Math.floor(score),
      savedAt,
    })
    return null
  },
})

export const submitDailyScore = mutation({
  args: {
    playerId: v.string(),
    name: v.string(),
    moves: v.number(),
    dateKey: v.string(),
    savedAt: v.number(),
  },
  handler: async (ctx, { playerId, name, moves, dateKey, savedAt }) => {
    if (!Number.isFinite(moves) || moves <= 0) return null
    const existing = await ctx.db
      .query('dailyScores')
      .withIndex('by_player_saved', (q) =>
        q.eq('playerId', playerId).eq('savedAt', savedAt),
      )
      .first()
    if (existing) return null
    await ctx.db.insert('dailyScores', {
      playerId,
      name: sanitizeName(name),
      moves: Math.floor(moves),
      dateKey,
      savedAt,
    })
    return null
  },
})

export const getTopEndlessScores = query({
  args: {},
  handler: async (ctx) => {
    // Convex orders are ascending by default; for the top scores we
    // ask for descending order on the score index. The native API for
    // that is `.order('desc')` on a query.
    const entries = await ctx.db
      .query('endlessScores')
      .withIndex('by_score')
      .order('desc')
      .take(ENDLESS_TOP_N)
    return entries.map((e) => ({
      playerId: e.playerId,
      name: e.name,
      score: e.score,
      savedAt: e.savedAt,
    }))
  },
})

export const getTopDailyScoresForDate = query({
  args: { dateKey: v.string() },
  handler: async (ctx, { dateKey }) => {
    // Index ordering is (dateKey, moves) ascending; that's exactly
    // what we want: today's runs sorted by fewest moves first.
    const entries = await ctx.db
      .query('dailyScores')
      .withIndex('by_dateKey_moves', (q) => q.eq('dateKey', dateKey))
      .take(DAILY_TOP_N)
    return entries.map((e) => ({
      playerId: e.playerId,
      name: e.name,
      moves: e.moves,
      dateKey: e.dateKey,
      savedAt: e.savedAt,
    }))
  },
})
