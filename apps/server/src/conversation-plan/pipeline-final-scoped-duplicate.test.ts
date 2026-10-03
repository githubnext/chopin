import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { first, message } from "./policy-initial.test-fixtures";
import { d01LinkedEditorCard } from "./pipeline-linked-option.test-fixtures";

test("D01 m6 cannot add a fifth option when targeting existing linked Lexical", () => {
	let { state, threadId, options, linkedCards } = d01LinkedEditorCard();
	let lexicalId = "01M3QAQWN9TYWMFW3D0EYAZY8H";
	let quote = "I'd pick Lexical for the spike;";
	let current = message("d01-m6", quote, "Mei");
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
			start: 0,
			end: quote.length,
			answers: {
				role: {
					type: "choice",
					choice: "option",
					confidence: 0.87,
					probabilities: {
						question: 0,
						option: 0.89,
						reason: 0,
						constraint: 0,
						support: 0.05,
						objection: 0,
						resolution: 0.05,
						reopening: 0,
						none: 0.01,
					},
				},
				thread: {
					type: "choice",
					choice: threadId,
					confidence: 0.95,
					probabilities: { [threadId]: 0.97, new: 0.03, none: 0 },
				},
				option: {
					type: "choice",
					choice: lexicalId,
					confidence: 1,
					probabilities: Object.fromEntries(
						options.map(option => [option.id, option.id === lexicalId ? 1 : 0])
							.concat([["new", 0], ["none", 0]]),
					),
				},
				chosen_option: {
					type: "choice",
					choice: lexicalId,
					confidence: 0.98,
					probabilities: Object.fromEntries(
						options.map(option => [option.id, option.id === lexicalId ? 0.98 : 0])
							.concat([["new", 0], ["none", 0.02]]),
					),
				},
				relation: {
					type: "choice",
					choice: "supports",
					confidence: 0.66,
					probabilities: {
						supports: 0.73,
						challenges: 0.05,
						qualifies: 0.13,
						replaces: 0.04,
						unrelated: 0.05,
					},
				},
				new_option: { type: "noul", noul: 0.85 },
				planning_substance: { type: "noul", noul: 0.51 },
				support: { type: "noul", noul: 0.92 },
				objection: { type: "noul", noul: 0.05 },
				duplicate: { type: "noul", noul: 0.15 },
				explicit_resolution: { type: "noul", noul: 0.1 },
				reopening: { type: "noul", noul: 0.06 },
				material_objection: { type: "noul", noul: 0.1 },
			},
		}],
	});

	expect(state.threads[0]!.contributions.filter(item => item.kind === "option")).toEqual([]);
	expect(result.events.filter(event => event.type === "option.added")).toEqual([]);
	expect(state.threads[0]!.contributions.filter(item => item.kind === "option")).toEqual([]);
	expect(linkedCards.get(threadId)?.options).toEqual(options);
});
