# Task 7: Color popover specimen

Added the design audit color group with a live `ColorPopover` and a three-row document table. Each Activity cell renders the shared `Sparkline`; its neutral graphic token is set from the edited OKLCH value. The fixture records every ruby, orange, lime, and gray theme value in declared order, with a test against `theme.css`.

## Checks

- Test-first run: `bun test apps/web/src/design-audit` failed because `./color` did not exist.
- `bun test apps/web/src/design-audit`: 23 pass, 0 fail.
- `bun run fix`: completed; one pre-existing approximate-constant warning in `packages/color/src/contrast.test.ts`.
- `bun run types`: passed across all packages and E2E.
- `bun test` with local socket permission: 1578 pass, 2 PostgreSQL skips, 0 fail.
- `bun run ci`: passed; 227 tokens defined across 23 stylesheets.
- `git diff --check`: passed.

## Browser

Checked `http://127.0.0.1:15174/design-audit#color` with Playwright at 1280×900 and 390×844. Screenshots: `docs/superpowers/reports/color-controls/task-7-desktop.png`, `task-7-mobile.png`, and `task-7-out-of-gamut.png` (ignored artifacts).

- At 390 px, document scroll width and client width were both 390 px.
- Dragging the plane changed contrast from `3.00:1` to `4.81:1` and the Sparkline stroke from `rgb(150, 149, 142)` to `rgb(123, 114, 79)`. The thumb stayed inside the plane.
- Five ArrowUp presses changed the thumb's accessible value from lightness 55.0% to 60.0%.
- Hue strip travel from top to bottom and back preserved chroma `0.0508`.
- Switching to HEX and blurring unchanged showed `#96958e` with no “was” line.
- Entering `oklch(0.7 0.3 140)` showed “Outside sRGB, shown clipped,” updated contrast to `2.33:1`, and repainted the Sparkline in clipped green.
- Console had no application errors; the dev server returned 404 for `/favicon.ico`.

No deviations from the Task 7 design brief.
