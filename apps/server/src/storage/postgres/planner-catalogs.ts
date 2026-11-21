import type { SQL, TransactionSQL } from "bun";
import type { Lease, PlannerCatalog } from "../model";
import type { PlannerCatalogStore } from "../port";

type Row = {
	channelId: string;
	userId: string;
	catalog: PlannerCatalog["catalog"] | string;
	reportedAt: Date | string;
};

export class PostgresPlannerCatalogStore implements PlannerCatalogStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
		private fence: (sql: TransactionSQL, lease: Lease) => Promise<void>,
	) {}
	put(lease: Lease, input: PlannerCatalog) {
		return this.run("save a Planner's model list", () =>
			this.sql.begin(async sql => {
				await this.fence(sql, lease);
				await sql`
					INSERT INTO planner_catalogs (channel_id, user_id, catalog, reported_at, fencing)
					VALUES (
						${input.channelId}, ${input.userId}, ${JSON.stringify(input.catalog)}::text::jsonb,
						${input.reportedAt}, ${lease.fencing}
					)
					ON CONFLICT (channel_id, user_id) DO UPDATE SET
						catalog = EXCLUDED.catalog,
						reported_at = EXCLUDED.reported_at,
						fencing = EXCLUDED.fencing
				`;
			}));
	}
	get(channelId: string, userId: string) {
		return this.run("read a Planner's model list", async () => {
			let [row] = await this.sql<Row[]>`
				SELECT channel_id AS "channelId", user_id AS "userId", catalog, reported_at AS "reportedAt"
				FROM planner_catalogs WHERE channel_id = ${channelId} AND user_id = ${userId}
			`;
			if (!row) return undefined;
			return {
				channelId: row.channelId,
				userId: row.userId,
				catalog: typeof row.catalog === "string" ? JSON.parse(row.catalog) : row.catalog,
				reportedAt: new Date(row.reportedAt),
			};
		});
	}
}
