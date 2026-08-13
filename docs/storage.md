# Storage adapters

Chopin's durable boundary is `StorageAdapter` in
`apps/server/src/storage/port.ts`. Domain services depend on that port, never on
a database driver or query language. PostgreSQL is the reference implementation,
not part of the contract.

The port is deliberately made of domain operations rather than generic CRUD.
In particular, `collaboration.commit` atomically advances a revision, appends a
Yjs update and events, replaces sidecar state, and records an idempotency key.
Acknowledging any of those separately would let a crash restore a state no
client was shown, or lose one it was.

## Guarantees

Every built-in adapter must provide:

- atomic, revision-checked channel commits;
- idempotent operation ids;
- ordered binary update and event replay;
- monotonic sequences across checkpoints;
- atomic first-agent ownership with a generation token;
- expiring login sessions;
- renewable leases whose fencing token is checked by durable channel writes;
- atomic checkpoint replacement; and
- distinct conflict, missing, corrupt and unavailable failures.

The application owns OAuth encryption, payload validation and Yjs semantics.
An adapter sees encrypted token bytes and versioned JSON, and must return those
bytes unchanged.

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

The default hosted adapter uses ordinary PostgreSQL and Bun's owned SQL pool.
It uses row locks for revisions, repeatable-read recovery snapshots, database
time for leases, and checksums for migration history. Start the development
database with `bun run db:up`, migrate it with `bun run migrate`, and run its
contract plus process-lifecycle test with `bun run test:postgres`.

Hosted repository channels use this port for their document, sidecar and
transcript. The `/r/*` prototype continues to use `DATA_DIR` only under
`AUTH_DRIVER=off`; `STORAGE_DRIVER=legacy` is not a hosted storage option.
