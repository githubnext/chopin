import type { SQL, TransactionSQL } from "bun";
import type { AiCutoffs } from "../ai-cutoffs";
import type { AiCredentialRecord, AiPlaceholder, Lease } from "../model";
import type { AiCredentialStore, AiPlaceholderStore } from "../port";

type Run = <T>(action: string, execute: () => Promise<T>) => Promise<T>;
/** Throws unless `lease` is held, in the transaction a cutoff is written in. */
type Fence = (transaction: TransactionSQL, lease: Lease) => Promise<void>;

type CredentialRow = {
	userId: string;
	provider: AiCredentialRecord["provider"];
	kind: AiCredentialRecord["kind"];
	ciphertext: Uint8Array | null;
	tokens: Uint8Array | null;
	suffix: string | null;
	updatedAt: Date | string;
	lastUsedAt: Date | string | null;
	rejectedAt: Date | string | null;
};

type PlaceholderRow = {
	digest: Uint8Array;
	launchId: string;
	launchDigest: Uint8Array;
	userId: string;
	provider: AiPlaceholder["provider"];
	machineId: string | null;
	channelId: string | null;
	generation: number | null;
	owner: string | null;
	expiresAt: Date | string;
};

const CREDENTIAL_COLUMNS = `user_id AS "userId", provider, kind, ciphertext, tokens, suffix,
	updated_at AS "updatedAt", last_used_at AS "lastUsedAt", rejected_at AS "rejectedAt"`;
const PLACEHOLDER_COLUMNS = `digest, launch_id AS "launchId",
	launch_digest AS "launchDigest", user_id AS "userId", provider,
	machine_id AS "machineId", channel_id AS "channelId", archive_generation AS "generation",
	owner, expires_at AS "expiresAt"`;
const PROVIDER_ORDER = `CASE provider WHEN 'github-copilot' THEN 0 WHEN 'openai' THEN 1
	WHEN 'anthropic' THEN 2 WHEN 'chatgpt' THEN 3 ELSE 4 END`;

function credential(row: CredentialRow): AiCredentialRecord {
	return {
		userId: row.userId,
		provider: row.provider,
		kind: row.kind,
		...(row.ciphertext ? { ciphertext: new Uint8Array(row.ciphertext) } : {}),
		...(row.tokens ? { tokens: new Uint8Array(row.tokens) } : {}),
		...(row.suffix ? { suffix: row.suffix } : {}),
		updatedAt: new Date(row.updatedAt),
		...(row.lastUsedAt ? { lastUsedAt: new Date(row.lastUsedAt) } : {}),
		...(row.rejectedAt ? { rejectedAt: new Date(row.rejectedAt) } : {}),
	};
}

function placeholder(row: PlaceholderRow): AiPlaceholder {
	return {
		digest: new Uint8Array(row.digest),
		launchId: row.launchId,
		launchDigest: new Uint8Array(row.launchDigest),
		userId: row.userId,
		provider: row.provider,
		...(row.machineId ? { machineId: row.machineId } : {}),
		...(row.channelId ? { channelId: row.channelId } : {}),
		...(row.generation !== null ? { generation: row.generation } : {}),
		...(row.owner !== null ? { owner: row.owner } : {}),
		expiresAt: new Date(row.expiresAt),
	};
}

export class PostgresAiCredentialStore implements AiCredentialStore {
	constructor(
		private sql: SQL,
		private run: Run,
		private fence: Fence,
		private cutoffs: AiCutoffs,
	) {}
	put(lease: Lease, record: AiCredentialRecord) {
		return this.#cut(
			record.userId,
			this.run("save an AI credential", () =>
				this.sql.begin(async transaction => {
					await this.fence(transaction, lease);
					await transaction`
				INSERT INTO ai_credentials (
					user_id, provider, kind, ciphertext, tokens, suffix, updated_at, last_used_at,
					rejected_at
				)
				VALUES (
					${record.userId}, ${record.provider}, ${record.kind}, ${record.ciphertext ?? null},
					${record.tokens ?? null}, ${record.suffix ?? null}, ${record.updatedAt},
					${record.lastUsedAt ?? null}, ${record.rejectedAt ?? null}
				)
				ON CONFLICT (user_id, provider) DO UPDATE SET
					kind = EXCLUDED.kind,
					ciphertext = EXCLUDED.ciphertext,
					tokens = EXCLUDED.tokens,
					suffix = EXCLUDED.suffix,
					updated_at = EXCLUDED.updated_at,
					last_used_at = EXCLUDED.last_used_at,
					rejected_at = EXCLUDED.rejected_at
			`;
				})),
		);
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
	delete(lease: Lease, userId: string, provider: AiCredentialRecord["provider"]) {
		return this.#cut(
			userId,
			this.run("remove an AI credential", () =>
				this.sql.begin(async transaction => {
					await this.fence(transaction, lease);
					let removed = await transaction<{ provider: string }[]>`
				DELETE FROM ai_credentials WHERE user_id = ${userId} AND provider = ${provider}
				RETURNING provider
			`;
					return removed.length > 0;
				})),
		);
	}
	used(record: AiCredentialRecord, at: Date) {
		return this.run("record an AI credential's use", async () => {
			await this.sql`
				UPDATE ai_credentials SET last_used_at = ${at}
				WHERE user_id = ${record.userId} AND provider = ${record.provider}
					AND updated_at = ${record.updatedAt}
					AND ciphertext IS NOT DISTINCT FROM ${record.ciphertext ?? null}
					AND (last_used_at IS NULL OR last_used_at < ${at})
			`;
		});
	}
	async rejected(record: AiCredentialRecord, at: Date) {
		let marked = await this.run("record that an AI credential was refused", async () => {
			let rows = await this.sql<{ provider: string }[]>`
				UPDATE ai_credentials SET rejected_at = ${at}
				WHERE user_id = ${record.userId} AND provider = ${record.provider}
					AND updated_at = ${record.updatedAt}
					AND ciphertext IS NOT DISTINCT FROM ${record.ciphertext ?? null}
					AND tokens IS NOT DISTINCT FROM ${record.tokens ?? null}
					AND rejected_at IS NULL
				RETURNING provider
			`;
			return rows.length > 0;
		});
		// Counted once it committed, so a launch reading the key meanwhile reads it again.
		if (marked) this.cutoffs.cut(record.userId);
		return marked;
	}
	refreshed(lease: Lease, record: AiCredentialRecord, tokens: Uint8Array) {
		return this.run(
			"save an AI sign-in's refreshed tokens",
			() =>
				this.sql.begin(async transaction => {
					await this.fence(transaction, lease);
					let rows = await transaction<{ provider: string }[]>`
					UPDATE ai_credentials SET tokens = ${tokens}
					WHERE user_id = ${record.userId} AND provider = ${record.provider}
						AND updated_at = ${record.updatedAt}
						AND ciphertext IS NOT DISTINCT FROM ${record.ciphertext ?? null}
						AND tokens IS NOT DISTINCT FROM ${record.tokens ?? null}
					RETURNING provider
				`;
					return rows.length > 0;
				}),
		);
	}
	version(userId: string) {
		return this.cutoffs.person(userId);
	}
	/** Counts `write` for its person once it settles, committed or not, before its caller hears. */
	#cut<T>(userId: string, write: Promise<T>): Promise<T> {
		return write.finally(() => this.cutoffs.cut(userId));
	}
}

export class PostgresAiPlaceholderStore implements AiPlaceholderStore {
	constructor(
		private sql: SQL,
		private run: Run,
		private fence: Fence,
		private counted: AiCutoffs,
	) {}
	put(placeholders: AiPlaceholder[]) {
		return this.run("save AI placeholders", () =>
			this.sql.begin(async transaction => {
				// Shared, so an archive waits for this to commit and then deletes what it stored, or
				// commits first and this reads the document archived.
				for (let channelId of new Set(placeholders.map(value => value.channelId))) {
					if (channelId === undefined) continue;
					let [open] = await transaction<{ generation: number; archived: boolean }[]>`
						SELECT archive_generation AS generation, archived_at IS NOT NULL AS archived
						FROM channels WHERE id = ${channelId}
						FOR SHARE
					`;
					// A missing document is refused by its reference, below.
					if (!open) continue;
					if (
						open.archived
						|| placeholders.some(value =>
							value.channelId === channelId && value.generation !== open.generation
						)
					) return false;
				}
				for (let value of placeholders) {
					await transaction`
						INSERT INTO ai_placeholders (
							digest, launch_id, launch_digest, user_id, provider, machine_id, channel_id,
							archive_generation, owner, expires_at
						)
						VALUES (
							${value.digest}, ${value.launchId}, ${value.launchDigest}, ${value.userId},
							${value.provider},
							${value.machineId ?? null}, ${value.channelId ?? null},
							${value.channelId === undefined ? null : value.generation ?? null},
							${value.owner ?? null}, ${value.expiresAt}
						)
					`;
				}
				return true;
			}));
	}
	generation(channelId: string) {
		return this.run("read a document's archive generation", async () => {
			let [open] = await this.sql<{ generation: number }[]>`
				SELECT archive_generation AS generation FROM channels
				WHERE id = ${channelId} AND archived_at IS NULL
			`;
			return open?.generation;
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
	findLaunch(launchDigest: Uint8Array, now: Date) {
		return this.run("read an AI launch", async () => {
			let [row] = await this.sql<PlaceholderRow[]>`
				SELECT ${this.sql.unsafe(PLACEHOLDER_COLUMNS)} FROM ai_placeholders
				WHERE launch_digest = ${launchDigest} AND expires_at > ${now}
				LIMIT 1
			`;
			return row && placeholder(row);
		});
	}
	owned(now: Date) {
		return this.run("list owned AI launches", async () => {
			let rows = await this.sql<{ launchId: string; owner: string; channelId: string | null }[]>`
				SELECT DISTINCT ON (launch_id) launch_id AS "launchId", owner, channel_id AS "channelId"
				FROM ai_placeholders
				WHERE owner IS NOT NULL AND expires_at > ${now}
				ORDER BY launch_id
			`;
			return rows.map(row => ({
				launchId: row.launchId,
				owner: row.owner,
				...(row.channelId ? { channelId: row.channelId } : {}),
			}));
		});
	}
	deleteLaunch(lease: Lease, launchId: string) {
		return this.run("end a launch's AI placeholders", () =>
			this.sql.begin(async transaction => {
				await this.fence(transaction, lease);
				let removed = await transaction<{ launchId: string }[]>`
				DELETE FROM ai_placeholders WHERE launch_id = ${launchId}
				RETURNING launch_id AS "launchId"
			`;
				return removed.length;
			})).finally(() => this.counted.cut());
	}
	deleteHeldLaunch(lease: Lease, launchDigest: Uint8Array, machineId: string) {
		return this.run(
			"end a held launch's AI placeholders",
			() =>
				this.sql.begin(async transaction => {
					await this.fence(transaction, lease);
					let removed = await transaction<{ launchId: string }[]>`
				DELETE FROM ai_placeholders
				WHERE launch_digest = ${launchDigest} AND machine_id = ${machineId}
				RETURNING launch_id AS "launchId"
			`;
					return removed.length;
				}),
		).finally(() => this.counted.cut());
	}
	deleteForMachine(lease: Lease, machineId: string) {
		return this.run("end a machine's AI placeholders", () =>
			this.sql.begin(async transaction => {
				await this.fence(transaction, lease);
				let removed = await transaction<{ launchId: string }[]>`
				DELETE FROM ai_placeholders WHERE machine_id = ${machineId}
				RETURNING launch_id AS "launchId"
			`;
				return removed.length;
			})).finally(() => this.counted.cut());
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
	cutoffs() {
		return this.counted.all();
	}
}
