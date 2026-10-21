import type { SQL } from "bun";
import type { DecisionAnswer, SaveDecisionAnswer } from "../model";
import type { DecisionAnswerStore } from "../port";

type AnswerRow = {
	decisionId: string;
	generation: number;
	savedAt: Date | string;
	turnId: string | null;
};

export class PostgresDecisionAnswerStore implements DecisionAnswerStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
	) {}
	save(input: SaveDecisionAnswer) {
		return this.run("save a decision answer for the Planner", async () => {
			await this.sql`
				INSERT INTO decision_answers (channel_id, decision_id, generation, saved_at)
				VALUES (${input.channelId}, ${input.decisionId}, ${input.generation}, ${input.savedAt})
				ON CONFLICT (channel_id, decision_id) DO UPDATE SET
					generation = EXCLUDED.generation,
					saved_at = EXCLUDED.saved_at,
					turn_id = NULL,
					delivered_at = NULL
				WHERE decision_answers.generation < EXCLUDED.generation
			`;
		});
	}
	pending(channelId: string) {
		return this.run("read decision answers for the Planner", async () => {
			let rows = await this.sql<AnswerRow[]>`
				SELECT decision_id AS "decisionId", generation, saved_at AS "savedAt",
					turn_id AS "turnId"
				FROM decision_answers
				WHERE channel_id = ${channelId} AND delivered_at IS NULL
				ORDER BY saved_at, decision_id
			`;
			return rows.map((row): DecisionAnswer => ({
				decisionId: row.decisionId,
				generation: Number(row.generation),
				savedAt: new Date(row.savedAt),
				...(row.turnId ? { turnId: row.turnId } : {}),
			}));
		});
	}
	claim(
		channelId: string,
		turnId: string,
		answers: Array<{ decisionId: string; generation: number }>,
	) {
		if (answers.length === 0) return Promise.resolve(0);
		return this.run("claim decision answers for a Planner turn", async () => {
			let rows = await this.sql<{ decisionId: string }[]>`
				UPDATE decision_answers AS answer SET turn_id = ${turnId}
				FROM jsonb_to_recordset(${JSON.stringify(answers)}::text::jsonb)
					AS x("decisionId" text, generation integer)
				WHERE answer.channel_id = ${channelId}
					AND answer.decision_id = x."decisionId"
					AND answer.generation = x.generation
					AND answer.turn_id IS NULL
					AND answer.delivered_at IS NULL
				RETURNING answer.decision_id AS "decisionId"
			`;
			return rows.length;
		});
	}
	release(channelId: string, turnId: string) {
		return this.run("release decision answers", async () => {
			await this.sql`
				UPDATE decision_answers SET turn_id = NULL
				WHERE channel_id = ${channelId} AND turn_id = ${turnId} AND delivered_at IS NULL
			`;
		});
	}
	delivered(channelId: string, turnId: string, at: Date) {
		return this.run("mark decision answers delivered", async () => {
			await this.sql`
				UPDATE decision_answers SET delivered_at = ${at}
				WHERE channel_id = ${channelId} AND turn_id = ${turnId} AND delivered_at IS NULL
			`;
		});
	}
}
