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
// Combined co-op display name: joined with ` & ` between every pair
// of player names — "Alice & Bob & Carol" for an N-player room.
// Each name is sanitized independently and capped at
// MAX_NAME_LENGTH; the final combined string is also capped at
// MAX_COMBINED_NAME_LENGTH so an 8-seat room can't spew a 180-char
// row onto the leaderboard.
const COOP_NAME_SEPARATOR = ' & '
const MAX_COMBINED_NAME_LENGTH = 80

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
    const fullCombined = sorted
      .map((p) => sanitizeName(p.name))
      .join(COOP_NAME_SEPARATOR)
    // Hard length cap with an ellipsis so 8-seat rooms don't blow
    // out the leaderboard row. We keep the full name in the common
    // 2-3 player case (well under 80 chars).
    const combinedName =
      fullCombined.length > MAX_COMBINED_NAME_LENGTH
        ? fullCombined.slice(0, MAX_COMBINED_NAME_LENGTH - 1) + '…'
        : fullCombined
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

// One-shot janitor for the heartbeat-bug duplicates that landed in
// coopScores before the heartbeat-on-gameover no-op + lastPlacement.ts
// dedupe-key fixes shipped. Each finished co-op run produces a stable
// (roomCode, score) pair — the heartbeat re-fires re-stamped the same
// score under different finishedAt values, so the buggy rows for one
// run all share both fields. Genuine restartRoom re-runs almost always
// land on a different score in the same roomCode, so they don't get
// merged here.
//
// Strategy: group by (roomCode, score), keep the row with the earliest
// finishedAt (the moment the run actually ended; later rows are
// heartbeat re-fires of the same gameover), delete the rest. Returns
// counts so the caller can confirm the cleanup did what was expected.
//
// Idempotent: re-running on already-clean data deletes 0 rows.
//
// Safe to leave deployed indefinitely; once the inserts stop happening
// (which they have, post-fix), this mutation is a no-op.
export const dedupeCoopScores = mutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query('coopScores').collect()
    type Survivor = { id: typeof all[number]['_id']; finishedAt: number }
    const survivors = new Map<string, Survivor>()
    const toDelete: typeof all[number]['_id'][] = []

    for (const row of all) {
      const key = `${row.roomCode}@${row.score}`
      const incumbent = survivors.get(key)
      if (!incumbent) {
        survivors.set(key, { id: row._id, finishedAt: row.finishedAt })
        continue
      }
      // Earliest finishedAt wins — that row is the genuine
      // gameover-instant entry; the others are post-gameover
      // heartbeat re-fires.
      if (row.finishedAt < incumbent.finishedAt) {
        toDelete.push(incumbent.id)
        survivors.set(key, { id: row._id, finishedAt: row.finishedAt })
      } else {
        toDelete.push(row._id)
      }
    }

    for (const id of toDelete) {
      await ctx.db.delete(id)
    }

    return {
      scanned: all.length,
      kept: survivors.size,
      deleted: toDelete.length,
    }
  },
})
