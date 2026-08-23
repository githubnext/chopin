import { describe, expect, it } from "bun:test";

import { ulid } from "@chopin/dialect";
import * as Y from "yjs";

import * as Room from "./room";
import * as Service from "./service";
import * as Chat from "../chat/service";
import { MemoryStorage } from "../storage/memory/adapter";

import type { Server } from "bun";
import type { Chat as ChatWire, Plan as Wire, Request } from "@chopin/protocol";
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
		let targets: Service.DocumentTarget[] = [];
		context.backend.onDocumentPersisted = target => targets.push(target);
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
		expect(targets).toEqual([{
			channelId: context.channel.id,
			revision: 1,
			source: Service.source(plan),
			sourceHash: Service.sourceHash(Service.source(plan)),
		}]);
		Service.submit(plan, ws, { ...message, rid: "request-2", id: "update-2" });
		await Bun.sleep(10);
		await plan.flushing;
		expect(plan.revision).toBe(1);
		expect(targets).toHaveLength(1);
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
		let targets: Service.DocumentTarget[] = [];
		context.backend.onDocumentPersisted = target => targets.push(target);
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		plan.chat.entries.push({
			id: ulid(),
			author: { kind: "member", handle: "octocat" },
			text: "Keep this conversation",
			ts: 1,
		});
		await Service.persist(plan);
		expect(targets).toEqual([]);
		await Service.close(plan);

		let restored = await Service.open(context.channel.id, context.backend, context.server);
		expect(restored.chat.entries.map(entry => entry.text)).toEqual(["Keep this conversation"]);
		await Service.close(restored);
	});

	it("restores typed chat references with their observed target state", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let reference = {
			id: ulid(),
			kind: "document" as const,
			start: 0,
			end: 8,
			label: "#Release",
			href: "/documents/octo-org/score/release-notes",
			repositoryId: "R_score",
			observedRevision: 4,
			channelId: crypto.randomUUID(),
			observedSourceHash: Service.sourceHash("Observed source.\n"),
		};
		plan.chat.entries.push({
			id: ulid(),
			author: { kind: "member", handle: "octocat" },
			text: "#Release",
			ts: 1,
			references: [reference],
		});
		await Service.persist(plan);
		await Service.close(plan);

		let restored = await Service.open(context.channel.id, context.backend, context.server);
		expect(restored.chat.entries[0]?.references).toEqual([reference]);
		await Service.close(restored);
	});

	it("replays a persisted room send request without duplicating its member entry", async () => {
		let context = await hosted();
		let plan = await Service.open(context.channel.id, context.backend, context.server);
		let replies: Array<Record<string, unknown>> = [];
		let ws = {
			data: { handle: "octocat", principalId: "U_octocat" },
			send(value: string) {
				replies.push(JSON.parse(value) as Record<string, unknown>);
			},
		} as unknown as Socket;
		let room = (current: Service.Plan): Chat.Room => ({
			chat: current.chat,
			plan: current,
			server: context.server,
			room: context.channel.id,
			config: {} as Chat.Room["config"],
			auth: {} as Chat.Room["auth"],
			claimantSessionId: "session",
			repository: {
				id: "R_score",
				owner: "octo-org",
				name: "score",
				defaultBranch: "main",
			},
			persist: () => Service.persist(current),
		});
		let requestId = crypto.randomUUID();
		let message: Request<ChatWire.Send> = {
			kind: "chat:send",
			ts: 0,
			rid: "first",
			requestId,
			text: "Persist exactly once",
			to: "room",
		};
		await Chat.send(room(plan), ws, message);
		await Service.close(plan);

		let restored = await Service.open(context.channel.id, context.backend, context.server);
		await Chat.send(room(restored), ws, { ...message, rid: "retry" });
		expect(restored.chat.entries.filter(entry => entry.id === requestId)).toHaveLength(1);
		expect(replies.filter(frame => frame.kind === "chat:send")).toEqual([
			expect.objectContaining({ rid: "first", id: requestId, queued: false }),
			expect.objectContaining({ rid: "retry", id: requestId, queued: false }),
		]);
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
