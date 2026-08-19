# Lifecycle projection fix

## Finding

`Implementations.reportLifecycle` erased lifecycle responses to `unknown`, so malformed host adapters typechecked. The same durable lifecycle state was also projected independently in the hosted MCP adapter and the live plan broadcast path.

## Fix

- Added the typed `ImplementationLifecycle` projection and `implementationLifecycle` function at the task lifecycle domain boundary.
- Reused it for MCP live, replayed, and committed closed-plan results; implementation reads; and `plan:lifecycle` broadcasts.
- Typed the MCP host interface with that projection and retained the existing protocol shape.
- Kept durable event logs in `Lifecycle`; the projection only derives public activity and history.

## TDD evidence

Before the implementation change, the server typecheck failed because the malformed projection's `@ts-expect-error` was unused. After typing the boundary, TypeScript rejects `{ activity: "recorded" }` as an implementation lifecycle projection.

## Verification

- `bun test apps/server/src/mcp.test.ts apps/server/src/mcp/hosted.test.ts apps/server/src/tasks/plan-graphs.test.ts apps/server/src/tasks/lifecycle.test.ts` — 62 passed, 0 failed.
- `bun run types` — passed.
- `bun run ci` — passed with 0 lint warnings or errors.

## Concerns

None. The unrelated untracked graph-foundation plan was not changed or staged.
