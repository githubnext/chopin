---
name: Chopin
description: A calm shared workspace for repository-connected documents.
colors:
  petrol: "oklch(0.50006 0.08514 210.06)"
  petrol-hover: "oklch(0.42914 0.07315 210.634)"
  petrol-active: "oklch(0.37546 0.06382 210.435)"
  page: "oklch(1 0 0)"
  ground: "oklch(0.96623 0.0039 95)"
  inset: "oklch(0.97857 0.00264 95)"
  selected: "oklch(0.94216 0.00393 95)"
  ink: "oklch(0.15908 0.00637 95)"
  secondary-ink: "oklch(0.39036 0.01026 95)"
  tertiary-ink: "oklch(0.48124 0.01278 95)"
  destructive: "oklch(0.60513 0.17178 24.175)"
  success: "oklch(0.51958 0.10966 145.072)"
  warning: "oklch(0.59898 0.12586 74.986)"
  chat-divider: "rgb(0 0 0 / 9%)"
typography:
  document-title:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "var(--text-2xl)"
    fontWeight: 600
    lineHeight: 1.15
  section-heading:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "var(--text-xl)"
    fontWeight: 600
    lineHeight: 1.25
  subheading:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "var(--text-lg)"
    fontWeight: 600
    lineHeight: 1.4
  document-body:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "var(--text-base)"
    fontWeight: 400
    lineHeight: 1.6
  chrome:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "var(--text-sm)"
    fontWeight: 400
    lineHeight: 1.5
  compact:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "var(--text-xs)"
    fontWeight: 400
    lineHeight: 1.35
  small-metadata:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "var(--text-2xs)"
    fontWeight: 400
    lineHeight: 1.35
rounded:
  sm: "0.25rem"
  md: "0.375rem"
  lg: "0.5rem"
  xl: "0.625rem"
  full: "9999px"
spacing:
  half: "0.125rem"
  base: "0.25rem"
  one-and-half: "0.375rem"
  two: "0.5rem"
  three: "0.75rem"
  four: "1rem"
  six: "1.5rem"
  eight: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.petrol}"
    textColor: "{colors.page}"
    rounded: "{rounded.md}"
    height: "2rem"
    padding: "0 0.75rem"
  button-secondary:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "2rem"
    padding: "0 0.75rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.secondary-ink}"
    rounded: "{rounded.md}"
    height: "2rem"
    padding: "0 0.75rem"
  field:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  document:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
  navigation-current:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
---

# Design System: Chopin

## Overview

**Creative North Star: "A Working Document"**

Chopin feels calm, precise, and collaborative. The authored document is the visual center; navigation, conversation, and controls support the work without competing with it. The interface is compact enough for sustained use and gives long-form prose room to breathe.

**Key Characteristics:**

- A white document surface sits on a warm olive ground.
- Petrol marks actions, links, focus, and presence; semantic colors identify outcomes.
- Controls are quiet, legible, and purposeful. Depth gives layers subtle separation.

The implementation is the authority for values: `../../packages/visuals/theme.css` owns shared tokens, while `src/theme.css`, `src/navigation.css`, and `../../packages/editor/src/styles.css` apply them. The frontmatter records the most reused values; it is not a replacement for those source files. `scripts/check-design-record.ts` compares the structured subset against the shared theme, including explicit aliases. Two contextual values are checked against their owning selectors: Chat's divider in `.workspace-frame .workspace-chat-panel`, and prose leading in `.plan .plan-content`. Prose leading is deliberately 1.6 while the paired base UI token remains 1.5. The sidecar's color values, shadows, and motion entries are checked too; generated dates and illustrative tonal ramps do not establish authority. See [the design contract guide](../../docs/design-contract.md) for the exact scope and change workflow.

## Colors

### Primary

- **Petrol** is the single interaction accent for primary actions, links, focus, and presence. Its darker states respond to hover and press.

### Neutral

- **White page** carries the authored document and raised controls.
- **Warm olive ground** frames the workspace. Lighter inset and selected roles separate nearby surfaces without adding another accent.
- **Ink** has primary, secondary, tertiary, and quaternary text roles; use the role that preserves the intended hierarchy and legibility.

Success, warning, and destructive colors communicate state. Their full surface, graphic, icon, and text pairs remain defined in the shared theme.

The original destructive button red is an intentional visual exception: white text on its default state measures about 4.20:1, below the usual 4.5:1 AA target. Keep this red for its aesthetic character. The hover and pressed colors remain distinct and above 4.5:1.

**The Contrast Hierarchy Rule.** Prefer AA contrast for primary content and controls, but do not treat it as a universal requirement for every text role. Preserve the approved visual hierarchy: timestamps and secondary conversation metadata use their original quiet roles; supplementary audit-page labels (source paths, specimen state, usage notes, type-scale metadata, icon names and section summaries) keep their original quaternary role; queued messages and loading/tool status keep their original muted roles and opacity; code and diff previews retain the original pierre-light palette and selection treatment. These are deliberate visual exceptions, alongside the original destructive button red. Do not darken these roles automatically to satisfy a contrast audit. Record measured findings honestly and keep exceptions scoped to the approved roles and states; new exceptions require a deliberate design decision. Token use, the fluid type scale, keyboard access, focus, and layout checks remain enforced.

**The One Accent Rule.** New action and focus treatments use the established petrol roles. New raw color values require a change to the shared theme, not a local copy.

## Typography

Inter Variable is used for interface text and document prose. The mono stack is reserved for code and technical content. The shared theme defines a fluid modular scale across 360–1440px viewports. Its base is 15–16px and its ratio grows from 1.12 to 1.14. Each role uses `base × ratio^step` at each endpoint and a CSS `clamp()` between them. The seven named roles are small metadata `--text-2xs` (step −2.5, 11.3–11.5px), compact `--text-xs` (step −2, 12–12.3px), common interface `--text-sm` (step −1, 13.4–14px), document body `--text-base` (step 0, 15–16px), subheading `--text-lg` (step +2), section heading `--text-xl` (step +4), and title `--text-2xl` (step +7, 33.2–40px). The editor gives prose looser leading than the paired UI token and forwards the fluid tokens through MDXEditor's fixed variable scope.

**The Fluid Type Rule.** Use a named text utility or `--text-*` token for every font size. The CI type-scale check rejects raw CSS font sizes, arbitrary Tailwind font sizes, and literal inline font sizes. Add a role in the shared theme and update its modular-scale test when the existing roles cannot serve the need. Inline code inherits the size of surrounding prose or a heading.

## Interface copy

Keep labels and tooltips concise and in sentence case. Capitalize the first word
and proper names; preserve handles and keyboard shortcuts as written. Use helper
text only when people need it to act or recover.

## Layout

The workspace places the document beside conversation when space permits. The Projects sidebar slides over the document without resizing it; on narrower screens, panels take their own view. The document uses a maximum prose measure of 43.75rem and a 4rem gutter that contracts to 1rem in a narrow document container. Wide authored content such as tables and code keeps its own scroll lane.

Spacing starts from a 4px unit and uses the measured steps shown in the frontmatter. App chrome is dense; prose has larger margins and trailing space so the caret remains comfortable near the end of a document. Layout responds to both viewport and document container width. Safe-area insets and larger coarse-pointer targets are accounted for in the web styles.

## Elevation & Depth

The system is mostly flat. Tonal separation and passive edges distinguish adjacent panes; subtle resting, raised, and overlay shadows distinguish surfaces that actually sit above others. In the split workspace, the frame owns elevation and its internal document pane does not add a second shadow.

## Shapes

Rectangular controls use a restrained four-step radius scale: small for grips and toolbar cells, medium for buttons and fields, large for popovers, and extra large for the document page. Badges and radio controls use the full radius. Passive structure uses a light edge; interactive fields use the stronger control edge. The Chat pane has its own quiet divider color.

## Components

- **Buttons:** Primary, secondary, outline, ghost, and destructive tiers (outline is a white button with the control edge, for a quiet single action inside a card) share one shape and compact text treatment. Medium buttons are 2rem high; small buttons are 1.5rem. Hover and pressed states change the relevant color role. Keyboard focus shows the brand focus ring; a pointer press hides it on buttons and menus, while text fields keep theirs.
- **Recovery actions:** Use `btn-outline-danger` on danger surfaces and `icon-danger` for error indicators. Hover and pressed states stay within the danger palette.
- **Fields and selections:** White fields use the medium radius, control edge, and subtle resting shadow. Invalid fields use the destructive role. Disabled controls use neutral fill and muted text.
- **Navigation:** The current location uses a white surface and primary ink. Other items stay quieter and reveal their affordance on hover or focus.
- **Badges and status graphics:** Neutral, success, warning, and danger use paired semantic surface, icon, graphic, and text roles. A badge combines an icon and label in a pill.
- **Document:** The authored page is white, readable, and wider only where content requires it. Headings, lists, tables, code, and callouts retain document semantics inside the editor.

## Do's and Don'ts

### Do:

- **Do** use shared color, type, radius, spacing, shadow, and motion tokens when extending the interface.
- **Do** use the established semantic color pairs for status and feedback.
- **Do** keep the focus ring keyboard-only for buttons and menus, and always visible on text fields.
- **Do** check new controls in the development design audit alongside their default, focus, disabled, and error states.

### Don't:

- **Don't** introduce a raw color, font size, or radius in a component when an established token serves that role.
- **Don't** create a second local definition of a shared token or shadow treatment.
