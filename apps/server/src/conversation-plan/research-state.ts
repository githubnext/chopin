import type { ConversationPlan } from "@chopin/protocol";
import * as Draft from "@chopin/draft";
import {
	actor,
	id,
	knownKeys,
	MAX_ANALYSIS,
	MAX_QUEUE,
	record,
	text,
	version,
} from "./validation-fields";
import { assertSourceShape } from "./sources";

export function emptyResearchState(): ConversationPlan.ResearchState {
	return { queue: [], analysis: [], retries: [] };
}

export function upgradeResearchState(state: ConversationPlan.State): ConversationPlan.State {
	if (state.schemaVersion === 2) return state;
	return {
		...state,
		schemaVersion: 2,
		research: {
			...emptyResearchState(),
			queue: state.queue.map(item => ({
				...item,
				status: item.status === "processing" ? "pending" : item.status,
			})),
		},
	};
}

function array(value: unknown, maximum: number): unknown[] {
	if (!Array.isArray(value) || value.length > maximum) {
		throw new Error("invalid research collection");
	}
	return value;
}

export function researchSources(value: unknown): void {
	let sources = array(value, 24);
	if (!sources.length) throw new Error("research source is required");
	for (let value of sources) {
		let source = record(value);
		knownKeys(source, ["messageId", "author", "quote", "start", "end"]);
		assertSourceShape({ ...source, role: "support" });
		if (record(source.author).kind !== "member") {
			throw new Error("research source must be a member");
		}
	}
}

export function assertResearchContext(value: unknown): void {
	let context = record(value);
	knownKeys(context, ["messages", "decisions"]);
	if (JSON.stringify(context).length > 24000) throw new Error("research context exceeds budget");
	for (let value of array(context.messages, 13)) {
		let message = record(value);
		knownKeys(message, ["id", "author", "text"]);
		id(message.id);
		actor(message.author);
		if (record(message.author).kind === "classifier") {
			throw new Error("invalid research context author");
		}
		text(message.text, 4000);
	}
	for (let value of array(context.decisions, 12)) {
		let decision = record(value);
		knownKeys(decision, ["id", "version", "question", "options", "answer"]);
		id(decision.id);
		version(decision.version);
		text(decision.question, 500);
		if (decision.answer !== undefined) text(decision.answer, 500);
		for (let value of array(decision.options, 10)) {
			let option = record(value);
			knownKeys(option, ["id", "label"]);
			id(option.id);
			text(option.label, 200);
		}
	}
}

export function assertResearchWorkflow(value: unknown, offer: Record<string, unknown>): void {
	let item = record(value);
	knownKeys(item, [
		"version",
		"revision",
		"generation",
		"mode",
		"placementMessageId",
		"sources",
		"context",
		"published",
		"preparation",
		"jobId",
		"modelVersion",
		"draft",
		"editedBy",
		"additions",
		"previousOfferId",
		"accepted",
	]);
	if (item.version !== 1) throw new Error("unsupported research workflow version");
	version(item.revision);
	version(item.generation);
	if (!["automatic", "human"].includes(item.mode as string)) {
		throw new Error("invalid research authorship");
	}
	id(item.placementMessageId);
	researchSources(item.sources);
	if (
		!(item.sources as ConversationPlan.ResearchSource[]).some(source =>
			source.messageId === item.placementMessageId
		)
	) throw new Error("research placement lacks source");
	assertResearchContext(item.context);
	if (
		typeof item.published !== "boolean"
		|| !["pending", "ready", "failed"].includes(item.preparation as string)
	) throw new Error("invalid research preparation");
	for (let key of ["jobId", "modelVersion", "previousOfferId"]) {
		if (item[key] !== undefined) id(item[key]);
	}
	let editors = array(item.editedBy, 100);
	for (let editor of editors) id(editor);
	if (new Set(editors).size !== editors.length) throw new Error("duplicate research editor");
	if (item.draft !== undefined) {
		if (Draft.read(Draft.restore(item.draft as number[])) !== offer.brief) {
			throw new Error("research draft differs from brief");
		}
		let bytes = array(item.draft, 256 * 1024);
		if (
			!bytes.length
			|| bytes.some(byte =>
				!Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255
			)
		) throw new Error("invalid research draft bytes");
	}
	let additions = array(item.additions, 32).map(value => {
		let addition = record(value);
		knownKeys(addition, ["id", "text", "sources", "status", "actionId", "actor"]);
		id(addition.id);
		text(addition.text, 2048);
		researchSources(addition.sources);
		if (!["pending", "applied", "dismissed"].includes(addition.status as string)) {
			throw new Error("invalid research addition");
		}
		if (addition.status === "pending") {
			if (addition.actionId !== undefined || addition.actor !== undefined) {
				throw new Error("unacted research addition");
			}
		} else {
			id(addition.actionId);
			id(addition.actor);
		}
		return addition.id;
	});
	if (new Set(additions).size !== additions.length) throw new Error("duplicate research addition");
	if (offer.status === "accepted") {
		let accepted = record(item.accepted);
		knownKeys(accepted, ["brief", "revision", "executionKey"]);
		text(accepted.brief, 2048);
		version(accepted.revision);
		id(accepted.executionKey);
		if (!item.published || accepted.brief !== offer.brief || accepted.revision !== item.revision) {
			throw new Error("research accepted snapshot differs");
		}
	} else if (item.accepted !== undefined) throw new Error("unaccepted research snapshot");
}

export function assertResearchState(
	value: unknown,
	validateAnalysis: (value: unknown) => void,
): void {
	let state = record(value);
	knownKeys(state, ["queue", "analysis", "retries"]);
	let queued = array(state.queue, MAX_QUEUE).map(value => {
		let item = record(value);
		knownKeys(item, ["messageId", "status", "attempts", "error"]);
		id(item.messageId);
		version(item.attempts);
		if (!["pending", "processing", "failed"].includes(item.status as string)) {
			throw new Error("invalid research queue status");
		}
		if (item.error !== undefined) text(item.error, 300);
		return item.messageId;
	});
	if (new Set(queued).size !== queued.length) throw new Error("duplicate research queue message");
	let analyzed = array(state.analysis, MAX_ANALYSIS).map(value => {
		let item = record(value);
		knownKeys(item, [
			"messageId",
			"questionSetVersion",
			"modelVersion",
			"status",
			"answers",
			"policyGate",
			"offerId",
			"latencyMs",
		]);
		if (!["applied", "unlinked", "failed"].includes(item.status as string)) {
			throw new Error("invalid research analysis status");
		}
		let { answers, offerId, ...base } = item;
		validateAnalysis({ ...base, passes: [{ stage: "triage", answers }], eventIds: [] });
		if (offerId !== undefined) id(offerId);
		return item.messageId;
	});
	if (new Set(analyzed).size !== analyzed.length) throw new Error("duplicate research analysis");
	let retries = array(state.retries, 4096).map(value => {
		let item = record(value);
		knownKeys(item, ["id", "messageId"]);
		id(item.id);
		id(item.messageId);
		return item.id;
	});
	if (new Set(retries).size !== retries.length) throw new Error("duplicate research retry");
}
