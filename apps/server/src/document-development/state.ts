import * as Y from "yjs";
import * as room from "../plan/room";
import { parse } from "@chopin/dialect";
import { supported } from "./markdown";
import { restoreRecovery } from "./recovery-state";
import { encodeDeletes } from "./recovery-yjs";
import type { Recovery } from "./recovery-state";
import { parseDocumentDevelopmentInput } from "./schema";

import type { Plan as Wire } from "@chopin/protocol";
import type { Plan } from "../plan/service";
import type { JsonValue } from "../storage/model";
import type { DocumentDevelopmentInput } from "./schema";

export const MAX_PASSAGES = 48;
export const MAX_SOURCE = 12_000;

export type Passage = {
	id: string;
	anchor: Wire.Anchor;
	/** The last source this feature authored, never a digest of a person's replacement. */
	generatedDigest: string;
	sourceIds: string[];
	status: "generated" | "protected" | "orphaned";
};

export type State = {
	recovery?: Recovery;
	version: 1;
	paused: boolean;
	lastMessageId?: string;
	lastJobId?: string;
	lastOutcome?: "updated" | "unchanged" | "failed" | "stale";
	pending?: { input: DocumentDevelopmentInput; jobId?: string };
	attempts: number[];
	passages: Passage[];
};

export function initial(): State {
	return { version: 1, paused: false, attempts: [], passages: [] };
}

function invalid(): never {
	throw new Error("hosted channel has invalid document development provenance");
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
	if (
		required.some(key => !Object.hasOwn(value, key))
		|| Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
	) invalid();
}

function text(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 200 || /\s/.test(value)) invalid();
	return value;
}

function digest(value: unknown): string {
	if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) invalid();
	return value;
}

function anchor(value: unknown): Wire.Anchor {
	let item = object(value);
	keys(item, ["epoch", "position", "digest"]);
	let epoch = text(item.epoch);
	let hash = digest(item.digest);
	if (
		typeof item.position !== "string" || !item.position || item.position.length > 2_048
		|| !/^[A-Za-z0-9+/]+={0,2}$/.test(item.position)
	) invalid();
	try {
		let bytes = Buffer.from(item.position, "base64");
		if (bytes.toString("base64") !== item.position) invalid();
		Y.decodeRelativePosition(bytes);
	} catch {
		invalid();
	}
	return { epoch, position: item.position, digest: hash };
}

/** Absence is legacy state; a present malformed field must never grant write authority. */
export function restore(value: unknown): State | undefined {
	if (value === undefined) return undefined;
	let item = object(value);
	keys(item, ["version", "paused", "attempts", "passages"], [
		"lastMessageId",
		"lastJobId",
		"lastOutcome",
		"pending",
		"recovery",
	]);
	if (item.version !== 1 || typeof item.paused !== "boolean") invalid();
	if (
		Object.hasOwn(item, "lastOutcome")
		&& !["updated", "unchanged", "failed", "stale"].includes(item.lastOutcome as string)
	) invalid();
	if (
		!Array.isArray(item.attempts) || item.attempts.length > 8
		|| item.attempts.some(at => !Number.isSafeInteger(at) || at < 0)
		|| !Array.isArray(item.passages) || item.passages.length > MAX_PASSAGES
	) invalid();
	let attempts = item.attempts as number[];
	if (attempts.some((at, index) => index > 0 && at < attempts[index - 1]!)) invalid();
	let pending: State["pending"];
	if (Object.hasOwn(item, "pending")) {
		let value = object(item.pending);
		keys(value, ["input"], ["jobId"]);
		pending = {
			input: parseDocumentDevelopmentInput(value.input as JsonValue),
			...(Object.hasOwn(value, "jobId") ? { jobId: text(value.jobId) } : {}),
		};
	}
	let seen = new Set<string>();
	let passages = item.passages.map(raw => {
		let passage = object(raw);
		keys(passage, ["id", "anchor", "generatedDigest", "sourceIds", "status"]);
		let id = text(passage.id);
		if (seen.has(id)) invalid();
		seen.add(id);
		if (
			!Array.isArray(passage.sourceIds) || passage.sourceIds.length < 1
			|| passage.sourceIds.length > 24
			|| new Set(passage.sourceIds).size !== passage.sourceIds.length
			|| !["generated", "protected", "orphaned"].includes(passage.status as string)
		) invalid();
		return {
			id,
			anchor: anchor(passage.anchor),
			generatedDigest: digest(passage.generatedDigest),
			sourceIds: passage.sourceIds.map(text),
			status: passage.status as Passage["status"],
		};
	});
	return {
		version: 1,
		paused: item.paused,
		...(Object.hasOwn(item, "recovery")
			? { recovery: restoreRecovery(item.recovery, anchor) }
			: {}),
		...(Object.hasOwn(item, "lastMessageId") ? { lastMessageId: text(item.lastMessageId) } : {}),
		...(Object.hasOwn(item, "lastJobId") ? { lastJobId: text(item.lastJobId) } : {}),
		...(Object.hasOwn(item, "lastOutcome")
			? { lastOutcome: item.lastOutcome as State["lastOutcome"] }
			: {}),
		...(pending ? { pending } : {}),
		attempts: [...attempts],
		passages,
	};
}

/** Resolve identity only. Identical source elsewhere is not permission to edit it. */
export function indexOf(document: room.Document, passage: Passage): number | undefined {
	// Rebuilding the last committed Yjs checkpoint changes its epoch, but retains its identities.
	let current = { ...passage.anchor, epoch: document.epoch };
	return room.anchorIndex(document, current);
}

function decided(plan: Plan): Wire.Anchor[] {
	let anchors: Wire.Anchor[] = [];
	for (let record of plan.records.values()) {
		if (record.status !== "answered") continue;
		anchors.push(...record.prose ?? []);
		for (let set of Object.values(record.anchors?.questions ?? {})) anchors.push(...set.anchors);
	}
	for (let thread of plan.threads.values()) {
		if (thread.status === "accepted") anchors.push(...thread.passage.blocks);
		if (thread.status === "accepted" || thread.status === "resolved") {
			anchors.push(...thread.result?.anchors ?? []);
		}
	}
	return anchors;
}

/** Pure snapshot: adoption belongs after the document and this sidecar commit together. */
export function capture(plan: Plan): State | undefined {
	let state = restore(plan.documentDevelopment);
	if (state?.recovery && state.recovery.epoch !== plan.document.epoch) {
		state.recovery = {
			epoch: plan.document.epoch,
			document: Buffer.from(Y.encodeStateAsUpdate(plan.document.doc)).toString("base64"),
			deletes: encodeDeletes(Y.createDeleteSet()),
			retired: state.recovery.retired.filter(item => item.version?.status === "pending"),
		};
	}
	if (!state || state.passages.length === 0) return state;
	let hashes = room.digests(plan.document);
	let blocks = parse(room.project(plan.document)).children;
	let authoritative = decided(plan);
	let protectedIndices = new Set(
		authoritative.map(anchor =>
			room.anchorIndex(plan.document, { ...anchor, epoch: plan.document.epoch })
		),
	);
	let protectedDigests = new Set(
		authoritative.filter(anchor => !anchor.orphaned).map(anchor => anchor.digest),
	);
	return {
		...state,
		passages: state.passages.map(passage => {
			if (passage.status !== "generated") return passage;
			let index = indexOf(plan.document, passage);
			if (index === undefined) return { ...passage, status: "orphaned" };
			let hash = hashes[index]!;
			if (
				hash !== passage.generatedDigest || !supported(blocks[index]!)
				|| protectedIndices.has(index) || protectedDigests.has(hash)
			) return { ...passage, status: "protected" };
			return { ...passage, anchor: room.anchorAt(plan.document, index, hash) };
		}),
	};
}
