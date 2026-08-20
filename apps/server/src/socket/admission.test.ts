import { describe, expect, it } from "bun:test";

import { Sessions } from "../auth/session";
import { Admission } from "../auth/admission";
import { GitHubError } from "../github/client";
import { MemoryStorage } from "../storage/memory/adapter";
import { admit } from "./admission";

import type { HostedAuth } from "../auth/routes";
import type {
	GitHub,
	GitHubTokenGrant,
	GitHubUser,
	InstallationPage,
	Repository,
	RepositoryPage,
} from "../github/client";

class FakeGitHub implements GitHub {
	repositoryId = "R_score";
	push = false;
	failure: number | undefined;

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
		return { id: "U_octocat", login: "octocat", avatarUrl: "avatar" };
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
		if (this.failure) throw new GitHubError("unavailable", this.failure);
		return this.repository(token, owner, name);
	}

	invalidate(): void {}
}

function grant(accessToken: string): GitHubTokenGrant {
	return {
		accessToken,
		accessExpiresIn: 28_800,
		refreshToken: "ghr_user",
		refreshExpiresIn: 15_897_600,
	};
}

function pair(cookie: string): string {
	return cookie.split(";", 1)[0]!;
}

describe("socket admission", () => {
	it("derives identity and edit rights from the authenticated repository", async () => {
		let now = new Date("2026-08-13T12:00:00.000Z");
		let storage = new MemoryStorage();
		await storage.users.put({ id: "U_octocat", login: "octocat", avatarUrl: "avatar", now });
		let sessions = new Sessions(storage, true, () => now);
		let issued = await sessions.issue("U_octocat", grant("ghu_user"));
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
		let config = {
			origin: "https://chopin.test",
			appSlug: "chopin-test",
			clientId: "client",
			clientSecret: "secret",
			encryptionKey: new Uint8Array(32).fill(2),
		};
		let auth: HostedAuth = {
			config,
			storage,
			github,
			admission: new Admission(config, github, () => now.getTime()),
			sessions,
			clock: () => now,
		};
		let url = new URL(`https://chopin.test/ws?channel=${channel.id}`);
		let wrongOrigin = await admit(
			new Request(url, { headers: { cookie: pair(issued.cookie), origin: "https://evil.test" } }),
			url,
			auth,
		);
		expect(wrongOrigin).toEqual({ status: 403, reason: "origin is not allowed" });
		let request = new Request(url, {
			headers: { cookie: pair(issued.cookie), origin: "https://chopin.test" },
		});
		let viewer = await admit(request, url, auth);
		expect("data" in viewer && viewer.data).toMatchObject({
			room: channel.id,
			handle: "octocat",
			principalId: "U_octocat",
			canEdit: false,
		});
		let probe = await admit(
			new Request(url, {
				headers: { cookie: pair(issued.cookie), "x-chopin-socket-probe": "1" },
			}),
			url,
			auth,
		);
		expect("data" in probe).toBe(true);

		let deterministic = await storage.channels.create({
			id: "019c1234-1234-5123-8123-123456789abc",
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "MCP plan",
			createdBy: "U_octocat",
			now,
		});
		let deterministicUrl = new URL(`https://chopin.test/ws?channel=${deterministic.id}`);
		let deterministicRequest = new Request(deterministicUrl, {
			headers: { cookie: pair(issued.cookie), origin: "https://chopin.test" },
		});
		let admitted = await admit(deterministicRequest, deterministicUrl, auth);
		expect("data" in admitted && admitted.data.room).toBe(deterministic.id);

		github.push = true;
		let editor = await admit(request, url, auth);
		expect("data" in editor && editor.data.canEdit).toBe(true);
		github.repositoryId = "R_other";
		let denied = await admit(request, url, auth);
		expect(denied).toEqual({ status: 404, reason: "channel not found" });

		github.repositoryId = "R_score";
		github.failure = 502;
		expect(await admit(request, url, auth)).toEqual({
			status: 503,
			reason: "repository access is temporarily unavailable",
		});
	});
});
