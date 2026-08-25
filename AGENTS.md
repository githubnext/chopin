# Working on Chopin

Chopin is an experimental collaborative authoring system: several people and a
hosted agent share one rich, repository-connected document. Plans are one
document workflow, not the product boundary. Read
[README.md](README.md) for the product framing and [Architecture](docs/architecture.md)
before changing cross-package behavior.

The most useful technical references are:

- [Authentication and authorization](docs/authentication.md)
- [Repository channels](docs/channels.md)
- [Storage and persistence](docs/storage.md)
- [Hosted agent (Planner)](docs/hosted-agent.md)
- [Background jobs and workers](docs/background-jobs.md)
- [Experimental implementation lifecycle](docs/implementation-lifecycle.md)
- [Self-hosting](docs/self-hosting.md)

## Commands

```bash
bun install             # install the workspace
bun run dev             # Vite and Bun development supervisor
bun run dev:exe         # exe.dev proxy and HMR mode
bun run db:up           # start the local PostgreSQL service
bun run db:down         # tear down the local Compose project
bun run migrate         # apply PostgreSQL migrations
bun test                # unit, domain, and memory-adapter tests
bun run test:postgres   # PostgreSQL contract and lifecycle tests
bun run e2e             # Chromium system integration suite
bun run e2e:ui          # Playwright UI mode
bun run e2e:browsers    # install Chromium once
bun run types           # TypeScript checks across packages and E2E
bun run ci              # dprint, oxlint, and token checks
bun run fix             # format and apply safe lint fixes
bun run build           # build the web client
bun run start           # start the server; build and migrate first
bun run docker:up       # build and start app plus PostgreSQL locally
bun run docker:down     # tear down the local Compose project
```

The repository pins Bun 1.3.2. Keep the package metadata, Docker image, CI, and
documentation synchronized when changing it.

`bun run e2e` starts two disposable PostgreSQL services, migrates them, builds
the client, starts applications on ports 8788 and 8789, and runs Chromium with
`AGENT=off`. Set `E2E_SKIP_BUILD=1` only when the existing client build is known
to match the checkout.

CI has three independent jobs: validation, browser integration, and a Docker
image build. A documentation-only change should still pass `bun run ci`.

## Repository map

| Area                | Responsibility                                         | Internal workspace dependencies               |
| ------------------- | ------------------------------------------------------ | --------------------------------------------- |
| `packages/dialect`  | Restricted MDX, MDAST, and Lexical schema              | none                                          |
| `packages/protocol` | WebSocket declarations and addressing helper           | none                                          |
| `packages/question` | Questionnaire definitions and shared drafts            | `protocol`                                    |
| `packages/viewport` | Browser geometry and subscriptions                     | none                                          |
| `packages/editor`   | Collaborative editor, decisions, comments, and widgets | `dialect`, `question`, `protocol`, `viewport` |
| `apps/server`       | Auth, channels, rooms, storage, Planner, MCP, tasks    | `dialect`, `question`, `protocol`             |
| `apps/web`          | Repository picker, navigation, conversation, workspace | `dialect`, `editor`, `protocol`, `viewport`   |
| `e2e`               | Browser and system integration harness                 | may import server internals as fixtures       |

Runtime workspace packages do not depend on an application. E2E and skill
contract tests may deliberately import server internals; do not treat those test
harnesses as runtime package boundaries.

## Runtime model

The browser edits Lexical bound to Yjs. One WebSocket multiplexes session,
document (`plan:*` on the wire), conversation, questions, comments, and
implementation lifecycle messages. The server keeps each open channel as an
authoritative Y.Doc with a headless Lexical mirror so it can validate and
serialize the document without trusting a browser.

Human updates are grouped for 5 ms, applied, projected to canonical MDX,
validated, and committed with sidecar state before acknowledgement or relay. An
invalid Yjs batch cannot be undone; the room rebuilds the latest known-good
state under a fresh epoch and clients reopen.

The Planner reads a plan revision and edits through structural block operations.
Operations stage against MDAST, pass dialect and Lexical round-trip validation,
reconcile into the live tree, and produce one Yjs delta. Unchanged or moved
MDAST object identity preserves existing Lexical nodes, selections, and undo
history.

PostgreSQL is the only runtime storage adapter. One renewable `chopin:writer`
lease permits one application process per database. Process-local browser
sessions and GitHub credentials are cleared on startup; collaborative state and
external implementation runs are durable.

## Authority and security

- **The dialect is an allowlist.** Document MDX is parsed and rendered, never
  evaluated. Keep imports, exports, expressions, raw HTML, and unknown JSX out.
- **Records own decisions.** Question answers and accepted comment decisions live
  in sidecar records. Their document components are projections. Planner
  operations protect those projections, but browser CRDT validation does not
  yet cross-check them against records; do not treat the projection as authority.
- **Admission is not authorization.** Optional user and organization lists admit
  an identity. Browser routes, sockets, and Planner tools separately recheck the
  App installation and repository role.
- **MCP has a different credential boundary.** `/mcp` checks its caller-supplied
  GitHub bearer directly, does not require the App installation, and can mutate
  data for callers with push or administration access.
- **Planner ownership is process-bound.** The first eligible Planner or
  model-backed research request supplies its GitHub App token and Copilot
  entitlement. The database stores only a token-free owner reference and durable
  context.
- **Planner tools are repository-fixed.** The hosted runtime has no shell,
  checkout, host filesystem, skills, plugins, or arbitrary GitHub access.
- **Repository node IDs are authoritative.** Owner and repository names resolve
  GitHub requests but never replace the stored node identity.
- **Persistence should precede publication.** Do not acknowledge or broadcast a
  domain mutation before its fenced durable commit. `anchor_plan` currently has
  a known ordering race described below; do not copy that pattern.

## Conversation and Planner addressing

The web composer uses `packages/protocol/address.ts` to translate `@chopin` into
`Chat.Send.to = "planner"`; ordinary messages use `to = "room"`. The wire
destination is authoritative on the server. Do not describe `@chopin` as a server
authorization boundary: a custom write-authorized client can send an explicit
Planner destination without a mention.

`instruction()` strips the mention before model input. Recent room messages that
did not address the Planner still enter a bounded backscroll for the next turn.
An accepted comment also starts an explicit Planner turn after it commits.

The Planner is a custom agent, not a general coding agent. `session.send()` only
accepts a message; the conversation stays active until the SDK emits idle. An
interrupted turn is never replayed automatically because it may already have
made durable tool changes.

## Questions, comments, and anchors

Question submission currently claims the shared draft with `claimSubmit()`,
projects the answer and authoritative record inside the room lock, calls
`Store.stage()`, persists the document or sidecar, and invokes the returned
finalizer. `stage()` removes the open draft before persistence, and the failure
path does not restore it after a storage error. Treat this as a known durability
gap: a proper two-phase refactor must retain or restore the draft until the
fenced commit succeeds.

Anchors combine Yjs relative positions with canonical block digests. A position
survives surrounding edits; a digest can recover one unique block after a move
or epoch replacement. Ambiguous matches must orphan rather than guess. The safe
ordering is to rebase against the old document before a server-authored edit;
the current Planner path reconciles first and is a known recovery gap.

The browser starts a comment from a bounded quote locator, selected length,
offset hint, and block indices, not an unbounded copy of selected text. The
server resolves the locator and mints relative positions. It handles stale or
ambiguous passages conservatively, but does not yet enforce every client-side
size and ordering bound on custom wire input.

Question and comment relationships have four deliberate states: pending,
linked, deliberately empty, and orphaned. Preserve the distinction. Empty means
the Planner reviewed the decision and intentionally linked no prose; orphaned
means a former target can no longer be identified safely.

## Research requests and child documents

Typing `/research` starts one parent-scoped durable request from the exact brief.
A pending request is an inline card, not a channel: it has no URL, sidebar row,
Conversation, or Decisions. Failure, cancellation, and explicit retry preserve
the request identity; observational reads must not restart terminal work.

Successful reconciliation validates the complete report and atomically creates
an initialized ordinary child channel plus the request link. Publication must be
idempotent and persistence must precede the ready card or nested navigation row.
A child owns ordinary document, Conversation, and Decisions state. V1 does not
offer child research, Background Work, implementation/tasks, or grandchildren.

The server retains `research_workspaces`, turns, messages, and historical chat
references as staging and compatibility internals. Do not present them as a
standalone report, thread, navigation child, or confirmation flow.

## Implementation graphs

The hosted Planner's graph tools remain technically available in any channel
after plan readiness checks pass. That does not make child implementation a
supported product workflow: the child surface exposes no tasks or implementation
destination. The supported MCP read path exposes a graph only for an MCP-created
document. The Planner cannot approve, lock, or start a graph. Approval exists in
the domain but has no current production UI or route; the workflow is
experimental.

An approved graph binds one plan revision, graph version, and graph revision.
`start_implementation` atomically claims those values and locks the graph. Task,
pull-request, blocker, revision, and verification transitions persist before
publication. Active implementation prevents plan and decision mutations that
would invalidate the claim.

The run claim is logical, not authorization-bound to the original coding agent.
Any admitted repository writer who knows the run ID can submit lifecycle
transitions. Do not describe the claimant as an exclusive security principal.

Keep graph counters separate from Yjs epoch, document sequence, plan revision,
and storage revision. See [Experimental implementation lifecycle](docs/implementation-lifecycle.md).

## Editor invariants

### Tables

- The first row is always the header row. A table has no independent header flag.
- Import normalizes merged cells into the rectangular subset supported by the
  editor. Export remains valid even if Lexical temporarily exposes a span.
- Tables are limited to 100 rows and 20 columns in the shared dialect.
- Empty paragraphs in cells render as the visible placeholder, so a new cell is
  immediately editable.
- Row and column rails use viewport-fixed overlays outside the editor's clipped
  container. Keep the overlay tree pointer-transparent except for controls.
- A move through a merged span may normalize to the original rectangle and is a
  valid no-op, not a failed operation.

### Code and diff blocks

- Syntax and diff previews are derived React views beside Lexical's canonical
  code node. Do not mount a second editor or write highlighted DOM into Lexical.
- An unnamed fence is plain text. Never guess a language from content.
- Invalid `patch` content temporarily falls back to plain code rendering without
  changing the stored language. Repairing the text restores the diff view.
- The preview is non-editable derived UI. The current Enter handler requires a
  Lexical range selection inside the canonical code block; do not assume a key
  event focused only on the preview will return to the source.

### Change marks and presence

- Planner changes broadcast only after the Yjs update that created their target
  nodes.
- Added and moved marks attach to live block elements. Removed marks use a gap
  between surviving blocks; no empty tombstone node is inserted into the
  document.
- A Planner cursor and a change mark are separate. The cursor points after the
  final changed block even if that block is outside the current viewport.
- Change marks are broadcast decoration, not durable server history. A client
  retains at most 50 unseen marks until they enter the viewport, the editor is
  cleared, or the epoch changes.
- Refresh Awareness with `setLocalState`, not only a field mutation, when the
  visible user profile changes after connection.

### Related prose

Hover highlights every related block. Click scrolls to the first related block
and pins the set briefly. Only one pin may exist, and clearing a pin must remove
the exact highlight object that created it. CSS Highlights are shared by name,
so merge ranges from all mounted editors before replacing a registry entry.

## Failure traps

### Collaboration

- A Lexical node present in the dialect but missing from server collaboration
  registration can throw inside a Lexical listener and silently stop sync.
  Current `registry.test.ts` coverage is narrower than an all-node headless
  Lexical/Yjs round trip; add that regression coverage when extending the
  registry.
- Lexical may report listener failures without throwing from the transaction.
  Capture editor errors explicitly when correctness depends on detecting them.
- Open the document on provider connection, not only editor mount. Otherwise a
  late initial socket connection never requests state.
- A draft edit must not leave the queue until its acknowledgement. Dropping it
  after `send()` loses edits on disconnect.
- Rebuilds and reconnects must replay unacknowledged updates only when the epoch
  is still compatible.
- Idle eviction removes a room registry entry before its asynchronous close and
  checkpoint completes. Until that lifecycle is serialized, avoid opening a
  replacement room during close and test revision conflicts around eviction.
- Sidecar restoration currently drops an invalid optional implementation graph
  instead of rejecting the whole sidecar. Do not generalize that fail-open
  behavior to other durable fields.

### Planner

- SDK events carry protocol data under `event.data`; do not read guessed
  top-level fields.
- An agent-level `tools` list filters MCP tools too. Keep the Planner's tool list
  unset and enforce the boundary through session `availableTools`.
- Permission-denied tools may produce no normal start or completion event. Render
  the refusal from the permission callback path.
- The external GitHub MCP server can change its offered tool count. Diagnose by
  required names and denied capabilities, not literal counts.
- `AGENT=off` prevents hosted agent turns but does not disable local MCP and
  does not currently remove every Planner label from the UI.
- A success callback for persisted sidecar work is not optional. Calling it
  after persistence prevents durable transcript state from being dropped.
- `anchor_plan` calls the asynchronous question-placement publish without
  awaiting it before separate sidecar persistence and anchor broadcast. Fix the
  serialization before relying on its ordering guarantee.

### Browser and editor

- Keep one React owner for derived code or diff previews. Mounting a second owner
  over the same node causes race-driven cleanup and remounting.
- Native `<select>` option values must remain globally unique, including the
  empty sentinel.
- Add both MDXEditor's selected-cell class and Lexical's selected-cell theme
  class when replacing table theme styles.
- Tailwind transform utilities can overwrite each other on fixed overlays. Use
  explicit transforms when two axes must compose.
- Geometry and scroll APIs are browser-owned behavior. Test them in Playwright,
  not a synthetic DOM.
- When route state changes rapidly, derive asynchronous results from stable
  request identity and ignore stale responses.

### Deployment and tests

- `compose.local.yaml` publishes application and PostgreSQL ports on all host
  interfaces. It is development-only; do not document it as a safe public
  deployment.
- Coolify preview variables that must remain late-bound use direct `${NAME}`
  references. A `${NAME:-default}` can be resolved from production before the
  preview environment is attached.
- The Docker image expects internal port 8787. Changing `PORT` alone breaks its
  health check and routing assumptions.
- Bun wrapper processes can outlive a failed child. The development and E2E
  supervisors kill process groups explicitly; production managers should run
  the server command directly and restart after any unexpected exit.
- Playwright reuses a server when its probe returns success. The E2E runner does
  not currently preflight application ports 8788 and 8789, so stop developer
  processes on those ports before running the suite.
- Accessible-name matching is substring-based by default. Use `exact: true` when
  controls share labels such as `Plan` and `Plan comment`.
- Mac Playwright uses `Meta` rather than `Control` for editor shortcuts.

## Testing strategy

Use the narrowest layer that exercises the behavior:

- **Unit and domain tests** cover parsing, serialization, graph transitions,
  permissions, documents, questions, comments, and pure editor logic.
- **Provider contract tests** run the shared storage suite against memory and
  real PostgreSQL, including process lifecycle and fencing.
- **Browser and system integration tests** cover OAuth/session flows, repository
  authorization, HTTP routes, WebSockets, persistence, reconnection, navigation,
  browser layout, selection geometry, scrolling, and visual editor interaction.

`bun test` has no DOM. Do not add `happy-dom` or `jsdom` to simulate layout,
selection, scroll, `IntersectionObserver`, CSS Highlights, or browser event
ordering. Extract pure state machines for unit coverage and use `*.e2e.ts` for
the browser adapter.

The E2E fake GitHub replaces GitHub's network responses only. OAuth state,
process-local sessions, admission, repository checks, channel routes,
WebSockets, storage, and the web application are production implementations.

Prefer role and accessible-name selectors. Avoid classes, generated Lexical
keys, and geometry-derived selectors unless geometry is the behavior under test.

## Coding conventions

- TypeScript uses tabs, double quotes, semicolons, and a 100-column target.
- Prefer `let` for local bindings, including values that are not reassigned.
- Keep changes in one function until a helper has a clear reusable boundary.
- Add comments only for non-obvious constraints or failure modes.
- Update protocol declarations before or with both client and server behavior.
- Keep storage mutations idempotent and persistence-before-publication.
- Do not add compatibility paths without a concrete persisted-data or external
  consumer requirement.
- Use current terminology: **Planner** for the hosted agent, **coding agent** for
  an external MCP client, **GitHub App for Chopin** for deployment identity, and
  **room** only for the live server representation.
- Use **document** for the authored product artifact. Use **plan** only for a
  planning-specific workflow, a literal UI label, or an implementation name such
  as `plan:*`, `read_plan`, and `planRevision`.

Run `bun run fix` after code edits and inspect its changes. For documentation,
run `bun run ci` and validate relative links with exact casing.

## Diagnostics

When a disposable Planner session is created, diagnostics report available tool
names and the external GitHub MCP contribution. Counts vary with SDK and remote
MCP versions. A healthy boundary includes Chopin's document tools (currently
plan-named), repository tools, and allowed pull-request tools, and excludes
ambient capabilities such as `bash`, filesystem access, URL fetch, host Git,
issues, and unrestricted search.

Treat a missing required tool or an unexpected ambient tool as a security or
configuration failure even when the overall count looks plausible.

## Environment-specific guides

- [exe.dev remote development](docs/exe-dev.md)
- [PR preview testing](docs/preview-testing.md)
- [Local coding-agent MCP](docs/local-agent-mcp.md)
