# Chopin

Chopin is a GitHub Next research prototype exploring how people and
repository-grounded agents can author durable documents together. A document
might be an implementation plan, technical specification, RFC, proposal, or
decision record.

People shape the document and own its decisions. The hosted agent, currently
named **Planner**, reads the selected repository, proposes changes, and asks the
team when the code cannot settle a choice.

To learn more about our design principles, and why we're building Chopin check out our recent blog post - https://githubnext.com/projects/chopin/

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

- **Chat** is shared by the team and the hosted agent. Saved messages help
  maintain a short document title and enter the Planner's bounded context;
  `@chopin` asks Chopin to act on the document.
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
through bounded, read-only tools, then co-author the document. Under the default
`copilot-sdk` harness, and under `pi`, it cannot write to GitHub, edit a checkout,
or implement code. `HARNESS=atomic` deliberately runs it as a full Atomic session
with shell and filesystem access as the server process's user; see
[Self-hosting](docs/self-hosting.md#choose-and-trust-a-harness). A separate coding agent can connect
to Chopin through MCP to create or revise documents and consume an approved
implementation graph.

The document model supports broader artifacts, while the current Planner prompt
and tool vocabulary remain optimized for planning.

## Current boundaries

- Chopin supports GitHub.com. GitHub Enterprise Server endpoints are not
  configurable.
- The Planner's file, tree, and history tools normally read the default branch captured
  when its session starts; investigation evidence can supply an exact commit instead.
  Code search is repository-scoped. Except under
  `HARNESS=atomic`, it never reads a local checkout or uncommitted changes.
- Every browser participant signs in, passes the instance admission policy, and
  needs repository access through the GitHub App installation. MCP callers also
  pass instance admission, but use their own bearer token for repository
  authorization instead of the App installation. A public repository does not
  make its Chopin channels public.
- Pull access can view channels. Push or administration access is required to
  create or change them and to invoke the Planner.
- The first eligible person whose saved Chat message starts title maintenance,
  who invokes the Planner, or who starts a model-backed research request supplies
  the GitHub App user token used for that channel
  and, under the default `copilot-sdk` harness, the Copilot entitlement. With
  `HARNESS=pi` or `HARNESS=atomic`, model access comes from the operator's
  `HARNESS_AUTH` instead.
  A server restart releases that ownership. Hosted browser logins survive
  releases using encrypted session credentials; local device mode restores a
  new session. Returning browsers can claim Planner ownership on a later action.
- Document and Chat context, along with repository material selected by
  the Planner, is sent to the harness's model provider during a turn (GitHub
  Copilot by default; under `HARNESS=pi` or `HARNESS=atomic`, the provider
  chosen by `HARNESS_AUTH`). Model-backed background jobs also send job-specific private
  material, including context loaded during execution, to isolated workers on
  the same harness. The public research worker receives
  only the exact submitted brief, but may derive or refine the queries it sends
  to web search. Hosted GitHub credentials are encrypted in PostgreSQL with a
  deployment key kept outside the database; the
  [local device mode](docs/authentication.md#local-device-flow-sign-in) persists
  credentials in an OS vault or an explicitly consented local file. Documents,
  transcripts, decisions, research request staging, background-job inputs and
  artifacts, and session records are stored in PostgreSQL.
- Optional conversation-derived cards default to off. With `CONVERSATION_PLAN=on`,
  current and recent Chat messages and selected decision context are sent to
  TypeSafe's Jev service for interpretation. This uses the server's `JEV_API_KEY`,
  separately from the Planner's harness credentials, and continues with `AGENT=off`.
  Independent research analysis can propose [research offers](docs/conversation-research.md)
  with shared editable briefs. Brief synthesis uses an isolated harness worker;
  a writer starts the research explicitly.
- Experimental Planner visual routing is opt-in with `PLANNER_VISUALS=on` and
  `JEV_API_KEY`. Jev makes small possibility, comprehension, and type decisions
  for one explanatory paragraph at a time; Planner authors the selected visual.
  Routing applies to explicit member requests of at most 1,000 characters under
  `copilot-sdk` or `pi`. Other turns keep their ordinary authoring behavior.
- One Chopin process may write to a database at a time. Horizontal application
  scaling and zero-downtime rolling deployment are not supported.

---

## Run locally

The development path requires:

- Bun 1.4.2;
- Docker Engine with Docker Compose, used for PostgreSQL;
- a GitHub App owned by the deployment; and
- a GitHub account with push or administration access to a test repository and,
  to use the Planner with the default harness, an active Copilot entitlement.

Register these local URLs on the GitHub App:

```text
Homepage:  http://127.0.0.1:8787
Callback:  http://127.0.0.1:8787/auth/github/callback
Setup URL: http://127.0.0.1:8787/auth/github/setup
```

On the App:

1. Enable expiring user authorization tokens.
2. Disable OAuth during installation.
3. Disable webhooks.
4. Give it these repository permissions, which
   [Authentication](docs/authentication.md#repository-permissions) explains:

```text
Contents:        Read and write
Pull requests:   Read and write
Workflows:       Read and write
Checks:          Read-only
Commit statuses: Read-only
Issues:          Read-only
Metadata:        Read-only (automatic)
```

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

The committed local Compose override publishes PostgreSQL on host port 5432, so
use it only on a trusted development machine. See [Self-hosting](docs/self-hosting.md) for an internet-facing deployment.

1. Open [http://127.0.0.1:8787](http://127.0.0.1:8787) and sign in.
2. Install or update the GitHub App when the repository picker asks.
3. Select a repository and create a channel, then start writing. The current
   interface calls these planning channels.

Opening the channel in a second browser profile shows the multiplayer path.

For a one-browser demo, [enable local collaborators](docs/authentication.md#rehearse-with-local-collaborators)
to open Lily or Felix in a separate tab using your existing login.

Ctrl-C stops the development supervisor. `bun run db:down` tears down the local
Compose project.

Set `AGENT=off` to prevent Planner turns and disable the background-job runner.
This does not disable the `/mcp` endpoint used by external coding agents.

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
even when those messages did not address the Planner. Saved member messages also
maintain the document's title independently of conversation-derived cards. Weak
or incidental discussion leaves the title alone; topic changes may refine a title
someone chose. This work obeys `AGENT`, ownership and implementation locks, and
does not require Jev. A title job can seed a goal only before body prose exists.

The first eligible model-backed action, including title maintenance, a Planner turn
or research request, claims the
channel's Copilot usage until that owner's session ends or the server restarts.
The current web interface has no control for transferring that ownership
manually.

Typing `#` in Chat opens a picker for other documents in the current
repository, including published children. Selected references retain stable
identities even when their titles change. The Planner reads referenced documents
at their latest revision, and references never change which document its editing
tools target. Research starts from `/research` in the document rather than from
a Chat reference.

## Use your own machine

The `chopin` CLI connects a machine you control to your Chopin server, so
builds, investigations and Planner work run in your own checkout with your own
coding agent. Install it, then connect your checkout once with your server's
origin in `CHOPIN_URL`. `chopin connect` pairs the machine the first time and
saves the server for later commands.

```bash
curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh | sh
CHOPIN_URL=https://your-chopin-instance.example chopin connect . -- copilot --acp --allow-all
```

That runs in your terminal and stops when you close it. On a remote machine or
server, add `--install-service` so a background service keeps it running after
you close SSH.

For another coding agent, install it, sign in, and put its **Connect with**
arguments in place of `-- copilot --acp --allow-all`:

| Agent                                                                                               | Install                                                       | Connect with                                              | Tested with Chopin |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- | ------------------ |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) | `npm install -g @github/copilot`                              | `-- copilot --acp --allow-all`                            | Yes                |
| [Atomic](https://github.com/bastani-inc/atomic-acp)                                                 | `npm install -g @bastani/atomic @bastani/atomic-acp`          | `--env ATOMIC_ACP_HEADLESS=1 -- atomic-acp`               | Yes                |
| [Claude Code](https://github.com/agentclientprotocol/claude-agent-acp)                              | `npm install -g @agentclientprotocol/claude-agent-acp`        | `-- claude-agent-acp`                                     | No                 |
| [OpenAI Codex](https://github.com/agentclientprotocol/codex-acp)                                    | `npm install -g @openai/codex @agentclientprotocol/codex-acp` | `--env INITIAL_AGENT_MODE=agent-full-access -- codex-acp` | No                 |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)            | `npm install -g @google/gemini-cli`                           | `-- gemini --acp --yolo`                                  | No                 |

The **Machines** page, at `/connect` on your server, gives one command that
installs `chopin` and connects the machine, with your server filled in: your
computer pairs once you approve it in the browser, and a server pairs with a
single-use key, so it works over SSH too; see
[Add a machine](docs/chopin-cli.md#add-a-machine). See
[Use your own machine with Chopin](docs/chopin-cli.md) for Windows, the
background service and every command.

## Documentation

For owner-authorized local prototypes, measurements, and service-data investigations,
see [Local investigations](docs/local-experiments.md). An ACP-compatible agent works
in a local checkout and publishes captured evidence to Chopin's native views.

| Topic                                      | Document                                                     |
| ------------------------------------------ | ------------------------------------------------------------ |
| Deploy and operate an instance             | [Self-hosting](docs/self-hosting.md)                         |
| Configure identity and access              | [Authentication](docs/authentication.md)                     |
| Connect an external coding agent           | [Local agent MCP](docs/local-agent-mcp.md)                   |
| Run Chopin's work on your own machine      | [chopin CLI](docs/chopin-cli.md)                             |
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
