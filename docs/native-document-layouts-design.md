# Native document layouts: first slice

9 October 2026. Design approved from the local preview in this task's artifact
folder. The preview is a design reference, not an editor fixture.

## Direction and sequence

Chopin will use distinct native layout containers. The first slice adds a
borderless, two-column section. A gallery is a composition of two columns with
the existing image node and editable caption paragraphs. The next slices extend
Columns to three regions, add Grid for repeated items (eventually 4 × 4), and
add a z-axis Deck whose cards are directly editable. Deck browsing position is
proposed as viewer-local; card contents and order remain shared. That proposal
will be reviewed with the Deck design.

This keeps every child in the existing MDX → Lexical → Yjs document. There is
no embedded editor, opaque gallery configuration, or separate renderer. A
generic `Layout`/`Item` pair would reduce node names but make editing and
validation depend on a mode; distinct containers keep each layout's rules
explicit. Fixed gallery widgets would make content moves and mixed prose harder.

## Source model

The first slice accepts exactly two top-level `Column` children in a top-level
`Columns` element. All three elements have durable ULID `id` attributes. A
`Column` holds ordinary editable Markdown blocks, including image paragraphs.
The first slice forbids nested layouts and other MDX block components inside a
column; question and decision projections remain record-owned. Unsupported
children and attributes produce dialect errors before publication.

```mdx
<Columns id="01K0N4W3B7P27CBAEC7A8C8WEA">
<Column id="01K0N4W3B7P27CBAEC7A8C8WEB">

![Document outline](https://example.com/outline.png)

The working document keeps related material together.

</Column>
<Column id="01K0N4W3B7P27CBAEC7A8C8WEC">

![Spatial layout](https://example.com/layout.png)

Images and captions remain editable inside the document.

</Column>
</Columns>
```

This example uses the accepted canonical MDX spacing. Image URLs must be
absolute HTTPS URLs or Chopin-hosted `/images/` paths returned by
[`upload_image`](local-agent-mcp.md#upload-an-image). Each `id` is unique within
the document.

The paragraph immediately after an image paragraph receives compact caption
styling, but remains an ordinary paragraph rather than a formal caption node.
It can be selected, edited, moved, or removed separately. This is the first
slice's deliberate limit: any prose immediately after an image will also get
that styling. If authors need a stronger association, add a native `Figure` in
a later slice rather than infer identity from adjacent blocks.

## Authoring and reading

- `/columns` inserts two empty columns and places the caret in the first. Each
  starts with a normal paragraph. The editor shows a quiet, unsaved placeholder
  while a column is empty.
- People edit text, insert images, and add caption paragraphs directly in either
  column. Selecting an image offers **Edit image** for its URL and alt text.
  Failed images retain the existing repairable missing-image presentation.
- Normal selection, cut/paste, and undo move or remove blocks within or between
  columns. The first slice has no drag reorder or column-count control. A
  content-preserving **Unwrap columns** action places both columns' blocks back
  in document order.
- Keyboard reading order is first column, then second, then the next document
  block. Arrow-key selection must cross those boundaries. Tab keeps its normal
  focus behavior. Enter on the final empty paragraph of the second column
  follows the existing callout exit convention and creates a paragraph after
  Columns. An Enter in the first column never skips the second.
- The section has no resting border or panel. It uses the document's wide lane,
  a quiet gap, and top alignment. A document-container breakpoint stacks the
  columns in source order. Images keep their intrinsic aspect ratio and stay
  within a column; the preview's sample artwork happens to share a 4:3 ratio.

## Data flow and failure behavior

`Columns` and `Column` are Lexical element nodes with ordinary descendants,
following the existing Callout/Tab pattern. Import/export visitors walk into
children. The shared dialect registry registers both nodes and visitors for
browser and server headless editors. Yjs synchronizes child edits as ordinary
document changes; the server validates and commits canonical MDX before
acknowledgement. Invalid client changes follow the existing epoch rebuild path.

The Planner may author a complete valid `Columns` block through structural
`edit_plan` operations, and an unchanged top-level block retains node identity.
The current operation API does not target a nested Column independently: a
Planner replacement of part of a Columns block can recreate its nested Lexical
subtree. This slice does not change Planner guidance or the frozen #415 trial.
An authoring-contract handoff follows only after the slice is implemented and
verified.

## Acceptance

Verify restricted MDX parse/serialize, Lexical round trip, and all-node server
registration. Reject fewer or more than two columns, unknown attributes, nested
layouts, and record-owned components. In a real browser document, insert the
layout, edit both columns and both image URLs/alt fields, move and remove child
blocks, unwrap, undo, and navigate across boundaries. Confirm a second client
sees the edits; reconnect and reload preserve structure and reading order.
Capture wide and narrow screenshots and verify no horizontal overflow. Document
the valid source example and the adjacent-caption limitation.

## Review slices

1. Two-column native MDX/editor path, image editing, gallery composition, and
   focused browser and collaboration coverage. Open a draft PR with a real UI
   image for design review.
2. Three-column controls and responsive refinement.
3. Native Grid with repeated editable items and bounded 4 × 4 content.
4. Native Deck with swipe, button and keyboard browsing, inactive-card focus
   handling, and reduced-motion behavior.

No slice changes the concurrent #415 assessment. New PRs remain draft; merge,
deployment, and force-push require separate authorization.
