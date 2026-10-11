import { expect, test } from "bun:test";

import { childSidecarWithoutConversation } from "./child-conversation";

const BASE = {
	version: 1,
	revision: 3,
	documentSeq: 7,
	questions: [],
	openQuestions: [],
	threads: [{ id: "t", status: "open" }],
};

test("clears every conversation field and keeps document state", () => {
	let cleared = childSidecarWithoutConversation({
		...BASE,
		transcript: [{ id: "m", author: { kind: "member", handle: "ana" }, text: "hi", ts: 1 }],
		workflowRuns: [{ id: "r" }],
		conversationPlan: { version: 2, queue: [{ messageId: "m" }] },
		conversationPlanRetries: [{ messageId: "m" }],
		conversationPlanJobs: [{ id: "j" }],
		conversationPlanEffects: [],
		conversationPlanPendingEffects: [],
		pendingCardActions: [{ id: "a" }],
	});
	expect(cleared).toEqual({ ...BASE, transcript: [] });
});

test("reports a sidecar with nothing to clear as unchanged", () => {
	expect(childSidecarWithoutConversation({ ...BASE, transcript: [] })).toBe("unchanged");
	expect(childSidecarWithoutConversation(JSON.stringify({ ...BASE, transcript: [] })))
		.toBe("unchanged");
});

test("keeps a child whose decisions cite chat messages", () => {
	for (
		let record of [
			{ id: "q", optionOrigins: { o: { origin: "chat", source: { messageId: "m" } } } },
			{ id: "q", optionOrigins: {}, threadId: "conversation-thread" },
		]
	) {
		expect(childSidecarWithoutConversation({
			...BASE,
			questions: [record],
			transcript: [{ id: "m" }],
		})).toBe("kept");
	}
});

test("clears a child whose decisions came from the Planner, not Chat", () => {
	let record = { id: "q", optionOrigins: { o: { origin: "planner" } } };
	expect(childSidecarWithoutConversation({
		...BASE,
		questions: [record],
		transcript: [{ id: "m" }],
	})).toEqual({ ...BASE, questions: [record], transcript: [] });
});

test("leaves unparseable sidecars to restoration, which already rejects them", () => {
	expect(childSidecarWithoutConversation("{not json")).toBe("unchanged");
	expect(childSidecarWithoutConversation(null)).toBe("unchanged");
});
