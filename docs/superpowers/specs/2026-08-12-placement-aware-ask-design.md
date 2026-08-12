# Placement-aware decisions

## Goal

When the planner raises a decision against an existing plan, its card appears immediately beside the prose it affects. Decisions without any prose yet remain available in the isolated Decisions view and are placed after the planner writes the resulting prose.

## Tool contract

Extend `ask` with the revision returned by `read_plan` and a `blocks` array on every question:

```ts
ask({
	revision,
	questions: [{
		header,
		question,
		options,
		multiple,
		blocks: [{ index, digest }],
	}],
});
```

Each block uses the existing index-plus-digest address. The first block is the card's inline home; all blocks remain the decision's related prose for highlighting and navigation.

An empty `blocks` array is accepted only when the document has no prose to relate yet. When prose exists, the planner must either identify the relevant block or write the missing context before asking.

## Server behavior

The server validates the revision and every block digest before creating any decision records or document nodes. A stale or invalid placement rejects the complete batch without inserting a partial set of cards.

After validation, the service creates one independently saveable record and node per question, stores its block anchors, and moves each canonical node after its first related block. Cards sharing one block retain their original ask order. The `ask` call then waits for the decisions exactly as it does today.

Questions asked before any prose keep an unresolved placement. A later `edit_plan` returns them through `anchors_pending`; `anchor_plan` places them once their resulting prose exists.

## Planner behavior

The planner continues to use Chopin's custom interactive agent rather than Copilot's built-in plan mode.

- For a plan that already contains prose, call `read_plan`, then include related block addresses in `ask`.
- When drafting a plan and discovering non-blocking choices, write the relevant prose first and call `ask` in the same turn with the returned block addresses.
- For genuinely blocking choices in an empty room, ask first without placement, wait for the answers, write the plan, and clear `anchors_pending` with `anchor_plan`.
- Do not collect decisions in a trailing Decisions section merely because they were created together.

## Errors and concurrency

- A changed revision returns a stale result and asks the planner to read again.
- A missing or mismatched digest rejects the batch before mutation.
- A non-empty plan paired with an empty `blocks` list is rejected with guidance to relate the question or write its context first.
- Existing stored questionnaires and the focused Decisions projection remain compatible.

## Tests

- A service test proves a pending question is inserted beside its validated prose before it is answered.
- A service test proves several questions targeting one block retain ask order.
- A contract test proves stale or empty placements mutate nothing.
- A planner prompt/schema test locks down placement-aware calls.
- A browser test proves an inline pending card and the focused Decisions projection still refer to one canonical node.

## Scope

This change does not create an atomic plan-and-decisions authoring tool, change the card UI, or infer semantic placement on the server. The planner chooses the related prose; the server validates and enforces that choice.
