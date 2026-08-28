# Repository channels

A channel is Chopin's internal durable collaboration container for one document, its Chat,
decisions, and one GitHub repository. Its metadata is stored
locally; GitHub remains the current source of identity, installation access, and
repository roles.

## Authorization

Every caller first passes the optional instance admission policy. Repository
authorization then depends on the surface:

| Surface                    | Credential                                 | Repository boundary                                                                                            |
| -------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Browser HTTP and WebSocket | Process-local GitHub App user session      | The repository must be in an App installation available to the user.                                           |
| Hosted agent (Planner)     | The owning browser user's GitHub App token | The installation, ownership generation, session, credential revision, and role are rechecked before tools run. |
| Local MCP                  | Caller-supplied GitHub bearer              | GitHub is queried directly; no App installation is required.                                                   |

Pull access may list and open active or archived documents. Push or
administration access may create, edit, rename, archive, restore, and delete
documents and mutate an implementation lifecycle. Deletion additionally
requires the document to be archived. The same roles apply to research requests:
pull may read a referenced request, while push or administration may start,
cancel, or retry one on an active document. The browser only offers the start
action on a top-level document. The API may accept a request on a child, but
publication validation rejects linking a grandchild. A public repository is not
sufficient to expose its documents through the browser.

An MCP-created document outside the App installation remains unavailable to
browser routes, WebSockets, and the hosted agent until an account owner adds
that repository to the installation.

## HTTP catalog

```text
GET  /api/repositories/:owner/:repository/channels
POST /api/repositories/:owner/:repository/channels
GET  /api/repositories/:owner/:repository/documents/:slug
GET  /api/channels/:channelId
PATCH /api/channels/:channelId
POST /api/channels/:channelId/archive
POST /api/channels/:channelId/restore
DELETE /api/channels/:channelId
POST /api/channels/:channelId/agent/reset
POST /api/channels/:channelId/research-workspaces
GET  /api/channels/:channelId/research-workspaces/:workspaceId
POST /api/channels/:channelId/research-workspaces/:workspaceId/cancel
POST /api/channels/:channelId/research-workspaces/:workspaceId/retry
```

The `channels`, `research-workspaces`, and UUID paths are internal API names
retained by the current implementation. A research create accepts the exact
`question` and a client request ID, persists one initial request, and starts it
immediately. Detail returns the supported card projection: immutable question,
state, stage, safe error, sources, and optional published child metadata. Cancel
and retry require an exact browser Origin and write access. Retry keeps the
request identity and question; it does not accept replacement prose.

Older repository-list, draft-confirmation, append-turn, and transcript methods
remain in server and storage compatibility code, but the current browser does
not use them as product routes. The repository-scoped `documents/:slug` route
resolves both the current document slug and its historical aliases. Browser
creation returns the readable canonical document route in `Location`, not a
UUID route.

The listing route accepts a case-insensitive `query`, an opaque `cursor`, a
`limit` from 1 through 100, and `includeArchived=true`. The query matches title
or the current generated description. The default limit is 50, and archived
documents are excluded by default. Results include `descriptionRevision` and an
optional `description`, then sort by most recent channel update with channel ID
as the stable tie-breaker. Description projection does not change `updatedAt`,
so it does not alter list recency. A cursor is bound to its original query and
archive-inclusion mode and cannot be reused with another search.

A title is optional during browser creation. Chopin generates one when omitted,
or accepts a trimmed title from 1 through 120 characters. Titles are unique per
repository without regard to case.

`PATCH /api/channels/:channelId` accepts `{ "title": "..." }`. It updates the
document title and canonical slug, but not the canonical MDX heading, UUID
identity, or plan revision. A changed title updates the channel activity time
and is broadcast to clients in the open room; submitting the current title is a
no-op.

Slugs are derived from Unicode-normalized, lowercased titles. Unicode letters,
numbers, and combining marks remain readable while punctuation and spacing
collapse to hyphens. Slugs are scoped to a repository and receive numbered
suffixes such as `-2` when they collide. Every former canonical slug remains a
historical alias for the document's lifetime and cannot be rebound while it
exists, so a rename changes the canonical route without breaking an old link.

## Archive, restore, and delete

Archive and restore are idempotent metadata transitions. An archived channel
has an `archivedAt` timestamp; restore removes it. Both transitions update the
channel activity timestamp without advancing the collaboration revision or
sequence, Yjs epoch, document sequence, plan revision, or implementation graph
counters.

Repository lists, searches, and storage scans consider only active documents by
default; their explicit `includeArchived` option includes archived documents.
Browser landing selection and saved navigation remain active-only. Direct slug
and UUID reads still resolve an archived document, including historical slug
aliases.

An archived browser session is read-only, including for a repository writer,
but retains `canManage` for writers so they can restore or delete the document.
Archival blocks metadata and document edits, chat, question and comment
mutations, new Planner and research-request work, and
`start_implementation`. An already active implementation may still accept
lifecycle reports, and already-started background or research work may continue
and persist. Archiving also ends the current Planner runtime; restoring does not
replay an interrupted turn.

The browser management routes are `POST /api/channels/:channelId/archive`,
`POST /api/channels/:channelId/restore`, and `DELETE /api/channels/:channelId`.
They require push or administration access and an exact browser Origin. Delete
returns a conflict unless the document is archived. Before deletion, the server
suspends description scheduling, cancels and aborts the channel's background
work, and closes the live plan. It then atomically deletes the channel and all
dependent data, notifies connected clients with `session:deleted`, and closes
them terminally. See [Storage](storage.md) for the deletion and backup boundary.

MCP exposes `archive_document` and `restore_document`, and `list_documents`
accepts `includeArchived`; direct MCP reads also remain available. These and
other common MCP document summaries expose the optional description. MCP does
not expose document deletion. See [Local agent MCP](local-agent-mcp.md).

The reset endpoint releases Planner ownership and aborts its disposable runtime
session. The current web application does not expose a control that calls it.

## Document URL and channel identity

New channel IDs are lowercase, UUIDv5-shaped values derived with SHA-256. The
server also accepts existing UUIDv4 IDs.

- Browser creation hashes the repository node ID with a fresh random UUID, so
  each request creates a new channel identity.
- MCP creation hashes the repository node ID with the caller's idempotency key,
  so a retried creation resolves to the same identity.
- Research publication hashes the repository node ID with the stable request
  identity, so repeated reconciliation resolves to the same child identity.

The stored GitHub repository node ID is authoritative. Owner and repository
name are retained so GitHub can resolve the repository, but they are never
trusted as a replacement for the node ID. This prevents a transferred or
recreated repository name from inheriting another repository's channels.

The UUID is the stable internal identity used by storage, UUID API routes,
WebSocket rooms, and MCP lifecycle calls. Public browser locations use the
repository and slug instead:

```text
/documents/:owner/:repository/:slug
/documents/:owner/:repository/:parentSlug/children/:childSlug
```

Renaming a document promotes its new title-derived slug as canonical while
retaining the same UUID and plan revision. Browser `Location` headers and the MCP
`create_document` result expose the readable route rather than
`/channels/:channelId`.

## Creation paths

Browser, MCP, and research-child creation initialize storage differently.

Browser creation writes channel metadata first. It has no document checkpoint
until the first `plan:open`, which lazily creates and persists the empty
document. An unopened browser-created channel can therefore have metadata and no
snapshot.

MCP `create_document` validates the supplied brief, repository provenance, and
canonical document source supplied through its current `plan` field before one
creation transaction publishes channel metadata, a revision-zero checkpoint,
sidecar creation metadata, and the deterministic ID. A repeated idempotency key
either returns that same document or reports a conflict when its original input
differs.

## Generated descriptions

The optional channel description is generated catalogue metadata, not authored
document content. New requests use the existing durable `document-summary@1`
definition with `output:"description"`; no `@2` exists. Completed marked
artifacts project idempotently with source plan revision and hash, generator
version, source job ID, projection timestamp, and an independent description
revision. Markerless legacy V1 summaries remain readable as job artifacts but do
not populate the catalogue.

The latest completed description stays visible and searchable while newer work
is pending or failed. Projection does not advance collaboration revision or
channel `updatedAt`. Descriptions are untrusted model output; the MCP creation
`brief` and reserved Planner transcript `summary` remain separate.

Canonical edits schedule generation after persistence. Opening and restoring a
document ensure a request for the current source, and MCP creation or replay
schedules immediately. These paths lazily regenerate an unchanged document that
has only a legacy summary because the new idempotency key is
`description-v1:<plan revision>:<source hash>`. Workers require an active Planner
owner, so there is no unattended all-document backfill.

A research child has no channel while work is pending. Once the complete report
validates, one transaction creates the child metadata and revision-zero
checkpoint, records `parentChannelId`, and links `publishedChannelId` on the
request. The child must share the parent's repository, and a child cannot parent
another child. Failed, cancelled, or partially reconciled work does not create a
visible document.

## Browser routes

```text
/documents/:owner/:repository         document list and creation
/documents/:owner/:repository/:slug   Chat plus Plan or Decisions view
/documents/:owner/:repository/:parentSlug/children/:childSlug
                                       anchored ordinary child document
/                                     repository picker
```

Pending research requests remain inline and do not appear in navigation. After
publication, the ordinary child channel appears beneath its parent. Selecting it
keeps the mounted parent as receded context and opens the child through its own
WebSocket, document state, Chat, and Decisions. Direct entry resolves
both slugs and verifies the repository and stored parent relationship. Browser
Back, Escape, and the child close control return to the parent and restore its
scroll, selection, and opener focus.

Project lists, the repository document picker, cross-project document search,
and Chat document-reference pickers show generated descriptions when
present. Search uses the server's title-or-description matching rather than
filtering only the currently loaded page.

Historical slug URLs continue to open the document. The legacy
`/repositories/:owner/:repository` and `/channels/:channelId` browser routes are
also accepted. After resolving any historical or legacy link, the browser
replaces its address with the current canonical `/documents/...` route while
preserving the query and fragment.

The application first authorizes metadata over HTTP, then opens one WebSocket
for live channel traffic. Wide split mode shows Chat beside either Plan,
the current label for the document-content view, or Decisions. Compact mode
shows one destination at a time. Plan and Decisions are alternatives rather
than simultaneous document panes.

## WebSocket lifecycle

1. The HTTP upgrade validates the exact Origin, process-local session, instance
   admission, App installation, repository identity, and pull access.
2. `session:hello` establishes the socket's identity and edit capability.
3. The editor asks `plan:open` when the transport becomes available. Questions,
   comments, and Chat receive their own current snapshots.
4. The open request supplies the client's epoch and Yjs state vector so the
   server can return only missing state when histories are compatible.
5. Unacknowledged browser updates remain in an outbox and replay after a
   reconnect.
6. The server rechecks the session, admission, installation, repository role,
   and archive state while the socket remains open. A lost mutation role or
   archival makes the connection read-only; lost read access closes it.
7. When a room becomes empty, the server removes its registry entry and starts
   an asynchronous final close and checkpoint. That close is not yet serialized
   against opening a replacement room for the same channel.

Opening is driven by connection state, not only editor mount. This is what makes
a late initial connection and a later reconnect both request missed state and
replay the outbox.

## Durable channel state

A channel persists:

- metadata and repository identity;
- archive metadata;
- generated description metadata with source and background-job provenance;
- canonical MDX, a complete Yjs checkpoint, and the accepted update journal
  after that checkpoint;
- document sequence and plan revision counters plus a versioned sidecar;
- question definitions, shared draft CRDTs, answers, and relationships;
- comment threads, passages, decisions, and result relationships;
- durable transcript and reserved hosted agent context fields;
- MCP creation metadata and repository provenance when created through MCP;
- implementation graph versions, active execution, task progress,
  verification, and archived runs;
- token-free Planner ownership references and generation state; and
- parent-scoped research request staging, immutable job-artifact links, and the
  optional published child identity.

A client document update is acknowledged only after its fenced durable commit.
Checkpointing removes Yjs journal entries through the checkpoint sequence; the
journal is a recovery tail, not permanent edit history.

See [Architecture](architecture.md) for document synchronization,
[Storage](storage.md) for tables and recovery, and
[Experimental implementation lifecycle](implementation-lifecycle.md) for graph
lock behavior.
