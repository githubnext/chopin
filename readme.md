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
@ai                                    → acts on the conversation above
@ai draft the export section           → acts on that
```

Anything said without the mention is still carried into the agent's next turn,
so a room can settle something between themselves and the agent arrives already
knowing. The composer says which a message will be before you send it.

To plan against another checkout, point it there:

```bash
WORKING_DIR=../some-project bun run dev
```

## What to try

1. Type in the plan with two windows open, and watch the cursors.
2. `@ai write a plan for adding X`, and watch it read the repository and
   write into the document you are looking at.
3. Ask it something it cannot know: `@ai ask us whether to support Y`. The
   question appears in the decisions pane on the right, both windows can edit
   the answer together, and either can submit it.
4. Hover the decision once it is settled — the prose it produced lights up.
   Click it and the plan goes there, and stays marked for a few seconds after
   the pointer has gone; click again to walk through the rest of what it wrote.
   Comment on a passage and the accepted thread works the same way: its quote is
   the way back to what it produced, which is the only way to find it.

## Configuration

| Variable                     | Default             | Meaning                                                                                   |
| ---------------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`               | —                   | Required. The agent's credential and the GitHub MCP bearer.                               |
| `WORKING_DIR`                | repository root     | Everything the agent may read. Relative to where you run the command. Printed at startup. |
| `SERVER_HOST`                | `127.0.0.1`         | Bind address. `0.0.0.0` for a LAN or a tunnel.                                            |
| `ACCESS_KEY`                 | unset               | When set, required to connect.                                                            |
| `MODEL`                      | `claude-sonnet-4.6` | The planner's model.                                                                      |
| `AGENT`                      | on                  | `AGENT=off` runs the editor with no agent at all.                                         |
| `PORT`                       | `8787`              |                                                                                           |
| `DATA_DIR`                   | `data`              | Where rooms are written.                                                                  |
| `STORAGE_DRIVER`             | `legacy`            | Durable service adapter. `postgres` selects the hosted storage foundation.                |
| `DATABASE_URL`               | unset               | Required by `STORAGE_DRIVER=postgres`; never printed by the server.                       |
| `AUTH_DRIVER`                | `off`               | `github` enables hosted GitHub OAuth and repository discovery.                            |
| `APP_ORIGIN`                 | unset               | Exact public HTTP(S) origin used to construct the OAuth callback.                         |
| `GITHUB_OAUTH_CLIENT_ID`     | unset               | GitHub OAuth App client id.                                                               |
| `GITHUB_OAUTH_CLIENT_SECRET` | unset               | GitHub OAuth App client secret.                                                           |
| `SESSION_ENCRYPTION_KEY`     | unset               | 32 random bytes as 64 hex characters; encrypts stored OAuth tokens.                       |

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

See [Document architecture](docs/architecture.md) for the runtime representation,
CRDT and agent edit flows, persistence model, and the reason agent edits use a
block-operation DSL.

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

The hosted service uses ordinary PostgreSQL. Start the development database and
apply its migrations with:

```bash
bun run db:up
STORAGE_DRIVER=postgres \
  DATABASE_URL=postgresql://chopin:chopin@127.0.0.1:5432/chopin?sslmode=disable \
  bun run migrate
```

`bun run db:down` stops it without removing its named volume. The current `/r/*`
prototype remains on `DATA_DIR` while its room sink is moved onto the storage
adapter; selecting PostgreSQL now proves the schema, health check and singleton
writer lease before the server accepts traffic.

Hosted sign-in also needs a GitHub OAuth App whose callback is
`<APP_ORIGIN>/auth/github/callback`. Generate its session key with
`openssl rand -hex 32`; the complete flow and credential boundary are described
in [Hosted authentication](docs/authentication.md). Repository authorization,
viewer/editor roles and the channel shell are described in
[Repository channels](docs/channels.md).

```bash
bun test          # 500 tests, no browser
bun run test:postgres # storage contract against the Docker database
bun run e2e       # 40 tests in Chromium, against the built client
bun run types     # every package, and e2e
bun run ci        # dprint + oxlint
bun run build     # production client
bun run start     # serve the built client
```

Neither suite spawns an agent; both set `AGENT=off`.

The browser suite needs Chromium once — `bun run e2e:browsers` — and builds the
client each run, so it is the slower of the two by some distance. It starts its
own servers on 8788 and 8789 and gives every test a room of its own, so it does
not mind you having `bun run dev` open at the same time.

If you are going to change the code, `agents.md` is the companion to this
file: how a room works, which decisions were deliberate, and the several
ways this stack fails without saying anything.

## Origins

The dialect, the editor and the questionnaire model began as a port of Ace's
plan feature, restructured to stand alone: no sandbox, no VM, one server, rooms
in memory. What changed, and why, is in the commit history.
