# Hosted agent (Planner)

Chopin's Copilot-backed document agent is currently named Planner. It can
inspect one selected GitHub repository, co-author the shared document, ask the
participants structured questions, and anchor decisions to prose. For documents
used as plans, it can also draft an implementation graph. Under `copilot-sdk` it
does not implement code or change GitHub; under `atomic` it runs as a full
Atomic session, described [below](#full-atomic-planner); under `remote` its model
runs in a member's own client, described in [Remote Planner](#remote-planner).

The product role is document co-authoring. The current prompt and tool vocabulary
remain optimized for planning and may structure another document type as a plan;
that is an implementation limitation, not the document model's boundary.

Chopin runs the Planner through `@ai-sdk/harness`: `HARNESS` selects one adapter
from a code-owned map, defaulting to `copilot-sdk`, a host-process adapter over
`@github/copilot-sdk`. `atomic`, which embeds Atomic's headless SDK
(`@bastani/atomic`) in the server process, is a further reviewed adapter and
requires an explicit `HARNESS_AUTH`. `remote` runs no model in the server at
all: each turn goes to a client attached over the agent connection. The harness owns
the agent loop and model. Under `copilot-sdk`, Chopin owns every tool the
Planner can call.

**Choosing `HARNESS=atomic` gives the Planner shell and filesystem access as the
server process's user, on hosted instances as well as local ones.** No other flag
turns this on or off. Operators who do not want it should use `copilot-sdk`. See [Self-hosting](self-hosting.md#choose-and-trust-a-harness) for
`HARNESS`/`HARNESS_AUTH` selection and adapter trust.

## Choosing the model and reasoning level

A person with write access can choose the model and the level of reasoning (thinking) of a
document's Planner from the Chat composer. The choice belongs to the document: everyone who opens
it sees it, it survives a reload and a restart (`planner_model_choices`, see
[Storage](storage.md)), and it applies from the next turn. Until somebody chooses, the harness
runs what it always did, so nothing changes. Choosing a model records that model, the one marked
_Default_ included, so the document keeps it if the harness's or the client's default later
changes; the reasoning control's _Default_ returns the level to the model's own.

The server owns what can be chosen, never the browser. It builds a catalog from the harness and
sends it to the room in `chat:model` (with the stored choice) when somebody joins and when either
changes:

| Harness                     | Catalog                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Applied by                                                                                                                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atomic`                    | The models of the Atomic model runtime the adapter builds: every chat model it has credentials for that `HARNESS_AUTH` would run, as `provider/model`, in the order the runtime reports them (the picker groups them by provider, in the order each first appears, and a model it reports twice is listed twice, a choice of that id being the first entry's), with each model's thinking levels as Atomic reads them (`xhigh` and `max` only where the model maps them) and its context size as the description. `MODEL` is the default. | The turn's `model` and `thinkingLevel`, set on the session; with no level chosen the model runs its own (the level saved for it in the operator's Atomic settings, else their default level, else `medium`), whichever model or level the session held before. |
| `remote`                    | What the attached client reported in its [capability catalog](agent-connection.md#capability-catalog), with `MODEL` as the default when set. An older client, or one that reports no models, offers none.                                                                                                                                                                                                                                                                                                                                 | `model` and `thinkingLevel` in the `turn` message; the level only to a client that offered `capability-catalog`.                                                                                                                                               |
| `copilot-sdk` and any other | None: the composer offers no control, because a choice nobody honors is not offered.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Not applicable.                                                                                                                                                                                                                                                |

The thinking level is a field of the turn the harness is given, beside `model` (`PlannerTurn` in
`apps/server/src/harness/turn-level.ts`). `HarnessAgent` builds a turn from a fixed set of fields
that has none for it, so the call that starts a Planner turn carries the level and the harness
wrapper puts it on that turn; no turn can see another's, and a background job's turn has none.

`chat:model` checks a choice against the catalog reported now, stores it under the writer lease
and only then answers the sender and tells the room. It refuses a model or a level the catalog
does not list (whatever its spelling or length: only the catalog decides, and what it lists is
stored as written), a field that is not a string, a choice for a child document
(which uses its root's), and every choice where no catalog is offered; choosing nothing goes back
to the default. Every Planner turn a person started resolves the stored choice again. A model that
has gone, or a level its model no longer lists, is not sent: the default runs, Chat says so once
while the reason stands (and again if it changes, or comes back after the choice was honored), and
the composer shows what will run. The stored choice is
kept, so it returns to force if the model does. Background jobs never carry a choice.

The composer says so even where nothing can be chosen any longer. When a client withdraws all its
models, or an older client takes its place, there is no catalog and the picker is gone, but the
stored choice is still sent in `chat:model` and the composer's notice says that the model is no longer
available and the default runs until a turn records that fallback in Chat. It does not repeat the
transcript line.
A document nobody chose for says nothing. The choice is held back while what a remote Planner
offers is unknown: with no client attached (a machine that is away, a server that has just restarted)
or one that offered the catalog and has yet to report it. The choice is then neither gone nor
honored, and the machine's own status speaks. It stops being unknown for a client that offered the
catalog and never reports it once a turn has run for want of it and fallen back on the saved
choice: that has happened, Chat says it, and the room is told the choice without repeating the
same fallback above the composer. A report that comes later, or
another client, starts again from what it reports. A person who can only read the document sees
none of it.

A turn that cannot read the choice at all (the catalog or the stored choice fails to load) never
runs the default silently. It runs the default, Chat says once, while that holds, that the
document's model choice couldn't be read, and the server tells the room with `chat:model-unreadable`
(`true`, and `false` when a later turn can read it again; a person who joins meanwhile is sent
`true` after the Chat history), so every open composer shows the same words in its notice until a
turn can read the choice again. Nothing stored is changed. These words are the composer's own
notice, a cause of their own beside the page's connection banner: drawn beneath the machine's
banner when that is drawn, and giving way, as the composer's other notices do, to the room's
own connection banner, a refused send and a failed reply, then returning with the connection
([design guide](../apps/web/DESIGN.md)).

### Commands the Planner offers

The same `chat:model` carries `commands`: what `/` offers in Chat besides Chopin's own
(`/research`), each with a `name`, a `kind` and a one-line `description`. Only the document's own
Planner supplies them, read each time somebody joins or the state changes:

| Harness                     | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atomic`                    | What an Atomic session in the Planner's working directory finds: its prompt templates (`prompt`), its skills (`skill`, named `skill:name`, as Atomic invokes them) and the workflows registered for it (`workflow`). The session is built as a Planner's is, in the operator's agent directory and the checkout, and ended at once; nothing goes to a model. It is read once for 30 seconds per directory, however many people join. Atomic's own extension commands are not offered. |
| `remote`                    | What the attached client reported in its [capability catalog](agent-connection.md#capability-catalog), as written, and nothing once that client has left. An older client, or one that reports none, offers none, and so does a machine that is away.                                                                                                                                                                                                                                 |
| `copilot-sdk` and any other | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The list is the document's Planner's alone. A remote Planner's commands are held with its attached
link, so another person's machine, or an earlier client of the same document, never shows its own.
A list that cannot be read leaves the field out and never fails the model state.

Choosing a command in the composer inserts it as a chip at the start of the draft, and the send
carries it as a `command` reference (`name` and `commandKind`, the `kind` the Planner reported, so a
name two kinds share is never run as the other) over the range of its `/name` token. The server
checks it against what the Planner reports at that moment and refuses what it does not offer, in
words the composer shows under the draft it keeps: `/name is not one of the commands the Planner
offers.`, `The Planner has not reported any commands, so /name cannot run.` (nothing attached, or
a client that reports none), `A command has to open the message.` and `A message can run one
command.` A command goes to the Planner; sent to the room it is refused. The reference is kept
with the message (the same persisted shape as a document reference, so a queued or saved request
keeps it across a restart) and the Planner's turn is built from it:

| Kind                            | The turn's prompt                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skill`, `prompt` and any other | Atomic's own invocation, `/name args`, alone: the room's earlier words and the focused child's line wait for the next turn (a fresh session has them in its instructions), so the prompt opens with the `/`.              |
| `workflow`                      | A request, in the person's turn as any message is, to start the registered workflow by name with the workflow tool's run action; the words after the chip are given as its input, said to be data and not an instruction. |

Chopin's own commands (`/research`) keep their behaviour: they are never sent to the Planner, and
the Planner's list never replaces them. A command in a queued message is not checked again when its
turn starts: if the Planner has since lost it, Atomic reads `/name` as text.

## Coaching in an invoked turn

The Planner is instructed to develop a small, provisional account of the problem
early, using the current document and relevant repository evidence. It distinguishes reported
experience, verified behavior, hypotheses, its own recommendations, and human
decisions. A suggested remedy, such as onboarding, does not become an agreed
requirement merely because someone mentioned it.

Every request for human input, including missing intent and clarification, uses
the `open_decisions` tool. The Planner drafts provisional prose, then batches the
known independent questions (up to ten) into separate cards beside the passages
they inform. Written answers capture intent, experience, constraints and unknown
alternatives; choice cards offer grounded alternatives where useful. Both forms
can appear in one batch. Cards stay open after the Planner finishes its turn,
and people can answer in any order. Only Save settles an answer. Repository facts need answers, not votes. Optional
exploration can remain provisional without becoming a Build blocker.

On every harness, Chat buffers each complete Planner text message and checks it
with the deployment's decisions classifier before publication. Requests for input
are withheld and the same session gets one continuation to create inline cards.
A continuation that repeats cards an earlier turn already created, by their stable
keys, counts as having created them only while those cards still hold their question:
open, reopened or answered. A key repeated for a different question or passage is
refused, and a card a person discarded, or that was cancelled or expired, counts for
nothing and is never recreated, so the turn still reports that it could not move its
questions.
Completed tools and the original request are not replayed. Failed, missing,
malformed or interrupted checks never publish unchecked prose; uncertain judgments
also withhold it. Chat prose therefore arrives after validation rather than token
by token. This is a semantic check and can misclassify language.
If both generated replies are withheld after the turn durably captured new inline
decisions, Chat reports their count in a fixed server-authored summary. It never
publishes the withheld text or claims the whole request succeeded. Without new
captured decisions, the turn still reports failure.

An answer, correction, or contradictory finding should change the affected
prose and its anchors, followed by the next useful authorized action. Disagreement
stays attributed rather than becoming artificial consensus. Pauses, dismissals,
and requests to continue exploring remain meaningful. An unanswered, cancelled,
or expired question is not consent.

The Planner can recommend a small first build and explain what it would teach,
while leaving broader questions open. This is advice about scope, not technical
readiness or approval. Graph preparation retains its separate read/edit workflow
and does not edit prose; only people approve and start implementation.

Saving an anchored Planner decision durably queues a scoped prose update, independently of
conversation-analysis flags. It uses the complete saved answers affecting that passage and
updates only its explicit target. Applied answer generations commit with the source, so an
interrupted retry cannot write them twice. Lost or ambiguous targets refuse safely. Work waits
for an existing authorized Planner owner; it never claims ownership from a viewer or saver.
The same Save also hands the answer to a Planner turn, so the Planner acts on what was decided
rather than only rewriting the passage; answers saved close together share one turn.
See [Decisions](decisions.md) for the shared answer lifecycle.

This does not start background research without an explicit request. Blocking `ask` remains
available for an explicitly synchronous exchange and keeps that turn waiting for answers or
cancellation. Ordinary unaddressed Chat retains its addressing and title-maintenance behavior.

The [coaching evaluation suite](../evals/planner-coach/README.md) separates live
model transcripts and independent rubric review from deterministic tool-boundary
tests. Its synthetic repository is an evaluation fixture, not a description of
Chopin's current interface.

## Ownership

The first eligible editor whose saved Chat message starts title maintenance, who
invokes the Planner, or who starts a model-backed research request supplies the
GitHub App user access token for that channel and, under
the default `copilot-sdk` harness, the Copilot entitlement. Under
`HARNESS=atomic` the owner supplies only the GitHub token; model access
comes from the operator's `HARNESS_AUTH` mode. Under `HARNESS=remote` the owner
also supplies only the GitHub token, and the model runs in the client attached
to the document; only [attaching](#remote-planner) makes an account the owner
there. The user must pass instance
admission and have repository push or administration access. Ownership is
assigned atomically in storage and guarded by a generation token.

That login owns the channel's model usage in this process until it expires, logs
out, the server restarts, or the authenticated reset API releases it. The
current web application does not expose a reset control. Under `copilot-sdk`, a
user without Copilot entitlement sees the provider failure on the first
model-backed action and remains owner until one of those release conditions
occurs.

Title maintenance uses an isolated heading job after a member message is saved,
including ordinary coworker messages. It works with `CONVERSATION_PLAN=off`
without Jev and is disabled by `AGENT=off`. It preserves weak-context titles and
existing body prose. When the topic changes it may refine a blank title, the
generated name of a document created without one, or the title a Planner last
drafted (kept in the sidecar as `plannerTitle`). A title a person set, at
creation, by renaming or by editing the heading, is never replaced; the job may
still seed a goal beneath it. Once a person renames the document or edits its
heading, the sidecar records `titleChosen` and no later draft replaces their title,
even a blank, a generated-looking name or the Planner's own earlier draft.
A drafted title also waits for a person who is renaming: while anyone has the
header's title field open or the caret in the heading (`plan:titling`), while
anyone still connected has typed in either, and for a minute after the last of
them lets go, the job keeps the current title. The drafted title is not offered
elsewhere; the next saved message drafts again.
Missing credentials, an absent remote attachment and an implementation lock keep
new work pending. Closing or detaching interrupts live work; reconnecting never
replays an interrupted job. Under `remote`, title work uses only the attached owner
and cannot claim ownership for a message sender.

An MCP [`invoke_planner`](local-agent-mcp.md#hand-an-instruction-to-the-planner)
call follows the same rules. Its instruction is posted as the caller's own
message; the turn runs under the channel's current owner, whoever that is. A
channel without one is claimed for the caller's live browser login, hosted or
local, and without such a login the call is refused and nothing is posted.
With `as: "system"` the call is an
[automatic follow-up](local-agent-mcp.md#automatic-follow-ups): Chat shows a
system notice naming the caller instead of their message, and the instruction
goes to the Planner alone. Only the document's creator or the account holding
its Planner may send one, at most 10 an hour per document.
Under `HARNESS=remote` only attaching claims ownership. An `@chopin` message or
`invoke_planner` call for a document without an attached Planner is refused with
`planner-not-attached`, and with one it runs as a turn on that Planner under its
owner. (A person's request is no longer refused: it is [saved](#saved-requests) and
starts once a Planner attaches, in hosted mode and under `AUTH_MODE=local` alike.) Other
Planner requests, such as sending a comment to the Planner or a Build draft, claim nothing
either: with a client attached they run on it, and without one they are saved the same way.
A research request claims no ownership either: its
workers run on the attached client as [isolated sessions](#remote-planner), and
without one the request waits until a client attaches.

An attachment lasts only as long as its owner. Signing that browser login out,
its expiry, or a repository writer's reset of the document's Planner closes the
attached connection at once and frees the document for any eligible account to
attach; see [Agent connection ownership](agent-connection.md#ownership).

Planner ownership stores only the owner session ID, referring to a login loaded
in this process. Hosted logins separately persist encrypted credentials in
PostgreSQL. Startup clears every owner reference while preserving valid hosted
sessions, the document, transcript, reserved context fields, and ownership
generation. A returning browser must present its cookie and pass authorization
before that session is available for a new Planner claim.

## Runtime isolation

Under `copilot-sdk` the Planner receives only Chopin's host-executed
tools: document, question, relationship, implementation-graph, repository, and
GitHub tools, each bound to the channel's repository through `toolsContext`. No
harness built-in is active for the Planner. The default `copilot-sdk` adapter
additionally runs the shared Copilot runtime in SDK `mode: "empty"`: each
disposable session receives its owner's token when created and has no
client-level service token or logged-in-user fallback. That detail is specific to
the Copilot SDK adapter, not a property every harness in `HARNESS` shares.

The CLI process does not inherit the server's environment. It receives the
proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, lowercase forms) and the
certificate variables (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`) the
server has set, so a server behind a proxy reaches GitHub through it, and nothing
else; see [Self-hosting](self-hosting.md).

The two pull-request tool names and input schemas are available when a Planner
session opens. GitHub MCP discovery runs on the first pull-request tool call,
using the owner's current credential. An unavailable server or missing required
tool fails that call; document-only turns do not wait for discovery.

That isolated Planner has no:

- checkout, shell, or host filesystem;
- skills, plugins, or configuration discovery;
- repository-local instruction loading;
- shared embeddings or cross-session store; or
- ability to change GitHub.

Chopin's tools available to the Planner under every harness are:

- Chopin document, question, relationship, and implementation-graph tools (with
  current plan-oriented tool names);
- Chopin's child document tools (`list_children`, `read_child`, `edit_child`,
  `anchor_child`), bound to the root document's own children and rechecked on
  every call (owner access, parentage, repository, and archive state); `read_child`
  [pages like `read_plan`](#reading-a-large-document). They are
  never offered to background jobs, and unexpected storage errors reach the
  model only as a generic message;
- bounded file and tree reads plus commit history using the session's default
  branch, or an explicitly supplied full commit ID when inspecting investigation evidence;
- repository-scoped code search, post-filtered by repository node ID; and
- bounded reads of document and historical research references attached to the
  current Chat context; and
- pull-request tools that only read, reached through `createMCPClient` against
  GitHub's remote MCP server and bound to the channel's repository. This is the
  Planner's own tool set; machines, not the Planner, use the App's write
  permissions (see
  [Authentication](authentication.md#who-writes-to-repositories)).

A comment note sent to Chopin (`to: "planner"` on `comment:start` or
`comment:reply`; the server never looks for a mention in the text) starts or
joins a turn about that one thread, under the sender's claimant session after
the same write-authority recheck as Chat. That turn alone may call
`reply_comment { thread, text }`: it refuses any thread other than the one the
running turn was sent, and a resolved or full one, and persists the Planner's
note before the room sees it. The turn's `edit_plan` writes are recorded as the
thread's result. If the turn ends having said something in Chat but nothing in
the thread, that last message is posted to the thread for it. Background jobs
cannot call `reply_comment`.

A child document has no Chat. A comment sent to Chopin inside one is admitted
by its root's queue and starts or joins a turn on the root's Chat, with the
child as the turn's focus; the root's transcript notice names the child. That
turn alone may `reply_comment` in that child thread, and its `edit_child` writes
are the thread's result. The note is saved in the child before the turn is
queued, and the reply is saved in the child before the child's room sees it.
Admission, queueing the turn, and `reply_comment` each re-ask storage that the
child still belongs to a live root in the same repository; admission refuses the
note before saving it when it does not. The end-of-turn fallback reply is posted
to the child room the note came from, which stays held until that turn ends,
without asking again. Planner ownership is the root's.

Issue and general search MCP tools are refused because linked objects and
free-form qualifiers can cross the selected repository boundary. Repository
REST tools construct owner and repository coordinates on the server, bound
response sizes and line ranges, reject path escape, and post-filter code search
by GitHub repository node ID.

Foreground Planner writes on every harness and MCP document creation and updates
share a server-owned visual admission check. New prose, lists and nested passages
are assessed for whether a faithful visual is possible, helpful, and which native
type fits. A selected diagram or comparison table must appear beside its passage
before the write is accepted. A successful prose judgment permits prose; there is
no diagram quota. This applies to blank drafts, long requests, and imported plans
without requiring `PLANNER_VISUALS`.

Assessments run in bounded batches outside the room queue. Failed or malformed
assessments refuse the write. Admission follows the shared assessment's probability
thresholds and selected type, including an explicit no-suitable-type result. It
does not add a confidence veto: confidence describes competition between types,
not whether the document write is valid. Every selected visual is still required
and validated. Refusals identify the passage and required representation and
include syntax guidance for repair.
Successful assessments are cached by passage and context while diagrams are
repaired. Unchanged prose with its existing visual is preserved. A concurrent edit
still invalidates the proposed revision. Background jobs retain their isolated
contracts. The legacy `assess_visual` single-paragraph handoff remains available
to sessions without the shared gate.

The isolated Planner does not see a user's local checkout, current branch, working tree,
or uncommitted changes. A coding agent must compare the repository context
returned by Chopin with its checkout before claiming work. The server validates
the shape of creation provenance but does not resolve its branch and commit
against GitHub or independently inspect the coding agent's checkout.

Under `HARNESS=atomic` the Planner is a [full Atomic session](#full-atomic-planner),
but the summary and research workers each still own one isolated in-process
Atomic `AgentSession`. It is built with every shipped Atomic package disabled
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

## Full Atomic Planner

Under `HARNESS=atomic` every Planner session is a full Atomic session, in local
and hosted deployments alike, with no separate flag. The workflows it starts
get shell and filesystem access **as the server process's user**, not a sandbox
confined to a repository. Operators who do not want that should use
`copilot-sdk`. Both `HARNESS_AUTH=auto` and `ai-gateway` work, under
their usual [bind rules](self-hosting.md#choose-and-trust-a-harness).

The Planner's own turns offer only read-only tools beside Chopin's document and
repository tools: `read`, `find` and `search` for the working directory,
Atomic's web research tools, `ask_user_question`, `workflow`, and `intercom`,
plus the read-only tools the operator names in `chopin.plannerTools` of the
agent directory's `settings.json`, such as a code search tool a package
registers:

```json
{ "chopin": { "plannerTools": ["my_code_search"] } }
```

Only the operator's file counts: a checkout's `.atomic/settings.json` can't add
tools to a Planner, and a name that edits files, runs commands or starts agents
(`bash`, `edit`, `write`, `kill`, `subagent`, `todo`) stops the Planner from
starting. It cannot edit files, run commands, or start subagents itself, so it
never implements the plan; a workflow it starts keeps the tools its stages
declare. Atomic's workflows, MCP, web access, and Intercom run alongside
Chopin's tools. The normal Atomic
agent directory (including `ATOMIC_CODING_AGENT_DIR` or the legacy
`PI_CODING_AGENT_DIR` override) supplies extensions, skills, prompt templates,
context files, and a read-only copy of its settings. A verified checkout's
`.atomic/settings.json` is read the same way, as trusted project settings, so
packages installed for that project load too; the document's own directory
has none. Paths in `HARNESS_EXTENSIONS` load in every Planner session as if
passed to Atomic's `--extension` flag, so a package listed there adds its
extensions, skills, and workflows without being installed in the agent
directory. Tools those extensions register load but are not offered to the
Planner's own turns unless they are named above; workflow stages still load
them. Chopin's compaction, summary, and cache overrides still apply on top.
Chopin appends its Planner
instructions to Atomic's assembled prompt. Session, settings, and model
credentials remain in memory; Atomic's own enabled tools, extensions, MCP
servers, and workflow journal can perform writes as the server process's user.
Background summary and research workers still use the isolated sessions described
above.

The working directory comes only from the `checkout` argument of
[`invoke_planner`](local-agent-mcp.md#hand-an-instruction-to-the-planner).
Chopin checks the path with Git and compares `origin`'s owner/repository to the
document's repository, case-insensitively. HTTPS, `ssh://`, and scp-style
remotes are accepted. Remote host spellings are ignored because SSH aliases are
common; this verifies repository coordinates, not the authenticity of a remote
host. An unverified path refuses the invocation before anything is posted. A
verified one is remembered in memory for that document until the process exits,
and every later Planner session for the document, browser-started or MCP-started,
re-verifies it before using it as its working directory.

Without a remembered checkout that still verifies, the session runs with the
same tools in a directory Chopin keeps for that document alone under its per-user state
directory (`$XDG_STATE_HOME/chopin/planner/<document id>`, defaulting to
`~/.local/state`; `~/Library/Application Support/Chopin/planner` on macOS;
`%LOCALAPPDATA%\Chopin\planner` on Windows), with mode `0700`. It is never shared
with another document, keeps what the Planner and its workflows write there
across later sessions and server restarts, and is not placed in the shared
temporary directory. A symlink or file at that path is refused. The Planner's
instructions state which case applies: a verified checkout, or an empty
directory with no repository files, in which case it reads the repository through
Chopin's repository tools.

The Planner still does not implement the plan. When a member asks to implement it
now, its instructions note that its `intercom` tool can reach other sessions on
the same machine, such as one working in a checkout of the document's
repository, and that it can pass the request to one of them and tell the member
where the work continues. Chopin does not track or verify that handoff.

Chopin implements Atomic's `HostInput`, bound through
`extensionBindings.humanInput`; it does not intercept tools. `ask_user_question`,
extension dialogs, and workflow-stage input become ordinary shared Decisions:

- Questionnaires retain question and option order, multi-selection, and the
  exact text Atomic supplied; answers return their Atomic question indices and
  answer kinds, including a selected option's preview. An option's `preview` is
  kept as its own field and shown framed under the option, as Markdown that may
  hold an image of the document's, a Mermaid diagram or a table; see
  [Option previews](agent-connection.md#option-previews). The Planner's own
  `ask`, `open_decision` and `open_decisions` tools take it too.
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
- Workflow cards show their question exactly as asked, with no run or stage
  ids; Chat's run card shows which run is waiting on Decisions. A request that
  names the block it concerns goes, as one adjacent batch, directly after that
  block and is linked to it (see
  [Agent connection questions](agent-connection.md#questions)). One that names
  none, or a block that has changed since, is appended at the end of the
  document, not linked yet.
- An abort withdraws still-open cards, removes their document nodes, and records
  cancellation by `@chopin`. Member cancellations retain any answers already
  given in that batch. Late submissions cannot approve withdrawn input.
- A request has no time limit. It waits until members answer it or it is
  withdrawn: the Planner stops, its run is cancelled, the document is archived
  or deleted, or the asker's link closes for good, which includes its owner's
  sign-in ending. A lost connection is never such an end. A link that dropped
  unexpectedly and offered `resumable-sessions` keeps its open questions and live
  runs for its account to [resume](agent-connection.md#resuming-after-a-dropped-link)
  however long it stays away: no timer, including `PLANNER_ATTACH_GRACE_MS`, ends
  them. While it is away Chat shows the runs with their last status, marked
  disconnected rather than stopped, and adds no line about the connection (the machine
  button and the cards carry it); the Decisions stay open and answerable, their answers kept
  for the client. A Stop pressed meanwhile, or sent and still unanswered when the link
  dropped, is held for the client's return (the line that records the Stop says so) rather
  than lost; Stop on
  a Planner that only waits on a question withdraws it, and Chat says that. A
  document on **Default machine**
  keeps its Planner running while that Planner is replying or waits on a question
  or a live or paused workflow run, a disconnected Planner's kept work included, so
  nobody viewing the document does not withdraw it or cut its work short.
- Cards an earlier Chopin closed unanswered after a fixed time stay in the
  document and in Decisions, among the resolved cards, marked
  `status="expired"`; each reads "Nobody answered this question, so the Planner
  used its best judgement for this decision." Nobody can answer an expired card.

Host input is not held to the Planner `ask` tool's per-field limits on question
and option counts or header, question, label, description, and answer lengths.
Only Chopin's aggregate bounds apply. A request whose cards would take the
document past its 256 KiB source limit fails with that message before any card
appears. A written answer is limited by one shared-draft edit (64 KiB) and the
whole draft (256 KiB). Text is never silently truncated. Atomic keeps durable
workflow approvals pending on withdrawal; Chopin does not automatically resume
workflows or replay interrupted turns after a restart. A new Atomic session must
explicitly resume a saved run.

A coding agent can hand an instruction to the Planner with
[`invoke_planner`](local-agent-mcp.md#hand-an-instruction-to-the-planner) under
any harness. The instruction is posted as the MCP caller's own message and runs
under the document's Planner ownership rules (see [Ownership](#ownership)).
Harnesses other than `atomic` ignore its `checkout`.

## Remote Planner

Under `HARNESS=remote` the Planner's model runs in a client attached to the
document over the agent connection, usually an agent on a member's own machine. The server keeps the document, Decisions, room writes, and anchors; the
client keeps its code, model credentials, and its own tools. The adapter
(`apps/server/src/harness/remote`) forwards each Planner session as `start` and
each turn as `turn`, and re-emits the parts the client streams back.

The agent connection is a WebSocket at `/api/v1/agent`, on the application's own
origin, with the `chopin.agent.v1` subprotocol.
[Agent connection](agent-connection.md) is its complete wire format, written for
clients that cannot import Chopin's packages. Its messages are declared and
validated by `@chopin/agent-link` (`packages/agent-link`), whose minimal
client in `@chopin/agent-link/client` uses only that wire format at runtime. Every message is a JSON text frame of at most
2 MiB, checked against a strict schema; a binary, malformed, out-of-order, or
oversized message ends the connection (close codes 1008 or 1009) after an `error`
message naming the problem.

| Server to client                                      | Client to server                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `attached` or `refused` (answers `attach`)            | `attach` (version, document id or URL, checkout identity)                              |
| `start` (session, `planner` or `isolated` mode)       | `started` or `start-failed`                                                            |
| `turn` (prompt, instructions, host tool specs)        | `tools` (the client's own tools for this turn)                                         |
| `abort`                                               | `part` (text, reasoning, tool input, own tool call/result, finish-step, finish, error) |
| `host-tool-result`                                    | `host-tool-call`                                                                       |
| `input-result` (answered, expired, cancelled, failed) | `input-request`, `input-cancel`                                                        |
| `stop`, `resume` (Stop and Resume Planner)            | `control-result`, `runs` (run cards for Chat)                                          |
| `destroy`                                             | `turn-end`, `detach`                                                                   |

**Attaching.** The upgrade request offers the `chopin.agent.v1` subprotocol, or
is refused with HTTP 426. It carries `Authorization: Bearer <GitHub token>`,
checked exactly as hosted MCP checks it: the token must resolve through instance
admission, a bad or missing token gets HTTP 401, a refused account 403, a foreign
`Origin` 403, and GitHub outages 503, all before anything is upgraded. The first
message must be `attach` with protocol version 1. Its document is resolved like
an MCP document locator, and the bearer's own account must have push or
administration access to the document's repository. An unsupported version, a
repository it cannot write, or a missing or archived document is refused with a
`refused` message and close code 4426, 4403, or 4404. Neither attaching nor a
refusal posts anything to the document. The account and repository access are
checked again before every session and every turn the connection starts, including
turns of a session kept for its runs, and every 5 minutes while the connection stays
attached; losing either fails that session or turn and closes the connection with
`access-revoked`.

A paired machine can attach instead with a document-scoped Planner credential
from `POST /api/connector/planner`, which `chopin connect --planner` hands to a
Planner backend command it starts per document
([Planner backend commands](agent-connection.md#planner-backend-commands)). Its
access is checked with the machine's own GitHub authorization, and it owns the
document through a delegated login of the machine's owner that no browser holds
(`apps/server/src/harness/remote/machine-planners.ts`), so no browser sign-in is
needed and signing out does not release it. A machine its owner shares with
teammates does the same for a teammate's document as its owner, where they chose it or made it their favorite; the same sharing
is the owner's consent for that teammate's builds and runs to run on the machine
too, as the owner (see
[Share a machine with teammates](chopin-cli.md#share-a-machine-with-teammates)). Revoking the machine, or GitHub
refusing its authorization, ends that login and closes its connections with
`access-revoked`.

**Ownership.** Attaching makes the account the document's Planner owner through
the same generation-guarded storage claim as any other owner
(`apps/server/src/harness/remote/attachments.ts`). The owner record names the
account's live browser login, not the connection, because Chopin's repository tools
run with that login's GitHub App token and never with the connection's bearer; an
account with no live sign-in since the server started is refused with
`sign-in-required` (4401). The login must pass the same eligibility as every
Planner owner: instance admission and push or administration access. This is
stricter than the design's "can read the repository", because an attached
client steers what the Planner writes and runs repository tools as the owner.
An owner left without an attachment, which only a race or an operator reset can
produce, is cleared under its generation and the document is claimed again.

One client holds a document's Planner. While it is attached, every other
`attach` for that document is refused with `planner-attached` (4409) and a
message naming its GitHub login. A connection that detaches, or drops with no
workflow run or open question to keep, keeps the ownership for
`PLANNER_ATTACH_GRACE_MS` (2 minutes by default). A connection that
answers none of the server's [protocol pings](agent-connection.md#pings) for
`AGENT_CONNECTION_TIMEOUT_MS` (2 minutes by default) is closed as dropped, so a
client whose network silently went away does not keep the document attached.
Within the grace period the same account can attach again and keeps the same
ownership generation; anyone else is refused. A link that offered
`resumable-sessions` and dropped unexpectedly while it had runs or open questions
instead keeps the ownership with no deadline, as the document's **disconnected**
Planner: the same account takes back the sessions, runs and questions whenever its
client returns, however long that takes, and nobody else can attach meanwhile.
Nothing but an explicit act ends that hold: a sign-out or expiry of the owner's
login, a Planner reset, revoking or unpairing the machine, the owner choosing
another machine for the document, the document being archived, a Stop that
withdraws the last thing it kept (which then runs the grace period as a detach
does), or the same account attaching with a client that holds nothing to resume.
A machine that only went quiet, or a Default machine idle period, never
does. The grace period is an ownership lease on a connection that is no longer
there, not a timeout on active work: it never runs while a client is attached or
disconnected with work kept. When it ends, the ownership is cleared under its
generation, so a newer owner is never released by an old timer. An attach, including a grace
reattach, binds only if no sign-out, expiry, or Planner reset of its ownership
landed while it was checking, including the eligibility checks of the sign-in
it is about to claim with; otherwise it is refused like an attached connection would
be closed. Attachments live in the server process, so a restart does not keep a link,
but it does keep what its client holds: at the cut, and when a link drops with work
kept, the server writes each hold to `planner_link_holds` (see
[Storage](storage.md#postgresql-schema)): the sessions the client holds, the questions
it waits on, the answers it has not acknowledged and the Stops it has not heard. The next
process rebuilds each as a suspended hold, so a client that returns and sends `resume`
takes its sessions back. Startup's reset keeps the owner of a document whose hold names a
browser sign-in that has stored credentials; a paired machine's hold names the machine
and no login, which a restart cannot keep: the machine's backend attaches again with its
credential, which is stored by digest and so accepted at once, and its new login takes over
the hold.

**The hand-over window.** A hold whose link the cut closed is given `HANDOVER_PLANNER_WINDOW_MS`
from the release of the lease, the time its client is told it has. The cut cannot know when the
release will be, so it writes the window's length with the hold (`handover_until` is the write
plus that length) and the next process, which can take the lease only after the release, counts
the window again from the moment it rebuilds the hold: no step between the write and the release,
however slow, and no late takeover takes anything from it, and a client that comes back at any
moment of the window it was told finds the machine attached. A process that rebuilds a hold more
than an hour after the cut wrote it finds no window: no deploy takes so long, and such a row was
left by a cut no process followed. Only the process that rebuilds the hold is given the window:
it rewrites the row without it before it shows the hold (a write that fails is logged, and the
window is still given), so a process that starts after that one crashed, inside the window or
after it, finds the hold of a link that had already dropped, disconnected. Until the window ends, `session:planner`, the owner's own views and
Planner comments treat it as attached, with its login, so no member sees it disconnected or
reconnecting; a request to it is saved as a row and starts when it resumes, and workflow
runs Chat stored come back live, not stopped. A `resume` inside the window before the owner's
browser sign-in is back (it comes back with the browser's cookie) is not refused: it waits, with
the link kept and the machine shown attached, and the sessions are handed back the moment the
sign-in is. One still without it when the window is over is refused with `unavailable` and
`retry`, which a client retries; it is never `sign-in-required`, which would end the link. A
`resume` inside the window ends it. When it ends with no resume the hold is disconnected,
as a dropped link is today, announced, with run cards marked disconnected, and the miss is
logged with its cause: the owner's sign-in or the client was not back. A hold that was already
disconnected keeps its state and gets no window, and one in its grace period is not kept.
A question a client waited on is not waited on again: nothing in the new process can
answer it, so `resumed` does not list it, the client settles it as cancelled, and its
Decision stays open and answerable; an answer starts a Planner turn once one is attached. An
answer given while the link was down, which was owed, is delivered once as before.
A graceful shutdown still tells every link it is going down first, so none withdraws a
question on the way out, and posts no Chat line about the links or the runs. `AUTH_MODE=local` is never handed over, and keeps today's behaviour: holds stay in memory.

**Who is attached.** Each room socket hears `session:planner` after
`session:hello`, and the whole room hears it again whenever an attachment
changes: an attach, a detach into the grace period with the time it ends, a drop
that keeps work (`disconnected`, with no deadline), the grace period ending, a sign-out, a Planner reset, or the server closing a connection
whose ownership was released. It names only the holder's GitHub login and
state, never a machine, checkout, or token. A healthy, attached Planner shows
nothing. Otherwise the document's machine button carries it (a thin spinner while
the machine is connecting, a warning dot where it cannot connect, a muted grey dot
while the Planner is away, and no dot at all where no machine is connected, the same
bare icon as a button with no machine, never the machine's own green) with its words in
the button's name and at the top of its menu, and as the connection banner at the Chat
composer's top edge, once, as it changes: _reconnecting_ while a machine is being connected to,
_dropped_ for a machine that cannot be connected to (with the reason exactly as the machine
reported it, the attempts and _How to fix_, and a button that asks the machine to try again
through `chat:wake`), that is offline or that has stepped away (no button: only that machine
can come back), and, for a person with no machine button, _No machine is connected._ The
page cannot hear the machine while the room's own connection is lost, so the banner then
tells that connection alone and tells the machine again, with the state then known, once
the connection is back. `plannerForBanner` and `connectionStep` decide this, so the button
and the banner cannot disagree. A screen reader hears each phase once as it begins, from
one live region of the page, and nothing when it clears; the region remembers the machine
state it last said, so one that carried on through a loss is not said again when the
connection returns, and a different one is said once. Other harnesses never send it, and
Chat then shows nothing.

These words are plain and name none of Chopin's own terms: _Connecting to studio_,
_Can't connect to studio_, _studio is offline. Last seen 10:31 AM._ for a machine that is away (_Your work is kept._ where no time is known), _studio stepped away.
Your work is kept until 10:31 AM._ for a detached holder with its deadline, and _No machine is
connected._ where none is attached, naming the machine only when it is the one the
document's button names (the person's choice, else the one Default machine uses now), and
otherwise only its owner's login (_@mona's machine_).
_Connecting_ and _No machine is connected_ are said only once they have lasted the 1.5 s a lost connection waits before the page speaks of it, the last state staying until then, so a restart's passing states are never shown; every state clearing goes at once. Through a lost connection the page keeps the last state it knew, however long the machine takes to return: a server that has just started tells `none` to everyone who connects until a machine returns, so the first `none` after the connection comes back is its placeholder, not news of the machine, and nothing is said until another state arrives. A `none` told after any other state, a machine removed while the page is connected, is still said, and so is the first state of a page that has known nothing else. It never names another machine of the list: while the person's machines are loading, while the
list names a machine the document does not run on, a teammate's or another of the person's own,
for a Planner their own account is starting or has lost, while it describes another account's Planner than the page's connection does, or while it was read before the connection's last word, which describes the Planner as it was (the page reads it again on every word, and a read that began after the word is the one that may name a machine), nothing is named
until it agrees. Meanwhile the status says nothing of the machine, however long that takes (a read that fails or a hidden tab leaves it empty, never stale), and what it said of an older word does not stay. The state it last showed and said is remembered through that gap, with the live region silent meanwhile, but only so that the same state naming the same machine, such as a word that repeats it with one more attempt, is neither made to wait out its grace again nor announced twice. Any other state that arrives after the gap is drawn by its own rules, never in place of what was shown before the gap: a state that waits (_Connecting_, _No machine is connected_) draws nothing until it has lasted its grace, so a document moved from one machine to another does not read the first machine's _offline_ before it says it is connecting to the second, and a state with no grace is drawn at once. With no gap, in an ordinary transition, the last state still stays through the grace of the next, so a reconnect does not flicker. A `disconnected` Planner's work is
kept with no deadline. Its live
run cards carry `disconnected` beside the status they last reported: each reads
**disconnected**, not running or stopped, with a still ring instead of the pulse and
its clock held at the last report; an open card says what it last reported and what
happens when the Planner returns. A card offers Pause, named as waiting for the Planner
to reconnect, because Chopin holds it, and no Resume, which it cannot hold. While the
page's connection banner shows, the cards say nothing of the machine: no **disconnected**, no
note, and a plain Pause, with the status as last reported, a still neutral ring and the
clock held; the words come back with the connection, as the state then is. Decisions
stay where they were and stay answerable. **Build plan** says to reconnect the machine
(_Reconnect the machine to build_), and a new comment is not sent to Chopin by default, until
it does. With no machine connected at all it says _Connect a machine to this document to
build_ and offers how to connect one.

While a paired machine is starting the Planner, the state is `starting`. Its
connector reports each launch of the backend that exits before staying up to
`POST /api/connector/planner/failure`: how many in a row, how it ended and the
last stderr line that says why (colors and credentials removed, the home
directory shown as `~`, at most 300 characters). From the second in a row, the
`starting` state also carries `failure` with the count, the reason and when
the last launch exited, so everyone in the document reads why it cannot connect to
the machine; the time is the server's own, not the connector's clock. The report
counts only for a document Chopin asked that machine to run, and is forgotten
when the Planner attaches, when the connector says a launch stayed up, when the
machine is no longer asked for the document, and with a restart. It is a new
route, not a new connector protocol: a connector that does not report is
unaffected, and a server without the route answers a reporting connector 404,
which it takes to mean no.

**Unattached documents.** Members, MCP callers, and research requests never claim
ownership under `HARNESS=remote`. An `@chopin` message or `invoke_planner` call
for a document with no attached client, including one within its grace period or
disconnected with its work kept (the message says its machine is offline and that the work
is kept and picks up when it is back), is saved and waits for a Planner to attach, as
[saved requests](#saved-requests) describe.
Before accepting either, the server rechecks an attached connection as its periodic
recheck would: if the owner's browser sign-in has ended or storage no longer
assigns that owner, it closes the connection, releases the ownership, and refuses the
request the same way. The
refusal names the document URL and says to connect a Planner client to it over
the agent connection from a session in a checkout of the repository, which attaches
that session as the Planner; the browser shows that text on the `@chopin`
request. Room messages are unaffected. Once a client is attached, both arrive as
turns on its connection and run under its ownership whoever sent them.

**Turns and tools.** Chopin's host tools (document, repository, and job tools)
still run in the server against the room, under the document's Planner owner and
the permission checks below. The client calls them with `host-tool-call` and
receives `host-tool-result`. Its own tools run on its machine: it must declare
them with `tools` before calling any, may not reuse a host tool's name, and
reports them as provider-executed `tool-call` and `tool-result` parts. An
undeclared tool fails the turn as a tool boundary failure. Background job
sessions start in `isolated` mode, where the client may offer no tools of its own
and ask nothing. That includes every background worker: the research, research
brief, document description, and History summary workers each open an isolated
session on the client attached to their document, may call only the host tools
their stage offers (the research evidence worker's `web_search`), and return
their structured result as the turn's JSON. The job runner starts no worker for
a document with no attached client; its job stays pending until one attaches. A turn ends with `turn-end`. An abort waits briefly for the
client's `turn-end`, then ends the turn anyway. A turn that ends while one of
its host tools still runs, such as an `ask` waiting on Decisions, stops that tool
and withdraws the cards it opened. A connection that closes mid-turn ends the turn
with an error rather than as a stop, its open questions are withdrawn, and runs
it reported are shown stopped; nothing waits on a client that has gone. A
session the client refuses or does not start in time is destroyed, and any
question it asked while starting is withdrawn.

**Questions.** An `input-request` carries one Atomic `HostInput` call
(`questionnaire`, `confirm`, `select`, `input`, or `editor`) and becomes Decisions
through the same path as the [full Atomic Planner](#full-atomic-planner): the same
verbatim text, the same 30-minute expiry, cancellation that withdraws open
cards, and answers to a workflow question held while the client reports that
run's root as paused. `input-result` returns what Atomic would have received in
process, with a status that tells an expiry from a cancellation.

**Runs.** The client reports its workflow runs with `runs`; Chat shows those
cards and keeps the session after its turn while any run is live or paused, as
for an Atomic Planner. **Stop Planner** and **Resume Planner** send `stop` and
`resume`, optionally for one run, and wait for `control-result`. Unlike an
Atomic Planner's, a reported run that ends blocked or failed between turns gets
only its Chat notice: the reports are the client's word, so they never start a
Planner turn that no writer asked for. A client that asks for the `run-stage-deltas`
feature sends only new and changed stages, so a run's stages have no count
limit; Chopin merges them into the run's stored stages as it does an Atomic
Planner's (see
[Agent connection](agent-connection.md#run-stage-deltas)).

**Trust boundary.** The server never holds the client's model credentials and
gains no shell or filesystem access from this harness. The client, in turn,
receives everything a Planner turn sees: the conversation, the document, and
the results of repository tools that run with the document Planner owner's
GitHub App token, limited to the document's repository, which its own account
can already read. The attached client decides what the Planner writes to the
document during turns writers start, which is why attaching requires the push
or administration access every Planner owner needs. Summary and research workers
have no model in the server either; they run as isolated sessions on the same
client, so attaching also lends that client's model to the document's
background work.

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
These checks do not mediate the atomic Planner's Atomic coding tools, operator
extensions, or operator-configured MCP servers; those act with the server
process's own authority.

A harness session is bound to one credential revision. Before an eight-hour
GitHub App token refresh, Chopin aborts and discards every Planner session
using that revision. The next turn creates a fresh session with the new token.

## Files in Chat

A message can carry images and text files: the `+` in the composer, a drop on it and a paste
add them, and each shows as a chip, with its picture for an image, its name and its size until the
message is sent.
The server keeps them in the document's storage (the `chat_attachments` table and the memory
adapter's equivalent; see [Storage](storage.md)), not in the sidecar, and a sent message shows them
to everyone in the room.

**Upload.** The browser sends each file's bytes to `POST /api/channels/:channelId/attachments`, with
its name and declared type in the query (`name`, `type`), and sees progress as the bytes go. The
route needs a session, the app's own origin, and repository write access to a document that is not
archived. It answers `201` with the file as the server kept it (`id`, `name`, `kind`, `mimeType`,
`size`), or a refusal with a `reason` (`too-large` 413, `empty`, `unsupported` and `image-type` 422,
`too-many` and `too-much` 429, `not-allowed` 403). A file is its uploader's alone until a message is
sent with it: `DELETE` on the same path with the file's `id` takes back one that has not been sent,
and an upload nobody sent within a day is forgotten. One person may leave unsent at most four times
what a message may carry.

**What a file is.** The server reads the bytes and decides, whatever the name or declared type say
(`packages/protocol/attachment.ts`, which the browser runs too, before the upload): a PNG, JPEG,
WebP or GIF is an image; UTF-8 text with no stray control character is a text file; anything else
is refused. A file whose name or declared type says it is an image must be one of those four rasters
by its bytes, so an SVG, a HEIC or a page named `.png` is refused rather than stored under a type
it is not. The file is stored under the type its bytes have, and a text file, whatever it is called,
as `text/plain`.

**Limits.** Three settings, each also told to the browser when it joins: `CHAT_ATTACHMENT_MAX_BYTES`
for one file (1 MiB by default), `CHAT_ATTACHMENT_MAX_COUNT` for a message (5; `0` turns files off)
and `CHAT_ATTACHMENT_MAX_TOTAL_BYTES` for all of a message's (4 MiB). See
[Self-hosting](self-hosting.md). Under `HARNESS=remote` the per-file and total caps are never more
than 1 MiB.

**To the Planner.** A file sent with a message to the Planner reaches its turn as the message's own
parts: a text file as a file part (`text/plain`) and an image as an image part, and only where the
model the turn would run reads images, by its catalog entry's `inputTypes`. A model that does not
say so reads as text only, and so does a harness that reports no catalog (`copilot-sdk`), so the
`+` explains why images are unavailable there and the server refuses an image sent to the
Planner all the same ("This model can't read images"); the same image can go to the room. Atomic is
given images as its own prompt images and each text file written into the prompt under its name;
the Copilot SDK likewise, with images as blob attachments; a remote Planner's client is sent them
in the turn's `attachments` if it asked for that feature, and otherwise as words (see [Images and files in a turn](agent-connection.md#images-and-files-in-a-turn)). If the model has stopped
reading images by the time the turn starts, the prompt says which images were sent and not shown.
A repair attempt of a turn is given the prompt alone.

**Reading.** `GET /api/channels/:channelId/attachments/:id` answers a person who can read the
document, and only once a message has been sent with the file (before that only its uploader may). A
person who cannot, a missing file and another document's file are the same `404`. A raster image is
served inline under its own type; a text file is a download of `text/plain; charset=utf-8`; every
answer carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none';
sandbox`, so a stored file is never rendered as HTML or SVG.

## Dictating a message

The composer has a microphone button where speech can be turned into words, and nowhere else. It
never records until a person presses it (the browser asks for the microphone then and not before),
and it stops on a second press, on Escape, when the message is sent, when the page is hidden, when
the person leaves the document and when the document stops taking messages. Nothing runs in the
background, and what a recognizer reports after a stop is ignored.

**Where speech becomes words.** First the browser's own speech recognition (`SpeechRecognition`,
prefixed or not), and only if the browser says it runs on the device (`processLocally`): a browser
that cannot say so is treated as having none, because without it a browser may send the audio to a
speech service. A device with no model for the person's language is asked to fetch one before the
microphone opens, and is told plainly if it cannot. Otherwise, where `TRANSCRIPTION_MODEL` is set
(off by default; see [Self-hosting](self-hosting.md)), the composer records on the device and, when
the person stops, sends the recording to `POST /api/channels/:channelId/transcriptions` for a person
who can write to the document, from the app's own origin. The server reads the bytes (a recording
a browser makes, a WAV or an MP3, up to `TRANSCRIPTION_MAX_BYTES`), sends nothing else to the
provider, and gives back `{ "text" }`; the route answers 404 where no model is set. The
`session:hello` frame names the provider (`transcription.provider`) only where it is set, and the
button's tooltip then says the recording goes to it.

**What it does to the draft.** Words the recognizer is sure of are written into the draft at the
caret the person had when they pressed the button, spaced as typing would, one result after another;
words it is still working on are shown beside that place in a quieter ink and replaced by the next
result, and are never part of the draft's text, selection or history. The draft stays ordinary
text the person can edit at any time: typing or moving the caret takes dictation with them. A
message sent while speaking is sent as the person saw it. A blocked microphone, no microphone, a
language the device cannot recognize and a lost connection each stop it with a plain message.

**Accessibility.** The button is "Dictate", pressed while listening, with the chord (Alt+Shift+M, ⌥⇧M on
a Mac) in its tooltip and in the keyboard shortcuts sheet; a polite live region says when it starts,
when it stops and why not; and the dot beside it, with the time so far, holds still where the person
prefers reduced motion.

## Chat context

[Automatic participation](conversation-initiative.md) is enabled with the Planner and lets
Chopin reply promptly in solo conversation and yield during human exchanges.
Group turns use a bounded turn-taking judgment and a quiet window. Natural-language
requests can invite Chopin without `@`. It uses this same Planner lifecycle, with
a shared durable pause control; explicit `@chopin` requests remain immediate.

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
  instead of receiving a stale embedded copy. The tool's own result is still that
  structured view as JSON, and the model is shown it as
  [text it can page through](#reading-a-large-document). A short header names the
  `document` id, the canonical `url` MCP `read_document` returns for it (nested
  under the parent for a child document), the `revision` and the size. A renamed
  top-level document adds `earlier urls`, the links it had before, which still
  open it, so the Planner can tell its current link from an old one by data.
  Every structured `edit_plan` result (success, or a locked, stale, or invalid
  refusal) still carries `document: { id, url }`, and `earlier_urls` after a
  rename. Argument and storage errors return plain error text without it. Code
  running inside the session, such as an Atomic extension, can use either to
  address that document over MCP.

After an `ask` questionnaire has a saved answer, its result may include
`current_plan` with the same document, revision, source, block outline, comments,
and question records as the structured view `read_plan` is built from. The
Planner can edit from that revision and
still uses `anchor_plan` to relate the answer to prose. The optional snapshot
has a 50 ms budget for document lookup, owner revalidation, and room access;
if it cannot finish, the saved answer returns without waiting and the Planner
can call `read_plan`. When none of a batch's questions were answered, or lookup
or revalidation fails, the result contains only the outcomes. `open_decisions`
returns `current_plan` the same way. Once that view, as JSON, would take more
than half of one read's 16,000 bytes (8,000 bytes), `current_plan` keeps
`document`, `revision`, and the newest `questions` and `comments` that fit, with
`questions_omitted` and `comments_omitted` counting any left out, and replaces
`source` and `blocks` with `source_omitted`, which gives the source's size, the
block count and the call that reads them. A result that carries the plan stays
within one read's bytes. Edit from that revision only after `read_plan` has
returned the blocks.

Chat references are typed server-side resources, not URLs the model can
follow. `#` selects another ordinary document in the current repository.
References persist with their message, but `read_reference` accepts only the
bounded set retained by the active Planner session. A document reference reads
latest canonical source and reports whether it changed since selection. Typing `%`
no longer opens anything; a research card of this document is chosen from `@` (below),
and persisted references from the removed Research Workspace interface still return a
bounded compatibility projection. Both forms are untrusted evidence, and neither changes
the room-fixed target of `read_plan` or editing tools.

`@` also points at the document's own parts and at its repository, as references the
Planner receives as identities and not as words. A request names the part and never
its text; the server resolves it against the document as it stands when the message
is sent, writes the label the person saw from it, and refuses one that has gone, in
words the composer shows (`That heading is no longer in the document.`,
`That Decision is no longer in the document.`, `That file is not in the repository.`,
`This repository's files cannot be listed right now, so a file cannot be mentioned.`,
`That path is too long to mention.`):

| Kind       | Request       | What the Planner is told beside the words                                                                                                                                                                   |
| ---------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `heading`  | `anchor`      | `[heading anchor "overview", level 1, line 1 of this document]`. The anchor is the heading's text as GitHub slugs it, `-1`, `-2` after a repeat, in document order, over the document's top-level headings. |
| `decision` | `decisionId`  | `[Decision id "<id>" of this document]`. The label is the Decision's header (its prompt where it has none).                                                                                                 |
| `file`     | `path`        | `[file path "src/index.ts" in the repository]`. A plain path from the root: no `..`, `.`, empty part, backslash or control character.                                                                       |
| `research` | `workspaceId` | As before: a reference read by id with `read_reference`, drawn `%Title`. Only a workspace of this document is accepted.                                                                                     |

The composer asks for what it can offer with `GET /api/channels/:channelId/mentions?query=&limit=`
(`limit`, 1 to 20 of each kind, is 6 by default; a query is at most 64 characters). A person who
can read the document gets its headings (`anchor`, `text`, `level`), its Decisions (`id`,
`title`), its research cards (`workspaceId`, `title`: the workspaces the document holds a card
for) and its repository's files (`files`, paths), each narrowed by the query (a title or name
that starts with it first, then a word, then any part) and read from the same source a message's
mentions are resolved against. Anybody else is told the document does not exist. Files are those
of the Planner's checkout where the document has one (`HARNESS=atomic`, what `git` tracks and has
not ignored, kept 10 seconds) and else what GitHub lists for the default branch, read with the
asking person's own session and kept a minute per repository, up to 50,000 paths; with neither,
`files` is left out and a file mention is refused.

None but a document or a research reference can be read by id: a heading, a Decision and a file
are places the prompt already says how to find (`read_plan` shows the document with its Decisions,
the repository tools read a file), and are quoted so a name with a quote or a line break stays one
value. Each is kept with its message, in the same persisted shape, strictly checked on restore.

Messages from people retain their GitHub handles so disagreement is not merged
into one anonymous user voice.

### Reading a large document

A host tool result reaches the model as one string, and a harness may keep only
the head and tail of a long one: Atomic's MCP adapter keeps the first and last
10 KiB of a result over 20 KiB of UTF-8 and drops the middle without a word.
`read_plan`, `read_child` and MCP `read_document` therefore return Markdown with
real newlines, and one result never carries more than **16,000 UTF-8 bytes in
all** (`READ_BYTES` in `apps/server/src/document-reading.ts`). The budget covers
the header, the outline, the lists, the block listing, the source and the lines
that say how to continue; nothing sits outside it. It is well under the 20 KiB
Atomic keeps and the 50,000 characters a harness reads at once.

`read_plan` and `read_child` still return their structured view as JSON, so a
caller that runs the tool itself, or reads the result of a tool-run in the
server, sees the whole document unchanged. The Copilot SDK, Atomic and the
attached client show their model whatever a host tool returned, and the agent
harness applies a tool's `toModelOutput` only to the messages it returns when a
turn ends. `withModelOutput` (`apps/server/src/harness/model-output.ts`) wraps
each real harness, so the result it hands the runtime for these two tools is the
text below, made from the same view. The harness the end-to-end suite fakes, and
`HARNESS` values added later, see the JSON until they are wrapped. The `remote`
harness sends the attached client the same text as `host-tool-result.output`.

```text
document: <id>
url: /documents/<owner>/<repository>/<slug>
revision: 7
size: 168421 characters, 5566 lines, 2214 blocks
lines: 1-120 of 5566
next: read_plan {"offset":121}
This document is larger than one result holds (16000 bytes), so this is its outline and first part. ...

Outline (line, heading):
L1 # Quarterly field notes
L3 ## Site 1: harbour survey

Decisions (their text, options and answers are in the source):
- <id>: open: Which quay?

Blocks starting on lines 1-120 (index type lines digest):
0 heading L1-1 sha256:...

--- source lines 1-120 of 5566 ---
# Quarterly field notes
...
```

- The source is last, after a `--- source lines A-B of N ---` line, and is
  verbatim: the source sections of the results `next:` leads through, joined,
  are the document exactly, with its final newline, CRLF and blank lines. Lines
  are separated by `\n`; a final newline does not start another line, so `lines`
  is the count of lines, not of newlines.
- Without arguments, a document whose whole text fits in 16,000 bytes is
  returned whole (`lines: all N`). A larger one returns its outline (shallow
  headings first, with the line each starts on, in at most 2,500 bytes and with
  a count of any left out) and its first part, and says `next:` with the exact
  call that continues. That is the threshold: `read_document` returns a document of
  up to about 15,000 characters whole, and `read_plan`, whose block listing takes
  about 90 bytes a block, about 6,000 characters of short blocks or more of long
  ones.
- `offset` (a 1-based line) and `limit` (lines) return that slice and the total
  line count. Where the slice fits in the budget it is exact. **`limit` is a
  maximum:** a result that would pass 16,000 bytes stops sooner, and its header
  says so (`limit: asked for 4000 lines from line 1, but one result holds at
  most 16000 bytes, so this one stops at line 521`) with a `next:` for the rest.
  The cap is what keeps a harness from silently cutting the middle of a result,
  so it wins over an exact slice. An `offset` outside the document is an error
  that names the line count.
- A line too long for one result is read in pieces. `column` is a 1-based
  position in line `offset`, counted in Unicode code points (a line's characters
  and then its newline, if it has one), so a piece never splits an emoji or a CJK
  character. A result that ends inside a line says `ends mid-line: line 3 after
  character 30703 of 50001` and its `next:` names `offset` and `column`; the
  result that continues says `starts mid-line`. A `column` needs its `offset`
  and must lie inside that line. Following `next:` covers every character
  exactly once.
- Lists that come with the first part are trimmed to their own budgets, and the
  last line of each says what was left out: the decisions (1,500 bytes; every
  decision, with its options and answers, is in the source), the accepted
  comments (1,500 bytes) and, for MCP, the brief (2,000 bytes; the whole brief is
  in `structuredContent.brief`). A header value is one line of at most 300
  characters.
- A part lists the top-level blocks that start on its lines, with their index,
  type, line range and digest, so a Planner can aim `edit_plan` and `anchor_plan`
  at a block it has read. `read_plan` on a small document lists every block.
- `read_child` has the same text, with `child` and `title` in the header, the
  same `offset`, `limit` and `column`, and a `next:` that names the child. MCP
  `read_document` has the same shape with the document's `id`, `title` and `url`,
  and no blocks. Its `structuredContent` is the whole document as before,
  whatever slice the text carries.

## Saved requests

A request to the Planner that cannot start at once is kept, not dropped and not refused. It is
acknowledged only after it is saved, as a row in `planner_deferred_turns`, in the same commit as
the transcript entry that shows it. Five kinds are kept: a Chat message to the Planner, a member
message from an MCP `invoke_planner` call, an automatic follow-up (`invoke_planner` with
`as: "system"`), a comment note sent to Chopin in a document or in one of its children, and a task
draft from Build. Every one is saved first, even when nothing is running and a machine is there: a
turn begins from its row, once a session is open on the machine, so a session that cannot be
opened leaves the request waiting and a stop before the turn starts loses nothing. A request waits
when a turn is running, when no turn may start because the process is stopping, when a saved
request is already waiting ahead of it, and, under `HARNESS=remote`, whenever no Planner is
attached, however long that lasts. Behind a running turn the queue holds
20 requests; past that the server answers `planner-queue-full` before anything is saved, which is
not a refusal of the message: the sender's browser keeps it and sends it again, in its turn and
with the same request ID, every few seconds until there is room, and shows it as waiting to send
meanwhile. A machine that is away has no such bound. As a chat app keeps a message for someone
who is offline, every request a person sends it is saved, in order, and kept until the machine is
back and takes it or the sender deletes it; none is refused or dropped for how many wait or how
long the machine has been away, and nothing is said in Chat about it. Nor is one turned away for
how many are being saved at the same moment, which is limited to 20 only for a machine that is
there (past which a send is answered `temporarily-unavailable` and sent again, below): a Chat
message, an MCP call and a task draft for a machine that is away are each saved, in the order they
came, however many arrive together and however slowly Chopin finds out that the machine is away.
What remains is a limit on a message's size. A send whose commit
went through but whose answer was lost is answered `temporarily-unavailable` like any passing
trouble, and its row is not forgotten: it is put back in the queue ahead of what was accepted
after it, and in the transcript, when the sender sends the same request again, when the queue next
starts and when the document opens again, so it is delivered once and in order whether or not its
sender asks again, unless it was deleted, which stays deleted. A machine that comes
back with a long backlog takes it one request at a time, in order; while twenty or more still
wait, a new message is held by its sender's browser as for any busy machine. So is any other refusal of a send for a passing reason (the message could
not be saved, the room is changing, authorization is briefly unavailable, too many sends are being
handled, a reference or the open child could not be looked up for storage's sake, or anything the
send itself threw): it carries `temporarily-unavailable`. Only a reference the server finds at
fault (malformed, outside the repository, no longer there) is final. A refusal without either code says the message is at
fault, and is the only one that marks it Couldn't send. Server-authored turns (answers to open
decisions, relinking after a build, settling a prototyped passage) and background jobs are not
kept this way and wait as before. `AUTH_MODE=local` is never handed over. It keeps requests as
rows only where the Planner runs on a machine that can be away (`HARNESS=remote`), so a message to
it waits for the machine as anywhere else; with a Planner on the same computer nothing is away and
the queue stays in memory.

A row is `waiting`, `started`, `ended`, `interrupted` or `cancelled`. Only `waiting` can move to
`started` or `cancelled`, and only `started` to `ended` or `interrupted`; any other move changes
nothing and is logged. Every move is written in one commit with the entry or notice it explains
and published after it commits.

**When a request starts.** In the order they were accepted, once the process is ready, and only
through a check that claims nothing until a login is known to be live. Under `HARNESS=remote` that
is an attached Planner. Otherwise the document's owner must have a live login, or, with no owner,
the login of someone whose request is waiting must be live, and it claims the document. A login is
live again when its browser sends its cookie. The check is tried when the process is ready, when
a login comes back, when a new request is accepted, when a Planner attaches and when a turn ends.
A request whose sender can no longer write is cancelled as failed; one whose focused child
document is gone is cancelled as failed; a comment whose thread was resolved is cancelled without
a notice, because the resolution is what members see. Only one turn is begun at a time: Chopin's
own background jobs (such as keeping a title) wait beside saved requests, run after those ahead of
them, and do not count against the 20 places a person's messages may fill.

**What a person sees.** A message appears in Chat at once, as theirs, with `deliveryState`: `sent`
while the row waits, `delivered` once its prompt is on its way to the machine, and `failed`, with `deliveryFailure`
(`machine-removed`, `access-lost` or `document-unavailable`), when it can never be delivered as
sent. The reason is kept on the cancelled row, so a document that was closed when its request was
cancelled still says why when it opens again. An entry saved before this existed has no state and
reads as delivered. `chat:delete` removes
a message that has not been delivered, for everyone, and cancels its row in the same commit; one
already taken, or someone else's, is refused with the code `message-not-deletable`, and deleting twice
leaves it deleted. That code is the server's last word; a delete refused for any other reason (storage
busy, the message being taken by the machine at that moment) says nothing final. `chat:retry`
sends a `failed` message again as it was. A message that is waiting is not listed in `chat:queue`,
which lists only requests with no entry of their own. Chat says nothing about why a queue waits,
however long it does: the message's own mark is the only sign, and the machine's state is shown on
the machine button alone, as everywhere else. (The design asked for one Chat line after a delay,
saying what the queue waits for; the rule that machine state is not said anywhere else replaces
it, so there is no such line and no `DEFERRED_NOTICE_DELAY_MS`.)

The sender's own message carries one quiet mark, in plain words and readable by a screen reader:
**Waiting to send** (a clock) while only the browser has it, in an outbox that sends it by itself, in
order and once, when the page's connection is back; **Sent** (one tick) once the server has it and
the machine has not taken it, whether the machine is away, still starting, or between processes
during a deploy; **Delivered** (two ticks) once the machine took it. A message not yet delivered
has a menu with **Delete**, even one the browser has already put on the wire, whatever the server
last answered it (an earlier attempt of a message it turned down for a passing reason may have
been kept, its answer lost): the server is told to drop it as soon as there is a connection,
cancels its saved row if it had one, and remembers that it was taken back so that a send still on
its way from a lost connection cannot bring it back. A message
taken back while the page is offline, or whose delete the server has not answered, leaves the Chat
at once and stays gone across a reload: the browser keeps the ids in the tab's session storage, as
it keeps the outbox, and asks again until the server answers, so the message is never delivered and
never comes back. The outbox remembers which messages were put on the wire, across a reload too, so
that a message whose answer was lost, taken back after the page was reloaded offline, is still told
to the server; only a message that provably never left the page is just dropped. Only the server's
last word (`message-not-deletable`) ends the asking, and shows the message again with its mark; a
refusal for a passing reason keeps the message hidden and is asked again after a few seconds, as a
lost connection is asked again on the next one. A message that can
never be delivered as sent, or that the server turned down for good, says **Couldn't send** on
itself, with the reason and **Try again** and **Delete**, and never in a strip above the composer. While the
page's connection banner shows, that line gives way to it and returns with the connection.
A full queue is not that: the message stays marked as waiting to send. The outbox is used only
with a server that acknowledges sends (`chatSendAcks`), and only for messages to the machine.

**Delivered is true.** A request kept as a row is handed to its machine only once a session is
open there: the row moves from `waiting` to `started`, and its message to `delivered`, in the
commit that follows a successful open, immediately before the prompt is sent. If the machine
cannot open a session, which is what a link that dropped as the request was starting does, the
row stays `waiting` and the message stays **Sent**, at the head of the queue and in order. It is
tried again when something says the machine may be there (a request accepted, the machine back, a
login restored), once each time, never in a loop, and without a failure notice or any line in
Chat. A message that starts at once is marked **Sent** until the same point and **Delivered** then. What is not
claimed: the prompt is handed over, not confirmed read, and a connection that drops between the
commit and the send ends the turn with its usual notice and is not run again, as any started
turn.

**Restarts.** When a document opens, rows `started` under an older fencing token are marked
`interrupted`, each with one Chat notice, and are never run again, because their turn may already
have changed the document. A turn cut off at `HANDOVER_TURN_WAIT_MS` ends its row the same way. The
rows still `waiting` rejoin the queue, a comment's prompt is built again from its thread as it
reads now, and a task draft is the document's live draft again, so a second press of Build returns
it. A retried `chat:send` with a request ID the process no longer holds is answered from its row.

## Session lifecycle

A harness session is disposable. A process restart, credential rotation,
logout, or ownership reset discards it. A later turn bootstraps from the
bounded transcript and reads the current document.

The one exception is an atomic Planner session that still owns Atomic workflow
runs when its turn ends. A workflow the Planner starts outlives the turn that
launched it, and its runs belong to that session, so Chopin keeps the session
and its owner binding, and keeps the document loaded, until every run has
finished. The next turn reuses that session, so the Planner can still see and
steer its runs over Intercom; people steer through Chat and Decisions, never a
stage directly. Since Atomic 0.9.44 such a message reaches a busy stage after
its current tool calls finish rather than cancelling them, unless the Planner
sends it as an `interrupt`. **Stop Planner** also pauses the session's live runs, resumably,
through Atomic's session run control, and **Resume Planner** resumes the runs it
paused. A run waiting on a question pauses too: Atomic withdraws the question
from Decisions while the run is paused and presents it again on Resume, and an
answer that arrives during the pause reaches the run only after Resume, so a
paused run never advances. A run that ends blocked or failed while the Planner
is between turns starts a Planner turn about it, on the kept session, so the
Planner reports what happened and what the team needs to do; Chat records the
run's end as that turn's reason, and the session is let go after the turn. The
adapter stops any turn Atomic starts on its own, such as for its lifecycle
notices or, since Atomic 0.9.41, for a message queued while the session is
idle, because Chopin would neither show nor record it. The Planner's next turn
still starts normally.
Chat shows the session's runs as one stack, one row
per run: its name, status (running, waiting on Decisions, paused, or ended), and
elapsed time. Several runs can be live at once. Runs waiting on Decisions come
first, then running, paused, and ended runs, newest first within each, and more
than three rows fold behind "more" without ever hiding a waiting run. Only the
first waiting run, or else the newest live one, shows its stages; any row opens
on click to show its six most recent stages with their status and duration, and
a waiting row links to its Decisions. Chopin stores every stage of a run, with
no limit on how many, in `workflow_run_stages` (see
[Storage](storage.md#postgresql-schema)); the card itself carries only the latest
12, with an unfinished stage under an ended ancestor already shown as stopped.
Its "+N earlier" button unfolds every stage in a list that scrolls inside the
card, loading the stored ones 200 at a time from
`GET /api/channels/<id>/runs/<run id>/stages?offset=&limit=` (for anyone who can
read the document; at most 500 a page) only when someone unfolds it, and says
how many earlier stages nobody reported; "Show fewer" folds it back and forgets
them. Each live row can be paused, and each paused row resumed, on its own; Chat
records who did. The stack and every stage are stored with the document, so a
reload or restart keeps them, including for finished runs; a run that was live
when the server stopped comes back stopped. A stored run's stages go when its
card does. Ended rows stay until the next workflow starts in the
document. When a run ends, Chat also records a line saying how it ended and how
long it took. The session is let go when its runs finish, when its owner
binding ends, or when the document closes. A session that waits on a question
it asked, such as an `ask_user_question` with no reported run, is kept the same way
until a member answers it or it is withdrawn. A turn whose Chat reply could not
be verified, or moved into inline decisions, fails without letting go a session
that still owns runs or waits on a question, so that failure ends no run and
withdraws no question. An explicit Stop still lets go a session that only waits on
a question, but changes nothing for one whose workflows are paused: they and the
question they hold open wait for Resume. The
"was stopped after N min" line records how long the run had lasted when its
session was let go, not a limit; run state is durable in Atomic's
workflow journal, so runs interrupted that way can be resumed from a later
session. Before disposing the session, the adapter waits, for at most 10
seconds, on Atomic's `session.workflows.waitForSettled()` for each run that
finished, failed or was stopped, so a session let go right after a run ends
never leaves that run `running` in the journal; a run whose ending could not be
recorded is logged by its ID. Chopin keeps that journal at
`$XDG_STATE_HOME/chopin/atomic/workflows.sqlite` under the same per-user state
directory as the documents' own directories, because a run resumes only with
the journal and working directory it started in. Each Planner session is
given that file through Atomic's `createAgentSession({ journal })`, so the
server's process environment is left unchanged. An operator's non-empty
`ATOMIC_WORKFLOW_JOURNAL_PATH` names another file instead; Atomic's
`workflows.journal` setting and its `ATOMIC_WORKFLOWS_JOURNAL` and
`ATOMIC_STORAGE` selections do not move a Planner session's journal, and
neither does the shared top-level `storage` setting, including an adapter named
by package such as the libSQL selection `atomic storage join` writes. That
setting does reach the Planner's Intercom: its sessions use the machine's
Intercom broker, which keeps its routing in the selected database and so can
reach sessions on every machine that selects the same one. Atomic
still checks every set `ATOMIC_STORAGE`, `ATOMIC_SESSIONS_STORAGE`, and
`ATOMIC_WORKFLOWS_JOURNAL` when it creates a session, so an invalid value fails
every Atomic turn with a `StorageConfigError` naming the variable. A Build is not a workflow run and has no card in Chat: its tasks, their
state and pull requests show under **Build**, whichever machine runs it. The
Planner's instructions say so, so it does not point people to Chat for a Build.

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

## Diagrams and wireframes

The prompt teaches two validated fence languages. `seecode` holds a JSON spec
for any registered SeeCode diagram or numerical chart. The ordinary prompt lists
the full native catalog, including bar, line, scatter, radar, polar, waterfall,
treemap, heatmap, and Sankey. Numerical aliases have variant-specific purpose
and data requirements; the guide includes labelled synthetic bar, Marimekko and
dumbbell examples that are checked against the renderer.
This capability and the shared visual admission check do not require `PLANNER_VISUALS`.
Ordinary and Atomic Planners
prefer native `seecode` whenever a registered type can represent the required
information. Mermaid is a fallback only for a representation the native catalogue
cannot provide or an explicit user request; it supports numerical charts such as
pie and bar/line charts. Jev-routed diagrams must keep the selected native type
and SeeCode fence, with no Mermaid substitution. `wireframe` holds an indented
outline of interface parts for layouts and mockups; the prompt asks for low
fidelity (short labels on key areas, `lines`, `image` and `grid` with `repeat`
for content, `w=` and `flush` for proportions and app chrome) and forbids
box-drawing or ASCII art in text fences. `edit_plan` and MCP `update_document`
refuse a batch that introduces or changes an invalid fence of either language;
a wireframe refusal names the failing lines, counted inside the fence. An
unchanged malformed fence, such as one a person left mid-edit, is carried
through unrelated edits and moves rather than blocking them.

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
