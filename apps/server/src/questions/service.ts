/**
 * Questions, as a room offers them.
 *
 * Two things have to stay in step: the record that owns an answer, and the
 * plan document that shows it. The record is authoritative — an agent
 * rewriting the prose around a decision cannot change the decision — but a
 * plan that does not show its own answers is not much of a plan.
 *
 * So resolving is ordered rather than parallel. The answer is claimed, written
 * into the document, and only then committed. If the document write fails the
 * claim is rolled back and the questionnaire is still open, which is a state
 * everyone already knows how to render.
 */

import * as Store from "./store";

export type { CardEvent } from "./card-event";
export { insertConversationCard } from "./card-insertion";
export { involved } from "./card-involved";
export { announce, listen, meta } from "./card-notifications";
export { relabelConversationOption } from "./card-option-relabel";
export { revisePlannerCard } from "./card-planner-revision";
export { retitle } from "./card-retitle";
export { addServerOption } from "./card-server-options";
export { suggest } from "./card-suggestions";
export {
	isOpenStatus,
	matchesQuestionSource,
	normalizeRecord,
	questionMentionsOption,
} from "./records";
export type { DecisionEntry, OptionOrigin, Record } from "./records";
export { appendOption as addOption } from "./service-append-option";
export { ask } from "./service-ask";
export { cancel, withdraw } from "./service-cancel";
export { identify } from "./service-definition";
export type { AskPlacement } from "./service-definition";
export { discard } from "./service-discard";
export { away, edit, focus, greet, open, shutdown } from "./service-draft";
export {
	anchors,
	invalidate,
	outstanding,
	place,
	prose,
	rebase,
	relate,
	setProse,
} from "./service-relationships";
export type { Placement } from "./service-relationships";
export { reopen } from "./service-reopen";
export { submit } from "./service-submit";
export type { Questions, StoredOpen } from "./store";

export const create = Store.create;
export const dump = Store.dump;
export const restore = Store.restore;
