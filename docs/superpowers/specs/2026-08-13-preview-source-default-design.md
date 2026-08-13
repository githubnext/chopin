# Preview source default

## Goal

When a block has a successful rendered preview, show the preview and hide its
editable source by default.

## Behaviour

- Code, diff, Mermaid, and block math previews start with their source hidden.
- The existing control reads "Show source" initially and reveals source only
  for that viewer and session.
- A source-only or failed-to-render block remains visible, so it can be
  repaired.
- Visibility stays out of the shared document and does not affect other
  collaborators.

## Implementation and verification

Initialise a previewable block's local collapsed state as true when no viewer
choice has been recorded. Keep an explicit viewer choice intact. Update browser
tests to assert the default and that revealing remains local to one viewer.
