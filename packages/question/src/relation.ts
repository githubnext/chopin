/**
 * How a decision stands to the document's prose.
 *
 * Four deliberate states, not three and an absence: pending has not been
 * reviewed yet, empty was reviewed and needs no prose, and orphaned once had
 * prose that can no longer be identified safely.
 */
export type Relation = "linked" | "pending" | "empty" | "orphaned";
