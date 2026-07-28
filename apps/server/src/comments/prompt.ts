/**
 * What the agent is told when a thread is accepted.
 *
 * The body starts with a verb because `compose` puts `@handle:` in front of it,
 * and a turn that reads "@ana: @ana accepted…" spends its first line saying the
 * same thing twice.
 *
 * The thread is quoted whole rather than summarised. Somebody would have to
 * write that summary, and the disagreement in a thread is usually the part
 * worth acting on — an agent given only the conclusion cannot tell which
 * objection the conclusion answered.
 */

import type { Record as Thread } from "./service";

/** Enough context to act, without pretending block indices will still be valid. */
export function compose(thread: Thread, quote: string, current?: string): string {
	let lines = [
		"accepted a comment on the plan.",
		"",
		"The passage it marks:",
		"",
		...quote.split("\n").map(line => `> ${line}`),
	];

	// A rewritten passage is more information, not less: the agent is told what
	// was discussed and what stands there now, and can reconcile the two.
	if (current !== undefined && current !== quote) {
		lines.push(
			"",
			"That prose has since been rewritten. It now reads:",
			"",
			...current.split("\n").map(line => `> ${line}`),
		);
	}

	lines.push(
		"",
		"The thread:",
		"",
		...thread.notes.map(note => `@${note.handle}: ${note.text}`),
		"",
		"Revise the plan so it reflects this, then record what your revision produced "
			+ `with \`anchor_plan\`, using thread ${thread.id}.`,
		"",
		"Other accepted threads may be waiting too — `read_plan` lists them, and you can "
			+ "deal with several in one pass.",
	);

	return lines.join("\n");
}
