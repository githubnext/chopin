# Implementation Verification Rebuild Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild PR #49 on PR #48's event-only lifecycle so every successful implementation is verified, later delivery updates reach the exact run, and verified graph versions cannot be claimed twice.

**Architecture:** `Run` remains immutable identity and gains the graph version number needed to identify one exact frozen graph. `Lifecycle` owns only active and archived event logs; one reducer validates and projects active, revision-requested, implemented, and delivered phases. MCP calls explicitly address `runId`, while the existing descriptor map and atomic live/closed sidecar paths remain the only integration seams.

**Tech Stack:** TypeScript, Bun tests, MCP JSON-RPC schemas, PostgreSQL-backed `StorageAdapter`, server-side immutable state transitions.

**Spec:** `docs/superpowers/specs/2026-08-19-implementation-verification-design.md`

---

## Global constraints

- Do not put mutable progress, verification, outcome, or delivery status on `Run` or in `tasks/graphs.ts`.
- Do not add lifecycle schema/parser/dispatch conditionals to `mcp.ts`; extend `mcp/lifecycle.ts`.
- Persist lifecycle transitions before broadcasting, and roll every in-memory field back on failure.
- Run IDs and idempotency keys are globally unique within a document.
- Status is derived from the event log; no independent `implemented` or `delivered` flag is stored.
- Use tabs, `let`, double quotes, and behaviour-named tests. Run dprint rather than hand-formatting.
- Do not stage or change the unrelated existing `docs/superpowers/plans/2026-08-18-graph-foundation-rewrite.md` file.

## File map

- `apps/server/src/tasks/graphs.ts`: immutable graph/run identity and exact graph-version restoration.
- `apps/server/src/tasks/lifecycle.ts`: lifecycle commands, event parsing, reducer, restore, transitions, and projections.
- `apps/server/src/tasks/plan-graphs.ts`: atomic live claim/lifecycle orchestration.
- `apps/server/src/plan/service.ts`: closed-channel claim/lifecycle sidecar preparation and restoration.
- `apps/server/src/mcp/lifecycle.ts`: the only lifecycle tool schema/parser registry.
- `apps/server/src/mcp.ts`: implementation-start contract and generic lifecycle dispatch only.
- `apps/server/src/mcp/hosted.ts`: authenticated live/closed adapters; no domain policy.
- `packages/protocol/plan.d.ts`: shared lifecycle projection types.
- Matching `*.test.ts` files: behaviour and malformed-sidecar coverage.

### Task 1: Give every run an exact graph identity

**Files:**

- Modify: `apps/server/src/tasks/graphs.ts`
- Modify: `apps/server/src/tasks/graphs.test.ts`
- Modify: `apps/server/src/mcp.ts`
- Modify: `apps/server/src/mcp.test.ts`
- Modify: `apps/server/src/mcp/hosted.ts`
- Modify: `apps/server/src/mcp/hosted.test.ts`

- [ ] **Step 1: Write failing graph identity tests**

Add `graphVersion: 2` to the canonical run fixture. Add assertions that `claim` and `restoreRun` accept only a run matching `Version.number`, `Version.revision`, and `Version.planRevision`. Give `restoreRunVersion` two graph versions with the same plan/revision pair and prove it resolves the run by number; a run naming a missing number must be rejected.

```ts
expect(restoreRun({ ...implementation, graphVersion: 1 }, locked, 7)).toBeUndefined();
expect(restoreRunVersion(implementation, {
	versions: [
		{ ...locked.versions[0]!, number: 1 },
		{ ...locked.versions[0]!, number: 2 },
	],
})).toEqual(implementation);
```

- [ ] **Step 2: Run the focused tests and confirm the new assertions fail**

Run: `bun test apps/server/src/tasks/graphs.test.ts`

Expected: failures because `Run`, restore, and claim do not yet understand `graphVersion`.

- [ ] **Step 3: Add exact graph identity**

Use these contracts:

```ts
export type Run = {
	id: string;
	user: string;
	client: { name: string; version: string };
	session: string;
	planRevision: number;
	graphVersion: number;
	graphRevision: number;
	repository: string;
	branch: string;
	commit: string;
	startedAt: string;
};

function matches(run: Run, version: Version): boolean {
	return run.graphVersion === version.number
		&& run.graphRevision === version.revision
		&& run.planRevision === version.planRevision;
}
```

Validate `graphVersion` as a positive safe integer during restoration. Use `matches` from `restoreRun`, `restoreRunVersion`, and `claim`; do not duplicate the three comparisons.

- [ ] **Step 4: Carry graphVersion through implementation start**

Add `graphVersion` to `ImplementationInput`, the `start_implementation` schema/parser, the hosted `run()` constructor, and every relevant fixture. It is required, positive, and must equal the current version number. Do not change lifecycle tools yet.

```ts
type ImplementationInput = {
	id: string;
	planRevision: number;
	graphVersion: number;
	graphRevision: number;
	repository: string;
	branch: string;
	commit: string;
};
```

- [ ] **Step 5: Verify and commit Task 1**

Run:

```bash
bun test apps/server/src/tasks/graphs.test.ts apps/server/src/mcp.test.ts apps/server/src/mcp/hosted.test.ts
bun run types
```

Expected: all pass.

Commit: `Model exact implementation graph identity`

### Task 2: Replace outcome snapshots with one verified event reducer

**Files:**

- Modify: `apps/server/src/tasks/lifecycle.ts`
- Modify: `apps/server/src/tasks/lifecycle.test.ts`
- Modify: `apps/server/src/mcp/lifecycle.ts` (mechanical `runId` contract so types remain green)
- Modify: lifecycle fixtures in `apps/server/src/mcp.test.ts`, `apps/server/src/mcp/hosted.test.ts`, and `apps/server/src/tasks/plan-graphs.test.ts`

- [ ] **Step 1: Add failing lifecycle behaviour tests**

Build commands with `runId: execution.id`. Add tests with these exact behaviours:

```ts
it("keeps failed verification active and returns named tasks to work", () => {});
it("archives a passing verification without storing terminal status", () => {});
it("derives delivery only after every distinct associated PR merges", () => {});
it("routes every command to its explicit run", () => {});
it("preserves revision request as an unsuccessful release", () => {});
it("rejects impossible active and archived event histories", () => {});
it("rejects duplicate run ids and idempotency keys globally", () => {});
```

Use a two-task graph, including a case where both tasks share one PR URL. Verification evidence must cover both tasks exactly once. Include a newer active run while updating an older verified run.

- [ ] **Step 2: Run the focused lifecycle tests and confirm failure**

Run: `bun test apps/server/src/tasks/lifecycle.test.ts`

Expected: the new verification types/transitions are absent and archived runs still require `outcome`.

- [ ] **Step 3: Define the event-only public model**

Use these shapes in `tasks/lifecycle.ts`:

```ts
export type VerificationEvidence = { taskId: string; evidence: string[] };
export type VerificationReport = {
	passed: boolean;
	summary: string;
	reviewerMethod: string;
	evidence: VerificationEvidence[];
	tasksNeedingWork: string[];
};

export type ArchivedRun = { run: Run; events: ProgressEvent[] };
export type HistoricalRun = {
	run: Run;
	progress: Progress;
	outcome:
		| { kind: "revision_requested"; reason: string }
		| { kind: "implemented" }
		| { kind: "delivered" };
};

type Command =
	| { kind: "start"; taskId: string; idempotencyKey: string }
	| { kind: "block"; taskId: string; reason: string; idempotencyKey: string }
	| {
		kind: "report_pr";
		taskId: string;
		url: string;
		state: PullRequest["state"];
		idempotencyKey: string;
	}
	| { kind: "complete"; taskId: string; summary: string; idempotencyKey: string }
	| ({ kind: "report_verification"; idempotencyKey: string } & VerificationReport)
	| { kind: "request_revision"; reason: string; idempotencyKey: string };

export type LifecycleInput = Command & { runId: string };
```

Stored `ProgressEvent` mirrors `Command` but omits `runId`; the containing log owns it. `Progress` may expose `verification?: VerificationReport` as a derived projection.

- [ ] **Step 4: Implement one reducer for transition and restore**

Create one private `deriveRun(tasks, run, events)` returning:

```ts
type DerivedRun =
	| { phase: "active"; progress: Progress }
	| { phase: "revision_requested"; progress: Progress; reason: string }
	| { phase: "implemented" | "delivered"; progress: Progress };
```

The reducer starts from queued tasks and applies events in order. Failed verification is non-terminal and reopens exactly `tasksNeedingWork`. Passing verification permits only matching post-verification `report_pr` events. A revision request must be final. A post-verification merged update changes every task association with the same URL and cannot move a merged URL backwards.

Use the reducer from `transition`, `restoreLifecycle`, `progressFor`, and `historyFor`. Delete `ArchivedRun.outcome`, `derive(...revisionReason)`, and any independent terminal flag. Replay must locate both the prior event and its containing run, so the same idempotency key sent with another `runId` conflicts.

- [ ] **Step 5: Enforce verification and restoration invariants**

Passing requires every task completed, every PR open or merged and owned by `run.repository`, full unique evidence coverage, and no work IDs. Failure requires a non-empty unique subset of task IDs. Restore requires exact keys, exact `Run.graphVersion` resolution, unique run IDs, global unique idempotency keys, a legal active log, and an archived terminal log.

- [ ] **Step 6: Add runId mechanically to the existing MCP registry**

Add `runId: ID` to every current lifecycle tool schema, required list, and parsed base object in `mcp/lifecycle.ts`. Do not add `report_verification` until Task 4. Update callers and fixtures without adding a second parser.

- [ ] **Step 7: Verify and commit Task 2**

Run:

```bash
bun test apps/server/src/tasks/lifecycle.test.ts apps/server/src/tasks/plan-graphs.test.ts apps/server/src/mcp.test.ts apps/server/src/mcp/hosted.test.ts
bun run types
```

Expected: all pass.

Commit: `Model verified implementation lifecycle events`

### Task 3: Prevent verified graph reclaims atomically

**Files:**

- Modify: `apps/server/src/tasks/lifecycle.ts`
- Modify: `apps/server/src/tasks/plan-graphs.ts`
- Modify: `apps/server/src/tasks/plan-graphs.test.ts`
- Modify: `apps/server/src/plan/service.ts`
- Modify: the closest closed-channel claim tests in `apps/server/src/mcp/hosted.test.ts`

- [ ] **Step 1: Add failing live and closed claim tests**

Add one test that verifies a graph, then tries to claim the exact same `{number, revision, planRevision}` and expects `already-verified`. Add another that drafts and approves the next graph version with the same plan/revision numbers and expects the new version to be claimable. Exercise both a live plan and `claimStored`.

```ts
expect(reclaim).toEqual({ kind: "refused", reason: "already-verified" });
expect(nextVersionClaim.kind).toBe("started");
```

- [ ] **Step 2: Run focused tests and confirm the duplicate claim succeeds incorrectly**

Run: `bun test apps/server/src/tasks/plan-graphs.test.ts apps/server/src/mcp/hosted.test.ts`

Expected: failure because claim eligibility currently sees only `graph`, `revision`, and `execution`.

- [ ] **Step 3: Add one canonical claim eligibility helper**

Export a pure helper from `tasks/lifecycle.ts`:

```ts
export function verified(
	lifecycle: Lifecycle,
	version: Version,
): boolean;
```

It returns true only when a historical run with the exact graph reference derives to `implemented` or `delivered`. Do not inspect JSON shapes or repeat reducer logic in callers.

- [ ] **Step 4: Check and persist eligibility inside existing atomic boundaries**

In live `claimImplementation`, call `verified` while holding `exclusive`, immediately before `claim`, and refuse `already-verified`. In `claimStored`, restore lifecycle and apply the same helper before producing the new sidecar. Keep graph lock, execution creation, and lifecycle check in the same commit. Preserve rollback on durability failure.

- [ ] **Step 5: Verify and commit Task 3**

Run:

```bash
bun test apps/server/src/tasks/plan-graphs.test.ts apps/server/src/mcp/hosted.test.ts
bun run types
```

Expected: all pass.

Commit: `Prevent verified graph reclaims`

### Task 4: Expose verification through the canonical MCP and hosted paths

**Files:**

- Modify: `apps/server/src/mcp/lifecycle.ts`
- Modify: `apps/server/src/mcp.test.ts`
- Modify: `apps/server/src/mcp/hosted.test.ts`
- Modify: `apps/server/src/tasks/plan-graphs.test.ts`
- Modify: `packages/protocol/plan.d.ts`
- Modify `apps/server/src/mcp.ts` and `apps/server/src/mcp/hosted.ts` only where shared types/projections require it

- [ ] **Step 1: Add failing MCP contract tests**

Assert `report_verification` is advertised once and parsed through `lifecycleCall`. Cover missing `runId`, malformed evidence shapes and bounded strings, and a valid report. Assert lifecycle calls still require a valid MCP session. Keep duplicate task coverage and pass/fail consistency in the domain tests from Task 2.

```ts
expect(toolNames.filter(name => name === "report_verification")).toHaveLength(1);
expect(parsed).toMatchObject({
	kind: "report_verification",
	runId: "run-1",
	passed: true,
});
```

- [ ] **Step 2: Add failing hosted persistence and broadcast tests**

Cover active completion → passing verification → idle implemented history → later PR merge by `runId` → delivered history. Repeat through a closed channel and reread the durable sidecar. While a newer run is active, merge a PR on the earlier run and assert the active log is unchanged. For a failed persistence call, assert no lifecycle broadcast and complete in-memory rollback.

- [ ] **Step 3: Add report_verification to the descriptor map**

Use the approved fields and limits:

```ts
properties: {
	id: ID,
	runId: ID,
	passed: { type: "boolean" },
	summary: TEXT,
	reviewerMethod: TEXT,
	evidence: {
		type: "array",
		minItems: 1,
		items: {
			type: "object",
			properties: {
				taskId: TASK,
				evidence: { type: "array", minItems: 1, items: TEXT },
			},
			required: ["taskId", "evidence"],
			additionalProperties: false,
		},
	},
	tasksNeedingWork: { type: "array", items: TASK },
	idempotencyKey: KEY,
}
```

Parsing enforces exact keys and string bounds. Domain validation remains responsible for task membership, unique coverage, and pass/fail consistency.

- [ ] **Step 4: Keep adapters thin and projections typed**

The hosted adapter strips only channel `id`; `runId` reaches `transition`. Reuse `reportImplementationLifecycle` and `lifecycleStored` for live and closed channels. Extend the protocol projection so `Progress` can include the latest failed `verification`, and historical outcomes can be `revision_requested`, `implemented`, or `delivered`.

- [ ] **Step 5: Verify and commit Task 4**

Run:

```bash
bun test apps/server/src/mcp.test.ts apps/server/src/mcp/hosted.test.ts apps/server/src/tasks/plan-graphs.test.ts apps/server/src/tasks/lifecycle.test.ts
bun run types
bun run ci
```

Expected: all pass.

Commit: `Require implementation verification reports`

### Task 5: Whole-branch verification and review fixes

**Files:**

- Modify only files implicated by concrete verification or final-review findings.

- [ ] **Step 1: Run every non-browser check**

```bash
bun run ci
bun run types
bun test
git diff --check origin/tq/018-report-implementation-pr-progress...HEAD
```

Expected: all pass.

- [ ] **Step 2: Run the browser suite**

Run: `bun run e2e`

Expected: all tests pass. If infrastructure fails before Playwright begins, preserve the logs and rerun once; do not call it a product failure without a test assertion.

- [ ] **Step 3: Run the thermonuclear whole-branch review**

Review the final diff against `origin/tq/018-report-implementation-pr-progress`. Confirm the event log is the only durable lifecycle truth, the MCP registry remains singular, no file crosses 1,000 lines, and no route infers run ownership.

- [ ] **Step 4: Fix only confirmed findings and rerun affected checks**

If the final review requires changes, commit them as `Harden implementation verification lifecycle`. Do not create an empty commit when the review is clean.
