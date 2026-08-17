# Storage adapters

Chopin's durable boundary is `StorageAdapter` in
`apps/server/src/storage/port.ts`. Domain services depend on that port, never on
a database driver or query language. PostgreSQL is the reference implementation,
not part of the contract.

The port is deliberately made of domain operations rather than generic CRUD.
In particular, `collaboration.commit` atomically advances a revision and
sequence and records an idempotency key while optionally appending a Yjs update,
events, or replacement sidecar state. Sidecar-only transcript and relationship
commits use the same operation. Acknowledging those parts separately would let
a crash restore a state no client was shown, or lose one it was.

## Guarantees

Every built-in adapter must provide:

- atomic, revision-checked channel commits;
- idempotent operation ids;
- ordered binary update and event replay;
- monotonic sequences across checkpoints;
- atomic first-agent ownership with a generation token;
- expiring login sessions;
- compare-and-swap replacement and conditional deletion of encrypted login
  credentials;
- renewable leases whose fencing token is checked by collaboration commits,
  epoch replacements, and checkpoints;
- atomic checkpoint replacement; and
- distinct conflict, missing, corrupt and unavailable failures.

The application owns GitHub credential encryption, payload validation and Yjs
semantics. An adapter must return encrypted credential bundles, Yjs updates and
checkpoint byte arrays byte-for-byte, and versioned JSON with the same semantic
value.

## Adding an adapter

1. Implement every store in `StorageAdapter` under
   `apps/server/src/storage/<driver>`.
2. Own the provider's schema and migrations inside that directory.
3. Add its configuration and one entry to `storage/registry.ts`.
4. Run the shared suite from `storage/contract.ts` against the real provider.
5. Add that provider run to CI; an adapter that is only tested through mocks is
   not built in.

Adapters are compiled into Chopin. Loading arbitrary packages at runtime is not
supported.

## PostgreSQL

The only built-in adapter currently uses ordinary PostgreSQL and Bun's owned SQL
pool. It is the default and only accepted `STORAGE_DRIVER` value.
It uses row locks for revisions, repeatable-read recovery snapshots, database
time for leases, and checksums for migration history. Start the development
database with `bun run db:up`, migrate it with `bun run migrate`, and run its
contract plus process-lifecycle test with `bun run test:postgres`.

Repository channels use this port for their document, sidecar and transcript.

One database-wide `chopin:writer` lease allows one active Chopin process per
database. A second process refuses startup. The holder renews the lease while
serving and shuts down if renewal fails or its safety deadline passes. Adapter
fencing prevents an expired holder from committing collaboration state even
before shutdown completes.
