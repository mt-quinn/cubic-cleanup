const directions = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
]

function axialAdd(a, b) {
  return { q: a.q + b.q, r: a.r + b.r }
}

function neighbors(center) {
  return directions.map((d) => axialAdd(center, d))
}

function flowerCells(center) {
  return [center, ...neighbors(center)]
}

function key(c) {
  return `${c.q},${c.r}`
}

function adjacencyCount(f1, f2) {
  const set2 = new Map()
  for (const c of f2) set2.set(key(c), c)
  let count = 0
  for (const c1 of f1) {
    for (const d of directions) {
      const n = axialAdd(c1, d)
      if (set2.has(key(n))) count++
    }
  }
  return count
}

function intersectCount(f1, f2) {
  const set2 = new Set(f2.map(key))
  let count = 0
  for (const c of f1) if (set2.has(key(c))) count++
  return count
}

const center = { q: 0, r: 0 }
const centerFlower = flowerCells(center)

const candidates = []
for (let q = -5; q <= 5; q++) {
  for (let r = -5; r <= 5; r++) {
    if (q === 0 && r === 0) continue
    const c = { q, r }
    const f = flowerCells(c)
    if (intersectCount(centerFlower, f) !== 0) continue
    const adj = adjacencyCount(centerFlower, f)
    if (adj === 3) {
      candidates.push({ center: c, cells: f })
    }
  }
}

console.log('Found', candidates.length, 'candidates to center')

// Now search for 6 distinct outer centers that each:
// - touch center with adjacency 3
// - form a ring where each outer has adjacency 3 with its two neighbors

function adjBetween(a, b) {
  return adjacencyCount(a.cells, b.cells)
}

// brute-force combinations of 6 from candidates (12 choose 6 = 924)
function* combos(arr, k, start = 0, prefix = []) {
  if (prefix.length === k) {
    yield prefix
    return
  }
  for (let i = start; i < arr.length; i++) {
    prefix.push(arr[i])
    yield* combos(arr, k, i + 1, prefix)
    prefix.pop()
  }
}

let found = 0
for (const combo of combos(candidates, 6)) {
  // build adjacency graph between these 6 outer centers
  const adjMatrix = combo.map(() => combo.map(() => 0))
  for (let i = 0; i < combo.length; i++) {
    for (let j = i + 1; j < combo.length; j++) {
      const a = combo[i]
      const b = combo[j]
      const adj = adjBetween(a, b)
      adjMatrix[i][j] = adjMatrix[j][i] = adj
    }
  }

  // count neighbors with adjacency 3 for each outer
  const neighborCounts = adjMatrix.map((row) =>
    row.reduce((acc, v) => acc + (v === 3 ? 1 : 0), 0),
  )

  if (neighborCounts.every((c) => c === 2)) {
    console.log('Valid ring found:')
    console.log(combo.map((c) => c.center))
    found++
    break
  }
}

if (!found) {
  console.log('No valid ring found')
}
