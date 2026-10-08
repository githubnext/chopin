# Local agent app-preview toolkit

This is the agreed direction for a small toolkit PR. The toolkit is not implemented
yet. The first deliverable is a local working example of an agent preparing an
adjustable preview from an app's actual component source.

## Purpose

Give a local coding agent instructions and tested helpers for isolating a real app
component, preserving its design system, and exposing a few useful design choices.
Chopin will own the surrounding controls, collaboration and decision records. The
coding agent owns the preview component and its parameter adapter.

Krzysztof owns the MCP request, pickup and result/resource delivery contract. This
PR provides inputs to that work, not another publication API. Current MCP
instructions and tool descriptions remain authoritative when integration becomes
available. The toolkit must not invent tool calls or insert executable document MDX.

## First example

Use a clearly labelled illustrative billing app because a separate user repository
has not been selected. Its billing card has child components, a Base UI popover,
an app-owned theme, a local font and a bundled asset. It imports no Chopin UI or
design tokens. The source-app view and preview import the same component.

Expose two adjustments: card spacing and accent colour. The adapter maps them to
the app's props or CSS custom properties. Preserve their meanings, units, baseline
and design-system constraints. Sliders change the preview, not the source files.

The local demonstration shows one adjusted preview, a wide/narrow inspector and
press-and-hold baseline comparison. Its export action says **Copy values** or
**Download values**. It does not claim to save a Chopin decision. Temporary local
jigs and Dial Kit are not part of the toolkit or PR.

## What the agent receives

- A provider-neutral `building-app-previews` skill in the repository's canonical
  `skills/` directory, with its normal `.agents/skills/` symlink.
- Copyable, framework-neutral TypeScript helpers for control definitions,
  parameter validation and applying complete snapshots to a render callback.
- Focused references for React integration, capability boundaries and useful
  evidence. Instructions defer to the target repository's own guidance and design
  system rather than restyling it to match Chopin.
- A runnable separate-app example and browser evidence in the PR. The installed
  skill remains understandable without access to this repository's test harness.

Helpers have no runtime dependency on a Chopin workspace package. Their authoring
API is local; it is not an MCP request or result schema. The demonstration transport
is confined to the test harness and replaced at integration time.

## Preview and report boundaries

Reuse the actual browser-renderable component, dependencies, children, CSS, fonts,
assets and providers. Supply deterministic fixture data. Replace business effects
and service calls; retain UI behaviour such as opening a popover.

Server-only or tightly coupled components need an adapter or extracted view.
Missing dependencies, context or fidelity must be reported rather than disguised
with an imitation. Static styles are the initial compatibility target. Runtime
style injection, bundle size, font embedding and portals need explicit evidence;
the earlier Chopin specimen did not establish universal compatibility.

The local output includes built resources, exact-byte checksums, control meanings
and baseline, component/source references, screenshots, reproducible commands and
limitations. Record the source commit and whether relevant files are uncommitted.
These are authoring facts to map into the engineer's contract, not a competing
transport envelope. Reports distinguish measurements from interpretations and
remaining choices; preparing a report does not approve a decision.

Charts and experiment reports follow later. Internal React primitives are not
automatically document capabilities: advertise only supported outputs from the
current contract, and report unavailable capabilities explicitly.

## Evidence required for the PR

- The embedded baseline matches the source-app component at the same viewport.
- Both controls update the component; Reset and pointer/keyboard baseline peek
  restore the correct values without rewriting source files.
- Child components, a portalled child, local fonts/assets and narrow layout work.
- Invalid parameters are refused before reaching the render callback; rendering
  failures are visible and allow a retry with the last requested values.
- The built preview works after its development server is stopped. Browser checks
  report unexpected network calls, console errors and missing resources.
- A fresh coding agent uses the installed skill to prepare a second preview from
  supplied app source. Its actual output is reviewed, not just the skill's prose.
- Unit tests, TypeScript, formatting/lint/token checks and dedicated browser tests
  pass. Browser CI runs the toolkit suite separately from PostgreSQL integration.

The PR includes real UI screenshots and a diagram showing the agent, preview
resources and future Chopin integration. It states that no production user flow,
shared draft, durable Save, MCP publication or private artifact hosting is added.

## Production integration remains separate

The local harness is not a production hosting or security certification. Generated
preview code stays outside document evaluation. A credential-free isolated preview
site, private artifact access/retention, trustworthy delivery, the production bridge
and attributed Save remain integration work. Do not deploy or merge as part of this
toolkit exercise.

See the [implementation plan](superpowers/plans/2026-10-08-app-preview-toolkit.md).
