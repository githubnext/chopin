# Real Planner visual acceptance

This opt-in suite runs the production Copilot SDK Planner through Chat, document tools,
PostgreSQL, and a fresh browser reopen. The GitHub API and MCP source boundary are
synthetic. Every case is loaded through [`evals/datasets/v2.ts`](../evals/datasets/v2.ts)
and checked against the committed [development cohort freeze](../evals/planner-visual/cohort-v2.json.freeze).
The freeze contains the exact document seed and case prompt, their hashes, provenance,
and cutoffs. The seven discussion inputs are attributed adaptations, the Rust RFC is an
original source excerpt, and D01 is synthetic. Links are inert. Do not compare this
cohort's scores directly with earlier raw-comment trials.

The current paired assessment uses the [native five-case subset](../evals/planner-visual/native-five-v1.json.freeze)
and native document dialect: prose, Markdown tables, allowlisted MDX components,
SeeCode diagrams, and ordinary Decisions. This is a development diagnostic, not
a replacement ten-case benchmark or general accuracy claim.

Normal `bun run e2e` never sends these turns. The explicit opt-in, selected case IDs,
phase, subset, isolated database, model, and clean committed checkout are required. The runner
writes `run-config.json` before its server starts; that file contains the complete
static Planner instructions, their hash, model/harness configuration, cohort and dataset
hashes, selected cases and prompts, offered tool names, generation defaults, and
integration commit. In these fresh channels there is no earlier conversation
bootstrap. A repeated batch under one run ID must match this configuration exactly.
Each case reserves its own ID before a turn so accidental retries cannot spend calls.

## Local setup

Use the assigned ports 8870 (app), 8871 (fake MCP), and 8872 (isolated PostgreSQL).
Check that they are free. A disposable database can be started with:

```sh
docker run --rm --name chopin-visual-acceptance-db \
  -e POSTGRES_USER=chopin -e POSTGRES_PASSWORD=chopin \
  -e POSTGRES_DB=chopin_visual_acceptance \
  -p 127.0.0.1:8872:5432 postgres:17-alpine
```

In the checkout under assessment, install, migrate, and build before the first batch:

```sh
bun install --frozen-lockfile
DATABASE_URL='postgresql://chopin:chopin@127.0.0.1:8872/chopin_visual_acceptance?sslmode=disable' \
APP_ORIGIN='http://127.0.0.1:8870' \
GITHUB_APP_SLUG='chopin-e2e' GITHUB_APP_CLIENT_ID='e2e' \
GITHUB_APP_CLIENT_SECRET='e2e' \
SESSION_ENCRYPTION_KEY='3333333333333333333333333333333333333333333333333333333333333333' \
bun run migrate
bun run build
```

The `gh auth token` credential must be available to the local server process. The
preload keeps it in memory, substitutes it only for the hosted Copilot session, and
denies repository-source requests. It never records the token.

## Bounded run

An explicit live-call release and budget are required. First run
`bun test evals/planner-visual/cohort.test.ts` and confirm the checkout is
committed and clean. The released native baseline uses the five frozen cases in
one batch. The candidate uses the same selection and a separate run ID after the
guidance change is committed and its examples are validated:

```sh
E2E_PLANNER_VISUAL_ACCEPTANCE=1 \
E2E_VISUAL_PHASE=baseline \
E2E_VISUAL_SUBSET='native-five-development-v1' \
E2E_VISUAL_CASE_IDS='R1,A1,E1,D1,S1' \
E2E_VISUAL_RUN_ID='native-baseline-example' \
E2E_VISUAL_MODEL='gpt-6-luna' \
E2E_VISUAL_QUESTION_ANSWER='Tiptap' \
E2E_DATABASE_URL_0='postgresql://chopin:chopin@127.0.0.1:8872/chopin_visual_acceptance?sslmode=disable' \
SESSION_ENCRYPTION_KEY='3333333333333333333333333333333333333333333333333333333333333333' \
bun node_modules/@playwright/test/cli.js test --config e2e/planner-visual-acceptance.config.ts
```

The question answer is only a runner control to let an asked turn finish; it is
not a gold answer. Playwright's short server shutdown may leave the writer lease
active for up to 30 seconds; confirm that it has expired before starting the
candidate batch. Count every Planner turn, including a repair turn, against the
released budget. Do not send Jev calls from the native five-case mode.

## Jev three-case live check

The [separate frozen subset](../evals/planner-visual/jev-three-v1.json.freeze)
selects R1, E1, and D1 in that order. It uses the same Chat, Planner, database,
and browser reopen path, with `PLANNER_VISUALS=on`. It requires an explicit
`jev-candidate` phase, `gpt-6-luna`, `jev-1.13.0`, a Jev API key, and no
`E2E_VISUAL_QUESTION_ANSWER`. The run configuration records the actual routed
Planner instructions and tool names, visual code hashes, thresholds, and caps.

This mode reserves each Jev HTTP call before network dispatch, including calls
that later fail. The cap is three calls per case and nine overall. A missing
case identity, fourth call in one case, tenth call overall, failed response, or
model drift creates `jev-stop.json` and prevents later cases from starting.
An unexpected `ask` is recorded as incomplete and is not answered. No case is
retried or repaired for a better result. `jev-dispatches.jsonl` records stage
answers and usage without credentials. The source seed, Chat prompt, tool frames,
saved source, and reopened browser evidence all refer to the same channel ID.

The separate preflight artifact fixes the case roles and release budget. Do not
run this mode until its external provider calls have been released for the exact
committed head. The earlier native five-case mode and its answer control remain
unchanged.

Evidence is under ignored `e2e/test-results/planner-visual-acceptance/<run>/`:
source before/after/reopen, exact case prompt, question and tool frames, blocked
source attempts, browser render data and screenshots, latency, and an explicit
usage-unavailable marker if Chat exposes no token count. Judge presentation fit,
source fidelity, semantic usefulness, and persisted rendering separately. Valid
syntax or fluent prose alone does not establish useful visual authoring.
