import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { extractQuotes } from "./quotes";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";
import { d01LinkedEditorCard } from "./pipeline-linked-option.test-fixtures";

test("an immediately conditioned Lexical preference cannot create a scoped Save", () => {
	let { state, threadId, linkedCards } = d01LinkedEditorCard();
	let lexicalId = "01M3QAQWN9TYWMFW3D0EYAZY8H";
	let text = "I would pick Lexical for the spike; if pasted tables work.";
	let current = message("d01-quoted-spike", text, "Mei");
	let quotes = extractQuotes(text);
	expect(quotes).toEqual([
		{ quote: "I would pick Lexical for the spike;", start: 0, end: 35 },
		{ quote: "if pasted tables work.", start: 36, end: 58 },
	]);
	let result = planEvents({
		channelId: "channel",
		message: current,
		state,
		linkedCards,
		first: {
			...first({
				new_option: 0.89,
				c0_owned_unretracted: 0.98,
			}),
			act: {
				type: "choice",
				choice: "proposal",
				confidence: 0.95,
				probabilities: {
					question: 0,
					proposal: 0.98,
					evaluation: 0.01,
					commitment: 0.01,
					correction: 0,
					other: 0,
				},
			},
			thread_target: confidentChoice(threadId),
		},
		candidates: quotes.map((candidate, index) => ({
			...candidate,
			answers: index === 0
				? {
					...follow({ role: "support", thread: threadId }),
					option: confidentChoice(lexicalId),
					chosen_option: confidentChoice(lexicalId),
					relation: confidentChoice("supports"),
					support: { type: "noul", noul: 0.99 },
					new_option: { type: "noul", noul: 0.9 },
					planning_substance: { type: "noul", noul: 0.9 },
					duplicate: { type: "noul", noul: 0.05 },
				}
				: {
					...follow({ role: "none", thread: threadId }),
					option: confidentChoice("none"),
					chosen_option: confidentChoice("none"),
				},
		})),
	});

	expect(
		result.events.filter(event => (event as { type: string }).type === "scoped-choice.proposed"),
	).toEqual([]);
	expect(result.events.filter(event => event.type === "option.added")).toEqual([]);
	expect(result.events.filter(event => event.type === "settle.suggested")).toEqual([]);
	expect(result.events.filter(event => event.type === "decision.recorded")).toEqual([]);
	expect(state.threads[0]!.pendingScopedChoice).toBeUndefined();
});

test("a generic spike request without an option preference does not create a global Save", () => {
	let { state, threadId, linkedCards } = d01LinkedEditorCard();
	let quote = "Let's run a quick spike before picking an editor.";
	let current = message("d01-m5-generic-spike", quote, "Mei");
	let result = planEvents({
		channelId: "channel",
		message: current,
		state,
		linkedCards,
		first: {
			...first({ new_option: 0.05, c0_owned_unretracted: 0.95 }),
			act: confidentChoice("proposal"),
			thread_target: confidentChoice(threadId),
		},
		candidates: [{
			quote,
			start: 0,
			end: quote.length,
			answers: {
				...follow({ role: "none", thread: threadId }),
				option: confidentChoice("none"),
				chosen_option: confidentChoice("none"),
				new_option: { type: "noul", noul: 0.05 },
				planning_substance: { type: "noul", noul: 0.12 },
			},
		}],
	});

	expect(result.events).toEqual([]);
	expect(state.threads[0]!.pendingSettle).toBeUndefined();
	expect(state.threads[0]!.decisionHistory).toEqual([]);
});
