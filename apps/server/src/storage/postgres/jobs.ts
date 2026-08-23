import { conflict, corrupt, missing } from "../errors";
import { appendProgress, progress } from "../progress";

import type { SQL, TransactionSQL } from "bun";
import type {
	AppendBackgroundJobProgress,
	BackgroundJob,
	BackgroundJobArtifact,
	BackgroundJobCursor,
	BackgroundJobDetail,
	BackgroundJobOrigin,
	BackgroundJobPage,
	BackgroundJobState,
	BackgroundJobSummary,
	BackgroundJobTarget,
	CancelBackgroundJob,
	ClaimBackgroundJobs,
	ClaimedBackgroundJob,
	ControlBackgroundJob,
	EnqueueBackgroundJob,
	FailBackgroundJob,
	JsonValue,
	Lease,
	PauseBackgroundJob,
	RenewBackgroundJob,
	RequeueBackgroundJob,
	ResumeBackgroundJob,
	SettleBackgroundJob,
	SupersedeBackgroundJob,
} from "../model";
import type { BackgroundJobStore } from "../port";

type Timestamp = Date | string;
type Integer = bigint | number | string;
type Run = <T>(action: string, execute: () => Promise<T>) => Promise<T>;
type Fence = (transaction: TransactionSQL, lease: Lease) => Promise<void>;

type JobRow = {
	id: string;
	channelId: string;
	type: string;
	version: Integer;
	origin: string;
	targetKey: string;
	targetGeneration: Integer;
	idempotencyKey: string;
	fingerprint: string;
	input: unknown;
	state: string;
	revision: Integer;
	attempts: Integer;
	failures: Integer;
	claimGeneration: Integer;
	claimOwner: string | null;
	claimBinding: unknown | null;
	claimExpiresAt: Timestamp | null;
	availableAt: Timestamp;
	reason: string | null;
	progress: unknown;
	createdAt: Timestamp;
	updatedAt: Timestamp;
};

type ArtifactRow = {
	jobId: string;
	revision: Integer;
	value: unknown;
	createdAt: Timestamp;
};

type TargetRow = {
	channelId: string;
	targetKey: string;
	generation: Integer;
};

const JOB_COLUMNS = `
	id,
	channel_id AS "channelId",
	type,
	version,
	origin,
	target_key AS "targetKey",
	target_generation AS "targetGeneration",
	idempotency_key AS "idempotencyKey",
	fingerprint,
	input,
	state,
	revision,
	attempts,
	failures,
	claim_generation AS "claimGeneration",
	claim_owner AS "claimOwner",
	claim_binding AS "claimBinding",
	claim_expires_at AS "claimExpiresAt",
	available_at AS "availableAt",
	reason,
	progress,
	created_at AS "createdAt",
	updated_at AS "updatedAt"
`;

const QUALIFIED_JOB_COLUMNS = `
	jobs.id,
	jobs.channel_id AS "channelId",
	jobs.type,
	jobs.version,
	jobs.origin,
	jobs.target_key AS "targetKey",
	jobs.target_generation AS "targetGeneration",
	jobs.idempotency_key AS "idempotencyKey",
	jobs.fingerprint,
	jobs.input,
	jobs.state,
	jobs.revision,
	jobs.attempts,
	jobs.failures,
	jobs.claim_generation AS "claimGeneration",
	jobs.claim_owner AS "claimOwner",
	jobs.claim_binding AS "claimBinding",
	jobs.claim_expires_at AS "claimExpiresAt",
	jobs.available_at AS "availableAt",
	jobs.reason,
	jobs.progress,
	jobs.created_at AS "createdAt",
	jobs.updated_at AS "updatedAt"
`;

const ARTIFACT_COLUMNS = `
	job_id AS "jobId",
	revision,
	value,
	created_at AS "createdAt"
`;

const TARGET_COLUMNS = `
	channel_id AS "channelId",
	target_key AS "targetKey",
	generation
`;

const STATES = new Set<BackgroundJobState>([
	"pending",
	"paused",
	"running",
	"completed",
	"failed",
	"cancelled",
	"superseded",
]);

const ORIGINS = new Set<BackgroundJobOrigin>(["scheduler", "planner", "user"]);

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

function job(row: JobRow): BackgroundJob {
	if (!STATES.has(row.state as BackgroundJobState)) {
		throw corrupt(`background job ${row.id} has an invalid state`);
	}
	if (!ORIGINS.has(row.origin as BackgroundJobOrigin)) {
		throw corrupt(`background job ${row.id} has an invalid origin`);
	}
	let version = integer(row.version, "background job version");
	let targetGeneration = integer(row.targetGeneration, "background job target generation");
	let revision = integer(row.revision, "background job revision");
	if (version < 1 || targetGeneration < 1 || revision < 1) {
		throw corrupt(`background job ${row.id} has an invalid positive counter`);
	}
	let state = row.state as BackgroundJobState;
	let claimOwner = row.claimOwner ?? undefined;
	let claimExpiresAt = row.claimExpiresAt
		? date(row.claimExpiresAt, "background job claim expiry")
		: undefined;
	if (state === "running" ? !claimOwner || !claimExpiresAt : !!claimOwner || !!claimExpiresAt) {
		throw corrupt(`background job ${row.id} has inconsistent claim state`);
	}
	return {
		...row,
		version,
		origin: row.origin as BackgroundJobOrigin,
		targetGeneration,
		input: json(row.input, "background job input"),
		state,
		revision,
		attempts: integer(row.attempts, "background job attempts"),
		failures: integer(row.failures, "background job failures"),
		claimGeneration: integer(row.claimGeneration, "background job claim generation"),
		claimOwner,
		claimBinding: row.claimBinding === null
			? undefined
			: json(row.claimBinding, "background job claim binding"),
		claimExpiresAt,
		availableAt: date(row.availableAt, "background job availability"),
		reason: row.reason ?? undefined,
		progress: progress(row.progress, row.id),
		createdAt: date(row.createdAt, "background job creation time"),
		updatedAt: date(row.updatedAt, "background job update time"),
	};
}

function summary(value: BackgroundJob): BackgroundJobSummary {
	let { claimBinding: _, fingerprint: _fingerprint, idempotencyKey: _key, input: _input, ...rest } =
		value;
	let field = value.type === "research-evidence"
		? "query"
		: value.type === "research-answer"
		? "question"
		: undefined;
	let subject =
		field && value.input && typeof value.input === "object" && !Array.isArray(value.input)
			&& typeof value.input[field] === "string"
			? [...value.input[field].trim()].slice(0, 200).join("")
			: undefined;
	return { ...rest, ...(subject ? { subject } : {}) };
}

function artifact(row: ArtifactRow): BackgroundJobArtifact {
	let revision = integer(row.revision, "background job artifact revision");
	if (revision < 1) throw corrupt(`background job ${row.jobId} has an invalid artifact revision`);
	return {
		jobId: row.jobId,
		revision,
		value: json(row.value, "background job artifact"),
		createdAt: date(row.createdAt, "background job artifact creation time"),
	};
}

function target(row: TargetRow): BackgroundJobTarget {
	let generation = integer(row.generation, "background job target generation");
	if (generation < 1) throw corrupt("background job target has an invalid generation");
	return { ...row, generation };
}

/** PostgreSQL queue and immutable artifact persistence. */
export class PostgresBackgroundJobStore implements BackgroundJobStore {
	#sql: SQL;
	#run: Run;
	#fence: Fence;

	constructor(sql: SQL, run: Run, fence: Fence) {
		this.#sql = sql;
		this.#run = run;
		this.#fence = fence;
	}

	readonly enqueue = (input: EnqueueBackgroundJob) =>
		this.#run("enqueue background job", () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				await this.#lockChannel(transaction, input.channelId);
				let [existing] = await transaction<JobRow[]>`
					SELECT ${transaction.unsafe(JOB_COLUMNS)}
					FROM background_jobs
					WHERE channel_id = ${input.channelId} AND idempotency_key = ${input.idempotencyKey}
					FOR UPDATE
				`;
				if (existing) {
					let repeated = job(existing);
					if (repeated.fingerprint !== input.fingerprint) {
						throw conflict(`background job idempotency key ${input.idempotencyKey} was reused`);
					}
					return { job: repeated, repeated: true };
				}
				if (
					!input.id || !input.type || !input.targetKey || !input.idempotencyKey
					|| !input.fingerprint
				) {
					throw conflict("background job durable identifiers must not be empty");
				}
				if (!Number.isSafeInteger(input.version) || input.version < 1) {
					throw conflict("background job version must be a positive integer");
				}
				let revision = await this.#bump(transaction, input.channelId);
				let [savedTarget] = await transaction<TargetRow[]>`
					INSERT INTO background_job_targets (channel_id, target_key, generation)
					VALUES (${input.channelId}, ${input.targetKey}, 1)
					ON CONFLICT (channel_id, target_key) DO UPDATE SET
						generation = background_job_targets.generation + 1
					RETURNING ${transaction.unsafe(TARGET_COLUMNS)}
				`;
				if (!savedTarget) throw corrupt("enqueuing a background job returned no target");
				let generation = target(savedTarget).generation;
				await transaction`
					UPDATE background_jobs SET
						state = 'superseded',
						revision = ${revision},
						claim_owner = NULL,
						claim_binding = NULL,
						claim_expires_at = NULL,
						reason = NULL,
						updated_at = ${input.now}
					WHERE channel_id = ${input.channelId}
						AND target_key = ${input.targetKey}
						AND target_generation < ${generation}
						AND state IN ('pending', 'paused', 'running')
				`;
				let [saved] = await transaction<JobRow[]>`
					INSERT INTO background_jobs (
						id, channel_id, type, version, origin, target_key, target_generation,
						idempotency_key, fingerprint, input, state, revision, attempts,
						claim_generation, available_at, created_at, updated_at
					) VALUES (
						${input.id}, ${input.channelId}, ${input.type}, ${input.version}, ${input.origin},
						${input.targetKey}, ${generation}, ${input.idempotencyKey}, ${input.fingerprint},
						${JSON.stringify(input.input)}::jsonb, 'pending', ${revision}, 0, 0,
						${input.availableAt}, ${input.now}, ${input.now}
					)
					RETURNING ${transaction.unsafe(JOB_COLUMNS)}
				`;
				if (!saved) throw corrupt("enqueuing a background job returned no record");
				return { job: job(saved), repeated: false };
			}));

	readonly claim = (input: ClaimBackgroundJobs): Promise<BackgroundJob[]> =>
		this.#run("claim background jobs", () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				if (input.channelId !== undefined && !input.channelId) {
					throw conflict("background job claim channel must not be empty");
				}
				if (!input.claimOwner) throw conflict("background job claim owner must not be empty");
				if (!Number.isSafeInteger(input.count) || input.count < 1) {
					throw conflict("background job claim count must be a positive integer");
				}
				if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) {
					throw conflict("background job claim ttl must be a positive integer");
				}
				let count = Math.min(100, input.count);
				let rows = await transaction<JobRow[]>`
					SELECT ${transaction.unsafe(QUALIFIED_JOB_COLUMNS)}
					FROM background_jobs AS jobs
					JOIN background_job_targets AS targets
						ON targets.channel_id = jobs.channel_id
						AND targets.target_key = jobs.target_key
					WHERE targets.generation = jobs.target_generation
						AND (${input.channelId ?? null}::text IS NULL OR jobs.channel_id = ${
					input.channelId ?? null
				})
						AND (
							(jobs.state = 'pending' AND jobs.available_at <= ${input.now})
							OR
							(jobs.state = 'running' AND jobs.claim_expires_at <= ${input.now})
						)
					ORDER BY
						CASE WHEN jobs.state = 'pending' THEN jobs.available_at ELSE jobs.claim_expires_at END,
						jobs.created_at,
						jobs.id
					LIMIT ${count}
					FOR UPDATE OF jobs SKIP LOCKED
				`;
				let revisions = new Map<string, number>();
				let claimed: BackgroundJob[] = [];
				for (let row of rows) {
					let found = job(row);
					let revision = revisions.get(found.channelId);
					if (revision === undefined) {
						revision = await this.#bump(transaction, found.channelId);
						revisions.set(found.channelId, revision);
					}
					let expiresAt = new Date(input.now.getTime() + input.ttlMs);
					let [saved] = await transaction<JobRow[]>`
						UPDATE background_jobs SET
							state = 'running',
							revision = ${revision},
							attempts = attempts + 1,
							claim_generation = claim_generation + 1,
							claim_owner = ${input.claimOwner},
							claim_binding = NULL,
							claim_expires_at = ${expiresAt},
							reason = NULL,
							updated_at = ${input.now}
						WHERE id = ${found.id}
						RETURNING ${transaction.unsafe(JOB_COLUMNS)}
					`;
					if (!saved) throw corrupt(`claiming background job ${found.id} returned no record`);
					claimed.push(job(saved));
				}
				return claimed;
			}));

	readonly renew = (input: RenewBackgroundJob): Promise<BackgroundJob> =>
		this.#run("renew background job", () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1) {
					throw conflict("background job claim ttl must be a positive integer");
				}
				let found = await this.#lockClaim(transaction, input);
				let expiresAt = new Date(input.now.getTime() + input.ttlMs);
				if (
					found.revision !== input.expectedRevision
					|| input.now < found.updatedAt
					|| expiresAt <= found.claimExpiresAt!
				) throw conflict(`background job ${found.id} changed before its claim renewal`);
				let revision = await this.#bump(transaction, found.channelId);
				let binding = input.claimBinding === undefined
					? null
					: JSON.stringify(input.claimBinding);
				let [saved] = await transaction<JobRow[]>`
					UPDATE background_jobs SET
						revision = ${revision},
						claim_binding = ${binding}::jsonb,
						claim_expires_at = ${expiresAt},
						updated_at = ${input.now}
					WHERE id = ${found.id}
					RETURNING ${transaction.unsafe(JOB_COLUMNS)}
				`;
				if (!saved) throw corrupt(`renewing background job ${found.id} returned no record`);
				return job(saved);
			}));

	readonly requeue = (input: RequeueBackgroundJob): Promise<BackgroundJob> =>
		this.#claimedTransition(
			"requeue background job",
			input,
			"pending",
			input.reason,
			input.availableAt,
			input.countFailure,
		);

	readonly appendProgress = (input: AppendBackgroundJobProgress): Promise<BackgroundJob> =>
		this.#run("append background job progress", () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				let found = await this.#lockClaim(transaction, input);
				if (input.now < found.updatedAt) {
					throw conflict(`background job ${found.id} changed before its progress update`);
				}
				let revision = await this.#bump(transaction, found.channelId);
				let next = appendProgress(found.progress, input, revision, found.attempts);
				let [saved] = await transaction<JobRow[]>`
					UPDATE background_jobs SET
						revision = ${revision},
						progress = ${JSON.stringify(next)}::text::jsonb,
						updated_at = ${input.now}
					WHERE id = ${found.id}
					RETURNING ${transaction.unsafe(JOB_COLUMNS)}
				`;
				if (!saved) {
					throw corrupt(`appending background job progress for ${found.id} returned no record`);
				}
				return job(saved);
			}));

	readonly settle = (input: SettleBackgroundJob): Promise<BackgroundJobDetail> =>
		this.#run("settle background job", () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				let found = await this.#lockClaim(transaction, input);
				let revision = await this.#bump(transaction, found.channelId);
				let [saved] = await transaction<JobRow[]>`
					UPDATE background_jobs SET
						state = 'completed',
						revision = ${revision},
						claim_owner = NULL,
						claim_binding = NULL,
						claim_expires_at = NULL,
						reason = NULL,
						updated_at = ${input.now}
					WHERE id = ${found.id}
					RETURNING ${transaction.unsafe(JOB_COLUMNS)}
				`;
				if (!saved) throw corrupt(`settling background job ${found.id} returned no record`);
				let [savedArtifact] = await transaction<ArtifactRow[]>`
					INSERT INTO background_job_artifacts (job_id, revision, value, created_at)
					VALUES (${found.id}, ${revision}, ${JSON.stringify(input.artifact)}::jsonb, ${input.now})
					RETURNING ${transaction.unsafe(ARTIFACT_COLUMNS)}
				`;
				if (!savedArtifact) {
					throw corrupt(`settling background job ${found.id} returned no artifact`);
				}
				let savedTarget = await this.#readTarget(transaction, found.channelId, found.targetKey);
				return {
					revision,
					target: savedTarget,
					job: job(saved),
					artifact: artifact(savedArtifact),
				};
			}));

	readonly pause = (input: PauseBackgroundJob): Promise<BackgroundJob> =>
		this.#controlTransition(
			"pause background job",
			input,
			["pending", "running"],
			"paused",
			input.reason,
		);

	readonly resume = (input: ResumeBackgroundJob): Promise<BackgroundJob> =>
		this.#controlTransition(
			"resume background job",
			input,
			["paused"],
			"pending",
			undefined,
			input.availableAt,
		);

	readonly fail = (input: FailBackgroundJob): Promise<BackgroundJob> =>
		this.#claimedTransition("fail background job", input, "failed", input.reason, undefined, true);

	readonly cancel = (input: CancelBackgroundJob): Promise<BackgroundJob> =>
		this.#controlTransition(
			"cancel background job",
			input,
			["pending", "paused", "running"],
			"cancelled",
		);

	readonly supersede = (input: SupersedeBackgroundJob): Promise<BackgroundJob> =>
		this.#controlTransition(
			"supersede background job",
			input,
			["pending", "paused", "running"],
			"superseded",
			input.reason,
		);

	readonly list = (
		channelId: string,
		limit: number,
		after?: BackgroundJobCursor,
	): Promise<BackgroundJobPage | undefined> =>
		this.#run(
			"list background jobs",
			() =>
				this.#sql.begin("isolation level repeatable read read only", async transaction => {
					let revision = await this.#readRevision(transaction, channelId);
					if (revision === undefined) return undefined;
					let count = Math.min(100, Math.max(1, limit));
					let rows = after
						? await transaction<JobRow[]>`
						SELECT ${transaction.unsafe(JOB_COLUMNS)}
						FROM background_jobs
						WHERE channel_id = ${channelId}
							AND (
								created_at < ${after.createdAt}
								OR (created_at = ${after.createdAt} AND id > ${after.id})
							)
						ORDER BY created_at DESC, id ASC
						LIMIT ${count + 1}
					`
						: await transaction<JobRow[]>`
						SELECT ${transaction.unsafe(JOB_COLUMNS)}
						FROM background_jobs
						WHERE channel_id = ${channelId}
						ORDER BY created_at DESC, id ASC
						LIMIT ${count + 1}
					`;
					let values = rows.map(job);
					let page = values.slice(0, count);
					let last = page.at(-1);
					return {
						revision,
						jobs: page.map(summary),
						next: values.length > page.length && last
							? { createdAt: new Date(last.createdAt), id: last.id }
							: undefined,
					};
				}),
		);

	readonly get = (channelId: string, jobId: string): Promise<BackgroundJobDetail | undefined> =>
		this.#run(
			"read background job",
			() =>
				this.#sql.begin("isolation level repeatable read read only", async transaction => {
					let revision = await this.#readRevision(transaction, channelId);
					if (revision === undefined) return undefined;
					let [found] = await transaction<JobRow[]>`
					SELECT ${transaction.unsafe(JOB_COLUMNS)}
					FROM background_jobs
					WHERE channel_id = ${channelId} AND id = ${jobId}
				`;
					if (!found) return undefined;
					let saved = job(found);
					let savedTarget = await this.#readTarget(
						transaction,
						saved.channelId,
						saved.targetKey,
					);
					let [foundArtifact] = await transaction<ArtifactRow[]>`
					SELECT ${transaction.unsafe(ARTIFACT_COLUMNS)}
					FROM background_job_artifacts WHERE job_id = ${saved.id}
				`;
					return {
						revision,
						target: savedTarget,
						job: saved,
						artifact: foundArtifact ? artifact(foundArtifact) : undefined,
					};
				}),
		);

	#claimedTransition(
		action: string,
		input: RequeueBackgroundJob | FailBackgroundJob,
		state: BackgroundJobState,
		reason?: string,
		availableAt?: Date,
		countFailure = false,
	): Promise<BackgroundJob> {
		return this.#run(action, () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				let found = await this.#lockClaim(transaction, input);
				let revision = await this.#bump(transaction, found.channelId);
				let [saved] = await transaction<JobRow[]>`
					UPDATE background_jobs SET
						state = ${state},
						revision = ${revision},
						failures = failures + ${countFailure ? 1 : 0},
						claim_owner = NULL,
						claim_binding = NULL,
						claim_expires_at = NULL,
						available_at = ${availableAt ?? found.availableAt},
						reason = ${reason ?? null},
						updated_at = ${input.now}
					WHERE id = ${found.id}
					RETURNING ${transaction.unsafe(JOB_COLUMNS)}
				`;
				if (!saved) throw corrupt(`${action} returned no record`);
				return job(saved);
			}));
	}

	#controlTransition(
		action: string,
		input: CancelBackgroundJob | ControlBackgroundJob,
		allowed: BackgroundJobState[],
		state: BackgroundJobState,
		reason?: string,
		availableAt?: Date,
	): Promise<BackgroundJob> {
		return this.#run(action, () =>
			this.#sql.begin(async transaction => {
				await this.#fence(transaction, input.lease);
				let found = await this.#lockControl(transaction, input, allowed);
				let revision = await this.#bump(transaction, found.channelId);
				let [saved] = await transaction<JobRow[]>`
					UPDATE background_jobs SET
						state = ${state},
						revision = ${revision},
						claim_owner = NULL,
						claim_binding = NULL,
						claim_expires_at = NULL,
						available_at = ${availableAt ?? found.availableAt},
						reason = ${reason ?? null},
						updated_at = ${input.now}
					WHERE id = ${found.id}
					RETURNING ${transaction.unsafe(JOB_COLUMNS)}
				`;
				if (!saved) throw corrupt(`${action} returned no record`);
				return job(saved);
			}));
	}

	async #lockClaim(
		transaction: TransactionSQL,
		input: ClaimedBackgroundJob,
	): Promise<BackgroundJob> {
		let [row] = await transaction<JobRow[]>`
			SELECT ${transaction.unsafe(JOB_COLUMNS)}
			FROM background_jobs
			WHERE channel_id = ${input.channelId} AND id = ${input.jobId}
			FOR UPDATE
		`;
		if (!row) throw missing(`background job ${input.jobId} does not exist`);
		let found = job(row);
		let current = await this.#readTarget(transaction, found.channelId, found.targetKey);
		if (
			found.state !== "running"
			|| found.claimOwner !== input.claimOwner
			|| found.claimGeneration !== input.claimGeneration
			|| !found.claimExpiresAt
			|| found.claimExpiresAt <= input.now
			|| current.generation !== found.targetGeneration
		) throw conflict(`background job ${found.id} claim is no longer active`);
		return found;
	}

	async #lockControl(
		transaction: TransactionSQL,
		input: CancelBackgroundJob | ControlBackgroundJob,
		allowed: BackgroundJobState[],
	): Promise<BackgroundJob> {
		let [row] = await transaction<JobRow[]>`
			SELECT ${transaction.unsafe(JOB_COLUMNS)}
			FROM background_jobs
			WHERE channel_id = ${input.channelId} AND id = ${input.jobId}
			FOR UPDATE
		`;
		if (!row) throw missing(`background job ${input.jobId} does not exist`);
		let found = job(row);
		let current = await this.#readTarget(transaction, found.channelId, found.targetKey);
		if (
			"expectedRevision" in input && found.revision !== input.expectedRevision
			|| !allowed.includes(found.state)
			|| current.generation !== found.targetGeneration
		) throw conflict(`background job ${found.id} changed`);
		return found;
	}

	async #bump(transaction: TransactionSQL, channelId: string): Promise<number> {
		let [row] = await transaction<{ revision: Integer }[]>`
			INSERT INTO background_job_channels (channel_id, revision)
			VALUES (${channelId}, 1)
			ON CONFLICT (channel_id) DO UPDATE SET
				revision = background_job_channels.revision + 1
			RETURNING revision
		`;
		if (!row) throw corrupt("advancing the background job revision returned no record");
		return integer(row.revision, "channel background job revision");
	}

	async #lockChannel(transaction: TransactionSQL, channelId: string): Promise<void> {
		let [row] = await transaction<{ id: string }[]>`
			SELECT id FROM channels WHERE id = ${channelId} FOR UPDATE
		`;
		if (!row) throw missing(`channel ${channelId} does not exist`);
	}

	async #readRevision(
		transaction: TransactionSQL,
		channelId: string,
	): Promise<number | undefined> {
		let [row] = await transaction<{ revision: Integer }[]>`
			SELECT COALESCE(background_job_channels.revision, 0) AS revision
			FROM channels
			LEFT JOIN background_job_channels ON background_job_channels.channel_id = channels.id
			WHERE channels.id = ${channelId}
		`;
		return row ? integer(row.revision, "channel background job revision") : undefined;
	}

	async #readTarget(
		transaction: TransactionSQL,
		channelId: string,
		targetKey: string,
	): Promise<BackgroundJobTarget> {
		let [row] = await transaction<TargetRow[]>`
			SELECT ${transaction.unsafe(TARGET_COLUMNS)}
			FROM background_job_targets
			WHERE channel_id = ${channelId} AND target_key = ${targetKey}
		`;
		if (!row) throw corrupt(`background job target ${targetKey} does not exist`);
		return target(row);
	}
}
