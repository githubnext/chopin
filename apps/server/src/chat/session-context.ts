/**
 * What a fresh Planner session is told of the room before the prompt of its first turn. It goes in the prompt rather
 * than the session's instructions, so the instructions stay the same from turn to turn and the model provider can
 * reuse its cache of them.
 */

/** The line that ends what the session is told of the room, before the turn's own prompt. */
export const SESSION_CONTEXT_END = "The conversation so far ends here. The current turn follows.";

/** The prompt of a fresh session's first turn: what it is told of the room, then the turn's own prompt. */
export function withSessionContext(context: string | undefined, prompt: string): string {
	return context ? `${context}\n\n${SESSION_CONTEXT_END}\n\n${prompt}` : prompt;
}

/** A turn's prompt split into what the session was told of the room, if anything, and the turn's own prompt. */
export function sessionContextOf(prompt: string): { context: string; turn: string } {
	let end = prompt.indexOf(`\n\n${SESSION_CONTEXT_END}\n\n`);
	if (end < 0) return { context: "", turn: prompt };
	return {
		context: prompt.slice(0, end),
		turn: prompt.slice(end + SESSION_CONTEXT_END.length + 4),
	};
}
