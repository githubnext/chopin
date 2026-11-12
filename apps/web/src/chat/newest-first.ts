/**
 * Mounting a long transcript newest first.
 *
 * Opening a document brings its whole Chat history in one frame, and rendering hundreds of
 * messages with the document in one commit kept both off the screen for seconds. A transcript
 * that arrives in bulk mounts only its newest rows, the ones a reader sees at the bottom, and the
 * older ones are added above them a chunk at a time after the page has painted, when it is idle.
 * Rows already mounted are not rendered again for it (`Transcript` keeps its rows while the
 * transcript does not change).
 */

/** Messages mounted with the history: more than a tall pane shows. */
export const FIRST_MESSAGES = 30;
/**
 * Messages added above them in each later step. Each step costs the layout of what it adds, about
 * 2 ms a message beside a large document, so a step stays well under what a click waits on.
 */
export const STEP_MESSAGES = 60;
/** How long a step waits for the page to be idle before it runs anyway. */
export const IDLE_WAIT_MS = 500;

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

/** The first row to mount in the next step, from the first mounted now. */
export function earlierRows(sizes: readonly number[], from: number): number {
	return newestRows(sizes.slice(0, from), STEP_MESSAGES);
}

/** More arrived than a live message brings: a history, a reconnect's or another document's. */
export function arrivedInBulk(entering: number): boolean {
	return entering > FIRST_MESSAGES;
}
