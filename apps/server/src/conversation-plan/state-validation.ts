import type { ConversationPlan } from "@chopin/protocol";
import { assertEventShape } from "./event-validation";
import { assertResearchOfferShape } from "./research-validation";
import { assertResearchState } from "./research-state";
import {
	id,
	knownKeys,
	MAX_ANALYSIS,
	MAX_EVENTS,
	MAX_QUEUE,
	MAX_RESEARCH_OFFERS,
	MAX_THREADS,
	record,
	version,
} from "./validation-fields";

function unitProbability(value: unknown): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error("invalid analysis probability");
	}
}

function analysisDistribution(value: unknown, max: number): Record<string, number> {
	let distribution = record(value);
	let keys = Object.keys(distribution);
	if (keys.length < 2 || keys.length > max) throw new Error("invalid analysis distribution");
	for (let key of keys) {
		id(key);
		unitProbability(distribution[key]);
	}
	let total = Object.values(distribution).reduce((sum: number, item) => sum + (item as number), 0);
	if (Math.abs(total - 1) > 0.08) throw new Error("invalid analysis distribution");
	return distribution as Record<string, number>;
}

export function assertStateShape(value: unknown): asserts value is ConversationPlan.State {
	let state = record(value);
	knownKeys(state, [
		"schemaVersion",
		"revision",
		"events",
		"threads",
		"queue",
		"analysis",
		"researchOffers",
		"research",
	]);
	if (state.schemaVersion !== 1 && state.schemaVersion !== 2) {
		throw new Error("unsupported conversation plan schema");
	}
	if (state.schemaVersion === 2) assertResearchState(state.research, assertAnalysisRecord);
	else if (state.research !== undefined) {
		throw new Error("version one cannot contain research analysis");
	}
	version(state.revision);
	if (
		!Array.isArray(state.events) || state.events.length > MAX_EVENTS
		|| !Array.isArray(state.threads) || state.threads.length > MAX_THREADS
		|| !Array.isArray(state.queue) || state.queue.length > MAX_QUEUE
		|| !Array.isArray(state.analysis) || state.analysis.length > MAX_ANALYSIS
	) throw new Error("invalid conversation plan snapshot arrays");
	if (state.researchOffers !== undefined) {
		if (!Array.isArray(state.researchOffers) || state.researchOffers.length > MAX_RESEARCH_OFFERS) {
			throw new Error("invalid research offers array");
		}
		let offerIds = new Set<string>();
		let sources = new Set<string>();
		let needs = new Set<string>();
		let actionIds = new Set<string>();
		let threadIds = new Set(state.threads.map((item: ConversationPlan.Thread) => item.id));
		for (let offer of state.researchOffers) {
			assertResearchOfferShape(offer);
			let need = JSON.stringify([offer.needId, offer.contextId]);
			if (
				offerIds.has(offer.id) || sources.has(offer.source.messageId) || needs.has(need)
				|| offer.action && actionIds.has(offer.action.id)
			) throw new Error("duplicate research offer identity");
			if (offer.threadId !== undefined && !threadIds.has(offer.threadId)) {
				throw new Error("research offer thread is missing");
			}
			offerIds.add(offer.id);
			sources.add(offer.source.messageId);
			needs.add(need);
			if (offer.action) actionIds.add(offer.action.id);
		}
	}
	for (let event of state.events) assertEventShape(event);
	for (let item of state.queue) {
		let queued = record(item);
		knownKeys(queued, ["messageId", "status", "attempts", "error"]);
		id(queued.messageId);
		if (!["pending", "processing", "failed"].includes(queued.status as string)) {
			throw new Error("invalid queue status");
		}
		version(queued.attempts);
		if (
			queued.error !== undefined && (typeof queued.error !== "string" || queued.error.length > 300)
		) throw new Error("invalid queue error");
	}
	if (new Set(state.queue.map((item) => item.messageId)).size !== state.queue.length) {
		throw new Error("duplicate queued message");
	}
	for (let item of state.analysis) assertAnalysisRecord(item);
}

export function assertAnalysisRecord(item: unknown): void {
	let analysis = record(item);
	knownKeys(analysis, [
		"messageId",
		"questionSetVersion",
		"modelVersion",
		"status",
		"passes",
		"selectedTarget",
		"quoteValidation",
		"outcomes",
		"policyGate",
		"candidates",
		"eventIds",
		"latencyMs",
		"error",
	]);
	id(analysis.messageId);
	id(analysis.questionSetVersion);
	id(analysis.modelVersion);
	if (
		!["queued", "running", "applied", "unlinked", "failed"].includes(analysis.status as string)
	) throw new Error("invalid analysis status");
	if (!Array.isArray(analysis.passes) || analysis.passes.length > 3) {
		throw new Error("invalid analysis passes");
	}
	for (let [index, pass] of analysis.passes.entries()) {
		let p = record(pass);
		knownKeys(p, ["stage", "version", "answers"]);
		if (!["triage", "targeting", "clarification"].includes(p.stage as string)) {
			throw new Error("invalid analysis pass stage");
		}
		if (p.stage === "clarification") {
			if (
				index !== 2 || analysis.passes[0]?.stage !== "triage"
				|| analysis.passes[1]?.stage !== "targeting"
				|| p.version !== "bare-editor-clarification-1"
			) throw new Error("invalid clarification pass version or order");
		} else if (p.version !== undefined) {
			throw new Error("invalid analysis pass version");
		}
		let answers = record(p.answers);
		if (Object.keys(answers).length > 45) throw new Error("too many analysis questions");
		let answerEntries = 0;
		for (let [question, value] of Object.entries(answers)) {
			id(question);
			let answer = record(value);
			if (answer.type === "noul") {
				knownKeys(answer, ["type", "noul"]);
				unitProbability(answer.noul);
				continue;
			}
			if (answer.type === "choice") {
				knownKeys(answer, ["type", "choice", "confidence", "probabilities"]);
				id(answer.choice);
				unitProbability(answer.confidence);
				let distribution = analysisDistribution(answer.probabilities, 255);
				answerEntries += Object.keys(distribution).length;
				if (
					!(answer.choice as string in distribution)
					|| distribution[answer.choice as string] + 0.01
						< Math.max(...Object.values(distribution))
				) {
					throw new Error("invalid analysis choice");
				}
				continue;
			}
			if (answer.type === "score") {
				knownKeys(answer, ["type", "score", "confidence", "legend", "probabilities"]);
				unitProbability(answer.confidence);
				let legend = record(answer.legend);
				let levels = Object.keys(legend);
				if (
					levels.length < 2 || levels.length > 10
					|| levels.some((level, index) =>
						level !== String(index) || typeof legend[level] !== "string"
						|| !(legend[level] as string).trim() || (legend[level] as string).length > 500
					)
				) throw new Error("invalid analysis score legend");
				let distribution = analysisDistribution(answer.probabilities, 10);
				answerEntries += Object.keys(distribution).length;
				if (
					Object.keys(distribution).length !== levels.length
					|| levels.some((level) => !(level in distribution))
				) {
					throw new Error("invalid analysis score distribution");
				}
				let weighted = levels.reduce((sum, level, index) => sum + index * distribution[level], 0);
				if (
					typeof answer.score !== "number" || !Number.isFinite(answer.score)
					|| answer.score < 0 || answer.score > levels.length - 1
					|| Math.abs(answer.score - weighted) > 0.12
				) {
					throw new Error("invalid analysis score");
				}
				continue;
			}
			throw new Error("invalid analysis answer type");
		}
		if (answerEntries > 512) throw new Error("too many analysis answer entries");
	}
	if (!Array.isArray(analysis.eventIds) || analysis.eventIds.length > 12) {
		throw new Error("invalid analysis event IDs");
	}
	for (let eventId of analysis.eventIds) id(eventId);
	if (analysis.outcomes !== undefined) {
		if (!Array.isArray(analysis.outcomes) || analysis.outcomes.length > 4) {
			throw new Error("invalid candidate outcomes");
		}
		for (let outcome of analysis.outcomes) {
			let item = record(outcome);
			knownKeys(item, ["start", "end", "status", "gate", "targetId", "eventIds"]);
			version(item.start);
			version(item.end);
			if (
				(item.end as number) <= (item.start as number)
				|| !["accepted", "review", "ignored"].includes(item.status as string)
				|| typeof item.gate !== "string" || !item.gate || item.gate.length > 300
				|| !Array.isArray(item.eventIds) || item.eventIds.length > 12
			) {
				throw new Error("invalid candidate outcome");
			}
			if (item.targetId !== undefined) id(item.targetId);
			for (let eventId of item.eventIds) {
				id(eventId);
				if (!analysis.eventIds.includes(eventId)) {
					throw new Error("candidate outcome event is not accepted");
				}
			}
		}
	}
	if (
		analysis.error !== undefined
		&& (typeof analysis.error !== "string" || analysis.error.length > 300)
	) throw new Error("invalid analysis error");
	if (analysis.latencyMs !== undefined) version(analysis.latencyMs);
	if (analysis.selectedTarget !== undefined) id(analysis.selectedTarget);
	if (
		analysis.policyGate !== undefined
		&& (typeof analysis.policyGate !== "string" || analysis.policyGate.length > 300)
	) throw new Error("invalid analysis policy gate");
	if (analysis.candidates !== undefined) {
		if (!Array.isArray(analysis.candidates) || analysis.candidates.length > 12) {
			throw new Error("invalid analysis candidates");
		}
		for (let candidate of analysis.candidates) {
			let c = record(candidate);
			knownKeys(c, ["id", "kind", "targetId"]);
			id(c.id);
			if (!["resolution", "reopening"].includes(c.kind as string)) {
				throw new Error("invalid analysis candidate kind");
			}
			if (c.targetId !== undefined) id(c.targetId);
		}
	}
	if (analysis.quoteValidation !== undefined) {
		if (!Array.isArray(analysis.quoteValidation) || analysis.quoteValidation.length > 12) {
			throw new Error("invalid quote validation debug");
		}
		for (let quote of analysis.quoteValidation) {
			let q = record(quote);
			knownKeys(q, ["start", "end", "valid"]);
			version(q.start);
			version(q.end);
			if ((q.end as number) <= (q.start as number) || typeof q.valid !== "boolean") {
				throw new Error("invalid quote validation debug");
			}
		}
	}
}
