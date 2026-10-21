import { limits, parse, ulid } from "@chopin/dialect";
import { SEECODE_LANGUAGE } from "@chopin/dialect/dialect";
import * as Question from "@chopin/question";
import * as Y from "yjs";

import * as Anchors from "./anchors";

import { applyEvent } from "../conversation-plan/events";

import { MAX_EVENTS, MAX_THREADS } from "../conversation-plan/validation";

import * as room from "../plan/room";
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
		capture?: { identities: string[]; signal?: AbortSignal };
		/** Somebody waits on the answer, which therefore reaches them rather than a new turn. */
		awaited?: boolean;
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
		let indices = definition.questions.flatMap((_, index) =>
			options.capture && plan.records.has(options.capture.identities[index]!) ? [] : [index]
		);
		if (!indices.length) return;
		if (options.capture?.signal?.aborted) Question.reject("Decision capture was cancelled");
		if (options.revision !== undefined && options.revision !== plan.revision) {
			Question.reject("The document changed; read it again before opening a decision");
		}
		let fresh = { questions: indices.map(index => definition.questions[index]!) };
		let placement = options.placement;
		if (options.capture && placement && "blocks" in placement) {
			if (placement.blocks.length !== definition.questions.length) {
				Question.reject("Give one placement for every question");
			}
			let blocks = placement.blocks;
			placement = { ...placement, blocks: indices.map(index => blocks[index]!) };
		}
		let near = placement && "near" in placement ? nearBlock(plan, placement.near) : undefined;
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
