# Local agent app-preview toolkit

The toolkit gives a local coding agent instructions and tested helpers for
preparing an adjustable preview from an app's actual component source. Its
runnable example is local; production preview delivery remains separate.

## Use the skill

Read [building-app-previews](../skills/building-app-previews/SKILL.md) and use its
[starter request](../skills/building-app-previews/prompt.md). Install the entire
`skills/building-app-previews/` folder, including `assets/` and `references/`, in a
location your harness discovers. Confirm discovery or explicitly read `SKILL.md`.
The repository's `.agents/skills/building-app-previews` is a relative symlink to
that canonical folder. Copying the skill does not connect MCP or start work;
[local agent MCP](local-agent-mcp.md) covers the existing connection separately.
No global configuration changes are required for local preview preparation.

The skill follows the target app's instructions and design system. It inspects
real component source, providers, dependencies, styles, fonts and assets; supplies
deterministic fixtures; maps meaningful controls to real props or tokens; builds
and checks browser fidelity; then reports resources, evidence and limits.
Server-coupled views may need a browser-renderable extraction. Runtime CSS
injection and large bundles need measured compatibility evidence.

Copy `assets/controls.ts` and `assets/preview.ts` together into the generated
workspace. `createPreview(definition, render)` returns a validated controller;
explicitly call `reset()` for initial baseline rendering. `apply()` accepts a
complete snapshot and serializes renderer calls. Current controls support numbers
with units/bounds/steps and six-digit hex colours. The helpers have no Chopin
runtime dependency, host UI, message transport or MCP publication schema.

## Run the illustrative example

```bash
bun run preview-toolkit:dev
```

Open <http://127.0.0.1:8810>. This command builds once with pinned Vite and then
serves static resources; the compiler exits before serving. The adjusted frame is
on port 8811 with `sandbox="allow-scripts"`. The source reference is
<http://127.0.0.1:8811/fixture-app/index.html>. After a successful build, serving
alone is available through:

```bash
bun e2e/app-preview-toolkit/server.ts --built
```

The separate illustrative Fieldwork app owns its billing card, child components,
Base UI popover, theme, local Inter font and bundled SVG. Source and preview import
the same view. The adapter maps spacing (baseline 24px) and accent (baseline
`#476b55`) to its real props. It changes rendered values rather than source files.

The host owns chosen values. Number/range controls stay synchronized; Reset
selects baseline; holding **Show current** temporarily renders baseline. Pointer
and keyboard release, cancellation, capture loss, blur and visibility loss restore
chosen values. Copy/Download values exports local JSON. Retry rebuilds and reloads
while retaining chosen values; four-second load/render timeouts surface failure.
The transport checks sender identity, origin, request order and frame attempt.

The local harness has fixed loopback ports and supports one illustrative component.
Opaque sandbox module/font requests need permissive resource CORS here. This is
local evidence, not a production security or hosting certification. See the
[example README](../e2e/app-preview-toolkit/README.md) for its entry points.

## Verified evidence

```bash
bun test skills/building-app-previews/assets
bun run preview-toolkit:test
bun run types
bun run ci
```

The dedicated Chromium suite runs wide and 390px narrow projects separately from
PostgreSQL integration, using fresh servers. Source-vs-embedded screenshots use
the same component viewport after font readiness and passed with zero differing
pixels above Playwright's 0.1 perceptual threshold. Checks cover actual children,
SVG/font resources, Base UI portal, controls, comparison exits, JSON exports,
invalid values, stale/foreign replies, sandbox restrictions and exact resources.
All 12 cases passed with zero unexpected browser errors, failed resources, bad
HTTP responses or off-origin requests. The capture-loss/cancellation assertions
also passed in both layouts while the pointer remained held.

Actual React 19 style and later portal commit failures are visible and preserve
chosen values. Both `onUncaughtError` and `onRecoverableError` are handled; the
latter can report wrapper #520 with the original `Error.cause`. Callback completion
is not a paint guarantee. Retry checks wait for the replacement frame's different
attempt URL and fresh resources before asserting the component. An observed old
DOM false positive led to that readiness correction.

The build writes `.built/resources.json` with an exact resource list and SHA-256
checksums, excluding itself. Generated builds, screenshots and traces remain
ignored. Reports also record source commit/dirty state, component/token references,
control units/baseline, commands, browser evidence and limitations.

## Independent authoring trial

A fresh coding agent received the whole installed skill and only the
[raw UsageCard app](../e2e/app-preview-toolkit/trial-source/), with its own theme,
deterministic usage and required Units provider. Its disposable source commit was
`a99336844fac22f24723b687514b80eab66b9641` on `master`, with no remote and a clean
initial state. The agent prepared a separate preview in ignored `.preview/`;
all five app files stayed unchanged and both copied helpers were byte-identical.

Agent types, build, nine helper tests and browser/resource checks passed. The parent
independently checked the actual source imports and Chromium output at host widths
1008px and 360px: source and preview baseline PNG bytes matched, Units context
rendered `requests`, and controls produced real meter height 19px and accent
`#ab4e39`. Space comparison restored chosen values; Reset returned to 8px. All 11
built resource paths and served SHA-256 checksums matched. Both inspected layouts
had no horizontal overflow, and there were zero unexpected browser errors.

The agent additionally checked invalid snapshots, local exports and an actual
missing-provider render failure. Retry observed a fresh frame attempt and resource
loads before verifying retained 16px / `#c05a38`. Review found that mouse-up could
mask the trial's earlier
cancellation, capture-loss, blur and visibility assertions. Corrected Chromium
checks passed with chosen styles, snapshot and comparison state asserted while
the pointer remained held, before cleanup; real focus loss was checked before
release too. That evidence correction informed the skill's reporting guidance.
No UI failure was observed.

The retained local trial workspace is `/private/tmp/chopin-preview-skill-trial`.
Its generated adapter, scripts and screenshots are evidence artifacts, excluded
from this repository. These commands apply to that workspace:

```bash
bun run types
bunx vite build --config .preview/vite.config.ts
bunx vite preview --config .preview/vite.config.ts --host 127.0.0.1 --port 8821 --strictPort
# With the built server running, in another terminal:
bun .preview/browser-check.ts
bun .preview/check-resources.ts
bun test ./.agents/skills/building-app-previews/assets/controls.test.ts ./.agents/skills/building-app-previews/assets/preview.test.ts
```

Trial frames were same-origin on loopback; this adds authoring/fidelity evidence,
not isolation certification. Some cancellation/visibility checks used injected
events. The source uses platform fonts and no portals or image assets; those
requirements are covered by the separate Billing example. No MCP preview contract
was supplied and no publication occurred.

## Delivery boundary

Current supplied MCP initialization instructions and tool/resource descriptors
are authoritative for any authorized pickup or publication. This toolkit invents
no tool, transport envelope, chart API or executable document JSX. Without a
preview delivery contract, return local resources and report integration absent.

The local example adds no production user flow, shared draft, durable Save, MCP
publication or private artifact hosting. Credential-free isolation, private
artifact access/retention, trustworthy delivery, the production bridge and
attributed Save remain integration work. Preparing a report or exporting values
does not approve a decision.

See the [implementation plan](superpowers/plans/2026-10-08-app-preview-toolkit.md).
