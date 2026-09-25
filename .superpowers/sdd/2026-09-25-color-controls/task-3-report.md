# Task 3 report: plane and hue geometry

## Implementation

Added the pure color-plane and hue-strip geometry module:

- square-root chroma mapping between plane points and OKLCH values, clamped to the sRGB gamut
- transparent out-of-gamut plane-image pixels and an SVG gamut-boundary path
- keyboard increments for lightness, chroma, and hue
- hue value and position mapping plus a 25-stop OKLCH gradient

Added `@chopin/color` as a workspace dependency of `@chopin/visuals` and the web specimen,
then regenerated `bun.lock`.

## RED

Command: `bun install && bun test packages/visuals/src/ui/color`

Result: expected failure before the implementation. The new test module could not resolve
`@chopin/color`, because Task 3's required visuals dependency had not yet been declared. This
was the first dependency needed by the test; after adding the declared dependency, the geometry
module was implemented.

## GREEN

Command: `bun install && bun test packages/visuals/src/ui/color`

Result: pass — `11 pass`, `0 fail`, `30 expect() calls`.

## Final checks

- `bun run fix`: pass; one existing non-error approximate-constant warning in
  `packages/color/src/contrast.test.ts`.
- `bun run types`: pass for all workspaces and E2E.
- `bun test`: pass — `1557 pass`, `2 skip`, `0 fail`, `6532 expect() calls`. The skipped
  PostgreSQL tests require `TEST_DATABASE_URL`.
- `bun run ci`: pass; the same non-error warning; token check passed (`227 defined across 21
  stylesheets`).
- `git diff --check`: pass before commit.

## Plan departure

The specified RED command failed first on the missing required `@chopin/color` package
declaration rather than `./geometry`. The test was still red for the expected new-task setup;
the dependency was added before production code so the test could exercise the missing module.

## Follow-up: hue endpoint round-trip

The original `huePosition()` normalization mapped the explicit `360` returned by the top of the
strip to normalized `0`, which positioned the thumb at the bottom. Added a RED regression that
round-trips both endpoints through `hueValue()` and `huePosition()`; it failed with top expected
at `0` and received at `200`.

`huePosition()` now preserves an explicit `360` as the top endpoint before it normalizes other
values. This deliberately departs from the original normalization-only formula because the strip
specification assigns `360` to its top and `0` to its bottom. Keyboard movement still normalizes
and wraps to `0`, which remains at the bottom. The focused suite passed `12 pass`, `0 fail` after
the fix.
