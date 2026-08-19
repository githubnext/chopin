# Canonical Implementation Skill Instructions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Chopin's MCP service the sole lifecycle authority consumed by the portable implementation skill.

**Architecture:** The MCP initialize response derives instructions from the existing tool registry. The skill retains local execution practices and delegates command semantics to that response.

**Tech Stack:** Bun, TypeScript, MCP Streamable HTTP, Markdown Agent Skills

**Spec:** `docs/superpowers/specs/2026-08-19-canonical-implementation-skill-instructions-design.md`

## Global Constraints

- Keep lifecycle tool registration singular in `apps/server/src/mcp/lifecycle.ts`.
- Do not add tests to `apps/server/src/mcp.test.ts`, which is already 999 lines.
- Preserve the provider-neutral skill and prompt.
- Tests describe observable behavior rather than source wording.

---

### Task 1: Publish canonical MCP instructions

**Files:**

- Modify: `apps/server/src/mcp/lifecycle.ts`
- Modify: `apps/server/src/mcp.ts`
- Test: `skills/implementing-chopin-plans/contract.test.ts`

**Interfaces:**

- Consumes: `TOOLS` and `LIFECYCLE_TOOLS` public tool descriptors.
- Produces: an MCP initialize `instructions` string derived from advertised implementation tools.

- [ ] **Step 1: Replace substring tests with an initialize-boundary test**

Call the real `handler`, read `result.instructions`, and require the complete
implementation lifecycle plus distinct `block_task` and `request_revision`
guidance.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `bun test skills/implementing-chopin-plans/contract.test.ts`

Expected: FAIL because initialize has no `instructions` field.

- [ ] **Step 3: Clarify canonical tool descriptions and derive instructions**

Describe task blockers, graph revision, task completion ordering, and graph-wide
verification in the lifecycle registry. Build initialize instructions from the
advertised implementation tool descriptors rather than copying their names and
semantics into a second constant.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `bun test skills/implementing-chopin-plans/contract.test.ts`

Expected: PASS.

### Task 2: Reduce and verify the portable skill

**Files:**

- Modify: `skills/implementing-chopin-plans/SKILL.md`
- Modify: `skills/implementing-chopin-plans/prompt.md`

**Interfaces:**

- Consumes: MCP initialize instructions and current tool descriptions.
- Produces: provider-neutral local implementation guidance without a copied lifecycle contract.

- [ ] **Step 1: Remove copied lifecycle semantics**

Keep checkout validation, dependency-ready work, independent review,
verification evidence, and one PR per task. Delegate tool choice and ordering to
the MCP service instructions.

- [ ] **Step 2: Run the same pressure scenario with a fresh agent**

Expected: the agent selects `request_revision`, stops coding, and reports no
contradiction in the skill.

- [ ] **Step 3: Run repository verification**

Run: `bun test`, `bun run types`, `bun run ci`, and `git diff --check`.

Expected: all commands pass; only the documented PostgreSQL skips are allowed.

- [ ] **Step 4: Commit and update PR #50**

Commit the hardening changes and force-update `tq/020-teach-agents-implement-plans`
with an exact lease after confirming its remote head has not changed.
