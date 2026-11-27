import { Machines } from "../auth/machines";
import { describe, expect, it } from "bun:test";

import { Sessions } from "../auth/session";
import { Admission } from "../auth/admission";
import { MemoryStorage } from "../storage/memory/adapter";
import { close, create, resetAgent, resolveOwner } from "./service";

import type { HostedAuth } from "../auth/routes";
import type {
	GitHub,
	GitHubTokenGrant,
	GitHubUser,
	InstallationPage,
	Repository,
	RepositoryPage,
} from "../github/client";

class GitHubAccess implements GitHub {
	authorize(): string {
		return "";
	}
	async exchange(): Promise<GitHubTokenGrant> {
		return grant("ghu_user");
	}
	async refresh(): Promise<GitHubTokenGrant> {
		return grant("ghu_refreshed");
	}
	async user(): Promise<GitHubUser> {
		return { id: "", login: "", avatarUrl: "" };
	}
	async organizationMembership() {
		return undefined;
	}
	async installations(): Promise<InstallationPage> {
		return { installations: [], nextPage: undefined };
	}
	async installationRepositories(): Promise<RepositoryPage> {
		return { repositories: [], nextPage: undefined };
	}
	async repository(_token: string, owner: string, name: string): Promise<Repository> {
		return this.value(owner, name);
	}
	async repositoryAccess(_token: string, owner: string, name: string): Promise<Repository> {
		return this.value(owner, name);
	}
	invalidate(): void {}
	private value(owner: string, name: string): Repository {
		return {
			id: "R_score",
			owner,
			name,
			fullName: `${owner}/${name}`,
			private: true,
			url: "",
			defaultBranch: "main",
			permissions: { pull: true, push: true, admin: false },
		};
	}
}

function grant(accessToken: string): GitHubTokenGrant {
	return {
		accessToken,
		accessExpiresIn: 28_800,
		refreshToken: `ghr_${accessToken}`,
		refreshExpiresIn: 15_897_600,
	};
}

describe("hosted Copilot ownership", () => {
	it("keeps the first invoking login session until it is explicitly released", async () => {
		let now = new Date();
		let storage = new MemoryStorage();
		let key = new Uint8Array(32).fill(9);
		for (let [id, login] of [["U_ana", "ana"], ["U_bob", "bob"]]) {
			await storage.users.put({ id, login, avatarUrl: "", now });
		}
		let sessions = new Sessions(storage, true, () => now);
		let ana = await sessions.issue("U_ana", grant("ghu_ana"));
		let bob = await sessions.issue("U_bob", grant("ghu_bob"));
		let channel = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Plan",
			createdBy: "U_ana",
			now,
		});
		let config = {
			origin: "https://test",
			appSlug: "chopin-test",
			clientId: "id",
			clientSecret: "secret",
			encryptionKey: key,
		};
		let github = new GitHubAccess();
		let auth: HostedAuth = {
			config,
			storage,
			github,
			admission: new Admission(config, github, () => now.getTime()),
			sessions,
			clock: () => now,
			machines: new Machines(storage, () => new Date(), {
				origin: "https://chopin.test",
				clientId: "test",
			}),
			pairings: {},
		};
		let repository = { id: "R_score", owner: "octo-org", name: "score", defaultBranch: "main" };

		let first = await resolveOwner(auth, repository, channel.id, ana.id);
		expect(first.ownership.ownerSessionId).toBe(ana.id);
		expect(first.owner.access.token).toBe("ghu_ana");
		let second = await resolveOwner(auth, repository, channel.id, bob.id);
		expect(second.ownership.ownerSessionId).toBe(ana.id);
		expect(second.owner.access.token).toBe("ghu_ana");

		await storage.channels.clearAgentOwner(
			channel.id,
			ana.id,
			first.ownership.generation,
			now,
		);
		let replacement = await resolveOwner(auth, repository, channel.id, bob.id);
		expect(replacement.ownership.ownerSessionId).toBe(bob.id);
		expect(replacement.ownership.generation).toBeGreaterThan(first.ownership.generation);
		expect(replacement.owner.access.token).toBe("ghu_bob");
	});

	it("invalidates only the turn bound to the rotating credential revision", async () => {
		let chat = create();
		let controller = chat.turnController = new AbortController();
		chat.owner = { sessionId: "session", generation: 3, revision: 4 };
		chat.busy = true;
		chat.activeRequest = {
			entryId: "entry",
			userId: "U_ana",
			handle: "ana",
			text: "research this",
			claimantSessionId: "session",
			turnId: "turn",
			lifecycle: 0,
		};
		chat.referenceCache.set("reference", {} as never);

		await resetAgent(chat, "session", 3, "rotated");
		expect(controller.signal.aborted).toBe(false);
		expect(chat.activeRequest).toBeDefined();
		expect(chat.referenceCache.size).toBe(1);

		await resetAgent(chat, "session", 4, "rotated");
		expect(controller.signal.aborted).toBe(true);
		expect(chat.interruption).toBe("rotated");
		expect(chat.lifecycle).toBe(1);
		expect(chat.activeRequest).toBeUndefined();
		expect(chat.referenceCache.size).toBe(0);
	});

	it("does not mark a not-yet-started turn interrupted during refresh", async () => {
		let chat = create();
		chat.busy = true;
		chat.activeRequest = {
			entryId: "entry",
			userId: "U_mona",
			handle: "mona",
			text: "research this",
			claimantSessionId: "session",
			turnId: "turn",
			lifecycle: 0,
		};
		chat.openingOwner = { sessionId: "session", generation: 1, revision: 2 };

		await resetAgent(chat, "session", 2, "rotated");
		expect(chat.interruption).toBeUndefined();
		expect(chat.lifecycle).toBe(1);
		expect(chat.activeRequest).toBeUndefined();
	});

	it("closes an active turn before releasing the conversation", async () => {
		let chat = create();
		let finished = Promise.withResolvers<void>();
		let controller = chat.turnController = new AbortController();
		controller.signal.addEventListener("abort", () => finished.resolve());
		chat.busy = true;
		chat.waiting.push({ id: "queued", handle: "mona", text: "next" });
		chat.referenceCache.set("reference", {} as never);
		chat.running = finished.promise;

		await close(chat);
		expect(controller.signal.aborted).toBe(true);
		expect(chat.closed).toBe(true);
		expect(chat.waiting).toEqual([]);
		expect(chat.activeRequest).toBeUndefined();
		expect(chat.referenceCache.size).toBe(0);
	});

	it("skips a rebindable session on credential rotation while resetting child chats, jobs, and full session revocations", async () => {
		let chat = create();
		let controller = chat.turnController = new AbortController();
		chat.owner = { sessionId: "session", generation: 3, revision: 4 };
		chat.busy = true;
		chat.agent = {
			activeTools: [],
			rebind: () => {},
			stream: (async () => ({ fullStream: (async function*() {})() })) as never,
			destroy: async () => {},
		};
		chat.activeRequest = {
			entryId: "entry",
			userId: "U_ana",
			handle: "ana",
			text: "continue working",
			claimantSessionId: "session",
			turnId: "turn",
			lifecycle: 0,
		};
		chat.referenceCache.set("reference", {} as never);

		let child = create();
		let childController = child.turnController = new AbortController();
		child.owner = { sessionId: "session", generation: 3, revision: 4 };
		child.busy = true;
		child.agent = {
			activeTools: [],
			stream: (async () => ({ fullStream: (async function*() {})() })) as never,
			destroy: async () => {},
		};
		chat.childChats = new Map([["thread-1", child]]);

		// Credential rotation skips the rebindable root turn, but still resets its non-rebindable child chat.
		await resetAgent(chat, "session", 4, "rotated");
		expect(controller.signal.aborted).toBe(false);
		expect(chat.interruption).toBeUndefined();
		expect(chat.lifecycle).toBe(0);
		expect(chat.activeRequest).toBeDefined();
		expect(chat.referenceCache.size).toBe(1);
		expect(childController.signal.aborted).toBe(true);
		expect(child.interruption).toBe("rotated");
		expect(child.lifecycle).toBe(1);

		// Idle retained rebindable session is also skipped on credential rotation.
		let retainedChat = create();
		retainedChat.owner = { sessionId: "session", generation: 3, revision: 4 };
		retainedChat.retained = {
			session: {
				activeTools: [],
				rebind: () => {},
				stream: (async () => ({ fullStream: (async function*() {})() })) as never,
				destroy: async () => {},
			},
			binding: {} as never,
			ended: () => {},
			release: async () => {},
		};
		await resetAgent(retainedChat, "session", 4, "rotated");
		expect(retainedChat.lifecycle).toBe(0);

		// Background jobs never skip credential rotation.
		let jobChat = create();
		let jobController = jobChat.turnController = new AbortController();
		jobChat.owner = { sessionId: "session", generation: 3, revision: 4 };
		jobChat.busy = true;
		jobChat.job = { kind: "heading", target: "heading" } as never;
		jobChat.agent = chat.agent;
		await resetAgent(jobChat, "session", 4, "rotated");
		expect(jobController.signal.aborted).toBe(true);
		expect(jobChat.lifecycle).toBe(1);

		// Full session revocation (revision === undefined) still aborts a rebindable session.
		await resetAgent(chat, "session", undefined, "signed out");
		expect(controller.signal.aborted).toBe(true);
		expect(chat.interruption).toBe("signed out");
		expect(chat.lifecycle).toBe(1);
		expect(chat.activeRequest).toBeUndefined();
	});
});
