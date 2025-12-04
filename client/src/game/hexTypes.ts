export type Axial = {
  q: number
  r: number
}

export type CellId = string

export type Cell = {
  id: CellId
  coord: Axial
}

export type PatternType = 'line' | 'flower'

export type Pattern = {
  id: string
  type: PatternType
  cellIds: CellId[]
}

export type BoardDefinition = {
  cells: Cell[]
  patterns: Pattern[]
  scoringLineIds: string[]
  flowerIds: string[]
}

export const axialToId = (coord: Axial): CellId => `${coord.q},${coord.r}`

export const directions: Axial[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]

export const addAxial = (a: Axial, b: Axial): Axial => ({
  q: a.q + b.q,
  r: a.r + b.r,
})


