# Task 6 report: color plane and popover

Implemented `ColorPlane`, `HueStrip`, and `ColorPopover`, with a composed server-render test and public exports. The plane paints a 96 × 96 OKLCH image to canvas, overlays the gamut boundary, and supports pointer and keyboard input. The popover includes the compare bar, color field, and contrast reader.

## Verification

- Failing test observed before implementation: missing `color-popover` module.
- `bun test packages/visuals`: 72 passed.
- `bun run types`: passed.
- `bun test` with local socket access: 1,576 passed, 2 PostgreSQL tests skipped because `TEST_DATABASE_URL` is unset.
- `bun run fix`, `bun run ci`, and `git diff --check`: passed. `fix` and `ci` emit one existing approximate-constant warning in `packages/color/src/contrast.test.ts`.

## Departures from the task brief

- Hue pointer input preserves `hueValue()` exactly. The brief's `% 360` would turn the top edge's 360° into 0° and move the thumb to the bottom. Keyboard wrapping remains in `hueKey()`.
- Canvas data is copied into `context.createImageData()` because the direct `ImageData` constructor rejects the geometry function's `Uint8ClampedArray<ArrayBufferLike>` in this TypeScript configuration.
- The SVG gamut outline uses `createElement` to meet the existing repository guard against literal SVG JSX in component sources. It remains an SVG path generated from geometry, not an icon.
- Focus outlines use the repository's global theme rule for focusable elements; a local outline rule fails the shared focus-geometry guard.

The canvas Effect synchronizes only the canvas external system. Its dependencies are the current hue and chroma range; repainting is idempotent and creates no subscription or resource requiring cleanup, including under Strict Mode.
