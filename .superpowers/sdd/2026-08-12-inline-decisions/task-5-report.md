# Task 5 — focused and inline decision views

## Summary

Replaced the decisions rail with one document area that switches between a
mounted Plan and a questionnaire-only Decisions view. Chat remains the only
resizable rail, at 280px by default and clamped to 240–400px.

The room consumes editor-owned `countUnanswered`, `useHasPlanContent`, and
`visibleDecisionView`; it does not re-derive plan state. New questions animate
the Decisions control without moving a prose-bearing plan away from Plan. The
host retains and restores the plan scroll position across view switches.

## Files

- Added `apps/web/src/decision-view-control.tsx` and its focused test.
- Updated the web room, workspace, chat wording, token contract, and shell/
  sidecar browser coverage.
- Reduced `packages/editor/src/decisions.tsx` to questionnaire cards and
  retained resolved-question disclosure.
- Added PlanEditor scroll-position callbacks for the host-owned view state.

## RED / GREEN

RED: `bun test apps/web/src/decision-view.test.ts` failed with:

```
Cannot find module './decision-view-control'
```

GREEN: after the minimal control implementation, the same test passed all
three view, attention, and zero-badge assertions.

The new browser coverage initially failed against the old three-pane shell.
The first sandboxed browser run was blocked by Chromium's macOS rendezvous
permission; the elevated rerun verified the implementation. Two subsequent
test-only corrections made the count decorative to assistive naming and fixed
the scroll-container locator. No product defect remained.

## Results

- `bun test apps/web/src/decision-view.test.ts apps/web/src/tokens.test.ts packages/editor/src/decision-state.test.ts` — 32 pass, 0 fail.
- `TMPDIR=/private/tmp bun run e2e -- e2e/shell.e2e.ts e2e/sidecar.e2e.ts` — 19 pass, 0 fail.
- `bun run types` — pass.
- `DPRINT_CACHE_DIR=/private/tmp/dprint-cache bun run ci` — pass.
- `git diff --check` — pass.

## Commit

`Add focused and inline decision views` (this commit).

## Deviations / risks

`PlanEditor` gained small scroll callbacks although it was not named in the
brief's file list; this is necessary to keep scroll ownership in the document
host while preserving the mounted editor. Task 6 planner-prompt work was not
changed.
