# Hosted agent (Planner)

Chopin's Copilot-backed document agent is currently named Planner. It can
inspect one selected GitHub repository, co-author the shared document, ask the
participants structured questions, and anchor decisions to prose. For documents
used as plans, it can also draft an implementation graph. By default it does not
implement code or change GitHub; the local full Atomic mode below changes its tool boundary.

The product role is document co-authoring. The current prompt and tool vocabulary
remain optimized for planning and may structure another document type as a plan;
that is an implementation limitation, not the document model's boundary.

Chopin runs the Planner through `@ai-sdk/harness`: `HARNESS` selects one adapter
from a code-owned map, defaulting to `copilot-sdk`, a host-process adapter over
`@github/copilot-sdk`. `pi`, over `@ai-sdk/harness-pi`, and `atomic`, which
embeds Atomic's headless SDK (`@bastani/atomic`) in the server process, are
further reviewed adapters. Both require an explicit `HARNESS_AUTH`. The
harness owns the agent loop and model; by default Chopin owns every tool the Planner
can call. See [Self-hosting](self-hosting.md) for `HARNESS`/`HARNESS_AUTH`
selection and adapter trust.

## Ownership

The first eligible editor to invoke the Planner or start a model-backed research
request supplies the GitHub App user access token for that channel and, under
the default `copilot-sdk` harness, the Copilot entitlement. Under `HARNESS=pi`
and `HARNESS=atomic` the owner supplies only the GitHub token; model access
comes from the operator's `HARNESS_AUTH` mode. The user must pass instance
admission and have repository push or administration access. Ownership is
assigned atomically in storage and guarded by a generation token.

That process-local login owns the channel's model usage until it expires, logs
out, the server restarts, or the authenticated reset API releases it. The
current web application does not expose a reset control. Under `copilot-sdk`, a
user without Copilot entitlement sees the provider failure on the first
model-backed action and remains owner until one of those release conditions
occurs.

PostgreSQL stores the owner session ID only so durable ownership can refer to an
active process session. The cookie verifier and GitHub credential remain in
memory. Startup clears every browser-session registry row and owner reference,
while preserving the document, transcript, reserved context fields, and
ownership generation.

## Runtime isolation

By default every harness receives only Chopin's host-executed tools: document, question,
relationship, implementation-graph, repository, and GitHub tools, each bound to
the channel's repository through `toolsContext`. No harness built-in is active
for the Planner. The default `copilot-sdk` adapter additionally runs the shared
Copilot runtime in SDK `mode: "empty"`: each disposable session receives its
owner's token when created and has no client-level service token or
logged-in-user fallback. That detail is specific to the Copilot SDK adapter,
not a property every harness in `HARNESS` shares.

The isolated Planner has no:

- checkout, shell, or host filesystem;
- skills, plugins, or configuration discovery;
- repository-local instruction loading;
- shared embeddings or cross-session store; or
- ability to change GitHub.

Under `HARNESS=pi`, Chopin patches `@ai-sdk/harness-pi` 1.0.128 so Pi does not
load `AGENTS.md` or `CLAUDE.md` context files from the host filesystem. See
[Self-hosting](self-hosting.md#choose-and-trust-a-harness).

Under `HARNESS=atomic` without a verified full-mode checkout, each harness session
owns one in-process Atomic `AgentSession`. It is built with every shipped Atomic package disabled
(workflows, subagents, MCP, web access, and Intercom). It has no Atomic coding
tools, and its resource loader discovers no extensions, skills, prompt
templates, themes, or context files. Its working and configuration directory is
an empty private temporary directory, and its session, settings, and
credentials stay in memory. A per-turn hook replaces the whole system prompt
with the turn's instructions, so the model never receives Atomic's
coding-agent preamble. The adapter fails the turn before any model request
when the live session reports an extension, tool, context file, skill, prompt
template, or system prompt beyond that set. It checks the tools offered to the
model again before every model request.

Available capabilities are:

- Chopin document, question, relationship, and implementation-graph tools (with
  current plan-oriented tool names);
- bounded file and tree reads plus commit history fixed to the default branch
  captured when the session is created;
- repository-scoped code search, post-filtered by repository node ID; and
- bounded reads of document and historical research references attached to the
  current Chat context; and
- repository-bound, read-only pull-request tools reached through
  `createMCPClient` against GitHub's remote MCP server, bound to the channel's
  repository.

Issue and general search MCP tools are refused because linked objects and
free-form qualifiers can cross the selected repository boundary. Repository
REST tools construct owner and repository coordinates on the server, bound
response sizes and line ranges, reject path escape, and post-filter code search
by GitHub repository node ID.

The isolated Planner does not see a user's local checkout, current branch, working tree,
or uncommitted changes. A coding agent must compare the repository context
returned by Chopin with its checkout before claiming work. The server validates
the shape of creation provenance but does not resolve its branch and commit
against GitHub or independently inspect the coding agent's checkout.

## Full Atomic Planner in local mode

`ATOMIC_PLANNER=full` is an explicit trust change, accepted only with
`AUTH_MODE=local` and `HARNESS=atomic`. Other combinations and unrecognized
nonempty values fail startup. Both `HARNESS_AUTH=auto` and `ai-gateway` work.
This gives the Planner shell and filesystem access **as the local operator**,
not a sandbox confined to a repository. Use it only on a trusted single-operator,
loopback-only instance; never expose that instance through a proxy or tunnel.

Set `ATOMIC_PLANNER_CHECKOUTS` to absolute checkout paths separated by the
platform path delimiter (`:` on Unix, `;` on Windows). Before each Planner
session, Chopin checks candidate paths with Git and compares `origin`'s
owner/repository to the channel repository, case-insensitively. HTTPS,
`ssh://`, and scp-style remotes are accepted. Remote host spellings are ignored
because SSH aliases are common; this verifies repository coordinates, not the
authenticity of a remote host. A per-invocation candidate takes precedence over
the configured list. No verified checkout means the same isolated session as
before, with no Atomic resources or HostInput binding.

A local coding agent can supply that candidate with
[`invoke_planner`](local-agent-mcp.md#hand-an-instruction-to-the-local-planner).
The tool requires a live browser login matching its MCP caller, posts a durable
member instruction, and returns the document URL without waiting for the turn.
An explicitly supplied but unverified checkout is refused before posting, rather
than falling back to another configured path.

With a verified checkout, it becomes the session's working directory. Atomic's
workflows, subagents, MCP, web access, Intercom, and default coding tools run
alongside Chopin's document tools. The normal Atomic agent directory (including
`ATOMIC_CODING_AGENT_DIR` or the legacy `PI_CODING_AGENT_DIR` override) supplies
extensions, skills, prompt templates, context files, and a read-only copy of its
settings. Chopin appends its Planner instructions to Atomic's assembled prompt.
Session, settings, and model credentials remain in memory; Atomic's own enabled
tools, extensions, MCP servers, and workflow storage can perform local writes.
Background summary and research workers still use isolated sessions.

Chopin implements Atomic's `HostInput`, bound through
`extensionBindings.humanInput`; it does not intercept tools. `ask_user_question`,
extension dialogs, and workflow-stage input become ordinary shared Decisions:

- Questionnaires retain question and option order, multi-selection, and the
  exact text Atomic supplied; answers return their Atomic question indices and
  answer kinds, including a selected option's preview.
- Every card offers a written answer. It returns as Atomic's `custom` kind where
  Atomic's own dialog accepts typed text (single-select without previews), and
  otherwise as typed `chat`, which Atomic delivers to the model as the member's
  inline message (blank `chat` text is Atomic's plain request to talk first).
  Chopin never reports written text as a chosen option, and Atomic workflows
  treat `chat` as a request to keep discussing, not approval.
- Confirm uses Yes/No; only choosing Yes approves. Select returns only a supplied
  choice. Input and editor use free-text cards; hints and initial editor text
  appear verbatim in the prompt. Explicitly submitted empty text is an answer,
  not cancellation.
- Workflow cards show `Workflow run: <id>; stage: <id>` below their question.
  The label is added to the card only; Atomic receives its question text as
  asked. A request is appended as one adjacent batch at the end of the document.
- An abort withdraws still-open cards, removes their document nodes, and records
  cancellation by `@chopin` in Decisions. Member cancellations retain any answers
  already given in that batch. Late submissions cannot approve withdrawn input.
- `ATOMIC_PLANNER_INPUT_TIMEOUT_MS` optionally limits each request (a positive
  integer in milliseconds, at most 2147483647). Unset waits indefinitely. Expiry
  withdraws pending cards and returns no answer; confirm returns false.

Host input is not held to the Planner `ask` tool's per-field limits on question
and option counts or header, question, label, description, and answer lengths.
Only Chopin's aggregate bounds apply. A request whose cards would take the
document past its 256 KiB source limit fails with that message before any card
appears. A written answer is limited by one shared-draft edit (64 KiB) and the
whole draft (256 KiB). Text is never silently truncated. Atomic keeps durable
workflow approvals pending on withdrawal; Chopin does not automatically resume
workflows or replay interrupted turns after a restart. A new Atomic session must
explicitly resume a saved run.

## Permission checks

Before each Chopin host tool or its repository-bound GitHub MCP tool executes, callbacks recheck:

- current instance admission;
- the owner process session and its user;
- ownership generation;
- credential revision and expiry;
- repository push or administration access; and
- the App installation's repository access.

Permission is decided before execution. A refusal therefore produces no normal
tool start or completion event; the Chat service renders permission
denials explicitly so the boundary remains visible.
These checks do not mediate full mode's Atomic coding tools, operator extensions,
or operator-configured MCP servers; those use the operator's local authority.

A harness session is bound to one credential revision. Before an eight-hour
GitHub App token refresh, Chopin aborts and discards every Planner session
using that revision. The next turn creates a fresh session with the new token.

## Chat context

The channel chat transcript is durable, but not every historical message is sent to
every turn.

- Messages since the last turn are retained as immediate backscroll, capped at
  40 entries and normally 8,000 characters. One message is retained intact even
  when it alone exceeds that character budget.
- A recreated Copilot session receives at most the last 100 transcript entries
  and 50,000 characters. Reserved Planner transcript-summary and cursor fields
  exist in storage, but the current runtime does not advance them. Generated
  descriptions and legacy summaries under durable `document-summary@1` are
  separate and are not bootstrap context.
- The Planner reads the current document through the plan-named `read_plan` tool
  instead of receiving a stale embedded copy.

Chat references are typed server-side resources, not URLs the model can
follow. `#` selects another ordinary document in the current repository.
References persist with their message, but `read_reference` accepts only the
bounded set retained by the active Planner session. A document reference reads
latest canonical source and reports whether it changed since selection. New
messages no longer offer `%` research references; persisted references from the
removed Research Workspace interface still return a bounded compatibility
projection. Both forms are untrusted evidence, and neither changes the
room-fixed target of `read_plan` or editing tools.

Messages from people retain their GitHub handles so disagreement is not merged
into one anonymous user voice.

## Session lifecycle

A harness session is disposable. A process restart, credential rotation,
logout, or ownership reset discards it. A later turn bootstraps from the
bounded transcript and reads the current document.

An interrupted turn is visible and is never replayed automatically because it
may already have made durable document or question changes. `HarnessAgent.stream()`
returns an AI SDK stream that `chat/service.ts` consumes part by part; the Chat
handler remains active until that stream finishes.

The runtime starts lazily on the first Planner turn or model-backed worker
attempt. `AGENT=off` prevents those turns and disables the background-job
runner. For the `copilot-sdk` adapter this also avoids starting Copilot CLI.
`AGENT=off` does not disable `/mcp`, and the prototype UI may still contain
Planner-oriented explanatory copy.

## Background jobs

Background jobs are durable Chopin requests, not child Planner turns. Registered
definitions control their input and artifact codecs, enqueue origins, credential
mode, timeout, failure budget, declared progress, and artifact settlement. Every
model-backed stage uses a fresh disposable harness session with a structured
`output` schema. Job output is not
automatically injected into Chat or recreated Planner context, although
the Planner may explicitly read an artifact in a later turn.

An inline `/research` submission persists the exact brief and starts work
immediately. During an explicit member turn, the Planner can call the
plan-named `create_research_workspace` tool with that same exact brief; it may
not refine, broaden, or replace it. The public worker's structured `output`
binds a host `web_search` tool reached through GitHub MCP; the public worker
receives only the brief.
Parent-document context goes to a separate no-web worker after evidence
completes. A validated initial report publishes as an ordinary child document;
it never edits the parent's collaborative prose automatically.

Jobs with `credential: "active-planner"` use the channel's process-local Planner
owner and entitlement, while fenced claims store no token. Full definition
registration, lifecycle, isolation, disclosure, retry, configuration, and
testing guidance is in [Background jobs and workers](background-jobs.md).

Generated document descriptions use this active owner in a private disposable
worker. The durable definition remains `document-summary@1`; marked V1 requests
produce one-line type, purpose, and subject metadata, while markerless legacy V1
artifacts remain readable only as summaries. The generated value is untrusted
model output and is neither the structured MCP creation `brief` nor the reserved
Planner transcript `summary`.

Open, edit, restore, and MCP creation paths schedule descriptions lazily. They do
not establish Planner ownership, and there is no unattended scan of every
document. Without an active owner, model-backed work cannot run; the last
completed description, if any, remains visible while work is pending or failed.

## Implementation graph status

The Planner can draft and revise a graph with `read_implementation_graph` and
`edit_implementation_graph`. It cannot approve, lock, or start implementation.
Those are explicitly human and coding-agent responsibilities.

The graph tools remain technically available in any channel, but the child
browser surface exposes no implementation or task destination. Child
implementation is therefore outside the supported product workflow. The
supported MCP handoff can read only graphs on MCP-created documents, and no
current production interface lets a person approve the draft. See
[Experimental implementation lifecycle](implementation-lifecycle.md).

## Main implementation points

- Harness selection, adapter factory map, and startup checks:
  `apps/server/src/harness/harnesses.ts`
- Planner, summary, and research `HarnessAgent` configurations:
  `apps/server/src/harness/agents.ts`
- Planner session lifecycle: `apps/server/src/harness/session.ts`
- Host-executed GitHub MCP tools: `apps/server/src/harness/github-tools.ts`
- Copilot SDK adapter: `apps/server/src/harness/copilot-sdk/adapter.ts`
- Atomic SDK adapter: `apps/server/src/harness/atomic/adapter.ts`
- Planner prompt and document tools: `apps/server/src/agent/planner.ts` and
  `apps/server/src/agent/tools.ts`
- Repository-fixed tools: `apps/server/src/agent/repository.ts`
- Ownership and Chat lifecycle: `apps/server/src/chat/service.ts`
- GitHub App session lifecycle: `apps/server/src/auth/session.ts`
- Background job registry and runner: `apps/server/src/jobs/registry.ts` and
  `apps/server/src/jobs/runner.ts`
