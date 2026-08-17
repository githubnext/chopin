import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { PostgresStorage } from "./adapter";
import { migrate } from "./migrations";

let database = process.env.TEST_DATABASE_URL;

if (database) {
	describe("postgres migrations", () => {
		it("refuses an active writer before rebuilding the session registry", async () => {
			let schema = `migration_${crypto.randomUUID().replaceAll("-", "")}`;
			let admin = new SQL(database);
			let scopedUrl = new URL(database);
			scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
			let sql = new SQL(scopedUrl.href);
			try {
				await admin.unsafe(`CREATE SCHEMA "${schema}"`);
				let source = await Bun.file(join(import.meta.dir, "migrations/001_initial.sql")).text();
				let checksum = new Bun.CryptoHasher("sha256").update(source).digest("hex");
				await sql.unsafe(source).simple();
				await sql`
					CREATE TABLE chopin_migrations (
						id text PRIMARY KEY,
						checksum text NOT NULL,
						applied_at timestamptz NOT NULL DEFAULT now()
					)
				`;
				await sql`
					INSERT INTO chopin_migrations (id, checksum) VALUES ('001_initial', ${checksum})
				`;
				await sql`
					INSERT INTO storage_leases (name, owner, fencing, expires_at)
					VALUES ('chopin:writer', 'active', 1, clock_timestamp() + interval '1 minute')
				`;

				await expect(migrate(sql)).rejects.toThrow("writer is active");
				let before = await sql<{ name: string }[]>`
					SELECT column_name AS name
					FROM information_schema.columns
					WHERE table_schema = ${schema} AND table_name = 'web_sessions'
				`;
				expect(before.map(column => column.name)).toContain("oauth_token");

				await sql`
					UPDATE storage_leases SET expires_at = to_timestamp(0) WHERE name = 'chopin:writer'
				`;
				let handoff = `test:${crypto.randomUUID()}`;
				await migrate(sql, handoff);
				let after = await sql<{ name: string }[]>`
					SELECT column_name AS name
					FROM information_schema.columns
					WHERE table_schema = ${schema} AND table_name = 'web_sessions'
					ORDER BY column_name
				`;
				expect(after.map(column => column.name)).toEqual([
					"created_at",
					"expires_at",
					"id",
					"user_id",
				]);
				let storage = new PostgresStorage(scopedUrl.href);
				let lease = await storage.leases.acquire("chopin:writer", handoff, 30_000);
				expect(lease?.owner).toBe(handoff);
				await storage.leases.release(lease!);
				await storage.close();
			} finally {
				await sql.close();
				await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
				await admin.close();
			}
		});
	});
} else {
	describe("postgres migrations", () => {
		it.skip("needs TEST_DATABASE_URL", () => {});
	});
}
