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
wrapper over `@github/copilot-sdk`; `pi` is a second reviewed adapter over
`@ai-sdk/harness-pi`; and `atomic` embeds Atomic's headless SDK
(`@bastani/atomic`) in the server process. Adding an adapter to that map is a
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

`HARNESS=pi` requires an explicit `HARNESS_AUTH`: unset is refused outright.
Pi's own documented modes are `auto`, `openai`, `anthropic`, `custom`, and
`ai-gateway`; `direct` is not one of them and is refused. On a non-loopback
`SERVER_HOST`, only `ai-gateway` is accepted, because every other mode can
fall back to Pi's native `~/.pi/agent` login. `ai-gateway` reads
`AI_GATEWAY_API_KEY` (or `VERCEL_OIDC_TOKEN`), `openai` reads `OPENAI_API_KEY`,
`anthropic` reads `ANTHROPIC_API_KEY`, and `custom` forwards every `*_API_KEY`
and `*_BASE_URL` variable. With `auto` on loopback, turns use the host
operator's own Pi login; with an operator key, every admitted writer's turns
bill that key.

Under `pi`, the channel owner supplies only the GitHub App user token; model
access comes from `HARNESS_AUTH`, not from the owner's Copilot entitlement.
Repository reads still come from that GitHub token through Chopin's own host
tools, never through Pi.

Under `pi`, `MODEL` is required and must be an ID from Pi's model catalog,
preferably provider-qualified (for example `github-copilot/gpt-5.6-luna`).
Chopin's default, `gpt-6-luna`, is a Copilot ID that Pi does not recognize.
Unpatched Pi silently falls back to another model for an unknown ID; Chopin's
patch to `@ai-sdk/harness-pi` 1.0.128 fails the turn instead, so the startup
banner always names the model Pi runs.

The same patch stops Pi's resource loader from reading `AGENTS.md` or
`CLAUDE.md` context files from the session's working directory, its parent
directories, or Pi's agent directory on the host. Both changes live in
`patches/@ai-sdk%2Fharness-pi@1.0.128.patch`; reapply or drop them when bumping
`@ai-sdk/harness-pi`, and run the Pi contract suite
(`apps/server/src/harness/pi.contract.test.ts`), which covers both.

`@ai-sdk/harness-pi` 1.0.128 cannot return structured output itself, so
Chopin registers a result tool as an inline Pi extension. The tool runs inside
Pi and ends the turn (`terminate: true`), so the summary and research workers
get their structured result without a follow-up model request. The adapter
enables the tool only for a turn that requests structured output and blocks it
on every other turn. Prompt text, including quoted earlier chat, cannot enable
it. The Pi contract suite (`apps/server/src/harness/pi.contract.test.ts`)
covers this against the real Pi agent loop; run it before bumping
`@ai-sdk/harness-pi` or `@earendil-works/pi-coding-agent`.

`HARNESS=atomic` runs Atomic 0.9.25 in the Chopin server process through its
headless SDK (`createAgentSession()`). It does not spawn the `atomic` CLI, use
RPC mode, or substitute Atomic for Pi's runtime.

**Choosing `HARNESS=atomic` gives the Planner shell and filesystem access as the
server process's user, on hosted instances as well as local ones.** Every Planner
session is a full Atomic session: Atomic's workflows, subagents, MCP, web access,
Intercom, and default coding tools run beside Chopin's document tools, with the
operator's Atomic extensions, skills, prompt templates, and context files. There is
no separate flag; choosing the harness is the choice. Operators who do not want that
should use `copilot-sdk` or `pi`, whose Planner keeps the isolated, Chopin-tools-only
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

Structured output uses the same approach as Pi: an inline Atomic extension
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

Without a remembered checkout that still verifies, the session runs in an empty
working directory that Chopin creates for that document alone under the operating
system's temporary directory, with mode `0700`. It is never shared with another
document, keeps what the Planner writes there for later sessions of the same
document, and is removed when the server shuts down cleanly. The session has the
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

## Prerequisites

- Docker for the application image, or Bun 1.4.2 for a source deployment.
- A reachable PostgreSQL database and credentials with schema migration access.
- A stable DNS name with TLS termination and WebSocket proxying.
- Outbound HTTPS access to GitHub and the selected harness's model provider
  (the hosted Copilot service for `copilot-sdk`).
- If `CONVERSATION_PLAN=on`, outbound HTTPS access to TypeSafe's Jev service
  (`api.typesafe.ai`) and a server-side `JEV_API_KEY`, separate from the Planner's
  harness credentials.
- A GitHub App owned by the deployment.
- At least one user with repository push or administration access.
- For `copilot-sdk`, an active Copilot entitlement for each user who may own a
  hosted agent session. For `pi` or `atomic`, model credentials for the chosen
  `HARNESS_AUTH` mode instead.

## Register the GitHub App

Create one GitHub App per deployment. Register the exact public origin:

```text
Homepage URL: <APP_ORIGIN>
Callback URL: <APP_ORIGIN>/auth/github/callback
Setup URL:    <APP_ORIGIN>/auth/github/setup
```

Enable expiring user authorization tokens, leave OAuth during installation
disabled, disable webhooks, and make the App installable on any account. Leave
device flow disabled unless this deployment also uses local device-flow
sign-in (below), which requires enabling it instead. The complete product
uses these read-only repository permissions:

```text
Contents:        Read-only
Pull requests:   Read-only
Checks:          Read-only
Commit statuses: Read-only
Metadata:        Read-only (automatic)
```

Organization admission additionally requires organization Members read access
and owner approval on every admitted organization. See
[Authentication](authentication.md) for the complete identity, installation,
session, and authorization model.

## Runtime configuration

Store production values in the deployment's secret manager or an owner-readable
environment file outside the source tree. Do not bake `.env` or credentials into
the image.

| Variable                       | Default               | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STORAGE_DRIVER`               | `postgres`            | Storage adapter. `postgres` is currently the only accepted value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DATABASE_URL`                 | required              | `postgres:` or `postgresql:` connection URL. It is not printed by Chopin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `APP_ORIGIN`                   | required              | Exact public origin, without credentials, path, query, fragment, or trailing slash. HTTPS is required unless the host is loopback.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GITHUB_APP_SLUG`              | required              | Lowercase slug from the App's public URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GITHUB_APP_CLIENT_ID`         | required              | OAuth client ID, not the numeric GitHub App ID.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GITHUB_APP_CLIENT_SECRET`     | required (hosted)     | OAuth client secret used for user-token exchange and refresh. Unused when `AUTH_MODE=local`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GITHUB_ALLOWED_USERS`         | empty                 | Comma-separated admitted GitHub logins.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GITHUB_ALLOWED_ORGANIZATIONS` | empty                 | Comma-separated organizations whose active members are admitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SESSION_ENCRYPTION_KEY`       | required              | Exactly 64 hexadecimal characters. Encrypts the OAuth attempt cookie in hosted mode; local mode requires the configured key but uses separate unpredictable, HttpOnly attempt and browser-binding cookies.                                                                                                                                                                                                                                                                                                                                         |
| `AUTH_MODE`                    | `hosted`              | Set `local` for loopback device-flow sign-in with persisted credentials (see [Authentication](authentication.md#local-device-flow-sign-in)). Any other value fails startup.                                                                                                                                                                                                                                                                                                                                                                        |
| `CHOPIN_LOCAL_CREDENTIALS_DIR` | platform default      | Local mode only. Overrides the plaintext-fallback credential directory (default `~/.config/chopin` on Linux, `~/Library/Application Support/Chopin` on macOS, `%APPDATA%\Chopin` on Windows). Must resolve outside the repository and process working directory.                                                                                                                                                                                                                                                                                   |
| `SERVER_HOST`                  | `127.0.0.1`           | Source-process bind address. The image sets `0.0.0.0`, which local mode refuses. A `HARNESS_AUTH` mode that falls back to a host-logged-in subscription is refused unless this stays loopback-only.                                                                                                                                                                                                                                                                                                                                                |
| `PORT`                         | `8787`                | Source-process HTTP and WebSocket port. The supplied image and health check expect internal port 8787.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MODEL`                        | `gpt-6-luna`          | Model requested for hosted agent sessions. Required under `HARNESS=pi` and `HARNESS=atomic`; under `atomic` it must be `provider/model` from Atomic's catalog.                                                                                                                                                                                                                                                                                                                                                                                     |
| `HARNESS`                      | `copilot-sdk`         | Adapter name selected from Chopin's harness map (`copilot-sdk`, `pi`, or `atomic`). An unknown name refuses at startup. `atomic` gives every Planner session shell and filesystem access as the server process's user, hosted instances included; see [Choose and trust a harness](#choose-and-trust-a-harness).                                                                                                                                                                                                                                   |
| `HARNESS_AUTH`                 | unset                 | Auth mode forwarded to the selected adapter. For `copilot-sdk`, `direct` and `ai-gateway` are allowed on any bind and `auto` requires a loopback-only `SERVER_HOST`; the adapter does not otherwise consume it. For `pi`, it is required: `auto`, `openai`, `anthropic`, and `custom` require a loopback-only `SERVER_HOST`, only `ai-gateway` is allowed otherwise, and `direct` is always refused. For `atomic`, it is required and must be `auto`, which requires a loopback-only `SERVER_HOST`, or `ai-gateway`; every other value is refused. |
| `AGENT`                        | on                    | Set exactly `off` to prevent hosted agent turns, disable the entire background-job runner, and avoid Copilot CLI startup.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `BACKGROUND_JOBS`              | on                    | Set exactly `off` to disable background job scheduling. `AGENT=off` disables the entire runner.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `WEB_RESEARCH`                 | on                    | Set exactly `off` to disable new public-web research while retaining durable requests, artifacts, and other jobs.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `COPILOT_CLI_PATH`             | automatic             | Advanced override for the Copilot CLI executable. Applies only to the `copilot-sdk` adapter.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CONVERSATION_PLAN`            | off                   | Set exactly `on` to enable experimental conversation-derived cards. Interpretation runs independently of `AGENT`; Planner jobs still obey the agent and job settings.                                                                                                                                                                                                                                                                                                                                                                              |
| `JEV_MODEL`                    | `jev-latest`          | Model alias for conversation interpretation. Independent of the hosted Planner's `MODEL`.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `JEV_TIMEOUT_MS`               | `30000`               | Per-request interpretation timeout in milliseconds, an integer between 100 and 60000.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `JEV_API_KEY`                  | required when enabled | Server-side Jev API key. Required at startup when `CONVERSATION_PLAN=on`; never send it to the browser.                                                                                                                                                                                                                                                                                                                                                                                                                                            |

See [Background jobs and workers](background-jobs.md) for the combined
`AGENT`, `BACKGROUND_JOBS`, and `WEB_RESEARCH` behavior and recovery model.

Conversation-derived cards default to off. When enabled, interpretation sends
current and recent Chat messages and selected decision context to TypeSafe's Jev
service. It uses `JEV_API_KEY` and `JEV_MODEL` independently of the Planner's
provider and credentials; `AGENT=off` does not disable it.

The supplied Compose file forwards `CONVERSATION_PLAN`, `JEV_MODEL` and
`JEV_API_KEY` from the deployment environment. It uses the server's default
30-second interpretation timeout. To override `JEV_TIMEOUT_MS`, configure it
explicitly in the service environment; the Compose file does not forward an
unset optional timeout as an empty value.

Generate the encryption key with:

```bash
openssl rand -hex 32
```

The image expects to listen on internal port 8787. Do not override `PORT` in the
supplied image without also replacing its health check and container routing.

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
- proxy WebSocket upgrades on `/ws`;
- proxy `/mcp` without removing its `Authorization` header;
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
   entitlement for `copilot-sdk`, or the `HARNESS_AUTH` credentials for `pi` or
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
