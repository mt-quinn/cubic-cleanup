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
  partnerPlayer: MultiplayerPlayer | null
  // Both seats sorted by slot, so callers (e.g. the co-op leaderboard
  // submission) can build a stable "Alice & Bob" display name that
  // reads identically to both clients regardless of who joined first.
  allPlayers: MultiplayerPlayer[]
  // Server-stamped time of the most recent room mutation. Used as the
  // canonical "this run finished at" marker when both clients race to
  // submit the gameover to the global co-op leaderboard.
  updatedAt: number | null
  lastPlacement: MultiplayerLastPlacement | null
  // cellId -> playerId map for partner-piece tinting on the shared
  // board. Empty / undefined when single-player.
  cellOwners: Record<string, string>
  // Latest partner emote (or null if none / they haven't sent one).
  // Clients enforce the 10s display window themselves so a stale ts
  // simply renders as "no emote" without needing a server cleanup.
  partnerEmote: MultiplayerEmote | null
  // Latest emote *this* client sent — surfaced so the local smiley
  // button can render a small "you sent this" corner badge while
  // the partner is still seeing the emoji on their side. Same 10s
  // display window as `partnerEmote`.
  selfEmote: MultiplayerEmote | null
  placePiece: (pieceId: string, cellId: string) => Promise<void>
  sendEmote: (emoji: string) => Promise<void>
  setName: (name: string) => Promise<void>
  restart: () => Promise<void>
  leave: () => Promise<void>
}

const HEARTBEAT_INTERVAL_MS = 8_000

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

  const partnerPlayer = useMemo<MultiplayerPlayer | null>(() => {
    if (!room) return null
    const partner = room.players.find((p) => p.playerId !== playerId)
    if (!partner) return null
    return {
      playerId: partner.playerId,
      name: partner.name,
      slot: partner.slot,
      hand: partner.hand as ActivePiece[],
      handSlots: partner.handSlots as (string | null)[],
      isSelf: false,
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

  const partnerEmote = useMemo<MultiplayerEmote | null>(() => {
    if (!room || !partnerPlayer) return null
    const emote = (room.lastEmotes ?? []).find(
      (e) => e.playerId === partnerPlayer.playerId,
    )
    if (!emote) return null
    return { emoji: emote.emoji, ts: emote.ts }
  }, [room, partnerPlayer])

  const selfEmote = useMemo<MultiplayerEmote | null>(() => {
    if (!room) return null
    const emote = (room.lastEmotes ?? []).find(
      (e) => e.playerId === playerId,
    )
    if (!emote) return null
    return { emoji: emote.emoji, ts: emote.ts }
  }, [room, playerId])

  return {
    status,
    code,
    game,
    selfPlayer,
    partnerPlayer,
    allPlayers,
    updatedAt: room?.updatedAt ?? null,
    lastPlacement: room?.lastPlacement ?? null,
    cellOwners,
    partnerEmote,
    selfEmote,
    placePiece,
    sendEmote,
    setName,
    restart,
    leave,
  }
}
