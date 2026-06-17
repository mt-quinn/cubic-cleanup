# Stats Screen — Ground-Up Redesign Proposal

*A world-class game/UX pass on the lifetime stats surface. Goal: make stats **legible, manipulable, exciting, and properly focused.***

---

## 1. Where we are today

The current screen is a single modal card titled **Stats** with four stacked label/value lists:

- **Totals** — Time, Pieces, Clears, Rubies, Total score, (Board clears)
- **Averages** — Score/game (featured) + Time/game, Clears/game
- **Games Played** — a ledger of mode counts (Endless, Daily, Co-op, PvP, wins, shames, Days cleared, Partners)
- **Records** — Best score, Best daily, Best combo, Best streak, Best clear, Most rubies, Longest
- A "Tracking since …" footnote.

It's accurate and honest, but as an *experience* it under-delivers. Diagnosed against the four goals:

**Legibility.** Everything is weighted the same — ~20 small label/value rows in near-identical type. There's no hero, no hierarchy, nothing the eye lands on first. The one "featured" number (Score/game) is a cross-mode average, which is the *least* legible possible choice because it blends endless, big, and co-op into a single muddy figure.

**Manipulability.** Zero. The screen is static. You can't filter by mode, switch lifetime vs. recent, drill into a record, or compare. The user can't *ask the data a question* — which is exactly the lever that turns a stat sheet into a toy.

**Excitement.** Nothing is celebrated. Records are a flat list with no "when," no "how close to the next one," no link to the moment. There's no sense of momentum — the single most motivating question in any game stats screen, *"am I getting better?"*, is unanswerable because every number is a lifetime aggregate with no time dimension.

**Focus.** Because nothing is prioritized, everything competes. Mode performance is buried as raw counts (PvP shown as a count, never a win **rate**; daily shown as games, never a clear **streak**). Piece intelligence (the Piecetiary data — clear rate, killing hands, best clear per piece) lives on a different screen and never informs "how do you play?" The screen is also a dead end: Back to menu, with no bridges to Leaderboard, Daily history, or Piecetiary.

---

## 2. Design principles (the lens)

1. **Three altitudes, progressive disclosure.** Open on *who you are right now* (headline), then *the story over time* (trajectory), then *drill anywhere* (detail). Never show all 30 numbers at once.
2. **Lead with a hero + an identity.** Great stats screens open with one defining number and a *player archetype* derived from play style. Identity is what makes a stats screen feel personal and screenshot-worthy.
3. **Make it a toy: let the player manipulate the view.** A **Mode** filter and a **Timeframe** toggle that recompute the entire screen. This is the "find the story in your stats" mechanic the brief explicitly asks for — and it's what lets us track *unlimited* stats without clutter, because the controls decide what's on screen.
4. **Time is the centerpiece.** A trajectory chart of recent runs with your PB line and a trend callout ("↑ 14% vs your last 20") is the emotional core.
5. **Records are trophies, not rows.** Each becomes a card with value, when it was set, distance to the next milestone, and — where a moment exists — a replay link.
6. **Derived stats earn their place with meaning, not volume.** Organize every metric into a small taxonomy (Volume → Efficiency → Mastery → Consistency → Style) so adding stats *deepens* the screen instead of crowding it.
7. **Theme-native data viz.** Each of the five themes renders the same structure in its own visual language. The stats screen is a showcase for the game's art direction, not a generic dashboard.

---

## 3. Proposed information architecture

Promote Stats from a cramped modal to a **full-height surface** with a sticky control bar. Five zones, top to bottom:

### Control bar — the manipulation layer (always visible)
- **Mode** segmented control: `All · Endless · Daily · Co-op · PvP`
- **Timeframe** toggle: `Lifetime · Last 20 runs · 7 days`

Everything below reacts to these two controls. Changing Mode reframes the hero, swaps the trajectory metric, and recomputes every rate. This single interaction is the difference between a report and an instrument.

### Zone 1 — Identity header (the hero)
A large **archetype badge** + the single most relevant number for the current filter, with a trend arrow:
- *All* → lifetime score or games, with archetype.
- *Endless* → best score (PB) + ▲ trend vs. recent average.
- *Daily* → current clear streak (days) + clear %.
- *PvP* → win rate.

The **archetype** is computed from the player's ratio mix and is the emotional anchor — e.g. *Combo Architect, Marathoner, Daily Devotee, Ruby Hunter, Blitzer, Closer.* It's fun, it's shareable, and it gives a reason to come back ("can I change my class?").

### Zone 2 — Trajectory (the story)
A performance-over-time chart for the selected mode:
- Endless/Big/Co-op → **score per run** with a dashed **PB line** and a shaded **average band**.
- Daily → **moves per day** (lower is better), already a clean per-day series we store today.
- PvP → a **win/loss ribbon** with rolling win-rate.

A plain-language callout reads the trend for the player: *"Your last 20 endless runs average 8,400 — up 14% from the 20 before."* This is the answer to *"am I improving?"* and it should be the most prominent thing after the hero.

### Zone 3 — Vitals (a legible, grouped tile grid)
Compact tiles — big value, tiny label, optional ▲▼ vs. the previous window — grouped under three headers so the grid reads as *meaning*, not a number dump:
- **Efficiency:** Clear rate, Points/piece, Pace (pieces/min), Cubes/clear.
- **Mastery:** Combo rate, Board-clear rate, Ruby rate, Best single clear.
- **Consistency:** Daily clear %, Avg vs. best score, PvP win %.

Tapping a tile expands it to show its definition and a mini-trend. This is the "as many derived stats as we want" container — the grouping + expand-on-tap keeps density high and legibility intact.

### Zone 4 — Trophy shelf (records, celebrated)
Horizontally scannable record cards. Each shows the value, **when it was set** ("3 runs ago," "Mar 12"), **progress to the next milestone** (a thin bar toward a round-number target), and a **▶ replay/view** affordance where a moment exists (best clear, board clear, best daily). Records set during the current session get a **"NEW"** flare. This is the zone that should feel the most alive.

### Zone 5 — Play style & pieces (the drill)
A small "how you play" panel:
- **Style axes** — Aggressive ↔ Patient, Combo ↔ Single, Sprint ↔ Marathon — derived from existing ratios and visualized as three sliders/needles. This is *also* what feeds the archetype in Zone 1, so the screen explains itself.
- **Signature piece** and **nemesis piece** pulled from Piecetiary (highest clear rate vs. most "killing hands"), each linking into the full Piecetiary.

### Footer — bridges, not a dead end
Quick links to **Leaderboard · Daily history · Piecetiary**, and a **Share** action that renders a stat/identity card image (reusing the existing GIF/image export pipeline) — a recap card is a natural growth/flex surface.

---

## 4. Derived-stat taxonomy (all computable from current data)

| Tier | Metric | Formula from existing fields |
|---|---|---|
| Volume | Games, Pieces, Cubes, Time, Total score | direct |
| Efficiency | Clear rate | `patternsCleared / piecesPlaced` |
| Efficiency | Points/piece | `totalScore / piecesPlaced` |
| Efficiency | Pace | `piecesPlaced / (totalActivePlayMs/60000)` |
| Mastery | Board-clear rate | `boardClears / scoredGamesPlayed` |
| Mastery | Ruby rate | `rubiesCleared / piecesPlaced` |
| Mastery | Combo rate | from Piecetiary `combosJoined / clearsCaused` |
| Consistency | Daily clear % | `dailyDaysCleared / dailyDaysPlayed` |
| Consistency | **Daily streak** (current & best) | derivable from the `dailyDaysCleared` date keys |
| Consistency | PvP win % | `pvpWins / gamesPlayedPvp` |
| Consistency | Score consistency | `avgScore / bestScore` |
| Style | Aggression / Patience / Marathon axes | ratios of combo rate, clears/piece, avg run length |
| Identity | Archetype | argmax over the style-axis mix |

The point: we can surface *many* of these because the controls + grouping + expand-on-tap give each one a place. Nothing here requires new tracking.

---

## 5. The one data dependency (and why the rest ships now)

The trajectory chart is the heart of the redesign. Today:
- **Daily** already has a full per-day series (`dailyBestMovesByDate`) → daily trends work immediately.
- **Endless** has the leaderboard list (`{score, date}`, top-N) → a clean **PB-progression** chart works immediately.
- A **true per-run trend for every scored mode** (not just leaderboard-making runs) needs one small addition: a **capped ring buffer of recent run summaries** (e.g. last 50 `{mode, score, moves, durationMs, clears, date}`), local-first, mirrored on sync exactly like `pieceStats`. Cheap, matches existing patterns, no migration risk.

So Zones 1, 3, 4, 5 and the daily/endless trajectory ship on **existing data**; the full multi-mode per-run trend is a Phase-2 unlock.

---

## 6. Theme-native expression

Same structure, five identities:

- **Cubekill (wood):** warm amber bars, painterly cards, the trajectory line glows like the score-tier palette.
- **Windows 98:** the whole surface is a tabbed dialog; the chart is a beveled `groupbox` with a classic blue plot line and system-grey tiles. Records are list-view rows with tiny icons.
- **Stained Glass:** vitals are leaded panes; the trajectory is a backlit segmented bar; the archetype badge is a rosette.
- **Abstract (De Stijl):** the grid *is* the composition — tiles are primary-colored planes divided by heavy black rules; the trajectory is a single bold red/blue line on warm white.
- **Music Visualizer:** the trajectory animates like a waveform; vitals pulse subtly; bars are equalizer-styled.

---

## 7. Phased rollout

- **Phase 1 — Restructure (no new data):** control bar (Mode + Timeframe), identity header + archetype, grouped vitals grid, trophy shelf, daily trajectory + endless PB-progression, cross-links. This alone fixes legibility, focus, manipulability, and most of the excitement.
- **Phase 2 — Recent-runs ring buffer:** unlocks full per-run trajectory + ▲▼ deltas across all scored modes.
- **Phase 3 — Delight:** share/recap card image, piece-intelligence panel, replay-from-trophy links, archetype reveal animation.

---

## 8. Success criteria

- A new player understands "who they are" within 2 seconds of opening the screen.
- Any player can answer "am I improving?" without leaving the screen.
- Changing Mode/Timeframe visibly recomputes the story.
- At least one element per session is worth screenshotting.
