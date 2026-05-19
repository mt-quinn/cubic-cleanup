// Tiny helpers for keeping the multiplayer room code in sync with the
// browser URL (?room=ABCD). Lets the host share a link and keeps the
// state survivable across refreshes.

const ROOM_PARAM = 'room'

export const readRoomCodeFromUrl = (): string | null => {
  if (typeof window === 'undefined') return null
  try {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get(ROOM_PARAM)
    if (!raw) return null
    const code = raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8)
    return code.length > 0 ? code : null
  } catch {
    return null
  }
}

export const setRoomCodeInUrl = (code: string | null): void => {
  if (typeof window === 'undefined') return
  try {
    const url = new URL(window.location.href)
    if (code && code.length > 0) {
      url.searchParams.set(ROOM_PARAM, code)
    } else {
      url.searchParams.delete(ROOM_PARAM)
    }
    window.history.replaceState({}, '', url.toString())
  } catch {
    // Ignore — URL update is a nice-to-have, not load-bearing.
  }
}

export const buildRoomShareUrl = (code: string): string => {
  if (typeof window === 'undefined') return `?${ROOM_PARAM}=${code}`
  try {
    const url = new URL(window.location.href)
    url.searchParams.set(ROOM_PARAM, code)
    return url.toString()
  } catch {
    return `?${ROOM_PARAM}=${code}`
  }
}
