/**
 * The plan, as a room offers it.
 *
 * Sits between sockets and the authoritative document: batches incoming
 * updates, decides whether they may be applied, acknowledges the sender and
 * relays to everyone else, and keeps the disk snapshot current.
 *
 * Acknowledgement is the contract worth being careful about. A client is told
 * its update was accepted only once the document has taken it and still
 * validates, because an ack is what lets the client stop holding the bytes.
 */

import * as Y from "yjs";
import { createHash } from "node:crypto";

import { MENTION } from "@chopin/protocol/address";

import * as presence from "./presence";
import * as room from "./room";
import * as Chat from "../chat/service";
import { restoreReferences } from "../chat/references";
import * as Comments from "../comments/service";
import * as Questions from "../questions/service";
import { claim, restore as restoreGraph, restoreRun } from "../tasks/graphs";
import { claimEligibility, restoreLifecycle, transition } from "../tasks/lifecycle";
import { broadcast, fail, relay, reply, tell } from "../wire";

import type { Server } from "bun";
import type { Plan as Wire, Request } from "@chopin/protocol";
import type { Socket, SocketData } from "../wire";
import type { Presence } from "./presence";
import type { Document } from "./room";
import type * as edit from "./edit";
import type { Block } from "./edit";
import type { Brief, CreationOrigin } from "../mcp";
import type { InitialChannel, JsonValue, Lease, StoredChannel } from "../storage/model";
import type { StorageAdapter } from "../storage/port";
import type { ClaimInput, ClaimResult, Graph, Run } from "../tasks/graphs";
import type { Lifecycle, LifecycleInput, LifecycleResult } from "../tasks/lifecycle";

/** Updates are grouped for this long before being applied together. */
const GROUP_MS = 5;

/** Per-connection ceiling, generous enough that typing never reaches it. */
const RATE_LIMIT = 200;
const RATE_WINDOW_MS = 1_000;

/** Invalid batches tolerated from one connection before it is disconnected. */
const INVALID_LIMIT = 3;
const INVALID_WINDOW_MS = 10 * 60 * 1_000;

/** Close code for a client that keeps sending updates the document rejects. */
const ABUSIVE = 4003;

type Queued = {
	ws: Socket;
	rid: string;
	id: string;
	update: Uint8Array;
};

type Meter = {
	/** Timestamps of recent updates, for the rate limit. */
	recent: number[];
	/** Timestamps of recent rejections, for the strike count. */
	invalid: number[];
};

export type Backend = {
	storage: StorageAdapter;
	lease: () => Lease;
	fatal: (error: unknown) => void;
	onDocumentPersisted?: (target: DocumentTarget) => void;
};

export type DocumentTarget = {
	channelId: string;
	revision: number;
	source: string;
	sourceHash: string;
};

/** Durable MCP context for a document created through the hosted surface. */
export type CreationMetadata = {
	brief: Brief;
	origin: CreationOrigin;
};

type Persistence = Backend & {
	channelId: string;
	revision: number;
	sequence: number;
	lastSidecar: string;
	checkpointTimer: ReturnType<typeof setTimeout> | undefined;
	committedEpoch: string;
	committedSource: string;
	committedDocument: Uint8Array;
	committedSidecar: JsonValue;
	closing: boolean;
};

type Captured = {
	revision: number;
	epoch: string;
	source: string;
	sourceHash: string;
	document: Uint8Array;
	sidecar: JsonValue;
	sidecarText: string;
};

export type Plan = {
	id: string;
	/** Context retained for plans created through MCP. */
	creation?: CreationMetadata;
	server: Server<SocketData>;
	document: Document;
	presence: Presence;
	/** Open questionnaires and their shared answer drafts. */
	questions: Questions.Questions;
	/** Resolutions in flight and who is typing. Nothing durable. */
	comments: Comments.Threads;
	/** The conversation driving the agent. */
	chat: Chat.Chat;
	/**
	 * Every questionnaire this plan has ever held, answered or not.
	 *
	 * Kept beside the document rather than in it: the plan shows a decision,
	 * this owns it. An agent rewriting the prose cannot change what was decided.
	 */
	records: Map<string, Questions.Record>;
	/**
	 * Every comment thread this plan has ever held.
	 *
	 * Beside the document for the same reason a questionnaire record is: a
	 * comment must not be undoable with the plan, and the agent must not be
	 * able to rewrite what somebody said about its work.
	 */
	threads: Map<string, Comments.Record>;
	/** Bumped on every committed change; the agent's concurrency token. */
	revision: number;
	/** Implementation work, stored beside rather than inside the plan. */
	graph?: Graph;
	/** The external implementation run that freezes this plan. */
	execution?: Run;
	/** Mutable task progress and prior runs, separate from claim identity. */
	lifecycle: Lifecycle;
	/** A claim has closed mutation ingress while accepted work drains. */
	claiming: boolean;
	/**
	 * Block outlines by revision.
	 *
	 * Kept so a batch aimed at a revision that has moved can be told which
	 * blocks moved, rather than only that it is too late.
	 */
	outlines: Map<number, Block[]>;
	queue: Queued[];
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Repeats the agent's cursor while it has one, so peers do not drop it. */
	attention: ReturnType<typeof setInterval> | undefined;
	/** Serialises commits so two batches cannot interleave. */
	flushing: Promise<void>;
	meters: WeakMap<Socket, Meter>;
	persistence: Persistence;
};

function decode(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "base64"));
}

function encode(value: Uint8Array): string {
	return Buffer.from(value).toString("base64");
}

function recent(stamps: number[], window: number): number[] {
	let cutoff = Date.now() - window;
	return stamps.filter(at => at > cutoff);
}

type Sidecar = {
	version: 1;
	revision: number;
	documentSeq: number;
	creation?: CreationMetadata;
	graph?: Graph;
	execution?: Run;
	lifecycle?: Lifecycle;
	questions: Questions.Record[];
	openQuestions: Questions.StoredOpen[];
	threads: Comments.Record[];
	transcript: Chat.Chat["entries"];
};

function state(plan: Plan): Sidecar {
	return {
		version: 1,
		revision: plan.revision,
		documentSeq: plan.document.seq,
		...(plan.creation ? { creation: plan.creation } : {}),
		...(plan.graph ? { graph: plan.graph } : {}),
		...(plan.execution ? { execution: plan.execution } : {}),
		...(plan.lifecycle.events?.length || plan.lifecycle.history.length > 0
			? { lifecycle: plan.lifecycle }
			: {}),
		questions: [...plan.records.values()],
		openQuestions: Questions.dump(plan.questions),
		threads: [...plan.threads.values()],
		transcript: plan.chat.entries,
	};
}

function jsonState(plan: Plan): { value: JsonValue; text: string } {
	let text = JSON.stringify(state(plan));
	return { value: JSON.parse(text) as JsonValue, text };
}

function capture(plan: Plan): Captured {
	let sidecar = jsonState(plan);
	let source = room.project(plan.document);
	return {
		revision: plan.revision,
		epoch: plan.document.epoch,
		source,
		sourceHash: sourceHash(source),
		document: Y.encodeStateAsUpdate(plan.document.doc),
		sidecar: sidecar.value,
		sidecarText: sidecar.text,
	};
}

function objects(value: JsonValue[], label: string): Array<Record<string, JsonValue>> {
	let seen = new Set<string>();
	return value.map(entry => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`hosted channel has an invalid ${label}`);
		}
		let item = entry as Record<string, JsonValue>;
		if (typeof item.id !== "string" || !item.id || seen.has(item.id)) {
			throw new Error(`hosted channel has an invalid or duplicate ${label} id`);
		}
		seen.add(item.id);
		return item;
	});
}

function strings(value: JsonValue | undefined): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string")
		? value
		: undefined;
}

function creation(value: JsonValue | undefined): CreationMetadata | undefined {
	if (value === undefined) return undefined;
	if (
		!value
		|| typeof value !== "object"
		|| Array.isArray(value)
	) throw new Error("hosted channel has invalid creation metadata");
	let metadata = value as Record<string, JsonValue>;
	if (
		Object.keys(metadata).length !== 2
		|| !Object.hasOwn(metadata, "brief")
		|| !Object.hasOwn(metadata, "origin")
		|| !metadata.brief
		|| typeof metadata.brief !== "object"
		|| Array.isArray(metadata.brief)
		|| !metadata.origin
		|| typeof metadata.origin !== "object"
		|| Array.isArray(metadata.origin)
	) throw new Error("hosted channel has invalid creation metadata");
	let brief = metadata.brief as Record<string, JsonValue>;
	let origin = metadata.origin as Record<string, JsonValue>;
	let briefKeys = [
		"constraints",
		"goal",
		"openQuestions",
		"repositoryFindings",
		"settledDecisions",
	];
	let originKeys = [
		"baseBranch",
		"baseCommit",
		"fingerprint",
		"idempotencyKey",
		"repository",
		"title",
	];
	let constraints = strings(brief.constraints);
	let settledDecisions = strings(brief.settledDecisions);
	let openQuestions = strings(brief.openQuestions);
	let repositoryFindings = strings(brief.repositoryFindings);
	if (
		Object.keys(brief).sort().some((key, index) => key !== briefKeys[index])
		|| Object.keys(brief).length !== briefKeys.length
		|| typeof brief.goal !== "string"
		|| !brief.goal.trim()
		|| !constraints
		|| !settledDecisions
		|| !openQuestions
		|| !repositoryFindings
		|| Object.keys(origin).sort().some((key, index) => key !== originKeys[index])
		|| Object.keys(origin).length !== originKeys.length
		|| originKeys.some(key => typeof origin[key] !== "string" || !origin[key].trim())
	) throw new Error("hosted channel has invalid creation metadata");
	return {
		brief: {
			goal: brief.goal,
			constraints,
			settledDecisions,
			openQuestions,
			repositoryFindings,
		},
		origin: origin as CreationOrigin,
	};
}

function legacyCreation(
	brief: JsonValue | undefined,
	origin: JsonValue | undefined,
): CreationMetadata | undefined {
	if (brief === undefined && origin === undefined) return undefined;
	if (brief === undefined || origin === undefined) {
		throw new Error("hosted channel has invalid creation metadata");
	}
	return creation({ brief, origin });
}

function restoredState(
	value: JsonValue,
	pristine: boolean,
	scope?: { channelId: string; repositoryId: string },
): Sidecar {
	if (value === null && pristine) {
		return {
			version: 1,
			revision: 0,
			documentSeq: 0,
			questions: [],
			openQuestions: [],
			threads: [],
			transcript: [],
		};
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("hosted channel has an invalid sidecar");
	}
	let item = value as Record<string, JsonValue>;
	let keys = Object.keys(item).sort();
	let legacy = item.creation === undefined
		&& (item.brief !== undefined || item.origin !== undefined);
	let created = item.creation === undefined
		? legacyCreation(item.brief, item.origin)
		: creation(item.creation);
	let graph = restoreGraph(item.graph);
	let expected = [
		"documentSeq",
		"openQuestions",
		"questions",
		"revision",
		"threads",
		"transcript",
		"version",
	];
	if (created) expected.push(...(legacy ? ["brief", "origin"] : ["creation"]));
	if (Object.hasOwn(item, "graph")) expected.push("graph");
	if (Object.hasOwn(item, "execution")) expected.push("execution");
	if (Object.hasOwn(item, "lifecycle")) expected.push("lifecycle");
	expected.sort();
	if (
		keys.length !== expected.length
		|| keys.some((key, index) => key !== expected[index])
		|| item.version !== 1
		|| typeof item.revision !== "number"
		|| !Number.isSafeInteger(item.revision)
		|| item.revision < 0
		|| typeof item.documentSeq !== "number"
		|| !Number.isSafeInteger(item.documentSeq)
		|| item.documentSeq < 0
		|| !Array.isArray(item.questions)
		|| !Array.isArray(item.openQuestions)
		|| !Array.isArray(item.threads)
		|| !Array.isArray(item.transcript)
	) throw new Error("hosted channel has an invalid sidecar");
	let execution = Object.hasOwn(item, "execution")
		? restoreRun(item.execution, graph, item.revision)
		: undefined;
	if (Object.hasOwn(item, "execution") && !execution) {
		throw new Error("hosted channel has an invalid implementation run");
	}
	let hasLifecycle = Object.hasOwn(item, "lifecycle");
	let restoredLifecycle = graph
		? restoreLifecycle(hasLifecycle ? item.lifecycle : { history: [] }, graph, execution)
		: undefined;
	if (graph && !restoredLifecycle || hasLifecycle && !graph) {
		throw new Error("hosted channel has an invalid implementation lifecycle");
	}
	let lifecycle = hasLifecycle ? restoredLifecycle : undefined;
	let questions = objects(item.questions, "question record");
	for (let question of questions) {
		if (
			(question.status !== "open" && question.status !== "answered"
				&& question.status !== "cancelled")
			|| !question.definition
			|| typeof question.definition !== "object"
			|| Array.isArray(question.definition)
		) throw new Error("hosted channel has an invalid question record");
	}
	let openQuestions = objects(item.openQuestions, "open questionnaire");
	let openIds = new Set(openQuestions.map(entry => entry.id as string));
	if (questions.some(record => (record.status === "open") !== openIds.has(record.id as string))) {
		throw new Error("hosted channel question records disagree with their drafts");
	}
	let threads = objects(item.threads, "comment thread");
	for (let thread of threads) {
		if (
			(thread.status !== "open" && thread.status !== "accepted" && thread.status !== "dismissed")
			|| !thread.passage
			|| typeof thread.passage !== "object"
			|| Array.isArray(thread.passage)
			|| !Array.isArray(thread.notes)
		) throw new Error("hosted channel has an invalid comment thread");
	}
	let transcript = objects(item.transcript, "transcript entry");
	let referenceIds = new Set<string>();
	for (let entry of transcript) {
		if (
			typeof entry.text !== "string"
			|| typeof entry.ts !== "number"
			|| !entry.author
			|| typeof entry.author !== "object"
			|| Array.isArray(entry.author)
		) throw new Error("hosted channel has an invalid transcript entry");
		if (Object.hasOwn(entry, "references")) {
			let author = entry.author as Record<string, JsonValue>;
			if (author.kind !== "member") {
				throw new Error("hosted channel has a non-member transcript reference");
			}
			try {
				entry.references = restoreReferences(
					entry.references,
					entry.text,
					referenceIds,
					scope,
				) as never;
			} catch (err) {
				throw new Error("hosted channel has an invalid transcript reference", { cause: err });
			}
		}
		try {
			Chat.validateDelivery(entry as unknown as Chat.Chat["entries"][number]);
		} catch (err) {
			throw new Error("hosted channel has invalid chat delivery metadata", { cause: err });
		}
	}
	return {
		version: 1,
		revision: item.revision,
		documentSeq: item.documentSeq,
		...(created ? { creation: created } : {}),
		...(graph ? { graph } : {}),
		...(execution ? { execution } : {}),
		...(lifecycle ? { lifecycle } : {}),
		questions: questions as never[],
		openQuestions: openQuestions as unknown as Questions.StoredOpen[],
		threads: threads as never[],
		transcript: transcript as unknown as Chat.Chat["entries"],
	};
}

export function sourceHash(source: string): string {
	return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

/** Build the complete revision-zero state published with a newly created channel. */
export async function initial(
	source: string,
	creation: CreationMetadata,
): Promise<InitialChannel> {
	let document = await room.create(source);
	try {
		let canonical = room.project(document);
		let sidecar: Sidecar = {
			version: 1,
			revision: 0,
			documentSeq: document.seq,
			creation,
			questions: [],
			openQuestions: [],
			threads: [],
			transcript: [],
		};
		return {
			generation: crypto.randomUUID(),
			epoch: document.epoch,
			source: canonical,
			sourceHash: sourceHash(canonical),
			document: Y.encodeStateAsUpdate(document.doc),
			sidecar: JSON.parse(JSON.stringify(sidecar)) as JsonValue,
		};
	} finally {
		document.doc.destroy();
	}
}

function scheduleCheckpoint(plan: Plan): void {
	let durable = plan.persistence;
	if (durable.closing || durable.checkpointTimer) return;
	durable.checkpointTimer = setTimeout(() => {
		durable.checkpointTimer = undefined;
		let checkpoint = () => checkpointHosted(plan);
		plan.flushing = plan.flushing.then(checkpoint, checkpoint);
	}, 500);
}

async function commitHosted(
	plan: Plan,
	update: Uint8Array | undefined,
	operationId: string,
	captured: Captured,
): Promise<void> {
	let durable = plan.persistence;
	if (!update && captured.sidecarText === durable.lastSidecar) {
		scheduleCheckpoint(plan);
		return;
	}
	try {
		let sourceChanged = captured.source !== durable.committedSource;
		let result = await durable.storage.collaboration.commit({
			channelId: durable.channelId,
			lease: durable.lease(),
			expectedRevision: durable.revision,
			operationId,
			epoch: captured.epoch,
			...(update ? { update } : {}),
			sidecar: captured.sidecar,
			events: [],
			now: new Date(),
		});
		if (!result.repeated) {
			durable.revision = result.revision;
			durable.sequence = result.sequence;
		}
		if (result.repeated && captured.sidecarText !== durable.lastSidecar) {
			let stateResult = await durable.storage.collaboration.commit({
				channelId: durable.channelId,
				lease: durable.lease(),
				expectedRevision: durable.revision,
				operationId: `state:${crypto.randomUUID()}`,
				epoch: captured.epoch,
				sidecar: captured.sidecar,
				events: [],
				now: new Date(),
			});
			durable.revision = stateResult.revision;
			durable.sequence = stateResult.sequence;
		}
		durable.lastSidecar = captured.sidecarText;
		durable.committedEpoch = captured.epoch;
		durable.committedSource = captured.source;
		durable.committedDocument = captured.document;
		durable.committedSidecar = captured.sidecar;
		if (plan.document.epoch === captured.epoch) {
			plan.document.checkpoint = new Uint8Array(captured.document);
		}
		if (update && sourceChanged && durable.onDocumentPersisted) {
			try {
				durable.onDocumentPersisted({
					channelId: durable.channelId,
					revision: captured.revision,
					source: captured.source,
					sourceHash: captured.sourceHash,
				});
			} catch (err) {
				console.warn(`[plan] could not schedule derived work for ${durable.channelId}:`, err);
			}
		}
		scheduleCheckpoint(plan);
	} catch (err) {
		durable.fatal(err);
		throw err;
	}
}

async function checkpointHosted(plan: Plan): Promise<void> {
	let durable = plan.persistence;
	try {
		await durable.storage.collaboration.checkpoint({
			channelId: durable.channelId,
			lease: durable.lease(),
			expectedRevision: durable.revision,
			generation: crypto.randomUUID(),
			revision: durable.revision,
			throughSequence: durable.sequence,
			epoch: durable.committedEpoch,
			source: durable.committedSource,
			sourceHash: sourceHash(durable.committedSource),
			document: durable.committedDocument,
			sidecar: durable.committedSidecar,
			createdAt: new Date(),
		});
		plan.document.checkpoint = new Uint8Array(durable.committedDocument);
	} catch (err) {
		durable.fatal(err);
		throw err;
	}
}

async function replaceHosted(plan: Plan, operationId: string, captured: Captured): Promise<void> {
	let durable = plan.persistence;
	try {
		let result = await durable.storage.collaboration.replace({
			channelId: durable.channelId,
			lease: durable.lease(),
			expectedRevision: durable.revision,
			operationId,
			generation: crypto.randomUUID(),
			epoch: captured.epoch,
			source: captured.source,
			sourceHash: sourceHash(captured.source),
			document: captured.document,
			sidecar: captured.sidecar,
			now: new Date(),
		});
		if (!result.repeated) {
			durable.revision = result.revision;
			durable.sequence = result.sequence;
		}
		durable.lastSidecar = captured.sidecarText;
		durable.committedEpoch = captured.epoch;
		durable.committedSource = captured.source;
		durable.committedDocument = captured.document;
		durable.committedSidecar = captured.sidecar;
		plan.document.checkpoint = new Uint8Array(captured.document);
		if (durable.checkpointTimer) clearTimeout(durable.checkpointTimer);
		durable.checkpointTimer = undefined;
	} catch (err) {
		durable.fatal(err);
		throw err;
	}
}

/** Persist a sidecar-only state transition. */
export function persist(plan: Plan): Promise<void> {
	let captured = capture(plan);
	let commit = () => commitHosted(plan, undefined, `state:${crypto.randomUUID()}`, captured);
	let pending = plan.flushing.then(commit, commit);
	plan.flushing = pending;
	return pending;
}

/** Reserve the same queue used by client batches for one complete server operation. */
export function exclusive<T>(plan: Plan, action: () => Promise<T>): Promise<T> {
	let operation = plan.flushing.then(action, action);
	plan.flushing = operation.then(() => {}, () => {});
	return operation;
}

/** Read one canonical document target in the same queue as live mutations. */
export function readCurrentDocument(plan: Plan): Promise<DocumentTarget> {
	return exclusive(plan, async () => {
		let source = room.project(plan.document);
		return {
			channelId: plan.id,
			revision: plan.revision,
			source,
			sourceHash: sourceHash(source),
		};
	});
}

/** Drain mutations already admitted before a claim closes the plan to new work. */
export async function drain(plan: Plan): Promise<void> {
	if (plan.timer) clearTimeout(plan.timer);
	plan.timer = undefined;
	let pending = () => commit(plan);
	plan.flushing = plan.flushing.then(pending, pending);
	await plan.flushing;
}

/** One gate for every path that can mutate a plan during implementation. */
export function implementationActive(plan: Plan): boolean {
	return plan.claiming || !!plan.execution;
}

/** Sidecar-only commit for a caller already holding `exclusive`. */
export function persistExclusive(plan: Plan): Promise<void> {
	return commitHosted(plan, undefined, `state:${crypto.randomUUID()}`, capture(plan));
}

type RestoredHosted = {
	document: Document;
	needsInitialCheckpoint: boolean;
	sidecar: Sidecar;
};

/** Prepare the sidecar half of one atomic claim for a plan that is not live. */
export function claimStored(
	loaded: StoredChannel,
	input: ClaimInput,
): { result: ClaimResult; sidecar?: JsonValue } {
	let pristine = loaded.channel.revision === 0 && loaded.latestSequence === 0 && !loaded.snapshot;
	let sidecar = restoredState(
		loaded.sidecar === null && loaded.snapshot && loaded.channel.revision === 0
			? loaded.snapshot.sidecar
			: loaded.sidecar,
		pristine,
		{ channelId: loaded.channel.id, repositoryId: loaded.channel.repositoryId },
	);
	let version = sidecar.graph?.versions.at(-1);
	let eligibility = version
		&& claimEligibility(sidecar.lifecycle ?? { history: [] }, version, input.run.id);
	if (eligibility && !eligibility.ok) {
		return { result: { kind: "refused", reason: eligibility.reason } };
	}
	let result = claim({
		graph: sidecar.graph,
		revision: sidecar.revision,
		execution: sidecar.execution,
	}, input);
	if (result.kind !== "started") return { result };
	return {
		result,
		sidecar: JSON.parse(JSON.stringify({
			...sidecar,
			graph: result.graph,
			execution: result.run,
		})) as JsonValue,
	};
}

/** Prepare one atomic lifecycle sidecar change for a plan that is not live. */
export function lifecycleStored(
	loaded: StoredChannel,
	input: LifecycleInput,
): { result: LifecycleResult; sidecar?: JsonValue } {
	let pristine = loaded.channel.revision === 0 && loaded.latestSequence === 0 && !loaded.snapshot;
	let sidecar = restoredState(
		loaded.sidecar === null && loaded.snapshot && loaded.channel.revision === 0
			? loaded.snapshot.sidecar
			: loaded.sidecar,
		pristine,
		{ channelId: loaded.channel.id, repositoryId: loaded.channel.repositoryId },
	);
	if (!sidecar.graph) return { result: { kind: "refused", reason: "inactive" } };
	let result = transition({
		graph: sidecar.graph,
		execution: sidecar.execution,
		lifecycle: sidecar.lifecycle ?? { history: [] },
	}, input);
	if (result.kind !== "accepted") return { result };
	let { graph: _graph, execution: _execution, lifecycle: _lifecycle, ...rest } = sidecar;
	return {
		result,
		sidecar: JSON.parse(JSON.stringify({
			...rest,
			graph: result.state.graph,
			...(result.state.execution ? { execution: result.state.execution } : {}),
			lifecycle: result.state.lifecycle,
		})) as JsonValue,
	};
}

async function restoreHosted(id: string, loaded: StoredChannel): Promise<RestoredHosted> {
	let document: Document;
	let needsInitialCheckpoint = false;
	let pristine = loaded.channel.revision === 0
		&& loaded.latestSequence === 0
		&& !loaded.snapshot;
	let sidecar = restoredState(
		loaded.sidecar === null && loaded.snapshot && loaded.channel.revision === 0
			? loaded.snapshot.sidecar
			: loaded.sidecar,
		pristine,
		{ channelId: loaded.channel.id, repositoryId: loaded.channel.repositoryId },
	);
	if (loaded.snapshot) {
		if (
			loaded.snapshot.revision > loaded.channel.revision
			|| loaded.snapshot.throughSequence > loaded.latestSequence
		) throw new Error(`channel ${id} has an invalid checkpoint position`);
		let previous = loaded.snapshot.throughSequence;
		for (let update of loaded.updates) {
			if (
				update.sequence <= previous
				|| update.sequence > loaded.latestSequence
				|| update.revision > loaded.channel.revision
				|| update.epoch !== loaded.snapshot.epoch
			) throw new Error(`channel ${id} has an invalid update journal`);
			previous = update.sequence;
		}
		if (sourceHash(loaded.snapshot.source) !== loaded.snapshot.sourceHash) {
			throw new Error(`channel ${id} has a corrupt source hash`);
		}
		document = await room.restore(
			loaded.snapshot.epoch,
			loaded.snapshot.document,
			loaded.snapshot.source,
			loaded.updates.map(update => ({ epoch: update.epoch, update: update.update })),
		);
	} else {
		if (loaded.updates.length > 0) {
			throw new Error(`channel ${id} has updates without a checkpoint`);
		}
		document = await room.create();
		needsInitialCheckpoint = true;
	}
	document.seq = sidecar.documentSeq;
	return { document, needsInitialCheckpoint, sidecar };
}

/** Project a closed channel without attaching it to the live room registry. */
export async function readStored(
	loaded: StoredChannel,
): Promise<{
	source: string;
	revision: number;
	creation?: CreationMetadata;
	graph?: Graph;
	execution?: Run;
	lifecycle?: Lifecycle;
}> {
	let restored = await restoreHosted(loaded.channel.id, loaded);
	try {
		Questions.shutdown(Questions.restore(restored.sidecar.openQuestions));
		return {
			source: room.project(restored.document),
			revision: restored.sidecar.revision,
			...(restored.sidecar.creation ? { creation: restored.sidecar.creation } : {}),
			...(restored.sidecar.graph ? { graph: restored.sidecar.graph } : {}),
			...(restored.sidecar.execution ? { execution: restored.sidecar.execution } : {}),
			...(restored.sidecar.lifecycle ? { lifecycle: restored.sidecar.lifecycle } : {}),
		};
	} finally {
		restored.document.doc.destroy();
	}
}

/** Restore one durable channel into its authoritative in-memory document. */
export async function open(
	id: string,
	backend: Backend,
	server: Server<SocketData>,
): Promise<Plan> {
	let loaded = await backend.storage.collaboration.load(id, new Date());
	if (!loaded) throw new Error(`channel ${id} does not exist`);
	let { document, needsInitialCheckpoint, sidecar } = await restoreHosted(id, loaded);

	let plan: Plan = {
		id,
		...(sidecar.creation ? { creation: sidecar.creation } : {}),
		server,
		document,
		presence: presence.create(),
		questions: Questions.restore(sidecar.openQuestions),
		comments: Comments.create(),
		chat: Chat.restore(sidecar.transcript),
		outlines: new Map(),
		records: new Map(sidecar.questions.map(record => [record.id, record])),
		threads: new Map(sidecar.threads.map(record => [record.id, record])),
		revision: sidecar.revision,
		graph: sidecar.graph,
		execution: sidecar.execution,
		lifecycle: sidecar.lifecycle ?? { history: [] },
		claiming: false,
		queue: [],
		timer: undefined,
		attention: undefined,
		flushing: Promise.resolve(),
		meters: new WeakMap(),
		persistence: undefined as unknown as Persistence,
	};

	let committed = capture(plan);
	plan.persistence = {
		...backend,
		channelId: id,
		revision: loaded.channel.revision,
		sequence: loaded.latestSequence,
		lastSidecar: committed.sidecarText,
		checkpointTimer: undefined,
		committedEpoch: committed.epoch,
		committedSource: committed.source,
		committedDocument: committed.document,
		committedSidecar: committed.sidecar,
		closing: false,
	};
	if (needsInitialCheckpoint) await checkpointHosted(plan);

	// Guarded because this is the last thing between a channel and being open. A
	// plan whose highlights are stale is worth having; one that refuses to open
	// because a decision could not be placed is not.
	try {
		Questions.rebase(plan);
		Comments.rebase(plan);
	} catch (err) {
		console.error(`[plan] could not carry anchors into ${id}:`, err);
	}

	return plan;
}

/** Cheap identity of the whole relationship snapshot, for spotting a change. */
function signature(plan: Plan): string {
	return JSON.stringify([Questions.anchors(plan), Comments.anchors(plan)]);
}

/** Everything a joining client needs to start from. */
export function greet(plan: Plan, ws: Socket, msg: Request<Wire.Open.Ask>): void {
	let resume = msg.epoch === plan.document.epoch && msg.vector ? decode(msg.vector) : undefined;
	let hello = presence.snapshot(plan.presence);

	reply(ws, msg.rid, {
		kind: "plan:open",
		ts: 0,
		epoch: plan.document.epoch,
		seq: plan.document.seq,
		update: encode(room.sync(plan.document, resume)),
		revision: plan.revision,
		anchors: Questions.anchors(plan),
		threads: Comments.anchors(plan),
		limits: room.LIMITS,
		...(hello ? { awareness: encode(hello) } : {}),
	});
}

function meter(plan: Plan, ws: Socket): Meter {
	let existing = plan.meters.get(ws);
	if (existing) return existing;
	let created: Meter = { recent: [], invalid: [] };
	plan.meters.set(ws, created);
	return created;
}

/** Accept an update for the next batch, or say why not. */
export function submit(plan: Plan, ws: Socket, msg: Request<Wire.Submit>): void {
	if (implementationActive(plan)) return fail(ws, msg.rid, "implementation is active");
	if (msg.epoch !== plan.document.epoch) {
		// Nothing to correct: the client is describing a history that no longer
		// exists and needs to re-open, which the reset already told it to do.
		return;
	}

	let update = decode(msg.update);
	if (update.byteLength > room.LIMITS.update) {
		return tell(ws, {
			kind: "plan:reset",
			ts: 0,
			epoch: plan.document.epoch,
			reason: "rebuilt",
		});
	}

	let gauge = meter(plan, ws);
	gauge.recent = recent(gauge.recent, RATE_WINDOW_MS);
	if (gauge.recent.length >= RATE_LIMIT) return;
	gauge.recent.push(Date.now());

	plan.queue.push({ ws, rid: msg.rid, id: msg.id, update });
	schedule(plan);
}

function schedule(plan: Plan): void {
	if (plan.timer) return;
	plan.timer = setTimeout(() => {
		plan.timer = undefined;
		plan.flushing = plan.flushing.then(() => commit(plan), () => commit(plan));
	}, GROUP_MS);
}

/**
 * Apply one batch.
 *
 * On rejection the document is rebuilt from its last known-good state and
 * everyone re-opens. Yjs cannot undo a transaction, so there is no narrower
 * remedy — which is why the senders in the batch are the ones charged for it.
 */
async function commit(plan: Plan): Promise<void> {
	let batch = plan.queue;
	if (batch.length === 0) return;
	plan.queue = [];

	let outcome = await room.apply(plan.document, batch.map(item => item.update));

	if (!outcome.ok) {
		console.warn("[plan] rejected batch:", outcome.issues.join(", "));

		let now = Date.now();
		for (let item of batch) {
			let gauge = meter(plan, item.ws);
			gauge.invalid = [...recent(gauge.invalid, INVALID_WINDOW_MS), now];
			if (gauge.invalid.length >= INVALID_LIMIT) {
				item.ws.close(ABUSIVE, "repeated invalid plan updates");
			}
		}

		let rebuilt = await room.rebuild(plan.document);
		plan.document = rebuilt;
		// Cursors describe positions in a history that no longer exists. The
		// agent's is in there too, and the interval repeating it would outlive
		// the presence it repeats.
		clearInterval(plan.attention);
		plan.attention = undefined;
		presence.destroy(plan.presence);
		plan.presence = presence.create();
		// So do anchors and passages, and unlike a cursor nobody re-announces
		// them. Without this every highlight in the room stays dark until the
		// agent happens to edit.
		//
		// Guarded because the `plan:reset` below is what tells everyone to
		// re-open. A throw here would strand the whole room on an epoch that no
		// longer exists, to save some highlights that are already stale.
		try {
			Questions.rebase(plan);
			Comments.rebase(plan);
		} catch (err) {
			console.error("[plan] could not carry anchors onto the rebuilt document:", err);
		}
		await replaceHosted(plan, `epoch:${rebuilt.epoch}`, capture(plan));

		broadcast(plan.server, plan.id, {
			kind: "plan:reset",
			ts: 0,
			epoch: rebuilt.epoch,
			reason: "rebuilt",
		});
		return;
	}

	let relationshipsChanged = false;
	let before = signature(plan);
	try {
		Questions.rebase(plan);
		Comments.rebase(plan);
		relationshipsChanged = signature(plan) !== before;
	} catch (err) {
		console.error("[plan] could not carry anchors forward:", err);
	}
	if (room.project(plan.document) !== plan.persistence.committedSource) plan.revision++;
	let merged = Y.mergeUpdates(batch.map(item => item.update));
	let operationId = `plan:${plan.document.epoch}:${
		createHash("sha256").update(merged).digest("hex")
	}`;
	await commitHosted(plan, merged, operationId, capture(plan));

	for (let item of batch) {
		reply(item.ws, item.rid, {
			kind: "plan:ack",
			ts: 0,
			epoch: plan.document.epoch,
			id: item.id,
			seq: outcome.seq,
		});
		// Peers need the bytes; the sender already applied them locally.
		relay(item.ws, {
			kind: "plan:update",
			ts: 0,
			epoch: plan.document.epoch,
			update: encode(item.update),
			seq: outcome.seq,
		});
	}

	if (relationshipsChanged) anchors(plan, plan.server, plan.id);
}

/**
 * Relay a change the server made, as an ordinary update.
 *
 * Agent edits and answer projections reach clients the same way a keystroke
 * does: as a delta against the document they already hold. That is what keeps
 * an agent rewriting a paragraph from costing everybody else their cursor.
 */
export async function publish(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	mutation: { update: Uint8Array; source: string },
): Promise<void> {
	if (implementationActive(plan)) throw new Error("implementation is active");
	plan.document.seq++;
	if (room.project(plan.document) !== plan.persistence.committedSource) plan.revision++;
	let operationId = `server:${plan.document.epoch}:${
		createHash("sha256").update(mutation.update).digest("hex")
	}`;
	await commitHosted(plan, mutation.update, operationId, capture(plan));
	try {
		broadcast(server, roomId, {
			kind: "plan:update",
			ts: 0,
			epoch: plan.document.epoch,
			update: encode(mutation.update),
			seq: plan.document.seq,
		});
	} catch (err) {
		console.error("[plan] could not broadcast a persisted update:", err);
	}
}

/**
 * Relay what the agent just did, so a reader can be shown where.
 *
 * Indices become anchors here rather than in the edit engine: only the live
 * document can say where a block is in the collaborative history, and only
 * these survive somebody else editing between this frame being sent and the
 * browser painting it.
 *
 * Sent after the update that created the blocks it names, which is what makes
 * it resolvable at the other end. Guarded whole, and silent on failure: this
 * is decoration, and a room that dropped an edit over a mark nobody would
 * have noticed would be a poor trade.
 */
export function changes(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	found: edit.Change[],
): void {
	if (found.length === 0) return;

	try {
		let digests = room.digests(plan.document);
		let anchor = (index: number): Wire.Anchor | undefined => {
			let digest = digests[index];
			return digest === undefined ? undefined : room.anchorAt(plan.document, index, digest);
		};
		let gap = (spot: edit.Spot): Wire.Gap | undefined => {
			let at = anchor(spot.index);
			return at && { at, side: spot.side };
		};

		let wired: Wire.Change[] = [];
		// The furthest down the plan this batch reached, of what could be
		// anchored — where the agent leaves its cursor.
		let last: number | undefined;

		for (let change of found) {
			if (change.kind === "removed") {
				let at = gap(change.at);
				if (at) {
					wired.push({ kind: "removed", at, blocks: change.blocks });
					last = change.at.index;
				}
				continue;
			}

			let at = anchor(change.index);
			if (!at) continue;
			if (change.kind === "added") {
				wired.push({ kind: "added", at, type: change.type, preview: change.preview });
				last = change.index;
				continue;
			}

			// Both ends or neither: a move shown only where it landed reads as
			// new prose, and shown only where it left reads as a deletion.
			let from = gap(change.from);
			if (from) {
				wired.push({ kind: "moved", at, from, type: change.type, preview: change.preview });
				last = change.index;
			}
		}

		if (wired.length === 0) return;
		broadcast(server, roomId, {
			kind: "plan:changes",
			ts: 0,
			epoch: plan.document.epoch,
			changes: wired,
		});

		// Read off the same pass, deliberately. Working it out separately could
		// disagree, and then the cursor would point at one block while the
		// marks described another.
		if (last !== undefined) attend(plan, server, roomId, last);
	} catch (err) {
		console.error("[plan] could not say what the agent changed:", err);
	}
}

/** Relay the current relationship snapshot to the whole room. */
export function anchors(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
): void {
	broadcast(server, roomId, {
		kind: "plan:anchors",
		ts: 0,
		epoch: plan.document.epoch,
		widgets: Questions.anchors(plan),
		threads: Comments.anchors(plan),
	});
}

/**
 * How often to repeat the agent's cursor.
 *
 * Comfortably inside the thirty seconds after which a peer drops a state it
 * has not heard about. Ours rather than the awareness library's, because a
 * cursor that quietly disappears partway through a long turn is not a failure
 * anybody would think to attribute to a renewal cadence changing underneath.
 */
const RENEW_MS = 10_000;

/**
 * The colour of the agent's cursor.
 *
 * A graphite, deliberately outside the palette `packages/editor/src/cursor.ts`
 * hands to people: the agent is not one of them, and a cursor that looked like
 * a colleague's would be read as one. Literal rather than a theme token
 * because Lexical validates it with `CSS.supports` and writes it inline, so a
 * `var()` would resolve against the wrong scope or not at all.
 *
 * Duplicated across the package boundary rather than shared for one string. If
 * the palette there ever grows a slate, this is what it must not collide with.
 */
const AGENT_COLOR = "#475569";

/**
 * Put the agent's cursor where it just edited.
 *
 * Presence rather than a record: it says the agent is working here now, which
 * is why it is broadcast rather than held, and why it does not wait to be
 * seen the way the marks do. Somebody scrolled elsewhere is not shown it at
 * all — that is what the marks and the chips are for.
 */
function attend(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	block: number,
): void {
	// The last turn may still be counting down to taking the cursor away. It is
	// about to be somewhere new, so that removal is no longer the truth.
	clearTimeout(plan.chat.lingering);
	plan.chat.lingering = undefined;

	let position = room.endOf(plan.document, block);
	let update = presence.attend(plan.presence, {
		name: MENTION.slice(1),
		color: AGENT_COLOR,
		focusing: true,
		agent: true,
		anchorPos: position,
		focusPos: position,
		awarenessData: {},
	});

	broadcast(server, roomId, {
		kind: "plan:awareness",
		ts: 0,
		epoch: plan.document.epoch,
		update: encode(update),
	});

	// Restarted, not stacked: an agent that edits twice in a turn should not
	// end up with two intervals repeating its cursor.
	clearInterval(plan.attention);
	plan.attention = setInterval(() => {
		let renewed = presence.renew(plan.presence);
		if (!renewed) return;
		broadcast(server, roomId, {
			kind: "plan:awareness",
			ts: 0,
			epoch: plan.document.epoch,
			update: encode(renewed),
		});
	}, RENEW_MS);
}

/** Take the agent's cursor down, and stop repeating it. */
export function release(plan: Plan, server: Server<SocketData>, roomId: string): void {
	clearInterval(plan.attention);
	plan.attention = undefined;

	let update = presence.release(plan.presence);
	if (!update) return;

	broadcast(server, roomId, {
		kind: "plan:awareness",
		ts: 0,
		epoch: plan.document.epoch,
		update: encode(update),
	});
}

/** Relay presence verbatim, and remember it for whoever joins next. */
export function awareness(plan: Plan, ws: Socket, msg: Wire.Awareness): void {
	if (msg.epoch !== plan.document.epoch) return;
	presence.track(plan.presence, ws, decode(msg.update));
	relay(ws, { kind: "plan:awareness", ts: 0, epoch: plan.document.epoch, update: msg.update });
}

/** Clear a departed member's cursors rather than leaving peers to time them out. */
export function departed(plan: Plan, ws: Socket): void {
	let update = presence.drop(plan.presence, ws);
	if (!update) return;
	relay(ws, {
		kind: "plan:awareness",
		ts: 0,
		epoch: plan.document.epoch,
		update: encode(update),
	});
}

/** Write anything outstanding and let go. */
export async function close(plan: Plan): Promise<void> {
	if (plan.timer) clearTimeout(plan.timer);
	clearInterval(plan.attention);
	let persistence = plan.persistence;
	persistence.closing = true;
	if (persistence.checkpointTimer) clearTimeout(persistence.checkpointTimer);
	persistence.checkpointTimer = undefined;
	await Chat.close(plan.chat);
	await plan.flushing;
	await commitHosted(plan, undefined, `state:${crypto.randomUUID()}`, capture(plan));
	await checkpointHosted(plan);
	Questions.shutdown(plan.questions);
	presence.destroy(plan.presence);
	plan.document.doc.destroy();
}

/** Current canonical source. */
export function source(plan: Plan): string {
	return room.project(plan.document);
}

/** Size of the Yjs history, for the idle compaction check. */
export function size(plan: Plan): number {
	return Y.encodeStateAsUpdate(plan.document.doc).byteLength;
}
