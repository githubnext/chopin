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

The document header has two approved fixed interface roles: `--text-document-control` (14px) for its view tabs and `--text-build-blocker` (13px) for the investigation pill. Build plan retains the common interface text. Its controls and tabs use 3px vertical and 8px horizontal padding; tabs have a 2px gap and 7px outer inset. The title bar remains 40px, with a 28px expand control, a 12px title inset after its divider, and equal expand and presence insets derived from the bar’s inner height, excluding its hairline. Blocker pills are 23px tall with 8px horizontal padding, a 14px icon and a 3px gap.

**The Fluid Type Rule.** Use a named text utility or `--text-*` token for every font size. The CI type-scale check rejects raw CSS font sizes, arbitrary Tailwind font sizes, and literal inline font sizes. Add a role in the shared theme and update its modular-scale test when the existing roles cannot serve the need. Inline code inherits the size of surrounding prose or a heading.

## Interface copy

Keep labels and tooltips concise and in sentence case. Capitalize the first word
and proper names; preserve handles and keyboard shortcuts as written. Use helper
text only when people need it to act or recover.

Never separate inline metadata with a middle dot or bullet. Separate the pieces
with layout (sibling elements with a gap, weight, tertiary color, or a line
break), or cut the metadata; `scripts/no-middot.test.ts` enforces this.

## Layout

The workspace places Chat on the left and the document on the right when space permits. Chat sits directly on the ground with no bar of its own; the document is a raised sheet that rises to the top margin and carries a 40px title bar above a compact views bar. The title bar holds the expand control, the project and title with rename and the document actions menu, then status and presence, separated by full-height dividers. The views bar below it holds Document, Decisions, and Build on the paper, with no rule beneath, and at its end a quiet History (clock) button. History slides in from the right under the title bar, over the views bar and the document, so nothing beneath reflows, and slides back out on close. Its title and close button stay put while the list scrolls under the shared scroll-edge fade. Each editing session is one line: face, who, a one-line summary of what it did (written by a small model when History opens and shown as a breathing skeleton until it arrives, or _made edits_ when no Planner can write it), and a terse age (_now_, _2m_, _3h_, _4d_, _2w_, then the date), with space between rows growing with the time between them. Lingering on a row for a moment shows the full line and the exact time just left of it. Contents needs no button: one quiet tick per heading sits in the document's right margin, the first level with the title, darker for the section being read. Hovering or focusing a tick peeks at that section beside it (its heading and opening lines, in a hairline card with a light shadow that follows the pointer down the ticks), and choosing one scrolls there. The ticks follow edits and an earlier version on show. Comment markers own the lane beside the prose, so the ticks appear only when the right margin can hold both, as on an expanded or wide sheet; History hides them while open. Choosing an earlier session replaces the document in place with a read-only copy, and the views bar gives its place to the version's own: Current (back to the live document), whose edits, the exact time, and for writers a small Restore. Restoring brings back that version's prose as a new edit by the person who pressed it, while decision, questionnaire and research blocks stay as they are now, since their records own them. The newest session is the live document. Expanding the document only widens the sheet: Chat collapses, the title stays, and a Chat button in the same place restores it. As the sheet narrows, the title truncates first, then status labels fold to glyphs, then presence keeps one face and a count. A child document zooms in place of its root: the title bar shows Back, the root as a crumb, and the child's own title and actions, and the views fold away because a child has none. Compact layouts and phones show the path in a slim stack bar instead. Document, Decisions, and Build switch the main pane; Build is available on parent documents. Tabs never trigger actions: Build stays off until the plan is built, and only the header's **Build plan** starts a build. Build plan sits left of the people here, inert with its reason in a tooltip until it can run. Required investigations replace it with a coloured capsule showing how many remain; open decisions never do, since Build goes ahead on the agent's best judgment and lists them as assumed. Hover or click reveals their titles; each whole row opens its specific card, with one hover surface and a decorative arrow. After the press the same slot becomes a quiet capsule (glyph and words such as _Building 3 of 8_, _Built_, _3 changes to build_) that opens Build, with at most one small outline action (_Retry_, _Build_). One shared glyph (progress ring, status dot, clock or warning) appears identically in the capsule and on the Build tab; hovering either lights the other, and on the first press the glyph travels to the tab unless reduced motion is on. On a phone the capsule keeps only its glyph and Build's headline carries the words. Local investigation proposals, approval controls, and results appear in the document flow. The Projects sidebar slides over the document without resizing it; on narrower screens, panels take their own view. The document uses a maximum prose measure of 40.625rem (650px), with 3.75rem (60px) of top padding and at least 3.5rem (56px) of padding on each side. At browser widths of 600px or less, the horizontal padding becomes 1.5rem (24px). On a phone (a primary touch pointer with a width of 600px or less, or a height of 500px or less, so landscape phones count), the workspace drops its card and the raised sheet: panes run full-bleed with the same 1.5rem (24px) gutters, so margin comment markers keep their lane, under a translucent top bar that tucks away while reading down, above a floating bottom tab bar in the thumb zone. Landscape phones use a shorter top bar and a one-line tab bar. Destinations slide sideways in tab order, and crossfade under reduced motion. Images and diagrams can extend beyond the prose measure within those gutters; a table wider than the measure grows evenly about the column's centre, up to 1.5 times the prose measure (60.9375rem, about 975px) or the gutters, whichever is narrower, and scrolls in its own lane beyond that. On a phone (a coarse pointer on a small screen), when the document is narrower than 40rem, a wide table fades whichever side still hides columns, code wraps with a hanging indent instead of scrolling, and a Mermaid diagram below its readability floor offers Expand diagram under its scroll lane, which opens it in a full-screen sheet at its authored size. A narrow document alone does not trigger these: narrow desktop windows keep the scroll lanes. Off a phone, a Mermaid diagram too wide to read at the frame's width opens at its start and offers Fit diagram to width under its scroll lane, which scales its whole shape to the frame until Actual size returns it, so the cut edge never reads as a crop.

Spacing starts from a 4px unit and uses the measured steps shown in the frontmatter. App chrome is dense; prose has larger margins and trailing space so the caret remains comfortable near the end of a document. Layout responds to both viewport and document container width. Safe-area insets and larger coarse-pointer targets are accounted for in the web styles.

## Elevation & Depth

The system is mostly flat. Tonal separation and passive edges distinguish adjacent panes; subtle resting, raised, and overlay shadows distinguish surfaces that actually sit above others. In the split workspace the document panel is the only raised sheet; Chat has no surface of its own. The composer on the ground is assistant-ui's box: the page surface with a hairline and no shadow.

## Shapes

Rectangular controls use a restrained four-step radius scale: small for grips and toolbar cells, medium for buttons and fields, large for popovers, and extra large for the document page. Badges and radio controls use the full radius. Passive structure uses a light edge; interactive fields use the stronger control edge. The Chat pane has its own quiet divider color.

## Components

- **Buttons:** Primary, secondary, outline, ghost, and destructive tiers (outline is a white button with a quiet 12% edge, for a single action inside a card) share one shape and compact text treatment. Resting outlines use at most 15% opacity, including primary and danger treatments; secondary buttons keep the lighter 7% passive edge. Sizes follow shadcn's Nova scale: `btn-xs` 24px, `btn-sm` 28px, `btn-md` 32px and `btn-lg` 36px, with icon-only `btn-icon-xs` (24px) and `btn-icon` (28px). Extra-small and small buttons use the extra-small text role, a 4px icon gap and the medium radius; medium and large use the small text role, a 6px gap and the large radius. Every button chooses a size. Hover and pressed states change the relevant color role. Keyboard focus shows the brand focus ring; a pointer press hides it on buttons and menus, leaves the clicked Chat composer only its quiet brand edge, and other text fields keep theirs.
- **Recovery actions:** Use `btn-outline-danger` on danger surfaces and `icon-danger` for error indicators. Hover and pressed states stay within the danger palette.
- **Fields and selections:** White fields use the medium radius, control edge, and subtle resting shadow. Invalid fields use the destructive role. Disabled controls use neutral fill and muted text.
- **Navigation:** The current location uses a white surface and primary ink. Other items stay quieter and reveal their affordance on hover or focus. A navigation item that leads to a full page discloses progressively: a click opens a popover with the essential information and the most common choice (Machines lists the machines you can use, yours and those teammates share, sorted together newest first, and sets your default), plus a link to the full page. A document's own machine, which plans and builds it, is the exception: an icon-only Local or Cloud status button left of Build plan, never in the Chat composer. It also carries the state of the document's Planner, which says nothing while it is attached: the dot becomes a thin petrol spinner while the machine is being connected to, the warning role where it cannot be, a muted grey while the Planner is away, and no dot at all where no machine is connected, the same bare tertiary icon as a button with no machine, never the machine's own success green. The button's name and the top of its menu say it in words that speak of the machine (_Connecting to Build box_, _Can't connect to Build box_ with the reason and what has been tried, _Build box is offline. Last seen 10:31 AM._ for a machine that is away (_Your work is kept._ where no time is known), _Build box stepped away. Your work is kept until 10:31 AM._, _No machine is connected._). Connecting and no machine yet are said only once they have lasted as long as a lost connection does before the page speaks (1.5 s), the last known state staying until then, so a restart's passing states are never shown; a state clearing goes at once, and nothing says it did. Through a lost connection the last known state stays until the machine's own word arrives, however long that takes: the no machine a restarted server tells first is its placeholder, not news. The name is the document's own machine's (the one the button names), or whose machine it is by login, never another machine's, and nothing is said while the list of machines describes another account's Planner than the page's connection does, or another machine than the document's, even one of the person's own, or was read before the connection's last word (the page asks again; until that answer has come the status says nothing of the machine, however long that takes, and is never what it said of an older word. The state it last showed is remembered through the gap only so that the same state, naming the same machine, returns at once instead of waiting out its grace again, and a screen reader is not told it again; any other state that arrives after the gap is drawn by its own rules, so a machine being connected to or no machine yet draws nothing until it has lasted 1.5 s, and what was shown before the gap is never drawn in its place: a document moved from Build box to Studio does not read _Build box is offline_ for a moment before _Connecting to Studio_). Status words are plain and name none of Chopin's own terms, such as the Planner, attaching or Decisions, nor Chopin itself; `status-copy.test.tsx` keeps it so, and keeps the Planner, attaching, holding and `@chopin` out of every other word a person reads, the busy labels (_Chopin is working_), a run card's notes (_It carries on when the machine reconnects_), the composer's picker hints and every refusal included. Decision stays Chopin's word for its cards and its tab; only text about a machine and its connection leaves it out.
- **Menus and popovers:** Every menu follows shadcn's Nova menu. The panel has 4px padding, the large radius, and a hairline ring with the raised shadow. Items are 28px: 4px by 6px padding, a 6px icon gap, the medium radius and the small text role. Group labels use the extra-small text role in medium weight and tertiary ink with the item's inset. Dividers are 1px, run through the panel's padding to both edges and keep 4px above and below. A selected item is tinted with the selected surface, never marked with a check. Secondary detail sits right-aligned in tertiary ink on the same line.
- **Composer popovers and assistant-ui:** The `/` commands, the `@` mentions and the model picker are one popover and one row (`ComposerMenu`, `ComposerMenuItem`), so the three open in the same place, with the same surface, edge, enter motion and tinted active row. Those pieces, with the model trigger and the model row, are adapted from the standalone (props and callbacks) lane of assistant-ui's Composer element, restyled to Chopin's tokens; `THIRD_PARTY_NOTICES.md` names the source, its date and the MIT notice, and nothing of its runtime is used. Those hand-adapted pieces stay, restyled to Chopin's tokens, until their element is copied: an element copied from assistant-ui's registry with `shadcn add` lives unmodified in `src/components`, keeps its own classes, sizes and radii (one generated layer gives its roots Tailwind's scale, never Chopin's control, pill or menu tokens) and takes only Chopin's colours, through the shadcn colour variables in `src/assistant-ui.css`; [Adding an assistant-ui element](../../docs/assistant-ui.md) says how, and a copy is never restyled here. Each hand-adapted element names its props and takes a finite `variant`, never a spread or a caller's class.
- **Composer box and send and stop:** The composer is assistant-ui's Composer element, copied with `shadcn add` and unmodified: a rounded box (24px corners, 10px padding, a hairline edge) holding Chopin's own field above a toolbar of 32px controls, the same on a phone, where only the target of a control grows. Its one round button, `ComposerSend`, is send and stop in one, and Chopin's state drives it (`send-stop.ts`). While the Planner is idle it is Send (an arrow): faded and disabled while the draft is empty, ink once there is something to send. While the Planner runs with an empty draft it is Stop (a square) and stops it, under the permission rules Stop has always had; someone who may not stop it sees a disabled Send, never a Stop they cannot press. While the Planner runs and the draft has words it is Send, and queues the message exactly as Enter does; when the draft is sent or cleared it is Stop again. The accessible name and tooltip always say what the icon shows (_Send message_, _Stop generating_), the icons swap with the element's own scale, fade and blur (at once under reduced motion), and one polite live region says once when the button changes, never for the tokens of a reply. Disabled is the element's own: no pointer, 30% opacity. The element's width (`max-w-lg`) is the demo's, so the pane sets it. Resume is its own ghost button beside it, and a control of Chopin's the element has no slot for goes in the toolbar in the element's ghost style, never as new chrome.
- **Model and reasoning control:** Left of Mention docs, after the Chat switch, a ghost button names the model that will run and, in tertiary ink, the reasoning level somebody chose for it, with a 12px chevron. It opens one popover over the composer: a search field that spans the row (its icon inside it, so its focus ring is flush with the popover), the models grouped by provider with a one-line description under each name and _Default_ right-aligned on the harness's own, and, only for a model that has levels, a _Reasoning_ radio group (_Default_ first, called _Model default_ when a level of the model would be taken for it (`Default` in any case), then the levels exactly as the harness reports them, `xhigh` as `xhigh` and `High` beside `high` as two, the reported string being what a turn carries; the interface-copy rule's sentence case applies to what Chopin writes, not to a value a harness reports). The chosen model is tinted, never checked; a level is a setting, so choosing one leaves the popover open, while choosing a model closes it and returns focus to the trigger. The search field keeps focus and drives the list with `aria-activedescendant`; Escape closes from anywhere inside, and Tab out or a pointer elsewhere closes without moving focus. On a phone the trigger is its icon and the model's short name, a pill as tall as the composer pill's other controls, with the name cut short by an ellipsis at 30% of the pill so the draft keeps its room beside the longest name (the level and the chevron stay in its accessible name and the open list), and the popover meets both edges of the composer, as the reference picker does. Nothing is drawn where the document's harness offers no choice or the person cannot write. Where a client withdrew its models, or an older one took its place, the picker is gone but a choice somebody saved still has its words in the composer's notice, with or without a turn since; while no client is attached, or one that offered its models has yet to report them, the notice says nothing of it until a turn has really fallen back, and then it says so, and a document nobody chose a model for never has one. A choice the harness no longer offers says what runs instead, in plain words with none of Chopin's own terms, in the trigger's name, in the popover and in the composer's notice, and Chat says it once on the turn. A turn that could not read the choice at all, the catalog or the stored choice, never runs the default silently: Chat says once, and every composer's notice says, _This document's model choice couldn't be read, so Chopin used its default model._, until a turn can read it again. These words are the composer's own notice, not a banner: a cause of their own, drawn beneath the connection banner when the machine's banner is drawn (the machine went after the turn), and giving way, as the composer's other notices do, to the room's own connection banner, a refused send and a failed reply, and back with the connection.
- **Message delivery:** A person's own message to the document's machine is never refused because the machine is away. It enters Chat at once and the composer empties. One quiet mark, in the quaternary ink at the line's end, says how far it has got: a clock (_Waiting to send_) while only this browser has it, one tick (_Sent_) once the server keeps it, two overlapping ticks (_Delivered_) once the machine took it. Each is an image with its words as its name. Until it is delivered, a menu at its end, shown on hover or focus and always on touch, offers _Delete_ in the shared menu. A message that can never be delivered as sent says so on itself in place of the mark: a warning glyph, _Couldn't send._ in the destructive ink with the reason in plain words, and _Try again_ and _Delete_ as extra-small ghost buttons. Nothing about it appears above the composer, and while the page's offline notice shows the line gives way to it and returns with the connection.
- **Markdown text:** Read-only Markdown (Chat messages, a decision card's text and the phrases in it) is drawn by `MarkdownText`, the element of [assistant-ui](https://www.assistant-ui.com/elements/markdown-text) adapted to take its text as a prop, because Chat is collaborative and has no assistant-ui runtime (`THIRD_PARTY_NOTICES.md` names the source and what changed). Its elements keep upstream's `aui-md-*` class names and are styled in Chopin's tokens with no specificity of their own, so a surface sets its own size and rhythm over them. A surface passes only what differs: Chat draws a heading as a line of text and links open in a new tab; a card reads no tables, strikethrough or autolinks except in an option's own visual, draws a Mermaid fence with the document's renderer through `componentsByLanguage`, and loads only the document's own images. Chat's messages also read GitHub's tables, strikethrough (two tildes) and task lists, whose boxes are named _Task_; footnotes and bare addresses stay plain text there, as they always were. A fenced block in Chat has a header on the block's own ground, its language at the start in the extra-small role and tertiary ink, and a ghost icon button (_Copy code_, then for three seconds _Copied_ with a check, or _Couldn't copy_ with a warning glyph in the danger icon role, which a touch screen shows without a tooltip) at the end; a card's code has none. A table scrolls inside its own lane. Raw HTML never reaches the page as markup: Chat drops it and a card shows it as the text it was written as. The collaborative editor is not drawn this way. A document shown read-only (an earlier version) stays in the editor's own read-only view, because it carries decisions, diagrams, comments and tables the dialect defines and MarkdownText does not.
- **Touch targets:** A control keeps its visible box on a touch screen. Where its box is under 44px (`--control-target-coarse`) an invisible `::after` of that size grows around it, so a finger just outside the control still reaches it, and the control never gets bigger, taller or spaced differently to make room for one. This applies only when the primary pointer is coarse (`(pointer: coarse)`, mirrored as `data-plan-coarse-pointer`): a touch-screen laptop used with a mouse keeps the desktop's sizes. Stacked menu rows keep their own 28px, and a row that follows another stands 44px from it (one margin, which is the height the rows no longer take themselves) so the menu is as tall as before and neighbouring targets meet without overlapping. A control that clips its own overflow cannot grow a target past its edge. Copied assistant-ui elements follow the same rule through the generated layer.
- **Icons:** Icon size is contextual: the container chooses it, not the call site. 16px is the default for menus, medium and large buttons, icon buttons and standalone interface icons. 14px sits beside small text: badges, pills, capsules and small buttons. 12px is for compact controls: extra-small buttons and the compact sidebar Search, disclosure, add-project, document-creation and document-action controls, which keep 24px targets. Icons in one row share one size and one column.
- **Badges and status graphics:** Neutral, success, warning, and danger use paired semantic surface, icon, graphic, and text roles. A badge combines an icon and label in a pill. Merged (plum) is the fifth quad, reserved for finished GitHub work: a merged pull request or a completed issue, as GitHub colours them.
- **GitHub reference pills:** A pull request or issue link in a document is a tinted capsule over the link itself: the state surface mixed half with the page, a hairline at 12% of the state icon colour, a 14px state glyph, the authored title in primary ink and a never-truncated `#number` in tertiary ink. Open is success, merged and completed are merged, closed is danger, and draft, not planned, loading and no access stay neutral.
- **Document:** The authored page is white, readable, and wider only where content requires it. Headings, lists, tables, code, and callouts retain document semantics inside the editor.
- **Document images:** Click opens a full-screen preview with zoom and close controls. Hover or keyboard focus reveals metadata editing and corner resize handles. Resizing preserves the image ratio, shares the chosen width with collaborators, and remains bounded by the document or column on narrow screens.
- **Decision decks:** Adjacent decisions stack as a deck. The top card is live; up to four cards behind it show as blank, inert edges, each nearer one showing more of itself. A capsule pager under the stack (previous, the top card's place, next) and Left and Right arrows page through the deck and stop at either end. Next drops the top card a short way as it fades and the card behind rises into its place with its content fading in; previous slides it back. Answered decisions settle to the back and keep an open card's full layout, with the chosen option selected. Moves animate transform and opacity, plus a clip and the leaving card's height so a taller card never covers the pager. Reduced motion crossfades without movement. Deck order is each reader's own.
  On desktop, Decisions shows open decisions as the same deck when two or more wait, with resolved decisions listed below in an accordion that opens by default; phones keep the single-pane list and save bar. A blank document whose Planner asks decisions opens Decisions once per visit, unless the reader is editing the document.
- **Unfold:** `UnfoldSection` uses Base UI Accordion for plain disclosure; card previews use the shared Unfold primitives. Both use the Chevron icon from the icon system. Native `details` and `summary` elements are not used. A button with `aria-expanded` and `aria-controls` folds a mounted panel open through its grid row while the content fades and tips down from its top edge, with the shared ease-out: card previews take the linger duration, plain accordions the accordion duration. A second press reverses from the current frame. Closed content is inert and hidden once the fold ends. Reduced motion snaps the height and keeps a short crossfade. A card preview never replaces the card's own open action.
- **Connection and failure banner:** One family adapted from assistant-ui's standalone `ConnectionState` and `ErrorState` elements (see [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)), restyled to Chopin's roles. Both are the composer's attached top strip: the common interface text role, the extra-small role for counts and reasons, `btn-xs` outline buttons, 16px icons and the semantic surface, icon and text pairs. The connection banner has four exclusive phases and shows nothing while online. _Reconnecting_ is neutral with a spinner and the attempt (_attempt 3_); _dropped_ is the warning pair with a Reconnect button, offered once automatic attempts have failed four times or where the machine itself can be asked to try again; _resumed_ is the success pair for four seconds and says what was caught up (_Back. The reply kept going._ with _3 new messages_, or _Back. The reply finished while you were away._), then leaves. It is fed by the room's socket, the document and transcript catching up on it, and the machine's connection, in that order: a lower layer is told only while the one above it is fine, and a restart the page is waiting out in silence shows nothing and is never _resumed_. Reconnect retries the layer that failed: the socket reconnects at once; a machine that cannot be connected to is asked to start again; a machine that dropped or stepped away has no button, because only that machine can come back. The failure banner is the danger pair with Retry for a reply that ended without finishing (a model or harness error, a timeout, an agent that could not be reached, a tool it needed), in a machine's plain words with the reason exactly as reported; one that was refused has no button, a refused message points to the machines, and Retry sends the same request again, with its text, references and open document, as a new request. A dropped link is the connection's to tell, never the failure's, and the failed reply's own line leaves the transcript while the banner tells it. Both enter once, with a fade and a short slide, and leave with no exit; reduced motion shows them at once. A screen reader hears each phase once, from one polite live region beside the page; the banners are no live region of their own, except that a failure alerts once.

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
- **Don't** join inline metadata with a middle dot, bullet, or a swapped-in glyph such as a slash or pipe; use spacing between elements, or drop the metadata.
- **Don't** give a menu or popover its own padding, item height, radius or divider; build it from the shared menu parts.
- **Don't** pick an icon size per call site when its container already sets one.
- **Don't** add a navigation item that jumps straight to a full page when a popover could answer the common question first.

## Shared component recipes

Important visual dimensions and colors belong to the shared theme. Use finite component variants for density, size, typography and state; avoid selector overrides that reach into another component or anonymous child. Browser geometry remains measured at runtime.

- `Count` owns quiet, actionable and control appearances. Quiet sidebar counts use `--color-count-quiet` (gray-50); selected control counts use the page surface. Control counts use an 18px minimum square and allow wider values without clipping. Counted buttons use the shared 4px control inset.
- `IconButton` owns normal and compact sizes, default and compact glyphs, and ghost or nested hover surfaces. Compact sidebar buttons are 24px with a 12px glyph; the common icon catalog also includes micro, default and larger roles. Coarse pointer targets use `--control-target-coarse`.
- `MenuItem` owns the Nova item: shared height, padding, gap and radius tokens, with normal and compact density now identical. Destructive text and icons inherit the same semantic ink. `MenuSeparator` owns the edge-to-edge divider and its spacing.
- Button utilities own their icon size through `--btn-icon-size`; a button's glyph never sets its own size.
- `EmptyState` owns circular tinted icon frames, title and description type roles, copy measure, icon gap and optional framed presentation. Decisions and Chat use its compact density.
- Document measure, gutters, top inset, leading and decision marker size are shared document roles. Marker positioning measures the rendered disc, so token changes cannot desynchronize the visual size and geometry.
- Panel headers and the document title split control use shared heights and insets. Breadcrumb text uses medium weight; the split label and compact action produce an 8px text-to-chevron gap. Project names in document breadcrumbs are plain text; document title and menu controls share a single hover surface.

SeeCode uses a fixed canvas typography catalog in `packages/diagrams/src/core/tokens.mjs`: node labels 14px, subtitles 12px, tags 10px and edge labels 12px. Measurement and SVG drawing variables derive from the same catalog, so changing type updates boxes and routing together. These are coordinate-system roles; interface controls retain the fluid UI scale. Architecture graphs may use a narrower derived layout, targeting the smaller of 1100px or the document lane, while preserving saved source, node identities, connections and playback. Fitting has a readability floor; dense diagrams keep native scrolling and zoom controls below the diagram.

`InlineNotice` reserves space in the page flow for recoverable failures, using the shared semantic surface, icon and text roles. Navigation retry controls align within it; notices never cover document content. A lost connection and the machine's own connection are one banner, the connection banner, described under Components: it sits at the top edge of the Chat composer while Chat is on screen, and at the top of the document's content (or above the panes where Chat and the document take turns) while it is not, never in both. It is the composer's attached strip with a phase, so the page has no second offline notice and the composer has no second strip about the machine. Its grace period is counted only while the page can be looked at: a hidden tab's timers run once a second and a frozen tab's not at all, so such a tab says nothing of being offline however long its connection takes to come back, and counts the grace whole from when it is shown, thawed or restored while the loss lasts; a banner already shown stays. The phase is decided once, above Chat and the document, so switching between them neither restarts the grace period nor announces it again; on a phone the document's banner floats just under the top bar, and its height is added to the panes' top inset so it never covers the first of their content. A workflow run card and a message that could not be sent say nothing of their machine or the connection while the banner shows: a run whose machine had dropped reads as it last reported, with no _disconnected_, no note and a plain Pause, under a still neutral ring, and the words come back with the connection. A server's refusal of a send is told again, in the same words, once the connection returns.
