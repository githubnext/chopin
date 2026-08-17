import { SQL } from "bun";
import { describe, expect, it } from "bun:test";

import { storageContract } from "../contract";
import { PostgresStorage } from "./adapter";

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
} else {
	describe("postgres storage", () => {
		it.skip("needs TEST_DATABASE_URL", () => {});
	});
}
