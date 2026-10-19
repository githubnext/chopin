import type { SQL } from "bun";
import type { PutRunStages, RunStageRecord } from "../model";
import type { RunStageStore } from "../port";

type StageRow = {
	id: string;
	name: string;
	kind: "tool" | null;
	status: RunStageRecord["status"];
	parentIds: string[] | null;
	started: number | null;
	ended: number | null;
};

function record(row: StageRow): RunStageRecord {
	return {
		id: row.id,
		name: row.name,
		...(row.parentIds ? { parentIds: row.parentIds } : {}),
		...(row.kind ? { kind: row.kind } : {}),
		status: row.status,
		...(row.started !== null ? { started: Number(row.started) } : {}),
		...(row.ended !== null ? { ended: Number(row.ended) } : {}),
	};
}

export class PostgresRunStageStore implements RunStageStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
	) {}
	put(input: PutRunStages) {
		let { channelId, runId } = input;
		// A repeated id keeps its first position and last value, as one upsert cannot touch a row twice.
		let unique = new Map<string, RunStageRecord>();
		for (let stage of input.stages) unique.set(stage.id, stage);
		let rows = [...unique.values()].map((stage, i) => ({
			i,
			id: stage.id,
			name: stage.name,
			kind: stage.kind ?? null,
			status: stage.status,
			parent_ids: stage.parentIds ?? null,
			started: stage.started ?? null,
			ended: stage.ended ?? null,
		}));
		return this.run("save workflow run stages", () =>
			this.sql.begin(async transaction => {
				// New stages of one run take consecutive positions after its last one.
				await transaction`
					SELECT pg_advisory_xact_lock(hashtext(${channelId}), hashtext(${runId}))
				`;
				if (input.replace) {
					await transaction`
						DELETE FROM workflow_run_stages WHERE channel_id = ${channelId} AND run_id = ${runId}
					`;
				}
				if (rows.length) {
					await transaction`
						INSERT INTO workflow_run_stages (
							channel_id, run_id, stage_id, position, name, kind, status, parent_ids, started, ended
						)
						SELECT ${channelId}, ${runId}, x.id, base.next + x.i, x.name, x.kind, x.status,
							x.parent_ids, x.started, x.ended
						FROM jsonb_to_recordset(${JSON.stringify(rows)}::text::jsonb) AS x(
							i bigint, id text, name text, kind text, status text, parent_ids jsonb,
							started bigint, ended bigint
						),
						(
							SELECT coalesce(max(position) + 1, 0) AS next FROM workflow_run_stages
							WHERE channel_id = ${channelId} AND run_id = ${runId}
						) base
						ORDER BY x.i
						ON CONFLICT (channel_id, run_id, stage_id) DO UPDATE SET
							name = EXCLUDED.name,
							kind = EXCLUDED.kind,
							status = EXCLUDED.status,
							parent_ids = EXCLUDED.parent_ids,
							started = EXCLUDED.started,
							ended = EXCLUDED.ended
					`;
				}
				let [counted] = await transaction<{ total: number }[]>`
					SELECT count(*)::integer AS total FROM workflow_run_stages
					WHERE channel_id = ${channelId} AND run_id = ${runId}
				`;
				return counted?.total ?? 0;
			}));
	}
	list(channelId: string, runId: string, page: { offset: number; limit: number }) {
		return this.run("read workflow run stages", async () => {
			let rows = await this.sql<StageRow[]>`
				SELECT stage_id AS id, name, kind, status, parent_ids AS "parentIds",
					started::float8 AS started, ended::float8 AS ended
				FROM workflow_run_stages
				WHERE channel_id = ${channelId} AND run_id = ${runId}
				ORDER BY position
				OFFSET ${page.offset} LIMIT ${page.limit}
			`;
			let [counted] = await this.sql<{ total: number }[]>`
				SELECT count(*)::integer AS total FROM workflow_run_stages
				WHERE channel_id = ${channelId} AND run_id = ${runId}
			`;
			return { stages: rows.map(record), total: counted?.total ?? 0 };
		});
	}
	retain(channelId: string, runIds: string[]) {
		return this.run("forget workflow run stages", async () => {
			await this.sql`
				DELETE FROM workflow_run_stages
				WHERE channel_id = ${channelId}
					AND run_id NOT IN (SELECT jsonb_array_elements_text(${
				JSON.stringify(runIds)
			}::text::jsonb))
			`;
		});
	}
}
