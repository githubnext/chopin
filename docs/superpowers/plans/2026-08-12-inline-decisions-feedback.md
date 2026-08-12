# Inline Decisions Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the inline-decisions prototype so activity is legible, each decision is independently answerable, and the same decision appears inline in the plan and in the focused Decisions view.

**Architecture:** New questions become independently owned one-question questionnaire records and document nodes, even when the planner asks several in one tool call. The plan remains canonical; the Decisions view projects those same nodes into a focused stack. Work is split across four isolated BB worktrees, each based on the latest `feature/decision-first-inline`; Task 4 starts only after Task 3 is merged.

**Tech Stack:** React, TypeScript, Lexical/Yjs, Bun, Playwright, Phosphor Icons.

## Global Constraints

- Use Phosphor Icons for product icons; do not add hand-authored SVG icons.
- Do not use an animated activity icon.
- Each decision must be answerable and saveable independently.
- The Plan and Decisions views must show the same canonical decisions, not copies.
- Preserve compatibility with stored multi-question questionnaires.
- Follow test-driven development and commit the completed change on the task branch.

---

### Task 1: Make planner activity legible and finite

**Status:** Complete in `9325d7d`; merged by `332101e`.

**Files:**

- Modify: `apps/web/src/chat/model.ts`
- Modify: `apps/web/src/chat/transcript.tsx`
- Modify: `apps/web/package.json` or the owning workspace manifest if Phosphor is not already available
- Test: the existing chat model/render tests and a focused browser test when DOM behavior is required

**Interfaces:**

- Consumes: transcript tool activity events.
- Produces: a finite activity summary with human-readable copy and a static Phosphor icon.

**Acceptance:**

- [x] Reproduce why an `ask` activity remains in the running state after its completed children are shown.
- [x] Add a failing regression test for that lifecycle.
- [x] Fix the lifecycle rather than merely hiding the spinner.
- [x] Replace `Spinner`, `Caret`, and other touched handwritten transcript SVGs with suitable Phosphor components.
- [x] Replace raw tool names such as `ask` with reader-facing copy such as “Questions”.
- [x] Show a quiet static state; no rotating or looping icon remains.
- [x] Run focused tests, `bun run types`, and `bun run ci`.

### Task 2: Remove the waiting-question row

**Status:** Complete in `94555bf`; merged by `22d2993`.

**Files:**

- Modify: `apps/web/src/chat/chat.tsx`
- Modify: callers/types if the `waiting` or `onReveal` props become unused
- Modify: `e2e/sidecar.e2e.ts`

**Interfaces:**

- Consumes: current Chat props.
- Produces: chat with no “X questions are waiting” row; decision discovery remains in document navigation.

**Acceptance:**

- [x] Add or adjust a test that proves the waiting row is absent when questions exist.
- [x] Remove the row, its dot, its Answer action, and any props used only by that row.
- [x] Keep the document-level Decisions count and navigation intact.
- [x] Run focused tests, `bun run types`, and `bun run ci`.

### Task 3: Give every decision its own independently saveable card

**Status:** Complete in `761ee93`; merged by `649630e`.

**Files:**

- Modify: `apps/server/src/questions/service.ts`
- Modify: `apps/server/src/questions/store.ts` only where individual ownership requires it
- Modify: `apps/server/src/agent/tools.ts`
- Modify: `packages/editor/src/widgets/questionnaire.tsx`
- Modify: `packages/question/src/react/question-view.tsx` or extract a focused single-question view
- Modify: `packages/editor/src/decisions.tsx`
- Test: corresponding question, editor, server, and Playwright suites

**Interfaces:**

- Consumes: one planner `ask` call containing one to ten questions.
- Produces: one canonical questionnaire record/node per question and an aggregate tool result after all individual decisions settle.

**Acceptance:**

- [x] Add failing service tests proving a multi-question `ask` creates individually addressed records/nodes.
- [x] Add failing UI tests proving questions render as separate cards without a tablist.
- [x] Add a browser test proving one card can be saved while another remains unanswered.
- [x] Keep one planner tool call waiting for all individual outcomes, returning answers in original order.
- [x] Render each one-question node as the Figma `161:425` card in both Plan and Decisions views.
- [x] Keep old multi-question stored nodes readable through a compatibility renderer; do not silently corrupt or discard their answers.
- [x] Use Phosphor icons for card actions.
- [x] Run focused tests, `bun test`, `bun run types`, `bun run ci`, and relevant Playwright tests.

### Task 4: Place canonical decision cards beside related plan content

**Status:** In progress in BB thread `thr_dq7att69az`.

**Files:**

- Modify: `apps/server/src/questions/service.ts`
- Modify: `apps/server/src/questions/anchors.ts`
- Modify: `apps/server/src/agent/tools.ts`
- Modify: `apps/server/src/plan/room.ts`
- Modify: `packages/editor/src/decisions.tsx` only if focused projection needs adjustment
- Test: server plan/question tests and `e2e/sidecar.e2e.ts`

**Interfaces:**

- Consumes: independently owned decision nodes from Task 3 and their existing question-to-prose anchors.
- Produces: canonical nodes positioned next to related prose, with the focused Decisions view continuing to aggregate those same nodes.

**Acceptance:**

- [ ] Add a failing test proving a decision can be inserted or relocated beside a validated related block.
- [ ] Extend the planner contract so placement uses a block index plus digest, rejecting stale placement rather than landing on unrelated prose.
- [ ] Keep decisions-first behavior: a decision without prose may remain in the isolated Decisions view until related plan content exists.
- [ ] When prose is created and anchored, place the decision node adjacent to its related content without duplicating it.
- [ ] Add a browser test proving Plan shows the card inline and Decisions shows the same decision in isolation.
- [ ] Preserve the unanswered count and new-decision attention treatment.
- [ ] Run `bun test`, `bun run types`, `bun run ci`, `bun run build`, and relevant Playwright tests.

## Integration Order

- [x] Merge Task 1 into `feature/decision-first-inline` after review.
- [x] Merge Task 2 into `feature/decision-first-inline` after review.
- [x] Merge Task 3 into `feature/decision-first-inline` after review.
- [ ] Start and merge Task 4 from the resulting feature-branch head.
- [ ] Run the full verification suite on the integrated feature branch.
