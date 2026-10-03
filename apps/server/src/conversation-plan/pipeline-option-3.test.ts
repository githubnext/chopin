import { expect, test } from "bun:test";
import type { Chat } from "@chopin/protocol";
import { applyEvent } from "./events";
import { optionIdFor, planEvents } from "./policy";
import { seeded, seededOptionId, settledBy } from "./interpret.test-fixtures";
import { first, follow, member, message } from "./policy-initial.test-fixtures";

test("support for another option is not agreement despite a high generic score", () => {
	let state = settledBy(seeded(), "bob");
	let otherOptionId = optionIdFor("channel", "other-option", 0, 1000);
	state = applyEvent(state, {
		id: "human-other-option",
		type: "option.added",
		threadId: "thread-a",
		observedThreadVersion: state.threads[0].version,
		origin: "human",
		actor: member("alice"),
		at: 1001,
		contribution: {
			id: otherOptionId,
			text: "Use a required outline.",
			authoring: "human-edited",
		},
	});
	let current = message("other-support", "I support the required outline.", "alice");
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
				option: {
					type: "choice",
					choice: otherOptionId,
					confidence: 0.95,
					probabilities: { [otherOptionId]: 0.95, [seededOptionId]: 0.05 },
				},
				agrees_with_settle: { type: "noul", noul: 0.99 },
			},
		}],
	});
	expect(output.events.map((event) => event.type)).toEqual(["stance.changed"]);
	expect(output.events[0]).toMatchObject({ optionId: otherOptionId });
	expect(state.threads[0].pendingSettle?.optionId).toBe(seededOptionId);
});

test("weak, self, agent, negative, and wrong-role evidence cannot agree", () => {
	let state = settledBy(seeded(), "bob");
	for (
		let [id, text, handle, role, agreement] of [
			["weak", "Sounds good to me.", "alice", "support", 0.5],
			["self", "Sounds good to me.", "bob", "support", 0.95],
			["negative", "I don't agree with that.", "alice", "none", 0.05],
			["disagree", "I disagree with that.", "alice", "none", 0.05],
			["reported", "She said it sounds good.", "alice", "none", 0.05],
			["quoted", "Please quote ‘sounds good to me’.", "alice", "none", 0.05],
			["sarcastic", "Sure 🙄", "alice", "none", 0.05],
			["objection", "I object to that.", "alice", "objection", 0.95],
		] as const
	) {
		let current = message(id, text, handle);
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
					agrees_with_settle: { type: "noul", noul: agreement },
				},
			}],
		});
		expect(output.events.map((event) => event.type)).not.toContain("settle.agreed");
	}
	let agentMessage: Chat.Entry = {
		...message("agent-assent", "Sounds good to me."),
		author: { kind: "agent" },
	};
	let agent = planEvents({
		channelId: "channel",
		message: agentMessage,
		state,
		first: first({ support: 0.95 }),
		candidates: [{
			quote: agentMessage.text,
			start: 0,
			end: agentMessage.text.length,
			answers: {
				...follow({ role: "none", thread: "thread-a" }),
				agrees_with_settle: { type: "noul", noul: 0.95 },
			},
		}],
	});
	expect(agent.events).toEqual([]);
});
