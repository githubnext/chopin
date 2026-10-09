# Planner visual development acceptance

The [frozen cohort](cohort-v2.json.freeze) and [loader adapter](cohort.ts) define ten
development cases. `cohort.test.ts` verifies every proposed document seed and case
prompt against the committed [dataset loader](../datasets/v2.ts). The
[rubric](rubric.md) records what each source can support and how to inspect an output.
The [native five-case subset](native-five-v1.json.freeze) fixes R1, A1, E1, D1,
and S1, their exact source and prompt hashes, and the four rubric axes for a paired
development diagnostic. It does not replace the ten-case cohort.

The [Jev three-case subset](jev-three-v1.json.freeze) selects the existing R1,
E1, and D1 inputs for a separately bounded same-room Planner authoring check.
It does not change or supersede the earlier five-case trial.

The [live runner instructions](../../e2e/planner-visual-acceptance.README.md) cover
the opt-in Copilot SDK, isolated ports and database, run lock, and evidence files.
Neither this directory nor a normal test command sends provider turns.

The native catalogue comes from `packages/dialect/src/dialect.ts` and the
Planner's `AUTHORABLE` list: Markdown headings, prose, lists, tables, links,
images, math and code; authorable `Callout`, `Tabs`/`Tab`, and `Underline`; and
`seecode`, `mermaid`, and `diff` fences. The Planner creates a team question
through `ask`. `Questionnaire`, `Decision`, and `Research` appear in the dialect
but are record-backed projections, not freeform Planner components. The runner
records native tables, callouts, tabs, diagrams, and ordinary questions separately.
