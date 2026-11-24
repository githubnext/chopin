/**
 * The Planner's `orchestrate`: one document's Planner working with the documents it created.
 *
 * `open` creates several documents at once, each exactly as `create_document` would; `list` reads
 * each created document's state as Chopin holds it; `instruct` hands their Planners one instruction
 * as the requesting person's message, starting any that is not running; `index` keeps a table of
 * them in this document. A document belongs here only while its stored `createdFrom` names this
 * one, so a turn can never reach a document it did not create.
 */
import { documentPath } from "@chopin/protocol/document-url";

import {
	createNewDocument,
	MAX_INSTRUCTION_BYTES,
	NEW_DOCUMENT_SCHEMA,
	newDocumentArguments,
	writes,
} from "./new-documents";

import type { BuildRequest } from "@chopin/protocol/implementation";
import type { HostedRepository } from "./repository";
import type { InvokePlannerError } from "../mcp";
import type {
	NewDocumentArguments,
	NewDocumentDeps,
	NewDocumentRequest,
	NewDocumentResult,
} from "./new-documents";
import type { ChannelRecord } from "../storage/model";

/** Most documents one `open` creates. */
export const MAX_OPEN = 20;
/** Most created documents one call lists, instructs or indexes. */
export const MAX_CREATED = 200;
/** How many documents are created, or Planners instructed, at once. */
const CONCURRENCY = 4;

export const ORCHESTRATE_OPERATIONS = ["open", "list", "instruct", "index"] as const;

export type OrchestrateArguments =
	| { operation: "open"; documents: NewDocumentArguments[] }
	| { operation: "list" }
	| { operation: "instruct"; instruction: string; targets?: string[] }
	| { operation: "index" };

export const ORCHESTRATE_SCHEMA = {
	type: "object",
	properties: {
		operation: {
			type: "string",
			enum: [...ORCHESTRATE_OPERATIONS],
			description: "`open` creates documents from `documents`; `list` reports every document "
				+ "this one created, with its Planner, open Decisions and build; `instruct` sends "
				+ "`instruction` to their Planners; `index` writes or refreshes their table in this "
				+ "document.",
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
			description: "For `instruct` only: the documents to instruct, each by the id or url "
				+ "`list` gives. Omit to instruct every document this one created.",
		},
	},
	required: ["operation"],
	additionalProperties: false,
};

const FIELDS: Record<OrchestrateArguments["operation"], string[]> = {
	open: ["documents"],
	list: [],
	instruct: ["instruction", "targets"],
	index: [],
};

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
	if (op === "instruct") {
		let instruction = args.instruction;
		if (
			typeof instruction !== "string" || !instruction.trim()
			|| Buffer.byteLength(instruction, "utf8") > MAX_INSTRUCTION_BYTES
		) throw new Error("instruct needs an instruction of non-empty text of at most 64 KiB");
		if (args.targets === undefined) return { operation: op, instruction };
		if (
			!Array.isArray(args.targets) || args.targets.length === 0
			|| args.targets.length > MAX_CREATED
			|| args.targets.some(target => typeof target !== "string" || !target.trim())
		) throw new Error("targets must list the documents to instruct, each by id or url");
		return { operation: op, instruction, targets: args.targets as string[] };
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

export type OrchestrateDeps = NewDocumentDeps & {
	/** Unarchived documents created from a document, oldest first. */
	createdFrom: (sourceId: string, limit: number) => Promise<ChannelRecord[]>;
	planner: (channelId: string) => PlannerState;
	build: (channelId: string) => Promise<BuildState>;
};

export type OrchestrateRequest = Omit<NewDocumentRequest, "arguments"> & {
	arguments: OrchestrateArguments;
	index: IndexWriter;
};

type Instructed =
	& Pick<CreatedDocumentState, "id" | "title" | "url">
	& ({ started: true } | { started: false; reason: string; message?: string });

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
		operation: "instruct";
		documents: Instructed[];
		unknown?: string[];
		next: string;
	}
	| { ok: true; operation: "index"; documents: CreatedDocumentState[]; index: IndexOutcome }
	| { ok: false; reason: string; message: string };

const REFUSALS: Record<string, string> = {
	"sign-in-required": "The person who asked has no live Chopin login in a browser, so their "
		+ "access can't be checked. Ask them to open Chopin and try again.",
	"repository-forbidden": "The person who asked can't write to this repository, so no Planner "
		+ "was instructed.",
	"document-unavailable": "This document is archived, deleted or closing.",
	"nothing-created": "No document was created from this one, so there is nothing to instruct.",
};

function refused(reason: string): OrchestrateResult {
	return { ok: false, reason, message: REFUSALS[reason]! };
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
		channel.createdFrom === source.id && channel.repositoryId === source.repositoryId
		&& !channel.parentChannelId && !channel.archivedAt && !deps.deleting(channel.id)
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
	let { creator } = request;
	let login = await deps.login(creator.userId, creator.claimantSessionId);
	if (!login || login.user.id !== creator.userId) return refused("sign-in-required");
	let repository = await deps.repository(login, source.repositoryOwner, source.repositoryName);
	if (!repository || !writes(repository, source.repositoryId)) {
		return refused("repository-forbidden");
	}
	let hosted: HostedRepository = {
		id: repository.id,
		owner: repository.owner,
		name: repository.name,
		defaultBranch: repository.defaultBranch,
	};
	let documents = await bounded(chosen, async (channel): Promise<Instructed> => {
		let shown = { id: channel.id, title: channel.title, url: url(deps, channel) };
		if (request.signal?.aborted) return { ...shown, started: false, reason: "cancelled" };
		let code: InvokePlannerError | undefined;
		try {
			code = await deps.invoke({
				channel,
				repository: hosted,
				user: { id: login.user.id, login: login.user.login, avatarUrl: login.user.avatarUrl },
				session: login,
				instruction: args.instruction,
			});
		} catch (err) {
			console.error("[chat] instructing a created document's Planner failed:", err);
			code = "planner-unavailable";
		}
		if (!code) return { ...shown, started: true };
		let message = await deps.refusal?.(code, channel, shown.url);
		return { ...shown, started: false, reason: code, ...(message ? { message } : {}) };
	});
	return {
		ok: true,
		operation: "instruct",
		documents,
		...(unknown?.length ? { unknown } : {}),
		next: "Each started Planner runs on its own; this turn need not wait for them. Tell the "
			+ "person which started, with their links, and why any did not. A Planner refused as "
			+ "busy can be instructed again once its turn ends.",
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
		let documents = await bounded(args.documents, async document => ({
			idempotencyKey: document.idempotencyKey,
			...await createNewDocument(deps, { ...request, arguments: document }),
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
	if (args.operation === "instruct") return instruct(deps, request, source, args);
	let documents = await states(deps, source);
	let index = await request.index(documents, args.operation === "index");
	if (args.operation === "index") return { ok: true, operation: "index", documents, index };
	return { ok: true, operation: "list", documents, ...(index.state === "absent" ? {} : { index }) };
}
