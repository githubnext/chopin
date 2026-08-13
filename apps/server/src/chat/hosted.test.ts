import { describe, expect, it } from "bun:test";

import { Sessions } from "../auth/session";
import { MemoryStorage } from "../storage/memory/adapter";
import { resolveHostedOwner } from "./service";

import type { HostedAuth } from "../auth/routes";
import type { GitHub, GitHubUser, Repository, RepositoryPage } from "../github/client";
import type { Room } from "./service";

class GitHubAccess implements GitHub {
	authorize(): string {
		return "";
	}
	async exchange(): Promise<string> {
		return "";
	}
	async user(): Promise<GitHubUser> {
		return { id: "", login: "", avatarUrl: "" };
	}
	async repositories(): Promise<RepositoryPage> {
		return { repositories: [], nextPage: undefined };
	}
	async repository(_token: string, owner: string, name: string): Promise<Repository> {
		return this.value(owner, name);
	}
	async repositoryAccess(_token: string, owner: string, name: string): Promise<Repository> {
		return this.value(owner, name);
	}
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

describe("hosted Copilot ownership", () => {
	it("keeps the first invoking login session until it is explicitly released", async () => {
		let now = new Date("2026-08-13T12:00:00.000Z");
		let storage = new MemoryStorage();
		let key = new Uint8Array(32).fill(9);
		for (let [id, login] of [["U_ana", "ana"], ["U_bob", "bob"]]) {
			await storage.users.put({ id, login, avatarUrl: "", now });
		}
		let sessions = new Sessions(storage, key, true, () => now);
		let ana = await sessions.issue("U_ana", "gho_ana");
		let bob = await sessions.issue("U_bob", "gho_bob");
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
				driver: "github",
				origin: "https://test",
				clientId: "id",
				clientSecret: "secret",
				encryptionKey: key,
			},
			storage,
			github: new GitHubAccess(),
			sessions,
			clock: () => now,
		};
		let hosted: NonNullable<Room["hosted"]> = {
			auth,
			claimantSessionId: ana.id,
			repository: { id: "R_score", owner: "octo-org", name: "score", defaultBranch: "main" },
		};

		let first = await resolveHostedOwner(hosted, channel.id, ana.id);
		expect(first.ownership.ownerSessionId).toBe(ana.id);
		expect(first.owner.oauthToken).toBe("gho_ana");
		let second = await resolveHostedOwner(hosted, channel.id, bob.id);
		expect(second.ownership.ownerSessionId).toBe(ana.id);
		expect(second.owner.oauthToken).toBe("gho_ana");

		await storage.channels.clearAgentOwner(
			channel.id,
			ana.id,
			first.ownership.generation,
			now,
		);
		let replacement = await resolveHostedOwner(hosted, channel.id, bob.id);
		expect(replacement.ownership.ownerSessionId).toBe(bob.id);
		expect(replacement.ownership.generation).toBeGreaterThan(first.ownership.generation);
		expect(replacement.owner.oauthToken).toBe("gho_bob");
	});
});
