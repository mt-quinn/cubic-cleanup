import type { Axial, BoardDefinition, Pattern } from './hexTypes'
import { axialToId, addAxial, directions } from './hexTypes'

// Seven flowers of seven hexes each:
// - One central flower at (0,0)
// - Six surrounding flowers, each:
//   - has no overlapping cells with any other flower
//   - touches the central flower along three hex faces
//   - touches its two neighboring outer flowers along three hex faces each
const flowerCenters: Axial[] = [
  { q: 0, r: 0 },   // center
  { q: -3, r: 1 },
  { q: -2, r: 3 },
  { q: -1, r: -2 },
  { q: 1, r: 2 },
  { q: 2, r: -3 },
  { q: 3, r: -1 },
]

const buildBoard = (): BoardDefinition => {
  const cellMap = new Map<string, Axial>()

  const addCell = (coord: Axial) => {
    const id = axialToId(coord)
    if (!cellMap.has(id)) {
      cellMap.set(id, coord)
    }
  }

  // Build cells as union of 7 radius-1 flowers around the chosen centers
  for (const center of flowerCenters) {
    addCell(center)
    for (const dir of directions) {
      addCell(addAxial(center, dir))
    }
  }

  const cells = Array.from(cellMap.entries()).map(([id, coord]) => ({
    id,
    coord,
  }))

  // Build flower patterns
  const patterns: Pattern[] = []
  const flowerIds: string[] = []

  flowerCenters.forEach((center, index) => {
    const centerId = axialToId(center)
    const petalIds = directions.map((dir) => {
      const c = addAxial(center, dir)
      return axialToId(c)
    })
    const cellIds = [centerId, ...petalIds].filter((id) => cellMap.has(id))
    if (cellIds.length === 7) {
      const id = `flower-${index}`
      flowerIds.push(id)
      patterns.push({
        id,
        type: 'flower',
        cellIds,
      })
    }
  })

  // Build straight-line patterns in three primary directions
  const cellSet = new Set(cellMap.keys())

  const getNeighbor = (id: string, dir: Axial): string | null => {
    const [qStr, rStr] = id.split(',')
    const q = Number(qStr)
    const r = Number(rStr)
    const nextId: string = axialToId({ q: q + dir.q, r: r + dir.r })
    return cellSet.has(nextId) ? nextId : null
  }

  const seenLines = new Set<string>()
  const scoringLineIds: string[] = []

  const primaryDirs = directions.slice(0, 3)

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
          const id = `line-${patterns.length}`
          const isScoring = lineIds.length === 7
          if (isScoring) {
            scoringLineIds.push(id)
          }
          patterns.push({
            id,
            type: 'line',
            cellIds: lineIds,
          })
        }
      }
    }
  }

  return {
    cells,
    patterns,
    scoringLineIds,
    flowerIds,
  }
}

export const BOARD_DEFINITION: BoardDefinition = buildBoard()


