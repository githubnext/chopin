# Wide Rich Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let top-level tables, images, and Mermaid blocks use the document width without widening prose or nested components.

**Architecture:** Keep `.plan-content` as the centred 40rem prose column. Define one document-relative inline size on that root, then apply it only to direct-child tables, image decorators, and Mermaid code blocks; existing local overflow remains responsible for intrinsically wider content.

**Tech Stack:** CSS container query units, Lexical/MDXEditor DOM, Playwright, Bun.

**Spec:** `docs/superpowers/specs/2026-08-21-wide-rich-surfaces-design.md`

## Global Constraints

- Align wide surfaces with the document's existing inline gutters.
- Do not upscale images beyond their natural width.
- Keep nested rich surfaces inside callouts, tabs, and other authored components.
- Keep callouts, tabs, questionnaires, ordinary code blocks, display maths, and prose at the existing measure.
- Preserve table and Mermaid internal scrolling and prevent document-level horizontal overflow.
- Use browser integration coverage for layout and geometry.

---

### Task 1: Widen the explicit top-level surface allowlist

**Files:**

- Modify: `e2e/responsive.ts:26-120`
- Modify: `e2e/responsive-content.e2e.ts:392-497`
- Modify: `packages/editor/src/styles.css:318-330, 462-520`

**Interfaces:**

- Consumes: `.plan-document` as the existing inline-size container; `--plan-gutter`; Lexical's direct-child `table`, standalone-image paragraph, and `[data-plan-language="mermaid"]` DOM.
- Produces: `--plan-wide-inline-size` and `--plan-wide-inline-offset` CSS properties scoped to `.plan-content`; no TypeScript API changes.

- [ ] **Step 1: Add a contained rich-surface fixture**

Add a second image inside the existing callout in `RESPONSIVE_SOURCE`:

```mdx
<Callout id="${CALLOUT}" type="warning" title="Every visible control stays compact while authored content scrolls without widening the document">

Every visible control and focused element stays inside the visual viewport.

![Contained callout reference](${RESPONSIVE_IMAGE_URL})

</Callout>
```

This reuses the routed image and gives the layout test a nested surface that must not break out.

- [ ] **Step 2: Write the failing wide-layout test**

Add this test before `narrow documents keep equal inline gutters` in `e2e/responsive-content.e2e.ts`:

```ts
test("top-level rich surfaces use the document width while nested surfaces stay contained", async ({ join, page, seed }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await routeResponsiveImage(page);
	await seed(RESPONSIVE_SOURCE);
	page = await join("wide-surface-reader");
	let document = content(page);
	await expect(document.getByRole("img", { name: "Responsive workspace reference" })).toBeVisible();
	await expect(document.getByRole("img", { name: "Contained callout reference" })).toBeVisible();
	await expect(document.getByRole("region", { name: "Diagram preview" })).toBeVisible();
	let geometry = await document.evaluate(root => {
		let rectangle = (element: Element | null) => {
			if (!element) throw new Error("responsive surface is missing");
			let box = element.getBoundingClientRect();
			return { left: box.left, right: box.right, width: box.width };
		};
		let imageRow = root.querySelector(
			":scope > p:has(> [data-plan-src]:first-child + br[data-lexical-managed-linebreak]:last-child)",
		);
		let image = imageRow?.querySelector<HTMLImageElement>(
			'img[alt="Responsive workspace reference"]',
		) ?? null;
		let callout = root.querySelector('[data-plan-type="warning"]');
		let nested = callout?.querySelector<HTMLImageElement>(
			'img[alt="Contained callout reference"]',
		) ?? null;
		let scroller = root.closest("[data-plan-scroll]");
		let style = getComputedStyle(root);
		return {
			callout: rectangle(callout),
			document: rectangle(scroller),
			gutter: Number.parseFloat(style.paddingInlineStart),
			image: { ...rectangle(image), naturalWidth: image?.naturalWidth ?? 0 },
			imageRow: rectangle(imageRow),
			mermaid: rectangle(root.querySelector(':scope > [data-plan-language="mermaid"]')),
			nested: rectangle(nested),
			prose: rectangle(root.querySelector(":scope > p")),
			table: rectangle(root.querySelector(":scope > table")),
		};
	});

	let left = geometry.document.left + geometry.gutter;
	let right = geometry.document.right - geometry.gutter;
	for (let surface of [geometry.table, geometry.imageRow, geometry.mermaid]) {
		expect(Math.abs(surface.left - left)).toBeLessThan(2);
		expect(Math.abs(surface.right - right)).toBeLessThan(2);
		expect(surface.width).toBeGreaterThan(geometry.prose.width);
	}
	expect(geometry.image.width).toBeLessThanOrEqual(geometry.image.naturalWidth);
	expect(geometry.image.width).toBeLessThanOrEqual(geometry.imageRow.width);
	expect(
		Math.abs(
			(geometry.image.left + geometry.image.right) / 2
				- (geometry.imageRow.left + geometry.imageRow.right) / 2,
		),
	).toBeLessThan(2);
	expect(geometry.nested.left).toBeGreaterThanOrEqual(geometry.callout.left);
	expect(geometry.nested.right).toBeLessThanOrEqual(geometry.callout.right);
	await expectNoHorizontalOverflow(page);
});
```

- [ ] **Step 3: Extend the narrow-layout assertion**

Inside the existing `narrow documents keep equal inline gutters` loop, after the padding checks,
measure the direct-child wrappers and assert that they reduce to the available prose width:

```ts
let widths = await content(page).evaluate(root => {
	let style = getComputedStyle(root);
	let available = root.clientWidth
		- Number.parseFloat(style.paddingInlineStart)
		- Number.parseFloat(style.paddingInlineEnd);
	let selectors = [
		":scope > table",
		":scope > p:has(> [data-plan-src]:first-child + br[data-lexical-managed-linebreak]:last-child)",
		':scope > [data-plan-language="mermaid"]',
	];
	return {
		available,
		surfaces: selectors.map(selector =>
			root.querySelector(selector)!.getBoundingClientRect().width
		),
	};
});
for (let surface of widths.surfaces) expect(Math.abs(surface - widths.available)).toBeLessThan(2);
```

- [ ] **Step 4: Run the focused browser test and confirm the layout contract fails**

Run:

```bash
bun run e2e e2e/responsive-content.e2e.ts
```

Expected: the new 1440px test fails because the table, image, and Mermaid block still equal the prose width. Existing containment tests should continue to pass.

- [ ] **Step 5: Add the minimal breakout CSS**

Add the shared measurements to `.plan .plan-content`:

```css
.plan .plan-content {
	--plan-wide-inline-size: calc(100cqi - 2 * var(--plan-gutter));
	--plan-wide-inline-offset: calc((100% - var(--plan-wide-inline-size)) / 2);
}
```

After the general image sizing rule, add the direct-child allowlist and image centring:

```css
/* Visual and data-heavy top-level blocks can use the document beyond the prose measure. */
.plan-content
	> :is(table, p:has(> [data-plan-src]:first-child
		+ br[data-lexical-managed-linebreak]:last-child), [data-plan-language="mermaid"]) {
	inline-size: var(--plan-wide-inline-size);
	max-inline-size: var(--plan-wide-inline-size);
	margin-inline: var(--plan-wide-inline-offset);
}

/* The decorator owns the wide row; the image keeps its intrinsic size inside it. */
.plan-content
	> p:has(> [data-plan-src]:first-child + br[data-lexical-managed-linebreak]:last-child) {
	display: grid;
	place-items: center;
}
```

Do not loosen the descendant `table`, `img`, `svg`, `.plan-diagram`, or component containment rules; they continue to protect nested content and intrinsic overflow.

- [ ] **Step 6: Run the focused browser test and confirm it passes**

Run:

```bash
bun run e2e e2e/responsive-content.e2e.ts
```

Expected: PASS at the existing responsive viewports and the new 1440px geometry case; no page-level horizontal overflow.

- [ ] **Step 7: Format, inspect, and run repository validation**

Run:

```bash
bun run fix
git diff --check
bun run ci
```

Inspect `git diff` after `bun run fix`; retain only the fixture, browser assertions, and CSS allowlist changes. Expected: all commands pass.

- [ ] **Step 8: Commit the implementation**

```bash
git add e2e/responsive.ts e2e/responsive-content.e2e.ts packages/editor/src/styles.css
git commit -m "Widen top-level rich surfaces"
```
