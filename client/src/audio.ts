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
//
// Mobile background-resume robustness:
// When iOS Safari (and to a lesser extent Chrome Android) backgrounds
// the tab and another app/tab grabs the audio session — phone call,
// YouTube tab, Spotify, control-center playback, etc. — the existing
// AudioContext often gets stuck in one of two bad states once the user
// comes back:
//   1. ctx.state === 'interrupted' (iOS-only) and resume() doesn't move
//      it back to 'running' inside the next user gesture.
//   2. ctx.state === 'running' but audio actually routes to nowhere —
//      the audio session was lost while we were hidden and the runtime
//      never reclaimed it for our context. This is the worst case:
//      everything looks healthy but nothing plays. Calling resume()
//      again is a no-op.
//
// Empirically the ONLY reliable cure is the same thing the user does by
// hand: throw the context away and build a fresh one. A new context
// asks the platform for a new audio session from inside a user gesture
// and routes correctly even when other media is still playing in
// another app, just like the page does on a cold load.
//
// We therefore:
//   * Cache the raw ArrayBuffers of every clip so a rebuild doesn't
//     re-fetch over the network (decoded AudioBuffers are tied to the
//     context that decoded them and can't be reused).
//   * Mark the context as "may be stale" on every hidden→visible
//     transition, pageshow, and focus event.
//   * On the very next call to unlockAudioOnGesture (which always runs
//     inside a real user gesture), close the suspect context and build
//     a new one before doing anything else.
//
// The result mirrors the user's "kill the tab and reopen" workaround
// without making them do it manually.

// Clear SFX naming convention:
//   - "clear<S>" (S = 1..7) is the single-clear sound for streak S.
//     Used when a placement clears exactly one line/rosette. Streak
//     caps at 7 (i.e., 8th+ consecutive clear reuses clear7).
//   - "clear<S>combo<C>" (S = 1..7, C = 1..3) is the combo sound for
//     streak S and combo size C+1. So clear3combo2 plays on the 3rd
//     consecutive clearing placement when that placement clears 3
//     lines/rosettes at once. Combo caps at 3 (i.e., 4+ patterns
//     cleared in one placement reuses combo3).
type ClearStreakIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7
type ClearComboIndex = 1 | 2 | 3
type ClearKey =
  | `clear${ClearStreakIndex}`
  | `clear${ClearStreakIndex}combo${ClearComboIndex}`
type SoundKey =
  | 'clickDown'
  | 'clickUp'
  | ClearKey
  | 'error'
  | 'gameOver'
  | 'break'
  | 'cubekill'
  | AnnouncerCueKey

// Announcer cues fired by placement results (see App.tsx for the
// priority rules: board clear > streak milestone > combo count).
export type AnnouncerCueKey =
  | 'announceBoardClear'
  | 'announceGameOver'
  | 'announceCombo2'
  | 'announceCombo3'
  | 'announceCombo4'
  | 'announceCombo5'
  | 'announceCombo6'
  | 'announceStreakGood'
  | 'announceStreakGreat'
  | 'announceStreakUnbelievable'
  | 'announceStreakGodlike'

const STREAKS: ClearStreakIndex[] = [1, 2, 3, 4, 5, 6, 7]
const COMBOS: ClearComboIndex[] = [1, 2, 3]

const buildClearSources = (): Record<ClearKey, string> => {
  const out = {} as Record<ClearKey, string>
  for (const s of STREAKS) {
    out[`clear${s}`] = `/clear_${s}.wav`
    for (const c of COMBOS) {
      out[`clear${s}combo${c}`] = `/clear_${s}_combo_${c}.wav`
    }
  }
  return out
}

const buildClearVolumes = (): Record<ClearKey, number> => {
  const out = {} as Record<ClearKey, number>
  for (const s of STREAKS) {
    out[`clear${s}`] = 0.85
    for (const c of COMBOS) {
      out[`clear${s}combo${c}`] = 0.85
    }
  }
  return out
}

const SOURCES: Record<SoundKey, string> = {
  clickDown: '/click_down.wav',
  clickUp: '/click_up.wav',
  ...buildClearSources(),
  error: '/error.wav',
  gameOver: '/game_over.wav',
  break: '/break.wav',
  // Announcer: the run-start "CUBEKILL" call, fired on the deal-in
  // title slam's impact frame.
  cubekill: '/cubekill.wav',
  // Announcer: placement cues. Combo lines ride 2-6 patterns cleared
  // in one placement; streak lines are keyed by name (the streak
  // numbers they attach to live in App.tsx, currently 2/3/4/5).
  announceBoardClear: '/boardclear.wav',
  // The announcer calls the death too — layered over (after) the
  // game_over.wav sting, not replacing it.
  announceGameOver: '/gameover.wav',
  announceCombo2: '/double.wav',
  announceCombo3: '/triple.wav',
  announceCombo4: '/quad.wav',
  announceCombo5: '/quintuple.wav',
  announceCombo6: '/sextuple.wav',
  announceStreakGood: '/goodstreak.wav',
  announceStreakGreat: '/greatstreak.wav',
  announceStreakUnbelievable: '/unbelievablestreak.wav',
  announceStreakGodlike: '/godlikestreak.wav',
}

const VOLUMES: Record<SoundKey, number> = {
  clickDown: 0.7,
  clickUp: 0.7,
  ...buildClearVolumes(),
  // Error SFX dialed back per request — was reading too loud relative
  // to the quieter UI clicks and clear hits around it.
  error: 0.64,
  gameOver: 0.85,
  break: 0.85,
  // The announcer sits clearly under the clear-SFX peaks so the
  // musical layer keeps the crown overall (full set now at 50% of the
  // originally-authored levels per mix review).
  cubekill: 0.45,
  announceBoardClear: 0.44,
  announceGameOver: 0.44,
  announceCombo2: 0.4,
  announceCombo3: 0.41,
  announceCombo4: 0.42,
  announceCombo5: 0.43,
  announceCombo6: 0.44,
  announceStreakGood: 0.41,
  announceStreakGreat: 0.42,
  announceStreakUnbelievable: 0.43,
  announceStreakGodlike: 0.44,
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

const computeMasterGainValue = (): number => (muted ? 0 : masterVolume)

// ---- Raw audio cache --------------------------------------------------
//
// Lives for the page's lifetime, independent of any single AudioContext.
// Each entry is the raw bytes of the .wav file. We slice() into a fresh
// ArrayBuffer every time we decode, because decodeAudioData is allowed
// to detach the input buffer on some platforms (notably older Safari).

const rawAudioData: Partial<Record<SoundKey, ArrayBuffer>> = {}
let rawFetchStarted = false

const startFetchingRawAudio = () => {
  if (rawFetchStarted) return
  if (typeof window === 'undefined') return
  rawFetchStarted = true
  for (const key of Object.keys(SOURCES) as SoundKey[]) {
    fetch(SOURCES[key])
      .then((res) => res.arrayBuffer())
      .then((arr) => {
        rawAudioData[key] = arr
        // If a context already exists and is waiting on this clip,
        // decode it now so the next play has a buffer ready.
        const ctx = audioContext
        if (ctx && !buffers[key]) {
          decodeIntoSession(ctx, sessionId, key, arr.slice(0))
        }
      })
      .catch(() => {
        // Best-effort: a failed clip silently no-ops on play.
      })
  }
}

// ---- Audio context lifecycle ------------------------------------------
//
// Every rebuild bumps `sessionId`. Async decodes from a previous session
// check the id when they resolve and discard themselves if they're
// landing in the wrong context.

let audioContext: AudioContext | null = null
let masterGainNode: GainNode | null = null
let buffers: Partial<Record<SoundKey, AudioBuffer>> = {}
let sessionId = 0

// Living Board critical state: a lowpass that sits permanently in the
// master chain (transparent when open) plus a synthesized 55Hz
// heartbeat thump on a 900ms clock. No audio assets involved.
// See Documentation/Deal-In and Living Board Plan.md.
let criticalFilterNode: BiquadFilterNode | null = null
let criticalAudioActive = false
let criticalThumpInterval: number | null = null
const CRITICAL_LOWPASS_HZ = 2400
const CRITICAL_LOWPASS_OPEN_HZ = 18000
const CRITICAL_THUMP_PERIOD_MS = 900
const CRITICAL_THUMP_GAIN = 0.13

// Set on every visibility transition that could have lost the audio
// session. Consumed by the next user-gesture unlock, which rebuilds the
// context. Starts false so the very first gesture on a fresh page boots
// a context normally instead of "rebuilding" a non-existent one.
let contextMayBeStale = false

// True when the AudioContext is in any of the not-actually-playing
// states. iOS Safari emits a non-standard 'interrupted' state when
// another app/tab grabs the audio session — it's not in the W3C
// AudioContext spec but the runtime uses it, so we string-match
// rather than rely on the TS lib types.
const isContextStalled = (ctx: AudioContext): boolean => {
  const state = ctx.state as string
  return state === 'suspended' || state === 'interrupted' || state === 'closed'
}

// ---- "Audio needs unlock" subscription --------------------------------
//
// A small pub/sub the UI uses to render a "Tap to resume" prompt when
// the player has audio unmuted but the AudioContext is unhealthy. iOS
// Safari refuses to resume an AudioContext from any event that's part
// of a drag gesture (see WebKit bug #248265), so when the player's
// natural first interaction is a tap-and-drag piece grab there is no
// way for us to silently unlock audio — they must do a touch-as-click
// somewhere. The UI surfaces a small prompt for that click.
//
// `audioNeedsUnlock` is true iff:
//   - the player is unmuted (so they're asking for audio), AND
//   - the context is missing, may be stale, or isn't `running`.
//
// We only fire subscribers when the boolean actually changes so the
// React renderer doesn't see redundant updates.

type AudioNeedsUnlockListener = (needsUnlock: boolean) => void
const audioNeedsUnlockListeners = new Set<AudioNeedsUnlockListener>()
let lastNotifiedNeedsUnlock: boolean | null = null

const computeNeedsUnlock = (): boolean => {
  // Muted players don't want audio; the prompt would be noise.
  if (muted) return false
  if (contextMayBeStale) return true
  if (!audioContext) return true
  if ((audioContext.state as string) !== 'running') return true
  return false
}

const notifyAudioState = (): void => {
  const needs = computeNeedsUnlock()
  if (needs === lastNotifiedNeedsUnlock) return
  lastNotifiedNeedsUnlock = needs
  for (const l of audioNeedsUnlockListeners) {
    try {
      l(needs)
    } catch {
      // Subscriber errors must not poison the broadcast.
    }
  }
}

export const subscribeAudioNeedsUnlock = (
  listener: AudioNeedsUnlockListener,
): (() => void) => {
  audioNeedsUnlockListeners.add(listener)
  // Fire the current state immediately so subscribers don't need their
  // own bootstrapping logic.
  try {
    listener(computeNeedsUnlock())
  } catch {
    // Same robustness guarantee as notifyAudioState().
  }
  return () => {
    audioNeedsUnlockListeners.delete(listener)
  }
}

// Synchronous snapshot of the current needs-unlock state, intended for
// React useState initializers that need the right value on the first
// render rather than waiting for the subscription effect to mount and
// flush an extra commit.
export const getAudioNeedsUnlock = (): boolean => computeNeedsUnlock()

const decodeIntoSession = (
  ctx: AudioContext,
  mySession: number,
  key: SoundKey,
  arr: ArrayBuffer,
): void => {
  // decodeAudioData has both Promise-returning and callback-based forms;
  // wrap the callback form so it works uniformly on older Safari.
  new Promise<AudioBuffer>((resolve, reject) =>
    ctx.decodeAudioData(arr, resolve, reject),
  )
    .then((buf) => {
      // Discard the decode if a newer session has replaced us. Without
      // this guard a slow decode from an old context could overwrite a
      // fresh decode in the new context and crash on play (AudioBuffer
      // cross-context).
      if (sessionId !== mySession) return
      if (audioContext !== ctx) return
      buffers[key] = buf
    })
    .catch(() => {
      // Bad clip / corrupted decode — let it stay missing.
    })
}

const decodeAllCachedFor = (ctx: AudioContext, mySession: number) => {
  for (const key of Object.keys(SOURCES) as SoundKey[]) {
    const raw = rawAudioData[key]
    if (!raw) continue
    decodeIntoSession(ctx, mySession, key, raw.slice(0))
  }
}

const closeAudioContext = () => {
  const ctx = audioContext
  audioContext = null
  masterGainNode = null
  criticalFilterNode = null
  buffers = {}
  if (!ctx) {
    notifyAudioState()
    return
  }
  // close() returns a Promise; we don't await because we're already
  // moving on and the runtime will tear the resources down regardless.
  try {
    void ctx.close()
  } catch {
    // Closing a context that's already closed throws on some browsers.
  }
  notifyAudioState()
}

const buildAudioContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null
  const Ctor =
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  if (!Ctor) return null
  let ctx: AudioContext
  try {
    ctx = new Ctor()
  } catch {
    return null
  }
  const mySession = ++sessionId
  audioContext = ctx
  masterGainNode = ctx.createGain()
  masterGainNode.gain.value = computeMasterGainValue()
  // Master chain: everything -> masterGain -> critical lowpass ->
  // destination. The filter sits transparent (wide open) until the
  // Living Board critical state closes it down; routing it permanently
  // means iOS context rebuilds re-apply the current critical state via
  // the initial frequency below, with no re-patching.
  criticalFilterNode = ctx.createBiquadFilter()
  criticalFilterNode.type = 'lowpass'
  criticalFilterNode.frequency.value = criticalAudioActive
    ? CRITICAL_LOWPASS_HZ
    : CRITICAL_LOWPASS_OPEN_HZ
  criticalFilterNode.Q.value = 0.0001
  masterGainNode.connect(criticalFilterNode)
  criticalFilterNode.connect(ctx.destination)
  buffers = {}

  // If the runtime emits a stalled statechange mid-session (iOS
  // interruption that fires without a corresponding visibility event),
  // mark the context as stale so the next gesture rebuilds. We don't
  // try to call resume() inline because by the time the user notices
  // and taps, we want to rebuild — not paper over a session that the
  // OS has already torn down. We also re-broadcast the needs-unlock
  // signal so the UI can show/hide the prompt as the runtime moves the
  // context between suspended/interrupted/running.
  ctx.addEventListener('statechange', () => {
    if (sessionId !== mySession) return
    if (isContextStalled(ctx)) {
      contextMayBeStale = true
    }
    notifyAudioState()
  })

  decodeAllCachedFor(ctx, mySession)
  // Newly-built context typically starts in 'suspended' on iOS until
  // resume() inside a user gesture moves it to 'running'. Broadcast so
  // the UI can keep the prompt up until that transition lands.
  notifyAudioState()
  return ctx
}

// ---- Audio session category -------------------------------------------
//
// By default iOS Safari treats our audio — especially the music-visualizer
// <audio> element, which is a real HTMLMediaElement — as primary
// "playback". That seizes the Now-Playing / lock-screen session and pauses
// whatever the user had going in other apps. Declaring the page's audio
// session as 'ambient' tells the platform our audio is non-primary: it
// mixes with other apps' audio instead of interrupting it, and obeys the
// hardware mute switch. The mute-switch behavior is not a regression for a
// browser game, which is already governed by it.
//
// The AudioSession API is Safari-only (16.4+) and still experimental, so we
// feature-detect and set it best-effort. It's a document-global setting, so
// a single call governs both this SFX context and the visualizer's separate
// AudioContext. We reassert it on every gesture-driven unlock because an
// iOS audio-session interruption can reset the category out from under us.

type AudioSessionLike = { type?: string }

const configureAudioSession = () => {
  if (typeof navigator === 'undefined') return
  const session = (
    navigator as Navigator & { audioSession?: AudioSessionLike }
  ).audioSession
  if (!session) return
  try {
    if (session.type !== 'ambient') session.type = 'ambient'
  } catch {
    // Unsupported value or a locked session — best-effort, just no-op.
  }
}

// ---- Visibility / focus hooks -----------------------------------------
//
// These do NOT touch the AudioContext directly — touching it outside a
// user gesture is what got us here in the first place. They just flip
// `contextMayBeStale` so the next gesture rebuilds.

let visibilityHooksInstalled = false

const markStale = () => {
  contextMayBeStale = true
  notifyAudioState()
}

const installVisibilityHooks = () => {
  if (visibilityHooksInstalled) return
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  visibilityHooksInstalled = true

  // Hidden→visible: the most common path. Tab-switch, app-switch on
  // iOS, lock-screen unlock, etc. We mark stale on BOTH transitions:
  // hidden (so we don't bother trying to play while backgrounded) and
  // visible (so the return-trip path is covered even if 'hidden' was
  // never observed, e.g. when the page boots straight into visible
  // after a bfcache restore).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      markStale()
    } else if (document.visibilityState === 'visible') {
      markStale()
    }
  })

  // bfcache restore on mobile back-navigation: the page wakes up in
  // visible state without a visibilitychange event firing. pageshow
  // with persisted=true is the canonical signal.
  window.addEventListener('pageshow', (e: PageTransitionEvent) => {
    if (e.persisted) markStale()
  })

  // Desktop window-focus path (clicking another browser window) —
  // visibilitychange doesn't fire for that.
  window.addEventListener('focus', markStale)

  // Safety net: any global user gesture runs the unlock path. This
  // catches gestures that don't go through our explicit
  // unlockAudioOnGesture() callsites (e.g. tapping a non-button
  // region). Listeners are passive — they don't preventDefault — and
  // run with `once: false` because the unlock is cheap when nothing
  // needs to change.
  //
  // Which events count as "activation-triggering" for AudioContext on
  // iOS Safari is narrower than people assume. Per WebKit's
  // implementation, the eligible events are:
  //   - keydown (excluding Escape)
  //   - mousedown
  //   - pointerdown ONLY when pointerType === 'mouse'
  //   - pointerup when pointerType !== 'mouse'
  //   - touchend
  //
  // Note that touchstart and touch-type pointerdown are NOT activation
  // events on iOS. This is why a tap-and-drag (which finishes with a
  // pointerup/touchend rather than a click on the original element)
  // failed to unlock audio when our only touch listeners were on
  // touchstart/pointerdown — the gesture completed without ever firing
  // a qualifying event. We listen on the full eligible set, paired with
  // touchstart/pointerdown for desktop or browsers that do treat them
  // as activation, so the unlock fires on whichever event ends up
  // qualifying first.
  const onGesture = () => {
    try {
      unlockAudioOnGesture()
    } catch {
      // Swallow — the explicit callsites will retry on the next tap.
    }
  }
  window.addEventListener('pointerdown', onGesture, { passive: true })
  window.addEventListener('pointerup', onGesture, { passive: true })
  window.addEventListener('touchstart', onGesture, { passive: true })
  window.addEventListener('touchend', onGesture, { passive: true })
  window.addEventListener('mousedown', onGesture, { passive: true })
  window.addEventListener('keydown', onGesture, { passive: true })
}

// Install the global gesture / visibility listeners at module load.
// They're SSR-safe (the function bails when `window` is undefined) and
// idempotent. Doing it here means the very first user tap anywhere on
// the page — including a tap on the board to pick up a piece — will
// bootstrap the AudioContext via the global pointerdown handler. The
// old "Resume button in the pause menu is the audio gateway" pattern
// is no longer required; the menu can stay closed on cold load.
installVisibilityHooks()

// Declare the page's audio as mixable up front so the platform never
// boots us into a Now-Playing-stealing session in the first place.
configureAudioSession()

// ---- Public unlock path -----------------------------------------------

// Must be called from inside a user gesture so the AudioContext can move
// out of the "suspended" / "interrupted" state. Subsequent plays from
// non-gesture code (pointermove, timer callbacks, etc.) are then
// permitted. Idempotent — fine to call on every gesture.
//
// This is also the rebuild path: if the page has been backgrounded
// since the context was last known good, we throw it away and create a
// fresh one inside this gesture. The new context claims a new audio
// session from the platform, which is the only reliable way to
// recover from an iOS audio-session steal.
export const unlockAudioOnGesture = () => {
  if (typeof window === 'undefined') return

  // Reassert the mixable session category — an iOS interruption while we
  // were hidden can silently reset it back to 'playback'.
  configureAudioSession()

  // If we're returning from a hidden-page round-trip, the existing
  // context — if any — is suspect. Close it now, inside the gesture,
  // and let the rebuild below claim a fresh audio session.
  if (contextMayBeStale && audioContext) {
    closeAudioContext()
  }
  // Always clear the flag once we've reacted to it. If the rebuild
  // below fails for any reason, the next gesture will start with a
  // clean (false) state and try again from scratch.
  contextMayBeStale = false

  startFetchingRawAudio()

  const ctx = audioContext ?? buildAudioContext()
  if (!ctx) return

  // Bring a freshly-created or recovering context into 'running' from
  // inside this same gesture. We don't await the promise — the next
  // play() call checks ctx.state directly.
  if (isContextStalled(ctx) && ctx.state !== 'closed') {
    const mySession = sessionId
    ctx.resume()
      .then(() => {
        // Belt-and-suspenders against the iOS "resume promise
        // resolves but state didn't actually move" case. If we
        // surface back to 'running', great; if not, mark stale so
        // the next gesture rebuilds rather than silently failing.
        if (sessionId !== mySession) return
        if (audioContext !== ctx) return
        if (isContextStalled(ctx)) {
          contextMayBeStale = true
        }
        notifyAudioState()
      })
      .catch(() => {
        // resume() can reject if Safari decides the gesture window
        // closed (e.g. nested setTimeout from a click handler) or
        // if the audio session is hard-locked by another app.
        // Either way, the next gesture should rebuild from scratch.
        if (sessionId === mySession && audioContext === ctx) {
          contextMayBeStale = true
        }
        notifyAudioState()
      })
  } else {
    // The context is already healthy (or fatally closed); broadcast
    // either way so subscribers stay in sync with reality.
    notifyAudioState()
  }
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
  // Mute changes flip whether the player wants audio at all, so the
  // needs-unlock signal needs to re-broadcast: a muted player should
  // never see the prompt, and an unmute toggle on a stale context
  // should surface it immediately.
  notifyAudioState()
}

// ---- Playback helpers --------------------------------------------------

// Common entry guard for every play call. Returns the running context
// if it's healthy, or null if we should silently no-op for this play.
//
// When the context is stalled we don't kick off recovery from here —
// the visibility hooks already marked staleness if anything changed,
// and the next user gesture will rebuild. Trying to resume() from a
// non-gesture path (which is what most plays are) just produces
// console noise on iOS without doing anything useful.
const readyContext = (): AudioContext | null => {
  if (muted) return null
  const ctx = audioContext
  if (!ctx) return null
  if (!masterGainNode) return null
  if (ctx.state !== 'running') return null
  return ctx
}

const playOneShot = (key: SoundKey) => {
  const ctx = readyContext()
  if (!ctx) return
  const buf = buffers[key]
  if (!buf) return
  try {
    const src = ctx.createBufferSource()
    src.buffer = buf
    const clipGain = ctx.createGain()
    clipGain.gain.value = VOLUMES[key]
    src.connect(clipGain).connect(masterGainNode!)
    src.start(0)
  } catch {
    // Ignore — playback is best-effort.
  }
}

export const playClickDown = () => playOneShot('clickDown')
export const playClickUp = () => playOneShot('clickUp')

// ---- Living Board critical audio ---------------------------------------

// One synthesized heartbeat: a 55Hz sine with a fast attack and ~280ms
// decay, mixed well under the SFX layer. Skips silently if the context
// isn't running (the CSS alarm carries the moment; audio rejoins on the
// next tick once the context wakes).
const playCriticalThump = () => {
  const ctx = readyContext()
  if (!ctx) return
  if (!criticalAudioActive) return
  try {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = 55
    const env = ctx.createGain()
    const now = ctx.currentTime
    env.gain.setValueAtTime(0, now)
    env.gain.linearRampToValueAtTime(CRITICAL_THUMP_GAIN, now + 0.012)
    env.gain.exponentialRampToValueAtTime(0.0001, now + 0.3)
    osc.connect(env).connect(masterGainNode!)
    osc.start(now)
    osc.stop(now + 0.32)
  } catch {
    // Best-effort.
  }
}

// Raise/lower the critical soundscape: closes the master lowpass (the
// air goes out of the room) and starts the heartbeat clock. Idempotent;
// safe to call with no audio context (state is remembered and applied
// when a context is built). The thump clock deliberately uses
// setInterval rather than the audio clock — critical states are short,
// and drift against the CSS pulse is imperceptible at this scale.
export const setCriticalAudio = (active: boolean): void => {
  if (criticalAudioActive === active) return
  criticalAudioActive = active

  if (criticalFilterNode && audioContext) {
    criticalFilterNode.frequency.setTargetAtTime(
      active ? CRITICAL_LOWPASS_HZ : CRITICAL_LOWPASS_OPEN_HZ,
      audioContext.currentTime,
      active ? 0.18 : 0.05,
    )
  }

  if (active) {
    if (typeof window !== 'undefined' && criticalThumpInterval === null) {
      playCriticalThump()
      criticalThumpInterval = window.setInterval(
        playCriticalThump,
        CRITICAL_THUMP_PERIOD_MS,
      )
    }
  } else if (criticalThumpInterval !== null) {
    window.clearInterval(criticalThumpInterval)
    criticalThumpInterval = null
  }
}

// Game-over collapse clatter: one tick per sampled cube impact as the
// board sheds its pieces. clickDown pitched well below normal with
// per-tick randomization so a burst of them reads as tumbling wooden
// debris rather than UI input. Quiet — the game_over sting leads.
export const playCollapseClatter = (delayMs = 0) => {
  const ctx = readyContext()
  if (!ctx) return
  const buf = buffers.clickDown
  if (!buf) return
  try {
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = 0.5 + Math.random() * 0.45
    const clipGain = ctx.createGain()
    clipGain.gain.value = VOLUMES.clickDown * (0.25 + Math.random() * 0.15)
    src.connect(clipGain).connect(masterGainNode!)
    src.start(ctx.currentTime + delayMs / 1000)
  } catch {
    // Ignore — playback is best-effort.
  }
}

// Deal-in tick: one per rosette as the board cascades in at the start
// of a fresh run. Reuses the clickUp buffer pitch-stepped upward across
// the rosettes (playbackRate 1.0 -> 2.0) so the board "builds" musically
// without any new audio asset, and quieter than a real UI click so the
// seven ticks read as one gesture rather than seven button presses.
export const playDealTick = (step: number, steps: number) => {
  const ctx = readyContext()
  if (!ctx) return
  const buf = buffers['clickUp']
  if (!buf) return
  try {
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = 1 + step / Math.max(1, steps - 1)
    const clipGain = ctx.createGain()
    clipGain.gain.value = VOLUMES.clickUp * 0.45
    src.connect(clipGain).connect(masterGainNode!)
    src.start(0)
  } catch {
    // Ignore — playback is best-effort.
  }
}
export const playError = () => playOneShot('error')
export const playGameOver = () => playOneShot('gameOver')

// Announcer: the run-start "CUBEKILL" call. Fired by the deal-in on
// its title-slam impact frame; no-ops while the context is locked
// (cold loads stay silent, gesture-started runs get the full call).
export const playCubekillAnnounce = () => playOneShot('cubekill')

// Announcer placement cues: scheduled slightly after the clear SFX on
// the audio clock (same pattern as playBreakAfterClear) so the musical
// hit keeps its attack and the voice reads as the call on top of it,
// not a collision with it.
export const playAnnouncerCue = (key: AnnouncerCueKey, delayMs = 160) => {
  const ctx = readyContext()
  if (!ctx) return
  const buf = buffers[key]
  if (!buf) return
  try {
    const src = ctx.createBufferSource()
    src.buffer = buf
    const clipGain = ctx.createGain()
    clipGain.gain.value = VOLUMES[key]
    src.connect(clipGain).connect(masterGainNode!)
    src.start(ctx.currentTime + delayMs / 1000)
  } catch {
    // Ignore — playback is best-effort.
  }
}

// Ruby capture: scheduled to fire ~80ms after the matching clear SFX
// for a stacked "shatter follow-up" feel rather than overlapping the
// clear's attack. We use the AudioContext clock instead of setTimeout
// so the offset is sample-accurate and doesn't drift under load.
export const playBreakAfterClear = (delayMs = 80) => {
  const ctx = readyContext()
  if (!ctx) return
  const buf = buffers.break
  if (!buf) return
  try {
    const src = ctx.createBufferSource()
    src.buffer = buf
    const clipGain = ctx.createGain()
    clipGain.gain.value = VOLUMES.break
    src.connect(clipGain).connect(masterGainNode!)
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
  const ctx = readyContext()
  if (!ctx) return
  const downBuf = buffers.clickDown
  const upBuf = buffers.clickUp
  if (!downBuf || !upBuf) return
  try {
    const now = ctx.currentTime
    const downSrc = ctx.createBufferSource()
    downSrc.buffer = downBuf
    const downGain = ctx.createGain()
    downGain.gain.value = VOLUMES.clickDown
    downSrc.connect(downGain).connect(masterGainNode!)
    downSrc.start(now)

    const upSrc = ctx.createBufferSource()
    upSrc.buffer = upBuf
    const upGain = ctx.createGain()
    upGain.gain.value = VOLUMES.clickUp
    upSrc.connect(upGain).connect(masterGainNode!)
    upSrc.start(now + downBuf.duration)
  } catch {
    // Ignore — playback is best-effort.
  }
}

// Play the celebration SFX for a clearing placement.
//
// `streakIndex` (1-based) is how many consecutive clearing placements
// the player has chained together, including this one — capped at 7,
// so an 8th+ in a row replays the clear7 layer.
//
// `clearCount` is how many lines/rosettes were cleared in *this single
// placement*. The combo layer is clearCount - 1: a single-clear plays
// the bare "clear<streak>" sound, two-in-one steps up to combo_1,
// three-in-one to combo_2, and four-or-more all collapse to combo_3.
export const playClearForStreakIndex = (
  streakIndex: number,
  clearCount: number = 1,
) => {
  const streak = Math.max(1, Math.min(7, Math.floor(streakIndex)))
  const combo = Math.max(0, Math.min(3, Math.floor(clearCount) - 1))
  const key =
    combo === 0 ? `clear${streak}` : `clear${streak}combo${combo}`
  playOneShot(key as SoundKey)
}
