import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { seeded, seededOptionId, withOption } from "./interpret.test-fixtures";
import { first, follow, message } from "./policy-initial.test-fixtures";
import { optionChoice } from "./pipeline-ordinary-save.test-fixtures";

test("an existing-option recommendation suggests the option when Jev's role is uncertain", () => {
	let state = withOption(seeded());
	for (
		let [id, text, roleProbability, supportProbability, triageResolution, targetingResolution] of [
			["s3", "We should do amazon S3 for uploaded files", 0.68, 0.26, 0.68, 0.89],
			["search", "And we should use elastic search", 0.44, 0.39, 0.74, 0.87],
		] as const
	) {
		let current = message(id, text);
		let output = planEvents({
			channelId: "channel",
			message: current,
			state,
			first: {
				...first({ explicit_resolution: triageResolution }),
				act: {
					type: "choice",
					choice: "proposal",
					confidence: 0.9,
					probabilities: { proposal: 0.9, evaluation: 0.1 },
				},
			},
			candidates: [{
				quote: current.text,
				start: 0,
				end: current.text.length,
				answers: {
					...follow({
						role: "resolution",
						thread: "thread-a",
						explicit_resolution: targetingResolution,
					}),
					role: {
						type: "choice",
						choice: "resolution",
						confidence: roleProbability,
						probabilities: {
							resolution: roleProbability,
							support: supportProbability,
							none: 1 - roleProbability - supportProbability,
						},
					},
					support: { type: "noul", noul: 0.89 },
					chosen_option: optionChoice(seededOptionId),
				},
			}],
		});
		expect(output.events.map(event => event.type)).toEqual(["settle.suggested"]);
		expect(output.events[0]).toMatchObject({
			optionId: seededOptionId,
			source: { quote: text, messageId: id },
		});
		expect(state.threads[0].status).toBe("exploring");
	}
});

test("an apostrophe-free let's choice suggests Jev's exact existing option", () => {
	let state = withOption(seeded());
	let current = message("postmark", "Lets do postmark for notifications");
	let output = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: first({ explicit_resolution: 0.92 }),
		candidates: [{
			quote: current.text,
			start: 0,
			end: current.text.length,
			answers: {
				...follow({ role: "resolution", thread: "thread-a", explicit_resolution: 0.94 }),
				chosen_option: optionChoice(seededOptionId),
			},
		}],
	});
	expect(output.events.map(event => event.type)).toEqual(["settle.suggested"]);
	expect(output.events[0]).toMatchObject({
		optionId: seededOptionId,
		source: { quote: current.text, messageId: current.id },
	});
	expect(state.threads[0].status).toBe("exploring");
});
