# Jev product extraction — handoff

This is a finite extraction from a preserved prototype, not a verified release or
classifier-quality fix. The transport, stable identity, provenance, validation and replay foundations are
implemented in bounded slices.

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

## Reviewed foundation slices

Each slice has a separate implementer and independent reviewer. Missing-module or
missing-export checks failed before extraction, then passed. The table records the
independent focused results on Bun 1.4.2; every slice also passed full workspace
and E2E type checks, formatting and CI with the existing warnings listed above.

| Slice                            | Preserved behavior and evidence                                                                                                                                                                                                                                                                             | Focused result                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Stored identity                  | Original `storedText()`/`identified()` and public export; IDs, order and raw strings survive without mutation. Normalisation and draft behavior stay current.                                                                                                                                               | 33 question tests, 99 assertions          |
| Contract and sources             | Complete archived `ConversationPlan` namespace, type export and `sources.ts`; exact UTF-16 spans, saved author/text identity and completed messages. Global wire unions and session flags stay current.                                                                                                     | 6 source tests, 53 assertions             |
| Quotes                           | Byte-identical parser/budget, all four original test bodies, plus explicit fifth-candidate rejection. Five exact development messages have source provenance.                                                                                                                                               | 5 tests, 20 assertions                    |
| Event/correction guards          | Original functions in bounded modules with an acyclic façade; all event and correction cases remain.                                                                                                                                                                                                        | 7 tests, 88 assertions                    |
| Research/snapshot guards         | Completes the original validation façade. Root syntax-tree proof: all 17 original functions and six constants occur once and match.                                                                                                                                                                         | 12 tests, 81 assertions                   |
| Accepted-event replay            | All 21 original case bodies, support functions, opening/preamble and counters match source syntax trees; `preference.ts` is byte-identical. Routing covers each case once.                                                                                                                                  | 9 tests, 51 assertions                    |
| Pure domain                      | All 18 archived functions and 18 original test callbacks/helpers match source syntax trees. Small, acyclic modules retain the original 11 public APIs.                                                                                                                                                      | 18 tests, 58 assertions                   |
| Research-offer regressions       | All 10 original tests and helper data match source syntax trees across three small suites; no production changes or eval imports.                                                                                                                                                                           | 10 tests, 72 assertions                   |
| Card and Save regressions        | All 17 original card tests and helpers match source syntax trees; four scoped Save tests are byte-identical. Card authority and exact support lineage remain unchanged.                                                                                                                                     | 21 tests, 71 assertions                   |
| Option growth                    | Byte-identical archived helper and six original tests; limit/export additions only. Cloned drafts keep existing selections and labels grow in order.                                                                                                                                                        | 39 question tests, 110 assertions         |
| Answer identifiers               | Archived derivation adds IDs alongside labels from the same ordered selection; optional protocol field retains old answers. Custom answers and summaries stay unchanged.                                                                                                                                    | 64 question/service tests, 171 assertions |
| Record validation                | All 25 original function/constant/type declarations match source syntax trees; seven archived tests are byte-identical. Extracted required dialect MAX_ID=200; added UTF-16 boundary regression.                                                                                                            | 8 record tests, 29 assertions             |
| Pending-card drafts              | Whole draft implementation matches archive; restored original empty-card mode assertions and added first-option selection/ID regression. Existing stored modes stay unchanged.                                                                                                                              | 73 focused tests, 205 assertions          |
| Shared definitions               | Store restoration and controller Open.Reply use identified definitions; existing wire types cover them. One original Store callback/helper and five new regressions cover stable IDs, pending cards and malformed payloads.                                                                                 | 79 focused tests, 226 assertions          |
| Store options/lifecycle          | Small acyclic modules preserve archived APIs/types, capture/revert, reopening and editor credit. Nine of 19 original Store callbacks are retained; 17 other core bodies remain unchanged apart from editor initialisation.                                                                                  | 99 focused tests, 292 assertions          |
| Store suggestions                | Archived suggestion metadata, restore bounds and explicit submit fallback; all 47 Store declarations and 19 original callbacks are retained exactly once across small suites. Existing service callers remain unchanged.                                                                                    | 109 focused tests, 348 assertions         |
| Durable record restore           | Canonical record defaults, matching saved definitions/drafts and transcript-checked option sources are integrated into current sidecar restoration. Ten memory persistence regressions; current metadata and mutation bodies remain intact.                                                                 | 129 focused tests, 417 assertions         |
| Request builders                 | All 18 archived declarations and exact prompts are split across acyclic modules. Thirteen original builder callbacks and nine fixture declarations are retained; two interpreter cases remain assigned to their dependency slice.                                                                           | 111 conversation tests, 580 assertions    |
| Review/correction coverage       | All 19 original callbacks and 18 actor/helper declarations are retained, including the complete three-case excerpt table. Twenty-one cases exercise existing pure behavior; production is unchanged.                                                                                                        | 132 conversation tests, 669 assertions    |
| Policy leaves                    | All 24 archived helper/type/constant declarations are retained across five small acyclic modules. One exact pipeline callback verifies deterministic ULID identity and Unix-second encoding. No policy dispatcher or placeholder exists yet.                                                                | 133 conversation tests, 673 assertions    |
| Initial policy terminals         | All 20 original preamble/fact/gate statements are retained with ordered internal calls; one unset initializer is explicitly undefined for lint. Three whole pipeline callbacks cover 18 cases; bounded regressions cover ordering, staging, capture and continuation.                                       | 171 conversation tests, 801 assertions    |
| Remaining policy terminals       | All 13 original statements through the purpose/final-question gate are retained across four stages and an ordered runner. Five whole pipeline callbacks remain exact; working writeback, local staging, cached captures and explicit continuation are covered.                                              | 192 conversation tests, 924 assertions    |
| Candidate setup                  | All six original statements retain order and captured inputs; four private mutable run fields are cached, with the prior-choice map local. Grouping, distinct known/linked/novel choices, evidence thresholds, fresh sets and input-state provenance are covered.                                           | 224 conversation tests, 1,035 assertions  |
| Candidate entry and role         | All six entry and 33 role statements retain original conditions and order, with eight candidate-loop continues mapped to undefined skips. Captured references, group retargeting, consumed labels, partial opening writes and selected-target preservation are covered.                                     | 251 conversation tests, 1,191 assertions  |
| Candidate factories/verification | Exact source/base declarations and eight early verification/condition statements retain capture timing and handled skips. Active-local working reads, valid deferred-domain histories, partial resume writes and cached spike labels are covered.                                                           | 266 conversation tests, 1,288 assertions  |
| Scoped and new-choice handlers   | All seven original statements preserve order, with exactly five handled skips. Scoped captures and labels, replay-valid histories, active-local factories, staged version overrides and partial push failures are covered.                                                                                  | 293 conversation tests, 1,484 assertions  |
| Withdrawal, agreement, question  | Three exact ordinary-role consequent bodies preserve statement order and three handled skips. Captured withdrawal ownership, current effective pending, raw option answers, question thresholds and target assignment before/after factory evaluation are covered.                                          | 316 conversation tests, 1,629 assertions  |
| Contribution proposals           | Eight exact consequent statements preserve order and four handled skips. Fresh card lookups, captured contribution/pending targets, role-specific quote filters, duplicate exemption, relation omission and construction timing are covered.                                                                | 343 conversation tests, 1,821 assertions  |
| Support and objection proposals  | Two exact consequent statements preserve order and two handled skips. Captured card uniqueness and option fallback, material reopening, current scoped history, historical agreement after withdrawal and partial review publication are covered.                                                           | 377 conversation tests, 2,028 assertions  |
| Resolution and reopening         | Fourteen resolution statements and one reopening conditional retain six handled skips. Credibility, fresh chosen/card lookup, captured targets, pending conflicts, staged linked-card construction and partial publication are covered.                                                                     | 411 conversation tests, 2,271 assertions  |
| Ordinary application             | The exact whole try/catch retains main application, raw pending deferral, distinct-supporter leaning and agreement follow-ups. Active-local versions, original support caps, uncapped constraint deferral and partial publication after caught failure are covered.                                         | 440 conversation tests, 2,490 assertions  |
| Complete pure policy             | Final fallback, bounded gate and result retain three whole nodes. All seven proposal route conditions, original candidate-loop binding, no-proposal continue and loop-bottom break preserve exact source tests and order. Complete offline public outputs and separately seeded final failures are covered. | 474 conversation tests, 2,606 assertions  |
| Pure interpreter                 | The original research guard, request await and catch remain in main. Synchronous offer selection preserves the original model conditional, seven types/helpers, targeting batch order and failure handling. Six whole pipeline callbacks, deferred question loop and original D19 suite are restored.       | 485 conversation tests, 2,650 assertions  |
| Pure effects                     | Fourteen exact archived declarations across six acyclic modules preserve projection, strict outbox restoration, recovery and ordered retry delivery. All 25 original callbacks and three whole interpreter/effects pipeline callbacks are retained.                                                         | 28 focused tests, 118 assertions          |
| Planner job state                | The 189-line module is byte-identical; all 22 original declarations and 12 whole callbacks retain deduplication, coalescing, retries, interrupted-job restoration and strict bounds. No Planner delivery is activated.                                                                                      | 12 focused tests, 85 assertions           |
| Durable card actions             | The 159-line model and complete original test file are retained; the exact CardEvent type moves into a private leaf with a type-only import redirect. Generations, identities, copied choices, UTF-16 truncation and strict queue bounds remain unchanged.                                                  | 3 focused tests, 13 assertions            |

The combined guard/source/quote run passed 30 tests (242 assertions). Domain/replay
checks passed 27 tests (109 assertions). The complete extracted foundation and
question-package run passed 100 tests, 0 failed (493 assertions, 20.92 seconds). Replay tests
cover immutable inputs, stale versions, contributions, decisions, deferral/resumption,
correction target counters, support withdrawals and exact Save lineage. Conversation
processing remains dormant; existing question paths use the extracted answer, draft
and definition validation behavior. Saved evidence, authenticated callers and persistence before
publication belong to the integration slices. Current question submission returns the
new IDs but still persists/projects summarised strings; durable ID-backed records
remain pending. Domain tests preserve saved provenance,
replay restoration, correction retries, card authority and atomic analysis completion.

Inherited behavior stays visible:

- Option growth assumes a valid single-question definition/model and a caller-supplied
  unique durable ID. Its label limit and 10-option cap do not validate IDs.
- Record normalisation preserves unknown top-level fields and shallow nested references.
  Definition, anchors, current-answer completeness and some string bounds remain
  partial checks; source shape/ref matching does not prove saved Chat provenance.
- Stored empty single-choice definitions are valid. Newly created pending drafts
  now start in `choices`; stored `custom` modes/text are read and restored unchanged.
- Tool normalisation assigns option IDs per question; stored multi-question definitions
  must have globally unique IDs. The old duplicate-ID controller fixture remains
  rejected; valid legacy fixtures preserve their saved IDs.
- Source guards retain uncapped handles and unusual enumerable-property shape quirks;
  ordinary JSON arrays fail. Shape checks do not prove saved provenance.
- `card.corrected` accepts `add-excerpt` despite its narrower protocol union.
- Snapshot guards do not check thread contents or event-ID uniqueness. Choice
  membership uses inherited properties; outcome IDs reference analysis records rather
  than proving accepted replay. Research shape checks do not authorise consent.
- Duplicate event IDs return before checking changed bodies. Opening shares unchanged
  prior objects; legacy candidate confirmation retains pending proposals.
- Scoped Save stays provisional with its evidence retained, as intended.
- Restore checks saved text only when a transcript is supplied. Research action retries
  compare identity while ignoring changed timestamps; transitions grant no execution authority.

## Product tests with eval dependencies

Seven archived product tests read eval development fixtures or helpers:
`d01-provenance-acceptance.test.ts`, `d01-scoped-endorsement.test.ts`,
`d02-deferral-domain.test.ts`, `d02-deferral-effects.test.ts`,
`d02-team-deferral.test.ts`, `d19-flow.test.ts`, and `quotes.test.ts` under
`apps/server/src/conversation-plan/`. Keep every assertion with its product slice.
Extract only the required messages, injected replies and narrow state observations
into product test fixtures/helpers with source provenance. Do not import runner,
scorer or dataset trees, or skip these tests. Reserved examples stay sealed.

The quote dependency is resolved: `quotes.test-fixtures.ts` contains exact D19/m1,m2,
D02/m2, D03/m1 and D04/m5 messages with archive SHA, case, step and path. Root and
reviewer verified text parity, apostrophes and UTF-16 offsets. The other six test
adaptations remain pending.

All 19 archived Store callbacks are retained across the bounded Store suites.
New Store mutation and suggestion APIs have no service/routes/UI callers yet.
Suggestions persist as metadata; their evidence IDs pass shape checks rather than
transcript provenance checks. Explicit submit fallback derives a copied draft and
leaves the shared model unchanged. Capture/revert retains references, reservations
require caller sequencing, and relabel bounds remain partial. The existing
stage-before-commit durability gap is unchanged. Server Store suggestions and
canonical records now round-trip through the memory sidecar open/close path.
Controller restoration remains independently tested;
PostgreSQL and socket recovery have not been run. Synthetic anchor fixtures gained
required canonical fields and one valid saved option; every original assertion stays.
New Planner asks initialize canonical collections, while existing text-answer
submission and history/choice mutations remain unchanged. Saved option sources are
checked against completed transcript text and authors, without claiming thread/event
authority.

Request builders retain the original 12-thread, 32-option and 23,500-character
context bounds and reserved IDs. Duplicate comparisons depend on the caller's saved
message prefix, excluding later, source-free, streaming and system evidence.
No request builder calls the model. The final parameterized `questions.test.ts`
interpreter callback (two cases) remains owned by policy/interpreter integration;
it has not been replaced with a skipped test.

Policy scoring thresholds, cue patterns and identity encoding remain unchanged.
The original D19 `policy.test.ts` callback and remaining `pipeline.test.ts` callbacks
stay assigned to later slices. The mixed pipeline source is 6,941 lines; its size
does not reduce coverage ownership. Policy dispatch, interpreter, durable processing,
Planner jobs and browser integration remain unimplemented.

The first four terminal stages preserve budget-before-initialization and
eligibility-before-facts ordering, topic/attribution/compound/recovery order, atomic
compound staging, and terminal recovery rejection. Captured messages and the original
quoted-option closure survive continuation. A wrapper capture mismatch was corrected
with a failing isolated negative control. Nineteen original statements remain exact;
the separated unset target initializer explicitly assigns `undefined` to satisfy
lint, with that one normalization permitted by the source proof. Policy gates stay exact.
Thirty-one terminal results match the preserved offline policy, with two explicit
continuation comparisons and input-mutation checks. These checks cover this prefix,
not the complete policy. Synthetic cap fixtures do not claim replay consistency.

The remaining four terminal stages retain all 13 original statements and five whole
pipeline callbacks. Offline checks match 30 terminal outputs and four continuation
states, including input-mutation checks. Three injected quoted-option failures and
one changed-message capture regression are verified separately.

Candidate setup retains six whole statements and four private run fields. Thirty-three
reached offline observations match the archived locals, including insertion order,
fresh sets, captured-message behavior and setup input-mutation checks. A synthetic
cached-label override is verified separately. The original full-policy callbacks
remain assigned to later dispatch slices; setup tests do not replace their assertions.

Candidate entry and role retain 39 whole statements, with exactly eight outer-loop
continues mapped to candidate skips. Offline observations match 23 entry progressions,
seven entry skips, 13 role progressions and six role skips at their original boundaries;
two injected push failures reproduce the original write timing and are counted separately.
These comparisons cover intermediate state, events, outcomes, captures and input
mutation. Event proposals and follow-ups remain unimplemented.

Candidate factories read the active handler's local working on each base call and
retain captured message/candidate references. Four factory creations, seven source
outputs and eight base outputs match the archived closures. Early verification checks
match four progressions and three handled skips; two mirrored push failures and two
independent quote-read controls are counted separately. Valid settlement histories
replay before and after resume. Continuation carries only the cached spike label,
not a base closure bound to the finished handler.

Scoped assent, proposal and direct new-choice handlers retain seven whole statements
and five handled skips. Stopped-boundary observations match seven assent progressions
and two handled skips, two proposal progressions and three handled skips, and one
new-choice progression and five handled skips. Six mirrored push failures, one source-read
failure and one synthetic cached-label override are verified separately. Scoped writes
retain applied working before pushes; new choices publish their locally staged working
only after both pushes. Valid card, scoped-proposal and settlement histories replay;
synthetic prior-batch cap fixtures do not claim replay consistency. No complete original
pipeline callback has been replaced by these bounded tests.

Withdrawal, agreement and question branches retain their whole original consequent
bodies, with exactly three outer-loop continues mapped to handled skips. Handlers are
called only for their matching captured role; a returned object with no proposed event
progresses to the original no-proposal guard, whose continue bypasses the ordinary
loop-bottom cap. That guard remains assigned to the later dispatcher. Stopped
observations match two withdrawal
progressions and five handled skips, four agreement progressions, and three question
progressions and two handled skips. Five mirrored factory/source failures and two
synthetic cached-question/group controls are verified separately. The baseline stops
after the whole role chain, before its original no-proposal guard and application.
Live snapshots preserve target/proposal write timing even when event construction
throws. Saved discard and settlement histories replay; no event is applied by these
handlers. Remaining original full-policy callbacks stay assigned whole.

Contribution proposals retain eight whole statements and four handled skips. The
handler is called only for its captured option, reason or constraint role. Nineteen
progressions and six handled skips match the stopped archived role chain; five
synthetic capture/group controls and separate base, source and quoted-text construction
failures are counted separately. Tests distinguish fresh card-map lookups from captured
thread contributions and pending qualification. Existing card names require the
original card identity and unique-name match, and the duplicate threshold retains its
option-group exemption. Valid histories and proposed contributions replay. Unknown
relations are omitted, and unsafe quote filters remain limited to option proposals.
These handlers apply no event; the original no-proposal guard, application and loop
cap remain assigned to later slices. Original full-policy callbacks remain assigned
whole.

Support and objection proposals retain two whole statements and two handled skips.
Twenty-two progressions and one handled skip match the stopped archived role chain;
six synthetic capture/review controls, separate base/source/text failures and two
mirrored review-push failures are counted separately. Replay-valid decided and scoped
agreement histories cover the 0.68 material-objection threshold and captured card
uniqueness, including bidirectional substring collisions and exact contribution text.
Scoped objection ownership still accepts an earlier agreement after active support
withdrawal; this inherited rule has not been strengthened. Support always leaves the
scoped proposal link null. Source parity proves proposal assignment precedes review
publication; thrown-push comparisons cover observable partial writes and error, without
claiming direct equality of the inaccessible product proposal local. Matching-role
wrappers retain the original branch type narrowing. No event is applied and no
full-policy callback is replaced.

Resolution and explicit reopening retain fourteen statements and one whole conditional,
with six handled skips. Stopped observations match three resolution progressions and
nine handled results, and three reopening progressions. Seven capture/seed controls
(one progression and six handled results, including the seeded reopening duplicate)
and twelve mirrored construction, validation and publication failures are counted
separately. The discarded-frame control explicitly replaces the captured frame in
the temporary baseline; the original prefix skips an initially discarded target.
Linked-card choices stage construction, preserve the original-version base with the
staged-version override, and assign applied working before event and ID pushes. A
second inference failure retains original working; later push failure retains applied
working and partial publication. This path provides no rollback after publication.
Explicit reopening preserves proposal-before-review ordering. The no-proposal guard
and loop-bottom cap remain unimplemented. Whole original full-policy callbacks remain
assigned to the eventual dispatcher.

Ordinary application retains the exact whole try/catch from archive policy.ts1634–1726,
without skip mappings. Its internal handler requires a definite event after the original
no-proposal guard and uses fresh factories bound to active local working. Stopped
observations match ten normal application results; nine batch/capture seeds and ten
mirrored inference, source and publication failures are counted separately. All four
temporary hook sites are checked exactly once, and every selected case reaches the
pre-application boundary. Observations stop after the try/catch before the original
loop-bottom cap and compare state, publications, outcomes, reviews and input mutations.

The original main/follow-up inference assigns working before publication; caught failures
retain applied state and partial event/ID writes. Constraint deferral reads raw pending
state after same-message neutral withdrawal and has no support-block event cap: an
explicit synthetic eleven-event batch reaches thirteen. Leaning uses distinct supporters,
and agreement retains the prior captured current reference with updated working history.
Only the exact no-useful-role gate changes to the accepted/review status. No ordinary
application dispatcher, no-proposal guard, loop cap or public policy facade is activated.

The complete pure public `planEvents(input)` runner now connects the reviewed stages in
original order: context and terminals, candidate setup, entry and role capture, cached
verification, scoped assent/proposal, direct new choice, matching ordinary proposals,
no-proposal continue, application and loop-bottom break. Every earlier handled skip
bypasses that cap. All seven role-routing conditions retain the exact original tests;
unknown truthy roles produce no proposal. The final fallback, 300-character gate and
result retain their three whole original nodes. Fallback uses live ownership/role
answers with cached direct-question state, index-zero IDs and full-message source;
validation does not assign returned working. Normal results retain the own selectedTarget
property even when undefined, while earlier terminal property omissions are unchanged.

Complete output comparisons match 57 ordinary public invocations and one quote-budget
rejection against the preserved original policy, using strict equality for full nested
results and input clones. They use complete real-input execution without injected stage
state. Independent review also matches 75 strict complete outputs across 21 fixture
families at ownership thresholds 0.69, 0.7 and 0.95, three input shapes and nine
optionless stance controls, with zero seeds or input mutations. These independent observations are reported separately.
Five synthetic final-context observations and three receiver-based publication failures
are counted separately, with one exact reached final-boundary hook per invocation.
The four-quote budget remains intact; enlarged publication batches from earlier unit
slices are synthetic controls rather than complete public comparisons.

Original pipeline ownership remains nine of 140 whole callback nodes retained and 131
explicitly deferred; existing callback bodies and repository imports are unchanged.
Temporary validation redirects retained terminal callbacks through the complete public
runner without rewriting them. The original public exports remain PolicyInput,
PolicyResult, optionIdFor, bareEditorClarificationThread and planEvents. No runtime
caller, configuration, paid provider or service activation is added.

The pure interpreter now retains eight outer statements, 25 nonresearch try statements,
original catches, research guard/request await and all seven type/helper declarations.
Only the whole model-checked offer-selection conditional moves into a synchronous
private helper at the same source position. The original await boundaries are unchanged;
member-source narrowing is a wrapper-only type assertion. Both false-guard and eligible
research scheduling regressions pass; temporary extra-await negative controls fail with
zero targeting calls at the observation point instead of one.

Six additional whole pipeline callbacks are retained, bringing ownership to 15 of 140
nodes with 125 explicitly deferred. The final original question interpreter outer loop
is preserved once and executes both cases, completing all 14 question callback nodes
and 15 executed cases. The original 123-line D19 fourth-candidate policy suite is
byte-identical under its new filename. Exact fixture helpers are reused where already
retained, and five new archive declarations preserve their bodies unchanged.

Independent review compares 30 strict complete interpretation outputs, request traces
and replies against the complete original interpreter and original policy: 15 research
offers, five failed interpretations and 12 events. Four dispatch-order controls also
match. These cases use replay-valid histories and injected transport, without stage
seeds; only existing numeric analysis latency is normalized. Input mutations and own
property presence are checked. Research model mismatch/failure remains silent and
records no research analysis pass. No runtime consumer or paid transport is activated.

The complete pure effects API retains all fourteen original declarations and eleven
fixture declarations once across small modules and suites. Its 25 whole tests and
three interpreter/effects bridge callbacks preserve ordered delivery, per-thread failure
blocking, receipt timing, retryable targets and explicit research omission. Pipeline
ownership is now 18 of 140 whole nodes, with 122 assigned to later groups.

The Planner job-state module is byte-identical and all twelve original callbacks remain.
The durable card-action model retains its complete source and three-test suite; only a
type-only import points to the unchanged CardEvent alias extracted into a private leaf.
These are complete pure boundaries, with no room, service or Planner consumer activated.

The combined foundation, effects, jobs and card-action run passes 528 tests with
2,866 assertions. Workspace/E2E types and CI pass with inherited findings only.

Next: actual conversation processing, durable sidecar/outbox persistence and Planner
delivery, with real integrated regressions before a backend milestone claim. Remaining
whole pipeline callbacks stay explicitly assigned and can be restored in bounded groups.

The complete processor now retains its ten-method public API and original asynchronous
boundaries across synchronous private factories. All 33 original callback nodes execute
40 cases. Five real MemoryStorage tests and one capture-order control also pass: message
acceptance, queued work, analysis, pending effects, receipts and retries survive close/open.
A failed receipt commit rolls back live and durable receipt state and replays the same
pending key after reopening. This verifies recovery; effect consumers still own idempotency.
Eight temporary strict comparisons against the original processor match complete state,
durable snapshots, publications, errors and method results with identical clock and ID
entropy. No model provider is called.

The current Plan service now persists and validates conversation state, retries, Planner
jobs, pending effects, receipts and pending card actions. Interrupted running jobs become
failed and commit before opening returns; observational reads do not write. Existing
canonical question validation and current-main authentication, graph and storage behavior
remain. All twelve selected original Plan persistence callbacks are retained, including
actual processor acceptance followed by reopening. The existing chat-option provenance
fixture now creates accepted events rather than inventing an unbacked chat source.

Room/chat consumer activation and actual Planner execution remain pending. This checkpoint
alone does not satisfy the requested backend milestone. The next parallel slices connect
Planner delivery and real card consumers, with independent review and integrated recovery
checks before claiming that milestone.

Combined processor, Plan, conversation and question checks pass 771 tests with 3,738
assertions. Workspace/E2E types and CI pass with inherited findings only.

The complete Planner delivery coordinator, context selection, prompts and prose-intent
helpers retain all 47 original callbacks. Four real MemoryStorage integrations connect
the actual processor and interpreter to durable enqueueing. Receipts and running state
commit before the scripted runner executes; completion and activity persist together.
Failed enqueueing retains the pending effect, explicit retry preserves job identity, and
stopped running work becomes interrupted on reopening without automatic replay.

Card projection prerequisites now preserve thread/status, chosen IDs and previous-choice
history through the restricted dialect and Lexical serialization. All 25 original node
callbacks and twelve original room projection callbacks remain. Protocol additions retain
current consumers and the existing cancellation API. A broad schema rewrite was rejected
by automatic approval review; bounded patches were approved after proving unrelated
validation rules unchanged. No rejected source write executed.

Staged publication commits the candidate document and sidecar before adopting or
broadcasting their state. Four new storage tests cover held and rejected commits,
reopening, the implementation guard and default-preserving notification suppression.
This evidence covers document and receipt isolation; the fixture does not change records
or drafts. Ten whole original notice tests cover rollback, ordering, stable IDs and
reopening. Notice metadata validation and accepted scoped-evidence checks are retained.
Ordinary instruction notices preserve the current persistence callback and queue behavior.

The original heading and job-scope functions retain all fourteen original callbacks.
Three new tests execute the actual heading tool through the current Harness and storage,
verify the live write boundary, and reject unsupported job kinds. The installed Harness
requires constructor-specific active tools, so the heading profile offers read tools and
its own writer. Ordinary Planner tool names remain unchanged; Copilot and Pi adapters,
ownership, credentials and disposable-session cleanup retain their current lifecycle.
A temporary negative control confirms that disabling the live refusal makes the foreign
write test fail. No paid inference is used.

The combined affected backend, Harness, dialect and question run passes 1,267 tests with
5,623 assertions. Workspace/E2E types and CI pass with inherited findings only. The Pi
contract uses its existing disposable loopback stub, with nine passing contract cases.

Next: actual Chat job FIFO and saved-message hook integration, complete card effect
consumers and remaining scoped job tools. These components are now verified separately,
but live conversation-to-Planner wiring is still required for the requested backend
milestone. Remaining whole pipeline callbacks stay assigned to their implementation groups.

The integrated backend now binds saved room messages to the actual conversation
processor and interpreter, durable sidecar and outbox, card consumers and current
Chat/Harness Planner runtime. Acceptance persists the transcript and queued work
before acknowledgement or publication. Correction, scoped-save and explicit retry
commands use the authenticated member context and existing write/archive guards.
Configuration enables this path only with `CONVERSATION_PLAN=on`; no application
instance was activated during extraction.

Actual MemoryStorage integrations exercise card creation, linking, receipts and
close/open recovery through the real runtime factory. Heading, refinement,
suggestions and prose jobs execute through the current Harness dispatch and actual
tools. Their profiles offer read tools plus their own writer; streamed foreign
writers fail the live boundary. Ordinary Planner turns gain the intended
`revise_open_decision` tool. Existing Copilot and Pi adapters, ownership and credential
boundaries remain. The prior unsupported-prose constructor test now checks an unknown
job kind because prose is supported.

All 62 original card-consumer cases remain. Question durability retains 28 additional
service callbacks, 18 prose callbacks and six option-source callbacks, alongside
seven previously retained originals and all nine current service cases. Scoped tools
retain 57 original cases and seven byte-identical write-prose tests. Chat retains
16 complete original callbacks. Private test bridges adapt old fixture calls to the
real current AI SDK tools; no production compatibility adapter was added.

Original prose tests exposed missing relationship metadata, empty-caret handling
and rebasing against the wrong source. The exact archived room projection,
reconciliation and restoration functions and Plan relationship snapshots are restored.
Server rewrites explicitly pass the pre-edit source when rebasing. Existing canonical
validation and unrelated current room and Plan functions remain source-proved.

Independent review reproduced a post-close card commit while an effect batch was
held in storage. The processor now exposes an additive idle drain, and runtime stop
waits for effects, Planner cleanup and card mirroring before document close. Runtime
replacement also waits for that drain. A second review reproduced overlapping stop
calls resolving prematurely; repeated calls now share the same drain. Held-commit
regressions verify both shutdown and replacement against actual card consumers.
Cancellation clears live Planner write scope immediately; interrupted jobs are durable
and are not replayed automatically after reopening.

A combined run exposed cached test-fixture cleanup hooks leaving Chat linger timers
alive and contaminating later Pi cases. Registering the unchanged cleanup hooks in
each split job suite fixes the fixture isolation; production timers and presence
handling were not changed. The combined Chat/Pi check then passes 145 cases.

This milestone verifies backend behavior with offline interpreter answers, the current
Harness using deterministic test streams, and MemoryStorage. It does not establish
paid-model quality, PostgreSQL deployment behavior or browser behavior. No paid
inference, database migration, application restart or evaluation dataset import ran.
Frontend and research command integration and the remaining 122 assigned whole
pipeline callbacks remain later extraction work; the larger product goal is unfinished.

The broader backend run also caught two existing synthetic fixture assumptions: an
exact processor API list omitted the additive idle method, and an answered decision
had no options, which the restored canonical record validator rejects. Only those
fixtures are corrected; dependency-capture, rewrite, anchor and comment assertions
and production validation remain intact.

Final integrated backend, Harness, dialect, question and protocol verification passes
1,935 tests across 294 files with 9,388 assertions and no failures. The two PostgreSQL
suites are explicitly skipped without a test database. Workspace and E2E TypeScript
checks pass. CI passes with only two inherited lint warnings and the existing design
baseline finding. All seven runtime, processor, card, question, scoped-tool, Chat and
configuration source-parity checks pass after formatting.

Research consent now reaches the current server runtime. Two whole original socket
command cases retain writer/archive checks, authenticated consent and forced access
refresh for observational link lookup. The accepted-offer executor rechecks the live
requester and current process owner before start and again before enqueue. Existing
Chat research creation now uses the same durable inline placement path. Explicit
startup and restore recovery retain pending-reference identity; shutdown awaits an
in-flight recovery before closing documents. Reads do not launch recovery or work.

Research service and storage preserve 279 archived declarations, including 258
unchanged ancestor declarations. Nineteen additional whole original service/storage
callbacks and all original helper/table data remain. Both providers validate Research
projections inside the fenced document commit. Migration 015 and the original
PostgreSQL race/startup regressions are retained as source only; no migration or
PostgreSQL test ran. Four complete original Plan placement callbacks exercise held,
failed and repeated commits and the implementation guard. All 137 existing Plan/room
declarations remain unchanged alongside the two original placement functions.

Eleven new integrations connect the actual processor, consent executor, current owner
resolution, real issued sessions, ResearchWorkspaceService, JobService, Plan placement
and MemoryStorage. They verify frozen consent identity, reference and placed-marker
commit before enqueue, held/failed publication, idempotent consent and lookup, actual
owner revocation between placement and enqueue, resume by a second authenticated
member without changing the original actor, and writer/archive/read-access gates.
No research worker or model provider executes in these tests.

Nine further whole linked-card and ordinary-Save pipeline callbacks are retained unchanged. Pipeline
ownership is now 27 of 140 callback nodes; 113 remain assigned to later slices. A new
actual runtime test separately verifies conversation interpretation, a linked human
option, advisory prompt, human Save, commit-before-acknowledgement, card mirroring and
close/open recovery. Bypassing its held commit makes the durable-state assertion fail.
This test does not change the retained CP-063/D19 policy behavior.

Independent review reproduced two shutdown races through the actual current runtime.
A research host tool could wait behind the document lock held by close while close
waited for Chat. Placement now checks room closing before requesting that lock and
again inside it, and refuses already-closing Plan persistence. The real Harness
regression verifies close completes, the same durable request remains pending and
no evidence job is queued.

A consent command could also commit its delivery receipt after processor idle and
Plan close. A separate in-flight set now tracks public asynchronous commands without
changing their original bodies, awaits or returned promises. Idle drains commands
and the existing effects loop until both settle. The held-callback regression verifies
the receipt commits before close and survives reopening, with no after-close commit.
Both original failures were reproduced before the fixes; independent review approves
these narrow lifecycle changes. All 29 original processor awaits remain intact.

Fresh focused lifecycle verification passes eight tests with 42 assertions. The
combined checkpoint also passes workspace and E2E types and CI. PostgreSQL
regressions remain source-only; runtime coverage uses MemoryStorage and offline
Harness streams. No application instance, paid model or evaluation runner ran.
