/**
 * What the room said while the agent was not listening.
 *
 * A message that does not address the agent still reaches it: anything said
 * since the last turn is carried into the next one, so the agent arrives
 * already knowing what was decided rather than having to be told again.
 *
 * Whether a message addresses it at all is the protocol's business, because
 * the browser has to predict the same answer.
 */

import { instruction } from "@chopin/protocol/address";

export type Said = { handle: string; text: string };

/** Bounds on what is carried forward, so a long discussion cannot grow forever. */
const MAX_ENTRIES = 40;
const MAX_CHARS = 8_000;

/** Add to the backscroll, dropping the oldest to stay within bounds. */
export function remember(backscroll: Said[], said: Said): Said[] {
	let next = [...backscroll, said];
	while (
		next.length > MAX_ENTRIES
		|| next.reduce((total, item) => total + item.text.length, 0) > MAX_CHARS
	) {
		if (next.length <= 1) break;
		next.shift();
	}
	return next;
}

/**
 * Build the prompt for a turn.
 *
 * A bare mention after a discussion means "act on that" — the way somebody
 * says *ok, go* once the argument is settled. With nothing buffered it is just
 * a short message, and the agent can ask what is wanted.
 */
export function compose(backscroll: Said[], handle: string, text: string): string {
	let asked = instruction(text);

	if (backscroll.length === 0) return `@${handle}: ${asked}`;

	let conversation = backscroll
		.map(said => `@${said.handle}: ${said.text}`)
		.join("\n");

	let closing = asked
		? `@${handle}: ${asked}`
		: `@${handle} is asking you to act on the conversation above.`;

	return `Said in the room since your last turn:\n\n${conversation}\n\n${closing}`;
}
