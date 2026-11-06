/**
 * Chopin's own terms, which a person never reads: the agent as "the Planner", a machine being
 * connected to it as "attached" or "detached", a connection that is "held", and `@chopin`, which
 * is only ever typed by the person and never drawn for them.
 *
 * The one pattern every test of the words a person can read uses (a status, a strip, a refusal, a
 * Chat line from the server), so a new sentence cannot bring one back. `detach` is its own word (it
 * contains `tach`, not `attach`), and `attach` takes every form of it.
 */
export const INTERNAL = /planner|detach|attach|\bheld\b|@chopin/i;

/**
 * What the text about a machine and its connection (its status, its strips, its refusals, the
 * Chat lines about its connection) must not say. It adds "Decision" to the terms above: that is
 * Chopin's word for its cards, and it tells a person nothing about a machine. Everywhere else
 * Decision and Decisions are the product's own word and stay.
 */
export const INTERNAL_IN_STATUS = new RegExp(`${INTERNAL.source}|\\bdecisions?\\b`, "i");
