# Task 2: Creation metadata and hosted response projection

## Status

Complete. Creation metadata is a single validated `CreationMetadata` value at
the plan and sidecar boundaries. Hosted document output now goes through one
projection that keeps the public brief and omits idempotency, fingerprint, and
repository provenance.

## Implementation

- Added `CreationMetadata` in `apps/server/src/plan/service.ts` and replaced
  paired `brief` / `origin` plan and sidecar properties with `creation`.
- Changed initial creation, persistence, restoration, and stored reads to carry
  that one value. Restoration rejects malformed or partial creation metadata as
  a unit.
- Added a typed hosted `document` projection in `apps/server/src/mcp/hosted.ts`.
  Live reads, stored reads, created responses, and replayed responses use it.
  It only exposes `creation.brief`; provenance remains internal for conflict
  checking.
- Updated behavior tests to expect restored creation metadata and identical
  public create, replay, and read documents.

## Files

- `apps/server/src/plan/service.ts`
- `apps/server/src/plan/creation.test.ts`
- `apps/server/src/mcp/hosted.ts`
- `apps/server/src/mcp/hosted.test.ts`

## TDD evidence

RED:

```sh
bun test apps/server/src/plan/creation.test.ts apps/server/src/mcp/hosted.test.ts
```

Result: 10 pass, 3 fail. The creation tests failed because restoration expected
paired fields; the hosted storage assertion failed because `readStored` still
returned paired public values.

GREEN:

```sh
bun test apps/server/src/plan/creation.test.ts apps/server/src/mcp/hosted.test.ts
bun run types
bunx dprint check apps/server/src/plan/service.ts apps/server/src/plan/creation.test.ts apps/server/src/mcp/hosted.ts apps/server/src/mcp/hosted.test.ts
```

Result: focused suite 13 pass, 0 fail; all package and e2e type checks pass;
the four changed files pass dprint.

## Self-review

- Atomic channel creation and conflict/idempotency checks are unchanged; replay
  still compares the stored provenance internally.
- The shared projector is the only hosted document construction path and has a
  URL-preserving overload for create/replay responses.
- Exact public-document assertions ensure provenance and fingerprint cannot
  leak through create, replay, or stored `read_document` responses.

## Concerns

None. The existing live-read test covers the live response path; the same
shared projector now handles its metadata-bearing documents as well.
