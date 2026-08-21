import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { documentSlug } from "../../channels/slug";
import { storageContract } from "../contract";
import { StorageError } from "../errors";
import { PostgresStorage } from "./adapter";
import { backfillDocumentSlugs } from "./migrations/002_document_slugs";

let url = process.env.TEST_DATABASE_URL;

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
