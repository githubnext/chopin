# Purposeful app motion

## Context

This work stacks on `maggie/global-nav-on-workspace-chrome`. Chopin currently has a few
entrance animations, loading loops, button press states, and hover transitions. Most larger
state changes are immediate: drawers and menus mount abruptly, modals disappear as soon as
they are dismissed, workspace panes snap between layouts, and disclosures add or remove their
content without continuity.

The motion language comes from the transitions.dev recipes and the web animation design guide.
It should make the interface easier to follow, not make routine work feel slower.

## Goals

- Animate meaningful spatial and state changes across the web app and editor.
- Give repeated surfaces the same timing, easing, and lifecycle.
- Preserve responsive input, focus, and state semantics.
- Support reduced motion everywhere motion is introduced.
- Keep the implementation dependency-free and small enough to review in checkpoints.

## Non-goals

- Animating every hover, colour change, or keyboard-driven action.
- Delaying navigation so an exit animation can finish.
- Adding route-level transitions between documents.
- Adding a general-purpose animation library, springs, gestures, or decorative motion.
- Refactoring component state that is unrelated to presentation lifecycle.

## Motion principles

- User-initiated entrances use a responsive ease-out curve. On-screen movement uses
  ease-in-out. Ordinary hover colour changes use `ease` or remain immediate.
- Small controls stay within 100–150ms. Menus, tabs, and modals stay within 150–250ms.
  Drawers stay below 300ms. Exits are roughly 20% faster than entrances.
- Elements that move together, such as a modal and backdrop, share timing and easing.
- Prefer `transform` and `opacity`. Blur is limited to the subtle 2–3px values used by the
  transition recipes.
- High-frequency and keyboard-driven interactions remain immediate.
- Reduced motion removes the animation rather than substituting a different one.

## Architecture

### Presence lifecycle

Add one small React hook for conditionally rendered surfaces. It converts an authoritative
open boolean into mounted, open, and closing presentation phases. Closing surfaces become
non-interactive immediately, remain mounted only for their CSS exit duration, and then unmount.
The hook owns cleanup and interruption, including reopening during a close. Component state
continues to decide whether a surface is logically open.

Persistent surfaces do not use the hook. Workspace panes, page views, and accordion bodies stay
mounted and expose their existing state through data or ARIA attributes so CSS can transition
them directly.

### Tokens and recipes

Do not import transitions.dev's universal root block. Chopin already uses names such as
`--duration-fast` for 120ms control feedback, while transitions.dev assigns the same name to
250ms surface motion. Replacing that token would silently slow existing controls.

Install only the semantic variables required by each selected recipe, such as
`--modal-open-dur` and `--dropdown-close-dur`. Use the recipe CSS and documented `t-*` hooks
where the visual shape matches. Bespoke surfaces, such as a horizontal navigation drawer, use
the same timing and easing doctrine without forcing a vertical recipe onto the wrong geometry.

### Input and accessibility

An activation can opt out of motion when it came from a keyboard event or when the platform
requests reduced motion. First paint also starts at the settled state. Focus restoration and
ARIA state update from the logical state, not after a visual timeout. Closing surfaces use
`pointer-events: none` and cannot trap focus.

## Surface map

| Surface                                                                   | Motion                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| Add Project, Search, and Rename dialogs                                   | Modal scale and fade with a paired backdrop        |
| Account, repository, document, callout, and table menus                   | Origin-aware dropdown                              |
| Compact navigation drawer                                                 | Horizontal drawer and backdrop                     |
| Conversation pane and compact comment sheet                               | Directional panel reveal                           |
| Project lists, decision history, tool transcripts, and collapsible blocks | Accordion                                          |
| Document and Decisions views                                              | Short side-by-side page transition                 |
| Conversation open/close controls                                          | Icon swap                                          |
| Unread, working, and attention indicators                                 | Restrained badge entrance or existing loading loop |
| Existing status entrances, shimmer, press, and hover feedback             | Timing and easing polish only                      |

Motion is applied only when a state change benefits from continuity. Repeated text entry,
selection, caret movement, document navigation, scrolling, resizing under the pointer, and
keyboard navigation stay immediate.

## Failure behaviour

Motion is progressive enhancement. A missing transition event, interrupted render, reduced
motion preference, or backgrounded tab must never strand a mounted overlay. The presence hook
uses the CSS duration as a cleanup fallback. Reopening cancels stale cleanup. Actions that leave
the page proceed immediately instead of waiting for an exit.

## Testing

- Unit-test the presence lifecycle: open, close, interrupted close, cleanup, and immediate mode.
- Keep existing component tests for authoritative state and ARIA output.
- Add focused Playwright coverage for modal and drawer exits, focus restoration, and reduced
  motion. Browser tests own visual timing, focus, and geometry assertions.
- Run `bun run fix`, `bun test`, `bun run types`, and the narrow relevant browser suite before
  the PR is ready.

## Delivery

The work remains one PR stacked on `maggie/global-nav-on-workspace-chrome`, implemented and
reviewed in four checkpoints:

1. Presence lifecycle and semantic motion variables.
2. Global navigation, dialogs, menus, and drawer.
3. Workspace panes, view changes, icons, and badges.
4. Editor disclosures, popovers, existing-motion polish, and browser verification.

Unrelated motion or component issues found during the pass go into a parking lot rather than
expanding this PR.
