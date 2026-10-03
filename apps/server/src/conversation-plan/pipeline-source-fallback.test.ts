import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import type { JevAnswer } from "./jev";
import { applyInference } from "./domain";
import { applyEvent } from "./events";
import { optionIdFor, planEvents } from "./policy";
import { buildCandidateTargetingRequest } from "./questions";
import { extractQuotes } from "./quotes";
import { confidentChoice, first, follow, member, message } from "./policy-initial.test-fixtures";
import { addThreadWithOption } from "./policy-terminal.test-fixtures";
import { hostingState } from "./pipeline-commitment.test-fixtures";

test("a sourced fallback condition qualifies the pending VPS choice only with a clear referent", () => {
	let state = hostingState();
	let managedOptionId = optionIdFor("channel", "managed-hosting-option", 0, 1000);
	state = applyEvent(state, {
		id: "managed-hosting-option-event",
		type: "option.added",
		threadId: "hosting-thread",
		observedThreadVersion: state.threads[0]!.version,
		origin: "human",
		actor: member("Mina"),
		at: 1000,
		contribution: {
			id: managedOptionId,
			text: "Use managed hosting.",
			authoring: "human-edited",
		},
	});
	state = addThreadWithOption(
		state,
		"other-thread",
		"Where should backups live?",
		"backup-option",
		"Keep backups on object storage.",
	);
	let proposal = message("vps-proposal", "Let's host it on our own VPS.", "Mina");
	state = applyInference(state, {
		id: "vps-pending-event",
		type: "settle.suggested",
		threadId: "hosting-thread",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: proposal.ts,
		source: {
			messageId: proposal.id,
			author: proposal.author as ConversationPlan.SourceAuthor,
			quote: proposal.text,
			start: 0,
			end: proposal.text.length,
			role: "resolution",
		},
		optionId: "vps-option",
	}, proposal);
	let current = message(
		"qualified-vps",
		"yes, and keep managed hosting as the escape hatch if on-call gets silly",
		"Jules",
	);
	let quotes = extractQuotes(current.text);
	let isolated = buildCandidateTargetingRequest(
		current,
		[proposal],
		state.threads,
		quotes,
		1,
		state.events,
	);
	expect(isolated.questions.c1_qualifies_pending_settle?.type).toBe("noul");
	let condition: Parameters<typeof planEvents>[0]["candidates"][number] = {
		...quotes[1]!,
		answers: {
			...follow({ role: "constraint", thread: "hosting-thread" }),
			role: {
				type: "choice" as const,
				choice: "constraint",
				confidence: 0.46,
				probabilities: { constraint: 0.46, support: 0.3, option: 0.14, none: 0.1 },
			},
			option: confidentChoice("none"),
			relation: {
				type: "choice" as const,
				choice: "qualifies",
				confidence: 0.76,
				probabilities: { qualifies: 0.76, supports: 0.18, unrelated: 0.06 },
			},
			planning_substance: { type: "noul" as const, noul: 0.91 },
			qualifies_pending_settle: { type: "noul" as const, noul: 0.91 },
			duplicate: { type: "noul" as const, noul: 0.08 },
		},
	};
	let triage: Record<string, JevAnswer> = {
		...first({ constraint: 0.9 }),
		significance: {
			type: "score",
			score: 2,
			confidence: 1,
			legend: { "0": "none", "1": "minor", "2": "useful" },
			probabilities: { "0": 0, "1": 0, "2": 1 },
		},
	};
	let assess = (
		candidate = condition,
		firstAnswers = triage,
		candidateState = state,
	) =>
		planEvents({
			channelId: "channel",
			message: current,
			state: candidateState,
			first: firstAnswers,
			candidates: [candidate],
		});
	let accepted = assess();
	expect(accepted.events.map(event => event.type)).toEqual(["constraint.added"]);
	expect(accepted.events[0]).toMatchObject({
		threadId: "hosting-thread",
		source: { ...quotes[1], role: "constraint" },
		contribution: { targetId: "vps-option", relation: "qualifies" },
	});
	let strongFallbackSupport = assess({
		...condition,
		answers: {
			...condition.answers,
			role: confidentChoice("support"),
			support: { type: "noul" as const, noul: 0.96 },
			option: confidentChoice(managedOptionId),
		},
	}, { ...triage, support: { type: "noul", noul: 0.96 } });
	expect(strongFallbackSupport.events.map(event => event.type)).toEqual(["constraint.added"]);
	expect(strongFallbackSupport.events[0]).toMatchObject({
		contribution: { targetId: "vps-option", relation: "qualifies" },
	});
	expect(
		assess({
			...condition,
			answers: {
				...condition.answers,
				option: confidentChoice("backup-option"),
			},
		}).events[0],
	).toMatchObject({ contribution: { targetId: "vps-option" } });
	let guards: Record<string, JevAnswer>[] = [
		{ thread: confidentChoice("none") },
		{ relation: confidentChoice("unrelated") },
		{ qualifies_pending_settle: { type: "noul" as const, noul: 0.4 } },
		{ planning_substance: { type: "noul" as const, noul: 0.4 } },
		{ duplicate: { type: "noul" as const, noul: 0.9 } },
	];
	for (let answers of guards) {
		expect(assess({ ...condition, answers: { ...condition.answers, ...answers } }).events)
			.toEqual([]);
	}
	expect(
		assess(condition, {
			...triage,
			c0_owned_unretracted: { type: "noul", noul: 0.2 },
		}).events,
	).toEqual([]);
	let stale = structuredClone(state);
	stale.threads[0]!.pendingSettle = undefined;
	expect(assess(condition, triage, stale).events).toEqual([]);
	let withdrawal = message("vps-withdrawal", "I no longer support the VPS.", "Mina");
	let withdrawn = applyInference(state, {
		id: "vps-withdrawal-event",
		type: "stance.changed",
		scopedProposalId: null,
		threadId: "hosting-thread",
		observedThreadVersion: state.threads[0]!.version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: withdrawal.ts,
		source: {
			messageId: withdrawal.id,
			author: withdrawal.author as ConversationPlan.SourceAuthor,
			quote: withdrawal.text,
			start: 0,
			end: withdrawal.text.length,
			role: "objection",
		},
		optionId: "vps-option",
		position: "oppose",
	}, withdrawal);
	expect(assess(condition, triage, withdrawn).events).toEqual([]);
});
