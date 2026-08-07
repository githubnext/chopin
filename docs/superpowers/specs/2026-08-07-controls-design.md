# Task 007: Buttons, fields and selects

## Goal

Put every standard control onto the designed sizes, tiers, states and edges
without changing its behaviour. The work ships as one PR, built through three
durable checkpoints so a timeout cannot erase the whole attempt again.

The task file and its three Figma frames are the visual contract.

## Architecture

`apps/web/src/theme.css` owns the shared control vocabulary as Tailwind
`@utility` rules. This follows the design-token utilities already established
by task 003 and lets `apps/web`, `packages/editor` and `packages/question` use
one contract without introducing a shared React component package.

The vocabulary will cover:

- a button base, two text-button sizes, one icon size and four tiers;
- a standard field, its invalid state and a ghost field for in-document
  selects;
- checkbox and radio presentation while retaining native inputs.

React components keep their current state, events and accessible names. The
specialised toolbar and menu surfaces from task 008 stay specialised where
they already meet task 007's sizes and states.

## Behaviour

Buttons have 24px and 32px text sizes, both on the 13px type rung, plus a 28px
icon square. Primary, secondary, ghost and destructive tiers step through
explicit hover and active fills. Disabled removes the tier entirely: gray-200
fill, gray-600 ink, no opacity and no active response.

Fields and textareas use the 20% control edge. Disabled fields use the 7%
hairline, gray-200 fill and gray-600 ink. Focus is a 2px brand outline with a
2px offset; the exposed gap naturally shows the page or ground beneath it.
Invalid fields use the same shape in destructive red and keep a written error
message beneath the field.

Checkboxes and radios keep native semantics but use the designed shapes and
checked glyphs. Their labels remain the whole click target. Disabled choices
use the same disabled vocabulary as the other controls.

The callout-kind and code-language selects remain native. They have no fill or
edge at rest, show the 20% edge on hover, and use the shared focus treatment.
The operating-system dropdown is deliberately left alone.

## Migration boundary

The PR migrates standard controls in the sign-in screen, planner/chat composer,
comment cards, questionnaires, callout chrome and code-fence chrome. Existing
domain behaviour, copy, layout structure and data flow are out of scope.

Any unrelated issue found during migration goes into a parking lot rather than
expanding this PR.

## Verification

Source-level regression tests will lock down the exact sizes, colour tokens,
tier states, disabled treatment, field edges, focus/error rings and checkbox
glyph. They will also reject legacy `disabled:opacity-*` control styling.

The finished branch must pass:

- `bun run ci`
- `bun run types`
- `bun test`
- `bun run build`
- `bun run e2e`

Browser verification will capture exactly the three images required by the
task: the chat composer, a comment card's buttons and a focused text field.
They will be stored under `tasks/images/` and included in the PR description.

## Delivery

One PR will contain three reviewable checkpoints:

1. shared tokens, utilities and regression tests;
2. control call-site migration;
3. full verification and the three screenshots.

No new component package, custom select, animation system or responsive/touch
redesign is part of this task.
