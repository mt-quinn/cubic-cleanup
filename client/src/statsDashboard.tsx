// Focus-driven stats dashboard.
//
// Replaces the old four-section "wall of label/value rows" profile
// modal. The core idea: different players want completely different
// things from their stats, so the screen reframes around a chosen
// FOCUS (Overall / Endless / Daily / PvP / Co-op). Each focus leads
// with a few large, tightly-labelled headline numbers + one signature
// visual; the inside-baseball detail lives in a collapsed drawer.
//
// Players can pin/swap the headline stats per focus, and both the
// last focus and the pins persist locally (loadDashboardPrefs /
// saveDashboardPrefs in stats.ts). On a brand-new profile the focus
// auto-selects to whatever mode the player has touched most.
//
// All values derive from data we already keep — lifetime aggregates,
// per-piece stats, the endless high-score list, daily clear sets, and
// the recent-runs ring buffer (the only new store, used for the
// trajectory sparklines). No fabricated numbers.

import { useMemo, useState } from 'react'

import type { LifetimeStats, RecentRun, DashboardFocus } from './stats'
import { formatDuration, loadDashboardPrefs, saveDashboardPrefs } from './stats'
import type { PieceStatsMap } from './pieceStats'

type ScoreEntry = { score: number; date: number }

type StatsDashboardProps = {
  lifetimeStats: LifetimeStats
  pieceStats: PieceStatsMap
  highScores: ScoreEntry[]
  recentRuns: RecentRun[]
  onBack: () => void
  onOpenDailyHistory?: () => void
  playUiClick?: () => void
}

// ------------------------------------------------------------------
// Formatting + small math helpers
// ------------------------------------------------------------------
const fmtInt = (n: number): string => Math.round(n).toLocaleString()
const fmtPct = (x: number): string => `${Math.round(x * 100)}%`
const clamp = (n: number, lo = 5, hi = 100): number =>
  Math.max(lo, Math.min(hi, n))
const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0

// Longest + current run of consecutive cleared calendar days, derived
// from the `YYYY-M-D` date keys. Uses a UTC day index so DST can't
// nudge a day across a boundary.
const dayIndexFromKey = (key: string): number | null => {
  const parts = key.split('-').map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
  return Math.round(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000)
}
const computeStreaks = (
  clearedKeys: string[],
): { current: number; best: number } => {
  const idx = clearedKeys
    .map(dayIndexFromKey)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b)
  if (idx.length === 0) return { current: 0, best: 0 }
  let best = 1
  let run = 1
  for (let i = 1; i < idx.length; i++) {
    if (idx[i] === idx[i - 1]) continue
    run = idx[i] === idx[i - 1] + 1 ? run + 1 : 1
    if (run > best) best = run
  }
  const today = Math.round(Date.now() / 86400000)
  const last = idx[idx.length - 1]
  let current = 0
  if (last === today || last === today - 1) {
    current = 1
    for (let i = idx.length - 1; i > 0; i--) {
      if (idx[i] === idx[i - 1] + 1) current++
      else if (idx[i] !== idx[i - 1]) break
    }
  }
  return { current, best }
}

type Derived = {
  totalGames: number
  stat: Record<string, { label: string; value: string; ok: boolean }>
  radar: { label: string; value: number }[]
  archetype: string
  endlessSeries: number[]
  coopSeries: number[]
  clearedSet: Set<string>
  playedSet: Set<string>
  pvpWins: number
  pvpLosses: number
}

const computeDerived = (
  ls: LifetimeStats,
  pieceStats: PieceStatsMap,
  highScores: ScoreEntry[],
  recentRuns: RecentRun[],
): Derived => {
  const totalGames =
    ls.gamesPlayedEndless +
    ls.gamesPlayedDaily +
    ls.gamesPlayedCoop +
    ls.gamesPlayedPvp
  const avgScore = ls.scoredGamesPlayed > 0 ? ls.totalScore / ls.scoredGamesPlayed : 0
  const avgRunMs = totalGames > 0 ? ls.totalActivePlayMs / totalGames : 0
  const clearRate = ls.piecesPlaced > 0 ? ls.patternsCleared / ls.piecesPlaced : 0
  const pointsPerPiece = ls.piecesPlaced > 0 ? ls.totalScore / ls.piecesPlaced : 0
  const pacePerMin =
    ls.totalActivePlayMs > 0 ? ls.piecesPlaced / (ls.totalActivePlayMs / 60000) : 0
  const boardClearRate = ls.scoredGamesPlayed > 0 ? ls.boardClears / ls.scoredGamesPlayed : 0
  const rubyRate = ls.piecesPlaced > 0 ? ls.rubiesCleared / ls.piecesPlaced : 0

  let combos = 0
  let clears = 0
  for (const v of Object.values(pieceStats)) {
    combos += v.combosJoined
    clears += v.clearsCaused
  }
  const comboRate = clears > 0 ? combos / clears : 0

  // A day counts as "cleared" if it's in the local cleared set OR has a
  // synced per-day best-moves entry — the latter is the cross-device
  // source of truth (the daily-history calendar leans on it the same
  // way), so clears earned on another signed-in device still show up.
  const clearedKeys = new Set<string>([
    ...ls.dailyDaysCleared,
    ...Object.keys(ls.dailyBestMovesByDate),
  ])
  const playedKeys = new Set<string>([...ls.dailyDaysPlayed, ...clearedKeys])
  const dailyClearPct =
    playedKeys.size > 0 ? clearedKeys.size / playedKeys.size : 0
  const streaks = computeStreaks(Array.from(clearedKeys))
  const pvpWinPct = ls.gamesPlayedPvp > 0 ? ls.pvpWins / ls.gamesPlayedPvp : 0

  const endlessRuns = recentRuns.filter((r) => r.mode === 'endless')
  const coopRuns = recentRuns.filter((r) => r.mode === 'coop')
  const avgEndless = endlessRuns.length
    ? mean(endlessRuns.map((r) => r.score))
    : avgScore
  const avgCoop = coopRuns.length ? mean(coopRuns.map((r) => r.score)) : avgScore

  // Endless trajectory: per-run scores if we have a couple, else fall
  // back to the high-score list (PBs over time) so existing players
  // still see a line before the ring buffer fills.
  let endlessSeries = endlessRuns.map((r) => r.score)
  if (endlessSeries.length < 2) {
    endlessSeries = [...highScores]
      .sort((a, b) => a.date - b.date)
      .map((e) => e.score)
  }
  const coopSeries = coopRuns.map((r) => r.score)

  const radar = [
    { label: 'Aggression', value: clamp(comboRate * 260) },
    { label: 'Combos', value: clamp(ls.bestCombo * 14) },
    { label: 'Efficiency', value: clamp(clearRate * 210) },
    { label: 'Endurance', value: clamp((avgRunMs / (15 * 60000)) * 100) },
    { label: 'Clutch', value: clamp(ls.bestSinglePlacement / 12) },
    {
      label: 'Consistency',
      value: clamp(
        ls.dailyDaysPlayed.length > 0 ? dailyClearPct * 100 : clearRate * 160,
      ),
    },
  ]
  const ARCH = [
    'Blitzer',
    'Combo Architect',
    'Efficient Mind',
    'Marathoner',
    'Closer',
    'Steady Hand',
  ]
  let topI = 0
  for (let i = 1; i < radar.length; i++) if (radar[i].value > radar[topI].value) topI = i

  const stat: Derived['stat'] = {
    'total-time': { label: 'Total time', value: formatDuration(ls.totalActivePlayMs), ok: ls.totalActivePlayMs > 0 },
    'score-game': { label: 'Score / game', value: fmtInt(avgScore), ok: ls.scoredGamesPlayed > 0 },
    'avg-endless': { label: 'Avg score', value: fmtInt(avgEndless), ok: ls.gamesPlayedEndless > 0 },
    'avg-coop': { label: 'Avg score', value: fmtInt(avgCoop), ok: ls.gamesPlayedCoop > 0 },
    games: { label: 'Games', value: fmtInt(totalGames), ok: true },
    'endless-games': { label: 'Runs', value: fmtInt(ls.gamesPlayedEndless), ok: ls.gamesPlayedEndless > 0 },
    'coop-games': { label: 'Co-op runs', value: fmtInt(ls.gamesPlayedCoop), ok: ls.gamesPlayedCoop > 0 },
    'pvp-games': { label: 'Matches', value: fmtInt(ls.gamesPlayedPvp), ok: ls.gamesPlayedPvp > 0 },
    'total-score': { label: 'Total score', value: fmtInt(ls.totalScore), ok: ls.totalScore > 0 },
    'best-score': { label: 'Best score', value: fmtInt(ls.bestEndlessScore), ok: ls.bestEndlessScore > 0 },
    'best-daily': { label: 'Best daily', value: ls.bestDailyMoves !== null ? `${ls.bestDailyMoves}` : '—', ok: ls.bestDailyMoves !== null },
    'day-streak': { label: 'Day streak', value: `${streaks.current}`, ok: clearedKeys.size > 0 },
    'best-streak': { label: 'Best streak', value: `${streaks.best}`, ok: clearedKeys.size > 0 },
    'days-cleared': { label: 'Days cleared', value: fmtInt(clearedKeys.size), ok: clearedKeys.size > 0 },
    'daily-clear': { label: 'Daily clear', value: fmtPct(dailyClearPct), ok: playedKeys.size > 0 },
    'pvp-win': { label: 'Win rate', value: fmtPct(pvpWinPct), ok: ls.gamesPlayedPvp > 0 },
    'pvp-wins': { label: 'Wins', value: fmtInt(ls.pvpWins), ok: ls.gamesPlayedPvp > 0 },
    clears: { label: 'Clears', value: fmtInt(ls.patternsCleared), ok: ls.patternsCleared > 0 },
    rubies: { label: 'Rubies', value: fmtInt(ls.rubiesCleared), ok: ls.rubiesCleared > 0 },
    'board-clears': { label: 'Board clears', value: fmtInt(ls.boardClears), ok: ls.boardClears > 0 },
    partners: { label: 'Partners', value: fmtInt(ls.coopPartnerIds.length), ok: ls.coopPartnerIds.length > 0 },
    pieces: { label: 'Pieces', value: fmtInt(ls.piecesPlaced), ok: ls.piecesPlaced > 0 },
    'best-combo': { label: 'Best combo', value: `×${ls.bestCombo}`, ok: ls.bestCombo >= 2 },
    'longest-run': { label: 'Longest run', value: formatDuration(ls.longestRunMs), ok: ls.longestRunMs > 0 },
    'clear-rate': { label: 'Clear rate', value: fmtPct(clearRate), ok: ls.piecesPlaced > 0 },
    'points-piece': { label: 'Points / piece', value: fmtInt(pointsPerPiece), ok: ls.piecesPlaced > 0 },
    pace: { label: 'Pace', value: `${Math.round(pacePerMin)} / min`, ok: pacePerMin > 0 },
    'combo-rate': { label: 'Combo rate', value: fmtPct(comboRate), ok: clears > 0 },
    'ruby-rate': { label: 'Ruby rate', value: fmtPct(rubyRate), ok: ls.rubiesCleared > 0 },
    'board-rate': { label: 'Board-clear rate', value: fmtPct(boardClearRate), ok: ls.boardClears > 0 },
    'best-clear': { label: 'Best clear', value: ls.bestSinglePlacement > 0 ? `+${fmtInt(ls.bestSinglePlacement)}` : '—', ok: ls.bestSinglePlacement > 0 },
  }

  return {
    totalGames,
    stat,
    radar,
    archetype: ARCH[topI],
    endlessSeries,
    coopSeries,
    clearedSet: clearedKeys,
    playedSet: playedKeys,
    pvpWins: ls.pvpWins,
    pvpLosses: Math.max(0, ls.gamesPlayedPvp - ls.pvpWins),
  }
}

type HeroKind = 'radar' | 'endless-trend' | 'coop-trend' | 'calendar' | 'gauge'

type FocusDef = {
  label: string
  title: (d: Derived) => string
  headline: string[]
  hero: HeroKind
  heroLabel: string
  glance: string[]
  detail: { group: string; keys: string[] }[]
  palette: string[]
}

const FOCI: Record<DashboardFocus, FocusDef> = {
  overall: {
    label: 'Overall',
    title: (d) => d.archetype,
    headline: ['total-time', 'score-game'],
    hero: 'radar',
    heroLabel: 'How you play',
    glance: ['games', 'total-score', 'clears'],
    detail: [
      { group: 'Efficiency', keys: ['clear-rate', 'points-piece', 'pace'] },
      { group: 'Mastery', keys: ['combo-rate', 'board-rate', 'ruby-rate', 'best-clear'] },
    ],
    palette: ['total-time', 'score-game', 'games', 'total-score', 'clears', 'rubies', 'best-score', 'best-combo', 'day-streak', 'pvp-win'],
  },
  endless: {
    label: 'Endless',
    title: () => 'Marathoner',
    headline: ['avg-endless', 'best-score'],
    hero: 'endless-trend',
    heroLabel: 'Score · recent runs',
    glance: ['endless-games', 'clears', 'longest-run'],
    detail: [
      { group: 'Efficiency', keys: ['clear-rate', 'points-piece', 'pace'] },
      { group: 'Mastery', keys: ['combo-rate', 'board-rate', 'best-clear'] },
    ],
    palette: ['avg-endless', 'best-score', 'endless-games', 'total-score', 'clears', 'best-combo', 'best-clear', 'longest-run'],
  },
  daily: {
    label: 'Daily',
    title: () => 'Daily Devotee',
    headline: ['day-streak', 'days-cleared'],
    hero: 'calendar',
    heroLabel: 'Clears · last 16 weeks',
    glance: ['daily-clear', 'best-daily', 'best-streak'],
    detail: [
      { group: 'Efficiency', keys: ['clear-rate', 'pace'] },
      { group: 'Consistency', keys: ['days-cleared', 'daily-clear', 'best-streak'] },
    ],
    palette: ['day-streak', 'days-cleared', 'best-daily', 'daily-clear', 'best-streak'],
  },
  pvp: {
    label: 'PvP',
    title: () => 'Closer',
    headline: ['pvp-win', 'pvp-wins'],
    hero: 'gauge',
    heroLabel: 'Match record',
    glance: ['pvp-games', 'clear-rate', 'combo-rate'],
    detail: [
      { group: 'Efficiency', keys: ['clear-rate', 'pace', 'points-piece'] },
      { group: 'Mastery', keys: ['combo-rate', 'best-clear'] },
    ],
    palette: ['pvp-win', 'pvp-wins', 'pvp-games', 'best-combo', 'best-clear'],
  },
  coop: {
    label: 'Co-op',
    title: () => 'Co-op Anchor',
    headline: ['avg-coop', 'partners'],
    hero: 'coop-trend',
    heroLabel: 'Score · recent co-op',
    glance: ['coop-games', 'board-clears', 'clears'],
    detail: [
      { group: 'Efficiency', keys: ['clear-rate', 'points-piece', 'pace'] },
      { group: 'Mastery', keys: ['combo-rate', 'ruby-rate'] },
    ],
    palette: ['avg-coop', 'partners', 'coop-games', 'board-clears', 'clears', 'best-clear'],
  },
}

const RECORD_KEYS: Record<DashboardFocus, string[]> = {
  overall: ['best-score', 'best-combo', 'best-clear', 'best-daily'],
  endless: ['best-score', 'best-combo', 'best-clear', 'longest-run'],
  daily: ['best-daily', 'best-streak', 'days-cleared'],
  pvp: ['best-combo', 'best-clear', 'pvp-wins'],
  coop: ['best-clear', 'board-clears', 'partners'],
}

// Pick the focus a brand-new viewer should land on: whatever bucket
// they've played most (ties fall back to Overall).
const autoFocus = (ls: LifetimeStats): DashboardFocus => {
  const counts: [DashboardFocus, number][] = [
    ['endless', ls.gamesPlayedEndless],
    ['daily', ls.gamesPlayedDaily],
    ['pvp', ls.gamesPlayedPvp],
    ['coop', ls.gamesPlayedCoop],
  ]
  const top = counts.reduce((a, b) => (b[1] > a[1] ? b : a), counts[0])
  return top[1] > 0 ? top[0] : 'overall'
}

// ------------------------------------------------------------------
// SVG visuals — themed via var(--dash-accent) + currentColor
// ------------------------------------------------------------------
const Radar = ({ axes }: { axes: { label: string; value: number }[] }) => {
  const cx = 130
  const cy = 110
  const R = 72
  const pt = (i: number, r: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / axes.length
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]
  }
  const ring = (frac: number) =>
    axes.map((_, i) => pt(i, R * frac).join(',')).join(' ')
  const shape = axes
    .map((ax, i) => pt(i, (R * Math.max(0, Math.min(100, ax.value))) / 100).join(','))
    .join(' ')
  return (
    <svg viewBox="0 0 260 220" className="hexaclear-dash-svg" role="img" aria-label="Play-style radar">
      {[0.33, 0.66, 1].map((f) => (
        <polygon key={f} points={ring(f)} fill="none" stroke="currentColor" strokeOpacity="0.16" />
      ))}
      {axes.map((_, i) => {
        const [x, y] = pt(i, R)
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="currentColor" strokeOpacity="0.12" />
      })}
      <polygon points={shape} fill="var(--dash-accent)" fillOpacity="0.22" stroke="var(--dash-accent)" strokeWidth="2" />
      {axes.map((ax, i) => {
        const [x, y] = pt(i, R + 16)
        return (
          <text key={ax.label} x={x} y={y} fontSize="10.5" fill="currentColor" fillOpacity="0.62"
            textAnchor={x < cx - 5 ? 'end' : x > cx + 5 ? 'start' : 'middle'}
            dominantBaseline="middle">{ax.label}</text>
        )
      })}
    </svg>
  )
}

const Sparkline = ({ data }: { data: number[] }) => {
  if (data.length < 2) {
    return <p className="hexaclear-dash-empty">Play a few more runs to chart your trend.</p>
  }
  const W = 300
  const H = 96
  const pad = 6
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const x = (i: number) => pad + (i * (W - pad * 2)) / (data.length - 1)
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2)
  const line = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(data.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`
  const half = data.length >> 1
  const a = mean(data.slice(0, half))
  const b = mean(data.slice(half))
  const pct = a ? Math.round(((b - a) / Math.abs(a)) * 100) : 0
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="hexaclear-dash-spark" role="img" aria-label="Score trajectory across recent runs">
        <line x1={pad} y1={y(max)} x2={W - pad} y2={y(max)} stroke="currentColor" strokeOpacity="0.16" strokeDasharray="3 4" />
        <path d={area} fill="var(--dash-accent)" fillOpacity="0.12" />
        <path d={line} fill="none" stroke="var(--dash-accent)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="hexaclear-dash-callout">
        <span className={pct >= 0 ? 'is-up' : 'is-down'}>{pct >= 0 ? '▲' : '▼'} {pct >= 0 ? '+' : ''}{pct}%</span> vs earlier runs · best {fmtInt(max)}
      </p>
    </div>
  )
}

const Heatmap = ({ cleared, played }: { cleared: Set<string>; played: Set<string> }) => {
  const weeks = 16
  const today = new Date()
  const dow = today.getDay()
  const cells: { key: string; level: number }[] = []
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const offset = (weeks - 1 - w) * 7 + (dow - d)
      if (offset < 0) {
        cells.push({ key: `f-${w}-${d}`, level: -1 })
        continue
      }
      const date = new Date(today.getTime() - offset * 86400000)
      // Match the app's zero-padded key format (buildDateKey/getTodayKey),
      // e.g. "2026-06-17" — an unpadded key never matches the stored set.
      const mm = String(date.getMonth() + 1).padStart(2, '0')
      const dd = String(date.getDate()).padStart(2, '0')
      const key = `${date.getFullYear()}-${mm}-${dd}`
      const level = cleared.has(key) ? 2 : played.has(key) ? 1 : 0
      cells.push({ key, level })
    }
  }
  return (
    <div className="hexaclear-dash-heatmap" role="img" aria-label="Daily clears over the last 16 weeks">
      {cells.map((c, i) => (
        <span key={`${c.key}-${i}`} className={`lvl-${c.level}`} />
      ))}
    </div>
  )
}

const Gauge = ({ wins, losses }: { wins: number; losses: number }) => {
  const total = wins + losses
  const pct = total > 0 ? wins / total : 0
  const r = 52
  const C = 2 * Math.PI * r
  return (
    <div className="hexaclear-dash-gauge">
      <svg viewBox="0 0 140 140" role="img" aria-label={`Win rate ${Math.round(pct * 100)} percent`}>
        <circle cx="70" cy="70" r={r} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="13" />
        <circle cx="70" cy="70" r={r} fill="none" stroke="var(--dash-accent)" strokeWidth="13" strokeLinecap="round"
          strokeDasharray={`${(C * pct).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 70 70)" />
        <text x="70" y="66" textAnchor="middle" fontSize="26" fontWeight="600" fill="currentColor">{fmtPct(pct)}</text>
        <text x="70" y="88" textAnchor="middle" fontSize="12" fill="currentColor" fillOpacity="0.6">{wins}–{losses}</text>
      </svg>
    </div>
  )
}

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------
export const StatsDashboard = ({
  lifetimeStats,
  pieceStats,
  highScores,
  recentRuns,
  onBack,
  onOpenDailyHistory,
  playUiClick,
}: StatsDashboardProps) => {
  const derived = useMemo(
    () => computeDerived(lifetimeStats, pieceStats, highScores, recentRuns),
    [lifetimeStats, pieceStats, highScores, recentRuns],
  )

  const [prefs, setPrefs] = useState(() => {
    const loaded = loadDashboardPrefs()
    // First-ever open (no saved focus pin yet) → auto-select by play.
    if (typeof window !== 'undefined' && !window.localStorage.getItem('cubic-stats-dashboard-v1')) {
      return { ...loaded, focus: autoFocus(lifetimeStats) }
    }
    return loaded
  })
  const [editing, setEditing] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)

  const focus = prefs.focus
  const def = FOCI[focus]

  const persist = (next: typeof prefs) => {
    setPrefs(next)
    saveDashboardPrefs(next)
  }
  const setFocus = (f: DashboardFocus) => {
    playUiClick?.()
    setEditing(false)
    persist({ ...prefs, focus: f })
  }

  const headlineKeys = (prefs.pins[focus] ?? def.headline).filter(
    (k) => derived.stat[k]?.ok,
  )
  const safeHeadline = headlineKeys.length > 0 ? headlineKeys : ['games']
  const setPins = (keys: string[]) =>
    persist({ ...prefs, pins: { ...prefs.pins, [focus]: keys } })

  const paletteKeys = def.palette.filter(
    (k) => derived.stat[k]?.ok && !safeHeadline.includes(k),
  )

  const glance = def.glance.filter((k) => derived.stat[k]?.ok)
  const records = RECORD_KEYS[focus].filter((k) => derived.stat[k]?.ok)

  const hasAnyGame = derived.totalGames > 0

  const renderHero = () => {
    switch (def.hero) {
      case 'radar':
        return <Radar axes={derived.radar} />
      case 'endless-trend':
        return <Sparkline data={derived.endlessSeries} />
      case 'coop-trend':
        return <Sparkline data={derived.coopSeries} />
      case 'calendar':
        return <Heatmap cleared={derived.clearedSet} played={derived.playedSet} />
      case 'gauge':
        return <Gauge wins={derived.pvpWins} losses={derived.pvpLosses} />
      default:
        return null
    }
  }

  return (
    <div
      className="hexaclear-overlay hexaclear-dash-overlay"
      onClick={(e) => {
        if (e.target !== e.currentTarget) return
        onBack()
      }}
    >
      <div className="hexaclear-overlay-card hexaclear-dash-card">
        <div className="hexaclear-dash-foci" role="tablist" aria-label="Stats focus">
          {(Object.keys(FOCI) as DashboardFocus[]).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={f === focus}
              className={`hexaclear-dash-focus${f === focus ? ' is-on' : ''}`}
              onClick={() => setFocus(f)}
            >
              {FOCI[f].label}
            </button>
          ))}
        </div>

        {!hasAnyGame ? (
          <p className="hexaclear-scores-empty">
            Finish a run and your stats will start filling in here.
          </p>
        ) : (
          <>
            <div className="hexaclear-dash-archetype">{def.title(derived)}</div>

            <div className="hexaclear-dash-headrow">
              <span className="hexaclear-dash-zlabel">Your headline</span>
              <button
                type="button"
                className={`hexaclear-dash-edit${editing ? ' is-on' : ''}`}
                onClick={() => {
                  playUiClick?.()
                  setEditing((v) => !v)
                }}
              >
                {editing ? 'Done' : 'Edit'}
              </button>
            </div>
            <div className="hexaclear-dash-headline">
              {safeHeadline.map((k) => (
                <div key={k} className="hexaclear-dash-head">
                  <span className="hexaclear-dash-head-value">{derived.stat[k].value}</span>
                  <span className="hexaclear-dash-head-label">{derived.stat[k].label}</span>
                  {editing && safeHeadline.length > 1 && (
                    <button
                      type="button"
                      className="hexaclear-dash-unpin"
                      aria-label={`Remove ${derived.stat[k].label}`}
                      onClick={() => setPins(safeHeadline.filter((x) => x !== k))}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            {editing && paletteKeys.length > 0 && safeHeadline.length < 4 && (
              <div className="hexaclear-dash-palette">
                {paletteKeys.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className="hexaclear-dash-pin"
                    onClick={() => setPins([...safeHeadline, k])}
                  >
                    + {derived.stat[k].label}
                  </button>
                ))}
              </div>
            )}

            <div className="hexaclear-dash-zlabel hexaclear-dash-herolabel">{def.heroLabel}</div>
            <div className="hexaclear-dash-hero">{renderHero()}</div>

            {glance.length > 0 && (
              <>
                <div className="hexaclear-dash-zlabel">At a glance</div>
                <div className="hexaclear-dash-glance">
                  {glance.map((k) => (
                    <div key={k} className="hexaclear-dash-gstat">
                      <span className="hexaclear-dash-gvalue">{derived.stat[k].value}</span>
                      <span className="hexaclear-dash-glabel">{derived.stat[k].label}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {records.length > 0 && (
              <>
                <div className="hexaclear-dash-zlabel">Trophy shelf</div>
                <div className="hexaclear-dash-trophies">
                  {records.map((k) => (
                    <div key={k} className="hexaclear-dash-trophy">
                      <span className="hexaclear-dash-tlabel">{derived.stat[k].label}</span>
                      <span className="hexaclear-dash-tvalue">{derived.stat[k].value}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <button
              type="button"
              className="hexaclear-dash-detail-toggle"
              aria-expanded={detailOpen}
              onClick={() => {
                playUiClick?.()
                setDetailOpen((v) => !v)
              }}
            >
              {detailOpen ? 'Hide detailed stats' : 'Show detailed stats'}
            </button>
            {detailOpen && (
              <div className="hexaclear-dash-detail">
                {def.detail.map((g) => {
                  const rows = g.keys.filter((k) => derived.stat[k]?.ok)
                  if (rows.length === 0) return null
                  return (
                    <div key={g.group} className="hexaclear-dash-detail-group">
                      <div className="hexaclear-dash-detail-glabel">{g.group}</div>
                      {rows.map((k) => (
                        <div key={k} className="hexaclear-dash-detail-row">
                          <span>{derived.stat[k].label}</span>
                          <span className="hexaclear-dash-detail-value">{derived.stat[k].value}</span>
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        <div className="hexaclear-dash-footer">
          <button type="button" className="hexaclear-reset" onClick={onBack}>
            Back
          </button>
          {onOpenDailyHistory && (
            <button
              type="button"
              className="hexaclear-dash-link"
              onClick={() => {
                playUiClick?.()
                onOpenDailyHistory()
              }}
            >
              Daily history
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default StatsDashboard
