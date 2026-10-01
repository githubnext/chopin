# Jev product extraction — handoff

This is a finite extraction from a preserved prototype, not a verified release or
classifier-quality fix. The transport, stable identity, provenance, validation and replay foundations are
implemented in bounded slices.

- Product branch: `Maggie/jev-chat-product` (existing canonical Git reference casing).
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

The original Conversation Save prompts now receive live questionnaire definitions,
card status/generation metadata and the room's conversation state. The restored
latest-prompt routing preserves ordinary message grouping, tools, composer, layout
and current authorization. Stores reset when the room or connection changes. Six
whole original transcript/model callbacks remain alongside current tests.

The scoped prompt initially trusted the conversation's contribution summary as its
option list. Review reproduced a valid canonical card option missing from that
summary, which disabled Save. The prompt now checks the current card definition,
unique option ID and exact proposal label, while preserving every other original
proposal, version, generation, support and status guard and the complete Save body.
Twelve regressions cover valid options and missing, stale, renamed or duplicate
canonical options. The actual transcript passes the current card snapshot.

Questionnaire transport preserves all original submit, shared draft, generation,
reopen and deferred teardown behavior, together with current cancellation. A
reproduced failed-cancel teardown leak is fixed by settling unobserved cleanup in
cancel's finalizer. The natural controller owns the private state; the public hook
keeps shared caches and existing exports. Suggestion projection is retained as a
pure leaf; the larger QuestionView and remaining card surface are later work.

Editor metadata, unanswered counts, document-content checks and prose bindings
retain their complete original functions and callbacks. Existing editor geometry,
selection and display behavior remain. Save components use the current typography
roles. The original DecisionIcon follows the existing typed LineIcon boundary;
its one reviewed forwarding exception and owner hash are the only design-contract
manifest additions. The web package directly declares its new question dependency.

This checkpoint covers server and pure/SSR browser-side behavior. PostgreSQL
regressions and migration 015 are retained but were not executed. No browser
session, database migration, application restart, paid inference or evaluation
runner was used. Remaining pipeline callbacks, QuestionView/card interactions,
conversation analysis and research-offer surfaces, and deployment configuration
remain extraction work. The overall product goal is unfinished.

The combined server, web, dialect, question, protocol, editor and icon run passes
2,710 tests across 410 files with 12,639 assertions and no failures; two PostgreSQL
suites are explicitly skipped without a database. Workspace and E2E TypeScript
checks pass. CI passes with only two inherited lint warnings and the existing
design baseline finding. All eleven research, placement, processor, browser Save,
controller, editor and callback-preservation checks pass after formatting.

The next bounded slice restores the exact suggestion-edit reducer and its two whole
original callbacks. Cancelling option composition restores an advisory suggestion
without undoing a human answer edit; text entered before a suggestion continues to
suppress replacement. All existing projection types, function, fixtures and tests
remain unchanged. The full question package passes 61 tests with 214 assertions;
focused reducer/projection coverage passes four tests with 20 assertions. Question
view rendering and card-host wiring remain separate subsequent work.

Seven further whole pipeline lifecycle callbacks are restored with their exact
shared helpers. They cover deliberate re-raise after discard, refusing settlement
of a decided target, human reopening review and preservation of earlier decisions.
The focused group passes seven tests with 25 assertions. Pipeline ownership is now
34 of 140 whole callbacks, with 106 assigned to subsequent groups.

QuestionView now projects the original advisory suggestion into its existing
controls without changing the shared draft. Human edits retain priority; Save
forwards the exact displayed option/revision snapshot and single-card readiness
uses the displayed draft. Current layout, cancellation, labels, error motion,
scrolling and host step rendering remain. The original rationale callback is
retained whole; the original anatomy and `Save` caption assertions remain deferred
to their applicable card surface instead of weakening them for `Save answer`.
The original AUTH fixture now has one shared declaration. The question package
passes 69 tests with 236 assertions; SSR coverage is not mounted browser evidence.
The existing three class-forwarding cases are unchanged; only their reviewed
QuestionView owner hash is renewed. Metadata-aware card hosts remain later work.

The original optional conversation configuration block is restored in `.env.example`.
Self-hosting lists its implemented flag, model alias, timeout and server-side key.
Current Planner model, Harness, local sign-in, credentials and deployment defaults
remain. Compose files are unchanged in this slice; container forwarding remains a
separate configuration review. No service was activated by editing examples.

The supplied Compose service now forwards the optional conversation flag, model
alias and server key using direct late-bound references. Every existing environment
entry and the complete original Compose test callback remain unchanged. The timeout
keeps the server's 30-second default: forwarding an unset optional value as an empty
string would fail the retained strict timeout validation. Self-hosting explains the
explicit override boundary. Five Compose/configuration tests pass with 54 assertions;
no container, service or database was started.

The next card-host slice connects the existing room metadata store to inline cards,
Decisions and the unanswered badge. Authoritative reopened status overrides delayed
answered nodes; terminal cards remain non-editable before answer projection arrives.
Discarded cards render cancellation and their recorded resolver without borrowing an
earlier node actor or time. Chosen IDs resolve through current canonical labels;
legacy custom answers retain their original text. Existing layout, Cancel, step
motion, history and controller lifecycle are preserved. The workspace passes its
edit permission explicitly; standalone Decisions retains its previous default.

Two whole original card callbacks and their shared fixtures are restored. Eight
whole provenance pipeline callbacks cover sourced agreement, retraction, concerns
and direct pending-option support using the public planEvents entry point. Unique
pipeline retention is 42 of 140 callbacks, with 98 remaining. The existing design
exceptions retain all cases; only two reviewed owner hashes change. One design-test
locator now follows the suggestion-forwarding Save callback, preserving its button
size and tier assertions. Mounted browser behavior remains unverified.

The frozen metadata/provenance checkpoint passes 2,747 combined tests with 12,801
assertions across 420 files and no failures. Two PostgreSQL suites skip without a
database. Full workspace/E2E type checks and CI pass, retaining only the two inherited
lint warnings and the existing design baseline finding. Exact callback, component
and RoomWorkspace source-preservation proofs pass after formatting.

The original research-offer module and all eight whole test callbacks are restored.
Offers appear under their exact source message, exclude queued messages and preserve
the escaped public brief. Read-only link observers retain their bounded retry and
stale-reply cleanup; they never start or resume research. The explicit workspace
action retains writer/connection checks, live offer/link checks, duplicate suppression
and the room/socket/connection generation fence. Current Chat, transcript grouping,
composer, scrolling, decision entries and authentication behavior are preserved.

Twelve further whole option-provenance pipeline callbacks retain their exact helpers
and public entry point. Unique retention is 54 of 140 callbacks, with 86 remaining.
The focused chat, research-store and pipeline run passes 122 tests with 432 assertions.
Full workspace/E2E types and CI pass with the inherited warnings/baseline only. Whole
module, callback, controls and three-file integration source proofs pass after
formatting. Mounted hooks and browser reconnect timing remain unverified.

The original AddOption composer is restored as a private leaf. Single-card views
keep their existing Choices, Custom, Cancel, Save caption and layout; adding an
option forwards through the existing shared controller under the edit guard. The
original limit, temporary-lock, absent-handler, keyboard-attempt and suggestion
edit ownership logic is preserved. Four whole original view callbacks are retained,
bringing that suite to 12 of 27 callbacks with 15 still assigned to later surfaces.
Browser focus, keyboard and viewport behavior remain unverified.

Fourteen further whole pipeline callbacks cover research quote selection, pending
targeting, owned recommendations, ambiguity, tentative leaning and mixed source
ranges. Unique retention is 68 of 140, with 72 remaining. The focused question,
card and pipeline run passes 101 tests with 356 assertions. Full workspace/E2E
types and CI pass; only two existing reviewed component owner hashes change,
with all exception cases retained. Original leaf, callback and integration proofs
pass after formatting. Existing lint warnings and design baseline remain.

The pure evidence projection and its eight complete original callbacks are restored
byte-for-byte. It groups current supporters, opposers and targeted reasons or
constraints in card order, keeps general evidence last, and retains the original
Planner rationale/source fallback. Historical stances, neutral or unknown-option
stances and empty rationale do not manufacture visible evidence. Popover and source
highlighting integration remain subsequent work; no browser geometry was exercised.

Twelve further whole pipeline callbacks restore exact question triage, clause
isolation, causal evidence and commitment safeguards. The two missing original
commitment helpers are retained once in a natural private fixture. Unique retention
is 80 of 140 callbacks, with 60 remaining. The focused evidence/pipeline run passes
20 tests with 134 assertions. Full workspace/E2E types and CI pass with the inherited
warnings/baseline only; producer, complete callback, table and helper proofs pass
after formatting. No interpretation policy was changed.

The original terminal Reopen/Discard control leaf and four whole view callbacks
are restored. Explicit requests retain the original duplicate-request fence and
writer/connection/discard guards; metadata continues to own lifecycle transitions
and attribution. Missing terminal answers render Saved decision instead of inputs.
Current open-state layout, Cancel, error motion and Save caption are preserved.
QuestionView retention is 16 of 27 callbacks, with 11 still assigned. The original
editor presentation-list callback remains deferred whole; no ignored compatibility
prop was introduced. The inherited request helper has no new generation fence.

Fifteen further whole source/fallback registrations retain complete parameter
tables, exact UTF-16 clauses, pending qualifiers, context and D01 recovery gates.
They execute 30 cases; unique pipeline retention is 95 of 140, with 45 remaining.
The focused view/card/pipeline run passes 125 tests with 432 assertions. Full
workspace/E2E types and CI pass with inherited warnings/baseline only. Design review
adds one exact owner-hashed lifecycle footer forwarding case and updates the existing
error-class case count for its terminal use; all other cases remain. Source, callback,
table and request-helper proofs pass after formatting. Mounted browser behavior
remains unverified.

The original previous-answer projection and four whole callbacks are restored.
Reopened cards show their recorded previous labels and actor, keyed by question for
legacy multi-question cards. Durable previous choices resolve through canonical
labels with the original custom-text fallback. Metadata remains the lifecycle and
permission authority; current layout, actions and Save caption are preserved.
QuestionView retention is 19 of 27 callbacks, with eight still assigned to later
surfaces. Mounted browser behavior remains unverified.

Fourteen further whole reply/options registrations retain complete malformed and
unsafe tables, dense-state restoration, named products, candidate gates and limits.
They execute 47 cases; unique pipeline retention is 109 of 140, with 31 remaining.
The focused question/editor/pipeline run passes 475 tests with 1,262 assertions.
Full workspace/E2E types and CI pass with the inherited warnings and design baseline
only. Only two independently reviewed existing component source hashes are renewed;
all exception cases remain unchanged. Whole callback, table, helper and additive
integration proofs pass after formatting. No interpretation policy was changed.

The original single-card refining signal is restored through authoritative metadata:
an open card displays the Planner status note and its exact refining attribute.
Terminal cards and legacy multi-question cards retain their original scope. Current
heading, layout, actions and caption remain preserved. One whole original callback
brings QuestionView retention to 20 of 27, with seven still assigned to later surfaces.

Fourteen further whole recovery/card-option registrations retain complete repair,
alternative, ambiguity, ownership, grouping and refusal tables. Four original helper
and table declarations are restored once in natural private fixtures. They execute
31 cases; unique pipeline retention is 123 of 140, with 17 remaining. The focused
question/editor/pipeline run passes 460 tests with 1,258 assertions. Full workspace/E2E
types and CI pass with inherited warnings and design baseline only. Independent
review and exact callback/table/helper/integration proofs pass after formatting;
only two existing reviewed source hashes change, with every exception case retained.
No interpretation policy was changed. Mounted browser behavior remains unverified.

Open cards now forward the existing shared controller Discard command under the same
writer/connection guard as Cancel. The original Discard confirmation is restored,
with explicit cancel/discard intent so the preserved Cancel confirmation stays
separate. Current navigation, Save, caption, layout and terminal metadata authority
remain unchanged. One whole original stepper callback and two compatibility controls
bring QuestionView retention to 21 of 27, with six whole callbacks still assigned.
Native click and confirmation behavior remains unverified at this checkpoint.

Twelve further whole scoped-choice and contrastive registrations retain complete
proposal, conditional, ownership, duplicate and refusal cases. Four exact helper
functions are restored once in two natural fixtures; a missing fixture import was
corrected without changing their bodies or assertions. Unique pipeline retention is
135 of 140, with five remaining. The focused question/editor/pipeline run passes
444 tests with 1,262 assertions. Full workspace/E2E types and CI pass, with inherited
warnings/design baseline only. Independent review and complete source/callback/table
proofs pass after formatting. Only two reviewed existing owner hashes change;
exception cases are unchanged. No interpretation policy was changed.

The final five clarification and dual-role registrations and their complete original
helper are restored. All 140 original pipeline registrations are now retained exactly
once, including complete parameter tables and assertions. No interpretation policy,
confidence gate, dataset or scoring behavior was changed.

The original 58-line source-highlight leaf is restored byte-for-byte. Seven isolated
Chromium cases exercise native ranges, nested text nodes, UTF-16 emoji offsets,
raw/rendered/quote refusal, exact owner identity, replacement and cleanup, and missing
CSS Highlights support. Three native QuestionView cases exercise separate Cancel and
Discard confirmations, Keep restoration, controlled submitting, disabled controls and
read-only presentation. The ten tests bundle actual components into plain pages with
all network requests blocked. They use a standalone native-file configuration; no
application, database or existing E2E configuration is started or changed. Run them
with `bun --bun node_modules/@playwright/test/cli.js test --config e2e/source/playwright.config.ts`.
Source-navigation wiring, paint styling, product scrolling, expiry and annotation
panel geometry remain later work; these tests establish leaf/component contracts.

Full verification identified and corrected two bounded current-design mismatches:
the research-offer SearchIcon now uses the current 14-pixel size instead of the
archive's 16; the standard-button audit follows the explicit confirmation intents
and checks both Keep controls with an exact count and all original style checks.
A new audit regression rejects a wrong second control and missing or extra controls.
Independent review confirms the sole icon substitution, unchanged eight original
offer callbacks, and unchanged remaining token assertions and action definitions.

Final serial combined verification passes 2,947 tests with 13,586 assertions across
478 files, with no failures; two PostgreSQL suites skip without a database. An earlier
combined run timed out on an unchanged Pi stub contract; all nine isolated Pi tests
and the final full run pass with the original timeout and unchanged Harness code.
All ten native Chromium tests, full workspace/E2E types and CI pass. Exact pipeline,
source-leaf and bounded design-adaptation proofs pass after formatting. The two
inherited lint warnings and existing design baseline finding remain unchanged.

The original evidence popover, source helpers and all five complete rendering callbacks
are restored. Rows show current participant stances, sourced reasons/constraints and
the exact Planner rationale/quote guards. Avatar display caps at eight while naming
all participants accessibly. Source actions preserve the original source/item identity;
the popover offers no answer or decision mutation. The helper uses the current text-xs
role instead of the archive's fixed 11-pixel label. Runtime host/source-navigation and
popover geometry integration remain later work.

Actual rendering first exposed the missing shared MessageForwardIcon export; its
complete original wrapper and public export are now restored with the current LineIcon
and default 14-pixel sizing. Independent review approves one exact typed forwarding
case in the existing icon owner and renewal of only that source fingerprint; all old
cases and reasons remain. The focused evidence/icon/design run passes 70 tests with
906 assertions. Full workspace/E2E types and CI pass with inherited warnings/design
baseline only. Original component, fixture, callback and icon preservation proofs pass
after formatting, with only the declared source-label typography adaptation.

## Analysis overview and excerpt-correction components

The complete original AnalysisOverview and ExcerptCorrection functions, action type,
answer helpers and sole original rendering callback are restored across five small
files. Corrections retain linked-card eligibility, bounded unique source text, existing
subspan checks, option membership, expected thread version and stable action identity
when retrying an unchanged request. Read-only and missing-callback guards remain.

Current-style substitutions replace eighteen fixed typography classes, four handmade
field classes, one decorative check with the shared 14-pixel icon, and one separator
with the shared hairline role. Every other original declaration and callback remains
intact. Independent review approves these exact changes. Focused verification passes
63 tests with 738 assertions; workspace/E2E types and CI pass. CI retains only the
inherited lint warnings and design baseline. Formatting and fresh archive-preservation
proofs pass. Runtime transcript wiring and native form interaction remain later work;
this component slice does not establish server persistence or collaboration behavior.

## Transcript source navigation and native correction checks

Chat now forwards source destinations to the real Transcript. The original navigation
uses a per-transcript highlight owner, scrolls a found message into view, and checks
its exact saved UTF-16 quote against raw and rendered text. Changed text and Markdown
that differs from saved raw text conservatively refuse exact highlighting while
retaining the source preview. Destination replacement, clearing, inactivity and
unmount clean up only that owner's range and marker. Existing manual bottom pinning,
Markdown, streaming, decision/research controls and withdrawal behavior are preserved.
The original effect reacts to active/destination changes, not entries-only changes;
this slice makes no late-arrival or entries-only revalidation claim. Room source
production, expiry and evidence-host integration remain later work.

Independent source proof preserves the whole current Chat/Transcript AST after the
exact additive archived navigation seams. The source-preview label uses current
text-xs, and highlight decoration uses shared brand tokens without literal fallback
colors. The client build retains the highlight rule; its CSS compiler warns about the
supported functional highlight pseudo-element, and the existing chunk-size warning
remains. No design exception was added. One fixture-only emoji representation uses
a Unicode escape; its cooked bytes, offsets and all callback assertions are identical.

The isolated cached-Chromium suite now passes 19 cases: seven exact source-leaf cases,
three question lifecycle cases, four actual Transcript navigation/scroll cases and
five actual ExcerptCorrection form cases. The form covers native focus, active-card
eligibility, held submission, read-only/missing callback guards, exact payload fields,
unchanged retry identity, rejected/ambiguous source text and option-target clearing.
Its initial blank-page failure was traced to unavailable native crypto.randomUUID;
the fixture now fulfills one synthetic HTTPS document locally, aborts all other
requests and checks the native secure context. No UUID polyfill or application server
is used. All complete fixture bodies and native callbacks survive the module-binding
adaptation, and the two prior native suites remain byte-identical.

Final focused verification passes 153 tests with 1,049 assertions. Workspace/E2E types,
CI, formatting and source/fixture preservation proofs pass. CI retains only inherited
warnings and the design baseline. The actual client build succeeds. No database,
application listener, authentication session, provider request or evaluation run was
started. These native component checks do not prove durable correction transport,
Room token expiry, collaborative evidence updates or complete browser integration.

## Live evidence host and Room source lifecycle

The real Room now supplies evidence from its conversation state, linked thread and
current authoritative card metadata to PlanEditor and the existing questionnaire
widget. Only visible document-plan cards with open or reopened metadata expose the
read-only popover. The existing decided/undecided content, editing permissions and
question motion remain intact. Empty evidence, absent metadata and terminal card
states refuse the popover. Source actions open the real Chat, preserve source identity
and use the original token-fenced three-second destination expiry and room reset.

The complete original EvidenceHover and geometry helper are restored, including all
five original geometry callbacks. Native hover/focus listeners retain the 400 ms open
and 150 ms close delays, Escape focus return, stationary-pointer suppression after
Source or Escape, document-scroll dismissal and independent panel scrolling. The
portal uses shared surface, edge, radius and shadow tokens. Only two existing editor
owner fingerprints are renewed; every reviewed exception case and reason is unchanged.
Independent review and full host/component preservation proofs pass.

Nine new isolated native cases exercise actual QuestionnaireCard, EvidenceHover,
EvidencePopover and Transcript: source highlighting and saved fallback, hover/focus
lifecycle, narrow and short viewport placement, panel/document scrolling, current
participant evidence and card metadata transitions. A zero-width narrow fixture was
traced to the imported document flex geometry; an explicit width and flex:none on the
isolated fixture host corrected it without changing production layout or weakening any
original assertion; positive overlap and scrolling checks were added.

Four further native cases render the entire actual RoomWorkspace, Workspace,
PlanEditor and Chat with their actual stores and Wire. One synchronous observer and
an append-only private navigation-provider export expose the actual source handlers;
no production functions or effects are replaced. An inert native EventTarget socket
supplies locally prepared frames. The cases follow real evidence-to-Source-to-Chat
navigation, invoke a captured old expiry callback to exercise the actual token fence,
check the replacement's exact three-second deadline, reset on room identity change,
and check unmount cleanup. A test-only observer records the actual returned expiry
handle and native clearTimeout calls; unmount must cancel that exact handle before
the clock advances. All original callbacks and assertions remain. The suite provides
no authoritative document snapshot,
authentication, collaboration or database-persistence claim.

The combined isolated cached-Chromium suite passes 32 cases. Focused component,
source, icon, widget and geometry verification passes 245 tests with 1,401 assertions.
Workspace/E2E types, CI, client build and complete binding/callback/source proofs pass.
CI retains only inherited warnings and the existing design baseline. Evidence, Room
and crypto-dependent form fixtures fulfill their synthetic HTTPS documents locally;
the original source/question fixtures use isolated plain pages. All other requests
are aborted; no app,
database, auth session, provider call or evaluation run was started. Analysis host
integration, decided-prose/list evidence and full application collaboration remain
later work.

## Conversation analysis host and correction bridge

The complete original MessageMarkers closure and four shared hover declarations are
restored, with the two original Planner diagnostics functions in their natural small
module. All seven original rendering callbacks and four helpers remain byte-identical.
Only four fixed 11-pixel labels use the current text-xs role. The original behavior
retains accepted-source chips, held-excerpt review, jobs after analysis pruning,
generation-keyed prose diagnostics, shared hover ownership, pinning, browser placement,
focus/Tab/Escape handling, serialized job retries and analysis retry identity.

Current Transcript, Chat and Room receive additive original anchor, marker and callback
bindings. Four whole original Room callbacks forward correction and retry requests to
real wire.ask and resolve card links through current question state. Existing write,
archive and connection guards, composer behavior, source navigation and evidence stay
intact. Independent subtraction proofs retain each complete current host AST and the
complete archived callbacks; no server or protocol behavior was changed.

The two original analysis-hover CSS rules are restored beside the unchanged current
source highlight. Their sole style adaptation uses the existing duration-fast and
ease-out tokens: duration remains 120 ms and easing follows the current role. One
exact, counted and source-hashed geometry exception covers only the measured portal
position, size, clipping, visibility and motion origin. Every prior record is unchanged.
Independent review approves the component, host, CSS and exception boundaries.

Nine additional native cases render actual Transcript, MessageMarkers, AnalysisOverview
and ExcerptCorrection with real compiled client CSS and controlled parent callbacks.
They exercise shared hover, native focus/Tab/Escape, pinning, selected Range refusal,
composer/viewport clipping and out-of-view dismissal, read-only controls, held and
rejected corrections, version changes and stable/fresh retry IDs. These callbacks are
new focused evidence; the original full application browser callbacks remain assigned
whole and deferred, including actual auth, compact Chat Escape ordering, editor caret,
collaboration and database reopen.

The first native run exposed two fixture assumptions. Locally fulfilled HTML lacked a
doctype, putting Chromium in quirks mode where the inherited :hover guard did not
match; standards-mode HTML plus an explicit CSS1Compat guard fixes that precondition.
The append check was still at the transcript bottom, so existing auto-follow correctly
scrolled. Native manual scrolling, positive away-from-bottom and viewport checks, and
waiting for the appended message and paint now exercise the intended unpinned case.
All nine complete callbacks and original assertions survive these additive setup fixes.

Six additional offline command checks reach the real correction handler, processor,
fenced MemoryStorage and actual document close/open. Reply-time snapshots capture
cloned durable state immediately. The checks distinguish the socket actor from the
saved source author and cover commit before reply/publication, rollback on commit
failure, restored transcript/state, idempotent retry and four command-local denial
conditions. Runtime lookup, access refresh and socket delivery use fixture substitutes;
the correction handler, processor and fenced storage are real. These checks do not
establish socket admission, GitHub authorization or complete authenticated
Room-to-server transport. Existing
correction and memory contracts pass alongside them. No database, application listener,
provider call, paid inference or evaluation run was used.

Final verification passes 276 focused tests with 1,588 assertions across 37 files and
all 41 isolated cached-Chromium cases against the final rebuilt styles. Workspace/E2E
types, CI, client build, formatting and whole source/fixture/callback proofs pass. CI
retains only the inherited warnings and existing design baseline. The broader product
extraction remains unfinished; decided-prose annotations and complete application
transport/collaboration browser coverage remain later work.

## Decided-prose reader controls

The complete original decision layer, placement hook and pin owner are restored, with
natural formatter, summary/dialog and ChosenList leaves. All seven original format and
surface callbacks, three pin callbacks and two decision geometry callbacks remain
whole. The two original mark ownership tests and complete archived mark implementation
are restored. Source subtraction proofs preserve the entire current geometry suite,
editor/options/plugin bridge, question exports and Room around the declared additions.

The layer mounts beside Lexical's editable document through the existing question
plugin. Genuine prose targets and authoritative CardMeta determine marker admission.
The real Room source callback resolves the conversation thread's first question source
and uses existing token-fenced source navigation. Readers can inspect and pin decisions;
mutation requests still require a connected wire, write permission, editable Lexical
state and the current owned pin. Pending requests serialize locally, and stale replies
cannot restore chrome after new intent, another editor's claim, hide or unmount.

The full original reader CSS, narrow document lane, leading-gutter geometry and decided
prose wash are restored. The only style adaptation replaces the circular marker's
50-percent radius with the current radius-full token. Existing wide authored surfaces
and all other current CSS remain byte-identical after subtraction. Existing motion
aliases use current shared tokens. Three counted, source-hashed exceptions cover only
measured marker/panel geometry and finite transition-presence classes. Only the existing
PlanEditor wrapper fingerprint changes. The original ClockIcon and its public export
are restored with one exact SVG-prop forwarding case; prior icon declarations and
manifest records are preserved.

This slice leaves the current answered inline questionnaire intact. Collapsing that
card and confirming deletion are separate original behaviors still assigned whole;
the richer current card, Cancel wording and permission checks are preserved. The eleven
original full-application decision-prose browser callbacks remain whole and deferred,
including actual application authentication, authoritative room collaboration,
Planner work and database persistence. Focused native reader evidence does not replace
those callbacks or establish the complete Room-to-server transport.
The isolated source action checks delivery to an injected callback, while actual Room
source navigation is verified by preserved wiring. Held mutation checks use a fake
transport to exercise the real layer's request fences, not a durable server mutation.

Eight new native cases mount the unchanged DecisionLayer with real Lexical, Yjs relative
anchors, questionnaire and metadata stores, and the shared widget realm. They cover
paragraph hover and stationary-pointer Escape, marker focus/pin/return, read-only source
callback delivery, narrow measured placement, scrolling and offscreen retirement,
hidden-host wash cleanup, unmount, two-editor wash union and one global pin, and
serialized requests with stale-intent rejection. Every case checks browser and Lexical
errors. These are new focused callbacks; all eleven original application callbacks
remain assigned whole.

The initial fixture needed the separately built lazy editor stylesheet in addition to
the index stylesheet. Review also added the actual plan ancestor, so production text
measure and marker-lane CSS apply, a precise recorded-request type, per-case error
assertions and a zero-wash check during hiding. The final runner passes all 49 isolated
cached-Chromium cases, including all eight complete strengthened reader callbacks.
Only one local standards-mode secure page is fulfilled; every other request is aborted.
No application, database, auth session, provider or evaluation run is started.

Full offline verification passes 3,113 tests with 14,456 assertions across 513 files;
the two PostgreSQL checks are skipped. Workspace/E2E types, CI, client build, formatting,
whole-source/fixture/callback retention proofs and independent reader/host/CSS/metadata
reviews pass. CI retains the two inherited lint warnings and existing design baseline.
This is a reader checkpoint, not completion of the broader product extraction.

## Answered-card collapse and protected deletion

Inline answered cards now retain the original settled line until their prose is linked,
then collapse without deleting the underlying document node. Discarded cards hide;
authoritative open or reopened metadata wins over stale decided projections. Decisions
uses the actual list presentation to keep its expanded cards. Current provenance,
Cancel/Save answer controls, evidence, question steps and permission checks remain.
Thirteen whole original registrations cover twenty cases, including the original list
callback. Ten existing fixtures now explicitly select list presentation; their assertions
remain unchanged. The original discarded-actor callback at archive line 301 remains
whole and deferred: its contiguous raw HTML expectation conflicts with the current
styled actor span. A native text assertion proves actor attribution but does not replace
that original callback or claim its restoration.

The four original deletion/navigation files are byte-identical to the archive and mount
through two additive widget exports and plugin subscriptions. Decided nodes are protected
against text and node deletion; Backspace beside a hidden linked card moves into its
actual prose. Discarded navigation skips the hidden node at genuine text boundaries.
The two original navigation callbacks and their helpers remain whole. This deletion
behavior has no confirmation dialog or wire mutation. The reader's existing discard
confirmation remains separately exercised.

The original caret spacing, hidden-host, collapse and reduced-motion CSS is additive;
all prior CSS survives source subtraction. The sole motion adaptation uses the current
shared duration/easing tokens, retaining the original 200 ms duration and existing
50 ms transition cleanup grace. One counted finite-presence class exception is added;
the existing questionnaire exception changes only its source fingerprint. No other
exception cases or reasons change.

Eleven new native callbacks use the actual Lexical and Yjs binding, relative prose
anchors, questionnaire renderer, stores, metadata and deletion/navigation plugins.
They exercise hidden inline versus expanded list layout, timed inert collapse, reopened
metadata, pending/error request fences, native Backspace and arrow keys, node/range
deletion protection, read-only behavior, and discarded actor attribution. A reopened
negative control permits deletion of the same stale decided node, proving that the
guard does not simply block every deletion. Each case checks browser and Lexical errors.
The isolated fixture fulfills one standards-mode secure local page and aborts every
other request. Its controlled transport accepts only the exact known presence-release
frame separately from terminal requests. It does not establish server durability,
authentication or complete application collaboration; the eleven original application
callbacks remain whole and deferred.

Initial fixture failures exposed an incorrect list permission setup, the existing
transition cleanup grace, and the real observer's presence-release frame. Native focus
also legitimately scrolled linked prose out of view; a paint fence and real viewport
restoration fix that test precondition. Production guards, geometry and timing were
preserved. Whole-source, fixture and callback proofs pass after global formatting.

Final offline verification passes 3,135 tests with 14,539 assertions across 518 files;
the two PostgreSQL checks are skipped. The actual combined cached-Chromium runner
passes all sixty isolated cases against freshly built styles, including all eleven
new callbacks. Workspace/E2E types, CI, client build, formatting and whole-source
retention proofs pass. Independent collapse and fixture reviews find no issues.
CI retains only the two inherited lint warnings and existing design baseline.
This is another bounded product checkpoint; the broader extraction remains unfinished.

## Open-card people and conversation source

The complete original People function and durable-before-live handle merge are restored.
Faces deduplicate, cap at eight, and show overflow while the accessible group retains
all handles. The original durable-people callback at archive line 246 and shared
fixtures remain whole and unique. Five additional source/people cases cover saved-thread
and callback admission, read-only navigation controls, overflow and current resolved
list provenance. Current questionnaire and Decisions suites pass fifty tests with
159 assertions. The whole current questionnaire module is preserved by AST subtraction
of the declared additions.

InlineQuestionnaire forwards the real existing onCardSource option through the current
QuestionnaireCard and Undecided. Source requires authoritative metadata's thread and a
callback and delivers the actual card ID. The existing Room handler resolves that card's
conversation thread and first saved question source, then uses current token-fenced
source navigation. No Room, QuestionView, CSS or icon implementation changes are needed.
The only original-source adaptations are using the existing QuestionView.aside slot for
the complete Source/People subtree and the current canonical icon-button role. Current
Cancel/Save answer, provenance, metadata precedence, evidence, shared draft, motion and
permission paths survive unchanged. The Decisions list has no Source callback, matching
the archive's scope; this slice does not add one.

The original card anatomy/caption callbacks at archive lines 286, 471 and 484 remain
whole and deferred. They are not rewritten to fit the current heading and controls.
The actor callback at line 301 and eleven full-application decided-prose browser
callbacks likewise remain deferred. This slice adds no design exceptions: only the two
existing questionnaire owner fingerprints change, with all cases and reasons retained.

Four new native callbacks mount the actual InlineQuestionnaire renderer in an auxiliary
Lexical host sharing the real Room questionnaire/metadata stores and showCardSource
callback. The saved conversation and chat frames enter the existing inert Room wire;
Source clicks reach actual Chat/Transcript source highlighting. Two legitimate saved
question sources distinguish first-source ordering, and changing the card proves
current ID delivery and replacement-token behavior. Read-only controls remain absent
or disabled. Live presence joins durable people without duplicate faces, preserves all
accessible handles, reports overflow, and retires removed live peers. Missing thread
or callback removes Source. Every case checks browser and Lexical errors.

This is an auxiliary Lexical host, not the complete Room document editor or Yjs provider
transport. Its controlled bridge permits only exact known question-open reads and
presence-release frames; unexpected writes fail. It does not establish authentication,
server durability or complete network collaboration. The fixture fulfills one local
secure standards-mode page, aborts all other requests, and consumes both actual built
stylesheets. Initial fixture failures involved incomplete metadata, current read-only
control expectations, and Node-only editor import resolution. The final fixture resolves
only its appended imports through the actual packages' browser exports. Production
logic was not changed to accommodate those failures.

Final verification passes all fifty focused unit cases and all sixty-four isolated
cached-Chromium cases against the final build. Workspace/E2E types, CI, build,
formatting and whole-source/callback/fixture proofs pass. Independent production,
metadata and native reviews find no issues. CI retains only the inherited two lint
warnings and existing design baseline. The broader extraction remains unfinished;
card-gap normalization and legacy Planner-thread backfill are audited next boundaries,
with original full-application and deferred anatomy coverage still outstanding.

## Canonical card gaps

The complete original card-gap module and its headless callback are restored byte-exact.
Only consecutive empty paragraphs bounded by questionnaire or decision nodes compact,
retaining the first editable blank. Prose and outer blanks survive. A collapsed caret
protects its own run while other runs may compact; a noncollapsed range defers every
run until selection changes. The original callback and adjacent navigation suite pass
three tests with eight assertions.

The plugin mounts immediately after DiscardedNavigation through one facade export,
import and composer-child registration. It reads the original canEdit, connected and
synced gates. The existing provider's sync state now reaches WidgetOptions and the
PlanEditor plugin parameters, with the same state included in the existing memo's
dependencies. Realm updates propagate changed flags and retire the registered root
transform and selection command when a gate closes or the plugin unmounts. Current
provider, auth, reset, room and all other editor behavior survive source subtraction.
The original plugin has no separate busy guard; this slice does not add one.

No CSS, theme or new design exception is needed. Only the existing PlanEditor wrapper's
fingerprint changes; its cases and reason and all other records stay intact. Exact
archive bytes and whole-current-module proofs cover the module, callback, widget
facade/plugin, WidgetOptions and PlanEditor after the declared additions.

Seven new native cases mount the actual archived plugin with real Lexical, both card
node types, a local Yjs binding and the shared widget realm. False writer, connection
and sync flags preserve thirteen canonical blocks; enabling the gate reduces them to
ten while retaining the original card, prose and outer-blank keys. Native selection
changes release a protected caret run and a noncollapsed range. Disconnect and plugin
unmount tests first preserve a deferred run, then reseed while disabled to prove both
the old selection command and root transform are retired; reconnect/remount compacts.

The snapshots encode and apply real Yjs updates into a new document. Ordered shared
block types match Lexical, paragraph counts change from nine to six, and complete
card state/text survives both compaction and the round trip. The initial fixture used
an unavailable Yjs getter, corrected to the installed API. A stronger snapshot then
returned a raw shared Y.Map with internal document cycles, causing pathological test
runner memory use. Only that owned runner was stopped. The final snapshot uses the
actual map's canonical toJSON data and rejects unexpected state types; every structural
and payload assertion remains. No production workaround or weakened assertion was used.

These checks use an isolated local binding, controlled widget flags and inert awareness,
not the complete PlanProvider, authenticated socket, server persistence or remote
collaboration. Provider-to-PlanEditor-to-realm wiring is separately preserved and
verified by source inspection. Each case checks native and Lexical errors, consumes
both actual built stylesheets, fulfills one local secure standards-mode page, and
aborts every other request. Original full-application callbacks remain separately
assigned and deferred.

Final verification passes 3,142 offline tests with 14,571 assertions across 521 files;
two PostgreSQL checks are skipped. The complete cached-Chromium runner passes all
seventy-one isolated cases against the final rebuilt styles, including all seven
strengthened gap cases. Workspace/E2E types, CI, build, formatting and source/fixture/
callback retention proofs pass. Independent source, sync, metadata and native reviews
find no issues. CI retains only two inherited lint warnings and the existing design
baseline. Legacy Planner-thread backfill and the remaining full-application/anatomy
boundaries remain outstanding; the broader extraction is unfinished.

## Legacy Planner-card backfill

The complete archived backfill module and all six original test callbacks, fixtures,
helpers and cleanup are restored. The two original room helpers snapshot card
projections and validate unique, still-unlinked cards before adding thread attributes.
Only those helpers and their existing projection-error binding change the room module.

Eligibility remains narrow: one open Planner-origin question with no decision history,
existing thread, human/chat option provenance or conflicting visible projection.
Question text, IDs and ordered options must match exactly. Deterministic card-derived
thread IDs and source-free, zero-time events make repeated migration idempotent.
Collisions and conversation limits skip unsafe candidates. The real fenced staged
commit precedes live document, record and conversation publication and suppresses
unnecessary derived-document notifications. No Planner jobs or effects are enqueued.

First-open integration runs only when the conversation prototype is enabled and the
channel is not archived. Channel lookup and backfill belong to preparation before room
exposure. Closing intent is checked before preparation, after awaited lookup before
migration and immediately before synchronous exposure. Existing document locking,
opening singleflight, deletion admission and asynchronous runtime attachment remain
unchanged. Detached Service.open calls, including observational research reads, do not
perform this migration. The original generic publication helper is preserved whole;
its other archived opening/join helpers and original tests remain separately deferred.

A successfully restored document that preparation never exposed now has a narrow
abortOpening cleanup path. It stops timers, marks closing, drains chat and pending
flushes and always disposes question, presence and Yjs resources, without another
commit or checkpoint. Ordinary Service.open and Service.close bodies remain unchanged.
A preparation error remains the rejection; a cleanup error is included only if both
fail. This resource-only path is for privately owned opening objects, not normal
published-document shutdown.

An additional real Memory-backed test exercises the existing implementation-claim
flag guard, then closes, reopens and retries the unlinked card. It does not construct
an approved implementation run or establish that lifecycle. Producer-level locking
has no general post-close admission guard; migration safety here depends on the
first-open ownership boundary. A commit already admitted when closing begins may
settle durably. Closing prevents subsequent room exposure rather than rolling back
that admitted commit.

Seven additional Memory lifecycle cases use real restoration, fenced backfill commits,
channel lookup and cleanup. They hold a commit to prove shared opening consumers and
attachment see only committed state; hold lookup to prevent migration admission after
close intent; and restore storage after both one-shot and persistent faults to retry.
Persistent failure disposes questions, presence, chat and the Yjs document with exactly
one failed migration commit and no cleanup commit. One- and two-hop microtask cases
expose the original guard-to-publication gap; the real old wrapper failed the ordering
assertion, and synchronous final guard/exposure passes. Publication that already
preceded close intent is allowed to finish and uses ordinary queued close.

The fixtures share opening promises and simulate queued close plus attachment callbacks.
They do not import or start main, execute its socket admission, authenticate a browser
or prove PostgreSQL behavior. The actual main guard order and retained lock/singleflight/
async attachment are covered separately by whole-source inspection and AST subtraction.
Original source and test retention proofs compare fresh Git objects; all seven new
callbacks and their fixture also survive formatting as complete programs.

Final verification passes 3,156 offline tests with 14,730 assertions across 524 files;
two PostgreSQL checks are skipped. The focused migration/lifecycle suite passes fourteen
cases with 159 assertions. Workspace/E2E types, CI, formatting and source/callback
retention proofs pass. Independent reviews approve the bounded implementation. CI
retains only the two inherited lint warnings and existing design baseline. This server
slice changes no browser code or styles; the prior seventy-one isolated native cases
are not rerun. Original opening/join, full-application and deferred anatomy boundaries
remain outstanding, and the broader extraction remains unfinished.

## Conversation opening and joined snapshots

The three remaining archived opening helpers and the complete original opening test
module are restored. Four whole callback registrations retain all five runtime cases,
including the delayed/failing commit table and every fixture, assertion and cleanup.
Current publishOpenedPlan and preparation/abort behavior survive unchanged.

Joining now reads the document, questions, comments, transcript and conversation/jobs
snapshot under the actual document mutation lock. A live room, plan, member and socket
predicate runs inside that lock, refusing stale joins before sending any snapshot.
Read-only and archived members can still read. Sending waits for the complete shared
opening promise, including current asynchronous runtime attachment, then rechecks
existing authorization and write access and refuses stale, closed, archiving or
closing targets. Missing or failed opening returns an explicit failure. The existing
receive authorization preamble and Chat.send implementation remain unchanged.

Archive recovery now waits outside the document lock and rechecks live identity after
channel lookup. The complete original recoverOpenedPlan helper waits only while a plan
is absent; current main publishes before its asynchronous attachment finishes. A
narrow recoverAttachedPlan wrapper therefore settles any shared opening first, also
when the plan is already published, before invoking original recovery. It catches
only opening rejection so that recovery can retain a useful published plan without
replacing the archive outcome. Current Harness, runtime attachment, owner credentials,
backfill, cleanup, archive mutation and storage behavior remain unchanged.

Four additional Memory cases exercise actual helpers, Chat, runtime and storage.
A queued greeting sends no frames after its target is retired. Actual replacement
attachment is held on an old processor's idle drain at the injected interpreter
boundary; both sending and recovery wait for that drain. Sending then uses the real
runtime binding and commits transcript and pending queue identity. Recovery performs
no additional attachment while opening is held. Rejected opening tolerates a useful
published plan, no plan and no room. Injected inference never calls a model provider.

These tests supply room/opening promises and callbacks, not main's real socket,
authentication or archive route. Caller await order, access checks and live predicates
are separately source-reviewed and covered by whole-current-module AST subtraction.
Original declarations and complete tests are compared with fresh Git objects; all
four new callbacks survive formatting as complete programs. No browser code or styles
change, so prior isolated native cases are not rerun. Browser projection protection
and original full-application/deferred anatomy coverage remain outstanding; the
broader extraction is unfinished.

Final verification passes 3,165 offline tests with 14,778 assertions across 526 files;
two PostgreSQL checks are skipped. The complete focused opening/backfill/cleanup suite
passes twenty-three cases with 207 assertions. Workspace/E2E types, CI, formatting,
whole-source and whole-callback proofs pass, with independent production and test
reviews approved. CI retains only two inherited lint warnings and the existing design
baseline. No live application, PostgreSQL, authentication or provider run is claimed.

## Browser projection preservation and research authority

The complete original projection module and room Applied/apply boundary are restored.
Browser updates compare serialized Questionnaire, Decision and Research snapshots
before and after applying the batch. Existing components may move unchanged, while
creation, removal or alteration is refused. Missing or duplicate protected identities
fail closed. Research additions and removals have explicit request/job authority
exceptions; accepted changes travel into the fenced storage commit for revalidation.
This compares document snapshots. It does not reconstruct Questionnaire or Decision
components from authoritative sidecar records, so that separate cross-check gap remains.

Service restores the complete original commit, commitHosted, rejection-reset and two
prose-metadata helper declarations. A late ResearchProjectionConflict restores the
previous revision, question records and comment threads, then uses the same durable
fresh-epoch reset as an invalid batch. No acknowledgement or update relay precedes
the commit. Prose orphan metadata publishes after the reset commits and broadcasts.
Current lease failure, archive, checkpoint, metadata, MCP and implementation behavior
survives whole-module subtraction. The existing staged-publication notification flag
is preserved with one empty research-change argument; server-authored mutations keep
their current path.

Nine whole original registrations retain eighteen runtime cases and their complete
terminal-state, projection-kind and remove/alter tables. Twelve fixture helpers are
restored in small leaves; two existing extracted helpers are reused. Real question
edit/submission, accepted comment decisions, Yjs batches, Memory commits and close/
reopen behavior are exercised without a strict-restore or fixture adaptation. The
initial unchanged tests reproduced thirteen failures. All eighteen now pass, including
a job failing after validation but before commit, active-request removal refusal,
terminal removal, combined prose/projection rejection and unchanged component moves.

An existing durable-before-ack test used a browser-created Decision, now correctly
forbidden. Its complete archived ordinary-prose callback is restored once, including
all existing acknowledgement, stored-update, revision and derived-notification
assertions. No guard or assertion is weakened. Twelve additional parser-backed cases
check nested/malformed identities, kind/payload changes, movement and exact authorized
Research IDs. They supplement the real submission cases rather than replacing them.

Whole-current room, Service and persistence-test proofs permit only the declared
boundary changes, imports and callback replacement. Complete original helpers,
callbacks and enclosing loop tables are compared against fresh Git sources. These
checks use Memory storage, synthetic sockets and actual Yjs/Service.submit; they do
not establish real browser, socket authorization or PostgreSQL execution. No client
or styles change, and prior isolated native cases are not rerun. Original application
coverage, scripted Harness adaptation and deferred anatomy remain outstanding;
the broader extraction is unfinished.

Final verification passes 3,195 offline tests with 14,912 assertions across 531 files;
two PostgreSQL checks are skipped. The combined focused persistence/room/original/
pure suite passes forty-nine cases with 181 assertions. Workspace/E2E types, CI,
formatting and all source/helper/callback/fixture proofs pass. Independent production
and test reviews approve the bounded implementation. CI retains only two inherited
lint warnings and the existing design baseline. No PostgreSQL, live application,
browser authentication or provider execution is claimed.

## Preserved scripted interpreter tests

The complete original test-only scripted runner is restored with a local structural
Tool descriptor replacing its Copilot SDK type import. All nine declarations retain
their complete bodies, including script bounds, substitution, holds, abort checks and
identity-owned cleanup. No startup switch, production tool export, profile or Harness
behavior changes.

All four original test callbacks, their fixtures and cleanup are preserved. Only the
Chat namespace import redirects to a test bridge. That bridge invokes the actual
current document and heading tools through scopedJobTools and Chat.documentRoom,
including real Service locking, publication and persistence. The original script
refuses ordinary writing and then drafts the heading. Other cases retain missing and
malformed scripts, a held abort and preservation of replacement job/turn/output state.
The unchanged tests first failed because the runner module was absent, then passed
all four cases with sixteen assertions.

This is legacy interpreter and current lower-tool guard evidence. The first original
script cannot retain its success outcome through the current heading Harness stream:
an inactive edit_plan call aborts that stream before a later heading call. These tests
do not change or verify that stream policy, session authentication, deployed storage
or browser behavior. A separate current Harness script driver remains outstanding,
alongside deferred application and anatomy coverage; the broader extraction is
unfinished.

Final verification passes 3,199 offline tests with 14,928 assertions across 532 files;
two PostgreSQL checks are skipped. Workspace/E2E types, CI, formatting and fresh
whole-module runner/test preservation proofs pass. Independent review approves the
bridge and unchanged production boundary. CI retains only two inherited lint warnings
and the existing design baseline. No application, PostgreSQL, browser authentication
or provider run is claimed.

## Scripted current Harness integration

A separate test-only HarnessV1 driver now supplies scripted model calls to actual
Chat.job, openPlannerSession, current static heading tools and the SDK dispatcher.
The driver captures a concrete fixture document and current job/turn identities;
it never invokes tool handlers or writes Chat ownership fields. Session ownership
uses real Memory Sessions and ActiveOwnerBindings with injected repository access.
No application startup switch, production profile, runtime or configuration changes.

The eight complete archived parser/substitution/hold declarations move once into a
shared private test helper. The legacy runner's entire function body and all four
original callbacks remain unchanged. A bounded throwing readScript loader serves
the new driver. Ten helper cases cover exact call shape, sixteen-call limit, original
string-length size semantics, malformed/missing files, depth, release and abort.
Fresh group reconstruction checks both archive and prior checkpoint source.

Current integration cases verify a heading's durable source at SDK result submission
and after close/reopen, inactive edit_plan refusal with no heading result or document
update, held-script cancellation and an abort during a held result observer. The
script can attempt another model-side call before Chat consumes the refusal. Tests
retain that adversarial sequence and check actual failed outcome, denied execution,
unchanged stored/live source and absent publication. The driver does not filter
calls, insert pacing or stop on denied results to manufacture the boundary outcome.
These are direct Chat.job cases, not processor/coordinator or application tests.

The SDK requires an internal working-directory setup request when opening a session.
The fake sandbox simulates only its exact mkdir command, exact single WORK_DIR
binding and directory derived from the registered session identity. It records one
setup request and rejects any other command. Nothing executes on the host. Offered
tool names match the current heading profile; the unused earlier fake never starts.
Session, sandbox and credential cleanup are checked exactly once.

The driver retains script-worker and result-observer promises through shutdown,
shares repeated destruction and wakes held scripts through local cancellation.
The modern SDK already waits for a held observer, so its integration case alone is
not evidence for the driver drain fix. A separate direct Harness contract regression
checks that boundary against a reconstructed earlier driver. The earlier variant
finishes while its observer is held; the fixed contract waits for release. A second
contract case stops an actual hold without aborting the caller signal. Replacing only
local hold cancellation with the caller signal reproduces failure; the fixed driver
drains and preserves the supplied job/turn identities. Direct contract cases do not
execute the SDK or authenticate a session. Both always await destruction in cleanup.

Final verification passes 3,215 offline tests with 15,024 assertions across 535 files;
two PostgreSQL checks are skipped. The focused legacy/helper/current-Harness/direct-
contract suite passes twenty cases with 112 assertions. Workspace/E2E types, CI,
formatting, fresh archive/checkpoint group reconstruction, legacy callback and frozen
new-module proofs pass. The group proof accounts for the formatter's exact import
specifier order at the declared relocation seam. Independent reviews approve the
implementation and additionally verify observer-error propagation and direct held
stop behavior. CI retains only two inherited lint warnings and the existing design
baseline. No real authentication, application, PostgreSQL or provider run is claimed.
Application/browser harness activation, other scripted profile coverage and deferred
anatomy remain outstanding; the broader extraction is unfinished.

## Discarded summaries and suggestion attribution

A remaining product audit found two semantic gaps within the preserved current
card layout. The editor mapped authoritative discarded metadata to the view's
cancelled status, producing contradictory Discarded/Cancelled copy. QuestionView
also projected a conversation suggestion into its selected row without showing
where that suggestion came from.

QuestionView now has a local discarded presentation state. The actual editor
producer changes only that status branch. Its terminal summary names the definition's
questions and resolver; absent/system resolvers simply show Discarded, without
claiming the question was never answered. Genuine cancellation retains its complete
existing helper and copy. Both terminal paths omit answer controls and resolved
actions. Wire, record and document lifecycle states do not change.

The existing option row displays from chat only for the current projected suggestion.
It uses the same text role and muted color as the current design. Raw suggestions,
invalid options, multi-question/multiple-choice cards, human choices and custom
answers do not acquire that attribution. Projection remains read-only; a human
edit hides the label until the existing suggestion lifecycle is cleared.

New SSR cases reproduced both gaps before implementation. They exercise the actual
QuestionView and metadata-driven QuestionnaireCard, including resolver precedence,
question identity, terminal action suppression and unchanged draft objects. Three
isolated native cases use the actual components and compiled production styles,
real input events and suggestion lifecycle, plus a discarded/cancelled gallery.
The page is a synthetic secure standards-mode fixture; all other requests are
aborted. Cancellation uses its real QuestionView contract, not a fabricated dialect
card status. These checks do not establish application, socket or storage execution.

Fresh whole-current-module proofs allow only the local view discriminator, discarded
helper/branch, private choice label/parameter and projected pass-through; the editor
proof permits exactly one status string branch. Existing hooks, controls, classes,
metadata authority, presence and mutation behavior remain unchanged. The six original
view callbacks, contiguous actor-HTML expectation and full application callbacks
remain whole and deferred where their old status, labels or anatomy conflict with
current semantics. These new cases do not replace or claim retention of those units.

Formatting initially removed the origin label's leading space. An explicit string
expression now preserves the separator; additive SSR and native accessible-name
assertions reject the glued label. A reconstructed stripped-separator variant fails
the strengthened SSR case. The seven existing dynamic design findings were reviewed
against their unchanged finite producers; only three owner fingerprints were renewed.
All 221 exception occurrences, reasons and counts remain unchanged.

Final verification passes 3,225 offline tests with 15,089 assertions across 537 files;
two PostgreSQL checks are skipped. The ten focused SSR cases pass with 61 assertions.
All 74 isolated native cases pass against the freshly built client, including three
new terminal/origin cases; the final gallery was visually inspected. Workspace/E2E
types, CI, formatting, fresh whole-module and complete new-test proofs, and the exact
design-renewal proof pass. CI retains two inherited lint warnings and its existing
design baseline. No application server, PostgreSQL, authentication or paid provider
run is claimed. Deferred original callbacks and application Harness activation remain
outstanding; this is one product correction within the unfinished extraction.

## Definition-only browser harness helpers

Four absent test-only modules are restored byte-for-byte from the preserved archive:
`e2e/jev-control.ts`, `planner-jobs.ts`, `jev-wire.ts` and `jev-process.ts`. Their
216 lines retain twelve whole functions, nineteen nested callbacks, all types,
constants and imports. A fresh archive byte/whole-module syntax-tree proof and
independent import/discovery review pass. No existing test or runtime module changes.

These modules register no browser test cases. File latches, WebSockets, process
launches, readiness fetches and timers occur only inside uninvoked functions. The
restart declaration still selects `AGENT=off` and names the separately deferred Jev
HTTP preload; it does not establish current-Harness job coverage. The preload is
not restored or imported in this slice. Test discovery and server configuration
remain unchanged. Static preservation and type compatibility do not establish
application, authentication, sockets, PostgreSQL, browser or restart execution.
The original whole browser callbacks and current-Harness activation remain deferred.

## Scripted refine failure and explicit durable retry

One new bounded SDK/Memory case exercises the durable recovery underlying the
original failed-job browser callback. Its file-backed model script submits a
schema-valid wrong-target `refine_decision` through the actual current refine
profile, SDK, scoped tool, Chat job and Planner coordinator. The actual tool returns
its different-decision error; without a successful own-tool output, current Chat
stores its separate ended-without-calling failure reason. The full card record,
source and revisions remain unchanged. No activity or public tool transcript leaks.

After real close/reopen, a rebuilt coordinator stays idle when woken. Rewriting
only the script target and invoking actual `jobs.retry` preserves the job identity
and trigger, completes attempt two, and durably retitles the card and adds its exact
option/rationale. Tool-result observations load actual storage; synchronous frame
observations capture the snapshot read after the awaited real fenced commit. Job,
card metadata, definition and activity publications are checked against those
snapshots. Title and option edits have separate durable commits; this test does not
claim atomicity of the entire refinement. A second reopen stays idle and refuses
retry of the completed job. Executed sessions release their sandbox/credential and
drain their driver exactly once; idle recovery starts no session.

The baseline includes actual initial close/reopen so canonical derived anchors are
compared rather than dropped. Recovery retains the same process-local Sessions and
rebuilds actual ActiveOwnerBindings around the reopened document. It is document
recovery, not process restart or credential restoration. Stored observation reads
keep raw running jobs; restart normalization is not used as their snapshot value.
The fake sandbox accepts only the exact SDK work-directory setup, executing nothing
on the host. Existing driver, parser, legacy tests, coordinator, profiles, session
and production modules remain unchanged.

This adds one new whole test callback, not the original whole browser callback.
Geometry, collaborator synchronization, reload/session admission, wire retry
authorization, PostgreSQL and paid provider behavior remain unverified here. The
original five job and eleven prose browser callbacks remain deferred; the existing
missing-script skipped/current-stream-failed conflict remains explicit.

Final verification passes 3,226 offline tests with 15,175 assertions across 538
files; two PostgreSQL checks are skipped. The focused current-Harness/card/retry
suite passes eight cases with 199 assertions; independent final retry verification
passes its one case with 86 assertions. The test explicitly requires both actual
changed-definition publications and compares the final complete definition, closing
the review's conditional-observation gap without removing prior assertions.

Fresh archive byte/full-module proofs retain all four E2E helpers exactly. Complete
frozen new-test/fixture proofs and fresh baseline checks retain sixteen existing
production/harness/auth/parser/coordinator dependencies byte-for-byte. Independent
source-only and SDK/Memory reviews approve the bounded work. Workspace/E2E types,
formatting and CI pass; the two inherited lint warnings, 221 reviewed design
exceptions and existing design baseline remain unchanged. No UI source changed,
so client build and isolated browser checks from the preceding checkpoint are not
rerun or presented as new evidence. The restored E2E helpers remain uninvoked; no
application, PostgreSQL or provider was activated. The original whole browser suites, HTTP preload and dedicated
current-Harness application adapter remain outstanding; extraction is unfinished.

## Preserved Jev HTTP preload source

The separately assigned `e2e/jev.ts` preload is restored as its complete natural
371-line archive module. Fresh archive byte/full-module proofs retain both types,
all 38 scenario entries, five whole functions, network/failure state, the entire
request fixture and final fetch assignment. No classifier policy or scenario data
is changed, and no reserved evaluation dataset is read or imported.

This is source retention only. The module is saved and parsed, never imported,
executed or preloaded in this slice; its fetch override is not installed. The exact
original TypeSafe URL, method, test-credential boundary, isolated-target checks,
failure and file-release behavior are preserved. Off-domain delegation remains
original source behavior, not evidence of any request. No server configuration or
browser discovery changes. Static source/type checks do not establish HTTP fixture
execution, application, authentication, sockets, PostgreSQL or browser behavior.
The original whole browser callbacks and current-Harness activation remain deferred.

## Prompt-only scripted Planner model adapter

The missing application-harness seam now has an unregistered test-only factory and
a small strict context leaf. Unlike the earlier Memory driver, this factory receives
only its script directory and a void result observer. It derives the job kind and
card target from the exact current background-job prompt; malformed or ambiguous
headers/targets fail before a tool call. String prompts and the actual SDK user-text
message shape are supported. No Plan, Chat, host registry or direct executor supplies
model context. Current production profiles and host authorization remain authoritative.

Before each unchanged original script operation, the fake model emits an actual
`read_plan`, waits for its tool result, validates the returned JSON revision as a
safe nonnegative integer, then applies the preserved substitution helper. This is
an explicit model-fixture seam: at most sixteen added reads accompany the unchanged
sixteen-call script bound, including reads before original read-only calls. Empty
scripts add none. Original operations are not rewritten, deduplicated or filtered
against offered names. Failed or malformed reads block their dependent call. The
original script parser, hold gate and captured-Plan driver remain unchanged.

The factory cancels holds locally and retains admitted model workers and result
observers until stop/destruction/factory shutdown drain. Repeated destruction is
shared and late sessions are rejected after shutdown. Direct contracts cover all
four prompt kinds, invalid context/read revisions, sequential returned revisions,
unaltered foreign tool emission, empty scripts, local stop, held-observer drain and
observer-error propagation. These contracts manually exchange model-side results;
they do not establish SDK execution or tool authority.

Two actual SDK/Memory cases use generated current prompts and static heading/refine
profiles. Heading reads its actual revision before one durable own-tool write. Refine
reads before retitling, then reads the genuinely increased revision before adding
its stable-ID option and exact Planner rationale. Result observations load fenced
stored source and complete records; actual close/reopen preserves them. Initial
canonical restoration retains derived anchors in complete equality checks. External
Plan-reading result observers assert storage only and supply no model decisions.
SDK sessions, sandbox and credential disposal are counted exactly once, and tools
or deltas do not leak into public chat. The sandbox simulates only the exact SDK
work-directory setup; nothing executes on the host.

Suggest/prose grammar contracts do not establish their actual SDK execution through
this new factory. Existing profile evidence from prior drivers remains distinct.
The factory is never registered, the restored HTTP preload is never imported, and
no application or E2E project is activated. Whole original browser callbacks,
dedicated preload/configuration, authentication/socket/PG integration and the known
missing-script skipped/current-failed conflict remain outstanding. This advances
necessary harness prerequisites without substituting narrow tests for those suites.

Final verification passes 3,258 offline tests with 15,344 assertions across 540
files; two PostgreSQL checks are skipped. Independent focused execution passes
thirty direct model contracts with 109 assertions plus two actual SDK/Memory
heading/refine cases with sixty assertions, for 32 cases and 169 assertions. The
original missing-module checks failed before the factory existed; these do not
claim a deployed application regression fix.

Fresh archive byte/full-module preload proof, complete frozen factory/context/test
and integration-module proofs pass after formatting. Twenty existing host, profile,
parser, legacy/current driver, main/config and preload dependencies remain byte-exact
to the preceding checkpoint. Independent source/data-flow/lifecycle review approves
the bounded work. Workspace/E2E types, formatting and CI pass with two inherited
lint warnings, 221 unchanged reviewed design exceptions and the existing design
baseline. No UI source changes, application, preload registration, PostgreSQL,
network or paid provider activation occurs. Suggest/prose current-factory execution
and original whole application browser suites remain outstanding; extraction is
unfinished.

## Current prompt-only suggest and prose execution

The remaining two background profiles now execute through the unregistered prompt-only
model factory, actual generated prompts, current static profiles, SDK sessions and
scoped tools. A shared test fixture observes actual Memory commits without supplying
model decisions. The suggest case first attempts a forbidden title change and verifies
its complete durable record, source, document revision and live draft revision stay
unchanged. A fresh real read then supplies the revision for one valid sourced option;
the exact saved-message quote, rationale and Planner origin persist and survive reopen.

The prose case starts from an actual answered Questionnaire projection and complete
record with one prior decision. Current helpers derive generation two and its immutable
trigger. A wrong-target call preserves the full record, source and revision; after
another actual read, the scoped tool inserts exactly one paragraph with a unique live
anchor. Complete choices, history and anchors survive document close/reopen. Result-time
observations establish stored source and records before successful tool results return.

These are direct Chat.job cases: the first own-tool refusal and subsequent successful
call share one turn. They do not establish durable coordinator failure/retry, job or
activity publication. Canonical restored anchors are persisted before baseline equality
checks; no optional record field is dropped to conceal restoration behavior. Both cases
count one session, SDK setup, sandbox disposal and credential release, with no public
chat tool or delta leakage. Only the exact SDK directory setup is simulated; no host
command executes. Current producers, profiles, parser, factory, configuration and
preloads remain unchanged. Browser, deployed authentication, PostgreSQL and provider
behavior are not exercised. Whole original application callbacks remain deferred,
including the known missing-script outcome and current UI caption conflicts. Extraction
is unfinished.

Final verification passes 3,260 offline tests with 15,438 assertions across 542
files; two PostgreSQL checks are skipped. Independent focused verification passes
34 cases with 263 assertions, combining thirty direct model contracts and all four
actual SDK/Memory profiles. Complete frozen-module/callback proofs pass after formatting;
existing production and harness dependencies remain byte-identical. Workspace/E2E
types and CI pass with the same two inherited lint warnings and design baseline.
No UI source changed, so no client build or browser check is repeated or claimed.
The factory remains unregistered and no application, preload, database, network or
paid provider is activated.

## Preserved whole jobs and prose browser suites

The original conversation-plan jobs and decision-prose modules are retained as whole
archive source, including all sixteen complete test callbacks, four cleanup hooks
and twenty-one helpers. Their assertions and selectors are unchanged. Normal browser
discovery excludes these two exact root paths; this slice adds no project, server,
preload registration or test command. Static source and type checks do not import
the suites or establish browser execution.

The retained jobs suite still expects a missing script to be skipped where the current
Harness reports failure, and one callback requires the old refining shimmer. The
prose suite still requires the exact Save caption where the current approved UI says
Save answer; other old card anatomy may also differ. These complete callbacks remain
assigned for later execution and conflict resolution. No assertion, current profile,
producer behavior or UI caption is changed to hide these differences. Dedicated
current-Harness application activation, real browser/authentication/socket/storage
integration and the remaining original suites are outstanding. Extraction remains
unfinished.

Fresh byte and whole-AST archive proofs preserve both complete modules after
formatting. A static proof uses the installed Playwright matcher and literal-only
configuration analysis: all existing selections across four projects are unchanged,
and both retained root paths are excluded. Chromium overrides the global ignore,
so the two exact paths are added to its existing ignore list. Negative controls
detect both accidental selection under the old configuration and ineffective global-only
exclusion. No configuration, suite or preload is loaded by this proof.

Workspace/E2E types, formatting and CI pass. Existing runtime source and offline unit
tests are unchanged; the preceding checkpoint's 3,260 passing tests and 15,438 assertions
are retained evidence, not a new browser result. No application, database, browser,
network or paid provider is started.

## Dedicated current-Harness application setup source

A separately selected conversation-plan Playwright configuration and scripted Planner
preload now supply the missing application setup source. The ordinary runner, default
configuration, original suites, production Harness map, authentication, profiles and
startup remain unchanged. No package command activates this configuration. Its exact
test matches contain only the two preserved jobs and prose modules, serialized under
one project with no retries or existing-server reuse.

The configuration rejects missing explicit selection, database and session inputs before
validating its assembled server environment, checking the built client, or resetting
the two existing fixture directories. It composes GitHub, preserved Jev HTTP and dedicated
scripted preloads before unchanged startup. Settings explicitly select the current
scripted Harness and conversation processing on loopback, fixed test Jev credentials,
known root-relative fixture directories and disabled unrelated background/research work.

A shared pure guard validates exact selection, host/origin/port, Harness/direct auth,
Jev test credentials, fixture paths, PostgreSQL storage, local database URL and the
actual authentication key shape. Database host, hostaddr and service query overrides
are refused. Errors name configuration variables without exposing supplied values.
Offline tests use fake environment objects and never mutate process environment.

The dedicated preload runs that guard before dynamically importing the real Harness
map, prompt-only factory and existing fake MCP module, then registering the factory,
starting its future listener and installing its fetch wrapper. The validated script
directory is captured before awaited imports; later environment mutations cannot
redirect factory creation. The wrapper forwards only the exact GitHub MCP endpoint
to the existing fake server and preserves request/init method, headers, body and abort
signal behavior. Unknown URLs delegate to the captured previous wrappers. Existing
factory shutdown/drain remains authoritative; fake MCP has process lifetime, so later
execution still requires process supervision and owned port checks.

These modules are saved and typechecked without being imported or activated. Pure
guard tests and static ordering proofs establish their respective offline boundaries,
not application startup, real authorization or HTTP behavior. Explicit flags and local
URLs do not prove database disposability, built-client freshness, free ports, network
containment or an owned writer lease. Even listing the dedicated tests would load its
configuration and reset fixtures, so no listing is performed. No database is provisioned
or migrated. The original missing-script, refining shimmer, Save caption and possible
card-selector conflicts remain unchanged and unexecuted. Whole application verification
and the remaining extraction requirements are still outstanding.

Final verification passes 3,296 offline tests with 15,518 assertions across 543
files, including 36 pure environment cases with eighty assertions; two PostgreSQL
checks are skipped. Types, formatting and CI pass with the unchanged two inherited
lint warnings, 221 reviewed design exceptions and existing design baseline. No UI
source changed, so no client build or browser check is repeated or claimed.

Independent static review approves the setup. Guard-before-effects and capture-before-await
proofs pass; deliberate reset-before-gate and listener-before-guard negative controls
are rejected. Fresh Git blob checks preserve all 1,443 preceding tracked files except
this explicitly updated document, including production, ordinary discovery/runner,
profiles, original browser callbacks and existing preloads. Saved-module proofs pass
after formatting. The dedicated configuration and preload remain unimported; no
application, listener, database, browser, network or provider is activated. Extraction
is unfinished.

## Dedicated server fetch fence

The selected application command now puts a guarded fetch preload before the preserved
GitHub/Jev wrappers and exact MCP preload. Its injected, test-only factory delegates
only HTTP requests to the two fixed loopback application/MCP origins and rejects
credentials, remote destinations, other protocols, wrong ports and malformed inputs.
Unknown provider-wrapper fallbacks therefore reach a rejecting boundary instead of
unrestricted native fetch. No ordinary runner or production module changes.

Review reproduced two real defects in the initial fixture: spreading request options
lost inherited native fields, and getters could mutate a URL after validation. The
final implementation normalizes the original options through native Request construction,
forces redirect-error behavior, validates the immutable final target, and delegates
only that Request. Standard method, headers, body and propagated abort behavior are
retained, including inherited options. Native proxy/unix/tls transport extensions are
deliberately excluded. Preconnect snapshots supported option values before final
validation and forwards a canonical URL string. It has the same destination guard.
Errors remain generic without supplied URLs or secrets. All transport calls in the
contracts are injected spies; no socket or real HTTP request is made.

Local Bun type documentation also exposed ambient proxy defaults. The dedicated
child environment explicitly clears the six uppercase/lowercase transport proxy
variables and sets both NO_PROXY variants to universal bypass. The shared guard
requires those exact values before any caller effects. All preceding guard statements
and tests are retained; new missing, set, whitespace, partial-bypass and secret-safe
proxy cases exercise the actual refusal boundary. No process environment is mutated
by tests.

This is a fetch/preconnect fixture boundary with configured proxy policy, not proof
of total process, DNS, socket, PostgreSQL or browser network containment. The guarded
preload and configuration remain unimported and inactive. Actual application startup,
HTTP/authentication/MCP behavior, owned ports/database/writer lease, built-client
freshness and browser containment still require separate evidence. Whole original
browser assertions remain unchanged, including their known compatibility conflicts.

A read-only next-suite audit inventories all seventeen whole runtime/prompt callbacks
and eleven helpers. They remain absent and unselected in this slice. It identifies
the separate 8789 process-restart helper as an additional execution boundary: that
helper uses agent-off interpretation and different database/background settings,
so blindly adding the exact 8788 scripted-server guard would reject it. The original
runtime Save caption conflict also remains. No callbacks are trimmed, skipped or
rewritten to conceal these requirements. Extraction is unfinished.

Final offline verification passes 3,333 tests with 15,720 assertions across 544
files; two PostgreSQL checks are skipped. Independent focused execution passes
73 guard/network contracts with 282 assertions, including ten native Request/spied
transport cases and all sixty-three environment cases. Actual failing regressions
precede the getter/inherited-option/transport/proxy fixes. Full types pass after
one test-only preconnect option annotation is corrected; a scoped proof retains
the complete runtime callback/assertion AST and the unchanged factory/preload hashes.
The ten network contracts are rerun and pass after that correction.

Formatting and CI pass with the same two inherited lint warnings, 221 reviewed
design exceptions and design baseline. Independent source proofs reject deliberately
wrong preload order and ungated installation; whole configuration/guard/test comparison
permits only the declared command prefix, eight proxy fields and appended proxy cases.
All other preceding tracked blobs remain exact. Original suites, production, provider
fakes, profiles and ordinary runner/discovery remain unchanged. No UI source changes,
client build or browser rerun is claimed. The dedicated setup remains inactive; its
configuration/preloads and original suites are never loaded or executed.

## Whole runtime and prompt browser source

The archived runtime and prompt suites are now restored byte-for-byte: 407 and
493 lines, respectively, with all seventeen complete test callbacks and eleven
helpers. Fresh archive comparisons cover complete bytes, nested callback bodies,
imports and helper declarations. Current direct dependency exports and static
E2E types pass. The scoped sources, authenticated ownership, exact quotes, UTF-16
spans, corrections, agreement, reload, focus, Save, Reopen and Discard assertions
remain intact.

Two exact Chromium discovery exclusions keep these suites inactive. The other
three projects already select only their explicit suites; the dedicated scripted
configuration still selects only jobs and decision prose. No configuration,
preload or restored suite is imported, listed or executed. The original runtime
Save caption conflict and its separate 8789 process-restart boundary remain
unresolved. Source retention and static compatibility do not establish passing
browser behavior or restart containment. Whole application verification and the
remaining product extraction are still outstanding.

Fresh full workspace types and CI pass after formatting. CI reports three existing
lint warnings, no errors, the same 221 reviewed design exceptions and existing
design baseline. The preceding 3,333-test offline result is retained evidence;
unit tests are not rerun for these inactive source modules and two discovery
exclusions. No production, unit-test or UI implementation changes in this slice.

## Workspace opening, ready links and research detection

A fresh implementation audit found three missing UI connections. Decisions now
selects the first authoritative open/reopened card rather than the first unanswered
projection. Settled metadata excludes stale unanswered definitions; reopened metadata
includes previous answers until projection catches up. The new pure selector uses
the archived predicate and is called by the actual workspace. Six focused assertions
failed against the old selection before the fix. Current callbacks remain intact.

The workspace also now uses the existing documentHasPlanningContent helper. A
conversation-linked inline-card-only document stays in Document; Planner-only
questions retain their forced Decisions opening. The actual host in the existing
isolated native fixture reproduced the missing integration (one failure, two passes).
After wiring the helper, all seven room-source native cases pass, including the
four preceding cases and actual focus on reopened work ahead of settled history.
The fixture intercepts its synthetic HTML navigation, aborts all other requests,
injects questionnaire state and uses an inert WebSocket. This proves host view/focus
behavior, not real socket, authentication, PostgreSQL or application startup.

Ready research system notices now render their valid child-document link through
current MessageMarkdown styling. Only the exact archived notice with a valid current
child route is recognized; ordinary text, external URLs, malformed paths/encoding,
queries, fragments and extra prose remain text. All three original SSR callbacks
are retained. A regression feeds the actual ResearchWorkspaceService ready notice
through Transcript using the existing MemoryStorage fixture. Two actual anchor
assertions failed before the fix; fifteen SSR tests with fifty assertions then pass.
This is rendering and memory-service evidence, not browser navigation or authorization.

All twenty-three original research-offer detection callbacks and twenty-seven
shared declarations are retained across five files below 500 lines each. Complete
nested-node proofs and deliberate missing/trimmed callback/helper controls pass.
The unchanged scenarios run the real processor/interpreter with injected local Jev
responses and the original serialized durable-snapshot double: twenty-three pass,
216 assertions. That double is not MemoryStorage. No policy, threshold, model,
fixture identity or assertion is tuned. Original race/failure/publication tests stay
with the product extraction. Restored scenarios passed on first execution, so their
previous absence is not claimed as a behavior regression failure.

Whole application verification, remaining original browser units, live announcements
and the declared compatibility conflicts remain outstanding. No archived ordinary
browser suite/configuration/preload is loaded, listed or executed by this slice.

Final fresh verification passes 3,376 offline tests with 15,989 assertions across
548 files; two PostgreSQL checks are skipped. All seventy-seven isolated native
browser cases pass using fresh client assets, including the three new host cases.
Workspace types, client build, formatting and CI pass. CI retains three existing
lint warnings, 221 reviewed design exceptions and the existing design baseline;
the build retains its existing chunk-size warning. Both independent reviews
approve the changes. Post-format source proofs preserve every prior affected
callback plus all original restored callbacks/declarations. No ordinary browser
suite, application listener, PostgreSQL service, migration or paid provider starts.
The finite product extraction remains unfinished.

## Conversation live announcements

The missing workspace live region and historical comparison are restored through a
small pure helper. The complete archived comparison order, captures, predicates,
message strings and final-event exclusions are retained by an adapted-body AST
proof with wrong-revision, swapped-priority and removed-exclusion negative controls.
The first observed state is a silent baseline. A newly failed message wins over
simultaneous event growth; otherwise growing events announce a card update unless
the last event opens a thread or links a card. Equal observations still replace
the captured summary without announcing. Failed membership is relative to the
preceding observation, so an observed retry can become eligible again.

Ruling: retain React-observed batch semantics and add a synchronous store reset
generation — the comparison must not replay reconnect history when React coalesces
reset and first snapshot — a mistaken scope would create a spurious announcement.
Snapshot shape, wire behavior and all prior store members remain unchanged except
the reset counter. The host captures the generation at render and scopes its prior
summary by store identity and generation; room/reset baselines also clear stale text.
Chat tokens and job updates do not drive comparison.

One stable, hidden polite status region precedes the unchanged Workspace subtree.
An eligible transition replaces its keyed descendant, allowing identical message
text to mutate the DOM again without remounting the live region. This and stale-text
clearing are deliberate accessibility integration improvements beyond the archived
string-state equality behavior. Browser DOM mutation is evidence of an update;
actual screen-reader speech is not verified.

Focused checks pass eleven pure comparison cases (25 assertions), three store
cases (18 assertions) and ten actual-host native cases. Genuine failing comparisons,
store-generation expectations and a compiled/mounted missing-region browser case
precede their fixes. The native cases exercise history, retries, failure priority,
opening exclusions, quiet jobs/chat, coalesced reset, room changes and cleanup.
An initially incorrect new test expectation about equal revisions was corrected
to match the archived summary-capture rule; production comparison was unchanged.
The existing synthetic HTML/inert socket/request-abort boundary remains intact.
No application, provider or database is started. Original fixture bindings, seven
room-source callbacks and complete existing Workspace JSX remain preserved.

This restores one missing product behavior. Remaining whole browser units and
full application verification are still outstanding; extraction remains unfinished.

Final fresh verification passes 3,389 offline tests with 16,022 assertions across
549 files; two PostgreSQL checks are skipped. All eighty-seven isolated native
browser cases pass with fresh client assets. Full workspace types, client build,
formatting and CI pass, retaining three existing lint warnings, 221 reviewed design
exceptions, the existing design baseline and build chunk-size warning. Independent
comparison review also matches 367 complete archive-effect/helper observations;
host/native review approves scope handling and full source preservation. Existing
ordinary browser runners, server behavior, protocol, persistence and provider
configuration are unchanged. Whole application and actual spoken delivery are not
verified, and remaining product extraction requirements are outstanding.

## Whole research browser regression source

Both original research browser modules and their shared fixture are retained
byte-for-byte: 200, 335 and 245 lines. All four complete test registrations,
fourteen helpers and four local types remain intact, including the delayed
correlated-link response, Resume race, viewer denials, reload and child navigation
assertions. Current dependency exports and static E2E types pass. Fresh full-byte,
nested-AST and complete source-boundary proofs reject missing callbacks, trimmed
nested assertions and changed race strings.

The exact archived fake-GitHub revoked-viewer map/comment and listing conditional
are selectively retained. For that synthetic handle prefix, the first listing
grants score pull access without push; later listings remove score pull access.
Current device authentication, creator role handling, accessible repository list,
ETags and all other provider branches remain unchanged. This is fixture source
retention, not proof of the server's post-admission authorization recheck.

Two exact Chromium exclusions keep the restored suites out of normal discovery.
The other projects' selections and four prior exclusions remain unchanged. The
dedicated scripted configuration still selects only jobs and prose. No restored
suite/helper or GitHub preload is imported, listed, evaluated or invoked. Source
checks do not provision PostgreSQL or execute SQL, OAuth, WebSockets, HTTP routes,
research publication or browser navigation. The helper's database fallback and
direct writes require explicit disposable-database/lease setup before execution;
ready-child fixtures remain mechanical publication fixtures. Existing domain and
isolated native evidence does not replace these whole application callbacks.
Remaining original browser units and full application verification are outstanding.

Final fresh full types, formatting and CI pass with the same three existing lint
warnings, 221 reviewed design exceptions and existing design baseline. Independent
review confirms exact archive bytes/nested bodies, unchanged forty-file ordinary
selection sets (23/8/1/1), both new suites excluded from every project, and unchanged
dedicated selection. Removing only the two ignore joins reconstructs the preceding
normal configuration; removing only the complete map/comment/conditional reconstructs
the preceding GitHub preload byte-for-byte and by full AST. An incomplete comment
extraction caught during review is corrected and its complete bytes are now checked.
No production, unit-test or UI runtime code changes in this slice. The preceding
3,389 offline and eighty-seven native passes remain historical evidence; they are
not repeated or represented as fresh execution of these unactivated browser cases.
