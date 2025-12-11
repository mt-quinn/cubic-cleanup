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
  // All cells that became filled as a result of placing the piece
  // (i.e. the raw footprint of the piece before any clears are applied).
  placedCellIds: CellId[]
  pointsGained: number
  comboMultiplier: number
  streakMultiplier: number
  // Daily-mode bookkeeping is always returned; for endless games these
  // will just mirror the incoming state (no numbered targets).
  dailyHits: Record<CellId, number>
  dailyTotalHits: number
  dailyRemainingHits: number
  dailyCompleted: boolean
  // Endless-mode golden cube state: the updated golden cell location
  // and whether it was cleared in this placement.
  goldenCellId: CellId | null
  goldenCleared: boolean
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
  // Daily-mode seed for deterministic hand dealing. Only set in daily mode.
  dailySeed?: number
  // Daily-mode hand deal count for deterministic sequencing. Only set in daily mode.
  dailyHandDealCount?: number
  // Endless-mode golden cube; null in daily mode.
  goldenCellId: CellId | null
}

const randomOf = <T>(arr: T[], random: () => number = Math.random): T =>
  arr[Math.floor(random() * arr.length)]!

const scoringPatternIds = new Set([
  ...BOARD_DEFINITION.scoringLineIds,
  ...BOARD_DEFINITION.flowerIds,
])

const FLOWER_PATTERNS = BOARD_DEFINITION.patterns.filter(
  (p) => p.type === 'flower',
)

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
  // Use the client’s local calendar day so that daily puzzles reset at
  // local midnight rather than a single global UTC boundary.
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const d = now.getDate()
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

// Choose a new golden cube position on the given board. The golden cube
// behaves like a real filled cube: if it lands on an empty cell we set
// that cell to 'filled', but we avoid any empty-cell placements that
// would immediately complete a scoring pattern. Optionally, we can
// forbid respawning inside certain flower (rosette) patterns.
const spawnGoldenCell = (
  board: BoardState,
  forbiddenFlowers?: Set<string>,
): CellId | null => {
  const cells = [...BOARD_DEFINITION.cells]
  // Shuffle to avoid always biasing toward earlier cells.
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[cells[i], cells[j]] = [cells[j]!, cells[i]!]
  }

  let fallbackFilled: CellId | null = null

cellLoop: for (const cell of cells) {
    const id = cell.id
    if (forbiddenFlowers && forbiddenFlowers.size > 0) {
      for (const pattern of FLOWER_PATTERNS) {
        if (
          forbiddenFlowers.has(pattern.id) &&
          pattern.cellIds.includes(id)
        ) {
          // Skip any cells that live inside a forbidden flower.
          continue cellLoop
        }
      }
    }

    const state = board[id]
    if (state === 'filled') {
      // Always safe: we're not changing occupancy so we can't create a
      // new clear just by marking it golden.
      return id
    }

    // Try treating this empty cell as filled and see if it would
    // immediately complete any scoring pattern. If not, accept it and
    // lock it in as filled.
    board[id] = 'filled'
    const { clearedPatterns } = findClears(board)
    if (clearedPatterns.length === 0) {
      return id
    }
    // Revert and keep looking.
    board[id] = 'empty'
  }

  // If we couldn't find a safe empty slot, fall back to *any* filled
  // cell (so we always have a golden cube somewhere).
  cellLoopFallback: for (const cell of cells) {
    const id = cell.id
    if (forbiddenFlowers && forbiddenFlowers.size > 0) {
      for (const pattern of FLOWER_PATTERNS) {
        if (
          forbiddenFlowers.has(pattern.id) &&
          pattern.cellIds.includes(id)
        ) {
          continue cellLoopFallback
        }
      }
    }
    if (board[id] === 'filled') {
      fallbackFilled = id
      break
    }
  }
  return fallbackFilled
}

export const dealHand = (random: () => number = Math.random): Hand => {
  const hand: Hand = []
  let totalCells = 0
  for (let i = 0; i < 3; i++) {
    let shape = randomOf(ALL_PIECE_SHAPES, random)
    let attempts = 0
    while (shape.size === 4 && totalCells + shape.size > 10 && attempts < 20) {
      shape = randomOf(ALL_PIECE_SHAPES, random)
      attempts++
    }

    const rotation = Math.floor(random() * 6)
    const rotatedCells =
      rotation === 0
        ? shape.cells
        : shape.cells.map((c) => rotateAxial(c, rotation))
    const instanceShape: PieceShape = {
      ...shape,
      cells: rotatedCells,
    }
    // For deterministic IDs in daily mode, use a counter-based approach
    // For endless mode, use timestamp-based IDs
    const idSuffix = random().toString(36).slice(2)
    hand.push({
      id: `piece-${Date.now()}-${i}-${idSuffix}`,
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
  const placedCellIds = [...canPlace.targetCellIds]
  for (const id of placedCellIds) {
    board[id] = 'filled'
  }

  const { clearedPatterns, clearedCellIds } = findClears(board)

  // Start from current daily state; we may update it below if any of the
  // cleared patterns include numbered daily targets.
  let dailyHits = current.dailyHits
  let dailyTotalHits = current.dailyTotalHits
  let dailyRemainingHits = current.dailyRemainingHits
  let dailyCompleted = current.dailyCompleted
  let goldenCellId = current.goldenCellId
  const previousGoldenCellId = current.goldenCellId

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
      placedCellIds,
      pointsGained: 0,
      comboMultiplier: 1,
      streakMultiplier: 1,
      dailyHits,
      dailyTotalHits,
      dailyRemainingHits,
      dailyCompleted,
      goldenCellId,
      goldenCleared: false,
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

  // Track whether the golden cube was cleared in this placement (endless
  // mode only). If so, we'll both award its bonus and immediately spawn
  // it at a new location on the resulting board.
  let goldenCleared = false
  if (current.mode === 'endless' && goldenCellId) {
    if (clearedCellIds.includes(goldenCellId)) {
      goldenCleared = true
      goldenCellId = null
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

  const goldenBonus = current.mode === 'endless' && goldenCleared ? 10 : 0
  const basePoints = 10 * numClears + boardClearedBonus + goldenBonus
  const pointsGained = Math.round(basePoints * comboMultiplier * streakMultiplier)

  // If we just cleared the golden cube in endless mode, immediately
  // respawn it somewhere else on the board.
  if (current.mode === 'endless' && goldenCleared) {
    let forbiddenFlowers: Set<string> | undefined
    if (previousGoldenCellId) {
      const ids = FLOWER_PATTERNS.filter((p) =>
        p.cellIds.includes(previousGoldenCellId),
      ).map((p) => p.id)
      if (ids.length > 0) {
        forbiddenFlowers = new Set(ids)
      }
    }
    const newGolden = spawnGoldenCell(board, forbiddenFlowers)
    goldenCellId = newGolden
  }

  return {
    board,
    clearedCellIds,
    clearedPatterns,
    placedCellIds,
    pointsGained,
    comboMultiplier,
    streakMultiplier,
    dailyHits,
    dailyTotalHits,
    dailyRemainingHits,
    dailyCompleted,
    goldenCellId,
    goldenCleared,
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
    goldenCellId: null,
  }
  for (const piece of hand) {
    for (const cell of BOARD_DEFINITION.cells) {
      const result = applyPlacement(fakeGame, piece, cell.id)
      if (result) return true
    }
  }
  return false
}

// Deal a new 3-piece hand that is guaranteed (under normal circumstances)
// to contain at least one playable piece for the given board state. We
// reuse the existing hasAnyValidMove path so the definition of "playable"
// exactly matches our real move rules.
export const dealPlayableHand = (
  board: BoardState,
  maxAttempts = 30,
  random: () => number = Math.random,
): Hand => {
  let hand = dealHand(random)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (hasAnyValidMove(board, hand)) {
      return hand
    }
    hand = dealHand(random)
  }
  // In principle we should never get here (as long as there is at least
  // one empty cell on the board and our piece set includes a single-cube
  // piece), but fall back to the last hand to avoid an infinite loop if
  // something goes wrong.
  return hand
}

export const createInitialGameState = (): GameState => {
  const board = createEmptyBoard()
  // Spawn the initial golden cube for endless mode.
  const goldenCellId = spawnGoldenCell(board)
  const hand = dealPlayableHand(board)
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
    goldenCellId,
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

    // Each non-center rosette gets exactly 1 numbered hex.
    const available = [...pattern.cellIds]

    if (available.length > 0) {
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

  // Use seeded random for deterministic hands in daily mode
  const hand = dealPlayableHand(board, 30, random)

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
    dailySeed: seed,
    dailyHandDealCount: 0,
    goldenCellId: null,
  }
}

// Deal a new hand for daily mode using the seeded random generator.
// This ensures hands are deterministic based on the daily seed and hand count.
// The key insight: we need to simulate all previous hand deals exactly,
// including all the failed attempts, to ensure we're at the right position
// in the random sequence. We do this by actually calling dealPlayableHand
// for each previous hand, but we need to know the board state for each.
// 
// However, since we can't easily reconstruct past board states, we use
// a simpler approach: we create a seeded random and advance it by a large
// fixed amount per hand deal. This works because dealPlayableHand will
// consume the same amount of randomness for the same board state, and
// we're using a fixed seed, so the sequence is deterministic.
//
// Actually, a better approach: we track the exact number of random calls
// made so far. But that's complex. For now, we use a large fixed offset
// that should be sufficient for most cases.
export const dealDailyHand = (
  board: BoardState,
  dailySeed: number,
  handDealCount: number,
): Hand => {
  const random = makeSeededRandom(dailySeed)
  
  // Advance the random sequence to account for all previous hand deals.
  // Each hand deal might consume varying amounts of randomness depending
  // on how many attempts dealPlayableHand needs. We use a conservative
  // estimate that should cover most cases. In practice, dealHand uses
  // roughly 10-20 random calls per hand (3 pieces * ~5 calls each),
  // and dealPlayableHand might try up to 30 hands, so worst case is
  // ~600 calls. We use 1000 to be safe.
  const estimatedRandomCallsPerHand = 1000
  for (let i = 0; i < handDealCount * estimatedRandomCallsPerHand; i++) {
    random()
  }
  
  // Now deal the current hand using the seeded random
  return dealPlayableHand(board, 30, random)
}


