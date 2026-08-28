# Design system normalization plan

**Status:** Complete

This small pass addresses only the verified P1/P2 findings from the browser audit. The P3 icon
colour migration and product-taste questions remain outside this plan.

## 1. Make the current compact destination visible

- Add a shared `aria-current="page"` treatment to `.workspace-navigation`.
- Guard it in `apps/web/src/tokens.test.ts`.
- Show the compact navigation state in the surface catalogue.

## 2. Normalize standard icon buttons

- Keep `.btn-icon` at 28px with a 16px glyph.
- Move send, Conversation, close, stop, sidebar, and queued-message actions onto that contract.
- Preserve 14px compact-navigation and disclosure icons because they are a separate role.
- Add focused render contracts for the affected controls.

## 3. Remove mechanical drift

- Keep base button labels on one line.
- Replace the two byte-identical close icons with `panel-close.svg`.
- Add an asset regression test so the duplicate names do not return.

## 4. Verify

- Run the focused design-system and component tests.
- Run workspace TypeScript checks, validation, unit tests, and production build.
- Recheck the catalogue at desktop and compact widths.
