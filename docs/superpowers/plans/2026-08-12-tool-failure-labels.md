# Tool Failure Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Identify each failed agent tool call in the expanded transcript tool list.

**Architecture:** `ToolRun` already renders the full `Chat.Activity` list and each activity has a terminal `status`. Render a presentational `Failed` status label only for activities whose status is `"failed"`; keep the aggregate summary and chronological rows intact. Verify it through the existing transcript smoke fixture, which already includes a failed `run_tests` activity.

**Tech Stack:** React, TypeScript, Tailwind CSS, Playwright.

---

### Task 1: Render and verify per-tool failure labels

**Files:**

- Modify: `apps/web/src/chat/transcript.tsx:60-69`
- Modify: `e2e/smoke.e2e.ts:231-238`

- [x] **Step 1: Extend the existing transcript smoke assertion**

After opening the tool run, assert that the `run_tests` row says both `Run tests` and `Failed`, and that the status label carries the same destructive colour as the summary:

```ts
let failed = chat.getByRole("listitem").filter({ hasText: "Run tests" });
await expect(failed).toContainText("Failed");
await expect(failed.getByText("Failed", { exact: true })).toHaveClass(/text-destructive-ink/);
```

- [x] **Step 2: Run the focused browser test to verify it fails**

Run: `bun run e2e -- e2e/smoke.e2e.ts --grep "shows the shared conversation"`

Expected: the assertion cannot find `Failed` in the `Run tests` row.

- [x] **Step 3: Render the label from existing status data**

In each tool-list row, insert this sibling after the existing tool-name span:

```tsx
{
	tool.status === "failed" && <span className="shrink-0 text-destructive-ink">Failed</span>;
}
```

The name span remains flexible and the duration remains right-aligned, preserving the current layout and order.

- [x] **Step 4: Re-run the focused browser test**

Run: `bun run e2e -- e2e/smoke.e2e.ts --grep "shows the shared conversation"`

Expected: PASS.

- [x] **Step 5: Run static checks and commit**

Run: `bun run types && bun run ci`

Expected: both commands exit successfully.

```bash
git add apps/web/src/chat/transcript.tsx e2e/smoke.e2e.ts
git commit -m "Show failed tool calls in transcript"
```
