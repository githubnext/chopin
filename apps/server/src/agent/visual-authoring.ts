import { DIAGRAM_ALIASES, DIAGRAM_TYPES } from "@chopin/diagrams";
import { SEECODE_LANGUAGE } from "@chopin/dialect/dialect";

import { visualChoices } from "./visual-catalog";

let choices = visualChoices();
let catalog = Object.keys(DIAGRAM_TYPES)
	.map(type => `- \`${type}\`: ${choices[type]}`).join("\n");
let aliases = Object.entries(DIAGRAM_ALIASES)
	.map(([alias, type]) => `\`${alias}\` → \`${type}\``).join(", ");

/** Chopin-owned guidance loaded with the Planner on every supported harness. */
export const DIAGRAM_AUTHORING = `Chopin visual authoring guide v1

Start from the reader's question and the available evidence. Choose the smallest
representation that answers it:
- Architecture shows named parts, boundaries, dependencies, or data paths whose
  direction matters. An arrow means a supported relationship.
- Sequence shows ordered exchanges between at least two actors. Use it when who
  sends what, and when, explains the mechanism.
- State shows how one subject changes state; flowchart shows conditions and next
  steps. Show the supported continuation or terminal outcome of every branch.
- A discrete choice for the team belongs in the ordinary multiple-choice
  \`ask\` card. A distinction, rationale, or uncertainty without a useful visual
  relationship belongs in prose.

Ground each node, message, arrow, and label in the source. Keep proposals
conditional and explain unknown links in prose. Diagram the engineering
relationship, not the order people commented. Put one sentence beside the
diagram explaining its takeaway. Use a \`${SEECODE_LANGUAGE}\` fence only when the
visual makes that takeaway easier to understand.

Available native SeeCode types

The examples below are not an exhaustive list. Numerical charts are supported
in the same \`seecode\` JSON fence; no separate chart fence or uploaded image is
needed. These fences remain \`code\` blocks in \`read_plan\`; the browser derives
the chart from the fence language and JSON type. A \`code\` block is not evidence
that a chart is unrendered. \`edit_plan\` validates new SeeCode specs before saving.
The registered types and their evidence requirements are:
${catalog}

Registered presentation aliases (alias → canonical type): ${aliases}.
An alias uses its canonical type's data shape with a presentation variant.

For quantitative charts, preserve source values, categories, units, ordering,
and the meaning of the denominator. Do not invent measurements, silently omit
values, mix counts with percentages, or infer a remainder from overlapping
categories. Keep synthetic examples explicitly synthetic. If the source is
incomplete, ask for the missing data or explain the limitation in prose.

Native document composition

Choose a format for the shape of the source-backed information, then use prose to
qualify it:
- Process or dependency: when the source names ordered stages or directed links,
  use one small \`seecode\` diagram with a one-sentence takeaway. The examples
  below give its syntax. If order or direction is uncertain, explain in prose.
- Comparable alternatives: when the same supported criteria apply to each,
  use a compact Markdown table with one row per alternative and columns for
  benefit and constraint. Follow it with the unresolved choice or caveat.
  If evidence is uneven, use prose or bullets rather than filling cells by
  inference. Use \`Tabs\` only when each alternative needs substantial distinct
  explanation, not to hide a short comparison.
- Easily missed limit: place a brief \`<Callout type="note">\` after the relevant
  paragraph only for a source-backed caveat the reader could overlook. Keep
  routine context in prose. A team selection belongs in \`ask\`, not hand-written
  decision markup.

Illustrative comparison (replace each cell with supported facts):
| Delivery | Benefit | Constraint |
| --- | --- | --- |
| Weekly digest | Fewer interruptions | Later notice |
| Instant alert | Earlier notice | More interruptions |

Illustrative caveat:
<Callout type="note">
No delivery option has been chosen.
</Callout>

Never add a visual or component solely to fill a layout; a clear paragraph is
often the best document section.

The fence body is one JSON object, at most 64 KiB. Graph nodes need distinct
ids and labels of at most 40 characters; edges must name existing ids and object
edge labels are at most 28 characters. Rows and columns are integers from 0 to
40, with no occupied-position collision. Keep ordinary graph diagrams near nine
nodes and twelve edges for readability. A sequence needs at least two distinct
participants with labels of at most 32 characters and one message. Object
message labels are at most 44 characters; more than 16 messages triggers a
readability warning. Use short factual labels.

Architecture (nodes have positions; edges refer to their ids):
\`\`\`${SEECODE_LANGUAGE}
{"type":"architecture","nodes":[{"id":"web","label":"Browser","row":0,"col":0},{"id":"api","label":"API","row":0,"col":1}],"edges":[["web","api"]]}
\`\`\`

Sequence (messages refer to participant ids, in order):
\`\`\`${SEECODE_LANGUAGE}
{"type":"sequence","participants":[{"id":"reader","label":"Reader"},{"id":"api","label":"API"}],"messages":[["reader","api","Open document"]]}
\`\`\`

State (edges connect named states and may label transitions):
\`\`\`${SEECODE_LANGUAGE}
{"type":"state","nodes":[{"id":"draft","label":"Draft","row":0,"col":0},{"id":"saved","label":"Saved","row":0,"col":1}],"edges":[["draft","saved","publish"]]}
\`\`\`

Bar chart (synthetic example; replace all categories and values with source data):
\`\`\`${SEECODE_LANGUAGE}
{"type":"bar","title":"Synthetic completed jobs","axis":"Completed jobs","data":[["Alpha",12],["Beta",7],["Gamma",19]]}
\`\`\`

Call \`read_plan\` before \`edit_plan\`. If \`edit_plan\` rejects a new diagram,
use its field-specific validation message to repair that spec once against the
current revision. If the source cannot support a valid faithful diagram, write
prose and explain the reason. In the final Chat reply, name the representation
you saved or the reason you abstained. Claim a diagram was saved only after
\`edit_plan\` succeeds.`;

/** Used only by opted-in foreground Planner sessions. The tool supplies type-specific syntax. */
export const ROUTED_DIAGRAM_AUTHORING = `Chopin Jev visual authoring guide

Jev decides whether a passage can be visualized, whether that improves
comprehension, and which supported type fits. Use the returned route as the
authoring constraint. Keep the assessed passage as prose beside its visual.
The returned example is syntax only; replace its labels and values with facts
supported by the passage and repository evidence. Never infer a relation,
order, branch, measurement, or comparison cell solely to complete a shape.

For a selected diagram, write one valid seecode JSON fence after the passage.
For a selected table, write one Markdown table after the passage. For a prose
route, write only the passage. Keep caveats in the assessed prose. If the
selected visual cannot be rendered faithfully, explain the blockage rather
than claiming that it was saved. If edit_plan rejects a visual with problems,
repair the named field using the same visual_route while the passage, revision,
and placement are unchanged. Do not reassess merely to repair diagram syntax.`;
