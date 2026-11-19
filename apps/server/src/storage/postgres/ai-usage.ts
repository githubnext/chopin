import type { SQL, TransactionSQL } from "bun";
import type {
	AiAttempt,
	AiAttemptOutcome,
	AiAttemptResult,
	AiAttemptStart,
	AiModelTotals,
	Lease,
} from "../model";
import type { AiUsageStore } from "../port";

type Run = <T>(action: string, execute: () => Promise<T>) => Promise<T>;
type Fence = (transaction: TransactionSQL, lease: Lease) => Promise<void>;

type AttemptRow = {
	id: string;
	launchId: string;
	userId: string;
	provider: AiAttempt["provider"];
	model: string | null;
	outcome: AiAttemptOutcome;
	status: number | null;
	error: string | null;
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	startedAt: Date | string;
	completedAt: Date | string | null;
};

type TotalsRow = {
	provider: AiModelTotals["provider"];
	model: string | null;
	requests: number;
	errors: number;
	pending: number;
	unknown: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

const ATTEMPT_COLUMNS = `id, launch_id AS "launchId", user_id AS "userId", provider, model, outcome,
	status, error, input_tokens::float8 AS input, output_tokens::float8 AS output,
	cache_read_tokens::float8 AS "cacheRead", cache_write_tokens::float8 AS "cacheWrite",
	started_at AS "startedAt", completed_at AS "completedAt"`;

function defined<T>(value: T | null): T | undefined {
	return value === null ? undefined : value;
}

function attempt(row: AttemptRow): AiAttempt {
	let tokens = {
		input: defined(row.input),
		output: defined(row.output),
		cacheRead: defined(row.cacheRead),
		cacheWrite: defined(row.cacheWrite),
	};
	return {
		id: row.id,
		launchId: row.launchId,
		userId: row.userId,
		provider: row.provider,
		...(row.model ? { model: row.model } : {}),
		startedAt: new Date(row.startedAt),
		outcome: row.outcome,
		...(row.status !== null ? { status: row.status } : {}),
		...(row.error ? { error: row.error } : {}),
		tokens: Object.fromEntries(Object.entries(tokens).filter(([, value]) => value !== undefined)),
		...(row.completedAt ? { completedAt: new Date(row.completedAt) } : {}),
	};
}

export class PostgresAiUsageStore implements AiUsageStore {
	constructor(private sql: SQL, private run: Run, private fence: Fence) {}
	begin(lease: Lease, value: AiAttemptStart) {
		return this.run("record an AI request", () =>
			this.sql.begin(async transaction => {
				await this.fence(transaction, lease);
				await transaction`
					INSERT INTO ai_usage (
						id, launch_id, user_id, provider, model, outcome, started_at, lease_name, fencing
					)
					VALUES (
						${value.id}, ${value.launchId}, ${value.userId}, ${value.provider},
						${value.model ?? null}, 'pending', ${value.startedAt}, ${lease.name}, ${lease.fencing}
					)
					ON CONFLICT (id) DO NOTHING
				`;
			}));
	}
	complete(lease: Lease, id: string, result: AiAttemptResult) {
		return this.run("complete an AI request", () =>
			this.sql.begin(async transaction => {
				await this.fence(transaction, lease);
				let completed = await transaction<{ id: string }[]>`
					UPDATE ai_usage SET
						outcome = ${result.outcome},
						status = ${result.status ?? null},
						error = ${result.error ?? null},
						input_tokens = ${result.tokens.input ?? null},
						output_tokens = ${result.tokens.output ?? null},
						cache_read_tokens = ${result.tokens.cacheRead ?? null},
						cache_write_tokens = ${result.tokens.cacheWrite ?? null},
						completed_at = ${result.completedAt}
					WHERE id = ${id} AND outcome = 'pending'
					RETURNING id
				`;
				return completed.length > 0;
			}));
	}
	retire(lease: Lease, at: Date) {
		return this.run(
			"mark unfinished AI requests unknown",
			() =>
				this.sql.begin(async transaction => {
					await this.fence(transaction, lease);
					let retired = await transaction<{ id: string }[]>`
					UPDATE ai_usage SET outcome = 'unknown', completed_at = ${at}
					WHERE outcome = 'pending' AND lease_name = ${lease.name} AND fencing < ${lease.fencing}
					RETURNING id
				`;
					return retired.length;
				}),
		);
	}
	get(id: string) {
		return this.run("read an AI request", async () => {
			let [row] = await this.sql<AttemptRow[]>`
				SELECT ${this.sql.unsafe(ATTEMPT_COLUMNS)} FROM ai_usage WHERE id = ${id}
			`;
			return row && attempt(row);
		});
	}
	summary(userId: string, since: Date) {
		return this.run("sum a person's AI requests", async () => {
			let rows = await this.sql<TotalsRow[]>`
				SELECT provider, model,
					count(*) FILTER (WHERE outcome IN ('ok', 'error'))::int AS requests,
					count(*) FILTER (WHERE outcome = 'error')::int AS errors,
					count(*) FILTER (WHERE outcome = 'pending')::int AS pending,
					count(*) FILTER (WHERE outcome = 'unknown')::int AS unknown,
					coalesce(sum(input_tokens), 0)::float8 AS input,
					coalesce(sum(output_tokens), 0)::float8 AS output,
					coalesce(sum(cache_read_tokens), 0)::float8 AS "cacheRead",
					coalesce(sum(cache_write_tokens), 0)::float8 AS "cacheWrite"
				FROM ai_usage
				WHERE user_id = ${userId} AND started_at >= ${since} AND outcome <> 'unsent'
				GROUP BY provider, model
				ORDER BY requests DESC, provider, model NULLS LAST
			`;
			return rows.map((row): AiModelTotals => ({
				provider: row.provider,
				...(row.model ? { model: row.model } : {}),
				requests: row.requests,
				errors: row.errors,
				pending: row.pending,
				unknown: row.unknown,
				tokens: {
					input: row.input,
					output: row.output,
					cacheRead: row.cacheRead,
					cacheWrite: row.cacheWrite,
				},
			}));
		});
	}
	deleteBefore(lease: Lease, before: Date) {
		return this.run("remove old AI requests", () =>
			this.sql.begin(async transaction => {
				await this.fence(transaction, lease);
				let removed = await transaction<{ id: string }[]>`
					DELETE FROM ai_usage WHERE started_at < ${before} AND outcome <> 'pending'
					RETURNING id
				`;
				return removed.length;
			}));
	}
}
