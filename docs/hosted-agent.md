# Hosted agent (Planner)

Chopin's Copilot-backed document agent is currently named Planner. It can
inspect one selected GitHub repository, co-author the shared document, ask the
participants structured questions, and anchor decisions to prose. For documents
used as plans, it can also draft an implementation graph. It does not implement
code or change GitHub.

The product role is document co-authoring. The current prompt and tool vocabulary
remain optimized for planning and may structure another document type as a plan;
that is an implementation limitation, not the document model's boundary.

## Ownership

The first eligible editor to invoke the Planner supplies the GitHub App user
access token and Copilot entitlement for that channel. The user must pass
instance admission and have repository push or administration access. Ownership
is assigned atomically in storage and guarded by a generation token.

That process-local login owns the channel's Copilot usage until it expires, logs
out, the server restarts, or the authenticated reset API releases it. The
current web application does not expose a reset control. A user without Copilot
entitlement sees the provider failure on the first turn and remains owner until
one of those release conditions occurs.

PostgreSQL stores the owner session ID only so durable ownership can refer to an
active process session. The cookie verifier and GitHub credential remain in
memory. Startup clears every browser-session registry row and owner reference,
while preserving the document, transcript, reserved context fields, and
ownership generation.

## Runtime isolation

The shared Copilot runtime runs in SDK `mode: "empty"`. Each disposable SDK
session receives its owner's token when created and has no client-level service
token or logged-in-user fallback.

The Planner has no:

- checkout, shell, or host filesystem;
- skills, plugins, or configuration discovery;
- repository-local instruction loading;
- shared embeddings or cross-session store; or
- ability to change GitHub.

Available capabilities are:

- Chopin document, question, relationship, and implementation-graph tools (with
  current plan-oriented tool names);
- bounded file and tree reads plus commit history fixed to the default branch
  captured when the SDK session is created;
- repository-scoped code search, post-filtered by repository node ID; and
- repository-bound, read-only pull-request MCP calls.

Issue and general search MCP tools are refused because linked objects and
free-form qualifiers can cross the selected repository boundary. Repository
REST tools construct owner and repository coordinates on the server, bound
response sizes and line ranges, reject path escape, and post-filter code search
by GitHub repository node ID.

The Planner does not see a user's local checkout, current branch, working tree,
or uncommitted changes. A coding agent must compare the repository context
returned by Chopin with its checkout before claiming work. The server validates
the shape of creation provenance but does not resolve its branch and commit
against GitHub or independently inspect the coding agent's checkout.

## Permission checks

Before each custom or MCP tool executes, callbacks recheck:

- current instance admission;
- the owner process session and its user;
- ownership generation;
- credential revision and expiry;
- repository push or administration access; and
- the App installation's repository access.

Permission is decided before execution. A refusal therefore produces no normal
tool start or completion event; the conversation service renders permission
denials explicitly so the boundary remains visible.

The in-memory SDK session is bound to one credential revision. Before an
eight-hour GitHub App token refresh, Chopin aborts and discards every Planner
session using that revision. The next turn creates a fresh session with the new
token.

## Conversation context

Channel conversation is durable, but not every historical message is sent to
every turn.

- Messages since the last turn are retained as immediate backscroll, capped at
  40 entries and normally 8,000 characters. One message is retained intact even
  when it alone exceeds that character budget.
- A recreated Copilot session receives at most the last 100 transcript entries
  and 50,000 characters. Summary and cursor fields exist in storage, but the
  current runtime does not advance them or generate a durable summary.
- The Planner reads the current document through the plan-named `read_plan` tool
  instead of receiving a stale embedded copy.

Messages from people retain their GitHub handles so disagreement is not merged
into one anonymous user voice.

## Session lifecycle

Copilot CLI session files and SDK session IDs are disposable. A process restart,
credential rotation, logout, or ownership reset discards the SDK session. A
later turn bootstraps from the bounded transcript and reads the current document.

An interrupted turn is visible and is never replayed automatically because it
may already have made durable document or question changes. `session.send()` only
accepts a message; the conversation handler remains active until the SDK emits
its idle event.

The runtime starts lazily on the first Planner turn. `AGENT=off` prevents those
turns and avoids starting Copilot CLI. It does not disable `/mcp`, and the
prototype UI may still contain Planner-oriented explanatory copy.

## Background jobs

Background jobs are durable Chopin requests, not child Planner turns. Registered
definitions control their input and artifact codecs, enqueue origins, credential
mode, capabilities, timeout, attempts, and AI-credit ceilings. Every model-backed
attempt uses a fresh disposable SDK session. Its events, prompts, tools, and
results never enter Conversation or recreated Planner context.

Running definitions can append fixed, code-owned progress stages to their fenced
job claim. The capped log is durable and appears in Tasks & Progress after reload
or reconnect. It never contains model prose, prompts, private document content,
URLs, or credentials. Interrupted stages expose only bounded reason categories
such as unavailable web search, timeout, lost heartbeat, or unavailable owner;
raw provider errors are not published. Server diagnostics contain only stage,
phase, call/result booleans and counts, and bounded machine error codes.

The scheduler creates revision/hash-addressed document summaries after canonical
document commits. Source snapshots are loaded into memory for an attempt but are
not persisted with the job. Publication rechecks the exact current document while
holding the same mutation gate used by room opening and live edits.

A writer can insert an inert `ResearchQuestion` component and explicitly assign
it. Assignment discloses that component's question text to the public GitHub
Copilot web-search tool. Public search receives no private document or repository
tools. A separate private stage receives canonical document context with no web
capability, and a final no-tool stage synthesizes bounded findings and validated
HTTPS citations. Reports never edit collaborative prose automatically.

Citation provenance comes only from successful web-search output: SDK citation
metadata, rich citation annotations, or typed resource links. The
server canonicalizes public HTTPS URLs but never follows, resolves, or fetches
them, and rejects report URLs absent from the prior search output.

Jobs use the channel's active Planner owner's process-local credential and
entitlement. No token is persisted. Logout, rotation, owner reset, expiry,
cancellation, timeout, claim loss, and target supersession synchronously revoke
local result acceptance; durable claim generations reject every late artifact.
`BACKGROUND_JOBS=off` disables scheduling and status surfaces. `WEB_RESEARCH=off`
disables new assignment and execution; older queued research pauses until the
flag is restored and an owner returns. `AGENT=off` keeps persisted status and
artifacts readable but schedules no new summaries and never starts Copilot CLI.

## Implementation graph status

The Planner can draft and revise a graph with `read_implementation_graph` and
`edit_implementation_graph`. It cannot approve, lock, or start implementation.
Those are explicitly human and coding-agent responsibilities.

Graph drafting is available in any channel. The supported MCP handoff can read
only graphs on MCP-created documents, and no current production interface lets a
person approve the draft. See
[Experimental implementation lifecycle](implementation-lifecycle.md).

## Main implementation points

- Planner prompt and tool boundary: `apps/server/src/agent/planner.ts`
- SDK client and available-tool filter: `apps/server/src/agent/client.ts`
- Permission callbacks: `apps/server/src/agent/permissions.ts`
- Repository-fixed tools: `apps/server/src/agent/repository.ts`
- Ownership and conversation lifecycle: `apps/server/src/chat/service.ts`
- GitHub App session lifecycle: `apps/server/src/auth/session.ts`
