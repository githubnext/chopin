import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { documentSlug } from "../../channels/slug";
import { storageContract } from "../contract";
import { StorageError } from "../errors";
import { PostgresStorage } from "./adapter";
import { migrate, verifyMigrations } from "./migrations";
import { backfillDocumentSlugs } from "./migrations/002_document_slugs";

let url = process.env.TEST_DATABASE_URL;

function digest(source: string): string {
	return new Bun.CryptoHasher("sha256").update(source).digest("hex");
}

if (url) {
	storageContract("postgres", () => new PostgresStorage(url));
	it("stores no browser verifier or GitHub credential columns", async () => {
		let storage = new PostgresStorage(url);
		await storage.migrate();
		await storage.close();
		let sql = new SQL(url);
		try {
			let columns = await sql<{ name: string }[]>`
				SELECT column_name AS name
				FROM information_schema.columns
				WHERE table_schema = 'public' AND table_name = 'web_sessions'
				ORDER BY column_name
			`;
			expect(columns.map(column => column.name)).toEqual([
				"created_at",
				"expires_at",
				"id",
				"user_id",
			]);
		} finally {
			await sql.close();
		}
	});

	it("cascades background jobs, artifacts, and research workspaces with their channel", async () => {
		let storage = new PostgresStorage(url);
		let suffix = crypto.randomUUID();
		let channelId = `job-channel-${suffix}`;
		try {
			await storage.migrate();
			let now = new Date();
			let userId = `job-user-${suffix}`;
			await storage.users.put({ id: userId, login: "jobs", avatarUrl: "", now });
			await storage.channels.create({
				id: channelId,
				repositoryId: `job-repository-${suffix}`,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: `Job cascade ${suffix}`,
				createdBy: userId,
				now,
			});
			let lease = await storage.leases.acquire(`job-writer-${suffix}`, "test", 60_000);
			let queued = await storage.jobs.enqueue({
				id: `job-${suffix}`,
				channelId,
				type: "research-answer",
				version: 1,
				origin: "user",
				targetKey: `research-answer:workspace:workspace-${suffix}:turn:turn-${suffix}:answer`,
				idempotencyKey: `enqueue-${suffix}`,
				fingerprint: `fingerprint-${suffix}`,
				input: { revision: 1 },
				availableAt: now,
				now,
				lease: lease!,
			});
			let [claimed] = await storage.jobs.claim({
				channelId,
				claimOwner: "worker",
				count: 1,
				ttlMs: 60_000,
				now: new Date(now.getTime() + 1),
				lease: lease!,
			});
			await storage.jobs.settle({
				channelId,
				jobId: queued.job.id,
				claimOwner: "worker",
				claimGeneration: claimed!.claimGeneration,
				artifact: { abstract: "summary" },
				now: new Date(now.getTime() + 2),
				lease: lease!,
			});
			let draft = await storage.research.create({
				id: `workspace-${suffix}`,
				channelId,
				title: "Cascade research",
				proposedQuestion: "What should be deleted?",
				origin: "sidebar",
				createdBy: userId,
				idempotencyKey: `workspace-create-${suffix}`,
				fingerprint: `workspace-fingerprint-${suffix}`,
				now: new Date(now.getTime() + 3),
				lease: lease!,
			});
			let confirmed = await storage.research.confirm({
				channelId,
				workspaceId: draft.workspace.id,
				turnId: `turn-${suffix}`,
				messageId: `member-message-${suffix}`,
				requestId: `confirm-${suffix}`,
				fingerprint: `confirm-fingerprint-${suffix}`,
				confirmedQuery: "Delete the complete workspace.",
				confirmedBy: userId,
				now: new Date(now.getTime() + 4),
				lease: lease!,
			});
			await storage.research.linkJob({
				channelId,
				workspaceId: draft.workspace.id,
				turnId: confirmed.turn.id,
				role: "answer",
				jobId: queued.job.id,
				now: new Date(now.getTime() + 5),
				lease: lease!,
			});
			await storage.research.appendAgentMessage({
				channelId,
				workspaceId: draft.workspace.id,
				id: `agent-message-${suffix}`,
				turnId: confirmed.turn.id,
				text: "Everything is scoped to the parent.",
				sourceJobId: queued.job.id,
				now: new Date(now.getTime() + 6),
				lease: lease!,
			});
		} finally {
			await storage.close();
		}

		let sql = new SQL(url);
		try {
			await sql`DELETE FROM channels WHERE id = ${channelId}`;
			let [counts] = await sql<{
				channels: number;
				targets: number;
				jobs: number;
				artifacts: number;
				workspaces: number;
				turns: number;
				messages: number;
			}[]>`
				SELECT
					(SELECT count(*)::int FROM background_job_channels WHERE channel_id = ${channelId}) AS channels,
					(SELECT count(*)::int FROM background_job_targets WHERE channel_id = ${channelId}) AS targets,
					(SELECT count(*)::int FROM background_jobs WHERE channel_id = ${channelId}) AS jobs,
					(SELECT count(*)::int FROM background_job_artifacts WHERE job_id = ${`job-${suffix}`}) AS artifacts,
					(SELECT count(*)::int FROM research_workspaces WHERE channel_id = ${channelId}) AS workspaces,
					(SELECT count(*)::int FROM research_turns WHERE workspace_id = ${`workspace-${suffix}`}) AS turns,
					(SELECT count(*)::int FROM research_messages WHERE workspace_id = ${`workspace-${suffix}`}) AS messages
			`;
			expect(counts).toEqual({
				channels: 0,
				targets: 0,
				jobs: 0,
				artifacts: 0,
				workspaces: 0,
				turns: 0,
				messages: 0,
			});
		} finally {
			await sql.close();
		}
	});

	it("rechecks a writer lease after waiting for its row lock", async () => {
		let storage = new PostgresStorage(url);
		let sql = new SQL(url);
		let suffix = crypto.randomUUID();
		let locked = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		try {
			await storage.migrate();
			let now = new Date();
			let userId = `lease-user-${suffix}`;
			let channelId = `lease-channel-${suffix}`;
			await storage.users.put({ id: userId, login: "lease", avatarUrl: "", now });
			await storage.channels.create({
				id: channelId,
				repositoryId: `lease-repository-${suffix}`,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: `Lease check ${suffix}`,
				createdBy: userId,
				now,
			});
			let lease = await storage.leases.acquire(`lease-${suffix}`, "old-writer", 50);
			let blocker = sql.begin(async transaction => {
				await transaction`SELECT name FROM storage_leases WHERE name = ${lease!.name} FOR UPDATE`;
				locked.resolve();
				await release.promise;
			});
			await locked.promise;
			let enqueue = storage.jobs.enqueue({
				id: `lease-job-${suffix}`,
				channelId,
				type: "document-summary",
				version: 1,
				origin: "scheduler",
				targetKey: "document-summary",
				idempotencyKey: `lease-enqueue-${suffix}`,
				fingerprint: `lease-fingerprint-${suffix}`,
				input: { revision: 1 },
				availableAt: now,
				now,
				lease: lease!,
			});
			let settled = false;
			void enqueue.then(
				() => settled = true,
				() => settled = true,
			);
			await Bun.sleep(10);
			expect(settled).toBe(false);
			await Bun.sleep(75);
			release.resolve();
			await blocker;
			await expect(enqueue).rejects.toMatchObject({ failure: "conflict" });
			expect((await storage.jobs.list(channelId, 10))!.jobs).toEqual([]);
		} finally {
			release.resolve();
			await storage.close();
			await sql.close();
		}
	});

	it("replays concurrent idempotent enqueues across independent lease rows", async () => {
		let storage = new PostgresStorage(url);
		let suffix = crypto.randomUUID();
		try {
			await storage.migrate();
			let now = new Date();
			let userId = `idempotency-user-${suffix}`;
			let channelId = `idempotency-channel-${suffix}`;
			await storage.users.put({ id: userId, login: "idempotency", avatarUrl: "", now });
			await storage.channels.create({
				id: channelId,
				repositoryId: `idempotency-repository-${suffix}`,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: `Idempotency ${suffix}`,
				createdBy: userId,
				now,
			});
			let firstLease = await storage.leases.acquire(`first-${suffix}`, "one", 60_000);
			let secondLease = await storage.leases.acquire(`second-${suffix}`, "two", 60_000);
			let common = {
				channelId,
				type: "document-summary",
				version: 1,
				origin: "scheduler" as const,
				targetKey: "document-summary",
				idempotencyKey: `enqueue-${suffix}`,
				fingerprint: `fingerprint-${suffix}`,
				input: { revision: 1 },
				availableAt: now,
				now,
			};
			let results = await Promise.all([
				storage.jobs.enqueue({ ...common, id: `first-job-${suffix}`, lease: firstLease! }),
				storage.jobs.enqueue({ ...common, id: `second-job-${suffix}`, lease: secondLease! }),
			]);
			expect(results.map(result => result.repeated).sort()).toEqual([false, true]);
			expect(new Set(results.map(result => result.job.id)).size).toBe(1);
			expect((await storage.jobs.list(channelId, 10))!.jobs).toHaveLength(1);
		} finally {
			await storage.close();
		}
	});

	it("rechecks a writer lease after waiting for the job mutation lock", async () => {
		let storage = new PostgresStorage(url);
		let sql = new SQL(url);
		let suffix = crypto.randomUUID();
		let locked = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		try {
			await storage.migrate();
			let now = new Date();
			let userId = `job-lock-user-${suffix}`;
			let channelId = `job-lock-channel-${suffix}`;
			await storage.users.put({ id: userId, login: "job-lock", avatarUrl: "", now });
			await storage.channels.create({
				id: channelId,
				repositoryId: `job-lock-repository-${suffix}`,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: `Job lock ${suffix}`,
				createdBy: userId,
				now,
			});
			let lease = await storage.leases.acquire(`job-lock-${suffix}`, "old-writer", 50);
			let blocker = sql.begin(async transaction => {
				await transaction`SELECT pg_advisory_xact_lock(2043237432)`;
				locked.resolve();
				await release.promise;
			});
			await locked.promise;
			let enqueue = storage.jobs.enqueue({
				id: `job-lock-job-${suffix}`,
				channelId,
				type: "document-summary",
				version: 1,
				origin: "scheduler",
				targetKey: "document-summary",
				idempotencyKey: `job-lock-enqueue-${suffix}`,
				fingerprint: `job-lock-fingerprint-${suffix}`,
				input: { revision: 1 },
				availableAt: now,
				now,
				lease: lease!,
			});
			await Bun.sleep(75);
			release.resolve();
			await blocker;
			await expect(enqueue).rejects.toMatchObject({ failure: "conflict" });
			expect((await storage.jobs.list(channelId, 10))!.jobs).toEqual([]);
		} finally {
			release.resolve();
			await storage.close();
			await sql.close();
		}
	});

	it("backfills unique readable slugs for channels created before the slug migration", async () => {
		let sql = new SQL(url);
		let schema = `slug_migration_${crypto.randomUUID().replaceAll("-", "")}`;
		try {
			await sql.unsafe(`CREATE SCHEMA "${schema}"`).simple();
			let initial = await Bun.file(join(import.meta.dir, "migrations/001_initial.sql")).text();
			let slugs = await Bun.file(join(import.meta.dir, "migrations/002_document_slugs.sql")).text();
			await sql.begin(async transaction => {
				await transaction.unsafe(`SET LOCAL search_path TO "${schema}"`).simple();
				await transaction.unsafe(initial).simple();
				await transaction`
					INSERT INTO users (id, login, avatar_url, created_at, updated_at)
					VALUES ('U_test', 'test', '', now(), now())
				`;
				let titles = [
					"Release plan",
					"Release-plan!",
					"Résumé 計画",
					"🚀",
					"İstanbul",
					"ΟΣ",
					"\u0301",
				];
				for (let [index, title] of titles.entries()) {
					await transaction`
						INSERT INTO channels (
							id, repository_id, repository_owner, repository_name, title,
							created_by, created_at, updated_at
						) VALUES (
							${`channel-${index}`}, 'R_test', 'octo-org', 'score', ${title},
							'U_test', ${new Date(1_700_000_000_000 + index)}, now()
						)
					`;
				}
				for (let index = 0; index < 505; index++) {
					let punctuation = index.toString(2).replaceAll("0", "!").replaceAll("1", "?");
					await transaction`
						INSERT INTO channels (
							id, repository_id, repository_owner, repository_name, title,
							created_by, created_at, updated_at
						) VALUES (
							${`channel-batch-${String(index).padStart(3, "0")}`},
							'R_test', 'octo-org', 'score', ${`Batch${punctuation}`},
							'U_test', ${new Date(1_700_001_000_000 + index)}, now()
						)
					`;
				}
				await transaction.unsafe(slugs).simple();
				await backfillDocumentSlugs(transaction);
				let rows = await transaction<{ channelId: string; slug: string }[]>`
					SELECT channel_id AS "channelId", slug
					FROM channel_slugs
					WHERE canonical
					ORDER BY channel_id
				`;
				let byId = new Map(rows.map(row => [row.channelId, row.slug]));
				expect(titles.map((_, index) => byId.get(`channel-${index}`))).toEqual([
					documentSlug(titles[0]!),
					`${documentSlug(titles[1]!)}-2`,
					...titles.slice(2).map(documentSlug),
				]);
				let batch = rows.filter(row => row.channelId.startsWith("channel-batch-"));
				expect(batch).toHaveLength(505);
				expect(new Set(batch.map(row => row.slug)).size).toBe(505);
				expect(byId.get("channel-batch-000")).toBe("batch");
				expect(byId.get("channel-batch-504")).toBe("batch-505");
			});
		} finally {
			await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).simple();
			await sql.close();
		}
	});

	it("upgrades a database that recorded user navigation as migration 002 without rewriting history", async () => {
		let sql = new SQL(url, { max: 1 });
		let schema = `legacy_navigation_${crypto.randomUUID().replaceAll("-", "")}`;
		try {
			await sql.unsafe(`CREATE SCHEMA "${schema}"`).simple();
			await sql.unsafe(`SET search_path TO "${schema}"`).simple();
			let initial = await Bun.file(join(import.meta.dir, "migrations/001_initial.sql")).text();
			let navigation = await Bun.file(
				join(import.meta.dir, "migrations/003_user_navigation.sql"),
			).text();
			await sql.unsafe(initial).simple();
			await sql.unsafe(navigation).simple();
			await sql`
				CREATE TABLE chopin_migrations (
					id text PRIMARY KEY,
					checksum text NOT NULL,
					applied_at timestamptz NOT NULL DEFAULT now()
				)
			`;
			await sql`
				INSERT INTO chopin_migrations (id, checksum)
				VALUES
					('001_initial', ${digest(initial)}),
					('002_user_navigation', ${digest(navigation)})
			`;

			await migrate(sql);
			await verifyMigrations(sql);
			let rows = await sql<{ id: string }[]>`
				SELECT id FROM chopin_migrations ORDER BY id
			`;
			expect(rows.map(row => row.id)).toEqual([
				"001_initial",
				"002_document_slugs",
				"002_user_navigation",
				"004_background_jobs",
				"005_background_job_failures",
				"006_background_job_progress",
				"007_research_workspaces",
				"008_research_repository_listing",
				"009_navigation_revision",
			]);
			expect(await sql<{ table: string | null }[]>`SELECT to_regclass('channel_slugs') AS table`)
				.toEqual([
					{ table: "channel_slugs" },
				]);
			expect(await sql<{ table: string | null }[]>`SELECT to_regclass('user_navigation') AS table`)
				.toEqual([
					{ table: "user_navigation" },
				]);
			expect(
				await sql<{ table: string | null }[]>`SELECT to_regclass('research_workspaces') AS table`,
			).toEqual([{ table: "research_workspaces" }]);
		} finally {
			await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).simple();
			await sql.close();
		}
	});

	it("orders concurrent create and rename slug reservations without deadlocking", async () => {
		let storage = new PostgresStorage(url);
		try {
			await storage.migrate();
			let suffix = crypto.randomUUID();
			let now = new Date();
			let userId = `user-${suffix}`;
			let repositoryId = `repository-${suffix}`;
			await storage.users.put({ id: userId, login: "slug-race", avatarUrl: "", now });
			let existing = await storage.channels.create({
				id: `existing-${suffix}`,
				repositoryId,
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: "Original title",
				createdBy: userId,
				now,
			});
			let results = await Promise.allSettled([
				storage.channels.rename({ id: existing.id, title: "Shared title", now }),
				storage.channels.create({
					id: `created-${suffix}`,
					repositoryId,
					repositoryOwner: "octo-org",
					repositoryName: "score",
					title: "Shared title",
					createdBy: userId,
					now,
				}),
			]);
			expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
			let rejected = results.find(result => result.status === "rejected");
			expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(StorageError);
			if (rejected?.status === "rejected" && rejected.reason instanceof StorageError) {
				expect(rejected.reason.failure).toBe("conflict");
			}
		} finally {
			await storage.close();
		}
	});
} else {
	describe("postgres storage", () => {
		it.skip("needs TEST_DATABASE_URL", () => {});
	});
}
