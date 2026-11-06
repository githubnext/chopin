import { conflict, corrupt } from "../errors";

import type { SQL, TransactionSQL } from "bun";
import type { Lease, PlannerHeldSession, PlannerLinkHold, StoredPlannerLinkHold } from "../model";
import type { PlannerLinkHoldStore } from "../port";

type Timestamp = Date | string;

type HoldRow = {
	channelId: string;
	userId: string;
	login: string;
	ownerSessionId: string | null;
	generation: string | number;
	machineId: string | null;
	machine: string | null;
	sessions: unknown;
	suspendedAt: Timestamp;
	handoverUntil: Timestamp | null;
	fencing: string | number;
};

const COLUMNS = `channel_id AS "channelId", user_id AS "userId", login,
	owner_session_id AS "ownerSessionId", generation, machine_id AS "machineId",
	machine_label AS machine, sessions, suspended_at AS "suspendedAt",
	handover_until AS "handoverUntil", fencing`;

function sessions(value: unknown): PlannerHeldSession[] {
	let decoded = typeof value === "string" ? JSON.parse(value) : value;
	if (!Array.isArray(decoded)) throw corrupt("storage returned invalid held Planner sessions");
	return decoded as PlannerHeldSession[];
}

function hold(row: HoldRow): StoredPlannerLinkHold {
	return {
		channelId: row.channelId,
		userId: row.userId,
		login: row.login,
		...(row.ownerSessionId !== null ? { ownerSessionId: row.ownerSessionId } : {}),
		generation: Number(row.generation),
		...(row.machineId !== null && row.machine !== null
			? { machineId: row.machineId, machine: row.machine }
			: {}),
		sessions: sessions(row.sessions),
		suspendedAt: new Date(row.suspendedAt),
		...(row.handoverUntil !== null ? { handoverUntil: new Date(row.handoverUntil) } : {}),
		fencing: Number(row.fencing),
	};
}

export class PostgresPlannerLinkHoldStore implements PlannerLinkHoldStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
		private fence: (sql: TransactionSQL, lease: Lease) => Promise<void>,
	) {}
	async put(lease: Lease, input: PlannerLinkHold) {
		if ((input.ownerSessionId === undefined) !== (input.machineId !== undefined)) {
			throw conflict("a Planner hold names a browser login or a paired machine, never both");
		}
		return this.run("save a Planner link hold", () =>
			this.sql.begin(async sql => {
				await this.fence(sql, lease);
				await sql`
					INSERT INTO planner_link_holds (
						channel_id, user_id, login, owner_session_id, generation, machine_id, machine_label,
						sessions, suspended_at, handover_until, fencing
					) VALUES (
						${input.channelId}, ${input.userId}, ${input.login}, ${input.ownerSessionId ?? null},
						${input.generation}, ${input.machineId ?? null}, ${input.machine ?? null},
						${JSON.stringify(input.sessions)}::text::jsonb,
						${input.suspendedAt}, ${input.handoverUntil ?? null}, ${lease.fencing}
					)
					ON CONFLICT (channel_id) DO UPDATE SET
						user_id = EXCLUDED.user_id,
						login = EXCLUDED.login,
						owner_session_id = EXCLUDED.owner_session_id,
						generation = EXCLUDED.generation,
						machine_id = EXCLUDED.machine_id,
						machine_label = EXCLUDED.machine_label,
						sessions = EXCLUDED.sessions,
						suspended_at = EXCLUDED.suspended_at,
						handover_until = EXCLUDED.handover_until,
						fencing = EXCLUDED.fencing
				`;
			}));
	}
	delete(lease: Lease, channelId: string) {
		return this.run("remove a Planner link hold", () =>
			this.sql.begin(async sql => {
				await this.fence(sql, lease);
				let removed = await sql<{ channelId: string }[]>`
					DELETE FROM planner_link_holds WHERE channel_id = ${channelId}
					RETURNING channel_id AS "channelId"
				`;
				return removed.length > 0;
			}));
	}
	get(channelId: string) {
		return this.run("read a Planner link hold", async () => {
			let [row] = await this.sql<HoldRow[]>`
				SELECT ${this.sql.unsafe(COLUMNS)} FROM planner_link_holds WHERE channel_id = ${channelId}
			`;
			return row && hold(row);
		});
	}
	list() {
		return this.run("list Planner link holds", async () => {
			let rows = await this.sql<HoldRow[]>`
				SELECT ${this.sql.unsafe(COLUMNS)} FROM planner_link_holds ORDER BY channel_id
			`;
			return rows.map(hold);
		});
	}
}
