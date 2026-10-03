# Jev conversation workflow

Jev lets ordinary Chat discussion develop into sourced decision cards and, after
an explicit Save, document prose. The Planner remains the agent that writes and
refines the document; Jev classifies discussion and proposes structured changes.
This guide describes the integrated feature and its review boundaries. It does
not establish release readiness or replace the validation records below.

## What changes for users

- Chat sits to the left of the document, using the existing resize and compact
  workspace controls. Direct `@chopin` requests still invoke the Planner.
- Ordinary discussion can create questions, add options and attach reasons,
  constraints, support or objections. Source links lead back to the quoted message.
- Decision cards retain shared drafts, stable option identities and participant
  attribution. Suggestions and inferred agreement do not save a decision.
- A writer explicitly saves a choice. Scoped Planner work then turns the saved
  decision into prose. Reopen preserves the previous answer; Discard records the
  lifecycle change without treating it as agreement.
- Evidence and analysis views explain attributed discussion and expose supported
  corrections and retries when interpretation misses useful material.
- Research suggestions require human consent. Accepted offers use the existing
  durable research workflow and publish an ordinary child document on success.
  Child documents do not offer another level of research.

The interface extends the existing QuestionView, resolved reader and Decisions
list. It does not require a separate Jev card renderer. See
[UI reconciliation](jev-ui-reconciliation.md) for that integration.

## How discussion reaches the document

```text
Saved Chat message
  → durable analysis queue
  → Jev classification of bounded, exact source spans
  → policy validates attribution, target and permitted transitions
  → conversation events and pending effects commit
  → effects create/update cards and enqueue scoped Planner work

Human Save
  → decision record, document projection and pending work commit
  → card action is mirrored into conversation history
  → Planner writes prose for that saved decision generation
```

Classification runs outside the document lock. Before committing its result,
processing rechecks the affected conversation and card state. A stale result
cannot silently overwrite an intervening human choice. Failed analysis has an
explicit retry path; uncertain classification can leave a message unapplied.

The current implementation has separate durable state for message analysis,
pending effects and receipts, card actions awaiting mirroring, and Planner jobs.
These serve different stages of the flow; they are not separate databases.
They live with the conversation events and decision records in the channel's
versioned sidecar. PostgreSQL commits precede publication to connected clients.
See [storage](storage.md) and [architecture](architecture.md).

## Where to review

| Responsibility                          | Entry points                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jev transport and configuration         | [jev.ts](../apps/server/src/conversation-plan/jev.ts), [config.ts](../apps/server/src/config.ts)                                                                                                                                                                                          |
| Source spans, interpretation and policy | [quotes.ts](../apps/server/src/conversation-plan/quotes.ts), [interpret.ts](../apps/server/src/conversation-plan/interpret.ts), [policy.ts](../apps/server/src/conversation-plan/policy.ts)                                                                                               |
| Accepted events, replay and corrections | [domain.ts](../apps/server/src/conversation-plan/domain.ts), [events.ts](../apps/server/src/conversation-plan/events.ts), [state-restoration.ts](../apps/server/src/conversation-plan/state-restoration.ts)                                                                               |
| Processing, effects and card mirroring  | [runtime.ts](../apps/server/src/conversation-plan/runtime.ts), [service.ts](../apps/server/src/conversation-plan/service.ts), [effects.ts](../apps/server/src/conversation-plan/effects.ts), [card-mirror-runner.ts](../apps/server/src/conversation-plan/card-mirror-runner.ts)          |
| Decision records and Save               | [records.ts](../apps/server/src/questions/records.ts), [service-submit.ts](../apps/server/src/questions/service-submit.ts), [card-actions.ts](../apps/server/src/questions/card-actions.ts)                                                                                               |
| Scoped Planner work                     | [planner-jobs.ts](../apps/server/src/conversation-plan/planner-jobs.ts), [job-prompts.ts](../apps/server/src/conversation-plan/job-prompts.ts), [job-scope.ts](../apps/server/src/agent/job-scope.ts)                                                                                     |
| Persistence and wire contracts          | [plan/service.ts](../apps/server/src/plan/service.ts), [conversation-plan.d.ts](../packages/protocol/conversation-plan.d.ts)                                                                                                                                                              |
| Chat and evidence interface             | [room-workspace.tsx](../apps/web/src/room-workspace.tsx), [decision-entry.tsx](../apps/web/src/chat/decision-entry.tsx), [evidence-popover.tsx](../apps/web/src/conversation-plan/evidence-popover.tsx), [analysis-overview.tsx](../apps/web/src/conversation-plan/analysis-overview.tsx) |
| Research consent and execution          | [processor-research-consent.ts](../apps/server/src/conversation-plan/processor-research-consent.ts), [accepted-research.ts](../apps/server/src/conversation-plan/accepted-research.ts), [research/service.ts](../apps/server/src/research/service.ts)                                     |

## Boundaries to preserve

**Records own decisions.** Conversation support, suggestions and classifier
confidence are advisory. Saving requires an authorized human action. Keep stable
option IDs, previous answers and source attribution through refinement, reopen,
discard and retry. Document widgets and prose are projections of those records.

**Source evidence must remain exact.** Quoted spans use offsets into saved Chat
messages. Generated labels and prose must not masquerade as a participant's
original wording. Changes to parsing or confidence policy need behavioral
coverage across paraphrases, ambiguity, negation and attribution, rather than
only the particular example that motivated a rule.

**Commit before publishing.** Preserve fenced persistence, stable action IDs,
idempotent replay and rollback after storage failure. A failed Save must retain
its draft for retry. Card mirroring must not allow stale inference to override
an already committed card action.

**Planner work retains its authorization boundary.** Jobs use the current
process owner and repository authorization, with tools scoped to their heading,
refinement, suggestion or saved-prose task. Restart does not restore credentials
or grant permission to replay interrupted tool execution. See
[authentication](authentication.md) and [hosted agent](hosted-agent.md).

**Research consent and publication are separate steps.** Preserve the accepted
brief, option snapshot and request identity through retry and recovery. Recheck
authorization before starting work. Publish the complete child and its parent
link atomically; failure must not expose a partial report or duplicate child.
See [background jobs](background-jobs.md).

**Browser behavior needs browser checks.** Shared drafts, read-only cards,
selection, source navigation, anchors and highlights cross component boundaries.
Use real browser tests for geometry, focus and event ordering. Keep one mounted
owner for the resolved reader and each editor's highlights.

## Configuration

`CONVERSATION_PLAN=on` enables processing; the default is off. Startup requires
`JEV_API_KEY` when enabled. `JEV_MODEL` defaults to `jev-latest`;
`JEV_TIMEOUT_MS` defaults to 30000 and accepts integers from 100 to 60000.
Keep the key on the server. `AGENT=off` separately disables hosted Planner turns;
it is not the switch for Jev classification. See [.env.example](../.env.example)
and [self-hosting](self-hosting.md).

## Validation and known limits

Validation evidence is tied to the revision and environment that produced it:

- [Quality handoff](jev-quality-handoff.md) records unit/domain, PostgreSQL,
  application-browser and component-browser runs at its stated checkpoint. Its
  deterministic provider fixtures exercise real storage, authorization and tools;
  they do not establish the semantic quality of live model responses.
- [UI reconciliation](jev-ui-reconciliation.md) records later checks after
  integrating main's card, reader and Chat changes. Those results supersede the
  earlier UI evidence for the affected surfaces.
- [Live browser test](jev-live-browser-test.md) records a bounded real-provider
  pass at `d75b2998`: nine messages and three new decisions. It confirmed useful
  flows but also observed incorrect/overlapping decision anchors, rationale from
  a previous option carried into new prose, and useful discussion left unapplied.
  Later changes fix saved-prose anchor precedence (`9b0ad917`), ground replacement
  prose in the current choice and reasons (`7569a727`), and refresh marker geometry
  after editor resizing (`0084bc7f`), with regression coverage. The historical
  real-provider pass has not been repeated to verify those same scenarios. Useful
  discussion can still remain unapplied; deterministic checks do not establish
  live semantic quality or broad collaboration stress coverage.

Multi-step Planner refinement can leave earlier durable tool writes after an
interruption. Explicit retry does not make the entire semantic edit atomic.
Capacity guards do not repair already oversubscribed historical state.

Editing this guide or passing source checks does not rerun these suites or
resolve the live findings. For a changed implementation, report fresh results
separately and identify skipped layers. The ordinary checks are `bun test`,
`bun run types`, `bun run ci` and `bun run build`; use a disposable PostgreSQL
service for storage tests and `bun run e2e` for application/browser behavior.
The [quality handoff](jev-quality-handoff.md) documents the dedicated contained
Planner runner; [source Playwright config](../e2e/source/playwright.config.ts)
owns actual-component contracts. Keep fake providers and scripted harnesses out
of production startup.

## Extraction history

The feature was selectively ported from prototype commit
`446a9779a937fa5be7cd3eb52fd7f3023d691ed2` onto the product branch
`Maggie/jev-chat-product`, while preserving newer main behavior. The
[source inventory](jev-product-source-map.tsv) is the historical ownership map
against ancestor `f9cd64b1eb271c4534e59667d6028f95825153bb`; its 287 path entries
are not a current file inventory, review checklist or instruction to copy whole
files. Some referenced files were subsequently split or removed.

The complete chronological extraction ledger remains in
[Git history at 27eb3724](https://github.com/githubnext/chopin/blob/27eb3724a6e7ba3020552e7a1fa17f234811941b/docs/jev-product-extraction.md).
It records intermediate failed checks, source-parity constraints and milestones;
those checkpoints should not be presented as current verification results.

Evaluation datasets, scoring tools, generated reports and the prototype diary
were excluded from the product extraction. Preserve that separation. A test's
origin in an evaluation does not by itself make it disposable: retain the
underlying behavior and regression it protects, while consolidating repeated
fixtures and replacing sentence-specific policy with general behavior where
supported. See the [quality review](jev-quality-review.md) for the later review
scope and confirmed changes.
