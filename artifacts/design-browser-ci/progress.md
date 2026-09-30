# Design browser CI progress

Implementation and local verification complete. Current required CI results: [PR #209](https://github.com/githubnext/chopin/pull/209/checks). Branch: `maggie/design-browser-ci`, base `99204aa5` (origin/main).

- [x] GitHub authentication and push/PR permission exercised (admin access).
- [x] Scoped Bun 1.4.2 via npm cache; Node 24.10.0; disposable Docker execution.
- [x] Install dependencies and exercise unauthenticated development audit in Chromium.
- [x] Add explicit coverage manifest, real interactive fixtures, assertions and axe reports.
- [x] Review all 32 Linux Chromium baselines and verify a clean repeat run; deliberate defects were detected.
- [x] Finish local validation and review of the integrated required e2e job.
- [x] Push PR with rendered images, link required CI, and publish the visual report.

Port 5422 reserved after checking no listener. No shared fixed-port E2E resources used yet.

## Milestone: exercised browser fixture and interactions

- Frozen dependency install passed using public npm registry (configured mirror had missing tarballs).
- Actual development route loaded in Chromium with no authentication or database.
- Local wide/narrow menu, modal focus trap, disabled Save, simulated save error, Select keyboard interaction: six checks passed.
- Fixed audit-only low-contrast labels and invalid selected-table-cell ARIA. Inline illustrative dialogs now use labeled groups, avoiding false modal semantics.
- Product contrast findings sent to Goal 3 with exact node fingerprints and real screenshots.
- Linux amd64 runner builds successfully from pinned Playwright and Bun images; 32 baselines are present, with final repeatability pending.
- Automatic approval review rejected extrapolating wide accessibility exceptions to narrow. No files were copied; the final harness uses no exceptions at either width.

## Milestone: independent checks and deliberate failures

- Production build passed; audit exclusion verified across 393 JS/CSS assets.
- Dedicated tests excluded from all system E2E projects (236 existing tests listed).
- Full unit run with socket permissions: 1657 passed, 2 PostgreSQL suites skipped, 0 failures.
- Pointer-based reduced-motion checks passed wide and narrow.
- Temporary Linux probes both failed as intended: changed menu surface caused pixel diff; empty menu action caused axe `button-name`. Removed probe source; preserved small evidence images and excerpt.
- Visual review rejected oversized narrow button screenshot as clipped. Now capture five small hierarchy/size rows; assert every screenshot fits its viewport and include 6px surrounding focus-ring space.
- Integrated shared destructive contrast token (8c6ddabc), code palette (bb844755), and chat contrast (de261386) repairs. The code preview `role="group"` follow-up (61d42d15) is also integrated.
- All temporary axe fingerprint exceptions have been removed. The final suite requires zero automatic violations.

## Milestone: full coverage assembled

- The explicit manifest yields 32 wide/narrow screenshots. The suite contains 38 tests, including native code and table keyboard scrolling.
- The fixture waits for real Mermaid, math, and highlighted-code rendering; resolves deterministic lazy images; and loads local Inter before capture. This addresses the earlier table bounds race without masking pixels or relaxing assertions.
- Focused native table and code checks passed. Full Linux repeatability, final axe results, and PR CI remain pending.

## Final Linux generation

- All 38 checks passed in 4.1 minutes under Linux amd64 emulation; zero axe violations and no exceptions.
- All 16 wide PNGs reviewed; narrow review and unchanged-baseline repeat underway.
- Fresh final local unit suite: 1658 passed, 2 PostgreSQL skips, 0 failures. Types, CI lint/design checks, build, and production-audit exclusion pass.

## Merge integration

Recommended human merge order: #207, #208, then this PR. Shared repair commits overlap. After rebasing onto enforcement, acknowledge the reviewed `design-audit/controls.tsx` source fingerprint for the added capture markers and rerun required CI. Goal 1 has a bounded controls-only patch; no token-policy exception is needed. Independent branch CI does not certify that combined state.

## Visual review and repeatability

- The first unchanged-baseline repeat passed all 38 checks in 4.1 minutes.
- All 32 PNGs reviewed. Narrow callouts had a few adjacent-content pixels in the outer margin. Full plates now use exact bounds; isolated button rows and menus retain focus-ring padding. Fourteen affected references are being regenerated and reviewed.
- Final system collection: 240 tests in 29 files, including the shared product-repair regressions; the dedicated design suite is excluded.

## Final local result

All 38 checks passed against the final references without update flags (4.1 minutes). All 32 screenshots were reviewed; the fourteen exact-bound replacements were reviewed again. Zero axe violations, no rule suppressions, no screenshot masks. Final types and format/lint/design checks pass. PR creation and remote CI are next.

## Pull request handoff

[PR #209](https://github.com/githubnext/chopin/pull/209), source commit `7195e40a08b3931c9105fd6077f5654802bce2d2`. Published description contains both inspected GitHub-hosted images. Goal 1 verified all 22 captured source hashes and the complete changed source-file set against this commit; its reviewed controls-only integration acknowledgement remains valid. Live required checks are linked above.

## Follow-up · 29 September 2026

Restored original red from shared commit09e99b2b (local223cb9cf), following Maggie’s explicit visual choice. Replaced the blanket zero-exceptions assertion with exact default/focus contrast fingerprints only. The plainer report rewrite is preserved and now explains the accepted4.20:1 shortfall. New verification and required CI pending.

## Expanded colour restoration · 29 September 2026

Integrated Goal3 restoration `6c063d8f` as `ee9f10ad`, resolving only the absent interface-quality test in favour of this branch. Adapted Goal1 canonical policy from `3d86ab04`; its separate enforcement documentation remains with Goal1. Reversed the audit-only metadata darkening while keeping semantics and capture markers. Fresh browser measurement records named approvals for 61 wide / 60 narrow nodes. Exact equality still rejects unexpected, changed or stale findings. Linux screenshot refresh and renewed required CI are in progress.

The first restored Linux run passed 37/38: narrow code included one additional original blue numeric token at 3.01:1. A controlled before/after/repeated-position experiment confirmed stable platform-specific detection: Linux seven syntax tokens, macOS six. Updated only that explicitly approved token record using Linux evidence. Final records contain 61 nodes per width. Canonical verification uses Linux; no tolerance or optional node matching was added.

## Restored local result

All 46 Linux checks passed (5.3 minutes): 38 interface checks and eight permanent approval-boundary checks. All 32 references captured; 26 changed PNGs visually reviewed. Exact findings match 61 explicitly approved nodes per viewport; other rules and new/changed/stale findings remain failures. Focused unit suite: 54 passed; types and format/lint/design checks passed. Current required GitHub results are linked in the report and PR.
