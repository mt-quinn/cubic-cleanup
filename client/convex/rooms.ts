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
}, hand: ActivePiece[], hold: ActivePiece | null = null): GameState => ({
  mode: MODE,
  board: { ...room.board },
  score: room.score,
  streak: room.streak,
  hand,
  handSlots: hand.map((p) => p.id),
  hold,
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
    // Which multiplayer flavor this room is. Default 'coop' preserves
    // the pre-PvP behavior for any older client / un-migrated link.
    mode: v.optional(v.union(v.literal('coop'), v.literal('pvp'))),
    // Optional snapshot of the host's current single-player co-op
    // (Big) board. When present we seed the new room with it so the
    // host's in-progress run is preserved when they invite a friend.
    // Otherwise we boot a fresh empty co-op board. We deliberately
    // skip the seed in PvP rooms so both players start from an empty
    // untinted board (a host's in-progress big run would otherwise
    // give them a head start on territory).
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
  handler: async (ctx, { playerId, name, mode, seed }) => {
    const roomMode: 'coop' | 'pvp' = mode ?? 'coop'
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

    // PvP starts fresh regardless of host's solo state so neither
    // player walks in with pre-tinted territory.
    const effectiveSeed = roomMode === 'pvp' ? undefined : seed
    const board = effectiveSeed?.board ?? createEmptyBoard(MODE)
    const goldenCellIds =
      effectiveSeed?.goldenCellIds ?? spawnInitialRubies(board, MODE, 3)
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
      mode: roomMode,
      board,
      goldenCellIds,
      score: effectiveSeed?.score ?? 0,
      streak: effectiveSeed?.streak ?? 0,
      moves: effectiveSeed?.moves ?? 0,
      players: [
        {
          playerId,
          name: sanitizeName(name),
          slot: 0,
          hand,
          handSlots: hand.map((p) => p.id),
          hold: null,
          joinedAt: now,
          lastSeen: now,
        },
      ],
      lastPlacement: null,
      cellOwners,
      cellTints: {},
      winnerPlayerId: null,
      lastEmotes: [],
      createdAt: now,
      updatedAt: now,
    })

    return { code, roomId: id, mode: roomMode }
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
    const roomMode: 'coop' | 'pvp' = room.mode ?? 'coop'
    const sanitized = sanitizeName(name)

    // Reconnect: same playerId is already in the room. Just bump lastSeen.
    const existing = room.players.find((p) => p.playerId === playerId)
    if (existing) {
      const players = room.players.map((p) =>
        p.playerId === playerId
          ? { ...p, lastSeen: now, name: sanitized }
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
      return {
        code,
        joinedAsSlot: existing.slot,
        reconnect: true,
        asSpectator: false,
      }
    }

    // Spectator reconnect: already attached as a viewer, bump lastSeen.
    const existingSpec = (room.spectators ?? []).find(
      (s) => s.playerId === playerId,
    )
    if (existingSpec) {
      const spectators = (room.spectators ?? []).map((s) =>
        s.playerId === playerId
          ? { ...s, lastSeen: now, name: sanitized }
          : s,
      )
      await ctx.db.patch(room._id, { spectators, updatedAt: now })
      return {
        code,
        joinedAsSlot: -1,
        reconnect: true,
        asSpectator: true,
      }
    }

    // PvP "first move locks the lobby" rule: once anyone has placed,
    // late arrivals via the share link can only watch. This also
    // skips the stale-seat eviction path below for PvP — a stranger
    // landing on a mid-match link should never take over an absent
    // opponent's color and territory; they just spectate. Co-op
    // continues to use the old "any open / stale seat is fair game"
    // behavior so a friend who refreshed mid-game still reclaims
    // their seat.
    const lateForPvp = roomMode === 'pvp' && room.moves > 0
    if (lateForPvp) {
      const spectators = [
        ...(room.spectators ?? []),
        {
          playerId,
          name: sanitized,
          joinedAt: now,
          lastSeen: now,
        },
      ]
      await ctx.db.patch(room._id, { spectators, updatedAt: now })
      return {
        code,
        joinedAsSlot: -1,
        reconnect: false,
        asSpectator: true,
      }
    }

    // Open seat? Just append.
    if (room.players.length < MAX_PLAYERS) {
      const hand = dealPlayableHand(room.board, 30, Math.random, MODE)
      const slot = room.players.length
      const players = [
        ...room.players,
        {
          playerId,
          name: sanitized,
          slot,
          hand,
          handSlots: hand.map((p) => p.id),
          hold: null,
          joinedAt: now,
          lastSeen: now,
        },
      ]
      await ctx.db.patch(room._id, {
        players,
        state: players.length >= 1 ? 'playing' : 'waiting',
        updatedAt: now,
      })
      return {
        code,
        joinedAsSlot: slot,
        reconnect: false,
        asSpectator: false,
      }
    }

    // Room is at MAX_PLAYERS — but is anyone stale? If yes, the new
    // joiner evicts the stalest seat and inherits its slot. Stale
    // player's cellOwners entries get re-tagged to the new player so
    // their cubes don't render as orphan / partner-tinted forever.
    // (Pre-first-move PvP is also allowed to use this path; the
    // lateForPvp branch above already excluded mid-match PvP.)
    const stalest = [...room.players]
      .filter((p) => now - p.lastSeen >= STALE_PLAYER_MS)
      .sort((a, b) => a.lastSeen - b.lastSeen)[0]
    if (!stalest) {
      // No room to seat, no stale eviction. Final fallback: park
      // them as a spectator so the link still works rather than
      // throwing a hard "room is full" error in their face.
      const spectators = [
        ...(room.spectators ?? []),
        {
          playerId,
          name: sanitized,
          joinedAt: now,
          lastSeen: now,
        },
      ]
      await ctx.db.patch(room._id, { spectators, updatedAt: now })
      return {
        code,
        joinedAsSlot: -1,
        reconnect: false,
        asSpectator: true,
      }
    }
    const hand = dealPlayableHand(room.board, 30, Math.random, MODE)
    const players = room.players.map((p) =>
      p.playerId === stalest.playerId
        ? {
            playerId,
            name: sanitized,
            slot: stalest.slot,
            hand,
            handSlots: hand.map((p2) => p2.id),
            // Evicting a stale seat starts the new occupant with an
            // empty hold — the evicted player's held piece (if any)
            // is forfeited along with their hand.
            hold: null,
            joinedAt: now,
            lastSeen: now,
          }
        : p,
    )
    const cellOwners: Record<string, string> = { ...(room.cellOwners ?? {}) }
    for (const [cellId, ownerId] of Object.entries(cellOwners)) {
      if (ownerId === stalest.playerId) cellOwners[cellId] = playerId
    }
    // Inherit the evicted seat's persistent tint territory too so PvP
    // standings stay attributed to whoever is sitting in the seat,
    // not to a ghost player who can no longer win anyway.
    const cellTints: Record<string, string> = { ...(room.cellTints ?? {}) }
    for (const [cellId, tintId] of Object.entries(cellTints)) {
      if (tintId === stalest.playerId) cellTints[cellId] = playerId
    }
    // Drop any stale hover the evicted player left behind so the
    // new occupant's first frame doesn't inherit a ghost.
    const hovers = (room.hovers ?? []).filter(
      (h) => h.playerId !== stalest.playerId,
    )
    await ctx.db.patch(room._id, {
      players,
      cellOwners,
      cellTints,
      hovers,
      state: 'playing',
      updatedAt: now,
    })
    return {
      code,
      joinedAsSlot: stalest.slot,
      reconnect: false,
      asSpectator: false,
    }
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
    // Once a game is over, heartbeats stop serving any purpose:
    // there's no stale-seat eviction to trigger, no presence to
    // track. We deliberately no-op here so `room.updatedAt` stays
    // pinned at the moment the gameover-triggering placement
    // landed. That matters because the co-op leaderboard uses
    // `lastPlacement.ts` (which equals updatedAt at gameover) as
    // the dedupe key, and any post-gameover updatedAt churn
    // re-triggers the client's "submit my run" effect with a
    // *different* key, leaking duplicate rows onto the board.
    if (room.state === 'gameover') return null
    const now = Date.now()
    // Bump whichever bucket the caller belongs to: seated player OR
    // spectator. The latter is needed so reconnect logic can tell a
    // fresh spectator from a long-stale one, and so a future
    // stale-spectator cleanup pass has something to read off.
    let touched = false
    const players = room.players.map((p) => {
      if (p.playerId !== playerId) return p
      touched = true
      return { ...p, lastSeen: now }
    })
    if (touched) {
      await ctx.db.patch(room._id, { players, updatedAt: now })
      return null
    }
    const spectators = (room.spectators ?? []).map((s) => {
      if (s.playerId !== playerId) return s
      touched = true
      return { ...s, lastSeen: now }
    })
    if (touched) {
      await ctx.db.patch(room._id, { spectators, updatedAt: now })
    }
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

    // Pieces may live in the hand OR in the player's hold slot (Tetris
    // style). The placement path treats them identically; only the
    // post-placement bookkeeping differs (a hand piece vacates a hand
    // slot, a hold piece empties the hold).
    const playerHold = (player.hold ?? null) as ActivePiece | null
    const playedFromHold =
      playerHold !== null && playerHold.id === pieceId
    const piece = playedFromHold
      ? playerHold
      : ((player.hand.find((p) => p.id === pieceId)) as
          | ActivePiece
          | undefined)
    if (!piece) throw new Error('Piece not in hand')

    const fakeGame = roomToGameState(
      room,
      player.hand as ActivePiece[],
      playerHold,
    )
    const result = applyPlacement(fakeGame, piece, cellId)
    if (!result) throw new Error('Invalid placement')

    // Snapshot the pre-placement ownership map so the tint pass below
    // can attribute every cleared cell to whoever actually placed the
    // cube that's now disappearing — clearing an opponent's tiles
    // should reward THEM with territory, not the player who triggered
    // the clear. Without this snapshot we'd lose those owners as soon
    // as we delete them from the new map.
    const prevCellOwners: Record<string, string> = room.cellOwners ?? {}

    // Update per-cell ownership: tag every cell the player just filled
    // with their playerId, then drop entries for any cells that the
    // resulting clears swept off the board so partner-owned relics
    // don't linger on cleared cells.
    const cellOwners: Record<string, string> = { ...prevCellOwners }
    for (const cellId of result.placedCellIds) {
      cellOwners[cellId] = playerId
    }
    for (const cellId of result.clearedCellIds) {
      delete cellOwners[cellId]
    }

    // Persistent tint of "who placed the cube that just got cleared
    // from this cell". Each cleared cell is attributed to the player
    // who put the cube there in the first place:
    //   * cells just placed this turn → the current placer
    //   * cells filled by an earlier turn → the prior owner from the
    //     pre-placement snapshot
    // This means clearing your opponent's tiles is a downside — you
    // hand them more PvP territory. Tints survive future placements
    // until another clear overwrites them.
    const placedThisTurn = new Set<string>(result.placedCellIds)
    const cellTints: Record<string, string> = { ...(room.cellTints ?? {}) }
    for (const cellId of result.clearedCellIds) {
      const placerForCell = placedThisTurn.has(cellId)
        ? playerId
        : prevCellOwners[cellId]
      if (placerForCell) {
        cellTints[cellId] = placerForCell
      }
    }

    // New per-player hand / hold. Two cases:
    //   1) Played from hand: drop the played piece out of hand, keep hold
    //      untouched. If the hand is now empty, deal a fresh playable hand.
    //   2) Played from hold: hand is unchanged, hold becomes null.
    let newHand: ActivePiece[]
    let newHandSlots: (string | null)[]
    let newHold: ActivePiece | null = playerHold

    if (playedFromHold) {
      newHand = player.hand as ActivePiece[]
      newHandSlots = player.handSlots
      newHold = null
    } else {
      const remainingHand = (player.hand as ActivePiece[]).filter(
        (p) => p.id !== piece.id,
      )
      const remainingSlots = player.handSlots.map((id) =>
        id === piece.id ? null : id,
      )

      newHand = remainingHand
      newHandSlots = remainingSlots

      if (remainingHand.length === 0) {
        const dealt = dealPlayableHand(result.board, 30, Math.random, MODE)
        newHand = dealt
        newHandSlots = dealt.map((p) => p.id)
      }
    }

    const updatedPlayers = room.players.map((p, i) =>
      i === playerIndex
        ? {
            ...p,
            hand: newHand,
            handSlots: newHandSlots,
            hold: newHold,
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
    // their current hand AND their held piece. With N-seat rooms we
    // have to scan all of them — the old "find the other seat"
    // check was 2-player only. The held piece is included as a move
    // source so a player whose three hand pieces are blocked but
    // whose held piece can still be placed keeps the match alive.
    const anyoneCanMove = updatedPlayers.some((p) =>
      hasAnyValidMove(
        result.board,
        p.hand as ActivePiece[],
        MODE,
        (p.hold ?? null) as ActivePiece | null,
      ),
    )
    const stuckGameOver = !anyoneCanMove

    // PvP instant-win check. After applying this placement's tints,
    // count how many cells each seated player owns. The first one
    // past (1/N + 0.05) of the board — equivalent to the user-facing
    // (100/N)+5% rule — wins immediately and ends the match. The
    // extra 5 % over parity keeps the post-fill stretch competitive
    // when seated players are otherwise neck and neck. In co-op we
    // skip this entirely; in stuck SHAME the winner stays null.
    const roomMode: 'coop' | 'pvp' = room.mode ?? 'coop'
    let winnerPlayerId: string | null = room.winnerPlayerId ?? null
    if (roomMode === 'pvp' && winnerPlayerId === null) {
      const totalCells = Object.keys(result.board).length
      const seatedCount = updatedPlayers.length
      if (totalCells > 0 && seatedCount > 0) {
        const tintCounts = new Map<string, number>()
        for (const ownerId of Object.values(cellTints)) {
          tintCounts.set(ownerId, (tintCounts.get(ownerId) ?? 0) + 1)
        }
        // (100/N)+5% in cell units. ceil so a board that doesn't
        // divide evenly still requires a strictly-better-than-parity
        // win, and clamp to at least one cell over parity for tiny
        // boards where the 5% slack rounds to zero.
        const parity = totalCells / seatedCount
        const slack = Math.max(1, Math.ceil(totalCells * 0.05))
        const threshold = Math.ceil(parity + slack)
        // Only seated players can win; tints left behind by a
        // disconnected player don't count toward an absent victor.
        const seatedIds = new Set(updatedPlayers.map((p) => p.playerId))
        for (const seatedId of seatedIds) {
          const count = tintCounts.get(seatedId) ?? 0
          if (count >= threshold) {
            winnerPlayerId = seatedId
            break
          }
        }
      }
    }

    // Compose the final game-over flag: either everyone is stuck
    // (SHAME in PvP, normal co-op end) OR a PvP winner has crossed
    // the threshold this placement.
    const gameOver = stuckGameOver || winnerPlayerId !== null

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

    // The piece this player was hovering with just got placed (or
    // discarded if their hand redealt), so its hover entry is now
    // stale by definition. Strip it so partners don't see the ghost
    // linger for the throttle window after the placement has
    // already animated in.
    const hovers = (room.hovers ?? []).filter((h) => h.playerId !== playerId)

    await ctx.db.patch(room._id, {
      board: result.board,
      goldenCellIds: result.goldenCellIds,
      score: newScore,
      streak: newStreak,
      moves: newMoves,
      players: updatedPlayers,
      lastPlacement,
      cellOwners,
      cellTints,
      winnerPlayerId,
      hovers,
      state: gameOver ? 'gameover' : 'playing',
      updatedAt: now,
    })

    return {
      pointsGained: result.pointsGained,
      cleared,
      boardCleared: result.boardCleared,
      gameOver,
      winnerPlayerId,
    }
  },
})

// Park / swap / pull a piece between this player's hand and their
// single-slot hold buffer. Atomic and authoritative so two clients
// can't race their hold state out of sync. `target` is either the
// hold slot or a specific hand slot index. Four cases:
//   1) source=hand, target=hold (empty) — park
//   2) source=hand, target=hold (full)  — swap; held piece goes to
//      the vacated hand slot
//   3) source=hold, target=hand[N] (empty) — pull into hand
//   4) source=hold, target=hand[N] (full)  — swap; displaced hand
//      piece goes to hold
// If parking the last hand piece would leave the hand empty we deal
// a fresh playable hand against the current board (mirrors the
// single-player rule and keeps the room in a playable state).
//
// We deliberately do not write `lastPlacement` or recompute the
// game-over flag here. Swapping itself doesn't change the board
// state, and any subsequent placement re-runs the full game-over
// check via `placePiece` with the new hand/hold included.
export const holdSwap = mutation({
  args: {
    code: v.string(),
    playerId: v.string(),
    sourcePieceId: v.string(),
    target: v.union(
      v.object({ kind: v.literal('hold') }),
      v.object({
        kind: v.literal('hand'),
        slotIndex: v.number(),
      }),
    ),
  },
  handler: async (
    ctx,
    { code, playerId, sourcePieceId, target },
  ) => {
    const room = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    if (!room) throw new Error('Room not found')
    if (room.state === 'gameover') {
      throw new Error('Game already over')
    }

    const playerIndex = room.players.findIndex(
      (p) => p.playerId === playerId,
    )
    if (playerIndex < 0) throw new Error('You are not in this room')
    const player = room.players[playerIndex]

    const playerHold = (player.hold ?? null) as ActivePiece | null
    const sourceInHand = player.hand.find(
      (p) => p.id === sourcePieceId,
    ) as ActivePiece | undefined
    const sourceFromHold =
      playerHold !== null && playerHold.id === sourcePieceId
        ? playerHold
        : null

    if (!sourceInHand && !sourceFromHold) {
      throw new Error('Source piece not in hand or hold')
    }

    let newHand = [...player.hand] as ActivePiece[]
    let newHandSlots = [...player.handSlots]
    let newHold: ActivePiece | null = playerHold

    if (sourceInHand) {
      // source is hand → target must be hold (no hand-to-hand drags).
      if (target.kind !== 'hold') {
        throw new Error('Hand-to-hand swaps are not supported')
      }
      const sourceSlotIndex = player.handSlots.findIndex(
        (id) => id === sourceInHand.id,
      )
      if (sourceSlotIndex < 0) {
        throw new Error('Source piece slot not found')
      }
      // Drop the source out of the hand; swap in the previously-held
      // piece (if any) at the same slot to keep slot positions stable.
      newHand = newHand.filter((p) => p.id !== sourceInHand.id)
      if (playerHold) {
        newHand = [...newHand, playerHold]
        newHandSlots[sourceSlotIndex] = playerHold.id
      } else {
        newHandSlots[sourceSlotIndex] = null
      }
      newHold = sourceInHand
    } else if (sourceFromHold) {
      // source is hold → target must be hand[N].
      if (target.kind !== 'hand') {
        throw new Error('Hold-to-hold swaps are a no-op')
      }
      const idx = target.slotIndex
      if (idx < 0 || idx >= newHandSlots.length) {
        throw new Error('Invalid target hand slot')
      }
      const existingId = newHandSlots[idx]
      const existing = existingId
        ? (newHand.find((p) => p.id === existingId) as
            | ActivePiece
            | undefined)
        : null
      if (existing) {
        // Swap: existing hand piece goes to hold; source goes into slot.
        newHand = newHand.filter((p) => p.id !== existing.id)
        newHand = [...newHand, sourceFromHold]
        newHandSlots[idx] = sourceFromHold.id
        newHold = existing
      } else {
        // Pull: empty hand slot is filled by the source; hold empties.
        newHand = [...newHand, sourceFromHold]
        newHandSlots[idx] = sourceFromHold.id
        newHold = null
      }
    }

    // If the swap left the hand empty (e.g. player parked their final
    // hand piece into an empty hold while their hand was already
    // running low), deal a fresh playable hand against the current
    // board. Same rule as a normal placement that consumed the last
    // hand piece.
    if (newHand.length === 0) {
      const dealt = dealPlayableHand(room.board, 30, Math.random, MODE)
      newHand = dealt
      newHandSlots = dealt.map((p) => p.id)
    }

    const now = Date.now()
    const updatedPlayers = room.players.map((p, i) =>
      i === playerIndex
        ? {
            ...p,
            hand: newHand,
            handSlots: newHandSlots,
            hold: newHold,
            lastSeen: now,
          }
        : p,
    )

    await ctx.db.patch(room._id, {
      players: updatedPlayers,
      updatedAt: now,
    })

    return null
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
        hold: null,
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
      // Wipe persistent tints and any prior winner so the next match
      // is a clean territory race. Mode is intentionally preserved —
      // restarting a PvP room gives you another PvP match.
      cellTints: {},
      winnerPlayerId: null,
      lastEmotes: [],
      hovers: [],
      state: players.length >= 1 ? 'playing' : 'waiting',
      updatedAt: now,
    })
    return null
  },
})

// Wipe a PvP room's board so the host can re-share the link from a
// clean state. The lobby's "Copy Link" button fires this when the
// host is still alone in the room and may have placed a piece or
// two before realizing they wanted to invite someone; in that case
// we erase their pre-placed cubes / tints so the link they're
// putting on the clipboard lands on a fresh match. The moment
// anyone else has attached (seated OR spectating) the session is
// considered formed and this mutation is a no-op — wiping mid-game
// would yank everyone's progress out from under them. Co-op rooms
// also no-op (their in-progress big board is the host's invite to
// help, not a head-start to undo).
export const prepareRoomForShare = mutation({
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
    const roomMode: 'coop' | 'pvp' = room.mode ?? 'coop'
    if (roomMode !== 'pvp') return null

    // "Host is alone" guard: only the host's own pre-placed pieces
    // are recoverable. Once a partner or spectator is present the
    // host has implicitly committed to this match.
    const hostIsAlone =
      room.players.length <= 1 && (room.spectators?.length ?? 0) === 0
    if (!hostIsAlone) return null

    const noWork =
      room.moves === 0 &&
      (room.cellOwners == null ||
        Object.keys(room.cellOwners).length === 0) &&
      (room.cellTints == null ||
        Object.keys(room.cellTints).length === 0)
    if (noWork) return null

    const now = Date.now()
    const board = createEmptyBoard(MODE)
    const goldenCellIds = spawnInitialRubies(board, MODE, 3)
    const players = room.players.map((p, i) => {
      const hand = dealPlayableHand(board, 30, Math.random, MODE)
      return {
        ...p,
        slot: i,
        hand,
        handSlots: hand.map((piece) => piece.id),
        hold: null,
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
      cellTints: {},
      winnerPlayerId: null,
      lastEmotes: [],
      hovers: [],
      state: players.length >= 1 ? 'playing' : 'waiting',
      updatedAt: now,
    })
    return null
  },
})

// Live hover broadcast. Each client throttles this to ~10 Hz while
// dragging / hovering a piece so partners can see a tinted ghost of
// what the player is about to drop, in close to real time. Clients
// fade out hovers older than ~3s themselves so an abandoned tab
// stops projecting a ghost without us needing a server cleanup.
//
// `pieceId === null` is the "I'm no longer hovering anything" signal
// (mouse left the board, drag ended without a placement, etc) and
// strips the entry. Any other call upserts the player's entry with a
// fresh timestamp.
export const setHover = mutation({
  args: {
    code: v.string(),
    playerId: v.string(),
    pieceId: v.union(v.string(), v.null()),
    cellId: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { code, playerId, pieceId, cellId }) => {
    const room = await ctx.db
      .query('rooms')
      .withIndex('by_code', (q) => q.eq('code', code))
      .unique()
    if (!room) return null
    if (!room.players.some((p) => p.playerId === playerId)) {
      return null
    }
    const now = Date.now()
    const others = (room.hovers ?? []).filter(
      (h) => h.playerId !== playerId,
    )
    const next =
      pieceId && cellId
        ? [...others, { playerId, pieceId, cellId, ts: now }]
        : others
    await ctx.db.patch(room._id, { hovers: next })
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
    const remainingSpectators = (room.spectators ?? []).filter(
      (s) => s.playerId !== playerId,
    )
    if (
      room.state === 'gameover' &&
      remaining.length === 0 &&
      remainingSpectators.length === 0
    ) {
      await ctx.db.delete(room._id)
      return null
    }
    const hovers = (room.hovers ?? []).filter((h) => h.playerId !== playerId)
    // "Waiting" only really applies to seated players — if seats have
    // emptied, the next person to click the link should re-seat. A
    // lingering spectator shouldn't keep the room in "playing".
    const nextState =
      room.state === 'gameover'
        ? 'gameover'
        : remaining.length === 0
          ? 'waiting'
          : room.state
    await ctx.db.patch(room._id, {
      players: remaining,
      spectators: remainingSpectators,
      hovers,
      state: nextState,
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
