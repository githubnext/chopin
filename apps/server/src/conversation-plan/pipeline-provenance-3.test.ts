import { expect, test } from "bun:test";
import type { ConversationPlan } from "@chopin/protocol";
import type { JevAnswer } from "./jev";
import { optionIdFor, planEvents } from "./policy";
import { extractQuotes } from "./quotes";
import { seeded, seededOptionId, settledBy, withOption } from "./interpret.test-fixtures";
import { confidentChoice, first, follow, member, message } from "./policy-initial.test-fixtures";
import { stateWithOption } from "./policy-terminal.test-fixtures";
import { queueWithPendingSave } from "./pipeline-ordinary-save-pending.test-fixtures";

test("specific pending agreement corroborates support without changing the role gate", () => {
	let current = message("pending-assent", "Sounds good to me.", "Jules");
	let answers = {
		...follow({ role: "support", thread: "thread-a" }),
		support: { type: "noul" as const, noul: 0.62 },
		agrees_with_settle: { type: "noul" as const, noul: 0.71 },
	};
	let run = (state: ConversationPlan.State) =>
		planEvents({
			channelId: "channel",
			message: current,
			state,
			first: first({ support: 0.39, c0_owned_unretracted: 0.92 }),
			candidates: [{ quote: current.text, start: 0, end: current.text.length, answers }],
		});
	expect(run(settledBy(seeded(), "Mina")).events.map(event => event.type))
		.toEqual(["stance.changed", "settle.agreed"]);
	expect(run(withOption(seeded())).events).toEqual([]);
	let pending = settledBy(seeded(), "Mina");
	let otherId = optionIdFor("channel", "other-pending-test", 0, 1000);
	pending.threads[0]!.contributions.push({
		...pending.threads[0]!.contributions[0]!,
		id: otherId,
		text: "Use another option.",
	});
	let conflicting = planEvents({
		channelId: "channel",
		message: current,
		state: pending,
		first: first({ c0_owned_unretracted: 0.92 }),
		candidates: [{
			quote: current.text,
			start: 0,
			end: current.text.length,
			answers: {
				...answers,
				option: {
					type: "choice",
					choice: otherId,
					confidence: 0.95,
					probabilities: { [otherId]: 0.95, [seededOptionId]: 0.05 },
				},
			},
		}],
	});
	expect(conflicting.events).toEqual([]);
	let self = planEvents({
		channelId: "channel",
		message: { ...current, author: member("Mina") },
		state: pending,
		first: first({ c0_owned_unretracted: 0.92 }),
		candidates: [{ quote: current.text, start: 0, end: current.text.length, answers }],
	});
	expect(self.events).toEqual([]);
});

test("withdrawal needs the own accepted pending option and cannot become generic opposition", () => {
	let { state } = queueWithPendingSave();
	let assess = (
		candidateState = state,
		handle = "Mina",
		text = "I take back my SQS preference for now.",
		overrides: Record<string, JevAnswer> = {},
		owned = 0.95,
	) => {
		let current = message(`withdraw-${handle}`, text, handle);
		let quote = extractQuotes(text)[0]!;
		return planEvents({
			channelId: "channel",
			message: current,
			state: candidateState,
			first: first({ c0_owned_unretracted: owned, correction: 0.91, withdrawal: 0.92 }),
			candidates: [{
				...quote,
				answers: {
					...follow({ role: "objection", thread: "queue-thread" }),
					option: confidentChoice("sqs-option"),
					withdraws_pending_settle: { type: "noul", noul: 0.95 },
					...overrides,
				},
			}],
		});
	};
	expect(assess().events.map(event => event.type)).toEqual(["stance.changed"]);
	expect(assess(state, "Jules").events).toEqual([]);
	expect(assess(state, "Mina", undefined, { option: confidentChoice("postgres-option") }).events)
		.toEqual([]);
	expect(assess(state, "Mina", undefined, { thread: confidentChoice("none") }).events)
		.toEqual([]);
	expect(
		assess(state, "Mina", undefined, {
			withdraws_pending_settle: { type: "noul", noul: 0.2 },
		}).events,
	).toEqual([]);
	let absent = stateWithOption(
		"Which queue should handle background jobs?",
		"queue-thread",
		"sqs-option",
		"Use SQS.",
	);
	expect(assess(absent).events).toEqual([]);
	expect(assess(state, "Mina", "If I take back my SQS preference, revisit this.").events)
		.toEqual([]);
	expect(assess(state, "Mina", "I take back my SQS preference if launch slips.").events)
		.toEqual([]);
	expect(assess(state, "Mina", "Alice said I take back my SQS preference.", {}, 0.1).events)
		.toEqual([]);
});
