# Chopin

Chopin is a GitHub Next research prototype exploring how people and
repository-grounded agents can author durable documents together. A document
might be an implementation plan, technical specification, RFC, proposal, or
decision record. People shape the document and own its decisions; the hosted
agent, currently named **Planner**, reads the selected repository, proposes
changes, and asks the team when the code cannot settle a choice.

> [!IMPORTANT]
> Chopin is experimental research software, not a supported GitHub product or a
> production-ready service. Expect incomplete workflows, operational limits,
> and breaking changes.

https://github.com/user-attachments/assets/9ebf0901-6255-47c3-adb3-e905e8f6cab4

> [!TIP]
> We do not provide public Chopin instance for general use. If you want use Chopin on
> your projects you can run it locally or host it on your own.

## What Chopin explores

A channel combines one repository-connected document with its collaboration
context:

- **Chat** is shared by the team and the hosted agent. Ordinary messages
  do not start an agent turn, although they can enter its bounded context;
  `@chopin` asks Chopin to act.
- **Document** is a multiplayer rich-text artifact backed by readable, restricted
  MDX. The current interface labels this view **Plan**. People and the agent edit
  the same document, with presence, cursors, and transient markers for recent
  agent changes.
- **Decisions** retain attributed questionnaire answers and accepted comments
  separately from the prose they produced, so a later rewrite cannot silently
  change what the team decided.

https://github.com/user-attachments/assets/9f429bf0-762d-4d8b-871b-493dbb14c03c


Typing `/research` in a document starts one durable request from the exact brief
and leaves an inline progress card in place. Completed research publishes as an
ordinary child document beneath its parent, with its own document,
Chat, and Decisions. Pending, failed, and cancelled requests never
appear as documents in navigation.

https://github.com/user-attachments/assets/72a85be8-685f-4d60-9937-b3855b46cebe

The Planner can inspect the selected GitHub repository and its pull requests
through bounded, read-only tools, then co-author the document. It cannot write to
GitHub, edit a checkout, or implement code. A separate coding agent can connect
to Chopin through MCP to create documents or consume an approved implementation
graph.

The document model supports broader artifacts, while the current Planner prompt
and tool vocabulary remain optimized for planning.

## Current boundaries

- Chopin supports GitHub.com. GitHub Enterprise Server endpoints are not
  configurable.
- The Planner's file, tree, and history tools read the default branch captured
  when its session starts; code search is repository-scoped. It never reads a
  local checkout or uncommitted changes.
- Every browser participant signs in, passes the instance admission policy, and
  needs repository access through the GitHub App installation. MCP callers also
  pass instance admission, but use their own bearer token for repository
  authorization instead of the App installation. A public repository does not
  make its Chopin channels public.
- Pull access can view channels. Push or administration access is required to
  create or change them and to invoke the Planner.
- The first eligible person to invoke the Planner or start a model-backed
  research request supplies the GitHub App user token and Copilot entitlement
  used for that channel. A server restart signs everyone out and releases that
  ownership.
- Document and Chat context, along with repository material selected by
  the Planner, is sent to GitHub Copilot during a turn. Model-backed background
  jobs also send job-specific private material, including context loaded during
  execution, to isolated Copilot workers. The public research worker receives
  only the exact submitted brief, but may derive or refine the queries it sends
  to web search. GitHub credentials remain process-local;
  documents, transcripts, decisions, research request staging, background-job
  inputs and artifacts, and token-free session records are stored in PostgreSQL.
- One Chopin process may write to a database at a time. Horizontal application
  scaling and zero-downtime rolling deployment are not supported.

---

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
create a channel, then start writing. The current interface calls these planning
channels. Opening the channel in a second browser profile shows the multiplayer
path.

Ctrl-C stops the development supervisor. `bun run db:down` tears down the local
Compose project. Set `AGENT=off` to prevent Planner turns and disable the
background-job runner; this does not disable the `/mcp` endpoint used by external
coding agents.

## Collaborate with the Planner

The web composer treats `@chopin` as an instruction for the Planner:

```text
should we cover the export format?     -> channel chat transcript
yes, Markdown for now                  -> channel chat transcript
@chopin                                -> act on the recent conversation
@chopin draft the export section       -> act on that request
@chopin compare #Release plan          -> read another document, then respond here
```

The recent channel chat transcript is supplied as bounded context for the next turn,
even when those messages did not address the Planner. The first eligible
model-backed action, either a Planner turn or research request, claims the
channel's Copilot usage until that owner's session ends or the server restarts.
The current web interface has no control for transferring that ownership
manually.

Typing `#` in Chat opens a picker for other documents in the current
repository, including published children. Selected references retain stable
identities even when their titles change. The Planner reads referenced documents
at their latest revision, and references never change which document its editing
tools target. Research starts from `/research` in the document rather than from
a Chat reference.

## Connect a coding agent

Chopin exposes a bearer-authenticated Streamable HTTP MCP endpoint. See
[Connect a local coding agent](docs/local-agent-mcp.md) for Claude Code, Codex
CLI, and GitHub Copilot CLI configuration.

Planning is one way to use a Chopin document today. The optional
[creating-chopin-plans skill](skills/creating-chopin-plans/SKILL.md) turns a
settled coding-agent conversation into an initial plan document.
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
| Review the hosted agent boundary           | [Hosted agent](docs/hosted-agent.md)                         |
| Register durable background jobs           | [Background jobs](docs/background-jobs.md)                   |
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
