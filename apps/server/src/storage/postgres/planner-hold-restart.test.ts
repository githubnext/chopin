import { describe, expect, it } from "bun:test";

import { Sessions } from "../../auth/session";
import { PlannerAttachments } from "../../harness/remote/attachments";
import { contractId } from "../contract-support";
import { PostgresStorage } from "./adapter";

import type { PlannerAttachment, PlannerAttachmentOptions } from "../../harness/remote/attachments";

let url = process.env.TEST_DATABASE_URL;

async function until(check: () => boolean, ms = 3_000) {
	for (let deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(5)) {
		if (check()) return;
	}
	throw new Error("the condition did not hold in time");
}

if (url) {
	describe("PostgreSQL remote Planner hand-over", () => {
		it("rebuilds a hold the cut wrote in the next process, keeping its owner through the startup reset, shown as attached through its window and disconnected after it", async () => {
			let first = new PostgresStorage(url);
			await first.migrate();
			let name = `chopin:test-holds-${crypto.randomUUID()}`;
			let userId = contractId("hold-owner");
			let sessionId = contractId("hold-login");
			let channelId = contractId("hold-channel");
			let now = new Date();
			await first.users.put({ id: userId, login: "mona", avatarUrl: "", now });
			await first.sessions.create({
				id: sessionId,
				userId,
				createdAt: now,
				expiresAt: new Date(now.getTime() + 3_600_000),
				credentials: {
					secretHash: new Uint8Array(32).fill(1),
					ciphertext: new Uint8Array(64).fill(2),
					revision: 1,
				},
			});
			await first.channels.create({
				id: channelId,
				repositoryId: contractId("hold-repository"),
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Held",
				createdBy: userId,
				now,
			});
			let owner = await first.channels.claimAgentOwner(channelId, sessionId, now);
			let leaseA = (await first.leases.acquire(name, "first", 60_000))!;
			// What the first process's cut persists for a link that was live, with a run under way.
			await first.plannerHolds.put(leaseA, {
				channelId,
				userId,
				login: "mona",
				ownerSessionId: sessionId,
				generation: owner.generation,
				sessions: [{
					id: "session-1",
					waiting: ["ask-1"],
					asked: [{ request: "ask-1", method: "confirm", decisions: ["decision-1"] }],
					owed: [{ type: "input-result", request: "ask-1", status: "answered", value: true }],
					stops: [{ run: null }],
				}],
				suspendedAt: now,
				handoverUntil: new Date(Date.now() + 400),
			});
			await first.leases.release(leaseA);
			await first.close();

			let second = new PostgresStorage(url);
			try {
				let leaseB = (await second.leases.acquire(name, "second", 60_000))!;
				await second.sessions.reset(new Date(), leaseB, 60_000);
				// The reset keeps what a hold in storage still names.
				expect((await second.channels.readAgent(channelId, new Date()))?.agent?.ownerSessionId)
					.toBe(sessionId);

				let sessions = new Sessions(second, false);
				let seen: PlannerAttachment[] = [];
				let missed: string[] = [];
				let attachments = new PlannerAttachments(
					{
						config: { origin: "https://chopin.test" },
						storage: second,
						sessions,
						clock: () => new Date(),
					} as never,
					60_000,
					{
						missed: (id, cause) => {
							if (id === channelId) missed.push(cause);
						},
					},
				);
				try {
					attachments.onChange((id, status) => {
						if (id === channelId) seen.push(status);
					});
					await attachments.restore(await second.plannerHolds.list());
					expect(attachments.status(channelId)).toEqual({ state: "attached", login: "mona" });
					expect(attachments.holding(channelId)).toMatchObject({
						attached: true,
						disconnected: false,
					});
					expect(attachments.attached(channelId)).toBe(false);
					expect(attachments.restoredWork(channelId)).toBe("live");
					expect(seen).toEqual([]);

					// Nobody resumes: the window ends, the Planner is disconnected, and the miss is named.
					await until(() => seen.length > 0);
					expect(seen).toEqual([{ state: "disconnected", login: "mona" }]);
					expect(missed).toEqual(["login"]);
					expect(attachments.restoredWork(channelId)).toBe("down");
					// Its row stays for a client that returns later: no deadline ends it.
					expect(await second.plannerHolds.get(channelId)).toMatchObject({
						sessions: [{
							id: "session-1",
							waiting: ["ask-1"],
							asked: [{ request: "ask-1", method: "confirm", decisions: ["decision-1"] }],
						}],
					});
				} finally {
					attachments.close();
				}
			} finally {
				await second.close();
			}
		});

		it("keeps a machine's hold, which names no login, through the reset that removes the machine's login, and rebuilds it", async () => {
			let first = new PostgresStorage(url);
			await first.migrate();
			let name = `chopin:test-machine-holds-${crypto.randomUUID()}`;
			let userId = contractId("machine-hold-owner");
			let channelId = contractId("machine-hold-channel");
			let now = new Date();
			await first.users.put({ id: userId, login: "mona", avatarUrl: "", now });
			await first.channels.create({
				id: channelId,
				repositoryId: contractId("machine-hold-repository"),
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Held",
				createdBy: userId,
				now,
			});
			let machineId = contractId("machine");
			await first.machines.create({
				id: machineId,
				userId,
				label: "laptop",
				tokenHash: crypto.getRandomValues(new Uint8Array(32)),
				repositories: [],
				autoRun: false,
				createdAt: now,
				lastSeenAt: now,
				revision: 1,
			} as never);
			// The machine's delegated login: no credentials, so the startup reset deletes it.
			let delegated = contractId("machine-login");
			await first.sessions.create({
				id: delegated,
				userId,
				createdAt: now,
				expiresAt: new Date(now.getTime() + 3_600_000),
			});
			await first.channels.claimAgentOwner(channelId, delegated, now);
			let leaseA = (await first.leases.acquire(name, "first", 60_000))!;
			await first.plannerHolds.put(leaseA, {
				channelId,
				userId,
				login: "mona",
				machineId,
				machine: "laptop",
				generation: 1,
				sessions: [],
				suspendedAt: now,
				handoverUntil: new Date(Date.now() + 60_000),
			});
			await first.leases.release(leaseA);
			await first.close();

			let second = new PostgresStorage(url);
			try {
				let leaseB = (await second.leases.acquire(name, "second", 60_000))!;
				await second.sessions.reset(new Date(), leaseB, 60_000);
				expect((await second.channels.readAgent(channelId, new Date()))?.agent?.ownerSessionId)
					.toBeUndefined();
				let hold = await second.plannerHolds.get(channelId);
				expect(hold).toMatchObject({ machineId, machine: "laptop" });
				expect(hold?.ownerSessionId).toBeUndefined();

				let attachments = new PlannerAttachments(
					{
						config: { origin: "https://chopin.test" },
						storage: second,
						sessions: new Sessions(second, false),
						clock: () => new Date(),
					} as never,
					60_000,
				);
				try {
					await attachments.restore(await second.plannerHolds.list());
					expect(attachments.status(channelId)).toEqual({ state: "attached", login: "mona" });
				} finally {
					attachments.close();
				}
			} finally {
				await second.close();
			}
		});

		it("gives the window to the process that rebuilds the hold and rewrites its row without it, so a process that starts after that one crashed finds the hold disconnected", async () => {
			let first = new PostgresStorage(url);
			await first.migrate();
			let name = `chopin:test-window-once-${crypto.randomUUID()}`;
			let userId = contractId("window-owner");
			let sessionId = contractId("window-login");
			let channelId = contractId("window-channel");
			let now = new Date();
			await first.users.put({ id: userId, login: "mona", avatarUrl: "", now });
			await first.sessions.create({
				id: sessionId,
				userId,
				createdAt: now,
				expiresAt: new Date(now.getTime() + 3_600_000),
				credentials: {
					secretHash: new Uint8Array(32).fill(1),
					ciphertext: new Uint8Array(64).fill(2),
					revision: 1,
				},
			});
			await first.channels.create({
				id: channelId,
				repositoryId: contractId("window-repository"),
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Held",
				createdBy: userId,
				now,
			});
			let owner = await first.channels.claimAgentOwner(channelId, sessionId, now);
			let leaseA = (await first.leases.acquire(name, "first", 60_000))!;
			await first.plannerHolds.put(leaseA, {
				channelId,
				userId,
				login: "mona",
				ownerSessionId: sessionId,
				generation: owner.generation,
				sessions: [{ id: "session-1", waiting: ["ask-1"], owed: [], stops: [], asked: [] }],
				suspendedAt: now,
				handoverUntil: new Date(now.getTime() + 60_000),
			});
			await first.leases.release(leaseA);
			await first.close();

			let second = new PostgresStorage(url);
			try {
				let leaseB = (await second.leases.acquire(name, "second", 60_000))!;
				await second.sessions.reset(new Date(), leaseB, 60_000);
				let attach = (store?: PlannerAttachmentOptions["store"]) =>
					new PlannerAttachments(
						{
							config: { origin: "https://chopin.test" },
							storage: second,
							sessions: new Sessions(second, false),
							clock: () => new Date(),
						} as never,
						60_000,
						store ? { store } : {},
					);
				let rebuilt = attach({
					put: hold => second.plannerHolds.put(leaseB, hold),
					delete: async id => void await second.plannerHolds.delete(leaseB, id),
				});
				// A process that starts after the first crashed, never having cut.
				let later = attach();
				try {
					await rebuilt.restore(await second.plannerHolds.list());
					expect(rebuilt.status(channelId)).toEqual({ state: "attached", login: "mona" });
					let kept = await second.plannerHolds.get(channelId);
					expect(kept?.handoverUntil).toBeUndefined();
					expect(kept?.sessions.map(session => session.id)).toEqual(["session-1"]);

					await later.restore(await second.plannerHolds.list());
					expect(later.status(channelId)).toEqual({ state: "disconnected", login: "mona" });
					expect(later.restoredWork(channelId)).toBe("down");
				} finally {
					rebuilt.close();
					later.close();
				}
			} finally {
				await second.close();
			}
		});
	});
}
