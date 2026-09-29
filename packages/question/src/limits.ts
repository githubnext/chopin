/**
 * Bounds on a questionnaire.
 *
 * Enforced by the VM when the agent asks a question and again on every edit.
 * Clients apply the same numbers so a rejection is never a surprise. Verbatim
 * host dialogs skip the per-field counts and lengths; the byte limits below
 * still apply to them.
 */

export const MAX_QUESTIONS = 10;
export const MAX_OPTIONS = 20;
/** The most options a question may hold once members start appending their own. */
export const MAX_SHARED_OPTIONS = 10;
export const MAX_HEADER = 80;
export const MAX_QUESTION = 1_000;
export const MAX_LABEL = 200;
export const MAX_DESCRIPTION = 1_000;
export const MAX_CUSTOM = 4_000;

/** Longest idempotency key for appending an option. */
export const MAX_KEY = 64;

/** One collaborative edit to the shared draft. */
export const MAX_PATCH_BYTES = 64 * 1024;

/** The draft's whole CRDT state, which grows with editing history. */
export const MAX_MODEL_BYTES = 256 * 1024;

/** Longest a tool call id may be, since it identifies the request. */
export const MAX_CALL_ID = 256;

/** How long host input waits for an answer before its card expires unanswered. */
export const INPUT_EXPIRY_MS = 30 * 60 * 1_000;
