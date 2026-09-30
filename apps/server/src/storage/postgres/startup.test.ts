import { SQL } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

import * as Service from "../../plan/service";
import { backgroundJob } from "../contract-support";
import { PostgresStorage } from "./adapter";

import type { Subprocess } from "bun";
import type { SocketData } from "../../wire";
import type { Server } from "bun";

let database = process.env.TEST_DATABASE_URL;
let running: Subprocess[] = [];

afterEach(async () => {
	for (let child of running) child.kill();
	await Promise.all(running.map(child => child.exited));
	running = [];
});

function spawn(
	port: number,
	stderr: "ignore" | "pipe" = "ignore",
	extra: Record<string, string> = {},
	stdout: "ignore" | "pipe" = "ignore",
): Subprocess {
	let child = Bun.spawn(["bun", join(import.meta.dir, "../../main.ts")], {
		env: {
			...process.env,
			AGENT: "off",
			APP_ORIGIN: `http://127.0.0.1:${port}`,
			DATABASE_URL: database!,
			GITHUB_APP_SLUG: "chopin-test",
			GITHUB_APP_CLIENT_ID: "client-id",
			GITHUB_APP_CLIENT_SECRET: "client-secret",
			GITHUB_ALLOWED_USERS: "",
			GITHUB_ALLOWED_ORGANIZATIONS: "",
			PORT: String(port),
			SESSION_ENCRYPTION_KEY: "22".repeat(32),
			SERVER_HOST: "127.0.0.1",
			STORAGE_DRIVER: "postgres",
			...extra,
		},
		stdout,
		stderr,
	});
	running.push(child);
	return child;
}

async function started(child: Subprocess): Promise<void> {
	let output = child.stdout as ReadableStream<Uint8Array>;
	let reader = output.getReader();
	let content = "";
	try {
		while (!content.includes("chopin  ·")) {
			let next = await reader.read();
			if (next.done) throw new Error("server exited before startup completed");
			content += new TextDecoder().decode(next.value);
		}
	} finally {
		reader.releaseLock();
	}
}

async function ready(port: number): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			await fetch(`http://127.0.0.1:${port}/`);
			return;
		} catch {
			await Bun.sleep(20);
		}
	}
	throw new Error(`server on ${port} did not become ready`);
}

if (database) {
	describe("postgres server lifecycle", () => {
		it("resets sessions only after owning the writer lease", async () => {
			let setup = new PostgresStorage(database);
			await setup.migrate();
			await setup.close();
			let first = spawn(9071, "ignore", {}, "pipe");
			await started(first);
			await ready(9071);
			let session = await fetch("http://127.0.0.1:9071/api/session");
			expect(await session.json()).toEqual({ user: null, agent: false });

			let storage = new PostgresStorage(database);
			let now = new Date();
			let userId = `user-${crypto.randomUUID()}`;
			let sessionId = crypto.randomUUID();
			let channelId = crypto.randomUUID();
			await storage.users.put({ id: userId, login: "mona", avatarUrl: "", now });
			await storage.sessions.create({
				id: sessionId,
				userId,
				expiresAt: new Date(now.getTime() + 60_000),
				createdAt: now,
			});
			await storage.channels.create({
				id: channelId,
				repositoryId: `repository-${crypto.randomUUID()}`,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Plan",
				createdBy: userId,
				now,
			});
			let owner = await storage.channels.claimAgentOwner(channelId, sessionId, now);
			await storage.channels.updateAgentContext({
				channelId,
				ownerSessionId: sessionId,
				generation: owner.generation,
				summary: "keep this",
				transcriptCursor: 4,
				status: "ready",
				now,
			});

			let refused = spawn(9072, "pipe");
			expect(await refused.exited).toBe(1);
			let reason = await new Response(refused.stderr as ReadableStream).text();
			expect(reason).toContain("another Chopin instance owns the database");
			expect(await storage.sessions.get(sessionId, now)).toBeDefined();
			expect((await storage.collaboration.load(channelId, now))!.agent!.ownerSessionId)
				.toBe(sessionId);

			first.kill("SIGTERM");
			expect(await first.exited).toBe(0);
			let replacement = spawn(9072, "ignore", {}, "pipe");
			await started(replacement);
			await ready(9072);
			expect(await storage.sessions.get(sessionId, now)).toBeUndefined();
			expect((await storage.collaboration.load(channelId, now))!.agent).toMatchObject({
				ownerSessionId: undefined,
				generation: owner.generation,
				summary: "keep this",
				transcriptCursor: 4,
				status: "unavailable",
			});
			replacement.kill("SIGTERM");
			expect(await replacement.exited).toBe(0);
			await storage.close();
		});

		it("recovers an inline Research card without an open room, once across restarts", async () => {
			let storage = new PostgresStorage(database);
			await storage.migrate();
			let now = new Date();
			let userId = `user-${crypto.randomUUID()}`;
			let channelId = crypto.randomUUID();
			let workspaceId = crypto.randomUUID();
			await storage.users.put({ id: userId, login: "mona", avatarUrl: "", now });
			await storage.channels.create({
				id: channelId,
				repositoryId: `repository-${crypto.randomUUID()}`,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Research recovery",
				createdBy: userId,
				now,
			});
			let lease = await storage.leases.acquire("chopin:writer", crypto.randomUUID(), 30_000);
			if (!lease) throw new Error("could not acquire setup lease");
			await storage.research.start({
				id: workspaceId,
				channelId,
				title: "Research request",
				question: "What changed?",
				origin: "planner",
				originMessageId: crypto.randomUUID(),
				inlineReference: "pending",
				createdBy: userId,
				turnId: crypto.randomUUID(),
				messageId: crypto.randomUUID(),
				requestId: crypto.randomUUID(),
				idempotencyKey: `research-recovery-${workspaceId}`,
				fingerprint: `research-recovery-${workspaceId}`,
				now,
				lease,
			});
			await storage.leases.release(lease);

			let countCards = async () => {
				let stored = await storage.collaboration.load(channelId, new Date());
				if (!stored) throw new Error("document is missing");
				let source = (await Service.readStored(stored)).source;
				return source.split(`<Research id="${workspaceId}" />`).length - 1;
			};
			for (let port of [9073, 9074]) {
				let child = spawn(port, "ignore", {}, "pipe");
				await started(child);
				await ready(port);
				expect((await storage.research.get(channelId, workspaceId))?.workspace.inlineReference)
					.toBe("placed");
				expect(await countCards()).toBe(1);
				child.kill("SIGTERM");
				expect(await child.exited).toBe(0);
			}
			await storage.close();
		});

		it("recovers one missed terminal Chat notice across repeated server starts", async () => {
			let storage = new PostgresStorage(database);
			await storage.migrate();
			let now = new Date();
			let userId = `user-${crypto.randomUUID()}`;
			let channelId = crypto.randomUUID();
			let workspaceId = crypto.randomUUID();
			await storage.users.put({ id: userId, login: "mona", avatarUrl: "", now });
			await storage.channels.create({
				id: channelId,
				repositoryId: `repository-${crypto.randomUUID()}`,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Terminal notice recovery",
				createdBy: userId,
				now,
			});
			let lease = await storage.leases.acquire("chopin:writer", crypto.randomUUID(), 30_000);
			if (!lease) throw new Error("could not acquire setup lease");
			let request = await storage.research.start({
				id: workspaceId,
				channelId,
				title: "Research request",
				question: "What failed?",
				origin: "planner",
				originMessageId: crypto.randomUUID(),
				inlineReference: "pending",
				createdBy: userId,
				turnId: crypto.randomUUID(),
				messageId: crypto.randomUUID(),
				requestId: crypto.randomUUID(),
				idempotencyKey: `terminal-${workspaceId}`,
				fingerprint: `terminal-${workspaceId}`,
				now,
				lease,
			});
			await storage.research.markReferencePlaced({ channelId, workspaceId, lease });
			let queued = await storage.jobs.enqueue(backgroundJob(channelId, lease, {
				type: "research-evidence",
				targetKey: `research-evidence:workspace:${workspaceId}:turn:${request.turn.id}:evidence`,
				availableAt: now,
				now,
			}));
			await storage.research.linkJob({
				channelId,
				workspaceId,
				turnId: request.turn.id,
				role: "evidence",
				jobId: queued.job.id,
				now,
				lease,
			});
			let [claimed] = await storage.jobs.claim({
				channelId,
				claimOwner: "failing-worker",
				count: 1,
				ttlMs: 30_000,
				now,
				lease,
			});
			await storage.jobs.fail({
				channelId,
				jobId: claimed!.id,
				claimOwner: "failing-worker",
				claimGeneration: claimed!.claimGeneration,
				reason: "failure",
				now,
				lease,
			});
			await storage.leases.release(lease);

			let noticeId = `research-failed:${workspaceId}:${queued.job.id}`;
			for (let port of [9076, 9077]) {
				let child = spawn(port, "ignore", {}, "pipe");
				await started(child);
				await ready(port);
				child.kill("SIGTERM");
				expect(await child.exited).toBe(0);
				let durable = await storage.collaboration.load(channelId, new Date());
				expect(JSON.stringify(durable?.sidecar).split(noticeId).length - 1).toBe(1);
			}
			await storage.close();
		});

		it("starts while placement is locked and recovers one card and job after release", async () => {
			let storage = new PostgresStorage(database);
			await storage.migrate();
			let now = new Date();
			let userId = `user-${crypto.randomUUID()}`;
			let channelId = crypto.randomUUID();
			let workspaceId = crypto.randomUUID();
			await storage.users.put({ id: userId, login: "mona", avatarUrl: "", now });
			await storage.channels.create({
				id: channelId,
				repositoryId: `repository-${crypto.randomUUID()}`,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Locked research recovery",
				createdBy: userId,
				now,
			});
			let lease = await storage.leases.acquire("chopin:writer", crypto.randomUUID(), 30_000);
			if (!lease) throw new Error("could not acquire setup lease");
			let backend: Service.Backend = {
				storage,
				lease: () => lease,
				fatal: error => {
					throw error;
				},
			};
			let server = {
				publish() {
					return 0;
				},
			} as unknown as Server<SocketData>;
			let plan = await Service.open(channelId, backend, server);
			plan.graph = {
				versions: [{
					number: 1,
					revision: 1,
					planRevision: plan.revision,
					state: "locked",
					definition: {
						tasks: [{
							id: "task",
							title: "Implement",
							context: "Research is pending.",
							goal: "Complete the work.",
							acceptance: ["Implementation is complete.", "Verification is recorded."],
							dependsOn: [],
						}],
					},
				}],
			};
			plan.execution = {
				id: crypto.randomUUID(),
				user: "mona",
				client: { name: "Codex", version: "1" },
				session: crypto.randomUUID(),
				planRevision: plan.revision,
				graphVersion: 1,
				graphRevision: 1,
				repository: "octo-org/score",
				branch: "test/locked-research",
				commit: "deadbeef",
				startedAt: now.toISOString(),
			};
			await Service.persist(plan);
			await Service.close(plan);
			await storage.research.start({
				id: workspaceId,
				channelId,
				title: "Research request",
				question: "What changed?",
				origin: "planner",
				originMessageId: crypto.randomUUID(),
				inlineReference: "pending",
				createdBy: userId,
				turnId: crypto.randomUUID(),
				messageId: crypto.randomUUID(),
				requestId: crypto.randomUUID(),
				idempotencyKey: `research-recovery-${workspaceId}`,
				fingerprint: `research-recovery-${workspaceId}`,
				now,
				lease,
			});
			await storage.leases.release(lease);

			let countCards = async () => {
				let stored = await storage.collaboration.load(channelId, new Date());
				if (!stored) throw new Error("document is missing");
				let source = (await Service.readStored(stored)).source;
				return source.split(`<Research id="${workspaceId}" />`).length - 1;
			};
			let child = spawn(9075, "pipe", { AGENT: "on" }, "pipe");
			await started(child);
			await ready(9075);
			expect(await countCards()).toBe(0);
			expect((await storage.research.get(channelId, workspaceId))?.workspace.inlineReference)
				.toBe("pending");
			expect((await storage.research.get(channelId, workspaceId))?.turns[0]?.evidenceJobId)
				.toBeUndefined();

			// Simulate a durable lifecycle release while this server has no open room.
			let sql = new SQL(database);
			try {
				await sql`
					UPDATE channel_state
					SET sidecar = to_jsonb(jsonb_set(
						(sidecar #>> '{}')::jsonb - 'execution',
						'{graph,versions,0,state}',
						'"approved"'::jsonb
					)::text)
					WHERE channel_id = ${channelId}
				`;
			} finally {
				await sql.close();
			}
			let placed = false;
			for (let attempt = 0; attempt < 150; attempt++) {
				let detail = await storage.research.get(channelId, workspaceId);
				if (detail?.workspace.inlineReference === "placed" && detail.turns[0]?.evidenceJobId) {
					placed = true;
					break;
				}
				await Bun.sleep(100);
			}
			expect(placed).toBe(true);
			expect(await countCards()).toBe(1);
			let researchJobs = async () =>
				(await storage.jobs.list(channelId, 100))?.jobs
					.filter(job => job.type === "research-evidence") ?? [];
			expect(await researchJobs()).toHaveLength(1);
			child.kill("SIGTERM");
			expect(await child.exited).toBe(0);

			let replacement = spawn(9076, "pipe", { AGENT: "on" }, "pipe");
			await started(replacement);
			await ready(9076);
			expect(await countCards()).toBe(1);
			expect(await researchJobs()).toHaveLength(1);
			replacement.kill("SIGTERM");
			expect(await replacement.exited).toBe(0);
			await storage.close();
		}, 30_000);
	});
} else {
	describe("postgres server lifecycle", () => {
		it.skip("needs TEST_DATABASE_URL", () => {});
	});
}
