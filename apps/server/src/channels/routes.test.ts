import { describe, expect, it } from "bun:test";

import { Sessions } from "../auth/session";
import { Admission } from "../auth/admission";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { registerChannelRoutes } from "./routes";

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
	affiliated = true;
	repo: Repository = {
		id: "R_score",
		owner: "octo-org",
		ownerAvatarUrl: "https://avatars.test/octo-org.png",
		name: "score",
		fullName: "octo-org/score",
		private: true,
		url: "https://github.test/octo-org/score",
		defaultBranch: "main",
		permissions: { pull: true, push: true, admin: false },
	};

	authorize(): string {
		return "https://github.test/authorize";
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
		return { repositories: [this.repo], nextPage: undefined };
	}

	async repository(_token: string, owner: string, name: string): Promise<Repository> {
		return { ...this.repo, owner, name, fullName: `${owner}/${name}` };
	}

	async repositoryAccess(
		token: string,
		owner: string,
		name: string,
	): Promise<Repository | undefined> {
		return this.affiliated ? this.repository(token, owner, name) : undefined;
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

async function setup(random?: () => number) {
	let now = new Date("2026-08-13T12:00:00.000Z");
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_octocat", login: "octocat", avatarUrl: "avatar", now });
	let sessions = new Sessions(storage, true, () => now);
	let issued = await sessions.issue("U_octocat", grant("ghu_user"));
	let github = new FakeGitHub();
	let config = {
		origin: "https://chopin.test",
		appSlug: "chopin-test",
		clientId: "client-id",
		clientSecret: "client-secret",
		encryptionKey: new Uint8Array(32).fill(4),
	};
	let auth: HostedAuth = {
		config,
		storage,
		github,
		admission: new Admission(config, github, () => now.getTime()),
		sessions,
		clock: () => now,
	};
	let router = new Router();
	let reset: string[] = [];
	registerChannelRoutes(router, auth, {
		onAgentReset: async id => {
			reset.push(id);
		},
		random,
	});
	return { router, storage, github, cookie: pair(issued.cookie), sessionId: issued.id, reset, now };
}

function request(path: string, cookie?: string, init: RequestInit = {}): Request {
	let headers = new Headers(init.headers);
	if (cookie) headers.set("cookie", cookie);
	return new Request(`https://chopin.test${path}`, { ...init, headers });
}

describe("channel routes", () => {
	it("requires authentication and current repository access", async () => {
		let { router, github, cookie } = await setup();
		let anonymous = await router.handle(request("/api/repositories/octo-org/score/channels"));
		expect(anonymous!.status).toBe(401);

		github.repo = { ...github.repo, permissions: { pull: false, push: false, admin: false } };
		let denied = await router.handle(request(
			"/api/repositories/octo-org/score/channels",
			cookie,
		));
		expect(denied!.status).toBe(403);

		github.repo = { ...github.repo, permissions: { pull: true, push: false, admin: false } };
		github.affiliated = false;
		let outsider = await router.handle(request(
			"/api/repositories/octo-org/score/channels",
			cookie,
		));
		expect(outsider!.status).toBe(404);
	});

	it("lets an editor create, list and open a canonical repository channel", async () => {
		let { router, storage, cookie, now } = await setup();
		let created = await router.handle(request(
			"/api/repositories/octo-org/score/channels",
			cookie,
			{
				method: "POST",
				headers: { "content-type": "application/json", origin: "https://chopin.test" },
				body: JSON.stringify({ title: "  Release readiness  " }),
			},
		));
		expect(created!.status).toBe(201);
		let body = await created!.json();
		expect(body.channel.title).toBe("Release readiness");
		expect(body.channel.id[14]).toBe("5");
		expect(body.channel.repositoryId).toBe("R_score");
		expect(body.channel.createdBy).toBe("U_octocat");
		expect(created!.headers.get("location")).toBe(`/channels/${body.channel.id}`);
		expect(await storage.channels.get(body.channel.id)).toMatchObject({
			repositoryOwner: "octo-org",
			repositoryName: "score",
		});

		let listed = await router.handle(request(
			"/api/repositories/octo-org/score/channels?limit=1",
			cookie,
		));
		expect((await listed!.json()).channels).toHaveLength(1);
		let detail = await router.handle(request(`/api/channels/${body.channel.id}`, cookie));
		expect(detail!.status).toBe(200);
		expect((await detail!.json()).canEdit).toBe(true);
		expect((await storage.collaboration.load(body.channel.id, now))?.channel.id).toBe(
			body.channel.id,
		);
	});

	it("continues to open a legacy UUIDv4 channel", async () => {
		let { router, storage, cookie, now } = await setup();
		let id = "019c1234-1234-4123-8123-123456789abc";
		await storage.channels.create({
			id,
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Legacy plan",
			createdBy: "U_octocat",
			now,
		});

		let response = await router.handle(request(`/api/channels/${id}`, cookie));
		expect(response!.status).toBe(200);
		expect((await response!.json()).channel.id).toBe(id);
	});

	it("lists matching documents with a query-bound cursor and repository avatar", async () => {
		let { router, storage, cookie, now } = await setup();
		for (let title of ["Launch notes", "Launch checklist", "Roadmap"]) {
			await storage.channels.create({
				id: crypto.randomUUID(),
				repositoryId: "R_score",
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title,
				createdBy: "U_octocat",
				now,
			});
		}
		let response = await router.handle(request(
			"/api/repositories/octo-org/score/channels?query=launch&limit=1",
			cookie,
		));
		expect(response!.status).toBe(200);
		let page = await response!.json();
		expect(page.repository.ownerAvatarUrl).toBe("https://avatars.test/octo-org.png");
		expect(page.channels[0].title).toMatch(/launch/i);
		expect(page.nextCursor).toBeString();
		let next = await router.handle(request(
			`/api/repositories/octo-org/score/channels?query=launch&limit=1&cursor=${page.nextCursor}`,
			cookie,
		));
		expect((await next!.json()).channels[0].title).toMatch(/launch/i);
		let mismatch = await router.handle(request(
			`/api/repositories/octo-org/score/channels?query=road&cursor=${page.nextCursor}`,
			cookie,
		));
		expect(mismatch!.status).toBe(400);
	});

	it("creates a unique generated document when a title is omitted", async () => {
		let { router, cookie } = await setup();
		let create = () =>
			router.handle(request(
				"/api/repositories/octo-org/score/channels",
				cookie,
				{ method: "POST", headers: { origin: "https://chopin.test" }, body: "{}" },
			));
		let first = await create();
		let second = await create();
		expect(first!.status).toBe(201);
		expect(second!.status).toBe(201);
		let firstBody = await first!.json();
		let secondBody = await second!.json();
		expect(firstBody.channel.title).toMatch(/^[a-z]+-[a-z]+$/);
		expect(secondBody.channel.title).not.toBe(firstBody.channel.title);
	});

	it("tries another generated title when its random starting title is reserved", async () => {
		let { router, storage, cookie, now } = await setup(() => 0);
		await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "amber-anchor",
			createdBy: "U_octocat",
			now,
		});
		let created = await router.handle(request(
			"/api/repositories/octo-org/score/channels",
			cookie,
			{ method: "POST", headers: { origin: "https://chopin.test" }, body: "{}" },
		));
		expect(created!.status).toBe(201);
		expect((await created!.json()).channel.title).toBe("amber-arch");
	});

	it("keeps viewers read-only and requires a matching Origin", async () => {
		let { router, github, cookie } = await setup();
		github.repo = { ...github.repo, permissions: { pull: true, push: false, admin: false } };
		let viewer = await router.handle(request(
			"/api/repositories/octo-org/score/channels",
			cookie,
			{
				method: "POST",
				headers: { origin: "https://chopin.test" },
				body: JSON.stringify({ title: "No" }),
			},
		));
		expect(viewer!.status).toBe(403);

		github.repo = { ...github.repo, permissions: { pull: true, push: true, admin: false } };
		let csrf = await router.handle(request(
			"/api/repositories/octo-org/score/channels",
			cookie,
			{
				method: "POST",
				headers: { origin: "https://evil.test" },
				body: JSON.stringify({ title: "No" }),
			},
		));
		expect(csrf!.status).toBe(403);
	});

	it("paginates opaquely and rejects malformed cursors", async () => {
		let { router, storage, cookie, now } = await setup();
		let ids = [
			"019c1234-1234-5123-8123-123456789abc",
			"119c1234-1234-4123-8123-123456789abc",
			"219c1234-1234-5123-8123-123456789abc",
		];
		for (let [index, id] of ids.entries()) {
			await storage.channels.create({
				id,
				repositoryId: "R_score",
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: `Channel ${index}`,
				createdBy: "U_octocat",
				now,
			});
		}
		let first = await router.handle(request(
			"/api/repositories/octo-org/score/channels?limit=1",
			cookie,
		));
		let page = await first!.json();
		expect(page.channels).toHaveLength(1);
		expect(page.channels[0].id).toBe(ids[0]);
		expect(page.nextCursor).toBeString();
		let second = await router.handle(request(
			`/api/repositories/octo-org/score/channels?limit=1&cursor=${page.nextCursor}`,
			cookie,
		));
		let secondPage = await second!.json();
		expect(secondPage.channels[0].id).toBe(ids[1]);
		expect(secondPage.nextCursor).toBeString();
		let third = await router.handle(request(
			`/api/repositories/octo-org/score/channels?limit=1&cursor=${secondPage.nextCursor}`,
			cookie,
		));
		expect((await third!.json()).channels[0].id).toBe(ids[2]);
		let bad = await router.handle(request(
			"/api/repositories/octo-org/score/channels?cursor=not-json",
			cookie,
		));
		expect(bad!.status).toBe(400);
	});

	it("refuses a channel whose stored repository id no longer matches", async () => {
		let { router, storage, github, cookie, now } = await setup();
		let channel = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_other",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Hidden",
			createdBy: "U_octocat",
			now,
		});
		github.repo = { ...github.repo, id: "R_score" };
		let response = await router.handle(request(`/api/channels/${channel.id}`, cookie));
		expect(response!.status).toBe(404);
	});

	it("lets an editor explicitly release the Copilot owner", async () => {
		let { router, storage, cookie, sessionId, reset, now } = await setup();
		let channel = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Reset",
			createdBy: "U_octocat",
			now,
		});
		await storage.channels.claimAgentOwner(channel.id, sessionId, now);
		let response = await router.handle(request(
			`/api/channels/${channel.id}/agent/reset`,
			cookie,
			{ method: "POST", headers: { origin: "https://chopin.test" } },
		));
		expect(response!.status).toBe(204);
		expect(reset).toEqual([channel.id]);
		expect((await storage.collaboration.load(channel.id, now))!.agent!.ownerSessionId)
			.toBeUndefined();
	});
});
