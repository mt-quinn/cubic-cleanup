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

function axialEq(a, b) {
  return a.q === b.q && a.r === b.r
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
for (let q = -6; q <= 6; q++) {
  for (let r = -6; r <= 6; r++) {
    if (q === 0 && r === 0) continue
    const c = { q, r }
    const f = flowerCells(c)
    if (intersectCount(centerFlower, f) !== 0) continue
    const adj = adjacencyCount(centerFlower, f)
    if (adj === 6) continue // probably too close
    if (adj === 3) {
      candidates.push({ center: c, adj })
    }
  }
}

console.log('Candidates with adjacency 3 to center and no overlap:', candidates)
