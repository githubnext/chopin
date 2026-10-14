import { conflict, missing } from "../errors";
import type { SQL, TransactionSQL } from "bun";
import type { AgendaRecord, AgendaRun, AgendaStore, SaveAgenda } from "../agenda";
import type { Lease } from "../model";

export class PostgresAgendaStore implements AgendaStore {
	constructor(
		private sql: SQL,
		private wrap: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
		private fence: (transaction: TransactionSQL, lease: Lease) => Promise<void>,
	) {}

	get(channelId: string) {
		return this.wrap("read research agenda", async () => {
			let [row] = await this.sql<{ record: AgendaRecord }[]>`
				SELECT record FROM research_agendas WHERE channel_id = ${channelId}
			`;
			return row?.record;
		});
	}

	save(input: SaveAgenda) {
		return this.wrap("save research agenda", () =>
			this.sql.begin(async transaction => {
				await this.fence(transaction, input.lease);
				let id = input.record.channelId;
				let [channel] = await transaction`SELECT id FROM channels WHERE id = ${id} FOR UPDATE`;
				if (!channel) throw missing("agenda document does not exist");
				let [current] = await transaction<{ revision: number | string }[]>`
				SELECT revision FROM research_agendas WHERE channel_id = ${id} FOR UPDATE
			`;
				if (Number(current?.revision ?? 0) !== input.expectedRevision) {
					throw conflict("agenda changed");
				}
				if (input.record.revision !== input.expectedRevision + 1) {
					throw conflict("agenda revision invalid");
				}
				await transaction`
				INSERT INTO research_agendas (channel_id, revision, state, record)
				VALUES (${id}, ${input.record.revision}, ${input.record.state}, ${
					JSON.stringify(input.record)
				}::text::jsonb)
				ON CONFLICT (channel_id) DO UPDATE SET
					revision = EXCLUDED.revision, state = EXCLUDED.state, record = EXCLUDED.record
			`;
				if (input.run) {
					if (input.run.channelId !== id) throw conflict("agenda request document mismatch");
					let inserted = await transaction`
					INSERT INTO research_agenda_runs (id, channel_id, record)
					VALUES (${input.run.id}, ${id}, ${JSON.stringify(input.run)}::text::jsonb)
					ON CONFLICT (id) DO NOTHING RETURNING id
				`;
					if (!inserted.length) throw conflict("agenda request already exists");
				}
				await this.fence(transaction, input.lease);
				return structuredClone(input.record);
			}));
	}

	active() {
		return this.wrap("list active research agendas", async () => {
			let rows = await this.sql<{ id: string }[]>`
				SELECT channel_id AS id FROM research_agendas WHERE state = 'active' ORDER BY channel_id
			`;
			return rows.map(row => row.id);
		});
	}

	run(channelId: string, requestId: string) {
		return this.wrap("read agenda request", async () => {
			let [row] = await this.sql<{ record: AgendaRun }[]>`
				SELECT record FROM research_agenda_runs WHERE channel_id = ${channelId} AND id = ${requestId}
			`;
			return row?.record;
		});
	}

	linkRun(input: Parameters<AgendaStore["linkRun"]>[0]) {
		return this.wrap("link agenda request", () =>
			this.sql.begin(async transaction => {
				await this.fence(transaction, input.lease);
				let [row] = await transaction<{ record: AgendaRun }[]>`
				SELECT record FROM research_agenda_runs
				WHERE channel_id = ${input.channelId} AND id = ${input.requestId} FOR UPDATE
			`;
				if (!row) throw missing("agenda request does not exist");
				if (row.record.workspaceId && row.record.workspaceId !== input.workspaceId) {
					throw conflict("agenda request already linked");
				}
				let updated = { ...row.record, workspaceId: input.workspaceId };
				await transaction`UPDATE research_agenda_runs SET record = ${
					JSON.stringify(updated)
				}::text::jsonb
				WHERE id = ${input.requestId}`;
				await this.fence(transaction, input.lease);
			}));
	}
}
