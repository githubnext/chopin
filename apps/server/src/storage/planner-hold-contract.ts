import { describe, expect, test } from "bun:test";

import { contractId as id, openedStorage, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";
import { machine } from "./machine-contract";

import type { StorageFactory } from "./contract-support";
import type { PlannerLinkHold } from "./model";
import type { StorageAdapter } from "./port";

const AT = new Date("2026-01-03T03:04:05.000Z");

function later(seconds: number): Date {
	return new Date(AT.getTime() + seconds * 1_000);
}

async function login(storage: StorageAdapter, userId: string, expiresAt = later(3_600)) {
	let sessionId = id("login");
	await storage.sessions.create({
		id: sessionId,
		userId,
		createdAt: AT,
		expiresAt,
		credentials: {
			secretHash: new Uint8Array(32).fill(1),
			ciphertext: new Uint8Array(64).fill(2),
			revision: 1,
		},
	});
	return sessionId;
}

async function document(storage: StorageAdapter, userId: string) {
	let channelId = id("channel");
	await storage.channels.create({
		id: channelId,
		repositoryId: id("repository"),
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Held document",
		createdBy: userId,
		now: AT,
	});
	return channelId;
}

function hold(
	channelId: string,
	userId: string,
	ownerSessionId: string,
	overrides: Partial<PlannerLinkHold> = {},
): PlannerLinkHold {
	return {
		channelId,
		userId,
		login: "octocat",
		ownerSessionId,
		generation: 1,
		sessions: [],
		suspendedAt: AT,
		...overrides,
	};
}

async function failure(attempt: Promise<unknown>) {
	let error = await attempt.then(() => undefined, err => err);
	expect(error).toBeInstanceOf(StorageError);
	return (error as StorageError).failure;
}

export function plannerHoldContract(name: string, factory: StorageFactory) {
	describe(`${name} persisted remote Planner holds`, () => {
		test("keeps a document's hold with its held sessions, and replaces it whole", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let sessionId = await login(storage, userId);
				let first = hold(channelId, userId, sessionId, {
					sessions: [{
						id: "session-1",
						waiting: ["request-1", "request-2"],
						asked: [{ request: "request-2", method: "questionnaire", decisions: ["d-1", "d-2"] }],
						owed: [{ request: "request-1", answer: { choice: "a" } }],
						stops: [{ run: "run-1" }, { run: null }],
					}, { id: "session-2", waiting: [], owed: [], stops: [] }],
				});
				expect(await storage.plannerHolds.get(channelId)).toBeUndefined();
				await storage.plannerHolds.put(lease, first);
				expect(await storage.plannerHolds.get(channelId)).toEqual({
					...first,
					fencing: lease.fencing,
				});
				let found = (await storage.plannerHolds.get(channelId))!;
				found.sessions[0]!.waiting.push("changed");
				found.sessions[0]!.asked![0]!.decisions.push("changed");
				found.suspendedAt.setTime(0);
				expect(await storage.plannerHolds.get(channelId)).toEqual({
					...first,
					fencing: lease.fencing,
				});

				let window = later(10);
				let second = hold(channelId, userId, sessionId, {
					generation: 3,
					login: "mona",
					suspendedAt: later(5),
					handoverUntil: window,
				});
				await storage.plannerHolds.put(lease, second);
				expect(await storage.plannerHolds.get(channelId)).toEqual({
					...second,
					fencing: lease.fencing,
				});
				expect(
					await storage.plannerHolds.list().then(all =>
						all.filter(value => value.channelId === channelId)
					),
				).toHaveLength(1);
			} finally {
				await storage.close();
			}
		});

		test("names the paired machine that holds the document, with no login of its own", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let sessionId = await login(storage, userId);
				let paired = machine(userId, { label: "laptop" });
				await storage.machines.create(paired);
				let { ownerSessionId: _, ...base } = hold(channelId, userId, sessionId);
				let input: PlannerLinkHold = { ...base, machineId: paired.id, machine: "laptop" };
				await storage.plannerHolds.put(lease, input);
				expect(await storage.plannerHolds.get(channelId)).toEqual({
					...input,
					fencing: lease.fencing,
				});
				expect(
					await failure(storage.plannerHolds.put(lease, {
						...input,
						machineId: id("nobody"),
					})),
				).toBe("missing");
				// Neither a machine with a login nor a browser hold with none is a hold.
				expect(
					await failure(storage.plannerHolds.put(lease, { ...input, ownerSessionId: sessionId })),
				).toBe("conflict");
				expect(
					await failure(
						storage.plannerHolds.put(lease, hold(channelId, userId, undefined as never)),
					),
				).toBe("conflict");
				expect(await storage.plannerHolds.get(channelId)).toEqual({
					...input,
					fencing: lease.fencing,
				});
			} finally {
				await storage.close();
			}
		});

		test("outlasts a machine's login, which no restart keeps", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let paired = machine(userId, { label: "laptop" });
				await storage.machines.create(paired);
				let { ownerSessionId: _, ...base } = hold(channelId, userId, "");
				let input: PlannerLinkHold = { ...base, machineId: paired.id, machine: "laptop" };
				await storage.plannerHolds.put(lease, input);
				await storage.sessions.reset(AT, lease, 30_000);
				expect(await storage.plannerHolds.get(channelId)).toBeDefined();
			} finally {
				await storage.close();
			}
		});

		test("lists every hold by document id", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, lease } = await userAndChannel(storage);
				let sessionId = await login(storage, userId);
				let documents = [
					await document(storage, userId),
					await document(storage, userId),
					await document(storage, userId),
				];
				for (let channelId of documents) {
					await storage.plannerHolds.put(lease, hold(channelId, userId, sessionId));
				}
				let listed = (await storage.plannerHolds.list()).map(value => value.channelId);
				expect(listed.filter(channelId => documents.includes(channelId))).toEqual(
					[...documents].sort(),
				);
			} finally {
				await storage.close();
			}
		});

		test("refuses a missing document, person or login", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let sessionId = await login(storage, userId);
				let input = hold(channelId, userId, sessionId);
				expect(await failure(storage.plannerHolds.put(lease, { ...input, channelId: id("none") })))
					.toBe("missing");
				expect(await failure(storage.plannerHolds.put(lease, { ...input, userId: id("none") })))
					.toBe("missing");
				expect(
					await failure(
						storage.plannerHolds.put(lease, { ...input, ownerSessionId: id("none") }),
					),
				).toBe("missing");
				expect(await storage.plannerHolds.get(channelId)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("is written and removed only under the writer lease", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, channelId, lease } = await userAndChannel(storage);
				let sessionId = await login(storage, userId);
				let input = hold(channelId, userId, sessionId);
				let stale = { ...lease, fencing: lease.fencing + 1 };
				expect(await failure(storage.plannerHolds.put(stale, input))).toBe("conflict");
				expect(await storage.plannerHolds.get(channelId)).toBeUndefined();

				await storage.plannerHolds.put(lease, input);
				expect(await failure(storage.plannerHolds.delete(stale, channelId))).toBe("conflict");
				expect(await storage.plannerHolds.get(channelId)).toBeDefined();
				expect(await storage.plannerHolds.delete(lease, channelId)).toBe(true);
				expect(await storage.plannerHolds.delete(lease, channelId)).toBe(false);
				expect(await storage.plannerHolds.get(channelId)).toBeUndefined();

				await storage.leases.release(lease);
				expect(await failure(storage.plannerHolds.put(lease, input))).toBe("conflict");
			} finally {
				await storage.close();
			}
		});

		test("goes with its owner's login and with its document", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, lease } = await userAndChannel(storage);
				let signedOut = await login(storage, userId);
				let expired = await login(storage, userId, later(60));
				let kept = await login(storage, userId);
				let [a, b, c, d] = [
					await document(storage, userId),
					await document(storage, userId),
					await document(storage, userId),
					await document(storage, userId),
				] as [string, string, string, string];
				await storage.plannerHolds.put(lease, hold(a, userId, signedOut));
				await storage.plannerHolds.put(lease, hold(b, userId, expired));
				await storage.plannerHolds.put(lease, hold(c, userId, kept));
				await storage.plannerHolds.put(lease, hold(d, userId, kept));

				expect(await storage.sessions.delete(signedOut)).toBe(true);
				expect(await storage.plannerHolds.get(a)).toBeUndefined();
				await storage.sessions.deleteExpired(later(120));
				expect(await storage.plannerHolds.get(b)).toBeUndefined();
				expect(await storage.plannerHolds.get(c)).toBeDefined();

				await storage.channels.archive({ id: c, now: AT });
				expect(await storage.channels.delete(c)).toBe(true);
				expect(await storage.plannerHolds.get(c)).toBeUndefined();
				expect(await storage.plannerHolds.get(d)).toBeDefined();
			} finally {
				await storage.close();
			}
		});
	});

	describe(`${name} startup reset with persisted Planner holds`, () => {
		test("keeps the owner of a document whose hold names a login the reset keeps", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, lease } = await userAndChannel(storage);
				let sessionId = await login(storage, userId);
				let held = await document(storage, userId);
				let unheld = await document(storage, userId);
				let claimed = await storage.channels.claimAgentOwner(held, sessionId, AT);
				await storage.channels.claimAgentOwner(unheld, sessionId, AT);
				await storage.channels.updateAgentContext({
					channelId: held,
					ownerSessionId: sessionId,
					generation: claimed.generation,
					summary: "kept summary",
					transcriptCursor: 4,
					status: "ready",
					now: AT,
				});
				await storage.plannerHolds.put(
					lease,
					hold(held, userId, sessionId, {
						generation: claimed.generation,
						handoverUntil: later(10),
					}),
				);

				let reset = await storage.sessions.reset(AT, lease, 60_000);
				expect(reset.lease.fencing).toBe(lease.fencing);

				let kept = (await storage.collaboration.load(held, AT))!.agent!;
				expect(kept).toMatchObject({
					ownerSessionId: sessionId,
					generation: claimed.generation,
					summary: "kept summary",
					transcriptCursor: 4,
					status: "ready",
				});
				let cleared = (await storage.collaboration.load(unheld, AT))!.agent!;
				expect(cleared.ownerSessionId).toBeUndefined();
				expect(cleared.status).toBe("unavailable");
				expect(await storage.sessions.get(sessionId, AT)).toBeDefined();
				expect(await storage.plannerHolds.get(held)).toMatchObject({ ownerSessionId: sessionId });
			} finally {
				await storage.close();
			}
		});

		test("still clears an owner whose login the reset removes, and the hold with it", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, lease } = await userAndChannel(storage);
				let expired = await login(storage, userId, later(60));
				let metadataOnly = id("metadata-only");
				await storage.sessions.create({
					id: metadataOnly,
					userId,
					createdAt: AT,
					expiresAt: later(3_600),
				});
				let a = await document(storage, userId);
				let b = await document(storage, userId);
				await storage.channels.claimAgentOwner(a, expired, AT);
				await storage.channels.claimAgentOwner(b, metadataOnly, AT);
				await storage.plannerHolds.put(lease, hold(a, userId, expired));
				await storage.sessions.reset(later(120), lease, 60_000);
				for (let channelId of [a, b]) {
					let agent = (await storage.collaboration.load(channelId, later(120)))!.agent!;
					expect(agent.ownerSessionId).toBeUndefined();
					expect(agent.status).toBe("unavailable");
				}
				expect(await storage.plannerHolds.get(a)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("clears an owner that is not the login the hold names", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, lease } = await userAndChannel(storage);
				let owner = await login(storage, userId);
				let other = await login(storage, userId);
				let channelId = await document(storage, userId);
				await storage.channels.claimAgentOwner(channelId, owner, AT);
				await storage.plannerHolds.put(lease, hold(channelId, userId, other));
				await storage.sessions.reset(AT, lease, 60_000);
				let agent = (await storage.collaboration.load(channelId, AT))!.agent!;
				expect(agent.ownerSessionId).toBeUndefined();
				expect(agent.status).toBe("unavailable");
			} finally {
				await storage.close();
			}
		});

		test("refuses a reset under a lease that is not held, leaving owners and holds alone", async () => {
			let storage = await openedStorage(factory);
			try {
				let { userId, lease } = await userAndChannel(storage);
				let stale = { ...lease, fencing: lease.fencing + 1 };
				let sessionId = await login(storage, userId);
				let channelId = await document(storage, userId);
				await storage.channels.claimAgentOwner(channelId, sessionId, AT);
				await storage.plannerHolds.put(lease, hold(channelId, userId, sessionId));
				expect(await failure(storage.sessions.reset(AT, stale, 60_000))).toBe("conflict");
				expect((await storage.collaboration.load(channelId, AT))!.agent!.ownerSessionId).toBe(
					sessionId,
				);
				expect(await storage.plannerHolds.get(channelId)).toBeDefined();
			} finally {
				await storage.close();
			}
		});
	});
}
