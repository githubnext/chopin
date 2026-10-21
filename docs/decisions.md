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

Saving a decision the Planner left open, whether captured with `open_decisions` or
`open_decision` or asked with `ask` by a turn that has since ended, also starts one Planner turn
that carries the saved answer, so the Planner acts on it: an answer that chose "start a new run"
starts one. Chat shows a system notice naming who answered, and the turn leaves an anchored
card's passage to its write-up. Like other turns nobody typed, it runs only under the existing
Planner owner, and under `HARNESS=remote` only while a Planner is attached; it never claims
ownership. An answer that found no Planner starts once an owner appears or a Planner attaches,
unless the server restarts first. Reopening or saving again makes a waiting answer stale. An
answer a blocking `ask` or a workflow's question is waiting for returns to it instead.

After a foreground rewrite, `anchor_plan` explicitly reviews the replacement passage and
refreshes its saved write-up links and future write scope in the same durable commit.
Decisions sharing a scope must be re-anchored together to the same passage. A scope contains
at most eight ordinary paragraphs, native diagrams or tables; intervening decision cards are
preserved, and unrelated gaps are refused. Re-anchoring does not claim an unwritten answer
was applied or retry failed work automatically. **Retry** keeps the failed job's identity and
uses the current reviewed passage and saved answers.

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
retried to ready updates its failed finding. A failed job ends its request the same way a completed one does, and a failed request posts a
quiet Chat notice. A sweep also runs whenever a top-level document opens and whenever a member
(re)opens it while the room stays loaded, settling any running research or investigation
finding whose work is terminal; a failed settle commit is logged and retried by the next sweep.
Stopping work that already ended, or that refuses to cancel, still settles the finding: failed if
the work failed, completed work as its result, stopped otherwise. Only the person who started a
running finding can stop it, and an ask is stopped by its asker.
`question:take`, stop and page refuse while an implementation is active, and a take also needs
the ask to be running on an open decision. Logins compare case-insensitively. At 20 findings the
oldest settled research or investigation makes room; takes and running work are never dropped, and
adding refuses when nothing can go.

With demo personas enabled, a roster persona (`demo:lily`) can be asked and replies as itself.
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
layouts, which have no such bar, show Research, Save or Reopen above the status pill; a phone's top bar
carries the same **⋯** menu, and a compact layout puts it first among those actions.

Above the Notes, the page shows what the root's record says, on the paper with no card around it,
in this order: a status row (a pill reading Open, Exploring, Waiting for or Settled; waiting is followed by the asked people's faces and names, settled by the settler's face and "by Ada, 19 Oct"; the card footer keeps its own waiting pill), the question,
and the control, which is the options or written-answer field at page width with no box and no
footer. Once settled the control stays where it was, read-only, with the saved option selected
or the written answer in the field; there is no separate answer block or heading. **Findings** (hidden when empty)
follow, each expanded by default with its summary, plain source links and branch. **Takes**
appear only if someone was asked. **Notes** is always present and shows an "Add a note"
placeholder while empty. A child document's own decisions cannot open as pages.

## A settled decision's why

A settled decision may carry one **why**: a single plain sentence of at most 300 characters on its
record (`why`, with `whyBy` naming the person who wrote it), projected on the card's metadata. Any
writer sets, replaces or clears it with `question:why { id, text }` (empty text clears); the server
commits the record, then announces `question:meta` and replies. Only a settled decision has one.

Chopin drafts it. The settle write-up job (`write_decision_prose`) takes an optional `why`, checked
as exactly one plain sentence with no Markdown, and saves it in the same commit as the paragraph.
That job runs for conversation decisions. Settling a Planner or human decision enqueues a
**why-only** run of the same job instead (trigger `why:<id>:<generation>`, no thread): it writes no
paragraph, only the `why`, from the question, the chosen answer, ready findings and takes with
their stances. It follows the same queue and Planner-ownership rules as the write-up: it needs the
settler's captured session, never claims an owner, waits for an attached Planner under
`HARNESS=remote`, and with none available the decision simply has no draft. It is keyed by saved
generation, so it runs once per settle and never loops.

A draft has no `whyBy`. A person's words, or their clearing of it (`whyBy` set with no `why`), are
never replaced by a later draft for the same settle; a draft is replaced by a redraft.

Reopening moves the why into the answer's history entry and clears it from the record: it
explained that answer, and the next settle drafts its own.

## Criteria

A choice decision may carry **criteria**: up to five named qualities, such as "New device", "No new
storage" or "Easy reset", that its options are judged against. The UI is a matrix: criteria are
columns, options are rows, and each cell is marked yes, partly or no. Criteria apply only to choice
questions, never to `response: "text"` or verbatim host dialogs.

**Definition.** `Question.Item.criteria?: Array<{ id: string; label: string }>` (1–5 entries, labels
at most 40 characters, case-insensitively unique, ids matching `^[A-Za-z0-9_-]{1,64}$`). The
Planner's `ask` tool takes `criteria: [{ label }]` per question; ids are minted by the server. The
`open_decision` tool and `question:create` make written decisions, which have no options to compare,
so they take no criteria. Criteria are frozen like the rest of the definition, with one exception
shaped like options: any writer may append one while the decision is open.

```ts
// request, at most 5 criteria, 40 characters, no case-insensitive duplicate label
{ kind: "question:criterion", rid, id, question, key, label }
// reply
{ kind: "question:criterion", id, ok: true, criterion, definition, repeated? }
{ kind: "question:criterion", id, ok: false, reason: AddOption.Refusal, message }
// broadcast, after the commit
{ kind: "question:criterion-added", id, question, criterion, definition, by }
```

`key` is an idempotency token as for `question:option`; the server stores it beside option keys in
the record's `appended` map, so repeating it returns the same criterion with `repeated: true`.
Reasons are the option refusals: `invalid`, `duplicate`, `full`, `resolved`, `resolving`,
`implementation`. The definition, record and plan projection change together and commit before the
reply and broadcast. The shared draft's shape does not change. Clients should adopt the returned
`definition` forward only (more criteria than they hold), as for options. Changing or removing a
criterion, or relabelling one, is not supported: ask a new decision.

**Marks are shared draft state**, like choices. Every choice question's draft holds a `marks`
object (`Question.DraftAnswer.marks`), a flat map of one LWW register per cell, keyed
`${optionId}/${criterionId}` (`Question.markKey`). A register holds `"yes" | "partly" | "no"`, or
`null` once cleared; a missing key is unmarked. Keys are created lazily, so appended options and
criteria never rewrite an existing draft. `marks` is read back only on questions with criteria,
where it is present; on others it stays empty. Use `Question.setMark(model, questionId, optionId,
criterionId, mark | null)` on the client's local model, flush, and send the patch with
`question:edit`; the server rejects any cell the definition does not describe or any other value.
Marks are optional: a partly filled matrix can be saved and unmarked cells render blank. Drafts
stored before criteria gain an empty `marks` object when the server restores them.

**Settling.** `question:submit` snapshots the draft's marked cells into the answer, so the settled
decision keeps the matrix after the draft is replaced:

- `Answer.marks?: Marks` (`Marks = { [cell]: Mark }`, flat and sparse), present when any cell was marked;
  it comes back in `question:submit` and `question:resolved` replies.
- The record stores `marks`, and `CardMeta.marks` carries it for decided cards. This is the data for
  the read-only table: rows are `definition.questions[0].options` (with the chosen one from
  `answers`/`choices`), columns are `criteria`, cells are `marks[markKey(option, criterion)]`.
- Reopening starts a fresh draft with no marks. The previous matrix moves to
  `CardMeta.history[n].marks`.

**Document projection.** The plan's `<Questionnaire>` reads correctly alone: each `<Question>` carries
`<Criterion id label />` children after its options, and a settled `<Answer>` carries
`marks="optionId/criterionId:mark ..."`. Records stay authoritative; reopening clears the attribute.
No Lexical node was added: both ride in the existing questionnaire node's state.

**Planner.** The Planner may propose criteria in `ask`. It cannot mark cells or suggest marks: a
mark is a human judgement, and the advisory `suggested` choice is the only Planner-authored draft
input. The settle write-up prompt lists each criterion with the chosen option's mark.
