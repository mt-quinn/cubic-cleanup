// Web Audio-based SFX manager.
//
// Why not HTMLAudioElement: a single <audio> element can only play one
// instance at a time. When the game fires several SFX close together
// (e.g. click_up + clear_3 + clear_4 during a combo), retriggers race
// the previous play and browsers handle it inconsistently — some drop
// the sound silently, others throw, others delay buffering. The result
// is the "1 in 4 sounds don't play" symptom and an audible action→sound
// latency.
//
// Web Audio fixes both: each sample is decoded once into an AudioBuffer,
// and every play creates a new AudioBufferSourceNode. Sources are
// throwaway, plays freely overlap, there's no Promise to reject, and
// scheduling latency is essentially the audio device's frame size.

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
  | 'break'

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
  break: '/break.wav',
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
  // Error SFX dialed back per request — was reading too loud relative
  // to the quieter UI clicks and clear hits around it.
  error: 0.64,
  gameOver: 0.85,
  break: 0.85,
}

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

let audioContext: AudioContext | null = null
let masterGainNode: GainNode | null = null
const buffers: Partial<Record<SoundKey, AudioBuffer>> = {}
let buffersStartedLoading = false

const computeMasterGainValue = (): number => (muted ? 0 : masterVolume)

const ensureContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null
  if (audioContext) return audioContext
  const Ctor =
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  if (!Ctor) return null
  try {
    const ctx = new Ctor()
    audioContext = ctx
    masterGainNode = ctx.createGain()
    masterGainNode.gain.value = computeMasterGainValue()
    masterGainNode.connect(ctx.destination)
    return ctx
  } catch {
    return null
  }
}

// Kick off fetch + decodeAudioData for every sample. Buffers populate as
// they finish; until a buffer is ready, plays for that key no-op silently.
// In practice the WAV files are tiny and decoding is comfortably done
// before the player dismisses the start-up menu.
const loadAllBuffers = () => {
  if (buffersStartedLoading) return
  const ctx = ensureContext()
  if (!ctx) return
  buffersStartedLoading = true
  for (const key of Object.keys(SOURCES) as SoundKey[]) {
    fetch(SOURCES[key])
      .then((res) => res.arrayBuffer())
      .then(
        (arr) =>
          // decodeAudioData has both a Promise-returning and callback-
          // based form; modern browsers support the Promise form.
          new Promise<AudioBuffer>((resolve, reject) =>
            ctx.decodeAudioData(arr, resolve, reject),
          ),
      )
      .then((buf) => {
        buffers[key] = buf
      })
      .catch(() => {
        // Best-effort: if this clip fails to load, plays for that key
        // will silently no-op. Other clips are unaffected.
      })
  }
}

// Must be called from inside a user gesture so the AudioContext can move
// out of the "suspended" state. Subsequent plays from non-gesture code
// (pointermove, timer callbacks, etc.) are then permitted.
export const unlockAudioOnGesture = () => {
  const ctx = ensureContext()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {
      // Ignore — user can try again on next gesture.
    })
  }
  loadAllBuffers()
}

export const setMasterVolume = (next: number): void => {
  masterVolume = Math.max(0, Math.min(1, next))
  if (masterGainNode && audioContext) {
    // Smooth the change slightly to avoid a click when the slider
    // sweeps quickly. setTargetAtTime is appropriate for live drags
    // because it merges instead of stacking like linearRampTo would.
    masterGainNode.gain.setTargetAtTime(
      computeMasterGainValue(),
      audioContext.currentTime,
      0.01,
    )
  }
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
  if (masterGainNode && audioContext) {
    masterGainNode.gain.setTargetAtTime(
      computeMasterGainValue(),
      audioContext.currentTime,
      0.005,
    )
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(LS_MUTED_KEY, next ? 'true' : 'false')
    } catch {
      // Best-effort persistence.
    }
  }
}

const playOneShot = (key: SoundKey) => {
  if (muted) return
  const ctx = audioContext
  if (!ctx || !masterGainNode) return
  // If the user gesture hasn't unlocked the context yet, bail rather
  // than try to start a source that the browser would silently mute.
  if (ctx.state !== 'running') return
  const buf = buffers[key]
  if (!buf) return
  try {
    const src = ctx.createBufferSource()
    src.buffer = buf
    const clipGain = ctx.createGain()
    clipGain.gain.value = VOLUMES[key]
    src.connect(clipGain).connect(masterGainNode)
    src.start(0)
  } catch {
    // Ignore — playback is best-effort.
  }
}

export const playClickDown = () => playOneShot('clickDown')
export const playClickUp = () => playOneShot('clickUp')
export const playError = () => playOneShot('error')
export const playGameOver = () => playOneShot('gameOver')

// Ruby capture: scheduled to fire ~80ms after the matching clear SFX
// for a stacked "shatter follow-up" feel rather than overlapping the
// clear's attack. We use the AudioContext clock instead of setTimeout
// so the offset is sample-accurate and doesn't drift under load.
export const playBreakAfterClear = (delayMs = 80) => {
  if (muted) return
  const ctx = audioContext
  if (!ctx || !masterGainNode) return
  if (ctx.state !== 'running') return
  const buf = buffers.break
  if (!buf) return
  try {
    const src = ctx.createBufferSource()
    src.buffer = buf
    const clipGain = ctx.createGain()
    clipGain.gain.value = VOLUMES.break
    src.connect(clipGain).connect(masterGainNode)
    src.start(ctx.currentTime + delayMs / 1000)
  } catch {
    // Ignore — playback is best-effort.
  }
}

// UI click: click_down immediately followed by click_up, scheduled
// so click_up begins exactly when click_down ends. We use the
// AudioContext clock for sample-accurate placement instead of
// setTimeout so the two clips sit tightly back-to-back without
// audible overlap or gap.
export const playUiClick = () => {
  if (muted) return
  const ctx = audioContext
  if (!ctx || !masterGainNode) return
  if (ctx.state !== 'running') return
  const downBuf = buffers.clickDown
  const upBuf = buffers.clickUp
  if (!downBuf || !upBuf) return
  try {
    const now = ctx.currentTime
    const downSrc = ctx.createBufferSource()
    downSrc.buffer = downBuf
    const downGain = ctx.createGain()
    downGain.gain.value = VOLUMES.clickDown
    downSrc.connect(downGain).connect(masterGainNode)
    downSrc.start(now)

    const upSrc = ctx.createBufferSource()
    upSrc.buffer = upBuf
    const upGain = ctx.createGain()
    upGain.gain.value = VOLUMES.clickUp
    upSrc.connect(upGain).connect(masterGainNode)
    upSrc.start(now + downBuf.duration)
  } catch {
    // Ignore — playback is best-effort.
  }
}

// Play the SFX for the Nth consecutive clearing placement, capping at
// clear_7.wav for the 7th and beyond. `streakIndex` is 1-based: 1 means
// the first clear in a run, 2 the second, etc.
export const playClearForStreakIndex = (streakIndex: number) => {
  const clamped = Math.max(1, Math.min(7, Math.floor(streakIndex)))
  playOneShot(`clear${clamped}` as SoundKey)
}
