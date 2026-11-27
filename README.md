# Chopin

Chopin is a GitHub Next research prototype where people and a repository-grounded agent write durable documents together. A document may be an implementation plan, technical specification, RFC, proposal, or decision record.

People shape the document and own every decision. The hosted agent, called Planner, reads the selected GitHub repository, proposes document edits, and asks the team when the code cannot settle a choice. Read the [GitHub Next project post](https://githubnext.com/projects/chopin/) for our design principles and motivation.

> [!IMPORTANT]
> Chopin is experimental research software, not a supported GitHub product or a production service. Expect incomplete workflows, operational limits, and breaking changes.

> [!TIP]
> There is no public Chopin instance for general use. Run Chopin locally with the steps below, or host your own instance by following [Self-hosting](docs/self-hosting.md).

https://github.com/user-attachments/assets/9ebf0901-6255-47c3-adb3-e905e8f6cab4

## What Chopin does

Each document connects to one GitHub repository and combines three parts.

- **Document.** People and the Planner edit one multiplayer rich-text document backed by restricted MDX, with live presence, cursors, and temporary markers for recent agent edits.
- **Chat.** The team shares a conversation beside the document. Saved messages enter the Planner's context and keep unnamed document titles current. When you are alone in a document, every message goes directly to `@chopin`. In a group discussion, [automatic participation](docs/conversation-initiative.md) waits its turn, while `@chopin` calls the Planner immediately.
- **Decisions.** Question answers and accepted comments live in attributed records separate from the prose they produced. Later edits cannot silently overwrite what the team decided.

https://github.com/user-attachments/assets/9f429bf0-762d-4d8b-871b-493dbb14c03c

**Research.** Type `/research` in a document to start one durable research request from your brief and place an inline progress card in the document. Completed research publishes as a child document beneath its parent, with its own Document and Decisions views. A child document has no Chat of its own; the parent's Chat and Planner reach it through child tools. Pending, failed, and cancelled requests never appear in navigation.

https://github.com/user-attachments/assets/72a85be8-685f-4d60-9937-b3855b46cebe

**Planner and coding agents.** Under the default `copilot-sdk` adapter, the Planner inspects the selected repository and its pull requests through bounded, read-only tools and edits only the Chopin document. It cannot write to GitHub, edit a checkout, or implement code. Setting `HARNESS=atomic` instead runs every Planner session as a full Atomic session with shell and filesystem access as the server process's user; see [Self-hosting](docs/self-hosting.md#choose-and-trust-a-harness). Setting `HARNESS=remote` runs Planner turns in an external client attached at `/api/v1/agent`; see [Agent connection](docs/agent-connection.md). A separate coding agent can also connect over `/mcp` to create or revise documents and work through an approved implementation graph.

The document model supports any repository-connected technical document, while the current Planner prompt and tool names focus on planning.

## Run locally

You need these prerequisites on your machine:

- Bun 1.4.5, selected automatically by `mise.toml` if you use [mise](https://mise.jdx.dev)
- Docker Engine with Docker Compose for PostgreSQL
- A GitHub App owned by your local deployment
- A GitHub account with push or administration access to a test repository, plus an active Copilot entitlement for the default Planner
- An `OPENAI_API_KEY` or `JEV_API_KEY` for the decisions model required when `AGENT=on`

### 1. Register a GitHub App

Create a GitHub App with these local URLs:

```text
Homepage:  http://127.0.0.1:8787
Callback:  http://127.0.0.1:8787/auth/github/callback
Setup URL: http://127.0.0.1:8787/auth/github/setup
```

Configure these App settings:

1. Enable expiring user authorization tokens.
2. Disable OAuth during installation.
3. Disable webhooks.
4. Grant these repository permissions, explained in [Authentication](docs/authentication.md#repository-permissions):

```text
Contents:        Read and write
Pull requests:   Read and write
Workflows:       Read and write
Checks:          Read-only
Commit statuses: Read-only
Issues:          Read-only
Metadata:        Read-only (automatic)
```

### 2. Install dependencies and configure `.env`

```bash
bun install
cp .env.example .env
openssl rand -hex 32
```

Open `.env` and fill in `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY` from the generated hexadecimal string, and either `OPENAI_API_KEY` or `JEV_API_KEY`.

To run without the Planner, background jobs, or a decisions key, set `AGENT=off`. That setting leaves the `/mcp` endpoint enabled for external coding agents.

### 3. Start PostgreSQL and Chopin

```bash
bun run db:up
bun run migrate
bun run dev
```

The committed `compose.local.yaml` override publishes PostgreSQL on host port 5432, so use it only on a trusted development machine. For an internet-facing deployment, follow [Self-hosting](docs/self-hosting.md).

Press `Ctrl-C` to stop the development supervisor. Run `bun run db:down` to tear down the local Docker Compose project.

### 4. Sign in and create a document

1. Open [http://127.0.0.1:8787](http://127.0.0.1:8787) and sign in with GitHub.
2. Install or update the GitHub App on a test repository when the repository picker asks.
3. Select the repository, create a new document, and start writing.

Open the document in a second browser profile to test multiplayer editing. For a single-browser demo, [enable local collaborators](docs/authentication.md#rehearse-with-local-collaborators) to open Lily or Felix in another tab using your existing login.

Public web search for `/research` calls GitHub's Copilot MCP endpoint with the signed-in user's App token. Whether that endpoint accepts a self-registered App's token for `web_search` is unconfirmed. If it refuses, the research card and server log state why, and [Self-hosting troubleshooting](docs/self-hosting.md#troubleshooting) lists what to check.

## Collaborate with the Planner

Write in Chat as a team, or address `@chopin` directly when you want the Planner to act.

| Message                              | What happens                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `should we cover the export format?` | The server saves the message in Chat and adds it to the Planner's context. Alone in a document, `chopin` replies at once; in a group, it waits its turn. |
| `@chopin`                            | Chopin invokes the Planner immediately to act on recent Chat messages.                                                                                   |
| `@chopin draft the export section`   | Chopin invokes the Planner immediately with that request.                                                                                                |
| `@chopin compare #Release plan`      | The Planner reads the referenced document at its latest revision, then responds in the current document.                                                 |

Type `#` in Chat to open a picker for other documents in the repository, published children, headings, Decisions, and repository files. Document references keep stable identities when titles change, and they never change which document the Planner edits. Start research with `/research` in the document rather than from Chat.

Saved messages also keep blank, generated, or Planner-drafted titles up to date without overwriting a title a person set or renamed. Under `copilot-sdk`, the first eligible writer to trigger title maintenance, a Planner turn, or a research request supplies the document's GitHub App token and Copilot usage. That ownership lasts until their session ends or the server restarts, and the interface has no manual transfer control. See [Hosted agent](docs/hosted-agent.md#ownership) for ownership and title rules.

## Use your own machine

The `chopin` CLI connects a machine you control to your Chopin server. Builds, local investigations, and Planner work then run there with your own coding agent for any repository you can push to.

The machine needs Linux on x86_64 with KVM, or Windows on x86_64 with the Windows Hypervisor Platform: `chopin` runs each agent in a microVM of its own ([NVX](https://github.com/microsoft/nvx)), installed there, so you don't install the agent or sign in to it on the machine. Install `chopin` and connect once from any directory with your server's origin in `CHOPIN_URL`:

```bash
curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh | sh
CHOPIN_URL=https://your-chopin-instance.example chopin connect --agent copilot
```

`chopin connect` pairs the machine on first run, saves the server URL for later commands, and clones each repository the first time work needs it. Pass `--checkout <path>` to use an existing checkout instead. The command runs in your terminal and stops when you close it. On a remote machine or server, add `--install-service` so a background service stays running after SSH closes.

Pass `--agent` with one of these built-in coding agents:

| Agent                                                                                               | In its microVMs                                         | Connect with      | Tested with Chopin |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------- | ------------------ |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) | `@github/copilot@1.0.114`                               | `--agent copilot` | Yes                |
| [Atomic](https://github.com/bastani-inc/atomic-acp)                                                 | `@bastani/atomic@0.10.14`, `@bastani/atomic-acp@0.0.18` | `--agent atomic`  | Yes                |

For any other agent that speaks ACP, pass its command after `--`, such as `chopin connect -- my-agent --acp`.

The **Machines** page at `/machines` on your server generates one install-and-connect command with your server filled in. Its former address, `/connect`, redirects there. A local computer pairs after you approve it in the browser, and a server pairs over SSH with a single-use key. See [Add a machine](docs/chopin-cli.md#add-a-machine) and [Use your own machine with Chopin](docs/chopin-cli.md) for Windows setup, background services, and every CLI command.

## Current boundaries

- **GitHub.com only.** GitHub Enterprise Server endpoints are not configurable.
- **Repository reads.** Under `copilot-sdk`, the Planner reads the default branch captured when its session starts, unless investigation evidence supplies an exact commit. Code search stays within that repository. The Planner never reads a local checkout or uncommitted changes unless you use `HARNESS=atomic` or a remote Planner on a paired machine.
- **Authentication and access.** Every browser participant signs in with GitHub, passes the optional instance admission policy, and needs repository access through the GitHub App installation. A public repository does not make its Chopin documents public. Pull access views documents; push or administration access creates documents, edits them, and invokes the Planner. MCP callers pass instance admission and authorize repositories directly with their own bearer token without an App installation. See [Authentication](docs/authentication.md) and [Repository channels](docs/channels.md).
- **Data sent to model providers.** Document content, Chat messages, and repository excerpts selected by the Planner go to the configured model provider. That provider is GitHub Copilot under `copilot-sdk`, the `HARNESS_AUTH` provider under `HARNESS=atomic`, or the attached client under `HARNESS=remote`. Background jobs send job-specific material to isolated workers on the same adapter. Public web research sends only the submitted brief, though the worker may refine search queries.
- **Credentials and storage.** Hosted GitHub credentials are encrypted in PostgreSQL with `SESSION_ENCRYPTION_KEY`, stored outside the database. [Local device mode](docs/authentication.md#local-device-flow-sign-in) instead stores credentials in an OS vault or a consented local file. Documents, transcripts, decisions, research staging, background jobs, and sessions live in PostgreSQL. See [Storage](docs/storage.md) and [Hosted agent](docs/hosted-agent.md).
- **Decisions model and opt-in settings.** When `AGENT=on`, Chopin requires a decisions model set through `OPENAI_API_KEY`, `JEV_API_KEY`, or `DECISIONS_MODEL` for group turn-taking and visual checks. Conversation-derived decision cards and [research offers](docs/conversation-research.md) are off by default; `CONVERSATION_PLAN=on` enables them, even with `AGENT=off`. Legacy single-paragraph visual routing is also off by default and enabled with `PLANNER_VISUALS=on`. See [Self-hosting](docs/self-hosting.md#runtime-configuration).
- **Single active writer.** One Chopin process may write to a database at a time, and horizontal scaling is not supported. A deploy can overlap two processes on one database with `HANDOVER=wait`; see [Deploys nobody can see](docs/zero-downtime-deploys.md).

## Documentation

| Topic                                      | Document                                                     |
| ------------------------------------------ | ------------------------------------------------------------ |
| Deploy and operate an instance             | [Self-hosting](docs/self-hosting.md)                         |
| Deploy without anyone noticing             | [Deploys nobody can see](docs/zero-downtime-deploys.md)      |
| Configure identity and access              | [Authentication](docs/authentication.md)                     |
| Let machines push as Chopin's GitHub App   | [GitHub App identity](docs/github-app-identity.md)           |
| Run Chopin's work on your own machine      | [chopin CLI](docs/chopin-cli.md)                             |
| Run local investigations and prototypes    | [Local investigations](docs/local-experiments.md)            |
| Connect an external coding agent           | [Local agent MCP](docs/local-agent-mcp.md)                   |
| Run a document's Planner in your own agent | [Agent connection](docs/agent-connection.md)                 |
| Understand the system                      | [Architecture](docs/architecture.md)                         |
| Understand channel identity and access     | [Repository channels](docs/channels.md)                      |
| Understand persistence                     | [Storage](docs/storage.md)                                   |
| Capture and record open decisions          | [Decisions](docs/decisions.md)                               |
| Review the hosted agent boundary           | [Hosted agent](docs/hosted-agent.md)                         |
| Understand automatic participation in Chat | [Automatic participation](docs/conversation-initiative.md)   |
| Understand research offers from Chat       | [Research offers from Chat](docs/conversation-research.md)   |
| Register durable background jobs           | [Background jobs](docs/background-jobs.md)                   |
| Review experimental implementation handoff | [Implementation lifecycle](docs/implementation-lifecycle.md) |
| Run local implementation builds            | [Local implementation](docs/local-launcher.md)               |
| Develop on exe.dev                         | [exe.dev development](docs/exe-dev.md)                       |
| Test an authenticated pull request preview | [PR preview testing](docs/preview-testing.md)                |
| Work on the repository                     | [Maintainer guide](AGENTS.md)                                |

## Development

```bash
bun test              # unit and in-memory adapter tests
bun run test:postgres # PostgreSQL storage contract and lifecycle tests
bun run e2e           # browser and system integration suite
bun run types         # TypeScript checks across the workspace
bun run ci            # formatting, lint, and token checks
```

Run `bun run e2e:browsers` once to install Chromium. The browser suite builds the client and starts disposable PostgreSQL services and application servers. See [AGENTS.md](AGENTS.md) for repository structure, test selection, and engineering invariants.

Report security issues through [SECURITY.md](SECURITY.md). Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md), and the source is under the [MIT License](LICENSE.md).
