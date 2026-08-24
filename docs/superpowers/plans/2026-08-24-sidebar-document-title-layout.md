# Sidebar Document Title Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give single-line sidebar document titles the action buttons' space while those controls are idle, then reclaim the space when the controls appear.

**Architecture:** Keep the behaviour in the existing sidebar CSS. The action container collapses and becomes hidden at rest, expands for hover and keyboard focus, and remains expanded on coarse pointers where controls are always shown.

**Tech Stack:** React, CSS, Playwright, Bun

**Spec:** `docs/superpowers/specs/2026-08-24-sidebar-document-title-layout-design.md`

## Global Constraints

- Titles remain on one line.
- Hidden action buttons reserve no horizontal space.
- Hover and keyboard focus reveal the buttons and safely truncate the title.
- Coarse-pointer controls remain visible with 44px targets.
- Document-row right padding is 4px.

---

### Task 1: Responsive document-row action space

**Files:**

- Modify: `e2e/document-navigation.e2e.ts`
- Modify: `apps/web/src/navigation.css`
- Modify: `apps/web/src/theme.test.ts`

**Interfaces:**

- Consumes: `.project-sidebar-document`, `.project-sidebar-document-actions`, and the existing hover, focus-within, and coarse-pointer states.
- Produces: A document row whose link gains the idle action space and yields it when controls become active.

- [x] **Step 1: Write the failing browser test**

Add a Playwright test that intercepts the document catalogue with a channel titled
`Complete the implementation`, joins as a writer, and measures the real sidebar row:

```ts
test("sidebar titles use action space until document controls are active", async ({ join, page }) => {
	let title = "Complete the implementation";
	let listed = channel("cccccccc-0000-4000-8000-000000000000", title);
	await page.route(
		"**/api/repositories/octo-org/score/channels*",
		route => route.fulfill({ json: { canEdit: true, channels: [listed], repository } }),
	);

	page = await join("ana");
	let projects = sidebar(page);
	let link = projects.getByRole("link", { name: title, exact: true });
	let row = link.locator("..");
	let research = projects.getByRole("button", { name: `New research in ${title}` });
	let actions = projects.getByRole("button", { name: `Actions for ${title}` });
	let idle = await link.evaluate(element => ({
		client: element.clientWidth,
		scroll: element.scrollWidth,
	}));

	expect(idle.scroll).toBeLessThanOrEqual(idle.client);
	await expect(research).toBeHidden();
	await expect(actions).toBeHidden();

	await row.hover();
	await expect(research).toBeVisible();
	await expect(actions).toBeVisible();
	let active = await link.evaluate(element => ({
		client: element.clientWidth,
		scroll: element.scrollWidth,
	}));

	expect(active.client).toBeLessThan(idle.client);
	expect(active.scroll).toBeGreaterThan(active.client);
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun run e2e -- e2e/document-navigation.e2e.ts --grep "sidebar titles use action space"
```

Expected: FAIL because the transparent action buttons are still visible to Playwright and still
reserve width, leaving the idle title truncated.

- [x] **Step 3: Implement the minimal CSS behaviour**

Change the document row padding to `4px 4px 4px 32px`. Collapse and hide the action container at
rest, then restore it for pointer hover, focus-within, and coarse pointers:

```css
.project-sidebar-document-actions {
	display: flex;
	width: 0;
	flex: 0 0 auto;
	align-items: center;
	overflow: hidden;
	visibility: hidden;
}

.group\/document:hover .project-sidebar-document-actions,
.group\/document:focus-within .project-sidebar-document-actions,
:root[data-plan-coarse-pointer] .project-sidebar .project-sidebar-document-actions {
	width: auto;
	overflow: visible;
	visibility: visible;
}
```

Update the existing navigation spacing expectation in `theme.test.ts` from
`padding: 4px 12px 4px 32px` to `padding: 4px 4px 4px 32px`.

- [x] **Step 4: Verify GREEN and keyboard focus**

Run the focused browser test again, then extend it to focus the document link and confirm both
buttons are visible. Run it once more to verify the focus assertion passes:

```bash
bun run e2e -- e2e/document-navigation.e2e.ts --grep "sidebar titles use action space"
```

- [x] **Step 5: Format and verify the repository**

Run:

```bash
bun run fix
bun test apps/web/src/theme.test.ts
bun run types
bun run ci
bun test
```

Inspect formatter changes and confirm only the planned files changed.

- [x] **Step 6: Commit the implementation**

```bash
git add apps/web/src/navigation.css apps/web/src/theme.test.ts e2e/document-navigation.e2e.ts docs/superpowers/plans/2026-08-24-sidebar-document-title-layout.md
git commit -m "Improve sidebar document title space"
```
