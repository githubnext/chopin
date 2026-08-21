# Center Compact Rich Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Center intrinsically narrow top-level tables and Mermaid diagrams while preserving the existing full-width surface bounds and internal scrolling for wide content.

**Architecture:** Keep the existing direct-child breakout allowlist. Let a top-level table shrink-wrap to its intrinsic width, cap it at the document-relative wide size, and offset it from the prose column's centre; keep Mermaid's full-width preview and center only its rendered SVG with auto inline margins.

**Tech Stack:** CSS, Lexical/MDXEditor DOM, Playwright, Bun.

**Spec:** `docs/superpowers/specs/2026-08-21-wide-rich-surfaces-design.md`

---

### Task 1: Cover compact surface centering in the browser

**Files:**

- Modify: `e2e/responsive.ts`
- Modify: `e2e/responsive-content.e2e.ts`

**Interfaces:**

- Consumes: direct-child Lexical `table`, `[data-plan-language="mermaid"]`, and `.plan-diagram svg` DOM.
- Produces: a compact fixture and browser geometry assertions; no production API changes.

- [ ] **Step 1: Add a compact rich-surface fixture**

Add this export after `RESPONSIVE_SOURCE` in `e2e/responsive.ts`:

```ts
export const COMPACT_SURFACES_SOURCE = `# Compact surfaces

| Service | Language |
| ------- | -------- |
| Auth | Go |
| Search | Python |

\`\`\`mermaid
flowchart LR
	Client --> Gateway
\`\`\`
`;
```

- [ ] **Step 2: Write the failing centering test**

Import `COMPACT_SURFACES_SOURCE` in `e2e/responsive-content.e2e.ts`, then add this test before the existing top-level rich-surface test:

```ts
test("compact tables and diagrams stay centered without stretching", async ({ join, page, seed }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await seed(COMPACT_SURFACES_SOURCE);
	page = await join("compact-surface-reader");
	let document = content(page);
	await expect(document.getByRole("region", { name: "Diagram preview" })).toBeVisible();
	let geometry = await document.evaluate(root => {
		let rectangle = (element: Element | null) => {
			if (!element) throw new Error("compact surface is missing");
			let box = element.getBoundingClientRect();
			return { left: box.left, right: box.right, width: box.width };
		};
		let table = root.querySelector(":scope > table");
		let preview = root.querySelector(":scope > [data-plan-language='mermaid'] .plan-diagram");
		let svg = preview?.querySelector("svg") ?? null;
		let scroller = root.closest("[data-plan-scroll]");
		return {
			document: rectangle(scroller),
			preview: rectangle(preview),
			svg: rectangle(svg),
			table: {
				...rectangle(table),
				clientWidth: table?.clientWidth ?? 0,
				scrollWidth: table?.scrollWidth ?? 0,
			},
		};
	});

	let center = (box: { left: number; right: number }) => (box.left + box.right) / 2;
	expect(geometry.table.width).toBeLessThan(geometry.preview.width);
	expect(geometry.table.scrollWidth).toBe(geometry.table.clientWidth);
	expect(Math.abs(center(geometry.table) - center(geometry.document))).toBeLessThan(2);
	expect(geometry.svg.width).toBeLessThan(geometry.preview.width);
	expect(Math.abs(center(geometry.svg) - center(geometry.document))).toBeLessThan(2);
	await expectNoHorizontalOverflow(page);
});
```

- [ ] **Step 3: Run the focused test and verify it fails for left alignment**

Run:

```bash
bun run e2e e2e/responsive-content.e2e.ts --grep "compact tables and diagrams"
```

Expected: FAIL because both compact contents have centres left of the document centre.

- [ ] **Step 4: Commit the regression test**

```bash
git add e2e/responsive.ts e2e/responsive-content.e2e.ts
git commit -m "Test compact rich surface centering"
```

### Task 2: Center compact tables and Mermaid output

**Files:**

- Modify: `packages/editor/src/styles.css:467-524, 1024-1034`
- Test: `e2e/responsive-content.e2e.ts`

**Interfaces:**

- Consumes: `--plan-wide-inline-size` and the existing top-level rich-surface selectors.
- Produces: intrinsic table sizing with a document-width cap and centered Mermaid SVG output.

- [ ] **Step 1: Separate table sizing from full-width surface sizing**

Replace the shared direct-child rule in `packages/editor/src/styles.css` with a full-width rule for image and Mermaid wrappers plus an intrinsic-width rule for tables:

```css
/* Visual and data-heavy top-level blocks can use the document beyond the prose measure. */
.plan-content
	> :is(p:has(> [data-plan-src]:first-child
		+ br[data-lexical-managed-linebreak]:last-child), [data-plan-language="mermaid"]) {
	inline-size: var(--plan-wide-inline-size);
	max-inline-size: var(--plan-wide-inline-size);
	margin-inline: var(--plan-wide-inline-offset);
}

/* A compact table shrink-wraps around its columns and stays on the document's centre line. */
.plan-content > table {
	inline-size: max-content;
	max-inline-size: var(--plan-wide-inline-size);
	margin-inline: 0;
	position: relative;
	inset-inline-start: 50%;
	translate: -50% 0;
}
```

The existing `.plan-content table` rule remains the overflow owner. If its intrinsic width exceeds `--plan-wide-inline-size`, the cap creates internal horizontal overflow instead of widening the document.

- [ ] **Step 2: Center rendered Mermaid SVGs**

Extend the existing SVG rule:

```css
.plan-content .plan-diagram svg {
	display: block;
	max-width: none;
	margin-inline: auto;
}
```

Auto margins center a compact SVG; they resolve without a negative offset when the SVG is wider than its scrollport, preserving access to the leading edge.

- [ ] **Step 3: Run the compact regression test and verify it passes**

Run:

```bash
bun run e2e e2e/responsive-content.e2e.ts --grep "compact tables and diagrams"
```

Expected: PASS; the compact table and SVG share the document centre and neither stretches to the preview width.

- [ ] **Step 4: Run all responsive-content browser coverage**

Run:

```bash
bun run e2e e2e/responsive-content.e2e.ts
```

Expected: PASS, including wide table and Mermaid scrolling, narrow layouts, page containment, and table-rail alignment.

- [ ] **Step 5: Format, inspect, and validate**

Run:

```bash
bun run fix
git diff --check
bun run ci
```

Inspect `git diff` after `bun run fix`; retain only the compact fixture, browser assertions, CSS centering rules, and approved spec/plan updates. Expected: all commands pass.

- [ ] **Step 6: Commit the implementation**

```bash
git add packages/editor/src/styles.css docs/superpowers/specs/2026-08-21-wide-rich-surfaces-design.md docs/superpowers/plans/2026-08-21-center-compact-rich-surfaces.md
git commit -m "Center compact rich surfaces"
```
