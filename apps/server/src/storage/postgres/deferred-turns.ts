import { corrupt } from "../errors";
import {
	DEFERRED_CANCEL_REASONS,
	DEFERRED_TURN_KINDS,
	DEFERRED_TURN_STATES,
	legalDeferredTransition,
} from "../model";

import type { SQL, TransactionSQL } from "bun";
import type {
	DeferredCancelReason,
	DeferredTurn,
	DeferredTurnChange,
	DeferredTurnKind,
	DeferredTurnOutcome,
	DeferredTurnState,
	DeferredTurnTransition,
	JsonValue,
	Lease,
	NewDeferredTurn,
} from "../model";
import type { DeferredTurnStore } from "../port";

type Timestamp = Date | string;

type TurnRow = {
	id: string;
	documentId: string;
	requestId: string;
	kind: string;
	handle: string;
	userId: string;
	text: string;
	references: unknown;
	delivery: unknown;
	focusChannelId: string | null;
	focusTitle: string | null;
	threadId: string | null;
	threadChannelId: string | null;
	planRevision: string | number | null;
	claimantSessionId: string | null;
	ownerSessionIdAtAccept: string | null;
	state: string;
	createdAt: Timestamp;
	fencing: string | number;
	resolvedAt: Timestamp | null;
	cancelReason: string | null;
};

const COLUMNS = `id, document_id AS "documentId", request_id AS "requestId", kind, handle,
	user_id AS "userId", text, references_json AS "references", delivery,
	focus_channel_id AS "focusChannelId", focus_title AS "focusTitle", thread_id AS "threadId",
	thread_channel_id AS "threadChannelId", plan_revision AS "planRevision",
	claimant_session_id AS "claimantSessionId",
	owner_session_id_at_accept AS "ownerSessionIdAtAccept", state, created_at AS "createdAt",
	fencing, resolved_at AS "resolvedAt", cancel_reason AS "cancelReason"`;

function parsed(value: unknown): unknown {
	return typeof value === "string" ? JSON.parse(value) : value;
}

function member<T extends string>(value: string, allowed: readonly T[], field: string): T {
	if (!(allowed as readonly string[]).includes(value)) {
		throw corrupt(`storage returned an invalid deferred turn ${field}`);
	}
	return value as T;
}

function turn(row: TurnRow): DeferredTurn {
	let references = parsed(row.references);
	if (!Array.isArray(references)) {
		throw corrupt("storage returned invalid deferred turn references");
	}
	let delivery = parsed(row.delivery) as JsonValue | null;
	return {
		id: row.id,
		documentId: row.documentId,
		requestId: row.requestId,
		kind: member<DeferredTurnKind>(row.kind, DEFERRED_TURN_KINDS, "kind"),
		handle: row.handle,
		userId: row.userId,
		text: row.text,
		references: references as JsonValue[],
		...(delivery !== null ? { delivery } : {}),
		...(row.focusChannelId !== null ? { focusChannelId: row.focusChannelId } : {}),
		...(row.focusTitle !== null ? { focusTitle: row.focusTitle } : {}),
		...(row.threadId !== null ? { threadId: row.threadId } : {}),
		...(row.threadChannelId !== null ? { threadChannelId: row.threadChannelId } : {}),
		...(row.planRevision !== null ? { planRevision: Number(row.planRevision) } : {}),
		...(row.claimantSessionId !== null ? { claimantSessionId: row.claimantSessionId } : {}),
		...(row.ownerSessionIdAtAccept !== null
			? { ownerSessionIdAtAccept: row.ownerSessionIdAtAccept }
			: {}),
		state: member<DeferredTurnState>(row.state, DEFERRED_TURN_STATES, "state"),
		createdAt: new Date(row.createdAt),
		fencing: Number(row.fencing),
		...(row.resolvedAt !== null ? { resolvedAt: new Date(row.resolvedAt) } : {}),
		...(row.cancelReason !== null
			? {
				cancelReason: member<DeferredCancelReason>(
					row.cancelReason,
					DEFERRED_CANCEL_REASONS,
					"cancel reason",
				),
			}
			: {}),
	};
}

async function find(
	sql: SQL | TransactionSQL,
	documentId: string,
	requestId: string,
): Promise<DeferredTurn | undefined> {
	let [row] = await sql<TurnRow[]>`
		SELECT ${sql.unsafe(COLUMNS)} FROM planner_deferred_turns
		WHERE document_id = ${documentId} AND request_id = ${requestId}
	`;
	return row ? turn(row) : undefined;
}

async function insert(
	sql: TransactionSQL,
	lease: Lease,
	input: NewDeferredTurn,
): Promise<DeferredTurnOutcome> {
	let repeated = await find(sql, input.documentId, input.requestId);
	if (repeated) return { action: "insert", status: "repeated", turn: repeated };
	if (input.kind === "comment" && input.threadId !== undefined) {
		let [waiting] = await sql<TurnRow[]>`
			SELECT ${sql.unsafe(COLUMNS)} FROM planner_deferred_turns
			WHERE document_id = ${input.documentId}
				AND kind = 'comment' AND state = 'waiting'
				AND thread_id = ${input.threadId}
				AND coalesce(thread_channel_id, '') = ${input.threadChannelId ?? ""}
		`;
		if (waiting) return { action: "insert", status: "thread-waiting", turn: turn(waiting) };
	}
	let [saved] = await sql<TurnRow[]>`
		INSERT INTO planner_deferred_turns (
			id, document_id, request_id, kind, handle, user_id, text, references_json, delivery,
			focus_channel_id, focus_title, thread_id, thread_channel_id, plan_revision,
			claimant_session_id, owner_session_id_at_accept, state, created_at, fencing
		) VALUES (
			${input.id}, ${input.documentId}, ${input.requestId}, ${input.kind}, ${input.handle},
			${input.userId}, ${input.text}, ${JSON.stringify(input.references)}::text::jsonb,
			${input.delivery === undefined ? null : JSON.stringify(input.delivery)}::text::jsonb,
			${input.focusChannelId ?? null}, ${input.focusTitle ?? null}, ${input.threadId ?? null},
			${input.threadChannelId ?? null}, ${input.planRevision ?? null},
			${input.claimantSessionId ?? null}, ${input.ownerSessionIdAtAccept ?? null},
			'waiting', ${input.createdAt}, ${lease.fencing}
		)
		RETURNING ${sql.unsafe(COLUMNS)}
	`;
	if (!saved) throw corrupt("saving a deferred turn returned no record");
	return { action: "insert", status: "inserted", turn: turn(saved) };
}

async function transition(
	sql: TransactionSQL,
	lease: Lease,
	change: DeferredTurnTransition,
): Promise<DeferredTurnOutcome> {
	let [current] = await sql<TurnRow[]>`
		SELECT ${sql.unsafe(COLUMNS)} FROM planner_deferred_turns
		WHERE id = ${change.id}
		FOR UPDATE
	`;
	if (!current) return { action: "transition", changed: false, reason: "missing" };
	let existing = turn(current);
	if (!legalDeferredTransition(change.from, change.to)) {
		return { action: "transition", changed: false, reason: "illegal", turn: existing };
	}
	if (
		existing.state !== change.from
		|| (change.to === "ended" && existing.fencing !== lease.fencing)
	) return { action: "transition", changed: false, reason: "state", turn: existing };
	let final = change.to !== "started";
	let [saved] = await sql<TurnRow[]>`
		UPDATE planner_deferred_turns
		SET state = ${change.to}, fencing = ${lease.fencing},
			resolved_at = ${final ? change.at : null},
			cancel_reason = ${change.to === "cancelled" ? change.reason ?? null : null}
		WHERE id = ${change.id}
		RETURNING ${sql.unsafe(COLUMNS)}
	`;
	if (!saved) throw corrupt("moving a deferred turn returned no record");
	return { action: "transition", changed: true, turn: turn(saved) };
}

/** Applies a commit's deferred-turn changes in its transaction, which has already been fenced. */
export async function applyDeferredTurnChanges(
	sql: TransactionSQL,
	lease: Lease,
	changes: DeferredTurnChange[],
): Promise<DeferredTurnOutcome[]> {
	let outcomes: DeferredTurnOutcome[] = [];
	for (let change of changes) {
		outcomes.push(
			change.action === "insert"
				? await insert(sql, lease, change.turn)
				: await transition(sql, lease, change),
		);
	}
	return outcomes;
}

export class PostgresDeferredTurnStore implements DeferredTurnStore {
	constructor(
		private sql: SQL,
		private run: <T>(action: string, execute: () => Promise<T>) => Promise<T>,
		private fence: (sql: TransactionSQL, lease: Lease) => Promise<void>,
	) {}
	insert(lease: Lease, input: NewDeferredTurn) {
		return this.run("save a deferred Planner turn", () =>
			this.sql.begin(async sql => {
				await this.fence(sql, lease);
				return insert(sql, lease, input);
			}));
	}
	transition(lease: Lease, change: DeferredTurnTransition) {
		return this.run("move a deferred Planner turn", () =>
			this.sql.begin(async sql => {
				await this.fence(sql, lease);
				return transition(sql, lease, change);
			}));
	}
	interruptStale(lease: Lease, at: Date, documentId?: string) {
		return this.run("interrupt stale deferred Planner turns", () =>
			this.sql.begin(async sql => {
				await this.fence(sql, lease);
				let rows = await sql<Array<TurnRow & { seq: string | number }>>`
					UPDATE planner_deferred_turns
					SET state = 'interrupted', fencing = ${lease.fencing}, resolved_at = ${at}
					WHERE state = 'started' AND fencing < ${lease.fencing}
						${documentId === undefined ? sql`` : sql`AND document_id = ${documentId}`}
					RETURNING ${sql.unsafe(COLUMNS)}, seq
				`;
				return rows
					.sort((a, b) =>
						new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
						|| Number(a.seq) - Number(b.seq)
					)
					.map(turn);
			}));
	}
	get(documentId: string, requestId: string) {
		return this.run("read a deferred Planner turn", () => find(this.sql, documentId, requestId));
	}
	list(documentId: string, states?: DeferredTurnState[]) {
		return this.run("list deferred Planner turns", async () => {
			if (states?.length === 0) return [];
			let rows = await this.sql<TurnRow[]>`
				SELECT ${this.sql.unsafe(COLUMNS)} FROM planner_deferred_turns
				WHERE document_id = ${documentId}
					${states === undefined ? this.sql`` : this.sql`AND state IN ${this.sql(states)}`}
				ORDER BY created_at, seq
			`;
			return rows.map(turn);
		});
	}
	documents(states: DeferredTurnState[]) {
		return this.run("list documents with deferred Planner turns", async () => {
			if (states.length === 0) return [];
			let rows = await this.sql<{ documentId: string }[]>`
				SELECT DISTINCT document_id AS "documentId" FROM planner_deferred_turns
				WHERE state IN ${this.sql(states)}
				ORDER BY document_id
			`;
			return rows.map(row => row.documentId);
		});
	}
}
