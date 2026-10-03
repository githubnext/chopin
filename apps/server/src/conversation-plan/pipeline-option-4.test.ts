import { expect, test } from "bun:test";
import type { Chat } from "@chopin/protocol";
import { planEvents } from "./policy";
import { seeded, seededOptionId, withOption } from "./interpret.test-fixtures";
import { first, follow, message } from "./policy-initial.test-fixtures";
import { optionChoice } from "./pipeline-ordinary-save.test-fixtures";

test("the Planner can quote an option but cannot propose a settle", () => {
	let state = withOption(seeded());
	let current: Chat.Entry = {
		...message("agent-settle", "Let's go with the optional outline."),
		author: { kind: "agent" },
	};
	let base = {
		channelId: "channel",
		message: current,
		state,
		first: first({ explicit_resolution: 0.98 }),
	};
	let settle = planEvents({
		...base,
		candidates: [{
			quote: current.text,
			start: 0,
			end: current.text.length,
			answers: {
				...follow({ role: "resolution", thread: "thread-a", explicit_resolution: 0.98 }),
				chosen_option: optionChoice(seededOptionId),
			},
		}],
	});
	expect(settle.events).toEqual([]);
	let option = { ...current, id: "agent-option", text: "Try a managed provider." };
	let quoted = planEvents({
		...base,
		message: option,
		first: first({ new_option: 0.98 }),
		candidates: [{
			quote: option.text,
			start: 0,
			end: option.text.length,
			answers: follow({ role: "option", thread: "thread-a" }),
		}],
	});
	expect(quoted.events.map((event) => event.type)).toEqual(["option.added"]);
	expect(quoted.events[0]).toMatchObject({ origin: "planner" });
	let addition = quoted.events[0];
	expect(addition.type === "option.added" && addition.contribution.id)
		.toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
});

test("a settle with no known chosen option stays in review", () => {
	let current = message("new-choice", "Let's just go with something new.");
	let output = planEvents({
		channelId: "channel",
		message: current,
		state: withOption(seeded()),
		first: first({ explicit_resolution: 0.98 }),
		candidates: [{
			quote: current.text,
			start: 0,
			end: current.text.length,
			answers: {
				...follow({ role: "resolution", thread: "thread-a", explicit_resolution: 0.98 }),
				chosen_option: optionChoice("new"),
			},
		}],
	});
	expect(output.events).toEqual([]);
	expect(output.outcomes[0]).toMatchObject({
		status: "review",
		gate: "chosen option needs review",
	});
});

test("negated proposals cannot suggest a rejected option", () => {
	let state = withOption(seeded());
	let current = message("negated", "We've decided not to use the optional outline.");
	for (let chosen of ["none", seededOptionId]) {
		let output = planEvents({
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
					option: optionChoice(seededOptionId),
					chosen_option: optionChoice(chosen),
				},
			}],
		});
		expect(output.events).toEqual([]);
		expect(output.outcomes[0].gate).toBe("chosen option needs review");
	}
});
