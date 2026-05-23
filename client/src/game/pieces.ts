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

// --- Piecetiary: every spawnable rotation variant -------------------
//
// `dealHand` rotates each canonical shape by a random 0..5 step before
// dealing, so the player actually encounters between 1 and 6 distinct
// rotations of every canonical piece. The Piecetiary in the help
// screen enumerates *those rotations*, not just the canonical bases,
// so the reference matches what shows up in play.
//
// Each variant is labelled with a hex-axis bounding-box notation
// "q×r×s" — the span of the cells along the three axial axes
// (q = E/W, r = SE/NW, s = -q-r = SW/NE). It's a compact, geometry-
// flavoured fingerprint: the singlet is 1×1×1, a flat 2-line is
// 2×1×2, a Y-tee is 2×3×3, etc. When multiple distinct shapes share a
// bounding box (e.g. the two triangle orientations are both 2×2×2),
// a lowercase suffix (a/b/c…) disambiguates them. Suffixing is keyed
// off a stable canonical iteration order so labels are deterministic
// across reloads.

const rotateOnce = (c: Axial): Axial => ({ q: -c.r, r: c.q + c.r })

const normalize = (cells: Axial[]): Axial[] => {
  const minQ = Math.min(...cells.map((c) => c.q))
  const minR = Math.min(...cells.map((c) => c.r))
  return cells
    .map((c) => ({ q: c.q - minQ, r: c.r - minR }))
    .sort((a, b) => a.q - b.q || a.r - b.r)
}

const cellsKey = (cells: Axial[]): string =>
  cells.map((c) => `${c.q},${c.r}`).join(';')

export type PieceVariant = {
  /** Unique variant id, stable across reloads. */
  id: string
  /** Canonical shape this rotation belongs to. */
  shapeId: string
  /** Rotation step (0..5) applied to the canonical cells. */
  rotation: number
  /** Cells of this orientation, normalized to min q = min r = 0. */
  cells: Axial[]
  size: number
  /**
   * Bounding-box dimensions along the three hex axes (q, r, s).
   * Used to render the "q×r×s" notation label.
   */
  bbox: { q: number; r: number; s: number }
  /** "q×r×s" notation, with a disambiguating suffix when needed. */
  notation: string
}

const buildVariants = (): PieceVariant[] => {
  // Step 1: collect every unique normalized cell set across all
  // canonical shapes × 6 rotations. We dedupe so a shape with a
  // rotational symmetry (e.g. the singlet) doesn't appear 6 times.
  type PreVariant = {
    shapeId: string
    rotation: number
    cells: Axial[]
    key: string
  }
  const seen = new Set<string>()
  const collected: PreVariant[] = []
  for (const shape of ALL_PIECE_SHAPES) {
    for (let rot = 0; rot < 6; rot++) {
      let cells = shape.cells
      for (let i = 0; i < rot; i++) cells = cells.map(rotateOnce)
      const norm = normalize(cells)
      const key = cellsKey(norm)
      if (seen.has(key)) continue
      seen.add(key)
      collected.push({ shapeId: shape.id, rotation: rot, cells: norm, key })
    }
  }

  // Step 2: compute bounding-box dimensions along the three hex axes
  // for each variant. q-span and r-span come straight from the
  // axial coords; s-span is over s = -q - r.
  const measured = collected.map((v) => {
    const qs = v.cells.map((c) => c.q)
    const rs = v.cells.map((c) => c.r)
    const ss = v.cells.map((c) => -c.q - c.r)
    const bbox = {
      q: Math.max(...qs) - Math.min(...qs) + 1,
      r: Math.max(...rs) - Math.min(...rs) + 1,
      s: Math.max(...ss) - Math.min(...ss) + 1,
    }
    return { ...v, bbox }
  })

  // Step 3: build notation labels. Variants that share their bbox
  // tuple get a lowercase suffix (a, b, c…) in canonical order so
  // each label is unique without losing the bounding-box reading.
  const dimKey = (b: { q: number; r: number; s: number }) =>
    `${b.q}x${b.r}x${b.s}`
  const buckets = new Map<string, number>()
  for (const v of measured) {
    const k = dimKey(v.bbox)
    buckets.set(k, (buckets.get(k) ?? 0) + 1)
  }
  const seenInBucket = new Map<string, number>()
  const result: PieceVariant[] = measured.map((v) => {
    const base = `${v.bbox.q}×${v.bbox.r}×${v.bbox.s}`
    const k = dimKey(v.bbox)
    const total = buckets.get(k) ?? 1
    let notation = base
    if (total > 1) {
      const idx = seenInBucket.get(k) ?? 0
      seenInBucket.set(k, idx + 1)
      notation = `${base}${String.fromCharCode(97 + idx)}`
    }
    return {
      id: `${v.shapeId}-r${v.rotation}`,
      shapeId: v.shapeId,
      rotation: v.rotation,
      cells: v.cells,
      size: v.cells.length,
      bbox: v.bbox,
      notation,
    }
  })

  return result
}

export const ALL_PIECE_VARIANTS: PieceVariant[] = buildVariants()

/**
 * Human nicknames for each rotation variant, indexed by variant id.
 *
 * The piecetiary shows these in quotes below the q×r×s notation so
 * players can refer to a specific orientation by a memorable name
 * instead of "the second 3×2×3" — a player can shout "the Layla!"
 * across the room and the other player can look it up here.
 *
 * Names are intentionally drawn from a broad set of cultural and
 * linguistic backgrounds and a mix of genders. They have no semantic
 * relationship to the shape they label — they're just sticky, easy
 * to say, and individually distinctive. The mapping is keyed by the
 * deterministic variant id `buildVariants` emits, so it stays stable
 * across reloads.
 *
 * If `buildVariants` ever changes (canonical shape order or rotation
 * dedup logic), update the keys here to match. There are exactly 44
 * variants today (1 singlet + 3 pair + 2 triangle + 6 wedge + 3 trio
 * + 3 rhombus + 6 tee + 2 pinwheel + 6 hook + 6 zigzag + 3 comma + 3
 * bar) and exactly 44 names below.
 */
export const PIECE_VARIANT_NAMES: Record<string, string> = {
  // 1-cube — singlet
  'shape-1-0-r0': 'Bea',
  // 2-cube — pair
  'shape-2-1-r0': 'Kai',
  'shape-2-1-r1': 'Amara',
  'shape-2-1-r2': 'Yusuf',
  // 3-cube — triangle
  'shape-3-2-r0': 'Wei',
  'shape-3-2-r1': 'Nokomis',
  // 3-cube — wedge
  'shape-3-3-r0': 'Aoife',
  'shape-3-3-r1': 'Kwame',
  'shape-3-3-r2': 'Saoirse',
  'shape-3-3-r3': 'Ravi',
  'shape-3-3-r4': 'Imani',
  'shape-3-3-r5': 'Mateo',
  // 3-cube — trio (3-in-a-line)
  'shape-3-4-r0': 'Noor',
  'shape-3-4-r1': 'Diego',
  'shape-3-4-r2': 'Yumiko',
  // 4-cube — rhombus
  'shape-4-5-r0': 'Tariq',
  'shape-4-5-r1': 'Camila',
  'shape-4-5-r2': 'Henrik',
  // 4-cube — tee
  'shape-4-6-r0': 'Priya',
  'shape-4-6-r1': 'Sefu',
  'shape-4-6-r2': 'Eliška',
  'shape-4-6-r3': 'Cormac',
  'shape-4-6-r4': 'Layla',
  'shape-4-6-r5': 'Bashir',
  // 4-cube — pinwheel
  'shape-4-7-r0': 'Sora',
  'shape-4-7-r1': 'Aiyana',
  // 4-cube — hook
  'shape-4-8-r0': 'Rashid',
  'shape-4-8-r1': 'Nia',
  'shape-4-8-r2': 'Pavel',
  'shape-4-8-r3': 'Tala',
  'shape-4-8-r4': 'Omar',
  'shape-4-8-r5': 'Mei',
  // 4-cube — zigzag
  'shape-4-9-r0': 'Inés',
  'shape-4-9-r1': 'Sékou',
  'shape-4-9-r2': 'Anya',
  'shape-4-9-r3': 'Tendai',
  'shape-4-9-r4': 'Kainoa',
  'shape-4-9-r5': 'Sigrid',
  // 4-cube — comma
  'shape-4-10-r0': 'Devi',
  'shape-4-10-r1': 'Chinedu',
  'shape-4-10-r2': 'Folake',
  // 4-cube — bar (4-in-a-line)
  'shape-4-11-r0': 'Vikram',
  'shape-4-11-r1': 'Inara',
  'shape-4-11-r2': 'Manaia',
}


