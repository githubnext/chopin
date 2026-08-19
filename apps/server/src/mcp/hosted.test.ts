import { describe, expect, it } from "bun:test";

import { ulid } from "@chopin/dialect";

import { Sessions } from "../auth/session";
import { GitHubError } from "../github/client";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import * as Rooms from "../rooms";
import { MemoryStorage } from "../storage/memory/adapter";
import { implementationGraphs } from "../tasks/plan-graphs";
import { hosted } from "./hosted";

import type { Server } from "bun";
import type { HostedAuth } from "../auth/routes";
import type {
	GitHub,
	GitHubTokenGrant,
	GitHubUser,
	InstallationPage,
	Repository,
	RepositoryPage,
} from "../github/client";
import type { CreateDocumentInput } from "../mcp";
import type { Socket, SocketData } from "../wire";

let creation: CreateDocumentInput = {
	idempotencyKey: "create-plan-1",
	fingerprint: "request-1",
	repository: "octo-org/score",
	baseBranch: "main",
	baseCommit: "0123456789abcdef0123456789abcdef01234567",
	title: "Created plan",
	brief: {
		goal: "Create a collaborative plan.",
		constraints: ["Keep the source canonical."],
		settledDecisions: ["Use hosted storage."],
		openQuestions: ["Who reviews the rollout?"],
		repositoryFindings: ["The repository uses Bun."],
	},
	plan: "# Created\n",
};

let claimTask = {
	id: "claim",
	title: "Claim the graph",
	context: "The graph and run share one durable sidecar.",
	goal: "Lock approved work for one external session.",
	acceptance: ["The graph locks.", "The run is durable."],
	dependsOn: [],
};

function createdDocument(id: string) {
	return {
		id,
		title: creation.title,
		brief: creation.brief,
		source: creation.plan,
		revision: 0,
	};
}

class GitHubBoundary implements GitHub {
	readonly userTokens: string[] = [];
	accessible = true;
	repositoryValue: Repository = {
		id: "R_score",
		owner: "octo-org",
		name: "score",
		fullName: "octo-org/score",
		private: true,
		url: "https://github.test/octo-org/score",
		defaultBranch: "main",
		permissions: { pull: true, push: false, admin: false },
	};

	authorize(): string {
		return "";
	}

	async exchange(): Promise<GitHubTokenGrant> {
		return grant("access-token");
	}

	async refresh(): Promise<GitHubTokenGrant> {
		return grant("refreshed-access-token");
	}

	async user(token: string): Promise<GitHubUser> {
		this.userTokens.push(token);
		if (token === "denied") throw new GitHubError("bad credentials", 401);
		return { id: `U_${token}`, login: token, avatarUrl: "https://github.test/avatar" };
	}

	async repositories(): Promise<RepositoryPage> {
		return { repositories: [], nextPage: undefined };
	}

	async installations(): Promise<InstallationPage> {
		return { installations: [], nextPage: undefined };
	}

	async installationRepositories(): Promise<RepositoryPage> {
		return this.repositories();
	}

	async repository(_token: string, owner: string, name: string): Promise<Repository> {
		return this.value(owner, name);
	}

	async repositoryAccess(
		_token: string,
		owner: string,
		name: string,
	): Promise<Repository | undefined> {
		return this.accessible ? this.value(owner, name) : undefined;
	}

	invalidate(): void {}

	private value(owner: string, name: string): Repository {
		return {
			...this.repositoryValue,
			owner,
			name,
			fullName: `${owner}/${name}`,
			url: `https://github.test/${owner}/${name}`,
		};
	}
}

function grant(accessToken: string): GitHubTokenGrant {
	return {
		accessToken,
		accessExpiresIn: 28_800,
		refreshToken: "refresh-token",
		refreshExpiresIn: 15_897_600,
	};
}

function setup() {
	let now = new Date("2026-08-17T12:00:00.000Z");
	let storage = new MemoryStorage();
	let github = new GitHubBoundary();
	let key = new Uint8Array(32).fill(3);
	let auth: HostedAuth = {
		config: {
			origin: "https://chopin.test",
			appSlug: "chopin-test",
			clientId: "client-id",
			clientSecret: "client-secret",
			encryptionKey: key,
		},
		storage,
		github,
		sessions: new Sessions(storage, true, () => now),
		clock: () => now,
	};
	return { auth, github, now, storage };
}

function request(authorization?: string | Headers): Request {
	let headers = authorization instanceof Headers
		? authorization
		: authorization
		? new Headers({ authorization })
		: undefined;
	return new Request("https://chopin.test/mcp", { headers });
}

async function plan(context: ReturnType<typeof setup>) {
	await context.storage.users.put({
		id: "U_allowed",
		login: "allowed",
		avatarUrl: "",
		now: context.now,
	});
	let channel = await context.storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release readiness",
		createdBy: "U_allowed",
		now: context.now,
	});
	let lease = await context.storage.leases.acquire("writer", "mcp-test", 60_000);
	if (!lease) throw new Error("could not acquire test lease");
	let server = { publish() {} } as unknown as Server<SocketData>;
	let backend: Service.Backend = {
		storage: context.storage,
		lease: () => lease,
		fatal: err => {
			throw err;
		},
	};
	return { channel, lease, server, plan: await Service.open(channel.id, backend, server) };
}

describe("the hosted MCP adapter", () => {
	it("accepts exactly one bearer token and validates its GitHub identity per request", async () => {
		let { auth, github } = setup();
		let adapter = hosted(auth);
		let duplicate = new Headers();
		duplicate.append("authorization", "Bearer first");
		duplicate.append("authorization", "Bearer second");

		expect(await adapter.caller(request())).toBeUndefined();
		expect(await adapter.caller(request("Basic token"))).toBeUndefined();
		expect(await adapter.caller(request(duplicate))).toBeUndefined();
		expect(await adapter.caller(request("Bearer denied"))).toBeUndefined();
		expect(await adapter.caller(request("Bearer allowed"))).toEqual({
			oauthToken: "allowed",
			user: {
				id: "U_allowed",
				login: "allowed",
				avatarUrl: "https://github.test/avatar",
			},
		});
		expect(await adapter.caller(request("bearer allowed"))).toBeDefined();
		expect(await adapter.caller(request("Bearer token+/=="))).toBeDefined();
		expect(github.userTokens).toEqual(["denied", "allowed", "allowed", "token+/=="]);
	});

	it("lists every channel under the currently readable repository node id", async () => {
		let { auth, github, now, storage } = setup();
		await storage.users.put({ id: "U_allowed", login: "allowed", avatarUrl: "", now });
		for (let index = 0; index < 101; index++) {
			await storage.channels.create({
				id: crypto.randomUUID(),
				repositoryId: "R_score",
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: `Plan ${String(index).padStart(3, "0")}`,
				createdBy: "U_allowed",
				now,
			});
		}
		await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_foreign",
			repositoryOwner: "elsewhere",
			repositoryName: "private",
			title: "Foreign title",
			createdBy: "U_allowed",
			now,
		});
		let adapter = hosted(auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");

		let listed = await adapter.documents.list(caller, "octo-org/score");
		expect(listed).toHaveLength(101);
		expect(listed.map(document => document.title)).not.toContain("Foreign title");

		github.repositoryValue = {
			...github.repositoryValue,
			permissions: { pull: false, push: true, admin: false },
		};
		expect(await adapter.documents.list(caller, "octo-org/score")).toEqual([]);
		github.accessible = false;
		expect(await adapter.documents.list(caller, "octo-org/score")).toEqual([]);
	});

	it("creates a durable repository channel for a caller with write access", async () => {
		let context = setup();
		context.github.repositoryValue = {
			...context.github.repositoryValue,
			permissions: { pull: true, push: true, admin: false },
		};
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");
		if (!adapter.create) throw new Error("hosted creation adapter is unavailable");

		let result = await adapter.create.create(caller, creation);
		expect(result.kind).toBe("created");
		if (result.kind !== "created") return;
		let expected = createdDocument(result.document.id);
		expect(result.document).toEqual({
			...expected,
			url: `/channels/${result.document.id}`,
		});
		let stored = await context.storage.collaboration.load(result.document.id, context.now);
		if (!stored) throw new Error("created channel was not stored");
		expect(await Service.readStored(stored)).toMatchObject({
			creation: {
				brief: creation.brief,
				origin: expect.objectContaining({
					idempotencyKey: creation.idempotencyKey,
					fingerprint: creation.fingerprint,
				}),
			},
		});
		expect(await adapter.documents.read(caller, result.document.id)).toEqual(expected);
	});

	it("requires repository write access before creating a channel", async () => {
		let context = setup();
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");
		if (!adapter.create) throw new Error("hosted creation adapter is unavailable");

		expect(await adapter.create.create(caller, creation)).toEqual({ kind: "forbidden" });
		expect((await context.storage.channels.scan("R_score", 10)).channels).toEqual([]);
	});

	it("replays an accepted idempotent creation request", async () => {
		let context = setup();
		context.github.repositoryValue = {
			...context.github.repositoryValue,
			permissions: { pull: true, push: true, admin: false },
		};
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");
		if (!adapter.create) throw new Error("hosted creation adapter is unavailable");

		let first = await adapter.create.create(caller, creation);
		expect(first.kind).toBe("created");
		if (first.kind !== "created") return;
		expect(await adapter.create.create(caller, creation)).toEqual({
			kind: "replayed",
			document: {
				...createdDocument(first.document.id),
				url: `/channels/${first.document.id}`,
			},
		});
	});

	it("rejects changed content under an accepted idempotency key", async () => {
		let context = setup();
		context.github.repositoryValue = {
			...context.github.repositoryValue,
			permissions: { pull: true, push: true, admin: false },
		};
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");
		if (!adapter.create) throw new Error("hosted creation adapter is unavailable");
		await adapter.create.create(caller, creation);

		expect(
			await adapter.create.create(caller, {
				...creation,
				fingerprint: "changed-request",
				title: "Changed title",
			}),
		).toEqual({ kind: "conflict" });
	});

	it("reconstructs a stored checkpoint and journal with the validated plan revision", async () => {
		let context = setup();
		let opened = await plan(context);
		let mutation = Room.insertDecision(opened.plan.document, {
			id: ulid(),
			quote: "Ship the release",
			by: "allowed",
			at: "2026-08-17T12:00:00.000Z",
			notes: [{ by: "allowed", text: "The checks are green" }],
		});
		if (!mutation) throw new Error("test mutation was empty");
		await Service.publish(opened.plan, opened.server, opened.channel.id, mutation);
		let stored = await context.storage.collaboration.load(opened.channel.id, context.now);
		expect(stored?.updates).toHaveLength(1);
		let expectedSource = Service.source(opened.plan);
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");

		expect(await adapter.documents.read(caller, opened.channel.id)).toEqual({
			id: opened.channel.id,
			title: "Release readiness",
			source: expectedSource,
			revision: 1,
		});
		await Service.close(opened.plan);
	});

	it("reads an open plan from its authoritative live document", async () => {
		let context = setup();
		let opened = await plan(context);
		let mutation = Room.insertDecision(opened.plan.document, {
			id: ulid(),
			quote: "Live and not checkpointed",
			by: "allowed",
			at: "2026-08-17T12:00:00.000Z",
			notes: [{ by: "allowed", text: "Read the live document" }],
		});
		if (!mutation) throw new Error("test mutation was empty");
		opened.plan.revision = 9;
		let socket = {
			data: { room: opened.channel.id, client: "mcp-test" },
		} as unknown as Socket;
		let live = Rooms.join(socket);
		live.plan = opened.plan;
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");

		try {
			expect(await adapter.documents.read(caller, opened.channel.id)).toEqual({
				id: opened.channel.id,
				title: "Release readiness",
				source: Service.source(opened.plan),
				revision: 9,
			});
		} finally {
			Rooms.forget(live);
			await Service.close(opened.plan);
		}
	});

	it("reads a live created plan with its public brief but not provenance", async () => {
		let context = setup();
		context.github.repositoryValue = {
			...context.github.repositoryValue,
			permissions: { pull: true, push: true, admin: false },
		};
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");
		if (!adapter.create) throw new Error("hosted creation adapter is unavailable");
		let result = await adapter.create.create(caller, creation);
		if (result.kind !== "created") throw new Error("test plan was not created");
		let lease = await context.storage.leases.acquire("writer", "mcp-test", 60_000);
		if (!lease) throw new Error("could not acquire test lease");
		let server = { publish() {} } as unknown as Server<SocketData>;
		let opened = await Service.open(result.document.id, {
			storage: context.storage,
			lease: () => lease,
			fatal: error => {
				throw error;
			},
		}, server);
		let socket = {
			data: { room: result.document.id, client: "mcp-test" },
		} as unknown as Socket;
		let live = Rooms.join(socket);
		live.plan = opened;

		try {
			expect(await adapter.documents.read(caller, result.document.id)).toEqual(
				createdDocument(result.document.id),
			);
		} finally {
			Rooms.forget(live);
			await Service.close(opened);
		}
	});

	it("reports implemented and delivered lifecycle history for a live hosted plan", async () => {
		let context = setup();
		context.github.repositoryValue = {
			...context.github.repositoryValue,
			permissions: { pull: true, push: true, admin: false },
		};
		let opened = await plan(context);
		opened.plan.creation = {
			brief: creation.brief,
			origin: {
				idempotencyKey: creation.idempotencyKey,
				fingerprint: creation.fingerprint,
				repository: creation.repository,
				baseBranch: creation.baseBranch,
				baseCommit: creation.baseCommit,
				title: creation.title,
			},
		};
		expect(
			(await implementationGraphs().revise(opened.plan, {
				planRevision: 0,
				graphRevision: 0,
				operations: [{ op: "add", task: claimTask }],
			})).ok,
		).toBe(true);
		expect((await implementationGraphs().approve(opened.plan)).ok).toBe(true);
		let socket = {
			data: { room: opened.channel.id, client: "mcp-test" },
		} as unknown as Socket;
		let live = Rooms.join(socket);
		live.plan = opened.plan;
		let adapter = hosted(context.auth, { lease: () => opened.lease });
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller || !adapter.implementations) throw new Error("implementation adapter unavailable");

		try {
			let claimed = await adapter.implementations.startImplementation(caller, {
				id: opened.channel.id,
				planRevision: 0,
				graphVersion: 1,
				graphRevision: 1,
				repository: "octo-org/score",
				branch: "tq/017",
				commit: "deadbeef",
				client: { name: "Codex", version: "1.2.3", session: "session-1" },
			});
			expect(claimed).toMatchObject({ kind: "started" });
			if (claimed.kind !== "started") throw new Error("implementation was not claimed");
			let report = adapter.implementations.reportLifecycle;
			if (!report) throw new Error("lifecycle adapter unavailable");
			for (
				let event of [
					{
						id: opened.channel.id,
						kind: "start" as const,
						runId: claimed.run.id,
						taskId: "claim",
						idempotencyKey: "live-start",
					},
					{
						id: opened.channel.id,
						kind: "report_pr" as const,
						runId: claimed.run.id,
						taskId: "claim",
						url: "https://github.com/octo-org/score/pull/49",
						state: "open" as const,
						idempotencyKey: "live-pr",
					},
					{
						id: opened.channel.id,
						kind: "complete" as const,
						runId: claimed.run.id,
						taskId: "claim",
						summary: "The live graph is durable.",
						idempotencyKey: "live-complete",
					},
					{
						id: opened.channel.id,
						kind: "report_verification" as const,
						runId: claimed.run.id,
						passed: true,
						summary: "The implementation passed review.",
						reviewerMethod: "Ran the focused implementation suite.",
						evidence: [{ taskId: "claim", evidence: ["Focused suite passed."] }],
						tasksNeedingWork: [],
						idempotencyKey: "live-verification",
					},
				]
			) {
				let result = await report(caller, event);
				expect(result).toMatchObject({ kind: "accepted" });
				if (event.kind === "report_verification") {
					expect(result).toMatchObject({
						lifecycle: {
							execution: { state: "idle" },
							history: [{ outcome: { kind: "implemented" } }],
						},
					});
				}
			}
			expect(opened.plan.execution).toBeUndefined();
			expect(opened.plan.lifecycle.history[0]?.events.some(event => "runId" in event)).toBe(false);
			expect(
				await report(caller, {
					id: opened.channel.id,
					kind: "report_pr",
					runId: claimed.run.id,
					taskId: "claim",
					url: "https://github.com/octo-org/score/pull/49",
					state: "merged",
					idempotencyKey: "live-merge",
				}),
			).toMatchObject({
				kind: "accepted",
				lifecycle: { history: [{ outcome: { kind: "delivered" } }] },
			});
			expect(await adapter.implementations.readImplementation(caller, opened.channel.id))
				.toMatchObject({
					execution: { state: "idle" },
					history: [{ outcome: { kind: "delivered" } }],
				});
		} finally {
			Rooms.forget(live);
			await Service.close(opened.plan);
		}
	});

	it("atomically stores one implementation claim for a closed hosted plan", async () => {
		let context = setup();
		context.github.repositoryValue = {
			...context.github.repositoryValue,
			permissions: { pull: true, push: true, admin: false },
		};
		let opened = await plan(context);
		opened.plan.creation = {
			brief: creation.brief,
			origin: {
				idempotencyKey: creation.idempotencyKey,
				fingerprint: creation.fingerprint,
				repository: creation.repository,
				baseBranch: creation.baseBranch,
				baseCommit: creation.baseCommit,
				title: creation.title,
			},
		};
		let graph = await implementationGraphs().revise(opened.plan, {
			planRevision: 0,
			graphRevision: 0,
			operations: [{ op: "add", task: claimTask }],
		});
		expect(graph.ok).toBe(true);
		expect((await implementationGraphs().approve(opened.plan)).ok).toBe(true);
		await Service.close(opened.plan);

		let adapter = hosted(context.auth, { lease: () => opened.lease });
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller || !adapter.implementations) throw new Error("implementation adapter unavailable");
		let input = {
			id: opened.channel.id,
			planRevision: 0,
			graphVersion: 1,
			graphRevision: 1,
			repository: "octo-org/score",
			branch: "tq/017",
			commit: "deadbeef",
			client: { name: "Codex", version: "1.2.3", session: "session-1" },
		};
		expect(
			await adapter.implementations.startImplementation(caller, {
				...input,
				graphVersion: 2,
			}),
		).toEqual({ kind: "refused", reason: "run" });
		let claimed = await adapter.implementations.startImplementation(caller, input);
		expect(claimed).toMatchObject({
			kind: "started",
			run: {
				user: "allowed",
				client: { name: "Codex", version: "1.2.3" },
				session: "session-1",
			},
		});
		if (claimed.kind !== "started") throw new Error("implementation was not claimed");

		let stored = await context.storage.collaboration.load(opened.channel.id, context.now);
		if (!stored) throw new Error("claimed plan was not stored");
		expect(await Service.readStored(stored)).toMatchObject({
			graph: { versions: [{ state: "locked" }] },
			execution: { branch: "tq/017", commit: "deadbeef" },
		});
		expect(await adapter.implementations.readImplementation(caller, opened.channel.id))
			.toMatchObject({
				graph: { state: "locked" },
				execution: { state: "active", run: { session: "session-1" } },
			});
		expect(await adapter.implementations.startImplementation(caller, input)).toMatchObject({
			kind: "active",
			run: { session: "session-1" },
		});
		let report = adapter.implementations.reportLifecycle;
		expect(report).toBeTypeOf("function");
		if (!report) return;
		let start = {
			id: opened.channel.id,
			kind: "start" as const,
			runId: claimed.run.id,
			taskId: "claim",
			idempotencyKey: "start-claim",
		};
		expect(await report(caller, start)).toMatchObject({
			kind: "accepted",
			lifecycle: {
				activity: { tasks: [{ id: "claim", state: "in_progress" }] },
			},
		});
		expect(await report(caller, start)).toMatchObject({ kind: "replayed" });
		let progressed = await context.storage.collaboration.load(opened.channel.id, context.now);
		if (!progressed) throw new Error("lifecycle progress was not stored");
		expect((await Service.readStored(progressed)).lifecycle).toMatchObject({
			events: [{ kind: "start", taskId: "claim", idempotencyKey: "start-claim" }],
		});
		expect(
			await report(caller, {
				id: opened.channel.id,
				kind: "request_revision",
				runId: claimed.run.id,
				reason: "The graph needs another delivery step.",
				idempotencyKey: "request-revision",
			}),
		).toMatchObject({
			kind: "accepted",
			lifecycle: {
				execution: { state: "idle" },
				history: [{ outcome: { kind: "revision_requested" } }],
			},
		});
		let released = await context.storage.collaboration.load(opened.channel.id, context.now);
		if (!released) throw new Error("released lifecycle was not stored");
		let durable = await Service.readStored(released);
		expect(durable).toMatchObject({
			graph: { versions: [{ state: "approved" }] },
		});
		expect(durable.lifecycle?.history[0]?.events.at(-1)).toMatchObject({
			kind: "request_revision",
			reason: "The graph needs another delivery step.",
		});
		expect(durable.lifecycle?.history[0]).not.toHaveProperty("outcome");
		expect(durable.execution).toBeUndefined();
	});

	it("refuses a verified graph but claims a new version for a closed hosted plan", async () => {
		let context = setup();
		context.github.repositoryValue = {
			...context.github.repositoryValue,
			permissions: { pull: true, push: true, admin: false },
		};
		let opened = await plan(context);
		opened.plan.creation = {
			brief: creation.brief,
			origin: {
				idempotencyKey: creation.idempotencyKey,
				fingerprint: creation.fingerprint,
				repository: creation.repository,
				baseBranch: creation.baseBranch,
				baseCommit: creation.baseCommit,
				title: creation.title,
			},
		};
		expect(
			(await implementationGraphs().revise(opened.plan, {
				planRevision: 0,
				graphRevision: 0,
				operations: [{ op: "add", task: claimTask }],
			})).ok,
		).toBe(true);
		expect((await implementationGraphs().approve(opened.plan)).ok).toBe(true);
		await Service.close(opened.plan);

		let adapter = hosted(context.auth, { lease: () => opened.lease });
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller || !adapter.implementations) throw new Error("implementation adapter unavailable");
		let input = {
			id: opened.channel.id,
			planRevision: 0,
			graphVersion: 1,
			graphRevision: 1,
			repository: "octo-org/score",
			branch: "tq/017",
			commit: "deadbeef",
			client: { name: "Codex", version: "1.2.3", session: "session-1" },
		};
		let claimed = await adapter.implementations.startImplementation(caller, input);
		expect(claimed).toMatchObject({ kind: "started" });
		if (claimed.kind !== "started") throw new Error("implementation was not claimed");
		let report = adapter.implementations.reportLifecycle;
		if (!report) throw new Error("lifecycle adapter unavailable");
		for (
			let event of [
				{
					id: opened.channel.id,
					kind: "start" as const,
					runId: claimed.run.id,
					taskId: "claim",
					idempotencyKey: "verified-start",
				},
				{
					id: opened.channel.id,
					kind: "report_pr" as const,
					runId: claimed.run.id,
					taskId: "claim",
					url: "https://github.com/octo-org/score/pull/49",
					state: "open" as const,
					idempotencyKey: "verified-pr",
				},
				{
					id: opened.channel.id,
					kind: "complete" as const,
					runId: claimed.run.id,
					taskId: "claim",
					summary: "The graph is durable.",
					idempotencyKey: "verified-complete",
				},
				{
					id: opened.channel.id,
					kind: "report_verification" as const,
					runId: claimed.run.id,
					passed: true,
					summary: "The implementation passed review.",
					reviewerMethod: "Ran the focused implementation suite.",
					evidence: [{ taskId: "claim", evidence: ["Focused suite passed."] }],
					tasksNeedingWork: [],
					idempotencyKey: "verified-report",
				},
			]
		) {
			expect(await report(caller, event)).toMatchObject({ kind: "accepted" });
		}
		expect(await adapter.implementations.readImplementation(caller, opened.channel.id))
			.toMatchObject({
				execution: { state: "idle" },
				history: [{
					outcome: { kind: "implemented" },
					progress: { verification: { passed: true } },
				}],
			});
		let verifiedStored = await context.storage.collaboration.load(opened.channel.id, context.now);
		if (!verifiedStored) throw new Error("verified lifecycle was not stored");
		let verifiedDurable = await Service.readStored(verifiedStored);
		expect(verifiedDurable.execution).toBeUndefined();
		expect(verifiedDurable.lifecycle?.history[0]?.events.at(-1)).toMatchObject({
			kind: "report_verification",
			passed: true,
		});
		expect(verifiedDurable.lifecycle?.history[0]?.events.some(event => "runId" in event)).toBe(
			false,
		);

		expect(
			await adapter.implementations.startImplementation(caller, {
				...input,
				client: { ...input.client, session: "session-2" },
			}),
		).toEqual({ kind: "refused", reason: "already-verified" });

		let reopened = await Service.open(opened.channel.id, {
			storage: context.storage,
			lease: () => opened.lease,
			fatal: error => {
				throw error;
			},
		}, opened.server);
		expect(
			(await implementationGraphs().revise(reopened, {
				planRevision: 0,
				graphRevision: 1,
				operations: [{ op: "replace", id: "claim", task: claimTask }],
			})).ok,
		).toBe(true);
		expect((await implementationGraphs().approve(reopened)).ok).toBe(true);
		await Service.close(reopened);

		let newer = await adapter.implementations.startImplementation(caller, {
			...input,
			graphVersion: 2,
			client: { ...input.client, session: "session-2" },
		});
		expect(newer).toMatchObject({ kind: "started" });
		if (newer.kind !== "started") throw new Error("new implementation was not claimed");
		let beforeMerge = await context.storage.collaboration.load(opened.channel.id, context.now);
		if (!beforeMerge) throw new Error("new implementation was not stored");
		let beforeMergeState = await Service.readStored(beforeMerge);
		expect(
			await report(caller, {
				id: opened.channel.id,
				kind: "report_pr",
				runId: claimed.run.id,
				taskId: "claim",
				url: "https://github.com/octo-org/score/pull/49",
				state: "merged",
				idempotencyKey: "verified-merge",
			}),
		).toMatchObject({
			kind: "accepted",
			lifecycle: {
				execution: { state: "active" },
				activity: { tasks: [{ id: "claim", state: "queued" }] },
				history: [{ outcome: { kind: "delivered" } }],
			},
		});
		let mergedStored = await context.storage.collaboration.load(opened.channel.id, context.now);
		if (!mergedStored) throw new Error("delivered lifecycle was not stored");
		let mergedState = await Service.readStored(mergedStored);
		expect(mergedState.execution).toEqual(beforeMergeState.execution);
		expect(mergedState.lifecycle?.events).toEqual(beforeMergeState.lifecycle?.events);
		expect(mergedState.lifecycle?.history[0]?.events.at(-1)).toMatchObject({
			kind: "report_pr",
			state: "merged",
		});
	});

	it("makes an inaccessible channel indistinguishable from a missing channel", async () => {
		let context = setup();
		let opened = await plan(context);
		await Service.close(opened.plan);
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");
		let missing = await adapter.documents.read(caller, crypto.randomUUID());
		context.github.repositoryValue = {
			...context.github.repositoryValue,
			id: "R_replaced",
			permissions: { pull: true, push: true, admin: true },
		};

		expect(await adapter.documents.read(caller, opened.channel.id)).toBe(missing);
		context.github.repositoryValue = {
			...context.github.repositoryValue,
			id: "R_score",
			permissions: { pull: false, push: true, admin: true },
		};
		expect(await adapter.documents.read(caller, opened.channel.id)).toBe(missing);
		expect(missing).toBeUndefined();
	});

	it("treats malformed durable state as an absent channel", async () => {
		let context = setup();
		let opened = await plan(context);
		await Service.close(opened.plan);
		let stored = await context.storage.collaboration.load(opened.channel.id, context.now);
		if (!stored?.snapshot) throw new Error("test channel has no checkpoint");
		await context.storage.collaboration.commit({
			channelId: opened.channel.id,
			lease: opened.lease,
			expectedRevision: stored.channel.revision,
			operationId: crypto.randomUUID(),
			epoch: stored.snapshot.epoch,
			sidecar: { version: 1, revision: 40 },
			events: [],
			now: context.now,
		});
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");

		expect(await adapter.documents.read(caller, opened.channel.id)).toBeUndefined();
	});

	it("treats an invalid open questionnaire as absent durable state", async () => {
		let context = setup();
		let opened = await plan(context);
		await Service.close(opened.plan);
		let stored = await context.storage.collaboration.load(opened.channel.id, context.now);
		if (!stored?.snapshot) throw new Error("test channel has no checkpoint");
		await context.storage.collaboration.commit({
			channelId: opened.channel.id,
			lease: opened.lease,
			expectedRevision: stored.channel.revision,
			operationId: crypto.randomUUID(),
			epoch: stored.snapshot.epoch,
			sidecar: {
				version: 1,
				revision: 40,
				documentSeq: 0,
				questions: [{ id: "question-1", status: "open", definition: {} }],
				openQuestions: [{
					id: "question-1",
					definition: {},
					model: [],
					revision: -1,
				}],
				threads: [],
				transcript: [],
			},
			events: [],
			now: context.now,
		});
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");

		expect(await adapter.documents.read(caller, opened.channel.id)).toBeUndefined();
	});
});
