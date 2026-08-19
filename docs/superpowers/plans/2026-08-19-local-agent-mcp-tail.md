# Local Agent MCP Tail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild PRs #40 and #43 on the completed MCP stack with honest authorization guidance and canonical creation instructions.

**Architecture:** PR #40 adds a typed forbidden outcome at the document-reader boundary and documents provider setup. PR #43 gives creation the same server-authoritative contract shape as implementation, publishes a portable skill bundle, and extracts creation tests from the nearly 1,000-line protocol test.

**Tech Stack:** Bun, TypeScript, MCP Streamable HTTP, Agent Skills, Markdown.

**Spec:** `docs/superpowers/specs/2026-08-19-local-agent-mcp-tail-design.md`

---

## Global constraints

- Rebuild each PR from current `origin/main`; never merge its inherited pre-stack MCP code.
- Tabs, `let`, double quotes, and dprint formatting remain repository conventions.
- MCP/tool behavior is tested at the real handler boundary.
- No changed file may exceed 1,000 lines.
- A created document is an editable Chopin channel; only the creation operation is one-shot and idempotent.
- The unrelated `docs/superpowers/plans/2026-08-18-graph-foundation-rewrite.md` remains untouched and untracked.

### Task 1: Rebuild PR #40 — repository access and local-agent setup

**Files:**
- Modify: `apps/server/src/mcp.ts`
- Modify: `apps/server/src/mcp/hosted.ts`
- Modify: `apps/server/src/mcp/hosted.test.ts`
- Create: `apps/server/src/mcp/documents.test.ts`
- Modify: `apps/server/src/mcp.test.ts`
- Create: `docs/local-agent-mcp.md`
- Modify: `readme.md`

- [ ] **Step 1: Write the failing document-boundary test**

Move the existing list/read handler test into `apps/server/src/mcp/documents.test.ts`, then add a reader whose `list` returns `"forbidden"`. Assert that `tools/call` returns:

```ts
{
	content: [{ type: "text", text: '{"code":"repository-forbidden"}' }],
	isError: true,
	structuredContent: { code: "repository-forbidden" },
}
```

The production mutation this catches is collapsing denied access back into an empty document list.

- [ ] **Step 2: Verify RED**

Run: `bun test apps/server/src/mcp/documents.test.ts`

Expected: type/runtime failure because `DocumentReader.list` accepts only arrays and the handler always wraps the result as `documents`.

- [ ] **Step 3: Add the typed forbidden outcome**

Change the reader contract to:

```ts
list(caller: Caller, repository: string): Promise<DocumentSummary[] | "forbidden">;
```

Return `"forbidden"` from the hosted adapter when the repository is absent or lacks pull permission. At the MCP boundary, translate it to `{ code: "repository-forbidden" }`; preserve `{ documents: [] }` only for an accessible empty repository.

- [ ] **Step 4: Prove the hosted authorization distinction**

Update the hosted adapter test so pull denial and an inaccessible repository both return `"forbidden"`, while a readable repository with no stored channels returns `[]`.

Run: `bun test apps/server/src/mcp/documents.test.ts apps/server/src/mcp/hosted.test.ts`

Expected: all focused tests pass.

- [ ] **Step 5: Publish concise setup guidance**

Port PR #40's provider commands, but share one verification and troubleshooting section. State:

- HTTP `401` means bearer authentication failed;
- `repository-forbidden` means the identity authenticated but lacks the operation's repository permission;
- pull is enough for list/read/read-implementation;
- push or admin is required for create/start/report lifecycle operations;
- after connection, MCP initialize instructions and current tool descriptions are authoritative.

Link the guide once from `readme.md`. Do not copy lifecycle steps into provider sections.

- [ ] **Step 6: Verify and commit PR #40**

Run:

```bash
bun test apps/server/src/mcp/documents.test.ts apps/server/src/mcp/hosted.test.ts
bun run types
bun run ci
git diff --check
```

Expected: all commands pass. Commit the rebuilt PR #40 payload.

### Task 2: Rebuild PR #43 — canonical creation skill and instructions

**Files:**
- Modify: `apps/server/src/mcp.ts`
- Modify: `skills/implementing-chopin-plans/contract.test.ts`
- Create: `skills/creating-chopin-plans/SKILL.md`
- Create: `skills/creating-chopin-plans/prompt.md`
- Create: `skills/creating-chopin-plans/contract.test.ts`
- Create: `apps/server/src/mcp/create.test.ts`
- Modify: `apps/server/src/mcp.test.ts`
- Modify: `readme.md`

- [ ] **Step 1: Capture RED for the creation contract**

Create a real initialize-boundary test using `handler` with a creation adapter and no implementation adapter. Require general MCP authority plus the advertised `create_document` workflow, and require that it does not tell creation agents to read a nonexistent implementation.

Run: `bun test skills/creating-chopin-plans/contract.test.ts`

Expected: fail because the directory/instructions do not exist and current initialize guidance is implementation-only.

- [ ] **Step 2: Scope canonical initialize instructions**

Make the common instruction apply to every advertised workflow:

```text
Chopin's MCP contract and current tool descriptions are authoritative.
```

Advertise creation semantics through the current `create_document` descriptor. Put the canonical-implementation requirement in a separate implementation-only sentence, followed by the implementation/lifecycle descriptors. Update the existing implementation contract test to assert the real response.

- [ ] **Step 3: Verify GREEN for both instruction consumers**

Run:

```bash
bun test skills/creating-chopin-plans/contract.test.ts skills/implementing-chopin-plans/contract.test.ts
```

Expected: both real initialize-boundary tests pass.

- [ ] **Step 4: Capture RED for corrected creation retry**

Extract the existing creation protocol cases from `apps/server/src/mcp.test.ts` into `apps/server/src/mcp/create.test.ts`. Add a test that first submits `<Chart />`, checks the returned `unknown-component` issue and zero adapter calls, then submits the corrected plan with the same idempotency key and checks exactly one adapter call carrying that key.

Run: `bun test apps/server/src/mcp/create.test.ts`

Expected before moving/adding the implementation: the new corrected-retry assertion fails or the test file is absent; after extraction, existing creation behavior remains covered without growing `mcp.test.ts` past 1,000 lines.

- [ ] **Step 5: Publish the portable creation skill**

Create `skills/creating-chopin-plans/` with:

- a concise trigger-only description;
- local workflow for synthesizing the brief, inspecting exact repository provenance, drafting supported MDX, repairing validation, and returning the canonical URL;
- no copied lifecycle or mutable tool schema;
- no claim that the channel is immutable;
- no automatic URL opening;
- a provider-neutral `prompt.md` that supplies the settled conversation and asks the agent to follow the installed skill plus current MCP instructions.

Update the README to copy the whole directory into a runtime-supported Agent Skills location and distinguish this creation skill from the implementation skill.

- [ ] **Step 6: Skill behavior check and focused GREEN**

Run one fresh-agent baseline without the skill against a settled-conversation scenario and record whether it creates multiple documents, forwards the raw transcript, invents provenance, or calls creation again after success. Run the same scenario with the skill and confirm the corrected behavior. Save the evidence in the SDD report, not the repository.

Run:

```bash
bun test apps/server/src/mcp/create.test.ts skills/creating-chopin-plans/contract.test.ts skills/implementing-chopin-plans/contract.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 7: Verify and commit PR #43**

Run:

```bash
bun test
bun run types
bun run ci
git diff --check
```

Expected: 0 failures, with only the two expected PostgreSQL skips. Commit the rebuilt PR #43 payload.

## Final integration

After both task reviews pass, run a whole-feature review against each PR's base. Confirm the provider commands remain current, every initialize instruction matches an advertised capability, both PRs contain only their intended rebuilt payload, and the old inherited MCP stack is absent. Update the two existing remote PR branches with force-with-lease.
