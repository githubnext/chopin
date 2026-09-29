import { expect, test } from "bun:test";

import { ActiveOwnerBindings } from "../agent/active-owner";
import { Admission } from "../auth/admission";
import { Sessions } from "../auth/session";
import * as Plan from "../plan/service";
import { MemoryStorage } from "../storage/memory/adapter";
import * as Chat from "./service";

import type { Server } from "bun";
import type { HostedAuth } from "../auth/routes";
import type { Config } from "../config";
import type { GitHub } from "../github/client";
import type { SocketData } from "../wire";

async function setup() {
	let now = new Date();
	let storage = new MemoryStorage();
	let user = { id: "U_ana", login: "ana", avatarUrl: "" };
	await storage.users.put({ ...user, now });
	let sessions = new Sessions(storage, false);
	let login = await sessions.issue(user.id, {
		accessToken: "browser-token",
		accessExpiresIn: 28_800,
		refreshToken: "refresh-token",
		refreshExpiresIn: 86_400,
	});
	let repository = { id: "R_score", owner: "octo-org", name: "score", defaultBranch: "main" };
	let github = {
		repositoryAccess: async () => ({
			...repository,
			permissions: { push: true, pull: true, admin: false },
		}),
	} as unknown as GitHub;
	let authConfig = {
		origin: "http://localhost:8795",
		appSlug: "test",
		clientId: "test",
		encryptionKey: new Uint8Array(32),
	};
	let auth: HostedAuth = {
		config: authConfig,
		github,
		storage,
		sessions,
		clock: () => new Date(),
		admission: new Admission(authConfig, github),
	};
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: repository.id,
		repositoryOwner: repository.owner,
		repositoryName: repository.name,
		title: "Document",
		createdBy: user.id,
		now,
	});
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let events: Array<{ kind: string; [key: string]: unknown }> = [];
	let server = {
		publish(_topic: string, message: string) {
			events.push(JSON.parse(message));
		},
	} as unknown as Server<SocketData>;
	let backend: Plan.Backend = {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	};
	let plan = await Plan.open(channel.id, backend, server);
	let owners = new ActiveOwnerBindings(auth);
	let context: Chat.Room = {
		chat: plan.chat,
		plan,
		room: channel.id,
		server,
		auth,
		repository,
		config: { agent: true } as Config,
		claimantSessionId: login.id,
		activeOwner: () => owners.resolve(channel.id),
		persist: () => Plan.persist(plan),
	};
	return {
		context,
		events,
		user,
		owners,
		storage,
		backend,
		async close() {
			owners.revokeAll();
			await Plan.close(plan);
		},
	};
}

test("an invoked instruction persists verbatim as a member message before publication and returns before the turn", async () => {
	let fixture = await setup();
	let { context, events, user } = fixture;
	let saved = Promise.withResolvers<void>();
	let persist = context.persist;
	context.persist = async () => {
		await saved.promise;
		await persist();
	};
	let finished = Promise.withResolvers<void>();
	let opened = Promise.withResolvers<void>();
	let seen: Array<{ checkout?: string; prompt: string }> = [];
	context.checkout = "/tmp/score";
	context.openPlannerSession = async (_owner, channel) => ({
		ok: true,
		value: {
			async stream(prompt) {
				seen.push({ checkout: channel.checkout, prompt });
				opened.resolve();
				return {
					fullStream: (async function*() {
						await finished.promise;
						yield { type: "finish" };
					})(),
				} as never;
			},
			destroy: async () => {},
		},
	});
	try {
		let posting = Chat.invoke(context, user, "  @chopin Plan this.\n");
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(events).toEqual([]);
		expect(seen).toEqual([]);
		saved.resolve();
		expect(await posting).toBeUndefined();
		await opened.promise;
		expect(context.chat.busy).toBe(true);
		expect(context.chat.entries[0]).toMatchObject({
			author: { kind: "member", handle: "ana" },
			text: "  @chopin Plan this.\n",
		});
		expect(events.some(event => event.kind === "chat:message")).toBe(true);
		expect(seen[0]?.checkout).toBe("/tmp/score");
		expect(seen[0]?.prompt).toBe("@ana:   @chopin Plan this.\n");
		finished.resolve();
		await context.chat.running;
		expect(context.chat.busy).toBe(false);
	} finally {
		saved.resolve();
		finished.resolve();
		await fixture.close();
	}
});

test("queued invocations retain their own checkout and durable message exactly once", async () => {
	let fixture = await setup();
	let { context, user } = fixture;
	let first = Promise.withResolvers<void>();
	let opened = Promise.withResolvers<void>();
	let checkouts: Array<string | undefined> = [];
	context.openPlannerSession = async (_owner, channel) => ({
		ok: true,
		value: {
			async stream() {
				checkouts.push(channel.checkout);
				opened.resolve();
				return {
					fullStream: (async function*() {
						await first.promise;
						yield { type: "finish" };
					})(),
				} as never;
			},
			destroy: async () => {},
		},
	});
	try {
		await Chat.invoke({ ...context, checkout: "/tmp/first" }, user, "First");
		await opened.promise;
		await Chat.invoke({ ...context, checkout: "/tmp/second" }, user, "Second");
		await Chat.invoke(context, user, "Second");
		expect(context.chat.waiting.map(item => item.text)).toEqual(["Second", "Second"]);
		expect(context.chat.entries.map(entry => entry.text)).toEqual(["First", "Second", "Second"]);
		expect(new Set(context.chat.entries.map(entry => entry.id)).size).toBe(3);
		expect(checkouts).toEqual(["/tmp/first"]);
		first.resolve();
		await context.chat.running;
		expect(checkouts).toEqual(["/tmp/first", "/tmp/second", undefined]);
		expect(context.chat.entries.map(entry => entry.text)).toEqual(["First", "Second", "Second"]);
		expect(context.chat.waiting).toEqual([]);
		expect(context.chat.busy).toBe(false);
		await fixture.close();
		let restored = await Plan.open(context.room, fixture.backend, context.server);
		expect(restored.chat.entries.map(entry => entry.text)).toEqual(["First", "Second", "Second"]);
		await Plan.close(restored);
	} finally {
		first.resolve();
		await fixture.close();
	}
});

test("failed persistence, unavailable Planner, full queue and another owner start no invoked turn", async () => {
	let fixture = await setup();
	let { context, user, events } = fixture;
	try {
		context.config.agent = false;
		expect(await Chat.invoke(context, user, "Review")).toBe("planner-unavailable");
		context.config.agent = true;
		context.chat.busy = true;
		context.chat.waiting = Array.from(
			{ length: 20 },
			(_, index) => ({ id: String(index), handle: "ana", text: "Waiting" }),
		);
		expect(await Chat.invoke(context, user, "Review")).toBe("planner-queue-full");
		context.chat.waiting = [];
		context.persist = async () => {
			throw new Error("storage failed");
		};
		await expect(Chat.invoke(context, user, "Review")).rejects.toThrow("storage failed");
		expect(context.chat.entries).toEqual([]);
		expect(events).toEqual([]);
		await fixture.storage.users.put({ id: "U_bob", login: "bob", avatarUrl: "", now: new Date() });
		let login = await context.auth.sessions.issue("U_bob", {
			accessToken: "bob-token",
			accessExpiresIn: 28_800,
			refreshToken: "refresh",
			refreshExpiresIn: 86_400,
		});
		expect(
			await Chat.invoke(
				{ ...context, claimantSessionId: login.id },
				{ id: "U_bob", login: "bob" },
				"Review",
			),
		).toBe("planner-owner-unavailable");
		expect(context.chat.waiting).toEqual([]);
		expect(context.chat.running).toBeUndefined();
	} finally {
		await fixture.close();
	}
});
