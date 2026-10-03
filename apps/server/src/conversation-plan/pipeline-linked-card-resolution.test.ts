import { expect, test } from "bun:test";
import { optionIdFor, planEvents } from "./policy";
import { seeded, withOption } from "./interpret.test-fixtures";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";

// Complete original archive pipeline.test.ts callbacks; shared helpers remain unchanged.
test("owned exact resolution mirrors a linked card option and suggests it atomically", () => {
	let current = message("m-card", "Let's just go with the VPS option.");
	let state = seeded();
	state.threads[0]!.questionnaireId = "card-a";
	let id = optionIdFor("channel", "card-option", 0, 1000);
	let cards = new Map([["thread-a", {
		cardId: "card-a",
		options: [{ id, label: "VPS option" }],
	}]]);
	let input = {
		channelId: "channel",
		message: current,
		state,
		linkedCards: cards,
		first: first({ explicit_resolution: 0.98 }),
		candidates: [{
			quote: current.text,
			start: 0,
			end: current.text.length,
			answers: {
				...follow({ role: "resolution", thread: "thread-a", explicit_resolution: 0.98 }),
				chosen_option: confidentChoice(id),
			},
		}],
	};
	let result = planEvents(input);
	expect(result.events.map(event => event.type)).toEqual(["option.added", "settle.suggested"]);
	expect(result.events[0]).toMatchObject({
		contribution: { id, text: "VPS option", authoring: "scribe" },
	});
	expect(result.events[1]).toMatchObject({ optionId: id, source: { quote: current.text } });
	let mixedRole = {
		...input,
		first: { ...input.first, act: confidentChoice("commitment") },
		candidates: [{
			...input.candidates[0]!,
			answers: {
				...input.candidates[0]!.answers,
				role: {
					type: "choice" as const,
					choice: "resolution",
					confidence: 0.72,
					probabilities: { resolution: 0.72, option: 0.2, none: 0.08 },
				},
			},
		}],
	};
	expect(planEvents(mixedRole).events.map(event => event.type))
		.toEqual(["option.added", "settle.suggested"]);
	let recommendation = message("recommend", "We should use the VPS option.");
	expect(
		planEvents({
			...mixedRole,
			message: recommendation,
			first: { ...input.first, act: confidentChoice("proposal") },
			candidates: [{
				...mixedRole.candidates[0]!,
				quote: recommendation.text,
				end: recommendation.text.length,
				answers: {
					...mixedRole.candidates[0]!.answers,
					support: { type: "noul" as const, noul: 0.95 },
				},
			}],
		}).events.map(event => event.type),
	).toEqual(["option.added", "settle.suggested"]);
	let mirrored = withOption(state);
	mirrored.threads[0]!.contributions[0]!.id = id;
	expect(planEvents({ ...input, state: mirrored }).events.map(event => event.type))
		.toEqual(["settle.suggested"]);
	expect(
		planEvents({
			...input,
			linkedCards: new Map([["thread-a", {
				cardId: "other-card",
				options: [{ id, label: "VPS option" }],
			}]]),
		}).events,
	).toEqual([]);
	expect(planEvents({ ...input, first: first({ c0_owned_unretracted: 0.4 }) }).events)
		.toEqual([]);
	let agent = { ...current, author: { kind: "agent" as const } };
	expect(planEvents({ ...input, message: agent }).events).toEqual([]);
	expect(
		planEvents({
			...input,
			candidates: [{
				...input.candidates[0]!,
				answers: {
					...input.candidates[0]!.answers,
					chosen_option: {
						type: "choice" as const,
						choice: id,
						confidence: 0.6,
						probabilities: { [id]: 0.6, none: 0.4 },
					},
				},
			}],
		}).events,
	).toEqual([]);
});
