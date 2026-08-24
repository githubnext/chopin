import { SQL } from "bun";

import { documentSlug, documentSlugCandidate } from "../../channels/slug";
import { conflict, corrupt, missing, StorageError, unavailable } from "../errors";
import { migrate, verifyMigrations } from "./migrations";
import { PostgresNavigationStore } from "./navigation";
import { PostgresBackgroundJobStore } from "./jobs";
import { PostgresResearchWorkspaceStore } from "./research";

import type { TransactionSQL } from "bun";
import type {
	AgentState,
	ChannelAgent,
	ChannelArchiveInput,
	ChannelArchiveResult,
	ChannelCursor,
	ChannelPage,
	ChannelRecord,
	ChannelScanCursor,
	ChannelScanPage,
	ChannelSnapshot,
	ChannelUpdate,
	CommitChannel,
	CommitResult,
	CreateChannel,
	JsonValue,
	Lease,
	PublishChannelDescription,
	PublishChannelDescriptionResult,
	RenameChannel,
	RenameResult,
	ReplaceChannel,
	SaveCheckpoint,
	StoredChannel,
	StoredEvent,
	UpdateAgentContext,
	UserRecord,
	WebSession,
} from "../model";
import type {
	BackgroundJobStore,
	ChannelStore,
	CollaborationStore,
	LeaseStore,
	NavigationStore,
	ResearchWorkspaceStore,
	SessionStore,
	StorageAdapter,
	UserStore,
} from "../port";

type Timestamp = Date | string;
type Integer = bigint | number | string;

type UserRow = {
	id: string;
	login: string;
	avatarUrl: string;
	createdAt: Timestamp;
	updatedAt: Timestamp;
};

type SessionRow = {
	id: string;
	userId: string;
	expiresAt: Timestamp;
	createdAt: Timestamp;
};

type ChannelRow = {
	id: string;
	repositoryId: string;
	repositoryOwner: string;
	repositoryName: string;
	parentChannelId: string | null;
	title: string;
	slug?: string;
	createdBy: string;
	revision: Integer;
	nextSequence?: Integer;
	createdAt: Timestamp;
	updatedAt: Timestamp;
	archivedAt: Timestamp | null;
	description: string | null;
	descriptionRevision: Integer;
	descriptionPlanRevision: Integer | null;
	descriptionSourceHash: string | null;
	descriptionGeneratorVersion: Integer | null;
	descriptionJobId: string | null;
	descriptionUpdatedAt: Timestamp | null;
};

type SnapshotRow = {
	channelId: string;
	generation: string;
	revision: Integer;
	throughSequence: Integer;
	epoch: string;
	source: string;
	sourceHash: string;
	document: Uint8Array;
	sidecar: unknown;
	createdAt: Timestamp;
};

type UpdateRow = {
	channelId: string;
	sequence: Integer;
	revision: Integer;
	epoch: string;
	update: Uint8Array;
};

type EventRow = {
	id: string;
	channelId: string;
	sequence: Integer;
	ordinal: number;
	kind: string;
	payload: unknown;
	createdAt: Timestamp;
};

type AgentRow = {
	channelId: string;
	ownerSessionId: string | null;
	generation: Integer;
	summary: string;
	transcriptCursor: Integer;
	status: string;
	updatedAt: Timestamp;
};

type LeaseRow = {
	name: string;
	owner: string;
	fencing: Integer;
	expiresAt: Timestamp;
};

type OperationRow = {
	revision: Integer;
	sequence: Integer;
};

type ChannelLockRow = {
	revision: Integer;
	nextSequence: Integer;
	archivedAt: Timestamp | null;
};

function date(value: Timestamp, field: string): Date {
	let parsed = value instanceof Date ? new Date(value) : new Date(value);
	if (Number.isNaN(parsed.getTime())) throw corrupt(`storage returned an invalid ${field}`);
	return parsed;
}

function integer(value: Integer, field: string): number {
	let parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw corrupt(`storage returned an invalid ${field}`);
	}
	return parsed;
}

function bytes(value: Uint8Array, field: string): Uint8Array {
	if (!(value instanceof Uint8Array)) throw corrupt(`storage returned an invalid ${field}`);
	return new Uint8Array(value);
}

function validJson(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(validJson);
	if (typeof value !== "object") return false;
	return Object.values(value as Record<string, unknown>).every(validJson);
}

function json(value: unknown, field: string): JsonValue {
	let parsed = typeof value === "string" ? parseJson(value, field) : value;
	if (!validJson(parsed)) throw corrupt(`storage returned invalid JSON for ${field}`);
	return structuredClone(parsed);
}

function parseJson(value: string, field: string): unknown {
	try {
		return JSON.parse(value);
	} catch (err) {
		throw corrupt(`storage returned invalid JSON for ${field}`, err);
	}
}

function user(row: UserRow): UserRecord {
	return {
		...row,
		createdAt: date(row.createdAt, "user creation time"),
		updatedAt: date(row.updatedAt, "user update time"),
	};
}

function session(row: SessionRow): WebSession {
	return {
		...row,
		expiresAt: date(row.expiresAt, "session expiry"),
		createdAt: date(row.createdAt, "session creation time"),
	};
}

function channel(row: ChannelRow): ChannelRecord {
	if (!row.slug) throw corrupt(`channel ${row.id} has no canonical slug`);
	let {
		archivedAt,
		parentChannelId,
		description,
		descriptionRevision,
		descriptionPlanRevision,
		descriptionSourceHash,
		descriptionGeneratorVersion,
		descriptionJobId,
		descriptionUpdatedAt,
		...record
	} = row;
	let projectionRevision = integer(descriptionRevision, "channel description revision");
	let projected = description === null
		? undefined
		: {
			value: description,
			revision: projectionRevision,
			planRevision: integer(descriptionPlanRevision!, "channel description plan revision"),
			sourceHash: descriptionSourceHash!,
			generatorVersion: integer(
				descriptionGeneratorVersion!,
				"channel description generator version",
			) as 1,
			jobId: descriptionJobId!,
			updatedAt: date(descriptionUpdatedAt!, "channel description update time"),
		};
	if (
		description === null
			? projectionRevision !== 0
				|| descriptionPlanRevision !== null
				|| descriptionSourceHash !== null
				|| descriptionGeneratorVersion !== null
				|| descriptionJobId !== null
				|| descriptionUpdatedAt !== null
			: !description
				|| projectionRevision < 1
				|| descriptionPlanRevision === null
				|| !descriptionSourceHash
				|| descriptionGeneratorVersion === null
				|| integer(descriptionGeneratorVersion, "channel description generator version") !== 1
				|| !descriptionJobId
				|| descriptionUpdatedAt === null
	) throw corrupt(`channel ${row.id} has invalid generated description metadata`);
	return {
		...record,
		...(parentChannelId === null ? {} : { parentChannelId }),
		slug: row.slug,
		revision: integer(row.revision, "channel revision"),
		createdAt: date(row.createdAt, "channel creation time"),
		updatedAt: date(row.updatedAt, "channel update time"),
		...(archivedAt === null ? {} : { archivedAt: date(archivedAt, "channel archive time") }),
		...(projected ? { description: projected } : {}),
	};
}

function snapshot(row: SnapshotRow): ChannelSnapshot {
	return {
		...row,
		revision: integer(row.revision, "snapshot revision"),
		throughSequence: integer(row.throughSequence, "snapshot sequence"),
		document: bytes(row.document, "snapshot document"),
		sidecar: json(row.sidecar, "snapshot sidecar"),
		createdAt: date(row.createdAt, "snapshot creation time"),
	};
}

function update(row: UpdateRow): ChannelUpdate {
	return {
		...row,
		sequence: integer(row.sequence, "update sequence"),
		revision: integer(row.revision, "update revision"),
		update: bytes(row.update, "Yjs update"),
	};
}

function event(row: EventRow): StoredEvent {
	return {
		...row,
		sequence: integer(row.sequence, "event sequence"),
		payload: json(row.payload, "event payload"),
		createdAt: date(row.createdAt, "event creation time"),
	};
}

function agent(row: AgentRow): AgentState {
	if (row.status !== "ready" && row.status !== "unavailable") {
		throw corrupt("storage returned an invalid agent status");
	}
	return {
		...row,
		ownerSessionId: row.ownerSessionId ?? undefined,
		generation: integer(row.generation, "agent ownership generation"),
		transcriptCursor: integer(row.transcriptCursor, "agent transcript cursor"),
		status: row.status,
		updatedAt: date(row.updatedAt, "agent update time"),
	};
}

function lease(row: LeaseRow): Lease {
	return {
		...row,
		fencing: integer(row.fencing, "lease fencing token"),
		expiresAt: date(row.expiresAt, "lease expiry"),
	};
}

function postgresCode(err: unknown): string | undefined {
	if (!err || typeof err !== "object") return undefined;
	if ("errno" in err && typeof err.errno === "string") return err.errno;
	if ("code" in err && typeof err.code === "string") return err.code;
	return undefined;
}

function titlePattern(query: string): string {
	return `%${query.replace(/[\\%_]/g, "\\$&")}%`;
}

const USER_COLUMNS = `
	id,
	login,
	avatar_url AS "avatarUrl",
	created_at AS "createdAt",
	updated_at AS "updatedAt"
`;

const SESSION_COLUMNS = `
	id,
	user_id AS "userId",
	expires_at AS "expiresAt",
	created_at AS "createdAt"
`;

const CHANNEL_COLUMNS = `
	channels.id,
	channels.repository_id AS "repositoryId",
	channels.repository_owner AS "repositoryOwner",
	channels.repository_name AS "repositoryName",
	channels.parent_channel_id AS "parentChannelId",
	channels.title,
	(
		SELECT channel_slugs.slug
		FROM channel_slugs
		WHERE channel_slugs.channel_id = channels.id AND channel_slugs.canonical
	) AS slug,
	channels.created_by AS "createdBy",
	channels.revision,
	channels.created_at AS "createdAt",
	channels.updated_at AS "updatedAt",
	channels.archived_at AS "archivedAt",
	channels.generated_description AS description,
	channels.generated_description_revision AS "descriptionRevision",
	channels.generated_description_plan_revision AS "descriptionPlanRevision",
	channels.generated_description_source_hash AS "descriptionSourceHash",
	channels.generated_description_generator_version AS "descriptionGeneratorVersion",
	channels.generated_description_job_id AS "descriptionJobId",
	channels.generated_description_updated_at AS "descriptionUpdatedAt"
`;

const CHANNEL_RETURNING = `
	id,
	repository_id AS "repositoryId",
	repository_owner AS "repositoryOwner",
	repository_name AS "repositoryName",
	parent_channel_id AS "parentChannelId",
	title,
	created_by AS "createdBy",
	revision,
	created_at AS "createdAt",
	updated_at AS "updatedAt",
	archived_at AS "archivedAt",
	generated_description AS description,
	generated_description_revision AS "descriptionRevision",
	generated_description_plan_revision AS "descriptionPlanRevision",
	generated_description_source_hash AS "descriptionSourceHash",
	generated_description_generator_version AS "descriptionGeneratorVersion",
	generated_description_job_id AS "descriptionJobId",
	generated_description_updated_at AS "descriptionUpdatedAt"
`;

const SNAPSHOT_COLUMNS = `
	channel_id AS "channelId",
	generation,
	revision,
	through_sequence AS "throughSequence",
	epoch,
	source,
	source_hash AS "sourceHash",
	document,
	sidecar,
	created_at AS "createdAt"
`;

const UPDATE_COLUMNS = `
	channel_id AS "channelId",
	sequence,
	revision,
	epoch,
	update
`;

const EVENT_COLUMNS = `
	id,
	channel_id AS "channelId",
	sequence,
	ordinal,
	kind,
	payload,
	created_at AS "createdAt"
`;

const AGENT_COLUMNS = `
	channel_id AS "channelId",
	owner_session_id AS "ownerSessionId",
	generation,
	summary,
	transcript_cursor AS "transcriptCursor",
	status,
	updated_at AS "updatedAt"
`;

const LEASE_COLUMNS = `
	name,
	owner,
	fencing,
	expires_at AS "expiresAt"
`;

/** PostgreSQL is the reference implementation, not part of the storage contract. */
export class PostgresStorage implements StorageAdapter {
	readonly driver = "postgres";
	readonly #sql: SQL;

	constructor(url: string) {
		this.#sql = new SQL(url, { connectionTimeout: 10, idleTimeout: 30, max: 10 });
		this.navigation = new PostgresNavigationStore(
			this.#sql,
			(action, execute) => this.#run(action, execute),
		);
		this.jobs = new PostgresBackgroundJobStore(
			this.#sql,
			(action, execute) => this.#run(action, execute),
			async (transaction, lease) => {
				await this.#assertLease(transaction, lease);
				// The deployment owns one writer; preserve that ordering even if a caller
				// supplies another valid lease name to the provider-neutral port.
				await transaction`SELECT pg_advisory_xact_lock(2043237432)`;
				await this.#assertLease(transaction, lease);
			},
		);
		this.research = new PostgresResearchWorkspaceStore(
			this.#sql,
			(action, execute) => this.#run(action, execute),
			async (transaction, lease) => {
				await this.#assertLease(transaction, lease);
				await transaction`SELECT pg_advisory_xact_lock(2043237432)`;
				await this.#assertLease(transaction, lease);
			},
		);
	}

	readonly users: UserStore = {
		put: input =>
			this.#run("save user", async () => {
				let [saved] = await this.#sql<UserRow[]>`
				INSERT INTO users (id, login, avatar_url, created_at, updated_at)
				VALUES (${input.id}, ${input.login}, ${input.avatarUrl}, ${input.now}, ${input.now})
				ON CONFLICT (id) DO UPDATE SET
					login = EXCLUDED.login,
					avatar_url = EXCLUDED.avatar_url,
					updated_at = EXCLUDED.updated_at
				RETURNING ${this.#sql.unsafe(USER_COLUMNS)}
			`;
				if (!saved) throw corrupt("saving a user returned no record");
				return user(saved);
			}),
		get: id =>
			this.#run("read user", async () => {
				let [found] = await this.#sql<UserRow[]>`
				SELECT ${this.#sql.unsafe(USER_COLUMNS)} FROM users WHERE id = ${id}
			`;
				return found ? user(found) : undefined;
			}),
	};

	readonly sessions: SessionStore = {
		create: input =>
			this.#run("create login session", async () => {
				await this.#sql`
				INSERT INTO web_sessions (
					id, user_id, expires_at, created_at
				) VALUES (
					${input.id}, ${input.userId}, ${input.expiresAt}, ${input.createdAt}
				)
			`;
			}),
		get: (id, now) =>
			this.#run("read login session", async () => {
				let [found] = await this.#sql<SessionRow[]>`
				SELECT ${this.#sql.unsafe(SESSION_COLUMNS)}
				FROM web_sessions
				WHERE id = ${id} AND expires_at > ${now}
			`;
				return found ? session(found) : undefined;
			}),
		delete: id =>
			this.#run("delete login session", () =>
				this.#sql.begin(async transaction => {
					await transaction`
					UPDATE agent_state
					SET owner_session_id = NULL, status = 'unavailable', updated_at = now()
					WHERE owner_session_id = ${id}
				`;
					let deleted = await transaction<{ id: string }[]>`
					DELETE FROM web_sessions WHERE id = ${id} RETURNING id
				`;
					return deleted.length > 0;
				})),
		deleteExpired: now =>
			this.#run("delete expired login sessions", () =>
				this.#sql.begin(async transaction => {
					await transaction`
					UPDATE agent_state
					SET owner_session_id = NULL, status = 'unavailable', updated_at = ${now}
					WHERE owner_session_id IN (
						SELECT id FROM web_sessions WHERE expires_at <= ${now}
					)
				`;
					let deleted = await transaction<{ id: string }[]>`
					DELETE FROM web_sessions WHERE expires_at <= ${now} RETURNING id
				`;
					return deleted.length;
				})),
		deleteAll: (now, held, ttlMs) =>
			this.#run("delete all login sessions", () =>
				this.#sql.begin(async transaction => {
					await this.#assertLease(transaction, held);
					await transaction`
					UPDATE agent_state
					SET owner_session_id = NULL, status = 'unavailable', updated_at = ${now}
					WHERE owner_session_id IS NOT NULL
				`;
					let deleted = await transaction<{ id: string }[]>`
					DELETE FROM web_sessions RETURNING id
					`;
					let [renewed] = await transaction<LeaseRow[]>`
					UPDATE storage_leases
					SET expires_at = clock_timestamp() + (${ttlMs} * interval '1 millisecond')
					WHERE name = ${held.name}
						AND owner = ${held.owner}
						AND fencing = ${held.fencing}
					RETURNING ${transaction.unsafe(LEASE_COLUMNS)}
					`;
					if (!renewed) throw conflict(`storage lease ${held.name} is no longer held`);
					return { deleted: deleted.length, lease: lease(renewed) };
				})),
	};

	readonly navigation: NavigationStore;
	readonly jobs: BackgroundJobStore;
	readonly research: ResearchWorkspaceStore;

	readonly channels: ChannelStore = {
		create: input => this.#createChannel(input),
		get: id =>
			this.#run("read channel", async () => {
				let [found] = await this.#sql<ChannelRow[]>`
				SELECT ${this.#sql.unsafe(CHANNEL_COLUMNS)} FROM channels WHERE id = ${id}
			`;
				return found ? channel(found) : undefined;
			}),
		resolve: (repositoryId, slug) =>
			this.#run("resolve channel slug", async () => {
				let [found] = await this.#sql<ChannelRow[]>`
					SELECT ${this.#sql.unsafe(CHANNEL_COLUMNS)}
					FROM channel_slugs
					JOIN channels
						ON channels.id = channel_slugs.channel_id
						AND channels.repository_id = channel_slugs.repository_id
					WHERE channel_slugs.repository_id = ${repositoryId}
						AND channel_slugs.slug = ${slug}
				`;
				return found ? channel(found) : undefined;
			}),
		rename: input => this.#renameChannel(input),
		archive: input => this.#setChannelArchived(input, true),
		restore: input => this.#setChannelArchived(input, false),
		delete: id => this.#deleteChannel(id),
		publishDescription: input => this.#publishChannelDescription(input),
		list: (repositoryId, limit, after, query, includeArchived) =>
			this.#listChannels(repositoryId, limit, after, query, includeArchived),
		scan: (repositoryId, limit, after, includeArchived) =>
			this.#scanChannels(repositoryId, limit, after, includeArchived),
		claimAgentOwner: (channelId, sessionId, now) =>
			this.#claimAgentOwner(channelId, sessionId, now),
		clearAgentOwner: (channelId, expectedSessionId, expectedGeneration, now) =>
			this.#clearAgentOwner(channelId, expectedSessionId, expectedGeneration, now),
		updateAgentContext: input => this.#updateAgentContext(input),
		readAgent: (channelId, now) => this.#readAgent(channelId, now),
	};

	readonly collaboration: CollaborationStore = {
		load: (channelId, now) => this.#load(channelId, now),
		commit: input => this.#commit(input),
		replace: input => this.#replace(input),
		checkpoint: input => this.#checkpoint(input),
	};

	readonly leases: LeaseStore = {
		acquire: (name, owner, ttlMs) => this.#acquire(name, owner, ttlMs),
		renew: (held, ttlMs) => this.#renew(held, ttlMs),
		release: held => this.#release(held),
	};

	async migrate(): Promise<void> {
		await this.#run("migrate storage", async () => {
			await this.#sql.connect();
			await migrate(this.#sql);
		});
	}

	async health(): Promise<void> {
		await this.#run("check storage", async () => {
			await this.#sql`SELECT 1`;
			await verifyMigrations(this.#sql);
		});
	}

	async close(): Promise<void> {
		await this.#sql.close({ timeout: 5 });
	}

	async #run<T>(action: string, execute: () => Promise<T>): Promise<T> {
		try {
			return await execute();
		} catch (err) {
			if (err instanceof StorageError) throw err;
			let code = postgresCode(err);
			if (code === "23505") throw conflict(`${action} conflicts with an existing record`);
			if (code === "23503") throw missing(`${action} refers to a missing record`);
			throw unavailable(`cannot ${action}`, err);
		}
	}

	#createChannel(input: CreateChannel): Promise<ChannelRecord> {
		return this.#run("create channel", () =>
			this.#sql.begin(async transaction => {
				if (input.parentChannelId) {
					let [parent] = await transaction<{
						parentChannelId: string | null;
						repositoryId: string;
					}[]>`
						SELECT
							parent_channel_id AS "parentChannelId",
							repository_id AS "repositoryId"
						FROM channels
						WHERE id = ${input.parentChannelId}
						FOR KEY SHARE
					`;
					if (!parent) throw missing(`channel ${input.parentChannelId} does not exist`);
					if (parent.repositoryId !== input.repositoryId) {
						throw conflict(`channel ${input.id} must share its parent's repository`);
					}
					if (parent.parentChannelId !== null) {
						throw conflict(`channel ${input.parentChannelId} cannot parent another child`);
					}
				}
				let [saved] = await transaction<ChannelRow[]>`
				INSERT INTO channels (
					id, repository_id, repository_owner, repository_name, parent_channel_id, title,
					created_by, revision, next_sequence, created_at, updated_at
				) VALUES (
					${input.id}, ${input.repositoryId}, ${input.repositoryOwner},
					${input.repositoryName}, ${input.parentChannelId ?? null}, ${input.title},
					${input.createdBy}, 0, 1,
					${input.now}, ${input.now}
				)
				RETURNING ${transaction.unsafe(CHANNEL_RETURNING)}
			`;
				if (!saved) throw corrupt("creating a channel returned no record");
				let slug = await this.#reserveSlug(
					transaction,
					input.repositoryId,
					input.id,
					input.title,
					input.now,
				);
				await transaction`
				INSERT INTO channel_state (channel_id, sidecar)
				VALUES (
					${input.id},
					${input.initial ? JSON.stringify(input.initial.sidecar) : "null"}::jsonb
				)
			`;
				if (input.initial) {
					await transaction`
						INSERT INTO channel_snapshots (
							channel_id, generation, revision, through_sequence, epoch, source,
							source_hash, document, sidecar, created_at
						) VALUES (
							${input.id}, ${input.initial.generation}, 0, 0, ${input.initial.epoch},
							${input.initial.source}, ${input.initial.sourceHash},
							${input.initial.document}, ${JSON.stringify(input.initial.sidecar)}::jsonb,
							${input.now}
						)
					`;
				}
				return channel({ ...saved, slug });
			}));
	}

	#renameChannel(input: RenameChannel): Promise<RenameResult> {
		return this.#run("rename channel", () =>
			this.#sql.begin(async transaction => {
				let [current] = await transaction<ChannelRow[]>`
					SELECT ${transaction.unsafe(CHANNEL_COLUMNS)}
					FROM channels
					WHERE id = ${input.id}
					FOR UPDATE
				`;
				if (!current) throw missing(`channel ${input.id} does not exist`);
				let existing = channel(current);
				if (existing.archivedAt) throw conflict(`channel ${input.id} is archived`);
				if (existing.title === input.title) {
					return { channel: existing, changed: false };
				}
				let updatedAt = input.now > existing.updatedAt
					? input.now
					: new Date(existing.updatedAt.getTime() + 1);
				let [saved] = await transaction<ChannelRow[]>`
					UPDATE channels
					SET title = ${input.title}, updated_at = ${updatedAt}
					WHERE id = ${input.id}
					RETURNING ${transaction.unsafe(CHANNEL_RETURNING)}
				`;
				if (!saved) throw corrupt("renaming a channel returned no record");
				let slug = await this.#reserveSlug(
					transaction,
					existing.repositoryId,
					existing.id,
					input.title,
					input.now,
				);
				return { channel: channel({ ...saved, slug }), changed: true };
			}));
	}

	#setChannelArchived(
		input: ChannelArchiveInput,
		archived: boolean,
	): Promise<ChannelArchiveResult> {
		return this.#run(
			archived ? "archive channel" : "restore channel",
			() =>
				this.#sql.begin(async transaction => {
					let [current] = await transaction<ChannelRow[]>`
					SELECT ${transaction.unsafe(CHANNEL_COLUMNS)}
					FROM channels
					WHERE id = ${input.id}
					FOR UPDATE
				`;
					if (!current) throw missing(`channel ${input.id} does not exist`);
					let existing = channel(current);
					if ((existing.archivedAt !== undefined) === archived) {
						return { channel: existing, changed: false };
					}
					let updatedAt = input.now > existing.updatedAt
						? input.now
						: new Date(existing.updatedAt.getTime() + 1);
					let archivedAt = archived ? updatedAt : null;
					let [saved] = await transaction<ChannelRow[]>`
					UPDATE channels
					SET archived_at = ${archivedAt}, updated_at = ${updatedAt}
					WHERE id = ${input.id}
					RETURNING ${transaction.unsafe(CHANNEL_RETURNING)}
				`;
					if (!saved) throw corrupt("changing channel archival returned no record");
					return { channel: channel({ ...saved, slug: existing.slug }), changed: true };
				}),
		);
	}

	#deleteChannel(id: string): Promise<boolean> {
		return this.#run("delete archived channel", () =>
			this.#sql.begin(async transaction => {
				let [current] = await transaction<{ archivedAt: Timestamp | null }[]>`
					SELECT archived_at AS "archivedAt"
					FROM channels
					WHERE id = ${id}
					FOR UPDATE
				`;
				if (!current) return false;
				if (current.archivedAt === null) {
					throw conflict(`channel ${id} must be archived before deletion`);
				}
				let [child] = await transaction<{ id: string }[]>`
					SELECT id FROM channels WHERE parent_channel_id = ${id} LIMIT 1
				`;
				if (child) throw conflict(`channel ${id} still has child channels`);
				let deleted = await transaction<{ id: string }[]>`
					DELETE FROM channels WHERE id = ${id} RETURNING id
				`;
				if (deleted.length !== 1) throw corrupt("deleting a channel returned no record");
				return true;
			}));
	}

	#publishChannelDescription(
		input: PublishChannelDescription,
	): Promise<PublishChannelDescriptionResult> {
		return this.#run("publish channel description", () =>
			this.#sql.begin(async transaction => {
				await this.#assertLease(transaction, input.lease);
				let [current] = await transaction<ChannelRow[]>`
					SELECT ${transaction.unsafe(CHANNEL_COLUMNS)}
					FROM channels
					WHERE id = ${input.channelId}
					FOR UPDATE
				`;
				if (!current) throw missing(`channel ${input.channelId} does not exist`);
				let existing = channel(current);
				if (
					existing.description?.jobId === input.jobId
					|| existing.description && existing.description.planRevision >= input.planRevision
				) return { channel: existing, changed: false };

				let [saved] = await transaction<ChannelRow[]>`
					UPDATE channels
					SET generated_description = ${input.description},
						generated_description_revision = generated_description_revision + 1,
						generated_description_plan_revision = ${input.planRevision},
						generated_description_source_hash = ${input.sourceHash},
						generated_description_generator_version = ${input.generatorVersion},
						generated_description_job_id = ${input.jobId},
						generated_description_updated_at = ${input.now}
					WHERE id = ${input.channelId}
					RETURNING ${transaction.unsafe(CHANNEL_RETURNING)}
				`;
				if (!saved) throw corrupt("publishing a channel description returned no record");
				return {
					channel: channel({ ...saved, slug: existing.slug }),
					changed: true,
				};
			}));
	}

	async #reserveSlug(
		transaction: TransactionSQL,
		repositoryId: string,
		channelId: string,
		title: string,
		now: Date,
	): Promise<string> {
		let base = documentSlug(title);
		for (let index = 1;; index++) {
			let candidate = documentSlugCandidate(base, index);
			let [inserted] = await transaction<{ channelId: string }[]>`
				INSERT INTO channel_slugs (
					repository_id, slug, channel_id, canonical, created_at
				) VALUES (${repositoryId}, ${candidate}, ${channelId}, false, ${now})
				ON CONFLICT DO NOTHING
				RETURNING channel_id AS "channelId"
			`;
			if (!inserted) {
				let [existing] = await transaction<{ channelId: string }[]>`
					SELECT channel_id AS "channelId"
					FROM channel_slugs
					WHERE repository_id = ${repositoryId} AND slug = ${candidate}
				`;
				if (existing?.channelId !== channelId) continue;
			}

			await transaction`
				UPDATE channel_slugs SET canonical = false
				WHERE channel_id = ${channelId} AND canonical
			`;
			let [promoted] = await transaction<{ slug: string }[]>`
				UPDATE channel_slugs SET canonical = true
				WHERE repository_id = ${repositoryId}
					AND slug = ${candidate}
					AND channel_id = ${channelId}
				RETURNING slug
			`;
			if (!promoted) throw corrupt(`could not reserve a slug for channel ${channelId}`);
			return promoted.slug;
		}
	}

	#listChannels(
		repositoryId: string,
		limit: number,
		after?: ChannelCursor,
		query?: string,
		includeArchived = false,
	): Promise<ChannelPage> {
		return this.#run("list channels", async () => {
			let count = Math.min(100, Math.max(1, limit));
			let pattern = query ? titlePattern(query) : "";
			let rows = after
				? await this.#sql<ChannelRow[]>`
					SELECT ${this.#sql.unsafe(CHANNEL_COLUMNS)}
					FROM channels
					WHERE repository_id = ${repositoryId}
						AND (${includeArchived} OR archived_at IS NULL)
						AND (
							${!query}
							OR title ILIKE ${pattern} ESCAPE '\\'
							OR generated_description ILIKE ${pattern} ESCAPE '\\'
						)
						AND (
							updated_at < ${after.updatedAt}
							OR (updated_at = ${after.updatedAt} AND id > ${after.id})
						)
					ORDER BY updated_at DESC, id ASC
					LIMIT ${count + 1}
				`
				: await this.#sql<ChannelRow[]>`
					SELECT ${this.#sql.unsafe(CHANNEL_COLUMNS)}
					FROM channels
					WHERE repository_id = ${repositoryId}
						AND (${includeArchived} OR archived_at IS NULL)
						AND (
							${!query}
							OR title ILIKE ${pattern} ESCAPE '\\'
							OR generated_description ILIKE ${pattern} ESCAPE '\\'
						)
					ORDER BY updated_at DESC, id ASC
					LIMIT ${count + 1}
				`;
			let more = rows.length > count;
			let page = rows.slice(0, count).map(channel);
			let last = page.at(-1);
			return {
				channels: page,
				next: more && last ? { updatedAt: last.updatedAt, id: last.id } : undefined,
			};
		});
	}

	#scanChannels(
		repositoryId: string,
		limit: number,
		after?: ChannelScanCursor,
		includeArchived = false,
	): Promise<ChannelScanPage> {
		return this.#run("scan channels", async () => {
			let count = Math.min(100, Math.max(1, limit));
			let rows = after
				? await this.#sql<ChannelRow[]>`
					SELECT ${this.#sql.unsafe(CHANNEL_COLUMNS)}
					FROM channels
					WHERE repository_id = ${repositoryId}
						AND (${includeArchived} OR archived_at IS NULL)
						AND (
							created_at < ${after.createdAt}
							OR (created_at = ${after.createdAt} AND id > ${after.id})
						)
					ORDER BY created_at DESC, id ASC
					LIMIT ${count + 1}
				`
				: await this.#sql<ChannelRow[]>`
					SELECT ${this.#sql.unsafe(CHANNEL_COLUMNS)}
					FROM channels
					WHERE repository_id = ${repositoryId}
						AND (${includeArchived} OR archived_at IS NULL)
					ORDER BY created_at DESC, id ASC
					LIMIT ${count + 1}
				`;
			let more = rows.length > count;
			let page = rows.slice(0, count).map(channel);
			let last = page.at(-1);
			return {
				channels: page,
				next: more && last ? { createdAt: last.createdAt, id: last.id } : undefined,
			};
		});
	}

	#claimAgentOwner(channelId: string, sessionId: string, now: Date): Promise<AgentState> {
		return this.#run("claim agent owner", () =>
			this.#sql.begin(async transaction => {
				let [active] = await transaction<{ id: string }[]>`
				SELECT id FROM web_sessions WHERE id = ${sessionId} AND expires_at > ${now}
			`;
				if (!active) throw missing(`session ${sessionId} is not active`);

				await transaction`
				UPDATE agent_state
				SET owner_session_id = NULL, status = 'unavailable', updated_at = ${now}
				WHERE channel_id = ${channelId}
					AND owner_session_id IN (
						SELECT id FROM web_sessions WHERE expires_at <= ${now}
					)
			`;
				let [claimed] = await transaction<AgentRow[]>`
				INSERT INTO agent_state (
					channel_id, owner_session_id, generation, summary,
					transcript_cursor, status, updated_at
				) VALUES (${channelId}, ${sessionId}, 1, '', 0, 'ready', ${now})
				ON CONFLICT (channel_id) DO UPDATE SET
					owner_session_id = EXCLUDED.owner_session_id,
					generation = agent_state.generation + 1,
					status = 'ready',
					updated_at = EXCLUDED.updated_at
				WHERE agent_state.owner_session_id IS NULL
				RETURNING ${transaction.unsafe(AGENT_COLUMNS)}
			`;
				if (claimed) return agent(claimed);
				let [existing] = await transaction<AgentRow[]>`
				SELECT ${transaction.unsafe(AGENT_COLUMNS)}
				FROM agent_state WHERE channel_id = ${channelId}
			`;
				if (!existing) throw corrupt("claiming an agent owner returned no record");
				return agent(existing);
			}));
	}

	#clearAgentOwner(
		channelId: string,
		expectedSessionId: string,
		expectedGeneration: number,
		now: Date,
	): Promise<boolean> {
		return this.#run("clear agent owner", async () => {
			let changed = await this.#sql<{ channelId: string }[]>`
				UPDATE agent_state
				SET owner_session_id = NULL, status = 'unavailable', updated_at = ${now}
				WHERE channel_id = ${channelId}
					AND owner_session_id = ${expectedSessionId}
					AND generation = ${expectedGeneration}
				RETURNING channel_id AS "channelId"
			`;
			return changed.length > 0;
		});
	}

	#readAgent(channelId: string, now: Date): Promise<ChannelAgent | undefined> {
		return this.#run(
			"read agent owner",
			() =>
				this.#sql.begin("isolation level repeatable read read only", async transaction => {
					let [channelRow] = await transaction<ChannelRow[]>`
					SELECT ${transaction.unsafe(CHANNEL_COLUMNS)} FROM channels WHERE id = ${channelId}
				`;
					if (!channelRow) return undefined;
					let [agentRow] = await transaction<AgentRow[]>`
					SELECT ${transaction.unsafe(AGENT_COLUMNS)}
					FROM agent_state WHERE channel_id = ${channelId}
				`;
					let storedAgent = agentRow ? agent(agentRow) : undefined;
					if (storedAgent?.ownerSessionId) {
						let [active] = await transaction<{ id: string }[]>`
						SELECT id FROM web_sessions
						WHERE id = ${storedAgent.ownerSessionId} AND expires_at > ${now}
					`;
						if (!active) {
							storedAgent = { ...storedAgent, ownerSessionId: undefined, status: "unavailable" };
						}
					}
					return { channel: channel(channelRow), agent: storedAgent };
				}),
		);
	}

	#updateAgentContext(input: UpdateAgentContext): Promise<AgentState> {
		return this.#run("update agent context", async () => {
			let [saved] = await this.#sql<AgentRow[]>`
				UPDATE agent_state
				SET summary = ${input.summary},
					transcript_cursor = ${input.transcriptCursor},
					status = ${input.status},
					updated_at = ${input.now}
				WHERE channel_id = ${input.channelId}
					AND owner_session_id = ${input.ownerSessionId}
					AND generation = ${input.generation}
					AND EXISTS (
						SELECT 1 FROM web_sessions
						WHERE id = ${input.ownerSessionId} AND expires_at > ${input.now}
					)
				RETURNING ${this.#sql.unsafe(AGENT_COLUMNS)}
			`;
			if (!saved) throw conflict(`agent owner changed for channel ${input.channelId}`);
			return agent(saved);
		});
	}

	#load(channelId: string, now: Date): Promise<StoredChannel | undefined> {
		return this.#run(
			"load channel",
			() =>
				this.#sql.begin("isolation level repeatable read read only", async transaction => {
					let [channelRow] = await transaction<ChannelRow[]>`
				SELECT ${transaction.unsafe(CHANNEL_COLUMNS)}, next_sequence AS "nextSequence"
				FROM channels WHERE id = ${channelId}
			`;
					if (!channelRow) return undefined;
					let [snapshotRow] = await transaction<SnapshotRow[]>`
				SELECT ${transaction.unsafe(SNAPSHOT_COLUMNS)}
				FROM channel_snapshots WHERE channel_id = ${channelId}
			`;
					let through = snapshotRow
						? integer(snapshotRow.throughSequence, "snapshot sequence")
						: 0;
					let updateRows = await transaction<UpdateRow[]>`
				SELECT ${transaction.unsafe(UPDATE_COLUMNS)}
				FROM channel_updates
				WHERE channel_id = ${channelId} AND sequence > ${through}
				ORDER BY sequence ASC
			`;
					let eventRows = await transaction<EventRow[]>`
				SELECT ${transaction.unsafe(EVENT_COLUMNS)}
				FROM channel_events
				WHERE channel_id = ${channelId}
				ORDER BY sequence ASC, ordinal ASC
			`;
					let [state] = await transaction<{ sidecar: unknown }[]>`
				SELECT sidecar FROM channel_state WHERE channel_id = ${channelId}
			`;
					if (!state) throw corrupt(`channel ${channelId} has no sidecar state`);
					let [agentRow] = await transaction<AgentRow[]>`
				SELECT ${transaction.unsafe(AGENT_COLUMNS)}
				FROM agent_state WHERE channel_id = ${channelId}
			`;
					let storedAgent = agentRow ? agent(agentRow) : undefined;
					if (storedAgent?.ownerSessionId) {
						let [active] = await transaction<{ id: string }[]>`
					SELECT id FROM web_sessions
					WHERE id = ${storedAgent.ownerSessionId} AND expires_at > ${now}
				`;
						if (!active) {
							storedAgent = {
								...storedAgent,
								ownerSessionId: undefined,
								status: "unavailable",
							};
						}
					}
					let nextSequence = integer(channelRow.nextSequence ?? 1, "channel sequence");
					if (nextSequence < 1) throw corrupt("storage returned an invalid channel sequence");
					return {
						channel: channel(channelRow),
						latestSequence: nextSequence - 1,
						snapshot: snapshotRow ? snapshot(snapshotRow) : undefined,
						updates: updateRows.map(update),
						events: eventRows.map(event),
						sidecar: json(state.sidecar, "channel sidecar"),
						agent: storedAgent,
					};
				}),
		);
	}

	#commit(input: CommitChannel): Promise<CommitResult> {
		return this.#run("commit channel", () =>
			this.#sql.begin(async transaction => {
				await this.#assertLease(transaction, input.lease);
				let [locked] = await transaction<ChannelLockRow[]>`
				SELECT revision, next_sequence AS "nextSequence", archived_at AS "archivedAt"
				FROM channels
				WHERE id = ${input.channelId}
				FOR UPDATE
			`;
				if (!locked) throw missing(`channel ${input.channelId} does not exist`);
				let [previous] = await transaction<OperationRow[]>`
				SELECT revision, sequence
				FROM channel_operations
				WHERE channel_id = ${input.channelId} AND operation_id = ${input.operationId}
			`;
				if (previous) {
					return {
						revision: integer(previous.revision, "operation revision"),
						sequence: integer(previous.sequence, "operation sequence"),
						repeated: true,
					};
				}
				if (locked.archivedAt !== null && !input.allowArchived) {
					throw conflict(`channel ${input.channelId} is archived`);
				}
				if (input.allowArchived && (input.update || input.events.length > 0)) {
					throw conflict("archived channel maintenance must be sidecar-only");
				}
				let current = integer(locked.revision, "channel revision");
				if (current !== input.expectedRevision) {
					throw conflict(
						`channel ${input.channelId} is at revision ${current}, expected ${input.expectedRevision}`,
					);
				}
				let sequence = integer(locked.nextSequence, "channel sequence");
				let revision = current + 1;
				await transaction`
				INSERT INTO channel_operations (channel_id, operation_id, sequence, revision)
				VALUES (${input.channelId}, ${input.operationId}, ${sequence}, ${revision})
			`;
				if (input.update) {
					await transaction`
					INSERT INTO channel_updates (channel_id, sequence, revision, epoch, update)
					VALUES (
						${input.channelId}, ${sequence}, ${revision}, ${input.epoch}, ${input.update}
					)
				`;
				}
				if (input.sidecar !== undefined) {
					await transaction`
					UPDATE channel_state
					SET sidecar = ${JSON.stringify(input.sidecar)}::jsonb
					WHERE channel_id = ${input.channelId}
				`;
				}
				for (let [ordinal, item] of input.events.entries()) {
					await transaction`
					INSERT INTO channel_events (
						channel_id, sequence, ordinal, id, kind, payload, created_at
					) VALUES (
						${input.channelId}, ${sequence}, ${ordinal}, ${item.id}, ${item.kind},
						${JSON.stringify(item.payload)}::jsonb, ${item.createdAt}
					)
				`;
				}
				await transaction`
				UPDATE channels
				SET revision = ${revision}, next_sequence = ${sequence + 1},
					updated_at = GREATEST(updated_at, ${input.now})
				WHERE id = ${input.channelId}
			`;
				return { revision, sequence, repeated: false };
			}));
	}

	#checkpoint(input: SaveCheckpoint): Promise<void> {
		return this.#run("checkpoint channel", () =>
			this.#sql.begin(async transaction => {
				await this.#assertLease(transaction, input.lease);
				let [locked] = await transaction<ChannelLockRow[]>`
				SELECT revision, next_sequence AS "nextSequence"
				FROM channels
				WHERE id = ${input.channelId}
				FOR UPDATE
			`;
				if (!locked) throw missing(`channel ${input.channelId} does not exist`);
				let revision = integer(locked.revision, "channel revision");
				let lastSequence = integer(locked.nextSequence, "channel sequence") - 1;
				if (revision !== input.expectedRevision || input.revision !== input.expectedRevision) {
					throw conflict(`channel ${input.channelId} changed before its checkpoint`);
				}
				if (input.throughSequence > lastSequence) {
					throw conflict(`checkpoint for channel ${input.channelId} is ahead of its journal`);
				}
				let [previous] = await transaction<{ throughSequence: Integer }[]>`
				SELECT through_sequence AS "throughSequence"
				FROM channel_snapshots
				WHERE channel_id = ${input.channelId}
			`;
				if (
					previous
					&& integer(previous.throughSequence, "snapshot sequence") > input.throughSequence
				) throw conflict(`channel ${input.channelId} already has a newer checkpoint`);

				await transaction`
				INSERT INTO channel_snapshots (
					channel_id, generation, revision, through_sequence, epoch, source,
					source_hash, document, sidecar, created_at
				) VALUES (
					${input.channelId}, ${input.generation}, ${input.revision},
					${input.throughSequence}, ${input.epoch}, ${input.source}, ${input.sourceHash},
					${input.document}, ${JSON.stringify(input.sidecar)}::jsonb, ${input.createdAt}
				)
				ON CONFLICT (channel_id) DO UPDATE SET
					generation = EXCLUDED.generation,
					revision = EXCLUDED.revision,
					through_sequence = EXCLUDED.through_sequence,
					epoch = EXCLUDED.epoch,
					source = EXCLUDED.source,
					source_hash = EXCLUDED.source_hash,
					document = EXCLUDED.document,
					sidecar = EXCLUDED.sidecar,
					created_at = EXCLUDED.created_at
			`;
				await transaction`
				DELETE FROM channel_updates
				WHERE channel_id = ${input.channelId} AND sequence <= ${input.throughSequence}
			`;
			}));
	}

	#replace(input: ReplaceChannel): Promise<CommitResult> {
		return this.#run("replace channel", () =>
			this.#sql.begin(async transaction => {
				await this.#assertLease(transaction, input.lease);
				let [locked] = await transaction<ChannelLockRow[]>`
					SELECT revision, next_sequence AS "nextSequence", archived_at AS "archivedAt"
					FROM channels
					WHERE id = ${input.channelId}
					FOR UPDATE
				`;
				if (!locked) throw missing(`channel ${input.channelId} does not exist`);
				let [previous] = await transaction<OperationRow[]>`
					SELECT revision, sequence
					FROM channel_operations
					WHERE channel_id = ${input.channelId} AND operation_id = ${input.operationId}
				`;
				if (previous) {
					return {
						revision: integer(previous.revision, "operation revision"),
						sequence: integer(previous.sequence, "operation sequence"),
						repeated: true,
					};
				}
				if (locked.archivedAt !== null) {
					throw conflict(`channel ${input.channelId} is archived`);
				}
				let current = integer(locked.revision, "channel revision");
				if (current !== input.expectedRevision) {
					throw conflict(
						`channel ${input.channelId} is at revision ${current}, expected ${input.expectedRevision}`,
					);
				}
				let sequence = integer(locked.nextSequence, "channel sequence");
				let revision = current + 1;
				await transaction`
					INSERT INTO channel_operations (channel_id, operation_id, sequence, revision)
					VALUES (${input.channelId}, ${input.operationId}, ${sequence}, ${revision})
				`;
				await transaction`
					UPDATE channel_state
					SET sidecar = ${JSON.stringify(input.sidecar)}::jsonb
					WHERE channel_id = ${input.channelId}
				`;
				await transaction`
					INSERT INTO channel_snapshots (
						channel_id, generation, revision, through_sequence, epoch, source,
						source_hash, document, sidecar, created_at
					) VALUES (
						${input.channelId}, ${input.generation}, ${revision}, ${sequence},
						${input.epoch}, ${input.source}, ${input.sourceHash}, ${input.document},
						${JSON.stringify(input.sidecar)}::jsonb, ${input.now}
					)
					ON CONFLICT (channel_id) DO UPDATE SET
						generation = EXCLUDED.generation,
						revision = EXCLUDED.revision,
						through_sequence = EXCLUDED.through_sequence,
						epoch = EXCLUDED.epoch,
						source = EXCLUDED.source,
						source_hash = EXCLUDED.source_hash,
						document = EXCLUDED.document,
						sidecar = EXCLUDED.sidecar,
						created_at = EXCLUDED.created_at
				`;
				await transaction`
					DELETE FROM channel_updates WHERE channel_id = ${input.channelId}
				`;
				await transaction`
					UPDATE channels
					SET revision = ${revision}, next_sequence = ${sequence + 1},
						updated_at = GREATEST(updated_at, ${input.now})
					WHERE id = ${input.channelId}
				`;
				return { revision, sequence, repeated: false };
			}));
	}

	#acquire(name: string, owner: string, ttlMs: number): Promise<Lease | undefined> {
		return this.#run("acquire storage lease", async () => {
			let [saved] = await this.#sql<LeaseRow[]>`
				INSERT INTO storage_leases (name, owner, fencing, expires_at)
				VALUES (
					${name}, ${owner}, 1,
					clock_timestamp() + (${ttlMs} * interval '1 millisecond')
				)
				ON CONFLICT (name) DO UPDATE SET
					owner = EXCLUDED.owner,
					fencing = CASE
						WHEN storage_leases.owner = EXCLUDED.owner
							AND storage_leases.expires_at > clock_timestamp()
						THEN storage_leases.fencing
						ELSE storage_leases.fencing + 1
					END,
					expires_at = EXCLUDED.expires_at
				WHERE storage_leases.expires_at <= clock_timestamp()
					OR storage_leases.owner = EXCLUDED.owner
				RETURNING ${this.#sql.unsafe(LEASE_COLUMNS)}
			`;
			return saved ? lease(saved) : undefined;
		});
	}

	#renew(held: Lease, ttlMs: number): Promise<Lease | undefined> {
		return this.#run("renew storage lease", async () => {
			let [saved] = await this.#sql<LeaseRow[]>`
				UPDATE storage_leases
				SET expires_at = clock_timestamp() + (${ttlMs} * interval '1 millisecond')
				WHERE name = ${held.name}
					AND owner = ${held.owner}
					AND fencing = ${held.fencing}
					AND expires_at > clock_timestamp()
				RETURNING ${this.#sql.unsafe(LEASE_COLUMNS)}
			`;
			return saved ? lease(saved) : undefined;
		});
	}

	#release(held: Lease): Promise<boolean> {
		return this.#run("release storage lease", async () => {
			let released = await this.#sql<{ name: string }[]>`
				UPDATE storage_leases
				SET expires_at = to_timestamp(0)
				WHERE name = ${held.name} AND owner = ${held.owner} AND fencing = ${held.fencing}
				RETURNING name
			`;
			return released.length > 0;
		});
	}

	async #assertLease(transaction: TransactionSQL, held: Lease): Promise<void> {
		let [locked] = await transaction<{ name: string }[]>`
			SELECT name
			FROM storage_leases
			WHERE name = ${held.name}
			FOR UPDATE
		`;
		if (!locked) throw conflict(`storage lease ${held.name} is no longer held`);
		let [active] = await transaction<{ name: string }[]>`
			SELECT name
			FROM storage_leases
			WHERE name = ${held.name}
				AND owner = ${held.owner}
				AND fencing = ${held.fencing}
				AND expires_at > clock_timestamp()
		`;
		if (!active) throw conflict(`storage lease ${held.name} is no longer held`);
	}
}
