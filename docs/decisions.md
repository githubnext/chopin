# Decisions

A decision can be open before anyone knows the alternatives. Use it for a choice
people need to make, such as “How should onboarding work?” Use repository
inspection or research for factual questions such as “When does onboarding run?”

In **Decisions**, choose **New decision**, write the question and optionally add
context. The new card starts open. Everyone with write access shares its working
answer and can add candidate approaches. A candidate is something to consider;
adding it does not decide the question.

Press **Record decision** to confirm the current written answer. On a phone,
the shared bar offers **Record decision** (or **Record decisions** for a batch)
when it includes a written answer you edited. The card records the person who
confirmed it. A draft, a recommendation and a casual agreement in Chat do not
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
person's answer. Its `options` may be empty or contain candidate approaches;
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
