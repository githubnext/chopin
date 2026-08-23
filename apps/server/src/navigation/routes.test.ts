import { describe, expect, it } from "bun:test";

import { Admission } from "../auth/admission";
import { Sessions } from "../auth/session";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { registerNavigationRoutes } from "./routes";

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
	repositories = new Map<string, Repository>();
	accesses: string[] = [];
	accessGate: ((owner: string, name: string) => Promise<void>) | undefined;

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
		return { repositories: [...this.repositories.values()], nextPage: undefined };
	}

	async repository(_token: string, owner: string, name: string): Promise<Repository> {
		let found = this.repositories.get(`${owner}/${name}`);
		if (!found) throw new Error("repository not found");
		return found;
	}

	async repositoryAccess(
		_token: string,
		owner: string,
		name: string,
	): Promise<Repository | undefined> {
		this.accesses.push(`${owner}/${name}`);
		await this.accessGate?.(owner, name);
		return this.repositories.get(`${owner}/${name}`);
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

function repository(
	id: string,
	owner: string,
	name: string,
	pull = true,
): Repository {
	return {
		id,
		owner,
		ownerAvatarUrl: `https://avatars.test/${owner}.png`,
		name,
		fullName: `${owner}/${name}`,
		private: true,
		url: `https://github.test/${owner}/${name}`,
		defaultBranch: "main",
		permissions: { pull, push: pull, admin: false },
	};
}

function pair(cookie: string): string {
	return cookie.split(";", 1)[0]!;
}

async function setup() {
	let now = new Date("2026-08-21T12:00:00.000Z");
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
	registerNavigationRoutes(router, auth, { storage });
	return { router, storage, github, cookie: pair(issued.cookie), now };
}

function request(path: string, cookie?: string, init: RequestInit = {}): Request {
	let headers = new Headers(init.headers);
	if (cookie) headers.set("cookie", cookie);
	return new Request(`https://chopin.test${path}`, { ...init, headers });
}

describe("navigation routes", () => {
	it("requires authentication", async () => {
		let { router } = await setup();
		let response = await router.handle(request("/api/navigation"));
		expect(response!.status).toBe(401);
	});

	it("lists ordered available and unavailable projects", async () => {
		let { router, storage, github, cookie, now } = await setup();
		await storage.navigation.addProject({
			userId: "U_octocat",
			repositoryId: "R_available",
			repositoryOwner: "octo-org",
			repositoryName: "available",
			now,
		});
		await storage.navigation.addProject({
			userId: "U_octocat",
			repositoryId: "R_unavailable",
			repositoryOwner: "octo-org",
			repositoryName: "unavailable",
			now,
		});
		github.repositories.set(
			"octo-org/available",
			repository("R_available", "octo-org", "available"),
		);
		github.repositories.set(
			"octo-org/unavailable",
			repository("R_replaced", "octo-org", "unavailable"),
		);

		let response = await router.handle(request("/api/navigation", cookie));
		expect(response!.status).toBe(200);
		expect(await response!.json()).toMatchObject({
			projects: [
				{ repositoryId: "R_available", position: 0, available: true },
				{ repositoryId: "R_unavailable", position: 1, available: false },
			],
		});
	});

	it("checks stored projects concurrently without changing their order", async () => {
		let { router, storage, github, cookie, now } = await setup();
		for (let name of ["first", "second"]) {
			await storage.navigation.addProject({
				userId: "U_octocat",
				repositoryId: `R_${name}`,
				repositoryOwner: "octo-org",
				repositoryName: name,
				now,
			});
			github.repositories.set(`octo-org/${name}`, repository(`R_${name}`, "octo-org", name));
		}
		let release: (() => void) | undefined;
		let gate = new Promise<void>(resolve => {
			release = resolve;
		});
		let firstAccessed: (() => void) | undefined;
		let first = new Promise<void>(resolve => {
			firstAccessed = resolve;
		});
		github.accessGate = async () => {
			firstAccessed?.();
			await gate;
		};

		let pending = router.handle(request("/api/navigation", cookie));
		await first;
		await Promise.resolve();
		expect(github.accesses).toEqual(["octo-org/first", "octo-org/second"]);
		release!();
		expect((await pending)!.status).toBe(200);
	});

	it("resolves remembered navigation without separate channel reads", async () => {
		let { router, storage, github, cookie, now } = await setup();
		await storage.navigation.addProject({
			userId: "U_octocat",
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			now,
		});
		github.repositories.set("octo-org/score", repository("R_score", "octo-org", "score"));
		let channel = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Remembered document",
			createdBy: "U_octocat",
			now,
		});
		await storage.navigation.setLastDocument("U_octocat", channel.id, now);
		storage.channels.get = async () => {
			throw new Error("navigation must use its joined snapshot");
		};
		storage.channels.list = async () => {
			throw new Error("remembered navigation must not query fallback channels");
		};

		let response = await router.handle(request("/api/navigation", cookie));
		expect(response!.status).toBe(200);
		expect((await response!.json()).lastDocumentId).toBe(channel.id);
	});

	it("rejects inaccessible projects and returns an existing project when repeated", async () => {
		let { router, github, cookie } = await setup();
		github.repositories.set("octo-org/score", repository("R_score", "octo-org", "score", false));
		let denied = await router.handle(request("/api/navigation/projects", cookie, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://chopin.test" },
			body: JSON.stringify({ owner: "octo-org", repository: "score" }),
		}));
		expect(denied!.status).toBe(403);

		github.repositories.set("octo-org/score", repository("R_score", "octo-org", "score"));
		let added = await router.handle(request("/api/navigation/projects", cookie, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://chopin.test" },
			body: JSON.stringify({ owner: "octo-org", repository: "score" }),
		}));
		let repeated = await router.handle(request("/api/navigation/projects", cookie, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://chopin.test" },
			body: JSON.stringify({ owner: "octo-org", repository: "score" }),
		}));
		expect(added!.status).toBe(201);
		expect(repeated!.status).toBe(200);
		expect(await repeated!.json()).toEqual(await added!.json());
	});

	it("rejects cross-origin navigation mutations", async () => {
		let { router, cookie } = await setup();
		let headers = { "content-type": "application/json", origin: "https://elsewhere.test" };
		let project = await router.handle(request("/api/navigation/projects", cookie, {
			method: "POST",
			headers,
			body: JSON.stringify({ owner: "octo-org", repository: "score" }),
		}));
		let document = await router.handle(request("/api/navigation", cookie, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ documentId: "document" }),
		}));
		expect(project!.status).toBe(403);
		expect(document!.status).toBe(403);
	});

	it("records an authorized deep-linked document and adds its Project", async () => {
		let { router, storage, github, cookie, now } = await setup();
		github.repositories.set("octo-org/other", repository("R_other", "octo-org", "other"));
		await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_other",
			repositoryOwner: "octo-org",
			repositoryName: "other",
			title: "Other document",
			createdBy: "U_octocat",
			now,
		}).then(async channel => {
			let response = await router.handle(request("/api/navigation", cookie, {
				method: "PATCH",
				headers: { "content-type": "application/json", origin: "https://chopin.test" },
				body: JSON.stringify({ documentId: channel.id }),
			}));
			expect(response!.status).toBe(204);
			expect(await storage.navigation.projects("U_octocat"))
				.toMatchObject([{ repositoryId: "R_other" }]);
			expect((await storage.navigation.get("U_octocat"))!.lastDocumentId).toBe(channel.id);
		});
	});

	it("falls back to the first accessible document by project and channel order", async () => {
		let { router, storage, github, cookie, now } = await setup();
		await storage.navigation.addProject({
			userId: "U_octocat",
			repositoryId: "R_unavailable",
			repositoryOwner: "octo-org",
			repositoryName: "unavailable",
			now,
		});
		await storage.navigation.addProject({
			userId: "U_octocat",
			repositoryId: "R_available",
			repositoryOwner: "octo-org",
			repositoryName: "available",
			now,
		});
		github.repositories.set(
			"octo-org/unavailable",
			repository("R_unavailable", "octo-org", "unavailable", false),
		);
		github.repositories.set(
			"octo-org/available",
			repository("R_available", "octo-org", "available"),
		);
		let inaccessible = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_unavailable",
			repositoryOwner: "octo-org",
			repositoryName: "unavailable",
			title: "Unavailable document",
			createdBy: "U_octocat",
			now,
		});
		let fallback = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_available",
			repositoryOwner: "octo-org",
			repositoryName: "available",
			title: "Available document",
			createdBy: "U_octocat",
			now: new Date(now.getTime() + 1),
		});
		await storage.navigation.setLastDocument("U_octocat", inaccessible.id, now);

		let response = await router.handle(request("/api/navigation", cookie));
		expect(response!.status).toBe(200);
		expect((await response!.json()).lastDocumentId).toBe(fallback.id);
		expect((await storage.navigation.get("U_octocat"))!.lastDocumentId).toBe(fallback.id);
	});

	it("does not overwrite a newer visit while resolving a fallback", async () => {
		let { router, storage, github, cookie, now } = await setup();
		await storage.navigation.addProject({
			userId: "U_octocat",
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			now,
		});
		github.repositories.set("octo-org/score", repository("R_score", "octo-org", "score"));
		let latest = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Latest visit",
			createdBy: "U_octocat",
			now: new Date(now.getTime() + 1),
		});
		await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Fallback candidate",
			createdBy: "U_octocat",
			now: new Date(now.getTime() + 2),
		});
		let release = Promise.withResolvers<void>();
		let accessed = Promise.withResolvers<void>();
		github.accessGate = async () => {
			accessed.resolve();
			await release.promise;
		};

		let pending = router.handle(request("/api/navigation", cookie));
		await accessed.promise;
		await storage.navigation.setLastDocument("U_octocat", latest.id, new Date(now.getTime() + 3));
		release.resolve();
		let response = await pending;

		expect(response!.status).toBe(200);
		expect((await response!.json()).lastDocumentId).toBe(latest.id);
		expect((await storage.navigation.get("U_octocat"))!.lastDocumentId).toBe(latest.id);
	});
});
