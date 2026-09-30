# Current colour decision · 29 September 2026

Maggie chose to restore all audit-driven colour changes: original Delete red, supplementary conversation text and opacity, original pierre-light code palette, and quiet audit metadata labels. Keyboard, focus, scrolling and layout repairs remain. This supersedes historical claims below that darkened colours were the final outcome or that no contrast exceptions exist.

Fresh browser measurements: Delete default/focus 4.20:1; timestamps/tool metadata 4.43:1; queued text/identity 2.21–2.64:1; measured syntax tokens 2.14–3.27:1; audit metadata 4.12:1. The target in these scans is 4.5:1. Each accepted finding has an explicit approved role and exact specimen/viewport fingerprint; no entire component or rule is excluded. See [the decision record](contrast-decision.md). All 46 final Linux checks passed in 5.3 minutes, including eight rejection checks. Changed pictures were reviewed. [Current required GitHub checks](https://github.com/githubnext/chopin/pull/209/checks) report the latest commit’s result.

# Decisions and findings

- The supplied brief approves implementation; no new product choices are necessary.
- Use a dedicated Playwright config under `e2e/design`, launched against Vite development mode. Production build remains unchanged.
- Screenshots cover small named specimens at wide and narrow viewport sizes. Real menu/dialog fixtures supplement existing static examples.
- Prefer a pinned Linux Playwright container for both generation and CI to avoid macOS font/rendering differences. No global runtime changes.
- Existing `e2e` job remains required and runs the design suite as a separate step, with readable failure artifacts.
- Automated axe scans and targeted keyboard checks provide partial accessibility coverage, not screen-reader or usability certification.

## Historical product findings · 28 September

At 1440px with axe 4.13.0, the initial audit found destructive default/focus buttons at 4.20:1, chat timestamps and tool metadata at 4.43:1, queued identity/text at 2.21–2.64:1, and seven syntax-highlight spans at 2.14–3.27:1. These are historical measurements, not current exceptions. At that stage, the shared destructive token (8c6ddabc), accessible Pierre-derived code palette (bb844755), and chat contrast (de261386) repairs were integrated. That historical version required zero axe violations; this is superseded by the explicit 29 September decision below. The code preview `role="group"` follow-up (61d42d15) is integrated.

## Coverage boundary

The static editor/callout/code renderers, Transcript, shared Select, DocumentActionsMenu, and NavigationDialog are production components. Button/field states use production classes. The chat composer and table interaction drawings are illustrative fixture markup; this suite does not claim collaborative editing, actual table selection, screen-reader usability, or complete app-route coverage. It does check native keyboard scrolling in the real table and code previews. Existing system E2E remains responsible for authenticated workflows.

## Review changes

- Exact Docker source copies prevent unrelated local files entering the image; credential-shaped files are excluded. Chromium uses a private 1 GiB shared-memory mount instead of host IPC.
- Baselines and reports are runtime mounts; screenshot updates do not rebuild the dependency image.
- Scope of E2E ignore is the exact dedicated `e2e/design/*.e2e.ts` location; 236 existing system tests remain collected.
- Production check includes audit CSS selectors as well as JS sentinel content.
- Text enlargement assertion verifies the actual computed field font increases, then checks selected prose/control reflow. Table keyboard scrolling is checked separately at normal size; no unsupported 200% code-scroll claim.

## Capture readiness diagnosis

The final control-only run was **30 passed, 2 failed**, not the 32 initially reported before completion. Both failures were table capture bounds, not product/table geometry. Instrumentation showed lazy renderers/images above the table changed the full audit scroll height from 14714 to 14903px after scrolling, leaving its bottom at1109px in a1000px viewport. The harness now waits for real Mermaid/math/highlight output and resolves the deterministic lazy-image fixtures before positioning a capture. Assertions are retained; no height tolerance or masking was introduced. The native focused rerun passed both table captures and both code keyboard/scroll assertions. Final Linux generation passed all 38 checks; the final unchanged-baseline repeat also passed all 38 checks.

Full plates use exact capture bounds to exclude neighboring content; isolated controls retain six pixels for focus rings. All 32 final images were reviewed. Required CI must still be rerun after the documented multi-PR merge integration.
