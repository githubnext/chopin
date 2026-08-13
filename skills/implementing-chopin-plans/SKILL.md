---
name: implementing-chopin-plans
description: Use when implementing an approved Chopin task graph through its MCP contract from a local coding-agent workspace.
---

# Implementing Chopin plans

Chopin's MCP contract is authoritative. This skill supplies local work habits without changing the approved graph.

## Claim the canonical graph

1. Resolve the supplied canonical document URL through the Chopin MCP server. Call `read_implementation` and read the graph, acceptance criteria, dependencies, repository context, current revisions, and service instructions.
2. Before claiming anything, compare the graph's repository and base reference with the local checkout. Inspect the repository identity, branch, remotes, and requested base ref.
3. If they differ, surface the mismatch to the operator and stop before claiming or changing code.
4. Call `start_implementation` with the current revisions and checkout context. Re-read the returned state and begin only when the claim succeeds.

Use the canonical document throughout; copied plans and stale task lists are not substitutes.

## Execute dependency-ready tasks

Work only on tasks whose dependencies are complete. Independent ready roots may be delegated when the runtime supports it, but the owning agent remains responsible for MCP reports, review, verification evidence, and one PR per task.

For each task:

1. Refresh `read_implementation`, then read the task and acceptance criteria.
2. Call `start_task`; begin only when it accepts the task.
3. Make only the required changes. Do not edit Chopin plan or graph content or start another top-level agent CLI session.
4. When the graph must change or work cannot continue, call `block_task` with the cause and what is needed, then stop code changes for that task.
5. Perform a separate review pass after implementation. Prefer a fresh reviewer sub-agent; otherwise review independently after stepping away. Resolve in-scope findings and run focused checks.
6. Create exactly one pull request. Call `report_pr` before `complete_task`; include the implementation summary when completing. Both reports must succeed.

## Verify the graph

After every task is complete, perform an independent verification pass over the whole graph. Run all relevant checks and capture command names, outcomes, and limitations as verification evidence for every task.

Call `report_verification` with the reviewer method, evidence, summary, and any tasks needing work. A failed report returns those tasks to work: re-read the implementation, update their existing PRs, complete them again, and repeat verification. Only an accepted passing report releases the implementation.

## Boundaries

| Situation                                  | Required response                     |
| ------------------------------------------ | ------------------------------------- |
| MCP instructions conflict with this skill  | Follow MCP instructions.              |
| Repository or base ref differs             | Surface it and stop before claiming.  |
| Scope, criteria, or dependencies must move | Call `block_task` and stop that task. |
| A dependency is incomplete                 | Leave the task waiting.               |
| A task has no PR                           | Do not call `complete_task`.          |
| Any task lacks verification evidence       | Do not pass `report_verification`.    |

Keep this provider-neutral Agent Skills directory intact when installing it in the shared skill location supported by the local runtime.
