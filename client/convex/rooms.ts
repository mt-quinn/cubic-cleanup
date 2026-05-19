import { mutation, query } from './_generated/server'
import { v } from 'convex/values'
import {
  applyPlacement,
  createEmptyBoard,
  dealPlayableHand,
  hasAnyValidMove,
  spawnInitialRubies,
  type ActivePiece,
  type GameMode,
  type GameState,
} from '../src/game/gameLogic'

// ---------- helpers ---------------------------------------------------------

const ROOM_CODE_LEN = 4
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

const generateRoomCode = (): string => {
  let out = ''
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    out += ROOM_CODE_ALPHABET.charAt(
      Math.floor(Math.random() * ROOM_CODE_ALPHABET.length),
    )
  }
  return out
}

const MODE: GameMode = 'big'
const MAX_PLAYERS = 2

const sanitizeName = (raw: string): string => {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return 'Player'
  return trimmed.slice(0, 20)
}

// Build a GameState shaped object from a room row so we can call into the
// existing pure game logic. Each player has their own hand, but every
// other field is shared across the room.
const roomToGameState = (room: {
  board: Record<string, 'empty' | 'filled'>
  score: number
  streak: number
  moves: number
  goldenCellIds: string[]
}, hand: ActivePiece[]): GameState => ({
  mode: MODE,
  board: { ...room.board },
  score: room.score,
  streak: room.streak,
  hand,
  handSlots: hand.map((p) => p.id),
  gameOver: false,
  moves: room.moves,
  dailyHits: {},
  dailyTotalHits: 0,
  dailyRemainingHits: 0,
  dailyCompleted: false,
  goldenCellIds: [...room.goldenCellIds],
})

// ---------- queries ---------------------------------------------------------

export const getRoom = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const room = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    return room ?? null
  },
})

// ---------- mutations -------------------------------------------------------

export const createRoom = mutation({
  args: {
    playerId: v.string(),
    name: v.string(),
  },
  handler: async (ctx, { playerId, name }) => {
    // Try a few times to land on an unused code. Collisions are rare with
    // a 24^4 alphabet (~330k) so this almost always lands on the first.
    let code: string | null = null
    for (let i = 0; i < 8; i++) {
      const candidate = generateRoomCode()
      const existing = await ctx.db
        .query('rooms')
        .withIndex('by_code', (q) => q.eq('code', candidate))
        .first()
      if (!existing) {
        code = candidate
        break
      }
    }
    if (!code) {
      throw new Error('Could not allocate a free room code, try again')
    }

    const board = createEmptyBoard(MODE)
    const goldenCellIds = spawnInitialRubies(board, MODE, 3)
    const hand = dealPlayableHand(board, 30, Math.random, MODE)
    const now = Date.now()

    const id = await ctx.db.insert('rooms', {
      code,
      state: 'waiting',
      board,
      goldenCellIds,
      score: 0,
      streak: 0,
      moves: 0,
      players: [
        {
          playerId,
          name: sanitizeName(name),
          slot: 0,
          hand,
          handSlots: hand.map((p) => p.id),
          joinedAt: now,
          lastSeen: now,
        },
      ],
      lastPlacement: null,
      createdAt: now,
      updatedAt: now,
    })

    return { code, roomId: id }
  },
})

export const joinRoom = mutation({
  args: {
    code: v.string(),
    playerId: v.string(),
    name: v.string(),
  },
  handler: async (ctx, { code, playerId, name }) => {
    const room = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    if (!room) throw new Error('Room not found')

    const now = Date.now()

    // Reconnect: same playerId is already in the room. Just bump lastSeen.
    const existing = room.players.find((p) => p.playerId === playerId)
    if (existing) {
      const players = room.players.map((p) =>
        p.playerId === playerId
          ? { ...p, lastSeen: now, name: sanitizeName(name) }
          : p,
      )
      await ctx.db.patch(room._id, { players, updatedAt: now })
      return { code, joinedAsSlot: existing.slot, reconnect: true }
    }

    if (room.players.length >= MAX_PLAYERS) {
      throw new Error('Room is full')
    }

    // Deal a fresh hand for player 2 against the live shared board.
    const hand = dealPlayableHand(room.board, 30, Math.random, MODE)
    const slot = room.players.length

    const players = [
      ...room.players,
      {
        playerId,
        name: sanitizeName(name),
        slot,
        hand,
        handSlots: hand.map((p) => p.id),
        joinedAt: now,
        lastSeen: now,
      },
    ]

    await ctx.db.patch(room._id, {
      players,
      state: players.length >= MAX_PLAYERS ? 'playing' : 'waiting',
      updatedAt: now,
    })

    return { code, joinedAsSlot: slot, reconnect: false }
  },
})

export const heartbeat = mutation({
  args: { code: v.string(), playerId: v.string() },
  handler: async (ctx, { code, playerId }) => {
    const room = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    if (!room) return null
    const now = Date.now()
    const players = room.players.map((p) =>
      p.playerId === playerId ? { ...p, lastSeen: now } : p,
    )
    await ctx.db.patch(room._id, { players, updatedAt: now })
    return null
  },
})

// Server-validated piece placement. Mirrors the single-player flow:
// applyPlacement -> update shared board / score / streak -> redeal hand
// when a player has used all three pieces -> recompute game over.
export const placePiece = mutation({
  args: {
    code: v.string(),
    playerId: v.string(),
    pieceId: v.string(),
    cellId: v.string(),
  },
  handler: async (ctx, { code, playerId, pieceId, cellId }) => {
    const room = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    if (!room) throw new Error('Room not found')
    if (room.state === 'gameover') {
      throw new Error('Game already over')
    }
    if (room.state === 'waiting') {
      throw new Error('Waiting for second player')
    }

    const playerIndex = room.players.findIndex((p) => p.playerId === playerId)
    if (playerIndex < 0) throw new Error('You are not in this room')
    const player = room.players[playerIndex]

    const piece = player.hand.find((p) => p.id === pieceId) as
      | ActivePiece
      | undefined
    if (!piece) throw new Error('Piece not in hand')

    const fakeGame = roomToGameState(room, player.hand as ActivePiece[])
    const result = applyPlacement(fakeGame, piece, cellId)
    if (!result) throw new Error('Invalid placement')

    // New per-player hand: drop the just-played piece. If that empties the
    // player's hand, deal a fresh playable hand against the new board.
    const remainingHand = (player.hand as ActivePiece[]).filter(
      (p) => p.id !== piece.id,
    )
    const remainingSlots = player.handSlots.map((id) =>
      id === piece.id ? null : id,
    )

    let newHand = remainingHand
    let newHandSlots = remainingSlots

    if (remainingHand.length === 0) {
      const dealt = dealPlayableHand(result.board, 30, Math.random, MODE)
      newHand = dealt
      newHandSlots = dealt.map((p) => p.id)
    }

    const updatedPlayers = room.players.map((p, i) =>
      i === playerIndex
        ? {
            ...p,
            hand: newHand,
            handSlots: newHandSlots,
            lastSeen: Date.now(),
          }
        : p,
    )

    // Streak / score / moves all live on the room. Streak follows the
    // single-player rule: a placement that clears anything increments it,
    // anything else resets to 0.
    const cleared = result.clearedPatterns.length > 0
    const newStreak = cleared ? room.streak + 1 : 0
    const newScore = room.score + result.pointsGained + piece.shape.size
    const newMoves = room.moves + 1

    // Game over when neither player has any valid move on their hand.
    const otherPlayer = updatedPlayers.find((_, i) => i !== playerIndex)
    const playerCanMove = hasAnyValidMove(
      result.board,
      newHand as ActivePiece[],
      MODE,
    )
    const otherCanMove = otherPlayer
      ? hasAnyValidMove(
          result.board,
          otherPlayer.hand as ActivePiece[],
          MODE,
        )
      : true
    const gameOver = !(playerCanMove || otherCanMove)

    const now = Date.now()

    const lastPlacement = {
      token: now,
      byPlayerId: playerId,
      pieceShape: piece.shape,
      originCellId: cellId,
      placedCellIds: result.placedCellIds,
      clearedCellIds: result.clearedCellIds,
      clearedPatternIds: result.clearedPatterns.map((p) => p.id),
      pointsGained: result.pointsGained,
      comboMultiplier: result.comboMultiplier,
      streakMultiplier: result.streakMultiplier,
      streakAfter: newStreak,
      rubiesCleared: result.rubiesCleared,
      prevGoldenCellIds: room.goldenCellIds,
      newGoldenCellIds: result.goldenCellIds,
      boardCleared: result.boardCleared,
      ts: now,
    }

    await ctx.db.patch(room._id, {
      board: result.board,
      goldenCellIds: result.goldenCellIds,
      score: newScore,
      streak: newStreak,
      moves: newMoves,
      players: updatedPlayers,
      lastPlacement,
      state: gameOver ? 'gameover' : 'playing',
      updatedAt: now,
    })

    return {
      pointsGained: result.pointsGained,
      cleared,
      boardCleared: result.boardCleared,
      gameOver,
    }
  },
})

// Bail out of a room. We don't actually delete anything — leaving just
// nudges the room into a non-playing state so the UI can show "your
// partner left". MVP keeps this simple.
export const leaveRoom = mutation({
  args: { code: v.string(), playerId: v.string() },
  handler: async (ctx, { code, playerId }) => {
    const room = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    if (!room) return null
    const remaining = room.players.filter((p) => p.playerId !== playerId)
    if (remaining.length === 0) {
      await ctx.db.delete(room._id)
      return null
    }
    await ctx.db.patch(room._id, {
      players: remaining,
      state: 'waiting',
      updatedAt: Date.now(),
    })
    return null
  },
})
