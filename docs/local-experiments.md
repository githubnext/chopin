# Local investigations

Chopin can delegate an investigation to an ACP-compatible coding agent on your
machine. The agent uses an exact checkout revision and its normal tools and
configuration, then returns a report and captured data. Chopin renders native
tables and charts, shares selections, and records decisions against fixed evidence.

## Connect a checkout

Install the Chopin workspace with `bun install`. From its root, run:

```sh
CHOPIN_URL=https://your-chopin-instance.example \
  bun run connector connect /absolute/path/to/project -- copilot --acp
```

The command after `--` is your agent's ACP launch command. Chopin uses one ACP
client implementation; it does not invoke a vendor-specific SDK. The connector
requires Bun 1.4.2 and Git. The agent must support local stdio ACP sessions and
MCP tools through either advertised HTTP support or the default stdio transport. Authenticate the agent normally before connecting it.

Open the printed pairing link, sign into Chopin with push access to the
checkout's repository, and choose **Connect**. One connection serves every
document in that repository; there is no per-document pairing. Both the browser
and connector contact the server over outbound requests. The browser does not
access your filesystem.

The connector credential is held in memory and tied to your browser login.
Connector grants are deliberately process-bound even though hosted browser
sessions can survive releases. Reconnect after a server restart or logout.

## Run and inspect work

At the end of the document, choose **Propose investigation** and enter a brief.
The request appears as an inline card marked **Ready to run**. Select **Run**:
the work runs on your own local agent, never on another person's. Chopin uses
your most recently active connection for the repository that is not already
busy. Without one, the card shows the connector command to start, and you select
**Run** again once connected. A Planner can also propose an investigation; its
card still needs someone to run it. Progress and published results appear in
that card automatically, without opening another tab or dialog.

Several people can connect checkouts of the same repository. Only a
connection's owner can start or cancel work on it. The server rechecks the
owner's repository push access on every connector call, and write access,
archive state and the implementation lock on the target document when work is
started and claimed. Other document writers can inspect published results,
change shared selections, and record decisions.

The first authorized investigation supplies the document's default experiment
commit. Later runs use that recorded source baseline. The connector creates a
detached worktree and preserves existing local edits. Its local state defaults to
`$XDG_STATE_HOME/chopin/connector` or `~/.local/state/chopin/connector`; override it
with `CHOPIN_CONNECTOR_STATE_DIR`. Worktrees are retained there for inspection.
Remove an unwanted worktree with Git's normal `worktree remove` command.

Local execution uses the agent's ordinary OS permissions, skills and configured
services. A worktree organizes edits; it is not a sandbox. Standard ACP permission
requests appear in the connector terminal and are declined when no interactive
terminal is available. The connector does not advertise client-hosted filesystem
or terminal tools; supported agents execute their own local tools.

The connector chooses HTTP MCP when the ACP agent advertises it and otherwise
uses its stdio bridge. Both transports expose the same investigation operations;
HTTP also retains the connector's internal `read_experiment` and
`submit_experiment_result` names.

The agent reads its sealed brief and output schema through `read_investigation`,
then calls `submit_investigation_result`. The server validates the candidate and
publishes only after the ACP turn completes successfully. Published data remains
available when the laptop disconnects. A model's interpretation and a measured
observation remain distinct; reports should explain their method and limitations.

## Results and decisions

Results contain restricted document MDX, typed datasets, native view specifications
and small text evidence. Supported views are tables, metric comparisons, bars and
simple lines. The capability response advertises size limits and schemas. No
uploaded UI code or live application endpoint is accepted.

Shared filters and row selections are revision-checked. A stale edit reports a
conflict. **Record decision** saves the exact acknowledged selections, conclusion
and rationale. **Insert decision evidence in document** embeds that immutable view;
**Insert view in document** embeds the current collaborative selections. Evidence
decisions also appear in the document's Decisions surface.

An interrupted run is not automatically repeated. **Propose retry** creates a new
request requiring owner authorization. Ctrl-C withdraws the connection and stops
managed agent processes. After a connector crash, its local lock remains to prevent
uncertain duplicate execution; confirm no connector is running before removing the
lock identified by the error message.

## Development verification

```sh
bun test packages/experiment apps/connector apps/server/src/experiments
bun run e2e experiments.e2e.ts connector.e2e.ts --project=chromium
CHOPIN_TEST_ACP_COMMAND='["copilot","--acp","--no-auto-update"]' \
  bun test apps/connector/src/acp.test.ts --test-name-pattern 'real ACP'
```

The opt-in final command makes a real model request using the agent's existing
authentication. Normal tests use a scripted ACP process. See the optional
[investigation skill](../skills/local-investigations/SKILL.md) for output guidance.
