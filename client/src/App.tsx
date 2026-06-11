import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useAuthActions, useConvexAuth } from '@convex-dev/auth/react'
import { useMutation, useQuery } from 'convex/react'
import {
  getBoardDefinitionForMode,
  getBoardGeometryForMode,
} from './game/boardDefinition'
import type { BoardGeometry } from './game/boardDefinition'
import {
  applyPlacement,
  canPlacePiece,
  computeBoardLiveness,
  createBigGameState,
  createInitialGameState,
  createDailyGameState,
  createTutorialStage1State,
  createTutorialStage2State,
  dealPlayableHand,
  dealDailyHand,
  hasAnyValidMove,
  TUTORIAL_STAGE_1_TARGET_CELL_IDS,
  TUTORIAL_STAGE_2_TARGET_CELL_IDS,
} from './game/gameLogic'
import type {
  ActivePiece,
  BoardState,
  GameMode,
  GameState,
} from './game/gameLogic'
import { axialToId, addAxial, directions } from './game/hexTypes'
import type { Axial, BoardDefinition } from './game/hexTypes'
import {
  ALL_PIECE_VARIANTS,
  PIECE_VARIANT_NAMES,
  findPieceVariant,
} from './game/pieces'
import type { PieceVariant } from './game/pieces'
import {
  applyGameOverToPieceStats,
  applyPlacementToPieceStats,
  averagePoints,
  getPieceStats,
  loadPieceStats,
  savePieceStats,
  savePieceStatsSyncBaseline,
} from './pieceStats'
import type { PieceStatsMap, PieceVariantStats } from './pieceStats'
import {
  getAudioNeedsUnlock,
  getMasterVolume,
  getMuted,
  playAnnouncerCue,
  playBreakAfterClear,
  playClearForStreakIndex,
  playClickDown,
  playClickUp,
  playCollapseClatter,
  playCubekillAnnounce,
  playDealTick,
  playError,
  playGameOver,
  playUiClick,
  setCriticalAudio,
  setMasterVolume,
  setMuted,
  subscribeAudioNeedsUnlock,
  unlockAudioOnGesture,
} from './audio'
import { api } from '../convex/_generated/api'
import { useMultiplayerGame } from './multiplayer/useMultiplayerGame'
import { getOrCreatePlayerId } from './multiplayer/playerIdentity'
import {
  applyPlacementToRunStats,
  buildPieceStatsDelta,
  createEmptyLifetimeStats,
  createEmptyRunStats,
  calculateStatsSyncDelta,
  clearStatsSyncAccountId,
  foldRunIntoLifetime,
  formatDuration,
  formatFriendlyDate,
  formatFriendlyDateTime,
  loadLifetimeStats,
  loadStatsSyncAccountId,
  loadStatsSyncBaseline,
  loadStatsSyncLastAt,
  saveLifetimeStats,
  saveStatsSyncAccountId,
  saveStatsSyncBaseline,
} from './stats'
import type { LifetimeStats, RunStats } from './stats'
import {
  createHighlightSnapshot,
  HighlightReel,
  HIGHLIGHT_REEL_MIN_POINTS,
  MultiHighlightReel,
  RUN_HISTORY_MAX,
  RUN_HISTORY_EXPORT_MAX,
} from './highlightReel'
import type { RunHighlightSnapshot } from './highlightReel'
import { captureMultiHighlightReelAsGif } from './highlightReelGif'
import type { CaptureProgress } from './highlightReelGif'
import {
  buildRoomShareUrl,
  readRoomFromUrl,
  setRoomCodeInUrl,
  type RoomMode,
} from './multiplayer/roomUrl'
import { WebHaptics } from 'web-haptics'
import './index.css'

// Single shared instance. Web-haptics no-ops on unsupported platforms,
// so no feature detection is required at the call sites.
const haptics = new WebHaptics()

type HoverInfo = {
  cellId: string
} | null

// Theme engine: the set of identifiers a user can pick from in the
// menu's theme selector. Wood is the original warm cream/gold theme;
// win98 is the Minesweeper / Windows 98 homage; audius is the
// music-reactive visualizer layered on top of the Cubekill palette; glass
// is the backlit cathedral stained-glass theme (translucent jewel panes +
// lead came + a shatter-on-clear). The active id lives on
// <html data-theme="..."> and every theme-specific CSS rule is scoped under
// that attribute so switching is a single DOM write.
type ThemeId = 'wood' | 'win98' | 'audius' | 'glass' | 'mondrian'

const THEME_OPTIONS: { id: ThemeId; label: string }[] = [
  { id: 'wood', label: 'Cubekill (default)' },
  { id: 'win98', label: 'Windows 98' },
  { id: 'audius', label: 'Music Visualizer' },
  { id: 'glass', label: 'Stained Glass' },
  { id: 'mondrian', label: 'Abstract' },
]

type AudiusTrack = {
  id: string
  title: string
  duration: number
  bpm: number | null
  artwork?: string
  userId?: string
  playlistsContainingTrackIds?: number[]
  albumBacklinkId?: number | string
  user?: {
    id?: string
    name?: string
    handle?: string
  }
}

type AudiusCollection = {
  id: string
  name: string
  isAlbum: boolean
  playlistId: number | null
  userId?: string
  trackIds: string[]
  trackCount: number
}

type AudiusAlbumQueue = {
  id: string
  name: string
  tracks: AudiusTrack[]
}

type PlayAudiusTrackOptions = {
  resolveAlbum?: boolean
  fallbackOnError?: boolean
}

type AudiusRepeatMode = 'none' | 'album' | 'track'
type AudiusAlbumResolveStatus = 'idle' | 'resolving' | 'resolved'

const AUDIUS_APP_NAME = 'cubekill-visualizer-poc'
// Audius now recommends the canonical REST server for querying and streaming.
// Keeping the player on that stable host avoids random discovery-node streams
// that can intermittently reject CORS or fail media playback.
const AUDIUS_API_BASE = 'https://api.audius.co/v1'
const audiusApiBase = AUDIUS_API_BASE
const ensureAudiusApiBase = (): Promise<string> =>
  Promise.resolve(AUDIUS_API_BASE)
const AUDIUS_ANALYSER_SILENT_FRAME_LIMIT = 90
const AUDIUS_ANALYSER_SILENCE_EPSILON = 1
const AUDIUS_MIN_DYNAMIC_RANGE = 14
const AUDIUS_VISUAL_FRAME_MS = 1000 / 30
const AUDIUS_STAGE_BEAT_CLASSES = [
  'audius-stage-beat-a',
  'audius-stage-beat-b',
] as const
const AUDIUS_VISUAL_PROPERTIES = [
  '--audius-bass',
  '--audius-mid',
  '--audius-treble',
  '--audius-onset',
  '--audius-intensity',
  '--audius-breath',
  '--audius-meter-bass',
  '--audius-meter-mid',
  '--audius-meter-treble',
  '--audius-meter-onset',
  '--audius-deck-hot',
  '--audius-board-ambience',
  '--audius-stage-scale',
  '--audius-viz-hue',
  '--audius-cube-hue-rotate',
]

type AudiusStageVisualState = {
  bass: number
  mid: number
  treble: number
  onset: number
  intensity: number
  breath: number
  hue: number
  playing: boolean
}

const clearAudiusStageCanvas = (canvas: HTMLCanvasElement | null) => {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
}

const AUDIUS_BAR_HUE_STEP = 4.4

// Cached layout for the EQ canvas. Geometry and the log-spaced band
// boundaries only change on resize, so we precompute them once (via a
// ResizeObserver) instead of every animation frame.
type AudiusStageGeometry = {
  spectrum: number
  cssWidth: number
  cssHeight: number
  dpr: number
  columns: number
  columnWidth: number
  step: number
  halfGap: number
  baseY: number
  minBar: number
  span: number
  bandStart: Int16Array
  bandEnd: Int16Array
  lift: Float32Array
}

const measureAudiusStage = (
  canvas: HTMLCanvasElement,
  spectrumLength: number,
): AudiusStageGeometry => {
  const rect = canvas.getBoundingClientRect()
  const cssWidth = Math.max(1, Math.round(rect.width))
  const cssHeight = Math.max(1, Math.round(rect.height))
  // Bars are simple flat shapes, so a 1.5x backing store is plenty crisp
  // while keeping fill-rate (the mobile bottleneck) in check.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
  const backingWidth = Math.round(cssWidth * dpr)
  const backingHeight = Math.round(cssHeight * dpr)
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth
    canvas.height = backingHeight
  }
  const columns = Math.max(28, Math.min(48, Math.floor(cssWidth / 12)))
  const columnGap = Math.max(1.5, cssWidth * 0.0035)
  const columnWidth = cssWidth / columns - columnGap
  const bandStart = new Int16Array(columns)
  const bandEnd = new Int16Array(columns)
  const lift = new Float32Array(columns)
  const usableBins = Math.max(2, spectrumLength - 1)
  const logMax = Math.log(usableBins) // log(1) == 0, so logMin drops out
  for (let i = 0; i < columns; i += 1) {
    const start = spectrumLength
      ? Math.max(1, Math.floor(Math.exp(logMax * (i / columns))))
      : 0
    const end = spectrumLength
      ? Math.max(start + 1, Math.floor(Math.exp(logMax * ((i + 1) / columns))))
      : 0
    bandStart[i] = start
    bandEnd[i] = Math.min(end, spectrumLength)
    const position = columns <= 1 ? 0 : i / (columns - 1)
    const lowLift = Math.max(0, 1 - position / 0.28)
    const highLift = Math.max(0, (position - 0.62) / 0.38)
    lift[i] = 1 + lowLift * 0.16 + highLift * 0.32
  }
  return {
    spectrum: spectrumLength,
    cssWidth,
    cssHeight,
    dpr,
    columns,
    columnWidth,
    step: columnWidth + columnGap,
    halfGap: columnGap * 0.5,
    baseY: cssHeight * 0.94,
    minBar: cssHeight * 0.012,
    span: cssHeight * 0.82,
    bandStart,
    bandEnd,
    lift,
  }
}

const drawAudiusStageCanvas = (
  canvas: HTMLCanvasElement | null,
  frequencyData: Uint8Array<ArrayBuffer> | null,
  visual: AudiusStageVisualState,
  geom: AudiusStageGeometry | null,
) => {
  if (!canvas || !geom) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const {
    cssWidth,
    cssHeight,
    dpr,
    columns,
    columnWidth,
    step,
    halfGap,
    baseY,
    minBar,
    span,
    bandStart,
    bandEnd,
    lift,
  } = geom
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  // Per-frame frequency readout: strongest bin per band, no smoothing/decay
  // in the draw layer (temporal smoothing lives on the analyser instead).
  const freq = visual.playing ? frequencyData : null
  const hue = visual.hue
  for (let i = 0; i < columns; i += 1) {
    let peak = 0
    if (freq) {
      const end = bandEnd[i]
      for (let bin = bandStart[i]; bin < end; bin += 1) {
        const value = freq[bin]
        if (value > peak) peak = value
      }
    }
    const shaped = peak > 0 ? (peak / 255) * lift[i] - 0.02 : 0
    // Gamma > 1 transfer curve keeps the response monotonic (accurate) while
    // pushing quiet bands toward empty so only loud ones approach full.
    const energy = shaped > 0 ? Math.min(1, Math.pow(shaped, 1.7)) : 0
    const barHeight = energy > 0 ? Math.max(2, minBar + energy * span) : 2
    const x = i * step + halfGap
    const y = baseY - barHeight
    ctx.fillStyle = `hsla(${(hue + i * AUDIUS_BAR_HUE_STEP) % 360}, 92%, ${
      48 + energy * 24
    }%, ${0.1 + energy * 0.46})`
    ctx.fillRect(x, y, columnWidth, barHeight)
  }
}

const buildAudiusApiUrl = (
  path: string,
  params: Record<string, string | number | boolean> = {},
): string => {
  const search = new URLSearchParams({ app_name: AUDIUS_APP_NAME })
  Object.entries(params).forEach(([key, value]) => {
    search.set(key, String(value))
  })
  return `${audiusApiBase}${path}?${search.toString()}`
}

const buildAudiusStreamUrl = (id: string): string =>
  `${audiusApiBase}/tracks/${id}/stream?app_name=${AUDIUS_APP_NAME}`

const normalizeAudiusPlaylistIds = (value: unknown): number[] => {
  if (!Array.isArray(value)) return []
  return value.filter((id): id is number => typeof id === 'number')
}

const normalizeAudiusAlbumBacklinkId = (
  value: unknown,
): number | string | undefined => {
  if (typeof value === 'number' || typeof value === 'string') return value
  if (!value || typeof value !== 'object') return undefined
  const item = value as { id?: unknown; playlist_id?: unknown }
  if (typeof item.id === 'string' || typeof item.id === 'number') return item.id
  if (typeof item.playlist_id === 'number') return item.playlist_id
  return undefined
}

// Audius returns artwork as a map of square sizes ("150x150" / "480x480" /
// "1000x1000"). Prefer the mid size — crisp on a ~54px tile at 2x DPR without
// pulling the full-res master into a thumbnail.
const normalizeAudiusArtwork = (raw: unknown): string | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const art = raw as Record<string, unknown>
  const candidates = ['480x480', '1000x1000', '150x150']
  for (const key of candidates) {
    const value = art[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

const normalizeAudiusTracks = (data: unknown): AudiusTrack[] => {
  if (!Array.isArray(data)) return []
  return data
    .map((raw): AudiusTrack | null => {
      if (!raw || typeof raw !== 'object') return null
      const item = raw as {
        id?: unknown
        title?: unknown
        duration?: unknown
        bpm?: unknown
        artwork?: unknown
        user_id?: unknown
        user?: unknown
        is_stream_gated?: unknown
        playlists_containing_track?: unknown
        album_backlink?: unknown
      }
      if (item.is_stream_gated === true) return null
      if (typeof item.id !== 'string') return null
      if (typeof item.title !== 'string' || item.title.trim() === '') return null
      const user =
        item.user && typeof item.user === 'object'
          ? (item.user as { id?: unknown; name?: unknown; handle?: unknown })
          : undefined
      const userId =
        typeof item.user_id === 'string'
          ? item.user_id
          : typeof user?.id === 'string'
            ? user.id
            : undefined
      return {
        id: item.id,
        title: item.title,
        duration: typeof item.duration === 'number' ? item.duration : 0,
        bpm: typeof item.bpm === 'number' && item.bpm > 0 ? item.bpm : null,
        artwork: normalizeAudiusArtwork(item.artwork),
        userId,
        playlistsContainingTrackIds: normalizeAudiusPlaylistIds(
          item.playlists_containing_track,
        ),
        albumBacklinkId: normalizeAudiusAlbumBacklinkId(item.album_backlink),
        user: user
          ? {
              id: typeof user.id === 'string' ? user.id : undefined,
              name: typeof user.name === 'string' ? user.name : undefined,
              handle: typeof user.handle === 'string' ? user.handle : undefined,
            }
          : undefined,
      }
    })
    .filter((track): track is AudiusTrack => track != null)
}

const normalizeAudiusCollections = (data: unknown): AudiusCollection[] => {
  if (!Array.isArray(data)) return []
  return data
    .map((raw): AudiusCollection | null => {
      if (!raw || typeof raw !== 'object') return null
      const item = raw as {
        id?: unknown
        playlist_id?: unknown
        playlist_name?: unknown
        playlistName?: unknown
        is_album?: unknown
        isAlbum?: unknown
        user_id?: unknown
        user?: unknown
        track_count?: unknown
        playlist_contents?: unknown
      }
      if (typeof item.id !== 'string') return null
      const name =
        typeof item.playlist_name === 'string'
          ? item.playlist_name
          : typeof item.playlistName === 'string'
            ? item.playlistName
            : ''
      if (!name.trim()) return null
      const user =
        item.user && typeof item.user === 'object'
          ? (item.user as { id?: unknown })
          : undefined
      const trackIds = Array.isArray(item.playlist_contents)
        ? item.playlist_contents
            .map((entry) => {
              if (!entry || typeof entry !== 'object') return null
              const trackId = (entry as { track_id?: unknown }).track_id
              return typeof trackId === 'string' ? trackId : null
            })
            .filter((trackId): trackId is string => trackId != null)
        : []
      return {
        id: item.id,
        name,
        isAlbum: item.is_album === true || item.isAlbum === true,
        playlistId:
          typeof item.playlist_id === 'number' ? item.playlist_id : null,
        userId:
          typeof item.user_id === 'string'
            ? item.user_id
            : typeof user?.id === 'string'
              ? user.id
              : undefined,
        trackIds,
        trackCount:
          typeof item.track_count === 'number' ? item.track_count : trackIds.length,
      }
    })
    .filter((collection): collection is AudiusCollection => collection != null)
}

const formatAudiusDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

type AudiusPlaybackSnapshot = {
  selectedTrackId: string | null
  searchQuery: string
  tracks: AudiusTrack[]
  position: number
  duration: number
  wasPlaying: boolean
  savedAt: number
}

const AUDIUS_PLAYBACK_SNAPSHOT_KEY = 'cubic-audius-playback-v1'
const AUDIUS_PLAYBACK_MAX_TRACKS = 40

const sanitizeAudiusTrackCache = (value: unknown): AudiusTrack[] =>
  normalizeAudiusTracks(Array.isArray(value) ? value : [])

const readAudiusPlaybackSnapshot = (): AudiusPlaybackSnapshot | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(AUDIUS_PLAYBACK_SNAPSHOT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<AudiusPlaybackSnapshot>
    const tracks = sanitizeAudiusTrackCache(parsed.tracks)
    return {
      selectedTrackId:
        typeof parsed.selectedTrackId === 'string'
          ? parsed.selectedTrackId
          : null,
      searchQuery:
        typeof parsed.searchQuery === 'string' && parsed.searchQuery.trim()
          ? parsed.searchQuery
          : 'lofi',
      tracks,
      position:
        typeof parsed.position === 'number' && Number.isFinite(parsed.position)
          ? Math.max(0, parsed.position)
          : 0,
      duration:
        typeof parsed.duration === 'number' && Number.isFinite(parsed.duration)
          ? Math.max(0, parsed.duration)
          : 0,
      wasPlaying: parsed.wasPlaying === true,
      savedAt:
        typeof parsed.savedAt === 'number' && Number.isFinite(parsed.savedAt)
          ? parsed.savedAt
          : 0,
    }
  } catch {
    return null
  }
}

const writeAudiusPlaybackSnapshot = (
  snapshot: AudiusPlaybackSnapshot,
): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      AUDIUS_PLAYBACK_SNAPSHOT_KEY,
      JSON.stringify({
        ...snapshot,
        tracks: snapshot.tracks.slice(0, AUDIUS_PLAYBACK_MAX_TRACKS),
      }),
    )
  } catch {
    // Best-effort persistence only.
  }
}

// === Procedural score-tier palette =================================
// The cube color palette used to be a four-step lookup table in CSS
// (`.cubic-viewport[data-score-tier="1..4"]`), which capped the
// progression at 4000 points. Players are now reaching 15k+, so the
// system is now computed in JS off the integer tier index and pushed
// onto the viewport as inline CSS custom properties. Tier 0 still
// falls through to the `:root` defaults — that path is preserved so
// daily mode and fresh runs look exactly like before.
//
// Recipe:
//   - hue = (tier * GOLDEN_ANGLE) mod 360. The golden angle gives
//     maximum visual distance between adjacent tiers, so no two
//     consecutive tiers ever land in the same color family.
//   - A small saturation oscillator keyed off (tier % 3) keeps each
//     tier's energy level slightly different even when the wheel
//     eventually loops around to a nearby hue.
//   - From octave 4 onward (tier ≥ 15), the top/right faces fan out
//     slightly from the base hue (top +6°, right -6°) so the cubes
//     pick up a subtle chromatic shading without any glow, halo, or
//     bloom — purely an in-fill recoloring.
//
// Per-theme tuning: wood lives in the soft 70-80% saturation /
// 60-85% lightness band so the cubes still feel painterly; win98
// pushes saturation to 90%+ and uses a darker lightness ramp to
// keep its punchy "system color" feel.

const TIER_HUE_STEP_DEG = 137.5
const FACE_HUE_SPREAD_OCTAVE_START = 4

const computeTierHue = (tier: number): number => {
  if (tier <= 0) return 0
  const raw = (tier * TIER_HUE_STEP_DEG) % 360
  return raw < 0 ? raw + 360 : raw
}

// Octave numbering matches the design plan:
//   tier 0          → octave 0 (default amber, no extras)
//   tiers 1–4       → octave 1 (hue + outline tint + bg wash drift)
//   tiers 5–9       → octave 2 (+ empty-grid stroke tint)
//   tiers 10–14     → octave 3 (+ cube edge stroke tint)
//   tiers 15–19     → octave 4 (+ per-face hue spread on cubes)
//   tiers 20–24     → octave 5 (+ drifting background pattern)
//   tier 25+        → octave 6+ (hue keeps rotating; no new layer)
const computeScoreOctave = (tier: number): number => {
  if (tier <= 0) return 0
  return Math.floor(tier / 5) + 1
}

// Returns a React-friendly CSS-properties object full of `--cube-*`
// + `--score-tier-accent` + theme-specific overrides. Tier 0 returns
// an empty object so the `:root` defaults win.
const paletteForTier = (
  tier: number,
  octave: number,
  theme: ThemeId,
): React.CSSProperties => {
  if (tier <= 0) return {}
  const baseHue = computeTierHue(tier)
  const inverseHue = (baseHue + 180) % 360
  // Octave 4+ fans the face hues out from the base hue so each face
  // catches a slightly different chromatic tint. Octaves below this
  // keep all three faces locked to the base hue.
  const spreadOn = octave >= FACE_HUE_SPREAD_OCTAVE_START
  const topHue = spreadOn ? (baseHue + 6) % 360 : baseHue
  const rightHue = spreadOn ? (baseHue + 354) % 360 : baseHue
  // Light per-tier energy modulation: cycles through three slightly
  // different saturation amounts so adjacent tiers don't read as a
  // pure hue rotation. tier 1 → +0, tier 2 → +4, tier 3 → +8, repeat.
  const satBump = (tier % 3) * 4
  if (theme === 'win98') {
    const baseSat = 92 + (tier % 2) * 6
    const sat = Math.min(100, baseSat + satBump)
    return {
      '--cube-top': `hsl(${topHue}, ${sat}%, 60%)`,
      '--cube-left': `hsl(${baseHue}, ${sat}%, 40%)`,
      '--cube-right': `hsl(${rightHue}, ${Math.max(60, sat - 5)}%, 22%)`,
      '--score-tier-accent': `hsl(${baseHue}, ${sat}%, 55%)`,
      '--cube-inverse-bright': `hsl(${inverseHue}, ${sat}%, 76%)`,
      '--cube-inverse-dim': `hsl(${inverseHue}, ${Math.max(50, sat - 25)}%, 38%)`,
      '--w98-cube-fill': `hsl(${baseHue}, ${sat}%, 38%)`,
      '--w98-inverse-fill': `hsl(${inverseHue}, ${Math.min(100, sat + 3)}%, 40%)`,
    } as React.CSSProperties
  }
  if (theme === 'glass') {
    // Stained glass: rich, saturated jewel tones. Keep saturation high
    // and lightness in a mid band so the translucent panes stay
    // luminous (never washed-out pastel), with a brighter "lit" top
    // face and a deep leaded base. The faces themselves are painted at
    // reduced fill-opacity in theme-glass.css so the board's backlight
    // glows through; these vars only set the hue/chroma of each pane.
    const sat = Math.min(100, 84 + satBump)
    // The backlight + accent ride the SAME octave rotation as the jewels
    // (see glassOctaveHueShift) instead of the per-tier golden-angle scatter
    // the other themes use — so the light pooling behind the window always
    // belongs to the same color story as the panes in front of it, and the
    // whole composition drifts as one harmonious unit as octaves climb.
    const glassShift = glassOctaveHueShift(octave)
    // Warm daylight behind the window — distinct from cobalt panes and from
    // the neutral-warm empty bays. Octave rotation tints the clerestory light
    // without pulling it back into the same blue band as the jewels.
    const glassLightHue = (42 + glassShift) % 360
    return {
      '--cube-top': `hsl(${topHue}, ${sat}%, 66%)`,
      '--cube-left': `hsl(${baseHue}, ${sat}%, 48%)`,
      '--cube-right': `hsl(${rightHue}, ${Math.max(72, sat - 6)}%, 30%)`,
      '--score-tier-accent': `hsl(${glassLightHue}, ${sat}%, 58%)`,
      '--cube-inverse-bright': `hsl(${inverseHue}, ${sat}%, 70%)`,
      '--cube-inverse-dim': `hsl(${inverseHue}, ${Math.max(60, sat - 14)}%, 42%)`,
      // Drives the backlight glow behind the window so the light that
      // bleeds through the panes shares the jewels' octave-rotated hue.
      '--glass-light-hue': `${glassLightHue}`,
    } as React.CSSProperties
  }
  if (theme === 'mondrian') {
    // De Stijl: the discipline is ONLY three primaries, so we do not let
    // the golden-angle hue drift continuously. Quantize the tier hue to
    // the nearest of red / blue / yellow and snap the whole cube to that
    // primary's fixed, near-flat plane (the heavy black edges in
    // theme-mondrian.css do the structural work, not face shading).
    // Escalation reads as the composition gaining color, expressed by the
    // static octave CSS layers — not a hue sweep.
    const PRIMARIES = [
      { h: 0, top: '#d6342f', left: '#b62027', right: '#8f181d' }, // red
      { h: 222, top: '#2f55c4', left: '#1d3a8f', right: '#142a6b' }, // blue
      { h: 48, top: '#ffd21f', left: '#f3c20b', right: '#caa006' }, // yellow
    ]
    const hueDist = (a: number, b: number) => {
      const d = Math.abs(((a - b) % 360) + 360) % 360
      return Math.min(d, 360 - d)
    }
    const primary = PRIMARIES.reduce((best, p) =>
      hueDist(baseHue, p.h) < hueDist(baseHue, best.h) ? p : best,
    )
    return {
      '--cube-top': primary.top,
      '--cube-left': primary.left,
      '--cube-right': primary.right,
      '--score-tier-accent': 'var(--md-yellow)',
      // About-to-clear drains to clean white; dim companion is the neutral
      // grey plane so the doomed cluster reads as "draining" not recoloring.
      '--cube-inverse-bright': '#ffffff',
      '--cube-inverse-dim': 'var(--md-grey)',
    } as React.CSSProperties
  }
  // Wood theme: softer saturation, brighter top face for the
  // painterly "ambient light" cube look.
  const baseSat = 78 + satBump
  return {
    '--cube-top': `hsl(${topHue}, ${baseSat}%, 84%)`,
    '--cube-left': `hsl(${baseHue}, ${baseSat - 4}%, 62%)`,
    '--cube-right': `hsl(${rightHue}, ${baseSat - 10}%, 38%)`,
    '--score-tier-accent': `hsl(${baseHue}, ${baseSat}%, 58%)`,
    '--cube-inverse-bright': `hsl(${inverseHue}, ${baseSat - 5}%, 82%)`,
    '--cube-inverse-dim': `hsl(${inverseHue}, ${Math.max(40, baseSat - 28)}%, 40%)`,
  } as React.CSSProperties
}

const HEX_SIZE = 32
const SQRT3 = Math.sqrt(3)

// Stained-glass theme: the circular carved-stone rose-window frame has been
// retired in favor of showing the masonry wall directly around the board
// (the lit blue glass is clipped to the hex panes instead). Flip to `true`
// to bring the frame back.
const SHOW_GLASS_ROSE_FRAME = false

// ---------------------------------------------------------------------------
// Stained-glass jewel palette
// ---------------------------------------------------------------------------
// In the glass theme every cube is cut from one of four real stained-glass
// colors — sapphire (deep navy), turquoise, emerald, amethyst — instead of
// the shared score-tier hue. A piece spawns into the hand with a color per
// cube; that color is deterministic from the piece id + cube index, so the
// hand preview and the eventual board placement always agree, and the color
// persists on the board after the piece is gone (see `glassCellColors`).
//
// Each jewel gives the three cube facets: a brighter lit top, a mid left,
// and a deep leaded right. The panes are painted at reduced fill-opacity in
// theme-glass.css so the backlight glows through; these are the hue/chroma.
type JewelFacets = {
  '--cube-top': string
  '--cube-left': string
  '--cube-right': string
}
const GLASS_JEWELS: JewelFacets[] = [
  // Cobalt — deep royal blue (cool, clearly not teal or empty-pane wash)
  { '--cube-top': '#4a7de8', '--cube-left': '#2456b8', '--cube-right': '#123070' },
  // Amber — warm gold (max separation from the blues)
  { '--cube-top': '#f0b830', '--cube-left': '#c88610', '--cube-right': '#805608' },
  // Emerald — saturated green
  { '--cube-top': '#40d070', '--cube-left': '#18a050', '--cube-right': '#0a6030' },
  // Amethyst — rich violet (far from cobalt on the wheel)
  { '--cube-top': '#b070e8', '--cube-left': '#8040c0', '--cube-right': '#481878' },
]

// Small deterministic string hash (FNV-1a). Stable across renders/reloads so
// a given piece-cube always maps to the same jewel.
const hashString = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const jewelIndexForPieceCube = (pieceId: string, cubeIndex: number): number =>
  hashString(`${pieceId}:${cubeIndex}`) % GLASS_JEWELS.length

const jewelStyle = (
  index: number,
  hueShift = 0,
): React.CSSProperties => {
  const jewel =
    GLASS_JEWELS[
      ((index % GLASS_JEWELS.length) + GLASS_JEWELS.length) %
        GLASS_JEWELS.length
    ]
  return hueShift % 360 === 0
    ? (jewel as unknown as React.CSSProperties)
    : rotateJewelFacets(jewel, hueShift)
}

// De Stijl primary palette for the Abstract theme. A "cube" renders as a
// FLAT hexagon here (theme-mondrian.css hides the isometric edges + per-face
// shading), so all three facets carry the SAME pure color — a flat painted
// plane, not a shaded block. The fourth entry is the neutral grey De Stijl
// uses sparingly. Length matches GLASS_JEWELS (4) so the shared
// jewelIndexForPieceCube() hashing assigns a stable color per piece-cube for
// both themes: the color is set when a piece is dealt, follows it into the
// hand preview, persists onto the board (glassCellColors), and is echoed in
// the piecetiary — exactly like the cathedral jewels.
const MONDRIAN_PRIMARIES: JewelFacets[] = [
  { '--cube-top': '#c8252b', '--cube-left': '#c8252b', '--cube-right': '#c8252b' }, // red
  { '--cube-top': '#1d3a8f', '--cube-left': '#1d3a8f', '--cube-right': '#1d3a8f' }, // blue
  { '--cube-top': '#f3c20b', '--cube-left': '#f3c20b', '--cube-right': '#f3c20b' }, // yellow
  { '--cube-top': '#7a746a', '--cube-left': '#7a746a', '--cube-right': '#7a746a' }, // neutral grey
]
const primaryStyle = (index: number): React.CSSProperties =>
  MONDRIAN_PRIMARIES[
    ((index % MONDRIAN_PRIMARIES.length) + MONDRIAN_PRIMARIES.length) %
      MONDRIAN_PRIMARIES.length
  ] as unknown as React.CSSProperties

// Self-rendered cube palette in the wood theme. Mirrors the
// `--cube-{top,right,left}` defaults declared in index.css. We hold
// JS copies here because per-partner tinting computes the rotated /
// lightened variants in JavaScript and assigns them as inline
// CSS custom properties — using `filter: hue-rotate()` on the SVG
// `<g>` wrappers turned out to be unreliable across nested transform
// groups, and `hue-rotate` itself is a linear color matrix that
// barely shifts mid-saturation teals (so two partners ended up
// reading as the same color even when their hue values differed).
// The win98 partner fill is the explicit "lighter teal" base used
// when filtering is in effect — we keep using it as the *self* base
// for partner cells in win98 too, then rotate from there in JS.
const WOOD_CUBE_TOP_HEX = '#ffeaa3'
const WOOD_CUBE_RIGHT_HEX = '#a04a18'
const WOOD_CUBE_LEFT_HEX = '#f9a23f'
const W98_PARTNER_FILL_HEX = '#6fbcbc'
// Win98 self cube fill. Matches `--w98-cube-fill` in theme-win98.css
// so PvP territory tints can use the same teal the player's cubes
// actually paint with (the wood-theme constants above produce a
// warm gold that's wrong in this theme).
const W98_SELF_FILL_HEX = '#008080'

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

const rgbToHex = (r: number, g: number, b: number): string => {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

const rgbToHsl = (
  r: number,
  g: number,
  b: number,
): [number, number, number] => {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60
    else if (max === gn) h = ((bn - rn) / d + 2) * 60
    else h = ((rn - gn) / d + 4) * 60
  }
  return [h, s, l]
}

const hslToRgb = (
  h: number,
  s: number,
  l: number,
): [number, number, number] => {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = ((h % 360) + 360) % 360 / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = l - c / 2
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
}

// Rotate the hue of `hex` by `deg` and apply a small lightness/
// saturation tweak so partner cubes always read as visibly tinted
// even when `deg === 0` (i.e. self-relative offset is the floor of
// the lightening pass — the wood/win98 themes used to do this with
// `brightness()` / `saturate()` filters, but those don't compose on
// SVG groups so we bake the same effect into the output color here).
const tintCubeColor = (
  hex: string,
  deg: number,
  lightnessAdd: number,
  saturationMul: number,
): string => {
  const [r, g, b] = hexToRgb(hex)
  const [h, s, l] = rgbToHsl(r, g, b)
  const nh = h + deg
  const ns = Math.max(0, Math.min(1, s * saturationMul))
  const nl = Math.max(0, Math.min(1, l + lightnessAdd))
  const [nr, ng, nb] = hslToRgb(nh, ns, nl)
  return rgbToHex(nr, ng, nb)
}

// Per-octave hue rotation for the stained-glass jewels (and the backlight
// that bleeds through them). 30° is a clean twelfth of the color wheel, so:
//   • every octave is a rigid rotation of the SAME four jewels — their
//     mutual spacing (and therefore the palette's harmony) is identical at
//     octave 1 and octave 40; only the window's overall color story drifts;
//   • the sequence is bounded and predictable (it cycles every 12 octaves),
//     passing through a full complement of the base palette at octave 6.
// This is the guard against "hideous at high octaves": we never invent new,
// clashing hue *relationships*, we only spin the balanced quartet around.
const GLASS_OCTAVE_HUE_STEP = 30

// Rigidly rotate a jewel's three facets by `deg`, preserving each facet's
// saturation + lightness (so the lit-top / mid-left / deep-right structure
// survives the spin and the panes stay luminous rather than washing out).
const rotateJewelFacets = (
  jewel: JewelFacets,
  deg: number,
): React.CSSProperties => {
  const rot = (hex: string): string => {
    const [r, g, b] = hexToRgb(hex)
    const [h, s, l] = rgbToHsl(r, g, b)
    const [nr, ng, nb] = hslToRgb(h + deg, s, l)
    return rgbToHex(nr, ng, nb)
  }
  return {
    '--cube-top': rot(jewel['--cube-top']),
    '--cube-left': rot(jewel['--cube-left']),
    '--cube-right': rot(jewel['--cube-right']),
  } as unknown as React.CSSProperties
}

// The hue rotation applied to the glass palette at a given score octave.
// Octave 0 (game start) is the untouched base quartet; each octave after
// that adds one clean wheel-step. Shared by the jewels and the backlight so
// the whole window drifts in lockstep.
const glassOctaveHueShift = (octave: number): number =>
  octave > 0 ? (octave * GLASS_OCTAVE_HUE_STEP) % 360 : 0

// Resolve the on-screen score counter element for the active theme.
// Wood theme renders the score in `.hexaclear-live-stat .value`;
// Win98 hides that and renders it as a 7-segment LCD on the right
// side of the LCD row (`.hexaclear-win98-lcd-score .lcd-frame`).
// The score-fly particle queries this every frame to land at the
// correct readout regardless of which theme is live.
function getScoreCounterEl(): Element | null {
  if (typeof document === 'undefined') return null
  const theme = document.documentElement.dataset.theme
  if (theme === 'win98') {
    return (
      document.querySelector('.hexaclear-win98-lcd-score .lcd-frame') ??
      document.querySelector('.hexaclear-live-stat .value')
    )
  }
  if (theme === 'audius') {
    return (
      document.querySelector(
        '.hexaclear-audius-readout-live .readout-value',
      ) ?? document.querySelector('.hexaclear-live-stat .value')
    )
  }
  return document.querySelector('.hexaclear-live-stat .value')
}
const DEBUG_SHOW_COORDS = false

// Mapping from polygon edge index (0..5) to axial neighbor direction index.
// With our pointy-top axial coordinates and hex vertex angles at
// -30, 30, 90, 150, 210, 270 degrees, the edge mid-angles are:
// 0, 60, 120, 180, 240, 300 degrees. These correspond to axial
// directions (1,0), (0,1), (-1,1), (-1,0), (0,-1), (1,-1) respectively.
const EDGE_DIRECTION_INDEX = [0, 5, 4, 3, 2, 1] as const

const axialToPixel = (q: number, r: number) => {
  const x = HEX_SIZE * (SQRT3 * q + (SQRT3 / 2) * r)
  const y = HEX_SIZE * (1.5 * r)
  return { x, y }
}

type BoardLayout = {
  positions: Record<string, { x: number; y: number }>
  width: number
  height: number
  offsetX: number
  offsetY: number
}

const buildLayout = (boardDef: BoardDefinition): BoardLayout => {
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  const positions: Record<string, { x: number; y: number }> = {}

  for (const cell of boardDef.cells) {
    const { x, y } = axialToPixel(cell.coord.q, cell.coord.r)
    positions[cell.id] = { x, y }
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  }

  const width = maxX - minX + HEX_SIZE * 2.5
  const height = maxY - minY + HEX_SIZE * 2.5

  return {
    positions,
    width,
    height,
    offsetX: -minX + HEX_SIZE * 1.25,
    offsetY: -minY + HEX_SIZE * 1.25,
  }
}

type Segment = { x1: number; y1: number; x2: number; y2: number }

// Inset distances (in user units, same coordinate space as
// HEX_SIZE = 32) for the two parallel lines that paint the
// rosette etched groove. The bevel covers user units 0..4 from
// the polygon edge; we leave a 1.5u gap so the groove reads as
// a separate carved channel rather than a continuation of the
// bevel.
const ROSETTE_GROOVE_DARK_INSET = 5.5
const ROSETTE_GROOVE_LIGHT_INSET = 7

// Build the perimeter segments for every rosette in the board. Used by
// the Wood theme to lightly outline each flower group of cells. Walks
// every cell inside the rosette (radius-r hex region) and emits the
// edges that border a non-rosette cell. Works for any flower radius.
const buildFlowerBoundarySegments = (
  boardDef: BoardDefinition,
  layout: BoardLayout,
  geometry: BoardGeometry,
): Segment[] => {
  const segments: Segment[] = []
  const idToCell = new Map(
    boardDef.cells.map((c) => [c.id, c] as const),
  )

  for (const center of geometry.flowerCenters) {
    const cellIds: string[] = []
    for (let dq = -geometry.flowerRadius; dq <= geometry.flowerRadius; dq++) {
      const drMin = Math.max(-geometry.flowerRadius, -dq - geometry.flowerRadius)
      const drMax = Math.min(geometry.flowerRadius, -dq + geometry.flowerRadius)
      for (let dr = drMin; dr <= drMax; dr++) {
        cellIds.push(axialToId({ q: center.q + dq, r: center.r + dr }))
      }
    }
    const cellSet = new Set(cellIds)

    for (const cellId of cellIds) {
      const cell = idToCell.get(cellId)
      if (!cell) continue
      const pos = layout.positions[cellId]
      const cx = pos.x + layout.offsetX
      const cy = pos.y + layout.offsetY

      for (let side = 0; side < 6; side++) {
        const dir = directions[EDGE_DIRECTION_INDEX[side]]
        const neighborCoord = addAxial(cell.coord, dir)
        const neighborId = axialToId(neighborCoord)
        if (cellSet.has(neighborId)) {
          continue
        }

        const angleA = ((60 * side - 30) * Math.PI) / 180
        const angleB = ((60 * ((side + 1) % 6) - 30) * Math.PI) / 180
        const x1 = cx + HEX_SIZE * Math.cos(angleA)
        const y1 = cy + HEX_SIZE * Math.sin(angleA)
        const x2 = cx + HEX_SIZE * Math.cos(angleB)
        const y2 = cy + HEX_SIZE * Math.sin(angleB)
        segments.push({ x1, y1, x2, y2 })
      }
    }
  }

  return segments
}

// Closed-loop rosette boundaries with proper inset polygons for
// the Win98 etched-groove rendering. For each rosette we:
//   1. Collect every cell-side segment that sits on the outer
//      perimeter of the 7-cell flower.
//   2. Stitch those segments into one ordered closed loop of
//      vertices.
//   3. Inset the loop by two perpendicular distances (the dark
//      and light groove offsets) using the angle-bisector
//      method so the resulting polygons stay parallel to the
//      original boundary at every corner — including corners
//      where two different rosette cells meet, which the older
//      per-cell-per-side approach broke up.
type Vec2 = { x: number; y: number }

const stitchClosedLoop = (segs: Segment[]): Vec2[] => {
  if (segs.length === 0) return []
  const eps = 0.5
  const same = (a: Vec2, b: Vec2) =>
    Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps
  const remaining = segs.map((s) => ({
    a: { x: s.x1, y: s.y1 },
    b: { x: s.x2, y: s.y2 },
  }))
  const result: Vec2[] = []
  const first = remaining.shift()!
  result.push(first.a)
  let endpoint: Vec2 = first.b
  while (remaining.length > 0) {
    let foundIdx = -1
    let nextEndpoint: Vec2 | null = null
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i]
      if (same(s.a, endpoint)) {
        foundIdx = i
        nextEndpoint = s.b
        break
      }
      if (same(s.b, endpoint)) {
        foundIdx = i
        nextEndpoint = s.a
        break
      }
    }
    if (foundIdx < 0) break
    result.push(endpoint)
    endpoint = nextEndpoint as Vec2
    remaining.splice(foundIdx, 1)
  }
  return result
}

const insetClosedLoop = (
  verts: Vec2[],
  dist: number,
  inwardRef: Vec2,
): Vec2[] => {
  const n = verts.length
  if (n < 3) return verts.map((v) => ({ ...v }))
  const result: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n]
    const curr = verts[i]
    const next = verts[(i + 1) % n]

    const e1x = curr.x - prev.x
    const e1y = curr.y - prev.y
    const e1len = Math.hypot(e1x, e1y)
    const e1nx = e1x / e1len
    const e1ny = e1y / e1len
    const e2x = next.x - curr.x
    const e2y = next.y - curr.y
    const e2len = Math.hypot(e2x, e2y)
    const e2nx = e2x / e2len
    const e2ny = e2y / e2len

    // Pick whichever perpendicular of each edge points toward
    // the inward reference point (the rosette center). The two
    // candidates are (-edgeY, edgeX) and (edgeY, -edgeX); we
    // resolve the ambiguity per-edge using a dot-product sign
    // check against the midpoint→center vector.
    const mid1x = (prev.x + curr.x) / 2
    const mid1y = (prev.y + curr.y) / 2
    const toRef1x = inwardRef.x - mid1x
    const toRef1y = inwardRef.y - mid1y
    let n1x = -e1ny
    let n1y = e1nx
    if (n1x * toRef1x + n1y * toRef1y < 0) {
      n1x = -n1x
      n1y = -n1y
    }
    const mid2x = (curr.x + next.x) / 2
    const mid2y = (curr.y + next.y) / 2
    const toRef2x = inwardRef.x - mid2x
    const toRef2y = inwardRef.y - mid2y
    let n2x = -e2ny
    let n2y = e2nx
    if (n2x * toRef2x + n2y * toRef2y < 0) {
      n2x = -n2x
      n2y = -n2y
    }

    const bx = n1x + n2x
    const by = n1y + n2y
    const blen = Math.hypot(bx, by)
    const bnx = bx / blen
    const bny = by / blen
    // Distance along the bisector that produces the requested
    // perpendicular distance from each adjacent edge.
    const cosHalf = bnx * n1x + bny * n1y
    const D = dist / cosHalf

    result.push({
      x: curr.x + bnx * D,
      y: curr.y + bny * D,
    })
  }
  return result
}

// Closed-loop, etched-groove polygons for every rosette. Stitches each
// rosette's perimeter into a continuous loop, then offsets it inward by
// two perpendicular distances for the dark/light groove pair. Same
// idea as buildFlowerBoundarySegments above, just walked through the
// stitcher so consecutive segments share a vertex.
const buildFlowerBoundaryLoops = (
  boardDef: BoardDefinition,
  layout: BoardLayout,
  geometry: BoardGeometry,
): { dark: Vec2[]; light: Vec2[] }[] => {
  const loops: { dark: Vec2[]; light: Vec2[] }[] = []
  const idToCell = new Map(
    boardDef.cells.map((c) => [c.id, c] as const),
  )

  for (const center of geometry.flowerCenters) {
    const centerId = axialToId(center)
    const cellIds: string[] = []
    for (let dq = -geometry.flowerRadius; dq <= geometry.flowerRadius; dq++) {
      const drMin = Math.max(-geometry.flowerRadius, -dq - geometry.flowerRadius)
      const drMax = Math.min(geometry.flowerRadius, -dq + geometry.flowerRadius)
      for (let dr = drMin; dr <= drMax; dr++) {
        cellIds.push(axialToId({ q: center.q + dq, r: center.r + dr }))
      }
    }
    const cellSet = new Set(cellIds)

    const segs: Segment[] = []
    for (const cellId of cellIds) {
      const cell = idToCell.get(cellId)
      if (!cell) continue
      const pos = layout.positions[cellId]
      const cx = pos.x + layout.offsetX
      const cy = pos.y + layout.offsetY
      for (let side = 0; side < 6; side++) {
        const dir = directions[EDGE_DIRECTION_INDEX[side]]
        const neighborCoord = addAxial(cell.coord, dir)
        const neighborId = axialToId(neighborCoord)
        if (cellSet.has(neighborId)) continue
        const angleA = ((60 * side - 30) * Math.PI) / 180
        const angleB = ((60 * ((side + 1) % 6) - 30) * Math.PI) / 180
        segs.push({
          x1: cx + HEX_SIZE * Math.cos(angleA),
          y1: cy + HEX_SIZE * Math.sin(angleA),
          x2: cx + HEX_SIZE * Math.cos(angleB),
          y2: cy + HEX_SIZE * Math.sin(angleB),
        })
      }
    }

    if (segs.length === 0) {
      loops.push({ dark: [], light: [] })
      continue
    }

    const ordered = stitchClosedLoop(segs)
    const centerPos = layout.positions[centerId]
    const inwardRef: Vec2 = {
      x: centerPos.x + layout.offsetX,
      y: centerPos.y + layout.offsetY,
    }
    loops.push({
      dark: insetClosedLoop(
        ordered,
        ROSETTE_GROOVE_DARK_INSET,
        inwardRef,
      ),
      light: insetClosedLoop(
        ordered,
        ROSETTE_GROOVE_LIGHT_INSET,
        inwardRef,
      ),
    })
  }

  return loops
}

// Exterior outline of the whole board: all hex edges whose neighbor is not
// another board cell, de-duped so we get a single continuous hex-shaped hull.
const buildBoardOutlineSegments = (
  boardDef: BoardDefinition,
  layout: BoardLayout,
): Segment[] => {
  const segments: Segment[] = []
  const cellSet = new Set(boardDef.cells.map((c) => c.id))
  const seen = new Set<string>()

  for (const cell of boardDef.cells) {
    const pos = layout.positions[cell.id]
    const cx = pos.x + layout.offsetX
    const cy = pos.y + layout.offsetY

    for (let side = 0; side < 6; side++) {
      const dir = directions[EDGE_DIRECTION_INDEX[side]]
      const neighborCoord = addAxial(cell.coord, dir)
      const neighborId = axialToId(neighborCoord)
      if (cellSet.has(neighborId)) continue

      const angleA = ((60 * side - 30) * Math.PI) / 180
      const angleB = ((60 * ((side + 1) % 6) - 30) * Math.PI) / 180
      const x1 = cx + HEX_SIZE * Math.cos(angleA)
      const y1 = cy + HEX_SIZE * Math.sin(angleA)
      const x2 = cx + HEX_SIZE * Math.cos(angleB)
      const y2 = cy + HEX_SIZE * Math.sin(angleB)

      const key =
        x1 <= x2
          ? `${x1.toFixed(2)},${y1.toFixed(2)}|${x2.toFixed(2)},${y2.toFixed(
              2,
            )}`
          : `${x2.toFixed(2)},${y2.toFixed(2)}|${x1.toFixed(2)},${y1.toFixed(
              2,
            )}`
      if (seen.has(key)) continue
      seen.add(key)

      segments.push({ x1, y1, x2, y2 })
    }
  }

  return segments
}

const segmentKey = (seg: Segment): string =>
  seg.x1 <= seg.x2
    ? `${seg.x1.toFixed(2)},${seg.y1.toFixed(2)}|${seg.x2.toFixed(2)},${seg.y2.toFixed(2)}`
    : `${seg.x2.toFixed(2)},${seg.y2.toFixed(2)}|${seg.x1.toFixed(2)},${seg.y1.toFixed(2)}`

const hexEdgeSegment = (
  cx: number,
  cy: number,
  side: number,
): Segment => {
  const angleA = ((60 * side - 30) * Math.PI) / 180
  const angleB = ((60 * ((side + 1) % 6) - 30) * Math.PI) / 180
  return {
    x1: cx + HEX_SIZE * Math.cos(angleA),
    y1: cy + HEX_SIZE * Math.sin(angleA),
    x2: cx + HEX_SIZE * Math.cos(angleB),
    y2: cy + HEX_SIZE * Math.sin(angleB),
  }
}

// De-dupe identical edge segments (shared rosette borders emit twice).
const dedupeSegments = (segments: Segment[]): Segment[] => {
  const seen = new Set<string>()
  const result: Segment[] = []
  for (const seg of segments) {
    const key = segmentKey(seg)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(seg)
  }
  return result
}

// Bundle of pre-baked render data for one board. We compute one of
// these per mode at module load and pick the right one based on
// `game.mode` at render time. Keeps the per-render cost flat — the
// only thing that varies is which constant we point at.
type BoardRenderData = {
  boardDef: BoardDefinition
  layout: BoardLayout
  rippleRadius: number
  flowerBoundarySegments: Segment[]
  flowerBoundaryLoops: { dark: Vec2[]; light: Vec2[] }[]
  outlineSegments: Segment[]
  geometry: BoardGeometry
  // Deal-in cascade: per-cell animation delay (ms) for the run-start
  // choreography. Rosettes pop in center-first then clockwise, cells
  // within each rosette center-out. Pre-baked here so the cascade costs
  // nothing at render time. See Documentation/Deal-In and Living Board
  // Plan.md.
  dealDelayByCellId: Record<string, number>
}

// Deal-in timing constants. The rosette stagger doubles as the audio
// tick schedule (one pitch-stepped tick per rosette). Deliberately
// slow and ceremonial per Quinn's review — the cascade alone runs
// ~1.9s, the full choreography ~3.5s. Any tap skips.
const DEAL_IN_ROSETTE_STAGGER_MS = 180
const DEAL_IN_CELL_STAGGER_STANDARD_MS = 48
const DEAL_IN_CELL_STAGGER_BIG_MS = 20
const DEAL_IN_HAND_BASE_DELAY_MS = 1600
// Active-state window. Long enough to cover the slowest beat (score
// readout pop ends ~3.5s; last hand fly-in ends ~2.85s) so the fly-in
// delay variable never changes under a running animation.
const DEAL_IN_TOTAL_MS = 3600
const DEAL_IN_REDUCED_MOTION_MS = 320

// Living Board critical-state hysteresis, adaptive to hand size: raw
// total placements scale with how many pieces you're holding, so a
// fixed threshold cried wolf with one piece left (one piece × five
// comfortable fits = "5 total" even on a healthy board). The alarm
// instead raises when the player averages <= ENTER_PER_PIECE fits per
// available piece (hand + hold), and stands down at that level plus a
// fixed gap so it never strobes around the line.
//   3 pieces: enter <= 6, exit >= 9
//   2 pieces: enter <= 4, exit >= 7
//   1 piece:  enter <= 2, exit >= 5
const CRITICAL_ENTER_PER_PIECE = 2
const CRITICAL_EXIT_GAP = 3

// Deal-in announce: the CUBEKILL wordmark slams in over the cascade
// (CSS: .hexaclear-dealin-announce — in at 160ms, impact ~340ms, gone
// by ~1.5s, well before the hand deals at 1.6s). The voice line leads
// the visual impact by ~140ms: between Web Audio start latency and how
// the eye registers the fast blur-in, firing both on the same frame
// reads as the voice arriving late.
const DEAL_IN_ANNOUNCE_IMPACT_MS = 340
const DEAL_IN_ANNOUNCE_VOICE_MS = 200

const buildDealDelays = (
  boardDef: BoardDefinition,
  layout: BoardLayout,
  geometry: BoardGeometry,
  cellStaggerMs: number,
): Record<string, number> => {
  const axialDist = (a: Axial, b: Axial): number => {
    const dq = a.q - b.q
    const dr = a.r - b.r
    return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2
  }
  const screenPos = (coord: Axial): Vec2 => {
    const pos = layout.positions[axialToId(coord)]
    return { x: pos.x + layout.offsetX, y: pos.y + layout.offsetY }
  }

  // Rosette order: the center flower first, then the outer six clockwise
  // by screen angle starting from "up". flowerCenters[0] is the origin
  // rosette in both board layouts.
  const boardCenter = screenPos(geometry.flowerCenters[0])
  const clockwiseAngle = (coord: Axial): number => {
    const p = screenPos(coord)
    // atan2(dx, -dy): 0 at twelve o'clock, increasing clockwise.
    const a = Math.atan2(p.x - boardCenter.x, -(p.y - boardCenter.y))
    return a < 0 ? a + Math.PI * 2 : a
  }
  const orderedCenters = [
    geometry.flowerCenters[0],
    ...geometry.flowerCenters
      .slice(1)
      .sort((a, b) => clockwiseAngle(a) - clockwiseAngle(b)),
  ]

  // Assign each cell to its rosette (regions never overlap, so the
  // unique center within flowerRadius is the owner).
  const delays: Record<string, number> = {}
  orderedCenters.forEach((center, rosetteIndex) => {
    const members = boardDef.cells.filter(
      (cell) => axialDist(cell.coord, center) <= geometry.flowerRadius,
    )
    // Center-out, then clockwise for stable, readable ordering.
    members.sort((a, b) => {
      const da = axialDist(a.coord, center)
      const db = axialDist(b.coord, center)
      if (da !== db) return da - db
      return clockwiseAngle(a.coord) - clockwiseAngle(b.coord)
    })
    members.forEach((cell, cellIndex) => {
      delays[cell.id] =
        rosetteIndex * DEAL_IN_ROSETTE_STAGGER_MS + cellIndex * cellStaggerMs
    })
  })
  return delays
}

const buildBoardRenderData = (mode: GameMode): BoardRenderData => {
  const boardDef = getBoardDefinitionForMode(mode)
  const geometry = getBoardGeometryForMode(mode)
  const layout = buildLayout(boardDef)
  return {
    boardDef,
    layout,
    rippleRadius: Math.max(layout.width, layout.height) * 0.7,
    flowerBoundarySegments: buildFlowerBoundarySegments(
      boardDef,
      layout,
      geometry,
    ),
    flowerBoundaryLoops: buildFlowerBoundaryLoops(
      boardDef,
      layout,
      geometry,
    ),
    outlineSegments: buildBoardOutlineSegments(boardDef, layout),
    geometry,
    dealDelayByCellId: buildDealDelays(
      boardDef,
      layout,
      geometry,
      mode === 'big'
        ? DEAL_IN_CELL_STAGGER_BIG_MS
        : DEAL_IN_CELL_STAGGER_STANDARD_MS,
    ),
  }
}

const STANDARD_RENDER_DATA = buildBoardRenderData('endless')
const BIG_RENDER_DATA = buildBoardRenderData('big')

const getRenderDataForMode = (mode: GameMode): BoardRenderData =>
  mode === 'big' ? BIG_RENDER_DATA : STANDARD_RENDER_DATA

const buildHexPoints = (cx: number, cy: number): string => {
  const points: string[] = []
  for (let i = 0; i < 6; i++) {
    const angleRad = ((60 * i - 30) * Math.PI) / 180
    const x = cx + HEX_SIZE * Math.cos(angleRad)
    const y = cy + HEX_SIZE * Math.sin(angleRad)
    points.push(`${x},${y}`)
  }
  return points.join(' ')
}

// For Win98 / Minesweeper-style raised tiles we render two polylines
// per hex: a "highlight" along the upper-left half of the perimeter
// (light-from-top-left convention) and a "shadow" along the
// lower-right half. Theme CSS decides whether they're visible —
// Wood theme keeps them hidden, Win98 paints the bevel.
//
// Vertices for our pointy-top hex (angles -30..270°):
//   V0 upper-right, V1 lower-right, V2 bottom point,
//   V3 lower-left,  V4 upper-left,  V5 top point.
// Highlight = V3 → V4 → V5 → V0  (left, top-left, top-right edges)
// Shadow    = V0 → V1 → V2 → V3  (right, bottom-right, bottom-left)
//
// The polylines are inset slightly toward the hex center so the
// stroke sits *inside* the polygon edge (rather than half outside,
// half inside). This way adjacent cells' bevels don't overpaint
// each other on shared edges — every cell shows its own clean
// raised-button outline. Inset is computed via the regular hex's
// 60° apothem-to-vertex ratio: moving each vertex toward (cx, cy)
// by insetDistance / sin(60°) keeps the stroke parallel to the
// edge at the requested distance.
const HEX_BEVEL_INSET = 2
const HEX_BEVEL_RADIUS_FACTOR =
  (HEX_SIZE - HEX_BEVEL_INSET / Math.sin(Math.PI / 3)) / HEX_SIZE
const buildHexBevelPaths = (
  cx: number,
  cy: number,
): { highlight: string; shadow: string } => {
  const corners: Array<{ x: number; y: number }> = []
  for (let i = 0; i < 6; i++) {
    const angleRad = ((60 * i - 30) * Math.PI) / 180
    const r = HEX_SIZE * HEX_BEVEL_RADIUS_FACTOR
    corners.push({
      x: cx + r * Math.cos(angleRad),
      y: cy + r * Math.sin(angleRad),
    })
  }
  const highlight = [corners[3], corners[4], corners[5], corners[0]]
    .map((p) => `${p.x},${p.y}`)
    .join(' ')
  const shadow = [corners[0], corners[1], corners[2], corners[3]]
    .map((p) => `${p.x},${p.y}`)
    .join(' ')
  return { highlight, shadow }
}

const CubeLines = ({
  cx,
  cy,
  size = HEX_SIZE,
  variant = 'normal',
  dailyHits,
  extraClasses = [],
  style,
  playerGlyph,
}: {
  cx: number
  cy: number
  // Cube radius. Defaults to the board cell size; the hand/hold preview
  // passes its smaller PREVIEW_SIZE so the cube exactly fits its hex cell
  // instead of overflowing it and burying the cell's outline stroke.
  size?: number
  variant?: 'normal' | 'dailyTarget' | 'golden'
  dailyHits?: number
  extraClasses?: string[]
  style?: React.CSSProperties
  // Colorblind-mode identity glyph (one character, e.g. ★ / ● / ▲).
  // Always rendered to the SVG when present; visibility is gated
  // entirely by CSS on `.cubic-viewport.is-colorblind` so the toggle
  // never re-renders the board. Omitted in single-player and on
  // ruby / daily-target cubes (those carry their own glyphs).
  playerGlyph?: string
}) => {
  const vertices: { x: number; y: number }[] = []
  const radius = size
  for (let i = 0; i < 6; i++) {
    const angleRad = ((60 * i - 30) * Math.PI) / 180
    const x = cx + radius * Math.cos(angleRad)
    const y = cy + radius * Math.sin(angleRad)
    vertices.push({ x, y })
  }

  // Choose three wedge faces meeting at center: top, lower-right, lower-left
  const v0 = vertices[0]
  const v1 = vertices[1]
  const v2 = vertices[2]
  const v3 = vertices[3]
  const v4 = vertices[4]
  const v5 = vertices[5]

  let variantClass = 'hexaclear-hex-cube'
  if (variant === 'dailyTarget') {
    variantClass += ' daily-target'
  } else if (variant === 'golden') {
    variantClass += ' golden'
  }

  const cubeClassName = [variantClass, ...extraClasses].join(' ')

  return (
    <g className={cubeClassName} style={style}>
      {/* Inner wrapper so we can apply a unified wiggle/rotation to the cube
          without fighting the parent scale transform on the whole piece. */}
      <g className="hexaclear-cube-wiggle-wrap">
        {/* right face */}
        <polygon
          className="cube-face cube-right"
          points={`${cx},${cy} ${v1.x},${v1.y} ${v2.x},${v2.y} ${v3.x},${v3.y}`}
        />
        {/* left face */}
        <polygon
          className="cube-face cube-left"
          points={`${cx},${cy} ${v3.x},${v3.y} ${v4.x},${v4.y} ${v5.x},${v5.y}`}
        />
        {/* top face drawn last so it's not partially occluded */}
        <polygon
          className="cube-face cube-top"
          points={`${cx},${cy} ${v5.x},${v5.y} ${v0.x},${v0.y} ${v1.x},${v1.y}`}
        />
        <g className="cube-pulse-overlays" aria-hidden="true">
          <polygon
            className="cube-pulse-overlay cube-pulse-dark cube-pulse-right"
            points={`${cx},${cy} ${v1.x},${v1.y} ${v2.x},${v2.y} ${v3.x},${v3.y}`}
          />
          <polygon
            className="cube-pulse-overlay cube-pulse-dark cube-pulse-left"
            points={`${cx},${cy} ${v3.x},${v3.y} ${v4.x},${v4.y} ${v5.x},${v5.y}`}
          />
          <polygon
            className="cube-pulse-overlay cube-pulse-dark cube-pulse-top"
            points={`${cx},${cy} ${v5.x},${v5.y} ${v0.x},${v0.y} ${v1.x},${v1.y}`}
          />
          <polygon
            className="cube-pulse-overlay cube-pulse-light cube-pulse-right"
            points={`${cx},${cy} ${v1.x},${v1.y} ${v2.x},${v2.y} ${v3.x},${v3.y}`}
          />
          <polygon
            className="cube-pulse-overlay cube-pulse-light cube-pulse-left"
            points={`${cx},${cy} ${v3.x},${v3.y} ${v4.x},${v4.y} ${v5.x},${v5.y}`}
          />
          <polygon
            className="cube-pulse-overlay cube-pulse-light cube-pulse-top"
            points={`${cx},${cy} ${v5.x},${v5.y} ${v0.x},${v0.y} ${v1.x},${v1.y}`}
          />
        </g>
        <polygon
          className="cube-ripple-overlay"
          points={vertices.map((v) => `${v.x},${v.y}`).join(' ')}
          aria-hidden="true"
        />
        {variant === 'golden' && (
          <text
            x={cx}
            y={cy + 3}
            className="hexaclear-gem-label"
          >
            +10
          </text>
        )}
        {variant === 'dailyTarget' && typeof dailyHits === 'number' && (
          <text
            x={cx}
            y={cy + 3}
            className="hexaclear-daily-number-centered"
          >
            {dailyHits}
          </text>
        )}
      </g>
      {/* Colorblind identity glyph. Sits OUTSIDE the wiggle wrap so
          the per-player marker stays rock-steady while the cube
          itself does its preview-clear scale. Always present in the
          DOM (hidden via CSS unless `.is-colorblind` is on) so the
          accessibility toggle doesn't force a board re-render. Not
          rendered for daily-target or golden variants — those cells
          already carry their own glyph (the hits counter / "+10")
          and stacking a player marker on top would compete with the
          existing identity. */}
      {playerGlyph && variant === 'normal' && (
        <text
          x={cx}
          y={cy + 4}
          className="hexaclear-player-glyph"
          aria-hidden="true"
        >
          {playerGlyph}
        </text>
      )}
    </g>
  )
}

// Emote sequence shown in the 3x3 grid below the smiley button. The
// composed emoji ('head shake' yes/no) include their explicit
// variation selectors so render-side font fallback is consistent
// across iOS / Android / desktop browsers.
const EMOTE_OPTIONS = [
  '⏸️',
  '▶️',
  '🤣',
  '😭',
  '🎉',
  '💀',
  '😍',
  '🙂\u200d↕\ufe0f',
  '🙂\u200d↔\ufe0f',
] as const

type SmileyRowPlayer = {
  playerId: string
  name: string
  // Optional global PvP rank chip drawn under the player's name.
  // Populated only when the active room is PvP and the server has
  // a row for this playerId; null while the row hasn't been
  // computed yet, undefined for co-op (chip suppressed entirely).
  pvpRank?: number | null
}

type SmileyRowProps = {
  show: boolean
  setShow: (v: boolean) => void
  // The local player. Their tile is the interactive trigger that
  // opens the emote panel and shows the emote *they* most recently
  // sent (so the sender can see what their partners are looking at).
  selfPlayer: SmileyRowPlayer | null
  // Every non-self seated player, in ring order. Each gets a
  // read-only smiley with their name underneath.
  otherPlayers: SmileyRowPlayer[]
  // Active (still-inside-the-10s-window) emote per playerId. Tiles
  // not in this map render the default smiley face.
  activeEmoteByPlayerId: Record<string, { emoji: string; ts: number }>
  // Number of true spectators currently watching (excludes seated
  // players). Surface as a tiny pill at the row's tail so seated
  // players can see they have an audience. Hidden when zero. The
  // SmileyRow is the natural home for it in both themes — it stays
  // next to player identity instead of pinning to header chrome.
  spectatorCount?: number
  onSend: (emoji: string) => void
  onToggle: () => void
}

const SmileyRow = ({
  show,
  setShow,
  selfPlayer,
  otherPlayers,
  activeEmoteByPlayerId,
  spectatorCount = 0,
  onToggle,
  onSend,
}: SmileyRowProps) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  // Close on outside click. Pointerdown so we beat the synthetic
  // click that would otherwise re-fire onToggle when the user taps
  // outside the popover.
  useEffect(() => {
    if (!show) return
    const onPointerDown = (e: PointerEvent) => {
      const el = wrapperRef.current
      if (!el) return
      if (el.contains(e.target as Node)) return
      setShow(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [show, setShow])
  // Spectators arrive with selfPlayer=null and we still want them
  // to see partner smileys + active reactions, just without a self
  // tile to send from. Only collapse the row entirely when nobody
  // (seated or partner) is around to render.
  if (!selfPlayer && otherPlayers.length === 0) return null
  const tiles: { player: SmileyRowPlayer; isSelf: boolean }[] = [
    ...(selfPlayer ? [{ player: selfPlayer, isSelf: true }] : []),
    ...otherPlayers.map((p) => ({ player: p, isSelf: false })),
  ]
  return (
    <div
      className={[
        'hexaclear-smiley-row',
        // The legacy class lets the existing absolute-centering
        // anchor + Win98 chrome rules (which target
        // `.hexaclear-emote-bar`) keep working unchanged.
        'hexaclear-emote-bar',
        tiles.length > 4 ? 'hexaclear-smiley-row-compact' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      ref={wrapperRef}
    >
      {tiles.map(({ player, isSelf }) => {
        const emote = activeEmoteByPlayerId[player.playerId] ?? null
        return (
          <div
            key={player.playerId}
            className={[
              'hexaclear-smiley-tile',
              isSelf ? 'is-self' : 'is-partner',
            ].join(' ')}
          >
            <button
              type="button"
              className={[
                'hexaclear-emote-trigger',
                isSelf ? '' : 'is-readonly',
                // Partner tiles get the existing pulse animation
                // when their owner has an active emote, so the
                // viewer's eye gets pulled to whoever just reacted.
                !isSelf && emote ? 'has-partner-emote' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={isSelf ? onToggle : undefined}
              aria-label={
                isSelf
                  ? 'Send an emote'
                  : `${player.name}'s reactions`
              }
              aria-expanded={isSelf ? show : undefined}
              aria-disabled={isSelf ? undefined : true}
              tabIndex={isSelf ? 0 : -1}
            >
              <img
                src="/smiley.png"
                alt=""
                aria-hidden="true"
                className="hexaclear-emote-trigger-img"
                draggable={false}
              />
              <span
                className="hexaclear-emote-trigger-default"
                aria-hidden="true"
              >
                🙂
              </span>
              {emote && (
                <span
                  className="hexaclear-emote-trigger-overlay"
                  aria-label={`${player.name} sent ${emote.emoji}`}
                >
                  {emote.emoji}
                </span>
              )}
            </button>
            <span className="hexaclear-smiley-name" aria-hidden="true">
              {player.name}
            </span>
            {player.pvpRank != null && (
              <span
                className="hexaclear-smiley-rank"
                aria-label={`${player.name} is ranked #${player.pvpRank} in PvP`}
              >
                #{player.pvpRank}
              </span>
            )}
            {isSelf && show && (
              <div
                className="hexaclear-emote-panel"
                role="dialog"
                aria-label="Pick an emote"
              >
                <div
                  className="hexaclear-emote-panel-title"
                  aria-hidden="true"
                >
                  Send how you feel!
                </div>
                <div className="hexaclear-emote-panel-grid">
                  {EMOTE_OPTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="hexaclear-emote-option"
                      onClick={() => onSend(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })}
      {spectatorCount > 0 && (
        <div
          key={spectatorCount}
          className="hexaclear-spectator-pill"
          aria-label={`${spectatorCount} spectator${
            spectatorCount === 1 ? '' : 's'
          } watching this room`}
          title={`${spectatorCount} watching`}
        >
          <span
            className="hexaclear-spectator-pill-eye"
            aria-hidden="true"
          >
            👁
          </span>
          <span
            className="hexaclear-spectator-pill-count"
            aria-hidden="true"
          >
            {spectatorCount}
          </span>
        </div>
      )}
    </div>
  )
}

const SlotGeometry = ({ cx, cy }: { cx: number; cy: number }) => {
  // Empty cells render as a single quiet hex dimple — no 3D cube facets — so
  // placed pieces stand out clearly against open space. Filled cubes carry
  // all the depth/shading. This is what tells the player "this cell is empty"
  // at a glance.
  const vertices: { x: number; y: number }[] = []
  const radius = HEX_SIZE * 0.86
  for (let i = 0; i < 6; i++) {
    const angleRad = ((60 * i - 30) * Math.PI) / 180
    vertices.push({
      x: cx + radius * Math.cos(angleRad),
      y: cy + radius * Math.sin(angleRad),
    })
  }
  const points = vertices.map((v) => `${v.x},${v.y}`).join(' ')

  return (
    <g className="hexaclear-slot">
      <polygon className="hexaclear-slot-fill" points={points} />
    </g>
  )
}

const PlacementGhost = ({
  originCellId,
  piece,
  valid,
  boardDef,
  layout,
}: {
  originCellId: string
  piece: ActivePiece
  valid: boolean
  boardDef: BoardDefinition
  layout: BoardLayout
}) => {
  const originCell = boardDef.cells.find((c) => c.id === originCellId)
  if (!originCell) return null

  return (
    <g className="hexaclear-placement-ghost">
      {piece.shape.cells.map((rel, idx) => {
        const targetQ = originCell.coord.q + rel.q
        const targetR = originCell.coord.r + rel.r
        const { x, y } = axialToPixel(targetQ, targetR)
        const cx = x + layout.offsetX
        const cy = y + layout.offsetY
        const points = buildHexPoints(cx, cy)
        return (
          <polygon
            key={idx}
            points={points}
            className={[
              'hexaclear-hex',
              'placement-ghost',
              valid ? 'placement-ghost-valid' : 'placement-ghost-invalid',
            ]
              .filter(Boolean)
              .join(' ')}
            pointerEvents="none"
          />
        )
      })}
    </g>
  )
}

const getBestPlacementPreview = (
  hoveredCellId: string | null,
  selectedPiece: ActivePiece | null,
  game: GameState,
) => {
  if (!hoveredCellId || !selectedPiece) return null

  const boardDef = getBoardDefinitionForMode(game.mode)
  const originCell = boardDef.cells.find((c) => c.id === hoveredCellId)
  if (!originCell) return null

  const targetIds: string[] = []
  let valid = true
  for (const rel of selectedPiece.shape.cells) {
    const targetQ = originCell.coord.q + rel.q
    const targetR = originCell.coord.r + rel.r
    const targetId = axialToId({ q: targetQ, r: targetR })
    if (!(targetId in game.board) || game.board[targetId] !== 'empty') {
      valid = false
    }
    targetIds.push(targetId)
  }

  let clearedIds: string[] = []
  // Number of distinct scoring patterns this placement would clear
  // simultaneously. Used by the multi-clear hint chip on the hover
  // ghost — it only surfaces when this is >= 2, since single clears
  // don't constitute a "combo" worth flagging.
  let clearedPatternsCount = 0
  if (valid) {
    const previewGame: GameState = {
      ...game,
      board: { ...game.board },
      hand: [selectedPiece],
      handSlots: [selectedPiece.id],
      gameOver: false,
    }
    const result = applyPlacement(previewGame, selectedPiece, hoveredCellId)
    if (result && result.clearedPatterns.length > 0) {
      clearedPatternsCount = result.clearedPatterns.length
      // In daily mode, only highlight cells that will actually disappear
      // (not numbered cubes that still have hits remaining after the clear).
      if (game.mode === 'daily') {
        clearedIds = result.clearedCellIds.filter((id) => {
          const hitsAfter = result.dailyHits[id]
          // If hitsAfter is undefined or 0, the cell will disappear.
          return hitsAfter === undefined || hitsAfter === 0
        })
      } else {
        clearedIds = result.clearedCellIds
      }
    }
  }

  return { targetIds, valid, clearedIds, clearedPatternsCount }
}

type HighScoreEntry = {
  name: string
  score: number
  date: number
}

type DailyHighScoreEntry = {
  name: string
  moves: number
  date: number
}

const DAILY_PLAYER_RUNS_PREFIX = 'cubic-daily-runs-'

// How many endless rows we keep in localStorage and surface to the
// player. Pause-menu and gameover leaderboards both paginate this
// list at 10 rows per page. Bumping this cap also bumps the bar a
// score has to clear to qualify for a "save score" prompt — any
// run good enough to land inside the top N is worth recording.
const LOCAL_ENDLESS_CAP = 30
// The gameover modal is space-constrained (it stacks the headline,
// optional save prompt, run-stats card, leaderboard, and action
// buttons), so we paginate its leaderboards more aggressively than
// the dedicated pause-menu panel. Five rows per page keeps the
// modal compact while still letting the player flip through the
// full local top-30 endless list and any global top-N view.
const GAMEOVER_LEADERBOARD_PAGE_SIZE = 5

const loadHighScores = (): HighScoreEntry[] => {
  try {
    const raw = window.localStorage.getItem('cubic-highscores')
    if (!raw) return []
    const parsed = JSON.parse(raw) as HighScoreEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (e) =>
          typeof e.name === 'string' &&
          typeof e.score === 'number' &&
          typeof e.date === 'number',
      )
      .sort((a, b) => b.score - a.score || a.date - b.date)
      .slice(0, LOCAL_ENDLESS_CAP)
  } catch {
    return []
  }
}

const loadDailyHighScores = (): DailyHighScoreEntry[] => {
  try {
    const raw = window.localStorage.getItem('cubic-daily-highscores')
    if (!raw) return []
    const parsed = JSON.parse(raw) as DailyHighScoreEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (e) =>
          typeof e.name === 'string' &&
          typeof e.moves === 'number' &&
          typeof e.date === 'number',
      )
      .sort((a, b) => a.moves - b.moves || a.date - b.date)
      .slice(0, 5)
  } catch {
    return []
  }
}

const loadDailyRunsForDateKey = (dateKey: string): DailyHighScoreEntry[] => {
  try {
    const raw = window.localStorage.getItem(`${DAILY_PLAYER_RUNS_PREFIX}${dateKey}`)
    if (!raw) return []
    const parsed = JSON.parse(raw) as DailyHighScoreEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e) =>
        typeof e.name === 'string' &&
        typeof e.moves === 'number' &&
        typeof e.date === 'number',
    )
  } catch {
    return []
  }
}

// Local co-op leaderboard entry. Keyed by `groupKey` (sorted player
// ids joined with '|') so each unique co-op partnership has at most
// one row on this device — repeated runs by the same group only
// stick if they beat the previous best. `name` is the rendered
// "Alice & Bob" display string, `playerIds` is kept around so the
// gameover modal can match the just-finished group against this
// store and so the global submit gate can compare apples-to-apples
// against the global leaderboard's per-group rows.
type CoopHighScoreEntry = {
  groupKey: string
  name: string
  score: number
  date: number
  playerIds: string[]
}

const COOP_HIGH_SCORES_KEY = 'cubic-coop-highscores'

const computeCoopGroupKey = (playerIds: readonly string[]): string =>
  [...playerIds].sort().join('|')

const loadCoopHighScores = (): CoopHighScoreEntry[] => {
  try {
    const raw = window.localStorage.getItem(COOP_HIGH_SCORES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as CoopHighScoreEntry[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (e) =>
          typeof e.groupKey === 'string' &&
          typeof e.name === 'string' &&
          typeof e.score === 'number' &&
          typeof e.date === 'number' &&
          Array.isArray(e.playerIds) &&
          e.playerIds.every((p) => typeof p === 'string'),
      )
      .sort((a, b) => b.score - a.score || a.date - b.date)
  } catch {
    return []
  }
}

// Apply a finished co-op run to the local store. Returns the updated
// list AND a flag indicating whether the run is the new best for its
// group — that flag drives the "only submit globally on a new local
// #1" gate. The returned list is also normalized: at most one row
// per groupKey (best score wins).
const applyCoopHighScore = (
  prev: CoopHighScoreEntry[],
  next: CoopHighScoreEntry,
): { list: CoopHighScoreEntry[]; isNewGroupBest: boolean } => {
  const incumbent = prev.find((e) => e.groupKey === next.groupKey) ?? null
  const isNewGroupBest =
    !incumbent ||
    next.score > incumbent.score ||
    (next.score === incumbent.score && next.date < incumbent.date)
  if (!isNewGroupBest) {
    return { list: prev, isNewGroupBest: false }
  }
  const filtered = prev.filter((e) => e.groupKey !== next.groupKey)
  const list = [...filtered, next].sort(
    (a, b) => b.score - a.score || a.date - b.date,
  )
  return { list, isNewGroupBest: true }
}

const qualifiesForHighScore = (
  score: number,
  entries: HighScoreEntry[],
): boolean => {
  if (score <= 0) return false
  if (entries.length < LOCAL_ENDLESS_CAP) return true
  const sorted = [...entries].sort(
    (a, b) => b.score - a.score || a.date - b.date,
  )
  const last = sorted[sorted.length - 1]
  return score > last.score
}

const getTodayKey = (): string => {
  const now = new Date()
  // Use the client’s local calendar day so that daily puzzles reset at
  // local midnight rather than a single global UTC boundary.
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  const d = now.getDate()
  const mm = String(m).padStart(2, '0')
  const dd = String(d).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

// Daily history launch date. The calendar refuses to navigate past
// this and never offers cells before it, so players can never start
// a daily that doesn't exist in our seed history. Pinned to the
// game's public launch date so every player has the same archive
// floor regardless of when they joined.
const DAILY_HISTORY_LAUNCH_DATE_KEY = '2026-03-01'

const FRIENDLY_MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

// Render a `YYYY-MM-DD` key as "March 3, 2026" for headers, history
// labels, and the archive-day pill on the daily HUD. Defensive
// against malformed input — anything we can't parse falls back to
// the raw key so we never crash on display.
const formatFriendlyDateKey = (dateKey: string): string => {
  const parts = dateKey.split('-')
  if (parts.length !== 3) return dateKey
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(d) ||
    m < 1 ||
    m > 12
  ) {
    return dateKey
  }
  return `${FRIENDLY_MONTH_NAMES[m - 1]} ${d}, ${y}`
}

// Pad a date key triple back into the canonical `YYYY-MM-DD` storage
// form. Used by the calendar grid when constructing date keys for
// each cell.
const buildDateKey = (year: number, month: number, day: number): string => {
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${year}-${mm}-${dd}`
}

// True if `a` represents a calendar day strictly before `b`. Both
// must be `YYYY-MM-DD`. Comparison is purely lexicographic, which
// is correct because the format zero-pads month and day.
const isDateKeyBefore = (a: string, b: string): boolean => a < b
const isDateKeyAfter = (a: string, b: string): boolean => a > b

const getDateKeyFromTimestamp = (timestamp: number): string => {
  const d = new Date(timestamp)
  // Bucket stored scores by the player’s local day.
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const day = d.getDate()
  const mm = String(m).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${y}-${mm}-${dd}`
}

const shiftDateKey = (key: string, deltaDays: number): string => {
  const [yStr, mStr, dStr] = key.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  const d = Number(dStr)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return getTodayKey()
  }
  const date = new Date(Date.UTC(y, m - 1, d + deltaDays))
  const yy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

type PersistedGameEnvelope = {
  version: 1
  mode: GameMode
  game: GameState
  // For daily mode we also stash the date key so we don't restore an
  // old daily puzzle on a new day.
  dateKey?: string
  // Per-hand undo history, snapshotted alongside the game so a refresh
  // resumes with the Undo button intact. Capped to the same 2 entries the
  // in-memory stack keeps. Older saves predate this field — `undefined`
  // simply restores an empty stack.
  undo?: GameState[]
}

const PERSIST_KEY_BY_MODE: Record<GameMode, string> = {
  endless: 'cubic-current-game-endless',
  daily: 'cubic-current-game-daily',
  big: 'cubic-current-game-big',
}

const ACTIVE_MODE_KEY = 'cubic-active-mode'

// Set once the first-launch micro-tutorial has been completed or
// explicitly skipped. Used to gate the guided opening so returning
// players never see it again.
const TUTORIAL_COMPLETED_KEY = 'cubic-tutorial-completed'
const FTUE_UNDO_HINT_KEY = 'cubic-ftue-undo-hint-seen'
const FTUE_HOLD_HINT_KEY = 'cubic-ftue-hold-hint-seen'
const FTUE_FLOWER_HINT_KEY = 'cubic-ftue-flower-hint-seen'
const FTUE_COMBO_HINT_KEY = 'cubic-ftue-combo-hint-seen'
const FTUE_DAILY_INTRO_KEY = 'cubic-ftue-daily-intro-seen'

// 0 = not in tutorial. 1 = line/ruby beat. 2 = rosette beat on the
// same board after the line clear has finished animating.
type TutorialStage = 0 | 1 | 2

type FtueHintKind = 'undo' | 'hold' | 'flower' | 'combo'

type FtueHint = {
  kind: FtueHintKind
  text: string
}

const getStorageFlag = (key: string): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

const setStorageFlag = (key: string) => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, '1')
  } catch {
    // Ignore storage failures; hints can safely reappear next session.
  }
}

const isDevForceTutorial = (): boolean => {
  if (!import.meta.env.DEV) return false
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get('forceTutorial') === '1'
}

// Belt-and-suspenders check for "this player has never played before."
// Requires both no completion flag AND no evidence of prior play in
// any persistence slot, so a stale localStorage from an old build
// can't re-trigger the tutorial on someone who already finished a
// run.
//
// Dev-only escape hatches:
//   ?forceTutorial=1 — always fires the tutorial, ignoring stored
//     state. Use to validate the guided opening without nuking
//     localStorage between iterations. Strict no-op in production.
const isFirstLaunchEver = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    if (isDevForceTutorial()) return true
    if (window.localStorage.getItem(TUTORIAL_COMPLETED_KEY)) return false
    for (const key of Object.values(PERSIST_KEY_BY_MODE)) {
      if (window.localStorage.getItem(key)) return false
    }
    if (window.localStorage.getItem('cubic-current-game')) return false
    if (window.localStorage.getItem('cubic-stats-v1')) return false
    if (window.localStorage.getItem('cubic-highscores')) return false
    return true
  } catch {
    // localStorage is unavailable (privacy mode etc.) — don't trap
    // the player in a tutorial they can't escape between sessions.
    return false
  }
}

// Try to migrate the pre-multi-mode single-key save into per-mode
// slots. If both the legacy key and a per-mode key exist, the per-mode
// key wins (it's been kept in sync more recently). Idempotent: deletes
// the legacy key after migrating so subsequent reads short-circuit.
const migrateLegacyPersistedGame = () => {
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem('cubic-current-game')
    if (!raw) return
    const parsed = JSON.parse(raw) as PersistedGameEnvelope
    if (!parsed || parsed.version !== 1 || !parsed.game) {
      window.localStorage.removeItem('cubic-current-game')
      return
    }
    const targetKey = PERSIST_KEY_BY_MODE[parsed.mode]
    if (targetKey && !window.localStorage.getItem(targetKey)) {
      window.localStorage.setItem(targetKey, raw)
    }
    if (!window.localStorage.getItem(ACTIVE_MODE_KEY)) {
      window.localStorage.setItem(ACTIVE_MODE_KEY, parsed.mode)
    }
    window.localStorage.removeItem('cubic-current-game')
  } catch {
    // Best-effort migration; ignore parse failures.
  }
}

// Backfill fields added since older saves were written so we don't crash on
// legacy state shapes (e.g. pre-multi-ruby saves had `goldenCellId`). Mutates
// and returns the same object. Applied to both the live game and every undo
// snapshot so a stack restored across a deploy can't carry an old shape.
const normalizePersistedGame = (raw: unknown, mode: GameMode): GameState => {
  const game = raw as GameState & {
    goldenCellId?: string | null
  }
  if (!Array.isArray(game.goldenCellIds)) {
    const legacyId = game.goldenCellId
    game.goldenCellIds =
      typeof legacyId === 'string' && legacyId.length > 0 ? [legacyId] : []
  }
  if (typeof game.mode !== 'string') {
    game.mode = mode
  }
  // `hold` was added later. Older saves don't have it; default to
  // an empty hold so downstream code that reads `game.hold` (and
  // distinguishes null from a filled buffer) doesn't see undefined.
  if (game.hold === undefined) {
    game.hold = null
  }
  return game
}

const loadEnvelopeForMode = (
  mode: GameMode,
): { game: GameState; undo: GameState[] } | null => {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PERSIST_KEY_BY_MODE[mode])
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedGameEnvelope
    if (!parsed || parsed.version !== 1 || !parsed.game) return null
    if (mode === 'daily') {
      const todayKey = getTodayKey()
      if (parsed.dateKey && parsed.dateKey !== todayKey) {
        return null
      }
    }
    const game = normalizePersistedGame(parsed.game, mode)
    const undo = Array.isArray(parsed.undo)
      ? parsed.undo.map((entry) => normalizePersistedGame(entry, mode))
      : []
    return { game, undo }
  } catch {
    return null
  }
}

const loadGameForMode = (mode: GameMode): GameState | null =>
  loadEnvelopeForMode(mode)?.game ?? null

const loadInitialGameFromStorage = (): GameState => {
  if (typeof window === 'undefined') {
    return createInitialGameState()
  }
  migrateLegacyPersistedGame()
  let activeMode = (window.localStorage.getItem(ACTIVE_MODE_KEY) as
    | GameMode
    | null) ?? 'endless'
  if (activeMode !== 'endless' && activeMode !== 'daily' && activeMode !== 'big') {
    activeMode = 'endless'
  }
  const stored = loadGameForMode(activeMode)
  if (stored) return stored
  if (activeMode === 'daily') return createDailyGameState()
  if (activeMode === 'big') return createBigGameState()
  return createInitialGameState()
}

// The undo stack lives in the active mode's envelope. Resolve the same active
// mode `loadInitialGameFromStorage` does so the restored stack always pairs
// with the restored game; any other case (no stored game, stale daily) yields
// an empty stack.
const loadInitialUndoFromStorage = (): GameState[] => {
  if (typeof window === 'undefined') return []
  let activeMode = (window.localStorage.getItem(ACTIVE_MODE_KEY) as
    | GameMode
    | null) ?? 'endless'
  if (activeMode !== 'endless' && activeMode !== 'daily' && activeMode !== 'big') {
    activeMode = 'endless'
  }
  return loadEnvelopeForMode(activeMode)?.undo ?? []
}

// Both pickup and placement get the same heavy bump per game design.
// `didClear` is preserved for the call site in case we want clear-only
// haptics later, but both branches currently fire the same heavy impact.
const triggerHaptics = (didClear: boolean) => {
  void didClear
  haptics.trigger('heavy')
}

const triggerGrabHaptic = () => {
  haptics.trigger('heavy')
}

function App() {
  // ---- Multiplayer plumbing ------------------------------------------
  //
  // We treat multiplayer as a thin layer over the single-player engine:
  // the same `game` state variable backs the rendering pipeline; in MP
  // mode it just gets continuously mirrored from the room snapshot
  // instead of being driven by local placePiece updates. Single-player
  // logic remains fully intact when no room is active.
  const playerIdRef = useRef<string>(getOrCreatePlayerId())
  const playerId = playerIdRef.current
  // Read both the room code and the (optional) requested mode from the
  // launch URL so an incoming player auto-joins a PvP room as PvP. The
  // server still gets final say once it returns the room doc, but
  // seeding the local mpPendingMode keeps the lobby UI consistent
  // during the connecting-but-not-yet-joined window.
  const initialRoomFromUrl = useMemo(() => readRoomFromUrl(), [])
  const [mpRoomCode, setMpRoomCode] = useState<string | null>(
    initialRoomFromUrl.code,
  )
  // The mode the player picked in the lobby toggle before clicking
  // copy. Once the room is created this becomes locked (the link the
  // partner uses carries the mode), so the toggle is hidden post-copy.
  // Auto-join with ?mode=pvp seeds this to 'pvp' so the local UI
  // matches the partner's chosen mode while the join is in flight.
  const [mpPendingMode, setMpPendingMode] = useState<RoomMode>(
    initialRoomFromUrl.mode === 'pvp' ? 'pvp' : 'coop',
  )
  // We pull the player's display name from the same localStorage key the
  // single-player high-score flow uses so the lobby auto-fills with
  // their familiar tag.
  // Multiplayer display name is persisted under its own localStorage
  // key (separate from the single-player high-score name) so changes
  // in the MP lobby don't overwrite the high-score autofill. On first
  // use we seed it from the SP high-score name when present so a
  // returning player sees their familiar tag, then it diverges from
  // there as soon as they edit it in the MP settings.
  const [mpPlayerName, setMpPlayerName] = useState<string>(() => {
    if (typeof window === 'undefined') return 'Player'
    try {
      const mpSaved = window.localStorage.getItem('cubic-mp-player-name')
      if (mpSaved && mpSaved.trim().length > 0) return mpSaved
      const spSaved = window.localStorage.getItem('cubic-player-name')
      if (spSaved && spSaved.trim().length > 0) return spSaved
    } catch {
      // Ignore — fall through to default.
    }
    return 'Player'
  })
  // Persist any MP name edit immediately so reloading (or coming
  // back later) keeps the player's chosen multiplayer identity.
  // Empty strings are skipped — a transient empty state shouldn't
  // wipe the saved value out from under them mid-edit.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const trimmed = mpPlayerName.trim()
    if (trimmed.length === 0) return
    try {
      window.localStorage.setItem('cubic-mp-player-name', mpPlayerName)
    } catch {
      // Best-effort persistence — quota errors are non-fatal.
    }
  }, [mpPlayerName])
  const isMultiplayer = mpRoomCode !== null
  const mp = useMultiplayerGame({
    code: mpRoomCode,
    playerId,
    name: mpPlayerName,
  })
  // Smiley/emote panel UI state. Self's smiley button in the score
  // bar in MP opens a 3x3 grid of emotes that get pushed to every
  // other seat. The expiry tick is bumped each time an emote ages
  // out of its 10s display window so each seat's smiley falls back
  // to its default render at the right moment.
  const [showEmotePanel, setShowEmotePanel] = useState<boolean>(false)
  const [partnerEmoteExpiryTick, setPartnerEmoteExpiryTick] = useState(0)
  // Per-cell hue rotation (deg) applied to non-self placements so
  // each player's cubes wear a unique tint for THIS viewer. Self's
  // cells are absent from the map (they render at hue 0 / default).
  // Re-derived only when the cellOwners map or hue assignments
  // change. We also keep a `nonSelfOwnedCells` set so the cube
  // render loop can do a cheap `has` check before reaching for the
  // hue lookup.
  const cellHueByCellId = useMemo<Record<string, number>>(() => {
    if (!isMultiplayer) return {}
    const out: Record<string, number> = {}
    const selfId = mp.selfPlayer?.playerId
    for (const [cellId, ownerId] of Object.entries(mp.cellOwners)) {
      if (!ownerId || ownerId === selfId) continue
      const hue = mp.hueShiftByPlayerId[ownerId] ?? 0
      if (hue !== 0) out[cellId] = hue
    }
    return out
  }, [isMultiplayer, mp.cellOwners, mp.hueShiftByPlayerId, mp.selfPlayer])
  const nonSelfOwnedCells = useMemo<Set<string>>(() => {
    if (!isMultiplayer) return new Set()
    const selfId = mp.selfPlayer?.playerId
    const out = new Set<string>()
    for (const [cellId, ownerId] of Object.entries(mp.cellOwners)) {
      if (!ownerId || ownerId === selfId) continue
      out.add(cellId)
    }
    return out
  }, [isMultiplayer, mp.cellOwners, mp.selfPlayer])

  // Colorblind-mode identity glyph per cell. Maps every owned cell
  // (including self's own placements) to the placer's glyph so the
  // viewer sees a consistent per-seat marker on every cube once the
  // `.is-colorblind` class is on. Skipped entirely in single-player
  // because there's only one "owner" and adding glyphs to every cube
  // would be visual noise without any disambiguation benefit. The
  // map is consulted at render time but the glyph elements
  // themselves are always rendered (gated by CSS) — see CubeLines.
  const cellGlyphByCellId = useMemo<Record<string, string>>(() => {
    if (!isMultiplayer) return {}
    const out: Record<string, string> = {}
    for (const [cellId, ownerId] of Object.entries(mp.cellOwners)) {
      if (!ownerId) continue
      const glyph = mp.glyphByPlayerId[ownerId]
      if (glyph) out[cellId] = glyph
    }
    return out
  }, [isMultiplayer, mp.cellOwners, mp.glyphByPlayerId])

  // PvP territory tints: persistent per-cell "last clearer" map.
  // `cellTintHueByCellId` maps each tinted cell to the hue rotation
  // to apply for THIS viewer (self → 0°, so tints owned by self
  // render in the default warm palette and are intentionally omitted
  // here — the renderer only flood-tints partner-owned territory so
  // self's own ground stays neutral and easy to read).
  // `tintedCellIds` is the full set including self, so we can detect
  // "filled cell on someone else's tint" (conflict ring) regardless
  // of viewer.
  const cellTintHueByCellId = useMemo<Record<string, number>>(() => {
    if (!isMultiplayer || mp.mode !== 'pvp') return {}
    const out: Record<string, number> = {}
    const selfId = mp.selfPlayer?.playerId
    for (const [cellId, tintId] of Object.entries(mp.cellTints)) {
      if (!tintId || tintId === selfId) continue
      const hue = mp.hueShiftByPlayerId[tintId] ?? 0
      if (hue !== 0) out[cellId] = hue
    }
    return out
  }, [
    isMultiplayer,
    mp.mode,
    mp.cellTints,
    mp.hueShiftByPlayerId,
    mp.selfPlayer,
  ])
  // Self-tinted cells get their own marker so the renderer can still
  // visually distinguish "my territory" from a truly untouched cell —
  // we use a subtle warm overlay rather than the partner hue rotation.
  const selfTintedCellIds = useMemo<Set<string>>(() => {
    if (!isMultiplayer || mp.mode !== 'pvp') return new Set()
    const selfId = mp.selfPlayer?.playerId
    if (!selfId) return new Set()
    const out = new Set<string>()
    for (const [cellId, tintId] of Object.entries(mp.cellTints)) {
      if (tintId === selfId) out.add(cellId)
    }
    return out
  }, [isMultiplayer, mp.mode, mp.cellTints, mp.selfPlayer])

  // Colorblind-mode glyph for PvP territory tints. Every tinted cell
  // (self OR partner) gets its owner's glyph so an empty owned cell
  // carries an explicit non-color identity marker — partner hues can
  // collapse for CVD viewers, so the territory race needs a shape
  // anchor. Co-op rooms have no persistent tints, so this is scoped
  // to PvP only.
  const cellTintGlyphByCellId = useMemo<Record<string, string>>(() => {
    if (!isMultiplayer || mp.mode !== 'pvp') return {}
    const out: Record<string, string> = {}
    for (const [cellId, tintId] of Object.entries(mp.cellTints)) {
      if (!tintId) continue
      const glyph = mp.glyphByPlayerId[tintId]
      if (glyph) out[cellId] = glyph
    }
    return out
  }, [isMultiplayer, mp.mode, mp.cellTints, mp.glyphByPlayerId])
  // Cells where the current occupant (cellOwners) and the tint
  // (cellTints) belong to different players — render a colored ring
  // around the cell in the tinter's color so the conflict reads.
  const conflictCellIds = mp.conflictCellIds
  const conflictTintHueByCellId = useMemo<Record<string, number>>(() => {
    if (!isMultiplayer || mp.mode !== 'pvp') return {}
    const out: Record<string, number> = {}
    for (const cellId of conflictCellIds) {
      const tintId = mp.cellTints[cellId]
      if (!tintId) continue
      out[cellId] = mp.hueShiftByPlayerId[tintId] ?? 0
    }
    return out
  }, [
    isMultiplayer,
    mp.mode,
    conflictCellIds,
    mp.cellTints,
    mp.hueShiftByPlayerId,
  ])

  // Per-playerId emote, narrowed to "still inside its 10s display
  // window". Once the window closes the corresponding smiley falls
  // back to its default face. The expiry tick forces a recompute
  // when an active emote ages out.
  const PARTNER_EMOTE_TTL_MS = 10_000
  const activeEmoteByPlayerId = useMemo<
    Record<string, { emoji: string; ts: number }>
  >(() => {
    const out: Record<string, { emoji: string; ts: number }> = {}
    const now = Date.now()
    for (const [pid, emote] of Object.entries(mp.emoteByPlayerId)) {
      if (now - emote.ts < PARTNER_EMOTE_TTL_MS) out[pid] = emote
    }
    return out
    // partnerEmoteExpiryTick is in the dep list intentionally — its
    // only job is to force a recompute when an active emote ages
    // out, even though it doesn't appear inside the function body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mp.emoteByPlayerId, partnerEmoteExpiryTick])
  useEffect(() => {
    // Schedule a single expiry tick at the earliest pending TTL
    // across every active emote. One timer covers the common case
    // where multiple seats sent emotes inside the same window; as
    // soon as the earliest one fades, the recompute either renders
    // a smaller active set or schedules the next.
    const expiries: number[] = []
    const now = Date.now()
    for (const emote of Object.values(mp.emoteByPlayerId)) {
      const r = PARTNER_EMOTE_TTL_MS - (now - emote.ts)
      if (r > 0) expiries.push(r)
    }
    if (expiries.length === 0) return
    const remaining = Math.min(...expiries)
    const id = window.setTimeout(() => {
      setPartnerEmoteExpiryTick((t) => t + 1)
    }, remaining + 16)
    return () => window.clearTimeout(id)
  }, [mp.emoteByPlayerId])
  // Auto-close the emote panel when MP ends so we don't leave a
  // dangling popover floating in single-player mode.
  useEffect(() => {
    if (!isMultiplayer) setShowEmotePanel(false)
  }, [isMultiplayer])
  // Push the player's display-name edits to the server while we're
  // in a co-op session. Debounced so a fast typist doesn't spam
  // mutations as they type. We deliberately do NOT write
  // localStorage here — the leaderboard auto-fill stays whatever
  // they typed last in the high-score save dialog.
  useEffect(() => {
    if (!isMultiplayer) return
    const handle = window.setTimeout(() => {
      mp.setName(mpPlayerName).catch(() => {})
    }, 300)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mpPlayerName, isMultiplayer])
  // First-run backfill: push every locally-saved high score up to
  // the global leaderboards. The dedup index in the mutation makes
  // re-submissions a no-op, but we also gate this with a one-shot
  // localStorage flag so a normal session does no work. This is
  // best-effort; if the browser is offline we'll retry on the next
  // launch (the flag isn't set unless every submit returned).
  const didBackfillRef = useRef<boolean>(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (didBackfillRef.current) return
    if (window.localStorage.getItem('cubic-global-backfilled-v1') === '1') {
      didBackfillRef.current = true
      return
    }
    didBackfillRef.current = true
    void (async () => {
      try {
        const endless = loadHighScores()
        for (const e of endless) {
          await submitEndlessGlobal({
            playerId,
            name: e.name,
            score: e.score,
            savedAt: e.date,
          })
        }
        const dailies = loadDailyHighScores()
        for (const e of dailies) {
          await submitDailyGlobal({
            playerId,
            name: e.name,
            moves: e.moves,
            dateKey: getDateKeyFromTimestamp(e.date),
            savedAt: e.date,
          })
        }
        // Sweep all per-date stash keys (`cubic-daily-runs-YYYY-M-D`)
        // so historical daily runs land on global too — these are the
        // entries that don't show up in `cubic-daily-highscores` once
        // they fall out of the top 5.
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const k = window.localStorage.key(i)
          if (!k || !k.startsWith(DAILY_PLAYER_RUNS_PREFIX)) continue
          const dateKey = k.slice(DAILY_PLAYER_RUNS_PREFIX.length)
          const runs = loadDailyRunsForDateKey(dateKey)
          for (const e of runs) {
            await submitDailyGlobal({
              playerId,
              name: e.name,
              moves: e.moves,
              dateKey,
              savedAt: e.date,
            })
          }
        }
        window.localStorage.setItem('cubic-global-backfilled-v1', '1')
      } catch {
        // Swallow — leaving the flag unset means we'll retry next
        // session, and the server-side dedup keeps re-runs cheap.
        didBackfillRef.current = false
      }
    })()
    // We intentionally only want this to fire once per mount; after
    // that the ref / localStorage flag prevents repeats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const createRoomMutation = useMutation(api.rooms.createRoom)
  const prepareRoomForShareMutation = useMutation(
    api.rooms.prepareRoomForShare,
  )
  const joinRoomMutation = useMutation(api.rooms.joinRoom)
  // Global leaderboard mutations + queries. The mutations get fired
  // alongside every local save (and during a one-time backfill of the
  // player's existing local entries). The queries are only enabled
  // when the High Scores card is open and the global toggle is on,
  // so we don't pay for a subscription while the menu is closed.
  const submitEndlessGlobal = useMutation(api.leaderboard.submitEndlessScore)
  const submitDailyGlobal = useMutation(api.leaderboard.submitDailyScore)
  const submitCoopGlobal = useMutation(api.leaderboard.submitCoopScore)
  const submitPvpGlobal = useMutation(api.leaderboard.submitPvpResult)
  const mergeAccountStats = useMutation(api.accountStats.mergeMyStats)
  const { signIn, signOut } = useAuthActions()
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth()
  const accountStatsQuery = useQuery(
    api.accountStats.getMyStats,
    isAuthenticated ? {} : 'skip',
  )
  // Track whether we've already attempted to join the current room so a
  // single failure or a full-room error doesn't get retried in a loop on
  // every render.
  const joinAttemptRef = useRef<{ code: string; attempted: boolean }>({
    code: '',
    attempted: false,
  })
  const [mpError, setMpError] = useState<string | null>(null)
  const [mpShareUrl, setMpShareUrl] = useState<string | null>(null)
  // Tri-state for the new "Copy Link" button so we can flash a
  // "Copied!" confirmation right on the button without popping a
  // modal. The timer ref is held outside React state so re-renders
  // don't cancel a pending revert.
  const [copyLinkLabel, setCopyLinkLabel] = useState<'idle' | 'copied' | 'busy'>(
    'idle',
  )
  const copyLinkTimerRef = useRef<number | null>(null)

  // First-launch micro-tutorial. The detector runs once at mount; we
  // hold the result in a ref so the placement engine can suppress its
  // auto-deal / game-over branches without depending on React state
  // closure semantics.
  const [tutorialStage, setTutorialStage] = useState<TutorialStage>(() =>
    isFirstLaunchEver() ? 1 : 0,
  )
  const tutorialStageRef = useRef<TutorialStage>(tutorialStage)
  useEffect(() => {
    tutorialStageRef.current = tutorialStage
  }, [tutorialStage])
  const [ftueHint, setFtueHint] = useState<FtueHint | null>(null)
  const ignoreFtueHintStorage = isDevForceTutorial()
  const undoHintSeenRef = useRef(
    ignoreFtueHintStorage ? false : getStorageFlag(FTUE_UNDO_HINT_KEY),
  )
  const holdHintSeenRef = useRef(
    ignoreFtueHintStorage ? false : getStorageFlag(FTUE_HOLD_HINT_KEY),
  )
  const flowerHintSeenRef = useRef(
    ignoreFtueHintStorage ? false : getStorageFlag(FTUE_FLOWER_HINT_KEY),
  )
  const comboHintSeenRef = useRef(
    ignoreFtueHintStorage ? false : getStorageFlag(FTUE_COMBO_HINT_KEY),
  )
  const [dailyIntroSeen, setDailyIntroSeen] = useState(() =>
    getStorageFlag(FTUE_DAILY_INTRO_KEY),
  )
  const [tutorialEndScreenPending, setTutorialEndScreenPending] =
    useState(false)

  const [game, setGame] = useState<GameState>(() =>
    tutorialStage === 1
      ? createTutorialStage1State()
      : loadInitialGameFromStorage(),
  )
  const showFtueHint = useCallback(
    (
      kind: FtueHintKind,
      text: string,
      storageKey: string,
      seenRef: { current: boolean },
    ) => {
      if (seenRef.current) return
      if (kind !== 'hold' && kind !== 'undo') {
        seenRef.current = true
        setStorageFlag(storageKey)
      }
      setFtueHint({ kind, text })
    },
    [],
  )
  const dismissActionFtueHint = useCallback(() => {
    setFtueHint((prev) => {
      if (prev?.kind !== 'hold' && prev?.kind !== 'undo') return prev
      if (prev.kind === 'hold') {
        holdHintSeenRef.current = true
        setStorageFlag(FTUE_HOLD_HINT_KEY)
      } else {
        undoHintSeenRef.current = true
        setStorageFlag(FTUE_UNDO_HINT_KEY)
      }
      return null
    })
  }, [])
  const markDailyIntroSeen = useCallback(() => {
    if (dailyIntroSeen) return
    setDailyIntroSeen(true)
    setStorageFlag(FTUE_DAILY_INTRO_KEY)
  }, [dailyIntroSeen])
  // Dev-only: support `?devScore=N` in the URL to seed the current
  // game's `score` field on load. Lets us visually scrub through
  // every score-tier / octave milestone without grinding to 25k in
  // real gameplay. Only fires in `import.meta.env.DEV` so it's a
  // strict no-op in production builds. Reads once on mount.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('devScore')
    if (raw === null) return
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return
    setGame((current) => ({ ...current, score: Math.floor(n) }))
  }, [])
  // Dev-only preview for the end-of-run highlight reel. Setting
  // `?devReel=1` mounts a synthetic best-placement snapshot in
  // `modalHighlightSnapshot` so the reel renders inside a
  // standalone popover without having to play a full game to
  // gameover. Pure visual debug aid; gated behind
  // `import.meta.env.DEV` so production never sees the popover.
  const [devReelOpen, setDevReelOpen] = useState(false)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('devReel') !== '1') return
    // Build a plausible endless-mode clear: a horizontal line
    // through r=0 with a singlet placed at (0,0) to trigger it.
    // `boardBefore` has every other cell on that line filled so
    // the placement completes the line and earns the pattern.
    const boardDef = getBoardDefinitionForMode('endless')
    const lineCells = ['-4,0', '-3,0', '-2,0', '-1,0', '0,0', '1,0', '2,0', '3,0', '4,0']
    const validLineCellIds = lineCells.filter((id) =>
      boardDef.cells.some((c) => c.id === id),
    )
    const placedCellId = validLineCellIds[Math.floor(validLineCellIds.length / 2)]
    const boardBefore = boardDef.cells.reduce<Record<string, 'empty' | 'filled'>>(
      (acc, cell) => {
        acc[cell.id] = 'empty'
        return acc
      },
      {},
    )
    for (const cellId of validLineCellIds) {
      if (cellId === placedCellId) continue
      boardBefore[cellId] = 'filled'
    }
    const linePattern = boardDef.patterns.find(
      (p) =>
        p.type === 'line' &&
        validLineCellIds.every((id) => p.cellIds.includes(id)),
    )
    if (!linePattern) return
    setModalHighlightSnapshot({
      mode: 'endless',
      boardBefore,
      placedCellIds: [placedCellId!],
      clearedCellIds: linePattern.cellIds,
      clearedPatterns: [
        { type: linePattern.type, cellIds: [...linePattern.cellIds] },
      ],
      pointsGained: 240,
      causedBoardClear: false,
      // Mark one filled line cell as a ruby so the dev reel
      // exercises the red-hex ruby render.
      goldenCellIds: validLineCellIds.filter((id) => id !== placedCellId).slice(0, 1),
    })
    setDevReelOpen(true)
  }, [])
  // Dev-only preview for the gameover modal itself. `?devGameOver=1`
  // forces game.gameOver=true on mount with a score in the high-
  // score range and a synthetic best-placement snapshot wired into
  // the highlight reel, so the full endless modal (reel + recap +
  // leaderboard + save input + sticky CTA) is testable without
  // playing a real run to completion. Optional `&devLb=many` seeds
  // mock local high scores so the Top-3 / Show-all toggle has data
  // to expand into.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('devGameOver') !== '1') return
    // Seed mock piece-stats for Bea (1x1x1) so the Piecetiary
    // detail view has a populated 2-column stat grid to inspect.
    // Touches a single variant id so the rest of the grid stays
    // in its honest "haven't played me yet" empty state.
    if (params.get('devPieceStats') === 'bea') {
      const seeded: PieceStatsMap = {
        'shape-1-0-r0': {
          timesPlayed: 142,
          clearsCaused: 38,
          combosJoined: 12,
          boardClears: 2,
          rubiesCaptured: 7,
          totalPointsGained: 4870,
          bestClear: 320,
          killingHands: 6,
        },
      }
      try {
        window.localStorage.setItem(
          'cubic-piece-stats-v1',
          JSON.stringify(seeded),
        )
      } catch {
        // Best-effort seeding.
      }
      // localStorage seeding alone isn't enough — pieceStats has
      // already initialized from storage on mount, so push the
      // seed into React state too.
      setPieceStats(seeded)
    }
    // Seed mock local high scores so the compact-vs-expanded
    // leaderboard toggle has rows to surface. The new run's
    // score is set below so it falls mid-pack and the player's
    // pinned row exercises the "outside top 3" path.
    if (params.get('devLb') === 'many') {
      try {
        const seedNames = [
          'Mira',
          'Kai',
          'Juno',
          'Vex',
          'Lio',
          'Sol',
          'Rae',
          'Pip',
          'Ash',
          'Eli',
        ]
        const seed = seedNames.map((name, i) => ({
          name,
          score: 8000 - i * 350,
          date: Date.now() - (i + 1) * 24 * 60 * 60 * 1000,
        }))
        window.localStorage.setItem('cubic-highscores', JSON.stringify(seed))
      } catch {
        // Best-effort seeding; if storage is unavailable the
        // modal just renders against whatever the page already
        // has, which is fine for an ad-hoc dev preview.
      }
    }
    const boardDef = getBoardDefinitionForMode('endless')
    const lineCells = ['-4,0', '-3,0', '-2,0', '-1,0', '0,0', '1,0', '2,0', '3,0', '4,0']
    const validLineCellIds = lineCells.filter((id) =>
      boardDef.cells.some((c) => c.id === id),
    )
    const placedCellId = validLineCellIds[Math.floor(validLineCellIds.length / 2)]
    const boardBefore = boardDef.cells.reduce<Record<string, 'empty' | 'filled'>>(
      (acc, cell) => {
        acc[cell.id] = 'empty'
        return acc
      },
      {},
    )
    for (const cellId of validLineCellIds) {
      if (cellId === placedCellId) continue
      boardBefore[cellId] = 'filled'
    }
    const linePattern = boardDef.patterns.find(
      (p) =>
        p.type === 'line' &&
        validLineCellIds.every((id) => p.cellIds.includes(id)),
    )
    if (linePattern) {
      const snapshot: RunHighlightSnapshot = {
        mode: 'endless',
        boardBefore,
        placedCellIds: [placedCellId!],
        clearedCellIds: linePattern.cellIds,
        clearedPatterns: [
          { type: linePattern.type, cellIds: [...linePattern.cellIds] },
        ],
        pointsGained: 480,
        causedBoardClear: false,
        goldenCellIds: validLineCellIds
          .filter((id) => id !== placedCellId)
          .slice(0, 1),
      }
      // Seed both the live ref AND the modal-state snapshot. The
      // real gameOver transition effect promotes the ref into
      // modal state, so populating the ref keeps the production
      // code path happy; explicitly setting the modal snapshot
      // belt-and-suspenders ensures the reel renders even if any
      // intermediate effect clobbers the ref back to null first.
      runHighlightRef.current = snapshot
      setModalHighlightSnapshot(snapshot)
    }
    setGame((current) => ({
      ...current,
      mode: 'endless',
      score: 4250,
      gameOver: true,
    }))
    // Re-assert the modal snapshot after a tick so we win against
    // the gameover-transition effect that runs on the next commit
    // and would otherwise reset modalHighlightSnapshot back to
    // whatever runHighlightRef.current was at THAT moment (which
    // can be null in StrictMode's double-effect run).
    window.setTimeout(() => {
      if (!linePattern) return
      setModalHighlightSnapshot({
        mode: 'endless',
        boardBefore,
        placedCellIds: [placedCellId!],
        clearedCellIds: linePattern.cellIds,
        clearedPatterns: [
          { type: linePattern.type, cellIds: [...linePattern.cellIds] },
        ],
        pointsGained: 480,
        causedBoardClear: false,
        goldenCellIds: validLineCellIds
          .filter((id) => id !== placedCellId)
          .slice(0, 1),
      })
    }, 200)
  }, [])
  // Dev-only preview for the "Export recent moves as GIF" modal.
  // `?devExportGif=N` (defaulting to 5) seeds `runHistoryRef` with
  // N synthetic line-clear placements that share a contiguous
  // boardBefore→boardAfter chain, then opens the modal so the
  // multi-snapshot preview + encoder can be tested without playing
  // a full session up to the desired move count.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('devExportGif')
    if (raw === null) return
    const count = Math.max(1, Math.min(RUN_HISTORY_EXPORT_MAX, Number(raw) || 5))
    const boardDef = getBoardDefinitionForMode('endless')
    // Same "fill r=0 minus one slot, drop the singlet, clear the
    // line" recipe as the devReel mock, but repeated N times with
    // each placement targeting a different gap. The boardBefore
    // for snapshot i+1 equals the boardAfter for snapshot i — both
    // are "every cell on r=0 empty" since the line clears each
    // time — so the preview transitions cleanly between moves.
    const lineCells = ['-4,0', '-3,0', '-2,0', '-1,0', '0,0', '1,0', '2,0', '3,0', '4,0']
    const validLineCellIds = lineCells.filter((id) =>
      boardDef.cells.some((c) => c.id === id),
    )
    if (validLineCellIds.length === 0) return
    const linePattern = boardDef.patterns.find(
      (p) =>
        p.type === 'line' &&
        validLineCellIds.every((id) => p.cellIds.includes(id)),
    )
    if (!linePattern) return
    const snapshots: RunHighlightSnapshot[] = []
    for (let i = 0; i < count; i++) {
      const placedIdx = i % validLineCellIds.length
      const placedCellId = validLineCellIds[placedIdx]
      const boardBefore = boardDef.cells.reduce<
        Record<string, 'empty' | 'filled'>
      >((acc, cell) => {
        acc[cell.id] = 'empty'
        return acc
      }, {})
      for (const cellId of validLineCellIds) {
        if (cellId === placedCellId) continue
        boardBefore[cellId] = 'filled'
      }
      snapshots.push({
        mode: 'endless',
        boardBefore,
        placedCellIds: [placedCellId],
        clearedCellIds: linePattern.cellIds,
        clearedPatterns: [
          { type: linePattern.type, cellIds: [...linePattern.cellIds] },
        ],
        pointsGained: 240 + i * 30,
        causedBoardClear: false,
        goldenCellIds: [],
      })
    }
    runHistoryRef.current = snapshots
    setExportGifCount(Math.min(count, RUN_HISTORY_EXPORT_MAX))
    setExportGifProgress(null)
    setShowExportGif(true)
  }, [])
  // All board-shape data (cell positions, layout dimensions, rosette
  // boundaries, etc.) is precomputed once per mode at module load and
  // re-pointed at when the active mode changes. Everything below uses
  // `boardDef` / `boardLayout` rather than the legacy module-level
  // BOARD_DEFINITION / BOARD_LAYOUT constants so big mode can reuse the
  // entire render tree with its own cells.
  const boardRender = useMemo(
    () => getRenderDataForMode(game.mode),
    [game.mode],
  )
  const boardDef = boardRender.boardDef
  const boardCellIdSet = useMemo(
    () => new Set(boardDef.cells.map((c) => c.id)),
    [boardDef],
  )
  // Outer hull segments — suppress the dark shadow stroke on the board edge
  // while keeping it between rosettes (carved depth there).
  const glassExteriorEdgeKeys = useMemo(
    () => new Set(boardRender.outlineSegments.map(segmentKey)),
    [boardRender],
  )
  const glassInterRosetteFlowerBackSegments = useMemo(
    () =>
      dedupeSegments(boardRender.flowerBoundarySegments).filter(
        (seg) => !glassExteriorEdgeKeys.has(segmentKey(seg)),
      ),
    [boardRender, glassExteriorEdgeKeys],
  )
  const glassInterRosetteFlowerFrontSegments = useMemo(
    () =>
      dedupeSegments(boardRender.flowerBoundarySegments).filter(
        (seg) => !glassExteriorEdgeKeys.has(segmentKey(seg)),
      ),
    [boardRender, glassExteriorEdgeKeys],
  )
  // Inter-rosette stone ribs — interior lead must not cross these edges.
  const glassFlowerBoundaryEdgeKeys = useMemo(
    () =>
      new Set(
        dedupeSegments(boardRender.flowerBoundarySegments).map(segmentKey),
      ),
    [boardRender],
  )
  // Hull rim lead — one closed path, inset to the glass lip, above stone.
  const glassHullLeadLoop = useMemo(() => {
    const loop = stitchClosedLoop(boardRender.outlineSegments)
    if (loop.length < 3) return null
    return insetClosedLoop(loop, 2.5, {
      x: boardRender.layout.width / 2,
      y: boardRender.layout.height / 2,
    })
  }, [boardRender])
  // Stone tracery is wider than the thin pane lead, so it gets a deeper
  // perimeter clip. This keeps inter-rosette mullions from crossing over the
  // interior side of the exterior stone reveal at hull junctions.
  const glassStoneTraceryClipLoop = useMemo(() => {
    const loop = stitchClosedLoop(boardRender.outlineSegments)
    if (loop.length < 3) return null
    return insetClosedLoop(loop, 7.5, {
      x: boardRender.layout.width / 2,
      y: boardRender.layout.height / 2,
    })
  }, [boardRender])
  // True iff the player committed to a session this load — either by having
  // an in-progress game restored from storage, or by explicitly starting /
  // resetting a run from the menu, or by placing their first piece. Once
  // true, never flips back. Drives whether the menu shows the prominent
  // "New Game" button (only on a true cold-boot with no in-progress save)
  // versus the normal Restart-run + Resume pause menu.
  //
  // Note: the persist effect writes the initial empty game to storage on
  // first render, so we can't gate on "key exists in localStorage" — that
  // would trip on the second visit even if the player never engaged. We
  // instead inspect the loaded game's actual state.
  const [hasStartedSession, setHasStartedSession] = useState<boolean>(() => {
    // First-launch tutorial counts as "not started" so the menu still
    // offers New Game after the player finishes the guided opening.
    if (isFirstLaunchEver()) return false
    const initial = loadInitialGameFromStorage()
    return initial.moves > 0 || initial.gameOver
  })
  const [selectedPieceId, setSelectedPieceId] = useState<string | null>(null)
  const [hover, setHover] = useState<HoverInfo>(null)
  const [clearingCells, setClearingCells] = useState<string[]>([])
  const [clearingClassesByCell, setClearingClassesByCell] = useState<
    Record<string, string[]>
  >({})
  // Stained-glass shatter. The engine drains clearingCells after 600ms,
  // which is too fast to read the shards breaking apart. So in the glass
  // theme we snapshot the cleared cells into their own state and keep the
  // shard overlay mounted on a longer, theme-owned timeline (well past
  // the engine's clear window) so the break is actually legible. The
  // token re-keys the shard <g> on every clear so the animation restarts
  // cleanly even on rapid back-to-back clears.
  const [glassShatter, setGlassShatter] = useState<{
    cells: string[]
    token: number
  } | null>(null)
  // Stained-glass per-cell jewel colors. When a piece is placed in the glass
  // theme each landed cell records the jewel index of the cube that filled
  // it, so the color the player saw in their hand persists on the board.
  // Keyed by cell id, value is an index into GLASS_JEWELS. Pruned to filled
  // cells whenever the board changes (so it resets with a new game and never
  // grows unbounded). Cells with no entry fall back to a deterministic jewel
  // from the cell id, so pre-seeded boards / rubies still get a color.
  const [glassCellColors, setGlassCellColors] = useState<Record<string, number>>(
    {},
  )
  // Ruby cells participating in the *current* clear animation. Tracked
  // as a list so big-board placements that sweep up multiple rubies in
  // one move can keep the ruby decoration on every cleared cell, not
  // just the first one.
  const [clearingGoldenCellIds, setClearingGoldenCellIds] = useState<string[]>([])
  // If a ruby (golden cube) respawns onto an empty cell, game logic
  // marks that destination cell as filled immediately. During the clear
  // animation we keep the ruby highlight on the *previous* cells, so we
  // hide each destination cube until the animation finishes to avoid a
  // brief "normal cube" flash. Big board can spawn several at once.
  const [pendingGoldenSpawnCellIds, setPendingGoldenSpawnCellIds] = useState<
    string[]
  >([])
  const [recentlyPlacedCells, setRecentlyPlacedCells] = useState<string[]>([])
  // Screenshake & hitstop are driven by tokens that increment per event so
  // we can retrigger CSS animations without remounting the wrapper element.
  const [shakeRequest, setShakeRequest] = useState<{
    token: number
    intensity: number
  }>({ token: 0, intensity: 0 })
  const [hitstop, setHitstop] = useState(false)
  // Bumped every time a fresh 3-piece hand is dealt. Used as part of each
  // hand-piece button's React key so all three buttons remount together
  // and the fly-in animation always plays on a hand refresh.
  const [handFlyInToken, setHandFlyInToken] = useState(0)
  // Per-slot fly-in completion, scoped to a token. Once the deal animation
  // has played for a slot we drop the `hexaclear-piece-flyin` class so an
  // unrelated CSS rule change (notably the failed-drop shake clearing
  // back out) can't re-trigger the deal animation a second time. State
  // is keyed by token so a fresh hand naturally starts everything at
  // "not yet played" without needing a separate reset effect that would
  // fight the initial render.
  const [flyInDoneState, setFlyInDoneState] = useState<{
    token: number
    done: boolean[]
  }>({ token: -1, done: [] })
  const isFlyInDone = (slotIndex: number) =>
    flyInDoneState.token === handFlyInToken &&
    (flyInDoneState.done[slotIndex] ?? false)
  const markFlyInDone = (slotIndex: number) => {
    setFlyInDoneState((prev) => {
      const baseDone = prev.token === handFlyInToken ? prev.done : []
      if (baseDone[slotIndex]) return prev
      const nextDone = [...baseDone]
      while (nextDone.length <= slotIndex) nextDone.push(false)
      nextDone[slotIndex] = true
      return { token: handFlyInToken, done: nextDone }
    })
  }
  // ---- Deal-in (run-start choreography) -----------------------------
  //
  // While true, the board cells wear the rosette-cascade animation
  // (per-cell delays pre-baked in BoardRenderData) and the hand fly-in
  // gains a base delay so pieces deal in after the board builds. Fresh
  // runs only; resumed games restore instantly. Any pointerdown skips.
  // See Documentation/Deal-In and Living Board Plan.md.
  const [dealInActive, setDealInActive] = useState(false)
  const dealInTimersRef = useRef<number[]>([])
  const dealInSkipCleanupRef = useRef<(() => void) | null>(null)
  // CUBEKILL announce lifecycle: the wordmark is absent from the
  // header while the announce flies (is-announce-flying hides it),
  // slams in big over the board, then settles into the header title's
  // measured position — at which point `announceLanded` unmounts the
  // overlay and reveals the real title in the same spot.
  const [announceLanded, setAnnounceLanded] = useState(false)
  const announceTextRef = useRef<HTMLSpanElement | null>(null)

  // Announcer text pop: the visual companion to the voice lines — a
  // celebratory call ("TRIPLE!", "GODLIKE!", "BOARD CLEAR!") that
  // punches in above the board on the same beat as the audio. Token
  // keys the element so back-to-back cues retrigger cleanly; `scale`
  // sizes the type to the magnitude of the moment; `kind` lets CSS
  // (and each theme) color combos / streaks / board clears
  // differently. Skipped wholesale under reduced motion (voice still
  // plays, matching the design doc).
  const [announcerPop, setAnnouncerPop] = useState<{
    token: number
    text: string
    kind: 'combo' | 'streak' | 'boardclear'
    scale: number
  } | null>(null)
  const announcerPopTimerRef = useRef<number | null>(null)
  const showAnnouncerPop = useCallback(
    (text: string, kind: 'combo' | 'streak' | 'boardclear', scale: number) => {
      if (reducedMotionRef.current) return
      if (announcerPopTimerRef.current !== null) {
        window.clearTimeout(announcerPopTimerRef.current)
      }
      setAnnouncerPop((prev) => ({
        token: (prev?.token ?? 0) + 1,
        text,
        kind,
        scale,
      }))
      // Life: 140ms sync delay + ~620ms animation + slack.
      announcerPopTimerRef.current = window.setTimeout(() => {
        announcerPopTimerRef.current = null
        setAnnouncerPop(null)
      }, 1000)
    },
    [],
  )

  const finishDealIn = useCallback(() => {
    for (const t of dealInTimersRef.current) window.clearTimeout(t)
    dealInTimersRef.current = []
    if (dealInSkipCleanupRef.current) {
      dealInSkipCleanupRef.current()
      dealInSkipCleanupRef.current = null
    }
    setDealInActive(false)
  }, [])

  const reducedMotionRef = useRef(false)

  const startDealIn = useCallback(() => {
    finishDealIn()
    setDealInActive(true)
    setAnnounceLanded(false)
    // Remount the hand buttons so the fly-in always replays as part of
    // the choreography (callers that already bump the token just merge
    // into the same remount).
    setHandFlyInToken((t) => t + 1)

    if (reducedMotionRef.current) {
      // Reduced motion: CSS collapses the cascade to a single short
      // board fade; no audio ticks, short active window. The announcer
      // still calls the run — reduced motion gates motion, not sound
      // (same policy as the critical heartbeat).
      dealInTimersRef.current.push(
        window.setTimeout(() => playCubekillAnnounce(), 80),
      )
      dealInTimersRef.current.push(
        window.setTimeout(() => finishDealIn(), DEAL_IN_REDUCED_MOTION_MS),
      )
      return
    }

    // Nearly every call site is a click handler ("New game", retry,
    // mode switch), which is a valid user activation — prime the audio
    // context from it so the ticks below actually sound on a fresh
    // page load whose first gesture is starting a run. Without this
    // the context is still suspended and readyContext() swallows every
    // tick silently. From the mount path (no activation) this is a
    // harmless no-op and the deal-in stays visual-only, as designed.
    unlockAudioOnGesture()

    // One pitch-stepped tick per rosette, on the rosette stagger clock.
    // playDealTick no-ops while audio is locked/muted, so cold loads
    // (no gesture yet) stay silent without special-casing here. The
    // first tick is nudged off t=0 to give the just-resumed context a
    // beat to reach 'running' (resume() is async even inside a
    // gesture).
    for (let i = 0; i < 7; i++) {
      dealInTimersRef.current.push(
        window.setTimeout(
          () => playDealTick(i, 7),
          Math.max(40, i * DEAL_IN_ROSETTE_STAGGER_MS),
        ),
      )
    }
    // CUBEKILL title slam: the announce overlay (rendered while
    // dealInActive) lands its impact frame ~340ms in. The voice leads
    // slightly so it lands ON the hit instead of trailing it; the
    // screen kick stays glued to the visual impact frame.
    dealInTimersRef.current.push(
      window.setTimeout(() => playCubekillAnnounce(), DEAL_IN_ANNOUNCE_VOICE_MS),
    )
    dealInTimersRef.current.push(
      window.setTimeout(() => {
        setShakeRequest((prev) => ({ token: prev.token + 1, intensity: 2.5 }))
      }, DEAL_IN_ANNOUNCE_IMPACT_MS),
    )

    dealInTimersRef.current.push(
      window.setTimeout(() => finishDealIn(), DEAL_IN_TOTAL_MS),
    )

    // Skip on the next pointerdown. The gesture that *started* the run
    // can't trigger this: its pointerdown happened before the click
    // handler that called us. Cells snap to their final state and the
    // hand fly-in fast-forwards (its delay variable drops by 400ms).
    const onSkip = () => finishDealIn()
    window.addEventListener('pointerdown', onSkip, {
      capture: true,
      once: true,
    })
    dealInSkipCleanupRef.current = () =>
      window.removeEventListener('pointerdown', onSkip, { capture: true })
  }, [finishDealIn])

  // Unmount safety: clear any in-flight deal-in timers.
  useEffect(() => () => finishDealIn(), [finishDealIn])

  // Radial particle bursts that fire at each ruby's old position when
  // it gets cleared. Each burst has a unique token; big-board moves can
  // queue several at once and they all animate independently before
  // expiring together when the list resets.
  const [rubyBursts, setRubyBursts] = useState<
    Array<{ token: number; x: number; y: number }>
  >([])
  // While true, the game-over modal is suppressed and the board is in
  // its wind-down phase (desaturating, hand pieces shaking).
  const [gameOverWindingDown, setGameOverWindingDown] = useState(false)

  // ---- Game-over collapse ---------------------------------------------
  //
  // When a run ends (loss), the board structurally fails: every filled
  // hex pops loose in a wave radiating from the killing piece, tumbles
  // down the board face with a clatter, and settles into a debris pile
  // along the bottom rim. The pile stays as the modal's backdrop and is
  // swept (250ms fade) when the player leaves the game-over state.
  //
  // Mechanics: each filled cell's <g> is DOM-cloned into an overlay
  // layer (theme-perfect for free — wood cubes, win98 tiles, glass
  // panes all carry their own markup), the original is hidden via the
  // `collapse-hidden` class, and the clone runs one shared keyframe
  // animation driven by per-cube CSS vars (delay, duration, drift,
  // drop, bounce, rotation). The "physics" is a staged settle: cubes
  // are bucketed into columns and stacked in release order. Disabled
  // in multiplayer and under reduced motion (desaturate carries it).
  type CollapseCube = {
    id: string
    delayMs: number
    durMs: number
    driftX: number
    dy: number
    bounce: number
    rot: number
  }
  const [collapse, setCollapse] = useState<{
    token: number
    cubes: CollapseCube[]
  } | null>(null)
  const [collapseSwept, setCollapseSwept] = useState(false)
  const collapseLayerRef = useRef<SVGGElement | null>(null)
  const collapseSweepTimerRef = useRef<number | null>(null)
  // The last placement's cells — the wave origin. Updated on every
  // single-player placement; if a game somehow ends without one (e.g.
  // a dealt hand with no moves on a restored board), the board center
  // is a fine stand-in.
  const lastPlacementCellIdsRef = useRef<string[] | null>(null)
  const collapseCellIdSet = useMemo(
    () => new Set(collapse?.cubes.map((c) => c.id) ?? []),
    [collapse],
  )

  const buildCollapse = useCallback(() => {
    const layout = boardRender.layout
    const filled = boardRender.boardDef.cells.filter(
      (cell) => game.board[cell.id] === 'filled',
    )
    if (filled.length === 0) return

    const centerOf = (id: string) => {
      const pos = layout.positions[id]
      return { x: pos.x + layout.offsetX, y: pos.y + layout.offsetY }
    }

    // Wave origin: centroid of the killing piece (fallback: board center).
    const originCells = lastPlacementCellIdsRef.current
    let ox = layout.width / 2
    let oy = layout.height / 2
    if (originCells && originCells.length > 0) {
      ox = 0
      oy = 0
      for (const id of originCells) {
        const c = centerOf(id)
        ox += c.x / originCells.length
        oy += c.y / originCells.length
      }
    }

    const maxDist = Math.max(
      1,
      ...filled.map((cell) => {
        const c = centerOf(cell.id)
        return Math.hypot(c.x - ox, c.y - oy)
      }),
    )

    // Staged settle: bucket cubes into columns along the bottom rim,
    // stacked in release order so the first cubes loose land lowest.
    const floorY = layout.height - HEX_SIZE * 0.85
    const slotW = HEX_SIZE * 1.75
    const slotCount = Math.max(1, Math.floor(layout.width / slotW))
    const stackBySlot: number[] = new Array(slotCount).fill(0)

    const cubes: CollapseCube[] = filled
      .map((cell) => {
        const c = centerOf(cell.id)
        const dist = Math.hypot(c.x - ox, c.y - oy)
        return { cell, c, delayMs: (dist / maxDist) * 650 + Math.random() * 70 }
      })
      .sort((a, b) => a.delayMs - b.delayMs)
      .map(({ cell, c, delayMs }) => {
        const driftX = (Math.random() - 0.5) * HEX_SIZE * 0.9
        const slot = Math.min(
          slotCount - 1,
          Math.max(0, Math.round((c.x + driftX) / slotW)),
        )
        const stack = stackBySlot[slot]
        stackBySlot[slot] += 1
        const restY = floorY - stack * HEX_SIZE * 1.05
        const dy = Math.max(HEX_SIZE * 0.4, restY - c.y)
        return {
          id: cell.id,
          delayMs,
          durMs: 600 + dy * 0.5,
          driftX,
          dy,
          bounce: Math.min(26, 10 + dy * 0.04),
          rot: (Math.random() < 0.5 ? -1 : 1) * (12 + Math.random() * 26),
        }
      })

    // Clatter: sample ~1 in 3 impacts (capped) so the burst reads as
    // debris, not a drumroll. Impact lands at ~72% of each fall.
    const impacts = cubes
      .map((cube) => cube.delayMs + cube.durMs * 0.72)
      .sort((a, b) => a - b)
    for (let i = 0; i < impacts.length && i / 3 < 16; i += 3) {
      playCollapseClatter(impacts[i])
    }

    setCollapse((prev) => ({ token: (prev?.token ?? 0) + 1, cubes }))
    setCollapseSwept(false)
  }, [boardRender, game.board])

  // Sweep: leaving the game-over state (retry, new game, mode switch)
  // fades the debris out while the next board builds. The hidden-cell
  // class is gated on game.gameOver, so the incoming board's cells are
  // never affected even though cell ids repeat across runs.
  useEffect(() => {
    if (!collapse || game.gameOver) return
    setCollapseSwept(true)
    collapseSweepTimerRef.current = window.setTimeout(() => {
      collapseSweepTimerRef.current = null
      const layer = collapseLayerRef.current
      if (layer) layer.replaceChildren()
      setCollapse(null)
      setCollapseSwept(false)
    }, 280)
    return () => {
      if (collapseSweepTimerRef.current !== null) {
        window.clearTimeout(collapseSweepTimerRef.current)
        collapseSweepTimerRef.current = null
      }
    }
  }, [collapse, game.gameOver])

  // Build the debris clones once the collapse-hidden classes have
  // committed: clone each doomed cell wholesale (hex, cube, jewels,
  // labels — whatever the theme drew), strip interactivity, attach the
  // per-cube animation vars, and let CSS drop them.
  useLayoutEffect(() => {
    if (!collapse) return
    const layer = collapseLayerRef.current
    const svg = svgRef.current
    if (!layer || !svg) return
    if (layer.childElementCount > 0) return // already built for this token
    for (const cube of collapse.cubes) {
      const cellEl = svg.querySelector(
        `[data-cell-id="${CSS.escape(cube.id)}"]`,
      )
      if (!cellEl) continue
      const clone = cellEl.cloneNode(true) as SVGGElement
      clone.classList.remove('collapse-hidden')
      clone.removeAttribute('data-cell-id')
      clone
        .querySelectorAll('[tabindex]')
        .forEach((n) => n.removeAttribute('tabindex'))
      const wrapper = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'g',
      )
      wrapper.setAttribute('class', 'hexaclear-collapse-cube')
      wrapper.style.setProperty('--cc-delay', `${cube.delayMs}ms`)
      wrapper.style.setProperty('--cc-dur', `${cube.durMs}ms`)
      wrapper.style.setProperty('--cc-drift', `${cube.driftX}px`)
      wrapper.style.setProperty('--cc-dy', `${cube.dy}px`)
      wrapper.style.setProperty('--cc-bounce', `${cube.bounce}px`)
      wrapper.style.setProperty('--cc-rot', `${cube.rot}deg`)
      wrapper.appendChild(clone)
      layer.appendChild(wrapper)
    }
  }, [collapse])

  // ---- Living Board (liveness + critical pressure) -------------------
  //
  // One derived snapshot per board/hand change: which empty cells are
  // still reachable by the current hand (+hold), and how many total
  // placements remain. Phase A (liveness): unreachable cells dim via
  // `cell-dead`. Phase B (critical): at <=5 total placements the map is
  // REVOKED — every empty cell joins one uniform synchronized alarm and
  // hand differentiation suspends, so the endgame hunt stays a human
  // skill. Hysteresis: enter <=5, exit >=8 or on any clear. Disabled in
  // tutorial and multiplayer. See Documentation/Deal-In and Living
  // Board Plan.md.
  const liveness = useMemo(
    () =>
      computeBoardLiveness(game.board, game.hand, game.mode, game.hold),
    [game.board, game.hand, game.mode, game.hold],
  )
  const livenessEnabled =
    !isMultiplayer &&
    tutorialStage === 0 &&
    !game.gameOver &&
    !gameOverWindingDown
  const [criticalActive, setCriticalActive] = useState(false)
  const criticalOnsetTimerRef = useRef<number | null>(null)
  // Adaptive thresholds: scarcity is judged per available piece
  // (hand + hold), not in raw totals — see the constants' comment.
  const criticalCandidates = Math.max(
    1,
    game.hand.length + (game.hold ? 1 : 0),
  )
  const criticalEnterMax = CRITICAL_ENTER_PER_PIECE * criticalCandidates
  const criticalExitMin = criticalEnterMax + CRITICAL_EXIT_GAP
  // The liveness map must vanish on the SAME render as the placement
  // that drops the board into critical territory — keying it off
  // criticalActive alone leaks the fresh valid-placement outlines for
  // the onset-delay window (and through clear animations) before the
  // alarm lands. Derived directly from the fit count, this hides the
  // map instantly and keeps it hidden through the hysteresis band
  // while the alarm holds.
  const criticalImminent =
    criticalActive ||
    (liveness.totalPlacements > 0 &&
      liveness.totalPlacements <= criticalEnterMax)

  useEffect(() => {
    const clearOnsetTimer = () => {
      if (criticalOnsetTimerRef.current !== null) {
        window.clearTimeout(criticalOnsetTimerRef.current)
        criticalOnsetTimerRef.current = null
      }
    }

    if (!livenessEnabled) {
      clearOnsetTimer()
      setCriticalActive(false)
      return
    }

    if (criticalActive) {
      // Exit ONLY when the player has real breathing room again (>=
      // the hysteresis ceiling). Clears that merely dent the danger do
      // NOT exit — the alarm holds continuously across placements,
      // clears, and fresh hands until the escape is genuine, so the
      // pulse never restarts mid-crisis (per review: exit-and-re-enter
      // flicker felt awkward). This exit is the "CLOSE CALL!"
      // announcer hook.
      if (liveness.totalPlacements >= criticalExitMin) {
        clearOnsetTimer()
        setCriticalActive(false)
      }
      return
    }

    // Enter: wait for clear animations to settle so the onset beat
    // never fights the clear juice, then freeze briefly (existing
    // hitstop) and snap every empty cell to the alarm simultaneously.
    if (
      liveness.totalPlacements > 0 &&
      liveness.totalPlacements <= criticalEnterMax &&
      clearingCells.length === 0 &&
      criticalOnsetTimerRef.current === null
    ) {
      setHitstop(true)
      criticalOnsetTimerRef.current = window.setTimeout(() => {
        criticalOnsetTimerRef.current = null
        setCriticalActive(true)
      }, 120)
    }

    return clearOnsetTimer
  }, [
    livenessEnabled,
    criticalActive,
    liveness,
    clearingCells,
    criticalEnterMax,
    criticalExitMin,
  ])

  // Critical audio: 55Hz heartbeat thump + master lowpass while the
  // alarm is up. audio.ts owns the clock; this just flips the switch
  // (and guarantees it flips back off on unmount).
  useEffect(() => {
    setCriticalAudio(criticalActive)
    return () => setCriticalAudio(false)
  }, [criticalActive])

  // Bumped each time a placement clears the entire board (+25 bonus).
  // Drives a one-shot golden flash overlay on the board wrapper.
  const [boardClearFlashToken, setBoardClearFlashToken] = useState(0)
  const [failedPlacementPieceId, setFailedPlacementPieceId] = useState<string | null>(
    null,
  )
  const [invalidDropCellIds, setInvalidDropCellIds] = useState<string[]>([])
  const [scorePopup, setScorePopup] = useState<string | null>(null)
  const [scorePopupId, setScorePopupId] = useState(0)
  const [scoreParticles, setScoreParticles] = useState<
    Array<{
      id: string
      value: number
      label?: string
      startX: number
      startY: number
      deltaX: number
      deltaY: number
      delay: number
      type: 'base' | 'combo' | 'streak' | 'piece'
    }>
  >([])
  const [showScoring, setShowScoring] = useState(false)
  // Active tab within the How-to-Play overlay. "rules" shows the
  // scoring rules / daily-puzzle rules (existing content); "pieces"
  // shows the Piecetiary — a visual reference for every piece shape
  // along with its name. Resets to "rules" every time the overlay
  // re-opens so the player lands on the familiar content first.
  const [scoringTab, setScoringTab] = useState<'rules' | 'pieces'>('rules')
  useEffect(() => {
    if (showScoring) setScoringTab('rules')
  }, [showScoring])
  const [showHighScores, setShowHighScores] = useState(false)
  // Profile-level stats modal, reachable from the pause menu via a
  // dedicated "Stats" button. Lives next to highscores / scoring as
  // a peer surface — same overlay treatment, just rendering the
  // lifetime totals instead.
  const [showStats, setShowStats] = useState(false)
  const [showAccount, setShowAccount] = useState(false)
  const [accountFormVisible, setAccountFormVisible] = useState(false)
  const [accountMode, setAccountMode] = useState<'signIn' | 'signUp'>('signIn')
  const [accountEmail, setAccountEmail] = useState('')
  const [accountPassword, setAccountPassword] = useState('')
  const [accountMessage, setAccountMessage] = useState<string | null>(null)
  const [accountError, setAccountError] = useState<string | null>(null)
  const [accountSyncState, setAccountSyncState] = useState<
    'idle' | 'syncing' | 'synced'
  >('idle')
  const [statsSyncLastAt, setStatsSyncLastAt] = useState<number | null>(() =>
    typeof window === 'undefined' ? null : loadStatsSyncLastAt(),
  )
  // Daily-history calendar modal. Toggled from the History button
  // we slot into the daily-mode top bar, and powers the past-day
  // replay flow (any cleared / played day on the calendar is
  // clickable to re-launch that day's seeded puzzle).
  const [showDailyHistory, setShowDailyHistory] = useState(false)
  // Currently displayed month in the calendar. Defaults to today's
  // month on first open and resets on close so the next open
  // always lands the player back on "now".
  const [historyMonth, setHistoryMonth] = useState<{
    year: number
    month: number
  }>(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() + 1 }
  })
  // Per-run stats accumulator (this run only). Reset whenever a new
  // run starts; updated on every placement; folded into the
  // lifetime profile on gameover.
  const [runStats, setRunStats] = useState<RunStats>(() =>
    createEmptyRunStats(),
  )
  // "Best placement of this run" snapshot. The ref tracks the
  // running-max during play (so the placement reducer can update
  // it synchronously without dragging React state through the
  // hot path); we mirror it into modalHighlightSnapshot at
  // gameover so the gameover modal can render the reel even if
  // the player keeps playing past the gameover (e.g. starts a
  // new run) and the live ref gets reset.
  const runHighlightRef = useRef<RunHighlightSnapshot | null>(null)
  const [modalHighlightSnapshot, setModalHighlightSnapshot] =
    useState<RunHighlightSnapshot | null>(null)
  // Rolling history of recent solo placements as RunHighlightSnapshots,
  // used by the pause menu's "Export recent moves" tool. Kept in a
  // ref (not React state) so we can append from inside the placement
  // reducer's hot path without triggering re-renders on every move.
  // Capped at RUN_HISTORY_MAX so an idle game can't grow this list
  // without bound; older entries are shifted off the front.
  const runHistoryRef = useRef<RunHighlightSnapshot[]>([])
  // Lifetime profile stats. Loaded from localStorage on mount;
  // overwritten on each gameover via foldRunIntoLifetime.
  const [lifetimeStats, setLifetimeStats] = useState<LifetimeStats>(() =>
    typeof window === 'undefined'
      ? createEmptyLifetimeStats()
      : loadLifetimeStats(),
  )
  // Per-rotation piece stats ("Piecetiary stats"). Loaded once on
  // mount; mutated through the deal/placement/gameover effects
  // below; persisted to localStorage on every change. Kept separate
  // from `lifetimeStats` because the surface area (44 small
  // counters) is large enough to deserve its own storage key and
  // its own retrospective UI on the Piecetiary tile.
  const [pieceStats, setPieceStats] = useState<PieceStatsMap>(() =>
    typeof window === 'undefined' ? {} : loadPieceStats(),
  )
  useEffect(() => {
    savePieceStats(pieceStats)
  }, [pieceStats])
  // Drives the Piecetiary detail sheet. Null means no sheet open;
  // a variant value means the player tapped that tile and wants to
  // see its stats / flavor lines.
  const [selectedPieceVariant, setSelectedPieceVariant] =
    useState<PieceVariant | null>(null)
  // One-shot backfill: existing accounts predate the synced
  // dailyBestMovesByDate map and only have per-day best moves in
  // `cubic-daily-best-<dateKey>` localStorage. Seed the map from
  // those local slots (plus any cleared day with no slot but a runs
  // list) so the next stats sync uploads them to the account and
  // every signed-in device can render them on the calendar.
  const dailyBestBackfillRanRef = useRef(false)
  useEffect(() => {
    if (dailyBestBackfillRanRef.current) return
    if (typeof window === 'undefined') return
    dailyBestBackfillRanRef.current = true
    const candidates = new Set<string>(lifetimeStats.dailyDaysCleared)
    // Also pick up any `cubic-daily-best-…` keys lying around in
    // case `dailyDaysCleared` is stale (e.g. archive replay only
    // wrote the per-day key without rebuilding the cleared set).
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i)
        if (key && key.startsWith('cubic-daily-best-')) {
          candidates.add(key.slice('cubic-daily-best-'.length))
        }
      }
    } catch {
      // Ignore; we'll just backfill from dailyDaysCleared.
    }
    const additions: Record<string, number> = {}
    for (const dateKey of candidates) {
      if (lifetimeStats.dailyBestMovesByDate[dateKey] !== undefined) continue
      try {
        const raw = window.localStorage.getItem(`cubic-daily-best-${dateKey}`)
        const parsed = raw ? Number.parseInt(raw, 10) : NaN
        if (Number.isFinite(parsed) && parsed > 0) {
          additions[dateKey] = parsed
        }
      } catch {
        // Skip this day; the next clear will populate it.
      }
    }
    if (Object.keys(additions).length === 0) return
    setLifetimeStats((prev) => {
      const next = {
        ...prev,
        dailyBestMovesByDate: { ...prev.dailyBestMovesByDate, ...additions },
      }
      try {
        saveLifetimeStats(next)
      } catch {
        // Best-effort persistence; in-memory copy still wins for this session.
      }
      return next
    })
  }, [lifetimeStats.dailyDaysCleared, lifetimeStats.dailyBestMovesByDate])
  const syncStatsToAccount = useCallback(
    async (stats: LifetimeStats, accountIdOverride?: string) => {
      const accountId =
        accountIdOverride ?? accountStatsQuery?.userId ?? loadStatsSyncAccountId()
      if (!accountId) return null
      setAccountSyncState('syncing')
      setAccountError(null)
      try {
        const baseline = loadStatsSyncBaseline(accountId)
        // Piece stats follow the same sync model as the lifetime
        // counters: compute (local - per-account baseline), attach
        // to the payload, then save the post-merge totals as the
        // new baseline. Silent — no UI surface, just rides along
        // with every stats sync.
        const pieceStatsDelta = buildPieceStatsDelta(accountId)
        const delta = calculateStatsSyncDelta(
          stats,
          baseline,
          pieceStatsDelta,
        )
        const rawMerged = await mergeAccountStats({ delta })
        // The server validator marks the PvP counters as optional so
        // legacy accountStats rows keep validating during the
        // migration window; on the client we model them as required
        // (default 0) so reads stay simple. Top them up at the
        // boundary so the client type lines up.
        const merged: LifetimeStats = {
          ...rawMerged,
          gamesPlayedPvp: rawMerged.gamesPlayedPvp ?? 0,
          pvpWins: rawMerged.pvpWins ?? 0,
          pvpShames: rawMerged.pvpShames ?? 0,
          bestRubiesInRun: rawMerged.bestRubiesInRun ?? 0,
          dailyBestMovesByDate: rawMerged.dailyBestMovesByDate ?? {},
          pieceStats: rawMerged.pieceStats ?? {},
        }
        saveLifetimeStats(merged)
        saveStatsSyncAccountId(accountId)
        saveStatsSyncBaseline(accountId, merged)
        setStatsSyncLastAt(loadStatsSyncLastAt())
        setLifetimeStats(merged)
        // Piece-stats round-trip: replace the local map with the
        // server-merged totals so cross-device counters stay in
        // sync, and save the same map as the new piece-stats
        // baseline so the next sync only ships brand-new deltas.
        if (merged.pieceStats) {
          setPieceStats(merged.pieceStats)
          savePieceStats(merged.pieceStats)
          savePieceStatsSyncBaseline(accountId, merged.pieceStats)
        }
        // Write through the merged per-day best moves to the
        // `cubic-daily-best-<dateKey>` localStorage cache so any
        // surface that still reads from the per-day key (legacy
        // call sites + the calendar's localStorage fallback for
        // pre-sync days) reflects the cross-device merge too.
        // Only writes when the merged value is strictly better
        // (or new) so we never regress a locally-recorded best.
        if (typeof window !== 'undefined') {
          for (const [dateKey, moves] of Object.entries(
            merged.dailyBestMovesByDate,
          )) {
            try {
              const slot = `cubic-daily-best-${dateKey}`
              const existingRaw = window.localStorage.getItem(slot)
              const existing = existingRaw
                ? Number.parseInt(existingRaw, 10)
                : NaN
              if (!Number.isFinite(existing) || moves < existing) {
                window.localStorage.setItem(slot, String(moves))
              }
            } catch {
              // Best-effort write-through; quota errors are fine.
            }
          }
          // The HUD's "Best" readout derives from
          // lifetimeStats.dailyBestMovesByDate which we just wrote
          // above, so the merged value flows through on the next
          // render without needing a separate state nudge here.
        }
        setAccountSyncState('synced')
        setAccountMessage('Stats synced. This device now shows your combined total.')
        return merged
      } catch (err) {
        setAccountSyncState('idle')
        setAccountError(
          err instanceof Error ? err.message : 'Stats sync did not complete.',
        )
        return null
      }
    },
    [accountStatsQuery?.userId, mergeAccountStats],
  )
  const autoSyncedAccountRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isAuthenticated || !accountStatsQuery?.userId) {
      autoSyncedAccountRef.current = null
      return
    }
    if (autoSyncedAccountRef.current === accountStatsQuery.userId) return
    autoSyncedAccountRef.current = accountStatsQuery.userId
    void syncStatsToAccount(lifetimeStats, accountStatsQuery.userId)
  }, [
    accountStatsQuery?.userId,
    isAuthenticated,
    lifetimeStats,
    syncStatsToAccount,
  ])
  // Which leaderboard tab the High Scores modal is currently showing.
  // The modal used to stack endless + daily (+ co-op when global was
  // on) end-to-end, which made the page get long. Now we render
  // exactly one board at a time and let the player flip between
  // them via a tab strip. The 'coop' tab is only available while
  // the global toggle is on (there is no local co-op store).
  type HighScoreTab = 'endless' | 'daily' | 'coop' | 'pvp'
  const [highScoreTab, setHighScoreTab] = useState<HighScoreTab>('endless')
  // PvP leaderboard secondary sort: by derived rank score (games ×
  // win-rate) or by raw wins. Lives at the App level so the toggle
  // state survives modal close/open.
  const [pvpSortBy, setPvpSortBy] = useState<'rank' | 'wins'>('rank')
  // Within each tab the leaderboard is paginated 10 at a time so the
  // modal height stays predictable even at the daily / endless
  // 100-entry global cap. Page index is per-tab and zero-based; the
  // reset effect that snaps every page back to 0 on context-switch
  // lives further down (near the other high-scores effects), since
  // it reads `showGlobalLeaderboard` / `dailyScoresDateKey` which
  // get declared after this block.
  const [highScorePages, setHighScorePages] = useState<
    Record<HighScoreTab, number>
  >({ endless: 0, daily: 0, coop: 0, pvp: 0 })
  // When on, the high-scores card swaps the local lists for live
  // global queries. Local stays first-class — we never wipe local
  // entries when the toggle flips. Defaults to ON for new players so
  // the global leaderboards (including co-op) are surfaced by default;
  // the player's last explicit choice is persisted under
  // `cubic-show-global-leaderboard` and restored on reload.
  const [showGlobalLeaderboard, setShowGlobalLeaderboard] = useState<boolean>(
    () => {
      if (typeof window === 'undefined') return true
      const raw = window.localStorage.getItem('cubic-show-global-leaderboard')
      if (raw === '0' || raw === 'false') return false
      if (raw === '1' || raw === 'true') return true
      return true
    },
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        'cubic-show-global-leaderboard',
        showGlobalLeaderboard ? '1' : '0',
      )
    } catch {
      // Best-effort; safe to fall through if storage is unavailable.
    }
  }, [showGlobalLeaderboard])
  const [highScores, setHighScores] = useState<HighScoreEntry[]>(() =>
    typeof window === 'undefined' ? [] : loadHighScores(),
  )
  const [pendingHighScore, setPendingHighScore] = useState(false)
  const [pendingScore, setPendingScore] = useState<number | null>(null)
  const [highScoreSaved, setHighScoreSaved] = useState(false)
  const [lastSavedHighScoreDate, setLastSavedHighScoreDate] = useState<
    number | null
  >(null)
  // Pagination state for the gameover modal's leaderboards. Each
  // tab keeps a local page (browsed via prev/next chevrons) and a
  // separate global page so the player can flip between views
  // without losing their place. The snap effects below run only
  // when the gameover modal opens, when a fresh save lands, or
  // when the relevant score query refetches — they deliberately do
  // NOT depend on the entry-list identity so user-driven prev/next
  // clicks aren't clobbered.
  const [gameoverEndlessPage, setGameoverEndlessPage] = useState(0)
  const [gameoverEndlessGlobalPage, setGameoverEndlessGlobalPage] = useState(0)
  const [gameoverDailyGlobalPage, setGameoverDailyGlobalPage] = useState(0)
  const [gameoverCoopGlobalPage, setGameoverCoopGlobalPage] = useState(0)
  // Gameover-modal leaderboards default to a compact top-3 view
  // (with the player's row pinned underneath if they fall outside
  // the top 3). The "Show all" toggle expands to the full paginated
  // leaderboard. The state is shared between endless and daily
  // because only one gameover modal is on screen at a time; it
  // resets on every new run via resetGame / createDailyGameState
  // so the next modal always opens collapsed.
  const [gameoverLeaderboardExpanded, setGameoverLeaderboardExpanded] =
    useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  // Open the menu on load. The first gesture the player makes is
  // dismissing the menu, which gives us a clean moment to prime the
  // audio elements without that priming colliding with gameplay sounds.
  // Skip the auto-open when arriving via a room URL — the player came
  // here to play, not to land on a menu they didn't ask for.
  // Cold load drops the player straight onto the board for whichever
  // mode they last played (or onto the multiplayer room if they're
  // following an invite link). The menu is opened explicitly via the
  // gear button or via the in-game `Esc` shortcut — it is no longer
  // the audio-unlock gateway (see `audio.ts` module-load gesture
  // hooks) and the cold-start "I don't even know what mode I'm in
  // until I dismiss this" friction is gone.
  const [showMenu, setShowMenu] = useState(false)
  // Pause menu's Settings section is collapsed by default — Audio,
  // The pause menu is a two-page bottom sheet: the type-index page
  // (the hot path) and a dedicated Settings page. Always reopens on
  // the index so the player isn't surprised by a settings screen
  // sitting where Resume should be.
  const [menuPage, setMenuPage] = useState<'index' | 'settings'>('index')
  useEffect(() => {
    if (!showMenu) setMenuPage('index')
  }, [showMenu])
  // Esc dismisses the pause menu (in addition to the existing
  // tap-on-backdrop behavior). Mounted only while the menu is open
  // so it doesn't compete with other modals' future Esc handling.
  useEffect(() => {
    if (!showMenu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setShowMenu(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showMenu])
  // "Export recent moves as GIF" modal. Opens from the pause menu.
  // `exportGifCount` is the stepper value (1..available, capped at
  // RUN_HISTORY_EXPORT_MAX). `exportGifProgress` mirrors the
  // single-snapshot exporter's progress reporting so the button
  // can show recording / encoding / done states.
  const [showExportGif, setShowExportGif] = useState(false)
  const [exportGifCount, setExportGifCount] = useState(1)
  const [exportGifProgress, setExportGifProgress] =
    useState<CaptureProgress | null>(null)
  const [volume, setVolumeState] = useState<number>(() => getMasterVolume())
  const [audioMuted, setAudioMutedState] = useState<boolean>(() => getMuted())
  // True iff the player is unmuted AND the AudioContext is missing,
  // stale, or not in 'running' state. The audio module owns the source
  // of truth; we just mirror its boolean here so React can render the
  // "Tap to resume" prompt. The lazy initializer reads the snapshot
  // synchronously so the very first render already has the right
  // value — no flash of "no prompt" before the subscription's first
  // broadcast lands. See `subscribeAudioNeedsUnlock` for the exact
  // condition and the iOS rationale.
  const [audioNeedsUnlock, setAudioNeedsUnlock] = useState<boolean>(() =>
    getAudioNeedsUnlock(),
  )
  useEffect(() => {
    const unsubscribe = subscribeAudioNeedsUnlock(setAudioNeedsUnlock)
    return unsubscribe
  }, [])
  // Touch-device gate for the audio-unlock prompt. Desktop browsers
  // don't have the iOS "no resume from a drag" limitation that makes
  // the prompt necessary — on desktop the first mousedown/click on
  // anything is enough to unlock. Computed once at mount and cached
  // for the session because hot-plugging a touchscreen mid-session is
  // not something we need to support.
  const isTouchDevice = useMemo<boolean>(() => {
    if (typeof window === 'undefined') return false
    if ('ontouchstart' in window) return true
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.maxTouchPoints === 'number' &&
      navigator.maxTouchPoints > 0
    ) {
      return true
    }
    return false
  }, [])
  // Reduced motion has two triggers and we want the toggle UI to
  // reflect reality regardless of which one fired:
  //   1. Explicit in-app preference saved to localStorage. Wins
  //      whenever the user has touched the toggle in this app.
  //   2. OS-level `prefers-reduced-motion: reduce`. Honored on first
  //      visit (and treated as the default if the user hasn't yet
  //      saved an in-app preference) so we don't silently override
  //      a system-wide accessibility setting.
  // The CSS also listens for `@media (prefers-reduced-motion)`
  // independently, so the reduced-motion behavior applies even if
  // this state is somehow out of sync — the JS-side default just
  // keeps the toggle from lying about what the player sees.
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    const stored = window.localStorage.getItem('cubic-reduced-motion')
    if (stored === 'true') return true
    if (stored === 'false') return false
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  })
  // Mirror into the ref the deal-in callbacks read (they're declared
  // above this state and shouldn't re-create on a settings toggle).
  useEffect(() => {
    reducedMotionRef.current = reducedMotion
  }, [reducedMotion])

  // Measure the announce's settle target: the header title's rect. The
  // overlay span's layout box sits at the viewport center untransformed
  // (fixed inset-0 flex), so offset* gives its true size while the
  // keyframes hold it scaled — getBoundingClientRect would lie here.
  // If the theme hides the title entirely (Win98 does), there's nothing
  // to settle into: mark `no-settle` and the announce falls back to the
  // original fade-out.
  useLayoutEffect(() => {
    if (!dealInActive || reducedMotion || announceLanded) return
    const el = announceTextRef.current
    if (!el) return
    const title = document.querySelector<HTMLElement>('.hexaclear-title')
    const rect = title?.getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      el.classList.add('no-settle')
      return
    }
    const ownH = el.offsetHeight
    if (ownH === 0) {
      el.classList.add('no-settle')
      return
    }
    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    el.style.setProperty(
      '--hexaclear-settle-x',
      `${rect.left + rect.width / 2 - cx}px`,
    )
    el.style.setProperty(
      '--hexaclear-settle-y',
      `${rect.top + rect.height / 2 - cy}px`,
    )
    el.style.setProperty('--hexaclear-settle-scale', `${rect.height / ownH}`)
  }, [dealInActive, reducedMotion, announceLanded])

  // Cold-load deal-in: if the session opens onto a pristine board (a
  // brand-new run, or a restored save with zero moves — visually
  // identical), play the choreography once. Mid-run restores skip it,
  // as do tutorial launches (the tutorial stages its own board) and
  // multiplayer (server state arrives async; see plan doc). Audio ticks
  // self-mute here because no gesture has unlocked the context yet.
  useEffect(() => {
    if (tutorialStage > 0) return
    if (isMultiplayer) return
    if (game.moves !== 0 || game.score !== 0 || game.gameOver) return
    startDealIn()
    // Mount-only by design: later pristine states (e.g. New Game) are
    // handled at their own call sites.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Colorblind support: opt-in. When on, the viewport carries an
  // `is-colorblind` class that lets CSS surface extra non-color
  // cues — a glyph on ruby cells, a stronger pattern on invalid
  // drops, and a heavier outline on `preview-clear` cells. We
  // deliberately scope the MVP to cues that don't depend on per-
  // player pattern art (those land in a later round once the
  // pattern set is designed) so the toggle is honest about the
  // accessibility win it delivers today.
  const [colorblindSupport, setColorblindSupport] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return (
      window.localStorage.getItem('cubic-colorblind-support') === 'true'
    )
  })
  // Score-tier color escalation. Pieces (and recently-placed cubes)
  // shift palette at every 1,000-point boundary up to a cap at 4k+,
  // giving the run a visible "levelling up" momentum without ever
  // turning the board into a unreadable mess. Tier 0 is the theme's
  // default look — both Wood and Win98 define cube-color overrides
  // for tiers 1–4 in their respective stylesheets.
  //
  // Daily mode is scored in moves, not points, so the tier is pinned
  // to 0 there. Endless and Big share the same thresholds; Big mode
  // scores faster, which the user accepted as intentional — bigger
  // scores get bigger rewards. Co-op / PvP follow the local player's
  // current score.
  // Score tier is now uncapped — every 1000 points produces a new
  // tier index, and the palette + octave system handles each one
  // procedurally. Daily mode (and any score below 1000) stays at 0
  // so the default amber palette wins there.
  const scoreTier = useMemo<number>(() => {
    if (game.mode === 'daily') return 0
    const t = Math.floor(game.score / 1000)
    return t <= 0 ? 0 : t
  }, [game.score, game.mode])
  // Octave = which "layer milestone" the tier belongs to. See
  // `computeScoreOctave` for the boundary table.
  const scoreOctave = useMemo<number>(
    () => computeScoreOctave(scoreTier),
    [scoreTier],
  )
  const prevScoreTierRef = useRef<number>(scoreTier)
  const prevScoreOctaveRef = useRef<number>(scoreOctave)
  // Token bumped every time the player crosses INTO a higher tier so
  // the HUD-pulse overlay's `key` changes and React remounts the
  // animation. Token doesn't bump on tier drops (mode swaps, resets)
  // because those aren't level-ups — they shouldn't fire a
  // congratulatory pulse.
  const [tierPulseToken, setTierPulseToken] = useState(0)
  // Tier crossings come in two flavors: a "tier-up" (every 1000pts)
  // and a louder "octave-up" (every 5000pts, when a new visual
  // layer also locks in). The pulse element reads this to decide
  // whether to render the standard ring or the bigger / longer
  // octave variant.
  const [tierPulseVariant, setTierPulseVariant] =
    useState<'tier' | 'octave'>('tier')
  // While the radial pulse + HUD grow animation are in flight, the
  // parent live-stat / LCD-score elements get this flag so their
  // inner score readout (`.value` / `.lcd-digits`) plays a coordinated
  // scale-up + drop-shadow glow. The flag auto-clears after the
  // longest animation finishes (the 1700ms expanding ring, or the
  // 2300ms octave variant). Keeping the flag derived from a token +
  // timeout — rather than just mounting the inner animation by
  // key — means we can target the existing inner spans without
  // having to remount them on each tier crossing.
  const [tierPulseActive, setTierPulseActive] = useState(false)
  // Continuity guards: a tier "increase" only deserves a pulse when it
  // was EARNED — score climbing within the same run. Mode switches
  // restore saved games (whose tier can be higher than the one we just
  // left) and new games reset to 0; both move the tier without any
  // scoring, and the refs must resync silently. Without these guards
  // the congratulatory pulse fired on mode-screen swaps and on fresh
  // runs right after a high-scoring game ended.
  const prevPulseScoreRef = useRef<number>(game.score)
  const prevPulseModeRef = useRef<GameMode>(game.mode)
  useEffect(() => {
    const sameRunScoring =
      game.mode === prevPulseModeRef.current &&
      game.score >= prevPulseScoreRef.current
    const tierUp = scoreTier > prevScoreTierRef.current
    const octaveUp = scoreOctave > prevScoreOctaveRef.current
    if (sameRunScoring && (tierUp || octaveUp)) {
      setTierPulseToken((t) => t + 1)
      setTierPulseActive(true)
      // Octave crossings out-rank tier crossings — when both fire
      // on the same step (which happens at tiers 5/10/15/…) we
      // want the louder variant.
      setTierPulseVariant(octaveUp ? 'octave' : 'tier')
    }
    prevScoreTierRef.current = scoreTier
    prevScoreOctaveRef.current = scoreOctave
    prevPulseScoreRef.current = game.score
    prevPulseModeRef.current = game.mode
  }, [scoreTier, scoreOctave, game.score, game.mode])
  useEffect(() => {
    if (!tierPulseActive) return
    // Hold the HUD glow long enough to cover the longer of the two
    // animations: tier ring is 1700ms; octave ring is staggered
    // and tail-extended to ~2300ms. The small slack avoids the
    // HUD snap-back landing on the animation's final frame.
    const duration = tierPulseVariant === 'octave' ? 2400 : 1750
    const id = window.setTimeout(() => setTierPulseActive(false), duration)
    return () => window.clearTimeout(id)
  }, [tierPulseActive, tierPulseToken, tierPulseVariant])
  // Theme engine: which visual theme is active. Wood is the original
  // warm cream/gold treatment; win98 is the Windows 98 / Minesweeper
  // homage. Stored as a flat string so we can add more themes later
  // without a migration. Applied via a [data-theme="..."] attribute on
  // <html>, which all theme overrides scope under in CSS.
  const [theme, setTheme] = useState<ThemeId>(() => {
    if (typeof window === 'undefined') return 'wood'
    const raw = window.localStorage.getItem('cubic-theme')
    return raw === 'win98' ||
      raw === 'audius' ||
      raw === 'glass' ||
      raw === 'mondrian'
      ? raw
      : 'wood'
  })
  // Board cell positions — fully tessellated for every theme (including
  // stained glass). Rosette tracery is painted by per-rosette boundary
  // strokes, not by separating the clusters.
  const boardLayout = boardRender.layout
  // Stained-glass only: the hue rotation applied to every jewel (and the
  // backlight) at the current octave. Threaded into all jewelStyle() calls
  // so the hand, ghost, placed cubes, and lock-in animation all wear the
  // same octave-shifted palette and stay in agreement. Non-glass themes
  // never read it.
  const glassHueShift = theme === 'glass' ? glassOctaveHueShift(scoreOctave) : 0
  const audiusAudioRef = useRef<HTMLAudioElement | null>(null)
  const audiusAudioContextRef = useRef<AudioContext | null>(null)
  const audiusAnalyserRef = useRef<AnalyserNode | null>(null)
  const audiusMediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const audiusOutputGainRef = useRef<GainNode | null>(null)
  const audiusFrequencyDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const audiusCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const audiusCanvasVisualRef = useRef<AudiusStageVisualState>({
    bass: 0,
    mid: 0,
    treble: 0,
    onset: 0,
    intensity: 0,
    breath: 0,
    hue: 188,
    playing: false,
  })
  const audiusEnergyFloorRef = useRef(0)
  const audiusEnergyPeakRef = useRef(64)
  const audiusPulseEnvelopeRef = useRef(0)
  const audiusBassEnvelopeRef = useRef(0)
  const audiusMidEnvelopeRef = useRef(0)
  const audiusTrebleEnvelopeRef = useRef(0)
  const audiusOnsetEnvelopeRef = useRef(0)
  const audiusIntensityEnvelopeRef = useRef(0)
  const audiusBreathPhaseRef = useRef(0)
  const audiusHueRef = useRef(0)
  // Ever-advancing hue angle for the whole-cube-layer filter. Always drifts
  // while playing (constant rotation) and speeds up with the music.
  const audiusCubeHueRef = useRef(0)
  // The board's music-reactive filter hue-rotates the entire cube layer
  // (0–360°), which would also sweep the red "invalid placement" preview
  // through green/blue and make it read as a *valid* drop. This SVG filter
  // counter-rotates by the negative angle on just the invalid-preview
  // elements so their net hue stays the authored danger-red. Driven from the
  // analyser loop (CSS filters on inner SVG nodes are ignored on iOS, so a
  // referenced <filter> is the cross-browser path — same as #audius-clear-invert).
  const audiusInvalidCounterRef = useRef<SVGFEColorMatrixElement | null>(null)
  const audiusLastBeatAtRef = useRef(0)
  const audiusLastVisualFrameAtRef = useRef(0)
  const audiusSilentFrameCountRef = useRef(0)
  const audiusAnalyserWarningShownRef = useRef(false)
  const audiusAlbumResolveTokenRef = useRef(0)
  const audiusFailedStreamIdsRef = useRef<Set<string>>(new Set())
  const [initialAudiusPlaybackSnapshot] = useState(readAudiusPlaybackSnapshot)
  const [audiusTracks, setAudiusTracks] = useState<AudiusTrack[]>(
    () => initialAudiusPlaybackSnapshot?.tracks ?? [],
  )
  const [audiusAlbumQueue, setAudiusAlbumQueue] =
    useState<AudiusAlbumQueue | null>(null)
  const [audiusSelectedTrackId, setAudiusSelectedTrackId] = useState<
    string | null
  >(() => initialAudiusPlaybackSnapshot?.selectedTrackId ?? null)
  const [audiusSearchQuery, setAudiusSearchQuery] = useState(
    () => initialAudiusPlaybackSnapshot?.searchQuery ?? 'lofi',
  )
  const [audiusStatus, setAudiusStatus] = useState<
    'idle' | 'loading' | 'playing' | 'paused' | 'error'
  >('idle')
  const [audiusError, setAudiusError] = useState<string | null>(null)
  const [, setAudiusAnalyserLive] = useState(false)
  const [audiusTitleCardCollapsed, setAudiusTitleCardCollapsed] =
    useState(false)
  const [audiusAutoTitleTrackId, setAudiusAutoTitleTrackId] = useState<
    string | null
  >(null)
  const [audiusRepeatMode, setAudiusRepeatMode] =
    useState<AudiusRepeatMode>('album')
  const [audiusAlbumResolveStatus, setAudiusAlbumResolveStatus] =
    useState<AudiusAlbumResolveStatus>('idle')
  const [showAudiusSearch, setShowAudiusSearch] = useState(false)
  const [showAudiusVolume, setShowAudiusVolume] = useState(false)
  const audiusTrackTitleFrameRef = useRef<HTMLSpanElement | null>(null)
  const audiusTrackTitleTextRef = useRef<HTMLSpanElement | null>(null)
  const [audiusTrackTitleScrollPx, setAudiusTrackTitleScrollPx] = useState(0)
  const [audiusVolume, setAudiusVolume] = useState(() => {
    if (typeof window === 'undefined') return 0.65
    const raw = window.localStorage.getItem('cubic-audius-volume')
    const parsed = raw == null ? Number.NaN : Number(raw)
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0.65
  })
  const [audiusPlaybackPosition, setAudiusPlaybackPosition] = useState(
    () => initialAudiusPlaybackSnapshot?.position ?? 0,
  )
  const [audiusPlaybackDuration, setAudiusPlaybackDuration] = useState(
    () => initialAudiusPlaybackSnapshot?.duration ?? 0,
  )
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      writeAudiusPlaybackSnapshot({
        selectedTrackId: audiusSelectedTrackId,
        searchQuery: audiusSearchQuery,
        tracks: audiusTracks,
        position: audiusPlaybackPosition,
        duration: audiusPlaybackDuration,
        wasPlaying: audiusStatus === 'playing',
        savedAt: Date.now(),
      })
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [
    audiusPlaybackDuration,
    audiusPlaybackPosition,
    audiusSearchQuery,
    audiusSelectedTrackId,
    audiusStatus,
    audiusTracks,
  ])
  const getAudiusPlaybackTracks = useCallback((): AudiusTrack[] => {
    const byId = new Map<string, AudiusTrack>()
    audiusTracks.forEach((track) => byId.set(track.id, track))
    audiusAlbumQueue?.tracks.forEach((track) => {
      if (!byId.has(track.id)) byId.set(track.id, track)
    })
    return [...byId.values()]
  }, [audiusAlbumQueue, audiusTracks])
  const getFallbackAudiusTrack = useCallback(
    (failedTrackId: string): AudiusTrack | null => {
      const tracks = getAudiusPlaybackTracks()
      if (tracks.length <= 1) return null
      const failedIndex = tracks.findIndex((track) => track.id === failedTrackId)
      for (let offset = 1; offset < tracks.length; offset += 1) {
        const index =
          failedIndex >= 0
            ? (failedIndex + offset) % tracks.length
            : offset - 1
        const candidate = tracks[index]
        if (
          candidate &&
          candidate.id !== failedTrackId &&
          !audiusFailedStreamIdsRef.current.has(candidate.id)
        ) {
          return candidate
        }
      }
      return null
    },
    [getAudiusPlaybackTracks],
  )
  const loadAudiusTracks = useCallback(async (query?: string) => {
    audiusAlbumResolveTokenRef.current += 1
    audiusFailedStreamIdsRef.current.clear()
    setAudiusAlbumQueue(null)
    setAudiusAlbumResolveStatus('idle')
    setAudiusStatus((current) => (current === 'playing' ? current : 'loading'))
    setAudiusError(null)
    const trimmed = query?.trim() ?? ''
    try {
      await ensureAudiusApiBase()
      const requests = trimmed
        ? [
            buildAudiusApiUrl('/tracks/search', { query: trimmed, limit: 8 }),
            buildAudiusApiUrl('/tracks/trending', { limit: 8 }),
          ]
        : [buildAudiusApiUrl('/tracks/trending', { limit: 8 })]
      let tracks: AudiusTrack[] = []
      let lastError: Error | null = null
      for (const endpoint of requests) {
        try {
          const res = await fetch(endpoint)
          if (!res.ok) throw new Error(`Audius returned ${res.status}`)
          const json = (await res.json()) as { data?: unknown }
          tracks = normalizeAudiusTracks(json.data)
          if (tracks.length > 0) break
          lastError = new Error('No playable public tracks returned.')
        } catch (error) {
          lastError =
            error instanceof Error
              ? error
              : new Error('Unable to load Audius tracks.')
        }
      }
      if (tracks.length === 0) {
        throw lastError ?? new Error('No playable public tracks returned.')
      }
      setAudiusTracks(tracks)
      setAudiusSelectedTrackId((prev) =>
        prev && tracks.some((track) => track.id === prev) ? prev : tracks[0].id,
      )
      setAudiusStatus((current) => (current === 'playing' ? current : 'idle'))
    } catch (error) {
      setAudiusError(
        error instanceof Error ? error.message : 'Unable to load Audius tracks.',
      )
      setAudiusStatus('error')
    }
  }, [])
  const ensureAudiusAnalyser = useCallback((): AnalyserNode | null => {
    if (audiusAnalyserRef.current) return audiusAnalyserRef.current
    if (typeof window === 'undefined') return null
    const audio = audiusAudioRef.current
    if (!audio) return null
    const Ctor =
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!Ctor) return null
    try {
      audio.crossOrigin = 'anonymous'
      const ctx = new Ctor()
      const source = ctx.createMediaElementSource(audio)
      const analyser = ctx.createAnalyser()
      const outputGain = ctx.createGain()
      analyser.fftSize = 512
      analyser.minDecibels = -90
      analyser.maxDecibels = -5
      // Light temporal smoothing to take the edge off frame-to-frame jitter
      // while staying responsive (0 = raw, 1 = frozen).
      analyser.smoothingTimeConstant = 0.7
      source.connect(analyser)
      analyser.connect(outputGain)
      outputGain.connect(ctx.destination)
      outputGain.gain.value = audiusVolume
      audiusAudioContextRef.current = ctx
      audiusMediaSourceRef.current = source
      audiusAnalyserRef.current = analyser
      audiusOutputGainRef.current = outputGain
      audiusFrequencyDataRef.current = new Uint8Array(analyser.frequencyBinCount)
      return analyser
    } catch {
      return null
    }
  }, [audiusVolume])
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('cubic-audius-volume', String(audiusVolume))
    }
    const gain = audiusOutputGainRef.current
    const ctx = audiusAudioContextRef.current
    if (gain) {
      const now = ctx?.currentTime ?? 0
      gain.gain.setTargetAtTime(audiusVolume, now, 0.025)
    }
  }, [audiusVolume])
  const resolveAudiusAlbumQueueForTrack = useCallback(
    async (trackId: string) => {
      const token = ++audiusAlbumResolveTokenRef.current
      setAudiusAlbumQueue(null)
      setAudiusAlbumResolveStatus('resolving')
      const fetchAudiusData = async (url: string): Promise<unknown> => {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`Audius returned ${res.status}`)
        const json = (await res.json()) as { data?: unknown }
        return json.data
      }
      const clearQueue = () => {
        if (audiusAlbumResolveTokenRef.current === token) {
          setAudiusAlbumQueue(null)
          setAudiusAlbumResolveStatus('resolved')
        }
      }

      try {
        const localTrack = audiusTracks.find((track) => track.id === trackId)
        let track = localTrack
        if (
          !track ||
          !track.userId ||
          track.playlistsContainingTrackIds === undefined
        ) {
          const data = await fetchAudiusData(
            buildAudiusApiUrl(`/tracks/${encodeURIComponent(trackId)}`),
          )
          track = normalizeAudiusTracks([data])[0] ?? localTrack
        }
        const userId = track?.userId ?? track?.user?.id
        if (!track || !userId) {
          clearQueue()
          return
        }

        const collectionUrls = [
          buildAudiusApiUrl(`/users/${encodeURIComponent(userId)}/playlists`, {
            limit: 100,
          }),
          buildAudiusApiUrl(`/users/${encodeURIComponent(userId)}/albums`, {
            limit: 100,
          }),
        ]
        const collectionResults = await Promise.allSettled(
          collectionUrls.map((url) => fetchAudiusData(url)),
        )
        const collections = collectionResults.flatMap((result) =>
          result.status === 'fulfilled'
            ? normalizeAudiusCollections(result.value)
            : [],
        )
        const containingCollections = collections.filter((collection) =>
          collection.trackIds.includes(trackId),
        )
        if (containingCollections.length === 0) {
          clearQueue()
          return
        }

        const playlistIds = track.playlistsContainingTrackIds ?? []
        const albumBacklink = track.albumBacklinkId
        const [collection] = containingCollections.sort((a, b) => {
          const score = (candidate: AudiusCollection): number => {
            let value = 0
            if (candidate.isAlbum) value += 80
            if (candidate.name.toLowerCase().includes('album')) value += 40
            if (
              candidate.playlistId != null &&
              playlistIds.includes(candidate.playlistId)
            ) {
              value += 20
            }
            if (
              albumBacklink != null &&
              (albumBacklink === candidate.id ||
                albumBacklink === candidate.playlistId)
            ) {
              value += 120
            }
            value += Math.min(candidate.trackCount, 40) / 10
            return value
          }
          return score(b) - score(a)
        })
        if (!collection) {
          clearQueue()
          return
        }

        const collectionTracks = normalizeAudiusTracks(
          await fetchAudiusData(
            buildAudiusApiUrl(
              `/playlists/${encodeURIComponent(collection.id)}/tracks`,
            ),
          ),
        )
        if (
          audiusAlbumResolveTokenRef.current !== token ||
          !collectionTracks.some((candidate) => candidate.id === trackId) ||
          collectionTracks.length <= 1
        ) {
          clearQueue()
          return
        }

        setAudiusAlbumQueue({
          id: collection.id,
          name: collection.name,
          tracks: collectionTracks,
        })
        setAudiusAlbumResolveStatus('resolved')
        setAudiusTracks((prev) => {
          const seen = new Set(prev.map((candidate) => candidate.id))
          const additions = collectionTracks.filter(
            (candidate) => !seen.has(candidate.id),
          )
          return additions.length > 0 ? [...prev, ...additions] : prev
        })
      } catch {
        clearQueue()
      }
    },
    [audiusTracks],
  )
  const playAudiusTrack = useCallback(
    async (trackId?: string | null, options: PlayAudiusTrackOptions = {}) => {
      const id = trackId ?? audiusSelectedTrackId ?? audiusTracks[0]?.id
      const audio = audiusAudioRef.current
      if (!id || !audio) return false

      const attemptPlay = async (targetId: string): Promise<boolean> => {
        const resumePosition =
          targetId === audiusSelectedTrackId ? audiusPlaybackPosition : 0
        setAudiusSelectedTrackId(targetId)
        setShowAudiusVolume(false)
        setAudiusError(null)
        setAudiusStatus('loading')
        audiusEnergyFloorRef.current = 0
        audiusEnergyPeakRef.current = 64
        audiusPulseEnvelopeRef.current = 0
        audiusBassEnvelopeRef.current = 0
        audiusMidEnvelopeRef.current = 0
        audiusTrebleEnvelopeRef.current = 0
        audiusOnsetEnvelopeRef.current = 0
        audiusIntensityEnvelopeRef.current = 0
        audiusBreathPhaseRef.current = 0
        audiusHueRef.current = 0
        audiusCubeHueRef.current = 0
        audiusLastBeatAtRef.current = 0
        audiusSilentFrameCountRef.current = 0
        audiusAnalyserWarningShownRef.current = false
        setAudiusAnalyserLive(false)
        setAudiusPlaybackPosition(resumePosition)
        audio.crossOrigin = 'anonymous'
        audio.volume = 1

        const applyResumePosition = () => {
          if (resumePosition <= 1) return
          try {
            const duration = Number.isFinite(audio.duration)
              ? audio.duration
              : resumePosition
            audio.currentTime = Math.min(resumePosition, Math.max(0, duration - 1))
          } catch {
            // Some Audius streams are not seekable until more metadata arrives.
          }
        }

        try {
          await ensureAudiusApiBase()
          audio.src = buildAudiusStreamUrl(targetId)
          audio.addEventListener('loadedmetadata', applyResumePosition, {
            once: true,
          })
          const analyser = ensureAudiusAnalyser()
          if (!analyser) {
            throw new Error('Browser could not create an Audius audio analyser.')
          }
          const ctx = audiusAudioContextRef.current
          if (analyser && ctx && (ctx.state as string) === 'suspended') {
            await ctx.resume()
          }
          await audio.play()
          applyResumePosition()
          audiusFailedStreamIdsRef.current.delete(targetId)
          setAudiusStatus('playing')
          return true
        } catch {
          audio.removeEventListener('loadedmetadata', applyResumePosition)
          audiusFailedStreamIdsRef.current.add(targetId)
          return false
        }
      }

      if (await attemptPlay(id)) {
        if (options.resolveAlbum !== false) {
          void resolveAudiusAlbumQueueForTrack(id)
        }
        return true
      }

      const fallback =
        options.fallbackOnError === false ? null : getFallbackAudiusTrack(id)
      if (fallback && (await attemptPlay(fallback.id))) {
        setAudiusError(null)
        if (options.resolveAlbum !== false) {
          void resolveAudiusAlbumQueueForTrack(fallback.id)
        }
        return true
      }

      setAudiusError('Audius playback failed for this track.')
      setAudiusStatus('error')
      return false
    },
    [
      audiusPlaybackPosition,
      audiusSelectedTrackId,
      audiusTracks,
      ensureAudiusAnalyser,
      getFallbackAudiusTrack,
      resolveAudiusAlbumQueueForTrack,
    ],
  )
  const getAdjacentAudiusTrack = useCallback(
    (direction: 1 | -1): AudiusTrack | null => {
      const queue = audiusAlbumQueue?.tracks ?? []
      if (!audiusSelectedTrackId || queue.length <= 1) return null
      const currentIndex = queue.findIndex(
        (track) => track.id === audiusSelectedTrackId,
      )
      if (currentIndex < 0) return null
      const nextIndex = currentIndex + direction
      if (nextIndex >= 0 && nextIndex < queue.length) {
        return queue[nextIndex] ?? null
      }
      if (audiusRepeatMode !== 'album') return null
      return direction > 0 ? queue[0] ?? null : queue[queue.length - 1] ?? null
    },
    [audiusAlbumQueue, audiusRepeatMode, audiusSelectedTrackId],
  )
  const showAudiusAutoTitle = useCallback(
    (trackId: string) => {
      if (!audiusTitleCardCollapsed) return
      setAudiusAutoTitleTrackId(trackId)
    },
    [audiusTitleCardCollapsed],
  )
  const playAdjacentAudiusTrack = useCallback(
    async (direction: 1 | -1, automatic = false): Promise<boolean> => {
      const track = getAdjacentAudiusTrack(direction)
      if (!track) return false
      const didPlay = await playAudiusTrack(track.id, { resolveAlbum: false })
      if (didPlay && automatic) {
        showAudiusAutoTitle(track.id)
      }
      return didPlay
    },
    [getAdjacentAudiusTrack, playAudiusTrack, showAudiusAutoTitle],
  )
  const playNextAudiusAlbumTrack = useCallback(async () => {
    if (audiusRepeatMode === 'track' && audiusSelectedTrackId) {
      const didPlay = await playAudiusTrack(audiusSelectedTrackId, {
        resolveAlbum: false,
      })
      if (didPlay) return
    }
    if (await playAdjacentAudiusTrack(1, true)) {
      return
    }
    setAudiusStatus('paused')
  }, [
    audiusRepeatMode,
    audiusSelectedTrackId,
    playAdjacentAudiusTrack,
    playAudiusTrack,
  ])
  const toggleAudiusPlayPause = useCallback(async () => {
    if (audiusStatus === 'playing') {
      audiusAudioRef.current?.pause()
      setAudiusStatus('paused')
      return
    }
    await playAudiusTrack()
  }, [audiusStatus, playAudiusTrack])
  const cycleAudiusRepeatMode = useCallback(() => {
    setAudiusRepeatMode((mode) =>
      mode === 'none' ? 'album' : mode === 'album' ? 'track' : 'none',
    )
  }, [])
  useEffect(() => {
    if (!audiusAutoTitleTrackId) return
    const id = window.setTimeout(() => setAudiusAutoTitleTrackId(null), 4200)
    return () => window.clearTimeout(id)
  }, [audiusAutoTitleTrackId])
  const [dailyHighScores, setDailyHighScores] = useState<DailyHighScoreEntry[]>(
    () => (typeof window === 'undefined' ? [] : loadDailyHighScores()),
  )
  const [dailyRunsToken, setDailyRunsToken] = useState(0)
  const [pendingDailyHighScore, setPendingDailyHighScore] = useState(false)
  const [pendingDailyMoves, setPendingDailyMoves] = useState<number | null>(
    null,
  )
  const [dailyHighScoreSaved, setDailyHighScoreSaved] = useState(false)
  const [lastSavedDailyHighScoreDate, setLastSavedDailyHighScoreDate] =
    useState<number | null>(null)
  // The daily gameover modal exits via either "Done" or "Retry".
  // Retry restarts the puzzle, naturally clearing gameOver back to
  // false and remounting the modal stack. Done just dismisses the
  // celebration so the player can sit on the cleared board and
  // navigate from there — same autosave behavior on the way out, but
  // no forced replay. We track that dismissal here so the modal stays
  // closed for *this* completed run; the reset effect below brings it
  // back the next time the player reaches gameover, switches modes,
  // or hops to a different daily date.
  const [dailyGameOverDismissed, setDailyGameOverDismissed] =
    useState<boolean>(false)
  useEffect(() => {
    setDailyGameOverDismissed(false)
  }, [game.gameOver, game.mode, game.dailyDateKey])
  // Transient "Copied!" feedback for the daily share button. We reset
  // it on gameover/mode transitions so a stale flash doesn't carry
  // over into the next puzzle's modal.
  const [dailyShareCopied, setDailyShareCopied] = useState(false)
  useEffect(() => {
    setDailyShareCopied(false)
  }, [game.gameOver, game.mode, game.dailyDateKey])
  // Per-device co-op high scores. Each unique playerIds-group has at
  // most one row (best score wins) so the local view is "all the
  // co-op partnerships I've ever scored with, deduped to each one's
  // best run". The just-finished-game submit pipeline writes here
  // first and only fires the global submit when the new score is
  // also the new local-#1 for its group, mirroring the endless /
  // daily gating.
  const [coopHighScores, setCoopHighScores] = useState<CoopHighScoreEntry[]>(
    () => (typeof window === 'undefined' ? [] : loadCoopHighScores()),
  )
  // Most-recent co-op submission identity, so the gameover screen
  // can highlight the just-finished run inside whichever leaderboard
  // (local-group or global) the player is viewing. Cleared when the
  // player leaves the room or starts a fresh single-player game.
  const [lastCoopSavedGroupKey, setLastCoopSavedGroupKey] = useState<
    string | null
  >(null)
  const [lastCoopSavedScore, setLastCoopSavedScore] = useState<number | null>(
    null,
  )
  // Pre-fill the high-score name field with the last name the
  // player saved under, falling back to a friendly default for
  // first-time players. Combined with the autosave-on-dismiss
  // wiring on the gameover modal, this makes the Save button a
  // confirm shortcut rather than a gate: every qualifying run
  // ends up in the table even if the player just clicks "Play
  // again" without touching the input.
  const [playerName, setPlayerName] = useState(() => {
    if (typeof window === 'undefined') return 'Player'
    return window.localStorage.getItem('cubic-player-name') ?? 'Player'
  })
  const [bestScore, setBestScore] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null
    const stored = window.localStorage.getItem('hexaclear-best-score')
    return stored ? Number(stored) : null
  })
  // Keep the HUD's endless "Best" readout in sync with the account-
  // synced lifetime best. `bestScore` updates live in-run via the
  // placement reducer (so the LCD ticks up as you pass your own
  // personal record), but `lifetimeStats.bestEndlessScore` is the
  // authoritative cross-device best — it's the field that the
  // account sync's merge takes the per-device max of, and it's the
  // field the syncStatsToAccount writeback updates on this device
  // when another device's run was higher. Pulling that max back
  // into `bestScore` (and the `hexaclear-best-score` localStorage
  // mirror it boot-hydrates from) closes the loop so the HUD
  // shows the cross-device record instead of the stale local one
  // after a sync. Daily mode's "Best" already reads through
  // `lifetimeStats.dailyBestMovesByDate` directly, so it's
  // automatic over there.
  useEffect(() => {
    const synced = lifetimeStats.bestEndlessScore
    if (synced <= 0) return
    if (bestScore !== null && synced <= bestScore) return
    setBestScore(synced)
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem('hexaclear-best-score', String(synced))
      } catch {
        // Best-effort mirror; state copy still drives the HUD.
      }
    }
  }, [lifetimeStats.bestEndlessScore, bestScore])
  // Each mode persists into its own localStorage slot so toggling
  // between modes (or refreshing while in a different mode) never
  // throws away the others' in-progress runs. The React state cache is
  // hydrated from those slots on first render.
  const [savedEndlessGame, setSavedEndlessGame] = useState<GameState | null>(
    () => loadGameForMode('endless'),
  )
  const [savedDailyGame, setSavedDailyGame] = useState<GameState | null>(
    () => loadGameForMode('daily'),
  )
  const [savedBigGame, setSavedBigGame] = useState<GameState | null>(
    () => loadGameForMode('big'),
  )
  // Best (lowest) moves the player has recorded for the daily puzzle
  // they are *currently* playing — today OR an archived date. The
  // HUD's "Best" readout uses this so the value always matches the
  // puzzle on screen instead of being pinned to today. `lifetimeStats`
  // is the authoritative source (kept in sync by foldRunIntoLifetime
  // and the boot-time backfill); we fall back to the per-day
  // localStorage entry in case the stats map hasn't been backfilled
  // yet for that day.
  const currentDailyDateKey =
    game.mode === 'daily' ? game.dailyDateKey ?? getTodayKey() : null
  const currentDailyBestMoves = useMemo<number | null>(() => {
    if (!currentDailyDateKey) return null
    const fromStats = lifetimeStats.dailyBestMovesByDate[currentDailyDateKey]
    if (typeof fromStats === 'number' && fromStats > 0) return fromStats
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(
          `cubic-daily-best-${currentDailyDateKey}`,
        )
        if (raw) {
          const n = Number(raw)
          if (Number.isFinite(n) && n > 0) return n
        }
      } catch {
        // Local best lookup is optional; stats query remains the source of truth.
      }
    }
    return null
  }, [currentDailyDateKey, lifetimeStats.dailyBestMovesByDate])
  const [dailyScoresDateKey, setDailyScoresDateKey] = useState<string>(() =>
    getTodayKey(),
  )
  // Live global queries. We only subscribe when the High Scores
  // card is showing AND the global toggle is on — passing 'skip'
  // tears down the subscription otherwise. Daily is hard-pinned to
  // today globally (per product call), regardless of which date
  // the local stepper happens to be sitting on.
  // Live global queries. We subscribe whenever a leaderboard surface
  // is visible (the High Scores card OR the gameover modal) AND the
  // global toggle is on — passing 'skip' tears down the subscription
  // otherwise.
  //
  // Daily date selection:
  //   * High Scores menu — follows the local `dailyScoresDateKey`
  //     stepper. Opens at today (see the reset effect below) but
  //     the player can step backwards through history to inspect
  //     past days' global rankings, same way they already could
  //     for the local list.
  //   * Game-over modal — follows the puzzle the player actually
  //     finished, so replays of an archive day show that day's
  //     leaderboard right next to the moves count they just earned.
  const wantsGlobalSubscription =
    showGlobalLeaderboard && (showHighScores || game.gameOver)
  const globalDailyDateKey =
    game.gameOver && game.mode === 'daily'
      ? game.dailyDateKey ?? getTodayKey()
      : showHighScores
        ? dailyScoresDateKey
        : getTodayKey()
  const globalEndlessScores = useQuery(
    api.leaderboard.getTopEndlessScores,
    wantsGlobalSubscription ? {} : 'skip',
  )
  const globalDailyScores = useQuery(
    api.leaderboard.getTopDailyScoresForDate,
    wantsGlobalSubscription ? { dateKey: globalDailyDateKey } : 'skip',
  )
  const globalCoopScores = useQuery(
    api.leaderboard.getTopCoopScores,
    wantsGlobalSubscription ? {} : 'skip',
  )
  // Global PvP leaderboard. Subscribed only when the High Scores
  // card is open AND the active tab is 'pvp'; the sort flips the
  // server-side ordering. (No 'showGlobalLeaderboard' gate because
  // the PvP leaderboard is global-only — there's no local PvP
  // store.) Reactive, so a fresh win submission re-orders the list
  // in place without a manual refetch.
  const wantsPvpLeaderboard =
    showHighScores && highScoreTab === 'pvp'
  const globalPvpScores = useQuery(
    api.leaderboard.getTopPvpScores,
    wantsPvpLeaderboard ? { sortBy: pvpSortBy } : 'skip',
  )
  // Per-seated-player rank lookup for the in-game SmileyRow chip.
  // Only fires when actively in a PvP match. The lookup batches all
  // seated players in one query so the cost is one round-trip per
  // roster change.
  const pvpSeatedIdsKey = useMemo(() => {
    if (!isMultiplayer || mp.mode !== 'pvp') return null
    return mp.allPlayers
      .map((p) => p.playerId)
      .sort()
      .join('|')
    // We deliberately include selfPlayer so the key changes when our
    // seat reconnects under a different playerId (theoretical).
  }, [isMultiplayer, mp.mode, mp.allPlayers])
  const pvpSeatedRankArgs = useMemo(() => {
    if (!pvpSeatedIdsKey) return null
    return { playerIds: pvpSeatedIdsKey.split('|') }
  }, [pvpSeatedIdsKey])
  const pvpSeatedRanks = useQuery(
    api.leaderboard.getPvpRanksForPlayers,
    pvpSeatedRankArgs ?? 'skip',
  )

  // Build the SmileyRow players (self + partners) with optional
  // PvP rank chips attached. In co-op the chip is omitted entirely
  // by leaving pvpRank undefined; in PvP we attach the rank from
  // the live query (or null while the lookup is loading / for a
  // brand-new player with no row yet).
  const smileyRowSelfPlayer = useMemo<SmileyRowPlayer | null>(() => {
    if (!mp.selfPlayer) return null
    const base: SmileyRowPlayer = {
      playerId: mp.selfPlayer.playerId,
      name: mp.selfPlayer.name,
    }
    if (isMultiplayer && mp.mode === 'pvp') {
      base.pvpRank = pvpSeatedRanks?.[mp.selfPlayer.playerId]?.rank ?? null
    }
    return base
  }, [mp.selfPlayer, isMultiplayer, mp.mode, pvpSeatedRanks])
  const smileyRowOtherPlayers = useMemo<SmileyRowPlayer[]>(() => {
    return mp.otherPlayers.map((p) => {
      const base: SmileyRowPlayer = {
        playerId: p.playerId,
        name: p.name,
      }
      if (isMultiplayer && mp.mode === 'pvp') {
        base.pvpRank = pvpSeatedRanks?.[p.playerId]?.rank ?? null
      }
      return base
    })
  }, [mp.otherPlayers, isMultiplayer, mp.mode, pvpSeatedRanks])
  const [goldenPopupCellIds, setGoldenPopupCellIds] = useState<string[]>([])
  const [goldenPopupToken, setGoldenPopupToken] = useState(0)
  const [dailyHitPulseCells, setDailyHitPulseCells] = useState<string[]>([])
  const [rippleCells, setRippleCells] = useState<string[]>([])
  const [rippleIsClear, setRippleIsClear] = useState(false)
  const [rippleCenter, setRippleCenter] = useState<{ x: number; y: number } | null>(null)
  const [rippleToken, setRippleToken] = useState(0)
  const rippleRadiusRef = useRef(0)
  const rippleMaxRadiusRef = useRef(boardRender.rippleRadius * 2)
  const CLEAR_RIPPLE_DURATION_MS = 900
  const dailyCubesRemaining = useMemo(() => {
    if (game.mode !== 'daily') return 0
    let count = 0
    for (const hits of Object.values(game.dailyHits)) {
      if (hits > 0) count++
    }
    return count
  }, [game.mode, game.dailyHits])

  // Local "your best" list shown in the daily gameover modal.
  // Previously hard-coded to today's runs, which made the list go
  // blank (or worse, show today's data) whenever the player just
  // finished a historical puzzle from the calendar. Now follows the
  // run's actual date: today when the active mode is today's
  // daily, the archive date when replaying a calendar day, falling
  // back to today otherwise so the memo has something stable to
  // key on.
  const todayPlayerDailyRuns = useMemo(() => {
    if (typeof window === 'undefined') return []
    const name = playerName.trim()
    if (!name) return []
    const targetDateKey =
      (game.mode === 'daily' ? game.dailyDateKey : null) ?? getTodayKey()
    const runs = loadDailyRunsForDateKey(targetDateKey)
    return runs
      .filter((r) => r.name === name && r.moves > 0)
      .sort((a, b) => a.moves - b.moves || a.date - b.date)
      .slice(0, 5)
  }, [playerName, dailyRunsToken, game.mode, game.dailyDateKey])
  const [undoStack, setUndoStack] = useState<GameState[]>(() =>
    // The first-launch tutorial swaps in a synthetic board; its undo stack
    // is always empty and the real game's persisted stack would be paired
    // with the wrong board, so skip restoring during the guided opening.
    tutorialStage === 1 ? [] : loadInitialUndoFromStorage(),
  )
  const [undoAnimation, setUndoAnimation] = useState<{
    piece: ActivePiece
    startX: number
    startY: number
    endX: number
    endY: number
    cellIds: string[]
  } | null>(null)
  const [pendingUndoRestoreSlotIndex, setPendingUndoRestoreSlotIndex] = useState<
    number | null
  >(null)
  // True while the undo animation is mid-flight for a piece headed
  // back into the hold pocket. The hold button reads this to hide
  // its rendered piece during the flight so the in-flight ghost is
  // the only visible copy.
  const [pendingUndoRestoreFromHold, setPendingUndoRestoreFromHold] = useState<
    boolean
  >(false)
  // Auto-rescue: when a placement would otherwise end the run with
  // exactly one unplayable piece left in hand and the hold pocket
  // empty, we silently park that piece into hold and deal a new
  // hand (something the player could do themselves by dragging into
  // hold). The animation state flies the rescued piece from its
  // hand slot into the hold pocket so the player can see what
  // happened; the "is-rescue-flash" class on the hold slot pulses
  // red for the same window.
  const [rescueAnimation, setRescueAnimation] = useState<{
    piece: ActivePiece
    startX: number
    startY: number
    endX: number
    endY: number
    // Scale to settle at when the rescue lands — matches the pocket's
    // computeHoldDisplayScale at the time the rescue fires, so the
    // overlay's final frame coincides with the pocket piece's size.
    // Without this the rescue used to crossfade to the much smaller
    // pocket render and read as a hard "snap" at landing.
    endScale: number
  } | null>(null)
  const handButtonRefs = useRef<(HTMLButtonElement | null)[]>([])
  // Live ref for the Hold slot button, used both as a drag drop-target
  // hit-test surface and as the destination for the undo animation
  // when the restored piece originated in the hold buffer rather than
  // a hand slot.
  const holdSlotRef = useRef<HTMLButtonElement | null>(null)
  // Tracks the pixel width of (a) any one hand-piece button and (b)
  // the Hold pocket so we can compute the held-piece preview scale
  // such that the held-piece HEX never renders larger than a hand
  // hex. Both controls use the same 5-hex SVG viewport, so the hex
  // size collapses to container_width / 5; the held piece is scaled
  // by hand_w / hold_w to match (then clamped down for pieces that
  // would otherwise spill outside the pocket).
  const [holdSizing, setHoldSizing] = useState<{
    handSlotPx: number
    holdPocketPx: number
  }>({ handSlotPx: 0, holdPocketPx: 0 })
  const selectedPiece = useMemo<ActivePiece | null>(() => {
    if (!selectedPieceId) return null
    const inHand = game.hand.find((p) => p.id === selectedPieceId)
    if (inHand) return inHand
    if (game.hold && game.hold.id === selectedPieceId) return game.hold
    return null
  }, [game.hand, game.hold, selectedPieceId])

  const rootRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const boardWrapperRef = useRef<HTMLDivElement | null>(null)
  // Live element ref for the × cancel marker that's currently mounted
  // inside the dragging slot. The marker is the single source of
  // truth for both the visual hit-zone affordance and the JS hit-
  // test rect, so they can never drift out of sync.
  const cancelMarkRef = useRef<HTMLSpanElement | null>(null)
  const dragState = useRef<{
    pieceId: string | null
    pointerId: number | null
    pointerType: string | null
  }>({
    pieceId: null,
    pointerId: null,
    pointerType: null,
  })
  // React dev StrictMode can invoke state updater functions twice; we use these
  // refs to ensure we don't schedule merge-time score increments twice.
  const placementActionIdRef = useRef(0)
  const lastScheduledScoreParticleActionIdRef = useRef<number | null>(null)
  const lastScheduledCubeParticleActionIdRef = useRef<number | null>(null)
  // Used to ignore timeouts scheduled by particles from a previous run/mode.
  const scoreParticleGenerationRef = useRef(0)
  // Used to avoid removing the celebrate class too early when celebrations overlap.
  const scoreCelebrateTokenRef = useRef(0)
  // Pending visual offset to the daily "Cubes" counter while -1 particles are
  // still in flight. Each in-flight particle bumps this up by 1 so the HUD
  // readout stays at its pre-placement value until the particle "lands";
  // mergeTimeMs into the flight we decrement and let the counter catch up.
  const [pendingCubesDelta, setPendingCubesDelta] = useState(0)
  // What the "Cubes" HUD readout actually displays. The underlying count
  // drops the moment a numbered cube is fully cleared, but we want the
  // visual to lag behind in-flight -1 particles so it pops as the
  // particle merges into it (mirrors the endless score-counter flow).
  // pendingCubesDelta is always >= 0 outside of flight; clamping at 0
  // is belt-and-braces in case undo / mode-switch races the merge.
  const displayedCubesRemaining = Math.max(
    0,
    dailyCubesRemaining + pendingCubesDelta,
  )
  const [draggingPieceId, setDraggingPieceId] = useState<string | null>(null)
  // Drag affordance flags for the Hold-slot drop targets. Only one is
  // ever non-null/true at a time:
  //   - `holdDropActive`: cursor is over the hold pocket during a
  //     hand-source drag (drop = park/swap into hold).
  //   - `handSwapTargetSlot`: cursor is over hand slot N during a
  //     hold-source drag (drop = pull/swap from hold into slot N).
  const [holdDropActive, setHoldDropActive] = useState(false)
  const [handSwapTargetSlot, setHandSwapTargetSlot] = useState<
    number | null
  >(null)
  const scale = 1
  const [ghost, setGhost] = useState<{
    piece: ActivePiece
    x: number
    y: number
    // Captured from the originating pointer event so the ghost
    // renderer can pick the right anchoring strategy:
    //   * touch  → keep the historical "lifted above the finger"
    //              offset so the player can see the piece despite
    //              their finger covering the board
    //   * mouse  → anchor the piece's (0,0) origin cell exactly at
    //              the cursor so what's shown matches what'll be
    //              placed (desktop users found the offset confusing)
    pointerType: string | null
  } | null>(null)

  const playablePieceIds = useMemo<Set<string>>(() => {
    const playable = new Set<string>()
    // Hand and hold are checked identically — both are valid placement
    // sources, and an unplayable held piece should grey out the same
    // way an unplayable hand piece does.
    const candidates: ActivePiece[] = game.hold
      ? [...game.hand, game.hold]
      : game.hand
    for (const piece of candidates) {
      for (const cell of boardDef.cells) {
        if (canPlacePiece(game.board, piece.shape, cell.id, game.mode)) {
          playable.add(piece.id)
          break
        }
      }
    }
    return playable
  }, [game.board, game.hand, game.hold, game.mode, boardDef])

  useEffect(() => {
    if (holdHintSeenRef.current) return
    if (tutorialStage === 0) return
    if (isMultiplayer) return
    if (game.gameOver) return
    if (game.mode !== 'endless') return
    if (game.hold !== null) return
    const hasAwkwardPiece = game.hand.some((p) => !playablePieceIds.has(p.id))
    if (!hasAwkwardPiece) return
    showFtueHint(
      'hold',
      "Pieces can be moved into Hold instead of played on the board if you don't want to or can't play them right now.",
      FTUE_HOLD_HINT_KEY,
      holdHintSeenRef,
    )
  }, [
    game.gameOver,
    game.hand,
    game.hold,
    game.mode,
    isMultiplayer,
    playablePieceIds,
    showFtueHint,
    tutorialStage,
  ])

  // Co-op only: when one player is stuck (no valid moves) but the
  // other still has options, both players see a small status label
  // above the hand so the stuck player knows they're waiting on the
  // partner and the moving player knows the partner is benched. The
  // label always names the *other* player from the perspective of
  // whoever's looking at the screen.
  //
  // We deliberately suppress this in the gameover state — once both
  // players are out of moves the gameover modal takes over the
  // narrative and a "no valid moves" label would be redundant.
  const mpMoveStatus = useMemo<
    | { kind: 'self-stuck' | 'partner-stuck'; message: string }
    | null
  >(() => {
    if (!isMultiplayer) return null
    if (!mp.selfPlayer || mp.otherPlayers.length === 0) return null
    if (game.gameOver) return null
    const selfCanMove = hasAnyValidMove(
      game.board,
      mp.selfPlayer.hand,
      game.mode,
      mp.selfPlayer.hold,
    )
    // Other-side "stuck" detection across all non-self seats. We
    // treat the room as "partner can move" if ANY other player has
    // a valid move, and partition the message accordingly. With >2
    // seats we name up to two stuck partners and switch to a count
    // string after that to keep the banner from wrapping.
    const stuckOthers: typeof mp.otherPlayers = []
    let anyOtherCanMove = false
    for (const op of mp.otherPlayers) {
      if (hasAnyValidMove(game.board, op.hand, game.mode, op.hold)) {
        anyOtherCanMove = true
      } else {
        stuckOthers.push(op)
      }
    }
    const formatNames = (xs: typeof mp.otherPlayers): string => {
      if (xs.length === 0) return ''
      if (xs.length === 1) return xs[0].name
      if (xs.length === 2) return `${xs[0].name} & ${xs[1].name}`
      return `${xs.length} other players`
    }
    if (!selfCanMove && anyOtherCanMove) {
      const movers = mp.otherPlayers.filter(
        (p) => !stuckOthers.some((s) => s.playerId === p.playerId),
      )
      return {
        kind: 'self-stuck',
        message: `${formatNames(movers)} still ${
          movers.length === 1 ? 'has' : 'have'
        } valid moves`,
      }
    }
    if (selfCanMove && !anyOtherCanMove) {
      return {
        kind: 'partner-stuck',
        message: `${formatNames(stuckOthers)} ${
          stuckOthers.length === 1 ? 'has' : 'have'
        } no valid moves`,
      }
    }
    return null
  }, [
    isMultiplayer,
    mp.selfPlayer,
    mp.otherPlayers,
    game.board,
    game.mode,
    game.gameOver,
  ])

  const findClosestCellIdFromClientPoint = (clientX: number, clientY: number): string | null => {
    const svg = svgRef.current
    if (!svg) return null
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const local = pt.matrixTransform(ctm.inverse())

    let bestId: string | null = null
    let bestDistSq = Infinity
    for (const cell of boardDef.cells) {
      const pos = boardLayout.positions[cell.id]
      // Guard against stale closure mismatch between boardDef and boardLayout
      // — if we somehow get a cell id without a layout entry, just skip it
      // rather than crashing the whole render tree.
      if (!pos) continue
      const cx = pos.x + boardLayout.offsetX
      const cy = pos.y + boardLayout.offsetY
      const dx = local.x - cx
      const dy = local.y - cy
      const distSq = dx * dx + dy * dy
      if (distSq < bestDistSq) {
        bestDistSq = distSq
        bestId = cell.id
      }
    }
    return bestId
  }

  // ---- Multiplayer auto-join + state mirror ---------------------------
  //
  // When the URL has ?room=ABCD we kick off a single joinRoom call. The
  // ref guard avoids re-firing the mutation on every render once we know
  // we've tried (success or hard error). Reconnects still land on the
  // same slot via the playerId match in the convex mutation.
  useEffect(() => {
    if (!mpRoomCode) return
    if (mp.status === 'connecting') return
    if (mp.status === 'not-found') {
      setMpError('Room not found')
      return
    }
    // Already attached (seated OR spectating) — no further joinRoom
    // calls. Spectators specifically: if we re-fired the mutation
    // every render the late-PvP gate would just keep re-stamping
    // their spectator row and bumping updatedAt.
    if (mp.selfPlayer) return
    if (mp.isSpectator) return
    if (joinAttemptRef.current.code === mpRoomCode && joinAttemptRef.current.attempted) {
      return
    }
    joinAttemptRef.current = { code: mpRoomCode, attempted: true }
    setMpError(null)
    joinRoomMutation({
      code: mpRoomCode,
      playerId,
      name: mpPlayerName,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Could not join room'
      setMpError(msg)
    })
  }, [
    mpRoomCode,
    mp.status,
    mp.selfPlayer,
    mp.isSpectator,
    joinRoomMutation,
    playerId,
    mpPlayerName,
  ])

  // Mirror the live room snapshot into the local game state so the
  // existing render tree (board, hand, score, etc.) shows the shared
  // state without any deeper rewrite. Only runs while a room is active.
  useEffect(() => {
    if (!isMultiplayer) return
    if (!mp.game) return
    setGame(mp.game)
  }, [isMultiplayer, mp.game])

  // Per-placement animation pipeline for MP mode. Reuses the same VFX
  // setters single-player drives inline from setGame; here we listen for
  // a fresh `lastPlacement.token` from the room snapshot and recreate
  // the animation set from the server-provided fields. We don't try to
  // perfectly recreate every detail (e.g. score-particle lives in the
  // single-player flow); just the load-bearing feel beats: placement
  // pop, ripple, clearing cells, ruby bursts, board-clear flourish,
  // shake, and clear SFX.
  const lastSeenMpTokenRef = useRef<number>(0)
  const prevMpHandLenRef = useRef<number>(0)
  useEffect(() => {
    if (!isMultiplayer) return
    if (!mp.game) return
    const placement = mp.lastPlacement
    if (!placement) return
    if (placement.token === lastSeenMpTokenRef.current) return
    lastSeenMpTokenRef.current = placement.token

    // Per-run stats: only bump when *we* are the player who landed
    // this placement. In a co-op room your partner's placements
    // don't count toward your "pieces placed", "rubies cleared",
    // etc. — the room's shared score is already reflected on the
    // gameover modal separately.
    if (placement.byPlayerId === playerId) {
      setRunStats((prev) =>
        applyPlacementToRunStats(prev, {
          piecePlacedCellsCount: placement.placedCellIds.length,
          patternsClearedCount: placement.clearedPatternIds.length,
          rubiesCleared: placement.rubiesCleared,
          boardCleared: placement.boardCleared,
          pointsGained: placement.pointsGained,
          streakAfter: placement.streakAfter,
        }),
      )

      // Highlight reel snapshot. PvP runs don't get reels (the
      // "best moment" framing only really lands in a personal-best
      // context); co-op uses the same monotonic-max rule as
      // single-player. We rebuild the pre-placement board by
      // undoing the placement against the post-placement board the
      // server just shipped us: cleared cells were filled before,
      // placed cells were empty before.
      const isCoop = mp.mode === 'coop'
      if (
        isCoop &&
        placement.pointsGained >= HIGHLIGHT_REEL_MIN_POINTS &&
        placement.clearedPatternIds.length > 0 &&
        (runHighlightRef.current === null ||
          placement.pointsGained > runHighlightRef.current.pointsGained)
      ) {
        const reconstructedBoardBefore: BoardState = { ...mp.game.board }
        for (const cellId of placement.placedCellIds) {
          reconstructedBoardBefore[cellId] = 'empty'
        }
        for (const cellId of placement.clearedCellIds) {
          reconstructedBoardBefore[cellId] = 'filled'
        }
        const patternsById = new Map(
          boardDef.patterns.map((p) => [p.id, p] as const),
        )
        const reconstructedPatterns = placement.clearedPatternIds
          .map((id) => patternsById.get(id))
          .filter((p): p is NonNullable<typeof p> => p != null)
        runHighlightRef.current = createHighlightSnapshot({
          mode: mp.game.mode,
          boardBefore: reconstructedBoardBefore,
          placedCellIds: placement.placedCellIds,
          clearedCellIds: placement.clearedCellIds,
          clearedPatterns: reconstructedPatterns,
          pointsGained: placement.pointsGained,
          causedBoardClear: placement.boardCleared,
        })
      }

      // Per-piece-variant stats for our own MP placements.
      // Partner placements never appear in our hand, so we
      // intentionally only track our own. Variant is resolved
      // from the rotated cells the server shipped back.
      const placedVariant = findPieceVariant(placement.pieceShape.cells)
      if (placedVariant) {
        setPieceStats((prev) =>
          applyPlacementToPieceStats(prev, {
            variantId: placedVariant.id,
            pointsGained: placement.pointsGained,
            patternsClearedCount: placement.clearedPatternIds.length,
            rubiesCleared: placement.rubiesCleared,
            boardCleared: placement.boardCleared,
          }),
        )
      }
    }

    const placedSet = new Set(placement.placedCellIds)
    const clearedSet =
      placement.clearedCellIds.length > 0
        ? new Set(placement.clearedCellIds)
        : null
    const nonClearingPlacedIds =
      clearedSet === null
        ? placement.placedCellIds
        : placement.placedCellIds.filter((id) => !clearedSet.has(id))

    // Hide rubies that just respawned onto cleared cells until the
    // clear animation finishes (otherwise the new ruby flashes as a
    // normal cube during the dissolve).
    if (placement.rubiesCleared > 0) {
      const previousRubySet = new Set(placement.prevGoldenCellIds)
      const newSpawns = placement.newGoldenCellIds.filter(
        (id) =>
          !previousRubySet.has(id) &&
          !placedSet.has(id),
      )
      setPendingGoldenSpawnCellIds(newSpawns)
    } else {
      setPendingGoldenSpawnCellIds([])
    }

    setRecentlyPlacedCells(nonClearingPlacedIds)

    const causedClear = placement.clearedPatternIds.length > 0
    setRippleIsClear(causedClear)
    setRippleCells(placement.placedCellIds)

    const rippleFootprint =
      nonClearingPlacedIds.length > 0
        ? nonClearingPlacedIds
        : placement.placedCellIds

    if (rippleFootprint.length > 0) {
      let sumX = 0
      let sumY = 0
      let count = 0
      for (const id of rippleFootprint) {
        const pos = boardLayout.positions[id]
        if (!pos) continue
        sumX += pos.x + boardLayout.offsetX
        sumY += pos.y + boardLayout.offsetY
        count++
      }
      if (count > 0) {
        const cx = sumX / count
        const cy = sumY / count
        setRippleCenter({ x: cx, y: cy })
        setRippleToken((t) => t + 1)
        rippleRadiusRef.current = 0
        let maxDistSq = 0
        for (const cell of boardDef.cells) {
          const pos = boardLayout.positions[cell.id]
          if (!pos) continue
          const x = pos.x + boardLayout.offsetX
          const y = pos.y + boardLayout.offsetY
          const dx = x - cx
          const dy = y - cy
          const distSq = dx * dx + dy * dy
          if (distSq > maxDistSq) {
            maxDistSq = distSq
          }
        }
        const margin = HEX_SIZE * 1.4
        rippleMaxRadiusRef.current = Math.sqrt(maxDistSq) + margin
      }
    }

    if (causedClear) {
      // Build per-cell clearing classes by looking up patterns on the
      // board definition. The server only sent us pattern ids; here we
      // rehydrate the type/order info needed to drive the line vs
      // flower clearing styles.
      const patternsById = new Map(
        boardDef.patterns.map((p) => [p.id, p] as const),
      )
      const nextClearingClasses: Record<string, string[]> = {}
      for (const id of placement.clearedPatternIds) {
        const pattern = patternsById.get(id)
        if (!pattern) continue
        if (pattern.type === 'line') {
          pattern.cellIds.forEach((cellId, idx) => {
            const classes = (nextClearingClasses[cellId] ||= [])
            classes.push('clearing-line', `clearing-line-step-${idx}`)
          })
        } else if (pattern.type === 'flower') {
          const centerIdForPattern = pattern.cellIds[0] ?? null
          for (const cellId of pattern.cellIds) {
            const role =
              centerIdForPattern && cellId === centerIdForPattern
                ? 'clearing-flower-center'
                : 'clearing-flower-ring'
            ;(nextClearingClasses[cellId] ||= []).push(role)
          }
        }
      }
      setClearingClassesByCell(nextClearingClasses)
      setClearingCells(placement.clearedCellIds)
      setClearingGoldenCellIds(placement.prevGoldenCellIds)
    }

    // Clear SFX + haptics + screenshake + hitstop, all derived from the
    // server-reported streak and combo (clearedCount).
    const clearCount = placement.clearedPatternIds.length
    if (clearCount > 0 && !mp.game.gameOver) {
      playClearForStreakIndex(placement.streakAfter, clearCount)
      if (placement.rubiesCleared > 0) {
        playBreakAfterClear(80)
      }
    }
    triggerHaptics(clearCount > 0)

    if (clearCount > 0) {
      let intensity = Math.min(
        6,
        clearCount + Math.min((placement.streakAfter - 1) * 0.5, 3),
      )
      if (placement.boardCleared) intensity = Math.max(intensity, 9)
      setShakeRequest((prev) => ({ token: prev.token + 1, intensity }))

      const bigClear =
        clearCount >= 2 ||
        placement.streakAfter >= 3 ||
        placement.boardCleared
      if (bigClear) setHitstop(true)
    }

    if (placement.boardCleared) {
      setBoardClearFlashToken((t) => t + 1)
    }

    // Ruby capture pop + radial burst per cleared ruby.
    if (placement.rubiesCleared > 0) {
      const newPopupIds: string[] = placement.prevGoldenCellIds.filter(
        (id) => clearedSet?.has(id),
      )
      if (newPopupIds.length > 0) {
        setGoldenPopupCellIds(newPopupIds)
        setGoldenPopupToken((t) => t + 1)
        const newBursts: Array<{ token: number; x: number; y: number }> = []
        let nextToken = Date.now()
        for (const rubyId of newPopupIds) {
          const rubyPos = boardLayout.positions[rubyId]
          if (rubyPos) {
            newBursts.push({
              token: nextToken++,
              x: rubyPos.x + boardLayout.offsetX,
              y: rubyPos.y + boardLayout.offsetY,
            })
          }
        }
        if (newBursts.length > 0) {
          setRubyBursts((prev) => [...prev, ...newBursts])
        }
      }
    }

    // If this placement was ours and used our last hand piece, the
    // server has already dealt a fresh 3-piece hand; trigger the deal
    // animation so the new pieces fly in just like single-player.
    const myHandLen = mp.game.hand.length
    if (myHandLen === 3 && prevMpHandLenRef.current === 0) {
      setHandFlyInToken((t) => t + 1)
    }
    prevMpHandLenRef.current = myHandLen
  }, [isMultiplayer, mp.lastPlacement, mp.game, boardDef, boardLayout])

  // While in MP mode, wipe transient single-player UI state (selection,
  // ghost, drag) so leftovers from a local run don't flicker on screen.
  useEffect(() => {
    if (!isMultiplayer) return
    setSelectedPieceId(null)
    setHover(null)
    setGhost(null)
    setDraggingPieceId(null)
    setHoldDropActive(false)
    setHandSwapTargetSlot(null)
    dragState.current = {
      pieceId: null,
      pointerId: null,
      pointerType: null,
    }
  }, [isMultiplayer])

  // Backgrounding the tab mid-drag used to be impossible to reach
  // because the pause menu intercepted everything on refocus. With the
  // menu no longer auto-opening on visibilitychange, a held piece would
  // stay "in hand" across the backgrounded window and the user's first
  // tap on return could resolve into a drop they never intended. Drop
  // any in-flight drag the moment the tab is hidden — the piece pops
  // safely back into its hand slot and the user lands on a clean state
  // when they come back.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onHidden = () => {
      if (document.visibilityState !== 'hidden') return
      // No-op when nothing is held — these setters bail if their next
      // value matches the current one, so the cost is essentially zero.
      setSelectedPieceId(null)
      setHover(null)
      setGhost(null)
      setDraggingPieceId(null)
      setHoldDropActive(false)
      setHandSwapTargetSlot(null)
      dragState.current = {
        pieceId: null,
        pointerId: null,
        pointerType: null,
      }
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [])

  // Park / swap / pull a piece between the player's hand and the
  // single-slot hold buffer. Source is resolved by piece id (hand or
  // hold); target is either the hold slot or a specific hand slot
  // index. Mirrors the four cases described in the convex
  // `holdSwap` mutation, with one extra wrinkle: in multiplayer we
  // round-trip through the server so the room row is authoritative;
  // in single-player we mutate local state directly.
  //
  // Hold swaps are NOT pushed onto the undo stack — per the design
  // discussion, only board placements are undoable. The undo stack
  // does include hold-source placements (their pre-state snapshot
  // captures `hold`, so restoring sends the piece back to hold).
  const handleHoldSwap = (
    sourcePieceId: string,
    target:
      | { kind: 'hold' }
      | { kind: 'hand'; slotIndex: number },
  ) => {
    if (isMultiplayer) {
      mp.holdSwap(sourcePieceId, target).catch(() => {
        setFailedPlacementPieceId(sourcePieceId)
        playError()
      })
      return
    }

    // Parking the final hand piece into an empty hold triggers a fresh
    // hand deal inside the reducer below, identical to playing the
    // third piece. Hand-close-outs also close out the per-hand undo
    // window, so clear it here before the swap commits — pressing Undo
    // across that boundary would land on a hand the player can't get
    // back to by gameplay (the freshly-dealt one would already have
    // replaced it).
    const swapWillDealNewHand =
      target.kind === 'hold' &&
      game.hold == null &&
      game.hand.length === 1 &&
      game.hand.some((p) => p.id === sourcePieceId)
    if (swapWillDealNewHand) {
      setUndoStack([])
    }

    setGame((current) => {
      if (current.gameOver) return current
      const inHand = current.hand.find((p) => p.id === sourcePieceId)
      const fromHold =
        current.hold != null && current.hold.id === sourcePieceId
          ? current.hold
          : null
      if (!inHand && !fromHold) return current
      dismissActionFtueHint()

      let newHand: ActivePiece[] = current.hand
      let newHandSlots: (string | null)[] = current.handSlots
      let newHold: ActivePiece | null = current.hold

      if (inHand) {
        if (target.kind !== 'hold') return current
        const sourceSlotIndex = current.handSlots.findIndex(
          (id) => id === inHand.id,
        )
        if (sourceSlotIndex < 0) return current
        newHand = current.hand.filter((p) => p.id !== inHand.id)
        if (current.hold) {
          newHand = [...newHand, current.hold]
          newHandSlots = current.handSlots.map((id, i) =>
            i === sourceSlotIndex ? current.hold!.id : id,
          )
        } else {
          newHandSlots = current.handSlots.map((id, i) =>
            i === sourceSlotIndex ? null : id,
          )
        }
        newHold = inHand
      } else if (fromHold) {
        if (target.kind !== 'hand') return current
        const idx = target.slotIndex
        if (idx < 0 || idx >= current.handSlots.length) return current
        const existingId = current.handSlots[idx]
        const existing = existingId
          ? current.hand.find((p) => p.id === existingId) ?? null
          : null
        if (existing) {
          newHand = current.hand.filter((p) => p.id !== existing.id)
          newHand = [...newHand, fromHold]
          newHandSlots = current.handSlots.map((id, i) =>
            i === idx ? fromHold.id : id,
          )
          newHold = existing
        } else {
          newHand = [...current.hand, fromHold]
          newHandSlots = current.handSlots.map((id, i) =>
            i === idx ? fromHold.id : id,
          )
          newHold = null
        }
      }

      // Re-deal the hand if the swap emptied it (e.g. the player
      // parked their final hand piece into an empty hold). Same rule
      // as a normal placement that consumed the last hand piece.
      let nextHandDealCount = current.dailyHandDealCount
      if (newHand.length === 0) {
        if (current.mode === 'daily' && current.dailySeed != null) {
          nextHandDealCount = (current.dailyHandDealCount ?? 0) + 1
          newHand = dealDailyHand(
            current.board,
            current.dailySeed,
            nextHandDealCount,
          )
        } else {
          newHand = dealPlayableHand(
            current.board,
            undefined,
            undefined,
            current.mode,
          )
        }
        newHandSlots = newHand.map((p) => p.id)
        setHandFlyInToken((t) => t + 1)
      }

      // Recompute game-over with the new hand AND new hold so the
      // run can survive on the strength of a single playable piece
      // regardless of where it lives.
      const noMovesLeft = !hasAnyValidMove(
        current.board,
        newHand,
        current.mode,
        newHold,
      )
      const gameOver = current.mode === 'daily'
        ? current.dailyCompleted || noMovesLeft
        : noMovesLeft

      return {
        ...current,
        hand: newHand,
        handSlots: newHandSlots,
        hold: newHold,
        dailyHandDealCount: nextHandDealCount,
        gameOver,
      }
    })

    // Hold swaps end the click-to-select state and any in-flight
    // hover so a subsequent gesture starts clean.
    setSelectedPieceId(null)
    setHover(null)
  }

  const placePieceAtCell = (
    pieceId: string,
    cellId: string,
    attemptedCellIds?: string[],
  ) => {
    if (isMultiplayer) {
      // In MP the server is authoritative. Optimistically clear local
      // ghost / selection so the piece doesn't appear stuck while we
      // wait for the room snapshot, and surface a shake on rejection.
      setSelectedPieceId(null)
      setHover(null)
      setGhost(null)
      // Snapshot the local hand right now so we can map the rescued
      // piece's id back to its DOM slot button even after the server
      // confirms the rescue and the room state has already shifted
      // to the freshly-dealt hand.
      const handBeforePlacement = mp.selfPlayer?.handSlots ?? null
      mp.placePiece(pieceId, cellId)
        .then((result) => {
          if (!result || !result.autoRescuedPieceId) return
          // Server says we just auto-rescued this player. Find the
          // rescued piece's source slot (preferring the server's
          // slot index, falling back to the snapshotted hand), then
          // play the same flight + flash animation as single player.
          const sourceSlot =
            result.autoRescuedSlotIndex ??
            (handBeforePlacement
              ? handBeforePlacement.indexOf(result.autoRescuedPieceId)
              : -1)
          const rescuedShape = mp.selfPlayer?.hold?.shape ?? null
          const sourceBtn =
            sourceSlot >= 0 ? handButtonRefs.current[sourceSlot] : null
          const holdBtn = holdSlotRef.current
          const wrapper = boardWrapperRef.current
          if (rescuedShape && sourceBtn && holdBtn && wrapper) {
            const wrapperRect = wrapper.getBoundingClientRect()
            const srcRect = sourceBtn.getBoundingClientRect()
            const dstRect = holdBtn.getBoundingClientRect()
            setRescueAnimation({
              piece: {
                id: result.autoRescuedPieceId,
                shape: rescuedShape,
              },
              startX:
                (srcRect.left + srcRect.width / 2 - wrapperRect.left) /
                scale,
              startY:
                (srcRect.top + srcRect.height / 2 - wrapperRect.top) / scale,
              endX:
                (dstRect.left + dstRect.width / 2 - wrapperRect.left) /
                scale,
              endY:
                (dstRect.top + dstRect.height / 2 - wrapperRect.top) / scale,
              endScale: computeHoldDisplayScale(
                rescuedShape.cells,
                holdSizing.handSlotPx,
                holdSizing.holdPocketPx,
              ),
            })
            // Matches the 1200ms hexaclear-rescue-fly + flash keyframes
            // in index.css. Slightly long on purpose: an auto-rescue
            // is a rare "you almost died" moment, so the save should
            // read as deliberate rather than zipping by in a flash.
            setTimeout(() => setRescueAnimation(null), 1200)
          }
          playError()
          triggerHaptics(true)
        })
        .catch(() => {
          setFailedPlacementPieceId(pieceId)
          setInvalidDropCellIds(
            attemptedCellIds && attemptedCellIds.length > 0
              ? attemptedCellIds
              : [cellId],
          )
          playError()
        })
      return
    }

    const actionId = (placementActionIdRef.current += 1)
    setGame((current) => {
      if (current.gameOver) return current
      // Pieces can come from the hand or from the single-slot hold
      // buffer. The bulk of the placement pipeline is identical for
      // both — only the post-placement bookkeeping differs (a hand
      // piece vacates a hand slot, a hold piece empties the hold).
      const inHand = current.hand.find((p) => p.id === pieceId)
      const playFromHold =
        !inHand && current.hold != null && current.hold.id === pieceId
      const piece = inHand ?? (playFromHold ? current.hold! : null)
      if (!piece) return current

      const activeTutorialStage = tutorialStageRef.current
      if (activeTutorialStage !== 0) {
        const requiredCellId =
          activeTutorialStage === 1
            ? TUTORIAL_STAGE_1_TARGET_CELL_IDS[0]
            : TUTORIAL_STAGE_2_TARGET_CELL_IDS[0]
        if (cellId !== requiredCellId) {
          setFailedPlacementPieceId(pieceId)
          setInvalidDropCellIds(
            attemptedCellIds && attemptedCellIds.length > 0
              ? attemptedCellIds
              : [cellId],
          )
          playError()
          return current
        }
      }

      const before = current
      const result = applyPlacement(current, piece, cellId)
      if (!result) {
        setFailedPlacementPieceId(pieceId)
        // When placement fails, highlight the whole attempted footprint
        // if the caller provided it; otherwise fall back to the origin cell.
        setInvalidDropCellIds(
          attemptedCellIds && attemptedCellIds.length > 0
            ? attemptedCellIds
            : [cellId],
        )
        playError()
        return current
      }
      dismissActionFtueHint()

      // Glass theme: record the jewel color each landed cell takes, mapping
      // the piece's per-cube colors (deterministic from piece id + cube
      // index, same as the hand preview) onto the board cells it fills. The
      // target cell for cube i is the piece origin + the cube's relative
      // axial offset — exactly the mapping getBestPlacementPreview uses.
      if (theme === 'glass' || theme === 'mondrian') {
        const placedBoardDef = getBoardDefinitionForMode(current.mode)
        const originCell = placedBoardDef.cells.find((c) => c.id === cellId)
        if (originCell) {
          const colorUpdates: Record<string, number> = {}
          piece.shape.cells.forEach((rel, i) => {
            const targetId = axialToId({
              q: originCell.coord.q + rel.q,
              r: originCell.coord.r + rel.r,
            })
            colorUpdates[targetId] = jewelIndexForPieceCube(piece.id, i)
          })
          setGlassCellColors((prev) => ({ ...prev, ...colorUpdates }))
        }
      }

      // Remember this placement's cells — if it turns out to be the
      // killing piece, the game-over collapse wave radiates from here.
      lastPlacementCellIdsRef.current = result.placedCellIds

      // Identify rubies that respawned onto previously-empty cells in
      // this placement so we can hide each one until the clear animation
      // finishes (otherwise the new ruby flashes as a normal cube). On
      // big-board moves multiple rubies can respawn in the same step.
      if (result.rubiesCleared > 0) {
        const previousRubySet = new Set(current.goldenCellIds)
        const placedSet = new Set(result.placedCellIds)
        const newSpawns = result.goldenCellIds.filter(
          (id) =>
            !previousRubySet.has(id) &&
            before.board[id] === 'empty' &&
            !placedSet.has(id),
        )
        setPendingGoldenSpawnCellIds(newSpawns)
      } else {
        setPendingGoldenSpawnCellIds([])
      }

      // For VFX, only run the placement "pop" on the portion of the piece
      // that is NOT participating in a clear. Any cells that are part of a
      // clear should only show the clear animation, never the placement
      // animation. The board ripple, however, should always originate from
      // the full placed footprint.
      const clearedSet =
        result.clearedCellIds.length > 0
          ? new Set(result.clearedCellIds)
          : null
      const nonClearingPlacedIds =
        clearedSet === null
          ? result.placedCellIds
          : result.placedCellIds.filter((id) => !clearedSet.has(id))

      setRecentlyPlacedCells(nonClearingPlacedIds)

      // Mark whether this placement caused a clear so we can choose between
      // different ripple styling, and compute the ripple's origin as the
      // centroid of the *visible* placed footprint in board coordinates.
      const causedClear = result.clearedPatterns.length > 0
      setRippleIsClear(causedClear)
      setRippleCells(result.placedCellIds)

      const rippleFootprint =
        nonClearingPlacedIds.length > 0
          ? nonClearingPlacedIds
          : result.placedCellIds

      if (rippleFootprint.length > 0) {
        let sumX = 0
        let sumY = 0
        for (const id of rippleFootprint) {
          const pos = boardLayout.positions[id]
          sumX += pos.x + boardLayout.offsetX
          sumY += pos.y + boardLayout.offsetY
        }
        const cx = sumX / rippleFootprint.length
        const cy = sumY / rippleFootprint.length
        setRippleCenter({ x: cx, y: cy })
        setRippleToken((t) => t + 1)
        rippleRadiusRef.current = 0
        // Compute how far this ring needs to travel: distance from the
        // centroid to the furthest board cell center, plus a small margin
        // so the wave fully exits the board before being cleared.
        let maxDistSq = 0
        for (const cell of boardDef.cells) {
          const pos = boardLayout.positions[cell.id]
          const x = pos.x + boardLayout.offsetX
          const y = pos.y + boardLayout.offsetY
          const dx = x - cx
          const dy = y - cy
          const distSq = dx * dx + dy * dy
          if (distSq > maxDistSq) {
            maxDistSq = distSq
          }
        }
        const margin = HEX_SIZE * 1.4
        const maxRadius = Math.sqrt(maxDistSq) + margin
        rippleMaxRadiusRef.current = maxRadius
      }
      if (current.mode === 'daily' && result.clearedPatterns.length > 0) {
        const pulse: string[] = []
        for (const [cellIdKey, after] of Object.entries(result.dailyHits)) {
          const before = current.dailyHits[cellIdKey] ?? 0
          if (before > 0 && after > 0 && after < before) {
            pulse.push(cellIdKey)
          }
        }
        if (pulse.length > 0) {
          setDailyHitPulseCells(pulse)
        }
      }

      // Build per-cell clearing classes so we can drive different
      // animations for lines vs flowers (center vs ring).
      if (result.clearedPatterns.length > 0) {
        const nextClearingClasses: Record<string, string[]> = {}
        for (const pattern of result.clearedPatterns) {
          if (pattern.type === 'line') {
            pattern.cellIds.forEach((id, idx) => {
              // In daily mode, don't animate numbered cubes that won't
              // actually disappear (still have hits remaining after clear).
              if (current.mode === 'daily') {
                const hitsAfter = result.dailyHits[id]
                if (hitsAfter !== undefined && hitsAfter > 0) {
                  return
                }
              }
              const classes = (nextClearingClasses[id] ||= [])
              classes.push('clearing-line', `clearing-line-step-${idx}`)
            })
          } else if (pattern.type === 'flower') {
            // boardDefinition always builds flower patterns with the
            // center cell first: [centerId, ...petalIds].
            const centerIdForPattern = pattern.cellIds[0] ?? null
            for (const id of pattern.cellIds) {
              // In daily mode, don't animate numbered cubes that won't
              // actually disappear (still have hits remaining after clear).
              if (current.mode === 'daily') {
                const hitsAfter = result.dailyHits[id]
                if (hitsAfter !== undefined && hitsAfter > 0) {
                  continue
                }
              }
              const role =
                centerIdForPattern && id === centerIdForPattern
                  ? 'clearing-flower-center'
                  : 'clearing-flower-ring'
              ;(nextClearingClasses[id] ||= []).push(role)
            }
          }
        }
        setClearingClassesByCell(nextClearingClasses)
      }

      // If the piece came from hold, hand and handSlots stay
      // untouched; the only mutation is emptying the hold buffer.
      // Otherwise the played piece vacates its hand slot (slot id ->
      // null) and a fresh hand may be dealt if it was the last one.
      const remainingHand = playFromHold
        ? current.hand
        : current.hand.filter((p) => p.id !== piece.id)
      const updatedSlots = playFromHold
        ? current.handSlots
        : current.handSlots.map((id) =>
            id === piece.id ? null : id,
          )

      let newStreak = current.streak
      if (result.clearedPatterns.length > 0) {
        newStreak = current.streak + 1
      } else {
        newStreak = 0
      }

      // Per-run stats bump for this placement. Single-player only —
      // the multiplayer side counts placements via the lastPlacement
      // effect, gated on byPlayerId === self so partner placements
      // don't double-count into our run totals.
      setRunStats((prev) =>
        applyPlacementToRunStats(prev, {
          piecePlacedCellsCount: piece.shape.cells.length,
          patternsClearedCount: result.clearedPatterns.length,
          rubiesCleared: result.rubiesCleared,
          boardCleared: result.boardCleared,
          pointsGained: result.pointsGained,
          streakAfter: newStreak,
        }),
      )

      // Best-placement snapshot for the gameover highlight reel.
      // Only captures placements that *cleared something* — a
      // raw 0-point drop is never the moment we want to replay.
      // Monotonic max keeps the snapshot pointing at the highest
      // single-placement gain of the run.
      if (
        result.pointsGained >= HIGHLIGHT_REEL_MIN_POINTS &&
        result.clearedPatterns.length > 0 &&
        (runHighlightRef.current === null ||
          result.pointsGained > runHighlightRef.current.pointsGained)
      ) {
        runHighlightRef.current = createHighlightSnapshot({
          mode: current.mode,
          boardBefore: before.board,
          placedCellIds: result.placedCellIds,
          clearedCellIds: result.clearedCellIds,
          clearedPatterns: result.clearedPatterns,
          pointsGained: result.pointsGained,
          causedBoardClear: result.boardCleared,
          goldenCellIds: before.goldenCellIds,
        })
      }

      // Rolling history of every solo placement, used by the
      // pause-menu "Export recent moves as GIF" tool. Snapshots are
      // captured unconditionally here (unlike the best-of-run
      // snapshot above, which gates on pointsGained / clears) so
      // the player can export a sequence that includes setup
      // moves, not just clears. The ring buffer is capped to
      // RUN_HISTORY_MAX entries and reset on new run below.
      {
        const moveSnapshot = createHighlightSnapshot({
          mode: current.mode,
          boardBefore: before.board,
          placedCellIds: result.placedCellIds,
          clearedCellIds: result.clearedCellIds,
          clearedPatterns: result.clearedPatterns,
          pointsGained: result.pointsGained,
          causedBoardClear: result.boardCleared,
          goldenCellIds: before.goldenCellIds,
        })
        const history = runHistoryRef.current
        history.push(moveSnapshot)
        if (history.length > RUN_HISTORY_MAX) {
          history.splice(0, history.length - RUN_HISTORY_MAX)
        }
      }

      // Per-piece-variant stats. Attribute this placement to the
      // rotation variant the piece was dealt in — that's the unit
      // the Piecetiary surfaces, and it matches the nickname the
      // player saw on the tile.
      const placedVariant = findPieceVariant(piece.shape.cells)
      if (placedVariant) {
        setPieceStats((prev) =>
          applyPlacementToPieceStats(prev, {
            variantId: placedVariant.id,
            pointsGained: result.pointsGained,
            patternsClearedCount: result.clearedPatterns.length,
            rubiesCleared: result.rubiesCleared,
            boardCleared: result.boardCleared,
          }),
        )
      }

      let newHand = remainingHand
      let gameOver = false

      // "Third piece" only makes sense when the consumed piece came
      // out of the hand. Playing from hold never empties the hand,
      // so we never auto-deal or bump the fly-in token in that case.
      const isThirdPieceThisHand =
        !playFromHold && remainingHand.length === 0
      let nextHandDealCount = current.dailyHandDealCount
      // The first-launch tutorial hand-feeds the player a single piece
      // per stage; if we auto-dealt three random pieces here a junk
      // hand would flash into the tray before the stage-transition
      // effect could replace state with the next tutorial stage. Skip
      // both the auto-deal and the game-over evaluation for the
      // duration of the tutorial — the transition effect drives the
      // post-placement flow instead.
      const inTutorial = tutorialStageRef.current !== 0

      if (isThirdPieceThisHand && !inTutorial) {
        // In daily mode, use deterministic hand dealing based on seed
        if (current.mode === 'daily' && current.dailySeed != null) {
          nextHandDealCount = (current.dailyHandDealCount ?? 0) + 1
          newHand = dealDailyHand(result.board, current.dailySeed, nextHandDealCount)
        } else {
          newHand = dealPlayableHand(
            result.board,
            undefined,
            undefined,
            current.mode,
          )
        }
        for (let i = 0; i < 3; i++) {
          updatedSlots[i] = newHand[i]?.id ?? null
        }
        // All three slots just got refreshed — bump the fly-in token so
        // every hand button remounts and runs its arrival animation.
        setHandFlyInToken((t) => t + 1)
      }

      // Game-over check considers the held piece as a possible move
      // source too. The post-placement hold is null when the played
      // piece came from hold, otherwise unchanged.
      let newHold = playFromHold ? null : current.hold
      const noMovesLeft = !hasAnyValidMove(
        result.board,
        newHand,
        current.mode,
        newHold,
      )

      if (!inTutorial) {
        if (current.mode === 'daily') {
          // Daily puzzles end either when all numbered targets are broken
          // or when there are no valid moves remaining.
          gameOver = result.dailyCompleted || noMovesLeft
        } else {
          if (noMovesLeft) {
            gameOver = true
          }
        }
      }

      // Auto-rescue: the player can manually drag a piece into the
      // empty hold pocket to dodge a game-over (we'll redeal a hand
      // so the held piece + the new hand have a fresh shot at a
      // valid move). When the only remaining hand piece is
      // unplayable and the hold is empty, that's the one and only
      // configuration where the player is forced to perform that
      // exact action to keep playing. Doing it for them removes the
      // friction; the red flash + flight animation key the player to
      // what just happened and why so the rescue doesn't feel
      // invisible.
      //
      // We intentionally only auto-rescue with EXACTLY one piece in
      // hand. With two or three unplayable pieces and an empty hold
      // the player still has a real choice (which piece to bank),
      // so we let game-over stand unless they take that action
      // themselves.
      let autoRescued = false
      if (
        gameOver &&
        newHand.length === 1 &&
        newHold == null &&
        !result.dailyCompleted
      ) {
        autoRescued = true
        const rescuedPiece = newHand[0]
        const rescuedSlot = updatedSlots.indexOf(rescuedPiece.id)
        const sourceBtn =
          rescuedSlot >= 0 ? handButtonRefs.current[rescuedSlot] : null
        const holdBtn = holdSlotRef.current
        const wrapper = boardWrapperRef.current

        // Park the rescued piece into hold and clear its hand slot.
        newHold = rescuedPiece
        if (rescuedSlot >= 0) {
          updatedSlots[rescuedSlot] = null
        }

        // Deal a fresh hand. Daily uses the deterministic seeded
        // dealer (same path as a manual hold-park would take),
        // endless / big retry up to 30 times for a playable hand.
        if (current.mode === 'daily' && current.dailySeed != null) {
          nextHandDealCount = (nextHandDealCount ?? 0) + 1
          newHand = dealDailyHand(
            result.board,
            current.dailySeed,
            nextHandDealCount,
          )
        } else {
          newHand = dealPlayableHand(
            result.board,
            undefined,
            undefined,
            current.mode,
          )
        }
        for (let i = 0; i < 3; i++) {
          updatedSlots[i] = newHand[i]?.id ?? null
        }
        setHandFlyInToken((t) => t + 1)

        // Re-evaluate game-over with the rescued state. The rescued
        // piece itself is still unplayable by definition, so survival
        // depends on the new hand having at least one playable piece.
        // In endless / big that's nearly guaranteed by dealPlayableHand;
        // in daily the deterministic deal could still be all-blocked,
        // in which case we let the game end after the rescue animation
        // for honesty.
        const stillStuck = !hasAnyValidMove(
          result.board,
          newHand,
          current.mode,
          newHold,
        )
        gameOver =
          current.mode === 'daily'
            ? result.dailyCompleted || stillStuck
            : stillStuck

        // Visual: fly the rescued piece from its hand slot into the
        // hold pocket and pulse the pocket red. Positions are captured
        // from the DOM right now (the slot button hasn't been re-laid
        // out — only its piece content changes on the next commit), so
        // a getBoundingClientRect here gives the right start/end.
        if (sourceBtn && holdBtn && wrapper) {
          const wrapperRect = wrapper.getBoundingClientRect()
          const srcRect = sourceBtn.getBoundingClientRect()
          const dstRect = holdBtn.getBoundingClientRect()
          setRescueAnimation({
            piece: rescuedPiece,
            startX:
              (srcRect.left + srcRect.width / 2 - wrapperRect.left) / scale,
            startY:
              (srcRect.top + srcRect.height / 2 - wrapperRect.top) / scale,
            endX:
              (dstRect.left + dstRect.width / 2 - wrapperRect.left) / scale,
            endY:
              (dstRect.top + dstRect.height / 2 - wrapperRect.top) / scale,
            endScale: computeHoldDisplayScale(
              rescuedPiece.shape.cells,
              holdSizing.handSlotPx,
              holdSizing.holdPocketPx,
            ),
          })
          // Matches the 1200ms hexaclear-rescue-fly + flash keyframes
          // in index.css. Slightly long on purpose: an auto-rescue
          // is a rare "you almost died" moment, so the save should
          // read as deliberate rather than zipping by in a flash.
          setTimeout(() => setRescueAnimation(null), 1200)
        }
        // Auto-rescue closes the current hand the same way a third
        // piece played or a manual park-into-hold would, so we treat
        // the undo stack the same way and clear it — pressing Undo
        // after a rescue would skip past the rescue itself and the
        // ensuing fresh hand, which isn't a useful affordance.
        playError()
        triggerHaptics(true)
      }

      // Score is only surfaced in endless mode. We keep it updated
      // internally so we don't have to special-case game logic.
      let finalScore = current.score
      let shouldDelayScoreUpdate = false
      
      // Big mode shares the same live-scoring loop as endless: piece
      // placement adds flat points, clears spawn the score-fly particle,
      // and the LCD updates as totals merge in. The high-score / best-
      // score side effects are still gated on endless only further
      // below — big mode is a playtest sandbox for now.
      if (current.mode === 'endless' || current.mode === 'big') {
        const newScore = current.score + result.pointsGained
        const flatPoints = piece.shape.cells.length
        finalScore = newScore + flatPoints

        if (result.clearedPatterns.length > 0) {
          setClearingCells(result.clearedCellIds)
          setClearingGoldenCellIds(current.goldenCellIds)
          
          // Calculate total score for this move (pointsGained + piece points)
          const totalScore = result.pointsGained + piece.shape.cells.length
          
          // Get score counter position
          const scoreCounterEl = getScoreCounterEl()
          const boardWrapper = boardWrapperRef.current
          if (scoreCounterEl && boardWrapper) {
            // Calculate centroid of all cleared patterns for start position
            let sumX = 0
            let sumY = 0
            let count = 0
            for (const pattern of result.clearedPatterns) {
              for (const cellId of pattern.cellIds) {
                const cell = boardDef.cells.find((c) => c.id === cellId)
                if (cell) {
                  const pos = boardLayout.positions[cell.id]
                  sumX += pos.x + boardLayout.offsetX
                  sumY += pos.y + boardLayout.offsetY
                  count++
                }
              }
            }
            
            if (count > 0) {
              const startX = sumX / count
              const startY = sumY / count
              
              // Mark that we should delay score update
              shouldDelayScoreUpdate = true

              const generationAtStart = scoreParticleGenerationRef.current
              const animationDurationMs = 1400
              const mergeTimeMs = Math.round(animationDurationMs * 0.85)

              // Defer particle creation until after React has rendered and DOM is updated.
              // Use requestAnimationFrame to ensure DOM is fully updated.
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  if (scoreParticleGenerationRef.current !== generationAtStart) return
                  // In dev StrictMode the updater function can be invoked twice; avoid
                  // scheduling a duplicate particle+merge for the same move.
                  if (lastScheduledScoreParticleActionIdRef.current === actionId) return
                  lastScheduledScoreParticleActionIdRef.current = actionId
                  // Recalculate positions now that DOM is updated
                  const scoreCounterEl = getScoreCounterEl()
                  const boardWrapper = boardWrapperRef.current
                  if (scoreCounterEl && boardWrapper) {
                    const counterRect = scoreCounterEl.getBoundingClientRect()
                    const boardRect = boardWrapper.getBoundingClientRect()
                    const updatedEndX =
                      (counterRect.left + counterRect.width / 2 - boardRect.left) /
                      scale
                    const updatedEndY =
                      (counterRect.top + counterRect.height / 2 - boardRect.top) /
                      scale

                    // Calculate delta once and store it to prevent recalculation on re-render
                    const deltaX = updatedEndX - startX
                    const deltaY = updatedEndY - startY

                    // Create a particle for this scoring event (overlap is OK).
                    const particleId = `score-${Date.now()}-${Math.random()
                      .toString(16)
                      .slice(2)}`
                    setScoreParticles((prev) => [
                      ...prev,
                      {
                        id: particleId,
                        value: totalScore,
                        // Surface the rarest event in the game with a
                        // dedicated label so the +25 doesn't get lost
                        // in the bigger combo number.
                        label: result.boardCleared ? 'BOARD CLEAR!' : undefined,
                        startX,
                        startY,
                        deltaX,
                        deltaY,
                        delay: 0,
                        type: 'base',
                      },
                    ])

                    // Update displayed score and trigger celebration near "merge" time.
                    window.setTimeout(() => {
                      if (scoreParticleGenerationRef.current !== generationAtStart) return
                      setGame((currentGame) => {
                        if (
                          currentGame.mode !== 'endless' &&
                          currentGame.mode !== 'big'
                        )
                          return currentGame
                        return {
                          ...currentGame,
                          score: currentGame.score + totalScore,
                        }
                      })

                      const scoreCounter = getScoreCounterEl()
                      if (scoreCounter) {
                        scoreCelebrateTokenRef.current += 1
                        const token = scoreCelebrateTokenRef.current
                        scoreCounter.classList.add('score-celebrate')
                        window.setTimeout(() => {
                          if (scoreCelebrateTokenRef.current !== token) return
                          scoreCounter.classList.remove('score-celebrate')
                        }, 400)
                      }
                    }, mergeTimeMs)

                    // Remove just this particle after animation completes.
                    window.setTimeout(() => {
                      if (scoreParticleGenerationRef.current !== generationAtStart) return
                      setScoreParticles((prev) =>
                        prev.filter((p) => p.id !== particleId),
                      )
                    }, animationDurationMs + 200)
                  }
                })
              })
              // NOTE: we intentionally do NOT reset `finalScore` to
              // `current.score` here. The delayed setGame above reads
              // `currentGame.score + totalScore` directly, so leaving
              // `finalScore` as the true post-placement total is what
              // lets the best-score check below recognise that a
              // clear pushed the run past the previous best. The
              // immediate `setGame` further down respects
              // `shouldDelayScoreUpdate` and uses `current.score`
              // independently, so nothing else relies on
              // `finalScore` being rewound.
            }
          } else {
            // Fallback to old popup if we can't get positions
            const totalClears = result.clearedPatterns.length
            const popupText =
              totalClears === 1
                ? `Clear · +${result.pointsGained}`
                : `${totalClears} clears · +${result.pointsGained}`
            setScorePopup(popupText)
            setScorePopupId((id) => id + 1)
          }
        }

        // Best-score tracking only for the original endless ladder for
        // now; big-mode scores live on a separate scale and would
        // otherwise dominate the all-time best LCD after a single run.
        if (current.mode === 'endless') {
          setBestScore((prev) => {
            if (prev === null || finalScore > prev) {
              window.localStorage.setItem(
                'hexaclear-best-score',
                String(finalScore),
              )
              return finalScore
            }
            return prev
          })
        }

        // Ruby capture popups + radial bursts: in big mode several
        // rubies can be cleared in a single placement, each one earns
        // its own local "+10" popup and shard burst at its previous
        // position. Endless behaves as before with at most one.
        const previousRubySet = new Set(current.goldenCellIds)
        const newRubySet = new Set(result.goldenCellIds)
        const clearedRubyIds = current.goldenCellIds.filter(
          (id) => !newRubySet.has(id),
        )
        // Defensive: if for some reason the ruby was cleared but its id
        // somehow still appears in the new list (shouldn't happen, but
        // belt-and-braces), also include any clearedCellIds that were
        // rubies before this placement.
        if (clearedRubyIds.length === 0 && result.rubiesCleared > 0) {
          for (const id of result.clearedCellIds) {
            if (previousRubySet.has(id)) clearedRubyIds.push(id)
          }
        }
        if (clearedRubyIds.length > 0) {
          setGoldenPopupCellIds(clearedRubyIds)
          setGoldenPopupToken((t) => t + 1)
          const newBursts: Array<{ token: number; x: number; y: number }> = []
          let nextToken = Date.now()
          for (const rubyId of clearedRubyIds) {
            const rubyPos = boardLayout.positions[rubyId]
            if (rubyPos) {
              newBursts.push({
                token: nextToken++,
                x: rubyPos.x + boardLayout.offsetX,
                y: rubyPos.y + boardLayout.offsetY,
              })
            }
          }
          if (newBursts.length > 0) {
            setRubyBursts((prev) => [...prev, ...newBursts])
          }
        }
      } else {
        // Daily mode: still show the clearing animation. Daily has no
        // rubies, so clearingGoldenCellIds stays empty for that branch.
        if (result.clearedPatterns.length > 0) {
          setClearingCells(result.clearedCellIds)
          setClearingGoldenCellIds(current.goldenCellIds)

          // Score-particle treatment for numbered cubes that this
          // placement fully eliminated (hits went from >0 to 0). One
          // "-1" particle per cube, flying from the cube's last
          // position up to the "Cubes" HUD readout. The HUD's
          // numeric update is held off until the particle merges in,
          // exactly like the endless score counter does.
          const fullyClearedCubeIds: string[] = []
          for (const [cellId, beforeHits] of Object.entries(
            current.dailyHits,
          )) {
            if (beforeHits > 0 && (result.dailyHits[cellId] ?? 0) === 0) {
              fullyClearedCubeIds.push(cellId)
            }
          }

          if (
            fullyClearedCubeIds.length > 0 &&
            // StrictMode dev re-runs the setGame updater (and all of
            // its side effects) twice. The ref mutates synchronously
            // on first pass, so the second pass bails out before
            // either bumping pendingCubesDelta or queueing a second
            // rAF chain. Setting it here (rather than inside the
            // rAF) guarantees the offset and the particle scheduling
            // stay in lockstep — exactly once per placement.
            lastScheduledCubeParticleActionIdRef.current !== actionId
          ) {
            lastScheduledCubeParticleActionIdRef.current = actionId
            const cubeCounterEl = getScoreCounterEl()
            const boardWrapper = boardWrapperRef.current
            if (cubeCounterEl && boardWrapper) {
              const generationAtStart = scoreParticleGenerationRef.current
              const animationDurationMs = 1400
              const mergeTimeMs = Math.round(animationDurationMs * 0.85)
              const offset = fullyClearedCubeIds.length

              // Hold the displayed count steady until particles land.
              setPendingCubesDelta((d) => d + offset)

              // Defer particle creation until after React has
              // rendered + the DOM is updated, so getBoundingClientRect
              // gives us the post-commit cube counter position.
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  if (
                    scoreParticleGenerationRef.current !== generationAtStart
                  )
                    return

                  const cubeCounter = getScoreCounterEl()
                  const boardWrapper2 = boardWrapperRef.current
                  if (!cubeCounter || !boardWrapper2) {
                    // Fallback: if we can't measure, just let the
                    // count catch up immediately so we don't leave
                    // the HUD permanently desynced.
                    setPendingCubesDelta((d) => Math.max(0, d - offset))
                    return
                  }
                  const counterRect = cubeCounter.getBoundingClientRect()
                  const boardRect = boardWrapper2.getBoundingClientRect()
                  const endX =
                    (counterRect.left +
                      counterRect.width / 2 -
                      boardRect.left) /
                    scale
                  const endY =
                    (counterRect.top +
                      counterRect.height / 2 -
                      boardRect.top) /
                    scale

                  const spawnedParticleIds: string[] = []
                  for (const cellId of fullyClearedCubeIds) {
                    const cellPos = boardLayout.positions[cellId]
                    if (!cellPos) continue
                    const startX = cellPos.x + boardLayout.offsetX
                    const startY = cellPos.y + boardLayout.offsetY
                    const deltaX = endX - startX
                    const deltaY = endY - startY

                    const particleId = `cube-${Date.now()}-${Math.random()
                      .toString(16)
                      .slice(2)}`
                    spawnedParticleIds.push(particleId)
                    setScoreParticles((prev) => [
                      ...prev,
                      {
                        id: particleId,
                        value: -1,
                        startX,
                        startY,
                        deltaX,
                        deltaY,
                        delay: 0,
                        type: 'base',
                      },
                    ])
                  }

                  // If, for some reason, no cells resolved to
                  // positions (boardLayout in flux, e.g.), claw
                  // back the offset so the counter doesn't stay
                  // permanently inflated.
                  if (spawnedParticleIds.length < offset) {
                    const missed = offset - spawnedParticleIds.length
                    setPendingCubesDelta((d) => Math.max(0, d - missed))
                  }

                  // Merge time: drop the offset by however many
                  // particles we actually spawned, then play the
                  // counter pop just like endless does.
                  window.setTimeout(() => {
                    if (
                      scoreParticleGenerationRef.current !==
                      generationAtStart
                    )
                      return
                    const landed = spawnedParticleIds.length
                    if (landed > 0) {
                      setPendingCubesDelta((d) => Math.max(0, d - landed))
                    }
                    const counterAtMerge = getScoreCounterEl()
                    if (counterAtMerge && landed > 0) {
                      scoreCelebrateTokenRef.current += 1
                      const token = scoreCelebrateTokenRef.current
                      counterAtMerge.classList.add('score-celebrate')
                      window.setTimeout(() => {
                        if (scoreCelebrateTokenRef.current !== token) return
                        counterAtMerge.classList.remove('score-celebrate')
                      }, 400)
                    }
                  }, mergeTimeMs)

                  // Tidy up the particles after the flight ends.
                  window.setTimeout(() => {
                    if (
                      scoreParticleGenerationRef.current !==
                      generationAtStart
                    )
                      return
                    setScoreParticles((prev) =>
                      prev.filter((p) => !spawnedParticleIds.includes(p.id)),
                    )
                  }, animationDurationMs + 200)
                })
              })
            }
          }
        }
      }

      triggerHaptics(result.clearedPatterns.length > 0)

      // Each consecutive clearing placement steps through clear_1..clear_7,
      // capped at clear_7 thereafter. A non-clearing placement resets
      // current.streak to 0 in game state, so the next clear after that
      // naturally lands back on clear_1. clearCount layers the combo
      // variant on top: 1 clear plays the plain streak sound, 2+ clears
      // play clear_<streak>_combo_<clearCount-1>, capped at combo_3.
      const clearCount = result.clearedPatterns.length
      if (clearCount > 0) {
        if (!inTutorial && current.mode === 'endless') {
          const clearedFlower = result.clearedPatterns.some(
            (pattern) => pattern.type === 'flower',
          )
          if (clearedFlower) {
            flowerHintSeenRef.current = true
            setStorageFlag(FTUE_FLOWER_HINT_KEY)
          } else if (clearCount >= 2) {
            showFtueHint(
              'combo',
              'Combo!',
              FTUE_COMBO_HINT_KEY,
              comboHintSeenRef,
            )
          }
        }

        // If this placement also ends the run, the game-over SFX fires
        // shortly after and overlapping a celebratory clear hit on top
        // of it sounds chaotic. Cede the moment to game_over.wav.
        if (!gameOver) {
          playClearForStreakIndex(current.streak + 1, clearCount)
          // Ruby capture: layer break.wav ~80ms after the clear hit so
          // the shatter reads as a follow-up to the clear, not on top
          // of its attack. Skipped when the same placement also ends
          // the game (game-over SFX owns the moment).
          if (result.rubiesCleared > 0) {
            playBreakAfterClear(80)
          }

          // Announcer: ONE primary cue per placement (voice + matching
          // text pop), reserved for impact moments. Priority per the
          // design doc: board clear outranks streak milestones, which
          // outrank the per-count combo call. Streak lines ride the
          // streak hitting exactly 2/3/4/5 (streaks step by 1, so each
          // fires once per climb). Combo lines cover 2-6 patterns in
          // one placement; 7+ clamps to SEXTUPLE. Suppressed during
          // the tutorial — the first clear of a guided board is not a
          // hype moment.
          if (!inTutorial) {
            const streakAfterClear = current.streak + 1
            const streak = (
              {
                2: { cue: 'announceStreakGood', text: 'Good Streak!' },
                3: { cue: 'announceStreakGreat', text: 'Great Streak!' },
                4: {
                  cue: 'announceStreakUnbelievable',
                  text: 'Unbelievable!',
                },
                5: { cue: 'announceStreakGodlike', text: 'Godlike!' },
              } as const
            )[streakAfterClear]
            const combo = (
              {
                2: { cue: 'announceCombo2', text: 'Double!' },
                3: { cue: 'announceCombo3', text: 'Triple!' },
                4: { cue: 'announceCombo4', text: 'Quad!' },
                5: { cue: 'announceCombo5', text: 'Quintuple!' },
                6: { cue: 'announceCombo6', text: 'Sextuple!' },
              } as const
            )[Math.min(clearCount, 6)]
            if (result.boardCleared) {
              playAnnouncerCue('announceBoardClear')
              showAnnouncerPop('Board Clear!', 'boardclear', 1.45)
            } else if (streak) {
              playAnnouncerCue(streak.cue)
              showAnnouncerPop(
                streak.text,
                'streak',
                1.05 + (streakAfterClear - 2) * 0.1,
              )
            } else if (clearCount >= 2 && combo) {
              playAnnouncerCue(combo.cue)
              showAnnouncerPop(
                combo.text,
                'combo',
                1 + (Math.min(clearCount, 6) - 2) * 0.09,
              )
            }
          }
        }

        // Screenshake intensity grows with combo size and current streak.
        // No shake on non-clearing placements: the board ripple already
        // covers those, and shaking on every drop quickly turns into
        // background noise. Board-clear is the rarest event in the game
        // and gets a much heavier shake regardless of other inputs.
        let intensity = Math.min(
          6,
          clearCount + Math.min(current.streak * 0.5, 3),
        )
        if (result.boardCleared) {
          intensity = Math.max(intensity, 9)
        }
        setShakeRequest((prev) => ({
          token: prev.token + 1,
          intensity,
        }))

        // Hitstop only on "big" clears: combos of 2+, a clear that
        // pushes the streak to 3+, or any board clear. The momentary
        // freeze sells the impact before the cascade plays out.
        const streakAfter = current.streak + 1
        const bigClear =
          clearCount >= 2 || streakAfter >= 3 || result.boardCleared
        if (bigClear) {
          setHitstop(true)
        }

        // Board-clear flourish: a golden flash sweeps across the wrapper
        // on top of the bigger shake. Token retriggers cleanly even if
        // a player somehow lands two board-clears in a row.
        if (result.boardCleared) {
          setBoardClearFlashToken((t) => t + 1)
        }
      }

      const newMoves = current.moves + 1

      // Update per-hand undo history: we only allow undoing moves within
      // the current 3-piece hand. We store snapshots of the pre-move
      // state and clear the history once the third piece has been
      // played OR an auto-rescue closed out the hand for them — both
      // result in a brand-new hand, and undoing across that boundary
      // would jump the player back into a state they can't reach by
      // gameplay anymore.
      const handClosedOut = isThirdPieceThisHand || autoRescued
      if (!handClosedOut) {
        const capped =
          undoStack.length >= 2 ? undoStack.slice(1) : undoStack
        setUndoStack([...capped, before])
      } else {
        setUndoStack([])
      }

      setSelectedPieceId(null)

      // If we're delaying score update (waiting for particle), don't update score yet
      const scoreToUse = shouldDelayScoreUpdate ? current.score : finalScore

      // Tutorial cleanup: stage 1 intentionally lets the captured ruby
      // respawn onto one of the already-filled rosette cells so the
      // player sees it move into the next objective. Stage 2 clears that
      // rosette; before we exit to free play, strip any post-clear ruby
      // respawn so a stray cube does not flash on the cleared board.
      let committedBoard = result.board
      let committedGoldenCellIds = result.goldenCellIds
      if (tutorialStageRef.current === 2 && result.rubiesCleared > 0) {
        committedBoard = { ...result.board }
        for (const id of result.goldenCellIds) {
          if (before.board[id] === 'empty') committedBoard[id] = 'empty'
        }
        committedGoldenCellIds = []
      }

      return {
        ...current,
        board: committedBoard,
        score: scoreToUse,
        streak: result.clearedPatterns.length > 0 ? newStreak : 0,
        hand: newHand,
        handSlots: updatedSlots,
        hold: newHold,
        gameOver,
        moves: newMoves,
        dailyHits: result.dailyHits,
        dailyTotalHits: result.dailyTotalHits,
        dailyRemainingHits: result.dailyRemainingHits,
        dailyCompleted: result.dailyCompleted,
        dailyHandDealCount: nextHandDealCount,
        goldenCellIds: committedGoldenCellIds,
      }
    })
  }

  const handleCellClick = (cellId: string) => {
    if (!selectedPieceId) return
    const piece = selectedPiece
    const previewForDrop =
      piece && cellId
        ? getBestPlacementPreview(cellId, piece, game)
        : null
    placePieceAtCell(
      selectedPieceId,
      cellId,
      previewForDrop?.targetIds ?? undefined,
    )
  }

  const resetGame = () => {
    scoreParticleGenerationRef.current += 1
    lastScheduledScoreParticleActionIdRef.current = null
    lastScheduledCubeParticleActionIdRef.current = null
    setScoreParticles([])
    setPendingCubesDelta(0)
    setTutorialEndScreenPending(false)
    if (game.mode === 'daily') {
      // Preserve the active daily date key when resetting — if the
      // player is replaying an archive day from history, "Reset"
      // should restart that same archive day, not jump them back to
      // today.
      const next = createDailyGameState(game.dailyDateKey)
      setGame(next)
      setSavedDailyGame(next)
      setDailyHighScoreSaved(false)
    } else if (game.mode === 'big') {
      const next = createBigGameState()
      setGame(next)
      setSavedBigGame(next)
    } else {
      const next = createInitialGameState()
      setGame(next)
      setSavedEndlessGame(next)
      setHighScoreSaved(false)
    }
    setSelectedPieceId(null)
    setHover(null)
    setFtueHint(null)
    setUndoStack([])
    setUndoAnimation(null)
    setPendingUndoRestoreSlotIndex(null)
    setGoldenPopupCellIds([])
    setClearingCells([])
    setClearingGoldenCellIds([])
    setPendingGoldenSpawnCellIds([])
    setScorePopup(null)
    startDealIn()
  }

  // ---- First-launch micro-tutorial -----------------------------------
  //
  // The tutorial leans on the existing placement pipeline: each stage's
  // single hand piece is the player's only legal move, dropping it
  // produces a real clear with full juice (audio, particles, ripple,
  // shake), and the state-transition effect below waits for the clear
  // animation before moving to the next beat.
  //
  // Why an effect rather than a callback on placement? The juice
  // pipeline (clear animations, score particles, ripple, ...) is
  // driven by post-placement state — we want the player to *see* the
  // tutorial clear finish before the board changes. Watching
  // `clearingCells` to drain back to empty is the cleanest "the
  // animation just ended" signal that already exists.

  const exitTutorial = useCallback((completed = false) => {
    // Wipe any visual artifacts from the tutorial board (particles,
    // ripples, popups, etc.) before swapping in the real game state.
    scoreParticleGenerationRef.current += 1
    lastScheduledScoreParticleActionIdRef.current = null
    lastScheduledCubeParticleActionIdRef.current = null
    setScoreParticles([])
    setPendingCubesDelta(0)
    setSelectedPieceId(null)
    setHover(null)
    setFtueHint(null)
    setUndoStack([])
    setUndoAnimation(null)
    setPendingUndoRestoreSlotIndex(null)
    setGoldenPopupCellIds([])
    setClearingCells([])
    setClearingGoldenCellIds([])
    setPendingGoldenSpawnCellIds([])
    setScorePopup(null)

    const fresh = createInitialGameState()
    setGame(fresh)
    setSavedEndlessGame(fresh)
    setTutorialEndScreenPending(completed)
    setTutorialStage(0)
    startDealIn()
    try {
      window.localStorage.setItem(TUTORIAL_COMPLETED_KEY, '1')
    } catch {
      // Best-effort; if storage is unavailable, the tutorial will
      // re-fire next session, which is harmless.
    }
  }, [startDealIn])

  const skipTutorial = useCallback(() => {
    if (tutorialStageRef.current === 0) return
    playUiClick()
    exitTutorial()
  }, [exitTutorial])

  // Drive the line -> rosette -> free-play progression. Fires only
  // while the tutorial is active and only after the player's single
  // piece has been placed (hand empty) AND the resulting clear
  // animation has finished (clearingCells drained).
  //
  // The streak check guards against a clever misclick: nothing
  // physically prevents the player from dropping a tutorial piece on
  // empty cells away from the highlighted target. `streak === 0` means
  // the last placement didn't clear, so we silently restage and let
  // them try again.
  useEffect(() => {
    if (tutorialStage === 0) return
    if (game.hand.length > 0) return
    if (clearingCells.length > 0) return
    if (game.streak === 0) {
      const handle = window.setTimeout(() => {
        setGame((current) =>
          tutorialStage === 1
            ? createTutorialStage1State()
            : createTutorialStage2State(current),
        )
      }, 480)
      return () => window.clearTimeout(handle)
    }
    const handle = window.setTimeout(() => {
      if (tutorialStage === 1) {
        setGame((current) => createTutorialStage2State(current))
        setTutorialStage(2)
        setHandFlyInToken((t) => t + 1)
      } else {
        exitTutorial(true)
      }
    }, tutorialStage === 1 ? 360 : 620)
    return () => window.clearTimeout(handle)
  }, [
    tutorialStage,
    game.hand.length,
    game.streak,
    clearingCells.length,
    exitTutorial,
  ])

  // Start (or replay) the daily puzzle for a specific calendar
  // day, dispatched from the history calendar modal. Past-day
  // puzzles share the same seeded layout as the day they
  // originally ran on, and a new best on any past day still
  // upserts that day's row on the global daily leaderboard — see
  // `handleSaveDailyHighScore` for the submission gate.
  // We piggy-back on the existing daily slot (`savedDailyGame`)
  // so that switching back to "Daily" via the mode toggle
  // resumes whatever puzzle the player was last on, archive or
  // not.
  const handleStartDailyForDateKey = (dateKey: string) => {
    scoreParticleGenerationRef.current += 1
    lastScheduledScoreParticleActionIdRef.current = null
    lastScheduledCubeParticleActionIdRef.current = null
    setScoreParticles([])
    setPendingCubesDelta(0)
    const next = createDailyGameState(dateKey)
    setGame(next)
    setSavedDailyGame(next)
    setDailyHighScoreSaved(false)
    setPendingDailyHighScore(false)
    setPendingDailyMoves(null)
    setSelectedPieceId(null)
    setHover(null)
    setUndoStack([])
    setUndoAnimation(null)
    setPendingUndoRestoreSlotIndex(null)
    setGoldenPopupCellIds([])
    setClearingCells([])
    setClearingGoldenCellIds([])
    setPendingGoldenSpawnCellIds([])
    setScorePopup(null)
    setShowDailyHistory(false)
    startDealIn()
  }

  // ---- Multiplayer handlers -----------------------------------------

  // Restart a co-op room in place: the server resets the shared
  // board and re-deals both hands, so neither player has to copy a
  // new link or rejoin. We flush local-only UI bookkeeping
  // (selection, hovers, particles, half-finished clears) so the
  // post-restart server state shows up clean.
  const handleRestartCoop = () => {
    if (!mpRoomCode) return
    mp.restart().catch(() => {})
    scoreParticleGenerationRef.current += 1
    lastScheduledScoreParticleActionIdRef.current = null
    lastScheduledCubeParticleActionIdRef.current = null
    setScoreParticles([])
    setPendingCubesDelta(0)
    setSelectedPieceId(null)
    setHover(null)
    setUndoStack([])
    setUndoAnimation(null)
    setPendingUndoRestoreSlotIndex(null)
    setGoldenPopupCellIds([])
    setClearingCells([])
    setClearingGoldenCellIds([])
    setPendingGoldenSpawnCellIds([])
    setScorePopup(null)
  }

  const handleLeaveRoom = () => {
    if (!mpRoomCode) return
    const code = mpRoomCode
    mp.leave().catch(() => {})
    setMpRoomCode(null)
    setRoomCodeInUrl(null)
    setMpShareUrl(null)
    setMpError(null)
    // Reset the lobby-mode toggle to the common-case default so the
    // next room the player creates starts as co-op unless they
    // explicitly flip to PvP again.
    setMpPendingMode('coop')
    joinAttemptRef.current = { code: '', attempted: false }
    // Drop straight back into a fresh single-player big game so the
    // local view doesn't keep showing the just-left shared board.
    const next = createBigGameState()
    setGame(next)
    setSavedBigGame(next)
    setSelectedPieceId(null)
    setHover(null)
    setClearingCells([])
    setClearingGoldenCellIds([])
    setPendingGoldenSpawnCellIds([])
    setUndoStack([])
    void code
  }

  // Mirror finished co-op runs to the global leaderboard. Both clients
  // see `mp.status === 'gameover'` simultaneously and race-fire the
  // mutation; the server dedupes on (roomCode, finishedAt) so only one
  // row lands. We also guard locally with a ref keyed on the same pair
  // so re-renders during the gameover-modal lifetime don't keep
  // re-firing the mutation.
  //
  // CRITICAL: `finishedAt` here is `lastPlacement.ts` — the server-
  // stamped time of the placement that ended the game — not the
  // room's `updatedAt`. The two are equal at the moment of gameover,
  // but `updatedAt` can later be patched by other writes (e.g. an
  // emote sent into the gameover modal), which would shift the dedupe
  // key and slip a duplicate row past the server's
  // (roomCode, finishedAt) check. `lastPlacement.ts` is the actual
  // "this game ended" timestamp and is stable for the lifetime of
  // the finished run.
  // Co-op gameover submit pipeline. We always upsert the run into the
  // per-device co-op high-scores store (so the player's "local"
  // co-op leaderboard tracks every partnership they've been part of,
  // deduped to one row per group), and only fire the global mutation
  // when the run is also the new best-ever score for its group. That
  // gating mirrors the endless / daily flow and keeps the global
  // table from collecting churn from the same group repeatedly
  // grinding at the same score.
  //
  // CRITICAL: `finishedAt` here is `lastPlacement.ts` — the server-
  // stamped time of the placement that ended the game — not the
  // room's `updatedAt`. The two are equal at the moment of gameover,
  // but `updatedAt` can later be patched by other writes (e.g. an
  // emote sent into the gameover modal), which would shift the
  // dedupe key and slip a duplicate row past the server's
  // (roomCode, finishedAt) check. `lastPlacement.ts` is the actual
  // "this game ended" timestamp and is stable for the lifetime of
  // the finished run.
  const coopScoreSubmittedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!isMultiplayer) return
    if (mp.status !== 'gameover') return
    if (!mpRoomCode) return
    if (mp.allPlayers.length === 0) return
    if (mp.game === null) return
    // Spectators are read-only watchers of the match — they shouldn't
    // co-claim the seated players' co-op leaderboard run.
    if (mp.isSpectator) return
    const finishedAt = mp.lastPlacement?.ts ?? mp.updatedAt
    if (finishedAt === null) return
    const dedupeKey = `${mpRoomCode}@${finishedAt}`
    if (coopScoreSubmittedRef.current === dedupeKey) return
    coopScoreSubmittedRef.current = dedupeKey

    const sortedBySlot = [...mp.allPlayers].sort((a, b) => a.slot - b.slot)
    const playerIds = sortedBySlot.map((p) => p.playerId)
    const groupKey = computeCoopGroupKey(playerIds)
    const combinedName = sortedBySlot.map((p) => p.name).join(' & ')
    const score = mp.game.score
    const newEntry: CoopHighScoreEntry = {
      groupKey,
      name: combinedName,
      score,
      date: finishedAt,
      playerIds,
    }
    setLastCoopSavedGroupKey(groupKey)
    setLastCoopSavedScore(score)
    let isNewGroupBest = false
    setCoopHighScores((prev) => {
      const result = applyCoopHighScore(prev, newEntry)
      isNewGroupBest = result.isNewGroupBest
      if (
        result.isNewGroupBest &&
        typeof window !== 'undefined'
      ) {
        window.localStorage.setItem(
          COOP_HIGH_SCORES_KEY,
          JSON.stringify(result.list),
        )
      }
      return result.list
    })

    if (!isNewGroupBest) return
    submitCoopGlobal({
      roomCode: mpRoomCode,
      finishedAt,
      score,
      players: sortedBySlot.map((p) => ({
        playerId: p.playerId,
        name: p.name,
        slot: p.slot,
      })),
    }).catch(() => {
      // If the network was flaky, allow a retry on the next render —
      // server-side dedup will still no-op a successful resend.
      coopScoreSubmittedRef.current = null
    })
    // mp.allPlayers identity changes per render but the underlying data
    // is stable until the room mutates; lastPlacement.ts + roomCode is
    // enough to gate this safely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMultiplayer, mp.status, mpRoomCode, mp.lastPlacement?.ts])

  // Reset the dedup ref when the player leaves the room so re-joining
  // a *different* room and finishing it submits cleanly.
  useEffect(() => {
    if (!mpRoomCode) coopScoreSubmittedRef.current = null
  }, [mpRoomCode])

  // Per-run stats lifecycle.
  //
  // 1) RESET on a new run: detected by `game.moves` falling back to
  //    0 from a non-zero value. Initial mount uses the useState
  //    initializer so we don't need to handle it here.
  // 2) FOLD on gameover: detected by `game.gameOver` flipping true.
  //    We read the latest runStats off a ref so the effect doesn't
  //    have to subscribe to runStats and re-fire on every placement.
  // 3) TICK active-play time: a 500ms interval that only runs while
  //    no modal/menu is open and the run isn't over. Per-tick delta
  //    is capped at 2s so a backgrounded tab doesn't suddenly add
  //    minutes to the count when it wakes back up.
  const runStatsRef = useRef<RunStats>(runStats)
  useEffect(() => {
    runStatsRef.current = runStats
  }, [runStats])

  const prevMovesRef = useRef<number>(game.moves)
  useEffect(() => {
    if (game.moves === 0 && prevMovesRef.current > 0) {
      setRunStats(createEmptyRunStats())
      // New run: clear the "best placement" snapshot too. We don't
      // also clear modalHighlightSnapshot here on purpose — the
      // gameover modal owns its own reset (cleared when the
      // player dismisses the modal / starts a fresh game from it)
      // so the reel survives if a new run starts under the modal.
      runHighlightRef.current = null
      // Same for the move-history ring buffer that backs the
      // pause-menu export tool — the new run starts with a fresh
      // (empty) history; only this run's moves are exportable.
      runHistoryRef.current = []
    }
    prevMovesRef.current = game.moves
  }, [game.moves])

  const prevGameOverRef = useRef<boolean>(game.gameOver)
  useEffect(() => {
    if (!prevGameOverRef.current && game.gameOver) {
      // Spectators don't fold a gameover into their own lifetime
      // stats or post to the PvP / co-op leaderboards — the match
      // they're watching isn't theirs to claim a result for. We
      // still flip the ref below so a later "really our run"
      // gameover (if they leave + start their own game) is treated
      // as the rising edge.
      if (isMultiplayer && mp.isSpectator) {
        prevGameOverRef.current = game.gameOver
        return
      }
      // Promote the live best-placement ref into modal state so
      // the highlight reel can render in the gameover modal
      // regardless of whether the player triggers a fresh run
      // beneath the modal (which would clear the ref). Daily
      // mode runs *don't* get a reel: the format is move-ranked,
      // not score-ranked, so a "biggest single placement"
      // framing doesn't fit.
      if (game.mode !== 'daily' && runHighlightRef.current) {
        setModalHighlightSnapshot(runHighlightRef.current)
      } else {
        setModalHighlightSnapshot(null)
      }
      // "Killing hand" credit per piece-variant: every variant
      // still sitting in the hand or hold buffer at game-over
      // earns one tick. Deduped inside `applyGameOverToPieceStats`
      // so a hand of three identical variants only takes one
      // credit. This is what powers the "Layla has ended N runs"
      // flavor line on the Piecetiary detail sheet.
      {
        const remainingVariantIds: string[] = []
        const collect = (piece: ActivePiece | null) => {
          if (!piece) return
          const variant = findPieceVariant(piece.shape.cells)
          if (variant) remainingVariantIds.push(variant.id)
        }
        for (const piece of game.hand) collect(piece)
        collect(game.hold)
        if (remainingVariantIds.length > 0) {
          setPieceStats((prev) =>
            applyGameOverToPieceStats(prev, remainingVariantIds),
          )
        }
      }
      const finishedRun = runStatsRef.current
      // Co-op partners list = everyone in the room *except* us.
      // (mp.allPlayers includes self; partner ids skip our own id.)
      const partnerIds = isMultiplayer
        ? mp.allPlayers
            .map((p) => p.playerId)
            .filter((pid) => pid !== playerId)
        : []
      // Use the puzzle's own date key (not the clock-day key) so
      // archive replays roll into the correct calendar slot in
      // both dailyDaysCleared/Played and dailyBestMovesByDate. The
      // explicit today fallback keeps single-mode-flow daily runs
      // working when the game state doesn't carry an explicit key.
      const dateKey =
        game.mode === 'daily' ? (game.dailyDateKey ?? getTodayKey()) : null
      // Pull MP outcome details off the live room so PvP wins /
      // shames roll up into the right counters. mp.mode falls back
      // to 'coop' for any legacy room without a mode field.
      const mpMode = isMultiplayer ? mp.mode : null
      const pvpWinnerId = isMultiplayer ? mp.winnerPlayerId : null
      const pvpSelfWon =
        isMultiplayer && mpMode === 'pvp' && pvpWinnerId === playerId
      const pvpShame =
        isMultiplayer && mpMode === 'pvp' && pvpWinnerId === null
      setLifetimeStats((prev) => {
        const next = foldRunIntoLifetime(prev, finishedRun, {
          mode: game.mode as 'endless' | 'daily' | 'big',
          isMultiplayer,
          mpMode,
          pvpSelfWon,
          pvpShame,
          finalScore: game.score,
          finalMoves: game.moves,
          dailyCleared: game.dailyCompleted,
          dailyDateKey: dateKey,
          coopPartnerIds: partnerIds,
        })
        saveLifetimeStats(next)
        if (isAuthenticated) {
          void syncStatsToAccount(next)
        }
        return next
      })
      // Mirror PvP outcomes to the global PvP leaderboard. Each
      // client fires its own submit so the per-player counter
      // upserts independently — SHAME folds in as a loss for every
      // seated player because the local pvpShame flag is true for
      // everyone when no winner crossed the threshold.
      if (isMultiplayer && mpMode === 'pvp') {
        const outcome: 'win' | 'loss' = pvpSelfWon ? 'win' : 'loss'
        submitPvpGlobal({
          playerId,
          name: mpPlayerName,
          outcome,
        }).catch(() => {})
      }
    }
    prevGameOverRef.current = game.gameOver
    // We intentionally exclude runStats / mp.allPlayers from deps to
    // avoid re-firing the fold on every placement. The transition
    // edge gating + ref-read pattern keeps it correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    game.gameOver,
    game.mode,
    game.score,
    game.moves,
    game.dailyCompleted,
    isMultiplayer,
    isAuthenticated,
    syncStatsToAccount,
  ])

  const isActivelyPlaying =
    !game.gameOver &&
    !showMenu &&
    !showHighScores &&
    !showStats &&
    !showAccount &&
    !showScoring &&
    !showDailyHistory
  useEffect(() => {
    if (!isActivelyPlaying) return
    let lastTick = Date.now()
    const interval = window.setInterval(() => {
      const now = Date.now()
      const delta = now - lastTick
      lastTick = now
      if (delta > 0 && delta < 2000) {
        setRunStats((prev) => ({
          ...prev,
          activePlayMs: prev.activePlayMs + delta,
        }))
      }
    }, 500)
    return () => window.clearInterval(interval)
  }, [isActivelyPlaying])

  const handleAccountSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setAccountError(null)
    setAccountMessage(null)
    setAccountSyncState('syncing')
    try {
      await signIn('password', {
        email: accountEmail.trim(),
        password: accountPassword,
        flow: accountMode,
      })
      setAccountMessage('Signed in. Combining this device with online stats...')
      setAccountPassword('')
    } catch (err) {
      setAccountSyncState('idle')
      setAccountError(
        err instanceof Error
          ? err.message
          : accountMode === 'signUp'
          ? 'Could not create account.'
          : 'Could not sign in.',
      )
    }
  }

  const handleAccountSignOut = async () => {
    setAccountError(null)
    setAccountMessage(null)
    setAccountSyncState('syncing')
    try {
      await signOut()
      clearStatsSyncAccountId()
      setAccountSyncState('idle')
      setAccountMessage('Signed out. Local stats remain on this device.')
    } catch (err) {
      setAccountSyncState('idle')
      setAccountError(err instanceof Error ? err.message : 'Could not sign out.')
    }
  }

  // Snap the gameover endless leaderboard to whichever page contains
  // the player's just-saved row, so the modal opens framed on their
  // entry instead of always landing on the top of the list. We
  // re-snap when the modal opens, when a fresh save lands, or when
  // the saved-flag clears (which indicates a fresh run and the
  // previous run's `lastSavedHighScoreDate` should no longer be
  // followed). We deliberately don't depend on `highScores` identity
  // so a player paging through their list mid-modal doesn't get
  // yanked back.
  useEffect(() => {
    if (!game.gameOver) return
    if (game.mode !== 'endless') return
    if (highScoreSaved && lastSavedHighScoreDate !== null) {
      const sorted = [...highScores].sort(
        (a, b) => b.score - a.score || a.date - b.date,
      )
      const idx = sorted.findIndex((e) => e.date === lastSavedHighScoreDate)
      if (idx >= 0) {
        setGameoverEndlessPage(
          Math.floor(idx / GAMEOVER_LEADERBOARD_PAGE_SIZE),
        )
        return
      }
    }
    setGameoverEndlessPage(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.gameOver, game.mode, highScoreSaved, lastSavedHighScoreDate])

  // Always re-collapse the gameover leaderboard when the modal is
  // closed (game.gameOver flips back to false on retry / new run).
  // This way the next gameover modal opens to its compact top-3
  // default, even if the player had previously expanded it.
  useEffect(() => {
    if (!game.gameOver) setGameoverLeaderboardExpanded(false)
  }, [game.gameOver])

  // Snap each gameover GLOBAL leaderboard to the page containing the
  // player's row whenever the global query first resolves (or the
  // player's identity changes). We key on the array length rather
  // than identity so subsequent prev/next clicks aren't clobbered
  // by Convex realtime refetches.
  useEffect(() => {
    if (!game.gameOver) return
    if (game.mode !== 'endless') return
    const list = globalEndlessScores
    if (list === undefined) return
    const idx = list.findIndex((e) => e.playerId === playerId)
    setGameoverEndlessGlobalPage(
      idx >= 0 ? Math.floor(idx / GAMEOVER_LEADERBOARD_PAGE_SIZE) : 0,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.gameOver, game.mode, playerId, globalEndlessScores?.length])

  useEffect(() => {
    if (!game.gameOver) return
    if (game.mode !== 'daily') return
    const list = globalDailyScores
    if (list === undefined) return
    const idx = list.findIndex((e) => e.playerId === playerId)
    setGameoverDailyGlobalPage(
      idx >= 0 ? Math.floor(idx / GAMEOVER_LEADERBOARD_PAGE_SIZE) : 0,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.gameOver, game.mode, playerId, globalDailyScores?.length])

  useEffect(() => {
    if (!game.gameOver) return
    if (!isMultiplayer) return
    const list = globalCoopScores
    if (list === undefined) return
    const groupKey = lastCoopSavedGroupKey
    const idx =
      groupKey === null
        ? -1
        : list.findIndex((e) => (e.playerIdsKey ?? '') === groupKey)
    setGameoverCoopGlobalPage(
      idx >= 0 ? Math.floor(idx / GAMEOVER_LEADERBOARD_PAGE_SIZE) : 0,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    game.gameOver,
    isMultiplayer,
    lastCoopSavedGroupKey,
    globalCoopScores?.length,
  ])

  // Single-action "Copy Link" used from the co-op HUD. If we're not
  // already in a room, we lazily spin one up so the link points at a
  // real lobby; if we are, we copy the existing URL. Either way the
  // button briefly flips to "Copied!" and then reverts. No modal.
  //
  // Important: this handler must be synchronous up to the
  // `navigator.clipboard.write` call. Safari / iOS reject any
  // clipboard write that's separated from the user gesture by an
  // `await`, so we use the `ClipboardItem(Promise<Blob>)` form which
  // lets us kick off the room-creation mutation, register the
  // pending write inside the same gesture tick, and let the browser
  // commit it once the URL resolves.
  const handleCopyLinkAction = (): void => {
    if (copyLinkLabel === 'busy') return
    setMpError(null)

    // Seed the new room with the host's current solo Big board so
    // their in-progress run carries over when a friend joins. We
    // only seed when the local game is in 'big' mode and has already
    // had at least one move; otherwise an empty fresh board is fine
    // and lets the server roll new initial rubies. PvP rooms ignore
    // the seed server-side so both players start from an empty
    // untinted board — passing it is harmless but redundant.
    const seedFromLocal =
      game.mode === 'big' && game.moves > 0
        ? {
            board: game.board,
            goldenCellIds: game.goldenCellIds,
            score: game.score,
            streak: game.streak,
            moves: game.moves,
          }
        : undefined

    // Snapshot the toggle's current value so subsequent re-renders
    // during the async chain can't change which mode we ultimately
    // create the room with.
    const createMode: RoomMode = mpPendingMode

    // Kick off the URL resolution. This IIFE returns synchronously
    // (it returns a Promise) so the clipboard.write call below still
    // runs inside the click gesture.
    const urlPromise = (async (): Promise<string> => {
      let code = mpRoomCode
      let url = mpShareUrl
      if (!code) {
        const res = await createRoomMutation({
          playerId,
          name: mpPlayerName,
          mode: createMode,
          seed: seedFromLocal,
        })
        if (!res?.code) throw new Error('No code returned')
        code = res.code
        setMpRoomCode(code)
        setRoomCodeInUrl(code, createMode === 'pvp' ? 'pvp' : null)
        url = buildRoomShareUrl(code, createMode === 'pvp' ? 'pvp' : null)
        setMpShareUrl(url)
        joinAttemptRef.current = { code, attempted: true }
      } else {
        // Re-copying the link for an existing PvP room: wipe the
        // board first ONLY if the host is still alone (nobody else
        // has joined as a player or spectator yet). That covers the
        // case where the host placed a piece or two while looking
        // for the link button and would otherwise hand their friend
        // a pre-stacked board. Once anyone else is attached, the
        // session is considered formed and Copy Link just re-shares
        // the URL pointed at the live match — wiping mid-game would
        // erase everyone's progress. Co-op never wipes (an in-
        // progress big board is the host's invite to help, not a
        // head-start on PvP territory).
        const hostIsAlone =
          mp.allPlayers.length <= 1 && (mp.spectatorCount ?? 0) === 0
        if (mp.mode === 'pvp' && hostIsAlone) {
          try {
            await prepareRoomForShareMutation({ code, playerId })
          } catch {
            // Best-effort — if the wipe fails (rare) we still want
            // to hand the player their URL rather than blocking.
          }
        }
        if (!url) {
          url = buildRoomShareUrl(
            code,
            mp.mode === 'pvp' ? 'pvp' : null,
          )
          setMpShareUrl(url)
        }
      }
      if (!url) throw new Error('No share URL available')
      return url
    })()

    setCopyLinkLabel('busy')

    const supportsClipboardItem =
      typeof navigator !== 'undefined' &&
      typeof navigator.clipboard?.write === 'function' &&
      typeof window !== 'undefined' &&
      typeof window.ClipboardItem !== 'undefined'

    // Write path. Safari only honors the gesture if we hand it a
    // ClipboardItem with a Promise<Blob> right now — actually
    // awaiting the URL first and then calling writeText bombs out
    // with the "request not allowed by the user agent" error.
    const writePromise: Promise<unknown> = supportsClipboardItem
      ? navigator.clipboard.write([
          new window.ClipboardItem({
            'text/plain': urlPromise.then(
              (text) => new Blob([text], { type: 'text/plain' }),
            ),
          }),
        ])
      : urlPromise.then((text) =>
          typeof navigator !== 'undefined' && navigator.clipboard?.writeText
            ? navigator.clipboard.writeText(text)
            : undefined,
        )

    void Promise.all([urlPromise, writePromise])
      .then(() => {
        setCopyLinkLabel('copied')
        if (copyLinkTimerRef.current !== null) {
          window.clearTimeout(copyLinkTimerRef.current)
        }
        copyLinkTimerRef.current = window.setTimeout(() => {
          setCopyLinkLabel('idle')
          copyLinkTimerRef.current = null
        }, 2200)
      })
      .catch((err: unknown) => {
        setCopyLinkLabel('idle')
        const msg =
          err instanceof Error ? err.message : 'Could not copy link'
        setMpError(msg)
      })
  }

  const handleUndo = () => {
    if (undoStack.length === 0) return
    dismissActionFtueHint()
    const previous = undoStack[undoStack.length - 1]
    const remaining = undoStack.slice(0, -1)

    // Cancel any cube-counter delays from this placement. After undo the
    // dailyHits state bounces back to its pre-placement values, so the
    // displayed cube counter needs to ignore the offset we layered on top
    // when the particle was first scheduled (otherwise it briefly reads
    // higher than the actual remaining count until the merge timeout
    // fires, at which point we'd over-decrement and drop below the truth).
    if (game.mode === 'daily' && pendingCubesDelta !== 0) {
      scoreParticleGenerationRef.current += 1
      lastScheduledCubeParticleActionIdRef.current = null
      setPendingCubesDelta(0)
      setScoreParticles((prev) =>
        prev.filter((p) => !(p.value < 0)),
      )
    }

    // Find cells that are currently filled but will be empty after undo
    const cellsToRemove: string[] = []
    for (const cellId in game.board) {
      if (game.board[cellId] === 'filled' && previous.board[cellId] !== 'filled') {
        cellsToRemove.push(cellId)
      }
    }
    
    // Find which piece was added back. Two possibilities:
    //   1) the placement consumed a hand piece → previous.hand has an
    //      id missing from the current hand
    //   2) the placement consumed the held piece → previous.hold is
    //      set but the current hold is null (or holds a different id)
    // Case 2 takes priority because a hold-source placement leaves
    // the hand untouched, so the "missing from hand" check would
    // return nothing.
    const currentHandIds = new Set(game.hand.map((p) => p.id))
    const restoredFromHold =
      previous.hold != null &&
      (game.hold == null || game.hold.id !== previous.hold.id)
    const restoredHandPieceId = previous.hand.find(
      (p) => !currentHandIds.has(p.id),
    )?.id
    const restoredPieceId = restoredFromHold
      ? previous.hold!.id
      : restoredHandPieceId

    if (cellsToRemove.length > 0 && restoredPieceId) {
      // Calculate centroid of cells being removed (board position)
      let sumX = 0
      let sumY = 0
      for (const cellId of cellsToRemove) {
        const cell = boardDef.cells.find((c) => c.id === cellId)
        if (cell) {
          const pos = boardLayout.positions[cell.id]
          sumX += pos.x + boardLayout.offsetX
          sumY += pos.y + boardLayout.offsetY
        }
      }
      const startX = sumX / cellsToRemove.length
      const startY = sumY / cellsToRemove.length

      // Resolve the actual ActivePiece + destination DOM element. The
      // destination depends on whether the restored piece is heading
      // back into the hold pocket or into a specific hand slot — the
      // animation flies to whichever button corresponds.
      const restoredPiece = restoredFromHold
        ? previous.hold
        : previous.hand.find((p) => p.id === restoredPieceId) ?? null
      const slotIndex = restoredFromHold
        ? -1
        : previous.handSlots.findIndex((id) => id === restoredPieceId)
      const destinationButton = restoredFromHold
        ? holdSlotRef.current
        : slotIndex >= 0
          ? handButtonRefs.current[slotIndex]
          : null

      if (restoredPiece && destinationButton && boardWrapperRef.current) {
        const boardRect = boardWrapperRef.current.getBoundingClientRect()
        const buttonRect = destinationButton.getBoundingClientRect()
        const endX = (buttonRect.left + buttonRect.width / 2 - boardRect.left) / scale
        const endY = (buttonRect.top + buttonRect.height / 2 - boardRect.top) / scale

        // Restore game state immediately so pieces reappear
        setUndoStack(remaining)
        // Only hand restorations need a slot index to hide-during-fly;
        // a hold restoration uses the hold button's own pending flag
        // (see `pendingUndoRestoreFromHold`).
        setPendingUndoRestoreSlotIndex(
          restoredFromHold ? null : slotIndex,
        )
        setPendingUndoRestoreFromHold(restoredFromHold)
        setGoldenPopupCellIds([])
        setClearingCells([])
        setClearingGoldenCellIds([])
        setPendingGoldenSpawnCellIds([])
        setScorePopup(null)
        setGame((current) => {
          const restoredMoves =
            current.mode === 'daily' ? current.moves : previous.moves
          return {
            ...previous,
            moves: restoredMoves,
          }
        })

        // Set up animation (visual only - state already restored)
        setUndoAnimation({
          piece: restoredPiece,
          startX,
          startY,
          endX,
          endY,
          cellIds: cellsToRemove,
        })

        // Clear animation state after animation completes
        setTimeout(() => {
          setSelectedPieceId(null)
          setHover(null)
          setUndoAnimation(null)
          setPendingUndoRestoreSlotIndex(null)
          setPendingUndoRestoreFromHold(false)
        }, 350)
        return
      }
    }
    
    // Fallback: instant undo if we can't animate
    setUndoStack(remaining)
    setPendingUndoRestoreSlotIndex(null)
    setGoldenPopupCellIds([])
    setClearingCells([])
    setClearingGoldenCellIds([])
    setPendingGoldenSpawnCellIds([])
    setScorePopup(null)
    setGame((current) => {
      const restoredMoves =
        current.mode === 'daily' ? current.moves : previous.moves
      return {
        ...previous,
        moves: restoredMoves,
      }
    })
    setSelectedPieceId(null)
    setHover(null)
  }

  const toggleMode = (target: GameMode) => {
    if (game.mode === target) return

    // Snapshot the run we're leaving so toggling back restores it.
    // We do this OUTSIDE setGame's updater because calling other
    // setState functions inside an updater is an antipattern (React
    // may run the updater twice in dev / under concurrent rendering,
    // causing duplicate side effects, and the batched commits can
    // interleave in ways that make a class-driven CSS rule paint a
    // frame behind). All saves and the next-mode resolution happen
    // synchronously here so setGame receives a single, fully-resolved
    // GameState.
    if (game.mode === 'endless') setSavedEndlessGame(game)
    else if (game.mode === 'daily') setSavedDailyGame(game)
    else if (game.mode === 'big') setSavedBigGame(game)

    let nextGame: GameState
    // Mode switches only deal in when they *create* a board; resuming a
    // saved run restores instantly (the deal-in is a fresh-run ritual,
    // not a transition effect).
    let dealInFreshBoard = false
    if (target === 'endless') {
      if (savedEndlessGame) {
        nextGame = savedEndlessGame
      } else {
        nextGame = createInitialGameState()
        setSavedEndlessGame(nextGame)
        dealInFreshBoard = true
      }
    } else if (target === 'daily') {
      if (savedDailyGame) {
        nextGame = savedDailyGame
      } else {
        nextGame = createDailyGameState()
        setSavedDailyGame(nextGame)
        dealInFreshBoard = true
      }
    } else {
      // target === 'big'
      if (savedBigGame) {
        nextGame = savedBigGame
      } else {
        nextGame = createBigGameState()
        setSavedBigGame(nextGame)
        dealInFreshBoard = true
      }
    }

    setGame(nextGame)
    if (dealInFreshBoard) startDealIn()
    setTutorialEndScreenPending(false)
    setSelectedPieceId(null)
    setHover(null)
    // Any in-flight cube-counter delay belongs to the run we're leaving.
    // Without this, switching out and back into daily could resume with
    // a stale +N offset, making the HUD read inflated until the next
    // clear's merge timeout fires.
    if (pendingCubesDelta !== 0) {
      scoreParticleGenerationRef.current += 1
      lastScheduledCubeParticleActionIdRef.current = null
      setPendingCubesDelta(0)
      setScoreParticles((prev) => prev.filter((p) => !(p.value < 0)))
    }
  }

  const preview = useMemo(
    () =>
      hover && hover.cellId
        ? getBestPlacementPreview(
            hover.cellId,
            selectedPiece,
            game,
          )
        : null,
    [hover, selectedPiece, game],
  )

  const nearCompleteFlowerHint = useMemo<{
    index: number
    targetIds: string[]
  } | null>(() => {
    if (tutorialStage !== 2) return null
    if (isMultiplayer) return null
    if (game.mode !== 'endless') return null
    if (game.gameOver) return null

    const flowers = boardDef.patterns.filter((p) => p.type === 'flower')
    const candidates = game.hold ? [...game.hand, game.hold] : game.hand
    for (let index = 0; index < flowers.length; index += 1) {
      const pattern = flowers[index]
      const targetIds = pattern.cellIds.filter((id) => game.board[id] === 'empty')
      if (targetIds.length !== 1) continue

      const canFinishFlower = candidates.some((piece) =>
        boardDef.cells.some((cell) => {
          const result = applyPlacement(
            {
              ...game,
              hand: [piece],
              handSlots: [piece.id],
              gameOver: false,
            },
            piece,
            cell.id,
          )
          return result?.clearedPatterns.some((p) => p.id === pattern.id)
        }),
      )
      if (canFinishFlower) return { index, targetIds }
    }
    return null
  }, [boardDef, game, isMultiplayer, tutorialStage])

  // PvP territory-delta preview. PvP has a non-obvious rule: when a
  // cube gets cleared, the *placer of that cube* receives the
  // territory, not the player who triggered the clear. The chip
  // surfaces that consequence in advance so players can see whose
  // territory each cleared cell will become before they commit to
  // the drop. Returns null in co-op / single-player and when the
  // hover isn't a real clearing placement (so the chip doesn't
  // flash on every empty hover).
  //
  // Self attribution: cells the player would place *and* clear in
  // the same turn count as theirs (they placed them), matching the
  // server-side resolution in convex/rooms.ts.
  const previewTerritoryDelta = useMemo<{
    entries: Array<{ playerId: string; count: number }>
    total: number
    unattributed: number
  } | null>(() => {
    if (!isMultiplayer) return null
    if (mp.mode !== 'pvp') return null
    if (!preview || !preview.valid) return null
    if (preview.clearedIds.length === 0) return null
    const selfId = mp.selfPlayer?.playerId ?? null
    if (!selfId) return null
    const placedSet = new Set(preview.targetIds)
    const owners = mp.cellOwners
    const tally = new Map<string, number>()
    let unattributed = 0
    for (const cellId of preview.clearedIds) {
      // Cells the player is about to place this turn that also
      // immediately clear count as their territory (the placer's
      // own cube cleared).
      const attributedTo = placedSet.has(cellId)
        ? selfId
        : owners[cellId] ?? null
      if (attributedTo) {
        tally.set(attributedTo, (tally.get(attributedTo) ?? 0) + 1)
      } else {
        unattributed += 1
      }
    }
    if (tally.size === 0 && unattributed === 0) return null
    // Sort: self first, then by descending count, then by playerId
    // for a stable tiebreak so the chip text doesn't flicker.
    const entries = Array.from(tally.entries())
      .map(([playerId, count]) => ({ playerId, count }))
      .sort((a, b) => {
        if (a.playerId === selfId) return -1
        if (b.playerId === selfId) return 1
        if (b.count !== a.count) return b.count - a.count
        return a.playerId.localeCompare(b.playerId)
      })
    const total = entries.reduce((sum, e) => sum + e.count, 0) + unattributed
    return { entries, total, unattributed }
  }, [
    isMultiplayer,
    mp.mode,
    mp.cellOwners,
    mp.selfPlayer,
    preview,
  ])

  // Per-partner ghost overlays: for each non-self player who's
  // currently hovering a piece, resolve their (pieceId, originCellId)
  // pair into the list of cells the piece footprint would occupy
  // and stamp the per-player hue onto each one. We tolerate partial
  // off-board footprints by computing positions directly from the
  // axial coords — the partner is "thinking about" placing here, so
  // the player should see exactly the footprint they're aiming at,
  // even if a cell falls outside the board. If the piece is no
  // longer in the partner's hand (race: they placed it, hover
  // hasn't cleared yet), we drop the ghost entirely rather than
  // render a stale silhouette.
  const partnerGhosts = useMemo(() => {
    if (!isMultiplayer) return []
    type Ghost = {
      playerId: string
      hue: number
      cells: { q: number; r: number; cellId: string; onBoard: boolean }[]
    }
    const out: Ghost[] = []
    // PvP hides opponent intent — never project a partner ghost when
    // the room is competitive. Senders also short-circuit their
    // broadcasts in PvP (see the hover-emit effects below) so this
    // map should be empty there, but we still guard the renderer in
    // case a stale or malicious entry lands.
    if (mp.mode === 'pvp') return out
    const boardDef = getBoardDefinitionForMode(game.mode)
    const cellById = new Map(boardDef.cells.map((c) => [c.id, c]))
    for (const [hoverPlayerId, hover] of Object.entries(mp.hoverByPlayerId)) {
      const partner = mp.allPlayers.find(
        (p) => p.playerId === hoverPlayerId,
      )
      if (!partner) continue
      const piece = partner.hand.find((p) => p.id === hover.pieceId)
      if (!piece) continue
      const origin = cellById.get(hover.cellId)
      if (!origin) continue
      const hue = mp.hueShiftByPlayerId[hoverPlayerId] ?? 0
      const cells = piece.shape.cells.map((rel) => {
        const q = origin.coord.q + rel.q
        const r = origin.coord.r + rel.r
        const cellId = axialToId({ q, r })
        return { q, r, cellId, onBoard: cellById.has(cellId) }
      })
      out.push({ playerId: hoverPlayerId, hue, cells })
    }
    return out
  }, [
    isMultiplayer,
    mp.mode,
    mp.hoverByPlayerId,
    mp.allPlayers,
    mp.hueShiftByPlayerId,
    game.mode,
  ])

  // Broadcast our local "I'm currently considering this piece on
  // this cell" to the room so partners can see a tinted ghost of
  // what we're about to drop, in close to real time.
  //
  // Three subtleties this effect has to get right to avoid a flickery
  // ghost on the partner's screen:
  //
  // 1. The local `hover` state goes briefly null between cells —
  //    `onMouseLeave(cellA)` fires before `onMouseEnter(cellB)`, so
  //    there's a sub-50ms window where `hover.cellId === null` even
  //    though the player is mid-drag. Forwarding that null instantly
  //    flashes the ghost out and back in for the partner. We debounce
  //    transitions-to-null via HOVER_NULL_DEBOUNCE_MS: if a non-null
  //    cell shows up in that window we just throttle to it; if not,
  //    we send the null for real (drag actually ended, cancel-zone,
  //    deselected, etc).
  //
  // 2. The trailing flush has to read the LATEST desired state at
  //    fire time, not at scheduling time. We hold the desired pair in
  //    a ref so the timer's callback always picks up the freshest
  //    value, regardless of how many cells the cursor crossed during
  //    the throttle window.
  //
  // 3. Identical re-emits should be cheap: skip if we already told
  //    the server about this exact (pieceId, cellId) within the
  //    refresh window. The HOVER_REFRESH_MS heartbeat (handled by a
  //    separate effect below) keeps the partner's TTL alive when the
  //    player is idling on one cell.
  const HOVER_THROTTLE_MS = 100
  const HOVER_NULL_DEBOUNCE_MS = 220
  const HOVER_REFRESH_MS = 1500
  const desiredHoverRef = useRef<{
    pieceId: string | null
    cellId: string | null
  }>({ pieceId: null, cellId: null })
  const lastHoverSentRef = useRef<{
    pieceId: string | null
    cellId: string | null
    ts: number
  } | null>(null)
  const hoverTrailingTimerRef = useRef<number | null>(null)
  const mpSetHover = mp.setHover
  // PvP rooms keep piece intent hidden — skip every hover broadcast
  // path so we don't pay the bandwidth or leak the preview. Co-op
  // (and any legacy room without a mode) still publishes ghosts.
  const shouldShareHover = isMultiplayer && mp.mode !== 'pvp'
  useEffect(() => {
    if (!shouldShareHover) return

    const desiredPieceId = selectedPieceId ?? null
    const desiredCellId =
      desiredPieceId && hover?.cellId ? hover.cellId : null

    const prev = desiredHoverRef.current
    desiredHoverRef.current = {
      pieceId: desiredPieceId,
      cellId: desiredCellId,
    }

    const now = Date.now()
    const last = lastHoverSentRef.current
    const sameAsLast =
      last !== null &&
      last.pieceId === desiredPieceId &&
      last.cellId === desiredCellId
    const sinceLast = last ? now - last.ts : Infinity
    if (sameAsLast && sinceLast < HOVER_REFRESH_MS) {
      return
    }

    if (hoverTrailingTimerRef.current !== null) {
      window.clearTimeout(hoverTrailingTimerRef.current)
      hoverTrailingTimerRef.current = null
    }

    const flush = () => {
      hoverTrailingTimerRef.current = null
      const cur = desiredHoverRef.current
      const lst = lastHoverSentRef.current
      if (
        lst &&
        lst.pieceId === cur.pieceId &&
        lst.cellId === cur.cellId &&
        Date.now() - lst.ts < HOVER_REFRESH_MS
      ) {
        return
      }
      lastHoverSentRef.current = {
        pieceId: cur.pieceId,
        cellId: cur.cellId,
        ts: Date.now(),
      }
      mpSetHover(cur.pieceId, cur.cellId).catch(() => {})
    }

    // Debounce only the "going to null while still holding a piece"
    // transition — that's the one the local mouseLeave/Enter pair
    // creates between cells. Other transitions (new cell, releasing
    // the piece, switching pieces) flush at the normal throttle rate.
    const isTransientNull =
      desiredPieceId !== null &&
      desiredCellId === null &&
      prev.cellId !== null
    if (isTransientNull) {
      hoverTrailingTimerRef.current = window.setTimeout(
        flush,
        HOVER_NULL_DEBOUNCE_MS,
      )
      return
    }

    if (sinceLast >= HOVER_THROTTLE_MS) {
      flush()
      return
    }

    hoverTrailingTimerRef.current = window.setTimeout(
      flush,
      HOVER_THROTTLE_MS - sinceLast,
    )
  }, [shouldShareHover, selectedPieceId, hover?.cellId, mpSetHover])

  // Re-emit the current hover periodically while it's stationary so
  // partners' stale-out timers (HOVER_STALE_MS in the hook) don't
  // fire mid-think. Without this, a player who selects a piece and
  // mouses over one cell without moving for >3s would see their
  // ghost vanish for the partner.
  useEffect(() => {
    if (!shouldShareHover) return
    const id = window.setInterval(() => {
      const last = lastHoverSentRef.current
      if (!last) return
      if (last.pieceId === null && last.cellId === null) return
      if (Date.now() - last.ts < HOVER_REFRESH_MS) return
      lastHoverSentRef.current = { ...last, ts: Date.now() }
      mpSetHover(last.pieceId, last.cellId).catch(() => {})
    }, HOVER_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [shouldShareHover, mpSetHover])

  // On unmount / room exit, drop any lingering ghost so a partner
  // doesn't see us frozen on our last cell for the stale-out grace
  // window.
  useEffect(() => {
    if (!shouldShareHover) return
    return () => {
      if (hoverTrailingTimerRef.current !== null) {
        window.clearTimeout(hoverTrailingTimerRef.current)
        hoverTrailingTimerRef.current = null
      }
      const last = lastHoverSentRef.current
      if (last && (last.pieceId !== null || last.cellId !== null)) {
        mpSetHover(null, null).catch(() => {})
        lastHoverSentRef.current = { pieceId: null, cellId: null, ts: Date.now() }
      }
    }
  }, [shouldShareHover, mpSetHover])

  useEffect(() => {
    if (game.moves > 0) {
      setHasStartedSession(true)
    }
  }, [game.moves])

  useEffect(() => {
    if (clearingCells.length === 0) return
    const timeout = window.setTimeout(() => {
      setClearingCells([])
      setClearingClassesByCell({})
      setClearingGoldenCellIds([])
      setPendingGoldenSpawnCellIds([])
    }, 600)
    return () => window.clearTimeout(timeout)
  }, [clearingCells])

  // Glass-theme shatter: capture each clear on its own longer-lived
  // timeline so the shards are readable. Skipped under reduced motion
  // (the shard overlay is hidden there anyway) and in other themes.
  useEffect(() => {
    if (theme !== 'glass' || reducedMotion) return
    if (clearingCells.length === 0) return
    setGlassShatter({ cells: clearingCells, token: Date.now() })
    // Held well past the engine's 600ms clear window so the slow shatter
    // (shards fly for ~1.7s) can play out fully and stay legible.
    const timeout = window.setTimeout(() => setGlassShatter(null), 2000)
    return () => window.clearTimeout(timeout)
  }, [clearingCells, theme, reducedMotion])

  // Keep the glass jewel-color map in sync with the board: drop entries for
  // cells that are no longer filled. This resets the palette on a new game
  // (board goes empty) and bounds the map to ≤49 entries without any
  // bespoke reset wiring.
  useEffect(() => {
    if (theme !== 'glass' && theme !== 'mondrian') return
    setGlassCellColors((prev) => {
      let changed = false
      const next: Record<string, number> = {}
      for (const id in prev) {
        if (game.board[id] === 'filled') next[id] = prev[id]
        else changed = true
      }
      return changed ? next : prev
    })
  }, [game.board, theme])

  // Per-cube jewel styles for a hand / hold / ghost piece in the glass
  // theme. Deterministic from the piece id so the hand preview matches what
  // lands on the board. Returns undefined in other themes (no override).
  const glassCubeStylesForPiece = (
    piece: ActivePiece,
  ): (React.CSSProperties | undefined)[] | undefined =>
    theme === 'glass'
      ? piece.shape.cells.map((_, i) =>
          jewelStyle(jewelIndexForPieceCube(piece.id, i), glassHueShift),
        )
      : theme === 'mondrian'
        ? piece.shape.cells.map((_, i) =>
            primaryStyle(jewelIndexForPieceCube(piece.id, i)),
          )
        : undefined

  // Shared resolver for a single board cube's persisted color in the two
  // "painted-cube" themes (glass jewels, abstract primaries). Falls back to a
  // deterministic color from the cell id for pre-seeded / ruby-respawned cells.
  const paintedCellStyle = (index: number): React.CSSProperties | null =>
    theme === 'glass'
      ? jewelStyle(index, glassHueShift)
      : theme === 'mondrian'
        ? primaryStyle(index)
        : null

  // Drive the screenshake animation. Removes the class, forces a reflow,
  // sets the amplitude variable, then re-adds the class so consecutive
  // shakes always restart cleanly instead of fighting an in-progress one.
  useEffect(() => {
    if (shakeRequest.intensity <= 0) return
    const node = boardWrapperRef.current
    if (!node) return
    node.classList.remove('hexaclear-shake')
    node.style.setProperty(
      '--hexaclear-shake-amp',
      String(shakeRequest.intensity),
    )
    // Force reflow so the animation actually restarts.
    void node.offsetWidth
    node.classList.add('hexaclear-shake')
    const tid = window.setTimeout(() => {
      node.classList.remove('hexaclear-shake')
    }, 380)
    return () => {
      window.clearTimeout(tid)
    }
  }, [shakeRequest])

  // Hitstop timer: clears itself after a short freeze so the clear
  // cascade and all paused animations resume together.
  useEffect(() => {
    if (!hitstop) return
    const tid = window.setTimeout(() => {
      setHitstop(false)
    }, 90)
    return () => window.clearTimeout(tid)
  }, [hitstop])

  // Clear ruby bursts after their outward animation completes so the
  // SVG nodes don't pile up across captures. Big-mode placements can
  // queue several bursts at once; once they've all played out we wipe
  // the whole list together.
  useEffect(() => {
    if (rubyBursts.length === 0) return
    const tokenAtStart = rubyBursts[rubyBursts.length - 1]!.token
    const tid = window.setTimeout(() => {
      setRubyBursts((prev) =>
        prev.length > 0 &&
        prev[prev.length - 1]!.token === tokenAtStart
          ? []
          : prev,
      )
    }, 800)
    return () => window.clearTimeout(tid)
  }, [rubyBursts])

  // Persist the reduced-motion preference so the toggle sticks across
  // sessions. The actual visual gating happens via a class on the root
  // viewport element.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        'cubic-reduced-motion',
        reducedMotion ? 'true' : 'false',
      )
    } catch {
      // Best-effort persistence.
    }
  }, [reducedMotion])

  // Same shape as reduced-motion: persist the colorblind toggle to
  // localStorage so it survives reloads. CSS reads the
  // `is-colorblind` class on the viewport root to switch on the
  // non-color cues.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(
        'cubic-colorblind-support',
        colorblindSupport ? 'true' : 'false',
      )
    } catch {
      // Best-effort persistence.
    }
  }, [colorblindSupport])

  // Apply the active theme to <html data-theme="..."> and persist it.
  // Every theme override in CSS is scoped under that selector so
  // switching is purely a single attribute write — no remount needed,
  // no flash, animations keep running. Also swap the tab favicon so
  // the Win98 theme gets its Minesweeper-mine icon instead of the
  // default cube glyph.
  useEffect(() => {
    if (typeof window === 'undefined') return
    document.documentElement.dataset.theme = theme
    const faviconHref =
      theme === 'win98'
        ? '/win_favicon.png'
        : theme === 'mondrian'
          ? '/mondrian_favicon.png'
          : '/favicon.png'
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (link && link.getAttribute('href') !== faviconHref) {
      link.setAttribute('href', faviconHref)
    }
    try {
      window.localStorage.setItem('cubic-theme', theme)
    } catch {
      // Best-effort persistence.
    }
  }, [theme])

  useEffect(() => {
    if (theme !== 'audius') {
      rootRef.current?.style.removeProperty('--audius-pulse')
      rootRef.current?.style.removeProperty('--audius-brightness')
      rootRef.current?.style.removeProperty('--audius-saturation')
      rootRef.current?.style.removeProperty('--audius-scale')
      rootRef.current?.style.removeProperty('--audius-light-overlay')
      rootRef.current?.style.removeProperty('--audius-dark-overlay')
      rootRef.current?.style.removeProperty('--audius-bass')
      rootRef.current?.style.removeProperty('--audius-mid')
      rootRef.current?.style.removeProperty('--audius-treble')
      rootRef.current?.style.removeProperty('--audius-onset')
      rootRef.current?.style.removeProperty('--audius-intensity')
      rootRef.current?.style.removeProperty('--audius-breath')
      rootRef.current?.style.removeProperty('--audius-top-light')
      rootRef.current?.style.removeProperty('--audius-left-warm')
      rootRef.current?.style.removeProperty('--audius-right-shadow')
      rootRef.current?.style.removeProperty('--audius-ripple')
      rootRef.current?.style.removeProperty('--audius-board-glow')
      rootRef.current?.style.removeProperty('--audius-shimmer')
      rootRef.current?.style.removeProperty('--audius-cube-scale')
      rootRef.current?.style.removeProperty('--audius-title-glow')
      rootRef.current?.style.removeProperty('--audius-board-inner-glow')
      rootRef.current?.style.removeProperty('--audius-board-outer-glow')
      rootRef.current?.style.removeProperty('--audius-score-glow-a')
      rootRef.current?.style.removeProperty('--audius-score-glow-b')
      rootRef.current?.style.removeProperty('--audius-score-scale')
      rootRef.current?.style.removeProperty('--audius-outline-glow')
      rootRef.current?.style.removeProperty('--audius-face-glow')
      rootRef.current?.style.removeProperty('--audius-empty-stroke-opacity')
      rootRef.current?.style.removeProperty('--audius-slot-fill-opacity')
      rootRef.current?.style.removeProperty('--audius-top-opacity')
      rootRef.current?.style.removeProperty('--audius-left-opacity')
      rootRef.current?.style.removeProperty('--audius-right-opacity')
      rootRef.current?.style.removeProperty('--audius-face-stroke-opacity')
      rootRef.current?.style.removeProperty('--audius-deck-hot')
      rootRef.current?.style.removeProperty('--audius-meter-bass')
      rootRef.current?.style.removeProperty('--audius-meter-mid')
      rootRef.current?.style.removeProperty('--audius-meter-treble')
      rootRef.current?.style.removeProperty('--audius-meter-onset')
      rootRef.current?.style.removeProperty('--audius-keybed-energy')
      rootRef.current?.style.removeProperty('--audius-cube-top')
      rootRef.current?.style.removeProperty('--audius-cube-left')
      rootRef.current?.style.removeProperty('--audius-cube-right')
      return
    }
    if (audiusTracks.length === 0 && audiusStatus === 'idle') {
      void loadAudiusTracks(audiusSearchQuery)
    }
  }, [audiusSearchQuery, audiusStatus, audiusTracks.length, loadAudiusTracks, theme])

  useEffect(() => {
    const rootEl = rootRef.current
    const canvasEl = audiusCanvasRef.current
    if (theme !== 'audius' || reducedMotion) {
      AUDIUS_VISUAL_PROPERTIES.forEach((property) => {
        rootEl?.style.removeProperty(property)
      })
      rootEl?.classList.remove(...AUDIUS_STAGE_BEAT_CLASSES)
      clearAudiusStageCanvas(canvasEl)
      // The board's hue-rotate is off in these states, so the invalid-preview
      // counter-rotation must return to identity too — otherwise it would be
      // the only rotation left and would push the cue off red.
      audiusInvalidCounterRef.current?.setAttribute('values', '0')
      return
    }
    let frame = 0
    let beatClearTimer = 0
    let beatIndex = 0
    // Layout is cached and only recomputed when the canvas resizes, so the
    // per-frame draw never touches getBoundingClientRect (forced reflow).
    let stageGeometry: AudiusStageGeometry | null = canvasEl
      ? measureAudiusStage(
          canvasEl,
          audiusFrequencyDataRef.current?.length ?? 256,
        )
      : null
    let stageResizeObserver: ResizeObserver | null = null
    if (canvasEl && typeof ResizeObserver !== 'undefined') {
      stageResizeObserver = new ResizeObserver(() => {
        if (!canvasEl) return
        stageGeometry = measureAudiusStage(
          canvasEl,
          audiusFrequencyDataRef.current?.length ??
            stageGeometry?.spectrum ??
            256,
        )
      })
      stageResizeObserver.observe(canvasEl)
    }
    const smoothBand = (
      ref: { current: number },
      target: number,
      attack = 0.34,
      release = 0.09,
    ) => {
      const rate = target > ref.current ? attack : release
      ref.current += (target - ref.current) * rate
      return Math.max(0, Math.min(1, ref.current))
    }
    const markBeat = () => {
      if (!rootEl) return
      const beatClass = AUDIUS_STAGE_BEAT_CLASSES[beatIndex % 2]
      beatIndex += 1
      rootEl.classList.remove(...AUDIUS_STAGE_BEAT_CLASSES)
      rootEl.classList.add(beatClass)
      if (beatClearTimer) window.clearTimeout(beatClearTimer)
      beatClearTimer = window.setTimeout(() => {
        rootEl.classList.remove(...AUDIUS_STAGE_BEAT_CLASSES)
      }, 520)
    }
    const tick = () => {
      const now = performance.now()
      const audio = audiusAudioRef.current
      const playing = audio != null && !audio.paused && !audio.ended
      const analyser = audiusAnalyserRef.current
      const data = audiusFrequencyDataRef.current

      // Draw the EQ on every animation frame for maximum responsiveness:
      // pull a fresh analyser frame and render the raw bars. The heavier band
      // math and CSS-variable writes below stay throttled.
      if (playing && analyser && data) {
        analyser.getByteFrequencyData(data)
        if (
          canvasEl &&
          (!stageGeometry || stageGeometry.spectrum !== data.length)
        ) {
          stageGeometry = measureAudiusStage(canvasEl, data.length)
        }
        drawAudiusStageCanvas(
          canvasEl,
          data,
          audiusCanvasVisualRef.current,
          stageGeometry,
        )
      }

      if (now - audiusLastVisualFrameAtRef.current < AUDIUS_VISUAL_FRAME_MS) {
        frame = window.requestAnimationFrame(tick)
        return
      }
      audiusLastVisualFrameAtRef.current = now

      let pulse = 0
      let energy = 0
      let bass = 0
      let mid = 0
      let treble = 0
      let onset = 0
      let intensity = 0
      let breath = 0
      if (playing && analyser && data) {
        let sum = 0
        let bassSum = 0
        let bassCount = 0
        let midSum = 0
        let midCount = 0
        let trebleSum = 0
        let trebleCount = 0
        let weightedCount = 0
        const sampleCount = Math.min(96, data.length)
        for (let i = 1; i < sampleCount; i++) {
          // Favor bass and low-mid energy, where kick/snare movement is
          // most useful for a simple cube-lightness visualizer.
          const weight = i < 8 ? 1.6 : i < 24 ? 1.15 : 0.65
          const value = data[i]
          if (i < 10) {
            bassSum += value * value
            bassCount += 1
          } else if (i < 42) {
            midSum += value
            midCount += 1
          } else {
            trebleSum += value * value
            trebleCount += 1
          }
          if (i < 48) {
            sum += value * weight
            weightedCount += weight
          }
        }
        const weightedEnergy = sum / Math.max(1, weightedCount)
        const bassEnergy = Math.sqrt(bassSum / Math.max(1, bassCount))
        const midEnergy = midSum / Math.max(1, midCount)
        const trebleEnergy = Math.sqrt(trebleSum / Math.max(1, trebleCount))
        bass = smoothBand(audiusBassEnvelopeRef, Math.min(1, bassEnergy / 255))
        mid = smoothBand(audiusMidEnvelopeRef, Math.min(1, midEnergy / 205), 0.22, 0.055)
        treble = smoothBand(
          audiusTrebleEnvelopeRef,
          Math.min(1, trebleEnergy / 190),
          0.42,
          0.18,
        )
        energy = weightedEnergy * 0.55 + bassEnergy * 0.45
        if (energy > AUDIUS_ANALYSER_SILENCE_EPSILON) {
          const currentFloor = audiusEnergyFloorRef.current
          const currentPeak = audiusEnergyPeakRef.current
          if (currentFloor === 0 && currentPeak === 64) {
            audiusEnergyFloorRef.current = Math.max(0, energy * 0.84)
            audiusEnergyPeakRef.current = Math.max(
              energy * 1.28,
              audiusEnergyFloorRef.current + AUDIUS_MIN_DYNAMIC_RANGE,
            )
          } else {
            const floorRate = energy < currentFloor ? 0.14 : 0.018
            const peakRate = energy > currentPeak ? 0.12 : 0.012
            audiusEnergyFloorRef.current += (energy - currentFloor) * floorRate
            audiusEnergyPeakRef.current += (energy - currentPeak) * peakRate
          }
          if (
            audiusEnergyPeakRef.current - audiusEnergyFloorRef.current <
            AUDIUS_MIN_DYNAMIC_RANGE
          ) {
            audiusEnergyPeakRef.current =
              audiusEnergyFloorRef.current + AUDIUS_MIN_DYNAMIC_RANGE
          }
          const range =
            audiusEnergyPeakRef.current - audiusEnergyFloorRef.current
          const normalized = Math.max(
            0,
            Math.min(1, (energy - audiusEnergyFloorRef.current) / range),
          )
          const previousPulse = audiusPulseEnvelopeRef.current
          const motion = Math.max(0, (normalized - 0.24) / 0.76)
          const curvedMotion = Math.pow(motion, 1.8)
          const onsetRaw = Math.max(0, motion - previousPulse)
          onset = smoothBand(audiusOnsetEnvelopeRef, Math.min(1, onsetRaw * 2.4), 0.65, 0.12)
          intensity = smoothBand(
            audiusIntensityEnvelopeRef,
            Math.pow(motion, 0.72),
            0.028,
            0.012,
          )
          audiusBreathPhaseRef.current =
            (audiusBreathPhaseRef.current + 0.018 + bass * 0.024) %
            (Math.PI * 2)
          breath =
            (0.5 + Math.sin(audiusBreathPhaseRef.current) * 0.5) *
            (0.22 + intensity * 0.78)
          const targetPulse = Math.min(1, curvedMotion * 0.58 + onsetRaw * 1.2)
          const envelopeRate = targetPulse > previousPulse ? 0.46 : 0.16
          audiusPulseEnvelopeRef.current +=
            (targetPulse - previousPulse) * envelopeRate
          pulse = Math.max(0, Math.min(1, audiusPulseEnvelopeRef.current))
          if (
            onset > 0.55 &&
            intensity > 0.34 &&
            now - audiusLastBeatAtRef.current > 340
          ) {
            audiusLastBeatAtRef.current = now
            markBeat()
          }
        } else {
          audiusPulseEnvelopeRef.current *= 0.9
          audiusOnsetEnvelopeRef.current *= 0.86
          audiusIntensityEnvelopeRef.current *= 0.98
          audiusBreathPhaseRef.current =
            (audiusBreathPhaseRef.current + 0.012) % (Math.PI * 2)
          pulse = audiusPulseEnvelopeRef.current
          onset = audiusOnsetEnvelopeRef.current
          intensity = audiusIntensityEnvelopeRef.current
          breath =
            (0.5 + Math.sin(audiusBreathPhaseRef.current) * 0.5) *
            (0.22 + intensity * 0.78)
        }
        if (energy > AUDIUS_ANALYSER_SILENCE_EPSILON) {
          audiusSilentFrameCountRef.current = 0
          audiusAnalyserWarningShownRef.current = false
          setAudiusAnalyserLive((live) => (live ? live : true))
        } else if (audio.currentTime > 0.5) {
          audiusSilentFrameCountRef.current += 1
          if (
            audiusSilentFrameCountRef.current >=
              AUDIUS_ANALYSER_SILENT_FRAME_LIMIT &&
            !audiusAnalyserWarningShownRef.current
          ) {
            audiusAnalyserWarningShownRef.current = true
            setAudiusAnalyserLive(false)
            setAudiusError(
              'Audius playback started, but the browser returned no analyser data for this stream.',
            )
          }
        }
      }
      audiusHueRef.current =
        (audiusHueRef.current + (playing ? 0.025 + mid * 0.3 + treble * 0.12 : 0)) %
        360
      const hue =
        (188 + audiusHueRef.current + mid * 55 + treble * 18 - bass * 24) %
        360
      // Constant hue rotation across the cube layer: a steady base drift that
      // accelerates with the music (intensity + beats). ~0.6deg/frame at 30fps
      // (~18deg/s) at rest, faster on loud/peaky sections.
      audiusCubeHueRef.current =
        (audiusCubeHueRef.current +
          (playing ? 0.6 + intensity * 1.6 + onset * 1.4 : 0)) %
        360
      rootEl?.style.setProperty('--audius-bass', bass.toFixed(3))
      rootEl?.style.setProperty('--audius-mid', mid.toFixed(3))
      rootEl?.style.setProperty('--audius-treble', treble.toFixed(3))
      rootEl?.style.setProperty('--audius-onset', onset.toFixed(3))
      rootEl?.style.setProperty('--audius-intensity', intensity.toFixed(3))
      rootEl?.style.setProperty('--audius-breath', breath.toFixed(3))
      rootEl?.style.setProperty(
        '--audius-meter-bass',
        Math.min(1, bass * 0.94 + intensity * 0.12).toFixed(3),
      )
      rootEl?.style.setProperty(
        '--audius-meter-mid',
        Math.min(1, mid * 0.88 + intensity * 0.18).toFixed(3),
      )
      rootEl?.style.setProperty(
        '--audius-meter-treble',
        Math.min(1, treble * 0.86 + onset * 0.22).toFixed(3),
      )
      rootEl?.style.setProperty(
        '--audius-meter-onset',
        Math.min(1, onset * 0.92 + pulse * 0.2).toFixed(3),
      )
      rootEl?.style.setProperty(
        '--audius-deck-hot',
        Math.min(1, onset * 0.55 + intensity * 0.24 + treble * 0.14).toFixed(3),
      )
      rootEl?.style.setProperty(
        '--audius-board-ambience',
        Math.min(0.62, intensity * 0.3 + breath * 0.18 + onset * 0.14).toFixed(3),
      )
      rootEl?.style.setProperty(
        '--audius-stage-scale',
        (1 + bass * 0.018 + onset * 0.01).toFixed(3),
      )
      rootEl?.style.setProperty('--audius-viz-hue', `${hue.toFixed(1)}deg`)
      rootEl?.style.setProperty(
        '--audius-cube-hue-rotate',
        `${audiusCubeHueRef.current.toFixed(1)}deg`,
      )
      // Cancel that same rotation on the invalid-placement preview so it
      // never drifts off red. The board applies hue-rotate(+X) to its whole
      // subtree; this primitive pre-rotates the preview by -X (sRGB, to match
      // CSS filter semantics) so the two compose back to the authored red.
      audiusInvalidCounterRef.current?.setAttribute(
        'values',
        (-audiusCubeHueRef.current).toFixed(1),
      )
      audiusCanvasVisualRef.current = {
        bass,
        mid,
        treble,
        onset,
        intensity,
        breath,
        hue,
        playing,
      }
      // While playing, the canvas is already drawn every frame at the top of
      // the tick. When stopped, redraw here so bars settle to baseline.
      if (!playing) {
        drawAudiusStageCanvas(
          canvasEl,
          null,
          audiusCanvasVisualRef.current,
          stageGeometry,
        )
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(frame)
      if (beatClearTimer) window.clearTimeout(beatClearTimer)
      stageResizeObserver?.disconnect()
      AUDIUS_VISUAL_PROPERTIES.forEach((property) => {
        rootEl?.style.removeProperty(property)
      })
      rootEl?.classList.remove(...AUDIUS_STAGE_BEAT_CLASSES)
      clearAudiusStageCanvas(canvasEl)
    }
  }, [reducedMotion, theme])

  // Measure the live pixel widths of a hand-piece slot and the Hold
  // pocket whenever either resizes (viewport changes, sidebar opens,
  // etc.). We feed both into computeHoldDisplayScale so the held
  // piece's hex size matches the hand's at most — never larger.
  // Falls back to the previous numbers when refs aren't mounted yet
  // (transitional states between modes).
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const measure = () => {
      const handBtn = handButtonRefs.current.find(
        (r): r is HTMLButtonElement => !!r,
      )
      const holdEl = holdSlotRef.current
      const handSlotPx = handBtn
        ? handBtn.getBoundingClientRect().width
        : 0
      const holdPocketPx = holdEl
        ? holdEl.getBoundingClientRect().width
        : 0
      setHoldSizing((prev) =>
        prev.handSlotPx === handSlotPx &&
        prev.holdPocketPx === holdPocketPx
          ? prev
          : { handSlotPx, holdPocketPx },
      )
    }
    const ro = new ResizeObserver(measure)
    // Observe the hold (which is stable across renders) and any
    // currently-mounted hand button. The hand mounts/unmounts on
    // fly-in token changes, but its layout width is determined by
    // the same flex math as its siblings, so observing one is enough.
    if (holdSlotRef.current) ro.observe(holdSlotRef.current)
    const sample = handButtonRefs.current.find((r) => !!r)
    if (sample) ro.observe(sample)
    measure()
    return () => ro.disconnect()
  }, [game.mode, game.handSlots.length])

  // Game-over wind-down: when the run ends, give the board a beat to
  // desaturate and let the unplayable hand shake before the modal slams
  // in. Plays game_over.wav at the start of the wind-down.
  //
  // useLayoutEffect (rather than useEffect) so the windingDown flag
  // flips synchronously before the browser paints the
  // gameOver=true / windingDown=false state — otherwise the modal
  // briefly flashes on screen between the render that committed the
  // game-over and the post-paint effect that starts the wind-down.
  useLayoutEffect(() => {
    if (!game.gameOver) {
      setGameOverWindingDown(false)
      return
    }

    // Daily win: celebratory beat — flash the gold board-clear overlay
    // and snap directly to the modal. Skip the desaturate wind-down
    // and the game-over SFX since both read as "you lost".
    if (game.mode === 'daily' && game.dailyCompleted) {
      setBoardClearFlashToken((t) => t + 1)
      setGameOverWindingDown(false)
      return
    }

    // Endless loss / daily loss — wind-down: the board sheds its
    // pieces in the collapse wave (skipped in multiplayer and under
    // reduced motion, where the desaturate alone carries the beat),
    // desaturates, then the modal appears over the wreckage.
    setGameOverWindingDown(true)
    playGameOver()
    // The announcer calls it ~450ms after the sting's attack, riding
    // over the collapse clatter rather than colliding with the
    // game_over.wav transient.
    playAnnouncerCue('announceGameOver', 450)
    if (!isMultiplayer && !reducedMotionRef.current) {
      buildCollapse()
    }
    const tid = window.setTimeout(() => {
      setGameOverWindingDown(false)
    }, 2500)
    return () => window.clearTimeout(tid)
    // buildCollapse changes identity with every board change; this
    // effect must only re-fire on actual game-over transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.gameOver, game.dailyCompleted, game.mode])

  // We used to force the pause menu open on every visibilitychange so
  // dismissing it would serve as the user gesture that unlocks audio
  // after iOS suspended the AudioContext. `audio.ts` now installs its
  // own global pointerdown/touchstart/keydown gesture listeners at
  // module load, so any first tap on the board (or anywhere else)
  // rebuilds the AudioContext invisibly. The player no longer has to
  // wade through a modal to get audio back — they can just keep
  // playing — so this refocus-pause is gone.

  useEffect(() => {
    if (recentlyPlacedCells.length === 0) return
    const timeout = window.setTimeout(() => {
      setRecentlyPlacedCells([])
    }, 220)
    return () => window.clearTimeout(timeout)
  }, [recentlyPlacedCells])

  useEffect(() => {
    if (dailyHitPulseCells.length === 0) return
    const timeout = window.setTimeout(() => {
      setDailyHitPulseCells([])
    }, 260)
    return () => window.clearTimeout(timeout)
  }, [dailyHitPulseCells])

  // Drive the ripple radius over time so the circular wave emanates smoothly
  // from the computed center across the full board. Clears move more slowly
  // than non-clearing placements for extra weight. We animate the SVG circle's
  // radius directly via requestAnimationFrame to avoid forcing React to
  // re-render the whole tree every frame.
  useEffect(() => {
    if (!rippleCenter || rippleCells.length === 0) return

    const durationMs = rippleIsClear ? CLEAR_RIPPLE_DURATION_MS : 600
    const maxRadius = Math.max(
      0,
      Number.isFinite(rippleMaxRadiusRef.current)
        ? rippleMaxRadiusRef.current
        : boardRender.rippleRadius * 2,
    )
    const start = performance.now()
    let frame: number

    const svg = svgRef.current
    if (!svg) return
    const circle = svg.querySelector(
      '.hexaclear-ripple-ring',
    ) as SVGCircleElement | null
    if (!circle) return

    rippleRadiusRef.current = 0
    circle.setAttribute('r', '0')

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs)
      const r = t * maxRadius
      rippleRadiusRef.current = r
      circle.setAttribute('r', String(r))
      if (t < 1) {
        frame = window.requestAnimationFrame(step)
      }
    }

    frame = window.requestAnimationFrame(step)

    // Clear ripple state once the animation has had time to fully traverse
    // the board, without needing another React-driven effect.
    const clearTimeoutId = window.setTimeout(() => {
      setRippleCells([])
      setRippleCenter(null)
      rippleRadiusRef.current = 0
    }, durationMs + 32)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.clearTimeout(clearTimeoutId)
    }
  }, [boardRender.rippleRadius, rippleCenter, rippleToken, rippleCells.length, rippleIsClear])

  useEffect(() => {
    if (!failedPlacementPieceId && invalidDropCellIds.length === 0) return
    const timeout = window.setTimeout(() => {
      setFailedPlacementPieceId(null)
      setInvalidDropCellIds([])
    }, 480)
    return () => window.clearTimeout(timeout)
  }, [failedPlacementPieceId, invalidDropCellIds])

  useEffect(() => {
    if (goldenPopupCellIds.length === 0) return
    const tokenAtStart = goldenPopupToken
    const timeout = window.setTimeout(() => {
      setGoldenPopupCellIds((prev) =>
        tokenAtStart === goldenPopupToken ? [] : prev,
      )
    }, 900)
    return () => window.clearTimeout(timeout)
  }, [goldenPopupCellIds, goldenPopupToken])

  useEffect(() => {
    if (!scorePopup) return
    const currentId = scorePopupId
    const timeout = window.setTimeout(() => {
      setScorePopup((prev) => (currentId === scorePopupId ? null : prev))
    }, 2600)
    return () => window.clearTimeout(timeout)
  }, [scorePopup, scorePopupId])

  useEffect(() => {
    if (!ftueHint) return
    if (ftueHint.kind === 'hold' || ftueHint.kind === 'undo') return
    const timeout = window.setTimeout(() => {
      setFtueHint((prev) => (prev?.kind === ftueHint.kind ? null : prev))
    }, 5200)
    return () => window.clearTimeout(timeout)
  }, [ftueHint])

  useEffect(() => {
    if (!game.gameOver) return

    if (game.mode === 'daily' && game.dailyCompleted) {
      const moves = game.moves
      setPendingDailyMoves(moves)
      // For daily mode, always allow the player to log the result.
      setPendingDailyHighScore(!dailyHighScoreSaved)

      // Track the best (lowest) move count for the puzzle the run
      // belongs to. The HUD's "Best" readout derives from
      // lifetimeStats.dailyBestMovesByDate (updated by
      // foldRunIntoLifetime below), so we only need to keep the
      // legacy `cubic-daily-best-<dateKey>` localStorage entry in
      // sync here for the calendar fallback path and any
      // pre-stats-map clients.
      if (typeof window !== 'undefined') {
        const todayKey = getTodayKey()
        const runDateKey = game.dailyDateKey ?? todayKey
        const prevRaw = window.localStorage.getItem(
          `cubic-daily-best-${runDateKey}`,
        )
        const prevNum = prevRaw ? Number.parseInt(prevRaw, 10) : NaN
        const prev = Number.isFinite(prevNum) ? prevNum : null
        if (prev === null || moves < prev) {
          window.localStorage.setItem(
            `cubic-daily-best-${runDateKey}`,
            String(moves),
          )
        }
      }
    } else if (game.mode === 'endless') {
      const score = game.score
      setPendingScore(score)
      setPendingHighScore(
        !highScoreSaved && qualifiesForHighScore(score, highScores),
      )
    }
  }, [
    game.gameOver,
    game.mode,
    game.score,
    game.moves,
    game.dailyCompleted,
    highScores,
    highScoreSaved,
    dailyHighScores,
    dailyHighScoreSaved,
  ])

  // Whenever the high score modal is opened, reset the viewed daily
  // scores date back to today.
  useEffect(() => {
    if (showHighScores) {
      setDailyScoresDateKey(getTodayKey())
    }
  }, [showHighScores])

  // Snap the calendar back to the player's current daily month
  // every time the history modal opens. Without this, paging back
  // through past months and then closing would cause the next open
  // to start on whatever month the player happened to have left it
  // on — feels broken when "today" isn't visible.
  useEffect(() => {
    if (showDailyHistory) {
      const focus = game.dailyDateKey ?? getTodayKey()
      const parts = focus.split('-')
      const y = Number(parts[0])
      const m = Number(parts[1])
      if (Number.isFinite(y) && Number.isFinite(m)) {
        setHistoryMonth({ year: y, month: m })
      }
    }
  }, [showDailyHistory, game.dailyDateKey])

  // Snap every leaderboard tab back to page 0 whenever the
  // underlying entry list identity changes — re-opening the modal,
  // flipping the global toggle, or stepping the daily date all
  // swap the data the lists are reading from, so the previous page
  // index is meaningless. (The page-state itself is declared up
  // near the high-scores tab state; only the reset effect lives
  // here, where its dependencies are in scope.)
  useEffect(() => {
    setHighScorePages({ endless: 0, daily: 0, coop: 0, pvp: 0 })
  }, [showHighScores, showGlobalLeaderboard, dailyScoresDateKey, pvpSortBy])

  // Persist the current game state on every change so that a refresh
  // resumes exactly where the player left off. Each mode owns its own
  // localStorage slot, plus we record which mode is active so reload
  // knows which slot to read first. The React `savedXxxGame` mirror
  // for the active mode is kept in lockstep so toggling modes mid-
  // session never sees stale state.
  useEffect(() => {
    if (typeof window === 'undefined') return
    // The room owns the source of truth in MP mode; mirroring it back to
    // localStorage would clobber the player's offline single-player save.
    if (isMultiplayer) return
    // The first-launch tutorial isn't a "real" game state — persisting
    // it would mean a mid-tutorial refresh resumes inside the canned
    // board instead of re-triggering the guided opening cleanly. The
    // completion flag is set once the tutorial actually ends, and the
    // post-exit endless state is what we want persisted.
    if (tutorialStage > 0) return
    try {
      const envelope: PersistedGameEnvelope = {
        version: 1,
        mode: game.mode,
        game,
        dateKey: game.mode === 'daily' ? getTodayKey() : undefined,
        // Switching modes leaves the in-memory stack pointing at the prior
        // run's snapshots; filtering by mode keeps a slot from ever caching
        // another mode's undo history.
        undo: undoStack.filter((entry) => entry.mode === game.mode),
      }
      window.localStorage.setItem(
        PERSIST_KEY_BY_MODE[game.mode],
        JSON.stringify(envelope),
      )
      window.localStorage.setItem(ACTIVE_MODE_KEY, game.mode)
    } catch {
      // Best-effort persistence; ignore quota/serialization errors.
    }
    if (game.mode === 'endless') setSavedEndlessGame(game)
    else if (game.mode === 'daily') setSavedDailyGame(game)
    else if (game.mode === 'big') setSavedBigGame(game)
  }, [game, isMultiplayer, tutorialStage, undoStack])

  const handleSaveHighScore = () => {
    if (pendingScore === null) return
    const name = playerName.trim() || 'Player'
    const entry: HighScoreEntry = {
      name,
      score: pendingScore,
      date: Date.now(),
    }
    const next = [...highScores, entry]
      .sort((a, b) => b.score - a.score || a.date - b.date)
      .slice(0, LOCAL_ENDLESS_CAP)
    setHighScores(next)
    setLastSavedHighScoreDate(entry.date)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('cubic-highscores', JSON.stringify(next))
      window.localStorage.setItem('cubic-player-name', name)
    }
    setPendingHighScore(false)
    setHighScoreSaved(true)
    // Only mirror to the global leaderboard when this run is the new
    // local #1 — i.e. it's the top of `next` after re-sorting. The
    // server upserts on playerId so re-firing on a non-best run
    // would be wasteful (and would arguably leak score floor data
    // we shouldn't push). The first row in `next` is the highest
    // because we sorted descending by score above.
    const top = next[0]
    const isNewLocalBest =
      top !== undefined &&
      top.score === entry.score &&
      top.date === entry.date
    if (isNewLocalBest) {
      submitEndlessGlobal({
        playerId,
        name,
        score: entry.score,
        savedAt: entry.date,
      }).catch(() => {})
    }
  }

  // Construct the share text shown by the daily gameover's "Copy
  // Share" affordance. Aim: brief, eye-catching, self-contained.
  // Lines are intentionally short so the result reads cleanly in any
  // text field / chat input / status update.
  //
  //   🧊 Cubekill Daily · May 22, 2026
  //   ✓ Solved in 14 moves
  //   🏆 New personal best!
  //   https://cubekill.example
  //
  // Lost runs swap the second line for a cubes-remaining summary and
  // drop the trophy line. The URL line is omitted in SSR / non-
  // browser contexts.
  const buildDailyShareText = (): string => {
    const dateKey = game.dailyDateKey ?? getTodayKey()
    // Parse the YYYY-MM-DD key into a UTC date so the local Date
    // constructor doesn't reinterpret it in the player's tz and
    // shift the month/day across DST or international date lines.
    const [yyyy, mm, dd] = dateKey.split('-').map((p) => Number(p))
    let dateLabel = dateKey
    if (
      Number.isFinite(yyyy) &&
      Number.isFinite(mm) &&
      Number.isFinite(dd)
    ) {
      const utc = new Date(Date.UTC(yyyy, mm - 1, dd))
      try {
        dateLabel = new Intl.DateTimeFormat('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(utc)
      } catch {
        dateLabel = dateKey
      }
    }

    const lines: string[] = [`🧊 Cubekill Daily · ${dateLabel}`]
    if (game.dailyCompleted) {
      lines.push(`✓ Solved in ${game.moves} moves`)
      // "Personal best" detection works pre- and post-save: prior to
      // saving, currentDailyBestMoves is the old best (so a strictly
      // better run satisfies game.moves < prev). Post-save the best
      // has already moved down to game.moves, so game.moves <= best
      // still holds. First-ever attempt: best is null → treated as a
      // PB. Pure under-par runs (game.moves > old best) drop through
      // and surface the best as a comparison instead.
      const best = currentDailyBestMoves
      if (best === null || game.moves <= best) {
        lines.push('🏆 New personal best!')
      } else {
        lines.push(`(best: ${best} moves)`)
      }
    } else {
      const remaining = dailyCubesRemaining
      if (remaining > 0) {
        lines.push(
          `${remaining} ${remaining === 1 ? 'cube' : 'cubes'} remained after ${game.moves} moves`,
        )
      } else {
        lines.push(`${game.moves} moves used`)
      }
    }
    if (typeof window !== 'undefined' && window.location?.origin) {
      lines.push(window.location.origin)
    }
    return lines.join('\n')
  }

  // Copy the share text to the clipboard, with a soft "Copied!"
  // confirmation that auto-clears so the same button can be used to
  // re-copy (e.g. after switching to a different chat target). We
  // swallow clipboard errors silently — the only failure mode is
  // "no permission" and surfacing an error would be more noise than
  // value here; the button just doesn't flip its label.
  const handleCopyDailyShare = async () => {
    try {
      const text = buildDailyShareText()
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text)
      } else {
        // Fallback for clipboard-blocked contexts (older Safari, some
        // PWA shells): drop into a hidden textarea + execCommand.
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try {
          document.execCommand('copy')
        } finally {
          document.body.removeChild(ta)
        }
      }
      setDailyShareCopied(true)
      window.setTimeout(() => setDailyShareCopied(false), 1800)
    } catch {
      // Silent fail — clipboard permissions denied or DOM unavailable.
    }
  }

  const handleSaveDailyHighScore = () => {
    if (pendingDailyMoves === null) return
    const name = playerName.trim() || 'Player'
    // Route this save to whichever calendar day this run is for.
    // Today's runs hit `cubic-daily-runs-<today>`; an archive replay
    // (history-calendar pick) hits the day it was started on, even
    // if the run wraps over midnight on the player's clock.
    const runDateKey = game.dailyDateKey ?? getTodayKey()
    const entry: DailyHighScoreEntry = {
      name,
      moves: pendingDailyMoves,
      date: Date.now(),
    }
    const next = [...dailyHighScores, entry]
      .sort((a, b) => a.moves - b.moves || a.date - b.date)
      .slice(0, 5)
    setDailyHighScores(next)
    setLastSavedDailyHighScoreDate(entry.date)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(
        'cubic-daily-highscores',
        JSON.stringify(next),
      )
      const existingRuns = loadDailyRunsForDateKey(runDateKey)
      const nextRuns = [...existingRuns, entry].slice(-50)
      window.localStorage.setItem(
        `${DAILY_PLAYER_RUNS_PREFIX}${runDateKey}`,
        JSON.stringify(nextRuns),
      )
      window.localStorage.setItem('cubic-player-name', name)
    }
    setDailyRunsToken((t) => t + 1)
    setPendingDailyHighScore(false)
    setDailyHighScoreSaved(true)
    // Mirror to the global daily leaderboard whenever this run is a
    // new local best for its dateKey — regardless of whether the
    // run was today's puzzle or an archive replay. The global server
    // upsert is keyed on (playerId, dateKey) and only accepts
    // strictly-better moves, so historical bests overwrite older
    // submissions safely and a slower replay is a silent no-op.
    const dayRuns = [
      ...loadDailyRunsForDateKey(runDateKey),
      entry,
    ].sort((a, b) => a.moves - b.moves || a.date - b.date)
    const top = dayRuns[0]
    const isNewLocalBestForDay =
      top !== undefined &&
      top.moves === entry.moves &&
      top.date === entry.date
    if (isNewLocalBestForDay) {
      submitDailyGlobal({
        playerId,
        name,
        moves: entry.moves,
        dateKey: runDateKey,
        savedAt: entry.date,
      }).catch(() => {})
    }
  }

  const handleResetHighScores = () => {
    setHighScores([])
    setPendingHighScore(false)
    setPendingScore(null)
    setHighScoreSaved(false)
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('cubic-highscores')
      window.localStorage.removeItem('cubic-daily-highscores')
      window.localStorage.removeItem(`${DAILY_PLAYER_RUNS_PREFIX}${getTodayKey()}`)
      window.localStorage.removeItem(COOP_HIGH_SCORES_KEY)
    }
    setDailyHighScores([])
    setDailyRunsToken((t) => t + 1)
    setPendingDailyHighScore(false)
    setPendingDailyMoves(null)
    setDailyHighScoreSaved(false)
    setCoopHighScores([])
    setLastCoopSavedGroupKey(null)
    setLastCoopSavedScore(null)
    setShowResetConfirm(false)
  }

  useEffect(() => {
    // True iff the given client-space point lies inside the live ×
    // marker rect for the current drag. The marker is sized via CSS
    // (50% × 50% of its slot, centered); we read its real rect off
    // the DOM rather than recomputing the inset in JS so the visual
    // and the hit-test can never drift.
    //
    // Why a small centered hit-zone, not the whole slot or hand bar:
    // pieces drag with a touch-offset preview, and on the big board
    // the bottom row of cells lines up close to the hand. A larger
    // cancel zone makes those bottom cells unreachable when the
    // player tries to place there.
    const isPointOverCancelMark = (
      clientX: number,
      clientY: number,
    ): boolean => {
      const node = cancelMarkRef.current
      if (!node) return false
      const r = node.getBoundingClientRect()
      return (
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom
      )
    }

    // Hit-test the Hold pocket. Used as a drop target whenever a hand
    // piece is being dragged (and to no-op when the held piece is
    // dragged back over itself).
    const isPointOverHoldSlot = (
      clientX: number,
      clientY: number,
    ): boolean => {
      const node = holdSlotRef.current
      if (!node) return false
      const r = node.getBoundingClientRect()
      return (
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom
      )
    }

    // Hit-test the hand row. Returns the slot index (0..N-1) under
    // the point, or -1 if the point isn't over any hand button. Used
    // to drop a held piece into a hand slot (swap or pull).
    const findHandSlotAtPoint = (
      clientX: number,
      clientY: number,
    ): number => {
      const refs = handButtonRefs.current
      for (let i = 0; i < refs.length; i++) {
        const node = refs[i]
        if (!node) continue
        const r = node.getBoundingClientRect()
        if (
          clientX >= r.left &&
          clientX <= r.right &&
          clientY >= r.top &&
          clientY <= r.bottom
        ) {
          return i
        }
      }
      return -1
    }

    const updateFromClientPoint = (clientX: number, clientY: number) => {
      if (!dragState.current.pieceId) return
      const wrapper = boardWrapperRef.current
      if (!wrapper) return
      const rect = wrapper.getBoundingClientRect()
      const x = (clientX - rect.left) / scale
      const y = (clientY - rect.top) / scale
      setGhost((prev) => (prev ? { ...prev, x, y } : prev))

      // Identify the source of the in-flight piece (hand vs hold) so
      // we can hit-test the right set of drop targets and show
      // matching affordances. Pieces dragged out of hand can swap
      // into the hold pocket; pieces dragged out of hold can swap
      // into any hand slot.
      const draggedId = dragState.current.pieceId
      const draggedFromHold =
        game.hold != null && game.hold.id === draggedId

      // While the cursor sits over the × cancel marker, kill the
      // on-board preview entirely so cells don't light up behind the
      // held piece.
      if (isPointOverCancelMark(clientX, clientY)) {
        setHover(null)
        setHoldDropActive(false)
        setHandSwapTargetSlot(null)
        return
      }

      // Hand → hold drop affordance: highlight the hold pocket when
      // the cursor is over it (excluding the self-overlap when the
      // hold piece is being dragged over its own slot).
      if (
        !draggedFromHold &&
        isPointOverHoldSlot(clientX, clientY)
      ) {
        setHover(null)
        setHoldDropActive(true)
        setHandSwapTargetSlot(null)
        return
      }
      setHoldDropActive(false)

      // Hold → hand drop affordance: only meaningful when the source
      // is the held piece. Highlight whichever hand slot the cursor
      // is over so the player can see the swap target clearly.
      if (draggedFromHold) {
        const slot = findHandSlotAtPoint(clientX, clientY)
        if (slot >= 0) {
          setHover(null)
          setHandSwapTargetSlot(slot)
          return
        }
      }
      setHandSwapTargetSlot(null)

      const isTouch = dragState.current.pointerType === 'touch'
      const previewOffsetY = isTouch ? 80 : 0
      const cellId = findClosestCellIdFromClientPoint(
        clientX,
        clientY - previewOffsetY,
      )
      if (cellId) {
        setHover({ cellId })
      } else {
        setHover(null)
      }
    }

    const finishDragAtPoint = (clientX: number | null, clientY: number | null) => {
      if (!dragState.current.pieceId) return
      const isTouch = dragState.current.pointerType === 'touch'
      const previewOffsetY = isTouch ? 80 : 0

      // Released over the × cancel marker — cancel the drag silently.
      // No placement attempt, no error shake, no preview-cell snap.
      // We still play the soft click_up so the gesture sounds
      // completed.
      const releasedOverCancelMark =
        clientX !== null &&
        clientY !== null &&
        isPointOverCancelMark(clientX, clientY)

      const pieceId = dragState.current.pieceId
      const draggedFromHold =
        pieceId !== null &&
        game.hold != null &&
        game.hold.id === pieceId

      // Drop-target hit-tests for the new hold/hand swap surfaces.
      // These take priority over the board placement path because they
      // sit visually below it in the layout (the hand row), and any
      // release with the cursor sitting over them should be a swap,
      // not a closest-board-cell snap. We deliberately exclude the
      // self-overlap case (releasing the held piece back onto its own
      // pocket) which falls through to a silent cancel.
      const releasedOverHoldSlot =
        !releasedOverCancelMark &&
        !draggedFromHold &&
        clientX !== null &&
        clientY !== null &&
        isPointOverHoldSlot(clientX, clientY)
      const releasedOverHandSlot =
        !releasedOverCancelMark &&
        draggedFromHold &&
        clientX !== null &&
        clientY !== null
          ? findHandSlotAtPoint(clientX, clientY)
          : -1

      let cellId: string | null = null
      if (
        !releasedOverCancelMark &&
        !releasedOverHoldSlot &&
        releasedOverHandSlot < 0
      ) {
        cellId = hover?.cellId ?? null
        if (!cellId && clientX !== null && clientY !== null) {
          cellId = findClosestCellIdFromClientPoint(
            clientX,
            clientY - previewOffsetY,
          )
        }
      }
      // Compute the full attempted footprint for visual feedback even if
      // placement turns out to be invalid. Source can be hand OR hold.
      let attemptedCellIds: string[] | undefined
      if (cellId && pieceId) {
        const piece =
          game.hand.find((p) => p.id === pieceId) ??
          (game.hold && game.hold.id === pieceId ? game.hold : null)
        if (piece) {
          const previewForDrop = getBestPlacementPreview(cellId, piece, game)
          attemptedCellIds = previewForDrop?.targetIds
        }
      }
      dragState.current.pointerId = null
      dragState.current.pieceId = null
      dragState.current.pointerType = null
      setDraggingPieceId(null)
      setGhost(null)
      setHoldDropActive(false)
      setHandSwapTargetSlot(null)

      // The player set the piece down — fire the drop click regardless
      // of whether the placement was actually valid (or whether they
      // dropped it back into the cancel slot).
      playClickUp()

      if (releasedOverHoldSlot && pieceId) {
        dismissActionFtueHint()
        handleHoldSwap(pieceId, { kind: 'hold' })
        setSelectedPieceId(null)
      } else if (releasedOverHandSlot >= 0 && pieceId) {
        dismissActionFtueHint()
        handleHoldSwap(pieceId, {
          kind: 'hand',
          slotIndex: releasedOverHandSlot,
        })
        setSelectedPieceId(null)
      } else if (cellId && pieceId) {
        placePieceAtCell(pieceId, cellId, attemptedCellIds)
        // Drag-based placement is one-shot: after the player lifts off
        // the board (success or fail) we deselect so the on-board hover
        // preview stops tracking the cursor. Without this, a failed
        // drop leaves the piece "stuck" to the mouse on desktop because
        // selectedPieceId is still set and any subsequent
        // onMouseEnter on a cell re-renders the placement preview.
        // The click-to-select workflow goes through handleCellClick
        // instead, which intentionally keeps the selection alive so the
        // player can keep tapping cells.
        setSelectedPieceId(null)
      } else if (releasedOverCancelMark) {
        // Drag-cancel: also drop the click-to-select state so the next
        // pointer-down on the same piece reads as a fresh pickup
        // instead of a follow-up placement at the closest cell.
        setSelectedPieceId(null)
      }
      setHover(null)
    }

    // Pointer Events (browsers that support them well)
    const handlePointerMove = (e: PointerEvent) => {
      if (!dragState.current.pieceId) return
      updateFromClientPoint(e.clientX, e.clientY)
    }

    const handlePointerUp = (e: PointerEvent) => {
      finishDragAtPoint(e.clientX, e.clientY)
    }

    // Mouse fallback (for browsers where PointerEvents are flaky)
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragState.current.pieceId) return
      // Only use this path for mouse-based drags.
      if (
        dragState.current.pointerType &&
        dragState.current.pointerType !== 'mouse'
      ) {
        return
      }
      updateFromClientPoint(e.clientX, e.clientY)
    }

    const handleMouseUp = (e: MouseEvent) => {
      if (!dragState.current.pieceId) return
      if (
        dragState.current.pointerType &&
        dragState.current.pointerType !== 'mouse'
      ) {
        return
      }
      finishDragAtPoint(e.clientX, e.clientY)
    }

    // Touch fallback (in case some Firefox builds send only touch events)
    const handleTouchMove = (e: TouchEvent) => {
      if (!dragState.current.pieceId) return
      const touch = e.touches[0]
      if (!touch) return
      if (
        dragState.current.pointerType &&
        dragState.current.pointerType !== 'touch'
      ) {
        return
      }
      updateFromClientPoint(touch.clientX, touch.clientY)
    }

    const handleTouchEnd = (e: TouchEvent) => {
      if (!dragState.current.pieceId) return
      const touch =
        e.changedTouches[0] || e.touches[0] || null
      if (touch) {
        finishDragAtPoint(touch.clientX, touch.clientY)
      } else {
        finishDragAtPoint(null, null)
      }
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('touchmove', handleTouchMove, { passive: false })
    window.addEventListener('touchend', handleTouchEnd)
    window.addEventListener('touchcancel', handleTouchEnd)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleTouchEnd)
      window.removeEventListener('touchcancel', handleTouchEnd)
    }
  }, [scale, hover])

  type StatDatum = {
    key: string
    label: string
    value: string
  }

  // Per-run summary card. Rendered on every gameover modal under
  // the score/save section. Hidden when the run has zero placements
  // (e.g. instant abandon) since "0 pieces / 0s" is just noise.
  //
  // History: this used to be a labeled section ("THIS RUN") with a
  // baseline strip on top and a separate moments ribbon underneath.
  // That stacked layout was a major contributor to the gameover
  // modal blowing past short-phone viewports. We've since merged
  // baseline + moments into a single horizontal ribbon and dropped
  // the section label — the modal context (FINAL SCORE header
  // above, leaderboard below) already tells the player what they
  // are looking at, and an extra header just steals vertical space.
  //
  // Note: we intentionally drop "Best clear" from the moments here.
  // The highlight reel directly above the recap is literally a
  // moving picture of that exact placement (with the +N overlay);
  // duplicating it as a static chip below felt like saying the
  // same thing twice.
  const renderRunStatsSection = () => {
    if (runStats.piecesPlaced === 0) return null
    const ribbon: StatDatum[] = [
      {
        key: 'time',
        label: 'Time',
        value: formatDuration(runStats.activePlayMs),
      },
      {
        key: 'pieces',
        label: 'Pieces',
        value: String(runStats.piecesPlaced),
      },
      {
        key: 'clears',
        label: 'Clears',
        value: String(runStats.patternsCleared),
      },
    ]
    // Rubies aren't a thing in daily mode (there's no ruby spawn /
    // capture loop on the fixed numbered-cube board), so hide the
    // "0 rubies" stat there — it just reads as a missing feature
    // rather than a meaningful zero.
    if (game.mode !== 'daily') {
      ribbon.push({
        key: 'rubies',
        label: 'Rubies',
        value: String(runStats.rubiesCleared),
      })
    }
    if (runStats.boardClears > 0) {
      ribbon.push({
        key: 'boards',
        label: 'Boards',
        value: String(runStats.boardClears),
      })
    }
    // Daily is move-ranked, not score-ranked: combos and points-per-
    // placement don't read as "achievements" there (the player isn't
    // chasing a high score, they're chasing fewest moves to clear the
    // numbered cubes). Hide the score/combo moments in daily so the
    // ribbon only surfaces things that actually matter for that mode.
    const showScoreMoments = game.mode !== 'daily'
    if (showScoreMoments && runStats.bestCombo >= 2) {
      ribbon.push({
        key: 'combo',
        label: 'Combo',
        value: `×${runStats.bestCombo}`,
      })
    }
    if (runStats.bestStreak > 0) {
      ribbon.push({
        key: 'streak',
        label: 'Streak',
        value: String(runStats.bestStreak),
      })
    }
    return (
      <div
        className="hexaclear-gameover-section hexaclear-run-recap"
        aria-label="Run summary"
      >
        <div className="hexaclear-run-strip">
          {ribbon.map((stat) => (
            <div key={stat.key} className="hexaclear-run-stat">
              <span className="hexaclear-run-stat-value">{stat.value}</span>
              <span className="hexaclear-run-stat-label">{stat.label}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Whenever the player has a dialog/menu surface up they have a
  // tap target available which will fire a click and unlock the
  // AudioContext via audio.ts's global gesture listener. In those
  // cases the "Tap to resume" overlay is redundant noise (and on
  // small modals, the overlay's z-index used to occlude the very
  // button the user was about to press to dismiss). Keep this list
  // in sync with the modal renders below — game-over modal renders
  // for all modes when `game.gameOver && !gameOverWindingDown`,
  // except daily which additionally hides when
  // `dailyGameOverDismissed` is true.
  const gameOverModalOpen =
    game.gameOver &&
    !gameOverWindingDown &&
    !(game.mode === 'daily' && dailyGameOverDismissed)
  const anyDialogOpen =
    showMenu ||
    showHighScores ||
    showScoring ||
    showStats ||
    showAccount ||
    showDailyHistory ||
    gameOverModalOpen

  // Octave classes are additive: at scoreOctave 3, the viewport
  // carries `octave-1 octave-2 octave-3`. This keeps the earlier
  // octaves' layers in place once they unlock.
  const octaveClasses: string[] = []
  for (let i = 1; i <= scoreOctave; i++) {
    octaveClasses.push(`octave-${i}`)
  }
  // Inline palette: tier > 0 pushes computed --cube-* / accent vars
  // onto the viewport so they cascade down through every cube,
  // preview, and partner-tint child. Tier 0 falls through to the
  // :root defaults (no inline style needed).
  const tierPaletteStyle = paletteForTier(scoreTier, scoreOctave, theme)
  const showTutorialEndScreen =
    game.mode === 'endless' && tutorialEndScreenPending && !dailyIntroSeen
  const audiusTrackOptions = useMemo(() => {
    const byId = new Map<string, AudiusTrack>()
    audiusTracks.forEach((track) => byId.set(track.id, track))
    audiusAlbumQueue?.tracks.forEach((track) => {
      if (!byId.has(track.id)) byId.set(track.id, track)
    })
    return [...byId.values()]
  }, [audiusAlbumQueue, audiusTracks])
  const selectedAudiusDeckTrack = audiusTrackOptions.find(
    (track) => track.id === audiusSelectedTrackId,
  )
  const audiusDeckBestValue =
    game.mode === 'daily'
      ? currentDailyBestMoves
      : game.mode === 'big'
        ? null
        : bestScore
  const audiusDeckLiveLabel = game.mode === 'daily' ? 'Cubes' : 'Score'
  const audiusDeckLiveValue =
    game.mode === 'daily' ? displayedCubesRemaining : game.score
  const audiusDeckTrackTitle =
    selectedAudiusDeckTrack?.title ?? 'Choose a track in Settings'
  const audiusDeckTrackArtistName =
    selectedAudiusDeckTrack?.user?.name ??
    selectedAudiusDeckTrack?.user?.handle ??
    'Audius'
  const audiusDeckTrackArtist = audiusAlbumQueue
    ? `${audiusDeckTrackArtistName} · ${audiusAlbumQueue.name}`
    : audiusDeckTrackArtistName
  const audiusProgressDuration =
    audiusPlaybackDuration > 0
      ? audiusPlaybackDuration
      : selectedAudiusDeckTrack?.duration ?? 0
  const audiusProgressValue = Math.min(
    Math.max(audiusPlaybackPosition, 0),
    Math.max(audiusProgressDuration, 0),
  )
  const audiusDeckArtworkUrl = selectedAudiusDeckTrack?.artwork ?? null
  const audiusDeckIsPlaying = audiusStatus === 'playing'
  // Elapsed-fill percentage for the custom scrubber. WebKit can't paint a
  // native progress fill, so we feed this into a CSS gradient on the track.
  const audiusProgressPct =
    audiusProgressDuration > 0
      ? Math.min(100, Math.max(0, (audiusProgressValue / audiusProgressDuration) * 100))
      : 0
  const audiusTitleCardPeeking =
    audiusTitleCardCollapsed && audiusAutoTitleTrackId != null
  const audiusPreviousTrack = getAdjacentAudiusTrack(-1)
  const audiusNextTrack = getAdjacentAudiusTrack(1)
  const audiusAlbumResolving = audiusAlbumResolveStatus === 'resolving'
  const audiusAlbumResolved = audiusAlbumResolveStatus === 'resolved'
  const audiusPreviousDisabled =
    !selectedAudiusDeckTrack ||
    audiusStatus === 'loading' ||
    audiusAlbumResolving ||
    (audiusAlbumResolved && !audiusPreviousTrack)
  const audiusNextDisabled =
    !selectedAudiusDeckTrack ||
    audiusStatus === 'loading' ||
    audiusAlbumResolving ||
    (audiusAlbumResolved && !audiusNextTrack)
  useLayoutEffect(() => {
    const frame = audiusTrackTitleFrameRef.current
    const text = audiusTrackTitleTextRef.current
    if (!frame || !text) {
      setAudiusTrackTitleScrollPx(0)
      return
    }

    const measure = () => {
      const overflow = Math.ceil(text.scrollWidth - frame.clientWidth)
      setAudiusTrackTitleScrollPx(overflow > 4 ? overflow : 0)
    }
    measure()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    observer.observe(text)
    return () => observer.disconnect()
  }, [audiusDeckTrackTitle, audiusTitleCardCollapsed, audiusTitleCardPeeking])
  const audiusRepeatLabel =
    audiusRepeatMode === 'album'
      ? 'Repeat album'
      : audiusRepeatMode === 'track'
        ? 'Repeat track'
        : 'Repeat off'
  return (
    <div
      className={[
        'cubic-viewport',
        hitstop ? 'hitstop' : '',
        dealInActive ? 'is-dealing-in' : '',
        dealInActive && !reducedMotion && !announceLanded
          ? 'is-announce-flying'
          : '',
        livenessEnabled ? 'is-liveness' : '',
        criticalActive ? 'is-critical' : '',
        reducedMotion ? 'reduced-motion' : '',
        colorblindSupport ? 'is-colorblind' : '',
        tutorialStage > 0 ? 'is-tutorial-active' : '',
        theme === 'audius' ? 'is-audius-visualizer' : '',
        ...octaveClasses,
      ]
        .filter(Boolean)
        .join(' ')}
      data-score-tier={scoreTier}
      data-score-octave={scoreOctave}
      style={tierPaletteStyle}
      onDragStart={(e) => {
        e.preventDefault()
      }}
    >
      <div className="hexaclear-root" ref={rootRef}>
      <audio
        ref={audiusAudioRef}
        className="hexaclear-audius-audio"
        crossOrigin="anonymous"
        onPlay={() => setAudiusStatus('playing')}
        onPause={() => setAudiusStatus((s) => (s === 'playing' ? 'paused' : s))}
        onTimeUpdate={(e) => {
          const audio = e.currentTarget
          setAudiusPlaybackPosition(
            Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
          )
        }}
        onDurationChange={(e) => {
          const audio = e.currentTarget
          setAudiusPlaybackDuration(
            Number.isFinite(audio.duration) ? audio.duration : 0,
          )
        }}
        onLoadedMetadata={(e) => {
          const audio = e.currentTarget
          setAudiusPlaybackDuration(
            Number.isFinite(audio.duration) ? audio.duration : 0,
          )
        }}
        onEnded={() => {
          void playNextAudiusAlbumTrack()
        }}
        onError={() => {
          if (theme !== 'audius') return
          const failedTrackId = audiusSelectedTrackId
          if (failedTrackId) {
            audiusFailedStreamIdsRef.current.add(failedTrackId)
            const fallback = getFallbackAudiusTrack(failedTrackId)
            if (fallback) {
              void playAudiusTrack(fallback.id, {
                resolveAlbum: false,
                fallbackOnError: false,
              })
              return
            }
          }
          setAudiusStatus('error')
          setAudiusError('Audius playback failed for this track.')
        }}
      />
      {theme === 'audius' && showAudiusSearch && (
        <div
          className="hexaclear-audius-search-window-backdrop"
          role="presentation"
        >
          <section
            className="hexaclear-audius-search-window"
            role="dialog"
            aria-modal="true"
            aria-label="Search Audius tracks"
          >
            <div className="hexaclear-audius-search-window-head">
              <div>
                <span className="track-label">Audius Library</span>
                <h2>Search tracks</h2>
              </div>
              <button
                type="button"
                className="hexaclear-audius-window-close"
                onClick={() => {
                  playUiClick()
                  setShowAudiusSearch(false)
                }}
              >
                Close
              </button>
            </div>
            <div className="hexaclear-audius-search-row">
              <input
                className="hexaclear-audius-search"
                type="search"
                value={audiusSearchQuery}
                placeholder="Search Audius tracks"
                onChange={(e) => setAudiusSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  playUiClick()
                  void loadAudiusTracks(audiusSearchQuery)
                }}
                aria-label="Search Audius tracks"
              />
              <button
                type="button"
                className="hexaclear-menu-chip"
                onClick={() => {
                  playUiClick()
                  void loadAudiusTracks(audiusSearchQuery)
                }}
                disabled={audiusStatus === 'loading'}
              >
                Search
              </button>
            </div>
            <label className="hexaclear-audius-field">
              <span>Track</span>
              <select
                className="hexaclear-menu-settings-select"
                value={audiusSelectedTrackId ?? ''}
                onChange={(e) => {
                  audiusAlbumResolveTokenRef.current += 1
                  setAudiusAlbumQueue(null)
                  setAudiusAlbumResolveStatus('idle')
                  setAudiusAutoTitleTrackId(null)
                  setShowAudiusVolume(false)
                  setAudiusPlaybackPosition(0)
                  setAudiusPlaybackDuration(0)
                  setAudiusSelectedTrackId(e.target.value)
                  playUiClick()
                }}
                aria-label="Audius track"
              >
                {audiusTrackOptions.length === 0 ? (
                  <option value="">Load tracks...</option>
                ) : (
                  audiusTrackOptions.map((track) => (
                    <option key={track.id} value={track.id}>
                      {track.title}
                    </option>
                  ))
                )}
              </select>
            </label>
            <div className="hexaclear-audius-search-window-actions">
              <button
                type="button"
                className="hexaclear-menu-chip"
                onClick={() => {
                  playUiClick()
                  void playAudiusTrack()
                }}
                disabled={
                  audiusStatus === 'loading' || audiusTrackOptions.length === 0
                }
              >
                Play selected
              </button>
              <button
                type="button"
                className="hexaclear-menu-chip"
                onClick={() => {
                  playUiClick()
                  setShowAudiusSearch(false)
                }}
              >
                Done
              </button>
            </div>
            <p className="hexaclear-audius-meta">
              {selectedAudiusDeckTrack
                ? `${audiusDeckTrackArtist} · ${formatAudiusDuration(
                    selectedAudiusDeckTrack.duration,
                  )}`
                : 'Search Audius, choose a track, then press Play.'}
            </p>
            {audiusError && (
              <p className="hexaclear-audius-error">{audiusError}</p>
            )}
          </section>
        </div>
      )}
      {/* Win98 app titlebar — only visible when [data-theme="win98"] is
          active. Window controls are visual-only; closing/minimizing a
          web app doesn't make sense. Kept always-mounted so theme swaps
          are a single CSS reflow with no React reconciliation. */}
      <div className="hexaclear-win98-titlebar">
        <span className="title">Cubekill</span>
        <span className="title-controls" aria-hidden="true">
          <button
            type="button"
            className="title-control"
            tabIndex={-1}
            aria-label="Minimize"
          >
            <span className="glyph glyph-min" />
          </button>
          <button
            type="button"
            className="title-control"
            tabIndex={-1}
            aria-label="Maximize"
          >
            <span className="glyph glyph-max" />
          </button>
          <button
            type="button"
            className="title-control title-control-close"
            tabIndex={-1}
            aria-label="Close"
          >
            <span className="glyph glyph-close" />
          </button>
        </span>
      </div>
      {(() => {
        // Big mode is a playtest sandbox — its scores live on a
        // different scale than endless and would be confusing to mix
        // into endless's "Best" pill. Hide the best readout entirely
        // for big until it gets its own leaderboard.
        const bestValue =
          game.mode === 'daily'
            ? currentDailyBestMoves
            : game.mode === 'big'
            ? null
            : bestScore
        const showBest = bestValue !== null && bestValue !== undefined
        const dailyIsToday =
          game.mode === 'daily' &&
          (game.dailyDateKey ?? getTodayKey()) === getTodayKey()
        const bestLabelText =
          game.mode === 'daily'
            ? dailyIsToday
              ? 'Best (today)'
              : 'Best'
            : 'Best'
        const liveStatLabel = game.mode === 'daily' ? 'Cubes' : 'Score'
        const liveStatValue =
          game.mode === 'daily' ? displayedCubesRemaining : game.score
        const showLiveStat = true
        return (
          <header className="hexaclear-header">
            <div className="hexaclear-header-main">
              <div className="hexaclear-title">Cubekill</div>
              {/* Names for non-self players are now surfaced under
                  each smiley in the SmileyRow below; the singular
                  "{partner} Feels:" HUD has been retired. With 0
                  other seats, we still want a "waiting for partner"
                  affordance, which we render compactly above the
                  Cubekill title in MP. */}
              {isMultiplayer && mp.otherPlayers.length === 0 && (
                <div
                  className="hexaclear-coop-hud"
                  aria-label="Waiting for partner"
                >
                  Waiting for Partner
                </div>
              )}
              <div className="hexaclear-header-main-right">
                {showBest && (
                  <div className="hexaclear-best-banner">
                    <span className="label">{bestLabelText}</span>
                    <span className="value">{bestValue}</span>
                  </div>
                )}
                <button
                  type="button"
                  className="hexaclear-menu-button"
                  onClick={() => {
                    playUiClick()
                    /* Close every other overlay before raising the
                       pause menu. Without this, opening the menu
                       while e.g. the Daily History overlay is up
                       would stack the menu *behind* the open
                       overlay (both share `.hexaclear-overlay`'s
                       z-index). Treat the menu button as "switch
                       to the pause menu" rather than "additively
                       open it on top of whatever is showing". */
                    setShowDailyHistory(false)
                    setShowHighScores(false)
                    setShowStats(false)
                    setShowAccount(false)
                    setShowScoring(false)
                    setShowMenu(true)
                  }}
                >
                  <span className="hexaclear-menu-button-icon" aria-hidden="true">
                    ⚙️
                  </span>
                  <span className="hexaclear-menu-button-label">Menu</span>
                </button>
              </div>
            </div>
            <div className="hexaclear-header-controls">
              {isMultiplayer ? (
                <div className="hexaclear-mode-toggle hexaclear-mode-toggle-coop">
                  <span className="mode-pill active" aria-disabled="true">
                    Multi
                  </span>
                </div>
              ) : (
                <div className="hexaclear-mode-toggle">
                  <button
                    type="button"
                    className={[
                      'mode-pill',
                      game.mode === 'endless' ? 'active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      if (game.mode !== 'endless') {
                        playUiClick()
                        toggleMode('endless')
                      }
                    }}
                  >
                    Endless
                  </button>
                  <button
                    type="button"
                    className={[
                      'mode-pill',
                      game.mode === 'daily' ? 'active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      if (game.mode !== 'daily') {
                        playUiClick()
                        toggleMode('daily')
                      }
                    }}
                  >
                    Daily
                  </button>
                  <button
                    type="button"
                    className={[
                      'mode-pill',
                      game.mode === 'big' ? 'active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      if (game.mode !== 'big') {
                        playUiClick()
                        toggleMode('big')
                      }
                    }}
                  >
                    Multi
                  </button>
                </div>
              )}
              {/* Daily-mode "History" button. Lives in the same
                  controls-row slot the smiley row uses for co-op so
                  each mode has its own unique top-bar element. Tap
                  to open the calendar of past dailies (back to the
                  March 2026 launch date). The button also surfaces
                  the friendly date when the player is replaying an
                  archived puzzle, so it doubles as the "you are
                  playing this day" affordance. */}
              {!isMultiplayer && game.mode === 'daily' && (() => {
                const archive =
                  game.dailyDateKey !== undefined &&
                  game.dailyDateKey !== getTodayKey()
                return (
                  <button
                    type="button"
                    className={[
                      'hexaclear-history-button',
                      archive ? 'is-archive' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      playUiClick()
                      setShowDailyHistory(true)
                    }}
                  >
                    {archive && game.dailyDateKey
                      ? formatFriendlyDateKey(game.dailyDateKey)
                      : 'History'}
                  </button>
                )
              })()}
              {/* Wood theme renders the smiley row here in the
                  controls row. The Win98 theme renders a sibling
                  copy of the same SmileyRow inside the LCD row below
                  (gated by `theme === 'win98'`) — its `display:
                  contents` ancestors break the absolute-centering
                  anchor we need, so we explicitly mount it under a
                  `position: relative` parent there instead. */}
              {isMultiplayer && theme !== 'win98' && (
                <SmileyRow
                  show={showEmotePanel}
                  setShow={setShowEmotePanel}
                  selfPlayer={smileyRowSelfPlayer}
                  otherPlayers={smileyRowOtherPlayers}
                  activeEmoteByPlayerId={activeEmoteByPlayerId}
                  spectatorCount={mp.spectatorCount ?? 0}
                  onSend={(emoji) => {
                    playUiClick()
                    mp.sendEmote(emoji).catch(() => {
                      // The mutation can fail if a partner already
                      // left the room. We silently swallow it — the
                      // emote panel will close and life goes on.
                    })
                    setShowEmotePanel(false)
                  }}
                  onToggle={() => {
                    playUiClick()
                    setShowEmotePanel((s) => !s)
                  }}
                />
              )}
              {showLiveStat ? (
                <div
                  className={[
                    'hexaclear-live-stat',
                    tierPulseActive && game.mode !== 'daily'
                      ? 'is-tier-pulsing'
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <span className="label">{liveStatLabel}</span>
                  <span className="value">{liveStatValue}</span>
                  {tierPulseToken > 0 && game.mode !== 'daily' && (
                    // Score-tier transition pulse. Keyed on the
                    // monotonic token so each crossing remounts a
                    // fresh animation; positioned absolutely inside
                    // the live-stat block so the ring radiates out
                    // from the score number specifically. Hidden in
                    // daily mode (which doesn't tier on score).
                    // Carries `is-octave-pulse` when the crossing
                    // is a 5000-point octave milestone so the CSS
                    // can switch to a larger, longer variant.
                    <span
                      key={tierPulseToken}
                      className={[
                        'hexaclear-tier-pulse',
                        tierPulseVariant === 'octave'
                          ? 'is-octave-pulse'
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-hidden="true"
                    />
                  )}
                </div>
              ) : (
                <span className="hexaclear-live-stat-placeholder" />
              )}
            </div>
          </header>
        )
      })()}

      {/* Win98 LCD row — Minesweeper-style red 7-segment displays. Best
          on the left with its label tucked to the inside; Score on the
          right with its label tucked to the inside. Default to the
          authentic Minesweeper 3-digit width and grow naturally for
          larger values (4-digit when score hits 1000+, etc). */}
      {(() => {
        const rawBestValue =
          game.mode === 'daily'
            ? currentDailyBestMoves
            : game.mode === 'big'
            ? null
            : bestScore
        const liveStatLabel = game.mode === 'daily' ? 'Cubes' : 'Score'
        const liveStatValue =
          game.mode === 'daily' ? displayedCubesRemaining : game.score
        // Modes other than daily that don't have a recorded best
        // (Big / co-op, or a first-ever endless run) fall back to
        // the live score so the LCD doesn't read "---" — the slot
        // still reads as a reserved record area with its label
        // intact. Daily mode is intentionally not given this
        // fallback: if the player hasn't completed the daily puzzle
        // currently on screen, we display "---" so they can tell
        // that no personal best exists for that day yet.
        const bestValue =
          game.mode === 'daily' ? rawBestValue : rawBestValue ?? liveStatValue
        const bestLabel = 'Best'
        // 3 digits is the Minesweeper default; values >999 expand the
        // display naturally rather than truncating. The off-segment
        // ghost layer matches the active display length so all "8"s
        // align under whatever digits are showing.
        const padDigits = (n: number | null | undefined): string => {
          if (n === null || n === undefined) return '---'
          const num = Math.max(0, Math.floor(n))
          return String(num).padStart(3, '0')
        }
        const bestDigits = padDigits(bestValue)
        const liveDigits = padDigits(liveStatValue)
        return (
          <div className="hexaclear-win98-lcds">
            <div className="hexaclear-win98-lcd hexaclear-win98-lcd-best" aria-hidden="true">
              <span className="lcd-frame">
                <span className="lcd-digits-off">{'8'.repeat(bestDigits.length)}</span>
                <span className="lcd-digits">{bestDigits}</span>
              </span>
              <span className="lcd-label">{bestLabel}</span>
            </div>
            <div
              className={[
                'hexaclear-win98-lcd',
                'hexaclear-win98-lcd-score',
                tierPulseActive && game.mode !== 'daily'
                  ? 'is-tier-pulsing'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-hidden="true"
            >
              <span className="lcd-label">{liveStatLabel}</span>
              <span className="lcd-frame">
                <span className="lcd-digits-off">{'8'.repeat(liveDigits.length)}</span>
                <span className="lcd-digits">{liveDigits}</span>
              </span>
              {tierPulseToken > 0 && game.mode !== 'daily' && (
                <span
                  key={tierPulseToken}
                  className={[
                    'hexaclear-tier-pulse',
                    tierPulseVariant === 'octave' ? 'is-octave-pulse' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-hidden="true"
                />
              )}
            </div>
            {/* Win98 smiley row + emote panel. Sits centered between
                the two LCDs (Minesweeper layout). Conditional on
                theme so only one SmileyRow lives in the DOM at a
                time — keeps the outside-click detector unambiguous. */}
            {isMultiplayer && theme === 'win98' && (
              <SmileyRow
                show={showEmotePanel}
                setShow={setShowEmotePanel}
                selfPlayer={smileyRowSelfPlayer}
                otherPlayers={smileyRowOtherPlayers}
                activeEmoteByPlayerId={activeEmoteByPlayerId}
                spectatorCount={mp.spectatorCount ?? 0}
                onSend={(emoji) => {
                  playUiClick()
                  mp.sendEmote(emoji).catch(() => {})
                  setShowEmotePanel(false)
                }}
                onToggle={() => {
                  playUiClick()
                  setShowEmotePanel((s) => !s)
                }}
              />
            )}
          </div>
        )
      })()}

      <section
        className="hexaclear-audius-deck"
        aria-label="Music visualizer game controls"
        aria-hidden={theme !== 'audius'}
      >
        <div className="hexaclear-audius-brand">
          <span className="hexaclear-audius-brand-title">Cubekill</span>
        </div>
        <div className="hexaclear-audius-mode-bank">
          {isMultiplayer ? (
            <span className="hexaclear-audius-mode active" aria-disabled="true">
              Multi
            </span>
          ) : (
            <>
              <button
                type="button"
                className={[
                  'hexaclear-audius-mode',
                  game.mode === 'endless' ? 'active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  if (game.mode !== 'endless') {
                    playUiClick()
                    toggleMode('endless')
                  }
                }}
              >
                Endless
              </button>
              <button
                type="button"
                className={[
                  'hexaclear-audius-mode',
                  game.mode === 'daily' ? 'active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  if (game.mode !== 'daily') {
                    playUiClick()
                    toggleMode('daily')
                  }
                }}
              >
                Daily
              </button>
              <button
                type="button"
                className={[
                  'hexaclear-audius-mode',
                  game.mode === 'big' ? 'active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  if (game.mode !== 'big') {
                    playUiClick()
                    toggleMode('big')
                  }
                }}
              >
                Multi
              </button>
            </>
          )}
        </div>
        <div className="hexaclear-audius-readouts" aria-hidden="true">
          <div className="hexaclear-audius-readout">
            <span className="readout-label">Best</span>
            <span className="readout-value">{audiusDeckBestValue ?? '--'}</span>
          </div>
          <div
            className={[
              'hexaclear-audius-readout',
              'hexaclear-audius-readout-live',
              tierPulseActive && game.mode !== 'daily' ? 'is-tier-pulsing' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span className="readout-label">{audiusDeckLiveLabel}</span>
            <span className="readout-value">{audiusDeckLiveValue}</span>
            {tierPulseToken > 0 && game.mode !== 'daily' && (
              <span
                key={tierPulseToken}
                className={[
                  'hexaclear-tier-pulse',
                  tierPulseVariant === 'octave' ? 'is-octave-pulse' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              />
            )}
          </div>
        </div>
        <div className="hexaclear-audius-utility-row">
          <button
            type="button"
            className="hexaclear-audius-menu-button"
            onClick={() => {
              playUiClick()
              setShowDailyHistory(false)
              setShowHighScores(false)
              setShowStats(false)
              setShowAccount(false)
              setShowScoring(false)
              setShowMenu(true)
            }}
          >
            Menu
          </button>
          {!isMultiplayer && game.mode === 'daily' && (() => {
            const archive =
              game.dailyDateKey !== undefined &&
              game.dailyDateKey !== getTodayKey()
            return (
              <button
                type="button"
                className={[
                  'hexaclear-audius-history-button',
                  archive ? 'is-archive' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  playUiClick()
                  setShowDailyHistory(true)
                }}
              >
                {archive && game.dailyDateKey
                  ? formatFriendlyDateKey(game.dailyDateKey)
                  : 'History'}
              </button>
            )
          })()}
        </div>
      </section>

      <main className="hexaclear-main">
        {/* "You are spectating" banner. Surfaces when the viewer
            joined a PvP room after the first move and got parked on
            the spectator list. Sits just below the menu bar / above
            the PvP HUD so it's visible without competing for vertical
            space with the board itself. Co-op never produces
            spectators so this only ever appears in PvP. */}
        {isMultiplayer && mp.isSpectator && (
          <div
            className="hexaclear-spectator-banner"
            role="status"
            aria-live="polite"
          >
            <span className="hexaclear-spectator-banner-eye" aria-hidden="true">
              👁
            </span>
            <span className="hexaclear-spectator-banner-label">
              Spectating
            </span>
            {mp.spectatorCount > 1 && (
              <span
                className="hexaclear-spectator-banner-count"
                aria-label={`${mp.spectatorCount} watchers including you`}
              >
                · {mp.spectatorCount} watching
              </span>
            )}
          </div>
        )}
        {/* PvP territory HUD: one mini-track per seated player, all
            sharing the same horizontal scale. The threshold marker
            sits at the same x-position on every row so the "win
            line" is a continuous vertical line across the stack.
            That lets a single glance answer two questions that the
            old single-stacked-bar couldn't answer together:
              * vs. each other  → which row's fill is longest
              * vs. victory     → how far is each fill from the line
            The bar scale is normalized to roughly the threshold
            (plus a small headroom past it) so the win line sits
            near the right edge and the race feels meaningful even
            when nobody is close to 100% of the board. */}
        {isMultiplayer && mp.mode === 'pvp' && (() => {
          const standings = mp.pvpStandings
          const thresholdRatio = Math.min(1, mp.pvpThresholdRatio)
          const maxRatio = standings.reduce(
            (m, s) => Math.max(m, s.ratio),
            0,
          )
          // Visual scale headroom: 15% past the threshold for the win
          // line, 5% past the leading player so a placement that
          // overshoots the threshold still renders on-track.
          const scaleMaxRatio = Math.max(
            thresholdRatio * 1.15,
            maxRatio * 1.05,
            0.1,
          )
          const thresholdScalePct = (thresholdRatio / scaleMaxRatio) * 100
          const thresholdAbsPct = Math.round(thresholdRatio * 100)
          const selfId = mp.selfPlayer?.playerId ?? null
          const nameByPlayerId = new Map<string, string>()
          for (const p of mp.allPlayers) {
            nameByPlayerId.set(p.playerId, p.name)
          }
          // Track-fill color mirrors the player's cube color on the
          // board so the HUD and the field stay in sync per theme:
          //   * Wood: every player (incl. self) is a hue-shifted
          //     warm wood-cube color; self happens to land on hue 0
          //     and renders the unshifted gold.
          //   * Win98: self uses the deep teal fill that solo cubes
          //     wear, partners use the lighter teal partner-cube
          //     fill rotated by their assigned hue.
          const colorForPlayer = (pid: string): string => {
            const hue = mp.hueShiftByPlayerId[pid] ?? 0
            if (theme === 'win98') {
              return pid === selfId
                ? W98_SELF_FILL_HEX
                : tintCubeColor(W98_PARTNER_FILL_HEX, hue, 0, 1)
            }
            return tintCubeColor(WOOD_CUBE_LEFT_HEX, hue, 0.05, 0.95)
          }
          const ariaLabel =
            standings
              .map((s) => {
                const name =
                  s.playerId === selfId
                    ? 'You'
                    : nameByPlayerId.get(s.playerId) ?? 'Player'
                return `${name} ${Math.round(s.ratio * 100)}%`
              })
              .join(', ') || 'No territory yet'
          return (
            <div
              className="hexaclear-pvp-banner hexaclear-pvp-hud"
              aria-label={`Territory: ${ariaLabel}. Win at ${thresholdAbsPct}%.`}
            >
              <div
                className={[
                  'hexaclear-pvp-tracks',
                  mp.winnerPlayerId ? 'is-won' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                role="img"
                style={{
                  ['--pvp-threshold-pct' as string]: `${thresholdScalePct}%`,
                }}
              >
                {standings.map((s) => {
                  const name =
                    s.playerId === selfId
                      ? 'You'
                      : nameByPlayerId.get(s.playerId) ?? 'Player'
                  const color = colorForPlayer(s.playerId)
                  const fillPct = Math.max(
                    0,
                    Math.min(100, (s.ratio / scaleMaxRatio) * 100),
                  )
                  const isSelf = s.playerId === selfId
                  const isWinner = mp.winnerPlayerId === s.playerId
                  return (
                    <div
                      key={s.playerId}
                      className={[
                        'hexaclear-pvp-row',
                        isSelf ? 'is-self' : '',
                        isWinner ? 'is-winner' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <span
                        className="hexaclear-pvp-row-swatch"
                        style={{ background: color }}
                        aria-hidden="true"
                      />
                      <span className="hexaclear-pvp-row-name">{name}</span>
                      <div className="hexaclear-pvp-row-track">
                        <div
                          className="hexaclear-pvp-row-track-fill"
                          style={{
                            width: `${fillPct}%`,
                            background: color,
                          }}
                        />
                        <div
                          className="hexaclear-pvp-row-track-threshold"
                          aria-hidden="true"
                        />
                      </div>
                      <span className="hexaclear-pvp-row-pct">
                        {Math.round(s.ratio * 100)}%
                      </span>
                    </div>
                  )
                })}
              </div>
              <div className="hexaclear-pvp-win-tag" aria-hidden="true">
                Win at {thresholdAbsPct}%
              </div>
            </div>
          )
        })()}
        <div
          className={[
            'hexaclear-board-wrapper',
            // Desaturate "you lost" treatment only on losses. Daily wins
            // keep their colors (and get a gold-flash flourish instead).
            game.gameOver &&
            !(game.mode === 'daily' && game.dailyCompleted)
              ? 'game-over-active'
              : '',
            // Daily wins, after the player dismisses the celebration
            // modal: surface a persistent "Daily Cleared" badge so the
            // half-interactible board doesn't read like an in-progress
            // game the player just can't drop pieces into.
            game.mode === 'daily' &&
            game.dailyCompleted &&
            game.gameOver &&
            dailyGameOverDismissed
              ? 'daily-cleared-dismissed'
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{
            aspectRatio: `${boardLayout.width} / ${boardLayout.height}`,
          }}
          ref={boardWrapperRef}
        >
          {/* The carved-stone rose-window frame is retired: the glass theme
              now shows the masonry wall directly around the board, with the
              lit blue field clipped to the hex panes (see #glass-field-clip)
              so glass appears only WITHIN the cells. Component kept behind a
              flag for easy revert. */}
          {SHOW_GLASS_ROSE_FRAME && theme === 'glass' && <GlassRoseFrame />}
          {theme === 'audius' && !reducedMotion && (
            <canvas
              ref={audiusCanvasRef}
              className="hexaclear-audius-stage-canvas"
              aria-hidden="true"
            />
          )}
          <div className="hexaclear-audius-vu hexaclear-audius-vu-left" aria-hidden="true">
            <span className="vu-tick vu-bass" />
            <span className="vu-tick vu-mid" />
            <span className="vu-tick vu-treble" />
            <span className="vu-tick vu-onset" />
            <span className="vu-tick vu-intensity" />
            <span className="vu-tick vu-breath" />
          </div>
          <div className="hexaclear-audius-vu hexaclear-audius-vu-right" aria-hidden="true">
            <span className="vu-tick vu-breath" />
            <span className="vu-tick vu-intensity" />
            <span className="vu-tick vu-onset" />
            <span className="vu-tick vu-treble" />
            <span className="vu-tick vu-mid" />
            <span className="vu-tick vu-bass" />
          </div>
          <section
            className={[
              'hexaclear-audius-title-card',
              audiusTitleCardCollapsed && !audiusTitleCardPeeking
                ? 'is-collapsed'
                : '',
              audiusTitleCardPeeking ? 'is-peeking' : '',
              audiusDeckIsPlaying ? 'is-playing' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            aria-label="Music visualizer track"
            aria-hidden={theme !== 'audius'}
          >
            {audiusTitleCardPeeking ? (
              <button
                type="button"
                className="hexaclear-audius-title-peek"
                onClick={() => {
                  playUiClick()
                  setAudiusAutoTitleTrackId(null)
                  setAudiusTitleCardCollapsed(false)
                }}
              >
                <span className="track-label">Now playing</span>
                <span className="track-title">{audiusDeckTrackTitle}</span>
              </button>
            ) : (
              <>
                <div className="hexaclear-audius-np-header">
                  <div
                    className={[
                      'hexaclear-audius-artwork',
                      audiusDeckArtworkUrl ? 'has-art' : 'is-empty',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-hidden="true"
                  >
                    {audiusDeckArtworkUrl ? (
                      <img
                        src={audiusDeckArtworkUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onError={(e) => {
                          // CDN miss / gated art: drop the broken <img> so the
                          // placeholder disc shows through instead.
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                    ) : (
                      <svg
                        className="hexaclear-audius-artwork-glyph"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path d="M9 18V6l10-2v12" />
                        <circle cx="6.5" cy="18" r="2.5" />
                        <circle cx="16.5" cy="16" r="2.5" />
                      </svg>
                    )}
                    <span
                      className="hexaclear-audius-np-eq"
                      aria-label="Music visualizer levels"
                    >
                      <span className="spectrum-bar spectrum-bass" />
                      <span className="spectrum-bar spectrum-mid" />
                      <span className="spectrum-bar spectrum-treble" />
                      <span className="spectrum-bar spectrum-onset" />
                    </span>
                  </div>
                  <div className="hexaclear-audius-title-copy">
                    <span className="track-label">
                      <span
                        className="hexaclear-audius-np-dot"
                        aria-hidden="true"
                      />
                      Now playing
                    </span>
                    <span
                      ref={audiusTrackTitleFrameRef}
                      className={[
                        'track-title',
                        audiusTrackTitleScrollPx > 0 ? 'is-overflowing' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={
                        {
                          '--audius-title-scroll-distance': `${audiusTrackTitleScrollPx}px`,
                        } as React.CSSProperties
                      }
                    >
                      <span
                        ref={audiusTrackTitleTextRef}
                        className="track-title-text"
                      >
                        {audiusDeckTrackTitle}
                      </span>
                    </span>
                    <span className="track-artist">{audiusDeckTrackArtist}</span>
                  </div>
                  <button
                    type="button"
                    className="hexaclear-audius-title-toggle"
                    onClick={() => {
                      playUiClick()
                      setAudiusAutoTitleTrackId(null)
                      setShowAudiusVolume(false)
                      setAudiusTitleCardCollapsed((collapsed) => !collapsed)
                    }}
                    aria-expanded={!audiusTitleCardCollapsed}
                    aria-label={
                      audiusTitleCardCollapsed
                        ? 'Show now playing'
                        : 'Hide now playing'
                    }
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                </div>
                <label className="hexaclear-audius-progress">
                  <span className="hexaclear-audius-progress-elapsed">
                    {formatAudiusDuration(audiusProgressValue)}
                  </span>
                  <input
                    type="range"
                    min="0"
                    max={Math.max(1, Math.ceil(audiusProgressDuration))}
                    value={Math.round(audiusProgressValue)}
                    style={
                      {
                        '--audius-progress-pct': `${audiusProgressPct}%`,
                      } as React.CSSProperties
                    }
                    onChange={(e) => {
                      const next = Number(e.target.value)
                      const audio = audiusAudioRef.current
                      if (audio && Number.isFinite(next)) {
                        audio.currentTime = next
                      }
                      setAudiusPlaybackPosition(
                        Number.isFinite(next) ? next : 0,
                      )
                    }}
                    aria-label="Track progress"
                  />
                  <span className="hexaclear-audius-progress-total">
                    {formatAudiusDuration(audiusProgressDuration)}
                  </span>
                </label>
                <div className="hexaclear-audius-media-controls">
                  <div className="hexaclear-audius-media-button-row">
                    <div className="hexaclear-audius-primary-transport">
                      <button
                        type="button"
                        className={[
                          'hexaclear-audius-media-button',
                          audiusAlbumResolving ? 'is-resolving' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => {
                          playUiClick()
                          void playAdjacentAudiusTrack(-1)
                        }}
                        disabled={audiusPreviousDisabled}
                        aria-label="Previous track"
                      >
                        {audiusAlbumResolving ? (
                          <span className="hexaclear-audius-spinner" aria-hidden="true" />
                        ) : (
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M6 5v14" />
                            <path d="M19 6 9 12l10 6V6Z" />
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        className="hexaclear-audius-media-button is-primary is-play-pause"
                        onClick={() => {
                          playUiClick()
                          void toggleAudiusPlayPause()
                        }}
                        disabled={
                          audiusStatus === 'loading' ||
                          audiusTrackOptions.length === 0
                        }
                        aria-label={
                          audiusStatus === 'playing' ? 'Pause track' : 'Play track'
                        }
                      >
                        {audiusStatus === 'playing' ? (
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M8 5v14" />
                            <path d="M16 5v14" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M8 5.5 18 12 8 18.5V5.5Z" />
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        className={[
                          'hexaclear-audius-media-button',
                          audiusAlbumResolving ? 'is-resolving' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => {
                          playUiClick()
                          void playAdjacentAudiusTrack(1)
                        }}
                        disabled={audiusNextDisabled}
                        aria-label="Next track"
                      >
                        {audiusAlbumResolving ? (
                          <span className="hexaclear-audius-spinner" aria-hidden="true" />
                        ) : (
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M18 5v14" />
                            <path d="M5 6l10 6-10 6V6Z" />
                          </svg>
                        )}
                      </button>
                    </div>
                    <div className="hexaclear-audius-secondary-controls">
                      <button
                        type="button"
                        className={[
                          'hexaclear-audius-media-button',
                          'is-secondary',
                          'is-repeat',
                          audiusRepeatMode !== 'none' ? 'is-active' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => {
                          playUiClick()
                          cycleAudiusRepeatMode()
                        }}
                        aria-label={audiusRepeatLabel}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M7 7h8.4c2.2 0 4 1.8 4 4 0 1.2-.5 2.3-1.4 3.1" />
                          <path d="m16 4 3.4 3L16 10" />
                          <path d="M17 17H8.6c-2.2 0-4-1.8-4-4 0-1.2.5-2.3 1.4-3.1" />
                          <path d="m8 20-3.4-3L8 14" />
                          {audiusRepeatMode === 'track' && (
                            <text x="12" y="15" textAnchor="middle">
                              1
                            </text>
                          )}
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={[
                          'hexaclear-audius-media-button',
                          'is-secondary',
                          showAudiusVolume ? 'is-active' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={() => {
                          playUiClick()
                          setShowAudiusVolume((shown) => !shown)
                        }}
                        aria-label="Music volume"
                        aria-expanded={showAudiusVolume}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M5 9v6h4l6 4V5L9 9H5Z" />
                          <path d="M18 9.5c.8 1.4.8 3.6 0 5" />
                          <path d="M20.5 7c1.8 2.8 1.8 7.2 0 10" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className="hexaclear-audius-media-button is-secondary"
                        onClick={() => {
                          playUiClick()
                          setShowAudiusSearch(true)
                        }}
                        aria-label="Search Audius tracks"
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <circle cx="10.5" cy="10.5" r="5.5" />
                          <path d="m15 15 4.5 4.5" />
                        </svg>
                      </button>
                    </div>
                  </div>
                  {showAudiusVolume && (
                    <label className="hexaclear-audius-mini-volume">
                      <span>Volume</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={Math.round(audiusVolume * 100)}
                        onChange={(e) => {
                          setAudiusVolume(Number(e.target.value) / 100)
                        }}
                        aria-label="Audius music volume"
                      />
                    </label>
                  )}
                </div>
              </>
            )}
          </section>
          {previewTerritoryDelta && (() => {
            // PvP territory-delta chip. Floats above the board near
            // the top edge so it doesn't overlap the placement ghost
            // (which the player needs unobstructed). Sorted self-first
            // by the memo upstream. Hidden in co-op / SP.
            const selfId = mp.selfPlayer?.playerId ?? null
            const nameByPlayerId = new Map<string, string>()
            for (const p of mp.allPlayers) {
              nameByPlayerId.set(p.playerId, p.name)
            }
            const colorFor = (pid: string): string => {
              const hue = mp.hueShiftByPlayerId[pid] ?? 0
              if (theme === 'win98') {
                return pid === selfId
                  ? W98_SELF_FILL_HEX
                  : tintCubeColor(W98_PARTNER_FILL_HEX, hue, 0, 1)
              }
              return tintCubeColor(WOOD_CUBE_LEFT_HEX, hue, 0.05, 0.95)
            }
            return (
              <div
                className="hexaclear-pvp-delta-chip"
                role="status"
                aria-live="polite"
              >
                <span className="hexaclear-pvp-delta-chip-label">
                  Territory if cleared
                </span>
                <span className="hexaclear-pvp-delta-chip-row">
                  {previewTerritoryDelta.entries.map((entry, idx) => {
                    const isSelf = entry.playerId === selfId
                    const name = isSelf
                      ? 'You'
                      : nameByPlayerId.get(entry.playerId) ?? 'Player'
                    return (
                      <span
                        key={entry.playerId}
                        className={[
                          'hexaclear-pvp-delta-entry',
                          isSelf ? 'is-self' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {idx > 0 && (
                          <span className="hexaclear-pvp-delta-sep">·</span>
                        )}
                        <span
                          className="hexaclear-pvp-delta-swatch"
                          style={{ background: colorFor(entry.playerId) }}
                          aria-hidden="true"
                        />
                        <span className="hexaclear-pvp-delta-name">
                          {name}
                        </span>
                        <span className="hexaclear-pvp-delta-amount">
                          +{entry.count}
                        </span>
                      </span>
                    )
                  })}
                  {previewTerritoryDelta.unattributed > 0 && (
                    <span className="hexaclear-pvp-delta-entry is-unattributed">
                      <span className="hexaclear-pvp-delta-sep">·</span>
                      <span className="hexaclear-pvp-delta-name">
                        Neutral
                      </span>
                      <span className="hexaclear-pvp-delta-amount">
                        +{previewTerritoryDelta.unattributed}
                      </span>
                    </span>
                  )}
                </span>
              </div>
            )
          })()}
          <svg
            className="hexaclear-board"
            ref={svgRef}
            viewBox={`0 0 ${boardLayout.width} ${boardLayout.height}`}
          >
            <defs>
              {/* About-to-clear highlight for the music visualizer theme.
                  WebKit/iOS ignores CSS shorthand filter functions
                  (invert(), hue-rotate(), ...) on inner SVG elements like
                  <g>, so the CSS `filter: invert(1) ...` worked on desktop
                  but silently did nothing on mobile. A real SVG <filter>
                  referenced via filter: url(#...) is the natively supported
                  path on WebKit, so it renders on mobile too. The primitives
                  below reproduce invert(1) hue-rotate(180deg) saturate(2)
                  brightness(1.28) in sRGB (to match CSS filter semantics). */}
              {theme === 'audius' && (
                <filter
                  id="audius-clear-invert"
                  colorInterpolationFilters="sRGB"
                >
                  <feComponentTransfer>
                    <feFuncR type="table" tableValues="1 0" />
                    <feFuncG type="table" tableValues="1 0" />
                    <feFuncB type="table" tableValues="1 0" />
                  </feComponentTransfer>
                  <feColorMatrix type="hueRotate" values="180" />
                  <feColorMatrix type="saturate" values="2" />
                  <feComponentTransfer>
                    <feFuncR type="linear" slope="1.28" />
                    <feFuncG type="linear" slope="1.28" />
                    <feFuncB type="linear" slope="1.28" />
                  </feComponentTransfer>
                </filter>
              )}
              {/* Counter-rotation for the invalid-placement preview. The
                  board's CSS filter hue-rotates the whole cube layer by a
                  music-driven angle X (0–360°); this pre-rotates the preview
                  by -X (updated each analyser frame via
                  audiusInvalidCounterRef) so the two cancel and the danger
                  cue stays red instead of sweeping into green/blue. The
                  generous region keeps the non-scaling preview stroke from
                  being clipped by the filter box. */}
              {theme === 'audius' && (
                <filter
                  id="audius-invalid-counter"
                  colorInterpolationFilters="sRGB"
                  x="-50%"
                  y="-50%"
                  width="200%"
                  height="200%"
                >
                  <feColorMatrix
                    ref={audiusInvalidCounterRef}
                    type="hueRotate"
                    values="0"
                  />
                </filter>
              )}
              {/* Stained-glass depth kit. These primitives are what sell
                  the "real glass" read — they're referenced from
                  theme-glass.css via fill: url(#...) / filter: url(#...).
                  A real SVG <filter>/<gradient> is used (not CSS shorthand
                  filters) because WebKit/iOS ignores CSS filter functions on
                  inner SVG nodes — same reason the audius theme references
                  url(#audius-clear-invert). All are static (no animated
                  turbulence) so they render once and the browser caches the
                  result. */}
              {theme === 'glass' && (
                <>
                  {/* Diagonal specular sheen laid over each lit pane — a
                      bright streak fading to nothing, like a glaze catching
                      window light. Painted onto the per-face light overlay. */}
                  <linearGradient
                    id="glass-sheen"
                    x1="0%"
                    y1="0%"
                    x2="100%"
                    y2="100%"
                  >
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
                    <stop offset="34%" stopColor="#ffffff" stopOpacity="0.18" />
                    <stop offset="60%" stopColor="#ffffff" stopOpacity="0" />
                  </linearGradient>
                  {/* Inner pane luminance: a hot center falling to a dark
                      leaded rim, so each pane reads as lit from behind with
                      volume rather than a flat fill. */}
                  <radialGradient id="glass-inner-light" cx="50%" cy="42%" r="62%">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.55" />
                    <stop offset="46%" stopColor="#ffffff" stopOpacity="0.12" />
                    <stop offset="100%" stopColor="#000000" stopOpacity="0.32" />
                  </radialGradient>
                  {/* Pane volume: luminous center, darker thickness at the
                      leaded edge. This is intentionally stronger than a
                      decorative texture; it makes each hex read as glass
                      transmitting light instead of a flat colored tile. */}
                  <radialGradient id="glass-pane-depth" cx="46%" cy="38%" r="78%">
                    <stop offset="0%" stopColor="#fff9df" stopOpacity="0.34" />
                    <stop offset="36%" stopColor="#ffffff" stopOpacity="0.12" />
                    <stop offset="64%" stopColor="#ffffff" stopOpacity="0" />
                    <stop offset="84%" stopColor="#15120b" stopOpacity="0.22" />
                    <stop offset="100%" stopColor="#050402" stopOpacity="0.48" />
                  </radialGradient>
                  <linearGradient
                    id="glass-pane-sheen"
                    x1="12%"
                    y1="4%"
                    x2="86%"
                    y2="92%"
                  >
                    <stop offset="0%" stopColor="#fff9e4" stopOpacity="0.38" />
                    <stop offset="20%" stopColor="#ffffff" stopOpacity="0.1" />
                    <stop offset="48%" stopColor="#ffffff" stopOpacity="0" />
                    <stop offset="100%" stopColor="#000000" stopOpacity="0" />
                  </linearGradient>
                  {/* Board-space limestone ramps. These use the same vertical
                      clerestory light as the page wall, so the hull reveal
                      and rosette tracery read as stone cut from the
                      surrounding masonry rather than as a separate board
                      layer. */}
                  <linearGradient
                    id="glass-stone-face-gradient"
                    gradientUnits="userSpaceOnUse"
                    x1={0}
                    y1={0}
                    x2={0}
                    y2={boardLayout.height}
                  >
                    <stop offset="0%" stopColor="var(--glass-stone-raise)" />
                    <stop offset="46%" stopColor="var(--glass-stone-face)" />
                    <stop offset="78%" stopColor="var(--glass-stone)" />
                    <stop offset="100%" stopColor="var(--glass-stone-deep)" />
                  </linearGradient>
                  <linearGradient
                    id="glass-stone-joint-gradient"
                    gradientUnits="userSpaceOnUse"
                    x1={0}
                    y1={0}
                    x2={0}
                    y2={boardLayout.height}
                  >
                    <stop offset="0%" stopColor="var(--glass-stone-face)" />
                    <stop offset="54%" stopColor="var(--glass-stone)" />
                    <stop offset="100%" stopColor="var(--glass-stone-deep)" />
                  </linearGradient>
                  <linearGradient
                    id="glass-stone-arris-gradient"
                    gradientUnits="userSpaceOnUse"
                    x1={0}
                    y1={0}
                    x2={0}
                    y2={boardLayout.height}
                  >
                    <stop offset="0%" stopColor="rgba(255, 244, 214, 0.38)" />
                    <stop offset="58%" stopColor="rgba(255, 244, 214, 0.1)" />
                    <stop offset="100%" stopColor="rgba(255, 244, 214, 0)" />
                  </linearGradient>
                  <pattern
                    id="glass-stone-speckle"
                    patternUnits="userSpaceOnUse"
                    width="42"
                    height="42"
                  >
                    <rect width="42" height="42" fill="transparent" />
                    <circle cx="7" cy="9" r="0.7" fill="rgba(255, 244, 214, 0.22)" />
                    <circle cx="30" cy="14" r="0.55" fill="rgba(255, 244, 214, 0.16)" />
                    <circle cx="18" cy="31" r="0.6" fill="rgba(0, 0, 0, 0.18)" />
                    <circle cx="37" cy="35" r="0.45" fill="rgba(0, 0, 0, 0.14)" />
                  </pattern>
                  <pattern
                    id="glass-pane-seed"
                    patternUnits="userSpaceOnUse"
                    width="34"
                    height="34"
                  >
                    <rect width="34" height="34" fill="transparent" />
                    <circle cx="6" cy="8" r="0.65" fill="rgba(255, 255, 255, 0.28)" />
                    <circle cx="24" cy="12" r="0.5" fill="rgba(255, 255, 255, 0.2)" />
                    <circle cx="15" cy="25" r="0.55" fill="rgba(0, 0, 0, 0.18)" />
                    <path
                      d="M3 22 C10 18 16 20 22 15 S30 11 33 15"
                      fill="none"
                      stroke="rgba(255,255,255,0.13)"
                      strokeWidth="0.7"
                    />
                    <path
                      d="M2 5 C9 9 13 6 19 10 S28 17 33 13"
                      fill="none"
                      stroke="rgba(0,0,0,0.12)"
                      strokeWidth="0.65"
                    />
                  </pattern>
                  {/* Seedy antique-glass refraction: low-frequency fractal
                      noise displaces the backlight layer it's applied to, so
                      the light bleeding through ripples and pools the way it
                      does through hand-poured cathedral glass. Kept subtle and
                      static. */}
                  <filter
                    id="glass-refract"
                    x="-20%"
                    y="-20%"
                    width="140%"
                    height="140%"
                  >
                    <feTurbulence
                      type="fractalNoise"
                      baseFrequency="0.012 0.026"
                      numOctaves={2}
                      seed={7}
                      result="noise"
                    />
                    <feDisplacementMap
                      in="SourceGraphic"
                      in2="noise"
                      scale={7}
                      xChannelSelector="R"
                      yChannelSelector="G"
                    />
                  </filter>
                  {/* The backlit field. ONE sheet of lit cathedral-blue
                      glass, center-bright and dimming outward, clipped to
                      the union of every hex pane below so it shows ONLY
                      through the glass — the masonry wall fills the gaps
                      between the seven rosettes and the space around the
                      board. The stop colors live in theme-glass.css keyed
                      off --glass-light-hue, so the field's hue rides the
                      same octave rotation as the jewels. */}
                  <radialGradient id="glass-field" cx="50%" cy="47%" r="62%">
                    <stop className="glass-field-stop-core" offset="0%" />
                    <stop className="glass-field-stop-mid" offset="52%" />
                    <stop className="glass-field-stop-edge" offset="100%" />
                  </radialGradient>
                  {/* One soft diagonal glare across the whole aperture —
                      board-level, not per-pane hotspots. */}
                  <linearGradient
                    id="glass-glare"
                    x1="8%"
                    y1="4%"
                    x2="78%"
                    y2="88%"
                  >
                    <stop offset="0%" stopColor="rgba(255, 252, 244, 0.42)" />
                    <stop offset="38%" stopColor="rgba(255, 252, 244, 0.08)" />
                    <stop offset="100%" stopColor="rgba(255, 252, 244, 0)" />
                  </linearGradient>
                  <clipPath
                    id="glass-field-clip"
                    clipPathUnits="userSpaceOnUse"
                  >
                    {boardDef.cells.map((cell) => {
                      const p = boardLayout.positions[cell.id]
                      return (
                        <polygon
                          key={`field-clip-${cell.id}`}
                          points={buildHexPoints(
                            p.x + boardLayout.offsetX,
                            p.y + boardLayout.offsetY,
                          )}
                        />
                      )
                    })}
                  </clipPath>
                  {glassHullLeadLoop && (
                    <clipPath
                      id="glass-internal-lead-clip"
                      clipPathUnits="userSpaceOnUse"
                    >
                      <polygon
                        points={glassHullLeadLoop
                          .map((v) => `${v.x},${v.y}`)
                          .join(' ')}
                      />
                    </clipPath>
                  )}
                  {glassStoneTraceryClipLoop && (
                    <clipPath
                      id="glass-stone-tracery-clip"
                      clipPathUnits="userSpaceOnUse"
                    >
                      <polygon
                        points={glassStoneTraceryClipLoop
                          .map((v) => `${v.x},${v.y}`)
                          .join(' ')}
                      />
                    </clipPath>
                  )}
                </>
              )}
              {rippleCells.length > 0 && rippleCenter && (
                <mask
                  id="hexaclear-ripple-mask"
                  maskUnits="userSpaceOnUse"
                  maskContentUnits="userSpaceOnUse"
                >
                  <rect
                    x={0}
                    y={0}
                    width={boardLayout.width}
                    height={boardLayout.height}
                    fill="black"
                  />
                  <circle
                    key={rippleToken}
                    className={[
                      'hexaclear-ripple-ring',
                      rippleIsClear ? 'clear' : 'soft',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    cx={rippleCenter.x}
                    cy={rippleCenter.y}
                    r={0}
                  />
                </mask>
              )}
            </defs>

            {/* Stained-glass backlit field, behind every pane and clipped
                to the hex panes so masonry shows in the gaps. */}
            {theme === 'glass' && (
              <g className="hexaclear-glass-field" aria-hidden="true">
                <rect
                  x={0}
                  y={0}
                  width={boardLayout.width}
                  height={boardLayout.height}
                  fill="url(#glass-field)"
                  clipPath="url(#glass-field-clip)"
                  filter="url(#glass-refract)"
                />
                <rect
                  x={0}
                  y={0}
                  width={boardLayout.width}
                  height={boardLayout.height}
                  fill="url(#glass-glare)"
                  clipPath="url(#glass-field-clip)"
                  className="hexaclear-glass-glare"
                />
              </g>
            )}

            {theme === 'glass' && glassHullLeadLoop && (
              <polygon
                points={glassHullLeadLoop
                  .map((v) => `${v.x},${v.y}`)
                  .join(' ')}
                className="hexaclear-glass-recess-shadow"
                aria-hidden="true"
                pointerEvents="none"
              />
            )}

            {/* Board hull — outer stone reveal (below glass panes). */}
            {boardRender.outlineSegments.map((seg, idx) => (
              <line
                key={`outline-back-${idx}`}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                className="hexaclear-board-outline-back"
              />
            ))}
            {boardRender.outlineSegments.map((seg, idx) => (
              <line
                key={`outline-front-${idx}`}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                className="hexaclear-board-outline-front"
              />
            ))}
            {theme === 'glass' &&
              boardRender.outlineSegments.map((seg, idx) => (
                <line
                  key={`outline-arris-${idx}`}
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  className="hexaclear-board-outline-arris"
                  aria-hidden="true"
                  pointerEvents="none"
                />
              ))}
            {theme === 'glass' &&
              boardRender.outlineSegments.map((seg, idx) => (
                <line
                  key={`outline-texture-${idx}`}
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  className="hexaclear-board-outline-texture"
                  aria-hidden="true"
                  pointerEvents="none"
                />
              ))}

            {(() => {
              return boardDef.cells.map((cell) => {
                const pos = boardLayout.positions[cell.id]
                const cx = pos.x + boardLayout.offsetX
                const cy = pos.y + boardLayout.offsetY
                const points = buildHexPoints(cx, cy)
                const bevel = buildHexBevelPaths(cx, cy)

                const isFilledLogical = game.board[cell.id] === 'filled'
                const isClearing = clearingCells.includes(cell.id)
                const isPendingGoldenSpawn =
                  (game.mode === 'endless' || game.mode === 'big') &&
                  clearingCells.length > 0 &&
                  pendingGoldenSpawnCellIds.includes(cell.id)
                // Don't hide pieces during undo - they should reappear immediately
                const isFilledVisible = isFilledLogical && !isPendingGoldenSpawn
                const isFilled = isFilledVisible || isClearing
                const inPreview =
                  !isClearing &&
                  preview &&
                  preview.targetIds.includes(cell.id)
                const willClearInPreview =
                  preview && preview.clearedIds.includes(cell.id)
                const previewValid = preview?.valid ?? false

                const dailyHitsForCell = game.dailyHits[cell.id] ?? 0
                const isDailyTarget =
                  game.mode === 'daily' && dailyHitsForCell > 0
                const isDailyHitPulsing = dailyHitPulseCells.includes(cell.id)
                const isRecentlyPlaced = recentlyPlacedCells.includes(cell.id)
                const isInvalidDrop = invalidDropCellIds.includes(cell.id)
                const isGolden =
                  (game.mode === 'endless' || game.mode === 'big') &&
                  (clearingCells.length > 0
                    ? clearingGoldenCellIds.includes(cell.id)
                    : game.goldenCellIds.includes(cell.id))

                // In MP co-op we tint each non-self placement so a
                // viewer can see at a glance who placed which cube.
                // The `partner-piece` class drives a lightening pass
                // (brightness/saturate) AND the hue rotation as a
                // single combined filter chain — composing two
                // separate filters across an SVG ancestor and its
                // descendant doesn't render reliably (especially in
                // the wood theme's nested `<g>` cubes), so we drive
                // the per-player offset through a CSS variable that
                // the partner-piece rule splices into its existing
                // brightness/saturate filter. Self-placed cells stay
                // in the default palette. Rubies have their own
                // palette and aren't owned by any player, so we
                // leave them untinted regardless.
                const isPartnerOwned =
                  isMultiplayer && !isGolden && nonSelfOwnedCells.has(cell.id)
                const partnerHueShift =
                  isPartnerOwned ? cellHueByCellId[cell.id] ?? 0 : 0
                // Bake hue rotation + lightening pass into concrete
                // hex colors via JS HSL math, then hand each cube
                // face / win98 polygon its tinted fill through inline
                // CSS variables. Doing it in JS sidesteps two CSS
                // gotchas: SVG `filter` on `<g>` doesn't compose
                // reliably across the board's nested transform
                // groups, and CSS `hue-rotate()` is a linear color
                // matrix that produces near-identical output for
                // mid-saturation teals at different angles, so two
                // distinct partners can read as the same color even
                // though `--partner-hue` differs. The lightnessAdd /
                // saturationMul args reproduce the previous
                // `brightness()/saturate()` filter pass.
                const partnerHueStyle = isPartnerOwned
                  ? ({
                      '--partner-hue': `${partnerHueShift}deg`,
                      '--cube-top-tint': tintCubeColor(
                        WOOD_CUBE_TOP_HEX,
                        partnerHueShift,
                        0.05,
                        0.85,
                      ),
                      '--cube-right-tint': tintCubeColor(
                        WOOD_CUBE_RIGHT_HEX,
                        partnerHueShift,
                        0.08,
                        0.85,
                      ),
                      '--cube-left-tint': tintCubeColor(
                        WOOD_CUBE_LEFT_HEX,
                        partnerHueShift,
                        0.06,
                        0.85,
                      ),
                      '--w98-partner-fill-tint': tintCubeColor(
                        W98_PARTNER_FILL_HEX,
                        partnerHueShift,
                        0,
                        1,
                      ),
                    } as React.CSSProperties)
                  : undefined

                const clearingClasses = clearingClassesByCell[cell.id] ?? []

                // Living Board phase A: an empty cell no current piece
                // can reach goes dark. Suppressed during critical (the
                // alarm is uniform — no map), for daily numbered targets
                // (their glow is gameplay-critical and the dimming flows
                // around them), and while disabled (tutorial/MP/over).
                const isDeadCell =
                  livenessEnabled &&
                  !criticalImminent &&
                  !isFilled &&
                  !isDailyTarget &&
                  !liveness.liveCellIds.has(cell.id)

                // PvP territory tint: every cleared cell wears the
                // last-clearer's hue as a translucent overlay so
                // empty ground reads as "owned territory" without
                // pretending to be filled. Partner tints flood with
                // a hue-rotated warm gold; self tints get a subtle
                // warm cream so own-territory still feels neutral.
                const partnerTintHue = cellTintHueByCellId[cell.id]
                const isPartnerTinted = partnerTintHue !== undefined
                const isSelfTinted = selfTintedCellIds.has(cell.id)
                // Theme-aware tint base. Wood mode tints with the warm
                // wood-cube palette; Win98 swaps to the teal cube
                // palette so the territory color actually matches the
                // player's cube color in that theme (without this the
                // Win98 cubes are teal but the floor tints under them
                // read gold/cream).
                const tintIsWin98 = theme === 'win98'
                const tintOverlayColor = isPartnerTinted
                  ? tintCubeColor(
                      tintIsWin98 ? W98_PARTNER_FILL_HEX : WOOD_CUBE_LEFT_HEX,
                      partnerTintHue ?? 0,
                      tintIsWin98 ? 0 : 0.1,
                      tintIsWin98 ? 1 : 0.85,
                    )
                  : isSelfTinted
                  ? tintIsWin98
                    ? W98_SELF_FILL_HEX
                    : WOOD_CUBE_TOP_HEX
                  : null
                const conflictTintHue = conflictTintHueByCellId[cell.id]
                const isConflict = conflictTintHue !== undefined
                const conflictStrokeColor = isConflict
                  ? tintCubeColor(
                      tintIsWin98 ? W98_PARTNER_FILL_HEX : WOOD_CUBE_LEFT_HEX,
                      conflictTintHue ?? 0,
                      tintIsWin98 ? 0 : 0.05,
                      1,
                    )
                  : null

                const cellTintStyle: React.CSSProperties = {}
                if (tintOverlayColor) {
                  ;(cellTintStyle as Record<string, string>)[
                    '--cell-tint-color'
                  ] = tintOverlayColor
                }
                if (conflictStrokeColor) {
                  ;(cellTintStyle as Record<string, string>)[
                    '--cell-conflict-color'
                  ] = conflictStrokeColor
                }
                const glassJewelStyle =
                  (theme === 'glass' || theme === 'mondrian') &&
                  !isGolden &&
                  !isMultiplayer
                    ? paintedCellStyle(
                        glassCellColors[cell.id] ??
                          jewelIndexForPieceCube(cell.id, 0),
                      )
                    : null
                let polygonStyle: React.CSSProperties | undefined
                if (theme === 'glass' && isFilled) {
                  if (isPartnerOwned && partnerHueStyle) {
                    polygonStyle = {
                      ...partnerHueStyle,
                      ...(tintOverlayColor || conflictStrokeColor
                        ? cellTintStyle
                        : {}),
                    }
                  } else if (!isGolden && glassJewelStyle) {
                    polygonStyle = { ...glassJewelStyle }
                  } else if (
                    tintOverlayColor ||
                    conflictStrokeColor ||
                    partnerHueStyle
                  ) {
                    polygonStyle = {
                      ...(partnerHueStyle ?? {}),
                      ...cellTintStyle,
                    }
                  }
                } else {
                  polygonStyle =
                    partnerHueStyle ||
                    tintOverlayColor ||
                    conflictStrokeColor
                      ? { ...(partnerHueStyle ?? {}), ...cellTintStyle }
                      : undefined
                }
                const cubeStyle = glassJewelStyle ?? partnerHueStyle

                return (
                  <g
                    key={cell.id}
                    data-cell-id={cell.id}
                    className={[
                      'hexaclear-cell',
                      isDeadCell ? 'cell-dead' : '',
                      // Game-over collapse: this cell's visual has been
                      // cloned into the debris layer; hide the original.
                      // Gated on gameOver so a freshly-started run's
                      // cells (same ids) are never hidden while the
                      // debris is still being swept.
                      game.gameOver && collapseCellIdSet.has(cell.id)
                        ? 'collapse-hidden'
                        : '',
                      isInvalidDrop ? 'invalid-drop' : '',
                      // Bubble PvP tint classes up to the cell wrapper
                      // so the SlotGeometry dimple (a sibling polygon
                      // that paints the dark interior of empty cells)
                      // can be tinted via CSS. Without this the dark
                      // #1a0c06 slot fill covers the empty hex's tint
                      // and only the cell border ring reads as owned.
                      isPartnerTinted ? 'pvp-tinted-partner' : '',
                      isSelfTinted ? 'pvp-tinted-self' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={
                      dealInActive
                        ? ({
                            ...(tintOverlayColor ? cellTintStyle : {}),
                            ['--hexaclear-deal-delay' as string]: `${
                              boardRender.dealDelayByCellId[cell.id] ?? 0
                            }ms`,
                          } as React.CSSProperties)
                        : tintOverlayColor
                        ? cellTintStyle
                        : undefined
                    }
                  >
                    <polygon
                      points={points}
                      className={[
                        'hexaclear-hex',
                        isFilled ? 'filled' : 'empty',
                        isGolden ? 'golden' : '',
                        isDailyTarget && !isFilledVisible ? 'daily-target' : '',
                        isClearing ? 'clearing' : '',
                        isInvalidDrop ? 'invalid-drop' : '',
                        willClearInPreview ? 'preview-clear' : '',
                        isPartnerOwned ? 'partner-piece' : '',
                        isPartnerTinted ? 'pvp-tinted-partner' : '',
                        isSelfTinted ? 'pvp-tinted-self' : '',
                        ...clearingClasses,
                        inPreview
                          ? previewValid
                            ? 'preview-valid'
                            : 'preview-invalid'
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={polygonStyle}
                      role="button"
                      tabIndex={0}
                      aria-label={`${
                        isFilled ? 'Filled' : 'Empty'
                      } cell at ${cell.coord.q}, ${cell.coord.r}`}
                      onMouseEnter={() => setHover({ cellId: cell.id })}
                      onMouseLeave={() => setHover(null)}
                      onClick={() => handleCellClick(cell.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          handleCellClick(cell.id)
                        }
                      }}
                    />
                    {theme === 'glass' && (
                      <polygon
                        points={points}
                        className={[
                          'hexaclear-pane-depth',
                          isFilled ? 'filled' : 'empty',
                          isGolden ? 'golden' : '',
                          isDailyTarget && !isFilledVisible
                            ? 'daily-target'
                            : '',
                          isClearing ? 'clearing' : '',
                          willClearInPreview ? 'preview-clear' : '',
                          inPreview
                            ? previewValid
                              ? 'preview-valid'
                              : 'preview-invalid'
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        aria-hidden="true"
                        pointerEvents="none"
                      />
                    )}
                    {theme === 'glass' && (
                      <polygon
                        points={points}
                        className={[
                          'hexaclear-pane-sheen',
                          isFilled ? 'filled' : 'empty',
                          isGolden ? 'golden' : '',
                          isClearing ? 'clearing' : '',
                          inPreview
                            ? previewValid
                              ? 'preview-valid'
                              : 'preview-invalid'
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        aria-hidden="true"
                        pointerEvents="none"
                      />
                    )}
                    {theme === 'glass' && (
                      <polygon
                        points={points}
                        className={[
                          'hexaclear-pane-seed',
                          isFilled ? 'filled' : 'empty',
                          isGolden ? 'golden' : '',
                          isClearing ? 'clearing' : '',
                          inPreview
                            ? previewValid
                              ? 'preview-valid'
                              : 'preview-invalid'
                            : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        aria-hidden="true"
                        pointerEvents="none"
                      />
                    )}
                    <g
                      className={[
                        'hexaclear-hex-bevels',
                        isFilled ? 'filled' : 'empty',
                        isGolden ? 'golden' : '',
                        isClearing ? 'clearing' : '',
                        willClearInPreview ? 'preview-clear' : '',
                        inPreview
                          ? previewValid
                            ? 'preview-valid'
                            : 'preview-invalid'
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-hidden="true"
                      pointerEvents="none"
                    >
                      <polyline
                        className="hexaclear-hex-bevel hexaclear-hex-bevel-highlight"
                        points={bevel.highlight}
                      />
                      <polyline
                        className="hexaclear-hex-bevel hexaclear-hex-bevel-shadow"
                        points={bevel.shadow}
                      />
                    </g>
                    {!isFilledVisible && !inPreview && !willClearInPreview && (
                      <SlotGeometry cx={cx} cy={cy} />
                    )}
                    {theme === 'audius' && inPreview && previewValid && (
                      <CubeLines
                        cx={cx}
                        cy={cy}
                        variant="normal"
                        extraClasses={[
                          'preview-piece',
                          willClearInPreview ? 'preview-clear' : '',
                        ].filter(Boolean)}
                      />
                    )}
                    {/* Colorblind-mode territory glyph on empty PvP-
                        tinted cells. Always rendered (cheap) and
                        hidden via CSS unless `.is-colorblind` is on,
                        so the toggle is a paint-only change. The
                        cell-glyph for FILLED cubes lives inside
                        CubeLines below; this branch handles the
                        empty-but-owned territory case so an empty
                        cell can still announce who claimed it. */}
                    {!isFilledVisible &&
                      !inPreview &&
                      !willClearInPreview &&
                      cellTintGlyphByCellId[cell.id] && (
                        <text
                          x={cx}
                          y={cy + 4}
                          className="hexaclear-player-glyph hexaclear-player-glyph-tint"
                          aria-hidden="true"
                        >
                          {cellTintGlyphByCellId[cell.id]}
                        </text>
                      )}
                    {(isFilled || (isDailyTarget && isDailyHitPulsing)) &&
                      !isRecentlyPlaced &&
                      (theme !== 'glass' ||
                        isGolden ||
                        isDailyTarget ||
                        !!cellGlyphByCellId[cell.id]) && (
                      <CubeLines
                        cx={cx}
                        cy={cy}
                        variant={
                          isDailyTarget
                            ? 'dailyTarget'
                            : isGolden
                            ? 'golden'
                            : 'normal'
                        }
                        dailyHits={isDailyTarget ? dailyHitsForCell : undefined}
                        extraClasses={[
                          // Don't apply clearing classes to daily cubes that are just being decremented
                          ...(isDailyTarget && isDailyHitPulsing ? [] : clearingClasses),
                          isInvalidDrop ? 'invalid-drop' : '',
                          isDailyTarget && isDailyHitPulsing
                            ? 'daily-hit-pulse'
                            : '',
                          isPartnerOwned ? 'partner-piece' : '',
                        ].filter(Boolean)}
                        style={cubeStyle}
                        playerGlyph={cellGlyphByCellId[cell.id]}
                      />
                    )}
                    {(game.mode === 'endless' || game.mode === 'big') &&
                      goldenPopupCellIds.includes(cell.id) && (
                        <text
                          x={cx}
                          y={cy - HEX_SIZE * 0.5}
                          className="hexaclear-golden-popup"
                        >
                          +10 Ruby
                        </text>
                      )}
                    {/* Colorblind-mode ruby glyph. Always rendered
                        on ruby cells (cheap — one text element per
                        ruby) and hidden via CSS unless the
                        viewport carries `.is-colorblind`. Gives the
                        ruby a non-color identity (a small diamond)
                        on top of its existing pink/red palette so
                        a player with red-green confusion can still
                        find it at a glance. */}
                    {isGolden && isFilled && !isClearing && (
                      <text
                        x={cx}
                        y={cy + HEX_SIZE * 0.18}
                        className="hexaclear-ruby-glyph"
                        aria-hidden="true"
                      >
                        ◆
                      </text>
                    )}
                    {/* PvP conflict ring: a filled cube sits on a
                        cell whose persistent tint belongs to another
                        player. Render a colored outline over the
                        cube so the disputed territory reads at a
                        glance — the player's color stays the cube's
                        body, the tinter's color frames it. */}
                    {isConflict && isFilled && (
                      <polygon
                        points={points}
                        className="hexaclear-hex-conflict-ring"
                        style={polygonStyle}
                        pointerEvents="none"
                        aria-hidden="true"
                      />
                    )}
                    {/* Ruby capture uses the same clear animation as other cubes;
                        only the +10 popup is special. */}
                    {DEBUG_SHOW_COORDS && (
                      <text
                        x={cx}
                        y={cy + 4}
                        className="hexaclear-debug-label"
                      >
                        {cell.coord.q},{cell.coord.r}
                      </text>
                    )}
                    {/* Lead came — pane-to-pane only; stone mullions own
                        inter-rosette edges (see glassFlowerBoundaryEdgeKeys). */}
                    {(() => {
                      const outlineClasses = [
                        'hexaclear-cell-outline',
                        isFilled ? 'filled' : 'empty',
                        isGolden ? 'golden' : '',
                        isClearing ? 'clearing' : '',
                        willClearInPreview ? 'preview-clear' : '',
                        inPreview
                          ? previewValid
                            ? 'preview-valid'
                            : 'preview-invalid'
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')
                      if (theme === 'glass') {
                        return Array.from({ length: 6 }, (_, side) => {
                          const dir = directions[EDGE_DIRECTION_INDEX[side]]
                          const neighborId = axialToId(
                            addAxial(cell.coord, dir),
                          )
                          if (!boardCellIdSet.has(neighborId)) return null
                          const edge = hexEdgeSegment(cx, cy, side)
                          if (
                            glassFlowerBoundaryEdgeKeys.has(segmentKey(edge))
                          ) {
                            return null
                          }
                          return (
                            <line
                              key={`lead-${side}`}
                              x1={edge.x1}
                              y1={edge.y1}
                              x2={edge.x2}
                              y2={edge.y2}
                              className={outlineClasses}
                              clipPath={
                                glassHullLeadLoop
                                  ? 'url(#glass-internal-lead-clip)'
                                  : undefined
                              }
                              aria-hidden="true"
                              pointerEvents="none"
                            />
                          )
                        })
                      }
                      return (
                        <polygon
                          points={points}
                          className={outlineClasses}
                          aria-hidden="true"
                          pointerEvents="none"
                        />
                      )
                    })()}
                  </g>
                )
              })
            })()}

            {/* Hull rim lead on the glass lip — before inter-rosette stone so
                internal mullions wrap over it at junctions. Exterior frame
                stone is the board outline above (drawn before panes). */}
            {theme === 'glass' && glassHullLeadLoop && (
              <polygon
                points={glassHullLeadLoop
                  .map((v) => `${v.x},${v.y}`)
                  .join(' ')}
                className="hexaclear-glass-perimeter-lead"
                aria-hidden="true"
                pointerEvents="none"
              />
            )}

            {/* Stained-glass shatter. Only in the glass theme, only while
                a clear is in flight (clearingCells drains after 600ms — the
                same window the engine keeps the clear state alive). Each
                clearing cell breaks into six wedge shards that fling outward
                along their own radial direction, spin, and fall, so a clear
                reads as panes smashing rather than the default shrink. The
                cube's clear animation is replaced with a quick light-flash in
                theme-glass.css so the two don't double up. The shards inherit
                the active jewel palette (--cube-*) so they match the glass
                that just broke. Transient + glass-only = no per-frame cost
                outside a clear. */}
            {theme === 'glass' && glassShatter && (
              <g
                key={glassShatter.token}
                className="hexaclear-glass-shatter"
                pointerEvents="none"
                aria-hidden="true"
              >
                {glassShatter.cells.map((id) => {
                  const pos = boardLayout.positions[id]
                  if (!pos) return null
                  const cx = pos.x + boardLayout.offsetX
                  const cy = pos.y + boardLayout.offsetY
                  // 12 boundary points (6 corners + 6 edge midpoints)
                  // fanned from the center give a finer, more glass-like
                  // fracture than clean wedges.
                  const ring: { x: number; y: number }[] = []
                  for (let i = 0; i < 6; i++) {
                    const a = ((60 * i - 30) * Math.PI) / 180
                    const a2 = ((60 * (i + 1) - 30) * Math.PI) / 180
                    const vx = cx + HEX_SIZE * Math.cos(a)
                    const vy = cy + HEX_SIZE * Math.sin(a)
                    const mx = cx + HEX_SIZE * 0.92 * Math.cos((a + a2) / 2)
                    const my = cy + HEX_SIZE * 0.92 * Math.sin((a + a2) / 2)
                    ring.push({ x: vx, y: vy }, { x: mx, y: my })
                  }
                  // Each cell's shards inherit its own jewel color so the
                  // break matches the pane that shattered.
                  const cellJewelStyle = jewelStyle(
                    glassCellColors[id] ?? jewelIndexForPieceCube(id, 0),
                    glassHueShift,
                  )
                  return (
                    <g key={`${id}-shards`} style={cellJewelStyle}>
                      {ring.map((p, i) => {
                    const p2 = ring[(i + 1) % ring.length]
                    const mx = (cx + p.x + p2.x) / 3
                    const my = (cy + p.y + p2.y) / 3
                    const dx = mx - cx
                    const dy = my - cy
                    const len = Math.hypot(dx, dy) || 1
                    // Deterministic per-shard variation (stable across
                    // re-renders within one shatter): travel distance and
                    // spin keyed off the shard index so the break reads
                    // organic, not mechanical.
                    const dist = 0.78 + ((i * 7) % 5) * 0.14
                    const spin = (i % 2 === 0 ? 1 : -1) * (0.7 + ((i * 3) % 4) * 0.22)
                    return (
                      <polygon
                        key={`${id}-shard-${i}`}
                        className={`hexaclear-glass-shard hexaclear-glass-shard-${i % 6}`}
                        points={`${cx.toFixed(2)},${cy.toFixed(2)} ${p.x.toFixed(
                          2,
                        )},${p.y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(
                          2,
                        )}`}
                        style={
                          {
                            '--shard-dx': (dx / len).toFixed(3),
                            '--shard-dy': (dy / len).toFixed(3),
                            '--shard-dist': dist.toFixed(2),
                            '--shard-spin': spin.toFixed(2),
                            '--shard-delay': `${(i % 6) * 45}ms`,
                          } as React.CSSProperties
                        }
                      />
                    )
                      })}
                    </g>
                  )
                })}
              </g>
            )}

            {/* Off-board invalid placement flash: show the attempted shape
                even when part of it falls outside the board. */}
            {invalidDropCellIds.length > 0 && (
              <g className="hexaclear-invalid-ghost">
                {invalidDropCellIds.map((id) => {
                  const cell = boardDef.cells.find((c) => c.id === id)
                  if (cell) {
                    // On-board cells are already flashing via invalid-drop.
                    return null
                  }
                  const [qStr, rStr] = id.split(',')
                  const q = Number(qStr)
                  const r = Number(rStr)
                  if (!Number.isFinite(q) || !Number.isFinite(r)) return null
                  const { x, y } = axialToPixel(q, r)
                  const cx = x + boardLayout.offsetX
                  const cy = y + boardLayout.offsetY
                  return (
                    <CubeLines
                      key={`invalid-ghost-${id}`}
                      cx={cx}
                      cy={cy}
                      variant="normal"
                      extraClasses={['invalid-drop']}
                    />
                  )
                })}
              </g>
            )}

            {/* Live partner-hover ghosts. One translucent piece
                footprint per non-self player, colored with their
                per-viewer hue (same `--partner-hue` variable that
                drives placed-cube tinting, so a partner's ghost
                matches the cubes they end up dropping). We render
                BOTH a flat polygon (visible only in win98, where
                cube faces are display:none) and a CubeLines (visible
                only in wood, where the polygon is empty / unfilled
                under a ghost). Each cell renders both shapes; CSS
                picks the right one per theme. Off-board cells in
                the footprint still render so the player can see
                that their partner is aiming at an edge — no
                validity check on purpose; these are exploratory
                previews, not commitments.

                Key stability matters here: we key the per-partner
                group by playerId (NOT by hovered cellId) and the
                inner cell slots by relative index within the
                piece's footprint, so when the partner moves their
                cursor to a new cell React updates the existing
                nodes' positions in place instead of unmounting and
                remounting. Mount/unmount churn at the sender's
                ~10Hz re-stamp cadence reads as a rapid blink on the
                partner's screen, which is exactly the bug we're
                avoiding. */}
            {partnerGhosts.length > 0 && (
              <g className="hexaclear-partner-ghosts" pointerEvents="none">
                {partnerGhosts.map((ghost) => (
                  <g
                    key={`partner-${ghost.playerId}`}
                    style={
                      {
                        '--partner-hue': `${ghost.hue}deg`,
                        '--cube-top-tint': tintCubeColor(
                          WOOD_CUBE_TOP_HEX,
                          ghost.hue,
                          0.05,
                          0.85,
                        ),
                        '--cube-right-tint': tintCubeColor(
                          WOOD_CUBE_RIGHT_HEX,
                          ghost.hue,
                          0.08,
                          0.85,
                        ),
                        '--cube-left-tint': tintCubeColor(
                          WOOD_CUBE_LEFT_HEX,
                          ghost.hue,
                          0.06,
                          0.85,
                        ),
                        '--w98-partner-fill-tint': tintCubeColor(
                          W98_PARTNER_FILL_HEX,
                          ghost.hue,
                          0,
                          1,
                        ),
                      } as React.CSSProperties
                    }
                  >
                    {ghost.cells.map((c, idx) => {
                      const { x, y } = axialToPixel(c.q, c.r)
                      const cx = x + boardLayout.offsetX
                      const cy = y + boardLayout.offsetY
                      const points = buildHexPoints(cx, cy)
                      const offboardClass = c.onBoard
                        ? ''
                        : 'partner-ghost-offboard'
                      return (
                        <React.Fragment key={`cell-${idx}`}>
                          <polygon
                            className={[
                              'hexaclear-partner-ghost-fill',
                              offboardClass,
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            points={points}
                          />
                          <CubeLines
                            cx={cx}
                            cy={cy}
                            variant="normal"
                            extraClasses={[
                              'partner-ghost',
                              offboardClass,
                            ].filter(Boolean)}
                          />
                        </React.Fragment>
                      )
                    })}
                  </g>
                ))}
              </g>
            )}

            {rippleCells.length > 0 && rippleCenter && (
              <g
                className={[
                  'hexaclear-board-ripple-overlay',
                  rippleIsClear ? 'clear' : 'soft',
                ]
                  .filter(Boolean)
                  .join(' ')}
                mask="url(#hexaclear-ripple-mask)"
              >
                {boardDef.cells.map((cell) => {
                  const pos = boardLayout.positions[cell.id]
                  const cx = pos.x + boardLayout.offsetX
                  const cy = pos.y + boardLayout.offsetY
                  const points = buildHexPoints(cx, cy)
                  return (
                    <polygon
                      key={`ripple-overlay-${cell.id}`}
                      points={points}
                      className="hexaclear-hex ripple-overlay"
                    />
                  )
                })}
              </g>
            )}
            {/* Rosette boundaries should sit above the static board but below
                the final cube pop overlay so the highlight never hides the
                animation. */}
            {/* Rosette stone tracery — inter-rosette ribs only in glass (exterior
                hull stone is the board outline); drawn above hull lead. */}
            {(theme === 'glass'
              ? glassInterRosetteFlowerBackSegments
              : boardRender.flowerBoundarySegments
            ).map((seg, idx) => (
              <line
                key={`flower-back-${idx}`}
                x1={seg.x1}
                y1={seg.y1}
                x2={seg.x2}
                y2={seg.y2}
                className="hexaclear-flower-boundary-back"
                clipPath={
                  theme === 'glass' && glassStoneTraceryClipLoop
                    ? 'url(#glass-stone-tracery-clip)'
                    : undefined
                }
              />
            ))}
            <g className="hexaclear-flower-boundary-group">
              {(theme === 'glass'
                ? glassInterRosetteFlowerFrontSegments
                : boardRender.flowerBoundarySegments
              ).map((seg, idx) => (
                <line
                  key={`flower-front-${idx}`}
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  className="hexaclear-flower-boundary"
                  clipPath={
                    theme === 'glass' && glassStoneTraceryClipLoop
                      ? 'url(#glass-stone-tracery-clip)'
                      : undefined
                  }
                />
              ))}
              {theme === 'glass' &&
                glassInterRosetteFlowerFrontSegments.map((seg, idx) => (
                  <line
                    key={`flower-arris-${idx}`}
                    x1={seg.x1}
                    y1={seg.y1}
                    x2={seg.x2}
                    y2={seg.y2}
                    className="hexaclear-flower-boundary-arris"
                    clipPath={
                      glassStoneTraceryClipLoop
                        ? 'url(#glass-stone-tracery-clip)'
                        : undefined
                    }
                    aria-hidden="true"
                    pointerEvents="none"
                  />
                ))}
              {theme === 'glass' &&
                glassInterRosetteFlowerFrontSegments.map((seg, idx) => (
                  <line
                    key={`flower-texture-${idx}`}
                    x1={seg.x1}
                    y1={seg.y1}
                    x2={seg.x2}
                    y2={seg.y2}
                    className="hexaclear-flower-boundary-texture"
                    clipPath={
                      glassStoneTraceryClipLoop
                        ? 'url(#glass-stone-tracery-clip)'
                        : undefined
                    }
                    aria-hidden="true"
                    pointerEvents="none"
                  />
                ))}
            </g>
            {/* Win98 etched-groove rosette frame. One closed
                polygon per rosette per groove tone; CSS hides the
                whole group in non-Win98 themes. The polygons sit
                above per-cell bevels and surfaces but below the
                cube/label content, so the etched ring traces the
                rosette without obscuring scoring text. */}
            <g
              className="hexaclear-flower-groove-group"
              aria-hidden="true"
              pointerEvents="none"
            >
              {boardRender.flowerBoundaryLoops.map((loop, idx) => (
                <g key={`flower-groove-${idx}`}>
                  {loop.dark.length > 0 && (
                    <polygon
                      className="hexaclear-flower-groove hexaclear-flower-groove-dark"
                      points={loop.dark
                        .map((v) => `${v.x},${v.y}`)
                        .join(' ')}
                    />
                  )}
                  {loop.light.length > 0 && (
                    <polygon
                      className="hexaclear-flower-groove hexaclear-flower-groove-light"
                      points={loop.light
                        .map((v) => `${v.x},${v.y}`)
                        .join(' ')}
                    />
                  )}
                </g>
              ))}
            </g>

            {nearCompleteFlowerHint &&
              (() => {
                const loop =
                  boardRender.flowerBoundaryLoops[nearCompleteFlowerHint.index]
                return (
                  <g
                    className="hexaclear-ftue-rosette-glow-layer"
                    aria-hidden="true"
                    pointerEvents="none"
                  >
                    {loop && (
                      <polygon
                        className="hexaclear-ftue-rosette-glow"
                        points={loop.light.map((v) => `${v.x},${v.y}`).join(' ')}
                      />
                    )}
                    {nearCompleteFlowerHint.targetIds.map((id) => {
                      const pos = boardLayout.positions[id]
                      if (!pos) return null
                      return (
                        <circle
                          key={id}
                          cx={pos.x + boardLayout.offsetX}
                          cy={pos.y + boardLayout.offsetY}
                          r={HEX_SIZE * 0.92}
                          className="hexaclear-ftue-rosette-target-pulse"
                        />
                      )
                    })}
                  </g>
                )
              })()}

            {preview && selectedPiece && hover?.cellId && !preview.valid && (
              <PlacementGhost
                originCellId={hover.cellId}
                piece={selectedPiece}
                valid={false}
                boardDef={boardDef}
                layout={boardLayout}
              />
            )}
            {/* Final overlay: animate the whole placed shape as a unit while it
                "locks in" to the board. */}
            {recentlyPlacedCells.length > 0 && (
              <g className="hexaclear-placed-overlay placed-impact">
                {(() => {
                  return recentlyPlacedCells.map((id) => {
                    const cell = boardDef.cells.find((c) => c.id === id)
                    if (!cell) return null
                    const pos = boardLayout.positions[cell.id]
                    const cx = pos.x + boardLayout.offsetX
                    const cy = pos.y + boardLayout.offsetY
                    const dailyHitsForCell = game.dailyHits[cell.id] ?? 0
                    const isDailyTarget =
                      game.mode === 'daily' && dailyHitsForCell > 0
                    const isGolden =
                      (game.mode === 'endless' || game.mode === 'big') &&
                      ((clearingCells.length > 0 &&
                        clearingGoldenCellIds.includes(cell.id)) ||
                        (clearingCells.length === 0 &&
                          game.goldenCellIds.includes(cell.id)))
                    if (game.board[cell.id] !== 'filled') return null
                    // Glass theme: the lock-in overlay must wear the SAME
                    // persisted jewel as the static cube it replaces, or the
                    // placement animation flashes the default sapphire palette
                    // before snapping to the piece's real color.
                    const glassJewelStyle =
                      (theme === 'glass' || theme === 'mondrian') &&
                      !isGolden &&
                      !isMultiplayer
                        ? (paintedCellStyle(
                            glassCellColors[cell.id] ??
                              jewelIndexForPieceCube(cell.id, 0),
                          ) ?? undefined)
                        : undefined
                    return (
                      <CubeLines
                        key={`placed-overlay-${cell.id}`}
                        cx={cx}
                        cy={cy}
                        variant={
                          isDailyTarget
                            ? 'dailyTarget'
                            : isGolden
                            ? 'golden'
                            : 'normal'
                        }
                        dailyHits={isDailyTarget ? dailyHitsForCell : undefined}
                        style={glassJewelStyle}
                        playerGlyph={cellGlyphByCellId[cell.id]}
                      />
                    )
                  })
                })()}
              </g>
            )}

            {/* Ruby capture bursts: a radial spray of small shards
                that flies out from each cleared ruby's last cell. Big
                mode often queues several at once when a placement
                clears multiple rubies in the same combo. */}
            {rubyBursts.map((burst) => (
              <g
                key={burst.token}
                className="hexaclear-ruby-burst"
                pointerEvents="none"
              >
                {Array.from({ length: 12 }).map((_, i) => {
                  const angle = (i / 12) * Math.PI * 2
                  const dist = HEX_SIZE * (1.8 + ((i % 3) * 0.25))
                  const dx = Math.cos(angle) * dist
                  const dy = Math.sin(angle) * dist
                  return (
                    <circle
                      key={i}
                      cx={burst.x}
                      cy={burst.y}
                      r={3.4}
                      className="hexaclear-ruby-shard"
                      style={{
                        ['--ruby-shard-dx' as string]: `${dx}px`,
                        ['--ruby-shard-dy' as string]: `${dy}px`,
                        ['--ruby-shard-delay' as string]: `${(i % 3) * 18}ms`,
                      }}
                    />
                  )
                })}
              </g>
            ))}
            {/* First-launch tutorial: pulse a soft ring on the target
                cell(s) for the current stage so the player's eye lands
                on the intended drop without any explicit "drop here"
                arrow. Lives inside the board SVG so it scales with
                the cells; pointer-events disabled so it never
                interferes with drags. */}
            {tutorialStage > 0 && (() => {
              const targetIds: string[] =
                tutorialStage === 1
                  ? [...TUTORIAL_STAGE_1_TARGET_CELL_IDS]
                  : [...TUTORIAL_STAGE_2_TARGET_CELL_IDS]
              return (
                <g
                  className="hexaclear-tutorial-pulse-layer"
                  aria-hidden="true"
                  pointerEvents="none"
                >
                  {targetIds.map((id) => {
                    const pos = boardLayout.positions[id]
                    if (!pos) return null
                    return (
                      <circle
                        key={id}
                        cx={pos.x + boardLayout.offsetX}
                        cy={pos.y + boardLayout.offsetY}
                        r={HEX_SIZE * 0.92}
                        className="hexaclear-tutorial-pulse"
                      />
                    )
                  })}
                </g>
              )
            })()}
            {/* Game-over collapse debris layer: populated imperatively
                with clones of the doomed cells (see the collapse
                useLayoutEffect). React renders only this empty shell
                and never touches its children, so the clones survive
                modal-driven re-renders. Drawn last = debris tumbles
                over the empty board. */}
            <g
              ref={collapseLayerRef}
              className={[
                'hexaclear-collapse-layer',
                collapseSwept ? 'swept' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-hidden="true"
            />
          </svg>
          {boardClearFlashToken > 0 && (
            <div
              key={boardClearFlashToken}
              className="hexaclear-board-clear-flash"
              aria-hidden="true"
            />
          )}
          {announcerPop && (
            <div
              key={announcerPop.token}
              className={`hexaclear-announcer-pop kind-${announcerPop.kind}`}
              style={
                {
                  '--announcer-pop-scale': announcerPop.scale,
                } as React.CSSProperties
              }
              aria-hidden="true"
            >
              {announcerPop.text}
            </div>
          )}
          {tutorialStage > 0 && (
            <div
              className={[
                'hexaclear-tutorial-overlay',
                `is-stage-${tutorialStage}`,
              ]
                .filter(Boolean)
                .join(' ')}
              aria-live="polite"
            >
              {tutorialStage === 1 && (
                <div className="hexaclear-tutorial-prompt">
                  Drag the piece onto the board to finish the line.
                </div>
              )}
              {tutorialStage === 2 && (
                <div className="hexaclear-tutorial-prompt">
                  Now finish the flower. Clearing the whole board earns a big
                  bonus!
                </div>
              )}
              <button
                type="button"
                className="hexaclear-tutorial-skip"
                onClick={skipTutorial}
                aria-label="Skip tutorial"
              >
                Skip
              </button>
            </div>
          )}
          {ftueHint &&
            ftueHint.kind !== 'hold' &&
            ftueHint.kind !== 'undo' &&
            tutorialStage > 0 &&
            !game.gameOver && (
            <div
              className={[
                'hexaclear-ftue-hint',
                `is-${ftueHint.kind}`,
              ].join(' ')}
              role="status"
              aria-live="polite"
            >
              {ftueHint.text}
            </div>
          )}
          <div className="hexaclear-board-hud">
            {isMultiplayer && mp.mode === 'pvp' ? (
              // PvP renders no left-side overlay block — the race bar
              // lives in its own dedicated row above the board (see
              // `.hexaclear-pvp-banner` mounted as a sibling of
              // `.hexaclear-board-wrapper`). Keeping a placeholder
              // here preserves the flex layout so the Copy Link CTA
              // sits in its usual right-side slot.
              <div className="board-hud-block left" aria-hidden="true" />
            ) : game.mode === 'daily' ? (
              <div className="board-hud-block left">
                {game.moves === 0 ? (
                  <span className="value small">
                    Clear all numbered cubes to win!
                  </span>
                ) : (
                  // Daily ranks ascending by moves, so the live
                  // moves count is the player's running "score".
                  // We park it in the same top-left slot endless
                  // uses for the streak readout so each mode keeps
                  // its primary live metric in the same place.
                  <>
                    <span className="label">Moves</span>
                    <span className="value">{game.moves}</span>
                  </>
                )}
              </div>
            ) : (
              <div className="board-hud-block left">
                {game.streak > 0 && (
                  <span
                    key={game.streak}
                    className={[
                      'value',
                      'hexaclear-streak-value',
                      `hexaclear-streak-tier-${Math.min(6, game.streak)}`,
                    ].join(' ')}
                  >
                    Streak {game.streak}
                  </span>
                )}
              </div>
            )}
            {/* Copy Link CTA only renders when an invite is actually
                useful: solo Multi (pre-room) or in MP with at least
                one open seat left. Once the room is full, the button
                steps out of the way — sharing the link again would
                only invite an evictor at that point. */}
            {game.mode === 'big' &&
              (!isMultiplayer || mp.allPlayers.length < 8) && (
              <div className="board-hud-block right hexaclear-coop-block">
                {/* Co-op vs PvP toggle. Visible only while the room
                    doesn't exist yet (mpRoomCode === null) — once the
                    host clicks Copy Link the room is created with the
                    displayed mode, the shared link encodes it, and the
                    toggle hides because the mode is now locked. */}
                {!isMultiplayer && (
                  <div
                    className="hexaclear-coop-mode-toggle"
                    role="radiogroup"
                    aria-label="Multiplayer mode"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={mpPendingMode === 'coop'}
                      className={[
                        'hexaclear-coop-mode-pill',
                        mpPendingMode === 'coop' ? 'is-active' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => {
                        if (mpPendingMode !== 'coop') {
                          playUiClick()
                          setMpPendingMode('coop')
                        }
                      }}
                    >
                      Co-op
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={mpPendingMode === 'pvp'}
                      className={[
                        'hexaclear-coop-mode-pill',
                        mpPendingMode === 'pvp' ? 'is-active' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => {
                        if (mpPendingMode !== 'pvp') {
                          playUiClick()
                          setMpPendingMode('pvp')
                        }
                      }}
                    >
                      PvP
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className={[
                    'hexaclear-coop-cta',
                    copyLinkLabel === 'copied' ? 'is-copied' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => {
                    unlockAudioOnGesture()
                    playUiClick()
                    void handleCopyLinkAction()
                  }}
                  disabled={copyLinkLabel === 'busy'}
                >
                  {copyLinkLabel === 'copied'
                    ? 'Copied!'
                    : copyLinkLabel === 'busy'
                    ? 'Creating…'
                    : 'Copy Link'}
                </button>
              </div>
            )}
          </div>
          {undoStack.length > 0 && !game.gameOver && (
            <button
              type="button"
              className={[
                'hexaclear-undo-button',
                ftueHint?.kind === 'undo' && tutorialStage > 0
                  ? 'is-ftue-highlighted'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => {
                playUiClick()
                handleUndo()
              }}
            >
              Undo
        </button>
          )}
          {ghost && (() => {
            // Touch keeps the historical "lift above the finger" offset
            // so the player can see the piece. For mouse / pen, we
            // anchor the ghost so the piece's (0,0) origin cell sits
            // exactly under the cursor — i.e. visually on the cell
            // that's about to receive the placement. Every generated
            // piece has (0,0) as its first cell (see pieces.ts:
            // `start = [{q:0, r:0}]`), so finding that cell's pixel
            // position inside the rendered SVG just requires
            // mirroring PiecePreview's board-mode layout math.
            //
            // Position is driven via `transform: translate3d(...)`
            // (with left/top pinned to 0 via CSS) rather than
            // `left`/`top` directly. The ghost has a stacked
            // `filter: drop-shadow()` for the lifted-off-the-board
            // shadow; moving an element with a non-trivial filter
            // via left/top doesn't reliably invalidate the
            // composited layer in Chromium, which leaves behind
            // faint static shadow streaks at every previous
            // position the ghost touched during a slow drag.
            // translate3d() promotes the ghost to its own GPU
            // layer and lets the browser invalidate the previous
            // frame cleanly on each move.
            const isTouchGhost = ghost.pointerType === 'touch'
            let ghostStyle: React.CSSProperties
            if (isTouchGhost) {
              ghostStyle = {
                transform: `translate3d(${ghost.x}px, ${ghost.y}px, 0) translate(-30%, -10%)`,
              }
            } else {
              const cells = ghost.piece.shape.cells
              let minQ = Infinity
              let minR = Infinity
              for (const c of cells) {
                if (c.q < minQ) minQ = c.q
                if (c.r < minR) minR = c.r
              }
              // Normalized coords of the (0,0) origin within the
              // PiecePreview's board-mode coordinate system.
              const originNQ = -minQ
              const originNR = -minR
              const originSvgX =
                HEX_SIZE *
                  (SQRT3 * originNQ + (SQRT3 / 2) * originNR) +
                HEX_SIZE
              const originSvgY = HEX_SIZE * (1.5 * originNR) + HEX_SIZE
              ghostStyle = {
                transform: `translate3d(${ghost.x - originSvgX}px, ${ghost.y - originSvgY}px, 0)`,
              }
            }
            return (
            <div
              className="hexaclear-ghost"
              style={ghostStyle}
            >
              <PiecePreview
                shape={ghost.piece.shape}
                mode="board"
                cubeStyles={glassCubeStylesForPiece(ghost.piece)}
              />
              {/* Multi-clear hint: when the current hover position
                  would clear 2+ scoring patterns at once, surface a
                  small "×N" chip pinned to the floating ghost. The
                  chip's tier (×2/×3/×4+) drives a CSS modifier so
                  bigger combos render larger and more emphatic.
                  Hidden for single clears so normal play stays
                  uncluttered. */}
              {preview &&
                preview.valid &&
                preview.clearedPatternsCount >= 2 && (
                  <span
                    key={preview.clearedPatternsCount}
                    className={[
                      'hexaclear-multi-clear-chip',
                      `hexaclear-multi-clear-tier-${Math.min(
                        4,
                        preview.clearedPatternsCount,
                      )}`,
                    ].join(' ')}
                    aria-hidden="true"
                  >
                    ×{preview.clearedPatternsCount}
                  </span>
                )}
            </div>
            )
          })()}
          {undoAnimation && (
            <div
              className="hexaclear-undo-animation"
              style={{
                left: undoAnimation.startX,
                top: undoAnimation.startY,
                '--undo-delta-x': `${undoAnimation.endX - undoAnimation.startX}px`,
                '--undo-delta-y': `${undoAnimation.endY - undoAnimation.startY}px`,
              } as React.CSSProperties & { '--undo-delta-x': string; '--undo-delta-y': string }}
            >
              <PiecePreview
                shape={undoAnimation.piece.shape}
                mode="board"
                cubeStyles={glassCubeStylesForPiece(undoAnimation.piece)}
              />
            </div>
          )}
          {rescueAnimation && (
            <div
              className="hexaclear-rescue-animation"
              style={{
                left: rescueAnimation.startX,
                top: rescueAnimation.startY,
                '--rescue-delta-x': `${rescueAnimation.endX - rescueAnimation.startX}px`,
                '--rescue-delta-y': `${rescueAnimation.endY - rescueAnimation.startY}px`,
                '--rescue-end-scale': String(rescueAnimation.endScale),
              } as React.CSSProperties & {
                '--rescue-delta-x': string
                '--rescue-delta-y': string
                '--rescue-end-scale': string
              }}
            >
              {/* hand mode (not board) so the overlay starts at the same
                  pixel size as the source hand slot and ends at the
                  pocket scale (`--rescue-end-scale`). With board mode
                  the overlay was several times bigger than the pocket
                  render, so the swap at the end of the flight was a
                  visible size jump. */}
              <PiecePreview
                shape={rescueAnimation.piece.shape}
                mode="hand"
                cubeStyles={glassCubeStylesForPiece(rescueAnimation.piece)}
              />
            </div>
          )}
          {game.mode === 'daily' &&
            game.dailyCompleted &&
            game.gameOver &&
            dailyGameOverDismissed && (
              <div
                className="hexaclear-daily-cleared-badge"
                role="status"
                aria-label="Daily puzzle cleared"
              >
                <span className="hexaclear-daily-cleared-check" aria-hidden="true">
                  ✓
                </span>
                <span className="hexaclear-daily-cleared-label">
                  Daily Cleared
                </span>
              </div>
            )}
          {scorePopup && game.mode !== 'daily' && (
            <div className="hexaclear-score-popup">{scorePopup}</div>
          )}
          {scoreParticles.length > 0 && (
            <div className="hexaclear-score-particles">
              {scoreParticles.map((particle) => {
                const isNegative = particle.value < 0
                const valueText = isNegative
                  ? String(particle.value)
                  : `+${particle.value}`
                return (
                  <div
                    key={particle.id}
                    className={`hexaclear-score-particle hexaclear-score-particle-${particle.type}${
                      isNegative ? ' is-negative' : ''
                    }`}
                    style={{
                      left: particle.startX,
                      top: particle.startY,
                      '--particle-delta-x': `${particle.deltaX}px`,
                      '--particle-delta-y': `${particle.deltaY}px`,
                      animationDelay: `${particle.delay}ms`,
                    } as React.CSSProperties & {
                      '--particle-delta-x': string
                      '--particle-delta-y': string
                    }}
                  >
                    <span className="hexaclear-score-particle-value">
                      {valueText}
                    </span>
                    {particle.label && (
                      <span className="hexaclear-score-particle-label">
                        {particle.label}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {game.gameOver && game.mode === 'endless' && !gameOverWindingDown && (
            <div className="hexaclear-overlay">
              <div className="hexaclear-overlay-card hexaclear-gameover-card">
                <div className="title">Game Over</div>

                <div className="hexaclear-gameover-headline">
                  <div className="hexaclear-gameover-headline-label">
                    Final score
                  </div>
                  <div className="hexaclear-gameover-headline-value">
                    {game.score}
                  </div>
                </div>

                {!showTutorialEndScreen && modalHighlightSnapshot && (
                  <HighlightReel snapshot={modalHighlightSnapshot} />
                )}

                {!showTutorialEndScreen && renderRunStatsSection()}

                {showTutorialEndScreen && (
                  <div className="hexaclear-gameover-ftue-reason">
                    No valid moves remaining!
                  </div>
                )}

                {showTutorialEndScreen && (
                  <div className="hexaclear-gameover-section hexaclear-gameover-daily-intro">
                    <div className="hexaclear-gameover-section-label">
                      Quick puzzle
                    </div>
                    <p className="hexaclear-gameover-daily-intro-copy">
                      Try today&apos;s Daily! Everyone gets the same board and
                      pieces - you just have to clear some special cubes in the
                      fewest moves you can.
                    </p>
                    <button
                      type="button"
                      className="hexaclear-gameover-cta hexaclear-gameover-cta-secondary hexaclear-gameover-daily-intro-cta"
                      onClick={() => {
                        playUiClick()
                        if (pendingHighScore) {
                          handleSaveHighScore()
                        }
                        markDailyIntroSeen()
                        setTutorialEndScreenPending(false)
                        toggleMode('daily')
                      }}
                    >
                      Try today&apos;s Daily
                    </button>
                  </div>
                )}

                {(() => {
                  // Endless gameover leaderboard. Defaults to a
                  // compact top-3 view to keep the modal short on
                  // phones; the "Show all" toggle expands to the
                  // full paginated list. The save-score input is
                  // integrated into the section header below the
                  // global toggle so the modal carries one fewer
                  // stacked section. The "you" highlight tracks the
                  // player's best entry in whichever view is
                  // showing — for global that's their playerId row
                  // (one-per-player by construction), for local
                  // it's the just-saved run.
                  //
                  // When expanded, the list paginates
                  // `GAMEOVER_LEADERBOARD_PAGE_SIZE` rows at a time
                  // (up to the top-30 cap) and defaults to whichever
                  // page contains the just-saved row.
                  const localTop = highScores
                    .slice()
                    .sort((a, b) => b.score - a.score || a.date - b.date)
                  const globalLoading =
                    showGlobalLeaderboard && globalEndlessScores === undefined
                  const globalTop = (globalEndlessScores ?? []).slice()
                  const usingGlobal = showGlobalLeaderboard
                  const expanded = gameoverLeaderboardExpanded
                  const playerGlobalIndex = globalTop.findIndex(
                    (e) => e.playerId === playerId,
                  )
                  const playerGlobalRank =
                    playerGlobalIndex === -1 ? null : playerGlobalIndex + 1
                  const playerGlobalEntry =
                    playerGlobalIndex === -1
                      ? null
                      : globalTop[playerGlobalIndex]
                  // Local "you" identification: the just-saved row
                  // matched by saveDate (when the player saved this
                  // run). If they haven't saved this run yet, we
                  // can't pin a specific row — pinned-you only
                  // applies once they've committed.
                  const playerLocalIndex =
                    highScoreSaved && lastSavedHighScoreDate !== null
                      ? localTop.findIndex(
                          (e) => e.date === lastSavedHighScoreDate,
                        )
                      : -1
                  const playerLocalRank =
                    playerLocalIndex === -1 ? null : playerLocalIndex + 1
                  // Pagination math (only used when expanded).
                  const localPageCount = Math.max(
                    1,
                    Math.ceil(
                      localTop.length / GAMEOVER_LEADERBOARD_PAGE_SIZE,
                    ),
                  )
                  const localPageIndex = Math.min(
                    Math.max(0, gameoverEndlessPage),
                    localPageCount - 1,
                  )
                  const localPageStart =
                    localPageIndex * GAMEOVER_LEADERBOARD_PAGE_SIZE
                  const localWindow = localTop.slice(
                    localPageStart,
                    localPageStart + GAMEOVER_LEADERBOARD_PAGE_SIZE,
                  )
                  const globalPageCount = Math.max(
                    1,
                    Math.ceil(
                      globalTop.length / GAMEOVER_LEADERBOARD_PAGE_SIZE,
                    ),
                  )
                  const globalPageIndex = Math.min(
                    Math.max(0, gameoverEndlessGlobalPage),
                    globalPageCount - 1,
                  )
                  const globalPageStart =
                    globalPageIndex * GAMEOVER_LEADERBOARD_PAGE_SIZE
                  const globalVisible = globalTop.slice(
                    globalPageStart,
                    globalPageStart + GAMEOVER_LEADERBOARD_PAGE_SIZE,
                  )
                  const globalShowsPlayer =
                    playerGlobalIndex >= globalPageStart &&
                    playerGlobalIndex <
                      globalPageStart + GAMEOVER_LEADERBOARD_PAGE_SIZE
                  // Hide the entire section when there's nothing to
                  // show AND nothing to save. If the player has a
                  // pending high score we keep the section so the
                  // save input has a home (it lives in this
                  // section's header now).
                  if (
                    !usingGlobal &&
                    localTop.length === 0 &&
                    !globalLoading &&
                    !pendingHighScore
                  ) {
                    return null
                  }
                  // Save-input subsection — appears at the top of
                  // the leaderboard section (right under the title +
                  // global toggle) whenever there's a pending save.
                  // Used to be a standalone section above the
                  // leaderboard; merging here saves one stacked
                  // chrome row of "label + padding".
                  const saveSubsection = pendingHighScore ? (
                    <div className="hexaclear-gameover-save-inline">
                      <div className="hexaclear-gameover-save-inline-label">
                        {(() => {
                          // Global submission only fires when the
                          // run also dethrones the device's local
                          // #1 (per the gating in
                          // handleSaveHighScore). Surface a "local
                          // only" hint for top-30-but-not-#1 runs
                          // so the player knows their save isn't
                          // hitting the global board.
                          const currentTop = highScores[0]?.score ?? -Infinity
                          const wouldBeNewBest =
                            pendingScore !== null && pendingScore > currentTop
                          if (wouldBeNewBest) return 'New high score'
                          const localRank =
                            pendingScore === null
                              ? null
                              : highScores.filter(
                                  (entry) => entry.score >= pendingScore,
                                ).length + 1
                          return localRank === null
                            ? 'New local high score'
                            : `New local high score (#${localRank})`
                        })()}
                      </div>
                      <div className="hexaclear-gameover-input-row">
                        <input
                          className="hexaclear-input"
                          value={playerName}
                          onChange={(e) => setPlayerName(e.target.value)}
                          placeholder="Your name"
                        />
                        <button
                          type="button"
                          className="hexaclear-gameover-save-button"
                          onClick={() => {
                            playUiClick()
                            handleSaveHighScore()
                          }}
                        >
                          Save score
                        </button>
                      </div>
                    </div>
                  ) : null
                  // Compact body: top-3 rows + optional pinned "you"
                  // row when the player is outside top 3. The pin
                  // gets a visual divider above it so it reads as
                  // separated from the top-3 cluster.
                  const renderCompactList = (
                    rows: Array<{
                      key: string
                      rank: number
                      name: string
                      value: string
                      isYou: boolean
                    }>,
                    playerRank: number | null,
                    playerRow: {
                      key: string
                      name: string
                      value: string
                    } | null,
                  ) => {
                    if (rows.length === 0) {
                      return (
                        <p className="hexaclear-scores-empty">
                          {usingGlobal
                            ? 'No global scores yet — be the first.'
                            : highScoreSaved
                              ? 'Saved!'
                              : 'No saved scores yet.'}
                        </p>
                      )
                    }
                    const showPin =
                      playerRank !== null && playerRow !== null && playerRank > 3
                    return (
                      <ol className="hexaclear-scores-list">
                        {rows.map((row) => {
                          const chipClass = [
                            'hexaclear-rank-chip',
                            row.rank === 1
                              ? 'hexaclear-chip-trophy'
                              : row.rank <= 3
                                ? 'hexaclear-chip-gold'
                                : 'hexaclear-chip-neutral',
                          ].join(' ')
                          return (
                            <li
                              key={row.key}
                              className={[
                                'hexaclear-scores-row',
                                row.isYou ? 'recent' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                            >
                              <span className={chipClass}>{row.rank}</span>
                              <span className="hexaclear-scores-name">
                                {row.name}
                                {row.isYou && usingGlobal ? ' (you)' : ''}
                              </span>
                              <span className="hexaclear-scores-value">
                                {row.value}
                              </span>
                            </li>
                          )
                        })}
                        {showPin && (
                          <li
                            key={`pin-${playerRow.key}`}
                            className="hexaclear-scores-row recent hexaclear-scores-row-pinned"
                            aria-label={`Your row: rank ${playerRank}`}
                          >
                            <span className="hexaclear-rank-chip hexaclear-chip-neutral">
                              {playerRank}
                            </span>
                            <span className="hexaclear-scores-name">
                              {playerRow.name}
                              {usingGlobal ? ' (you)' : ''}
                            </span>
                            <span className="hexaclear-scores-value">
                              {playerRow.value}
                            </span>
                          </li>
                        )}
                      </ol>
                    )
                  }
                  // Pre-shaped row arrays for the compact renderer so
                  // local/global share a single render path.
                  const localCompactRows = localTop.slice(0, 3).map(
                    (entry, idx) => ({
                      key: `${entry.date}-${entry.name}-${idx}`,
                      rank: idx + 1,
                      name: entry.name,
                      value: String(entry.score),
                      isYou:
                        highScoreSaved &&
                        lastSavedHighScoreDate !== null &&
                        entry.date === lastSavedHighScoreDate,
                    }),
                  )
                  const localPlayerRow =
                    playerLocalIndex >= 0
                      ? {
                          key: `local-you-${localTop[playerLocalIndex].date}`,
                          name: localTop[playerLocalIndex].name,
                          value: String(localTop[playerLocalIndex].score),
                        }
                      : null
                  const globalCompactRows = globalTop.slice(0, 3).map(
                    (entry, idx) => ({
                      key: `${entry.savedAt}-${entry.playerId}-${idx}`,
                      rank: idx + 1,
                      name: entry.name,
                      value: String(entry.score),
                      isYou: entry.playerId === playerId,
                    }),
                  )
                  const globalPlayerRow =
                    playerGlobalEntry !== null
                      ? {
                          key: `global-you-${playerGlobalEntry.playerId}`,
                          name: playerGlobalEntry.name,
                          value: String(playerGlobalEntry.score),
                        }
                      : null
                  // "Show all (N)" / "Show fewer" toggle. Only render
                  // when there are more rows than the compact view
                  // surfaces; if the leaderboard is already <= 3
                  // entries (plus a pinned-you), expanding wouldn't
                  // reveal anything new.
                  const visibleCount = usingGlobal
                    ? globalTop.length
                    : localTop.length
                  const compactSurfaceCount =
                    Math.min(3, visibleCount) +
                    ((usingGlobal ? playerGlobalRank : playerLocalRank) !==
                      null &&
                    (usingGlobal ? playerGlobalRank : playerLocalRank)! > 3
                      ? 1
                      : 0)
                  const canExpand = visibleCount > compactSurfaceCount
                  return (
                    <div className="hexaclear-gameover-section">
                      <div className="hexaclear-gameover-section-header">
                        <div className="hexaclear-gameover-section-label">
                          Top scores{usingGlobal ? ' (global)' : ''}
                        </div>
                        <label className="hexaclear-scores-global-toggle hexaclear-gameover-toggle">
                          <input
                            type="checkbox"
                            checked={showGlobalLeaderboard}
                            onChange={(e) => {
                              playUiClick()
                              setShowGlobalLeaderboard(e.target.checked)
                            }}
                          />
                          <span>Global</span>
                        </label>
                      </div>
                      {saveSubsection}
                      {globalLoading ? (
                        <p className="hexaclear-scores-empty">
                          Loading global scores…
                        </p>
                      ) : usingGlobal ? (
                        expanded ? (
                          <>
                            {globalVisible.length === 0 ? (
                              <p className="hexaclear-scores-empty">
                                No global scores yet — be the first.
                              </p>
                            ) : (
                              <ol className="hexaclear-scores-list">
                                {globalVisible.map((entry, idx) => {
                                  const rank = globalPageStart + idx + 1
                                  const isYou = entry.playerId === playerId
                                  const chipClass = [
                                    'hexaclear-rank-chip',
                                    rank === 1
                                      ? 'hexaclear-chip-trophy'
                                      : rank <= 3
                                        ? 'hexaclear-chip-gold'
                                        : 'hexaclear-chip-neutral',
                                  ].join(' ')
                                  return (
                                    <li
                                      key={
                                        entry.savedAt +
                                        entry.playerId +
                                        idx
                                      }
                                      className={[
                                        'hexaclear-scores-row',
                                        isYou ? 'recent' : '',
                                      ]
                                        .filter(Boolean)
                                        .join(' ')}
                                    >
                                      <span className={chipClass}>{rank}</span>
                                      <span className="hexaclear-scores-name">
                                        {entry.name}
                                        {isYou ? ' (you)' : ''}
                                      </span>
                                      <span className="hexaclear-scores-value">
                                        {entry.score}
                                      </span>
                                    </li>
                                  )
                                })}
                              </ol>
                            )}
                            {globalPageCount > 1 && (
                              <div className="hexaclear-scores-pagination">
                                <button
                                  type="button"
                                  className="hexaclear-scores-page-step"
                                  aria-label="Previous page"
                                  onClick={() => {
                                    playUiClick()
                                    setGameoverEndlessGlobalPage((p) =>
                                      Math.max(0, p - 1),
                                    )
                                  }}
                                  disabled={globalPageIndex === 0}
                                >
                                  ‹
                                </button>
                                <span className="hexaclear-scores-page-label">
                                  {globalPageStart + 1}–
                                  {Math.min(
                                    globalPageStart +
                                      GAMEOVER_LEADERBOARD_PAGE_SIZE,
                                    globalTop.length,
                                  )}{' '}
                                  of {globalTop.length}
                                </span>
                                <button
                                  type="button"
                                  className="hexaclear-scores-page-step"
                                  aria-label="Next page"
                                  onClick={() => {
                                    playUiClick()
                                    setGameoverEndlessGlobalPage((p) =>
                                      Math.min(globalPageCount - 1, p + 1),
                                    )
                                  }}
                                  disabled={
                                    globalPageIndex >= globalPageCount - 1
                                  }
                                >
                                  ›
                                </button>
                              </div>
                            )}
                            {playerGlobalRank !== null &&
                              !globalShowsPlayer &&
                              playerGlobalEntry && (
                                <p className="hexaclear-scores-your-rank">
                                  Your rank: #{playerGlobalRank} ·{' '}
                                  {playerGlobalEntry.score}
                                </p>
                              )}
                            {playerGlobalRank === null && highScoreSaved && (
                              <p className="hexaclear-scores-your-rank">
                                Not on the global board yet.
                              </p>
                            )}
                          </>
                        ) : (
                          <>
                            {renderCompactList(
                              globalCompactRows,
                              playerGlobalRank,
                              globalPlayerRow,
                            )}
                            {playerGlobalRank === null && highScoreSaved && (
                              <p className="hexaclear-scores-your-rank">
                                Not on the global board yet.
                              </p>
                            )}
                          </>
                        )
                      ) : expanded ? (
                        <>
                          <ol className="hexaclear-scores-list">
                            {localWindow.map((entry, idx) => {
                              const isRecent =
                                highScoreSaved &&
                                lastSavedHighScoreDate !== null &&
                                entry.date === lastSavedHighScoreDate
                              const rank = localPageStart + idx + 1
                              const chipClass = [
                                'hexaclear-rank-chip',
                                rank === 1
                                  ? 'hexaclear-chip-trophy'
                                  : rank <= 3
                                    ? 'hexaclear-chip-gold'
                                    : 'hexaclear-chip-neutral',
                              ].join(' ')
                              return (
                                <li
                                  key={entry.date + entry.name + rank}
                                  className={[
                                    'hexaclear-scores-row',
                                    isRecent ? 'recent' : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' ')}
                                >
                                  <span className={chipClass}>{rank}</span>
                                  <span className="hexaclear-scores-name">
                                    {entry.name}
                                  </span>
                                  <span className="hexaclear-scores-value">
                                    {entry.score}
                                  </span>
                                </li>
                              )
                            })}
                          </ol>
                          {localPageCount > 1 && (
                            <div className="hexaclear-scores-pagination">
                              <button
                                type="button"
                                className="hexaclear-scores-page-step"
                                aria-label="Previous page"
                                onClick={() => {
                                  playUiClick()
                                  setGameoverEndlessPage((p) =>
                                    Math.max(0, p - 1),
                                  )
                                }}
                                disabled={localPageIndex === 0}
                              >
                                ‹
                              </button>
                              <span className="hexaclear-scores-page-label">
                                {localPageStart + 1}–
                                {Math.min(
                                  localPageStart +
                                    GAMEOVER_LEADERBOARD_PAGE_SIZE,
                                  localTop.length,
                                )}{' '}
                                of {localTop.length}
                              </span>
                              <button
                                type="button"
                                className="hexaclear-scores-page-step"
                                aria-label="Next page"
                                onClick={() => {
                                  playUiClick()
                                  setGameoverEndlessPage((p) =>
                                    Math.min(localPageCount - 1, p + 1),
                                  )
                                }}
                                disabled={
                                  localPageIndex >= localPageCount - 1
                                }
                              >
                                ›
                              </button>
                            </div>
                          )}
                        </>
                      ) : (
                        renderCompactList(
                          localCompactRows,
                          playerLocalRank,
                          localPlayerRow,
                        )
                      )}
                      {canExpand && (
                        <button
                          type="button"
                          className="hexaclear-scores-expand-toggle"
                          onClick={() => {
                            playUiClick()
                            setGameoverLeaderboardExpanded((v) => !v)
                          }}
                          aria-expanded={expanded}
                        >
                          {expanded
                            ? 'Show fewer'
                            : `Show all (${visibleCount})`}
                        </button>
                      )}
                    </div>
                  )
                })()}

                <div className="hexaclear-gameover-footer">
                  {undoStack.length > 0 && !highScoreSaved && (
                    <button
                      type="button"
                      className="hexaclear-menu-link"
                      onClick={() => {
                        playUiClick()
                        handleUndo()
                      }}
                    >
                      Undo last move
                    </button>
                  )}

                  <button
                    type="button"
                    className="hexaclear-gameover-cta"
                    onClick={() => {
                      playUiClick()
                      // Autosave the high score on dismiss so the
                      // "Save score" button is just a confirm shortcut —
                      // if the player walks away without clicking it
                      // (or without typing a custom name) we still log
                      // their run with whatever's in the field.
                      if (pendingHighScore) {
                        handleSaveHighScore()
                      }
                      if (showTutorialEndScreen) {
                        markDailyIntroSeen()
                        setTutorialEndScreenPending(false)
                      }
                      resetGame()
                    }}
                  >
                    {showTutorialEndScreen ? 'Play Endless Again' : 'Play again'}
                  </button>
                </div>
              </div>
            </div>
          )}
          {game.gameOver &&
            game.mode === 'big' &&
            !gameOverWindingDown &&
            isMultiplayer &&
            mp.mode === 'pvp' &&
            (() => {
              // PvP-specific game-over modal. Two variants on the same
              // shell: a "WIN" celebration when winnerPlayerId is set,
              // and a desaturated "SHAME — NOBODY WINS" screen when
              // every seated player got stuck before anyone crossed
              // the threshold. Both variants show the final
              // territory standings so each player sees how close
              // they were.
              const selfId = mp.selfPlayer?.playerId ?? null
              const winnerId = mp.winnerPlayerId
              const isShame = winnerId === null
              const selfWon = !isShame && winnerId === selfId
              const nameByPlayerId = new Map<string, string>()
              for (const p of mp.allPlayers) {
                nameByPlayerId.set(p.playerId, p.name)
              }
              const winnerName =
                winnerId !== null
                  ? nameByPlayerId.get(winnerId) ?? 'Player'
                  : null
              // Same theme-aware rule as the in-game HUD so the
              // final standings on this modal match the colors the
              // player saw on the board the whole match.
              const colorForPlayer = (pid: string): string => {
                const hue = mp.hueShiftByPlayerId[pid] ?? 0
                if (theme === 'win98') {
                  return pid === selfId
                    ? W98_SELF_FILL_HEX
                    : tintCubeColor(W98_PARTNER_FILL_HEX, hue, 0, 1)
                }
                return tintCubeColor(WOOD_CUBE_LEFT_HEX, hue, 0.05, 0.95)
              }
              const thresholdPct = Math.round(mp.pvpThresholdRatio * 100)
              return (
                <div className="hexaclear-overlay">
                  <div
                    className={[
                      'hexaclear-overlay-card',
                      'hexaclear-gameover-card',
                      'hexaclear-pvp-gameover',
                      isShame ? 'is-shame' : 'is-win',
                      selfWon ? 'is-self-won' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {isShame ? (
                      <>
                        <div className="title hexaclear-pvp-shame-title">
                          SHAME
                        </div>
                        <div className="hexaclear-pvp-shame-subtitle">
                          NOBODY WINS
                        </div>
                        <div className="hexaclear-pvp-shame-blurb">
                          Every player ran out of moves before anyone
                          claimed {thresholdPct}% of the field.
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="title hexaclear-pvp-win-title">
                          {selfWon ? 'You Win!' : `${winnerName} Wins`}
                        </div>
                        <div className="hexaclear-pvp-win-subtitle">
                          First past {thresholdPct}% of the field.
                        </div>
                      </>
                    )}

                    <div className="hexaclear-pvp-standings">
                      <div className="hexaclear-pvp-standings-label">
                        Final standings
                      </div>
                      <ol className="hexaclear-pvp-standings-list">
                        {mp.pvpStandings.map((s, idx) => {
                          const name =
                            s.playerId === selfId
                              ? 'You'
                              : nameByPlayerId.get(s.playerId) ?? 'Player'
                          const isWinner = s.playerId === winnerId
                          return (
                            <li
                              key={s.playerId}
                              className={[
                                'hexaclear-pvp-standings-row',
                                isWinner ? 'is-winner' : '',
                                s.playerId === selfId ? 'is-self' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                            >
                              <span className="hexaclear-pvp-standings-rank">
                                {idx + 1}
                              </span>
                              <span
                                className="hexaclear-pvp-standings-swatch"
                                style={{
                                  background: colorForPlayer(s.playerId),
                                }}
                                aria-hidden="true"
                              />
                              <span className="hexaclear-pvp-standings-name">
                                {name}
                              </span>
                              <span className="hexaclear-pvp-standings-pct">
                                {Math.round(s.ratio * 100)}%
                              </span>
                            </li>
                          )
                        })}
                      </ol>
                    </div>

                    {!mp.isSpectator && (
                      <button
                        type="button"
                        className="hexaclear-gameover-cta"
                        onClick={() => {
                          playUiClick()
                          handleRestartCoop()
                        }}
                      >
                        New match
                      </button>
                    )}
                    <button
                      type="button"
                      className="hexaclear-menu-link"
                      onClick={() => {
                        playUiClick()
                        handleLeaveRoom()
                      }}
                    >
                      Back to single player
                    </button>
                  </div>
                </div>
              )
            })()}
          {game.gameOver &&
            game.mode === 'big' &&
            !gameOverWindingDown &&
            !(isMultiplayer && mp.mode === 'pvp') && (
            <div className="hexaclear-overlay">
              <div className="hexaclear-overlay-card hexaclear-gameover-card">
                <div className="title">
                  {isMultiplayer ? 'Co-op finished' : 'Game Over'}
                </div>

                <div className="hexaclear-gameover-headline">
                  <div className="hexaclear-gameover-headline-label">
                    Final score
                  </div>
                  <div className="hexaclear-gameover-headline-value">
                    {game.score}
                  </div>
                </div>

                {!isMultiplayer && undoStack.length > 0 && (
                  <button
                    type="button"
                    className="hexaclear-menu-link"
                    onClick={() => {
                      playUiClick()
                      handleUndo()
                    }}
                  >
                    Undo last move
                  </button>
                )}

                {modalHighlightSnapshot && (
                  <HighlightReel snapshot={modalHighlightSnapshot} />
                )}

                {renderRunStatsSection()}

                {isMultiplayer && (() => {
                  // Co-op gameover leaderboard. The local view shows
                  // every co-op partnership this device has scored
                  // with, deduped to each one's best run; the global
                  // view shows every group's best ever co-op run
                  // across all devices. Highlight the row for the
                  // group that just finished — by groupKey locally,
                  // by canonical playerIdsKey globally.
                  const localTop = coopHighScores
                    .slice()
                    .sort((a, b) => b.score - a.score || a.date - b.date)
                  const globalLoading =
                    showGlobalLeaderboard && globalCoopScores === undefined
                  const globalTop = (globalCoopScores ?? []).slice()
                  const usingGlobal = showGlobalLeaderboard
                  const visibleCount = GAMEOVER_LEADERBOARD_PAGE_SIZE
                  const localVisible = localTop.slice(0, visibleCount)
                  const groupKey = lastCoopSavedGroupKey
                  const groupGlobalIndex =
                    groupKey === null
                      ? -1
                      : globalTop.findIndex(
                          (e) => (e.playerIdsKey ?? '') === groupKey,
                        )
                  const groupGlobalRank =
                    groupGlobalIndex === -1 ? null : groupGlobalIndex + 1
                  const groupGlobalEntry =
                    groupGlobalIndex === -1
                      ? null
                      : globalTop[groupGlobalIndex]
                  // Co-op global pagination — snap effect points us
                  // at the page containing the group's row.
                  const globalPageCount = Math.max(
                    1,
                    Math.ceil(
                      globalTop.length / GAMEOVER_LEADERBOARD_PAGE_SIZE,
                    ),
                  )
                  const globalPageIndex = Math.min(
                    Math.max(0, gameoverCoopGlobalPage),
                    globalPageCount - 1,
                  )
                  const globalPageStart =
                    globalPageIndex * GAMEOVER_LEADERBOARD_PAGE_SIZE
                  const globalVisible = globalTop.slice(
                    globalPageStart,
                    globalPageStart + GAMEOVER_LEADERBOARD_PAGE_SIZE,
                  )
                  const globalShowsGroup =
                    groupGlobalIndex >= globalPageStart &&
                    groupGlobalIndex <
                      globalPageStart + GAMEOVER_LEADERBOARD_PAGE_SIZE
                  const showSection =
                    usingGlobal ||
                    localVisible.length > 0 ||
                    lastCoopSavedScore !== null
                  if (!showSection) return null
                  return (
                    <div className="hexaclear-gameover-section">
                      <div className="hexaclear-gameover-section-header">
                        <div className="hexaclear-gameover-section-label">
                          Co-op leaderboard
                          {usingGlobal ? ' (global)' : ''}
                        </div>
                        <label className="hexaclear-scores-global-toggle hexaclear-gameover-toggle">
                          <input
                            type="checkbox"
                            checked={showGlobalLeaderboard}
                            onChange={(e) => {
                              playUiClick()
                              setShowGlobalLeaderboard(e.target.checked)
                            }}
                          />
                          <span>Global</span>
                        </label>
                      </div>
                      {globalLoading ? (
                        <p className="hexaclear-scores-empty">
                          Loading global scores…
                        </p>
                      ) : usingGlobal ? (
                        <>
                          {globalVisible.length === 0 ? (
                            <p className="hexaclear-scores-empty">
                              No global co-op scores yet — be the first.
                            </p>
                          ) : (
                            <ol className="hexaclear-scores-list">
                              {globalVisible.map((entry, idx) => {
                                const rank = globalPageStart + idx + 1
                                const isYou =
                                  groupKey !== null &&
                                  (entry.playerIdsKey ?? '') === groupKey
                                const chipClass = [
                                  'hexaclear-rank-chip',
                                  rank === 1
                                    ? 'hexaclear-chip-trophy'
                                    : rank <= 3
                                      ? 'hexaclear-chip-gold'
                                      : 'hexaclear-chip-neutral',
                                ].join(' ')
                                return (
                                  <li
                                    key={entry.finishedAt + entry.name + idx}
                                    className={[
                                      'hexaclear-scores-row',
                                      isYou ? 'recent' : '',
                                    ]
                                      .filter(Boolean)
                                      .join(' ')}
                                  >
                                    <span className={chipClass}>{rank}</span>
                                    <span className="hexaclear-scores-name">
                                      {entry.name}
                                      {isYou ? ' (you)' : ''}
                                    </span>
                                    <span className="hexaclear-scores-value">
                                      {entry.score}
                                    </span>
                                  </li>
                                )
                              })}
                            </ol>
                          )}
                          {globalPageCount > 1 && (
                            <div className="hexaclear-scores-pagination">
                              <button
                                type="button"
                                className="hexaclear-scores-page-step"
                                aria-label="Previous page"
                                onClick={() => {
                                  playUiClick()
                                  setGameoverCoopGlobalPage((p) =>
                                    Math.max(0, p - 1),
                                  )
                                }}
                                disabled={globalPageIndex === 0}
                              >
                                ‹
                              </button>
                              <span className="hexaclear-scores-page-label">
                                {globalPageStart + 1}–
                                {Math.min(
                                  globalPageStart +
                                    GAMEOVER_LEADERBOARD_PAGE_SIZE,
                                  globalTop.length,
                                )}{' '}
                                of {globalTop.length}
                              </span>
                              <button
                                type="button"
                                className="hexaclear-scores-page-step"
                                aria-label="Next page"
                                onClick={() => {
                                  playUiClick()
                                  setGameoverCoopGlobalPage((p) =>
                                    Math.min(globalPageCount - 1, p + 1),
                                  )
                                }}
                                disabled={
                                  globalPageIndex >= globalPageCount - 1
                                }
                              >
                                ›
                              </button>
                            </div>
                          )}
                          {groupGlobalRank !== null &&
                            !globalShowsGroup &&
                            groupGlobalEntry && (
                              <p className="hexaclear-scores-your-rank">
                                Your group's rank: #{groupGlobalRank} ·{' '}
                                {groupGlobalEntry.score}
                              </p>
                            )}
                          {groupGlobalRank === null && lastCoopSavedScore !== null && (
                            <p className="hexaclear-scores-your-rank">
                              Group not on the global board yet.
                            </p>
                          )}
                        </>
                      ) : localVisible.length === 0 ? (
                        <p className="hexaclear-scores-empty">
                          No co-op runs on this device yet.
                        </p>
                      ) : (
                        <ol className="hexaclear-scores-list">
                          {localVisible.map((entry, idx) => {
                            const isRecent =
                              groupKey !== null && entry.groupKey === groupKey
                            const rank = idx + 1
                            const chipClass = [
                              'hexaclear-rank-chip',
                              rank === 1
                                ? 'hexaclear-chip-trophy'
                                : rank <= 3
                                  ? 'hexaclear-chip-gold'
                                  : 'hexaclear-chip-neutral',
                            ].join(' ')
                            return (
                              <li
                                key={entry.groupKey + entry.date}
                                className={[
                                  'hexaclear-scores-row',
                                  isRecent ? 'recent' : '',
                                ]
                                  .filter(Boolean)
                                  .join(' ')}
                              >
                                <span className={chipClass}>{rank}</span>
                                <span className="hexaclear-scores-name">
                                  {entry.name}
                                </span>
                                <span className="hexaclear-scores-value">
                                  {entry.score}
                                </span>
                              </li>
                            )
                          })}
                        </ol>
                      )}
                    </div>
                  )
                })()}

                <div className="hexaclear-gameover-footer">
                  {isMultiplayer ? (
                    <>
                      {/* Keep the same room/partner — just rerack and
                          play again. Either player can fire it; the
                          server reset propagates to both clients.
                          Spectators don't get a restart button — the
                          match isn't theirs to restart. */}
                      {!mp.isSpectator && (
                        <button
                          type="button"
                          className="hexaclear-gameover-cta"
                          onClick={() => {
                            playUiClick()
                            handleRestartCoop()
                          }}
                        >
                          New game
                        </button>
                      )}
                      <button
                        type="button"
                        className="hexaclear-menu-link"
                        onClick={() => {
                          playUiClick()
                          handleLeaveRoom()
                        }}
                      >
                        Back to single player
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="hexaclear-gameover-cta"
                      onClick={() => {
                        playUiClick()
                        resetGame()
                      }}
                    >
                      Play again
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          {/* The old "Waiting for a partner…" modal is gone — Copy
              Link writes the URL straight to the clipboard without
              any overlay. While the room sits in 'waiting' state,
              the player keeps playing on the shared board so their
              run isn't blocked by a missing partner. */}
          {isMultiplayer && (mp.status === 'not-found' || mpError) && (
            <div className="hexaclear-overlay">
              <div className="hexaclear-overlay-card hexaclear-coop-error-card">
                <div className="title">Couldn't join</div>
                <p className="hexaclear-coop-error-message">
                  {mpError ||
                    (mp.status === 'not-found'
                      ? 'That room no longer exists. Try creating a new one.'
                      : 'Something went wrong.')}
                </p>
                <button
                  type="button"
                  className="hexaclear-reset"
                  onClick={() => {
                    playUiClick()
                    handleLeaveRoom()
                  }}
                >
                  Back to single player
                </button>
              </div>
            </div>
          )}
          {game.gameOver &&
            game.mode === 'daily' &&
            !gameOverWindingDown &&
            !dailyGameOverDismissed && (
            <div className="hexaclear-overlay">
              <div
                className={[
                  'hexaclear-overlay-card',
                  'hexaclear-gameover-card',
                  game.dailyCompleted ? 'daily-win' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div className="title">
                  {game.dailyCompleted ? 'Daily Cleared' : 'Daily Over'}
                </div>

                <div className="hexaclear-gameover-headline">
                  <div className="hexaclear-gameover-headline-label">
                    {game.dailyCompleted ? 'Cleared in' : 'Used'}
                  </div>
                  <div className="hexaclear-gameover-headline-value">
                    {game.moves}
                  </div>
                  <div className="hexaclear-gameover-headline-label">
                    {game.moves === 1 ? 'move' : 'moves'}
                  </div>
                </div>

                {!game.dailyCompleted && dailyCubesRemaining > 0 && (
                  <div className="hexaclear-gameover-subhead">
                    {dailyCubesRemaining}{' '}
                    {dailyCubesRemaining === 1 ? 'cube' : 'cubes'}{' '}
                    remained! Clear all numbered cubes to solve the
                    Daily puzzle.
                  </div>
                )}

                {renderRunStatsSection()}

                {(() => {
                  // Daily gameover leaderboard. Defaults to a
                  // compact top-3 view (with the player's own row
                  // pinned beneath if they're outside the top 3)
                  // so the modal stays short on phones; the "Show
                  // all" toggle expands to the full paginated list.
                  // The save-score input now lives inside the
                  // section header instead of as a separate stacked
                  // section above it. Daily ranks ascending by
                  // moves (fewest = best); the "you" highlight
                  // tracks the player's local best for the day
                  // (lastSavedDaily…) and, in the global view, the
                  // row whose playerId matches.
                  const localAll = todayPlayerDailyRuns
                  const globalLoading =
                    showGlobalLeaderboard && globalDailyScores === undefined
                  const globalTop = (globalDailyScores ?? []).slice()
                  const usingGlobal = showGlobalLeaderboard
                  const expanded = gameoverLeaderboardExpanded
                  const playerGlobalIndex = globalTop.findIndex(
                    (e) => e.playerId === playerId,
                  )
                  const playerGlobalRank =
                    playerGlobalIndex === -1 ? null : playerGlobalIndex + 1
                  const playerGlobalEntry =
                    playerGlobalIndex === -1
                      ? null
                      : globalTop[playerGlobalIndex]
                  // Local "you" identification: the just-saved daily
                  // run matched by saveDate. If they haven't saved
                  // this run yet, no pin is shown — pinned-you only
                  // applies once the result is committed.
                  const playerLocalIndex =
                    dailyHighScoreSaved &&
                    lastSavedDailyHighScoreDate !== null
                      ? localAll.findIndex(
                          (e) => e.date === lastSavedDailyHighScoreDate,
                        )
                      : -1
                  const playerLocalRank =
                    playerLocalIndex === -1 ? null : playerLocalIndex + 1
                  // Pagination math (expanded view only).
                  const localPageWindow = localAll.slice(
                    0,
                    GAMEOVER_LEADERBOARD_PAGE_SIZE,
                  )
                  const globalPageCount = Math.max(
                    1,
                    Math.ceil(
                      globalTop.length / GAMEOVER_LEADERBOARD_PAGE_SIZE,
                    ),
                  )
                  const globalPageIndex = Math.min(
                    Math.max(0, gameoverDailyGlobalPage),
                    globalPageCount - 1,
                  )
                  const globalPageStart =
                    globalPageIndex * GAMEOVER_LEADERBOARD_PAGE_SIZE
                  const globalVisible = globalTop.slice(
                    globalPageStart,
                    globalPageStart + GAMEOVER_LEADERBOARD_PAGE_SIZE,
                  )
                  const globalShowsPlayer =
                    playerGlobalIndex >= globalPageStart &&
                    playerGlobalIndex <
                      globalPageStart + GAMEOVER_LEADERBOARD_PAGE_SIZE
                  if (
                    !usingGlobal &&
                    localAll.length === 0 &&
                    !globalLoading &&
                    !pendingDailyHighScore
                  ) {
                    return null
                  }
                  const formatDailyMoves = (n: number) =>
                    `${n} ${n === 1 ? 'move' : 'moves'}`
                  const saveSubsection = pendingDailyHighScore ? (
                    <div className="hexaclear-gameover-save-inline">
                      <div className="hexaclear-gameover-save-inline-label">
                        {game.dailyCompleted
                          ? 'New daily best'
                          : 'Log this attempt'}
                      </div>
                      <div className="hexaclear-gameover-input-row">
                        <input
                          className="hexaclear-input"
                          value={playerName}
                          onChange={(e) => setPlayerName(e.target.value)}
                          placeholder="Your name"
                        />
                        <button
                          type="button"
                          className="hexaclear-gameover-save-button"
                          onClick={() => {
                            playUiClick()
                            handleSaveDailyHighScore()
                          }}
                        >
                          Save daily result
                        </button>
                      </div>
                    </div>
                  ) : null
                  const renderCompactList = (
                    rows: Array<{
                      key: string
                      rank: number
                      name: string
                      value: string
                      isYou: boolean
                    }>,
                    playerRank: number | null,
                    playerRow: {
                      key: string
                      name: string
                      value: string
                    } | null,
                  ) => {
                    if (rows.length === 0) {
                      return (
                        <p className="hexaclear-scores-empty">
                          {usingGlobal
                            ? 'No global daily scores yet — be the first.'
                            : 'No saved attempts yet.'}
                        </p>
                      )
                    }
                    const showPin =
                      playerRank !== null && playerRow !== null && playerRank > 3
                    return (
                      <ol className="hexaclear-scores-list">
                        {rows.map((row) => {
                          const chipClass = [
                            'hexaclear-rank-chip',
                            row.rank === 1
                              ? 'hexaclear-chip-trophy'
                              : row.rank <= 3
                                ? 'hexaclear-chip-gold'
                                : 'hexaclear-chip-neutral',
                          ].join(' ')
                          return (
                            <li
                              key={row.key}
                              className={[
                                'hexaclear-scores-row',
                                row.isYou ? 'recent' : '',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                            >
                              <span className={chipClass}>{row.rank}</span>
                              <span className="hexaclear-scores-name">
                                {row.name}
                                {row.isYou && usingGlobal ? ' (you)' : ''}
                              </span>
                              <span className="hexaclear-scores-value">
                                {row.value}
                              </span>
                            </li>
                          )
                        })}
                        {showPin && (
                          <li
                            key={`pin-${playerRow.key}`}
                            className="hexaclear-scores-row recent hexaclear-scores-row-pinned"
                            aria-label={`Your row: rank ${playerRank}`}
                          >
                            <span className="hexaclear-rank-chip hexaclear-chip-neutral">
                              {playerRank}
                            </span>
                            <span className="hexaclear-scores-name">
                              {playerRow.name}
                              {usingGlobal ? ' (you)' : ''}
                            </span>
                            <span className="hexaclear-scores-value">
                              {playerRow.value}
                            </span>
                          </li>
                        )}
                      </ol>
                    )
                  }
                  const localCompactRows = localAll.slice(0, 3).map(
                    (entry, idx) => ({
                      key: `${entry.date}-${entry.name || 'you'}-${idx}`,
                      rank: idx + 1,
                      name: entry.name || 'You',
                      value: formatDailyMoves(entry.moves),
                      isYou:
                        dailyHighScoreSaved &&
                        lastSavedDailyHighScoreDate !== null &&
                        entry.date === lastSavedDailyHighScoreDate,
                    }),
                  )
                  const localPlayerRow =
                    playerLocalIndex >= 0
                      ? {
                          key: `local-you-${localAll[playerLocalIndex].date}`,
                          name: localAll[playerLocalIndex].name || 'You',
                          value: formatDailyMoves(
                            localAll[playerLocalIndex].moves,
                          ),
                        }
                      : null
                  const globalCompactRows = globalTop.slice(0, 3).map(
                    (entry, idx) => ({
                      key: `${entry.savedAt}-${entry.playerId}-${idx}`,
                      rank: idx + 1,
                      name: entry.name,
                      value: formatDailyMoves(entry.moves),
                      isYou: entry.playerId === playerId,
                    }),
                  )
                  const globalPlayerRow =
                    playerGlobalEntry !== null
                      ? {
                          key: `global-you-${playerGlobalEntry.playerId}`,
                          name: playerGlobalEntry.name,
                          value: formatDailyMoves(playerGlobalEntry.moves),
                        }
                      : null
                  const visibleCount = usingGlobal
                    ? globalTop.length
                    : localAll.length
                  const compactSurfaceCount =
                    Math.min(3, visibleCount) +
                    ((usingGlobal ? playerGlobalRank : playerLocalRank) !==
                      null &&
                    (usingGlobal ? playerGlobalRank : playerLocalRank)! > 3
                      ? 1
                      : 0)
                  const canExpand = visibleCount > compactSurfaceCount
                  return (
                    <div className="hexaclear-gameover-section">
                      <div className="hexaclear-gameover-section-header">
                        <div className="hexaclear-gameover-section-label">
                          {(() => {
                            // When the player just finished an
                            // archive-day daily, both local and
                            // global lists below reflect THAT day's
                            // attempts. Surface the date so the
                            // moves-vs-leaderboard comparison reads
                            // cleanly without the player wondering
                            // why "today's" list looks off. Today's
                            // run keeps the original "today" copy.
                            const runDateKey =
                              game.dailyDateKey ?? getTodayKey()
                            const isHistorical =
                              runDateKey !== getTodayKey()
                            if (usingGlobal) {
                              return isHistorical
                                ? `${formatFriendlyDateKey(runDateKey)} · global · fewest moves`
                                : 'Today · global · fewest moves'
                            }
                            return isHistorical
                              ? `Your best on ${formatFriendlyDateKey(runDateKey)}`
                              : 'Your best today'
                          })()}
                        </div>
                        <label className="hexaclear-scores-global-toggle hexaclear-gameover-toggle">
                          <input
                            type="checkbox"
                            checked={showGlobalLeaderboard}
                            onChange={(e) => {
                              playUiClick()
                              setShowGlobalLeaderboard(e.target.checked)
                            }}
                          />
                          <span>Global</span>
                        </label>
                      </div>
                      {saveSubsection}
                      {globalLoading ? (
                        <p className="hexaclear-scores-empty">
                          Loading global scores…
                        </p>
                      ) : usingGlobal ? (
                        expanded ? (
                          <>
                            {globalVisible.length === 0 ? (
                              <p className="hexaclear-scores-empty">
                                No global daily scores yet — be the first.
                              </p>
                            ) : (
                              <ol className="hexaclear-scores-list">
                                {globalVisible.map((entry, idx) => {
                                  const rank = globalPageStart + idx + 1
                                  const isYou = entry.playerId === playerId
                                  const chipClass = [
                                    'hexaclear-rank-chip',
                                    rank === 1
                                      ? 'hexaclear-chip-trophy'
                                      : rank <= 3
                                        ? 'hexaclear-chip-gold'
                                        : 'hexaclear-chip-neutral',
                                  ].join(' ')
                                  return (
                                    <li
                                      key={
                                        entry.savedAt +
                                        entry.playerId +
                                        idx
                                      }
                                      className={[
                                        'hexaclear-scores-row',
                                        isYou ? 'recent' : '',
                                      ]
                                        .filter(Boolean)
                                        .join(' ')}
                                    >
                                      <span className={chipClass}>{rank}</span>
                                      <span className="hexaclear-scores-name">
                                        {entry.name}
                                        {isYou ? ' (you)' : ''}
                                      </span>
                                      <span className="hexaclear-scores-value">
                                        {entry.moves}{' '}
                                        {entry.moves === 1 ? 'move' : 'moves'}
                                      </span>
                                    </li>
                                  )
                                })}
                              </ol>
                            )}
                            {globalPageCount > 1 && (
                              <div className="hexaclear-scores-pagination">
                                <button
                                  type="button"
                                  className="hexaclear-scores-page-step"
                                  aria-label="Previous page"
                                  onClick={() => {
                                    playUiClick()
                                    setGameoverDailyGlobalPage((p) =>
                                      Math.max(0, p - 1),
                                    )
                                  }}
                                  disabled={globalPageIndex === 0}
                                >
                                  ‹
                                </button>
                                <span className="hexaclear-scores-page-label">
                                  {globalPageStart + 1}–
                                  {Math.min(
                                    globalPageStart +
                                      GAMEOVER_LEADERBOARD_PAGE_SIZE,
                                    globalTop.length,
                                  )}{' '}
                                  of {globalTop.length}
                                </span>
                                <button
                                  type="button"
                                  className="hexaclear-scores-page-step"
                                  aria-label="Next page"
                                  onClick={() => {
                                    playUiClick()
                                    setGameoverDailyGlobalPage((p) =>
                                      Math.min(globalPageCount - 1, p + 1),
                                    )
                                  }}
                                  disabled={
                                    globalPageIndex >= globalPageCount - 1
                                  }
                                >
                                  ›
                                </button>
                              </div>
                            )}
                            {playerGlobalRank !== null &&
                              !globalShowsPlayer &&
                              playerGlobalEntry && (
                                <p className="hexaclear-scores-your-rank">
                                  Your rank: #{playerGlobalRank} ·{' '}
                                  {playerGlobalEntry.moves}{' '}
                                  {playerGlobalEntry.moves === 1
                                    ? 'move'
                                    : 'moves'}
                                </p>
                              )}
                            {playerGlobalRank === null &&
                              dailyHighScoreSaved && (
                                <p className="hexaclear-scores-your-rank">
                                  Not on today's global board yet.
                                </p>
                              )}
                          </>
                        ) : (
                          <>
                            {renderCompactList(
                              globalCompactRows,
                              playerGlobalRank,
                              globalPlayerRow,
                            )}
                            {playerGlobalRank === null &&
                              dailyHighScoreSaved && (
                                <p className="hexaclear-scores-your-rank">
                                  Not on today's global board yet.
                                </p>
                              )}
                          </>
                        )
                      ) : expanded ? (
                        <ol className="hexaclear-scores-list">
                          {localPageWindow.map((entry, idx) => {
                            const isRecent =
                              dailyHighScoreSaved &&
                              lastSavedDailyHighScoreDate !== null &&
                              entry.date === lastSavedDailyHighScoreDate
                            const rank = idx + 1
                            const chipClass = [
                              'hexaclear-rank-chip',
                              rank === 1
                                ? 'hexaclear-chip-trophy'
                                : rank <= 3
                                  ? 'hexaclear-chip-gold'
                                  : 'hexaclear-chip-neutral',
                            ].join(' ')
                            return (
                              <li
                                key={entry.date + entry.name + idx}
                                className={[
                                  'hexaclear-scores-row',
                                  isRecent ? 'recent' : '',
                                ]
                                  .filter(Boolean)
                                  .join(' ')}
                              >
                                <span className={chipClass}>{rank}</span>
                                <span className="hexaclear-scores-name">
                                  {entry.name || 'You'}
                                </span>
                                <span className="hexaclear-scores-value">
                                  {entry.moves}{' '}
                                  {entry.moves === 1 ? 'move' : 'moves'}
                                </span>
                              </li>
                            )
                          })}
                        </ol>
                      ) : (
                        renderCompactList(
                          localCompactRows,
                          playerLocalRank,
                          localPlayerRow,
                        )
                      )}
                      {canExpand && (
                        <button
                          type="button"
                          className="hexaclear-scores-expand-toggle"
                          onClick={() => {
                            playUiClick()
                            setGameoverLeaderboardExpanded((v) => !v)
                          }}
                          aria-expanded={expanded}
                        >
                          {expanded
                            ? 'Show fewer'
                            : `Show all (${visibleCount})`}
                        </button>
                      )}
                    </div>
                  )
                })()}

                {/* "Undo last move" is the rescue hatch for a daily
                    run that ran out of moves a few cubes shy of the
                    target — undoing lets the player try a different
                    placement instead of accepting the loss. Once
                    they've cleared the puzzle, though, the move
                    count is the score, so undoing back into a
                    pre-clear state would be a way to keep retrying
                    placements until they luck into a better number.
                    Hide the button when the daily is a confirmed
                    clear so the score they just earned is the
                    score they keep. */}
                {undoStack.length > 0 &&
                  !dailyHighScoreSaved &&
                  !game.dailyCompleted && (
                    <button
                      type="button"
                      className="hexaclear-menu-link"
                      onClick={() => {
                        playUiClick()
                        handleUndo()
                      }}
                    >
                      Undo last move
                    </button>
                  )}

                {/* Daily-win-only jump-to-another-day row. After a
                    cleared puzzle, the most useful follow-up is
                    often "show me the next unsolved daily" — this
                    row offers exactly that for both directions,
                    preferring unfinished puzzles in each direction
                    so the player can chain through their backlog
                    without bouncing back into the calendar grid.
                    Either side disappears entirely when no
                    unfinished day exists in that direction within
                    the launch..today range, so the buttons only
                    appear when they'd actually do something. */}
                {game.dailyCompleted &&
                  (() => {
                    const currentDailyKey =
                      game.dailyDateKey ?? getTodayKey()
                    const todayKey = getTodayKey()
                    const isCleared = (dateKey: string): boolean => {
                      // Mirrors the bestMoves lookup used by the
                      // calendar grid: synced map first, then the
                      // per-day localStorage best, then the runs
                      // list as a last resort.
                      const synced =
                        lifetimeStats.dailyBestMovesByDate[dateKey]
                      if (
                        typeof synced === 'number' &&
                        Number.isFinite(synced) &&
                        synced > 0
                      ) {
                        return true
                      }
                      try {
                        if (typeof window !== 'undefined') {
                          const raw = window.localStorage.getItem(
                            `cubic-daily-best-${dateKey}`,
                          )
                          const parsed = raw ? Number.parseInt(raw, 10) : NaN
                          if (Number.isFinite(parsed) && parsed > 0) {
                            return true
                          }
                          const runs = loadDailyRunsForDateKey(dateKey)
                          if (runs.length > 0) return true
                        }
                      } catch {
                        // Treat storage errors as "not cleared" so the
                        // button still works even if localStorage is
                        // unavailable.
                      }
                      return false
                    }
                    const findNeighbor = (
                      delta: -1 | 1,
                    ): string | null => {
                      // Safety bound: walk at most a few years of
                      // calendar days so a logic bug can never spin
                      // here forever. The real terminating condition
                      // is the launch / today boundary.
                      let cursor = shiftDateKey(currentDailyKey, delta)
                      for (let i = 0; i < 4000; i++) {
                        if (
                          delta < 0 &&
                          isDateKeyBefore(
                            cursor,
                            DAILY_HISTORY_LAUNCH_DATE_KEY,
                          )
                        ) {
                          return null
                        }
                        if (delta > 0 && isDateKeyAfter(cursor, todayKey)) {
                          return null
                        }
                        if (!isCleared(cursor)) return cursor
                        cursor = shiftDateKey(cursor, delta)
                      }
                      return null
                    }
                    const prevKey = findNeighbor(-1)
                    const nextKey = findNeighbor(1)
                    if (!prevKey && !nextKey) return null
                    return (
                      <div className="hexaclear-gameover-daily-nav-row">
                        {prevKey ? (
                          <button
                            type="button"
                            className="hexaclear-gameover-cta hexaclear-gameover-cta-secondary hexaclear-gameover-daily-nav"
                            onClick={() => {
                              playUiClick()
                              if (pendingDailyHighScore) {
                                handleSaveDailyHighScore()
                              }
                              handleStartDailyForDateKey(prevKey)
                              setDailyGameOverDismissed(true)
                            }}
                          >
                            <span className="hexaclear-gameover-daily-nav-arrow">
                              ‹
                            </span>
                            <span className="hexaclear-gameover-daily-nav-stack">
                              <span className="hexaclear-gameover-daily-nav-label">
                                Previous day
                              </span>
                              <span className="hexaclear-gameover-daily-nav-date">
                                {formatFriendlyDateKey(prevKey)}
                              </span>
                            </span>
                          </button>
                        ) : (
                          <span className="hexaclear-gameover-daily-nav-spacer" />
                        )}
                        {nextKey ? (
                          <button
                            type="button"
                            className="hexaclear-gameover-cta hexaclear-gameover-cta-secondary hexaclear-gameover-daily-nav"
                            onClick={() => {
                              playUiClick()
                              if (pendingDailyHighScore) {
                                handleSaveDailyHighScore()
                              }
                              handleStartDailyForDateKey(nextKey)
                              setDailyGameOverDismissed(true)
                            }}
                          >
                            <span className="hexaclear-gameover-daily-nav-stack">
                              <span className="hexaclear-gameover-daily-nav-label">
                                Next day
                              </span>
                              <span className="hexaclear-gameover-daily-nav-date">
                                {formatFriendlyDateKey(nextKey)}
                              </span>
                            </span>
                            <span className="hexaclear-gameover-daily-nav-arrow">
                              ›
                            </span>
                          </button>
                        ) : (
                          <span className="hexaclear-gameover-daily-nav-spacer" />
                        )}
                      </div>
                    )
                  })()}

                {/* Copy Share — pasteable summary of the run.
                    Lives right above the exit row so it's the last
                    thing the player sees before deciding which exit
                    to take, and works for both wins and losses
                    (lost runs include "N cubes remained" instead of
                    a personal-best line). The label flips to
                    "Copied!" for ~1.8s after a successful copy as
                    inline confirmation. */}
                <button
                  type="button"
                  className={[
                    'hexaclear-gameover-cta',
                    'hexaclear-gameover-cta-share',
                    dailyShareCopied ? 'is-copied' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => {
                    playUiClick()
                    void handleCopyDailyShare()
                  }}
                  aria-live="polite"
                >
                  {dailyShareCopied ? '✓ Copied!' : 'Copy Share'}
                </button>

                {/* Two-button exit row: Done is the calm "I'm
                    satisfied, leave me alone" path; Retry is the
                    competitive "let me chase a better score" path.
                    Both autosave any pending result on the way out
                    so the leaderboard reflects every completed
                    attempt regardless of which exit the player
                    chooses. Wrapped in the sticky `hexaclear-
                    gameover-footer` so the primary exit is always
                    one tap away even on tall puzzle days where the
                    leaderboard/recap scrolls below the fold. The
                    daily-nav row and Copy Share above stay in the
                    scrollable body because they're optional
                    side-doors, not the modal's primary action. */}
                <div className="hexaclear-gameover-footer">
                <div className="hexaclear-gameover-cta-row">
                  <button
                    type="button"
                    className="hexaclear-gameover-cta hexaclear-gameover-cta-secondary"
                    onClick={() => {
                      playUiClick()
                      if (pendingDailyHighScore) {
                        handleSaveDailyHighScore()
                      }
                      // Dismiss the celebration but keep the
                      // underlying gameover state intact, so the
                      // player lands on the cleared board with the
                      // mode pills, menu button, and history button
                      // still available for the next move they want
                      // to make.
                      setDailyGameOverDismissed(true)
                    }}
                  >
                    Done
                  </button>
                  <button
                    type="button"
                    className="hexaclear-gameover-cta"
                    onClick={() => {
                      playUiClick()
                      // Autosave on dismiss — see the endless-mode
                      // counterpart above. The Save button stays as
                      // a visible confirm action, but stepping away
                      // from the modal still records the attempt.
                      if (pendingDailyHighScore) {
                        handleSaveDailyHighScore()
                      }
                      // Retry whichever day this run was for.
                      // Today's run replays today; an archive-day
                      // run replays that same archived day so the
                      // player can keep chipping at their best.
                      const next = createDailyGameState(game.dailyDateKey)
                      setGame(next)
                      setSavedDailyGame(next)
                      setDailyHighScoreSaved(false)
                      setSelectedPieceId(null)
                      setHover(null)
                      startDealIn()
                    }}
                  >
                    {game.dailyDateKey &&
                    game.dailyDateKey !== getTodayKey()
                      ? 'Retry this puzzle'
                      : "Retry today's puzzle"}
                  </button>
                </div>
                </div>
              </div>
            </div>
          )}
          {/* CUBEKILL announce: slams over the board cascade at the
              start of every deal-in — the run is ANNOUNCED, Quake
              style — then settles into the header title's measured
              position (the title is hidden until the announce lands,
              so it reads as the same object arriving). Unmounts
              instantly on skip because dealInActive drops. Hidden
              under reduced motion. */}
          {dealInActive && !reducedMotion && !announceLanded && (
            <div className="hexaclear-dealin-announce" aria-hidden="true">
              <span
                ref={announceTextRef}
                className="hexaclear-dealin-announce-text"
                onAnimationEnd={(e) => {
                  if (
                    e.animationName === 'hexaclear-dealin-announce-settle' ||
                    e.animationName === 'hexaclear-dealin-announce-fade'
                  ) {
                    setAnnounceLanded(true)
                  }
                }}
              >
                Cubekill
              </span>
            </div>
          )}
          {/* iOS Safari refuses to resume an AudioContext from a touch
              event that's part of a drag (WebKit #248265). When the
              player is unmuted and the context is missing or stale,
              they have to do a "touch-as-click" somewhere to unlock
              audio — a tap-and-drag piece grab will NOT do it. We
              render a full-screen system prompt centered on the
              screen; tapping anywhere on the overlay fires a click
              event, which IS a valid activation event, and the
              `subscribeAudioNeedsUnlock` signal flips the overlay
              away as soon as the context reaches `running`.

              Suppressed whenever another dialog is on screen — pause
              menu, high scores, stats, account, history calendar,
              how-to-play, or any gameover modal. In those cases the
              player has tappable UI in front of them already (at
              minimum a Close / Back / Done button), and that tap
              counts as a valid activation gesture which `audio.ts`
              picks up via its global pointerup/touchend listener.
              Stacking our prompt on top would be redundant noise. */}
          {audioNeedsUnlock && isTouchDevice && !anyDialogOpen && (
            <div
              className="hexaclear-audio-unlock-overlay"
              role="button"
              tabIndex={0}
              aria-label="Tap to resume audio"
              onClick={() => {
                unlockAudioOnGesture()
              }}
            >
              <div className="hexaclear-audio-unlock-card">
                <div className="hexaclear-audio-unlock-title">
                  Tap to resume
                </div>
              </div>
            </div>
          )}
          {showMenu && (
            <div
              className="hexaclear-overlay hexaclear-pmenu-overlay"
              /* Backdrop dismissal fires on click rather than pointer
                 down so the overlay stays mounted through the entire
                 down → up gesture. If we close on pointerdown the
                 overlay unmounts mid-gesture and the synthesized
                 pointerup / click bleeds through to the board cell
                 underneath, letting the player accidentally place a
                 piece or trigger a UI control they were trying to
                 ignore. Click waits for the full tap to land on the
                 backdrop before unmounting, so no event reaches the
                 game state. */
              onClick={(e) => {
                if (e.target !== e.currentTarget) return
                playUiClick()
                setShowMenu(false)
              }}
            >
              {(() => {
                // === Pause menu derived data =====================
                // Library card teases: each card carries one short
                // line of useful data so the menu reads at-a-glance
                // (instead of three blind nav titles).
                const menuTotalGames =
                  lifetimeStats.gamesPlayedEndless +
                  lifetimeStats.gamesPlayedDaily +
                  lifetimeStats.gamesPlayedCoop +
                  lifetimeStats.gamesPlayedPvp
                const menuUnlockedPieces = ALL_PIECE_VARIANTS.reduce(
                  (acc, variant) => {
                    const s = getPieceStats(pieceStats, variant.id)
                    return s.timesPlayed > 0 || s.killingHands > 0
                      ? acc + 1
                      : acc
                  },
                  0,
                )
                const selectedAudiusTrack = audiusTrackOptions.find(
                  (track) => track.id === audiusSelectedTrackId,
                )
                // "Save GIF" chip only renders when there is at
                // least one recorded move; no orphaned disabled
                // state in the menu (the player just doesn't see
                // the chip until it's usable).
                const menuCanExportGif =
                  !isMultiplayer && runHistoryRef.current.length > 0
                const menuModeLabel = isMultiplayer
                  ? mp.mode === 'pvp'
                    ? 'Versus'
                    : 'Co-op'
                  : game.mode === 'daily'
                    ? 'Daily'
                    : game.mode === 'big'
                      ? 'Big Board'
                      : 'Endless'
                const menuContextLine =
                  game.mode === 'daily'
                    ? menuModeLabel
                    : `${menuModeLabel} · ${game.score.toLocaleString()}`
                return (
                  // PAUSE MENU — editorial monolith. A bottom sheet
                  // rising over the dimmed board: a masthead, then a
                  // letterpress-style index of giant type rows, each
                  // annotated with one line of live data. Rows deal in
                  // with the same stagger vocabulary as the hand.
                  // Settings is page two of the same sheet.
                  <div
                    className="hexaclear-pmenu"
                    role="dialog"
                    aria-label="Pause menu"
                  >
                    <header
                      className="hexaclear-pmenu-masthead"
                      aria-hidden="true"
                    >
                      <span className="hexaclear-pmenu-kicker">Paused</span>
                    </header>
                    {menuPage === 'index' ? (
                    <nav className="hexaclear-pmenu-index" aria-label="Menu">
                      {/* TIER 1 — the action. One raised, pressable
                          slab; the only bright object in the menu.
                          Dark-on-gold inverts the palette so nothing
                          else can compete with it. */}
                      {hasStartedSession || isMultiplayer ? (
                        <button
                          type="button"
                          className="hexaclear-pmenu-hero"
                          style={{ ['--pmenu-i' as string]: 0 }}
                          onClick={() => {
                            unlockAudioOnGesture()
                            playUiClick()
                            setShowMenu(false)
                          }}
                        >
                          <span className="hexaclear-pmenu-hero-label">
                            Resume
                          </span>
                          <span className="hexaclear-pmenu-hero-sub">
                            {menuContextLine}
                          </span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="hexaclear-pmenu-hero"
                          style={{ ['--pmenu-i' as string]: 0 }}
                          onClick={() => {
                            unlockAudioOnGesture()
                            playUiClick()
                            setHasStartedSession(true)
                            setShowMenu(false)
                            // The board is already pristine (this hero
                            // only exists pre-first-move), so there's no
                            // state to create — but "New Game" is the
                            // player's explicit "begin", so the deal-in
                            // ritual replays as the menu drops away.
                            // Mount may have already played it to an
                            // empty room; this is the one that counts.
                            startDealIn()
                          }}
                        >
                          <span className="hexaclear-pmenu-hero-label">
                            New Game
                          </span>
                          <span className="hexaclear-pmenu-hero-sub">
                            Fresh board
                          </span>
                        </button>
                      )}

                      {/* TIER 2 — the places. Engraved inlay tiles;
                          each stat is locked up directly beneath its
                          title so the data belongs to the object. */}
                      <div
                        className="hexaclear-pmenu-tiles"
                        style={{ ['--pmenu-i' as string]: 1 }}
                      >
                        <button
                          type="button"
                          className="hexaclear-pmenu-tile"
                          onClick={() => {
                            unlockAudioOnGesture()
                            playUiClick()
                            setShowMenu(false)
                            setShowHighScores(true)
                          }}
                        >
                          <span className="hexaclear-pmenu-tile-title">
                            Scores
                          </span>
                          <span className="hexaclear-pmenu-tile-stat">
                            {bestScore != null && bestScore > 0
                              ? `Best ${bestScore.toLocaleString()}`
                              : 'No runs yet'}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="hexaclear-pmenu-tile"
                          onClick={() => {
                            unlockAudioOnGesture()
                            playUiClick()
                            setShowMenu(false)
                            setShowStats(true)
                          }}
                        >
                          <span className="hexaclear-pmenu-tile-title">
                            Stats
                          </span>
                          <span className="hexaclear-pmenu-tile-stat">
                            {menuTotalGames > 0
                              ? `${menuTotalGames.toLocaleString()} game${
                                  menuTotalGames === 1 ? '' : 's'
                                }`
                              : 'Local profile'}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="hexaclear-pmenu-tile"
                          onClick={() => {
                            unlockAudioOnGesture()
                            playUiClick()
                            setShowMenu(false)
                            setShowScoring(true)
                          }}
                        >
                          <span className="hexaclear-pmenu-tile-title">
                            How to play
                          </span>
                          <span className="hexaclear-pmenu-tile-stat">
                            Pieces {menuUnlockedPieces}/
                            {ALL_PIECE_VARIANTS.length}
                          </span>
                        </button>
                      </div>

                      {/* TIER 3 — utility. Quiet strip: run-scoped
                          actions left (warn/danger reads), Settings
                          chip right. */}
                      <div
                        className="hexaclear-pmenu-utility"
                        style={{ ['--pmenu-i' as string]: 2 }}
                      >
                        <div className="hexaclear-pmenu-utility-links">
                          {(hasStartedSession || isMultiplayer) &&
                            (isMultiplayer ? (
                              <button
                                type="button"
                                className="hexaclear-pmenu-runlink is-danger"
                                onClick={() => {
                                  unlockAudioOnGesture()
                                  playUiClick()
                                  setShowMenu(false)
                                  handleLeaveRoom()
                                }}
                              >
                                Leave game
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="hexaclear-pmenu-runlink is-warn"
                                onClick={() => {
                                  unlockAudioOnGesture()
                                  playUiClick()
                                  setShowMenu(false)
                                  resetGame()
                                }}
                              >
                                Restart run
                              </button>
                            ))}
                          {menuCanExportGif && (
                            <button
                              type="button"
                              className="hexaclear-pmenu-runlink"
                              onClick={() => {
                                unlockAudioOnGesture()
                                playUiClick()
                                const available =
                                  runHistoryRef.current.length
                                if (available === 0) return
                                const defaultCount = Math.min(
                                  5,
                                  available,
                                  RUN_HISTORY_EXPORT_MAX,
                                )
                                setExportGifCount(defaultCount)
                                setExportGifProgress(null)
                                setShowMenu(false)
                                setShowExportGif(true)
                              }}
                            >
                              Save GIF
                            </button>
                          )}
                        </div>
                        <button
                          type="button"
                          className="hexaclear-pmenu-settings-chip"
                          onClick={() => {
                            playUiClick()
                            setMenuPage('settings')
                          }}
                        >
                          <span aria-hidden="true">⚙</span> Settings
                        </button>
                      </div>
                    </nav>
                    ) : (
                    <div className="hexaclear-pmenu-settings">
                      <header className="hexaclear-pmenu-settings-head">
                        <button
                          type="button"
                          className="hexaclear-pmenu-back"
                          onClick={() => {
                            playUiClick()
                            setMenuPage('index')
                          }}
                        >
                          ← Back
                        </button>
                        <span className="hexaclear-pmenu-settings-title">
                          Settings
                        </span>
                      </header>
                      <div className="hexaclear-pmenu-settings-body">
                          <div className="hexaclear-menu-settings-group">
                            <div className="hexaclear-menu-settings-group-label">
                              Account
                            </div>
                            <div className="hexaclear-menu-settings-account">
                              <span className="hexaclear-menu-settings-account-text">
                                {authLoading
                                  ? 'Checking account…'
                                  : isAuthenticated
                                  ? accountSyncState === 'syncing'
                                    ? 'Syncing online stats…'
                                    : 'Signed in — stats syncing across devices.'
                                  : 'Local only — sign in to sync stats and daily history.'}
                              </span>
                              <button
                                type="button"
                                className="hexaclear-menu-settings-account-button"
                                onClick={() => {
                                  unlockAudioOnGesture()
                                  playUiClick()
                                  setShowMenu(false)
                                  setShowAccount(true)
                                }}
                              >
                                {isAuthenticated ? 'Manage' : 'Sign in'}
                              </button>
                            </div>
                          </div>

                          <div className="hexaclear-menu-settings-group">
                            <div className="hexaclear-menu-settings-group-label">
                              Audio
                            </div>
                            <div className="hexaclear-menu-settings-audio">
                              <input
                                type="range"
                                min={0}
                                max={100}
                                step={1}
                                value={Math.round(volume * 100)}
                                disabled={audioMuted}
                                onChange={(e) => {
                                  const v = Number(e.target.value) / 100
                                  setVolumeState(v)
                                  setMasterVolume(v)
                                }}
                                aria-label="Volume"
                              />
                              <span className="hexaclear-menu-settings-audio-readout">
                                {Math.round(volume * 100)}%
                              </span>
                              <label className="hexaclear-menu-settings-mute">
                                <input
                                  type="checkbox"
                                  checked={audioMuted}
                                  onChange={(e) => {
                                    const next = e.target.checked
                                    setAudioMutedState(next)
                                    setMuted(next)
                                    // After mute toggles:
                                    //   unmuting -> click is audible (signals "audio back")
                                    //   muting   -> click is silenced (visual confirms it)
                                    playUiClick()
                                  }}
                                />
                                <span>Mute</span>
                              </label>
                            </div>
                          </div>

                          <div className="hexaclear-menu-settings-group">
                            <div className="hexaclear-menu-settings-group-label">
                              Theme
                            </div>
                            <select
                              className="hexaclear-menu-settings-select"
                              value={theme}
                              onChange={(e) => {
                                setTheme(e.target.value as ThemeId)
                                playUiClick()
                              }}
                              aria-label="Theme"
                            >
                              {THEME_OPTIONS.map((opt) => (
                                <option key={opt.id} value={opt.id}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </div>

                          {theme === 'audius' && (
                            <div className="hexaclear-menu-settings-group hexaclear-audius-poc">
                              <div className="hexaclear-menu-settings-group-label">
                                Music
                              </div>
                              <div className="hexaclear-audius-panel">
                                <div className="hexaclear-audius-panel-head">
                                  <span>Music source</span>
                                  <button
                                    type="button"
                                    className="hexaclear-menu-chip"
                                    onClick={() => {
                                      playUiClick()
                                      setShowAudiusSearch(true)
                                    }}
                                  >
                                    Search
                                  </button>
                                </div>
                                <p className="hexaclear-audius-meta">
                                  {selectedAudiusTrack
                                    ? `${
                                        selectedAudiusTrack.user?.name ??
                                        selectedAudiusTrack.user?.handle ??
                                        'Audius artist'
                                      } · ${
                                        audiusAlbumQueue
                                          ? `${audiusAlbumQueue.name} · `
                                          : ''
                                      }${
                                        selectedAudiusTrack.bpm
                                          ? `${selectedAudiusTrack.bpm} BPM`
                                          : 'BPM unknown'
                                      } · ${formatAudiusDuration(
                                        selectedAudiusTrack.duration,
                                      )}`
                                    : 'Search Audius, choose a track, then press Play.'}
                                </p>
                                {audiusError && (
                                  <p className="hexaclear-audius-error">
                                    {audiusError}
                                  </p>
                                )}
                              </div>
                            </div>
                          )}

                          <div className="hexaclear-menu-settings-group">
                            <div className="hexaclear-menu-settings-group-label">
                              Visual
                            </div>
                            <div className="hexaclear-menu-settings-toggles">
                              <label className="hexaclear-menu-settings-toggle-row">
                                <input
                                  type="checkbox"
                                  checked={reducedMotion}
                                  onChange={(e) => {
                                    setReducedMotion(e.target.checked)
                                    playUiClick()
                                  }}
                                />
                                <span>Reduced motion</span>
                              </label>
                              <label className="hexaclear-menu-settings-toggle-row">
                                <input
                                  type="checkbox"
                                  checked={colorblindSupport}
                                  onChange={(e) => {
                                    setColorblindSupport(e.target.checked)
                                    playUiClick()
                                  }}
                                />
                                <span>Colorblind support</span>
                              </label>
                            </div>
                          </div>

                          {isMultiplayer && (
                            <div className="hexaclear-menu-settings-group">
                              <div className="hexaclear-menu-settings-group-label">
                                Co-op name
                              </div>
                              <input
                                type="text"
                                className="hexaclear-menu-settings-text"
                                value={mpPlayerName}
                                maxLength={20}
                                onChange={(e) =>
                                  setMpPlayerName(e.target.value)
                                }
                                aria-label="Co-op display name"
                              />
                            </div>
                          )}

                      </div>
                    </div>
                    )}
                  </div>
                )
              })()}
            </div>
          )}
          {showAccount && (() => {
            const totalGames =
              lifetimeStats.gamesPlayedEndless +
              lifetimeStats.gamesPlayedDaily +
              lifetimeStats.gamesPlayedCoop +
              lifetimeStats.gamesPlayedPvp
            // Number of distinct daily puzzles this device will push
            // to the account on sync. Use the synced map's keys when
            // present (covers any backfilled days that aren't yet in
            // dailyDaysCleared) and fall back to dailyDaysCleared so
            // pre-backfill devices still report a sensible count.
            const dailyClearedKeys = new Set<string>(
              lifetimeStats.dailyDaysCleared,
            )
            for (const key of Object.keys(
              lifetimeStats.dailyBestMovesByDate,
            )) {
              dailyClearedKeys.add(key)
            }
            const dailyClearedCount = dailyClearedKeys.size
            const summaryItems: StatDatum[] = [
              {
                key: 'games',
                label: 'Games',
                value: String(totalGames),
              },
              {
                key: 'daily',
                label: 'Daily',
                value: String(dailyClearedCount),
              },
              {
                key: 'rubies',
                label: 'Rubies',
                value: String(lifetimeStats.rubiesCleared),
              },
              {
                key: 'score',
                label: 'Score',
                value: String(lifetimeStats.totalScore),
              },
              {
                key: 'time',
                label: 'Time',
                value: formatDuration(lifetimeStats.totalActivePlayMs),
              },
            ]
            const lastSyncedLabel =
              statsSyncLastAt === null
                ? null
                : `Last synced ${formatFriendlyDateTime(statsSyncLastAt)}`

            return (
              <div
                className="hexaclear-overlay"
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return
                  playUiClick()
                  setShowAccount(false)
                  setShowMenu(true)
                }}
              >
                <div className="hexaclear-overlay-card hexaclear-account-card">
                  <div className="title">Stats Sync</div>
                  <div className="hexaclear-account-copy">
                    <strong>
                      Your lifetime stats and daily game history on this device
                      will be merged into your online account.
                    </strong>
                    <span>
                      That includes {dailyClearedCount}{' '}
                      {dailyClearedCount === 1
                        ? 'cleared daily puzzle'
                        : 'cleared daily puzzles'}{' '}
                      from this device — the calendar will show every day
                      you've cleared on any signed-in device, with the
                      fewest-moves run kept on each.
                    </span>
                    <span>
                      Nothing local is lost. After sync, this device shows the
                      combined online total.
                    </span>
                  </div>
                  <div className="hexaclear-account-summary">
                    {summaryItems.map((item) => (
                      <div key={item.key} className="hexaclear-account-stat">
                        <span>{item.value}</span>
                        <strong>{item.label}</strong>
                      </div>
                    ))}
                  </div>
                  {accountError && (
                    <div className="hexaclear-account-message is-error">
                      {accountError}
                    </div>
                  )}
                  {accountMessage && (
                    <div className="hexaclear-account-message">
                      {accountMessage}
                    </div>
                  )}
                  {isAuthenticated ? (
                    <div className="hexaclear-account-actions">
                      <div className="hexaclear-account-online">
                        <span>
                          {accountStatsQuery?.email ?? 'Signed in account'}
                        </span>
                        <strong>
                          {accountSyncState === 'syncing'
                            ? 'Syncing...'
                            : lastSyncedLabel ?? 'Ready to sync'}
                        </strong>
                      </div>
                      <button
                        type="button"
                        className="hexaclear-reset"
                        disabled={accountSyncState === 'syncing'}
                        onClick={() => {
                          playUiClick()
                          void syncStatsToAccount(lifetimeStats)
                        }}
                      >
                        Sync now
                      </button>
                      <button
                        type="button"
                        className="hexaclear-menu-danger-button"
                        disabled={accountSyncState === 'syncing'}
                        onClick={() => {
                          playUiClick()
                          void handleAccountSignOut()
                        }}
                      >
                        Sign out
                      </button>
                    </div>
                  ) : (
                    <>
                      {!accountFormVisible ? (
                        <div className="hexaclear-account-actions">
                          <button
                            type="button"
                            className="hexaclear-reset"
                            onClick={() => {
                              playUiClick()
                              setAccountMode('signIn')
                              setAccountFormVisible(true)
                            }}
                          >
                            Continue to sign in
                          </button>
                          <button
                            type="button"
                            className="hexaclear-menu-account-secondary"
                            onClick={() => {
                              playUiClick()
                              setAccountMode('signUp')
                              setAccountFormVisible(true)
                            }}
                          >
                            Create account
                          </button>
                        </div>
                      ) : (
                        <form
                          className="hexaclear-account-form"
                          onSubmit={handleAccountSubmit}
                        >
                          <div className="hexaclear-account-mode-row">
                            <button
                              type="button"
                              className={
                                accountMode === 'signIn' ? 'is-active' : ''
                              }
                              onClick={() => setAccountMode('signIn')}
                            >
                              Sign in
                            </button>
                            <button
                              type="button"
                              className={
                                accountMode === 'signUp' ? 'is-active' : ''
                              }
                              onClick={() => setAccountMode('signUp')}
                            >
                              Create
                            </button>
                          </div>
                          <label>
                            <span>Email</span>
                            <input
                              type="email"
                              value={accountEmail}
                              autoComplete="email"
                              required
                              onChange={(e) => setAccountEmail(e.target.value)}
                            />
                          </label>
                          <label>
                            <span>Password</span>
                            <input
                              type="password"
                              value={accountPassword}
                              autoComplete={
                                accountMode === 'signUp'
                                  ? 'new-password'
                                  : 'current-password'
                              }
                              minLength={8}
                              required
                              onChange={(e) => setAccountPassword(e.target.value)}
                            />
                          </label>
                          <button
                            type="submit"
                            className="hexaclear-reset"
                            disabled={accountSyncState === 'syncing' || authLoading}
                          >
                            {accountSyncState === 'syncing'
                              ? 'Working...'
                              : accountMode === 'signUp'
                              ? 'Create and sync'
                              : 'Sign in and sync'}
                          </button>
                        </form>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className="hexaclear-reset"
                    onClick={() => {
                      playUiClick()
                      setShowAccount(false)
                      setShowMenu(true)
                    }}
                  >
                    Back
                  </button>
                </div>
              </div>
            )
          })()}
          {showScoring && (
            <div
              className="hexaclear-overlay"
              onClick={(e) => {
                if (e.target !== e.currentTarget) return
                playUiClick()
                setShowScoring(false)
                setShowMenu(true)
              }}
            >
              <div className="hexaclear-overlay-card hexaclear-scoring-card">
                <div className="title">How to Play</div>
                {/* Tab strip. The Rules tab keeps its mode-specific
                    content (daily puzzle rules vs scoring numbers);
                    the Piecetiary tab shows every piece in the
                    rotation with its name so the player can build a
                    vocabulary for talking about them. */}
                <div
                  className="hexaclear-scoring-tabs"
                  role="tablist"
                  aria-label="How to play tabs"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={scoringTab === 'rules'}
                    className={[
                      'hexaclear-scoring-tab',
                      scoringTab === 'rules' ? 'is-active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      playUiClick()
                      setScoringTab('rules')
                    }}
                  >
                    {game.mode === 'daily' ? 'Daily Rules' : 'How to Score'}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={scoringTab === 'pieces'}
                    className={[
                      'hexaclear-scoring-tab',
                      scoringTab === 'pieces' ? 'is-active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      playUiClick()
                      setScoringTab('pieces')
                    }}
                  >
                    Piecetiary
                  </button>
                </div>
                {scoringTab === 'pieces' ? (
                  <div className="hexaclear-piecetiary">
                    <div className="hexaclear-piecetiary-grid">
                      {ALL_PIECE_VARIANTS.map((variant) => {
                        // Tiles double as "show me my history with
                        // this piece" buttons. Tile chrome stays
                        // visually identical to the read-only
                        // version; we just route the click into
                        // the detail-sheet modal.
                        const tileStats = getPieceStats(
                          pieceStats,
                          variant.id,
                        )
                        const hasHistory =
                          tileStats.timesPlayed > 0 ||
                          tileStats.killingHands > 0
                        return (
                          <button
                            key={variant.id}
                            type="button"
                            className={[
                              'hexaclear-piecetiary-cell',
                              hasHistory ? 'has-history' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            data-piece-size={variant.size}
                            onClick={() => {
                              playUiClick()
                              setSelectedPieceVariant(variant)
                            }}
                            aria-label={`Open piece details for ${
                              PIECE_VARIANT_NAMES[variant.id] ??
                              variant.notation
                            }`}
                          >
                            <div className="hexaclear-piecetiary-preview">
                              <PiecePreview
                                shape={{
                                  id: variant.id,
                                  cells: variant.cells,
                                  size: variant.size,
                                }}
                                mode="hand"
                                // In the cathedral theme the catalog pieces
                                // carry the same per-cube jewel tones (sapphire
                                // / turquoise / emerald / amethyst) the hand
                                // uses. Keyed off the variant id so each shape
                                // shows a stable mix every time. Other themes
                                // keep their default rendering.
                                cubeStyles={
                                  theme === 'glass'
                                    ? variant.cells.map((_, i) =>
                                        jewelStyle(
                                          jewelIndexForPieceCube(
                                            variant.id,
                                            i,
                                          ),
                                        ),
                                      )
                                    : theme === 'mondrian'
                                      ? variant.cells.map((_, i) =>
                                          primaryStyle(
                                            jewelIndexForPieceCube(
                                              variant.id,
                                              i,
                                            ),
                                          ),
                                        )
                                      : undefined
                                }
                              />
                            </div>
                            <div className="hexaclear-piecetiary-notation">
                              {variant.notation}
                            </div>
                            {PIECE_VARIANT_NAMES[variant.id] && (
                              <div className="hexaclear-piecetiary-name">
                                &ldquo;{PIECE_VARIANT_NAMES[variant.id]}
                                &rdquo;
                              </div>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ) : game.mode === 'daily' ? (
                  <>
                    <div className="hexaclear-scoring-rules">
                      <div className="hexaclear-scoring-rule">
                        <span className="hexaclear-chip hexaclear-chip-goal">
                          Goal
                        </span>
                        <div className="hexaclear-scoring-rule-text">
                          <div className="hexaclear-scoring-rule-title">
                            Clear every numbered cube
                          </div>
                          <div className="hexaclear-scoring-rule-desc">
                            Hit each cube the number of times shown on it.
                          </div>
                        </div>
                      </div>
                      <div className="hexaclear-scoring-rule">
                        <span className="hexaclear-chip hexaclear-chip-neutral">
                          1 Move
                        </span>
                        <div className="hexaclear-scoring-rule-text">
                          <div className="hexaclear-scoring-rule-title">
                            Each placement counts
                          </div>
                          <div className="hexaclear-scoring-rule-desc">
                            Every piece you place adds one move to the run.
                          </div>
                        </div>
                      </div>
                      <div className="hexaclear-scoring-rule">
                        <span className="hexaclear-chip hexaclear-chip-trophy">
                          Best
                        </span>
                        <div className="hexaclear-scoring-rule-text">
                          <div className="hexaclear-scoring-rule-title">
                            Fewest moves wins
                          </div>
                          <div className="hexaclear-scoring-rule-desc">
                            Your best daily run is the one finished in the
                            fewest moves.
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  (() => {
                    // Per-mode scoring numbers shown in the rules card.
                    // Mirrors SCORING_BY_MODE in gameLogic.ts so the UI
                    // and the actual point values never drift.
                    const isBig = game.mode === 'big'
                    const clearPoints = isBig ? 40 : 10
                    const boardClearPoints = isBig ? 100 : 25
                    const rosetteSize = isBig ? 'nineteen-cube' : 'six-cube'
                    return (
                      <>
                        <div className="hexaclear-scoring-rules">
                          <div className="hexaclear-scoring-rule">
                            <span className="hexaclear-chip hexaclear-chip-gold">
                              +{clearPoints}
                            </span>
                            <div className="hexaclear-scoring-rule-text">
                              <div className="hexaclear-scoring-rule-title">
                                Line or rosette clear
                              </div>
                              <div className="hexaclear-scoring-rule-desc">
                                Fill a straight line or a {rosetteSize} rosette.
                              </div>
                            </div>
                          </div>
                          <div className="hexaclear-scoring-rule">
                            <span className="hexaclear-chip hexaclear-chip-multiplier">
                              Combo
                            </span>
                            <div className="hexaclear-scoring-rule-text">
                              <div className="hexaclear-scoring-rule-title">
                                Combo multiplier
                              </div>
                              <div className="hexaclear-scoring-rule-desc">
                                Clear several lines or rosettes in one
                                placement to multiply the points by 1.5&times;
                                per extra clear.
                              </div>
                            </div>
                          </div>
                          <div className="hexaclear-scoring-rule">
                            <span className="hexaclear-chip hexaclear-chip-multiplier">
                              Streak
                            </span>
                            <div className="hexaclear-scoring-rule-text">
                              <div className="hexaclear-scoring-rule-title">
                                Streak multiplier
                              </div>
                              <div className="hexaclear-scoring-rule-desc">
                                Clear on back-to-back placements to multiply
                                the points by a stacking 1.1&times; per
                                consecutive clear.
                              </div>
                            </div>
                          </div>
                          <div className="hexaclear-scoring-rule">
                            <span className="hexaclear-chip hexaclear-chip-ruby">
                              +10
                            </span>
                            <div className="hexaclear-scoring-rule-text">
                              <div className="hexaclear-scoring-rule-title">
                                Ruby bonus
                              </div>
                              <div className="hexaclear-scoring-rule-desc">
                                Clearing a ruby cube grants extra points.
                              </div>
                            </div>
                          </div>
                          <div className="hexaclear-scoring-rule">
                            <span className="hexaclear-chip hexaclear-chip-big">
                              +{boardClearPoints}
                            </span>
                            <div className="hexaclear-scoring-rule-text">
                              <div className="hexaclear-scoring-rule-title">
                                Board clear
                              </div>
                              <div className="hexaclear-scoring-rule-desc">
                                Clear the entire board to get {boardClearPoints}{' '}
                                bonus points.
                              </div>
                            </div>
                          </div>
                          <div className="hexaclear-scoring-rule">
                            <span className="hexaclear-chip hexaclear-chip-small">
                              +1
                            </span>
                            <div className="hexaclear-scoring-rule-text">
                              <div className="hexaclear-scoring-rule-title">
                                Per cube placed
                              </div>
                              <div className="hexaclear-scoring-rule-desc">
                                Every cube you set down is worth one point.
                              </div>
                            </div>
                          </div>
                        </div>
                      </>
                    )
                  })()
                )}
                <button
                  type="button"
                  className="hexaclear-reset"
                  onClick={() => {
                    playUiClick()
                    setShowScoring(false)
                    setShowMenu(true)
                  }}
                >
                  Back
                </button>
              </div>
            </div>
          )}
          {devReelOpen && modalHighlightSnapshot && (
            <div
              className="hexaclear-popover-overlay"
              onClick={(e) => {
                if (e.target !== e.currentTarget) return
                setDevReelOpen(false)
              }}
            >
              <div className="hexaclear-overlay-card hexaclear-piece-detail-card">
                <div className="hexaclear-piece-detail-nickname">
                  Highlight reel preview (dev)
                </div>
                <HighlightReel snapshot={modalHighlightSnapshot} />
                <div className="hexaclear-piece-detail-actions">
                  <button
                    type="button"
                    className="hexaclear-menu-link"
                    onClick={() => setDevReelOpen(false)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}
          {showExportGif && (() => {
            // "Export recent moves" modal. Reads `runHistoryRef`
            // directly — the menu was open when this opened, so
            // the game is paused and the ref is stable across the
            // modal's lifetime (no need to snapshot it into React
            // state). The stepper is clamped to
            // `[1..min(history, RUN_HISTORY_EXPORT_MAX)]`; the
            // preview shows the trailing slice so the *most
            // recent* N moves are what gets exported.
            const history = runHistoryRef.current
            const maxCount = Math.min(history.length, RUN_HISTORY_EXPORT_MAX)
            const clampedCount = Math.max(1, Math.min(exportGifCount, maxCount))
            const snapshotsToExport =
              clampedCount > 0 ? history.slice(-clampedCount) : []
            const totalPoints = snapshotsToExport.reduce(
              (sum, s) => sum + Math.max(0, s.pointsGained),
              0,
            )
            const isExporting =
              exportGifProgress !== null &&
              exportGifProgress.label !== 'done'
            const downloadLabel =
              exportGifProgress?.label === 'recording'
                ? `Recording… ${Math.round(exportGifProgress.ratio * 100)}%`
                : exportGifProgress?.label === 'encoding'
                  ? 'Encoding…'
                  : exportGifProgress?.label === 'done'
                    ? 'Saved!'
                    : 'Download GIF'
            const closeModal = () => {
              if (isExporting) return
              playUiClick()
              setShowExportGif(false)
              setExportGifProgress(null)
            }
            const handleDownload = async () => {
              if (isExporting || snapshotsToExport.length === 0) return
              setExportGifProgress({ ratio: 0, label: 'recording' })
              try {
                await captureMultiHighlightReelAsGif({
                  snapshots: snapshotsToExport,
                  onProgress: setExportGifProgress,
                })
              } catch {
                // Quiet recovery — a failed export reverts the
                // button label without surfacing a modal-on-modal
                // dialog the player can't action.
                setExportGifProgress(null)
                return
              }
              window.setTimeout(() => setExportGifProgress(null), 1500)
            }
            const adjustCount = (delta: number) => {
              playUiClick()
              setExportGifCount((current) =>
                Math.max(1, Math.min(current + delta, maxCount)),
              )
            }
            return (
              <div
                className="hexaclear-popover-overlay"
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return
                  closeModal()
                }}
              >
                <div className="hexaclear-overlay-card hexaclear-export-gif-card">
                  <div className="hexaclear-piece-detail-nickname">
                    Export recent moves
                  </div>
                  <MultiHighlightReel
                    key={`export-preview-${clampedCount}`}
                    snapshots={snapshotsToExport}
                  />
                  <div className="hexaclear-export-gif-meta">
                    {snapshotsToExport.length === 1
                      ? '1 move'
                      : `${snapshotsToExport.length} moves`}
                    {' · '}
                    {totalPoints} points
                  </div>
                  <div
                    className="hexaclear-export-gif-stepper"
                    aria-label="Number of recent moves to export"
                  >
                    <button
                      type="button"
                      className="hexaclear-export-gif-step"
                      onClick={() => adjustCount(-1)}
                      disabled={isExporting || clampedCount <= 1}
                      aria-label="Decrease move count"
                    >
                      −
                    </button>
                    <input
                      type="number"
                      className="hexaclear-export-gif-count"
                      min={1}
                      max={maxCount}
                      step={1}
                      value={clampedCount}
                      disabled={isExporting}
                      onChange={(e) => {
                        const raw = Number(e.target.value)
                        if (!Number.isFinite(raw)) return
                        setExportGifCount(
                          Math.max(1, Math.min(Math.round(raw), maxCount)),
                        )
                      }}
                      aria-label="Move count"
                    />
                    <button
                      type="button"
                      className="hexaclear-export-gif-step"
                      onClick={() => adjustCount(1)}
                      disabled={isExporting || clampedCount >= maxCount}
                      aria-label="Increase move count"
                    >
                      +
                    </button>
                    <span className="hexaclear-export-gif-step-label">
                      moves (max {maxCount})
                    </span>
                  </div>
                  <div className="hexaclear-export-gif-actions">
                    <button
                      type="button"
                      className="hexaclear-reel-download hexaclear-export-gif-download"
                      onClick={handleDownload}
                      disabled={
                        isExporting || snapshotsToExport.length === 0
                      }
                    >
                      {downloadLabel}
                    </button>
                    <button
                      type="button"
                      className="hexaclear-menu-link"
                      onClick={closeModal}
                      disabled={isExporting}
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )
          })()}
          {selectedPieceVariant && (() => {
            // Piecetiary detail sheet. Opens when the player taps a
            // tile inside the "How to Play › Piecetiary" tab. Shows
            // the variant's mini-preview + notation + nickname, a
            // 1-2 line playful flavor blurb derived from this
            // device's history with the piece, and a compact stat
            // table. Click-outside / Close button dismisses.
            const variant = selectedPieceVariant
            const stats: PieceVariantStats = getPieceStats(
              pieceStats,
              variant.id,
            )
            const nickname =
              PIECE_VARIANT_NAMES[variant.id] ?? variant.notation
            const hasAny =
              stats.timesPlayed > 0 || stats.killingHands > 0
            // Stat rows are only surfaced when there's data behind
            // them — the empty piece detail card just shows "no
            // history yet" copy without a giant zero grid. Keeps
            // the modal honest about retrospection (it's not goals).
            // Labels are kept terse so the two-column grid below
            // can render an even left/right ribbon of pairs without
            // wrapping. Order matters: we want the most universally
            // relevant stats first (Played, Clears) so even pieces
            // with light data have a meaningful first row.
            const statRows: Array<{ label: string; value: string }> = []
            if (hasAny) {
              statRows.push({
                label: 'Played',
                value: String(stats.timesPlayed),
              })
              if (stats.clearsCaused > 0) {
                statRows.push({
                  label: 'Clears',
                  value: String(stats.clearsCaused),
                })
              }
              if (stats.combosJoined > 0) {
                statRows.push({
                  label: 'Combos',
                  value: String(stats.combosJoined),
                })
              }
              if (stats.timesPlayed > 0) {
                statRows.push({
                  label: 'Avg. Score',
                  value: String(averagePoints(stats, variant)),
                })
              }
              if (stats.bestClear > 0) {
                statRows.push({
                  label: 'Best Play',
                  value: `+${stats.bestClear}`,
                })
              }
              if (stats.rubiesCaptured > 0) {
                statRows.push({
                  label: 'Rubies',
                  value: String(stats.rubiesCaptured),
                })
              }
              if (stats.boardClears > 0) {
                statRows.push({
                  label: 'Board clears',
                  value: String(stats.boardClears),
                })
              }
              if (stats.killingHands > 0) {
                statRows.push({
                  label: 'Cubekilled You',
                  value: String(stats.killingHands),
                })
              }
            }
            return (
              <div
                className="hexaclear-popover-overlay"
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return
                  playUiClick()
                  setSelectedPieceVariant(null)
                }}
              >
                <div className="hexaclear-overlay-card hexaclear-piece-detail-card">
                  <div className="hexaclear-piece-detail-head">
                    <div className="hexaclear-piece-detail-preview">
                      <PiecePreview
                        shape={{
                          id: variant.id,
                          cells: variant.cells,
                          size: variant.size,
                        }}
                        mode="hand"
                      />
                    </div>
                    <div className="hexaclear-piece-detail-id">
                      <div className="hexaclear-piece-detail-nickname">
                        &ldquo;{nickname}&rdquo;
                      </div>
                      <div className="hexaclear-piece-detail-notation">
                        {variant.notation} ·{' '}
                        {variant.size === 1
                          ? '1 cube'
                          : `${variant.size} cubes`}
                      </div>
                    </div>
                  </div>
                  {statRows.length > 0 ? (
                    <dl className="hexaclear-piece-detail-stats">
                      {statRows.map((row) => (
                        <div
                          key={row.label}
                          className="hexaclear-piece-detail-stat"
                        >
                          <dt>{row.label}</dt>
                          <dd>{row.value}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <div className="hexaclear-piece-detail-empty">
                      You and {nickname} haven't crossed paths yet.
                    </div>
                  )}
                  <div className="hexaclear-piece-detail-actions">
                    <button
                      type="button"
                      className="hexaclear-menu-link"
                      onClick={() => {
                        playUiClick()
                        setSelectedPieceVariant(null)
                      }}
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )
          })()}
          {showStats && (() => {
            // Profile stats modal. Pulls all values from the cached
            // `lifetimeStats` (which is itself the localStorage
            // record). Same compact tile grid as the gameover
            // run-stats card so the surfaces feel like one family
            // — three sections (Lifetime / By mode / Records) each
            // built from a list of optional tiles. Records hide
            // tiles for unset records so a brand-new profile shows
            // a minimal "you haven't earned this yet" state instead
            // of a wall of dashes.
            const ls = lifetimeStats
            const hasAnyGame =
              ls.gamesPlayedEndless +
                ls.gamesPlayedDaily +
                ls.gamesPlayedCoop +
                ls.gamesPlayedPvp >
              0
            const totalGames =
              ls.gamesPlayedEndless +
              ls.gamesPlayedDaily +
              ls.gamesPlayedCoop +
              ls.gamesPlayedPvp
            const avgRunMs =
              totalGames > 0 ? ls.totalActivePlayMs / totalGames : 0
            const formatAverage = (value: number): string =>
              Number.isFinite(value) ? String(Math.round(value)) : '0'
            const displayTotalScore = ls.totalScore
            const avgClearsPerGame =
              totalGames > 0 ? ls.patternsCleared / totalGames : 0
            // Score/game only averages across modes that produce a
            // score (endless / big / co-op). Daily ranks by moves and
            // PvP is a territory race, so including them drags the
            // average toward zero with games that were never even
            // eligible to contribute points. `scoredGamesPlayed` and
            // `totalScore` are already kept in lockstep on the stats
            // side; see `foldRunIntoLifetime`.
            const avgScorePerGame =
              ls.scoredGamesPlayed > 0
                ? displayTotalScore / ls.scoredGamesPlayed
                : 0
            const trackingSince = formatFriendlyDate(ls.startedTrackingAt)

            const summaryStats: StatDatum[] = [
              {
                key: 'time',
                label: 'Time',
                value: formatDuration(ls.totalActivePlayMs),
              },
              {
                key: 'pieces',
                label: 'Pieces',
                value: String(ls.piecesPlaced),
              },
              {
                key: 'clears',
                label: 'Clears',
                value: String(ls.patternsCleared),
              },
              {
                key: 'rubies',
                label: 'Rubies',
                value: String(ls.rubiesCleared),
              },
              {
                key: 'total-score',
                label: 'Total score',
                value: String(displayTotalScore),
              },
            ]
            const performanceStats: StatDatum[] = [
              {
                key: 'score-game',
                label: 'Score/game',
                value: formatAverage(avgScorePerGame),
              },
              {
                key: 'time-game',
                label: 'Time/game',
                value: formatDuration(avgRunMs),
              },
              {
                key: 'clears-game',
                label: 'Clears/game',
                value: formatAverage(avgClearsPerGame),
              },
            ]
            if (ls.boardClears > 0) {
              summaryStats.push({
                key: 'boards',
                label: 'Board clears',
                value: String(ls.boardClears),
              })
            }

            const modeStats: StatDatum[] = [
              {
                key: 'endless',
                label: 'Endless',
                value: String(ls.gamesPlayedEndless),
              },
              {
                key: 'daily',
                label: 'Daily',
                value: String(ls.gamesPlayedDaily),
              },
              {
                key: 'coop',
                label: 'Co-op',
                value: String(ls.gamesPlayedCoop),
              },
            ]
            if (ls.gamesPlayedPvp > 0) {
              modeStats.push({
                key: 'pvp',
                label: 'PvP',
                value: String(ls.gamesPlayedPvp),
              })
              modeStats.push({
                key: 'pvp-wins',
                label: 'PvP wins',
                value: String(ls.pvpWins),
              })
              if (ls.pvpShames > 0) {
                modeStats.push({
                  key: 'pvp-shames',
                  label: 'Shames',
                  value: String(ls.pvpShames),
                })
              }
            }
            if (ls.dailyDaysCleared.length > 0) {
              modeStats.push({
                key: 'daily-days',
                label: 'Days cleared',
                value: String(ls.dailyDaysCleared.length),
              })
            }
            if (ls.coopPartnerIds.length > 0) {
              modeStats.push({
                key: 'partners',
                label: 'Partners',
                value: String(ls.coopPartnerIds.length),
              })
            }

            const records: StatDatum[] = []
            if (ls.bestEndlessScore > 0) {
              records.push({
                key: 'best-score',
                label: 'Best score',
                value: String(ls.bestEndlessScore),
              })
            }
            if (ls.bestDailyMoves !== null) {
              records.push({
                key: 'best-daily',
                label: 'Best daily',
                value: String(ls.bestDailyMoves),
              })
            }
            if (ls.bestCombo >= 2) {
              records.push({
                key: 'best-combo',
                label: 'Best combo',
                value: `×${ls.bestCombo}`,
              })
            }
            if (ls.bestStreak > 0) {
              records.push({
                key: 'best-streak',
                label: 'Best streak',
                value: String(ls.bestStreak),
              })
            }
            if (ls.bestSinglePlacement > 0) {
              records.push({
                key: 'best-hit',
                label: 'Best clear',
                value: `+${ls.bestSinglePlacement}`,
              })
            }
            if (ls.bestRubiesInRun > 0) {
              records.push({
                key: 'best-rubies',
                label: 'Most rubies',
                value: String(ls.bestRubiesInRun),
              })
            }
            if (ls.longestRunMs > 0) {
              records.push({
                key: 'longest',
                label: 'Longest',
                value: formatDuration(ls.longestRunMs),
              })
            }

            const renderStatLine = (stat: StatDatum) => (
              <div key={stat.key} className="hexaclear-statline">
                <span className="hexaclear-statline-label">{stat.label}</span>
                <span className="hexaclear-statline-value">{stat.value}</span>
              </div>
            )

            const renderRecordRows = (items: StatDatum[]) => {
              if (items.length === 0) return null
              return (
                <div className="hexaclear-record-book">
                  {items.map((record) => (
                    <div key={record.key} className="hexaclear-record-row">
                      <span className="hexaclear-record-label">
                        {record.label}
                      </span>
                      <span className="hexaclear-record-value">
                        {record.value}
                      </span>
                    </div>
                  ))}
                </div>
              )
            }

            const renderModeSplit = () => (
              <div className="hexaclear-mode-ledger">
                {modeStats.map((mode) => (
                  <div key={mode.key} className="hexaclear-mode-ledger-item">
                    <span className="hexaclear-mode-ledger-value">
                      {mode.value}
                    </span>
                    <span className="hexaclear-mode-ledger-label">
                      {mode.label}
                    </span>
                  </div>
                ))}
              </div>
            )

            const renderPerformancePanel = () => (
              <div className="hexaclear-performance-panel">
                <div className="hexaclear-performance-feature">
                  <span className="hexaclear-performance-feature-value">
                    {formatAverage(avgScorePerGame)}
                  </span>
                  <span className="hexaclear-performance-feature-label">
                    Score/game
                  </span>
                </div>
                <div className="hexaclear-performance-list">
                  {performanceStats
                    .filter((stat) => stat.key !== 'score-game')
                    .map(renderStatLine)}
                </div>
              </div>
            )

            const renderSummary = () => (
              <div className="hexaclear-profile-summary">
                <div className="hexaclear-profile-summary-main">
                  <span className="hexaclear-profile-summary-value">
                    {totalGames}
                  </span>
                  <span className="hexaclear-profile-summary-label">
                    {totalGames === 1 ? 'Game played' : 'Games played'}
                  </span>
                </div>
                <div className="hexaclear-profile-summary-lines">
                  {summaryStats.map((stat) => (
                    <div
                      key={stat.key}
                      className="hexaclear-profile-summary-line"
                    >
                      <span>{stat.label}</span>
                      <strong>{stat.value}</strong>
                    </div>
                  ))}
                </div>
              </div>
            )

            return (
              <div
                className="hexaclear-overlay"
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return
                  playUiClick()
                  setShowStats(false)
                  setShowMenu(true)
                }}
              >
                <div className="hexaclear-overlay-card hexaclear-stats-card">
                  <div className="title">Stats</div>
                  {!hasAnyGame ? (
                    <p className="hexaclear-scores-empty">
                      Finish a run and your stats will start filling in here.
                    </p>
                  ) : (
                    <>
                      <div className="hexaclear-stats-section">
                        <div className="hexaclear-stats-section-label">
                          Totals
                        </div>
                        {renderSummary()}
                      </div>
                      <div className="hexaclear-stats-section">
                        <div className="hexaclear-stats-section-label">
                          Averages
                        </div>
                        {renderPerformancePanel()}
                      </div>
                      <div className="hexaclear-stats-section">
                        <div className="hexaclear-stats-section-label">
                          Games Played
                        </div>
                        {renderModeSplit()}
                      </div>
                      <div className="hexaclear-stats-section">
                        <div className="hexaclear-stats-section-label">
                          Records
                        </div>
                        {renderRecordRows(records)}
                      </div>
                      <p className="hexaclear-stats-tracking-since">
                        Tracking since {trackingSince}
                      </p>
                    </>
                  )}
                  <button
                    type="button"
                    className="hexaclear-reset"
                    onClick={() => {
                      playUiClick()
                      setShowStats(false)
                      setShowMenu(true)
                    }}
                  >
                    Back
                  </button>
                </div>
              </div>
            )
          })()}
          {showDailyHistory && (() => {
            // Daily-history calendar. Renders one month at a time
            // (Sun–Sat header) with prev/next chevrons clamped to
            // the launch month on the low end and today's month on
            // the high end. Each cell is a button when its day is
            // playable (between launch and today inclusive) and
            // shows the best move count locally recorded for that
            // day, if any. Clicking a playable cell starts (or
            // replays) that day's seeded puzzle via
            // `handleStartDailyForDateKey`.
            const todayKey = getTodayKey()
            const todayParts = todayKey.split('-').map(Number)
            const todayY = todayParts[0]
            const todayM = todayParts[1]
            const launchParts = DAILY_HISTORY_LAUNCH_DATE_KEY.split('-')
              .map(Number)
            const launchY = launchParts[0]
            const launchM = launchParts[1]
            const { year, month } = historyMonth
            const monthLabel = `${FRIENDLY_MONTH_NAMES[month - 1]} ${year}`
            const firstOfMonth = new Date(year, month - 1, 1)
            const firstWeekday = firstOfMonth.getDay()
            const daysInMonth = new Date(year, month, 0).getDate()
            // 6 weeks * 7 days = 42 cells, enough to cover every
            // possible month layout without re-laying-out per month.
            const cells: Array<
              | { kind: 'blank'; key: string }
              | {
                  kind: 'day'
                  key: string
                  day: number
                  dateKey: string
                  bestMoves: number | null
                  isFuture: boolean
                  isPreLaunch: boolean
                  isToday: boolean
                  isActive: boolean
                }
            > = []
            for (let i = 0; i < firstWeekday; i++) {
              cells.push({ kind: 'blank', key: `b-${i}` })
            }
            for (let day = 1; day <= daysInMonth; day++) {
              const dateKey = buildDateKey(year, month, day)
              const isFuture = isDateKeyAfter(dateKey, todayKey)
              const isPreLaunch = isDateKeyBefore(
                dateKey,
                DAILY_HISTORY_LAUNCH_DATE_KEY,
              )
              const isToday = dateKey === todayKey
              const isActive = dateKey === game.dailyDateKey
              // Read best moves with a layered lookup so signed-in
              // accounts see clears from every device:
              //   1. The synced `dailyBestMovesByDate` map (always
              //      preferred when present — it merges across
              //      devices on each stats sync).
              //   2. The dedicated `cubic-daily-best-<key>`
              //      localStorage slot for legacy / pre-sync data.
              //   3. The runs list min, for very old saves that
              //      predate the per-day-best storage.
              // Whichever wins, we keep `bestMoves` as the smallest
              // observed value so a stale local entry can't shadow
              // a better synced one.
              let bestMoves: number | null = null
              const consider = (candidate: number | null | undefined) => {
                if (
                  typeof candidate === 'number' &&
                  Number.isFinite(candidate) &&
                  candidate > 0 &&
                  (bestMoves === null || candidate < bestMoves)
                ) {
                  bestMoves = candidate
                }
              }
              consider(lifetimeStats.dailyBestMovesByDate[dateKey])
              try {
                if (typeof window !== 'undefined') {
                  const raw = window.localStorage.getItem(
                    `cubic-daily-best-${dateKey}`,
                  )
                  const parsed = raw ? Number.parseInt(raw, 10) : NaN
                  if (Number.isFinite(parsed) && parsed > 0) {
                    consider(parsed)
                  }
                  if (bestMoves === null) {
                    const runs = loadDailyRunsForDateKey(dateKey)
                    if (runs.length > 0) {
                      const min = runs.reduce(
                        (acc, r) => Math.min(acc, r.moves),
                        Infinity,
                      )
                      if (Number.isFinite(min)) consider(min)
                    }
                  }
                }
              } catch {
                // Keep whatever we already have from the synced map.
              }
              cells.push({
                kind: 'day',
                key: dateKey,
                day,
                dateKey,
                bestMoves,
                isFuture,
                isPreLaunch,
                isToday,
                isActive,
              })
            }
            // Pad out to a full 6-week grid so the modal height
            // doesn't jump as the player flips between short and
            // long months.
            while (cells.length < 42) {
              cells.push({ kind: 'blank', key: `b-${cells.length}` })
            }
            const canGoPrev =
              year > launchY || (year === launchY && month > launchM)
            const canGoNext =
              year < todayY || (year === todayY && month < todayM)
            // Perfect-month check: every playable day in this
            // month has been cleared. Eligibility is conservative —
            // a month can only be "perfected" once it's strictly in
            // the past, or it's the current month and today is its
            // last day (i.e. no future-day puzzles remain). Days
            // before the global launch are excluded from the
            // requirement since they never had a puzzle to play, so
            // the partially-pre-launch launch month can still be
            // perfected by clearing the post-launch days.
            const todayD = Number.isFinite(todayParts[2])
              ? todayParts[2]
              : NaN
            const isPastMonth =
              year < todayY || (year === todayY && month < todayM)
            const isCurrentMonth = year === todayY && month === todayM
            const isLastDayOfCurrentMonth =
              isCurrentMonth &&
              Number.isFinite(todayD) &&
              todayD === daysInMonth
            const monthIsEligibleForPerfect =
              isPastMonth || isLastDayOfCurrentMonth
            const monthHasAnyPlayableDay = cells.some(
              (c) => c.kind === 'day' && !c.isPreLaunch && !c.isFuture,
            )
            const monthPerfected =
              monthIsEligibleForPerfect &&
              monthHasAnyPlayableDay &&
              cells.every((c) => {
                if (c.kind !== 'day') return true
                if (c.isPreLaunch) return true
                return c.bestMoves !== null
              })
            // Sum of best moves across the played days of this month
            // plus the medal tier this player has earned for it.
            // We only surface this once the month is *both* past and
            // perfected: the player needs every playable day cleared
            // before the moves total reads as a final score, and the
            // current month (even fully-cleared) is excluded so the
            // medal can't flip mid-month as the player chips away at
            // a tougher day. Thresholds per product:
            //   gold   — avg ≤ 35 moves/day
            //   silver — avg 36..60 moves/day
            //   bronze — avg > 60 moves/day
            const monthBestMovesList: number[] = cells.flatMap((c) => {
              if (c.kind !== 'day') return []
              if (c.bestMoves === null || !Number.isFinite(c.bestMoves)) {
                return []
              }
              return [c.bestMoves]
            })
            const monthTotalMoves = monthBestMovesList.reduce(
              (acc, n) => acc + n,
              0,
            )
            const monthClearedDayCount = monthBestMovesList.length
            const monthAvgMoves =
              monthClearedDayCount > 0
                ? monthTotalMoves / monthClearedDayCount
                : null
            const monthMedalEmoji =
              monthAvgMoves === null
                ? ''
                : monthAvgMoves <= 35
                  ? '🥇'
                  : monthAvgMoves <= 60
                    ? '🥈'
                    : '🥉'
            const monthMedalLabel =
              monthAvgMoves === null
                ? ''
                : monthAvgMoves <= 35
                  ? 'Gold medal'
                  : monthAvgMoves <= 60
                    ? 'Silver medal'
                    : 'Bronze medal'
            const showMonthSummary =
              monthPerfected && isPastMonth && monthClearedDayCount > 0
            const stepMonth = (delta: number) => {
              setHistoryMonth(({ year: y, month: m }) => {
                const date = new Date(y, m - 1 + delta, 1)
                return {
                  year: date.getFullYear(),
                  month: date.getMonth() + 1,
                }
              })
            }
            return (
              <div
                className="hexaclear-overlay"
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return
                  playUiClick()
                  setShowDailyHistory(false)
                }}
              >
                <div className="hexaclear-overlay-card hexaclear-history-card">
                  <div className="title">Daily History</div>
                  <div className="hexaclear-history-nav">
                    <button
                      type="button"
                      className="hexaclear-history-nav-step"
                      aria-label="Previous month"
                      onClick={() => {
                        playUiClick()
                        stepMonth(-1)
                      }}
                      disabled={!canGoPrev}
                    >
                      ‹
                    </button>
                    <span
                      className={[
                        'hexaclear-history-nav-label',
                        monthPerfected
                          ? 'hexaclear-history-nav-label-perfected'
                          : '',
                        showMonthSummary
                          ? 'hexaclear-history-nav-label-with-summary'
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <span className="hexaclear-history-nav-label-top">
                        {monthLabel}
                        {monthPerfected && (
                          <span
                            className="hexaclear-history-month-check"
                            aria-label="every day this month cleared"
                            title="Every day this month cleared"
                          >
                            ✓
                          </span>
                        )}
                      </span>
                      {showMonthSummary && (
                        <span
                          className="hexaclear-history-month-summary"
                          aria-label={`${monthMedalLabel} · ${monthTotalMoves} total moves across ${monthClearedDayCount} ${
                            monthClearedDayCount === 1 ? 'day' : 'days'
                          }`}
                          title={`${monthMedalLabel} · average ${
                            monthAvgMoves !== null
                              ? Math.round(monthAvgMoves * 10) / 10
                              : '—'
                          } moves/day`}
                        >
                          <span className="hexaclear-history-month-medal">
                            {monthMedalEmoji}
                          </span>
                          <span className="hexaclear-history-month-total">
                            {monthTotalMoves}{' '}
                            {monthTotalMoves === 1 ? 'move' : 'moves'}
                          </span>
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="hexaclear-history-nav-step"
                      aria-label="Next month"
                      onClick={() => {
                        playUiClick()
                        stepMonth(1)
                      }}
                      disabled={!canGoNext}
                    >
                      ›
                    </button>
                  </div>
                  <div
                    className="hexaclear-history-grid"
                    role="grid"
                    aria-label={`Daily puzzles for ${monthLabel}`}
                  >
                    {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(
                      (label) => (
                        <div
                          key={`hd-${label}`}
                          className="hexaclear-history-weekday"
                          aria-hidden="true"
                        >
                          {label}
                        </div>
                      ),
                    )}
                    {cells.map((cell) => {
                      if (cell.kind === 'blank') {
                        return (
                          <div
                            key={cell.key}
                            className="hexaclear-history-cell hexaclear-history-cell-blank"
                            aria-hidden="true"
                          />
                        )
                      }
                      const playable = !cell.isFuture && !cell.isPreLaunch
                      const className = [
                        'hexaclear-history-cell',
                        cell.isToday ? 'is-today' : '',
                        cell.isActive ? 'is-active' : '',
                        cell.bestMoves !== null ? 'is-cleared' : '',
                        cell.isFuture ? 'is-future' : '',
                        cell.isPreLaunch ? 'is-pre-launch' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')
                      const ariaLabel = playable
                        ? `${formatFriendlyDateKey(cell.dateKey)}${
                            cell.bestMoves !== null
                              ? `, cleared in ${cell.bestMoves} moves`
                              : ''
                          }`
                        : `${formatFriendlyDateKey(cell.dateKey)} (unavailable)`
                      return (
                        <button
                          key={cell.key}
                          type="button"
                          className={className}
                          aria-label={ariaLabel}
                          disabled={!playable}
                          onClick={() => {
                            if (!playable) return
                            playUiClick()
                            handleStartDailyForDateKey(cell.dateKey)
                          }}
                        >
                          <span className="hexaclear-history-day">
                            {cell.day}
                          </span>
                          {cell.bestMoves !== null && (
                            <span className="hexaclear-history-best">
                              {cell.bestMoves}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                  <button
                    type="button"
                    className="hexaclear-reset"
                    onClick={() => {
                      playUiClick()
                      setShowDailyHistory(false)
                    }}
                  >
                    Close
                  </button>
                </div>
              </div>
            )
          })()}
          {showHighScores && (() => {
            const todayKey = getTodayKey()
            // When the global toggle is on, we render directly off
            // the live Convex queries and pin the daily section to
            // today (per product call). When off, we keep the local
            // lists with the date stepper so old behavior is intact.
            const sortedEndless = showGlobalLeaderboard
              ? (globalEndlessScores ?? []).map((e) => ({
                  name: e.name,
                  score: e.score,
                  date: e.savedAt,
                }))
              : highScores
                  .slice()
                  .sort((a, b) => b.score - a.score || a.date - b.date)
            const dailyEntriesForDay = showGlobalLeaderboard
              ? (globalDailyScores ?? []).map((e) => ({
                  name: e.name,
                  moves: e.moves,
                  date: e.savedAt,
                }))
              : dailyHighScores
                  .slice()
                  .filter(
                    (entry) =>
                      getDateKeyFromTimestamp(entry.date) ===
                      dailyScoresDateKey,
                  )
                  .sort((a, b) => a.moves - b.moves || a.date - b.date)
            const sortedCoop = showGlobalLeaderboard
              ? (globalCoopScores ?? []).map((e) => ({
                  name: e.name,
                  score: e.score,
                  date: e.finishedAt,
                }))
              : coopHighScores
                  .slice()
                  .sort((a, b) => b.score - a.score || a.date - b.date)
                  .map((e) => ({
                    name: e.name,
                    score: e.score,
                    date: e.date,
                  }))
            const globalLoading =
              showGlobalLeaderboard &&
              (globalEndlessScores === undefined ||
                globalDailyScores === undefined ||
                globalCoopScores === undefined)
            // Both local and global daily lists are now scoped by
            // the same date stepper, so the displayed date matches
            // whichever day the player has paged to regardless of
            // toggle state.
            const dailyDateKeyForDisplay = dailyScoresDateKey
            const rankClass = (rank: number) =>
              rank === 1
                ? 'hexaclear-chip-trophy'
                : rank <= 3
                  ? 'hexaclear-chip-gold'
                  : 'hexaclear-chip-neutral'
            // Co-op now has both a global view (every group's best
            // score across all devices) and a per-device local view
            // (every co-op partnership this device has scored with,
            // deduped to each one's best run), so the tab is
            // available regardless of toggle state.
            const effectiveTab: HighScoreTab = highScoreTab
            const tabButton = (id: HighScoreTab, label: string) => (
              <button
                key={id}
                type="button"
                className={[
                  'hexaclear-scores-tab',
                  effectiveTab === id ? 'is-active' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => {
                  playUiClick()
                  setHighScoreTab(id)
                }}
                aria-pressed={effectiveTab === id}
              >
                {label}
              </button>
            )
            // Pagination plumbing shared by every tab. Each tab keeps
            // its own page index in `highScorePages`. The slice +
            // `pageStart` math lets each visible row carry its true
            // global rank (1-based) regardless of which page is
            // currently rendered.
            const PAGE_SIZE = 10
            const setPageFor = (id: HighScoreTab, next: number) => {
              setHighScorePages((prev) => ({ ...prev, [id]: next }))
            }
            const buildPageWindow = <T,>(
              entries: T[],
              tab: HighScoreTab,
            ): {
              window: T[]
              pageIndex: number
              pageCount: number
              pageStart: number
            } => {
              const total = entries.length
              const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
              // Clamp the stored page in case the entry list shrank
              // (e.g. global query returned fewer rows on refetch)
              // out from under whatever page we used to be on.
              const rawPage = highScorePages[tab] ?? 0
              const pageIndex = Math.min(Math.max(0, rawPage), pageCount - 1)
              const pageStart = pageIndex * PAGE_SIZE
              return {
                window: entries.slice(pageStart, pageStart + PAGE_SIZE),
                pageIndex,
                pageCount,
                pageStart,
              }
            }
            const PageControls = ({
              tab,
              pageIndex,
              pageCount,
              pageStart,
              total,
            }: {
              tab: HighScoreTab
              pageIndex: number
              pageCount: number
              pageStart: number
              total: number
            }) => {
              if (pageCount <= 1) return null
              const rangeStart = pageStart + 1
              const rangeEnd = Math.min(pageStart + PAGE_SIZE, total)
              return (
                <div className="hexaclear-scores-pagination">
                  <button
                    type="button"
                    className="hexaclear-scores-page-step"
                    aria-label="Previous page"
                    onClick={() => {
                      playUiClick()
                      setPageFor(tab, Math.max(0, pageIndex - 1))
                    }}
                    disabled={pageIndex === 0}
                  >
                    ‹
                  </button>
                  <span className="hexaclear-scores-page-label">
                    {rangeStart}–{rangeEnd} of {total}
                  </span>
                  <button
                    type="button"
                    className="hexaclear-scores-page-step"
                    aria-label="Next page"
                    onClick={() => {
                      playUiClick()
                      setPageFor(tab, Math.min(pageCount - 1, pageIndex + 1))
                    }}
                    disabled={pageIndex >= pageCount - 1}
                  >
                    ›
                  </button>
                </div>
              )
            }
            const endlessPage = buildPageWindow(sortedEndless, 'endless')
            const dailyPage = buildPageWindow(dailyEntriesForDay, 'daily')
            const coopPage = buildPageWindow(sortedCoop, 'coop')
            return (
              <div
                className="hexaclear-overlay"
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return
                  playUiClick()
                  setShowHighScores(false)
                  setShowMenu(true)
                }}
              >
                <div className="hexaclear-overlay-card hexaclear-scores-card">
                  <div className="title">High Scores</div>

                  <label className="hexaclear-scores-global-toggle">
                    <input
                      type="checkbox"
                      checked={showGlobalLeaderboard}
                      onChange={(e) => {
                        playUiClick()
                        setShowGlobalLeaderboard(e.target.checked)
                      }}
                    />
                    <span>Show global</span>
                  </label>

                  <div
                    className="hexaclear-scores-tabs"
                    role="tablist"
                    aria-label="Leaderboard"
                  >
                    {tabButton('endless', 'Endless')}
                    {tabButton('daily', 'Daily')}
                    {tabButton('coop', 'Co-op')}
                    {tabButton('pvp', 'PvP')}
                  </div>

                  {effectiveTab === 'endless' && (
                    <div className="hexaclear-scores-section">
                      <div className="hexaclear-scores-section-label">
                        Endless · highest score
                        {showGlobalLeaderboard ? ' (global)' : ''}
                      </div>
                      {globalLoading ? (
                        <p className="hexaclear-scores-empty">Loading global scores…</p>
                      ) : sortedEndless.length === 0 ? (
                        <p className="hexaclear-scores-empty">
                          {showGlobalLeaderboard
                            ? 'No global endless scores yet.'
                            : 'No endless scores yet. Play a game!'}
                        </p>
                      ) : (
                        <>
                          <ol className="hexaclear-scores-list">
                            {endlessPage.window.map((entry, idx) => {
                              const isRecent =
                                highScoreSaved &&
                                lastSavedHighScoreDate !== null &&
                                entry.date === lastSavedHighScoreDate
                              const rank = endlessPage.pageStart + idx + 1
                              return (
                                <li
                                  key={entry.date + entry.name + rank}
                                  className={
                                    'hexaclear-scores-row' +
                                    (isRecent ? ' recent' : '')
                                  }
                                >
                                  <span
                                    className={`hexaclear-rank-chip ${rankClass(rank)}`}
                                    aria-hidden="true"
                                  >
                                    {rank}
                                  </span>
                                  <span className="hexaclear-scores-name">
                                    {entry.name}
                                  </span>
                                  <span className="hexaclear-scores-value">
                                    {entry.score}
                                  </span>
                                </li>
                              )
                            })}
                          </ol>
                          <PageControls
                            tab="endless"
                            pageIndex={endlessPage.pageIndex}
                            pageCount={endlessPage.pageCount}
                            pageStart={endlessPage.pageStart}
                            total={sortedEndless.length}
                          />
                        </>
                      )}
                    </div>
                  )}

                  {effectiveTab === 'daily' && (
                    <div className="hexaclear-scores-section">
                      <div className="hexaclear-scores-section-label">
                        Daily · fewest moves
                        {showGlobalLeaderboard ? ' (global)' : ''}
                      </div>
                      {/* Date stepper now drives the global list too,
                          so showing it unconditionally lets the player
                          inspect any past day's global rankings. */}
                      <div className="hexaclear-scores-date-stepper">
                        <button
                          type="button"
                          className="hexaclear-scores-date-step"
                          aria-label="Previous day"
                          onClick={() => {
                            playUiClick()
                            setDailyScoresDateKey((prev) =>
                              shiftDateKey(prev || getTodayKey(), -1),
                            )
                          }}
                        >
                          ‹
                        </button>
                        <span className="hexaclear-scores-date-label">
                          {dailyScoresDateKey}
                        </span>
                        <button
                          type="button"
                          className="hexaclear-scores-date-step"
                          aria-label="Next day"
                          onClick={() => {
                            playUiClick()
                            const today = getTodayKey()
                            setDailyScoresDateKey((prev) => {
                              const next = shiftDateKey(prev || today, 1)
                              return next > today ? today : next
                            })
                          }}
                          disabled={dailyScoresDateKey >= todayKey}
                        >
                          ›
                        </button>
                      </div>
                      {globalLoading ? (
                        <p className="hexaclear-scores-empty">Loading global scores…</p>
                      ) : dailyEntriesForDay.length === 0 ? (
                        <p className="hexaclear-scores-empty">
                          No scores stored for this date
                          {dailyDateKeyForDisplay === todayKey
                            ? ". Play today's puzzle!"
                            : '.'}
                        </p>
                      ) : (
                        <>
                          <ol className="hexaclear-scores-list">
                            {dailyPage.window.map((entry, idx) => {
                              const isRecent =
                                dailyHighScoreSaved &&
                                lastSavedDailyHighScoreDate !== null &&
                                entry.date === lastSavedDailyHighScoreDate
                              const rank = dailyPage.pageStart + idx + 1
                              return (
                                <li
                                  key={entry.date + entry.name + rank}
                                  className={
                                    'hexaclear-scores-row' +
                                    (isRecent ? ' recent' : '')
                                  }
                                >
                                  <span
                                    className={`hexaclear-rank-chip ${rankClass(rank)}`}
                                    aria-hidden="true"
                                  >
                                    {rank}
                                  </span>
                                  <span className="hexaclear-scores-name">
                                    {entry.name}
                                  </span>
                                  <span className="hexaclear-scores-value">
                                    {entry.moves} moves
                                  </span>
                                </li>
                              )
                            })}
                          </ol>
                          <PageControls
                            tab="daily"
                            pageIndex={dailyPage.pageIndex}
                            pageCount={dailyPage.pageCount}
                            pageStart={dailyPage.pageStart}
                            total={dailyEntriesForDay.length}
                          />
                        </>
                      )}
                      {dailyScoresDateKey !== todayKey && (
                        <button
                          type="button"
                          className="hexaclear-menu-link hexaclear-scores-today-link"
                          onClick={() => {
                            playUiClick()
                            setDailyScoresDateKey(todayKey)
                          }}
                        >
                          Jump to today
                        </button>
                      )}
                    </div>
                  )}

                  {effectiveTab === 'coop' && (
                    <div className="hexaclear-scores-section">
                      <div className="hexaclear-scores-section-label">
                        Co-op · highest score
                        {showGlobalLeaderboard ? ' (global)' : ''}
                      </div>
                      {globalLoading ? (
                        <p className="hexaclear-scores-empty">
                          Loading global scores…
                        </p>
                      ) : sortedCoop.length === 0 ? (
                        <p className="hexaclear-scores-empty">
                          {showGlobalLeaderboard
                            ? 'No co-op finishes yet. Grab a friend!'
                            : 'No co-op runs on this device yet. Grab a friend!'}
                        </p>
                      ) : (
                        <>
                          <ol className="hexaclear-scores-list">
                            {coopPage.window.map((entry, idx) => {
                              const rank = coopPage.pageStart + idx + 1
                              return (
                                <li
                                  key={entry.date + entry.name + rank}
                                  className="hexaclear-scores-row"
                                >
                                  <span
                                    className={`hexaclear-rank-chip ${rankClass(rank)}`}
                                    aria-hidden="true"
                                  >
                                    {rank}
                                  </span>
                                  <span className="hexaclear-scores-name">
                                    {entry.name}
                                  </span>
                                  <span className="hexaclear-scores-value">
                                    {entry.score}
                                  </span>
                                </li>
                              )
                            })}
                          </ol>
                          <PageControls
                            tab="coop"
                            pageIndex={coopPage.pageIndex}
                            pageCount={coopPage.pageCount}
                            pageStart={coopPage.pageStart}
                            total={sortedCoop.length}
                          />
                        </>
                      )}
                    </div>
                  )}

                  {effectiveTab === 'pvp' && (() => {
                    // Global PvP leaderboard. Always global (no
                    // local store), so we ignore the
                    // showGlobalLeaderboard toggle for this tab.
                    // Sort flips the server-side ordering between
                    // derived rank score (games × win-rate, the
                    // default) and raw wins. Both columns render
                    // either way so the player can compare.
                    const rows = (globalPvpScores ?? []).map((e) => ({
                      ...e,
                      // Display-only win rate: wins / (wins +
                      // losses). 0 when neither side has a value
                      // yet so a brand-new row renders 0% instead
                      // of NaN.
                      winRate:
                        e.wins + e.losses > 0
                          ? e.wins / (e.wins + e.losses)
                          : 0,
                    }))
                    const pvpPage = buildPageWindow(rows, 'pvp')
                    const loadingPvp = globalPvpScores === undefined
                    const selfId = playerId
                    return (
                      <div className="hexaclear-scores-section">
                        <div className="hexaclear-scores-section-label">
                          PvP · {pvpSortBy === 'rank' ? 'global rank' : 'most wins'}
                        </div>
                        <div
                          className="hexaclear-pvp-sort-toggle"
                          role="radiogroup"
                          aria-label="Sort PvP leaderboard"
                        >
                          <button
                            type="button"
                            role="radio"
                            aria-checked={pvpSortBy === 'rank'}
                            className={[
                              'hexaclear-pvp-sort-pill',
                              pvpSortBy === 'rank' ? 'is-active' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            onClick={() => {
                              if (pvpSortBy !== 'rank') {
                                playUiClick()
                                setPvpSortBy('rank')
                              }
                            }}
                          >
                            Rank
                          </button>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={pvpSortBy === 'wins'}
                            className={[
                              'hexaclear-pvp-sort-pill',
                              pvpSortBy === 'wins' ? 'is-active' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            onClick={() => {
                              if (pvpSortBy !== 'wins') {
                                playUiClick()
                                setPvpSortBy('wins')
                              }
                            }}
                          >
                            Wins
                          </button>
                        </div>
                        {loadingPvp ? (
                          <p className="hexaclear-scores-empty">
                            Loading global PvP leaderboard…
                          </p>
                        ) : rows.length === 0 ? (
                          <p className="hexaclear-scores-empty">
                            No PvP matches yet — be the first.
                          </p>
                        ) : (
                          <>
                            <div className="hexaclear-pvp-scores-header">
                              <span className="col-rank">#</span>
                              <span className="col-name">Player</span>
                              <span className="col-record">W–L</span>
                              <span className="col-score">Score</span>
                            </div>
                            <ol className="hexaclear-scores-list hexaclear-pvp-scores-list">
                              {pvpPage.window.map((entry, idx) => {
                                const rank = pvpPage.pageStart + idx + 1
                                const isYou = entry.playerId === selfId
                                return (
                                  <li
                                    key={entry.playerId}
                                    className={[
                                      'hexaclear-scores-row',
                                      'hexaclear-pvp-scores-row',
                                      isYou ? 'recent' : '',
                                    ]
                                      .filter(Boolean)
                                      .join(' ')}
                                  >
                                    <span
                                      className={`hexaclear-rank-chip ${rankClass(rank)}`}
                                      aria-hidden="true"
                                    >
                                      {rank}
                                    </span>
                                    <span className="hexaclear-scores-name">
                                      {entry.name}
                                      {isYou ? ' (you)' : ''}
                                    </span>
                                    <span className="hexaclear-pvp-record">
                                      {entry.wins}–{entry.losses}
                                      <span className="hexaclear-pvp-record-rate">
                                        {Math.round(entry.winRate * 100)}%
                                      </span>
                                    </span>
                                    <span className="hexaclear-scores-value hexaclear-pvp-rank-score">
                                      {entry.rankScore.toFixed(1)}
                                    </span>
                                  </li>
                                )
                              })}
                            </ol>
                            <PageControls
                              tab="pvp"
                              pageIndex={pvpPage.pageIndex}
                              pageCount={pvpPage.pageCount}
                              pageStart={pvpPage.pageStart}
                              total={rows.length}
                            />
                          </>
                        )}
                      </div>
                    )
                  })()}

                  {/* Reset hiscores only wipes per-device local
                      lists; it never touches the global tables.
                      Hiding it while the global toggle is on keeps
                      the affordance from misleading players into
                      thinking they can reset the global board. */}
                  {!showGlobalLeaderboard &&
                    (!showResetConfirm ? (
                      <button
                        type="button"
                        className="hexaclear-menu-restart-link"
                        onClick={() => {
                          playUiClick()
                          setShowResetConfirm(true)
                        }}
                      >
                        Reset hiscores
                      </button>
                    ) : (
                      <div className="hexaclear-scores-confirm">
                        <p className="hexaclear-scores-confirm-text">
                          Reset all local hiscores? This cannot be undone.
                        </p>
                        <div className="hexaclear-scores-confirm-actions">
                          <button
                            type="button"
                            className="hexaclear-menu-restart-link"
                            onClick={() => {
                              playUiClick()
                              handleResetHighScores()
                            }}
                          >
                            Yes, reset
                          </button>
                          <span
                            className="hexaclear-menu-link-sep"
                            aria-hidden="true"
                          >
                            •
                          </span>
                          <button
                            type="button"
                            className="hexaclear-menu-link"
                            onClick={() => {
                              playUiClick()
                              setShowResetConfirm(false)
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ))}

                  <button
                    type="button"
                    className="hexaclear-reset"
                    onClick={() => {
                      playUiClick()
                      setShowHighScores(false)
                      setShowMenu(true)
                    }}
                  >
                    Back
                  </button>
                </div>
              </div>
            )
          })()}
        </div>

        {/* Spectators don't get a hand at all — the piece tray is the
            primary "you can play" surface and we want the absence of
            it to read at a glance. The compact spectator banner that
            replaces it lives just below the menu bar (see
            .hexaclear-spectator-banner above the board). */}
        {!mp.isSpectator && (
        <section
          className={[
            'hexaclear-hand',
            gameOverWindingDown ? 'game-over-winding-down' : '',
            // Once the daily celebration is dismissed, the hand pieces
            // are still rendered but no longer interactible. Visually
            // mark them as inert so the player isn't confused about
            // why drags don't take.
            game.mode === 'daily' &&
            game.dailyCompleted &&
            game.gameOver &&
            dailyGameOverDismissed
              ? 'is-daily-cleared-locked'
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {mpMoveStatus && (
            <div
              className={[
                'hexaclear-hand-status',
                `hexaclear-hand-status-${mpMoveStatus.kind}`,
              ].join(' ')}
              role="status"
              aria-live="polite"
            >
              {mpMoveStatus.message}
            </div>
          )}
          {ftueHint?.kind === 'hold' &&
            tutorialStage > 0 &&
            !game.gameOver && (
            <div
              className={[
                'hexaclear-ftue-action-hint',
                `is-${ftueHint.kind}`,
              ].join(' ')}
              role="status"
              aria-live="polite"
            >
              {ftueHint.text}
            </div>
          )}
          {/* Hold pocket. Lives on the leftmost edge of the hand tray so
              hand↔hold drags are short and the slot reads as a reserve
              compartment (inset, narrower, dimmer) rather than a 4th
              hand slot. Held piece renders at half scale so the pocket
              can stay compact without losing legibility. */}
          {(() => {
            const heldPiece = game.hold
            const isHiddenByUndo =
              undoAnimation != null && pendingUndoRestoreFromHold
            const displayPiece = isHiddenByUndo ? null : heldPiece
            const isSelected =
              !!displayPiece && selectedPieceId === displayPiece.id
            const isDragging =
              !!displayPiece && draggingPieceId === displayPiece.id
            const isPlayable =
              !!displayPiece && playablePieceIds.has(displayPiece.id)
            const isFailedDrop =
              !!displayPiece && failedPlacementPieceId === displayPiece.id

            return (
              <button
                key="hexaclear-hold-slot"
                ref={holdSlotRef}
                type="button"
                className={[
                  'hexaclear-hold',
                  !displayPiece ? 'is-empty' : '',
                  holdDropActive ? 'is-drop-active' : '',
                  isSelected ? 'selected' : '',
                  isDragging ? 'dragging' : '',
                  displayPiece && !isPlayable ? 'unplayable' : '',
                  isFailedDrop ? 'failed-drop' : '',
                  rescueAnimation ? 'is-rescue-flash' : '',
                  ftueHint?.kind === 'hold' && tutorialStage > 0
                    ? 'is-ftue-highlighted'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                aria-label={
                  displayPiece
                    ? `Held ${displayPiece.shape.size}-cube piece`
                    : 'Empty hold slot'
                }
                onClick={() => {
                  if (!displayPiece) {
                    if (selectedPiece && game.hand.some((p) => p.id === selectedPiece.id)) {
                      handleHoldSwap(selectedPiece.id, { kind: 'hold' })
                      setSelectedPieceId(null)
                      setHover(null)
                    }
                    return
                  }
                  setSelectedPieceId(
                    selectedPieceId === displayPiece.id
                      ? null
                      : displayPiece.id,
                  )
                  setHover(null)
                }}
                onPointerDown={(e) => {
                  if (!displayPiece) return
                  e.preventDefault()
                  unlockAudioOnGesture()
                  dragState.current = {
                    pieceId: displayPiece.id,
                    pointerId: e.pointerId,
                    pointerType: e.pointerType || null,
                  }
                  setSelectedPieceId(displayPiece.id)
                  setDraggingPieceId(displayPiece.id)
                  const wrapper = boardWrapperRef.current
                  if (wrapper) {
                    const rect = wrapper.getBoundingClientRect()
                    setGhost({
                      piece: displayPiece,
                      x: (e.clientX - rect.left) / scale,
                      y: (e.clientY - rect.top) / scale,
                      pointerType: e.pointerType || null,
                    })
                  }
                  triggerGrabHaptic()
                  playClickDown()
                }}
              >
                <span
                  className="hexaclear-hold-label"
                  aria-hidden="true"
                >
                  Hold
                </span>
                {displayPiece &&
                  !isDragging &&
                  // Hide the pocket-rendered piece while the rescue
                  // animation is flying its own copy across the
                  // board — otherwise the player sees two pieces
                  // (the smaller pocket render and the in-flight
                  // overlay) at the same time. The flight settles
                  // ~50ms before the rescueAnimation state clears,
                  // and the pocket render reappears on the next
                  // render cycle, looking like the piece "landed".
                  !(
                    rescueAnimation &&
                    rescueAnimation.piece.id === displayPiece.id
                  ) && (
                    <span
                      className="hexaclear-hold-piece"
                      style={{
                        transform: `scale(${computeHoldDisplayScale(
                          displayPiece.shape.cells,
                          holdSizing.handSlotPx,
                          holdSizing.holdPocketPx,
                        )})`,
                      }}
                    >
                      <PiecePreview
                        shape={displayPiece.shape}
                        mode="hand"
                        cubeStyles={glassCubeStylesForPiece(displayPiece)}
                      />
                    </span>
                  )}
                {isDragging && (
                  <span
                    ref={cancelMarkRef}
                    className="hexaclear-piece-cancel-mark"
                    aria-hidden="true"
                  >
                    ×
                  </span>
                )}
              </button>
            )
          })()}
          {game.handSlots.map((pieceId, slotIndex) => {
            const piece = game.hand.find((p) => p.id === pieceId) ?? null
            const isHiddenByUndo =
              undoAnimation != null &&
              pendingUndoRestoreSlotIndex != null &&
              pendingUndoRestoreSlotIndex === slotIndex
            const displayPiece = isHiddenByUndo ? null : piece
            const isSelected =
              !!displayPiece && selectedPieceId === displayPiece.id
            const isDragging =
              !!displayPiece && draggingPieceId === displayPiece.id
            const isPlayable =
              !!displayPiece && playablePieceIds.has(displayPiece.id)
            const isFailedDrop =
              !!displayPiece && failedPlacementPieceId === displayPiece.id
            const isSwapTarget = handSwapTargetSlot === slotIndex

            return (
              <button
                // Composite key: bumping handFlyInToken on a fresh hand
                // forces all three buttons to remount together so the
                // staggered fly-in animation always plays. Slot index
                // alone keeps the buttons stable across regular renders.
                key={`${handFlyInToken}-${slotIndex}`}
                ref={(el) => {
                  handButtonRefs.current[slotIndex] = el
                }}
                style={{
                  // During the deal-in the hand waits for the board
                  // cascade (base +1600ms). dealInActive stays true
                  // past the last fly-in's end (DEAL_IN_TOTAL_MS) so
                  // this value never shrinks under a running animation
                  // — except on explicit skip, where the jump-forward
                  // is the desired fast-forward.
                  ['--hexaclear-fly-in-delay' as string]: `${
                    (dealInActive ? DEAL_IN_HAND_BASE_DELAY_MS : 0) +
                    slotIndex * 175
                  }ms`,
                }}
                className={[
                  'hexaclear-piece-button',
                  // Drop the deal animation class as soon as the fly-in
                  // has completed (or the player has picked the piece
                  // up). Leaving it on means a transient class change
                  // like .failed-drop's shake can later remove its own
                  // animation rule and let CSS re-trigger the deal
                  // animation, making a misplaced piece appear to be
                  // re-dealt right after shaking back into place.
                  !isFlyInDone(slotIndex) ? 'hexaclear-piece-flyin' : '',
                  isSelected ? 'selected' : '',
                  isDragging ? 'dragging' : '',
                  piece && !isPlayable ? 'unplayable' : '',
                  isFailedDrop ? 'failed-drop' : '',
                  isSwapTarget ? 'is-swap-target' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onAnimationEnd={(e) => {
                  if (e.animationName === 'hexaclear-hand-flyin') {
                    markFlyInDone(slotIndex)
                  }
                }}
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                aria-label={
                  displayPiece
                    ? `${displayPiece.shape.size}-cube piece`
                    : 'Empty hand slot'
                }
                onClick={() => {
                  if (!displayPiece) return
                  setSelectedPieceId(
                    selectedPieceId === displayPiece.id ? null : displayPiece.id,
                  )
                  setHover(null)
                }}
                onPointerDown={(e) => {
                  if (!displayPiece) return
                  e.preventDefault()
                  // Prime audio on the very first user gesture so that
                  // mobile browsers (iOS Safari especially) allow us to
                  // start the looped scrolling sound from inside later
                  // pointermove handlers.
                  unlockAudioOnGesture()
                  // Lock in the deal animation: if the player grabs a
                  // piece mid-fly-in, treat the deal as done so a later
                  // failed-drop shake can't bounce the piece back into
                  // a fresh deal animation when its class clears.
                  markFlyInDone(slotIndex)
                  dragState.current = {
                    pieceId: displayPiece.id,
                    pointerId: e.pointerId,
                    pointerType: e.pointerType || null,
                  }
                  setSelectedPieceId(displayPiece.id)
                  setDraggingPieceId(displayPiece.id)
                  const wrapper = boardWrapperRef.current
                  if (wrapper) {
                    const rect = wrapper.getBoundingClientRect()
                    setGhost({
                      piece: displayPiece,
                      x: (e.clientX - rect.left) / scale,
                      y: (e.clientY - rect.top) / scale,
                      pointerType: e.pointerType || null,
                    })
                  }
                  triggerGrabHaptic()
                  playClickDown()
                }}
              >
                {displayPiece && !isDragging && (
                  <PiecePreview
                    shape={displayPiece.shape}
                    mode="hand"
                    cubeStyles={glassCubeStylesForPiece(displayPiece)}
                  />
                )}
                {isDragging && (
                  <span
                    ref={cancelMarkRef}
                    className="hexaclear-piece-cancel-mark"
                    aria-hidden="true"
                  >
                    ×
                  </span>
                )}
              </button>
            )
          })}
        </section>
        )}
      </main>

      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stained-glass rose-window frame
// ---------------------------------------------------------------------------
// A circular oculus of carved pale limestone that the hex board sits inside,
// turning the play field into a real rose window mounted in a cathedral wall.
// Built procedurally with 16-fold symmetry: an outer torus molding, a ring of
// radial colonettes, a ring of foiled oculi (little round lights), a cusped
// inner edge, gilt fillets, and carved corner spandrels with quatrefoils.
// Rendered as an overlay over the board (pointer-events: none in CSS); the
// central opening is transparent so the glass shows through.
const GlassRoseFrame = () => {
  const C = 500
  const N = 16
  const rInner = 430 // opening edge — the glass shows inside this
  const rTorIn = 472 // where the outer torus molding begins
  const rOuter = 499 // frame edge
  const deg = (d: number) => (d * Math.PI) / 180
  const pol = (r: number, d: number): [number, number] => [
    C + r * Math.cos(deg(d)),
    C + r * Math.sin(deg(d)),
  ]
  // Donut path (outer ring minus inner circle) via even-odd fill.
  const annulus = (rIn: number, rOut: number) =>
    `M${C - rOut},${C} A${rOut},${rOut} 0 1 0 ${C + rOut},${C} A${rOut},${rOut} 0 1 0 ${
      C - rOut
    },${C} Z M${C - rIn},${C} A${rIn},${rIn} 0 1 1 ${C + rIn},${C} A${rIn},${rIn} 0 1 1 ${
      C - rIn
    },${C} Z`

  // Gabled lancet "light" drawn at the 12-o'clock sector (apex pointing
  // outward); N rotated copies form the ring of pointed-arch lights that
  // read as a gothic rose window. Sits entirely inside the tracery band.
  const wb = 21 // half-width of a light at its base
  const rLightIn = rInner + 4
  const rLightOut = rTorIn - 9
  const cuspH = 22 // height of the pointed gable
  const lightPath =
    `M${C - wb},${C - rLightIn} L${C - wb},${C - (rLightOut - cuspH)} ` +
    `L${C},${C - rLightOut} L${C + wb},${C - (rLightOut - cuspH)} ` +
    `L${C + wb},${C - rLightIn} Z`
  const lights = Array.from({ length: N }, (_, i) => i * (360 / N))
  const mullions = Array.from({ length: N }, (_, i) => (i + 0.5) * (360 / N))
  const corners: Array<[number, number]> = [
    [142, 142],
    [858, 142],
    [142, 858],
    [858, 858],
  ]

  return (
    <div className="hexaclear-glass-frame" aria-hidden="true">
      <svg
        className="hexaclear-glass-rose"
        viewBox="0 0 1000 1000"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          {/* Pale limestone, lit from the upper-left. */}
          <linearGradient id="rose-lime" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#efe4ca" />
            <stop offset="40%" stopColor="#d3bf97" />
            <stop offset="74%" stopColor="#9a8460" />
            <stop offset="100%" stopColor="#5f4e39" />
          </linearGradient>
          {/* Recessed / shadowed stone for carved hollows + the light band. */}
          <linearGradient id="rose-shade" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#8d7a58" />
            <stop offset="55%" stopColor="#5b4b36" />
            <stop offset="100%" stopColor="#352a1d" />
          </linearGradient>
          {/* Faintly-lit deep cathedral glass behind the tracery lights. */}
          <radialGradient id="rose-eye" cx="42%" cy="36%" r="72%">
            <stop offset="0%" stopColor="#26315a" />
            <stop offset="55%" stopColor="#141633" />
            <stop offset="100%" stopColor="#060611" />
          </radialGradient>
        </defs>

        {/* The masonry wall is painted on the page background now, so the
            frame draws no spandrel — everything outside the torus is
            transparent and the wall shows straight through. Carved
            quatrefoil bosses still flank the window, sitting on that wall. */}
        {corners.map(([x, y], i) => (
          <g
            key={`corner-${i}`}
            className="rose-corner"
            transform={`translate(${x} ${y})`}
          >
            <circle className="rose-corner-stone" r="34" />
            <g className="rose-corner-foil">
              <circle cx="0" cy="-15" r="11" />
              <circle cx="0" cy="15" r="11" />
              <circle cx="-15" cy="0" r="11" />
              <circle cx="15" cy="0" r="11" />
            </g>
            <circle className="rose-corner-pip" r="6" />
          </g>
        ))}

        {/* Outer torus molding — the chunky stone rim of the oculus. */}
        <path className="rose-torus" d={annulus(rTorIn, rOuter)} />
        <circle className="rose-bead-dark" cx={C} cy={C} r={rOuter - 3} />
        <circle className="rose-bead-gilt" cx={C} cy={C} r={rTorIn + 5} />
        <circle className="rose-bead-dark" cx={C} cy={C} r={rTorIn - 1} />

        {/* Recessed light band that holds the tracery. */}
        <path className="rose-band" d={annulus(rInner, rTorIn)} />

        {/* Carved stone mullions (the slender stone bars between lights). */}
        {mullions.map((a, i) => {
          const [x0, y0] = pol(rInner + 2, a)
          const [x1, y1] = pol(rTorIn - 2, a)
          return (
            <line
              key={`mul-${i}`}
              className="rose-mullion"
              x1={x0}
              y1={y0}
              x2={x1}
              y2={y1}
            />
          )
        })}

        {/* Ring of pointed-arch lights — the rose's radiating petals,
            glazed with dark cathedral glass and cusped in gilt. */}
        {lights.map((a, i) => (
          <g key={`light-${i}`} transform={`rotate(${a} ${C} ${C})`}>
            <path className="rose-light" d={lightPath} />
            <path className="rose-light-cusp" d={lightPath} />
          </g>
        ))}

        {/* Gilt fillets bounding the tracery band. */}
        <circle className="rose-fillet" cx={C} cy={C} r={rInner} />
        <circle className="rose-bead-dark" cx={C} cy={C} r={rInner - 4} />
      </svg>
    </div>
  )
}

type PiecePreviewProps = {
  shape: ActivePiece['shape']
  mode?: 'hand' | 'board'
  /**
   * When true, tighten the SVG viewBox to the piece's own bounding
   * box (plus one hex of padding so outer hexes are fully visible)
   * instead of the default fixed 5-hex viewport. Lets a small piece
   * fill its container instead of being a tiny mark in the corner.
   * Used by the Hold pocket so 1-cube pieces don't render as dots.
   */
  fitToBounds?: boolean
  /**
   * Optional per-cube style overrides, indexed to match `shape.cells`.
   * Used by the glass theme to paint each cube its assigned jewel color
   * (the same color it will keep once placed on the board).
   */
  cubeStyles?: (React.CSSProperties | undefined)[]
}

/**
 * Per-piece display scale for the Hold pocket. Both the hand and
 * the Hold use the same 5-hex SVG viewport, so a single hex always
 * renders at (container_width / 5) px. To keep the held piece's
 * hex from rendering LARGER than the hand's (which felt visually
 * odd — a held 1-cube looked bigger than a 4-cube line in the
 * hand), we scale by (hand / hold) so the held hex matches the
 * hand hex exactly. We then clamp DOWN for pieces whose bounding
 * box would otherwise spill outside the pocket at that scale.
 *
 * `extent` is the maximum hex-axial span — a 1-cube has extent 1,
 * a 4-in-a-line has extent 4. `handSlotPx` / `holdPocketPx` are
 * measured at runtime by the layout effect that wires up the
 * ResizeObserver; both fall back gracefully to a neutral 1.0
 * scale before the first measurement lands.
 */
const computeHoldDisplayScale = (
  cells: ReadonlyArray<{ q: number; r: number }>,
  handSlotPx: number,
  holdPocketPx: number,
) => {
  let minQ = Infinity
  let maxQ = -Infinity
  let minR = Infinity
  let maxR = -Infinity
  let minS = Infinity
  let maxS = -Infinity
  for (const { q, r } of cells) {
    if (q < minQ) minQ = q
    if (q > maxQ) maxQ = q
    if (r < minR) minR = r
    if (r > maxR) maxR = r
    const s = -q - r
    if (s < minS) minS = s
    if (s > maxS) maxS = s
  }
  const extent = Math.max(maxQ - minQ, maxR - minR, maxS - minS) + 1
  // Until both refs have measured, render at 1× (the SVG already
  // fits the pocket via width: 100% / height: 100%).
  if (handSlotPx <= 0 || holdPocketPx <= 0) {
    return 1
  }
  // Scale the pocket's SVG so its hex matches the hand hex. With
  // the hold typically narrower than a hand slot this is > 1, but
  // overflow on .hexaclear-hold is clipped so the extra empty SVG
  // canvas around the centered piece is just invisible.
  const handMatchScale = handSlotPx / holdPocketPx
  // Independent cap: at scale s, the piece occupies
  // extent/5 * holdPocketPx * s. Keep that within ~90% of the
  // pocket so the piece never hugs the pocket walls.
  const pocketFitScale = (5 * 0.9) / Math.max(extent, 1)
  return Math.max(0.3, Math.min(handMatchScale, pocketFitScale))
}

const PiecePreview = ({
  shape,
  mode = 'hand',
  fitToBounds = false,
  cubeStyles,
}: PiecePreviewProps) => {
  const coords = shape.cells

  if (mode === 'board') {
    let minQ = Infinity
    let maxQ = -Infinity
    let minR = Infinity
    let maxR = -Infinity
    coords.forEach((c) => {
      minQ = Math.min(minQ, c.q)
      maxQ = Math.max(maxQ, c.q)
      minR = Math.min(minR, c.r)
      maxR = Math.max(maxR, c.r)
    })

    const width = (maxQ - minQ + 2.5) * HEX_SIZE * SQRT3
    const height = (maxR - minR + 2.5) * HEX_SIZE * 1.5

    const normalized = coords.map((c) => ({
      q: c.q - minQ,
      r: c.r - minR,
    }))

    return (
      <svg
        className="hexaclear-piece-svg"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
      >
        {normalized.map((c, idx) => {
          const { x, y } = axialToPixel(c.q, c.r)
          const cx = x + HEX_SIZE * 1
          const cy = y + HEX_SIZE * 1
          const points = buildHexPoints(cx, cy)
          const bevel = buildHexBevelPaths(cx, cy)
          return (
            <g key={idx}>
              <polygon
                points={points}
                className="hexaclear-hex piece"
                style={cubeStyles?.[idx]}
              />
              <g
                className="hexaclear-hex-bevels piece"
                aria-hidden="true"
                pointerEvents="none"
              >
                <polyline
                  className="hexaclear-hex-bevel hexaclear-hex-bevel-highlight"
                  points={bevel.highlight}
                />
                <polyline
                  className="hexaclear-hex-bevel hexaclear-hex-bevel-shadow"
                  points={bevel.shadow}
                />
              </g>
            </g>
          )
        })}
        {normalized.map((c, idx) => {
          const { x, y } = axialToPixel(c.q, c.r)
          return (
            <CubeLines
              key={`cube-${idx}`}
              cx={x + HEX_SIZE * 1}
              cy={y + HEX_SIZE * 1}
              style={cubeStyles?.[idx]}
            />
          )
        })}
      </svg>
    )
  }

  const PREVIEW_SIZE = HEX_SIZE * 0.9

  const axialToPixelPreview = (q: number, r: number) => {
    const x = PREVIEW_SIZE * (SQRT3 * q + (SQRT3 / 2) * r)
    const y = PREVIEW_SIZE * (1.5 * r)
    return { x, y }
  }

  const centers = coords.map((c) =>
    axialToPixelPreview(c.q, c.r),
  )
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  centers.forEach(({ x, y }) => {
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
  })
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  // Default canvas is a 5-hex-wide × 5-hex-tall viewport that every
  // piece is centered inside. `fitToBounds` instead tightens to the
  // piece's own bbox + one hex of padding so e.g. a 1-cube piece
  // fills its container rather than rendering at 1/5 of it.
  const CARD_W = fitToBounds
    ? maxX - minX + PREVIEW_SIZE * SQRT3
    : PREVIEW_SIZE * SQRT3 * 5
  const CARD_H = fitToBounds
    ? maxY - minY + PREVIEW_SIZE * 2
    : PREVIEW_SIZE * 1.5 * 5

  const buildPreviewHexPoints = (cx: number, cy: number): string => {
    const points: string[] = []
    for (let i = 0; i < 6; i++) {
      const angleRad = ((60 * i - 30) * Math.PI) / 180
      const x = cx + PREVIEW_SIZE * Math.cos(angleRad)
      const y = cy + PREVIEW_SIZE * Math.sin(angleRad)
      points.push(`${x},${y}`)
    }
    return points.join(' ')
  }

  return (
    <svg
      className="hexaclear-piece-svg"
      viewBox={`0 0 ${CARD_W} ${CARD_H}`}
      width={CARD_W}
      height={CARD_H}
    >
      {centers.map(({ x, y }, idx) => {
        const cx = CARD_W / 2 + (x - centerX)
        const cy = CARD_H / 2 + (y - centerY)
        const points = buildPreviewHexPoints(cx, cy)
        // Bevel paths use HEX_SIZE-relative geometry; the preview
        // is drawn at PREVIEW_SIZE so we scale the inset radius
        // factor identically here for visually-consistent bevels.
        const corners: Array<{ x: number; y: number }> = []
        for (let i = 0; i < 6; i++) {
          const angleRad = ((60 * i - 30) * Math.PI) / 180
          const r = PREVIEW_SIZE * HEX_BEVEL_RADIUS_FACTOR
          corners.push({
            x: cx + r * Math.cos(angleRad),
            y: cy + r * Math.sin(angleRad),
          })
        }
        const highlight = [corners[3], corners[4], corners[5], corners[0]]
          .map((p) => `${p.x},${p.y}`)
          .join(' ')
        const shadow = [corners[0], corners[1], corners[2], corners[3]]
          .map((p) => `${p.x},${p.y}`)
          .join(' ')
        return (
          <g key={idx}>
            <polygon
              points={points}
              className="hexaclear-hex piece"
              style={cubeStyles?.[idx]}
            />
            <g
              className="hexaclear-hex-bevels piece"
              aria-hidden="true"
              pointerEvents="none"
            >
              <polyline
                className="hexaclear-hex-bevel hexaclear-hex-bevel-highlight"
                points={highlight}
              />
              <polyline
                className="hexaclear-hex-bevel hexaclear-hex-bevel-shadow"
                points={shadow}
              />
            </g>
          </g>
        )
      })}
      {centers.map(({ x, y }, idx) => {
        const cx = CARD_W / 2 + (x - centerX)
        const cy = CARD_H / 2 + (y - centerY)
        return (
          <CubeLines
            key={`cube-${idx}`}
            cx={cx}
            cy={cy}
            size={PREVIEW_SIZE}
            style={cubeStyles?.[idx]}
          />
        )
      })}
      {/* Outline pass — drawn ON TOP of the cubes so the black rule shows on
          every edge, including the shared edge between two adjacent cubes in
          a piece (which the cubes otherwise cover from both sides). Only
          themes that opt in (e.g. Abstract/Glass) paint a stroke here; other
          themes leave it transparent. */}
      {centers.map(({ x, y }, idx) => {
        const cx = CARD_W / 2 + (x - centerX)
        const cy = CARD_H / 2 + (y - centerY)
        return (
          <polygon
            key={`outline-${idx}`}
            points={buildPreviewHexPoints(cx, cy)}
            className="hexaclear-piece-outline"
            aria-hidden="true"
            pointerEvents="none"
          />
        )
      })}
    </svg>
  )
}

export default App
