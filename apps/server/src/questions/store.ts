/**
 * The authority on what a questionnaire says and what it has been answered.
 *
 * Everyone editing an answer works on one shared CRDT rather than private
 * copies, because the result is a single decision. This owns the authoritative
 * model: a patch is applied to a clone and read back against the definition
 * before it is accepted, so a client cannot introduce a shape the definition
 * does not describe, no matter what it sends.
 *
 * Resolution is two-phase. Answering a durable question has to change the plan
 * document as well as this record, and neither the waiting agent nor any client
 * may be told the decision is final until both have happened. A claim reserves
 * the outcome, the caller performs the durable half, and only then does the
 * commit make it visible.
 */

import * as Question from "@chopin/question";

import type { Answer, DecisionDefinition, Definition, Drafts, Model } from "@chopin/question";

/** How long a resolved questionnaire is remembered, for late arrivals. */
const CLOSED_TTL = 5 * 60 * 1_000;

export type Collaborator = {
	client: string;
	handle: string;
	question?: string;
	field?: "choices" | "custom";
};

export type Ended =
	| { status: "answered"; answers: Answer[]; resolver: string }
	| { status: "cancelled"; resolver: string };

type Open = {
	id: string;
	definition: DecisionDefinition;
	/** The plan node this belongs to, when it has one. */
	widget?: string;
	model: Model;
	revision: number;
	presence: Map<string, Collaborator>;
	/** Set while a resolution is in flight; blocks edits and rival claims. */
	claim?: "submit" | "cancel";
	/** Resolves the promise the agent is waiting on. */
	settle?: (ended: Ended) => void;
};

type Closed = { result: Ended; revision: number; expires: number };

export type Claim = {
	id: string;
	entry: Open;
	result: Ended;
};

export type Questions = {
	open: Map<string, Open>;
	/**
	 * Tombstones.
	 *
	 * A submit that arrives just after somebody else's would otherwise be told
	 * the questionnaire never existed, which reads as an error rather than as
	 * "they got there first".
	 */
	closed: Map<string, Closed>;
};

export type StoredOpen = {
	id: string;
	definition: DecisionDefinition;
	widget?: string;
	model: number[];
	revision: number;
};

export function create(): Questions {
	return { open: new Map(), closed: new Map() };
}

export function dump(questions: Questions): StoredOpen[] {
	return [...questions.open.values()].map(entry => ({
		id: entry.id,
		definition: entry.definition,
		...(entry.widget ? { widget: entry.widget } : {}),
		model: [...entry.model.toBinary()],
		revision: entry.revision,
	}));
}

export function restore(entries: StoredOpen[]): Questions {
	let questions = create();
	for (let entry of entries) {
		if (questions.open.has(entry.id)) Question.reject("Questionnaire is duplicated in storage");
		if (!Number.isSafeInteger(entry.revision) || entry.revision < 0) {
			Question.reject("Questionnaire revision is invalid");
		}
		if (
			!Array.isArray(entry.model)
			|| entry.model.some(value => !Number.isInteger(value) || value < 0 || value > 255)
		) Question.reject("Questionnaire model is invalid");
		let definition = Question.decision(entry.definition);
		questions.open.set(entry.id, {
			id: entry.id,
			definition,
			...(entry.widget ? { widget: entry.widget } : {}),
			model: Question.restore(entry.model, definition),
			revision: entry.revision,
			presence: new Map(),
		});
	}
	return questions;
}

function sweep(questions: Questions): void {
	let now = Date.now();
	for (let [id, entry] of questions.closed) {
		if (entry.expires <= now) questions.closed.delete(id);
	}
}

function remember(questions: Questions, id: string, result: Ended, revision: number): void {
	sweep(questions);
	questions.closed.set(id, { result, revision, expires: Date.now() + CLOSED_TTL });
}

/**
 * Register a questionnaire and hand back the promise its asker waits on.
 *
 * The definition is already normalised and identified by the caller, because
 * the plan node referencing these ids has to be built before anyone is told
 * the questionnaire exists.
 */
export function ask(
	questions: Questions,
	id: string,
	definition: Definition,
	widget?: string,
): Promise<Ended> {
	if (questions.open.has(id)) Question.reject("Questionnaire is already open");
	questions.closed.delete(id);

	let decision = Question.decision(definition);
	let model = Question.create(decision);
	// Proves the freshly built model reads back as the definition describes,
	// rather than discovering it does not on the first patch.
	Question.read(model, decision);

	return new Promise<Ended>(settle => {
		questions.open.set(id, {
			id,
			definition: decision,
			...(widget ? { widget } : {}),
			model,
			revision: 0,
			presence: new Map(),
			settle,
		});
	});
}

export function get(questions: Questions, id: string): Open | undefined {
	return questions.open.get(id);
}

/** Everything still open, for a client that has just joined. */
export function outstanding(
	questions: Questions,
): Array<{ id: string; definition: DecisionDefinition; widget?: string }> {
	return [...questions.open.values()].map(entry => ({
		id: entry.id,
		definition: entry.definition,
		...(entry.widget ? { widget: entry.widget } : {}),
	}));
}

export type Opened =
	| {
		open: true;
		definition: DecisionDefinition;
		model: number[];
		revision: number;
		presence: Collaborator[];
	}
	| { open: false };

export function snapshot(questions: Questions, id: string): Opened {
	let entry = questions.open.get(id);
	if (!entry) return { open: false };
	return {
		open: true,
		definition: entry.definition,
		model: [...entry.model.toBinary()],
		revision: entry.revision,
		presence: [...entry.presence.values()],
	};
}

export type Edited =
	| { open: true; accepted: true; applied: boolean; revision: number }
	| { open: true; accepted: false; revision: number; message: string }
	| { open: false; revision: number };

/**
 * Apply one patch, if the questionnaire is in a state to take it.
 *
 * Whether the patch itself is acceptable is the domain's question, answered by
 * `Question.apply`. What is decided here is who may ask: a questionnaire that
 * is resolving takes no more edits, because its answer has already been read.
 */
export function edit(questions: Questions, id: string, binary: number[]): Edited {
	let entry = questions.open.get(id);
	if (!entry) {
		let ended = questions.closed.get(id);
		return { open: false, revision: ended?.revision ?? 0 };
	}

	if (entry.claim) {
		return {
			open: true,
			accepted: false,
			revision: entry.revision,
			message: "Questionnaire is resolving",
		};
	}

	let outcome = Question.apply(entry.model, entry.definition, binary);
	if (!outcome.ok) {
		return { open: true, accepted: false, revision: entry.revision, message: outcome.message };
	}
	if (!outcome.changed) {
		return { open: true, accepted: true, applied: false, revision: entry.revision };
	}

	entry.model = outcome.model;
	entry.revision++;
	return { open: true, accepted: true, applied: true, revision: entry.revision };
}

/** Note who is looking at which question, for the badges beside it. */
export function focus(questions: Questions, id: string, person: Collaborator): boolean {
	let entry = questions.open.get(id);
	if (!entry) return false;

	if (!person.question) entry.presence.delete(person.client);
	else if (entry.definition.questions.some(item => item.id === person.question)) {
		entry.presence.set(person.client, person);
	} else return false;

	return true;
}

/** Forget a departed connection's presence across every open questionnaire. */
export function away(questions: Questions, client: string): string[] {
	let touched: string[] = [];
	for (let entry of questions.open.values()) {
		if (entry.presence.delete(client)) touched.push(entry.id);
	}
	return touched;
}

/**
 * Already decided, by somebody else.
 *
 * Carries the outcome rather than an error, because arriving second is not a
 * failure — the answer they wanted is right there.
 */
export type Settled = {
	ok: false;
	reason: "resolved";
	status: "answered" | "cancelled";
	resolver: string;
	answers?: Answer[];
};

/** How submitting can be refused. Mirrors what the reply may carry. */
export type SubmitRefusal =
	| Settled
	| { ok: false; reason: "stale"; current: number }
	| { ok: false; reason: "invalid"; message: string };

/** How cancelling can be refused. It cannot be stale: there is nothing to match. */
export type CancelRefusal = Settled | { ok: false; reason: "resolving" };

function resolved(entry: Closed): Settled {
	return {
		ok: false,
		reason: "resolved",
		status: entry.result.status,
		resolver: entry.result.resolver,
		...(entry.result.status === "answered" ? { answers: entry.result.answers } : {}),
	};
}

/**
 * Reserve an answer.
 *
 * The revision must match: two people submitting different drafts at the same
 * moment is exactly the case this exists for, and the one working from stale
 * state is told so rather than silently overwriting.
 */
export function claimSubmit(
	questions: Questions,
	id: string,
	revision: number,
	resolver: string,
): { ok: true; claim: Claim; answers: Answer[]; widget?: string } | SubmitRefusal {
	let ended = questions.closed.get(id);
	if (ended) return resolved(ended);

	let entry = questions.open.get(id);
	if (!entry) {
		return { ok: false, reason: "resolved", status: "cancelled", resolver: "system" };
	}
	if (entry.claim) return { ok: false, reason: "stale", current: entry.revision };
	if (revision !== entry.revision) return { ok: false, reason: "stale", current: entry.revision };

	let drafts: Drafts;
	try {
		drafts = Question.read(entry.model, entry.definition);
	} catch (err) {
		return {
			ok: false,
			reason: "invalid",
			message: err instanceof Error ? err.message : "invalid",
		};
	}

	let outcome = Question.derive(entry.definition, drafts);
	if (!outcome.ok) return { ok: false, reason: "invalid", message: outcome.message };

	entry.claim = "submit";
	return {
		ok: true,
		answers: outcome.answers,
		...(entry.widget ? { widget: entry.widget } : {}),
		claim: { id, entry, result: { status: "answered", answers: outcome.answers, resolver } },
	};
}

export function claimCancel(
	questions: Questions,
	id: string,
	resolver: string,
): { ok: true; claim: Claim; widget?: string } | CancelRefusal {
	let ended = questions.closed.get(id);
	if (ended) return resolved(ended);

	let entry = questions.open.get(id);
	if (!entry) {
		return { ok: false, reason: "resolved", status: "cancelled", resolver: "system" };
	}
	if (entry.claim) return { ok: false, reason: "resolving" };

	entry.claim = "cancel";
	return {
		ok: true,
		...(entry.widget ? { widget: entry.widget } : {}),
		claim: { id, entry, result: { status: "cancelled", resolver } },
	};
}

/** Make a claimed resolution final, and release whoever was waiting on it. */
export function stage(questions: Questions, claim: Claim): () => Ended {
	questions.open.delete(claim.id);
	remember(questions, claim.id, claim.result, claim.entry.revision);
	return () => {
		claim.entry.settle?.(claim.result);
		return claim.result;
	};
}

export function commit(questions: Questions, claim: Claim): Ended {
	return stage(questions, claim)();
}

/** Undo a claim whose durable half failed. The questionnaire stays open. */
export function rollback(questions: Questions, claim: Claim): void {
	if (questions.open.get(claim.id) !== claim.entry) return;
	claim.entry.claim = undefined;
}

/**
 * Release everything, without recording an outcome.
 *
 * Used when the process is going away. The questionnaire is not cancelled —
 * nobody declined it — so whoever is waiting simply stops waiting.
 */
export function shutdown(questions: Questions): void {
	questions.open.clear();
	questions.closed.clear();
}
