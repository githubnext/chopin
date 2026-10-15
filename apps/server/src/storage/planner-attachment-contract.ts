import { describe, expect, test } from "bun:test";

import { Sessions } from "../auth/session";
import { PlannerAttachments } from "../harness/remote/attachments";
import { contractId as id, openedStorage } from "./contract-support";

import type { AttachmentAuth } from "../harness/remote/attachments";
import type { AgentLink } from "../harness/remote/link";
import type { StorageFactory } from "./contract-support";
import type { StorageAdapter } from "./port";

const GRANT = { accessExpiresIn: 28_800, refreshToken: "refresh", refreshExpiresIn: 86_400 };

async function attachable(storage: StorageAdapter) {
	let now = new Date();
	let member = { id: id("member"), login: "member" };
	let rival = { id: id("rival"), login: "rival" };
	for (let user of [member, rival]) await storage.users.put({ ...user, avatarUrl: "", now });
	let channelId = id("channel");
	let repository = { id: id("repository"), owner: "octo-org", name: "score" };
	await storage.channels.create({
		id: channelId,
		repositoryId: repository.id,
		repositoryOwner: repository.owner,
		repositoryName: repository.name,
		title: "Attached document",
		createdBy: member.id,
		now,
	});
	let skew = { ms: 0 };
	let clock = () => new Date(Date.now() + skew.ms);
	let sessions = new Sessions(storage, false, clock);
	let signIn = async (user: { id: string }) =>
		(await sessions.issue(user.id, { ...GRANT, accessToken: `${user.id}-login` })).id;
	let logins = { member: await signIn(member), rival: await signIn(rival) };
	let auth: AttachmentAuth = {
		config: { origin: "https://chopin.test" },
		storage,
		sessions,
		clock,
		admission: { allowed: async () => true },
		github: {
			repositoryAccess: async () => ({
				...repository,
				fullName: "octo-org/score",
				private: true,
				url: "https://github.test/octo-org/score",
				defaultBranch: "main",
				permissions: { pull: true, push: true, admin: false },
			}),
		},
	};
	let owner = async () => (await storage.channels.readAgent(channelId, new Date()))?.agent;
	let request = (user: { id: string; login: string }) => ({ channelId, repository, user });
	return { auth, sessions, member, rival, logins, channelId, owner, request, skew };
}

function link(): AgentLink {
	return {} as AgentLink;
}

function revocable() {
	let refusals: { code: string; message: string }[] = [];
	let revocable = { revoke: (code: string, message: string) => refusals.push({ code, message }) };
	return { link: revocable as unknown as AgentLink, refusals };
}

async function released(owner: () => Promise<{ ownerSessionId?: string } | undefined>) {
	for (let deadline = Date.now() + 3_000; Date.now() < deadline;) {
		if (!(await owner())?.ownerSessionId) return;
		await Bun.sleep(10);
	}
}

/** Remote Planner attachments over each storage adapter's generation-guarded ownership. */
export function plannerAttachmentContract(name: string, factory: StorageFactory): void {
	describe(`${name} Planner attachments`, () => {
		test("an attachment owns the document, refuses another login, and survives its own reattach", async () => {
			let storage = await openedStorage(factory);
			let f = await attachable(storage);
			let attachments = new PlannerAttachments(f.auth, 60_000);
			try {
				let granted = await attachments.attach(f.request(f.member), link());
				expect(granted.ok).toBe(true);
				let held = await f.owner();
				expect(held).toMatchObject({ ownerSessionId: f.logins.member, status: "ready" });
				expect(await attachments.attach(f.request(f.rival), link())).toMatchObject({
					ok: false,
					code: "planner-attached",
					message: expect.stringContaining("member is attached"),
				});
				if (granted.ok) granted.detach();
				expect(attachments.attached(f.channelId)).toBe(false);
				expect(await f.owner()).toEqual(held);
				expect(await attachments.attach(f.request(f.rival), link())).toMatchObject({
					ok: false,
					code: "planner-attached",
					message: expect.stringContaining("member detached"),
				});
				expect((await attachments.attach(f.request(f.member), link())).ok).toBe(true);
				expect(attachments.attached(f.channelId)).toBe(true);
				expect(await f.owner()).toEqual(held);
			} finally {
				attachments.close();
				await storage.close();
			}
		});

		test("the grace period's end clears only the ownership the attachment still holds", async () => {
			let storage = await openedStorage(factory);
			let f = await attachable(storage);
			let attachments = new PlannerAttachments(f.auth, 30);
			try {
				let first = await attachments.attach(f.request(f.member), link());
				let generation = (await f.owner())!.generation;
				if (first.ok) first.detach();
				await released(f.owner);
				expect(await f.owner()).toMatchObject({
					ownerSessionId: undefined,
					generation,
					status: "unavailable",
				});
				expect(attachments.holder(f.channelId)).toBeUndefined();

				let rival = await attachments.attach(f.request(f.rival), link());
				expect(await f.owner())
					.toMatchObject({ ownerSessionId: f.logins.rival, generation: generation + 1 });
				if (rival.ok) rival.detach();
				let channels = storage.channels;
				expect(
					await channels.clearAgentOwner(f.channelId, f.logins.rival, generation + 1, new Date()),
				)
					.toBe(true);
				await channels.claimAgentOwner(f.channelId, f.logins.member, new Date());
				await Bun.sleep(80);
				expect(await f.owner())
					.toMatchObject({ ownerSessionId: f.logins.member, generation: generation + 2 });
			} finally {
				attachments.close();
				await storage.close();
			}
		});

		test("startup clears an attachment's ownership and a new process starts unattached", async () => {
			let storage = await openedStorage(factory);
			let f = await attachable(storage);
			let attachments = new PlannerAttachments(f.auth, 60_000);
			try {
				await attachments.attach(f.request(f.member), link());
				let generation = (await f.owner())!.generation;
				let lease = await storage.leases.acquire(id("writer"), id("instance"), 60_000);
				await storage.sessions.reset(new Date(), lease!, 60_000);
				expect(await f.owner()).toMatchObject({ ownerSessionId: undefined, generation });

				let sessions = new Sessions(storage, false);
				let restarted = new PlannerAttachments({ ...f.auth, sessions }, 60_000);
				try {
					expect(restarted.attached(f.channelId)).toBe(false);
					expect(await restarted.attach(f.request(f.member), link())).toMatchObject({
						ok: false,
						code: "sign-in-required",
					});
					let login = await sessions.issue(f.member.id, { ...GRANT, accessToken: "again" });
					expect((await restarted.attach(f.request(f.member), link())).ok).toBe(true);
					expect(await f.owner())
						.toMatchObject({ ownerSessionId: login.id, generation: generation + 1 });
				} finally {
					restarted.close();
				}
			} finally {
				attachments.close();
				await storage.close();
			}
		});

		test("an owner sign-in storage already sees expired releases the attachment as sign-in-required", async () => {
			let storage = await openedStorage(factory);
			let f = await attachable(storage);
			let attachments = new PlannerAttachments(f.auth, 60_000);
			try {
				let attached = revocable();
				expect((await attachments.attach(f.request(f.member), attached.link)).ok).toBe(true);
				let generation = (await f.owner())!.generation;
				f.skew.ms = 31 * 24 * 60 * 60 * 1_000;
				expect((await storage.channels.readAgent(f.channelId, f.auth.clock()))?.agent)
					.toMatchObject({ ownerSessionId: undefined, generation });
				expect(await attachments.verify(f.channelId, attached.link)).toBe(false);
				expect(attached.refusals).toEqual([{
					code: "sign-in-required",
					message: expect.stringContaining("The Chopin browser sign-in that made member"),
				}]);
				f.skew.ms = 0;
				expect(await f.owner())
					.toMatchObject({ ownerSessionId: undefined, generation, status: "unavailable" });
				expect(attachments.holder(f.channelId)).toBeUndefined();
			} finally {
				attachments.close();
				await storage.close();
			}
		});

		test("a reset during a grace reattach refuses it and leaves the document free", async () => {
			let storage = await openedStorage(factory);
			let f = await attachable(storage);
			let reading = Promise.withResolvers<void>();
			let resume = Promise.withResolvers<void>();
			let paused = false;
			let channels = {
				...storage.channels,
				readAgent: async (channelId: string, now: Date) => {
					let snapshot = await storage.channels.readAgent(channelId, now);
					if (!paused) return snapshot;
					paused = false;
					reading.resolve();
					await resume.promise;
					return snapshot;
				},
			};
			let attachments = new PlannerAttachments({ ...f.auth, storage: { channels } }, 60_000);
			try {
				let first = await attachments.attach(f.request(f.member), link());
				if (first.ok) first.detach();
				let held = (await f.owner())!;
				paused = true;
				let reattached = revocable();
				let reattaching = attachments.attach(f.request(f.member), reattached.link);
				await reading.promise;
				expect(
					await storage.channels.clearAgentOwner(
						f.channelId,
						held.ownerSessionId!,
						held.generation,
						new Date(),
					),
				).toBe(true);
				attachments.ownerReset(f.channelId);
				resume.resolve();
				expect(await reattaching).toMatchObject({ ok: false, code: "access-revoked" });
				expect(attachments.attached(f.channelId)).toBe(false);
				expect(attachments.holder(f.channelId)).toBeUndefined();
				expect(await f.owner())
					.toMatchObject({ ownerSessionId: undefined, generation: held.generation });
				expect((await attachments.attach(f.request(f.rival), link())).ok).toBe(true);
				expect(await f.owner())
					.toMatchObject({ ownerSessionId: f.logins.rival, generation: held.generation + 1 });
			} finally {
				attachments.close();
				await storage.close();
			}
		});
	});
}
