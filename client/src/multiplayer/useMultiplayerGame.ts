import { useEffect, useMemo, useRef } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { ActivePiece, GameState } from '../game/gameLogic'

export type MultiplayerStatus =
  | 'connecting'
  | 'not-found'
  | 'waiting'
  | 'playing'
  | 'gameover'

export type MultiplayerPlayer = {
  playerId: string
  name: string
  slot: number
  hand: ActivePiece[]
  handSlots: (string | null)[]
  isSelf: boolean
}

export type MultiplayerLastPlacement = NonNullable<
  NonNullable<ReturnType<typeof useQuery<typeof api.rooms.getRoom>>>['lastPlacement']
>

export type UseMultiplayerGameArgs = {
  code: string | null
  playerId: string
  name: string
}

export type MultiplayerEmote = {
  emoji: string
  ts: number
}

export type UseMultiplayerGameResult = {
  status: MultiplayerStatus
  code: string | null
  game: GameState | null
  selfPlayer: MultiplayerPlayer | null
  // Every non-self seated player, ordered by (slot - selfSlot) mod N
  // so each viewer's first entry is "the next seat after mine".
  // Indices in this array line up with hue assignments in
  // `hueShiftByPlayerId` (entry i gets (i + 1) * HUE_STEP_DEG).
  otherPlayers: MultiplayerPlayer[]
  // All seats sorted by slot, so callers (e.g. the co-op leaderboard
  // submission) can build a stable "Alice & Bob" display name that
  // reads identically to every client regardless of join order.
  allPlayers: MultiplayerPlayer[]
  // Server-stamped time of the most recent room mutation. Used as the
  // canonical "this run finished at" marker when every client races to
  // submit the gameover to the global co-op leaderboard.
  updatedAt: number | null
  lastPlacement: MultiplayerLastPlacement | null
  // cellId -> playerId map for partner-piece tinting on the shared
  // board. Empty / undefined when single-player.
  cellOwners: Record<string, string>
  // Latest emote per playerId (room.lastEmotes flattened to a map).
  // Clients enforce the 10s display window themselves so a stale ts
  // simply renders as "no emote" without needing a server cleanup.
  // Self's id is also a key in this map — its EmoteBar uses it to
  // mirror the emote it just sent.
  emoteByPlayerId: Record<string, MultiplayerEmote>
  // Hue rotation (in degrees) to apply to each player's placed cubes
  // when rendered for *this* viewer. Self maps to 0; otherPlayers[i]
  // maps to (i + 1) * 15. Drives the per-player cube tinting in App.
  hueShiftByPlayerId: Record<string, number>
  placePiece: (pieceId: string, cellId: string) => Promise<void>
  sendEmote: (emoji: string) => Promise<void>
  setName: (name: string) => Promise<void>
  restart: () => Promise<void>
  leave: () => Promise<void>
}

const HEARTBEAT_INTERVAL_MS = 8_000

// Per-step hue rotation (degrees) for partner cube tinting.
// Self renders at 0; the first partner at HUE_STEP_DEG, the second at
// 2 * HUE_STEP_DEG, etc. Picked so 8 seats fit comfortably under
// 360° and stay visually distinct against each other.
export const HUE_STEP_DEG = 15

// Synthesize a GameState off the live room snapshot so the rest of the app
// can keep reading from a single shape regardless of mode. Only the
// fields the big-mode UI actually reads are populated; daily-only fields
// are left in their no-op shape (empty objects / zeros).
const buildGameStateFromRoom = (
  room: NonNullable<ReturnType<typeof useQuery<typeof api.rooms.getRoom>>>,
  selfHand: ActivePiece[],
  selfHandSlots: (string | null)[],
): GameState => ({
  mode: 'big',
  board: room.board as GameState['board'],
  score: room.score,
  streak: room.streak,
  hand: selfHand,
  handSlots: selfHandSlots,
  gameOver: room.state === 'gameover',
  moves: room.moves,
  dailyHits: {},
  dailyTotalHits: 0,
  dailyRemainingHits: 0,
  dailyCompleted: false,
  goldenCellIds: [...room.goldenCellIds],
})

export const useMultiplayerGame = ({
  code,
  playerId,
  name,
}: UseMultiplayerGameArgs): UseMultiplayerGameResult => {
  const room = useQuery(
    api.rooms.getRoom,
    code ? { code } : 'skip',
  )
  const placePieceMutation = useMutation(api.rooms.placePiece)
  const leaveMutation = useMutation(api.rooms.leaveRoom)
  const heartbeatMutation = useMutation(api.rooms.heartbeat)
  const sendEmoteMutation = useMutation(api.rooms.sendEmote)
  const setNameMutation = useMutation(api.rooms.setPlayerName)
  const restartMutation = useMutation(api.rooms.restartRoom)

  // Periodic presence ping so the partner can tell when someone has
  // gone idle (closing tab, lost connection, etc).
  useEffect(() => {
    if (!code) return
    const tick = () => {
      heartbeatMutation({ code, playerId }).catch(() => {})
    }
    tick()
    const id = window.setInterval(tick, HEARTBEAT_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [code, playerId, heartbeatMutation])

  const selfPlayer = useMemo<MultiplayerPlayer | null>(() => {
    if (!room) return null
    const me = room.players.find((p) => p.playerId === playerId)
    if (!me) return null
    return {
      playerId: me.playerId,
      name: me.name,
      slot: me.slot,
      hand: me.hand as ActivePiece[],
      handSlots: me.handSlots as (string | null)[],
      isSelf: true,
    }
  }, [room, playerId])

  const allPlayers = useMemo<MultiplayerPlayer[]>(() => {
    if (!room) return []
    return [...room.players]
      .sort((a, b) => a.slot - b.slot)
      .map((p) => ({
        playerId: p.playerId,
        name: p.name,
        slot: p.slot,
        hand: p.hand as ActivePiece[],
        handSlots: p.handSlots as (string | null)[],
        isSelf: p.playerId === playerId,
      }))
  }, [room, playerId])

  // Every non-self player ordered by (slot - selfSlot + N) mod N.
  // That ordering means each viewer's first partner is "the next
  // seat after mine in the ring" and is stable across re-renders, so
  // hue assignments don't shuffle when somebody else's hand updates.
  // When self isn't seated yet (e.g. the room view briefly appears
  // before joinRoom finishes), we fall back to slot order.
  const otherPlayers = useMemo<MultiplayerPlayer[]>(() => {
    if (allPlayers.length === 0) return []
    const self = allPlayers.find((p) => p.isSelf)
    if (!self) return allPlayers.filter((p) => !p.isSelf)
    const N = allPlayers.length
    const ringIndex = (p: MultiplayerPlayer) =>
      (p.slot - self.slot + N) % N
    return allPlayers
      .filter((p) => !p.isSelf)
      .sort((a, b) => ringIndex(a) - ringIndex(b))
  }, [allPlayers])

  // Hue per playerId for THIS viewer. Self → 0°, otherPlayers[i] →
  // (i + 1) * HUE_STEP_DEG. Two viewers see each other at the same
  // first-partner step; a third party may see them differently
  // depending on their own ring position — this is the documented
  // trade-off for "self always renders at default hue".
  const hueShiftByPlayerId = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {}
    if (selfPlayer) out[selfPlayer.playerId] = 0
    otherPlayers.forEach((p, i) => {
      out[p.playerId] = (i + 1) * HUE_STEP_DEG
    })
    return out
  }, [selfPlayer, otherPlayers])

  const game = useMemo<GameState | null>(() => {
    if (!room || !selfPlayer) return null
    return buildGameStateFromRoom(
      room,
      selfPlayer.hand,
      selfPlayer.handSlots,
    )
  }, [room, selfPlayer])

  const status: MultiplayerStatus = useMemo(() => {
    if (!code) return 'connecting'
    if (room === undefined) return 'connecting'
    if (room === null) return 'not-found'
    if (room.state === 'gameover') return 'gameover'
    if (room.state === 'waiting') return 'waiting'
    return 'playing'
  }, [code, room])

  // Deduplicate name to keep the partner's stale name from overwriting a
  // freshly-edited self name on every poll.
  const lastNameRef = useRef<string>(name)
  useEffect(() => {
    lastNameRef.current = name
  }, [name])

  const placePiece = async (pieceId: string, cellId: string) => {
    if (!code) return
    await placePieceMutation({ code, playerId, pieceId, cellId })
  }

  const sendEmote = async (emoji: string) => {
    if (!code) return
    await sendEmoteMutation({ code, playerId, emoji })
  }

  const setName = async (nextName: string) => {
    if (!code) return
    await setNameMutation({ code, playerId, name: nextName })
  }

  const restart = async () => {
    if (!code) return
    await restartMutation({ code, playerId })
  }

  const leave = async () => {
    if (!code) return
    await leaveMutation({ code, playerId })
  }

  const cellOwners = useMemo<Record<string, string>>(() => {
    if (!room || !room.cellOwners) return {}
    return room.cellOwners
  }, [room])

  const emoteByPlayerId = useMemo<Record<string, MultiplayerEmote>>(() => {
    if (!room) return {}
    const out: Record<string, MultiplayerEmote> = {}
    for (const e of room.lastEmotes ?? []) {
      out[e.playerId] = { emoji: e.emoji, ts: e.ts }
    }
    return out
  }, [room])

  return {
    status,
    code,
    game,
    selfPlayer,
    otherPlayers,
    allPlayers,
    updatedAt: room?.updatedAt ?? null,
    lastPlacement: room?.lastPlacement ?? null,
    cellOwners,
    emoteByPlayerId,
    hueShiftByPlayerId,
    placePiece,
    sendEmote,
    setName,
    restart,
    leave,
  }
}
