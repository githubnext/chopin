import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { extractQuotes } from "./quotes";
import { seeded, seededOptionId, settledBy } from "./interpret.test-fixtures";
import { first, follow, message } from "./policy-initial.test-fixtures";
import { optionChoice } from "./pipeline-ordinary-save.test-fixtures";

test("another member's plain assent agrees without recording a decision", () => {
	let state = settledBy(seeded(), "bob");
	for (
		let [id, text, role] of [
			["assent-support", "Sounds good to me.", "support"],
			["assent-none", "Sounds good to me.", "none"],
			["seems-good", "Seems good to me.", "none"],
			["no-reason-not", "Sounds good—no reason not to.", "support"],
		]
	) {
		let current = message(id, text, "alice");
		let output = planEvents({
			channelId: "channel",
			message: current,
			state,
			first: first({ support: 0.9 }),
			candidates: [{
				quote: current.text,
				start: 0,
				end: current.text.length,
				answers: {
					...follow({ role, thread: "thread-a" }),
					agrees_with_settle: { type: "noul", noul: 0.9 },
				},
			}],
		});
		expect(output.events.map((event) => event.type)).toEqual(
			role === "support" ? ["stance.changed", "settle.agreed"] : ["settle.agreed"],
		);
		expect(output.events.at(-1)).toMatchObject({
			type: "settle.agreed",
			optionId: seededOptionId,
			origin: "classifier",
		});
		expect(state.threads[0].decision).toBeUndefined();
	}
});

test("a later attribution vetoes only the earlier assent, retaining objection and question", () => {
	let state = settledBy(seeded(), "Bob");
	let current = message(
		"mixed-withdrawal",
		"Sounds good to me. That's what Bob said, but I disagree. What about agent access?",
		"Jules",
	);
	let quotes = extractQuotes(current.text);
	let output = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: first({
			new_question: 0.95,
			c0_owned_unretracted: 0.2,
			c1_owned_unretracted: 0.9,
			c2_owned_unretracted: 0.9,
		}),
		candidates: [
			{
				...quotes[0]!,
				answers: {
					...follow({ role: "support", thread: "thread-a" }),
					agrees_with_settle: { type: "noul", noul: 0.95 },
				},
			},
			{ ...quotes[1]!, answers: follow({ role: "objection", thread: "thread-a" }) },
			{ ...quotes[2]!, answers: follow({ role: "question", thread: "new" }) },
		],
	});
	expect(output.events.map(event => event.type)).toEqual(["stance.changed", "thread.opened"]);
	expect(output.events[0]).toMatchObject({ position: "oppose" });
	expect(output.events.map(event => "source" in event ? event.source?.quote : ""))
		.toEqual([quotes[1]!.quote, quotes[2]!.quote]);
	expect(output.outcomes[0]?.gate).toBe("source ownership unclear");
	expect(output.events.some(event =>
		event.type === "settle.agreed"
		|| event.type === "settle.suggested" || event.type === "decision.recorded"
	)).toBe(false);
});

test("direct support for the pending option agrees even when generic agreement is low", () => {
	let state = settledBy(seeded(), "bob");
	for (
		let [id, text] of [
			["direct-support", "I support the optional outline."],
			["qualified-support", "I don't see a reason not to use the optional outline."],
		]
	) {
		let current = message(id, text, "alice");
		let output = planEvents({
			channelId: "channel",
			message: current,
			state,
			first: first({ support: 0.95 }),
			candidates: [{
				quote: current.text,
				start: 0,
				end: current.text.length,
				answers: {
					...follow({ role: "support", thread: "thread-a" }),
					option: optionChoice(seededOptionId),
					agrees_with_settle: { type: "noul", noul: 0.1 },
				},
			}],
		});
		expect(output.events.map((event) => event.type)).toEqual([
			"stance.changed",
			"settle.agreed",
		]);
		expect(output.events[1]).toMatchObject({ optionId: seededOptionId });
	}
});
