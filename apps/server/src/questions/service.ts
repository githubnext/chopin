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

import * as room from "../plan/room";
import * as Store from "./store";
import { broadcast, relay, reply, tell } from "../wire";

import type { Server } from "bun";
import type { Question as Wire, Request } from "@chopin/protocol";
import type { Answer, Definition } from "@chopin/question";
import type { Plan } from "../plan/service";
import type { Socket, SocketData } from "../wire";
import type { Ended, Questions } from "./store";

export type { Questions } from "./store";

export const create = Store.create;

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

/**
 * Ask a questionnaire, and put it in the plan.
 *
 * The record is registered before the node exists, because a client receiving
 * the plan update will immediately try to open a questionnaire by id and must
 * not be told there is no such thing.
 */
export async function ask(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	definition: Definition,
): Promise<Ended> {
	if (definition.questions.length === 0) {
		Question.reject("A questionnaire needs at least one question");
	}

	// Its own identity, not borrowed from its first question. They are
	// different things, and a lookup that matched either would be a bug
	// waiting for a questionnaire with two questions.
	let id = ulid();
	let waiting = Store.ask(plan.questions, id, definition, id);

	// The dialect calls the question text `prompt`; the domain calls it
	// `question`. Translating here keeps the document's vocabulary its own.
	let mutation = room.insertQuestionnaire(plan.document, {
		id,
		questions: definition.questions.map(question => ({
			id: question.id,
			header: question.header,
			prompt: question.question,
			multiple: question.multiple,
			options: question.options.map(option => ({
				id: option.id,
				label: option.label,
				...(option.description ? { description: option.description } : {}),
			})),
		})),
	});

	plan.records.set(id, { id, definition, status: "open" });

	if (mutation) publish(plan, server, roomId, mutation);
	broadcast(server, roomId, { kind: "question:asked", ts: 0, id, definition, widget: id });

	return waiting;
}

/** Relay a server-authored change to the document as an ordinary update. */
function publish(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	mutation: room.Mutation,
): void {
	plan.document.seq++;
	plan.revision++;
	broadcast(server, roomId, {
		kind: "plan:update",
		ts: 0,
		epoch: plan.document.epoch,
		update: Buffer.from(mutation.update).toString("base64"),
		seq: plan.document.seq,
	});
	room.mark(plan.document);
	plan.sink.touch();
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

export function edit(plan: Plan, ws: Socket, msg: Request<Wire.Edit.Ask>): void {
	let outcome = Store.edit(plan.questions, msg.id, msg.patch);
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
	let claimed = Store.claimSubmit(plan.questions, msg.id, msg.revision, ws.data.handle);
	if (!claimed.ok) {
		return reply(ws, msg.rid, { kind: "question:submit", ts: 0, id: msg.id, ...claimed });
	}

	let record = plan.records.get(msg.id);
	let answers = record
		? decide({ status: "answered", answers: claimed.answers }, record.definition)
		: {};

	try {
		let mutation = room.projectAnswer(plan.document, msg.id, answers);
		if (mutation) publish(plan, server, roomId, mutation);
	} catch (err) {
		// The decision is not final if the plan could not be told about it.
		Store.rollback(plan.questions, claimed.claim);
		return reply(ws, msg.rid, {
			kind: "question:submit",
			ts: 0,
			id: msg.id,
			ok: false,
			reason: "invalid",
			message: err instanceof Error ? err.message : "could not record the answer",
		});
	}

	Store.commit(plan.questions, claimed.claim);
	if (record) {
		plan.records.set(msg.id, { ...record, status: "answered", answers, resolver: ws.data.handle });
	}
	plan.sink.touch();

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
	let claimed = Store.claimCancel(plan.questions, msg.id, ws.data.handle);
	if (!claimed.ok) {
		return reply(ws, msg.rid, { kind: "question:cancel", ts: 0, id: msg.id, ...claimed });
	}

	try {
		let mutation = room.removeQuestionnaire(plan.document, msg.id);
		if (mutation) publish(plan, server, roomId, mutation);
	} catch (err) {
		// The questionnaire stays open and answerable, which is a state every
		// client already renders. Saying "resolving" is honest: the attempt is
		// over, and trying again is the right move.
		console.error("[questions] could not remove the node:", err);
		Store.rollback(plan.questions, claimed.claim);
		return reply(ws, msg.rid, {
			kind: "question:cancel",
			ts: 0,
			id: msg.id,
			ok: false,
			reason: "resolving",
		});
	}

	Store.commit(plan.questions, claimed.claim);
	let record = plan.records.get(msg.id);
	if (record) {
		plan.records.set(msg.id, { ...record, status: "cancelled", resolver: ws.data.handle });
	}
	plan.sink.touch();

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
