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
  merged: "oklch(0.47500 0.17500 301)"
  chat-divider: "rgb(0 0 0 / 9%)"
typography:
  document-title:
    fontFamily: '"Lora", Georgia, serif'
    fontSize: "var(--text-2xl)"
    fontWeight: 400
    lineHeight: 1.15
  section-heading:
    fontFamily: '"Lora", Georgia, serif'
    fontSize: "var(--text-xl)"
    fontWeight: 400
    lineHeight: 1.25
  subheading:
    fontFamily: '"Lora", Georgia, serif'
    fontSize: "var(--text-lg)"
    fontWeight: 400
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

The implementation is the authority for values: `../../packages/visuals/theme.css` owns shared tokens, while `src/theme.css`, `src/navigation.css`, and `../../packages/editor/src/styles.css` apply them. The frontmatter records the most reused values; it is not a replacement for those source files. `scripts/check-design-record.ts` compares the structured subset against the shared theme, including explicit aliases. Two component bindings to shared tokens are checked against their owning selectors: Chat's divider in `.workspace-frame .workspace-chat-panel`, and prose leading in `.plan .plan-content`. Their shared owners are `--color-divider` and `--document-line-height`. Document leading is deliberately 1.6 while the paired base UI token remains 1.5. The sidecar's color values, shadows, and motion entries are checked too; generated dates and illustrative tonal ramps do not establish authority. See [the design contract guide](../../docs/design-contract.md) for the exact scope and change workflow.

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

Inter Variable is used for interface text and document prose. Document headings H1–H3 use Lora at weight 400 through `--font-document-heading`. H4 uses Inter at weight 700 and keeps the body-size token. The mono stack is reserved for code and technical content. The shared theme defines a fluid modular scale across 360–1440px viewports. Its base is 15–16px and its ratio grows from 1.12 to 1.14. Each role uses `base × ratio^step` at each endpoint and a CSS `clamp()` between them. The seven named roles are small metadata `--text-2xs` (step −2.5, 11.3–11.5px), compact `--text-xs` (step −2, 12–12.3px), common interface `--text-sm` (step −1, 13.4–14px), document body `--text-base` (step 0, 15–16px), subheading `--text-lg` (step +2), section heading `--text-xl` (step +3, 21.1–23.7px), and title `--text-2xl` (step +5, 26.4–30.8px). The editor gives prose looser leading than the paired UI token and forwards the fluid tokens through MDXEditor's fixed variable scope.

**The Fluid Type Rule.** Use a named text utility or `--text-*` token for every font size. The CI type-scale check rejects raw CSS font sizes, arbitrary Tailwind font sizes, and literal inline font sizes. Add a role in the shared theme and update its modular-scale test when the existing roles cannot serve the need. Inline code inherits the size of surrounding prose or a heading.

## Interface copy

Keep labels and tooltips concise and in sentence case. Capitalize the first word
and proper names; preserve handles and keyboard shortcuts as written. Use helper
text only when people need it to act or recover.

## Layout

The workspace places Chat on the left and the document on the right when space permits. Chat sits directly on the ground with no bar of its own; the document is a raised sheet that rises to the top margin and carries two 40px bars. The title bar holds the expand control, the project and title with rename and the document actions menu, then status and presence, separated by full-height dividers. The views bar below it holds Document, Decisions, and Build on the paper, with no rule beneath. Expanding the document only widens the sheet: Chat collapses, the title stays, and a Chat button in the same place restores it. As the sheet narrows, the title truncates first, then status labels fold to glyphs, then presence keeps one face and a count. A child document zooms in place of its root: the title bar shows Back, the root as a crumb, and the child's own title and actions, and the views fold away because a child has none. Compact layouts and phones show the path in a slim stack bar instead. Document, Decisions, and Build switch the main pane; Build is available on parent documents. Tabs never trigger actions: Build stays off until the plan is built, and only the header's **Build plan** starts a build. Build plan sits left of the people here, inert with its reason in a tooltip until it can run. Open decisions and required investigations replace it with a coloured capsule showing how many remain. Hover or click reveals their titles; each whole row opens its specific card, with one hover surface and a decorative arrow. After the press the same slot becomes a quiet capsule (glyph and words such as _Building · 3 of 8_, _Built_, _3 changes to build_) that opens Build, with at most one small outline action (_Retry_, _Build_). One shared glyph (progress ring, status dot, clock or warning) appears identically in the capsule and on the Build tab; hovering either lights the other, and on the first press the glyph travels to the tab unless reduced motion is on. On a phone the capsule keeps only its glyph and Build's headline carries the words. Local investigation proposals, approval controls, and results appear in the document flow. The Projects sidebar slides over the document without resizing it; on narrower screens, panels take their own view. The document uses a maximum prose measure of 40.625rem (650px), with 3.75rem (60px) of top padding and at least 3.5rem (56px) of padding on each side. At browser widths of 600px or less, the horizontal padding becomes 1.5rem (24px). On a phone (a primary touch pointer with a width of 600px or less, or a height of 500px or less, so landscape phones count), the workspace drops its card and the raised sheet: panes run full-bleed with the same 1.5rem (24px) gutters, so margin comment markers keep their lane, under a translucent top bar that tucks away while reading down, above a floating bottom tab bar in the thumb zone. Landscape phones use a shorter top bar and a one-line tab bar. Destinations slide sideways in tab order, and crossfade under reduced motion. Images and diagrams can extend beyond the prose measure within those gutters; a table wider than the measure grows evenly about the column's centre, up to 1.5 times the prose measure (60.9375rem, about 975px) or the gutters, whichever is narrower, and scrolls in its own lane beyond that. On a phone (a coarse pointer on a small screen), when the document is narrower than 40rem, a wide table fades whichever side still hides columns, code wraps with a hanging indent instead of scrolling, and a Mermaid diagram below its readability floor offers Expand diagram under its scroll lane, which opens it in a full-screen sheet at its authored size. A narrow document alone does not trigger these: narrow desktop windows keep the scroll lanes.

Spacing starts from a 4px unit and uses the measured steps shown in the frontmatter. App chrome is dense; prose has larger margins and trailing space so the caret remains comfortable near the end of a document. Layout responds to both viewport and document container width. Safe-area insets and larger coarse-pointer targets are accounted for in the web styles.

## Elevation & Depth

The system is mostly flat. Tonal separation and passive edges distinguish adjacent panes; subtle resting, raised, and overlay shadows distinguish surfaces that actually sit above others. In the split workspace the document panel is the only raised sheet; Chat has no surface of its own. The composer on the ground uses the inset surface without a shadow.

## Shapes

Rectangular controls use a restrained four-step radius scale: small for grips and toolbar cells, medium for buttons and fields, large for popovers, and extra large for the document page. Badges and radio controls use the full radius. Passive structure uses a light edge; interactive fields use the stronger control edge. The Chat pane has its own quiet divider color.

## Components

- **Buttons:** Primary, secondary, outline, ghost, and destructive tiers (outline is a white button with a quiet 12% edge, for a single action inside a card) share one shape and compact text treatment. Resting outlines use at most 15% opacity, including primary and danger treatments; secondary buttons keep the lighter 7% passive edge. Medium buttons are 2rem high; small buttons are 1.5rem. Hover and pressed states change the relevant color role. Keyboard focus shows the brand focus ring; a pointer press hides it on buttons and menus, leaves the clicked Chat composer only its quiet brand edge, and other text fields keep theirs.
- **Recovery actions:** Use `btn-outline-danger` on danger surfaces and `icon-danger` for error indicators. Hover and pressed states stay within the danger palette.
- **Fields and selections:** White fields use the medium radius, control edge, and subtle resting shadow. Invalid fields use the destructive role. Disabled controls use neutral fill and muted text.
- **Navigation:** The current location uses a white surface and primary ink. Other items stay quieter and reveal their affordance on hover or focus.
- **Sidebar icons:** Icons normally use 14px glyphs. Compact Search, disclosure, add-project, project document-creation, and document-action controls use 12px glyphs while retaining 24px icon-button targets.
- **Badges and status graphics:** Neutral, success, warning, and danger use paired semantic surface, icon, graphic, and text roles. A badge combines an icon and label in a pill. Merged (plum) is the fifth quad, reserved for finished GitHub work: a merged pull request or a completed issue, as GitHub colours them.
- **GitHub reference pills:** A pull request or issue link in a document is a tinted capsule over the link itself: the state surface mixed half with the page, a hairline at 12% of the state icon colour, a 14px state glyph, the authored title in primary ink and a never-truncated `#number` in tertiary ink. Open is success, merged and completed are merged, closed is danger, and draft, not planned, loading and no access stay neutral.
- **Document:** The authored page is white, readable, and wider only where content requires it. Headings, lists, tables, code, and callouts retain document semantics inside the editor.
- **Document images:** Click opens a full-screen preview with zoom and close controls. Hover or keyboard focus reveals metadata editing and corner resize handles. Resizing preserves the image ratio, shares the chosen width with collaborators, and remains bounded by the document or column on narrow screens.
- **Decision decks:** Adjacent decisions stack as a deck. The top card is live; up to four cards behind it show as blank, inert edges, each nearer one showing more of itself. A capsule pager under the stack (previous, the top card's place, next) and Left and Right arrows page through the deck and stop at either end. Next drops the top card a short way as it fades and the card behind rises into its place with its content fading in; previous slides it back. Answered decisions settle to the back and keep an open card's full layout, with the chosen option selected. Moves animate transform and opacity, plus a clip and the leaving card's height so a taller card never covers the pager. Reduced motion crossfades without movement. Deck order is each reader's own.
  On desktop, Decisions shows open decisions as the same deck when two or more wait, with resolved decisions listed below; phones keep the single-pane list and save bar. A blank document whose Planner asks decisions opens Decisions once per visit, unless the reader is editing the document.
- **Unfold:** `UnfoldSection` uses Base UI Accordion for plain disclosure; card previews use the shared Unfold primitives. Both use the Chevron icon from the icon system. Native `details` and `summary` elements are not used. A button with `aria-expanded` and `aria-controls` folds a mounted panel open through its grid row while the content fades and tips down from its top edge, with the shared ease-out: card previews take the linger duration, plain accordions the accordion duration. A second press reverses from the current frame. Closed content is inert and hidden once the fold ends. Reduced motion snaps the height and keeps a short crossfade. A card preview never replaces the card's own open action.

## Do's and Don'ts

### Do:

- **Do** use shared color, type, radius, spacing, shadow, and motion tokens when extending the interface.
- **Do** use the established semantic color pairs for status and feedback.
- **Do** keep the focus ring keyboard-only for buttons, menus, and the Chat composer (a click leaves it a quiet brand edge), and always visible on other text fields. Give a ring room to draw: clip only the axis that must clip.
- **Do** slide the inline Projects sidebar and split Chat the same way for their shortcuts as for a click, so the space a pane takes or gives back is always visible; reduced motion and a layout change settle them at once. Other keyboard-driven changes (the Projects drawer, menus, dialogs, document views, compact panes, and count or icon feedback) still settle immediately.
- **Do** check new controls in the development design audit alongside their default, focus, disabled, and error states.

### Don't:

- **Don't** introduce a raw color, font size, or radius in a component when an established token serves that role.
- **Don't** create a second local definition of a shared token or shadow treatment.

## Shared component recipes

Important visual dimensions and colors belong to the shared theme. Use finite component variants for density, size, typography and state; avoid selector overrides that reach into another component or anonymous child. Browser geometry remains measured at runtime.

- `Count` owns quiet, actionable and control appearances. Quiet sidebar counts use `--color-count-quiet` (gray-50); selected control counts use the page surface. Control counts use an 18px minimum square and allow wider values without clipping. Counted buttons use the shared 4px control inset.
- `IconButton` owns normal and compact sizes, default and compact glyphs, and ghost or nested hover surfaces. Compact sidebar buttons are 24px with a 12px glyph; the common icon catalog also includes micro, default and larger roles. Coarse pointer targets use `--control-target-coarse`.
- `MenuItem` owns normal and compact density, with shared height, padding and gap tokens. Destructive text and icons inherit the same semantic ink. `MenuSeparator` owns the divider spacing.
- `EmptyState` owns circular tinted icon frames, title and description type roles, copy measure, icon gap and optional framed presentation. Decisions and Chat use its compact density.
- Document measure, gutters, top inset, leading and decision marker size are shared document roles. Marker positioning measures the rendered disc, so token changes cannot desynchronize the visual size and geometry.
- Panel headers and the document title split control use shared heights and insets. Breadcrumb text uses medium weight; the split label and compact action produce an 8px text-to-chevron gap. Project names in document breadcrumbs are plain text; document title and menu controls share a single hover surface.

SeeCode uses a fixed canvas typography catalog in `packages/diagrams/src/core/tokens.mjs`: node labels 14px, subtitles 12px, tags 10px and edge labels 12px. Measurement and SVG drawing variables derive from the same catalog, so changing type updates boxes and routing together. These are coordinate-system roles; interface controls retain the fluid UI scale. Architecture graphs may use a narrower derived layout, targeting the smaller of 1100px or the document lane, while preserving saved source, node identities, connections and playback. Fitting has a readability floor; dense diagrams keep native scrolling and zoom controls below the diagram.

`InlineNotice` reserves space in the page flow for recoverable failures, using the shared semantic surface, icon and text roles. Navigation retry controls align within it; notices never cover document content. Connection labels and recovery buttons use the same compact text role.
