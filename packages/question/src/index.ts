/**
 * Collaborative questionnaires.
 *
 * The domain lives here so the server and the clients agree on what a question
 * is, what a valid answer looks like, and how a shared draft is shaped —
 * including what makes a patch acceptable, which is the rule that keeps one
 * client from corrupting an answer everybody shares.
 *
 * Transport belongs to the caller. The server owns the authoritative model and
 * decides who may write to it; this only says what writing may produce.
 */

export * as limits from "./limits";

export { assertCallId, normalize, QuestionError, reject } from "./schema";
export type { Answer, Definition, Item, Option } from "./schema";

export { answered, apply, assertPatch, create, read } from "./draft";
export type { Applied, Draft, Drafts, Mode, Model } from "./draft";

export { derive, incomplete, summarize } from "./answer";
export type { Outcome } from "./answer";

/**
 * The CRDT itself.
 *
 * Exposed because a client has to build the patches it sends, and patches are
 * already the wire format — pretending the representation is private while
 * shipping its bytes over a socket would be a fiction.
 */
export { crdt } from "./draft";
