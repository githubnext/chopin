# Final view-state fix report

## Summary

- Preserve the forced opening Decisions flow until the first ordinary prose
  block, then move to Plan once even when the saved preference is Decisions.
- Selecting Decisions now reveals, scrolls to, and focuses the first unanswered
  card. Resolved history starts collapsed, and the control names its unanswered
  count for assistive technology.
- Removed only unreferenced sidecar grid CSS and stale layout comments. Active
  `data-plan-sidecar-*` hooks remain in the focused and inline projections.

## Files

- `apps/web/src/app.tsx`, `apps/web/src/decision-view-control.tsx`, and
  `apps/web/src/decision-view.test.ts`
- `packages/editor/src/decision-state.ts`, `packages/editor/src/decision-state.test.ts`,
  `packages/editor/src/decisions.tsx`, and `packages/editor/src/decisions.test.tsx`
- `e2e/sidecar.e2e.ts`
- `apps/web/src/workspace.tsx`, `packages/editor/src/plan-editor.tsx`, and
  `packages/editor/src/styles.css`

## RED

`bun test packages/editor/src/decision-state.test.ts packages/editor/src/decisions.test.tsx apps/web/src/decision-view.test.ts` produced the intended four failures:

- saved Plan changed to Plan as soon as opening questions resolved;
- saved Decisions stayed on Decisions after first prose;
- the Decisions control omitted the unanswered accessible name;
- resolved history was open with no stored preference.

The focused browser test also failed before implementation because the first
questionnaire card remained inactive after returning to Decisions.

## GREEN and verification

- `bun test packages/editor/src/decision-state.test.ts packages/editor/src/decisions.test.tsx apps/web/src/decision-view.test.ts apps/web/src/tokens.test.ts` — 36 pass, 0 fail.
- `bun node_modules/@playwright/test/cli.js test --config e2e/playwright.config.ts e2e/sidecar.e2e.ts --grep "selecting Decisions returns"` — 1 pass.
- `TMPDIR=/private/tmp bun node_modules/@playwright/test/cli.js test --config e2e/playwright.config.ts` — 67 pass, 0 fail.
- `TMPDIR=/private/tmp bun test` — 616 pass, 0 fail.
- `bun run types` — pass.
- `DPRINT_CACHE_DIR=/private/tmp/dprint-cache bun run ci` — pass.
- `bunx dprint fmt` on changed source and test files — pass.
- `git diff --check` — pass.

## Commit

`Fix decisions view lifecycle and navigation`

## Risks

The opening transition is client-local UI state by design; no room phase,
protocol field, or migration was introduced. Comment-layer interaction was not
changed.
