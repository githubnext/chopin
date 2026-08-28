# Archived Chats Sidebar

## Goal

Move archived documents out of the active project catalogue and into a distinct sidebar mode.
This replaces the current “Show archived documents” checkbox and mixed active/archive list.

## Interaction

The active sidebar remains unchanged except for a new **Archived chats** navigation button directly
above the account control. It uses the supplied box-archive SVG at 14px and the same spacing,
typography, hover, and focus treatment as the existing New document and Search actions.

Selecting **Archived chats** swaps the scrollable sidebar contents into archive mode:

- New document and Search are replaced by **← Back to active docs**.
- Projects are listed in their existing order.
- Each expanded project shows only archived documents and their existing research children.
- Project creation, document creation, and new-research controls are hidden.
- Archived document menus continue to offer Restore and Delete permanently.
- The redundant per-document Archived badge is omitted in this already-labelled context.
- Existing loading, error, pagination, collapse, current-document, drawer, and resize behavior remains.

The account control remains anchored at the bottom in both modes. The Archived chats footer button is
shown only in active mode; the back control is the return path from archive mode.

Restoring a document while browsing archives returns the sidebar to active mode so the restored
document is visible. Archiving a document keeps the sidebar in active mode and removes it from the
active catalogue.

## Architecture

`NavigationShell` owns a local `"active" | "archived"` catalogue mode and passes it to the existing
document and research catalogue hooks. Archive mode reuses the current `includeArchived=true` API
request, then `ProjectSidebar` filters each project to archived channels. Active mode uses the
existing active-only request. No route, persistence, server, storage, or protocol change is needed.

`ProjectSidebar` renders separate active and archived navigation bodies while reusing the existing
Project component. Small mode props control document filtering and the visibility of mutation
controls. A new SVG asset is imported through `NavigationIcon`, preserving the shared 14px contract.

## Failure and Empty States

Archive mode keeps the existing per-project loading, failure, and Load more behavior. Projects
without archived documents may have an empty expanded list. API failures use the current navigation
error presentation. Switching modes cancels stale catalogue requests through the existing hook.

## Testing

- Static navigation tests cover the footer placement, exact labels, 14px icon, mode-specific
  controls, and archived-only rendering.
- Existing document catalogue tests continue to cover cancellation and stale-response handling.
- The archive E2E flow opens Archived chats, verifies active documents are absent, restores an
  archived document, and returns to the active catalogue.
- Responsive drawer behavior uses the same mode and controls and is covered by the E2E flow at a
  narrow viewport where practical.

## Out of Scope

This change does not add a dedicated archive URL, persist archive mode across reloads, alter archive
authorization, or introduce an archive-only backend query.
