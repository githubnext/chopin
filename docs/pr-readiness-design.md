# Automatic PR readiness

## Outcome

Help open Chopin PRs recover from failing current-head CI and actual merge
conflicts before a human reviews them. A mergeable branch that is merely behind
its base does not need an agent unless repository policy requires an update.
When preserving intent requires a human decision, present the exact decision on
the PR, label it `needs-human-attention`, and notify its owner. Humans retain
review, approval, draft, and merge decisions.

The agreed architecture is a deterministic coordinator plus one repair agent
per PR, hosted in GitHub Actions. Verified stale design hashes may be renewed
automatically. This replaces the separate rebase and batch CI-fixer workflows.

Repository baseline: `githubnext/chopin`, main commit
`c4657388cfe529a70fa28b137c1ab039a6d46c6d`.

## Coordinator and durable state

PR updates, base-branch changes, CI completions, and manual retry wake the
coordinator. An hourly scan recovers work missed by events or interrupted by
runner failures. The disabled coordinator runs no inventory; a pilot selection
limits per-PR reads before verification and reporting.
Set `PR_READINESS_PRS` to selected PR numbers and `PR_READINESS_HEAD_REFS` to
their exact head branch names during the pilot. The second variable lets CI
completion events wake only selected PRs because GitHub can omit PR numbers from
those events. Set `PR_READINESS_PRS=all` after the full rollout; the head-ref
gate then no longer applies.

Eligibility includes same-repository open PRs, including drafts.
`no-babysit` remains the opt-out. Forks are outside the first release. A pilot
uses main-based PRs; stacks need a recorded replay boundary before expansion.
Preserve the current base, draft status, reviews, and authored PR description.

Maintain durable, bot-owned state for each PR: observed head and base SHAs,
attempt identity, status, repair count, failure fingerprint, next retry time,
active Actions run, and escalation identity. Validate state ownership before
reading it. Labels and comment prose display state; arbitrary human comments
and PR source do not define workflow authority.

Allow three repair workflows concurrently across the repository. Serialize each
PR's complete read, propose, inspect, apply, and report cycle with one lock.
Duplicate events must neither start competing writers nor discard another PR's
work. Persist dispatch intent and reconcile it against Actions run state so a
lost dispatch response cannot permanently lose work.

## Repair cycle

1. Re-read eligibility, branch identities, and current checks. Capture the exact
   head SHA, base SHA, and trusted main instructions for this attempt.
2. Dispatch an agent for a true conflict or failed current-head CI. If an
   explicit repository policy requires an up-to-date branch, update it first.
   For a conflict on a main-based branch, merge the captured base into the
   captured head and resolve only conflicts whose intent is clear. Preserve both
   features and existing commit history.
3. Obtain CI for the resulting head. Pending CI means wait; absent or cancelled
   CI must be triggered or retried rather than interpreted as passing.
4. Read the first meaningful failure and reproduce it. Apply the smallest
   correction that preserves the PR's intended behavior and existing rules.
5. Run the failed check and relevant regressions. Apply repository formatting
   and validation commands. Use real browser, PostgreSQL, and container
   prerequisites when those behaviors fail; speculation is not verification.
6. Submit a proposed artifact. A trusted application job checks eligibility,
   provenance, allowed paths, and the expected remote head before writing. All
   updates use a guarded push against the captured remote head.
   A changed remote head invalidates the attempt and causes reconciliation.
7. Await GitHub CI on the published head. Re-read the base and head before
   declaring readiness. New failures continue the cycle within the repair
   budget; base movement alone does not spend agent minutes.

An agent's successful exit or accepted proposal alone never means ready. The
trusted job must confirm the actual branch update and current GitHub checks.

## Stacked PRs

Repair parents before descendants. Record parent tips before rewriting them so
descendants can replay only their own commits onto the new parent tip. Do not
flatten a stack onto main or replay superseded parent commits. A stack remains
a human blocker until this boundary is recorded and the publication path proves
it can preserve the stack; pilot success alone does not authorize all-PR rollout.

After a parent merges, reconcile the child's actual base and old parent tip
before restacking. Escalate an ambiguous stack boundary rather than guessing.
Waiting for a repairable parent is automatic work, not a human blocker.

## Design hashes and write authority

Agents may renew a stale hash after inspecting the protected source and
confirming that its existing exception still describes its current data flow,
scope, and intended behavior. Report the reviewed source, rationale, and checks
in the PR's maintenance comment. A conflict in an existing exception JSON file
may be resolved this way only when the merge base and both sides retain
identical exception structure and the resulting hashes match the merged source
bytes.

Renewal does not authorize adding or broadening exceptions, removing findings,
weakening tests, or changing design rules. A new exception, disputed behavior,
or snapshot update that accepts a substantive visual change requires a human
decision. Formatting and mechanical regeneration are allowed when verified.

Application code, tests, documentation, and exact design-hash renewals are in
scope. Workflow files, agent instructions, maintenance code, dependency
manifests, and lockfiles require escalation in the first release. Trusted jobs
perform all remote mutations; repair agents do not receive write credentials.

## Retry and recovery

Use three substantive repair attempts per episode and escalate after two
attempts reproduce the same failure without progress. An episode starts with a
human-authored head change or an explicit retry; automation commits and base
movement do not reset its budget. Each attempt has a 45-minute limit.

Transient runner, network, and provider errors retry after 5, 15, and 60 minutes
without consuming substantive repair attempts. Exhausted infrastructure retries
remain visible with the failing Actions link and concrete operator action.
Shared outages should produce one repository-level diagnosis, with affected
PRs referencing it, rather than repeatedly pinging every author.

A human blocker pauses substantive work for that episode. New human commits or
an authenticated explicit retry resume it. A base update can clear a blocker
when deterministic checks prove it resolved, but does not restart an unchanged
decision repeatedly. A diagnosis comment is never a permanent skip marker.

## PR presentation

Use mutually exclusive labels `maintenance:working`, `maintenance:ready`, and
`needs-human-attention`. Working covers queued repair and waiting for CI or a
parent. Ready means the branch is mergeable and the configured CI jobs and
required checks pass for its current head. A repository policy requiring an
up-to-date branch must also be satisfied.
Review requirements and draft status remain independent.

Maintain one bot-owned comment per PR, identified by a stable marker. Include
current status, inspected head, relevant CI links, changes and verification,
and any outstanding decision. Preserve the last blocker until it is resolved.
Do not rewrite the authored PR body.

For human attention, include the conflicting files or failing expectation,
both competing intentions, the agent's recommendation, and the exact answer or
action needed. Mention human assignees, or the human PR author if unassigned,
once per new blocker. For bot-authored unassigned PRs, label and explain that
an owner must be assigned. Clear the attention label when the blocker resolves.

## Validation and rollout

Cover event duplication, 30-PR backlog fairness, per-PR serialization, stale
heads, interrupted dispatches, real subprocess conflict errors, transient
failures, absent CI, attempt budgets, comment deduplication, hash-only renewal,
and readiness invalidation in deterministic tests.

Use disposable branches to verify guarded pushes, conflict merges, rebase leases,
parent-child restacking, CI triggering, and current-head readiness against GitHub.
Verify a model request succeeds through the actual firewall and that safe
application supports the chosen rebase mechanism before enabling backlog writes.

Roll out in small slices: reliable scheduling and state; ordinary CI repair and
verified readiness; conflict repair, stacks, and escalation. Start with a
read-only backlog inventory, then one main-based PR, then three concurrent
workers, and finally all eligible PRs once stack handling is proven. Cancel
queued old-writer runs before the first new writer is enabled; delete the old
workflow definitions after the pilot succeeds. A manual dispatch must support
an immediate selected-PR scan.
