# SeeCode rendering module implementation plan

> **For agentic workers:** Use bounded subagent tasks with explicit file ownership. Check each completed stage before proceeding.

**Goal:** Commit a reusable `@chopin/diagrams` package containing the pinned SeeCode renderer catalogue, a scoped interactive browser view, and a runnable Chopin gallery with a document specimen.

**Architecture:** `renderDiagram(input: unknown)` validates an already-resolved declarative spec and returns deterministic SVG body, view box, graph metadata, motion steps, and diagnostics. `Diagram` is the React browser adapter: it supplies a per-instance SVG ID prefix, renders semantic controls and detail content, and owns local focus, playback, and disposal. The web app consumes only the package exports; the renderer never imports an application or reads files or URLs.

**Tech stack:** Bun workspace, TypeScript public API and React adapter, preserved upstream `.mjs` render algorithms and JSON schemas, CSS using `@chopin/visuals` tokens, Vite development route, Bun and Playwright checks.

**Base:** `35549a43499f2a3d1cb7f957212b415475d34631` on `maggie/seecode-rendering-module`. **Upstream:** SeeCode `8c48bb8804a5e531ea718edecedd10200ddbcb31` (MIT). The read-only clone is `/private/tmp/chopin-seecode-review-20261008`.

## Ownership and boundaries

| Stage | Owner | Files | Checkpoint |
| --- | --- | --- | --- |
| 1. Core | Worker A | `packages/diagrams/src/core/**`, schemas, fixtures, `packages/diagrams/src/render.ts`, core tests, package metadata and licence/provenance | All registered types and representative aliases render through the bounded public contract; no Node or browser API in core |
| 2. Browser | Worker B | `packages/diagrams/src/viewer/**`, `packages/diagrams/src/diagram.tsx`, viewer styles and adapter tests | Two instances, focus/step/replay/inspect, scoped IDs, reduced motion and cleanup |
| 3. Gallery | Worker C | `apps/web/src/diagram-gallery/**`, `apps/web/src/main.tsx`, `apps/web/package.json`, gallery browser tests | `/diagram-gallery` works in Vite development and includes a prose + two-diagram document specimen |
| 4. Integration | Lead | `bun.lock`, shared package exports/config, plan/docs, verification, screenshots, final review and commits | Narrow tests, types, build, CI, real-browser checks and branch review complete |

Workers share a checkout and must preserve one another's edits. Worker B can depend only on the declared public result shape below, not Worker A internals. Worker C can depend only on the package export. The lead owns integration conflicts and final evidence.

## Public contract

`DiagramSpec` is a JSON-compatible object with an allowlisted `type` and resolved data. The entry point takes `unknown`, normalizes supported aliases, rejects file-path `data`/`links`, privileged `out` and unbounded inputs, runs the retained schemas and renderer, and contains exceptions as `DiagramProblem[]` (`code`, `at`, `msg`, optional `fix`). Success contains `body` (trusted renderer-produced SVG fragment), `viewBox: [number, number, number, number]`, `steps`, `motion`, `type`, `title`, `description`, optional `graph` (`nodes` and `edges` for exploration), and nonfatal diagnostics. The adapter wraps `body` in SVG, namespaces marker and other SVG IDs, and never evaluates authored HTML. Keep `renderDiagram` deterministic for the same input and independent of browser state.

Use the upstream schemas in a static registry. Retain the 42 types registered in `types.mjs` and 15 aliases in `ALIASES`, without making the count itself the only test. Include a valid resolved fixture for every registered type. Keep source layout modules recognizable under `src/core/render/{graph,lanes,structure,charts,shared}` and record any changed algorithm. Do not carry `render.mjs`'s file loading, `page.mjs`, CLI, importer/exporter, brand crawler, global viewer or remote font dependency. Reuse `@chopin/visuals` colour and font tokens in the presentation layer; preserve upstream spacing and timing unless a measured defect requires adjustment. The mono stack stays available for technical labels.

## Tasks

### 1. Extract and validate the pure core

- [ ] Copy the pinned renderer modules, `types.mjs`, `schema.mjs`, `svg.mjs`, `text.mjs`, `motion.mjs`, and schemas into the package; keep import paths and attribution legible.
- [ ] Add package metadata, TypeScript entry types, static schema lookup, safe spec limits, alias resolution, and `renderDiagram` without Node I/O or browser globals. Reject nonfinite numbers, excessive depth/collection/string size, file path fields, unsupported styles and malformed source before rendering. Keep `renderDiagram` pure; avoid the upstream global text-width scale by passing or fixing a constant modest Inter allowance.
- [ ] Convert the 42 upstream examples to resolved local fixtures. Assert every registry type has a fixture, each renders without errors or nonfinite SVG geometry, representative aliases work, escaped hostile labels remain inert, invalid inputs return diagnostics, and repeat calls are equal.
- [ ] Preserve the SeeCode MIT notice and a provenance map; include third-party notices only for assets/code retained. Commit the core stage.

### 2. Build the scoped browser adapter

- [ ] Implement `<Diagram spec={...} />` using `renderDiagram`. Wrap each result with per-instance SVG IDs, title and description. Render errors as readable content, not raw markup.
- [ ] Add local step/replay/reset controls and focusable graph nodes/edges with hover and keyboard focus tracing plus click-to-inspect details. Scope queries and handlers to a root ref; source replacement resets local state; unmount cleans listeners/timers. Do not change hash, theme, localStorage or editor key handling.
- [ ] Adapt SeeCode motion and diagram CSS under `.ch-diagram`; map paper/ink/accent/series/font roles to existing Chopin tokens. Test real Inter labels for clipping and use a small fixed geometry allowance if needed. Preserve reduced-motion and print end states.
- [ ] Add focused adapter tests for result changes and IDs, then commit the adapter stage.

### 3. Make the gallery and document specimen

- [ ] Add a development-only `/diagram-gallery` route following the design-audit guard pattern; production output must omit it. Show every retained type grouped by family, with normal-width graph, sequence and chart samples and a documented direct URL.
- [ ] Include a document-surface specimen with ordinary prose and two independent diagrams using the real package component and the existing document style. Label it as a development specimen, not a persisted authored feature.
- [ ] Add real-browser checks for two-instance marker isolation, focus and editor arrow keys, playback, source replacement/unmount, narrow width, font loading and reduced motion. Capture review screenshots at wide and narrow sizes outside commits. Commit the gallery stage.

### 4. Integrate and review

- [ ] Run focused Bun tests, `bun run fix`, inspect its diff, `bun run types`, `bun run build`, `bun run ci`, and focused Playwright gallery checks. Run extra suites only for a concrete remaining risk.
- [ ] Inspect representative graph, sequence and chart screenshots at wide and narrow widths. Request an independent code/behaviour review, repair substantive findings, and verify the final diff.
- [ ] Update concise package usage and catalogue/provenance notes, commit the final changes, and report branch/base/final commit, URL, screenshot paths, exact checks and limits to the strategy chat.

## Scope decisions and limits

This branch proves a package and development specimen, not a new durable MDX diagram node or collaboration workflow. Its viewer keeps useful local exploration and motion; upstream standalone search, route journey, lenses, minimap, pan/zoom and media export may be deferred if their lifecycle would enlarge the adapter. Renderer-type coverage and viewer-feature coverage are reported separately. No arbitrary imports, URL/file data, network access or code evaluation enter the runtime renderer.
