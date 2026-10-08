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
import { isDeepStrictEqual } from "node:util";

import { assertIntroducedUrls, parse } from "@chopin/dialect";
import { MENTION } from "@chopin/protocol/address";
import * as Question from "@chopin/question";

import { validateSource } from "../conversation-plan/sources";
import { restoreState as restoreConversationPlan } from "../conversation-plan/domain";
import { assertEventCapacity } from "../conversation-plan/events";
import { assertOptionCapacity } from "../conversation-plan/option-capacity";
import { type Effect, restoreEffectOutbox } from "../conversation-plan/effects";
import * as Jobs from "../conversation-plan/jobs";
import { restorePendingCardActions } from "../questions/card-actions";
import { validateNotice, validateScopedNotices } from "./notice-validation";

import * as presence from "./presence";
import * as edit from "./edit";
import * as room from "./room";
import * as Chat from "../chat/service";
import { restoreReferences } from "../chat/references";
import * as Comments from "../comments/service";
import * as Questions from "../questions/service";
import * as VisualDecisions from "../visual-decisions/state";
import { CommitRejected } from "../storage/errors";
import { claim, restore as restoreGraph, restoreRun } from "../tasks/graphs";
import { claimEligibility, restoreLifecycle, transition } from "../tasks/lifecycle";
import { broadcast, fail, relay, reply, tell } from "../wire";

import type { Server } from "bun";
import type { ConversationPlan, Plan as Wire, Request } from "@chopin/protocol";
import type { Socket, SocketData } from "../wire";
import type { Presence } from "./presence";
import type { Document } from "./room";
import type { Block } from "./edit";
import type { Brief, CreationOrigin } from "../mcp";
import { researchProjectionAllowed, ResearchProjectionConflict } from "../storage/model";
import type {
	InitialChannel,
	JsonValue,
	Lease,
	ResearchProjectionChange,
	StoredChannel,
} from "../storage/model";
import type { StorageAdapter } from "../storage/port";
import type { PendingCardAction } from "../questions/card-actions";
import type { ClaimInput, ClaimResult, Graph, Run } from "../tasks/graphs";
import type { Lifecycle, LifecycleInput, LifecycleResult } from "../tasks/lifecycle";

/** Updates are grouped for this long before being applied together. */
const GROUP_MS = 5;

/** Per-connection ceiling, generous enough that typing never reaches it. */
const RATE_LIMIT = 200;
const RATE_WINDOW_MS = 1_000;
/**
 * Consecutive windows over the limit before the connection is closed.
 *
 * A dropped update strands every later one from the same client, because Yjs
 * holds an update until its predecessor arrives. A current client resends what
 * was never acknowledged; an older bundle only replays its outbox when it
 * reopens, so closing is what gets its edits through.
 */
const RATE_STRIKES = 3;

/** Invalid batches tolerated from one connection before it is disconnected. */
const INVALID_LIMIT = 3;
const INVALID_WINDOW_MS = 10 * 60 * 1_000;

/** Close code for a client that keeps sending updates the document rejects. */
const ABUSIVE = 4003;

/** Close code for a client that keeps sending updates faster than the limit. */
const TOO_FAST = 4429;

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
	/** When the current window of dropped updates began. */
	limitedAt?: number;
	/** Consecutive windows in which updates were dropped. */
	limitedWindows?: number;
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

/** Durable result of one accepted MCP document rewrite. */
export type McpUpdateRecord = {
	idempotencyKey: string;
	fingerprint: string;
	fromRevision: number;
	client: { name: string; version: string };
	document: {
		source: string;
		revision: number;
		title: string;
		url: string;
		description?: string;
	};
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
	/** Idempotent MCP rewrites retained so later edits do not change a replay. */
	mcpUpdates: McpUpdateRecord[];
	server: Server<SocketData>;
	document: Document;
	presence: Presence;
	/** Open questionnaires and their shared answer drafts. */
	questions: Questions.Questions;
	visualDecisions: VisualDecisions.Decisions;
	/** Resolutions in flight and who is typing. Nothing durable. */
	comments: Comments.Threads;
	/** The conversation driving the agent. */
	chat: Chat.Chat;
	/** Replayable conversation-derived cards and durable inference queue. */
	conversationPlan: ConversationPlan.State;
	/** Durable request IDs for explicit analysis retries. */
	conversationPlanRetries: Array<{ id: string; messageId: string }>;
	/** Background Planner work retained across restarts. */
	conversationPlanJobs: ConversationPlan.Job[];
	/** Completed delivery keys and unfinished durable conversation work. */
	conversationPlanEffects: string[];
	conversationPlanPendingEffects: Effect[];
	/** Card actions waiting to be mirrored into their conversation thread. */
	pendingCardActions: PendingCardAction[];

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
	mcpUpdates?: McpUpdateRecord[];
	questions: Questions.Record[];
	openQuestions: Questions.StoredOpen[];
	visualDecisions?: VisualDecisions.Stored[];
	threads: Comments.Record[];
	transcript: Chat.Chat["entries"];
	conversationPlan?: ConversationPlan.State;
	conversationPlanRetries?: Array<{ id: string; messageId: string }>;
	conversationPlanJobs?: ConversationPlan.Job[];
	conversationPlanEffects?: string[];
	conversationPlanPendingEffects?: Effect[];
	pendingCardActions?: PendingCardAction[];
	workflowRuns?: NonNullable<Chat.Chat["runs"]>;
};

type ChatView = Pick<Chat.Chat, "entries" | "runs">;

function state(plan: Plan, chat: ChatView = plan.chat): Sidecar {
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
		...(plan.mcpUpdates.length > 0 ? { mcpUpdates: plan.mcpUpdates } : {}),
		questions: [...plan.records.values()],
		openQuestions: Questions.dump(plan.questions),
		...(plan.visualDecisions.size
			? { visualDecisions: VisualDecisions.dump(plan.visualDecisions) }
			: {}),
		threads: [...plan.threads.values()],
		transcript: chat.entries,
		conversationPlan: plan.conversationPlan,
		...(plan.conversationPlanRetries.length
			? { conversationPlanRetries: plan.conversationPlanRetries }
			: {}),
		...(plan.conversationPlanJobs.length
			? { conversationPlanJobs: plan.conversationPlanJobs }
			: {}),
		...(plan.conversationPlanEffects.length
			? { conversationPlanEffects: plan.conversationPlanEffects }
			: {}),
		...(plan.conversationPlanPendingEffects.length
			? { conversationPlanPendingEffects: plan.conversationPlanPendingEffects }
			: {}),
		...(plan.pendingCardActions.length ? { pendingCardActions: plan.pendingCardActions } : {}),
		...(chat.runs?.length ? { workflowRuns: chat.runs } : {}),
	};
}

function jsonState(plan: Plan, chat?: ChatView): { value: JsonValue; text: string } {
	let text = JSON.stringify(state(plan, chat));
	return { value: JSON.parse(text) as JsonValue, text };
}

function capture(plan: Plan, chat?: ChatView): Captured {
	assertEventCapacity(plan.conversationPlan, plan.pendingCardActions.length);
	if (plan.persistence) assertOptionCapacity(plan);
	let sidecar = jsonState(plan, chat);
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

function definitionShape(value: Question.Definition) {
	return value.questions.map(question => [
		question.id,
		question.header,
		question.question,
		question.multiple,
		question.options.map(option => [option.id, option.label, option.description]),
	]);
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
	if (Object.hasOwn(item, "mcpUpdates")) expected.push("mcpUpdates");
	if (Object.hasOwn(item, "conversationPlan")) expected.push("conversationPlan");
	if (Object.hasOwn(item, "conversationPlanRetries")) expected.push("conversationPlanRetries");
	if (Object.hasOwn(item, "conversationPlanJobs")) expected.push("conversationPlanJobs");
	if (Object.hasOwn(item, "conversationPlanEffects")) expected.push("conversationPlanEffects");
	if (Object.hasOwn(item, "conversationPlanPendingEffects")) {
		expected.push("conversationPlanPendingEffects");
	}
	if (Object.hasOwn(item, "pendingCardActions")) expected.push("pendingCardActions");
	if (Object.hasOwn(item, "workflowRuns")) expected.push("workflowRuns");
	if (Object.hasOwn(item, "visualDecisions")) expected.push("visualDecisions");
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
	let records = questions.map(question => Questions.normalizeRecord(question));
	let visualDecisions = VisualDecisions.restore(item.visualDecisions);
	if ([...visualDecisions.keys()].some(id => records.some(record => record.id === id))) {
		throw new Error("Visual decision identity conflicts with questionnaire record");
	}
	let openQuestions = objects(item.openQuestions, "open questionnaire");
	let recordIds = new Set(records.map(record => record.id));
	let openIds = new Set(openQuestions.map(entry => entry.id as string));
	let definitions = new Map(
		records.map(record => [record.id, Question.identified(record.definition)]),
	);
	if (
		[...openIds].some(id => !recordIds.has(id))
		|| records.some(record => Questions.isOpenStatus(record.status) !== openIds.has(record.id))
		|| openQuestions.some(entry => {
			let record = definitions.get(entry.id as string);
			if (!record) return true;
			let draft = Question.identified(entry.definition);
			return JSON.stringify(definitionShape(record))
				!== JSON.stringify(definitionShape(draft));
		})
	) {
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
	let savedMessages = new Map(transcript.map(entry => [entry.id, entry]));
	for (let record of records) {
		for (let origin of Object.values(record.optionOrigins)) {
			if (!origin.source) continue;
			let message = savedMessages.get(origin.source.messageId);
			if (!message) throw new Error("hosted channel has option source without a message");
			try {
				validateSource(origin.source, message as Chat.Chat["entries"][number]);
			} catch (err) {
				throw new Error("hosted channel has invalid option source", { cause: err });
			}
		}
	}
	let referenceIds = new Set<string>();
	for (let entry of transcript) {
		if (
			typeof entry.text !== "string"
			|| typeof entry.ts !== "number"
			|| !entry.author
			|| typeof entry.author !== "object"
			|| Array.isArray(entry.author)
		) throw new Error("hosted channel has an invalid transcript entry");
		validateNotice(entry, savedMessages);
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
	let mcpUpdates = restoreMcpUpdates(item.mcpUpdates);
	let conversationPlan = restoreConversationPlan(
		item.conversationPlan,
		transcript as unknown as Chat.Chat["entries"],
	);
	validateScopedNotices(transcript as unknown as Chat.Chat["entries"], conversationPlan, records);
	for (let record of records) {
		for (let [optionId, origin] of Object.entries(record.optionOrigins)) {
			if (
				origin.origin === "chat" && origin.source
				&& !conversationPlan.events.some(event =>
					event.type === "option.added" && event.threadId === record.threadId
					&& event.contribution.id === optionId
					&& isDeepStrictEqual(event.source, origin.source)
				)
			) {
				throw new Error("hosted channel has option source outside its card thread or evidence");
			}
			if (origin.source?.role !== "question") continue;
			let thread = conversationPlan.threads.find(item =>
				item.id === record.threadId && item.questionnaireId === record.id
			);
			let option = record.definition.questions.flatMap(item => item.options)
				.find(item => item.id === optionId);
			if (
				!Questions.matchesQuestionSource(origin.source, thread)
				|| !option || !Questions.questionMentionsOption(origin.source.quote, option.label)
			) {
				throw new Error(
					"hosted channel has option question source outside its card thread or evidence",
				);
			}
		}
	}
	let conversationPlanRetries = restoreConversationPlanRetries(item.conversationPlanRetries);
	let conversationPlanJobs = Jobs.restore(item.conversationPlanJobs);
	let outbox = restoreEffectOutbox(
		item.conversationPlanPendingEffects,
		item.conversationPlanEffects,
	);
	let pendingCardActions = restorePendingCardActions(item.pendingCardActions);
	let messageIds = new Set(transcript.map(entry => entry.id as string));
	if (
		conversationPlan.queue.some(entry => !messageIds.has(entry.messageId))
		|| conversationPlan.analysis.some(entry => !messageIds.has(entry.messageId))
		|| conversationPlanRetries.some(entry => !messageIds.has(entry.messageId))
	) throw new Error("hosted channel has conversation analysis without a source message");
	let workflowRuns = restoreWorkflowRuns(item.workflowRuns);
	return {
		version: 1,
		revision: item.revision,
		documentSeq: item.documentSeq,
		...(created ? { creation: created } : {}),
		...(graph ? { graph } : {}),
		...(execution ? { execution } : {}),
		...(lifecycle ? { lifecycle } : {}),
		...(mcpUpdates.length > 0 ? { mcpUpdates } : {}),
		questions: records,
		openQuestions: openQuestions as unknown as Questions.StoredOpen[],
		...(visualDecisions.size ? { visualDecisions: VisualDecisions.dump(visualDecisions) } : {}),
		threads: threads as never[],
		transcript: transcript as unknown as Chat.Chat["entries"],
		conversationPlan,
		...(conversationPlanRetries.length ? { conversationPlanRetries } : {}),
		...(conversationPlanJobs.length ? { conversationPlanJobs } : {}),
		...(outbox.receipts.length ? { conversationPlanEffects: outbox.receipts } : {}),
		...(outbox.pending.length ? { conversationPlanPendingEffects: outbox.pending } : {}),
		...(pendingCardActions.length ? { pendingCardActions } : {}),
		...(workflowRuns.length > 0 ? { workflowRuns } : {}),
	};
}

function restoreConversationPlanRetries(
	value: JsonValue | undefined,
): Array<{ id: string; messageId: string }> {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 4096) {
		throw new Error("hosted channel has invalid conversation analysis retries");
	}
	let seen = new Set<string>();
	return value.map(raw => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error("hosted channel has invalid conversation analysis retry");
		}
		let item = raw as Record<string, JsonValue>;
		if (
			Object.keys(item).sort().join(",") !== "id,messageId"
			|| typeof item.id !== "string" || !item.id || item.id.length > 250
			|| typeof item.messageId !== "string" || !item.messageId || item.messageId.length > 200
			|| seen.has(item.id)
		) throw new Error("hosted channel has invalid conversation analysis retry");
		seen.add(item.id);
		return { id: item.id, messageId: item.messageId };
	});
}

const RUN_STATUSES = new Set([
	"running",
	"waiting",
	"paused",
	"finished",
	"blocked",
	"failed",
	"stopped",
]);
const RUN_STAGE_STATUSES = new Set([
	"pending",
	"running",
	"awaiting_input",
	"paused",
	"blocked",
	"completed",
	"failed",
	"skipped",
]);

function seconds(value: JsonValue | undefined, optional = false): boolean {
	if (value === undefined) return optional;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Workflow run cards Chat showed, as `Chat.Run` values. */
function restoreWorkflowRuns(value: JsonValue | undefined): NonNullable<Chat.Chat["runs"]> {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("hosted channel has invalid workflow runs");
	let runs = objects(value, "workflow run");
	for (let run of runs) {
		let stages = run.stages;
		if (
			typeof run.name !== "string"
			|| !RUN_STATUSES.has(run.status as string)
			|| !seconds(run.started)
			|| !seconds(run.updated)
			|| !seconds(run.ended, true)
			|| !seconds(run.earlierStages, true)
			|| !seconds(run.waiting)
			|| !Array.isArray(stages)
			|| stages.some(stage =>
				!stage || typeof stage !== "object" || Array.isArray(stage)
				|| typeof stage.id !== "string" || typeof stage.name !== "string"
				|| stage.kind !== undefined && stage.kind !== "tool"
				|| !RUN_STAGE_STATUSES.has(stage.status as string)
				|| !seconds(stage.started, true) || !seconds(stage.ended, true)
			)
		) throw new Error("hosted channel has invalid workflow runs");
	}
	return runs as unknown as NonNullable<Chat.Chat["runs"]>;
}

function restoreMcpUpdates(value: JsonValue | undefined): McpUpdateRecord[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("hosted channel has invalid MCP updates");
	let seen = new Set<string>();
	return value.map(entry => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error("hosted channel has invalid MCP updates");
		}
		let item = entry as Record<string, JsonValue>;
		let document = item.document;
		if (
			!document
			|| typeof document !== "object"
			|| Array.isArray(document)
			|| typeof item.idempotencyKey !== "string"
			|| !item.idempotencyKey.trim()
			|| seen.has(item.idempotencyKey)
			|| typeof item.fingerprint !== "string"
			|| !item.fingerprint.trim()
			|| typeof item.fromRevision !== "number"
			|| !Number.isSafeInteger(item.fromRevision)
			|| item.fromRevision < 0
			|| !item.client
			|| typeof item.client !== "object"
			|| Array.isArray(item.client)
		) throw new Error("hosted channel has invalid MCP updates");
		seen.add(item.idempotencyKey);
		let client = item.client as Record<string, JsonValue>;
		let recorded = document as Record<string, JsonValue>;
		if (
			typeof client.name !== "string"
			|| !client.name.trim()
			|| typeof client.version !== "string"
			|| !client.version.trim()
			|| typeof recorded.source !== "string"
			|| typeof recorded.revision !== "number"
			|| !Number.isSafeInteger(recorded.revision)
			|| recorded.revision < 0
			|| typeof recorded.title !== "string"
			|| typeof recorded.url !== "string"
			|| (recorded.description !== undefined && typeof recorded.description !== "string")
		) throw new Error("hosted channel has invalid MCP updates");
		return {
			idempotencyKey: item.idempotencyKey,
			fingerprint: item.fingerprint,
			fromRevision: item.fromRevision,
			client: { name: client.name, version: client.version },
			document: {
				source: recorded.source,
				revision: recorded.revision,
				title: recorded.title,
				url: recorded.url,
				...(recorded.description ? { description: recorded.description } : {}),
			},
		};
	});
}

export function sourceHash(source: string): string {
	return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

/** Build the complete revision-zero state published with a newly created channel. */
export async function initial(
	source: string,
	creation?: CreationMetadata,
): Promise<InitialChannel> {
	// A new document has no stored links to spare from the newer URL rules.
	assertIntroducedUrls([], parse(source).children);
	let document = await room.create(source);
	try {
		let canonical = room.project(document);
		let sidecar: Sidecar = {
			version: 1,
			revision: 0,
			documentSeq: document.seq,
			...(creation ? { creation } : {}),
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
	allowArchived = false,
	researchProjections: ResearchProjectionChange[] = [],
	notifyDocumentPersisted = true,
	retryRejectedCommit = false,
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
			...(researchProjections.length > 0 ? { researchProjections } : {}),
			...(allowArchived ? { allowArchived: true } : {}),
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
				...(allowArchived ? { allowArchived: true } : {}),
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
		if (update && sourceChanged && notifyDocumentPersisted && durable.onDocumentPersisted) {
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
		if (
			!(err instanceof ResearchProjectionConflict)
			&& !(retryRejectedCommit && err instanceof CommitRejected)
		) {
			durable.fatal(err);
		}
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

/**
 * Persist a sidecar-only state transition. `chat` is read when the commit runs
 * and stored in place of the live transcript and run cards, so a change can be
 * saved before it becomes visible in shared chat state.
 */
export function persist(plan: Plan, chat?: () => ChatView): Promise<void> {
	let commit = () =>
		commitHosted(plan, undefined, `state:${crypto.randomUUID()}`, capture(plan, chat?.()));
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
export function persistExclusive(plan: Plan, allowArchived = false): Promise<void> {
	return commitHosted(
		plan,
		undefined,
		`state:${crypto.randomUUID()}`,
		capture(plan),
		allowArchived,
	);
}

type RestoredHosted = {
	document: Document;
	needsInitialCheckpoint: boolean;
	sidecar: Sidecar;
	/** Exact saved sidecar, before interrupted jobs are normalized in memory. */
	persistedSidecar: JsonValue;
	interruptedJobs: boolean;
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
	let persistedSidecar = loaded.sidecar === null && loaded.snapshot
			&& loaded.channel.revision === 0
		? loaded.snapshot.sidecar
		: loaded.sidecar;
	let sidecar = restoredState(
		persistedSidecar,
		pristine,
		{ channelId: loaded.channel.id, repositoryId: loaded.channel.repositoryId },
	);
	let persistedJobs = persistedSidecar && typeof persistedSidecar === "object"
			&& !Array.isArray(persistedSidecar)
		? (persistedSidecar as Record<string, JsonValue>).conversationPlanJobs
		: undefined;
	let interruptedJobs = Array.isArray(persistedJobs)
		&& persistedJobs.some(job => (job as { status: string }).status === "running");
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
	try {
		VisualDecisions.validateProjections(
			VisualDecisions.restore(sidecar.visualDecisions),
			room.questionnaireProjections(document),
		);
	} catch (error) {
		document.doc.destroy();
		throw error;
	}
	return { document, needsInitialCheckpoint, sidecar, persistedSidecar, interruptedJobs };
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
	let { document, needsInitialCheckpoint, sidecar, persistedSidecar, interruptedJobs } =
		await restoreHosted(id, loaded);

	let plan: Plan = {
		id,
		...(sidecar.creation ? { creation: sidecar.creation } : {}),
		mcpUpdates: sidecar.mcpUpdates ?? [],
		server,
		document,
		presence: presence.create(),
		questions: Questions.restore(sidecar.openQuestions),
		visualDecisions: VisualDecisions.restore(sidecar.visualDecisions),
		comments: Comments.create(),
		chat: Chat.restore(sidecar.transcript, sidecar.workflowRuns),
		conversationPlan: sidecar.conversationPlan ?? restoreConversationPlan(undefined),
		conversationPlanRetries: sidecar.conversationPlanRetries ?? [],
		conversationPlanJobs: sidecar.conversationPlanJobs ?? [],
		conversationPlanEffects: sidecar.conversationPlanEffects ?? [],
		conversationPlanPendingEffects: sidecar.conversationPlanPendingEffects ?? [],
		pendingCardActions: sidecar.pendingCardActions ?? [],
		outlines: new Map(),
		records: new Map(
			sidecar.questions.map(record => [record.id, Questions.normalizeRecord(record)]),
		),
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
	if (interruptedJobs) {
		plan.persistence.lastSidecar = JSON.stringify(persistedSidecar);
		plan.persistence.committedSidecar = persistedSidecar;
	}
	try {
		if (interruptedJobs) await persistExclusive(plan, true);
		if (needsInitialCheckpoint) await checkpointHosted(plan);
	} catch (error) {
		if (plan.persistence.checkpointTimer) clearTimeout(plan.persistence.checkpointTimer);
		Questions.shutdown(plan.questions);
		presence.destroy(plan.presence);
		plan.document.doc.destroy();
		throw error;
	}

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
	return JSON.stringify([Questions.anchors(plan), Comments.anchors(plan), Questions.prose(plan)]);
}

function proseOrphans(plan: Plan): Map<string, boolean> {
	return new Map(Questions.prose(plan).map(item => [item.widget, item.orphaned]));
}

function announceProseChanges(plan: Plan, before: Map<string, boolean>): void {
	for (let item of Questions.prose(plan)) {
		if (before.get(item.widget) === item.orphaned) continue;
		try {
			Questions.announce(plan, plan.server, plan.id, item.widget);
		} catch (err) {
			console.error("[plan] could not announce decided prose metadata:", err);
		}
	}
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
		prose: Questions.prose(plan),
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
	if (gauge.recent.length >= RATE_LIMIT) return limited(plan, ws, msg.rid, gauge);
	gauge.recent.push(Date.now());

	plan.queue.push({ ws, rid: msg.rid, id: msg.id, update });
	schedule(plan);
}

/** Refuse an update over the rate limit, and close a connection that keeps it up. */
function limited(plan: Plan, ws: Socket, rid: string, gauge: Meter): void {
	fail(ws, rid, "rate limited");
	let now = Date.now();
	let since = gauge.limitedAt === undefined ? Infinity : now - gauge.limitedAt;
	if (since < RATE_WINDOW_MS) return;

	gauge.limitedWindows = since < 2 * RATE_WINDOW_MS ? (gauge.limitedWindows ?? 0) + 1 : 1;
	gauge.limitedAt = now;
	console.warn(
		`[plan] dropping updates from ${ws.data.handle} in ${plan.id}: over ${RATE_LIMIT} a second`,
	);
	if (gauge.limitedWindows >= RATE_STRIKES) {
		ws.close(TOO_FAST, "plan updates too fast");
	}
}

function schedule(plan: Plan): void {
	if (plan.timer) return;
	plan.timer = setTimeout(() => {
		plan.timer = undefined;
		plan.flushing = plan.flushing.then(() => commit(plan), () => commit(plan));
	}, GROUP_MS);
}

async function rejectBatch(plan: Plan, batch: Queued[], issues: string[]): Promise<void> {
	console.warn("[plan] rejected batch:", issues.join(", "));
	let proseBefore = proseOrphans(plan);

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
	announceProseChanges(plan, proseBefore);
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

	let outcome = await room.apply(
		plan.document,
		batch.map(item => item.update),
		async (id, action) => {
			let request = await plan.persistence.storage.research.get(plan.id, id);
			let initial = request?.turns.find(turn => turn.kind === "initial");
			let jobId = initial?.answerJobId ?? initial?.evidenceJobId;
			let job = jobId ? await plan.persistence.storage.jobs.get(plan.id, jobId) : undefined;
			return researchProjectionAllowed(
				plan.id,
				{ id, action },
				request?.workspace,
				initial,
				job?.job,
			);
		},
		plan.questions.open.size,
	);

	if (!outcome.ok) {
		await rejectBatch(plan, batch, outcome.issues);
		return;
	}

	let relationshipsChanged = false;
	let before = signature(plan);
	let previousRecords = new Map(plan.records);
	let previousThreads = new Map(plan.threads);
	try {
		Questions.rebase(plan);
		Comments.rebase(plan);
		relationshipsChanged = signature(plan) !== before;
	} catch (err) {
		console.error("[plan] could not carry anchors forward:", err);
	}
	let previousRevision = plan.revision;
	if (room.project(plan.document) !== plan.persistence.committedSource) plan.revision++;
	let merged = Y.mergeUpdates(batch.map(item => item.update));
	let operationId = `plan:${plan.document.epoch}:${
		createHash("sha256").update(merged).digest("hex")
	}`;
	try {
		await commitHosted(
			plan,
			merged,
			operationId,
			capture(plan),
			false,
			outcome.researchProjections,
		);
	} catch (err) {
		if (!(err instanceof ResearchProjectionConflict)) throw err;
		plan.revision = previousRevision;
		plan.records = previousRecords;
		plan.threads = previousThreads;
		await rejectBatch(plan, batch, ["research-reference-conflict"]);
		return;
	}

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

class ImplementationActiveError extends Error {
	constructor() {
		super("implementation is active");
	}
}

/** Commit a staged document and sidecar before bringing the live room forward. */
export async function publishStaged(
	plan: Plan,
	server: Server<SocketData>,
	roomId: string,
	candidate: Plan,
	mutation?: room.Mutation,
	options?: { notifyDocumentPersisted?: boolean; retryRejectedCommit?: boolean },
): Promise<void> {
	if (implementationActive(plan)) throw new ImplementationActiveError();
	let source = room.project(candidate.document);
	if (!mutation && source !== room.project(plan.document)) {
		throw new Error("staged document changed without a mutation");
	}
	if (mutation) candidate.document.seq++;
	if (source !== plan.persistence.committedSource) candidate.revision++;
	let operationId = mutation
		? `server:${candidate.document.epoch}:${
			createHash("sha256").update(mutation.update).digest("hex")
		}`
		: `state:${crypto.randomUUID()}`;
	await commitHosted(
		plan,
		mutation?.update,
		operationId,
		capture(candidate),
		false,
		[],
		options?.notifyDocumentPersisted !== false,
		options?.retryRejectedCommit === true,
	);
	if (mutation) {
		Y.applyUpdate(plan.document.doc, mutation.update);
		await room.settle();
	}
	plan.document.seq = candidate.document.seq;
	plan.revision = candidate.revision;
	plan.records = candidate.records;
	plan.threads = candidate.threads;
	plan.questions = candidate.questions;
	plan.visualDecisions = candidate.visualDecisions;
	plan.conversationPlan = candidate.conversationPlan;
	plan.pendingCardActions = candidate.pendingCardActions;
	plan.conversationPlanPendingEffects = candidate.conversationPlanPendingEffects;
	plan.conversationPlanEffects = candidate.conversationPlanEffects;
	if (mutation) {
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
}

export async function rewrite(
	plan: Plan,
	nextSource: string,
	record: (source: string, revision: number) => McpUpdateRecord,
): Promise<edit.Result> {
	if (implementationActive(plan)) throw new Error("implementation is active");
	let before = room.project(plan.document);
	let document = await room.restore(
		plan.document.epoch,
		Y.encodeStateAsUpdate(plan.document.doc),
		before,
		[],
	);
	document.seq = plan.document.seq;
	let candidate: Plan = {
		...plan,
		document,
		records: new Map(plan.records),
		threads: new Map(plan.threads),
		outlines: new Map(plan.outlines),
		mcpUpdates: [...plan.mcpUpdates],
	};
	try {
		Questions.rebase(candidate);
		Comments.rebase(candidate);
		let outcome = edit.replace(candidate, plan.revision, nextSource);
		if (!outcome.ok) return outcome;
		let source = room.project(document);
		let changed = source !== before;
		if (changed) {
			Questions.rebase(candidate);
			Questions.invalidate(candidate, "plan_changed");
			Comments.rebase(candidate);
			Comments.invalidate(candidate, "plan_changed");
		} else {
			candidate.records = plan.records;
			candidate.threads = plan.threads;
		}
		if (outcome.mutation) document.seq++;
		if (source !== plan.persistence.committedSource) candidate.revision++;
		let recorded = record(source, candidate.revision);
		candidate.mcpUpdates.push(recorded);
		let operationId = outcome.mutation
			? `server:${document.epoch}:${
				createHash("sha256").update(outcome.mutation.update).digest("hex")
			}`
			: `state:${crypto.randomUUID()}`;
		await commitHosted(plan, outcome.mutation?.update, operationId, capture(candidate));
		if (outcome.mutation) {
			Y.applyUpdate(plan.document.doc, outcome.mutation.update);
			await room.settle();
		}
		plan.document.seq = document.seq;
		plan.revision = candidate.revision;
		plan.mcpUpdates.push(recorded);
		plan.outlines = candidate.outlines;
		if (changed) {
			Questions.rebase(plan, before);
			Questions.invalidate(plan, "plan_changed");
			Comments.rebase(plan);
			Comments.invalidate(plan, "plan_changed");
		}
		if (outcome.mutation) {
			try {
				broadcast(plan.server, plan.id, {
					kind: "plan:update",
					ts: 0,
					epoch: plan.document.epoch,
					update: encode(outcome.mutation.update),
					seq: plan.document.seq,
				});
			} catch (err) {
				console.error("[plan] could not broadcast a persisted update:", err);
			}
		}
		return outcome;
	} finally {
		document.doc.destroy();
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
	options?: { cursor?: boolean; attribution?: Wire.ChangeAttribution },
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
			changes: options?.attribution
				? wired.map(change => ({ ...change, attribution: options.attribution }))
				: wired,
		});

		// Read off the same pass, deliberately. Working it out separately could
		// disagree, and then the cursor would point at one block while the
		// marks described another.
		if (last !== undefined && options?.cursor !== false) attend(plan, server, roomId, last);
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
	let prose = Questions.prose(plan);
	broadcast(server, roomId, {
		kind: "plan:anchors",
		ts: 0,
		epoch: plan.document.epoch,
		widgets: Questions.anchors(plan),
		threads: Comments.anchors(plan),
		prose,
	});
	// Other post-commit callers also rebase prose; repeat metadata so none can
	// publish a stale collapse state after an edit or rewrite.
	for (let item of prose) {
		try {
			Questions.announce(plan, server, roomId, item.widget);
		} catch (err) {
			console.error("[plan] could not announce decided prose metadata:", err);
		}
	}
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

/** Release a successfully opened document that has never been exposed to a room. */
export async function abortOpening(plan: Plan): Promise<void> {
	if (plan.timer) clearTimeout(plan.timer);
	clearInterval(plan.attention);
	let persistence = plan.persistence;
	persistence.closing = true;
	if (persistence.checkpointTimer) clearTimeout(persistence.checkpointTimer);
	persistence.checkpointTimer = undefined;
	try {
		let results = await Promise.allSettled([Chat.close(plan.chat), plan.flushing]);
		let failed = results.filter(result => result.status === "rejected");
		if (failed.length === 1) throw failed[0]!.reason;
		if (failed.length > 1) {
			throw new AggregateError(failed.map(result => result.reason), "document cleanup failed");
		}
	} finally {
		try {
			Questions.shutdown(plan.questions);
		} finally {
			try {
				presence.destroy(plan.presence);
			} finally {
				plan.document.doc.destroy();
			}
		}
	}
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
	await commitHosted(plan, undefined, `state:${crypto.randomUUID()}`, capture(plan), true);
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

export function placeResearchReference(plan: Plan, id: string): Promise<"placed" | "deferred"> {
	return exclusive(plan, async () => {
		if (implementationActive(plan)) return "deferred";
		let document = await room.restore(
			plan.document.epoch,
			Y.encodeStateAsUpdate(plan.document.doc),
			room.project(plan.document),
			[],
		);
		document.seq = plan.document.seq;
		try {
			let mutation = room.insertResearch(document, id);
			if (!mutation) return "placed";
			try {
				await publishStaged(plan, plan.server, plan.id, { ...plan, document }, mutation);
			} catch (err) {
				if (err instanceof ImplementationActiveError) return "deferred";
				throw err;
			}
			return "placed";
		} finally {
			document.doc.destroy();
		}
	});
}
