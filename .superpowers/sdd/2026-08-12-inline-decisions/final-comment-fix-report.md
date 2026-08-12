# Final comment interaction fix

## Summary

- Open comment passages now have one transparent, host-observed hit region per
  rendered range line. Hover previews and clicks work from the exact passage
  without putting elements in the collaborative document or changing the
  `CSS.highlights` registry.
- A passage click pins the same thread card as its gutter button. The overlay
  never receives pointer events, so native Lexical selection remains intact.
- Previews use the existing bounded `popoverPoint()` geometry and stay inside
  the narrow 400px document surface. They are pointer-transparent too, so a
  narrow preview cannot cover its own passage's click.
- Comment buttons include reply state in their accessible name and description;
  an exposed preview is linked with `aria-describedby`.

## Files

- `packages/editor/src/comment-hits.ts`
- `packages/editor/src/comment-hits.test.ts`
- `packages/editor/src/comment-layer.tsx`
- `packages/editor/src/comment-geometry.test.ts`
- `packages/editor/src/styles.css`
- `e2e/sidecar.e2e.ts`

## RED / GREEN

RED:

- `bun test packages/editor/src/comment-hits.test.ts packages/editor/src/comment-geometry.test.ts`
  failed because the hit-region helper did not exist.
- The narrow browser test failed with zero `[data-plan-comment-hit]` regions.

GREEN:

- The new pure hit-region and 400px geometry tests pass.
- Focused browser coverage passes for wrapped passage hover/click, bounded
  preview placement, preserved text selection, preview association and reply
  descriptions.

## Verification

- Relevant editor units: 57 passed.
- Full sidecar browser suite: 17 passed.
- Full e2e suite: 68 passed.
- Full unit suite: 618 passed.
- `bun run types` passed.
- `bun run ci` passed.
- `bun run build` passed.
- `git diff --check` passed.

## Commit

`Add passage interactions for inline comments`

## Risks

- The range rectangles are recalculated with the existing editor/scroll/resize
  measurement lifecycle; a transient stale rectangle can only miss a hover,
  never alter document content or selection.
- Exact painted prose remains keyboard-accessible through its named gutter
  button, because a CSS highlight cannot supply a real focus target without
  changing the editor tree.
