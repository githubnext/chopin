# Focus Indicator System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every focusable control a visible, consistent focus indicator that cannot be cropped by an app-owned clipping boundary.

**Architecture:** The web theme owns focus-ring colour, width, and offset. Ordinary controls inherit an outside offset; a clipping or scrolling surface opts its descendants into an inset offset with `data-focus-boundary`. A shared Playwright assertion checks the active ring against every clipping ancestor, while static checks stop components from inventing another focus dialect.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, plain CSS custom properties, Bun tests, Playwright

**Design:** `docs/superpowers/specs/2026-08-20-focus-indicator-system-design.md`

---

## File map

- `apps/web/src/theme.css` — owns focus tokens, the global focus rule, and the boundary override.
- `apps/web/src/tokens.test.ts` — proves the theme emits the shared focus vocabulary.
- `apps/web/src/focus.test.ts` — prevents component CSS and markup from creating a second focus dialect.
- `e2e/focus.ts` — reusable browser assertion for a focused element's painted outline.
- `packages/editor/src/callout.css` and `packages/editor/src/styles.css` — keep component state styling but relinquish focus geometry.
- `packages/editor/src/widgets/callout.tsx`, `packages/editor/src/widgets/tabs.tsx`, `packages/editor/src/toolbar/bubble.tsx`, `packages/editor/src/toolbar/slash.tsx`, `packages/editor/src/table/rails.tsx`, `packages/question/src/react/question-view.tsx` — declare necessary clipping and scrolling boundaries.
- `apps/web/src/document-picker.tsx`, `apps/web/src/repository-picker.tsx`, `packages/editor/src/card.tsx` — distinguish true scrolling boundaries from rounded outer shells.
- `packages/editor/src/changes-chip.tsx`, `packages/editor/src/styles.css`, `apps/web/src/hosted.tsx` — remove cosmetic clipping from grouped controls.
- Existing browser tests — exercise representative Radix, scrollport, rail, tab, picker, and grouped-control paths.

### Task 1: Establish the shared focus vocabulary

**Files:**

- Modify: `apps/web/src/tokens.test.ts:222-234`
- Modify: `apps/web/src/theme.css:39-45, 477-485`

- [ ] **Step 1: Write the failing theme-contract test**

Replace the focus half of `keeps focus and invalid outlines visible above their surface` with explicit shared-property expectations:

```ts
it("keeps focus and invalid outlines visible above their surface", () => {
	expect(declared("--focus-ring-color")).toBe("var(--color-brand)");
	expect(declared("--focus-ring-width")).toBe("2px");
	expect(declared("--focus-ring-offset")).toBe("2px");
	expect(THEME).toMatch(
		/\[data-focus-boundary\]\s*\{[\s\S]*--focus-ring-offset:\s*-2px/,
	);
	expect(THEME).toMatch(
		/:focus-visible\s*\{[\s\S]*outline:\s*var\(--focus-ring-width\) solid var\(--focus-ring-color\);[\s\S]*outline-offset:\s*var\(--focus-ring-offset\)/,
	);
	expect(utility("field")).toMatch(
		/&\[aria-invalid="true"\]\s*\{[\s\S]*outline:\s*2px solid var\(--color-destructive\);[\s\S]*outline-offset:\s*2px/,
	);
});
```

- [ ] **Step 2: Run the test and confirm the missing contract**

Run: `bun test apps/web/src/tokens.test.ts`

Expected: FAIL because `--focus-ring-color`, `--focus-ring-width`, `--focus-ring-offset`, and `[data-focus-boundary]` do not exist.

- [ ] **Step 3: Add the tokens and boundary rule**

Add these declarations beside the brand palette in `@theme static`:

```css
--focus-ring-color: var(--color-brand);
--focus-ring-width: 2px;
--focus-ring-offset: 2px;
```

Replace the global focus rule with:

```css
[data-focus-boundary] {
	--focus-ring-offset: -2px;
}

:where(a, button, input, select, summary, textarea, [role="button"], [tabindex]):focus-visible {
	outline: var(--focus-ring-width) solid var(--focus-ring-color);
	outline-offset: var(--focus-ring-offset);
}
```

- [ ] **Step 4: Run the focused tests**

Run: `bun test apps/web/src/tokens.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the shared contract**

```bash
git add apps/web/src/theme.css apps/web/src/tokens.test.ts
git commit -m "Add focus boundary design tokens"
```

### Task 2: Make the theme the only owner of focus geometry

**Files:**

- Modify: `apps/web/src/focus.test.ts`
- Modify: `packages/editor/src/callout.css:81-97, 127-132`
- Modify: `packages/editor/src/styles.css:97-104, 565-573, 633-638, 760-769`

- [ ] **Step 1: Expand the static guard to stylesheets**

Generalise the file walker and add a stylesheet set which excludes the theme itself:

```ts
function sources(dir: string, suffixes: string[], found: string[] = []): string[] {
	for (let entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		let path = join(dir, entry);
		if (statSync(path).isDirectory()) sources(path, suffixes, found);
		else if (suffixes.some(suffix => entry.endsWith(suffix))) found.push(path);
	}
	return found;
}

const ROOTS = [join(ROOT, "apps"), join(ROOT, "packages")];
const COMPONENTS = ROOTS.flatMap(root => sources(root, [".tsx"]));
const THEME = join(ROOT, "apps/web/src/theme.css");
const STYLES = ROOTS.flatMap(root => sources(root, [".css"]))
	.filter(file => file !== THEME);

function offenders(files: string[], pattern: RegExp): string[] {
	return files
		.filter(file => pattern.test(readFileSync(file, "utf8")))
		.map(file => file.slice(ROOT.length + 1));
}
```

Pass `COMPONENTS` to the two existing calls to `offenders`, then add:

```ts
it("keeps focus geometry in the theme", () => {
	expect(
		offenders(
			STYLES,
			/:focus-visible[^{]*\{[^}]*\boutline(?:-offset)?\s*:/s,
		),
	).toEqual([]);
});
```

- [ ] **Step 2: Run the guard and confirm the duplicate dialect**

Run: `bun test apps/web/src/focus.test.ts`

Expected: FAIL listing `packages/editor/src/callout.css` and `packages/editor/src/styles.css`.

- [ ] **Step 3: Remove component-owned focus geometry**

In `callout.css`, delete the rule which assigns an outline to `.plan-callout-type`, `.plan-callout-title`, and `.plan-callout-option`. Also delete `outline: none` from the editable title's `:focus` rule; its background and subtle edit-state shadow remain.

In `styles.css`:

- keep focus-triggered background and visibility rules;
- remove the explicit outline and offset from comment buttons and table grips;
- delete the focus-only outline block for remove, insert, and alignment controls;
- delete the focus-only inset outline block for `.plan-table-touch-action`.

The ordinary control-edge outlines on resting rail buttons are not focus geometry and remain.

- [ ] **Step 4: Run the focus and token tests**

Run: `bun test apps/web/src/focus.test.ts apps/web/src/tokens.test.ts`

Expected: PASS with no component stylesheet reported.

- [ ] **Step 5: Commit the single focus dialect**

```bash
git add apps/web/src/focus.test.ts packages/editor/src/callout.css packages/editor/src/styles.css
git commit -m "Centralize focus indicator geometry"
```

### Task 3: Add a reusable browser assertion and prove the systemic failure

**Files:**

- Create: `e2e/focus.ts`
- Modify: `e2e/callout.e2e.ts:1-38`
- Modify: `e2e/table.e2e.ts:15-20, 145-158`
- Modify: `e2e/responsive-decisions.e2e.ts:1-8, 118-130`

- [ ] **Step 1: Create the shared focus assertion**

Create `e2e/focus.ts`:

```ts
import { expect } from "@playwright/test";

import type { Locator } from "@playwright/test";

export async function expectFocusIndicator(target: Locator): Promise<void> {
	await expect(target).toBeFocused();
	let result = await target.evaluate(element => {
		let style = getComputedStyle(element);
		let width = parseFloat(style.outlineWidth);
		let offset = parseFloat(style.outlineOffset);
		let bounds = element.getBoundingClientRect();
		let html = element as HTMLElement;
		let scaleX = html.offsetWidth ? bounds.width / html.offsetWidth : 1;
		let scaleY = html.offsetHeight ? bounds.height / html.offsetHeight : 1;
		let outside = Math.max(0, width + offset);
		let clippedBy: string[] = [];
		let clips = /^(auto|clip|hidden|scroll)$/;

		for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
			let ancestorStyle = getComputedStyle(ancestor);
			let ancestorBounds = ancestor.getBoundingClientRect();
			let name = `${ancestor.tagName}.${ancestor.getAttribute("class") ?? ""}`;
			if (
				clips.test(ancestorStyle.overflowX)
				&& (bounds.left - outside * scaleX < ancestorBounds.left
					|| bounds.right + outside * scaleX > ancestorBounds.right)
			) clippedBy.push(`${name}:x`);
			if (
				clips.test(ancestorStyle.overflowY)
				&& (bounds.top - outside * scaleY < ancestorBounds.top
					|| bounds.bottom + outside * scaleY > ancestorBounds.bottom)
			) clippedBy.push(`${name}:y`);
		}

		return {
			clippedBy,
			outline: style.outlineStyle !== "none" && width >= 2,
		};
	});

	expect(result.outline).toBe(true);
	expect(result.clippedBy).toEqual([]);
}
```

- [ ] **Step 2: Use the helper on three different boundary shapes**

In `callout.e2e.ts`, import the helper and check the keyboard-focused Note option immediately after the existing `toBeFocused()` assertion:

```ts
await expectFocusIndicator(menu.getByRole("option", { name: "Note" }));
```

In the table keyboard test, establish keyboard modality before focusing the grip, then check it:

```ts
await page.keyboard.press("Tab");
let rowGrip = grip(rail, "row", 2);
await rowGrip.focus();
await expectFocusIndicator(rowGrip);
await page.keyboard.press("Meta+ArrowDown");
```

In the responsive questionnaire test, activate Next from the keyboard and check the newly focused second tab:

```ts
await next.press("Enter");
await expect(tabTargets.nth(1)).toHaveAttribute("aria-selected", "true");
await expectFocusIndicator(tabTargets.nth(1));
```

- [ ] **Step 3: Run the three browser paths and verify the geometric failures**

Run:

```bash
bun run e2e e2e/callout.e2e.ts e2e/table.e2e.ts e2e/responsive-decisions.e2e.ts --grep "callout type menu|grip moves its row|long coarse decisions"
```

Expected: at least the rail and tab-strip assertions FAIL with clipping ancestors named. The callout may pass because the current local padding workaround is still present.

### Task 4: Migrate necessary clipping and scrolling surfaces

**Files:**

- Modify: `packages/editor/src/widgets/callout.tsx:257-298`
- Modify: `packages/editor/src/callout.css:154-168`
- Modify: `packages/editor/src/widgets/tabs.tsx:60-69`
- Modify: `packages/question/src/react/question-view.tsx:441-449`
- Modify: `packages/editor/src/toolbar/bubble.tsx:306-316`
- Modify: `packages/editor/src/toolbar/slash.tsx:464-474`
- Modify: `packages/editor/src/table/rails.tsx:497-508`
- Modify: `packages/editor/src/card.tsx:52-59`
- Modify: `apps/web/src/document-picker.tsx:168-176`
- Modify: `apps/web/src/repository-picker.tsx:198-204`

- [ ] **Step 1: Replace the callout workaround with the boundary contract**

Change the Radix viewport to:

```tsx
<Select.Viewport data-focus-boundary="">
```

Restore the menu's original visual padding and remove `.plan-callout-menu-viewport`:

```css
.plan-callout-menu {
	/* existing declarations */
	padding: 0.25rem;
}
```

- [ ] **Step 2: Mark true horizontal and vertical scrollports**

Add `data-focus-boundary=""` to:

- the plan tablist in `widgets/tabs.tsx`;
- the question tablist in `question-view.tsx`;
- the formatting toolbar root in `bubble.tsx`;
- the slash-menu listbox root in `slash.tsx`;
- the row/column rail root in `rails.tsx`;
- the document picker element carrying `data-document-scroll`;
- the repository picker element carrying `data-repository-scroll`.

Keep their existing overflow declarations and interaction behaviour unchanged.

- [ ] **Step 3: Mark the sidecar's necessary composite clip**

The sidecar can contain an edge-to-edge questionnaire tab strip, so retain its `overflow-hidden` and add the boundary attribute to the article:

```tsx
<article
	aria-label={label}
	className={`flex flex-col overflow-hidden rounded-lg ring-hairline ${surface} ${
		focused ? "bg-selected" : ""
	}`}
	data-focus-boundary=""
	{...rest}
>
```

- [ ] **Step 4: Run the migrated browser paths**

Run:

```bash
bun run e2e e2e/callout.e2e.ts e2e/table.e2e.ts e2e/responsive-decisions.e2e.ts --grep "callout type menu|grip moves its row|long coarse decisions"
```

Expected: PASS, including the helper assertions while the callout menu animation is active.

- [ ] **Step 5: Run picker and sidecar regressions**

Run:

```bash
bun run e2e e2e/document-navigation.e2e.ts e2e/hosted.e2e.ts e2e/sidecar.e2e.ts
```

Expected: PASS; scrolling, roving focus, and card interaction remain unchanged.

- [ ] **Step 6: Commit the true boundaries**

```bash
git add apps/web/src/document-picker.tsx apps/web/src/repository-picker.tsx e2e/focus.ts e2e/callout.e2e.ts e2e/table.e2e.ts e2e/responsive-decisions.e2e.ts packages/editor/src/card.tsx packages/editor/src/callout.css packages/editor/src/table/rails.tsx packages/editor/src/toolbar/bubble.tsx packages/editor/src/toolbar/slash.tsx packages/editor/src/widgets/callout.tsx packages/editor/src/widgets/tabs.tsx packages/question/src/react/question-view.tsx
git commit -m "Mark focus clipping boundaries"
```

### Task 5: Remove cosmetic clipping from grouped controls

**Files:**

- Modify: `e2e/responsive-content.e2e.ts:230-250`
- Modify: `packages/editor/src/changes-chip.tsx:102-125`
- Modify: `packages/editor/src/styles.css:1172-1205`
- Modify: `apps/web/src/document-picker.tsx:144-150`
- Modify: `apps/web/src/repository-picker.tsx:175-181`
- Modify: `apps/web/src/hosted.tsx:310-320`

- [ ] **Step 1: Add a failing assertion for the agent-change pill**

Import `expectFocusIndicator` in `responsive-content.e2e.ts`. Before clicking the “What the agent changed” button, establish keyboard modality, focus it, and assert its ring:

```ts
let disclosure = chip.getByRole("button", { name: "What the agent changed" });
await ana.keyboard.press("Tab");
await disclosure.focus();
await expectFocusIndicator(disclosure);
await disclosure.click();
```

- [ ] **Step 2: Run the focused browser test and confirm the pill clips**

Run: `bun run e2e e2e/responsive-content.e2e.ts --grep "phone-320 exposes every required responsive surface"`

Expected: FAIL naming `.plan-changes-bar` as a clipping ancestor.

- [ ] **Step 3: Let the change-pill buttons own their rounded ends**

Remove `overflow: hidden` from `.plan-changes-bar`. Add logical end radii to the two controls:

```css
.plan-changes-go {
	border-start-start-radius: 9999px;
	border-end-start-radius: 9999px;
}

.plan-changes-more {
	border-start-end-radius: 9999px;
	border-end-end-radius: 9999px;
	padding-inline: 0.375rem;
	border-inline-start: var(--edge-width) solid var(--color-edge);
}
```

- [ ] **Step 4: Remove cosmetic clipping from picker shells**

Delete `overflow-hidden` from the fixed outer shell in both picker components. Their inner list scrollports retain overflow and already carry `data-focus-boundary`; the outer shell continues to draw its rounded background, hairline, and shadow.

- [ ] **Step 5: Move hosted-list corner clipping onto its edge links**

Delete `overflow-hidden` from the channel-list wrapper. Extend each link class with the edge radii:

```tsx
className={`flex min-w-0 flex-col items-start justify-between gap-1 px-4 py-4 hover:bg-hover first:rounded-t-lg last:rounded-b-lg sm:flex-row sm:items-center sm:gap-4 sm:px-5 ${
	index ? "hairline-t" : ""
}`}
```

- [ ] **Step 6: Run grouped-control and picker tests**

Run:

```bash
bun run e2e e2e/responsive-content.e2e.ts e2e/document-navigation.e2e.ts e2e/hosted.e2e.ts
```

Expected: PASS. The change-pill focus assertion passes with an outside ring, and picker/list interactions retain their rounded visual shells.

- [ ] **Step 7: Commit cosmetic clipping removal**

```bash
git add apps/web/src/document-picker.tsx apps/web/src/hosted.tsx apps/web/src/repository-picker.tsx e2e/responsive-content.e2e.ts packages/editor/src/changes-chip.tsx packages/editor/src/styles.css
git commit -m "Remove cosmetic focus clipping"
```

### Task 6: Verify the whole focus-system migration

**Files:**

- Verify only; modify a file only if a check identifies a defect in this plan's scope.

- [ ] **Step 1: Format changed sources**

Run:

```bash
bunx dprint fmt apps/web/src/theme.css apps/web/src/tokens.test.ts apps/web/src/focus.test.ts apps/web/src/document-picker.tsx apps/web/src/repository-picker.tsx apps/web/src/hosted.tsx packages/editor/src/callout.css packages/editor/src/styles.css packages/editor/src/card.tsx packages/editor/src/changes-chip.tsx packages/editor/src/table/rails.tsx packages/editor/src/toolbar/bubble.tsx packages/editor/src/toolbar/slash.tsx packages/editor/src/widgets/callout.tsx packages/editor/src/widgets/tabs.tsx packages/question/src/react/question-view.tsx e2e/focus.ts e2e/callout.e2e.ts e2e/table.e2e.ts e2e/responsive-decisions.e2e.ts e2e/responsive-content.e2e.ts
```

Expected: files format without error.

- [ ] **Step 2: Run static and type checks**

Run: `bun run ci && bun run types`

Expected: zero formatting, lint, token, or type failures.

- [ ] **Step 3: Run unit tests**

Run: `bun test`

Expected: all unit tests pass.

- [ ] **Step 4: Run the affected browser suite**

Run:

```bash
bun run e2e e2e/callout.e2e.ts e2e/table.e2e.ts e2e/responsive-decisions.e2e.ts e2e/responsive-content.e2e.ts e2e/document-navigation.e2e.ts e2e/hosted.e2e.ts e2e/sidecar.e2e.ts
```

Expected: all selected browser tests pass with no clipped focus assertion.

- [ ] **Step 5: Inspect the final diff**

Run: `git diff --check && git status --short && git log --oneline -6`

Expected: no whitespace errors; only planned changes remain, split across the commits above.

- [ ] **Step 6: Commit any formatting-only residue**

If Step 1 changed tracked files after the task commits:

```bash
git add apps/web/src packages/editor/src packages/question/src e2e
git commit -m "Format focus system changes"
```

If Step 1 produced no diff, skip this commit.
