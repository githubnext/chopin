import { conflict } from "./errors";
import type { InitialChannel, Lease } from "./model";

export type FollowthroughKind = "research" | "investigation";
export type FollowthroughStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type FollowthroughContext = { planRevision: number; sourceHash: string };
export type Followthrough = {
	id: string;
	channelId: string;
	childId: string;
	kind: FollowthroughKind;
	sourceId: string;
	resultKey: string;
	status: FollowthroughStatus;
	revision: number;
	attempts: number;
	createdAt: Date;
	updatedAt: Date;
	reason?: string;
	context?: FollowthroughContext;
	attemptToken?: string;
};
export type FollowthroughPublication =
	& Pick<
		Followthrough,
		"channelId" | "childId" | "kind" | "sourceId" | "resultKey"
	>
	& { now: Date };

export interface FollowthroughStore {
	get(channelId: string, id: string): Promise<Followthrough | undefined>;
	forSource(channelId: string, kind: FollowthroughKind, sourceId: string): Promise<Followthrough[]>;
	/** Oldest pending receipts, bounded to at most 100. */
	pending(channelId: string | undefined, limit: number): Promise<Followthrough[]>;
	claim(
		channelId: string,
		id: string,
		expectedRevision: number,
		context: FollowthroughContext,
		lease: Lease,
	): Promise<Followthrough | undefined>;
	defer(
		channelId: string,
		id: string,
		expectedRevision: number,
		reason: string,
		lease: Lease,
	): Promise<Followthrough | undefined>;
	finish(
		channelId: string,
		id: string,
		expectedRevision: number,
		outcome: "done" | "failed" | "skipped",
		reason: string | undefined,
		lease: Lease,
	): Promise<Followthrough | undefined>;
	retry(
		channelId: string,
		id: string,
		expectedRevision: number,
		lease: Lease,
	): Promise<Followthrough | undefined>;
	dismiss(
		channelId: string,
		id: string,
		expectedRevision: number,
		lease: Lease,
	): Promise<Followthrough | undefined>;
	skip(
		channelId: string,
		id: string,
		expectedRevision: number,
		reason: string,
		lease: Lease,
	): Promise<Followthrough | undefined>;
	/** Release only before any model stream begins; never replay started or interrupted work. */
	releaseUnstarted(
		channelId: string,
		id: string,
		expectedRevision: number,
		attemptToken: string,
		reason: string,
		lease: Lease,
	): Promise<Followthrough | undefined>;
	/** Startup only: interrupted model work requires an explicit retry, never automatic replay. */
	recoverInterrupted(lease: Lease): Promise<number>;
}

export type FollowthroughChange =
	| { action: "claim"; context: FollowthroughContext }
	| { action: "defer"; reason: string }
	| { action: "skip"; reason: string }
	| { action: "release-unstarted"; attemptToken: string; reason: string }
	| { action: "finish"; outcome: "done" | "failed" | "skipped"; reason?: string }
	| { action: "retry" | "dismiss" };

function bounded(value: string, limit: number): void {
	if (
		typeof value !== "string" || !value.trim() || value.length > limit
		|| [...value].some(character => character.charCodeAt(0) < 32)
	) {
		throw conflict("invalid follow-through metadata");
	}
}

export function followthroughLimit(limit: number): number {
	if (!Number.isSafeInteger(limit) || limit < 1) throw conflict("invalid follow-through limit");
	return Math.min(100, limit);
}

export function assertResultInitial(initial: InitialChannel): void {
	if (
		!initial || !(initial.document instanceof Uint8Array) || !initial.document.byteLength
		|| typeof initial.source !== "string" || !initial.source.trim()
		|| !initial.generation || !initial.epoch || !initial.sourceHash || !initial.sidecar
	) {
		throw conflict("result publication requires an initialized document");
	}
}

export function followthroughPublication(input: FollowthroughPublication): Followthrough {
	for (let value of [input.channelId, input.childId, input.sourceId, input.resultKey]) {
		bounded(value, 256);
	}
	if (
		!["research", "investigation"].includes(input.kind) || !(input.now instanceof Date)
		|| !Number.isFinite(input.now.getTime())
	) {
		throw conflict("invalid follow-through publication");
	}
	let id = new Bun.CryptoHasher("sha256").update(JSON.stringify([
		input.channelId,
		input.kind,
		input.sourceId,
		input.resultKey,
	])).digest("hex");
	return {
		id,
		channelId: input.channelId,
		childId: input.childId,
		kind: input.kind,
		sourceId: input.sourceId,
		resultKey: input.resultKey,
		status: "pending",
		revision: 0,
		attempts: 0,
		createdAt: new Date(input.now),
		updatedAt: new Date(input.now),
	};
}

/** Undefined means the status disallows this action; returning the input is a deduplicated defer. */
export function changeFollowthrough(
	value: Followthrough,
	change: FollowthroughChange,
): Followthrough | undefined {
	let next = {
		...value,
		revision: value.revision + 1,
		updatedAt: new Date(Math.max(Date.now(), value.updatedAt.getTime())),
	};
	if (change.action === "claim") {
		if (!Number.isSafeInteger(change.context.planRevision) || change.context.planRevision < 0) {
			throw conflict("invalid follow-through plan revision");
		}
		bounded(change.context.sourceHash, 128);
		if (value.status !== "pending") return;
		next.status = "running";
		next.context = { ...change.context };
		next.attemptToken = crypto.randomUUID();
		next.attempts++;
		delete next.reason;
	} else if (change.action === "defer") {
		bounded(change.reason, 160);
		if (value.status !== "pending") return;
		if (value.reason === change.reason) return value;
		next.reason = change.reason;
	} else if (change.action === "skip") {
		bounded(change.reason, 160);
		if (value.status !== "pending") return;
		next.status = "skipped";
		next.reason = change.reason;
	} else if (change.action === "finish") {
		if (!["done", "failed", "skipped"].includes(change.outcome)) {
			throw conflict("invalid follow-through outcome");
		}
		if (change.reason !== undefined) bounded(change.reason, 160);
		if (value.status !== "running") return;
		next.status = change.outcome;
		if (change.reason === undefined) delete next.reason;
		else next.reason = change.reason;
	} else if (change.action === "release-unstarted") {
		bounded(change.reason, 160);
		if (value.status !== "running" || value.attemptToken !== change.attemptToken) return;
		next.status = "pending";
		next.reason = change.reason;
		delete next.context;
		delete next.attemptToken;
	} else if (change.action === "retry") {
		if (value.status !== "failed") return;
		next.status = "pending";
		delete next.reason;
		delete next.context;
		delete next.attemptToken;
	} else {
		if (!["pending", "failed"].includes(value.status)) return;
		next.status = "skipped";
		next.reason = "dismissed";
	}
	return next;
}
