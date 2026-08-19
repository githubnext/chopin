# Implementation verification design

PR #49 should finish the implementation lifecycle without undoing the simpler
model established by PR #48. The awkward version stored mutable task snapshots,
verification reports, and terminal status on `Run`; that gives the same run
several competing stories about what happened. This rebuild keeps one story:
the ordered lifecycle event log.

## Goals

- Require evidence for every frozen task before an implementation can succeed.
- Keep failed verification inside the active, locked run and return only the
  named tasks to work.
- Release a successfully verified run without making the same graph claimable
  again.
- Track later pull-request merges against the exact run that owns them.
- Preserve graph revision as an explicit unsuccessful exit, separate from
  verification.
- Use the existing MCP registry and live/closed-channel persistence paths.

## Run and graph identity

`Run` remains immutable claim identity. It gains `graphVersion`, the graph
version number returned by `read_implementation`; `start_implementation` must
echo that number alongside the graph and plan revisions. The three values form
an exact graph reference. This matters because graph revisions restart at one
for a new graph version, and a plan revision need not move between versions.

Every lifecycle MCP call includes `runId`. A stale call from an earlier run must
not accidentally mutate a newer run whose tasks happen to have the same IDs.
The input uses `runId` for routing; events do not repeat it because their
containing active or archived log already owns the run identity.

## Canonical lifecycle model

Lifecycle data remains beside the plan:

```ts
type Lifecycle = {
	events?: ProgressEvent[];
	history: ArchivedRun[];
};

type ArchivedRun = {
	run: Run;
	events: ProgressEvent[];
};
```

`ArchivedRun` has no independently stored status or outcome. A revision log
ends in `request_revision`; a verified log contains one passing
`report_verification`, followed only by delivery-state events. Implemented and
delivered are projections, never another durable flag.

`report_verification` carries:

- `passed`
- a non-empty summary and reviewer method
- exactly one non-empty evidence entry for every task
- a unique `tasksNeedingWork` subset, empty on success and non-empty on failure

One reducer derives task progress and phase from a run and its events. Restore,
transition, active progress, and history projection all use that reducer. It
rejects impossible ordering instead of accepting a plausible-looking snapshot.

## Transitions

A verification report is accepted only when every task is completed and owns
an open or merged pull request from the run's repository.

A failed report is appended to the active log. The run and graph remain locked;
named tasks become `in_progress`, lose their old completion summaries, and keep
their pull-request associations. Later work events may follow, then another
verification report.

A passing report is appended and the whole log moves into history atomically.
Execution clears and the graph returns from `locked` to `approved`, allowing a
new graph version to be drafted. Claiming checks history in the same transaction
and refuses an exact graph reference that already ended in successful
verification. A newly drafted graph version remains claimable even when its
plan and graph revision numbers happen to match an older version.

`request_revision` stays available as cancellation when the graph itself is
wrong. It may occur before task completion, archives the run, clears execution,
and releases the graph. It never produces implemented or delivered status and
does not prevent a revised graph from being claimed.

## Pull-request delivery

Before verification, `report_pr` updates the explicitly addressed active run.
After successful verification it may update only the explicitly addressed
archived run, task, and already-associated URL. Unknown runs, revision-requested
runs, URL replacement, and ambiguous or mismatched addresses are refused.

When several tasks share one pull-request URL, one post-verification state
change updates every matching association in that run. A merged pull request
cannot move backwards to open or closed.

Historical status is derived as:

- `revision_requested` when the log ends in that event;
- `implemented` after successful verification while any distinct associated
  pull request is not merged;
- `delivered` once every distinct associated pull request is merged.

## MCP and persistence

`apps/server/src/mcp/lifecycle.ts` remains the single descriptor map for schema,
parsing, descriptions, and dispatch. It gains `report_verification`, `runId` on
lifecycle inputs, and `graphVersion` on implementation start. `mcp.ts` does not
grow another lifecycle condition chain.

No new persistence seam is needed. Live transitions continue to run under
`exclusive`, commit graph, execution, and lifecycle together, then broadcast.
Closed channels continue through `lifecycleStored` and the existing
revision-checked sidecar commit. A failed commit restores every in-memory field
before anything is published.

## Restoration invariants

Restoration rejects:

- duplicate run IDs or idempotency keys anywhere in the document;
- a run whose graph reference does not resolve exactly;
- active logs containing a successful verification or revision terminal;
- archived logs without exactly one legal terminal event, or with an illegal
  event after it;
- incomplete or duplicate verification evidence;
- task-work events after successful verification;
- post-verification URL replacement or updates for unknown tasks;
- PR state moving backwards from merged;
- more than one successful run for the same exact graph reference.

## Testing

Domain tests cover readiness, evidence validation, failed rework, successful
archival, immediate delivery, later delivery, shared PR URLs, idempotent replay,
wrong run IDs, terminal ordering, strict restoration, graph-version identity,
and refusal to reclaim a verified graph.

MCP tests cover the single advertised registry, `runId`, `graphVersion`, valid
and malformed verification payloads, and session gating. Hosted and plan tests
cover live and closed channels, atomic persistence, rollback before broadcast,
post-run delivery while newer work is active, and close/reopen restoration.
