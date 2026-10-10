import { describe, expect, it, spyOn } from "bun:test";

import { LiveSyncCoordinator } from "./live-sync";
import { liveSnapshot, reportBuild, reportRebuild } from "./builds";
import { implementationStatus } from "./notifications";
import { MemoryStorage } from "../storage/memory/adapter";
import { close, implementationActive, open, rewrite, source } from "../plan/service";

import type { Server } from "bun";
import type { Connection } from "../experiments/connections";
import type { Backend, Plan } from "../plan/service";
import type { LiveDelta } from "./live-sync";
import type { SocketData } from "../wire";

const now = new Date("2026-10-10T12:00:00.000Z");
const buildId = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

function connection(id: string, owner = "octocat"): Connection {
	return {
		id,
		owner,
		login: owner,
		sessionId: "session",
		label: "Laptop",
		source: {
			repositoryId: "R_score",
			repository: "octo-org/score",
			branch: "main",
			commit: "b".repeat(40),
		},
		expiresAt: Number.MAX_SAFE_INTEGER,
	};
}

/** A live document whose current source already differs from what was built. */
async function harness(
	options: {
		liveBuild?: boolean;
		classify?: (delta: LiveDelta) => boolean;
		/** Runs after each document-locked action releases the lock. */
		unlocked?: () => Promise<void>;
	} = {},
) {
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_octocat", login: "octocat", avatarUrl: "", now });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Living document",
		createdBy: "U_octocat",
		now,
	});
	let lease = await storage.leases.acquire("writer", "live-sync-test", 60_000);
	if (!lease) throw new Error("could not acquire test lease");
	let coordinator: LiveSyncCoordinator | undefined;
	let backend: Backend = {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
		liveBuild: options.liveBuild ?? true,
		onBuildStopped: id => coordinator?.stopped(id),
	};
	let server = { publish() {} } as unknown as Server<SocketData>;
	let plan = await open(channel.id, backend, server);
	plan.builds = [{
		id: buildId,
		user: "octocat",
		connectionId: "gone",
		repositoryId: "R_score",
		checkout: { repository: "octo-org/score", branch: "main", commit: "a".repeat(40) },
		planRevision: plan.revision,
		graphVersion: 1,
		graphRevision: 1,
		createdAt: now.toISOString(),
		expiresAt: now.getTime(),
		state: "stopped",
	}];
	plan.live = {
		buildId,
		user: "octocat",
		repositoryId: "R_score",
		checkout: { repository: "octo-org/score", branch: "main", commit: "a".repeat(40) },
		baseRevision: plan.revision,
		baseSource: `${source(plan)}\nThe built paragraph.\n`,
		pullRequests: ["https://github.com/octo-org/score/pull/49"],
	};
	let timers: Array<{ at: number; action: () => void; cancelled: boolean }> = [];
	let clock = 0;
	let queued: string[] = [];
	let deltas: LiveDelta[] = [];
	let available = [connection("laptop")];
	let assignments = new Map<string, string>();
	coordinator = new LiveSyncCoordinator({
		withPlan: async (_id, action) => {
			let result = await action(plan);
			await options.unlocked?.();
			return result;
		},
		connections: {
			get: id => available.find(item => item.id === id),
			list: (repositoryId, owner) =>
				available.filter(item =>
					item.source.repositoryId === repositoryId && (owner === undefined || item.owner === owner)
				),
			assign: (connectionId, documentId) => assignments.set(connectionId, documentId),
			assigned: connectionId => assignments.get(connectionId),
		},
		classifier: {
			classify: async delta => {
				deltas.push(delta);
				return options.classify?.(delta) ?? true;
			},
		},
		queued: (_id, build) => queued.push(build.id),
		after: (delay, action) => {
			let timer = { at: clock + delay, action, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		error: error => {
			throw error;
		},
	});
	let live = coordinator;
	return {
		plan,
		coordinator: live,
		available,
		assignments,
		queued,
		deltas,
		edit: () => live.schedule({ channelId: plan.id }),
		/** Advance the fake clock and let any fired check settle. */
		async advance(ms: number) {
			clock += ms;
			for (let timer of timers.filter(item => !item.cancelled && item.at <= clock)) {
				timer.cancelled = true;
				timer.action();
			}
			await settle(plan);
		},
		async stop(state: "stopped" | "failed" = "stopped") {
			let build = plan.builds.at(-1)!;
			if (build.state === "queued") {
				plan.builds = [...plan.builds.slice(0, -1), { ...build, state: "running" }];
			}
			await reportBuild(plan, build.user, build.connectionId, build.id, { state });
			await settle(plan);
		},
	};
}

async function settle(plan: Plan) {
	for (let index = 0; index < 20; index++) {
		await new Promise(resolve => setTimeout(resolve, 0));
		await plan.flushing;
	}
}

describe("living-document sync", () => {
	it("waits for 45 seconds of quiet before rebuilding", async () => {
		let { plan, queued, edit, advance } = await harness();
		edit();
		await advance(44_999);
		expect(queued).toEqual([]);
		await advance(1);
		expect(queued).toHaveLength(1);
		expect(plan.builds.at(-1)).toMatchObject({
			id: queued[0],
			kind: "rebuild",
			user: "octocat",
			connectionId: "laptop",
			baseRevision: plan.live!.baseRevision,
			targetRevision: plan.builds.at(-1)!.planRevision,
			state: "queued",
		});
		await close(plan);
	});

	it("coalesces a burst of edits into one rebuild", async () => {
		let { plan, queued, deltas, edit, advance } = await harness();
		for (let index = 0; index < 20; index++) {
			edit();
			await advance(30_000);
		}
		expect(queued).toEqual([]);
		await advance(15_000);
		expect(queued).toHaveLength(1);
		expect(deltas).toHaveLength(1);
		expect(deltas[0]).toMatchObject({
			baseSource: plan.live!.baseSource,
			source: source(plan),
			pullRequests: ["https://github.com/octo-org/score/pull/49"],
		});
		await close(plan);
	});

	it("settles in sync without a rebuild when the classifier declines the delta", async () => {
		let { plan, queued, deltas, edit, advance } = await harness({ classify: () => false });
		edit();
		await advance(45_000);
		expect(deltas).toHaveLength(1);
		expect(queued).toEqual([]);
		expect(plan.builds).toHaveLength(1);
		expect(plan.live?.baseSource).toBe(source(plan));
		expect(plan.live?.baseRevision).toBe(plan.revision);
		expect(plan.live?.noChange).toEqual([expect.objectContaining({ revision: plan.revision })]);
		expect(liveSnapshot(plan, [])?.outOfSync).toBe(false);
		await close(plan);
	});

	it("rebuilds outstanding tasks without asking the classifier", async () => {
		let { plan, queued, deltas, edit, advance } = await harness({ classify: () => false });
		plan.live = { ...plan.live!, outstanding: ["model"] };
		edit();
		await advance(45_000);
		expect(deltas).toEqual([]);
		expect(queued).toHaveLength(1);
		await close(plan);
	});

	it("queues nothing when the document matches its built source", async () => {
		let { plan, queued, deltas, edit, advance } = await harness();
		plan.live = { ...plan.live!, baseSource: source(plan) };
		edit();
		await advance(45_000);
		expect(deltas).toEqual([]);
		expect(queued).toEqual([]);
		await close(plan);
	});

	it("follows an active rebuild with exactly one more after it stops", async () => {
		let { plan, queued, edit, advance, stop } = await harness();
		edit();
		await advance(45_000);
		expect(queued).toHaveLength(1);
		edit();
		await advance(45_000);
		edit();
		await advance(45_000);
		expect(queued).toHaveLength(1);
		await stop();
		expect(queued).toHaveLength(2);
		expect(plan.builds.filter(build => build.kind === "rebuild")).toHaveLength(2);
		await stop("failed");
		expect(queued).toHaveLength(2);
		await close(plan);
	});

	it("follows a build that stops just after a busy rebuild attempt", async () => {
		let context: Awaited<ReturnType<typeof harness>> | undefined;
		let attempted = false;
		let started = false;
		context = await harness({
			classify: () => {
				if (started) return true;
				started = true;
				// A build starts while the delta is being judged, so queueing finds it busy.
				let plan = context!.plan;
				plan.builds = [...plan.builds, {
					...plan.builds[0]!,
					id: crypto.randomUUID(),
					connectionId: "laptop",
					expiresAt: Number.MAX_SAFE_INTEGER,
					state: "running",
				}];
				attempted = true;
				return true;
			},
			unlocked: async () => {
				if (!attempted) return;
				attempted = false;
				await context!.stop();
			},
		});
		let { plan, queued, edit, advance } = context;
		edit();
		await advance(45_000);
		// The follow-up check is chained behind the busy one, which waited out the stop.
		await advance(0);
		expect(queued).toHaveLength(1);
		expect(plan.builds.at(-1)).toMatchObject({ id: queued[0], kind: "rebuild" });
		await close(plan);
	});

	it("lands a reported rebuild and rebuilds edits made while it ran", async () => {
		let { plan, queued, deltas, edit, advance } = await harness();
		edit();
		await advance(45_000);
		expect(queued).toHaveLength(1);
		let target = source(plan);
		plan.builds = [...plan.builds.slice(0, -1), { ...plan.builds.at(-1)!, state: "running" }];
		let next = `${target.trimEnd()}\n\nWritten during the rebuild.\n`;
		expect(
			(await rewrite(plan, next, (text, revision) => ({
				idempotencyKey: "mid-rebuild",
				fingerprint: "mid-rebuild",
				fromRevision: plan.revision,
				client: { name: "test", version: "1" },
				document: { source: text, revision, title: "Living document", url: "https://chopin.test" },
			}))).ok,
		).toBe(true);
		edit();
		await advance(45_000);
		expect(queued).toHaveLength(1);
		let commit = {
			pullRequest: "https://github.com/octo-org/score/pull/49",
			sha: "c".repeat(40),
			message: "Render the paragraph",
		};
		expect(
			await reportRebuild(plan, queued[0]!, { summary: "Done", commits: [commit], tasks: [] }),
		).toEqual({ kind: "accepted" });
		await settle(plan);
		expect(plan.live).toMatchObject({ baseSource: target, commits: [commit] });
		expect(queued).toHaveLength(2);
		expect(source(plan)).toContain("Written during the rebuild.");
		expect(deltas.at(-1)).toMatchObject({ baseSource: target, source: source(plan) });
		expect(plan.live!.target).toMatchObject({ buildId: queued[1], source: source(plan) });
		await close(plan);
	});

	it("catches up on a missed rebuild when the builder's local agent reconnects", async () => {
		let { plan, coordinator, available, assignments, queued, edit, advance } = await harness();
		available.length = 0;
		edit();
		await advance(45_000);
		expect(queued).toHaveLength(0);
		available.push(connection("desktop", "someone-else"));
		coordinator.connected("R_score", "someone-else");
		await advance(0);
		expect(queued).toHaveLength(0);
		available.push(connection("laptop"));
		coordinator.connected("R_other", "octocat");
		await advance(0);
		expect(queued).toHaveLength(0);
		coordinator.connected("R_score", "octocat");
		await advance(0);
		expect(queued).toHaveLength(1);
		expect(plan.builds.at(-1)).toMatchObject({ kind: "rebuild", connectionId: "laptop" });
		expect(assignments.get("laptop")).toBe(plan.id);
		await close(plan);
	});

	it("does not take a connection that holds another document's build", async () => {
		let { plan, assignments, queued, edit, advance } = await harness();
		assignments.set("laptop", crypto.randomUUID());
		edit();
		await advance(45_000);
		expect(queued).toHaveLength(0);
		await close(plan);
	});

	it("keeps editing open while a rebuild is queued or running", async () => {
		let { plan, queued, edit, advance } = await harness();
		edit();
		await advance(45_000);
		expect(queued).toHaveLength(1);
		expect(implementationActive(plan)).toBe(false);
		expect(implementationStatus(plan).locked).toBe(false);
		plan.builds = [...plan.builds.slice(0, -1), { ...plan.builds.at(-1)!, state: "running" }];
		expect(implementationActive(plan)).toBe(false);
		expect(implementationStatus(plan).locked).toBe(false);
		await close(plan);
	});

	it("warns when a full build history leaves no room for a rebuild", async () => {
		let { plan, queued, edit, advance } = await harness();
		plan.builds = Array.from({ length: 100 }, (_, index) => ({
			...plan.builds[0]!,
			id: index ? crypto.randomUUID() : buildId,
		}));
		let warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			edit();
			await advance(45_000);
			expect(queued).toEqual([]);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("build history is full"));
		} finally {
			warn.mockRestore();
			await close(plan);
		}
	});

	it("does nothing when live builds are off", async () => {
		let { plan, queued, deltas, edit, advance } = await harness({ liveBuild: false });
		edit();
		await advance(45_000);
		expect(deltas).toEqual([]);
		expect(queued).toEqual([]);
		await close(plan);
	});
});
