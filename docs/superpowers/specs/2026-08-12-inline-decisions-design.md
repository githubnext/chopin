# Inline decisions and focused decision view

## Goal

Give the plan most of the workspace while keeping conversation in a narrower
left rail. Decisions move out of the right rail and into the document they
shape. A second, focused view shows those same decisions as a stack when the
room needs to work through them without the surrounding prose.

The design follows the Figma explorations [Stacks 1](https://www.figma.com/design/Px4tP6QSzRgNe6St0Yah64/Chopin-foundations-%E2%80%94-colour?node-id=146-1872&t=2hnlx2rWTmAxqLNG-4)
and [Inline 1](https://www.figma.com/design/Px4tP6QSzRgNe6St0Yah64/Chopin-foundations-%E2%80%94-colour?node-id=147-2008&t=2hnlx2rWTmAxqLNG-4).
They are interaction references rather than complete screen specifications;
the existing top bar remains above both conversation and document.

## Core model

There is one collaborative document and two ways to look at it. Questionnaire
and accepted-comment `<Decision>` nodes remain in canonical MDX, in document
order. Inline view renders those nodes among the prose. Decisions view projects
the questionnaire records into a focused stack. It does not create a second
decision store, copy answers, or rearrange the source document.

The view is personal interface state. One person can answer from Decisions
while another reads Inline; both surfaces use the existing shared questionnaire
controller and see the same draft, collaborators and resolution. Switching
views never changes the document for anyone else.

Open comment threads remain records beside the document, joined to their
passages through the existing relative-position anchors. They are discussion
about document content, not entries in Decisions view.

## Workspace

The application keeps one top bar across the full width. Below it:

- conversation remains in a resizable left rail, with a 280px default and a
  240–400px range rather than the current 340px default and 240–520px range;
- the document occupies all remaining width;
- the right decisions rail and its resize handle are removed.

The document surface holds one two-option `Plan`/`Decisions` control. The
Decisions option carries the unanswered count; its badge is omitted at zero
rather than showing a permanent zero. The existing room, connection and
presence controls remain in the top bar; their exact arrangement is outside
this exploration.

`PlanEditor` stays mounted while Decisions view is showing. Its surface is
hidden, not destroyed, so the Yjs document, Lexical editor, undo history,
subscriptions and remote presence continue to run. Returning to Inline restores
the reader's previous document scroll position.

## Opening flow

On a new plan, the planner asks genuinely blocking questions before writing
prose. The `ask` tool already waits for the shared answer, so a document that
contains questionnaires but no ordinary plan blocks is naturally in its
opening decision phase. It opens directly in Decisions view.

After the opening questions resolve, the same planner turn continues and
writes the plan. The first ordinary prose block ends the opening phase and the
interface moves to Inline once. This is derived from document shape; it does
not add a persisted room phase, a protocol message or a migration for existing
rooms.

Later questions behave differently. If a plan already has prose, a new
question renders inline and increments the unanswered count, but it never
hides the plan, moves the reader, changes their view or steals their caret.

The planner prompt explicitly asks blocking questions before its first edit.
This first version does not add a server gate that forces every room to contain
a question: some plans have no decisions the repository and request cannot
already settle.

## Decision attention and navigation

The Decisions control shows the number of questions whose answer is not yet
final, not the number of questionnaire cards or historical decisions. A batch
of five questions therefore shows five until its shared draft is submitted and
the durable answer projection has completed. When a new question arrives, the
number uses a short, quiet emphasis and then settles. There is no toast and no
automatic navigation.

Clicking the control switches to Decisions view and brings the first unanswered
card into view. The stack follows document order:

1. unanswered questionnaire cards, with the first unanswered question active;
2. resolved questionnaires under a collapsed history disclosure.

Open comment threads and accepted comment decision records do not appear in
this stack. Each questionnaire card can return to Plan with “Show in plan”.
That action restores the inline document, scrolls to the card's document
position and pins the existing related-passage mark long enough to explain
where the reader arrived. Returning without selecting a card restores the
scroll position from before the view switch.

The last manually selected view is remembered locally once plan prose exists.
The automatic opening transition applies only before the first prose appears.

## Inline decisions

Questionnaire decorator nodes stop rendering as zero-height anchors. They use
the existing `QuestionnaireCard` and `QuestionView` behaviour inside the
document, including the shared draft, collaborator badges, submit/cancel rules,
resolved answers and provenance. The document supplies enough horizontal space
for the full card; the card does not open in a modal or popover.

Accepted comment threads already project to immutable `<Decision>` nodes. Those
nodes render as compact decision records in document order, preserving the
quote, discussion and acceptance provenance without reopening the frozen
thread. They do not use questionnaire controls.

Both kinds of node remain atomic document blocks. Their records own their
answers and discussion as they do today; inline rendering does not make their
contents ordinary editable Lexical prose.

## Comments in the document

An open thread paints its anchored phrase with a subtle wash and places a small
comment button in the document's right gutter near the passage. The card itself
is hidden until requested:

- hovering the phrase or button shows a compact preview;
- clicking either pins the complete thread with reply, Accept and Dismiss;
- Escape or clicking elsewhere closes a pinned thread;
- moving between the passage, button and card does not collapse the preview;
- creating a comment from the selection toolbar opens the same anchored card
  beside the captured selection.

The popover is interface chrome, not document content. It must not change
layout, enter the Yjs document or disturb the editor selection. Only one thread
is expanded at a time.

Accepting freezes the thread and starts the existing agent turn. Its temporary
highlight and gutter button disappear; the durable `<Decision>` record remains
inline. Dismissing removes the thread from the document UI while retaining its
transcript trace.

If the exact phrase changes but a subject block survives, the button stays on
that block and the thread says that its text changed. If every subject block is
gone, a small orphaned-comment count appears in the document toolbar. It opens
those threads as anchored-to-toolbar popovers so a durable discussion never
becomes unreachable. This is a recovery affordance, not a separate Comments
view.

## State and component boundaries

`Room` continues to own one `QuestionnaireStore` and one `ThreadStore`.
Questionnaire observation remains inside `PlanEditor`; the host reads the same
store to derive unanswered count, opening state and the focused stack.

The workspace owns only personal layout state: chat width, chat visibility,
Inline/Decisions mode and saved plan scroll position. Decision counts are
derived from the questionnaire snapshot rather than stored separately.

Inline widget renderers receive live host configuration through the editor's
existing widget plugin boundary rather than a module-level singleton. Comment
gutter placement and popovers belong to a focused editor adapter: the
`ThreadStore` continues to resolve durable anchors and expose thread state,
while the adapter measures current DOM ranges and decides where chrome is
drawn.

No protocol or persisted-record change is required for the first version.

## Accessibility and motion

The view control and count use real buttons with selected state and descriptive
accessible names. Switching views moves focus to the focused-view heading or
selected card; “Show in plan” returns focus to the inline card after scrolling.
Comment buttons name the quoted passage and whether replies are waiting. Hover
is never the only route: focus shows the same preview and click pins it.

The new-decision emphasis uses the existing fast/base motion tokens and obeys
reduced-motion preferences. View changes do not animate document position;
restoring a scroll offset is more important than making the canvas slide.

## Scope boundary

This exploration covers the desktop workspace, opening decision flow, two
decision views, inline cards, comment disclosure and the planner's first-edit
guidance. It does not redesign mobile layouts, add assignments, invent new
decision actions such as Research or Expand, change questionnaire schema,
reopen settled decisions, or add a general notification centre.

## Verification

Pure tests will cover derived opening state, unanswered counts, new-question
count transitions and the one-time automatic move to Inline. Existing
questionnaire controller coverage continues to prove that two mounted surfaces
share one model and one presence lifecycle.

Browser coverage will verify:

- a new room with questions starts in Decisions and moves to Inline when prose
  appears;
- a later question increments the count without changing view, scroll or
  selection;
- stack and inline surfaces edit the same shared draft;
- “Show in plan” restores Inline and finds the correct card;
- switching views preserves the editor and its scroll position;
- comment hover, keyboard preview, pinned actions and dismissal work without
  changing document layout;
- accepted comments become inline decision records;
- drifted and fully orphaned threads remain reachable.

Each implementation slice must keep `bun run ci`, `bun run types`, `bun test`
and the relevant focused browser tests passing. The completed exploration also
runs `bun run build` and the full browser suite.

## Delivery shape

The work should land as small vertical slices: first the wider workspace and
view state, then the focused decision projection, then inline questionnaire and
decision rendering, then comment gutter disclosure, and finally the opening
planner flow. Each slice keeps the existing storage and collaboration model
valid if later slices never land.
