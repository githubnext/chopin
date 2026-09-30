import { describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type {
	Chat as ChatWire,
	ConversationPlan,
	Plan as PlanWire,
	Request,
} from "@chopin/protocol";
import * as Chat from "../chat/service";
import * as Service from "../plan/service";
import { MemoryStorage } from "../storage/memory/adapter";
import type { Socket, SocketData } from "../wire";
import { createProcessor, type Processor } from "./service";
import * as Jobs from "./jobs";
import {
	greetJoinedPlan,
	publishOpenedPlan,
	readyPlan,
	recoverOpenedPlan,
} from "./service-opening";

function deferred() {
	let resolve!: () => void;
	let promise = new Promise<void>(done => resolve = done);
	return { promise, resolve };
}

async function hosted() {
	let now = new Date("2026-08-13T12:00:00.000Z");
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_ana", login: "ana", avatarUrl: "", now });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_test",
		repositoryOwner: "team",
		repositoryName: "demo",
		title: "Demo",
		createdBy: "U_ana",
		now,
	});
	let lease = await storage.leases.acquire("writer", "test", 60_000);
	if (!lease) throw new Error("test lease missing");
	let server = { publish() {} } as unknown as Server<SocketData>;
	let plan = await Service.open(channel.id, {
		storage,
		lease: () => lease,
		fatal: () => {},
	}, server);
	return { channel, storage, server, plan };
}

function socket() {
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { handle: "ana", principalId: "U_ana" },
		send(value: string) {
			frames.push(JSON.parse(value) as Record<string, unknown>);
		},
	} as unknown as Socket;
	return { ws, frames };
}

function processorFor(plan: Service.Plan, active: () => boolean): Processor {
	return createProcessor({
		plan,
		exclusive: action => Service.exclusive(plan, action),
		persist: () => Service.persistExclusive(plan),
		publish: () => {},
		active,
	});
}

describe("conversation-plan open and join ordering", () => {
	test("failed archive suspension waits for a held opening before reattaching jobs", async () => {
		let context = await hosted();
		let room: { plan?: Service.Plan; opening?: Promise<Service.Plan> } = {};
		let entered = deferred();
		let release = deferred();
		let archiving = true;
		let attachments = 0;
		room.opening = publishOpenedPlan(room, context.plan, async () => {
			entered.resolve();
			await release.promise;
			if (!archiving) attachments++;
		});
		await entered.promise;
		let recovered = Promise.reject(new Error("summary suspension failed")).catch(async () => {
			let opened = await recoverOpenedPlan(room);
			archiving = false;
			if (opened) attachments++;
		});
		await Bun.sleep(2);
		expect(room.plan).toBeUndefined();
		expect(attachments).toBe(0);
		release.resolve();
		await recovered;
		expect(room.plan).toBe(context.plan);
		expect(attachments).toBe(1);
		await Service.close(context.plan);
	});

	test("a joining member sees the durable Planner job queue in the locked snapshot", async () => {
		let context = await hosted();
		context.plan.conversationPlanJobs = Jobs.enqueue([], {
			kind: "heading",
			target: "document",
			trigger: "m1",
		}, "2026-09-25T10:00:00.000Z");
		await Service.persist(context.plan);
		let joiner = socket();
		await greetJoinedPlan(
			context.plan,
			joiner.ws,
			{
				kind: "plan:open",
				ts: 0,
				rid: "open-jobs",
			},
			true,
			() => true,
		);
		expect(joiner.frames.find(frame => frame.kind === "conversation-plan:snapshot")?.jobs)
			.toEqual(context.plan.conversationPlanJobs);
		await Service.close(context.plan);
	});

	test("a send during deferred open waits for processor attachment and commits its pending ID", async () => {
		let context = await hosted();
		let gate = deferred();
		let room: { plan?: Service.Plan; opening?: Promise<Service.Plan> } = {};
		let processor: Processor | undefined;
		room.opening = publishOpenedPlan(room, context.plan, async () => {
			await gate.promise;
			processor = processorFor(context.plan, () => room.plan === context.plan);
		});
		let sender = socket();
		let message: Request<ChatWire.Send> = {
			kind: "chat:send",
			ts: 0,
			rid: "send-1",
			requestId: crypto.randomUUID(),
			text: "Should we use an optional outline?",
			to: "room",
		};
		let sending = (async () => {
			let opened = await readyPlan(room);
			if (!opened) throw new Error("plan did not open");
			await Chat.send(
				{
					chat: opened.chat,
					plan: opened,
					server: context.server,
					room: context.channel.id,
					config: { agent: false } as Chat.Room["config"],
					auth: {} as Chat.Room["auth"],
					claimantSessionId: "session",
					repository: {
						id: "R_test",
						owner: "team",
						name: "demo",
						defaultBranch: "main",
					},
					persist: () => Service.persist(opened),
					commitRoomMessage: entry => processor!.accept(entry),
				},
				sender.ws,
				message,
			);
		})();
		await Bun.sleep(2);
		expect(room.plan).toBeUndefined();
		expect(sender.frames).toEqual([]);
		gate.resolve();
		await Promise.all([room.opening, sending]);
		expect(sender.frames).toContainEqual(expect.objectContaining({
			kind: "chat:send",
			rid: "send-1",
			id: message.requestId,
		}));
		let loaded = await context.storage.collaboration.load(context.channel.id, new Date());
		let sidecar = loaded!.sidecar as Record<string, unknown>;
		expect((sidecar.transcript as ChatWire.Entry[]).map(entry => entry.id)).toEqual([
			message.requestId,
		]);
		expect((sidecar.conversationPlan as { queue: ConversationPlan.QueueItem[] }).queue)
			.toEqual([{ messageId: message.requestId, status: "pending", attempts: 0 }]);
		processor!.stop();
		await Service.close(context.plan);
	});

	for (let fails of [false, true]) {
		test(`joining while a message commit is ${fails ? "failing" : "delayed"} sees only committed state`, async () => {
			let context = await hosted();
			let processor = processorFor(context.plan, () => true);
			let entered = deferred();
			let release = deferred();
			let original = context.storage.collaboration.commit;
			context.storage.collaboration.commit = async input => {
				entered.resolve();
				await release.promise;
				if (fails) throw new Error("storage failed");
				return original(input);
			};
			let accepting = processor.accept({
				id: "message-1",
				author: { kind: "member", handle: "ana" },
				text: "Use an optional outline.",
				ts: 1,
			});
			await entered.promise;
			expect(context.plan.chat.entries.map(entry => entry.id)).toEqual(["message-1"]);
			let joiner = socket();
			let opening: Request<PlanWire.Open.Ask> = {
				kind: "plan:open",
				ts: 0,
				rid: "open-1",
			};
			let greeting = greetJoinedPlan(context.plan, joiner.ws, opening, true, () => true);
			await Bun.sleep(2);
			expect(joiner.frames).toEqual([]);
			release.resolve();
			if (fails) await expect(accepting).rejects.toThrow("storage failed");
			else await accepting;
			await greeting;
			let history = joiner.frames.find(frame => frame.kind === "chat:history")!;
			let snapshot = joiner.frames.find(frame => frame.kind === "conversation-plan:snapshot")!;
			expect((history.entries as ChatWire.Entry[]).map(entry => entry.id))
				.toEqual(fails ? [] : ["message-1"]);
			expect((snapshot.state as { queue: ConversationPlan.QueueItem[] }).queue)
				.toEqual(fails ? [] : [{ messageId: "message-1", status: "pending", attempts: 0 }]);
			context.storage.collaboration.commit = original;
			processor.stop();
			await Service.close(context.plan);
		});
	}
});
