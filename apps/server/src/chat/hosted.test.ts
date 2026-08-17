import { describe, expect, it } from "bun:test";

import { Sessions } from "../auth/session";
import { MemoryStorage } from "../storage/memory/adapter";
import { close, create, resetAgent, resolveOwner } from "./service";

import type { Agent } from "../agent/client";
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
		let now = new Date("2026-08-13T12:00:00.000Z");
		let storage = new MemoryStorage();
		let key = new Uint8Array(32).fill(9);
		for (let [id, login] of [["U_ana", "ana"], ["U_bob", "bob"]]) {
			await storage.users.put({ id, login, avatarUrl: "", now });
		}
		let sessions = new Sessions(storage, key, true, () => now);
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
		let auth: HostedAuth = {
			config: {
				origin: "https://test",
				appSlug: "chopin-test",
				clientId: "id",
				clientSecret: "secret",
				encryptionKey: key,
			},
			storage,
			github: new GitHubAccess(),
			sessions,
			clock: () => now,
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

	it("invalidates only the agent bound to the rotating credential revision", async () => {
		let chat = create();
		let aborted = 0;
		let disconnected = 0;
		let finished = 0;
		chat.agent = {
			id: "agent",
			session: {
				abort: async () => {
					aborted++;
				},
				disconnect: async () => {
					disconnected++;
				},
			},
		} as unknown as Agent;
		chat.owner = {
			sessionId: "session",
			generation: 3,
			revision: 4,
			expiresAt: Date.now() + 10_000,
		};
		chat.busy = true;
		chat.finishTurn = () => {
			finished++;
		};

		await resetAgent(chat, "session", 3, "rotated");
		expect(aborted).toBe(0);
		expect(chat.agent).toBeDefined();

		await resetAgent(chat, "session", 4, "rotated");
		expect(aborted).toBe(1);
		expect(disconnected).toBe(1);
		expect(finished).toBe(1);
		expect(chat.agent).toBeUndefined();
		expect(chat.owner).toBeUndefined();
		expect(chat.interruption).toBe("rotated");
		expect(chat.lifecycle).toBe(1);
	});

	it("does not mark a not-yet-started turn interrupted during refresh", async () => {
		let chat = create();
		chat.busy = true;
		chat.openingOwner = { sessionId: "session", generation: 1, revision: 2 };

		await resetAgent(chat, "session", 2, "rotated");
		expect(chat.interruption).toBeUndefined();
		expect(chat.lifecycle).toBe(1);
	});

	it("closes an active turn before releasing the conversation", async () => {
		let chat = create();
		let finished = Promise.withResolvers<void>();
		let aborted = 0;
		chat.busy = true;
		chat.waiting.push({ id: "queued", handle: "mona", text: "next" });
		chat.running = finished.promise;
		chat.finishTurn = finished.resolve;
		chat.agent = {
			id: "agent",
			session: {
				abort: async () => {
					aborted++;
				},
				disconnect: async () => {},
			},
		} as unknown as Agent;

		await close(chat);
		expect(aborted).toBe(1);
		expect(chat.closed).toBe(true);
		expect(chat.waiting).toEqual([]);
		expect(chat.agent).toBeUndefined();
	});
});
