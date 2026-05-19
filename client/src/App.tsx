import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import {
  getBoardDefinitionForMode,
  getBoardGeometryForMode,
} from './game/boardDefinition'
import type { BoardGeometry } from './game/boardDefinition'
import {
  applyPlacement,
  canPlacePiece,
  createBigGameState,
  createInitialGameState,
  createDailyGameState,
  dealPlayableHand,
  dealDailyHand,
  hasAnyValidMove,
} from './game/gameLogic'
import type { ActivePiece, GameMode, GameState } from './game/gameLogic'
import { axialToId, addAxial, directions } from './game/hexTypes'
import type { BoardDefinition } from './game/hexTypes'
import {
  getMasterVolume,
  getMuted,
  playBreakAfterClear,
  playClearForStreakIndex,
  playClickDown,
  playClickUp,
  playError,
  playGameOver,
  playUiClick,
  setMasterVolume,
  setMuted,
  unlockAudioOnGesture,
} from './audio'
import { api } from '../convex/_generated/api'
import { useMultiplayerGame } from './multiplayer/useMultiplayerGame'
import { getOrCreatePlayerId } from './multiplayer/playerIdentity'
import {
  buildRoomShareUrl,
  readRoomCodeFromUrl,
  setRoomCodeInUrl,
} from './multiplayer/roomUrl'
import { WebHaptics } from 'web-haptics'
import './index.css'

// Single shared instance. Web-haptics no-ops on unsupported platforms,
// so no feature detection is required at the call sites.
const haptics = new WebHaptics()

type HoverInfo = {
  cellId: string
} | null

// Theme engine: the set of identifiers a user can pick from in the
// menu's theme selector. Wood is the original warm cream/gold theme;
// win98 is the Minesweeper / Windows 98 homage. The active id lives on
// <html data-theme="..."> and every theme-specific CSS rule is scoped
// under that attribute so switching is a single DOM write.
type ThemeId = 'wood' | 'win98'

const THEME_OPTIONS: { id: ThemeId; label: string }[] = [
  { id: 'wood', label: 'Cubekill (default)' },
  { id: 'win98', label: 'Windows 98' },
]

const HEX_SIZE = 32
const SQRT3 = Math.sqrt(3)

// Resolve the on-screen score counter element for the active theme.
// Wood theme renders the score in `.hexaclear-live-stat .value`;
// Win98 hides that and renders it as a 7-segment LCD on the right
// side of the LCD row (`.hexaclear-win98-lcd-score .lcd-frame`).
// The score-fly particle queries this every frame to land at the
// correct readout regardless of which theme is live.
function getScoreCounterEl(): Element | null {
  if (typeof document === 'undefined') return null
  const theme = document.documentElement.dataset.theme
  if (theme === 'win98') {
    return (
      document.querySelector('.hexaclear-win98-lcd-score .lcd-frame') ??
      document.querySelector('.hexaclear-live-stat .value')
    )
  }
  return document.querySelector('.hexaclear-live-stat .value')
}
const DEBUG_SHOW_COORDS = false

// Mapping from polygon edge index (0..5) to axial neighbor direction index.
// With our pointy-top axial coordinates and hex vertex angles at
// -30, 30, 90, 150, 210, 270 degrees, the edge mid-angles are:
// 0, 60, 120, 180, 240, 300 degrees. These correspond to axial
// directions (1,0), (0,1), (-1,1), (-1,0), (0,-1), (1,-1) respectively.
const EDGE_DIRECTION_INDEX = [0, 5, 4, 3, 2, 1] as const

const axialToPixel = (q: number, r: number) => {
  const x = HEX_SIZE * (SQRT3 * q + (SQRT3 / 2) * r)
  const y = HEX_SIZE * (1.5 * r)
  return { x, y }
}

type BoardLayout = {
  positions: Record<string, { x: number; y: number }>
  width: number
  height: number
  offsetX: number
  offsetY: number
}

const buildLayout = (boardDef: BoardDefinition): BoardLayout => {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  const positions: Record<string, { x: number; y: number }> = {}

  for (const cell of boardDef.cells) {
    const { x, y } = axialToPixel(cell.coord.q, cell.coord.r)
    positions[cell.id] = { x, y }
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }

  const width = maxX - minX + HEX_SIZE * 2.5
  const height = maxY - minY + HEX_SIZE * 2.5

  return {
    positions,
    width,
    height,
    offsetX: -minX + HEX_SIZE * 1.25,
    offsetY: -minY + HEX_SIZE * 1.25,
  }
}

type Segment = { x1: number; y1: number; x2: number; y2: number }

// Inset distances (in user units, same coordinate space as
// HEX_SIZE = 32) for the two parallel lines that paint the
// rosette etched groove. The bevel covers user units 0..4 from
// the polygon edge; we leave a 1.5u gap so the groove reads as
// a separate carved channel rather than a continuation of the
// bevel.
const ROSETTE_GROOVE_DARK_INSET = 5.5
const ROSETTE_GROOVE_LIGHT_INSET = 7

// Build the perimeter segments for every rosette in the board. Used by
// the Wood theme to lightly outline each flower group of cells. Walks
// every cell inside the rosette (radius-r hex region) and emits the
// edges that border a non-rosette cell. Works for any flower radius.
const buildFlowerBoundarySegments = (
  boardDef: BoardDefinition,
  layout: BoardLayout,
  geometry: BoardGeometry,
): Segment[] => {
  const segments: Segment[] = []
  const idToCell = new Map(
    boardDef.cells.map((c) => [c.id, c] as const),
  )

  for (const center of geometry.flowerCenters) {
    const cellIds: string[] = []
    for (let dq = -geometry.flowerRadius; dq <= geometry.flowerRadius; dq++) {
      const drMin = Math.max(-geometry.flowerRadius, -dq - geometry.flowerRadius)
      const drMax = Math.min(geometry.flowerRadius, -dq + geometry.flowerRadius)
      for (let dr = drMin; dr <= drMax; dr++) {
        cellIds.push(axialToId({ q: center.q + dq, r: center.r + dr }))
      }
    }
    const cellSet = new Set(cellIds)

    for (const cellId of cellIds) {
      const cell = idToCell.get(cellId)
      if (!cell) continue
      const pos = layout.positions[cellId]
      const cx = pos.x + layout.offsetX
      const cy = pos.y + layout.offsetY

      for (let side = 0; side < 6; side++) {
        const dir = directions[EDGE_DIRECTION_INDEX[side]]
        const neighborCoord = addAxial(cell.coord, dir)
        const neighborId = axialToId(neighborCoord)
        if (cellSet.has(neighborId)) {
          continue
        }

        const angleA = ((60 * side - 30) * Math.PI) / 180
        const angleB = ((60 * ((side + 1) % 6) - 30) * Math.PI) / 180
        const x1 = cx + HEX_SIZE * Math.cos(angleA)
        const y1 = cy + HEX_SIZE * Math.sin(angleA)
        const x2 = cx + HEX_SIZE * Math.cos(angleB)
        const y2 = cy + HEX_SIZE * Math.sin(angleB)
        segments.push({ x1, y1, x2, y2 })
      }
    }
  }

  return segments
}

// Closed-loop rosette boundaries with proper inset polygons for
// the Win98 etched-groove rendering. For each rosette we:
//   1. Collect every cell-side segment that sits on the outer
//      perimeter of the 7-cell flower.
//   2. Stitch those segments into one ordered closed loop of
//      vertices.
//   3. Inset the loop by two perpendicular distances (the dark
//      and light groove offsets) using the angle-bisector
//      method so the resulting polygons stay parallel to the
//      original boundary at every corner — including corners
//      where two different rosette cells meet, which the older
//      per-cell-per-side approach broke up.
type Vec2 = { x: number; y: number }

const stitchClosedLoop = (segs: Segment[]): Vec2[] => {
  if (segs.length === 0) return []
  const eps = 0.5
  const same = (a: Vec2, b: Vec2) =>
    Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps
  const remaining = segs.map((s) => ({
    a: { x: s.x1, y: s.y1 },
    b: { x: s.x2, y: s.y2 },
  }))
  const result: Vec2[] = []
  const first = remaining.shift()!
  result.push(first.a)
  let endpoint: Vec2 = first.b
  while (remaining.length > 0) {
    let foundIdx = -1
    let nextEndpoint: Vec2 | null = null
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i]
      if (same(s.a, endpoint)) {
        foundIdx = i
        nextEndpoint = s.b
        break
      }
      if (same(s.b, endpoint)) {
        foundIdx = i
        nextEndpoint = s.a
        break
      }
    }
    if (foundIdx < 0) break
    result.push(endpoint)
    endpoint = nextEndpoint as Vec2
    remaining.splice(foundIdx, 1)
  }
  return result
}

const insetClosedLoop = (
  verts: Vec2[],
  dist: number,
  inwardRef: Vec2,
): Vec2[] => {
  const n = verts.length
  if (n < 3) return verts.map((v) => ({ ...v }))
  const result: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n]
    const curr = verts[i]
    const next = verts[(i + 1) % n]

    const e1x = curr.x - prev.x
    const e1y = curr.y - prev.y
    const e1len = Math.hypot(e1x, e1y)
    const e1nx = e1x / e1len
    const e1ny = e1y / e1len
    const e2x = next.x - curr.x
    const e2y = next.y - curr.y
    const e2len = Math.hypot(e2x, e2y)
    const e2nx = e2x / e2len
    const e2ny = e2y / e2len

    // Pick whichever perpendicular of each edge points toward
    // the inward reference point (the rosette center). The two
    // candidates are (-edgeY, edgeX) and (edgeY, -edgeX); we
    // resolve the ambiguity per-edge using a dot-product sign
    // check against the midpoint→center vector.
    const mid1x = (prev.x + curr.x) / 2
    const mid1y = (prev.y + curr.y) / 2
    const toRef1x = inwardRef.x - mid1x
    const toRef1y = inwardRef.y - mid1y
    let n1x = -e1ny
    let n1y = e1nx
    if (n1x * toRef1x + n1y * toRef1y < 0) {
      n1x = -n1x
      n1y = -n1y
    }
    const mid2x = (curr.x + next.x) / 2
    const mid2y = (curr.y + next.y) / 2
    const toRef2x = inwardRef.x - mid2x
    const toRef2y = inwardRef.y - mid2y
    let n2x = -e2ny
    let n2y = e2nx
    if (n2x * toRef2x + n2y * toRef2y < 0) {
      n2x = -n2x
      n2y = -n2y
    }

    const bx = n1x + n2x
    const by = n1y + n2y
    const blen = Math.hypot(bx, by)
    const bnx = bx / blen
    const bny = by / blen
    // Distance along the bisector that produces the requested
    // perpendicular distance from each adjacent edge.
    const cosHalf = bnx * n1x + bny * n1y
    const D = dist / cosHalf

    result.push({
      x: curr.x + bnx * D,
      y: curr.y + bny * D,
    })
  }
  return result
}

// Closed-loop, etched-groove polygons for every rosette. Stitches each
// rosette's perimeter into a continuous loop, then offsets it inward by
// two perpendicular distances for the dark/light groove pair. Same
// idea as buildFlowerBoundarySegments above, just walked through the
// stitcher so consecutive segments share a vertex.
const buildFlowerBoundaryLoops = (
  boardDef: BoardDefinition,
  layout: BoardLayout,
  geometry: BoardGeometry,
): { dark: Vec2[]; light: Vec2[] }[] => {
  const loops: { dark: Vec2[]; light: Vec2[] }[] = []
  const idToCell = new Map(
    boardDef.cells.map((c) => [c.id, c] as const),
  )

  for (const center of geometry.flowerCenters) {
    const centerId = axialToId(center)
    const cellIds: string[] = []
    for (let dq = -geometry.flowerRadius; dq <= geometry.flowerRadius; dq++) {
      const drMin = Math.max(-geometry.flowerRadius, -dq - geometry.flowerRadius)
      const drMax = Math.min(geometry.flowerRadius, -dq + geometry.flowerRadius)
      for (let dr = drMin; dr <= drMax; dr++) {
        cellIds.push(axialToId({ q: center.q + dq, r: center.r + dr }))
      }
    }
    const cellSet = new Set(cellIds)

    const segs: Segment[] = []
    for (const cellId of cellIds) {
      const cell = idToCell.get(cellId)
      if (!cell) continue
      const pos = layout.positions[cellId]
      const cx = pos.x + layout.offsetX
      const cy = pos.y + layout.offsetY
      for (let side = 0; side < 6; side++) {
        const dir = directions[EDGE_DIRECTION_INDEX[side]]
        const neighborCoord = addAxial(cell.coord, dir)
        const neighborId = axialToId(neighborCoord)
        if (cellSet.has(neighborId)) continue
        const angleA = ((60 * side - 30) * Math.PI) / 180
        const angleB = ((60 * ((side + 1) % 6) - 30) * Math.PI) / 180
        segs.push({
          x1: cx + HEX_SIZE * Math.cos(angleA),
          y1: cy + HEX_SIZE * Math.sin(angleA),
          x2: cx + HEX_SIZE * Math.cos(angleB),
          y2: cy + HEX_SIZE * Math.sin(angleB),
        })
      }
    }

    if (segs.length === 0) {
      loops.push({ dark: [], light: [] })
      continue
    }

    const ordered = stitchClosedLoop(segs)
    const centerPos = layout.positions[centerId]
    const inwardRef: Vec2 = {
      x: centerPos.x + layout.offsetX,
      y: centerPos.y + layout.offsetY,
    }
    loops.push({
      dark: insetClosedLoop(
        ordered,
        ROSETTE_GROOVE_DARK_INSET,
        inwardRef,
      ),
      light: insetClosedLoop(
        ordered,
        ROSETTE_GROOVE_LIGHT_INSET,
        inwardRef,
      ),
    })
  }

  return loops
}

// Exterior outline of the whole board: all hex edges whose neighbor is not
// another board cell, de-duped so we get a single continuous hex-shaped hull.
const buildBoardOutlineSegments = (
  boardDef: BoardDefinition,
  layout: BoardLayout,
): Segment[] => {
  const segments: Segment[] = []
  const cellSet = new Set(boardDef.cells.map((c) => c.id))
  const seen = new Set<string>()

  for (const cell of boardDef.cells) {
    const pos = layout.positions[cell.id]
    const cx = pos.x + layout.offsetX
    const cy = pos.y + layout.offsetY

    for (let side = 0; side < 6; side++) {
      const dir = directions[EDGE_DIRECTION_INDEX[side]]
      const neighborCoord = addAxial(cell.coord, dir)
      const neighborId = axialToId(neighborCoord)
      if (cellSet.has(neighborId)) continue

      const angleA = ((60 * side - 30) * Math.PI) / 180
      const angleB = ((60 * ((side + 1) % 6) - 30) * Math.PI) / 180
      const x1 = cx + HEX_SIZE * Math.cos(angleA)
      const y1 = cy + HEX_SIZE * Math.sin(angleA)
      const x2 = cx + HEX_SIZE * Math.cos(angleB)
      const y2 = cy + HEX_SIZE * Math.sin(angleB)

      const key =
        x1 <= x2
          ? `${x1.toFixed(2)},${y1.toFixed(2)}|${x2.toFixed(2)},${y2.toFixed(
              2,
            )}`
          : `${x2.toFixed(2)},${y2.toFixed(2)}|${x1.toFixed(2)},${y1.toFixed(
              2,
            )}`
      if (seen.has(key)) continue
      seen.add(key)

      segments.push({ x1, y1, x2, y2 })
    }
  }

  return segments
}

// Bundle of pre-baked render data for one board. We compute one of
// these per mode at module load and pick the right one based on
// `game.mode` at render time. Keeps the per-render cost flat — the
// only thing that varies is which constant we point at.
type BoardRenderData = {
  boardDef: BoardDefinition
  layout: BoardLayout
  rippleRadius: number
  flowerBoundarySegments: Segment[]
  flowerBoundaryLoops: { dark: Vec2[]; light: Vec2[] }[]
  outlineSegments: Segment[]
  geometry: BoardGeometry
}

const buildBoardRenderData = (mode: GameMode): BoardRenderData => {
  const boardDef = getBoardDefinitionForMode(mode)
  const geometry = getBoardGeometryForMode(mode)
  const layout = buildLayout(boardDef)
  return {
    boardDef,
    layout,
    rippleRadius: Math.max(layout.width, layout.height) * 0.7,
    flowerBoundarySegments: buildFlowerBoundarySegments(
      boardDef,
      layout,
      geometry,
    ),
    flowerBoundaryLoops: buildFlowerBoundaryLoops(
      boardDef,
      layout,
      geometry,
    ),
    outlineSegments: buildBoardOutlineSegments(boardDef, layout),
    geometry,
  }
}

const STANDARD_RENDER_DATA = buildBoardRenderData('endless')
const BIG_RENDER_DATA = buildBoardRenderData('big')

const getRenderDataForMode = (mode: GameMode): BoardRenderData =>
  mode === 'big' ? BIG_RENDER_DATA : STANDARD_RENDER_DATA

const buildHexPoints = (cx: number, cy: number): string => {
  const points: string[] = []
  for (let i = 0; i < 6; i++) {
    const angleRad = ((60 * i - 30) * Math.PI) / 180
    const x = cx + HEX_SIZE * Math.cos(angleRad)
    const y = cy + HEX_SIZE * Math.sin(angleRad)
    points.push(`${x},${y}`)
  }
  return points.join(' ')
}

// For Win98 / Minesweeper-style raised tiles we render two polylines
// per hex: a "highlight" along the upper-left half of the perimeter
// (light-from-top-left convention) and a "shadow" along the
// lower-right half. Theme CSS decides whether they're visible —
// Wood theme keeps them hidden, Win98 paints the bevel.
//
// Vertices for our pointy-top hex (angles -30..270°):
//   V0 upper-right, V1 lower-right, V2 bottom point,
//   V3 lower-left,  V4 upper-left,  V5 top point.
// Highlight = V3 → V4 → V5 → V0  (left, top-left, top-right edges)
// Shadow    = V0 → V1 → V2 → V3  (right, bottom-right, bottom-left)
//
// The polylines are inset slightly toward the hex center so the
// stroke sits *inside* the polygon edge (rather than half outside,
// half inside). This way adjacent cells' bevels don't overpaint
// each other on shared edges — every cell shows its own clean
// raised-button outline. Inset is computed via the regular hex's
// 60° apothem-to-vertex ratio: moving each vertex toward (cx, cy)
// by insetDistance / sin(60°) keeps the stroke parallel to the
// edge at the requested distance.
const HEX_BEVEL_INSET = 2
const HEX_BEVEL_RADIUS_FACTOR =
  (HEX_SIZE - HEX_BEVEL_INSET / Math.sin(Math.PI / 3)) / HEX_SIZE
const buildHexBevelPaths = (
  cx: number,
  cy: number,
): { highlight: string; shadow: string } => {
  const corners: Array<{ x: number; y: number }> = []
  for (let i = 0; i < 6; i++) {
    const angleRad = ((60 * i - 30) * Math.PI) / 180
    const r = HEX_SIZE * HEX_BEVEL_RADIUS_FACTOR
    corners.push({
      x: cx + r * Math.cos(angleRad),
      y: cy + r * Math.sin(angleRad),
    })
  }
  const highlight = [corners[3], corners[4], corners[5], corners[0]]
    .map((p) => `${p.x},${p.y}`)
    .join(' ')
  const shadow = [corners[0], corners[1], corners[2], corners[3]]
    .map((p) => `${p.x},${p.y}`)
    .join(' ')
  return { highlight, shadow }
}

const CubeLines = ({
  cx,
  cy,
  variant = 'normal',
  dailyHits,
  extraClasses = [],
  style,
}: {
  cx: number
  cy: number
  variant?: 'normal' | 'dailyTarget' | 'golden'
  dailyHits?: number
  extraClasses?: string[]
  style?: React.CSSProperties
}) => {
  const vertices: { x: number; y: number }[] = []
  const radius = HEX_SIZE
  for (let i = 0; i < 6; i++) {
    const angleRad = ((60 * i - 30) * Math.PI) / 180
    const x = cx + radius * Math.cos(angleRad)
    const y = cy + radius * Math.sin(angleRad)
    vertices.push({ x, y })
  }

  // Choose three wedge faces meeting at center: top, lower-right, lower-left
  const v0 = vertices[0]
  const v1 = vertices[1]
  const v2 = vertices[2]
  const v3 = vertices[3]
  const v4 = vertices[4]
  const v5 = vertices[5]

  let variantClass = 'hexaclear-hex-cube'
  if (variant === 'dailyTarget') {
    variantClass += ' daily-target'
  } else if (variant === 'golden') {
    variantClass += ' golden'
  }

  const cubeClassName = [variantClass, ...extraClasses].join(' ')

  return (
    <g className={cubeClassName} style={style}>
      {/* Inner wrapper so we can apply a unified wiggle/rotation to the cube
          without fighting the parent scale transform on the whole piece. */}
      <g className="hexaclear-cube-wiggle-wrap">
        {/* right face */}
        <polygon
          className="cube-face cube-right"
          points={`${cx},${cy} ${v1.x},${v1.y} ${v2.x},${v2.y} ${v3.x},${v3.y}`}
        />
        {/* left face */}
        <polygon
          className="cube-face cube-left"
          points={`${cx},${cy} ${v3.x},${v3.y} ${v4.x},${v4.y} ${v5.x},${v5.y}`}
        />
        {/* top face drawn last so it's not partially occluded */}
        <polygon
          className="cube-face cube-top"
          points={`${cx},${cy} ${v5.x},${v5.y} ${v0.x},${v0.y} ${v1.x},${v1.y}`}
        />
        {variant === 'golden' && (
          <text
            x={cx}
            y={cy + 3}
            className="hexaclear-gem-label"
          >
            +10
          </text>
        )}
        {variant === 'dailyTarget' && typeof dailyHits === 'number' && (
          <text
            x={cx}
            y={cy + 3}
            className="hexaclear-daily-number-centered"
          >
            {dailyHits}
          </text>
        )}
      </g>
    </g>
  )
}

// Emote sequence shown in the 3x3 grid below the smiley button. The
// composed emoji ('head shake' yes/no) include their explicit
// variation selectors so render-side font fallback is consistent
// across iOS / Android / desktop browsers.
const EMOTE_OPTIONS = [
  '⏸️',
  '▶️',
  '🤣',
  '😭',
  '🎉',
  '💀',
  '😍',
  '🙂\u200d↕\ufe0f',
  '🙂\u200d↔\ufe0f',
] as const

type SmileyRowPlayer = {
  playerId: string
  name: string
}

type SmileyRowProps = {
  show: boolean
  setShow: (v: boolean) => void
  // The local player. Their tile is the interactive trigger that
  // opens the emote panel and shows the emote *they* most recently
  // sent (so the sender can see what their partners are looking at).
  selfPlayer: SmileyRowPlayer | null
  // Every non-self seated player, in ring order. Each gets a
  // read-only smiley with their name underneath.
  otherPlayers: SmileyRowPlayer[]
  // Active (still-inside-the-10s-window) emote per playerId. Tiles
  // not in this map render the default smiley face.
  activeEmoteByPlayerId: Record<string, { emoji: string; ts: number }>
  onSend: (emoji: string) => void
  onToggle: () => void
}

const SmileyRow = ({
  show,
  setShow,
  selfPlayer,
  otherPlayers,
  activeEmoteByPlayerId,
  onToggle,
  onSend,
}: SmileyRowProps) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  // Close on outside click. Pointerdown so we beat the synthetic
  // click that would otherwise re-fire onToggle when the user taps
  // outside the popover.
  useEffect(() => {
    if (!show) return
    const onPointerDown = (e: PointerEvent) => {
      const el = wrapperRef.current
      if (!el) return
      if (el.contains(e.target as Node)) return
      setShow(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [show, setShow])
  if (!selfPlayer) return null
  const tiles: { player: SmileyRowPlayer; isSelf: boolean }[] = [
    { player: selfPlayer, isSelf: true },
    ...otherPlayers.map((p) => ({ player: p, isSelf: false })),
  ]
  return (
    <div
      className={[
        'hexaclear-smiley-row',
        // The legacy class lets the existing absolute-centering
        // anchor + Win98 chrome rules (which target
        // `.hexaclear-emote-bar`) keep working unchanged.
        'hexaclear-emote-bar',
        tiles.length > 4 ? 'hexaclear-smiley-row-compact' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      ref={wrapperRef}
    >
      {tiles.map(({ player, isSelf }) => {
        const emote = activeEmoteByPlayerId[player.playerId] ?? null
        return (
          <div
            key={player.playerId}
            className={[
              'hexaclear-smiley-tile',
              isSelf ? 'is-self' : 'is-partner',
            ].join(' ')}
          >
            <button
              type="button"
              className={[
                'hexaclear-emote-trigger',
                isSelf ? '' : 'is-readonly',
                // Partner tiles get the existing pulse animation
                // when their owner has an active emote, so the
                // viewer's eye gets pulled to whoever just reacted.
                !isSelf && emote ? 'has-partner-emote' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={isSelf ? onToggle : undefined}
              aria-label={
                isSelf
                  ? 'Send an emote'
                  : `${player.name}'s reactions`
              }
              aria-expanded={isSelf ? show : undefined}
              aria-disabled={isSelf ? undefined : true}
              tabIndex={isSelf ? 0 : -1}
            >
              <img
                src="/smiley.png"
                alt=""
                aria-hidden="true"
                className="hexaclear-emote-trigger-img"
                draggable={false}
              />
              <span
                className="hexaclear-emote-trigger-default"
                aria-hidden="true"
              >
                🙂
              </span>
              {emote && (
                <span
                  className="hexaclear-emote-trigger-overlay"
                  aria-label={`${player.name} sent ${emote.emoji}`}
                >
                  {emote.emoji}
                </span>
              )}
            </button>
            <span className="hexaclear-smiley-name" aria-hidden="true">
              {player.name}
            </span>
            {isSelf && show && (
              <div
                className="hexaclear-emote-panel"
                role="dialog"
                aria-label="Pick an emote"
              >
                <div
                  className="hexaclear-emote-panel-title"
                  aria-hidden="true"
                >
                  Send how you feel!
                </div>
                <div className="hexaclear-emote-panel-grid">
                  {EMOTE_OPTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="hexaclear-emote-option"
                      onClick={() => onSend(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const SlotGeometry = ({ cx, cy }: { cx: number; cy: number }) => {
  // Empty cells render as a single quiet hex dimple — no 3D cube facets — so
  // placed pieces stand out clearly against open space. Filled cubes carry
  // all the depth/shading. This is what tells the player "this cell is empty"
  // at a glance.
  const vertices: { x: number; y: number }[] = []
  const radius = HEX_SIZE * 0.86
  for (let i = 0; i < 6; i++) {
    const angleRad = ((60 * i - 30) * Math.PI) / 180
    vertices.push({
      x: cx + radius * Math.cos(angleRad),
      y: cy + radius * Math.sin(angleRad),
    })
  }
  const points = vertices.map((v) => `${v.x},${v.y}`).join(' ')

  return (
    <g className="hexaclear-slot">
      <polygon className="hexaclear-slot-fill" points={points} />
    </g>
  )
}

const PlacementGhost = ({
  originCellId,
  piece,
  valid,
  boardDef,
  layout,
}: {
  originCellId: string
  piece: ActivePiece
  valid: boolean
  boardDef: BoardDefinition
  layout: BoardLayout
}) => {
  const originCell = boardDef.cells.find((c) => c.id === originCellId)
  if (!originCell) return null

  return (
    <g className="hexaclear-placement-ghost">
      {piece.shape.cells.map((rel, idx) => {
        const targetQ = originCell.coord.q + rel.q
        const targetR = originCell.coord.r + rel.r
        const { x, y } = axialToPixel(targetQ, targetR)
        const cx = x + layout.offsetX
        const cy = y + layout.offsetY
        const points = buildHexPoints(cx, cy)
        return (
          <polygon
            key={idx}
            points={points}
            className={[
              'hexaclear-hex',
              'placement-ghost',
              valid ? 'placement-ghost-valid' : 'placement-ghost-invalid',
            ]
              .filter(Boolean)
              .join(' ')}
            pointerEvents="none"
          />
        )
      })}
    </g>
  )
}

const getBestPlacementPreview = (
  hoveredCellId: string | null,
  selectedPiece: ActivePiece | null,
  game: GameState,
) => {
  if (!hoveredCellId || !selectedPiece) return null

  const boardDef = getBoardDefinitionForMode(game.mode)
  const originCell = boardDef.cells.find((c) => c.id === hoveredCellId)
  if (!originCell) return null

  const targetIds: string[] = []
  let valid = true
  for (const rel of selectedPiece.shape.cells) {
    const targetQ = originCell.coord.q + rel.q
    const targetR = originCell.coord.r + rel.r
    const targetId = axialToId({ q: targetQ, r: targetR })
    if (!(targetId in game.board) || game.board[targetId] !== 'empty') {
      valid = false
    }
    targetIds.push(targetId)
  }

  let clearedIds: string[] = []
  if (valid) {
    const previewGame: GameState = {
      ...game,
      board: { ...game.board },
      hand: [selectedPiece],
      handSlots: [selectedPiece.id],
      gameOver: false,
    }
    const result = applyPlacement(previewGame, selectedPiece, hoveredCellId)
    if (result && result.clearedPatterns.length > 0) {
      // In daily mode, only highlight cells that will actually disappear
      // (not numbered cubes that still have hits remaining after the clear).
      if (game.mode === 'daily') {
        clearedIds = result.clearedCellIds.filter((id) => {
          const hitsAfter = result.dailyHits[id]
          // If hitsAfter is undefined or 0, the cell will disappear.
          return hitsAfter === undefined || hitsAfter === 0
        })
      } else {
        clearedIds = result.clearedCellIds
      }
    }
  }

  return { targetIds, valid, clearedIds }
}

type HighScoreEntry = {
  name: string
  score: number
  date: number
}

type DailyHighScoreEntry = {
  name: string
  moves: number
  date: number
}

const DAILY_PLAYER_RUNS_PREFIX = 'cubic-daily-runs-'

const loadHighScores = (): HighScoreEntry[] => {
  try {
    const raw = window.localStorage.getItem('cubic-highscores')
    if (!raw) return []
    const parsed = JSON.parse(raw) as HighScoreEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (e) =>
          typeof e.name === 'string' &&
          typeof e.score === 'number' &&
          typeof e.date === 'number',
      )
      .sort((a, b) => b.score - a.score || a.date - b.date)
      .slice(0, 5)
  } catch {
    return []
  }
}

const loadDailyHighScores = (): DailyHighScoreEntry[] => {
  try {
    const raw = window.localStorage.getItem('cubic-daily-highscores')
    if (!raw) return []
    const parsed = JSON.parse(raw) as DailyHighScoreEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (e) =>
          typeof e.name === 'string' &&
          typeof e.moves === 'number' &&
          typeof e.date === 'number',
      )
      .sort((a, b) => a.moves - b.moves || a.date - b.date)
      .slice(0, 5)
  } catch {
    return []
  }
}

const loadDailyRunsForDateKey = (dateKey: string): DailyHighScoreEntry[] => {
  try {
    const raw = window.localStorage.getItem(`${DAILY_PLAYER_RUNS_PREFIX}${dateKey}`)
    if (!raw) return []
    const parsed = JSON.parse(raw) as DailyHighScoreEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e) =>
        typeof e.name === 'string' &&
        typeof e.moves === 'number' &&
        typeof e.date === 'number',
    )
  } catch {
    return []
  }
}

const qualifiesForHighScore = (
  score: number,
  entries: HighScoreEntry[],
): boolean => {
  if (score <= 0) return false
  if (entries.length < 5) return true
  const sorted = [...entries].sort(
    (a, b) => b.score - a.score || a.date - b.date,
  )
  const last = sorted[sorted.length - 1]
  return score > last.score
}

const getTodayKey = (): string => {
  const now = new Date()
  // Use the client’s local calendar day so that daily puzzles reset at
  // local midnight rather than a single global UTC boundary.
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const d = now.getDate()
  const mm = String(m).padStart(2, '0')
  const dd = String(d).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

const getDateKeyFromTimestamp = (timestamp: number): string => {
  const d = new Date(timestamp)
  // Bucket stored scores by the player’s local day.
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  const mm = String(m).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

const shiftDateKey = (key: string, deltaDays: number): string => {
  const [yStr, mStr, dStr] = key.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  const d = Number(dStr)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return getTodayKey()
  }
  const date = new Date(Date.UTC(y, m - 1, d + deltaDays))
  const yy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

type PersistedGameEnvelope = {
  version: 1
  mode: GameMode
  game: GameState
  // For daily mode we also stash the date key so we don't restore an
  // old daily puzzle on a new day.
  dateKey?: string
}

const PERSIST_KEY_BY_MODE: Record<GameMode, string> = {
  endless: 'cubic-current-game-endless',
  daily: 'cubic-current-game-daily',
  big: 'cubic-current-game-big',
}

const ACTIVE_MODE_KEY = 'cubic-active-mode'

// Try to migrate the pre-multi-mode single-key save into per-mode
// slots. If both the legacy key and a per-mode key exist, the per-mode
// key wins (it's been kept in sync more recently). Idempotent: deletes
// the legacy key after migrating so subsequent reads short-circuit.
const migrateLegacyPersistedGame = () => {
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem('cubic-current-game')
    if (!raw) return
    const parsed = JSON.parse(raw) as PersistedGameEnvelope
    if (!parsed || parsed.version !== 1 || !parsed.game) {
      window.localStorage.removeItem('cubic-current-game')
      return
    }
    const targetKey = PERSIST_KEY_BY_MODE[parsed.mode]
    if (targetKey && !window.localStorage.getItem(targetKey)) {
      window.localStorage.setItem(targetKey, raw)
    }
    if (!window.localStorage.getItem(ACTIVE_MODE_KEY)) {
      window.localStorage.setItem(ACTIVE_MODE_KEY, parsed.mode)
    }
    window.localStorage.removeItem('cubic-current-game')
  } catch {
    // Best-effort migration; ignore parse failures.
  }
}

const loadGameForMode = (mode: GameMode): GameState | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PERSIST_KEY_BY_MODE[mode])
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedGameEnvelope
    if (!parsed || parsed.version !== 1 || !parsed.game) return null
    if (mode === 'daily') {
      const todayKey = getTodayKey()
      if (parsed.dateKey && parsed.dateKey !== todayKey) {
        return null
      }
    }
    // Backfill fields added since older saves were written so we don't crash on
    // legacy state shapes (e.g. pre-multi-ruby saves had `goldenCellId`).
    const game = parsed.game as GameState & {
      goldenCellId?: string | null
    }
    if (!Array.isArray(game.goldenCellIds)) {
      const legacyId = game.goldenCellId
      game.goldenCellIds =
        typeof legacyId === 'string' && legacyId.length > 0 ? [legacyId] : []
    }
    if (typeof game.mode !== 'string') {
      game.mode = mode
    }
    return game
  } catch {
    return null
  }
}

const loadInitialGameFromStorage = (): GameState => {
  if (typeof window === 'undefined') {
    return createInitialGameState()
  }
  migrateLegacyPersistedGame()
  let activeMode = (window.localStorage.getItem(ACTIVE_MODE_KEY) as
    | GameMode
    | null) ?? 'endless'
  if (activeMode !== 'endless' && activeMode !== 'daily' && activeMode !== 'big') {
    activeMode = 'endless'
  }
  const stored = loadGameForMode(activeMode)
  if (stored) return stored
  if (activeMode === 'daily') return createDailyGameState()
  if (activeMode === 'big') return createBigGameState()
  return createInitialGameState()
}

// Both pickup and placement get the same heavy bump per game design.
// `didClear` is preserved for the call site in case we want clear-only
// haptics later, but both branches currently fire the same heavy impact.
const triggerHaptics = (_didClear: boolean) => {
  haptics.trigger('heavy')
}

const triggerGrabHaptic = () => {
  haptics.trigger('heavy')
}

function App() {
  // ---- Multiplayer plumbing ------------------------------------------
  //
  // We treat multiplayer as a thin layer over the single-player engine:
  // the same `game` state variable backs the rendering pipeline; in MP
  // mode it just gets continuously mirrored from the room snapshot
  // instead of being driven by local placePiece updates. Single-player
  // logic remains fully intact when no room is active.
  const playerIdRef = useRef<string>(getOrCreatePlayerId())
  const playerId = playerIdRef.current
  const [mpRoomCode, setMpRoomCode] = useState<string | null>(() =>
    readRoomCodeFromUrl(),
  )
  // We pull the player's display name from the same localStorage key the
  // single-player high-score flow uses so the lobby auto-fills with
  // their familiar tag.
  const [mpPlayerName, setMpPlayerName] = useState<string>(() => {
    if (typeof window === 'undefined') return 'Player'
    try {
      const saved = window.localStorage.getItem('cubic-player-name')
      if (saved && saved.trim().length > 0) return saved
    } catch {
      // Ignore — fall through to default.
    }
    return 'Player'
  })
  const isMultiplayer = mpRoomCode !== null
  const mp = useMultiplayerGame({
    code: mpRoomCode,
    playerId,
    name: mpPlayerName,
  })
  // Smiley/emote panel UI state. Self's smiley button in the score
  // bar in MP opens a 3x3 grid of emotes that get pushed to every
  // other seat. The expiry tick is bumped each time an emote ages
  // out of its 10s display window so each seat's smiley falls back
  // to its default render at the right moment.
  const [showEmotePanel, setShowEmotePanel] = useState<boolean>(false)
  const [partnerEmoteExpiryTick, setPartnerEmoteExpiryTick] = useState(0)
  // Per-cell hue rotation (deg) applied to non-self placements so
  // each player's cubes wear a unique tint for THIS viewer. Self's
  // cells are absent from the map (they render at hue 0 / default).
  // Re-derived only when the cellOwners map or hue assignments
  // change. We also keep a `nonSelfOwnedCells` set so the cube
  // render loop can do a cheap `has` check before reaching for the
  // hue lookup.
  const cellHueByCellId = useMemo<Record<string, number>>(() => {
    if (!isMultiplayer) return {}
    const out: Record<string, number> = {}
    const selfId = mp.selfPlayer?.playerId
    for (const [cellId, ownerId] of Object.entries(mp.cellOwners)) {
      if (!ownerId || ownerId === selfId) continue
      const hue = mp.hueShiftByPlayerId[ownerId] ?? 0
      if (hue !== 0) out[cellId] = hue
    }
    return out
  }, [isMultiplayer, mp.cellOwners, mp.hueShiftByPlayerId, mp.selfPlayer])
  const nonSelfOwnedCells = useMemo<Set<string>>(() => {
    if (!isMultiplayer) return new Set()
    const selfId = mp.selfPlayer?.playerId
    const out = new Set<string>()
    for (const [cellId, ownerId] of Object.entries(mp.cellOwners)) {
      if (!ownerId || ownerId === selfId) continue
      out.add(cellId)
    }
    return out
  }, [isMultiplayer, mp.cellOwners, mp.selfPlayer])
  // Per-playerId emote, narrowed to "still inside its 10s display
  // window". Once the window closes the corresponding smiley falls
  // back to its default face. The expiry tick forces a recompute
  // when an active emote ages out.
  const PARTNER_EMOTE_TTL_MS = 10_000
  const activeEmoteByPlayerId = useMemo<
    Record<string, { emoji: string; ts: number }>
  >(() => {
    const out: Record<string, { emoji: string; ts: number }> = {}
    const now = Date.now()
    for (const [pid, emote] of Object.entries(mp.emoteByPlayerId)) {
      if (now - emote.ts < PARTNER_EMOTE_TTL_MS) out[pid] = emote
    }
    return out
    // partnerEmoteExpiryTick is in the dep list intentionally — its
    // only job is to force a recompute when an active emote ages
    // out, even though it doesn't appear inside the function body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mp.emoteByPlayerId, partnerEmoteExpiryTick])
  useEffect(() => {
    // Schedule a single expiry tick at the earliest pending TTL
    // across every active emote. One timer covers the common case
    // where multiple seats sent emotes inside the same window; as
    // soon as the earliest one fades, the recompute either renders
    // a smaller active set or schedules the next.
    const expiries: number[] = []
    const now = Date.now()
    for (const emote of Object.values(mp.emoteByPlayerId)) {
      const r = PARTNER_EMOTE_TTL_MS - (now - emote.ts)
      if (r > 0) expiries.push(r)
    }
    if (expiries.length === 0) return
    const remaining = Math.min(...expiries)
    const id = window.setTimeout(() => {
      setPartnerEmoteExpiryTick((t) => t + 1)
    }, remaining + 16)
    return () => window.clearTimeout(id)
  }, [mp.emoteByPlayerId])
  // Auto-close the emote panel when MP ends so we don't leave a
  // dangling popover floating in single-player mode.
  useEffect(() => {
    if (!isMultiplayer) setShowEmotePanel(false)
  }, [isMultiplayer])
  // Push the player's display-name edits to the server while we're
  // in a co-op session. Debounced so a fast typist doesn't spam
  // mutations as they type. We deliberately do NOT write
  // localStorage here — the leaderboard auto-fill stays whatever
  // they typed last in the high-score save dialog.
  useEffect(() => {
    if (!isMultiplayer) return
    const handle = window.setTimeout(() => {
      mp.setName(mpPlayerName).catch(() => {})
    }, 300)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mpPlayerName, isMultiplayer])
  // First-run backfill: push every locally-saved high score up to
  // the global leaderboards. The dedup index in the mutation makes
  // re-submissions a no-op, but we also gate this with a one-shot
  // localStorage flag so a normal session does no work. This is
  // best-effort; if the browser is offline we'll retry on the next
  // launch (the flag isn't set unless every submit returned).
  const didBackfillRef = useRef<boolean>(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (didBackfillRef.current) return
    if (window.localStorage.getItem('cubic-global-backfilled-v1') === '1') {
      didBackfillRef.current = true
      return
    }
    didBackfillRef.current = true
    void (async () => {
      try {
        const endless = loadHighScores()
        for (const e of endless) {
          await submitEndlessGlobal({
            playerId,
            name: e.name,
            score: e.score,
            savedAt: e.date,
          })
        }
        const dailies = loadDailyHighScores()
        for (const e of dailies) {
          await submitDailyGlobal({
            playerId,
            name: e.name,
            moves: e.moves,
            dateKey: getDateKeyFromTimestamp(e.date),
            savedAt: e.date,
          })
        }
        // Sweep all per-date stash keys (`cubic-daily-runs-YYYY-M-D`)
        // so historical daily runs land on global too — these are the
        // entries that don't show up in `cubic-daily-highscores` once
        // they fall out of the top 5.
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const k = window.localStorage.key(i)
          if (!k || !k.startsWith(DAILY_PLAYER_RUNS_PREFIX)) continue
          const dateKey = k.slice(DAILY_PLAYER_RUNS_PREFIX.length)
          const runs = loadDailyRunsForDateKey(dateKey)
          for (const e of runs) {
            await submitDailyGlobal({
              playerId,
              name: e.name,
              moves: e.moves,
              dateKey,
              savedAt: e.date,
            })
          }
        }
        window.localStorage.setItem('cubic-global-backfilled-v1', '1')
      } catch {
        // Swallow — leaving the flag unset means we'll retry next
        // session, and the server-side dedup keeps re-runs cheap.
        didBackfillRef.current = false
      }
    })()
    // We intentionally only want this to fire once per mount; after
    // that the ref / localStorage flag prevents repeats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const createRoomMutation = useMutation(api.rooms.createRoom)
  const joinRoomMutation = useMutation(api.rooms.joinRoom)
  // Global leaderboard mutations + queries. The mutations get fired
  // alongside every local save (and during a one-time backfill of the
  // player's existing local entries). The queries are only enabled
  // when the High Scores card is open and the global toggle is on,
  // so we don't pay for a subscription while the menu is closed.
  const submitEndlessGlobal = useMutation(api.leaderboard.submitEndlessScore)
  const submitDailyGlobal = useMutation(api.leaderboard.submitDailyScore)
  const submitCoopGlobal = useMutation(api.leaderboard.submitCoopScore)
  // Track whether we've already attempted to join the current room so a
  // single failure or a full-room error doesn't get retried in a loop on
  // every render.
  const joinAttemptRef = useRef<{ code: string; attempted: boolean }>({
    code: '',
    attempted: false,
  })
  const [mpError, setMpError] = useState<string | null>(null)
  const [mpShareUrl, setMpShareUrl] = useState<string | null>(null)
  // Tri-state for the new "Copy Link" button so we can flash a
  // "Copied!" confirmation right on the button without popping a
  // modal. The timer ref is held outside React state so re-renders
  // don't cancel a pending revert.
  const [copyLinkLabel, setCopyLinkLabel] = useState<'idle' | 'copied' | 'busy'>(
    'idle',
  )
  const copyLinkTimerRef = useRef<number | null>(null)

  const [game, setGame] = useState<GameState>(() => loadInitialGameFromStorage())
  // All board-shape data (cell positions, layout dimensions, rosette
  // boundaries, etc.) is precomputed once per mode at module load and
  // re-pointed at when the active mode changes. Everything below uses
  // `boardDef` / `boardLayout` rather than the legacy module-level
  // BOARD_DEFINITION / BOARD_LAYOUT constants so big mode can reuse the
  // entire render tree with its own cells.
  const boardRender = useMemo(
    () => getRenderDataForMode(game.mode),
    [game.mode],
  )
  const boardDef = boardRender.boardDef
  const boardLayout = boardRender.layout
  // True iff the player committed to a session this load — either by having
  // an in-progress game restored from storage, or by explicitly starting /
  // resetting a run from the menu, or by placing their first piece. Once
  // true, never flips back. Drives whether the menu shows the prominent
  // "New Game" button (only on a true cold-boot with no in-progress save)
  // versus the normal Restart-run + Resume pause menu.
  //
  // Note: the persist effect writes the initial empty game to storage on
  // first render, so we can't gate on "key exists in localStorage" — that
  // would trip on the second visit even if the player never engaged. We
  // instead inspect the loaded game's actual state.
  const [hasStartedSession, setHasStartedSession] = useState<boolean>(() => {
    const initial = loadInitialGameFromStorage()
    return initial.moves > 0 || initial.gameOver
  })
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null)
  const [hover, setHover] = useState<HoverInfo>(null)
  const [clearingCells, setClearingCells] = useState<string[]>([])
  const [clearingClassesByCell, setClearingClassesByCell] = useState<
    Record<string, string[]>
  >({})
  // Ruby cells participating in the *current* clear animation. Tracked
  // as a list so big-board placements that sweep up multiple rubies in
  // one move can keep the ruby decoration on every cleared cell, not
  // just the first one.
  const [clearingGoldenCellIds, setClearingGoldenCellIds] = useState<string[]>([])
  // If a ruby (golden cube) respawns onto an empty cell, game logic
  // marks that destination cell as filled immediately. During the clear
  // animation we keep the ruby highlight on the *previous* cells, so we
  // hide each destination cube until the animation finishes to avoid a
  // brief "normal cube" flash. Big board can spawn several at once.
  const [pendingGoldenSpawnCellIds, setPendingGoldenSpawnCellIds] = useState<
    string[]
  >([])
  const [recentlyPlacedCells, setRecentlyPlacedCells] = useState<string[]>([])
  // Screenshake & hitstop are driven by tokens that increment per event so
  // we can retrigger CSS animations without remounting the wrapper element.
  const [shakeRequest, setShakeRequest] = useState<{
    token: number
    intensity: number
  }>({ token: 0, intensity: 0 })
  const [hitstop, setHitstop] = useState(false)
  // Bumped every time a fresh 3-piece hand is dealt. Used as part of each
  // hand-piece button's React key so all three buttons remount together
  // and the fly-in animation always plays on a hand refresh.
  const [handFlyInToken, setHandFlyInToken] = useState(0)
  // Per-slot fly-in completion, scoped to a token. Once the deal animation
  // has played for a slot we drop the `hexaclear-piece-flyin` class so an
  // unrelated CSS rule change (notably the failed-drop shake clearing
  // back out) can't re-trigger the deal animation a second time. State
  // is keyed by token so a fresh hand naturally starts everything at
  // "not yet played" without needing a separate reset effect that would
  // fight the initial render.
  const [flyInDoneState, setFlyInDoneState] = useState<{
    token: number
    done: boolean[]
  }>({ token: -1, done: [] })
  const isFlyInDone = (slotIndex: number) =>
    flyInDoneState.token === handFlyInToken &&
    (flyInDoneState.done[slotIndex] ?? false)
  const markFlyInDone = (slotIndex: number) => {
    setFlyInDoneState((prev) => {
      const baseDone = prev.token === handFlyInToken ? prev.done : []
      if (baseDone[slotIndex]) return prev
      const nextDone = [...baseDone]
      while (nextDone.length <= slotIndex) nextDone.push(false)
      nextDone[slotIndex] = true
      return { token: handFlyInToken, done: nextDone }
    })
  }
  // Radial particle bursts that fire at each ruby's old position when
  // it gets cleared. Each burst has a unique token; big-board moves can
  // queue several at once and they all animate independently before
  // expiring together when the list resets.
  const [rubyBursts, setRubyBursts] = useState<
    Array<{ token: number; x: number; y: number }>
  >([])
  // While true, the game-over modal is suppressed and the board is in
  // its wind-down phase (desaturating, hand pieces shaking).
  const [gameOverWindingDown, setGameOverWindingDown] = useState(false)
  // Bumped each time a placement clears the entire board (+25 bonus).
  // Drives a one-shot golden flash overlay on the board wrapper.
  const [boardClearFlashToken, setBoardClearFlashToken] = useState(0)
  const [failedPlacementPieceId, setFailedPlacementPieceId] = useState<string | null>(
    null,
  )
  const [invalidDropCellIds, setInvalidDropCellIds] = useState<string[]>([])
  const [scorePopup, setScorePopup] = useState<string | null>(null)
  const [scorePopupId, setScorePopupId] = useState(0)
  const [scoreParticles, setScoreParticles] = useState<
    Array<{
      id: string
      value: number
      label?: string
      startX: number
      startY: number
      deltaX: number
      deltaY: number
      delay: number
      type: 'base' | 'combo' | 'streak' | 'piece'
    }>
  >([])
  const [showScoring, setShowScoring] = useState(false)
  const [showHighScores, setShowHighScores] = useState(false)
  // Which leaderboard tab the High Scores modal is currently showing.
  // The modal used to stack endless + daily (+ co-op when global was
  // on) end-to-end, which made the page get long. Now we render
  // exactly one board at a time and let the player flip between
  // them via a tab strip. The 'coop' tab is only available while
  // the global toggle is on (there is no local co-op store).
  type HighScoreTab = 'endless' | 'daily' | 'coop'
  const [highScoreTab, setHighScoreTab] = useState<HighScoreTab>('endless')
  // When on, the high-scores card swaps the local lists for live
  // global queries. Local stays first-class — we never wipe local
  // entries when the toggle flips. Defaults to ON for new players so
  // the global leaderboards (including co-op) are surfaced by default;
  // the player's last explicit choice is persisted under
  // `cubic-show-global-leaderboard` and restored on reload.
  const [showGlobalLeaderboard, setShowGlobalLeaderboard] = useState<boolean>(
    () => {
      if (typeof window === 'undefined') return true
      const raw = window.localStorage.getItem('cubic-show-global-leaderboard')
      if (raw === '0' || raw === 'false') return false
      if (raw === '1' || raw === 'true') return true
      return true
    },
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        'cubic-show-global-leaderboard',
        showGlobalLeaderboard ? '1' : '0',
      )
    } catch {
      // Best-effort; safe to fall through if storage is unavailable.
    }
  }, [showGlobalLeaderboard])
  const [highScores, setHighScores] = useState<HighScoreEntry[]>(() =>
    typeof window === 'undefined' ? [] : loadHighScores(),
  )
  const [pendingHighScore, setPendingHighScore] = useState(false)
  const [pendingScore, setPendingScore] = useState<number | null>(null)
  const [highScoreSaved, setHighScoreSaved] = useState(false)
  const [lastSavedHighScoreDate, setLastSavedHighScoreDate] = useState<
    number | null
  >(null)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  // Open the menu on load. The first gesture the player makes is
  // dismissing the menu, which gives us a clean moment to prime the
  // audio elements without that priming colliding with gameplay sounds.
  // Skip the auto-open when arriving via a room URL — the player came
  // here to play, not to land on a menu they didn't ask for.
  const [showMenu, setShowMenu] = useState(() => mpRoomCode === null)
  const [volume, setVolumeState] = useState<number>(() => getMasterVolume())
  const [audioMuted, setAudioMutedState] = useState<boolean>(() => getMuted())
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('cubic-reduced-motion') === 'true'
  })
  // Joke "ad previews" preview-mode. When on, a parody banner-ad
  // image gets stamped between the header chrome and the board so we
  // can mock up what a freemium / monetized build of Cubekill might
  // look like. Off by default; persisted under cubic-ad-previews so
  // the player's choice survives reloads.
  const [adPreviews, setAdPreviews] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('cubic-ad-previews') === 'true'
  })
  // Theme engine: which visual theme is active. Wood is the original
  // warm cream/gold treatment; win98 is the Windows 98 / Minesweeper
  // homage. Stored as a flat string so we can add more themes later
  // without a migration. Applied via a [data-theme="..."] attribute on
  // <html>, which all theme overrides scope under in CSS.
  const [theme, setTheme] = useState<ThemeId>(() => {
    if (typeof window === 'undefined') return 'wood'
    const raw = window.localStorage.getItem('cubic-theme')
    return raw === 'win98' ? 'win98' : 'wood'
  })
  const [dailyHighScores, setDailyHighScores] = useState<DailyHighScoreEntry[]>(
    () => (typeof window === 'undefined' ? [] : loadDailyHighScores()),
  )
  const [dailyRunsToken, setDailyRunsToken] = useState(0)
  const [pendingDailyHighScore, setPendingDailyHighScore] = useState(false)
  const [pendingDailyMoves, setPendingDailyMoves] = useState<number | null>(
    null,
  )
  const [dailyHighScoreSaved, setDailyHighScoreSaved] = useState(false)
  const [lastSavedDailyHighScoreDate, setLastSavedDailyHighScoreDate] =
    useState<number | null>(null)
  // Pre-fill the high-score name field with the last name the
  // player saved under, falling back to a friendly default for
  // first-time players. Combined with the autosave-on-dismiss
  // wiring on the gameover modal, this makes the Save button a
  // confirm shortcut rather than a gate: every qualifying run
  // ends up in the table even if the player just clicks "Play
  // again" without touching the input.
  const [playerName, setPlayerName] = useState(() => {
    if (typeof window === 'undefined') return 'Player'
    return window.localStorage.getItem('cubic-player-name') ?? 'Player'
  })
  const [bestScore, setBestScore] = useState<number | null>(() => {
    const stored = window.localStorage.getItem('hexaclear-best-score')
    return stored ? Number(stored) : null
  })
  // Each mode persists into its own localStorage slot so toggling
  // between modes (or refreshing while in a different mode) never
  // throws away the others' in-progress runs. The React state cache is
  // hydrated from those slots on first render.
  const [savedEndlessGame, setSavedEndlessGame] = useState<GameState | null>(
    () => loadGameForMode('endless'),
  )
  const [savedDailyGame, setSavedDailyGame] = useState<GameState | null>(
    () => loadGameForMode('daily'),
  )
  const [savedBigGame, setSavedBigGame] = useState<GameState | null>(
    () => loadGameForMode('big'),
  )
  const [todayDailyBestMoves, setTodayDailyBestMoves] = useState<number | null>(
    () => {
      if (typeof window === 'undefined') return null
      const key = getTodayKey()
      const raw = window.localStorage.getItem(
        `cubic-daily-best-${key}`,
      )
      if (!raw) return null
      const n = Number(raw)
      return Number.isFinite(n) && n > 0 ? n : null
    },
  )
  const [dailyScoresDateKey, setDailyScoresDateKey] = useState<string>(() =>
    getTodayKey(),
  )
  // Live global queries. We only subscribe when the High Scores
  // card is showing AND the global toggle is on — passing 'skip'
  // tears down the subscription otherwise. Daily is hard-pinned to
  // today globally (per product call), regardless of which date
  // the local stepper happens to be sitting on.
  const globalEndlessScores = useQuery(
    api.leaderboard.getTopEndlessScores,
    showHighScores && showGlobalLeaderboard ? {} : 'skip',
  )
  const globalDailyScores = useQuery(
    api.leaderboard.getTopDailyScoresForDate,
    showHighScores && showGlobalLeaderboard
      ? { dateKey: getTodayKey() }
      : 'skip',
  )
  const globalCoopScores = useQuery(
    api.leaderboard.getTopCoopScores,
    showHighScores && showGlobalLeaderboard ? {} : 'skip',
  )
  const [goldenPopupCellIds, setGoldenPopupCellIds] = useState<string[]>([])
  const [goldenPopupToken, setGoldenPopupToken] = useState(0)
  const [dailyHitPulseCells, setDailyHitPulseCells] = useState<string[]>([])
  const [rippleCells, setRippleCells] = useState<string[]>([])
  const [rippleIsClear, setRippleIsClear] = useState(false)
  const [rippleCenter, setRippleCenter] = useState<{ x: number; y: number } | null>(null)
  const [rippleToken, setRippleToken] = useState(0)
  const rippleRadiusRef = useRef(0)
  const rippleMaxRadiusRef = useRef(boardRender.rippleRadius * 2)
  const CLEAR_RIPPLE_DURATION_MS = 900
  const dailyCubesRemaining = useMemo(() => {
    if (game.mode !== 'daily') return 0
    let count = 0
    for (const hits of Object.values(game.dailyHits)) {
      if (hits > 0) count++
    }
    return count
  }, [game.mode, game.dailyHits])

  const todayPlayerDailyRuns = useMemo(() => {
    if (typeof window === 'undefined') return []
    const name = playerName.trim()
    if (!name) return []
    const todayKey = getTodayKey()
    const runs = loadDailyRunsForDateKey(todayKey)
    return runs
      .filter((r) => r.name === name && r.moves > 0)
      .sort((a, b) => a.moves - b.moves || a.date - b.date)
      .slice(0, 5)
  }, [playerName, dailyRunsToken])
  const [undoStack, setUndoStack] = useState<GameState[]>([])
  const [undoAnimation, setUndoAnimation] = useState<{
    piece: ActivePiece
    startX: number
    startY: number
    endX: number
    endY: number
    cellIds: string[]
  } | null>(null)
  const [pendingUndoRestoreSlotIndex, setPendingUndoRestoreSlotIndex] = useState<
    number | null
  >(null)
  const handButtonRefs = useRef<(HTMLButtonElement | null)[]>([])
  const selectedPiece = useMemo<ActivePiece | null>(() => {
    if (!selectedPieceId) return null
    return game.hand.find((p) => p.id === selectedPieceId) ?? null
  }, [game.hand, selectedPieceId])

  const rootRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const boardWrapperRef = useRef<HTMLDivElement | null>(null)
  // Live element ref for the × cancel marker that's currently mounted
  // inside the dragging slot. The marker is the single source of
  // truth for both the visual hit-zone affordance and the JS hit-
  // test rect, so they can never drift out of sync.
  const cancelMarkRef = useRef<HTMLSpanElement | null>(null)
  const dragState = useRef<{
    pieceId: string | null
    pointerId: number | null
    pointerType: string | null
  }>({
    pieceId: null,
    pointerId: null,
    pointerType: null,
  })
  // React dev StrictMode can invoke state updater functions twice; we use these
  // refs to ensure we don't schedule merge-time score increments twice.
  const placementActionIdRef = useRef(0)
  const lastScheduledScoreParticleActionIdRef = useRef<number | null>(null)
  // Used to ignore timeouts scheduled by particles from a previous run/mode.
  const scoreParticleGenerationRef = useRef(0)
  // Used to avoid removing the celebrate class too early when celebrations overlap.
  const scoreCelebrateTokenRef = useRef(0)
  const [draggingPieceId, setDraggingPieceId] = useState<string | null>(null)
  const scale = 1
  const [ghost, setGhost] = useState<{
    piece: ActivePiece
    x: number
    y: number
  } | null>(null)

  const playablePieceIds = useMemo<Set<string>>(() => {
    const playable = new Set<string>()
    for (const piece of game.hand) {
      for (const cell of boardDef.cells) {
        if (canPlacePiece(game.board, piece.shape, cell.id, game.mode)) {
          playable.add(piece.id)
          break
        }
      }
    }
    return playable
  }, [game.board, game.hand, game.mode, boardDef])

  // Co-op only: when one player is stuck (no valid moves) but the
  // other still has options, both players see a small status label
  // above the hand so the stuck player knows they're waiting on the
  // partner and the moving player knows the partner is benched. The
  // label always names the *other* player from the perspective of
  // whoever's looking at the screen.
  //
  // We deliberately suppress this in the gameover state — once both
  // players are out of moves the gameover modal takes over the
  // narrative and a "no valid moves" label would be redundant.
  const mpMoveStatus = useMemo<
    | { kind: 'self-stuck' | 'partner-stuck'; message: string }
    | null
  >(() => {
    if (!isMultiplayer) return null
    if (!mp.selfPlayer || mp.otherPlayers.length === 0) return null
    if (game.gameOver) return null
    const selfCanMove = hasAnyValidMove(
      game.board,
      mp.selfPlayer.hand,
      game.mode,
    )
    // Other-side "stuck" detection across all non-self seats. We
    // treat the room as "partner can move" if ANY other player has
    // a valid move, and partition the message accordingly. With >2
    // seats we name up to two stuck partners and switch to a count
    // string after that to keep the banner from wrapping.
    const stuckOthers: typeof mp.otherPlayers = []
    let anyOtherCanMove = false
    for (const op of mp.otherPlayers) {
      if (hasAnyValidMove(game.board, op.hand, game.mode)) {
        anyOtherCanMove = true
      } else {
        stuckOthers.push(op)
      }
    }
    const formatNames = (xs: typeof mp.otherPlayers): string => {
      if (xs.length === 0) return ''
      if (xs.length === 1) return xs[0].name
      if (xs.length === 2) return `${xs[0].name} & ${xs[1].name}`
      return `${xs.length} other players`
    }
    if (!selfCanMove && anyOtherCanMove) {
      const movers = mp.otherPlayers.filter(
        (p) => !stuckOthers.some((s) => s.playerId === p.playerId),
      )
      return {
        kind: 'self-stuck',
        message: `${formatNames(movers)} still ${
          movers.length === 1 ? 'has' : 'have'
        } valid moves`,
      }
    }
    if (selfCanMove && !anyOtherCanMove) {
      return {
        kind: 'partner-stuck',
        message: `${formatNames(stuckOthers)} ${
          stuckOthers.length === 1 ? 'has' : 'have'
        } no valid moves`,
      }
    }
    return null
  }, [
    isMultiplayer,
    mp.selfPlayer,
    mp.otherPlayers,
    game.board,
    game.mode,
    game.gameOver,
  ])

  const findClosestCellIdFromClientPoint = (clientX: number, clientY: number): string | null => {
    const svg = svgRef.current
    if (!svg) return null
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const local = pt.matrixTransform(ctm.inverse())

    let bestId: string | null = null
    let bestDistSq = Infinity
    for (const cell of boardDef.cells) {
      const pos = boardLayout.positions[cell.id]
      // Guard against stale closure mismatch between boardDef and boardLayout
      // — if we somehow get a cell id without a layout entry, just skip it
      // rather than crashing the whole render tree.
      if (!pos) continue
      const cx = pos.x + boardLayout.offsetX
      const cy = pos.y + boardLayout.offsetY
      const dx = local.x - cx
      const dy = local.y - cy
      const distSq = dx * dx + dy * dy
      if (distSq < bestDistSq) {
        bestDistSq = distSq
        bestId = cell.id
      }
    }
    return bestId
  }

  // ---- Multiplayer auto-join + state mirror ---------------------------
  //
  // When the URL has ?room=ABCD we kick off a single joinRoom call. The
  // ref guard avoids re-firing the mutation on every render once we know
  // we've tried (success or hard error). Reconnects still land on the
  // same slot via the playerId match in the convex mutation.
  useEffect(() => {
    if (!mpRoomCode) return
    if (mp.status === 'connecting') return
    if (mp.status === 'not-found') {
      setMpError('Room not found')
      return
    }
    if (mp.selfPlayer) return
    if (joinAttemptRef.current.code === mpRoomCode && joinAttemptRef.current.attempted) {
      return
    }
    joinAttemptRef.current = { code: mpRoomCode, attempted: true }
    setMpError(null)
    joinRoomMutation({
      code: mpRoomCode,
      playerId,
      name: mpPlayerName,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Could not join room'
      setMpError(msg)
    })
  }, [mpRoomCode, mp.status, mp.selfPlayer, joinRoomMutation, playerId, mpPlayerName])

  // Mirror the live room snapshot into the local game state so the
  // existing render tree (board, hand, score, etc.) shows the shared
  // state without any deeper rewrite. Only runs while a room is active.
  useEffect(() => {
    if (!isMultiplayer) return
    if (!mp.game) return
    setGame(mp.game)
  }, [isMultiplayer, mp.game])

  // Per-placement animation pipeline for MP mode. Reuses the same VFX
  // setters single-player drives inline from setGame; here we listen for
  // a fresh `lastPlacement.token` from the room snapshot and recreate
  // the animation set from the server-provided fields. We don't try to
  // perfectly recreate every detail (e.g. score-particle lives in the
  // single-player flow); just the load-bearing feel beats: placement
  // pop, ripple, clearing cells, ruby bursts, board-clear flourish,
  // shake, and clear SFX.
  const lastSeenMpTokenRef = useRef<number>(0)
  const prevMpHandLenRef = useRef<number>(0)
  useEffect(() => {
    if (!isMultiplayer) return
    if (!mp.game) return
    const placement = mp.lastPlacement
    if (!placement) return
    if (placement.token === lastSeenMpTokenRef.current) return
    lastSeenMpTokenRef.current = placement.token

    const placedSet = new Set(placement.placedCellIds)
    const clearedSet =
      placement.clearedCellIds.length > 0
        ? new Set(placement.clearedCellIds)
        : null
    const nonClearingPlacedIds =
      clearedSet === null
        ? placement.placedCellIds
        : placement.placedCellIds.filter((id) => !clearedSet.has(id))

    // Hide rubies that just respawned onto cleared cells until the
    // clear animation finishes (otherwise the new ruby flashes as a
    // normal cube during the dissolve).
    if (placement.rubiesCleared > 0) {
      const previousRubySet = new Set(placement.prevGoldenCellIds)
      const newSpawns = placement.newGoldenCellIds.filter(
        (id) =>
          !previousRubySet.has(id) &&
          !placedSet.has(id),
      )
      setPendingGoldenSpawnCellIds(newSpawns)
    } else {
      setPendingGoldenSpawnCellIds([])
    }

    setRecentlyPlacedCells(nonClearingPlacedIds)

    const causedClear = placement.clearedPatternIds.length > 0
    setRippleIsClear(causedClear)
    setRippleCells(placement.placedCellIds)

    const rippleFootprint =
      nonClearingPlacedIds.length > 0
        ? nonClearingPlacedIds
        : placement.placedCellIds

    if (rippleFootprint.length > 0) {
      let sumX = 0
      let sumY = 0
      let count = 0
      for (const id of rippleFootprint) {
        const pos = boardLayout.positions[id]
        if (!pos) continue
        sumX += pos.x + boardLayout.offsetX
        sumY += pos.y + boardLayout.offsetY
        count++
      }
      if (count > 0) {
        const cx = sumX / count
        const cy = sumY / count
        setRippleCenter({ x: cx, y: cy })
        setRippleToken((t) => t + 1)
        rippleRadiusRef.current = 0
        let maxDistSq = 0
        for (const cell of boardDef.cells) {
          const pos = boardLayout.positions[cell.id]
          if (!pos) continue
          const x = pos.x + boardLayout.offsetX
          const y = pos.y + boardLayout.offsetY
          const dx = x - cx
          const dy = y - cy
          const distSq = dx * dx + dy * dy
          if (distSq > maxDistSq) {
            maxDistSq = distSq
          }
        }
        const margin = HEX_SIZE * 1.4
        rippleMaxRadiusRef.current = Math.sqrt(maxDistSq) + margin
      }
    }

    if (causedClear) {
      // Build per-cell clearing classes by looking up patterns on the
      // board definition. The server only sent us pattern ids; here we
      // rehydrate the type/order info needed to drive the line vs
      // flower clearing styles.
      const patternsById = new Map(
        boardDef.patterns.map((p) => [p.id, p] as const),
      )
      const nextClearingClasses: Record<string, string[]> = {}
      for (const id of placement.clearedPatternIds) {
        const pattern = patternsById.get(id)
        if (!pattern) continue
        if (pattern.type === 'line') {
          pattern.cellIds.forEach((cellId, idx) => {
            const classes = (nextClearingClasses[cellId] ||= [])
            classes.push('clearing-line', `clearing-line-step-${idx}`)
          })
        } else if (pattern.type === 'flower') {
          const centerIdForPattern = pattern.cellIds[0] ?? null
          for (const cellId of pattern.cellIds) {
            const role =
              centerIdForPattern && cellId === centerIdForPattern
                ? 'clearing-flower-center'
                : 'clearing-flower-ring'
            ;(nextClearingClasses[cellId] ||= []).push(role)
          }
        }
      }
      setClearingClassesByCell(nextClearingClasses)
      setClearingCells(placement.clearedCellIds)
      setClearingGoldenCellIds(placement.prevGoldenCellIds)
    }

    // Clear SFX + haptics + screenshake + hitstop, all derived from the
    // server-reported streak and combo (clearedCount).
    const clearCount = placement.clearedPatternIds.length
    if (clearCount > 0 && !mp.game.gameOver) {
      playClearForStreakIndex(placement.streakAfter, clearCount)
      if (placement.rubiesCleared > 0) {
        playBreakAfterClear(80)
      }
    }
    triggerHaptics(clearCount > 0)

    if (clearCount > 0) {
      let intensity = Math.min(
        6,
        clearCount + Math.min((placement.streakAfter - 1) * 0.5, 3),
      )
      if (placement.boardCleared) intensity = Math.max(intensity, 9)
      setShakeRequest((prev) => ({ token: prev.token + 1, intensity }))

      const bigClear =
        clearCount >= 2 ||
        placement.streakAfter >= 3 ||
        placement.boardCleared
      if (bigClear) setHitstop(true)
    }

    if (placement.boardCleared) {
      setBoardClearFlashToken((t) => t + 1)
    }

    // Ruby capture pop + radial burst per cleared ruby.
    if (placement.rubiesCleared > 0) {
      const newPopupIds: string[] = placement.prevGoldenCellIds.filter(
        (id) => clearedSet?.has(id),
      )
      if (newPopupIds.length > 0) {
        setGoldenPopupCellIds(newPopupIds)
        setGoldenPopupToken((t) => t + 1)
        const newBursts: Array<{ token: number; x: number; y: number }> = []
        let nextToken = Date.now()
        for (const rubyId of newPopupIds) {
          const rubyPos = boardLayout.positions[rubyId]
          if (rubyPos) {
            newBursts.push({
              token: nextToken++,
              x: rubyPos.x + boardLayout.offsetX,
              y: rubyPos.y + boardLayout.offsetY,
            })
          }
        }
        if (newBursts.length > 0) {
          setRubyBursts((prev) => [...prev, ...newBursts])
        }
      }
    }

    // If this placement was ours and used our last hand piece, the
    // server has already dealt a fresh 3-piece hand; trigger the deal
    // animation so the new pieces fly in just like single-player.
    const myHandLen = mp.game.hand.length
    if (myHandLen === 3 && prevMpHandLenRef.current === 0) {
      setHandFlyInToken((t) => t + 1)
    }
    prevMpHandLenRef.current = myHandLen
  }, [isMultiplayer, mp.lastPlacement, mp.game, boardDef, boardLayout])

  // While in MP mode, wipe transient single-player UI state (selection,
  // ghost, drag) so leftovers from a local run don't flicker on screen.
  useEffect(() => {
    if (!isMultiplayer) return
    setSelectedPieceId(null)
    setHover(null)
    setGhost(null)
    setDraggingPieceId(null)
    dragState.current = {
      pieceId: null,
      pointerId: null,
      pointerType: null,
    }
  }, [isMultiplayer])

  const placePieceAtCell = (
    pieceId: string,
    cellId: string,
    attemptedCellIds?: string[],
  ) => {
    if (isMultiplayer) {
      // In MP the server is authoritative. Optimistically clear local
      // ghost / selection so the piece doesn't appear stuck while we
      // wait for the room snapshot, and surface a shake on rejection.
      setSelectedPieceId(null)
      setHover(null)
      setGhost(null)
      mp.placePiece(pieceId, cellId).catch(() => {
        setFailedPlacementPieceId(pieceId)
        setInvalidDropCellIds(
          attemptedCellIds && attemptedCellIds.length > 0
            ? attemptedCellIds
            : [cellId],
        )
        playError()
      })
      return
    }

    const actionId = (placementActionIdRef.current += 1)
    setGame((current) => {
      if (current.gameOver) return current
      const piece = current.hand.find((p) => p.id === pieceId)
      if (!piece) return current

      const before = current
      const result = applyPlacement(current, piece, cellId)
      if (!result) {
        setFailedPlacementPieceId(pieceId)
        // When placement fails, highlight the whole attempted footprint
        // if the caller provided it; otherwise fall back to the origin cell.
        setInvalidDropCellIds(
          attemptedCellIds && attemptedCellIds.length > 0
            ? attemptedCellIds
            : [cellId],
        )
        playError()
        return current
      }

      // Identify rubies that respawned onto previously-empty cells in
      // this placement so we can hide each one until the clear animation
      // finishes (otherwise the new ruby flashes as a normal cube). On
      // big-board moves multiple rubies can respawn in the same step.
      if (result.rubiesCleared > 0) {
        const previousRubySet = new Set(current.goldenCellIds)
        const placedSet = new Set(result.placedCellIds)
        const newSpawns = result.goldenCellIds.filter(
          (id) =>
            !previousRubySet.has(id) &&
            before.board[id] === 'empty' &&
            !placedSet.has(id),
        )
        setPendingGoldenSpawnCellIds(newSpawns)
      } else {
        setPendingGoldenSpawnCellIds([])
      }

      // For VFX, only run the placement "pop" on the portion of the piece
      // that is NOT participating in a clear. Any cells that are part of a
      // clear should only show the clear animation, never the placement
      // animation. The board ripple, however, should always originate from
      // the full placed footprint.
      const clearedSet =
        result.clearedCellIds.length > 0
          ? new Set(result.clearedCellIds)
          : null
      const nonClearingPlacedIds =
        clearedSet === null
          ? result.placedCellIds
          : result.placedCellIds.filter((id) => !clearedSet.has(id))

      setRecentlyPlacedCells(nonClearingPlacedIds)

      // Mark whether this placement caused a clear so we can choose between
      // different ripple styling, and compute the ripple's origin as the
      // centroid of the *visible* placed footprint in board coordinates.
      const causedClear = result.clearedPatterns.length > 0
      setRippleIsClear(causedClear)
      setRippleCells(result.placedCellIds)

      const rippleFootprint =
        nonClearingPlacedIds.length > 0
          ? nonClearingPlacedIds
          : result.placedCellIds

      if (rippleFootprint.length > 0) {
        let sumX = 0
        let sumY = 0
        for (const id of rippleFootprint) {
          const pos = boardLayout.positions[id]
          sumX += pos.x + boardLayout.offsetX
          sumY += pos.y + boardLayout.offsetY
        }
        const cx = sumX / rippleFootprint.length
        const cy = sumY / rippleFootprint.length
        setRippleCenter({ x: cx, y: cy })
        setRippleToken((t) => t + 1)
        rippleRadiusRef.current = 0
        // Compute how far this ring needs to travel: distance from the
        // centroid to the furthest board cell center, plus a small margin
        // so the wave fully exits the board before being cleared.
        let maxDistSq = 0
        for (const cell of boardDef.cells) {
          const pos = boardLayout.positions[cell.id]
          const x = pos.x + boardLayout.offsetX
          const y = pos.y + boardLayout.offsetY
          const dx = x - cx
          const dy = y - cy
          const distSq = dx * dx + dy * dy
          if (distSq > maxDistSq) {
            maxDistSq = distSq
          }
        }
        const margin = HEX_SIZE * 1.4
        const maxRadius = Math.sqrt(maxDistSq) + margin
        rippleMaxRadiusRef.current = maxRadius
      }
      if (current.mode === 'daily' && result.clearedPatterns.length > 0) {
        const pulse: string[] = []
        for (const [cellIdKey, after] of Object.entries(result.dailyHits)) {
          const before = current.dailyHits[cellIdKey] ?? 0
          if (before > 0 && after > 0 && after < before) {
            pulse.push(cellIdKey)
          }
        }
        if (pulse.length > 0) {
          setDailyHitPulseCells(pulse)
        }
      }

      // Build per-cell clearing classes so we can drive different
      // animations for lines vs flowers (center vs ring).
      if (result.clearedPatterns.length > 0) {
        const nextClearingClasses: Record<string, string[]> = {}
        for (const pattern of result.clearedPatterns) {
          if (pattern.type === 'line') {
            pattern.cellIds.forEach((id, idx) => {
              // In daily mode, don't animate numbered cubes that won't
              // actually disappear (still have hits remaining after clear).
              if (current.mode === 'daily') {
                const hitsAfter = result.dailyHits[id]
                if (hitsAfter !== undefined && hitsAfter > 0) {
                  return
                }
              }
              const classes = (nextClearingClasses[id] ||= [])
              classes.push('clearing-line', `clearing-line-step-${idx}`)
            })
          } else if (pattern.type === 'flower') {
            // boardDefinition always builds flower patterns with the
            // center cell first: [centerId, ...petalIds].
            const centerIdForPattern = pattern.cellIds[0] ?? null
            for (const id of pattern.cellIds) {
              // In daily mode, don't animate numbered cubes that won't
              // actually disappear (still have hits remaining after clear).
              if (current.mode === 'daily') {
                const hitsAfter = result.dailyHits[id]
                if (hitsAfter !== undefined && hitsAfter > 0) {
                  continue
                }
              }
              const role =
                centerIdForPattern && id === centerIdForPattern
                  ? 'clearing-flower-center'
                  : 'clearing-flower-ring'
              ;(nextClearingClasses[id] ||= []).push(role)
            }
          }
        }
        setClearingClassesByCell(nextClearingClasses)
      }

      const remainingHand = current.hand.filter((p) => p.id !== piece.id)
      const updatedSlots = current.handSlots.map((id) =>
        id === piece.id ? null : id,
      )

      let newStreak = current.streak
      if (result.clearedPatterns.length > 0) {
        newStreak = current.streak + 1
      } else {
        newStreak = 0
      }

      let newHand = remainingHand
      let gameOver = false

      const isThirdPieceThisHand = remainingHand.length === 0
      let nextHandDealCount = current.dailyHandDealCount

      if (isThirdPieceThisHand) {
        // In daily mode, use deterministic hand dealing based on seed
        if (current.mode === 'daily' && current.dailySeed != null) {
          nextHandDealCount = (current.dailyHandDealCount ?? 0) + 1
          newHand = dealDailyHand(result.board, current.dailySeed, nextHandDealCount)
        } else {
          newHand = dealPlayableHand(
            result.board,
            undefined,
            undefined,
            current.mode,
          )
        }
        for (let i = 0; i < 3; i++) {
          updatedSlots[i] = newHand[i]?.id ?? null
        }
        // All three slots just got refreshed — bump the fly-in token so
        // every hand button remounts and runs its arrival animation.
        setHandFlyInToken((t) => t + 1)
      }

      const noMovesLeft = !hasAnyValidMove(result.board, newHand, current.mode)

      if (current.mode === 'daily') {
        // Daily puzzles end either when all numbered targets are broken
        // or when there are no valid moves remaining.
        gameOver = result.dailyCompleted || noMovesLeft
      } else {
        if (noMovesLeft) {
          gameOver = true
        }
      }

      // Score is only surfaced in endless mode. We keep it updated
      // internally so we don't have to special-case game logic.
      let finalScore = current.score
      let shouldDelayScoreUpdate = false
      
      // Big mode shares the same live-scoring loop as endless: piece
      // placement adds flat points, clears spawn the score-fly particle,
      // and the LCD updates as totals merge in. The high-score / best-
      // score side effects are still gated on endless only further
      // below — big mode is a playtest sandbox for now.
      if (current.mode === 'endless' || current.mode === 'big') {
        const newScore = current.score + result.pointsGained
        const flatPoints = piece.shape.cells.length
        finalScore = newScore + flatPoints

        if (result.clearedPatterns.length > 0) {
          setClearingCells(result.clearedCellIds)
          setClearingGoldenCellIds(current.goldenCellIds)
          
          // Calculate total score for this move (pointsGained + piece points)
          const totalScore = result.pointsGained + piece.shape.cells.length
          
          // Get score counter position
          const scoreCounterEl = getScoreCounterEl()
          const boardWrapper = boardWrapperRef.current
          if (scoreCounterEl && boardWrapper) {
            // Calculate centroid of all cleared patterns for start position
            let sumX = 0
            let sumY = 0
            let count = 0
            for (const pattern of result.clearedPatterns) {
              for (const cellId of pattern.cellIds) {
                const cell = boardDef.cells.find((c) => c.id === cellId)
                if (cell) {
                  const pos = boardLayout.positions[cell.id]
                  sumX += pos.x + boardLayout.offsetX
                  sumY += pos.y + boardLayout.offsetY
                  count++
                }
              }
            }
            
            if (count > 0) {
              const startX = sumX / count
              const startY = sumY / count
              
              // Mark that we should delay score update
              shouldDelayScoreUpdate = true

              const generationAtStart = scoreParticleGenerationRef.current
              const animationDurationMs = 1400
              const mergeTimeMs = Math.round(animationDurationMs * 0.85)

              // Defer particle creation until after React has rendered and DOM is updated.
              // Use requestAnimationFrame to ensure DOM is fully updated.
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  if (scoreParticleGenerationRef.current !== generationAtStart) return
                  // In dev StrictMode the updater function can be invoked twice; avoid
                  // scheduling a duplicate particle+merge for the same move.
                  if (lastScheduledScoreParticleActionIdRef.current === actionId) return
                  lastScheduledScoreParticleActionIdRef.current = actionId
                  // Recalculate positions now that DOM is updated
                  const scoreCounterEl = getScoreCounterEl()
                  const boardWrapper = boardWrapperRef.current
                  if (scoreCounterEl && boardWrapper) {
                    const counterRect = scoreCounterEl.getBoundingClientRect()
                    const boardRect = boardWrapper.getBoundingClientRect()
                    const updatedEndX =
                      (counterRect.left + counterRect.width / 2 - boardRect.left) /
                      scale
                    const updatedEndY =
                      (counterRect.top + counterRect.height / 2 - boardRect.top) /
                      scale

                    // Calculate delta once and store it to prevent recalculation on re-render
                    const deltaX = updatedEndX - startX
                    const deltaY = updatedEndY - startY

                    // Create a particle for this scoring event (overlap is OK).
                    const particleId = `score-${Date.now()}-${Math.random()
                      .toString(16)
                      .slice(2)}`
                    setScoreParticles((prev) => [
                      ...prev,
                      {
                        id: particleId,
                        value: totalScore,
                        // Surface the rarest event in the game with a
                        // dedicated label so the +25 doesn't get lost
                        // in the bigger combo number.
                        label: result.boardCleared ? 'BOARD CLEAR!' : undefined,
                        startX,
                        startY,
                        deltaX,
                        deltaY,
                        delay: 0,
                        type: 'base',
                      },
                    ])

                    // Update displayed score and trigger celebration near "merge" time.
                    window.setTimeout(() => {
                      if (scoreParticleGenerationRef.current !== generationAtStart) return
                      setGame((currentGame) => {
                        if (
                          currentGame.mode !== 'endless' &&
                          currentGame.mode !== 'big'
                        )
                          return currentGame
                        return {
                          ...currentGame,
                          score: currentGame.score + totalScore,
                        }
                      })

                      const scoreCounter = getScoreCounterEl()
                      if (scoreCounter) {
                        scoreCelebrateTokenRef.current += 1
                        const token = scoreCelebrateTokenRef.current
                        scoreCounter.classList.add('score-celebrate')
                        window.setTimeout(() => {
                          if (scoreCelebrateTokenRef.current !== token) return
                          scoreCounter.classList.remove('score-celebrate')
                        }, 400)
                      }
                    }, mergeTimeMs)

                    // Remove just this particle after animation completes.
                    window.setTimeout(() => {
                      if (scoreParticleGenerationRef.current !== generationAtStart) return
                      setScoreParticles((prev) =>
                        prev.filter((p) => p.id !== particleId),
                      )
                    }, animationDurationMs + 200)
                  }
                })
              })
              
              // Don't update score yet - wait for particle to arrive
              finalScore = current.score
            }
          } else {
            // Fallback to old popup if we can't get positions
            const totalClears = result.clearedPatterns.length
            const popupText =
              totalClears === 1
                ? `Clear · +${result.pointsGained}`
                : `${totalClears} clears · +${result.pointsGained}`
            setScorePopup(popupText)
            setScorePopupId((id) => id + 1)
          }
        }

        // Best-score tracking only for the original endless ladder for
        // now; big-mode scores live on a separate scale and would
        // otherwise dominate the all-time best LCD after a single run.
        if (current.mode === 'endless') {
          setBestScore((prev) => {
            if (prev === null || finalScore > prev) {
              window.localStorage.setItem(
                'hexaclear-best-score',
                String(finalScore),
              )
              return finalScore
            }
            return prev
          })
        }

        // Ruby capture popups + radial bursts: in big mode several
        // rubies can be cleared in a single placement, each one earns
        // its own local "+10" popup and shard burst at its previous
        // position. Endless behaves as before with at most one.
        const previousRubySet = new Set(current.goldenCellIds)
        const newRubySet = new Set(result.goldenCellIds)
        const clearedRubyIds = current.goldenCellIds.filter(
          (id) => !newRubySet.has(id),
        )
        // Defensive: if for some reason the ruby was cleared but its id
        // somehow still appears in the new list (shouldn't happen, but
        // belt-and-braces), also include any clearedCellIds that were
        // rubies before this placement.
        if (clearedRubyIds.length === 0 && result.rubiesCleared > 0) {
          for (const id of result.clearedCellIds) {
            if (previousRubySet.has(id)) clearedRubyIds.push(id)
          }
        }
        if (clearedRubyIds.length > 0) {
          setGoldenPopupCellIds(clearedRubyIds)
          setGoldenPopupToken((t) => t + 1)
          const newBursts: Array<{ token: number; x: number; y: number }> = []
          let nextToken = Date.now()
          for (const rubyId of clearedRubyIds) {
            const rubyPos = boardLayout.positions[rubyId]
            if (rubyPos) {
              newBursts.push({
                token: nextToken++,
                x: rubyPos.x + boardLayout.offsetX,
                y: rubyPos.y + boardLayout.offsetY,
              })
            }
          }
          if (newBursts.length > 0) {
            setRubyBursts((prev) => [...prev, ...newBursts])
          }
        }
      } else {
        // Daily mode: still show the clearing animation. Daily has no
        // rubies, so clearingGoldenCellIds stays empty for that branch.
        if (result.clearedPatterns.length > 0) {
          setClearingCells(result.clearedCellIds)
          setClearingGoldenCellIds(current.goldenCellIds)
        }
      }

      triggerHaptics(result.clearedPatterns.length > 0)

      // Each consecutive clearing placement steps through clear_1..clear_7,
      // capped at clear_7 thereafter. A non-clearing placement resets
      // current.streak to 0 in game state, so the next clear after that
      // naturally lands back on clear_1. clearCount layers the combo
      // variant on top: 1 clear plays the plain streak sound, 2+ clears
      // play clear_<streak>_combo_<clearCount-1>, capped at combo_3.
      const clearCount = result.clearedPatterns.length
      if (clearCount > 0) {
        // If this placement also ends the run, the game-over SFX fires
        // shortly after and overlapping a celebratory clear hit on top
        // of it sounds chaotic. Cede the moment to game_over.wav.
        if (!gameOver) {
          playClearForStreakIndex(current.streak + 1, clearCount)
          // Ruby capture: layer break.wav ~80ms after the clear hit so
          // the shatter reads as a follow-up to the clear, not on top
          // of its attack. Skipped when the same placement also ends
          // the game (game-over SFX owns the moment).
          if (result.rubiesCleared > 0) {
            playBreakAfterClear(80)
          }
        }

        // Screenshake intensity grows with combo size and current streak.
        // No shake on non-clearing placements: the board ripple already
        // covers those, and shaking on every drop quickly turns into
        // background noise. Board-clear is the rarest event in the game
        // and gets a much heavier shake regardless of other inputs.
        let intensity = Math.min(
          6,
          clearCount + Math.min(current.streak * 0.5, 3),
        )
        if (result.boardCleared) {
          intensity = Math.max(intensity, 9)
        }
        setShakeRequest((prev) => ({
          token: prev.token + 1,
          intensity,
        }))

        // Hitstop only on "big" clears: combos of 2+, a clear that
        // pushes the streak to 3+, or any board clear. The momentary
        // freeze sells the impact before the cascade plays out.
        const streakAfter = current.streak + 1
        const bigClear =
          clearCount >= 2 || streakAfter >= 3 || result.boardCleared
        if (bigClear) {
          setHitstop(true)
        }

        // Board-clear flourish: a golden flash sweeps across the wrapper
        // on top of the bigger shake. Token retriggers cleanly even if
        // a player somehow lands two board-clears in a row.
        if (result.boardCleared) {
          setBoardClearFlashToken((t) => t + 1)
        }
      }

      const newMoves = current.moves + 1

      // Update per-hand undo history: we only allow undoing moves within
      // the current 3-piece hand. We store snapshots of the pre-move
      // state and clear the history once the third piece has been played.
      if (!isThirdPieceThisHand) {
        const capped =
          undoStack.length >= 2 ? undoStack.slice(1) : undoStack
        setUndoStack([...capped, before])
      } else {
        setUndoStack([])
      }

      setSelectedPieceId(null)

      // If we're delaying score update (waiting for particle), don't update score yet
      const scoreToUse = shouldDelayScoreUpdate ? current.score : finalScore
      
      return {
        ...current,
        board: result.board,
        score: scoreToUse,
        streak: result.clearedPatterns.length > 0 ? newStreak : 0,
        hand: newHand,
        handSlots: updatedSlots,
        gameOver,
        moves: newMoves,
        dailyHits: result.dailyHits,
        dailyTotalHits: result.dailyTotalHits,
        dailyRemainingHits: result.dailyRemainingHits,
        dailyCompleted: result.dailyCompleted,
        dailyHandDealCount: nextHandDealCount,
        goldenCellIds: result.goldenCellIds,
      }
    })
  }

  const handleCellClick = (cellId: string) => {
    if (!selectedPieceId) return
    const piece = selectedPiece
    const previewForDrop =
      piece && cellId
        ? getBestPlacementPreview(cellId, piece, game)
        : null
    placePieceAtCell(
      selectedPieceId,
      cellId,
      previewForDrop?.targetIds ?? undefined,
    )
  }

  const resetGame = () => {
    scoreParticleGenerationRef.current += 1
    lastScheduledScoreParticleActionIdRef.current = null
    setScoreParticles([])
    if (game.mode === 'daily') {
      const next = createDailyGameState()
      setGame(next)
      setSavedDailyGame(next)
      setDailyHighScoreSaved(false)
    } else if (game.mode === 'big') {
      const next = createBigGameState()
      setGame(next)
      setSavedBigGame(next)
    } else {
      const next = createInitialGameState()
      setGame(next)
      setSavedEndlessGame(next)
      setHighScoreSaved(false)
    }
    setSelectedPieceId(null)
    setHover(null)
    setUndoStack([])
    setUndoAnimation(null)
    setPendingUndoRestoreSlotIndex(null)
    setGoldenPopupCellIds([])
    setClearingCells([])
    setClearingGoldenCellIds([])
    setPendingGoldenSpawnCellIds([])
    setScorePopup(null)
  }

  // ---- Multiplayer handlers -----------------------------------------

  // Restart a co-op room in place: the server resets the shared
  // board and re-deals both hands, so neither player has to copy a
  // new link or rejoin. We flush local-only UI bookkeeping
  // (selection, hovers, particles, half-finished clears) so the
  // post-restart server state shows up clean.
  const handleRestartCoop = () => {
    if (!mpRoomCode) return
    mp.restart().catch(() => {})
    scoreParticleGenerationRef.current += 1
    lastScheduledScoreParticleActionIdRef.current = null
    setScoreParticles([])
    setSelectedPieceId(null)
    setHover(null)
    setUndoStack([])
    setUndoAnimation(null)
    setPendingUndoRestoreSlotIndex(null)
    setGoldenPopupCellIds([])
    setClearingCells([])
    setClearingGoldenCellIds([])
    setPendingGoldenSpawnCellIds([])
    setScorePopup(null)
  }

  const handleLeaveRoom = () => {
    if (!mpRoomCode) return
    const code = mpRoomCode
    mp.leave().catch(() => {})
    setMpRoomCode(null)
    setRoomCodeInUrl(null)
    setMpShareUrl(null)
    setMpError(null)
    joinAttemptRef.current = { code: '', attempted: false }
    // Drop straight back into a fresh single-player big game so the
    // local view doesn't keep showing the just-left shared board.
    const next = createBigGameState()
    setGame(next)
    setSavedBigGame(next)
    setSelectedPieceId(null)
    setHover(null)
    setClearingCells([])
    setClearingGoldenCellIds([])
    setPendingGoldenSpawnCellIds([])
    setUndoStack([])
    void code
  }

  // Mirror finished co-op runs to the global leaderboard. Both clients
  // see `mp.status === 'gameover'` simultaneously and race-fire the
  // mutation; the server dedupes on (roomCode, finishedAt) so only one
  // row lands. We also guard locally with a ref keyed on the same pair
  // so a re-renders during the gameover-modal lifetime don't keep
  // re-firing the mutation.
  const coopScoreSubmittedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isMultiplayer) return
    if (mp.status !== 'gameover') return
    if (!mpRoomCode) return
    if (mp.updatedAt === null) return
    if (mp.allPlayers.length === 0) return
    if (mp.game === null) return
    const dedupeKey = `${mpRoomCode}@${mp.updatedAt}`
    if (coopScoreSubmittedRef.current === dedupeKey) return
    coopScoreSubmittedRef.current = dedupeKey
    submitCoopGlobal({
      roomCode: mpRoomCode,
      finishedAt: mp.updatedAt,
      score: mp.game.score,
      players: mp.allPlayers.map((p) => ({
        playerId: p.playerId,
        name: p.name,
        slot: p.slot,
      })),
    }).catch(() => {
      // If the network was flaky, allow a retry on the next render —
      // server-side dedup will still no-op a successful resend.
      coopScoreSubmittedRef.current = null
    })
    // mp.allPlayers identity changes per render but the underlying data
    // is stable until the room mutates; updatedAt+roomCode is enough
    // to gate this safely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMultiplayer, mp.status, mpRoomCode, mp.updatedAt])

  // Reset the dedup ref when the player leaves the room so re-joining
  // a *different* room and finishing it submits cleanly.
  useEffect(() => {
    if (!mpRoomCode) coopScoreSubmittedRef.current = null
  }, [mpRoomCode])

  // Single-action "Copy Link" used from the co-op HUD. If we're not
  // already in a room, we lazily spin one up so the link points at a
  // real lobby; if we are, we copy the existing URL. Either way the
  // button briefly flips to "Copied!" and then reverts. No modal.
  //
  // Important: this handler must be synchronous up to the
  // `navigator.clipboard.write` call. Safari / iOS reject any
  // clipboard write that's separated from the user gesture by an
  // `await`, so we use the `ClipboardItem(Promise<Blob>)` form which
  // lets us kick off the room-creation mutation, register the
  // pending write inside the same gesture tick, and let the browser
  // commit it once the URL resolves.
  const handleCopyLinkAction = (): void => {
    if (copyLinkLabel === 'busy') return
    setMpError(null)

    // Seed the new room with the host's current solo Big board so
    // their in-progress run carries over when a friend joins. We
    // only seed when the local game is in 'big' mode and has already
    // had at least one move; otherwise an empty fresh board is fine
    // and lets the server roll new initial rubies.
    const seedFromLocal =
      game.mode === 'big' && game.moves > 0
        ? {
            board: game.board,
            goldenCellIds: game.goldenCellIds,
            score: game.score,
            streak: game.streak,
            moves: game.moves,
          }
        : undefined

    // Kick off the URL resolution. This IIFE returns synchronously
    // (it returns a Promise) so the clipboard.write call below still
    // runs inside the click gesture.
    const urlPromise = (async (): Promise<string> => {
      let code = mpRoomCode
      let url = mpShareUrl
      if (!code) {
        const res = await createRoomMutation({
          playerId,
          name: mpPlayerName,
          seed: seedFromLocal,
        })
        if (!res?.code) throw new Error('No code returned')
        code = res.code
        setMpRoomCode(code)
        setRoomCodeInUrl(code)
        url = buildRoomShareUrl(code)
        setMpShareUrl(url)
        joinAttemptRef.current = { code, attempted: true }
      } else if (!url) {
        url = buildRoomShareUrl(code)
        setMpShareUrl(url)
      }
      if (!url) throw new Error('No share URL available')
      return url
    })()

    setCopyLinkLabel('busy')

    const supportsClipboardItem =
      typeof navigator !== 'undefined' &&
      typeof navigator.clipboard?.write === 'function' &&
      typeof window !== 'undefined' &&
      typeof window.ClipboardItem !== 'undefined'

    // Write path. Safari only honors the gesture if we hand it a
    // ClipboardItem with a Promise<Blob> right now — actually
    // awaiting the URL first and then calling writeText bombs out
    // with the "request not allowed by the user agent" error.
    const writePromise: Promise<unknown> = supportsClipboardItem
      ? navigator.clipboard.write([
          new window.ClipboardItem({
            'text/plain': urlPromise.then(
              (text) => new Blob([text], { type: 'text/plain' }),
            ),
          }),
        ])
      : urlPromise.then((text) =>
          typeof navigator !== 'undefined' && navigator.clipboard?.writeText
            ? navigator.clipboard.writeText(text)
            : undefined,
        )

    void Promise.all([urlPromise, writePromise])
      .then(() => {
        setCopyLinkLabel('copied')
        if (copyLinkTimerRef.current !== null) {
          window.clearTimeout(copyLinkTimerRef.current)
        }
        copyLinkTimerRef.current = window.setTimeout(() => {
          setCopyLinkLabel('idle')
          copyLinkTimerRef.current = null
        }, 2200)
      })
      .catch((err: unknown) => {
        setCopyLinkLabel('idle')
        const msg =
          err instanceof Error ? err.message : 'Could not copy link'
        setMpError(msg)
      })
  }

  const handleUndo = () => {
    if (undoStack.length === 0) return
    const previous = undoStack[undoStack.length - 1]
    const remaining = undoStack.slice(0, -1)
    
    // Find cells that are currently filled but will be empty after undo
    const cellsToRemove: string[] = []
    for (const cellId in game.board) {
      if (game.board[cellId] === 'filled' && previous.board[cellId] !== 'filled') {
        cellsToRemove.push(cellId)
      }
    }
    
    // Find which piece was added back to the hand
    const currentHandIds = new Set(game.hand.map((p) => p.id))
    const restoredPieceId = previous.hand.find((p) => !currentHandIds.has(p.id))?.id
    
    if (cellsToRemove.length > 0 && restoredPieceId) {
      // Calculate centroid of cells being removed (board position)
      let sumX = 0
      let sumY = 0
      for (const cellId of cellsToRemove) {
        const cell = boardDef.cells.find((c) => c.id === cellId)
        if (cell) {
          const pos = boardLayout.positions[cell.id]
          sumX += pos.x + boardLayout.offsetX
          sumY += pos.y + boardLayout.offsetY
        }
      }
      const startX = sumX / cellsToRemove.length
      const startY = sumY / cellsToRemove.length
      
      // Find which slot the piece will occupy in the hand
      const slotIndex = previous.handSlots.findIndex((id) => id === restoredPieceId)
      const restoredPiece = previous.hand.find((p) => p.id === restoredPieceId)
      
      if (slotIndex >= 0 && restoredPiece && boardWrapperRef.current) {
        // Get the hand button's position
        const handButton = handButtonRefs.current[slotIndex]
        if (handButton) {
          const boardRect = boardWrapperRef.current.getBoundingClientRect()
          const buttonRect = handButton.getBoundingClientRect()
          const endX = (buttonRect.left + buttonRect.width / 2 - boardRect.left) / scale
          const endY = (buttonRect.top + buttonRect.height / 2 - boardRect.top) / scale
          
          // Restore game state immediately so pieces reappear
          setUndoStack(remaining)
          setPendingUndoRestoreSlotIndex(slotIndex)
          setGoldenPopupCellIds([])
          setClearingCells([])
          setClearingGoldenCellIds([])
          setPendingGoldenSpawnCellIds([])
          setScorePopup(null)
          setGame((current) => {
            const restoredMoves =
              current.mode === 'daily' ? current.moves : previous.moves
            return {
              ...previous,
              moves: restoredMoves,
            }
          })
          
          // Set up animation (visual only - state already restored)
          setUndoAnimation({
            piece: restoredPiece,
            startX,
            startY,
            endX,
            endY,
            cellIds: cellsToRemove,
          })
          
          // Clear animation state after animation completes
          setTimeout(() => {
            setSelectedPieceId(null)
            setHover(null)
            setUndoAnimation(null)
            setPendingUndoRestoreSlotIndex(null)
          }, 350) // Match animation duration
          return
        }
      }
    }
    
    // Fallback: instant undo if we can't animate
    setUndoStack(remaining)
    setPendingUndoRestoreSlotIndex(null)
    setGoldenPopupCellIds([])
    setClearingCells([])
    setClearingGoldenCellIds([])
    setPendingGoldenSpawnCellIds([])
    setScorePopup(null)
    setGame((current) => {
      const restoredMoves =
        current.mode === 'daily' ? current.moves : previous.moves
      return {
        ...previous,
        moves: restoredMoves,
      }
    })
    setSelectedPieceId(null)
    setHover(null)
  }

  const toggleMode = (target: GameMode) => {
    if (game.mode === target) return

    // Snapshot the run we're leaving so toggling back restores it.
    // We do this OUTSIDE setGame's updater because calling other
    // setState functions inside an updater is an antipattern (React
    // may run the updater twice in dev / under concurrent rendering,
    // causing duplicate side effects, and the batched commits can
    // interleave in ways that make a class-driven CSS rule paint a
    // frame behind). All saves and the next-mode resolution happen
    // synchronously here so setGame receives a single, fully-resolved
    // GameState.
    if (game.mode === 'endless') setSavedEndlessGame(game)
    else if (game.mode === 'daily') setSavedDailyGame(game)
    else if (game.mode === 'big') setSavedBigGame(game)

    let nextGame: GameState
    if (target === 'endless') {
      if (savedEndlessGame) {
        nextGame = savedEndlessGame
      } else {
        nextGame = createInitialGameState()
        setSavedEndlessGame(nextGame)
      }
    } else if (target === 'daily') {
      if (savedDailyGame) {
        nextGame = savedDailyGame
      } else {
        nextGame = createDailyGameState()
        setSavedDailyGame(nextGame)
      }
    } else {
      // target === 'big'
      if (savedBigGame) {
        nextGame = savedBigGame
      } else {
        nextGame = createBigGameState()
        setSavedBigGame(nextGame)
      }
    }

    setGame(nextGame)
    setSelectedPieceId(null)
    setHover(null)
  }

  const preview = useMemo(
    () =>
      hover && hover.cellId
        ? getBestPlacementPreview(
            hover.cellId,
            selectedPiece,
            game,
          )
        : null,
    [hover, selectedPiece, game],
  )

  useEffect(() => {
    if (game.moves > 0) {
      setHasStartedSession(true)
    }
  }, [game.moves])

  useEffect(() => {
    if (clearingCells.length === 0) return
    const timeout = window.setTimeout(() => {
      setClearingCells([])
      setClearingClassesByCell({})
      setClearingGoldenCellIds([])
      setPendingGoldenSpawnCellIds([])
    }, 600)
    return () => window.clearTimeout(timeout)
  }, [clearingCells])

  // Drive the screenshake animation. Removes the class, forces a reflow,
  // sets the amplitude variable, then re-adds the class so consecutive
  // shakes always restart cleanly instead of fighting an in-progress one.
  useEffect(() => {
    if (shakeRequest.intensity <= 0) return
    const node = boardWrapperRef.current
    if (!node) return
    node.classList.remove('hexaclear-shake')
    node.style.setProperty(
      '--hexaclear-shake-amp',
      String(shakeRequest.intensity),
    )
    // Force reflow so the animation actually restarts.
    void node.offsetWidth
    node.classList.add('hexaclear-shake')
    const tid = window.setTimeout(() => {
      node.classList.remove('hexaclear-shake')
    }, 380)
    return () => {
      window.clearTimeout(tid)
    }
  }, [shakeRequest])

  // Hitstop timer: clears itself after a short freeze so the clear
  // cascade and all paused animations resume together.
  useEffect(() => {
    if (!hitstop) return
    const tid = window.setTimeout(() => {
      setHitstop(false)
    }, 90)
    return () => window.clearTimeout(tid)
  }, [hitstop])

  // Clear ruby bursts after their outward animation completes so the
  // SVG nodes don't pile up across captures. Big-mode placements can
  // queue several bursts at once; once they've all played out we wipe
  // the whole list together.
  useEffect(() => {
    if (rubyBursts.length === 0) return
    const tokenAtStart = rubyBursts[rubyBursts.length - 1]!.token
    const tid = window.setTimeout(() => {
      setRubyBursts((prev) =>
        prev.length > 0 &&
        prev[prev.length - 1]!.token === tokenAtStart
          ? []
          : prev,
      )
    }, 800)
    return () => window.clearTimeout(tid)
  }, [rubyBursts])

  // Persist the reduced-motion preference so the toggle sticks across
  // sessions. The actual visual gating happens via a class on the root
  // viewport element.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        'cubic-reduced-motion',
        reducedMotion ? 'true' : 'false',
      )
    } catch {
      // Best-effort persistence.
    }
  }, [reducedMotion])

  // Persist the ad-previews toggle alongside the other prefs.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        'cubic-ad-previews',
        adPreviews ? 'true' : 'false',
      )
    } catch {
      // Best-effort persistence.
    }
  }, [adPreviews])

  // Apply the active theme to <html data-theme="..."> and persist it.
  // Every theme override in CSS is scoped under that selector so
  // switching is purely a single attribute write — no remount needed,
  // no flash, animations keep running. Also swap the tab favicon so
  // the Win98 theme gets its Minesweeper-mine icon instead of the
  // default cube glyph.
  useEffect(() => {
    if (typeof window === 'undefined') return
    document.documentElement.dataset.theme = theme
    const faviconHref = theme === 'win98' ? '/win_favicon.png' : '/favicon.png'
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link && link.getAttribute('href') !== faviconHref) {
      link.setAttribute('href', faviconHref)
    }
    try {
      window.localStorage.setItem('cubic-theme', theme)
    } catch {
      // Best-effort persistence.
    }
  }, [theme])


  // Game-over wind-down: when the run ends, give the board a beat to
  // desaturate and let the unplayable hand shake before the modal slams
  // in. Plays game_over.wav at the start of the wind-down.
  useEffect(() => {
    if (!game.gameOver) {
      setGameOverWindingDown(false)
      return
    }

    // Daily win: celebratory beat — flash the gold board-clear overlay
    // and snap directly to the modal. Skip the desaturate wind-down
    // and the game-over SFX since both read as "you lost".
    if (game.mode === 'daily' && game.dailyCompleted) {
      setBoardClearFlashToken((t) => t + 1)
      setGameOverWindingDown(false)
      return
    }

    // Endless loss / daily loss — existing wind-down with desaturate +
    // game_over SFX before the modal appears.
    setGameOverWindingDown(true)
    playGameOver()
    const tid = window.setTimeout(() => {
      setGameOverWindingDown(false)
    }, 2880)
    return () => window.clearTimeout(tid)
  }, [game.gameOver, game.dailyCompleted, game.mode])

  // Mobile pause-on-refocus: iOS suspends the AudioContext when the page
  // is backgrounded and won't auto-resume even when the page is visible
  // again — until a fresh user gesture. We re-open the main menu on
  // refocus so dismissing it counts as that gesture (the menu's Resume
  // button already calls unlockAudioOnGesture). Touch-device gated so
  // desktop users tab-switching aren't paused unnecessarily.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const isTouchDevice =
      'ontouchstart' in window ||
      (typeof navigator !== 'undefined' &&
        typeof navigator.maxTouchPoints === 'number' &&
        navigator.maxTouchPoints > 0)
    if (!isTouchDevice) return
    const handler = () => {
      if (document.visibilityState !== 'visible') return
      // Don't stack on top of an existing modal flow — the game-over
      // modal owns its moment, and the player can dismiss scoring /
      // scores modals on their own time when they come back.
      if (showScoring || showHighScores) return
      if (game.gameOver) return
      setShowMenu(true)
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [showScoring, showHighScores, game.gameOver])

  useEffect(() => {
    if (recentlyPlacedCells.length === 0) return
    const timeout = window.setTimeout(() => {
      setRecentlyPlacedCells([])
    }, 220)
    return () => window.clearTimeout(timeout)
  }, [recentlyPlacedCells])

  useEffect(() => {
    if (dailyHitPulseCells.length === 0) return
    const timeout = window.setTimeout(() => {
      setDailyHitPulseCells([])
    }, 260)
    return () => window.clearTimeout(timeout)
  }, [dailyHitPulseCells])

  // Drive the ripple radius over time so the circular wave emanates smoothly
  // from the computed center across the full board. Clears move more slowly
  // than non-clearing placements for extra weight. We animate the SVG circle's
  // radius directly via requestAnimationFrame to avoid forcing React to
  // re-render the whole tree every frame.
  useEffect(() => {
    if (!rippleCenter || rippleCells.length === 0) return

    const durationMs = rippleIsClear ? CLEAR_RIPPLE_DURATION_MS : 600
    const maxRadius = rippleMaxRadiusRef.current
    const start = performance.now()
    let frame: number

    const svg = svgRef.current
    if (!svg) return
    const circle = svg.querySelector(
      '.hexaclear-ripple-ring',
    ) as SVGCircleElement | null
    if (!circle) return

    rippleRadiusRef.current = 0
    circle.setAttribute('r', '0')

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      const r = t * maxRadius
      rippleRadiusRef.current = r
      circle.setAttribute('r', String(r))
      if (t < 1) {
        frame = window.requestAnimationFrame(step)
      }
    }

    frame = window.requestAnimationFrame(step)

    // Clear ripple state once the animation has had time to fully traverse
    // the board, without needing another React-driven effect.
    const clearTimeoutId = window.setTimeout(() => {
      setRippleCells([])
      setRippleCenter(null)
      rippleRadiusRef.current = 0
    }, durationMs + 32)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.clearTimeout(clearTimeoutId)
    }
  }, [rippleCenter, rippleToken, rippleCells.length, rippleIsClear])

  useEffect(() => {
    if (!failedPlacementPieceId && invalidDropCellIds.length === 0) return
    const timeout = window.setTimeout(() => {
      setFailedPlacementPieceId(null)
      setInvalidDropCellIds([])
    }, 480)
    return () => window.clearTimeout(timeout)
  }, [failedPlacementPieceId, invalidDropCellIds])

  useEffect(() => {
    if (goldenPopupCellIds.length === 0) return
    const tokenAtStart = goldenPopupToken
    const timeout = window.setTimeout(() => {
      setGoldenPopupCellIds((prev) =>
        tokenAtStart === goldenPopupToken ? [] : prev,
      )
    }, 900)
    return () => window.clearTimeout(timeout)
  }, [goldenPopupCellIds, goldenPopupToken])

  useEffect(() => {
    if (!scorePopup) return
    const currentId = scorePopupId
    const timeout = window.setTimeout(() => {
      setScorePopup((prev) => (currentId === scorePopupId ? null : prev))
    }, 2600)
    return () => window.clearTimeout(timeout)
  }, [scorePopup, scorePopupId])

  useEffect(() => {
    if (!game.gameOver) return

    if (game.mode === 'daily' && game.dailyCompleted) {
      const moves = game.moves
      setPendingDailyMoves(moves)
      // For daily mode, always allow the player to log today's result.
      setPendingDailyHighScore(!dailyHighScoreSaved)

      // Track the best (lowest) move count for today's daily puzzle,
      // independent of the global daily high score table.
      if (typeof window !== 'undefined') {
        const todayKey = getTodayKey()
        setTodayDailyBestMoves((prev) => {
          if (prev === null || moves < prev) {
            window.localStorage.setItem(
              `cubic-daily-best-${todayKey}`,
              String(moves),
            )
            return moves
          }
          return prev
        })
      }
    } else if (game.mode === 'endless') {
      const score = game.score
      setPendingScore(score)
      setPendingHighScore(
        !highScoreSaved && qualifiesForHighScore(score, highScores),
      )
    }
  }, [
    game.gameOver,
    game.mode,
    game.score,
    game.moves,
    game.dailyCompleted,
    highScores,
    highScoreSaved,
    dailyHighScores,
    dailyHighScoreSaved,
  ])

  // Whenever the high score modal is opened, reset the viewed daily
  // scores date back to today.
  useEffect(() => {
    if (showHighScores) {
      setDailyScoresDateKey(getTodayKey())
    }
  }, [showHighScores])

  // Persist the current game state on every change so that a refresh
  // resumes exactly where the player left off. Each mode owns its own
  // localStorage slot, plus we record which mode is active so reload
  // knows which slot to read first. The React `savedXxxGame` mirror
  // for the active mode is kept in lockstep so toggling modes mid-
  // session never sees stale state.
  useEffect(() => {
    if (typeof window === 'undefined') return
    // The room owns the source of truth in MP mode; mirroring it back to
    // localStorage would clobber the player's offline single-player save.
    if (isMultiplayer) return
    try {
      const envelope: PersistedGameEnvelope = {
        version: 1,
        mode: game.mode,
        game,
        dateKey: game.mode === 'daily' ? getTodayKey() : undefined,
      }
      window.localStorage.setItem(
        PERSIST_KEY_BY_MODE[game.mode],
        JSON.stringify(envelope),
      )
      window.localStorage.setItem(ACTIVE_MODE_KEY, game.mode)
    } catch {
      // Best-effort persistence; ignore quota/serialization errors.
    }
    if (game.mode === 'endless') setSavedEndlessGame(game)
    else if (game.mode === 'daily') setSavedDailyGame(game)
    else if (game.mode === 'big') setSavedBigGame(game)
  }, [game, isMultiplayer])

  const handleSaveHighScore = () => {
    if (pendingScore === null) return
    const name = playerName.trim() || 'Player'
    const entry: HighScoreEntry = {
      name,
      score: pendingScore,
      date: Date.now(),
    }
    const next = [...highScores, entry]
      .sort((a, b) => b.score - a.score || a.date - b.date)
      .slice(0, 5)
    setHighScores(next)
    setLastSavedHighScoreDate(entry.date)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('cubic-highscores', JSON.stringify(next))
      window.localStorage.setItem('cubic-player-name', name)
    }
    setPendingHighScore(false)
    setHighScoreSaved(true)
    // Auto-mirror to the global leaderboard. Convex dedupes on
    // (playerId, savedAt) so duplicate clicks/refreshes are a no-op.
    submitEndlessGlobal({
      playerId,
      name,
      score: entry.score,
      savedAt: entry.date,
    }).catch(() => {})
  }

  const handleSaveDailyHighScore = () => {
    if (pendingDailyMoves === null) return
    const name = playerName.trim() || 'Player'
    const entry: DailyHighScoreEntry = {
      name,
      moves: pendingDailyMoves,
      date: Date.now(),
    }
    const next = [...dailyHighScores, entry]
      .sort((a, b) => a.moves - b.moves || a.date - b.date)
      .slice(0, 5)
    setDailyHighScores(next)
    setLastSavedDailyHighScoreDate(entry.date)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(
        'cubic-daily-highscores',
        JSON.stringify(next),
      )
      const todayKey = getTodayKey()
      const existingRuns = loadDailyRunsForDateKey(todayKey)
      const nextRuns = [...existingRuns, entry].slice(-50)
      window.localStorage.setItem(
        `${DAILY_PLAYER_RUNS_PREFIX}${todayKey}`,
        JSON.stringify(nextRuns),
      )
      window.localStorage.setItem('cubic-player-name', name)
    }
    setDailyRunsToken((t) => t + 1)
    setPendingDailyHighScore(false)
    setDailyHighScoreSaved(true)
    // Auto-mirror to the global daily board, scoped to today's
    // calendar key. We don't gate this on the toggle so a player
    // who saves locally always lands on the global board too.
    submitDailyGlobal({
      playerId,
      name,
      moves: entry.moves,
      dateKey: getTodayKey(),
      savedAt: entry.date,
    }).catch(() => {})
  }

  const handleResetHighScores = () => {
    setHighScores([])
    setPendingHighScore(false)
    setPendingScore(null)
    setHighScoreSaved(false)
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('cubic-highscores')
      window.localStorage.removeItem('cubic-daily-highscores')
      window.localStorage.removeItem(`${DAILY_PLAYER_RUNS_PREFIX}${getTodayKey()}`)
    }
    setDailyHighScores([])
    setDailyRunsToken((t) => t + 1)
    setPendingDailyHighScore(false)
    setPendingDailyMoves(null)
    setDailyHighScoreSaved(false)
    setShowResetConfirm(false)
  }

  useEffect(() => {
    // True iff the given client-space point lies inside the live ×
    // marker rect for the current drag. The marker is sized via CSS
    // (50% × 50% of its slot, centered); we read its real rect off
    // the DOM rather than recomputing the inset in JS so the visual
    // and the hit-test can never drift.
    //
    // Why a small centered hit-zone, not the whole slot or hand bar:
    // pieces drag with a touch-offset preview, and on the big board
    // the bottom row of cells lines up close to the hand. A larger
    // cancel zone makes those bottom cells unreachable when the
    // player tries to place there.
    const isPointOverCancelMark = (
      clientX: number,
      clientY: number,
    ): boolean => {
      const node = cancelMarkRef.current
      if (!node) return false
      const r = node.getBoundingClientRect()
      return (
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom
      )
    }

    const updateFromClientPoint = (clientX: number, clientY: number) => {
      if (!dragState.current.pieceId) return
      const wrapper = boardWrapperRef.current
      if (!wrapper) return
      const rect = wrapper.getBoundingClientRect()
      const x = (clientX - rect.left) / scale
      const y = (clientY - rect.top) / scale
      setGhost((prev) => (prev ? { ...prev, x, y } : prev))

      // While the cursor sits over the × cancel marker, kill the
      // on-board preview entirely so cells don't light up behind the
      // held piece.
      if (isPointOverCancelMark(clientX, clientY)) {
        setHover(null)
        return
      }

      const isTouch = dragState.current.pointerType === 'touch'
      const previewOffsetY = isTouch ? 80 : 0
      const cellId = findClosestCellIdFromClientPoint(
        clientX,
        clientY - previewOffsetY,
      )
      if (cellId) {
        setHover({ cellId })
      } else {
        setHover(null)
      }
    }

    const finishDragAtPoint = (clientX: number | null, clientY: number | null) => {
      if (!dragState.current.pieceId) return
      const isTouch = dragState.current.pointerType === 'touch'
      const previewOffsetY = isTouch ? 80 : 0

      // Released over the × cancel marker — cancel the drag silently.
      // No placement attempt, no error shake, no preview-cell snap.
      // We still play the soft click_up so the gesture sounds
      // completed.
      const releasedOverCancelMark =
        clientX !== null &&
        clientY !== null &&
        isPointOverCancelMark(clientX, clientY)

      let cellId: string | null = null
      if (!releasedOverCancelMark) {
        cellId = hover?.cellId ?? null
        if (!cellId && clientX !== null && clientY !== null) {
          cellId = findClosestCellIdFromClientPoint(
            clientX,
            clientY - previewOffsetY,
          )
        }
      }
      const pieceId = dragState.current.pieceId
      // Compute the full attempted footprint for visual feedback even if
      // placement turns out to be invalid.
      let attemptedCellIds: string[] | undefined
      if (cellId && pieceId) {
        const piece = game.hand.find((p) => p.id === pieceId) ?? null
        if (piece) {
          const previewForDrop = getBestPlacementPreview(cellId, piece, game)
          attemptedCellIds = previewForDrop?.targetIds
        }
      }
      dragState.current.pointerId = null
      dragState.current.pieceId = null
      dragState.current.pointerType = null
      setDraggingPieceId(null)
      setGhost(null)

      // The player set the piece down — fire the drop click regardless
      // of whether the placement was actually valid (or whether they
      // dropped it back into the cancel slot).
      playClickUp()

      if (cellId && pieceId) {
        placePieceAtCell(pieceId, cellId, attemptedCellIds)
        // Drag-based placement is one-shot: after the player lifts off
        // the board (success or fail) we deselect so the on-board hover
        // preview stops tracking the cursor. Without this, a failed
        // drop leaves the piece "stuck" to the mouse on desktop because
        // selectedPieceId is still set and any subsequent
        // onMouseEnter on a cell re-renders the placement preview.
        // The click-to-select workflow goes through handleCellClick
        // instead, which intentionally keeps the selection alive so the
        // player can keep tapping cells.
        setSelectedPieceId(null)
      } else if (releasedOverCancelMark) {
        // Drag-cancel: also drop the click-to-select state so the next
        // pointer-down on the same piece reads as a fresh pickup
        // instead of a follow-up placement at the closest cell.
        setSelectedPieceId(null)
      }
      setHover(null)
    }

    // Pointer Events (browsers that support them well)
    const handlePointerMove = (e: PointerEvent) => {
      if (!dragState.current.pieceId) return
      updateFromClientPoint(e.clientX, e.clientY)
    }

    const handlePointerUp = (e: PointerEvent) => {
      finishDragAtPoint(e.clientX, e.clientY)
    }

    // Mouse fallback (for browsers where PointerEvents are flaky)
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState.current.pieceId) return
      // Only use this path for mouse-based drags.
      if (
        dragState.current.pointerType &&
        dragState.current.pointerType !== 'mouse'
      ) {
        return
      }
      updateFromClientPoint(e.clientX, e.clientY)
    }

    const handleMouseUp = (e: MouseEvent) => {
      if (!dragState.current.pieceId) return
      if (
        dragState.current.pointerType &&
        dragState.current.pointerType !== 'mouse'
      ) {
        return
      }
      finishDragAtPoint(e.clientX, e.clientY)
    }

    // Touch fallback (in case some Firefox builds send only touch events)
    const handleTouchMove = (e: TouchEvent) => {
      if (!dragState.current.pieceId) return
      const touch = e.touches[0]
      if (!touch) return
      if (
        dragState.current.pointerType &&
        dragState.current.pointerType !== 'touch'
      ) {
        return
      }
      updateFromClientPoint(touch.clientX, touch.clientY)
    }

    const handleTouchEnd = (e: TouchEvent) => {
      if (!dragState.current.pieceId) return
      const touch =
        e.changedTouches[0] || e.touches[0] || null
      if (touch) {
        finishDragAtPoint(touch.clientX, touch.clientY)
      } else {
        finishDragAtPoint(null, null)
      }
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('touchmove', handleTouchMove, { passive: false })
    window.addEventListener('touchend', handleTouchEnd)
    window.addEventListener('touchcancel', handleTouchEnd)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleTouchEnd)
      window.removeEventListener('touchcancel', handleTouchEnd)
    }
  }, [scale, hover])

  return (
    <div
      className={[
        'cubic-viewport',
        hitstop ? 'hitstop' : '',
        reducedMotion ? 'reduced-motion' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onDragStart={(e) => {
        e.preventDefault()
      }}
    >
      <div className="hexaclear-root" ref={rootRef}>
      {/* Win98 app titlebar — only visible when [data-theme="win98"] is
          active. Window controls are visual-only; closing/minimizing a
          web app doesn't make sense. Kept always-mounted so theme swaps
          are a single CSS reflow with no React reconciliation. */}
      <div className="hexaclear-win98-titlebar">
        <span className="title">Cubekill</span>
        <span className="title-controls" aria-hidden="true">
          <button
            type="button"
            className="title-control"
            tabIndex={-1}
            aria-label="Minimize"
          >
            <span className="glyph glyph-min" />
          </button>
          <button
            type="button"
            className="title-control"
            tabIndex={-1}
            aria-label="Maximize"
          >
            <span className="glyph glyph-max" />
          </button>
          <button
            type="button"
            className="title-control title-control-close"
            tabIndex={-1}
            aria-label="Close"
          >
            <span className="glyph glyph-close" />
          </button>
        </span>
      </div>
      {(() => {
        // Big mode is a playtest sandbox — its scores live on a
        // different scale than endless and would be confusing to mix
        // into endless's "Best" pill. Hide the best readout entirely
        // for big until it gets its own leaderboard.
        const bestValue =
          game.mode === 'daily'
            ? todayDailyBestMoves
            : game.mode === 'big'
            ? null
            : bestScore
        const showBest = bestValue !== null && bestValue !== undefined
        const liveStatLabel = game.mode === 'daily' ? 'Cubes' : 'Score'
        const liveStatValue =
          game.mode === 'daily' ? dailyCubesRemaining : game.score
        const showLiveStat = true
        return (
          <header className="hexaclear-header">
            <div className="hexaclear-header-main">
              <div className="hexaclear-title">Cubekill</div>
              {/* Names for non-self players are now surfaced under
                  each smiley in the SmileyRow below; the singular
                  "{partner} Feels:" HUD has been retired. With 0
                  other seats, we still want a "waiting for partner"
                  affordance, which we render compactly above the
                  Cubekill title in MP. */}
              {isMultiplayer && mp.otherPlayers.length === 0 && (
                <div
                  className="hexaclear-coop-hud"
                  aria-label="Waiting for partner"
                >
                  Waiting for Partner
                </div>
              )}
              <div className="hexaclear-header-main-right">
                {showBest && (
                  <div className="hexaclear-best-banner">
                    <span className="label">
                      {game.mode === 'daily' ? 'Best (today)' : 'Best'}
                    </span>
                    <span className="value">{bestValue}</span>
                  </div>
                )}
                <button
                  type="button"
                  className="hexaclear-menu-button"
                  onClick={() => {
                    playUiClick()
                    setShowMenu(true)
                  }}
                >
                  <span className="hexaclear-menu-button-icon" aria-hidden="true">
                    ⚙️
                  </span>
                  <span className="hexaclear-menu-button-label">Menu</span>
                </button>
              </div>
            </div>
            <div className="hexaclear-header-controls">
              {isMultiplayer ? (
                <div className="hexaclear-mode-toggle hexaclear-mode-toggle-coop">
                  <span className="mode-pill active" aria-disabled="true">
                    Co-op
                  </span>
                </div>
              ) : (
                <div className="hexaclear-mode-toggle">
                  <button
                    type="button"
                    className={[
                      'mode-pill',
                      game.mode === 'endless' ? 'active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      if (game.mode !== 'endless') {
                        playUiClick()
                        toggleMode('endless')
                      }
                    }}
                  >
                    Endless
                  </button>
                  <button
                    type="button"
                    className={[
                      'mode-pill',
                      game.mode === 'daily' ? 'active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      if (game.mode !== 'daily') {
                        playUiClick()
                        toggleMode('daily')
                      }
                    }}
                  >
                    Daily
                  </button>
                  <button
                    type="button"
                    className={[
                      'mode-pill',
                      game.mode === 'big' ? 'active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      if (game.mode !== 'big') {
                        playUiClick()
                        toggleMode('big')
                      }
                    }}
                  >
                    Co-op
                  </button>
                </div>
              )}
              {/* Wood theme renders the smiley row here in the
                  controls row. The Win98 theme renders a sibling
                  copy of the same SmileyRow inside the LCD row below
                  (gated by `theme === 'win98'`) — its `display:
                  contents` ancestors break the absolute-centering
                  anchor we need, so we explicitly mount it under a
                  `position: relative` parent there instead. */}
              {isMultiplayer && theme !== 'win98' && (
                <SmileyRow
                  show={showEmotePanel}
                  setShow={setShowEmotePanel}
                  selfPlayer={mp.selfPlayer}
                  otherPlayers={mp.otherPlayers}
                  activeEmoteByPlayerId={activeEmoteByPlayerId}
                  onSend={(emoji) => {
                    playUiClick()
                    mp.sendEmote(emoji).catch(() => {
                      // The mutation can fail if a partner already
                      // left the room. We silently swallow it — the
                      // emote panel will close and life goes on.
                    })
                    setShowEmotePanel(false)
                  }}
                  onToggle={() => {
                    playUiClick()
                    setShowEmotePanel((s) => !s)
                  }}
                />
              )}
              {showLiveStat ? (
                <div className="hexaclear-live-stat">
                  <span className="label">{liveStatLabel}</span>
                  <span className="value">{liveStatValue}</span>
                </div>
              ) : (
                <span className="hexaclear-live-stat-placeholder" />
              )}
            </div>
          </header>
        )
      })()}

      {/* Win98 LCD row — Minesweeper-style red 7-segment displays. Best
          on the left with its label tucked to the inside; Score on the
          right with its label tucked to the inside. Default to the
          authentic Minesweeper 3-digit width and grow naturally for
          larger values (4-digit when score hits 1000+, etc). */}
      {(() => {
        const rawBestValue =
          game.mode === 'daily'
            ? todayDailyBestMoves
            : game.mode === 'big'
            ? null
            : bestScore
        const liveStatLabel = game.mode === 'daily' ? 'Cubes' : 'Score'
        const liveStatValue =
          game.mode === 'daily' ? dailyCubesRemaining : game.score
        // Modes that don't track a persistent best (Big / co-op)
        // would otherwise leave the left LCD reading "---", which
        // looks broken on a 7-segment display. We fall back to the
        // live score there instead — same digits as the right LCD,
        // but the "Best" label stays so the layout is preserved and
        // it still reads as the slot reserved for a record. Modes
        // that DO have a best but haven't recorded one yet (e.g.
        // first-ever endless run) get the same fallback for the
        // same reason.
        const bestValue = rawBestValue ?? liveStatValue
        const bestLabel = 'Best'
        // 3 digits is the Minesweeper default; values >999 expand the
        // display naturally rather than truncating. The off-segment
        // ghost layer matches the active display length so all "8"s
        // align under whatever digits are showing.
        const padDigits = (n: number | null | undefined): string => {
          if (n === null || n === undefined) return '---'
          const num = Math.max(0, Math.floor(n))
          return String(num).padStart(3, '0')
        }
        const bestDigits = padDigits(bestValue)
        const liveDigits = padDigits(liveStatValue)
        return (
          <div className="hexaclear-win98-lcds">
            <div className="hexaclear-win98-lcd hexaclear-win98-lcd-best" aria-hidden="true">
              <span className="lcd-frame">
                <span className="lcd-digits-off">{'8'.repeat(bestDigits.length)}</span>
                <span className="lcd-digits">{bestDigits}</span>
              </span>
              <span className="lcd-label">{bestLabel}</span>
            </div>
            <div
              className="hexaclear-win98-lcd hexaclear-win98-lcd-score"
              aria-hidden="true"
            >
              <span className="lcd-label">{liveStatLabel}</span>
              <span className="lcd-frame">
                <span className="lcd-digits-off">{'8'.repeat(liveDigits.length)}</span>
                <span className="lcd-digits">{liveDigits}</span>
              </span>
            </div>
            {/* Win98 smiley row + emote panel. Sits centered between
                the two LCDs (Minesweeper layout). Conditional on
                theme so only one SmileyRow lives in the DOM at a
                time — keeps the outside-click detector unambiguous. */}
            {isMultiplayer && theme === 'win98' && (
              <SmileyRow
                show={showEmotePanel}
                setShow={setShowEmotePanel}
                selfPlayer={mp.selfPlayer}
                otherPlayers={mp.otherPlayers}
                activeEmoteByPlayerId={activeEmoteByPlayerId}
                onSend={(emoji) => {
                  playUiClick()
                  mp.sendEmote(emoji).catch(() => {})
                  setShowEmotePanel(false)
                }}
                onToggle={() => {
                  playUiClick()
                  setShowEmotePanel((s) => !s)
                }}
              />
            )}
          </div>
        )
      })()}

      {adPreviews && (
        <>
          {/* Two layout variants drive a single source asset:
              - `.hexaclear-banner-ad` runs full-width inline between
                the header and the board, used when the viewport has
                vertical room to spare (mobile portrait).
              - `.hexaclear-banner-ad-side` is a fixed-position strip
                rotated 90° on the right edge of the viewport, used
                when horizontal space is plentiful and vertical
                space is tight (desktop / landscape tablets).
              The CSS in `index.css` switches which one is visible
              based on `(orientation: landscape) and (min-width: …)`,
              so only one paints at a time. Both share the same
              gating React condition so the player only sees an ad
              when they've explicitly opted in. */}
          <img
            className="hexaclear-banner-ad"
            src="/banner_ad.png"
            alt="Sponsored banner ad preview"
          />
          <div
            className="hexaclear-banner-ad-side-frame"
            aria-hidden="true"
          >
            <img
              className="hexaclear-banner-ad-side"
              src="/banner_ad.png"
              alt=""
              draggable={false}
            />
          </div>
        </>
      )}

      <main className="hexaclear-main">
        <div
          className={[
            'hexaclear-board-wrapper',
            // Desaturate "you lost" treatment only on losses. Daily wins
            // keep their colors (and get a gold-flash flourish instead).
            game.gameOver &&
            !(game.mode === 'daily' && game.dailyCompleted)
              ? 'game-over-active'
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            aspectRatio: `${boardLayout.width} / ${boardLayout.height}`,
          }}
          ref={boardWrapperRef}
        >
          <svg
            className="hexaclear-board"
            ref={svgRef}
            viewBox={`0 0 ${boardLayout.width} ${boardLayout.height}`}
          >
            <defs>
              
              {rippleCells.length > 0 && rippleCenter && (
                <mask
                  id="hexaclear-ripple-mask"
                  maskUnits="userSpaceOnUse"
                  maskContentUnits="userSpaceOnUse"
                >
                  <rect
                    x={0}
                    y={0}
                    width={boardLayout.width}
                    height={boardLayout.height}
                    fill="black"
                  />
                  <circle
                    key={rippleToken}
                    className={[
                      'hexaclear-ripple-ring',
                      rippleIsClear ? 'clear' : 'soft',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    cx={rippleCenter.x}
                    cy={rippleCenter.y}
                    r={0}
                  />
                </mask>
              )}
            </defs>

            {/* Board hull behind everything */}
            {boardRender.outlineSegments.map((seg, idx) => (
              <line
                key={`outline-back-${idx}`}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                className="hexaclear-board-outline-back"
              />
            ))}
            {boardRender.outlineSegments.map((seg, idx) => (
              <line
                key={`outline-front-${idx}`}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                className="hexaclear-board-outline-front"
              />
            ))}

            {(() => {
              return boardDef.cells.map((cell) => {
                const pos = boardLayout.positions[cell.id]
                const cx = pos.x + boardLayout.offsetX
                const cy = pos.y + boardLayout.offsetY
                const points = buildHexPoints(cx, cy)
                const bevel = buildHexBevelPaths(cx, cy)

                const isFilledLogical = game.board[cell.id] === 'filled'
                const isClearing = clearingCells.includes(cell.id)
                const isPendingGoldenSpawn =
                  (game.mode === 'endless' || game.mode === 'big') &&
                  clearingCells.length > 0 &&
                  pendingGoldenSpawnCellIds.includes(cell.id)
                // Don't hide pieces during undo - they should reappear immediately
                const isFilledVisible = isFilledLogical && !isPendingGoldenSpawn
                const isFilled = isFilledVisible || isClearing
                const inPreview =
                  !isClearing &&
                  preview &&
                  preview.targetIds.includes(cell.id)
                const willClearInPreview =
                  preview && preview.clearedIds.includes(cell.id)
                const previewValid = preview?.valid ?? false

                const dailyHitsForCell = game.dailyHits[cell.id] ?? 0
                const isDailyTarget =
                  game.mode === 'daily' && dailyHitsForCell > 0
                const isDailyHitPulsing = dailyHitPulseCells.includes(cell.id)
                const isRecentlyPlaced = recentlyPlacedCells.includes(cell.id)
                const isInvalidDrop = invalidDropCellIds.includes(cell.id)
                const isGolden =
                  (game.mode === 'endless' || game.mode === 'big') &&
                  (clearingCells.length > 0
                    ? clearingGoldenCellIds.includes(cell.id)
                    : game.goldenCellIds.includes(cell.id))

                // In MP co-op we tint each non-self placement so a
                // viewer can see at a glance who placed which cube.
                // The `partner-piece` class drives a lightening pass
                // (brightness/saturate) and the inline hue-rotate
                // filter rotates the underlying palette by the per-
                // player offset assigned in the hook. Self-placed
                // cells stay in the default palette. Rubies have
                // their own palette and aren't owned by any player,
                // so we leave them untinted regardless.
                const isPartnerOwned =
                  isMultiplayer && !isGolden && nonSelfOwnedCells.has(cell.id)
                const partnerHueShift =
                  isPartnerOwned ? cellHueByCellId[cell.id] ?? 0 : 0
                const partnerHueStyle =
                  partnerHueShift !== 0
                    ? { filter: `hue-rotate(${partnerHueShift}deg)` }
                    : undefined

                const clearingClasses = clearingClassesByCell[cell.id] ?? []

                return (
                  <g
                    key={cell.id}
                    className={[
                      'hexaclear-cell',
                      isInvalidDrop ? 'invalid-drop' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <polygon
                      points={points}
                      className={[
                        'hexaclear-hex',
                        isFilled ? 'filled' : 'empty',
                        isGolden ? 'golden' : '',
                        isClearing ? 'clearing' : '',
                        isInvalidDrop ? 'invalid-drop' : '',
                        willClearInPreview ? 'preview-clear' : '',
                        isPartnerOwned ? 'partner-piece' : '',
                        ...clearingClasses,
                        inPreview
                          ? previewValid
                            ? 'preview-valid'
                            : 'preview-invalid'
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={partnerHueStyle}
                      role="button"
                      tabIndex={0}
                      aria-label={`${
                        isFilled ? 'Filled' : 'Empty'
                      } cell at ${cell.coord.q}, ${cell.coord.r}`}
                      onMouseEnter={() => setHover({ cellId: cell.id })}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => handleCellClick(cell.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleCellClick(cell.id)
                        }
                      }}
                    />
                    <g
                      className={[
                        'hexaclear-hex-bevels',
                        isFilled ? 'filled' : 'empty',
                        isGolden ? 'golden' : '',
                        isClearing ? 'clearing' : '',
                        willClearInPreview ? 'preview-clear' : '',
                        inPreview
                          ? previewValid
                            ? 'preview-valid'
                            : 'preview-invalid'
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-hidden="true"
                      pointerEvents="none"
                    >
                      <polyline
                        className="hexaclear-hex-bevel hexaclear-hex-bevel-highlight"
                        points={bevel.highlight}
                      />
                      <polyline
                        className="hexaclear-hex-bevel hexaclear-hex-bevel-shadow"
                        points={bevel.shadow}
                      />
                    </g>
                    {!isFilledVisible && !inPreview && !willClearInPreview && (
                      <SlotGeometry cx={cx} cy={cy} />
                    )}
                    {(isFilled || (isDailyTarget && isDailyHitPulsing)) && !isRecentlyPlaced && (
                      <CubeLines
                        cx={cx}
                        cy={cy}
                        variant={
                          isDailyTarget
                            ? 'dailyTarget'
                            : isGolden
                            ? 'golden'
                            : 'normal'
                        }
                        dailyHits={isDailyTarget ? dailyHitsForCell : undefined}
                        extraClasses={[
                          // Don't apply clearing classes to daily cubes that are just being decremented
                          ...(isDailyTarget && isDailyHitPulsing ? [] : clearingClasses),
                          isInvalidDrop ? 'invalid-drop' : '',
                          isDailyTarget && isDailyHitPulsing
                            ? 'daily-hit-pulse'
                            : '',
                          isPartnerOwned ? 'partner-piece' : '',
                        ].filter(Boolean)}
                        style={partnerHueStyle}
                      />
                    )}
                    {(game.mode === 'endless' || game.mode === 'big') &&
                      goldenPopupCellIds.includes(cell.id) && (
                        <text
                          x={cx}
                          y={cy - HEX_SIZE * 0.5}
                          className="hexaclear-golden-popup"
                        >
                          +10
                        </text>
                      )}
                    {/* Ruby capture uses the same clear animation as other cubes;
                        only the +10 popup is special. */}
                    {DEBUG_SHOW_COORDS && (
                      <text
                        x={cx}
                        y={cy + 4}
                        className="hexaclear-debug-label"
                      >
                        {cell.coord.q},{cell.coord.r}
                      </text>
                    )}
                  </g>
                )
              })
            })()}

            {/* Off-board invalid placement flash: show the attempted shape
                even when part of it falls outside the board. */}
            {invalidDropCellIds.length > 0 && (
              <g className="hexaclear-invalid-ghost">
                {invalidDropCellIds.map((id) => {
                  const cell = boardDef.cells.find((c) => c.id === id)
                  if (cell) {
                    // On-board cells are already flashing via invalid-drop.
                    return null
                  }
                  const [qStr, rStr] = id.split(',')
                  const q = Number(qStr)
                  const r = Number(rStr)
                  if (!Number.isFinite(q) || !Number.isFinite(r)) return null
                  const { x, y } = axialToPixel(q, r)
                  const cx = x + boardLayout.offsetX
                  const cy = y + boardLayout.offsetY
                  return (
                    <CubeLines
                      key={`invalid-ghost-${id}`}
                      cx={cx}
                      cy={cy}
                      variant="normal"
                      extraClasses={['invalid-drop']}
                    />
                  )
                })}
              </g>
            )}

            {rippleCells.length > 0 && rippleCenter && (
              <g
                className={[
                  'hexaclear-board-ripple-overlay',
                  rippleIsClear ? 'clear' : 'soft',
                ]
                  .filter(Boolean)
                  .join(' ')}
                mask="url(#hexaclear-ripple-mask)"
              >
                {boardDef.cells.map((cell) => {
                  const pos = boardLayout.positions[cell.id]
                  const cx = pos.x + boardLayout.offsetX
                  const cy = pos.y + boardLayout.offsetY
                  const points = buildHexPoints(cx, cy)
                  return (
                    <polygon
                      key={`ripple-overlay-${cell.id}`}
                      points={points}
                      className="hexaclear-hex ripple-overlay"
                    />
                  )
                })}
              </g>
            )}
            {/* Rosette boundaries should sit above the static board but below
                the final cube pop overlay so the highlight never hides the
                animation. */}
            {boardRender.flowerBoundarySegments.map((seg, idx) => (
              <line
                key={`flower-back-${idx}`}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                className="hexaclear-flower-boundary-back"
              />
            ))}
            <g className="hexaclear-flower-boundary-group">
              {boardRender.flowerBoundarySegments.map((seg, idx) => (
                <line
                  key={`flower-front-${idx}`}
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  className="hexaclear-flower-boundary"
                />
              ))}
            </g>
            {/* Win98 etched-groove rosette frame. One closed
                polygon per rosette per groove tone; CSS hides the
                whole group in non-Win98 themes. The polygons sit
                above per-cell bevels and surfaces but below the
                cube/label content, so the etched ring traces the
                rosette without obscuring scoring text. */}
            <g
              className="hexaclear-flower-groove-group"
              aria-hidden="true"
              pointerEvents="none"
            >
              {boardRender.flowerBoundaryLoops.map((loop, idx) => (
                <g key={`flower-groove-${idx}`}>
                  {loop.dark.length > 0 && (
                    <polygon
                      className="hexaclear-flower-groove hexaclear-flower-groove-dark"
                      points={loop.dark
                        .map((v) => `${v.x},${v.y}`)
                        .join(' ')}
                    />
                  )}
                  {loop.light.length > 0 && (
                    <polygon
                      className="hexaclear-flower-groove hexaclear-flower-groove-light"
                      points={loop.light
                        .map((v) => `${v.x},${v.y}`)
                        .join(' ')}
                    />
                  )}
                </g>
              ))}
            </g>

            {preview && selectedPiece && hover?.cellId && !preview.valid && (
              <PlacementGhost
                originCellId={hover.cellId}
                piece={selectedPiece}
                valid={false}
                boardDef={boardDef}
                layout={boardLayout}
              />
            )}
            {/* Final overlay: animate the whole placed shape as a unit while it
                "locks in" to the board. */}
            {recentlyPlacedCells.length > 0 && (
              <g className="hexaclear-placed-overlay placed-impact">
                {(() => {
                  return recentlyPlacedCells.map((id) => {
                    const cell = boardDef.cells.find((c) => c.id === id)
                    if (!cell) return null
                    const pos = boardLayout.positions[cell.id]
                    const cx = pos.x + boardLayout.offsetX
                    const cy = pos.y + boardLayout.offsetY
                    const dailyHitsForCell = game.dailyHits[cell.id] ?? 0
                    const isDailyTarget =
                      game.mode === 'daily' && dailyHitsForCell > 0
                    const isGolden =
                      (game.mode === 'endless' || game.mode === 'big') &&
                      ((clearingCells.length > 0 &&
                        clearingGoldenCellIds.includes(cell.id)) ||
                        (clearingCells.length === 0 &&
                          game.goldenCellIds.includes(cell.id)))
                    if (game.board[cell.id] !== 'filled') return null
                    return (
                      <CubeLines
                        key={`placed-overlay-${cell.id}`}
                        cx={cx}
                        cy={cy}
                        variant={
                          isDailyTarget
                            ? 'dailyTarget'
                            : isGolden
                            ? 'golden'
                            : 'normal'
                        }
                        dailyHits={isDailyTarget ? dailyHitsForCell : undefined}
                      />
                    )
                  })
                })()}
              </g>
            )}

            {/* Ruby capture bursts: a radial spray of small shards
                that flies out from each cleared ruby's last cell. Big
                mode often queues several at once when a placement
                clears multiple rubies in the same combo. */}
            {rubyBursts.map((burst) => (
              <g
                key={burst.token}
                className="hexaclear-ruby-burst"
                pointerEvents="none"
              >
                {Array.from({ length: 12 }).map((_, i) => {
                  const angle = (i / 12) * Math.PI * 2
                  const dist = HEX_SIZE * (1.8 + ((i % 3) * 0.25))
                  const dx = Math.cos(angle) * dist
                  const dy = Math.sin(angle) * dist
                  return (
                    <circle
                      key={i}
                      cx={burst.x}
                      cy={burst.y}
                      r={3.4}
                      className="hexaclear-ruby-shard"
                      style={{
                        ['--ruby-shard-dx' as string]: `${dx}px`,
                        ['--ruby-shard-dy' as string]: `${dy}px`,
                        ['--ruby-shard-delay' as string]: `${(i % 3) * 18}ms`,
                      }}
                    />
                  )
                })}
              </g>
            ))}
          </svg>
          {boardClearFlashToken > 0 && (
            <div
              key={boardClearFlashToken}
              className="hexaclear-board-clear-flash"
              aria-hidden="true"
            />
          )}
          <div className="hexaclear-board-hud">
            {game.mode === 'daily' ? (
              <div className="board-hud-block left">
                {game.moves === 0 && (
                  <span className="value small">
                    Clear all numbered cubes to win!
                  </span>
                )}
              </div>
            ) : (
              <div className="board-hud-block left">
                {game.streak > 0 && (
                  <span
                    key={game.streak}
                    className={[
                      'value',
                      'hexaclear-streak-value',
                      `hexaclear-streak-tier-${Math.min(6, game.streak)}`,
                    ].join(' ')}
                  >
                    Streak {game.streak}
                  </span>
                )}
              </div>
            )}
            {/* Copy Link CTA only renders when an invite is actually
                useful: solo Co-op (pre-room) or in MP with at least
                one open seat left. Once the room is full, the button
                steps out of the way — sharing the link again would
                only invite an evictor at that point. */}
            {game.mode === 'big' &&
              (!isMultiplayer || mp.allPlayers.length < 8) && (
              <div className="board-hud-block right hexaclear-coop-block">
                <button
                  type="button"
                  className={[
                    'hexaclear-coop-cta',
                    copyLinkLabel === 'copied' ? 'is-copied' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => {
                    unlockAudioOnGesture()
                    playUiClick()
                    void handleCopyLinkAction()
                  }}
                  disabled={copyLinkLabel === 'busy'}
                >
                  {copyLinkLabel === 'copied'
                    ? 'Copied!'
                    : copyLinkLabel === 'busy'
                    ? 'Creating…'
                    : 'Copy Link'}
                </button>
              </div>
            )}
          </div>
          {undoStack.length > 0 && !game.gameOver && (
            <button
              type="button"
              className="hexaclear-undo-button"
              onClick={() => {
                playUiClick()
                handleUndo()
              }}
            >
              Undo
        </button>
          )}
          {ghost && (
            <div
              className="hexaclear-ghost"
              style={{
                left: ghost.x,
                top: ghost.y,
                transform: 'translate(-30%, -10%)',
              }}
            >
              <PiecePreview shape={ghost.piece.shape} mode="board" />
            </div>
          )}
          {undoAnimation && (
            <div
              className="hexaclear-undo-animation"
              style={{
                left: undoAnimation.startX,
                top: undoAnimation.startY,
                '--undo-delta-x': `${undoAnimation.endX - undoAnimation.startX}px`,
                '--undo-delta-y': `${undoAnimation.endY - undoAnimation.startY}px`,
              } as React.CSSProperties & { '--undo-delta-x': string; '--undo-delta-y': string }}
            >
              <PiecePreview shape={undoAnimation.piece.shape} mode="board" />
            </div>
          )}
          {scorePopup && game.mode !== 'daily' && (
            <div className="hexaclear-score-popup">{scorePopup}</div>
          )}
          {scoreParticles.length > 0 && game.mode !== 'daily' && (
            <div className="hexaclear-score-particles">
              {scoreParticles.map((particle) => (
                <div
                  key={particle.id}
                  className={`hexaclear-score-particle hexaclear-score-particle-${particle.type}`}
                  style={{
                    left: particle.startX,
                    top: particle.startY,
                    '--particle-delta-x': `${particle.deltaX}px`,
                    '--particle-delta-y': `${particle.deltaY}px`,
                    animationDelay: `${particle.delay}ms`,
                  } as React.CSSProperties & {
                    '--particle-delta-x': string
                    '--particle-delta-y': string
                  }}
                >
                  <span className="hexaclear-score-particle-value">
                    +{particle.value}
                  </span>
                  {particle.label && (
                    <span className="hexaclear-score-particle-label">
                      {particle.label}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {game.gameOver && game.mode === 'endless' && !gameOverWindingDown && (
            <div className="hexaclear-overlay">
              <div className="hexaclear-overlay-card hexaclear-gameover-card">
                <div className="title">Game Over</div>

                <div className="hexaclear-gameover-headline">
                  <div className="hexaclear-gameover-headline-label">
                    Final score
                  </div>
                  <div className="hexaclear-gameover-headline-value">
                    {game.score}
                  </div>
                </div>

                {pendingHighScore && (
                  <div className="hexaclear-gameover-section">
                    <div className="hexaclear-gameover-section-label">
                      New high score
                    </div>
                    <div className="hexaclear-gameover-input-row">
                      <input
                        className="hexaclear-input"
                        value={playerName}
                        onChange={(e) => setPlayerName(e.target.value)}
                        placeholder="Your name"
                      />
                      <button
                        type="button"
                        className="hexaclear-gameover-save-button"
                        onClick={() => {
                          playUiClick()
                          handleSaveHighScore()
                        }}
                      >
                        Save score
                      </button>
                    </div>
                  </div>
                )}

                {highScores.length > 0 && (
                  <div className="hexaclear-gameover-section">
                    <div className="hexaclear-gameover-section-label">
                      Top scores
                    </div>
                    <ol className="hexaclear-scores-list">
                      {highScores
                        .slice()
                        .sort((a, b) => b.score - a.score || a.date - b.date)
                        .slice(0, 5)
                        .map((entry, idx) => {
                          const isRecent =
                            highScoreSaved &&
                            lastSavedHighScoreDate !== null &&
                            entry.date === lastSavedHighScoreDate
                          const rank = idx + 1
                          const chipClass = [
                            'hexaclear-rank-chip',
                            rank === 1
                              ? 'hexaclear-chip-trophy'
                              : rank <= 3
                                ? 'hexaclear-chip-gold'
                                : 'hexaclear-chip-neutral',
                          ].join(' ')
                          return (
                            <li
                              key={entry.date + entry.name + idx}
                              className={[
                                'hexaclear-scores-row',
                                isRecent ? 'recent' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                            >
                              <span className={chipClass}>{rank}</span>
                              <span className="hexaclear-scores-name">
                                {entry.name}
                              </span>
                              <span className="hexaclear-scores-value">
                                {entry.score}
                              </span>
                            </li>
                          )
                        })}
                    </ol>
                  </div>
                )}

                {undoStack.length > 0 && !highScoreSaved && (
                  <button
                    type="button"
                    className="hexaclear-menu-link"
                    onClick={() => {
                      playUiClick()
                      handleUndo()
                    }}
                  >
                    Undo last move
                  </button>
                )}

                <button
                  type="button"
                  className="hexaclear-gameover-cta"
                  onClick={() => {
                    playUiClick()
                    // Autosave the high score on dismiss so the
                    // "Save score" button is just a confirm shortcut —
                    // if the player walks away without clicking it
                    // (or without typing a custom name) we still log
                    // their run with whatever's in the field.
                    if (pendingHighScore) {
                      handleSaveHighScore()
                    }
                    resetGame()
                  }}
                >
                  Play again
                </button>
              </div>
            </div>
          )}
          {game.gameOver && game.mode === 'big' && !gameOverWindingDown && (
            <div className="hexaclear-overlay">
              <div className="hexaclear-overlay-card hexaclear-gameover-card">
                <div className="title">
                  {isMultiplayer ? 'Co-op finished' : 'Game Over'}
                </div>

                <div className="hexaclear-gameover-headline">
                  <div className="hexaclear-gameover-headline-label">
                    Final score
                  </div>
                  <div className="hexaclear-gameover-headline-value">
                    {game.score}
                  </div>
                </div>

                {!isMultiplayer && undoStack.length > 0 && (
                  <button
                    type="button"
                    className="hexaclear-menu-link"
                    onClick={() => {
                      playUiClick()
                      handleUndo()
                    }}
                  >
                    Undo last move
                  </button>
                )}

                {isMultiplayer ? (
                  <>
                    {/* Keep the same room/partner — just rerack and
                        play again. Either player can fire it; the
                        server reset propagates to both clients. */}
                    <button
                      type="button"
                      className="hexaclear-gameover-cta"
                      onClick={() => {
                        playUiClick()
                        handleRestartCoop()
                      }}
                    >
                      New game
                    </button>
                    <button
                      type="button"
                      className="hexaclear-menu-link"
                      onClick={() => {
                        playUiClick()
                        handleLeaveRoom()
                      }}
                    >
                      Back to single player
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="hexaclear-gameover-cta"
                    onClick={() => {
                      playUiClick()
                      resetGame()
                    }}
                  >
                    Play again
                  </button>
                )}
              </div>
            </div>
          )}
          {/* The old "Waiting for a partner…" modal is gone — Copy
              Link writes the URL straight to the clipboard without
              any overlay. While the room sits in 'waiting' state,
              the player keeps playing on the shared board so their
              run isn't blocked by a missing partner. */}
          {isMultiplayer && (mp.status === 'not-found' || mpError) && (
            <div className="hexaclear-overlay">
              <div className="hexaclear-overlay-card hexaclear-coop-error-card">
                <div className="title">Couldn't join</div>
                <p className="hexaclear-coop-error-message">
                  {mpError ||
                    (mp.status === 'not-found'
                      ? 'That room no longer exists. Try creating a new one.'
                      : 'Something went wrong.')}
                </p>
                <button
                  type="button"
                  className="hexaclear-reset"
                  onClick={() => {
                    playUiClick()
                    handleLeaveRoom()
                  }}
                >
                  Back to single player
                </button>
              </div>
            </div>
          )}
          {game.gameOver && game.mode === 'daily' && !gameOverWindingDown && (
            <div className="hexaclear-overlay">
              <div
                className={[
                  'hexaclear-overlay-card',
                  'hexaclear-gameover-card',
                  game.dailyCompleted ? 'daily-win' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div className="title">
                  {game.dailyCompleted ? 'Daily Cleared' : 'Daily Over'}
                </div>

                <div className="hexaclear-gameover-headline">
                  <div className="hexaclear-gameover-headline-label">
                    {game.dailyCompleted ? 'Cleared in' : 'Used'}
                  </div>
                  <div className="hexaclear-gameover-headline-value">
                    {game.moves}
                  </div>
                  <div className="hexaclear-gameover-headline-label">
                    {game.moves === 1 ? 'move' : 'moves'}
                  </div>
                </div>

                {!game.dailyCompleted && dailyCubesRemaining > 0 && (
                  <div className="hexaclear-gameover-subhead">
                    {dailyCubesRemaining}{' '}
                    {dailyCubesRemaining === 1 ? 'cube' : 'cubes'} still
                    standing — goal is to clear every numbered cube.
                  </div>
                )}

                {pendingDailyHighScore && (
                  <div className="hexaclear-gameover-section">
                    <div className="hexaclear-gameover-section-label">
                      {game.dailyCompleted
                        ? 'New daily best'
                        : 'Log this attempt'}
                    </div>
                    <div className="hexaclear-gameover-input-row">
                      <input
                        className="hexaclear-input"
                        value={playerName}
                        onChange={(e) => setPlayerName(e.target.value)}
                        placeholder="Your name"
                      />
                      <button
                        type="button"
                        className="hexaclear-gameover-save-button"
                        onClick={() => {
                          playUiClick()
                          handleSaveDailyHighScore()
                        }}
                      >
                        Save daily result
                      </button>
                    </div>
                  </div>
                )}

                {todayPlayerDailyRuns.length > 0 && (
                  <div className="hexaclear-gameover-section">
                    <div className="hexaclear-gameover-section-label">
                      Your best today
                    </div>
                    <ol className="hexaclear-scores-list">
                      {todayPlayerDailyRuns.slice(0, 5).map((entry, idx) => {
                        const isRecent =
                          dailyHighScoreSaved &&
                          lastSavedDailyHighScoreDate !== null &&
                          entry.date === lastSavedDailyHighScoreDate
                        const rank = idx + 1
                        const chipClass = [
                          'hexaclear-rank-chip',
                          rank === 1
                            ? 'hexaclear-chip-trophy'
                            : rank <= 3
                              ? 'hexaclear-chip-gold'
                              : 'hexaclear-chip-neutral',
                        ].join(' ')
                        return (
                          <li
                            key={entry.date + entry.name + idx}
                            className={[
                              'hexaclear-scores-row',
                              isRecent ? 'recent' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            <span className={chipClass}>{rank}</span>
                            <span className="hexaclear-scores-name">
                              {entry.name || 'You'}
                            </span>
                            <span className="hexaclear-scores-value">
                              {entry.moves}{' '}
                              {entry.moves === 1 ? 'move' : 'moves'}
                            </span>
                          </li>
                        )
                      })}
                    </ol>
                  </div>
                )}

                {undoStack.length > 0 && !dailyHighScoreSaved && (
                  <button
                    type="button"
                    className="hexaclear-menu-link"
                    onClick={() => {
                      playUiClick()
                      handleUndo()
                    }}
                  >
                    Undo last move
                  </button>
                )}

                <button
                  type="button"
                  className="hexaclear-gameover-cta"
                  onClick={() => {
                    playUiClick()
                    // Autosave on dismiss — see the endless-mode
                    // counterpart above. The Save button stays as a
                    // visible confirm action, but stepping away from
                    // the modal still records the attempt.
                    if (pendingDailyHighScore) {
                      handleSaveDailyHighScore()
                    }
                    const next = createDailyGameState()
                    setGame(next)
                    setSavedDailyGame(next)
                    setDailyHighScoreSaved(false)
                    setSelectedPieceId(null)
                    setHover(null)
                  }}
                >
                  Retry today&apos;s puzzle
                </button>
              </div>
            </div>
          )}
          {showMenu && (
            <div className="hexaclear-overlay">
              <div className="hexaclear-overlay-card hexaclear-menu-card">
                <div className="title">Cubekill</div>
                <div className="hexaclear-menu-hint">
                  Drag pieces from the tray onto the board. Complete a
                  full line or rosette to clear it.
                </div>

                <div className="hexaclear-menu-rows">
                  {isMultiplayer && (
                    <label className="hexaclear-menu-row">
                      <span className="hexaclear-menu-row-label">
                        Co-op name
                      </span>
                      <input
                        type="text"
                        className="hexaclear-menu-row-text"
                        value={mpPlayerName}
                        maxLength={20}
                        onChange={(e) => setMpPlayerName(e.target.value)}
                        aria-label="Co-op display name"
                      />
                    </label>
                  )}
                  <label className="hexaclear-menu-row">
                    <span className="hexaclear-menu-row-label">Volume</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={Math.round(volume * 100)}
                      disabled={audioMuted}
                      onChange={(e) => {
                        const v = Number(e.target.value) / 100
                        setVolumeState(v)
                        setMasterVolume(v)
                      }}
                      aria-label="Volume"
                    />
                    <span className="hexaclear-menu-row-readout">
                      {Math.round(volume * 100)}%
                    </span>
                  </label>
                  <label className="hexaclear-menu-row">
                    <span className="hexaclear-menu-row-label">Mute</span>
                    <input
                      type="checkbox"
                      checked={audioMuted}
                      onChange={(e) => {
                        const next = e.target.checked
                        setAudioMutedState(next)
                        setMuted(next)
                        // After mute state is updated:
                        //   unmuting -> click is now audible (signals "audio back")
                        //   muting   -> click is silenced (visual change confirms it)
                        playUiClick()
                      }}
                    />
                  </label>
                  <label className="hexaclear-menu-row">
                    <span className="hexaclear-menu-row-label">
                      Reduced motion
                    </span>
                    <input
                      type="checkbox"
                      checked={reducedMotion}
                      onChange={(e) => {
                        setReducedMotion(e.target.checked)
                        playUiClick()
                      }}
                    />
                  </label>
                  <label className="hexaclear-menu-row">
                    <span className="hexaclear-menu-row-label">
                      Ad previews
                    </span>
                    <input
                      type="checkbox"
                      checked={adPreviews}
                      onChange={(e) => {
                        setAdPreviews(e.target.checked)
                        playUiClick()
                      }}
                    />
                  </label>
                  <label className="hexaclear-menu-row">
                    <span className="hexaclear-menu-row-label">Theme</span>
                    <select
                      className="hexaclear-menu-row-select"
                      value={theme}
                      onChange={(e) => {
                        setTheme(e.target.value as ThemeId)
                        playUiClick()
                      }}
                      aria-label="Theme"
                    >
                      {THEME_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="hexaclear-menu-links">
                  <button
                    type="button"
                    className="hexaclear-menu-link"
                    onClick={() => {
                      unlockAudioOnGesture()
                      playUiClick()
                      setShowMenu(false)
                      setShowScoring(true)
                    }}
                  >
                    How to score
                  </button>
                  <span className="hexaclear-menu-link-sep" aria-hidden="true">
                    •
                  </span>
                  <button
                    type="button"
                    className="hexaclear-menu-link"
                    onClick={() => {
                      unlockAudioOnGesture()
                      playUiClick()
                      setShowMenu(false)
                      setShowHighScores(true)
                    }}
                  >
                    High scores
                  </button>
                </div>

                  {/* In MP we always show the Resume + Leave co-op
                      pair, regardless of whether the player has
                      placed a piece yet. The "fresh new game" menu
                      pair only makes sense for single-player runs. */}
                  {hasStartedSession || isMultiplayer ? (
                  <>
                    {isMultiplayer ? (
                      <button
                        type="button"
                        className="hexaclear-menu-restart-link"
                        onClick={() => {
                          unlockAudioOnGesture()
                          playUiClick()
                          setShowMenu(false)
                          handleLeaveRoom()
                        }}
                      >
                        Leave co-op
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="hexaclear-menu-restart-link"
                        onClick={() => {
                          unlockAudioOnGesture()
                          playUiClick()
                          setShowMenu(false)
                          resetGame()
                        }}
                      >
                        Restart run
                      </button>
                    )}

                    <button
                      type="button"
                      className="hexaclear-reset"
                      onClick={() => {
                        unlockAudioOnGesture()
                        playUiClick()
                        setShowMenu(false)
                      }}
                    >
                      Resume
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="hexaclear-menu-new-game"
                    onClick={() => {
                      unlockAudioOnGesture()
                      playUiClick()
                      setHasStartedSession(true)
                      setShowMenu(false)
                    }}
                  >
                    New Game
                  </button>
                )}
              </div>
            </div>
          )}
          {showScoring && (
            <div className="hexaclear-overlay">
              <div className="hexaclear-overlay-card hexaclear-scoring-card">
                {game.mode === 'daily' ? (
                  <>
                    <div className="title">Daily Puzzles</div>
                    <div className="hexaclear-scoring-rules">
                      <div className="hexaclear-scoring-rule">
                        <span className="hexaclear-chip hexaclear-chip-goal">
                          Goal
                        </span>
                        <div className="hexaclear-scoring-rule-text">
                          <div className="hexaclear-scoring-rule-title">
                            Clear every numbered cube
                          </div>
                          <div className="hexaclear-scoring-rule-desc">
                            Hit each cube the number of times shown on it.
                          </div>
                        </div>
                      </div>
                      <div className="hexaclear-scoring-rule">
                        <span className="hexaclear-chip hexaclear-chip-neutral">
                          1 Move
                        </span>
                        <div className="hexaclear-scoring-rule-text">
                          <div className="hexaclear-scoring-rule-title">
                            Each placement counts
                          </div>
                          <div className="hexaclear-scoring-rule-desc">
                            Every piece you place adds one move to the run.
                          </div>
                        </div>
                      </div>
                      <div className="hexaclear-scoring-rule">
                        <span className="hexaclear-chip hexaclear-chip-trophy">
                          Best
                        </span>
                        <div className="hexaclear-scoring-rule-text">
                          <div className="hexaclear-scoring-rule-title">
                            Fewest moves wins
                          </div>
                          <div className="hexaclear-scoring-rule-desc">
                            Your best daily run is the one finished in the
                            fewest moves.
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  (() => {
                    // Per-mode scoring numbers shown in the rules card.
                    // Mirrors SCORING_BY_MODE in gameLogic.ts so the UI
                    // and the actual point values never drift.
                    const isBig = game.mode === 'big'
                    const clearPoints = isBig ? 40 : 10
                    const boardClearPoints = isBig ? 100 : 25
                    const rosetteSize = isBig ? 'nineteen-cube' : 'six-cube'
                    return (
                      <>
                        <div className="title">How To Score</div>
                        <div className="hexaclear-scoring-rules">
                          <div className="hexaclear-scoring-rule">
                            <span className="hexaclear-chip hexaclear-chip-gold">
                              +{clearPoints}
                            </span>
                            <div className="hexaclear-scoring-rule-text">
                              <div className="hexaclear-scoring-rule-title">
                                Line or rosette clear
                              </div>
                              <div className="hexaclear-scoring-rule-desc">
                                Fill a straight line or a {rosetteSize} rosette.
                              </div>
                            </div>
                          </div>
                          <div className="hexaclear-scoring-rule">
                            <span className="hexaclear-chip hexaclear-chip-multiplier">
                              Combo
                            </span>
                            <div className="hexaclear-scoring-rule-text">
                              <div className="hexaclear-scoring-rule-title">
                                Combo multiplier
                              </div>
                              <div className="hexaclear-scoring-rule-desc">
                                Clear several lines or rosettes in one
                                placement to multiply the points by 1.5&times;
                                per extra clear.
                              </div>
                            </div>
                          </div>
                          <div className="hexaclear-scoring-rule">
                            <span className="hexaclear-chip hexaclear-chip-multiplier">
                              Streak
                            </span>
                            <div className="hexaclear-scoring-rule-text">
                              <div className="hexaclear-scoring-rule-title">
                                Streak multiplier
                              </div>
                              <div className="hexaclear-scoring-rule-desc">
                                Clear on back-to-back placements to multiply
                                the points by a stacking 1.1&times; per
                                consecutive clear.
                              </div>
                            </div>
                          </div>
                          <div className="hexaclear-scoring-rule">
                            <span className="hexaclear-chip hexaclear-chip-ruby">
                              +10
                            </span>
                            <div className="hexaclear-scoring-rule-text">
                              <div className="hexaclear-scoring-rule-title">
                                Ruby bonus
                              </div>
                              <div className="hexaclear-scoring-rule-desc">
                                Clearing a ruby cube grants extra points.
                              </div>
                            </div>
                          </div>
                          <div className="hexaclear-scoring-rule">
                            <span className="hexaclear-chip hexaclear-chip-big">
                              +{boardClearPoints}
                            </span>
                            <div className="hexaclear-scoring-rule-text">
                              <div className="hexaclear-scoring-rule-title">
                                Board clear
                              </div>
                              <div className="hexaclear-scoring-rule-desc">
                                Clear the entire board to get {boardClearPoints}{' '}
                                bonus points.
                              </div>
                            </div>
                          </div>
                          <div className="hexaclear-scoring-rule">
                            <span className="hexaclear-chip hexaclear-chip-small">
                              +1
                            </span>
                            <div className="hexaclear-scoring-rule-text">
                              <div className="hexaclear-scoring-rule-title">
                                Per cube placed
                              </div>
                              <div className="hexaclear-scoring-rule-desc">
                                Every cube you set down is worth one point.
                              </div>
                            </div>
                          </div>
                        </div>
                      </>
                    )
                  })()
                )}
                <button
                  type="button"
                  className="hexaclear-reset"
                  onClick={() => {
                    playUiClick()
                    setShowScoring(false)
                    setShowMenu(true)
                  }}
                >
                  Back
                </button>
              </div>
            </div>
          )}
          {showHighScores && (() => {
            const todayKey = getTodayKey()
            // When the global toggle is on, we render directly off
            // the live Convex queries and pin the daily section to
            // today (per product call). When off, we keep the local
            // lists with the date stepper so old behavior is intact.
            const sortedEndless = showGlobalLeaderboard
              ? (globalEndlessScores ?? []).map((e) => ({
                  name: e.name,
                  score: e.score,
                  date: e.savedAt,
                }))
              : highScores
                  .slice()
                  .sort((a, b) => b.score - a.score || a.date - b.date)
            const dailyEntriesForDay = showGlobalLeaderboard
              ? (globalDailyScores ?? []).map((e) => ({
                  name: e.name,
                  moves: e.moves,
                  date: e.savedAt,
                }))
              : dailyHighScores
                  .slice()
                  .filter(
                    (entry) =>
                      getDateKeyFromTimestamp(entry.date) ===
                      dailyScoresDateKey,
                  )
                  .sort((a, b) => a.moves - b.moves || a.date - b.date)
            const sortedCoop = showGlobalLeaderboard
              ? (globalCoopScores ?? []).map((e) => ({
                  name: e.name,
                  score: e.score,
                  date: e.finishedAt,
                }))
              : []
            const globalLoading =
              showGlobalLeaderboard &&
              (globalEndlessScores === undefined ||
                globalDailyScores === undefined ||
                globalCoopScores === undefined)
            const dailyDateKeyForDisplay = showGlobalLeaderboard
              ? todayKey
              : dailyScoresDateKey
            const rankClass = (rank: number) =>
              rank === 1
                ? 'hexaclear-chip-trophy'
                : rank <= 3
                  ? 'hexaclear-chip-gold'
                  : 'hexaclear-chip-neutral'
            // The co-op tab only makes sense when the global toggle
            // is on (there is no local co-op storage). If the player
            // flips global off while sitting on the co-op tab, snap
            // them back to endless on the next render so the modal
            // doesn't show a stale empty board.
            const effectiveTab: HighScoreTab =
              highScoreTab === 'coop' && !showGlobalLeaderboard
                ? 'endless'
                : highScoreTab
            const tabButton = (id: HighScoreTab, label: string) => (
              <button
                key={id}
                type="button"
                className={[
                  'hexaclear-scores-tab',
                  effectiveTab === id ? 'is-active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  playUiClick()
                  setHighScoreTab(id)
                }}
                aria-pressed={effectiveTab === id}
              >
                {label}
              </button>
            )
            return (
              <div className="hexaclear-overlay">
                <div className="hexaclear-overlay-card hexaclear-scores-card">
                  <div className="title">High Scores</div>

                  <label className="hexaclear-scores-global-toggle">
                    <input
                      type="checkbox"
                      checked={showGlobalLeaderboard}
                      onChange={(e) => {
                        playUiClick()
                        setShowGlobalLeaderboard(e.target.checked)
                      }}
                    />
                    <span>Show global</span>
                  </label>

                  <div
                    className="hexaclear-scores-tabs"
                    role="tablist"
                    aria-label="Leaderboard"
                  >
                    {tabButton('endless', 'Endless')}
                    {tabButton('daily', 'Daily')}
                    {showGlobalLeaderboard && tabButton('coop', 'Co-op')}
                  </div>

                  {effectiveTab === 'endless' && (
                    <div className="hexaclear-scores-section">
                      <div className="hexaclear-scores-section-label">
                        Endless · highest score
                        {showGlobalLeaderboard ? ' (global)' : ''}
                      </div>
                      {globalLoading ? (
                        <p className="hexaclear-scores-empty">Loading global scores…</p>
                      ) : sortedEndless.length === 0 ? (
                        <p className="hexaclear-scores-empty">
                          {showGlobalLeaderboard
                            ? 'No global endless scores yet.'
                            : 'No endless scores yet. Play a game!'}
                        </p>
                      ) : (
                        <ol className="hexaclear-scores-list">
                          {sortedEndless.map((entry, idx) => {
                            const isRecent =
                              highScoreSaved &&
                              lastSavedHighScoreDate !== null &&
                              entry.date === lastSavedHighScoreDate
                            const rank = idx + 1
                            return (
                              <li
                                key={entry.date + entry.name + idx}
                                className={
                                  'hexaclear-scores-row' +
                                  (isRecent ? ' recent' : '')
                                }
                              >
                                <span
                                  className={`hexaclear-rank-chip ${rankClass(rank)}`}
                                  aria-hidden="true"
                                >
                                  {rank}
                                </span>
                                <span className="hexaclear-scores-name">
                                  {entry.name}
                                </span>
                                <span className="hexaclear-scores-value">
                                  {entry.score}
                                </span>
                              </li>
                            )
                          })}
                        </ol>
                      )}
                    </div>
                  )}

                  {effectiveTab === 'daily' && (
                    <div className="hexaclear-scores-section">
                      <div className="hexaclear-scores-section-label">
                        Daily · fewest moves
                        {showGlobalLeaderboard ? ' (global · today)' : ''}
                      </div>
                      {!showGlobalLeaderboard && (
                      <div className="hexaclear-scores-date-stepper">
                        <button
                          type="button"
                          className="hexaclear-scores-date-step"
                          aria-label="Previous day"
                          onClick={() => {
                            playUiClick()
                            setDailyScoresDateKey((prev) =>
                              shiftDateKey(prev || getTodayKey(), -1),
                            )
                          }}
                        >
                          ‹
                        </button>
                        <span className="hexaclear-scores-date-label">
                          {dailyScoresDateKey}
                        </span>
                        <button
                          type="button"
                          className="hexaclear-scores-date-step"
                          aria-label="Next day"
                          onClick={() => {
                            playUiClick()
                            const today = getTodayKey()
                            setDailyScoresDateKey((prev) => {
                              const next = shiftDateKey(prev || today, 1)
                              return next > today ? today : next
                            })
                          }}
                          disabled={dailyScoresDateKey >= todayKey}
                        >
                          ›
                        </button>
                      </div>
                      )}
                      {globalLoading ? (
                        <p className="hexaclear-scores-empty">Loading global scores…</p>
                      ) : dailyEntriesForDay.length === 0 ? (
                        <p className="hexaclear-scores-empty">
                          No scores stored for this date
                          {dailyDateKeyForDisplay === todayKey
                            ? ". Play today's puzzle!"
                            : '.'}
                        </p>
                      ) : (
                        <ol className="hexaclear-scores-list">
                          {dailyEntriesForDay.map((entry, idx) => {
                            const isRecent =
                              dailyHighScoreSaved &&
                              lastSavedDailyHighScoreDate !== null &&
                              entry.date === lastSavedDailyHighScoreDate
                            const rank = idx + 1
                            return (
                              <li
                                key={entry.date + entry.name + idx}
                                className={
                                  'hexaclear-scores-row' +
                                  (isRecent ? ' recent' : '')
                                }
                              >
                                <span
                                  className={`hexaclear-rank-chip ${rankClass(rank)}`}
                                  aria-hidden="true"
                                >
                                  {rank}
                                </span>
                                <span className="hexaclear-scores-name">
                                  {entry.name}
                                </span>
                                <span className="hexaclear-scores-value">
                                  {entry.moves} moves
                                </span>
                              </li>
                            )
                          })}
                        </ol>
                      )}
                      {!showGlobalLeaderboard && dailyScoresDateKey !== todayKey && (
                        <button
                          type="button"
                          className="hexaclear-menu-link hexaclear-scores-today-link"
                          onClick={() => {
                            playUiClick()
                            setDailyScoresDateKey(todayKey)
                          }}
                        >
                          Jump to today
                        </button>
                      )}
                    </div>
                  )}

                  {effectiveTab === 'coop' && showGlobalLeaderboard && (
                    <div className="hexaclear-scores-section">
                      <div className="hexaclear-scores-section-label">
                        Co-op · highest score (global)
                      </div>
                      {globalLoading ? (
                        <p className="hexaclear-scores-empty">
                          Loading global scores…
                        </p>
                      ) : sortedCoop.length === 0 ? (
                        <p className="hexaclear-scores-empty">
                          No co-op finishes yet. Grab a friend!
                        </p>
                      ) : (
                        <ol className="hexaclear-scores-list">
                          {sortedCoop.map((entry, idx) => {
                            const rank = idx + 1
                            return (
                              <li
                                key={entry.date + entry.name + idx}
                                className="hexaclear-scores-row"
                              >
                                <span
                                  className={`hexaclear-rank-chip ${rankClass(rank)}`}
                                  aria-hidden="true"
                                >
                                  {rank}
                                </span>
                                <span className="hexaclear-scores-name">
                                  {entry.name}
                                </span>
                                <span className="hexaclear-scores-value">
                                  {entry.score}
                                </span>
                              </li>
                            )
                          })}
                        </ol>
                      )}
                    </div>
                  )}

                  {!showResetConfirm ? (
                    <button
                      type="button"
                      className="hexaclear-menu-restart-link"
                      onClick={() => {
                        playUiClick()
                        setShowResetConfirm(true)
                      }}
                    >
                      Reset hiscores
                    </button>
                  ) : (
                    <div className="hexaclear-scores-confirm">
                      <p className="hexaclear-scores-confirm-text">
                        Reset all local hiscores? This cannot be undone.
                      </p>
                      <div className="hexaclear-scores-confirm-actions">
                        <button
                          type="button"
                          className="hexaclear-menu-restart-link"
                          onClick={() => {
                            playUiClick()
                            handleResetHighScores()
                          }}
                        >
                          Yes, reset
                        </button>
                        <span
                          className="hexaclear-menu-link-sep"
                          aria-hidden="true"
                        >
                          •
                        </span>
                        <button
                          type="button"
                          className="hexaclear-menu-link"
                          onClick={() => {
                            playUiClick()
                            setShowResetConfirm(false)
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    className="hexaclear-reset"
                    onClick={() => {
                      playUiClick()
                      setShowHighScores(false)
                      setShowMenu(true)
                    }}
                  >
                    Back
                  </button>
                </div>
              </div>
            )
          })()}
        </div>

        <section
          className={[
            'hexaclear-hand',
            gameOverWindingDown ? 'game-over-winding-down' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {mpMoveStatus && (
            <div
              className={[
                'hexaclear-hand-status',
                `hexaclear-hand-status-${mpMoveStatus.kind}`,
              ].join(' ')}
              role="status"
              aria-live="polite"
            >
              {mpMoveStatus.message}
            </div>
          )}
          {game.handSlots.map((pieceId, slotIndex) => {
            const piece = game.hand.find((p) => p.id === pieceId) ?? null
            const isHiddenByUndo =
              undoAnimation != null &&
              pendingUndoRestoreSlotIndex != null &&
              pendingUndoRestoreSlotIndex === slotIndex
            const displayPiece = isHiddenByUndo ? null : piece
            const isSelected =
              !!displayPiece && selectedPieceId === displayPiece.id
            const isDragging =
              !!displayPiece && draggingPieceId === displayPiece.id
            const isPlayable =
              !!displayPiece && playablePieceIds.has(displayPiece.id)
            const isFailedDrop =
              !!displayPiece && failedPlacementPieceId === displayPiece.id

            return (
              <button
                // Composite key: bumping handFlyInToken on a fresh hand
                // forces all three buttons to remount together so the
                // staggered fly-in animation always plays. Slot index
                // alone keeps the buttons stable across regular renders.
                key={`${handFlyInToken}-${slotIndex}`}
                ref={(el) => {
                  handButtonRefs.current[slotIndex] = el
                }}
                style={{
                  ['--hexaclear-fly-in-delay' as string]:
                    `${slotIndex * 175}ms`,
                }}
                className={[
                  'hexaclear-piece-button',
                  // Drop the deal animation class as soon as the fly-in
                  // has completed (or the player has picked the piece
                  // up). Leaving it on means a transient class change
                  // like .failed-drop's shake can later remove its own
                  // animation rule and let CSS re-trigger the deal
                  // animation, making a misplaced piece appear to be
                  // re-dealt right after shaking back into place.
                  !isFlyInDone(slotIndex) ? 'hexaclear-piece-flyin' : '',
                  isSelected ? 'selected' : '',
                  isDragging ? 'dragging' : '',
                  piece && !isPlayable ? 'unplayable' : '',
                  isFailedDrop ? 'failed-drop' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onAnimationEnd={(e) => {
                  if (e.animationName === 'hexaclear-hand-flyin') {
                    markFlyInDone(slotIndex)
                  }
                }}
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                aria-label={
                  displayPiece
                    ? `${displayPiece.shape.size}-cube piece`
                    : 'Empty hand slot'
                }
                onClick={() => {
                  if (!displayPiece) return
                  setSelectedPieceId(
                    selectedPieceId === displayPiece.id ? null : displayPiece.id,
                  )
                  setHover(null)
                }}
                onPointerDown={(e) => {
                  if (!displayPiece) return
                  e.preventDefault()
                  // Prime audio on the very first user gesture so that
                  // mobile browsers (iOS Safari especially) allow us to
                  // start the looped scrolling sound from inside later
                  // pointermove handlers.
                  unlockAudioOnGesture()
                  // Lock in the deal animation: if the player grabs a
                  // piece mid-fly-in, treat the deal as done so a later
                  // failed-drop shake can't bounce the piece back into
                  // a fresh deal animation when its class clears.
                  markFlyInDone(slotIndex)
                  dragState.current = {
                    pieceId: displayPiece.id,
                    pointerId: e.pointerId,
                    pointerType: e.pointerType || null,
                  }
                  setSelectedPieceId(displayPiece.id)
                  setDraggingPieceId(displayPiece.id)
                  const wrapper = boardWrapperRef.current
                  if (wrapper) {
                    const rect = wrapper.getBoundingClientRect()
                    setGhost({
                      piece: displayPiece,
                      x: (e.clientX - rect.left) / scale,
                      y: (e.clientY - rect.top) / scale,
                    })
                  }
                  triggerGrabHaptic()
                  playClickDown()
                }}
              >
                {displayPiece && !isDragging && (
                  <PiecePreview shape={displayPiece.shape} mode="hand" />
                )}
                {isDragging && (
                  <span
                    ref={cancelMarkRef}
                    className="hexaclear-piece-cancel-mark"
                    aria-hidden="true"
                  >
                    ×
                  </span>
                )}
              </button>
            )
          })}
        </section>
      </main>

      </div>
    </div>
  )
}

type PiecePreviewProps = {
  shape: ActivePiece['shape']
  mode?: 'hand' | 'board'
}

const PiecePreview = ({ shape, mode = 'hand' }: PiecePreviewProps) => {
  const coords = shape.cells

  if (mode === 'board') {
    let minQ = Infinity
    let maxQ = -Infinity
    let minR = Infinity
    let maxR = -Infinity
    coords.forEach((c) => {
      minQ = Math.min(minQ, c.q)
      maxQ = Math.max(maxQ, c.q)
      minR = Math.min(minR, c.r)
      maxR = Math.max(maxR, c.r)
    })

    const width = (maxQ - minQ + 2.5) * HEX_SIZE * SQRT3
    const height = (maxR - minR + 2.5) * HEX_SIZE * 1.5

    const normalized = coords.map((c) => ({
      q: c.q - minQ,
      r: c.r - minR,
    }))

    return (
      <svg
        className="hexaclear-piece-svg"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
      >
        {normalized.map((c, idx) => {
          const { x, y } = axialToPixel(c.q, c.r)
          const cx = x + HEX_SIZE * 1
          const cy = y + HEX_SIZE * 1
          const points = buildHexPoints(cx, cy)
          const bevel = buildHexBevelPaths(cx, cy)
          return (
            <g key={idx}>
              <polygon
                points={points}
                className="hexaclear-hex piece"
              />
              <g
                className="hexaclear-hex-bevels piece"
                aria-hidden="true"
                pointerEvents="none"
              >
                <polyline
                  className="hexaclear-hex-bevel hexaclear-hex-bevel-highlight"
                  points={bevel.highlight}
                />
                <polyline
                  className="hexaclear-hex-bevel hexaclear-hex-bevel-shadow"
                  points={bevel.shadow}
                />
              </g>
            </g>
          )
        })}
        {normalized.map((c, idx) => {
          const { x, y } = axialToPixel(c.q, c.r)
          return (
            <CubeLines
              key={`cube-${idx}`}
              cx={x + HEX_SIZE * 1}
              cy={y + HEX_SIZE * 1}
            />
          )
        })}
      </svg>
    )
  }

  const PREVIEW_SIZE = HEX_SIZE * 0.9
  const CARD_W = PREVIEW_SIZE * SQRT3 * 5
  const CARD_H = PREVIEW_SIZE * 1.5 * 5

  const axialToPixelPreview = (q: number, r: number) => {
    const x = PREVIEW_SIZE * (SQRT3 * q + (SQRT3 / 2) * r)
    const y = PREVIEW_SIZE * (1.5 * r)
    return { x, y }
  }

  const centers = coords.map((c) =>
    axialToPixelPreview(c.q, c.r),
  )
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  centers.forEach(({ x, y }) => {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  })
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  const buildPreviewHexPoints = (cx: number, cy: number): string => {
    const points: string[] = []
    for (let i = 0; i < 6; i++) {
      const angleRad = ((60 * i - 30) * Math.PI) / 180
      const x = cx + PREVIEW_SIZE * Math.cos(angleRad)
      const y = cy + PREVIEW_SIZE * Math.sin(angleRad)
      points.push(`${x},${y}`)
    }
    return points.join(' ')
  }

  return (
    <svg
      className="hexaclear-piece-svg"
      viewBox={`0 0 ${CARD_W} ${CARD_H}`}
      width={CARD_W}
      height={CARD_H}
    >
      {centers.map(({ x, y }, idx) => {
        const cx = CARD_W / 2 + (x - centerX)
        const cy = CARD_H / 2 + (y - centerY)
        const points = buildPreviewHexPoints(cx, cy)
        // Bevel paths use HEX_SIZE-relative geometry; the preview
        // is drawn at PREVIEW_SIZE so we scale the inset radius
        // factor identically here for visually-consistent bevels.
        const corners: Array<{ x: number; y: number }> = []
        for (let i = 0; i < 6; i++) {
          const angleRad = ((60 * i - 30) * Math.PI) / 180
          const r = PREVIEW_SIZE * HEX_BEVEL_RADIUS_FACTOR
          corners.push({
            x: cx + r * Math.cos(angleRad),
            y: cy + r * Math.sin(angleRad),
          })
        }
        const highlight = [corners[3], corners[4], corners[5], corners[0]]
          .map((p) => `${p.x},${p.y}`)
          .join(' ')
        const shadow = [corners[0], corners[1], corners[2], corners[3]]
          .map((p) => `${p.x},${p.y}`)
          .join(' ')
        return (
          <g key={idx}>
            <polygon
              points={points}
              className="hexaclear-hex piece"
            />
            <g
              className="hexaclear-hex-bevels piece"
              aria-hidden="true"
              pointerEvents="none"
            >
              <polyline
                className="hexaclear-hex-bevel hexaclear-hex-bevel-highlight"
                points={highlight}
              />
              <polyline
                className="hexaclear-hex-bevel hexaclear-hex-bevel-shadow"
                points={shadow}
              />
            </g>
          </g>
        )
      })}
      {centers.map(({ x, y }, idx) => {
        const cx = CARD_W / 2 + (x - centerX)
        const cy = CARD_H / 2 + (y - centerY)
        return (
          <CubeLines
            key={`cube-${idx}`}
            cx={cx}
            cy={cy}
          />
        )
      })}
    </svg>
  )
}

export default App
