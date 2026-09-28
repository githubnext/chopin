# Chopin product context

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers, designers, and product owners who need to co-author plans in real time before handing implementation work to coding agents.

## Product Purpose

Help a team research possible options, make decisions together, and reach clear agreement in a shared plan that can guide implementation.

## Positioning

Chopin combines a live, repository-connected document with team conversation, attributed decisions, and a hosted Planner that can read the repository and co-author the document. People remain responsible for the decisions.

## Operating Context

- A team selects a GitHub repository and works together in one channel containing a document, Chat, and Decisions.
- The current interface labels the document view **Plan**. The underlying document model can also represent specifications, RFCs, proposals, and decision records.
- People can ask the Planner to investigate repository context and propose document changes. A `/research` request can publish a completed child document with its own collaboration context.
- A separate coding agent can connect through MCP for document work and the experimental implementation handoff.

## Capabilities and Constraints

- The document is collaborative rich text stored as restricted, readable MDX. People and the Planner edit the same artifact.
- Decisions retain attributed answers and accepted comments separately from document prose, so later edits do not silently change what the team agreed.
- The Planner has bounded, repository-fixed read access; it cannot edit a checkout, write to GitHub, or implement code.
- Browser access depends on GitHub sign-in, instance admission, a matching GitHub App installation, and repository permissions.
- Chopin is experimental research software. The implementation handoff is not yet a complete production workflow.
- Use **document** for the authored artifact, **Planner** for the hosted agent, and **coding agent** for an external MCP client. Use **plan** for the planning workflow or a literal interface label.

## Evidence on Hand

- [Repository README](../../README.md) describes the product, current workflows, and limits.
- [Architecture](../../docs/architecture.md) defines document and channel boundaries and product terminology.
- The development-only design audit at `src/design-audit/` contains live specimens of the current interface.

## Product Principles

- Keep shared decisions attributable and distinct from editable prose.
- Let people and the Planner work in the same durable document, with people owning the decisions.
- Ground research and proposed changes in the selected repository.
- Make the path from collaborative agreement to agent handoff clear without implying that experimental steps are already complete.
