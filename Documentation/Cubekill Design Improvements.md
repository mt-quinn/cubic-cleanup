# Cubekill — Design Improvements (Round 1)

> A living document of agreed-upon additions and refinements on top of the current design captured in [Cubekill UX Design Document.md](./Cubekill%20UX%20Design%20Document.md). This document only lists changes that have been **explicitly endorsed**; rejected or deferred ideas are recorded at the end so the rationale isn't lost.

---

## Guiding Philosophy

These principles override any individual feature decision. When a proposed feature conflicts with one of these, the principle wins.

1. **No FOMO mechanics, ever.**
   - No time-limited content that disappears.
   - No streaks that punish missed days.
   - No "limited-time" themes, pieces, modes, or events.
   - Nothing the player can permanently lose by not playing.
2. **Remarkably generous.** The game should feel refreshing relative to its peers — no nags, no paywalls, no dark patterns, no engagement bait.
3. **Don't add more for the player to think about.** Cubekill is a fundamentally simple puzzle. Mechanical additions that raise the strategy ceiling at the cost of cognitive load are *anti-features* here. Polish, feel, and identity are the levers; rules are not.
4. **Juice and feel are the product.** When in doubt, invest in a moment landing better, not in a new system.

---

## Agreed Improvements

### 1. Micro-tutorial (~10–15 seconds)

A first-launch guided moment, intentionally tiny.

**Design:**
- Triggered only on absolute first launch (no saved games of any mode, no lifetime stats).
- A pre-built **near-complete state**: one straight line on the standard board is missing exactly 1–2 cells.
- Player is dealt a single matching piece (singlet or pair) in hand slot 1. Slots 2 and 3 are empty for this beat.
- The valid target cell(s) pulse gently with the existing `preview-clear` visual.
- One line of copy floats above the board: **"Drag the cube to fill the line."**
- The player drags, the line clears with full juice (sound, particles, score popup, ripple), and the tutorial is done. No second beat, no second tooltip, no "now try a combo."
- A subtle 1-second toast confirms: **"That's it. Have fun."** then fades.

**What this teaches without saying it:**
- Pieces come from the hand tray.
- Drag-and-drop is the interaction.
- Filling a line clears it.
- Clearing is satisfying (because the juice is doing the work).

**What it deliberately does NOT teach:**
- Combos, streaks, rubies, hold, undo, tier/octave, daily, multiplayer. All discovered organically.

**Skip behavior:**
- A "Skip" link in the corner exits immediately to a fresh Endless run.
- Never re-prompts after first launch. No "tip of the day", no re-introduction of features.

---

### 2. End-of-run Highlight Reel

A short auto-replay of the player's best moment of the run, shown at game-over.

**Selection rule (MVP):** The single placement that scored the most points in this run (already tracked as `bestSinglePlacement` / `topPlacementPoints` per-run).

- Ties broken by: most patterns cleared in the placement → highest streak at the time → earliest in the run.
- A run must have something impressive to show - a 3x placement, a score over a certain threshhold (50+) before a reel is shown
- A run with **no qualifying placement** simply has no reel (game-over modal unchanged). The reel is a reward, not a participation trophy.

**Surface treatment:**
- Plays **inline inside the game-over modal**, at the top, before the run-stats strip. ~140–160px tall, full-width of the card. Not a separate overlay, not blocking the rest of the modal.
- Auto-plays once on modal open. Replay button (`▶ Watch again`) underneath.
- A small caption above the replay frame: `Best clear · +{N} points` (Wood theme: cream gold; Win98: black on gray).
- Daily wins: the reel can also play. The "best clear" framing still works ("Best clear · +{N}") because daily placements also score.

**What's replayed:**
- A 1.5–2 second sequence captured from the moment of the placement.
- Frame 0: board state immediately before the placement.
- Frame 1: piece flies in from off-frame to its drop position.
- Frame 2: placement pop, clear animations, ripple, particles, ruby shards if any. All original juice.
- Frame 3: a 300ms hold on the cleared board.
- A subtle "REPLAY" stamp in a corner so it's never mistaken for live play.

**What is NOT captured:**
- Pre-placement hover. Just the snap + drop + clear.
- Audio. The reel is **silent** by default to avoid stomping the game-over flourish. (Toggleable later if we find it feels flat.)

**Implementation notes:**
- Don't render a video. Re-run the existing animation pipeline against a saved snapshot of the pre-placement state + the placement parameters. This keeps the reel theme-correct, tier/octave-correct, and PvP-tint-correct without any encoding work.
- Snapshot capture is a single object per run: `{ boardBefore, piece, cellId, attemptedCellIds, streakBefore, tierAtPlacement }`. Updated only when a new best-placement is set.

**Future (not MVP):**
- Multi-moment reels (opening clear → biggest combo → final placement).
- Shareable GIF/MP4 export.
- "Reel of the day" curated from global scores.

---

### 3. Additional Themes

Theme is a first-class identity surface in Cubekill. Adding more is high-delight and aligned with the "refreshing" philosophy. All additions slot into the existing CSS-variable + `data-theme` architecture; no remount, no game-logic changes.

#### Neon / Cyberpunk / Tron
- **Palette:** Near-black background (`#05060c`), electric cyan (`#00f0ff`) primary, hot magenta (`#ff2bd6`) secondary, lime accent (`#bbff00`).
- **Cubes:** Wireframe-style isometric — thin glowing edges on a near-transparent face, with a subtle inner-glow fill. Top face cyan, sides darker magenta/violet. The cube faces *emit* rather than reflect.
- **Empty cells:** Dark dimples with a faint cyan stroke; on hover, the stroke intensifies and "pulses" like a circuit.
- **Rosette grooves:** Replaced by an etched circuit-trace polyline — same paths as the existing groove SVG, but stylized as a PCB trace, with a tiny glow.
- **Rubies:** Hot magenta wireframe cubes with a `+10` glyph in scanline font.
- **Tier/octave hue rotation:** Still active; pre-tinted toward the cyan/magenta poles of the wheel rather than the warm half. Octaves unlock additional scanline + grid layers on the background.
- **Score readout:** A faux-LCD glow style (similar to Win98 LCD but cyan-on-black, with bloom).
- **Title font:** Consider an angular / extended-character treatment; reuse Monoton for cohesion if a custom face isn't worth shipping yet.
- **Failed-drop flash:** Red→pink burst (keep the existing red, just punchier).

#### Honeycomb / Beehive
- **Palette:** Deep amber/honey background (`#3a2407` → `#1c0e02` radial wash), golden yellow primary (`#ffc845`), warm wax cream (`#fff1c8`), capped with a darker brown for structural lines.
- **Cubes:** The three-face isometric is retained but textured to suggest honey or beeswax. Top face glossy bright honey (`#ffe27a`), sides progressively darker wax tones with a barely-visible hex-cell texture.
- **Empty cells:** Hexagonal "wax cell" pits — slightly translucent, with a faint inner shadow as if looking into an empty comb.
- **Rosette grooves:** Replaced by an embossed comb-wall texture — thicker, raised, like the outer rim of a honeycomb section.
- **Rubies:** A "queen jewel" — amber + ruby red gradient, or a small bee glyph on the face.
- **Board panel:** Suggestive of a frame from a real beehive (without going so literal that it becomes kitsch).
- **Tier/octave hue rotation:** Constrained to the warm half of the wheel (amber → orange → rose → red) so it doesn't fight the theme's identity.
- **Theme-specific delight:** Very subtle ambient particles — a single golden mote drifting across the screen every 6–10 seconds. Reduced-motion disables.

#### Theme system notes
- All themes share the existing animation timings, audio library, piece geometry, and game logic.
- Naming in code stays English-ASCII tokens: `wood`, `win98`, `neon`, `honeycomb`.
- Favicon swap per theme (we already do this for Win98).

---

### 4. Spectator Count Visible to Everyone

Currently the `👁 N watching` badge is only rendered for spectators themselves. Make it visible to all seated players in any multiplayer room (Co-op and PvP).

**Placement:**
- A small unobtrusive pill: `👁 N`.
- Wood theme: tucked into the right end of the smiley row, with the same beveled-pill styling as the existing rank chip.
- Win98 theme: a tiny inset pill next to the right-hand LCD, or beside the smiley row if space allows.
- Hidden when `N === 0` (no clutter when nobody's watching).

**Behavior:**
- Only counts true spectators (not seated players).
- Tap/click does nothing — purely informational.
- A faint tooltip / aria-label: `{N} spectator(s) watching this room`.
- A subtle one-shot pulse when the count increments (just brightness flash, no movement) so seated players notice without it being a notification.

---

### 5. Named Rooms / Clubs

Friend-group infrastructure layered on top of the existing 4-character room codes. Two tiers; ship Tier 1 first, evaluate before committing to Tier 2.

#### Tier 1 — Named Rooms (small, ship first)
Replace or augment the random 4-char code with an optional player-chosen room name.

- URL becomes `/?room=goonsquad` (lowercase, ASCII, 3–20 chars, `[a-z0-9-]`, no profanity reserved-words list).
- Creation flow: when the player clicks **Copy Link**, a small inline input appears under the button: `Custom name (optional)` with a `Use code instead` link to fall back to the existing 4-char behavior.
- Server-side: try to allocate the requested name. If taken, surface `That name is in use — try another`. If allocated, the room persists under that name; the same name re-opens the same room when re-visited (subject to the room's normal lifecycle).
- Same room-mode and same join rules as today (PvP / Co-op set at creation via `?mode=pvp`).
- No social directory: named rooms are still invitation-only via shared link. Discoverability is opt-in only.

#### Tier 2 — Clubs (larger; evaluate after Tier 1)
A persistent group entity. Lightweight, no formal hierarchy, no obligations.

- A **Club** is: a name + an invite link + a roster.
- Creation: any signed-in player creates a club. Joining requires the invite link.
- The club has its own **permanent room** at `/?club=<slug>` — opening it always lands you in *the* club's room. Empty rooms simply show "Waiting for a clubmate".
- Roster shows who's online right now (using existing heartbeat infrastructure), and last-seen for offline members. No public "activity feed" — just presence.
- **No member caps, no roles, no admin controls beyond "leave club".** This is a friend group, not a guild.
- Club-only leaderboard (Co-op high scores filtered to runs where all participants were club members) shown under the High Scores screen when a club is joined.
- **What clubs explicitly do NOT have:**
  - Levels / XP / club progression
  - Daily/weekly required activity
  - Recruitment / public listings / leaderboards comparing clubs
  - Cosmetics gated behind club membership
  - Notifications about clubmate activity (no nags)

Requires the existing optional account system; signed-out players can't create or join clubs.

---

### 6. Quake-style Announcer Cues

For a game named **Cubekill**, the Quake homage writes itself. A short voiced announcer flair on impressive clears.

#### Trigger model

Announcer cues fire on **combo size** (number of patterns cleared in a single placement) and on **streak thresholds**. Reserved purely for impact moments — never on routine clears.

**Combo cues (per-placement):**

| Patterns cleared in one placement | Cue |
|---|---|
| 1 | (silent — existing clear SFX only) |
| 2 | "DOUBLE!" |
| 3 | "TRIPLE!" |
| 4 | "OVERKILL!" |
| 5 | "MEGA CLEAR!" |
| 6+ | "ULTRA CLEAR!" |

**Streak milestones (fired on the placement that crosses each threshold):**

| Streak reached | Cue |
|---|---|
| 5 | "RAMPAGE!" |
| 8 | "DOMINATING!" |
| 12 | "UNSTOPPABLE!" |
| 18 | "GODLIKE!" |
| 25 | "WICKED SICK!" |
| 35 | "M-M-M-MONSTER STREAK!" |

**Special moments:**

| Trigger | Cue |
|---|---|
| Board clear | "PERFECT CLEAR!" |
| 2+ rubies cleared in one placement | "JACKPOT!" |
| Auto-rescue triggered | "CLOSE CALL!" (softer, lower energy — relief, not glory) |
| First clear of a brand-new run | (silent — too early to celebrate) |

#### Priority + overlap rules

In a single placement, multiple cues may qualify (e.g., a triple-clear that also crosses streak 5 *and* clears the board). Resolution:

1. **Board clear** wins over everything else this placement.
2. Otherwise, the **highest-tier streak milestone** (if crossed this placement) wins over the combo cue.
3. Combo cue is the default if nothing higher fires.
4. **Ruby jackpot** layers underneath, played **+200ms** after the primary cue if it fires alongside (so they don't talk over each other).

Only **one primary cue per placement** otherwise.

#### Audio treatment

- New audio bucket separate from the existing SFX library. New files like `vo_double.wav`, `vo_rampage.wav`, etc.
- Mixed slightly **below** the clear SFX layer so the existing musical clear progression still leads. The voice is a garnish, not the main course.
- Subject to the master volume slider.
- A **separate toggle** in the menu: `Announcer` (checkbox, default **on**). Players who hate this should turn it off easily; the rest of the game should be untouched.

#### Voice personality

Cubekill's tone is "warm tactile arcade puzzle," not gritty FPS. The voice should reference Quake while feeling at home in Cubekill:

- Warm and slightly theatrical rather than aggressive.
- Likely lower-mid range; not a snarling growl.
- A single voice actor across all cues for consistency.
- An option (down the road) for an alternate voice pack — e.g., a deadpan dry-British alt-line set ("Oh. *Three* of them.") — would be on-theme but is **not** MVP.

#### Visual companion

When a cue fires, a brief on-screen flash to give the cue visual reinforcement:

- Large text overlay above the board, ~600ms life: fade-in 80ms, hold 400ms, fade-out 120ms.
- Sized to the cue: `DOUBLE!` modest, `MONSTER STREAK!` huge.
- Color matches the cue tier: golden for combos, orange for low streaks, red for high streaks, magenta/gold flash for board clear, hot pink for jackpot.
- Skipped entirely under reduced-motion (audio still plays).

---

### 7. Real Colorblind Support

Color should never be the only way to understand ownership, mode state, scoring heat, or danger. This is especially important in PvP, where player identity and territory are core gameplay information.

#### Design goals

- Preserve the existing high-juice visual identity; this is an accessibility layer, not a desaturation pass.
- Make PvP readable when colors are indistinguishable.
- Keep the default experience unchanged for players who do not opt in.
- Support both Wood and Win98 themes.

#### Setting

Add a menu setting under accessibility/preferences:

- Checkbox or select: `Colorblind support`
- MVP can be a single toggle: `Off` / `On`
- Future version can expose presets: `Deuteranopia`, `Protanopia`, `Tritanopia`, `High contrast`
- Persisted under a new localStorage key, e.g. `cubic-colorblind-support`

#### Player identity beyond hue

Every seated PvP player gets a stable **secondary identity marker** in addition to color:

- Pattern texture: stripes, dots, crosshatch, rings, chevrons, diagonal ticks, grid, solid.
- Small glyph: `●`, `◆`, `▲`, `■`, `✕`, `+`, `◇`, `⬢` or theme-specific SVG marks.
- The marker appears consistently in:
  - PvP territory HUD rows
  - Player smiley tiles / rank chips
  - Empty-cell territory overlays
  - Conflict rings
  - Placement previews that affect territory
  - Final standings

The goal is that a player can say "I'm stripes" or "I'm diamonds," not just "I'm green."

#### Board treatment

In PvP with colorblind support enabled:

- Empty owned cells get a very light pattern overlay clipped to the hex, not just a translucent fill.
- Currently occupied cells retain the cube tint, but ownership/tint information can be reinforced with a small corner glyph or rim pattern.
- Conflict rings should encode both:
  - **Current cube owner** via cube/glyph.
  - **Territory owner** via ring pattern.
- The territory HUD should show each player's marker beside their name and inside the progress bar fill.

#### Non-PvP support

Endless / Big / Daily should also benefit where color carries meaning:

- Ruby cells keep their distinctive `+10` label and glow, but also get a gem/ruby glyph or faceted pattern so they are not just "pink/red."
- Daily numbered cubes are already label-first; preserve strong contrast around the number.
- Invalid previews should use shape language too: crosshatch or warning outline, not only red.
- Valid-clear previews should use a clear motion/outline treatment, not only warm glow.

#### Implementation notes

- Prefer CSS/SVG pattern overlays using the existing cell SVG geometry.
- Avoid noisy textures at small sizes; patterns should read at phone scale.
- Test with simulated colorblind filters and actual grayscale screenshots.
- Include screenshots of 2-player, 4-player, and 8-player PvP before calling this done.

---

### 8. Piece Personality + Piecetiary Stats

The Piecetiary already gives every rotation variant a human nickname. Turn that into a lightweight identity layer by letting pieces accumulate personal history and by showing that history when the player taps/clicks a piece in the Piecetiary.

This should feel like "my relationship with these weird little shapes," not like an achievement checklist.

#### Piecetiary interaction

- Each Piecetiary tile remains compact by default: miniature piece, notation, nickname.
- Tapping/clicking a tile opens a detail sheet/modal for that specific rotation variant.
- Desktop can also support hover/focus preview, but tap/click is the primary path.
- The detail view should be readable as a tiny baseball card for that piece.

#### Detail view content

MVP stats per piece variant:

- **Times played** — how often the player placed it.
- **Killing hands** — how many times this piece was part of the final hand before game over. Use gentle copy; this is flavorful, not shaming.
- **Clears caused** — number of placements with this piece that cleared at least one pattern.
- **Combos joined** — number of multi-clear placements involving this piece.
- **Average score** — average points gained when this piece is played.
- **Best clear** — highest single-placement score produced by this piece.

Nice-to-have later:
- Tiny sparkline of average score over time

#### Flavor copy

Use the nickname to make the stats feel alive:

- `Layla has ended 12 runs.`
- `Bea's best clear: +240.`
- `Noor has captured 18 rubies.`
- `Sora loves combos: 31 multi-clears.`

Keep it playful and retrospective. Do not imply goals the player should grind.

#### Data model

Track stats by stable piece variant ID, not by nickname text. Nicknames are presentation; stats should survive copy edits.

Per placement, update:

- dealt counts when a hand is generated
- played count when a piece is placed
- score gained by that placement
- whether clear count was 0, 1, or 2+
- rubies cleared
- board clear flag
- mode

At game over, attribute **killing hand** credit to every piece still in the current hand plus held piece if present. This creates a memorable "these were the pieces I died with" stat without changing gameplay.

#### Privacy / sync

- Local-first. These stats are personal texture, not leaderboard data.
- If account sync later includes them, merge by additive counts and weighted averages.
- Do not expose other players' piece stats in multiplayer.

---

### 9. PvP Clear Preview: Territory Delta

PvP has a clever but non-obvious rule: clearing a cube gives territory to whoever placed that cube, not necessarily the player who triggered the clear. The UI should preview that consequence before the drop.

#### During drag / hover

When a PvP player previews a valid placement that would clear one or more patterns:

- The existing clear preview still highlights the affected cells.
- Add a compact floating chip near the ghost or territory HUD:
  - `Clears: You +4 · Alice +2 · Bob +1`
  - Use player markers/colors from the PvP HUD.
  - Sort self first, then largest territory gain.
- The chip counts **territory that will be awarded by cleared cells**, not score.
- If the placement clears only the player's own cubes, positive self framing:
  - `Territory: You +7`
- If the placement mostly helps opponents, make that obvious but not scolding:
  - `Territory: Alice +6 · You +1`

#### Board-level preview

For the cells that would clear:

- Overlay each cleared cell with the marker/color of the player who will receive territory from that cell.
- If a cleared cell has no owner data, use a neutral marker and omit it from the delta chip.
- Conflict cells should be especially clear: the preview should answer "whose territory does this become?"

#### Territory HUD integration

Optionally, the PvP territory bars can show ghosted projected deltas while hovering:

- A translucent extension on each affected player's bar.
- Threshold marker remains visible above the projection.
- If the preview would make someone win, show `WIN` or `Wins if dropped` beside that player.

This is high-value because it teaches the PvP rule at the exact moment it matters.

#### Copy / tone

Avoid punitive language like "bad move" or "helps opponent." The game should present consequences clearly and let players decide.

Examples:

- `Territory if cleared`
- `You +5 · Mina +3`
- `Mina reaches win line`
- `No territory change`

---

## Deferred / Rejected — for the record

These were considered and explicitly **not** taken, with rationale.

| Idea | Status | Reason |
|---|---|---|
| Manual piece rotation | Rejected | Adds player-side complexity; trivializes the core puzzle. Conflicts with principle 3. |
| Next-hand preview | Rejected | Same — turns moment-to-moment play into multi-hand planning. Conflicts with principle 3. |
| Daily streak counter | Rejected | FOMO mechanic. Conflicts with principle 1. (Calendar of cleared days as it exists today is fine — that's *retrospective*, not punitive.) |
| Achievement / badge system | Deferred | Not philosophically aligned unless framed as *retrospective* discovery rather than goals to chase. May revisit. |
| Themed/varied daily difficulty (Mon→Sun ramp) | Deferred | Worth revisiting in isolation later; not part of this round. |
| Public PvP matchmaking | Deferred | Worth considering once the named-rooms/clubs work lands and we see how social play is being used. |
| Background music | Deferred | Open question of identity; not part of this round. |
| Wordle-style daily share emoji grid | Deferred | Not rejected, just not in this round. |
| Scramble / hand re-deal button | Deferred | Adds a player choice; needs more thought before adding. |
| Endless / PvP shareable result text | Deferred | Reasonable; revisit later. |

---

## Notes for future rounds

- Once any of the above ship, re-read the original UX doc and update it so it stays the source of truth for current behavior — this document is a *plan*, not a *spec*.

