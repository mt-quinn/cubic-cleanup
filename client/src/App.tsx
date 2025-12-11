import { useEffect, useMemo, useRef, useState } from 'react'
import { BOARD_DEFINITION } from './game/boardDefinition'
import {
  applyPlacement,
  canPlacePiece,
  createInitialGameState,
  createDailyGameState,
  dealPlayableHand,
  hasAnyValidMove,
} from './game/gameLogic'
import type { ActivePiece, GameMode, GameState } from './game/gameLogic'
import { axialToId, addAxial, directions } from './game/hexTypes'
import type { Axial } from './game/hexTypes'
import './index.css'

type HoverInfo = {
  cellId: string
} | null

const HEX_SIZE = 32
const SQRT3 = Math.sqrt(3)
const DEBUG_SHOW_COORDS = false

// Mapping from polygon edge index (0..5) to axial neighbor direction index.
// With our pointy-top axial coordinates and hex vertex angles at
// -30, 30, 90, 150, 210, 270 degrees, the edge mid-angles are:
// 0, 60, 120, 180, 240, 300 degrees. These correspond to axial
// directions (1,0), (0,1), (-1,1), (-1,0), (0,-1), (1,-1) respectively.
const EDGE_DIRECTION_INDEX = [0, 5, 4, 3, 2, 1] as const

const FLOWER_CENTERS: Axial[] = [
  { q: 0, r: 0 },
  { q: 1, r: 2 },
  { q: -2, r: 3 },
  { q: -3, r: 1 },
  { q: -1, r: -2 },
  { q: 2, r: -3 },
  { q: 3, r: -1 },
]

const axialToPixel = (q: number, r: number) => {
  const x = HEX_SIZE * (SQRT3 * q + (SQRT3 / 2) * r)
  const y = HEX_SIZE * (1.5 * r)
  return { x, y }
}

const buildLayout = () => {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  const positions: Record<string, { x: number; y: number }> = {}

  for (const cell of BOARD_DEFINITION.cells) {
    const { x, y } = axialToPixel(cell.coord.q, cell.coord.r)
    positions[cell.id] = { x, y }
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }

  const width = maxX - minX + HEX_SIZE * 2.5
  const height = maxY - minY + HEX_SIZE * 2.5

  return { positions, width, height, offsetX: -minX + HEX_SIZE * 1.25, offsetY: -minY + HEX_SIZE * 1.25 }
}

const BOARD_LAYOUT = buildLayout()
const BOARD_RIPPLE_RADIUS =
  Math.max(BOARD_LAYOUT.width, BOARD_LAYOUT.height) * 0.7

type Segment = { x1: number; y1: number; x2: number; y2: number }

const FLOWER_BOUNDARY_SEGMENTS: Segment[] = (() => {
  const segments: Segment[] = []
  const idToCell = new Map(
    BOARD_DEFINITION.cells.map((c) => [c.id, c] as const),
  )

  for (const center of FLOWER_CENTERS) {
    const centerId = axialToId(center)
    const neighborIds = directions.map((d) =>
      axialToId(addAxial(center, d)),
    )
    const cellIds = [centerId, ...neighborIds]
    const cellSet = new Set(cellIds)

    for (const cellId of cellIds) {
      const cell = idToCell.get(cellId)
      if (!cell) continue
      const pos = BOARD_LAYOUT.positions[cellId]
      const cx = pos.x + BOARD_LAYOUT.offsetX
      const cy = pos.y + BOARD_LAYOUT.offsetY

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
})()

// Exterior outline of the whole board: all hex edges whose neighbor is not
// another board cell, de-duped so we get a single continuous hex-shaped hull.
const BOARD_OUTLINE_SEGMENTS: Segment[] = (() => {
  const segments: Segment[] = []
  const cellSet = new Set(BOARD_DEFINITION.cells.map((c) => c.id))
  const seen = new Set<string>()

  for (const cell of BOARD_DEFINITION.cells) {
    const pos = BOARD_LAYOUT.positions[cell.id]
    const cx = pos.x + BOARD_LAYOUT.offsetX
    const cy = pos.y + BOARD_LAYOUT.offsetY

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
})()

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

const CubeLines = ({
  cx,
  cy,
  variant = 'normal',
  dailyHits,
  extraClasses = [],
}: {
  cx: number
  cy: number
  variant?: 'normal' | 'dailyTarget' | 'golden'
  dailyHits?: number
  extraClasses?: string[]
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

  // Face centers for placing embossed numbers on each visible face.
  const rightCenter = {
    x: (cx + v1.x + v2.x + v3.x) / 4,
    y: (cy + v1.y + v2.y + v3.y) / 4,
  }
  const leftCenter = {
    x: (cx + v3.x + v4.x + v5.x) / 4,
    y: (cy + v3.y + v4.y + v5.y) / 4,
  }
  const topCenter = {
    x: (cx + v5.x + v0.x + v1.x) / 4,
    y: (cy + v5.y + v0.y + v1.y) / 4,
  }

  // Angles of the shared "spine" edges between the top face and each
  // side face (center → vertex), so we can orient baselines relative to
  // those like a real d6. With our pointy-top hex layout:
  // - v1 is the shared edge direction to the darker right face
  // - v5 is the shared edge direction to the mid-tone left face
  const rightSharedAngle =
    (Math.atan2(v1.y - cy, v1.x - cx) * 180) / Math.PI
  const leftSharedAngle =
    (Math.atan2(v5.y - cy, v5.x - cx) * 180) / Math.PI

  // Final, hand-tuned offsets for daily-mode digits, derived from the
  // in-game debug sliders.
  const TOP_DX = 0.2
  const TOP_DY = 1.8
  const TOP_ANGLE = 13

  const RIGHT_DX = 0.4
  const RIGHT_DY = -0.4
  const RIGHT_ANGLE_OFFSET = 93

  const LEFT_DX = 0.6
  const LEFT_DY = -0.2
  const LEFT_ANGLE_OFFSET = -105

  const cubeClassName = [variantClass, ...extraClasses].join(' ')

  return (
    <g className={cubeClassName}>
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
        <>
          {/* Top face number */}
          <text
            x={topCenter.x + TOP_DX}
            y={topCenter.y + TOP_DY}
            className="hexaclear-daily-number daily-number-top"
            transform={`rotate(${TOP_ANGLE} ${topCenter.x + TOP_DX} ${
              topCenter.y + TOP_DY
            })`}
          >
            {dailyHits}
          </text>
          {/* Right (darkest) face: baseline follows the shared edge with
              the top/lightest face. */}
          <text
            x={rightCenter.x + RIGHT_DX}
            y={rightCenter.y + RIGHT_DY}
            className="hexaclear-daily-number daily-number-right"
            transform={`rotate(${
              rightSharedAngle + RIGHT_ANGLE_OFFSET
            } ${rightCenter.x + RIGHT_DX} ${rightCenter.y + RIGHT_DY})`}
          >
            {dailyHits}
          </text>
          {/* Left (second-lightest) face: baseline is opposite (rotated
              90° from) its shared edge with the top face. */}
          <text
            x={leftCenter.x + LEFT_DX}
            y={leftCenter.y + LEFT_DY}
            className="hexaclear-daily-number daily-number-left"
            transform={`rotate(${
              leftSharedAngle + 90 + LEFT_ANGLE_OFFSET
            } ${leftCenter.x + LEFT_DX} ${leftCenter.y + LEFT_DY})`}
          >
            {dailyHits}
          </text>
        </>
      )}
    </g>
  )
}

const SlotGeometry = ({ cx, cy }: { cx: number; cy: number }) => {
  const vertices: { x: number; y: number }[] = []
  const radius = HEX_SIZE * 0.9

  for (let i = 0; i < 6; i++) {
    const angleRad = ((60 * i - 30) * Math.PI) / 180
    vertices.push({
      x: cx + radius * Math.cos(angleRad),
      y: cy + radius * Math.sin(angleRad),
    })
  }

  const v0 = vertices[0]
  const v1 = vertices[1]
  const v2 = vertices[2]
  const v3 = vertices[3]
  const v4 = vertices[4]
  const v5 = vertices[5]

  // Use same three-face layout as cubes, but darker palette to read as a slot.
  const rightFace = `${cx},${cy} ${v1.x},${v1.y} ${v2.x},${v2.y} ${v3.x},${v3.y}`
  const leftFace = `${cx},${cy} ${v3.x},${v3.y} ${v4.x},${v4.y} ${v5.x},${v5.y}`
  const topFace = `${cx},${cy} ${v5.x},${v5.y} ${v0.x},${v0.y} ${v1.x},${v1.y}`

  return (
    <g className="hexaclear-slot">
      <polygon className="hexaclear-slot-right" points={rightFace} />
      <polygon className="hexaclear-slot-left" points={leftFace} />
      <polygon className="hexaclear-slot-top" points={topFace} />
    </g>
  )
}

const PlacementGhost = ({
  originCellId,
  piece,
  valid,
}: {
  originCellId: string
  piece: ActivePiece
  valid: boolean
}) => {
  const originCell = BOARD_DEFINITION.cells.find((c) => c.id === originCellId)
  if (!originCell) return null

  return (
    <g className="hexaclear-placement-ghost">
      {piece.shape.cells.map((rel, idx) => {
        const targetQ = originCell.coord.q + rel.q
        const targetR = originCell.coord.r + rel.r
        const { x, y } = axialToPixel(targetQ, targetR)
        const cx = x + BOARD_LAYOUT.offsetX
        const cy = y + BOARD_LAYOUT.offsetY
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

  const originCell = BOARD_DEFINITION.cells.find((c) => c.id === hoveredCellId)
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

const qualifiesForDailyHighScore = (
  moves: number,
  entries: DailyHighScoreEntry[],
): boolean => {
  if (moves <= 0) return false
  if (entries.length < 5) return true
  const sorted = [...entries].sort(
    (a, b) => a.moves - b.moves || a.date - b.date,
  )
  const last = sorted[sorted.length - 1]
  return moves < last.moves
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

const loadInitialGameFromStorage = (): GameState => {
  if (typeof window === 'undefined') {
    return createInitialGameState()
  }
  try {
    const raw = window.localStorage.getItem('cubic-current-game')
    if (!raw) return createInitialGameState()
    const parsed = JSON.parse(raw) as PersistedGameEnvelope
    if (!parsed || parsed.version !== 1 || !parsed.game) {
      return createInitialGameState()
    }

    // For daily games, only restore if the stored date matches today.
    if (parsed.mode === 'daily') {
      const todayKey = getTodayKey()
      if (parsed.dateKey && parsed.dateKey !== todayKey) {
        return createDailyGameState()
      }
    }

    return parsed.game
  } catch {
    return createInitialGameState()
  }
}

const triggerHaptics = (didClear: boolean) => {
  if (typeof window === 'undefined') return
  const nav: any = navigator
  if (!nav || typeof nav.vibrate !== 'function') return
  if (didClear) {
    nav.vibrate([15, 40, 25])
  } else {
    nav.vibrate(10)
  }
}

const triggerGrabHaptic = () => {
  if (typeof window === 'undefined') return
  const nav: any = navigator
  if (!nav || typeof nav.vibrate !== 'function') return
  nav.vibrate(5)
}

function App() {
  const [game, setGame] = useState<GameState>(() => loadInitialGameFromStorage())
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null)
  const [hover, setHover] = useState<HoverInfo>(null)
  const [clearingCells, setClearingCells] = useState<string[]>([])
  const [clearingClassesByCell, setClearingClassesByCell] = useState<
    Record<string, string[]>
  >({})
  const [clearingGoldenCellId, setClearingGoldenCellId] = useState<string | null>(null)
  const [recentlyPlacedCells, setRecentlyPlacedCells] = useState<string[]>([])
  const [failedPlacementPieceId, setFailedPlacementPieceId] = useState<string | null>(
    null,
  )
  const [invalidDropCellIds, setInvalidDropCellIds] = useState<string[]>([])
  const [scorePopup, setScorePopup] = useState<string | null>(null)
  const [scorePopupId, setScorePopupId] = useState(0)
  const [showScoring, setShowScoring] = useState(false)
  const [showHighScores, setShowHighScores] = useState(false)
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
  const [dailyHighScores, setDailyHighScores] = useState<DailyHighScoreEntry[]>(
    () => (typeof window === 'undefined' ? [] : loadDailyHighScores()),
  )
  const [pendingDailyHighScore, setPendingDailyHighScore] = useState(false)
  const [pendingDailyMoves, setPendingDailyMoves] = useState<number | null>(
    null,
  )
  const [dailyHighScoreSaved, setDailyHighScoreSaved] = useState(false)
  const [lastSavedDailyHighScoreDate, setLastSavedDailyHighScoreDate] =
    useState<number | null>(null)
  const [playerName, setPlayerName] = useState(() => {
    if (typeof window === 'undefined') return ''
    return window.localStorage.getItem('cubic-player-name') ?? ''
  })
  const [bestScore, setBestScore] = useState<number | null>(() => {
    const stored = window.localStorage.getItem('hexaclear-best-score')
    return stored ? Number(stored) : null
  })
  const [savedEndlessGame, setSavedEndlessGame] = useState<GameState | null>(
    null,
  )
  const [savedDailyGame, setSavedDailyGame] = useState<GameState | null>(null)
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
  const [goldenPopupCellId, setGoldenPopupCellId] = useState<string | null>(null)
  const [goldenPopupToken, setGoldenPopupToken] = useState(0)
  const [dailyHitPulseCells, setDailyHitPulseCells] = useState<string[]>([])
  const [rippleCells, setRippleCells] = useState<string[]>([])
  const [rippleIsClear, setRippleIsClear] = useState(false)
  const [rippleCenter, setRippleCenter] = useState<{ x: number; y: number } | null>(null)
  const [rippleToken, setRippleToken] = useState(0)
  const rippleRadiusRef = useRef(0)
  const rippleMaxRadiusRef = useRef(BOARD_RIPPLE_RADIUS * 2)
  const CLEAR_RIPPLE_DURATION_MS = 1350
  const dailyCubesRemaining = useMemo(() => {
    if (game.mode !== 'daily') return 0
    let count = 0
    for (const hits of Object.values(game.dailyHits)) {
      if (hits > 0) count++
    }
    return count
  }, [game.mode, game.dailyHits])
  const [undoStack, setUndoStack] = useState<GameState[]>([])
  const selectedPiece = useMemo<ActivePiece | null>(() => {
    if (!selectedPieceId) return null
    return game.hand.find((p) => p.id === selectedPieceId) ?? null
  }, [game.hand, selectedPieceId])

  const rootRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const boardWrapperRef = useRef<HTMLDivElement | null>(null)
  const dragState = useRef<{
    pieceId: string | null
    pointerId: number | null
    pointerType: string | null
  }>({ pieceId: null, pointerId: null, pointerType: null })
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
      for (const cell of BOARD_DEFINITION.cells) {
        if (canPlacePiece(game.board, piece.shape, cell.id)) {
          playable.add(piece.id)
          break
        }
      }
    }
    return playable
  }, [game.board, game.hand])

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
    for (const cell of BOARD_DEFINITION.cells) {
      const pos = BOARD_LAYOUT.positions[cell.id]
      const cx = pos.x + BOARD_LAYOUT.offsetX
      const cy = pos.y + BOARD_LAYOUT.offsetY
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

  const placePieceAtCell = (
    pieceId: string,
    cellId: string,
    attemptedCellIds?: string[],
  ) => {
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
        return current
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
          const pos = BOARD_LAYOUT.positions[id]
          sumX += pos.x + BOARD_LAYOUT.offsetX
          sumY += pos.y + BOARD_LAYOUT.offsetY
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
        for (const cell of BOARD_DEFINITION.cells) {
          const pos = BOARD_LAYOUT.positions[cell.id]
          const x = pos.x + BOARD_LAYOUT.offsetX
          const y = pos.y + BOARD_LAYOUT.offsetY
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

      if (isThirdPieceThisHand) {
        newHand = dealPlayableHand(result.board)
        for (let i = 0; i < 3; i++) {
          updatedSlots[i] = newHand[i]?.id ?? null
        }
      }

      const noMovesLeft = !hasAnyValidMove(result.board, newHand)

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
      if (current.mode === 'endless') {
        const newScore = current.score + result.pointsGained
        const flatPoints = piece.shape.cells.length
        finalScore = newScore + flatPoints

        if (result.clearedPatterns.length > 0) {
          setClearingCells(result.clearedCellIds)
          setClearingGoldenCellId(current.goldenCellId)
          const totalClears = result.clearedPatterns.length
          const popupText =
            totalClears === 1
              ? `Clear · +${result.pointsGained}`
              : `${totalClears} clears · +${result.pointsGained}`
          setScorePopup(popupText)
          setScorePopupId((id) => id + 1)
        }

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

        // Golden cube bonus popup: when the golden cube is cleared in
        // endless mode, show a local "+10" popup over that cell.
        if (result.goldenCleared && current.goldenCellId) {
          setGoldenPopupCellId(current.goldenCellId)
          setGoldenPopupToken((t) => t + 1)
        }
      } else {
        // Still show the clearing animation in daily mode.
        if (result.clearedPatterns.length > 0) {
          setClearingCells(result.clearedCellIds)
          setClearingGoldenCellId(current.goldenCellId)
        }
      }

      triggerHaptics(result.clearedPatterns.length > 0)

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

      return {
        ...current,
        board: result.board,
        score: finalScore,
        streak: result.clearedPatterns.length > 0 ? newStreak : 0,
        hand: newHand,
        handSlots: updatedSlots,
        gameOver,
        moves: newMoves,
        dailyHits: result.dailyHits,
        dailyTotalHits: result.dailyTotalHits,
        dailyRemainingHits: result.dailyRemainingHits,
        dailyCompleted: result.dailyCompleted,
        goldenCellId: result.goldenCellId,
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
    if (game.mode === 'daily') {
      const next = createDailyGameState()
      setGame(next)
      setSavedDailyGame(next)
      setDailyHighScoreSaved(false)
    } else {
      const next = createInitialGameState()
      setGame(next)
      setSavedEndlessGame(next)
      setHighScoreSaved(false)
    }
    setSelectedPieceId(null)
    setHover(null)
    setUndoStack([])
    setGoldenPopupCellId(null)
    setClearingCells([])
    setClearingGoldenCellId(null)
    setScorePopup(null)
  }

  const handleUndo = () => {
    if (undoStack.length === 0) return
    const previous = undoStack[undoStack.length - 1]
    const remaining = undoStack.slice(0, -1)
    setUndoStack(remaining)
    setGoldenPopupCellId(null)
    setClearingCells([])
    setClearingGoldenCellId(null)
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

  const toggleDailyMode = () => {
    setGame((current) => {
      if (current.mode === 'daily') {
        // Leaving daily → restore endless run (or start fresh).
        setSavedDailyGame(current)
        if (savedEndlessGame) {
          return savedEndlessGame
        }
        const endless = createInitialGameState()
        setSavedEndlessGame(endless)
        return endless
      } else {
        // Entering daily → restore today's run if we have one,
        // otherwise create a fresh daily puzzle.
        setSavedEndlessGame(current)
        if (savedDailyGame) {
          return savedDailyGame
        }
        const daily = createDailyGameState()
        setSavedDailyGame(daily)
        return daily
      }
    })
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
    if (clearingCells.length === 0) return
    const timeout = window.setTimeout(() => {
      setClearingCells([])
      setClearingClassesByCell({})
      setClearingGoldenCellId(null)
    }, 600)
    return () => window.clearTimeout(timeout)
  }, [clearingCells])

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

    const durationMs = rippleIsClear ? CLEAR_RIPPLE_DURATION_MS : 900
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
    if (!goldenPopupCellId) return
    const tokenAtStart = goldenPopupToken
    const timeout = window.setTimeout(() => {
      setGoldenPopupCellId((prev) =>
        tokenAtStart === goldenPopupToken ? null : prev,
      )
    }, 900)
    return () => window.clearTimeout(timeout)
  }, [goldenPopupCellId, goldenPopupToken])

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
      setPendingDailyHighScore(
        !dailyHighScoreSaved &&
          qualifiesForDailyHighScore(moves, dailyHighScores),
      )

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
  // resumes exactly where the player left off.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const envelope: PersistedGameEnvelope = {
        version: 1,
        mode: game.mode,
        game,
        dateKey: game.mode === 'daily' ? getTodayKey() : undefined,
      }
      window.localStorage.setItem(
        'cubic-current-game',
        JSON.stringify(envelope),
      )
    } catch {
      // Best-effort persistence; ignore quota/serialization errors.
    }
  }, [game])

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
      window.localStorage.setItem('cubic-player-name', name)
    }
    setPendingDailyHighScore(false)
    setDailyHighScoreSaved(true)
  }

  const handleResetHighScores = () => {
    setHighScores([])
    setPendingHighScore(false)
    setPendingScore(null)
    setHighScoreSaved(false)
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('cubic-highscores')
      window.localStorage.removeItem('cubic-daily-highscores')
    }
    setDailyHighScores([])
    setPendingDailyHighScore(false)
    setPendingDailyMoves(null)
    setDailyHighScoreSaved(false)
    setShowResetConfirm(false)
  }

  useEffect(() => {
    const updateFromClientPoint = (clientX: number, clientY: number) => {
      if (!dragState.current.pieceId) return
      const wrapper = boardWrapperRef.current
      if (!wrapper) return
      const rect = wrapper.getBoundingClientRect()
      const x = (clientX - rect.left) / scale
      const y = (clientY - rect.top) / scale
      setGhost((prev) => (prev ? { ...prev, x, y } : prev))
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
      let cellId = hover?.cellId ?? null
      if (!cellId && clientX !== null && clientY !== null) {
        cellId = findClosestCellIdFromClientPoint(
          clientX,
          clientY - previewOffsetY,
        )
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
      if (cellId && pieceId) {
        placePieceAtCell(pieceId, cellId, attemptedCellIds)
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
      className="cubic-viewport"
      onDragStart={(e) => {
        e.preventDefault()
      }}
    >
      <div className="hexaclear-root" ref={rootRef}>
      <header className="hexaclear-header">
        <div className="hexaclear-header-main">
          <div className="hexaclear-title">Cubic Cleanup</div>
          <div className="hexaclear-best-banner">
            <span className="label">
              {game.mode === 'daily' ? 'Best (today)' : 'Best'}
            </span>
            <span className="value">
              {game.mode === 'daily'
                ? todayDailyBestMoves !== null
                  ? todayDailyBestMoves
                  : '—'
                : bestScore ?? '—'}
            </span>
          </div>
        </div>
        <div className="hexaclear-header-controls">
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
                  toggleDailyMode()
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
                  toggleDailyMode()
                }
              }}
            >
              Daily
            </button>
          </div>
          <div className="hexaclear-header-buttons">
            <button
              className="hexaclear-reset"
              type="button"
              onClick={resetGame}
            >
              Restart
            </button>
            <button
              className="hexaclear-reset"
              type="button"
              onClick={() => setShowScoring(true)}
            >
              Scoring
            </button>
            <button
              className="hexaclear-reset"
              type="button"
              onClick={() => setShowHighScores(true)}
            >
              Scores
            </button>
          </div>
        </div>
      </header>

      <main className="hexaclear-main">
        <div className="hexaclear-board-wrapper" ref={boardWrapperRef}>
          <svg
            className="hexaclear-board"
            ref={svgRef}
            viewBox={`0 0 ${BOARD_LAYOUT.width} ${BOARD_LAYOUT.height}`}
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
                    width={BOARD_LAYOUT.width}
                    height={BOARD_LAYOUT.height}
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
            {BOARD_OUTLINE_SEGMENTS.map((seg, idx) => (
              <line
                key={`outline-back-${idx}`}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                className="hexaclear-board-outline-back"
              />
            ))}
            {BOARD_OUTLINE_SEGMENTS.map((seg, idx) => (
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
              return BOARD_DEFINITION.cells.map((cell) => {
                const pos = BOARD_LAYOUT.positions[cell.id]
                const cx = pos.x + BOARD_LAYOUT.offsetX
                const cy = pos.y + BOARD_LAYOUT.offsetY
                const points = buildHexPoints(cx, cy)

                const isFilledLogical = game.board[cell.id] === 'filled'
                const isClearing = clearingCells.includes(cell.id)
                const isFilled = isFilledLogical || isClearing
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
                  game.mode === 'endless' &&
                  (clearingCells.length > 0
                    ? clearingGoldenCellId != null &&
                      clearingGoldenCellId === cell.id
                    : game.goldenCellId != null &&
                      game.goldenCellId === cell.id)

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
                        isClearing ? 'clearing' : '',
                        isInvalidDrop ? 'invalid-drop' : '',
                        willClearInPreview ? 'preview-clear' : '',
                        ...clearingClasses,
                        inPreview
                          ? previewValid
                            ? 'preview-valid'
                            : 'preview-invalid'
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
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
                    {!isFilledLogical && !inPreview && !willClearInPreview && (
                      <SlotGeometry cx={cx} cy={cy} />
                    )}
                    {isFilled && !isRecentlyPlaced && (
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
                          ...clearingClasses,
                          isInvalidDrop ? 'invalid-drop' : '',
                          isDailyTarget && isDailyHitPulsing
                            ? 'daily-hit-pulse'
                            : '',
                        ].filter(Boolean)}
                      />
                    )}
                    {game.mode === 'endless' &&
                      goldenPopupCellId === cell.id && (
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
                {BOARD_DEFINITION.cells.map((cell) => {
                  const pos = BOARD_LAYOUT.positions[cell.id]
                  const cx = pos.x + BOARD_LAYOUT.offsetX
                  const cy = pos.y + BOARD_LAYOUT.offsetY
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
            {FLOWER_BOUNDARY_SEGMENTS.map((seg, idx) => (
              <line
                key={`flower-back-${idx}`}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                className="hexaclear-flower-boundary-back"
              />
            ))}
            {FLOWER_BOUNDARY_SEGMENTS.map((seg, idx) => (
              <line
                key={`flower-front-${idx}`}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                className="hexaclear-flower-boundary"
              />
            ))}

            {preview && selectedPiece && hover?.cellId && !preview.valid && (
              <PlacementGhost
                originCellId={hover.cellId}
                piece={selectedPiece}
                valid={false}
              />
            )}
            {/* Final overlay: animate the whole placed shape as a unit while it
                "locks in" to the board. */}
            {recentlyPlacedCells.length > 0 && (
              <g className="hexaclear-placed-overlay placed-impact">
                {(() => {
                  return recentlyPlacedCells.map((id) => {
                    const cell = BOARD_DEFINITION.cells.find((c) => c.id === id)
                    if (!cell) return null
                    const pos = BOARD_LAYOUT.positions[cell.id]
                    const cx = pos.x + BOARD_LAYOUT.offsetX
                    const cy = pos.y + BOARD_LAYOUT.offsetY
                    const dailyHitsForCell = game.dailyHits[cell.id] ?? 0
                    const isDailyTarget =
                      game.mode === 'daily' && dailyHitsForCell > 0
                    const isGolden =
                      game.mode === 'endless' &&
                      ((clearingCells.length > 0 &&
                        clearingGoldenCellId != null &&
                        clearingGoldenCellId === cell.id) ||
                        (clearingCells.length === 0 &&
                          game.goldenCellId != null &&
                          game.goldenCellId === cell.id))
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
          </svg>
          <div className="hexaclear-board-hud">
            {game.mode === 'daily' ? (
              <>
                <div className="board-hud-block left">
                  {game.moves === 0 ? (
                    <span className="value small">
                      Clear all numbered cubes to win!
                    </span>
                  ) : (
                    <span className="value">
                       {dailyCubesRemaining} Cubes Remain
                    </span>
                  )}
      </div>
                {game.moves > 0 && (
                  <div className="board-hud-block right">
                    <span className="label">Moves</span>
                    <span className="value">{game.moves}</span>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="board-hud-block left">
                  {game.streak > 0 && (
                    <span className="value">Streak {game.streak}</span>
                  )}
                </div>
                <div className="board-hud-block right">
                  <span className="label">Score</span>
                  <span className="value">{game.score}</span>
                </div>
              </>
            )}
          </div>
          {undoStack.length > 0 && !game.gameOver && (
            <button
              type="button"
              className="hexaclear-undo-button"
              onClick={handleUndo}
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
          {scorePopup && game.mode === 'endless' && (
            <div className="hexaclear-score-popup">{scorePopup}</div>
          )}
          {game.gameOver && game.mode === 'endless' && (
            <div className="hexaclear-overlay">
              <div className="hexaclear-overlay-card">
                <div className="title">No more moves</div>
                <div className="score">Final score: {game.score}</div>
                {pendingHighScore && (
                  <div className="score">
                    <p>New high score! Enter your name:</p>
                    <input
                      className="hexaclear-input"
                      value={playerName}
                      onChange={(e) => setPlayerName(e.target.value)}
                      placeholder="Your name"
                    />
                    <button
                      type="button"
                      onClick={handleSaveHighScore}
                      style={{ marginTop: '0.5rem' }}
                    >
                      Save score
        </button>
                  </div>
                )}
                {highScores.length > 0 && (
                  <div className="score">
                    <p>Top scores:</p>
                    <ol className="hexaclear-highscores">
                      {highScores
                        .slice()
                        .sort(
                          (a, b) =>
                            b.score - a.score || a.date - b.date,
                        )
                        .map((entry, idx) => {
                          const isRecent =
                            highScoreSaved &&
                            lastSavedHighScoreDate !== null &&
                            entry.date === lastSavedHighScoreDate
                          return (
                            <li
                              key={entry.date + entry.name + idx}
                              className={isRecent ? 'recent' : undefined}
                            >
                              <span className="name">{entry.name}</span>
                              <span className="value">{entry.score}</span>
                            </li>
                          )
                        })}
                    </ol>
                  </div>
                )}
                {undoStack.length > 0 && !highScoreSaved && (
                  <button
                    type="button"
                    onClick={handleUndo}
                    style={{ marginBottom: '0.5rem' }}
                  >
                    Undo last move
                  </button>
                )}
                <button onClick={resetGame}>Play again</button>
              </div>
            </div>
          )}
          {game.gameOver && game.mode === 'daily' && (
            <div className="hexaclear-overlay">
              <div className="hexaclear-overlay-card">
                <div className="title">
                  {game.dailyCompleted ? 'Daily cleared!' : 'Daily over'}
                </div>
                <div className="score">
                  <p>Moves: {game.moves}</p>
                  <p>Goal: clear all numbered cubes.</p>
                </div>
                {pendingDailyHighScore && (
                  <div className="score">
                    <p>New daily best! Enter your name:</p>
                    <input
                      className="hexaclear-input"
                      value={playerName}
                      onChange={(e) => setPlayerName(e.target.value)}
                      placeholder="Your name"
                    />
                    <button
                      type="button"
                      onClick={handleSaveDailyHighScore}
                      style={{ marginTop: '0.5rem' }}
                    >
                      Save daily result
                    </button>
                  </div>
                )}
                {dailyHighScores.length > 0 && (
                  <div className="score">
                    <p>Best daily runs (fewest moves):</p>
                    <ol className="hexaclear-highscores">
                      {dailyHighScores
                        .slice()
                        .sort(
                          (a, b) => a.moves - b.moves || a.date - b.date,
                        )
                        .map((entry, idx) => {
                          const isRecent =
                            dailyHighScoreSaved &&
                            lastSavedDailyHighScoreDate !== null &&
                            entry.date === lastSavedDailyHighScoreDate
                          return (
                            <li
                              key={entry.date + entry.name + idx}
                              className={isRecent ? 'recent' : undefined}
                            >
                              <span className="name">{entry.name}</span>
                              <span className="value">
                                {entry.moves} moves
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
                    onClick={handleUndo}
                    style={{ marginBottom: '0.5rem' }}
                  >
                    Undo last move
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
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
          {showScoring && (
            <div className="hexaclear-overlay">
              <div className="hexaclear-overlay-card">
                {game.mode === 'daily' ? (
                  <>
                    <div className="title">Daily puzzles</div>
                    <div className="score">
                      <p>Clear all numbered cubes to finish the puzzle.</p>
                      <p>Every placement is one move.</p>
                      <p>Your best daily runs are the ones with the fewest moves.</p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="title">Endless scoring</div>
                    <div className="score">
                      <p>Clearing a full line or rosette is worth 10 base points.</p>
                      <p>Clearing several lines or rosettes at once creates a combo that boosts those points.</p>
                      <p>Clearing on back‑to‑back moves builds a streak that boosts them further.</p>
                      <p>Clearing a Ruby gives a +10 bonus.</p>
                      <p>Clearing the entire board in one move gives a +25 bonus.</p>
                      <p>You also gain a flat +1 point for every cube you place.</p>
                    </div>
                  </>
                )}
                <button type="button" onClick={() => setShowScoring(false)}>
                  Got it
                </button>
              </div>
            </div>
          )}
          {showHighScores && (
            <div className="hexaclear-overlay">
              <div className="hexaclear-overlay-card">
                <div className="title">High Scores</div>
                <div className="score">
                  <p>Endless (score):</p>
                  {highScores.length === 0 ? (
                    <p>No endless scores yet. Play a game!</p>
                  ) : (
                    <ol className="hexaclear-highscores">
                      {highScores
                        .slice()
                        .sort(
                          (a, b) =>
                            b.score - a.score || a.date - b.date,
                        )
                        .map((entry, idx) => {
                          const isRecent =
                            highScoreSaved &&
                            lastSavedHighScoreDate !== null &&
                            entry.date === lastSavedHighScoreDate
                          return (
                            <li
                              key={entry.date + entry.name + idx}
                              className={isRecent ? 'recent' : undefined}
                            >
                              <span className="name">{entry.name}</span>
                              <span className="value">{entry.score}</span>
                            </li>
                          )
                        })}
                    </ol>
                  )}
                </div>
                <div className="score" style={{ marginTop: '0.75rem' }}>
                  <p style={{ marginTop: 0, marginBottom: '0.25rem' }}>
                    Daily (fewest moves)
                  </p>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.5rem',
                      marginBottom: '0.35rem',
                    }}
                  >
                    <button
                      type="button"
                      style={{ minWidth: '1.8rem' }}
                      onClick={() => {
                        setDailyScoresDateKey((prev) =>
                          shiftDateKey(prev || getTodayKey(), -1),
                        )
                      }}
                    >
                      ◀
                    </button>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {dailyScoresDateKey}
                    </span>
                    <button
                      type="button"
                      style={{ minWidth: '1.8rem' }}
                      onClick={() => {
                        const today = getTodayKey()
                        setDailyScoresDateKey((prev) => {
                          const next = shiftDateKey(prev || today, 1)
                          // Don&apos;t advance past today.
                          return next > today ? today : next
                        })
                      }}
                      disabled={dailyScoresDateKey >= getTodayKey()}
                    >
                      ▶
                    </button>
      </div>
                  {dailyScoresDateKey !== getTodayKey() && (
                    <div style={{ marginBottom: '0.4rem' }}>
                      <button
                        type="button"
                        onClick={() => setDailyScoresDateKey(getTodayKey())}
                      >
                        Today&apos;s scores
                      </button>
                    </div>
                  )}
                  {(() => {
                    const todayKey = getTodayKey()
                    const entriesForDay = dailyHighScores.filter(
                      (entry) =>
                        getDateKeyFromTimestamp(entry.date) ===
                        dailyScoresDateKey,
                    )
                    if (entriesForDay.length === 0) {
                      return (
                        <p>
                          No scores stored for this date
                          {dailyScoresDateKey === todayKey
                            ? ". Play today's puzzle!"
                            : '.'}
                        </p>
                      )
                    }
                    return (
                      <ol className="hexaclear-highscores">
                        {entriesForDay
                          .slice()
                          .sort(
                            (a, b) => a.moves - b.moves || a.date - b.date,
                          )
                          .map((entry, idx) => {
                            const isRecent =
                              dailyHighScoreSaved &&
                              lastSavedDailyHighScoreDate !== null &&
                              entry.date === lastSavedDailyHighScoreDate
                            return (
                              <li
                                key={entry.date + entry.name + idx}
                                className={isRecent ? 'recent' : undefined}
                              >
                                <span className="name">{entry.name}</span>
                                <span className="value">
                                  {entry.moves} moves
                                </span>
                              </li>
                            )
                          })}
                      </ol>
                    )
                  })()}
                </div>
                {!showResetConfirm ? (
                  <button
                    type="button"
                    onClick={() => setShowResetConfirm(true)}
                    style={{ marginTop: '0.75rem' }}
                  >
                    Reset Hiscores
                  </button>
                ) : (
                  <div className="score" style={{ marginTop: '0.75rem' }}>
                    <p>Reset all local hiscores? This cannot be undone.</p>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'center',
                        gap: '0.5rem',
                        marginTop: '0.25rem',
                      }}
                    >
                      <button
                        type="button"
                        onClick={handleResetHighScores}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowResetConfirm(false)}
                      >
                        No
                      </button>
                    </div>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setShowHighScores(false)}
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>

        <section className="hexaclear-hand">
          {game.handSlots.map((pieceId, slotIndex) => {
            const piece = game.hand.find((p) => p.id === pieceId) ?? null
            const isSelected =
              !!piece && selectedPieceId === piece.id
            const isDragging = !!piece && draggingPieceId === piece.id
            const isPlayable = !!piece && playablePieceIds.has(piece.id)
            const isFailedDrop =
              !!piece && failedPlacementPieceId === piece.id

            return (
              <button
                key={slotIndex}
                className={[
                  'hexaclear-piece-button',
                  isSelected ? 'selected' : '',
                  isDragging ? 'dragging' : '',
                  piece && !isPlayable ? 'unplayable' : '',
                  isFailedDrop ? 'failed-drop' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                aria-label={
                  piece
                    ? `${piece.shape.size}-cube piece`
                    : 'Empty hand slot'
                }
                onClick={() => {
                  if (!piece) return
                  setSelectedPieceId(
                    selectedPieceId === piece.id ? null : piece.id,
                  )
                  setHover(null)
                }}
                onPointerDown={(e) => {
                  if (!piece) return
                  e.preventDefault()
                  dragState.current = {
                    pieceId: piece.id,
                    pointerId: e.pointerId,
                    pointerType: e.pointerType || null,
                  }
                  setSelectedPieceId(piece.id)
                  setDraggingPieceId(piece.id)
                  const wrapper = boardWrapperRef.current
                  if (wrapper) {
                    const rect = wrapper.getBoundingClientRect()
                    setGhost({
                      piece,
                      x: (e.clientX - rect.left) / scale,
                      y: (e.clientY - rect.top) / scale,
                    })
                  }
                  triggerGrabHaptic()
                }}
              >
                {piece && !isDragging && (
                  <PiecePreview shape={piece.shape} mode="hand" />
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
          return (
            <polygon
              key={idx}
              points={points}
              className="hexaclear-hex piece"
            />
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
        return (
          <polygon
            key={idx}
            points={points}
            className="hexaclear-hex piece"
          />
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
