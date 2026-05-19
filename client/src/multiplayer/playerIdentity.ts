// Stable per-browser anonymous identifier. Keeps reconnect logic working
// when a player closes/refreshes the tab without giving up their slot in
// the room. Persisted in localStorage; regenerated only if it ever goes
// missing (cleared storage, private window, etc).

const PLAYER_ID_KEY = 'cubic-mp-player-id'

const generateId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export const getOrCreatePlayerId = (): string => {
  if (typeof window === 'undefined') return generateId()
  try {
    const existing = window.localStorage.getItem(PLAYER_ID_KEY)
    if (existing && existing.length > 0) return existing
    const fresh = generateId()
    window.localStorage.setItem(PLAYER_ID_KEY, fresh)
    return fresh
  } catch {
    return generateId()
  }
}
