# Working on Chopin

Chopin is an experimental collaborative authoring system: several people and a
hosted agent share one rich, repository-connected document. Plans are one
document workflow, not the product boundary. Read
[README.md](README.md) for the product framing and [Architecture](docs/architecture.md)
before changing cross-package behavior.

Before changing UI or interface copy, read the [design guidance](apps/web/DESIGN.md).
Design jigs are temporary local artifacts. Keep them out of commits and pull requests.

The most useful technical references are:

- [Authentication and authorization](docs/authentication.md)
- [Repository channels](docs/channels.md)
- [Storage and persistence](docs/storage.md)
- [Hosted agent (Planner)](docs/hosted-agent.md)
- [Agent connection](docs/agent-connection.md)
- [Background jobs and workers](docs/background-jobs.md)
- [Experimental implementation lifecycle](docs/implementation-lifecycle.md)
- [Adding an assistant-ui element](docs/assistant-ui.md)
- [Self-hosting](docs/self-hosting.md)
- [Deploys nobody can see](docs/zero-downtime-deploys.md)

## Commands

```bash
bun install             # install the workspace
bun run dev             # Vite and Bun development supervisor
bun run dev:exe         # exe.dev proxy and HMR mode
bun run db:up           # start the local PostgreSQL service
bun run db:down         # tear down the local Compose project
bun run migrate         # apply PostgreSQL migrations
bun test                # unit, domain, and memory-adapter tests
bun run test:postgres   # PostgreSQL contract and lifecycle tests
bun run e2e             # Chromium system integration suite
bun run e2e:ui          # Playwright UI mode
bun run e2e:browsers    # install Chromium once
bun run types           # TypeScript checks across packages and E2E
bun run ci              # dprint, oxlint, and token checks
bun run fix             # format and apply safe lint fixes
bun run build           # build the web client
bun run start           # start the server; build and migrate first
bun run docker:up       # build and start app plus PostgreSQL locally
bun run docker:down     # tear down the local Compose project
```

The repository pins Bun 1.4.4. `mise.toml` selects that version automatically for
contributors who use [mise](https://mise.jdx.dev); run `mise install` once. Keep
the package metadata, `mise.toml`, Docker image, CI, and documentation
synchronized when changing it.

`bun run e2e` starts four disposable PostgreSQL services, migrates them, builds
the client, starts applications on ports 8788 and 8789 with `AGENT=off`, and an
isolated `AGENT=on` fake-harness server on 8792 (with its fake GitHub MCP server
on 8797) alongside them, then runs Chromium. The local-auth test starts its own
application on port 8791 against the fourth database. Set `E2E_SKIP_BUILD=1`
only when the existing client build is known to match the checkout.

CI starts every job at once: format, lint and types on one runner; unit tests in
three shards balanced by `.github/bun-test-timings.json`; the PostgreSQL contract;
browser integration in twelve shards balanced by `e2e/shard-timings.json`; the
design and diagram suites; a Docker image build; and the `chopin` CLI binary
build with its bridge smoke test (whose Windows binary is then started once on
Windows, where `install.ps1` is also tested). The required checks
`format, lint, types, tests` and `e2e` are gates over those jobs. The timings
files only balance shards; a missing or stale entry never drops a test. Browser
shards reuse a client build cached on a hash of its sources. A
documentation-only change should still pass `bun run ci`.

Before opening a PR or repairing CI, use the repository's
[PR readiness skill](.agents/skills/chopin-pr-readiness/SKILL.md).

## Repository map

| Area                  | Responsibility                                            | Internal workspace dependencies                                                    |
| --------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/dialect`    | Restricted MDX, MDAST, and Lexical schema                 | none                                                                               |
| `packages/protocol`   | WebSocket declarations and addressing helper              | none                                                                               |
| `packages/agent-link` | Agent connection messages, schemas and test client        | none                                                                               |
| `packages/question`   | Questionnaire definitions and shared drafts               | `protocol`                                                                         |
| `packages/draft`      | Bounded collaborative plain-text drafts                   | none                                                                               |
| `packages/viewport`   | Browser geometry and subscriptions                        | none                                                                               |
| `packages/diagrams`   | Bounded diagram rendering and scoped React viewing        | `icons` (React peer)                                                               |
| `packages/experiment` | Investigation result schemas, selections and native views | `diagrams` (React peer)                                                            |
| `apps/connector`      | Local ACP client and run-scoped MCP bridge                | `experiment`, `protocol`                                                           |
| `packages/editor`     | Collaborative editor, decisions, comments, and widgets    | `diagrams`, `dialect`, `experiment`, `question`, `protocol`, `viewport`            |
| `apps/server`         | Auth, channels, rooms, storage, Planner, MCP, tasks       | `agent-link`, `diagrams`, `dialect`, `draft`, `experiment`, `question`, `protocol` |
| `apps/web`            | Repository picker, navigation, conversation, workspace    | `dialect`, `diagrams`, `draft`, `editor`, `experiment`, `protocol`, `viewport`     |
| `e2e`                 | Browser and system integration harness                    | may import server internals as fixtures                                            |

Runtime workspace packages do not depend on an application. E2E and skill
contract tests may deliberately import server internals; do not treat those test
harnesses as runtime package boundaries.

## Runtime model

The browser edits Lexical bound to Yjs. One WebSocket multiplexes session,
document (`plan:*` on the wire), conversation, questions, comments, and
implementation lifecycle messages; the Projects sidebar's own `/ws/sidebar`
socket carries decision counts and says when a repository's documents change. The server keeps each open channel as an
authoritative Y.Doc with a headless Lexical mirror so it can validate and
serialize the document without trusting a browser.

Human updates are grouped for 5 ms, applied, projected to canonical MDX,
validated, and committed with sidecar state before acknowledgement or relay. An
invalid Yjs batch cannot be undone; the room rebuilds the latest known-good
state under a fresh epoch and clients reopen.

The Planner reads a plan revision and edits through structural block operations.
Operations stage against MDAST, pass dialect and Lexical round-trip validation,
reconcile into the live tree, and produce one Yjs delta. Unchanged or moved
MDAST object identity preserves existing Lexical nodes, selections, and undo
history.

PostgreSQL is the only runtime storage adapter. One renewable `chopin:writer`
lease permits one application process per database. A second process started with
`HANDOVER=wait` waits beside the holder in standby, reading the lease without a lock,
and takes it when the holder's cut releases it; only the holder serves.
[Deploys nobody can see](docs/zero-downtime-deploys.md) gives the order and the proxy
it needs. Hosted browser sessions use encrypted credentials in PostgreSQL and restore
on presentation of the browser cookie. Startup clears Planner ownership, except a
remote Planner's persisted hand-over hold, and metadata-only local sessions;
collaborative state, saved Planner requests and external implementation runs are
durable.

## Authority and security

- **The dialect is an allowlist.** Document MDX is parsed and rendered, never
  evaluated. Keep imports, exports, expressions, raw HTML, and unknown JSX out.
- **Records own decisions.** Question answers and accepted comment decisions live
  in sidecar records. Their document components are projections. Browser CRDT
  validation allows unchanged projections to move but rejects their creation,
  removal or alteration. Domain operations update records and projections together;
  do not treat the projection as authority.
- **Admission is not authorization.** Optional user and organization lists admit
  an identity. Browser routes, sockets, and Planner tools separately recheck the
  App installation and repository role.
- **MCP has a different credential boundary.** `/mcp` checks its caller-supplied
  GitHub bearer directly, does not require the App installation, and can mutate
  data for callers with push or administration access.
- **Planner ownership is process-bound.** The first eligible Planner or
  model-backed research request supplies its GitHub App token and Copilot
  entitlement. Server-authored turns nobody typed (re-linking decisions after a
  build, settling a prototyped passage) never claim an owner; under
  `HARNESS=remote` they also wait for an attached Planner. The database stores only a token-free owner reference and durable
  context.
- **Planner tools are repository-fixed under `copilot-sdk`.** That
  Planner has no shell, checkout, host filesystem, skills, plugins, or arbitrary
  GitHub access. `HARNESS=atomic` deliberately runs every Planner session, local
  or hosted, as a full Atomic session with the operator's Atomic tools and
  resources, including shell and filesystem access as the server process's user.
  Its working directory is a checkout verified from `invoke_planner` and
  remembered per channel in memory, or else an empty per-channel directory. Its
  summary and research workers stay isolated. There is no flag for this; the
  harness is the choice.
- **`HARNESS=remote` moves the model, not the authority.** Turns run in a client
  attached at `/api/v1/agent` with a GitHub bearer and push access; Chopin's
  host tools, Decisions, and room writes still run in the server. The attached
  client sees what a turn sees and steers its document writes. Attaching makes
  the account's live browser login the document's Planner owner, one client per
  document; nothing else claims ownership. `@chopin` and `invoke_planner` on a
  document without one are saved as durable rows, shown as sent and delivered
  when a Planner takes them, also under `AUTH_MODE=local`. Signing out the
  owner's login, its expiry, or a Planner reset closes the link. A lost
  connection never ends work by itself: a link that offered
  `resumable-sessions` and then dropped unexpectedly keeps its sessions that hold
  a live run or an open question, however long it stays away, and holds any Stop
  pressed meanwhile or still unanswered when it dropped for its client's return.
  Run cards say the Planner is disconnected, not stopped; Decisions stay open and
  answerable; answers and cancellations made meanwhile are delivered when the
  same account's client resumes. No timer ends that, and `PLANNER_ATTACH_GRACE_MS`
  leases only a detached link's ownership. Only an explicit Stop, a sign-out or
  expiry, a Planner reset, unpairing or revoking the machine, the owner choosing
  another machine, archiving the document, or the same account attaching with a client that
  does not resume (a browser sign-in over a machine's parked work included) ends it; no other
  close keeps it.
  A restart keeps what the cut writes to `planner_link_holds`: the sessions a client holds,
  the questions it waits on (with the decisions each asked, which the next process waits on
  again so a member's answer reaches the client's own request), the answers it is owed and the
  Stops it has not heard. Until its window (`HANDOVER_PLANNER_WINDOW_MS`, counted from the
  release of the lease: the next process starts it as it rebuilds the hold, so no step between
  the write and the release, however slow, and no late takeover takes anything from it; only a
  row the cut wrote more than an hour before is no window's) ends, a hold whose link the cut
  closed is shown as attached. A `resume` inside the window is never refused: before the owner's
  browser sign-in is back it waits for it, with the link kept and the machine shown attached, and
  takes the sessions back the moment it is; one still without it once the window is over is
  refused `unavailable` with `retry`. Only that process is given the window: it rewrites the
  row without it before it shows the hold, so a process that starts after it crashed, inside the
  window or after it, finds the hold disconnected. A crash keeps only
  the hold of a link that had already dropped. Without a `resume` the hold turns disconnected
  when the window ends. A graceful shutdown posts no Chat line about it. A same-account
  client that returns before the server noticed its old link died takes that link's work
  over with its first `resume`. A paired machine's Planner backend attaches with a document-scoped
  credential instead and owns through a cookie-less login carrying the machine's
  own GitHub token, which only revoking the machine or its authorization ends. See
  [Hosted agent](docs/hosted-agent.md#remote-planner).
- **Repository node IDs are authoritative.** Owner and repository names resolve
  GitHub requests but never replace the stored node identity.
- **Automatic local work needs consent.** `LIVE_BUILD` rebuilds (and, where
  enabled, prototypes) dispatch only to a connection whose owner opted in on
  the pairing page, for their own live build's repository; manual Build and
  Run do not need it. Rebuild checks are scheduled only by persisted edits
  from writers or work a writer started. Document text in agent prompts is
  data. See [Living documents](docs/implementation-lifecycle.md#living-documents-live_build).
  `LIVE_SPIKES` prototypes run only passages the consenting editor changed, on a
  push-refusing throwaway worktree, under hourly caps and a 20-minute deadline;
  see [Prototype spikes](docs/local-experiments.md#prototype-spikes-live_spikes).
- **A shared machine runs teammates' work as its owner.** An owner who shares a machine
  consents to the Planner, builds and runs of a document whose editor chose it, or made it
  their favorite and chose none, in repositories the owner can push to (checked with the machine's
  own token, as Default machine does). The
  agent runs with the owner's GitHub account; the build records the editor as `user` and the
  owner as `machineOwner`, and only the connection it was queued on may claim or report it.
  Work Chopin starts by itself never leaves its builder's own machines. Where a document's Planner runs is
  derived from stored choices (the creator's, else an editor's whose machine can run it now),
  never from process memory, so a restart asks one machine; a choice that cannot run it yet
  stops nothing and never interrupts an attached Planner. That check is held per machine and
  repository (a pass 10 minutes, a refusal a minute, asked once however many listings ask
  at once). The Machines page, polled every few seconds, lists a machine that serves every
  repository from two held lists of what can be pushed to, not a check per repository: the
  person's own (a minute) and its owner's, listed with the machine's token once per owner
  for everyone (10 minutes, a failure a minute), so its cost to the owner's token does not
  grow with teammates or polls. Only a repository the machine has a checkout of is asked
  on its own. A person's one favorite may be a teammate's shared machine they could use (the
  same eligibility as its listing); Automatic and Default machine prefer it where it serves the
  repository, and fall back where it doesn't, for a pressed rebuild too, ahead of the machine its
  first build ran on. A favorite is stored and published one change at a time per machine, with
  unsharing and revoking, so memory never keeps one storage has cleared. Machines, a person's own
  and teammates' shared ones, are listed together newest paired first. Unsharing clears
  teammates' choices and favorites of the machine and hands a document to Default machine only where the machine ran its Planner,
  had been asked to, was placing it, or someone uses the document; any other just loses
  the choice.
- **Agents on a machine run in its process sandbox.** The connector starts the ACP
  agent and each Planner backend through one `Sandbox` seam (`apps/connector/src/sandbox.ts`):
  MXC's Seatbelt, bubblewrap or ProcessContainer, in one policy. Writes go to the run's
  worktree or the Planner's own worktree, the agent's state, a private temporary directory and what
  the owner adds. A sandboxed agent never writes the person's own checkout: a Planner runs in it
  (`CHOPIN_CHECKOUT`, whether a regular checkout, a linked worktree of the person's or a clone
  Chopin made) and reads it, whole, so its files, its submodules (whose `.git` files the person's
  `git status` and `git diff` follow), its `.git`, index and `HEAD` are never writable, and no path
  the owner adds with `--sandbox-write` changes that: one that is the checkout or inside it (a
  submodule's folder) or its git directory is not granted, and one that holds it is granted with
  the checkout held read-only. The working directory is written only where the connector made it for the launch (`Launch.own`). A
  Planner's changes reach the person as commits and a pushed branch from its own worktree
  (`CHOPIN_WORKTREE`), never by in-place edits. Git on the host runs what a repository's configuration names, and finds that
  configuration through files (a worktree's or a submodule's `.git`, a `commondir`) that name another
  directory, and a sandbox can only hold back paths that exist. So the policy is an allow-list: the repository's
  git directory is read-only whole, which also stops its entries being renamed or made again, with
  only `objects`, `refs`, `logs` and `lfs` written in it (data git reads, not programs or
  pointers), and only by a launch with a worktree of its own: for a linked worktree the connector
  made for the launch (a run's, or a Planner's own), that worktree's one entry in `worktrees/` with
  `commondir`, `gitdir`, `config.worktree` and the directories `hooks`, `info` and `modules` read-only
  inside it (made empty where there is none). A name made at the top of that entry can't be refused:
  git takes the lock of its `HEAD` and index by creating a file beside each, which a sandbox can't grant
  for those names and refuse for the others (measured: `git add` and `git commit` fail with `Unable to
  create 'index.lock'` when the entry is read-only), so that directory stays writable and a
  new name in it (`future-pointer`, `rebase-merge/`, `locked`, a file named like a hook) is made. Such a
  name is never a pointer, configuration, hook or program for the person's git in their checkout, which
  stays read-only with the rest of the git directory (it reads the entry to list, prune and remove the
  worktree, to see which branch it has checked out or is rebasing, which a planted name can make refuse
  a checkout or delete of that branch, and `gc` reads its `HEAD` and index), and it makes no hardened connector git run anything
  (tested: status, fetch, the removal of the worktree and retention with such names planted, an unfinished
  rebase's `exec` line among them, run nothing; git run inside the worktree itself would, as the next
  sentences say). Which entry is the launch's own
  is the connector's record of what it made for it (`Launch.own`), never what a folder is called or
  what is in it. Its `config`, `hooks`, `info`, `HEAD`, `index`, `packed-refs`, submodules' git
  directories, `worktrees` and every worktree's entry but the launch's own, the person's included,
  are read-only, and no file can be added at its top level. The guarantee is that nothing a
  sandboxed agent writes is in a tree the person's own git reads in their checkout, but `objects`,
  `refs`, `logs` and `lfs` (an agent can add commits and move branches there) and the launch's own
  entry, whose names are no pointer, configuration or program there; the worktree an agent works in
  is its own, and git run inside it by a person runs what the agent left. Paths are real
  paths: `repositoryAt` resolves a symbolic `.git` (and a `.git` file that leads through a link)
  once, and the policy names that directory, never the link. A Planner's own worktree is made by
  the connector on the host before a sandboxed backend starts (`preparePlannerWorktree`), because
  `git worktree add` would need `worktrees/` written, and with no filter run (`noFilters`: every
  filter any configuration defines is given no command); an unsandboxed backend makes it itself. The
  limit, said plainly: in the sandbox anything written in a Planner's checkout, `git add`, `commit`
  and `checkout` included, fails (it is read-only whole), and works in the launch's own worktree.
  A Planner backend that edits `CHOPIN_CHECKOUT` in place must edit its worktree instead; nothing
  in this repository does. `git worktree add/remove`, `git config` without `-c`, `git remote add`, `branch -D`, `tag -d` and `gc` fail
  everywhere; `push -u` can't record an upstream (see [Git in the sandbox](docs/chopin-cli.md#git-in-the-sandbox)). Every git command the connector runs on the host
  goes through `apps/connector/src/git-host.ts`, which is told where the repository is
  (`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, recorded by `repositoryAt` the first time the
  connector sees a working tree and never read from the files an agent can write), reads a copy of
  the person's configuration of the settings a fetch and a checkout need (`GIT_CONFIG_NOSYSTEM`,
  `GIT_CONFIG_GLOBAL`), and replaces what a repository may set for hooks, the file-system monitor, the
  ssh command, attributes, `ext::` remotes, credential helpers (reset, and none of the person's
  named again; a command's caller gives the credentials it needs in the environment) and the
  local transport (never allowed; `GIT_ALLOW_PROTOCOL` in the connector's own environment is the
  person's way to a mirror on disk). Not guaranteed: what an agent writes
  in its own worktree and its own entry (an unfinished rebase's `exec` lines, a repository it
  `git init`s, a submodule it adds to its own index with a `.git` it wrote, which the connector's
  git doesn't open) is the agent's, and git run there by a person runs what is there; a repository's
  own configuration is still read by the connector's git (filters, proxies), which the policy keeps
  an agent from writing. `removePlantedRedirects` remains as a cheap detector of a `commondir` an
  earlier release's agent left, and is not the defense. The rest of the disk reads except credentials (on Windows only what a
  ProcessContainer is given: the profile, MXC's baseline of tool directories, per-user programs, the
  working directory and worktree and the repository's git directory, whole, see `windowsReadRoots` and `launchPolicy`; not run on Windows), and the connector's state
  directory is left out of the read grants, so an agent sees there only its own worktree and the
  folder of its own tokens (`<worktree>.tokens`) and nothing made later (Seatbelt lets a denial
  win over a grant inside it, so a denial can't give an agent its own paths back; a working directory or
  an owner's `--sandbox-write` path that holds the state directory, a home or a dotfiles checkout, is read
  and written around it too, and the connected start check with no registered checkout runs in an empty
  folder of its own, not the home); egress goes only
  through a loopback allow-list proxy. Credentials in the agent's environment are not hidden. A
  machine with no working sandbox runs agents unsandboxed and says so, unless its owner chose
  `--require-sandbox`. Do not start an agent process outside the seam. The one exception is the two
  ACP `initialize` start checks, `chopin service install`'s and `chopin connect --install-service`'s
  before the machine is paired (`checkAgent`): they are not runs, send the agent nothing from Chopin
  (no document, prompt or instruction), last 10 seconds at most, and are not sandboxed, even with
  `--require-sandbox`; `--skip-check` leaves them out. The check that names the agent to Chopin
  once connected goes through the seam. See [Sandbox](docs/chopin-cli.md#sandbox).
- **Persistence should precede publication.** Do not acknowledge or broadcast a
  domain mutation before its fenced durable commit.

## Conversation and Planner addressing

The web composer uses `packages/protocol/address.ts` to translate `@chopin` into
`Chat.Send.to = "planner"`; ordinary messages use `to = "room"`. A person addresses Chopin with
the @Chopin chip at the start of the draft (`apps/web/src/chat/chopin-chip.ts` holds its rules);
the message on the wire is the same `@chopin`-prefixed one a typed mention makes. The wire
destination is authoritative on the server. Do not describe `@chopin` as a server
authorization boundary: a custom write-authorized client can send an explicit
Planner destination without a mention.

A message to the Planner leaves the composer at once. The browser shows it from
its outbox (`apps/web/src/chat/delivery.ts`), marked as waiting to send, until
the server's entry for the same request ID arrives; it then carries
`Entry.deliveryState` (sent, delivered). Delivered means the prompt is on its way
to the machine, after a session is open there; a request whose session cannot be
opened stays sent and waits to be tried again. The outbox sends one message at a
time, oldest first, once the current connection's transcript has arrived, and only
to a server that acknowledges sends. A refused send or a `failed` entry says
"Couldn't send" on the message with Try again and Delete, never in a strip above
the composer, and not while the page's connection banner shows. A refusal with a passing reason is not a
refusal of the message: a full queue behind a running turn (`planner-queue-full`, twenty requests; a
machine that is away has no bound, and keeps every request until it is back, as a chat app keeps
a message for someone offline) or a storage, room or authorization trouble that will pass
(`temporarily-unavailable`). The browser keeps the message waiting to send and sends it
again, in order and with the same request ID, once there may be room. Only a refusal with neither
code is final.
A message already put on the wire can still be deleted, whatever the server last answered it
(an earlier attempt of one it turned down for a passing reason may have been kept): the server is
told to drop it, and a late send cannot bring it back. One it kept, though the commit's answer
was lost, is put back in the queue and the transcript, in its place, when the same request is sent
again, when the queue next starts and when the document opens again, and is delivered once and in
order; a person's request for a machine that is away is never turned away for how many are being
saved at once, whether sent from Chat, by an MCP call or as a task draft.

`instruction()` strips the mention before model input. Recent room messages that
did not address the Planner still enter a bounded backscroll for the next turn.
`implementation:draft` from Build also starts an explicit Planner turn: the
server writes the instruction from the plan, rechecks write access as for
`chat:send`, records only a system notice of who asked, and keeps one live draft
per document. An MCP
`invoke_planner` call posts its instruction as the caller's member message and
runs under the channel's existing Planner owner; only a caller with a live
browser login can claim an unowned channel. With `as: "system"`, an automatic
follow-up limited to the document's creator or its Planner's holder and to 10
an hour, it goes through `instruct()` and records only a system notice instead.

`Chat.Send.focus` names the child a member has open. The server resolves it
against storage and treats it as context, never as an authorization grant. A
child has no Chat: a comment sent to Chopin inside a child, and an
`invoke_planner` call naming a child, run on the root's Chat with that child as
focus, and the turn answers in the child's thread.

Under `copilot-sdk` the Planner is a custom agent, not a general coding
agent; under `atomic` it is a full Atomic session. Either way its turn runs
through `HarnessAgent.stream()` from `@ai-sdk/harness`; the conversation stays
active until the returned stream finishes. An interrupted turn is never
replayed automatically because it may already have made durable tool changes.

## Questions, comments, and anchors

Question submission claims the shared draft with `claimSubmit()`, then stages
the document, authoritative record, and copied question maps inside the room
lock. Publish the candidate only after its fenced commit and invoke the returned
`Store.stage()` finalizer afterward. A failed commit releases the claim and keeps
the accepted draft available for retry. Planner asks and cancellation follow the
same persistence-before-publication ordering.

A decision's definition is frozen except for appended options. Any writer may
send `question:option` to add one while the question is open (at most 10 options,
no case-insensitive duplicate label). The server changes the sidecar record, the
open entry, and the plan `Option` projection together under the plan queue,
commits, and only then acknowledges and broadcasts `question:option-added`. The
client's `key` makes a retry return the same option. Shared drafts need no
rewrite: an option has a register only once someone selects it. New free-text
custom answers are not offered; an existing `custom` draft or answer still
renders and derives.

Anchors combine Yjs relative positions with canonical block digests. A position
survives surrounding edits; a digest can recover one unique block after a move
or epoch replacement. Ambiguous matches must orphan rather than guess. The safe
ordering is to rebase against the old document before a server-authored edit.
Scoped decision-prose jobs follow that ordering. The ordinary `edit_plan` tool
still reconciles first and remains a recovery gap.

The browser starts a comment from a bounded quote locator, selected length,
offset hint, and block indices, not an unbounded copy of selected text. The
server resolves the locator and mints relative positions. It handles stale or
ambiguous passages conservatively, but does not yet enforce every client-side
size and ordering bound on custom wire input.

A comment thread is resolved or reopened through `comment:resolve` and
`comment:reopen`. Both change only the sidecar record and persist before they
are acknowledged or broadcast; reopening must also drop the store's recent
resolution tombstone, which otherwise refuses replies. Resolved threads leave
`comment:sync` and `plan:anchors` and are not rebased, except one whose Planner
turn recorded a result: it stays synced and rebased so the left margin can mark
what it wrote. Reopening recovers the passage. Accepted and dismissed threads are legacy persisted states: nothing
creates them, but accepted `<Decision>` rows and their result anchors remain.

Question and comment relationships have four deliberate states: pending,
linked, deliberately empty, and orphaned. Preserve the distinction. Empty means
the Planner reviewed the decision and intentionally linked no prose; orphaned
means a former target can no longer be identified safely.

## Research requests and child documents

Conversation research offers are distinct from research requests. With
`CONVERSATION_PLAN=on`, decision and research classifiers process saved messages
independently. The research offer's original source and execution identity never
change when its Chat placement moves. Human brief edits are shared CRDT patches;
Start seals the latest server-accepted brief and persists its delivery intent
before publication. See [Research offers from Chat](docs/conversation-research.md).

Typing `/research` starts one parent-scoped durable request from the exact brief.
A pending request is an inline card, not a channel: it has no URL, sidebar row,
Conversation, or Decisions. Failure, cancellation, and explicit retry preserve
the request identity; observational reads must not restart terminal work.

Successful reconciliation validates the complete report and atomically creates
an initialized ordinary child channel plus the request link. Publication must be
idempotent and persistence must precede the ready card or nested navigation row.
A child owns ordinary document and Decisions state. It has no Chat: its root's
Chat and Planner reach it through the child tools, and a root message carries the
open child as `focus`. Startup clears any conversation a child stored earlier,
except one its decision records still cite, which is kept and logged but never
served. V1 does not offer child research, Background Work, implementation/tasks,
or grandchildren.

The server retains `research_workspaces`, turns, messages, and historical chat
references as staging and compatibility internals. Do not present them as a
standalone report, thread, navigation child, or confirmation flow.

## Implementation graphs

The hosted Planner's graph tools remain technically available in any channel
after plan readiness checks pass. That does not make child implementation a
supported product workflow: the child surface exposes no tasks or implementation
destination. The ordinary MCP read path exposes graphs for MCP-created documents. A browser
plan can approve and dispatch a graph through the owner-paired ACP connector;
its run-scoped bridge exposes the document and lifecycle reporting tools. The
Planner cannot approve, lock, or start a graph. See docs/local-launcher.md.

Open or reopened decisions never block a build. **Build plan**, **Build** and
**Retry** go ahead: the coding agent builds on its best judgment, reads each
unanswered decision as `unapprovedDecisions` (in `read_implementation` and
`read_rebuild`), and is told to put that list in the body of every pull request
it opens. The decisions stay open and answerable once the active build releases
its lock; building never answers or closes one.

A person's press is the approval. **Build plan** approves and starts the
drafted graph. Once a build has delivered, with or without `LIVE_BUILD`, a
rebuild appends its tasks as an approved, completed graph version from the
coding agent's report, with no separate review: without `LIVE_BUILD` that
approval is the person pressing **Build** (or **Retry**) on the changes, which
the server refuses while accepted comments await plan changes or required
investigations are open, but never for an open decision; under
`LIVE_BUILD` it is the Build plan press that made the document live.

An approved graph binds one plan revision, graph version, and graph revision.
`start_implementation` atomically claims those values and locks the graph. Task,
pull-request, blocker, revision, and verification transitions persist before
publication. Active implementation prevents plan and decision mutations that
would invalidate the claim.

The run claim is logical, not authorization-bound to the original coding agent.
Any admitted repository writer who knows the run ID can submit lifecycle
transitions. Do not describe the claimant as an exclusive security principal.

Keep graph counters separate from Yjs epoch, document sequence, plan revision,
and storage revision. See [Experimental implementation lifecycle](docs/implementation-lifecycle.md).

## Editor invariants

### Tables

- The first row is always the header row. A table has no independent header flag.
- Import normalizes merged cells into the rectangular subset supported by the
  editor. Export remains valid even if Lexical temporarily exposes a span.
- Tables are limited to 100 rows and 20 columns in the shared dialect.
- Empty paragraphs in cells render as the visible placeholder, so a new cell is
  immediately editable.
- Row and column rails use viewport-fixed overlays outside the editor's clipped
  container. Keep the overlay tree pointer-transparent except for controls.
- A move through a merged span may normalize to the original rectangle and is a
  valid no-op, not a failed operation.

### Code and diff blocks

- Syntax and diff previews are derived React views beside Lexical's canonical
  code node. Do not mount a second editor or write highlighted DOM into Lexical.
- An unnamed fence is plain text. Never guess a language from content.
- Invalid `patch` content temporarily falls back to plain code rendering without
  changing the stored language. Repairing the text restores the diff view.
- The preview is non-editable derived UI. The current Enter handler requires a
  Lexical range selection inside the canonical code block; do not assume a key
  event focused only on the preview will return to the source.

### Change marks and presence

- Planner changes broadcast only after the Yjs update that created their target
  nodes.
- Added and moved marks attach to live block elements. Removed marks use a gap
  between surviving blocks; no empty tombstone node is inserted into the
  document.
- A Planner cursor and a change mark are separate. The cursor points after the
  final changed block even if that block is outside the current viewport.
- Change marks are broadcast decoration, not durable server history. A client
  retains at most 50 unseen marks until they enter the viewport, the editor is
  cleared, or the epoch changes.
- Refresh Awareness with `setLocalState`, not only a field mutation, when the
  visible user profile changes after connection.

### Related prose

Hover highlights every related block. Click scrolls to the first related block
and pins the set briefly. Only one pin may exist, and clearing a pin must remove
the exact highlight object that created it. CSS Highlights are shared by name,
so merge ranges from all mounted editors before replacing a registry entry.

## Failure traps

### Collaboration

- A Lexical node present in the dialect but missing from server collaboration
  registration can throw inside a Lexical listener and silently stop sync.
  Current `registry.test.ts` coverage is narrower than an all-node headless
  Lexical/Yjs round trip; add that regression coverage when extending the
  registry.
- Lexical may report listener failures without throwing from the transaction.
  Capture editor errors explicitly when correctness depends on detecting them.
- Open the document on provider connection, not only editor mount. Otherwise a
  late initial socket connection never requests state.
- A draft edit must not leave the queue until its acknowledgement. Dropping it
  after `send()` loses edits on disconnect.
- Rebuilds and reconnects must replay unacknowledged updates only when the epoch
  is still compatible.
- Shutdown closes every socket with 1012 (`OpenSockets.stopForRestart()`) before
  `server.stop(true)`, whose own 1001 reads as a loss. The browser takes 1012 as a
  quiet restart and a probe's 4xx as a refusal only with `x-chopin-refusal: 1`
  (or a 401); answer any new refusal of `/ws` or `/ws/sidebar` through
  `refused()` so a proxy's 4xx cannot be mistaken for it. A request waiting when
  the 1012 arrives rejects as `WireLost` with `restarting` set; only a caller whose
  request carries its own identity, as `chat:send` does, may send it again quietly.
  For `RESTART_QUIET_MS` after a 1012 `Wire` raises no `onOutage`, so the page's one
  connection banner stays away, and every other surface that speaks of a lost connection
  waits `useConnectionNotice(lost, wire.restarting)`; a new one must honour both. What the
  page draws holds through that quiet too (`readsConnected` for Build plan and the editors'
  controls, `quietRestart` for Chat's hint and composer): a control that comes and goes with the
  connection must not change for a restart, and `e2e/handover.e2e.ts` samples them.
- The cut has a fixed order (`apps/server/src/handover/cut.ts`, held by its test): readiness
  off for the whole unready window while everything is still served, then the listener stops,
  in-flight requests finish, edits stop and commit, link state is persisted, the lease is
  released, and only then do clients hear `session:restarting` and lose their sockets. A
  process answers nothing after it releases the lease, and refuses nothing it was routed.
  Before SIGTERM's cut it keeps serving and starts no new Planner turn. Do not move a step
  across the release or the listener stop, and do not make readiness depend on a query.
  `Chat.close` waits for every send already admitted before it marks the Chat closed, so a
  message being saved at the cut is saved and answered; a `chat:send` that reaches a closed Chat
  of a stopping process (`holdStarts`) is answered with nothing, never "chat is closed", because
  its browser sends it again to the next process and must not show it as one that could not be
  sent.
- Room opening and closing share the document lifecycle lock. Opening waits for
  an active close; eviction forgets the room only after runtime shutdown and
  persistence complete. Preserve that ordering.
- Sidecar restoration currently drops an invalid optional implementation graph
  instead of rejecting the whole sidecar. Do not generalize that fail-open
  behavior to other durable fields.

### Harness and Planner

- Chat consumes `HarnessAgent.stream()` as AI SDK `TextStreamPart`s; `translate()`
  in `apps/server/src/chat/service.ts` projects each part. A `tool-call` naming a
  tool outside the Planner's active tool set aborts the turn and logs a boundary
  failure rather than trusting adapter-internal filtering alone.
- Permission and approval refusals arrive as `tool-output-denied` or
  `tool-approval-request` stream parts, not a separately shaped event; render the
  refusal from that part rather than a guessed top-level field.
- The Copilot SDK adapter (`apps/server/src/harness/copilot-sdk/adapter.ts`) still
  reads raw Copilot SDK events and keeps its own live tool check against session
  metadata. Treat that as adapter-internal behavior, not a property every harness
  in `HARNESS` shares.
- A host tool's return value is what its model reads: the Copilot SDK, Atomic and an
  attached client show it as is, or as one line of JSON for an object, and `HarnessAgent`
  applies a tool's `toModelOutput` only when a turn ends. `read_plan` and `read_child`
  return their structured view, and each real harness in `harnesses.ts` is wrapped by
  `withModelOutput` so its model reads them as text of at most `READ_BYTES` bytes, paged
  with `next:`; Atomic's MCP adapter silently drops the middle of text over 20 KiB. A new
  `HARNESS` must be wrapped too.
- The GitHub MCP tools reached through `apps/server/src/harness/github-tools.ts`
  come from a remote server that can change its offered tool count. Diagnose by
  required names and denied capabilities, not literal counts.
- `HARNESS_AUTH` values that fall back to a host-logged-in subscription (for
  example `auto`) are refused at startup unless the server binds only to a
  loopback interface, so an operator's own subscription is never lent to every
  admitted writer on a public deployment.
- `AGENT=off` prevents hosted agent turns but does not disable local MCP and
  does not currently remove every Planner label from the UI.
- A success callback for persisted sidecar work is not optional. Calling it
  after persistence prevents durable transcript state from being dropped.

### Browser and editor

- Keep one React owner for derived code or diff previews. Mounting a second owner
  over the same node causes race-driven cleanup and remounting.
- While a pane edge is dragged, `apps/web/src/pane-drag-skip.ts` leaves the document's
  far tables and code blocks and Chat's far rows out of layout (`content-visibility: auto`
  on blocks marked `data-drag-skip`, only while the page carries `data-pane-dragging`).
  A geometry read inside such a block lays it out again for the read, so code that
  measures on every resize step must not reach into far blocks. Mark only blocks far
  from the window: with every block marked, the browser stopped anchoring the reader's
  scroll position. A Playwright trace snapshot reads every element and can take seconds
  on a page in that state, so the browser tests that drag long documents run with
  `trace: "off"`.
- Native `<select>` option values must remain globally unique, including the
  empty sentinel.
- Add both MDXEditor's selected-cell class and Lexical's selected-cell theme
  class when replacing table theme styles.
- Tailwind transform utilities can overwrite each other on fixed overlays. Use
  explicit transforms when two axes must compose.
- Geometry and scroll APIs are browser-owned behavior. Test them in Playwright,
  not a synthetic DOM.
- When route state changes rapidly, derive asynchronous results from stable
  request identity and ignore stale responses.

### Deployment and tests

- `compose.local.yaml` publishes application and PostgreSQL ports on all host
  interfaces. It is development-only; do not document it as a safe public
  deployment.
- Coolify preview variables that must remain late-bound use direct `${NAME}`
  references. A `${NAME:-default}` can be resolved from production before the
  preview environment is attached.
- The deploy that overlaps two processes needs a proxy that checks `/api/health/ready`
  actively and holds requests; `deploy/overlap` is a local reference, not a production
  file. A stopped Compose slot's name does not resolve, so a deploy script waits for the
  proxy to see the new slot before it stops the old one (`scripts/overlap.ts` does).
  `scripts/deploy-under-load.ts` is the many-client version, run by hand or from the
  `deploy under load` workflow and never as part of `bun test`; strict invisibility is switched
  on only after it passes on the built image.
- The Docker image expects internal port 8787. Changing `PORT` alone breaks its
  health check and routing assumptions.
- Bun wrapper processes can outlive a failed child. The development and E2E
  supervisors kill process groups explicitly; production managers should run
  the server command directly and restart after any unexpected exit.
- Playwright reuses a server when its probe returns success. The E2E runner does
  not currently preflight application ports 8788, 8789, and 8792, or the fake
  GitHub MCP server's 8797, so stop developer processes on those ports before
  running the suite.
- Accessible-name matching is substring-based by default. Use `exact: true` when
  controls share labels such as `Plan` and `Plan comment`.
- Mac Playwright uses `Meta` rather than `Control` for editor shortcuts.

## Testing strategy

Use the narrowest layer that exercises the behavior:

- **Unit and domain tests** cover parsing, serialization, graph transitions,
  permissions, documents, questions, comments, and pure editor logic.
- **Provider contract tests** run the shared storage suite against memory and
  real PostgreSQL, including process lifecycle and fencing.
- **Browser and system integration tests** cover OAuth/session flows, repository
  authorization, HTTP routes, WebSockets, persistence, reconnection, navigation,
  browser layout, selection geometry, scrolling, and visual editor interaction.

`bun test` has no DOM. Do not add `happy-dom` or `jsdom` to simulate layout,
selection, scroll, `IntersectionObserver`, CSS Highlights, or browser event
ordering. Extract pure state machines for unit coverage and use `*.e2e.ts` for
the browser adapter.

The E2E fake GitHub replaces GitHub's network responses only. OAuth state,
session persistence, admission, repository checks, channel routes,
WebSockets, storage, and the web application are production implementations.

Prefer role and accessible-name selectors. Avoid classes, generated Lexical
keys, and geometry-derived selectors unless geometry is the behavior under test.

## Coding conventions

- TypeScript uses tabs, double quotes, semicolons, and a 100-column target.
- Prefer `let` for local bindings, including values that are not reassigned.
- Keep changes in one function until a helper has a clear reusable boundary.
- Add comments only for non-obvious constraints or failure modes.
- Update protocol declarations before or with both client and server behavior.
- Keep storage mutations idempotent and persistence-before-publication.
- Do not add compatibility paths without a concrete persisted-data or external
  consumer requirement.
- Use current terminology: **Planner** for the hosted agent, **coding agent** for
  an external MCP client, **GitHub App for Chopin** for deployment identity, and
  **room** only for the live server representation.
- Use **document** for the authored product artifact. Use **plan** only for a
  planning-specific workflow, a literal UI label, or an implementation name such
  as `plan:*`, `read_plan`, and `planRevision`.

Run `bun run fix` after code edits and inspect its changes. For documentation,
run `bun run ci` and validate relative links with exact casing.

## Diagnostics

When a disposable Planner session is created, diagnostics report available tool
names and the external GitHub MCP contribution. Counts vary with SDK and remote
MCP versions. A healthy boundary includes Chopin's document tools (currently
plan-named), child document tools, repository tools, and allowed pull-request
tools, and excludes ambient capabilities such as `bash`, filesystem access, URL
fetch, host Git, issues, and unrestricted search. The exception is an `atomic`
Planner session, which deliberately adds Atomic's builtins and coding tools; its
summary and research worker sessions must still show only their own tools.

Treat a missing required tool or an unexpected ambient tool as a security or
configuration failure even when the overall count looks plausible.

## Environment-specific guides

- [exe.dev remote development](docs/exe-dev.md)
- [PR preview testing](docs/preview-testing.md)
- [Local coding-agent MCP](docs/local-agent-mcp.md)
