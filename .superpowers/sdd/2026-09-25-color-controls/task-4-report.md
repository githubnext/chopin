# Task 4 report: contrast reader

## Implementation

Added a compact contrast reader with one visible ratio, an `IconLabel` verdict, an optional previous ratio, controlled purpose and background selects, and a swatch for the selected background. The ratio updates with props; a separate hidden polite live region announces a settled change after 500 ms. Returning to the initial reading also schedules an announcement.

The reader's styles use the existing visuals tokens and are imported from the public stylesheet. The component and its prop types are exported from `@chopin/visuals`.

## RED

`bun test packages/visuals/src/ui/color/contrast-reader.test.tsx` failed as expected because `./contrast-reader` did not exist.

## GREEN

`bun test packages/visuals` passed: 59 tests, 0 failures.

## Final checks

- `bun run fix`: passed; dprint could not write its incremental cache under the user Library path, but formatting completed. Oxlint reported one existing non-error approximate-constant warning in `packages/color/src/contrast.test.ts`.
- `bun run types`: passed for all packages and E2E.
- `bun test`: passed with socket binding permission: 1563 pass, 2 skipped PostgreSQL tests, 0 fail.
- `bun run ci`: passed; token check found 227 tokens across 22 stylesheets.
- `git diff --check`: passed.

## Plan departure

The brief's live-region example compared every reading with the initial reading. That would suppress a later announcement when the user returned to the initial value. The implementation instead skips only the initial effect and schedules every subsequent change, including a return to the initial reading.

## Follow-up: native option value collision

Review found that a background option whose ID matched a purpose, such as `graphic`, produced the same native option value in both selects. A new static-markup regression rendered that case and failed with five options but only four unique values. Purpose and background options now use distinct value prefixes, and each callback removes its own prefix before passing the controlled ID to the parent. The focused reader suite passes with 6 tests.

Follow-up checks: `bun run fix`, `bun run types`, `bun run ci`, and `git diff --check` passed. The socket-enabled full `bun test` passed with 1564 tests, 2 PostgreSQL skips, and 0 failures. The existing oxlint warning and dprint cache-write warning remained non-fatal.
