# Color Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build reusable, controlled color controls: a palette grid, a single-color OKLCH
popover with a WCAG contrast reader, a ramp curve editor, and a semantic token list with a
Light/Dark toggle. Chopin jigs will embed them later.

**Architecture:** A new pure-TypeScript package, `@chopin/color`, holds all color math and a
palette state reducer, with no dependencies, no React and no DOM. `@chopin/visuals` gets
controlled React views under `src/ui/color/`, plus pure geometry helpers that `bun test` can
exercise. A dev-only specimen at `/design-audit#color` demonstrates the controls against
Chopin's own ramps, including a live Sparkline preview.

**Tech Stack:** Bun 1.3.2, TypeScript (tsgo), React 19.2, plain CSS with Chopin theme tokens,
`bun:test` with `react-dom/server`, and dprint plus oxlint.

**Spec:** [`docs/superpowers/specs/2026-09-25-color-controls-design.md`](../specs/2026-09-25-color-controls-design.md).
Read it in full first. Reference screenshots are in
[`docs/superpowers/specs/assets/color-controls/`](../specs/assets/color-controls/). Open the
images and the original lab (`05-sparkline-color-lab.html`) before you start any view task.

## Global Constraints

- **Math:** no color library. Do not add `culori`, `colorjs.io` or any other.
  `@chopin/color` has zero dependencies and must not import React or touch the DOM.
- **Code style:** tabs, double quotes, semicolons, a 100-column target, and `let` for local
  bindings. Add comments only for non-obvious constraints. Follow `AGENTS.md`.
- **CSS:**
  - Classes are prefixed `cv-`.
  - Use only existing theme tokens (`--color-*`, `--spacing`, `--radius-*`, `--shadow-*`,
    `--text-*`).
  - A custom property read in CSS but written at runtime must carry a fallback, for example
    `var(--cv-swatch, transparent)`.
  - `bun run ci` runs `scripts/check-tokens.ts`, which fails on undefined custom properties.
- **Native `<select>`:** option values must be globally unique. Prefix them with `useId()`.
- **Tests:** `bun test` has no DOM, and you must not add `happy-dom` or `jsdom`. Unit-test pure
  functions. Test components with `renderToStaticMarkup`. Verify browser behavior by driving
  `bun run dev` with the Playwright MCP.
- **Contrast display:** `formatRatio` truncates. A failing ratio must never display as
  meeting the threshold.
- **Edits:** the base palette is never changed. An edit equal to its base value is removed.
- **Views are controlled.** The palette state lives in the caller, which passes it with
  `dispatch`. Views may keep only transient UI state: popover open, text being typed, and the
  selected format, purpose and background.
- **Scope:** do not build "+ Add hue", hue removal, the settings icon, palette discovery,
  dialect nodes, persistence or realtime sync.
- **After every code edit, run `bun run fix`.** Before every commit, run `bun run types`,
  `bun test` and `bun run ci`.
- **Commits** end with:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
- **Design:** before any view task (Tasks 4–7, 10, 12, 14 and 15), load the `maggie-design`
  skill. Show each value once. Use the lab's `--color-ground` background with white
  `--color-page` panels.

## Review Focus

- **Committing unchanged text in HEX format must not create an edit.** Hex rounding changes
  the OKLCH value, so `ColorField` commits only when the text differs from the formatted
  value. Test: Task 5.
- **Sweeping the hue must not ratchet chroma down.** Changing hue keeps `c`, even when the
  color leaves the gamut, which shows as clipped. Test: Task 6.
- **Reopening the popover on another swatch must not clear the selection.** Light dismiss
  fires `toggle` after the new swatch's click. Only clear when the popover is truly closed.
  Test: Task 10's browser verification.
- **Ratios near a threshold must be truncated without float error.** 1.15 must show `1.15:1`
  and 2.999 must show `2.99:1`. Test: Task 2.
- **A hue that rounds to 360 must format as 0.** Test: Task 1.

---

## File Map

| File                                                  | Responsibility                                          | Task |
| ----------------------------------------------------- | ------------------------------------------------------- | ---- |
| `packages/color/package.json`, `tsconfig.json`        | New workspace package                                   | 1    |
| `packages/color/src/oklch.ts` (+test)                 | Conversions, parse, format, sameColor                   | 1    |
| `packages/color/src/gamut.ts` (+test)                 | maxChroma, cusp                                         | 2    |
| `packages/color/src/contrast.ts` (+test)              | WCAG ratio, thresholds, formatting                      | 2    |
| `packages/color/src/index.ts`                         | Public exports                                          | 1, 2, 8, 11 |
| `packages/visuals/src/ui/color/geometry.ts` (+test)   | Plane, hue, grid, popover and scrub geometry            | 3, 9, 13 |
| `packages/visuals/src/ui/color/contrast-reader.tsx` (+test) | Contrast reader view                              | 4    |
| `packages/visuals/src/ui/color/color-field.tsx` (+test) | Format select plus text input                        | 5    |
| `packages/visuals/src/ui/color/color-plane.tsx`       | L×C plane (canvas, SVG boundary, thumb)                 | 6    |
| `packages/visuals/src/ui/color/hue-strip.tsx`         | Vertical hue slider                                     | 6    |
| `packages/visuals/src/ui/color/color-popover.tsx` (+test) | Popover composition                                 | 6    |
| `packages/visuals/src/ui/color/color.css`             | All color-control styles                                | 4–15 |
| `packages/visuals/src/index.ts`, `src/styles.css`     | Exports and CSS import                                  | 4–15 |
| `apps/web/src/design-audit/color-fixture.ts`          | Chopin ramps and tokens as a `Palette`                  | 7    |
| `apps/web/src/design-audit/color.tsx`                 | Specimen                                                | 7, 10, 14, 15 |
| `apps/web/src/design-audit/inventory.ts`, `page.tsx`  | Register the specimen                                   | 7    |
| `packages/color/src/palette.ts` (+test)               | Palette types, reducer, selectors, changes              | 8, 11, 15 |
| `packages/visuals/src/ui/color/palette-grid.tsx` (+test) | Swatch grid                                          | 9    |
| `packages/visuals/src/ui/color/palette-editor.tsx`    | Grid plus anchored popover plus changes summary         | 10, 14, 15 |
| `packages/color/src/curve.ts` (+test)                 | Ramp curve generation                                   | 11   |
| `packages/visuals/src/ui/color/scrub-field.tsx`       | Drag-or-type number field                               | 12   |
| `packages/visuals/src/ui/color/chroma-graph.tsx` (+test) | Chroma current against max                           | 12   |
| `packages/visuals/src/ui/color/ramp-curve-editor.tsx` (+test) | Curve pane                                      | 12   |
| `packages/icons/src/line.tsx`, `index.ts`             | `CurveIcon`                                             | 12   |
| `packages/visuals/src/ui/color/token-list.tsx` (+test) | Token list                                             | 14   |
| `packages/visuals/src/ui/color/theme-toggle.tsx`      | Light/Dark segmented control                            | 14   |
| `Dockerfile`, `AGENTS.md`                             | Register the new workspace package                      | 1    |

## Slices and Checkpoints

| Slice | Tasks | Branch                             | Deliverable                                                     |
| ----- | ----- | ---------------------------------- | --------------------------------------------------------------- |
| 1     | 1–7   | `color-controls/1-popover`         | Color math, contrast reader and a standalone popover in the audit |
| 2     | 8–10  | `color-controls/2-palette-grid`    | Palette reducer, grid and anchored popover                      |
| 3     | 11–13 | `color-controls/3-ramp-curve`      | Curve generation and the curve pane                             |
| 4     | 14–15 | `color-controls/4-tokens-theme`    | Token list, retargeting and the Light/Dark toggle               |

Stack the branches. Create each slice's branch from the previous one. Slice 1 starts from
`worktree-noble-puzzling-pike`, which holds this plan, the spec and the reference assets.
`docs/superpowers` is gitignored, so use `git add -f` when you commit an update to this file,
such as a progress-log entry. At the end of each slice, run the **Slice checkpoint** task. It covers the full checks,
screenshots, and a progress-log entry at the bottom of this file. Push and open a PR for each
slice only if the operator has authorized pushing. Otherwise leave the stacked local branches.

---

## Slice 1: Color math, contrast and the popover

### Task 1: `@chopin/color` package with OKLCH conversions

**Files:**
- Create: `packages/color/package.json`, `packages/color/tsconfig.json`,
  `packages/color/src/index.ts`, `packages/color/src/oklch.ts`,
  `packages/color/src/oklch.test.ts`
- Modify: `Dockerfile` (after line 17), and the repository map table in `AGENTS.md`

**Interfaces:**
- Produces:
  - `type Oklch = { l: number; c: number; h: number }`
  - `type Srgb = { r: number; g: number; b: number; inGamut: boolean }` (bytes 0–255)
  - `type ColorFormat = "oklch" | "hex"`
  - `normalizeHue(h: number): number`
  - `toSrgb(value: Oklch): Srgb`
  - `toHex(value: Oklch): string`
  - `fromHex(text: string): Oklch | null`
  - `parse(text: string): Oklch | null`
  - `format(value: Oklch, form: ColorFormat): string`
  - `sameColor(a: Oklch, b: Oklch): boolean`

- [ ] **Step 1: Branch and scaffold the package**

```bash
git checkout -b color-controls/1-popover worktree-noble-puzzling-pike
mkdir -p packages/color/src
```

`packages/color/package.json`:

```json
{
	"name": "@chopin/color",
	"private": true,
	"version": "0.0.0",
	"type": "module",
	"scripts": {
		"types": "tsgo --noEmit --skipLibCheck"
	},
	"exports": {
		".": {
			"types": "./src/index.ts",
			"default": "./src/index.ts"
		}
	},
	"devDependencies": {
		"@types/bun": "catalog:bun"
	}
}
```

`packages/color/tsconfig.json`:

```json
{
	"extends": "../../tsconfig.json",
	"include": ["src"],
	"compilerOptions": {
		"lib": ["esnext"],
		"types": ["bun"]
	}
}
```

Add `COPY packages/color/package.json ./packages/color/package.json` to `Dockerfile` in the
manifest block, keeping it alphabetical before `dialect`. Add this row to the `AGENTS.md`
repository map, above `packages/dialect`:

```
| `packages/color`    | OKLCH math, WCAG contrast, and palette editing state  | none                                          |
```

Run `bun install` to link the workspace.

- [ ] **Step 2: Write the failing tests** in `packages/color/src/oklch.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { format, fromHex, normalizeHue, parse, sameColor, toHex, toSrgb } from "./oklch";

describe("toSrgb", () => {
	test("matches Chopin's documented theme hex values", () => {
		expect(toHex({ l: 0.89108, c: 0.00552, h: 95 })).toBe("#dcdbd7");
		expect(toHex({ l: 0.6681, c: 0.0105, h: 95 })).toBe("#96958e");
		expect(toHex({ l: 0.56514, c: 0.0123, h: 95 })).toBe("#78766e");
		expect(toHex({ l: 1, c: 0, h: 0 })).toBe("#ffffff");
		expect(toHex({ l: 0, c: 0, h: 0 })).toBe("#000000");
	});

	test("flags out-of-gamut colors and clamps their bytes", () => {
		let rgb = toSrgb({ l: 0.7, c: 0.3, h: 140 });
		expect(rgb.inGamut).toBe(false);
		for (let channel of [rgb.r, rgb.g, rgb.b]) {
			expect(channel).toBeGreaterThanOrEqual(0);
			expect(channel).toBeLessThanOrEqual(255);
		}
		expect(toSrgb({ l: 0.6681, c: 0.0105, h: 95 }).inGamut).toBe(true);
	});
});

describe("fromHex", () => {
	test("round-trips a theme gray", () => {
		let value = fromHex("#78766e")!;
		expect(value.l).toBeCloseTo(0.56514, 4);
		expect(value.c).toBeCloseTo(0.0123, 4);
		expect(value.h).toBeCloseTo(95.28, 1);
		expect(toHex(value)).toBe("#78766e");
	});

	test("treats near-zero chroma as achromatic", () => {
		let white = fromHex("#ffffff")!;
		expect(white.l).toBeCloseTo(1, 6);
		expect(white.c).toBe(0);
		expect(white.h).toBe(0);
	});

	test("accepts short hex and rejects anything else", () => {
		expect(toHex(fromHex("#fff")!)).toBe("#ffffff");
		expect(fromHex("#ffff")).toBeNull();
		expect(fromHex("ffffff")).toBeNull();
		expect(fromHex("#gggggg")).toBeNull();
	});
});

describe("parse", () => {
	test("reads oklch() with numbers, percentages, deg and none", () => {
		expect(parse("oklch(0.6681 0.0105 95)")).toEqual({ l: 0.6681, c: 0.0105, h: 95 });
		expect(parse("  OKLCH( 66.81%  0.0105  95deg )")).toEqual({ l: 0.6681, c: 0.0105, h: 95 });
		expect(parse("oklch(0.5 50% 30)")).toEqual({ l: 0.5, c: 0.2, h: 30 });
		expect(parse("oklch(0.5 0.1 none)")).toEqual({ l: 0.5, c: 0.1, h: 0 });
	});

	test("clamps like CSS and normalizes hue", () => {
		expect(parse("oklch(1.5 -0.1 -30)")).toEqual({ l: 1, c: 0, h: 330 });
	});

	test("delegates hex", () => {
		expect(toHex(parse("#96958E")!)).toBe("#96958e");
	});

	test("rejects alpha, var(), other functions and garbage", () => {
		for (let text of [
			"oklch(0.5 0.1 30 / 50%)",
			"oklch(var(--x) 0.1 30)",
			"rgb(1 2 3)",
			"oklch(0.5, 0.1, 30)",
			"oklch(0.5 0.1)",
			"",
			"blue",
		]) {
			expect(parse(text)).toBeNull();
		}
	});
});

describe("format", () => {
	test("writes trimmed oklch() and lowercase hex", () => {
		expect(format({ l: 0.6681, c: 0.0105, h: 95 }, "oklch")).toBe("oklch(0.6681 0.0105 95)");
		expect(format({ l: 0.123456789, c: 0.000001, h: 12.3456 }, "oklch")).toBe(
			"oklch(0.12346 0 12.35)",
		);
		expect(format({ l: 0.6681, c: 0.0105, h: 95 }, "hex")).toBe("#96958e");
	});

	test("formats a hue that rounds to 360 as 0", () => {
		expect(format({ l: 0.5, c: 0.1, h: 359.999 }, "oklch")).toBe("oklch(0.5 0.1 0)");
	});
});

describe("sameColor and normalizeHue", () => {
	test("compares within 1e-5 and ignores hue for achromatic pairs", () => {
		expect(sameColor({ l: 0.5, c: 0.1, h: 30 }, { l: 0.500001, c: 0.1, h: 30 })).toBe(true);
		expect(sameColor({ l: 0.5, c: 0.1, h: 30 }, { l: 0.5, c: 0.1, h: 31 })).toBe(false);
		expect(sameColor({ l: 0.5, c: 0, h: 30 }, { l: 0.5, c: 0.000005, h: 200 })).toBe(true);
	});

	test("wraps hue into [0, 360)", () => {
		expect(normalizeHue(-30)).toBe(330);
		expect(normalizeHue(720)).toBe(0);
		expect(normalizeHue(95)).toBe(95);
	});
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/color`
Expected: FAIL, with `Cannot find module './oklch'`.

- [ ] **Step 4: Implement** `packages/color/src/oklch.ts`:

```ts
/**
 * OKLCH ⇄ sRGB using Björn Ottosson's reference matrices.
 *
 * Everything downstream (hex, contrast, gamut) reads the clipped 8-bit result, because that
 * is what a screen shows and what a hex value in a stylesheet can express.
 */

export type Oklch = { l: number; c: number; h: number };
export type Srgb = { r: number; g: number; b: number; inGamut: boolean };
export type ColorFormat = "oklch" | "hex";

const ACHROMATIC = 1e-4;
const EQUAL = 1e-5;
const GAMUT = 1e-6;

export function normalizeHue(h: number): number {
	let value = h % 360;
	return value < 0 ? value + 360 : value + 0;
}

function linear({ l, c, h }: Oklch): [number, number, number] {
	let radians = h * Math.PI / 180;
	let a = c * Math.cos(radians);
	let b = c * Math.sin(radians);
	let long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	let medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	let short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
		-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
		-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
	];
}

function encode(value: number): number {
	return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function decode(value: number): number {
	return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function toSrgb(value: Oklch): Srgb {
	let channels = linear(value).map(encode);
	let inGamut = channels.every(channel => channel >= -GAMUT && channel <= 1 + GAMUT);
	let [r, g, b] = channels.map(channel => Math.round(Math.min(1, Math.max(0, channel)) * 255));
	return { r, g, b, inGamut };
}

export function toHex(value: Oklch): string {
	let { r, g, b } = toSrgb(value);
	return `#${[r, g, b].map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

function fromBytes(r: number, g: number, b: number): Oklch {
	let [red, green, blue] = [r, g, b].map(channel => decode(channel / 255));
	let long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
	let medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
	let short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
	let l = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
	let a = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short;
	let bAxis = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short;
	let c = Math.hypot(a, bAxis);
	if (c < ACHROMATIC) return { l, c: 0, h: 0 };
	return { l, c, h: normalizeHue(Math.atan2(bAxis, a) * 180 / Math.PI) };
}

export function fromHex(text: string): Oklch | null {
	let match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
	if (!match) return null;
	let digits = match[1];
	if (digits.length === 3) digits = [...digits].map(digit => digit + digit).join("");
	return fromBytes(
		parseInt(digits.slice(0, 2), 16),
		parseInt(digits.slice(2, 4), 16),
		parseInt(digits.slice(4, 6), 16),
	);
}

const OKLCH = /^oklch\(\s*([^\s/,()]+)\s+([^\s/,()]+)\s+([^\s/,()]+)\s*\)$/i;
const NUMBER = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg)?$/i;

function channel(token: string, percent: number | null, degrees: boolean): number | null {
	if (token.toLowerCase() === "none") return 0;
	let match = NUMBER.exec(token);
	if (!match) return null;
	let value = Number(match[1]);
	let unit = match[2]?.toLowerCase();
	if (unit === "%") return percent === null ? null : value / 100 * percent;
	if (unit === "deg" && !degrees) return null;
	return Number.isFinite(value) ? value : null;
}

export function parse(text: string): Oklch | null {
	let trimmed = text.trim();
	if (trimmed.startsWith("#")) return fromHex(trimmed);
	let match = OKLCH.exec(trimmed);
	if (!match) return null;
	let l = channel(match[1], 1, false);
	let c = channel(match[2], 0.4, false);
	let h = channel(match[3], null, true);
	if (l === null || c === null || h === null) return null;
	return { l: Math.min(1, Math.max(0, l)), c: Math.max(0, c), h: normalizeHue(h) };
}

function trim(value: number, digits: number): string {
	return String(Number(value.toFixed(digits)) + 0);
}

export function format(value: Oklch, form: ColorFormat): string {
	if (form === "hex") return toHex(value);
	let hue = Number(normalizeHue(value.h).toFixed(2)) % 360;
	return `oklch(${trim(value.l, 5)} ${trim(value.c, 5)} ${trim(hue, 2)})`;
}

export function sameColor(a: Oklch, b: Oklch): boolean {
	if (Math.abs(a.l - b.l) > EQUAL || Math.abs(a.c - b.c) > EQUAL) return false;
	if (a.c < ACHROMATIC && b.c < ACHROMATIC) return true;
	let delta = Math.abs(normalizeHue(a.h) - normalizeHue(b.h));
	return Math.min(delta, 360 - delta) <= EQUAL;
}
```

`packages/color/src/index.ts`:

```ts
export { format, fromHex, normalizeHue, parse, sameColor, toHex, toSrgb } from "./oklch";
export type { ColorFormat, Oklch, Srgb } from "./oklch";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/color`
Expected: PASS. `fromHex("#ffffff")` gives an `l` slightly below 1, and `toBeCloseTo(1, 6)`
allows for that. Do not special-case it.

- [ ] **Step 6: Commit**

```bash
bun run fix && bun run types && bun run ci
git add packages/color Dockerfile AGENTS.md bun.lock
git commit -m "Add color package with OKLCH conversions"
```

### Task 2: Gamut and contrast

**Files:**
- Create: `packages/color/src/gamut.ts`, `packages/color/src/gamut.test.ts`,
  `packages/color/src/contrast.ts`, `packages/color/src/contrast.test.ts`
- Modify: `packages/color/src/index.ts`

**Interfaces:**
- Consumes: `toSrgb`, `Oklch`
- Produces:
  - `maxChroma(l: number, h: number): number`
  - `cusp(h: number): number`
  - `type Purpose = "graphic" | "large" | "text" | "enhanced"`
  - `PURPOSES: readonly Purpose[]`
  - `THRESHOLDS: Record<Purpose, number>`
  - `PURPOSE_LABELS: Record<Purpose, string>`
  - `luminance(value: Oklch): number`
  - `contrast(a: Oklch, b: Oklch): number`
  - `passes(ratio: number, purpose: Purpose): boolean`
  - `formatRatio(ratio: number): string`
  - `formatThreshold(purpose: Purpose): string`

- [ ] **Step 1: Write the failing tests**

`packages/color/src/gamut.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { cusp, maxChroma } from "./gamut";
import { toSrgb } from "./oklch";

describe("maxChroma", () => {
	test("finds the sRGB boundary", () => {
		expect(maxChroma(0.7, 30)).toBeCloseTo(0.1915, 3);
		expect(maxChroma(0.75, 95)).toBeCloseTo(0.154, 3);
	});

	test("is in gamut at the result and out just beyond it", () => {
		for (let [l, h] of [[0.3, 260], [0.6, 140], [0.9, 95]] as const) {
			let c = maxChroma(l, h);
			expect(toSrgb({ l, c, h }).inGamut).toBe(true);
			expect(toSrgb({ l, c: c + 0.002, h }).inGamut).toBe(false);
		}
	});

	test("collapses to zero at white and black", () => {
		expect(maxChroma(1, 0)).toBeLessThan(0.001);
		expect(maxChroma(0, 200)).toBe(0);
	});
});

test("cusp is the largest maxChroma across lightness", () => {
	expect(cusp(95)).toBeCloseTo(0.1807, 3);
});
```

`packages/color/src/contrast.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { contrast, formatRatio, formatThreshold, passes, PURPOSES, THRESHOLDS } from "./contrast";

let white = { l: 1, c: 0, h: 0 };

describe("contrast", () => {
	test("matches WCAG extremes and Chopin's grays against white", () => {
		expect(contrast(white, { l: 0, c: 0, h: 0 })).toBeCloseTo(21, 6);
		expect(contrast({ l: 0.89108, c: 0.00552, h: 95 }, white)).toBeCloseTo(1.3855, 3);
		expect(contrast({ l: 0.74029, c: 0.00856, h: 95 }, white)).toBeCloseTo(2.302, 3);
		expect(contrast({ l: 0.6681, c: 0.0105, h: 95 }, white)).toBeCloseTo(3.0058, 3);
		expect(contrast({ l: 0.56514, c: 0.0123, h: 95 }, white)).toBeCloseTo(4.5502, 3);
	});

	test("is symmetric", () => {
		let gray = { l: 0.6681, c: 0.0105, h: 95 };
		expect(contrast(gray, white)).toBe(contrast(white, gray));
	});
});

describe("thresholds", () => {
	test("compare the unrounded ratio", () => {
		expect(passes(2.9999, "graphic")).toBe(false);
		expect(passes(3, "graphic")).toBe(true);
		expect(passes(4.49, "text")).toBe(false);
		expect(THRESHOLDS.enhanced).toBe(7);
		expect(PURPOSES).toEqual(["graphic", "large", "text", "enhanced"]);
	});

	test("format ratios by truncation without float error", () => {
		expect(formatRatio(2.9999)).toBe("2.99:1");
		expect(formatRatio(1.15)).toBe("1.15:1");
		expect(formatRatio(3.0058)).toBe("3.00:1");
		expect(formatRatio(21)).toBe("21.00:1");
		expect(formatThreshold("text")).toBe("4.5:1");
		expect(formatThreshold("graphic")).toBe("3:1");
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/color`
Expected: FAIL, with the modules not found.

- [ ] **Step 3: Implement**

`packages/color/src/gamut.ts`:

```ts
import { toSrgb } from "./oklch";

/** The most chroma sRGB can show at this lightness and hue; a bisection, so ±3e-8. */
export function maxChroma(l: number, h: number): number {
	if (l <= 0 || l >= 1) return 0;
	let low = 0;
	let high = 0.5;
	for (let step = 0; step < 24; step++) {
		let middle = (low + high) / 2;
		if (toSrgb({ l, c: middle, h }).inGamut) low = middle;
		else high = middle;
	}
	return low;
}

/** The peak of the gamut boundary for one hue; sets the plane's chroma range. */
export function cusp(h: number): number {
	let peak = 0;
	for (let step = 1; step < 100; step++) peak = Math.max(peak, maxChroma(step / 100, h));
	return peak;
}
```

`packages/color/src/contrast.ts`:

```ts
import { toSrgb } from "./oklch";

import type { Oklch } from "./oklch";

export type Purpose = "graphic" | "large" | "text" | "enhanced";

export const PURPOSES: readonly Purpose[] = ["graphic", "large", "text", "enhanced"];

export const THRESHOLDS: Record<Purpose, number> = {
	graphic: 3,
	large: 3,
	text: 4.5,
	enhanced: 7,
};

export const PURPOSE_LABELS: Record<Purpose, string> = {
	graphic: "Graphics and UI",
	large: "Large text",
	text: "Body text",
	enhanced: "Enhanced text",
};

export function luminance(value: Oklch): number {
	let { r, g, b } = toSrgb(value);
	let [red, green, blue] = [r, g, b].map(channel => {
		let encoded = channel / 255;
		return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrast(a: Oklch, b: Oklch): number {
	let first = luminance(a);
	let second = luminance(b);
	return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function passes(ratio: number, purpose: Purpose): boolean {
	return ratio >= THRESHOLDS[purpose];
}

/** Truncated, never rounded: WCAG has no rounding, so 2.999 must not read as 3.00. */
export function formatRatio(ratio: number): string {
	return `${(Math.floor(ratio * 100 + 1e-9) / 100).toFixed(2)}:1`;
}

export function formatThreshold(purpose: Purpose): string {
	return `${THRESHOLDS[purpose]}:1`;
}
```

Append to `packages/color/src/index.ts`:

```ts
export {
	contrast,
	formatRatio,
	formatThreshold,
	luminance,
	passes,
	PURPOSE_LABELS,
	PURPOSES,
	THRESHOLDS,
} from "./contrast";
export type { Purpose } from "./contrast";
export { cusp, maxChroma } from "./gamut";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/color`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run fix && bun run types && bun run ci
git add packages/color
git commit -m "Add gamut boundary and WCAG contrast to color package"
```

### Task 3: Plane and hue geometry

**Files:**
- Create: `packages/visuals/src/ui/color/geometry.ts`,
  `packages/visuals/src/ui/color/geometry.test.ts`
- Modify: `packages/visuals/package.json` (add `"@chopin/color": "workspace:*"` to
  `dependencies`), and `apps/web/package.json` (add the same dependency for the specimen)

**Interfaces:**
- Consumes: `maxChroma`, `toSrgb`, `toHex`, `normalizeHue`, `Oklch`
- Produces:
  - `type Point = { x: number; y: number }`
  - `type Size = { width: number; height: number }`
  - `type Modifiers = { shiftKey?: boolean; altKey?: boolean }`
  - `planeValue(point: Point, size: Size, hue: number, range: number): Oklch`
  - `planePosition(value: Oklch, size: Size, range: number): Point`
  - `planeImage(hue: number, range: number, resolution?: number): Uint8ClampedArray`
  - `gamutPath(hue: number, range: number, size: Size, samples?: number): string`
  - `planeKey(value: Oklch, key: string, modifiers: Modifiers): Oklch | null`
  - `hueValue(y: number, height: number): number`
  - `huePosition(h: number, height: number): number`
  - `hueKey(h: number, key: string, modifiers: Modifiers): number | null`
  - `hueGradient(): string`

- [ ] **Step 1: Write the failing tests** in `packages/visuals/src/ui/color/geometry.test.ts`:

```ts
import { maxChroma, toSrgb } from "@chopin/color";
import { describe, expect, test } from "bun:test";

import {
	gamutPath,
	hueGradient,
	hueKey,
	huePosition,
	hueValue,
	planeImage,
	planeKey,
	planePosition,
	planeValue,
} from "./geometry";

let size = { width: 200, height: 200 };

describe("plane mapping", () => {
	test("maps top to white and bottom to black", () => {
		expect(planeValue({ x: 0, y: 0 }, size, 95, 0.18).l).toBe(1);
		expect(planeValue({ x: 0, y: 200 }, size, 95, 0.18).l).toBe(0);
	});

	test("uses a square-root chroma axis so neutrals are not squeezed", () => {
		let x = planePosition({ l: 0.6681, c: 0.0105, h: 95 }, size, 0.18).x;
		expect(x).toBeGreaterThan(40);
	});

	test("round-trips a point inside the gamut", () => {
		let value = { l: 0.6, c: 0.05, h: 95 };
		let point = planePosition(value, size, 0.18);
		let back = planeValue(point, size, 95, 0.18);
		expect(back.l).toBeCloseTo(0.6, 6);
		expect(back.c).toBeCloseTo(0.05, 6);
	});

	test("clamps dragged chroma to the gamut and points to the plane", () => {
		let value = planeValue({ x: 400, y: -20 }, size, 140, 0.2);
		expect(value.l).toBe(1);
		expect(value.c).toBeLessThanOrEqual(maxChroma(1, 140));
		let edge = planeValue({ x: 200, y: 100 }, size, 140, 0.2);
		expect(toSrgb(edge).inGamut).toBe(true);
	});
});

describe("plane image", () => {
	test("is opaque in gamut and transparent outside", () => {
		let pixels = planeImage(140, 0.2, 8);
		expect(pixels.length).toBe(8 * 8 * 4);
		let alpha = (x: number, y: number) => pixels[(y * 8 + x) * 4 + 3];
		expect(alpha(0, 4)).toBe(255);
		expect(alpha(7, 0)).toBe(0);
	});

	test("draws a boundary path from top to bottom", () => {
		let path = gamutPath(95, 0.18, { width: 100, height: 100 }, 4);
		expect(path.startsWith("M ")).toBe(true);
		expect(path.split(" L ").length).toBe(5);
	});
});

describe("plane keyboard", () => {
	let value = { l: 0.6, c: 0.05, h: 95 };

	test("steps chroma horizontally and lightness vertically", () => {
		expect(planeKey(value, "ArrowRight", {})!.c).toBeCloseTo(0.051, 6);
		expect(planeKey(value, "ArrowUp", {})!.l).toBeCloseTo(0.61, 6);
		expect(planeKey(value, "ArrowUp", { shiftKey: true })!.l).toBeCloseTo(0.7, 6);
		expect(planeKey(value, "ArrowLeft", { altKey: true })!.c).toBeCloseTo(0.0499, 6);
		expect(planeKey(value, "PageDown", {})!.l).toBeCloseTo(0.5, 6);
	});

	test("clamps and ignores other keys", () => {
		expect(planeKey({ l: 0.6, c: 0, h: 95 }, "ArrowLeft", {})!.c).toBe(0);
		expect(planeKey({ l: 0.995, c: 0, h: 95 }, "ArrowUp", {})!.l).toBe(1);
		expect(planeKey(value, "a", {})).toBeNull();
	});
});

describe("hue strip", () => {
	test("puts 360 at the top and 0 at the bottom", () => {
		expect(hueValue(0, 200)).toBe(360);
		expect(hueValue(200, 200)).toBe(0);
		expect(huePosition(90, 200)).toBe(150);
	});

	test("ArrowUp increases and wraps", () => {
		expect(hueKey(95, "ArrowUp", {})).toBe(96);
		expect(hueKey(95, "ArrowDown", { shiftKey: true })).toBe(85);
		expect(hueKey(359.5, "ArrowUp", {})).toBe(0.5);
		expect(hueKey(95, "Enter", {})).toBeNull();
	});

	test("paints 25 stops from bottom to top", () => {
		let gradient = hueGradient();
		expect(gradient.startsWith("linear-gradient(to top, #")).toBe(true);
		expect(gradient.match(/#[0-9a-f]{6}/g)!.length).toBe(25);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun install && bun test packages/visuals/src/ui/color`
Expected: FAIL, with `./geometry` not found.

- [ ] **Step 3: Implement** `packages/visuals/src/ui/color/geometry.ts`:

```ts
import { maxChroma, normalizeHue, toHex, toSrgb } from "@chopin/color";

import type { Oklch } from "@chopin/color";

export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Modifiers = { shiftKey?: boolean; altKey?: boolean };

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number): string {
	return String(Number(value.toFixed(2)));
}

/*
 * Chroma runs on a square-root axis. Linear, a C≈0.01 neutral sits in the first few percent
 * of a plane whose range is the hue's cusp (≈0.18), which makes grays undraggable.
 */
export function planeValue(point: Point, size: Size, hue: number, range: number): Oklch {
	let l = clamp(1 - point.y / size.height, 0, 1);
	let fraction = clamp(point.x / size.width, 0, 1);
	return { l, c: Math.min(fraction ** 2 * range, maxChroma(l, hue)), h: hue };
}

export function planePosition(value: Oklch, size: Size, range: number): Point {
	return {
		x: Math.sqrt(clamp(value.c / range, 0, 1)) * size.width,
		y: (1 - clamp(value.l, 0, 1)) * size.height,
	};
}

export function planeImage(hue: number, range: number, resolution = 96): Uint8ClampedArray {
	let pixels = new Uint8ClampedArray(resolution * resolution * 4);
	for (let y = 0; y < resolution; y++) {
		let l = 1 - (y + 0.5) / resolution;
		for (let x = 0; x < resolution; x++) {
			let rgb = toSrgb({ l, c: ((x + 0.5) / resolution) ** 2 * range, h: hue });
			let offset = (y * resolution + x) * 4;
			pixels[offset] = rgb.r;
			pixels[offset + 1] = rgb.g;
			pixels[offset + 2] = rgb.b;
			pixels[offset + 3] = rgb.inGamut ? 255 : 0;
		}
	}
	return pixels;
}

export function gamutPath(hue: number, range: number, size: Size, samples = 64): string {
	let commands: string[] = [];
	for (let index = 0; index <= samples; index++) {
		let l = 1 - index / samples;
		let point = planePosition({ l, c: maxChroma(l, hue), h: hue }, size, range);
		commands.push(`${index === 0 ? "M" : "L"} ${round(point.x)} ${round(point.y)}`);
	}
	return commands.join(" ");
}

function scale(modifiers: Modifiers): number {
	return modifiers.shiftKey ? 10 : modifiers.altKey ? 0.1 : 1;
}

export function planeKey(value: Oklch, key: string, modifiers: Modifiers): Oklch | null {
	let factor = scale(modifiers);
	let { l, c } = value;
	if (key === "ArrowLeft") c -= 0.001 * factor;
	else if (key === "ArrowRight") c += 0.001 * factor;
	else if (key === "ArrowUp") l += 0.01 * factor;
	else if (key === "ArrowDown") l -= 0.01 * factor;
	else if (key === "PageUp") l += 0.1;
	else if (key === "PageDown") l -= 0.1;
	else return null;
	l = clamp(l, 0, 1);
	return { l, c: clamp(c, 0, maxChroma(l, value.h)), h: value.h };
}

export function hueValue(y: number, height: number): number {
	return clamp(1 - y / height, 0, 1) * 360;
}

export function huePosition(h: number, height: number): number {
	return (1 - normalizeHue(h) / 360) * height;
}

export function hueKey(h: number, key: string, modifiers: Modifiers): number | null {
	let step = modifiers.shiftKey ? 10 : 1;
	if (key === "ArrowUp" || key === "ArrowRight") return normalizeHue(h + step);
	if (key === "ArrowDown" || key === "ArrowLeft") return normalizeHue(h - step);
	return null;
}

export function hueGradient(): string {
	let stops: string[] = [];
	for (let h = 0; h <= 360; h += 15) {
		stops.push(toHex({ l: 0.75, c: Math.min(0.15, maxChroma(0.75, h)), h }));
	}
	return `linear-gradient(to top, ${stops.join(", ")})`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/visuals/src/ui/color`
Expected: PASS. If `alpha(7, 0)` is opaque for hue 140 and range 0.2, the top-right corner
(L≈0.94, C≈0.19) is out of gamut and must be transparent, so the bug is in `planeImage`, not
in the test.

- [ ] **Step 5: Commit**

```bash
bun run fix && bun run types && bun run ci
git add packages/visuals apps/web/package.json bun.lock
git commit -m "Add color plane and hue geometry"
```

### Task 4: Contrast reader

**Files:**
- Create: `packages/visuals/src/ui/color/contrast-reader.tsx`,
  `packages/visuals/src/ui/color/contrast-reader.test.tsx`,
  `packages/visuals/src/ui/color/color.css`
- Modify: `packages/visuals/src/index.ts`, `packages/visuals/src/styles.css` (add
  `@import "./ui/color/color.css";`)

**Interfaces:**
- Consumes: `contrast`, `passes`, `formatRatio`, `formatThreshold`, `PURPOSES`,
  `PURPOSE_LABELS`, `toHex`, and `IconLabel` from `../icon-label`
- Produces:
  - `type ContrastOption = { id: string; label: string; value: Oklch }`
  - `type ContrastReaderProps = { value: Oklch; previous?: Oklch; against: string; options: readonly ContrastOption[]; onAgainstChange(id: string): void; purpose: Purpose; onPurposeChange(purpose: Purpose): void }`
  - `ContrastReader(props): JSX.Element`

- [ ] **Step 1: Write the failing test** in `contrast-reader.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ContrastReader } from "./contrast-reader";

let options = [
	{ id: "page", label: "Page", value: { l: 1, c: 0, h: 0 } },
	{ id: "ground", label: "Ground", value: { l: 0.96623, c: 0.0039, h: 95 } },
];

function render(props: Partial<Parameters<typeof ContrastReader>[0]> = {}) {
	return renderToStaticMarkup(
		<ContrastReader
			against="page"
			onAgainstChange={() => {}}
			onPurposeChange={() => {}}
			options={options}
			purpose="graphic"
			value={{ l: 0.6681, c: 0.0105, h: 95 }}
			{...props}
		/>,
	);
}

describe("ContrastReader", () => {
	test("shows the ratio and a passing verdict once", () => {
		let markup = render();
		expect(markup).toContain("3.00:1");
		expect(markup).toContain("Meets 3:1");
		expect(markup).toContain('data-tone="success"');
		expect(markup.match(/3\.00:1/g)!.length).toBe(1);
	});

	test("fails body text with the danger tone", () => {
		let markup = render({ purpose: "text" });
		expect(markup).toContain("Below 4.5:1");
		expect(markup).toContain('data-tone="danger"');
	});

	test("shows the previous ratio only when it differs", () => {
		expect(render({ previous: { l: 0.6681, c: 0.0105, h: 95 } })).not.toContain("was ");
		expect(render({ previous: { l: 0.74029, c: 0.00856, h: 95 } })).toContain("was 2.30:1");
	});

	test("falls back to the first option when the background id is unknown", () => {
		expect(render({ against: "missing" })).toContain("3.00:1");
	});

	test("renders a dash without any background options", () => {
		let markup = render({ options: [] });
		expect(markup).toContain("—");
		expect(markup).not.toContain("Meets");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/visuals/src/ui/color/contrast-reader.test.tsx`
Expected: FAIL, with the module not found.

- [ ] **Step 3: Implement** `contrast-reader.tsx`:

```tsx
import {
	contrast,
	formatRatio,
	formatThreshold,
	passes,
	PURPOSE_LABELS,
	PURPOSES,
	toHex,
} from "@chopin/color";
import { CheckIcon, WarningIcon } from "@chopin/icons";
import { useEffect, useId, useRef, useState } from "react";

import { IconLabel } from "../icon-label";

import type { Oklch, Purpose } from "@chopin/color";

export type ContrastOption = { id: string; label: string; value: Oklch };

export type ContrastReaderProps = {
	value: Oklch;
	previous?: Oklch;
	against: string;
	options: readonly ContrastOption[];
	onAgainstChange(id: string): void;
	purpose: Purpose;
	onPurposeChange(purpose: Purpose): void;
};

export function ContrastReader({
	value,
	previous,
	against,
	options,
	onAgainstChange,
	purpose,
	onPurposeChange,
}: ContrastReaderProps) {
	let id = useId();
	let background = options.find(option => option.id === against) ?? options[0];
	let ratio = background ? contrast(value, background.value) : null;
	let pass = ratio !== null && passes(ratio, purpose);
	let threshold = formatThreshold(purpose);
	let was = previous && background ? formatRatio(contrast(previous, background.value)) : null;
	let shown = ratio === null ? "—" : formatRatio(ratio);
	let message = ratio === null ? "" : `Contrast ${shown}, ${pass ? "meets" : "below"} ${threshold}`;

	// Announce after the value settles, so dragging does not flood a screen reader.
	let [announcement, setAnnouncement] = useState("");
	let first = useRef(message);
	useEffect(() => {
		if (message === first.current) return;
		let timer = setTimeout(() => setAnnouncement(message), 500);
		return () => clearTimeout(timer);
	}, [message]);

	return (
		<section aria-label="Contrast" className="cv-contrast">
			<div className="cv-contrast-reading">
				<strong className="cv-contrast-ratio">{shown}</strong>
				{ratio !== null && (
					<IconLabel
						icon={pass ? CheckIcon : WarningIcon}
						label={`${pass ? "Meets" : "Below"} ${threshold}`}
						tone={pass ? "success" : "danger"}
					/>
				)}
			</div>
			{was && was !== shown && <p className="cv-contrast-was">was {was}</p>}
			<div className="cv-contrast-controls">
				<label className="cv-contrast-control">
					<span>Purpose</span>
					<select
						onChange={event => onPurposeChange(event.target.value.slice(id.length + 1) as Purpose)}
						value={`${id}-${purpose}`}
					>
						{PURPOSES.map(item => (
							<option key={item} value={`${id}-${item}`}>
								{PURPOSE_LABELS[item]} · {formatThreshold(item)}
							</option>
						))}
					</select>
				</label>
				{background && (
					<label className="cv-contrast-control">
						<span>Against</span>
						<span className="cv-contrast-against">
							<span
								aria-hidden="true"
								className="cv-contrast-swatch"
								style={{ background: toHex(background.value) }}
							/>
							<select
								onChange={event => onAgainstChange(event.target.value.slice(id.length + 1))}
								value={`${id}-${background.id}`}
							>
								{options.map(option => (
									<option key={option.id} value={`${id}-${option.id}`}>
										{option.label}
									</option>
								))}
							</select>
						</span>
					</label>
				)}
			</div>
			<span aria-live="polite" className="cv-visually-hidden">{announcement}</span>
		</section>
	);
}
```

Start `color.css` with the shared helpers and the reader styles, using theme tokens only:

```css
.cv-visually-hidden {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
}

.cv-contrast {
	display: grid;
	gap: calc(var(--spacing) * 2);
}

.cv-contrast-reading {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: calc(var(--spacing) * 3);
}

.cv-contrast-ratio {
	font-size: var(--text-xl);
	font-variant-numeric: tabular-nums;
	font-weight: 650;
	letter-spacing: -0.03em;
}

.cv-contrast-was {
	margin: 0;
	color: var(--color-text-tertiary);
	font-size: var(--text-sm);
	font-variant-numeric: tabular-nums;
}

.cv-contrast-controls {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: calc(var(--spacing) * 2);
}

.cv-contrast-control {
	display: grid;
	gap: calc(var(--spacing) * 1);
	min-width: 0;
	color: var(--color-text-tertiary);
	font-size: var(--text-sm);
}

.cv-contrast-against {
	display: flex;
	align-items: center;
	gap: calc(var(--spacing) * 1.5);
	min-width: 0;
}

.cv-contrast-swatch {
	flex: 0 0 auto;
	width: calc(var(--spacing) * 4);
	height: calc(var(--spacing) * 4);
	border-radius: var(--radius-sm);
	box-shadow: inset 0 0 0 1px var(--color-control-boundary);
}
```

Style the `<select>` elements to match Chopin's existing controls. Look at how
`apps/web/src/design-audit/controls.tsx` renders native selects, and reuse the same tokens.

Export from `packages/visuals/src/index.ts`:

```ts
export { ContrastReader } from "./ui/color/contrast-reader";
export type { ContrastOption, ContrastReaderProps } from "./ui/color/contrast-reader";
```

Add `"@chopin/icons"` only if it is missing. It is already a dependency of visuals.

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/visuals`
Expected: PASS, including the existing sparkline and icon-label tests.

- [ ] **Step 5: Commit**

```bash
bun run fix && bun run types && bun run ci
git add packages/visuals
git commit -m "Add WCAG contrast reader"
```

### Task 5: Color field

**Files:**
- Create: `packages/visuals/src/ui/color/color-field.tsx`,
  `packages/visuals/src/ui/color/color-field.test.tsx`
- Modify: `color.css`, `packages/visuals/src/index.ts`

**Interfaces:**
- Consumes: `parse`, `format`, `sameColor`, `toSrgb`, `ColorFormat`
- Produces:
  - `type ColorFieldProps = { value: Oklch; onChange(value: Oklch): void; format: ColorFormat; onFormatChange(format: ColorFormat): void }`
  - `ColorField(props)`
  - `commitText(text: string, shown: string, value: Oklch): { value: Oklch | null; invalid: boolean }`,
    exported for tests

- [ ] **Step 1: Write the failing test** in `color-field.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ColorField, commitText } from "./color-field";

let gray = { l: 0.6681, c: 0.0105, h: 95 };

describe("commitText", () => {
	test("does not emit when the text is unchanged, even in lossy hex", () => {
		expect(commitText("#96958e", "#96958e", gray)).toEqual({ value: null, invalid: false });
	});

	test("emits a parsed change", () => {
		expect(commitText("oklch(0.7 0.0105 95)", "oklch(0.6681 0.0105 95)", gray)).toEqual({
			value: { l: 0.7, c: 0.0105, h: 95 },
			invalid: false,
		});
	});

	test("does not emit an equivalent value written differently", () => {
		expect(commitText("oklch(66.81% 0.0105 95deg)", "oklch(0.6681 0.0105 95)", gray).value)
			.toBeNull();
	});

	test("marks garbage invalid without emitting", () => {
		expect(commitText("nope", "oklch(0.6681 0.0105 95)", gray)).toEqual({
			value: null,
			invalid: true,
		});
	});
});

describe("ColorField", () => {
	test("renders the formatted value and a unique format select", () => {
		let markup = renderToStaticMarkup(
			<ColorField format="oklch" onChange={() => {}} onFormatChange={() => {}} value={gray} />,
		);
		expect(markup).toContain('value="oklch(0.6681 0.0105 95)"');
		expect(markup).toContain(">OKLCH<");
		expect(markup).toContain(">HEX<");
		expect(markup).not.toContain("Outside sRGB");
	});

	test("flags out-of-gamut values", () => {
		let markup = renderToStaticMarkup(
			<ColorField
				format="hex"
				onChange={() => {}}
				onFormatChange={() => {}}
				value={{ l: 0.7, c: 0.3, h: 140 }}
			/>,
		);
		expect(markup).toContain("Outside sRGB, shown clipped");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/visuals/src/ui/color/color-field.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** `color-field.tsx`:

```tsx
import { format, parse, sameColor, toSrgb } from "@chopin/color";
import { useEffect, useId, useState } from "react";

import type { ColorFormat, Oklch } from "@chopin/color";

export type ColorFieldProps = {
	value: Oklch;
	onChange(value: Oklch): void;
	format: ColorFormat;
	onFormatChange(format: ColorFormat): void;
};

/*
 * Unchanged text never commits. Hex is lossy, so re-parsing the displayed hex would turn a
 * blur into an edit that nobody made.
 */
export function commitText(
	text: string,
	shown: string,
	value: Oklch,
): { value: Oklch | null; invalid: boolean } {
	if (text.trim() === shown) return { value: null, invalid: false };
	let parsed = parse(text);
	if (!parsed) return { value: null, invalid: true };
	return { value: sameColor(parsed, value) ? null : parsed, invalid: false };
}

export function ColorField({ value, onChange, format: form, onFormatChange }: ColorFieldProps) {
	let id = useId();
	let shown = format(value, form);
	let [text, setText] = useState(shown);
	let [editing, setEditing] = useState(false);
	let [invalid, setInvalid] = useState(false);

	useEffect(() => {
		if (editing) return;
		setText(shown);
		setInvalid(false);
	}, [shown, editing]);

	function commit() {
		let result = commitText(text, shown, value);
		setInvalid(result.invalid);
		if (result.invalid) return;
		setEditing(false);
		if (result.value) onChange(result.value);
		else setText(shown);
	}

	return (
		<div className="cv-color-field">
			<div className="cv-color-field-row">
				<select
					aria-label="Color format"
					onChange={event => onFormatChange(event.target.value.slice(id.length + 1) as ColorFormat)}
					value={`${id}-${form}`}
				>
					<option value={`${id}-oklch`}>OKLCH</option>
					<option value={`${id}-hex`}>HEX</option>
				</select>
				<input
					aria-invalid={invalid || undefined}
					aria-label="Color value"
					onBlur={commit}
					onChange={event => {
						setEditing(true);
						setText(event.target.value);
					}}
					onKeyDown={event => {
						if (event.key === "Enter") commit();
						if (event.key === "Escape") {
							setEditing(false);
							setInvalid(false);
							setText(shown);
						}
					}}
					spellCheck={false}
					value={text}
				/>
			</div>
			{!toSrgb(value).inGamut && <p className="cv-color-field-note">Outside sRGB, shown clipped</p>}
		</div>
	);
}
```

In `color.css`:
- `.cv-color-field-row` is a flex row. The select has a fixed width; the input fills the rest
  and uses `font-variant-numeric: tabular-nums`.
- `[aria-invalid="true"]` gets a `--color-destructive` boundary.
- `.cv-color-field-note` uses `--color-warning` at `--text-sm`.

Export `ColorField` and `ColorFieldProps` from `index.ts`.

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/visuals`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
bun run fix && bun run types && bun run ci
git add packages/visuals
git commit -m "Add color field with lossless commit"
```

### Task 6: Plane, hue strip and popover composition

**Files:**
- Create: `packages/visuals/src/ui/color/color-plane.tsx`,
  `packages/visuals/src/ui/color/hue-strip.tsx`,
  `packages/visuals/src/ui/color/color-popover.tsx`,
  `packages/visuals/src/ui/color/color-popover.test.tsx`
- Modify: `color.css`, `index.ts`

**Interfaces:**
- Consumes: the geometry functions from Task 3, `ColorField` from Task 5, `ContrastReader`
  from Task 4, and `cusp`, `toHex` and `sameColor`
- Produces:
  - `ColorPlane({ value, onChange, label? })`
  - `HueStrip({ value: Oklch, onChange(h: number) })`
  - `type ColorPopoverProps = Omit<ComponentProps<"section">, "onChange" | "title"> & { title: string; value: Oklch; previous: Oklch; onChange(value: Oklch): void; contrast: Omit<ContrastReaderProps, "value" | "previous">; actions?: ReactNode }`
  - `ColorPopover(props)`
  - `withHue(value: Oklch, h: number): Oklch`, exported for tests

- [ ] **Step 1: Write the failing test** in `color-popover.test.tsx`:

```tsx
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ColorPopover, withHue } from "./color-popover";

let gray = { l: 0.6681, c: 0.0105, h: 95 };
let contrast = {
	against: "page",
	onAgainstChange() {},
	onPurposeChange() {},
	options: [{ id: "page", label: "Page", value: { l: 1, c: 0, h: 0 } }],
	purpose: "graphic" as const,
};

describe("withHue", () => {
	test("keeps chroma when a hue sweep leaves the gamut", () => {
		let vivid = { l: 0.7, c: 0.19, h: 30 };
		expect(withHue(vivid, 140)).toEqual({ l: 0.7, c: 0.19, h: 140 });
		expect(withHue(withHue(vivid, 140), 30)).toEqual(vivid);
	});
});

describe("ColorPopover", () => {
	test("composes the plane, hue strip, compare bar, field and contrast", () => {
		let markup = renderToStaticMarkup(
			<ColorPopover
				contrast={contrast}
				onChange={() => {}}
				previous={{ l: 0.74029, c: 0.00856, h: 95 }}
				title="Gray 450"
				value={gray}
			/>,
		);
		expect(markup).toContain(">Gray 450<");
		expect(markup).toContain('aria-label="Lightness and chroma"');
		expect(markup).toContain('aria-valuetext="Lightness 66.8%, chroma 0.0105"');
		expect(markup).toContain('aria-label="Hue"');
		expect(markup).toContain('aria-orientation="vertical"');
		expect(markup).toContain('aria-label="Restore previous color"');
		expect(markup).toContain("3.00:1");
		expect(markup).toContain("was 2.30:1");
	});

	test("disables restore when nothing changed", () => {
		let markup = renderToStaticMarkup(
			<ColorPopover contrast={contrast} onChange={() => {}} previous={gray} title="Gray 450" value={gray} />,
		);
		expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Restore previous color"|aria-label="Restore previous color"[^>]*disabled=""/);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/visuals/src/ui/color/color-popover.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the plane** (`color-plane.tsx`):

```tsx
import { cusp, toHex } from "@chopin/color";
import { useEffect, useMemo, useRef } from "react";

import { gamutPath, planeImage, planeKey, planePosition, planeValue } from "./geometry";

import type { Oklch } from "@chopin/color";
import type { PointerEvent } from "react";

const RESOLUTION = 96;
const VIEW = { width: 100, height: 100 };

export type ColorPlaneProps = { value: Oklch; onChange(value: Oklch): void; label?: string };

export function ColorPlane({ value, onChange, label = "Lightness and chroma" }: ColorPlaneProps) {
	let canvas = useRef<HTMLCanvasElement>(null);
	let thumb = useRef<HTMLSpanElement>(null);
	let hue = value.h;
	let range = useMemo(() => cusp(hue), [hue]);
	let boundary = useMemo(() => gamutPath(hue, range, VIEW), [hue, range]);

	useEffect(() => {
		let context = canvas.current?.getContext("2d");
		if (!context) return;
		let image = new ImageData(planeImage(hue, range, RESOLUTION), RESOLUTION, RESOLUTION);
		context.putImageData(image, 0, 0);
	}, [hue, range]);

	function pick(event: PointerEvent<HTMLDivElement>) {
		let rect = event.currentTarget.getBoundingClientRect();
		let point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
		onChange(planeValue(point, rect, hue, range));
	}

	let position = planePosition(value, VIEW, range);
	return (
		<div
			className="cv-color-plane"
			onPointerDown={event => {
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				thumb.current?.focus({ preventScroll: true });
				pick(event);
			}}
			onPointerMove={event => {
				if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event);
			}}
		>
			<canvas aria-hidden="true" height={RESOLUTION} ref={canvas} width={RESOLUTION} />
			<svg aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 100">
				<path d={boundary} />
			</svg>
			<span
				aria-label={label}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={Math.round(value.l * 1000) / 10}
				aria-valuetext={`Lightness ${(value.l * 100).toFixed(1)}%, chroma ${
					Number(value.c.toFixed(4))
				}`}
				className="cv-color-plane-thumb"
				onKeyDown={event => {
					let next = planeKey(value, event.key, event);
					if (!next) return;
					event.preventDefault();
					onChange(next);
				}}
				ref={thumb}
				role="slider"
				style={{ left: `${position.x}%`, top: `${position.y}%`, background: toHex(value) }}
				tabIndex={0}
			/>
		</div>
	);
}
```

- [ ] **Step 4: Implement the hue strip** (`hue-strip.tsx`). Follow the same pointer-capture
  pattern. Build the background once at module level (`const GRADIENT = hueGradient();`) and
  set it with `style={{ backgroundImage: GRADIENT }}`.

```tsx
import { toHex } from "@chopin/color";
import { useRef } from "react";

import { hueGradient, hueKey, huePosition, hueValue } from "./geometry";

import type { Oklch } from "@chopin/color";
import type { PointerEvent } from "react";

const GRADIENT = hueGradient();

export type HueStripProps = { value: Oklch; onChange(h: number): void };

export function HueStrip({ value, onChange }: HueStripProps) {
	let thumb = useRef<HTMLSpanElement>(null);
	function pick(event: PointerEvent<HTMLDivElement>) {
		let rect = event.currentTarget.getBoundingClientRect();
		onChange(hueValue(event.clientY - rect.top, rect.height) % 360);
	}
	return (
		<div
			className="cv-hue-strip"
			onPointerDown={event => {
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				thumb.current?.focus({ preventScroll: true });
				pick(event);
			}}
			onPointerMove={event => {
				if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event);
			}}
			style={{ backgroundImage: GRADIENT }}
		>
			<span
				aria-label="Hue"
				aria-orientation="vertical"
				aria-valuemax={360}
				aria-valuemin={0}
				aria-valuenow={Math.round(value.h)}
				aria-valuetext={`${Math.round(value.h)}°`}
				className="cv-hue-strip-thumb"
				onKeyDown={event => {
					let next = hueKey(value.h, event.key, event);
					if (next === null) return;
					event.preventDefault();
					onChange(next);
				}}
				ref={thumb}
				role="slider"
				style={{ top: `${huePosition(value.h, 100)}%`, background: toHex(value) }}
				tabIndex={0}
			/>
		</div>
	);
}
```

- [ ] **Step 5: Implement the popover** (`color-popover.tsx`):

```tsx
import { sameColor, toHex } from "@chopin/color";
import { useState } from "react";

import { ColorField } from "./color-field";
import { ColorPlane } from "./color-plane";
import { ContrastReader } from "./contrast-reader";
import { HueStrip } from "./hue-strip";

import type { ColorFormat, Oklch } from "@chopin/color";
import type { ComponentProps, ReactNode } from "react";
import type { ContrastReaderProps } from "./contrast-reader";

export type ColorPopoverProps = Omit<ComponentProps<"section">, "onChange" | "title"> & {
	title: string;
	value: Oklch;
	previous: Oklch;
	onChange(value: Oklch): void;
	contrast: Omit<ContrastReaderProps, "value" | "previous">;
	actions?: ReactNode;
};

/** Hue changes keep chroma: clamping would ratchet it down on every sweep through a narrow hue. */
export function withHue(value: Oklch, h: number): Oklch {
	return { ...value, h };
}

export function ColorPopover({
	title,
	value,
	previous,
	onChange,
	contrast,
	actions,
	className,
	...props
}: ColorPopoverProps) {
	let [form, setForm] = useState<ColorFormat>("oklch");
	let changed = !sameColor(value, previous);
	return (
		<section
			{...props}
			aria-label={title}
			className={["cv-color-popover", className].filter(Boolean).join(" ")}
		>
			<header className="cv-color-popover-header">
				<h3>{title}</h3>
				{actions && <div className="cv-color-popover-actions">{actions}</div>}
			</header>
			<div className="cv-color-popover-pickers">
				<ColorPlane onChange={onChange} value={value} />
				<HueStrip onChange={h => onChange(withHue(value, h))} value={value} />
			</div>
			<div className="cv-color-compare">
				<div aria-hidden="true" className="cv-color-compare-labels">
					<span>Previous</span>
					<span>Current</span>
				</div>
				<div className="cv-color-compare-bar">
					<button
						aria-label="Restore previous color"
						disabled={!changed}
						onClick={() => onChange(previous)}
						style={{ background: toHex(previous) }}
						type="button"
					/>
					<span style={{ background: toHex(value) }} />
				</div>
			</div>
			<ColorField format={form} onChange={onChange} onFormatChange={setForm} value={value} />
			<ContrastReader {...contrast} previous={changed ? previous : undefined} value={value} />
		</section>
	);
}
```

- [ ] **Step 6: Style it** in `color.css`. Match `03-swatch-popover.png`:
  - **Panel:** `.cv-color-popover` is 320 px wide (`calc(var(--spacing) * 80)`), with a
    `--color-page` background, `--radius-xl`, `--shadow-overlay`, and
    `calc(var(--spacing) * 4)` padding and gap.
  - **Header:** a flex row. The `h3` is `--text-sm`, weight 600, `--color-text-secondary`.
  - **Pickers:** `.cv-color-popover-pickers` is a grid with columns `1fr auto`.
  - **Plane:** `aspect-ratio: 1`, `position: relative`, `touch-action: none`,
    `border-radius: var(--radius-md)`, `overflow: hidden`, and a `--color-inset` background
    that shows through the transparent pixels. The canvas fills it at `width: 100%;
    height: 100%`. The SVG is absolutely positioned over it, with
    `fill: none; stroke: var(--color-control-boundary); stroke-width: 1;
    vector-effect: non-scaling-stroke`.
  - **Thumbs:** absolutely positioned with `translate: -50% -50%`. Use a 14 px ring:
    `box-shadow: 0 0 0 2px var(--color-page), 0 0 0 3px var(--color-gray-800)`. Give them a
    visible `:focus-visible` outline using `--color-focus` if it exists; otherwise use the token
    that `apps/web/src/design-audit/controls.css` uses for focus.
  - **Hue strip:** `width: calc(var(--spacing) * 5)`, `border-radius: var(--radius-md)`, and
    `touch-action: none`. Its thumb is a horizontal pill, as in the reference.
  - **Compare bar:** `.cv-color-compare-bar` is a two-column grid, 36 px tall, with
    `--radius-md` and `overflow: hidden`. Its labels use `--text-sm` and
    `--color-text-tertiary`. A disabled Previous button uses `cursor: default`.

  Explicit transforms or `translate` avoid the Tailwind transform trap noted in AGENTS.md.

- [ ] **Step 7: Export and run the tests**

Add to `index.ts`:

```ts
export { ColorPlane } from "./ui/color/color-plane";
export { ColorPopover } from "./ui/color/color-popover";
export type { ColorPopoverProps } from "./ui/color/color-popover";
export { HueStrip } from "./ui/color/hue-strip";
```

Run: `bun test packages/visuals`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
bun run fix && bun run types && bun run ci
git add packages/visuals
git commit -m "Add OKLCH color popover"
```

### Task 7: Design audit specimen with a live sparkline preview

**Files:**
- Create: `apps/web/src/design-audit/color-fixture.ts`, `apps/web/src/design-audit/color.tsx`,
  `apps/web/src/design-audit/color.css`
- Modify: `apps/web/src/design-audit/inventory.ts` (add a `"color"` group id and items),
  `apps/web/src/design-audit/page.tsx`, and `apps/web/src/design-audit/specimens.test.tsx`

**Interfaces:**
- Consumes: `ColorPopover`, `ContrastOption` and `Sparkline` from `@chopin/visuals`, and
  `Oklch` from `@chopin/color`
- Produces:
  - `CHOPIN_PALETTE: Palette`. Slice 1 exports only the typed hue arrays, because `Palette`
    arrives in Task 8. Export `CHOPIN_LIGHT_HUES`, an array of
    `{ name, swatches: { step, value, source }[] }`.
  - `ColorControls()`, the specimen

- [ ] **Step 1: Write the fixture.** Copy every `--color-gray-*`, `--color-ruby-*`,
  `--color-orange-*` and `--color-lime-*` value from `packages/visuals/theme.css`, in declared
  order, as `{ step, value: { l, c, h }, source: "--color-gray-450" }`. Add a test in
  `specimens.test.tsx` that reads `theme.css` with `Bun.file` and asserts that every fixture
  `source` appears there with the same `oklch(...)` numbers. This stops the fixture drifting
  from the theme.

- [ ] **Step 2: Write the specimen test first** in `specimens.test.tsx`, following the
  sparkline test already there:

```tsx
it("inventories and renders the color popover specimen", () => {
	let item = AUDIT_INVENTORY.flatMap(group => group.items).find(
		candidate => candidate.id === "color-popover",
	);
	expect(item?.source).toBe("packages/visuals/src/ui/color/color-popover.tsx");
	let markup = renderToStaticMarkup(<ColorControls />);
	expect(markup).toContain('data-audit-item="color-popover"');
	expect(markup).toContain(">Gray 450<");
	expect(markup).toContain("3.00:1");
	expect(markup).toContain('role="img"');
});
```

Run `bun test apps/web/src/design-audit`. Expected: FAIL.

- [ ] **Step 3: Implement the specimen.** `ColorControls` keeps `value`, `purpose` and
  `against` in `useState`, starting from gray 450. Its background options are Page
  (`oklch(1 0 0)`), Ground (gray 150) and Inset (gray 100). Lay it out as two panels on the
  `--color-ground` background:
  - the `ColorPopover` (title "Gray 450", `previous` set to the fixture's gray 450)
  - a white preview panel with a three-row table (Document, Activity, Edits), using the lab's
    sample rows. Each Activity cell renders
    `<Sparkline label="… activity" tone="neutral" values={…} />`, and the table sets
    `style={{ "--color-neutral-graphic": toHex(value) } as CSSProperties}`, so the real
    component repaints live.

  Wrap the specimen in `AuditPlate` with `item="color-popover"`, like the sparkline plate in
  `foundations.tsx`. Add an `AuditSection id="color" title="Color controls"` to `page.tsx`, and
  add a group `{ id: "color", label: "Color controls", items: [...] }` to `AUDIT_INVENTORY`,
  widening the `AuditGroup["id"]` union. Fix any inventory or page tests that enumerate the
  groups.

- [ ] **Step 4: Run the tests**

Run: `bun test apps/web`
Expected: PASS.

- [ ] **Step 5: Verify in the browser.** Run `bun run dev` in the background, then use the
  Playwright MCP:
  1. Navigate to the dev URL printed by the supervisor, at `/design-audit#color`.
  2. Take screenshots at 1280×900 and at 390×844. Compare them against
     `03-swatch-popover.png`: the plane with its visible gamut boundary, the hue strip, the
     compare bar and the format field. No horizontal scroll at 390 px.
  3. Drag the plane thumb. The ratio and the preview sparklines update live, and the thumb stays
     inside the boundary.
  4. Focus the thumb, press ArrowUp 5 times, and confirm with a snapshot that `aria-valuetext`
     changes.
  5. Drag the hue strip from one end to the other and back. Chroma returns to its starting value.
  6. Switch the format to HEX, focus the field, and blur without typing. "was …" must not appear.
  7. Type `oklch(0.7 0.3 140)` and press Enter. "Outside sRGB, shown clipped" appears.
  8. Check the browser console for errors.

  Save screenshots to `/tmp/color-controls/slice-1-*.png`. Do not commit them.

- [ ] **Step 6: Commit**

```bash
bun run fix && bun run types && bun run ci && bun test
git add apps/web
git commit -m "Show color popover specimen with live sparkline preview"
```

### Slice 1 checkpoint

- [ ] Run `bun run types && bun test && bun run ci`. All must pass. Paste the summary lines into
  the progress log.
- [ ] Load `superpowers:requesting-code-review` and review the slice against the spec sections
  "Color math" and "Color popover". Fix confirmed findings.
- [ ] Add a progress-log entry at the bottom of this file: the branch, the commits, the
  screenshot paths, and any deviation from the plan and why.
- [ ] If pushing is authorized, run `git push -u origin color-controls/1-popover` and open a PR
  titled "Add OKLCH color popover and contrast reader". The body ends with
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Slice 2: Palette state, grid and the anchored popover

### Task 8: Palette state reducer

**Files:**
- Create: `packages/color/src/palette.ts`, `packages/color/src/palette.test.ts`
- Modify: `packages/color/src/index.ts`

**Interfaces:**
- Consumes: `Oklch`, `sameColor`
- Produces:

```ts
export type Theme = "light" | "dark";
export type SwatchRef = { hue: string; step: string };
export type Swatch = { step: string; value: Oklch; source?: string };
export type Hue = { name: string; swatches: Swatch[] };
export type Token = { name: string; group?: string; ref: SwatchRef; source?: string };
export type Palette = {
	themes: { light: Hue[]; dark?: Hue[] };
	surfaces?: Partial<Record<Theme, Oklch>>;
	tokens?: Token[];
};
export type Edits = Record<string, Record<string, Oklch>>; // hue → step → value
export type PaletteState = {
	palette: Palette;
	theme: Theme;
	edits: Record<Theme, Edits>;
	selected: SwatchRef | null;
};
export type PaletteAction =
	| { type: "select"; ref: SwatchRef | null }
	| { type: "edit"; ref: SwatchRef; value: Oklch }
	| { type: "reset"; ref: SwatchRef }
	| { type: "resetRow"; hue: string }
	| { type: "resetAll" }
	| { type: "theme"; theme: Theme };
export type SwatchChange = { kind: "swatch"; theme: Theme; ref: SwatchRef; before: Oklch; after: Oklch };
export type Change = SwatchChange;
export type GridCell = { ref: SwatchRef; step: string; value: Oklch; edited: boolean; selected: boolean };
export type GridRow = { name: string; cells: GridCell[] };

export function createPaletteState(palette: Palette): PaletteState;
export function paletteReducer(state: PaletteState, action: PaletteAction): PaletteState;
export function activeHues(state: PaletteState): Hue[];
export function baseValue(state: PaletteState, ref: SwatchRef): Oklch | null;
export function currentValue(state: PaletteState, ref: SwatchRef): Oklch | null;
export function isEdited(state: PaletteState, ref: SwatchRef): boolean;
export function surface(state: PaletteState): Oklch;
export function gridRows(state: PaletteState): GridRow[];
export function sharedSteps(rows: readonly GridRow[]): string[] | null;
export function changes(state: PaletteState): Change[];
```

- [ ] **Step 1: Branch**

```bash
git checkout -b color-controls/2-palette-grid color-controls/1-popover
```

- [ ] **Step 2: Write the failing tests** in `packages/color/src/palette.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import {
	baseValue,
	changes,
	createPaletteState,
	currentValue,
	gridRows,
	isEdited,
	paletteReducer,
	sharedSteps,
	surface,
} from "./palette";

import type { Palette } from "./palette";

let g450 = { l: 0.6681, c: 0.0105, h: 95 };
let palette: Palette = {
	themes: {
		light: [
			{
				name: "gray",
				swatches: [
					{ step: "400", value: { l: 0.74029, c: 0.00856, h: 95 } },
					{ step: "450", value: g450, source: "--color-gray-450" },
				],
			},
			{ name: "a/b", swatches: [{ step: "1", value: { l: 0.9, c: 0.05, h: 30 } }] },
		],
		dark: [{ name: "gray", swatches: [{ step: "400", value: { l: 0.3, c: 0.01, h: 95 } }] }],
	},
};
let ref = { hue: "gray", step: "450" };

describe("createPaletteState", () => {
	test("starts clean on the light theme", () => {
		let state = createPaletteState(palette);
		expect(state.theme).toBe("light");
		expect(state.selected).toBeNull();
		expect(changes(state)).toEqual([]);
	});

	test("rejects duplicate hues and duplicate steps loudly", () => {
		let hue = { name: "gray", swatches: [{ step: "1", value: g450 }] };
		expect(() => createPaletteState({ themes: { light: [hue, hue] } })).toThrow(
			'Duplicate hue "gray" in light theme',
		);
		expect(() =>
			createPaletteState({ themes: { light: [{ name: "x", swatches: [hue.swatches[0], hue.swatches[0]] }] } })
		).toThrow('Duplicate step "1" in hue "x" (light theme)');
	});
});

describe("paletteReducer", () => {
	test("edits without touching the base", () => {
		let next = { l: 0.64, c: 0.0105, h: 95 };
		let state = paletteReducer(createPaletteState(palette), { type: "edit", ref, value: next });
		expect(currentValue(state, ref)).toEqual(next);
		expect(baseValue(state, ref)).toEqual(g450);
		expect(palette.themes.light[0].swatches[1].value).toEqual(g450);
		expect(isEdited(state, ref)).toBe(true);
	});

	test("an edit back to the base value removes the edit", () => {
		let state = createPaletteState(palette);
		state = paletteReducer(state, { type: "edit", ref, value: { l: 0.64, c: 0.0105, h: 95 } });
		state = paletteReducer(state, { type: "edit", ref, value: { ...g450, l: 0.668101 } });
		expect(isEdited(state, ref)).toBe(false);
		expect(state.edits.light).toEqual({});
	});

	test("keeps hue names with slashes distinct", () => {
		let state = paletteReducer(createPaletteState(palette), {
			type: "edit",
			ref: { hue: "a/b", step: "1" },
			value: { l: 0.8, c: 0.05, h: 30 },
		});
		expect(Object.keys(state.edits.light)).toEqual(["a/b"]);
	});

	test("ignores refs that do not exist and themes that are absent", () => {
		let state = createPaletteState(palette);
		expect(paletteReducer(state, { type: "edit", ref: { hue: "nope", step: "1" }, value: g450 }))
			.toBe(state);
		let light = createPaletteState({ themes: { light: palette.themes.light } });
		expect(paletteReducer(light, { type: "theme", theme: "dark" })).toBe(light);
	});

	test("resets a swatch, a row, and everything", () => {
		let state = createPaletteState(palette);
		let other = { hue: "gray", step: "400" };
		state = paletteReducer(state, { type: "edit", ref, value: { ...g450, l: 0.6 } });
		state = paletteReducer(state, { type: "edit", ref: other, value: { ...g450, l: 0.7 } });
		expect(isEdited(paletteReducer(state, { type: "reset", ref }), ref)).toBe(false);
		expect(changes(paletteReducer(state, { type: "resetRow", hue: "gray" }))).toEqual([]);
		expect(changes(paletteReducer(state, { type: "resetAll" }))).toEqual([]);
	});

	test("keeps edits per theme", () => {
		let state = createPaletteState(palette);
		let dark = { hue: "gray", step: "400" };
		state = paletteReducer(state, { type: "theme", theme: "dark" });
		state = paletteReducer(state, { type: "edit", ref: dark, value: { l: 0.35, c: 0.01, h: 95 } });
		expect(changes(state)).toEqual([
			{
				kind: "swatch",
				theme: "dark",
				ref: dark,
				before: { l: 0.3, c: 0.01, h: 95 },
				after: { l: 0.35, c: 0.01, h: 95 },
			},
		]);
		state = paletteReducer(state, { type: "theme", theme: "light" });
		expect(isEdited(state, dark)).toBe(false);
	});
});

describe("selectors", () => {
	test("gridRows marks edited and selected cells", () => {
		let state = paletteReducer(createPaletteState(palette), { type: "select", ref });
		state = paletteReducer(state, { type: "edit", ref, value: { ...g450, l: 0.6 } });
		let cell = gridRows(state)[0].cells[1];
		expect(cell).toMatchObject({ step: "450", edited: true, selected: true });
	});

	test("sharedSteps only when every row has identical steps", () => {
		let state = createPaletteState(palette);
		expect(sharedSteps(gridRows(state))).toBeNull();
		let same = createPaletteState({ themes: { light: [palette.themes.light[0], { ...palette.themes.light[0], name: "blue" }] } });
		expect(sharedSteps(gridRows(same))).toEqual(["400", "450"]);
	});

	test("surface defaults to white in light and a near-black in dark", () => {
		let state = createPaletteState(palette);
		expect(surface(state)).toEqual({ l: 1, c: 0, h: 0 });
		expect(surface(paletteReducer(state, { type: "theme", theme: "dark" }))).toEqual({
			l: 0.159,
			c: 0.006,
			h: 95,
		});
	});
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bun test packages/color/src/palette.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement** `packages/color/src/palette.ts`. Required behavior:
  - `createPaletteState` validates each theme with a `Set` of hue names and, per hue, a `Set`
    of steps. It throws the exact messages in the tests.
  - `findSwatch(hues, ref)` is a private helper returning `Swatch | undefined`.
  - `withEdit(edits, ref, value | undefined): Edits` returns a new object. When a hue's step
    map becomes empty, the hue key is deleted.
  - `edit` looks up the base value in the **active theme**. If it is missing, return `state`
    unchanged. If `sameColor(value, base)`, remove the edit; otherwise set it.
  - `theme` returns `state` unchanged when the target theme has no hues. It clears `selected`
    whenever the theme actually changes.
  - `resetAll` clears both themes.
  - `select` stores the ref as given.
  - `changes` walks `palette.themes` in order (light, then dark), then hues and swatches in
    declared order, so the output is stable.
  - `DEFAULT_SURFACES = { light: { l: 1, c: 0, h: 0 }, dark: { l: 0.159, c: 0.006, h: 95 } }`.

```ts
import { sameColor } from "./oklch";

import type { Oklch } from "./oklch";

// ...types from the Interfaces block above...

const DEFAULT_SURFACES: Record<Theme, Oklch> = {
	light: { l: 1, c: 0, h: 0 },
	dark: { l: 0.159, c: 0.006, h: 95 },
};

function validate(hues: readonly Hue[], theme: Theme) {
	let names = new Set<string>();
	for (let hue of hues) {
		if (names.has(hue.name)) throw new Error(`Duplicate hue "${hue.name}" in ${theme} theme`);
		names.add(hue.name);
		let steps = new Set<string>();
		for (let swatch of hue.swatches) {
			if (steps.has(swatch.step)) {
				throw new Error(`Duplicate step "${swatch.step}" in hue "${hue.name}" (${theme} theme)`);
			}
			steps.add(swatch.step);
		}
	}
}

export function createPaletteState(palette: Palette): PaletteState {
	validate(palette.themes.light, "light");
	if (palette.themes.dark) validate(palette.themes.dark, "dark");
	return { palette, theme: "light", edits: { light: {}, dark: {} }, selected: null };
}

function huesOf(palette: Palette, theme: Theme): Hue[] {
	return (theme === "dark" ? palette.themes.dark : palette.themes.light) ?? [];
}

export function activeHues(state: PaletteState): Hue[] {
	return huesOf(state.palette, state.theme);
}

function findSwatch(hues: readonly Hue[], ref: SwatchRef): Swatch | undefined {
	return hues.find(hue => hue.name === ref.hue)?.swatches.find(swatch => swatch.step === ref.step);
}

function withEdit(edits: Edits, ref: SwatchRef, value: Oklch | undefined): Edits {
	let steps = { ...edits[ref.hue] };
	if (value) steps[ref.step] = value;
	else delete steps[ref.step];
	let next = { ...edits };
	if (Object.keys(steps).length) next[ref.hue] = steps;
	else delete next[ref.hue];
	return next;
}

export function paletteReducer(state: PaletteState, action: PaletteAction): PaletteState {
	switch (action.type) {
		case "select":
			return { ...state, selected: action.ref };
		case "edit": {
			let base = findSwatch(activeHues(state), action.ref);
			if (!base) return state;
			let value = sameColor(action.value, base.value) ? undefined : action.value;
			let edits = withEdit(state.edits[state.theme], action.ref, value);
			return { ...state, edits: { ...state.edits, [state.theme]: edits } };
		}
		case "reset": {
			let edits = withEdit(state.edits[state.theme], action.ref, undefined);
			return { ...state, edits: { ...state.edits, [state.theme]: edits } };
		}
		case "resetRow": {
			let edits = { ...state.edits[state.theme] };
			delete edits[action.hue];
			return { ...state, edits: { ...state.edits, [state.theme]: edits } };
		}
		case "resetAll":
			return { ...state, edits: { light: {}, dark: {} } };
		case "theme":
			if (action.theme === state.theme || !huesOf(state.palette, action.theme).length) return state;
			return { ...state, theme: action.theme, selected: null };
	}
}

export function baseValue(state: PaletteState, ref: SwatchRef): Oklch | null {
	return findSwatch(activeHues(state), ref)?.value ?? null;
}

export function currentValue(state: PaletteState, ref: SwatchRef): Oklch | null {
	return state.edits[state.theme][ref.hue]?.[ref.step] ?? baseValue(state, ref);
}

export function isEdited(state: PaletteState, ref: SwatchRef): boolean {
	return Boolean(state.edits[state.theme][ref.hue]?.[ref.step]);
}

export function surface(state: PaletteState): Oklch {
	return state.palette.surfaces?.[state.theme] ?? DEFAULT_SURFACES[state.theme];
}

export function gridRows(state: PaletteState): GridRow[] {
	return activeHues(state).map(hue => ({
		name: hue.name,
		cells: hue.swatches.map(swatch => {
			let ref = { hue: hue.name, step: swatch.step };
			return {
				ref,
				step: swatch.step,
				value: currentValue(state, ref)!,
				edited: isEdited(state, ref),
				selected: state.selected?.hue === hue.name && state.selected.step === swatch.step,
			};
		}),
	}));
}

export function sharedSteps(rows: readonly GridRow[]): string[] | null {
	if (!rows.length) return null;
	let steps = rows[0].cells.map(cell => cell.step);
	let same = rows.every(row =>
		row.cells.length === steps.length && row.cells.every((cell, index) => cell.step === steps[index])
	);
	return same && steps.length ? steps : null;
}

export function changes(state: PaletteState): Change[] {
	let found: Change[] = [];
	for (let theme of ["light", "dark"] as const) {
		for (let hue of huesOf(state.palette, theme)) {
			for (let swatch of hue.swatches) {
				let after = state.edits[theme][hue.name]?.[swatch.step];
				if (after) {
					found.push({
						kind: "swatch",
						theme,
						ref: { hue: hue.name, step: swatch.step },
						before: swatch.value,
						after,
					});
				}
			}
		}
	}
	return found;
}
```

Export all of the above types and functions from `packages/color/src/index.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/color`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
bun run fix && bun run types && bun run ci
git add packages/color
git commit -m "Add palette editing state"
```

### Task 9: Palette grid

**Files:**
- Create: `packages/visuals/src/ui/color/palette-grid.tsx`,
  `packages/visuals/src/ui/color/palette-grid.test.tsx`
- Modify: `geometry.ts` and `geometry.test.ts` (add `gridMove` and `placePopover`),
  `color.css`, `index.ts`

**Interfaces:**
- Consumes: `GridRow`, `SwatchRef`, `sharedSteps`, `format`, `toHex` and `contrast`
- Produces:
  - `type GridPosition = { row: number; index: number }`
  - `gridMove(lengths: readonly number[], at: GridPosition, key: string): GridPosition | null`
  - `type Box = { left: number; top: number; width: number; height: number }`
  - `placePopover(anchor: Box, size: Size, viewport: Box, margin?: number, gap?: number): { left: number; top: number; side: "below" | "above" }`
  - `type PaletteGridProps = { rows: readonly GridRow[]; onActivate(ref: SwatchRef, anchor: HTMLElement): void }`
  - `PaletteGrid(props)`

- [ ] **Step 1: Write the failing geometry tests.** Append to `geometry.test.ts`:

```ts
import { gridMove, placePopover } from "./geometry";

describe("gridMove", () => {
	let lengths = [13, 12, 12];

	test("moves within a row without wrapping", () => {
		expect(gridMove(lengths, { row: 0, index: 0 }, "ArrowRight")).toEqual({ row: 0, index: 1 });
		expect(gridMove(lengths, { row: 0, index: 12 }, "ArrowRight")).toEqual({ row: 0, index: 12 });
		expect(gridMove(lengths, { row: 0, index: 0 }, "ArrowLeft")).toEqual({ row: 0, index: 0 });
		expect(gridMove(lengths, { row: 1, index: 5 }, "End")).toEqual({ row: 1, index: 11 });
		expect(gridMove(lengths, { row: 1, index: 5 }, "Home")).toEqual({ row: 1, index: 0 });
	});

	test("maps proportionally between rows of different length", () => {
		expect(gridMove(lengths, { row: 0, index: 12 }, "ArrowDown")).toEqual({ row: 1, index: 11 });
		expect(gridMove(lengths, { row: 1, index: 11 }, "ArrowUp")).toEqual({ row: 0, index: 12 });
		expect(gridMove(lengths, { row: 2, index: 3 }, "ArrowDown")).toEqual({ row: 2, index: 3 });
		expect(gridMove([1, 5], { row: 0, index: 0 }, "ArrowDown")).toEqual({ row: 1, index: 0 });
	});

	test("skips empty rows and ignores other keys", () => {
		expect(gridMove([3, 0, 3], { row: 0, index: 1 }, "ArrowDown")).toEqual({ row: 2, index: 1 });
		expect(gridMove(lengths, { row: 0, index: 0 }, "Tab")).toBeNull();
	});
});

describe("placePopover", () => {
	let viewport = { left: 0, top: 0, width: 1000, height: 800 };
	let size = { width: 320, height: 500 };

	test("centres below the anchor", () => {
		expect(placePopover({ left: 400, top: 100, width: 60, height: 40 }, size, viewport)).toEqual({
			left: 270,
			top: 148,
			side: "below",
		});
	});

	test("flips above when there is no room below", () => {
		let placed = placePopover({ left: 400, top: 700, width: 60, height: 40 }, size, viewport);
		expect(placed).toEqual({ left: 270, top: 192, side: "above" });
	});

	test("clamps to the viewport with a 16px margin", () => {
		expect(placePopover({ left: 0, top: 100, width: 40, height: 40 }, size, viewport).left).toBe(16);
		let narrow = { left: 0, top: 0, width: 300, height: 800 };
		expect(placePopover({ left: 100, top: 100, width: 40, height: 40 }, size, narrow).left).toBe(16);
	});

	test("chooses the roomier side when neither fits", () => {
		let short = { left: 0, top: 0, width: 1000, height: 400 };
		expect(placePopover({ left: 400, top: 300, width: 60, height: 40 }, size, short).side).toBe("above");
		expect(placePopover({ left: 400, top: 40, width: 60, height: 40 }, size, short).side).toBe("below");
	});
});
```

- [ ] **Step 2: Run them to verify they fail**, then implement them in `geometry.ts`:

```ts
export type GridPosition = { row: number; index: number };
export type Box = { left: number; top: number; width: number; height: number };

function project(index: number, from: number, to: number): number {
	if (to <= 1 || from <= 1) return 0;
	return Math.round(index / (from - 1) * (to - 1));
}

export function gridMove(
	lengths: readonly number[],
	at: GridPosition,
	key: string,
): GridPosition | null {
	let length = lengths[at.row];
	if (key === "ArrowRight") return { row: at.row, index: Math.min(at.index + 1, length - 1) };
	if (key === "ArrowLeft") return { row: at.row, index: Math.max(at.index - 1, 0) };
	if (key === "Home") return { row: at.row, index: 0 };
	if (key === "End") return { row: at.row, index: length - 1 };
	if (key !== "ArrowDown" && key !== "ArrowUp") return null;
	let direction = key === "ArrowDown" ? 1 : -1;
	for (let row = at.row + direction; row >= 0 && row < lengths.length; row += direction) {
		if (lengths[row] > 0) return { row, index: project(at.index, length, lengths[row]) };
	}
	return at;
}

export function placePopover(
	anchor: Box,
	size: Size,
	viewport: Box,
	margin = 16,
	gap = 8,
): { left: number; top: number; side: "below" | "above" } {
	let top = viewport.top + margin;
	let bottom = viewport.top + viewport.height - margin;
	let below = anchor.top + anchor.height + gap;
	let above = anchor.top - gap - size.height;
	let roomBelow = bottom - below;
	let roomAbove = anchor.top - gap - top;
	let side: "below" | "above" = roomBelow >= size.height
		? "below"
		: roomAbove >= size.height || roomAbove > roomBelow
		? "above"
		: "below";
	let maximum = Math.max(viewport.left + margin, viewport.left + viewport.width - margin - size.width);
	let left = clamp(anchor.left + anchor.width / 2 - size.width / 2, viewport.left + margin, maximum);
	return { left, top: side === "below" ? below : Math.max(top, above), side };
}
```

Run: `bun test packages/visuals/src/ui/color/geometry.test.ts`. Expected: PASS.

- [ ] **Step 3: Write the failing grid test** in `palette-grid.test.tsx`:

```tsx
import { createPaletteState, gridRows, paletteReducer } from "@chopin/color";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PaletteGrid } from "./palette-grid";

let state = createPaletteState({
	themes: {
		light: [
			{
				name: "gray",
				swatches: [
					{ step: "400", value: { l: 0.74029, c: 0.00856, h: 95 } },
					{ step: "450", value: { l: 0.6681, c: 0.0105, h: 95 } },
				],
			},
			{ name: "empty", swatches: [] },
		],
	},
});

test("labels swatches, marks edits and selection, and uses roving tabindex", () => {
	let ref = { hue: "gray", step: "450" };
	let edited = paletteReducer(paletteReducer(state, { type: "select", ref }), {
		type: "edit",
		ref,
		value: { l: 0.64, c: 0.0105, h: 95 },
	});
	let markup = renderToStaticMarkup(<PaletteGrid onActivate={() => {}} rows={gridRows(edited)} />);
	expect(markup).toContain('aria-label="Gray 400, oklch(0.74029 0.00856 95)"');
	expect(markup).toContain('aria-label="Gray 450, oklch(0.64 0.0105 95), edited"');
	expect(markup).toContain('aria-pressed="true"');
	expect(markup.match(/tabindex="0"/g)!.length).toBe(1);
	expect(markup).toContain("No colors");
});

test("shows a shared step header only when every row matches", () => {
	let markup = renderToStaticMarkup(<PaletteGrid onActivate={() => {}} rows={gridRows(state)} />);
	expect(markup).not.toContain("cv-palette-grid-steps");
});
```

- [ ] **Step 4: Implement** `palette-grid.tsx`:
  - **Layout.** Render the header row (from `sharedSteps`) when it is non-null. Each row is
    `role="group"` with an `aria-label` of the capitalised hue name. It shows the visible name
    column, then either a cells container or `<span className="cv-palette-grid-empty">No
    colors</span>`.
  - **Swatch buttons.**
    `aria-label = "${Capitalised} ${step}, ${format(value, "oklch")}${edited ? ", edited" : ""}"`,
    `title = "${hue} ${step}"`, `aria-pressed={cell.selected}`,
    `style={{ background: toHex(value) }}`, and `data-edited` plus `data-dot`, where
    `data-dot` is `"dark"` when `contrast(value, black) >= contrast(value, white)`, otherwise
    `"light"`.
  - **Roving focus.** Keep `useState<GridPosition>`, clamped to valid cells at render. The
    first non-empty cell holds `tabIndex={0}` by default, or the selected cell if there is one.
    `onKeyDown` calls `gridMove`; when it returns a position, call `preventDefault` and focus
    the button through a `Map` of refs.
  - `onClick` calls `onActivate(cell.ref, event.currentTarget)`.

  CSS, matching `01-palette-grid-and-tokens.png`:
  - Rows are grid columns `minmax(4rem, max-content) 1fr`. Cells are a flex row of equal
    `flex: 1` buttons 44 px tall, with no gap and no border. The first and last rows round
    the outer corners with `--radius-md`.
  - The selected swatch gets
    `box-shadow: inset 0 0 0 2px var(--color-page), 0 0 0 1px var(--color-gray-800)`.
  - The edited dot is a `::after` pseudo-element, 6 px, bottom-right, coloured
    `var(--color-gray-900)` for `data-dot="dark"` and `var(--color-page)` for `light`.
  - `:focus-visible` gets an outline offset of 2 px.

- [ ] **Step 5: Run and commit**

```bash
bun test packages/visuals
bun run fix && bun run types && bun run ci
git add packages/visuals
git commit -m "Add palette grid"
```

### Task 10: Palette editor with an anchored popover

**Files:**
- Create: `packages/visuals/src/ui/color/palette-editor.tsx`
- Modify: `packages/visuals/package.json` (add `"@chopin/viewport": "workspace:*"`),
  `color.css`, `index.ts`, `apps/web/src/design-audit/color-fixture.ts` (export
  `CHOPIN_PALETTE: Palette`), `apps/web/src/design-audit/color.tsx`, `inventory.ts`, and
  `specimens.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 4–9, plus `currentViewport` and `listenToViewportChanges`
- Produces:
  - `type PaletteEditorProps = { state: PaletteState; dispatch(action: PaletteAction): void }`
  - `PaletteEditor(props)`
  - `contrastOptions(state: PaletteState): ContrastOption[]`, exported for tests

- [ ] **Step 1: Write the failing tests.** Add to `palette-grid.test.tsx`, or create
  `palette-editor.test.tsx`:

```tsx
import { contrastOptions } from "./palette-editor";

test("contrast options start with the theme surface, then every current swatch", () => {
	let options = contrastOptions(state);
	expect(options[0]).toEqual({ id: "surface", label: "Page surface", value: { l: 1, c: 0, h: 0 } });
	expect(options.map(option => option.label)).toEqual(["Page surface", "Gray 400", "Gray 450"]);
	expect(new Set(options.map(option => option.id)).size).toBe(options.length);
});
```

  Also add a specimen test to `specimens.test.tsx`. It asserts that `data-audit-item="palette-editor"`
  renders, that the markup contains `aria-label="Gray 450, oklch(0.6681 0.0105 95)"` and
  `aria-label="Ruby 9, …"`, and that there is no changes summary initially.

- [ ] **Step 2: Implement** `palette-editor.tsx`:

```tsx
import {
	baseValue,
	changes,
	currentValue,
	gridRows,
	surface,
} from "@chopin/color";
import { currentViewport, listenToViewportChanges } from "@chopin/viewport";
import { useLayoutEffect, useRef, useState } from "react";

import { ColorPopover } from "./color-popover";
import { placePopover } from "./geometry";
import { PaletteGrid } from "./palette-grid";

import type { PaletteAction, PaletteState, Purpose, SwatchRef } from "@chopin/color";
import type { ContrastOption } from "./contrast-reader";

export type PaletteEditorProps = { state: PaletteState; dispatch(action: PaletteAction): void };

function title(ref: SwatchRef): string {
	return `${ref.hue.charAt(0).toUpperCase()}${ref.hue.slice(1)} ${ref.step}`;
}

export function contrastOptions(state: PaletteState): ContrastOption[] {
	let options: ContrastOption[] = [{
		id: "surface",
		label: state.theme === "dark" ? "Dark surface" : "Page surface",
		value: surface(state),
	}];
	for (let row of gridRows(state)) {
		for (let cell of row.cells) {
			options.push({ id: JSON.stringify([row.name, cell.step]), label: title(cell.ref), value: cell.value });
		}
	}
	return options;
}

export function PaletteEditor({ state, dispatch }: PaletteEditorProps) {
	let popover = useRef<HTMLDivElement>(null);
	let anchor = useRef<HTMLElement | null>(null);
	let [purpose, setPurpose] = useState<Purpose>("graphic");
	let [against, setAgainst] = useState("surface");
	let [position, setPosition] = useState<{ left: number; top: number } | null>(null);
	let selected = state.selected;
	let pending = changes(state).length;

	useLayoutEffect(() => {
		if (!selected) return;
		function place() {
			let element = popover.current;
			let trigger = anchor.current;
			if (!element || !trigger) return;
			let size = { width: element.offsetWidth, height: element.offsetHeight };
			setPosition(placePopover(trigger.getBoundingClientRect(), size, currentViewport()));
		}
		place();
		return listenToViewportChanges(place, { observeDocumentScroll: true });
	}, [selected]);

	function open(ref: SwatchRef, element: HTMLElement) {
		anchor.current = element;
		dispatch({ type: "select", ref });
		if (!popover.current?.matches(":popover-open")) popover.current?.showPopover();
	}

	let value = selected && currentValue(state, selected);
	let previous = selected && baseValue(state, selected);
	return (
		<div className="cv-palette-editor">
			<PaletteGrid onActivate={open} rows={gridRows(state)} />
			{pending > 0 && (
				<p className="cv-palette-changes">
					{pending} {pending === 1 ? "change" : "changes"} ·{" "}
					<button onClick={() => dispatch({ type: "resetAll" })} type="button">
						Discard all
					</button>
				</p>
			)}
			<div
				className="cv-palette-popover"
				onToggle={event => {
					// Light dismiss fires this after a click on another swatch has reopened it.
					if (event.newState !== "closed" || popover.current?.matches(":popover-open")) return;
					dispatch({ type: "select", ref: null });
					anchor.current?.focus({ preventScroll: true });
				}}
				popover="auto"
				ref={popover}
				style={position ? { left: position.left, top: position.top } : { visibility: "hidden" }}
			>
				{selected && value && previous && (
					<ColorPopover
						contrast={{
							against,
							onAgainstChange: setAgainst,
							onPurposeChange: setPurpose,
							options: contrastOptions(state),
							purpose,
						}}
						onChange={next => dispatch({ type: "edit", ref: selected, value: next })}
						previous={previous}
						title={title(selected)}
						value={value}
					/>
				)}
			</div>
		</div>
	);
}
```

`.cv-palette-popover` is `position: fixed; inset: auto; margin: 0; padding: 0; border: 0;
background: transparent; overflow: visible`. The `ColorPopover` inside supplies the surface.

Update `color-fixture.ts` to export `CHOPIN_PALETTE: Palette = { themes: { light:
CHOPIN_LIGHT_HUES } }`. In `color.tsx`, add a `PaletteEditorSpecimen` using
`useReducer(paletteReducer, CHOPIN_PALETTE, createPaletteState)`, wrapped in `AuditPlate` with
`item="palette-editor"`. Keep the slice 1 `ColorControls` specimen, and add the inventory item.

- [ ] **Step 3: Run the tests**

Run: `bun test`
Expected: PASS.

- [ ] **Step 4: Verify in the browser** (`bun run dev` plus the Playwright MCP, at 1280×900 and
  390×844):
  1. The grid shows gray (13 steps) and ruby, orange and lime (12 steps) with no shared header.
     Compare it against `01-palette-grid-and-tokens.png`.
  2. Click gray 450. The popover opens below it, centred and fully inside the viewport. Click
     a swatch in the last row: the popover flips above it.
  3. **Review Focus.** With the popover open on gray 450, click ruby 9. The popover stays open
     and now shows "Ruby 9", and the selection is not cleared (take a snapshot of
     `aria-pressed`).
  4. Drag the plane. The swatch recolours live, gets the edited dot, and "1 change · Discard
     all" appears.
  5. Press Escape. The popover closes and focus returns to the swatch (check the active element
     in a snapshot). Arrow keys move focus across rows of different lengths.
  6. Scroll the page with the popover open. It follows its anchor.
  7. Click "Discard all". The dot and the summary disappear.
  8. There are no console errors.

- [ ] **Step 5: Commit**

```bash
bun run fix && bun run types && bun run ci && bun test
git add packages/visuals apps/web bun.lock
git commit -m "Add palette editor with anchored color popover"
```

### Slice 2 checkpoint

Run the same checkpoint as slice 1, on branch `color-controls/2-palette-grid`. The review
covers the spec section "Palette grid and editor (slice 2)". The PR title is "Add palette grid
and anchored color popover".

---

## Slice 3: Ramp curve editor

### Task 11: Curve generation and the `curve` action

**Files:**
- Create: `packages/color/src/curve.ts`, `packages/color/src/curve.test.ts`
- Modify: `packages/color/src/palette.ts`, `palette.test.ts`, `index.ts`

**Interfaces:**
- Consumes: `maxChroma`, `normalizeHue`, `Oklch`
- Produces:
  - `type Easing = "linear" | "ease"`
  - `type Endpoint = { l: number; hueShift: number; easing: Easing }`
  - `type Curve = { darkest: Endpoint; lightest: Endpoint }`
  - `ease(t: number, start: Easing, end: Easing): number`
  - `rampCurve(base: readonly Oklch[], curve: Curve): Oklch[]`
  - `curveFrom(base: readonly Oklch[]): Curve`
  - In `palette.ts`:
    - `PaletteState.curves: Record<Theme, Record<string, Curve>>`
    - the action `{ type: "curve"; hue: string; curve: Curve }`
    - `rowValues(state, hue): { base: Oklch[]; current: Oklch[]; steps: string[] } | null`
    - `curveFor(state, hue): Curve | null`, which returns the stored curve or `curveFrom(base)`

- [ ] **Step 1: Branch**

```bash
git checkout -b color-controls/3-ramp-curve color-controls/2-palette-grid
```

- [ ] **Step 2: Write the failing tests** in `curve.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { curveFrom, ease, rampCurve } from "./curve";
import { maxChroma } from "./gamut";

let lightToDark = [
	{ l: 0.95, c: 0.02, h: 30 },
	{ l: 0.8, c: 0.08, h: 30 },
	{ l: 0.6, c: 0.15, h: 31 },
	{ l: 0.4, c: 0.1, h: 32 },
];

describe("ease", () => {
	test("linear at both ends is the identity", () => {
		for (let t of [0, 0.25, 0.5, 1]) expect(ease(t, "linear", "linear")).toBeCloseTo(t, 9);
	});

	test("ease flattens its end and stays monotonic", () => {
		expect(ease(0.1, "ease", "linear")).toBeLessThan(0.1);
		expect(ease(0.9, "linear", "ease")).toBeGreaterThan(0.9);
		let previous = -1;
		for (let step = 0; step <= 20; step++) {
			let value = ease(step / 20, "ease", "ease");
			expect(value).toBeGreaterThanOrEqual(previous);
			previous = value;
		}
	});
});

describe("rampCurve", () => {
	test("curveFrom spans the row's lightness with no shift", () => {
		expect(curveFrom(lightToDark)).toEqual({
			darkest: { l: 0.4, hueShift: 0, easing: "linear" },
			lightest: { l: 0.95, hueShift: 0, easing: "linear" },
		});
	});

	test("respects declared order: the first swatch is lightest here", () => {
		let out = rampCurve(lightToDark, {
			darkest: { l: 0.3, hueShift: 0, easing: "linear" },
			lightest: { l: 0.9, hueShift: 0, easing: "linear" },
		});
		expect(out.map(value => Number(value.l.toFixed(4)))).toEqual([0.9, 0.7, 0.5, 0.3]);
	});

	test("shifts hue from each swatch's own base hue", () => {
		let out = rampCurve(lightToDark, {
			darkest: { l: 0.4, hueShift: -30, easing: "linear" },
			lightest: { l: 0.95, hueShift: 0, easing: "linear" },
		});
		expect(out[0].h).toBeCloseTo(30, 6);
		expect(out[3].h).toBeCloseTo(2, 6);
	});

	test("keeps each swatch's relative chroma and stays in gamut", () => {
		let out = rampCurve(lightToDark, curveFrom(lightToDark));
		for (let [index, value] of out.entries()) {
			let base = lightToDark[index];
			let ratio = Math.min(1, base.c / maxChroma(base.l, base.h));
			expect(value.c).toBeCloseTo(ratio * maxChroma(value.l, value.h), 6);
		}
	});

	test("handles achromatic rows and rows too short to curve", () => {
		let grays = [{ l: 0.9, c: 0, h: 0 }, { l: 0.2, c: 0, h: 0 }];
		expect(rampCurve(grays, curveFrom(grays)).every(value => value.c === 0)).toBe(true);
		expect(rampCurve([{ l: 0.5, c: 0.1, h: 30 }], curveFrom([{ l: 0.5, c: 0.1, h: 30 }]))).toEqual([
			{ l: 0.5, c: 0.1, h: 30 },
		]);
	});
});
```

Add to `palette.test.ts`:

```ts
test("the curve action rewrites a row from its base and stores the settings", () => {
	let state = createPaletteState(palette);
	let curve = {
		darkest: { l: 0.6, hueShift: 0, easing: "linear" as const },
		lightest: { l: 0.8, hueShift: 0, easing: "linear" as const },
	};
	let once = paletteReducer(state, { type: "curve", hue: "gray", curve });
	let twice = paletteReducer(once, { type: "curve", hue: "gray", curve });
	expect(twice.edits).toEqual(once.edits);
	expect(currentValue(once, { hue: "gray", step: "400" })!.l).toBeCloseTo(0.8, 6);
	expect(curveFor(once, "gray")).toEqual(curve);
	let reset = paletteReducer(once, { type: "resetRow", hue: "gray" });
	expect(changes(reset)).toEqual([]);
	expect(curveFor(reset, "gray")).toEqual(curveFrom(rowValues(reset, "gray")!.base));
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `bun test packages/color`
Expected: FAIL.

- [ ] **Step 4: Implement** `curve.ts`:

```ts
import { maxChroma } from "./gamut";
import { normalizeHue } from "./oklch";

import type { Oklch } from "./oklch";

export type Easing = "linear" | "ease";
export type Endpoint = { l: number; hueShift: number; easing: Easing };
export type Curve = { darkest: Endpoint; lightest: Endpoint };

/** A cubic Hermite from 0 to 1; "ease" flattens that end's slope to zero, "linear" keeps 1. */
export function ease(t: number, start: Easing, end: Easing): number {
	let s0 = start === "ease" ? 0 : 1;
	let s1 = end === "ease" ? 0 : 1;
	let t2 = t * t;
	let t3 = t2 * t;
	return (t3 - 2 * t2 + t) * s0 + (-2 * t3 + 3 * t2) + (t3 - t2) * s1;
}

function lerp(from: number, to: number, t: number): number {
	return from + (to - from) * t;
}

export function curveFrom(base: readonly Oklch[]): Curve {
	let lightness = base.map(value => value.l);
	return {
		darkest: { l: Math.min(...lightness), hueShift: 0, easing: "linear" },
		lightest: { l: Math.max(...lightness), hueShift: 0, easing: "linear" },
	};
}

/** Generated from the base row, never the edited one, so repeating a setting is idempotent. */
export function rampCurve(base: readonly Oklch[], curve: Curve): Oklch[] {
	if (base.length < 2) return base.map(value => ({ ...value }));
	let lightFirst = base[0].l >= base[base.length - 1].l;
	return base.map((value, index) => {
		let t = (lightFirst ? base.length - 1 - index : index) / (base.length - 1);
		let l = lerp(curve.darkest.l, curve.lightest.l, ease(t, curve.darkest.easing, curve.lightest.easing));
		let h = normalizeHue(value.h + lerp(curve.darkest.hueShift, curve.lightest.hueShift, t));
		let limit = maxChroma(value.l, value.h);
		let ratio = limit > 0 ? Math.min(1, value.c / limit) : 0;
		return { l, c: ratio * maxChroma(l, h), h };
	});
}
```

In `palette.ts`:
- Add `curves` to `PaletteState` and `createPaletteState` (`{ light: {}, dark: {} }`).
- Add `rowValues`.
- Add `curveFor`, which reads `state.curves[state.theme][hue] ?? curveFrom(base)`.
- Handle `curve`: find the row and return `state` if it is missing. Compute
  `rampCurve(base, curve)` and write each swatch through `withEdit`, dropping values equal to
  base. Store the curve.
- Make `resetRow` also delete `curves[theme][hue]`, and `resetAll` clear `curves` too.

Export the new names from `index.ts`.

- [ ] **Step 5: Run the tests to verify they pass, then commit**

```bash
bun test packages/color
bun run fix && bun run types && bun run ci
git add packages/color
git commit -m "Add ramp curve generation"
```

### Task 12: Scrub field, chroma graph, curve pane and `CurveIcon`

**Files:**
- Create: `packages/visuals/src/ui/color/scrub-field.tsx`,
  `packages/visuals/src/ui/color/chroma-graph.tsx`,
  `packages/visuals/src/ui/color/ramp-curve-editor.tsx`,
  `packages/visuals/src/ui/color/ramp-curve-editor.test.tsx`
- Modify: `geometry.ts` and its test (add `scrub`), `packages/icons/src/line.tsx`,
  `packages/icons/src/index.ts`, `color.css`, and `packages/visuals/src/index.ts`

**Interfaces:**
- Consumes: `Curve`, `Endpoint`, `Easing`, `maxChroma`
- Produces:
  - `scrub(value: number, deltaPixels: number, options: { step: number; min: number; max: number; pixelsPerStep?: number }): number`
  - `ScrubField({ label, value, onChange, step, min, max, suffix, precision })`
  - `ChromaGraph({ values: readonly Oklch[] })`
  - `type RampCurveEditorProps = { steps: readonly string[]; current: readonly Oklch[]; curve: Curve; onCurveChange(curve: Curve): void; edited: boolean; onDiscard(): void }`
  - `RampCurveEditor(props)`
  - `CurveIcon(props: IconProps)`

- [ ] **Step 1: Write the failing tests.** Add `scrub` cases to `geometry.test.ts`:

```ts
test("scrub steps per pixel run and clamps", () => {
	expect(scrub(50, 8, { step: 1, min: 0, max: 100 })).toBe(52);
	expect(scrub(50, -3, { step: 1, min: 0, max: 100 })).toBe(49);
	expect(scrub(99, 40, { step: 1, min: 0, max: 100 })).toBe(100);
	expect(scrub(0, 12, { step: 5, min: -180, max: 180, pixelsPerStep: 6 })).toBe(10);
});
```

`ramp-curve-editor.test.tsx`:

```tsx
import { curveFrom } from "@chopin/color";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RampCurveEditor } from "./ramp-curve-editor";

let row = [
	{ l: 0.95, c: 0.02, h: 30 },
	{ l: 0.6, c: 0.15, h: 31 },
	{ l: 0.4, c: 0.1, h: 32 },
];

test("renders both endpoints, the chroma graph and the discard note only when edited", () => {
	let props = {
		current: row,
		curve: curveFrom(row),
		onCurveChange() {},
		onDiscard() {},
		steps: ["1", "2", "3"],
	};
	let clean = renderToStaticMarkup(<RampCurveEditor {...props} edited={false} />);
	expect(clean).toContain(">Darkest<");
	expect(clean).toContain(">Lightest<");
	expect(clean).toContain('value="40"');
	expect(clean).toContain('value="95"');
	expect(clean).toContain('aria-label="Chroma across 3 steps"');
	expect(clean).toContain('stroke-dasharray');
	expect(clean).not.toContain("Discard these changes");
	expect(renderToStaticMarkup(<RampCurveEditor {...props} edited />)).toContain(
		"Discard these changes",
	);
});
```

- [ ] **Step 2: Run them to verify they fail**, then implement:
  - **`scrub`:**
    `clamp(value + Math.round(deltaPixels / (pixelsPerStep ?? 4)) * step, min, max)`.
  - **`ScrubField`:** a `<div className="cv-scrub">` containing a `<span>` label handle
    (`cursor: ew-resize`, `touch-action: none`) and an `<input inputMode="decimal"
    aria-label={fullLabel}>`.
    - Dragging the label uses pointer capture and computes `dx` from the pointer-down x
      position. Call `scrub(startValue, dx, …)` on each move, so values do not drift.
    - The input shows `value.toFixed(precision)` followed by the suffix.
    - It commits on Enter or blur via `Number.parseFloat`, ignoring `NaN` and clamping.
    - ↑/↓ step the value, and Shift multiplies the step by 10.
  - **`ChromaGraph`:** an SVG with `viewBox="0 0 240 88"`, `role="img"` and
    `aria-label="Chroma across ${n} steps"`.
    - `x = i / (n - 1) * 232 + 4`, and `y = 80 - c / top * 72`, where
      `top = Math.max(0.01, ...maxChroma values)`.
    - Draw a solid current path, a dashed max path (`stroke-dasharray="4 4"`), step labels
      `1…n` below, and a legend "Current" and "Max" above.
    - With fewer than 2 values, render nothing.
  - **`RampCurveEditor`:** two sections, "Darkest" and "Lightest". Each has:
    - `ScrubField` "L", in percent: value `l * 100`, 0–100, step 1, precision 0, suffix `%`
    - `ScrubField` "H": the hue shift, −180 to 180, step 1, suffix `°`
    - a native `<select>` for easing with `useId`-prefixed values "Linear" and "Ease"

    Then a `ChromaGraph` of `current`. When `edited`, add
    `<p>This row's previous values were overwritten. <button type="button"
    onClick={onDiscard}>Discard these changes</button> to restore them.</p>`.
  - **`CurveIcon`** in `packages/icons/src/line.tsx`:

```tsx
export function CurveIcon(props: IconProps) {
	return (
		<LineIcon title="curve" {...props}>
			<path d="M2.75 11.75C4.5 5.25 6.5 5.25 9 9s4.5 3.75 6.25-2.75" />
		</LineIcon>
	);
}
```

  Export `CurveIcon` from `packages/icons/src/index.ts`. If
  `apps/web/src/icon-assets.test.ts` enumerates icons, update it.

- [ ] **Step 3: Run the tests and commit**

```bash
bun test packages/visuals packages/icons apps/web
bun run fix && bun run types && bun run ci
git add packages/visuals packages/icons apps/web
git commit -m "Add ramp curve pane, scrub field and chroma graph"
```

### Task 13: Wire the curve pane into the editor

**Files:**
- Modify: `packages/visuals/src/ui/color/palette-editor.tsx`, `color.css`,
  `apps/web/src/design-audit/specimens.test.tsx`

**Interfaces:**
- Consumes: `RampCurveEditor`, `CurveIcon`, `rowValues`, `curveFor`, and the `curve` and
  `resetRow` actions
- Produces: the `PaletteEditor` curve toggle

- [ ] **Step 1: Write the failing test.** Render `PaletteEditor` from a state with
  `selected = { hue: "gray", step: "450" }`, created with `paletteReducer(state, { type:
  "select", … })`. Assert that the markup contains a button with
  `aria-label="Edit gray ramp curve"` and `aria-expanded="false"`. For a one-swatch row, assert
  the button has `disabled=""` and an `aria-describedby` that points at text reading
  "Needs at least two colors".

- [ ] **Step 2: Implement it.**
  - Add `curveOpen` state in `PaletteEditor`. Pass
    `actions={<button aria-expanded aria-label="Edit {hue} ramp curve" …><CurveIcon size={16}
    /></button>}` to `ColorPopover`.
  - When the pane is open, render a wrapper `.cv-palette-popover-body` inside the popover
    element. It is a flex row at `min-width: 640px` (use a container or media query) and a
    column below that, holding the `ColorPopover` and a `RampCurveEditor` panel with the same
    surface styles.
  - `onCurveChange` dispatches `{ type: "curve", hue, curve }`. `onDiscard` dispatches
    `resetRow`.
  - `edited` is `rowValues(...).current.some((value, i) => !sameColor(value, base[i]))`.
  - The popover re-places when the pane opens. Include `curveOpen` in the layout effect
    dependencies.

- [ ] **Step 3: Verify in the browser** at 1280 px and 390 px:
  1. Open lime 9 and click the curve icon. The pane sits beside the popover at 1280 px and
     below it at 390 px, and stays inside the viewport. Compare it against
     `04-ramp-curve-editor.png`.
  2. Scrub Darkest L. The whole lime row recolours live, and the chroma graph's solid line
     stays under the dashed line.
  3. Set the Lightest easing to Ease. The graph changes and the row's lighter steps compress.
  4. "Discard these changes" restores the row, and the note disappears.
  5. The gray row (13 steps) curves too. Its step order is light to dark, so the darkest
     endpoint drives gray 900.

- [ ] **Step 4: Commit and run the checkpoint**

```bash
bun run fix && bun run types && bun run ci && bun test
git add packages/visuals apps/web
git commit -m "Open ramp curve pane from the color popover"
```

Run the slice checkpoint on branch `color-controls/3-ramp-curve`. The review covers the spec
section "Ramp curve editor (slice 3)". The PR title is "Add ramp curve editor".

---

## Slice 4: Tokens and theme

### Task 14: Token retargeting and the token list

**Files:**
- Create: `packages/visuals/src/ui/color/token-list.tsx`,
  `packages/visuals/src/ui/color/token-list.test.tsx`
- Modify: `packages/color/src/palette.ts`, `palette.test.ts`, `index.ts`, `palette-editor.tsx`,
  `color.css`, `packages/visuals/src/index.ts`, and `apps/web/src/design-audit/color-fixture.ts`
  (add `tokens`)

**Interfaces:**
- Produces:
  - In `palette.ts`:
    - `PaletteState.retargets: Record<string, SwatchRef>`
    - the action `{ type: "retarget"; token: string; ref: SwatchRef | null }`, where `null`
      resets
    - `type TokenChange = { kind: "token"; name: string; before: SwatchRef; after: SwatchRef }`
    - `Change = SwatchChange | TokenChange`
    - `type TokenRow = { name: string; group?: string; ref: SwatchRef; original: SwatchRef; value: Oklch | null; retargeted: boolean }`
    - `tokenRows(state): TokenRow[]`
  - `type TokenListProps = { rows: readonly TokenRow[]; swatches: readonly SwatchRef[]; onRetarget(token: string, ref: SwatchRef | null): void; onOpen(ref: SwatchRef, anchor: HTMLElement): void }`
  - `TokenList(props)`

- [ ] **Step 1: Branch**

```bash
git checkout -b color-controls/4-tokens-theme color-controls/3-ramp-curve
```

- [ ] **Step 2: Write the failing reducer tests** in `palette.test.ts`:

```ts
describe("tokens", () => {
	let withTokens: Palette = {
		...palette,
		tokens: [
			{ name: "neutral-graphic", group: "neutral", ref: { hue: "gray", step: "450" } },
			{ name: "ghost", ref: { hue: "gone", step: "1" } },
		],
	};

	test("retargets, reports and resets a token", () => {
		let state = createPaletteState(withTokens);
		let to = { hue: "gray", step: "400" };
		state = paletteReducer(state, { type: "retarget", token: "neutral-graphic", ref: to });
		expect(tokenRows(state)[0]).toMatchObject({ ref: to, retargeted: true });
		expect(changes(state)).toContainEqual({
			kind: "token",
			name: "neutral-graphic",
			before: { hue: "gray", step: "450" },
			after: to,
		});
		state = paletteReducer(state, { type: "retarget", token: "neutral-graphic", ref: { hue: "gray", step: "450" } });
		expect(tokenRows(state)[0].retargeted).toBe(false);
		expect(changes(state)).toEqual([]);
	});

	test("resolves a missing ref to null instead of throwing", () => {
		expect(tokenRows(createPaletteState(withTokens))[1].value).toBeNull();
	});

	test("ignores unknown tokens and resetAll clears retargets", () => {
		let state = createPaletteState(withTokens);
		expect(paletteReducer(state, { type: "retarget", token: "nope", ref: null })).toBe(state);
		state = paletteReducer(state, { type: "retarget", token: "neutral-graphic", ref: { hue: "gray", step: "400" } });
		expect(paletteReducer(state, { type: "resetAll" }).retargets).toEqual({});
	});
});
```

  Retargeting to the original ref deletes the entry. `tokenRows` resolves `value` through
  `currentValue` in the active theme, so a retarget or a swatch edit is reflected. Token
  changes follow swatch changes in `changes()`.

- [ ] **Step 3: Implement the reducer changes and run `bun test packages/color`.**
  Expected: PASS.

- [ ] **Step 4: Write the failing `TokenList` test.** It renders rows under group headings, with
  a leader line element. The ref `<select>` has `aria-label="neutral-graphic color"` and a
  selected option "gray 450". A retargeted row shows "was gray 450". A missing row shows
  "missing" with `data-tone="danger"`. The swatch button has
  `aria-label="Open gray 450"`.

- [ ] **Step 5: Implement `TokenList`.** Match the Tokens section of
  `01-palette-grid-and-tokens.png`:
  - Group headings use `--text-lg`, weight 600.
  - Rows are grid columns `max-content 1fr max-content max-content`. The leader is a 1 px
    `--color-selected` line centred vertically.
  - The select looks like text until hovered or focused.
  - The swatch is 24 × 18 px, with `--radius-sm` and an inset boundary shadow.
  - Option values are prefixed with `useId`, and each value encodes
    `JSON.stringify([hue, step])` after the prefix.

  In `PaletteEditor`, render `TokenList` under the grid when `palette.tokens` is non-empty:
  - `onOpen` reuses the grid's `open`.
  - `swatches` is every ref in `gridRows(state)`.
  - Add a single "Tokens" heading.

  In the fixture, add Chopin's semantic tokens from `theme.css` lines 63–121. Include every
  `--color-*: var(--color-<hue>-<step>)` alias, grouped as `surface`, `text`, `neutral`,
  `success`, `warning`, `danger` and `control`, each with a `source` such as
  `"--color-neutral-graphic"`. Extend the fixture drift test to cover the aliases.

- [ ] **Step 6: Run the tests and commit**

```bash
bun test
bun run fix && bun run types && bun run ci
git add packages/color packages/visuals apps/web
git commit -m "Add semantic token list with retargeting"
```

### Task 15: Light/Dark toggle

**Files:**
- Create: `packages/visuals/src/ui/color/theme-toggle.tsx`
- Modify: `palette-editor.tsx`, `color.css`, `index.ts`, `color-fixture.ts`, `color.tsx`,
  `specimens.test.tsx`

**Interfaces:**
- Produces: `ThemeToggle({ value: Theme, onChange(theme: Theme): void })`

- [ ] **Step 1: Write the failing test** in `specimens.test.tsx` or a new
  `theme-toggle.test.tsx`:
  - `ThemeToggle` renders `role="group"` with `aria-label="Theme"`, and two buttons "Light"
    and "Dark" using `aria-pressed`.
  - `PaletteEditor` renders no toggle for a palette without `themes.dark`, and renders one
    when `themes.dark` exists.
  - After dispatching `theme: "dark"`, the first contrast option's label is "Dark surface".

- [ ] **Step 2: Implement it.**
  - `ThemeToggle` is two plain buttons, styled like the reference's "Light **Dark**": the
    active one uses `--color-text-primary` at weight 600, the inactive one
    `--color-text-quaternary`.
  - `PaletteEditor` places it top-right above the grid, as in the reference.
  - Changing theme closes the popover: the reducer clears `selected`, and the editor calls
    `hidePopover()`.
  - It resets `against` to `"surface"`.

  In the fixture, add a **synthetic** dark theme so the toggle can be exercised: the gray
  ramp with the same step labels and values mirrored (step `50` takes gray 900's value, and so
  on). Label the specimen plate's description "Dark ramp is synthetic; Chopin has no dark theme
  yet."

- [ ] **Step 3: Verify in the browser.**
  1. Toggle to Dark. The grid shows only the synthetic gray row, the tokens pointing at other
     hues show "missing", and the contrast default is "Dark surface".
  2. Edit a dark swatch, toggle to Light, and toggle back. The dark edit is still there, and
     the light swatches show no dot.
  3. The changes summary counts both themes.
  4. Take screenshots at 1280 px and 390 px.

- [ ] **Step 4: Commit and run the final checkpoint**

```bash
bun run fix && bun run types && bun run ci && bun test
git add packages/visuals apps/web
git commit -m "Add light and dark theme toggle to palette editor"
```

Run the slice checkpoint on branch `color-controls/4-tokens-theme`. The review covers the spec
section "Tokens and theme (slice 4)". The PR title is "Add semantic tokens and theme toggle".
Then run the **whole-branch review**: load `superpowers:requesting-code-review` against the
diff from `main` to `color-controls/4-tokens-theme`, with the spec as the reference.

---

## Progress Log

Append one entry per slice checkpoint. Record the date, the branch, the head commit, the
check results, the screenshot paths, any deviations with reasons, and open questions for
Maggie.
