// Lightweight SFX manager. Uses HTMLAudioElement so we can rely on
// browser-managed decoding, looping, and pause/resume. The first user
// gesture that plays a sound also "primes" every audio element so that
// later playback (including the looped scrolling sound, which we may
// start from inside a non-gesture event handler) is allowed on iOS
// Safari and other mobile browsers with strict autoplay policies.

type SoundKey = 'clickDown' | 'clickUp' | 'scrolling'

const SOURCES: Record<SoundKey, string> = {
  clickDown: '/click_down.wav',
  clickUp: '/click_up.wav',
  scrolling: '/scrolling.wav',
}

const VOLUMES: Record<SoundKey, number> = {
  clickDown: 0.7,
  clickUp: 0.7,
  scrolling: 0.45,
}

let elements: Partial<Record<SoundKey, HTMLAudioElement>> = {}
let primed = false

const ensureElements = () => {
  if (typeof window === 'undefined') return
  for (const key of Object.keys(SOURCES) as SoundKey[]) {
    if (elements[key]) continue
    const audio = new Audio(SOURCES[key])
    audio.preload = 'auto'
    audio.volume = VOLUMES[key]
    if (key === 'scrolling') {
      audio.loop = true
    }
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
    try {
      const result = audio.play()
      if (result && typeof result.then === 'function') {
        result
          .then(() => {
            audio.pause()
            audio.currentTime = 0
          })
          .catch(() => {
            // Some browsers reject the priming play; that's fine — the
            // real call from inside the same gesture below will still
            // work for one-shots.
          })
      } else {
        audio.pause()
        audio.currentTime = 0
      }
    } catch {
      // Ignore: priming is best-effort.
    }
  }
}

const playOneShot = (key: SoundKey) => {
  ensureElements()
  const audio = elements[key]
  if (!audio) return
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

export const startScrollingLoop = () => {
  ensureElements()
  const audio = elements.scrolling
  if (!audio) return
  if (!audio.paused) return
  try {
    const result = audio.play()
    if (result && typeof result.catch === 'function') {
      result.catch(() => {})
    }
  } catch {
    // Ignore.
  }
}

export const stopScrollingLoop = () => {
  const audio = elements.scrolling
  if (!audio) return
  if (audio.paused) return
  try {
    audio.pause()
    audio.currentTime = 0
  } catch {
    // Ignore.
  }
}
