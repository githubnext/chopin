import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyInference } from "./domain";
import { effectivePending } from "./preference";
import { planEvents } from "./policy";
import { buildCandidateTargetingRequest, buildTriageRequest } from "./questions";
import { extractQuotes } from "./quotes";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";
import { queueWithPendingSave } from "./pipeline-ordinary-save-pending.test-fixtures";

test("a direct proposal withdrawal becomes one sourced neutral stance, leaving another clause eligible", () => {
	let { state, proposal } = queueWithPendingSave();
	let current = message(
		"withdraw-sqs",
		"I take back my SQS preference for now. Let's verify backups before choosing.",
		"Mina",
	);
	let quotes = extractQuotes(current.text);
	expect(quotes).toHaveLength(2);
	let triage = buildTriageRequest(current, [proposal], state.threads, quotes, state.events);
	expect(triage.questions.withdrawal?.type).toBe("noul");
	let targeting = buildCandidateTargetingRequest(
		current,
		[proposal],
		state.threads,
		quotes,
		0,
		state.events,
	);
	expect(targeting.questions.c0_withdraws_pending_settle?.type).toBe("noul");
	expect(targeting.questions.c0_material_objection).toBeUndefined();
	expect(targeting.questions.c0_duplicate).toBeUndefined();
	expect(Object.keys(targeting.questions)).toHaveLength(14);
	let firstAnswers = first({ withdrawal: 0.92, correction: 0.91 });
	let withdrawal = {
		...quotes[0]!,
		answers: {
			...follow({ role: "objection", thread: "queue-thread" }),
			option: confidentChoice("sqs-option"),
			withdraws_pending_settle: { type: "noul" as const, noul: 0.94 },
		},
	};
	let result = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: firstAnswers,
		candidates: [withdrawal, {
			...quotes[1]!,
			answers: {
				...follow({ role: "constraint", thread: "queue-thread" }),
				option: confidentChoice("sqs-option"),
				relation: confidentChoice("qualifies"),
				duplicate: { type: "noul" as const, noul: 0.1 },
			},
		}],
	});
	expect(result.events.map(event => event.type)).toEqual([
		"stance.changed",
		"constraint.added",
		"settle.deferred",
	]);
	expect(result.events[0]).toMatchObject({
		threadId: "queue-thread",
		optionId: "sqs-option",
		position: "neutral",
		source: { ...quotes[0], role: "withdrawal" },
	});
	expect(result.events[1]).toMatchObject({ source: { ...quotes[1], role: "constraint" } });
	let proposalEvent = state.events.findLast(event =>
		event.type === "settle.suggested" && event.threadId === "queue-thread"
	);
	expect(result.events[2]).toMatchObject({
		type: "settle.deferred",
		threadId: "queue-thread",
		proposalId: proposalEvent?.id,
		source: { ...quotes[1], role: "constraint" },
	});
	let neutral = result.events[0] as Extract<ConversationPlan.Event, { type: "stance.changed" }>;
	let after = result.events.reduce(
		(next, event) => applyInference(next, event, current),
		state,
	);
	expect(effectivePending(after.threads[0]!, after.events)).toBeUndefined();
	expect(after.threads[0]!.pendingSettle).toEqual(state.threads[0]!.pendingSettle);
	expect(after.threads[0]!.decisionHistory).toEqual(state.threads[0]!.decisionHistory);
	expect(() =>
		applyInference(state, {
			...neutral,
			source: { ...neutral.source, role: "objection" },
		}, current)
	).toThrow("stance source role disagrees");
});
