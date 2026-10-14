import type { SQL, TransactionSQL } from "bun";
import { corrupt } from "../errors";
import {
	changeFollowthrough,
	followthroughLimit,
	followthroughPublication,
} from "../followthrough";
import type {
	Followthrough,
	FollowthroughChange,
	FollowthroughContext,
	FollowthroughKind,
	FollowthroughPublication,
	FollowthroughStore,
} from "../followthrough";
import type { Lease } from "../model";

type Row = {
	id: string;
	channel_id: string;
	child_id: string;
	kind: FollowthroughKind;
	source_id: string;
	result_key: string;
	status: Followthrough["status"];
	revision: number | string;
	attempts: number | string;
	created_at: Date;
	updated_at: Date;
	reason: string | null;
	context: unknown;
	attempt_token: string | null;
};

function claimContext(value: unknown): FollowthroughContext | undefined {
	if (value === null) return;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			throw corrupt("storage returned invalid follow-through context");
		}
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw corrupt("storage returned invalid follow-through context");
	}
	let context = value as Record<string, unknown>;
	if (
		typeof context.planRevision !== "number" || !Number.isSafeInteger(context.planRevision)
		|| context.planRevision < 0 || typeof context.sourceHash !== "string"
		|| !context.sourceHash.trim() || context.sourceHash.length > 128
		|| [...context.sourceHash].some(character => character.charCodeAt(0) < 32)
	) throw corrupt("storage returned invalid follow-through context");
	return { planRevision: context.planRevision, sourceHash: context.sourceHash };
}

function decode(row: Row): Followthrough {
	let context = claimContext(row.context);
	return {
		id: row.id,
		channelId: row.channel_id,
		childId: row.child_id,
		kind: row.kind,
		sourceId: row.source_id,
		resultKey: row.result_key,
		status: row.status,
		revision: Number(row.revision),
		attempts: Number(row.attempts),
		createdAt: new Date(row.created_at),
		updatedAt: new Date(row.updated_at),
		...(row.reason === null ? {} : { reason: row.reason }),
		...(context ? { context } : {}),
		...(row.attempt_token === null ? {} : { attemptToken: row.attempt_token }),
	};
}

/** Only publication calls this, inside the same transaction as the initialized child and source link. */
export async function enqueueFollowthrough(
	sql: TransactionSQL,
	input: FollowthroughPublication,
): Promise<void> {
	let value = followthroughPublication(input);
	await sql`INSERT INTO result_followthrough
		(id, channel_id, child_id, kind, source_id, result_key, status, revision, attempts, created_at, updated_at)
		VALUES (${value.id}, ${value.channelId}, ${value.childId}, ${value.kind}, ${value.sourceId},
			${value.resultKey}, 'pending', 0, 0, ${value.createdAt}, ${value.updatedAt})
		ON CONFLICT (channel_id, kind, source_id, result_key) DO NOTHING`;
}

export class PostgresFollowthroughStore implements FollowthroughStore {
	constructor(
		private sql: SQL,
		private fence: (sql: TransactionSQL, lease: Lease) => Promise<void>,
	) {}
	async get(channelId: string, id: string) {
		let [row] = await this.sql<
			Row[]
		>`SELECT * FROM result_followthrough WHERE channel_id = ${channelId} AND id = ${id}`;
		return row ? decode(row) : undefined;
	}
	async forSource(channelId: string, kind: FollowthroughKind, sourceId: string) {
		let rows = await this.sql<Row[]>`SELECT * FROM result_followthrough
			WHERE channel_id = ${channelId} AND kind = ${kind} AND source_id = ${sourceId}
			ORDER BY created_at DESC, id DESC LIMIT 100`;
		return rows.map(decode);
	}
	async pending(channelId: string | undefined, limit: number) {
		let count = followthroughLimit(limit);
		let rows = channelId === undefined
			? await this.sql<Row[]>`SELECT * FROM result_followthrough WHERE status = 'pending'
				ORDER BY updated_at, id LIMIT ${count}`
			: await this.sql<
				Row[]
			>`SELECT * FROM result_followthrough WHERE status = 'pending' AND channel_id = ${channelId}
				ORDER BY updated_at, id LIMIT ${count}`;
		return rows.map(decode);
	}
	claim(
		channelId: string,
		id: string,
		revision: number,
		context: FollowthroughContext,
		lease: Lease,
	) {
		return this.#change(channelId, id, revision, { action: "claim", context }, lease);
	}
	defer(channelId: string, id: string, revision: number, reason: string, lease: Lease) {
		return this.#change(channelId, id, revision, { action: "defer", reason }, lease);
	}
	finish(
		channelId: string,
		id: string,
		revision: number,
		outcome: "done" | "failed" | "skipped",
		reason: string | undefined,
		lease: Lease,
	) {
		return this.#change(channelId, id, revision, { action: "finish", outcome, reason }, lease);
	}
	retry(channelId: string, id: string, revision: number, lease: Lease) {
		return this.#change(channelId, id, revision, { action: "retry" }, lease);
	}
	dismiss(channelId: string, id: string, revision: number, lease: Lease) {
		return this.#change(channelId, id, revision, { action: "dismiss" }, lease);
	}
	skip(channelId: string, id: string, revision: number, reason: string, lease: Lease) {
		return this.#change(channelId, id, revision, { action: "skip", reason }, lease);
	}
	releaseUnstarted(
		channelId: string,
		id: string,
		revision: number,
		attemptToken: string,
		reason: string,
		lease: Lease,
	) {
		return this.#change(channelId, id, revision, {
			action: "release-unstarted",
			attemptToken,
			reason,
		}, lease);
	}
	async recoverInterrupted(lease: Lease): Promise<number> {
		return await this.sql.begin(async sql => {
			await this.fence(sql, lease);
			let rows =
				await sql`UPDATE result_followthrough SET status = 'failed', reason = 'interrupted',
				revision = revision + 1, updated_at = GREATEST(updated_at, now()) WHERE status = 'running' RETURNING id`;
			return rows.length;
		}) as number;
	}
	async #change(
		channelId: string,
		id: string,
		revision: number,
		change: FollowthroughChange,
		lease: Lease,
	): Promise<Followthrough | undefined> {
		return await this.sql.begin(async sql => {
			await this.fence(sql, lease);
			let [row] = await sql<Row[]>`SELECT * FROM result_followthrough
				WHERE channel_id = ${channelId} AND id = ${id} AND revision = ${revision} FOR UPDATE`;
			if (!row) return;
			if (change.action === "claim") {
				let [eligible] = await sql`SELECT parent.id FROM channels AS parent
					JOIN channels AS child ON child.parent_channel_id = parent.id
					WHERE parent.id = ${channelId} AND child.id = ${row.child_id}
						AND parent.parent_channel_id IS NULL AND parent.archived_at IS NULL
						AND child.archived_at IS NULL AND child.repository_id = parent.repository_id
					FOR SHARE OF parent, child`;
				if (!eligible) return;
			}
			let value = decode(row);
			let next = changeFollowthrough(value, change);
			if (!next || next === value) return next;
			let [saved] = await sql<Row[]>`UPDATE result_followthrough SET
				status = ${next.status}, revision = ${next.revision}, attempts = ${next.attempts},
				updated_at = GREATEST(updated_at, ${next.updatedAt}), reason = ${next.reason ?? null},
				context = ${next.context ? JSON.stringify(next.context) : null}::jsonb,
				attempt_token = ${next.attemptToken ?? null}
				WHERE id = ${id} AND revision = ${revision} RETURNING *`;
			return saved ? decode(saved) : undefined;
		}) as Followthrough | undefined;
	}
}
