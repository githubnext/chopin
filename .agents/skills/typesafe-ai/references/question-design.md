# Designing Jev questions

## State is evidence

Supply the records, identities, relationships, policy, and current facts needed for
the judgment. Keep relevant context together; remove unrelated history. Named fields
make the target explicit and let code replace evidence without rewriting the question.
A string is sufficient for one simple input. Current facts should come from the
application's records or retrieved sources. See [State](https://docs.typesafe.ai/concepts/state).

For conversation interpretation, preserve who said what, ordering, and the passage or
proposal being discussed. A sentence such as “that works” needs its referent. Splitting
the questions is useful; stripping away the evidence that connects them is not.

## One question, one useful meaning

Define the property before the threshold or resulting action. “Is this worth doing?”
mixes intent, relevance, feasibility, and preferences. Separate those dimensions when
the application needs to inspect or change them independently. A narrow relational
question such as “Does this message withdraw the earlier proposal?” can still require
several messages. See [the building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one).

Separate inference from policy: ask whether someone requests a change; let code check
their permissions and decide whether the workflow can apply it. An inferred request
is not a new authorization grant. This is an engineering boundary, not a Jev capability.

## Instructions and criteria

Question IDs label the returned answers but never reach the underlying model. A key
named `requests_refund` does not explain the question. State the complete judgment in
`instructions`. Choice option names and descriptions do reach the model. Describe
what distinguishes neighboring options, including boundaries and representative
examples where useful. See [Choice](https://docs.typesafe.ai/primitives/choice).

Use paths that actually exist in the submitted state. For example, ask “Does
`conversation.latest.text` ask to change `proposal`?” rather than “Does this want that?”
Backticks aid readability; they are not a special reference-resolution mechanism.

Use a string for a short, clear question. Structured instructions and criteria can
carry a question, focus, examples, contrasts, or dynamically supplied records in named
fields. Keep the same field names across Choice options so definitions are comparable.
Check the chosen SDK or local wrapper supports this shape before using it. See
[Advanced structure](https://docs.typesafe.ai/primitives/advanced).

## Match the primitive to the semantics

- **Choice:** one mutually exclusive result. Include `none`, `other`, or `insufficient`
  when that is a real answer. Adding an option changes the comparison; evaluate it.
- **Noul:** a condition with probability of yes. For multiple labels that may all apply,
  ask one Noul per label. Define what counts as true/false when the boundary is unclear.
  A low value means probably false, not an unreliable answer. See
  [Noul](https://docs.typesafe.ai/primitives/noul).
- **Score:** intensity or degree on ordered levels. Describe observable situations,
  not just “poor / good / great.” Each level must be interpretable on its own. With
  three levels, the score runs from 0 to 2 and may be fractional: it is an expected
  level, not a percentage or a discrete class. Keep comparable rubrics when ranking
  items. Use the levels you can meaningfully distinguish, rather than stretching a
  rubric to an arbitrary count. See [Score](https://docs.typesafe.ai/primitives/score)
  and [Allie's explanation at 1:57:14](https://thursdai.news/ep/sep-17-2026).

## Request sketch: interpreting a shared document discussion

This original example shows question shape, not evaluated prompts or recommended
thresholds. It uses strings supported by a simple transport wrapper.

```json
{
	"model": "jev-latest",
	"state": {
		"proposal": { "id": "p7", "text": "Export reports as CSV." },
		"conversation": {
			"previous": { "author": "Lee", "text": "Does CSV export work for you?" },
			"latest": { "author": "Sam", "text": "Yes, but only for the filtered rows." }
		}
	},
	"questions": {
		"intent": {
			"type": "choice",
			"instructions": "What does `conversation.latest.text` express about `proposal`, in light of `conversation.previous`?",
			"criteria": {
				"accept": "Accepts the proposal as written, without changing its scope.",
				"amend": "Proposes a condition or scope change to the proposal.",
				"reject": "Declines or withdraws the proposal.",
				"none": "No clear stance toward this proposal can be established."
			}
		},
		"filtered_scope": {
			"type": "noul",
			"instructions": "Does `conversation.latest.text` request limiting the CSV export in `proposal` to the rows currently selected by a filter?"
		}
	}
}
```

Both questions use the supplied context independently. Code can use `filtered_scope`
on the amendment branch, check authority and freshness, and decide the next step.

## Debug the question before adding complexity

Inspect a failing case's supplied state and exact question. Determine whether the
target is identifiable, criteria overlap, an answer is missing, or the question blends
separate dimensions. Change the smallest relevant definition and retain the case.
Measure the revised question and policy on held-out examples; additional context or
questions are useful only when they supply missing evidence or distinguish a real case.
