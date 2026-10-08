---
name: building-app-previews
description: Build adjustable previews from real app components, preserving their styles and context, with browser evidence and built resources for local review or a supplied delivery contract.
---

# Building app previews

Prepare a faithful, adjustable view of the target app's actual component. The
preview adapter owns parameter mapping; the supplied host owns controls and chosen
values. Read [capabilities](references/capabilities.md) before choosing delivery.

1. Read the target repository's instructions and design guidance. Inspect the
   component, its source entry, children, styles, dependencies and required context.
   Record the source commit and relevant dirty files. Resolve missing source or
   intended behaviour before making an imitation.
2. Reuse browser-renderable source and deterministic fixtures. Preserve providers,
   fonts, assets and interactive children; replace service calls and business
   effects with explicit fixtures. For React or server-coupled views, read
   [React preview integration](references/react-preview.md).
3. Choose a few adjustments that answer the request. Trace each to a real prop or
   app token; record units, bounds, step and source baseline. Copy
   [controls.ts](assets/controls.ts) and [preview.ts](assets/preview.ts) together into
   the generated workspace. Their API supports number and six-digit hex colour
   controls; it is local authoring code, not a publication schema.
4. Validate complete snapshots, map values to the reused view, and explicitly apply
   the baseline. Build browser resources using the app's dependency versions.
   Include emitted CSS, chunks, fonts and assets; report compatibility gaps.
5. Browser-check the built preview against the live source at matching component
   viewports after fonts and assets load. Exercise every adjustment and supported
   comparison/recovery interaction. Verify resources and errors as described in
   [reporting](references/reporting.md); callback success alone is insufficient.
6. Return built resources, source/control references, reproducible evidence and
   limits. Publish only through currently supplied descriptors and within the
   user's authorization. When integration is absent, hand off local files and say
   so explicitly.

Use [prompt.md](prompt.md) for a starter request. Install this entire folder,
including `assets/` and `references/`; confirm harness discovery or explicitly read
this `SKILL.md`. Copying a skill does not connect MCP or start a remote workflow.
