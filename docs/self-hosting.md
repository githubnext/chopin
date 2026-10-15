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
  scaling and zero-downtime rolling deployment are not supported.
- PostgreSQL 17 is the version used by the repository and browser tests. Other
  versions are not covered by the project test suite.
- Database migrations are forward-only. There is no automated schema rollback.
- Restarting the application signs every browser out and releases hosted agent
  ownership. Documents, transcripts, decisions, background jobs and artifacts,
  research request staging, child documents, and implementation state remain.
  In local mode (see below), the returning browser can restore the same login
  without repeating device-flow sign-in; it still gets a new session and does
  not reclaim Planner ownership.

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

`HARNESS=atomic` runs Atomic 0.9.37 in the Chopin server process through its
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
- Under `auto`, refreshing an OAuth token in memory can rotate the refresh token
  stored by the host CLI, which may then ask the operator to sign in again.
  `auto` also runs `!command` API-key entries in `auth.json` to resolve them.
- There is no per-session credit limit like Copilot's, so a worker's
  `maxAiCredits` does not apply. Use the provider's spend limits.
- `@bastani/atomic` adds more than 250 MB of installed dependencies on Linux
  x64, including glibc and musl native modules and the embedded PostgreSQL
  that only Atomic workflows use. Expect a larger image.
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
question limits. A request nobody answers within 30 minutes expires: its cards
stay in Decisions marked as expired, and Atomic receives no answer. Cancellation
withdraws pending cards; neither ever approves an action. See
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
bind to a public interface. Startup refuses `HARNESS_AUTH` and requires
`BACKGROUND_JOBS=off`, because the summary and research workers would have no
model. The route exists only with `AGENT` on and `HARNESS=remote`.

The trust boundary moves to whoever attaches. A client authenticates with a
GitHub token bearer, checked like hosted MCP, and needs push or administration
access to the document's repository, rechecked before every session and turn and
every 5 minutes while it stays attached. The same account must have signed in to
this server in a browser: attaching makes that login the document's Planner
owner, one client per document, and a detached or dropped connection keeps it for
`PLANNER_ATTACH_GRACE_MS` so the same account can reattach. The server pings
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
client, `@chopin` and `invoke_planner` are refused with `planner-not-attached`
and instructions to attach one. See
[Remote Planner](hosted-agent.md#remote-planner) for the behaviour and
[Agent connection](agent-connection.md) for the wire format. The connection shares the
application's origin and port with `/ws` and `/mcp`, so a TLS-terminating proxy
such as Caddy needs no extra listener; its default `reverse_proxy` already passes
WebSocket upgrades with their `Sec-WebSocket-Protocol` and `Authorization`
headers.

## Prerequisites

- Docker for the application image, or Bun 1.4.2 for a source deployment.
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
| `MODEL`                           | `gpt-6-luna`            | Model requested for hosted agent sessions. Required under `HARNESS=atomic`, where it must be `provider/model` from Atomic's catalog. Optional under `HARNESS=remote`, where the attached client chooses its model and a set value is only passed along as the turn's request.                                                                                                                                                                                                                                                                                                                                                                                     |
| `HARNESS`                         | `copilot-sdk`           | Adapter name selected from Chopin's harness map (`copilot-sdk`, `atomic`, or `remote`). An unknown name refuses at startup. `remote` runs Planner turns in a client attached at `/api/v1/agent`; see [The remote Planner](#the-remote-planner). `atomic` gives every Planner session shell and filesystem access as the server process's user, hosted instances included; see [Choose and trust a harness](#choose-and-trust-a-harness).                                                                                                                                                                                                                          |
| `PLANNER_ATTACH_GRACE_MS`         | `120000`                | Under `HARNESS=remote`, how long a detached or dropped agent connection keeps the document's Planner ownership so the same account can reattach, in milliseconds, an integer between 0 and 3600000.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `AGENT_CONNECTION_PING_MS`        | `15000`                 | Under `HARNESS=remote`, how often the server sends each agent connection a WebSocket protocol ping, in milliseconds, an integer between 1000 and 600000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `AGENT_CONNECTION_TIMEOUT_MS`     | `120000`                | Under `HARNESS=remote`, how long an agent connection may send nothing, not even a pong, before the server closes it as dropped, in milliseconds, an integer between 1000 and 600000 and longer than `AGENT_CONNECTION_PING_MS`. A whole frame must arrive within it: 2 MiB in 120 seconds is about 17 KiB/s of client upload.                                                                                                                                                                                                                                                                                                                                     |
| `AGENT_CONNECTION_MAX_SILENCE_MS` | `900000`                | Under `HARNESS=remote`, how long an agent connection may send nothing at all, not even a pong, before the server closes it as dropped, however much of what the server queued for it drains meanwhile, in milliseconds, an integer between 1000 and 3600000 and at least `AGENT_CONNECTION_TIMEOUT_MS`. A draining queue defers the timeout only up to this, since a proxy can drain it while the client reads nothing. The 15-minute default lets a client reading at about 19 KiB/s drain the full 16 MiB the server may queue for it and answer a ping; lower it to release a client that stopped reading behind a proxy sooner, or raise it for slower links. |
| `HARNESS_AUTH`                    | unset                   | Auth mode forwarded to the selected adapter. For `copilot-sdk`, `direct` and `ai-gateway` are allowed on any bind and `auto` requires a loopback-only `SERVER_HOST`; the adapter does not otherwise consume it. For `atomic`, it is required and must be `auto`, which requires a loopback-only `SERVER_HOST`, or `ai-gateway`; every other value is refused. For `remote`, any value is refused.                                                                                                                                                                                                                                                                 |
| `HARNESS_EXTENSIONS`              | unset                   | Extension or package paths every atomic Planner session loads, as Atomic's `--extension` flag would, separated by the platform path delimiter (`:`, or `;` on Windows). A package's extensions, skills, and workflows all register. Each path must be absolute and exist; any other harness refuses the variable at startup. Background workers never load them. The code runs in the server process as its user.                                                                                                                                                                                                                                                 |
| `AGENT`                           | on                      | Set exactly `off` to prevent hosted agent turns, disable the entire background-job runner, and avoid Copilot CLI startup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `BACKGROUND_JOBS`                 | on                      | Set exactly `off` to disable background job scheduling. `AGENT=off` disables the entire runner. `HARNESS=remote` requires `off`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `WEB_RESEARCH`                    | on                      | Set exactly `off` to disable new public-web research while retaining durable requests, artifacts, and other jobs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `COPILOT_CLI_PATH`                | automatic               | Advanced override for the Copilot CLI executable. Applies only to the `copilot-sdk` adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CONVERSATION_PLAN`               | off                     | Set exactly `on` to enable experimental conversation-derived cards. Interpretation runs independently of `AGENT`; Planner jobs still obey the agent and job settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PLANNER_VISUALS`                 | off                     | Set exactly `on` to enable the bounded visual handoff for foreground Planner turns. Requires `AGENT=on` and a decisions model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DECISIONS_MODEL`                 | from the key present    | The classifier that answers every decision, as an exact Atomic `provider/id`. Unset, it is `typesafe/jev-latest` when `JEV_API_KEY` or `TYPESAFE_API_KEY` is set, otherwise `openai-decisions/gpt-6-luna` when `OPENAI_API_KEY` is set. See [Decisions](#decisions).                                                                                                                                                                                                                                                                                                                                                                                              |
| `DECISIONS_TIMEOUT_MS`            | `30000`                 | Per-request decisions timeout in milliseconds, an integer between 100 and 60000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `OPENAI_API_KEY`                  | unset                   | OpenAI API key for `openai-decisions/gpt-6-luna`. Server-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `JEV_API_KEY`                     | unset                   | TypeSafe API key for `typesafe/jev-latest`. Server-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `CONNECTOR_VERSION`               | the bundled connector's | The `chopin` release this server recommends: `chopin update` installs it by default, and a refused connector is told to run `chopin update <version>` with it. Defaults to the version in `apps/connector/package.json`. A `cli-v` or `v` prefix is dropped; anything but a version like `0.2.0` fails startup.                                                                                                                                                                                                                                                                                                                                                   |
| `CHOPIN_SETUP_AGENTS`             | unset                   | Setups the Machines page offers before the built-in coding agents, as a JSON array. See [Setup agents](#setup-agents). The supplied Compose file forwards it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

[Automatic participation](conversation-initiative.md) is part of the enabled Planner,
with no separate feature flag. The shared Chat control pauses automatic replies per
document. Group turn-taking asks the decisions model; solo replies bypass it.

See [Background jobs and workers](background-jobs.md) for the combined
`AGENT`, `BACKGROUND_JOBS`, and `WEB_RESEARCH` behavior and recovery model.

`PLANNER_VISUALS` defaults to off. Set it exactly to `on` alongside `AGENT=on`
to enable the bounded foreground visual handoff. The decisions model makes
three decisions for each assessed paragraph: whether visualization is possible,
whether it improves comprehension, and which SeeCode type or table fits. The
Planner writes and validates the selected visual. This experimental path
currently accepts one explanatory paragraph per edit, optionally followed by
its selected visual; headings can be separate edits. Lists and nested MDX
paragraphs are not yet supported in a routed edit.

Routing is limited to explicit member requests of at most 1,000 characters under
`copilot-sdk`. Comment turns, longer member requests, background
jobs, and `atomic` sessions retain their ordinary authoring behavior. Atomic's
retained workflow sessions are outside this disposable-session prototype.

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

| Field     | Value                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`      | Up to 40 lowercase letters, digits and dashes. Unique, and not a built-in agent's id.                             |
| `name`    | What the picker shows, up to 60 characters.                                                                       |
| `install` | Up to 20 lines, shown under **Show install steps**.                                                               |
| `command` | The command for **Server or VM**. It must contain `{key}`.                                                        |
| `keyless` | Optional. The command for **Your computer**, without `{key}`. Without it, only **Server or VM** offers the entry. |
| `default` | Optional. `true` on one entry preselects it for anyone who hasn't picked an agent in that browser.                |

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
MODEL=gpt-6-luna
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
- serve Chopin at `/`, not below a path prefix; and
- redirect alternate hosts to the canonical origin before application traffic.

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
8. Connect a local coding agent and call `list_documents` if MCP is part of the
   deployment's intended surface.

The image health check calls `/api/session`. It confirms HTTP liveness but does
not prove that a browser bundle is present, a new database transaction can
complete, GitHub is reachable, or the Planner can start.

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

Migration files are checksummed once applied. Never edit an applied migration.
Because migrations are forward-only, returning to an older application image
may require restoring the pre-upgrade database rather than merely changing the
image tag.

### Writer lease

The database holds one renewable `chopin:writer` lease. A second application
process refuses startup. If the active process loses the lease, it drains and
stops; fencing prevents an expired process from committing collaboration state.
Allow the previous lease to expire before treating a failed host as safely
replaced.

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
lease. Do not run two application instances against one database.

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
