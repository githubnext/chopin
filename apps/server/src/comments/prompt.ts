/**
 * What the Planner is told when somebody sends it a comment.
 *
 * The body starts with a verb because Chat puts `@handle:` in front of it, and
 * a turn that reads "@ana: @ana sent…" spends its first line saying the same
 * thing twice.
 *
 * The thread is quoted whole rather than summarised: the disagreement in it is
 * usually the part worth acting on, and a Planner given only the last line
 * cannot tell which objection it answers.
 */

import { speaker } from "./store";

import type { Record as Thread } from "./service";

/**
 * Enough context to answer, without pretending block indices will still be valid.
 *
 * `child` is the child document holding the thread, whose tools the change goes through.
 */
export function address(thread: Thread, quote: string, child?: string): string {
	let change = child
		? `make it with \`edit_child\` on child ${child} first and anchor what you wrote with `
			+ `\`anchor_child\`, using thread ${thread.id}`
		: "make it with `edit_plan` first and anchor what you wrote with `anchor_plan`, "
			+ `using thread ${thread.id}`;
	return [
		`sent you a comment on a passage of ${child ? `child document ${child}` : "the plan"}.`,
		"",
		"The passage it marks:",
		"",
		...quote.split("\n").map(line => `> ${line}`),
		"",
		"The thread, oldest first. Notes marked → Chopin were sent to you:",
		"",
		...thread.notes.map(note =>
			`@${speaker(note)}${note.to === "planner" ? " → Chopin" : ""}: ${note.text}`
		),
		"",
		`Answer the latest note sent to you with \`reply_comment\`, using thread ${thread.id}. `
		+ `If it asks for a change to the document, ${change}; then say in the reply, `
		+ "briefly, what you changed. The reply is shown in a small card beside the passage, so "
		+ "keep it to a sentence or two.",
	].join("\n");
}
