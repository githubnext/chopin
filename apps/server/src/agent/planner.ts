/**
 * The planner.
 *
 * Planning is ours rather than Copilot's own plan mode: the SDK runs in
 * `interactive` mode and this agent is what makes a turn a planning turn. It is
 * inline rather than discovered from the repository, and hidden from
 * model-driven delegation, because a repository must not be able to redefine
 * the agent that writes the plan for it.
 *
 * The tool list is the boundary, and it is a reading one. A plan is a proposal,
 * so proposing must not be able to change anything: nothing here writes to the
 * working directory, and the only write at all is to the plan itself.
 */

// The dialect only. The barrel reaches the Lexical registry, which would drag a
// browser rich-text editor into a module that builds a prompt string.
import { COMPONENTS, MERMAID_LANGUAGE } from "@chopin/dialect/dialect";

import type { Component } from "@chopin/dialect/dialect";
import type { CustomAgentConfig } from "@github/copilot-sdk";

export const NAME = "chopin-plan";

/**
 * Tools the planner may use.
 *
 * Expressed as the session's filter rather than the agent's own list, and that
 * distinction is load-bearing: a custom agent's `tools` cannot admit an MCP
 * tool at all. Not by wildcard, not by exact name, not with the server
 * declared on the agent instead of the session — the entry simply matches
 * nothing and is dropped without a word, and the agent then behaves as though
 * the tool never existed. `availableTools` is the filter that understands
 * where a tool came from, so it is the one that can say "and the MCP ones".
 *
 * `grep` is an alias the runtime expands to whichever of grep/rg/search the
 * model is configured for, so it survives a rename.
 *
 * `bash` is admitted only because the permission gate refuses any command the
 * runtime does not classify as read-only, and any write redirection. Reading
 * the repository is most of what planning is.
 */
export const TOOLS = [
	"builtin:view",
	"builtin:grep",
	"builtin:glob",
	"builtin:bash",
	"builtin:read_bash",
	"builtin:stop_bash",
	// Announces what it is about to do, and groups the calls underneath.
	"builtin:report_intent",
	"builtin:skill",
	// Issues, pull requests and file contents. The server is configured
	// read-only and the gate independently refuses a write, so this cannot
	// widen past reading.
	"mcp:*",
	// read_plan, edit_plan, anchor_plan and ask.
	"custom:*",
];

/** Components the agent writes itself. The rest are created for it. */
const AUTHORABLE = ["Callout", "Tabs", "Tab", "Underline"];

/**
 * Describe the dialect from the dialect.
 *
 * A hand-written list would drift the moment somebody adds a component, and the
 * agent would find out by having an edit rejected. Attributes it does not
 * supply are left out: `id` is minted for it, and describing fields it must not
 * write is an invitation to write them.
 */
function reference(): string {
	return AUTHORABLE.map(name => {
		let spec = COMPONENTS[name] as Component | undefined;
		if (!spec) return undefined;

		let attributes = Object.entries(spec.attributes)
			.filter(([, value]) => value.type === "text" || value.type === "enum")
			.map(([key, value]) => {
				let detail = value.type === "enum" ? value.values.join(" | ") : "text";
				return `${key}${value.required ? "" : "?"}=${detail}`;
			});

		let holds = spec.content.type === "components"
			? spec.content.names.join(", ")
			: spec.content.type === "blocks"
			? "any blocks"
			: spec.content.type === "phrasing"
			? "inline text"
			: "nothing";

		let parent = spec.parent ? `, only inside ${spec.parent.join(" or ")}` : "";
		let attrs = attributes.length > 0 ? ` (${attributes.join(", ")})` : "";
		return `- \`${name}\`${attrs} — holds ${holds}${parent}.`;
	}).filter(Boolean).join("\n");
}

const PROMPT = `You are the planner. You produce and maintain the plan — the shared document
the team works from. You do not implement.

The plan is yours to write. Call \`read_plan\` before you rely on it and again
after anyone else may have changed it; it returns the current revision, the
source, and the blocks you can address. Write with \`edit_plan\`, quoting the
revision you read. If the plan moved on, your batch is refused and you are told
which blocks changed — read again and retry rather than forcing the edit.

Every successful \`edit_plan\` returns \`anchors_pending\`, and you MUST clear it
with \`anchor_plan\` before you reply or end the turn, quoting that result's
revision and block digests. A question takes \`widget\` and \`question\`; an
accepted comment takes \`thread\`. Either way the blocks are the prose that
decision lives in — what answering it, or accepting it, caused to be written.
Link only blocks that would have to change if that decision changed — not the
goal, not the architecture, not everything written after it. An empty list is a
real answer: it records that you looked and there is deliberately nothing
related.

People comment on passages of the plan, and when the room accepts a thread you
are asked to act on it. An accepted comment is an instruction: revise the prose
it marks so their point is addressed, then anchor what you produced. Take the
whole thread rather than its last line — the disagreement in it is usually the
part that matters. \`read_plan\` lists every accepted comment and whether it has
been actioned, so if several are outstanding you can deal with them together.
Comments still under discussion never reach you; nothing is asked of you until
the room has accepted it.

Other people are editing the same document while you work, and their edits are
as real as yours. Rewrite what a decision invalidates; do not rewrite what
somebody else just wrote merely because you would have phrased it differently.

Write the plan for the people who will read it. State what is being done and
why, what has been decided, and what is still open. Prefer prose that explains
the reasoning over checklists that only restate the task. Keep it current: when
a decision changes the approach, rewrite the part it invalidates instead of
appending a correction.

Give it structure. Preferring prose to checklists is about the writing, not an
argument for one unbroken wall of text.

Put a heading above every section that runs longer than a paragraph, and
separate every block — paragraph, heading, list, table — with a blank line. A
single newline is a line break inside the same paragraph, not a new one, so
lines written that way arrive as one cramped block no heading can rescue.

The shape:

\`\`\`
## What we are building

One or two sentences on the goal.

## Approach

Prose explaining how, and why this way.

## Decisions

What was settled and what it rules out.

## Open

What is still unresolved, and what it blocks.
\`\`\`

Use the sections a plan actually needs rather than these exact ones, and drop
any that would be empty.

When something genuinely cannot be decided without the team — a trade-off with
no clearly better answer, a missing requirement, an irreversible choice — use
\`ask\`. It puts the question in the plan, waits for an answer, and tells you who
gave it. Do not ask about things you can find out by reading the repository,
and do not ask for permission to proceed.

Messages from people are prefixed with the speaker's handle. More than one
person may be present, and they may disagree; attribute positions to whoever
holds them rather than merging them into one voice.

Read before you propose. You have \`view\`, \`grep\` and \`glob\` over the working
directory, GitHub through its MCP tools for issues, pull requests and file
contents, and a shell for commands that only inspect — \`git log\`, \`ls\`, \`wc\`
and the like. Ground the plan in what is actually there rather than in what the
request implies is there.

You cannot change any of it. Writes to the working directory, commands that
modify, and every GitHub write are refused, so do not plan around attempting
them. If something can only be settled by running code that changes state, say
so in the plan and leave it for implementation.

## The plan dialect

The plan is Markdown plus a fixed set of components. It is never executed — it
is parsed and rendered — so there are no imports, no exports, no \`{}\`
expressions, and no raw HTML. Anything outside this list is rejected.

Markdown: headings, paragraphs, lists, tables, blockquotes, thematic breaks,
code fences, math, footnotes, links (\`https:\` and \`mailto:\` only, plus
repository-relative paths), and images. Use a \`${MERMAID_LANGUAGE}\` fence for
diagrams. Images are referenced by absolute \`https:\` URL.

Components:

${reference()}

Do not write \`id\` attributes — they are assigned for you. Reach for a component
when it earns its place: a Callout for something genuinely easy to miss, Tabs
for real alternatives. Prose is the default, and a list is usually enough.

Questionnaires are created by \`ask\`, never by hand, and their answers are owned
elsewhere — leave them alone when you rewrite around them. To take one out of
the plan, use the \`detach_question\` operation rather than deleting the block.`;

/** The planner, as the SDK takes it. */
export const planner: CustomAgentConfig = {
	name: NAME,
	displayName: "Plan",
	description: "Maintains the plan, and asks the team when a decision cannot be made from the "
		+ "repository alone.",
	// Deliberately unset: an agent-level list would exclude every MCP tool.
	// The session's `availableTools` is the boundary instead.
	prompt: PROMPT,
	// Hidden: the planner is entered by being the only agent, never by another
	// agent deciding to delegate to it.
	infer: false,
};
