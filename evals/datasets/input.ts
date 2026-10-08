import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import proposals from "./proposals.json";
import registry from "./registry.json";

type JsonRecord = Record<string, unknown>;
type File = { path: string; sha256: string };
type Say = { id: string; kind: "say"; actor: string; text: string; to: "room" | "planner" };
type Checkpoint = {
	id: string;
	kind: "checkpoint";
	waitFor: "settled" | "analysis" | "research-terminal";
	deadlineMs: number;
};
type ResearchAction = {
	id: string;
	kind: "research-action";
	actor: string;
	researchKey: string;
	action: "research" | "dismiss";
};
export type ChatInput = {
	kind: "synthetic-chat";
	id: string;
	checkpointId: string;
	actors: string[];
	initialDocument: string;
	steps: (Say | Checkpoint | ResearchAction)[];
};
export type DiscussionInput = {
	kind: "async-discussion";
	id: string;
	checkpointId: string;
	cutoff: string;
	links: "inert";
	threadModel: string;
	source: unknown;
	events: JsonRecord[];
};
export type ProposalInput = {
	kind: "authored-proposal";
	id: string;
	cutoff: string;
	links: "inert";
	sourceUrl: string;
	pinnedUrl: string;
	text: string;
};

let snapshotRoot = new URL("../../data/visual-doc-corpus/development/", import.meta.url);

async function verifiedBytes(file: File, read: (url: URL) => Promise<Uint8Array>) {
	let bytes = await read(new URL(file.path, snapshotRoot));
	if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
		throw new Error(`Dataset bytes changed: ${file.path}`);
	}
	return bytes;
}

// Return copies: callers cannot change the allowlist used by the loader.
export function listDevelopment() {
	return registry.development.map((entry) => ({
		id: entry.id,
		kind: entry.kind,
		checkpoints: [...(entry.checkpoints ?? entry.files!.map((file) => file.checkpoint))],
	}));
}

export function listProposals() {
	return proposals.cases.map((entry) => ({
		id: entry.id,
		kind: entry.kind,
		cutoff: entry.cutoff,
		sourceUrl: entry.sourceUrl,
		pinnedUrl: entry.pinnedUrl,
	}));
}

/** Proposals are separate source documents, never later context for a discussion checkpoint. */
export async function loadProposal(
	id: string,
	read: (url: URL) => Promise<Uint8Array> = readFile,
): Promise<ProposalInput> {
	let entry = proposals.cases.find((entry) => entry.id === id);
	if (!entry) throw new Error(`Unsupported proposal: ${id}`);
	let bytes = await verifiedBytes(entry.file, read);
	return {
		kind: "authored-proposal",
		id,
		cutoff: entry.cutoff,
		links: "inert",
		sourceUrl: entry.sourceUrl,
		pinnedUrl: entry.pinnedUrl,
		text: new TextDecoder().decode(bytes),
	};
}

/** Loads one checkpoint only. No path API, URL fetch, annotations, or gold output. */
export async function loadInput(
	id: string,
	checkpointId: string,
	read: (url: URL) => Promise<Uint8Array> = readFile,
): Promise<ChatInput | DiscussionInput> {
	let entry = registry.development.find((entry) => entry.id === id);
	if (!entry) throw new Error(`Unsupported development case: ${id}`);
	let file: File;
	if (entry.kind === "synthetic-chat") {
		if (!entry.checkpoints!.includes(checkpointId)) {
			throw new Error(`Unsupported checkpoint: ${checkpointId}`);
		}
		file = entry.file!;
	} else {
		let checkpoint = entry.files!.find((file) => file.checkpoint === checkpointId);
		if (!checkpoint) throw new Error(`Unsupported checkpoint: ${checkpointId}`);
		file = checkpoint;
	}
	let bytes = await verifiedBytes(file, read);
	let document = JSON.parse(new TextDecoder().decode(bytes));
	if (entry.kind === "synthetic-chat") {
		if (document.id !== id || document.partition !== "development") {
			throw new Error(`Invalid chat identity: ${id}`);
		}
		let steps: ChatInput["steps"] = [];
		for (let step of document.input.steps) {
			switch (step.kind) {
				case "say":
					steps.push({
						id: step.id,
						kind: "say",
						actor: step.actor,
						text: step.text,
						to: step.to,
					});
					break;
				case "checkpoint":
					steps.push({
						id: step.id,
						kind: "checkpoint",
						waitFor: step.waitFor,
						deadlineMs: step.deadlineMs,
					});
					break;
				case "research-action":
					steps.push({
						id: step.id,
						kind: "research-action",
						actor: step.actor,
						researchKey: step.researchKey,
						action: step.action,
					});
					break;
				default:
					throw new Error(`Unsupported chat step: ${step.kind}`);
			}
			if (step.id === checkpointId) break;
		}
		return {
			kind: "synthetic-chat",
			id,
			checkpointId,
			actors: [...document.input.actors],
			initialDocument: document.input.initialDocument,
			steps,
		};
	}
	let checkpoint = entry.files!.find((file) => file.checkpoint === checkpointId)!;
	let recordedId = document.episodeId ?? document.episode;
	let recordedCheckpoint = document.checkpointId ?? document.checkpoint;
	if (
		recordedId !== id
		|| (typeof recordedCheckpoint === "number" ? `c${recordedCheckpoint}` : recordedCheckpoint)
			!== checkpointId
		|| document.cutoff !== checkpoint.cutoff
	) {
		throw new Error(`Invalid discussion identity: ${id}/${checkpointId}`);
	}
	let cutoff = Date.parse(document.cutoff);
	if (!Number.isFinite(cutoff)) throw new Error("Invalid cutoff");
	let events = document.events as JsonRecord[];
	for (let event of events) {
		for (let field of ["createdAt", "lastEditedAt", "created_at", "edited_at", "visible_at"]) {
			let value = event[field];
			if (value == null) continue;
			let time = typeof value === "string" ? Date.parse(value) : NaN;
			if (!Number.isFinite(time) || time > cutoff) {
				throw new Error(`Event outside cutoff: ${event.id}`);
			}
		}
	}
	return {
		kind: "async-discussion",
		id,
		checkpointId,
		cutoff: document.cutoff,
		links: "inert",
		threadModel: document.threadModel ?? (entry.schemaGroup === "web-frameworks"
			? "GitHub Discussion with recorded nested reply parents"
			: "Flat GitHub issue/PR comments; exact reply parents unavailable"),
		source: document.sourceAttribution ?? document.source_identity ?? {
			id: document.sourceId,
			number: document.sourceNumber,
		},
		// Keep frozen wording, identities, attribution, links, and process events verbatim.
		// A close/merge remains a source event; it never generates a Chopin Save action.
		events,
	};
}
