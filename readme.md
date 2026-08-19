# chopin

A collaborative plan, written by a team and an agent together.

Several people edit one MDX document at once, with cursors and presence. A
planning agent reads the selected GitHub repository, writes into the same
document, and asks the channel when something cannot be settled from the code
alone. Answers are attributed to the GitHub user who made them and linked to the
prose they produced.

## Running it

Chopin requires Bun 1.3.2, PostgreSQL, and a GitHub App. The Bun version matches
CI and the production image; verify it with `bun --version`. Register these URLs
on a GitHub App owned by the deployment:

```text
Homepage:  http://127.0.0.1:8787
Callback:  http://127.0.0.1:8787/auth/github/callback
Setup URL: http://127.0.0.1:8787/auth/github/setup
```

Enable expiring user authorization tokens, disable OAuth during installation,
and grant read access to Contents, Pull requests, Checks, and Commit statuses.
Make the App installable on any account and disable webhooks. See
[Authentication](docs/authentication.md) for the complete registration values.
Deployments admitting organization members also need organization Members read
access and an approved App installation on each allowed organization.

Then configure and start the service:

```bash
bun install
cp .env.example .env
# Fill in the GitHub App slug, client credentials, and session key in .env.
bun run db:up
bun run migrate
bun run dev
```

Open **http://127.0.0.1:8787**, sign in with GitHub, choose a repository, and
create a planning channel. Open that channel in another browser profile to see
the multiplayer half. Ctrl-C stops the web and server processes;
`bun run db:down` stops PostgreSQL.

Set `AGENT=off` to run the editor without Copilot.

For a local coding agent connection, see
[Connect a local coding agent](docs/local-agent-mcp.md).

For proxied VM development and remote HMR, see
[Remote development](docs/exe-dev.md).

### Docker

The production image builds the browser client and serves it from the same Bun
process that owns the API and WebSocket. To run the complete stack locally,
fill in the GitHub App and session variables in `.env`, then run:

```bash
bun run docker:up
```

This builds the image, starts PostgreSQL, applies migrations, and listens on
`http://127.0.0.1:8787`. `bun run docker:down` stops the stack. The ordinary
`bun run db:up` remains database-only for development with Vite HMR.

For a deployment using a managed database, build `Dockerfile`, provide
`DATABASE_URL`, `APP_ORIGIN`, the GitHub App credentials and slug, and
`SESSION_ENCRYPTION_KEY` at runtime, and expose container port `8787`. Do not
bake `.env` or any credential into the image.

## Talking to the agent

The agent acts only when addressed:

```text
should we cover the export format?     -> the channel only
yes, Markdown for now                  -> the channel only
@ai                                    -> acts on the conversation above
@ai draft the export section           -> acts on that
```

Anything said without the mention is still carried into the agent's next turn,
so a team can settle something between themselves and the agent arrives already
knowing. The composer says which destination a message has before you send it.

The first editor to invoke the planner lends their GitHub App session to that
channel's Copilot usage. The agent receives repository-scoped read tools and no
host filesystem or shell. **New planner session** releases ownership so another
editor can take it. Login sessions and GitHub credentials exist only in the
server process; restarting Chopin signs everyone out and releases Planner
ownership without losing plans or transcripts.

## Configuration

| Variable                       | Default             | Meaning                                                              |
| ------------------------------ | ------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`                 | required            | PostgreSQL connection URL; never printed by the server.              |
| `STORAGE_DRIVER`               | `postgres`          | Built-in storage adapter.                                            |
| `APP_ORIGIN`                   | required            | Exact public HTTP(S) origin used for callbacks and Origin checks.    |
| `GITHUB_APP_SLUG`              | required            | Slug from the GitHub App's public link.                              |
| `GITHUB_APP_CLIENT_ID`         | required            | GitHub App OAuth client id, distinct from the App id.                |
| `GITHUB_APP_CLIENT_SECRET`     | required            | GitHub App client secret used for user-token exchange and refresh.   |
| `GITHUB_ALLOWED_USERS`         | unrestricted        | Comma-separated GitHub usernames admitted to this instance.          |
| `GITHUB_ALLOWED_ORGANIZATIONS` | unrestricted        | Comma-separated organizations whose active members are admitted.     |
| `SESSION_ENCRYPTION_KEY`       | required            | 32 random bytes as 64 hex characters; encrypts OAuth state and PKCE. |
| `SERVER_HOST`                  | `127.0.0.1`         | Bind address.                                                        |
| `PORT`                         | `8787`              | HTTP and WebSocket port.                                             |
| `MODEL`                        | `claude-sonnet-4.6` | Planner model.                                                       |
| `AGENT`                        | on                  | `AGENT=off` hides and disables the planner.                          |

Generate the session key with `openssl rand -hex 32`. `APP_ORIGIN` has no
trailing slash and must match the GitHub App callback's origin exactly.
The two admission lists are case-insensitive and combined: matching either one
is sufficient. Leaving both empty preserves unrestricted sign-in.

## Sharing

The client derives the application socket from the page origin, so a tunnel
needs no separate application WebSocket setting:

```bash
SERVER_HOST=0.0.0.0 APP_ORIGIN=https://chopin.example bun run dev
cloudflared tunnel --url http://127.0.0.1:8787
```

Update the GitHub App homepage, callback, and setup URL to the new origin. Every
participant authorizes the App, and an account owner installs it on the selected
repositories. Repository access is checked before a channel is listed, opened,
or edited. This single-port example does not carry remote Vite HMR; see
[Remote development](docs/exe-dev.md) for that setup.

## Architecture

```text
packages/dialect     the plan's MDX dialect and Lexical schema
packages/question    questionnaires: definition, shared answer, derivation
packages/editor      the browser editor, cursors, decisions pane
packages/protocol    wire types and addressing rules
packages/viewport    browser viewport geometry and event subscriptions
apps/server          auth, channels, documents, persistence, the agent
apps/web             repositories, channels, and the three-pane workspace
```

The server holds every open channel as a Yjs document with a headless Lexical
editor bound to it. That mirror lets it validate an edit rather than relay bytes
it cannot read. Accepted updates and sidecar state are committed to PostgreSQL
before acknowledgement; complete checkpoints retain canonical MDX and the Yjs
epoch for recovery.

See [Document architecture](docs/architecture.md),
[Authentication](docs/authentication.md), [Repository channels](docs/channels.md),
[Storage adapters](docs/storage.md), and [Copilot agent](docs/hosted-agent.md).

Three things are worth knowing before changing it:

- **The dialect is an allowlist.** Plan content is parsed and rendered, never
  evaluated.
- **Admission and repository authorization are separate boundaries.** Optional
  user and organization lists admit an identity; routes, sockets, and agent
  tools then recheck repository permission.
- **An unhandled node type kills collaboration silently.** `registry.test.ts`
  asserts that every dialect node can be serialized and synchronized.

## Development

```bash
bun test              # unit and in-memory adapter tests, no browser or agent
bun run test:postgres # storage contract against PostgreSQL
bun run e2e           # fake GitHub, real auth/session/channel path, Chromium
bun run types         # every package and e2e
bun run ci            # formatting, lint, and token checks
bun run build         # production client
bun run start         # serve the built client
```

The browser suite needs Chromium once with `bun run e2e:browsers`. It starts two
temporary PostgreSQL services, migrates them, builds the client, and runs with
`AGENT=off`. Its fake GitHub implementation replaces only GitHub's network
responses; OAuth state, process-local sessions, repository authorization,
channel routes, WebSockets, and persistence are the production implementations.

`AGENTS.md` is the companion for maintainers: invariants, deliberate decisions,
and failure modes that are otherwise easy to miss.

## Origins

The dialect, editor, and questionnaire model began as a port of Ace's plan
feature and were restructured around authenticated repository channels, durable
storage, and a repository-scoped agent. Work happens here now.
