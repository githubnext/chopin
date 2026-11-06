import type { SQL } from "bun";
import type { PlannerCredential } from "../model";
import type { PlannerCredentialStore } from "../port";

type CredentialRow = {
	digest: Uint8Array;
	machineId: string;
	channelId: string;
	expiresAt: Date | string;
};

const COLUMNS = `digest, machine_id AS "machineId", channel_id AS "channelId",
	expires_at AS "expiresAt"`;

export class PostgresPlannerCredentialStore implements PlannerCredentialStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
	) {}
	put(credential: PlannerCredential) {
		return this.run("save a Planner credential", async () => {
			await this.sql`
				INSERT INTO planner_credentials (digest, machine_id, channel_id, expires_at)
				VALUES (
					${credential.digest}, ${credential.machineId}, ${credential.channelId},
					${credential.expiresAt}
				)
			`;
		});
	}
	find(digest: Uint8Array, now: Date) {
		return this.run("read a Planner credential", async () => {
			let [row] = await this.sql<CredentialRow[]>`
				SELECT ${this.sql.unsafe(COLUMNS)} FROM planner_credentials
				WHERE digest = ${digest} AND expires_at > ${now}
			`;
			return row && {
				digest: new Uint8Array(row.digest),
				machineId: row.machineId,
				channelId: row.channelId,
				expiresAt: new Date(row.expiresAt),
			};
		});
	}
	delete(digest: Uint8Array) {
		return this.run("remove a Planner credential", async () => {
			let removed = await this.sql<{ machineId: string }[]>`
				DELETE FROM planner_credentials WHERE digest = ${digest} RETURNING machine_id AS "machineId"
			`;
			return removed.length > 0;
		});
	}
	deleteForMachine(machineId: string, channelId?: string) {
		return this.run("remove a machine's Planner credentials", async () => {
			let removed = await this.sql<{ machineId: string }[]>`
				DELETE FROM planner_credentials
				WHERE machine_id = ${machineId}
					${channelId === undefined ? this.sql`` : this.sql`AND channel_id = ${channelId}`}
				RETURNING machine_id AS "machineId"
			`;
			return removed.length;
		});
	}
	deleteExpired(now: Date) {
		return this.run("remove expired Planner credentials", async () => {
			let removed = await this.sql<{ machineId: string }[]>`
				DELETE FROM planner_credentials WHERE expires_at <= ${now}
				RETURNING machine_id AS "machineId"
			`;
			return removed.length;
		});
	}
}
