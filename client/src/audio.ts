// Lightweight SFX manager. Uses HTMLAudioElement so we can rely on
// browser-managed decoding, looping, and pause/resume. The first user
// gesture that plays a sound also "primes" every audio element so that
// later playback (including the looped scrolling sound, which we may
// start from inside a non-gesture event handler) is allowed on iOS
// Safari and other mobile browsers with strict autoplay policies.

type SoundKey =
  | 'clickDown'
  | 'clickUp'
  | 'clear1'
  | 'clear2'
  | 'clear3'
  | 'clear4'
  | 'clear5'
  | 'clear6'
  | 'clear7'
  | 'error'
  | 'gameOver'

const SOURCES: Record<SoundKey, string> = {
  clickDown: '/click_down.wav',
  clickUp: '/click_up.wav',
  clear1: '/clear_1.wav',
  clear2: '/clear_2.wav',
  clear3: '/clear_3.wav',
  clear4: '/clear_4.wav',
  clear5: '/clear_5.wav',
  clear6: '/clear_6.wav',
  clear7: '/clear_7.wav',
  error: '/error.wav',
  gameOver: '/game_over.wav',
}

const VOLUMES: Record<SoundKey, number> = {
  clickDown: 0.7,
  clickUp: 0.7,
  clear1: 0.85,
  clear2: 0.85,
  clear3: 0.85,
  clear4: 0.85,
  clear5: 0.85,
  clear6: 0.85,
  clear7: 0.85,
  error: 0.8,
  gameOver: 0.85,
}

let elements: Partial<Record<SoundKey, HTMLAudioElement>> = {}
let primed = false

const LS_VOLUME_KEY = 'cubic-master-volume'
const LS_MUTED_KEY = 'cubic-muted'

const readInitialVolume = (): number => {
  if (typeof window === 'undefined') return 1
  const raw = window.localStorage.getItem(LS_VOLUME_KEY)
  if (raw === null) return 1
  const n = Number(raw)
  if (!Number.isFinite(n)) return 1
  return Math.max(0, Math.min(1, n))
}

const readInitialMuted = (): boolean => {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(LS_MUTED_KEY) === 'true'
}

let masterVolume = readInitialVolume()
let muted = readInitialMuted()

export const getMasterVolume = (): number => masterVolume
export const getMuted = (): boolean => muted

export const setMasterVolume = (next: number): void => {
  masterVolume = Math.max(0, Math.min(1, next))
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LS_VOLUME_KEY, String(masterVolume))
    } catch {
      // Best-effort persistence.
    }
  }
}

export const setMuted = (next: boolean): void => {
  muted = next
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LS_MUTED_KEY, next ? 'true' : 'false')
    } catch {
      // Best-effort persistence.
    }
  }
}

const ensureElements = () => {
  if (typeof window === 'undefined') return
  for (const key of Object.keys(SOURCES) as SoundKey[]) {
    if (elements[key]) continue
    const audio = new Audio(SOURCES[key])
    audio.preload = 'auto'
    audio.volume = VOLUMES[key]
    elements[key] = audio
  }
}

// Must be called from inside a user gesture (touchstart, pointerdown,
// click, etc.) on the first interaction. Plays + pauses each clip so
// the browser marks it as "user-initiated" and lets us trigger it later
// from non-gesture code paths.
export const unlockAudioOnGesture = () => {
  ensureElements()
  if (primed) return
  primed = true
  for (const key of Object.keys(elements) as SoundKey[]) {
    const audio = elements[key]
    if (!audio) continue
    // Mute the element during priming so the brief window between
    // play() and the pause() that follows the play promise resolving
    // doesn't emit an audible "chord" of every sound at once on iOS
    // Safari and similar mobile browsers. We restore the muted flag
    // after pausing.
    audio.muted = true
    try {
      const result = audio.play()
      if (result && typeof result.then === 'function') {
        result
          .then(() => {
            audio.pause()
            audio.currentTime = 0
            audio.muted = false
          })
          .catch(() => {
            audio.muted = false
            // Some browsers reject the priming play; that's fine — the
            // real call from inside the same gesture below will still
            // work for one-shots.
          })
      } else {
        audio.pause()
        audio.currentTime = 0
        audio.muted = false
      }
    } catch {
      audio.muted = false
      // Ignore: priming is best-effort.
    }
  }
}

const playOneShot = (key: SoundKey) => {
  if (muted) return
  ensureElements()
  const audio = elements[key]
  if (!audio) return
  // Apply per-clip base volume × master volume right before play so the
  // user's volume slider takes effect immediately on the next sound.
  audio.volume = Math.max(0, Math.min(1, VOLUMES[key] * masterVolume))
  try {
    audio.currentTime = 0
    const result = audio.play()
    if (result && typeof result.catch === 'function') {
      result.catch(() => {})
    }
  } catch {
    // Ignore.
  }
}

export const playClickDown = () => playOneShot('clickDown')
export const playClickUp = () => playOneShot('clickUp')
export const playError = () => playOneShot('error')
export const playGameOver = () => playOneShot('gameOver')

// Play the SFX for the Nth consecutive clearing placement, capping at
// clear_7.wav for the 7th and beyond. `streakIndex` is 1-based: 1 means
// the first clear in a row, 2 the second, etc.
export const playClearForStreakIndex = (streakIndex: number) => {
  const clamped = Math.max(1, Math.min(7, Math.floor(streakIndex)))
  playOneShot(`clear${clamped}` as SoundKey)
}
