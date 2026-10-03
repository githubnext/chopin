import { expect, test } from "bun:test";
import * as Chat from "../chat/service";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { createConversationRuntime } from "./runtime";
import { until } from "./service.test-fixtures";
import type { Room } from "../rooms";
import type { Socket } from "../wire";

test("runtime withholds chat acknowledgement and publication until the transcript and queue commit", async () => {
	let opened = await openPlan();
	let plan = opened.plan;
	let room: Room = { id: plan.id, plan, members: new Map() };
	let started = false;
	let release!: () => void;
	let gate = new Promise<void>(resolve => release = resolve);
	let original = opened.storage.collaboration.commit;
	opened.storage.collaboration.commit = async input => {
		started = true;
		await gate;
		return original(input);
	};
	let runtime = createConversationRuntime({
		config: { agent: false, conversationPlan: true },
		server: () => opened.server,
		unavailable: () => false,
		interpret: async () => ({
			events: [],
			analysis: {
				status: "unlinked",
				questionSetVersion: "test",
				modelVersion: "test",
				passes: [],
			},
		}),
	});
	let replies: string[] = [];
	let socket = {
		data: { handle: "test", principalId: "U_test" },
		send(value: string) {
			replies.push(value);
		},
	} as unknown as Socket;
	let send: Promise<void> | undefined;
	try {
		await runtime.attach(room, plan, false);
		let context = runtime.bind(
			{
				chat: plan.chat,
				plan,
				server: opened.server,
				room: plan.id,
				config: { agent: false } as Chat.Room["config"],
				persist: () => Plan.persist(plan),
			} as Chat.Room,
		);
		send = Chat.send(context, socket, {
			kind: "chat:send",
			rid: "send",
			requestId: crypto.randomUUID(),
			to: "room",
			text: "Discuss authentication",
			ts: 0,
		});
		await until(() => started);
		expect(replies).toEqual([]);
		expect(opened.broadcasts).toEqual([]);
		let before = (await opened.storage.collaboration.load(plan.id, opened.now))!;
		expect(before.sidecar ?? before.snapshot!.sidecar).toMatchObject({ transcript: [] });
		release();
		await send;
		expect(replies.map(value => JSON.parse(value).kind)).toContain("chat:send");
		let after = (await opened.storage.collaboration.load(plan.id, opened.now))!;
		expect(after.sidecar ?? after.snapshot!.sidecar).toMatchObject({
			transcript: [{ text: "Discuss authentication" }],
			conversationPlan: { queue: [{ status: "pending" }] },
		});
	} finally {
		release();
		await send;
		let stopped = runtime.stop(plan);
		await stopped;
		await Plan.close(plan);
	}
});
