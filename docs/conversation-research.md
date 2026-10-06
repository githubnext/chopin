# Research offers from Chat

With `CONVERSATION_PLAN=on`, ordinary human Chat messages can propose external
research. A message may explicitly suggest investigation or identify a meaningful
information gap. The subject can be stated directly or resolved from bounded
recent discussion and decision context. The classifier favors clear opportunities;
ambiguous subjects and repository-only debugging questions are left unapplied.

Decision analysis and research analysis run independently. Research does not need
an existing decision, known candidate options, or an accepted decision contribution.
A message can contribute to a decision and propose research at the same time.

## Offer lifecycle

An offer appears in Chat with **Start research**, **Edit brief**, and **Dismiss**.
The brief is synthesized from its source material through an isolated harness
worker. When synthesis is unavailable, a self-contained source excerpt can serve
as the initial brief. An offer without a usable brief remains internal until
preparation succeeds. An offer is not yet a research request or a child document.

Any repository writer can edit, start, or dismiss an offer. These actions are
shared with the other participants:

- New relevant discussion refreshes an untouched brief.
- Entering the shared editor gives people control of its wording. Subsequent
  discussion produces optional sourced additions instead of rewriting the brief.
- The editor is live-collaborative; **Done** closes the editor after its edits have
  entered the shared draft. Unacknowledged edits are retained for reconnect.
- The single card moves beneath the latest message that materially contributes
  to it. Its original source and identity remain stable.
- Repeated discussion reuses an existing offer. A dismissed topic can return
  after a fresh explicit research proposal or materially changed scope.
- Additional requirements after acceptance can produce a linked follow-up offer.

**Start research accepts the latest server-accepted shared draft.** The initiating
browser first flushes its own pending edits. The server then atomically seals the
current brief and records the durable start intent. Edits arriving after that
boundary are excluded. Research creation and execution follow through idempotent
delivery, using an immutable offer-scoped key. Simultaneous starters observe the
same result and the winning participant's attribution.

The card shows request progress and opens the ordinary child document once the
complete report has been published. Failure and retry preserve the accepted
brief. See [background jobs](background-jobs.md) for research execution and child
publication. The existing `/research` document composer remains the manual entry.

## Processing and persistence

Both analysis queues commit with the saved message. Each has independent outcomes
and retry receipts. Model work runs outside the document mutation lock; research
admission rechecks affected offers and decisions before committing. A failure in
one analysis path does not roll back the other's accepted changes.

Research uses its own versioned Jev question set. The decision classifier no
longer asks `research_need`. Historical analyses retain that field when present.
The message diagnostics show research judgments, policy outcomes, model and
question-set versions, admission-policy version, timing, and an independent retry
action. Admission checks show the score and actual minimum or maximum used.
Subject clarity combines the explicit and contextual probabilities; the winning
category's confidence is a separate model judgment.

Admission policy `research-admission-2` uses a 70% external-suitability minimum
when the explicit-proposal signal is at least 90%. Inferred opportunities use
80%. A proposal still needs sufficient research significance, speaker ownership,
a clear subject, valid source evidence, and an unresolved question. Updates to
an existing offer can establish significance through a material scope change.
Only the external-suitability minimum responds to strong explicit intent.
Failures report the unmet threshold rather than labeling a borderline score as
proof that a request is not external research. Historical analyses without the
new admission fields retain their original diagnostics.

Conversation state version two adds research analysis and general offer metadata
inside the existing version-one channel sidecar. Restoration upgrades unfinished
version-one work without reanalyzing completed chat. Historical pricing offers
keep their original option-snapshot validation and request identities.

Brief drafts are bounded json-joy string CRDTs from `packages/draft`. The server
validates candidate patches and persists their complete state before acknowledgement
or publication. Original excerpts, generated wording, and human edits remain
distinct. Offer placement is presentation metadata and never determines request
identity.

`research-brief@1` uses the generic durable job framework. It receives selected
Chat excerpts and decision snapshots, returns structured output with source IDs,
and has no web, repository, shell, or document-editing tools. Generation checks
prevent stale output from replacing human edits or accepted briefs. Successful
artifacts reconcile on completion or the next room opening.
Runner failures also reconcile the offer immediately so its refinement error and
retry action become visible. The brief worker uses a 30-credit session ceiling,
matching the Copilot SDK's minimum accepted session limit.

## Configuration

- `CONVERSATION_PLAN=on` enables both Jev analysis paths; the default is off.
- `JEV_API_KEY`, `JEV_MODEL`, and `JEV_TIMEOUT_MS` configure their shared transport.
- Brief synthesis uses the existing harness and active Planner owner. Passive
  synthesis does not claim ownership.
- `AGENT=off` or `BACKGROUND_JOBS=off` disables synthesis. Source-based offers can
  still appear. Starting research follows the existing execution capability and
  authorization checks; unavailable execution is shown in the card.
- Offers and research execution are supported on top-level documents. Child
  documents do not offer another research level.

## Verification

The relevant checks include:

```bash
bun test packages/draft apps/server/src/conversation-plan apps/server/src/jobs
bun run types
bun run ci
bun run build
bun --bun node_modules/@playwright/test/cli.js test --config e2e/source/playwright.config.ts research-offers.native.ts
E2E_RESEARCH_OFFERS=1 bun run e2e research-conversation.e2e.ts --project chromium --workers 1
```

The application test switch selects the Jev HTTP fixture and keeps research
execution off. It exercises production authentication, sockets, persistence,
classification admission, shared editing, source movement, and dismissal. Unit
and storage tests cover accepted-brief delivery and request identity. The
PostgreSQL conversation reconstruction test uses fresh processes to verify sealed
drafts and pending delivery survive restart.

Provider fixtures establish mechanics, not live semantic accuracy. Live checks
should cover paraphrases, implied subjects, comparisons, information gaps,
negation, reported speech, withdrawal, and unrelated discussion, recording the
actual Jev model version and both missed and unnecessary suggestions.

A bounded live check on 5 October 2026 used `jev-1.13.0` for 16 initial-message
cases and a four-message offer lifecycle. The final pass recognized the original
“maybe we should investigate Jev alternatives” example, contextual shorthand,
pricing gaps, and general comparisons; it withheld offers for ambiguous subjects,
repository-only questions, negation, reported speech, and withdrawal. The lifecycle
pass retained one offer while adding a self-hosting requirement and allowed a fresh
explicit proposal after dismissal. These observations cover classification and
admission, not live execution of the report-generation workers.

A follow-up admission-policy check on 6 October used 36 scenarios twice, including
12 held-out scenarios, with `jev-1.13.0`. All 36 negative runs were withheld and
32 of 36 positive runs produced research candidates. The four misses were bare
references to Jev falling below the independent subject-clarity threshold. The
exact reported question passed in two additional runs with recent discussion
identifying TypeSafe Jev's role. A deterministic regression covers the reported
79% external-suitability score with strong intent and explicitly clear subject
probabilities; that score now passes the explicit-proposal path. These results
do not establish that every paraphrase will pass the other admission gates.
