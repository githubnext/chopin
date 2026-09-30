# Jev product extraction — handoff

This is a finite extraction from a preserved prototype, not a verified release or
classifier-quality fix. The transport, stored-identity, source-provenance and quote foundations are implemented in bounded slices.

- Product branch: `maggie/jev-chat-product`.
- Product worktree: `/Users/maggieappleton/.codex/worktrees/jev-chat-product/chopin`.
- Current-main base: `9a5ac1d0947a0422d3607c876296fe849362188d` (Bun 1.4.2).
- Preserved source: `maggie/archive-jev-prototype-20260930`,
  `446a9779a937fa5be7cd3eb52fd7f3023d691ed2`, including unverified WIP.
- Shared ancestor for identifying prototype-authored changes:
  `f9cd64b1eb271c4534e59667d6028f95825153bb`.
- Historical checkout `/Users/maggieappleton/.codex/worktrees/42e5/chopin` is read-only.
- Eval branch `maggie/chopin-eval-hub` is separately owned; no stack rebase is done here.

## Exact path ownership

[Source inventory](jev-product-source-map.tsv) assigns all 287 changed paths under
`apps`, `packages`, `e2e`, `scripts`, and the relevant configuration/deployment files,
relative to the shared ancestor. Each row identifies owner, feature, and disposition.
A path assignment is a selective-port candidate, not permission to copy its whole file.
Comparing main directly with the archive also shows later main-only work as deletions;
those apparent deletions are not prototype changes to extract.

Every product test stays with its corresponding product slice. That includes the
D01/D02/D19-named regression tests: their names reflect discovery through evaluations,
but they exercise source provenance, deferral, scoped support and product behavior.
The large `pipeline.test.ts` remains product coverage; its size does not justify
silently dropping scenarios. No reserved dataset contents were opened for this map.

| Feature                             | Product source paths                                                                                                                                                                                                                                                                                                                                   | Dependencies and regression ownership                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jev HTTP transport                  | `apps/server/src/conversation-plan/jev.ts`, `jev.test.ts`                                                                                                                                                                                                                                                                                              | Standalone; injected fetch tests. Implemented now.                                                                                                                                                                                     |
| Jev configuration                   | `apps/server/src/config.ts`, `config.test.ts`, `.env.example`, Compose files, `docs/self-hosting.md`                                                                                                                                                                                                                                                   | Selectively add `CONVERSATION_PLAN`, `JEV_API_KEY`, `JEV_MODEL`, `JEV_TIMEOUT_MS`; do not activate processing before durable integration. Transport also retains `TYPESAFE_API_KEY` fallback.                                          |
| Wire and state authority            | `packages/protocol/conversation-plan.d.ts`, `chat.d.ts`, `plan.d.ts`, `question.d.ts`, `index.d.ts`                                                                                                                                                                                                                                                    | Event/source/card/job/analysis/research/Save contracts; update server and browser consumers with producers.                                                                                                                            |
| Interpretation and policy           | `apps/server/src/conversation-plan/{interpret,questions,quotes,quote-budget,policy,validation,sources}.ts`                                                                                                                                                                                                                                             | Transport + wire + bounded source spans. Retain corresponding tests and `pipeline.test.ts`; exact policy extraction, no threshold changes.                                                                                             |
| Structured decision domain          | `apps/server/src/conversation-plan/{domain,events,preference}.ts`                                                                                                                                                                                                                                                                                      | Accepted-event replay, corrections, attribution, scoped proposals and withdrawals. Keep domain/corrections/review/qualified-choice/provenance/deferral/support tests in inventory.                                                     |
| Processing and durable effects      | `apps/server/src/conversation-plan/{service,service-opening,effects,cards}.ts`                                                                                                                                                                                                                                                                         | Serialized queue, retry receipts, source freshness, outbox and card projection; service/effects/cards/opening tests and room integration required.                                                                                     |
| Decision definitions and drafts     | `packages/question/src/{schema,limits,options,draft,answer,index}.ts`, `react/*`                                                                                                                                                                                                                                                                       | Stable IDs, option growth and answer option IDs; retain question/options/React tests. No wholesale draft-mode replacement.                                                                                                             |
| Decision records and lifecycle      | `apps/server/src/questions/{records,store,service,card-actions,backfill,option-match,prose,write-prose,anchors}.ts`                                                                                                                                                                                                                                    | Card metadata, reopen/discard, sources and prose projection. Retain all questions regression files in inventory, including top-level `questions.*.test.ts`.                                                                            |
| Room/sidecar persistence            | `apps/server/src/plan/{service,room,projections,edit,questionnaires}.ts`                                                                                                                                                                                                                                                                               | Conversation state, retries, jobs, effects/receipts and pending card actions live in the versioned sidecar. Preserve current metadata, MCP and implementation guards; persistence/room/planner-job tests protect restore and rollback. |
| SQL/provider persistence            | `apps/server/src/storage/{model,port,contract}.ts`, memory/postgres adapters and `research.ts`, migrations registry, `015_planner_inline_reference.sql`                                                                                                                                                                                                | Research inline-placement recovery field, adapter contract, startup and migration tests. New migration must follow target registry; never replace applied checksums. No database migration is run here.                                |
| Background Planner work             | `apps/server/src/conversation-plan/{jobs,planner-jobs,job-context,job-prompts,prose-job}.ts`; `apps/server/src/agent/{heading-tool,refine-tool,revise-open-decision,decision-prose,job-scope,tools,planner}.ts`                                                                                                                                        | Heading/refine/suggest/prose jobs, scoped tools, ownership and job freshness. Merge into current Harness agents and stream consumption; keep all matching tests.                                                                       |
| Chat and socket integration         | `apps/server/src/chat/{service,address,references}.ts`, queue/job/notice tests; `socket/authorization.ts` and tests; `main.ts`                                                                                                                                                                                                                         | Message enqueue, notices, Save/research/job routes, authorization and reconnect snapshots. Retain current denial rendering and auth revalidation.                                                                                      |
| Chat-first workspace                | `apps/web/src/{room-workspace,workspace,resizable-pane,workspace-model}.tsx/ts`, theme, design-audit icons, tokens tests                                                                                                                                                                                                                               | Retain current navigation, local sign-in, design system and keyboard behavior while porting chat-first layout. Browser layout/responsive tests are product.                                                                            |
| Save suggestions                    | `apps/server/src/conversation-plan/save-command.ts`; scoped proposal policy/domain/events; card actions/records; `apps/web/src/chat/{decision-entry,scoped-choice-entry,transcript}.tsx`                                                                                                                                                               | Proposed support differs from human-confirmed Save; scoped-save, pending-withdrawal, linked-card-choice and transcript/entry tests must follow these paths. No automatic acceptance.                                                   |
| Decision cards/editor               | `packages/dialect/src/{dialect,limits,validate,index}.ts`, questionnaire node; `packages/editor/src/{card-meta,decision-state,decision-surface,decisions,questionnaires,provider,plan-editor,widget-options,widgets-plugin,index}.ts/tsx`, styles and `widgets/{questionnaire,card-gap,decision-deletion,discarded-navigation*,index}`; icon additions | Dialect allowlist + records + stable draft definition. Keep round-trip/provider/card/lifecycle/render tests; real browser save/discard/reopen/selection tests.                                                                         |
| Document annotations/evidence       | `packages/editor/src/{decision-format,decision-layer,decision-pin,decision-placement,evidence-geometry,comment-geometry,marks}.ts/tsx`, `widgets/evidence-hover.tsx`; `apps/web/src/conversation-plan/{source,evidence,evidence-popover,markers,links,store,card-parts}` and CSS                                                                       | Source spans and authoritative records first; then geometry, highlighting, pin/scroll, orphan recovery. Keep geometry/pin/marks/source tests and browser anchor/evidence/prose stress scenarios.                                       |
| Analysis popover                    | `apps/web/src/conversation-plan/analysis-overview.tsx`, tests and related store/evidence helpers                                                                                                                                                                                                                                                       | Wire snapshots + analysis history/corrections/retry; preserve original display without redesign.                                                                                                                                       |
| Automatic research offers           | Research types/domain/validation/policy/interpreter/service; `apps/server/src/research/service.ts`, research storage; `apps/web/src/chat/research-offer.tsx`, tests; Chat references                                                                                                                                                                   | Keep implemented cost/context detection, frozen task options, human consent/dismissal, stable request identity, recovery and linking. Retain research-offer-detection/task-snapshot/consent tests; do not expand supported cases.      |
| Product browser regression harness  | `e2e/jev*.ts`, `planner-jobs.ts`, `research-offer-fixtures.ts`, server/database/github fixtures, Playwright config and `scripts/e2e.ts`                                                                                                                                                                                                                | Mock only provider boundaries and exercise real domain/wire/scoped tools. Adapt to main's current fake Harness and local-auth server; do not overwrite supervisor/port setup.                                                          |
| Scripted Planner regression harness | `apps/server/src/conversation-plan/scripted-runner.ts` and tests                                                                                                                                                                                                                                                                                       | Explicitly test-only. Real scoped tools with local scripted calls; keep product tests, adapt old Copilot `Tool` typing to current Harness, isolate harness activation from normal startup.                                             |

Exact filenames, including every related test and modified E2E scenario, are in the
inventory. Shared package exports, icons, app dependency metadata, existing MCP/task
fixtures and responsive tests need selective integration; they are not a separate
license to port unrelated old code.

## Material excluded from product extraction

- `evals/**`, including conversation-shape and conversation-corpus datasets,
  scoring, results, generated grades, screenshots and sealed examples: eval/artifact
  owner; originals remain in the preserved snapshot and corpus evidence archive.
- `scripts/evaluate-jev*`, `evaluate-card-quality*`, `export-card-quality-snapshot*`,
  their evaluator tests, `check-jev.ts` and `conversation-plan-demo.ts`: eval/dev
  tooling owner. Scoring tests do not replace product regression tests.
- `docs/prototypes/conversation-plan/**`: historical specs, decisions, implementation
  plans, growing issue diary, reports, mockups, evaluation notes, generated captures.
  Preserve as historical reference; write concise current feature docs when each
  capability actually ships instead of importing the diary.
- One-use eval listener/setup, if needed by eval runs, belongs only to eval tooling.
  Never port it from old main/startup wiring into product runtime.
- Snapshot-era Bun pin, package/lock metadata, agent client/runtime/permissions and
  Copilot-only job/worker plumbing: retain main's current Bun/Harness architecture.
- Main-only auth/device/local-store, Harness adapters/contract/session, design checks,
  design components and existing test suites: retain; direct archive diff deletions
  must not be applied. Unrelated editor/research/code styling changes are deferred.

## Minimal dependency sequence

1. **Transport (this milestone):** copy the standalone transport and five existing
   timeout/abort/body tests; add offline serialization/result/bounds tests. No imports
   into startup, flags, listeners, storage, UI or policy.
2. **Stored decision identity:** extract `identified()` and its stored-text guard
   from `packages/question/src/schema.ts`, export it in `index.ts`, and selectively
   port its source tests from `question.test.ts`. Preserve durable IDs/order, validate
   duplicate IDs and raw string lengths. This can be tested within the question
   package without adding cards, changing draft mode or requiring a database.
3. **Pure conversation state:** wire declarations + source validation + event replay,
   domain and their tests. Keep research/Save types that are referenced; do not
   split a type graph by silently deleting accepted-event cases.
4. **Stable card definitions and records:** question option growth and answer IDs,
   record lifecycle, card metadata and dialect normalization. Port dependencies and
   tests together; no live processing yet.
5. **Durable processing:** sidecar/room serialization, queue/retry/outbox/card effects,
   exact interpretation policy, configuration and authorized socket handlers. Only
   enable processing after durable commits, reconnect and disabled-mode tests pass.
6. **Planner jobs:** adapt heading/refine/suggest/prose tools and transcript notices
   to current Harness, owner credentials and stream events. Preserve test-only
   scripted scenarios through current fake Harness conventions.
7. **Product surfaces:** cards and Save suggestions, then chat-first layout, annotations,
   evidence and analysis popover; port matching browser tests with each bounded slice.
8. **Research offers:** preserve consent/recovery/task snapshots/inline placement;
   adapt current isolated research workers and child publication, then offer UI/tests.

Steps 3–8 are dependency boundaries, not permission to implement them in one large
commit. Inspect coupling at each step and split only where intermediate code compiles
and its behavior is independently testable. Product regression coverage remains owned
by these steps even when eval tooling also consumes the modules.

## Current-main compatibility blockers

- Old Planner job code speaks direct Copilot SDK tools/sessions. Main speaks
  `HarnessAgent` and AI SDK stream parts, supports Copilot and Pi, and rechecks the
  live tool allowlist. Port tool behavior, not old clients or runtime files.
- Main's local device sign-in restores a new process session; it does not reclaim
  Planner ownership. Processing/job/research startup cannot assume a restored
  credential automatically authorizes replay or new work.
- Main description/research definitions use current isolated workers, job publication
  and child reconciliation. Old research and runner changes must preserve those
  boundaries, including active-owner fencing and persistence before publication.
- Proto sidecar additions interact with current description/creation/lifecycle fields;
  whole-file replacement would lose newer durable fields and guards.
- Current design contracts and browser fixtures are newer than the archive. Preserve
  them and selectively reconcile layout/card styles and test preloads.
- Existing Save quality failure (CP-063/D19): a linked direct choice is rejected by a
  separate message-confidence gate. It remains preserved and unaddressed; extraction
  must not tune policy or relabel the dataset to hide it.

## First-slice verification and handoff

Separate implementer and independent reviewer completed this bounded slice. The
reviewer approved it with no extraction regressions or major map omissions.

- Jev production source is byte-identical to the preserved snapshot.
- All five original tests remain; five mocked boundary tests were added.
- Independent Bun 1.4.2 run: 10 passed, 0 failed, 43 assertions, including the
  original response-after-20-seconds regression.
- `bun run types` passed for all workspace packages and E2E declarations.
- `bun run fix` and `bun run ci` passed. Two existing lint warnings remain in
  `packages/editor/src/widgets/research.tsx` and
  `apps/server/src/harness/github-tools.test.ts`; the design check reports its
  one existing baseline finding and no new findings. Formatting touched only
  this milestone's files; package metadata and lockfile remain unchanged.
- Inventory checked against Git: 287 paths, each once (273 product, 14 eval
  tooling). The relative document link resolves with exact casing.

Inherited transport caveats remain unchanged: extra runtime request properties can
override the selected model; pre-aborted callers still invoke fetch; optional noul
criteria do not have complete request bounds. Assess these in a separately scoped
change before live integration, rather than mixing fixes into preservation.

No PostgreSQL, browser integration, complete unit suite, live provider, or model
quality run was performed. The offline tests inject fetch stubs and dummy keys.
The TypeSafe documentation index and [HTTP API](https://docs.typesafe.ai/api) were
read without inference calls; this does not establish live service compatibility.
This dormant transport is not end-to-end Jev chat, a live provider compatibility
measurement, a quality baseline, or a verified release of the preserved prototype.

No push, merge, paid calls, new database, migration execution, credential copies,
port-8787 handoff, app restart or other-worktree mutation is part of this milestone.
The old automatic goal remains paused. Continued work below belongs to this product
extraction chat; it does not resume the old prototype goal.

## Stored decision identity slice

Extract `storedText()` and `identified()` unchanged from the preserved schema and
export the validator publicly. It validates durable IDs, order and raw text lengths
without re-keying, trimming, freezing or mutating a definition. Current `normalize()`,
shared drafts and answer derivation retain their existing behavior.

The two archived validator tests are retained with the pending-card validator portion.
Its draft-mode and unanswered-derive assertions depend on the later draft slice and
remain explicitly pending; changing draft behavior here would exceed this boundary.
Five additional tests cover stable IDs/order/identity, duplicate IDs across questions,
unknown fields, counts, and every raw text field. Test-first verification failed on the
missing public export, then passed after extraction. Independent review approved the
slice: 33 question-package tests passed, 0 failed (99 assertions), on Bun 1.4.2.
Full workspace types passed; formatting and CI checks passed with existing warnings.
The validator has no runtime consumers yet; durable restoration integration is pending.

## Product tests with eval dependencies

Seven archived product tests currently read eval development fixtures or helpers:
`d01-provenance-acceptance.test.ts`, `d01-scoped-endorsement.test.ts`,
`d02-deferral-domain.test.ts`, `d02-deferral-effects.test.ts`,
`d02-team-deferral.test.ts`, `d19-flow.test.ts`, and `quotes.test.ts` under
`apps/server/src/conversation-plan/`. Keep their assertions with the product slices.
Extract only the test messages, injected model replies and narrow state observations
needed by those assertions into product test fixtures/helpers with source provenance.
Do not import the eval runner/scorer/dataset tree or skip these tests. Original material
stays archived; reserved examples stay sealed. This adaptation is required before
claiming those slices' product regression coverage passes independently of eval tooling.

## Conversation contract and source provenance slice

Extract the complete archived `ConversationPlan` namespace and `sources.ts` unchanged.
The public namespace type export preserves all Save, research, correction and event
cases. Global Incoming/Outgoing unions, session flags and runtime routes are unchanged;
wire activation waits for authorized producers/handlers/consumers together.

Six focused source tests cover exact UTF-16 spans (including emoji), completed saved
member/agent messages, source identity, text and author matching, streaming rejection,
unknown fields, missing fields, bounds and role allowlist. Test-first verification
failed on the missing module before extraction. Existing handle-length and enumerable
property shape quirks remain inherited; no classifier or validation behavior was tuned.
Independent review approved the slice: six source tests passed, 0 failed (53
assertions), and the protocol type check passed on Bun 1.4.2. The implementer also
verified the 39 combined source/question tests (152 assertions). Full workspace types,
formatting and CI passed with the same existing warnings. These checks establish
standalone provenance validation, not live conversation integration.

## Exact quote extraction slice

The parser and quote budget are byte-identical to the archive. All four original
quote test bodies and assertions remain; five exact development messages now live in
`quotes.test-fixtures.ts` with archive SHA, case, step and source path. No labels,
scoring or dataset imports accompany them. Root and reviewer checked text parity,
including apostrophes and UTF-16 offsets. A fifth regression verifies that four
candidates succeed and a fifth throws rather than silently losing source evidence.

Test-first verification failed on the missing parser module before extraction.
Independent review approved the slice: 5 tests passed, 0 failed (20 assertions), on
Bun 1.4.2. Full workspace types, formatting and CI passed with existing warnings.
This resolves `quotes.test.ts`'s eval fixture dependency; the other six listed product
test adaptations remain pending. No parsing rules or classifier policy changed.

Next bounded pure-state sub-slice: event/correction shape validation. Keep its archived
function bodies and strictness, extracting event and correction modules plus shared
field guards behind the existing `validation.ts` entry point. This preserves behavior
while avoiding importing the entire 855-line validation file at once. Research/state
validators, event replay/domain and durable processing remain later dependencies.
