# Storage and persistence

Chopin's durable boundary is `StorageAdapter` in
`apps/server/src/storage/port.ts`. Domain services depend on that port rather
than a database driver or query language. PostgreSQL is the only selectable
runtime adapter. `MemoryStorage` exists for unit and contract tests and is not a
runtime `STORAGE_DRIVER`.

## State model

The database stores channel metadata, repository-scoped document slug aliases,
collaboration recovery state, domain sidecars, token-free ownership references,
and the writer lease. GitHub tokens, browser-cookie verifiers, open rooms,
Awareness presence, and Copilot SDK sessions never cross the storage boundary.

The versioned sidecar is the atomic domain snapshot associated with a channel.
It includes document sequence and plan revision counters, question and comment
records, shared drafts, transcript, relationships, creation metadata,
implementation graphs, active execution, and lifecycle history. Restoration
validates the sidecar version and selected shapes before exposing a room, but it
does not deeply validate every nested question, passage, note, or
transcript-author field.
Compatibility conversion is limited to explicitly supported former fields. An
invalid optional implementation graph is dropped instead of rejecting the
sidecar.

## Adapter guarantees

Every adapter must provide:

- atomic, revision-checked channel commits;
- idempotent operation IDs;
- ordered binary update and event replay;
- monotonic storage sequences across checkpoints;
- atomic checkpoint and epoch replacement;
- atomic first-Planner ownership with a generation token;
- repository-scoped canonical and historical slug resolution without rebinding
  aliases;
- expiring, token-free process-session registry rows;
- startup removal of every registry row and Planner owner reference;
- renewable leases whose fencing token protects commits, epoch replacements,
  and checkpoints; and
- distinct conflict, missing, corrupt, and unavailable failures.

`collaboration.commit` can append a Yjs update, replace sidecar state, append
events, or combine them in one transaction. Transcript, draft, relationship,
graph, and lifecycle changes use the same commit even when the document itself
does not change. Splitting those writes could restore a document and decision
state that no connected client was ever shown.

## Counters

The adapter's `revision` and `sequence` are storage counters, not the plan
revision used by document block operations or the WebSocket document sequence.

- The channel storage revision advances for every accepted durable commit.
- The storage sequence orders commits that may carry updates or events.
- Sidecar-only commits consume a sequence without adding a Yjs journal row, so
  gaps in `channel_updates.sequence` are expected.
- A checkpoint records the storage revision and `through_sequence` it covers.
- The Yjs epoch is retained separately so incompatible collaborative histories
  cannot be combined.

See the counter glossary in [Architecture](architecture.md) before changing
recovery or acknowledgement behavior.

## PostgreSQL schema

The migration runner owns `chopin_migrations`, including a checksum for each
applied migration. The application schema contains:

| Table                      | Purpose                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `users`                    | GitHub identity and attribution records.                                                                         |
| `web_sessions`             | Token-free process-session IDs, user IDs, and expiry timestamps used by Planner ownership.                       |
| `channels`                 | Repository identity, title, creator, storage revision, next sequence, and timestamps.                            |
| `channel_slugs`            | One canonical title-derived slug per channel plus permanent repository-scoped historical aliases.                |
| `channel_state`            | Current sidecar JSON for a channel.                                                                              |
| `channel_snapshots`        | Complete Yjs checkpoint, canonical source, source hash, epoch, counters, and checkpoint sidecar.                 |
| `channel_operations`       | Per-channel operation idempotency and the revision and sequence assigned to each operation.                      |
| `channel_updates`          | Ordered post-checkpoint Yjs update journal.                                                                      |
| `channel_events`           | Ordered event capability in the adapter contract. Current collaboration commits do not use it for domain replay. |
| `agent_state`              | Reserved Planner summary and transcript cursor, status, owner session reference, and ownership generation.       |
| `storage_leases`           | Renewable named leases and fencing tokens.                                                                       |
| `background_job_channels`  | Job-state revision per channel, independent of collaboration counters.                                           |
| `background_job_targets`   | Current generation for each registered channel job target.                                                       |
| `background_jobs`          | Versioned requests, lifecycle, attempts, fenced claims, bounded inputs, and sanitized failures.                  |
| `background_job_artifacts` | Immutable validated results committed atomically with job completion.                                            |

Channel titles have a case-insensitive unique constraint within each repository.
Slug values are also unique per repository, with one canonical slug per channel.
A rename promotes a new collision-suffixed slug but retains all former slugs as
aliases that cannot be assigned to another channel. Foreign keys remove slug
aliases and dependent collaboration state when a channel is deleted, although
the current product has no channel-deletion route.

## Commit and acknowledgement

For a browser update, the plan service batches and validates the document before
calling the adapter. PostgreSQL locks the channel row, verifies the expected
storage revision and writer fencing token, checks operation idempotency, assigns
the next revision and sequence, and writes the update and sidecar atomically.
Only then does the service acknowledge or broadcast the mutation.

Server-authored document edits, decisions, transcript entries, implementation graph
changes, and lifecycle reports follow the same persistence-before-publication
rule.

## Checkpoints and retention

A checkpoint contains canonical MDX, its source hash, complete Yjs bytes, the
epoch, generation, covered sequence, storage revision, and a sidecar copy.
Saving it atomically replaces the prior checkpoint and deletes
`channel_updates` entries through its covered sequence.

Checkpointing does not prune `channel_operations` or `channel_events`. The
current schema therefore retains operation idempotency records and any stored
events until a separate retention policy or channel deletion removes them.
Operators should account for that behavior in database monitoring and backups.

The database is a recovery store, not a user-visible edit history. Canonical MDX
and current domain records are durable, but the compacted Yjs journal is not an
audit log of every keystroke.

## Recovery

PostgreSQL recovery reads channel metadata, sidecar, checkpoint, journal,
events, and Planner state from one repeatable-read snapshot. The room then:

1. validates the sidecar and checkpoint metadata;
2. loads the complete Yjs document and verifies that it projects to the stored
   canonical MDX and source hash;
3. replays ordered journal updates from the same epoch;
4. projects and validates the resulting current document; and
5. recovers broken anchors conservatively before returning the open snapshot.

A browser-created channel may have metadata but no snapshot until its first
`plan:open`. MCP creation publishes its initial checkpoint atomically with the
metadata.

## Planner ownership and sessions

PostgreSQL stores only the process-session ID, user ID, expiry, and timestamps.
The serving process alone holds the cookie verifier and GitHub credentials.
`agent_state.owner_session_id` can therefore refer to a current process session
without making the database row an authentication credential.

After acquiring the writer lease, every application start deletes all
`web_sessions` rows and clears Planner owner references. Reserved summary and
transcript cursor fields and the generation remain unchanged; the current
runtime does not advance the summary or cursor, and startup forces status to
`unavailable`. A later owner creates a fresh Copilot SDK session from bounded
transcript context and the current document.

Active external implementation runs are different: their graph lock, run
identity, progress, and history remain durable across application restart.

## Writer lease

One database-wide `chopin:writer` lease permits one active application process.
A second process refuses startup. The holder renews the lease while serving and
drains and stops if renewal fails or its safety deadline passes. Adapter fencing
prevents an expired holder from committing even before shutdown completes.

This lease is why the current deployment model cannot perform a rolling
application replacement against one database. See
[Self-hosting](self-hosting.md) for upgrade and backup guidance.

## Migrations

Migrations live with the PostgreSQL adapter and run in order. Each filename and
content checksum is recorded in `chopin_migrations`; changing an applied file is
treated as corruption rather than a new migration.

Run migrations from source with:

```bash
bun run migrate
```

The Docker image's default command applies migrations before starting. Replacing
that command also bypasses automatic migration. Migration configuration
currently loads the complete application configuration, so all required GitHub
and OAuth variables must be present even for a standalone migration job.

## Adding an adapter

1. Implement every store in `StorageAdapter` under
   `apps/server/src/storage/<driver>`.
2. Own the provider's schema and migrations in that directory.
3. Add configuration parsing and one registry entry.
4. Run `apps/server/src/storage/contract.ts` against the real provider.
5. Add that provider's contract and lifecycle run to CI.

Adapters are compiled into Chopin. Runtime loading of arbitrary storage packages
is not supported.

The PostgreSQL contract and process-lifecycle tests run with:

```bash
bun run test:postgres
```
