# Jev feature quality handoff

Branch: `Maggie/jev-chat-product`. Reviewed application and test revision:
`b7b79ef00c2ffe1fe1ea84a9eb7fdcc034d099e6`. The final handoff commit changes
only documentation.

The review integrated main at `bae7818597895841b0adbe9c023c0a57194af96e`
through merge `d22862a6`, then audited the complete feature by subsystem with
independent re-review. [The review ledger](jev-quality-review.md) records ownership
and confirmed fixes. The extraction ledger and source inventory remain historical
references.

## Result

The branch retains the conversation/decisions workflow: sourced interpretation,
shared card drafts and choices, explicit Save, scoped Planner work, decided prose,
and consent-based research children. The review fixed stance targeting after
refinement, staged card mutations, bounded execution context and event capacity,
unsupported child research offers, missing live prose-anchor forwarding, and
pending option cancellation/focus handling. Unmounted historical UI was removed.

Retained browser scenarios now exercise the mounted interface and actual keyed
option protocol. Duplicate research tests were consolidated without dropping
publication, retry, cancellation, or reconnect coverage.

## Fresh verification on 2 October 2026

| Check                                     | Result                                              |
| ----------------------------------------- | --------------------------------------------------- |
| Unit/domain suite                         | 3,539 passed; 3 PostgreSQL guards skipped; 0 failed |
| Real PostgreSQL contracts/lifecycle       | 72 passed; 0 skipped; 0 failed                      |
| Complete application Chromium suite       | 327 passed; 0 retries                               |
| Contained Planner/research Chromium suite | 76 passed; 0 retries                                |
| Actual-component Chromium contracts       | 98 passed; 0 retries                                |
| Workspace and E2E types; repository CI    | Passed                                              |
| Exact-revision image and client build     | Passed                                              |

The PostgreSQL suite includes three fresh processes proving accepted document,
conversation, and receipts survive; a running job becomes durably interrupted
once. Browser coverage includes successful heading/refine/prose work, actual
inference process restart, two/three-member collaboration, evidence, native
cut/paste anchors, option acknowledgement races, and research recovery.

The final image is `chopin-jev-quality:66fa`, digest
`sha256:7f57949a757ec8983beb80aee447812819887d5d93c5499e8943b4a3b21dac31`.
The contained report is in
`e2e/test-results/conversation-plan/a879404db95f8b9c0d528641167dc746/`.
Its attestations confirm the source/build stamp, denied egress, successful CLI,
no remaining worker/listeners, preserved artifacts, and both owned containers
removed. Application/component logs and results are retained locally under
`/private/tmp/jev-*-v3*`; unit evidence is `/private/tmp/jev-browser-fixed-unit.log`.
CI retains four existing lint warnings and one design baseline finding.

To repeat checks, use `bun test --timeout 30000`, `bun run types`, `bun run ci`,
and a disposable database with `TEST_DATABASE_URL` supplied to
`bun test apps/server/src/storage/postgres`. Run the full application suite with
`bun run e2e --workers=2 --retries=0`; run component contracts through
`bun --bun node_modules/@playwright/test/cli.js test --config e2e/source/playwright.config.ts`.
For contained checks, build `e2e/conversation-plan.Dockerfile` with
`CHOPIN_SOURCE_COMMIT` set to the current full commit, then run
`bun scripts/conversation-plan.ts --image <local-tag> --postgres-image postgres:17`.

## Remaining limits

- Paid-provider semantic quality remains unverified. Deterministic model fixtures
  exercise real authorization, storage, sockets, and Planner execution.
- Multi-step refinement may retain earlier durable tool writes after interruption;
  explicit retry is required. The entire semantic edit is not an atomic batch.
- Capacity reservations prevent new oversubscription; they do not repair legacy
  persisted histories already oversubscribed by pending actions.
- Main advanced during this review to `3e57e40ea6da4920d8a6f8a8ee645ff6abadc898`
  with Atomic harness and Chat mention changes. Integrate those newer commits and
  recheck their interaction before merging this branch.

Start follow-up work with [architecture](architecture.md), [storage](storage.md),
[hosted Planner](hosted-agent.md), [background jobs](background-jobs.md), and
[authentication](authentication.md). Keep fixes small and preserve the recorded
behavioral checks.
