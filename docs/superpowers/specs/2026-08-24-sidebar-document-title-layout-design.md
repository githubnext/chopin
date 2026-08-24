# Sidebar Document Title Layout

## Goal

Let a document title use the full sidebar row while its action buttons are idle. Keep titles on one
line, truncating only when they exceed the genuinely available width or when the actions are shown.

## Interaction

- At rest, the hidden research and document-action buttons reserve no horizontal space.
- Hovering a document row or focusing within it reveals the buttons and makes room for them, so the
  title truncates without overlapping the controls.
- Keyboard focus receives the same layout as pointer hover.
- Coarse-pointer layouts keep their existing always-visible, larger controls.
- The document row's right padding shrinks from 12px to 4px, placing the controls closer to the
  sidebar edge.

## Implementation

Keep the change in `apps/web/src/navigation.css`. Collapse and hide the document-actions container
by default, then restore its natural width and visibility for the existing hover and focus states.
No React state, markup, protocol, or data changes are needed.

## Testing

Extend the navigation CSS contract test to cover the smaller right padding and the idle versus
hover/focus action-container layout. Run the focused test, formatter/linter, and TypeScript checks.

