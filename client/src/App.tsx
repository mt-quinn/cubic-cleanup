import { useEffect, useMemo, useRef, useState } from 'react'
import { BOARD_DEFINITION } from './game/boardDefinition'
import {
  applyPlacement,
  createInitialGameState,
  dealHand,
  hasAnyValidMove,
} from './game/gameLogic'
import type { ActivePiece, GameState } from './game/gameLogic'
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

const CubeLines = ({ cx, cy }: { cx: number; cy: number }) => {
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

  return (
    <g className="hexaclear-hex-cube">
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
      clearedIds = result.clearedCellIds
    }
  }

  return { targetIds, valid, clearedIds }
}

type HighScoreEntry = {
  name: string
  score: number
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
  const [game, setGame] = useState<GameState>(() => createInitialGameState())
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null)
  const [hover, setHover] = useState<HoverInfo>(null)
  const [clearingCells, setClearingCells] = useState<string[]>([])
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
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [playerName, setPlayerName] = useState(() => {
    if (typeof window === 'undefined') return ''
    return window.localStorage.getItem('cubic-player-name') ?? ''
  })
  const [bestScore, setBestScore] = useState<number | null>(() => {
    const stored = window.localStorage.getItem('hexaclear-best-score')
    return stored ? Number(stored) : null
  })

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
  }>({ pieceId: null, pointerId: null })
  const [draggingPieceId, setDraggingPieceId] = useState<string | null>(null)
  const scale = 1
  const [ghost, setGhost] = useState<{
    piece: ActivePiece
    x: number
    y: number
  } | null>(null)

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

  const placePieceAtCell = (pieceId: string, cellId: string) => {
    setGame((current) => {
      if (current.gameOver) return current
      const piece = current.hand.find((p) => p.id === pieceId)
      if (!piece) return current

      const result = applyPlacement(current, piece, cellId)
      if (!result) return current

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

      if (remainingHand.length === 0) {
        newHand = dealHand()
        for (let i = 0; i < 3; i++) {
          updatedSlots[i] = newHand[i]?.id ?? null
        }
      }

      if (!hasAnyValidMove(result.board, newHand)) {
        gameOver = true
      }

      const newScore = current.score + result.pointsGained
      const flatPoints = piece.shape.cells.length
      const finalScore = newScore + flatPoints

      if (result.clearedPatterns.length > 0) {
        setClearingCells(result.clearedCellIds)
        const totalClears = result.clearedPatterns.length
        const popupText =
          totalClears === 1
            ? `Clear · +${result.pointsGained}`
            : `${totalClears} clears · +${result.pointsGained}`
        setScorePopup(popupText)
        setScorePopupId((id) => id + 1)
      }

      triggerHaptics(result.clearedPatterns.length > 0)

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

      setSelectedPieceId(null)

      return {
        ...current,
        board: result.board,
        score: finalScore,
        streak: result.clearedPatterns.length > 0 ? newStreak : 0,
        hand: newHand,
        handSlots: updatedSlots,
        gameOver,
      }
    })
  }

  const handleCellClick = (cellId: string) => {
    if (!selectedPieceId) return
    placePieceAtCell(selectedPieceId, cellId)
  }

  const resetGame = () => {
    setGame(createInitialGameState())
    setSelectedPieceId(null)
    setHover(null)
    setHighScoreSaved(false)
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
    }, 450)
    return () => window.clearTimeout(timeout)
  }, [clearingCells])

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
    const score = game.score
    setPendingScore(score)
    setPendingHighScore(
      !highScoreSaved && qualifiesForHighScore(score, highScores),
    )
  }, [game.gameOver, game.score, highScores, highScoreSaved])

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
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('cubic-highscores', JSON.stringify(next))
      window.localStorage.setItem('cubic-player-name', name)
    }
    setPendingHighScore(false)
    setHighScoreSaved(true)
  }

  const handleResetHighScores = () => {
    setHighScores([])
    setPendingHighScore(false)
    setPendingScore(null)
    setHighScoreSaved(false)
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('cubic-highscores')
    }
    setShowResetConfirm(false)
  }

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (!dragState.current.pointerId) return
      const wrapper = boardWrapperRef.current
      if (!wrapper) return
      const rect = wrapper.getBoundingClientRect()
      const x = (e.clientX - rect.left) / scale
      const y = (e.clientY - rect.top) / scale
      setGhost((prev) => (prev ? { ...prev, x, y } : prev))
      const cellId = findClosestCellIdFromClientPoint(
        e.clientX,
        e.clientY - 80,
      )
      if (cellId) {
        setHover({ cellId })
      } else {
        setHover(null)
      }
    }

    const handlePointerUp = (e: PointerEvent) => {
      if (!dragState.current.pieceId) return
      const cellId =
        hover?.cellId ??
        findClosestCellIdFromClientPoint(e.clientX, e.clientY - 80)
      const pieceId = dragState.current.pieceId
      dragState.current.pointerId = null
      dragState.current.pieceId = null
      setDraggingPieceId(null)
      setGhost(null)
      if (cellId && pieceId) {
        placePieceAtCell(pieceId, cellId)
      }
      setHover(null)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
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
        <div className="hexaclear-title">Cubic Cleanup</div>
        <div className="hexaclear-stats">
          {bestScore !== null && (
            <div className="hexaclear-best-banner">
              <span className="label">Best</span>
              <span className="value">{bestScore}</span>
            </div>
          )}
        </div>
        <button className="hexaclear-reset" onClick={resetGame}>
          New Game
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
          High Scores
        </button>
      </header>

      <main className="hexaclear-main">
        <div className="hexaclear-board-wrapper" ref={boardWrapperRef}>
          <svg
            className="hexaclear-board"
            ref={svgRef}
            viewBox={`0 0 ${BOARD_LAYOUT.width} ${BOARD_LAYOUT.height}`}
          >
            {BOARD_DEFINITION.cells.map((cell) => {
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

              return (
                <g key={cell.id}>
                  <polygon
                    points={points}
                    className={[
                      'hexaclear-hex',
                      isFilled ? 'filled' : 'empty',
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
                  {isFilled && <CubeLines cx={cx} cy={cy} />}
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
            })}
            {FLOWER_BOUNDARY_SEGMENTS.map((seg, idx) => (
              <line
                key={idx}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                className="hexaclear-flower-boundary"
              />
            ))}
          </svg>
          <div className="hexaclear-board-hud">
            <div className="board-hud-block left">
              <span className="label">Score:</span>
              <span className="value">{game.score}</span>
            </div>
            <div className="board-hud-block right">
              <span className="label">Streak</span>
              <span className="value">{game.streak}</span>
            </div>
          </div>
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
          {scorePopup && (
            <div className="hexaclear-score-popup">{scorePopup}</div>
          )}
          {game.gameOver && (
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
                        .map((entry, idx) => (
                          <li key={entry.date + entry.name + idx}>
                            <span className="name">{entry.name}</span>
                            <span className="value">{entry.score}</span>
                          </li>
                        ))}
                    </ol>
                  </div>
                )}
                <button onClick={resetGame}>Play again</button>
              </div>
            </div>
          )}
          {showScoring && (
            <div className="hexaclear-overlay">
              <div className="hexaclear-overlay-card">
                <div className="title">Scoring</div>
                <div className="score">
                  <p>Each cleared line or flower is worth 10 points.</p>
                  <p>
                    Combo multiplier: +0.5 per additional clear in the same
                    placement (1 clear = x1.0, 2 clears = x1.5, 3 clears = x2.0,
                    etc.).
                  </p>
                  <p>
                    Streak multiplier: +0.1 per consecutive clearing placement
                    (1st clear after a miss = x1.0, 2nd in a row = x1.1, 3rd in
                    a row = x1.2, etc.).
                  </p>
                  <p>Total points = 10 × clears × combo × streak.</p>
                </div>
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
                  {highScores.length === 0 ? (
                    <p>No scores yet. Play a game!</p>
                  ) : (
                    <ol className="hexaclear-highscores">
                      {highScores
                        .slice()
                        .sort(
                          (a, b) =>
                            b.score - a.score || a.date - b.date,
                        )
                        .map((entry, idx) => (
                          <li key={entry.date + entry.name + idx}>
                            <span className="name">{entry.name}</span>
                            <span className="value">{entry.score}</span>
                          </li>
                        ))}
                    </ol>
                  )}
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

            return (
            <button
              key={slotIndex}
              className={[
                'hexaclear-piece-button',
                isSelected ? 'selected' : '',
                isDragging ? 'dragging' : '',
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
              {piece && <PiecePreview shape={piece.shape} mode="hand" />}
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
