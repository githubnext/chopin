import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";

import { Admission } from "../auth/admission";
import { Sessions } from "../auth/session";
import { JobRegistry } from "../jobs/registry";
import { researchAnswerDefinition, researchEvidenceDefinition } from "../jobs/research-workspace";
import { JobService } from "../jobs/service";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { registerResearchWorkspaceRoutes } from "./routes";
import { ResearchWorkspaceService } from "./service";

import type { HostedAuth } from "../auth/routes";
import type { GitHub, GitHubTokenGrant, Repository } from "../github/client";

const SOURCE = "# Release plan\n\nShip safely.\n";
const SOURCE_HASH = `sha256:${createHash("sha256").update(SOURCE).digest("hex")}`;
const USER_ID = "MDQ6VXNlcjU0MjcwODM=";
const REPOSITORY_ID = "MDEwOlJlcG9zaXRvcnkxMjM=";
const OTHER_REPOSITORY_ID = "MDEwOlJlcG9zaXRvcnk0NTY=";

function requestId(value: number): string {
	return `10000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
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

class RepositoryAccess {
	affiliated = true;
	repository: Repository = {
		id: REPOSITORY_ID,
		owner: "octo-org",
		ownerAvatarUrl: "https://avatars.test/octo-org.png",
		name: "score",
		fullName: "octo-org/score",
		private: true,
		url: "https://github.test/octo-org/score",
		defaultBranch: "main",
		permissions: { pull: true, push: true, admin: false },
	};

	async repositoryAccess(
		_token: string,
		owner: string,
		name: string,
	): Promise<Repository | undefined> {
		return this.affiliated
			? { ...this.repository, owner, name, fullName: `${owner}/${name}` }
			: undefined;
	}
}

async function setup() {
	let now = new Date("2026-08-23T12:00:00.000Z");
	let storage = new MemoryStorage();
	await storage.users.put({ id: USER_ID, login: "octocat", avatarUrl: "avatar", now });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: REPOSITORY_ID,
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release plan",
		createdBy: USER_ID,
		now,
	});
	let lease = await storage.leases.acquire("chopin:writer", "route-writer", 60_000);
	if (!lease) throw new Error("writer lease unavailable");
	let access = new RepositoryAccess();
	let github = access as unknown as GitHub;
	let config = {
		origin: "https://chopin.test",
		appSlug: "chopin-test",
		clientId: "client-id",
		clientSecret: "client-secret",
		encryptionKey: new Uint8Array(32).fill(4),
	};
	let sessions = new Sessions(storage, true, () => now);
	let issued = await sessions.issue(USER_ID, grant("ghu_user"));
	let auth: HostedAuth = {
		config,
		storage,
		github,
		admission: new Admission(config, github, () => now.getTime()),
		sessions,
		clock: () => now,
	};
	let registry = new JobRegistry([
		researchEvidenceDefinition({
			config: { agent: true, model: "research-model" },
			engine: async () => ({ findings: [], sources: [] }),
		}),
		researchAnswerDefinition({
			config: { agent: true, model: "research-model" },
			engines: {
				private: async () => ({ findings: [] }),
				synthesize: async () => ({
					title: "Report",
					summary: "Summary",
					findings: [],
					caveats: [],
				}),
				answer: async () => ({ text: "Answer", sourceUrls: [] }),
			},
		}),
	]);
	let jobSequence = 0;
	let jobs = new JobService({
		storage,
		registry,
		lease: () => lease,
		now: () => now,
		id: () => `route-job-${++jobSequence}`,
	});
	let entitySequence = 0;
	let service = new ResearchWorkspaceService({
		storage,
		jobs,
		lease: () => lease,
		clock: () => now,
		id: () => `route-entity-${++entitySequence}`,
		current: async channelId => ({
			channelId,
			revision: 1,
			source: SOURCE,
			sourceHash: SOURCE_HASH,
		}),
		publish: () => {},
	});
	let owners: string[] = [];
	let router = new Router();
	registerResearchWorkspaceRoutes(router, auth, {
		service,
		ensureOwner: async ensured => {
			owners.push(ensured.id);
		},
	});
	return {
		storage,
		service,
		jobs,
		router,
		access,
		channel,
		cookie: pair(issued.cookie),
		owners,
		now,
		lease,
	};
}

function request(path: string, cookie?: string, init: RequestInit = {}): Request {
	let headers = new Headers(init.headers);
	if (cookie) headers.set("cookie", cookie);
	return new Request(`https://chopin.test${path}`, { ...init, headers });
}

function mutation(body: unknown, origin = "https://chopin.test"): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify(body),
	};
}

async function create(context: Awaited<ReturnType<typeof setup>>) {
	let response = await context.router.handle(request(
		`/api/channels/${context.channel.id}/research-workspaces`,
		context.cookie,
		mutation({ question: "What changed?", requestId: requestId(1) }),
	));
	if (!response) throw new Error("research create route was not registered");
	return { response, body: await response.json() };
}

async function createInline(context: Awaited<ReturnType<typeof setup>>) {
	let response = await context.router.handle(request(
		`/api/channels/${context.channel.id}/research-requests`,
		context.cookie,
		mutation({ question: "What changed?", requestId: requestId(11) }),
	));
	if (!response) throw new Error("inline research create route was not registered");
	return { response, body: await response.json() };
}

async function failInitial(context: Awaited<ReturnType<typeof setup>>) {
	let [claimed] = await context.storage.jobs.claim({
		channelId: context.channel.id,
		claimOwner: "route-failing-worker",
		count: 1,
		ttlMs: 30_000,
		now: new Date(context.now.getTime() + 1),
		lease: context.lease,
	});
	if (!claimed) throw new Error("route evidence job was not claimable");
	await context.storage.jobs.fail({
		channelId: context.channel.id,
		jobId: claimed.id,
		claimOwner: "route-failing-worker",
		claimGeneration: claimed.claimGeneration,
		reason: "private failure",
		now: new Date(context.now.getTime() + 2),
		lease: context.lease,
	});
}

function retryMutation(origin = "https://chopin.test"): RequestInit {
	return { method: "POST", headers: { origin } };
}

describe("research workspace routes", () => {
	it("enforces authentication, exact origin, write access, and owner timing", async () => {
		let context = await setup();
		let path = `/api/channels/${context.channel.id}/research-workspaces`;
		let anonymous = await context.router.handle(request(
			path,
			undefined,
			mutation({ question: "What changed?", requestId: requestId(1) }),
		));
		expect(anonymous?.status).toBe(401);

		let badOrigin = await context.router.handle(request(
			path,
			context.cookie,
			mutation({ question: "What changed?", requestId: requestId(1) }, "https://evil.test"),
		));
		expect(badOrigin?.status).toBe(403);

		context.access.repository = {
			...context.access.repository,
			permissions: { pull: true, push: false, admin: false },
		};
		let readOnly = await context.router.handle(request(
			path,
			context.cookie,
			mutation({ question: "What changed?", requestId: requestId(1) }),
		));
		expect(readOnly?.status).toBe(403);

		context.access.repository = {
			...context.access.repository,
			permissions: { pull: true, push: true, admin: false },
		};
		let created = await create(context);
		expect(created.response.status).toBe(201);
		expect(created.body.workspace.createdBy).toBe(USER_ID);
		expect(created.response.headers.get("location")).toBeNull();
		expect(context.owners).toEqual([]);

		let confirmed = await context.router.handle(request(
			`${path}/${created.body.workspace.id}/confirm`,
			context.cookie,
			mutation({ query: "What changed?", requestId: requestId(2) }),
		));
		expect(confirmed?.status).toBe(200);
		expect((await confirmed!.json()).workspace.confirmedBy).toBe(USER_ID);
		expect(context.owners).toEqual([context.channel.id]);
		let replayed = await context.router.handle(request(
			`${path}/${created.body.workspace.id}/confirm`,
			context.cookie,
			mutation({ query: "What changed?", requestId: requestId(2) }),
		));
		expect(replayed?.status).toBe(200);
		expect(context.owners).toEqual([context.channel.id]);

		context.access.repository = {
			...context.access.repository,
			permissions: { pull: true, push: false, admin: false },
		};
		let read = await context.router.handle(request(
			`${path}/${created.body.workspace.id}`,
			context.cookie,
		));
		expect(read?.status).toBe(200);
	});

	it("rejects child research before owner setup or durable work", async () => {
		let context = await setup();
		let child = await context.storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: context.channel.repositoryId,
			repositoryOwner: context.channel.repositoryOwner,
			repositoryName: context.channel.repositoryName,
			parentChannelId: context.channel.id,
			title: "Published research child",
			createdBy: USER_ID,
			now: context.now,
		});
		let response = await context.router.handle(request(
			`/api/channels/${child.id}/research-requests`,
			context.cookie,
			mutation({ question: "Create a grandchild", requestId: requestId(1) }),
		));
		if (!response) throw new Error("research create route was not registered");
		let body = await response.json() as { error?: string };
		let durable = await context.storage.research.list(child.id, 100);
		let jobs = (await context.jobs.list(child.id, 100))?.jobs ?? [];

		expect({
			status: response.status,
			error: body.error,
			owners: context.owners,
			requests: durable.length,
			jobs: jobs.length,
		}).toEqual({
			status: 400,
			error: "invalid research workspace request",
			owners: [],
			requests: 0,
			jobs: 0,
		});
	});

	it("starts inline research without replacing private workspace creation", async () => {
		let context = await setup();
		let draft = await create(context);
		expect(draft.body.workspace.origin).toBe("sidebar");
		expect(context.owners).toEqual([]);

		let inline = await createInline(context);
		expect(inline.response.status).toBe(201);
		expect(inline.body).toMatchObject({
			repeated: false,
			request: { question: "What changed?", stage: "queued" },
		});
		expect(context.owners).toEqual([context.channel.id]);
		expect(await context.storage.research.list(context.channel.id, 100)).toHaveLength(2);

		let path = `/api/channels/${context.channel.id}/research-requests/${inline.body.request.id}`;
		let observed = await context.router.handle(request(path, context.cookie));
		expect(observed?.status).toBe(200);
		expect(await observed!.json()).toMatchObject({ id: inline.body.request.id });

		let cancelled = await context.router.handle(request(
			`${path}/cancel`,
			context.cookie,
			mutation({}),
		));
		expect(cancelled?.status).toBe(200);
		expect(await cancelled!.json()).toMatchObject({ stage: "cancelled" });
	});

	it("retries a failed request without minting another workspace", async () => {
		let context = await setup();
		let created = await createInline(context);
		await failInitial(context);
		let path =
			`/api/channels/${context.channel.id}/research-requests/${created.body.request.id}/retry`;

		let retried = await context.router.handle(request(
			path,
			context.cookie,
			retryMutation(),
		));

		expect(retried?.status).toBe(200);
		expect(await retried!.json()).toMatchObject({
			id: created.body.request.id,
			question: created.body.request.question,
			stage: "queued",
		});
		expect(await context.storage.research.list(context.channel.id, 100)).toHaveLength(1);
		expect(context.owners).toEqual([context.channel.id, context.channel.id]);
		expect(
			(await context.router.handle(request(
				path,
				context.cookie,
				retryMutation(),
			)))?.status,
		).toBe(409);
	});

	it("exposes a durably cleared request as retryable after reload", async () => {
		let context = await setup();
		let created = await createInline(context);
		await failInitial(context);
		let detail = await context.storage.research.get(context.channel.id, created.body.request.id);
		let initial = detail!.turns[0]!;
		await context.storage.research.resetInitialAttempt({
			channelId: context.channel.id,
			workspaceId: created.body.request.id,
			expectedEvidenceJobId: initial.evidenceJobId,
			expectedAnswerJobId: initial.answerJobId,
			now: new Date(context.now.getTime() + 3),
			lease: context.lease,
		});
		let path = `/api/channels/${context.channel.id}/research-requests/${created.body.request.id}`;

		let observed = await context.router.handle(request(path, context.cookie));
		expect(observed?.status).toBe(200);
		expect(await observed!.json()).toMatchObject({
			id: created.body.request.id,
			state: "failed",
			stage: "failed",
			error: "Research could not be completed.",
		});
		let retried = await context.router.handle(request(
			`${path}/retry`,
			context.cookie,
			retryMutation(),
		));
		expect(retried?.status).toBe(200);
		expect(await retried!.json()).toMatchObject({
			id: created.body.request.id,
			stage: "queued",
		});
	});

	it("enforces retry origin, authentication, write access, and archive state", async () => {
		let context = await setup();
		let created = await createInline(context);
		await failInitial(context);
		let path =
			`/api/channels/${context.channel.id}/research-requests/${created.body.request.id}/retry`;

		expect((await context.router.handle(request(path, undefined, retryMutation())))?.status)
			.toBe(401);
		expect(
			(await context.router.handle(request(
				path,
				context.cookie,
				retryMutation("https://evil.test"),
			)))?.status,
		).toBe(403);
		context.access.repository = {
			...context.access.repository,
			permissions: { pull: true, push: false, admin: false },
		};
		expect(
			(await context.router.handle(request(
				path,
				context.cookie,
				retryMutation(),
			)))?.status,
		).toBe(403);
		context.access.repository = {
			...context.access.repository,
			permissions: { pull: true, push: true, admin: false },
		};
		await context.storage.channels.archive({
			id: context.channel.id,
			now: new Date(context.now.getTime() + 3),
		});
		expect(
			(await context.router.handle(request(
				path,
				context.cookie,
				retryMutation(),
			)))?.status,
		).toBe(409);
		expect(context.owners).toEqual([context.channel.id]);
	});

	it("returns inaccessible and cross-channel children as not found", async () => {
		let context = await setup();
		let created = await create(context);
		let other = await context.storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: REPOSITORY_ID,
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Other plan",
			createdBy: USER_ID,
			now: context.now,
		});
		let crossChannel = await context.router.handle(request(
			`/api/channels/${other.id}/research-workspaces/${created.body.workspace.id}`,
			context.cookie,
		));
		expect(crossChannel?.status).toBe(404);

		context.access.repository = {
			...context.access.repository,
			id: "MDEwOlJlcG9zaXRvcnk3ODk=",
		};
		let recreated = await context.router.handle(request(
			`/api/channels/${context.channel.id}/research-workspaces/${created.body.workspace.id}`,
			context.cookie,
		));
		expect(recreated?.status).toBe(404);

		context.access.repository = {
			...context.access.repository,
			id: REPOSITORY_ID,
			permissions: { pull: false, push: true, admin: false },
		};
		let noPull = await context.router.handle(request(
			`/api/channels/${context.channel.id}/research-workspaces/${created.body.workspace.id}`,
			context.cookie,
		));
		expect(noPull?.status).toBe(404);
	});

	it("lists repository children in one bounded response without leaking another repository", async () => {
		let context = await setup();
		let created = await create(context);
		let other = await context.storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: OTHER_REPOSITORY_ID,
			repositoryOwner: "octo-org",
			repositoryName: "other",
			title: "Other repository plan",
			createdBy: USER_ID,
			now: context.now,
		});
		await context.service.createDraft({
			channelId: other.id,
			question: "Private to the other repository",
			requestId: requestId(9),
			origin: "sidebar",
			createdBy: USER_ID,
		});

		let response = await context.router.handle(request(
			"/api/repositories/octo-org/score/research-workspaces",
			context.cookie,
		));
		expect(response?.status).toBe(200);
		let body = await response!.json();
		expect(body.channels).toHaveLength(1);
		expect(body.channels[0]).toMatchObject({
			channel: { id: context.channel.id },
			workspaces: [{ id: created.body.workspace.id, channelId: context.channel.id }],
		});
		expect(JSON.stringify(body)).not.toContain("Private to the other repository");
		expect(JSON.stringify(body)).not.toContain("idempotencyKey");
	});

	it("lists only the current channel for authenticated pull readers", async () => {
		let context = await setup();
		let created = await create(context);
		let sibling = await context.storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: REPOSITORY_ID,
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Sibling plan",
			createdBy: USER_ID,
			now: context.now,
		});
		let siblingWorkspace = await context.service.createDraft({
			channelId: sibling.id,
			question: "Sibling-only research",
			requestId: requestId(10),
			origin: "sidebar",
			createdBy: USER_ID,
		});
		let path = `/api/channels/${context.channel.id}/research-workspaces`;
		let anonymous = await context.router.handle(request(path));
		expect(anonymous?.status).toBe(401);

		context.access.repository = {
			...context.access.repository,
			permissions: { pull: true, push: false, admin: false },
		};
		let response = await context.router.handle(request(path, context.cookie));
		expect(response?.status).toBe(200);
		let body = await response!.json();
		expect(body).toMatchObject({
			workspaces: [{ id: created.body.workspace.id, channelId: context.channel.id }],
			truncated: false,
		});
		let serialized = JSON.stringify(body);
		expect(serialized).not.toContain(siblingWorkspace.workspace.id);
		expect(serialized).not.toContain("Sibling-only research");
		expect(serialized).not.toContain("idempotencyKey");
		expect(serialized).not.toContain("fingerprint");

		context.access.repository = {
			...context.access.repository,
			permissions: { pull: false, push: true, admin: false },
		};
		expect((await context.router.handle(request(path, context.cookie)))?.status).toBe(404);
	});
});
