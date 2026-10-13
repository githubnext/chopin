# Local implementation tracer

**Build plan** launches an implementation through the same
[ACP connector used for investigations](local-experiments.md). Chopin displays
tasks, dependencies, blockers and per-task PR links. The connector claims the
approved graph before prompting the coding agent; a completed ACP turn is
separate from passing implementation verification.

## Connect a workspace

Authenticate an ACP-compatible coding agent normally, then connect a checkout
from its folder. [Bun](https://bun.sh) is required:

```sh
mkdir -p ~/.chopin \
  && curl -fsSL https://your-chopin-instance.example/connector.js -o ~/.chopin/connector.js \
  && CHOPIN_URL=https://your-chopin-instance.example \
    bun --no-env-file --config=/dev/null \
      ~/.chopin/connector.js connect . -- copilot --acp --allow-all
```

`--no-env-file` and `--config=/dev/null` stop Bun from loading the project folder's
`.env` and `bunfig.toml`: a checkout must not choose which server the connector pairs
with or run code through a `preload`. The `chopin` binary below ignores both by itself.

Open the printed pairing link, sign into Chopin, check that the page shows the
confirmation code printed in your terminal, and select **Connect**. Leave
**Let Chopin build and prototype automatically on this machine** unticked unless
you want Chopin to start work there by itself: rebuilds of a living document
(`LIVE_BUILD`) and, where enabled, prototypes. Without it, only work a person
presses Build or Run for reaches the laptop. The choice is stored with the paired
machine, so reconnecting keeps it and pairing again asks again. This is
the existing investigation pairing flow; one connection serves every document in
the checkout's repository. No GitHub bearer
needs to be configured in a second companion. Pairing stores a machine token
that outlives server restarts, deploys and browser sign-out, until the machine
is disconnected in the browser or unpaired with `chopin unpair`; see
[Connect a checkout](local-experiments.md#connect-a-checkout). See
[Trouble connecting](local-experiments.md#trouble-connecting)
for pairing problems, refusals and stale locks.

Keep the connector running. Each browser Build action starts an agent process;
automatically installing or starting the connector itself remains future work.
Standard ACP permission requests appear in its terminal with the command or
paths involved, and are declined when no interactive terminal is available.
The agent retains its normal tools, project instructions and configured
services.

### Install the chopin CLI

The connector is also released as `chopin`, one executable that needs no Bun.
Install it, then connect from the checkout's folder:

```sh
curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh | sh
CHOPIN_URL=https://your-chopin-instance.example \
  chopin connect . -- copilot --acp --allow-all
```

On Windows, install it in PowerShell with
`irm https://github.com/githubnext/chopin/releases/latest/download/install.ps1 | iex`.
`chopin connect` behaves exactly like the `bun` command above. Until the first
`cli-v*` release is published, the installers have nothing to download, and the
`curl` and `bun` command above remains the way to connect. See
[Install the chopin CLI](local-experiments.md#install-the-chopin-cli) for where
it installs, version pins and how the download is verified.

## Build a settled plan

1. Resolve planning questions and accepted comments awaiting document updates.
   Until then **Build plan** in the document header is inert and its tooltip
   says what is left.
2. Select **Build plan**. When the tasks are missing or older than the
   document, it asks the hosted Planner to draft them without posting a Chat
   message, then starts them without a separate review. See
   [drafting tasks from Build plan](implementation-lifecycle.md#drafting-tasks-from-build-plan).
3. The build runs on your own local agent: the server picks your idle
   connection for the repository, preferring the one that last ran work for this
   document, and derives the checkout from it. Without one, the header reads
   **Build stopped**, and Build says your local agent isn't connected and shows
   the connector command to run in your project folder; **Retry** tries again
   once connected. Approval persists the document and graph
   counters, checkout commit, connection and the person who started it, then
   freezes planning edits.
4. The **Build** tab turns on with the press. It shows the status and the
   tasks with their goals, acceptance criteria and dependencies; opening it
   never starts anything.
5. The connector creates an isolated worktree at that exact commit and an
   implementation branch, preserving existing local edits. It creates an ACP
   session and claims the graph before prompting the orchestrator.
6. The orchestrator is instructed to use sub-agents for independent ready tasks,
   integrate prerequisites and open small reviewable PRs linked to the document
   and task anchors. It owns all task and verification reporting.

The agent's run-scoped MCP connection exposes only `read_implementation` and the seven
existing lifecycle reporting tools. The run credential fixes the document and
run; those IDs are not agent-supplied arguments. The connector's credential
controls pickup and heartbeat. Investigations and implementations share the
same workspace busy check. The connector uses HTTP MCP when advertised by the
ACP agent, falling back to the stdio bridge otherwise. This also makes the
investigation tools available to Copilot ACP versions that reject stdio MCP.

The Build view loads a snapshot when opened and refreshes on document,
workspace and implementation notifications. It does not poll in the background
and occupies the same workspace pane as Document and Decisions. Leaving it does
not stop a run, and editing
locks continue to update through the document socket. A `#task-<id>` link opens
Build with that task expanded.

Duplicate Build requests from the same person for the same reviewed graph
return the same durable intent. A picked-up build is never automatically replayed.
Refresh retains task progress, blockers, session
identity and reported PRs. Expired connections or missing heartbeats mark tracked
builds as needing attention; after a server restart, opening the document tracks
its retained build again.

## Current limits and recovery

This slice uses ACP agents. It removes the separate Codex App Server launcher;
an agent without ACP support needs an adapter. Scheduling and sub-agent use are
orchestrator instructions, not a server scheduler. The opt-in live tracer checks
MCP reporting; it does not prove delivery of a complete multi-PR implementation.

New implementation decisions appear as task blockers. Configurable decision
policy, human resolution/resume controls, automatic connector startup and a
browser PR-creation action remain future work. Multiple reported PRs already
appear beside their tasks; Chopin never merges them automatically.

Inspect failures in the connector terminal and retained worktree. If startup
failed before the graph was claimed, **Retry** in the header creates a
new attempt. Repeating that retry request returns
the same attempt; it does not start duplicate work.

If a claimed run stops or fails, its graph remains locked. After inspecting the
retained checkout, choose **Return to planning**, enter a reason and confirm to
record a revision request and release the editing lock. **Build plan** then asks
the Planner to revise the tasks and builds the replacement.
This action is unavailable while the agent is still running; stop the connector
in its terminal first. An admitted
repository writer can also continue the existing lifecycle through ordinary
`/mcp`. The connector's run credential stops accepting reports when its turn ends.
Failure does not undo local edits, and these controls do not automatically resume
an interrupted agent session.

## Verification

```sh
bun run e2e e2e/implementation-launcher.e2e.ts e2e/connector.e2e.ts
```

The scripted ACP tests exercise real browser pairing, the production connector,
worktree creation, scoped MCP claims, persisted blockers and two reported PRs
through successful verification. GitHub responses and the ACP agent are fixtures;
they do not create real GitHub PRs.

Set `CHOPIN_TEST_ACP_COMMAND` to a JSON array containing your agent's ACP command
to enable the additional live test. It uses local credentials and model usage to
read the approved graph and report a blocker. It changes disposable test state
and does not implement code or create PRs.
