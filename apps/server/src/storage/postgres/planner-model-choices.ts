import type { SQL, TransactionSQL } from "bun";
import type { Lease, PlannerModelChoice } from "../model";
import type { PlannerModelChoiceStore } from "../port";

type Row = {
	channelId: string;
	model: string | null;
	modelName: string | null;
	thinkingLevel: string | null;
	userId: string;
	updatedAt: Date | string;
};

export class PostgresPlannerModelChoiceStore implements PlannerModelChoiceStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
		private fence: (sql: TransactionSQL, lease: Lease) => Promise<void>,
	) {}
	put(lease: Lease, input: PlannerModelChoice) {
		return this.run("save a Planner model choice", () =>
			this.sql.begin(async sql => {
				await this.fence(sql, lease);
				if (input.model === undefined && input.thinkingLevel === undefined) {
					await sql`DELETE FROM planner_model_choices WHERE channel_id = ${input.channelId}`;
					return;
				}
				await sql`
					INSERT INTO planner_model_choices (
						channel_id, model, model_name, thinking_level, user_id, updated_at, fencing
					) VALUES (
						${input.channelId}, ${input.model ?? null}, ${input.modelName ?? null},
						${input.thinkingLevel ?? null}, ${input.userId}, ${input.updatedAt}, ${lease.fencing}
					)
					ON CONFLICT (channel_id) DO UPDATE SET
						model = EXCLUDED.model,
						model_name = EXCLUDED.model_name,
						thinking_level = EXCLUDED.thinking_level,
						user_id = EXCLUDED.user_id,
						updated_at = EXCLUDED.updated_at,
						fencing = EXCLUDED.fencing
				`;
			}));
	}
	get(channelId: string) {
		return this.run("read a Planner model choice", async () => {
			let [row] = await this.sql<Row[]>`
				SELECT channel_id AS "channelId", model, model_name AS "modelName", thinking_level AS "thinkingLevel",
					user_id AS "userId", updated_at AS "updatedAt"
				FROM planner_model_choices WHERE channel_id = ${channelId}
			`;
			if (!row) return undefined;
			return {
				channelId: row.channelId,
				...(row.model !== null ? { model: row.model } : {}),
				...(row.modelName !== null ? { modelName: row.modelName } : {}),
				...(row.thinkingLevel !== null ? { thinkingLevel: row.thinkingLevel } : {}),
				userId: row.userId,
				updatedAt: new Date(row.updatedAt),
			};
		});
	}
}
