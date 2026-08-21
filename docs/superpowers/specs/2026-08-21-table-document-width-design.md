# Wider top-level tables

## Goal

Keep prose on Chopin's existing 40rem reading measure while allowing a top-level table to use
the document width, inset by the normal inline gutters. On a narrow document, the layout should
look unchanged.

## Design

The editor root remains centred and measure-limited. A direct-child table breaks out of that
measure with CSS container units: its width becomes the document container width minus both
gutters, and calculated inline margins keep it centred. Tables nested inside callouts, tabs, or
other authored components keep their current local width.

The table remains its own horizontal scrollport. Its cells retain their minimum width, so a table
whose columns need more room than the widened surface can still scroll without widening the
document. Existing table rails continue to measure the rendered table and therefore need no state
or geometry changes.

## Responsive behaviour

- Wide document: prose stays at 40rem; a top-level table aligns with the document's inline gutters.
- Narrow document: prose and tables use the available width inside the reduced gutters.
- Intrinsically wide table: horizontal scrolling stays on the table, with no document overflow.
- Nested table: stays contained by its nearest authored component.

## Verification

Extend the Playwright layout coverage to assert that a top-level table is wider than prose in a
wide document, aligns with the document gutters, and collapses back to the prose width in a narrow
document. Keep the existing checks for internal scrolling, page containment, and table-rail
alignment.
