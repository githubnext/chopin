import type { SQL } from "bun";
import type { MachineDatabaseState, StoredMachineDatabase } from "../model";
import type { MachineDatabaseStore } from "../port";

type Row = {
	machineId: string;
	role: string;
	revision: number;
	ciphertext: Uint8Array;
	candidateRevision: number | null;
	candidateCiphertext: Uint8Array | null;
	state: MachineDatabaseState;
	failure: string | null;
	updatedAt: Date | string;
	disabledAt: Date | string | null;
	droppedAt: Date | string | null;
};

const COLUMNS = `d.machine_id AS "machineId", d.role_name AS role, d.revision, d.ciphertext,
	d.candidate_revision AS "candidateRevision", d.candidate_ciphertext AS "candidateCiphertext", d.state,
	d.failure, d.updated_at AS "updatedAt", d.disabled_at AS "disabledAt", d.dropped_at AS "droppedAt"`;

function record(row: Row): StoredMachineDatabase {
	return {
		machineId: row.machineId,
		role: row.role,
		revision: Number(row.revision),
		ciphertext: new Uint8Array(row.ciphertext),
		...(row.candidateRevision !== null && row.candidateCiphertext
			? {
				candidate: {
					revision: Number(row.candidateRevision),
					ciphertext: new Uint8Array(row.candidateCiphertext),
				},
			}
			: {}),
		state: row.state,
		...(row.failure ? { failure: row.failure } : {}),
		updatedAt: new Date(row.updatedAt),
		...(row.disabledAt ? { disabledAt: new Date(row.disabledAt) } : {}),
		...(row.droppedAt ? { droppedAt: new Date(row.droppedAt) } : {}),
	};
}

export class PostgresMachineDatabaseStore implements MachineDatabaseStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
	) {}
	get(machineId: string) {
		return this.run("read a machine's database login", async () => {
			let [row] = await this.sql<Row[]>`
				SELECT ${
				this.sql.unsafe(COLUMNS)
			} FROM machine_databases d WHERE d.machine_id = ${machineId}
			`;
			return row && record(row);
		});
	}
	many(machineIds: readonly string[]) {
		return this.run("read machines' database logins", async () => {
			if (!machineIds.length) return [];
			let rows = await this.sql<Row[]>`
				SELECT ${this.sql.unsafe(COLUMNS)} FROM machine_databases d
				WHERE d.machine_id IN ${this.sql([...machineIds])}
			`;
			return rows.map(record);
		});
	}
	claim(input: StoredMachineDatabase) {
		return this.run("keep a machine's database login", async () => {
			await this.sql`
				INSERT INTO machine_databases (
					machine_id, role_name, revision, ciphertext, candidate_revision, candidate_ciphertext, state,
					failure, updated_at, disabled_at, dropped_at
				) VALUES (
					${input.machineId}, ${input.role}, ${input.revision}, ${input.ciphertext},
					${input.candidate?.revision ?? null}, ${
				input.candidate?.ciphertext ?? null
			}, ${input.state},
					${input.failure ?? null}, ${input.updatedAt}, ${input.disabledAt ?? null},
					${input.droppedAt ?? null}
				)
				ON CONFLICT (machine_id) DO NOTHING
			`;
			let [row] = await this.sql<Row[]>`
				SELECT ${this.sql.unsafe(COLUMNS)} FROM machine_databases d
				WHERE d.machine_id = ${input.machineId}
			`;
			return record(row!);
		});
	}
	put(input: StoredMachineDatabase) {
		return this.run("change a machine's database login", async () => {
			let rows = await this.sql<{ machineId: string }[]>`
				UPDATE machine_databases SET
					revision = ${input.revision},
					ciphertext = ${input.ciphertext},
					candidate_revision = ${input.candidate?.revision ?? null},
					candidate_ciphertext = ${input.candidate?.ciphertext ?? null},
					state = ${input.state},
					failure = ${input.failure ?? null},
					updated_at = ${input.updatedAt},
					disabled_at = ${input.disabledAt ?? null},
					dropped_at = ${input.droppedAt ?? null}
				WHERE machine_id = ${input.machineId} AND role_name = ${input.role}
				RETURNING machine_id AS "machineId"
			`;
			return rows.length > 0;
		});
	}
	settling(dropBefore?: Date) {
		return this.run("list machines' database logins to settle", async () => {
			let rows = await this.sql<Row[]>`
				SELECT ${this.sql.unsafe(COLUMNS)} FROM machine_databases d
				JOIN machines m ON m.id = d.machine_id
				WHERE (m.revoked_at IS NOT NULL AND d.state NOT IN ('disabled', 'dropped'))
					${
				dropBefore
					? this.sql`OR (d.state = 'disabled' AND d.disabled_at <= ${dropBefore})`
					: this.sql``
			}
				ORDER BY d.machine_id
			`;
			return rows.map(record);
		});
	}
}
