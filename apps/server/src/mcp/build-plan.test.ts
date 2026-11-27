import { afterEach, describe, expect, it } from "bun:test";

import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import { Connections } from "../experiments/connections";
import { Experiments } from "../experiments/service";
import { GitHubError } from "../github/client";
import { handler } from "../mcp";
import * as edit from "../plan/edit";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import * as Rooms from "../rooms";
import { reportBuild } from "../tasks/builds";
import { implementationConnector } from "../tasks/connector";
import { restore as restoreGraph } from "../tasks/graphs";
import { implementationGraphs } from "../tasks/plan-graphs";
import { createBuildStarter } from "../tasks/start-build";
import { openPlan } from "../testing/plan";
import { hosted } from "./hosted";

import type { HostedAuth } from "../auth/routes";
import type {
	GitHub,
	GitHubTokenGrant,
	GitHubUser,
	InstallationPage,
	Repository,
	RepositoryPage,
} from "../github/client";
import type { DraftBuildStarter } from "../tasks/start-build";

const NOW = new Date("2026-11-20T12:00:00.000Z");
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const SAMPLE_TASK = {
	id: "ship-api",
	title: "Ship the API",
	context: "Add the endpoint.",
	goal: "Expose the endpoint cleanly.",
	acceptance: ["Endpoint responds 200.", "Tests pass."],
	dependsOn: [],
};

class FakeGitHub implements GitHub {
	push = true;
	repositoryValue: Repository = {
		id: "R_score",
		owner: "octo-org",
		name: "score",
		fullName: "octo-org/score",
		private: true,
		url: "https://github.test/octo-org/score",
		defaultBranch: "main",
		permissions: { pull: true, push: true, admin: false },
	};

	authorize(): string {
		return "";
	}
	async exchange(): Promise<GitHubTokenGrant> {
		return {
			accessToken: "t",
			accessExpiresIn: 28_800,
			refreshToken: "r",
			refreshExpiresIn: 15_897_600,
		};
	}
	async refresh(): Promise<GitHubTokenGrant> {
		return {
			accessToken: "t",
			accessExpiresIn: 28_800,
			refreshToken: "r",
			refreshExpiresIn: 15_897_600,
		};
	}
	async user(token: string): Promise<GitHubUser> {
		if (token === "denied") throw new GitHubError("bad credentials", 401);
		return { id: `U_${token}`, login: token, avatarUrl: "https://github.test/avatar" };
	}
	async organizationMembership() {
		return undefined;
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
		return {
			...this.repositoryValue,
			owner,
			name,
			fullName: `${owner}/${name}`,
			permissions: { pull: true, push: this.push, admin: false },
		};
	}
	async repositoryAccess(token: string, owner: string, name: string) {
		return this.repository(token, owner, name);
	}
	async installationRepositoryAccess() {
		return undefined;
	}
	invalidate(): void {}
}

let roomsToClear: Rooms.Room[] = [];
let plansToClose: Plan.Plan[] = [];

afterEach(async () => {
	for (let room of roomsToClear.splice(0)) Rooms.forget(room);
	for (let plan of plansToClose.splice(0)) await Plan.close(plan);
});

async function setupBuildFixture(options: {
	draftBuild?: DraftBuildStarter;
	connectAgent?: boolean;
	liveBuild?: boolean;
} = {}) {
	let opened = await openPlan("# Shipping plan\n\nBuild the feature.\n");
	plansToClose.push(opened.plan);
	let storage = opened.storage;
	let channel = (await storage.channels.get(opened.channel.id))!;
	let held = Rooms.hold(channel.id);
	held.room.plan = opened.plan;
	roomsToClear.push(held.room);

	let github = new FakeGitHub();
	github.repositoryValue = {
		...github.repositoryValue,
		id: channel.repositoryId,
		owner: channel.repositoryOwner,
		name: channel.repositoryName,
		fullName: `${channel.repositoryOwner}/${channel.repositoryName}`,
	};
	let clock = () => NOW;
	let config = {
		origin: "https://chopin.test",
		encryptionKey: new Uint8Array(32).fill(7),
		clientId: "client-id",
		clientSecret: "client-secret",
		appSlug: "chopin-test",
	};
	let auth: HostedAuth = {
		config,
		storage,
		github,
		sessions: new Sessions(storage, true, clock),
		machines: new Machines(storage, clock, { origin: config.origin, clientId: config.clientId }),
		admission: new Admission(config, github, () => clock().getTime()),
		clock,
		pairings: {},
	};

	let connections = new Connections();
	if (options.connectAgent !== false) {
		connections.open(
			{
				id: "M_alice",
				owner: "U_alice",
				login: "alice",
				autoRun: false,
				protocol: 8,
			},
			"Alice laptop",
			[{
				repositoryId: channel.repositoryId,
				repository: `${channel.repositoryOwner}/${channel.repositoryName}`,
				branch: "main",
				commit: HEAD,
			}],
		);
	}

	let withPlan = async <T>(id: string, action: (plan: Plan.Plan) => Promise<T>): Promise<T> => {
		if (id !== channel.id) throw new Error("document is unavailable");
		return action(opened.plan);
	};
	let connector = implementationConnector(
		withPlan,
		connections,
		async id => `https://chopin.test/channels/${id}`,
		async id => id === channel.id,
	);
	let starter = createBuildStarter({
		withPlan,
		connections,
		connector,
		liveBuild: options.liveBuild ?? false,
		draftBuild: options.draftBuild,
	});
	let mcp = handler(
		hosted(auth, { lease: () => opened.lease }, {
			startBuild: input => starter.startPlanBuild(input),
		}),
	);

	let call = async (args: Record<string, unknown>, token = "alice") => {
		let res = await mcp(
			new Request("https://chopin.test/mcp", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "build_plan", arguments: args },
				}),
			}),
		);
		return await res.json() as {
			result?: {
				structuredContent?: Record<string, unknown>;
				isError?: boolean;
			};
			error?: { code: number; message: string };
		};
	};

	let draftGraph = async (planRevision = opened.plan.revision) => {
		let version = opened.plan.graph?.versions.at(-1);
		let res = await implementationGraphs().revise(opened.plan, {
			planRevision,
			graphRevision: version?.revision ?? 0,
			operations: version
				? [{ op: "replace", id: SAMPLE_TASK.id, task: SAMPLE_TASK }]
				: [{ op: "add", task: SAMPLE_TASK }],
		});
		if (!res.ok) throw new Error(`could not draft graph: ${res.reason}`);
	};

	return {
		opened,
		channel,
		storage,
		github,
		connections,
		starter,
		call,
		draftGraph,
	};
}

describe("MCP build_plan and shared build starter", () => {
	it("starts a ready graph, records approval provenance, and handles already-building vs implementation-active", async () => {
		let ctx = await setupBuildFixture();
		await ctx.draftGraph();

		let started = await ctx.call({
			id: ctx.channel.id,
			idempotencyKey: "build-op-1",
			planRevision: ctx.opened.plan.revision,
		});
		expect(started.result?.isError).toBeUndefined();
		expect(started.result?.structuredContent).toMatchObject({
			status: "started",
			build: {
				user: "U_alice",
				state: "queued",
				planRevision: ctx.opened.plan.revision,
			},
		});

		// Approval provenance persisted on the approved graph version and survives restore()!
		let version = ctx.opened.plan.graph?.versions.at(-1);
		expect(version).toMatchObject({
			state: "approved",
			approvedBy: "alice",
			operationKey: "build-op-1",
		});
		expect(restoreGraph(JSON.parse(JSON.stringify(ctx.opened.plan.graph)))).toEqual(
			ctx.opened.plan.graph,
		);

		// Same caller + same revision -> idempotent already-building!
		let repeat = await ctx.call({ id: ctx.channel.id });
		expect(repeat.result?.isError).toBeUndefined();
		expect(repeat.result?.structuredContent).toMatchObject({
			status: "already-building",
			build: { id: (started.result!.structuredContent as { build: { id: string } }).build.id },
		});

		// Same caller + mismatched revision -> implementation-active (active check runs first!)
		let wrongRev = await ctx.call({ id: ctx.channel.id, planRevision: 99 });
		expect(wrongRev.result?.isError).toBe(true);
		expect(wrongRev.result?.structuredContent).toMatchObject({ code: "implementation-active" });

		// Different caller -> implementation-active
		let otherUser = await ctx.call({ id: ctx.channel.id }, "bob");
		expect(otherUser.result?.isError).toBe(true);
		expect(otherUser.result?.structuredContent).toMatchObject({ code: "implementation-active" });
	});

	it("enforces revision-conflict, optional requireSettledDecisions gate, and readiness blockers", async () => {
		let ctx = await setupBuildFixture();
		await ctx.draftGraph();

		// Stale planRevision -> revision-conflict
		let stale = await ctx.call({ id: ctx.channel.id, planRevision: 99 });
		expect(stale.result?.isError).toBe(true);
		expect(stale.result?.structuredContent).toEqual({
			code: "revision-conflict",
			revision: ctx.opened.plan.revision,
		});

		// Add an open decision
		await Questions.capture(
			ctx.opened.plan,
			ctx.opened.server,
			ctx.channel.id,
			{
				key: "open-gate-1",
				question: "Use feature flag?",
				block: { index: 1, digest: edit.outline(ctx.opened.plan)[1]!.digest },
			},
			{ revision: ctx.opened.plan.revision },
		);
		await ctx.draftGraph(ctx.opened.plan.revision);

		// requireSettledDecisions: true refuses with open-decisions
		let gated = await ctx.call({
			id: ctx.channel.id,
			requireSettledDecisions: true,
		});
		expect(gated.result?.isError).toBe(true);
		expect(gated.result?.structuredContent).toMatchObject({
			code: "open-decisions",
			openDecisions: [{ status: "open", prompt: "Use feature flag?" }],
		});

		// Required investigation blocks even when requireSettledDecisions is false
		let experiments = new Experiments(ctx.storage.experiments, () => ctx.opened.lease);
		let inv = await experiments.create(
			ctx.channel.id,
			"U_alice",
			"Benchmark latency",
			crypto.randomUUID(),
			undefined,
			"Must confirm p99 under 50ms",
		);
		let blocked = await ctx.call({ id: ctx.channel.id });
		expect(blocked.result?.isError).toBe(true);
		expect(blocked.result?.structuredContent).toMatchObject({
			code: "not-ready",
			blockers: ["required investigations"],
		});

		// Clear blocker -> default requireSettledDecisions: false proceeds to build despite open decision!
		await experiments.setBuildBlocker(ctx.channel.id, inv.id, inv.revision, null);
		let proceeds = await ctx.call({ id: ctx.channel.id });
		expect(proceeds.result?.isError).toBeUndefined();
		expect(proceeds.result?.structuredContent).toMatchObject({ status: "started" });
	});

	it("handles missing/stale graphs: refuses when draftIfNeeded=false or Planner is busy, drafts and auto-queues on save, and clears buildRequested on failure or race", async () => {
		let draftEnded: ReturnType<typeof Promise.withResolvers<void>> | undefined;
		let draftMode: "succeed" | "no-save" | "busy" = "succeed";
		let released = 0;

		let ctx = await setupBuildFixture({
			draftBuild: async ({ planRevision }) => {
				if (draftMode === "busy") {
					return { kind: "planner-busy", message: "Planner is busy" };
				}
				draftEnded = Promise.withResolvers<void>();
				return {
					kind: "drafting",
					planRevision,
					ended: draftEnded.promise,
					release: () => {
						released++;
					},
				};
			},
		});

		// 1. draftIfNeeded: false -> graph-required
		let noDraft = await ctx.call({ id: ctx.channel.id, draftIfNeeded: false });
		expect(noDraft.result?.isError).toBe(true);
		expect(noDraft.result?.structuredContent).toEqual({
			code: "graph-required",
			planRevision: ctx.opened.plan.revision,
		});

		// 2. Planner busy mid-turn -> graph-required with guidance (never deadlocks)
		draftMode = "busy";
		let busy = await ctx.call({ id: ctx.channel.id });
		expect(busy.result?.isError).toBe(true);
		expect(busy.result?.structuredContent).toMatchObject({
			code: "graph-required",
			planRevision: ctx.opened.plan.revision,
		});
		expect((busy.result!.structuredContent as { message?: string }).message).toContain(
			"edit_implementation_graph",
		);
		expect(ctx.opened.plan.buildRequested).toBeUndefined();

		// 3. Draft fails / finishes without saving a graph -> buildRequested cleared cleanly (never orphaned!)
		draftMode = "no-save";
		let draftingFail = await ctx.call({ id: ctx.channel.id });
		expect(draftingFail.result?.structuredContent).toEqual({
			status: "drafting",
			planRevision: ctx.opened.plan.revision,
		});
		expect(ctx.opened.plan.buildRequested).toEqual({
			by: "U_alice",
			revision: ctx.opened.plan.revision,
		});
		draftEnded!.resolve();
		for (let i = 0; i < 40 && ctx.opened.plan.buildRequested; i++) await Bun.sleep(5);
		expect(ctx.opened.plan.buildRequested).toBeUndefined();
		expect(ctx.opened.plan.builds).toHaveLength(0);
		expect(released).toBe(1);

		// 4. Draft saves graph -> server-side auto-queue starts exactly one build and clears buildRequested!
		draftMode = "succeed";
		let draftingOk = await ctx.call({ id: ctx.channel.id, idempotencyKey: "auto-op-1" });
		expect(draftingOk.result?.structuredContent).toEqual({
			status: "drafting",
			planRevision: ctx.opened.plan.revision,
		});
		await ctx.draftGraph(ctx.opened.plan.revision);
		draftEnded!.resolve();
		for (let i = 0; i < 40 && ctx.opened.plan.builds.length === 0; i++) await Bun.sleep(5);
		expect(ctx.opened.plan.builds).toHaveLength(1);
		expect(ctx.opened.plan.builds[0]).toMatchObject({ user: "U_alice", state: "queued" });
		expect(ctx.opened.plan.graph?.versions.at(-1)).toMatchObject({
			state: "approved",
			approvedBy: "alice",
			operationKey: "auto-op-1",
		});
		expect(ctx.opened.plan.buildRequested).toBeUndefined();
		expect(released).toBe(2);
	});

	it("never queues two active builds if a manual build races post-draft auto-queue", async () => {
		let draftEnded = Promise.withResolvers<void>();
		let ctx = await setupBuildFixture({
			draftBuild: async ({ planRevision }) => ({
				kind: "drafting",
				planRevision,
				ended: draftEnded.promise,
			}),
		});

		let drafting = await ctx.call({ id: ctx.channel.id });
		expect(drafting.result?.structuredContent).toMatchObject({ status: "drafting" });
		await ctx.draftGraph(ctx.opened.plan.revision);

		// Concurrent manual build_plan succeeds before auto-queue runs!
		let manual = await ctx.call({ id: ctx.channel.id, idempotencyKey: "manual-race" });
		expect(manual.result?.structuredContent).toMatchObject({ status: "started" });
		expect(ctx.opened.plan.builds).toHaveLength(1);

		// Now draft turn ends -> auto-queue sees active build and queues NOTHING!
		draftEnded.resolve();
		await Bun.sleep(30);
		expect(ctx.opened.plan.builds).toHaveLength(1);
		expect(ctx.opened.plan.buildRequested).toBeUndefined();
	});

	it("supports retry: true after a failed build, rebuild: true on a delivered live build, and refuses child/archived/pull-only", async () => {
		let ctx = await setupBuildFixture();
		await ctx.draftGraph();

		let first = await ctx.call({ id: ctx.channel.id });
		let firstBuild =
			(first.result!.structuredContent as { build: { id: string; connectionId: string } })
				.build;
		await reportBuild(
			ctx.opened.plan,
			"U_alice",
			firstBuild.connectionId,
			firstBuild.id,
			{ state: "failed", error: "network" },
		);
		ctx.connections.release(firstBuild.connectionId, ctx.channel.id);

		// Without retry: true -> retry-required
		let needsRetry = await ctx.call({ id: ctx.channel.id });
		expect(needsRetry.result?.isError).toBe(true);
		expect(needsRetry.result?.structuredContent).toMatchObject({ code: "retry-required" });

		// With retry: true -> started with retryOf!
		let retried = await ctx.call({ id: ctx.channel.id, retry: true });
		expect(retried.result?.isError).toBeUndefined();
		expect(retried.result?.structuredContent).toMatchObject({
			status: "started",
			build: { retryOf: firstBuild.id, state: "queued" },
		});

		// Set up a delivered live build to verify rebuild: true
		let secondBuild = (retried.result!.structuredContent as {
			build: { id: string; connectionId: string };
		}).build;
		await reportBuild(
			ctx.opened.plan,
			"U_alice",
			secondBuild.connectionId,
			secondBuild.id,
			{ state: "failed", error: "done" },
		);
		ctx.connections.release(secondBuild.connectionId, ctx.channel.id);
		ctx.opened.plan.live = {
			buildId: secondBuild.id,
			user: "U_alice",
			repositoryId: ctx.channel.repositoryId,
			checkout: {
				repository: `${ctx.channel.repositoryOwner}/${ctx.channel.repositoryName}`,
				branch: "main",
				commit: HEAD,
			},
			baseRevision: ctx.opened.plan.revision,
			baseSource: Plan.source(ctx.opened.plan),
			pullRequests: ["https://github.com/octo-org/score/pull/1"],
		};

		// No edits since baseSource -> nothing-to-build
		let unchanged = await ctx.call({ id: ctx.channel.id, rebuild: true });
		expect(unchanged.result?.isError).toBe(true);
		expect(unchanged.result?.structuredContent).toMatchObject({ code: "nothing-to-build" });

		// Edit document -> rebuild queues cleanly!
		await Plan.rewrite(
			ctx.opened.plan,
			"# Shipping plan\n\nBuild the updated feature.\n",
			undefined,
		);
		let rebuilt = await ctx.call({ id: ctx.channel.id, rebuild: true });
		expect(rebuilt.result?.isError).toBeUndefined();
		expect(rebuilt.result?.structuredContent).toMatchObject({
			status: "rebuilding",
			build: { kind: "rebuild", state: "queued" },
		});

		// Child document -> child-document refusal
		let child = await ctx.storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: ctx.channel.repositoryId,
			repositoryOwner: ctx.channel.repositoryOwner,
			repositoryName: ctx.channel.repositoryName,
			parentChannelId: ctx.channel.id,
			title: "Research child",
			createdBy: "U_alice",
			now: NOW,
		});
		let childRefused = await ctx.call({ id: child.id });
		expect(childRefused.result?.isError).toBe(true);
		expect(childRefused.result?.structuredContent).toMatchObject({ code: "child-document" });

		// Archived document -> document-archived
		await ctx.storage.channels.archive({ id: ctx.channel.id, now: NOW, lease: ctx.opened.lease });
		let archived = await ctx.call({ id: ctx.channel.id });
		expect(archived.result?.isError).toBe(true);
		expect(archived.result?.structuredContent).toMatchObject({ code: "document-archived" });

		// Pull-only caller -> repository-forbidden
		ctx.github.push = false;
		let pullOnly = await ctx.call({ id: ctx.channel.id });
		expect(pullOnly.result?.isError).toBe(true);
		expect(pullOnly.result?.structuredContent).toMatchObject({ code: "repository-forbidden" });
	});
});
