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
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_code', ['code']),
})
