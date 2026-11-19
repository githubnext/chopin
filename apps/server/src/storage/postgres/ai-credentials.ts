import type { SQL } from "bun";
import type { AiCredentialRecord, AiPlaceholder } from "../model";
import type { AiCredentialStore, AiPlaceholderStore } from "../port";

type Run = <T>(action: string, execute: () => Promise<T>) => Promise<T>;

type CredentialRow = {
	userId: string;
	provider: AiCredentialRecord["provider"];
	kind: AiCredentialRecord["kind"];
	ciphertext: Uint8Array | null;
	updatedAt: Date | string;
};

type PlaceholderRow = {
	digest: Uint8Array;
	launchId: string;
	userId: string;
	provider: AiPlaceholder["provider"];
	machineId: string | null;
	channelId: string | null;
	expiresAt: Date | string;
};

const CREDENTIAL_COLUMNS = `user_id AS "userId", provider, kind, ciphertext,
	updated_at AS "updatedAt"`;
const PLACEHOLDER_COLUMNS = `digest, launch_id AS "launchId", user_id AS "userId", provider,
	machine_id AS "machineId", channel_id AS "channelId", expires_at AS "expiresAt"`;
const PROVIDER_ORDER = `CASE provider WHEN 'github-copilot' THEN 0 WHEN 'openai' THEN 1 ELSE 2 END`;

function credential(row: CredentialRow): AiCredentialRecord {
	return {
		userId: row.userId,
		provider: row.provider,
		kind: row.kind,
		...(row.ciphertext ? { ciphertext: new Uint8Array(row.ciphertext) } : {}),
		updatedAt: new Date(row.updatedAt),
	};
}

function placeholder(row: PlaceholderRow): AiPlaceholder {
	return {
		digest: new Uint8Array(row.digest),
		launchId: row.launchId,
		userId: row.userId,
		provider: row.provider,
		...(row.machineId ? { machineId: row.machineId } : {}),
		...(row.channelId ? { channelId: row.channelId } : {}),
		expiresAt: new Date(row.expiresAt),
	};
}

export class PostgresAiCredentialStore implements AiCredentialStore {
	constructor(private sql: SQL, private run: Run) {}
	put(record: AiCredentialRecord) {
		return this.run("save an AI credential", async () => {
			await this.sql`
				INSERT INTO ai_credentials (user_id, provider, kind, ciphertext, updated_at)
				VALUES (
					${record.userId}, ${record.provider}, ${record.kind}, ${record.ciphertext ?? null},
					${record.updatedAt}
				)
				ON CONFLICT (user_id, provider) DO UPDATE SET
					kind = EXCLUDED.kind,
					ciphertext = EXCLUDED.ciphertext,
					updated_at = EXCLUDED.updated_at
			`;
		});
	}
	get(userId: string, provider: AiCredentialRecord["provider"]) {
		return this.run("read an AI credential", async () => {
			let [row] = await this.sql<CredentialRow[]>`
				SELECT ${this.sql.unsafe(CREDENTIAL_COLUMNS)} FROM ai_credentials
				WHERE user_id = ${userId} AND provider = ${provider}
			`;
			return row && credential(row);
		});
	}
	list(userId: string) {
		return this.run("list AI credentials", async () => {
			let rows = await this.sql<CredentialRow[]>`
				SELECT ${this.sql.unsafe(CREDENTIAL_COLUMNS)} FROM ai_credentials
				WHERE user_id = ${userId} ORDER BY ${this.sql.unsafe(PROVIDER_ORDER)}
			`;
			return rows.map(credential);
		});
	}
	delete(userId: string, provider: AiCredentialRecord["provider"]) {
		return this.run("remove an AI credential", async () => {
			let removed = await this.sql<{ provider: string }[]>`
				DELETE FROM ai_credentials WHERE user_id = ${userId} AND provider = ${provider}
				RETURNING provider
			`;
			return removed.length > 0;
		});
	}
}

export class PostgresAiPlaceholderStore implements AiPlaceholderStore {
	constructor(private sql: SQL, private run: Run) {}
	put(placeholders: AiPlaceholder[]) {
		return this.run("save AI placeholders", async () => {
			await this.sql.begin(async transaction => {
				for (let value of placeholders) {
					await transaction`
						INSERT INTO ai_placeholders (
							digest, launch_id, user_id, provider, machine_id, channel_id, expires_at
						)
						VALUES (
							${value.digest}, ${value.launchId}, ${value.userId}, ${value.provider},
							${value.machineId ?? null}, ${value.channelId ?? null}, ${value.expiresAt}
						)
					`;
				}
			});
		});
	}
	find(digest: Uint8Array, now: Date) {
		return this.run("read an AI placeholder", async () => {
			let [row] = await this.sql<PlaceholderRow[]>`
				SELECT ${this.sql.unsafe(PLACEHOLDER_COLUMNS)} FROM ai_placeholders
				WHERE digest = ${digest} AND expires_at > ${now}
			`;
			return row && placeholder(row);
		});
	}
	deleteLaunch(launchId: string) {
		return this.run("end a launch's AI placeholders", async () => {
			let removed = await this.sql<{ launchId: string }[]>`
				DELETE FROM ai_placeholders WHERE launch_id = ${launchId}
				RETURNING launch_id AS "launchId"
			`;
			return removed.length;
		});
	}
	deleteForMachine(machineId: string) {
		return this.run("end a machine's AI placeholders", async () => {
			let removed = await this.sql<{ launchId: string }[]>`
				DELETE FROM ai_placeholders WHERE machine_id = ${machineId}
				RETURNING launch_id AS "launchId"
			`;
			return removed.length;
		});
	}
	deleteExpired(now: Date) {
		return this.run("remove expired AI placeholders", async () => {
			let removed = await this.sql<{ launchId: string }[]>`
				DELETE FROM ai_placeholders WHERE expires_at <= ${now}
				RETURNING launch_id AS "launchId"
			`;
			return removed.length;
		});
	}
}
