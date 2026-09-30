import { expect, test } from "bun:test";
import type { JevQuestion } from "./jev";
import { optionIdFor, planEvents } from "./policy";
import { extractQuotes } from "./quotes";
import { buildCandidateTargetingRequest } from "./questions";
import { seeded } from "./interpret.test-fixtures";
import { confidentChoice, first, follow, message } from "./policy-initial.test-fixtures";

// Complete original archive pipeline.test.ts callbacks; shared helpers remain unchanged.
test("targeting lists all ten current linked card options, including beyond thread truncation", () => {
	let state = seeded();
	state.threads[0]!.questionnaireId = "card-a";
	let ids = Array.from(
		{ length: 10 },
		(_, index) => optionIdFor("channel", `card-${index}`, 0, 1000),
	);
	let cards = new Map([["thread-a", {
		cardId: "card-a",
		options: ids.map((id, index) => ({ id, label: `Visible choice ${index}` })),
	}]]);
	let current = message("choice", "Let's go with visible choice nine.");
	let request = buildCandidateTargetingRequest(
		current,
		[],
		state.threads,
		extractQuotes(current.text),
		0,
		state.events,
		cards,
	);
	let criteria =
		(request.questions.c0_chosen_option as Extract<JevQuestion, { type: "choice" }>).criteria;
	expect(ids.every(id => id in criteria)).toBe(true);
	expect(criteria[ids[9]!]).toContain("Visible choice 9");
	expect(
		(request.state as { threads: Array<{ options: Array<{ id: string }> }> }).threads[0]!.options,
	)
		.toHaveLength(10);
});

test("two distinct linked card choices in one message cannot create competing Save prompts", () => {
	let current = message("competing", "Let's go with VPS. Let's go with managed hosting.");
	let state = seeded();
	state.threads[0]!.questionnaireId = "card-a";
	let vps = optionIdFor("channel", "vps", 0, 1000);
	let managed = optionIdFor("channel", "managed", 0, 1000);
	let quotes = extractQuotes(current.text);
	let cards = new Map([["thread-a", {
		cardId: "card-a",
		options: [{ id: vps, label: "VPS" }, { id: managed, label: "Managed hosting" }],
	}]]);
	let result = planEvents({
		channelId: "channel",
		message: current,
		state,
		linkedCards: cards,
		first: { ...first({ explicit_resolution: 0.98 }), act: confidentChoice("commitment") },
		candidates: quotes.map((quote, index) => ({
			...quote,
			answers: {
				...follow({ role: "resolution", thread: "thread-a", explicit_resolution: 0.98 }),
				chosen_option: confidentChoice(index === 0 ? vps : managed),
			},
		})),
	});
	expect(result.events).toEqual([]);
	expect(result.outcomes.every(item => item.gate === "competing choice needs review")).toBe(true);
});
