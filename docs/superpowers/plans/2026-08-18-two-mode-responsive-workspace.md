# Two-mode Responsive Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make phones and tablets use the same full-destination workspace below 1200px, then switch directly to the desktop split workspace.

**Architecture:** Reduce the responsive classifier to `compact | split`. Compact Conversation occupies the whole workspace and hides the document; split mode preserves the existing resizable desktop layout. Delete every drawer-only branch rather than leaving a dormant third presentation.

**Tech Stack:** React, TypeScript, Bun unit tests, Playwright E2E.

---

### Task 1: Collapse the workspace model to two modes

**Files:**

- Modify: `apps/web/src/workspace-model.test.ts`
- Modify: `apps/web/src/workspace-model.ts`

- [ ] **Step 1: Write the failing boundary and presentation tests**

Replace the four-boundary expectation with:

```ts
expect([1199, 1200].map(width => workspaceMode(mediaAt(width)))).toEqual([
	"compact",
	"split",
]);
```

Replace the drawer presentation case with:

```ts
it("shows Conversation as the only compact destination on tablets", () => {
	let state: WorkspaceState = {
		conversationOpen: true,
		desktopConversationOpen: true,
	};

	expect(presentWorkspace(state, "compact", "decisions")).toMatchObject({
		documentView: "decisions",
		documentVisible: false,
		conversationVisible: true,
		separatorVisible: false,
	});
});
```

- [ ] **Step 2: Run the unit test and verify RED**

Run: `bun test apps/web/src/workspace-model.test.ts`

Expected: FAIL because 1199px currently classifies as `split` and the model still exposes `drawer`.

- [ ] **Step 3: Implement the two-mode classifier**

Use:

```ts
export type WorkspaceMode = "compact" | "split";

export const WORKSPACE_MEDIA = ["(max-width: 1199px)"] as const;

export function workspaceMode(matchMedia: (query: string) => { matches: boolean }): WorkspaceMode {
	return matchMedia(WORKSPACE_MEDIA[0]).matches ? "compact" : "split";
}
```

In `presentWorkspace`, keep only compact/split visibility and return:

```ts
return {
	documentView,
	documentVisible,
	conversationVisible,
	separatorVisible: mode === "split" && conversationVisible,
};
```

- [ ] **Step 4: Run the unit test and verify GREEN**

Run: `bun test apps/web/src/workspace-model.test.ts`

Expected: 4 passed, 0 failed.

- [ ] **Step 5: Commit the model slice**

```bash
git add apps/web/src/workspace-model.ts apps/web/src/workspace-model.test.ts
git commit -m "refactor: collapse responsive workspace to two modes"
```

### Task 2: Make tablet Conversation use the compact destination

**Files:**

- Modify: `e2e/responsive-workspace.e2e.ts`
- Modify: `apps/web/src/workspace.tsx`
- Modify: `apps/web/src/app.tsx`

- [ ] **Step 1: Rewrite the drawer tests as public compact behavior tests**

At 768px and 1199px, assert:

```ts
let conversation = page.getByRole("complementary", { name: "Conversation" });
await expect(conversation).toBeVisible();
await expect(page.getByRole("dialog", { name: "Conversation" })).toHaveCount(0);
await expect(content(page)).toBeHidden();
await expect(page.getByRole("separator", { name: "Resize the conversation" })).toHaveCount(0);
await expect(page.locator("#workspace-conversation-heading")).toBeFocused();
await page.keyboard.press("Escape");
await expect(conversation).toBeHidden();
await expect(opener).toBeFocused();
```

Change split coverage to `[1200, 1440]`. Rename the zoom test to compact presentation and assert the complementary region.

- [ ] **Step 2: Run focused E2E and verify RED**

Run:

```bash
E2E_SKIP_BUILD=1 bun scripts/e2e.ts e2e/responsive-workspace.e2e.ts --grep "tablet|1199px|1200px|200% zoom"
```

Expected: FAIL because the built app still renders the tablet drawer and 1200px is not yet the split boundary.

- [ ] **Step 3: Remove drawer-only workspace code**

In `workspace.tsx`:

- remove `useLayoutEffect`, `isolate`, and `focusable`;
- remove modal isolation and Tab trapping;
- render non-split Conversation as a normal full-width complementary region;
- remove `aria-modal`, `role="dialog"`, the drawer close toolbar, overlay width, and `documentInert`;
- keep Escape dismissal for compact Conversation;
- keep the bottom navigation for every non-split viewport.

In `app.tsx`, change compact Decisions reveal behavior to:

```ts
selectView(destination, mode === "split");
```

- [ ] **Step 4: Build and run focused E2E for GREEN**

Run:

```bash
bun run build
E2E_SKIP_BUILD=1 bun scripts/e2e.ts e2e/responsive-workspace.e2e.ts --grep "tablet|1199px|1200px|200% zoom"
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the UI slice**

```bash
git add apps/web/src/workspace.tsx apps/web/src/app.tsx e2e/responsive-workspace.e2e.ts
git commit -m "fix: use compact destinations on tablets"
```

### Task 3: Verify state continuity and full regressions

**Files:**

- Modify only if a behavior regression exposes a missing assertion.

- [ ] **Step 1: Run focused continuity coverage**

Run:

```bash
E2E_SKIP_BUILD=1 bun scripts/e2e.ts e2e/responsive-workspace.e2e.ts e2e/responsive-selection.e2e.ts e2e/sidecar.e2e.ts
```

Expected: compact draft, scroll, selection, focus, comments, and breakpoint transitions pass.

- [ ] **Step 2: Run static and unit verification**

Run:

```bash
bun test
bun run types
bun run ci
bun run build
git diff --check
```

Expected: all commands exit 0; only the repository's intentional database-dependent skips remain.

- [ ] **Step 3: Run the full browser suite**

Run: `E2E_SKIP_BUILD=1 bun scripts/e2e.ts`

Expected: all browser tests pass.

- [ ] **Step 4: Commit any test-only corrections**

If verification required behavior-level assertion corrections:

```bash
git add e2e
git commit -m "test: cover two-mode responsive workspace"
```

Otherwise, leave the two implementation commits as the complete change.
