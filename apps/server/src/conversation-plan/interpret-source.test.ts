import { expect, test } from "bun:test";
import { interpretMessage } from "./interpret";
import { initialState } from "./domain";
import type { JevQuestion } from "./jev";
import { message, mockResult, seeded, settledBy } from "./interpret.test-fixtures";
import { extractQuotes } from "./quotes";

// Exact archive446a9779a937fa5be7cd3eb52fd7f3023d691ed2, pipeline.test.ts.
// Complete callbacks and helpers retained; injected offline transport only.

test("rejects a fifth source quote before Jev or any partial event", async () => {
	let current = message(
		"five-quotes",
		"Use GitHub OAuth. Use magic links. Send user tokens. Use a GitHub App. Keep credentials separate.",
	);
	let calls = 0;
	expect(() => extractQuotes(current.text)).toThrow("source quote count exceeds 4");

	let output = await interpretMessage({
		channelId: "channel",
		message: current,
		recent: [],
		state: initialState(),
		ask: async request => {
			calls++;
			return mockResult(request.questions, {});
		},
	});

	expect(calls).toBe(0);
	expect(output.events).toEqual([]);
	expect(output.analysis.status).toBe("failed");
});

test("a late retraction beyond the ownership context fails closed before Jev", async () => {
	let calls = 0;
	let ask = async (request: { questions: Record<string, JevQuestion> }) => {
		calls++;
		return mockResult(request.questions, {});
	};
	let tooLong = message(
		"late-retraction",
		`Sounds good to me. ${"x".repeat(4000)} Actually, no—I withdraw that.`,
		"Jules",
	);
	let blocked = await interpretMessage({
		channelId: "channel",
		message: tooLong,
		recent: [],
		state: settledBy(seeded(), "Mina"),
		ask,
	});
	expect(blocked.events).toEqual([]);
	expect(blocked.analysis).toMatchObject({
		status: "unlinked",
		policyGate: "message exceeds ownership context",
		passes: [],
	});
	expect(calls).toBe(0);
	let boundary = message("exact-boundary", `${"x".repeat(3999)}.`, "Jules");
	await interpretMessage({
		channelId: "channel",
		message: boundary,
		recent: [],
		state: initialState(),
		ask,
	});
	expect(calls).toBe(1);
});
