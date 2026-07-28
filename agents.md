# Working on chopin

Notes for whoever changes this next, human or otherwise. The readme is for
people running it; this is for people editing it.

## Commands

```bash
bun run dev        # supervisor: Vite + server on one origin, Ctrl-C stops both
bun test           # 230 tests, no agent spawned
bun run types      # every package
bun run ci         # dprint check && oxlint
bun run build      # production client
bun run start      # serve the built client
```

`bun run dev` needs `GITHUB_TOKEN`. `AGENT=off` runs everything except the
agent, which is what the tests use.

## Shape

```
packages/dialect     4.5k   the MDX dialect and its Lexical schema
packages/editor      5.4k   the browser editor, cursors, the sidecar
packages/question    1.8k   questionnaires: definition, shared answer, derivation
packages/protocol    0.9k   the wire, as types, plus the addressing rule
apps/server          8.8k   rooms, documents, questions, comments, the agent
apps/web             1.4k   the three panes
scripts/dev.ts              the development supervisor
```

Dependencies point one way: `apps` depend on `packages`, `packages` depend on
`protocol`, and nothing depends on an app. `protocol` is types plus one runtime
module — the rule for whether a message addresses the agent, which both ends
need and must not disagree about.

## How a room works

Each room holds a Yjs document with a **headless Lexical editor bound to it**.
That mirror is the reason the server can validate an edit rather than relay
bytes it cannot read: it turns opaque CRDT updates into a tree that can be
projected back to canonical MDX with nobody connected.

Client updates are grouped for 5ms, applied together, and only then
acknowledged. Yjs cannot undo a transaction, so a batch that leaves the
document invalid is not rolled back — the document is rebuilt from its last
known-good state under a fresh epoch and everyone re-opens.

Agent edits take a different path. They are staged on the parsed document,
serialised, re-parsed, validated, and only then _reconciled_ into the live
tree, so blocks the agent did not touch keep their Lexical identity and nobody
loses a cursor to somebody else's edit.

Canonical MDX goes to `data/<room>/plan.mdx` on a debounce, with questionnaire
records, comment threads, anchors and the transcript beside it. Yjs history is
deliberately not persisted: it would buy undo across a restart at the price of
a binary checkpoint that could disagree with the source.

## Decisions, and why

**The dialect is an allowlist.** Anything not described in
`packages/dialect/src/dialect.ts` is rejected before it reaches a renderer.
Plan content is parsed and rendered, never evaluated.

**The permission gate is the only boundary.** There is no sandbox — this runs
as you, on your filesystem. So `apps/server/src/agent/permissions.ts` is an
allowlist: writes refused outright rather than confined, reads limited to
`WORKING_DIR` with credential patterns excluded, shell limited to commands the
runtime classifies read-only, unrecognised kinds denied. Read it before
pointing the agent at anything you care about.

**Ids are minted wherever a component is created**, client or server. A ULID
has enough entropy that two editors cannot collide, so buying uniqueness with a
round trip would only make a block appear later than the keystroke that asked
for it. The agent's ids are minted server-side in `plan/edit.ts` because a
model that copies a block it read copies the id with it.

**The record owns an answer; the plan shows it.** A questionnaire's answer
lives in `data/<room>/state.json`, and what appears in the MDX is a projection
kept so the source reads correctly alone. An agent rewriting the prose around a
decision cannot change the decision.

**Resolution is two-phase.** Answering has to reach both the record and the
document, and until both have happened nobody may be told it is final. A failed
document write rolls the claim back and the questionnaire stays open.

**The agent acts only when addressed** with `@ai`. Everything else is
conversation, carried into its next turn as context. Without this, two people
planning together cannot talk — "should we ask about auth first?" would start a
turn. Not `@plan`: it is the most common noun in the product.

**Accepting a comment is an address.** The `@ai` rule separates conversation
from instruction, and a button press is already the latter — so accept starts a
turn, through the same queue a message does. It writes a system line into the
transcript, because an agent that begins editing for no visible reason is worse
than a noisy log. Accepting also freezes the thread: it is what the room
settled, so `edit_plan` cannot author or remove the `<Decision>` it projects.

**Anchors are a relative position plus a digest**, and the two do different
jobs. The position survives edits around a block; the digest recovers it when
the position cannot resolve — a move rebuilds a block's collaborative identity,
and an epoch rotation discards the history the position was expressed in. A
digest matching two blocks recovers neither.

**A passage is the same idea one level finer.** A comment marks a phrase, not a
block, so it carries the block anchors plus a pair of relative positions into
the text and the quoted words. The positions make the highlight stretch as
somebody types inside the phrase; the quote finds it again when they cannot
resolve. Two occurrences equally near the recorded offset recover neither.

**A client sends what it read, not where it thinks that is.** `comment:start`
carries block indices and the selected text; the server finds the quote and
mints every Yjs position itself. Finding it is the concurrency check, and a
better one than a digest — it tests whether the sentence is still there, which
is what matters, and a browser cannot compute a canonical block digest without
re-serialising the document. The two ends must agree on which blocks the source
addresses; they need not agree on the offset, so a divergence surfaces as a
refusal rather than a comment landing on the wrong sentence.

**Hard-fail at boot.** A missing token, an unusable CLI or a `WORKING_DIR` that
is not there are all detectable in seconds by trying, and discovering them when
somebody types their first message is worse. `AGENT=off` is the deliberate way
to run without one.

## Things that fail silently

Every bug found in this project so far was invisible. These are the mechanisms.

**An unhandled node type kills collaboration.** MDXEditor re-serialises the
document on every update, and a type its serialiser cannot write throws inside
the first update listener — which stops every listener after it, including the
one that syncs. The editor keeps accepting edits and none of them leave the
browser. `registry.test.ts` asserts every dialect node is writable; keep it
passing when you touch the dialect.

**Lexical swallows errors thrown inside `editor.update()`**, routing them to the
editor's `onError`. A seeding failure looked like an empty document until
`plan/room.ts` started carrying the error out by hand.

**Everything in an SDK event lives under `event.data`**, and several fields have
near-homonyms on the envelope. `event.id` is the event's; `event.data.messageId`
is the message's. Reading the wrong one produced a duplicated reply and a
streaming caret that never stopped. Nothing throws.

**`session.send()` resolves when the message is accepted, not when the turn
ends.** Waiting on it alone tears the handler down before the agent has said
anything. Turns end on `session.idle`.

**A custom agent's `tools` list cannot admit MCP tools.** Not by wildcard, not
by exact name, not with the server declared on the agent. The entry matches
nothing and is dropped without a word, and the agent then explains its way
around the absence. The session's `availableTools` is the filter that
understands `builtin:`, `mcp:` and `custom:` prefixes — the allowlist lives
there, and the agent declares none of its own.

**Permission is decided before execution**, so a refused tool produces no start
and no completion. `chat/service.ts` renders `permission.completed` denials as
failed tool chips; without that a boundary the agent keeps hitting is invisible.

**Tailwind v4 translate utilities emit the `translate` property**, not
`transform`. They compose rather than override, so an element positioned by
script must not also carry them.

**A gate on a message is not a gate on a button.** `chat:send` checks
`config.agent`; accepting a comment reached `Chat.instruct` directly and opened
a session under `AGENT=off`. Anything that can start a turn has to check, and
the check lives in `instruct` now so the next one cannot miss it.

**Rebasing used to happen only inside `edit_plan`.** So a block a person moved
kept its anchors broken until the agent next happened to edit, and everything
restored from disk was expressed in a history the new document did not have.
It now runs on the snapshot debounce, on an epoch rotation, and before `open`
returns — and the flush broadcasts only when the snapshot actually moved,
because a recovery nobody is told about is the same as no recovery.

**`CSS.highlights` is a document-wide registry**, shared with Lexical's remote
cursors. Ours are named `plan-comment*`, its are `lexical-cursor-*`; a
collision would silently unpaint somebody's selection.

**`bun run <script>` does not exit when what it started dies.** It sits there
with no child. `scripts/dev.ts` spawns both processes directly for this reason,
and gives each its own process group so the whole tree can be taken down.

**Vite's `strictPort` does not catch a second instance** when the two bind
different address families, which is why the dev server binds `127.0.0.1`
explicitly rather than `localhost`.

## Conventions

Tabs, `let` over `const`, double quotes, no semicolon-free style — `dprint fmt`
settles all of it. `oxlint` is the linter; `oxc/no-map-spread` is off because
these records are copy-on-write by intent.

Comments explain _why_, and are worth writing where the reason is not
recoverable from the code. Most of the comments in this repository exist
because something above surprised somebody.

Tests describe behaviour rather than implementation, and their names read as
sentences about what the system does. Prefer a test that fails when the
behaviour regresses over one that fails when the code is rearranged. A few
places have no test on purpose — anything requiring layout, since happy-dom
returns zero for every measurement and a test there would assert a fiction.

## Diagnostics

The agent prints what it can actually call, once per session:

```
[agent] 41 tools: anchor_plan, ask, bash, edit_plan, github/get_commit, …
[agent] github mcp: 29 tools offered
```

That line exists because a dropped tool is otherwise undetectable. If the agent
starts claiming it cannot do something, read it before anything else.

`DEV_QUESTIONS=1` makes a room ask a sample questionnaire on open, which
exercises the whole question path without an agent. `DEV_COMMENTS=1` marks a
real phrase in whatever the room already holds, which does the same for
passages — anchoring, carrying across edits, freezing into a decision — before
any of it has a sidecar to be driven from.

## Origins

The dialect, the editor and the questionnaire model began as a port of Ace's
plan feature, restructured to stand alone: no sandbox, no VM, one server, rooms
in memory. It is a one-time port — work happens here now, and there is no
attempt to track upstream.

Several defects were ported along with the code and fixed here: a link prompt
that inserted unvalidated URLs and cost the room its epoch, a selection toolbar
placed twice, an edge correction measuring its own output, and the `github/*`
tool entry that never resolved. If you work on Ace too, they are still there.
