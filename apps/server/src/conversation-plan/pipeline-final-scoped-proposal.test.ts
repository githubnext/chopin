import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";
import { d01LinkedEditorCard } from "./pipeline-linked-option.test-fixtures";

test("D01 m6 proposes a spike-scoped Save for existing linked Lexical", () => {
	let { state, threadId, options, linkedCards } = d01LinkedEditorCard();
	let lexicalId = "01M3QAQWN9TYWMFW3D0EYAZY8H";
	let quote = "I'd pick Lexical for the spike;";
	let current = message(
		"d01-m6",
		`agreed. ${quote} still want to see how it handles pasted tables.`,
		"Mei",
	);
	let result = planEvents({
		channelId: "channel",
		message: current,
		state,
		linkedCards,
		first: {
			...first({
				new_option: 0.89,
				c0_owned_unretracted: 0.88,
				c1_owned_unretracted: 0.94,
				c2_owned_unretracted: 0.95,
			}),
			act: {
				type: "choice",
				choice: "proposal",
				confidence: 0.73,
				probabilities: {
					question: 0,
					proposal: 0.78,
					evaluation: 0.2,
					commitment: 0.02,
					correction: 0,
					other: 0,
				},
			},
			thread_target: {
				type: "choice",
				choice: threadId,
				confidence: 0.75,
				probabilities: { [threadId]: 0.84, new: 0.06, none: 0.1 },
			},
			significance: {
				type: "score",
				score: 2.26,
				confidence: 0.69,
				legend: { "0": "none", "1": "low", "2": "normal", "3": "high" },
				probabilities: { "0": 0.01, "1": 0.02, "2": 0.69, "3": 0.28 },
			},
		},
		candidates: [{
			quote,
			start: 8,
			end: 39,
			answers: {
				...follow({ role: "support", thread: threadId }),
				role: {
					type: "choice",
					choice: "support",
					confidence: 0.87,
					probabilities: {
						question: 0,
						option: 0.05,
						reason: 0,
						constraint: 0,
						support: 0.89,
						objection: 0,
						resolution: 0.05,
						reopening: 0,
						none: 0.01,
					},
				},
				option: confidentChoice(lexicalId),
				chosen_option: confidentChoice(lexicalId),
				relation: confidentChoice("supports"),
				new_option: { type: "noul", noul: 0.85 },
				planning_substance: { type: "noul", noul: 0.51 },
				support: { type: "noul", noul: 0.92 },
				duplicate: { type: "noul", noul: 0.15 },
			},
		}],
	});
	let scoped = result.events.filter(event =>
		(event as { type: string }).type === "scoped-choice.proposed"
	);

	expect(scoped).toHaveLength(1);
	expect(scoped[0]).toMatchObject({
		type: "scoped-choice.proposed",
		id: expect.any(String),
		threadId,
		cardId: "01M3QAQ8HM8DVYA9E4N28QCQ7T",
		optionId: lexicalId,
		label: "Lexical",
		scope: "spike",
		source: {
			messageId: current.id,
			author: { kind: "member", handle: "Mei" },
			quote,
			start: 8,
			end: 39,
			role: "support",
		},
	});
	expect(result.events.filter(event => event.type === "option.added")).toEqual([]);
	expect(result.events.filter(event => event.type === "settle.suggested")).toEqual([]);
	expect(result.events.filter(event => event.type === "decision.recorded")).toEqual([]);
	expect(state.threads[0]!.pendingSettle).toBeUndefined();
	expect(state.threads[0]!.decisionHistory).toEqual([]);
	expect(linkedCards.get(threadId)?.options).toEqual(options);
});
