# Repository channels

A channel is Chopin's durable collaborative workspace for one GitHub
repository. Its metadata is stored locally; GitHub remains the current source of
identity, installation access, and repository roles.

## Authorization

Every caller first passes the optional instance admission policy. Repository
authorization then depends on the surface:

| Surface                    | Credential                                 | Repository boundary                                                                                            |
| -------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Browser HTTP and WebSocket | Process-local GitHub App user session      | The repository must be in an App installation available to the user.                                           |
| Hosted Planner             | The owning browser user's GitHub App token | The installation, ownership generation, session, credential revision, and role are rechecked before tools run. |
| Local MCP                  | Caller-supplied GitHub bearer              | GitHub is queried directly; no App installation is required.                                                   |

Pull access may list and open channels. Push or administration access may create
a channel, edit its plan, change decisions, invoke the Planner, and mutate an
implementation lifecycle. A public repository is not sufficient to expose its
channels through the browser.

An MCP-created channel outside the App installation remains unavailable to
browser routes, WebSockets, and the hosted Planner until an account owner adds
that repository to the installation.

## HTTP catalog

```text
GET  /api/repositories/:owner/:repository/channels
POST /api/repositories/:owner/:repository/channels
GET  /api/channels/:channelId
POST /api/channels/:channelId/agent/reset
```

The listing route accepts a case-insensitive `query`, an opaque `cursor`, and a
`limit` from 1 through 100. The default limit is 50. Results sort by most recent
update, with channel ID as the stable tie-breaker. A cursor is bound to its
original query and cannot be reused with another search.

A title is optional during browser creation. Chopin generates one when omitted,
or accepts a trimmed title from 1 through 120 characters. Titles are unique per
repository without regard to case.

The reset endpoint releases Planner ownership and aborts its disposable runtime
session. The current web application does not expose a control that calls it.

## Channel identity

New channel IDs are lowercase, UUIDv5-shaped values derived with SHA-256. The
server also accepts existing UUIDv4 IDs.

- Browser creation hashes the repository node ID with a fresh random UUID, so
  each request creates a new channel identity.
- MCP creation hashes the repository node ID with the caller's idempotency key,
  so a retried creation resolves to the same identity.

The stored GitHub repository node ID is authoritative. Owner and repository
name are retained so GitHub can resolve the repository, but they are never
trusted as a replacement for the node ID. This prevents a transferred or
recreated repository name from inheriting another repository's channels.

## Creation paths

Browser and MCP creation intentionally initialize storage differently.

Browser creation writes channel metadata first. It has no document checkpoint
until the first `plan:open`, which lazily creates and persists the empty plan.
An unopened browser-created channel can therefore have metadata and no snapshot.

MCP `create_document` validates the supplied brief, repository provenance, and
canonical plan before one creation transaction publishes channel metadata, a
revision-zero checkpoint, sidecar creation metadata, and the deterministic ID.
A repeated idempotency key either returns that same document or reports a
conflict when its original input differs.

## Browser routes

```text
/                                      repository picker
/repositories/:owner/:repository      channel list and creation
/channels/:channelId                   conversation plus Plan or Decisions view
```

The application first authorizes metadata over HTTP, then opens one WebSocket
for live channel traffic. Wide split mode shows Conversation beside either Plan
or Decisions; compact mode shows one destination at a time. Plan and Decisions
are alternatives rather than simultaneous document panes.

## WebSocket lifecycle

1. The HTTP upgrade validates the exact Origin, process-local session, instance
   admission, App installation, repository identity, and pull access.
2. `session:hello` establishes the socket's identity and edit capability.
3. The editor asks `plan:open` when the transport becomes available. Questions,
   comments, and conversation receive their own current snapshots.
4. The open request supplies the client's epoch and Yjs state vector so the
   server can return only missing state when histories are compatible.
5. Unacknowledged browser updates remain in an outbox and replay after a
   reconnect.
6. The server rechecks the session, admission, installation, and repository role
   while the socket remains open. A lost mutation role makes the connection
   read-only; lost read access closes it.
7. When a room becomes empty, the server removes its registry entry and starts
   an asynchronous final close and checkpoint. That close is not yet serialized
   against opening a replacement room for the same channel.

Opening is driven by connection state, not only editor mount. This is what makes
a late initial connection and a later reconnect both request missed state and
replay the outbox.

## Durable channel state

A channel persists:

- metadata and repository identity;
- canonical MDX, a complete Yjs checkpoint, and the accepted update journal
  after that checkpoint;
- plan counters and a versioned sidecar;
- question definitions, shared draft CRDTs, answers, and relationships;
- comment threads, passages, decisions, and result relationships;
- durable transcript and reserved hosted Planner context fields;
- MCP creation metadata and repository provenance when created through MCP;
- implementation graph versions, active execution, task progress,
  verification, and archived runs; and
- token-free Planner ownership references and generation state.

A client document update is acknowledged only after its fenced durable commit.
Checkpointing removes Yjs journal entries through the checkpoint sequence; the
journal is a recovery tail, not permanent edit history.

See [Architecture](architecture.md) for document synchronization,
[Storage](storage.md) for tables and recovery, and
[Experimental implementation lifecycle](implementation-lifecycle.md) for graph
lock behavior.
