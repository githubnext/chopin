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

import { limits, ulid } from "@chopin/dialect";
import * as Question from "@chopin/question";

import * as Anchors from "./anchors";

import * as room from "../plan/room";
import * as Store from "./store";
import { broadcast, fail, relay, reply, tell } from "../wire";

import type { Server } from "bun";
// `Plan` is the room's plan here; the protocol namespace of the same name is
// aliased so the two cannot be confused at a glance.
import type { Plan as Wired, Question as Wire, Request } from "@chopin/protocol";
import type { Answer, DecisionDefinition, Definition } from "@chopin/question";
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
export function identify(raw: unknown, options?: { verbatim?: boolean }): Definition {
	let definition = Question.normalize(raw, options);
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
	status: "open" | Wire.Status;
	/** Question id to the answer as it reads, for projection into the plan. */
	answers?: { [question: string]: string };
	resolver?: string;
	/** When it was settled, Unix seconds. Absent on one settled before we recorded it. */
	at?: number;
	/** Where in the prose each of its decisions lives. */
	anchors?: Wired.WidgetAnchors;
	/**
	 * Option-append idempotency keys to the option each created. Bounded by the
	 * option limit, and durable so a retry after a restart still finds it.
	 */
	appended?: { [key: string]: string };
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
 * Ask each decision independently; register its record before publishing its node.
 *
 * An abort withdraws the cards still open. After `expiresInMs` without an answer
 * they expire instead, and stay in the document marked as such.
 */
export async function ask(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	definition: Definition,
	placement?: AskPlacement,
	created?: () => void,
	signal?: AbortSignal,
	expiresInMs?: number,
): Promise<Ended[]> {
	if (signal?.aborted) return [];
	if (Service.implementationActive(plan)) throw new Error("implementation is active");
	if (definition.questions.length === 0) {
		Question.reject("A questionnaire needs at least one question");
	}
	let asked: Array<{
		id: string;
		single: DecisionDefinition;
		value: room.QuestionnaireInsertion["value"];
		waiting: Promise<Ended>;
		at: room.QuestionnaireInsertion["at"];
	}> = [];
	await Service.exclusive(plan, async () => {
		let anchors = placement ? validatePlacement(plan, definition, placement) : undefined;
		// Widget and question identities are deliberately distinct.
		let values = definition.questions.map(question => ({
			id: ulid(),
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
		}));
		// Verbatim host input has no per-field limits, so the document bounds it.
		if (
			definition.questions.some(question => question.verbatim)
			&& !room.fitsQuestionnaires(plan.document, values)
		) {
			Question.reject(
				`This input would take the document past its ${limits.MAX_SOURCE_BYTES / 1024} KiB limit`,
			);
		}
		asked = definition.questions.map((question, index) => {
			let single = Question.decision({ questions: [question] });
			let value = values[index]!;
			let waiting = Store.ask(plan.questions, value.id, single, value.id);
			let record: Record = { id: value.id, definition: single, status: "open" };
			if (anchors) {
				record.anchors = Anchors.set(Anchors.read(record), question.id, anchors[index]!);
			}
			plan.records.set(value.id, record);
			return { id: value.id, single, value, waiting, at: placement?.blocks[index]?.[0] };
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

	let failed = Promise.withResolvers<never>();
	let closing: Promise<unknown> | undefined;
	let close = (status: "cancelled" | "expired") => {
		closing ??= Promise.all(
			asked.map(item =>
				status === "expired"
					? expire(plan, server, roomId, item.id)
					: withdraw(plan, server, roomId, item.id, "chopin")
			),
		);
		void closing.catch(failed.reject);
	};
	let abort = () => close("cancelled");
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	let timer = expiresInMs === undefined
		? undefined
		: setTimeout(() => close("expired"), expiresInMs);
	try {
		let ended = await Promise.race([Promise.all(asked.map(item => item.waiting)), failed.promise]);
		await closing;
		return ended;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
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
	if (Service.implementationActive(plan)) return fail(ws, msg.rid, "implementation is active");
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
			// A long answer can push the document past its size limit, after which the
			// Planner can no longer edit it; check on a copy so a refusal changes nothing.
			let preview = await room.create(room.project(plan.document));
			try {
				room.projectAnswer(preview, msg.id, answers, settled);
				room.validate(room.project(preview));
			} finally {
				preview.doc.destroy();
			}
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

const ADD_OPTION_REFUSAL: { [reason in "resolved" | "resolving"]: string } = {
	resolved: "This question has already been decided",
	resolving: "This question is being decided",
};

/**
 * Append an option to an open question, for everyone.
 *
 * Ordering follows the rest of this module: the record, the open entry and the
 * plan projection change together under the plan's exclusive queue, the fenced
 * commit happens, and only then does anyone hear about it. The shared draft is
 * not touched, so nothing another member has already chosen can change.
 */
export async function addOption(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	ws: Socket,
	msg: Request<Wire.AddOption.Ask>,
): Promise<void> {
	let refuse = (reason: Wire.AddOption.Refusal, message: string) =>
		reply(ws, msg.rid, {
			kind: "question:option",
			ts: 0,
			id: msg.id,
			ok: false,
			reason,
			message,
		});
	if (Service.implementationActive(plan)) {
		return refuse("implementation", "An implementation is running; decisions cannot change");
	}

	let outcome: Wire.AddOption.Reply | undefined;
	let added: Wire.OptionAdded | undefined;
	await Service.exclusive(plan, async () => {
		// An implementation may have claimed the plan while this waited in the
		// queue. Refuse before touching the live document: `publish` would throw
		// after the Yjs mutation, leaving the room ahead of its durable state.
		if (Service.implementationActive(plan)) {
			outcome = {
				kind: "question:option",
				ts: 0,
				id: msg.id,
				ok: false,
				reason: "implementation",
				message: "An implementation is running; decisions cannot change",
			};
			return;
		}
		let record = plan.records.get(msg.id);
		let entry = Store.get(plan.questions, msg.id);
		if (!record || !entry || record.status !== "open") {
			outcome = {
				kind: "question:option",
				ts: 0,
				id: msg.id,
				ok: false,
				reason: "resolved",
				message: ADD_OPTION_REFUSAL.resolved,
			};
			return;
		}
		let applied = typeof msg.key === "string" && Object.hasOwn(record.appended ?? {}, msg.key)
			? record.appended![msg.key]
			: undefined;
		let existing = applied
			? entry.definition.questions[0].options.find(option => option.id === applied)
			: undefined;
		if (existing) {
			outcome = {
				kind: "question:option",
				ts: 0,
				id: msg.id,
				ok: true,
				option: existing,
				definition: entry.definition,
				repeated: true,
			};
			return;
		}
		if (entry.claim) {
			outcome = {
				kind: "question:option",
				ts: 0,
				id: msg.id,
				ok: false,
				reason: "resolving",
				message: ADD_OPTION_REFUSAL.resolving,
			};
			return;
		}

		let result = Question.appendOption(entry.definition, {
			question: msg.question,
			key: msg.key,
			label: msg.label,
			...(msg.description === undefined ? {} : { description: msg.description }),
		}, ulid());
		if (!result.ok) {
			outcome = {
				kind: "question:option",
				ts: 0,
				id: msg.id,
				ok: false,
				reason: result.reason,
				message: result.message,
			};
			return;
		}

		let previous = { record, definition: entry.definition };
		let mutation: room.Mutation | undefined;
		try {
			mutation = room.appendQuestionOption(plan.document, msg.id, msg.question, result.option);
		} catch (err) {
			console.error("[questions] could not add the option to the plan:", err);
			outcome = {
				kind: "question:option",
				ts: 0,
				id: msg.id,
				ok: false,
				reason: "invalid",
				message: "Could not add the option",
			};
			return;
		}
		plan.records.set(msg.id, {
			...record,
			definition: result.definition,
			appended: { ...record.appended, [msg.key]: result.option.id },
		});
		Store.redefine(plan.questions, msg.id, result.definition);
		try {
			if (mutation) await Service.publish(plan, server, roomId, mutation);
			else await Service.persistExclusive(plan);
		} catch (err) {
			plan.records.set(msg.id, previous.record);
			Store.restoreDefinition(plan.questions, msg.id, previous.definition);
			throw err;
		}
		outcome = {
			kind: "question:option",
			ts: 0,
			id: msg.id,
			ok: true,
			option: result.option,
			definition: result.definition,
		};
		added = {
			kind: "question:option-added",
			ts: 0,
			id: msg.id,
			question: msg.question,
			option: result.option,
			definition: result.definition,
			by: ws.data.handle,
		};
	}).catch(err => {
		console.error("[questions] could not save the option:", err);
		outcome = undefined;
		added = undefined;
	});

	if (!outcome) return fail(ws, msg.rid, "could not save the option");
	reply(ws, msg.rid, outcome);
	if (added) broadcast(server, roomId, added);
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
	if (Service.implementationActive(plan)) return fail(ws, msg.rid, "implementation is active");
	let result = await withdraw(plan, server, roomId, msg.id, ws.data.handle);
	reply(ws, msg.rid, { kind: "question:cancel", ts: 0, id: msg.id, ...result });
}

/** Withdraw input on behalf of a member or the Planner, after its durable commit. */
export function withdraw(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	id: string,
	resolver: string,
): Promise<Store.CancelRefusal | { ok: true; resolver: string }> {
	return closeUnanswered(
		plan,
		server,
		roomId,
		id,
		{ status: "cancelled", resolver },
		() => room.removeQuestionnaire(plan.document, id),
	);
}

/**
 * Expire host input nobody answered in time, after its durable commit.
 *
 * Unlike a withdrawal the card stays in the document, marked expired, so the
 * room can still see what was asked and that nobody answered it.
 */
export function expire(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	id: string,
): Promise<Store.CancelRefusal | { ok: true; resolver: string }> {
	let at = Math.floor(Date.now() / 1_000);
	return closeUnanswered(
		plan,
		server,
		roomId,
		id,
		{ status: "expired", resolver: "chopin", at },
		() => room.projectExpiry(plan.document, id, new Date(at * 1_000).toISOString()),
	);
}

async function closeUnanswered(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	id: string,
	closed: { status: "cancelled" | "expired"; resolver: string; at?: number },
	project: () => room.Mutation | undefined,
): Promise<Store.CancelRefusal | { ok: true; resolver: string }> {
	let { status, resolver } = closed;
	return Service.exclusive(plan, async () => {
		let claimed = Store.claimCancel(plan.questions, id, resolver, status);
		if (!claimed.ok) return claimed;
		let mutation: room.Mutation | undefined;
		try {
			mutation = project();
		} catch (err) {
			console.error(`[questions] could not project the ${status} node:`, err);
			Store.rollback(plan.questions, claimed.claim);
			return { ok: false, reason: "resolving" };
		}
		let record = plan.records.get(id);
		if (record) plan.records.set(id, { ...record, ...closed });
		let finish = Store.stage(plan.questions, claimed.claim);
		try {
			if (mutation) await Service.publish(plan, server, roomId, mutation);
			else await Service.persistExclusive(plan);
		} catch (err) {
			plan.questions.closed.delete(id);
			plan.questions.open.set(id, claimed.claim.entry);
			Store.rollback(plan.questions, claimed.claim);
			if (record) plan.records.set(id, record);
			throw err;
		}
		finish();
		broadcast(server, roomId, { kind: "question:resolved", ts: 0, id, status, resolver });
		return { ok: true, resolver };
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
