# Decisions

A decision can be open before anyone knows the alternatives. Use it for a choice
people need to make, such as “How should onboarding work?” Use repository
inspection or research for factual questions such as “When does onboarding run?”

A decision appears in **Decisions** as an open card when someone asks the Planner
to raise it. Everyone with write access shares its working answer. Written decisions have one answer field; choice decisions have selectable
options.

Press **Save** to submit the written answer, just like a choice decision. On a
phone, the shared **Save** bar submits the answers you edited. The card records
the person who saved it. A draft, a recommendation and a casual agreement in Chat do not
resolve a written decision.

Choose **Reopen** to reconsider an answer. The previous decision remains visible
while people develop the next one, and the record retains prior answers and
their authors. **Discard** sets the card aside while preserving its history.
Questions and context retain their original meaning; reconsidering an answer
does not silently rewrite the question.

Existing decisions with selectable alternatives keep their current behavior.

## Planner tools

`open_decisions` captures up to ten written or choice decisions in one durable batch. The
Planner first writes provisional prose, then supplies the current document revision, a stable
key and related block addresses for each card. Written responses use `response: "text"`,
`options: []`, and `multiple: false`; choices retain their existing form. Cards appear beside
their primary passage and the tool returns immediately. Retrying a key reuses the same card,
including after it has been saved or discarded. Stop Planner does not withdraw committed cards.

Each Save queues an update to the related prose. Decisions sharing a passage share its write
scope, so later answers preserve earlier saved answers. Source, updated anchors and receipts
commit together; reconnecting or retrying cannot apply the same answer twice. If the target is
lost or ambiguous, the update fails without guessing a new passage. Pending work waits for an
authorized Planner owner after restart. Draft edits and research findings do not start this
write-up. Child-focused Planner turns cannot create decisions in the root document.

`open_decision` captures a written decision and returns its identity immediately.
It takes the current document revision, a stable request key, a concise question
and optional context. Repeating a request returns the same card. The Planner
can continue inspecting or developing the document while the choice remains
open. This tool cannot confirm an answer. It creates an unanchored card without the scoped
follow-up above; the Planner uses `open_decisions` for questions beside plan prose.

`ask` also accepts `response: "text"` when the Planner needs to wait for a
person's answer. Set `options` to an empty array;
`multiple` must be false. Omitting `response` keeps the existing choice mode.

## Collaboration and persistence

Written and choice decisions use the same authoritative records, shared drafts,
native cards and submission lifecycle. A written decision adds
`response="text"` to its document projection and stores prose in the existing
answer field. Old projections without the marker retain their original meaning.

Creation commits the record, draft and document projection before announcement.
Submission claims the displayed draft revision, rejects stale saves, and commits
the answer and attribution before acknowledging it. Reconnection restores the
accepted shared draft. Reopening and discarding preserve durable history.

## Exploring a decision

Every open decision in a top-level document has one **Research** menu. It opens as a list:
**Research the web**, **Investigate the codebase** and **Ask someone**. Choosing research or an
investigation folds that row open in place (one at a time) with an optional **Details** field
and a **Start research** or **Start investigation** button; Cmd/Ctrl+Enter in the field also
starts it, and the details become the finding's focus. Investigating runs on the viewer's paired
machine and is disabled, with its reason, when none is online. Ask someone folds open into the
list of other members. While research or an investigation runs, the button reads **Researching**
and the menu shows what it is focused on, **Stop** and Ask someone; Save stays enabled. The
button becomes a quiet capsule ("Researching" or "Investigating" with a spinner). Nothing shows in
the card body: once work has finished, a quiet "N findings" button at the footer's left opens the
decision's page.

What comes back is a **finding** on the decision's record:
`{ id, kind: "research" | "spike" | "ask", status, focus?, ref, title?, summary?, sources?,
sourceCount?, branch?, childId?, by, at }`, at most 20 per record. The browser starts
research and investigations through their existing HTTP routes, so their authorization, Planner owner and
paired-machine checks are unchanged, then sends `question:explore` with the request or
investigation id. The server checks that the work belongs to the document, persists a running
finding, and only then replies and announces `question:meta`. When a research request reaches
ready or failed, or an investigation finishes, the server settles every running finding that
follows it, idempotently, and posts a Chat notice. `question:explore-stop` stops the work and
marks the finding stopped.

A running finding never waits on a missed event. Attaching work that has already ended settles the
finding at once. Cancelling a research request settles it as stopped, and a failed request that is
retried to ready updates its failed finding. A sweep also runs whenever a top-level document opens
(rooms open lazily, so that covers startup), settling any running research or investigation
finding whose work is terminal; a failed settle commit is logged and retried by the next sweep.
Only the person who started a running finding can stop it, and an ask is stopped by its asker.
`question:take`, stop and page refuse while an implementation is active, and a take also needs
the ask to be running on an open decision. Logins compare case-insensitively. At 20 findings the
oldest settled research or investigation makes room; takes and running work are never dropped, and
adding refuses when nothing can go.

Asking someone records a running `ask` finding, shows an amber "Waiting for Sam" status in the card footer, and
posts a Chat notice that names them. Only the asked member can answer, with `question:take`;
their reply becomes the finding's summary and appears under **Takes** on the decision's page. The reply may carry a `stance`, `supports` or `objects`, which the page shows as a chip beside their name; the server stores only those two values, and only on an `ask` finding.

Ready findings feed the settle write-up's prompt as context, beside the discussion's reasons.

## A decision's page

**Expand decision** turns a decision in a top-level document into its own child document. The
channel id is deterministic (`question:<recordId>` within the repository), so a retry or a second
member finds the same page; the record learns `childId` only after the channel exists. The child's
body is the decision's Notes. The page's actions sit in the child's title bar, after Back, the
parent's crumb and the question: a **⋯** menu (Copy link, and **Discard decision…**, which asks
for confirmation), then at the end **Research** and **Save**.
Save submits the same shared draft as the control in the body and stays disabled until the
decision is answerable. When settled, an outline **Reopen** replaces them. Phones and compact
layouts, which have no such bar, show the same actions above the status pill.

Above the Notes, the page shows what the root's record says, on the paper with no card around it,
in this order: a status row (a pill reading Open, Exploring, Waiting for or Settled; waiting is followed by the asked people's faces and names, settled by the settler's face and "by Ada, 19 Oct"; the card footer keeps its own waiting pill), the question,
and the control, which is the options or written-answer field at page width with no box and no
footer. Once settled the control stays where it was, read-only, with the saved option selected
or the written answer in the field; there is no separate answer block or heading. **Findings** (hidden when empty)
follow, each expanded by default with its summary, plain source links and branch. **Takes**
appear only if someone was asked. **Notes** is always present and shows an "Add a note"
placeholder while empty. A child document's own decisions cannot open as pages.
