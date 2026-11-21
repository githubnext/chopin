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

The repository pins Bun 1.4.5. `mise.toml` selects that version automatically for
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
design and diagram suites; a Docker image build; the conversation-plan suite in
its sealed image (`e2e/conversation-plan.Dockerfile`); and the `chopin` CLI
binary build with its bridge smoke test (whose Windows binary is then started
once on Windows, where `install.ps1` is also tested). The required checks
`format, lint, types, tests` and `e2e` are gates over all of those jobs but the
conversation-plan suite. The timings
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
  data for callers with push or administration access. Work on a paired machine
  instead presents an MCP token minted from its launch's credential, limited to
  that launch's documents and life (`experiments/mcp-token.ts`); `/mcp` never
  takes a GitHub App installation token or a launch's own Planner or run credential.
- **AI credentials stay in Chopin.** A person's connected AI keys
  (`ai_credentials`, encrypted) are never returned by any route. A launch holds
  random per-provider placeholders and a launch credential its runner keeps from
  the agent, all kept only as digests; `/api/v1/ai/<provider>/` serves only that
  provider's model API routes, accepts a placeholder only from a live launch, in
  `Authorization` or `x-api-key`, with that same launch's credential in
  `x-chopin-launch`, checks the launch, its machine, its document and the person's
  credential again once the body is read, after any Copilot renewal, and decides the
  send in the same step as it enters the transport: a cutoff (a launch ended, a machine
  revoked, a document archived, a credential replaced or removed) that completed while
  those reads were pending makes it read again (one process holds the writer lease, so
  storage counts each cutoff in memory as it commits, and each cutoff is written under
  that lease, checked in its own transaction, so a process that no longer holds it is
  refused one rather than acknowledge it), and the transport is handed the launch's
  deadline and a Copilot token's and checks them on the clock reading it takes the request
  at, so a request is never sent after a cutoff its caller saw complete. A successor's
  cutoffs are not counted by the process before it, so a process sends nothing once its
  writer lease is released, lost or past its deadline, nor for a request its hand-over abandoned (the
  proxy's requests get the cut's abandon signal, as `/mcp`'s do). A renewed Copilot token
  is sent only if it came from the credential the request was admitted with and still
  connected. It refuses a request carrying any launch's placeholder in a header it
  drops, by value or name, rather than send it changed, swaps the
  placeholder for the real credential of the launch's person in that provider's
  one header, forwards to that provider's fixed origin, following no redirect, and
  passes back only allow-listed response headers, with the credential taken out of
  them and the body and what is emitted checked for it, the headers Chopin adds
  included (an answer they would carry it in is refused, never sent without
  `no-store`). A revoked machine ends its launches'
  placeholders, and archiving a document deletes them for good: a launch prepared
  across an archive stores and publishes nothing, restored or not
  (`channels.archive_generation`). Copilot is sent
  the Copilot token Chopin exchanges the person's GitHub token for and renews, to the
  account's Copilot host, never one past its expiry; GitHub exchanges only Copilot's own
  clients' tokens, so for a GitHub token it refuses (a GitHub App's user token, as a
  Chopin sign-in is, or a personal access token) Copilot is sent that GitHub token
  itself, as Copilot's CLI sends one (`Authorization: Bearer` with
  `Copilot-Integration-Id: copilot-developer-cli`), to `https://api.githubcopilot.com`
  alone and only once that host's model list took it (`apps/server/src/ai/copilot.ts`);
  either is taken out of what is passed back and never logged. A launch gets a Copilot
  placeholder only when GitHub gives that token Copilot access at launch (through
  the person's sign-in unless they connected a token instead; a catalog launch, which runs no
  model, takes the answer held for that account and token, as the proxy's requests do), and no
  placeholder for a provider its person can't use. Copilot's model list for an account (the
  body of the access check's `GET /models`, or one read from the account's Copilot host with its
  Copilot token under the same sending rules) is kept with that answer, a body carrying the token
  dropped, and only read by Chopin to list that person's own models for their composer
  (`ai/account-models.ts`, Atomic's runtime run with no network and a stand-in for every key);
  it is never returned or logged. Only GitHub naming no seat
  (`no_copilot_access`, `not_signed_up`, `subscription_ended`) is no access; a token
  neither GitHub's exchange nor Copilot's model API takes is a check that couldn't be
  done, never no subscription. Every answer GitHub gives about
  Copilot access (a launch's, the list's, the AI accounts page's check's, a proxied request's) is kept
  against the account it concerns, ordered by when it completed, used again only for that account
  and the token that asked, and replaces older answers of the other kind held for that account; one
  that crossed an answer of the other kind settles neither, so the check is unfinished until GitHub
  answers a question put after both, and a refusal for GitHub's rate limit is no answer. A
  launch's grants are published only while its person's credentials are those it was
  prepared with, no answer of the other kind about its Copilot account has completed since it asked, and before
  its deadline and its Copilot token's, both on one clock reading; changes that never settle fail the launch with a retryable error,
  never an empty grant list. A ChatGPT or Claude subscription is connected through that provider's own sign-in, as
  Atomic signs in (`ai/subscriptions.ts`: the person pastes back ChatGPT's callback address or
  Claude's code); nothing is stored until the provider returns tokens, and then only while that
  sign-in is still the person's latest for the provider with no disconnect since (a newer sign-in or a
  disconnect ends one whose code is still being exchanged), over the connection stored when its
  exchange began; the tokens are kept encrypted
  and renewed before they expire, one refresh per connection at a time, each from the pair
  stored when it starts (or one renewed that storage couldn't save yet) and never over a newer
  pair; an access token the provider refuses makes the stored pair it belongs to due for renewal,
  in storage, and a late refusal of an older token marks nothing; a renewal the provider refuses
  for good marks it `rejectedAt` only while the refused pair is still the stored one; an expired or
  refused access token is never sent: the final handoff sends a sign-in's request only with the pair
  it has then, read with the rest and checked, with `rejectedAt`, on the clock reading the send is
  decided on, and renews it first or refuses the request (`sign-in-ended`); a Claude token's
  requests carry Atomic's Claude Code headers and leading system block. An
  OpenAI or Anthropic key is
  saved only once that provider accepts it, and given to no launch once it refuses it as
  invalid on a request (`rejectedAt`, until it is connected again) or while it doesn't
  decrypt. A Copilot token is saved only once GitHub's exchange or Copilot's model API takes
  it, or GitHub names no seat for it; one both refuse (422) or that couldn't be asked (502)
  leaves the sign-in or the token connected before. The model catalog route serves only a
  request carrying one of a live launch's placeholders with that launch's credential,
  while the process holds the writer lease, and none with a placeholder in its query or
  another header or a query field that can't be decoded.
  Each request the proxy sends is recorded under the writer lease before it is sent
  (`ai_usage`), and one it can't record is not sent; it is completed once with its
  outcome and the provider's token counts, and the next lease holder marks one left
  pending `unknown`. A person reads only their own totals (`GET /api/ai/usage`).
  Runners get only a launch credential, placeholders and the proxy's base URLs,
  all from `handOut` (`apps/server/src/ai/launches.ts`), the one place a launch's
  result is decided on: a Planner session on a client offering `ai-credentials`
  (`start`/`fork` carry `ai`, and an `ai` message replaces it when the person's
  credentials change, before its deadline and after a resume) is launched for the
  account that attached; a run on a paired machine (`/api/connector/ai-launch`)
  for whoever started it. A launch Chopin answers with no usable account never starts
  an agent, and the machine owner's setup is never a substitute, on a shared machine or
  their own: `handOut` refuses it (`AiLaunchRefused`), so a Planner `start`/`fork` is
  not sent and its turn fails with `no-ai-account`, as a message from someone with no AI
  account is refused, and
  `/api/connector/ai-launch` answers 409 `no-ai-account` with the words a Build, Run or
  Retry ends with (`NO_AI_ACCOUNT_RUN`, or that a Copilot check couldn't finish, never
  that there is no subscription), its card offering its starter alone Open AI accounts;
  a launch whose document or machine ended first is `launch-ended`, accounts that kept
  changing 503, and a Chopin without launches (404) gives a run no models but what its
  `--env` passes, since nothing of the machine's own setup is in its microVM. Each launch records its owner (`run:<id>`, `session:<id>`, migration 046)
  and its final checks read that the run still runs or a session of this process holds
  it (`ownerLive`). A client offering `ai-catalog` too may ask once per link for a catalog
  launch of the same account, owned by the link (`link:<id>`), to list that account's models
  before any session has one: it is handed in `ai-catalog`, again when it would change, held
  only while the link is attached to this process and ended with it, and catalog-only
  (`catalogOnly`): the proxy serves it each provider's model list and the model catalog and
  refuses it anything else (`catalog-only`) before reading a credential. An end, a
  replacement or a session's close is in force in the
  process the moment it is asked, before storage deletes the rows (`#ending`), an end
  storage refuses is retried, and the writer lease's holder ends launches nothing owns
  as it starts serving and with each sweep (`AiCredentials.retire`). A key refused as
  invalid, or a Copilot seat GitHub confirms lost or back, tells the person's lasting
  launches as a connected or removed key does, and a launch's last check compares
  `rejectedAt` and that every stored grant is still there. A restart's hold freezes
  its sessions' launches as the cut takes it (`freezeAi`), and a change while a session
  starts is sent once after `started`. A runner reads `GET /api/v1/ai/launch` with its
  launch credential to tell an ended launch from a stand-in its agent got wrong. The
  runner adds the launch credential itself; no agent sees it. See
  [Hosted agent](docs/hosted-agent.md#handing-launches-to-runners).
- **A machine's database login is its own.** With `MACHINE_STORE_URL`, pairing and
  connecting give each paired machine a role and database named from its id
  (`apps/server/src/machine-store/`): the administrator owns the database, the role
  has `CONNECT` on it alone and its `atomic` schema, and no other connectable database
  lets the role connect, checked with `has_database_privilege` on each before its login is
  on and by connecting to each but the machines' own after; a `REVOKE` that only warned (the
  administrator doesn't own the database) refuses the login. Each sweep checks every login
  that is on the same way, in one catalog read, and turns off one another database has let in
  since, recording it failed (with that database) before `NOLOGIN`, never a ready record whose
  login is off; its next connect provisions it again. The one exception is a database
  the operator names in `MACHINE_STORE_OPEN_DATABASES`, one a managed service owns and keeps
  open to every role, never `postgres`, `template1`, the administrator's or a machine's, and
  never one where every role reads captured statements, which hold Chopin's password
  verifiers. An
  existing role or database that isn't the managed one (other roles its members, no
  `chopin:machine-store` comment) is refused, never repaired, a password is changed only while the role holds nothing but
  `CONNECT` without grant option on its database, and turning a login off or dropping it
  touches only a marked role and a marked database the administrator owns. Passwords reach PostgreSQL only as a SCRAM
  verifier, are kept encrypted (`machine_databases`), and a rotation keeps the working one
  until PostgreSQL has the new one, refused while the last one's outcome is unknown. A
  login is never handed to a revoked machine, checked in the per-machine queue revoking
  waits on. Revoking or unpairing turns the login off before the revoke is answered as
  done; one that can't is answered 503 with the reason, and revoking again finishes it. The connector writes the login only into
  the private Atomic directories of agents on Chopin's AI accounts
  (`apps/connector/src/machine-store.ts`), never the person's `~/.atomic`. A failure
  never fails pairing; the connector and the Machines page say it, a standalone `chopin pair`
  through `POST /api/connector/machine-store` with `problem`.
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
  document without one, or whose machine is away, are refused with the
  connection's own words and nothing is kept for later. A client that offers the
  optional `steer-turn` feature is given a message sent while its turn runs as a
  `steer` frame (`docs/agent-connection.md`); one that does not is refused such a
  message, except one sent once the turn is being stopped or finishing, which starts
  its next turn. Chopin keeps no workflow runs of a client's and draws no run cards: a session
  outlives its turn only while it waits on a question it asked or on an answer its client has not
  received. Signing out the owner's login, its expiry, or a Planner reset closes the link. A lost
  connection never ends work by itself: a link that offered
  `resumable-sessions` and then dropped unexpectedly keeps its sessions that hold
  an open question or an answer its client has not acknowledged, however long it stays away.
  Decisions stay open and answerable; answers and cancellations made meanwhile are delivered when the
  same account's client resumes. No timer ends that, and `PLANNER_ATTACH_GRACE_MS`
  leases only a detached link's ownership. Only an explicit Stop, a sign-out or
  expiry, a Planner reset, unpairing or revoking the machine, the owner choosing
  another machine, archiving the document, or the same account attaching with a client that
  does not resume (a browser sign-in over a machine's parked work included) ends it; no other
  close keeps it.
  A restart keeps what the cut writes to `planner_link_holds`: the sessions a client holds,
  the questions it waits on (with the decisions each asked, which the next process waits on
  again so a member's answer reaches the client's own request), the answers it is owed and
  each session's AI launch id, which the next process ends with the
  session or replaces when its client resumes. Until its window (`HANDOVER_PLANNER_WINDOW_MS`, counted from the
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
  agent pushes as the App's bot with a token for the one repository, crediting the editor, whose
  push access the server checks ([GitHub App identity](docs/github-app-identity.md)); the build
  records the editor as `user` and the
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
- **Agents on a machine run in NVX microVMs.** The connector starts every agent process, each
  ACP agent of a run, each Planner backend cold or spare, the agent checks and the builds of agent
  images, in an [NVX](https://github.com/microsoft/nvx) microVM of its own, through one seam
  (`Sandbox.spawn` in `apps/connector/src/sandbox.ts`); `vmSpec` in `apps/connector/src/nvx.ts` is
  the one place that decides what a guest is given. There is no process sandbox, no fallback and
  no unsandboxed mode: a machine that can't run NVX (not Linux or Windows on x86_64, or its user
  can't read and write `/dev/kvm` or `/dev/mshv`) is refused by `chopin pair` and `chopin connect`
  before anything is paired or a key spent, with words that say what it needs and the fix; one
  already paired tells Chopin (`/api/connector/capability`, kept as `machines.vm_problem` and shown
  on the Machines page while it is away); and Chopin takes a connection, and hands a Planner
  credential, GitHub or MCP token, AI launch or database login, only to connector protocol 8 saying
  its agents run in microVMs (`chopin-connector-sandbox: nvx`, `microvmsOnly` in
  `experiments/routes.ts`), telling an older connector to update whatever it says. Do not start an agent process outside the seam; tests of what the
  connector does around an agent use the host stand-in in `testing/host-sandbox.ts` and
  `testing/chopin-on-host.ts`, never built into `chopin`. A guest boots its agent's image, an EROFS
  layer built once per recipe in a microVM (Node, pinned git packages, the agent at the version
  this release pins or the owner's `--install` commands, and an account for the connector's own
  user, which every guest runs as so shared files are its own), and is given exactly: the git
  directory its repository is cloned from, read-only; for a Planner, the person's checkout,
  read-only, uncommitted files included; its token folder, read-only; its agents' state, written,
  on Chopin's AI accounts; the MCP bridge, one read-only file; and what the owner adds with
  `--sandbox-write`. Nothing else of the host: no home, credentials, other launches' files, the
  state directory or the owner's agent logins. Shares never hold one another, and a guest writes
  nothing of the person's: every share of a checkout or git directory is read-only, which NVX
  enforces on the host. An agent never works in a host folder: its guest clones the repository
  into its own file system before the agent starts (`PREPARE`), a run with `git clone --shared` into
  memory at the run's commit and branch, a Planner with `--reference --dissociate` onto a sparse
  32 GiB disk of its own (`<slot>.disk`) that lasts between its starts. The host never runs git in a
  tree an agent wrote, and a run leaves no worktree; what an agent keeps, it pushes. Every git
  command the connector runs on the host (fetching into a checkout, a spare's `rev-parse HEAD`)
  still goes through `apps/connector/src/git-host.ts`. A Planner's disk goes when Chopin, the server
  its document is on (`<slot>.server`), says it is archived or gone (`/api/connector/planner/kept`,
  asked as the connector connects and hourly), when a writer reset its Planner after the disk was
  made (`channels.planner_reset_at`, named with each Planner credential and compared with
  `<slot>.reset`), after 30 days unused, or when the machine is
  unpaired or revoked, never while a launch holds it (`<disk>.held`); commits never pushed go with
  it. Nothing a guest left in a folder it writes is followed by the host: no link is written or
  read through (`realDirectory`, `writeOwn`). A
  guest's only way out is the connector's allow-list proxy through NVX's proxy-only network
  (`--network-egress=deny --host-loopback=deny --network-proxy`), its environment is the launch's,
  in a `0600` file and never on a command line, and it holds only its own launch's credentials:
  AI stand-ins, never a real key or the relay's launch credential. Each launch's `nvx` runs in a
  process group the connector ends with it, and a connector that died has its orphans killed by
  the next one (launch records under `<base>/nvx/launches`). A launch takes the folder `nvx` keeps
  in the temporary directory with it however it ends, and a connector removes, as it starts, those
  no launch record or running process names (`sweepRunFolders`); its own files stay in the state
  directory. A start OpenVMM failed for io_uring, as it does under heavy load, is tried again, three
  starts at most, and only before the guest says its workload starts (`STARTED_LINE`): until then
  no stdin reaches the guest, so an agent never sees two starts. A start OpenVMM wasn't allowed to
  open `/dev/kvm` or `/dev/mshv` for says the machine can't run microVMs, with the fix: the
  connector tells Chopin (`/api/connector/capability`), leaves and starts nothing until the support
  check passes again. The base dir is where it really is (`stateDirectory` follows links), and every
  host path a guest's environment, command or working directory names is where its share has it
  (`inGuest` in `vmSpec`). A refusal of an older connector never names a release before
  `NVX_RELEASE`. The run's MCP bridge runs in the guest
  on the image's Node and reads an investigation's images in the guest's repository. Windows (WHP)
  is designed but not yet run end to end. See [Agents in NVX microVMs](docs/nvx-sandbox.md) and
  [Sandbox](docs/chopin-cli.md#sandbox).
- **Persistence should precede publication.** Do not acknowledge or broadcast a
  domain mutation before its fenced durable commit.

## Conversation and Planner addressing

The web composer uses `packages/protocol/address.ts` to translate `@chopin` into
`Chat.Send.to = "planner"`; ordinary messages use `to = "room"`. A person addresses Chopin with
an `@chopin` mention in the draft's words, typed, chosen in the `@` menu, or written at the caret
by the composer's sparkle button or Command+J (`apps/web/src/chat/ask-chopin.ts` holds its rules);
the composer draws no other state for it, and the message on the wire is its words. A person
alone in the document (`alone` in `apps/server/src/chat/initiative.ts`: no other writer has it
open, spoke in the last two minutes or is typing) is talking to Chopin: the server takes their
room message as one to the Planner, with no silence window or judgment, and their draft says
_Message chopin_. The wire
destination is authoritative on the server. Do not describe `@chopin` as a server
authorization boundary: a custom write-authorized client can send an explicit
Planner destination without a mention.

Nothing a person sends is ever held for the Planner. A message to it starts a turn
when none is running; while one runs it is posted to the transcript and
acknowledged at once and given to that turn (`PlannerSession.steer`, through the
harness's own mid-run input: Atomic's `steer`, a `steer` frame to a remote client
that offered `steer-turn`), which reads it at its next step as `@handle: text`, in the
same turn. Steering takes the same write access as starting a turn: `chat:send` is
checked before `Chat.send`, so a reader cannot steer. A background job never makes a
person wait: a message to the Planner (or an `invoke_planner` message) while a job's turn
runs, or while one is being handed the Chat, is acknowledged at once and the job gives way
(`preempt` in `apps/server/src/chat/service.ts`). Its turn is stopped and starts the
person's turn as it ends; a write its own tool has under way finishes first and stands as its
result, and with none it goes back to pending, its attempts unspent, and runs again when that
turn's end wakes the queue. One job (kind and target) gives way at most three times in a row;
the next run is let finish, with the person's turn right behind it. A turn a person started, or
one Chopin started for a Build or a comment, is never preempted. A harness that cannot take
input mid-run (the Copilot SDK) refuses a message while a turn runs with `planner-busy`:
"chopin can't take messages while it works on this machine. Stop it to ask now." (the server
log names the harness). A machine that is away,
in its hand-over window before the client resumes ("Still connecting to @mona's machine, so
this message wasn't sent. Send it again in a moment."), or with none attached, refuses it with
the connection's own words (`planner-not-attached`),
mid-turn too; for a machine that is away they say the message was not sent and to send it again
when the machine is back, and never that it is kept (the machine's own work is; the message is
not). Under `HARNESS=remote` a message to the Planner, or a Retry, from a person a launch would
give no provider (no Copilot access and no API key, read from `AiCredentials.available` with
nothing stored) is refused with `no-ai-account` before anything is saved: "chopin needs an AI
account to answer, so this message wasn't sent. Add one, then send it again.", or, where GitHub
couldn't be asked about their Copilot access and they have no key, that the check couldn't finish
(`ai/account-check.ts`), never that they have no subscription. Their accounts changing while they
are read is a passing trouble. A message sent while a turn is being stopped or finishing, or while one of Chopin's
own turns is being handed the Chat, has no session to be given to; it is acknowledged at once
and starts the next turn as that one winds down (`windingDown` in `chat/service.ts`), ahead of
anything waiting. One sent while such a person's turn waits to start is acknowledged at once and
given to that turn once it can take one (`chat.following`); a harness that takes no input
mid-run refuses it with `planner-starting` and words that ask for no Stop ("chopin is about to answer
another message and can't take more while it works on this machine. Send yours again once it has
answered."). None is answered as a passing trouble, so no message waits in its browser's outbox
behind another. A stopping process (`holdStarts`) keeps no such message: it refuses one in silence
for the browser to send to the next process, and says in Chat that Chopin did not read any it had
already kept for a turn it will not start. If the
turn ends before it can read the message, an idle Chat starts a turn for it and any other
says plainly that Chopin did not read it. A comment note, an `invoke_planner as system` call
and a task draft need a turn of their own, so a running turn refuses them before anything is
saved. Only Chopin's own scheduling still waits for the running turn (or, for a job, a person's), in `chat.waiting`:
background jobs and server-authored instructions nobody typed (initiative, readiness,
decision follow-ups). `planner_deferred_turns` is no longer written or read;
at start the writer-lease holder closes any row an earlier release left open
(`deferredTurns.retire`), so a message it held stays in its Chat as an ordinary one that no
Planner took. The table and its rows are kept, and no migration was added.

A message to the Planner leaves the composer at once. The browser shows it from
its outbox (`apps/web/src/chat/delivery.ts`) as the person's own, saying Sending (never
waiting, queued or a clock), until the server's entry for the same request ID arrives; from
then it carries no mark. The outbox holds a message only for the browser's own connection:
it sends one message at a time, oldest first, once the current connection's transcript has
arrived, and only to a server that acknowledges sends. When `planner-not-attached`,
`planner-busy`, `planner-starting` or `no-ai-account` refuses a send and the composer holds no newer draft, the
typed text (with its mention, references and staged files) returns to the composer draft and
chopin says why in a row only that person sees, placed at the time it was said
(`chat/quiet-note.tsx`, with How to fix where the machine has something to fix, and a link to
AI accounts for `no-ai-account`; in a thread, which holds its draft until it is sent, the words
stay in its draft and `no-ai-account` has the same row there), and for
`planner-busy` while Chopin works the one button offers Stop so the person can stop Chopin and
send it (`planner-starting` keeps Send, so it cannot stop the other person's turn);
when a newer draft was already typed, or another refusal rejected the message, it says
"Couldn't send" on the message with Try again and Delete (which act on the outbox alone, since
the server kept nothing), and not while the page's offline bar
shows. A refusal with a passing reason is not a refusal of the message: a storage, room,
authorization or AI-account-read trouble that will pass (`temporarily-unavailable`). The browser keeps the message sending and sends it again, in order
and with the same request ID, in a moment. Only a refusal with neither code is final, and so
are `planner-busy`, `planner-starting`, `planner-not-attached` and `no-ai-account`. One the server kept, though the commit's answer
was lost, is answered with its first answer when the same request is sent again, and is given
to a turn once.

Chat and every thread read in the order things happened: by `ts`, then by the server's `seq`.
The server appends entries and never gives one an earlier second than the entry ahead of it, and
gives each a sequence (its clock in milliseconds, or one more than the last it gave out) past every
entry and history before it (`appendEntries` in `apps/server/src/chat/chronology.ts`). A thread's
entry that Chat holds too is stamped once against both transcripts when it enters the thread,
raising both transcripts' last sequence, and its copy into Chat keeps that time and sequence and
takes its place by them. Each `chat:history` and opened thread carries `seq`, at least every entry
it holds and smaller than any appended after it; it gives out no number, and a Retry's removal
moves the last sequence past what it took out (`takeOut`). That last sequence is saved with the
transcript (the sidecar's `transcriptSeq`, a thread's `last_seq`), so a restart whose clock is
behind gives out no sequence a browser has seen. An entry saved before sequences existed
keeps its stored place among those of its second. The browser (`transcript-state.ts`) places an
entry by time and sequence, merges two copies of one entry by what the server only adds (text while
it streams, images; reactions by `reactionsSeq`; a tool call is reported whole, with a fixed
`order` among its entry's calls and a growing `rev`, so the larger `rev` wins and the calls keep
the server's order), keeps a `chat:delta`
past the text's end, and a tool or reaction frame for an entry not yet shown, until they fit,
ignores a history older than one applied, drops an entry a history lacks though its `seq` covers
it, and remembers what a Retry removed. So every frame and history, applied in any order, more
than once, or after a reconnect, leaves the server's transcript (`transcript-replay.test.ts`).
What only the browser has (a message still sending, the quiet note, a local notice under its send)
joins the server's entries by its own time, after the entries of its second, in `group()`
(`chat/chronology.ts`), so turn offsets still count the server's entries.

A reply that fails is retried on the same message (`chat:retry`), never as a new one. Only the
message's sender may, while its failure is the latest Planner turn and asking again can help. The
server takes the failed attempt out of the transcript (the failure notice and every agent entry
the attempt wrote, `retryTarget` in `apps/server/src/chat/retry.ts`), saves that, tells the room
with `chat:removed`, and runs the message's turn as it began: the agent reads the message once and
nothing of the attempt. An Atomic session branches back to its leaf before the attempt; a remote
client that offered `retry-turn` is told `message` and `retry` to drop the attempt from what it
keeps ([Retrying a failed turn](docs/agent-connection.md#retrying-a-failed-turn)). A Retry the
server refuses keeps the failure banner and its Retry, with the refusal's words in it, and a link
to AI accounts for `no-ai-account` (`refusedRetryView` in `apps/web/src/chat/failure.ts`).

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

## Planner-created documents

The Planner's `create_document` host tool (every harness) makes new top-level
documents, one per piece of work that splits naturally, each with its own Chat,
Decisions and Planner. Only a turn a person's message (in Chat or a thread)
drives may call it: that person is the creator, and their own live browser login
is rechecked for write access as for `chat:send`; a turn nobody typed and
background jobs are refused. It reuses MCP `create_document`'s draft validation,
visual assessment and creation (`createDocument` in `apps/server/src/mcp/hosted.ts`),
keeps the creating document's repository and base branch, and is bounded per turn
(counted on the turn's own member request, for as long as it runs) and per person
per hour, with an idempotency key scoped to the creating document. The creating
document's model choice is stored in the transaction that creates the new one
(`CreateChannel.modelChoice`), so a retry never overwrites a choice made since.
A retry is found in storage before the limits are counted, is compared against
the base the first call recorded, and posts the linked line only if the first call
could not save it. The document is stored before the sidebar, the asking Chat's
one linked line (`Entry.document`) or its optional first instruction (posted as
the creator's message, as `invoke_planner` does) hear of it. See
[Creating documents](docs/hosted-agent.md#creating-documents).

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

- Code in a named language is coloured on Lexical's canonical code node itself,
  with CSS Custom Highlights (`widgets/code-paint-plugin.tsx`): ranges over its
  own text, never DOM written into Lexical. Diff previews are derived React views
  beside the canonical node. Do not mount a second editor or write highlighted
  DOM into Lexical.
- An unnamed fence is plain text. Never guess a language from content.
- Invalid `patch` content temporarily falls back to plain code rendering without
  changing the stored language. Repairing the text restores the diff view.
- A diff preview is non-editable derived UI. The current Enter handler requires a
  Lexical range selection inside the canonical code block; do not assume a key
  event focused only on the preview will return to the source.
- Enter in a code block is always a line break. Escape, Mod+Enter and the arrows
  at its end leave it (`widgets/code-keys.tsx`); a paste into it is inserted as
  raw text, because Lexical's own paste makes each line a paragraph.
- Wrap lines is the word `wrap` in the fence's info string (`` ```ts wrap ``), outside any
  quoted value; `codeWraps` and `withCodeWrap` in the dialect read and write it. A fence
  without it is never rewritten. Full width is channel metadata (`channels.full_width`),
  set through `PATCH /api/channels/:id` and announced with `session:channel`, not
  document content: it has no Yjs history and is not undone by the editor.

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
  offline bar stays away (it waits ten seconds more, `OFFLINE_BAR_GRACE`, as Slack's does,
  and the Planner's machine is never drawn in Chat), and every other surface that speaks of a lost connection
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
plan-named), `create_document`, child document tools, repository tools, and allowed pull-request
tools, and excludes ambient capabilities such as `bash`, filesystem access, URL
fetch, host Git, issues, and unrestricted search. The exception is an `atomic`
Planner session, which deliberately adds Atomic's builtins and coding tools but
withholds `intercom` from its turns (a Chat thread's adds `tell_chat_planner`); its
summary and research worker sessions must still show only their own tools.

Treat a missing required tool or an unexpected ambient tool as a security or
configuration failure even when the overall count looks plausible.

## Environment-specific guides

- [exe.dev remote development](docs/exe-dev.md)
- [PR preview testing](docs/preview-testing.md)
- [Local coding-agent MCP](docs/local-agent-mcp.md)
