import { BOARD_DEFINITION } from './boardDefinition'
import { ALL_PIECE_SHAPES } from './pieces'
import type { PieceShape } from './pieces'
import type { CellId, Pattern } from './hexTypes'
import { rotateAxial } from './hexTypes'

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
}

export type GameState = {
  board: BoardState
  score: number
  streak: number
  hand: Hand
  handSlots: (string | null)[]
  gameOver: boolean
}

const randomOf = <T>(arr: T[]): T =>
  arr[Math.floor(Math.random() * arr.length)]!

const scoringPatternIds = new Set([
  ...BOARD_DEFINITION.scoringLineIds,
  ...BOARD_DEFINITION.flowerIds,
])

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

  if (clearedPatterns.length === 0) {
    return {
      board,
      clearedCellIds: [],
      clearedPatterns: [],
      pointsGained: 0,
      comboMultiplier: 1,
      streakMultiplier: 1,
    }
  }

  for (const id of clearedCellIds) {
    board[id] = 'empty'
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
  }
}

export const hasAnyValidMove = (board: BoardState, hand: Hand): boolean => {
  for (const piece of hand) {
    for (const cell of BOARD_DEFINITION.cells) {
      if (canPlacePiece(board, piece.shape, cell.id)) {
        return true
      }
    }
  }
  return false
}

export const createInitialGameState = (): GameState => {
  const board = createEmptyBoard()
  const hand = dealHand()
  return {
    board,
    score: 0,
    streak: 0,
    hand,
    handSlots: hand.map((p) => p.id),
    gameOver: !hasAnyValidMove(board, hand),
  }
}


