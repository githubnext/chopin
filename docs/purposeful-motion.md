# Purposeful motion

Motion in Chopin explains occasional state changes. It should help a reader understand where a
surface came from or what just changed without slowing down ordinary authoring work.

## Rules

- Pointer-owned entrances and exits use the strong ease-out curve.
- On-screen layout movement uses the dedicated ease-in-out curve.
- Hover and colour feedback use the short control transition.
- Surface motion remains below 300 ms and exits are shorter where practical.
- Transform and opacity are the default animated properties.
- Layout animation is limited to the Projects sidebar track and bounded disclosures.
- Keyboard-owned and reduced-motion paths settle immediately.

Typing, caret movement, selection, presence, streaming content, live progress, slash menus,
reference pickers, and repeated keyboard navigation remain immediate.

## Ownership

The web theme owns app-shell motion. The editor stylesheet owns editor motion and inherits timing
tokens from its host. Shared packages do not depend on app-only CSS. The question package accepts
presentation supplied by its host rather than naming either the editor or web implementation.

Existing lifecycle owners remain in place for surfaces that must stay mounted during an exit:

- `useTransitionPresence` owns popovers, panels, and the Projects sidebar;
- `MotionDisclosure` owns bounded disclosure content; and
- content-swap components own overlapping document destinations.

Feedback entrances do not need a second JavaScript lifecycle. They use CSS transitions with
`@starting-style`. Pointer ownership enables the semantic duration before the element mounts;
keyboard ownership and reduced motion use a zero duration. Because the element reaches its final
style on insertion, a later modality change cannot replay the entrance.

Stateful disclosure icons remount through the existing disclosure-icon abstraction. Newly
actionable counts remount only when their attention identity changes. Terminal alerts enter when
their owning error state mounts. No global animation listener or imperatively managed settlement
attribute participates in React reconciliation.

## Surface coverage

| Surface                                                                                                           | Treatment                       | Owner                   |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------- |
| Navigation dialogs, compact drawer, pickers, comments, Conversation panel                                         | Existing semantic contracts     | Existing owners         |
| Desktop Projects sidebar and document shift                                                                       | Bounded layout transition       | Navigation shell        |
| Menus and comment previews                                                                                        | Origin-aware popover transition | Menu and comment owners |
| Project, decision, research, and tool disclosures                                                                 | Bounded disclosure transition   | Disclosure owners       |
| Workspace, question-step, and resolved-route changes                                                              | Overlapping content swap        | Content-swap owners     |
| Open/close and chevron icons                                                                                      | Keyed feedback entrance         | Disclosure-icon owners  |
| Unread, unanswered, reply, and change-attention counts                                                            | Explicit count entrance         | Count owners            |
| Terminal action alerts                                                                                            | Terminal feedback entrance      | Alert owners            |
| Typing, caret, selection, presence, streaming, live progress, slash/reference menus, repeated keyboard navigation | Immediate                       | Local owners            |

## Review remediation

The feedback slice follows four structural constraints:

1. The Research Workspace remains below 1,000 lines. Feedback markup must not be copied through
   each alert; focused research UI is extracted when the file reaches that boundary.
2. App-shell and editor feedback classes stay in their canonical stylesheets. The question package
   receives its error class from the editor host.
3. Open and closed icon state is expressed once by the existing disclosure-icon abstraction.
4. Tests assert semantic contracts and rendered behaviour. They do not scan implementation files
   for magic strings as a substitute for exercising the feature.

## Testing

Unit tests cover semantic timing, input-modality gates, package-owned feedback classes, disclosure
icon state, and actionable-count identity. Static stylesheet tests verify declared tokens and
reduced-motion rules.

Playwright covers representative pointer, keyboard, reduced-motion, alert, icon, count, and
no-replay paths. Geometry, computed styles, focus, browser timing, inertness, and interruption stay
in browser tests rather than synthetic DOM tests.
