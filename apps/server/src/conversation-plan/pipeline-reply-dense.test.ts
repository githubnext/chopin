import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { askJev, type JevQuestion } from "./jev";
import {
	buildCandidateTargetingRequest,
	buildTargetingRequest,
	buildTriageRequest,
} from "./questions";
import { extractQuotes } from "./quotes";
import { mockResult, seeded, withOption } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";
import { reply } from "./pipeline-reply.test-fixtures";

test("twelve populated targets fit Jev's state budget with three long quotes", async () => {
	let template = withOption(seeded()).threads[0];
	let threads: ConversationPlan.Thread[] = Array.from({ length: 12 }, (_, index) => {
		let options = Array.from({ length: 8 }, (_, optionIndex) => ({
			...template.contributions[0],
			id: `option-${index}-${optionIndex}-${"x".repeat(12)}`,
			text: "o".repeat(500),
		}));
		let reasons = Array.from({ length: 12 }, (_, reasonIndex) => ({
			...template.contributions[0],
			id: `reason-${index}-${reasonIndex}-${"x".repeat(12)}`,
			kind: "reason" as const,
			text: "r".repeat(500),
			targetId: options[0].id,
			sources: [{ ...template.contributions[0].sources[0], role: "reason" as const }],
		}));
		return {
			...template,
			id: `thread-${index}`,
			question: "Q".repeat(500),
			status: index === 11 ? "discarded" : "exploring",
			contributions: [...options, ...reasons],
			pendingSettle: index === 0
				? { optionId: options[0].id, proposer: "Mina", messageId: "proposal" }
				: undefined,
			stances: Array.from({ length: 20 }, (_, stanceIndex) => ({
				id: `stance-${index}-${stanceIndex}`,
				participant: `member-${stanceIndex}`,
				optionId: options[0].id,
				position: "support" as const,
				sources: [{ ...template.contributions[0].sources[0], role: "support" as const }],
				at: 1000,
			})),
		};
	});
	let current = message(
		"dense",
		["A", "B", "C"].map((letter) => `Consider ${letter} ${"x".repeat(1230)}.`).join(" "),
	);
	let recent = Array.from(
		{ length: 12 },
		(_, index) => message(`recent-${index}`, "r".repeat(300)),
	);
	let candidates = extractQuotes(current.text);
	expect(candidates).toHaveLength(3);
	let triage = buildTriageRequest(current, recent, threads);
	let targeting = buildTargetingRequest(current, recent, threads, candidates);
	let isolated = buildCandidateTargetingRequest(current, recent, threads, candidates, 0);
	expect((isolated.state as { recent: Array<{ id: string }> }).recent.map(entry => entry.id))
		.toEqual(recent.map(entry => entry.id));
	let context = (targeting.state as {
		threads: Array<{
			id: string;
			options: Array<{ id: string }>;
			pendingSettle?: { optionId: string; option: string; proposer: string };
		}>;
	}).threads;
	let targetChoices =
		(targeting.questions.c0_thread as Extract<JevQuestion, { type: "choice" }>).criteria;
	let optionChoices =
		(targeting.questions.c0_chosen_option as Extract<JevQuestion, { type: "choice" }>).criteria;
	expect(context.map((thread) => thread.id)).toEqual(
		Object.keys(targetChoices).filter((id) => id !== "new" && id !== "none"),
	);
	expect(context.flatMap((thread) => thread.options.map((option) => option.id)).sort()).toEqual(
		Object.keys(optionChoices).filter((id) => id !== "new" && id !== "none").sort(),
	);
	expect(context[0].pendingSettle).toEqual({
		optionId: threads[0].pendingSettle!.optionId,
		option: "o".repeat(100),
		proposer: "Mina",
	});
	expect(targeting.questions.c0_agrees_with_settle?.type).toBe("noul");
	expect(Object.keys(targeting.questions)).toHaveLength(42);
	expect(Object.keys(targeting.questions).filter(key => key.endsWith("_duplicate")))
		.toEqual([]);
	expect(context[11].options.length).toBeGreaterThan(0);
	for (let request of [triage, targeting]) {
		expect((request.state as { threads: unknown[] }).threads).toHaveLength(12);
		expect(JSON.stringify(request.state).length).toBeLessThanOrEqual(24_000);
		let answer = await askJev(request, {
			apiKey: "test-only",
			fetch: async () => reply(mockResult(request.questions, {}).answers),
		});
		expect(answer.model).toBe("jev-1.13.0");
	}
});
