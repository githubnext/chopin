# Local investigations

Chopin can delegate an investigation to an ACP-compatible coding agent on your
machine. The agent uses an exact checkout revision and its normal tools and
configuration, then returns a report and captured data. Chopin renders native
tables and charts, shares selections, and records decisions against fixed evidence.

## Connect a machine

Connect your machine with the `chopin` CLI, as
[Use your own machine with Chopin](chopin-cli.md) describes. It runs work for
documents in any repository you can push to, from a checkout you named with
`--checkout` or a clone it makes when work first needs one.

The command after `--` is your agent's ACP launch command. Chopin uses one ACP
client implementation; it does not invoke a vendor-specific SDK. The agent must
support local stdio ACP sessions and MCP tools through either advertised HTTP
support or the default stdio transport.

One connection serves every document in every repository its owner can push
to; there is no per-document or per-repository pairing. Under `AUTH_MODE=local`, which has no client secret to
authorize a machine with, connector calls use your live browser login instead
and wait while you are signed out.

`GET /connector.js` serves the connector as one bundled file with no sign-in;
`bun run build` and the Docker image produce it, and a development server
bundles it from source. Chopin contributors can still run
`bun run connector connect --agent copilot` from a Chopin checkout.

## Run chopin as a service

To keep a connection running in the background, and to start the Windows task
at boot, see [Keep it running](chopin-cli.md#keep-it-running) and
[Start the Windows task at boot](chopin-cli-reference.md#start-the-windows-task-at-boot).

## Run and inspect work

On any open line of the document, type `/` and choose **Investigate**, next to
**Research**. Write a brief in the composer that opens at the caret and choose
**Propose investigation**. Chopin creates the investigation and places an
`<Investigation id="…" />` card where the caret was, marked **Ready to run**. The
document holds only that id; the investigation record owns the brief, state and
result. Select **Run**:
the work runs on your own local agent, never on another person's. Chopin
prefers the connection that last ran work for this document, then your most
recently active one that is not busy. When all of yours are busy, the work
queues behind one of them and starts when it is free. Without any, the card shows the connector command to start, and you select
**Run** again once connected. A Planner can also propose an investigation. It
names the block the investigation concerns by index and digest, and its card
goes directly after that block. When the block has changed, or its digest now
matches more than one block, the card goes at the end of the document instead
of guessing, and the Planner is told. Either way it still needs someone to run
it. Progress appears in that card automatically, without opening another tab or
dialog. A completed investigation is published as a child document, like a
research report, and its card becomes a compact link to it.

The card is atomic, like a research card: it can move with the prose around it,
but its markup only ever names the record. When a browser adds a card, the server
accepts it only if that id belongs to an existing investigation in the same
document; a card naming any other id is refused. The Planner's document edits
cannot add, move or remove one. Removing a **Ready to run** card withdraws the
investigation first, so no record is left without its card. A failed, stopped or
interrupted card can be removed directly. Running and completed investigations
keep their card.

Several people can connect machines for the same repository. Only a
connection's owner can start or cancel work on it. The server renews the
machine's GitHub authorization and rechecks its owner's admission on every
connector call, and the owner's push access and archive state on the target
document whenever work is claimed or reported. An
investigation also requires that the document is not locked by an active build,
both when it is started and when it is claimed; a document archived or locked
in between interrupts the investigation instead of stalling the connector. A
build is itself that lock, so builds do not check it. Other document writers can inspect published results,
change shared selections, and record decisions.

Each new investigation uses the commit of the checkout the selected machine
named for the document's repository, or else the head of the repository's
default branch on GitHub, which the machine clones or fetches. Retrying an
investigation keeps its original source commit, even after the connection changes.
Other investigations in the document do not choose its baseline. The connector creates a
detached worktree and preserves existing local edits. Its local state defaults to
`$XDG_STATE_HOME/chopin/connector` or `~/.local/state/chopin/connector`; override it
with `--base-dir`, `CHOPIN_HOME` or `CHOPIN_CONNECTOR_STATE_DIR`. Worktrees are retained there for inspection.
Remove an unwanted worktree with Git's normal `worktree remove` command.

Manual investigations can upload up to three distinct screenshots, at most 1 MiB each.
The agent saves PNG, JPEG or WebP files in its worktree and calls `upload_image_file({path})`.
The connector refuses paths outside that worktree, including symlinks. The agent embeds the
returned hosted paths as Markdown images in the submitted report. The run-scoped server tool
is `upload_investigation_image`; the connector handles reading and encoding the local file.

Local execution uses the agent's ordinary OS permissions, skills and configured
services. A worktree organizes edits; it is not a sandbox. Standard ACP permission
requests appear in the connector terminal with the tool kind and the command,
paths or input involved, and are declined when no interactive terminal is
available. Choosing an "always allow" option skips later prompts for that tool
kind until the connector exits. The connector does not advertise client-hosted filesystem
or terminal tools; supported agents execute their own local tools.

The connector chooses HTTP MCP when the ACP agent advertises it and otherwise
uses its stdio bridge. Both transports expose the same investigation operations;
HTTP also retains the connector's internal `read_experiment` and
`submit_experiment_result` names.

The agent reads its sealed brief and output schema through `read_investigation`,
then calls `submit_investigation_result`. The server validates the candidate,
including that it converts into a valid child document, and publishes only after
the ACP turn completes successfully. A report may not contain record-backed
components such as `Investigation`, `Experiment`, `Research` or decisions. Published data remains
available when the laptop disconnects. A model's interpretation and a measured
observation remain distinct; reports should explain their method and limitations.

## Results and decisions

A Planner proposal may mark an investigation as required before building and
explain the specific dependency. Its card shows that reason, and Build names and
reveals the card. Optional investigations do not block Build. Failure, interruption
and stopping execution retain the requirement so it can be retried. Removing an
unstarted proposal withdraws the requirement. Completed required evidence remains
blocking until the Planner incorporates its findings and creates any necessary
human decision cards; it then clears the investigation's reason. These reviews run
under the existing Planner owner, without starting local work. If a review fails or
is interrupted, select **Apply findings** on the completed card to start a fresh
Planner request.

Results contain restricted document MDX, typed datasets, native view specifications
and small text evidence. Supported views are tables, metric comparisons, bars and
simple lines. The capability response advertises size limits and schemas. No
uploaded UI code or live application endpoint is accepted.

Completion promotes the candidate and creates the child document in one fenced
commit, so the card never links a child that does not exist; a repeated
completion returns the same child. The child is titled by the report's top
heading, or else the brief, and holds the report, an `<Experiment>` embed for each
view, the method and limitations, and as much raw evidence as fits the document
size limit. Its provenance line names the parent document, who started the
investigation and the brief. A child has no investigations or Build of its own:
the server refuses to create, place or publish one there.

As with Research, publication makes both documents permanent while the record
links them. The parent cannot be deleted while it has the child, and the child
cannot be deleted while the investigation record names it; either can still be
archived.

The child's embeds read the parent's investigation record by its id, so shared
filters and row selections stay one collaborative state wherever they appear.
They are revision-checked; a stale edit reports a conflict. **Record decision**
under an embed saves the exact acknowledged selections, conclusion and rationale.
Recorded decisions appear on the parent's investigation card and in its Decisions
surface, where **Insert decision evidence in document** embeds that immutable view.

An interrupted run is not automatically repeated. **Retry** on a failed,
stopped or interrupted card returns the same investigation to **Ready to run**;
someone then selects **Run** again. The old claim stays fenced by its generation.
Ctrl-C, including at a permission prompt, reports running work as stopped from
the connector terminal, then withdraws the connection; a second Ctrl-C exits at
once. When the connector disconnects, Chopin fails its builds and rebuilds and
interrupts its investigations immediately; a connector killed without warning
is noticed within about 90 seconds. When a job ends for any reason, the
connector stops the agent's process group and any background process still
running in the job's worktree, such as a dev server the agent started. Terminal
shells opened in the worktree are left alone. After a connector crash, its local
lock remains to prevent
uncertain duplicate execution; confirm no connector is running before removing the
lock identified by the error message.

A network drop or a server restart does not end the connector. It reconnects
at once when a working connection fails, then retries after a random delay
below 1, 2, 4 … seconds, at most 5 minutes apart, and starts that ladder over
once a connection has stayed up for a minute. An attempt to connect or
register that gets no answer in 15 seconds, as while the network is down,
counts as failed, so the retries go on through an outage. The terminal says when the
connection is lost and why, as Chopin's error code, an HTTP status such as
`HTTP 502`, or a network error such as `ECONNRESET`, announces the first few retries, and says **Reconnected.**
when it is back. It stops instead of retrying when Chopin refuses the machine,
requires a newer connector, or the owner has lost push access to the repository.

A running agent keeps working through a drop. Its heartbeat retries on the same
backoff, but never waits longer than its usual 10 seconds between tries, and its
session and completion reports wait in memory, in order, until
Chopin answers. The terminal says **Lost contact with Chopin**, then, at most
every 10 seconds while it lasts, **Still trying to reach Chopin (attempt 4,
40 s, HTTP 502), the run keeps going.** with the retry's number, how long Chopin
has been out of reach, and the failure's HTTP status or error code alone, never
its message, and **Back in contact with Chopin after 47 s.** when it answers
again. The connector stops the agent only when Chopin says the run is
over, after 10 minutes without reaching Chopin, or after two minutes in which
Chopin only said it no longer knows the connection. Ctrl-C stops the agent at
once and waits at most five seconds for Chopin to hear why. Chopin itself still ends a
run whose heartbeat it has not heard for about a minute, so after a longer drop
the agent stops as soon as the connector is back in contact. Permission prompts
are only ever answered in the connector terminal; a drop never answers one.

## Trouble connecting

**How pairing works.** An unpaired connector prints a link and an
eight-character code. Signing in at the link with push access, choosing
**Add machine** after checking the code, and the GitHub authorization that follows
hand the machine a long-lived token. Each `connect` then registers the machine
with that token, naming the repository, commit and branch of each checkout given
with `--checkout`. One connector process runs for a state directory, and its
connection serves every document in every repository its owner can push to. The
server forgets a connection 90 seconds after it last heard from it; a running
connector renews it continuously. Connections live in the server's memory, but
the machine does not: after a server restart or a deploy, a running connector
registers again with the machine token and carries on
without pairing, and a stopped one does the same when you start `connect` again.
The connector also registers again, mid-run, when one of its requests fails
on the way (a long poll cut by a proxy, a timeout, a 5xx answer); the terminal says
**Lost the connection to Chopin during a run** and **Registered this machine with
Chopin again**. A build carries on through that: its next heartbeat comes on the
new connection of the same paired machine and owner, and Chopin moves the build,
and the agent's run credential, to it. A connection of any other machine, or of
another person, is still refused (`build-forbidden`).

A build also goes on through a server restart or a deploy. Its heartbeat and
reports name the document (connector protocol 6, chopin 0.0.16 and later), so
the restarted Chopin finds the build in the document and hands it to the new
connection of the same paired machine and owner, as above. The agent's run
credential is signed with a key derived from the deployment's
`SESSION_ENCRYPTION_KEY` rather than kept in memory, so Chopin checks it again
after the restart, accepts it only for the connection that now holds its build,
and refuses it once the build has ended. Until the machine is back, the agent's
calls are answered `unavailable` (HTTP 503) with a request to retry. Chopin
waits 10 minutes after it starts for the machine to come back
(`CHOPIN_BUILD_RESUME_MS`, see [Self-hosting](self-hosting.md#runtime-configuration)),
as long as the connector keeps its agent running without reaching Chopin, so a
slow deploy or a host reboot does not end the build. Once the machine has
registered again, it has a minute to carry the build on, as a connector still
running it renews it within seconds; a build it has not taken back by then ends
as **your local agent stopped responding**. A build whose machine never comes
back ends as **your local agent disconnected** when the window passes, once
someone opens the document or the agent calls Chopin. The window, the agent's
`unavailable` answers and the machine taking the build back follow the same
rule, so they never disagree. A build that ended before the restart stays ended
(`build-inactive`).

A build claimed by an older connector, or by a server without this change,
cannot go on, as Chopin cannot find it again: the connector stops its agent with
**Chopin restarted, so it ended this run.** (an older connector says **Chopin
ended this run (server-restarted).**) and waits for the next work, and Build
says **Build stopped — Chopin restarted.** Build says **your
local agent disconnected** only when the machine has no connection left, and
**your local agent stopped responding** when its heartbeat stopped while the
machine stayed connected. When Chopin has answered
only that it does not know the connection (`connection-unavailable`, or HTTP 401)
for two minutes, the connector stops any running agent, reports why, and exits
with **Chopin no longer recognizes this
connection (it may have restarted).** Run the connect command again. Network
errors and 5xx answers do not count; the connector keeps retrying those.

**"This machine is no longer paired" (`machine-revoked`) or "GitHub no longer
accepts this machine's authorization" (`machine-reauthorize`).** The machine was
disconnected in the browser or unpaired, or GitHub retired its authorization.
The connector has deleted the refused token. Run `chopin connect` again on a
terminal, which pairs first, or `chopin pair` and then connect.

**`script not found: connector`.** `bun run connector` only works inside a Chopin
checkout. From your project folder, use `chopin connect` or the `connector.js`
command in [Run without installing](chopin-cli-reference.md#run-without-installing).

**"Your local agent isn't connected" (HTTP 409 `no-workspace`).** No connector of
yours is connected. Start the command shown, open
its link, choose **Add machine**, then press **Run** or **Build on my laptop** again.
Another person's connector never runs your work.

**Wrong repository, not a Git checkout, or a missing commit.** A `--checkout`
must be a clone whose `origin` remote is a github.com repository; the connector
refuses one without, and a run whose repository differs from the authorized one.
If a run's recorded commit is not in the checkout, the connector fetches it from
`origin`; push or fetch the commit if that fails. A repository with no checkout
named is cloned into `repos/<owner>/<repo>` in the state directory, which needs
the GitHub token Chopin gives machines; without one the run fails with
`This machine has no checkout of <owner>/<repo>`.

**Connector version mismatch after a deploy.** Run `chopin update`, or rerun the
whole `connector.js` command, which downloads the connector again so it matches
the server.

**Stale lock after a crash.** The connector holds a lock in its state
directory, `$XDG_STATE_HOME/chopin/connector` or `~/.local/state/chopin/connector`
(or `--base-dir`, `CHOPIN_HOME` or `CHOPIN_CONNECTOR_STATE_DIR`). The lock
records when its connector's process started. A lock whose process has exited
is replaced automatically, even when another process has since been given the
same pid: a process with that pid that started at another time is not the
connector. If the connector still reports that the state directory _is already
locked by a running connector_, confirm no connector is running and delete the
`.lock` file the error names.

**Permission prompts.** Each prompt names the tool kind and what it will run or
touch. Choose an "always allow" option to stop prompts for that kind during this
run, or pass the agent's own auto-approval flag after `--`, such as Copilot's
`--allow-all`.

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

## Prototype spikes (`LIVE_SPIKES`)

With `LIVE_SPIKES=on`, a document that has no living build yet can prototype an
uncertain passage on its own. After an editor's edits settle, the server asks
Jev whether a quick prototype would inform each passage that editor changed;
with a yes it starts a spike on that editor's local agent and places a
`<Callout>` under the passage that tracks it ("Prototype queued",
"Prototyping…", then the result or "Prototype stopped"). Deleting the callout
stops the spike, and that passage is not spiked again.

The trust model is deliberately narrow:

- **Consent.** A spike runs only on a machine whose owner ticked **Let Chopin
  build and prototype automatically on this machine** when pairing it, and only
  for passages that person changed. Another editor's text never runs on
  someone else's agent.
- **Judge.** Without Jev nothing is spiked. `LIVE_SPIKES_REGEX_JUDGE=on` opts
  into matching explicit uncertainty words instead.
- **Limits.** At most three spikes run per document at once, six start per
  document and ten per editor in an hour, and a spike still running 20 minutes
  after its claim is interrupted.
- **Text is data.** The brief, the passage and the document context are framed
  as untrusted text describing what to prototype, not as instructions.
- **Throwaway work.** The connector runs a spike in a fresh worktree on a
  `chopin/spike-*` branch under Git configuration that refuses every push, and
  removes the worktree and branch when the run ends.
- **Locks.** A spike's callout never lands while a build holds the document,
  including a first build that is only queued: the approved tasks stay bound to
  the revision people approved, and the finding lands after the build ends.

When a result lands, Chopin asks the Planner to settle the passage the spike
answered. Nobody typed that turn, so it never claims a Planner owner: it runs
only under the document's existing owner and, under `HARNESS=remote`, only
while a Planner is attached. Until then the settle stays pending, and an owner
appearing or a Planner attaching runs it; a child document's settle is
dropped. Under `HARNESS=atomic` the turn is a full Atomic session with the
operator's shell and filesystem tools, reading the callout's report, which the
spike's agent wrote from collaborators' text; the instruction treats it as data,
but operators should weigh that exposure before enabling `LIVE_SPIKES` there.

A spike run's MCP tools are `read_investigation`, `upload_investigation_image`
(at most three distinct images, each at most 1 MiB) and `submit_spike_result`
(a headline, three to six findings, a recommendation and the uploaded image
paths, which the server turns into the report). It cannot submit an
investigation or experiment result. The connector adds a local
`upload_image_file({path})` tool that reads an image inside the spike's worktree
and forwards it, so the agent passes a path rather than the image's bytes.
