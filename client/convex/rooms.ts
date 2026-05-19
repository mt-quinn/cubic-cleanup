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
// Up to 8 seats per room. Picked so the +15° hue ladder stays well
// under the 360° wrap (8 × 15° = 120°), and so the SmileyRow header
// stays readable in both themes without needing to two-row in the
// common case. Bumping this further is safe at the schema level —
// every server path already iterates `room.players` — but the
// header chrome would need a wrap pass.
const MAX_PLAYERS = 8

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
    // Optional snapshot of the host's current single-player co-op
    // (Big) board. When present we seed the new room with it so the
    // host's in-progress run is preserved when they invite a friend.
    // Otherwise we boot a fresh empty co-op board.
    seed: v.optional(
      v.object({
        board: v.record(
          v.string(),
          v.union(v.literal('empty'), v.literal('filled')),
        ),
        goldenCellIds: v.array(v.string()),
        score: v.number(),
        streak: v.number(),
        moves: v.number(),
      }),
    ),
  },
  handler: async (ctx, { playerId, name, seed }) => {
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

    const board = seed?.board ?? createEmptyBoard(MODE)
    const goldenCellIds =
      seed?.goldenCellIds ?? spawnInitialRubies(board, MODE, 3)
    const hand = dealPlayableHand(board, 30, Math.random, MODE)
    const now = Date.now()

    // Initial ruby cells were just placed by the room itself, not by a
    // human player. Leaving their ownership unset means they'll render
    // in the default palette regardless of which player is looking,
    // which is what we want for "neutral" rubies. When seeding from
    // a host's solo board we likewise leave ownership empty — the
    // host's pre-existing cubes can render to both players in the
    // default palette since they pre-date the partnership.
    const cellOwners: Record<string, string> = {}

    const id = await ctx.db.insert('rooms', {
      code,
      state: 'waiting',
      board,
      goldenCellIds,
      score: seed?.score ?? 0,
      streak: seed?.streak ?? 0,
      moves: seed?.moves ?? 0,
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
      cellOwners,
      lastEmotes: [],
      createdAt: now,
      updatedAt: now,
    })

    return { code, roomId: id }
  },
})

// A player whose lastSeen is older than this is considered
// disconnected for the purposes of seat reclamation. The client
// heartbeats every 8s, so this gives ~3 missed heartbeats before
// someone else can take their seat.
const STALE_PLAYER_MS = 30_000

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

    if (room.state === 'gameover') {
      throw new Error('That game has already finished')
    }

    const now = Date.now()

    // Reconnect: same playerId is already in the room. Just bump lastSeen.
    const existing = room.players.find((p) => p.playerId === playerId)
    if (existing) {
      const players = room.players.map((p) =>
        p.playerId === playerId
          ? { ...p, lastSeen: now, name: sanitizeName(name) }
          : p,
      )
      // With N-seat rooms the "waiting" gate is purely "no one is
      // here yet". Any seated player can play solo on the shared
      // board, so we flip to 'playing' as soon as anyone is in.
      const nextState = players.length >= 1 ? 'playing' : 'waiting'
      await ctx.db.patch(room._id, {
        players,
        state: nextState,
        updatedAt: now,
      })
      return { code, joinedAsSlot: existing.slot, reconnect: true }
    }

    // Open seat? Just append.
    if (room.players.length < MAX_PLAYERS) {
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
        state: players.length >= 1 ? 'playing' : 'waiting',
        updatedAt: now,
      })
      return { code, joinedAsSlot: slot, reconnect: false }
    }

    // Room is at MAX_PLAYERS — but is anyone stale? If yes, the new
    // joiner evicts the stalest seat and inherits its slot. Stale
    // player's cellOwners entries get re-tagged to the new player so
    // their cubes don't render as orphan / partner-tinted forever.
    const stalest = [...room.players]
      .filter((p) => now - p.lastSeen >= STALE_PLAYER_MS)
      .sort((a, b) => a.lastSeen - b.lastSeen)[0]
    if (!stalest) {
      throw new Error('Room is full')
    }
    const hand = dealPlayableHand(room.board, 30, Math.random, MODE)
    const players = room.players.map((p) =>
      p.playerId === stalest.playerId
        ? {
            playerId,
            name: sanitizeName(name),
            slot: stalest.slot,
            hand,
            handSlots: hand.map((p2) => p2.id),
            joinedAt: now,
            lastSeen: now,
          }
        : p,
    )
    const cellOwners: Record<string, string> = { ...(room.cellOwners ?? {}) }
    for (const [cellId, ownerId] of Object.entries(cellOwners)) {
      if (ownerId === stalest.playerId) cellOwners[cellId] = playerId
    }
    await ctx.db.patch(room._id, {
      players,
      cellOwners,
      state: 'playing',
      updatedAt: now,
    })
    return { code, joinedAsSlot: stalest.slot, reconnect: false }
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
    // We deliberately don't refuse placement while the room is
    // still in 'waiting'. Per the new co-op flow, the host plays
    // on the shared board straight away (no waiting overlay) and
    // any partner who joins later inherits the in-progress board.

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

    // Update per-cell ownership: tag every cell the player just filled
    // with their playerId, then drop entries for any cells that the
    // resulting clears swept off the board so partner-tinted relics
    // don't linger on cleared cells.
    const cellOwners: Record<string, string> = { ...(room.cellOwners ?? {}) }
    for (const cellId of result.placedCellIds) {
      cellOwners[cellId] = playerId
    }
    for (const cellId of result.clearedCellIds) {
      delete cellOwners[cellId]
    }

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

    // Game over when EVERY seated player is out of valid moves on
    // their current hand. With N-seat rooms we have to scan all of
    // them — the old "find the other seat" check was 2-player only.
    const anyoneCanMove = updatedPlayers.some((p) =>
      hasAnyValidMove(result.board, p.hand as ActivePiece[], MODE),
    )
    const gameOver = !anyoneCanMove

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
      cellOwners,
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

// Update a player's display name mid-session. Only changes how the
// partner sees you in the co-op HUD — it doesn't touch
// `cubic-player-name` in localStorage, so the leaderboard auto-fill
// still uses whatever the player typed last time they saved a high
// score. Idempotent on identical input.
export const setPlayerName = mutation({
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
    if (!room) return null
    const sanitized = sanitizeName(name)
    let touched = false
    const players = room.players.map((p) => {
      if (p.playerId !== playerId) return p
      if (p.name === sanitized) return p
      touched = true
      return { ...p, name: sanitized }
    })
    if (!touched) return null
    await ctx.db.patch(room._id, { players, updatedAt: Date.now() })
    return null
  },
})

// Send an emote to the partner. We just stash the latest one per
// player on the room; clients render the partner's emoji in their
// smiley button for 10s after `ts`. The 10s window is enforced
// client-side by comparing Date.now() to ts so we don't have to run
// any cleanup jobs.
const ALLOWED_EMOTES = new Set([
  '⏸️',
  '▶️',
  '🤣',
  '😭',
  '🎉',
  '💀',
  '😍',
  '🙂\u200d↕\ufe0f',
  '🙂\u200d↔\ufe0f',
])

export const sendEmote = mutation({
  args: {
    code: v.string(),
    playerId: v.string(),
    emoji: v.string(),
  },
  handler: async (ctx, { code, playerId, emoji }) => {
    if (!ALLOWED_EMOTES.has(emoji)) {
      throw new Error('Unknown emote')
    }
    const room = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    if (!room) throw new Error('Room not found')
    if (!room.players.some((p) => p.playerId === playerId)) {
      throw new Error('You are not in this room')
    }
    const now = Date.now()
    const prior = (room.lastEmotes ?? []).filter(
      (e) => e.playerId !== playerId,
    )
    const lastEmotes = [...prior, { playerId, emoji, ts: now }]
    await ctx.db.patch(room._id, { lastEmotes, updatedAt: now })
    return null
  },
})

// Reset a room to a fresh game while keeping every player seated.
// Used by the in-modal "New game" CTA at game over so two players
// can immediately re-rack against the same partner without going
// through the create/share/join dance again. Either player can
// trigger it; if both fire near-simultaneously the second wins
// (idempotent reset to a fresh empty board).
export const restartRoom = mutation({
  args: { code: v.string(), playerId: v.string() },
  handler: async (ctx, { code, playerId }) => {
    const room = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    if (!room) throw new Error('Room not found')
    if (!room.players.some((p) => p.playerId === playerId)) {
      throw new Error('You are not in this room')
    }
    const now = Date.now()
    const board = createEmptyBoard(MODE)
    const goldenCellIds = spawnInitialRubies(board, MODE, 3)
    const players = room.players.map((p) => {
      const hand = dealPlayableHand(board, 30, Math.random, MODE)
      return {
        ...p,
        hand,
        handSlots: hand.map((piece) => piece.id),
        lastSeen: now,
      }
    })
    await ctx.db.patch(room._id, {
      board,
      goldenCellIds,
      score: 0,
      streak: 0,
      moves: 0,
      players,
      lastPlacement: null,
      cellOwners: {},
      lastEmotes: [],
      state: players.length >= 1 ? 'playing' : 'waiting',
      updatedAt: now,
    })
    return null
  },
})

// Bail out of a room. The seat opens up so anyone with the link
// can take it (durable links). We deliberately do NOT delete the
// room when the last player leaves — the shared board state is
// preserved until either (a) someone reaches gameover or (b) the
// daily janitor cron prunes it for being idle past the TTL.
// Gameover rooms get cleared so the next person clicking the link
// can start fresh, since we currently don't surface "post-mortem"
// boards to anyone outside that finished session anyway.
export const leaveRoom = mutation({
  args: { code: v.string(), playerId: v.string() },
  handler: async (ctx, { code, playerId }) => {
    const room = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    if (!room) return null
    const remaining = room.players.filter((p) => p.playerId !== playerId)
    if (room.state === 'gameover' && remaining.length === 0) {
      await ctx.db.delete(room._id)
      return null
    }
    await ctx.db.patch(room._id, {
      players: remaining,
      state: room.state === 'gameover' ? 'gameover' : 'waiting',
      updatedAt: Date.now(),
    })
    return null
  },
})

// Daily janitor: prunes any room that hasn't been touched in over
// 24h. We need this so abandoned rooms (both players closed their
// tabs without leaving and never came back) don't pile up forever
// in the rooms table.
export const cleanupStaleRooms = mutation({
  args: {},
  handler: async (ctx) => {
    const TTL_MS = 24 * 60 * 60 * 1000
    const cutoff = Date.now() - TTL_MS
    const stale = await ctx.db.query('rooms').collect()
    let removed = 0
    for (const room of stale) {
      if (room.updatedAt < cutoff) {
        await ctx.db.delete(room._id)
        removed += 1
      }
    }
    return { removed }
  },
})
