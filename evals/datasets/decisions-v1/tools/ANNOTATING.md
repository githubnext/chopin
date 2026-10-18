# Annotating a thread

Each annotator reads one normalised digest and writes one annotation JSON file.
`assemble.py` then builds the case file and decision records. Structural fields
such as event IDs, actors, times, parents and URLs always come from the
skeleton. Do not retype them.

## Inputs

- `.cache/decisions/norm/<key>.txt` is the digest. Each event shows its `[event id]`,
  kind, actor, association or role, time, parent and reactions, followed by the
  source text. `HIDDEN(...)` marks a comment that GitHub collapses, and `ANSWER`
  marks a discussion's chosen answer. Long bodies are clipped. When a clipped
  body matters, read the raw `.cache/decisions/<key>.json`.
- `.cache/decisions/norm/<key>.json` is the skeleton. It holds the event IDs you
  must summarise.
- To follow a cross-reference that carries the decision, such as the PR that
  implemented it or the RFC it spawned, fetch it with
  `python3 -I evals/datasets/decisions-v1/tools/fetch.py <url>`, then run
  `python3 -I evals/datasets/decisions-v1/tools/normalise.py <key>`. Add its key
  to `include` only when the decision spans both threads. Follow one hop at most.

## Rules

- **Never invent content.** If something is unknown, write `null` and say why
  in `notes`.
- **Paraphrase everything.** Never copy a sentence or quote a comment. No run of
  8 or more consecutive words may match the source; the validator checks this.
  Code identifiers, option names and titles are fine.
- Each `summary` is one or two neutral sentences. Make the actor's role clear:
  "A maintainer…", "A contributor…", "A user…", "The opener…", "A bot…". Use the
  association label and context. The Go team, the Rust team members who
  sign rfcbot, and a project's MEMBER, OWNER or COLLABORATOR are maintainers.
- Summarise every event in the skeleton, except process events that carry no
  meaning for the decision. Put those IDs in `drop`: routine label churn,
  `stale` labels, a cross-reference to an unrelated PR. Keep closes, reopens,
  merges, renames, decision labels such as `Proposal-Accepted`, FCP and
  disposition labels, and cross-references to an implementing or reverting PR.
- A low-content comment such as "+1", "any update?" or a bare emoji still gets
  a short summary, e.g. "A user adds support."
- Do not summarise a hidden comment's content if it is off-topic, abusive or
  spam. Write "A comment GitHub marks as hidden (off-topic)." Skip the whole
  thread if it is dominated by harassment or personal matters.

## Keep or discard

Keep a thread only if at least two people, or at least two options, are
genuinely weighed, and the decision can be stated as one question. "Genuinely"
needs a second human to engage. A lone options memo with no replies is a
discard. Discard bug
reports with no design choice, support Q&A and spam. When you discard, give a
one-line `discardReason` and omit everything else.

## Cutoffs

Place 2–4 cutoffs at meaningful moments, chosen from:

- `question-clear`: just after the question is clear
- `options-on-table`: just after the main options have been proposed
- `before-decision`: just before the deciding event
- `after-decision`: just after it

Use `c1`, `c2`, … in time order. `at` is an ISO timestamp strictly between two
events' `createdAt` values, so the cutoff's visible set is unambiguous. Do not
place a cutoff before the opening event.

## The Chopin question model (for `chopinFit`)

Chopin's questions feature has four shapes:

- **explore:** open text
- **choice:** a table of options × criteria
- **tune:** a preview plus dials
- **check:** verify a claim as True, Partly or False, by research or a spike

A question moves from open, to waiting or researching, to settled, and may be
reopened. Teammates can be asked for a quick take: thumbs, an emoji or a reply.
A settled question becomes a record with the answer, explanation, who settled
it, who was involved, confidence, a timeline, what we knew, what we considered,
and the PRs it was built into.

`fitsFlows` names which flows the decision exercised: `find`, `work-in-place`,
`research-or-spike`, `ask-teammate`, `settle`, `revisit-reopen`, `build-pr`
and `reshape`.

**`gaps` is the most valuable field.** Name concretely what this decision needed
that the design does not offer. Common candidates: coupled decisions decided
together; staged "accept in principle, details later"; a decider who isn't in
the thread; votes or 👍 counts as evidence; reversal after shipping; decisions
taken off-platform; experiments or feature flags as evidence; duplicates
merged. Write each gap as a short phrase that starts with the clustered gap
name, then a colon and the specific detail, e.g. `"off-platform decision: the
outcome was agreed in a team call and only reported here"`. An empty list is
allowed when the design really covers the decision.

## Output

Write `.cache/decisions/ann/<key>.json`:

```json
{
  "key": "<cache key>",
  "verdict": "keep",
  "discardReason": null,
  "quota": "product-ui|pr-debate|eng-issue|formal-process|small-team|open-choice",
  "caseId": "short-kebab-id, unique, e.g. zed-soft-wrap-off",
  "title": "Short neutral name",
  "include": [],
  "drop": ["process event ids omitted"],
  "summaries": {"<event id>": "paraphrase", "…": "…"},
  "cutoffs": [{"id": "c1", "at": "ISO", "purpose": "question-clear"}],
  "decisions": [DECISION_RECORD, …]
}
```

Write a `DECISION_RECORD` for each distinct decision in the thread, usually
one. `assemble.py` fills in `caseId`, `collector` and `fidelity`.

```json
{
	"id": "short-kebab-id",
	"sources": [
		{
			"url": "https://…",
			"kind": "discussion|issue|pr|rfc|proposal|adr|design-doc|minutes|meeting-notes|other",
			"retrievedAt": "ISO-8601 from meta.retrievedAt"
		}
	],
	"repo": "owner/name",
	"domain": "api-design|language-design|ui-ux|product-behaviour|architecture|dependency|performance|security|naming|process-governance|compatibility|tooling|docs|infra|data-model|other",
	"title": "Short neutral name",
	"question": "The decision as one question, paraphrased as participants framed it",
	"questionExplicit": true,
	"context": "1–3 sentences, paraphrased",
	"options": [
		{
			"label": "…",
			"proposedBy": "handle or role",
			"fate": "chosen|rejected|deferred|merged|partly"
		}
	],
	"criteria": ["…"],
	"participants": {
		"count": 0,
		"roles": ["maintainers", "users"],
		"decider": "consensus|named maintainer|vote|BDFL|team|unclear"
	},
	"process": {
		"research": "none|links|benchmarks|survey|data-analysis",
		"spike": "none|prototype|implementation-pr|experiment|feature-flag",
		"poll": false,
		"escalation": "none|core-team|steering|tsc|vote",
		"subQuestions": [],
		"deferred": false,
		"reopened": false,
		"superseded": false,
		"durationDays": 0,
		"comments": 0,
		"reactionsTotal": 0,
		"decidedOffPlatform": false,
		"notableMoves": []
	},
	"outcome": {
		"decided": true,
		"decision": "paraphrase, or null if undecided",
		"how": "consensus|maintainer-decision|vote|fcp|default/no-action|abandoned|unclear",
		"rationale": "paraphrase or null",
		"dissent": "paraphrase or null",
		"confidence": "stated|implied|none",
		"reversibility": "stated-easy|stated-hard|implied|unknown",
		"implementedIn": ["PR URLs"]
	},
	"chopinFit": {
		"shape": "explore|choice|tune|check|mixed|none",
		"shapeWhy": "one line",
		"secondaryShape": null,
		"fitsFlows": [],
		"gaps": []
	},
	"evalUse": "one line",
	"notes": ""
}
```

- Copy `participants.count`, `process.comments` and `process.reactionsTotal`
  from the digest's meta line (`humanParticipants`, `comments`, `reactionsTotal`).
  These are computed over the whole thread, before the cap. For a merged
  multi-thread case, add the parts together.
- `durationDays` runs from the opening to the deciding event, or to the last
  event if the thread is undecided. Round it to a whole number.
- `decider` uses the exact enum strings. For "named maintainer", put the handle
  in `notes`.
- Judge roles by behaviour as well as by the association label. Someone
  labelled CONTRIBUTOR who triages, decides and merges is a maintainer.
- When something was agreed in principle but only partly built, use
  `decided: true`, set the option's `fate` to `partly`, and record the shortfall
  as a `staged acceptance` gap.
- Write a separate decision record only when a sub-decision was debated in its
  own right. A quick follow-up adjustment, such as a default flipped a week
  later, goes in `subQuestions` and `notableMoves` of the same record.
- Values must come from the enums. Use `secondaryShape: null` when there is
  none.
