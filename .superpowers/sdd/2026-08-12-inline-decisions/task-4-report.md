# Task 4 — document comment chrome

## Summary

Open comments now render as document-local overlay chrome: a 24px gutter
button resolves from the exact passage, falls back to the surviving subject
block, and opens a pinned reply card. Draft placement is captured before focus
leaves the selection and remains local-only. Orphaned comments remain reachable
from a document-chrome count.

## Files

- Added `packages/editor/src/comment-geometry.ts` and its pure tests.
- Added `packages/editor/src/comment-layer.tsx` and mounted it through the
  widgets plugin.
- Updated comments, threads, the selection toolbar, overlay styling, and the
  sidecar browser tests.

## RED / GREEN

RED: `bun test packages/editor/src/comment-geometry.test.ts` failed because
`./comment-geometry` did not exist.

GREEN: the same geometry test passed with four assertions for exact passage,
block fallback, clamping, and left-side popovers. Final focused unit run passed
40 tests.

## Verification

- `DPRINT_CACHE_DIR=/private/tmp bun run ci` — pass
- `bun run types` — pass
- `bun test packages/editor/src/comment-geometry.test.ts packages/editor/src/threads.test.ts packages/editor/src/places.test.ts` — pass (40 tests)
- `TMPDIR=/private/tmp bun run e2e -- e2e/sidecar.e2e.ts` — blocked before any
  test body: every fixture timed out while the editor remained read-only
  (`contenteditable=false`). Chromium launch required escalation; the rerun
  reached the app but hit the same shared connection/readiness failure.

## Commit

Included in the final Task 4 commit; its immutable hash is reported in the
handoff.

## Deviations / risks

The old decisions-sidecar thread cards are intentionally left for Task 5 to
remove. Browser assertions were changed only to the reachable document-chrome
flow; accept-to-inline-decision cannot be exercised with `AGENT=off` and the
suite's readiness blocker prevented end-to-end confirmation. The overlay does
not touch `CSS.highlights` or comment transport payloads.
