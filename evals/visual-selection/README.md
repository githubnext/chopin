# Visual selection assessment

This is a bounded local comparison of three ways to choose an explanatory visual for
engineering discussion. It does not change the hosted Planner or document routing.

## Plan and frozen inputs

1. Pin a small SeeCode catalogue and the same generator instructions for all strategies.
2. Verify the frozen development registry and one checkpoint per source discussion.
3. Probe one case, then run one complete baseline before changing prompts or choices.
4. Review disagreements against the source and report counts, latency, and available usage.

[cases.json](cases.json) selects seven distinct real development discussions, one checkpoint
each. Its registry hash is `5cdc086840041f9b5c2140d90f9baa8355c7604b8b6fa46d991f09c9f3b889cb`
from the development-only loader at `0c560ea126181bd3c6911a318f9804a029f0c85a`.
The loader verifies every selected checkpoint hash and cutoff before sending source text.
It sends only event identity, authorship, timing, body, and process fields. Source links stay
inert. Candidate interpretations, later events, synthetic examples, validation, and reserved
data are not in these model inputs. This first batch has discussions, not standalone plans.

The pinned outcomes are `dependency`, `sequence`, `state`, `flowchart`, `table`, and `prose`.
The first four are actual SeeCode renderer types. The set covers directed relationships,
ordered interactions, state changes, explicit branches, comparisons, and appropriate
abstention. It deliberately excludes chart types that require absent measurements.

## Strategies

| Strategy      | Selection                     | Filling                                        |
| ------------- | ----------------------------- | ---------------------------------------------- |
| Direct        | Model chooses from all six    | Same model and generator instructions          |
| Jev one       | Jev's top choice              | Same model, constrained to that choice         |
| Jev shortlist | Jev's top three probabilities | Same model chooses among those three and fills |

The two Jev strategies reuse one validated probability distribution per case. Count its
latency and usage once for the executed batch; either deployed Jev strategy would incur one
Jev call per case. The generator uses an isolated, tool-free `HarnessAgent` session, not an
actual hosted Planner turn. The exact requested harness model is recorded; if a provider
does not expose its resolved version or token usage, report those fields as unavailable.

The runner writes one JSONL record per Jev call and strategy attempt. It never retries a
model result silently. A later mechanical repair, if needed, must be a separate run with a
new output path, limited to failed attempts and reported apart from this baseline. At most
20 cases and 60 strategy attempts are permitted. Results belong under ignored `data/` or
another private location, never in a source commit.

## Rubric

Evaluate each completed output against its checkpoint only. More than one choice may be
defensible. A matching label by itself earns no credit. Use 0, 1, or 2 for each judgment:

| Criterion           | 0                         | 1                                      | 2                                        |
| ------------------- | ------------------------- | -------------------------------------- | ---------------------------------------- |
| Useful choice       | Distracts or obscures     | Defensible but weaker                  | Makes the source easier to understand    |
| Source faithfulness | Invents or contradicts    | Mostly grounded with material omission | Claims and relationships trace to source |
| Data sufficiency    | Required inputs absent    | Partial, with visible gaps             | Enough stated information for this form  |
| Readability         | Hard to parse             | Workable                               | Clear at ordinary document size          |
| Abstention          | Wrongly draws or declines | Debatable                              | Correctly uses prose/table or draws      |

Separately record parse validity, renderer validation problems, successful render, failures,
and whether evidence IDs exist. Human reviewers inspect the actual wording and rendered SVG
for fabricated relationships, false certainty, missing alternatives, unreadable labels, and
useful diagram placement. Automated and agent judgments are provisional until reviewed.
Keep an explicit small queue of disagreements and failures rather than treating the scores
as calibrated gold. Summarize by source cluster, not by individual message or checkpoint.

## Commands

From the repository root, with the frozen development directory available locally:

```bash
bun test apps/server/src/visual-selection-eval
bun apps/server/src/visual-selection-eval/run.ts --jev-probe \
  --case astro-production-deps --registry data/visual-selection/frozen-development/registry.json \
  --jev-env /Users/maggieappleton/Projects/chopin/.env \
  --output data/visual-selection/jev-probe.jsonl
bun apps/server/src/visual-selection-eval/run.ts \
  --registry data/visual-selection/frozen-development/registry.json \
  --jev-env /Users/maggieappleton/Projects/chopin/.env \
  --model gpt-6-luna --output data/visual-selection/baseline.jsonl
bun apps/server/src/visual-selection-eval/review.ts \
  --registry data/visual-selection/frozen-development/registry.json \
  --results data/visual-selection/baseline.jsonl \
  --output data/visual-selection/review.md
bun apps/server/src/visual-selection-eval/repair.ts \
  --registry data/visual-selection/frozen-development/registry.json \
  --baseline data/visual-selection/baseline.jsonl \
  --output data/visual-selection/repair.jsonl
```

The default Copilot harness reads a GitHub user token from `GITHUB_TOKEN`, `GH_TOKEN`, or the
existing `gh` keyring without printing it. Use an existing supported `pi` or `atomic` harness
with `--harness`, `--auth`, and a model available to that provider if Copilot is unavailable.
Run one case first with
`--case astro-production-deps` and a separate output file. Do not tune after that smoke
check; complete the pinned seven-case baseline first.
