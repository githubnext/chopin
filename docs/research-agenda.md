# Experimental research agendas

A document writer can delegate a bounded public research agenda from the document
menu's **Research agenda** action. Existing documents have no agenda or permission
to run one. Saving a scope creates a paused agenda; **Allow public research** is
the explicit grant. The person granting it must be the document's Planner owner
(or claim that role through the usual authenticated owner path).

The scope should contain only material the writer intends to send to public
research. Writers may supply up to six questions with a reason, priority, and
evidence need, or let Chopin propose questions from that public scope. Readers
can inspect the agenda and its reports. Every repository writer can pause it or
edit its scope; saving edits pauses work and requires another explicit grant.

## What runs

The scope-only generator proposes a small, deduplicated set of factual questions.
A separate private assessor reads a bounded document excerpt and completed agenda
reports, then chooses one existing question, says the evidence is sufficient, or
stops. It cannot write a new public query, change the scope, or grant authority.
Human preferences and low-value repetition are reasons to stop.

Only the approved public scope, selected question, and evidence need reach the
existing public research worker. Document text and repository files do not enter
that worker. The existing private research stages combine the evidence with the
document and publish an ordinary child document. Reports retain their sources
and open from the agenda's question rows. Agenda work does not edit the parent
prose, resolve decisions, build code, or start local experiments.

The initial experiment requires `AGENT=on`, `BACKGROUND_JOBS=on`,
`WEB_RESEARCH=on`, and `HARNESS=copilot-sdk`. Other harnesses cannot activate an
agenda because this path requires enforced per-session AI credit limits. Paused
scopes remain readable and editable while execution is unavailable. Explicit
one-off `/research` requests retain their existing behavior.

## Bounds and stopping

One saved scope has the following allowance:

| Bound                             | Limit                                 |
| --------------------------------- | ------------------------------------- |
| Questions                         | Six                                   |
| Investigations                    | Three                                 |
| Lifetime                          | 24 hours from the first grant         |
| Time between investigation starts | At least five minutes                 |
| Individual request deadline       | 15 minutes, within the grant lifetime |
| Planning/assessment sessions      | Five, including question generation   |
| Reserved AI credits               | 420 total                             |

Each assessment reserves 30 credits before opening its session. Public evidence
reserves 30; a private answer attempt reserves 60 for its two stages. Actual
worker retries reserve again. Reservations are conservative ceilings, not a
measurement of billed usage, and are never refunded. A retry may exhaust the
allowance before all three investigations finish. Model assessments permit at
most two concurrent sessions globally and one per delegating person. Research
execution also uses the existing background job runner's concurrency limits.

**Pause research** revokes the durable permission, cancels in-flight work, and
blocks late publication. Expiry, unavailable ownership, changed capabilities,
archiving, failed work, exhausted limits, sufficient evidence, and unhelpful
remaining questions stop further scheduling. Failed investigations do not loop
through automatic agenda retries. A server restart pauses every active agenda;
a person must explicitly allow it again. Resuming preserves the original expiry
and counters. Save a new scope to establish a new allowance.

A changed document or completed report invalidates an assessment made from its
previous content. The next bounded assessment may stop or choose another queued
question. Changes of direction outside the approved scope require a person to
edit that scope; the model never expands its own permission.

## Durable boundaries

`research_agendas` stores the current scope, generation, counters, questions,
owner binding, and assessment reservation. `research_agenda_runs` associates
stable request UUIDs with the exact generation and owner that authorized them.
Run associations survive scope replacement so stale jobs cannot become ordinary
unguarded requests. The storage adapter writes under the application writer
lease with optimistic revision checks.

The coordinator persists investigation intent before starting the existing
research service. Repeated scheduling repairs the same request identity. A
shared per-document lock orders scope changes, reservations, and research
publication. Enqueue, each worker attempt, and publication recheck the grant,
owner session/generation/credential revision, request deadline, and active
question. Canceling the remote worker is cleanup; the durable grant check is the
publication fence.

The browser reads and mutates `/api/channels/:channelId/research-agenda`, with
`/activate` and `/pause` actions. Mutations require same-origin authenticated
repository write access. Saves and activations require the expected revision;
pause requires the grant generation so progress updates cannot prevent stopping
the current grant. Reads recheck the
stored repository node identity. Agenda state is separate from collaborative
text and decision records, so document or model output cannot grant permission.

Future scheduling or follow-through can compose with this module through an
explicit agenda grant, `wake(channelId)`, and ordinary completed research child
documents. Such integration must preserve the existing scope and owner checks;
a Chat intervention or report completion is not another grant.
