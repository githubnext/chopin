import { missing } from "../errors";
import { legalDeferredTransition } from "../model";

import type {
	DeferredTurn,
	DeferredTurnChange,
	DeferredTurnOutcome,
	DeferredTurnState,
	DeferredTurnTransition,
	Lease,
	NewDeferredTurn,
} from "../model";
import type { DeferredTurnStore } from "../port";

type Row = DeferredTurn & { seq: number };

function copy({ seq: _seq, ...value }: Row): DeferredTurn {
	let { resolvedAt, ...rest } = value;
	return {
		...rest,
		references: structuredClone(value.references),
		...(value.delivery !== undefined ? { delivery: structuredClone(value.delivery) } : {}),
		createdAt: new Date(value.createdAt),
		...(resolvedAt ? { resolvedAt: new Date(resolvedAt) } : {}),
	};
}

export class MemoryDeferredTurnStore implements DeferredTurnStore {
	#rows = new Map<string, Row>();
	#next = 1;
	constructor(
		private deps: {
			channelExists: (id: string) => boolean;
			assertLease: (lease: Lease) => void;
		},
	) {}
	async insert(lease: Lease, turn: NewDeferredTurn) {
		this.deps.assertLease(lease);
		this.check({ action: "insert", turn });
		return this.#insert(lease, turn);
	}
	async transition(lease: Lease, change: DeferredTurnTransition) {
		this.deps.assertLease(lease);
		return this.#transition(lease, change);
	}
	async interruptStale(lease: Lease, at: Date, documentId?: string) {
		this.deps.assertLease(lease);
		let moved: Row[] = [];
		for (let row of this.#rows.values()) {
			if (
				row.state === "started" && row.fencing < lease.fencing
				&& (documentId === undefined || row.documentId === documentId)
			) {
				row.state = "interrupted";
				row.fencing = lease.fencing;
				row.resolvedAt = new Date(at);
				moved.push(row);
			}
		}
		return moved.sort(order).map(copy);
	}
	async get(documentId: string, requestId: string) {
		let found = this.#find(documentId, requestId);
		return found && copy(found);
	}
	async list(documentId: string, states?: DeferredTurnState[]) {
		return [...this.#rows.values()]
			.filter(row => row.documentId === documentId && (!states || states.includes(row.state)))
			.sort(order)
			.map(copy);
	}
	async documents(states: DeferredTurnState[]) {
		return [
			...new Set(
				[...this.#rows.values()].filter(row => states.includes(row.state)).map(row =>
					row.documentId
				),
			),
		].sort();
	}
	/** What a commit must refuse before it changes anything, so applying its changes cannot fail. */
	check(change: DeferredTurnChange): void {
		if (change.action === "insert" && !this.deps.channelExists(change.turn.documentId)) {
			throw missing(`channel ${change.turn.documentId} does not exist`);
		}
	}
	apply(lease: Lease, changes: DeferredTurnChange[]): DeferredTurnOutcome[] {
		return changes.map(change =>
			change.action === "insert"
				? this.#insert(lease, change.turn)
				: this.#transition(lease, change)
		);
	}
	deleteChannel(channelId: string) {
		for (let [id, row] of this.#rows) if (row.documentId === channelId) this.#rows.delete(id);
	}
	#find(documentId: string, requestId: string): Row | undefined {
		for (let row of this.#rows.values()) {
			if (row.documentId === documentId && row.requestId === requestId) return row;
		}
		return undefined;
	}
	#insert(lease: Lease, turn: NewDeferredTurn): DeferredTurnOutcome {
		let repeated = this.#find(turn.documentId, turn.requestId);
		if (repeated) return { action: "insert", status: "repeated", turn: copy(repeated) };
		if (turn.kind === "comment" && turn.threadId !== undefined) {
			for (let row of this.#rows.values()) {
				if (
					row.documentId === turn.documentId && row.kind === "comment" && row.state === "waiting"
					&& row.threadId === turn.threadId
					&& (row.threadChannelId ?? "") === (turn.threadChannelId ?? "")
				) return { action: "insert", status: "thread-waiting", turn: copy(row) };
			}
		}
		let row: Row = {
			...copy({ ...turn, state: "waiting", fencing: lease.fencing, seq: 0 }),
			seq: this.#next++,
		};
		this.#rows.set(row.id, row);
		return { action: "insert", status: "inserted", turn: copy(row) };
	}
	#transition(lease: Lease, change: DeferredTurnTransition): DeferredTurnOutcome {
		let row = this.#rows.get(change.id);
		if (!row) return { action: "transition", changed: false, reason: "missing" };
		if (!legalDeferredTransition(change.from, change.to)) {
			return { action: "transition", changed: false, reason: "illegal", turn: copy(row) };
		}
		if (row.state !== change.from || (change.to === "ended" && row.fencing !== lease.fencing)) {
			return { action: "transition", changed: false, reason: "state", turn: copy(row) };
		}
		row.state = change.to;
		row.fencing = lease.fencing;
		if (change.to === "started") delete row.resolvedAt;
		else row.resolvedAt = new Date(change.at);
		if (change.to === "cancelled" && change.reason) row.cancelReason = change.reason;
		else delete row.cancelReason;
		return { action: "transition", changed: true, turn: copy(row) };
	}
}

function order(a: Row, b: Row): number {
	return a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq;
}
