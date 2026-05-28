// Tiny helpers for keeping the multiplayer room code in sync with the
// browser URL (?room=ABCD). Lets the host share a link and keeps the
// state survivable across refreshes.
//
// The link can also carry the desired room mode (?mode=pvp). We treat
// 'coop' as the default and only serialize the mode when it diverges
// (so pre-existing share links keep working untouched).

export type RoomMode = 'coop' | 'pvp'

const ROOM_PARAM = 'room'
const MODE_PARAM = 'mode'

const sanitizeMode = (raw: string | null): RoomMode | null => {
  if (!raw) return null
  const v = raw.toLowerCase()
  if (v === 'pvp' || v === 'coop') return v
  return null
}

type ReadRoomFromUrlResult = {
  code: string | null
  mode: RoomMode | null
}

export const readRoomFromUrl = (): ReadRoomFromUrlResult => {
  if (typeof window === 'undefined') return { code: null, mode: null }
  try {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get(ROOM_PARAM)
    const code = raw
      ? (() => {
          const cleaned = raw.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8)
          return cleaned.length > 0 ? cleaned : null
        })()
      : null
    const mode = sanitizeMode(params.get(MODE_PARAM))
    return { code, mode }
  } catch {
    return { code: null, mode: null }
  }
}

export const setRoomCodeInUrl = (
  code: string | null,
  mode: RoomMode | null = null,
): void => {
  if (typeof window === 'undefined') return
  try {
    const url = new URL(window.location.href)
    if (code && code.length > 0) {
      url.searchParams.set(ROOM_PARAM, code)
    } else {
      url.searchParams.delete(ROOM_PARAM)
    }
    if (mode === 'pvp') {
      url.searchParams.set(MODE_PARAM, 'pvp')
    } else {
      url.searchParams.delete(MODE_PARAM)
    }
    window.history.replaceState({}, '', url.toString())
  } catch {
    // Ignore — URL update is a nice-to-have, not load-bearing.
  }
}

export const buildRoomShareUrl = (
  code: string,
  mode: RoomMode | null = null,
): string => {
  if (typeof window === 'undefined') {
    return mode === 'pvp'
      ? `?${ROOM_PARAM}=${code}&${MODE_PARAM}=pvp`
      : `?${ROOM_PARAM}=${code}`
  }
  try {
    const url = new URL(window.location.href)
    url.searchParams.set(ROOM_PARAM, code)
    if (mode === 'pvp') {
      url.searchParams.set(MODE_PARAM, 'pvp')
    } else {
      url.searchParams.delete(MODE_PARAM)
    }
    return url.toString()
  } catch {
    return mode === 'pvp'
      ? `?${ROOM_PARAM}=${code}&${MODE_PARAM}=pvp`
      : `?${ROOM_PARAM}=${code}`
  }
}
