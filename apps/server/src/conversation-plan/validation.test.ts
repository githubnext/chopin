import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import {
	assertCorrectionAction,
	assertEventShape,
	MAX_ANALYSIS,
	MAX_EVENTS,
	MAX_QUEUE,
	MAX_RESEARCH_OFFERS,
	MAX_THREADS,
	spikeAgreementLabel,
	spikePreferenceLabel,
} from "./validation";

function base(): ConversationPlan.EventBase {
	return {
		id: "event-1",
		threadId: "thread-1",
		observedThreadVersion: 0,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1,
	};
}
function human(): ConversationPlan.EventBase {
	return { ...base(), origin: "human", actor: { kind: "member", handle: "maggie" } };
}
function source(
	role: ConversationPlan.SourceRole = "question",
	quote = "Which?",
): ConversationPlan.SourceRef {
	return {
		messageId: "message-1",
		author: { kind: "member", handle: "maggie" },
		quote,
		start: 0,
		end: quote.length,
		role,
	};
}

test("explicit human decisions validate without claiming a chat quote", () => {
	expect(() =>
		assertEventShape({ ...human(), type: "decision.recorded", text: "Use Bun", explicit: true })
	)
		.not.toThrow();
	expect(() =>
		assertEventShape({ ...human(), type: "decision.recorded", text: "Use Bun", explicit: false })
	)
		.toThrow("decision requires explicit resolution");
	expect(() =>
		assertEventShape({
			...human(),
			type: "decision.recorded",
			text: "Use Bun",
			explicit: true,
			source: source(),
		})
	)
		.toThrow("human action cannot claim a message quote");
});

let optionId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
function planner(): ConversationPlan.EventBase {
	return { ...base(), origin: "planner", actor: { kind: "agent" } };
}

test("all archived event kinds retain their field-validation path", () => {
	let events = [
		{ ...base(), type: "thread.opened", source: source(), question: "Which?" },
		{ ...planner(), type: "thread.opened", question: "Which?" },
		...["option.added", "reason.added", "constraint.added"].map(type => ({
			...base(),
			type,
			source: source("option"),
			contribution: { id: "contribution-1", text: "Bun", authoring: "quoted" },
		})),
		{
			...human(),
			type: "option.added",
			contribution: { id: optionId, text: "Bun", authoring: "human-edited" },
		},
		{
			...human(),
			type: "reason.added",
			source: source("reason"),
			contribution: { id: optionId, text: "Which?", authoring: "quoted" },
		},
		{
			...base(),
			type: "stance.changed",
			source: source("support"),
			position: "support",
			scopedProposalId: null,
		},
		{ ...planner(), type: "option.relabeled", optionId, label: "Bun", observedCardRevision: 0 },
		{ ...base(), type: "thread.leaning", source: source("support") },
		{ ...base(), type: "card.linked", questionnaireId: "card-1" },
		...["settle.suggested", "settle.agreed"].map(type => ({
			...base(),
			type,
			source: source("support"),
			optionId,
		})),
		{ ...base(), type: "settle.deferred", source: source("constraint"), proposalId: "proposal-1" },
		{
			...base(),
			type: "settle.resumed",
			source: source("verification"),
			proposalId: "proposal-1",
			deferredEventId: "deferred-1",
		},
		{
			...base(),
			type: "scoped-choice.proposed",
			source: source("support", "I'd pick Bun for the spike."),
			cardId: "card-1",
			optionId,
			label: "Bun",
			scope: "spike",
		},
		{
			...base(),
			type: "scoped-choice.agreed",
			source: source("support", "yep, Bun for the spike."),
			proposalId: "proposal-1",
			cardId: "card-1",
			optionId,
			label: "Bun",
			scope: "spike",
		},
		{
			...human(),
			type: "scoped-choice.saved",
			proposalId: "proposal-1",
			cardId: "card-1",
			optionId,
			label: "Bun",
			scope: "spike",
			sources: [source("support")],
			expectedGeneration: 0,
		},
		{ ...human(), type: "thread.discarded" },
		{
			...base(),
			type: "decision.recorded",
			source: source("resolution"),
			text: "Use Bun",
			explicit: true,
		},
		{ ...human(), type: "decision.reopened", explicit: true },
		{ ...base(), type: "decision.reopened", source: source("reopening"), explicit: true },
		{
			...base(),
			type: "candidate.proposed",
			source: source("resolution"),
			candidate: { id: "candidate-1", kind: "resolution", text: "Use Bun" },
		},
		...["candidate.confirmed", "candidate.rejected"].map(type => ({
			...human(),
			type,
			candidateId: "candidate-1",
		})),
		{
			...human(),
			type: "card.corrected",
			change: { kind: "edit", field: "question", text: "Which runtime?" },
		},
	];
	for (let event of events) expect(() => assertEventShape(event)).not.toThrow();
});

test("event IDs, versions, unknown fields, and actor origin must validate", () => {
	let event = { ...base(), type: "thread.opened", source: source(), question: "Which?" };
	for (
		let override of [
			{ id: "" },
			{ id: "x".repeat(201) },
			{ threadId: "" },
			{ observedThreadVersion: -1 },
			{ observedThreadVersion: 0.5 },
			{ at: Number.MAX_SAFE_INTEGER + 1 },
			{ actor: { kind: "member", handle: "maggie" } },
			{ origin: "other" },
			{ actor: { kind: "classifier", extra: true } },
			{ extra: true },
			{ source: { ...source(), quote: "Wrong" } },
			{ question: "x".repeat(501) },
			{ type: "unknown" },
		]
	) expect(() => assertEventShape({ ...event, ...override })).toThrow();
	expect(() => assertEventShape({ ...event, id: "x".repeat(200), question: "x".repeat(500) })).not
		.toThrow();
	expect(() =>
		assertEventShape({ ...planner(), type: "thread.opened", question: "x".repeat(1000) })
	).not.toThrow();
	expect(() =>
		assertEventShape({ ...planner(), type: "thread.opened", question: "x".repeat(1001) })
	).toThrow();
});

test("human event restrictions and explicit decisions remain distinct from correction actions", () => {
	for (
		let event of [
			{ ...base(), type: "decision.recorded", text: "Use Bun", explicit: true },
			{ ...human(), type: "decision.reopened", explicit: false },
			{ ...base(), type: "thread.discarded" },
			{ ...base(), type: "candidate.confirmed", candidateId: "candidate-1" },
			{
				...base(),
				type: "card.corrected",
				change: { kind: "edit", field: "question", text: "Which?" },
			},
			{ ...human(), type: "card.corrected", change: { kind: "record-decision", text: "Use Bun" } },
			{
				...human(),
				type: "option.added",
				contribution: { id: "not-a-ulid", text: "Bun", authoring: "human-edited" },
			},
		]
	) expect(() => assertEventShape(event)).toThrow();
	expect(() =>
		assertCorrectionAction({
			actionId: "action-1",
			threadId: "thread-1",
			expectedVersion: 0,
			change: { kind: "record-decision", text: "Use Bun" },
		})
	).not.toThrow();
});

test("scoped saves validate bounded unique support IDs and matching member sources", () => {
	let event = {
		...human(),
		type: "scoped-choice.saved",
		proposalId: "proposal-1",
		cardId: "card-1",
		optionId,
		label: "Bun",
		scope: "spike",
		expectedGeneration: 0,
	};
	expect(() =>
		assertEventShape({ ...event, supportEventIds: ["support-1"], sources: [source("support")] })
	).not.toThrow();
	for (
		let fields of [
			{ supportEventIds: [], sources: [] },
			{
				supportEventIds: ["support-1", "support-1"],
				sources: [source("support"), source("support")],
			},
			{
				supportEventIds: Array.from({ length: MAX_EVENTS + 1 }, (_, index) => `support-${index}`),
				sources: [],
			},
			{ supportEventIds: ["support-1"], sources: [] },
			{ supportEventIds: ["support-1"], agreementId: "agreement-1", sources: [source("support")] },
			{
				supportEventIds: ["support-1", "support-2"],
				sources: [source("support"), source("support")],
			},
			{ sources: [source("question")] },
		]
	) expect(() => assertEventShape({ ...event, ...fields })).toThrow();
});

test("correction action variants validate scoped IDs and fields without applying changes", () => {
	let changes = [
		{ kind: "add-excerpt", messageId: "message-1", start: 0, end: 500, contributionKind: "option" },
		{ kind: "edit", field: "question", text: "Which?" },
		{ kind: "edit", field: "decision", text: "Use Bun" },
		{ kind: "edit", field: "contribution", contributionId: "contribution-1", text: "Bun" },
		{
			kind: "move",
			contributionId: "contribution-1",
			targetThreadId: "thread-2",
			targetVersion: 0,
		},
		{ kind: "set-status", status: "reopened" },
		{ kind: "retarget-stance", stanceId: "stance-1", optionId },
		{ kind: "dismiss-stance", stanceId: "stance-1" },
		{ kind: "retarget-contribution", contributionId: "contribution-1", targetId: optionId },
		{ kind: "record-decision", text: "Use Bun", optionId },
		{ kind: "confirm-candidate", candidateId: "candidate-1" },
		{ kind: "reject-candidate", candidateId: "candidate-1" },
	];
	for (let change of changes) {
		expect(() =>
			assertCorrectionAction({
				actionId: "action-1",
				threadId: "thread-1",
				expectedVersion: 0,
				change,
			})
		).not.toThrow();
	}
	let action = {
		actionId: "action-1",
		threadId: "thread-1",
		expectedVersion: 0,
		change: { kind: "edit", field: "question", text: "Which?" },
	};
	for (
		let fields of [
			{ actionId: "" },
			{ threadId: "x".repeat(201) },
			{ expectedVersion: -1 },
			{ extra: true },
			{ change: { ...action.change, extra: true } },
			{ change: { ...action.change, contributionId: "unexpected" } },
			{ change: { kind: "edit", field: "contribution", text: "Bun" } },
			{ change: { kind: "set-status", status: "decided" } },
			{
				change: {
					kind: "add-excerpt",
					messageId: "message-1",
					start: 0,
					end: 501,
					contributionKind: "option",
				},
			},
			{
				change: {
					kind: "move",
					contributionId: "contribution-1",
					targetThreadId: "thread-2",
					targetVersion: 0.5,
				},
			},
		]
	) expect(() => assertCorrectionAction({ ...action, ...fields })).toThrow();
});

test("spike wording and exported snapshot bounds retain the archived contract", () => {
	expect(spikePreferenceLabel("I'd pick Bun for the spike.")).toBe("Bun");
	expect(spikeAgreementLabel("yep, Bun for a spike!")).toBe("Bun");
	expect(spikePreferenceLabel("We should use Bun.")).toBeUndefined();
	expect(spikeAgreementLabel("yep, Bun for production.")).toBeUndefined();
	expect([MAX_THREADS, MAX_EVENTS, MAX_ANALYSIS, MAX_QUEUE, MAX_RESEARCH_OFFERS])
		.toEqual([20, 4096, 64, 128, 64]);
});
