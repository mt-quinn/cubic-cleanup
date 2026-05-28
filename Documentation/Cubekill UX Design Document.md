# Cubekill — Exhaustive UX Design Document

> A hex-based, mobile-first block-clearing puzzle game.
> Working title in code/HTML: **Cubekill**. Original design doc title: *Hexaclear*. Some legacy CSS class names still use `hexaclear-*`. Other internal references: *Cubic Cleanup* (workspace name), *Cubic* (localStorage prefixes).

This document describes the **complete player-facing experience**: the game's identity, every rule, every screen, every animation, every sound, every state. It is intentionally exhaustive so that an LLM (or human designer) can critique and iterate on the design without re-reading the codebase.

It does **not** describe technical implementation (data structures, persistence layers, the Convex server) except where those choices are directly visible to the player.

---

## Table of Contents

1. [Identity & Pitch](#1-identity--pitch)
2. [Core Gameplay Loop](#2-core-gameplay-loop)
3. [The Board](#3-the-board)
4. [Pieces (Cubes)](#4-pieces-cubes)
5. [Scoring System](#5-scoring-system)
6. [Rubies (Golden Cubes)](#6-rubies-golden-cubes)
7. [Game Modes](#7-game-modes)
8. [Multiplayer](#8-multiplayer)
9. [Input & Interaction](#9-input--interaction)
10. [The Shell: HUD, Menu, Dialogs](#10-the-shell-hud-menu-dialogs)
11. [Audio](#11-audio)
12. [Visual Feedback & Animations](#12-visual-feedback--animations)
13. [Themes](#13-themes)
14. [Persistence, Accounts, Leaderboards](#14-persistence-accounts-leaderboards)
15. [Game Over Flows](#15-game-over-flows)
16. [Accessibility & Preferences](#16-accessibility--preferences)
17. [Edge Cases & State Quirks](#17-edge-cases--state-quirks)
18. [Reference Tables](#18-reference-tables)

---

## 1. Identity & Pitch

### What it is
A **hex-grid placement puzzler** in the lineage of Blockudoku / Wood Block / 1010!, played on a "flower-of-flowers" board made of seven 7-hex rosettes. Players are dealt hands of three contiguous 1–4 hex pieces and drag them onto the grid. Every filled scoring line or full rosette clears and scores points. The board is small, no scrolling exists, and the run continues until the hand can no longer make a legal move.

### Tone
- **Tactile, "feels-good" arcade puzzle.** Heavy emphasis on game feel (juice): screenshake, hitstop, score particles, layered audio per streak/combo, haptics, ripple effects, octave-stepping color progression.
- **Mobile-first.** Designed for drag-and-drop with one thumb. Desktop support is present (mouse hover preview, click-to-place) but not the primary modality.
- **Two visual identities** in one product: the default warm "Cubekill" wood-grain theme and a Windows 98 / Minesweeper homage theme.
- **Light social.** Optional online accounts sync stats across devices. Real-time multiplayer (co-op and PvP) is bolted on top of the same core engine.

### Anti-pitch
- Not a deep strategy game.
- Not turn-based or asynchronous (multiplayer is real-time, free-for-all).
- Not a roguelike, not a story game, no progression unlock tree.
- No microtransactions, no real ads (banner ads, when enabled, are joke mock previews).

### Inspiration cited in code/docs
- Blockudoku — base loop
- Vlambeer's "The Art of Screenshake" — juice philosophy (full transcript shipped in `Documentation/`)
- Tetris — hold-piece mechanic
- Windows 98 / Minesweeper — alternate theme
- 7-segment LCD digits (Win98 score readouts use the **DSEG7-Classic** font)

---

## 2. Core Gameplay Loop

The minute-to-minute loop, regardless of mode:

1. **Receive a hand of 3 pieces.** Each piece is a contiguous 1–4 hex shape in one of 6 rotations.
2. **Drag a piece to the board.** A ghost preview snaps to the nearest cell; the projected footprint highlights, and any patterns that *would* clear are previewed.
3. **Release to place.** If valid, the piece locks in.
4. **Clears resolve.** Any completed scoring lines or full rosettes clear simultaneously, cells animate out, score is awarded with combo/streak multipliers, and any rubies cleared trigger a shatter SFX + shard burst.
5. **(Optional) Park a piece in Hold.** A single Tetris-style hold slot lets the player set one piece aside for later.
6. **Repeat with remaining hand pieces.** When all 3 pieces have been played (Hold doesn't count), a new hand is dealt with a 900ms staggered fly-in animation.
7. **Run ends** when the player has no legal move with their current hand + Hold (Endless / Big), or when the daily's numbered cubes are all cleared (Daily win), or when a PvP player crosses the territory threshold (PvP win), or when everyone is stuck simultaneously (PvP SHAME).

The loop differs subtly per mode (see §7) but the input mechanics are uniform.

---

## 3. The Board

### Geometry overview
The board is a **"flower of flowers"**: one central hex rosette plus six outer rosettes arranged hexagonally around it. Adjacent rosettes *touch* (kiss along an edge) but do **not overlap**.

Two board sizes:

| Board | Per-rosette | Total cells | Used by |
|---|---|---|---|
| **Standard** | radius-1, 7 cells/rosette | **49** | Endless, Daily |
| **Big** | radius-2, 19 cells/rosette | **133** | Big (solo), Co-op, PvP |

The shape uses **axial hex coordinates** `(q, r)`. Each cell is identified by a string `"q,r"`. The visual flowers are placed so all seven rosettes share a consistent visual tilt — the outer six sit at "two-and-a-half-hex" diagonals from the center in standard mode, and at distance-5 from origin in big mode.

### Scoring patterns

Two pattern types can clear when filled:

1. **Lines** — maximal straight tracks in the three primary axial directions.
2. **Flowers (rosettes)** — every 7-cell or 19-cell hex region around a flower center.

A pattern clears the instant **every cell in that pattern is filled**. Multiple patterns can clear in the same placement (combo), and the same cell can participate in multiple clears at once.

| Board | Max line length | Scoring line length(s) | # of scoring lines | # of flowers | Total scoring patterns |
|---|---|---|---|---|---|
| Standard | 7 | exactly 7 | **15** | **7** | **22** |
| Big | 12 | 11 or 12 | **27** (12 length-12, 15 length-11) | **7** | **34** |

**Why two line lengths on Big?** Tracks that bypass the central rosette by one ring are 1 hex shorter than the absolute maximum. Visually they still span the board side-to-side, so they are kept clearable. Tracks shorter than that tolerance (e.g., length-5 short edge tracks on Standard, or length-2 nubs) are not clearable; they're geometric artifacts the player can't act on.

### Visual representation

In the **Wood theme** (default), each cell is rendered as an **isometric 3-faced cube** when filled (top face bright cream/gold, right face deep red-brown, left face mid amber). Cubes are drawn from SVG polygons inside a per-cell `CubeLines` component — not bitmap sprites, not CSS 3D — so they tint and animate cleanly.

Empty cells in Wood are dark slot dimples (`#1a0c06`) with a warm `#94633a` stroke. Around each rosette is an **etched groove**: two concentric polylines (dark inner, light outer) that read like routed wood grain. The board panel sits on a radial warm-brown wash with an orange glow shadow.

In the **Win98 theme**, the isometric cube faces are hidden. Filled cells are flat teal (`#008080`) tiles with raised/sunken Minesweeper-style 2-tone bevels. Empty cells are raised gray `#c3c3c3` tiles. Rosette grooves become closed SVG polygons with 2-tone etched strokes. The whole board panel is a flat inset gray rectangle with a beveled border.

### Coordinate debug
`DEBUG_SHOW_COORDS` exists as a constant; default `false`. Not exposed to users.

---

## 4. Pieces (Cubes)

### The piece library

Pieces are **contiguous shapes of 1–4 hexes** (polyhexes through n=4). Generated by BFS expansion from a single hex, deduplicated by rotation + reflection, yielding:

| Size | # canonical shapes | Informal names |
|---|---|---|
| 1 | 1 | singlet |
| 2 | 1 | pair |
| 3 | 3 | triangle, wedge, trio (straight line) |
| 4 | 7 | rhombus, tee, pinwheel, hook, zigzag, comma, bar |

**Total canonical shapes: 12.**

Each canonical shape can be rotated 0–5 steps (six orientations). After deduplication of rotationally symmetric shapes, the game has exactly **44 distinct rotation variants**.

### The "Piecetiary" (in-game catalog)

The help screen's "Piecetiary" tab is a scrollable grid showing every one of the 44 variants. Each tile shows:

- **A miniature SVG preview** of the piece's footprint (cubes rendered just like on the board).
- **A `q × r × s` notation** — bounding box along the three hex axes. E.g.:
  - Singlet: `1×1×1`
  - Flat 2-in-a-row: `2×1×2`
  - Y-tee: `2×3×3`
- **A disambiguating suffix** (`a`, `b`, `c`…) when multiple variants share the same bounding box, in stable canonical order.
- **A human nickname** in quotes (e.g., "Layla", "Bea", "Mateo"). These names are deliberately drawn from diverse cultural and linguistic backgrounds and a mix of genders. They have no semantic relationship to the shape they label — they're memorable, individually distinctive, and intended as colloquial shorthand ("pass me the Layla!"). The complete name list is in code:

> Bea, Kai, Amara, Yusuf, Wei, Nokomis, Aoife, Kwame, Saoirse, Ravi, Imani, Mateo, Noor, Diego, Yumiko, Tariq, Camila, Henrik, Priya, Sefu, Eliška, Cormac, Layla, Bashir, Sora, Aiyana, Rashid, Nia, Pavel, Tala, Omar, Mei, Inés, Sékou, Anya, Tendai, Kainoa, Sigrid, Devi, Chinedu, Folake, Vikram, Inara, Manaia.

### Hand of 3

- **Hand size:** Always 3 pieces.
- **Dealt all at once.** A new hand is dealt when all 3 are played out (Hold doesn't count).
- **Random** in Endless / Big (Math.random); **deterministic seeded** in Daily.
- **Random rotation** is applied per deal: each piece's canonical cells are rotated 0–5 steps independently of the canonical orientation.
- **Size budget heuristic:** While building a hand, if a candidate piece is size 4 and `totalCells + 4 > 10`, the dealer re-rolls (up to 20 tries) preferring smaller pieces. The intent is to avoid all-4 hands that immediately brick.
- **Playability guarantee:** `dealPlayableHand` tries up to 30 times to deal a hand with at least one valid placement on the current board. In practice the singlet ensures a deal is always possible if any empty cell exists.

### The Hold slot

A single Tetris-style hold buffer. Visually a small dedicated pocket to the **left** of the 3 hand slots, labeled "Hold". About 60% the visual width of a hand slot, with the piece auto-scaled to match the hand's hex pixel size.

**Rules:**
- Holds at most **1 piece** at a time.
- Drag a hand piece onto Hold to **park** it (or swap with the held piece).
- Drag the held piece into a hand slot to **pull** it (or swap with whatever's there).
- The held piece **counts toward "any valid move"** — a player whose three hand pieces are all blocked but whose held piece can still be placed is **not** game over.
- Parking the **last** hand piece into an empty Hold triggers a new hand deal (same as playing the 3rd piece).
- **Auto-rescue:** If exactly one hand piece remains, Hold is empty, and that piece has no legal placement → the engine silently moves it to Hold and deals a fresh hand. Plays the `error` SFX (signals "you almost died") + heavy haptics; piece flies into Hold with a red glow.
- Hold swaps **are not undoable** and clear the undo stack.

### Piece interactions
- **Cell must be empty** to place. Rubies and numbered daily cells are `filled` from the game's perspective — they block placement until cleared.
- **All-or-nothing.** Placement either succeeds entirely or fails entirely. There's no partial drop.

### Unplayable pieces in hand
While a hand is on screen, pieces that have **no legal placement** are dimmed (45% opacity, slight grayscale filter). The player can still pick them up — they just can't drop them anywhere except the Hold pocket or the cancel mark.

---

## 5. Scoring System

### Per-mode constants

| Mode | Points per cleared pattern | Board-clear bonus | Ruby clear bonus (per ruby) | +1 per cube placed |
|---|---|---|---|---|
| Endless | **10** | **25** | **10** | Yes |
| Daily | **10** | **25** | n/a (no rubies) | Yes |
| Big (solo & MP) | **40** | **100** | **10** | Yes |

### Per-placement formula

Awarded **only when at least one pattern clears** in the placement:

```
numClears        = number of patterns cleared this placement
comboMultiplier  = 1 + 0.5 × (numClears − 1)
streakMultiplier = 1 + 0.1 × streak_before_this_placement
rubyBonusTotal   = rubiesCleared × rubyClearedBonus
basePoints       = pointsPerClearedPattern × numClears
                   + (boardCleared ? boardClearedBonus : 0)
                   + rubyBonusTotal
pointsGained     = round(basePoints × comboMultiplier × streakMultiplier)
```

**Combo multiplier examples** (additive within a single placement, NOT compounding):

| Clears in one placement | Combo mult |
|---|---|
| 1 | ×1.0 |
| 2 | ×1.5 |
| 3 | ×2.0 |
| 4 | ×2.5 |
| 5 | ×3.0 |

**Streak** counts consecutive clearing placements. After every placement: if any pattern cleared → `streak += 1`; if not → `streak = 0`.

**Streak multiplier examples:**

| Streak before this placement | Streak mult |
|---|---|
| 0 | ×1.0 |
| 1 | ×1.1 |
| 2 | ×1.2 |
| 10 | ×2.0 |

**Combined example** (the rule the original design doc anchors on): clear 3 lines/rosettes in one placement while on a streak of 1 = `×2.0 × ×1.1 = ×2.2`, not 2.1 or 2.25.

### Flat per-cube bonus

In addition to clear scoring, every placement adds **1 point per cube cell in the placed piece** to the score. This is a small constant nudge that gives every placement (even non-clearing ones) a visible reward.

### Board-clear bonus

If a placement **empties the entire board** (was non-empty before; becomes all-empty after clears — measured before any ruby respawns into the empty board), the mode-specific bonus is added to the base. Also triggers a 900ms golden screen-flash flourish.

### Rounding

`pointsGained = Math.round(basePoints × combo × streak)`. Standard float multiplication, single round-to-nearest at the end. Per-cube +1 is added separately as an integer.

### Score tier system (visual progression)

The score counter has an **uncapped tier system** that re-skins the entire viewport every 1,000 points (Daily mode is pinned to tier 0):

- `tier = floor(score / 1000)`
- Hue rotation: `(tier × 137.5°) mod 360` — the **golden angle**, so adjacent tiers land in maximally distant colors.
- Light saturation modulation `(tier % 3) × 4` adds per-tier energy variation.

Every 5 tiers crosses an **octave**, unlocking a new visual layer:

| Octave | Tiers | What unlocks |
|---|---|---|
| 0 | 0 | Default palette |
| 1 | 1–4 | Hue shift + outline tint + background wash drift |
| 2 | 5–9 | Empty-grid stroke tint + 14s hue drift |
| 3 | 10–14 | Cube edge stroke tint + pulse |
| 4 | 15–19 | Per-face hue spread (top +6°, right −6°) on cubes |
| 5 | 20–24 | Drifting background hex pattern |
| 6+ | 25+ | Hue keeps rotating; no new visual layers |

Octave classes are additive on the viewport. Palette transitions use 1600ms cubic-bezier color fades. Tier 0 snaps instantly (no transition). On tier-up: a 1.7s radial pulse expands from the score counter; octave-up gets a larger 2.3s pulse.

The system is designed for players reaching 15,000+ points where the old 4-tier CSS lookup capped out.

---

## 6. Rubies (Golden Cubes)

Rubies are special **golden cells** treated as `filled` by the placement engine. They appear in Endless and Big modes. Daily has none.

### Counts per mode

| Mode | Active rubies on board |
|---|---|
| Endless | **1** at all times |
| Big (solo & MP) | **3** at all times |
| Daily | **0** |

### Visual
**Wood theme:** Hot-pink/rose-red cube faces (`--cube-golden-top: #ff5a8a`, right `#b01232`, left `#e23c5c`) with a pink drop-shadow glow. A `+10` text label on the cube face.

**Win98 theme:** Flat red `#ff0000` tile (no cube faces).

### Spawn rules
On a new run: spawn N rubies into separate flowers when possible.

On respawn after a clear (the typical case):
1. **Prefer filled cells.** Look for any non-forbidden filled cell to "convert" — gives the impression the new ruby *replaced* a player cube rather than appearing at random elsewhere.
2. **Else safe empty.** Pick an empty cell, flip it filled (becomes the ruby's home), but **reject** the candidate if doing so would immediately trigger a clear.
3. **Forbid same-rosette.** The cleared ruby's rosette is excluded from the new ruby's candidate pool.
4. **Forbid collisions.** No two rubies on the same cell.
5. If everything is forbidden → `null` (no ruby this round).

### Scoring
Each ruby cleared in a single placement adds `rubyClearedBonus` (10 in Endless and Big) to the **base** before multipliers. In Big mode, multiple rubies cleared in one placement stack additively.

### Capture VFX
Rubies clear with the **same shrink animation** as normal cubes, plus:
- A floating `+10` popup (`hexaclear-golden-popup`) above the cell, 900ms cream-gold text fade.
- 12 pink-shard particles (`hexaclear-ruby-shard`) bursting outward from the ruby cell, 720ms.
- A scheduled `break.wav` SFX **80ms after** the clear sound, on the AudioContext clock so it's sample-accurate.

Respawn shows no spawn animation — the new position is hidden during the 600ms clear window so the player doesn't see a "normal cube flash" before the ruby appears.

---

## 7. Game Modes

The player picks a mode from three pills in the header:

- **Endless** — classic infinite run, standard board, 1 ruby.
- **Daily** — deterministic puzzle of the day, standard board, numbered targets, fewest moves wins.
- **Multi** — Big board (radius 2) plus access to multiplayer. In code this mode is `big`.

Each mode persists its **in-progress game** under its own localStorage key (`cubic-current-game-endless`, `-daily`, `-big`). Switching modes via the toggle restores the snapshot (in-memory React state) or creates fresh state. The "last active mode" is remembered across reloads via `cubic-active-mode`.

### 7.1 Endless

**The classic loop.**
- Standard 49-cell board.
- 1 ruby active at all times.
- Score-ranked; high scores tracked locally and (optionally) globally.
- Runs end when no legal placement exists with the current hand + Hold.

**HUD specifics:**
- **Score** label + current score.
- **Streak** badge floats over the board's top-left when streak > 0, with tier classes 1–6 visualized by warming colors and growing font size (1.4rem → 2.35rem; pink → orange → red).
- **Best** banner at the top-right of header shows the local best Endless score.

### 7.2 Daily

**One puzzle per real-world calendar day, deterministic for every player.**

- Standard 49-cell board.
- **No rubies.**
- **6 numbered cubes** are pre-placed at run start — one per non-center rosette (the central flower is excluded). Each starts with **2 or 3 hits**, determined by the day's seed.
- The total numbered cube count is `dailyTotalHits`. A "cube" in the daily HUD = one hit remaining (e.g., a numbered cube showing "3" counts as 3 cubes remaining).
- **Goal:** zero out every numbered cube's hit count.

**Hit reduction:**
When a placement clears patterns, the engine counts how many **distinct cleared patterns** contain each numbered cell. The cell's hit count decrements by that many. A numbered cell at the intersection of a line and a flower clearing in the same placement ticks down **twice** in that move.

While `hits > 0`, the cell stays `filled` on the board (it survives the clear). When `hits` hits 0, the cell clears.

**Win condition:** `dailyRemainingHits === 0` → `dailyCompleted = true`. The board-clear animation plays and the daily game-over modal appears.

**Failure condition:** Player runs out of legal moves before clearing all numbered cubes. Modal shows `{n} cube(s) remained! Clear all numbered cubes to solve the Daily puzzle.`

**Ranking:** Fewer moves = better. Local Daily high score list is move-ranked (ascending). Score is tracked internally but not the headline metric.

**HUD specifics:**
- **Cubes** counter replaces Score (live count of numbered cubes remaining).
- At 0 moves played, a hint reads: `Clear all numbered cubes to win!`
- "Best (today)" banner shows the player's best move count for today's puzzle (`---` if not yet cleared).
- Score counter is pinned to tier 0 (no escalating colors).

**Determinism:**
- Seed: `YYYY-M-D` (unpadded) hashed via a small LCG. Padded `YYYY-MM-DD` inputs are normalized to unpadded before hashing so legacy seeds stay stable.
- Same calendar day → same numbered layout + same hand sequence.

**Persistence:**
- Saved to `cubic-current-game-daily` keyed by `YYYY-MM-DD`.
- Reload restores only if the stored date matches today. A new calendar day discards yesterday's save.
- Per-day individual run history stored under `cubic-daily-runs-<dateKey>` (up to 50 runs per day).
- Best moves per day: `cubic-daily-best-<dateKey>` and `lifetimeStats.dailyBestMovesByDate`.

**Past-day replay:**
A **History** button (or a date pill when replaying an archive) opens the Daily History calendar. Picking any past playable day starts that day's puzzle by feeding the archived `dateKey` to `createDailyGameState`. Replays of past dates are explicitly excluded from the global daily leaderboard (`dailyDateKey !== today`).

**Calendar launch date:** `2026-03-01`. Days before that show as "unavailable".

### 7.3 Big (solo)

- 133-cell board, 7 radius-2 rosettes.
- **3 active rubies.**
- Score values 4× the standard board (40/pattern, 100 board-clear).
- Otherwise plays exactly like Endless.

**Why 4×?** With larger rosettes, finishing a flower or filling a 12-hex line takes substantially more pieces. The 4× multiplier keeps the per-clear reward feeling commensurate.

The **Big** mode is named "Multi" in the UI's mode toggle because the same `big` mode powers multiplayer rooms; the player gets the big board either as a single-player or by inviting a friend.

When Big mode is active in single-player, the board HUD shows:
- A **Co-op / PvP** toggle (radiogroup, pre-room only).
- A **Copy Link** button. Clicking it creates a room and copies a share URL.

If the player has a Big run already in progress, the host's local board / score / rubies / streak / moves are **seeded into a Co-op room** when the link is created. PvP rooms always start fresh (no head-start territory).

### 7.4 Mode persistence

Each of the three single-player modes maintains an independent in-progress game saved on every state change. Switching modes via the toggle:
- Saves current mode's state to its key.
- Restores target mode's saved state, or creates fresh if none.
- The "last active mode" is restored on next launch.

Daily-mode saves are validated against the calendar date. A new day discards yesterday's save.

---

## 8. Multiplayer

Two flavors, both played on the **Big board**:

- **Co-op** — shared score, all players placing on a shared board.
- **PvP** — territory race, first past a threshold wins.

Up to **8 players** per room. Real-time, no turns — anyone can place anytime their hand permits.

### 8.1 Room lifecycle

#### Creating a room (host)
1. Player enters Big mode in single-player.
2. Picks Co-op or PvP via the lobby radiogroup (default Co-op).
3. Clicks **Copy Link**.
4. A 4-character code is allocated (alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ` — no `I`, no `O`), the room is created, and a share URL is built and copied:
   - Co-op: `<origin>/?room=ABCD`
   - PvP: `<origin>/?room=ABCD&mode=pvp`
5. **In Co-op only**: if the host has a Big run in progress, the board/rubies/score/streak/moves are seeded into the new room.

**Copy Link button states:** `Copy Link` → `Creating…` (disabled) → `Copied!` (green, ~2.2s) → back to `Copy Link`. If the room exists and the host clicks again, the link is re-copied (PvP host alone with no spectators wipes the board first via `prepareRoomForShare` so the invitee gets a fresh match).

If creation fails: `mpError` displays a contextual message like `Could not allocate a free room code, try again` or `Could not copy link`.

The pre-room mode toggle (Co-op vs PvP) is **hidden** after the first room is created (the link carries the mode). A non-interactive `Multi` mode pill replaces the Endless/Daily/Multi triplet while in MP.

#### Joining a room
- Visiting a URL with `?room=ABCD` auto-joins.
- If `?mode=pvp` is also present, the local UI starts in PvP-pending state to avoid a visual flicker before the room snapshot arrives.
- Server outcomes:
  - **New seat:** Player is seated; their hand + hold appear.
  - **Reconnect (same playerId):** Same slot restored, name refreshed.
  - **PvP after first move:** Player becomes a **spectator** (read-only view, no hand, no placement).
  - **Room at 8 players with stale seat (30s+ no heartbeat):** Steal the stale seat, inheriting tints/owners.
  - **Room full, no stale seat:** Spectator.
  - **Room is `gameover`:** Error: `That game has already finished`.
  - **Room not found:** `Couldn't join` modal with `That room no longer exists. Try creating a new one.`

#### Leaving a room
- **Pause menu → Leave game** (danger button).
- Game-over → **Back to single player** also leaves.
- Leaving clears the URL room param and resets local Big state.

### 8.2 Display names
- Separate from single-player high-score name. Stored under `cubic-mp-player-name`.
- First launch seeds from `cubic-player-name` if MP name is empty.
- Default: `Player`.
- Max length: 20.
- Edited in pause menu (`Co-op name` label, even in PvP).
- Edits are debounced 300ms and pushed to the server while in a room.

### 8.3 Player presence
- Heartbeat every **8 seconds** while in room.
- Server considers a seat **stale** after **30s** without a heartbeat (~3 missed beats).
- A new joiner into a full room can **steal** a stale seat, inheriting all its tints and cell owners.
- There is **no client-side UI** for "partner is idle" — disconnected players continue to render normally until evicted, which is a usability gap.

### 8.4 The smiley row (player bar)

A horizontal row of smiley faces above the board (Wood theme) or between the LCD score displays (Win98 theme). Each player gets a tile:

- Self tile first (if seated), then partners in **ring order** — "next slot after mine in the seating ring," stable across re-renders.
- 5+ players compress to a smaller layout.
- Per tile:
  - Smiley face button. Wood: 🙂 emoji. Win98: `smiley.png` raster, drawn in a beveled Win98 button.
  - Player name underneath, ellipsis if long.
  - **PvP only:** optional `#N` rank chip below the name if the player has a record on the global PvP leaderboard.
- **Self tile is interactive** (opens emote panel). **Partner tiles are read-only** (`tabIndex={-1}`, default cursor).
- When the player is alone in a room: header reads `Waiting for Partner`.

### 8.5 Emotes

The self smiley tile opens an **emote panel** — a 3×3 grid:

```
⏸️   ▶️   🤣
😭   🎉   💀
😍   🙂‍↕️   🙂‍↔️
```
(The last two are head-shake emojis with explicit variation selectors: vertical = "yes" nod, horizontal = "no" shake.)

- Title: `Send how you feel!`
- Tap an emote → broadcast via `mp.sendEmote(emoji)` → close panel → `playUiClick()`.
- Outside-panel pointerdown closes the panel.
- Each emote is displayed on the sender's and every partner's smiley tile for **10 seconds** (`PARTNER_EMOTE_TTL_MS`), then reverts to the default 🙂.
- Active emote on a partner tile triggers a 1.4s infinite gold pulse glow (Wood) or opacity pulse (Win98). Reduced motion disables the pulse.
- Spectators can see emotes but can't send (no self tile).

### 8.6 Cube tinting (co-op and PvP)

Each player's placed cubes are rendered with a per-viewer **hue shift** applied to the cube colors. **Self is always 0° (default palette)** so the player's own cubes always look the same.

**Co-op hue ladder:** Partners at `(i+1) × 15°`. 8 seats land at `0°, 15°, 30°, 45°, 60°, 75°, 90°, 105°`. All partners stay in the same "warm half" of the wheel — the table reads as one team.

**PvP hue ladder:** Partners spread evenly around the full wheel: `(i+1) × (360/N)`. With 4 PvP players: `0°, 90°, 180°, 270°`. Distinguishability wins over chromatic unity. Colors may shift when seats fill/empty (accepted tradeoff, documented in code).

Hue is applied in JS to the HSL color before output (`tintCubeColor`), not as a CSS `hue-rotate` filter, so the shift is precise and stable across render passes.

### 8.7 PvP territory mechanics

Two parallel maps drive PvP:

| Map | Semantics |
|---|---|
| `cellOwners` | Who **currently** placed the cube sitting on each filled cell. Set on placement; deleted when the cell clears. |
| `cellTints` | Who **last placed** the cube that was cleared off this cell, **persisting through subsequent placements**. Sets territory ownership. |

**Critical rule:** Clearing a cell attributes territory **to whoever originally placed the cube that was cleared**, not to the player who triggered the clear. So clearing an opponent's cube *gives them* territory. Cleverness lies in clearing your own cubes (or denying opponents).

**Empty-cell tint overlay:** In PvP only, empty cells show a translucent territory color (`pvp-tinted-self` for self, `pvp-tinted-partner` for partners with that player's hue). This is the visual representation of "who owns this ground right now."

**Conflict rings:** Cells where `cellOwners[id] !== cellTints[id]` get a colored ring (`hexaclear-hex-conflict-ring`) in the **tinter's** color — i.e., someone's currently sitting on another player's territory.

### 8.8 PvP win/loss conditions

**Win threshold (per cell count):**
```
parity   = totalCells / N
slack    = max(1, ceil(totalCells × 0.05))
threshold = ceil(parity + slack)
```

**UI ratio displayed to players:**
```
thresholdRatio = min(1, 1/N + 0.05)
```

Equivalently: `(100/N)+5%`.

**Win:** First seated player whose `cellTints` count reaches `threshold` triggers an instant match-over, with `winnerPlayerId` set.

**SHAME:** If all seated players are simultaneously stuck (`hasAnyValidMove` false on each of their hand + hold) and nobody crossed the threshold → match ends with `winnerPlayerId === null`. Every seated player counts this as a "shame" in their lifetime stats; the server submits each player as a loss to the global PvP leaderboard.

**PvP HUD (above the board):**
- Horizontal banner with one row per seated player.
- Color swatch matching cube color.
- Name (`You` for self, partner display name otherwise).
- Horizontal bar scaled to current territory %, with a vertical threshold marker on every row at the same %.
- `{N}%` at right edge of each row.
- Footer: `Win at {thresholdAbsPct}%`.
- ARIA label: `Territory: {names and percents}, ... Win at {thresholdAbsPct}%.`
- Disconnected players' tints persist on the board but don't count toward standings.
- Winner row gets `is-winner` pulse animation.

### 8.9 Spectator mode

Triggered when joining a PvP room after `moves > 0`, or joining a full room with no stale seat to steal.

- Spectator banner above board: `👁 Spectating · {N} watching` (count shown if > 1, including self).
- No hand tray rendered.
- Can see: board, PvP HUD, smileys (for seated players), emotes from seated players.
- Cannot: place pieces, hold, send emotes, trigger restart, contribute to stats/leaderboards.

### 8.10 Co-op specifics

- **Shared:** board, room score, streak, moves, ruby positions, game-over state.
- **Per player:** hand of 3, hold slot, hover ghost broadcast.
- **No turn taking** — anyone can place anytime they have a legal piece.
- Placements allowed even in server `waiting` state (the player isn't blocked from playing solo while alone).
- **Stuck-player feedback** (subtle status pill above hand):
  - If self is stuck but others can move: amber pill `{Name} still has valid moves` / `Alice & Bob still have valid moves` / `3 other players still have valid moves`.
  - If self can move but all others are stuck: blue pill `{Name} has no valid moves` (pluralized).
- **End condition:** Match ends when **no seated player** has any legal move (hand or hold).
- **Auto-rescue** applies per player, same as single-player.

### 8.11 Hover ghosts (co-op only)

Co-op partners see translucent footprints of what each other are considering:

- A partner's currently-hovered piece appears as a tinted footprint at their hover cell.
- Tint matches that partner's per-viewer hue (per §8.6).
- Opacity: ~0.65 on filled cells, ~0.32 on off-board cells (yes, off-board hovers are still drawn, since the hover signal is exploratory not validity-checked).
- Throttled to one update per ~100ms from the sender.
- Null transitions debounced 220ms to avoid flicker between adjacent cells.
- A re-stamp every 1500ms keeps the ghost alive while stationary.
- **Stale window: 3 seconds.** A ghost not refreshed in 3s disappears. Even without server updates, the client re-evaluates the stale set every 1s.
- Crash-quit / tab-close on a partner: their ghost vanishes within 3s without needing explicit cleanup.

**PvP:** hover ghosts are **disabled** — opponents don't get to telegraph their plans.

### 8.12 Multiplayer game over flows

**Co-op finished:**
- Modal title: `Co-op finished`.
- Final score shown.
- Run stats (Time, Pieces, Clears, Rubies, Board clears, Combo, Streak, Best clear).
- Co-op leaderboard section with `Global` toggle.
- Save high score path uses the combined "Alice & Bob" display name (slot-ordered names joined with ` & `), max 80 chars, ellipsis if longer.
- Buttons: `New game` (seated only — calls `restartRoom`) and `Back to single player`.

**PvP win:**
- Modal title: `You Win!` (self) or `{name} Wins`.
- Subtitle: `First past {thresholdPct}% of the field.`
- Self-win gets `is-self-won` styling — Monoton gold title with 1.6s infinite text-shadow flash.
- Final standings list (color swatch, name with `(you)` suffix for self, percent).
- Buttons: `New match` (seated only) and `Back to single player`.

**PvP SHAME:**
- Modal title: `SHAME` (Monoton 3.6rem).
- Subtitle: `NOBODY WINS`.
- Body: `Every player ran out of moves before anyone claimed {thresholdPct}% of the field.`
- Same standings list, but no winner row highlight.
- `is-shame` class desaturates the card.
- Buttons: same as PvP win, but spectators don't see `New match`.

**Restart (`restartRoom`):** Fresh board, fresh hands, clears tints and `winnerPlayerId`. Mode is preserved (you can't toggle Co-op ↔ PvP mid-room). Either player can trigger.

---

## 9. Input & Interaction

The game is **drag-primary** on touch, **drag-or-click** on desktop.

### 9.1 Picking up a piece

- Touch or mouse `pointerdown` on a hand slot or the hold pocket.
- **No movement threshold.** Drag starts immediately on pointer-down.
- **No long-press alternative.** There's no time-based gate.
- Side effects:
  - `unlockAudioOnGesture()` — first user gesture primes the AudioContext for iOS Safari.
  - `markFlyInDone(slotIndex)` — locks in the deal animation so a mid-fly-in grab doesn't get tangled.
  - `dragState` ref captures pointer ID + pointer type.
  - `setSelectedPieceId(pieceId)` — also primes click-to-place selection.
  - `setDraggingPieceId(pieceId)` — hides the source slot render and shows the × cancel mark.
  - `setGhost({ piece, x, y, pointerType })` — spawns the floating ghost.
  - `triggerGrabHaptic()` → `'heavy'` vibration via web-haptics.
  - `playClickDown()`.

The native HTML5 drag-and-drop API is **disabled** (`onDragStart={e.preventDefault()}`).

### 9.2 Dragging over the board

Global `window` listeners on `pointermove`, `mousemove`, `touchmove` track the drag.

**Two parallel previews:**
1. **Floating ghost** (`hexaclear-ghost`): the piece rendered as cubes with a drop-shadow, following the finger/cursor.
2. **Board cell preview**: cells in the snapped footprint get `.preview-valid` or `.preview-invalid` classes, with cube wiggle on cells that would clear.

**Two distinct touch offsets:**
- **Cell hit-test offset:** On touch, subtract **80px** from `clientY` before finding the closest cell. The player looks at where the piece *will land*, not at the finger.
- **Ghost render offset:** On touch, the floating ghost is translated up and slightly left via `translate(-30%, -10%)` so the piece is visible above the finger.

On mouse/pen, the piece's `(0,0)` origin cell is anchored under the cursor (no Y offset).

**Cell snap:** `findClosestCellIdFromClientPoint` always returns the nearest cell — there's no maximum snap radius. This means the player can be far off the board and still get a valid preview if the projection lands on legal cells.

**Hover triggers in non-drag flows (desktop only):** Cell polygons handle `onMouseEnter` / `onMouseLeave` so a player who has tapped a piece to select it can hover over the board to preview placements without dragging.

### 9.3 Visual preview during drag

For the projected footprint at the hovered cell:

- **Valid placement, no clear:** `preview-valid` — warm amber wash, gold stroke.
- **Valid placement, would clear:** valid wash + `preview-clear` on cells in clearing patterns. Cubes shrink to scale 0.8 and wiggle ±1.8° at 120ms alternate (touch: 580ms for readability). Empty cells in the clearing pattern get an inverse-tier stroke. Win98 uses inverse fill `--w98-inverse-fill` (default `#ff0081` magenta at tier 0).
- **Multi-clear chip:** If 2+ patterns would clear, a floating `×N` chip appears on the ghost. Tiers: `×2` at 2.55rem golden, `×3` at 3.3rem orange, `×4+` at 4.15rem red. Pop-in: 280ms.
- **Invalid placement:** `preview-invalid` — red wash with `brightness(0.7) saturate(1.3)` on cube faces. Off-board cells additionally render as `PlacementGhost` outline hexes with red fills.

### 9.4 Dropping (pointer up)

`finishDragAtPoint` is called on `pointerup`, `pointercancel`, `mouseup`, `touchend`, `touchcancel`. The drop target is resolved in priority order:

1. **Over cancel mark in source slot** → silent cancel, `playClickUp()`, clear selection.
2. **Over Hold pocket** (with a hand piece dragged) → `handleHoldSwap(pieceId, { kind: 'hold' })`.
3. **Over a hand slot** (with the held piece dragged) → `handleHoldSwap(pieceId, { kind: 'hand', slotIndex })`.
4. **Over a board cell** → `placePieceAtCell(pieceId, cellId, attemptedCellIds)`.
5. **Off-board, no target** → drop with no placement, no error.

`playClickUp()` always plays on drop, valid or not.

### 9.5 Valid placement consequences

- Snapshot pre-move state to `undoStack` (single-player only).
- Apply placement to board.
- Resolve clears.
- Trigger the full VFX pipeline (see §12):
  - Placement pop on non-clearing cells.
  - Cell clear animations (lines stagger across cells; flowers do center → ring).
  - Ripple/shockwave.
  - Score particles flying to the score counter (1400ms; counter updates at ~85%).
  - Screen shake (intensity scales with combo+streak; board-clear forces intensity ≥ 9).
  - Hitstop (90ms) on "big" clears: combo ≥ 2, streak ≥ 3, or board cleared.
  - Ruby capture VFX if any rubies cleared.
  - Board-clear flourish if the board emptied.
- Audio:
  - `playClearForStreakIndex(streak, clearCount)` — the right `clear<S>combo<C>.wav` for this streak/combo.
  - `playBreakAfterClear(80)` scheduled +80ms if any rubies cleared.
  - **Suppressed if the placement also ends the run** — `game_over.wav` owns the moment.
- Haptics: `triggerHaptics(true)` — heavy.
- New hand deal + fly-in if the 3rd piece was just played (or if Hold parking forced a redeal).

### 9.6 Invalid placement consequences

- `setFailedPlacementPieceId(pieceId)` → 190ms horizontal shake on the source button.
- `setInvalidDropCellIds(cellIds)` → 520ms red flash animation on attempted footprint.
- `playError()`.
- Piece stays in hand.

In MP, server rejection triggers the same shake/flash via the `.catch()` branch of `mp.placePiece()`.

### 9.7 Click-to-select fallback

The game supports a **click-to-select-then-click-to-place** workflow that coexists with drag:

| Action | Handler | Behavior |
|---|---|---|
| Tap/click piece | `onClick` | Toggle `selectedPieceId`; clear hover |
| `pointerdown` on piece | `onPointerDown` | Always starts drag + selects |
| Tap/click board cell | `handleCellClick` | Places if a piece is selected; keeps selection for further taps |
| Drag release on cell | `finishDragAtPoint` | Places and clears selection |
| `keydown` Enter/Space | Board cell focused | `handleCellClick` (one of the rare keyboard inputs) |

On desktop, the typical flow is click piece → hover board → click cell. On touch, the drag flow dominates because pointerdown immediately starts a drag.

### 9.8 Hold slot interactions

Hold swaps are **drag-only** (no button-press path). Drag any piece from a hand slot to the Hold pocket to park it (or swap with what's there). Drag the held piece into a hand slot to pull it (or swap with that hand slot's piece). Hold swaps are not undoable and clear the undo stack.

Visual affordances:
- `.hexaclear-hold.is-drop-active` — glowing border when a hand piece is hovered over Hold.
- `.hexaclear-piece-button.is-swap-target` — inset highlight on target hand slot when the held piece is hovered.

### 9.9 Undo

- **Single-player only.** No undo in MP (placements are server-authoritative).
- **Button location:** absolute bottom-right inside `.hexaclear-board-wrapper`, visible only when `undoStack.length > 0 && !game.gameOver`.
- **Max depth: 2** — only the last two placements within the current hand can be undone.
- Stack is **cleared** when:
  - The 3rd hand piece is played (new hand deal).
  - Auto-rescue deals a new hand.
  - A hold-park forces a redeal.
- Pressing undo:
  - Restores game state (board, hand, hold, score, streak, etc.) instantly.
  - Plays a 350ms `hexaclear-undo-fly` animation flying a piece silhouette from the cleared cells' centroid back to its slot (hand or hold).
  - Cancels in-flight clearing/popup animations.
  - **Does not** rewind `moves` in Daily mode (the move count stays current).
- Also surfaces as `Undo last move` links in some single-player game-over modals.

### 9.10 Cell tap (with selected piece)

Tap a board cell with a piece selected → places it if valid. Selection persists across multiple cell taps (useful for placing several pieces in series via click-to-select on desktop).

### 9.11 Menu interactions

- Menu opens via the ⚙️ Menu button in the header. Other open overlays (Daily History, High Scores, Stats, Account, How to Play) are closed first.
- Menu closes on:
  - Backdrop click (not pointerdown — prevents click-through to the board).
  - Any in-menu action button (Resume, Restart, navigation to a sub-dialog, etc.).
- Sub-dialogs (Stats, Account, etc.) have a `Back` button that returns to the menu.

### 9.12 Layout responsiveness

- The play column is centered with `max-width: 520px`. On tablets/desktops, the column stays phone-sized.
- Portrait phones: hand below the board; hand height `clamp(80px, 18dvh, 180px)`.
- Landscape, width ≥ 720px: the optional banner ad mock switches from inline to a side strip rotated 90°.
- Hold pocket: `clamp(72px, 22vw, 84px)` so narrow phones get a readable hold area.

### 9.13 Keyboard support

Minimal:
- Enter / Space on a focused board cell triggers `handleCellClick` if a piece is selected.
- No undo hotkey, no menu hotkeys, no piece-selection hotkeys.
- Win98 titlebar minimize/maximize/close buttons are visual-only (`tabIndex={-1}`).

### 9.14 Drag thresholds & long-press

**None.** Drag begins on the first pointerdown. No slop tolerance, no time gate. Tabs going to the background cancel in-flight drags via `visibilitychange`.

### 9.15 Hand fly-in

When a fresh hand is dealt:
- All 3 hand buttons remount with new React keys.
- 900ms `hexaclear-hand-flyin` animation: opacity 0→1, translateY(28px → overshoot → 0), scale(0.78 → overshoot → 1).
- Per-slot stagger: slot 0 at 0ms, slot 1 at 175ms, slot 2 at 350ms.
- Grabbing a piece mid-fly-in immediately marks that slot's fly-in as "done" so a later failed-drop shake can't trigger the deal animation again.

Hold pocket does **not** fly in — only hand slots.

---

## 10. The Shell: HUD, Menu, Dialogs

### 10.1 Header

Two visual rows in both themes:

**Row 1 (`.hexaclear-header-main`):**
- **Title:** `Cubekill`.
- **Waiting banner** (MP, host alone): `Waiting for Partner`.
- **Best banner** (pill at top right):
  - Endless / Big: `Best` + local best score. Hidden in Big mode (no headline best displayed there).
  - Daily: `Best (today)` if today's puzzle; else `Best` + fewest moves for that date.
- **Menu** button (⚙️ + label).

**Row 2 (`.hexaclear-header-controls`):**
- Mode pill triplet: `Endless` | `Daily` | `Multi`. Active pill has `.active`. Solo only — replaced by non-interactive `Multi` pill when in MP.
- Daily: a `History` button or, when replaying an archive, a date pill (`is-archive`, orange).
- MP (Wood theme): the smiley row.
- A `Live stat` pill: the primary headline number for the mode.

**Live stat per mode:**

| Mode | Label | Value |
|---|---|---|
| Endless | `Score` | Current score |
| Daily | `Cubes` | Numbered cubes remaining (`displayedCubesRemaining`) |
| Big | `Score` | Current score |
| MP Big | `Score` | Shared room score |
| MP Big PvP | `Score` | Shared room score (but win is territorial) |

In **Win98 theme**, the header also includes:
- A fake titlebar `Cubekill` with non-functional Minimize / Maximize / Close buttons (aria-hidden).
- An LCD row with 7-segment-style red digits showing Best on the left and Score/Cubes on the right (`---` placeholder if a daily personal best is unknown).
- The smiley row centers between the two LCDs in Win98.

### 10.2 Board HUD (overlaid on the board panel)

**Endless / Big (solo):**
- Top-left: `Streak {n}` (when streak > 0), with tier classes 1–6 escalating font size and color.
- Bottom-right: Undo button when `undoStack` is non-empty.

**Daily:**
- Top-left: `Moves` + count, or `Clear all numbered cubes to win!` hint at 0 moves.
- Bottom-right: Undo button if available.

**PvP:**
- Top: territory race bar (see §8.8).
- Spectator banner if applicable.

**Big (with inviteable room, not yet created):**
- Top-right: Co-op / PvP toggle + `Copy Link` button.

**Post-daily-clear:**
- An on-board `✓ Daily Cleared` badge with an infinite 2400ms gold pulse.

### 10.3 Hamburger Menu (`showMenu`)

A modal card titled `Cubekill`. Backdrop click closes; in-menu nav also closes.

**Primary action(s)** (one or two buttons depending on state):

| Condition | Buttons |
|---|---|
| `hasStartedSession` or MP | `Resume` |
| MP | `Leave game` (danger) |
| Solo + started session | `Restart` (danger) |
| Not started | `New Game` |

**Account strip:**
- Label: `Stats & daily history sync`.
- Status line, one of:
  - `Checking account...`
  - `Syncing online stats and daily history...`
  - `Signed in`
  - `Local only - sign in to sync stats and daily history across devices!`
- Button: `Manage` (signed in) or `Sign in` → opens Account dialog.

**Library nav cards:**
- `High Scores`
- `Stats`
- `How to Play`

**Settings:**
- (MP only) Text input `Co-op name` (max 20 chars, aria `Co-op display name`).
- Volume slider 0–100%, readout `{n}%`. Disabled when muted.
- Checkbox `Mute`.
- Theme select: `Cubekill (default)`, `Windows 98`.
- Checkbox `Reduced motion`.
- Checkbox `Ad previews`.

The menu does **not** auto-open on cold load (audio is now unlocked by the first gesture anywhere, not via a menu button).

### 10.4 How to Play (`showScoring`)

Title: `How to Play`. Two tabs:

**Rules tab** (label varies):
- Mode is Daily → `Daily Rules`
- Otherwise → `How to Score`

**Daily Rules chips:**

| Chip | Title | Description |
|---|---|---|
| `Goal` | Clear every numbered cube | Hit each cube the number of times shown on it. |
| `1 Move` | Each placement counts | Every piece you place adds one move to the run. |
| `Best` | Fewest moves wins | Your best daily run is the one finished in the fewest moves. |

**How to Score chips (Endless / Big):**

| Chip | Title | Description |
|---|---|---|
| `+10` or `+40` (big) | Line or rosette clear | Fill a straight line or a six-cube / nineteen-cube rosette. |
| `Combo` | Combo multiplier | Clear several lines or rosettes in one placement to multiply the points by 1.5× per extra clear. |
| `Streak` | Streak multiplier | Clear on back-to-back placements to multiply the points by a stacking 1.1× per consecutive clear. |
| `+10` | Ruby bonus | Clearing a ruby cube grants extra points. |
| `+25` or `+100` (big) | Board clear | Clear the entire board to get {n} bonus points. |
| `+1` | Per cube placed | Every cube you set down is worth one point. |

**Pieces tab (Piecetiary):** Scrollable grid with all 44 rotation variants. Each tile has the SVG preview, the `q×r×s` notation, and the nickname in quotes.

`Back` button returns to the menu. Backdrop click does the same.

### 10.5 High Scores (`showHighScores`)

Title: `High Scores`.

- **Global toggle** at top: checkbox `Show global`. Default **on** for new players. Persisted to `cubic-show-global-leaderboard`.
- **Tabs:** `Endless` | `Daily` | `Co-op` | `PvP`.
- **Pagination:** 10 rows per page, controls `‹` / `›` with `{start}–{end} of {total}` label.

**Endless tab:**
- Section header: `Endless · highest score` (`+ (global)` when global is on).
- Empty: `No global endless scores yet.` / `No endless scores yet. Play a game!`
- Loading: `Loading global scores…`
- Rows: rank chip (#1 = trophy, #2–3 = gold), name, score.
- Just-saved entries get a `recent` highlight.

**Daily tab:**
- Section: `Daily · fewest moves` (`+ (global)` when global on).
- Date stepper: `‹` `{dateKey}` `›`. Forward disabled at today.
- Empty: `No scores stored for this date` (+ `. Play today's puzzle!` if today).
- Rows: `{moves} moves`.
- `Jump to today` link when viewing a non-today date.

**Co-op tab:**
- Section: `Co-op · highest score` (+ ` (global)`).
- Empty: `No co-op finishes yet. Grab a friend!` / `No co-op runs on this device yet. Grab a friend!` (variants for global vs local).

**PvP tab:**
- Always global (Show global toggle ignored).
- Section: `PvP · global rank` (default) or `PvP · most wins`.
- Sort pill toggle: `Rank` | `Wins`.
- Header columns: `#` · `Player` · `W–L` · `Score`.
- Row: rank chip, name (` (you)` if self), `{wins}–{losses}` + win %, `rankScore` to 1 decimal.
- `rankScore = gamesPlayed × winRate`. Shames count as losses on submit.
- Empty: `No PvP matches yet — be the first.`
- Loading: `Loading global PvP leaderboard…`

**Reset (local only):**
- Only shown when `Show global` is off.
- Link: `Reset hiscores`
- Confirm dialog: `Reset all local hiscores? This cannot be undone.` + `Yes, reset` / `Cancel`.
- Wipes local Endless / Daily / Co-op lists. Does not touch global Convex tables.

`Back` returns to the menu.

### 10.6 Stats (`showStats`)

Title: `Stats`.

Empty: `Finish a run and your stats will start filling in here.`

When data exists, four collapsible-style sections:

**Totals:**
- Hero number: `{n}` + `Game played` / `Games played`.
- Lines:
  - `Time` (formatted duration)
  - `Pieces`
  - `Clears`
  - `Rubies`
  - `Total score`
  - `Board clears` (if > 0)

**Averages:**
- Featured: `Score/game`.
- Lines: `Time/game`, `Clears/game`.

**Games Played:**
- Ledger lines: `Endless`, `Daily`, `Co-op`, optional `PvP`, `PvP wins`, `Shames`, `Days cleared`, `Partners`.

**Records:**
- Only shown if at least one record is set. Lines:
  - `Best score`
  - `Best daily` (lowest moves)
  - `Best combo` (`×{n}`)
  - `Best streak`
  - `Best clear` (`+{n}` points in a single placement)
  - `Most rubies` (in a single run)
  - `Longest` (longest run duration)

**Footer:** `Tracking since {friendly date}`.

`Back` returns to the menu.

### 10.7 Account (`showAccount`)

Title: `Stats Sync`.

**Copy (signed out and signed in pre-sync):**
- Bold: `Your lifetime stats and daily game history on this device will be merged into your online account.`
- Body: cleared daily count + `cleared daily puzzle(s)` + calendar merge explanation.
- `Nothing local is lost. After sync, this device shows the combined online total.`

**Summary tiles (pre-sync overview):**
- `Games`, `Daily`, `Rubies`, `Score`, `Time`.

**Signed-out actions:**
- `Continue to sign in` → form mode `Sign in`.
- `Create account` → form mode `Create`.

**Form:**
- Tabs: `Sign in` | `Create`.
- Fields: `Email`, `Password` (min 8).
- Submit button label varies: `Working...` (in-flight) / `Create and sync` / `Sign in and sync`.
- Provider: email/password only (`signIn('password', ...)`).

**Signed-in state:**
- Email line: account email or `Signed in account`.
- Status: `Syncing...` / `Last synced {friendly date and time}` / `Ready to sync`.
- Button `Sync now` (disabled while syncing).
- Button `Sign out` (danger).

**Messages:**
- Success examples: `Signed in. Combining this device with online stats...` / `Stats synced. This device now shows your combined total.` / `Signed out. Local stats remain on this device.`
- Error examples: `Could not create account.` / `Could not sign in.` / `Could not sign out.` / `Stats sync did not complete.`

Auto-sync on sign-in merges the device's stats with the account's online totals via a server-side merge.

### 10.8 Daily History (`showDailyHistory`)

Title: `Daily History`.

**Month navigation:**
- `‹` `Previous month` / `›` `Next month`. Previous disabled at launch month (March 2026). Next disabled at current month.
- Center: `{Month Name} {Year}` (e.g., `March 2026`).
- "Perfect month" indicator: if every playable day in the displayed month is cleared and the month is eligible, the title shows a green check. ARIA: `every day this month cleared`.
- Past perfect months show a medal summary based on average moves/day:
  - 🥇 Gold ≤ 35 avg moves/day
  - 🥈 Silver ≤ 60
  - 🥉 Bronze otherwise

**Grid:**
- Weekday headers: `Sun` … `Sat`.
- 6×7 = 42 cell slots.
- Day cell states:

| State | Visual |
|---|---|
| Blank | Empty padding cell |
| Future / pre-launch | Faded, disabled, not clickable |
| Today | Gold border |
| Active puzzle day | Orange gradient (current `dailyDateKey`) |
| Cleared | Green gradient, corner `✓`, best move count below day number |
| Cleared + active | Orange wins; check hidden |

ARIA labels for playable days: `{friendly date}, cleared in {n} moves` or without "cleared in". Unavailable: `{friendly date} (unavailable)`.

Clicking a playable day starts that day's puzzle and closes the calendar.

**Close** button dismisses (backdrop also closes; does not return to Menu — explicit close exits cleanly).

### 10.9 Audio Unlock prompt

A full-screen overlay shown when:
- `audioNeedsUnlock` is true (player is unmuted but the AudioContext isn't running).
- The device is touch (`ontouchstart` or `maxTouchPoints > 0`).
- No other dialog is currently open.

UI:
- ARIA label: `Tap to resume audio`.
- Card title: `Tap to resume`.
- Tapping anywhere calls `unlockAudioOnGesture()`.

This exists primarily for iOS Safari, which refuses to resume an AudioContext from drag gestures (WebKit bug #248265). The first drag-only interaction with the game can leave audio silent; the prompt forces a tap-as-click somewhere.

---

## 11. Audio

### 11.1 Library

All sounds are short WAV files in `client/public/`:

| Sound | Description | Volume |
|---|---|---|
| `click_down.wav` | UI button press / piece pickup | 0.7 |
| `click_up.wav` | UI button release / drop | 0.7 |
| `error.wav` | Invalid placement / auto-rescue trigger | 0.64 (deliberately quieter) |
| `game_over.wav` | End of run flourish | 0.85 |
| `break.wav` | Ruby capture follow-up | 0.85 |
| `clear_1.wav` … `clear_7.wav` | Streak-S single-clear celebration | 0.85 each |
| `clear_<S>_combo_<C>.wav` (S=1–7, C=1–3) | Combo layer for streak S, combo size C+1 | 0.85 each |

Total: **33 clear-related WAVs** (7 streak × (1 base + 3 combo)) + UI/error/game-over/break.

### 11.2 Streak/combo SFX selection

```
streak = min(7, max(1, consecutive clearing placements))
combo  = min(3, max(0, clearCount - 1))

if combo == 0: play clear<streak>
else:          play clear<streak>combo<combo>
```

- A single clear plays the bare `clear<S>` sound.
- 2 clears → `clear<S>_combo_1`.
- 3 → `clear<S>_combo_2`.
- 4+ → `clear<S>_combo_3` (capped).
- Streak above 7 reuses `clear_7` and the combo_3 ceiling for that streak.

### 11.3 Trigger map

| Event | Sound | Notes |
|---|---|---|
| Piece pickup | `clickDown` | Plus `unlockAudioOnGesture()` |
| Drag release (any kind) | `clickUp` | Always plays on drop |
| Most UI buttons | `playUiClick` | Down + up back-to-back, scheduled tight on AudioContext clock |
| Clearing placement | `playClearForStreakIndex(streak, clearCount)` | Suppressed if the same placement ends the run |
| Ruby cleared in placement | `playBreakAfterClear(80)` | Scheduled +80ms after clear sound, sample-accurate |
| Invalid placement | `error` | Also auto-rescue, MP placement reject, hold-swap fail |
| Run ends (loss / daily fail) | `gameOver` | Not played on daily win |

### 11.4 Master controls

- **Master volume:** 0–1, default 1. Persisted to `cubic-master-volume`.
- **Mute toggle:** boolean, default false. Persisted to `cubic-muted`.
- Slider drags use `setTargetAtTime` with a 10ms time constant to avoid clicks. Mute toggle uses 5ms.

### 11.5 iOS / mobile audio session

The audio engine uses **Web Audio** with per-clip throwaway `AudioBufferSourceNode`s connected through a master gain node. This avoids the `<audio>` element race conditions that drop concurrent sounds.

For mobile robustness:
- Raw WAV bytes are cached in memory so rebuilds don't refetch.
- `visibilitychange`, `pageshow`, and `focus` events mark the AudioContext as possibly stale.
- The next user gesture closes the suspect context, builds a fresh one, and `resume()`s it inside the gesture — the only reliable way to recover from iOS audio-session theft (phone call, Spotify, control-center playback, etc.).
- Global passive gesture listeners on `pointerdown/up`, `touchstart/end`, `mousedown`, `keydown` ensure any tap anywhere primes audio.

### 11.6 Audio context unlock prompt

When the player is unmuted but the AudioContext isn't running, the audio module broadcasts a `needsUnlock` signal. On touch devices with no other dialog open, this surfaces the `Tap to resume` overlay (see §10.9).

---

## 12. Visual Feedback & Animations

### 12.1 Screenshake

- Triggered on **clears only** (not non-clearing placements).
- Class `hexaclear-shake` on `.hexaclear-board-wrapper`.
- Duration: 380ms.
- Easing: `cubic-bezier(0.36, 0.07, 0.19, 0.97)`.
- Amplitude controlled by CSS var `--hexaclear-shake-amp`.
- **Intensity formula:** `min(6, clearCount + min(streak × 0.5, 3))`. Board-clear forces intensity to at least 9.
- Reduced motion: animations collapse to ~0ms via the global override.
- Retrigger uses a token bump that forces class remove → reflow → re-add.

### 12.2 Hitstop

- Class `.cubic-viewport.hitstop`.
- 90ms freeze of all descendant CSS animations.
- Triggered on "big" clears: `clearCount ≥ 2` OR `streakAfter ≥ 3` OR `boardCleared`.
- Sells impact moments without disrupting routine play.

### 12.3 Cube placement animations

**Placement pop:**
- Class `.hexaclear-placed-overlay.placed-impact` on non-clearing cells of the placed piece.
- 200ms: scale 0.85 → 1.08 → 1.
- Clears after 220ms.

**Failed-drop shake:**
- 190ms horizontal jitter on the source hand/hold button.
- Invalid cells flash red for 520ms (`.invalid-drop` double-snap).
- Off-board ghost cubes render with `invalid-drop` styling.

### 12.4 Clear animations

**Line clears (Wood theme):**
- Cubes shrink to center, scale 0.80 → 0, opacity 1 → 0.
- 220ms each, staggered 40ms per cell across the line (`clearing-line-step-0` … `-6`).
- Hex fill goes transparent during the animation.

**Flower / rosette clears:**
- Center cell: 260ms immediate shrink.
- Ring cells: 260ms with a 190ms delay.

**Win98 clears:**
- Class `hexaclear-w98-cell-unpress`.
- Fill drains from `--w98-inverse-fill` → `--w98-surface` (`#c3c3c3`).
- Same 220/260ms timing as Wood.
- Bevels stay raised (outset) throughout.

**Clear state lifetime:** 600ms before all clearing classes/state reset.

### 12.5 Ripple / shockwave

A radial mask ripple expands from the placed piece's centroid:

- Non-clearing placement: 600ms, soft cream-gold stroke `#d7b773`.
- Clearing placement: 900ms, brighter `#ffe5a8` width 3.4.
- Driven by `requestAnimationFrame` for smooth interpolation.

### 12.6 Board-clear flourish

When the board is fully emptied:
- 900ms golden radial gradient flash (`.hexaclear-board-clear-flash`), `mix-blend-mode: screen`, scale 0.5 → 1.05 → fade.
- Stacks with intensity-9+ screenshake.
- Plays alongside the regular clear cascade.

### 12.7 Ruby animations

**Visual identity:**
- Wood: cube faces in hot pink/red with pink drop-shadow glow.
- Win98: flat red `#ff0000` tile.

**Capture VFX (per ruby cleared):**
- `+10` floating popup above the cell (`.hexaclear-golden-popup`), 900ms cream fade, `translateY(4px → -8px)`.
- 12 pink shard particles (`.hexaclear-ruby-shard`), 720ms each, flying outward `HEX_SIZE × (1.8 + (i%3)×0.25)` pixels. Stagger `(i%3)×18ms`.
- `break.wav` scheduled +80ms after the clear SFX.

**Respawn:**
- No spawn animation. The new ruby's position is hidden during the 600ms clear window so the player doesn't see a "normal cube flash" before the ruby reappears.

### 12.8 Score popup & particles

**Primary path: flying score particles** (Endless / Big):
- Spawn at the centroid of cleared cells.
- Target: live score counter (LCD in Win98, pill in Wood).
- 1400ms flight, `cubic-bezier(0.2, 0.7, 0.3, 1)`.
- Counter "merge" (score update + pop) at ~85% (≈1190ms).
- Counter pop: `.score-celebrate`, 400ms, scale 1 → 1.15 + brightness boost.
- Value: `+#N` in cream `#fff9e6`, 2.8rem Nunito 800.
- Board-clear sublabel: `BOARD CLEAR!` in `#d9a45c`.
- Particle cleanup at 1600ms.

**Fallback popup** (when counter DOM position unavailable):
- Class `.hexaclear-score-popup`.
- Text: `Clear · +N` (1 clear) or `{N} clears · +M` (multi).
- 2600ms fade, top-centered above the board.

**Daily particles:**
- `−1` per fully eliminated numbered cube, flies to the `Cubes` counter.
- `.is-negative` class tints `#ffd0a3` with red glow.

**Multi-clear ghost chip:**
- On the floating drag ghost when ≥2 patterns would clear.
- `×N` text, tiered:
  - `tier-2` (2 clears): 2.55rem, `#ffe18a`
  - `tier-3` (3 clears): 3.3rem, `#ff9d4f`
  - `tier-4` (4+ clears): 4.15rem, `#ff4d4d`
- Pop-in 280ms.

### 12.9 Score counter tier pulse

On tier or octave increase (never on decrease):

| Variant | Ring animation | HUD glow |
|---|---|---|
| Tier-up | `hexaclear-tier-pulse` 1700ms, scale to 60× | Scale 1 → 1.45 → 1 |
| Octave-up | `hexaclear-octave-pulse` 2300ms, scale to 85×, thicker initial border | Same, held 2400ms |

Ring color: `var(--score-tier-accent)`. Daily pinned to tier 0 — no pulses.

### 12.10 Streak HUD badge

Above the board, `Streak {N}` with tier classes 1–6:
- Escalating font size 1.4rem → 2.35rem.
- Warm → hot colors up to `#ff4d4d`.
- Remount key = streak count, so each increment triggers a 360ms pop animation.

### 12.11 Game-over wind-down

**Loss (endless / daily fail):**
- Immediate: `playGameOver()`, `gameOverWindingDown = true`.
- 2800ms board transition to `saturate(0.32) brightness(0.7)`.
- 1080ms hand shake (`game-over-winding-down`).
- After 2500ms total: modal appears.

**Daily win:**
- **Skips** wind-down and `game_over.wav`.
- Triggers the **board-clear golden flash** instead.
- Modal shows when `dailyCompleted && !gameOverWindingDown`.
- After dismissing (`Done`): `.daily-cleared-dismissed` desaturates board; on-board `✓ Daily Cleared` badge appears with infinite 2400ms gold pulse.

**PvP win/SHAME:** see §8.12.

### 12.12 Reduced motion

Toggle in pause menu → persisted to `cubic-reduced-motion` → class `.reduced-motion` on `.cubic-viewport`.

Global kill switch (CSS):
```
animation-duration: 0.001ms !important;
animation-delay: 0ms !important;
animation-iteration-count: 1 !important;
transition-duration: 0.001ms !important;
```

Targeted exceptions:
- Preview-clear cubes get `animation: none` + static `scale(0.8)` (prevents wiggle flicker).
- Octave background washes, grid drift, cube-edge pulse, drifting background pattern: all disabled with static fallback positions.
- Partner emote glow becomes static.

Reduced motion **does not** touch game logic, audio, or haptics — only CSS motion.

### 12.13 Cube self-rendering

Cubes are drawn as **custom SVG isometric polygons**, not bitmaps or CSS 3D:
- 6 hex vertices at `HEX_SIZE = 32`.
- 3 wedge faces (top, lower-right, lower-left) meeting at center.
- Classes: `.hexaclear-hex-cube` + `.cube-top` / `.cube-left` / `.cube-right`.
- Variants:
  - `normal` (player cubes)
  - `golden` (ruby; with `+10` label)
  - `dailyTarget` (with hit count label)
- Wiggle wrapper isolates rotation from parent transforms.
- Win98: cube faces hidden via CSS; cell polygon + bevels carry the fill; text labels still render.
- Partner tinting in MP applies inline `--cube-*-tint` CSS variables computed in JS (HSL rotation), not CSS `hue-rotate` filter.

The same renderer is used for: board cubes, placement-overlay pop, partner ghost previews, invalid off-board ghosts, hand pieces, and the Piecetiary previews.

### 12.14 Haptics

Implemented via the `web-haptics` library, which no-ops on unsupported platforms.

| Trigger | Pattern |
|---|---|
| Piece pickup | `'heavy'` |
| Piece drop (any) | `'heavy'` (regardless of clear) |

No haptics on error, game over, tier-up, or emote.

### 12.15 Banner ad mock

A joke "freemium mockup," off by default:
- Setting: pause menu **Ad previews** toggle.
- Storage: `cubic-ad-previews`.
- Image: `banner_ad.png`.
- Portrait: full-width banner between header and board.
- Landscape ≥ 720px wide: rotated 90° side strip beside the board.
- `pointer-events: none`, non-draggable, `alt="Sponsored banner ad preview"`.
- Not real ads, no network calls, no engagement.

---

## 13. Themes

### 13.1 Switching

- State: `theme: 'wood' | 'win98'` stored as `cubic-theme`.
- Applied via `document.documentElement.dataset.theme`.
- No remount — the entire theme cascades through CSS variables.
- Favicon swap: `favicon.png` (wood) vs `win_favicon.png` (win98).

### 13.2 Wood (default "Cubekill")

- Palette: warm cream / gold / amber / deep red-brown.
- Board panel: radial wash `#5a341b → #28130a` with an orange glow shadow.
- Cubes: isometric 3-face rendering with the warm palette.
- Empty cells: dark dimple `#1a0c06`, stroke `#94633a`.
- Rosette boundaries: etched 2-tone grooves.
- Title font: **Monoton** in `#ffe8a3`.
- UI: warm gradients, rounded corners, soft shadows.
- Smiley: default 🙂 emoji.

### 13.3 Win98 (Minesweeper homage)

- Palette: `#c3c3c3` surface, `#010081` titlebar blue, `#008080` teal "desktop" / filled cells, `#ff0000` LCD red / ruby.
- Board: flat gray inset panel with a 4-tone beveled border. No warm wash.
- Cells: raised empty / sunken filled tiles via bevel polylines.
- Cubes: faces hidden — flat fills only. Labels (+10, daily numbers) remain.
- LCD score: **DSEG7-Classic** seven-segment font (red on black). Padded to 3+ digits.
- Smiley: raster `smiley.png` in a beveled Win98 button.
- Ripple colors retain Wood's warm `#ffe5a8` / `#d7b773`.
- All modals: navy titlebar + beveled gray cards + forced black text.
- Fake titlebar buttons (Min/Max/Close): visual only.

### 13.4 What's the same across themes

- Game logic identical.
- Animation timing identical (220/260/600/900ms etc.).
- Audio library identical.
- Tier hue progression identical (but Win98 uses higher saturation and darker lightness for punch).
- Pieces and board geometry identical.

---

## 14. Persistence, Accounts, Leaderboards

### 14.1 Local storage keys

| Key | Contents |
|---|---|
| `cubic-active-mode` | Last selected mode (`endless` / `daily` / `big`) |
| `cubic-current-game-endless` | Saved in-progress Endless game |
| `cubic-current-game-daily` | Saved Daily game (with dateKey envelope) |
| `cubic-current-game-big` | Saved in-progress Big game |
| `cubic-highscores` | Local Endless top scores (cap 30) |
| `cubic-daily-highscores` | Local Daily top scores (cap 5) |
| `cubic-daily-runs-<dateKey>` | Per-day Daily run history (cap 50) |
| `cubic-daily-best-<dateKey>` | Local best moves for a specific date |
| `cubic-coop-highscores` | Local Co-op top scores |
| `cubic-stats-v1` | Lifetime stats record |
| `cubic-master-volume` | Audio master volume |
| `cubic-muted` | Audio mute state |
| `cubic-reduced-motion` | Reduced motion toggle |
| `cubic-ad-previews` | Ad-preview toggle |
| `cubic-theme` | Theme (`wood` / `win98`) |
| `cubic-show-global-leaderboard` | Show-global toggle in leaderboards |
| `cubic-player-name` | Default high-score name |
| `cubic-mp-player-name` | Multiplayer display name |
| `cubic-stats-sync-account-id` | Linked account for syncing |
| `cubic-stats-sync-baseline-<accountId>` | Last-known online baseline (for delta upload) |
| `cubic-stats-sync-last-at` | Last successful sync timestamp |
| `cubic-global-backfilled-v1` | One-shot flag for initial backfill of local entries to global |

### 14.2 Lifetime stats (local profile)

Stats accumulated across all runs on the device:

- `totalActivePlayMs` — total time actively playing.
- `gamesPlayedEndless`, `gamesPlayedDaily`, `gamesPlayedCoop`, `gamesPlayedPvp`.
- `pvpWins`, `pvpShames`.
- `piecesPlaced`, `cubesPlaced`, `patternsCleared`, `rubiesCleared`, `boardClears`.
- `totalScore` (across scored modes only: Endless, Big solo, Co-op MP — PvP and Daily do not contribute).
- `scoredGamesPlayed`.
- `bestEndlessScore`.
- `bestDailyMoves` (lowest).
- `bestCombo` (max simultaneous patterns in one placement).
- `bestStreak`.
- `bestSinglePlacement` (highest single-placement points).
- `bestRubiesInRun`.
- `longestRunMs`.
- `dailyDaysCleared`, `dailyDaysPlayed` (sets of `YYYY-M-D`).
- `coopPartnerIds` (distinct partners co-op'd with).
- `dailyBestMovesByDate` (per-day best move counts).

Run-level stats during a session:
- `startedAt`, `activePlayMs`.
- `piecesPlaced`, `cubesPlaced`, `patternsCleared`, `rubiesCleared`, `boardClears`.
- `bestCombo`, `bestStreak`.
- `topPlacementPoints`.

On run end, the run is **folded** into the lifetime record via `foldRunIntoLifetime`. Records are taken as a max (or min for Daily moves). Scored modes increment `totalScore` + `scoredGamesPlayed`. PvP increments win/shame counters appropriately. Daily logs the date as "played" regardless of clear; "cleared" only on success.

### 14.3 Account sync

- Email/password auth via `@convex-dev/auth`.
- On sign-in, the device's lifetime stats are uploaded as a one-time delta:
  - First sign-in: full local profile is added to the online totals.
  - Subsequent syncs: only newly earned local totals (delta vs baseline) are added.
- Baseline is the last-known online snapshot, stored under `cubic-stats-sync-baseline-<accountId>`.
- Per-day daily best moves are merged with a per-key minimum (so any signed-in device can see the per-day best for the calendar).
- Daily history calendar uses the merged map.

### 14.4 Global leaderboards (Convex)

- **`endlessScores`:** one row per `(playerId, savedAt)` pair. Sorted by score desc; ties by savedAt asc. Local saves trigger a global submit. Dedupe is per-tuple, so the one-time backfill of existing local scores doesn't double-count.
- **`dailyScores`:** dedupe per `(playerId, savedAt)`. Indexed by `(dateKey, moves)` for "today" queries.
- **`coopScores`:** one row per **unique group of players** (dedupe key = sorted `playerId`s joined with `|`). Best-score upsert. `name` is pre-baked `Alice & Bob`.
- **`pvpScores`:** one row per playerId. Lifetime record: `wins`, `losses`, `gamesPlayed`, `rankScore = gamesPlayed × winRate`. Sort by `rankScore` (default) or `wins`.

### 14.5 First-time backfill

On first launch with leaderboards available, the client does a one-shot best-effort backfill of all locally saved scores (Endless, Daily, Co-op, per-day historical Daily runs) to the global tables. Dedupe makes resubmissions safe. The `cubic-global-backfilled-v1` flag is set on success.

---

## 15. Game Over Flows

All game-over modals share a base structure (title, run stats, save/leaderboard, action buttons) but content varies by mode.

### 15.1 Endless Game Over
- **Title:** `Game Over`.
- **Headline:** `Final score` + score.
- **Run stats strip:** `Time`, `Pieces`, `Clears`, `Rubies`, and moments: `Board clears`, `Combo`, `Streak`, `Best clear`.
- **Save block** (if score qualifies):
  - Label: `New high score` / `New local high score` / `New local high score (#{rank})`.
  - Input `Your name` (placeholder).
  - `Save score` button.
- **Top scores** (5 per page) with `Global` checkbox. Loading: `Loading global scores…`. Empty global: `No global scores yet — be the first.` Off-page rank: `Your rank: #N · {score}` or `Not on the global board yet.`
- `Undo last move` link (if undo stack non-empty and not saved).
- **`Play again`** — autosaves pending high score then resets.

### 15.2 Daily Game Over

Two variants depending on `dailyCompleted`:

- **Title:** `Daily Cleared` (win) or `Daily Over` (loss).
- **Headline:** `Cleared in` / `Used` + `{moves}` + `move`/`moves`.
- **Loss subhead:** `{n} cube(s) remained! Clear all numbered cubes to solve the Daily puzzle.`
- **Run stats** (no rubies, no combo/score moments).
- **Save block:**
  - Label: `New daily best` (win, new PB) / `Log this attempt` (loss).
  - `Your name` input, `Save daily result` button.
- **Daily leaderboard** with `Global` toggle. Header variants:
  - `Today · global · fewest moves`
  - `{date} · global · fewest moves`
  - `Your best today` / `Your best on {date}`
- `Undo last move` (failed run, not saved, not completed).
- **Date nav (win only):** `Previous day` / `Next day` to step through unfinished neighbors.
- **`Copy Share`** → `✓ Copied!` for 1.8s.

Share text format:
```
🧊 Cubekill Daily · {Month Day, Year}
✓ Solved in {n} moves
🏆 New personal best!     (or: (best: {n} moves) / loss line)
{origin URL}
```

- **Actions:** `Done` (single button) or `Retry this puzzle` / `Retry today's puzzle`.

After `Done`: on-board `✓ Daily Cleared` badge appears; the hand is locked (`.is-daily-cleared-locked` → `pointer-events: none`).

### 15.3 Big solo Game Over
- **Title:** `Game Over`.
- **Final score** + run stats + `Play again`.

### 15.4 Co-op Game Over
- **Title:** `Co-op finished`.
- **Final score** + run stats.
- **Co-op leaderboard** with `Global` toggle. Empty: `No co-op runs on this device yet.` / `No global co-op scores yet — be the first.` Off-page: `Your group's rank: …` / `Group not on the global board yet.`
- **Actions:** `New game` (seated only — calls `restartRoom`) / `Back to single player`.

### 15.5 PvP Game Over (Win)
- **Title:** `You Win!` (self) or `{name} Wins`.
- **Subtitle:** `First past {thresholdPct}% of the field.`
- **Final standings** list (rank, color swatch, name with `You` for self, percent). Winner row pulses.
- **Actions:** `New match` (seated only) / `Back to single player`.

### 15.6 PvP Game Over (SHAME)
- **Title:** `SHAME`.
- **Subtitle:** `NOBODY WINS`.
- Body: `Every player ran out of moves before anyone claimed {thresholdPct}% of the field.`
- Standings list (no winner pulse).
- `is-shame` card styling (desaturated).
- **Actions:** same as win, but spectators don't see `New match`.

### 15.7 Multiplayer join error
- **Title:** `Couldn't join`.
- Body: `mpError` text, or `That room no longer exists. Try creating a new one.`, or `Something went wrong.`
- **Action:** `Back to single player`.

---

## 16. Accessibility & Preferences

### 16.1 Reduced motion
- Toggle in pause menu (`Reduced motion` checkbox).
- Disables CSS animations and transitions across the viewport (collapses to ~0ms).
- Does not affect game logic, audio, or haptics.
- See §12.12.

### 16.2 Mute and volume
- Master volume slider (0–100%) and Mute checkbox in pause menu.
- Persisted across sessions.
- Mute also silences the `needs unlock` prompt (muted players don't need their audio resumed).

### 16.3 Color choices
- Color is used heavily for tier/octave progression and PvP/co-op tinting. The game does not appear to have a colorblind-friendly mode.
- Win98 theme uses higher-contrast system colors which may help in bright environments.

### 16.4 ARIA labels
- Numerous `aria-label` attributes throughout (mode toggle, smiley row, calendar cells, PvP HUD, "Tap to resume", etc.).
- Modals use `role="dialog"`.
- Most clickable surfaces have a discoverable accessible name.

### 16.5 Keyboard
- Minimal — Enter / Space on focused board cells trigger placement when a piece is selected.
- No undo hotkey, no menu hotkeys, no drag via keyboard.

### 16.6 Touch & cell hit zones
- Aggressive cell snap (no max distance) means even hesitant aim usually finds a target.
- 80px upward touch offset for hit-testing keeps the piece visible above the finger.
- Failed placements re-show clearly and don't lose the player's selection.

---

## 17. Edge Cases & State Quirks

A grab bag of subtle behaviors a designer iterating on the experience should know about.

### Daily mode subtleties
- A numbered cube at the intersection of a line and a flower clearing in the **same placement** ticks down **twice** in that move.
- Numbered cubes with `hits > 0` survive their own clear — they stay on the board until hits reach 0.
- Daily completion can happen on a placement that also fills the rest of the board → daily-win + board-clear flourish stack.
- Past-date daily replays are **excluded** from the global daily leaderboard.
- Daily moves are **not** rewound by undo.

### Hold mechanics
- Parking the **last** hand piece into empty Hold triggers a new hand deal.
- The held piece counts toward `hasAnyValidMove` and the game-over check.
- Auto-rescue parks the last hand piece into Hold when it's unplayable. Player loses the undo stack and gets an error sound + heavy haptic to signal "you almost died."

### Undo
- Max depth **2 per hand**. Older snapshots are dropped before each push.
- Stack is wiped when a new hand is dealt (3rd piece played, hold-park redeal, auto-rescue redeal).
- Hold swaps are not in the undo stack.
- Multiplayer has no undo (placements are server-authoritative).

### Multiplayer
- Hover ghosts are co-op-only — PvP players don't telegraph their intent.
- A spectator who joined a PvP game can still send emotes? **No.** Spectators have no self tile.
- Disconnected players' tints persist on the board (PvP) but don't count toward standings or the win threshold.
- A new player joining a full room with a stale 30s+ seat inherits that seat's tints and cell owners.
- PvP rooms started fresh by `prepareRoomForShare` only happen when the host is alone (no other players or spectators). With anyone else attached, copying the link doesn't wipe.
- Co-op leaderboard dedupes per unique group of `playerId`s (sorted, joined with `|`). The same friends playing again will upsert their best, not stack rows.

### Audio
- The clear SFX is **suppressed if the placement also ends the run** so `game_over.wav` isn't doubled with a celebration hit.
- Daily wins skip `game_over.wav` entirely — the board-clear flash is the win flourish.
- iOS audio recovers by **rebuilding the AudioContext on the next user gesture** after backgrounding, not by attempting to resume the old one.

### Visual progression
- Score tier is uncapped — players at 25,000+ keep rotating through hues.
- Octave 6+ doesn't add new visual layers; only hue rotation continues.
- The score counter palette transition is 1600ms cubic-bezier; tier 0 snaps instantly (no transition).
- Daily mode is pinned to tier 0.

### Persistence corner cases
- Stored daily save is keyed by `YYYY-MM-DD`; a new calendar day discards yesterday's save unconditionally.
- Lifetime stats are validated defensively — any malformed payload collapses to a fresh empty record so the app never crashes on a corrupted localStorage entry.
- `startedTrackingAt` is capped to a sane value: future timestamps or wildly old timestamps fall back to "now."

### Banner ads
- Off by default. They're a joke (`Sponsored banner ad preview` mock), not real ads.
- Wide landscape orientation rotates the banner 90° as a side strip.

### Theme switching
- Win98's score readouts use a custom 7-segment DSEG7-Classic font; if the font fails to load there is no fallback styling specified.
- Win98 cube fills inherit per-tier hue rotation (procedurally generated), so the LCD red and teal palettes still drift at high scores.

### Game over wind-down
- The 2500ms wind-down period before the loss modal is suppressed for daily wins.
- The clear SFX on a game-ending placement is omitted (the game-over sound owns the moment).

### Multiplayer name editing
- Single-player high-score name (`cubic-player-name`) and MP display name (`cubic-mp-player-name`) are **separate**.
- On first MP launch, MP seeds from SP if SP is set.
- Subsequent edits in MP **do not** push back to SP.

---

## 18. Reference Tables

### 18.1 Scoring summary

| Mode | Pts per pattern | Board clear bonus | Per ruby | +1 per cube placed | Combo formula | Streak formula |
|---|---|---|---|---|---|---|
| Endless | 10 | 25 | 10 | Yes | 1 + 0.5(n−1) | 1 + 0.1×streak |
| Daily | 10 | 25 | n/a | Yes | same | same |
| Big | 40 | 100 | 10 | Yes | same | same |

### 18.2 Board summary

| Board | Flowers | Per-flower cells | Total cells | Scoring lines | Scoring flowers |
|---|---|---|---|---|---|
| Standard | 7 | 7 | 49 | 15 | 7 |
| Big | 7 | 19 | 133 | 27 | 7 |

### 18.3 Animation timing (selected)

| Event | Duration |
|---|---|
| Screenshake | 380ms |
| Hitstop | 90ms |
| Hand fly-in (per slot) | 900ms (+ 0/175/350ms stagger) |
| Placement pop | 200ms |
| Clear state window | 600ms |
| Line cell shrink | 220ms (+40ms stagger across line) |
| Flower clear (center / ring) | 260ms / 260ms with 190ms delay |
| Ripple (non-clear / clear) | 600ms / 900ms |
| Board-clear flash | 900ms |
| Ruby `+10` popup | 900ms |
| Ruby shard burst | 720ms |
| Score particle flight | 1400ms |
| Score counter celebrate | 400ms |
| Game-over wind-down | 2500ms (loss only) |
| Invalid placement flash | 520ms |
| Failed-drop shake | 190ms |
| Tier palette transition | 1600ms |
| Tier pulse ring / Octave pulse | 1700ms / 2300ms |
| Multi-clear chip pop-in | 280ms |
| Undo fly | 350ms |
| Emote display | 10,000ms |
| Hover ghost stale | 3,000ms |

### 18.4 Audio summary

| Sound | Trigger | Volume |
|---|---|---|
| `click_down` | Piece pickup, UI button down | 0.7 |
| `click_up` | Drag release, UI button up | 0.7 |
| `clear<S>` (1–7) | Single clear at streak S | 0.85 |
| `clear<S>_combo<C>` (1–7, 1–3) | Multi-clear at streak S, combo size C+1 | 0.85 |
| `error` | Invalid placement, auto-rescue | 0.64 |
| `game_over` | Run loss (not daily win) | 0.85 |
| `break` | Ruby capture, +80ms after clear | 0.85 |

### 18.5 Multiplayer constants

| Constant | Value |
|---|---|
| Max players per room | 8 |
| Room code length | 4 |
| Room code alphabet | `ABCDEFGHJKLMNPQRSTUVWXYZ` (no I, O) |
| Heartbeat interval | 8 seconds |
| Stale seat reclaim threshold | 30 seconds |
| Hover throttle | 100ms |
| Hover null debounce | 220ms |
| Hover stationary re-stamp | 1500ms |
| Hover stale window | 3000ms |
| Emote TTL | 10,000ms |
| Co-op hue step | 15° per partner |
| PvP hue step | 360° / seat count |
| PvP win threshold ratio | min(1, 1/N + 0.05) |
| PvP win threshold cells | ceil(totalCells/N + max(1, ceil(totalCells × 0.05))) |

### 18.6 Pieces summary

| Size | Canonical shapes | Rotation variants |
|---|---|---|
| 1 | 1 | 1 |
| 2 | 1 | 3 |
| 3 | 3 | 2 + 6 + 3 = 11 |
| 4 | 7 | 3 + 6 + 2 + 6 + 6 + 3 + 3 = 29 |
| **Total** | **12** | **44** |

### 18.7 URL parameters

| Param | Values | Meaning |
|---|---|---|
| `room` | 4-char code | Auto-join multiplayer room |
| `mode` | `pvp` (or omitted = coop) | Multiplayer flavor seeded for lobby UI before room snapshot lands |

### 18.8 Daily date keys

- Format: `YYYY-MM-DD` (zero-padded) for storage.
- Seed input: `YYYY-M-D` (unpadded) — padded inputs normalize to unpadded before hashing, preserving legacy seeds.
- Calendar launch date: `2026-03-01`.

---

*End of design document. ~133 cells, 44 pieces, 22 scoring patterns on Standard / 34 on Big, 2 themes, 5 modes, 1 hand, 1 hold, infinite tiers.*
