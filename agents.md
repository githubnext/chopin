# Working on chopin

Notes for whoever changes this next, human or otherwise. The readme is for
people running it; this is for people editing it.

## Before pushing

Run the complete repository checks:

```bash
bun run ci
bun run types
bun test
bun run e2e
```

A non-zero result is blocking, even when the failing file predates the current
work. Fix it or ask before pushing. Scoped checks are useful while iterating,
but never replace these full commands.

## Commands

```bash
bun run dev        # supervisor: Vite + server on one origin, Ctrl-C stops both
bun test           # 525 tests, no browser, no agent spawned
bun run e2e        # 49 tests, Chromium, builds the client first
bun run types      # every package, and e2e
bun run ci         # dprint check && oxlint
bun run build      # production client
bun run start      # serve the built client
```

`.github/workflows/ci.yml` runs all four checks on every push and pull request,
in two jobs: `bun run ci`, `bun run types` and `bun test` together, and the
browser suite on its own because it has to build the client first and should
not make a formatting mistake wait behind Vite. A failed browser run uploads
its report and traces.

`bun run dev` needs `GITHUB_TOKEN`. `AGENT=off` runs everything except the
agent, which is what both suites use.

`bun run e2e` needs a browser once: `bun run e2e:browsers`. It builds the
client, then starts two servers of its own — 8788, and 8789 with the injection
flags on — so having `bun run dev` open at the same time costs nothing.

To iterate against a server you are already running, skipping the build and the
supervision, give it the three things the suite assumes and name it:

```bash
PORT=8790 AGENT=off DATA_DIR="$PWD/e2e/.scratch/8790" \
  DEV_QUESTIONS=1 DEV_COMMENTS=1 bun apps/server/src/main.ts
E2E_BASE_URL=http://127.0.0.1:8790 bun node_modules/@playwright/test/cli.js \
  test --config e2e/playwright.config.ts
```

The `DATA_DIR` is not decoration: tests that need prose before anybody opens
the room write it themselves, and they derive where from the port in the base
URL. Point it elsewhere and they seed a directory the server never reads.

## Shape

```
packages/dialect     4.6k   the MDX dialect and its Lexical schema
packages/editor     10.5k   the browser editor, cursors, the sidecar, agent marks
packages/question    1.8k   questionnaires: definition, shared answer, derivation
packages/protocol    0.9k   the wire, as types, plus the addressing rule
apps/server         11.4k   rooms, documents, questions, comments, the agent
apps/web             1.5k   the three panes
e2e                  1.3k   the browser suite, and the servers it runs against
scripts/dev.ts              the development supervisor
```

Dependencies point one way: `apps` depend on `packages`, `packages` depend on
`protocol`, and nothing depends on an app. `protocol` is types plus one runtime
module — the rule for whether a message addresses the agent, which both ends
need and must not disagree about.

## How a room works

Each room holds a Yjs document with a **headless Lexical editor bound to it**.
That mirror is the reason the server can validate an edit rather than relay
bytes it cannot read: it turns opaque CRDT updates into a tree that can be
projected back to canonical MDX with nobody connected.

Client updates are grouped for 5ms, applied together, and only then
acknowledged. Yjs cannot undo a transaction, so a batch that leaves the
document invalid is not rolled back — the document is rebuilt from its last
known-good state under a fresh epoch and everyone re-opens.

Agent edits take a different path. They are staged on the parsed document,
serialised, re-parsed, validated, and only then _reconciled_ into the live
tree, so blocks the agent did not touch keep their Lexical identity and nobody
loses a cursor to somebody else's edit.

Canonical MDX goes to `data/<room>/plan.mdx` on a debounce, with questionnaire
records, comment threads, anchors and the transcript beside it. Yjs history is
deliberately not persisted: it would buy undo across a restart at the price of
a binary checkpoint that could disagree with the source.

## Decisions, and why

**The dialect is an allowlist.** Anything not described in
`packages/dialect/src/dialect.ts` is rejected before it reaches a renderer.
Plan content is parsed and rendered, never evaluated.

**The permission gate is the only boundary.** There is no sandbox — this runs
as you, on your filesystem. So `apps/server/src/agent/permissions.ts` is an
allowlist: writes refused outright rather than confined, reads limited to
`WORKING_DIR` with credential patterns excluded, shell limited to commands the
runtime classifies read-only, unrecognised kinds denied. Read it before
pointing the agent at anything you care about.

**Ids are minted wherever a component is created**, client or server. A ULID
has enough entropy that two editors cannot collide, so buying uniqueness with a
round trip would only make a block appear later than the keystroke that asked
for it. The agent's ids are minted server-side in `plan/edit.ts` because a
model that copies a block it read copies the id with it.

**The record owns an answer; the plan shows it.** A questionnaire's answer
lives in `data/<room>/state.json`, and what appears in the MDX is a projection
kept so the source reads correctly alone. An agent rewriting the prose around a
decision cannot change the decision.

**Resolution is two-phase.** Answering has to reach both the record and the
document, and until both have happened nobody may be told it is final. A failed
document write rolls the claim back and the questionnaire stays open.

**The agent acts only when addressed** with `@ai`. Everything else is
conversation, carried into its next turn as context. Without this, two people
planning together cannot talk — "should we ask about auth first?" would start a
turn. Not `@plan`: it is the most common noun in the product.

**Accepting a comment is an address.** The `@ai` rule separates conversation
from instruction, and a button press is already the latter — so accept starts a
turn, through the same queue a message does. It writes a system line into the
transcript, because an agent that begins editing for no visible reason is worse
than a noisy log. Accepting also freezes the thread: it is what the room
settled, so `edit_plan` cannot author or remove the `<Decision>` it projects.

**Anchors are a relative position plus a digest**, and the two do different
jobs. The position survives edits around a block; the digest recovers it when
the position cannot resolve — a move rebuilds a block's collaborative identity,
and an epoch rotation discards the history the position was expressed in. A
digest matching two blocks recovers neither.

**A passage is the same idea one level finer.** A comment marks a phrase, not a
block, so it carries the block anchors plus a pair of relative positions into
the text and the quoted words. The positions make the highlight stretch as
somebody types inside the phrase; the quote finds it again when they cannot
resolve. Two occurrences equally near the recorded offset recover neither.

**A client sends what it read, not where it thinks that is.** `comment:start`
carries block indices and the selected text; the server finds the quote and
mints every Yjs position itself. Finding it is the concurrency check, and a
better one than a digest — it tests whether the sentence is still there, which
is what matters, and a browser cannot compute a canonical block digest without
re-serialising the document. The two ends must agree on which blocks the source
addresses; they need not agree on the offset, so a divergence surfaces as a
refusal rather than a comment landing on the wrong sentence.

**A decision has one place in the plan, not two.** A question used to carry
what it was about and what its answer produced as separate anchor sets, on the
theory that they move independently. Asked to tell them apart, the agent
anchored the first block of the result and called it the subject — in every
record it ever wrote — so a resolved card offered two adjacent, identically
labelled buttons that led to the same block. The subject was also never derived
when a question was asked and never invalidated when the plan moved, so it sat
permanently unreviewed: an inert link, and an entry in `anchors_pending` that no
amount of anchoring could clear. A comment thread still keeps two, because there
the halves have different authors and different shapes and neither can stand for
the other.

**The quote is the way back, not the card.** A sidecar card holds a reply box,
an Accept and a Dismiss, so making the whole of it a link would mean deciding on
every click whether the reader meant the link or the control they actually hit.
The quotation becomes a button when the thread has somewhere to send one and
stays a blockquote when it does not, which is the rule a question's answer
already followed. It matters most for an accepted comment: a `<Decision>` draws
nothing in the prose, so the pane is the whole of where the decision can be seen
and the quote is the only route to what it produced.

**A table's header row is furniture, not a row.** GFM has exactly one header
and it is always the first, so nothing in the document marks it as one — being
first is the whole of what makes it the header, and the column alignment hangs
off its cells. A drag that moved it would therefore not reorder the table so
much as change what it claims: two rows would swap meaning at the next save and
the alignment would follow whichever stopped being the header. So the header
cannot be dragged, cannot be dropped onto, cannot be removed, and nothing can
be inserted above it. Its bar is still drawn, because a rail with a gap where
a row plainly is reads as a bug. The last _body_ row can go, though —
`| a |\n| - |\n` is well formed and round-trips, and refusing it would mean the
only way to empty a table is to delete it.

**The rails are measured, because a `<table>` cannot contain a `<div>`.** Every
other widget in the editor puts its chrome in a `data-plan-chrome` slot the
node reserves and Lexical is told to leave alone. A table has nowhere to put
one: the browser hoists a stray div straight back out. So the choice was
between subclassing `TableNode` and measuring cell rectangles, and measuring is
what the selection bubble already does. The grips are one lane and the buttons
another, with nothing overlapping — a cross in the middle of a grip is exactly
where a drag is most naturally begun, and it swallowed the gesture it was drawn
beside. Intermittently, too, since whether it had become live yet depended on a
re-render landing between the pointer arriving and the button going down.

**A limit is enforced where the button is, not where the document is.** A table
past `MAX_TABLE_ROWS` or `MAX_TABLE_COLUMNS` applies locally, syncs cleanly and
is then refused by the server — which cannot undo a Yjs transaction, so it
rebuilds the room under a fresh epoch and everyone in it loses their undo and
their cursors. `table/shape.ts` is asked before anything is created, so the
cost of reaching a hundred rows is a grey button rather than everybody's
session. The same argument as `toolbar/url.ts`, one order of magnitude worse.

**A rendered fence is a second reading, never the document.** `@pierre/diffs`
colours code and draws patches, and it is asked for nothing else: it has an
edit mode, and turning it on would put a character model of its own beside the
one the room is collaborating in, so that two people typing would each be
correcting a copy. The source stays where it was, as Lexical text children
under Yjs, directly editable underneath what was drawn from it. It arrives on
demand, because Shiki's grammars outweigh everything else the editor loads and
a plan with no code in it should pay none of that.

**A fence with no language draws nothing**, and that is the whole of what makes
the control worth having. Uncoloured text above the same uncoloured text is two
of the same thing with a caret in only one of them; naming the language is what
turns the upper one into something the lower one is not. So `/code` opens a
fence with a selector and no preview, and choosing from it is an edit to the
fence like any other — it syncs, it saves, and everybody else's copy is
coloured too.

**A patch is repaired on the way to the renderer, and nowhere else.** Nobody
writes a hunk header correctly, least of all a model quoting a change it is
proposing, and the counts in one are how a parser knows where the hunk ends —
so a count that is too low truncates the change silently, which is the one
outcome worth any amount of trouble to avoid. `widgets/code.ts` recounts them
from the lines that are actually there, reads a stripped blank line as the
unchanged line it was, and takes off the `a/` and `b/` that the renderer only
removes for git's own form. What comes out is handed over and thrown away; the
fence keeps every byte the author wrote. Anything still malformed is refused by
the parser and drawn as coloured text, which is the honest rendering of a
fragment that was never a patch.

**Enter is a newline in a fence, and twice over is the way out.** Lexical asks
a block to make its own successor and a code block returns null, which is why
Enter inside one did nothing whatsoever — no newline, and no way past a fence
sitting at the end of a plan. `widgets/enter.tsx` answers
`INSERT_PARAGRAPH_COMMAND` rather than the keystroke, because that is what rich
text turns an unshifted Enter into and what everything else meaning "start a
new block" dispatches. The blank line that asked to leave goes with the
request, or every fence anybody escaped would keep a trailing empty line
nobody typed.

**A hover asks; a click sends.** Both leave the same wash, because they are the
same fact — this is the prose that card refers to — and the difference is how
long it is owed. A hover is over when the pointer moves; a click has put the
reader somewhere they were not looking, so the mark is pinned for five seconds
after the pointer has gone, or they arrive at a block with nothing to say which
one it was. Pointing at another card in the meantime borrows the wash and gives
it back, which is what makes a detour a detour.

**There is one pin, in `marks.ts`, not one per store.** A reader has one
pointer, so going to a comment has to put out the question they went to before
it — the same argument that already put the registry there. Whether a walk
through several places continues is asked of the pin rather than announced by
it: nothing needs redrawing when it lapses, since the lapse redraws itself, and
a callback fired on the way to replacing a pin would reach a store in the middle
of walking and wipe the step it had just taken.

**Hard-fail at boot.** A missing token, an unusable CLI or a `WORKING_DIR` that
is not there are all detectable in seconds by trying, and discovering them when
somebody types their first message is worse. `AGENT=off` is the deliberate way
to run without one.

**A mark for an agent edit waits to be seen.** The agent writes wherever it
likes, including several screens away from whoever is reading, so a mark that
spent its few seconds off screen would have told nobody anything. Nothing
starts counting down until it has been in the viewport, which makes it an
unread marker rather than a flash — and unread markers do not expire on a
clock, so an unseen one waits indefinitely and the set is bounded by a cap
instead. Once seen the clock runs whether or not the mark is still in view: two
states and one timer, so nothing can go dark and light up again on a later
scroll, which would read as a second edit that never happened.

**Those marks take no space and add no element.** An agent editing below the
fold must not shift the sentence somebody is in the middle of typing, and a
mark expiring a few seconds later must not shift it back. What the agent removed
has no element at all, which is why a hole is drawn in `box-shadow` on the edge
of the block still beside it and why the side is part of its address — and why
what was removed can only be read in the list behind the chips.

**The agent's cursor and the agent's marks disagree about time, on purpose.**
The cursor is presence: it says the agent is working _here, now_, so it is
broadcast the moment an edit lands, it is not held back for anyone, and it goes
shortly after the turn ends. A mark is a record: it waits until it has been
read and may sit unseen indefinitely. So somebody who comes back after a long
turn sees marks and no cursor, and somebody watching sees both — which looks
like an inconsistency until you notice they answer different questions. The
cursor cannot replace the marks, because a cursor off screen is simply not
there, and that is the case the marks exist for.

**It sits at the end of what the agent wrote, and says its name for longer.**
An anchor names a block from its start, which is the stable end of one; a
cursor is where an edit _finished_, so `room.endOf` is its own function rather
than a flag on `anchorAt`. A caret at the top of a new block points at the
first thing the reader already knows and looks like something about to be
typed. The label keeps the same distinction: a person's caret is one of several
and its owner is watching it, so a second names them and that is enough, while
the agent's turns up unannounced in a document somebody else is reading and the
naming is the entire point of drawing it.

**The agent rides in the presence mirror's own local slot.** Everything else
in `plan/presence.ts` is a reflection of some socket, which is what lets a
disconnect clear it; the agent has no socket, so it goes where nothing can
attribute it to one. That slot is also in the join snapshot, so somebody
arriving mid-turn sees where the agent is.

## Things that fail silently

Every bug found in this project so far was invisible. These are the mechanisms.

**An unhandled node type kills collaboration.** MDXEditor re-serialises the
document on every update, and a type its serialiser cannot write throws inside
the first update listener — which stops every listener after it, including the
one that syncs. The editor keeps accepting edits and none of them leave the
browser. `registry.test.ts` asserts every dialect node is writable; keep it
passing when you touch the dialect.

**Lexical swallows errors thrown inside `editor.update()`**, routing them to the
editor's `onError`. A seeding failure looked like an empty document until
`plan/room.ts` started carrying the error out by hand.

**Everything in an SDK event lives under `event.data`**, and several fields have
near-homonyms on the envelope. `event.id` is the event's; `event.data.messageId`
is the message's. Reading the wrong one produced a duplicated reply and a
streaming caret that never stopped. Nothing throws.

**`session.send()` resolves when the message is accepted, not when the turn
ends.** Waiting on it alone tears the handler down before the agent has said
anything. Turns end on `session.idle`.

**A custom agent's `tools` list cannot admit MCP tools.** Not by wildcard, not
by exact name, not with the server declared on the agent. The entry matches
nothing and is dropped without a word, and the agent then explains its way
around the absence. The session's `availableTools` is the filter that
understands `builtin:`, `mcp:` and `custom:` prefixes — the allowlist lives
there, and the agent declares none of its own.

**Permission is decided before execution**, so a refused tool produces no start
and no completion. `chat/service.ts` renders `permission.completed` denials as
failed tool chips; without that a boundary the agent keeps hitting is invisible.

**Tailwind v4 translate utilities emit the `translate` property**, not
`transform`. They compose rather than override, so an element positioned by
script must not also carry them.

**A grammar the highlighter does not have rejects a promise nobody is
watching.** `@pierre/diffs` starts its first highlight from a render and never
attaches a handler to it, so a fence saying `foobar` — or `pseudocode`, which a
model will write — resolves nothing, renders nothing, and leaves a block that
is simply blank. `code-view.tsx` asks `resolveLanguage` first and falls back to
plain text, which is also why the answer is cached: the question is asked again
on every keystroke in the block.

**One preview slot, two writers, and the loser is whoever committed first.**
The rendered output used to be assigned as `innerHTML` and the code renderer is
React, so a fence that changed language from `mermaid` had to clear the slot on
the way out — and a passive effect's cleanup runs _after_ React has already
inserted the next renderer's nodes into it. Everything in `data-plan-preview`
is React's now, including the markup KaTeX and Mermaid produce as strings.

**A `<select>` in the document answers to `getByRole("option")`.** The slash
menu is a listbox of options and so, to a browser, is the language control
beside every fence — so an unscoped option locator in the browser suite matches
both and resolves to thirty elements. Every existing one is scoped to the menu;
keep them that way.

**A library that paints through the theme paints nothing when the theme is
silent.** `@lexical/table` marks a selected cell by adding
`theme.tableCellSelected` and does nothing else — no inline style, no fallback
— and MDXEditor's `lexicalTheme` names no table class of any kind. So dragging
across cells produced a live `TableSelection` that was completely invisible,
and the next keystroke replaced everything it covered. The entries are in
`plan-editor.tsx` beside the `collaboration` block, which is there for the
identical reason.

**`$moveTableRow` and `$moveTableColumn` return silently on a table with merged
cells**, which is why `shape.ts` carries `simple` and the grips go inert rather
than becoming drags that do nothing. A plan cannot contain a merged cell — GFM
cannot write one, and the export visitor ignores spans — but a paste can still
introduce one, so `registerTableCellUnmergeTransform` is registered to take
them back out.

**A rail that lets pointer events through has a hole wherever it has no
control.** `pointerleave` fires the moment the pointer crosses one, so the
first version blinked the rails out from under a hand moving along them,
whenever it passed the header's bar. The rail takes events across the whole of
itself now and accepts that it covers 28px of gutter for as long as its table
is the one being pointed at.

**A seam is on the edge, so what is drawn on one straddles it.** The rail
clips, to hide a grip belonging to a column scrolled out of the table's own
scroller — and that clip cut the first and last insert buttons in half, which
are the two most likely to be wanted. The rail carries half a seam of slack at
each end for this, and measures its origin from its own edge rather than the
table's so the two cannot disagree.

**A transport comes up on its own schedule; whatever mounted against it does
not.** The provider opened the document once, when the editor mounted, so a
socket still mid-handshake cost the plan entirely — `ask` refused, nothing
tried again, and the editor sat locked for the session under a status chip
still saying "Loading". The same gap swallowed reconnects: `#open` is the only
thing that asks for what was missed and the only thing that replays the outbox,
so a client came back unlocked over a document quietly short of everyone else's
edits. Opening is driven by the connection now, not by the mount.

**A gate on a message is not a gate on a button.** `chat:send` checks
`config.agent`; accepting a comment reached `Chat.instruct` directly and opened
a session under `AGENT=off`. Anything that can start a turn has to check, and
the check lives in `instruct` now so the next one cannot miss it.

**A record read back from disk is not checked by anything.** `Anchors.read`
hands back what `JSON.parse` produced, cast to the current type, so changing the
shape of anything under `data/<room>/state.json` is somebody's existing room
breaking rather than a type error here. It does not even break loudly: the carry
on open is guarded, so a set the new code cannot read is caught, logged once,
and every decision in the plan quietly loses its place — and because that guard
is shared, one stale questionnaire takes the comment threads' anchors with it.
`folded` is where the last such change is absorbed, and where the next one goes.

**An optional callback nobody passes is a button that does nothing.**
`QuestionView` rendered a real `<button>` labelled "Show in plan", with a
pointer cursor and a count of how many places it would go to, calling an
`onRelationSelect` that no caller ever supplied — `QuestionnaireCard` forwarded
the two hover props beside it and dropped this one. It typechecks, it renders,
it takes a tab stop, and it is inert. The same wiring in reverse is worth
watching for: the tabs called `onRelationSelect` too, which read as harmless
for as long as it was undefined and became the plan scrolling out from under
somebody the moment it was not.

**Rebasing used to happen only inside `edit_plan`.** So a block a person moved
kept its anchors broken until the agent next happened to edit, and everything
restored from disk was expressed in a history the new document did not have.
It now runs on the snapshot debounce, on an epoch rotation, and before `open`
returns — and the flush broadcasts only when the snapshot actually moved,
because a recovery nobody is told about is the same as no recovery.

**`CSS.highlights` is a document-wide registry**, shared with Lexical's remote
cursors. Ours is named `plan-related`, its are `lexical-cursor-*`; a collision
would silently unpaint somebody's selection.

**Awareness ignores an update whose clock has not advanced**, and ignoring it
means not refreshing the timer either. A peer drops a state it has not heard
about for thirty seconds, so a cursor that outlives that has to be repeated —
and repeating it by re-encoding the same state does nothing at all. The state
has to be set again. Get this wrong and the agent's cursor vanishes partway
through a long turn with nothing anywhere to say why.

**An `IntersectionObserver` threshold is a fraction of the element**, not of
the viewport. A block taller than the window can never reach `0.2`, so gating
anything on a ratio silently excludes exactly the blocks most worth noticing. A
negative `rootMargin` is the way to say "meaningfully on screen" for a block of
any size.

**An element that crosses the viewport in one frame produces no entry.** Its
ratio is zero on both sides of a `scrollIntoView` or a scrollbar drag, so an
observer watching for a crossing sees nothing and whatever was derived from the
last one it did see is stale. `changes.ts` re-reads rectangles after any scroll
longer than the viewport for this reason.

**A block's index moves when anything above it is inserted.** Comparing indices
before and after an edit therefore reports most of the document as having moved
whenever one paragraph is added at the top. What genuinely moved is knowable
only from the operations that were asked for, which is why `edit.ts` derives
what was written from object identity and what moved or went from the batch.

**`bun run <script>` does not exit when what it started dies.** It sits there
with no child. `scripts/dev.ts` spawns both processes directly for this reason,
and gives each its own process group so the whole tree can be taken down.

**Vite's `strictPort` does not catch a second instance** when the two bind
different address families, which is why the dev server binds `127.0.0.1`
explicitly rather than `localhost`.

**Bun's runner claims `.spec.` as well as `.test.`.** A Playwright file under
either name is collected by `bun test`, which then fails on an import it cannot
satisfy — so the browser suite is `*.e2e.ts` and the Playwright config matches
that instead of its own default. Naming one `.spec.ts` breaks the unit run, in
a file the unit run has no business reading.

**Playwright's web servers start before its `globalSetup`.** So a setup that
checks for the built client is unreachable when there isn't one: the server
answers 404 for the `dist` it cannot find, Playwright polls for a minute and
reports a timeout against a URL, and the check that would have explained it
never runs. The guard is at the top of `playwright.config.ts` instead, which is
evaluated before anything is started.

**The client is built by `bun run e2e`, not from inside the config.** A build
racing servers that are already answering would leave the suite testing the
_previous_ bundle — green, about code nobody changed. `dist` lingers, so
`playwright test` invoked directly serves whatever was last built; the guard
only refuses when there is nothing there at all.

**A `globalTeardown` runs while the web servers are still up.** So the obvious
place to remove the suite's rooms is one where the snapshot debounce writes
some of them back: the last test's room is saved 500ms after the wipe, and the
tree ends up mostly empty and never quite. `setup.ts` clears it on the way in
instead, which is exact — a server writes nothing until a room is opened — and
leaves a failed run's plan beside the trace that failed on it.

**`context.setOffline` leaves an established socket alone.** It governs what
may be opened, and by the time there is a connection worth dropping the opening
has happened — so the editor stays unlocked and a test written the obvious way
asserts nothing. `page.routeWebSocket` proxies it, and can therefore close it.

**An accessible name matches as a substring.** "Remove row 4" contains "Move
row 4", so `getByRole("button", { name: "Move row 4" })` resolves to the grip
_and_ the button that deletes the row, and refuses to act on either. It reads
as a flaky selector and is a strict-mode violation every time.

**A mark on the prose is not in the DOM.** The related-passage wash is painted
through `CSS.highlights`, which takes no space and adds no element — that is
the whole point of it — so it can only be read with `CSS.highlights.get`.
`data-plan-related` is the fallback for a browser without the registry, and
asserting on it in Chromium is asserting on the path that never runs.

**`ControlOrMeta+Home` is not the start of the document on a Mac**, and a
keystroke a platform does not recognise is not an error — it is nothing at all,
followed by typing that lands wherever the caret already was. Two people aiming
at opposite ends of one fence both wrote at the end of it, which reads exactly
like a merge that lost an edit. Select everything and collapse the selection
with an arrow instead: it says which end without naming a key.

## Conventions

Tabs, `let` over `const`, double quotes, no semicolon-free style — `dprint fmt`
settles all of it. `oxlint` is the linter; `oxc/no-map-spread` is off because
these records are copy-on-write by intent.

Comments explain _why_, and are worth writing where the reason is not
recoverable from the code. Most of the comments in this repository exist
because something above surprised somebody.

Tests describe behaviour rather than implementation, and their names read as
sentences about what the system does. Prefer a test that fails when the
behaviour regresses over one that fails when the code is rearranged.

**There is no DOM in the `bun test` runtime** — no happy-dom, no preload,
`document` is undefined — so anything that reaches for an element, a rectangle
or an observer cannot be covered there at all. The answer is not to add one but
to keep the part worth testing separable from the part that needs a browser:
`trail.ts` is the whole of the mark lifecycle with no document in it, and
`changes.ts` is the adapter that has one.

The adapters are what `e2e` is for, and only those. A behaviour that can be
asserted without a browser belongs in `bun test`, which runs in eighteen
seconds and does not depend on a rectangle being where it was last week —
measured rails, a pointer drag, a caret painted for somebody else, a wash in
`CSS.highlights`. Selectors come from roles, labels and the `data-plan-*`
attributes the product already carries; nothing here has added a `data-testid`,
and a test that wants one is usually a test asking for the wrong thing.

## Diagnostics

The agent prints what it can actually call, once per session:

```
[agent] 41 tools: anchor_plan, ask, bash, edit_plan, github/get_commit, …
[agent] github mcp: 29 tools offered
```

That line exists because a dropped tool is otherwise undetectable. If the agent
starts claiming it cannot do something, read it before anything else.

`DEV_QUESTIONS=1` makes a room ask a sample questionnaire on open, which
exercises the whole question path without an agent. `DEV_COMMENTS=1` marks a
real phrase in whatever the room already holds, which does the same for
passages — anchoring, carrying across edits, freezing into a decision — before
any of it has a sidecar to be driven from.

## Origins

The dialect, the editor and the questionnaire model began as a port of Ace's
plan feature, restructured to stand alone: no sandbox, no VM, one server, rooms
in memory. It is a one-time port — work happens here now, and there is no
attempt to track upstream.

Several defects were ported along with the code and fixed here: a link prompt
that inserted unvalidated URLs and cost the room its epoch, a selection toolbar
placed twice, an edge correction measuring its own output, and the `github/*`
tool entry that never resolved. If you work on Ace too, they are still there.
