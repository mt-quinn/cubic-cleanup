import {
  BOARD_DEFINITION,
  BIG_BOARD_DEFINITION,
  STANDARD_BOARD_DEFINITION,
  getBoardDefinitionForMode,
} from './boardDefinition'
import { ALL_PIECE_SHAPES } from './pieces'
import type { PieceShape } from './pieces'
import type { BoardDefinition, CellId, Pattern } from './hexTypes'
import { rotateAxial } from './hexTypes'

export type GameMode = 'endless' | 'daily' | 'big'

type CellState = 'empty' | 'filled'

export type BoardState = Record<CellId, CellState>

export type ActivePiece = {
  id: string
  shape: PieceShape
}

type Hand = ActivePiece[]

// How many bonus rubies (a.k.a. golden cubes) a given mode keeps live on
// the board. Endless has the classic single ruby; big mode plays with
// three at once and respawns each one as it clears; daily mode has none
// because the numbered cubes already drive the scoring tempo.
const RUBY_COUNT_BY_MODE: Record<GameMode, number> = {
  endless: 1,
  daily: 0,
  big: 3,
}

// Per-mode scoring parameters. Big mode pays out 4x per pattern clear and
// 4x for board clears so the bigger rosettes still feel rewarding to
// finish; endless and daily keep their original numbers.
type ModeScoring = {
  pointsPerClearedPattern: number
  boardClearedBonus: number
  // Bonus added to the base score for *each* ruby cleared in a placement.
  // Endless awards this for the lone ruby; big stacks the bonus for every
  // simultaneously-cleared ruby.
  rubyClearedBonus: number
}

const SCORING_BY_MODE: Record<GameMode, ModeScoring> = {
  endless: {
    pointsPerClearedPattern: 10,
    boardClearedBonus: 25,
    rubyClearedBonus: 10,
  },
  daily: {
    pointsPerClearedPattern: 10,
    boardClearedBonus: 25,
    rubyClearedBonus: 0,
  },
  big: {
    pointsPerClearedPattern: 40,
    boardClearedBonus: 100,
    rubyClearedBonus: 10,
  },
}

type PlacementResult = {
  board: BoardState
  clearedCellIds: CellId[]
  clearedPatterns: Pattern[]
  // All cells that became filled as a result of placing the piece
  // (i.e. the raw footprint of the piece before any clears are applied).
  placedCellIds: CellId[]
  pointsGained: number
  comboMultiplier: number
  streakMultiplier: number
  // Daily-mode bookkeeping is always returned; for endless/big games these
  // will just mirror the incoming state (no numbered targets).
  dailyHits: Record<CellId, number>
  dailyTotalHits: number
  dailyRemainingHits: number
  dailyCompleted: boolean
  // Updated ruby positions after this placement (post-clear, post-respawn).
  // Order matches the incoming `goldenCellIds`; a freshly-respawned ruby
  // takes the slot of the one that was cleared. For daily this stays
  // empty; endless has 0 or 1; big has up to 3.
  goldenCellIds: CellId[]
  // Number of rubies cleared in *this* placement. Big mode multiplies the
  // ruby bonus by this count; endless treats it as boolean.
  rubiesCleared: number
  // True when this placement emptied the entire board (earning the
  // mode-specific board-clear bonus). Surfaced so the UI can play a
  // flourish.
  boardCleared: boolean
}

export type GameState = {
  mode: GameMode
  board: BoardState
  score: number
  streak: number
  hand: Hand
  handSlots: (string | null)[]
  // Single-slot "hold" buffer (Tetris-style). Players can park a piece
  // outside their hand to play later, or swap it back into hand. null
  // means the slot is empty. The held piece counts toward the
  // game-over check just like a hand piece (see `hasAnyValidMove`).
  hold: ActivePiece | null
  gameOver: boolean
  // Count of successful piece placements in this run.
  moves: number
  // Daily puzzle data. For endless/big games these will all be "empty".
  dailyHits: Record<CellId, number>
  dailyTotalHits: number
  dailyRemainingHits: number
  dailyCompleted: boolean
  // Daily-mode seed for deterministic hand dealing. Only set in daily mode.
  dailySeed?: number
  // Daily-mode hand deal count for deterministic sequencing. Only set in daily mode.
  dailyHandDealCount?: number
  // Calendar date this daily run is for, in `YYYY-M-D` form (no
  // zero padding) so the seed input matches the legacy hash. Only
  // set in daily mode. Today's run uses today's key; past-day
  // replays from the history calendar use the archived day's key,
  // which lets the App detect "this is an archive run" via
  // `dailyDateKey !== getTodayDateKey()` and gate off global
  // submission accordingly.
  dailyDateKey?: string
  // Live ruby positions. Endless = 0 or 1, big = up to 3, daily = always 0.
  goldenCellIds: CellId[]
}

const randomOf = <T>(arr: T[], random: () => number = Math.random): T =>
  arr[Math.floor(random() * arr.length)]!

const getScoringPatternIds = (boardDef: BoardDefinition): Set<string> =>
  new Set([...boardDef.scoringLineIds, ...boardDef.flowerIds])

const getFlowerPatterns = (boardDef: BoardDefinition): Pattern[] =>
  boardDef.patterns.filter((p) => p.type === 'flower')

// Cached scoring-pattern lookups per mode so the placement hot path
// doesn't re-allocate a Set on every call.
const SCORING_PATTERNS_BY_MODE: Record<GameMode, Set<string>> = {
  endless: getScoringPatternIds(STANDARD_BOARD_DEFINITION),
  daily: getScoringPatternIds(STANDARD_BOARD_DEFINITION),
  big: getScoringPatternIds(BIG_BOARD_DEFINITION),
}

const FLOWER_PATTERNS_BY_MODE: Record<GameMode, Pattern[]> = {
  endless: getFlowerPatterns(STANDARD_BOARD_DEFINITION),
  daily: getFlowerPatterns(STANDARD_BOARD_DEFINITION),
  big: getFlowerPatterns(BIG_BOARD_DEFINITION),
}

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

// Hash a YYYY-M-D string into a 32-bit int. Pulled out so today's
// seed and past-day-replay seeds share the exact same hash, which
// guarantees a calendar day always maps to the same puzzle.
const hashDateKey = (key: string): number => {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  return hash
}

// Normalize any incoming date key into the unpadded `YYYY-M-D`
// format the legacy seed used. Padded inputs (e.g. `2026-05-20`)
// are silently re-hashed under the unpadded form so they collide
// with the value the original `getTodaySeed()` produced — meaning
// existing players' "today" puzzles don't drift when this code
// path turns on.
const normalizeDateKeyForSeed = (dateKey: string): string => {
  const parts = dateKey.split('-')
  if (parts.length !== 3) return dateKey
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return dateKey
  }
  return `${y}-${m}-${d}`
}

// Today's calendar date in zero-padded `YYYY-MM-DD` form, matching
// the `cubic-daily-runs-…` localStorage convention on the App side.
// `normalizeDateKeyForSeed` strips the padding before hashing so the
// resulting seed still matches the legacy unpadded form, which means
// existing players' "today" puzzle is unchanged.
const getTodayDateKey = (): string => {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const d = now.getDate()
  const mm = String(m).padStart(2, '0')
  const dd = String(d).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

const findClears = (
  board: BoardState,
  mode: GameMode = 'endless',
): { clearedPatterns: Pattern[]; clearedCellIds: CellId[] } => {
  const boardDef = getBoardDefinitionForMode(mode)
  const scoringPatternIds = SCORING_PATTERNS_BY_MODE[mode]
  const clearedPatterns: Pattern[] = []
  const clearedCellsSet = new Set<CellId>()

  for (const pattern of boardDef.patterns) {
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

export const createEmptyBoard = (mode: GameMode = 'endless'): BoardState => {
  const boardDef = getBoardDefinitionForMode(mode)
  const state: BoardState = {}
  for (const cell of boardDef.cells) {
    state[cell.id] = 'empty'
  }
  return state
}

// Choose a new ruby/golden cube position for the given mode.
//
// Selection order:
// 1. PREFER FILLED: if any non-forbidden cell is currently `filled`,
//    take that one. This is the dominant case for ruby respawns —
//    the board still has player pieces standing, and dropping the
//    new ruby on top of one of those reads as a "replacement"
//    rather than slipping a new ruby into some unrelated empty
//    hex elsewhere on the board. Per design: as long as even one
//    player piece is on the board, a respawned ruby must land on
//    a player-filled hex. We're not changing occupancy so this is
//    always safe (can't trip a new clear just by recoloring).
// 2. SAFE EMPTY: otherwise mark an empty cell `filled` (which
//    becomes the ruby's new home), provided that flip wouldn't
//    immediately complete a scoring pattern. This is the path
//    used by initial spawns on a fresh board and by edge-case
//    respawns where every player-filled cell was just cleared
//    out from under us.
// 3. Returns null only if every candidate is forbidden or empties
//    would all trip immediate clears — the caller treats null as
//    "no ruby this round" and moves on.
//
// Cells in `forbiddenFlowers` are skipped (used to avoid
// respawning the same ruby into the rosette it just cleared) and
// cells in `forbiddenCellIds` are skipped (used to keep multiple
// rubies from colliding on the same tile and to avoid respawning
// onto another ruby).
const spawnGoldenCell = (
  board: BoardState,
  mode: GameMode,
  options: {
    forbiddenFlowers?: Set<string>
    forbiddenCellIds?: Set<CellId>
  } = {},
): CellId | null => {
  const boardDef = getBoardDefinitionForMode(mode)
  const flowerPatterns = FLOWER_PATTERNS_BY_MODE[mode]
  const { forbiddenFlowers, forbiddenCellIds } = options
  const cells = [...boardDef.cells]
  // Shuffle to avoid always biasing toward earlier cells.
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[cells[i], cells[j]] = [cells[j]!, cells[i]!]
  }

  const isForbidden = (id: CellId): boolean => {
    if (forbiddenCellIds && forbiddenCellIds.has(id)) return true
    if (forbiddenFlowers && forbiddenFlowers.size > 0) {
      for (const pattern of flowerPatterns) {
        if (
          forbiddenFlowers.has(pattern.id) &&
          pattern.cellIds.includes(id)
        ) {
          return true
        }
      }
    }
    return false
  }

  // Pass 1: filled non-forbidden cell wins. Marking it golden doesn't
  // change occupancy, so no clear-trigger check needed.
  for (const cell of cells) {
    const id = cell.id
    if (isForbidden(id)) continue
    if (board[id] === 'filled') {
      return id
    }
  }

  // Pass 2: pick a safe empty cell. Flip it filled (becomes the
  // ruby's home) only if doing so doesn't trip an immediate clear.
  for (const cell of cells) {
    const id = cell.id
    if (isForbidden(id)) continue
    if (board[id] !== 'empty') continue
    board[id] = 'filled'
    const { clearedPatterns } = findClears(board, mode)
    if (clearedPatterns.length === 0) {
      return id
    }
    board[id] = 'empty'
  }

  return null
}

// Spawn N rubies into a fresh board, each one in a different flower
// when possible. Returns the array of cell ids; mutates `board` so each
// chosen empty-cell becomes 'filled'.
export const spawnInitialRubies = (
  board: BoardState,
  mode: GameMode,
  count: number,
): CellId[] => {
  const flowerPatterns = FLOWER_PATTERNS_BY_MODE[mode]
  const rubyCellIds: CellId[] = []
  const rubyFlowerIds = new Set<string>()
  for (let i = 0; i < count; i++) {
    const newId = spawnGoldenCell(board, mode, {
      forbiddenFlowers: new Set(rubyFlowerIds),
      forbiddenCellIds: new Set(rubyCellIds),
    })
    if (!newId) break
    rubyCellIds.push(newId)
    for (const pattern of flowerPatterns) {
      if (pattern.cellIds.includes(newId)) {
        rubyFlowerIds.add(pattern.id)
      }
    }
  }
  return rubyCellIds
}

const dealHand = (random: () => number = Math.random): Hand => {
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
  mode: GameMode = 'endless',
): { targetCellIds: CellId[] } | null => {
  const boardDef = getBoardDefinitionForMode(mode)
  const originCell = boardDef.cells.find((c) => c.id === originCellId)
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
  const canPlace = canPlacePiece(current.board, piece.shape, originCellId, current.mode)
  if (!canPlace) return null

  const flowerPatterns = FLOWER_PATTERNS_BY_MODE[current.mode]
  const scoring = SCORING_BY_MODE[current.mode]

  const board: BoardState = { ...current.board }
  const placedCellIds = [...canPlace.targetCellIds]
  for (const id of placedCellIds) {
    board[id] = 'filled'
  }

  const { clearedPatterns, clearedCellIds } = findClears(board, current.mode)

  // Start from current daily state; we may update it below if any of the
  // cleared patterns include numbered daily targets.
  let dailyHits = current.dailyHits
  let dailyTotalHits = current.dailyTotalHits
  let dailyRemainingHits = current.dailyRemainingHits
  let dailyCompleted = current.dailyCompleted
  let goldenCellIds = [...current.goldenCellIds]

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
      goldenCellIds,
      rubiesCleared: 0,
      boardCleared: false,
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

  // Track which rubies got swept up in this clear. Each cleared ruby
  // earns the per-mode ruby bonus and respawns at a fresh position
  // outside the rosette it was just sitting in.
  const clearedSet = new Set(clearedCellIds)
  const survivingRubyIds: CellId[] = []
  const clearedRubyIds: CellId[] = []
  for (const id of goldenCellIds) {
    if (clearedSet.has(id)) {
      clearedRubyIds.push(id)
    } else {
      survivingRubyIds.push(id)
    }
  }

  // Determine whether the placement cleared the entire board BEFORE
  // respawning any replacement rubies. spawnGoldenCell may flip an
  // 'empty' cell to 'filled' (the new ruby's home), which would
  // otherwise sneak in ahead of the board-empty check and rob the
  // player of the board-clear bonus + animation on the move that
  // emptied the last ruby off the board.
  const wasBoardEmptyBefore = Object.values(current.board).every(
    (state) => state === 'empty',
  )
  const isBoardEmptyAfter = Object.values(board).every(
    (state) => state === 'empty',
  )
  const boardCleared = !wasBoardEmptyBefore && isBoardEmptyAfter
  const boardClearedBonus = boardCleared ? scoring.boardClearedBonus : 0

  // Rebuild goldenCellIds: keep the survivors, then for each cleared
  // ruby spawn a replacement (avoiding the surviving ruby cells and the
  // rosette the cleared one had been in).
  goldenCellIds = [...survivingRubyIds]
  for (const previousId of clearedRubyIds) {
    let forbiddenFlowers: Set<string> | undefined
    const ids = flowerPatterns
      .filter((p) => p.cellIds.includes(previousId))
      .map((p) => p.id)
    if (ids.length > 0) {
      forbiddenFlowers = new Set(ids)
    }
    const newId = spawnGoldenCell(board, current.mode, {
      forbiddenFlowers,
      forbiddenCellIds: new Set(goldenCellIds),
    })
    if (newId) goldenCellIds.push(newId)
  }

  const numClears = clearedPatterns.length
  const comboMultiplier = 1 + 0.5 * (numClears - 1)
  const streakMultiplier = 1 + 0.1 * current.streak

  const rubiesCleared = clearedRubyIds.length
  const rubyBonusTotal = rubiesCleared * scoring.rubyClearedBonus
  const basePoints =
    scoring.pointsPerClearedPattern * numClears + boardClearedBonus + rubyBonusTotal
  const pointsGained = Math.round(
    basePoints * comboMultiplier * streakMultiplier,
  )

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
    goldenCellIds,
    rubiesCleared,
    boardCleared,
  }
}

export const hasAnyValidMove = (
  board: BoardState,
  hand: Hand,
  mode: GameMode = 'endless',
  hold: ActivePiece | null = null,
): boolean => {
  const boardDef = getBoardDefinitionForMode(mode)
  // Use the same placement path as real moves (including clears),
  // so "space created by clears" is always considered.
  const fakeGame: GameState = {
    mode,
    board,
    score: 0,
    streak: 0,
    hand,
    handSlots: hand.map((p) => p.id),
    hold,
    gameOver: false,
    moves: 0,
    dailyHits: {},
    dailyTotalHits: 0,
    dailyRemainingHits: 0,
    dailyCompleted: false,
    goldenCellIds: [],
  }
  // Held piece counts toward "any valid move" — a player whose three
  // hand pieces are all blocked but whose held piece can still be
  // placed should not be game over.
  const candidates: Hand = hold ? [...hand, hold] : hand
  for (const piece of candidates) {
    for (const cell of boardDef.cells) {
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
  mode: GameMode = 'endless',
): Hand => {
  let hand = dealHand(random)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (hasAnyValidMove(board, hand, mode)) {
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
  const board = createEmptyBoard('endless')
  // Spawn the initial golden cube for endless mode.
  const goldenCellIds = spawnInitialRubies(board, 'endless', RUBY_COUNT_BY_MODE.endless)
  const hand = dealPlayableHand(board, 30, Math.random, 'endless')
  return {
    mode: 'endless',
    board,
    score: 0,
    streak: 0,
    hand,
    handSlots: hand.map((p) => p.id),
    hold: null,
    gameOver: !hasAnyValidMove(board, hand, 'endless'),
    moves: 0,
    dailyHits: {},
    dailyTotalHits: 0,
    dailyRemainingHits: 0,
    dailyCompleted: false,
    goldenCellIds,
  }
}

// Big-board endless variant: 7 radius-2 rosettes with 3 simultaneous
// rubies. Same single-player scoring loop as endless mode, just on a
// larger surface (and tuned scoring values per mode in SCORING_BY_MODE).
export const createBigGameState = (): GameState => {
  const board = createEmptyBoard('big')
  const goldenCellIds = spawnInitialRubies(board, 'big', RUBY_COUNT_BY_MODE.big)
  const hand = dealPlayableHand(board, 30, Math.random, 'big')
  return {
    mode: 'big',
    board,
    score: 0,
    streak: 0,
    hand,
    handSlots: hand.map((p) => p.id),
    hold: null,
    gameOver: !hasAnyValidMove(board, hand, 'big'),
    moves: 0,
    dailyHits: {},
    dailyTotalHits: 0,
    dailyRemainingHits: 0,
    dailyCompleted: false,
    goldenCellIds,
  }
}

// Create the daily puzzle board for the given calendar day, or for
// today if `dateKey` is omitted. The layout of numbered hexes is
// deterministic per day, dealt pieces are drawn off the same
// per-day seed, so the same dateKey always produces the exact same
// puzzle (which is what powers past-day replays from the history
// calendar). The seed input is intentionally formatted as the
// legacy `YYYY-M-D` (no zero padding) so existing today seeds keep
// resolving to the puzzle players already have.
export const createDailyGameState = (dateKey?: string): GameState => {
  const board = createEmptyBoard('daily')

  const resolvedDateKey =
    dateKey !== undefined && dateKey !== null && dateKey !== ''
      ? dateKey
      : getTodayDateKey()
  const seed = hashDateKey(normalizeDateKeyForSeed(resolvedDateKey))
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

      // Each numbered hex starts with 2–3 hits.
      const value = 2 + Math.floor(random() * 2)

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
  const hand = dealPlayableHand(board, 30, random, 'daily')

  return {
    mode: 'daily',
    board,
    score: 0,
    streak: 0,
    hand,
    handSlots: hand.map((p) => p.id),
    hold: null,
    gameOver: false,
    moves: 0,
    dailyHits,
    dailyTotalHits: totalHits,
    dailyRemainingHits: totalHits,
    dailyCompleted: false,
    dailySeed: seed,
    dailyHandDealCount: 0,
    dailyDateKey: resolvedDateKey,
    goldenCellIds: [],
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
  return dealPlayableHand(board, 30, random, 'daily')
}

// --- Micro-tutorial states ------------------------------------------
//
// The first-launch tutorial runs as two staged endless-mode boards.
// Stage 1: a single diagonal scoring line is filled except for two
// adjacent cells at its center; the player is dealt a single pair piece
// that exactly fills the gap. Dropping it clears one line — the
// player's first taste of the satisfaction loop.
//
// Stage 2: the board is filled into an asterisk through (0,0) — the
// three primary-direction lines that all pass through center, plus
// the central rosette, all filled except for (0,0) itself. A greedy
// no-pre-existing-clear pass then fills as many remaining cells as
// possible to make the board look "mostly full". The player is dealt
// a single singlet at (0,0); placing it clears four patterns at once
// (three lines + the central flower), teaching that combos exist and
// feel enormous.
//
// Both stages run on the standard 49-cell endless board with rubies
// disabled. The hand only contains a single slot-0 piece; slots 1 and
// 2 are intentionally empty so the visual focus is on the one move.

// Diagonal scoring line (q + r = 0) running through the central
// rosette. All seven cells exist on the standard board; the tutorial
// piece is dealt to fill the centered gap.
const TUTORIAL_STAGE_1_LINE_CELLS: CellId[] = [
  '-3,3',
  '-2,2',
  '-1,1',
  '0,0',
  '1,-1',
  '2,-2',
  '3,-3',
]
// Two adjacent cells near the center of the line — the gap the player
// fills. Picked so the pair piece sits centered visually rather than
// at an end.
const TUTORIAL_STAGE_1_TARGET_CELLS: CellId[] = ['0,0', '1,-1']

const TUTORIAL_PAIR_SHAPE: PieceShape = {
  id: 'shape-tutorial-pair',
  // Two cells offset along (1, -1) — the same axis as the chosen
  // diagonal line, so dropping anchored at (0,0) covers (0,0) and
  // (1,-1).
  cells: [
    { q: 0, r: 0 },
    { q: 1, r: -1 },
  ],
  size: 2,
}

const TUTORIAL_SINGLET_SHAPE: PieceShape = {
  id: 'shape-tutorial-singlet',
  cells: [{ q: 0, r: 0 }],
  size: 1,
}

const baseTutorialState = (): GameState => ({
  mode: 'endless',
  board: createEmptyBoard('endless'),
  score: 0,
  streak: 0,
  hand: [],
  handSlots: [null, null, null],
  hold: null,
  gameOver: false,
  moves: 0,
  dailyHits: {},
  dailyTotalHits: 0,
  dailyRemainingHits: 0,
  dailyCompleted: false,
  goldenCellIds: [],
})

export const TUTORIAL_STAGE_1_TARGET_CELL_IDS: readonly CellId[] =
  TUTORIAL_STAGE_1_TARGET_CELLS
export const TUTORIAL_STAGE_2_TARGET_CELL_ID: CellId = '0,0'

// The 3 primary-direction lines that all pass through (0,0). Each is
// the full length-7 maximal scoring line in its direction.
const STAGE_2_CROSS_LINE_CELLS: CellId[][] = [
  // r = 0
  ['-3,0', '-2,0', '-1,0', '0,0', '1,0', '2,0', '3,0'],
  // q = 0
  ['0,-3', '0,-2', '0,-1', '0,0', '0,1', '0,2', '0,3'],
  // q + r = 0 (same axis as stage 1 — re-used here so the cross is
  // perfectly symmetric through center)
  ['-3,3', '-2,2', '-1,1', '0,0', '1,-1', '2,-2', '3,-3'],
]

// Cells of the central rosette around (0,0).
const STAGE_2_CENTRAL_ROSETTE_CELLS: CellId[] = [
  '0,0',
  '1,0',
  '0,1',
  '-1,1',
  '-1,0',
  '0,-1',
  '1,-1',
]

export const createTutorialStage1State = (): GameState => {
  const state = baseTutorialState()
  const targetSet = new Set(TUTORIAL_STAGE_1_TARGET_CELLS)
  for (const cellId of TUTORIAL_STAGE_1_LINE_CELLS) {
    if (targetSet.has(cellId)) continue
    state.board[cellId] = 'filled'
  }
  const piece: ActivePiece = {
    id: 'tutorial-pair-1',
    shape: TUTORIAL_PAIR_SHAPE,
  }
  state.hand = [piece]
  state.handSlots = [piece.id, null, null]
  return state
}

export const createTutorialStage2State = (): GameState => {
  const state = baseTutorialState()
  const targetCell = TUTORIAL_STAGE_2_TARGET_CELL_ID

  // Fill the "asterisk": the 3 cross lines through (0,0) plus the
  // central rosette, every cell except the target.
  const corePrefill = new Set<CellId>()
  for (const line of STAGE_2_CROSS_LINE_CELLS) {
    for (const cellId of line) corePrefill.add(cellId)
  }
  for (const cellId of STAGE_2_CENTRAL_ROSETTE_CELLS) {
    corePrefill.add(cellId)
  }
  corePrefill.delete(targetCell)
  for (const cellId of corePrefill) {
    state.board[cellId] = 'filled'
  }

  // Greedy "make the board look mostly full" pass: visit every other
  // cell and fill it only if doing so doesn't complete any scoring
  // pattern. This keeps the only legal clear gated on placing the
  // singlet at (0,0). Iteration order is deterministic so the same
  // visual lands every time.
  const boardDef = getBoardDefinitionForMode('endless')
  for (const cell of boardDef.cells) {
    if (cell.id === targetCell) continue
    if (state.board[cell.id] === 'filled') continue
    state.board[cell.id] = 'filled'
    const { clearedPatterns } = findClears(state.board, 'endless')
    if (clearedPatterns.length > 0) {
      state.board[cell.id] = 'empty'
    }
  }

  const piece: ActivePiece = {
    id: 'tutorial-singlet-1',
    shape: TUTORIAL_SINGLET_SHAPE,
  }
  state.hand = [piece]
  state.handSlots = [piece.id, null, null]
  return state
}
