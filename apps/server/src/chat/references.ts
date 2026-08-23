import { createHash } from "node:crypto";

import { ULID, ulid } from "@chopin/dialect";
import {
	documentPath,
	parseDocumentPath,
	parseResearchWorkspacePath,
	researchWorkspacePath,
} from "@chopin/protocol/document-url";
import { instruction, MENTION } from "@chopin/protocol/address";

import { isChannelId } from "../channels/id";
import {
	parseResearchAnswerArtifact,
	parseResearchEvidenceArtifact,
} from "../jobs/research-workspace";

import type { Chat as Wire, Job } from "@chopin/protocol";
import type { JsonValue } from "../storage/model";
import type { StorageAdapter } from "../storage/port";
import type { DocumentTarget } from "../plan/service";
import type { ResearchWorkspaceService, ResearchWorkspaceView } from "../research/service";

const MAX_REFERENCES = 10;
const MAX_TOKEN = 256;
const MAX_LABEL = 121;
const MAX_HREF = 2_048;
const MAX_REPOSITORY_ID = 255;
const MAX_WORKSPACE_ID = 96;
const MAX_RESEARCH_TURNS = 12;
const MAX_RESEARCH_TURN_BYTES = 2 * 1024 * 1024;
const MAX_RESEARCH_MESSAGES = 100;
const MAX_RESEARCH_MESSAGE = 4_096;
const MAX_RESEARCH_MESSAGE_BYTES = 256 * 1024;
const SOURCE_HASH = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export class ChatReferenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ChatReferenceError";
	}
}

export type ReferenceServiceOptions = {
	storage: StorageAdapter;
	current: (channelId: string) => Promise<DocumentTarget | undefined>;
	research: ResearchWorkspaceService;
	id?: () => string;
};

export type ResolveReferences = {
	channelId: string;
	repositoryId: string;
	text: string;
	destination: Wire.Destination;
	requests?: Wire.ReferenceRequest[];
};

export type ResolvedMessage = {
	text: string;
	references?: Wire.Reference[];
};

export type ReadReference = {
	channelId: string;
	repositoryId: string;
	reference: Wire.Reference;
};

type TextUnit = { value: string; reference?: number };

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		let code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function opaqueId(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= maximum
		&& !hasControlCharacter(value);
}

function safeWorkspaceId(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= MAX_WORKSPACE_ID
		&& SAFE_ID.test(value);
}

function safeBoundary(text: string, boundary: number): boolean {
	if (boundary <= 0 || boundary >= text.length) return true;
	let previous = text.charCodeAt(boundary - 1);
	let next = text.charCodeAt(boundary);
	return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function token(text: string, start: number, end: number, marker: "#" | "%"): string {
	if (
		!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
		|| start < 0 || end <= start || end > text.length || end - start > MAX_TOKEN
		|| !safeBoundary(text, start) || !safeBoundary(text, end)
	) throw new ChatReferenceError("Reference range is invalid.");
	let value = text.slice(start, end);
	if (!value.startsWith(marker) || [...value].length > MAX_LABEL || hasControlCharacter(value)) {
		throw new ChatReferenceError("Reference token is invalid.");
	}
	return value;
}

function exact(value: Record<string, unknown>, fields: string[]): boolean {
	let keys = Object.keys(value).sort();
	let expected = [...fields].sort();
	return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function request(value: unknown): Wire.ReferenceRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ChatReferenceError("Reference request is invalid.");
	}
	let item = value as Record<string, unknown>;
	if (item.kind === "document") {
		if (
			!exact(item, ["channelId", "end", "kind", "start"])
			|| typeof item.channelId !== "string" || !isChannelId(item.channelId)
		) {
			throw new ChatReferenceError("Document reference is invalid.");
		}
		return item as Wire.ReferenceRequest;
	}
	if (item.kind === "research") {
		if (
			!exact(item, ["end", "kind", "start", "workspaceId"])
			|| !safeWorkspaceId(item.workspaceId)
		) throw new ChatReferenceError("Research reference is invalid.");
		return item as Wire.ReferenceRequest;
	}
	throw new ChatReferenceError("Reference kind is invalid.");
}

function isWord(value: string | undefined): boolean {
	return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function requests(text: string, value: unknown): Wire.ReferenceRequest[] {
	if (value !== undefined && !Array.isArray(value)) {
		throw new ChatReferenceError("References must be an array.");
	}
	let values = value as unknown[] | undefined;
	if ((values?.length ?? 0) > MAX_REFERENCES) {
		throw new ChatReferenceError(`A message may contain at most ${MAX_REFERENCES} references.`);
	}
	let parsed = Array.from(values ?? [], request);
	let previousEnd = -1;
	let targets = new Set<string>();
	for (let item of parsed) {
		if (item.start < previousEnd) {
			throw new ChatReferenceError("References must be sorted and disjoint.");
		}
		let marker: "#" | "%" = item.kind === "document" ? "#" : "%";
		token(text, item.start, item.end, marker);
		previousEnd = item.end;
		let target = `${item.kind}:${item.kind === "document" ? item.channelId : item.workspaceId}`;
		if (targets.has(target)) throw new ChatReferenceError("Reference targets must be unique.");
		targets.add(target);
	}
	return parsed;
}

function units(value: string, referenceIndex?: number): TextUnit[] {
	let result: TextUnit[] = [];
	for (let index = 0; index < value.length; index++) {
		result.push({
			value: value[index]!,
			...(referenceIndex !== undefined ? { reference: referenceIndex } : {}),
		});
	}
	return result;
}

/** Remove Planner addressing only from prose; canonical reference labels are opaque. */
function plannerText(input: TextUnit[]): TextUnit[] {
	let text = input.map(unit => unit.value).join("");
	let filtered: TextUnit[] = [];
	for (let source = 0; source < input.length; source++) {
		if (
			text.slice(source, source + MENTION.length).toLowerCase() === MENTION
			&& (source === 0 || !isWord(text[source - 1]) && text[source - 1] !== "@")
			&& !isWord(text[source + MENTION.length])
			&& input.slice(source, source + MENTION.length).every(unit => unit.reference === undefined)
		) {
			source += MENTION.length - 1;
			continue;
		}
		filtered.push(input[source]!);
	}

	let collapsed: TextUnit[] = [];
	for (let index = 0; index < filtered.length;) {
		let current = filtered[index]!;
		if (current.reference !== undefined || !/[^\S\n]/.test(current.value)) {
			collapsed.push(current);
			index++;
			continue;
		}
		let end = index + 1;
		while (
			end < filtered.length && filtered[end]!.reference === undefined
			&& /[^\S\n]/.test(filtered[end]!.value)
		) end++;
		collapsed.push(end - index >= 2 ? { value: " " } : current);
		index = end;
	}

	let start = 0;
	let end = collapsed.length;
	while (
		start < end && collapsed[start]!.reference === undefined
		&& /\s/.test(collapsed[start]!.value)
	) start++;
	while (
		end > start && collapsed[end - 1]!.reference === undefined
		&& /\s/.test(collapsed[end - 1]!.value)
	) end--;
	return collapsed.slice(start, end);
}

function canonicalMessage(
	text: string,
	destination: Wire.Destination,
	references: Wire.Reference[],
): ResolvedMessage {
	if (references.length === 0) {
		return { text: destination === "planner" ? instruction(text) : text.trim() };
	}
	let canonical: TextUnit[] = [];
	let cursor = 0;
	for (let [index, reference] of references.entries()) {
		canonical.push(...units(text.slice(cursor, reference.start)));
		canonical.push(...units(reference.label, index));
		cursor = reference.end;
	}
	canonical.push(...units(text.slice(cursor)));
	if (destination === "planner") canonical = plannerText(canonical);
	else {
		let start = 0;
		let end = canonical.length;
		while (
			start < end && canonical[start]!.reference === undefined && /\s/.test(canonical[start]!.value)
		) {
			start++;
		}
		while (
			end > start && canonical[end - 1]!.reference === undefined
			&& /\s/.test(canonical[end - 1]!.value)
		) end--;
		canonical = canonical.slice(start, end);
	}

	let visible = canonical.map(unit => unit.value).join("");
	let ranges = references.map(() => ({ start: -1, end: -1 }));
	for (let [index, unit] of canonical.entries()) {
		if (unit.reference === undefined) continue;
		let range = ranges[unit.reference]!;
		if (range.start < 0) range.start = index;
		range.end = index + 1;
	}
	let restored = references.map((reference, index) => {
		let range = ranges[index]!;
		if (
			range.start < 0 || range.end <= range.start
			|| visible.slice(range.start, range.end) !== reference.label
		) throw new ChatReferenceError("Canonical reference range is invalid.");
		return { ...reference, ...range };
	});
	return { text: visible, references: restored };
}

function hash(source: string): string {
	return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function currentDocument(value: DocumentTarget | undefined, channelId: string): DocumentTarget {
	let target = value ?? { channelId, revision: 0, source: "", sourceHash: hash("") };
	if (
		target.channelId !== channelId || !Number.isSafeInteger(target.revision) || target.revision < 0
		|| typeof target.source !== "string" || !SOURCE_HASH.test(target.sourceHash)
		|| hash(target.source) !== target.sourceHash
	) throw new ChatReferenceError("Referenced document state is invalid.");
	return target;
}

function validLabel(value: unknown, marker: "#" | "%"): value is string {
	if (typeof value !== "string" || !value.startsWith(marker) || hasControlCharacter(value)) {
		return false;
	}
	let title = value.slice(1);
	return title.length > 0 && title === title.trim() && [...value].length <= MAX_LABEL;
}

function canonicalDocumentHref(value: unknown): value is string {
	if (typeof value !== "string" || value.length > MAX_HREF) return false;
	let parsed = parseDocumentPath(value);
	return !!parsed?.slug && documentPath(parsed.owner, parsed.repository, parsed.slug) === value;
}

function canonicalResearchHref(value: unknown): value is string {
	if (typeof value !== "string" || value.length > MAX_HREF) return false;
	let parsed = parseResearchWorkspacePath(value);
	return !!parsed
		&& researchWorkspacePath(parsed.owner, parsed.repository, parsed.slug, parsed.workspaceId)
			=== value;
}

function reference(value: unknown): Wire.Reference {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ChatReferenceError("Stored reference is invalid.");
	}
	let item = value as Record<string, unknown>;
	let base = typeof item.id === "string" && ULID.test(item.id)
		&& Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end)
		&& opaqueId(item.repositoryId, MAX_REPOSITORY_ID)
		&& typeof item.observedRevision === "number"
		&& Number.isSafeInteger(item.observedRevision) && item.observedRevision >= 0;
	if (item.kind === "document") {
		if (
			!base
			|| !exact(item, [
				"channelId",
				"end",
				"href",
				"id",
				"kind",
				"label",
				"observedRevision",
				"observedSourceHash",
				"repositoryId",
				"start",
			])
			|| typeof item.channelId !== "string" || !isChannelId(item.channelId)
			|| !validLabel(item.label, "#")
			|| !canonicalDocumentHref(item.href)
			|| typeof item.observedSourceHash !== "string"
			|| !SOURCE_HASH.test(item.observedSourceHash)
		) throw new ChatReferenceError("Stored document reference is invalid.");
		return item as Wire.DocumentReference;
	}
	if (item.kind === "research") {
		let parsedHref = typeof item.href === "string"
			? parseResearchWorkspacePath(item.href)
			: undefined;
		if (
			!base
			|| !exact(item, [
				"end",
				"href",
				"id",
				"kind",
				"label",
				"observedRevision",
				"parentChannelId",
				"repositoryId",
				"start",
				"workspaceId",
			])
			|| typeof item.parentChannelId !== "string" || !isChannelId(item.parentChannelId)
			|| !safeWorkspaceId(item.workspaceId)
			|| !validLabel(item.label, "%")
			|| !canonicalResearchHref(item.href)
			|| parsedHref?.workspaceId !== item.workspaceId
		) throw new ChatReferenceError("Stored research reference is invalid.");
		return item as Wire.ResearchReference;
	}
	throw new ChatReferenceError("Stored reference kind is invalid.");
}

/** Strictly restore optional transcript references and verify their ranges against stored text. */
export function restoreReferences(
	value: unknown,
	text: string,
	seenIds = new Set<string>(),
	scope?: { channelId: string; repositoryId: string },
): Wire.Reference[] {
	if (!Array.isArray(value) || value.length > MAX_REFERENCES) {
		throw new ChatReferenceError("Stored references are invalid.");
	}
	let restored = value.map(reference);
	let previousEnd = -1;
	let targets = new Set<string>();
	for (let item of restored) {
		if (item.start < previousEnd) {
			throw new ChatReferenceError("Stored references are not disjoint.");
		}
		token(text, item.start, item.end, item.kind === "document" ? "#" : "%");
		if (text.slice(item.start, item.end) !== item.label) {
			throw new ChatReferenceError("Stored reference label does not match its range.");
		}
		if (
			scope
			&& (item.repositoryId !== scope.repositoryId
				|| item.kind === "document" && item.channelId === scope.channelId
				|| item.kind === "research" && item.parentChannelId !== scope.channelId)
		) throw new ChatReferenceError("Stored reference is outside its parent document.");
		if (seenIds.has(item.id)) throw new ChatReferenceError("Stored reference id is duplicated.");
		seenIds.add(item.id);
		let target = `${item.kind}:${item.kind === "document" ? item.channelId : item.workspaceId}`;
		if (targets.has(target)) throw new ChatReferenceError("Stored reference target is duplicated.");
		targets.add(target);
		previousEnd = item.end;
	}
	return restored;
}

function state(value: Job.Detail | undefined): Job.State | undefined {
	return value?.job.state;
}

function evidence(value: Job.Detail | undefined) {
	if (value?.job.state !== "completed" || !value.artifact) return undefined;
	let artifact = parseResearchEvidenceArtifact(value.artifact.value as JsonValue);
	return {
		findings: artifact.findings,
		sources: artifact.sources,
	};
}

function answer(value: Job.Detail | undefined) {
	if (value?.job.state !== "completed" || !value.artifact) return undefined;
	let artifact = parseResearchAnswerArtifact(value.artifact.value as JsonValue);
	return artifact.kind === "initial"
		? {
			kind: artifact.kind,
			documentRevision: artifact.documentRevision,
			documentSourceHash: artifact.documentSourceHash,
			report: artifact.report,
			sources: artifact.sources,
		}
		: {
			kind: artifact.kind,
			documentRevision: artifact.documentRevision,
			documentSourceHash: artifact.documentSourceHash,
			answer: artifact.answer,
			sources: artifact.sources,
		};
}

function researchTurn(turn: ResearchWorkspaceView["turns"][number]) {
	let evidenceState = state(turn.evidence);
	let answerState = state(turn.answer);
	let evidenceArtifact = evidence(turn.evidence);
	let answerArtifact = answer(turn.answer);
	return {
		id: turn.id,
		ordinal: turn.ordinal,
		kind: turn.kind,
		question: turn.question,
		states: {
			...(evidenceState ? { evidence: evidenceState } : {}),
			...(answerState ? { answer: answerState } : {}),
		},
		...(evidenceArtifact ? { evidence: evidenceArtifact } : {}),
		...(answerArtifact ? { answer: answerArtifact } : {}),
	};
}

function researchTurns(view: ResearchWorkspaceView) {
	let initial = view.turns.find(turn => turn.kind === "initial");
	let selected: ReturnType<typeof researchTurn>[] = [];
	let bytes = 2;
	if (initial) {
		let projected = researchTurn(initial);
		bytes += Buffer.byteLength(JSON.stringify(projected));
		if (bytes > MAX_RESEARCH_TURN_BYTES) {
			throw new ChatReferenceError("Initial research turn exceeds the reference output limit.");
		}
		selected.push(projected);
	}
	let candidates = view.turns.filter(turn => turn !== initial)
		.toSorted((left, right) => right.ordinal - left.ordinal);
	for (let turn of candidates) {
		if (selected.length >= MAX_RESEARCH_TURNS) break;
		let projected = researchTurn(turn);
		let size = Buffer.byteLength(JSON.stringify(projected)) + (selected.length > 0 ? 1 : 0);
		if (bytes + size > MAX_RESEARCH_TURN_BYTES) break;
		selected.push(projected);
		bytes += size;
	}
	selected.sort((left, right) => left.ordinal - right.ordinal);
	return {
		turns: selected,
		truncation: {
			total: view.turns.length,
			returned: selected.length,
			truncated: selected.length < view.turns.length,
			countLimit: MAX_RESEARCH_TURNS,
			byteLimit: MAX_RESEARCH_TURN_BYTES,
		},
	};
}

function boundedMessageText(value: string, maximumBytes: number): string {
	let output = "";
	let bytes = 0;
	let points = 0;
	for (let point of value) {
		let size = Buffer.byteLength(point);
		if (points >= MAX_RESEARCH_MESSAGE || bytes + size > maximumBytes) break;
		output += point;
		bytes += size;
		points++;
	}
	return output;
}

function researchMessages(view: ResearchWorkspaceView) {
	let eligible = view.messages.filter(message =>
		message.authorKind === "member" || message.authorKind === "agent"
	);
	let candidates = eligible.slice(-MAX_RESEARCH_MESSAGES);
	let messages: Array<Record<string, unknown>> = [];
	let remaining = MAX_RESEARCH_MESSAGE_BYTES - 2;
	let truncatedText = false;
	for (let message of candidates.toReversed()) {
		let text = boundedMessageText(message.text, Math.max(0, remaining - 512));
		if (!text) break;
		let projected = {
			id: message.id,
			sequence: message.sequence,
			...(message.turnId ? { turnId: message.turnId } : {}),
			author: message.authorKind,
			...(message.userHandle ? { handle: message.userHandle } : {}),
			text,
			createdAt: message.createdAt,
		};
		let size = Buffer.byteLength(JSON.stringify(projected)) + (messages.length > 0 ? 1 : 0);
		if (size > remaining) break;
		messages.push(projected);
		remaining -= size;
		if (text !== message.text) truncatedText = true;
		if (remaining <= 0) break;
	}
	let values = messages.toReversed();
	return {
		messages: values,
		truncation: {
			total: eligible.length,
			returned: values.length,
			truncated: truncatedText || values.length < eligible.length,
			countLimit: MAX_RESEARCH_MESSAGES,
			byteLimit: MAX_RESEARCH_MESSAGE_BYTES,
			textLimit: MAX_RESEARCH_MESSAGE,
		},
	};
}

export class ReferenceService {
	#storage: StorageAdapter;
	#current: ReferenceServiceOptions["current"];
	#research: ResearchWorkspaceService;
	#id: () => string;

	constructor(options: ReferenceServiceOptions) {
		this.#storage = options.storage;
		this.#current = options.current;
		this.#research = options.research;
		this.#id = options.id ?? ulid;
	}

	async resolve(input: ResolveReferences): Promise<ResolvedMessage> {
		if (typeof input.text !== "string") throw new ChatReferenceError("Message text is invalid.");
		if (input.destination !== "room" && input.destination !== "planner") {
			throw new ChatReferenceError("Message destination is invalid.");
		}
		let requested = requests(input.text, input.requests);
		if (requested.length === 0) return canonicalMessage(input.text, input.destination, []);
		let parent = await this.#storage.channels.get(input.channelId);
		if (!parent || parent.repositoryId !== input.repositoryId) {
			throw new ChatReferenceError("Current document is unavailable.");
		}

		let resolved = await Promise.all(requested.map(async item => {
			if (item.kind === "document") {
				if (item.channelId === parent.id) {
					throw new ChatReferenceError("A document cannot reference itself.");
				}
				let target = await this.#storage.channels.get(item.channelId);
				if (!target || target.repositoryId !== parent.repositoryId) {
					throw new ChatReferenceError("Referenced document is unavailable.");
				}
				let document = currentDocument(await this.#current(target.id), target.id);
				return {
					kind: "document" as const,
					start: item.start,
					end: item.end,
					label: `#${target.title}`,
					href: documentPath(target.repositoryOwner, target.repositoryName, target.slug),
					repositoryId: target.repositoryId,
					observedRevision: document.revision,
					channelId: target.id,
					observedSourceHash: document.sourceHash,
				};
			}

			let detail = await this.#storage.research.get(parent.id, item.workspaceId);
			if (
				!detail || detail.workspace.id !== item.workspaceId
				|| detail.workspace.channelId !== parent.id
			) throw new ChatReferenceError("Referenced research workspace is unavailable.");
			return {
				kind: "research" as const,
				start: item.start,
				end: item.end,
				label: `%${detail.workspace.title}`,
				href: researchWorkspacePath(
					parent.repositoryOwner,
					parent.repositoryName,
					parent.slug,
					detail.workspace.id,
				),
				repositoryId: parent.repositoryId,
				observedRevision: detail.workspace.revision,
				parentChannelId: parent.id,
				workspaceId: detail.workspace.id,
			};
		}));

		let ids = new Set<string>();
		let references = resolved.map(item => {
			let id = this.#id();
			if (!ULID.test(id) || ids.has(id)) throw new ChatReferenceError("Reference id is invalid.");
			ids.add(id);
			return reference({ id, ...item });
		});
		return canonicalMessage(input.text, input.destination, references);
	}

	async read(input: ReadReference): Promise<unknown> {
		let stored = reference(input.reference);
		let parent = await this.#storage.channels.get(input.channelId);
		if (
			!parent || parent.repositoryId !== input.repositoryId
			|| stored.repositoryId !== parent.repositoryId
		) throw new ChatReferenceError("Reference target is unavailable.");

		if (stored.kind === "document") {
			if (stored.channelId === parent.id) throw new ChatReferenceError("Reference target moved.");
			let target = await this.#storage.channels.get(stored.channelId);
			if (!target || target.repositoryId !== parent.repositoryId) {
				throw new ChatReferenceError("Reference target moved or is unavailable.");
			}
			let document = currentDocument(await this.#current(target.id), target.id);
			return {
				untrusted: true,
				kind: stored.kind,
				id: stored.id,
				label: stored.label,
				title: target.title,
				observedRevision: stored.observedRevision,
				observedSourceHash: stored.observedSourceHash,
				currentRevision: document.revision,
				currentSourceHash: document.sourceHash,
				href: documentPath(target.repositoryOwner, target.repositoryName, target.slug),
				changedSinceReference: document.revision !== stored.observedRevision
					|| document.sourceHash !== stored.observedSourceHash,
				source: document.source,
			};
		}

		if (stored.parentChannelId !== parent.id) {
			throw new ChatReferenceError("Reference target moved.");
		}
		let view = await this.#research.read(parent.id, stored.workspaceId);
		if (
			!view || view.workspace.id !== stored.workspaceId
			|| view.workspace.channelId !== stored.parentChannelId
		) throw new ChatReferenceError("Reference target moved or is unavailable.");
		let boundedTurns = researchTurns(view);
		let boundedMessages = researchMessages(view);
		return {
			untrusted: true,
			kind: stored.kind,
			id: stored.id,
			label: stored.label,
			title: view.workspace.title,
			observedRevision: stored.observedRevision,
			currentRevision: view.workspace.revision,
			href: researchWorkspacePath(
				parent.repositoryOwner,
				parent.repositoryName,
				parent.slug,
				view.workspace.id,
			),
			changedSinceReference: view.workspace.revision !== stored.observedRevision,
			workspace: {
				id: view.workspace.id,
				title: view.workspace.title,
				proposedQuestion: view.workspace.proposedQuestion,
				...(view.workspace.confirmedQuery !== undefined
					? { confirmedQuery: view.workspace.confirmedQuery }
					: {}),
				origin: view.workspace.origin,
				revision: view.workspace.revision,
				createdAt: view.workspace.createdAt,
				updatedAt: view.workspace.updatedAt,
			},
			turns: boundedTurns.turns,
			messages: boundedMessages.messages,
			truncation: {
				turns: boundedTurns.truncation,
				messages: boundedMessages.truncation,
			},
		};
	}
}
