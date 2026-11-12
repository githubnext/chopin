/**
 * Mounting a long transcript newest first.
 *
 * Opening a document brings its whole Chat history in one frame, and rendering hundreds of
 * messages with the document in one commit kept both off the screen for seconds. A transcript
 * that arrives in bulk mounts only its newest rows, the ones a reader sees at the bottom, and the
 * older ones are added above them a chunk at a time after the page has painted.
 */

/** Messages mounted with the history: more than a tall pane shows. */
export const FIRST_MESSAGES = 30;
/** The fewest messages added above them in a later step. */
export const STEP_MESSAGES = 60;

/**
 * The index of the first row to mount so that the rows from it on hold at least `messages`
 * messages, given how many each row holds. Whole rows only: a row is never split.
 */
export function newestRows(sizes: readonly number[], messages: number): number {
	let held = 0;
	for (let index = sizes.length - 1; index >= 0; index--) {
		held += sizes[index]!;
		if (held >= messages) return index;
	}
	return 0;
}

/**
 * The first row to mount in the next step, from the first mounted now. Each step adds at least as
 * many messages as are mounted already, so a step renders the rows mounted before it again a
 * bounded number of times: the whole transcript about twice in all.
 */
export function earlierRows(sizes: readonly number[], from: number): number {
	let mounted = 0;
	for (let index = from; index < sizes.length; index++) mounted += sizes[index]!;
	return newestRows(sizes.slice(0, from), Math.max(STEP_MESSAGES, mounted));
}

/** More arrived than a live message brings: a history, a reconnect's or another document's. */
export function arrivedInBulk(entering: number): boolean {
	return entering > FIRST_MESSAGES;
}
