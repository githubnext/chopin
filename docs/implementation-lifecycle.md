# Experimental implementation lifecycle

One current planning-specific workflow hands a document used as a settled plan
to an external coding agent. It persists a versioned dependency graph, lets a
coding agent claim an approved version, records task and pull-request progress,
and requires graph-wide verification before releasing a successful run. The
ordinary MCP read-before-claim path accepts MCP-created documents. Browser plans
run on the clicker's own ACP connector, which serves every repository they can push to, and its run-scoped
bridge; see the
[local implementation tracer](local-launcher.md).

The web application can prepare tasks through the Planner, review and approve
the graph, queue a local ACP session, and display task progress, dependencies,
blockers and PR links. This is a thin live tracer: decision resolution during
implementation, automatic restart and an installer remain future work.

## Actors

- The **hosted Planner** reads the current plan and drafts or revises tasks with
  `read_implementation_graph` and `edit_implementation_graph`.
- A **person** is the only actor allowed by the domain model to approve a draft.
  The header's **Build plan** press approves the exact drafted
  graph and queues it, with the clicker's own connection and checkout, in one
  durable commit.
- The **local connector** creates an exact-commit worktree and ACP session, then
  claims a browser-approved graph before prompting the orchestrator. Its scoped
  bridge fixes document and run identity for lifecycle reports.
- A **coding agent** may also connect through `/mcp`, read an approved graph, and start
  one logical implementation run. The run is not authorization-bound to that
  caller after it starts.

The [implementing-chopin-plans skill](../skills/implementing-chopin-plans/SKILL.md)
adds provider-neutral local work practices. The MCP initialization instructions
and current tool descriptions remain authoritative.

## Drafting tasks from Build plan

Only **Build plan** in the document header sends `implementation:draft`, and
only when the document has no tasks for its current revision, or its last build
was returned for changes. Opening the Build tab never drafts or starts anything;
the tab stays off until the plan has been built or a press is under way. Build
plan is always present for writers. While the document is empty, has open
decisions, accepted comments, or required investigations, it is inert and names
what is waiting. Pressing a blocked Build reveals the related decision or
investigation card. A completeness score cannot disable Build. With `LIVE_BUILD`,
a debounced assessment instead asks the existing owner-bound Planner to place
necessary decisions and investigations in the document and explain them in Chat.
It never claims an owner or runs an investigation. After the press the same slot becomes a status capsule:
**Breaking into tasks…**, **Building 3 of 8**, **Built**, **N changes to
build**, **Building changes…**, or **Build stopped**/**Build failed** with
**Retry**. The Build tab carries the same glyph, and the change count is the
number of top-level blocks added, removed or changed since the last built
source.

A browser build that delivers records its built source even without
`LIVE_BUILD`. Later edits then read as **N changes to build**, and the
capsule's **Build** sends them to `POST /api/channels/:id/implementation/rebuild`.
That route queues one rebuild of the edits onto the existing pull requests, on
the presser's own connected agent, and persists it before answering. Like
Build plan, it is refused while decisions or accepted comments are open, and
the capsule's Build is inert with that reason. The press is the approval: the
rebuild's tasks join the graph as an approved, completed version from the
coding agent's report, without a separate review. Under
`LIVE_BUILD` the same rebuild starts by itself once editing settles, so the
capsule shows a clock instead of **Build**. **Retry** on a failed rebuild uses
the same route.

The server rechecks write access and the room exactly as for a Chat message to
the Planner, refuses a child document, unresolved decisions or accepted
comments, and an active implementation, then writes the instruction itself from
the plan. No member message is posted: Chat records a system line saying who
asked, and the turn runs under the asker's
login for Planner ownership like any member turn. The notice is persisted
before the turn starts or queues. A queued draft is not shown in the Chat
queue.

At most one draft per document is live, whatever revision it was asked for,
because its instruction reads the latest document. A request while a draft is
queued or running returns that draft (`existing: true`), so collaborators
pressing Build plan together start one turn. Requests share Chat's send and queue
limits, even while the Planner is idle. A reply says `ended` when the turn
finished before the request was answered. `implementation:drafting`
broadcasts `queued`, `running` and `ended`; `ended` follows the turn's own
persistence, so a snapshot read then shows any tasks it saved. Whether tasks
arrived is the snapshot's answer, not the broadcast's. Draft records are
in-memory, like the turn they ride.

## Graph states and counters

Each graph version contains ordered tasks, dependency edges, acceptance
criteria, and these concurrency values:

- `planRevision` identifies the exact canonical plan the graph describes.
- `graphVersion` identifies a new definition created when the current graph is
  no longer a draft.
- `graphRevision` advances as a draft graph is edited.

A graph version starts as `draft`. Approval refuses a graph drafted against an
older plan revision and moves it to `approved`; approving a newer version then
marks any prior approved version `superseded`. Starting an implementation
atomically checks all three concurrency values and moves the approved version to
`locked`. Every terminal run moves that version back to `approved`, including a
revision request.

A version with successful passing verification remains labeled `approved` but
is permanently ineligible for another claim. A revision-requested version is
also `approved` and remains eligible only until a replacement draft becomes the
latest version; claims inspect the latest version rather than an older approved
one.

Drafting a replacement while the latest version is approved creates a new draft
without immediately superseding the prior approved version. The prior version
is superseded only when the replacement is approved.

These counters are separate from the Yjs epoch, document update sequence, and
storage commit revision described in [Architecture](architecture.md). Archiving
or restoring the document does not advance any collaboration, document, or
graph counter.

## Intended workflow

1. The team settles the plan and resolves its questions and comments.
2. The hosted Planner reads the latest plan and drafts a dependency graph.
3. A person reviews and approves that exact graph and plan revision.
4. A coding agent passes the canonical document URL, or its UUID, to
   `read_implementation` from the document's repository.
5. The agent verifies the repository, branch, and commit returned by Chopin
   against its checkout. The service does not inspect the checkout or resolve
   the original branch and commit against GitHub.
6. The agent uses the returned document UUID and revisions with
   `start_implementation`, which atomically claims the approved graph and creates
   one run ID.
7. The agent works only on dependency-ready tasks and reports their lifecycle.
8. Every task receives one reported pull request and completion summary, or
   completes as needing no code change.
9. An independent whole-graph review submits verification evidence for every
   task.
10. Passing verification releases the successful run. Failed verification
    returns named tasks to work. A scope or dependency change ends the run with
    `request_revision` and unlocks the same graph back to `approved`.

The Planner may then draft a replacement graph, but a revision request does not
itself supersede the old version and does not prevent that version from being
claimed again through MCP. The connector deliberately does not replay a picked-up
request. A failed pre-claim attempt can be explicitly retried from Build. A stopped
claimed attempt can be returned for changes through a durable revision request;
the next reviewed build is a new attempt, not an automatic session replay.

## MCP lifecycle tools

| Tool                   | Purpose                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `read_implementation`  | Read the approved graph, plan, and repository context by UUID or canonical URL.             |
| `start_implementation` | Claim that exact graph while reporting the coding agent's repository, branch, and commit.   |
| `start_task`           | Move one dependency-ready task to in progress.                                              |
| `block_task`           | Record a task blocker without releasing the graph lock; a queued task starts implicitly.    |
| `report_pr`            | Attach an open, merged, or closed pull request to a task.                                   |
| `complete_task`        | Complete a task after its pull request is recorded, or with `noChange` when none is needed. |
| `report_verification`  | Submit graph-wide review evidence and return failed tasks to work.                          |
| `request_revision`     | End the run when the plan, criteria, tasks, or dependencies must change.                    |

Every post-claim lifecycle report carries a caller-generated idempotency key.
`start_implementation` does not; the service creates a fresh run ID when it
accepts the claim. Accepted transitions persist before publication.

`block_task` on a queued task starts and blocks it in one step and skips the
dependency check `start_task` applies, so a blocker found before work began is
never lost even while the task's dependencies are unfinished. `complete_task`
on a task that is already complete is refused with `already-complete`; the
local connector answers it at once instead of retrying it as an out-of-order
call.

### Tasks that need no change

Some tasks turn out to need no code change, such as a verification task whose
code already satisfies it. `complete_task` completes one without a pull request
when the agent declares it:

```json
{
	"taskId": "verify-export",
	"summary": "The export already meets the criteria.",
	"noChange": {
		"reason": "The base commit already exports every field.",
		"evidence": "Ran `bun test export` in CI run 4821: **36 passed**, 0 failed."
	},
	"idempotencyKey": "complete-verify-export"
}
```

`reason` is at most 1,000 characters and `evidence`, Markdown saying what was
checked and its result, at most 5,000. Both are required and non-empty. A task
that already has a reported pull request refuses `noChange` with
`no-change-pull-request`, and a task completed this way refuses a later
`report_pr` with `no-change`. Once a review returns it to work, it can complete
again either way.

The task counts as complete for its dependents, which may start at once. With
no commit of its own, a dependent's base is the base this task started from: the
run's checkout, or the prerequisite pull requests this task itself built on.
Verification still needs evidence for the task but checks pull-request state
only for tasks that have one, and a run is delivered once every pull request it
has is merged; a run with none stays implemented. Build shows the task as done with **No change needed**, its
reason and its evidence, never as a pull request, and counts such tasks apart
from pull requests, as in "1 pull request, 1 task needed no change". Living
documents and rebuilds treat it as a completed task: it is not outstanding, and
a rebuild's `read_rebuild` lists it with its reason instead of a pull request.
The field is additive: the connector protocol and `plan:lifecycle` keep their
versions, and the task's `noChange` appears beside `summary` in progress. A
server from before this field cannot restore a lifecycle that records one, so
rolling back past it leaves such documents unopenable until it is rolled forward.

The readable URL is a locator for `read_implementation`; it is not a lifecycle
identity. `read_implementation` returns the stable UUID as `document.id`, and
`start_implementation` plus every task, pull-request, blocker, revision, and
verification call continues using that UUID.

Direct `read_implementation` remains available for an archived document.
`start_implementation` refuses it with `document-archived`, while reports for a
run that started before archival remain accepted under the normal run and graph
checks.

## Lock behavior

A queued or launching build freezes plan and decision edits before the MCP
claim. An active implementation locks the graph and prevents plan changes that would
invalidate the claimed work. Planner edits, new questions, and decision changes
that mutate the plan are refused until the implementation finishes or requests
revision. Progress and archived runs remain durable sidecar state.

The protocol defines a `plan:lifecycle` projection for active progress and run
history. `plan:implementation` invalidates the Build view's authenticated
snapshot after committed graph, build and lifecycle changes. It includes the
storage revision and current editing lock; `plan:open` supplies that lock on
reconnect even when the Build view is closed. The view refreshes when opened
or notified rather than polling every document in the background.

Archiving does not release an active graph lock or terminate its run. A coding
agent can continue reporting task, pull-request, blocker, revision, and
verification transitions while the document is archived. Permanent deletion is
terminal instead: it cascades the graph, execution, and lifecycle sidecar with
the channel, and later lifecycle reports return `document-unavailable`.

## Authorization

The external coding agent authenticates to `/mcp` with its own GitHub bearer
token. Pull access is sufficient to read documents and approved implementation
state. Push or administration access is required to claim a graph or report
lifecycle changes. The instance admission policy still applies.

The claim is logical rather than an exclusive caller identity. Lifecycle tools
authorize the current bearer by repository role and match the supplied run ID;
they do not require the original claimant's user, token, client, or session. Any
admitted repository writer who knows the active run ID can advance it.

`read_implementation` requires MCP creation metadata before exposing the graph
and repository provenance. `start_implementation` does not repeat that check; a
caller that somehow knows a browser-created channel's exact plan and graph
counters can invoke the claim directly. Treat read-before-claim as the supported
path, not an authorization guarantee.

This authorization is independent of the browser's GitHub App installation.
See [Local agent MCP](local-agent-mcp.md) and
[Authentication](authentication.md) for the two trust boundaries.

## Living documents (`LIVE_BUILD`)

With `LIVE_BUILD=on`, a delivered build makes its document live: later edits are
rebuilt onto the same pull requests by the builder's local agent. This is an
experimental prototype, and it runs a coding agent on someone's laptop without a
press, so its trust model is narrow on purpose.

- **Consent at pairing.** An automatic rebuild is dispatched only to a
  connection of the live build's own user, for the live build's repository,
  whose owner ticked **Let Chopin build and prototype automatically on this
  machine** when pairing it. The consent is held in memory with the connection.
  Without it the document stays out of sync until someone presses Build.
- **Writers trigger.** Only edits that persist through a path requiring push or
  administration access schedule a rebuild check: browser edits (every
  document-changing socket message requires write access), MCP
  `update_document`, and Planner or server work started by a writer. Viewers
  and pull-only MCP callers cannot cause one.
- **Document text is data.** The rebuild prompt presents the before and after
  sources as the change to implement, not as instructions to the agent.
- **Interrupted first builds never resume by themselves.** A first build goes
  live when its agent reports `stopped` with tasks outstanding. A failure,
  including the server's sweep of an expired or disconnected build, needs a
  person's Retry, because a task may have stopped mid-change.
- **Privacy.** Only the builder's snapshot names their checkout, the
  connection that ran a rebuild, and whether their agent is online.

A rebuild's run token reaches only `read_rebuild` and `report_rebuild`; a
build's run token cannot report a rebuild. A build's run token names its
document, build and kind, signed with a key derived from `SESSION_ENCRYPTION_KEY`,
so a restarted server can check it without storing it; the build's state still
decides whether it is accepted, so it ends with the build. See
[Trouble connecting](local-experiments.md#trouble-connecting) for how a build
resumes after a restart. A report repeated after the rebuild
landed returns the same success. The build history keeps 100 entries; ended
rebuilds give way oldest first so a long-lived document keeps rebuilding.

## Main implementation points

- Graph model and transitions: `apps/server/src/tasks/graphs.ts`
- Task and verification lifecycle: `apps/server/src/tasks/lifecycle.ts`
- Plan integration and durable publication: `apps/server/src/tasks/plan-graphs.ts`
- Hosted Planner graph tools: `apps/server/src/agent/tools.ts`
- Task draft requests: `apps/server/src/tasks/draft.ts` and `draftTasks` in
  `apps/server/src/chat/service.ts`
- Public MCP contract: `apps/server/src/mcp.ts` and
  `apps/server/src/mcp/lifecycle.ts`
- Wire projection: `packages/protocol/plan.d.ts`
