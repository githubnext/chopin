# Purposeful motion coverage

## Problem

Chopin has a working motion foundation, but only a few surfaces use it. Dialogs, compact
navigation, picker popovers, comment cards, and the Conversation panel have transitions. The
desktop Projects sidebar, document menus, disclosures, view changes, and small feedback states
still snap between states. The result feels less coherent than the token system suggests.

This design extends the existing system rather than replacing it. “Everything” means every
eligible state change: motion should explain where an occasional, pointer-triggered change came
from. It should not slow down typing, keyboard navigation, live progress, or repeated editor work.

## Goals

- Give pointer-triggered entrances, exits, movement, and feedback consistent motion.
- Keep keyboard-triggered and reduced-motion paths immediate.
- Reuse `useTransitionPresence`, the root input-modality marker, and existing semantic tokens.
- Retain focus, inertness, interruption, and responsive behaviour throughout transitions.
- Land the work as four small, independently reviewable PRs.

## Non-goals

- Adding Framer Motion, React Spring, or another animation dependency.
- Animating typing, cursor movement, selection, slash menus, reference pickers, or live progress.
- Inventing a toast system where the product currently has none.
- Redesigning surfaces or changing their information architecture.
- Making motion durable or collaborative state.

## Motion rules

1. Entrances and exits use the existing strong ease-out curve.
2. On-screen layout movement uses a dedicated ease-in-out curve.
3. Hover and colour feedback use the existing short control transition.
4. Surface motion stays below 300ms. Exits are shorter than entrances where practical.
5. Transform and opacity are the default animated properties.
6. Layout animation is limited to the Projects sidebar track and bounded accordion containers.
7. Popovers scale from their trigger rather than their centre.
8. Paired elements share duration and easing.

## Architecture

`useTransitionPresence` remains the lifecycle authority for surfaces that must stay mounted during
exit. Semantic motion contracts map a surface kind to its CSS class, close duration, and expected
states. The initial kinds are:

- `popover`: origin-aware scale and opacity;
- `sidebar`: a bounded layout track plus child transform and opacity;
- `collapse`: clipped disclosure size plus child opacity and translation;
- `content-swap`: overlapping outgoing and incoming content after the destination is ready; and
- `feedback`: short icon, count, and alert entrances.

The app theme owns app-shell contracts. Editor-specific contracts remain in the editor stylesheet,
using inherited theme tokens. Shared runtime packages do not depend on the web application. The
question package may use CSS entry states supplied by its host, but must not depend on the editor.

No new general-purpose component is required merely to remove repeated class names. A shared hook
or component should be introduced only where at least two consumers need the same presence,
accessibility, and interruption behaviour.

## Input and accessibility

The root input-modality listener records pointer or keyboard ownership before the state update that
opens a surface. Pointer-owned changes animate. Keyboard-owned changes settle immediately.

`prefers-reduced-motion: reduce` disables every new transition and animation. Changing the
preference while a surface exits settles it immediately.

During exit, content becomes `inert` and `aria-hidden` immediately but remains mounted until its
visual transition completes. Focus restoration and destination focus are not delayed by motion.
Outgoing content in a swap is inert as soon as incoming content becomes active, so overlapping
frames never expose two interactive copies.

## Surface coverage

### Existing contracts retained

- navigation dialogs;
- compact Projects drawer;
- repository, document, and account pickers;
- comment cards and compact comment sheets; and
- Conversation panel.

### New coverage

- desktop Projects sidebar and the corresponding content shift;
- document action menus and comment preview tooltips;
- Projects, decision history, research result, and chat tool disclosures;
- Document, Decisions, and Background Work view changes;
- question-step changes;
- document route changes once the destination is resolved;
- chevrons and open/close icon changes;
- unread, unanswered, busy, and similar count entrances; and
- terminal alerts and errors that appear in response to a completed action.

### Intentionally immediate

- slash menus and selection toolbars;
- Conversation reference pickers;
- typing, caret, selection, cursor, and presence updates;
- streaming transcript content and Research Workspace progress; and
- repeated keyboard navigation within an open menu or list.

## Lifecycle and failure behaviour

Opening content mounts in its starting style and receives its open state on the next animation
frame. Closing content remains mounted for its semantic close duration. Reopening during exit
cancels the close and transitions from the current visual state.

Measured popovers stay hidden until placement succeeds. If measurement fails, the surface settles
without motion rather than animating from a guessed origin. Content swaps do not animate loading
placeholders or blank frames: the outgoing view remains until the incoming view is ready.

The existing timeout fallback remains responsible for unmounting when a browser omits a transition
event. Motion is presentational; failure must never block navigation, editing, or dismissal.

## Testing

Unit tests cover semantic duration mapping, presence interruption, input-modality gates, and
reduced-motion settlement. Static theme tests ensure each semantic contract consumes declared
tokens and has a reduced-motion rule.

Playwright covers representative examples rather than every class name:

- pointer opening and interrupted closing;
- keyboard-owned immediate settlement;
- reduced motion before and during a transition;
- focus restoration, `inert`, and `aria-hidden` during exit;
- origin-aware portal menu placement;
- sidebar behaviour on both sides of the responsive breakpoint; and
- content swaps without duplicate interactive views or empty frames.

Geometry, computed styles, focus, and browser timing remain browser tests rather than synthetic DOM
tests.

## PR sequence

1. **Shell and menus** — add semantic contracts, animate the desktop Projects sidebar, document
   action menus, and comment previews.
2. **Disclosures** — animate Projects, decision history, research result, and chat tool expansion.
3. **Content swaps** — animate workspace views, question steps, and resolved document routes.
4. **Feedback polish** — animate icons, counts, and terminal alerts, then audit all current surfaces
   against this document.

Each PR includes its own tests and documentation changes. PRs build in order because later slices
consume the semantic contracts introduced by the first. Each coding agent starts from the previous
slice's merged main, owns one branch and PR, and stops for review rather than expanding into the
next slice.
