# Decisions

A decision can be open before anyone knows the alternatives. Use it for a choice
people need to make, such as “How should onboarding work?” Use repository
inspection or research for factual questions such as “When does onboarding run?”

In **Decisions**, choose **New decision**, write the question and optionally add
context. The new card starts open. Everyone with write access shares its working
answer. Written decisions have one answer field; choice decisions have selectable
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

`open_decision` captures a written decision and returns its identity immediately.
It takes the current document revision, a stable request key, a concise question
and optional context. Repeating a request returns the same card. The Planner
can continue inspecting or developing the document while the choice remains
open. This tool cannot confirm an answer.

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
sourceCount?, verdict?, branch?, childId?, by, at }`, at most 20 per record. The browser starts
research and investigations through their existing HTTP routes, so their authorization, Planner owner and
paired-machine checks are unchanged, then sends `question:explore` with the request or
investigation id. The server checks that the work belongs to the document, persists a running
finding, and only then replies and announces `question:meta`. When a research request reaches
ready or failed, or an investigation finishes, the server settles every running finding that
follows it, idempotently, and posts a Chat notice. `question:explore-stop` stops the work and
marks the finding stopped.

Asking someone records a running `ask` finding, shows an amber "Waiting for Sam" status in the card footer, and
posts a Chat notice that names them. Only the asked member can answer, with `question:take`;
their reply becomes the finding's summary and appears under **Takes** on the decision's page.

Ready findings feed the settle write-up's prompt as context, beside the discussion's reasons.

## A decision's page

**Expand decision** turns a decision in a top-level document into its own child document. The
channel id is deterministic (`question:<recordId>` within the repository), so a retry or a second
member finds the same page; the record learns `childId` only after the channel exists. The child's
body is the decision's Notes. Above it, the page shows what the root's record says, on the paper
with no card around it. A top row holds the status pill (Open, Exploring, Waiting for a member,
or Settled) and the faces of the people in the decision, then the question. An open decision shows
its options or written-answer field and one action row (Research, Discard, Save); who it is
waiting for appears only in the pill. A settled decision shows its answer once with who settled
it and a **Reopen** button, and for a choice question a plain list of what was considered with the
chosen option tinted; a written answer has no such list. Findings and Takes follow. A child
document's own decisions cannot open as pages.
