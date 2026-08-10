# Chat Markdown rendering

## Goal

Render the small set of Markdown people naturally use in conversation so
Planner replies and participant messages do not show formatting punctuation.
This slice changes how sent messages are displayed; it does not add formatting
controls or a preview to the composer.

## Architecture

Add a focused `MessageMarkdown` component beside the existing chat transcript.
It receives the message's stored text and renders it with `react-markdown`.
`MessageBody` uses it for both member and Planner messages. System entries stay
plain text because they are application events rather than participant prose.

The renderer uses standard Markdown only. It does not enable GFM plugins or the
plan's MDX dialect. This keeps plan components, tables, task lists and other
document features out of the conversation surface.

## Supported formatting

Messages support:

- bold and italic text;
- ordered and unordered lists;
- blockquotes;
- links;
- inline code;
- fenced multiline code blocks.

Headings are rendered as ordinary message paragraphs rather than introducing
document hierarchy into the rail. Images, raw HTML, tables, task lists and
strikethrough are not rendered as rich message content.

## Presentation and behaviour

Markdown uses compact chat typography. Paragraphs and list items retain the
current message size and line height. Lists have enough indentation to make
their markers legible without consuming the narrow rail. Blockquotes use a
quiet edge and secondary text colour. Inline code has a subtle inset surface;
fenced blocks use the monospace font and scroll horizontally rather than
wrapping or widening the sidebar.

Links use the existing brand colour and focus treatment. They open safely
without allowing the message to replace the current room. Raw HTML remains
disabled, unsafe URL protocols are rejected by the renderer, and remote images
are not loaded.

Queued member messages use the same renderer and keep their existing withdraw
control. Streaming Planner messages re-render the source received so far; an
unfinished delimiter remains literal until its closing delimiter arrives. The
streaming caret stays after the rendered content. Mentions continue through
`displayText` before Markdown parsing, preserving the rail's existing display
names.

## Scope boundary

The composer remains a plain text input. People can type Markdown syntax, but
this work adds no toolbar, shortcuts, rich editing, syntax highlighting, copy
button, or live preview. Transcript storage, grouping, transport and message
types do not change.

## Verification

Browser coverage will send a participant message containing emphasis, both
list kinds, a blockquote, a link, inline code and a fenced block, then assert
that the transcript exposes the corresponding semantic elements. The same
renderer path covers Planner messages, so a focused Planner assertion will
confirm that agent output is not left as literal Markdown.

The browser test will also confirm that raw HTML and image syntax cannot create
active elements or remote image requests. Existing transcript tests continue
to cover grouping, mentions, queued messages and tool runs.

The completed change must pass:

- `bun run ci`
- `bun run types`
- `bun test`
- the focused browser test
- `bun run build`

## Delivery

This is one small vertical slice: dependency, renderer, chat-specific styles
and behaviour coverage land together. Composer editing can follow separately.
