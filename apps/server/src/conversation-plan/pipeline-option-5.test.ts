import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import { applyInference } from "./domain";
import { planEvents } from "./policy";
import { seeded, seededOptionId, withOption } from "./interpret.test-fixtures";
import { first, follow, message } from "./policy-initial.test-fixtures";
import { optionChoice } from "./pipeline-ordinary-save.test-fixtures";

test("an unclear choice is held, but current opposition does not block a clear suggestion", () => {
	let state = withOption(seeded());
	let opposition = message("oppose-option", "I oppose the optional outline.", "Theo");
	state = applyInference(state, {
		id: "opposition-option",
		type: "stance.changed",
		scopedProposalId: null,
		threadId: "thread-a",
		observedThreadVersion: state.threads[0].version,
		origin: "classifier",
		actor: { kind: "classifier" },
		at: 1000,
		source: {
			messageId: opposition.id,
			author: opposition.author as ConversationPlan.SourceAuthor,
			quote: opposition.text,
			start: 0,
			end: opposition.text.length,
			role: "objection",
		},
		optionId: seededOptionId,
		position: "oppose",
	}, opposition);
	let current = message("uncertain-choice", "Let's go with the optional outline.");
	let input = {
		channelId: "channel",
		message: current,
		state,
		first: first({ explicit_resolution: 0.98 }),
		candidates: [{
			quote: current.text,
			start: 0,
			end: current.text.length,
			answers: {
				...follow({ role: "resolution", thread: "thread-a", explicit_resolution: 0.98 }),
				chosen_option: optionChoice("none"),
			},
		}],
	};
	let unclear = planEvents(input);
	expect(unclear.events).toEqual([]);
	expect(unclear.outcomes[0].gate).toBe("chosen option needs review");
	let clear = planEvents({
		...input,
		candidates: [{
			...input.candidates[0],
			answers: {
				...input.candidates[0].answers,
				chosen_option: optionChoice(seededOptionId),
			},
		}],
	});
	expect(clear.events.map((event) => event.type)).toEqual(["settle.suggested"]);
});

test("proposal, assent, quote, sarcasm, and reported consensus do not decide", () => {
	let state = seeded();
	for (
		let [id, text] of [
			["proposal", "Maybe use an optional outline."],
			["assent", "+1 to the optional outline."],
			["quote", "Please show ‘we decided to use an outline’ in history."],
			["sarcasm", "Sure, force everyone through a template 🙄"],
			["reported", "Everyone seems to agree on an outline, I guess."],
		]
	) {
		let current = message(id, text);
		let result = planEvents({
			channelId: "channel",
			message: current,
			state,
			first: first({ explicit_resolution: 0.05 }),
			candidates: [
				{
					quote: text,
					start: 0,
					end: text.length,
					answers: follow({ role: "resolution", thread: "thread-a", explicit_resolution: 0.04 }),
				},
			],
		});
		expect(result.events).toEqual([]);
	}
});

test("a settle needs strong first-pass and candidate evidence", () => {
	let state = withOption(seeded());
	let current = message("resolution", "We've decided to use the optional outline.");
	let output = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: first({ explicit_resolution: 0.79 }),
		candidates: [{
			quote: current.text,
			start: 0,
			end: current.text.length,
			answers: follow({ role: "resolution", thread: "thread-a", explicit_resolution: 0.98 }),
		}],
	});
	expect(output.events).toEqual([]);
	expect(output.outcomes[0].gate).toBe("settle authority unclear");
	let weakCandidate = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: first({ explicit_resolution: 0.98 }),
		candidates: [{
			quote: current.text,
			start: 0,
			end: current.text.length,
			answers: {
				...follow({ role: "resolution", thread: "thread-a", explicit_resolution: 0.84 }),
				chosen_option: optionChoice(seededOptionId),
			},
		}],
	});
	expect(weakCandidate.events).toEqual([]);
	expect(weakCandidate.outcomes[0].gate).toBe("settle authority unclear");
	expect(state.threads[0].status).toBe("exploring");
});
