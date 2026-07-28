/**
 * Hard bounds for `plan.mdx`.
 *
 * Every limit is enforced server-side during validation. Clients enforce the
 * same values for immediate feedback, but the server is authoritative.
 */

/** Canonical source, UTF-8. Images are referenced by URL, never embedded. */
export const MAX_SOURCE_BYTES = 256 * 1024;

/** Structural nesting depth, guarding renderer and AST recursion. */
export const MAX_DEPTH = 20;

/** Uncompressed Yjs update accepted in one request. */
export const MAX_UPDATE_BYTES = 512 * 1024;

/** Yjs state size that triggers epoch rotation once the room is idle. */
export const MAX_COLLAB_BYTES = 4 * 1024 * 1024;

export const MAX_TABLE_ROWS = 100;
export const MAX_TABLE_COLUMNS = 20;

/** Image nodes per plan. Each is a remote fetch when the plan renders. */
export const MAX_IMAGES = 100;

export const MAX_TAB_LABEL = 60;
export const MAX_CALLOUT_TITLE = 100;

/** Questionnaire shape, matching the `ask` tool's contract. */
export const MAX_QUESTIONS = 10;
export const MAX_OPTIONS = 20;
export const MAX_QUESTION_HEADER = 80;
export const MAX_QUESTION_PROMPT = 1_000;
export const MAX_OPTION_LABEL = 200;
export const MAX_OPTION_DESCRIPTION = 1_000;
export const MAX_CUSTOM_ANSWER = 4_000;

/**
 * Accepted comment threads, projected into the plan as `<Decision>`.
 *
 * `MAX_QUOTE` bounds a locator, not the passage: a thread records the extent it
 * marked separately, so a long selection is truncated here rather than refused.
 */
export const MAX_QUOTE = 500;
export const MAX_NOTE = 4_000;
export const MAX_HANDLE = 80;
/** ISO 8601, with room for an offset. */
export const MAX_TIMESTAMP = 40;
