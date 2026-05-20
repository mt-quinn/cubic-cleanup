import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

// Global leaderboard storage.
//
// Identity & dedup: every leaderboard tracks one row per actor.
//   • Endless: actor = playerId. The row reflects that player's best
//     ever endless score.
//   • Daily: actor = (dateKey, playerId). Each player has at most one
//     row per calendar day, reflecting their best (fewest moves) run.
//   • Co-op: actor = the canonical "group of playerIds" the run was
//     played by. Sort the playerIds lexically and join with '|' to
//     get a stable `playerIdsKey`; every distinct group has one row,
//     reflecting that group's best collective score.
//
// All submit mutations are upserts: they look up the existing row
// for the actor, keep whichever side is better (higher score / fewer
// moves), and patch the loser. This means the same player / group
// can fire submissions repeatedly without flooding the table — every
// later run either wins the slot or is a no-op.

const MAX_NAME_LENGTH = 20
const ENDLESS_TOP_N = 100
const DAILY_TOP_N = 100
const COOP_TOP_N = 100
const PVP_TOP_N = 100
const COOP_NAME_SEPARATOR = ' & '
const MAX_COMBINED_NAME_LENGTH = 80

// Derived "global rank" stat: games played × win rate, where
// winRate = wins / (wins + losses). Rewards both volume (more games)
// and skill (higher win share). A player with 10 W / 0 L scores 10;
// a player with 50 W / 50 L scores 50; a 100-game flat zero scores 0.
// Shames are folded into losses on submit, so this matches the
// gameover-time bookkeeping.
const computePvpRankScore = (
  wins: number,
  losses: number,
  gamesPlayed: number,
): number => {
  const ranked = wins + losses
  if (ranked <= 0) return 0
  return gamesPlayed * (wins / ranked)
}

const sanitizeName = (raw: string): string => {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return 'Player'
  return trimmed.slice(0, MAX_NAME_LENGTH)
}

// Canonical key for a group of playerIds. Sort lexically so callers
// can hand us the players in any order (slot order, join order, …)
// and we still produce the same key for the same group.
const computeGroupKey = (playerIds: readonly string[]): string => {
  return [...playerIds].sort().join('|')
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
    const flooredScore = Math.floor(score)
    // Upsert against the by_player_saved index. We pull every row
    // for this player (legacy data may have multiple) so we can
    // collapse to a single row in a single transaction. New writes
    // never produce >1 row, but historical data does until the
    // dedupe janitor sweeps it.
    const existingRows = await ctx.db
      .query('endlessScores')
      .withIndex('by_player_saved', (q) => q.eq('playerId', playerId))
      .collect()
    const incumbentBest = existingRows.reduce<typeof existingRows[number] | null>(
      (best, r) =>
        best === null
          ? r
          : r.score > best.score || (r.score === best.score && r.savedAt < best.savedAt)
            ? r
            : best,
      null,
    )
    if (incumbentBest && incumbentBest.score >= flooredScore) {
      // The incumbent is at least as good — make sure stragglers
      // (legacy duplicates) are gone but don't overwrite the row.
      for (const r of existingRows) {
        if (r._id !== incumbentBest._id) await ctx.db.delete(r._id)
      }
      return null
    }
    const cleanName = sanitizeName(name)
    if (incumbentBest) {
      await ctx.db.patch(incumbentBest._id, {
        name: cleanName,
        score: flooredScore,
        savedAt,
      })
      for (const r of existingRows) {
        if (r._id !== incumbentBest._id) await ctx.db.delete(r._id)
      }
    } else {
      await ctx.db.insert('endlessScores', {
        playerId,
        name: cleanName,
        score: flooredScore,
        savedAt,
      })
    }
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
    const flooredMoves = Math.floor(moves)
    // We don't have a (dateKey, playerId) index yet, so scan this
    // player's rows and filter by date in JS. Daily rows per player
    // are bounded (one per day), so the scan stays cheap.
    const existingRows = (
      await ctx.db
        .query('dailyScores')
        .withIndex('by_player_saved', (q) => q.eq('playerId', playerId))
        .collect()
    ).filter((r) => r.dateKey === dateKey)
    const incumbentBest = existingRows.reduce<typeof existingRows[number] | null>(
      (best, r) =>
        best === null
          ? r
          : r.moves < best.moves || (r.moves === best.moves && r.savedAt < best.savedAt)
            ? r
            : best,
      null,
    )
    if (incumbentBest && incumbentBest.moves <= flooredMoves) {
      for (const r of existingRows) {
        if (r._id !== incumbentBest._id) await ctx.db.delete(r._id)
      }
      return null
    }
    const cleanName = sanitizeName(name)
    if (incumbentBest) {
      await ctx.db.patch(incumbentBest._id, {
        name: cleanName,
        moves: flooredMoves,
        savedAt,
      })
      for (const r of existingRows) {
        if (r._id !== incumbentBest._id) await ctx.db.delete(r._id)
      }
    } else {
      await ctx.db.insert('dailyScores', {
        playerId,
        name: cleanName,
        moves: flooredMoves,
        dateKey,
        savedAt,
      })
    }
    return null
  },
})

export const getTopEndlessScores = query({
  args: {},
  handler: async (ctx) => {
    // After the upsert + dedupe janitor, by_score returns at most
    // one row per playerId. We still de-dupe in JS as a defensive
    // belt-and-suspenders pass: legacy rows are possible until
    // every client has run the new submit pipeline at least once.
    const entries = await ctx.db
      .query('endlessScores')
      .withIndex('by_score')
      .order('desc')
      .take(ENDLESS_TOP_N * 2)
    const seen = new Set<string>()
    const out: typeof entries = []
    for (const e of entries) {
      if (seen.has(e.playerId)) continue
      seen.add(e.playerId)
      out.push(e)
      if (out.length >= ENDLESS_TOP_N) break
    }
    return out.map((e) => ({
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
    const entries = await ctx.db
      .query('dailyScores')
      .withIndex('by_dateKey_moves', (q) => q.eq('dateKey', dateKey))
      .take(DAILY_TOP_N * 2)
    const seen = new Set<string>()
    const out: typeof entries = []
    for (const e of entries) {
      if (seen.has(e.playerId)) continue
      seen.add(e.playerId)
      out.push(e)
      if (out.length >= DAILY_TOP_N) break
    }
    return out.map((e) => ({
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
// whichever lands first wins, the other no-ops via the group-level
// upsert. We rebuild the combined name server-side from the player
// list rather than trusting either client's pre-formatted string so
// we know the slot order is canonical and the per-half names are
// length-capped.
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
    const flooredScore = Math.floor(score)
    const sortedBySlot = [...players].sort((a, b) => a.slot - b.slot)
    const fullCombined = sortedBySlot
      .map((p) => sanitizeName(p.name))
      .join(COOP_NAME_SEPARATOR)
    const combinedName =
      fullCombined.length > MAX_COMBINED_NAME_LENGTH
        ? fullCombined.slice(0, MAX_COMBINED_NAME_LENGTH - 1) + '…'
        : fullCombined
    const playerIds = sortedBySlot.map((p) => p.playerId)
    const playerIdsKey = computeGroupKey(playerIds)

    // Upsert by group key. Pull every row for this group so legacy
    // multi-row data also gets collapsed in a single transaction.
    const groupRows = await ctx.db
      .query('coopScores')
      .withIndex('by_group', (q) => q.eq('playerIdsKey', playerIdsKey))
      .collect()
    // Belt-and-suspenders: legacy rows pre-migration may not have
    // playerIdsKey at all but still belong to this group. Pick them
    // up by scanning rooms with matching playerIds.
    if (groupRows.length === 0) {
      const legacy = await ctx.db.query('coopScores').collect()
      for (const r of legacy) {
        if (
          r.playerIdsKey === undefined &&
          computeGroupKey(r.playerIds) === playerIdsKey
        ) {
          groupRows.push(r)
        }
      }
    }

    const incumbentBest = groupRows.reduce<typeof groupRows[number] | null>(
      (best, r) =>
        best === null
          ? r
          : r.score > best.score || (r.score === best.score && r.finishedAt < best.finishedAt)
            ? r
            : best,
      null,
    )
    if (incumbentBest && incumbentBest.score >= flooredScore) {
      for (const r of groupRows) {
        if (r._id !== incumbentBest._id) await ctx.db.delete(r._id)
      }
      // Backfill the key on the survivor if it predates the field.
      if (incumbentBest.playerIdsKey === undefined) {
        await ctx.db.patch(incumbentBest._id, { playerIdsKey })
      }
      return null
    }
    if (incumbentBest) {
      await ctx.db.patch(incumbentBest._id, {
        roomCode,
        finishedAt,
        name: combinedName,
        score: flooredScore,
        playerIds,
        playerIdsKey,
      })
      for (const r of groupRows) {
        if (r._id !== incumbentBest._id) await ctx.db.delete(r._id)
      }
    } else {
      await ctx.db.insert('coopScores', {
        roomCode,
        finishedAt,
        name: combinedName,
        score: flooredScore,
        playerIds,
        playerIdsKey,
      })
    }
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
      .take(COOP_TOP_N * 2)
    const seen = new Set<string>()
    const out: typeof entries = []
    for (const e of entries) {
      const key = e.playerIdsKey ?? computeGroupKey(e.playerIds)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(e)
      if (out.length >= COOP_TOP_N) break
    }
    return out.map((e) => ({
      roomCode: e.roomCode,
      name: e.name,
      score: e.score,
      finishedAt: e.finishedAt,
      playerIds: e.playerIds,
      playerIdsKey: e.playerIdsKey ?? computeGroupKey(e.playerIds),
    }))
  },
})

// Co-op scores filtered to "groups that include this playerId" —
// powers the per-device "local" co-op leaderboard. Groups still
// dedupe to one row each (best score wins), and within that the
// roster of returned groups is whichever ones the requesting
// player has been part of.
export const getCoopScoresForPlayer = query({
  args: { playerId: v.string() },
  handler: async (ctx, { playerId }) => {
    // We don't have an array-membership index, so scan and filter.
    // This is bounded by the size of the global co-op table and is
    // only fired when the leaderboard panel is open.
    const all = await ctx.db.query('coopScores').collect()
    const bestByGroup = new Map<string, typeof all[number]>()
    for (const e of all) {
      if (!e.playerIds.includes(playerId)) continue
      const key = e.playerIdsKey ?? computeGroupKey(e.playerIds)
      const incumbent = bestByGroup.get(key)
      if (
        !incumbent ||
        e.score > incumbent.score ||
        (e.score === incumbent.score && e.finishedAt < incumbent.finishedAt)
      ) {
        bestByGroup.set(key, e)
      }
    }
    return Array.from(bestByGroup.values())
      .sort((a, b) => b.score - a.score || a.finishedAt - b.finishedAt)
      .slice(0, COOP_TOP_N)
      .map((e) => ({
        roomCode: e.roomCode,
        name: e.name,
        score: e.score,
        finishedAt: e.finishedAt,
        playerIds: e.playerIds,
        playerIdsKey: e.playerIdsKey ?? computeGroupKey(e.playerIds),
      }))
  },
})

// ---------- PvP leaderboard --------------------------------------------
//
// One row per playerId, mutated each time that player finishes a PvP
// match. `submitPvpResult` increments the right counter (wins / losses)
// and recomputes the derived rankScore in the same transaction so
// the by_rank index stays consistent with the underlying counters.
// SHAME matches submit as a loss for every seated player — the
// caller is responsible for firing one submit per local participant.
export const submitPvpResult = mutation({
  args: {
    playerId: v.string(),
    name: v.string(),
    outcome: v.union(v.literal('win'), v.literal('loss')),
  },
  handler: async (ctx, { playerId, name, outcome }) => {
    const cleanName = sanitizeName(name)
    const now = Date.now()
    const existing = await ctx.db
      .query('pvpScores')
      .withIndex('by_player', (q) => q.eq('playerId', playerId))
      .unique()
    if (existing) {
      const wins = existing.wins + (outcome === 'win' ? 1 : 0)
      const losses = existing.losses + (outcome === 'loss' ? 1 : 0)
      const gamesPlayed = existing.gamesPlayed + 1
      await ctx.db.patch(existing._id, {
        name: cleanName,
        wins,
        losses,
        gamesPlayed,
        rankScore: computePvpRankScore(wins, losses, gamesPlayed),
        updatedAt: now,
      })
    } else {
      const wins = outcome === 'win' ? 1 : 0
      const losses = outcome === 'loss' ? 1 : 0
      const gamesPlayed = 1
      await ctx.db.insert('pvpScores', {
        playerId,
        name: cleanName,
        wins,
        losses,
        gamesPlayed,
        rankScore: computePvpRankScore(wins, losses, gamesPlayed),
        updatedAt: now,
      })
    }
    return null
  },
})

// Top N PvP players, ordered by either the derived rank score
// (default) or raw wins. Reactive — flips immediately when a
// match submission lands.
export const getTopPvpScores = query({
  args: {
    sortBy: v.union(v.literal('rank'), v.literal('wins')),
  },
  handler: async (ctx, { sortBy }) => {
    const indexName = sortBy === 'wins' ? 'by_wins' : 'by_rank'
    const rows = await ctx.db
      .query('pvpScores')
      .withIndex(indexName)
      .order('desc')
      .take(PVP_TOP_N)
    return rows.map((r) => ({
      playerId: r.playerId,
      name: r.name,
      wins: r.wins,
      losses: r.losses,
      gamesPlayed: r.gamesPlayed,
      rankScore: r.rankScore,
    }))
  },
})

// Rank lookup for a small batch of playerIds (the seated roster of
// an active PvP match, typically 2–8). Returns the rank-by-
// rankScore position 1..N for each, or null if the player has no
// row yet. Collects every row once and walks it in one pass so the
// per-player cost is constant in seated-roster size.
export const getPvpRanksForPlayers = query({
  args: { playerIds: v.array(v.string()) },
  handler: async (ctx, { playerIds }) => {
    const out: Record<
      string,
      {
        rank: number
        wins: number
        losses: number
        gamesPlayed: number
        rankScore: number
      } | null
    > = {}
    for (const pid of playerIds) out[pid] = null
    if (playerIds.length === 0) return out
    const wanted = new Set(playerIds)
    const all = await ctx.db
      .query('pvpScores')
      .withIndex('by_rank')
      .order('desc')
      .collect()
    let position = 0
    for (const row of all) {
      position += 1
      if (wanted.has(row.playerId)) {
        out[row.playerId] = {
          rank: position,
          wins: row.wins,
          losses: row.losses,
          gamesPlayed: row.gamesPlayed,
          rankScore: row.rankScore,
        }
      }
    }
    return out
  },
})

// One-shot janitor for the v1 leaderboards. Collapses every actor
// (endless: per playerId; daily: per (dateKey, playerId); coop: per
// canonical playerIdsKey) down to its single best row, and backfills
// `playerIdsKey` on every co-op row that predates the field.
//
// Idempotent: re-running on already-clean data deletes 0 rows.
export const dedupeAllScoresV2 = mutation({
  args: {},
  handler: async (ctx) => {
    const out = {
      endless: { scanned: 0, kept: 0, deleted: 0 },
      daily: { scanned: 0, kept: 0, deleted: 0 },
      coop: { scanned: 0, kept: 0, deleted: 0, backfilledKeys: 0 },
    }

    // ---- endless ----------------------------------------------------
    const allEndless = await ctx.db.query('endlessScores').collect()
    out.endless.scanned = allEndless.length
    type EndlessRow = typeof allEndless[number]
    const bestEndless = new Map<string, EndlessRow>()
    for (const r of allEndless) {
      const incumbent = bestEndless.get(r.playerId)
      if (
        !incumbent ||
        r.score > incumbent.score ||
        (r.score === incumbent.score && r.savedAt < incumbent.savedAt)
      ) {
        bestEndless.set(r.playerId, r)
      }
    }
    for (const r of allEndless) {
      const winner = bestEndless.get(r.playerId)
      if (!winner) continue
      if (r._id !== winner._id) {
        await ctx.db.delete(r._id)
        out.endless.deleted += 1
      }
    }
    out.endless.kept = bestEndless.size

    // ---- daily ------------------------------------------------------
    const allDaily = await ctx.db.query('dailyScores').collect()
    out.daily.scanned = allDaily.length
    type DailyRow = typeof allDaily[number]
    const bestDaily = new Map<string, DailyRow>()
    for (const r of allDaily) {
      const key = `${r.dateKey}@${r.playerId}`
      const incumbent = bestDaily.get(key)
      if (
        !incumbent ||
        r.moves < incumbent.moves ||
        (r.moves === incumbent.moves && r.savedAt < incumbent.savedAt)
      ) {
        bestDaily.set(key, r)
      }
    }
    for (const r of allDaily) {
      const key = `${r.dateKey}@${r.playerId}`
      const winner = bestDaily.get(key)
      if (!winner) continue
      if (r._id !== winner._id) {
        await ctx.db.delete(r._id)
        out.daily.deleted += 1
      }
    }
    out.daily.kept = bestDaily.size

    // ---- coop -------------------------------------------------------
    const allCoop = await ctx.db.query('coopScores').collect()
    out.coop.scanned = allCoop.length
    type CoopRow = typeof allCoop[number]
    const bestCoop = new Map<string, CoopRow>()
    for (const r of allCoop) {
      const key = r.playerIdsKey ?? computeGroupKey(r.playerIds)
      const incumbent = bestCoop.get(key)
      if (
        !incumbent ||
        r.score > incumbent.score ||
        (r.score === incumbent.score && r.finishedAt < incumbent.finishedAt)
      ) {
        bestCoop.set(key, r)
      }
    }
    for (const r of allCoop) {
      const key = r.playerIdsKey ?? computeGroupKey(r.playerIds)
      const winner = bestCoop.get(key)
      if (!winner) continue
      if (r._id !== winner._id) {
        await ctx.db.delete(r._id)
        out.coop.deleted += 1
      } else if (r.playerIdsKey === undefined) {
        await ctx.db.patch(r._id, { playerIdsKey: key })
        out.coop.backfilledKeys += 1
      }
    }
    out.coop.kept = bestCoop.size

    return out
  },
})

// Legacy v1 cleanup retained for compatibility with the previous
// admin tooling. Strict subset of dedupeAllScoresV2 (coop only,
// merge by (roomCode, score)). Kept for now so existing call sites
// don't break; new callers should use dedupeAllScoresV2 instead.
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
