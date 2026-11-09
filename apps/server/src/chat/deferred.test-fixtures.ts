/**
 * A document's Chat as `main.ts` serves it in hosted mode, for tests of the requests kept as rows:
 * every durable piece is real and the Planner is a script.
 */
import { decideReplying } from "../conversation-plan/decisions.test-fixtures";
import { ActiveOwnerBindings } from "../agent/active-owner";
import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import * as Plan from "../plan/service";
import { MemoryStorage } from "../storage/memory/adapter";
import { deferralWiring } from "./deferred";
import * as Chat from "./service";

import type { Server } from "bun";
import type { HostedAuth } from "../auth/routes";
import type { Config } from "../config";
import type { GitHub } from "../github/client";
import type { DeferredTurn, Lease } from "../storage/model";
import type { StorageAdapter } from "../storage/port";
import type { Socket, SocketData } from "../wire";

export const tick = () => new Promise(resolve => setTimeout(resolve, 0));
/**
 * Waits for a condition for a time, not a count of event-loop turns: a turn that saves to
 * PostgreSQL waits on round trips and commits while the loop turns idly, so a count says how fast
 * the loop spun, not whether the database was given long enough. The time ends before bun's 5 s
 * limit on a test, so a condition that never holds is named instead of the test timing out.
 */
export const waitFor = async (
	condition: () => boolean | Promise<boolean>,
	what = "a condition",
) => {
	let deadline = Date.now() + 4_000;
	while (!await condition()) {
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await tick();
	}
};

export let cleanups: Array<() => Promise<void> | void> = [];

function grant(accessToken: string) {
	return {
		accessToken,
		accessExpiresIn: 28_800,
		refreshToken: "refresh-token",
		refreshExpiresIn: 86_400,
	};
}

export const REPOSITORY = {
	id: "R_score",
	owner: "octo-org",
	name: "score",
	defaultBranch: "main",
};

/**
 * A document's Chat as `main.ts` serves it in hosted mode, with every durable piece real (memory
 * storage, a plan that commits through the writer lease) and the Planner a script: it records the
 * prompts it is given, and can be told to hold a turn until released.
 */
export async function world(
	options: {
		away?: boolean;
		/** A machine's Planner that is starting and does not arrive until this settles. */
		starting?: Promise<void>;
		/** A database to use in place of memory, and how to open it again for the next process. */
		storage?: StorageAdapter;
		reopen?: () => Promise<StorageAdapter>;
		lease?: string;
		/** The server's own configuration, as `main.ts` loads it, in place of a hosted one. */
		config?: Config;
	} = {},
) {
	// Only a document whose Planner runs on a machine has one to be away; `away` says it does.
	let remote = options.away !== undefined;
	let now = new Date();
	let storage: StorageAdapter = options.storage ?? new MemoryStorage();
	let ana = { id: "U_ana", login: "ana", avatarUrl: "" };
	let bob = { id: "U_bob", login: "bob", avatarUrl: "" };
	for (let person of [ana, bob]) await storage.users.put({ ...person, now });
	let writable = true;
	let github = {
		repositoryAccess: async () => ({
			...REPOSITORY,
			permissions: { push: writable, pull: true, admin: false },
		}),
	} as unknown as GitHub;
	let authConfig = {
		origin: "http://localhost:8795",
		appSlug: "test",
		clientId: "test",
		encryptionKey: new Uint8Array(32),
	};
	let auth: HostedAuth;
	let sign = (sessions: Sessions) => {
		auth = {
			config: authConfig,
			github,
			storage,
			sessions,
			clock: () => new Date(),
			admission: new Admission(authConfig, github),
			machines: new Machines(storage, () => new Date(), {
				origin: "https://chopin.test",
				clientId: "test",
			}),
			pairings: {},
		};
	};
	let sessions = new Sessions(storage, false);
	sign(sessions);
	let logins = {
		ana: await sessions.issue(ana.id, grant("ana-token")),
		bob: await sessions.issue(bob.id, grant("bob-token")),
	};
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: REPOSITORY.id,
		repositoryOwner: REPOSITORY.owner,
		repositoryName: REPOSITORY.name,
		title: "Document",
		createdBy: ana.id,
		now,
	});
	let leaseName = options.lease ?? "chopin:writer";
	let lease: Lease = (await storage.leases.acquire(leaseName, "first", 600_000))!;
	let events: Array<{ kind: string; [key: string]: unknown }> = [];
	let server = {
		publish(_topic: string, message: string) {
			events.push(JSON.parse(message));
		},
	} as unknown as Server<SocketData>;

	// The Planner: records each prompt, and holds a turn while `holding` is set.
	let prompts: string[] = [];
	let gates: PromiseWithResolvers<void>[] = [];
	let holding = false;
	let failing = 0;
	let opens = 0;
	let planner = {
		prompts,
		hold(value = true) {
			holding = value;
		},
		/** The machine's next `count` attempts to open a session fail, as a dropped link's do. */
		failOpens(count: number) {
			failing = count;
		},
		get opens() {
			return opens;
		},
		release() {
			gates.shift()?.resolve();
		},
		get running() {
			return gates.length;
		},
	};
	let session = {
		async stream(prompt: string, signal?: AbortSignal) {
			prompts.push(prompt);
			let gate = holding ? Promise.withResolvers<void>() : undefined;
			if (gate) gates.push(gate);
			return {
				fullStream: (async function*() {
					if (gate) {
						// Ends when released, and, as a real session does, when it is cut off.
						await new Promise<void>(resolve => {
							void gate.promise.then(resolve);
							signal?.addEventListener("abort", () => resolve());
						});
					}
					yield { type: "text-start", id: "reply" };
					yield { type: "text-delta", id: "reply", text: `answer ${prompts.length}` };
					yield { type: "text-end", id: "reply" };
				})(),
			} as never;
		},
		async destroy() {},
	};

	let attached = !options.away;
	// While set, asking whether the machine is there waits, as a slow check of it does.
	let asking: Promise<void> | undefined;
	let owners: ActiveOwnerBindings;
	let open = async () => {
		let backend: Plan.Backend = {
			storage,
			lease: () => lease,
			fatal: error => {
				throw error;
			},
		};
		let plan = await Plan.open(channel.id, backend, server);
		owners = new ActiveOwnerBindings(auth);
		let context: Chat.Room = {
			chat: plan.chat,
			plan,
			room: channel.id,
			server,
			auth,
			repository: REPOSITORY,
			config: options.config ?? ({ agent: true } as Config),
			claimantSessionId: logins.ana.id,
			decide: decideReplying({ input: { type: "noul", noul: 0 } }),
			activeOwner: () => owners.resolve(channel.id),
			persist: (chat, deferred) => Plan.persistDeferred(plan, chat, deferred),
			// What `main.ts` hands a document's Chat, from the same function, for the same configuration.
			...deferralWiring(
				options.config ?? { auth: {}, harness: "copilot-sdk" },
				{
					// No extra step unless the check is slow: the order of what is asked is part of the tests.
					plannerReady: remote
						? () => asking ? asking.then(() => attached) : Promise.resolve(attached)
						: undefined,
				},
			),
			...(options.starting ? { plannerStarting: () => options.starting! } : {}),
			openPlannerSession: async () => {
				opens++;
				if (failing > 0) {
					failing--;
					return { ok: false, error: { kind: "unavailable" } } as never;
				}
				return { ok: true, value: session as never };
			},
		};
		return context;
	};
	let current = await open();
	let live = { context: current };
	let socket = (who: "ana" | "bob" = "ana") => {
		let person = who === "ana" ? ana : bob;
		let frames: Array<{ kind: string; rid?: string; [key: string]: unknown }> = [];
		let ws = {
			data: { handle: person.login, principalId: person.id, sessionId: logins[who].id },
			send(text: string) {
				frames.push(JSON.parse(text));
			},
		} as unknown as Socket;
		return { ws, frames };
	};
	let senders = new Map<string, ReturnType<typeof socket>>();
	let send = async (
		text: string,
		who: "ana" | "bob" = "ana",
		extra: { requestId?: string; focus?: string } = {},
	) => {
		let sender = senders.get(who) ?? socket(who);
		senders.set(who, sender);
		let rid = crypto.randomUUID();
		await Chat.send(
			{ ...live.context, claimantSessionId: logins[who].id },
			sender.ws,
			{
				kind: "chat:send",
				rid,
				requestId: extra.requestId ?? crypto.randomUUID(),
				to: "planner",
				text,
				...(extra.focus ? { focus: extra.focus } : {}),
				ts: 0,
			} as never,
		);
		return sender.frames.find(frame => frame.rid === rid)!;
	};
	let rows = (states?: DeferredTurn["state"][]) => storage.deferredTurns.list(channel.id, states);
	let world = {
		get storage() {
			return storage;
		},
		channel,
		events,
		prompts,
		planner,
		ana,
		bob,
		get logins() {
			return logins;
		},
		get context() {
			return live.context;
		},
		get lease() {
			return lease;
		},
		get sessions() {
			return auth.sessions;
		},
		get github() {
			return writable;
		},
		set writable(value: boolean) {
			writable = value;
		},
		send,
		socket,
		rows,
		/** The machine comes back, as `main.ts` learns of it. */
		attach: async () => {
			attached = true;
			await Chat.kick(live.context);
		},
		away: () => {
			attached = false;
		},
		/** Makes the check of whether the machine is there wait; the returned function ends it. */
		slowCheck: () => {
			let gate = Promise.withResolvers<void>();
			asking = gate.promise;
			return () => {
				asking = undefined;
				gate.resolve();
			};
		},
		/** The first process ends, and a second takes over with the same database. */
		restart: async (alive = true) => {
			// As a stopping process does: no turn starts while the running one is cut off.
			Chat.holdStarts();
			owners.revokeAll();
			await Chat.close(live.context.chat);
			Chat.holdStarts(false);
			await Plan.close(live.context.plan);
			await storage.leases.release(lease);
			if (options.reopen) {
				storage = await options.reopen();
				sign(sessions);
			}
			lease = (await storage.leases.acquire(leaseName, crypto.randomUUID(), 600_000))!;
			if (!alive) {
				sessions = new Sessions(storage, false);
				sign(sessions);
				logins = {
					ana: logins.ana,
					bob: await sessions.issue(bob.id, grant("bob-token-2")),
				};
			}
			live.context = await open();
			senders.clear();
			return live.context;
		},
		/** Waits for the Planner to have been given this many prompts and the turns to settle. */
		turns: async (count: number) => {
			await waitFor(() => prompts.length >= count, `${count} prompts`);
			await waitFor(() => !live.context.chat.busy && !live.context.chat.running, "idle");
		},
		texts: () => live.context.chat.entries.map(entry => entry.text),
	};
	cleanups.push(async () => {
		owners.revokeAll();
		await Chat.close(live.context.chat).catch(() => {});
		await Plan.close(live.context.plan).catch(() => {});
	});
	return world;
}

export const memberEntry = (context: Chat.Room, text: string) =>
	context.chat.entries.find(entry => entry.author.kind === "member" && entry.text === text);
