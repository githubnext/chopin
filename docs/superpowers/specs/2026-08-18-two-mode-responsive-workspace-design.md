# Two-mode responsive workspace

## Goal

Use the same destination-based workspace on phones and tablets. Do not open
Conversation as a drawer. Switch directly from compact destinations to the
desktop split workspace at 1200px.

## Responsive behavior

- Below 1200px, show one destination at a time: Conversation, Plan, or
  Decisions.
- Use the existing bottom navigation in the order Conversation, Plan,
  Decisions.
- Opening Conversation hides the document from layout, pointer, keyboard, and
  accessibility navigation. Conversation fills the workspace.
- Returning to Plan or Decisions hides Conversation and restores the selected
  document destination.
- At 1200px and above, preserve the existing desktop split workspace,
  conversation resize handle, document controls, and header toggle.
- Preserve the stored desktop conversation width and open/closed preference
  while compact destinations are used.

## Architecture

Reduce `WorkspaceMode` to `compact | split`. Use one media query at 1199px.
Remove drawer-only presentation state, modal isolation, focus trapping, drawer
width, and the internal Close conversation action. Compact Conversation keeps
the existing phone semantics and fills the same workspace slot as Plan and
Decisions.

No document, chat, decision, persistence, or collaboration model changes are
needed. The three destinations remain mounted so drafts, scroll, selection,
and live state survive navigation and breakpoint changes.

## Focus and accessibility

- Compact destination buttons move focus to the selected destination heading.
- Inactive destinations remain hidden and inert.
- Escape from compact Conversation returns to its opener, matching the current
  phone behavior.
- Compact Conversation is a complementary region, not a modal dialog.
- Desktop focus and resizing behavior remain unchanged.

## Test seams

Tests observe only public behavior:

1. `workspaceMode(matchMedia)` classifies 1199px as compact and 1200px as
   split.
2. `presentWorkspace` exposes exactly one compact destination and preserves
   the desktop preference.
3. Browser tests verify full-destination behavior at 768px, 1023px, 1024px,
   and 1199px; split behavior at 1200px and 1440px; and compact behavior under
   the existing 200% zoom viewport.
4. Browser tests verify role, visibility, inert state, focus restoration,
   navigation order, draft preservation, and absence of the resize handle.

Tests use roles, labels, and existing product attributes rather than styling
classes or new test-only hooks.

## Acceptance criteria

- No width below 1200px renders a Conversation drawer or overlays the document.
- Phone and tablet use the same bottom-navigation interaction model.
- 1200px and wider retain the desktop split workspace.
- Breakpoint transitions preserve the active task and mounted chat/editor
  state.
- Focus, touch targets, safe areas, visual-viewport behavior, and horizontal
  overflow checks continue to pass.
