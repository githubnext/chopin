import { describe, expect, it } from "bun:test";

import * as Chat from "../chat/service";
import * as Comments from "../comments/service";
import * as edit from "../plan/edit";
import * as Room from "../plan/room";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import * as Rooms from "../rooms";
import { openPlan } from "../testing/plan";
import { hosted } from "./hosted";

import type { HostedAuth } from "../auth/routes";
import type { HostedCallbacks } from "./hosted";
import type { UpdateDocumentInput } from "./update";
import type { Socket } from "../wire";

type Context = Awaited<ReturnType<typeof openPlan>>;
const caller = { oauthToken: "token", user: { id: "U_test", login: "test", avatarUrl: "" } };
const client = { name: "update-test", version: "1" };

function adapter(context: Context, callbacks: HostedCallbacks = {}) {
	return hosted(
		{
			config: { origin: "https://chopin.test" },
			storage: context.storage,
			clock: () => new Date(),
			github: {
				repository: async () => ({
					id: "R_test",
					owner: "owner",
					name: "repository",
					permissions: { pull: true, push: true, admin: false },
				}),
			},
		} as unknown as HostedAuth,
		{ lease: () => context.lease },
		callbacks,
	);
}

function input(
	context: Context,
	overrides: Partial<UpdateDocumentInput> = {},
): UpdateDocumentInput {
	return {
		id: context.channel.id,
		revision: 0,
		plan: "# Changed\n",
		idempotencyKey: "update-1",
		fingerprint: "fingerprint-1",
		...overrides,
	};
}

async function stored(context: Context) {
	let loaded = (await context.storage.collaboration.load(context.channel.id, new Date()))!;
	return { loaded, projected: await Plan.readStored(loaded) };
}

function attach(context: Context) {
	let room = Rooms.join({ data: { room: context.channel.id, client: "test" } } as Socket);
	room.plan = context.plan;
	return room;
}

function latch() {
	let release!: () => void;
	let promise = new Promise<void>(resolve => {
		release = resolve;
	});
	return { promise, release };
}

function queue() {
	let tail = Promise.resolve();
	return <T>(action: () => Promise<T>): Promise<T> => {
		let operation = tail.then(action, action);
		tail = operation.then(() => {}, () => {});
		return operation;
	};
}

function socket(context: Context) {
	let frames: Array<Record<string, unknown>> = [];
	let ws = {
		data: { room: context.channel.id, client: "browser", handle: "test", principalId: "U_test" },
		send(value: string) {
			frames.push(JSON.parse(value));
		},
		publish(_topic: string, value: string) {
			frames.push(JSON.parse(value));
		},
	} as Socket;
	return { ws, frames };
}

describe("hosted document rewrite lifecycle", () => {
	it("does not persist a failed closed rewrite during cleanup or falsely replay it", async () => {
		let context = await openPlan("# Original\n");
		await Plan.close(context.plan);
		let api = adapter(context);
		let commit = context.storage.collaboration.commit;
		let attempts = 0;
		context.storage.collaboration.commit = async value => {
			if (++attempts === 1) throw new Error("injected pre-commit failure");
			return commit(value);
		};
		await expect(api.update!.update(caller, input(context), client))
			.rejects.toThrow("injected pre-commit failure");
		let rejected = await stored(context);
		expect(rejected.projected).toMatchObject({ source: "# Original\n", revision: 0 });
		expect(rejected.loaded.sidecar).not.toHaveProperty("mcpUpdates");
		expect(attempts).toBe(1);
		let accepted = await api.update!.update(caller, input(context), client);
		expect(accepted).toMatchObject({
			kind: "updated",
			document: { source: "# Changed\n", revision: 1 },
		});
		expect(await api.update!.update(caller, input(context), client)).toMatchObject({
			kind: "replayed",
			document: { source: "# Changed\n", revision: 1 },
		});
		expect((await stored(context)).projected).toMatchObject({ source: "# Changed\n", revision: 1 });
	});

	it("serializes live reads behind a rejected rewrite and retries from durable Yjs history", async () => {
		let context = await openPlan("# Original\n");
		let room = attach(context);
		let api = adapter(context);
		let commit = context.storage.collaboration.commit;
		let entered = latch(), release = latch();
		context.storage.collaboration.commit = async () => {
			entered.release();
			await release.promise;
			throw new Error("injected pre-commit failure");
		};
		let updating = api.update!.update(caller, input(context), client).catch(error => error);
		try {
			await entered.promise;
			expect(Plan.source(context.plan)).toBe("# Original\n");
			expect(context.plan.revision).toBe(0);
			expect(context.plan.mcpUpdates).toEqual([]);
			expect(context.broadcasts).toEqual([]);
			let readFinished = false;
			let reading = api.documents.read(caller, context.channel.id).then(value => {
				readFinished = true;
				return value;
			});
			await Bun.sleep(10);
			expect(readFinished).toBe(false);
			release.release();
			expect(await updating).toBeInstanceOf(Error);
			expect(await reading).toMatchObject({ source: "# Original\n", revision: 0 });
			expect((await stored(context)).loaded.sidecar).not.toHaveProperty("mcpUpdates");
			context.storage.collaboration.commit = commit;
			let accepted = await api.update!.update(caller, input(context), client);
			expect(accepted).toMatchObject({ kind: "updated", document: { revision: 1 } });
			expect(await api.update!.update(caller, input(context), client)).toMatchObject({
				kind: "replayed",
				document: { source: "# Changed\n", revision: 1 },
			});
			let durable = await stored(context);
			expect(durable.loaded.updates).toHaveLength(1);
			expect(durable.projected).toMatchObject({ source: "# Changed\n", revision: 1 });
			let reopened = await Plan.open(context.channel.id, context.backend, context.server);
			try {
				expect(Plan.source(reopened)).toBe("# Changed\n");
				expect(reopened.mcpUpdates.map(value => value.idempotencyKey)).toEqual(["update-1"]);
			} finally {
				await Plan.close(reopened);
			}
		} finally {
			release.release();
			await updating;
			context.storage.collaboration.commit = commit;
			Rooms.forget(room);
			await Plan.close(context.plan);
		}
	});

	it("refreshes archive metadata after entering the document lock", async () => {
		let context = await openPlan("# Original\n");
		await Plan.close(context.plan);
		let api = adapter(context, {
			serializeDocument: async (_id, action) => {
				await context.storage.channels.archive({ id: context.channel.id, now: new Date() });
				return action();
			},
		});
		expect(await api.update!.update(caller, input(context), client)).toEqual({ kind: "archived" });
		let durable = await stored(context);
		expect(durable.projected).toMatchObject({ source: "# Original\n", revision: 0 });
		expect(durable.loaded.sidecar).not.toHaveProperty("mcpUpdates");
	});

	for (let live of [false, true]) {
		for (let sameKey of [false, true]) {
			it(`serializes parallel ${live ? "live" : "closed"} updates with ${sameKey ? "the same key" : "a shared revision"}`, async () => {
				let context = await openPlan("# Original\n");
				let room = live ? attach(context) : undefined;
				if (!live) await Plan.close(context.plan);
				try {
					let api = adapter(context);
					let results = await Promise.all([
						api.update!.update(caller, input(context), client),
						api.update!.update(
							caller,
							input(
								context,
								sameKey ? {} : {
									plan: "# Other\n",
									idempotencyKey: "update-2",
									fingerprint: "fingerprint-2",
								},
							),
							client,
						),
					]);
					expect(results.map(value => value.kind)).toEqual([
						"updated",
						sameKey ? "replayed" : "revision-conflict",
					]);
					expect((await stored(context)).projected).toMatchObject({
						source: "# Changed\n",
						revision: 1,
					});
				} finally {
					if (room) {
						Rooms.forget(room);
						await Plan.close(context.plan);
					}
				}
			});
		}
	}

	it("does not wait for a room opening queued behind its document lock", async () => {
		let context = await openPlan("# Original\n");
		await Plan.close(context.plan);
		let room = Rooms.join({ data: { room: context.channel.id, client: "browser" } } as Socket);
		let lock = queue(), release = latch(), queued = latch();
		let blocker = lock(() => release.promise);
		let api = adapter(context, {
			serializeDocument: (_id, action) => {
				let result = lock(action);
				queued.release();
				return result;
			},
		});
		let updating = api.update!.update(caller, input(context), client);
		await queued.promise;
		room.opening = lock(async () => {
			room.plan = await Plan.open(context.channel.id, context.backend, context.server);
			return room.plan;
		});
		release.release();
		await blocker;
		try {
			let result = await Promise.race([
				updating,
				Bun.sleep(300).then(() => ({ kind: "blocked" })),
			]);
			expect(result.kind).toBe("updated");
			await room.opening;
			expect(Plan.source(room.plan!)).toBe("# Changed\n");
		} finally {
			Rooms.forget(room);
			if (room.plan) await Plan.close(room.plan);
		}
	});

	it("retains chat, comment replies, and new threads admitted while a rewrite commits", async () => {
		let context = await openPlan("# Original\n\nRetained paragraph.\n");
		let room = attach(context);
		let api = adapter(context);
		let { ws, frames } = socket(context);
		let blocks = [1];
		let comment = {
			kind: "comment:start" as const,
			ts: 0,
			rid: "first-thread",
			blocks,
			quote: "Retained paragraph.",
			offset: 0,
			length: 19,
			text: "First note",
		};
		await Comments.start(context.plan, context.server, context.channel.id, ws, comment);
		expect(frames).toContainEqual(expect.objectContaining({ kind: "comment:start", ok: true }));
		let opened = frames.find(frame => frame.kind === "comment:start") as { thread: { id: string } };
		let commit = context.storage.collaboration.commit;
		let entered = latch(), release = latch(), chatQueued = latch();
		let held = false;
		context.storage.collaboration.commit = async value => {
			if (!held) {
				held = true;
				entered.release();
				await release.promise;
			}
			return commit(value);
		};
		let updating = api.update!.update(
			caller,
			input(context, {
				plan: "# Changed\n\nRetained paragraph.\n",
			}),
			client,
		);
		try {
			await entered.promise;
			let responding = Comments.respond(context.plan, ws, {
				kind: "comment:reply",
				ts: 0,
				rid: "reply",
				id: opened.thread.id,
				text: "Concurrent reply",
			});
			let starting = Comments.start(context.plan, context.server, context.channel.id, ws, {
				...comment,
				rid: "second-thread",
				text: "Concurrent thread",
			});
			let chatting = Chat.send(
				{
					plan: context.plan,
					chat: context.plan.chat,
					server: context.server,
					room: context.channel.id,
					persist: () => {
						chatQueued.release();
						return Plan.persist(context.plan);
					},
				} as Chat.Room,
				ws,
				{
					kind: "chat:send",
					ts: 0,
					rid: "chat",
					requestId: crypto.randomUUID(),
					to: "room",
					text: "Concurrent message",
				},
			);
			await chatQueued.promise;
			release.release();
			expect(await updating).toMatchObject({ kind: "updated", document: { revision: 1 } });
			await Promise.all([responding, starting, chatting]);
			expect((await stored(context)).projected).toMatchObject({
				source: "# Changed\n\nRetained paragraph.\n",
				revision: 1,
			});
			let reopened = await Plan.open(context.channel.id, context.backend, context.server);
			try {
				for (let plan of [context.plan, reopened]) {
					let observed = socket(context);
					Chat.greet(plan.chat, observed.ws);
					Comments.greet(plan, observed.ws);
					expect(observed.frames).toContainEqual(expect.objectContaining({
						kind: "chat:history",
						entries: [expect.objectContaining({ text: "Concurrent message" })],
					}));
					expect(observed.frames).toContainEqual(expect.objectContaining({
						kind: "comment:sync",
						threads: [
							expect.objectContaining({
								notes: [
									expect.objectContaining({ text: "First note" }),
									expect.objectContaining({ text: "Concurrent reply" }),
								],
							}),
							expect.objectContaining({
								notes: [expect.objectContaining({ text: "Concurrent thread" })],
							}),
						],
					}));
					expect(plan.mcpUpdates).toHaveLength(1);
				}
			} finally {
				await Plan.close(reopened);
			}
		} finally {
			release.release();
			await updating;
			context.storage.collaboration.commit = commit;
			Rooms.forget(room);
			await Plan.close(context.plan);
		}
	});

	it("checks revisions after draining browser edits already admitted to the batch", async () => {
		let context = await openPlan("# Original\n");
		let room = attach(context);
		let { ws } = socket(context);
		let peer = await Room.restore(
			context.plan.document.epoch,
			Room.sync(context.plan.document),
			Plan.source(context.plan),
			[],
		);
		try {
			let changed = edit.replace(
				{ ...context.plan, document: peer, outlines: new Map() },
				0,
				"# Browser\n",
			);
			if (!changed.ok || !changed.mutation) throw new Error("browser edit was not prepared");
			let api = adapter(context, {
				serializeDocument: async (_id, action) => {
					Plan.submit(context.plan, ws, {
						kind: "plan:update",
						ts: 0,
						rid: "browser-edit",
						id: "browser-edit",
						epoch: peer.epoch,
						update: Buffer.from(changed.mutation!.update).toString("base64"),
					});
					return action();
				},
			});
			expect(await api.update!.update(caller, input(context), client)).toEqual({
				kind: "revision-conflict",
				revision: 1,
			});
			expect((await stored(context)).projected).toMatchObject({
				source: "# Browser\n",
				revision: 1,
			});
		} finally {
			peer.doc.destroy();
			Rooms.forget(room);
			await Plan.drain(context.plan);
			await Plan.close(context.plan);
		}
	});

	it("does not invalidate decision anchors or comment passages for a no-op full-source update", async () => {
		let context = await openPlan("# Original\n\nRetained paragraph.\n", {
			questions: [{
				id: "widget",
				status: "answered",
				definition: {
					questions: [{
						id: "question",
						header: "Keep",
						question: "What should stay?",
						multiple: false,
						options: [],
					}],
				},
			}],
		});
		let room = attach(context);
		try {
			let { ws } = socket(context);
			await Comments.start(context.plan, context.server, context.channel.id, ws, {
				kind: "comment:start",
				ts: 0,
				rid: "thread",
				blocks: [1],
				quote: "Retained paragraph.",
				offset: 0,
				length: 19,
				text: "Keep this passage",
			});
			expect(Questions.relate(context.plan, "widget", "question", [
				{ index: 1, digest: Room.digests(context.plan.document)[1]! },
			])).toBeUndefined();
			await Plan.persist(context.plan);
			let questions = Questions.anchors(context.plan), threads = Comments.anchors(context.plan);
			let history = Room.sync(context.plan.document), seq = context.plan.document.seq;
			let api = adapter(context);
			expect(
				await api.update!.update(
					caller,
					input(context, { plan: Plan.source(context.plan) }),
					client,
				),
			)
				.toMatchObject({ kind: "updated", document: { revision: 0 } });
			expect(Questions.anchors(context.plan)).toEqual(questions);
			expect(Comments.anchors(context.plan)).toEqual(threads);
			expect(Room.sync(context.plan.document)).toEqual(history);
			expect(context.plan.document.seq).toBe(seq);
			expect(context.broadcasts.some(frame => frame.kind === "plan:update")).toBe(false);
			let reopened = await Plan.open(context.channel.id, context.backend, context.server);
			try {
				expect(Questions.anchors(reopened)).toEqual(questions);
				expect(Comments.anchors(reopened)).toEqual(threads);
				expect(reopened.mcpUpdates).toHaveLength(1);
			} finally {
				await Plan.close(reopened);
			}
		} finally {
			Rooms.forget(room);
			await Plan.close(context.plan);
		}
	});

	it("rechecks deletion and uses newly renamed metadata inside the document lock", async () => {
		let context = await openPlan("# Original\n");
		await Plan.close(context.plan);
		let deleting = false;
		let api = adapter(context, {
			isChannelDeleting: () => deleting,
			serializeDocument: async (_id, action) => {
				deleting = true;
				return action();
			},
		});
		expect(await api.update!.update(caller, input(context), client)).toEqual({
			kind: "unavailable",
		});
		expect((await stored(context)).projected).toMatchObject({
			source: "# Original\n",
			revision: 0,
		});
		api = adapter(context, {
			serializeDocument: async (_id, action) => {
				await context.storage.channels.rename({
					id: context.channel.id,
					title: "Renamed",
					now: new Date(),
				});
				return action();
			},
		});
		expect(await api.update!.update(caller, input(context), client)).toMatchObject({
			kind: "updated",
			document: { title: "Renamed" },
		});
	});
});
