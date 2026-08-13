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

import { ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";

import * as Anchors from "./anchors";

import * as room from "../plan/room";
import * as Store from "./store";
import { broadcast, fail, relay, reply, tell } from "../wire";

import type { Server } from "bun";
// `Plan` is the room's plan here; the protocol namespace of the same name is
// aliased so the two cannot be confused at a glance.
import type { Plan as Wired, Question as Wire, Request } from "@chopin/protocol";
import type { Answer, Definition } from "@chopin/question";
import * as Service from "../plan/service";

import type { Plan } from "../plan/service";
import type { Socket, SocketData } from "../wire";
import type { Ended, Questions } from "./store";

export type { Questions } from "./store";

export type AskPlacement = {
	revision: number;
	blocks: Array<Array<{ index: number; digest: string }>>;
};

export const create = Store.create;
export const dump = Store.dump;
export const restore = Store.restore;
export type { StoredOpen } from "./store";

/**
 * Validate a questionnaire and give it durable identity.
 *
 * The domain assigns positional ids — `q0`, `o1` — which are fine while a
 * questionnaire is a single tool result and useless the moment it is a node in
 * a document the agent will rewrite around. Identity is minted once, here,
 * before anything references it.
 */
export function identify(raw: unknown): Definition {
	let definition = Question.normalize(raw);
	return {
		questions: definition.questions.map(question => ({
			...question,
			id: ulid(),
			options: question.options.map(option => ({ ...option, id: ulid() })),
		})),
	};
}

/** A questionnaire as it is stored beside the plan, so it survives a restart. */
export type Record = {
	id: string;
	definition: Definition;
	status: "open" | "answered" | "cancelled";
	/** Question id to the answer as it reads, for projection into the plan. */
	answers?: { [question: string]: string };
	resolver?: string;
	/** When it was settled, Unix seconds. Absent on one settled before we recorded it. */
	at?: number;
	/** Where in the prose each of its decisions lives. */
	anchors?: Wired.WidgetAnchors;
};

function decide(
	entry: { status: "answered"; answers: Answer[] } | { status: "cancelled" },
	definition: Definition,
): { [question: string]: string } {
	if (entry.status !== "answered") return {};
	let out: { [question: string]: string } = {};
	definition.questions.forEach((question, index) => {
		let answer = entry.answers[index];
		if (answer) out[question.id] = Question.summarize(answer);
	});
	return out;
}

/** Ask each decision independently; register its record before publishing its node. */
export async function ask(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	definition: Definition,
	placement?: AskPlacement,
	created?: () => void,
): Promise<Ended[]> {
	if (plan.execution) throw new Error("implementation is active");
	if (definition.questions.length === 0) {
		Question.reject("A questionnaire needs at least one question");
	}
	let asked: Array<{
		id: string;
		single: Definition;
		value: room.QuestionnaireInsertion["value"];
		waiting: Promise<Ended>;
		at: room.QuestionnaireInsertion["at"];
	}> = [];
	await Service.exclusive(plan, async () => {
		let anchors = placement ? validatePlacement(plan, definition, placement) : undefined;
		asked = definition.questions.map((question, index) => {
			let single = { questions: [question] };
			// Widget and question identities are deliberately distinct.
			let id = ulid();
			let waiting = Store.ask(plan.questions, id, single, id);
			let value = {
				id,
				questions: [{
					id: question.id,
					header: question.header,
					prompt: question.question,
					multiple: question.multiple,
					options: question.options.map(option => ({
						id: option.id,
						label: option.label,
						...(option.description ? { description: option.description } : {}),
					})),
				}],
			};
			let record: Record = { id, definition: single, status: "open" };
			if (anchors) {
				record.anchors = Anchors.set(Anchors.read(record), question.id, anchors[index]!);
			}
			plan.records.set(id, record);
			return { id, single, value, waiting, at: placement?.blocks[index]?.[0] };
		});

		let mutation = room.insertQuestionnaires(
			plan.document,
			asked.map(item => ({
				value: item.value,
				...(item.at ? { at: item.at } : {}),
			})),
		);
		if (mutation) await Service.publish(plan, server, roomId, mutation);
		else await Service.persistExclusive(plan);
		for (let item of asked) {
			broadcast(server, roomId, {
				kind: "question:asked",
				ts: 0,
				id: item.id,
				definition: item.single,
				widget: item.id,
			});
		}
		created?.();
	});

	return Promise.all(asked.map(item => item.waiting));
}

/** Validate every placement before registering records or document nodes. */
function validatePlacement(
	plan: Plan,
	definition: Definition,
	placement: AskPlacement,
): Wired.Anchor[][] {
	if (placement.revision !== plan.revision) {
		throw new Error("The plan changed; read it again before asking.");
	}
	if (placement.blocks.length !== definition.questions.length) {
		throw new Error("Give one placement for every question.");
	}

	let digests = room.digests(plan.document);
	return placement.blocks.map(blocks => {
		if (blocks.length === 0) {
			if (room.hasProse(plan.document)) {
				throw new Error("Relate each question to prose, or write its context first.");
			}
			return [];
		}

		return blocks.map(block => {
			let current = digests[block.index];
			if (!current) throw new Error(`no block at index ${block.index}`);
			if (current !== block.digest) {
				throw new Error(`block ${block.index} has changed; read the plan again`);
			}
			return room.anchorAt(plan.document, block.index, current);
		});
	});
}

/** Everything still unanswered, for a client that has just joined. */
export function greet(plan: Plan, ws: Socket): void {
	let open = Store.outstanding(plan.questions);
	if (open.length === 0) return;
	tell(ws, { kind: "question:sync", ts: 0, open });
}

export function open(plan: Plan, ws: Socket, msg: Request<Wire.Open.Ask>): void {
	reply(ws, msg.rid, { kind: "question:open", ts: 0, ...Store.snapshot(plan.questions, msg.id) });
}

export function edit(plan: Plan, ws: Socket, msg: Request<Wire.Edit.Ask>): void | Promise<void> {
	let outcome = Store.edit(plan.questions, msg.id, msg.patch);
	let finish = () => {
		reply(ws, msg.rid, { kind: "question:edit", ts: 0, id: msg.id, ...outcome });
		// A no-op patch is acknowledged but not relayed: peers have nothing to do
		// with it and it did not move the revision.
		if (!outcome.open || !outcome.accepted || !outcome.applied) return;
		relay(ws, {
			kind: "question:edit",
			ts: 0,
			id: msg.id,
			open: true,
			accepted: true,
			applied: true,
			revision: outcome.revision,
			patch: msg.patch,
			editor: ws.data.handle,
		});
	};
	if (outcome.open && outcome.accepted && outcome.applied) {
		return Service.persist(plan).then(finish, () => {
			fail(ws, msg.rid, "could not save questionnaire draft");
		});
	}
	finish();
}

export function focus(plan: Plan, ws: Socket, msg: Wire.Presence.Input): void {
	let person = {
		client: ws.data.client,
		handle: ws.data.handle,
		...(msg.question ? { question: msg.question } : {}),
		...(msg.field ? { field: msg.field } : {}),
	};
	if (!Store.focus(plan.questions, msg.id, person)) return;
	relay(ws, { kind: "question:presence", ts: 0, ...person, id: msg.id });
}

export function away(plan: Plan, ws: Socket): void {
	for (let id of Store.away(plan.questions, ws.data.client)) {
		relay(ws, {
			kind: "question:presence",
			ts: 0,
			id,
			client: ws.data.client,
			handle: ws.data.handle,
		});
	}
}

export async function submit(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Submit.Ask>,
): Promise<void> {
	if (plan.execution) return fail(ws, msg.rid, "implementation is active");
	let claimed = Store.claimSubmit(plan.questions, msg.id, msg.revision, ws.data.handle);
	if (!claimed.ok) {
		return reply(ws, msg.rid, { kind: "question:submit", ts: 0, id: msg.id, ...claimed });
	}

	let record = plan.records.get(msg.id);
	let answers = record
		? decide({ status: "answered", answers: claimed.answers }, record.definition)
		: {};

	// Stamped once and used in both places, so the record and the plan cannot
	// disagree about when the room decided.
	let at = Math.floor(Date.now() / 1_000);
	let settled = { by: ws.data.handle, at: new Date(at * 1_000).toISOString() };
	let mutationError: unknown;
	let finish: (() => Store.Ended) | undefined;
	await Service.exclusive(plan, async () => {
		let mutation: room.Mutation | undefined;
		try {
			mutation = room.projectAnswer(plan.document, msg.id, answers, settled);
		} catch (err) {
			mutationError = err;
			return;
		}
		if (record) {
			plan.records.set(msg.id, {
				...record,
				status: "answered",
				answers,
				resolver: ws.data.handle,
				at,
			});
		}
		finish = Store.stage(plan.questions, claimed.claim);
		if (mutation) await Service.publish(plan, server, roomId, mutation);
		else await Service.persistExclusive(plan);
	});
	if (mutationError) {
		// The decision is not final if the plan could not be told about it.
		Store.rollback(plan.questions, claimed.claim);
		return reply(ws, msg.rid, {
			kind: "question:submit",
			ts: 0,
			id: msg.id,
			ok: false,
			reason: "invalid",
			message: mutationError instanceof Error
				? mutationError.message
				: "could not record the answer",
		});
	}
	finish!();

	reply(ws, msg.rid, {
		kind: "question:submit",
		ts: 0,
		id: msg.id,
		ok: true,
		answers: claimed.answers,
		resolver: ws.data.handle,
	});
	broadcast(server, roomId, {
		kind: "question:resolved",
		ts: 0,
		id: msg.id,
		status: "answered",
		resolver: ws.data.handle,
		answers: claimed.answers,
	});
}

/**
 * Decline to answer.
 *
 * Terminal, and the node leaves the plan: a questionnaire cannot say it was
 * cancelled, so left in place it would read as one still waiting. The record
 * survives as history.
 */
export async function cancel(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.Cancel.Ask>,
): Promise<void> {
	if (plan.execution) return fail(ws, msg.rid, "implementation is active");
	let claimed = Store.claimCancel(plan.questions, msg.id, ws.data.handle);
	if (!claimed.ok) {
		return reply(ws, msg.rid, { kind: "question:cancel", ts: 0, id: msg.id, ...claimed });
	}
	let mutationError: unknown;
	let finish: (() => Store.Ended) | undefined;
	await Service.exclusive(plan, async () => {
		let mutation: room.Mutation | undefined;
		try {
			mutation = room.removeQuestionnaire(plan.document, msg.id);
		} catch (err) {
			mutationError = err;
			return;
		}
		let record = plan.records.get(msg.id);
		if (record) {
			plan.records.set(msg.id, { ...record, status: "cancelled", resolver: ws.data.handle });
		}
		finish = Store.stage(plan.questions, claimed.claim);
		if (mutation) await Service.publish(plan, server, roomId, mutation);
		else await Service.persistExclusive(plan);
	});
	if (mutationError) {
		// The questionnaire stays open and answerable, which is a state every
		// client already renders. Saying "resolving" is honest: the attempt is
		// over, and trying again is the right move.
		console.error("[questions] could not remove the node:", mutationError);
		Store.rollback(plan.questions, claimed.claim);
		return reply(ws, msg.rid, {
			kind: "question:cancel",
			ts: 0,
			id: msg.id,
			ok: false,
			reason: "resolving",
		});
	}
	finish!();

	reply(ws, msg.rid, {
		kind: "question:cancel",
		ts: 0,
		id: msg.id,
		ok: true,
		resolver: ws.data.handle,
	});
	broadcast(server, roomId, {
		kind: "question:resolved",
		ts: 0,
		id: msg.id,
		status: "cancelled",
		resolver: ws.data.handle,
	});
}

export function shutdown(questions: Questions): void {
	Store.shutdown(questions);
}

// -- relationships ---------------------------------------------------------

/** Every questionnaire's relationships, as an authoritative snapshot. */
export function anchors(plan: Plan): Wired.WidgetAnchors[] {
	return [...plan.records.values()].map(record => Anchors.read(record));
}

/**
 * Bring every relationship forward onto the document as it is now.
 *
 * Called after anything that moves prose around, which is most things. An
 * anchor whose block survived is re-expressed against it; one whose block was
 * rewritten is orphaned, and the agent is told it owes a review.
 */
export function rebase(plan: Plan): void {
	for (let [id, record] of plan.records) {
		let value = Anchors.read(record);
		let questions: { [question: string]: Wired.AnchorSet } = {};

		for (let [question, set] of Object.entries(value.questions)) {
			questions[question] = carry(plan, set);
		}

		plan.records.set(id, { ...record, anchors: { widget: value.widget, questions } });
	}
}

function carry(plan: Plan, set: Wired.AnchorSet): Wired.AnchorSet {
	let anchors = room.rebase(plan.document, set.anchors);
	let lost = anchors.some(anchor => anchor.orphaned);
	return {
		anchors,
		pending: set.pending || lost,
		...(lost ? { reason: "orphaned" as const } : set.reason ? { reason: set.reason } : {}),
	};
}

/** Mark answered results as needing review, after the plan changed beneath them. */
export function invalidate(plan: Plan, reason: Wired.AnchorReason): void {
	for (let [id, record] of plan.records) {
		plan.records.set(id, { ...record, anchors: Anchors.invalidate(record, reason) });
	}
}

/** What the agent still owes a review on. */
export function outstanding(plan: Plan): Anchors.Pending[] {
	return [...plan.records.values()].flatMap(record => Anchors.pending(record));
}

/** Replace where a decision lives with the blocks the agent reviewed it against. */
export function relate(
	plan: Plan,
	widget: string,
	question: string,
	blocks: Array<{ index: number; digest: string }>,
): string | undefined {
	let record = plan.records.get(widget);
	if (!record) return `no questionnaire ${widget}`;

	let current = room.digests(plan.document);
	let anchors: Wired.Anchor[] = [];

	for (let block of blocks) {
		let hash = current[block.index];
		if (!hash) return `no block at index ${block.index}`;
		// The digest is how the agent says which block it meant. If it does not
		// match, the plan moved between reading and anchoring, and quietly
		// anchoring the block that happens to be there now would be worse than
		// saying so.
		if (hash !== block.digest) return `block ${block.index} has changed; read the plan again`;
		anchors.push(room.anchorAt(plan.document, block.index, hash));
	}

	plan.records.set(widget, {
		...record,
		anchors: Anchors.set(Anchors.read(record), question, anchors),
	});
	return undefined;
}

export type Placement = {
	widget: string;
	blocks: Array<{ index: number; digest: string }>;
};

/** Move cards after their first related block, preserving ask order per block. */
export function place(plan: Plan, updates: Placement[]): room.Mutation | undefined {
	let records = [...plan.records.values()];
	let placements: room.QuestionnairePlacement[] = [];
	let byWidget = new Map(updates.map(update => [update.widget, update]));

	for (let record of records) {
		let update = byWidget.get(record.id);
		if (!update || record.definition.questions.length !== 1 || update.blocks.length === 0) continue;

		let home = update.blocks[0]!;
		let before = records.slice(0, records.indexOf(record)).findLast(candidate => {
			if (candidate.definition.questions.length !== 1) return false;
			let question = candidate.definition.questions[0];
			if (!question) return false;
			let anchor = Anchors.read(candidate).questions[question.id]?.anchors[0];
			return anchor !== undefined && room.matchesAnchor(plan.document, anchor, home.index);
		});

		placements.push({ id: update.widget, at: home, ...(before ? { after: before.id } : {}) });
	}

	return room.placeQuestionnaires(plan.document, placements);
}
