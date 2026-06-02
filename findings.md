# Findings & Decisions

## Requirements
- The stained glass board should look like a rose-window aperture set into an actual masonry wall.
- Board stone mullions should follow the same gradient and light source as the background masonry.
- The board and wall should read as one cohesive physical object, not separate layers.
- Preserve game playability and cell readability.
- Continue respecting the previous edge-junction goal: internal mullions/lead should terminate cleanly at perimeter stone/lead.

## Research Findings
- Current dirty changes already move glass toward flat translucent panes, hide cube facets, add stone tracery, add a glare field, and clip internal lead to an inset hull.
- Relevant files are `client/src/App.tsx` for SVG gradients/layers and `client/src/theme-glass.css` for all stained-glass material styling.
- Current CSS variables define wall/stone tokens, but the SVG `glass-stone-tracery` gradient appears hard-coded and not yet fully tied to the page wall gradient.
- Implemented board-space gradients `glass-stone-face-gradient`, `glass-stone-joint-gradient`, and `glass-stone-arris-gradient` so the exterior hull and rosette ribs share one vertical wall-like lighting ramp.
- User screenshot after first pass showed improved geometry, but mullions still looked browner/higher-contrast than the wall and the diagonal lighting was off.
- User screenshot after vertical-lighting pass showed improved mullion/wall match, but the black inner perimeter lead around the outer board edge looked distracting.
- Current pass adds: soft recessed aperture shadow, softened perimeter-adjacent pane lead, shared stone speckle overlay on hull/tracery, and restored variable-driven wall/stone colors.
- Latest user screenshot confirms continued improvement; remaining game-board read comes mostly from uniform/dominant lead lines and flat pane surfaces.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Tie board stone strokes to shared CSS variables and SVG gradients | Lets wall and board share one light/material model. |
| Add subtle stone texture and contact-shadow treatment | Cohesion needs surface continuity, not just matching colors. |
| Keep lead strokes thin and subordinate to stone ribs | Playability needs visible cell boundaries, while the reference imagery favors stone tracery as the major structure. |
| Add thin arris stroke layers | A separate highlight stroke gives stone relief without thickening the playable edge/came logic. |
| Match wall lighting with vertical gradients | The wall uses a mostly vertical top-lit gradient, so mullions should follow that instead of a diagonal top-left ramp. |
| Demote perimeter lead to a faint stone incision | The exterior stone reveal should own the hull boundary; black lead on the inner lip makes the board feel outlined. |
| Soften only perimeter-adjacent pane lead | Interior lead still needs high contrast for playability, but near-hull lead can recede into the stone reveal. |
| Add recess shadow and stone speckle overlays | Real windows show glass set behind stone and non-uniform limestone surfaces; subtle overlays provide that read cheaply. |
| Add subtle pane seed texture and reduce lead weight | Makes panes read more like imperfect cathedral glass while preserving the playable hex grid. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|

## Resources
- `client/src/App.tsx`
- `client/src/theme-glass.css`

## Visual/Browser Findings
- User-provided current screenshot: board has dark hex lead and brown masonry wall; board still reads like a separate layer because outer shadow/rim and internal mullions do not share enough lighting/material with the background wall.
- User-provided references: large cathedral rose windows use warm limestone, concentric carved frames, radial/rosette tracery, strong shared top-left lighting, incised joints, and stone mullions that are physically part of the surrounding wall.

---
*Update this file after every 2 view/browser/search operations*
