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
const COOP_TOP_N = 100
// Combined co-op display name: "Alice & Bob". Each half is sanitized
// independently and capped at MAX_NAME_LENGTH so a 20-char name on
// each side max out at 43 chars total ("X" * 20 + " & " + "Y" * 20).
const COOP_NAME_SEPARATOR = ' & '

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

// Finalize a co-op run on the global board. Both clients race-fire
// this on gameover with the same (roomCode, finishedAt) pair —
// whichever lands first wins, the other is a no-op. We rebuild the
// combined name server-side from the player list rather than trusting
// either client's pre-formatted string so we know the slot order is
// canonical and the per-half names are length-capped.
export const submitCoopScore = mutation({
  args: {
    roomCode: v.string(),
    finishedAt: v.number(),
    score: v.number(),
    // Sorted by slot client-side already, but we re-sort here so a
    // bad client can't reorder the display name.
    players: v.array(
      v.object({
        playerId: v.string(),
        name: v.string(),
        slot: v.number(),
      }),
    ),
  },
  handler: async (ctx, { roomCode, finishedAt, score, players }) => {
    if (!Number.isFinite(score) || score < 0) return null
    if (players.length === 0) return null
    const existing = await ctx.db
      .query('coopScores')
      .withIndex('by_room_finished', (q) =>
        q.eq('roomCode', roomCode).eq('finishedAt', finishedAt),
      )
      .first()
    if (existing) return null
    const sorted = [...players].sort((a, b) => a.slot - b.slot)
    const combinedName = sorted
      .map((p) => sanitizeName(p.name))
      .join(COOP_NAME_SEPARATOR)
    await ctx.db.insert('coopScores', {
      roomCode,
      finishedAt,
      name: combinedName,
      score: Math.floor(score),
      playerIds: sorted.map((p) => p.playerId),
    })
    return null
  },
})

export const getTopCoopScores = query({
  args: {},
  handler: async (ctx) => {
    const entries = await ctx.db
      .query('coopScores')
      .withIndex('by_score')
      .order('desc')
      .take(COOP_TOP_N)
    return entries.map((e) => ({
      roomCode: e.roomCode,
      name: e.name,
      score: e.score,
      finishedAt: e.finishedAt,
      playerIds: e.playerIds,
    }))
  },
})
