import { expect, test } from "bun:test";
import { handleConversationCommand } from "./commands";
import { correctionCommand } from "./command-correction-memory.test-fixtures";

// These tests cover command-local gates, not socket admission or GitHub authorization.
test("correction commands commit attributed source evidence before reply and survive reopen", async () => {
	let h = await correctionCommand();
	try {
		await handleConversationCommand(h.frame, h.room, h.ws, h.deps);
		let replied = await h.snapshots[0]!;
		let event = replied.conversationPlan.events.at(-1)!;
		let quote = h.seed.excerpt.text.slice(h.seed.start, h.seed.end);
		expect(event).toMatchObject({
			id: "human:bob:add-excerpt",
			type: "reason.added",
			origin: "human",
			actor: { kind: "member", handle: "bob" },
			source: {
				messageId: h.seed.excerpt.id,
				author: { kind: "member", handle: "alice" },
				quote,
				start: h.seed.start,
				end: h.seed.end,
				role: "reason",
			},
		});
		expect(h.frames).toEqual([{
			kind: "conversation-plan:correct",
			rid: h.frame.rid,
			ts: expect.any(Number),
			eventId: event.id,
			revision: replied.conversationPlan.revision,
		}]);
		expect(h.setup.publications).toEqual([replied.conversationPlan]);
		await h.reopen();
		expect(h.setup.plan.conversationPlan).toEqual(replied.conversationPlan);
		expect(replied.transcript).toEqual(h.seed.setup.plan.chat.entries);
		expect(h.setup.plan.chat.entries).toEqual(h.seed.setup.plan.chat.entries);
		await handleConversationCommand({ ...h.frame, rid: "correction-again" }, h.room, h.ws, h.deps);
		expect(h.frames[1]).toMatchObject({
			kind: "conversation-plan:correct",
			rid: "correction-again",
			eventId: event.id,
			revision: replied.conversationPlan.revision,
		});
		expect(h.setup.plan.conversationPlan.events.filter(item => item.id === event.id)).toHaveLength(
			1,
		);
		expect(h.setup.publications).toHaveLength(1);
		expect(h.setup.errors).toEqual([]);
	} finally {
		await h.setup.close();
	}
});

test("correction command storage failure refuses without publishing and remains retryable after reopen", async () => {
	let h = await correctionCommand();
	try {
		let before = await h.setup.saved();
		h.setup.failNextCommit();
		await handleConversationCommand(h.frame, h.room, h.ws, h.deps);
		expect(h.frames).toEqual([{
			kind: "session:error",
			rid: h.frame.rid,
			ts: expect.any(Number),
			message: "memory commit rejected",
		}]);
		expect(await h.snapshots[0]!).toEqual(before);
		expect(await h.setup.saved()).toEqual(before);
		expect(h.setup.plan.conversationPlan).toEqual(before.conversationPlan);
		expect(h.setup.publications).toEqual([]);
		expect(h.setup.fatals).toHaveLength(1);
		await h.reopen();
		expect(h.setup.plan.conversationPlan).toEqual(before.conversationPlan);
		await handleConversationCommand({ ...h.frame, rid: "correction-retry" }, h.room, h.ws, h.deps);
		let saved = await h.setup.saved();
		expect(h.frames[1]).toMatchObject({
			kind: "conversation-plan:correct",
			rid: "correction-retry",
			eventId: "human:bob:add-excerpt",
			revision: saved.conversationPlan.revision,
		});
		expect(saved.conversationPlan.events.filter(item => item.id === "human:bob:add-excerpt"))
			.toHaveLength(1);
		expect(h.setup.publications).toEqual([saved.conversationPlan]);
	} finally {
		await h.setup.close();
	}
});

test.each(["reader", "archived", "disabled", "unavailable"] as const)(
	"correction command refuses %s before any durable mutation",
	async condition => {
		let h = await correctionCommand();
		try {
			let before = await h.setup.saved();
			if (condition === "reader") h.ws.data.canEdit = false;
			if (condition === "archived") h.ws.data.channelArchivedAt = "2026-09-30T00:00:00Z";
			if (condition === "disabled") h.deps.enabled = false;
			if (condition === "unavailable") h.deps.unavailable = () => true;
			await handleConversationCommand(h.frame, h.room, h.ws, h.deps);
			expect(h.frames).toEqual([{
				kind: "session:error",
				rid: h.frame.rid,
				ts: expect.any(Number),
				message: condition === "disabled"
					? "conversation analysis is disabled"
					: "repository write access is required",
			}]);
			expect(await h.setup.saved()).toEqual(before);
			expect(h.setup.plan.conversationPlan).toEqual(before.conversationPlan);
			expect(h.setup.publications).toEqual([]);
			expect(h.setup.fatals).toEqual([]);
		} finally {
			await h.setup.close();
		}
	},
);
