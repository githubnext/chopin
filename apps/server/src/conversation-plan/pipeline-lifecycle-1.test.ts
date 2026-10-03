import { expect, test } from "bun:test";
import type { JevQuestion } from "./jev";
import { planEvents } from "./policy";
import { buildTargetingRequest } from "./questions";
import { extractQuotes } from "./quotes";
import { seeded, seededOptionId } from "./interpret.test-fixtures";
import { first, follow, message } from "./policy-initial.test-fixtures";
import { optionChoice } from "./pipeline-ordinary-save.test-fixtures";
import { decided, discarded } from "./pipeline-lifecycle.test-fixtures";

test("a discarded question opens anew only when deliberately raised again", () => {
	let state = discarded(seeded());
	let current = message("bring-back", "Should we use an optional outline?");
	let request = buildTargetingRequest(current, [], state.threads, extractQuotes(current.text));
	let choices = (request.questions.c0_thread as Extract<JevQuestion, { type: "choice" }>).criteria;
	expect(choices["thread-a"]).toContain("(discarded)");
	let ask = (raises: number, newQuestion = 0.95) =>
		planEvents({
			channelId: "channel",
			message: current,
			state,
			first: first({ new_question: newQuestion }),
			candidates: [{
				quote: current.text,
				start: 0,
				end: current.text.length,
				answers: {
					...follow({ role: "question", thread: "thread-a" }),
					raises_again: { type: "noul", noul: raises },
				},
			}],
		});
	expect(ask(0.2).events).toEqual([]);
	expect(ask(0.2).outcomes[0].gate).toBe("discarded question not raised again");
	expect(ask(0.9, 0.89).events).toEqual([]);
	let raised = ask(0.9);
	expect(raised.events.map((event) => event.type)).toEqual(["thread.opened"]);
	expect(raised.events[0].threadId).not.toBe("thread-a");
	expect(state.threads[0].status).toBe("discarded");
	let option = message("late-option", "Use a summary instead.");
	let blocked = planEvents({
		channelId: "channel",
		message: option,
		state,
		first: first({ new_option: 0.9 }),
		candidates: [{
			quote: option.text,
			start: 0,
			end: option.text.length,
			answers: follow({ role: "option", thread: "thread-a" }),
		}],
	});
	expect(blocked.events).toEqual([]);
	expect(blocked.outcomes[0].gate).toBe("thread discarded");
});

test("a decided target cannot receive a settle proposal", () => {
	let current = message("closed-settle", "Let's go with the optional outline.");
	let output = planEvents({
		channelId: "channel",
		message: current,
		state: decided(),
		first: first({ explicit_resolution: 0.98 }),
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
	expect(output.events).toEqual([]);
	expect(output.outcomes[0].gate).toBe("settle target needs review");
});
