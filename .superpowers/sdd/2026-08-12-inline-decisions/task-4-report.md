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
remove. The overlay does not touch `CSS.highlights` or comment transport
payloads.

## Review follow-up

### Readiness investigation

The Playwright trace contained Lexical error #195 (`getLatest` via
`getQuestionnaire`) and left the editor reconnecting/read-only. The invalid
read was not `QuestionnaireObserver`: that observer wraps its collection in
`editor.getEditorState().read`. It was the questionnaire decorator renderer:
`renderQuestionnaire` returned a React component holding a live
`QuestionnaireNode`, and that component called `getQuestionnaire` after
Lexical's read transaction had ended. The thrown render disconnected the room.

The smallest reproduction captures the decorator element inside a headless
Lexical read, then asserts its props after that read has finished. RED found no
captured `value`; GREEN captures the plain questionnaire record before React
renders it. The regression is in `widgets/questionnaire-render.test.tsx`.

### Placement and interaction RED / GREEN

- RED: the new tall-card geometry case produced `{ top: 560, left: 0 }` when
  `{ top: 400, left: 468 }` was required. GREEN: `popoverPoint` now accepts the
  card height and clamps against it; rendered cards measure their actual
  height.
- Draft cards now use their captured selection rectangle through
  `popoverPoint`, rather than recomputing a gutter point after the native
  selection disappears.
- The preview owns the same enter/leave timer handlers as its button, so
  crossing from the button into the preview does not close it.

### Browser coverage and `AGENT=off`

`sidecar.e2e.ts` now covers a live comment after text editing, fully orphaned
document chrome, and accepting into an inline `<Decision>`. Ordinary typing is
not a drift fallback reproduction: Yjs relative positions deliberately stretch
and the passage remains exact. The actual unresolved-passage/block-survives
fallback is covered deterministically by the existing pure `places.test.ts`.

`AGENT=off` does not prevent the inline decision. `comments/service.ts` inserts
and publishes the `<Decision>` before it calls `Chat.instruct`; that call only
skips the later agent-authored revision and emits the system notice. The
acceptance browser test therefore runs under the suite's normal `AGENT=off`
fixture and passes.

### Follow-up verification

- `bun test packages/editor/src/widgets/questionnaire-render.test.tsx packages/editor/src/comment-geometry.test.ts packages/editor/src/threads.test.ts packages/editor/src/places.test.ts` — pass (42 tests)
- `bun run types` — pass
- `TMPDIR=/private/tmp bun run e2e -- e2e/sidecar.e2e.ts` — pass (12 tests)
- `bun run ci` — pass

### Follow-up commit

Included in the follow-up commit; its immutable hash is reported in the
handoff.
