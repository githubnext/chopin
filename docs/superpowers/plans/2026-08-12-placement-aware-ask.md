# Placement-aware Ask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every decision asked against an existing plan appear immediately beside the prose it affects.

**Architecture:** Extend `ask` with the current plan revision and digest-validated block addresses per question. Validate the complete batch before mutation, then create, anchor, and place each independent questionnaire before waiting for answers. Questions in a prose-free room remain unplaced until later prose is written and anchored.

**Tech Stack:** TypeScript, Bun test, Lexical/Yjs plan document, Copilot SDK custom tools, Playwright.

## Global Constraints

- Use one canonical Questionnaire node; Plan and Decisions are projections of the same node.
- A block address is exactly `{ index: number; digest: "sha256:<64 lowercase hex>" }`.
- Reject every stale or invalid batch before creating any question record or document node.
- An empty `blocks` array is valid only when the document contains no prose.
- Cards sharing one prose block retain their original ask order.
- Existing stored questionnaire records remain readable without migration.
- Follow strict RED-GREEN TDD and commit each completed task.

---

### Task 1: Enforce placement in the `ask` contract

**Files:**

- Modify: `apps/server/src/agent/arguments.ts`
- Modify: `apps/server/src/agent/arguments.test.ts`
- Modify: `apps/server/src/agent/tools.ts`
- Modify: `apps/server/src/agent/tools.test.ts`
- Modify: `apps/server/src/questions/service.ts`
- Modify: `apps/server/src/questions.service.test.ts`
- Modify: `apps/server/src/plan/room.ts`
- Modify: `apps/server/src/plan/room.test.ts`

**Interfaces:**

- Produces: `Arguments.askPlan(raw): { revision: number; questions: PositionedQuestion[] }`.
- Produces: `PositionedQuestion`, the current raw question fields plus `blocks: BlockAddress[]`.
- Produces: a placement argument for `Questions.ask` that aligns each identified question with its validated blocks.
- Produces: `room.insertQuestionnaires`, which inserts a validated batch directly at its destinations in one Yjs mutation.
- Preserves: `Questions.ask(...): Promise<Ended[]>` and independent answer lifecycles.

- [x] **Step 1: Add argument-parser RED tests**

Add tests that define the intended shape:

```ts
let parsed = askPlan({
	revision: 3,
	questions: [{
		header: "Rollout",
		question: "How should we deploy?",
		multiple: false,
		options: [{ label: "Canary", description: "Limit exposure." }],
		blocks: [{ index: 2, digest: digest() }],
	}],
});
expect(parsed.revision).toBe(3);
expect(parsed.questions[0]!.blocks).toEqual([{ index: 2, digest: digest() }]);
```

Also assert rejection of a missing revision, missing blocks, malformed digest, unknown fields, and more than ten questions.

- [x] **Step 2: Run the parser test and verify RED**

Run: `bun test apps/server/src/agent/arguments.test.ts`

Expected: FAIL because `askPlan` does not exist.

- [x] **Step 3: Add service-level RED tests**

Extend the question service test fixture with real prose and assert:

```ts
let digest = room.digests(plan.document)[0]!;
let waiting = Questions.ask(plan, server, "test", definition, {
	revision: plan.revision,
	blocks: [[{ index: 0, digest }]],
});

expect(room.project(plan.document).indexOf("Related prose."))
	.toBeLessThan(room.project(plan.document).indexOf("<Questionnaire"));
```

Before resolving `waiting`, prove the card is already inline and its stored anchor is not pending. Add separate tests proving same-block ask order, stale revision atomicity, mismatched digest atomicity, and rejection of empty blocks when prose exists. For each rejected batch, assert both `plan.records.size === 0` and no `<Questionnaire` in the projected source.

- [x] **Step 4: Run the service tests and verify RED**

Run: `bun test apps/server/src/questions.service.test.ts`

Expected: FAIL because `Questions.ask` does not yet accept or enforce placement.

- [x] **Step 5: Implement the parser and tool schema**

Add a runtime parser mirroring the JSON schema. Its result must retain normalized question fields separately from placement fields so `Questions.identify` receives no unknown `blocks` property:

```ts
export type PositionedQuestion = {
	header: string;
	question: string;
	options: Array<{ label: string; description: string }>;
	multiple: boolean;
	blocks: Array<{ index: number; digest: string }>;
};

export function askPlan(raw: unknown): {
	revision: number;
	questions: PositionedQuestion[];
};
```

Update the SDK schema and handler to require top-level `revision` and per-question `blocks`. Strip `blocks` before `Questions.identify`, then align the identified questions with the parsed block arrays.

- [x] **Step 6: Implement validate-before-mutate placement**

Extend `Questions.ask` with an optional placement input used by both the tool and existing injectors/tests:

```ts
type AskPlacement = {
	revision: number;
	blocks: Array<Array<{ index: number; digest: string }>>;
};
```

Before `Store.ask`, validate revision, cardinality, every index/digest, and the empty-block rule. Mint durable anchors against the untouched document. Add a room primitive that inserts the complete questionnaire batch directly after its validated prose blocks in one mutation, appending only entries whose block list is validly empty. After validation, create all waiters and records, attach their anchors with `pending: false`, invoke the batch room insertion, publish its single document mutation, broadcast each question, and only then await `Promise.all(waiting)`.

The room primitive must validate every destination before entering its Lexical update and preserve input order for cards sharing one block:

```ts
export type QuestionnaireInsertion = {
	value: Questionnaire;
	at?: { index: number; digest: string };
};

export function insertQuestionnaires(
	target: Document,
	insertions: QuestionnaireInsertion[],
): Mutation | undefined;
```

- [x] **Step 7: Add a tool-level contract test**

Invoke the real `ask` handler with prose, revision, and blocks. Observe the plan while its returned promise is pending; assert the questionnaire is inline and the placement update was published. Resolve the question through the existing store helpers so the handler completes.

- [x] **Step 8: Run focused GREEN verification**

Run:

```bash
bun test apps/server/src/agent/arguments.test.ts \
  apps/server/src/questions.service.test.ts \
  apps/server/src/agent/tools.test.ts
bun run types
bun run ci
```

Expected: all pass.

- [x] **Step 9: Commit Task 1**

```bash
git add apps/server/src/agent/arguments.ts apps/server/src/agent/arguments.test.ts \
  apps/server/src/agent/tools.ts apps/server/src/agent/tools.test.ts \
  apps/server/src/questions/service.ts apps/server/src/questions.service.test.ts \
  apps/server/src/plan/room.ts apps/server/src/plan/room.test.ts
git commit -m "Place asked decisions beside related prose"
```

---

### Task 2: Teach and verify the planner flow

**Files:**

- Modify: `apps/server/src/agent/planner.ts`
- Modify: `apps/server/src/agent/planner.test.ts`
- Modify: `e2e/sidecar.e2e.ts`

**Interfaces:**

- Consumes: Task 1's required `ask({ revision, questions[].blocks })` contract.
- Verifies: an unanswered canonical node appears inline in Plan and once in Decisions.

- [x] **Step 1: Add planner-prompt RED assertions**

Assert the prompt explicitly requires these behaviors:

```ts
expect(PROMPT).toContain("include its related block addresses in `ask`");
expect(PROMPT).toContain("write the relevant prose first");
expect(PROMPT).toContain("Do not collect decisions at the end of the plan");
```

- [x] **Step 2: Run the prompt test and verify RED**

Run: `bun test apps/server/src/agent/planner.test.ts`

Expected: FAIL because the prompt describes anchoring after edits but not placement-aware asks.

- [x] **Step 3: Update the planner instructions**

Preserve the decisions-first rule for a prose-free room. Add the complementary existing-plan rule: after `read_plan` or a successful `edit_plan`, pass the returned revision and exact related block addresses into `ask`; write missing context before asking; never use a trailing decision collection as a placement fallback.

- [x] **Step 4: Make the canonical-node browser coverage exercise an unanswered card**

Change the existing inline-decision fixture to an open questionnaire without `<Answer>`, resolver, or timestamp. Assert the card is visible beside its anchored paragraph in Plan, appears exactly once in Decisions, and “Show in plan” returns focus to the same canonical inline node.

- [x] **Step 5: Run focused GREEN verification**

Run:

```bash
bun test apps/server/src/agent/planner.test.ts
bun run types
bun run ci
bun run build
bun run e2e -- e2e/sidecar.e2e.ts
```

Expected: all pass.

- [x] **Step 6: Commit Task 2**

```bash
git add apps/server/src/agent/planner.ts apps/server/src/agent/planner.test.ts e2e/sidecar.e2e.ts
git commit -m "Teach the planner to ask decisions in place"
```

---

## Final Verification

- [x] Run `bun test`.
- [x] Run `bun run types`.
- [x] Run `bun run ci`.
- [x] Run `bun run build`.
- [x] Run `bun run e2e`.
- [x] Run `git diff --check` and confirm the feature worktree is clean.
- [x] Update this plan's task and verification checkboxes, then commit the tracking change.
