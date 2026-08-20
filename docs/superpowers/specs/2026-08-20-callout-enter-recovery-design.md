# Callout Enter Recovery

## Problem

Callouts created by the old slash command can hold text directly beneath the
`CalloutNode`. Lexical expects block children there, so trying to insert a
paragraph from that text does nothing. The newer slash command creates the
right shape, but an already-open legacy callout remains stuck.

## Behaviour

- Enter at the end of callout text creates another paragraph inside the
  callout.
- Enter in an empty final paragraph removes that paragraph, creates a paragraph
  after the callout, and moves the caret there.
- Shift-Enter remains a line break.
- Valid callouts and Enter away from the empty final paragraph are unchanged.

## Design

Add a small callout-shape normaliser to the editor. When it finds inline nodes
directly beneath a `CalloutNode`, it moves each consecutive inline run into a
paragraph without recreating the inline nodes. Keeping those node identities
preserves the selection and collaborative identity. Existing block children
stay where they are.

Register the normaliser as a `CalloutNode` transform alongside the callout
editor behaviour. It is idempotent: once a callout contains only blocks, later
transform passes do nothing. After normalisation, the existing Enter handler
owns the interaction. Its exit branch already removes the empty final
paragraph before inserting and selecting the paragraph after the callout.

This is a client-side compatibility repair, not a source migration. The repair
becomes an ordinary collaborative edit and is persisted through the existing
document flow.

## Tests

- A headless regression test constructs the legacy direct-text shape, runs the
  normaliser, and verifies that the same text node now lives in a paragraph.
- The browser test verifies that the first Enter creates an in-callout
  paragraph and the second removes the empty paragraph, exits the callout, and
  persists subsequent text outside it.

## Scope

One small implementation slice: the normaliser, its registration, and the two
focused regression checks. No server migration or unrelated container cleanup.
