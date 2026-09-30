# Working with the design contract

Choose the existing role that describes the job: petrol for an action, a semantic
pair for status, a named type role for hierarchy, and a depth role for a raised
surface. Read [DESIGN.md](../apps/web/DESIGN.md) for the visual intent and
[the shared theme](../packages/visuals/theme.css) for exact values. A token's name
expresses why it exists; matching a number is not enough to choose it.

## Change a value deliberately

1. Look for a reusable role before adding a token. Geometry, chart coordinates,
   authored content, and isolated layout measurements do not each need a token.
2. Put a justified shared value in the theme. Preserve the fluid type scale,
   document title role, accepted 3px quote edge, and sidebar transform behaviour.
3. Update the corresponding structured values in DESIGN.md and its
   [Impeccable sidecar](../apps/web/.impeccable/design.json). Add a mapping and a
   failing drift test when extending the checked subset. Keep design reasoning
   in prose; the checker cannot judge whether a design choice is good.
4. Run `bun scripts/check-design-record.ts`, `bun scripts/check-design-contract.ts`, and
   `bun run ci`. Inspect the rendered component when changing appearance.

An exception needs an exact file, property, value, and explanation of why a shared
role cannot express it. The index in `scripts/design-contract/exceptions.json` links small manifests grouped by review responsibility. Each case is `[family, property, value, context, count]`; its group supplies the exact file and explanation. Reviewers can inspect the precise source boundary without a broad file ignore.
Dynamic groups also pin the reviewed owner file with SHA-256, so changes behind an unchanged spread or expression require data-flow review and an explicit hash renewal. This is a boundary review checksum, not evidence that documented token values are correct. Dynamic typography additionally requires an explicit list of producer files and their review hashes; the current specimen names its local finite TYPE table owner. An imported producer changing to a raw size fails even when the consuming expression stays unchanged. Other imported computations still need producer review. Never automatically refresh these review hashes in CI; sibling changes require a deliberate review and scoped manifest update.

The policy checks expected occurrence counts; removed or broadened uses must be
reviewed again. A local disable comment is not an exception: the detector runs with
`--no-inline-ignores`. Never add a broad ignore or create a one-use token just to
silence a finding.

## Contrast and visual hierarchy

AA contrast is preferred for primary content and controls, not required for every
text role. Maggie has approved the original lighter timestamps and secondary chat
metadata, muted queued/loading and tool-status text, original pierre-light code
and diff colours, supplementary audit-page labels in their quaternary role, and
original destructive red. Preserve those choices; do not
promote them to darker roles just to make a contrast audit pass.

Browser screenshot and contrast-report comparisons are optional review tools;
run `bun run design:browser` when reviewing appearance. Required CI retains token
checks and `bun run design:behavior` for keyboard, focus, motion and layout behaviour.
See [rendered design checks](../e2e/design/README.md).

Keep browser contrast findings visible. Optional visual tests may acknowledge only the approved
roles and states, with a reason and measured evidence. Unexpected findings and
changes outside that scope must still fail. Do not disable contrast checking for
an entire page or hide accepted findings behind a claim of universal AA compliance.
New exceptions need an explicit design decision. This policy does not relax token,
fluid typography, keyboard, focus, or layout enforcement.

## What the record check proves

The check parses YAML, JSON, and CSS. The theme owns token values; explicit
`var(--token)` references and documented `{colors.petrol}`-style aliases resolve
before comparison. Missing or unknown mapped fields, duplicate named entries,
unknown aliases, alias cycles, malformed sources, and genuine value conflicts
fail the check. Tailwind namespace resets are applied in source order.

| Record subset                                                     | Implementation owner                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Fourteen named colours, including sidecar `colorMeta.*.canonical` | Explicit semantic colour mapping in the theme; Chat divider is contextual below      |
| Five `rounded` entries                                            | `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-full`          |
| Six typography roles: size, complete font stack, line height      | `--text-*`, `--font-sans`, paired leading; document prose is contextual below        |
| Eight spacing steps                                               | Multiples of `--spacing`                                                             |
| Four sidecar shadow entries                                       | `--shadow-resting`, `--shadow-resting-strong`, `--shadow-raised`, `--shadow-overlay` |
| Seven sidecar motion entries                                      | Fast/base/linger duration, smooth-out/move curves, sidebar open/close duration       |

Two values intentionally belong to components. The divider is the `border-color`
in `.workspace-frame .workspace-chat-panel` in the
[web theme](../apps/web/src/theme.css). Prose leading is the `line-height` in
`.plan .plan-content` in the [editor styles](../packages/editor/src/styles.css).
The check requires each declaration exactly once. The document's 1.6 leading is
deliberately looser than the base UI token's 1.5.

Font weights are validated as numeric CSS weights, but are not compared to a
shared token: the current theme does not own weight roles. Component recipes,
illustrative tonal ramps, breakpoints, and narrative are outside this canonical
value comparison. Component aliases are still resolved so a broken reference
cannot hide there. Sidecar typography metadata must cover the same six roles.
Timestamps are metadata, never evidence that a value is correct.

The comparison normalises whitespace and font-name quotes, not arbitrary CSS
semantics. Prefer the canonical spelling or an explicit alias; it does not run a
browser to prove that two colour spaces, unit conversions, or calculations are
equivalent.

## Source coverage and dynamic values

The source scanner covers font size, font shorthand and family; colours including
border/outline shorthands and colour mixes; radii; shadows; and motion durations
and easing. It parses authored CSS and supported JavaScript/TSX style forms.
Literal `0`, `none`, inherited values, percentages used for circular geometry,
and token-based calculations are treated according to the property. `linear`
remains valid for intentional continuous motion. Spacing is audited without a
blanket ban on numeric layout dimensions. Dynamic expressions cannot
be assumed safe merely because a parser accepts them. Keep finite choices in
visible token-based branches. When a runtime value cannot be resolved, surface
it for review and give any necessary exception an exact scope and rationale.
Generated source, external styles, and runtime-computed values still need browser
review; passing the static checks does not prove every rendered state is correct.

The parser resolves local static bindings, branches, templates, object keys/spreads,
JSX style/presentation attributes, direct DOM style assignments, `setProperty`,
`cssText`, `Object.assign`, recognised stylesheet strings, HTML/SVG, `@apply`,
and Tailwind arbitrary/variant forms. Exported uppercase or class-named literal
producers and Lexical themes are checked separately from their consumers.
Imported function computation, arbitrary control flow, Web Animations API calls,
third-party CSS-in-JS protocols, and arbitrary runtime-generated HTML are not
interpreted. Known unresolved style/class sinks produce findings, including JSX
prop pass-throughs. The exact dynamic exceptions record these reviewed boundaries;
they do not prove arbitrary future values safe. Review producers and browser
behavior when changing such a boundary, and add a parser fixture before adopting
a new style API. Do not treat a JavaScript string elsewhere in the program as a
supported stylesheet container.

Typography weight and leading stay component-owned except for the documented
role checks. The scanner focuses typography enforcement on size, shorthand and
family. Numeric spacing and layout measurements remain permitted; audit their
intent in the real component. Standalone artwork palettes, fine caret geometry,
legacy mono stacks and bespoke repeat animations have explained counted cases.
Canonical token use alone does not establish contrast; verify foreground and
background pairs, opacity and rendered states separately.

## Impeccable setup health

CI uses the pinned repository CLI (`impeccable` 4.1.0). Its detector and
`--no-inline-ignores` behavior are exercised by tests. During this change, the
separate user-installed skill launcher (4.3.1) lacked engine 0.1.5 in its global
cache and could not load context. No global skills, cache or trust settings were
changed. An owner can repair that launcher by running its `engine-probe` with
its documented permissions; it is not a prerequisite for the repository checks.
