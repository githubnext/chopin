# Chopin

Chopin is a GitHub Next research prototype exploring how a software team and a
repository-grounded planning agent can produce one durable implementation plan
together. People edit the plan and own its decisions; the Planner reads the
selected repository, proposes changes, and asks the team when the code cannot
settle a choice.

> [!IMPORTANT]
> Chopin is experimental research software, not a supported GitHub product or a
> production-ready service. Expect incomplete workflows, operational limits,
> and breaking changes.

## What Chopin explores

A planning channel combines three views of the same piece of work:

- **Conversation** is shared by the team and the Planner. Ordinary messages stay
  in the channel conversation; `@ai` asks the Planner to act.
- **Plan** is a multiplayer rich-text document backed by readable MDX. People
  and the Planner edit the same document, with presence, cursors, and visible
  change markers.
- **Decisions** retains attributed questionnaire answers and accepted comments
  separately from the prose they produced, so a later rewrite cannot silently
  change what the team decided.

The Planner can inspect the selected GitHub repository and its pull requests
through bounded, read-only tools. It cannot write to GitHub, edit a checkout, or
implement the plan. A separate coding agent can connect to Chopin through MCP to
create documents or consume an approved implementation graph.

## Current boundaries

- Chopin supports GitHub.com. GitHub Enterprise Server endpoints are not
  configurable.
- The Planner's file, tree, and history tools read the default branch captured
  when its session starts; code search is repository-scoped. It never reads a
  local checkout or uncommitted changes.
- Every participant signs in, passes the instance admission policy, and needs
  repository access through the GitHub App installation. A public repository
  does not make its Chopin channels public.
- Pull access can view channels. Push or administration access is required to
  create or change them and to invoke the Planner.
- The first person to invoke the Planner supplies the GitHub App user token and
  Copilot entitlement used for that channel. A server restart signs everyone
  out and releases that ownership.
- Plan and conversation context, along with repository material selected by the
  Planner, is sent to GitHub Copilot during a Planner turn. GitHub credentials
  remain process-local; plans, transcripts, decisions, and token-free session
  records are stored in PostgreSQL.
- One Chopin process may write to a database at a time. Horizontal application
  scaling and zero-downtime rolling deployment are not supported.

## Run locally

The development path requires:

- Bun 1.3.2;
- Docker Engine with Docker Compose, used for PostgreSQL;
- a GitHub App owned by the deployment; and
- a GitHub account with push or administration access to a test repository and,
  to use the Planner, an active Copilot entitlement.

Register these local URLs on the GitHub App:

```text
Homepage:  http://127.0.0.1:8787
Callback:  http://127.0.0.1:8787/auth/github/callback
Setup URL: http://127.0.0.1:8787/auth/github/setup
```

Enable expiring user authorization tokens, disable OAuth during installation,
disable webhooks, and grant read access to Contents, Pull requests, Checks, and
Commit statuses. See [Authentication](docs/authentication.md) for the exact App
settings and the additional permission needed for organization admission.

Install, configure, and start Chopin:

```bash
bun install
cp .env.example .env
openssl rand -hex 32
# Fill in the GitHub App values and generated session key in .env.
bun run db:up
bun run migrate
bun run dev
```

The committed local Compose override publishes PostgreSQL on host port 5432 and
is intended only for a trusted development machine. Do not use it on an exposed
host. See [Self-hosting](docs/self-hosting.md) for an internet-facing deployment.

Open [http://127.0.0.1:8787](http://127.0.0.1:8787), sign in, and install or
update the GitHub App when the repository picker asks. Select a repository and
create a planning channel. Opening the channel in a second browser profile shows
the multiplayer path.

Ctrl-C stops the development supervisor. `bun run db:down` tears down the local
Compose project. Set `AGENT=off` to prevent hosted Planner turns; this does not
disable the `/mcp` endpoint used by external coding agents.

## Talk to the Planner

The web composer treats `@ai` as an instruction for the Planner:

```text
should we cover the export format?     -> channel conversation
yes, Markdown for now                  -> channel conversation
@ai                                    -> act on the recent conversation
@ai draft the export section           -> act on that request
```

Recent channel conversation is supplied as bounded context for the next turn,
even when those messages did not address the Planner. The first eligible editor to
invoke it owns the channel's Copilot usage until their session ends or the
server restarts. The current web interface has no control for transferring that
ownership manually.

## Connect a coding agent

Chopin exposes a bearer-authenticated Streamable HTTP MCP endpoint. See
[Connect a local coding agent](docs/local-agent-mcp.md) for Claude Code, Codex
CLI, and GitHub Copilot CLI configuration.

The optional [creating-chopin-plans skill](skills/creating-chopin-plans/SKILL.md)
turns a settled coding-agent conversation into an initial Chopin document.
[Implementation handoff](docs/implementation-lifecycle.md) and the
[implementing-chopin-plans skill](skills/implementing-chopin-plans/SKILL.md) are
experimental. The supported read-before-claim flow works only for documents
created through MCP, and Chopin does not yet provide a user-facing way to approve
a draft graph.

## Documentation

| Topic                                      | Document                                                     |
| ------------------------------------------ | ------------------------------------------------------------ |
| Deploy and operate an instance             | [Self-hosting](docs/self-hosting.md)                         |
| Configure identity and access              | [Authentication](docs/authentication.md)                     |
| Connect an external coding agent           | [Local agent MCP](docs/local-agent-mcp.md)                   |
| Understand the system                      | [Architecture](docs/architecture.md)                         |
| Understand channel identity and access     | [Repository channels](docs/channels.md)                      |
| Understand persistence                     | [Storage](docs/storage.md)                                   |
| Review the hosted Planner boundary         | [Hosted Planner](docs/hosted-agent.md)                       |
| Review experimental implementation handoff | [Implementation lifecycle](docs/implementation-lifecycle.md) |
| Develop on exe.dev                         | [exe.dev development](docs/exe-dev.md)                       |
| Test an authenticated PR preview           | [PR preview testing](docs/preview-testing.md)                |
| Work on the repository                     | [Maintainer guide](AGENTS.md)                                |

## Development

```bash
bun test              # unit and in-memory adapter tests
bun run test:postgres # PostgreSQL storage contract and lifecycle tests
bun run e2e           # browser and system integration suite
bun run types         # TypeScript checks across the workspace
bun run ci            # formatting, lint, and token checks
```

Run `bun run e2e:browsers` once to install Chromium. The browser suite builds
the client and starts disposable PostgreSQL services and application servers.
See [AGENTS.md](AGENTS.md) for repository structure, test selection, and current
engineering invariants.

Security reports should follow [SECURITY.md](SECURITY.md). Participation is
covered by the [Code of Conduct](CODE_OF_CONDUCT.md), and the source is available
under the [MIT License](LICENSE.md).
