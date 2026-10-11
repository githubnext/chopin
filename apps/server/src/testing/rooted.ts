/**
 * A root document and one child sharing a store, with a hosted Planner owner.
 *
 * The root's Chat runs real turns over a harness stub that records each prompt
 * and holds the turn open until the test finishes it.
 */
import { ActiveOwnerBindings } from "../agent/active-owner";
import { Admission } from "../auth/admission";
import { Sessions } from "../auth/session";
import { createChildDocuments } from "../chat/children";
import { openPlannerSession } from "../harness/session";
import * as Service from "../plan/service";
import { MemoryStorage } from "../storage/memory/adapter";
import { checkpointSource } from "./plan";

import type { Server } from "bun";
import type { HostedAuth } from "../auth/routes";
import type * as Chat from "../chat/service";
import type { Config } from "../config";
import type { GitHub } from "../github/client";
import type { SocketData } from "../wire";

export type Frame = { kind: string; [key: string]: unknown };

/** The real session opener over a stub that records each turn's prompt and holds it open. */
export function observe(context: Chat.Room) {
	let prompts: string[] = [];
	let gate = Promise.withResolvers<unknown[]>();
	let opened = Promise.withResolvers<void>();
	context.openPlannerSession = (owner, channel) =>
		openPlannerSession(owner, channel, {
			githubTools: async () => ({ ok: true, value: {} }),
			createSandbox: async () => ({ destroy: async () => {} }) as never,
			registerCredential: () => () => {},
			agent: {
				createSession: async ({ sessionId }: { sessionId: string }) => ({
					sessionId,
					destroy: async () => {},
				}),
				stream: async (call: { prompt: string }) => {
					prompts.push(call.prompt);
					opened.resolve();
					let parts = await gate.promise;
					return {
						fullStream: (async function*() {
							yield* parts;
						})(),
					};
				},
			} as never,
		});
	return {
		prompts,
		/** Settles once the first turn has reached the model. */
		started: () => opened.promise,
		/** Lets every turn end after streaming `parts`. */
		finish: (parts: unknown[] = []) => gate.resolve(parts),
	};
}

export async function rooted(sources: { root: string; child: string }) {
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
	let fields = {
		repositoryId: repository.id,
		repositoryOwner: repository.owner,
		repositoryName: repository.name,
		createdBy: user.id,
		now,
	};
	let rootChannel = await storage.channels.create({
		...fields,
		id: crypto.randomUUID(),
		title: "Root",
	});
	let childChannel = await storage.channels.create({
		...fields,
		id: crypto.randomUUID(),
		title: "Source review",
		parentChannelId: rootChannel.id,
	});
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	await checkpointSource(storage, lease, rootChannel.id, sources.root);
	await checkpointSource(storage, lease, childChannel.id, sources.child);
	let backend: Service.Backend = {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	};
	let events: Array<{ topic: string; frame: Frame }> = [];
	let listeners: Array<(topic: string, frame: Frame) => void> = [];
	let server = {
		publish(topic: string, raw: string) {
			let frame = JSON.parse(raw) as Frame;
			events.push({ topic, frame });
			for (let listener of listeners) listener(topic, frame);
		},
	} as unknown as Server<SocketData>;
	let rootPlan = await Service.open(rootChannel.id, backend, server);
	let childPlan = await Service.open(childChannel.id, backend, server);
	let owners = new ActiveOwnerBindings(auth);
	let config = { agent: true } as Config;
	let rootContext: Chat.Room = {
		chat: rootPlan.chat,
		plan: rootPlan,
		room: rootChannel.id,
		server,
		auth,
		repository,
		config,
		claimantSessionId: login.id,
		activeOwner: () => owners.resolve(rootChannel.id),
		persist: chat => Service.persist(rootPlan, chat),
		children: createChildDocuments({
			rootId: rootChannel.id,
			repositoryId: repository.id,
			channels: storage.channels,
			server,
			withChildPlan: async (_id, action) => action(childPlan),
		}),
	};
	let turns = observe(rootContext);
	let childContext: Chat.Room = {
		chat: childPlan.chat,
		plan: childPlan,
		room: childChannel.id,
		server,
		auth,
		repository,
		config,
		claimantSessionId: login.id,
		persist: chat => Service.persist(childPlan, chat),
		rootChannelId: rootChannel.id,
	};
	return {
		storage,
		user,
		login,
		repository,
		server,
		events,
		/** Called with every broadcast as it is published. */
		listen: (listener: (topic: string, frame: Frame) => void) => listeners.push(listener),
		root: { channel: rootChannel, plan: rootPlan, context: rootContext },
		child: { channel: childChannel, plan: childPlan, context: childContext },
		turns,
		async close() {
			turns.finish();
			await rootPlan.chat.running;
			owners.revokeAll();
			await Service.close(rootPlan);
			await Service.close(childPlan);
		},
	};
}
