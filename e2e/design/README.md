# Rendered design checks

`bun run design:browser` builds and runs a disposable Linux amd64 container with
Bun 1.4.4 and a digest-pinned Playwright 1.62.1 Noble image. It installs from the
frozen lockfile, starts the real `/design-audit` development route and runs Chromium.
Docker is required. No database, GitHub login, API key, host port or paid agent is used.
This is an optional visual review command. Screenshot differences and exact
contrast-report baselines do not block PRs while Chopin's interface is evolving.

The required **e2e** CI job instead runs `bun run design:behavior` with its already
installed Chromium, without building a design container. This runs 36 checks across
both widths for keyboard navigation, focus, form errors, reduced motion, text
reflow, usable scrolling and the geometry of copied assistant-ui elements (their
pixels against their own Tailwind classes, under a fine and a forced coarse pointer;
see [Adding an assistant-ui element](../../docs/assistant-ui.md)). It performs no
screenshot comparisons or axe scans.
Static token and design-record checks remain required through `bun run ci`.

For local behaviour checks, run `bun run design:behavior`. `bun run design:test`
includes visual comparisons using your installed Chromium
and Vite on port 5422 (`DESIGN_PORT=5423` changes it). It refuses to reuse an existing
server. Host screenshots and contrast detection are **not** canonical baselines; use the Linux command for
visual comparisons and updates.

## Coverage

[`coverage.ts`](coverage.ts) is the explicit manifest. Eight specimen plates (with the button plate split into five short rows) are
captured at 1440 × 1000 and 390 × 844, plus the open menu, disabled/error modal, and
open Select: 33 small screenshots. Capture bounds fail if content would be clipped. Tests scan each captured state with axe after it
is rendered, and attach the full JSON report including incomplete/manual-review
results. Keyboard assertions cover arrow navigation, Escape, initial focus, modal
Tab wrapping, Select selection and focus restoration. Responsive checks cover
200% root text size, an intentionally scrollable table, and keyboard access to code previews. Reduced-motion tests
check that menu/modal animations have settled.

The static editor, callouts, code previews, Transcript, Select, document action
menu and modal shell are production components. Controls use production classes.
The composer and table toolbar/selection examples are illustrative markup, not
coverage of production editing behavior. This suite does not replace authenticated
system E2E, screen-reader testing, manual contrast review, or usability testing.

## Reviewing baselines

1. Run `bun run design:browser`. Open `e2e/playwright-report/design/index.html`
   to inspect expected, actual and diff images plus axe attachments.
2. Establish why the change is intentional against `apps/web/DESIGN.md` and the
   shared theme. Fix defects before updating references.
3. Run `bun run design:browser --update-snapshots`, optionally with `--grep` and
   `--project` to constrain the change.
4. Visually inspect **every** changed PNG in `snapshots`, at both widths. Commit
   only explained images. Never update images merely
   because CI is red.
5. Run `bun run design:browser` again without update flags to verify repeatability.

Screenshots wait for locally served Inter, use a fixed locale/timezone and fixture
content, and replace external avatars with a deterministic image. Animation is
disabled only for capture; reduced-motion behavior is separately asserted. There
are no screenshot masks or allowed pixel-count differences. The 0.1 color threshold
handles minute per-pixel raster noise; the exact container keeps rendering stable.

Behaviour failures in the required e2e job publish the HTML report, diagnostic
screenshots and traces through its existing seven-day `playwright-report` artifact.
Optional visual runs write their expected/actual/diff PNGs and axe JSON locally to
`e2e/test-results/design` and `e2e/playwright-report/design`.
The route's development guard is also checked against production JS/CSS output by
`scripts/check-design-production.ts` after the system suite builds the client.

The optional visual suite runs 38 interface checks across the two viewport sizes. Each accessibility scan must find nothing.

## Contrast

Chopin meets WCAG 2.2 AA everywhere, in light and dark (the Contrast Rule in `apps/web/DESIGN.md`, decided on 11 November 2026; until then the Delete red, quiet timestamps and metadata, loading and tool status, the pierre-light code palette and the audit-page labels were recorded exceptions).

[`contrast.e2e.ts`](contrast.e2e.ts), part of `bun run design:behavior`, holds it. [`contrast.ts`](contrast.ts) walks every visible text node, generated text and placeholder, and every icon in a control, status icon, field, composer and checkbox edge, status dot and focus ring (each control focused as a keyboard would), and measures each against the colour actually composited behind it: the ancestors' backgrounds and every group's opacity, through shadow roots. It fails any pair below 4.5:1 for text, 3:1 for large text and non-text parts, except disabled controls. Dark is the system's dark preference with the `.dark` class the copies read; Chopin draws it as light.

The optional visual suite's axe scans expect no findings: there are no approved contrast records any more.
