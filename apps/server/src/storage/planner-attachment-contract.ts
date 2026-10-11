import { describe, expect, test } from "bun:test";

import { Sessions } from "../auth/session";
import { PlannerAttachments } from "../harness/remote/attachments";
import { contractId as id, openedStorage } from "./contract-support";

import type { AttachmentAuth } from "../harness/remote/attachments";
import type { PlannerLink } from "../harness/remote/link";
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
	let sessions = new Sessions(storage, false);
	let signIn = async (user: { id: string }) =>
		(await sessions.issue(user.id, { ...GRANT, accessToken: `${user.id}-login` })).id;
	let logins = { member: await signIn(member), rival: await signIn(rival) };
	let auth: AttachmentAuth = {
		config: { origin: "https://chopin.test" },
		storage,
		sessions,
		clock: () => new Date(),
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
	return { auth, sessions, member, rival, logins, channelId, owner, request };
}

function link(): PlannerLink {
	return {} as PlannerLink;
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
	});
}
