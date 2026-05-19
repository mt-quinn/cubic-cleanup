import type { Axial, BoardDefinition, Pattern } from './hexTypes'
import { axialToId, directions } from './hexTypes'

// Cubekill boards are always built as a "flower of flowers": one central
// hex flower of radius `flowerRadius`, plus six outer flowers of the same
// radius, arranged so that adjacent flowers touch but never share cells.
// Two non-overlapping radius-r hex regions can sit at axial distance
// 2r + 1 from each other; we put the outer centers at exactly that
// distance from the origin so the boundaries kiss without overlap.
//
// Standard board: radius 1, 7-cell rosettes, 49 cells total.
// Big board:      radius 2, 19-cell rosettes, 133 cells total.
//
// The two center arrays below are hand-picked to share the same visual
// tilt — outer rosettes sit at "two-and-a-half-hex" diagonals from the
// central rosette in both layouts. The standard set is preserved
// verbatim from the original board so existing save-states keep working.

const STANDARD_FLOWER_CENTERS: Axial[] = [
  { q: 0, r: 0 },
  { q: 1, r: 2 },
  { q: -2, r: 3 },
  { q: -3, r: 1 },
  { q: -1, r: -2 },
  { q: 2, r: -3 },
  { q: 3, r: -1 },
]

// Distance-5 seed vector (5, -2) and its five 60° rotations, plus the
// origin. Picked to mirror the standard board's tilt — the outer six
// sit at the same angular positions as the standard board's outer six,
// just farther out so the bigger rosettes don't overlap.
const BIG_FLOWER_CENTERS: Axial[] = [
  { q: 0, r: 0 },
  { q: 5, r: -2 },
  { q: 2, r: 3 },
  { q: -3, r: 5 },
  { q: -5, r: 2 },
  { q: -2, r: -3 },
  { q: 3, r: -5 },
]

const axialDistance = (a: Axial, b: Axial): number => {
  const dq = a.q - b.q
  const dr = a.r - b.r
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2
}

// Shared list of cells inside the radius-r hex region around a center.
// Used by board geometry, but also by App.tsx-side render helpers that
// iterate over the cells of a single rosette (boundary segments,
// etched-groove loops, etc.).
export const cellsInRosette = (
  center: Axial,
  flowerRadius: number,
): Axial[] => {
  const out: Axial[] = []
  for (let dq = -flowerRadius; dq <= flowerRadius; dq++) {
    const drMin = Math.max(-flowerRadius, -dq - flowerRadius)
    const drMax = Math.min(flowerRadius, -dq + flowerRadius)
    for (let dr = drMin; dr <= drMax; dr++) {
      out.push({ q: center.q + dq, r: center.r + dr })
    }
  }
  return out
}

export type BuildBoardOptions = {
  flowerRadius: number
  flowerCenters: Axial[]
}

export const buildBoardDefinition = ({
  flowerRadius,
  flowerCenters,
}: BuildBoardOptions): BoardDefinition => {
  const cellMap = new Map<string, Axial>()

  const addCell = (coord: Axial) => {
    const id = axialToId(coord)
    if (!cellMap.has(id)) {
      cellMap.set(id, coord)
    }
  }

  // Cells = union of every flower's hex region. Centers are placed so
  // regions kiss without overlapping, so the union has
  // 7 * (1 + 3r(r + 1)) cells (49 for r=1, 133 for r=2).
  for (const center of flowerCenters) {
    for (const coord of cellsInRosette(center, flowerRadius)) {
      addCell(coord)
    }
  }

  const cells = Array.from(cellMap.entries()).map(([id, coord]) => ({
    id,
    coord,
  }))

  const patterns: Pattern[] = []
  const flowerIds: string[] = []

  // Each flower is one scoring pattern. cellIds[0] is the flower center
  // (the daily numbered-cube logic and clearing animations rely on
  // that ordering); the rest are sorted by axial distance from the
  // center for stability.
  flowerCenters.forEach((center, index) => {
    const region = cellsInRosette(center, flowerRadius)
    region.sort((a, b) => axialDistance(a, center) - axialDistance(b, center))
    const cellIds = region.map((coord) => axialToId(coord))
    if (cellIds.every((id) => cellMap.has(id))) {
      const id = `flower-${index}`
      flowerIds.push(id)
      patterns.push({
        id,
        type: 'flower',
        cellIds,
      })
    }
  })

  // Build straight-line patterns in three primary axial directions.
  const cellSet = new Set(cellMap.keys())

  const getNeighbor = (id: string, dir: Axial): string | null => {
    const [qStr, rStr] = id.split(',')
    const q = Number(qStr)
    const r = Number(rStr)
    const nextId: string = axialToId({ q: q + dir.q, r: r + dir.r })
    return cellSet.has(nextId) ? nextId : null
  }

  const seenLines = new Set<string>()
  const primaryDirs = directions.slice(0, 3)
  let maxLineLength = 0

  for (const startId of cellSet) {
    for (const dir of primaryDirs) {
      const prevId = getNeighbor(startId, { q: -dir.q, r: -dir.r })
      if (prevId) continue

      const lineIds: string[] = [startId]
      let currentId: string | null = startId
      while (true) {
        const neighborId: string | null = currentId
          ? getNeighbor(currentId, dir)
          : null
        if (!neighborId) break
        lineIds.push(neighborId)
        currentId = neighborId
      }

      if (lineIds.length >= 2) {
        const key = lineIds.join('|')
        if (!seenLines.has(key)) {
          seenLines.add(key)
          patterns.push({
            id: `line-${patterns.length}`,
            type: 'line',
            cellIds: lineIds,
          })
          if (lineIds.length > maxLineLength) {
            maxLineLength = lineIds.length
          }
        }
      }
    }
  }

  // Second pass: pick scoring lines. Every emitted line is already the
  // full extent of its own parallel track (the generator only starts at
  // cells with no predecessor in the direction), so each line is "as
  // long as it can be" for that track. We then filter to tracks whose
  // length is within `flowerRadius` of the global maximum.
  //
  // Why the tolerance? On a flower-of-flowers shape, tracks that miss
  // the central rosette by one ring fall short by exactly one ruby per
  // ring of bypassed flowers — i.e. up to `flowerRadius` cells. Those
  // tracks still visually span the board side-to-side, so a player
  // filling them legitimately expects a line clear.
  //
  //   Standard board (r=1): max=7, threshold=7  → 15 length-7 lines.
  //                         Length-5 / length-2 are short edge tracks
  //                         that never cross center, kept out.
  //   Big board (r=2):      max=12, threshold=11 → 12 length-12 + 15
  //                         length-11 lines. Without this tolerance the
  //                         15 length-11 tracks were silently un-
  //                         clearable, even though they look identical
  //                         to length-12 lines on the big board.
  const scoringLineIds: string[] = []
  const minScoringLineLength = Math.max(1, maxLineLength - flowerRadius + 1)
  for (const pattern of patterns) {
    if (
      pattern.type === 'line' &&
      pattern.cellIds.length >= minScoringLineLength
    ) {
      scoringLineIds.push(pattern.id)
    }
  }

  return {
    cells,
    patterns,
    scoringLineIds,
    flowerIds,
  }
}

export const STANDARD_BOARD_DEFINITION: BoardDefinition = buildBoardDefinition({
  flowerRadius: 1,
  flowerCenters: STANDARD_FLOWER_CENTERS,
})

export const BIG_BOARD_DEFINITION: BoardDefinition = buildBoardDefinition({
  flowerRadius: 2,
  flowerCenters: BIG_FLOWER_CENTERS,
})

// Backward-compat alias. Existing imports of `BOARD_DEFINITION` keep
// working unchanged and resolve to the standard 49-cell layout.
export const BOARD_DEFINITION = STANDARD_BOARD_DEFINITION

export type GameModeId = 'endless' | 'daily' | 'big'

export const getBoardDefinitionForMode = (
  mode: GameModeId,
): BoardDefinition =>
  mode === 'big' ? BIG_BOARD_DEFINITION : STANDARD_BOARD_DEFINITION

// Per-board parameters callers commonly need together with the
// definition: the radius of each flower and the canonical list of flower
// centers (in the same order as `flowerIds`). Surfaced here so render
// helpers can iterate rosettes without re-deriving them from cellIds.
export type BoardGeometry = {
  flowerRadius: number
  flowerCenters: Axial[]
}

export const getBoardGeometryForMode = (mode: GameModeId): BoardGeometry =>
  mode === 'big'
    ? { flowerRadius: 2, flowerCenters: BIG_FLOWER_CENTERS }
    : { flowerRadius: 1, flowerCenters: STANDARD_FLOWER_CENTERS }
