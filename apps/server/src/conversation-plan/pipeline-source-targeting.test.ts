import { expect, test } from "bun:test";
import type { JevQuestion } from "./jev";
import { interpretMessage } from "./interpret";
import { buildTargetingRequest } from "./questions";
import { extractQuotes } from "./quotes";
import { mockResult, seeded, settledBy, withOption } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";

test("active targets after the eighth keep their options in choices and compact context", () => {
	let template = withOption(seeded()).threads[0];
	let discarded = { ...template, id: "discarded-first", status: "discarded" as const };
	let active = Array.from({ length: 12 }, (_, index) => ({
		...template,
		id: `thread-${index}`,
		question: `Question ${index}?`,
		contributions: [{ ...template.contributions[0], id: `option-${index}` }],
	}));
	let current = message("late-target", "Let's settle option eleven.");
	let request = buildTargetingRequest(
		current,
		[],
		[discarded, ...active],
		extractQuotes(current.text),
	);
	let threadChoices =
		(request.questions.c0_thread as Extract<JevQuestion, { type: "choice" }>).criteria;
	let optionChoices =
		(request.questions.c0_chosen_option as Extract<JevQuestion, { type: "choice" }>).criteria;
	expect(threadChoices["thread-11"]).toContain("Question 11");
	expect(threadChoices["discarded-first"]).toBeUndefined();
	expect(optionChoices["option-11"]).toContain("Question 11");
	let context =
		(request.state as { threads: Array<{ id: string; options: Array<{ id: string }> }> })
			.threads;
	expect(context.map((thread) => thread.id)).toHaveLength(12);
	expect(context.find((thread) => thread.id === "thread-11")?.options.map((option) => option.id))
		.toContain("option-11");
});

test("four isolated targets persist a pending qualifier relation within 45 answers", async () => {
	let current = message(
		"figma-mixed",
		"Sounds good to me. What about optional outlines if editors can change them? Copilot? BYO API keys?",
		"Jules",
	);
	let recent = [
		message("purpose", "We need to figure out auth.", "Mina"),
		message("alternatives", "Auth0, custom login, or GitHub auth?", "Jules"),
		message("suggestion", "GitHub could work.", "Mina"),
		message("proposal", "Let's just go with GitHub.", "Mina"),
	];
	let calls: Array<{ questions: string[]; state: unknown }> = [];
	let output = await interpretMessage({
		channelId: "channel",
		message: current,
		recent,
		state: settledBy(seeded(), "Mina"),
		ask: async request => {
			let keys = Object.keys(request.questions);
			calls.push({ questions: keys, state: request.state });
			let overrides: Record<string, string | number> = keys.includes("new_question")
				? {
					new_question: 0.95,
					support: 0.9,
					significance: 2,
					c0_owned_unretracted: 0.95,
					c1_owned_unretracted: 0.95,
					c2_owned_unretracted: 0.95,
				}
				: keys.some(key => key.startsWith("c0_"))
				? {
					c0_role: "support",
					c0_thread: "thread-a",
					c0_support: 0.95,
					c0_agrees_with_settle: 0.95,
				}
				: keys.some(key => key.startsWith("c1_"))
				? { c1_role: "question", c1_thread: "new" }
				: {};
			return mockResult(request.questions, overrides);
		},
	});
	expect(calls).toHaveLength(5);
	expect(calls[0]!.questions).toContain("new_question");
	for (let index = 0; index < 4; index++) {
		expect(calls[index + 1]!.questions.every(key => key.startsWith(`c${index}_`)))
			.toBe(true);
		expect((calls[index + 1]!.state as { recent: Array<{ id: string }> }).recent
			.map(entry => entry.id)).toEqual(recent.map(entry => entry.id));
	}
	expect(calls[2]!.questions).toContain("c1_relation");
	expect(calls[2]!.questions).toContain("c1_qualifies_pending_settle");
	expect(output.analysis.passes.map(pass => pass.stage)).toEqual(["triage", "targeting"]);
	expect(calls.slice(1).flatMap(call => call.questions).filter(key => key.endsWith("_duplicate")))
		.toEqual([]);
	expect(Object.keys(output.analysis.passes[1]!.answers)).toHaveLength(44);
	expect(output.events.map(event => event.type)).toEqual([
		"stance.changed",
		"settle.agreed",
		"thread.opened",
	]);
	let quotes = extractQuotes(current.text);
	expect(output.events.map(event => "source" in event ? event.source?.quote : ""))
		.toEqual([quotes[0]!.quote, quotes[0]!.quote, quotes[1]!.quote]);
	expect(output.events.every(event =>
		"source" in event
		&& event.source?.messageId === current.id
		&& current.text.slice(event.source.start, event.source.end) === event.source.quote
	))
		.toBe(true);
});
