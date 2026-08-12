# Inline Decisions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the right decisions rail with inline decision cards, a focused Decisions view, and document-anchored comments while preserving one collaborative MDX document.

**Architecture:** Questionnaire and accepted-comment nodes remain canonical MDX blocks. `QuestionnaireStore` publishes document shape to the host, widget renderers draw those blocks inline from live editor options, and a document overlay draws open comments from `ThreadStore` without entering Yjs. The web shell keeps `PlanEditor` mounted and switches only the visible projection.

**Tech Stack:** React 19, TypeScript, Lexical/MDXEditor, Yjs, Tailwind CSS v4 tokens, Bun tests, Playwright.

---

## Global constraints

- Work on `feature/decision-first-inline` in the existing BB-managed linked worktree.
- The Figma references are [Stacks 1](https://www.figma.com/design/Px4tP6QSzRgNe6St0Yah64/Chopin-foundations-%E2%80%94-colour?node-id=146-1872&t=2hnlx2rWTmAxqLNG-4) and [Inline 1](https://www.figma.com/design/Px4tP6QSzRgNe6St0Yah64/Chopin-foundations-%E2%80%94-colour?node-id=147-2008&t=2hnlx2rWTmAxqLNG-4). Use the repository's existing tokens and controls rather than copying generated Tailwind values.
- There is one document and one authoritative questionnaire/thread record. View choice, hover, pinning, counts and scroll restoration are local UI state.
- Later questions must not change view, scroll or selection. Only a questionnaire-only opening document forces Decisions view.
- Focused Decisions contains questionnaires only. Open comments and accepted-comment decisions stay in Plan.
- Keep `PlanEditor` mounted in both views. Do not add a room phase, protocol field, state migration, modal, notification centre, icon dependency or mobile redesign.
- The conversation rail defaults to `280px` and clamps to `240–400px`.
- Use TDD for every task: capture a relevant RED failure before implementation and GREEN output afterwards in the task report.
- Focused tests run during iteration. Before each task commit run its focused tests plus `bun run types`. Use `TMPDIR=/private/tmp` for commands that spawn Bun servers.

## File structure

- `packages/editor/src/decision-state.ts` — pure unanswered-count and visible-view rules.
- `packages/editor/src/questionnaires.ts` — observes questionnaire nodes and whether ordinary plan content exists.
- `packages/editor/src/widget-options.ts` — live host options shared by decorator renderers and editor plugins.
- `packages/editor/src/widgets/questionnaire.tsx` — shared focused/inline questionnaire surfaces.
- `packages/editor/src/widgets/decision.tsx` — compact accepted-comment decision record.
- `packages/editor/src/comment-geometry.ts` — pure gutter/popover placement arithmetic.
- `packages/editor/src/comment-layer.tsx` — DOM adapter for comment buttons, previews, pinned threads and orphan fallback.
- `packages/editor/src/threads.ts` — durable thread/anchor resolution and fallback target state.
- `packages/editor/src/decisions.tsx` — questionnaire-only focused Decisions projection.
- `apps/web/src/workspace.tsx` — narrower two-column shell that keeps both document projections mounted.
- `apps/web/src/app.tsx` — view preference, count control, reveal routing and shell composition.
- `apps/server/src/agent/planner.ts` — opening-flow instruction.
- `e2e/sidecar.e2e.ts` and `e2e/shell.e2e.ts` — renamed behaviour coverage for inline decisions, comments and shell.

### Task 1: Derive decision count and opening view from the document

**Files:**

- Create: `packages/editor/src/decision-state.ts`
- Create: `packages/editor/src/decision-state.test.ts`
- Create: `packages/editor/src/questionnaires.test.ts`
- Modify: `packages/editor/src/questionnaires.ts`
- Modify: `packages/editor/src/index.ts`

- [ ] **Step 1: Write failing tests for the pure view rules**

Create `decision-state.test.ts` with these behaviours:

```ts
import { describe, expect, it } from "bun:test";

import { countUnanswered, visibleDecisionView } from "./decision-state";

import type { QuestionnaireEntry } from "./questionnaires";

function entry(answers: Array<string | undefined>): QuestionnaireEntry {
	return {
		id: String(answers.length),
		value: {
			id: String(answers.length),
			questions: answers.map((answer, index) => ({
				id: `q${index}`,
				header: `Question ${index + 1}`,
				prompt: `Question ${index + 1}?`,
				multiple: false,
				options: [],
				...(answer === undefined ? {} : { answer }),
			})),
		},
	};
}

describe("decision attention", () => {
	it("counts unresolved questions rather than questionnaire cards", () => {
		expect(countUnanswered([entry([undefined, undefined]), entry(["Done"])]))
			.toBe(2);
	});

	it("forces only a questionnaire-only opening document into Decisions", () => {
		expect(visibleDecisionView("plan", false, 2)).toBe("decisions");
		expect(visibleDecisionView("plan", true, 2)).toBe("plan");
		expect(visibleDecisionView("decisions", true, 0)).toBe("decisions");
	});
});
```

- [ ] **Step 2: Run the pure test and capture RED**

Run: `bun test packages/editor/src/decision-state.test.ts`

Expected: FAIL because `decision-state.ts` does not exist.

- [ ] **Step 3: Implement the pure state module**

Create `decision-state.ts`:

```ts
import type { QuestionnaireEntry } from "./questionnaires";

export type DecisionView = "plan" | "decisions";

export function countUnanswered(entries: QuestionnaireEntry[]): number {
	return entries.reduce(
		(total, entry) =>
			total + entry.value.questions.filter(question => question.answer === undefined).length,
		0,
	);
}

export function visibleDecisionView(
	preferred: DecisionView,
	hasPlanContent: boolean,
	unanswered: number,
): DecisionView {
	return !hasPlanContent && unanswered > 0 ? "decisions" : preferred;
}
```

- [ ] **Step 4: Write a failing document-shape test**

In `questionnaires.test.ts`, build headless Lexical editors containing an empty paragraph, questionnaire-only source, and ordinary Markdown source. Assert `collectPlanState()` returns `{ entries, hasPlanContent }`, where an empty paragraph and `<Questionnaire>` do not count as plan content, but a paragraph, table, image or code block does.

- [ ] **Step 5: Run the document-shape test and capture RED**

Run: `bun test packages/editor/src/questionnaires.test.ts`

Expected: FAIL because `collectPlanState` and `hasPlanContent` do not exist.

- [ ] **Step 6: Publish document shape through `QuestionnaireStore`**

In `questionnaires.ts`:

```ts
export type PlanQuestionnaireState = {
	entries: QuestionnaireEntry[];
	hasPlanContent: boolean;
};

export function collectPlanState(): PlanQuestionnaireState {
	let entries = collectQuestionnaires();
	let hasPlanContent = $getRoot().getChildren().some(node => {
		if ($isQuestionnaireNode(node) || $isDecisionNode(node)) return false;
		if ($isParagraphNode(node) && node.getChildrenSize() === 0) return false;
		return true;
	});
	return { entries, hasPlanContent };
}
```

Store `#state` as one `PlanQuestionnaireState`, compare the whole value before publishing, retain `snapshot()` as the entries snapshot for compatibility, add `contentSnapshot = () => this.#state.hasPlanContent`, and make `QuestionnaireObserver` call `store.set(collectPlanState())`. Export:

```ts
export function useHasPlanContent(store: QuestionnaireStore): boolean {
	let subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
	return useSyncExternalStore(subscribe, store.contentSnapshot, store.contentSnapshot);
}
```

Update the barrel exports.

- [ ] **Step 7: Run focused GREEN tests and types**

Run:

```bash
bun test packages/editor/src/decision-state.test.ts packages/editor/src/questionnaires.test.ts
bun run types
```

Expected: all focused tests pass and types exit 0.

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/editor/src/decision-state.ts packages/editor/src/decision-state.test.ts packages/editor/src/questionnaires.ts packages/editor/src/questionnaires.test.ts packages/editor/src/index.ts
git commit -m "Derive the decision view from plan content"
```

### Task 2: Render questionnaire and accepted-comment nodes inline

**Files:**

- Create: `packages/editor/src/widget-options.ts`
- Create: `packages/editor/src/widgets/decision.test.tsx`
- Modify: `packages/editor/src/widgets-plugin.tsx`
- Modify: `packages/editor/src/plan-editor.tsx`
- Modify: `packages/editor/src/widgets/questionnaire.tsx`
- Modify: `packages/editor/src/widgets/decision.tsx`
- Modify: `packages/editor/src/styles.css`

- [ ] **Step 1: Write a failing accepted-decision rendering test**

Export `DecisionCard` and use `renderToStaticMarkup` in `decision.test.tsx` to assert that a decision containing a quote, two notes, accepter and timestamp renders an article named `Decision`, the frozen quote, both attributed notes and `Accepted by @ana`.

- [ ] **Step 2: Run the rendering test and capture RED**

Run: `bun test packages/editor/src/widgets/decision.test.tsx`

Expected: FAIL because `DecisionCard` does not exist.

- [ ] **Step 3: Move live widget options into a cycle-free module**

Create `widget-options.ts`:

```ts
import { Cell } from "@mdxeditor/gurx";

import type { ChangeStore } from "./changes";
import type { QuestionnaireStore } from "./questionnaires";
import type { ThreadStore } from "./threads";
import type { Transport } from "./transport";

export type WidgetOptions = {
	questions?: QuestionnaireStore;
	threads?: ThreadStore;
	changes?: ChangeStore;
	wire?: Transport;
	connected?: boolean;
};

export const widgets$ = Cell<WidgetOptions>({});
```

Have `widgets-plugin.tsx` import and re-export these names. Pass `wire` and `connected: !offline` from `PlanEditor` to `widgetsPlugin`.

- [ ] **Step 4: Render questionnaires from live options**

Replace the null renderer with a small component that reads `widgets$` using `useCellValue`, gets the node's current value and id, and renders `QuestionnaireCard`. Wire related-passage callbacks only when `options.questions` exists:

```tsx
function InlineQuestionnaire({ node }: { node: QuestionnaireNode }) {
	let options = useCellValue(widgets$);
	let value = node.getQuestionnaire();
	return (
		<QuestionnaireCard
			connected={options.connected}
			onQuestionEnter={question => options.questions?.highlight(value.id, question)}
			onQuestionLeave={() => options.questions?.clear()}
			onQuestionSelect={question => options.questions?.reveal(value.id, question)}
			places={options.questions?.counts(value.id)}
			value={value}
			wire={options.wire}
		/>
	);
}
```

Keep the shared `QuestionnaireCard` unchanged so inline and focused surfaces join the same existing controller.

- [ ] **Step 5: Implement the compact accepted decision card**

Render a settled `SidecarCard` labelled `Decision`, with `Provenance verb="Accepted"`, the decision quote in a blockquote, and each note in order with `@handle`. `renderDecision(node)` returns `<DecisionCard value={node.getDecision()} />`.

- [ ] **Step 6: Expose the blocks in editor CSS**

Remove the `display: none` rule. Give both decorator hosts vertical margin and make their articles fill the prose measure. Keep the existing page, edge, radius, shadow and typography tokens; add no new palette values.

- [ ] **Step 7: Run focused GREEN tests, registry coverage and types**

Run:

```bash
bun test packages/editor/src/widgets/decision.test.tsx packages/dialect/src/registry.test.ts packages/question/src/react/use-questionnaire.test.ts
bun run types
```

Expected: all commands exit 0.

- [ ] **Step 8: Commit Task 2**

```bash
git add packages/editor/src/widget-options.ts packages/editor/src/widgets-plugin.tsx packages/editor/src/plan-editor.tsx packages/editor/src/widgets/questionnaire.tsx packages/editor/src/widgets/decision.tsx packages/editor/src/widgets/decision.test.tsx packages/editor/src/styles.css
git commit -m "Render decisions inside the plan"
```

### Task 3: Preserve comment targets when their exact phrase drifts

**Files:**

- Modify: `packages/editor/src/threads.ts`
- Modify: `packages/editor/src/threads.test.ts`
- Modify: `packages/editor/src/places.test.ts`

- [ ] **Step 1: Write failing fallback and orphan tests**

Extend the headless placement fixtures to cover:

```ts
it("keeps a gutter target when the phrase changed but its block survived", () => {
	// Mark a phrase, replace its text while retaining the block, then refresh.
	let view = subject.snapshot().threads[0]!;
	expect(view.places).toEqual([]);
	expect(view.targetKey).toBeDefined();
	expect(view.drifted).toBe(true);
	expect(view.orphaned).toBe(false);
});

it("calls a thread orphaned only when every subject block is gone", () => {
	// Delete the complete subject block, then refresh.
	let view = subject.snapshot().threads[0]!;
	expect(view.targetKey).toBeUndefined();
	expect(view.orphaned).toBe(true);
});
```

Also assert accepted threads do not become orphan toolbar entries: their inline `<Decision>` is their durable surface.

- [ ] **Step 2: Run the placement tests and capture RED**

Run: `bun test packages/editor/src/threads.test.ts packages/editor/src/places.test.ts`

Expected: FAIL because `targetKey` and `orphaned` are absent.

- [ ] **Step 3: Extend `ThreadView` with UI-independent placement state**

Add:

```ts
/** Block used for a gutter button when the exact phrase no longer resolves. */
targetKey?: string;
/** An open thread with no surviving subject block. */
orphaned: boolean;
```

Refactor subject resolution to return both exact `places` and the first resolved top-level subject block. Exact result anchors still win for accepted threads. For an open thread:

```ts
let subjectKeys = subject.blocks
	.map(block => resolve(binding, block))
	.filter((key): key is string => !!key);
let found = locate(binding, subject) ?? this.#recover(binding, subject);
return {
	places: found ? [found] : [],
	...(subjectKeys[0] ? { targetKey: subjectKeys[0] } : {}),
};
```

Set `orphaned` only for open threads with no exact place and no target key. Malformed anchors remain visible and guarded as today.

- [ ] **Step 4: Keep open comment washes present without exposing accepted comments**

During `#rebuild`, collect exact places for every open thread into the comment mark list. Accepted threads are no longer part of comment chrome and are marked only through their inline decision record.

- [ ] **Step 5: Run focused GREEN tests and types**

Run:

```bash
bun test packages/editor/src/threads.test.ts packages/editor/src/places.test.ts packages/editor/src/marks.test.ts
bun run types
```

Expected: all commands exit 0 with no console noise.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/editor/src/threads.ts packages/editor/src/threads.test.ts packages/editor/src/places.test.ts
git commit -m "Keep drifted comments reachable"
```

### Task 4: Draw comment buttons and popovers over the document

**Files:**

- Create: `packages/editor/src/comment-geometry.ts`
- Create: `packages/editor/src/comment-geometry.test.ts`
- Create: `packages/editor/src/comment-layer.tsx`
- Modify: `packages/editor/src/comments.tsx`
- Modify: `packages/editor/src/threads.ts`
- Modify: `packages/editor/src/toolbar/index.tsx`
- Modify: `packages/editor/src/widgets-plugin.tsx`
- Modify: `packages/editor/src/styles.css`
- Modify: `e2e/sidecar.e2e.ts`

- [ ] **Step 1: Write failing pure geometry tests**

Use plain rectangle records to assert that a gutter button aligns with the first line of an exact passage, falls back to the surviving block top, clamps inside the document, and places a popover to the left when the right side lacks room.

Define the pure API before implementation:

```ts
export type Rect = {
	top: number;
	right: number;
	bottom: number;
	left: number;
	width: number;
	height: number;
};
export type Point = { top: number; left: number };

export function gutterPoint(target: Rect, host: Rect, size = 24, gap = 8): Point;
export function popoverPoint(button: Rect, host: Rect, width: number, gap = 8): Point;
```

- [ ] **Step 2: Run geometry tests and capture RED**

Run: `bun test packages/editor/src/comment-geometry.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement geometry with explicit clamping**

Use `Math.min`/`Math.max`; return coordinates relative to the overlay host, not viewport coordinates. A 24px button sits eight pixels beyond the prose edge when room permits. A popover uses `min(24rem, 80%)` through CSS and geometry chooses its side only.

- [ ] **Step 4: Capture draft placement before selection focus is lost**

Extend local `Draft` with an optional serialisable placement `{ top, right, bottom, left, width, height }`. In the selection toolbar, read `window.getSelection()` and copy the active range's `getBoundingClientRect()` before `threads.draft(...)` moves focus. Never send this placement over `comment:start`; destructure only `blocks`, `quote`, `offset` and `length` in `ThreadStore.start`.

- [ ] **Step 5: Implement `CommentLayer` as an editor adapter**

Mount it as a composer child when `threads` exists. It must:

- read the Lexical editor from `useLexicalComposerContext` and thread state from `useThreads`;
- portal into `.plan-document` and position relative to that host;
- derive exact DOM ranges with `$rangeOf(editor, view.places[0])`, or use `blockElement(editor, view.targetKey)`;
- recompute after editor updates, document scroll and `ResizeObserver` changes;
- render one accessible 24px comment button per open thread;
- show a compact quote/reply-count preview on hover or focus;
- pin one full `ThreadCard` on click; Escape/outside click closes it;
- render `DraftCard` at the captured draft rectangle;
- render an orphan-count button in document chrome and pin orphaned threads from it;
- keep pointer travel between highlight, button and card from closing the preview.

Errors in measurement must log once and drop only the affected button; they must never escape a Lexical update listener.

- [ ] **Step 6: Add document-overlay styles**

Use absolute positioning and the existing `page`, `edge`, `raised`, `overlay`, `brand-wash`, radius and focus utilities. The layer is pointer-transparent except for buttons/cards, occupies no document layout space, and uses `z-index` only within `.plan-document`.

- [ ] **Step 7: Rewrite comment browser tests around document chrome**

Replace sidecar-thread locators with accessible comment buttons/popovers. Cover hover preview, keyboard focus, click pinning, reply, accept-to-inline-decision, dismiss, drifted block fallback and fully orphaned toolbar fallback. Keep the existing assertion that comment marks live in `CSS.highlights`, not DOM attributes.

- [ ] **Step 8: Run focused GREEN tests and types**

Run:

```bash
bun test packages/editor/src/comment-geometry.test.ts packages/editor/src/threads.test.ts packages/editor/src/places.test.ts
TMPDIR=/private/tmp bun run e2e -- e2e/sidecar.e2e.ts
bun run types
```

Expected: all commands exit 0 and Playwright produces no trace on success.

- [ ] **Step 9: Commit Task 4**

```bash
git add packages/editor/src/comment-geometry.ts packages/editor/src/comment-geometry.test.ts packages/editor/src/comment-layer.tsx packages/editor/src/comments.tsx packages/editor/src/threads.ts packages/editor/src/toolbar/index.tsx packages/editor/src/widgets-plugin.tsx packages/editor/src/styles.css e2e/sidecar.e2e.ts
git commit -m "Move comments onto the document"
```

### Task 5: Replace the three-pane shell with Plan and Decisions views

**Files:**

- Create: `apps/web/src/decision-view-control.tsx`
- Create: `apps/web/src/decision-view.test.ts`
- Modify: `packages/editor/src/decisions.tsx`
- Modify: `packages/editor/src/index.ts`
- Modify: `apps/web/src/workspace.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/chat/chat.tsx`
- Modify: `apps/web/src/tokens.test.ts`
- Modify: `e2e/shell.e2e.ts`
- Modify: `e2e/sidecar.e2e.ts`

- [ ] **Step 1: Write failing attention-state tests**

Import `visibleDecisionView` from the editor package and test a small `decisionAttention(previous, current)` helper owned by the control:

```ts
expect(visibleDecisionView("plan", false, 2)).toBe("decisions");
expect(visibleDecisionView("plan", true, 1)).toBe("plan");
expect(decisionAttention(1, 2)).toBe(true);
expect(decisionAttention(2, 2)).toBe(false);
expect(decisionAttention(2, 1)).toBe(false);
```

Also assert zero suppresses the badge label in static markup. Keep view derivation in `packages/editor/src/decision-state.ts`; the web shell must not duplicate it.

- [ ] **Step 2: Run host-state tests and capture RED**

Run: `bun test apps/web/src/decision-view.test.ts`

Expected: FAIL because the helper/control is absent.

- [ ] **Step 3: Make `Decisions` questionnaire-only**

Remove `ThreadStore`, `DraftCard` and `ThreadCard` from `decisions.tsx`. Keep unanswered cards first and resolved questionnaires under remembered disclosure. Add `onShowPlan(widget, question)` and invoke it from `onQuestionSelect`; this lets the host reveal the hidden editor before calling `QuestionnaireStore.reveal`.

- [ ] **Step 4: Implement the two-option view control**

Render `Plan` and `Decisions` as two real buttons with `aria-pressed`. The Decisions button includes `<Count>{unanswered}</Count>` only above zero. When the count grows, set `data-attention` for one base-duration animation; disable that animation under `prefers-reduced-motion`.

- [ ] **Step 5: Simplify `Workspace` to one side rail and two mounted centre surfaces**

Keep `chat`, `chatOpen`, `header` and the conversation resize handle. Remove decisions pane props, right handle and right aside. Clamp chat at `MIN = 240`, `MAX = 400`, default `280`. Add `controls`, `plan`, `decisions` and `view` props. Render both centre surfaces and use `hidden` so `PlanEditor` remains mounted. Capture and restore the plan scroller's `scrollTop` through callbacks owned by the host.

- [ ] **Step 6: Route view state in `Room`**

Use `useQuestionnaires`, `useHasPlanContent`, `countUnanswered` and `visibleDecisionView`. Persist preferred view under `chopin:view:document` only when plan content exists. Chat's Answer action selects Decisions and reveals the addressed questionnaire. “Show in plan” selects Plan, waits one animation frame for visibility, then calls `questions.reveal(widget, question)` and focuses the inline card.

Remove the decisions pane toggle from `Header`. Keep the top bar above both conversation and document.

- [ ] **Step 7: Update shell and decision browser coverage**

Assert one aside, one resize separator, 280px default, 400px maximum, hidden-chat draft preservation and 400px minimum document width. In the fixture room with existing prose, assert `Plan` remains selected when questions arrive, Decisions shows the individual unanswered count, clicking it shows questionnaire cards only, and Show in plan returns to the inline card while preserving the previous plan scroll when no card is selected.

- [ ] **Step 8: Run focused GREEN tests, E2E and types**

Run:

```bash
bun test apps/web/src/decision-view.test.ts apps/web/src/tokens.test.ts packages/editor/src/decision-state.test.ts
TMPDIR=/private/tmp bun run e2e -- e2e/shell.e2e.ts e2e/sidecar.e2e.ts
bun run types
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit Task 5**

```bash
git add apps/web/src/decision-view-control.tsx apps/web/src/decision-view.test.ts packages/editor/src/decisions.tsx packages/editor/src/index.ts apps/web/src/workspace.tsx apps/web/src/app.tsx apps/web/src/chat/chat.tsx apps/web/src/tokens.test.ts e2e/shell.e2e.ts e2e/sidecar.e2e.ts
git commit -m "Add focused and inline decision views"
```

### Task 6: Teach the opening planner flow and verify the complete branch

**Files:**

- Create: `apps/server/src/agent/planner.test.ts`
- Modify: `apps/server/src/agent/planner.ts`
- Modify: `e2e/sidecar.e2e.ts`
- Modify: `docs/superpowers/plans/2026-08-12-inline-decisions.md`

- [ ] **Step 1: Write a failing planner-order test**

Export the prompt for testing and assert it contains this rule before the general plan-writing instructions:

```ts
expect(PROMPT).toContain(
	"When a new room has no plan prose, settle genuinely blocking choices before writing the first draft",
);
expect(PROMPT.indexOf("settle genuinely blocking choices"))
	.toBeLessThan(PROMPT.indexOf("The plan is yours to write"));
```

The test must also assert the prompt says not to invent a question when repository evidence already settles the choice.

- [ ] **Step 2: Run the prompt test and capture RED**

Run: `bun test apps/server/src/agent/planner.test.ts`

Expected: FAIL because the opening instruction/export is absent.

- [ ] **Step 3: Add the opening-flow instruction**

Place a concise paragraph near the beginning of `PROMPT`: on a room with no plan prose, inspect the request and repository, batch genuinely blocking decisions into `ask`, wait for their shared answer, then write the first draft. If nothing genuinely needs the room's judgement, write the plan directly. On an existing plan, ask later questions in place and never treat them as a reason to replace or hide the plan.

- [ ] **Step 4: Add opening-view browser coverage**

Against the fixture server, open an unseeded room and assert it begins in Decisions with the two injected unanswered questions. In a separate room whose prose is seeded before its first connection, assert it opens in Plan while the same injected questions only update the Decisions count. Record the plan scroller and selection, wait for the questionnaire snapshot, and assert neither moves. Keep this deterministic under `AGENT=off`; the pure state test covers the transition when prose first appears, and the planner prompt test covers agent behaviour.

- [ ] **Step 5: Run complete verification**

Run:

```bash
DPRINT_CACHE_DIR=/private/tmp/dprint-cache bun run ci
bun run types
TMPDIR=/private/tmp bun test
bun run build
TMPDIR=/private/tmp bun run e2e
git diff --check
```

Expected: formatting/lint, types, all unit tests, production build, all browser tests and whitespace check pass.

- [ ] **Step 6: Mark plan checkboxes and commit Task 6**

Mark completed task steps in this file, then:

```bash
git add apps/server/src/agent/planner.ts apps/server/src/agent/planner.test.ts e2e/sidecar.e2e.ts docs/superpowers/plans/2026-08-12-inline-decisions.md
git commit -m "Guide the decisions-first opening flow"
```
