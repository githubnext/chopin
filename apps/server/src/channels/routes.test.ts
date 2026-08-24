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
	let renamed: string[] = [];
	let archived: Array<{ id: string; changed: boolean }> = [];
	let restored: Array<{ id: string; changed: boolean }> = [];
	let deleted: string[] = [];
	registerChannelRoutes(router, auth, {
		onAgentReset: async id => {
			reset.push(id);
		},
		onChannelArchived: async (id, at) => {
			let result = await storage.channels.archive({ id, now: at });
			archived.push({ id, changed: result.changed });
			return result;
		},
		onChannelDeleted: async id => {
			deleted.push(id);
			return storage.channels.delete(id);
		},
		onChannelRenamed: channel => {
			renamed.push(channel.title);
		},
		onChannelRestored: async (id, at) => {
			let result = await storage.channels.restore({ id, now: at });
			restored.push({ id, changed: result.changed });
			return result;
		},
		random,
	});
	return {
		router,
		storage,
		github,
		cookie: pair(issued.cookie),
		sessionId: issued.id,
		reset,
		renamed,
		archived,
		restored,
		deleted,
		now,
	};
}

function request(path: string, cookie?: string, init: RequestInit = {}): Request {
	let headers = new Headers(init.headers);
	if (cookie) headers.set("cookie", cookie);
	return new Request(`https://chopin.test${path}`, { ...init, headers });
}

function createChannel(storage: MemoryStorage, now: Date, title: string) {
	return storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title,
		createdBy: "U_octocat",
		now,
	});
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
		expect(body.channel.slug).toBe("release-readiness");
		expect(body.channel.id[14]).toBe("5");
		expect(body.channel.repositoryId).toBe("R_score");
		expect(body.channel.createdBy).toBe("U_octocat");
		expect(created!.headers.get("location"))
			.toBe("/documents/octo-org/score/release-readiness");
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

	it("exposes child parents without accepting them on top-level creation", async () => {
		let { router, storage, cookie, now } = await setup();
		let parent = await createChannel(storage, now, "Research parent");
		let child = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Research child",
			createdBy: "U_octocat",
			parentChannelId: parent.id,
			now,
		});

		let detail = await router.handle(request(`/api/channels/${child.id}`, cookie));
		expect(detail!.status).toBe(200);
		expect((await detail!.json()).channel.parentChannelId).toBe(parent.id);

		let listed = await router.handle(request(
			"/api/repositories/octo-org/score/channels",
			cookie,
		));
		let page = await listed!.json();
		expect(page.channels.find((channel: { id: string }) => channel.id === child.id))
			.toMatchObject({ parentChannelId: parent.id });

		let forged = await router.handle(request(
			"/api/repositories/octo-org/score/channels",
			cookie,
			{
				method: "POST",
				headers: { "content-type": "application/json", origin: "https://chopin.test" },
				body: JSON.stringify({
					title: "Forged nested child",
					parentChannelId: child.id,
				}),
			},
		));
		expect(forged!.status).toBe(201);
		let forgedChannel = (await forged!.json()).channel;
		expect(forgedChannel.parentChannelId).toBeUndefined();
		expect((await storage.channels.get(forgedChannel.id))?.parentChannelId).toBeUndefined();
	});

	it("resolves canonical and historical document paths within the authorized repository", async () => {
		let { router, storage, github, cookie, now } = await setup();
		let channel = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Release plan",
			createdBy: "U_octocat",
			now,
		});
		await storage.channels.rename({
			id: channel.id,
			title: "Résumé 計画",
			now: new Date(now.getTime() + 1),
		});

		let canonical = await router.handle(request(
			"/api/repositories/octo-org/score/documents/r%C3%A9sum%C3%A9-%E8%A8%88%E7%94%BB",
			cookie,
		));
		expect(canonical!.status).toBe(200);
		expect((await canonical!.json()).channel).toMatchObject({
			id: channel.id,
			title: "Résumé 計画",
			slug: "résumé-計画",
		});

		let alias = await router.handle(request(
			"/api/repositories/octo-org/score/documents/Release--Plan",
			cookie,
		));
		expect(alias!.status).toBe(200);
		expect((await alias!.json()).channel.slug).toBe("résumé-計画");
		expect(await storage.navigation.projects("U_octocat")).toEqual([]);
		expect(await storage.navigation.get("U_octocat")).toBeUndefined();
		let remembered = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Remembered document",
			createdBy: "U_octocat",
			now,
		});
		await storage.navigation.setLastDocument("U_octocat", remembered.id, now);

		github.repo = { ...github.repo, permissions: { pull: false, push: false, admin: false } };
		let denied = await router.handle(request(
			"/api/repositories/octo-org/score/documents/release-plan",
			cookie,
		));
		expect(denied!.status).toBe(404);
		expect((await storage.navigation.get("U_octocat"))!.lastDocumentId).toBe(remembered.id);

		github.repo = {
			...github.repo,
			id: "R_recreated",
			permissions: { pull: true, push: true, admin: false },
		};
		let recreated = await router.handle(request(
			"/api/repositories/octo-org/score/documents/release-plan",
			cookie,
		));
		expect(recreated!.status).toBe(404);
		expect((await storage.navigation.get("U_octocat"))!.lastDocumentId).toBe(remembered.id);
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

	it("does not mutate navigation while resolving authorized metadata", async () => {
		let { router, storage, cookie, now } = await setup();
		let channel = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Deep link",
			createdBy: "U_octocat",
			now,
		});
		let recorded: Parameters<typeof storage.navigation.recordVisit>[0][] = [];
		let recordVisit = storage.navigation.recordVisit;
		storage.navigation.recordVisit = async input => {
			recorded.push(input);
			return recordVisit(input);
		};

		let response = await router.handle(request(`/api/channels/${channel.id}`, cookie));
		expect(response!.status).toBe(200);
		expect(recorded).toEqual([]);
		expect(await storage.navigation.projects("U_octocat")).toEqual([]);
		expect(await storage.navigation.get("U_octocat")).toBeUndefined();
	});

	it("lets an editor rename a document without changing its plan revision", async () => {
		let { router, storage, cookie, renamed, now } = await setup();
		let channel = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Release plan",
			createdBy: "U_octocat",
			now,
		});
		let response = await router.handle(request(`/api/channels/${channel.id}`, cookie, {
			method: "PATCH",
			headers: { "content-type": "application/json", origin: "https://chopin.test" },
			body: JSON.stringify({ title: "  Launch plan  " }),
		}));

		expect(response!.status).toBe(200);
		let body = await response!.json();
		expect(body.channel).toMatchObject({
			id: channel.id,
			title: "Launch plan",
			slug: "launch-plan",
			revision: channel.revision,
		});
		expect((await storage.channels.get(channel.id))!.title).toBe("Launch plan");
		expect(renamed).toEqual(["Launch plan"]);

		let repeated = await router.handle(request(`/api/channels/${channel.id}`, cookie, {
			method: "PATCH",
			headers: { origin: "https://chopin.test" },
			body: JSON.stringify({ title: "Launch plan" }),
		}));
		expect(repeated!.status).toBe(200);
		expect(renamed).toEqual(["Launch plan"]);
	});

	it("validates rename titles and preserves a document after a title conflict", async () => {
		let { router, storage, cookie, now } = await setup();
		let channel = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Release plan",
			createdBy: "U_octocat",
			now,
		});
		await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Launch plan",
			createdBy: "U_octocat",
			now,
		});
		let patch = (body: unknown) =>
			router.handle(request(`/api/channels/${channel.id}`, cookie, {
				method: "PATCH",
				headers: { origin: "https://chopin.test" },
				body: JSON.stringify(body),
			}));

		expect((await patch({}))!.status).toBe(400);
		expect((await patch({ title: " " }))!.status).toBe(400);
		expect((await patch({ title: "x".repeat(121) }))!.status).toBe(400);
		let conflict = await patch({ title: "launch PLAN" });
		expect(conflict!.status).toBe(409);
		expect(await conflict!.json()).toEqual({
			error: "a document with this title already exists",
		});
		expect((await storage.channels.get(channel.id))!.title).toBe("Release plan");
	});

	it("requires current write access and the configured origin to rename", async () => {
		let { router, storage, github, cookie, now } = await setup();
		let channel = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Release plan",
			createdBy: "U_octocat",
			now,
		});
		let body = JSON.stringify({ title: "Launch plan" });
		let csrf = await router.handle(request(`/api/channels/${channel.id}`, cookie, {
			method: "PATCH",
			headers: { origin: "https://evil.test" },
			body,
		}));
		expect(csrf!.status).toBe(403);

		github.repo = { ...github.repo, permissions: { pull: true, push: false, admin: false } };
		let viewer = await router.handle(request(`/api/channels/${channel.id}`, cookie, {
			method: "PATCH",
			headers: { origin: "https://chopin.test" },
			body,
		}));
		expect(viewer!.status).toBe(403);
	});

	it("lists matching documents with a query-bound cursor and repository avatar", async () => {
		let { router, storage, cookie, now } = await setup();
		let roadmap;
		for (let title of ["Launch notes", "Launch checklist", "Roadmap"]) {
			let channel = await storage.channels.create({
				id: crypto.randomUUID(),
				repositoryId: "R_score",
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title,
				createdBy: "U_octocat",
				now,
			});
			if (title === "Roadmap") roadmap = channel;
		}
		let lease = await storage.leases.acquire("description-writer", "routes", 60_000);
		await storage.channels.publishDescription({
			channelId: roadmap!.id,
			description: "RFC about payment migration",
			planRevision: 2,
			sourceHash: `sha256:${"a".repeat(64)}`,
			generatorVersion: 1,
			jobId: "description-job",
			now,
			lease: lease!,
		});
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
		let described = await router.handle(request(
			"/api/repositories/octo-org/score/channels?query=payment",
			cookie,
		));
		expect((await described!.json()).channels).toMatchObject([{
			id: roadmap!.id,
			description: "RFC about payment migration",
			descriptionRevision: 1,
		}]);
		let mismatch = await router.handle(request(
			`/api/repositories/octo-org/score/channels?query=road&cursor=${page.nextCursor}`,
			cookie,
		));
		expect(mismatch!.status).toBe(400);
	});

	it("excludes archived documents by default and binds cursors to archive mode", async () => {
		let { router, storage, cookie, now } = await setup();
		let first = await createChannel(storage, now, "First active");
		let second = await createChannel(storage, now, "Second active");
		let archived = await createChannel(storage, now, "Archived plan");
		let archivedAt = new Date(now.getTime() + 1_000);
		await storage.channels.archive({ id: archived.id, now: archivedAt });

		let defaultResponse = await router.handle(request(
			"/api/repositories/octo-org/score/channels",
			cookie,
		));
		expect(defaultResponse!.status).toBe(200);
		let defaultPage = await defaultResponse!.json();
		expect(defaultPage.channels.map((channel: { id: string }) => channel.id).sort()).toEqual(
			[first.id, second.id].sort(),
		);
		expect(defaultPage.channels.every((channel: object) => !("archivedAt" in channel))).toBe(true);

		let includedResponse = await router.handle(request(
			"/api/repositories/octo-org/score/channels?includeArchived=true",
			cookie,
		));
		expect(includedResponse!.status).toBe(200);
		let includedPage = await includedResponse!.json();
		expect(includedPage.channels).toHaveLength(3);
		expect(
			includedPage.channels.find((channel: { id: string }) => channel.id === archived.id),
		).toMatchObject({ id: archived.id, archivedAt: archivedAt.toISOString() });

		let activeFirst = await router.handle(request(
			"/api/repositories/octo-org/score/channels?limit=1",
			cookie,
		));
		let activeCursor = (await activeFirst!.json()).nextCursor;
		expect(activeCursor).toBeString();
		let activeCursorInArchiveMode = await router.handle(request(
			`/api/repositories/octo-org/score/channels?limit=1&includeArchived=true&cursor=${activeCursor}`,
			cookie,
		));
		expect(activeCursorInArchiveMode!.status).toBe(400);

		let includedFirst = await router.handle(request(
			"/api/repositories/octo-org/score/channels?limit=1&includeArchived=true",
			cookie,
		));
		let includedCursor = (await includedFirst!.json()).nextCursor;
		expect(includedCursor).toBeString();
		let includedCursorInActiveMode = await router.handle(request(
			`/api/repositories/octo-org/score/channels?limit=1&cursor=${includedCursor}`,
			cookie,
		));
		expect(includedCursorInActiveMode!.status).toBe(400);
	});

	it("opens archived documents by slug and UUID as manageable but read-only", async () => {
		let { router, storage, cookie, now } = await setup();
		let channel = await createChannel(storage, now, "Archived direct read");
		let archivedAt = new Date(now.getTime() + 1_000);
		await storage.channels.archive({ id: channel.id, now: archivedAt });

		for (
			let path of [
				`/api/repositories/octo-org/score/documents/${channel.slug}`,
				`/api/channels/${channel.id}`,
			]
		) {
			let response = await router.handle(request(path, cookie));
			expect(response!.status).toBe(200);
			expect(await response!.json()).toMatchObject({
				canEdit: false,
				canManage: true,
				channel: { id: channel.id, archivedAt: archivedAt.toISOString() },
			});
		}
	});

	it("lets viewers read archived documents but not archive, restore or delete", async () => {
		let { router, storage, github, cookie, archived, restored, deleted, now } = await setup();
		let active = await createChannel(storage, now, "Viewer active");
		let inactive = await createChannel(storage, now, "Viewer archived");
		await storage.channels.archive({
			id: inactive.id,
			now: new Date(now.getTime() + 1_000),
		});
		github.repo = { ...github.repo, permissions: { pull: true, push: false, admin: false } };

		let read = await router.handle(request(`/api/channels/${inactive.id}`, cookie));
		expect(read!.status).toBe(200);
		expect(await read!.json()).toMatchObject({ canEdit: false, canManage: false });

		for (
			let [method, path] of [
				["POST", `/api/channels/${active.id}/archive`],
				["POST", `/api/channels/${inactive.id}/restore`],
				["DELETE", `/api/channels/${inactive.id}`],
			] as const
		) {
			let response = await router.handle(request(path, cookie, {
				method,
				headers: { origin: "https://chopin.test" },
			}));
			expect(response!.status).toBe(403);
		}
		expect(archived).toEqual([]);
		expect(restored).toEqual([]);
		expect(deleted).toEqual([]);
		expect((await storage.channels.get(active.id))!.archivedAt).toBeUndefined();
		expect((await storage.channels.get(inactive.id))!.archivedAt).toBeDate();
	});

	it("archives and restores idempotently for a writer", async () => {
		let { router, storage, cookie, archived, restored, now } = await setup();
		let channel = await createChannel(storage, now, "Lifecycle");
		let transition = (action: "archive" | "restore") =>
			router.handle(request(`/api/channels/${channel.id}/${action}`, cookie, {
				method: "POST",
				headers: { origin: "https://chopin.test" },
			}));

		let firstArchive = await transition("archive");
		expect(firstArchive!.status).toBe(200);
		let archivedBody = await firstArchive!.json();
		expect(archivedBody).toMatchObject({ canEdit: false, canManage: true });
		expect(archivedBody.channel.archivedAt).toBeString();
		let repeatedArchive = await transition("archive");
		expect(repeatedArchive!.status).toBe(200);
		expect((await repeatedArchive!.json()).channel.archivedAt)
			.toBe(archivedBody.channel.archivedAt);
		expect(archived).toEqual([
			{ id: channel.id, changed: true },
			{ id: channel.id, changed: false },
		]);

		let firstRestore = await transition("restore");
		expect(firstRestore!.status).toBe(200);
		let restoredBody = await firstRestore!.json();
		expect(restoredBody).toMatchObject({ canEdit: true, canManage: true });
		expect(restoredBody.channel).not.toHaveProperty("archivedAt");
		let repeatedRestore = await transition("restore");
		expect(repeatedRestore!.status).toBe(200);
		expect((await repeatedRestore!.json()).channel).not.toHaveProperty("archivedAt");
		expect(restored).toEqual([
			{ id: channel.id, changed: true },
			{ id: channel.id, changed: false },
		]);
	});

	it("requires the exact configured Origin for lifecycle mutations", async () => {
		let { router, storage, cookie, archived, restored, deleted, now } = await setup();
		let active = await createChannel(storage, now, "Origin active");
		let inactive = await createChannel(storage, now, "Origin archived");
		await storage.channels.archive({
			id: inactive.id,
			now: new Date(now.getTime() + 1_000),
		});

		for (
			let [method, path] of [
				["POST", `/api/channels/${active.id}/archive`],
				["POST", `/api/channels/${inactive.id}/restore`],
				["DELETE", `/api/channels/${inactive.id}`],
			] as const
		) {
			for (let origin of [undefined, "https://chopin.test/", "https://chopin.test.evil"]) {
				let response = await router.handle(request(path, cookie, {
					method,
					headers: origin ? { origin } : undefined,
				}));
				expect(response!.status).toBe(403);
			}
		}
		expect(archived).toEqual([]);
		expect(restored).toEqual([]);
		expect(deleted).toEqual([]);
	});

	it("requires archival before deletion and delegates archived deletion", async () => {
		let { router, storage, cookie, deleted, now } = await setup();
		let channel = await createChannel(storage, now, "Delete lifecycle");
		let remove = () =>
			router.handle(request(`/api/channels/${channel.id}`, cookie, {
				method: "DELETE",
				headers: { origin: "https://chopin.test" },
			}));

		let active = await remove();
		expect(active!.status).toBe(409);
		expect(deleted).toEqual([]);
		expect(await storage.channels.get(channel.id)).toBeDefined();

		await storage.channels.archive({
			id: channel.id,
			now: new Date(now.getTime() + 1_000),
		});
		let archived = await remove();
		expect(archived!.status).toBe(204);
		expect(archived!.headers.get("cache-control")).toBe("no-store");
		expect(await archived!.text()).toBe("");
		expect(deleted).toEqual([channel.id]);
		expect(await storage.channels.get(channel.id)).toBeUndefined();
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
