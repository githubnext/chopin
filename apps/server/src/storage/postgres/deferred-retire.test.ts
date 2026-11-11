import { describe, expect, it } from "bun:test";
import { SQL } from "bun";

import { contractId as id, userAndChannel } from "../contract-support";
import { PostgresStorage } from "./adapter";

let url = process.env.TEST_DATABASE_URL;

async function states(sql: SQL, channelId: string): Promise<Record<string, string>> {
	let rows = await sql<{ id: string; state: string }[]>`
		SELECT id, state FROM planner_deferred_turns WHERE document_id = ${channelId}
	`;
	return Object.fromEntries(rows.map(row => [row.id, row.state]));
}

/**
 * What a deploy finds in a live database: rows an earlier release wrote for Planner requests that
 * waited. They are written here with SQL, as that release wrote them, because nothing writes them
 * now.
 */
describe.skipIf(!url)(
	"PostgreSQL rows an earlier release kept for Planner requests that waited",
	() => {
		async function insert(
			sql: SQL,
			channelId: string,
			state: string,
			fencing = 1,
			kind = "composer",
		) {
			let resolved = state === "waiting" || state === "started" ? null : new Date();
			let row = id("turn");
			await sql`
			INSERT INTO planner_deferred_turns (
				id, document_id, request_id, kind, handle, user_id, text, references_json, state,
				created_at, fencing, resolved_at
			) VALUES (
				${row}, ${channelId}, ${id("request")}, ${kind}, 'mona', ${
				id("user")
			}, 'ask later', '[]'::jsonb,
				${state}, now(), ${fencing}, ${resolved}
			)
		`;
			return row;
		}

		it("closes a waiting row as cancelled and a started one as interrupted, and leaves a closed one alone", async () => {
			let storage = new PostgresStorage(url!);
			let sql = new SQL(url!);
			try {
				await storage.migrate();
				let { channelId, lease } = await userAndChannel(storage);
				let waiting = await insert(sql, channelId, "waiting");
				let comment = await insert(sql, channelId, "waiting", 1, "comment");
				let started = await insert(sql, channelId, "started");
				let ended = await insert(sql, channelId, "ended");
				let cancelled = await insert(sql, channelId, "cancelled");
				let before = (await sql<{ resolved_at: Date }[]>`
				SELECT resolved_at FROM planner_deferred_turns WHERE id = ${ended}
			`)[0]!.resolved_at;

				// Other documents' rows are closed too: a deploy settles what the old release left anywhere.
				let retired = await storage.deferredTurns.retire(lease, new Date());
				expect(retired).toBeGreaterThanOrEqual(3);
				expect(await states(sql, channelId)).toEqual({
					[waiting]: "cancelled",
					[comment]: "cancelled",
					[started]: "interrupted",
					[ended]: "ended",
					[cancelled]: "cancelled",
				});
				let after = (await sql<{ resolved_at: Date }[]>`
				SELECT resolved_at FROM planner_deferred_turns WHERE id = ${ended}
			`)[0]!.resolved_at;
				expect(after).toEqual(before);

				// Closed, so a second start has nothing to do and the rows are still there for a rollback.
				expect(await storage.deferredTurns.retire(lease, new Date())).toBe(0);
				expect(Object.keys(await states(sql, channelId))).toHaveLength(5);
			} finally {
				await sql.close();
				await storage.close();
			}
		});
	},
);
