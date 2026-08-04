# Design Token Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give chopin a real design-token layer — surface, shadow, radius, type and motion scales — so hierarchy comes from a system rather than from values invented at each call site.

**Architecture:** All tokens live in one `@theme static` block in `apps/web/src/theme.css`. Nothing else declares a scale. The editor package reads tokens through `var()` and never redefines them. Where a Tailwind theme namespace exists (`--color-*`, `--radius-*`, `--text-*`, `--shadow-*`, `--ease-*`), tokens are declared under that namespace so the matching utility classes are regenerated with our values and existing markup upgrades without being touched.

**Tech Stack:** Tailwind CSS v4.3 (`@theme static`), Vite 7, React 19, Bun test.

## Global Constraints

- The palette is **light only**. Dark mode is explicitly out of scope; do not add `prefers-color-scheme` blocks or a second token set.
- Every token is declared in `apps/web/src/theme.css` inside the single `@theme static { }` block. `packages/editor/src/styles.css` may **read** tokens but must never declare a scale.
- `@theme` must keep the `static` keyword. `scripts/check-tokens.ts` fails the build otherwise — Tailwind prunes theme variables that only hand-written CSS reads.
- Every `var(--token)` without a fallback must resolve. `bun scripts/check-tokens.ts` enforces this and runs in `bun run ci`.
- Sizes are declared in `rem`. Pixel equivalents belong in comments, not values.
- Run `bun run fix` before every commit — `dprint check` runs in CI and rejects unformatted files.
- Do not touch press states (`active:`), focus-ring unification, or enter/exit animations. Those are the next slice.
- Existing test baseline is **525 passing, 0 failing**. It must stay green.

---

## File Structure

| File                                | Responsibility                                                                             | Change                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `apps/web/src/theme.css`            | The single source of every scale                                                           | Modify — add surface, shadow, radius, type, motion tokens |
| `apps/web/src/tokens.test.ts`       | Asserts the scales hold their invariants (monotonic, perceptible, no arbitrary sizes left) | Create                                                    |
| `apps/web/src/workspace.tsx`        | Three-pane shell; applies the rail surface                                                 | Modify                                                    |
| `apps/web/src/app.tsx`              | Header; applies the rail surface                                                           | Modify                                                    |
| `apps/web/src/chat/chat.tsx`        | Chat rail; type + radius migration                                                         | Modify                                                    |
| `apps/web/src/chat/transcript.tsx`  | Tool cards; type + radius migration                                                        | Modify                                                    |
| `packages/editor/src/styles.css`    | Reads tokens for document type, motion, radius                                             | Modify                                                    |
| `packages/editor/src/decisions.tsx` | Decisions rail surface                                                                     | Modify                                                    |
| `scripts/check-tokens.ts`           | Drops `--radius-` from the external allowlist once we own the scale                        | Modify                                                    |

`apps/web/src/theme.test.ts` already tests highlight perceptibility by parsing CSS. `tokens.test.ts` is a sibling in the same idiom, kept separate because it tests scale _structure_ rather than colour perception.

---

## Task 1: Surface token and the rails

Gives the layout a depth axis: the plan document stays pure white, the chrome around it recedes to a faint tint.

**Files:**

- Modify: `apps/web/src/theme.css` (`@theme static` block)
- Create: `apps/web/src/tokens.test.ts`
- Modify: `apps/web/src/workspace.tsx:85` (chat `<aside>`), `apps/web/src/workspace.tsx:97` (decisions `<aside>`)
- Modify: `apps/web/src/app.tsx:86` (header)
- Modify: `packages/editor/src/styles.css` (`.plan-decisions`)

**Interfaces:**

- Produces: `--color-surface`, an oklch token. Tasks 2–5 do not depend on it.
- Produces: `apps/web/src/tokens.test.ts` with helpers `theme(): string` and `declared(name: string): string`, reused by Tasks 2–5.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/tokens.test.ts`:

```ts
/**
 * Structural invariants of the scales.
 *
 * `theme.test.ts` beside this one asks whether a colour can be seen. This asks
 * whether a scale is a scale: that its steps go one way, that adjacent steps
 * are far enough apart to read as different, and that nothing in the app has
 * quietly opted out by inventing a value at the call site.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const THEME = readFileSync(join(import.meta.dir, "theme.css"), "utf8");

/** A token's declared value, as written in the theme. */
export function declared(name: string): string {
	let found = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(THEME);
	if (!found) throw new Error(`no ${name} in the theme`);
	return found[1]!.trim();
}

/** The lightness channel of an oklch token. */
function lightness(name: string): number {
	let found = /oklch\(([\d.]+)/.exec(declared(name));
	if (!found) throw new Error(`${name} is not an oklch colour`);
	return Number(found[1]);
}

describe("surfaces", () => {
	it("separates the rails from the document enough to see", () => {
		let gap = lightness("--color-background") - lightness("--color-surface");
		expect({ gap: gap > 0.008 }).toEqual({ gap: true });
	});

	it("keeps the rails lighter than a filled chip, so a tint is not a fill", () => {
		expect(lightness("--color-surface")).toBeGreaterThan(lightness("--color-muted"));
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test apps/web/src/tokens.test.ts`
Expected: FAIL — `no --color-surface in the theme`.

- [ ] **Step 3: Declare the token**

In `apps/web/src/theme.css`, immediately after the `--color-background` / `--color-foreground` pair:

```css
/*
 * The chrome around the document.
 *
 * A tint rather than a fill: the plan is the only pure white surface on the
 * page, so the eye lands on it without anything having to be drawn around
 * it. Sits between the page and `muted`, which stays the colour of a filled
 * chip — a rail the same value as the chips on it would flatten both.
 */
--color-surface: oklch(0.985 0.001 285);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test apps/web/src/tokens.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Apply the surface to the three chrome regions**

`apps/web/src/app.tsx:86` — add `bg-surface` to the header:

```tsx
<header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-2">
```

`apps/web/src/workspace.tsx:85` — the chat rail:

```tsx
<aside className="min-w-0 shrink-0 overflow-hidden bg-surface" style={{ width: chatWidth }}>
```

`apps/web/src/workspace.tsx:97` — the decisions rail:

```tsx
<aside
	className="min-w-0 shrink-0 overflow-hidden bg-surface"
	style={{ width: decisionsWidth }}
>
```

`packages/editor/src/styles.css` — `.plan-decisions` currently sets `background: var(--color-background)`, which would paint white over the rail. Change it to inherit:

```css
.plan-decisions {
	display: flex;
	height: 100%;
	min-width: 0;
	min-height: 0;
	flex-direction: column;
	overflow: hidden;
	/* The rail owns the surface; painting it again here would undo the tint. */
	background: transparent;
}
```

- [ ] **Step 6: Verify in the browser**

Run: `bun scripts/check-tokens.ts` — expect `tokens ok`.
Load `http://localhost:8787/r/main?as=Test` and confirm the two rails and the header are tinted while the plan column stays white.

- [ ] **Step 7: Commit**

```bash
bun run fix
git add apps/web/src/theme.css apps/web/src/tokens.test.ts apps/web/src/app.tsx apps/web/src/workspace.tsx packages/editor/src/styles.css
git commit -m "Give the chrome a surface of its own"
```

---

## Task 2: Shadow scale

Replaces three single-layer shadows invented at three call sites with one four-step scale. Because `--shadow-*` is a Tailwind namespace, the two existing `shadow-md` usages upgrade without being edited.

**Files:**

- Modify: `apps/web/src/theme.css`
- Modify: `apps/web/src/tokens.test.ts`
- Modify: `packages/editor/src/styles.css` (`.plan-status`, `.plan-changes-bar`, `.plan-changes-list`)

**Interfaces:**

- Consumes: `declared()` from Task 1.
- Produces: `--shadow-xs`, `--shadow-sm`, `--shadow-md`, `--shadow-lg`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/tokens.test.ts`:

```ts
/** Every blur radius in a shadow declaration, in px. */
function blurs(name: string): number[] {
	return [...declared(name).matchAll(/\d+px\s+(\d+)px/g)].map(match => Number(match[1]));
}

/** Every mix percentage in a shadow declaration. */
function opacities(name: string): number[] {
	return [...declared(name).matchAll(/(\d+)%/g)].map(match => Number(match[1]));
}

describe("shadows", () => {
	const SCALE = ["--shadow-xs", "--shadow-sm", "--shadow-md", "--shadow-lg"];

	it("grows monotonically, so a step up is always a step further from the page", () => {
		let reach = SCALE.map(name => Math.max(...blurs(name)));
		expect(reach).toEqual([...reach].sort((a, b) => a - b));
		expect(new Set(reach).size).toBe(reach.length);
	});

	it("layers every step above the first, because one stop cannot describe light", () => {
		for (let name of SCALE.slice(1)) {
			expect({ shadow: name, stops: blurs(name).length > 1 }).toEqual({
				shadow: name,
				stops: true,
			});
		}
	});

	it("keeps every stop faint enough to read as shadow rather than as a border", () => {
		for (let name of SCALE) {
			for (let percent of opacities(name)) {
				expect({ shadow: name, percent, subtle: percent <= 12 }).toEqual({
					shadow: name,
					percent,
					subtle: true,
				});
			}
		}
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test apps/web/src/tokens.test.ts`
Expected: FAIL — `no --shadow-xs in the theme`.

- [ ] **Step 3: Declare the scale**

In `apps/web/src/theme.css`, after the colour tokens:

```css
/*
 * Depth.
 *
 * Two stops from `sm` up, because one cannot describe light: a tight, darker
 * stop is the contact shadow where the surface meets the page, and a wide,
 * fainter one is the ambient fall-off around it. A single stop has to choose
 * between them, and whichever it picks reads as a blurred border.
 *
 * Mixed from `foreground` rather than pure black. The page is warm-neutral,
 * and a black shadow over it greys toward a different hue than everything
 * else on the page — visible where a shadow crosses a border it should be
 * continuous with. Every stop stays at or under 12%, past which the edge
 * reads as drawn rather than cast.
 */
--shadow-xs: 0 1px 2px -1px color-mix(in oklch, var(--color-foreground) 8%, transparent);
--shadow-sm:
	0 1px 2px -1px color-mix(in oklch, var(--color-foreground) 8%, transparent),
	0 2px 4px -1px color-mix(in oklch, var(--color-foreground) 5%, transparent);
--shadow-md:
	0 2px 4px -2px color-mix(in oklch, var(--color-foreground) 8%, transparent),
	0 6px 12px -2px color-mix(in oklch, var(--color-foreground) 7%, transparent);
--shadow-lg:
	0 4px 8px -4px color-mix(in oklch, var(--color-foreground) 10%, transparent),
	0 16px 28px -6px color-mix(in oklch, var(--color-foreground) 8%, transparent);
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test apps/web/src/tokens.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Point the three hand-written shadows at the scale**

In `packages/editor/src/styles.css`, `.plan-status[data-level="notice"]`:

```css
box-shadow: var(--shadow-xs);
```

`.plan-changes-bar`:

```css
box-shadow: var(--shadow-sm);
```

`.plan-changes-list`, `.plan-changes-empty`:

```css
box-shadow: var(--shadow-md);
```

- [ ] **Step 6: Verify the Tailwind utilities regenerated**

The two `shadow-md` sites (`toolbar/bubble.tsx:294`, `toolbar/slash.tsx:391`) must now render our two-stop shadow rather than Tailwind's default. In the browser console:

```js
getComputedStyle(document.querySelector(".mdxeditor")).getPropertyValue("--shadow-md");
```

Expected: the two-stop `color-mix` value, not Tailwind's `0 4px 6px -1px rgb(0 0 0 / 0.1)`.

- [ ] **Step 7: Commit**

```bash
bun run fix && bun test apps/web/src/tokens.test.ts && bun scripts/check-tokens.ts
git add apps/web/src/theme.css apps/web/src/tokens.test.ts packages/editor/src/styles.css
git commit -m "Cast a shadow in two stops rather than one"
```

---

## Task 3: Radius scale

Stops borrowing Tailwind's radius defaults and removes the corresponding exemption from the token checker.

**Files:**

- Modify: `apps/web/src/theme.css`
- Modify: `apps/web/src/tokens.test.ts`
- Modify: `scripts/check-tokens.ts:39-43` (the `EXTERNAL` allowlist)
- Modify: `apps/web/src/chat/chat.tsx:154`, `apps/web/src/chat/transcript.tsx:33`
- Modify: `packages/editor/src/toolbar/bubble.tsx:330,367,386`, `packages/editor/src/widgets/render-blocks.tsx:160,181`, `packages/editor/src/widgets/callout.tsx:81,93`

**Interfaces:**

- Consumes: `declared()` from Task 1.
- Produces: `--radius-xs` … `--radius-xl`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/tokens.test.ts`:

```ts
/** A `rem` token as a number of rems. */
function rems(name: string): number {
	let found = /^([\d.]+)rem$/.exec(declared(name));
	if (!found) throw new Error(`${name} is not a rem value`);
	return Number(found[1]);
}

describe("radii", () => {
	const SCALE = ["--radius-xs", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl"];

	it("is declared by us rather than borrowed from Tailwind", () => {
		for (let name of SCALE) expect(() => rems(name)).not.toThrow();
	});

	it("increases at every step", () => {
		let sizes = SCALE.map(rems);
		expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
		expect(new Set(sizes).size).toBe(sizes.length);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test apps/web/src/tokens.test.ts`
Expected: FAIL — `no --radius-xs in the theme`.

- [ ] **Step 3: Declare the scale**

In `apps/web/src/theme.css`:

```css
/*
 * Corners.
 *
 * Ours rather than Tailwind's, which this theme used to inherit silently —
 * so `--radius-md` meant one thing in the editor's stylesheet and whatever
 * the framework last shipped everywhere else.
 *
 * Nested corners are concentric: an inner radius plus its padding gives the
 * outer one. A chip at `xs` inside `sm` padding wants `md` around it, which
 * is why the steps are spaced roughly a padding step apart rather than
 * doubling.
 */
--radius-xs: 0.25rem; /* 4px — inline code, the smallest chips */
--radius-sm: 0.375rem; /* 6px — buttons, grips, toolbar cells */
--radius-md: 0.5rem; /* 8px — cards, inputs, callouts, code blocks */
--radius-lg: 0.75rem; /* 12px — popovers and panels */
--radius-xl: 1rem; /* 16px — the largest containers */
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `bun test apps/web/src/tokens.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Drop the allowlist exemption**

In `scripts/check-tokens.ts`, the `EXTERNAL` array — remove `"--radius-"` and its now-stale doc comment, leaving:

```ts
/**
 * Tokens owned by somebody else, so absent from our stylesheets by design.
 *
 * Kept deliberately short. Every entry is a dependency on a scale we do not
 * control, and is worth removing by defining the thing ourselves.
 */
const EXTERNAL = [
	/** Tailwind's internal bookkeeping properties. */
	"--tw-",
];
```

- [ ] **Step 6: Migrate the bare `rounded` call sites**

`rounded` with no suffix is Tailwind's 4px default and appears at 8 sites that are all small interactive cells. Replace each with `rounded-sm` (6px):

- `apps/web/src/chat/chat.tsx:154` — the Stop button
- `apps/web/src/chat/transcript.tsx:33` — the tool-call card
- `packages/editor/src/toolbar/bubble.tsx:330,367,386` — the `size-7` toolbar cells
- `packages/editor/src/widgets/render-blocks.tsx:160,181`
- `packages/editor/src/widgets/callout.tsx:81,93`

- [ ] **Step 7: Verify and commit**

```bash
bun run fix && bun test apps/web/src/tokens.test.ts && bun scripts/check-tokens.ts && bun run types
git add -A
git commit -m "Own the corners instead of borrowing them"
```

Expected: `tokens ok`, all tests pass, types clean.

---

## Task 4: Type scale

Widens the heading steps so hierarchy comes from size as well as weight, drops rail text below document text, and replaces eighteen arbitrary `text-[…]` sizes — currently the same size spelled four different ways — with one named step.

**Files:**

- Modify: `apps/web/src/theme.css`
- Modify: `apps/web/src/tokens.test.ts`
- Modify: `packages/editor/src/styles.css` (heading sizes, `.plan-status`, `.plan-changes-*`)
- Modify: all files containing `text-[0.5rem]`, `text-[10px]`, `text-[0.625rem]`, `text-[0.6875rem]`

**Interfaces:**

- Consumes: `declared()`, `rems()` from Tasks 1 and 3.
- Produces: `--text-2xs` … `--text-2xl` with paired `--text-*--line-height`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/tokens.test.ts`:

```ts
import { readdirSync, statSync } from "node:fs";

/** Every `.tsx` under the repo, excluding dependencies. */
function components(dir: string, found: string[] = []): string[] {
	for (let entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		let path = join(dir, entry);
		if (statSync(path).isDirectory()) components(path, found);
		else if (entry.endsWith(".tsx")) found.push(path);
	}
	return found;
}

const ROOT = join(import.meta.dir, "../../..");

describe("type scale", () => {
	const HEADINGS = ["--text-base", "--text-lg", "--text-xl", "--text-2xl"];

	/*
	 * Below this a heading reads as body text in bold. The eye takes the weight
	 * change as the whole signal and stops looking for a size change, so the
	 * extra pixels are spent without buying a level of hierarchy.
	 */
	const LEAST_STEP = 1.15;

	it("steps far enough between headings to survive being bolded", () => {
		for (let i = 1; i < HEADINGS.length; i++) {
			let ratio = rems(HEADINGS[i]!) / rems(HEADINGS[i - 1]!);
			expect({ from: HEADINGS[i - 1], to: HEADINGS[i], stepped: ratio >= LEAST_STEP })
				.toEqual({ from: HEADINGS[i - 1], to: HEADINGS[i], stepped: true });
		}
	});

	it("sets rail text below document text, so a rail reads as chrome", () => {
		expect(rems("--text-sm")).toBeLessThan(rems("--text-base"));
	});

	it("leaves no arbitrary size in any component", () => {
		let offenders: string[] = [];
		for (let file of components(join(ROOT, "apps")).concat(components(join(ROOT, "packages")))) {
			for (let [match] of readFileSync(file, "utf8").matchAll(/text-\[[\d.]+(?:rem|px)\]/g)) {
				offenders.push(`${file.slice(ROOT.length + 1)}  ${match}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test apps/web/src/tokens.test.ts`
Expected: FAIL — `no --text-base in the theme`, and the arbitrary-size test lists 18 offenders.

- [ ] **Step 3: Declare the scale**

In `apps/web/src/theme.css`:

```css
/*
 * Type.
 *
 * Two ranges with different jobs. From `base` up is the document, and the
 * steps are wide — a heading only a pixel or two above its body text is
 * doing the whole job with weight, and reads as a bold paragraph. From `sm`
 * down is chrome, where steps are narrow because the sizes are close to the
 * floor of legibility and there is nowhere to go.
 *
 * `sm` is deliberately under `base`: a rail set at the document's size
 * competes with it, and the document should win its own page.
 *
 * Line heights are declared beside each size rather than left to Tailwind.
 * Its defaults are computed against its own sizes, so overriding a size
 * alone would silently pair new type with the old rhythm.
 */
--text-2xs: 0.6875rem; /* 11px — timestamps, counts, gutter chips */
--text-2xs--line-height: 1rem;
--text-xs: 0.75rem; /* 12px — secondary chrome */
--text-xs--line-height: 1rem;
--text-sm: 0.8125rem; /* 13px — rail body */
--text-sm--line-height: 1.25rem;
--text-base: 0.9375rem; /* 15px — the document */
--text-base--line-height: 1.5rem;
--text-lg: 1.125rem; /* 18px — h3 */
--text-lg--line-height: 1.5rem;
--text-xl: 1.375rem; /* 22px — h2 */
--text-xl--line-height: 1.75rem;
--text-2xl: 1.75rem; /* 28px — h1 */
--text-2xl--line-height: 2.125rem;
```

- [ ] **Step 4: Point the document headings at the scale**

In `packages/editor/src/styles.css`, replace the four heading size rules:

```css
.plan-content h1 {
	font-size: var(--text-2xl);
	line-height: var(--text-2xl--line-height);
}
.plan-content h2 {
	font-size: var(--text-xl);
	line-height: var(--text-xl--line-height);
}
.plan-content h3 {
	font-size: var(--text-lg);
	line-height: var(--text-lg--line-height);
}
.plan-content :is(h4, h5, h6) {
	font-size: var(--text-base);
}
```

The `.plan .plan-content` body rule keeps its `line-height: 1.6` (prose wants looser leading than the UI rhythm) but takes its size from the token:

```css
font-size: var(--text-base);
```

And the two chrome blocks that already sit at 11px take the token instead of the literal — `.plan-status` and `.plan-changes-bar`, `.plan-changes-list`, `.plan-changes-empty`:

```css
font-size: var(--text-2xs);
line-height: var(--text-2xs--line-height);
```

- [ ] **Step 5: Migrate every arbitrary size**

All eighteen sites collapse to `text-2xs`. Sizes go up or stay level; none shrink.

```bash
cd /Users/maggieappleton/Github/chopin
grep -rlE "text-\[(0\.5rem|10px|0\.625rem|0\.6875rem)\]" --include="*.tsx" apps packages \
  | xargs sed -i '' -E 's/text-\[(0\.5rem|10px|0\.625rem|0\.6875rem)\]/text-2xs/g'
```

Then confirm nothing was missed:

```bash
grep -rn "text-\[" --include="*.tsx" apps packages
```

Expected: no output.

- [ ] **Step 6: Run the test and watch it pass**

Run: `bun test apps/web/src/tokens.test.ts`
Expected: PASS, 10 tests, with `offenders` empty.

- [ ] **Step 7: Verify and commit**

```bash
bun run fix && bun test && bun scripts/check-tokens.ts && bun run types
git add -A
git commit -m "Step the type far enough apart to be read as steps"
```

Expected: 525+ tests pass.

---

## Task 5: Motion tokens

Replaces the bare `ease` keyword — the browser default, and the least characterful curve available — with one custom curve applied everywhere, including to the fifteen `transition-colors` utilities in components, which upgrade via Tailwind's transition defaults without being edited.

**Files:**

- Modify: `apps/web/src/theme.css`
- Modify: `apps/web/src/tokens.test.ts`
- Modify: `packages/editor/src/styles.css:428,474,630,871,902` (the five transitions)

**Interfaces:**

- Consumes: `declared()` from Task 1.
- Produces: `--ease-out`, `--ease-in-out`, `--duration-fast|base|slow|linger`, and Tailwind's `--default-transition-duration` / `--default-transition-timing-function`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/tokens.test.ts`:

```ts
const EDITOR_STYLES = readFileSync(
	join(ROOT, "packages/editor/src/styles.css"),
	"utf8",
);

describe("motion", () => {
	it("names a curve of its own rather than the browser's default", () => {
		expect(declared("--ease-out")).toStartWith("cubic-bezier");
	});

	it("hands Tailwind the same curve, so utilities and stylesheets agree", () => {
		expect(declared("--default-transition-timing-function")).toBe("var(--ease-out)");
	});

	it("leaves no transition timed or eased by a literal", () => {
		let offenders = [...EDITOR_STYLES.matchAll(/transition:[^;]+;/g)]
			.map(match => match[0])
			.filter(rule => /\d+ms|\bease(-in|-out|-in-out)?[;\s]/.test(rule));
		expect(offenders).toEqual([]);
	});
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test apps/web/src/tokens.test.ts`
Expected: FAIL — `no --ease-out in the theme`, and five literal-timed transitions listed.

- [ ] **Step 3: Declare the tokens**

In `apps/web/src/theme.css`:

```css
/*
 * Motion.
 *
 * One curve does nearly all of it. `ease`, the browser default and what this
 * project used, is symmetrical — it accelerates as long as it decelerates —
 * and symmetrical motion reads as mechanical because nothing with mass moves
 * that way. This one leaves immediately and settles slowly, so a change
 * looks like a response to the click that caused it.
 *
 * Durations are named for what they are for rather than numbered. `fast` is
 * a state change on something already under the pointer, where anything
 * slower feels like lag. `linger` belongs to the agent's change marks, which
 * are not feedback at all — they are a fade nobody is waiting on, and want
 * to be slow enough to notice without being slow enough to watch.
 */
--ease-out: cubic-bezier(0.2, 0, 0, 1);
--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);

--duration-fast: 120ms;
--duration-base: 200ms;
--duration-slow: 400ms;
--duration-linger: 600ms;

/*
 * What every `transition-*` utility in the components gets without asking.
 * Fifteen of them are already written and none name a duration or a curve,
 * so they have been running on Tailwind's defaults.
 */
--default-transition-duration: var(--duration-fast);
--default-transition-timing-function: var(--ease-out);
```

- [ ] **Step 4: Retime the five hand-written transitions**

In `packages/editor/src/styles.css`:

- `.plan-grip` (line ~428): `transition: background-color var(--duration-fast) var(--ease-out);`
- `.plan-grip-remove, .plan-insert, .plan-align` (line ~474): `transition: opacity var(--duration-fast) var(--ease-out);`
- `.plan .plan-cursor-name` (line ~630): `transition: opacity var(--duration-base) var(--ease-out);`
- `[data-plan-change]` (line ~871): `transition: background var(--duration-linger) var(--ease-out);`
- `[data-plan-gap-before], [data-plan-gap-after]` (line ~902): `transition: box-shadow var(--duration-linger) var(--ease-out);`

- [ ] **Step 5: Run the test and watch it pass**

Run: `bun test apps/web/src/tokens.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 6: Confirm the utilities picked up the curve**

In the browser, hover a toolbar button and check in the console:

```js
getComputedStyle(document.querySelector("[class*='transition-colors']")).transitionTimingFunction;
```

Expected: `cubic-bezier(0.2, 0, 0, 1)`, not `cubic-bezier(0.4, 0, 0.2, 1)`.

- [ ] **Step 7: Full verification and commit**

```bash
bun run fix && bun run ci && bun test && bun run types
git add -A
git commit -m "Move on a curve that has a direction"
```

Expected: `tokens ok`, 525+ tests pass, 0 type errors.

---

## Self-Review

**Spec coverage.** Surfaces → Task 1. Shadows → Task 2. Radius → Task 3. Type → Task 4. Motion → Task 5. The `--radius-` allowlist removal promised in `check-tokens.ts` → Task 3 Step 5. Dark mode is out of scope and appears nowhere. Press states and focus unification are out of scope and appear nowhere.

**Placeholder scan.** Every step carries its literal value or command. No "TBD", no "similar to Task N", no described-but-unshown code.

**Type consistency.** `declared()` is defined in Task 1 and used in 2, 3, 4, 5. `rems()` is defined in Task 3 and used in Task 4 — Task 4 must run after Task 3, which the ordering enforces. `ROOT` is introduced in Task 4 and reused in Task 5. `blurs()`/`opacities()` are local to Task 2.

**Known risk.** Tailwind v4 must accept a `var()` reference inside `--default-transition-timing-function`. Task 5 Step 6 verifies this in the browser rather than assuming it; if the indirection does not resolve, inline the `cubic-bezier` literal in both `--default-*` declarations and keep `--ease-out` for the stylesheets.
