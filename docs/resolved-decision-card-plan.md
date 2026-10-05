# Resolved Decision Card Implementation Plan

> **For agentic workers:** Implement this plan in small steps, checking the affected tests between edits.

**Goal:** Make an answered decision look like the open card in a static, clearly chosen state.

**Architecture:** Keep the durable decision record and actions unchanged. `QuestionView`
renders read-only options and provenance; `QuestionnaireCard` supplies the metadata and
chooses the open-like surface. Shared CSS tokens paint the selected static row.

**Tech Stack:** React, TypeScript, Tailwind utilities, existing theme CSS, Bun tests, Playwright.

---

## Files

- `packages/question/src/react/question-view.tsx`: static answered questions/options.
- `packages/question/src/react/resolved-actions.test.ts`: resolved markup and action contracts.
- `packages/editor/src/widgets/questionnaire.tsx`: answered-card surface and provenance placement.
- `apps/web/src/theme.css`: selected static row style matching open choices.
- `e2e/sidecar-card-states.e2e.ts`: resolved, read-only, and reopen browser behavior.

## Task 1 — Make the resolved body resemble the open card

- [ ] Add a failing markup test for a heading with `question-head`/`question-mark`, static
  option rows with letter tiles, selected row/check, no inputs, and one linked heading button.
- [ ] Run `bun test packages/question/src/react/resolved-actions.test.ts` and confirm that
  the new expectation fails on the old resolved markup.
- [ ] Render offered options in read-only rows; select by `optionIds` when present and
  label fallback for legacy answers. Show a custom/unmatched answer as a chosen text row.
  Preserve multi-question order and the missing-projection “Saved decision” fallback.
- [ ] Extend `.question-option` selected styling to the static row marker in `theme.css`.
- [ ] Run the focused unit test and `bun run types`.

## Task 2 — Align chrome and metadata

- [ ] Give answered cards the normal white/shadow surface; retain the muted surface for
  discarded cards. Use the existing `SidecarCard` boundary without changing comment cards.
- [ ] Move answered provenance below the choice rows through `QuestionView`’s existing
  `aside` slot. Keep the attribution server-owned and the action callbacks unchanged.
- [ ] Run `bun test packages/editor/src` and `bun run types`.

## Task 3 — Verify the real interaction and ship

- [ ] Extend the existing resolved-card browser checks for selected presentation,
  keyboard prose navigation, read-only actions, Reopen/Discard, and compact width.
- [ ] Run focused Chromium checks, `bun run fix`, `bun run ci`, and `bun run build`.
- [ ] Capture settled open/answered screenshots in `/private/tmp`, independently review
  the diff, then commit and open the standalone PR with hosted inline visuals.
