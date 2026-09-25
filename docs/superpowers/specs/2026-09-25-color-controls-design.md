# Color controls

## Why

Chopin should let people drop small, purpose-built tools into a document — _jigs_ — to make a
decision with bespoke controls, then commit that decision. The first jig is for color. It came
from a throwaway lab
([`05-sparkline-color-lab.html`](assets/color-controls/05-sparkline-color-lab.html)) that was
used to pick a neutral gray for the sparkline so that it met the WCAG 3:1 non-text contrast
minimum. The lab had the right ingredients:

- pick a color from the design-system ramp
- adjust it precisely in OKLCH
- read its WCAG contrast live
- see it in the component where it will be used

The lab has too much repetition. It shows the hex three times, the contrast twice, and adds
explanatory prose and a meter that duplicates the badge. Its light ground with white panels
is worth keeping.

This spec covers **sub-project 1 only: the color controls**. They are pure, reusable UI with no
persistence, no document integration, and no Planner involvement.

## Sub-project map

| # | Sub-project                     | Status                                                     |
| - | ------------------------------- | ---------------------------------------------------------- |
| 1 | Color controls (this spec)      | Planned: `docs/superpowers/plans/2026-09-25-color-controls.md` |
| 2 | Color jig block and decision    | Future. Outline below; needs its own spec.                 |
| 3 | Live preview in context         | Future. Approach A first, B if feasible.                   |

## Reference

The reference is an all-in-one theme editor. Model ours on it.

| File                                                                                  | Shows                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`01-palette-grid-and-tokens.png`](assets/color-controls/01-palette-grid-and-tokens.png) | Hue × step grid with no gaps between swatches; step column headers; hue row labels; the × remove affordance on hover; "+ Add hue"; Light/Dark toggle; Tokens list mapping roles (accent, interactive, neutral) to hues with a leader line and a swatch |
| [`02-remove-hue.png`](assets/color-controls/02-remove-hue.png)                         | The grid after a hue was removed; the tokens pointing at the removed hue fall back                                                                      |
| [`03-swatch-popover.png`](assets/color-controls/03-swatch-popover.png)                 | Clicking a swatch outlines it and opens a popover anchored below it: title "Green 500", a curve icon and a settings icon, a 2D plane, a vertical hue strip, a Previous/Current bar, and a format switcher (HEX) with a text input |
| [`04-ramp-curve-editor.png`](assets/color-controls/04-ramp-curve-editor.png)           | The curve icon opens a second pane beside the popover: Darkest and Lightest endpoints (L %, H shift °, easing), a chroma graph (solid Current, dashed Max) across steps 1–9, and "Previous hue palette was overwritten. Restore it by discarding these changes." The whole row updates live |

**Deliberate differences from the reference:**

- **The plane is OKLCH lightness × chroma at a fixed hue**, not HSV. The part a screen can show
  (the sRGB gamut) has an irregular boundary. Draw that boundary and leave the region beyond it
  empty.
- **The chroma axis uses a square-root scale.** Otherwise a low-chroma neutral such as gray
  (C ≈ 0.01) is squeezed into a few pixels at the left edge.
- **A contrast reader is built into the popover.** The reference has none.
- **Rows can have different steps.** Chopin's hue ramps use steps `1`–`12`, and gray uses `50`,
  `100`, `150`, `200`, `300`, `400`, `450`, `500`, `600`, `700`, `750`, `800` and `900`. Other
  repositories will differ again.
- **"+ Add hue", removing a hue and the settings icon are out of scope.** Adding and removing
  hues belongs in sub-project 2. The settings icon has no defined job yet.

## Decisions already made

- **Scope:** the palette grid, the single-color popover, the ramp curve editor, and semantic
  tokens with a Light/Dark toggle. Each is its own slice and PR, in that order after slice 1.
- **Architecture:** a pure model with controlled views, and color math written by hand with no
  dependencies. Do not add `culori`, `colorjs.io` or any other color library.
- **Contrast is measured against a chosen color.** By default that is the active theme's
  surface. The user can switch it to any palette swatch. One ratio is shown.
- **The WCAG purpose is selectable.** Graphics and UI need 3:1, large text 3:1, body text 4.5:1,
  and enhanced text 7:1. The badge reads pass or fail for the selected purpose.
- **Palette discovery is not in this project.** The controls take a `Palette` value. In
  sub-project 2 the Planner will find a repository's design system and produce one.
- **Keep base values and edits separate.** The base palette is never changed. Edits are a diff
  on top of it, which makes Previous/Current, per-swatch reset, per-row discard and the future
  committed decision all fall out of the model.
- **Collaboration later.** Every view is controlled (`state` plus `dispatch`, or `value` plus
  `onChange`). This keeps shared state possible in sub-project 2, through a Yjs map or a
  questionnaire-style shared draft, without changing any view. Do not build realtime sync now.

## Architecture

```
packages/color      pure TypeScript, no React, no DOM, no dependencies
  oklch.ts          conversions, parse, format, sameColor
  gamut.ts          maxChroma, cusp
  contrast.ts       WCAG ratio, thresholds, formatRatio
  palette.ts        Palette types, reducer, selectors, changes()
  curve.ts          ramp curve generation (slice 3)

packages/visuals/src/ui/color/     React views, controlled, cv- class prefix
  geometry.ts       plane, hue and scrub mapping plus image generation (pure)
  contrast-reader.tsx
  color-plane.tsx
  hue-strip.tsx
  color-field.tsx   format switcher plus text input
  color-popover.tsx composes plane, hue strip, compare bar, field and contrast reader
  palette-grid.tsx          (slice 2)
  palette-editor.tsx        (slice 2) grid plus anchored popover
  ramp-curve-editor.tsx     (slice 3)
  scrub-field.tsx           (slice 3)
  chroma-graph.tsx          (slice 3)
  token-list.tsx            (slice 4)
  theme-toggle.tsx          (slice 4)
  color.css

apps/web/src/design-audit/color.tsx      dev-only specimen at /design-audit
apps/web/src/design-audit/color-fixture.ts   Chopin's own ramps, copied from theme.css
```

`@chopin/color` has no workspace dependencies. `@chopin/visuals` depends on it.

## Data model

```ts
type Oklch = { l: number; c: number; h: number }; // l 0–1, c ≥ 0, h [0, 360)
type Theme = "light" | "dark";
type SwatchRef = { hue: string; step: string };
type Swatch = { step: string; value: Oklch; source?: string }; // source: "--color-gray-450"
type Hue = { name: string; swatches: Swatch[] }; // in the order the repository declares
type Token = { name: string; group?: string; ref: SwatchRef; source?: string };
type Palette = {
	themes: { light: Hue[]; dark?: Hue[] };
	surfaces?: Partial<Record<Theme, Oklch>>; // default contrast background
	tokens?: Token[];
};
```

`Record` is used instead of `Map` everywhere, so that state can be serialized to JSON. Edits are
nested by hue and then step, never joined into a string key, so a hue called `a/b` cannot collide
with anything. `createPaletteState` throws a descriptive `Error` for duplicate hue names within a
theme and for duplicate steps within a hue. A palette produced by discovery must be rejected
loudly, not rendered with collisions.

Editor state:

```ts
type PaletteState = {
	palette: Palette; // the base, never changed
	theme: Theme;
	edits: Record<Theme, Record<string, Record<string, Oklch>>>; // theme → hue → step → value
	curves: Record<Theme, Record<string, Curve>>; // hue → last curve settings (slice 3)
	retargets: Record<string, SwatchRef>; // token name → new ref (slice 4)
	selected: SwatchRef | null;
};
```

Actions: `select`, `edit`, `reset` (one swatch), `resetRow`, `resetAll`, `theme`,
`curve` (slice 3) and `retarget` (slice 4). An edit whose value equals the base value removes
the edit, so "edited" always means "differs from base". Two colors count as equal when they
match within 1e-5 on each channel. Hue is ignored when both chromas are below 1e-4.

`changes(state)` returns `{ kind: "swatch", theme, ref, before, after }` and
`{ kind: "token", name, before, after }` entries. It is the diff that the jig will commit in
sub-project 2.

## Behavior

### Color math

- **Conversions.** OKLCH to linear sRGB uses Björn Ottosson's matrices, the same ones as the
  lab. `toSrgb` reports `inGamut` using a tolerance of 1e-6 on each encoded channel, and
  clamps the returned bytes. `fromHex` handles `#rgb` and `#rrggbb`. Colors whose chroma is
  below 1e-4 are treated as achromatic: `c = 0`, `h = 0`.
- **`parse(text)`** accepts, case-insensitively and with loose whitespace:
  - `#rgb` and `#rrggbb`
  - `oklch(L C H)`, where L is 0–1 or a percentage, C is a number or a percentage
    (100% = 0.4), and H is a number with an optional `deg`. As in CSS, L is clamped to [0, 1],
    a negative C becomes 0, and H is normalized to [0, 360).
  - `none` for any channel, which becomes 0

  It returns `null` for alpha, `var()`, other color functions, and anything else.
- **`format(value, "oklch" | "hex")`.** The `oklch` form rounds L and C to 5 decimals and H to
  2, trims trailing zeros, and writes `oklch(0.6681 0.0105 95)`. The `hex` form is lowercase
  `#rrggbb` of the clipped sRGB color.
- **`maxChroma(l, h)`** is a 24-step binary search over `[0, 0.5]`. `cusp(h)` gives the highest
  `maxChroma` across lightness, sampled every 0.01. It sets the plane's chroma range.
- **`contrast(a, b)`** is the WCAG 2 ratio computed on the clipped 8-bit sRGB bytes, so it
  matches the hex value and what the screen shows. `formatRatio` **truncates** to 2 decimals
  (2.999 shows as `2.99:1`). A failing value must never display as `3.00:1`.
  `passes(ratio, purpose)` compares the unrounded ratio.

Values checked against Chopin's theme, taking contrast against white:

| Token            | OKLCH                    | hex       | ratio  |
| ---------------- | ------------------------ | --------- | ------ |
| `--color-gray-300` | `0.89108 0.00552 95`   | `#dcdbd7` | 1.3855 |
| `--color-gray-400` | `0.74029 0.00856 95`   | `#acaba5` | 2.3020 |
| `--color-gray-450` | `0.66810 0.01050 95`   | `#96958e` | 3.0058 |
| `--color-gray-500` | `0.56514 0.0123 95`    | `#78766e` | 4.5502 |

Other checked values: `maxChroma(0.7, 30) ≈ 0.1915`, `maxChroma(0.75, 95) ≈ 0.1540`,
`maxChroma(1, h) < 0.001`, and `cusp(95) ≈ 0.1807`.

### Color popover (slice 1)

The popover is a panel roughly 320 px wide. It has no positioning of its own; slice 2 anchors
it. From top to bottom:

1. **Header.** The title (for example "Gray 450") and a slot for header actions (the curve toggle
   in slice 3).
2. **Plane and hue strip.**
   - The plane is square, with lightness running from 1 at the top to 0 at the bottom. Chroma
     runs left to right on the `sqrt(c / cusp(h))` scale.
   - The plane is painted from a 96 × 96 RGBA image generated by `planeImage()` and scaled up
     smoothly by CSS. Pixels outside the gamut are transparent, so the inset surface shows
     through. The gamut boundary is drawn as an SVG path on top.
   - The thumb is a ring.
   - Dragging uses pointer capture, and chroma is clamped to `maxChroma(l, h)`.
   - Keyboard: the thumb is one focusable element with `role="slider"` and an `aria-valuetext`
     such as "Lightness 66.8%, chroma 0.0105". ←/→ change chroma by 0.001 and ↑/↓ change
     lightness by 0.01. Shift multiplies the step by 10 and Alt divides it by 10. Page Up and
     Page Down change lightness by 0.1.
   - The hue strip is vertical. It is painted as a gradient with a stop every 15°, at L 0.75
     and `c = min(0.15, maxChroma)`. It is a `role="slider"` with vertical orientation. 360° is
     at the top and 0° at the bottom, so ↑ increases the value as ARIA expects. ↑/↓ step 1°, and
     Shift steps 10°. Hue wraps around.
3. **Compare bar.** The left half shows Previous and the right half shows Current, each labelled
   above. Clicking Previous restores it; the accessible name is "Restore previous color". When
   the two are equal, the bar shows one color and Previous is disabled.
4. **Color field.** A native `<select>` offers "OKLCH" and "HEX" (with globally unique option
   values) next to a text input.
   - The input commits on Enter or blur. Escape restores the last committed text.
   - Text that doesn't parse sets `aria-invalid` and keeps the previous color.
   - A value that parses but is out of gamut is accepted. It shows "Outside sRGB, shown
     clipped" and the contrast uses the clipped color.
5. **Contrast reader.**
   - The ratio is shown large, with tabular numbers.
   - A pass or fail badge uses the existing `IconLabel` with the `success` or `danger` tone and
     reads "Meets 3:1" or "Below 3:1".
   - A purpose `<select>` offers "Graphics and UI", "Large text", "Body text" and "Enhanced
     text".
   - An "against" control shows the background swatch and its name, and lets the user choose
     from the options passed in.
   - A secondary line shows the previous ratio only when it differs, for example "was 2.30:1".
   - Nothing else: no meter and no explanatory paragraph.
   - The visible ratio updates on every change. A separate visually hidden `aria-live="polite"`
     line announces the ratio and verdict only after the value has been still for 500 ms, so a
     drag doesn't flood screen readers.

The contrast target is controlled from outside: the popover receives `against`, `againstOptions`
and `onAgainstChange`.

### Palette grid and editor (slice 2)

- **Rows and headers.** One row per hue, with the name in a left column. Swatches in a row
  share its width equally, with no gap between them. The grid has rounded outer corners only.
  When every row has identical step labels, a shared column header appears above the grid.
  Otherwise there is no header, and each swatch's step appears in its tooltip and accessible
  name.
- **Swatches.** Each swatch is a `<button>` whose accessible name is `"{Hue} {step}, {format},
  edited"`, with "edited" only when it applies. `aria-pressed` marks the selected swatch.
  - An edited swatch shows a small dot, in a color that contrasts with the swatch
    (`contrast ≥ 3` against either black or white).
  - The selected swatch gets the reference's inset ring: a 2 px `--color-page` inset plus a
    1 px outer shadow.
- **Keyboard.** Roving tabindex. The arrow keys move within and between rows, snapping to the
  nearest index when row lengths differ. Home and End go to the ends of a row. Enter or Space
  opens the popover. The movement logic is a pure function, `gridMove`.
- **Popover.** `PaletteEditor` opens the popover with the native `popover="auto"` attribute, so
  it gets the top layer, light dismiss and Escape. It is placed below the swatch, centred and
  clamped to the viewport with a 16 px margin. It flips above when there is no room below.
  Closing it returns focus to the swatch. The placement is a pure function,
  `placePopover(anchor, size, viewport)`. Viewport bounds come from `currentViewport()` and
  `listenToViewportChanges()` in `@chopin/viewport`, the same source `apps/web/src/anchored-picker.tsx`
  uses, so mobile visual-viewport offsets are respected.
- **Changes summary.** A compact line under the grid reads "3 changes · Discard all". Nothing
  appears when there are no changes.

### Ramp curve editor (slice 3)

- **Opening.** The curve toggle in the popover header opens a pane beside the popover at 640 px
  and wider, and below it on narrower screens. The pane shows the whole row of the selected
  swatch.
- **Endpoints.** The Darkest and Lightest endpoints each have three controls:
  - L %, a `ScrubField`: drag horizontally or type a value.
  - H shift °, a `ScrubField` covering −180 to 180.
  - Easing, a native `<select>` with "Linear" and "Ease".
- **Generation.** `rampCurve(base, curve)` works from the **base** row, not the edited one,
  so changing a setting is idempotent. For each swatch:
  - Position t runs from 0 at the darkest end to 1 at the lightest. The direction is inferred
    from the base row's first and last L.
  - `L = lerp(Ld, Ll, ease(t))`, where `ease` is a cubic Hermite with a start slope of 1 for
    Linear or 0 for Ease at the darkest end, and the same rule for the end slope at the
    lightest end.
  - `h = base.h + lerp(shiftD, shiftL, t)`.
  - `c = min(1, base.c / maxChroma(base)) × maxChroma(L, h)`. Each swatch keeps its relative
    saturation.
  - `curveFrom(base)` sets the initial endpoints from the row's minimum and maximum L, with
    zero shift and Linear easing. Opening the pane changes nothing until a control moves.
- **Chroma graph.** An SVG with one x position per step. A solid line shows the current
  chroma and a dashed line shows `maxChroma`, with a legend reading "— Current - - Max".
- **Discard.** When the row has edits, a note reads "This row's previous values were
  overwritten. Discard these changes to restore them." "Discard these changes" is a button that
  dispatches `resetRow`.
- **Short rows.** A row with fewer than 2 swatches disables the curve toggle and gives the
  reason in its accessible description.

### Tokens and theme (slice 4)

- **Token list.** Tokens are listed by group. Each row has the name, a leader line, the ref label
  ("gray 450") and a small swatch.
  - Clicking the swatch or the label selects the referenced swatch and opens its popover.
  - The ref label is a native `<select>` of every swatch in the active theme. Changing it
    dispatches `retarget`.
  - A retargeted token shows "was gray 300" until it is reset.
- **Theme toggle.** A two-button Light/Dark segmented control, shown only when `palette.themes.dark`
  exists. Edits are kept per theme. The default contrast `against` color follows the active
  theme's surface, which defaults to `oklch(1 0 0)` for light and `oklch(0.159 0.006 95)` for
  dark.
- **Missing refs.** A token whose ref no longer resolves shows "missing" in the danger tone and
  never throws.

## Visual direction

- Use the lab's light `--color-ground` background with white `--color-page` panels, a
  `--shadow-resting` shadow and a large radius. Use Chopin's Inter typography, with tabular
  numbers for values.
- Show each value once. For example, the hex appears only in the color field, never beside the
  swatch as well.
- Use only existing theme tokens: `--color-*`, `--spacing`, `--radius-*` and `--shadow-*`.
- Custom properties written from script at runtime must carry a fallback, such as
  `var(--cv-swatch, transparent)`, so that `scripts/check-tokens.ts` passes.
- Load the `maggie-design` skill before building any view. Compare against the reference
  screenshots at each slice.

## Testing

- **`bun test`, with no DOM,** covers all of `packages/color` and the pure geometry functions
  (`planeValue`, `planePosition`, `planeImage`, `hueStops`, `gridMove`, `placePopover` and
  `scrub`). Components get static markup tests using `renderToStaticMarkup`, following
  `packages/visuals/src/ui/sparkline.test.tsx`.
- **Browser verification.** `/design-audit` is served only in development, so the production
  E2E suite cannot reach it. Verify interaction and layout by running `bun run dev` and driving
  `/design-audit#color` with the Playwright MCP browser at 1280 px and 390 px wide. Take
  screenshots and compare them against the reference images. Do not add `happy-dom` or
  `jsdom`.
- **Checks.** `bun run types`, `bun test`, `bun run ci`. Run `bun run fix` after edits.

## Sub-project 2 outline: color jig (future, not planned here)

- **Dialect node.** A `<ColorJig id=… />` in the restricted MDX allowlist. It is atomic, like a
  questionnaire; the sidecar record owns its state and the node is a projection.
- **Palette discovery.** A Planner tool that finds the design system in the connected
  repository (CSS custom properties, Tailwind theme, token JSON) and emits a `Palette` with a
  `source` on every swatch and token. It returns nothing when there isn't a design system.
- **Draft state.** A shared draft that holds `PaletteState.edits` and `retargets`, following
  the questionnaire draft pattern. It needs a decision on concurrent edits to the same swatch
  (last writer wins is probably enough).
- **Commit.** `changes(state)` becomes a decision record. The document projection lists the
  changes as `token: before → after`, and the Planner can act on them.
- **Preview.** Option A: a Planner-authored static SVG or HTML mock in a sandboxed iframe, with
  the palette's CSS custom properties injected. Option B, if feasible: the repository's real
  component built into an isolated iframe, receiving the same custom properties through
  `postMessage`. Both only need the controls to emit color values.
