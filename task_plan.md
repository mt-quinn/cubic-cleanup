# Task Plan: Stained Glass Masonry Integration

## Goal
Make the stained glass theme read as one cathedral rose-window object set into masonry, with board stone mullions and background wall sharing lighting, material, and depth while preserving playability.

## Current Phase
Phase 3

## Phases

### Phase 1: Requirements & Discovery
- [x] Capture user intent from transferred chat history
- [x] Inspect current dirty changes and relevant rendering files
- [x] Document findings in findings.md
- **Status:** complete

### Phase 2: Design Approach
- [x] Define visual changes that unify board and wall
- [x] Identify SVG/CSS layers to edit
- [x] Document decisions with rationale
- **Status:** complete

### Phase 3: Implementation
- [x] Update SVG gradients/filters/layers for shared masonry lighting
- [x] Update glass theme CSS for stone, wall, mullions, and pane integration
- [x] Keep board readability and interactions intact
- **Status:** in_progress

### Phase 4: Verification
- [ ] Run build/checks
- [ ] Open local app and capture visual state if browser tooling is available
- [ ] Iterate on obvious visual defects
- **Status:** pending

### Phase 5: Delivery
- [ ] Summarize changed files and verification
- [ ] Note any limitations
- **Status:** pending

## Key Questions
1. Which layer currently makes the board feel pasted on top of the wall?
2. How can stone mullions use the same light direction as the wall without reducing game readability?
3. Are internal lead lines still clipped cleanly at perimeter and stone ribs?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Preserve existing dirty changes | They include prior-chat fixes and theme work that are likely intentional. |
| Use CSS/SVG material treatment rather than layout changes | The request is about cohesion and lighting, not board geometry or play rules. |
| Use board-space stone gradients | A single SVG gradient spanning the board makes hull and rosette stone share the same light direction as the wall. |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|

## Notes
- User references cathedral rose windows with stone tracery, warm limestone, carved relief, and stained glass set within the same masonry surface.
