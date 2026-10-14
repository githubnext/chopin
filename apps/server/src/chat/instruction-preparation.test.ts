import { afterEach, expect, spyOn, test } from "bun:test";
import * as Chat from "./service";
import * as Service from "../plan/service";
import { harness, installJobCleanup, until } from "./job.test-fixtures";
import { hosted } from "./notice.test-fixtures";

installJobCleanup();

let plans: Service.Plan[] = [];
afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	plans = [];
});

async function preparedHarness() {
	let state = harness();
	let saved = await hosted();
	saved.plan.chat = state.chat;
	state.context.plan = saved.plan;
	plans.push(saved.plan);
	return state;
}

test("a durable instruction waits for preparation before its notice and model stream", async () => {
	let state = await preparedHarness();
	let prepared = Promise.withResolvers<Chat.PreparedInstruction>();
	let preparing = false;
	let ended: Chat.Ended[] = [];
	await Chat.instruct(state.context, "Chopin", "old context", "Reviewing findings", {
		prepare: () => {
			preparing = true;
			return prepared.promise;
		},
		ended: outcome => {
			ended.push(outcome);
		},
	});
	await until(() => preparing);
	expect(state.prompts).toEqual([]);
	expect(state.chat.entries).toEqual([]);
	prepared.resolve({
		status: "ready",
		text: "fresh current context",
		noticeId: "result:attempt:1",
	});
	await until(() => state.prompts.length === 1);
	expect(state.prompts[0]).toContain("fresh current context");
	expect(state.prompts[0]).not.toContain("old context");
	expect(state.chat.entries[0]).toMatchObject({
		id: "result:attempt:1",
		text: "Reviewing findings",
	});
	state.emit("session.idle");
	await state.chat.running;
	expect(ended).toEqual([{ status: "done" }]);
});

for (let status of ["deferred", "skipped"] as const) {
	test(`a ${status} preparation preserves unread conversation and never invokes the model`, async () => {
		let state = harness();
		let backscroll = [{ handle: "ana", text: "We changed direction." }];
		state.chat.backscroll = backscroll;
		let ended: Chat.Ended[] = [];
		await Chat.instruct(state.context, "Chopin", "old context", "Reviewing findings", {
			prepare: async () => ({ status }),
			ended: outcome => {
				ended.push(outcome);
			},
		});
		await state.chat.running;
		expect(state.prompts).toEqual([]);
		expect(state.chat.entries).toEqual([]);
		expect(state.chat.backscroll).toEqual(backscroll);
		expect(ended).toEqual([{ status: "skipped" }]);
		expect(state.chat.busy).toBe(false);
	});
}

test("a failed durable claim cannot reach the model", async () => {
	let state = harness();
	let ended: Chat.Ended[] = [];
	await Chat.instruct(state.context, "Chopin", "review", "Reviewing findings", {
		prepare: async () => {
			throw new Error("claim could not be saved");
		},
		ended: outcome => {
			ended.push(outcome);
		},
	});
	await state.chat.running;
	expect(state.prompts).toEqual([]);
	expect(state.chat.entries).toEqual([]);
	expect(ended).toEqual([{ status: "failed" }]);
});

test("closing a prepared instruction still reports its interrupted outcome", async () => {
	let state = await preparedHarness();
	let ended: Chat.Ended[] = [];
	await Chat.instruct(state.context, "Chopin", "review", "Reviewing findings", {
		prepare: async () => ({ status: "ready", text: "review", noticeId: "result:attempt:1" }),
		ended: outcome => {
			ended.push(outcome);
		},
	});
	await until(() => state.prompts.length === 1);
	await Chat.close(state.chat);
	expect(ended).toEqual([{ status: "stopped" }]);
});

test("an automatic queued instruction cannot inherit the preceding human's owner claim", async () => {
	let state = await preparedHarness();
	let claims = spyOn(state.context.auth.storage.channels, "claimAgentOwner");
	state.context.auth.storage.channels.readAgent = async () => undefined;
	await Chat.instruct(state.context, "ana", "Human request", "Human asked");
	await until(() => state.prompts.length === 1);
	let prepared = false;
	let ended: Chat.Ended[] = [];
	await Chat.instruct(
		{ ...state.context, claimantSessionId: undefined },
		"Chopin",
		"review",
		"Reviewing findings",
		{
			prepare: async () => {
				prepared = true;
				return { status: "skipped" };
			},
			ended: outcome => {
				ended.push(outcome);
			},
		},
	);
	state.setOwnerAvailable(false);
	await Chat.resetAgent(state.chat);
	await state.chat.running;
	expect(claims).toHaveBeenCalledTimes(1);
	expect(prepared).toBe(false);
	expect(state.prompts).toHaveLength(1);
	expect(ended).toEqual([{ status: "failed" }]);
	claims.mockRestore();
});

test("a streamed provider error cannot finish a prepared review successfully", async () => {
	let state = await preparedHarness();
	let ended: Chat.Ended[] = [];
	await Chat.instruct(state.context, "Chopin", "review", "Reviewing findings", {
		prepare: async () => ({ status: "ready", text: "review", noticeId: "result:attempt:1" }),
		ended: outcome => {
			ended.push(outcome);
		},
	});
	await until(() => state.prompts.length === 1);
	state.emit("session.error", { message: "provider failed" });
	await state.chat.running;
	expect(ended).toEqual([{ status: "failed" }]);
});

test("prepared turns do not create their own owner-availability wakeups", async () => {
	let state = await preparedHarness();
	let wakeups = 0;
	state.context.ownerAvailable = async () => {
		wakeups++;
	};
	await Chat.instruct(state.context, "Chopin", "review", "Reviewing findings", {
		prepare: async () => ({ status: "deferred" }),
	});
	await state.chat.running;
	expect(wakeups).toBe(0);
});

test("owner expiry after partial output remains an interrupted review", async () => {
	let state = await preparedHarness();
	let binding = await state.context.activeOwner!();
	let expiry = new AbortController();
	state.context.activeOwner = async () => ({ ...binding!, signal: expiry.signal });
	let ended: Chat.Ended[] = [];
	await Chat.instruct(state.context, "Chopin", "review", "Reviewing findings", {
		prepare: async () => ({ status: "ready", text: "review", noticeId: "result:attempt:1" }),
		ended: outcome => {
			ended.push(outcome);
		},
	});
	await until(() => state.prompts.length === 1);
	state.emit("assistant.message_delta", { messageId: "partial", deltaContent: "Partial finding" });
	await until(() => state.chat.entries.some(entry => entry.text === "Partial finding"));
	expiry.abort();
	await state.chat.running;
	expect(ended).toEqual([{ status: "failed", text: "Partial finding" }]);
});

test("the last pre-stream guard runs after notice persistence and preserves unread context on deferral", async () => {
	let state = await preparedHarness();
	let backscroll = [{ handle: "ana", text: "Preserve this changed direction." }];
	state.chat.backscroll = backscroll;
	let ended: Chat.Ended[] = [];
	let released = false;
	await Chat.instruct(state.context, "Chopin", "review", "Reviewing findings", {
		prepare: async () => ({ status: "ready", text: "review", noticeId: "result:attempt:1" }),
		beforeStream: async () => {
			expect(state.chat.entries[0]?.id).toBe("result:attempt:1");
			expect(state.prompts).toHaveLength(0);
			released = true;
			return false as const;
		},
		ended: outcome => {
			ended.push(outcome);
		},
	});
	await state.chat.running;
	expect(released).toBe(true);
	expect(state.prompts).toHaveLength(0);
	expect(state.chat.backscroll).toEqual(backscroll);
	expect(ended).toEqual([{ status: "skipped" }]);
});

for (let failure of ["persistence", "close"] as const) {
	test(`a queued instruction reports abandonment during ${failure} at handoff`, async () => {
		let state = await preparedHarness();
		await Chat.instruct(state.context, "ana", "Human request", "Human asked");
		await until(() => state.prompts.length === 1);
		let ended: Chat.Ended[] = [];
		await Chat.instruct(
			{ ...state.context, claimantSessionId: undefined },
			"Chopin",
			"review",
			"Reviewing findings",
			{
				prepare: async () => {
					throw new Error("must not reach preparation");
				},
				ended: outcome => {
					ended.push(outcome);
				},
			},
		);
		state.context.persist = async () => {
			if (state.chat.waiting.length) return;
			if (failure === "persistence") throw new Error("handoff commit failed");
			void Chat.close(state.chat);
		};
		state.emit("session.idle");
		await state.chat.running;
		expect(state.prompts).toHaveLength(1);
		expect(ended).toEqual([{ status: failure === "persistence" ? "failed" : "skipped" }]);
	});
}
