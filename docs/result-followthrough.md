# Following findings into the document

Publishing a research report or an ordinary investigation queues a review in its
parent's Chat. The Planner compares the result with the current document and human
decisions, revises affected provisional prose when warranted, links its evidence,
and explains the next useful decision or experiment. It may conclude that no edit
is needed, including when people changed direction while the work ran.

The report stays an ordinary child document. Its original captured result is
evidence; later human edits to the child remain part of the current context.
Contradictory findings should visibly revise a recommendation without replacing a
recorded human decision. Report completion does not establish that a hypothesis
was true or that a build blocker was resolved.

## Delivery and recovery

The child publication transaction also inserts a `result_followthrough` receipt.
Its immutable identity is the parent, source kind, source ID, and result key:
the initial research answer job ID or the investigation generation. Changes to
filters, evidence decisions, or a source record's revision do not create another
review. Failed or cancelled work publishes no receipt. Historical results are
not backfilled; automatic prototype spikes retain their separate settlement flow.

One result per parent enters the existing Planner queue at a time. Queue admission
leaves the receipt pending. Immediately before model execution, an awaited
preparation checks current source identity, document scope, ownership, connected
Planner capability, and implementation state. The durable claim precedes the
review notice and model stream. Receipt changes publish only after persistence.

| State   | Meaning                                                                 |
| ------- | ----------------------------------------------------------------------- |
| Pending | Published evidence is waiting for an eligible Planner turn.             |
| Running | The durable claim succeeded and a review is starting or underway.       |
| Done    | The review finished and left an explanation; edits are not required.    |
| Failed  | The review failed, was interrupted, or finished without an explanation. |
| Skipped | A writer dismissed it or its original document scope no longer applies. |

The review uses the parent's existing owner and never claims someone else's
credentials. Missing ownership, a disconnected remote Planner, or an active build
leaves it pending. Publication, room opening, owner availability, and build unlock
wake pending work. Coalesced delayed wakeups preserve events arriving while an
attempt is finishing without repeatedly appending Chat notices.

The card shows the current status. Writers can **Dismiss review** while pending
or failed, or **Retry review** after failure. These actions change scheduling;
they do not launch new research or local code. A proposed next investigation
still requires a person to select Run. Readers can open the evidence and observe
the review status. Reconnecting an authenticated session refreshes retained result
cards, including reports whose publication finished earlier.

Startup changes interrupted running receipts to failed. Once model work may have
started, neither reconnects nor repeated reads automatically replay it: earlier
tool edits may already be durable. An explicit retry preserves the result
identity and creates a new guarded attempt. A finalization failure likewise
leaves the attempt uncertain until recovery, rather than guessing it is safe to
repeat.

Current source schemas do not link results to an authoritative originating
question ID. A different parent revision or an unrelated cancelled decision is
therefore insufficient to discard evidence. The Planner compares current prose,
decisions, and recent conversation to assess a changed direction. Archived,
missing, mismatched, or superseded result identities are rejected structurally.

The review has the same owner-bound investigation proposal and blocker controls
as a readiness review. A blocker can clear only when incorporated evidence and
any necessary human choices resolve it; failed or inconclusive execution is not
positive evidence. Historical cards and dismissed reviews with an unresolved
blocker retain their manual **Apply findings** action.
