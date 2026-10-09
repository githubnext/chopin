# Native-MDX visual authoring rubric v3

This rubric uses the unchanged `cohort-v2.json.freeze` document seeds and prompts.
Seven public discussions are attributed **adapted event summaries**, two cases use
bounded excerpts of the original Rust RFC, and D01 is **synthetic**. Links are
inert. Judge only the loaded cutoff, not linked pages or later discussion.

The supported authoring surface is Markdown prose, lists and tables; Chopin's
allowlisted MDX components such as Callout and Tabs; SeeCode diagrams; and an
ordinary `ask` for a team decision. The test does not require a diagram or a
special component where plain prose answers the reader better.

| Case | Required source fidelity                                                                                                                                                                                       | Presentation opportunity                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| R1   | Calling the async function returns a future without running its body; polling progresses it toward `await!` or return.                                                                                         | A small creation/poll/yield diagram may clarify the relation.                        |
| R2   | `await!` converts, polls, yields on `Async::Pending`, and breaks with the item on `Async::Ready`; the shown expansion is approximate.                                                                          | A bounded polling loop may clarify the mechanism.                                    |
| A1   | CLI dependencies and built SSR runtime needs differ; moving needed library dependencies to its own `devDependencies` would leave users without them; separation remains proposed.                              | A compact dependency diagram may help.                                               |
| P1   | Removing automatic bold/border formatting and using Styler are proposed; at c3 contributors favor a direct pandas 3.0 change over a separate deprecation. No shipped outcome.                                  | Short prose or a small Markdown table.                                               |
| V1   | Preserve the tester's full-reload observation and the respondent's contrary granular CSS reproduction on the same versions; bundled CSS updates travel as JS patches in the reply. Disagreement remains at c2. | Prose is sufficient; source is too thin for detailed mechanics.                      |
| T1   | An opt-in flag avoids involuntary change when off, but enabled code could break and another configuration has cost. The tradeoff is unresolved.                                                                | A focused Markdown table or prose comparison may help.                               |
| B1   | Initial compatibility migration proposal precedes an existing-category finding, a participant's working VS Code configuration, and a revised documentation diagnosis.                                          | A brief evidence timeline may help; do not frame evolving evidence as a team choice. |
| E1   | At c2, compare helper/separate-map compatibility with object-shaped normalization, including the CLI/inline coverage tradeoff. No final decision.                                                              | A Markdown table or Tabs may make the two alternatives easier to scan.               |
| D1   | The author distinguishes `deno run` scripts from `deno task` tasks and says fallback can interfere with import-map paths. No literal error suggestion or outcome is present.                                   | Prose control; no diagram or decision card.                                          |
| S1   | Ask among Tiptap, bare ProseMirror, Lexical, and native Selection/Range with an owned model. No preference or choice is present at c2.                                                                         | Ordinary unanswered `ask` with four options; no explanatory visual.                  |

Score each case on four separate axes, `0 = fail`, `1 = partial`, `2 = meets`:

1. **Presentation fit:** the chosen format helps the reader; decoration does not earn credit.
2. **Source fidelity:** the stated distinctions survive, with no invented mechanism or later outcome. A factual inversion scores zero even if it renders.
3. **Semantic usefulness:** diagram labels, edges and scale, table qualifications, component grouping, or question options can be understood without guessing.
4. **Persistence and rendering:** the normal tool saved valid source or an authoritative question, and a fresh browser reopen shows the result legibly. Schema validity alone is insufficient.

Record the actual representation, tool actions and any rejected attempts, a source
quote or artifact pointer for each score, question state, latency, available
usage or `unavailable`, and reopened browser evidence. Count diagrams, tables,
MDX components, ordinary questions, and prose separately. Helpful prose does
not prove diagram or component authoring.
