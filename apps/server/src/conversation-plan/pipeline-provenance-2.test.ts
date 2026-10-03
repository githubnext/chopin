import { expect, test } from "bun:test";
import { planEvents } from "./policy";
import { extractQuotes } from "./quotes";
import { seeded, seededOptionId, settledBy, withOption } from "./interpret.test-fixtures";
import { first, follow, message } from "./policy-initial.test-fixtures";
import { optionChoice } from "./pipeline-ordinary-save.test-fixtures";

test("reported, sarcastic, and retracted quotes cannot borrow strong agreement evidence", () => {
	for (
		let [text, owned] of [
			["Bob said, 'sounds good to me.'", 0.04],
			["Sounds good to me 🙄. What about agents?", 0.22],
			["Sounds good to me. Actually, no—I disagree with GitHub.", 0.17],
		] as const
	) {
		let current = message(`negative-${owned}`, text, "Jules");
		let quote = extractQuotes(current.text)[0]!;
		let output = planEvents({
			channelId: "channel",
			message: current,
			state: settledBy(seeded(), "Mina"),
			first: first({ support: 0.95, c0_owned_unretracted: owned }),
			candidates: [{
				...quote,
				answers: {
					...follow({ role: "support", thread: "thread-a" }),
					agrees_with_settle: { type: "noul", noul: 0.95 },
				},
			}],
		});
		expect(output.events).toEqual([]);
		expect(output.outcomes[0]?.gate).toBe("source ownership unclear");
	}
	let current = message("retracted-resolution", "Let's use Redis. Actually, no.", "Jules");
	let quote = extractQuotes(current.text)[0]!;
	let output = planEvents({
		channelId: "channel",
		message: current,
		state: withOption(seeded()),
		first: first({ explicit_resolution: 0.98, c0_owned_unretracted: 0.09 }),
		candidates: [{
			...quote,
			answers: {
				...follow({ role: "resolution", thread: "thread-a", explicit_resolution: 0.98 }),
				chosen_option: optionChoice(seededOptionId),
			},
		}],
	});
	expect(output.events).toEqual([]);
	expect(output.outcomes[0]?.gate).toBe("source ownership unclear");
});

test("a separately sourced concern and question can follow assent in one message", () => {
	let state = settledBy(seeded(), "Mina");
	let other = structuredClone(state.threads[0]!);
	other.id = "thread-b";
	other.question = "How should we handle agent access?";
	other.pendingSettle = undefined;
	state.threads.push(other);
	let current = message(
		"mixed-three",
		"Sounds good to me. I'm worried about agent access. Should we use Copilot?",
		"Jules",
	);
	let quotes = extractQuotes(current.text);
	let output = planEvents({
		channelId: "channel",
		message: current,
		state,
		first: first({
			new_question: 0.95,
			c0_owned_unretracted: 0.9,
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
			{ ...quotes[1]!, answers: follow({ role: "objection", thread: "thread-b" }) },
			{ ...quotes[2]!, answers: follow({ role: "question", thread: "new" }) },
		],
	});
	expect(output.events.map(event => event.type)).toEqual([
		"stance.changed",
		"settle.agreed",
		"stance.changed",
		"thread.opened",
	]);
	expect(output.events.map(event => "source" in event ? event.source?.quote : ""))
		.toEqual([quotes[0]!.quote, quotes[0]!.quote, quotes[1]!.quote, quotes[2]!.quote]);
	expect(
		output.events.every(event => "source" in event && event.source?.messageId === current.id),
	)
		.toBe(true);
	expect(output.events.some(event => event.type === "decision.recorded")).toBe(false);
});
