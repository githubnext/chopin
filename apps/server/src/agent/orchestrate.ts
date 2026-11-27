/**
 * Multi-document orchestration shared by the Planner's `orchestrate` host tool and MCP `orchestrate`.
 *
 * `open` creates several documents at once, each exactly as `create_document` would; `list` reads
 * each created document's state as Chopin holds it; `decisions` reads decisions across created
 * documents with status/origin filtering; `answer` answers one decision on a created document;
 * `instruct` hands their Planners one instruction as the requesting person's message (starting
 * stopped Planners and steering/nudging live working Planners when supported); `build` starts
 * builds (drafting tasks first when needed) across created documents; `index` keeps a table of
 * them in this document. A document belongs here only while its stored `createdFrom` names this
 * one, in the same repository, top-level and unarchived, so orchestration is strictly contained
 * and non-transitive.
 */
import { documentPath } from "@chopin/protocol/document-url";

import {
	DECISION_ANSWER_VALUE_SCHEMA,
	DECISION_ORIGIN_SCHEMA,
	DECISION_STATUS_FILTER_SCHEMA,
	parseDecisionAnswerPayload,
} from "../mcp/decisions";
import { parseDecisionOrigin, parseDecisionStatusFilter } from "../questions/read-decisions";
import {
	createNewDocument,
	MAX_INSTRUCTION_BYTES,
	NEW_DOCUMENT_SCHEMA,
	newDocumentArguments,
	writes,
} from "./new-documents";

import type { BuildRequest } from "@chopin/protocol/implementation";
import type { AuthenticatedSession } from "../auth/session";
import type { GitHubUser, Repository as GitHubRepository } from "../github/client";
import type { InvokePlannerError } from "../mcp";
import type {
	AnswerDecisionOutcome,
	AnswerDecisionRefusal,
	AnsweredDecision,
	DecisionAnswerPayload,
} from "../mcp/decisions";
import type {
	DecisionCounts,
	DecisionFilter,
	DecisionOrigin,
	DecisionSnapshot,
	DecisionStatusFilter,
	ReadDecisionsResult,
} from "../questions/read-decisions";
import type { DecisionAnswerValue } from "../questions/service-submit";
import type { ChannelRecord } from "../storage/model";
import type { UnapprovedDecision } from "../tasks/open-decisions";
import type { StartPlanBuildInput, StartPlanBuildResult } from "../tasks/start-build";
import type {
	NewDocumentArguments,
	NewDocumentDeps,
	NewDocumentRequest,
	NewDocumentResult,
} from "./new-documents";
import type { HostedRepository } from "./repository";

/** Most documents one `open` creates. */
export const MAX_OPEN = 20;
/** Most created documents one call lists, inspects, instructs, builds or indexes. */
export const MAX_CREATED = 200;
/** How many documents are created, inspected, instructed, or built at once. */
const CONCURRENCY = 4;

export const ORCHESTRATE_OPERATIONS = [
	"open",
	"list",
	"decisions",
	"answer",
	"instruct",
	"build",
	"index",
] as const;

export type OrchestrateArguments =
	| { operation: "open"; documents: NewDocumentArguments[] }
	| { operation: "list" }
	| {
		operation: "decisions";
		targets?: string[];
		status?: DecisionStatusFilter;
		origin?: DecisionOrigin;
	}
	| ({ operation: "answer"; target: string } & DecisionAnswerPayload)
	| { operation: "instruct"; instruction: string; targets?: string[] }
	| {
		operation: "build";
		targets?: string[];
		draftIfNeeded?: boolean;
		requireSettledDecisions?: boolean;
		retry?: boolean;
		rebuild?: boolean;
	}
	| { operation: "index" };

export const ORCHESTRATE_SCHEMA = {
	type: "object",
	properties: {
		operation: {
			type: "string",
			enum: [...ORCHESTRATE_OPERATIONS],
			description: "`open` creates documents from `documents`; `list` reports every document "
				+ "this one created, with its Planner, open Decisions and build; `decisions` reads "
				+ "decisions across created documents with optional status/origin filters; `answer` "
				+ "answers one decision on a created `target` document; `instruct` sends `instruction` "
				+ "to their Planners (starting stopped Planners and steering/nudging live working "
				+ "Planners when supported); `build` starts builds (drafting tasks first when needed) "
				+ "across created documents; `index` writes or refreshes their table in this document.",
		},
		documents: {
			type: "array",
			minItems: 1,
			maxItems: MAX_OPEN,
			items: NEW_DOCUMENT_SCHEMA,
			description: "For `open` only: each new document, exactly as `create_document` takes it, "
				+ "with its own idempotencyKey.",
		},
		instruction: {
			type: "string",
			minLength: 1,
			description: "For `instruct` only: what each document's Planner should do now. It is "
				+ "posted in each document's Chat as the requesting person's message.",
		},
		targets: {
			type: "array",
			minItems: 1,
			maxItems: MAX_CREATED,
			items: { type: "string", minLength: 1 },
			description: "For `decisions`, `instruct`, or `build`: the documents to include, each by "
				+ "the id or url `list` gives. Omit to include every document this one created.",
		},
		status: {
			...DECISION_STATUS_FILTER_SCHEMA,
			description: "For `decisions` only: filter by decision status (`all`, a single status, "
				+ "or a non-empty list of statuses). Defaults to `all`.",
		},
		origin: {
			...DECISION_ORIGIN_SCHEMA,
			description: "For `decisions` only: filter by decision origin (`planner`, `conversation`, "
				+ "or `human`).",
		},
		target: {
			type: "string",
			minLength: 1,
			description: "For `answer` only: the created document containing the decision, by id or url.",
		},
		decisionId: {
			type: "string",
			minLength: 1,
			description: "For `answer` only: the decision card ID or any question ID within the card.",
		},
		revision: {
			type: "integer",
			minimum: 0,
			description: "For `answer` only: the open decision revision read from `decisions`.",
		},
		idempotencyKey: {
			type: "string",
			minLength: 1,
			maxLength: 128,
			description: "For `answer` only: stable caller key making retries safe and idempotent.",
		},
		optionIds: {
			type: "array",
			items: { type: "string", minLength: 1 },
			description: "For `answer` on a single-question choice card: selected option ID(s).",
		},
		text: {
			type: "string",
			description: "For `answer` on a single-question text card: written answer text.",
		},
		answers: {
			type: "object",
			additionalProperties: DECISION_ANSWER_VALUE_SCHEMA,
			description: "For `answer` on multi-question (or any) card: answers keyed by question ID.",
		},
		draftIfNeeded: {
			type: "boolean",
			description: "For `build` only (default true): when a document has no current graph for "
				+ "its revision, ask its Planner to draft tasks and auto-queue the build once saved.",
		},
		requireSettledDecisions: {
			type: "boolean",
			description: "For `build` only (default false): when true, refuse documents that still "
				+ "have open or reopened decisions instead of building on best judgment.",
		},
		retry: {
			type: "boolean",
			description: "For `build` only (default false): allow retrying a stopped or failed build "
				+ "at the same revision.",
		},
		rebuild: {
			type: "boolean",
			description: "For `build` only (default false): queue a rebuild when a document already "
				+ "has a delivered live build and newer edits.",
		},
	},
	required: ["operation"],
	additionalProperties: false,
};

const FIELDS: Record<OrchestrateArguments["operation"], string[]> = {
	open: ["documents"],
	list: [],
	decisions: ["targets", "status", "origin"],
	answer: [
		"target",
		"decisionId",
		"revision",
		"idempotencyKey",
		"optionIds",
		"text",
		"answers",
	],
	instruct: ["instruction", "targets"],
	build: ["targets", "draftIfNeeded", "requireSettledDecisions", "retry", "rebuild"],
	index: [],
};

function parseTargets(raw: unknown, operation: string): string[] | undefined {
	if (raw === undefined) return undefined;
	if (
		!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CREATED
		|| raw.some(target => typeof target !== "string" || !target.trim())
	) throw new Error(`targets must list the documents to ${operation}, each by id or url`);
	return raw as string[];
}

function parseOptionalBoolean(raw: unknown, field: string): boolean | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "boolean") throw new Error(`${field} must be a boolean`);
	return raw;
}

/** The tool's arguments, checked; throws with a sentence the model can act on. */
export function orchestrateArguments(raw: unknown): OrchestrateArguments {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("orchestrate arguments must be an object");
	}
	let args = raw as Record<string, unknown>;
	let operation = args.operation;
	if (!ORCHESTRATE_OPERATIONS.includes(operation as OrchestrateArguments["operation"])) {
		throw new Error(`operation must be one of ${ORCHESTRATE_OPERATIONS.join(", ")}`);
	}
	let op = operation as OrchestrateArguments["operation"];
	let unknown = Object.keys(args).find(key => key !== "operation" && !FIELDS[op].includes(key));
	if (unknown) throw new Error(`orchestrate ${op} does not take \`${unknown}\``);
	if (op === "open") {
		if (!Array.isArray(args.documents) || args.documents.length === 0) {
			throw new Error("open needs documents, at least one");
		}
		if (args.documents.length > MAX_OPEN) {
			throw new Error(`open creates at most ${MAX_OPEN} documents at once`);
		}
		let documents = args.documents.map((value, index) => {
			try {
				return newDocumentArguments(value);
			} catch (err) {
				throw new Error(`documents[${index}]: ${err instanceof Error ? err.message : err}`, {
					cause: err,
				});
			}
		});
		let keys = new Set(documents.map(document => document.idempotencyKey));
		if (keys.size !== documents.length) {
			throw new Error("each document needs its own idempotencyKey");
		}
		return { operation: op, documents };
	}
	if (op === "decisions") {
		let targets = parseTargets(args.targets, "inspect");
		let status: DecisionStatusFilter | undefined;
		if (Object.hasOwn(args, "status")) {
			status = parseDecisionStatusFilter(args.status);
			if (!status) {
				throw new Error("status must be `all`, a decision status, or a non-empty list of statuses");
			}
		}
		let origin: DecisionOrigin | undefined;
		if (Object.hasOwn(args, "origin")) {
			origin = parseDecisionOrigin(args.origin);
			if (!origin) throw new Error("origin must be `planner`, `conversation`, or `human`");
		}
		return {
			operation: op,
			...(targets ? { targets } : {}),
			...(status ? { status } : {}),
			...(origin ? { origin } : {}),
		};
	}
	if (op === "answer") {
		if (typeof args.target !== "string" || !args.target.trim()) {
			throw new Error("answer needs a target document id or url");
		}
		let parsed = parseDecisionAnswerPayload(args);
		if (!parsed.ok) throw new Error(parsed.message);
		return { operation: op, target: args.target, ...parsed.value };
	}
	if (op === "instruct") {
		let instruction = args.instruction;
		if (
			typeof instruction !== "string" || !instruction.trim()
			|| Buffer.byteLength(instruction, "utf8") > MAX_INSTRUCTION_BYTES
		) throw new Error("instruct needs an instruction of non-empty text of at most 64 KiB");
		let targets = parseTargets(args.targets, "instruct");
		return { operation: op, instruction, ...(targets ? { targets } : {}) };
	}
	if (op === "build") {
		let targets = parseTargets(args.targets, "build");
		let draftIfNeeded = parseOptionalBoolean(args.draftIfNeeded, "draftIfNeeded");
		let requireSettledDecisions = parseOptionalBoolean(
			args.requireSettledDecisions,
			"requireSettledDecisions",
		);
		let retry = parseOptionalBoolean(args.retry, "retry");
		let rebuild = parseOptionalBoolean(args.rebuild, "rebuild");
		return {
			operation: op,
			...(targets ? { targets } : {}),
			...(draftIfNeeded !== undefined ? { draftIfNeeded } : {}),
			...(requireSettledDecisions !== undefined ? { requireSettledDecisions } : {}),
			...(retry !== undefined ? { retry } : {}),
			...(rebuild !== undefined ? { rebuild } : {}),
		};
	}
	return { operation: op };
}

export type PlannerState = "working" | "idle" | "stopped";
export type BuildState = "not built" | "building" | "built" | "failed" | "stopped";

/** A document this one created, as Chopin holds it now. */
export type CreatedDocumentState = {
	id: string;
	title: string;
	url: string;
	planner: PlannerState;
	openDecisions: number;
	build: BuildState;
};

/** Whether a build of the document runs now, else whether one delivered, else how the last ended. */
export function buildState(plan: { builds: BuildRequest[]; live?: unknown }): BuildState {
	if (plan.builds.some(build => !["stopped", "failed"].includes(build.state))) return "building";
	if (plan.live) return "built";
	let last = plan.builds.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
		.at(-1);
	return last ? last.state as "stopped" | "failed" : "not built";
}

export type IndexOutcome =
	| { state: "written" | "unchanged" }
	| { state: "absent" }
	| { state: "refused"; reason: string; message?: string };

/**
 * Writes the table of `documents` into the creating document. `create` false refreshes a table
 * already there and writes none where there is none.
 */
export type IndexWriter = (
	documents: CreatedDocumentState[],
	create: boolean,
) => Promise<IndexOutcome>;

export type OrchestrateWriteAuthority =
	| {
		ok: true;
		user: GitHubUser;
		repository: GitHubRepository;
		session?: AuthenticatedSession;
	}
	| { ok: false; reason: "sign-in-required" | "repository-forbidden" };

export type OrchestrateAnswerInput = {
	channel: ChannelRecord;
	user: GitHubUser;
	decisionId: string;
	revision: number;
	idempotencyKey: string;
	optionIds?: string[];
	text?: string;
	answers?: { [questionId: string]: DecisionAnswerValue };
};

export type OrchestrateDeps = NewDocumentDeps & {
	/** Unarchived documents created from a document, oldest first. */
	createdFrom: (sourceId: string, limit: number) => Promise<ChannelRecord[]>;
	planner: (channelId: string) => PlannerState;
	build: (channelId: string) => Promise<BuildState>;
	/** Reads decisions for one created document with optional status/origin filter. */
	decisions?: (channelId: string, filter?: DecisionFilter) => Promise<ReadDecisionsResult>;
	/** Settles one decision on a created document through the shared durable answer core. */
	answerDecision?: (input: OrchestrateAnswerInput) => Promise<AnswerDecisionOutcome>;
	/** Starts (or drafts-then-starts, retries, or rebuilds) a created document's build. */
	startBuild?: (input: StartPlanBuildInput) => Promise<StartPlanBuildResult>;
	/**
	 * Optional caller write authorization override (used by MCP callers authenticated via bearer or
	 * launch token rather than a browser login). Defaults to `deps.login` + `deps.repository`.
	 */
	authorize?: (source: ChannelRecord) => Promise<OrchestrateWriteAuthority>;
	/**
	 * Optional document creation override (used by MCP callers creating via bearer token without
	 * requiring a browser login). Defaults to `createNewDocument(deps, ...)`.
	 */
	openDocument?: (
		request: NewDocumentRequest,
	) => Promise<NewDocumentResult>;
};

export type OrchestrateRequest = Omit<NewDocumentRequest, "arguments"> & {
	arguments: OrchestrateArguments;
	index: IndexWriter;
};

type Instructed =
	& Pick<CreatedDocumentState, "id" | "title" | "url">
	& (
		| { started: true; steered?: true }
		| { started: false; reason: string; message?: string }
	);

export type OrchestratedDocumentDecisions = Pick<CreatedDocumentState, "id" | "title" | "url"> & {
	decisions: DecisionSnapshot[];
	decisionCounts: DecisionCounts;
};

export type OrchestratedBuildOutcome =
	& Pick<CreatedDocumentState, "id" | "title" | "url">
	& (
		| { status: "started" | "already-building" | "rebuilding"; build: BuildRequest }
		| { status: "drafting"; planRevision: number }
		| {
			status: "refused";
			reason: string;
			message?: string;
			build?: BuildRequest;
			revision?: number;
			planRevision?: number;
			blockers?: string[];
			openDecisions?: UnapprovedDecision[];
		}
	);

export type OrchestrateResult =
	| {
		ok: true;
		operation: "open";
		documents: Array<{ idempotencyKey: string } & NewDocumentResult>;
		index?: IndexOutcome;
		next: string;
	}
	| { ok: true; operation: "list"; documents: CreatedDocumentState[]; index?: IndexOutcome }
	| {
		ok: true;
		operation: "decisions";
		documents: OrchestratedDocumentDecisions[];
		unknown?: string[];
	}
	| ({
		ok: true;
		operation: "answer";
		target: Pick<CreatedDocumentState, "id" | "title" | "url">;
		index?: IndexOutcome;
	} & AnsweredDecision)
	| {
		ok: true;
		operation: "instruct";
		documents: Instructed[];
		unknown?: string[];
		next: string;
	}
	| {
		ok: true;
		operation: "build";
		documents: OrchestratedBuildOutcome[];
		unknown?: string[];
		index?: IndexOutcome;
		next: string;
	}
	| { ok: true; operation: "index"; documents: CreatedDocumentState[]; index: IndexOutcome }
	| {
		ok: false;
		reason: string;
		message: string;
		currentRevision?: number;
		status?: string;
		resolver?: string;
	};

const REFUSALS: Record<string, string> = {
	"sign-in-required": "The person who asked has no live Chopin login in a browser, so their "
		+ "access can't be checked. Ask them to open Chopin and try again.",
	"repository-forbidden": "The person who asked can't write to this repository.",
	"document-unavailable": "This document is archived, deleted or closing.",
	"nothing-created": "No document was created from this one.",
	"target-not-created": "The target document was not created from this document.",
	"decisions-unavailable": "Decision reading is unavailable in this environment.",
	"answer-unavailable": "Decision answering is unavailable in this environment.",
	"builds-unavailable": "Starting builds is unavailable in this environment.",
};

function refused(reason: string, message?: string): OrchestrateResult {
	return { ok: false, reason, message: message ?? REFUSALS[reason] ?? reason };
}

function answerRefusalMessage(refusal: AnswerDecisionRefusal): string {
	switch (refusal.code) {
		case "invalid-answer":
			return refusal.message;
		case "idempotency-conflict":
			return "This idempotencyKey was already used with a different answer payload.";
		case "unknown-decision":
			return "No decision with this card ID or question ID exists in the target document.";
		case "implementation-active":
			return "An implementation is currently active on the target document.";
		case "paused":
			return "This decision is paused pending verification.";
		case "already-settled":
			return `This decision is already ${refusal.status}.`;
		case "state-diverged":
			return "This open decision's collaborative draft is missing; reload or repair the document.";
		case "stale":
			return `The decision moved on to revision ${refusal.currentRevision}; read decisions again and retry.`;
		case "draft-in-progress":
			return `A collaborator is currently editing this decision (revision ${refusal.currentRevision}).`;
		case "document-archived":
			return "The target document is archived.";
		case "repository-forbidden":
			return "Repository write access is required to answer decisions.";
		case "document-unavailable":
			return "The target document is unavailable.";
	}
}

/** `work` over `items`, at most `CONCURRENCY` at once, results in the items' order. */
async function bounded<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
	let results: R[] = [];
	let next = 0;
	let worker = async () => {
		while (next < items.length) {
			let index = next++;
			results[index] = await work(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
	return results;
}

function url(deps: OrchestrateDeps, channel: ChannelRecord): string {
	return new URL(
		documentPath(channel.repositoryOwner, channel.repositoryName, channel.slug),
		deps.appOrigin,
	).href;
}

/** The documents `source` created that are still its repository's, top-level and unarchived. */
async function created(deps: OrchestrateDeps, source: ChannelRecord): Promise<ChannelRecord[]> {
	return (await deps.createdFrom(source.id, MAX_CREATED)).filter(channel =>
		channel.id !== source.id
		&& channel.createdFrom === source.id
		&& channel.repositoryId === source.repositoryId
		&& !channel.parentChannelId
		&& !channel.archivedAt
		&& !deps.deleting(channel.id)
	);
}

async function states(
	deps: OrchestrateDeps,
	source: ChannelRecord,
): Promise<CreatedDocumentState[]> {
	return Promise.all((await created(deps, source)).map(async channel => ({
		id: channel.id,
		title: channel.title,
		url: url(deps, channel),
		planner: deps.planner(channel.id),
		openDecisions: channel.unansweredDecisions,
		build: await deps.build(channel.id),
	})));
}

/** Whether `wanted`, an id or a url, names `channel`. */
function names(deps: OrchestrateDeps, channel: ChannelRecord, wanted: string): boolean {
	let key = wanted.trim().replace(/\/+$/, "");
	return key === channel.id || key === url(deps, channel)
		|| key === documentPath(channel.repositoryOwner, channel.repositoryName, channel.slug);
}

async function authorizeWrite(
	deps: OrchestrateDeps,
	request: OrchestrateRequest,
	source: ChannelRecord,
): Promise<OrchestrateWriteAuthority> {
	if (deps.authorize) return deps.authorize(source);
	let { creator } = request;
	let login = await deps.login(creator.userId, creator.claimantSessionId);
	if (!login || login.user.id !== creator.userId) {
		return { ok: false, reason: "sign-in-required" };
	}
	let repository = await deps.repository(login, source.repositoryOwner, source.repositoryName);
	if (!repository || !writes(repository, source.repositoryId)) {
		return { ok: false, reason: "repository-forbidden" };
	}
	return {
		ok: true,
		user: { id: login.user.id, login: login.user.login, avatarUrl: login.user.avatarUrl },
		repository,
		session: login,
	};
}

async function listDecisions(
	deps: OrchestrateDeps,
	source: ChannelRecord,
	args: Extract<OrchestrateArguments, { operation: "decisions" }>,
): Promise<OrchestrateResult> {
	if (!deps.decisions) return refused("decisions-unavailable");
	let all = await created(deps, source);
	let unknown = args.targets?.filter(wanted => !all.some(channel => names(deps, channel, wanted)));
	let chosen = args.targets
		? all.filter(channel => args.targets!.some(wanted => names(deps, channel, wanted)))
		: all;
	let filter: DecisionFilter = {
		status: args.status ?? "all",
		...(args.origin ? { origin: args.origin } : {}),
	};
	let documents = await bounded(chosen, async (channel): Promise<OrchestratedDocumentDecisions> => {
		let read = await deps.decisions!(channel.id, filter);
		return {
			id: channel.id,
			title: channel.title,
			url: url(deps, channel),
			decisions: read.decisions,
			decisionCounts: read.decisionCounts,
		};
	});
	return {
		ok: true,
		operation: "decisions",
		documents,
		...(unknown?.length ? { unknown } : {}),
	};
}

async function answerTarget(
	deps: OrchestrateDeps,
	request: OrchestrateRequest,
	source: ChannelRecord,
	args: Extract<OrchestrateArguments, { operation: "answer" }>,
): Promise<OrchestrateResult> {
	if (!deps.answerDecision) return refused("answer-unavailable");
	let all = await created(deps, source);
	let target = all.find(channel => names(deps, channel, args.target));
	if (!target) return refused("target-not-created");
	let auth = await authorizeWrite(deps, request, source);
	if (!auth.ok) return refused(auth.reason);
	let outcome = await deps.answerDecision({
		channel: target,
		user: auth.user,
		decisionId: args.decisionId,
		revision: args.revision,
		idempotencyKey: args.idempotencyKey,
		...(args.optionIds !== undefined ? { optionIds: args.optionIds } : {}),
		...(args.text !== undefined ? { text: args.text } : {}),
		...(args.answers !== undefined ? { answers: args.answers } : {}),
	});
	if (outcome.kind === "refused") {
		let r = outcome.refusal;
		return {
			ok: false,
			reason: r.code,
			message: answerRefusalMessage(r),
			...("currentRevision" in r ? { currentRevision: r.currentRevision } : {}),
			...("status" in r ? { status: r.status } : {}),
			...("resolver" in r && r.resolver !== undefined ? { resolver: r.resolver } : {}),
		};
	}
	let index = await request.index(await states(deps, source), false);
	return {
		ok: true,
		operation: "answer",
		target: { id: target.id, title: target.title, url: url(deps, target) },
		...outcome.result,
		...(index.state === "absent" ? {} : { index }),
	};
}

async function instruct(
	deps: OrchestrateDeps,
	request: OrchestrateRequest,
	source: ChannelRecord,
	args: Extract<OrchestrateArguments, { operation: "instruct" }>,
): Promise<OrchestrateResult> {
	let all = await created(deps, source);
	if (all.length === 0) return refused("nothing-created");
	let unknown = args.targets?.filter(wanted => !all.some(channel => names(deps, channel, wanted)));
	let chosen = args.targets
		? all.filter(channel => args.targets!.some(wanted => names(deps, channel, wanted)))
		: all;
	let auth = await authorizeWrite(deps, request, source);
	if (!auth.ok) return refused(auth.reason);
	let hosted: HostedRepository = {
		id: auth.repository.id,
		owner: auth.repository.owner,
		name: auth.repository.name,
		defaultBranch: auth.repository.defaultBranch,
	};
	let documents = await bounded(chosen, async (channel): Promise<Instructed> => {
		let shown = { id: channel.id, title: channel.title, url: url(deps, channel) };
		if (request.signal?.aborted) return { ...shown, started: false, reason: "cancelled" };
		let wasWorking = deps.planner(channel.id) === "working";
		let code: InvokePlannerError | undefined;
		try {
			code = await deps.invoke({
				channel,
				repository: hosted,
				user: auth.user,
				...(auth.session ? { session: auth.session } : {}),
				instruction: args.instruction,
			});
		} catch (err) {
			console.error("[chat] instructing a created document's Planner failed:", err);
			code = "planner-unavailable";
		}
		if (!code) {
			return { ...shown, started: true, ...(wasWorking ? { steered: true as const } : {}) };
		}
		let message = await deps.refusal?.(code, channel, shown.url);
		return { ...shown, started: false, reason: code, ...(message ? { message } : {}) };
	});
	return {
		ok: true,
		operation: "instruct",
		documents,
		...(unknown?.length ? { unknown } : {}),
		next: "Each started or steered Planner runs on its own; this turn need not wait for them. "
			+ "Tell the person which started or received the nudge, with their links, and why any "
			+ "did not. A Planner refused as busy (on a non-steerable harness) can be instructed "
			+ "again once its turn ends.",
	};
}

async function buildTargets(
	deps: OrchestrateDeps,
	request: OrchestrateRequest,
	source: ChannelRecord,
	args: Extract<OrchestrateArguments, { operation: "build" }>,
): Promise<OrchestrateResult> {
	if (!deps.startBuild) return refused("builds-unavailable");
	let all = await created(deps, source);
	if (all.length === 0) return refused("nothing-created");
	let unknown = args.targets?.filter(wanted => !all.some(channel => names(deps, channel, wanted)));
	let chosen = args.targets
		? all.filter(channel => args.targets!.some(wanted => names(deps, channel, wanted)))
		: all;
	let auth = await authorizeWrite(deps, request, source);
	if (!auth.ok) return refused(auth.reason);
	let hosted: HostedRepository = {
		id: auth.repository.id,
		owner: auth.repository.owner,
		name: auth.repository.name,
		defaultBranch: auth.repository.defaultBranch,
	};
	let documents = await bounded(chosen, async (channel): Promise<OrchestratedBuildOutcome> => {
		let shown = { id: channel.id, title: channel.title, url: url(deps, channel) };
		if (request.signal?.aborted) return { ...shown, status: "refused", reason: "cancelled" };
		let outcome: StartPlanBuildResult;
		try {
			outcome = await deps.startBuild!({
				channel,
				repository: hosted,
				user: auth.user,
				...(auth.session ? { session: auth.session } : {}),
				...(args.draftIfNeeded !== undefined ? { draftIfNeeded: args.draftIfNeeded } : {}),
				...(args.requireSettledDecisions !== undefined
					? { requireSettledDecisions: args.requireSettledDecisions }
					: {}),
				...(args.retry !== undefined ? { retry: args.retry } : {}),
				...(args.rebuild !== undefined ? { rebuild: args.rebuild } : {}),
			});
		} catch (err) {
			console.error("[chat] building a created document failed:", err);
			return { ...shown, status: "refused", reason: "planner-unavailable" };
		}
		if (outcome.status === "drafting") {
			return { ...shown, status: "drafting", planRevision: outcome.planRevision };
		}
		if (outcome.status !== "refused") {
			return { ...shown, status: outcome.status, build: outcome.build };
		}
		return {
			...shown,
			status: "refused",
			reason: outcome.code,
			...(outcome.message ? { message: outcome.message } : {}),
			...(outcome.build ? { build: outcome.build } : {}),
			...(outcome.revision !== undefined ? { revision: outcome.revision } : {}),
			...(outcome.planRevision !== undefined ? { planRevision: outcome.planRevision } : {}),
			...(outcome.blockers ? { blockers: outcome.blockers } : {}),
			...(outcome.openDecisions ? { openDecisions: outcome.openDecisions } : {}),
		};
	});
	let index = await request.index(await states(deps, source), false);
	return {
		ok: true,
		operation: "build",
		documents,
		...(unknown?.length ? { unknown } : {}),
		...(index.state === "absent" ? {} : { index }),
		next: "Tell the person which documents started building, are drafting tasks first, were "
			+ "already building, or were refused, with their links.",
	};
}

export async function orchestrate(
	deps: OrchestrateDeps,
	request: OrchestrateRequest,
): Promise<OrchestrateResult> {
	let source = await deps.channel(request.sourceId);
	if (!source || source.archivedAt || deps.deleting(source.id) || source.parentChannelId) {
		return refused("document-unavailable");
	}
	let args = request.arguments;
	if (args.operation === "open") {
		let opener = deps.openDocument
			?? ((req: NewDocumentRequest) => createNewDocument(deps, req));
		let documents = await bounded(args.documents, async document => ({
			idempotencyKey: document.idempotencyKey,
			...await opener({ ...request, arguments: document }),
		}));
		let index = await request.index(await states(deps, source), false);
		return {
			ok: true,
			operation: "open",
			documents,
			...(index.state === "absent" ? {} : { index }),
			next: "Tell the person what was created, with each link. A document refused can be "
				+ "opened again with the same idempotencyKey; one already made is returned, not made "
				+ "twice.",
		};
	}
	if (args.operation === "decisions") return listDecisions(deps, source, args);
	if (args.operation === "answer") return answerTarget(deps, request, source, args);
	if (args.operation === "instruct") return instruct(deps, request, source, args);
	if (args.operation === "build") return buildTargets(deps, request, source, args);
	let documents = await states(deps, source);
	let index = await request.index(documents, args.operation === "index");
	if (args.operation === "index") return { ok: true, operation: "index", documents, index };
	return { ok: true, operation: "list", documents, ...(index.state === "absent" ? {} : { index }) };
}
