# Local agent MCP tail design

## Goal

Rebuild PRs #40 and #43 on the completed MCP stack so local-agent setup,
creation guidance, and the server's canonical instructions describe the same
product.

## Decisions

### Repository access is explicit

`list_documents` must distinguish an accessible repository with no documents
from a repository the caller cannot read. The hosted adapter returns a typed
forbidden outcome, and the MCP boundary exposes `repository-forbidden` without
revealing whether an inaccessible repository exists.

The setup guide states the permissions each workflow requires:

- pull access for listing, reading, and reading an implementation;
- push or admin access for creating a document, claiming implementation work,
  and reporting lifecycle progress.

Authentication failures remain HTTP `401`; repository authorization failures
remain authenticated MCP tool errors.

### Server and skills have separate authority

The initialize response states that the MCP contract and current tool
descriptions are authoritative for every tool. Its requirement to read the
canonical implementation before acting applies only to implementation and
lifecycle operations, never to `create_document`.

The creation skill keeps local judgment: synthesize the conversation into a
structured brief, inspect repository provenance, draft supported MDX, repair
validation issues, and hand off the returned channel. It does not duplicate a
mutable server protocol.

### Creation creates an editable channel

`create_document` is one-shot and idempotent, but the resulting Chopin channel
is collaboratively editable. The skill says to create one initial document,
stop calling the creation tool after success, and return the canonical URL. It
does not call the document immutable or open the URL as an external side
effect.

### Portable artifacts share one shape

The new skill lives at `skills/creating-chopin-plans/` beside
`skills/implementing-chopin-plans/`, with `SKILL.md`, `prompt.md`, and a real
boundary contract test. Installation copies the whole directory to a runtime's
supported Agent Skills location.

Creation protocol tests move out of the 999-line `apps/server/src/mcp.test.ts`
into a focused test module. The corrected-retry test proves that validation
does not consume an idempotency key: the invalid request returns a dialect
issue without calling the adapter, and a corrected request with the same key
reaches it exactly once.

## PR boundaries

PR #40 owns repository-forbidden listing behavior and the provider setup guide.
PR #43 owns creation instructions, the portable creation skill, creation test
extraction, and its README handoff. Both are rebuilt from current `main` and
share only this design history.

## Verification

Each PR runs its focused tests, `bun run types`, `bun run ci`, and
`git diff --check`. The combined feature also runs `bun test`; browser coverage
is unnecessary because the changes are MCP, documentation, and skill
boundaries.
