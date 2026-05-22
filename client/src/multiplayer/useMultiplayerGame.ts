import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  // Single-piece "hold" buffer per Tetris-style hold mechanic. Only
  // surfaced for self (we don't render partner holds).
  hold: ActivePiece | null
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

export type RoomMode = 'coop' | 'pvp'

// Per-player share of the PvP territory. `count` is the raw cell count
// owned (last clear attribution), `ratio` is count / totalCells. The
// HUD reads these directly to size race-bar segments and show %s.
export type PvpStandingsEntry = {
  playerId: string
  count: number
  ratio: number
}

export type MultiplayerEmote = {
  emoji: string
  ts: number
}

// Live "where is this player hovering?" snapshot. Stripped down to
// just what the renderer needs to draw a ghost: which piece, which
// origin cell. We carry the timestamp so the consumer can fade out
// stale entries without coordinating with the server.
export type MultiplayerHover = {
  pieceId: string
  cellId: string
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
  // Which multiplayer flavor this room is running. Defaults to 'coop'
  // for any legacy rooms that pre-date the field.
  mode: RoomMode
  // cellId -> playerId map for partner-piece tinting on the shared
  // board. Empty / undefined when single-player.
  cellOwners: Record<string, string>
  // Persistent "who last cleared this cell" map. Survives subsequent
  // fills until another clear overwrites it. Drives the empty-cell
  // tint render and the PvP territory race.
  cellTints: Record<string, string>
  // Cells where the current placer (cellOwners) and the persistent
  // tinter (cellTints) are different players — a temporary occupant
  // sitting on someone else's territory. Renderer draws a colored
  // ring around these.
  conflictCellIds: Set<string>
  // Per-player tint counts + ratios for the PvP HUD. Sorted by ratio
  // desc so the leaderboard renders top-down without re-sorting.
  // Empty in co-op rooms.
  pvpStandings: PvpStandingsEntry[]
  // Total cells on the shared board (denominator for ratios). 0 until
  // the room's board is observed.
  pvpTotalCells: number
  // (1/N) ratio above which a player has crossed the win threshold.
  // Renderer draws the threshold marker at this position on the race
  // bar. 0 in co-op.
  pvpThresholdRatio: number
  // Set the moment a PvP player crosses the threshold; null in co-op
  // or when a PvP match ends in SHAME. Drives the win modal vs SHAME
  // branching at game over.
  winnerPlayerId: string | null
  // True when this viewer is attached to the room as a read-only
  // spectator (not seated, no hand). Lobby UI uses this to hide the
  // hand strip and surface a "Spectating" badge.
  isSpectator: boolean
  // Total number of spectators currently watching the room (includes
  // self if isSpectator). Used by the spectator HUD strip to call out
  // "+N watching" when more than one observer is attached.
  spectatorCount: number
  // Latest emote per playerId (room.lastEmotes flattened to a map).
  // Clients enforce the 10s display window themselves so a stale ts
  // simply renders as "no emote" without needing a server cleanup.
  // Self's id is also a key in this map — its EmoteBar uses it to
  // mirror the emote it just sent.
  emoteByPlayerId: Record<string, MultiplayerEmote>
  // Live hover positions per partner playerId (self is excluded).
  // Stale entries (older than HOVER_STALE_MS) are dropped client-
  // side so a backgrounded tab stops projecting a ghost. The
  // consumer renders a tinted piece footprint at `cellId` for each
  // entry to give the room a "what is my partner thinking?" feel.
  hoverByPlayerId: Record<string, MultiplayerHover>
  // Hue rotation (in degrees) to apply to each player's placed cubes
  // when rendered for *this* viewer. Self maps to 0; otherPlayers[i]
  // maps to (i + 1) * HUE_STEP_DEG. Drives the per-player cube
  // tinting in App.
  hueShiftByPlayerId: Record<string, number>
  placePiece: (pieceId: string, cellId: string) => Promise<void>
  // Park a piece into the hold slot, swap it with a held piece, or
  // pull a held piece into a hand slot. `target` is either the hold
  // slot or a specific hand slot index. The server is authoritative;
  // a successful return means the swap has landed in the room row.
  holdSwap: (
    sourcePieceId: string,
    target:
      | { kind: 'hold' }
      | { kind: 'hand'; slotIndex: number },
  ) => Promise<void>
  sendEmote: (emoji: string) => Promise<void>
  setName: (name: string) => Promise<void>
  restart: () => Promise<void>
  leave: () => Promise<void>
  // Broadcast that *this viewer* is currently hovering pieceId over
  // cellId. Pass null/null to signal "I'm not hovering anything"
  // (drag ended off-board, mouse left, etc). Idempotent; the caller
  // throttles. The mutation is intentionally cheap-to-call so we can
  // fire it on most cell crossings without ceremony.
  setHover: (pieceId: string | null, cellId: string | null) => Promise<void>
}

const HEARTBEAT_INTERVAL_MS = 8_000

// How long a hover entry stays "live" client-side. The throttled
// sender re-stamps every ~100ms while you're actively hovering, so
// a 3s grace window means you only need to land one update inside
// that window to keep the ghost alive — and crash-quit / tab-close
// scenarios flush within 3s without any explicit teardown.
export const HOVER_STALE_MS = 3_000

// Per-step hue rotation (degrees) for partner cube tinting.
// Self renders at 0; the first partner at HUE_STEP_DEG, the second at
// 2 * HUE_STEP_DEG, etc. 15° per step is plenty visible now that we
// bake the rotation directly into the output color in JS (HSL hue
// rotation produces dramatic, clearly-distinct shifts even at small
// angles — far more than CSS `filter: hue-rotate()` did). Eight
// seats land at 0/15/30/45/60/75/90/105°, keeping every partner in
// the same warm half of the wheel as self instead of jumping into
// alien blues/greens.
export const HUE_STEP_DEG = 15

// Synthesize a GameState off the live room snapshot so the rest of the app
// can keep reading from a single shape regardless of mode. Only the
// fields the big-mode UI actually reads are populated; daily-only fields
// are left in their no-op shape (empty objects / zeros).
const buildGameStateFromRoom = (
  room: NonNullable<ReturnType<typeof useQuery<typeof api.rooms.getRoom>>>,
  selfHand: ActivePiece[],
  selfHandSlots: (string | null)[],
  selfHold: ActivePiece | null,
): GameState => ({
  mode: 'big',
  board: room.board as GameState['board'],
  score: room.score,
  streak: room.streak,
  hand: selfHand,
  handSlots: selfHandSlots,
  hold: selfHold,
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
  const holdSwapMutation = useMutation(api.rooms.holdSwap)
  const leaveMutation = useMutation(api.rooms.leaveRoom)
  const heartbeatMutation = useMutation(api.rooms.heartbeat)
  const sendEmoteMutation = useMutation(api.rooms.sendEmote)
  const setNameMutation = useMutation(api.rooms.setPlayerName)
  const restartMutation = useMutation(api.rooms.restartRoom)
  const setHoverMutation = useMutation(api.rooms.setHover)

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
      hold: (me.hold ?? null) as ActivePiece | null,
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
        hold: (p.hold ?? null) as ActivePiece | null,
        isSelf: p.playerId === playerId,
      }))
  }, [room, playerId])

  // Room mode: 'coop' for any pre-mode room, 'pvp' when the room
  // was created competitively. Hoisted above the per-viewer hue
  // shifts so PvP can pick a different (evenly-spread) palette.
  const mode: RoomMode = (room?.mode ?? 'coop') as RoomMode

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

  // Hue per playerId for THIS viewer.
  //
  // Co-op: partners are kept in the same warm half of the wheel as
  // self (15° per step) so the table reads as one team — see
  // HUE_STEP_DEG. With four co-op seats we land at 0/15/30/45° and
  // the room still feels chromatically unified.
  //
  // PvP: distinguishability wins. We spread the seated players as
  // evenly as possible around the full hue wheel for the current
  // seat count, so each opponent's territory tint and cube color
  // sits as far from every other as the geometry allows. Self stays
  // at 0° (no view-dependent surprise) and partners take
  // (i + 1) * 360/N. Recomputed on every membership change — the
  // user explicitly accepted that colors may shift slightly when a
  // new player joins or leaves.
  const hueShiftByPlayerId = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {}
    if (selfPlayer) out[selfPlayer.playerId] = 0
    const isPvp = mode === 'pvp'
    const seatCount = otherPlayers.length + (selfPlayer ? 1 : 0)
    const pvpStep = seatCount > 0 ? 360 / seatCount : 0
    otherPlayers.forEach((p, i) => {
      const step = isPvp ? pvpStep : HUE_STEP_DEG
      out[p.playerId] = (i + 1) * step
    })
    return out
  }, [selfPlayer, otherPlayers, mode])

  // Spectator detection. A viewer is a spectator when the room exists,
  // self isn't seated, AND self appears in the room's spectator
  // list. (Self being absent from both lists during the brief join
  // window doesn't count — that's just "joining", and the existing
  // selfPlayer=null branches handle it.)
  const isSpectator = useMemo<boolean>(() => {
    if (!room || selfPlayer) return false
    return (room.spectators ?? []).some((s) => s.playerId === playerId)
  }, [room, selfPlayer, playerId])

  const spectatorCount = useMemo<number>(() => {
    return room?.spectators?.length ?? 0
  }, [room])

  // Game-state synth. Spectators still get a game object so the
  // board + score + gameover state render off the live room — we
  // just hand them an empty hand so no piece tray appears. Seated
  // players take their own hand as before.
  const game = useMemo<GameState | null>(() => {
    if (!room) return null
    if (selfPlayer) {
      return buildGameStateFromRoom(
        room,
        selfPlayer.hand,
        selfPlayer.handSlots,
        selfPlayer.hold,
      )
    }
    if (isSpectator) {
      return buildGameStateFromRoom(room, [], [], null)
    }
    return null
  }, [room, selfPlayer, isSpectator])

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

  const holdSwap = async (
    sourcePieceId: string,
    target:
      | { kind: 'hold' }
      | { kind: 'hand'; slotIndex: number },
  ) => {
    if (!code) return
    await holdSwapMutation({ code, playerId, sourcePieceId, target })
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

  const cellTints = useMemo<Record<string, string>>(() => {
    if (!room || !room.cellTints) return {}
    return room.cellTints
  }, [room])

  // Cells where someone has placed a cube (cellOwners) on top of
  // territory whose tint belongs to a different player (cellTints).
  // The renderer puts a ring around these so the conflict reads at a
  // glance.
  const conflictCellIds = useMemo<Set<string>>(() => {
    const out = new Set<string>()
    if (!room || !room.cellOwners || !room.cellTints) return out
    for (const [cellId, ownerId] of Object.entries(room.cellOwners)) {
      const tintId = room.cellTints[cellId]
      if (tintId && tintId !== ownerId) out.add(cellId)
    }
    return out
  }, [room])

  const pvpTotalCells = useMemo<number>(() => {
    if (!room) return 0
    return Object.keys(room.board).length
  }, [room])

  // Per-player territory totals + ratios, sorted high → low so the
  // HUD's leader is always first. Only seated players appear (a
  // disconnected player's tints survive on the board but they no
  // longer count toward standings, matching the server-side win
  // check).
  const pvpStandings = useMemo<PvpStandingsEntry[]>(() => {
    if (!room || mode !== 'pvp') return []
    const tints = room.cellTints ?? {}
    const seatedIds = new Set(room.players.map((p) => p.playerId))
    const counts = new Map<string, number>()
    for (const seatedId of seatedIds) counts.set(seatedId, 0)
    for (const tintId of Object.values(tints)) {
      if (!seatedIds.has(tintId)) continue
      counts.set(tintId, (counts.get(tintId) ?? 0) + 1)
    }
    const total = pvpTotalCells || 1
    const entries: PvpStandingsEntry[] = []
    for (const [pid, count] of counts.entries()) {
      entries.push({ playerId: pid, count, ratio: count / total })
    }
    entries.sort((a, b) => b.ratio - a.ratio)
    return entries
  }, [room, mode, pvpTotalCells])

  // Win threshold ratio used for the race-bar marker and "to win"
  // copy in the PvP UI. Mirrors the server-side rule (1/N + 0.05 of
  // the board, equivalent to (100/N)+5%) so the visual marker lines
  // up exactly with the cell count that triggers a win.
  const pvpThresholdRatio = useMemo<number>(() => {
    if (mode !== 'pvp') return 0
    const n = room?.players.length ?? 0
    if (n <= 0) return 0
    return Math.min(1, 1 / n + 0.05)
  }, [mode, room])

  const winnerPlayerId: string | null = (room?.winnerPlayerId ?? null) as
    | string
    | null

  const emoteByPlayerId = useMemo<Record<string, MultiplayerEmote>>(() => {
    if (!room) return {}
    const out: Record<string, MultiplayerEmote> = {}
    for (const e of room.lastEmotes ?? []) {
      out[e.playerId] = { emoji: e.emoji, ts: e.ts }
    }
    return out
  }, [room])

  // Hover ghosts for *partners only*. Self is filtered out so the
  // local renderer never has to subtract its own entry — and since
  // the local hover preview is already driven by client state, we
  // wouldn't want it round-tripping through the server anyway.
  // Stale entries are dropped here rather than on the server so we
  // can keep the throttle TTL purely client-side and avoid bumping
  // updatedAt on every cell crossing. We re-render once per second
  // via the staleTick state so a ghost reliably ages out even if no
  // other room mutation lands during the grace window.
  const [staleTick, setStaleTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => {
      setStaleTick((n) => n + 1)
    }, 1_000)
    return () => window.clearInterval(id)
  }, [])
  const hoverByPlayerId = useMemo<Record<string, MultiplayerHover>>(() => {
    if (!room) return {}
    const out: Record<string, MultiplayerHover> = {}
    const cutoff = Date.now() - HOVER_STALE_MS
    for (const h of room.hovers ?? []) {
      if (h.playerId === playerId) continue
      if (h.ts < cutoff) continue
      out[h.playerId] = { pieceId: h.pieceId, cellId: h.cellId, ts: h.ts }
    }
    return out
    // staleTick is a deliberate dep — it's how we re-evaluate the
    // cutoff once per second when no other room mutation has
    // arrived to refresh `room`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, playerId, staleTick])

  // Stable identity so consumers can put `setHover` into effect dep
  // arrays (or rely on its identity for cleanup-on-unmount logic)
  // without re-firing on every render. Without this, the cleanup
  // function of any effect that depends on `setHover` runs every
  // render and — for the hover-ghost teardown effect in App — was
  // calling setHover(null,null) ~10×/s, which the partner saw as a
  // rapid set→null→set→null flicker on top of the legitimate hover
  // updates.
  const setHover = useCallback(
    async (pieceId: string | null, cellId: string | null) => {
      if (!code) return
      await setHoverMutation({ code, playerId, pieceId, cellId })
    },
    [code, playerId, setHoverMutation],
  )

  return {
    status,
    code,
    game,
    selfPlayer,
    otherPlayers,
    allPlayers,
    updatedAt: room?.updatedAt ?? null,
    lastPlacement: room?.lastPlacement ?? null,
    mode,
    cellOwners,
    cellTints,
    conflictCellIds,
    pvpStandings,
    pvpTotalCells,
    pvpThresholdRatio,
    winnerPlayerId,
    isSpectator,
    spectatorCount,
    emoteByPlayerId,
    hoverByPlayerId,
    hueShiftByPlayerId,
    placePiece,
    holdSwap,
    sendEmote,
    setName,
    restart,
    leave,
    setHover,
  }
}
