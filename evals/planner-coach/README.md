# Planner coaching behavioral evaluation

Eleven [frozen synthetic scenarios](scenarios.json.freeze) exercise coaching inside
an invoked Planner turn. Coworker confusion and human correction have two fixed
human turns. The cohort checksum prevents silently changing inputs between policies.
This is a development diagnostic, not a benchmark or a test of idle scheduling.

List or validate cases without provider calls:

```sh
bun evals/planner-coach/run.ts --list
bun evals/planner-coach/run.ts --cases coworker-confusion,user-correction
```

Live runs require an explicit `--live`, a full instructions file, and an existing
`gh auth` login. The credential is read in-process and registered through the
production harness credential registry. It is never passed in a command argument
or used to read GitHub source. The runner forces the production Copilot SDK adapter
before loading agent modules, regardless of the local `.env` harness selection.

```sh
bun evals/planner-coach/run.ts \
  --live --instructions /private/tmp/full-planner-instructions.txt \
  --cases coworker-confusion,user-correction \
  --label baseline --model gpt-6-luna \
  --out /private/tmp/planner-coach-runs --run-id baseline-01 \
  --max-tools 16 --turn-timeout-ms 120000 --question-wait-ms 2000
```

Use the same cases, model and limits with each candidate policy. `--cases all`
selects the cohort. Each run ID creates a new directory and refuses overwrite.
`--visual fixture-prose` exercises production visual-routing validation with a
deterministic zero-possibility Jev fixture; it sends no Jev requests and evaluates
prose routing only. Record and compare visual modes separately.

The runner uses `createPlannerAgent`, `openPlannerSession`, real document, graph
and decision tools, and the memory test storage adapter. It never connects a
database. Repository and pull-request tools retain production schemas but read
only committed synthetic fixtures. The fixture's decision interface is invented
for the scenarios and is **not evidence of Chopin's actual UI**. Research and local
investigation proposals return explicit fixture refusals. Build, background work,
real source retrieval, timing and browser integration are outside this evaluation.

Each completed case saves complete text and stream parts, actual tool inputs/results and
document snapshots. The manifest records policy and cohort hashes, model, Git head,
dirty diff hash including untracked files, limits, flags, fixture boundaries,
failures and undelivered follow-ups. Exact credentials and recognizable bearer or
GitHub tokens are redacted. Output remains private local material; inspect artifacts
before sharing them and keep run directories outside commits.
A cap or timeout retains a bounded partial transcript and an explicit failure.

Each disposable Copilot turn receives up to 100 prior human/Planner Chat entries
under a 50,000-character bound, matching the hosted Chat bootstrap's limits. The
exact prompt is retained. Tool results stay in traces; durable document changes
are recovered with real reads. An owned memory writer lease is extended for the
whole bounded scenario plus opening and cleanup allowances. Real publication
persists each edit, and the runner reconstructs the stored document before teardown
to compare it with the final live source.

A real `ask` waits for a person. At the configured decision bound the runner aborts
the turn, production cleanup withdraws the unanswered card, and the case stops as
`awaiting-human`; its canned next Chat message is not submitted as an answer. A
Chat question can be followed by the next frozen human turn. Tool/time limits abort
work, and streams/tools must settle before another turn. Failed cleanup stops the
case. These paths are visible in the traces and are not silently scored as success.

The generated scorecard starts **unscored**. An independent human or agent reviewer
reads the transcript, tool results and final document, assigns 0/1/2 on each axis,
and supplies concrete evidence references and rationale. Count useful open Chat
questions manually. Review scenario expectations alongside the common axes.
Mechanical checks cover revision use, structured `ask` question count, tool authority,
attempted mutations after a stop and successful evidence reads. They do not measure
grounding, usefulness, respectful coaching or whether a claim follows its source.
Report live rubric judgments separately from scripted runner tests.

Verify the runner without live requests:

```sh
bun test evals/planner-coach/runner.test.ts
bunx --no-install tsgo --noEmit --skipLibCheck -p evals/planner-coach
```

Normal test commands never opt into paid provider turns. The runner has no new
dependencies; it uses the existing server tool factories and installed workspace
packages. Source modules remain small so execution, fixture behavior and scoring
can be reviewed independently.
