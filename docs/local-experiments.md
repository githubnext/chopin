# Local investigations

Chopin can delegate an investigation to an ACP-compatible coding agent on your
machine. The agent uses an exact checkout revision and its normal tools and
configuration, then returns a report and captured data. Chopin renders native
tables and charts, shares selections, and records decisions against fixed evidence.

## Connect a checkout

From your project folder, download the connector this Chopin server serves and
connect the checkout:

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

The Build view and an investigation card show this command with your server's
origin filled in when no local agent is connected. `GET /connector.js` serves one
bundled file with no sign-in; `bun run build` and the Docker image produce it, and
a development server bundles it from source. Chopin contributors can still run
`bun run connector connect /path/to/project -- copilot --acp` from a Chopin
checkout.

The command after `--` is your agent's ACP launch command. Chopin uses one ACP
client implementation; it does not invoke a vendor-specific SDK. The connector
requires [Bun](https://bun.sh) 1.4.2 and Git. The agent must support local stdio ACP sessions and
MCP tools through either advertised HTTP support or the default stdio transport. Authenticate the agent normally before connecting it.

The first time, the connector pairs this machine with Chopin. Open the printed
pairing link, sign into Chopin with push access to the checkout's repository,
check that the page shows the same confirmation code as your terminal, and
choose **Connect**. GitHub then authorizes the machine on its own, which takes
no extra step for an App you already authorized, and the page says
**Connected.** One connection serves every document in that repository; there
is no per-document pairing. Both the browser and connector contact the server
over outbound requests. The browser does not access your filesystem.

Pairing stores a machine token in `machine.json` in the connector's state
directory, readable only by you (mode `0600`; on Windows, your user profile's
permissions). The token is never printed. Chopin keeps only a hash of it, plus
the machine's own GitHub authorization encrypted like a browser login's. Later
`connect` commands, also after a server restart, a deploy or signing out of the
browser, use the stored token and do not pair again. On each connector call the
server rechecks your push access with the machine's own GitHub authorization.

A machine stays paired until you disconnect it: choose **Disconnect machine**
for it under **Your machines** at `/connect` and confirm, or run `chopin unpair` on the
machine. Either way its connector stops at once with `machine-revoked`, does
not retry, and deletes the token from `machine.json`. The next `chopin connect`
on a terminal then pairs again, as on a machine never paired; without a
terminal, as when run as a service, it stops with the same message instead of
waiting on a browser. GitHub allows ten active authorizations per account for an App. A
new sign-in or pairing beyond that silently retires the oldest one, which can be
a machine's. Chopin then marks that machine as needing pairing again
(`machine-reauthorize`) rather than revoking it, its connector stops and
forgets the token in the same way, and `chopin pair`, or `chopin connect` on a
terminal, authorizes it again. Under `AUTH_MODE=local`, which has no
client secret to authorize a machine with, connector calls instead use your
live browser login and wait while you are signed out.

The terminal prints the pairing link and confirmation code, then
**✓ Connected.** and a line for each job it starts, finishes or fails. Styling
appears only on an interactive terminal and is off under `NO_COLOR`. The agent's
own log output is hidden unless `CHOPIN_DEBUG=1`; its last lines are shown when a
job fails.

### Install the chopin CLI

The connector is also released as `chopin`, one executable for Linux, macOS
(x64 or arm64) and Windows (x64) that runs without Bun. Install it with:

```sh
curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://github.com/githubnext/chopin/releases/latest/download/install.ps1 | iex
```

Then, from your project folder:

```sh
export CHOPIN_URL=https://your-chopin-instance.example
chopin pair --label build-box      # once per machine; optional, connect pairs first if needed
chopin connect . -- copilot --acp --allow-all
```

Until the first `cli-v*` release is published, those install commands have
nothing to download, and the `curl … connector.js` and `bun` command above
remains the way to connect.

`chopin pair` pairs this machine and stores its token; `--label` names it in
Chopin (default: the hostname), and pairing again replaces the token.
`chopin connect` runs work exactly as `bun connector.js connect` does, pairing
first only when the machine has no token for that server, and `chopin` uses
`https://chopin.githubnext.com` when `CHOPIN_URL` is unset. `chopin unpair`
revokes the machine in Chopin and deletes its token. Every command takes
`--base-dir <dir>` (or `CHOPIN_HOME`) for where the token, locks and worktrees
live. `chopin --version` prints the CLI version and the connector protocol it
speaks, and `chopin help` lists the commands. The binary ignores any `.env` or
`bunfig.toml` in the folder it runs in.

The installer puts `chopin` in `~/.local/bin` (on Windows,
`%LOCALAPPDATA%\chopin\bin`, which it adds to your user PATH) and never needs
administrator rights. It installs the newest release unless you name a version,
either as an argument (`… | sh -s -- 0.2.0`) or with `CHOPIN_VERSION`. Before
installing, it checks the download against the release's `checksums.txt`, and,
when the [GitHub CLI](https://cli.github.com) is installed, runs
`gh attestation verify <file> -R githubnext/chopin` to confirm the release
workflow built it; `CHOPIN_VERIFY_ATTESTATION=0` skips that second check. When
`~/.local/bin` is not on your `PATH`, the installer prints the line to add to
your shell profile.

`chopin update` replaces the installed `chopin` with the release your Chopin
server recommends, which it reads from `CHOPIN_URL`'s
`/api/connector/version`. When the server cannot be reached, it says so and
installs the newest release instead. `chopin update 0.2.0` installs that
release. It verifies the download as the installer does, with `checksums.txt`
and, when `gh` is installed, `gh attestation verify`, then swaps the binary in
place and prints the old and new versions. On Windows the running `chopin.exe`
is renamed to `chopin.exe.old`, which the next `chopin` deletes. If an update
on Windows is interrupted and leaves only `chopin.exe.old`, run the installer
again to put a fresh `chopin.exe` in place. Updating to the version already
installed does nothing.

Moving to an older release than the installed one, whether named or
recommended, needs `--allow-downgrade`; without it `chopin update` prints the
command with the flag and changes nothing. On a terminal, `chopin update` asks
before replacing itself unless you pass `--yes`. Without a terminal, as in a
script, it goes ahead without asking: an upgrade needs no confirmation, and a
downgrade has already been confirmed by `--allow-downgrade`. Running the
installer again also updates `chopin`.

The connector sends its version and connector protocol when it pairs and on
every request. A server that does not speak that protocol refuses it with
`connector-update-required` and says what to run: `chopin update <version>`
with the release the server recommends, or downloading `connector.js` again for
the script. The connector prints that message and exits instead of retrying. A
`connector.js` from before this check sends no version; it is treated as
protocol 1, which predates machine pairing, and is told to download
`connector.js` again.

To build the binaries from a Chopin checkout instead, run
`bun run --cwd apps/connector build:binaries --host` for this machine, or
without `--host` for every target. They are written to `apps/connector/dist`:
`chopin-linux-x64`, `chopin-linux-arm64`, `chopin-darwin-x64`,
`chopin-darwin-arm64` and `chopin-windows-x64.exe`. See
[Releasing the chopin CLI](releasing-cli.md) for how releases are made.

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

Several people can connect checkouts of the same repository. Only a
connection's owner can start or cancel work on it. The server rechecks the
owner's repository push access on every connector call, and write access and
archive state on the target document whenever work is claimed or reported. An
investigation also requires that the document is not locked by an active build,
both when it is started and when it is claimed; a document archived or locked
in between interrupts the investigation instead of stalling the connector. A
build is itself that lock, so builds do not check it. Other document writers can inspect published results,
change shared selections, and record decisions.

The first authorized investigation supplies the document's default experiment
commit. Later runs use that recorded source baseline. The connector creates a
detached worktree and preserves existing local edits. Its local state defaults to
`$XDG_STATE_HOME/chopin/connector` or `~/.local/state/chopin/connector`; override it
with `--base-dir`, `CHOPIN_HOME` or `CHOPIN_CONNECTOR_STATE_DIR`. Worktrees are retained there for inspection.
Remove an unwanted worktree with Git's normal `worktree remove` command.

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
backoff, and its session and completion reports wait in memory, in order, until
Chopin answers. The connector stops the agent only when Chopin says the run is
over, after 10 minutes without reaching Chopin, or after two minutes in which
Chopin only said it no longer knows the connection. Ctrl-C stops the agent at
once and waits at most five seconds for Chopin to hear why. Chopin itself still ends a
run whose heartbeat it has not heard for about a minute, so after a longer drop
the agent stops as soon as the connector is back in contact. Permission prompts
are only ever answered in the connector terminal; a drop never answers one.

## Trouble connecting

**How pairing works.** An unpaired connector prints a link and an
eight-character code. Signing in at the link with push access, choosing
**Connect** after checking the code, and the GitHub authorization that follows
hand the machine a long-lived token. Each `connect` then registers the
checkout's repository, commit and branch with that token. One connector process
serves one checkout, and its connection serves every document in that
repository. The server forgets a connection 90 seconds after it last heard from
it; a running connector renews it continuously. Connections live in the server's
memory, but the machine does not: after a server restart or a deploy, a running
connector registers its checkout again with the machine token and carries on
without pairing, and a stopped one does the same when you start `connect` again.
A run that was going at the restart cannot go on: Chopin refuses it on the new
connection, so the connector stops its agent with **Chopin ended this run
(connection-forbidden).** and waits for the next work. When Chopin has answered
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
checkout. Use the `curl … connector.js` command above from your project folder.

**"Your local agent isn't connected" (HTTP 409 `no-workspace`).** No connector of
yours is connected for this document's repository. Start the command shown, open
its link, choose **Connect**, then press **Run** or **Build on my laptop** again.
Another person's connector never runs your work.

**Wrong repository, not a Git checkout, or a missing commit.** Run the command
inside a checkout whose `origin` remote is the document's github.com repository.
The connector refuses a checkout without a github.com origin, and a run whose
repository differs from the authorized one. If a run's recorded commit is not in
your checkout, the connector fetches it from `origin`; push or fetch the commit
if that fails.

**Connector version mismatch after a deploy.** Rerun the whole command. It
downloads the connector again, so it matches the server.

**Stale lock after a crash.** Each checkout has a lock in the connector's state
directory, `$XDG_STATE_HOME/chopin/connector` or `~/.local/state/chopin/connector`
(or `--base-dir`, `CHOPIN_HOME` or `CHOPIN_CONNECTOR_STATE_DIR`). A lock whose process has exited is replaced
automatically. If the connector still reports _Workspace already locked_, confirm
no connector is running for that checkout and delete the `.lock` file the error
names.

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
