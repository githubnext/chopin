import { describe, expect, it } from "bun:test";

import { ulid } from "@chopin/dialect";
import * as Y from "yjs";

import * as Room from "./room";
import * as Service from "./service";
import { MemoryStorage } from "../storage/memory/adapter";

import type { Server } from "bun";
import type { Plan as Wire, Request } from "@chopin/protocol";
import type { Socket, SocketData } from "../wire";

async function hosted() {
	let now = new Date("2026-08-13T12:00:00.000Z");
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_octocat", login: "octocat", avatarUrl: "", now });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release",
		createdBy: "U_octocat",
		now,
	});
	let lease = await storage.leases.acquire("writer", "test", 60_000);
	if (!lease) throw new Error("could not acquire test lease");
	let frames: Array<Record<string, unknown>> = [];
	let server = {
		publish(_topic: string, value: string) {
			frames.push(JSON.parse(value) as Record<string, unknown>);
		},
	} as unknown as Server<SocketData>;
	let backend: Service.Backend = {
		storage,
		lease: () => lease,
		fatal: err => {
			throw err;
		},
	};
	return { storage, channel, lease, frames, server, backend, now };
}

describe("hosted plan persistence", () => {
	it("does not acknowledge a client update before its durable commit", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let peer = await Room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			Service.source(plan),
			[],
		);
		let mutation = Room.insertDecision(peer, {
			id: ulid(),
			quote: "Durable first",
			by: "octocat",
			at: "2026-08-13T12:00:00.000Z",
			notes: [{ by: "octocat", text: "Do not acknowledge early" }],
		})!;
		let frames: Array<Record<string, unknown>> = [];
		let ws = {
			data: { room: context.channel.id, handle: "octocat", client: "client", canEdit: true },
			send(value: string) {
				frames.push(JSON.parse(value) as Record<string, unknown>);
			},
			publish(_topic: string, value: string) {
				frames.push(JSON.parse(value) as Record<string, unknown>);
			},
			close() {},
		} as unknown as Socket;
		let release: (() => void) | undefined;
		let blocked = new Promise<void>(resolve => {
			release = resolve;
		});
		let original = context.storage.collaboration.commit;
		(context.storage.collaboration as { commit: typeof original }).commit = async input => {
			await blocked;
			return original(input);
		};
		let message: Request<Wire.Submit> = {
			kind: "plan:update",
			ts: 0,
			rid: "request-1",
			id: "update-1",
			epoch: plan.document.epoch,
			update: Buffer.from(mutation.update).toString("base64"),
		};

		Service.submit(plan, ws, message);
		await Bun.sleep(20);
		expect(frames.some(frame => frame.kind === "plan:ack")).toBe(false);
		release!();
		await plan.flushing;
		expect(frames.some(frame => frame.kind === "plan:ack")).toBe(true);
		expect((await context.storage.collaboration.load(context.channel.id, context.now))!.updates)
			.toHaveLength(1);
		peer.doc.destroy();
		await Service.close(plan);
	});

	it("checkpoints a new channel and restores server-authored updates in the same epoch", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let initial = await context.storage.collaboration.load(context.channel.id, context.now);
		expect(initial!.snapshot).toBeDefined();
		expect(initial!.latestSequence).toBe(0);

		let mutation = Room.insertDecision(plan.document, {
			id: ulid(),
			quote: "Ship it",
			by: "octocat",
			at: "2026-08-13T12:00:00.000Z",
			notes: [{ by: "octocat", text: "Ready for release" }],
		});
		expect(mutation).toBeDefined();
		await Service.publish(plan, context.server, context.channel.id, mutation!);
		let epoch = plan.document.epoch;
		let source = Service.source(plan);
		expect(source).toContain("<Decision");
		let journal = await context.storage.collaboration.load(context.channel.id, context.now);
		expect(journal!.updates).toHaveLength(1);
		expect(journal!.latestSequence).toBe(1);

		await Service.close(plan);
		let checkpoint = await context.storage.collaboration.load(context.channel.id, context.now);
		expect(checkpoint!.updates).toEqual([]);
		expect(checkpoint!.snapshot!.throughSequence).toBe(1);

		let restored = await Service.open(context.channel.id, context.backend, context.server);
		expect(restored.document.epoch).toBe(epoch);
		expect(Service.source(restored)).toBe(source);
		await Service.close(restored);
	});

	it("restores sidecar-only transcript changes", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		plan.chat.entries.push({
			id: ulid(),
			author: { kind: "member", handle: "octocat" },
			text: "Keep this conversation",
			ts: 1,
		});
		await Service.persist(plan);
		await Service.close(plan);

		let restored = await Service.open(context.channel.id, context.backend, context.server);
		expect(restored.chat.entries.map(entry => entry.text)).toEqual(["Keep this conversation"]);
		await Service.close(restored);
	});

	it("refuses malformed state instead of replacing it with an empty sidecar", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let epoch = plan.document.epoch;
		await Service.close(plan);
		await context.storage.collaboration.commit({
			channelId: context.channel.id,
			lease: context.lease,
			expectedRevision: 0,
			operationId: "damage-sidecar",
			epoch,
			sidecar: null,
			events: [],
			now: context.now,
		});

		await expect(Service.open(context.channel.id, context.backend, context.server))
			.rejects.toThrow("invalid sidecar");
	});
});
