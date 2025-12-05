import { BOARD_DEFINITION } from './boardDefinition'
import { ALL_PIECE_SHAPES } from './pieces'
import type { PieceShape } from './pieces'
import type { CellId, Pattern } from './hexTypes'
import { rotateAxial } from './hexTypes'

export type GameMode = 'endless' | 'daily'

export type CellState = 'empty' | 'filled'

export type BoardState = Record<CellId, CellState>

export type ActivePiece = {
  id: string
  shape: PieceShape
}

export type Hand = ActivePiece[]

export type PlacementResult = {
  board: BoardState
  clearedCellIds: CellId[]
  clearedPatterns: Pattern[]
  pointsGained: number
  comboMultiplier: number
  streakMultiplier: number
  // Daily-mode bookkeeping is always returned; for endless games these
  // will just mirror the incoming state (no numbered targets).
  dailyHits: Record<CellId, number>
  dailyTotalHits: number
  dailyRemainingHits: number
  dailyCompleted: boolean
}

export type GameState = {
  mode: GameMode
  board: BoardState
  score: number
  streak: number
  hand: Hand
  handSlots: (string | null)[]
  gameOver: boolean
  // Count of successful piece placements in this run.
  moves: number
  // Daily puzzle data. For endless games these will all be "empty".
  dailyHits: Record<CellId, number>
  dailyTotalHits: number
  dailyRemainingHits: number
  dailyCompleted: boolean
}

const randomOf = <T>(arr: T[]): T =>
  arr[Math.floor(Math.random() * arr.length)]!

const scoringPatternIds = new Set([
  ...BOARD_DEFINITION.scoringLineIds,
  ...BOARD_DEFINITION.flowerIds,
])

// Simple deterministic RNG used for daily puzzle generation so that the
// same calendar day produces the same layout everywhere.
type RNG = () => number

const makeSeededRandom = (seed: number): RNG => {
  let state = seed >>> 0
  return () => {
    // Numerical Recipes LCG
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

const getTodaySeed = (): number => {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1
  const d = now.getUTCDate()
  const key = `${y}-${m}-${d}`
  // Simple string hash to int
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  return hash
}

export const findClears = (
  board: BoardState,
): { clearedPatterns: Pattern[]; clearedCellIds: CellId[] } => {
  const clearedPatterns: Pattern[] = []
  const clearedCellsSet = new Set<CellId>()

  for (const pattern of BOARD_DEFINITION.patterns) {
    if (!scoringPatternIds.has(pattern.id)) continue
    const allFilled = pattern.cellIds.every((id) => board[id] === 'filled')
    if (allFilled) {
      clearedPatterns.push(pattern)
      for (const cellId of pattern.cellIds) {
        clearedCellsSet.add(cellId)
      }
    }
  }

  return {
    clearedPatterns,
    clearedCellIds: Array.from(clearedCellsSet),
  }
}

export const createEmptyBoard = (): BoardState => {
  const state: BoardState = {}
  for (const cell of BOARD_DEFINITION.cells) {
    state[cell.id] = 'empty'
  }
  return state
}

export const dealHand = (): Hand => {
  const hand: Hand = []
  let totalCells = 0
  for (let i = 0; i < 3; i++) {
    let shape = randomOf(ALL_PIECE_SHAPES)
    let attempts = 0
    while (shape.size === 4 && totalCells + shape.size > 10 && attempts < 20) {
      shape = randomOf(ALL_PIECE_SHAPES)
      attempts++
    }

    const rotation = Math.floor(Math.random() * 6)
    const rotatedCells =
      rotation === 0
        ? shape.cells
        : shape.cells.map((c) => rotateAxial(c, rotation))
    const instanceShape: PieceShape = {
      ...shape,
      cells: rotatedCells,
    }
    hand.push({
      id: `piece-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`,
      shape: instanceShape,
    })
    totalCells += shape.size
  }
  return hand
}

export const canPlacePiece = (
  board: BoardState,
  piece: PieceShape,
  originCellId: CellId,
): { targetCellIds: CellId[] } | null => {
  const originCell = BOARD_DEFINITION.cells.find((c) => c.id === originCellId)
  if (!originCell) return null

  const targetIds: CellId[] = []

  for (const rel of piece.cells) {
    const targetQ = originCell.coord.q + rel.q
    const targetR = originCell.coord.r + rel.r
    const targetId = `${targetQ},${targetR}`
    if (!(targetId in board)) return null
    if (board[targetId] !== 'empty') return null
    targetIds.push(targetId)
  }

  return { targetCellIds: targetIds }
}

export const applyPlacement = (
  current: GameState,
  piece: ActivePiece,
  originCellId: CellId,
): PlacementResult | null => {
  const canPlace = canPlacePiece(current.board, piece.shape, originCellId)
  if (!canPlace) return null

  const board: BoardState = { ...current.board }
  for (const id of canPlace.targetCellIds) {
    board[id] = 'filled'
  }

  const { clearedPatterns, clearedCellIds } = findClears(board)

  // Start from current daily state; we may update it below if any of the
  // cleared patterns include numbered daily targets.
  let dailyHits = current.dailyHits
  let dailyTotalHits = current.dailyTotalHits
  let dailyRemainingHits = current.dailyRemainingHits
  let dailyCompleted = current.dailyCompleted

  if (clearedPatterns.length > 0 && Object.keys(dailyHits).length > 0) {
    // Count how many distinct clear-patterns each numbered cell
    // participates in for THIS placement. A cell that belongs to both a
    // flower and a line in the same move should tick down twice.
    const perCellHitCounts: Record<CellId, number> = {}
    for (const pattern of clearedPatterns) {
      for (const cellId of pattern.cellIds) {
        const currentHits = dailyHits[cellId]
        if (currentHits && currentHits > 0) {
          perCellHitCounts[cellId] =
            (perCellHitCounts[cellId] ?? 0) + 1
        }
      }
    }

    if (Object.keys(perCellHitCounts).length > 0) {
      dailyHits = { ...dailyHits }
      for (const [cellId, hitCount] of Object.entries(perCellHitCounts)) {
        const before = dailyHits[cellId] ?? 0
        if (before <= 0) continue
        const after = Math.max(0, before - hitCount)
        dailyHits[cellId] = after
        dailyRemainingHits -= before - after
      }
      if (dailyRemainingHits <= 0 && dailyTotalHits > 0) {
        dailyRemainingHits = 0
        dailyCompleted = true
      }
    }
  }

  if (clearedPatterns.length === 0) {
    return {
      board,
      clearedCellIds: [],
      clearedPatterns: [],
      pointsGained: 0,
      comboMultiplier: 1,
      streakMultiplier: 1,
      dailyHits,
      dailyTotalHits,
      dailyRemainingHits,
      dailyCompleted,
    }
  }

  for (const id of clearedCellIds) {
    board[id] = 'empty'
  }

  // In daily mode, any numbered cells that still have hits remaining
  // "survive" clears and should stay filled on the board.
  if (Object.keys(dailyHits).length > 0) {
    for (const [cellId, hits] of Object.entries(dailyHits)) {
      if (hits > 0) {
        board[cellId] = 'filled'
      }
    }
  }

  const numClears = clearedPatterns.length
  const comboMultiplier = 1 + 0.5 * (numClears - 1)
  const streakMultiplier = 1 + 0.1 * current.streak

  const wasBoardEmptyBefore = Object.values(current.board).every(
    (state) => state === 'empty',
  )
  const isBoardEmptyAfter = Object.values(board).every(
    (state) => state === 'empty',
  )
  const boardClearedBonus =
    !wasBoardEmptyBefore && isBoardEmptyAfter ? 25 : 0

  const basePoints = 10 * numClears + boardClearedBonus
  const pointsGained = Math.round(basePoints * comboMultiplier * streakMultiplier)

  return {
    board,
    clearedCellIds,
    clearedPatterns,
    pointsGained,
    comboMultiplier,
    streakMultiplier,
    dailyHits,
    dailyTotalHits,
    dailyRemainingHits,
    dailyCompleted,
  }
}

export const hasAnyValidMove = (board: BoardState, hand: Hand): boolean => {
  // Use the same placement path as real moves (including clears),
  // so "space created by clears" is always considered.
  const fakeGame: GameState = {
    mode: 'endless',
    board,
    score: 0,
    streak: 0,
    hand,
    handSlots: hand.map((p) => p.id),
    gameOver: false,
    moves: 0,
    dailyHits: {},
    dailyTotalHits: 0,
    dailyRemainingHits: 0,
    dailyCompleted: false,
  }
  for (const piece of hand) {
    for (const cell of BOARD_DEFINITION.cells) {
      const result = applyPlacement(fakeGame, piece, cell.id)
      if (result) return true
    }
  }
  return false
}

export const createInitialGameState = (): GameState => {
  const board = createEmptyBoard()
  const hand = dealHand()
  return {
    mode: 'endless',
    board,
    score: 0,
    streak: 0,
    hand,
    handSlots: hand.map((p) => p.id),
    gameOver: !hasAnyValidMove(board, hand),
    moves: 0,
    dailyHits: {},
    dailyTotalHits: 0,
    dailyRemainingHits: 0,
    dailyCompleted: false,
  }
}

// Create the daily puzzle board for the current UTC day. The layout of
// numbered hexes is deterministic per day, but the dealt pieces still
// use the regular RNG.
export const createDailyGameState = (): GameState => {
  const board = createEmptyBoard()

  const seed = getTodaySeed()
  const random = makeSeededRandom(seed)

  const dailyHits: Record<CellId, number> = {}

  // Build a quick lookup from cellId -> coord to find the central flower.
  const cellCoord = new Map<CellId, { q: number; r: number }>()
  for (const cell of BOARD_DEFINITION.cells) {
    cellCoord.set(cell.id, cell.coord)
  }

  const flowerPatterns = BOARD_DEFINITION.patterns.filter(
    (p) => p.type === 'flower',
  )

  // Identify the central flower as the one whose average axial coord is
  // closest to (0,0).
  let centerFlower: typeof flowerPatterns[number] | null = null
  let bestDistSq = Infinity
  for (const pattern of flowerPatterns) {
    let sumQ = 0
    let sumR = 0
    let count = 0
    for (const id of pattern.cellIds) {
      const coord = cellCoord.get(id)
      if (!coord) continue
      sumQ += coord.q
      sumR += coord.r
      count++
    }
    if (count === 0) continue
    const avgQ = sumQ / count
    const avgR = sumR / count
    const distSq = avgQ * avgQ + avgR * avgR
    if (distSq < bestDistSq) {
      bestDistSq = distSq
      centerFlower = pattern
    }
  }

  let totalHits = 0

  for (const pattern of flowerPatterns) {
    if (pattern === centerFlower) {
      continue
    }

    // Each non-center rosette gets 1–2 numbered hexes.
    const targetsForThisFlower = random() < 0.5 ? 1 : 2
    const available = [...pattern.cellIds]

    for (let n = 0; n < targetsForThisFlower && available.length > 0; n++) {
      const idx = Math.floor(random() * available.length)
      const cellId = available.splice(idx, 1)[0]!

      // Each numbered hex starts with 2–4 hits.
      const value = 2 + Math.floor(random() * 3)

      const previous = dailyHits[cellId] ?? 0
      const next = previous + value
      dailyHits[cellId] = next
      totalHits += value
    }
  }

  // Mark numbered targets as filled on the starting board.
  for (const [id, hits] of Object.entries(dailyHits)) {
    if (hits > 0) {
      board[id] = 'filled'
    }
  }

  const hand = dealHand()

  return {
    mode: 'daily',
    board,
    score: 0,
    streak: 0,
    hand,
    handSlots: hand.map((p) => p.id),
    gameOver: false,
    moves: 0,
    dailyHits,
    dailyTotalHits: totalHits,
    dailyRemainingHits: totalHits,
    dailyCompleted: false,
  }
}


