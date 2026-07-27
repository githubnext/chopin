# chopin

A collaborative plan, written by a room and an agent together.

Several people edit one MDX document at once, with cursors and presence. A
planning agent reads the repository, writes into the same document, and asks
the room when something cannot be settled from the code alone. Answers are
decided collaboratively, recorded against whoever made them, and linked to the
prose they produced.

It is a prototype. Rooms live in memory, identity is a claimed GitHub handle,
and the agent runs as you on your own filesystem.

## Running it

```bash
bun install
GITHUB_TOKEN=$(gh auth token) bun run dev
```

Then open **http://localhost:8787/r/main?as=your-github-handle**

Open the same URL in a second browser profile with a different `?as=` to see
the multiplayer half. Two tabs in one profile also works — identity is stored
per tab.

Ctrl-C stops everything it started.

## Talking to the agent

The agent acts only when addressed:

```
should we cover the export format?     → the room only
yes, Markdown for now                  → the room only
@chopin                                → acts on the conversation above
@chopin draft the export section       → acts on that
```

Anything said without the mention is still carried into the agent's next turn,
so a room can settle something between themselves and the agent arrives already
knowing. The composer says which a message will be before you send it.

## What to try

1. Type in the plan with two windows open, and watch the cursors.
2. `@chopin write a plan for adding X`, and watch it read the repository and
   write into the document you are looking at.
3. Ask it something it cannot know: `@chopin ask us whether to support Y`. The
   question appears in the decisions pane on the right, both windows can edit
   the answer together, and either can submit it.
4. Hover the answer once it is decided — the prose it produced lights up.

## Configuration

| Variable       | Default             | Meaning                                                     |
| -------------- | ------------------- | ----------------------------------------------------------- |
| `GITHUB_TOKEN` | —                   | Required. The agent's credential and the GitHub MCP bearer. |
| `WORKING_DIR`  | repository root     | Everything the agent may read. Printed at startup.          |
| `SERVER_HOST`  | `127.0.0.1`         | Bind address. `0.0.0.0` for a LAN or a tunnel.              |
| `ACCESS_KEY`   | unset               | When set, required to connect.                              |
| `MODEL`        | `claude-sonnet-4.6` | The planner's model.                                        |
| `AGENT`        | on                  | `AGENT=off` runs the editor with no agent at all.           |
| `PORT`         | `8787`              |                                                             |
| `DATA_DIR`     | `data`              | Where rooms are written.                                    |

## Sharing a room

The client derives its socket from the page's own origin, so a tunnel works
without configuration:

```bash
ACCESS_KEY=$(openssl rand -hex 8) SERVER_HOST=0.0.0.0 bun run dev
cloudflared tunnel --url http://localhost:8787
```

Send `https://<tunnel>/r/demo?as=their-handle&key=<key>`. The key is taken out
of the address bar once the page has it, so it does not sit in a screen share.

**The agent is the exposure, not the plan.** Anyone who can reach the room can
prompt it, and it can read everything under `WORKING_DIR`. Point that at a
throwaway checkout before sharing a link.

## How it is put together

```
packages/dialect     the plan's MDX dialect and its Lexical schema
packages/question    questionnaires: definition, shared answer, derivation
packages/editor      the browser editor, cursors, decisions pane
packages/protocol    the wire, as types
apps/server          rooms, documents, questions, the agent
apps/web             the three panes
```

The server holds each room's document as a Yjs document with a headless Lexical
editor bound to it, which is what lets it validate an edit rather than relay
bytes it cannot read. Canonical MDX is written to `data/<room>/plan.mdx` on a
debounce; Yjs history is not kept, so a restart resumes the content under a
fresh epoch.

Three things are worth knowing if you intend to change it:

- **The dialect is an allowlist.** Anything not described in
  `packages/dialect/src/dialect.ts` is rejected before it reaches a renderer.
  Plan content is parsed and rendered, never evaluated.
- **The permission gate is the only boundary.** There is no sandbox. Writes are
  refused outright, reads are confined to `WORKING_DIR`, and shell commands must
  be ones the runtime classifies as read-only. It is worth reading
  `apps/server/src/agent/permissions.ts` before pointing this at a real
  checkout.
- **An unhandled node type kills collaboration silently.** MDXEditor
  re-serialises the document on every update, and a type its serialiser cannot
  write throws inside the first update listener — which stops every listener
  after it, including the one that syncs. `registry.test.ts` is the guard.

## Development

```bash
bun test          # 224 tests
bun run types     # every package
bun run ci        # dprint + oxlint
bun run build     # production client
bun run start     # serve the built client
```

Tests never spawn an agent; they set `AGENT=off`.

## Origins

The dialect, the editor and the questionnaire model began as a port of Ace's
plan feature, restructured to stand alone: no sandbox, no VM, one server, rooms
in memory. What changed, and why, is in the commit history.
