import { expect, test } from "bun:test";
import { interpretMessage } from "./interpret";
import { mockResult, seeded } from "./interpret.test-fixtures";
import { message } from "./policy-initial.test-fixtures";

test("multi-claim current text gets distinct source ranges and target choices", async () => {
	let current = message(
		"m5",
		"Keep the outline optional; separately, should each repository remember my choice?",
	);
	let seen: Record<string, unknown>[] = [];
	let output = await interpretMessage({
		channelId: "channel",
		message: current,
		recent: [],
		state: seeded(),
		ask: async (request) => {
			seen.push(request.state as Record<string, unknown>);
			if (seen.length === 1) {
				return mockResult(request.questions, {
					new_question: 0.9,
					support: 0.9,
					significance: 2,
				});
			}
			return mockResult(request.questions, {
				c0_role: "support",
				c0_support: 0.95,
				c0_thread: "thread-a",
				c1_role: "question",
				c1_thread: "new",
			});
		},
	});
	expect(seen).toHaveLength(3);
	expect(output.events.map((event) => event.type)).toContain("thread.opened");
	expect(output.events.map((event) => event.type)).toContain("stance.changed");
	expect("source" in output.events[0] ? output.events[0].source?.quote : undefined).not.toBe(
		"source" in output.events[1] ? output.events[1].source?.quote : undefined,
	);
});

test("mixed message keeps per-candidate ranges and review gate in analysis", async () => {
	let current = message(
		"mixed",
		"We've decided to use an outline. Should we remember the choice?",
	);
	let calls = 0;
	let output = await interpretMessage({
		channelId: "channel",
		message: current,
		recent: [],
		state: seeded(),
		ask: async (request) => {
			calls++;
			return mockResult(
				request.questions,
				calls === 1
					? { explicit_resolution: 0.98, new_question: 0.95 }
					: {
						c0_role: "resolution",
						c0_thread: "none",
						c0_explicit_resolution: 0.98,
						c1_role: "question",
						c1_thread: "new",
					},
			);
		},
	});
	expect(output.events.map((event) => event.type)).toEqual(["thread.opened"]);
	expect(output.analysis.outcomes).toHaveLength(2);
	expect(output.analysis.outcomes?.[0]).toMatchObject({ status: "review", start: 0 });
	expect(output.analysis.outcomes?.[0].gate).toContain("target");
	expect(output.analysis.outcomes?.[1]).toMatchObject({
		status: "accepted",
		eventIds: [output.events[0].id],
	});
});
