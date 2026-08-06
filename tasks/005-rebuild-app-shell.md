---
id: "005"
title: Rebuild the app shell as two layers
status: pr-opened
branch: tq/005-rebuild-app-shell
pr: "https://github.com/githubnext/chopin/pull/25"
stacked_on: "006"
blocked_reason:
---

## Context

The shell was designed on canvas, and the canvas is readable over MCP — open
the frame rather than working from the image.

- App shell — https://www.figma.com/design/Px4tP6QSzRgNe6St0Yah64?node-id=35-2

![the two-layer shell — one ground, one lifted page](images/005-shell.png)

Today the three panes are separate surfaces separated by borders and a gap,
with the ground showing between them.

## Goal

Reduce the shell to two layers: one ground carrying the nav and both rails,
and the document page as the only surface sitting on it.

## Notes

The rails stop being panels. They have no fill, no border and no shadow — they
are content laid directly on the ground, and the ground runs unbroken behind
the nav, both rails and the space around the page.

Rejected, and why:

- Flush panes each with their own fill and a hairline seam at every join.
  Three greys and two seam rules to justify, and nothing read as the subject.
- Panes as separate cards with the ground showing in a gap between them. Two
  mechanisms doing one job, and the gap made the app look assembled.

Resize handles appear on hover rather than being permanently drawn. There is
no seam between rail and page to grab, so the affordance has to arrive with
the pointer — but it must still be reachable without one.

Neither rail collapses today and this task does not add that. Build the rails
so a collapsed state could be added later without restructuring — the ground
already runs behind them, so collapsing one should be a width change rather
than a change of surface.

Depends on 003 — the ground, ring and shadow it needs are defined there.

## Acceptance

Layers

- [ ] The nav and both rails have no background fill of their own
- [ ] A single gray-150 ground runs behind the nav, both rails and the page
- [ ] The document page is the only element with a shadow

Page

- [ ] The page is white with the hairline ring and the raised shadow
- [ ] The page has 4px of ground on its left and right
- [ ] The page runs off the bottom of the viewport rather than ending above it
- [ ] The page's top two corners are rounded and its bottom two are not

Nav

- [ ] The nav is 48px tall with a hairline on its bottom edge only
- [ ] There is 16px between the nav and the top of the page

Resize

- [ ] Neither resize handle is visible until the pointer is over its boundary
- [ ] Both rails can be resized using only the keyboard

Evidence

- [ ] Screenshots at 1280px and 1680px wide attached to the PR

## Evidence

`e2e/shell.e2e.ts` is where the acceptance above is read. Every line of it is a
rectangle, a painted colour or a pseudo-element that exists only under a
pointer, so none of it can be asserted without a browser — and a fill put back
on a rail is invisible in a diff and obvious on a screen.

"The document page is the only element with a shadow" is read as written rather
than as three assertions on the shell's own layers, which would pass on a shell
that had grown a fourth: every element in the document is asked, and the answer
has to be a list of one. It is read against a resting room, and that is the
whole of its scope — five surfaces in the product carry a shadow when they
appear, none of which the shell puts there and none of which this task touches:

- the slash menu and the selection bubble, on `--shadow-md`, which 008 moves
  onto the raised shadow along with the rest of their shell
- the status notice pill, on `--shadow-xs`, which 009 moves onto the resting
  shadow
- the agent's change bar and its list, on `--shadow-sm` and `--shadow-md`.
  These are the ones with no task of their own — they are floating chrome over
  the page in the same family as the two above, and whoever takes 009 should
  decide whether they belong to it
- a table's grips and insert buttons, whose 1px ring is drawn in `box-shadow`
  because a `<table>` cannot contain a `<div>` to put a border on

`bun run shot:shell` takes the two pictures. It seeds one room — the same plan,
the same questionnaire, the same three lines of conversation — and opens it
twice, so the pair differ only in the width they were taken at. The transcript
is written to `state.json` rather than typed, because `chat:send` is gated on
there being an agent and this runs with `AGENT=off`; the avatars are refused at
the network so the faces fall back to initials and the picture does not depend
on who holds a GitHub handle this week.

![the shell at 1280 — one ground behind the nav and both rails, the page the only thing on it](images/005-shell-1280.png)
![the same room at 1680, where the ground either side of the page grows and the page does not](images/005-shell-1680.png)

003 is still blocked, so the three tokens this depends on are defined here
instead: `--color-ground` at gray-150, `--color-hairline` at black 7%, and
`--shadow-raised` with `--shadow-color: 14 13 10`, all at the values 003
specifies. Two sources in that task disagree about the ring — the notes say 7%
and the shadow frame says 6% — and 7% is what is written, since that is the
number stated as the passive-edge token rather than as an aside in a shadow
table.

`scripts/stack.ts` is the dev stack both of the browser scripts here start —
Vite and the server in one process, on ports the OS chose. `check:console`
needs it because a production bundle has no React invariants left to read, and
`shot:shell` because rebuilding `dist` is a long way round for a screenshot.
