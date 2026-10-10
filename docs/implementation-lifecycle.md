# Experimental implementation lifecycle

One current planning-specific workflow hands a document used as a settled plan
to an external coding agent. It persists a versioned dependency graph, lets a
coding agent claim an approved version, records task and pull-request progress,
and requires graph-wide verification before releasing a successful run. The
ordinary MCP read-before-claim path accepts MCP-created documents. Browser plans
use the owner-paired ACP connector and its run-scoped bridge; see the
[local implementation tracer](local-launcher.md).

The web application can prepare tasks through the Planner, review and approve
the graph, queue a local ACP session, and display task progress, dependencies,
blockers and PR links. This is a thin live tracer: decision resolution during
implementation, automatic restart and an installer remain future work.

## Actors

- The **hosted Planner** reads the current plan and drafts or revises tasks with
  `read_implementation_graph` and `edit_implementation_graph`.
- A **person** is the only actor allowed by the domain model to approve a draft.
  The browser's “Build on my laptop” action approves the exact reviewed
  graph and queues its assigned paired workspace in one durable commit.
- The **local connector** creates an exact-commit worktree and ACP session, then
  claims a browser-approved graph before prompting the orchestrator. Its scoped
  bridge fixes document and run identity for lifecycle reports.
- A **coding agent** may also connect through `/mcp`, read an approved graph, and start
  one logical implementation run. The run is not authorization-bound to that
  caller after it starts.

The [implementing-chopin-plans skill](../skills/implementing-chopin-plans/SKILL.md)
adds provider-neutral local work practices. The MCP initialization instructions
and current tool descriptions remain authoritative.

## Drafting tasks from Build

Opening Build sends `implementation:draft` when the document has no tasks, its
tasks were drafted for an earlier revision, or its last build was returned for
changes. The browser asks at most once per visit, only for the need its first
read saw, and never while the Planner is already in a turn; a later document
change shows **Update tasks** instead.

The server rechecks write access and the room exactly as for a Chat message to
the Planner, refuses a child document, unresolved decisions or accepted
comments, and an active implementation, then writes the instruction itself from
the plan. No member message is posted: Chat records a system line saying who
asked, as it does for an accepted comment, and the turn runs under the asker's
login for Planner ownership like any member turn. The notice is persisted
before the turn starts or queues. A queued draft is not shown in the Chat
queue.

At most one draft per document is live, whatever revision it was asked for,
because its instruction reads the latest document. A request while a draft is
queued or running returns that draft (`existing: true`), so collaborators
opening Build together start one turn. Requests share Chat's send and queue
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
8. Every task receives one reported pull request and completion summary.
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

| Tool                   | Purpose                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `read_implementation`  | Read the approved graph, plan, and repository context by UUID or canonical URL.           |
| `start_implementation` | Claim that exact graph while reporting the coding agent's repository, branch, and commit. |
| `start_task`           | Move one dependency-ready task to in progress.                                            |
| `block_task`           | Record a task blocker without releasing the graph lock.                                   |
| `report_pr`            | Attach an open, merged, or closed pull request to a task.                                 |
| `complete_task`        | Complete a task after its pull request and summary are recorded.                          |
| `report_verification`  | Submit graph-wide review evidence and return failed tasks to work.                        |
| `request_revision`     | End the run when the plan, criteria, tasks, or dependencies must change.                  |

Every post-claim lifecycle report carries a caller-generated idempotency key.
`start_implementation` does not; the service creates a fresh run ID when it
accepts the claim. Accepted transitions persist before publication.

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
