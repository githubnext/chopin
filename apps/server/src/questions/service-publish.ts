import { limits, parse, ulid } from "@chopin/dialect";
import { SEECODE_LANGUAGE } from "@chopin/dialect/dialect";
import * as Question from "@chopin/question";
import * as Y from "yjs";

import * as Anchors from "./anchors";

import { applyEvent } from "../conversation-plan/events";

import { MAX_EVENTS, MAX_THREADS } from "../conversation-plan/validation";

import * as edit from "../plan/edit";
import * as room from "../plan/room";
import { holdsQuestion } from "./records";
import * as Store from "./store";

import { broadcast } from "../wire";
import type { Server } from "bun";

import type { DecisionDefinition, Definition } from "@chopin/question";
import * as Service from "../plan/service";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";
import type { Ended } from "./store";
import type { Record } from "./records";

import { announce } from "./card-notifications";
import { type AskPlacement, validatePlacement } from "./service-definition";

/**
 * The prose block a question concerns, as a Planner's blocking question names it: the block at
 * `index` when its digest still matches, else the one block with that digest. A changed, repeated
 * or non-prose block resolves to nothing, and the card stays unlinked at the end of the document.
 */
export type AskNear = { near: { index: number; digest: string } };

function nearBlock(plan: Plan, near: AskNear["near"]) {
	let index = room.resolveBlock(plan.document, near);
	if (index === undefined) return undefined;
	let block = parse(room.project(plan.document)).children[index];
	if (
		!block || block.type === "mdxJsxFlowElement"
			&& (block.name === "Questionnaire" || block.name === "Decision")
	) return undefined;
	let digest = room.digests(plan.document)[index]!;
	return { at: { index, digest }, anchor: room.anchorAt(plan.document, index, digest) };
}

function captureScopes(
	plan: Plan,
	placement: AskPlacement,
	anchors: NonNullable<Record["followUp"]>["target"][],
): Array<{ followUp: NonNullable<Record["followUp"]>; at: AskNear["near"] }> {
	let scopes = new Map<string, NonNullable<Record["followUp"]>>();
	for (let record of plan.records.values()) {
		if (!record.followUp) continue;
		let target = room.rebase(plan.document, record.followUp.target);
		let primary = target[0];
		let key = primary && !primary.orphaned ? room.resolveAnchor(plan.document, primary) : undefined;
		if (key) scopes.set(key, { scope: record.followUp.scope, target });
	}
	let blocks = parse(room.project(plan.document)).children;
	let digests = room.digests(plan.document);
	return anchors.map((related, index) => {
		let at = placement.blocks[index]?.[0];
		let target = related[0];
		if (!at || blocks[at.index]?.type !== "paragraph" || !target) {
			Question.reject("Relate each captured decision to a provisional paragraph first");
		}
		let key = room.resolveAnchor(plan.document, target);
		if (!key) Question.reject("The captured decision's paragraph could not be resolved");
		let scope = scopes.get(key);
		if (!scope) {
			let targets = [target];
			for (let next = at.index + 1; next < blocks.length; next++) {
				let block = blocks[next]!;
				if (
					block.type !== "table" && !(block.type === "code" && block.lang === SEECODE_LANGUAGE)
				) break;
				targets.push(room.anchorAt(plan.document, next, digests[next]!));
			}
			scope = { scope: ulid(), target: targets };
		}
		let indices = scope.target.map(anchor => {
			let matches = blocks.flatMap((_, at) =>
				!anchor.orphaned && room.matchesAnchor(plan.document, anchor, at) ? [at] : []
			);
			if (matches.length !== 1) Question.reject("The decision scope target could not be resolved");
			return matches[0]!;
		});
		if (indices.some((at, index) => index > 0 && at !== indices[index - 1]! + 1)) {
			Question.reject("The decision scope target is no longer contiguous");
		}
		scopes.set(key, scope);
		let last = indices.at(-1)!;
		return { followUp: structuredClone(scope), at: { index: last, digest: digests[last]! } };
	});
}

const STALE_BATCH = "The document changed; read it again before opening a decision";

function unmatched(key: string, cause: string): string {
	return `${STALE_BATCH}. The passage for decision "${key}" cannot be matched to one block of the `
		+ `document as you read it: ${cause}.`;
}

const NO_READ = "the server no longer has that read";

type Located = { index: number } | { cause: string };

/**
 * The live block the Planner's read named, found by identity wherever it now stands and whatever
 * it now says, or why none can be named: the server no longer has that read, the address does not
 * match what was read there, the paragraph appeared more than once when it was read, or the block
 * that was read has since gone.
 */
function locate(
	plan: Plan,
	revision: number,
	block: { index: number; digest: string },
): Located {
	let read = edit.read(plan, revision);
	if (!read) return { cause: NO_READ };
	if (read.blocks[block.index]?.digest !== block.digest) {
		return { cause: "its address does not match the block you read at that position" };
	}
	let seen = read.blocks.filter(candidate => candidate.digest === block.digest);
	if (seen.length > 1) {
		return { cause: "the same paragraph appeared more than once when you read it" };
	}
	let anchor = read.anchors[block.index];
	let index = anchor && room.blockNamedBy(plan.document, anchor);
	return index === undefined
		? { cause: "the block you read has been rewritten, removed or moved since" }
		: { index };
}

/**
 * The block a stale batch meant, found against the revision the Planner read rather than the
 * document as it stands: the block that was read must still carry the digest, now alone. A
 * paragraph rewritten since, or already repeated when it was read, never resolves to an identical
 * twin; neither does a revision that is no longer retained. Otherwise, why not.
 */
function readBlock(
	plan: Plan,
	revision: number,
	block: { index: number; digest: string },
): Located {
	let located = locate(plan, revision, block);
	if ("cause" in located) return located;
	if (room.digests(plan.document)[located.index] !== block.digest) {
		return { cause: "the block you read has been rewritten, removed or moved since" };
	}
	return room.uniqueBlock(plan.document, block) === located.index
		? located
		: { cause: "an identical paragraph now stands beside it" };
}

/** Where each passage of a card now is, brought forward onto the document as it stands. */
function cardAnchors(plan: Plan, record: Record) {
	let id = record.definition.questions[0]!.id;
	let anchors = Anchors.read(record).questions[id]?.anchors ?? [];
	return room.rebase(plan.document, anchors, { marking: true });
}

/**
 * The block each passage of a card still names, or nothing where it can no longer be told, and
 * whether the card's anchor found it by digest alone, now or on an earlier rebase.
 */
function cardBlocks(
	plan: Plan,
	record: Record,
): Array<{ index: number; byDigest: boolean } | undefined> {
	return cardAnchors(plan, record).map(anchor => {
		let index = anchor.orphaned ? undefined : room.blockNamedBy(plan.document, anchor);
		return index === undefined ? undefined : { index, byDigest: anchor.byDigest === true };
	});
}

/**
 * The block a card's widget follows: the nearest block before it that is not another card or a
 * visual attached to its passage. Where a card's anchor was recovered by digest onto an identical
 * paragraph elsewhere, this still says where the card actually stands.
 */
function blockBeforeCard(plan: Plan, record: Record): number | undefined {
	let widget = room.questionnaireIndex(plan.document, record.id);
	if (widget === undefined) return undefined;
	let blocks = parse(room.project(plan.document)).children;
	let beside = (block: (typeof blocks)[number]) =>
		block.type === "table" || block.type === "code" && block.lang === SEECODE_LANGUAGE
		|| block.type === "mdxJsxFlowElement"
			&& (block.name === "Questionnaire" || block.name === "Decision");
	let index = widget - 1;
	while (index >= 0 && beside(blocks[index]!)) index--;
	return index >= 0 ? index : undefined;
}

/** Whether a stale input points a known key at an intact passage other than the card's own. */
function namesAnotherPassage(
	plan: Plan,
	readAt: number,
	record: Record,
	related: Array<{ index: number; digest: string }>,
): boolean {
	let hashes = room.digests(plan.document);
	let blocks = cardBlocks(plan, record);
	return related.some((block, position) => {
		let located = locate(plan, readAt, block);
		return !("cause" in located) && hashes[located.index] === block.digest
			&& located.index !== blocks[position]?.index;
	});
}

/** What identifies a decision's definition, leaving out its ids and any option or criterion in `skip`. */
function shape(item: Question.Item, skip = new Set<string>()): string {
	return JSON.stringify([
		item.header,
		item.question,
		item.description ?? null,
		item.response ?? null,
		item.multiple,
		item.verbatim ?? false,
		item.options.filter(option => !skip.has(option.id)).map(option => [
			option.label,
			option.description,
			option.preview ?? null,
		]),
		(item.criteria ?? []).filter(criterion => !skip.has(criterion.id)).map(criterion =>
			criterion.label
		),
	]);
}

/** Whether a card made under a stable key has the definition the repeated input describes. */
function sameDefinition(record: Record, wanted: Question.Item): boolean {
	let stored = record.definition.questions[0];
	if (!stored || record.definition.questions.length !== 1) return false;
	let appended = new Set(Object.values(record.appended ?? {}));
	return shape(stored, appended) === shape(wanted);
}

/**
 * Whether a card an earlier call made under this stable key is the decision the repeated input
 * describes: the same question, response kind and choices, apart from options or criteria people
 * appended since, and the same passages. A card that no longer holds its question is only
 * compared on its definition, as its passages no longer mean anything. Nothing is placed, so the
 * card's own anchor says which block it sits beside; the input's digest must still match that block,
 * and its index too unless the document has moved on since the Planner read it, in which case the
 * block the Planner read, where the server still has that read, must be the card's block. Where it
 * does not, the card must stand right after the one passage it was opened on and its anchor must
 * never have been found again by digest alone: such an anchor may sit on an identical copy.
 */
function repeats(
	plan: Plan,
	record: Record,
	wanted: Question.Item,
	related: Array<{ index: number; digest: string }>,
	readAt: number | undefined,
): boolean {
	if (!sameDefinition(record, wanted)) return false;
	if (!holdsQuestion(record.status)) return true;
	let blocks = cardBlocks(plan, record);
	if (blocks.length !== related.length) return false;
	let hashes = room.digests(plan.document);
	let retained = readAt !== undefined && edit.read(plan, readAt) !== undefined;
	let standing = readAt !== undefined && !retained ? blockBeforeCard(plan, record) : undefined;
	return blocks.every((found, position) => {
		let block = related[position]!;
		if (!found || hashes[found.index] !== block.digest) return false;
		if (readAt === undefined) return found.index === block.index;
		if (retained) {
			let located = locate(plan, readAt, block);
			return !("cause" in located) && located.index === found.index;
		}
		// Without the read, only where the card stands says which paragraph it was opened beside,
		// and it stands beside the first passage alone; a later one cannot be told from a twin.
		// An anchor found again by digest alone says nothing more: it may sit on an identical copy
		// of a paragraph rewritten since, which is also the block before the card.
		return position === 0 && standing === found.index && !found.byDigest;
	});
}

/** Create records, drafts and their document projections in one durable mutation. */
export async function publishQuestions(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	definition: Definition,
	options: {
		placement?: AskPlacement | AskNear;
		origin?: "planner" | "human";
		by?: string;
		/** Stable identity for a retryable single-card creation. */
		identity?: string;
		/** Anchored nonblocking Planner cards, with one retry identity per question. */
		capture?: { identities: string[]; keys?: string[]; signal?: AbortSignal };
		/** Somebody waits on the answer, which therefore reaches them rather than a new turn. */
		awaited?: boolean;
		/**
		 * The Planner's own card: without a block it can still place, it goes beside the
		 * document's first section and is linked to it, rather than trailing unlinked.
		 */
		section?: boolean;
		revision?: number;
		created?: () => void;
	} = {},
) {
	if (Service.isQuestionPage(plan)) Question.reject(Service.QUESTION_PAGE_REFUSAL);
	if (Service.implementationActive(plan)) throw new Error("implementation is active");
	if (definition.questions.length === 0 || options.identity && definition.questions.length !== 1) {
		Question.reject("Invalid decision count");
	}
	if (
		options.capture && (options.identity || !options.placement || !("blocks" in options.placement)
			|| options.capture.identities.length !== definition.questions.length
			|| new Set(options.capture.identities).size !== definition.questions.length)
	) Question.reject("Invalid capture identities or placement");
	let asked: Array<{
		id: string;
		single: DecisionDefinition;
		value: room.QuestionnaireInsertion["value"];
		waiting: Promise<Ended>;
		at: room.QuestionnaireInsertion["at"];
	}> = [];
	await Service.exclusive(plan, async () => {
		if (options.identity && plan.records.has(options.identity)) {
			// The actor-scoped request identity survives later retitling and resolution.
			return;
		}
		let readAt = options.revision !== undefined && options.revision !== plan.revision
			? options.revision
			: undefined;
		let stale = readAt !== undefined;
		if (options.capture && options.placement && "blocks" in options.placement) {
			// A repeated key replays only the decision it made. Anything else would hand the
			// Planner an unrelated card as though its new question were already in the document.
			let { blocks } = options.placement;
			definition.questions.forEach((wanted, index) => {
				let record = plan.records.get(options.capture!.identities[index]!);
				let related = blocks[index] ?? [];
				if (record && !repeats(plan, record, wanted, related, readAt)) {
					let key = options.capture!.keys?.[index] ?? options.capture!.identities[index]!;
					if (
						readAt !== undefined && sameDefinition(record, wanted)
						&& !namesAnotherPassage(plan, readAt, record, related)
					) {
						let found = related.map(block => readBlock(plan, readAt, block)).find(block =>
							"cause" in block
						);
						let cause = found && "cause" in found
							? found.cause
							: "the card for this key no longer stands beside the block you read";
						// Without that read, a card found again by digest alone may be on a copy.
						if (cause === NO_READ && cardBlocks(plan, record).some(block => block?.byDigest)) {
							cause += ", and the card's paragraph can only be found again by its text, which an "
								+ "identical copy would match too";
						}
						Question.reject(unmatched(key, cause));
					}
					Question.reject(
						`Decision key "${key}" already holds a different decision, so this one was not opened. `
							+ "Use a new key for a different question or passage.",
					);
				}
			});
		}
		let indices = definition.questions.flatMap((_, index) =>
			options.capture && plan.records.has(options.capture.identities[index]!) ? [] : [index]
		);
		if (!indices.length) return;
		if (options.capture?.signal?.aborted) Question.reject("Decision capture was cancelled");
		if (stale && !options.capture) {
			Question.reject(STALE_BATCH);
		}
		let fresh = { questions: indices.map(index => definition.questions[index]!) };
		let placement = options.placement;
		if (options.capture && placement && "blocks" in placement) {
			if (placement.blocks.length !== definition.questions.length) {
				Question.reject("Give one placement for every question");
			}
			let blocks = placement.blocks;
			placement = { ...placement, blocks: indices.map(index => blocks[index]!) };
			if (readAt !== undefined) {
				// The block the Planner read, wherever it now stands; one that changed, that another
				// block repeats, or that was repeated when it was read, is refused, never guessed.
				let keys = options.capture!.keys;
				let located = placement.blocks.map((related, at) =>
					related.map(block => ({ found: readBlock(plan, readAt, block), block, at }))
				);
				for (let { found, at } of located.flat()) {
					if (!("cause" in found)) continue;
					let position = indices[at]!;
					Question.reject(unmatched(
						keys?.[position] ?? options.capture!.identities[position]!,
						found.cause,
					));
				}
				placement = {
					revision: plan.revision,
					blocks: located.map(related =>
						related.map(({ found, block }) => ({
							index: (found as { index: number }).index,
							digest: block.digest,
						}))
					),
				};
			}
		}
		let near = placement && "near" in placement ? nearBlock(plan, placement.near) : undefined;
		if (!near && options.section && !(placement && "blocks" in placement)) {
			let first = room.firstSection(plan.document);
			near = first && nearBlock(plan, first);
		}
		let anchors = placement && "blocks" in placement
			? validatePlacement(plan, fresh, placement)
			: near && fresh.questions.map(() => [near.anchor]);
		let followUps = options.capture && placement && "blocks" in placement
			? captureScopes(plan, placement, anchors!)
			: undefined;
		let placedAt = (index: number) =>
			followUps
				? followUps[index]!.at
				: placement && "blocks" in placement
				? placement.blocks[index]?.[0]
				: near?.at;
		if (Service.implementationActive(plan)) throw new Error("implementation is active");
		let questions: Store.Questions = {
			open: new Map(plan.questions.open),
			closed: new Map(plan.questions.closed),
		};
		let records = new Map(plan.records);
		let conversationPlan = plan.conversationPlan;
		asked = fresh.questions.map((question, index) => {
			let single = Question.decision({ questions: [question] });
			// Widget and question identities are deliberately distinct.
			let id = options.capture?.identities[indices[index]!] ?? options.identity ?? ulid();
			// Classifier capacity must not prevent an ordinary Planner questionnaire.
			let available = MAX_EVENTS - conversationPlan.events.length - plan.pendingCardActions.length;
			// Host dialogs keep their raw text, which conversation events cannot carry.
			let threadId = options.origin !== "human" && !question.verbatim
					&& conversationPlan.threads.length < MAX_THREADS
					&& question.options.length + 2 <= available
				? ulid()
				: undefined;
			let at = Math.floor(Date.now() / 1_000);
			if (threadId) {
				conversationPlan = applyEvent(conversationPlan, {
					id: `ask:${id}:opened`,
					type: "thread.opened",
					threadId,
					observedThreadVersion: 0,
					origin: "planner",
					actor: { kind: "agent" },
					at,
					question: question.question,
				});
				for (let option of question.options) {
					let version = conversationPlan.threads.find(thread => thread.id === threadId)!.version;
					conversationPlan = applyEvent(conversationPlan, {
						id: `ask:${id}:option:${option.id}`,
						type: "option.added",
						threadId,
						observedThreadVersion: version,
						origin: "planner",
						actor: { kind: "agent" },
						at,
						contribution: {
							id: option.id,
							text: option.label,
							authoring: "scribe",
							targetId: threadId,
						},
					});
				}
				conversationPlan = applyEvent(conversationPlan, {
					id: `ask:${id}:linked`,
					type: "card.linked",
					threadId,
					observedThreadVersion: conversationPlan.threads.find(thread =>
						thread.id === threadId
					)!.version,
					origin: "classifier",
					actor: { kind: "classifier" },
					at,
					questionnaireId: id,
				});
			}
			let waiting = Store.ask(questions, id, single, id);
			if (options.awaited) questions.open.get(id)!.awaited = true;
			let value = {
				id,
				...(threadId ? { thread: threadId } : {}),
				questions: [{
					id: question.id,
					header: question.header,
					prompt: question.question,
					...(question.description === undefined ? {} : { description: question.description }),
					...(question.response ? { response: question.response } : {}),
					multiple: question.multiple,
					options: question.options.map(option => ({
						id: option.id,
						label: option.label,
						...(option.description ? { description: option.description } : {}),
						...(option.preview ? { preview: option.preview } : {}),
					})),
					...(question.criteria
						? { criteria: question.criteria.map(({ id, label }) => ({ id, label })) }
						: {}),
				}],
			};
			let record: Record = {
				id,
				definition: single,
				status: "open",
				origin: options.origin ?? "planner",
				...(options.by ? { owner: options.by } : {}),
				...(threadId ? { threadId } : {}),
				history: [],
				optionOrigins: {},
				editors: options.by ? [options.by] : [],
				...(followUps ? { followUp: followUps[index]!.followUp } : {}),
			};
			if (anchors) {
				record.anchors = Anchors.set(Anchors.read(record), question.id, anchors[index]!);
			}
			records.set(id, record);
			return { id, single, value, waiting, at: placedAt(index) };
		});
		// Verbatim host input has no per-field limits. Refuse before anything is registered or
		// published.
		if (!room.fitsQuestionnaires(plan.document, asked.map(item => item.value))) {
			Question.reject(
				`This input would take the document past its ${limits.MAX_SOURCE_BYTES / 1024} KiB limit`,
			);
		}
		let document = await room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			room.project(plan.document),
			[],
		);
		document.seq = plan.document.seq;
		try {
			if (options.capture?.signal?.aborted) Question.reject("Decision capture was cancelled");
			let mutation = room.insertQuestionnaires(
				document,
				asked.map(item => ({
					value: item.value,
					...(item.at ? { at: item.at } : {}),
				})),
			);
			await Service.publishStaged(plan, server, roomId, {
				...plan,
				document,
				questions,
				records,
				conversationPlan,
			}, mutation);
		} finally {
			document.doc.destroy();
		}
		for (let item of asked) {
			announce(plan, server, roomId, item.id);
			broadcast(server, roomId, {
				kind: "question:asked",
				ts: 0,
				id: item.id,
				definition: item.single,
				widget: item.id,
			});
		}
		options.created?.();
	});

	return asked;
}
