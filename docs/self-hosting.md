# Self-hosting

This guide is for operators evaluating Chopin on infrastructure they control.
Chopin is an experimental research prototype, not a supported production
service. Its current deployment model is one application process, one
PostgreSQL database, one exact public origin, and a GitHub App registered for
that origin.

## Support boundaries

- GitHub.com is the only supported GitHub host.
- Chopin must be served at the root of one origin. Subpath hosting is not
  supported.
- HTTPS is required except for a loopback development origin.
- The application, API, MCP endpoint, and WebSocket share one origin and one
  internal port.
- One active Chopin process may write to a database. Horizontal application
  scaling is not supported. A second process can start beside the holder and take
  over when it stops, which is how a deploy can be invisible; see
  [Deploys nobody can see](zero-downtime-deploys.md).
- PostgreSQL 17 is the version used by the repository and browser tests. Other
  versions are not covered by the project test suite.
- Database migrations are forward-only. There is no automated schema rollback.
- Restarting the application releases hosted agent ownership, except for a remote
  Planner that was connected when the process stopped, which keeps its place for
  a short window (see [Deploys nobody can see](zero-downtime-deploys.md#a-remote-planner-and-its-machine)).
  Documents, transcripts, decisions, background jobs and artifacts, research
  request staging, child documents, implementation state and Planner requests
  that had not started remain. A hosted browser's login is restored when its
  cookie reaches the new process. In local mode (see below), the returning
  browser can restore the same login without repeating device-flow sign-in; it
  still gets a new session and does not reclaim Planner ownership.

## Choose the access policy first

Every browser user authenticates through the GitHub App. Two optional admission
lists decide who may enter the instance:

- `GITHUB_ALLOWED_USERS` contains comma-separated GitHub logins.
- `GITHUB_ALLOWED_ORGANIZATIONS` contains comma-separated organizations whose
  active members are admitted.
- The lists are case-insensitive and form a union.
- Leaving both lists empty admits every verified GitHub user.

Admission does not grant repository access. Browser routes and WebSockets also
require the repository to be present in a GitHub App installation available to
the user. Pull access permits viewing; push or administration access permits
creation, editing, and Planner invocation.

Chopin also registers `/mcp` unconditionally. It accepts a caller-supplied
GitHub bearer token, applies the instance admission policy, and authorizes
repositories directly from that token. It does not require a GitHub App
installation and can create documents or advance implementation lifecycle
state for callers with push or administration access. `AGENT=off` disables
hosted agent turns and the background-job runner; it does not disable MCP.

Use restricted admission for any internet-facing evaluation unless unrestricted
access is a deliberate choice. Protect the entire origin with TLS because MCP
bearer tokens and browser sessions traverse it.

## Choose and trust a harness

Chopin runs its hosted agent through `@ai-sdk/harness`. `HARNESS` selects one
adapter from a code-owned map: the default is `copilot-sdk`, a host-process
wrapper over `@github/copilot-sdk`; `atomic` embeds Atomic's headless SDK
(`@bastani/atomic`) in the server process; and `remote` runs each Planner turn in
a client attached over the agent connection instead. Adding an adapter to that map is a
reviewed trust decision, not a runtime plugin choice: an adapter's
`builtinTools` and `supportsBuiltinToolFiltering` are self-declarations, and
Chopin's contract suite checks those declarations and the tools a session
actually receives, but it cannot prove what the underlying runtime does
internally. Only adapters that ship in this repository and pass that suite
belong in `harnesses`.

For `copilot-sdk`, `direct` and `ai-gateway` are explicit `HARNESS_AUTH` modes
that may be used on any bind. A mode that could fall back to a subscription
already logged in on the host, such as `auto`, is refused at startup unless
`SERVER_HOST` is loopback-only. The current `copilot-sdk` adapter still uses
each owner's GitHub App user token and does not consume `HARNESS_AUTH`;
setting `auto` on loopback passes the startup guard but does not enable host
login in that adapter.

Under `HARNESS=copilot-sdk` the Copilot CLI runs with a minimal environment of
its own, not the server's. Behind an HTTP or HTTPS proxy, set these on the
server process and the CLI receives them unchanged: `HTTPS_PROXY`,
`HTTP_PROXY`, `NO_PROXY` and their lowercase forms, and the certificate
variables a proxy that re-signs TLS needs, `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE` and `SSL_CERT_DIR`. A variable the server has not set is not
passed, and one set to an empty string is passed as empty. The CLI also gets
`COPILOT_PLUGIN_DIR_ONLY=true` and the variables the Copilot SDK itself sets;
nothing else from the server's environment reaches it, including tokens and
`COPILOT_ENABLE_BUILTIN_GITHUB_MCP`. If the host reaches GitHub only through a
proxy that the server learns some other way, such as a system setting, set
these variables on the server process too: otherwise the CLI connects directly,
and a Planner turn fails with "The Planner stream failed."

`HARNESS=atomic` runs Atomic 0.9.76 in the Chopin server process through its
headless SDK (`createAgentSession()`). It does not spawn the `atomic` CLI or use
RPC mode.

**Choosing `HARNESS=atomic` gives the Planner shell and filesystem access as the
server process's user, on hosted instances as well as local ones.** Every Planner
session is a full Atomic session: Atomic's workflows, subagents, MCP, web access,
Intercom, and default coding tools run beside Chopin's document tools, with the
operator's Atomic extensions, skills, prompt templates, and context files. There is
no separate flag; choosing the harness is the choice. Operators who do not want that
should use `copilot-sdk`, whose Planner keeps the isolated, Chopin-tools-only
boundary. Only the summary and research workers still run isolated Atomic sessions.
See [The atomic Planner](#the-atomic-planner) below and
[Hosted agent](hosted-agent.md#full-atomic-planner) for the details.

`HARNESS=atomic` requires an explicit `HARNESS_AUTH`, either `auto` or
`ai-gateway`. Unset, `direct`, and every other value are refused at startup.

- `auto` copies the host operator's Atomic login into memory when the first
  turn starts: `$ATOMIC_CODING_AGENT_DIR/auth.json` when that variable is set,
  then `$PI_CODING_AGENT_DIR/auth.json` for the legacy variable, otherwise
  `~/.atomic/agent/auth.json` over the legacy `~/.pi/agent/auth.json`.
  It also resolves provider keys from the process environment, such as
  `ANTHROPIC_API_KEY`, and ambient cloud credentials, such as an AWS profile or
  Google application default credentials. Because every admitted writer's turns
  would use the operator's own subscription or keys, `auto` is refused unless
  `SERVER_HOST` is loopback-only.
- `ai-gateway` starts without stored credentials, reads `AI_GATEWAY_API_KEY`,
  and accepts only `vercel-ai-gateway` models. It is the only mode allowed on a
  non-loopback bind.

The adapter never writes credentials to disk. It reads the host login without a
lock file, keeps refreshed OAuth tokens in memory, and neither reads nor writes
Atomic's `models.json` or `models-store.json`.

Under `atomic`, `MODEL` is required and must name a `provider/model` from
Atomic's catalog: for example `vercel-ai-gateway/anthropic/claude-sonnet-4.6`
under `ai-gateway`, or `github-copilot/gpt-6-luna` under `auto` with a GitHub
Copilot login. An integration that passes Atomic a failed model lookup gets
another model without warning. This adapter looks the model up itself and
fails the turn before any model request.

Structured output uses an inline Atomic extension that
registers a terminating result tool, enabled only for a turn that requests
structured output and blocked on every other turn. The tool records the calling
model's own arguments. The adapter does not use Atomic's
`createStructuredOutputTool`, which infers the answer again with a second model
call. The Atomic contract suite
(`apps/server/src/harness/atomic.contract.test.ts`) covers isolation, model
resolution, host tools, structured output, and abort against Atomic's real
agent loop. Run it before bumping `@bastani/atomic`.

Atomic caveats:

- Atomic's SDK defaults suit a local coding agent, not Chopin. By default it
  enables its shipped packages, including a mandatory Intercom, and its coding
  tools. It discovers host resources, gives turns without instructions a
  coding-agent system prompt, and saves tool results over 50,000 characters to a
  temporary file. For the isolated worker sessions the adapter overrides each
  default and fails closed on the ones it can observe, but a new Atomic release
  can add a default the suite does not check. Planner sessions deliberately keep
  those capabilities.
- Sessions live only in memory. `doStop` returns a state the adapter refuses to
  resume, so a session never survives a restart. Chopin does not resume
  harness sessions.
- Harness-level compaction, suspending a turn, and supplied harness skills are
  unsupported. A Planner session's own resource discovery does load Atomic
  skills. Atomic's automatic retries remain on.
- Since Atomic 0.9.42 a provider's rate limit is shared by the whole server
  process. After one request gets a 429, every Atomic session in the server,
  Planner turns and workers alike, waits for that provider's cooldown (its
  `Retry-After`, otherwise backoff of up to 60 seconds) before sending its next
  request, instead of each hitting the limit in turn. A turn waiting there shows
  no output yet; stopping it ends the wait without sending the request. Chopin
  sets no request budget (`configureProviderRequestBudget()`) or
  `resourceAdmission` of its own.
- Under `auto`, refreshing an OAuth token in memory can rotate the refresh token
  stored by the host CLI, which may then ask the operator to sign in again.
  `auto` also runs `!command` API-key entries in `auth.json` to resolve them.
- There is no per-session credit limit like Copilot's, so a worker's
  `maxAiCredits` does not apply. Use the provider's spend limits.
- `@bastani/atomic` adds more than 200 MB of installed dependencies on Linux
  x64, including glibc and musl native modules. Expect a larger image.
- Atomic workflows need no database server. Their runs are journaled in a
  SQLite file, `$XDG_STATE_HOME/chopin/atomic/workflows.sqlite`, beside the
  documents' Planner directories, which Chopin passes to each Planner session
  as its `journal` rather than through the process environment (see
  [Full Atomic Planner](hosted-agent.md#full-atomic-planner)). The Docker image
  sets `XDG_STATE_HOME=/var/lib/chopin`; mount a volume there to keep runs
  and those directories when the container is replaced.
- Local workflow worker pools stay off unless the operator's Atomic settings
  set `workflows.localWorkers`. Since Atomic 0.9.44 a pool runs as one
  coordinator process per root run, started by the Chopin server process, with
  the worker processes under it; it uses the same journal, and if the server
  exits, the coordinator and its workers exit with it. Atomic keeps each
  worker's standard error in `worker-logs/` beside the journal, so under
  `$XDG_STATE_HOME/chopin/atomic/worker-logs/<run id>/`, inside the directory
  Chopin creates for the journal with access for the server's user only. It
  deletes a log when its worker shuts down normally but keeps the logs of
  workers that failed; remove them yourself. A child whose worker dies is
  replayed on a new worker, up to three attempts; after that the run fails and
  its card in Chat says so. The settings `workflows.localWorkers.startupTimeoutMs`
  and `leaseMs` set how long a worker may take to start and how long an
  unresponsive one keeps its child; Chopin sets neither. A pool runs children
  once one worker is ready and fails to start only when none is. Since Atomic
  0.9.45 an unset `startupTimeoutMs` is no longer a flat 30 seconds: it is 30
  seconds times the worker count plus the one-minute load average, divided by
  the CPU cores, at least 30 seconds and at most 10 minutes, so a large pool on
  a busy Chopin host waits longer. A run whose workers still miss it fails with
  `Local worker startup timed out`, and its card in Chat says so; raise the
  setting or use fewer workers.
- Since Atomic 0.9.44 a workflow runs up to 1000 of its stages at once unless
  it says otherwise (`defaultConcurrency`, 3 before), nests child workflows at
  most three levels deep (`maxDepth`, 4 before), and a stage's `subagent` tool
  runs up to 1000 children at once (`parallel.concurrency` and
  `parallel.runningCapacity`, 3 and 4 before). Without a pool, all of them run
  in the Chopin server process and share its memory and the provider rate
  limit above. To throttle a server, lower `defaultConcurrency` in
  `extensions/workflow/config.json` and the `parallel` limits in
  `extensions/subagent/config.json` under the Atomic agent directory, which
  Planner sessions read; Chopin sets none of these itself.
- Atomic depends on `typebox` 1.3.27 while Chopin pins 1.3.7. Host tool schemas
  pass to Atomic as plain JSON Schema, so the two versions never meet.

For a reviewed adapter that consumes a shared operator key, every admitted
writer's turns would bill that key. Chopin adds no billing quotas of its own in
this revision, across jobs or users; use the model provider's spend limits and
usage alerts. A Copilot credit limit applies to one harness session, including all
turns of its job stage, not as a platform-wide budget; see
[Background jobs](background-jobs.md#executor-owned-limits).

### The atomic Planner

A Planner session's working directory comes from one place: a `checkout` path
supplied through the MCP
[`invoke_planner`](local-agent-mcp.md#hand-an-instruction-to-the-planner) tool.
Chopin checks it with Git and compares `origin`'s owner/repository to the
document's repository, ignoring case and the remote host spelling (so SSH host
aliases work). A mismatching or missing path refuses the invocation before
anything is posted. A verified path is remembered for that document until the
server process exits; nothing is written to storage. Every later Planner session
for the document, whether started from the browser or through MCP, re-verifies
the remembered path before using it. The check establishes repository
coordinates, not remote-host authenticity, and it does not confine the shell.

Without a remembered checkout that still verifies, the session runs in a directory Chopin keeps for that document alone under its per-user state
directory (`$XDG_STATE_HOME/chopin/planner/<document id>`, defaulting to
`~/.local/state`; `~/Library/Application Support/Chopin/planner` on macOS;
`%LOCALAPPDATA%\Chopin\planner` on Windows), with mode `0700`. It is never shared
with another document, keeps what the Planner and its workflows write there
across later sessions and server restarts, and is not placed in the shared
temporary directory. A symlink or file at that path is refused. The session has the
same tools either way; the Planner is told whether it is in a checkout or in an
empty directory without repository files, and its repository tools remain
available.

Atomic input (`ask_user_question`, extension dialogs, and workflow-stage
questions) appears as shared Decisions instead of terminal dialogs, including
workflow run and stage labels. Unanchored batches append at the document's end.
Dialog text and written answers stay verbatim, bounded only by the document's
256 KiB source limit and the shared-draft limits rather than the Planner's own
question limits. A request has no time limit: it waits until a member answers it
or it is withdrawn. Cancellation withdraws pending cards and never approves an
action. See
[Full Atomic Planner](hosted-agent.md#full-atomic-planner) for the mapping,
resource loading, persistence, and workflow restart boundaries.

`invoke_planner` itself is offered on every harness and in both authentication
modes. Other harnesses ignore its `checkout`: they neither verify nor use nor
remember it.

### The remote Planner

`HARNESS=remote` keeps the model out of the server. Each Planner session and turn
goes to a client attached to the document over the agent connection at
`/api/v1/agent`, usually an agent on a member's own machine; code, model credentials, and that client's tools stay on the
member's machine, while the document, Decisions, and every room write stay in
this server. The server needs no `MODEL` (one that is set is passed to the
client as the turn's requested model) and accepts no `HARNESS_AUTH`, so it may
bind to a public interface. Startup refuses `HARNESS_AUTH`. Summary and
research workers run as isolated sessions on the client attached to their
document, and wait while none is attached; set `BACKGROUND_JOBS=off` to keep
them off the attached clients entirely, which also turns off `/research`. The
route exists only with `AGENT` on and `HARNESS=remote`.

The trust boundary moves to whoever attaches. A client authenticates with a
GitHub token bearer, checked like hosted MCP, and needs push or administration
access to the document's repository, rechecked before every session and turn and
every 5 minutes while it stays attached. The same account must have signed in to
this server in a browser: attaching makes that login the document's Planner
owner, one client per document, and a detached connection, or one that dropped with
nothing to keep, holds it for `PLANNER_ATTACH_GRACE_MS` so the same account can
reattach. A dropped `resumable-sessions` connection with runs or open questions
holds it, and them, until it returns or something explicit ends them. The server pings
every connection and counts one that answers nothing for `AGENT_CONNECTION_TIMEOUT_MS` as
dropped, so a client whose network silently went away does not stay attached.
A queue of frames draining toward the client puts that off, but never past
`AGENT_CONNECTION_MAX_SILENCE_MS` since the client last sent anything, because a
proxy such as Caddy can drain it while the client reads nothing. Its 15-minute
default lets a client reading at about 19 KiB/s or faster drain the full 16 MiB
the server may queue for it and answer a ping in time. A client that stops
reading behind such a proxy is released by then at the latest, and usually much
sooner: once the proxy's and the kernel's buffers fill, the queue stops
shrinking and the ordinary timeout applies. Lower it to release such clients
sooner, or raise it for slower connections.
A frame counts only once it has arrived whole, so with the 2-minute default a
client must upload at about 17 KiB/s or more to send a full 2 MiB frame; see
[Pings](agent-connection.md#pings) and raise the timeout for slower uplinks.
The client then
receives what a Planner turn sees, including repository reads made with that
owner's token, and decides what the Planner writes during turns writers start;
its run reports never start a turn. The server never runs the client's tools and
gains no shell or filesystem access from this harness. Without an attached
client, `@chopin` and `invoke_planner` are saved and wait for one, under
`AUTH_MODE=local` as well. See
[Remote Planner](hosted-agent.md#remote-planner) for the behaviour and
[Agent connection](agent-connection.md) for the wire format. The connection shares the
application's origin and port with `/ws` and `/mcp`, so a TLS-terminating proxy
such as Caddy needs no extra listener; its default `reverse_proxy` already passes
WebSocket upgrades with their `Sec-WebSocket-Protocol` and `Authorization`
headers.

## Prerequisites

- Docker for the application image, or Bun 1.4.4 for a source deployment.
- A reachable PostgreSQL database and credentials with schema migration access.
- A stable DNS name with TLS termination and WebSocket proxying.
- Outbound HTTPS access to GitHub and the selected harness's model provider
  (the hosted Copilot service for `copilot-sdk`).
- When the Planner is enabled (the default), or `CONVERSATION_PLAN=on`, a
  decisions classifier and its server-side key, separate from the Planner's
  harness credentials: `OPENAI_API_KEY` for OpenAI's Decisions API
  (`api.openai.com`) or `JEV_API_KEY` for TypeSafe's Jev (`api.typesafe.ai`).
  See [Decisions](#decisions).
- A GitHub App owned by the deployment.
- At least one user with repository push or administration access.
- For `copilot-sdk`, an active Copilot entitlement for each user who may own a
  hosted agent session. For `atomic`, model credentials for the chosen
  `HARNESS_AUTH` mode instead.
- For public web research (`/research` with `WEB_RESEARCH` on), GitHub's Copilot
  MCP endpoint must offer its `web_search` tool to each user's App user access
  token. GitHub does not document that tool's requirements, so verify it on your
  deployment; see [Troubleshooting](#troubleshooting).

## Register the GitHub App

Create one GitHub App per deployment. Register the exact public origin:

```text
Homepage URL: <APP_ORIGIN>
Callback URL: <APP_ORIGIN>/auth/github/callback
Setup URL:    <APP_ORIGIN>/auth/github/setup
```

Then:

1. Enable expiring user authorization tokens.
2. Leave OAuth during installation disabled.
3. Disable webhooks.
4. Make the App installable on any account.
5. Leave device flow disabled, unless you use
   [local device-flow sign-in](#local-device-flow-sign-in).
6. Give it these repository permissions, which
   [Authentication](authentication.md#repository-permissions) explains:

```text
Contents:        Read and write
Pull requests:   Read and write
Workflows:       Read and write
Checks:          Read-only
Commit statuses: Read-only
Issues:          Read-only
Metadata:        Read-only (automatic)
```

Organization admission also needs
[one organization permission](authentication.md#organization-admission).

## Runtime configuration

Store production values in the deployment's secret manager or an owner-readable
environment file outside the source tree. Do not bake `.env` or credentials into
the image.

| Variable                          | Default                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_DRIVER`                  | `postgres`              | Storage adapter. `postgres` is currently the only accepted value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DATABASE_URL`                    | required                | `postgres:` or `postgresql:` connection URL. It is not printed by Chopin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `APP_ORIGIN`                      | required                | Exact public origin, without credentials, path, query, fragment, or trailing slash. HTTPS is required unless the host is loopback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PREVIOUS_ORIGINS`                | empty                   | Comma-separated origins this deployment was served from before `APP_ORIGIN`, each validated like `APP_ORIGIN`. Paired machines, browser logins, Origin checks, and document links from those origins keep working; see [Moving to a new origin](#moving-to-a-new-origin).                                                                                                                                                                                                                                                                                                                                                                                         |
| `GITHUB_APP_SLUG`                 | required                | Lowercase slug from the App's public URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GITHUB_APP_CLIENT_ID`            | required                | OAuth client ID, not the numeric GitHub App ID.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GITHUB_APP_CLIENT_SECRET`        | required (hosted)       | OAuth client secret used for user-token exchange and refresh. Unused when `AUTH_MODE=local`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GITHUB_ALLOWED_USERS`            | empty                   | Comma-separated admitted GitHub logins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GITHUB_ALLOWED_ORGANIZATIONS`    | empty                   | Comma-separated organizations whose active members are admitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SESSION_ENCRYPTION_KEY`          | required                | Exactly 64 hexadecimal characters. Encrypts the hosted OAuth attempt cookie and derives a separate key for session credentials in PostgreSQL. Keep stable across releases and outside the database; replacing it invalidates hosted logins. Local mode requires the configured key but uses separate unpredictable, HttpOnly attempt and browser-binding cookies.                                                                                                                                                                                                                                                                                                 |
| `AUTH_MODE`                       | `hosted`                | Set `local` for loopback device-flow sign-in with persisted credentials (see [Authentication](authentication.md#local-device-flow-sign-in)). Any other value fails startup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DEMO_PERSONAS`                   | `off`                   | Set `on` to enable the server-owned local demo collaborators (Lily and Felix). Requires `AUTH_MODE=local` on a loopback bind; otherwise, or for any value besides `on` and `off`, startup fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CHOPIN_LOCAL_CREDENTIALS_DIR`    | platform default        | Local mode only. Overrides the plaintext-fallback credential directory (default `~/.config/chopin` on Linux, `~/Library/Application Support/Chopin` on macOS, `%APPDATA%\Chopin` on Windows). Must resolve outside the repository and process working directory.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SERVER_HOST`                     | `127.0.0.1`             | Source-process bind address. The image sets `0.0.0.0`, which local mode refuses. A `HARNESS_AUTH` mode that falls back to a host-logged-in subscription is refused unless this stays loopback-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PORT`                            | `8787`                  | Source-process HTTP and WebSocket port. The supplied image and health check expect internal port 8787.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MODEL`                           | `gpt-6.1-sol`           | Model requested for hosted agent sessions. Required under `HARNESS=atomic`, where it must be `provider/model` from Atomic's catalog. Optional under `HARNESS=remote`, where the attached client chooses its model and a set value is only passed along as the turn's request.                                                                                                                                                                                                                                                                                                                                                                                     |
| `HISTORY_MODEL`                   | `MODEL`                 | Model for History's one-line summaries of editing sessions, written when someone opens History on a document with a Planner owner. A small, fast model suits it. Resolved like `MODEL` by the configured harness.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `HARNESS`                         | `copilot-sdk`           | Adapter name selected from Chopin's harness map (`copilot-sdk`, `atomic`, or `remote`). An unknown name refuses at startup. `remote` runs Planner turns in a client attached at `/api/v1/agent`; see [The remote Planner](#the-remote-planner). `atomic` gives every Planner session shell and filesystem access as the server process's user, hosted instances included; see [Choose and trust a harness](#choose-and-trust-a-harness).                                                                                                                                                                                                                          |
| `PLANNER_ATTACH_GRACE_MS`         | `120000`                | Under `HARNESS=remote`, how long a detached agent connection, or one that dropped with nothing to keep, holds the document's Planner ownership so the same account can reattach, in milliseconds, an integer between 0 and 3600000. It is an ownership lease, not a timeout on active work: a dropped `resumable-sessions` connection with runs or open questions keeps them with no deadline until it returns or something explicit ends them.                                                                                                                                                                                                                   |
| `AGENT_CONNECTION_PING_MS`        | `15000`                 | Under `HARNESS=remote`, how often the server sends each agent connection a WebSocket protocol ping, in milliseconds, an integer between 1000 and 600000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AGENT_CONNECTION_TIMEOUT_MS`     | `120000`                | Under `HARNESS=remote`, how long an agent connection may send nothing, not even a pong, before the server closes it as dropped, in milliseconds, an integer between 1000 and 600000 and longer than `AGENT_CONNECTION_PING_MS`. A whole frame must arrive within it: 2 MiB in 120 seconds is about 17 KiB/s of client upload.                                                                                                                                                                                                                                                                                                                                     |
| `AGENT_CONNECTION_MAX_SILENCE_MS` | `900000`                | Under `HARNESS=remote`, how long an agent connection may send nothing at all, not even a pong, before the server closes it as dropped, however much of what the server queued for it drains meanwhile, in milliseconds, an integer between 1000 and 3600000 and at least `AGENT_CONNECTION_TIMEOUT_MS`. A draining queue defers the timeout only up to this, since a proxy can drain it while the client reads nothing. The 15-minute default lets a client reading at about 19 KiB/s drain the full 16 MiB the server may queue for it and answer a ping; lower it to release a client that stopped reading behind a proxy sooner, or raise it for slower links. |
| `HANDOVER`                        | unset                   | Set exactly `wait` to let this process start beside another one that holds the database's writer lease. It then listens at once in standby, answers `GET /api/health/live` with `200 standby` and `GET /api/health/ready` with `503 standby`, serves the built client's files, holds every other request and WebSocket upgrade for up to `HANDOVER_HOLD_MS`, and reads the lease every 100 ms until the holder releases it or it expires, then takes it. Unset or `off`, a process that finds the lease held exits 1. Any other value refuses at startup.                                                                                                         |
| `HANDOVER_TURN_WAIT_MS`           | `10000`                 | When this process is stopped (SIGTERM or SIGINT), how long it keeps serving while Planner turns already running finish, in milliseconds, an integer between 0 and 600000. A turn still running then is cut off, with a notice in its Chat, and is never run again. The turn wait, the unready window, the request wait and about three seconds to commit must fit inside the platform's stop grace period.                                                                                                                                                                                                                                                        |
| `HANDOVER_UNREADY_MS`             | `300`                   | How long `GET /api/health/ready` answers `503 draining` before the listener stops, in milliseconds, an integer between 0 and 60000. Set it to the proxy's active health-check interval plus a margin. The process serves every request through the window. It logs how many readiness checks it answered not ready in it, and a window in which none came as a risk to the hand-over.                                                                                                                                                                                                                                                                             |
| `HANDOVER_REQUEST_WAIT_MS`        | `1000`                  | After the listener stops, how long requests already running may finish before their connections are closed without an answer, in milliseconds, an integer between 0 and 60000. Each request closed this way is logged.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `HANDOVER_PLANNER_WINDOW_MS`      | `10000`                 | How long after the cut a remote Planner is expected to be back, in milliseconds, an integer between 0 and 600000. It is the `reconnectWithinMs` of the `restarting` notice and of `session:restarting`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `HANDOVER_HOLD_MS`                | `20000`                 | How long a process in standby holds a request or WebSocket upgrade that needs the writer lease before it answers `503` with `Retry-After: 1`, in milliseconds, an integer between 0 and 120000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CLIENT_DIR`                      | `apps/web/dist`         | Directory of the built web client. A process is ready only when `index.html` exists there, unless `DEV_CLIENT` is set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `HARNESS_AUTH`                    | unset                   | Auth mode forwarded to the selected adapter. For `copilot-sdk`, `direct` and `ai-gateway` are allowed on any bind and `auto` requires a loopback-only `SERVER_HOST`; the adapter does not otherwise consume it. For `atomic`, it is required and must be `auto`, which requires a loopback-only `SERVER_HOST`, or `ai-gateway`; every other value is refused. For `remote`, any value is refused.                                                                                                                                                                                                                                                                 |
| `HARNESS_EXTENSIONS`              | unset                   | Extension or package paths every atomic Planner session loads, as Atomic's `--extension` flag would, separated by the platform path delimiter (`:`, or `;` on Windows). A package's extensions, skills, and workflows all register. Each path must be absolute and exist; any other harness refuses the variable at startup. Background workers never load them. The code runs in the server process as its user.                                                                                                                                                                                                                                                 |
| `AGENT`                           | on                      | Set exactly `off` to prevent hosted agent turns, disable the entire background-job runner, and avoid Copilot CLI startup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `BACKGROUND_JOBS`                 | on                      | Set exactly `off` to disable background job scheduling. `AGENT=off` disables the entire runner. Under `HARNESS=remote`, workers run on the document's attached client.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `WEB_RESEARCH`                    | on                      | Set exactly `off` to disable new public-web research while retaining durable requests, artifacts, and other jobs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `CHAT_ATTACHMENT_MAX_BYTES`       | `1048576`               | The most one image or text file sent with a Chat message may be, in bytes, a whole number from 1 to 16777216. The browser checks it before uploading and the server again on arrival, by reading the bytes. Under `HARNESS=remote` it is never more than 1048576, which is what a turn's files may total in one agent connection message.                                                                                                                                                                                                                                                                                                                         |
| `CHAT_ATTACHMENT_MAX_COUNT`       | `5`                     | The most files one Chat message may carry, a whole number from 0 to 20. `0` turns files in Chat off: the composer offers none and the upload routes answer 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CHAT_ATTACHMENT_MAX_TOTAL_BYTES` | `4194304`               | The most the files of one Chat message may total, in bytes, a whole number from 1 to 67108864 that is at least `CHAT_ATTACHMENT_MAX_BYTES`. Under `HARNESS=remote` it is never more than 1048576.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `TRANSCRIPTION_MODEL`             | off                     | `off`, or `openai/<model>` such as `openai/gpt-4o-mini-transcribe`. Where it is set, a person whose browser has no speech recognition that runs on their device may dictate: the composer records on their device and, when they stop, sends the recording to this server, which sends it to OpenAI with `OPENAI_API_KEY` and gives the words back. Where it is off no audio is ever accepted or sent anywhere, and the microphone button is offered only to browsers that recognize speech on the device. The microphone button's tooltip names OpenAI wherever this is on. Needs `OPENAI_API_KEY`.                                                              |
| `TRANSCRIPTION_MAX_BYTES`         | `5242880`               | The longest recording the server takes for `TRANSCRIPTION_MODEL`, in bytes, a whole number from 1 to 26214400. A recording is kept only as long as the provider takes to answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `RESEARCH_EVIDENCE_TIMEOUT_MS`    | `600000`                | Deadline of one public-web research evidence attempt in milliseconds, an integer between 120000 and 1800000. Web search calls take up to about two minutes each; the attempt budgets at most four calls against what remains of this deadline. The job retries once after a failed attempt.                                                                                                                                                                                                                                                                                                                                                                       |
| `COPILOT_CLI_PATH`                | automatic               | Advanced override for the Copilot CLI executable. Applies only to the `copilot-sdk` adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CONVERSATION_PLAN`               | off                     | Set exactly `on` to enable experimental conversation-derived cards. Interpretation runs independently of `AGENT`; Planner jobs still obey the agent and job settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PLANNER_VISUALS`                 | off                     | Set exactly `on` to enable the bounded visual handoff for foreground Planner turns. Requires `AGENT=on` and a decisions model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DECISIONS_MODEL`                 | from the key present    | The classifier that answers every decision, as an exact Atomic `provider/id`. Unset, it is `typesafe/jev-latest` when `JEV_API_KEY` or `TYPESAFE_API_KEY` is set, otherwise `openai-decisions/gpt-6-luna` when `OPENAI_API_KEY` is set. See [Decisions](#decisions).                                                                                                                                                                                                                                                                                                                                                                                              |
| `DECISIONS_TIMEOUT_MS`            | `30000`                 | Per-request decisions timeout in milliseconds, an integer between 100 and 60000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `OPENAI_API_KEY`                  | unset                   | OpenAI API key for `openai-decisions/gpt-6-luna`. Server-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `JEV_API_KEY`                     | unset                   | TypeSafe API key for `typesafe/jev-latest`. Server-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CONNECTOR_VERSION`               | the bundled connector's | The `chopin` release this server recommends: `chopin update` installs it by default, and a refused connector is told to run `chopin update <version>` with it. Defaults to the version in `apps/connector/package.json`. A `cli-v` or `v` prefix is dropped; anything but a version like `0.2.0` fails startup.                                                                                                                                                                                                                                                                                                                                                   |
| `CHOPIN_SETUP_AGENTS`             | unset                   | Setups the Machines page offers before the built-in coding agents, as a JSON array. See [Setup agents](#setup-agents). The supplied Compose file forwards it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `CHOPIN_BUILD_RESUME_MS`          | `600000`                | How long after it starts the server waits for a paired machine to come back and carry on with a build it was running before a restart or deploy, in milliseconds, an integer between 1000 and 3600000. Until then the build stays running and its agent's calls are answered `unavailable`; after it, a build no machine took back ends as disconnected. A machine that registered again without its build has one minute, whatever this is. The connector stops an agent after 10 minutes without reaching Chopin, so a much longer window mostly keeps a build nobody will resume showing as running.                                                           |

[Automatic participation](conversation-initiative.md) is part of the enabled Planner,
with no separate feature flag. The shared Chat control pauses automatic replies per
document. Group turn-taking asks the decisions model; solo replies bypass it.

See [Background jobs and workers](background-jobs.md) for the combined
`AGENT`, `BACKGROUND_JOBS`, and `WEB_RESEARCH` behavior and recovery model.

Foreground Planner writes on every harness and MCP document imports share visual
assessment before acceptance. The decisions model judges whether a faithful
visual is possible and helpful, then selects its native type or a comparison
table. The author must supply the selected visual beside its passage before the
write succeeds. Lists and nested prose are included, and there is no diagram
quota. Failed or uncertain assessments refuse the write. Prose imports require a
decisions model even with `AGENT=off`.

`PLANNER_VISUALS` controls only the legacy single-paragraph tool for sessions
without the shared admission check; it does not disable the shared check.

Conversation-derived cards default to off. When enabled, interpretation sends
current and recent Chat messages and selected decision context to the decisions
model, independently of the Planner's provider and credentials; `AGENT=off` does
not disable it.

The same flag enables independent external-research suggestions in Chat. Their
shared briefs can be synthesized by the `research-brief@1` background worker under
the existing Planner owner; this uses the configured harness provider, separately
from the decisions model. A self-contained source excerpt is the fallback when synthesis is
unavailable. Actual research starts only after a writer accepts the current shared
brief and the execution capability is enabled. See
[Research offers from Chat](conversation-research.md).

The supplied Compose file forwards `CONVERSATION_PLAN`, `PLANNER_VISUALS`,
`DECISIONS_MODEL`, `OPENAI_API_KEY` and `JEV_API_KEY` from the deployment
environment. It uses the server's default 30-second decisions timeout. To
override `DECISIONS_TIMEOUT_MS`, configure it explicitly in the service
environment; the Compose file does not forward an unset optional timeout as an
empty value.

### Decisions

Conversation cards, research offers, group turn-taking, visual routing, and the
living-build and prototype gates ask small typed questions: a yes-or-no
probability, a choice from a fixed set, or a score on ordered levels. One
classifier model answers all of them through Atomic's model registry. The
server checks at startup that `DECISIONS_MODEL` is a classifier the registry
knows and that its provider has a key, and refuses to start otherwise.

Any classifier in the registry works. Examples:

| `DECISIONS_MODEL`                           | Key                                              |
| ------------------------------------------- | ------------------------------------------------ |
| `openai-decisions/gpt-6-luna`               | `OPENAI_API_KEY`                                 |
| `typesafe/jev-latest`                       | `JEV_API_KEY` or `TYPESAFE_API_KEY`              |
| `cloudflare-workers-ai/@cf/cloudflare/clef` | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |

Keys come from the server environment under each provider's usual variable;
see Atomic's
[model docs](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/docs/models.md#use-classifier-models)
for the classifier list. The server never reads Atomic's saved logins. It does
read Atomic's `models.json` from `$ATOMIC_CODING_AGENT_DIR` (default
`~/.atomic/agent`), so a provider's base URL can be overridden there. Requests
send their decision context to the chosen provider and get one attempt each.
`CONVERSATION_INITIATIVE_MODEL` can point group turn-taking at another
classifier.

Generate the encryption key with:

```bash
openssl rand -hex 32
```

The image expects to listen on internal port 8787. Do not override `PORT` in the
supplied image without also replacing its health check and container routing.

### Setup agents

`CHOPIN_SETUP_AGENTS` adds your own setups to the **Coding agent** picker on the
Machines page, before the built-in agents. Only signed-in people see them.
Chopin refuses to start when the value is malformed.

```json
[
	{
		"id": "acme",
		"name": "Acme",
		"install": ["curl -fsSL https://acme.example/install.sh | sh"],
		"command": "acme connect --server {origin} --key {key} --name {name}",
		"keyless": "acme connect --server {origin}",
		"default": true
	}
]
```

| Field     | Value                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------- |
| `id`      | Up to 40 lowercase letters, digits and dashes. Unique, and not a built-in agent's id.              |
| `name`    | What the picker shows, up to 60 characters.                                                        |
| `install` | Up to 20 lines, shown under **Show install steps**.                                                |
| `command` | The command for **Cloud**. It must contain `{key}`.                                                |
| `keyless` | Optional. The command for **Local**, without `{key}`. Without it, only **Cloud** offers the entry. |
| `default` | Optional. `true` on one entry preselects it for anyone who hasn't picked an agent in that browser. |

`install`, `command` and `keyless` also take an object with one value each for
`linux`, `macos` and `windows`. The page fills in `{origin}`, `{key}` and
`{name}`, quoted for the system's shell. With no machine name, it drops `{name}`
and the flag before it.

The entry's command decides how the machine connects, so the page hides **Run in
the background** for it. The list holds at most 10 entries.

## Deploy the Docker image

The `Dockerfile` builds the browser client and one runtime image. The Bun server
serves static assets, HTTP routes, `/mcp`, and `/ws` from the same process. Its
default command applies migrations before starting the server and runs as the
unprivileged `bun` user.

Build an image from a reviewed commit:

```bash
docker build --tag chopin:local .
```

A page left open across a deploy still asks for the files of the build it loaded. The
image keeps the hashed files of the last two builds before it, for 30 days at most, in
`apps/web/kept-assets`, and the server answers for them from there; a file it does not
have is a 404, never the page. To keep them, give the build the image that runs now:

```bash
docker build --build-arg PREVIOUS_IMAGE="$(docker inspect --format '{{.Image}}' chopin)"   --tag chopin:next .
```

With `docker compose`, set `PREVIOUS_IMAGE` in the environment of the build. Without it
the build keeps nothing and only its own files are served. The first build after this
step lands keeps only the image before it, which kept nothing itself.

Create an environment file such as `/etc/chopin/chopin.env`:

```dotenv
STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://<user>:<password>@<database-host>:5432/<database>
APP_ORIGIN=https://chopin.example
GITHUB_APP_SLUG=<app-slug>
GITHUB_APP_CLIENT_ID=<client-id>
GITHUB_APP_CLIENT_SECRET=<client-secret>
GITHUB_ALLOWED_USERS=<comma-separated-logins>
GITHUB_ALLOWED_ORGANIZATIONS=
SESSION_ENCRYPTION_KEY=<64-hex-character-key>
AGENT=on
MODEL=gpt-6.1-sol
HARNESS=copilot-sdk
BACKGROUND_JOBS=on
WEB_RESEARCH=on
```

Restrict that file to the deployment account, then start the image behind a
same-host reverse proxy:

```bash
docker run --detach \
  --name chopin \
  --restart unless-stopped \
  --env-file /etc/chopin/chopin.env \
  --publish 127.0.0.1:8787:8787 \
  chopin:local
```

If the reverse proxy is another container, attach both containers to a private
network instead of publishing the application port. Ensure the database address
in `DATABASE_URL` is reachable from the application container.

### Reverse proxy requirements

The proxy must:

- terminate TLS for the exact `APP_ORIGIN`;
- forward the original `Host` and `Origin` headers;
- proxy WebSocket upgrades on `/ws`, and on `/api/v1/agent` under `HARNESS=remote`;
- proxy `/mcp` and the `/api/v1/agent` upgrade without removing their
  `Authorization` header, nor the upgrade's `Sec-WebSocket-Protocol` header;
- pass Chopin's response headers through unchanged, so a browser can tell Chopin's
  refusal of a WebSocket handshake (`x-chopin-refusal: 1`) from the proxy's own
  4xx while no upstream answers;
- serve Chopin at `/`, not below a path prefix; and
- redirect alternate hosts to the canonical origin before application traffic,
  except the paths a [moved deployment](#moving-to-a-new-origin) keeps serving.

Chopin derives OAuth callbacks from `APP_ORIGIN`, never from incoming `Host` or
forwarded headers. A proxy cannot repair a mismatched configuration after the
process starts.

## Checked-in Compose files

The checked-in Compose files support repository development and the project's
Coolify deployment; they are not a complete generic production stack.

`compose.yaml` publishes no host ports, uses a fixed internal development
database credential, and includes Coolify late-binding variables. The local
commands merge `compose.local.yaml`, which currently publishes application port
8787 and PostgreSQL port 5432 on every host interface:

```bash
bun run db:up      # start only PostgreSQL for source development
bun run docker:up  # build and start the application and PostgreSQL
```

Use those commands only on a trusted, firewalled development machine. Do not
attach `compose.local.yaml` to an internet-facing deployment. Both
`bun run db:down` and `bun run docker:down` tear down the whole Compose project.

Coolify supplies the public proxy and can substitute `SERVICE_NAME_DB` and
`SERVICE_FQDN_APP`. Configure `APP_ORIGIN` as
`https://${SERVICE_FQDN_APP}` and provide all GitHub, admission, model, and
encryption values as runtime variables. Preview-specific late-binding and
credential isolation are described in [PR preview testing](preview-testing.md).

## Deploy from source

A source deployment must build the client, apply migrations, and start the
server as three distinct operations:

```bash
bun install --frozen-lockfile
bun run build
bun run migrate
exec bun apps/server/src/main.ts
```

All runtime configuration, including the GitHub App values, is required by the
migration command. `bun run start` starts the server but does not build the
client or migrate the database. A missing client build allows the API process to
start while the browser route returns 404.

Run the direct server command under a process manager that restarts it after any
unexpected exit. Some fatal runtime paths drain successfully and exit with code
zero, so a policy equivalent to `Restart=on-failure` is insufficient.

## Local device-flow sign-in

`AUTH_MODE=local` is a single-machine mode for evaluating Chopin without an
operator-managed GitHub App client secret. It is not an alternative deployment
topology: it requires a loopback `SERVER_HOST` and `APP_ORIGIN`, so it cannot
be reached from another machine, and it is incompatible with the Docker image,
which sets `SERVER_HOST=0.0.0.0`. Run it from a source checkout:

```bash
bun install --frozen-lockfile
bun run build
AUTH_MODE=local APP_ORIGIN=http://127.0.0.1:8787 GITHUB_APP_SLUG=<app-slug> \
  GITHUB_APP_CLIENT_ID=<client-id> SESSION_ENCRYPTION_KEY=<64-hex-character-key> \
  DATABASE_URL=<database-url> bun run migrate
AUTH_MODE=local APP_ORIGIN=http://127.0.0.1:8787 GITHUB_APP_SLUG=<app-slug> \
  GITHUB_APP_CLIENT_ID=<client-id> SESSION_ENCRYPTION_KEY=<64-hex-character-key> \
  DATABASE_URL=<database-url> exec bun apps/server/src/main.ts
```

`GITHUB_APP_CLIENT_SECRET` is not read in this mode. Enable device flow on the
App instead of the client-secret authorization-code flow described above, and
keep expiring user authorization tokens enabled. The browser shows GitHub's
device code, persists the resulting credential to the OS credential store or,
with explicit consent, a local plaintext file, and restores that login after a
restart without a fresh device-flow prompt. See
[Local device-flow sign-in](authentication.md#local-device-flow-sign-in) for
the complete flow, the plaintext-consent warning text, file permissions, and
the restart-restore and logout model.

Local logout deletes the persisted credential; it does not revoke the GitHub
App authorization, because device-issued refresh tokens can be refreshed
without the client secret but GitHub's revocation endpoint requires it. Remove
the App from **Settings > Applications** on GitHub to revoke it there.

## First-start smoke test

Startup validates configuration, database connectivity, migration history, the
exclusive writer lease, and the configured harness (unknown `HARNESS`, or a
host-login `HARNESS_AUTH` fallback on a non-loopback bind, refuse before the
process serves traffic). It does not fully validate the GitHub App, Copilot
entitlement, model, or lazy Planner runtime.

After the first deployment:

1. Confirm the process reports the intended restricted or unrestricted admission
   policy.
2. Complete GitHub sign-in and return to the exact configured origin.
3. Install the App on one non-sensitive test repository.
4. Confirm the picker lists only expected installations and repositories.
5. Create a channel with a user who has push or administration access.
6. Open the channel in a second browser and verify presence and live edits.
7. Send one `@chopin` request to verify model access (the owner's Copilot
   entitlement for `copilot-sdk`, or the `HARNESS_AUTH` credentials for
   `atomic`)
   and the hosted agent runtime.
8. Run `/research` with a short brief to verify public web search. It reaches
   GitHub's Copilot MCP endpoint with the signed-in user's App user access
   token, a separate check from step 7.
9. Connect a local coding agent and call `list_documents` if MCP is part of the
   deployment's intended surface.

The image health check calls `/api/health/live`. It confirms HTTP liveness, and
passes for a process waiting in standby too, but does not prove that a browser
bundle is present, a new database transaction can complete, GitHub is reachable,
or the Planner can start; readiness (below) covers the first two.

Two unauthenticated endpoints answer with a status word and nothing else, for a
proxy or platform that routes on them:

- `GET /api/health/live` answers `200 live` while the process runs, and
  `200 standby` while a process started with `HANDOVER=wait` waits for the
  writer lease.
- `GET /api/health/ready` answers `200 ready` once the process holds the writer
  lease, has finished startup recovery, a database transaction has completed
  and the built client's `index.html` exists. It answers `503 standby` while it
  waits for the lease, `503 starting` before it is ready, and `503 draining`
  from the start of a shutdown's cut, not from SIGTERM: a stopping process keeps
  answering `200 ready` and keeps serving while running Planner turns finish
  (`HANDOVER_TURN_WAIT_MS`). It decides this once, when it becomes ready, so a
  check runs no query.

Send new connections only to a ready process. Readiness does not check that
GitHub is reachable or that a model answers. Both endpoints answer `HEAD` the
same way.
A proxy that routes on them, and the deploy that overlaps two processes, are described
in [Deploys nobody can see](zero-downtime-deploys.md).

## Operations

### Backups and restore

PostgreSQL is the durable system of record. Back up the complete database with
the database provider's consistent backup mechanism; copying only selected
tables or the application container is not sufficient. Regularly test restore
into an isolated database before relying on the backup.

Stop Chopin before replacing a database from a backup. Starting against the
restored database validates migration checksums and acquires a new writer lease.
Browser sessions and Planner ownership are cleared at startup.

### Upgrades

1. Back up the database and retain the currently deployed image.
2. Stop the existing application process.
3. Start the new image against the same database; its entrypoint applies pending
   migrations before serving.
4. Repeat the first-start checks after migrations or authentication changes.

This stops the old process before it starts the new one, so there is a gap in which nothing
listens, and a tab shows its notice if the gap outlasts its quiet period (below). To make a
deploy invisible instead, start the new process beside the old one with `HANDOVER=wait`
and stop the old one once the new one is waiting, behind a proxy that holds requests for
that moment: see [Deploys nobody can see](zero-downtime-deploys.md). Migrations must then be
expand-only.

A stop signal makes Chopin close every WebSocket with code 1012 (service
restart) before it exits, rather than the 1001 that stopping the listener
sends. An open browser tab takes that as a restart: it reconnects after a
random moment of up to a second and goes on retrying about once a second, says
nothing about it for the first 5 seconds, and keeps its unacknowledged edits,
drafts and answers to send once connected. In those 5 seconds the connection
reports no outage, so the notice for a lost connection does not wait on a
shorter count, and the attempts that fail meanwhile are not counted towards
the backoff or towards offering Retry. A restart that lasts longer is then
treated as any other lost connection, with the same moment of grace before
the notice. A refusal Chopin makes of a handshake carries
`x-chopin-refusal: 1`, and a tab stops retrying on a 4xx only when it does (a
401 still asks for a sign-in). Without it the 4xx is a proxy's and the tab keeps
retrying. This is the client half of a restart that stops the old process before it
starts the new one, and it does not make the gap between them any shorter. It
adds a random moment before the first attempt so that tabs do not all return
together, and keeps a restart quiet for 5 seconds rather than 1.5, because that
kind of restart takes longer than 1.5 seconds. A deploy that overlaps two
processes behind a proxy that holds requests ends well inside 1.5 seconds; see
[Deploys nobody can see](zero-downtime-deploys.md).

A tab opened before an upgrade asks for the hashed `/assets/*` files of its own
build, which the new image carries only if it was built with `PREVIOUS_IMAGE`. Chopin answers a missing file under `/assets/` with 404 and never with the
app's HTML. When a part of the page fails to load for that reason (Vite's
`vite:preloadError`), the tab reloads to fetch the new build, but only while the
server answers with a page of another build than the one running (it asks for the
page and compares the entry script, so a failure with the server away, or with no
upgrade behind it, is left to the page's own recovery) and it holds nothing the
server has not taken: no unacknowledged edit, unsent message, answer or draft.
Otherwise it leaves the failure as it was and a later one reloads it, and a reload
that did not cure the failure is not repeated within ten seconds. A build given the
image that runs now (`PREVIOUS_IMAGE`, above) keeps the previous builds' files, so
such a tab usually carries on without reloading.

Migration files are checksummed once applied. Never edit an applied migration.
Because migrations are forward-only, returning to an older application image
may require restoring the pre-upgrade database rather than merely changing the
image tag.

### Moving to a new origin

Paired machines' GitHub authorizations and browser logins are encrypted for the
origin they were stored under, so changing `APP_ORIGIN` alone signs everyone out
and makes every machine run `chopin pair` again. To move a deployment from
`https://old.example.com` to `https://new.example.com` instead:

1. Add `https://new.example.com/auth/github/callback` to the GitHub App's
   callback URLs, keeping the old one, and point its Homepage and Setup URLs at
   the new origin.
2. Serve the new name, and keep serving the old one. On the old name, keep
   proxying `/mcp`, `/api`, `/connector*`, `/auth/github/callback`, and
   `/auth/github/setup` to Chopin, because paired machines, MCP clients, and
   GitHub still use it; redirect browsers on other paths to the new name.
3. Restart with `APP_ORIGIN=https://new.example.com` and
   `PREVIOUS_ORIGINS=https://old.example.com`.

A machine or browser login stored under a previous origin is re-encrypted under
`APP_ORIGIN` the first time it is used, and the server logs once per kind that
it moved one. Browser cookies belong to a host, so people sign in once on the
new name. Origin and WebSocket checks accept the previous origins, and document
links on them resolve to the same documents; Chopin itself only writes links on
`APP_ORIGIN`. A sign-in that was in progress when the deployment restarted has
to start again.

Remove `PREVIOUS_ORIGINS` once machines have reconnected and you stop serving
the old name. Never list an origin you no longer control: its pages would pass
Chopin's Origin checks.

### Machines and the connector sandbox

`chopin connect` runs agents and Planner commands in the operating system's
process sandbox where the machine has one (see
[Sandbox](chopin-cli.md#sandbox)). Nothing to configure here: the server only
keeps what each connector says about its own sandbox, in three additive request
headers (`chopin-connector-sandbox`, `-reason` and `-fix`), and the Machines page
shows it as **Sandboxed** or **Not sandboxed**, with the reason and the one fix
for a machine that has none. An older connector sends none, and an older server
ignores them.

The sandbox lets agents reach your instance's origin, GitHub, the model
providers and the npm, PyPI and crates registries, and nothing else. A
self-hosted deployment whose agents also need an internal registry, a Git mirror
or another model endpoint adds each host on the machine, with
`chopin connect --sandbox-host <host>`, and runs `chopin service install` again
for a service. An instance behind another origin needs nothing: the connector
allows the origin it connected to. `--require-sandbox` refuses runs on a machine
with no sandbox, which an operator may want to ask of the people who share
machines.

### Writer lease

The database holds one renewable `chopin:writer` lease. A second application
process refuses startup, unless it was started with `HANDOVER=wait`, which makes it
wait in standby until the holder releases the lease (see
[Deploys nobody can see](zero-downtime-deploys.md)). If the active process loses the
lease, it drains and stops; fencing prevents an expired process from committing
collaboration state. Allow the previous lease to expire (30 seconds after its last
renewal) before treating a failed host as safely replaced.

## Troubleshooting

**OAuth returns to an error page.** Confirm `APP_ORIGIN`, the callback URL, and
the browser origin match exactly. A trailing slash or reverse-proxy hostname
change requires a configuration restart and corresponding GitHub App update.

**No repositories appear.** Authorization and installation are separate. Check
that the App is installed on the repository, the signed-in user can access that
installation, and any new permission is approved by the organization owner.

**Organization admission is temporarily unavailable.** Confirm the App has
Members read access, the organization approved it, and the user has active
membership. GitHub outages and rate limits fail closed for new checks.

**A second process refuses startup.** Another holder owns the database writer
lease. Do not run two application instances against one database. To start a
process beside the holder on purpose, set `HANDOVER=wait`; it waits in standby and
serves nothing until the holder stops.

**The process refuses startup with an unknown-harness or auth-mode error.**
`HARNESS` names an adapter that is not in Chopin's harness map, or
`HARNESS_AUTH` falls back to a host-logged-in subscription while
`SERVER_HOST` is not loopback-only. Fix `HARNESS`/`HARNESS_AUTH` or bind the
process to loopback for local-only use. See [Choose and trust a harness](#choose-and-trust-a-harness).

**The UI returns 404 while APIs respond.** The source deployment did not build
`apps/web/dist`, or the runtime image was assembled incorrectly.

**The first model-backed action fails.** Check the invoking user's Copilot
entitlement, the model, App permissions, repository write access, and Copilot
CLI startup logs. Planner and research request execution validate these
dependencies lazily.

**Public web research fails before it searches.** `/research` finds public sources through
the `web_search` tool of GitHub's Copilot MCP endpoint (`https://api.githubcopilot.com/mcp/`).
It authorizes with the signed-in user's App user access token (`ghu_`), the same credential the
Planner's pull request tools send to that endpoint. When setup fails, the research card says
which of three things happened and the server log names the step and the cause:

- `web-search-credential-rejected`: "GitHub refused the credential from this sign-in for public
  web search." The endpoint answered HTTP 401 or 403 while connecting or listing tools.
- `web-search-not-offered`: "GitHub did not offer public web search to this sign-in." The endpoint
  accepted the connection, but its tool list had no `web_search`.
- `web-search-unavailable`: "The public web-search service was unavailable." Any other setup
  failure, such as a network error, an HTTP 5xx, or a JSON-RPC error.

The log line names the step (`connect` or `tools`), a classification with any HTTP status and
JSON-RPC code, how long setup ran, the type of credential Chopin sent, and the client's error
with tokens and `Bearer` values masked and clipped to one short line. It never contains the token
or the `Authorization` header:

```text
chopin: web_search unavailable at connect - local:connect:mcp-client:http:401 in 180ms; credential: GitHub App user access token (ghu_); MCPClientError: ...
```

The `elapsedMs` on the `connecting-web` progress line records when that phase began, not when it
failed; read the duration from the failure line.

Chopin cannot tell from these responses why the endpoint refused the credential or withheld the
tool. GitHub's Copilot SDK documentation lists GitHub App user access tokens (`ghu_`) as supported
for Copilot requests, but GitHub documents no token requirement for this endpoint's `web_search`
tool, and the tool is not part of GitHub's open-source MCP server. A deployment that signs in
through its own GitHub App reported this step failing while a classic OAuth token (`gho_`) for the
same account was accepted by the endpoint's `initialize` request. Whether the endpoint refuses
App user access tokens for `web_search` is unconfirmed.

Check the log line first, then the account's Copilot entitlement and the settings that gate web
search and MCP servers for the user and, in an organization, its Copilot policies. No Chopin
setting sends a different credential to this endpoint. If setup keeps failing, set
`WEB_RESEARCH=off` to stop offering public web research until you have verified it, and report
the log line, which holds no token.

**MCP returns 401 or 403.** A 401 indicates an invalid or expired bearer. A 403
indicates failed instance admission or a supplied Origin that differs from
`APP_ORIGIN`. Repository authorization failures normally arrive as an MCP tool
error with reason `repository-forbidden`. See
[Local agent MCP](local-agent-mcp.md) for client-specific guidance.

## Related references

- [Authentication](authentication.md)
- [Hosted agent (Planner)](hosted-agent.md)
- [Local agent MCP](local-agent-mcp.md)
- [Storage](storage.md)
- [Repository channels](channels.md)
- [exe.dev development](exe-dev.md)
