---
name: typesafe-ai
description: >
  Design, implement, and evaluate software using TypeSafe's Jev System One model.
  Use when a feature needs semantic routing, ranking, extraction, verification,
  or other typed judgments; when improving Jev questions, state, or thresholds;
  or when exploring what programmable common sense could add to an application.
---

# Build with TypeSafe

Jev contributes small units of AI intelligence to ordinary software: application
state and typed questions go in; answers and probabilities come out. Code owns
control flow and actions. A generative model can write text or reason when needed.

## Read the relevant guidance

The [live documentation index](https://docs.typesafe.ai/llms.txt) is the source of
truth for API contracts, SDKs, models, limits, and cookbooks. Follow its links;
append `.md` for Markdown, or try the normal page if Markdown fetching fails.
Before integrating, read the current [API](https://docs.typesafe.ai/api), chosen
[SDK](https://docs.typesafe.ai/sdk/javascript), and closest cookbook. Preserve the
existing stack and transport boundary. If live access fails, inspect installed
types and local documentation and state which details remain unverified.

Read only the reference needed for the task:

- [Question design](references/question-design.md): preparing state, decomposing
  judgments, choosing primitives, and fixing ambiguous instructions or criteria.
- [Composition and evaluation](references/composition-and-evaluation.md): batching,
  extraction, retrieval, routing, confidence, regression cases, and agent economics.

## Find the useful shape

Start with the desired application behavior. Identify where semantic understanding
helps, and leave exact lookups, arithmetic, permission checks, and execution in code.
For a concrete request, choose a suitable pattern and build. For exploration, offer
a few possibilities suited to the user's goal. These patterns are starting points:

| Need                       | Useful shape                                                                                      | Read next                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interpret a request        | Choose a handler and closed-set arguments; compute other values in code                           | [Function calling](https://docs.typesafe.ai/cookbooks/function_calling)                                                                                          |
| Extract a value            | Find candidates, select the intended span, copy and normalize it                                  | [Pre-parsed extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook)                                                                 |
| Retrieve evidence          | Retrieve cheaply, then judge query–candidate pairs                                                | [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe)                                                                                                 |
| Compare preferences        | Score dimensions once; combine weights in code or use probabilities as learned features           | [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring), [feature discovery](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery) |
| Check another model's work | Judge specific claims against supplied evidence; escalate uncertainty                             | [Citation checks](https://docs.typesafe.ai/cookbooks/citation_check), [extraction cascade](https://docs.typesafe.ai/cookbooks/sde_cascade)                       |
| Guide an app or agent      | Select bounded actions from current state; keep observations, goals, and stop conditions explicit | [Skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion)                                                                                          |

## Design the judgments

| Answer means              | Primitive                                            | Read it correctly                                                    |
| ------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| One of a defined set      | [Choice](https://docs.typesafe.ai/primitives/choice) | One selected option and a competing-options distribution             |
| Whether a condition holds | [Noul](https://docs.typesafe.ai/primitives/noul)     | Probability of yes; near 0.5 means uncertainty, not medium intensity |
| Degree along a dimension  | [Score](https://docs.typesafe.ai/primitives/score)   | Probability-weighted position on ordered, descriptive levels         |

Give each question the evidence and relationships it needs, preferably in named
JSON fields. Put the judgment in `instructions` and define answers in `criteria`.
Question IDs are not sent to the model: instructions must carry the full meaning.
Use explicit paths such as `ticket.messages[0].text` when they clarify the target.
Strings suit simple questions; objects and arrays suit definitions and examples.

Ask one coherent semantic judgment per question. Split independently useful
dimensions; preserve relationships required to interpret meaning. Atomic does not
mean context-free fact extraction: bounded action selection and contextual intent
are valid. Include a no-match outcome when appropriate and check candidate coverage.
Describe Score levels concretely so each stands on its own.

## Compose and verify

Ask independent questions over the same state together, including useful speculative
branches. They cannot see one another's answers; state conditional premises explicitly
and let code consume only applicable answers. Use another request when an earlier
answer changes the evidence, state, or candidates. Measure token cost and latency.

Keep probabilities and raw judgments reusable. Choice/Score confidence summarizes
the answer distribution; it is not the probability that the workflow is correct.
Thresholds belong to each question and action and must be evaluated on representative
data. A weighted preference score is not a substitute for an explicit veto condition.
Typed output guarantees shape, not truth or authorization.

For failures, inspect the exact state, questions, candidates, distributions, policy,
and observed outcome. Separate missing evidence, question ambiguity, model errors,
composition errors, and service failures. Add regression cases for demonstrated
failures. Verify final application behavior as well as individual judgments.
Pin an evaluated model version when thresholds matter and log the resolved model.
Treat cookbook thresholds and performance numbers as dated examples. Keep API
credentials server-side in web applications.
