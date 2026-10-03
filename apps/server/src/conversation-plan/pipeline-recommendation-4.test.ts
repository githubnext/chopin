import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { seeded, seededOptionId, withOption } from "./interpret.test-fixtures";
import { first, follow, message } from "./policy-initial.test-fixtures";
import { optionChoice } from "./pipeline-ordinary-save.test-fixtures";

test("a clear owned team commitment suggests a known choice despite low settle scores", () => {
	let state = withOption(seeded());
	state.threads[0]!.question = "Where should we host the app?";
	state.threads[0]!.contributions[0]!.text = "Host it on our own VPS";
	let current = message("vps-choice", "We've decided to host it on our own VPS");
	let input = {
		channelId: "channel",
		message: current,
		state,
		first: {
			...first({ explicit_resolution: 0.60, c0_owned_unretracted: 0.89 }),
			act: {
				type: "choice" as const,
				choice: "commitment",
				confidence: 0.89,
				probabilities: { commitment: 0.89, proposal: 0.08, other: 0.03 },
			},
		},
		candidates: [{
			quote: current.text,
			start: 0,
			end: current.text.length,
			answers: {
				...follow({ role: "resolution", thread: "thread-a", explicit_resolution: 0.67 }),
				role: {
					type: "choice" as const,
					choice: "resolution",
					confidence: 0.89,
					probabilities: { resolution: 0.89, support: 0.08, none: 0.03 },
				},
				chosen_option: {
					type: "choice" as const,
					choice: seededOptionId,
					confidence: 0.92,
					probabilities: { [seededOptionId]: 0.92, new: 0.04, none: 0.04 },
				},
			},
		}],
	};
	let output = planEvents(input);
	expect(output.events.map(event => event.type)).toEqual(["settle.suggested"]);
	expect(output.events[0]).toMatchObject({
		optionId: seededOptionId,
		source: { quote: current.text, messageId: current.id },
	});
	expect(state.threads[0].status).toBe("exploring");
	let uncertainAct = planEvents({
		...input,
		first: {
			...input.first,
			act: {
				type: "choice",
				choice: "proposal",
				confidence: 0.89,
				probabilities: { proposal: 0.89, commitment: 0.08, other: 0.03 },
			},
		},
	});
	expect(uncertainAct.events).toEqual([]);
	expect(uncertainAct.outcomes[0]?.gate).toBe("settle authority unclear");
});

test("a recommendation for a known VPS option does not add a duplicate", () => {
	let state = withOption(seeded());
	state.threads[0]!.question = "Where should we host the app?";
	state.threads[0]!.contributions[0]!.text = "Host it on our own VPS";
	let current = message("vps-proposal", "We should also host it on our own VPS");
	let output = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: {
			...first({ explicit_resolution: 0.45, new_option: 0.82 }),
			act: {
				type: "choice",
				choice: "proposal",
				confidence: 1,
				probabilities: { proposal: 1, commitment: 0 },
			},
		},
		candidates: [{
			quote: current.text,
			start: 0,
			end: current.text.length,
			answers: {
				...follow({ role: "option", thread: "thread-a", explicit_resolution: 0.67 }),
				option: optionChoice(seededOptionId),
				chosen_option: optionChoice(seededOptionId),
				new_option: { type: "noul", noul: 0.91 },
				duplicate: { type: "noul", noul: 0.53 },
				support: { type: "noul", noul: 0.90 },
			},
		}],
	});
	expect(output.events.map(event => event.type)).toEqual(["settle.suggested"]);
	expect(output.events[0]).toMatchObject({ optionId: seededOptionId });
	expect(state.threads[0]!.contributions).toHaveLength(1);
});
