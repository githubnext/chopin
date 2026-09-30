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

| Slice                      | Preserved behavior and evidence                                                                                                                                                                                                              | Focused result                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Stored identity            | Original `storedText()`/`identified()` and public export; IDs, order and raw strings survive without mutation. Normalisation and draft behavior stay current.                                                                                | 33 question tests, 99 assertions          |
| Contract and sources       | Complete archived `ConversationPlan` namespace, type export and `sources.ts`; exact UTF-16 spans, saved author/text identity and completed messages. Global wire unions and session flags stay current.                                      | 6 source tests, 53 assertions             |
| Quotes                     | Byte-identical parser/budget, all four original test bodies, plus explicit fifth-candidate rejection. Five exact development messages have source provenance.                                                                                | 5 tests, 20 assertions                    |
| Event/correction guards    | Original functions in bounded modules with an acyclic façade; all event and correction cases remain.                                                                                                                                         | 7 tests, 88 assertions                    |
| Research/snapshot guards   | Completes the original validation façade. Root syntax-tree proof: all 17 original functions and six constants occur once and match.                                                                                                          | 12 tests, 81 assertions                   |
| Accepted-event replay      | All 21 original case bodies, support functions, opening/preamble and counters match source syntax trees; `preference.ts` is byte-identical. Routing covers each case once.                                                                   | 9 tests, 51 assertions                    |
| Pure domain                | All 18 archived functions and 18 original test callbacks/helpers match source syntax trees. Small, acyclic modules retain the original 11 public APIs.                                                                                       | 18 tests, 58 assertions                   |
| Research-offer regressions | All 10 original tests and helper data match source syntax trees across three small suites; no production changes or eval imports.                                                                                                            | 10 tests, 72 assertions                   |
| Card and Save regressions  | All 17 original card tests and helpers match source syntax trees; four scoped Save tests are byte-identical. Card authority and exact support lineage remain unchanged.                                                                      | 21 tests, 71 assertions                   |
| Option growth              | Byte-identical archived helper and six original tests; limit/export additions only. Cloned drafts keep existing selections and labels grow in order.                                                                                         | 39 question tests, 110 assertions         |
| Answer identifiers         | Archived derivation adds IDs alongside labels from the same ordered selection; optional protocol field retains old answers. Custom answers and summaries stay unchanged.                                                                     | 64 question/service tests, 171 assertions |
| Record validation          | All 25 original function/constant/type declarations match source syntax trees; seven archived tests are byte-identical. Extracted required dialect MAX_ID=200; added UTF-16 boundary regression.                                             | 8 record tests, 29 assertions             |
| Pending-card drafts        | Whole draft implementation matches archive; restored original empty-card mode assertions and added first-option selection/ID regression. Existing stored modes stay unchanged.                                                               | 73 focused tests, 205 assertions          |
| Shared definitions         | Store restoration and controller Open.Reply use identified definitions; existing wire types cover them. One original Store callback/helper and five new regressions cover stable IDs, pending cards and malformed payloads.                  | 79 focused tests, 226 assertions          |
| Store options/lifecycle    | Small acyclic modules preserve archived APIs/types, capture/revert, reopening and editor credit. Nine of 19 original Store callbacks are retained; 17 other core bodies remain unchanged apart from editor initialisation.                   | 99 focused tests, 292 assertions          |
| Store suggestions          | Archived suggestion metadata, restore bounds and explicit submit fallback; all 47 Store declarations and 19 original callbacks are retained exactly once across small suites. Existing service callers remain unchanged.                     | 109 focused tests, 348 assertions         |
| Durable record restore     | Canonical record defaults, matching saved definitions/drafts and transcript-checked option sources are integrated into current sidecar restoration. Ten memory persistence regressions; current metadata and mutation bodies remain intact.  | 129 focused tests, 417 assertions         |
| Request builders           | All 18 archived declarations and exact prompts are split across acyclic modules. Thirteen original builder callbacks and nine fixture declarations are retained; two interpreter cases remain assigned to their dependency slice.            | 111 conversation tests, 580 assertions    |
| Review/correction coverage | All 19 original callbacks and 18 actor/helper declarations are retained, including the complete three-case excerpt table. Twenty-one cases exercise existing pure behavior; production is unchanged.                                         | 132 conversation tests, 669 assertions    |
| Policy leaves              | All 24 archived helper/type/constant declarations are retained across five small acyclic modules. One exact pipeline callback verifies deterministic ULID identity and Unix-second encoding. No policy dispatcher or placeholder exists yet. | 133 conversation tests, 673 assertions    |

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

Next: extract the policy's ordered terminal stages, then candidate dispatch. Preserve
shared candidate state, local capture timing, continuation and event-limit checks,
and partial events retained after follow-up failure. Keep the original public
interface and compare original offline fixtures before publishing the dispatcher.
