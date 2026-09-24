---
name: creating-chopin-plans
description: Use when a coding-agent conversation has settled enough context to create a Chopin document, or when revising an existing document through update_document after review or new findings.
---

# Creating and revising a Chopin plan

Create one initial Chopin document from the useful outcome of the settled
conversation, then revise that same document as the plan develops. Chopin's
current MCP instructions and tool descriptions are authoritative. If
`update_document` is unavailable, report that limitation instead of creating a
replacement document or trying to trigger the Planner.

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
same key. Once creation succeeds, do not call `create_document` again for that
document. Follow the revision flow below to preserve its Conversation and
Decisions.

## Revise an existing document

1. Read the supplied canonical document URL or UUID with `read_document`. Work
   from its latest `source` and `revision`, not a copied plan or an earlier tool
   result. Confirm that the requested change belongs to this document.
2. Prepare the full replacement MDX in `plan`, including unchanged prose. Copy
   existing Questionnaire, Decision, and Research projections unchanged,
   including their ids and answers. Do not invent, remove, or rewrite those
   server-owned components to make the edit pass validation.
3. Call `update_document` with `id`, the revision just read, the complete `plan`,
   and a new nonblank `idempotencyKey` of at most 128 characters. Keep the exact
   arguments until the outcome is known. The caller needs repository push or
   administration access; its MCP bearer does not acquire Planner ownership.
4. If the response is lost or uncertain, retry with the same key and identical
   arguments, including the original URL or UUID. Do not switch identifiers or
   change the source during a retry. A replay returns the original applied
   source and revision, which may no longer be the latest document. Read again
   before planning another edit.

If the document already has an approved implementation graph, changing its
source makes that graph's plan revision stale even before a run is claimed.
Coordinate a graph revision and renewed approval before expecting implementation
to start; a successful document update does not update or approve the graph.

Handle refusals without overwriting collaborators' work:

- `revision-conflict`: re-read the complete document, reconcile the requested
  edit with intervening changes, and submit a new update with a new key. Do not
  merely replace the revision number on stale source.
- `idempotency-conflict`: the key was reused with different arguments. Recover
  the original request for an uncertain retry; use a new key only for an
  intentional new update after reading the current document.
- `issues`: repair the reported validation problem. Treat changed arguments as
  a new update with a new key.
- `protected-projection`: re-read and preserve the exact server-owned projections.
  This code also covers other rewrite validation or reconciliation refusals. If
  unchanged projections still fail, stop and report the refusal rather than
  repeatedly retrying or stripping components to get past it.
- `document-locked`: stop document edits and follow the implementation's
  revision and graph-release process. Do not bypass the lock by creating a copy.
- `document-archived`: stop and ask whether to restore the document; do not
  restore or replace it implicitly.
- `repository-forbidden` or `document-unavailable`: report the access or
  availability problem instead of recreating the document.

## Hand off

Return the created or updated document's human-readable `url` as the canonical handoff,
with its title. Treat the returned `id` as an internal MCP identifier: include it
separately when useful, but never replace the `/documents/...` URL with a
`/channels/<id>` link. Do not open it automatically.
After an idempotent replay, use a fresh `read_document` result for the current
title and canonical URL, since the stored response may predate a rename. Keep
the replay's accepted revision distinct from the latest revision.

Use [prompt.md](prompt.md) as a starter for creation or revision with this skill
installed.
