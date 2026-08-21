# Wider rich surfaces

## Goal

Keep prose on Chopin's existing 40rem reading measure while allowing top-level tables, images, and
Mermaid blocks to use the document width, inset by the normal inline gutters. On a narrow
document, the layout should look unchanged.

## Design

The editor root remains centred and measure-limited. An explicit allowlist of direct-child rich
surfaces breaks out of that measure with CSS container units: each surface can use the document
container width minus both gutters, and calculated inline margins keep it centred. The allowlist
contains tables, images, and Mermaid blocks. The same elements nested inside callouts, tabs, or
other authored components keep their current local width.

The table remains its own horizontal scrollport. It shrink-wraps to its intrinsic column width and
is centred on the document when narrower than the available surface. Its cells retain their minimum
width, so a table whose columns need more room than the widened surface is capped at that width and
can still scroll without widening the document. Existing table rails continue to measure the
rendered table and therefore need no state or geometry changes.

Images can grow beyond the prose measure but never beyond their natural size, avoiding blurry
upscaling. Mermaid's whole block widens, keeping its preview, controls, and editable source aligned.
The rendered diagram is centred inside that preview when narrower than the available surface; an
intrinsically wider diagram continues to scroll inside its preview.

## Responsive behaviour

- Wide document: prose stays at 40rem; allowed top-level surfaces can reach the document's inline
  gutters.
- Narrow document: prose and rich surfaces use the available width inside the reduced gutters.
- Image: grows only up to its natural width and remains centred when it is smaller than the space.
- Intrinsically narrow table or diagram: remains centred within the document container.
- Intrinsically wide table or diagram: horizontal scrolling stays on that surface, with no document
  overflow.
- Nested rich surface: stays contained by its nearest authored component.
- Callouts, tabs, questionnaires, ordinary code blocks, and display maths retain the prose measure.

## Verification

Extend the Playwright layout coverage to assert that top-level tables, naturally wide images, and
Mermaid blocks are wider than prose in a wide document, align with the document gutters or their
natural width, and collapse back to the prose width in a narrow document. Keep the existing checks
for internal scrolling, page containment, and table-rail alignment. Add compact table and Mermaid
fixtures to verify their rendered content remains centred without being stretched. Add a contained
nested fixture so the direct-child boundary is covered.
