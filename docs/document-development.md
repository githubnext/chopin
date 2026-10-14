# Developing a document from Chat

`CONVERSATION_DOCUMENT=on` lets ordinary human discussion develop provisional
prose in its root document. It requires `AGENT=on`, `BACKGROUND_JOBS=on`, and the
document's active Planner owner. It does not require Jev or
`CONVERSATION_PLAN`. The existing title worker still maintains the title with
its narrow authority.

The document can accumulate a problem statement, reported evidence, intended
experience, possible approaches, unresolved questions, or a next experiment.
The worker chooses a short structure supported by the discussion. Suggestions
remain proposals; disagreement and unanswered questions must remain visible.
It has no repository or web tools and must not turn an unverified product claim
into a repository fact. Explicit Planner requests keep their existing path.

The document's provisional-draft control shows whether updates are pending or
paused. Any repository writer can pause or resume updates for everyone. Readers
can see the state. Pausing is durable and prevents publication, including output
that was already running; pending worker jobs pause too.

## Human editing and authority

Each generated paragraph, list, or level-two/three heading receives a
server-minted passage identity, source-message IDs, an anchor, and an immutable
digest of the source Chopin wrote. These records live in the document sidecar.
They are not user-editable Markdown attributes.

Every persisted document mutation reconciles this provenance. Editing a passage
protects it permanently from automatic changes, including after undo. Removing
it or moving it in a way that loses collaborative identity orphans it. Identical
text elsewhere never grants ownership. A known checkpoint rebuild can retain
identity. Human-authored prose and the existing title/goal are never adopted.
Answered decision prose and accepted or resolved comment results are protected
independently of their MDX projections.

A browser can still be editing an earlier paragraph when an automatic
replacement commits. The server retains its collaborative history before that
replacement and saves arriving human edits in the same durable commit as their
acknowledgement. The first safe recovered passage is appended as human prose.
Further edits to that earlier version appear under **Recovered edits**, where a
writer can read the saved text, add it to the document, or dismiss it. This never
overwrites someone else's edits to the recovered copy. Readers can inspect the
saved text. Recovery remains available when automatic drafting is switched off.

Recovery validates the complete browser batch before acknowledging it. Invalid,
oversized, or causally incomplete updates receive the existing rejection and
document reset; they are never acknowledged as saved. Automatic replacement also
waits while the current document has unresolved collaborative dependencies.

The worker proposes a bounded patch. It can append ordinary blocks and
replace or remove its still-generated passages. It cannot create decision
components, rewrite a human paragraph, or replace the whole document. New
passages join the end of the document. Existing change marks show committed
agent changes through the normal editor channel.

## Scheduling and recovery

Only persisted ordinary human Chat messages trigger synthesis. Agent messages,
prose commits, headings, research output, and background work do not trigger it.
A discussion burst waits for 15 seconds of silence. The scheduler admits at most
one attempt per minute and eight per hour per document; those timestamps survive
restart. An active Planner turn or implementation defers admission.

Admission first saves an immutable context in the sidecar outbox, then enqueues
`document-development@1` through the generic background-job service. The same
outbox request can safely enqueue again after a crash. A stable document target
supersedes older work. A completed artifact is durable before reconciliation;
its receipt, new anchors, and document delta commit together before publication.
Reopening the document or regaining an owner recovers unfinished delivery. A
terminal or unchanged attempt does not run again merely because someone reads
or reconnects; a later human message permits new work.

Model work runs outside document locks. Reconciliation drains admitted browser
updates, then checks the latest human message, decision-context fingerprint,
ownership, pause state, implementation lock, and every targeted passage against
the current document. Unrelated edits can remain while safe generated passages
change. A newer conversation or decision invalidates old output. Pending browser
updates defer reconciliation rather than being overwritten.

## Bounds and data handling

The private worker has no tools or ambient capabilities. It uses one disposable
structured-output session with a 60-second deadline, one failure attempt, and
a 30-credit session ceiling. Credentials are revalidated and never stored in
input, artifacts, or provenance.

Each input contains at most 16 complete human messages and 16,000 message
characters, 32,000 document characters, 48 passage descriptions, and 24 bounded
decision summaries. The complete serialized input must also fit within 128 KiB
of UTF-8. Context that cannot fit safely is deferred. One result can
change at most eight blocks and supply 4,800 new Markdown characters. The
document retains at most 48 passage records and 12,000 generated characters.
Protected and orphaned records are retained, so ownership cannot silently return.

Before replacing or removing generated prose, the server reserves recovery
history for up to 48 retired passages and refuses further destructive automatic
changes once its retained document history exceeds 1 MiB. Human edits can still
arrive and are retained; these are admission bounds, not deletion policies.

The captured private discussion, document, and decision material is stored in
the sidecar outbox and durable job input, then sent to the configured harness's
model provider. Output artifacts and source-message provenance remain durable.
The generic job retention and deletion rules apply; see
[Background jobs](background-jobs.md#storage-and-retention).

Scripted tests establish these mutation, provenance, and recovery invariants.
They do not prove the model will always choose useful prose or correctly
interpret a disagreement; that requires separate live-model evaluation.

CI runs the control and recovery browser tests in the ordinary suite, and the
complete scripted discussion scenario separately with the feature enabled. Run
that scenario locally with:

```bash
E2E_DOCUMENT_DEVELOPMENT=1 bun run e2e e2e/document-development.e2e.ts --project=harness
```
