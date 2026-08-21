# Chopin Mention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the public `@ai` trigger with the hard-cutover `@chopin` trigger and name Chopin in the composer.

**Architecture:** Keep addressing centralised in `packages/protocol/address.ts`, which already supplies the browser and server. Update generated messages, reader-facing copy, tests, and documentation without changing the internal `planner` wire destination.

**Tech Stack:** TypeScript, Bun test, React, Playwright, Markdown

---

### Task 1: Addressing contract

**Files:**
- Modify: `apps/server/src/chat/address.test.ts`
- Modify: `apps/web/src/chat/model.test.ts`
- Modify: `packages/protocol/address.ts`

- [ ] **Step 1: Write the failing addressing tests**

Replace trigger examples with `@chopin`, including the `displayText()` example;
add case-insensitive `@CHOPIN` coverage and this hard-cutover assertion:

```ts
it("does not recognise the retired mention", () => {
	expect(addressed("@ai draft the auth section")).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `bun test apps/server/src/chat/address.test.ts apps/web/src/chat/model.test.ts`

Expected: FAIL because `@chopin` is not recognised and `@ai` still is.

- [ ] **Step 3: Replace the shared mention**

Update `packages/protocol/address.ts` so its exported value and both regular
expressions use `@chopin`:

```ts
export const MENTION = "@chopin";
const ADDRESSED = /(^|[^\w@])@chopin\b/i;
```

Use the same token in `instruction()`'s global replacement expression and
update boundary examples in comments to `hi@chopin.dev` and `@chopina`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `bun test apps/server/src/chat/address.test.ts apps/web/src/chat/model.test.ts`

Expected: all addressing tests PASS.

- [ ] **Step 5: Commit the addressing contract**

```bash
git add apps/server/src/chat/address.test.ts apps/web/src/chat/model.test.ts packages/protocol/address.ts
git commit -m "Replace AI mention with Chopin"
```

### Task 2: Generated messages and reader-facing copy

**Files:**
- Modify: `packages/editor/src/threads.test.ts`
- Modify: `e2e/smoke.e2e.ts`
- Modify: `apps/web/src/chat/chat.tsx`
- Modify: `packages/editor/src/threads.ts`

- [ ] **Step 1: Write failing generated-message and browser tests**

Add this test to `packages/editor/src/threads.test.ts`:

```ts
it("asks Chopin to retry an unapplied accepted comment", () => {
	let sent: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
	let subject = store();
	subject.listen({
		on: () => () => {},
		send: (kind, payload) => sent.push({ kind, payload }),
		ask: async () => {
			throw new Error("not used");
		},
	});
	subject.sync([thread({ id: "t1", status: "accepted", quote: "shorten this" })]);

	subject.retry("t1");

	expect(sent).toEqual([{
		kind: "chat:send",
		payload: {
			text: '@chopin apply the accepted comment on "shorten this" — it has not been actioned yet.',
			to: "planner",
		},
	}]);
});
```

In the `chat uses one room-message composer when the planner is off` Playwright
test, select the textarea by `Use @chopin to ask Chopin`.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `bun test packages/editor/src/threads.test.ts`

Expected: FAIL because retry still sends `@ai`.

Run:

```bash
bun run e2e e2e/smoke.e2e.ts \
	--grep "chat uses one room-message composer when the planner is off"
```

Expected: FAIL because the composer still exposes the old placeholder.

- [ ] **Step 3: Update visible and generated copy**

Set the composer placeholder to:

```tsx
placeholder="Use @chopin to ask Chopin"
```

Change the accepted-comment retry message prefix in
`packages/editor/src/threads.ts` to `@chopin`.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `bun test packages/editor/src/threads.test.ts`

Expected: all thread-store tests PASS.

Run:

```bash
bun run e2e e2e/smoke.e2e.ts \
	--grep "chat uses one room-message composer when the planner is off"
```

Expected: the focused browser test PASS.

- [ ] **Step 5: Commit reader-facing copy**

```bash
git add packages/editor/src/threads.test.ts e2e/smoke.e2e.ts apps/web/src/chat/chat.tsx packages/editor/src/threads.ts
git commit -m "Name Chopin in conversation copy"
```

### Task 3: Integration examples and documentation

**Files:**
- Modify: `apps/server/src/chat/queue.test.ts`
- Modify: `apps/server/src/chat/service.ts`
- Modify: `e2e/responsive-activity.e2e.ts`
- Modify: `e2e/responsive-workspace.e2e.ts`
- Modify: `e2e/smoke.e2e.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/self-hosting.md`
- Modify: `AGENTS.md`
- Modify: `.agents/skills/testing-pr-previews/SKILL.md`

- [ ] **Step 1: Replace product trigger examples**

Replace `@ai` with `@chopin` in test messages, test names, comments, README
examples, architecture notes, self-hosting checks, project instructions, and
the preview-testing skill. Replace the Playwright placeholder selector with
`Use @chopin to ask Chopin`.

- [ ] **Step 2: Confirm no retired product trigger remains**

Run:

```bash
rg -n '@ai|Use @ai|ask the agent' \
	AGENTS.md README.md apps packages e2e docs .agents/skills/testing-pr-previews \
	--glob '!docs/superpowers/**'
```

Expected: no matches except the deliberate unit test proving that `@ai` no
longer routes.

- [ ] **Step 3: Run unit tests**

Run: `bun test`

Expected: PASS.

- [ ] **Step 4: Commit integration and documentation updates**

```bash
git add AGENTS.md README.md apps/server/src/chat/queue.test.ts \
	apps/server/src/chat/service.ts e2e/responsive-activity.e2e.ts \
	e2e/responsive-workspace.e2e.ts e2e/smoke.e2e.ts docs/architecture.md \
	docs/self-hosting.md .agents/skills/testing-pr-previews/SKILL.md
git commit -m "Update Chopin mention examples"
```

### Task 4: Repository verification

**Files:**
- Modify: any touched files changed by the formatter

- [ ] **Step 1: Format and apply safe lint fixes**

Run: `bun run fix`

Expected: command exits successfully; inspect all formatter changes.

- [ ] **Step 2: Run static checks**

Run: `bun run types`

Expected: PASS.

- [ ] **Step 3: Run repository validation**

Run: `bun run ci`

Expected: PASS.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only intended files are changed.
