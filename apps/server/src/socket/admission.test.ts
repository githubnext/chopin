import { describe, expect, it } from "bun:test";

import { Sessions } from "../auth/session";
import { MemoryStorage } from "../storage/memory/adapter";
import { admit } from "./admission";

import type { HostedAuth } from "../auth/routes";
import type { GitHub, GitHubUser, Repository, RepositoryPage } from "../github/client";

class FakeGitHub implements GitHub {
	repositoryId = "R_score";
	push = false;

	authorize(): string {
		return "";
	}

	async exchange(): Promise<string> {
		return "gho_user";
	}

	async user(): Promise<GitHubUser> {
		return { id: "U_octocat", login: "octocat", avatarUrl: "avatar" };
	}

	async repositories(): Promise<RepositoryPage> {
		return { repositories: [], nextPage: undefined };
	}

	async repository(_token: string, owner: string, name: string): Promise<Repository> {
		return {
			id: this.repositoryId,
			owner,
			name,
			fullName: `${owner}/${name}`,
			private: true,
			url: "",
			defaultBranch: "main",
			permissions: { pull: true, push: this.push, admin: false },
		};
	}

	async repositoryAccess(token: string, owner: string, name: string): Promise<Repository> {
		return this.repository(token, owner, name);
	}
}

function pair(cookie: string): string {
	return cookie.split(";", 1)[0]!;
}

describe("socket admission", () => {
	it("preserves claimed identity for the legacy prototype", async () => {
		let url = new URL("https://chopin.test/ws?room=main&as=octocat&key=secret");
		let result = await admit(new Request(url), url, { key: "secret", auth: undefined });
		expect("data" in result && result.data).toMatchObject({
			room: "main",
			handle: "octocat",
			canEdit: true,
		});
	});

	it("derives hosted identity and edit rights from the authenticated repository", async () => {
		let now = new Date("2026-08-13T12:00:00.000Z");
		let storage = new MemoryStorage();
		await storage.users.put({ id: "U_octocat", login: "octocat", avatarUrl: "avatar", now });
		let sessions = new Sessions(storage, new Uint8Array(32).fill(2), true, () => now);
		let issued = await sessions.issue("U_octocat", "gho_user");
		let channel = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Plan",
			createdBy: "U_octocat",
			now,
		});
		let github = new FakeGitHub();
		let auth: HostedAuth = {
			config: {
				driver: "github",
				origin: "https://chopin.test",
				clientId: "client",
				clientSecret: "secret",
				encryptionKey: new Uint8Array(32).fill(2),
			},
			storage,
			github,
			sessions,
			clock: () => now,
		};
		let url = new URL(`https://chopin.test/ws?room=${channel.id}&as=impersonated`);
		let wrongOrigin = await admit(
			new Request(url, { headers: { cookie: pair(issued.cookie), origin: "https://evil.test" } }),
			url,
			{ key: undefined, auth },
		);
		expect(wrongOrigin).toEqual({ status: 403, reason: "origin is not allowed" });
		let request = new Request(url, {
			headers: { cookie: pair(issued.cookie), origin: "https://chopin.test" },
		});
		let viewer = await admit(request, url, { key: undefined, auth });
		expect("data" in viewer && viewer.data).toMatchObject({
			room: channel.id,
			handle: "octocat",
			principalId: "U_octocat",
			canEdit: false,
		});

		github.push = true;
		let editor = await admit(request, url, { key: undefined, auth });
		expect("data" in editor && editor.data.canEdit).toBe(true);
		github.repositoryId = "R_other";
		let denied = await admit(request, url, { key: undefined, auth });
		expect(denied).toEqual({ status: 404, reason: "channel not found" });
	});
});
