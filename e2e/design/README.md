# Rendered design checks

`bun run design:browser` builds and runs a disposable Linux amd64 container with
Bun 1.4.2 and a digest-pinned Playwright 1.62.1 Noble image. It installs from the
frozen lockfile, starts the real `/design-audit` development route and runs Chromium.
Docker is required. No database, GitHub login, API key, host port or paid agent is used.
This is an optional visual review command. Screenshot differences and exact
contrast-report baselines do not block PRs while Chopin's interface is evolving.

The required **e2e** CI job instead runs `bun run design:behavior` with its already
installed Chromium, without building a design container. This runs 14 checks across
both widths for keyboard navigation, focus, form errors, reduced motion, text
reflow and usable scrolling. It performs no screenshot comparisons or axe scans.
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

The optional visual suite runs 38 interface checks across the two viewport sizes. Each accessibility scan compares the complete set of findings with the exact reviewed record, so additional or changed findings fail that optional command and removed findings require review.

## Approved colour decisions

On 29 September 2026, Maggie chose the original Delete red, quiet timestamps/tool metadata, muted queued/loading messages, original pierre-light code palette and supplementary audit-page labels. AA remains a preference, not a universal mandate. See `apps/web/DESIGN.md`.

`approved-contrast/` records each accepted node's named role and exact rule, selector, HTML and measured evidence at each width. There are 61 accepted nodes at each width; 47 at each width are audit-page source/state/type-scale labels. Linux detects seven approved syntax tokens at each width. A controlled three-scan comparison showed the macOS browser detects one fewer narrow token regardless of vertical positioning; use Linux for authoritative contrast verification. These counts describe findings in the tested states, not complete palette or application coverage.

Full axe reports retain the findings. Equality against the reviewed records rejects new nodes, other rules, changed markup/colour/size/ratio and stale entries. Menus, dialogs and Select still require zero violations. Do not broaden this decision or refresh these records automatically to make a failure pass. Screenshot update flags do not update contrast approvals.
