import type { SQL, TransactionSQL } from "bun";
import type { Lease } from "../model";
import type { DeferredTurnStore } from "../port";

/** See `DeferredTurnStore`: the rows are only ever closed, and the table is kept as it is. */
export class PostgresDeferredTurnStore implements DeferredTurnStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
		private fence: (sql: TransactionSQL, lease: Lease) => Promise<void>,
	) {}
	retire(lease: Lease, at: Date) {
		return this.run("close held Planner requests", () =>
			this.sql.begin(async sql => {
				await this.fence(sql, lease);
				let closed = await sql<Array<{ id: string }>>`
					UPDATE planner_deferred_turns
					SET state = CASE state WHEN 'waiting' THEN 'cancelled' ELSE 'interrupted' END,
						fencing = ${lease.fencing}, resolved_at = ${at}
					WHERE state IN ('waiting', 'started')
					RETURNING id
				`;
				return closed.length;
			}));
	}
}
