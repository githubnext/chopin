import { investigationSchema } from "@chopin/experiment/records";
import type { Investigation } from "@chopin/experiment/records";
import type { SQL, TransactionSQL } from "bun";
import type { ExperimentStore } from "../experiments";
import type { Lease } from "../model";
import { conflict, missing } from "../errors";

function decode(value: unknown): Investigation {
	return investigationSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
}

export class PostgresExperimentStore implements ExperimentStore {
	constructor(
		private sql: SQL,
		private fence: (sql: TransactionSQL, lease: Lease) => Promise<void>,
	) {}
	async get(id: string) {
		let [row] = await this.sql<
			{ payload: unknown }[]
		>`SELECT payload FROM experiments WHERE id = ${id}`;
		return row ? decode(row.payload) : undefined;
	}
	async list(documentId: string) {
		let rows = await this.sql<
			{ payload: unknown }[]
		>`SELECT payload FROM experiments WHERE channel_id = ${documentId} ORDER BY created_at DESC LIMIT 100`;
		return rows.map(row => decode(row.payload));
	}
	async active() {
		let rows = await this.sql<
			{ payload: unknown }[]
		>`SELECT payload FROM experiments WHERE state IN ('queued', 'running', 'publishing')`;
		return rows.map(row => decode(row.payload));
	}
	async save(value: Investigation, expected: number | undefined, lease: Lease): Promise<boolean> {
		let parsed = investigationSchema.parse(value);
		if (value.revision !== (expected === undefined ? 0 : expected + 1)) {
			throw conflict("invalid experiment revision");
		}
		return await this.sql.begin(async sql => {
			await this.fence(sql, lease);
			let [channel] = await sql`SELECT id FROM channels WHERE id = ${value.documentId} FOR UPDATE`;
			if (!channel) throw missing("experiment document not found");
			let rows = expected === undefined
				? await sql`INSERT INTO experiments (id, channel_id, revision, state, created_at, payload)
					VALUES (${value.id}, ${value.documentId}, 0, ${value.state}, ${new Date(
					value.createdAt,
				)}, ${JSON.stringify(parsed)}::jsonb)
					ON CONFLICT DO NOTHING RETURNING id`
				: await sql`UPDATE experiments SET revision = ${value.revision}, state = ${value.state}, payload = ${
					JSON.stringify(parsed)
				}::jsonb
					WHERE id = ${value.id} AND channel_id = ${value.documentId} AND revision = ${expected} RETURNING id`;
			return rows.length === 1;
		}) as boolean;
	}
}
