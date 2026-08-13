# Planner Working State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a transient Planner “Working on it” row before an active Planner turn produces its first response.

**Architecture:** `Chat` derives a temporary `working` flag from the authoritative `busy` lifecycle and records the first Planner frame for that browser session. The row is never a protocol entry or persisted history; `Transcript` renders the normal Planner group shape, applying a text-only shimmer utility.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Bun tests, Playwright.

---

### Task 1: Model the transient row

**Files:**

- Modify: `apps/web/src/chat/model.ts`
- Test: `apps/web/src/chat/model.test.ts`

- [x] **Step 1: Write failing unit tests**

```ts
expect(group([], [], true)).toMatchObject([{
	kind: "messages",
	author: { kind: "agent" },
	working: true,
}]);
expect(group([entry("a1", { kind: "agent" }, "Answer")], [], false)[0]).not.toMatchObject({
	working: true,
});
expect(group([], [], false)).toEqual([]);
```

- [x] **Step 2: Verify the tests fail**

Run: `bun test apps/web/src/chat/model.test.ts`

Expected: failure because `group` does not yet accept active-turn state or project a working row.

- [x] **Step 3: Add the smallest projection**

```ts
let rows = [
	...entries,
	...(working
		? [{
			id: "working",
			author: { kind: "agent" },
			text: "Working on it",
			queued: false,
			working: true,
		}]
		: []),
	...queued,
];
```

Pass `connected && busy && !responded` from `Chat` through `Transcript`; keep `Chat.Entry` and the protocol unchanged.

- [x] **Step 4: Verify the focused unit tests pass**

Run: `bun test apps/web/src/chat/model.test.ts`

Expected: exit code 0.

### Task 2: Render the row and motion treatment

**Files:**

- Modify: `apps/web/src/chat/transcript.tsx`
- Modify: `apps/web/src/chat/chat.tsx`
- Modify: `apps/web/src/theme.css`
- Test: `e2e/smoke.e2e.ts`

- [x] **Step 1: Write focused browser behavior coverage**

Assert a running prompt displays one Planner row with “Working on it”, then the streamed Planner answer replaces it, and clearing active state removes it before a response.

- [x] **Step 2: Verify the browser assertion fails**

Run: `bun run e2e --grep "Planner working"`

Expected: the row is absent before implementation.

- [x] **Step 3: Render through the existing Planner group**

```tsx
let groups = group(entries, queued, busy);
<Transcript busy={busy} ... />
<span className={message.working ? "chat-working" : undefined}>{text}</span>
```

Use the current `MessageGroup` and `AgentFace`; add `chat-working` with a restrained background-position shimmer only inside `@media (prefers-reduced-motion: no-preference)`.

- [x] **Step 4: Verify targeted browser coverage passes**

Run: `bun run e2e --grep "Planner working"`

Expected: exit code 0.

### Task 3: Review and verify

**Files:**

- Verify: `apps/web/src/chat/model.ts`
- Verify: `apps/web/src/chat/transcript.tsx`
- Verify: `apps/web/src/chat/chat.tsx`
- Verify: `apps/web/src/theme.css`

- [x] **Step 1: Run format/lint, type checks, unit suite, and browser suite**

```bash
bun run ci
bun run types
bun test
bun run e2e
```

- [x] **Step 2: Self-review lifecycle boundaries**

Confirm no temporary entry crosses the wire or is stored in history; history replacement, `busy: false` after abort/failure, reconnect, and reload all remove it; the first real Planner entry suppresses it; only the text carries animation and reduced motion leaves the text static.

- [x] **Step 3: Commit the scoped implementation**

```bash
git add apps/web/src/chat/model.ts apps/web/src/chat/model.test.ts apps/web/src/chat/transcript.tsx apps/web/src/chat/chat.tsx apps/web/src/theme.css e2e/smoke.e2e.ts docs/superpowers/plans/2026-08-12-planner-working-state.md
git commit -m "Show Planner working state in chat"
```
