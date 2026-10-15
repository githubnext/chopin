import { SQL } from "bun";
import { expect, test } from "bun:test";

let database = process.env.TEST_DATABASE_URL;

test.skipIf(!database)(
	"agenda migration preserves spent allowance and scope identity",
	async () => {
		let sql = new SQL(database!);
		try {
			await sql.begin(async transaction => {
				await transaction`CREATE TEMP TABLE research_agendas (id int, record jsonb) ON COMMIT DROP`;
				let context = {
					generation: 3,
					state: "paused",
					investigations: 2,
					assessments: 4,
					expiresAt: "2026-10-15T12:00:00.000Z",
					owner: { sessionId: "existing-owner" },
					questions: [{ requestId: "existing-run", state: "running" }],
				};
				let credits = [0, 30, 60, 140, 420];
				for (let [id, reservedAiCredits] of credits.entries()) {
					await transaction`INSERT INTO research_agendas VALUES (${id}, ${
						JSON.stringify({ ...context, reservedAiCredits })
					}::text::jsonb)`;
				}
				await transaction`INSERT INTO research_agendas VALUES (5, ${
					JSON.stringify({ ...context, reservedSessions: 7 })
				}::text::jsonb)`;
				let migration = await Bun.file(
					new URL("./migrations/025_agenda_sessions.sql", import.meta.url),
				).text();
				await transaction.unsafe(migration).simple();
				let rows = await transaction<{ record: Record<string, unknown> }[]>`
				SELECT record FROM research_agendas ORDER BY id
			`;
				expect(rows.map(row => row.record)).toEqual(
					[0, 1, 2, 5, 14, 7].map(reservedSessions => ({ ...context, reservedSessions })),
				);
				await transaction.unsafe(migration).simple();
				let repeated = await transaction<{ record: Record<string, unknown> }[]>`
				SELECT record FROM research_agendas ORDER BY id
			`;
				expect(repeated).toEqual(rows);
			});
		} finally {
			await sql.close();
		}
	},
);
