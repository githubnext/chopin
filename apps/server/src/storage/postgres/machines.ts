import type { SQL } from "bun";
import { conflict, missing } from "../errors";
import type {
	CreateMachine,
	MachineChoice,
	MachineCredentials,
	MachineRepository,
	StoredMachine,
} from "../model";
import type { MachineStore } from "../port";

type MachineRow = {
	id: string;
	userId: string;
	label: string;
	repositories: MachineRepository[] | string;
	autoRun: boolean;
	tokenHash: Uint8Array;
	ciphertext: Uint8Array | null;
	revision: string | number | null;
	createdAt: Date | string;
	lastSeenAt: Date | string;
	reauthorizeAt: Date | string | null;
	revokedAt: Date | string | null;
};

const COLUMNS = `id, user_id AS "userId", label, repositories, auto_run AS "autoRun",
	token_hash AS "tokenHash", credential_ciphertext AS ciphertext, credential_revision AS revision,
	created_at AS "createdAt", last_seen_at AS "lastSeenAt", reauthorize_at AS "reauthorizeAt",
	revoked_at AS "revokedAt"`;

function machine(row: MachineRow): StoredMachine {
	return {
		id: row.id,
		userId: row.userId,
		label: row.label,
		repositories: typeof row.repositories === "string"
			? JSON.parse(row.repositories)
			: row.repositories,
		autoRun: row.autoRun,
		tokenHash: new Uint8Array(row.tokenHash),
		...(row.ciphertext && row.revision !== null
			? {
				credentials: { ciphertext: new Uint8Array(row.ciphertext), revision: Number(row.revision) },
			}
			: {}),
		createdAt: new Date(row.createdAt),
		lastSeenAt: new Date(row.lastSeenAt),
		...(row.reauthorizeAt ? { reauthorizeAt: new Date(row.reauthorizeAt) } : {}),
		...(row.revokedAt ? { revokedAt: new Date(row.revokedAt) } : {}),
	};
}

export class PostgresMachineStore implements MachineStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
	) {}
	create(input: CreateMachine) {
		return this.run("pair machine", async () => {
			await this.sql`
				INSERT INTO machines (
					id, user_id, label, repositories, auto_run, token_hash, credential_ciphertext,
					credential_revision, created_at, last_seen_at
				) VALUES (
					${input.id}, ${input.userId}, ${input.label}, ${
				JSON.stringify(input.repositories)
			}::text::jsonb,
					${input.autoRun}, ${input.tokenHash}, ${input.credentials?.ciphertext ?? null},
					${input.credentials?.revision ?? null}, ${input.createdAt}, ${input.lastSeenAt}
				)
			`;
		});
	}
	get(id: string) {
		return this.run("read machine", async () => {
			let [row] = await this.sql<MachineRow[]>`
				SELECT ${this.sql.unsafe(COLUMNS)} FROM machines WHERE id = ${id}
			`;
			return row && machine(row);
		});
	}
	byToken(tokenHash: Uint8Array) {
		return this.run("read machine", async () => {
			let [row] = await this.sql<MachineRow[]>`
				SELECT ${this.sql.unsafe(COLUMNS)} FROM machines WHERE token_hash = ${tokenHash}
			`;
			return row && machine(row);
		});
	}
	list(userId: string) {
		return this.run("list machines", async () => {
			let rows = await this.sql<MachineRow[]>`
				SELECT ${this.sql.unsafe(COLUMNS)} FROM machines
				WHERE user_id = ${userId} AND revoked_at IS NULL
				ORDER BY created_at DESC, id
			`;
			return rows.map(machine);
		});
	}
	seen(id: string, now: Date) {
		return this.run("record machine contact", async () => {
			await this.sql`
				UPDATE machines SET last_seen_at = ${now} WHERE id = ${id} AND revoked_at IS NULL
			`;
		});
	}
	rotate(id: string, expectedRevision: number, credentials: MachineCredentials) {
		return this.run("rotate machine credentials", async () => {
			if (credentials.revision !== expectedRevision + 1) {
				throw conflict("invalid credential revision");
			}
			let updated = await this.sql<{ id: string }[]>`
				UPDATE machines
				SET credential_ciphertext = ${credentials.ciphertext},
					credential_revision = ${credentials.revision}
				WHERE id = ${id} AND revoked_at IS NULL AND credential_revision = ${expectedRevision}
				RETURNING id
			`;
			return updated.length > 0;
		});
	}
	reauthorize(id: string, expectedRevision: number, now: Date) {
		return this.run("mark machine for re-authorization", async () => {
			let updated = await this.sql<{ id: string }[]>`
				UPDATE machines
				SET credential_ciphertext = NULL, credential_revision = NULL, reauthorize_at = ${now}
				WHERE id = ${id} AND revoked_at IS NULL AND credential_revision = ${expectedRevision}
				RETURNING id
			`;
			return updated.length > 0;
		});
	}
	rename(id: string, userId: string, label: string) {
		return this.run("rename machine", async () => {
			let updated = await this.sql<{ id: string }[]>`
				UPDATE machines SET label = ${label}
				WHERE id = ${id} AND user_id = ${userId} AND revoked_at IS NULL
				RETURNING id
			`;
			return updated.length > 0;
		});
	}
	revoke(id: string, userId: string, now: Date) {
		return this.run("revoke machine", () =>
			this.sql.begin(async transaction => {
				let updated = await transaction<{ id: string }[]>`
					UPDATE machines
					SET credential_ciphertext = NULL, credential_revision = NULL, revoked_at = ${now}
					WHERE id = ${id} AND user_id = ${userId} AND revoked_at IS NULL
					RETURNING id
				`;
				if (updated.length) await transaction`DELETE FROM machine_choices WHERE machine_id = ${id}`;
				return updated.length > 0;
			}));
	}
	serve(id: string, repository: MachineRepository) {
		return this.run("record a machine's repository", async () => {
			let entry = JSON.stringify([repository]);
			await this.sql`
				UPDATE machines SET repositories = repositories || ${entry}::text::jsonb
				WHERE id = ${id} AND revoked_at IS NULL
					AND NOT repositories @> ${
				JSON.stringify([{ repositoryId: repository.repositoryId }])
			}::text::jsonb
			`;
		});
	}
	choices() {
		return this.run("list machine choices", async () => {
			let rows = await this.sql<MachineChoice[]>`
				SELECT c.channel_id AS "channelId", c.user_id AS "userId", c.machine_id AS "machineId"
				FROM machine_choices c JOIN machines m ON m.id = c.machine_id
				WHERE m.revoked_at IS NULL
			`;
			return rows.map(row => ({ ...row }));
		});
	}
	choose(choice: Omit<MachineChoice, "machineId"> & { machineId?: string }, now: Date) {
		return this.run("choose a machine", async () => {
			if (!choice.machineId) {
				await this.sql`
					DELETE FROM machine_choices
					WHERE channel_id = ${choice.channelId} AND user_id = ${choice.userId}
				`;
				return;
			}
			// Only the person's own unrevoked machine; anything else is missing.
			let inserted = await this.sql<{ machineId: string }[]>`
				INSERT INTO machine_choices (channel_id, user_id, machine_id, chosen_at)
				SELECT ${choice.channelId}, ${choice.userId}, id, ${now} FROM machines
				WHERE id = ${choice.machineId} AND user_id = ${choice.userId} AND revoked_at IS NULL
				ON CONFLICT (channel_id, user_id)
				DO UPDATE SET machine_id = EXCLUDED.machine_id, chosen_at = EXCLUDED.chosen_at
				RETURNING machine_id AS "machineId"
			`;
			if (!inserted.length) throw missing(`machine ${choice.machineId} is not the person's`);
		});
	}
}
