---
name: implementing-chopin-plans
description: Use when implementing an approved Chopin task graph through its MCP contract from a local coding-agent workspace.
---

# Implementing Chopin plans

Chopin's MCP initialize instructions and current tool descriptions are authoritative. This skill adds local work practices; it does not restate the lifecycle.

## Claim the canonical graph

1. Pass the supplied canonical document URL directly as the `id` input to `read_implementation`; the read tool accepts either that URL or a document UUID.
2. Read the returned document UUID, graph, acceptance criteria, dependencies, repository context, revisions, lifecycle state, MCP initialize instructions, and current tool descriptions. Copied plans and remembered command sequences are not substitutes.
3. Compare the graph's repository, base branch, and base commit with the local checkout. Inspect repository identity, branch, remotes, commit, and working tree before claiming or editing.
4. If the checkout does not match, surface the mismatch and stop.
5. Call `start_implementation` with the returned document UUID, revisions, and current checkout context. Begin only when the claim succeeds, and retain the returned run identity for later calls.

## Execute ready work

Re-read the implementation before every lifecycle action, then follow the service instructions for the current state. Reads may use the canonical URL or UUID, but `start_implementation` and every later lifecycle call must use the UUID returned as `document.id`.

- Work only on tasks whose dependencies are complete. Independent ready roots may be delegated when the runtime supports it; the owning agent remains responsible for MCP reporting, review, verification evidence, and one pull request per task.
- Make only the required changes. Do not edit Chopin plan or graph content or start another top-level agent CLI session.
- Stop code changes whenever the service requires a blocker or graph release. Explain what must change and wait for the next valid lifecycle state.
- Perform a separate review pass after implementation. Prefer a fresh reviewer sub-agent; otherwise review independently after stepping away. Resolve in-scope findings and run focused checks.
- Create exactly one pull request per task. Update that pull request if later verification returns the task to work.

## Verify the graph

After every task is complete, perform an independent whole-graph verification. Run all relevant checks and capture command names, outcomes, and limitations as evidence for every task. Submit that evidence through the current service contract and follow the returned lifecycle state; only an accepted passing result releases a successful implementation.

## Boundaries

| Situation                                  | Required response                         |
| ------------------------------------------ | ----------------------------------------- |
| MCP instructions conflict with this skill  | Follow current MCP instructions.          |
| Repository or base ref differs             | Stop before claiming or changing code.    |
| Scope, criteria, or dependencies must move | Follow graph-release guidance; stop code. |
| A dependency is incomplete                 | Leave the task waiting.                   |
| Verification evidence is incomplete        | Do not report a passing result.           |

Keep this provider-neutral Agent Skills directory intact when installing it in the shared skill location supported by the local runtime.

Use [prompt.md](prompt.md) as a starter only after Chopin exposes an approved
graph through `read_implementation`.
