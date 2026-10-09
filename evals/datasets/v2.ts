import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import manifestJson from "./v2/manifest.json";

type File = { path: string; sha256: string; bytes: number };
type Case = {
	id: string;
	kind: "synthetic-chat" | "async-discussion" | "authored-proposal";
	origin: "synthetic" | "adapted" | "original-source";
	sourceCluster: string;
	checkpoints?: string[];
	cutoff?: string;
	sourceUrl?: string;
	pinnedUrl?: string;
	file: File;
};
type Step =
	| { id: string; kind: "say"; actor: string; text: string; to: "room" | "planner" }
	| { id: string; kind: "checkpoint"; waitFor: string; deadlineMs: number }
	| { id: string; kind: "research-action"; actor: string; researchKey: string; action: string };
type Event = {
	id: string;
	kind: string;
	actor: unknown;
	createdAt: string;
	visibleAt?: string;
	parentId?: string;
	url?: string;
	summary: string;
};
export type DevelopmentInput =
	| {
		kind: "synthetic-chat";
		origin: "synthetic";
		id: string;
		checkpointId: string;
		actors: string[];
		initialDocument: string;
		steps: Step[];
	}
	| {
		kind: "async-discussion";
		origin: "adapted";
		id: string;
		checkpointId: string;
		cutoff: string;
		links: "inert";
		sourceUrl: string;
		events: Event[];
	}
	| {
		kind: "authored-proposal";
		origin: "original-source";
		id: string;
		cutoff: string;
		links: "inert";
		sourceUrl: string;
		pinnedUrl: string;
		text: string;
	};

let root = new URL("./v2/", import.meta.url);
let manifest = manifestJson as { version: number; cases: Case[] };

export function listCases() {
	return manifest.cases.map((entry) => ({
		id: entry.id,
		kind: entry.kind,
		origin: entry.origin,
		sourceCluster: entry.sourceCluster,
		checkpoints: [...(entry.checkpoints ?? [])],
		cutoff: entry.cutoff,
	}));
}

/** Load one committed development input. Linked pages are never fetched. */
export async function loadCase(
	id: string,
	checkpointId?: string,
	read: (url: URL) => Promise<Uint8Array> = readFile,
): Promise<DevelopmentInput> {
	let entry = manifest.cases.find((candidate) => candidate.id === id);
	if (!entry) throw new Error(`Unsupported development case: ${id}`);
	if (entry.kind === "authored-proposal") {
		if (checkpointId !== undefined) throw new Error(`Unsupported checkpoint: ${checkpointId}`);
	} else if (!checkpointId || !entry.checkpoints?.includes(checkpointId)) {
		throw new Error(`Unsupported checkpoint: ${checkpointId}`);
	}
	let bytes = await read(new URL(entry.file.path, root));
	if (
		bytes.byteLength !== entry.file.bytes
		|| createHash("sha256").update(bytes).digest("hex") !== entry.file.sha256
	) {
		throw new Error(`Dataset bytes changed: ${entry.file.path}`);
	}
	let text = new TextDecoder().decode(bytes);
	if (entry.kind === "authored-proposal") {
		return {
			kind: entry.kind,
			origin: "original-source",
			id,
			cutoff: entry.cutoff!,
			links: "inert",
			sourceUrl: entry.sourceUrl!,
			pinnedUrl: entry.pinnedUrl!,
			text,
		};
	}
	let document = JSON.parse(text);
	if (document.id !== id || (document.version !== 2 && document.schemaVersion !== 2)) {
		throw new Error(`Invalid dataset identity: ${id}`);
	}
	if (entry.kind === "synthetic-chat") {
		if (document.kind !== entry.kind || document.origin !== entry.origin) {
			throw new Error(`Invalid chat origin: ${id}`);
		}
		let end = document.steps.findIndex((step: Step) => step.id === checkpointId);
		if (end < 0 || document.steps[end].kind !== "checkpoint") {
			throw new Error(`Missing checkpoint: ${id}/${checkpointId}`);
		}
		return {
			kind: "synthetic-chat",
			origin: "synthetic",
			id,
			checkpointId: checkpointId!,
			actors: [...document.actors],
			initialDocument: document.initialDocument,
			steps: document.steps.slice(0, end + 1),
		};
	}
	if (document.origin !== "adapted") throw new Error(`Invalid discussion origin: ${id}`);
	let checkpoint = document.cutoffs.find((cutoff: { id: string }) => cutoff.id === checkpointId);
	if (!checkpoint || !Number.isFinite(Date.parse(checkpoint.at))) {
		throw new Error(`Missing cutoff: ${id}/${checkpointId}`);
	}
	let cutoff = Date.parse(checkpoint.at);
	let events = (document.events as Event[]).filter((event) => {
		let visible = Date.parse(event.visibleAt ?? event.createdAt);
		if (!Number.isFinite(visible)) throw new Error(`Invalid event time: ${event.id}`);
		return visible <= cutoff;
	});
	return {
		kind: "async-discussion",
		origin: "adapted",
		id,
		checkpointId: checkpointId!,
		cutoff: checkpoint.at,
		links: "inert",
		sourceUrl: document.source.url,
		events,
	};
}
