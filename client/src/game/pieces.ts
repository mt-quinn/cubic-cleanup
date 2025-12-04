import type { Axial } from './hexTypes'

export type PieceShape = {
  id: string
  cells: Axial[]
  size: number
}

const directions: Axial[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]

const transformVariants = (cells: Axial[]): Axial[][] => {
  const result: Axial[][] = []

  const rotate = (c: Axial, times: number): Axial => {
    let { q, r } = c
    for (let i = 0; i < times; i++) {
      const newQ = -r
      const newR = q + r
      q = newQ
      r = newR
    }
    return { q, r }
  }

  const reflect = (c: Axial): Axial => ({ q: -c.q, r: c.r + c.q })

  const normalize = (shape: Axial[]): Axial[] => {
    const minQ = Math.min(...shape.map((c) => c.q))
    const minR = Math.min(...shape.map((c) => c.r))
    return shape
      .map((c) => ({ q: c.q - minQ, r: c.r - minR }))
      .sort((a, b) => (a.q - b.q) || (a.r - b.r))
  }

  const base = cells

  for (let rot = 0; rot < 6; rot++) {
    const rotated = base.map((c) => rotate(c, rot))
    result.push(normalize(rotated))
    const reflected = rotated.map(reflect)
    result.push(normalize(reflected))
  }

  return result
}

const canonicalKey = (cells: Axial[]): string => {
  const variants = transformVariants(cells)
  const variantStrings = variants.map((v) =>
    v.map((c) => `${c.q},${c.r}`).join(';'),
  )
  return variantStrings.sort()[0]
}

const generateShapes = (): PieceShape[] => {
  const shapes = new Map<string, Axial[]>()

  const addShape = (cells: Axial[]) => {
    const key = canonicalKey(cells)
    if (!shapes.has(key)) {
      shapes.set(key, cells)
    }
  }

  const start: Axial[] = [{ q: 0, r: 0 }]
  addShape(start)

  const expand = (current: Axial[]): Axial[][] => {
    const result: Axial[][] = []
    const existing = new Set(current.map((c) => `${c.q},${c.r}`))
    for (const cell of current) {
      for (const dir of directions) {
        const neighbor = { q: cell.q + dir.q, r: cell.r + dir.r }
        const key = `${neighbor.q},${neighbor.r}`
        if (!existing.has(key)) {
          result.push([...current, neighbor])
        }
      }
    }
    return result
  }

  let frontier: Axial[][] = [start]
  for (let size = 2; size <= 4; size++) {
    const nextFrontier: Axial[][] = []
    for (const shape of frontier) {
      for (const grown of expand(shape)) {
        const key = canonicalKey(grown)
        if (!shapes.has(key)) {
          shapes.set(key, grown)
          nextFrontier.push(grown)
        }
      }
    }
    frontier = nextFrontier
  }

  const pieceShapes: PieceShape[] = []
  let idCounter = 0
  for (const cells of shapes.values()) {
    if (cells.length >= 1 && cells.length <= 4) {
      const size = cells.length
      pieceShapes.push({
        id: `shape-${size}-${idCounter++}`,
        cells,
        size,
      })
    }
  }

  pieceShapes.sort((a, b) => a.size - b.size)

  return pieceShapes
}

export const ALL_PIECE_SHAPES: PieceShape[] = generateShapes()


