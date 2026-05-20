import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

// Multiplayer rooms for co-op Big mode. One row per active room.
//
// MVP scope is intentionally narrow: 2 players, big board, shared score
// + streak, per-player hands. The room is the single source of truth for
// the shared state; each client subscribes to it via getRoom.

const cellStateValidator = v.union(v.literal('empty'), v.literal('filled'))

const axialValidator = v.object({
  q: v.number(),
  r: v.number(),
})

const pieceShapeValidator = v.object({
  id: v.string(),
  size: v.number(),
  cells: v.array(axialValidator),
})

const activePieceValidator = v.object({
  id: v.string(),
  shape: pieceShapeValidator,
})

const playerValidator = v.object({
  playerId: v.string(),
  name: v.string(),
  slot: v.number(),
  hand: v.array(activePieceValidator),
  // Mirror of single-player handSlots: positional ids so the UI can keep
  // empty slots stable across re-deals.
  handSlots: v.array(v.union(v.string(), v.null())),
  // ms timestamps used as a coarse presence signal.
  joinedAt: v.number(),
  lastSeen: v.number(),
})

// Snapshot of the most recent placement so all clients can replay the
// animation pipeline (clears, ripple, ruby pop, etc.) by diffing tokens.
const lastPlacementValidator = v.object({
  token: v.number(),
  byPlayerId: v.string(),
  pieceShape: pieceShapeValidator,
  originCellId: v.string(),
  placedCellIds: v.array(v.string()),
  clearedCellIds: v.array(v.string()),
  clearedPatternIds: v.array(v.string()),
  pointsGained: v.number(),
  comboMultiplier: v.number(),
  streakMultiplier: v.number(),
  streakAfter: v.number(),
  rubiesCleared: v.number(),
  prevGoldenCellIds: v.array(v.string()),
  newGoldenCellIds: v.array(v.string()),
  boardCleared: v.boolean(),
  ts: v.number(),
})

// Per-cell ownership map: cellId -> playerId. Lets clients know which
// player placed each cube so partner-placed pieces can render with a
// lighter tint. Entries get cleared as cells get cleared. Optional so
// older rooms (created before this field existed) keep validating.
const cellOwnersValidator = v.optional(v.record(v.string(), v.string()))

// Most-recent emote per player. We render the partner's emote inside
// their smiley face for 10s after `ts`, then it falls back to the
// default 🙂. Optional / array-shaped so older rooms keep working.
const emoteValidator = v.object({
  playerId: v.string(),
  emoji: v.string(),
  ts: v.number(),
})

// Live "where each player is hovering" presence. Each entry is a
// (playerId, pieceId, cellId) triple stamped with `ts` so clients
// can fade out stale entries without needing a server-side cleanup.
// `pieceId` is the id of the piece currently held / about to be
// dropped; `cellId` is the cell under the cursor or the touch
// preview. We render a tinted ghost of that piece footprint for
// every other viewer so they can see what their partner is
// considering before it's actually placed. Optional + array-shaped
// so older rooms (created before this field existed) keep
// validating.
const hoverValidator = v.object({
  playerId: v.string(),
  pieceId: v.string(),
  cellId: v.string(),
  ts: v.number(),
})

export default defineSchema({
  rooms: defineTable({
    code: v.string(),
    state: v.union(
      v.literal('waiting'),
      v.literal('playing'),
      v.literal('gameover'),
    ),
    board: v.record(v.string(), cellStateValidator),
    goldenCellIds: v.array(v.string()),
    score: v.number(),
    streak: v.number(),
    moves: v.number(),
    players: v.array(playerValidator),
    lastPlacement: v.union(v.null(), lastPlacementValidator),
    cellOwners: cellOwnersValidator,
    lastEmotes: v.optional(v.array(emoteValidator)),
    hovers: v.optional(v.array(hoverValidator)),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_code', ['code']),

  // Global high scores for endless mode. We dedupe on (playerId,
  // savedAt) so a player resubmitting the same saved entry (e.g. the
  // first-time backfill) doesn't double-count. Score is the sortable
  // metric; ties break by savedAt (older first, like the local board).
  endlessScores: defineTable({
    playerId: v.string(),
    name: v.string(),
    score: v.number(),
    savedAt: v.number(),
  })
    .index('by_score', ['score'])
    .index('by_player_saved', ['playerId', 'savedAt']),

  // Global daily-puzzle runs. Same identity dedup. `dateKey` is the
  // calendar-day key the run is bound to (matches single-player's
  // local-daily key format) so we can scope queries to "today".
  dailyScores: defineTable({
    playerId: v.string(),
    name: v.string(),
    moves: v.number(),
    dateKey: v.string(),
    savedAt: v.number(),
  })
    .index('by_dateKey_moves', ['dateKey', 'moves'])
    .index('by_player_saved', ['playerId', 'savedAt']),

  // Global co-op leaderboard. ONE row per unique group of players —
  // dedupe key is `playerIdsKey`, the player ids sorted lexically and
  // joined with '|'. Each subsequent run by the same group upserts
  // the row when it beats the previous best score. `name` is the
  // pre-baked "Eli & Thomas" string built from the room's slot order
  // so the rendered name reads identically to both players. We keep
  // raw `playerIds` around so we can attribute / filter by player
  // (e.g. "scores from any group containing this playerId") without
  // re-parsing the display name. `playerIdsKey` is optional in the
  // validator only so older rooms validate during the migration
  // window — every new write fills it in.
  coopScores: defineTable({
    roomCode: v.string(),
    finishedAt: v.number(),
    name: v.string(),
    score: v.number(),
    playerIds: v.array(v.string()),
    playerIdsKey: v.optional(v.string()),
  })
    .index('by_score', ['score'])
    .index('by_room_finished', ['roomCode', 'finishedAt'])
    .index('by_group', ['playerIdsKey']),
})
