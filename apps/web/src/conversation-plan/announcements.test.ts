import { describe, expect, it } from "bun:test";

import { advanceConversationAnnouncement } from "./announcements";

import type { ConversationPlan } from "@chopin/protocol";

function event(
	type: "thread.opened" | "card.linked" | "thread.discarded",
	id: string = type,
): ConversationPlan.Event {
	let base: ConversationPlan.EventBase = {
		id,
		threadId: "thread-1",
		observedThreadVersion: 1,
		origin: "human",
		actor: { kind: "member", handle: "ada" },
		at: 1,
	};
	if (type === "thread.opened") return { ...base, type, question: "Which storage?" };
	if (type === "card.linked") return { ...base, type, questionnaireId: "card-1" };
	return { ...base, type };
}

function state(
	revision: number,
	queue: ConversationPlan.QueueItem[] = [],
	events: ConversationPlan.Event[] = [],
): ConversationPlan.State {
	return { schemaVersion: 1, revision, events, threads: [], queue, analysis: [] };
}

function failed(messageId: string): ConversationPlan.QueueItem {
	return { messageId, status: "failed", attempts: 1, error: "analysis failed" };
}

function baseline(value: ConversationPlan.State) {
	return advanceConversationAnnouncement(undefined, value).summary;
}

describe("conversation announcements", () => {
	it("establishes an initial silent baseline even with historical failures and events", () => {
		let initial = state(10, [
			failed("a"),
			{ messageId: "pending", status: "pending", attempts: 1 },
			{ messageId: "processing", status: "processing", attempts: 1 },
		], [event("thread.discarded")]);

		expect(advanceConversationAnnouncement(undefined, initial)).toEqual({
			summary: { revision: 10, events: 1, failedMessages: ["a"] },
		});
		expect(advanceConversationAnnouncement(baseline(initial), undefined)).toEqual({});
	});

	it("keeps persistent failures quiet despite attempts, errors and queue order changes", () => {
		let previous = baseline(state(1, [failed("a"), failed("b")]));
		let next = state(2, [
			{ ...failed("b"), attempts: 4, error: "different error" },
			{ ...failed("a"), attempts: 2 },
		]);

		expect(advanceConversationAnnouncement(previous, next)).toEqual({
			summary: { revision: 2, events: 0, failedMessages: ["b", "a"] },
		});
	});

	it("announces newly failed message IDs while existing failures remain", () => {
		let result = advanceConversationAnnouncement(
			baseline(state(1, [failed("a")])),
			state(2, [failed("a"), failed("b")]),
		);

		expect(result.message).toBe("Message analysis failed. You can retry from Chat.");
		expect(result.summary).toEqual({ revision: 2, events: 0, failedMessages: ["a", "b"] });
	});

	it("allows a retry to fail again after its pending observation", () => {
		let previous = baseline(state(1, [failed("a")]));
		let retry = advanceConversationAnnouncement(
			previous,
			state(2, [{
				messageId: "a",
				status: "pending",
				attempts: 2,
			}]),
		);
		let failure = advanceConversationAnnouncement(retry.summary, state(3, [failed("a")]));

		expect(retry.message).toBeUndefined();
		expect(failure.message).toBe("Message analysis failed. You can retry from Chat.");
		expect(advanceConversationAnnouncement(failure.summary, state(3, [failed("a")])).message)
			.toBeUndefined();
	});

	it("gives a new failure priority over event growth without replaying the card update", () => {
		let batch = [event("thread.discarded"), event("card.linked")];
		let failure = advanceConversationAnnouncement(
			baseline(state(1)),
			state(2, [failed("a")], batch),
		);
		let quiet = advanceConversationAnnouncement(
			failure.summary,
			state(3, [failed("a")], batch),
		);

		expect(failure.message).toBe("Message analysis failed. You can retry from Chat.");
		expect(failure.summary?.events).toBe(2);
		expect(quiet.message).toBeUndefined();
	});

	it("announces accepted event growth only at a higher revision", () => {
		let growth = advanceConversationAnnouncement(
			baseline(state(1)),
			state(2, [], [event("thread.discarded")]),
		);

		expect(growth.message).toBe("A conversation card was updated.");
		expect(
			advanceConversationAnnouncement(
				growth.summary,
				state(3, [], [event("thread.discarded", "replacement")]),
			).message,
		).toBeUndefined();
		expect(advanceConversationAnnouncement(growth.summary, state(3)).message).toBeUndefined();
	});

	it.each(["thread.opened", "card.linked"] as const)(
		"suppresses the entire growing event batch when its final event is %s",
		type => {
			let batch = [event("thread.discarded"), event(type)];
			let excluded = advanceConversationAnnouncement(baseline(state(1)), state(2, [], batch));
			let later = advanceConversationAnnouncement(
				excluded.summary,
				state(3, [], [...batch, event("thread.discarded", "later")]),
			);

			expect(excluded.message).toBeUndefined();
			expect(excluded.summary?.events).toBe(2);
			expect(later.message).toBe("A conversation card was updated.");
		},
	);

	it.each([2, 1])(
		"captures revision %s without announcing equal or lower observations",
		revision => {
			let observed = state(revision, [failed("a")], [event("thread.discarded")]);
			let result = advanceConversationAnnouncement(baseline(state(2)), observed);

			expect(result).toEqual({
				summary: { revision, events: 1, failedMessages: ["a"] },
			});
			expect(
				advanceConversationAnnouncement(result.summary, state(3, observed.queue, observed.events))
					.message,
			).toBeUndefined();
		},
	);

	it("detaches captured counts and failed IDs from later mutation of the observed state", () => {
		let observed = state(1, [failed("a")], [event("thread.discarded")]);
		let result = advanceConversationAnnouncement(undefined, observed);
		observed.revision = 8;
		observed.queue[0]!.messageId = "mutated";
		observed.queue.push(failed("b"));
		observed.events.push(event("card.linked"));

		expect(result.summary).toEqual({ revision: 1, events: 1, failedMessages: ["a"] });
	});
});
