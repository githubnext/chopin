---
name: creating-chopin-plans
description: Use when a coding-agent conversation has settled enough context to create a new Chopin document through the create_document MCP tool.
---

# Creating a Chopin plan

Create one initial Chopin document from the useful outcome of the settled
conversation. Chopin's current MCP instructions and tool descriptions are
authoritative.

## Prepare the brief

Synthesize the settled outcome instead of forwarding the raw transcript. Record
the goal, constraints, settled decisions with their rationale, genuine open
questions, and repository findings.

Inspect the repository before creating: resolve its canonical identity, current
branch, and full commit SHA with read-only commands. Use that exact provenance
in the creation request.

## Draft and create

Write a supported Chopin MDX plan. Use normal Markdown by default; use only
documented components when they clarify the plan. Do not add imports, exports,
expressions, raw HTML, arbitrary JSX, or component ids owned by Chopin.

Generate one idempotency key for the attempt, then use the current
`create_document` descriptor to submit the brief, provenance, title, and plan.
If it reports validation issues, repair the relevant content and retry with the
same key. Once creation succeeds, do not call `create_document` again.

## Hand off

Return the created document's human-readable `url` as the canonical handoff,
with its title. Treat the returned `id` as an internal MCP identifier: include it
separately when useful, but never replace the `/documents/...` URL with a
`/channels/<id>` link. Do not open it automatically.

Use [prompt.md](prompt.md) as a starter when handing an already-settled
conversation to an agent with this skill installed.
