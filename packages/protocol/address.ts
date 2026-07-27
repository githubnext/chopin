/**
 * Who a message is for.
 *
 * The agent acts only when addressed, so that two people planning together can
 * talk to each other — "should we ask about auth first?" is a question for a
 * colleague, not an instruction to draft an auth section.
 *
 * This lives with the protocol because both ends need it and they must not
 * disagree. The server decides whether a turn runs; the client says which it
 * will be before anything is sent, and a composer that predicted differently
 * would be worse than one that said nothing.
 */

/** How the agent is summoned. */
export const MENTION = "@chopin";

/**
 * Word-boundary match, so an address in prose does not count.
 *
 * `@plan` would be hopeless here — it is the most common noun in the product,
 * and "rewrite the plan section" would start a turn every time.
 */
const ADDRESSED = /(^|[^\w@])@chopin\b/i;

export function addressed(text: string): boolean {
	return ADDRESSED.test(text);
}

/**
 * The instruction, without the summons.
 *
 * The mention is addressing rather than content: leaving it in spends a token
 * telling the agent its own name.
 */
export function instruction(text: string): string {
	return text
		.replace(/(^|[^\w@])@chopin\b/gi, "$1")
		// Removing a word from the middle of a sentence leaves the gap it sat
		// in, and a prompt should not carry the shape of what was taken out.
		.replace(/[^\S\n]{2,}/g, " ")
		.trim();
}
