# Design system audit

## Aim

Make Chopin's visual system easier to inspect and harder to drift. The first pass should fix clear,
repeatable inconsistencies while leaving taste-heavy choices visible for a human review.

The audit covers `apps/web` and the user-facing parts of `packages/editor`. Existing product identity,
behaviour, and terminology stay intact.

## Current state

The foundations are stronger than the individual screens suggest. `apps/web/src/theme.css` already
owns the colour, type, spacing, radius, focus, shadow, button, field, and choice-control scales. The
main problem is inconsistent use across roughly 3,400 lines of app and editor CSS.

Icons currently mix local SVG files with Phosphor React components and explicit sizes from 14px to
24px. At least one pair is byte-identical: `assets/figma/navigation/collapse.svg` and
`assets/icons/conversation-close.svg`.

Many editor widgets depend on Lexical, Yjs, live stores, or application state. Reimplementing their
markup in a showcase would hide the drift we want to find.

## Architecture

Add a development-only `/design-audit` route to `apps/web`. It renders before session loading, so the
catalogue can be reviewed without GitHub authentication. Production builds must not expose or bundle
the route.

The page has four layers:

1. **Foundations** – colour, typography, spacing, radii, shadows, icon sizes, and focus treatment.
2. **Controls** – buttons, icon buttons, links, fields, selections, tabs, menus, dropdowns, and their
   resting, hover, active, focus, disabled, busy, error, and selected states.
3. **Surfaces** – dialogs, popovers, cards, lists, navigation rows, chat messages, composer elements,
   decisions, resolved comments, and loading/empty/error states.
4. **Authored content** – a real read-only editor fixture containing headings, lists, links, image,
   formula, Mermaid diagram, code, diff, callout, table, tabs, decision, comment-related prose, and
   research states. Where a widget cannot be mounted through the document, use its exported component
   with a small typed fixture adapter.

Catalogue scaffolding belongs in a small `apps/web/src/design-audit/` module. It may compose real
components and fixtures but must not become a second component library.

## State and interaction

Sections render all stable visual states side by side. Pointer-only states get a labelled forced-state
sample so screenshots remain deterministic; real controls remain interactive for keyboard and focus
review. Dialogs and menus have both inline specimen and interactive examples.

Fixtures are local and deterministic. They do not call HTTP, WebSocket, GitHub, or Planner APIs. A
compact viewport control lets the same page expose desktop and narrow arrangements without copying
the app shell.

## Audit method

Create a machine-readable inventory alongside the page for:

- component and state coverage;
- icon source, semantic name, geometry, and duplicate-content hash;
- button and icon-button class combinations;
- shadow, radius, spacing, and colour-token use; and
- items deliberately left for human judgement.

Inspect the catalogue and authenticated app at desktop and mobile widths. Use one broad screenshot
pass, fix the resulting clear issues in a batch, then use one confirmation pass. This is a bounded
review, not an endless polish loop.

Clear first-pass fixes include duplicate icon assets, mismatched icon geometry or colour, missing
focus and disabled treatments, undersized targets, accidental one-off spacing, incorrect shadow
levels, and hierarchy that contradicts the shared button variants. Ambiguous brand or composition
changes go into the human-review list instead.

## Change boundaries

Normalisation should deepen the existing system:

- add semantic utilities or small shared components only when at least two real consumers need them;
- migrate consumers in small vertical slices;
- preserve accessible names, keyboard behaviour, responsive behaviour, and editor invariants; and
- avoid compatibility aliases unless persisted data or an external consumer requires one.

The catalogue stays in the repository as a regression and review surface after the audit.

## Verification

The catalogue gets focused render or source-contract tests for route gating and required specimens.
Existing component tests remain authoritative for behaviour. Browser checks cover layout, focus,
menus, dialogs, target sizes, overflow, and screenshots at desktop and mobile widths.

After edits, run `bun run fix`, focused tests, `bun run types`, `bun run ci`, and the narrowest relevant
Playwright coverage. Run the design-quality detector once over changed UI files after visual work is
finished.

## Delivery slices

1. Add the dev-only catalogue shell, inventory, and foundation/control specimens.
2. Add real app surfaces, chat, dialogs, decisions, comments, and loading states.
3. Add the authored-content fixture and research states.
4. Capture the first screenshots and normalise clear token, icon, control, spacing, and surface drift.
5. Confirm desktop/mobile results and publish the remaining human-review list.
