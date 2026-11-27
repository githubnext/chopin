import { displayTitle, documentTitleText, parse } from "@chopin/dialect";
import { createHash } from "node:crypto";

import {
	documentPath,
	parseChildDocumentPath,
	parseDocumentPath,
} from "@chopin/protocol/document-url";

import { ownOrigin } from "../auth/config";
import { documentUrl } from "../channels/document-url";
import { CANNOT_STEER } from "../chat/steering";
import { notAttachedMessage } from "../harness/remote/attachments";
import { deterministicChannelId, isChannelId } from "../channels/id";
import { documentSlug } from "../channels/slug";
import { claimsMcpToken } from "../experiments/mcp-token";
import { GitHubError } from "../github/client";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import * as Rooms from "../rooms";
import { claimImplementation, reportImplementationLifecycle } from "../tasks/plan-graphs";
import { StorageError } from "../storage/errors";
import { implementationLifecycle } from "../tasks/lifecycle";
import { unapprovedContext } from "../tasks/open-decisions";
import { planSourceFor, withPlanSource } from "../tasks/plan-source";
import { imagePath } from "../images/format";
import { deterministicChannelId as deterministicId } from "../channels/id";
import { prepare as prepareCreate } from "./create";
import { answerDecisionFingerprint, IdempotentDecisionAnswers } from "./decisions";
import { IdempotentInvocations, invocationFingerprint } from "./invoke";
import { readDecisions } from "../questions/read-decisions";
import { buildState, orchestrate as runOrchestrate } from "../agent/orchestrate";
import { writeIndex } from "../agent/orchestrate-index";

import type { Server } from "bun";
import type { BuildRequest } from "@chopin/protocol/implementation";
import type { HostedAuth } from "../auth/routes";
import type { KeyedInvocation } from "./invoke";
import type { GitHubUser, Repository as GitHubRepository } from "../github/client";
import type { AuthenticatedSession } from "../auth/session";
import type { HostedRepository } from "../agent/repository";
import type { DocumentRoom } from "../agent/tools";
import type { IndexWriter, PlannerState } from "../agent/orchestrate";
import type { NewDocumentRequest, NewDocumentResult } from "../agent/new-documents";
import type {
	AnswerDecisionOutcome,
	DecisionAnswerPayload,
	DecisionReadRequest,
} from "./decisions";
import type { DecisionFilter, ReadDecisionsResult } from "../questions/read-decisions";
import type { settleIntent } from "../conversation-plan/prose-job";
import type { StartPlanBuildInput, StartPlanBuildResult } from "../tasks/start-build";
import type {
	DocumentSummary,
	Implementation,
	ImplementationInput,
	InvokePlannerError,
	McpOptions,
	RecordPlanSourceInput,
	RenameDocumentInput,
} from "../mcp";
import type { CreateDocumentInput } from "./create";
import type { UpdateClient, UpdateDocumentInput } from "./update";
import type { LifecycleArguments } from "./lifecycle";
import type {
	ChannelArchiveResult,
	ChannelRecord,
	CreateChannel,
	Lease,
	StoredChannel,
} from "../storage/model";
import type { ClaimResult, Run } from "../tasks/graphs";
import type { SocketData } from "../wire";
import type { PlanSource } from "../tasks/plan-source";

export type HostedCaller = {
	oauthToken: string;
	user: GitHubUser;
	signal?: AbortSignal;
	/**
	 * A launch's MCP token: the documents it may reach, in one repository, and how that
	 * repository's access is read (with the machine's own grant) instead of `oauthToken`.
	 */
	launch?: {
		repository(owner: string, name: string): Promise<GitHubRepository | undefined>;
		/** Whether the repository on GitHub has the commit, read with the machine's own grant. */
		hasCommit(owner: string, name: string, sha: string): Promise<boolean>;
		allows(channel: ChannelRecord): boolean;
	};
};

export type PlannerInvocation = {
	channel: ChannelRecord;
	repository: HostedRepository;
	user: GitHubUser;
	/** The caller's live browser login, which may claim ownership for a channel without one. */
	session?: AuthenticatedSession;
	instruction: string;
	/** Unverified; only the atomic harness reads it. */
	checkout?: string;
	/** An automatic follow-up shown in Chat as a system notice rather than the caller's message. */
	system?: boolean;
	/** The caller's idempotency key, settled against the root's Chat once the call is authorized. */
	keyed?: KeyedInvocation;
};

export type ImplementationPersistence = { lease(): Lease };
export type HostedCallbacks = {
	archiveChannel?: (channelId: string, now: Date) => Promise<ChannelArchiveResult>;
	restoreChannel?: (channelId: string, now: Date) => Promise<ChannelArchiveResult>;
	isChannelDeleting?: (channelId: string) => boolean;
	serializeDocument?: <T>(channelId: string, action: () => Promise<T>) => Promise<T>;
	onChannelRenamed?: (channel: ChannelRecord) => void;
	/** `create_document` created a document. */
	onChannelCreated?: (channel: ChannelRecord) => void;
	onDocumentPersisted?: (target: Plan.DocumentTarget) => void;
	invokePlanner?: (input: PlannerInvocation) => Promise<InvokePlannerError | undefined>;
	/** The caller an MCP token names while its launch is live; see `experiments/mcp-token.ts`. */
	launchCaller?: (token: string) => Promise<HostedCaller | undefined>;
	/** What `planner-not-attached` says for a document, at its URL; how to attach one by default. */
	plannerNotAttached?: (channelId: string, url: string, repository: string) => Promise<string>;
	/** Notified after a decision answer commits (for waking background prose follow-ups). */
	onDecisionCommitted?: (
		plan: Plan.Plan,
		intent: NonNullable<ReturnType<typeof settleIntent>>,
	) => void;
	/** Notified after an unawaited Planner decision is answered (durable Planner turn handoff). */
	onPlannerAnswer?: (channelId: string, decisionId: string, generation: number) => void;
	/** Optional shared idempotency coordinator for `answer_decision` and `orchestrate answer`. */
	decisionAnswers?: IdempotentDecisionAnswers;
	/** Shared build starter for MCP `build_plan` and `orchestrate build`. */
	startBuild?: (input: StartPlanBuildInput) => Promise<StartPlanBuildResult>;
	/** Reports the live Planner state of a document for `orchestrate list` / `instruct`. */
	plannerState?: (channelId: string) => PlannerState;
	/** Inherits a source document's Planner model choice when `orchestrate open` creates children. */
	modelChoice?: (from: string, userId: string) => Promise<CreateChannel["modelChoice"]>;
};

const BEARER = new RegExp("^Bearer ([A-Za-z0-9._~+/-]+=*)$", "i");

type Document = {
	id: string;
	title: string;
	description?: string;
	creation?: Plan.CreationMetadata;
	source: string;
	revision: number;
	archivedAt?: Date;
	url?: string;
};

type PublicDocument = Omit<Document, "archivedAt" | "creation" | "url"> & {
	brief?: Plan.CreationMetadata["brief"];
	archivedAt?: string;
};

function summary(channel: ChannelRecord): DocumentSummary {
	return {
		id: channel.id,
		title: channel.title,
		...(channel.description ? { description: channel.description.value } : {}),
		...(channel.archivedAt ? { archivedAt: channel.archivedAt.toISOString() } : {}),
	};
}

/** Strip durable idempotency and repository provenance from MCP responses. */
function document(value: Document & { url: string }): PublicDocument & { url: string };
function document(value: Document): PublicDocument;
function document(value: Document): PublicDocument & { url?: string } {
	return {
		id: value.id,
		title: value.title,
		...(value.description ? { description: value.description } : {}),
		...(value.creation ? { brief: value.creation.brief } : {}),
		source: value.source,
		revision: value.revision,
		...(value.archivedAt ? { archivedAt: value.archivedAt.toISOString() } : {}),
		...(value.url ? { url: value.url } : {}),
	};
}

function exposed(
	channel: ChannelRecord,
	state: Awaited<ReturnType<typeof Plan.readStored>>,
): Implementation | undefined {
	let version = state.graph?.versions.at(-1);
	if (
		!state.creation
		|| !version
		|| (version.state !== "approved" && version.state !== "locked")
	) {
		return undefined;
	}
	let lifecycle = state.graph && state.lifecycle
		? implementationLifecycle({
			graph: state.graph,
			execution: state.execution,
			lifecycle: state.lifecycle,
		})
		: undefined;
	return {
		document: document({
			id: channel.id,
			title: channel.title,
			...(channel.description ? { description: channel.description.value } : {}),
			creation: state.creation,
			source: state.source,
			revision: state.revision,
			archivedAt: channel.archivedAt,
		}),
		repository: {
			name: state.creation.origin.repository,
			baseBranch: state.creation.origin.baseBranch,
			baseCommit: state.creation.origin.baseCommit,
		},
		graph: version,
		execution: state.execution
			? { state: "active", run: state.execution }
			: { state: "idle" },
		activity: lifecycle?.activity,
		history: lifecycle?.history ?? [],
		...unapprovedContext(state.records ?? []),
		...withSource(planSourceFor(state.planSources ?? [], version.planRevision)),
	};
}

function withSource(planSource: PlanSource | undefined) {
	return planSource ? { planSource } : {};
}

function claimResult(value: ClaimResult) {
	return value.kind === "started"
		? { kind: "started" as const, run: value.run }
		: value;
}

type LocatorAuth = Pick<HostedAuth, "config" | "github" | "storage">;

async function directRepositoryFor(
	auth: LocatorAuth,
	caller: HostedCaller,
	owner: string,
	name: string,
) {
	try {
		if (caller.launch) return await caller.launch.repository(owner, name);
		return await auth.github.repository(caller.oauthToken, owner, name);
	} catch (err) {
		if (err instanceof GitHubError && (err.status === 403 || err.status === 404)) {
			return undefined;
		}
		throw err;
	}
}

/**
 * The document a locator names, by id, legacy channel URL, or document URL,
 * with the caller's own repository access; "forbidden" when it cannot read it,
 * or when the caller is a launch whose documents do not include it.
 */
export async function locateDocument(auth: LocatorAuth, caller: HostedCaller, locator: string) {
	let located = await locateAny(auth, caller, locator);
	return typeof located === "object" && caller.launch && !caller.launch.allows(located.channel)
		? "forbidden" as const
		: located;
}

async function locateAny(auth: LocatorAuth, caller: HostedCaller, locator: string) {
	let path: URL | undefined;
	try {
		path = new URL(locator, auth.config.origin);
	} catch {
		path = undefined;
	}
	// A link from before the deployment moved names the same document.
	let local = ownOrigin(auth.config, path?.origin) ? path!.pathname : undefined;
	let child = local === undefined ? undefined : parseChildDocumentPath(local);
	if (child) {
		let repository = await directRepositoryFor(auth, caller, child.owner, child.repository);
		if (!repository?.permissions.pull) return "forbidden" as const;
		let channel = await auth.storage.channels.resolve(
			repository.id,
			documentSlug(child.childSlug),
		);
		let parent = channel?.parentChannelId
			? await auth.storage.channels.resolve(repository.id, documentSlug(child.parentSlug))
			: undefined;
		return channel && parent?.id === channel.parentChannelId
			? { channel, repository }
			: undefined;
	}
	let parsed = local === undefined ? undefined : parseDocumentPath(local);
	if (parsed?.slug) {
		let repository = await directRepositoryFor(auth, caller, parsed.owner, parsed.repository);
		if (!repository?.permissions.pull) return "forbidden" as const;
		let channel = await auth.storage.channels.resolve(
			repository.id,
			documentSlug(parsed.slug),
		);
		return channel ? { channel, repository } : undefined;
	}

	let legacy = local === undefined
		? undefined
		: /^\/channels\/([0-9a-f-]{36})\/?$/i.exec(local);
	let id = legacy?.[1]?.toLowerCase();
	let channel = await auth.storage.channels.get(id && isChannelId(id) ? id : locator);
	if (!channel) return undefined;
	let repository = await directRepositoryFor(
		auth,
		caller,
		channel.repositoryOwner,
		channel.repositoryName,
	);
	if (!repository?.permissions.pull || repository.id !== channel.repositoryId) {
		return "forbidden" as const;
	}
	return { channel, repository };
}

/** Who is creating a document, already allowed to write `repository`. */
export type DocumentCreator = {
	user: GitHubUser;
	repository: GitHubRepository;
	/** The Planner model choice to store in the transaction that creates the document. */
	modelChoice?: () => Promise<CreateChannel["modelChoice"]>;
	/** The document whose Planner creates this one, stored as its `createdFrom`. */
	createdFrom?: string;
	signal?: AbortSignal;
};

export type CreatedDocument =
	| {
		kind: "created" | "replayed";
		document: PublicDocument & { url: string };
		channel: ChannelRecord;
	}
	| { kind: "conflict" }
	| { kind: "title-taken" }
	| { kind: "forbidden" }
	| { kind: "unavailable" };

/**
 * Create a top-level document from a prepared draft, or return the one an earlier call with the
 * same idempotency key made. The document is stored before anyone is told of it.
 */
export async function createDocument(
	auth: Pick<HostedAuth, "storage" | "clock">,
	callbacks: Pick<
		HostedCallbacks,
		"isChannelDeleting" | "onChannelCreated" | "onDocumentPersisted"
	>,
	creator: DocumentCreator,
	input: CreateDocumentInput,
): Promise<CreatedDocument> {
	let { repository, signal, user } = creator;
	let id = deterministicChannelId(repository.id, input.idempotencyKey);
	if (callbacks.isChannelDeleting?.(id)) return { kind: "unavailable" };
	let replay = async (stored: StoredChannel): Promise<CreatedDocument> => {
		if (stored.channel.repositoryId !== repository.id) return { kind: "conflict" };
		let restored = await Plan.readStored(stored);
		if (
			!restored.creation
			|| restored.creation.origin.idempotencyKey !== input.idempotencyKey
			|| restored.creation.origin.fingerprint !== input.fingerprint
		) return { kind: "conflict" };
		callbacks.onDocumentPersisted?.({
			channelId: id,
			revision: restored.revision,
			source: restored.source,
			sourceHash: Plan.sourceHash(restored.source),
		});
		return {
			kind: "replayed",
			channel: stored.channel,
			document: document({
				id,
				title: stored.channel.title,
				...(stored.channel.description ? { description: stored.channel.description.value } : {}),
				creation: restored.creation,
				source: restored.source,
				revision: restored.revision,
				archivedAt: stored.channel.archivedAt,
				url: documentPath(repository.owner, repository.name, stored.channel.slug),
			}),
		};
	};
	let stored = await auth.storage.collaboration.load(id, auth.clock());
	if (stored) return replay(stored);
	if (signal?.aborted) return { kind: "unavailable" };
	await auth.storage.users.put({
		id: user.id,
		login: user.login,
		avatarUrl: user.avatarUrl,
		now: auth.clock(),
	});
	let { brief, plan, ...origin } = input;
	let creation: Plan.CreationMetadata = { brief, origin };
	let initial = await Plan.initial(plan, creation, input.title);
	let modelChoice = await creator.modelChoice?.();
	let created: ChannelRecord;
	try {
		created = await auth.storage.channels.create({
			id,
			repositoryId: repository.id,
			repositoryOwner: repository.owner,
			repositoryName: repository.name,
			title: displayTitle(documentTitleText(parse(initial.source)) ?? input.title),
			createdBy: user.id,
			now: auth.clock(),
			initial,
			...(modelChoice ? { modelChoice } : {}),
			...(creator.createdFrom ? { createdFrom: creator.createdFrom } : {}),
		});
	} catch (err) {
		if (!(err instanceof StorageError) || err.failure !== "conflict") throw err;
		if (callbacks.isChannelDeleting?.(id)) return { kind: "unavailable" };
		let stored = await auth.storage.collaboration.load(id, auth.clock());
		// Nothing stored under this key's id: the repository already has a document with this title.
		if (!stored) return { kind: "title-taken" };
		return replay(stored);
	}
	callbacks.onChannelCreated?.(created);
	callbacks.onDocumentPersisted?.({
		channelId: id,
		revision: 0,
		source: initial.source,
		sourceHash: initial.sourceHash,
	});
	return {
		kind: "created",
		channel: created,
		document: document({
			id,
			title: created.title,
			...(created.description ? { description: created.description.value } : {}),
			creation,
			source: initial.source,
			revision: 0,
			url: documentPath(repository.owner, repository.name, created.slug),
		}),
	};
}

const MAX_MCP_SESSION_ID = 128;
/** A session seen this recently is not written again. */
const MCP_SESSION_TOUCH_MS = 60_000;
/** An MCP session nobody used for this long is forgotten with the expired login sessions. */
export const MCP_SESSION_IDLE_MS = 30 * 24 * 60 * 60_000;

/** Bind the backend-neutral MCP surface to hosted GitHub authentication. */
export function hosted(
	auth: HostedAuth,
	persistence?: ImplementationPersistence,
	callbacks: HostedCallbacks = {},
): McpOptions<HostedCaller> {
	let directRepository = (caller: HostedCaller, owner: string, name: string) =>
		directRepositoryFor(auth, caller, owner, name);
	let locatedChannel = (caller: HostedCaller, locator: string) =>
		locateDocument(auth, caller, locator);

	async function writableChannel(caller: HostedCaller, locator: string) {
		let located = await locatedChannel(caller, locator);
		if (!located || located === "forbidden") return { kind: "unavailable" as const };
		if (callbacks.isChannelDeleting?.(located.channel.id)) {
			return { kind: "unavailable" as const };
		}
		if (!located.repository.permissions.push && !located.repository.permissions.admin) {
			return { kind: "forbidden" as const };
		}
		return { kind: "allowed" as const, ...located };
	}

	function run(caller: HostedCaller, input: ImplementationInput): Run {
		return {
			id: crypto.randomUUID(),
			user: caller.user.login,
			client: { name: input.client.name, version: input.client.version },
			session: input.client.session,
			planRevision: input.planRevision,
			graphVersion: input.graphVersion,
			graphRevision: input.graphRevision,
			repository: input.repository,
			branch: input.branch,
			commit: input.commit,
			startedAt: auth.clock().toISOString(),
		};
	}

	let documentOperations = new Map<string, Promise<void>>();
	function serializeDocument<T>(channelId: string, action: () => Promise<T>): Promise<T> {
		if (callbacks.serializeDocument) return callbacks.serializeDocument(channelId, action);
		let previous = documentOperations.get(channelId) ?? Promise.resolve();
		let operation = previous.then(action, action);
		let settled = operation.then(() => {}, () => {});
		documentOperations.set(channelId, settled);
		void settled.then(() => {
			if (documentOperations.get(channelId) === settled) documentOperations.delete(channelId);
		});
		return operation;
	}

	let silentServer = { publish() {} } as unknown as Server<SocketData>;
	let invocations = persistence
		&& new IdempotentInvocations(auth.storage.mcpInvocations, persistence.lease, auth.clock);
	let decisionAnswers = callbacks.decisionAnswers
		?? (persistence
			&& new IdempotentDecisionAnswers(auth.storage.mcpInvocations, persistence.lease, auth.clock));

	async function withOpenedPlan<T>(
		channelId: string,
		action: (plan: Plan.Plan) => Promise<T>,
	): Promise<T> {
		let live = Rooms.get(channelId)?.plan;
		if (live) {
			await Plan.drain(live);
			return action(live);
		}
		if (!persistence) throw new Error("document is unavailable");
		let opened = await Plan.open(channelId, {
			documentTitles: true,
			storage: auth.storage,
			lease: persistence.lease,
			fatal: error => {
				throw error;
			},
			onDocumentPersisted: callbacks.onDocumentPersisted,
			onChannelRenamed: callbacks.onChannelRenamed,
		}, silentServer);
		try {
			return await action(opened);
		} finally {
			await Plan.close(opened);
		}
	}

	async function withPlan<T>(
		channelId: string,
		action: (plan: Plan.Plan) => Promise<T>,
	): Promise<T> {
		return withOpenedPlan(channelId, plan => Plan.exclusive(plan, () => action(plan)));
	}

	async function readDocumentDecisions(
		channelId: string,
		filter?: DecisionFilter,
	): Promise<ReadDecisionsResult> {
		let live = Rooms.get(channelId)?.plan;
		if (live) {
			return Plan.exclusive(
				live,
				async () => readDecisions(live.records, live.questions, live.conversationPlan, filter),
			);
		}
		let stored = await auth.storage.collaboration.load(channelId, auth.clock());
		if (!stored) return readDecisions([], undefined, undefined, filter);
		let projected = await Plan.readStored(stored);
		return readDecisions(
			projected.records ?? [],
			projected.openQuestions,
			projected.conversationPlan,
			filter,
		);
	}

	async function answerChannelDecision(
		channel: ChannelRecord,
		user: GitHubUser,
		payload: DecisionAnswerPayload,
	): Promise<AnswerDecisionOutcome> {
		if (!decisionAnswers) throw new Error("storage writer lease is unavailable");
		return decisionAnswers.run(
			{ userId: user.id, channelId: channel.id, key: payload.idempotencyKey },
			answerDecisionFingerprint(payload),
			async () => {
				let current = await auth.storage.channels.get(channel.id);
				if (!current || callbacks.isChannelDeleting?.(channel.id)) {
					return { kind: "refused", refusal: { code: "document-unavailable" } };
				}
				if (current.archivedAt) {
					return { kind: "refused", refusal: { code: "document-archived" } };
				}
				try {
					return await serializeDocument(
						channel.id,
						() =>
							withOpenedPlan(channel.id, async plan => {
								let settled = await Questions.answerDecision(
									plan,
									plan.server,
									channel.id,
									{
										decisionId: payload.decisionId,
										revision: payload.revision,
										resolver: user.login,
										...(payload.optionIds !== undefined ? { optionIds: payload.optionIds } : {}),
										...(payload.text !== undefined ? { text: payload.text } : {}),
										...(payload.answers !== undefined ? { answers: payload.answers } : {}),
									},
									{
										onCommitted: intent => callbacks.onDecisionCommitted?.(plan, intent),
										onPlannerAnswer: (id, generation) =>
											callbacks.onPlannerAnswer?.(channel.id, id, generation),
									},
								);
								if (!settled.ok) {
									let { ok: _ok, ...refusal } = settled;
									return { kind: "refused" as const, refusal };
								}
								return {
									kind: "answered" as const,
									result: {
										status: "answered" as const,
										replayed: false,
										decisionId: settled.decisionId,
										committedAt: settled.committedAt,
										resolver: settled.resolver,
										answers: settled.answers,
										decision: settled.decision,
									},
								};
							}),
					);
				} catch (err) {
					if (err instanceof Error && err.message === "document is unavailable") {
						return { kind: "refused", refusal: { code: "document-unavailable" } };
					}
					if (err instanceof StorageError && err.failure === "missing") {
						return { kind: "refused", refusal: { code: "document-unavailable" } };
					}
					throw err;
				}
			},
		);
	}

	function plannerStateOf(channelId: string): PlannerState {
		if (callbacks.plannerState) return callbacks.plannerState(channelId);
		let chat = Rooms.get(channelId)?.plan?.chat;
		if (chat?.busy || chat?.starting) return "working";
		if (chat?.agent) return "idle";
		return "stopped";
	}

	async function buildStateOf(channelId: string) {
		let plan = Rooms.get(channelId)?.plan;
		if (plan) return buildState(plan);
		let stored = await auth.storage.collaboration.load(channelId, auth.clock());
		let sidecar = stored?.sidecar as { builds?: unknown; live?: unknown } | null | undefined;
		let builds = Array.isArray(sidecar?.builds) ? sidecar.builds as BuildRequest[] : [];
		return buildState({ builds, live: sidecar?.live });
	}

	return {
		sessions: {
			async create(caller, id, client) {
				let now = auth.clock();
				await auth.storage.mcpSessions.create({
					id,
					userId: caller.user.id,
					clientName: client.name,
					clientVersion: client.version,
					createdAt: now,
					lastSeenAt: now,
				});
			},
			async find(id) {
				if (id.length > MAX_MCP_SESSION_ID) return undefined;
				let found = await auth.storage.mcpSessions.find(id);
				if (!found) return undefined;
				let now = auth.clock();
				if (now.getTime() - found.lastSeenAt.getTime() >= MCP_SESSION_TOUCH_MS) {
					await auth.storage.mcpSessions.touch(id, now);
				}
				return { name: found.clientName, version: found.clientVersion };
			},
		},
		invoke: callbacks.invokePlanner
			? {
				async invoke(caller, input) {
					let located = await locatedChannel(caller, input.id);
					if (!located) return { kind: "refused", code: "document-unavailable" };
					if (
						located === "forbidden"
						|| (!located.repository.permissions.push && !located.repository.permissions.admin)
					) {
						return { kind: "refused", code: "repository-forbidden" };
					}
					let { channel, repository } = located;
					if (callbacks.isChannelDeleting?.(channel.id)) {
						return {
							kind: "refused",
							code: "document-unavailable",
						};
					}
					let document = {
						...summary(channel),
						url: new URL(await documentUrl(channel, auth.storage.channels), auth.config.origin)
							.href,
					};
					let deliver = async (keyed?: KeyedInvocation) => {
						if (channel.archivedAt) return { kind: "refused", code: "document-archived" } as const;
						let code = await callbacks.invokePlanner!({
							channel,
							repository,
							user: caller.user,
							session: await auth.sessions.forUser(caller.user.id),
							instruction: input.instruction,
							...(input.checkout === undefined ? {} : { checkout: input.checkout }),
							...(input.as === "system" ? { system: true } : {}),
							...(keyed ? { keyed } : {}),
						});
						if (code === "planner-not-attached") {
							let fullName = `${repository.owner}/${repository.name}`;
							return {
								kind: "refused",
								code,
								message: await callbacks.plannerNotAttached?.(channel.id, document.url, fullName)
									?? notAttachedMessage(document.url, fullName),
							} as const;
						}
						if (code === "planner-busy") {
							return { kind: "refused", code, message: CANNOT_STEER } as const;
						}
						if (code) return { kind: "refused", code } as const;
						return { kind: "invoked", document } as const;
					};
					if (input.idempotencyKey === undefined) return deliver();
					if (!invocations) throw new Error("storage writer lease is unavailable");
					return invocations.run(
						{ userId: caller.user.id, channelId: channel.id, key: input.idempotencyKey },
						invocationFingerprint(input, channel.id),
						{ document },
						deliver,
					);
				},
			}
			: undefined,
		async caller(request) {
			let match = request.headers.get("authorization")?.match(BEARER);
			if (!match) return undefined;
			let oauthToken = match[1]!;
			if (claimsMcpToken(oauthToken)) {
				let caller = await callbacks.launchCaller?.(oauthToken);
				return caller && { ...caller, signal: request.signal };
			}
			// A GitHub App installation token reaches GitHub only, never Chopin's tools; a launch's own
			// Planner or build credential reaches its link or its run, never `/mcp`.
			if (oauthToken.startsWith("ghs_") || oauthToken.startsWith("chopin_")) return undefined;
			try {
				return { oauthToken, user: await auth.admission.user(oauthToken), signal: request.signal };
			} catch (err) {
				if (err instanceof GitHubError && err.status === 401) return undefined;
				throw err;
			}
		},
		documents: {
			async list(caller, repository, includeArchived = false) {
				let parts = repository.split("/");
				if (parts.length !== 2 || !parts[0] || !parts[1]) return "forbidden";
				let resolved = await directRepository(caller, parts[0], parts[1]);
				if (!resolved?.permissions.pull) return "forbidden";

				let documents = [];
				let cursor;
				do {
					let page = await auth.storage.channels.scan(
						resolved.id,
						100,
						cursor,
						includeArchived,
					);
					documents.push(
						...page.channels.filter(channel => caller.launch?.allows(channel) ?? true).map(summary),
					);
					cursor = page.next;
				} while (cursor);
				return documents;
			},
			async read(caller, id, readOptions?: DecisionReadRequest) {
				let located = await locatedChannel(caller, id);
				if (!located || located === "forbidden") return undefined;
				let { channel } = located;
				let url = await documentUrl(channel, auth.storage.channels);
				let filter: DecisionFilter | undefined = readOptions?.includeDecisions
					? {
						...(readOptions.decisionStatus !== undefined
							? { status: readOptions.decisionStatus }
							: {}),
						...(readOptions.decisionOrigin !== undefined
							? { origin: readOptions.decisionOrigin }
							: {}),
					}
					: undefined;

				let live = Rooms.get(channel.id)?.plan;
				if (live) {
					try {
						return await Plan.exclusive(live, async () => {
							let base = document({
								id: channel.id,
								title: channel.title,
								...(channel.description ? { description: channel.description.value } : {}),
								creation: live.creation,
								source: Plan.source(live),
								revision: live.revision,
								archivedAt: channel.archivedAt,
								url,
							});
							if (!filter) return base;
							let { decisions, decisionCounts } = readDecisions(
								live.records,
								live.questions,
								live.conversationPlan,
								filter,
							);
							return { ...base, decisions, decisionCounts };
						});
					} catch {
						return undefined;
					}
				}

				let stored = await auth.storage.collaboration.load(channel.id, auth.clock());
				if (
					!stored
					|| stored.channel.id !== channel.id
					|| stored.channel.repositoryId !== channel.repositoryId
					|| stored.channel.repositoryOwner !== channel.repositoryOwner
					|| stored.channel.repositoryName !== channel.repositoryName
				) return undefined;
				try {
					let projected = await Plan.readStored(stored);
					let base = document({
						id: channel.id,
						title: channel.title,
						...(channel.description ? { description: channel.description.value } : {}),
						creation: projected.creation,
						source: projected.source,
						revision: projected.revision,
						archivedAt: channel.archivedAt,
						url,
					});
					if (!filter) return base;
					let { decisions, decisionCounts } = readDecisions(
						projected.records ?? [],
						projected.openQuestions,
						projected.conversationPlan,
						filter,
					);
					return { ...base, decisions, decisionCounts };
				} catch {
					return undefined;
				}
			},
		},
		rename: {
			async rename(caller, input: RenameDocumentInput) {
				let access = await writableChannel(caller, input.id);
				if (access.kind === "unavailable") return access;
				if (access.kind === "forbidden") {
					return { kind: "forbidden" as const };
				}
				if (access.channel.archivedAt) return { kind: "archived" as const };
				try {
					let result = await serializeDocument(
						access.channel.id,
						() => withPlan(access.channel.id, opened => Plan.rename(opened, input.title)),
					);
					return {
						kind: result.changed ? "renamed" as const : "unchanged" as const,
						document: summary(result.channel),
					};
				} catch (err) {
					if (err instanceof Plan.ImplementationActiveError) return { kind: "locked" as const };
					if (err instanceof StorageError && err.failure === "conflict") {
						let current = await auth.storage.channels.get(input.id);
						if (!current || callbacks.isChannelDeleting?.(input.id)) {
							return { kind: "unavailable" as const };
						}
						if (current.archivedAt) return { kind: "archived" as const };
						return { kind: "conflict" as const };
					}
					if (err instanceof StorageError && err.failure === "missing") {
						return { kind: "unavailable" as const };
					}
					throw err;
				}
			},
		},
		archive: {
			async archive(caller, id) {
				let access = await writableChannel(caller, id);
				if (access.kind !== "allowed") return access;
				try {
					let now = auth.clock();
					let result: ChannelArchiveResult;
					if (callbacks.archiveChannel) {
						result = await callbacks.archiveChannel(access.channel.id, now);
					} else if (persistence) {
						result = await auth.storage.channels.archive({
							id: access.channel.id,
							now,
							lease: persistence.lease(),
						});
					} else throw new Error("storage writer lease is unavailable");
					if (!result.channel.archivedAt) {
						throw new Error("archiving a document returned active metadata");
					}
					return {
						kind: result.changed ? "archived" as const : "unchanged" as const,
						document: summary(result.channel),
					};
				} catch (err) {
					if (err instanceof StorageError && err.failure === "missing") {
						return { kind: "unavailable" as const };
					}
					throw err;
				}
			},
		},
		restore: {
			async restore(caller, id) {
				let access = await writableChannel(caller, id);
				if (access.kind !== "allowed") return access;
				try {
					let now = auth.clock();
					let result = callbacks.restoreChannel
						? await callbacks.restoreChannel(access.channel.id, now)
						: await auth.storage.channels.restore({ id: access.channel.id, now });
					if (result.channel.archivedAt) {
						throw new Error("restoring a document returned archived metadata");
					}
					return {
						kind: result.changed ? "restored" as const : "unchanged" as const,
						document: summary(result.channel),
					};
				} catch (err) {
					if (err instanceof StorageError && err.failure === "missing") {
						return { kind: "unavailable" as const };
					}
					throw err;
				}
			},
		},
		create: {
			async create(caller, input) {
				let parts = input.repository.split("/");
				if (parts.length !== 2 || !parts[0] || !parts[1]) return { kind: "forbidden" };
				// A launch reaches only the documents it was started for, never a new one.
				if (caller.launch) return { kind: "forbidden" };
				let repository = await directRepository(caller, parts[0], parts[1]);
				if (!repository || (!repository.permissions.push && !repository.permissions.admin)) {
					return { kind: "forbidden" };
				}
				let outcome = await createDocument(auth, callbacks, {
					user: caller.user,
					repository,
					...(caller.signal ? { signal: caller.signal } : {}),
				}, input);
				if (outcome.kind !== "created" && outcome.kind !== "replayed") return outcome;
				return { kind: outcome.kind, document: outcome.document };
			},
		},
		update: {
			async update(caller, input: UpdateDocumentInput, client: UpdateClient) {
				let access = await writableChannel(caller, input.id);
				if (access.kind !== "allowed") return access;
				try {
					return await serializeDocument(access.channel.id, async () => {
						let current = await writableChannel(caller, access.channel.id);
						if (current.kind !== "allowed") return current;
						let { channel, repository } = current;
						return withPlan(channel.id, async plan => {
							let existing = plan.mcpUpdates.find(entry =>
								entry.idempotencyKey === input.idempotencyKey
							);
							if (existing) {
								return existing.fingerprint === input.fingerprint
									? {
										kind: "replayed" as const,
										document: document({
											id: channel.id,
											title: existing.document.title,
											...(existing.document.description
												? { description: existing.document.description }
												: {}),
											creation: plan.creation,
											source: existing.document.source,
											revision: existing.document.revision,
											url: existing.document.url,
										}),
									}
									: { kind: "conflict" as const };
							}
							if (channel.archivedAt) return { kind: "archived" as const };
							if (Plan.implementationActive(plan)) return { kind: "locked" as const };
							if (caller.signal?.aborted) return { kind: "unavailable" as const };
							// History credits the rewrite to this person, so they need a user row.
							await auth.storage.users.put({
								id: caller.user.id,
								login: caller.user.login,
								avatarUrl: caller.user.avatarUrl,
								now: auth.clock(),
							});
							if (input.revision !== plan.revision) {
								return {
									kind: "revision-conflict" as const,
									revision: plan.revision,
								};
							}

							let url = documentPath(repository.owner, repository.name, channel.slug);
							let outcome = await Plan.rewrite(plan, input.plan, (source, revision) => ({
								idempotencyKey: input.idempotencyKey,
								fingerprint: input.fingerprint,
								fromRevision: input.revision,
								client,
								document: {
									source,
									revision,
									title: channel.title,
									url,
									...(channel.description
										? { description: channel.description.value }
										: {}),
								},
							}), caller.user.id);
							if (!outcome.ok) {
								return outcome.reason === "stale"
									? {
										kind: "revision-conflict" as const,
										revision: outcome.revision,
									}
									: { kind: "protected" as const };
							}

							let receipt = plan.mcpUpdates.at(-1)!.document;
							Plan.changes(plan, plan.server, channel.id, outcome.changes, {
								cursor: false,
								attribution: {
									client,
									user: caller.user.login,
									fromRevision: input.revision,
									revision: plan.revision,
								},
							});
							Plan.anchors(plan, plan.server, channel.id);
							return {
								kind: "updated" as const,
								document: document({
									id: channel.id,
									title: receipt.title,
									...(channel.description
										? { description: channel.description.value }
										: {}),
									creation: plan.creation,
									source: Plan.source(plan),
									revision: plan.revision,
									url: receipt.url,
								}),
							};
						});
					});
				} catch (err) {
					if (err instanceof Error && err.message === "document is unavailable") {
						return { kind: "unavailable" as const };
					}
					if (err instanceof StorageError && err.failure === "missing") {
						return { kind: "unavailable" as const };
					}
					throw err;
				}
			},
		},
		upload: {
			async upload(caller, input) {
				let access = await writableChannel(caller, input.id);
				if (access.kind !== "allowed") return access;
				if (access.channel.archivedAt) return { kind: "archived" as const };
				let sha256 = createHash("sha256").update(input.bytes).digest("hex");
				try {
					await auth.storage.users.put({
						id: caller.user.id,
						login: caller.user.login,
						avatarUrl: caller.user.avatarUrl,
						now: auth.clock(),
					});
					await auth.storage.images.put({
						channelId: access.channel.id,
						sha256,
						mimeType: input.mimeType,
						bytes: input.bytes,
						uploadedBy: caller.user.id,
						now: auth.clock(),
					});
				} catch (err) {
					if (err instanceof StorageError && err.failure === "missing") {
						return { kind: "unavailable" as const };
					}
					throw err;
				}
				return { kind: "uploaded" as const, path: imagePath(sha256, input.mimeType) };
			},
		},
		...(persistence
			? {
				answerDecision: {
					async answer(caller, input) {
						let located = await locatedChannel(caller, input.id);
						if (!located) {
							return { kind: "refused", refusal: { code: "document-unavailable" } };
						}
						if (
							located === "forbidden"
							|| (!located.repository.permissions.push && !located.repository.permissions.admin)
						) {
							return { kind: "refused", refusal: { code: "repository-forbidden" } };
						}
						let { channel } = located;
						if (callbacks.isChannelDeleting?.(channel.id)) {
							return { kind: "refused", refusal: { code: "document-unavailable" } };
						}
						return answerChannelDecision(channel, caller.user, input);
					},
				},
				...(callbacks.startBuild
					? {
						buildPlan: {
							async build(caller, input) {
								let located = await locatedChannel(caller, input.id);
								if (!located) {
									return { status: "refused", code: "document-unavailable" };
								}
								if (
									located === "forbidden"
									|| (!located.repository.permissions.push
										&& !located.repository.permissions.admin)
								) {
									return { status: "refused", code: "repository-forbidden" };
								}
								let { channel, repository } = located;
								if (callbacks.isChannelDeleting?.(channel.id)) {
									return { status: "refused", code: "document-unavailable" };
								}
								await auth.storage.users.put({
									id: caller.user.id,
									login: caller.user.login,
									avatarUrl: caller.user.avatarUrl,
									now: auth.clock(),
								});
								let session = await auth.sessions.forUser(caller.user.id);
								return callbacks.startBuild!({
									channel,
									repository: {
										id: repository.id,
										owner: repository.owner,
										name: repository.name,
										defaultBranch: repository.defaultBranch,
									},
									user: caller.user,
									...(session ? { session } : {}),
									...(input.idempotencyKey !== undefined
										? { idempotencyKey: input.idempotencyKey }
										: {}),
									...(input.planRevision !== undefined
										? { planRevision: input.planRevision }
										: {}),
									...(input.requireSettledDecisions !== undefined
										? { requireSettledDecisions: input.requireSettledDecisions }
										: {}),
									...(input.draftIfNeeded !== undefined
										? { draftIfNeeded: input.draftIfNeeded }
										: {}),
									...(input.retry !== undefined ? { retry: input.retry } : {}),
									...(input.rebuild !== undefined ? { rebuild: input.rebuild } : {}),
								});
							},
						},
					}
					: {}),
				orchestrate: {
					async orchestrate(caller, { id, arguments: args }) {
						let located = await locatedChannel(caller, id);
						if (!located) {
							return {
								ok: false,
								reason: "document-unavailable",
								message: "The source document is unavailable.",
							};
						}
						if (located === "forbidden") {
							return {
								ok: false,
								reason: "repository-forbidden",
								message: "Repository access is required.",
							};
						}
						let { channel: source, repository } = located;
						if (
							callbacks.isChannelDeleting?.(source.id) || source.archivedAt
							|| source.parentChannelId
						) {
							return {
								ok: false,
								reason: "document-unavailable",
								message: "This document is archived, deleted or closing.",
							};
						}
						let canWrite = repository.permissions.push || repository.permissions.admin;
						let readOnlyOp = args.operation === "list" || args.operation === "decisions";
						if (!readOnlyOp && !canWrite) {
							return {
								ok: false,
								reason: "repository-forbidden",
								message: "Repository write access is required.",
							};
						}
						let writeMcpIndex: IndexWriter = async (documents, create) => {
							if (!canWrite) return { state: "absent" };
							return serializeDocument(source.id, () =>
								withOpenedPlan(source.id, async plan => {
									let room: DocumentRoom = {
										id: source.id,
										plan,
										server: plan.server,
										publish: mutation => Plan.publish(plan, plan.server, source.id, mutation),
										persist: () => Plan.persistExclusive(plan),
										exclusive: action => Plan.exclusive(plan, action),
										anchors: () => Plan.anchors(plan, plan.server, source.id),
										changes: found =>
											Plan.changes(plan, plan.server, source.id, found, { cursor: false }),
									};
									return writeIndex(room, documents, create, caller.signal);
								}));
						};
						let openViaMcp = async (req: NewDocumentRequest): Promise<NewDocumentResult> => {
							if (caller.launch) {
								return {
									ok: false,
									reason: "repository-forbidden",
									message: "A launch token cannot create new documents over MCP.",
								};
							}
							let owner = source.repositoryOwner;
							let name = source.repositoryName;
							let key = `planner:${source.id}:${req.arguments.idempotencyKey}`;
							let earlierId = deterministicId(source.repositoryId, key);
							let loadOrigin = async (channelId: string) => {
								let live = Rooms.get(channelId)?.plan;
								if (live) return live.creation?.origin;
								let stored = await auth.storage.collaboration.load(channelId, auth.clock());
								return stored ? (await Plan.readStored(stored)).creation?.origin : undefined;
							};
							let earlier = await loadOrigin(earlierId);
							let inherited = earlier ?? await loadOrigin(source.id);
							let base = inherited && (earlier || inherited.repository === `${owner}/${name}`)
								? { baseBranch: inherited.baseBranch, baseCommit: inherited.baseCommit }
								: undefined;
							if (!base) {
								if (!auth.github.branchHead) {
									return {
										ok: false,
										reason: "unavailable",
										message: "The base branch's commit cannot be read.",
									};
								}
								let baseBranch = repository.defaultBranch;
								let baseCommit = await auth.github.branchHead(
									caller.oauthToken,
									owner,
									name,
									baseBranch,
								);
								base = { baseBranch, baseCommit };
							}
							let prepared = prepareCreate({
								idempotencyKey: key,
								repository: `${owner}/${name}`,
								...base,
								title: req.arguments.title,
								brief: req.arguments.brief,
								plan: req.arguments.document,
							});
							if (!prepared) {
								return {
									ok: false,
									reason: "invalid-document",
									message: "title, brief and document must match the create_document schema",
								};
							}
							if ("issues" in prepared) {
								return {
									ok: false,
									reason: "invalid-document",
									message: "The document is not valid in the dialect.",
									issues: prepared.issues,
								};
							}
							let created = await createDocument(auth, callbacks, {
								user: caller.user,
								repository,
								...(callbacks.modelChoice
									? { modelChoice: () => callbacks.modelChoice!(source.id, caller.user.id) }
									: {}),
								createdFrom: source.id,
								...(caller.signal ? { signal: caller.signal } : {}),
							}, prepared.input);
							if (created.kind === "conflict") {
								return {
									ok: false,
									reason: "idempotency-conflict",
									message:
										"Another document was already created with this idempotencyKey and different content.",
								};
							}
							if (created.kind === "title-taken") {
								return {
									ok: false,
									reason: "title-taken",
									message: "The repository already has a document with this title.",
								};
							}
							if (created.kind === "forbidden") {
								return {
									ok: false,
									reason: "repository-forbidden",
									message: "Repository write access is required.",
								};
							}
							if (created.kind === "unavailable") {
								return {
									ok: false,
									reason: "unavailable",
									message: "The document could not be created now.",
								};
							}
							let url = new URL(created.document.url, auth.config.origin).href;
							let doc = { id: created.channel.id, title: created.channel.title, url };
							if (created.kind === "replayed") {
								return {
									ok: true,
									document: doc,
									replayed: true,
									next:
										"An earlier call with this idempotencyKey made this document; nothing new was created or started.",
								};
							}
							if (req.arguments.instruction === undefined) {
								return {
									ok: true,
									document: doc,
									next: "The document is created and listed in the repository.",
								};
							}
							if (!callbacks.invokePlanner) {
								return {
									ok: true,
									document: doc,
									instruction: { started: false, reason: "planner-unavailable" },
									next: "The document was created, but its Planner could not be started.",
								};
							}
							let session = await auth.sessions.forUser(caller.user.id);
							let code = await callbacks.invokePlanner({
								channel: created.channel,
								repository: {
									id: repository.id,
									owner: repository.owner,
									name: repository.name,
									defaultBranch: repository.defaultBranch,
								},
								user: caller.user,
								...(session ? { session } : {}),
								instruction: req.arguments.instruction,
							});
							if (code) {
								let message = code === "planner-busy"
									? CANNOT_STEER
									: code === "planner-not-attached"
									? await callbacks.plannerNotAttached?.(
										created.channel.id,
										url,
										`${repository.owner}/${repository.name}`,
									) ?? notAttachedMessage(url, `${repository.owner}/${repository.name}`)
									: undefined;
								return {
									ok: true,
									document: doc,
									instruction: { started: false, reason: code, ...(message ? { message } : {}) },
									next: "The document was created, but its Planner did not start.",
								};
							}
							return {
								ok: true,
								document: doc,
								instruction: { started: true },
								next: "The document was created and its Planner started on the instruction.",
							};
						};
						return runOrchestrate(
							{
								channel: channelId => auth.storage.channels.get(channelId),
								deleting: channelId => !!callbacks.isChannelDeleting?.(channelId),
								login: async () => await auth.sessions.forUser(caller.user.id),
								repository: async () => repository,
								branchHead: async () => {
									throw new Error("branchHead is handled by openDocument in MCP mode");
								},
								origin: async () => undefined,
								created: async () => undefined,
								create: async () => ({ kind: "unavailable" }),
								modelChoice: async () => undefined,
								invoke: async input =>
									callbacks.invokePlanner
										? callbacks.invokePlanner(input)
										: "planner-unavailable",
								refusal: async (code, channel, url) => {
									if (code === "planner-busy") return CANNOT_STEER;
									if (code !== "planner-not-attached") return undefined;
									let fullName = `${channel.repositoryOwner}/${channel.repositoryName}`;
									return await callbacks.plannerNotAttached?.(channel.id, url, fullName)
										?? notAttachedMessage(url, fullName);
								},
								appOrigin: auth.config.origin,
								createdFrom: async (sourceId, limit) =>
									(await auth.storage.channels.createdFrom(sourceId, limit))
										.filter(channel => caller.launch?.allows(channel) ?? true),
								planner: plannerStateOf,
								build: buildStateOf,
								decisions: readDocumentDecisions,
								answerDecision: input => answerChannelDecision(input.channel, input.user, input),
								...(callbacks.startBuild ? { startBuild: callbacks.startBuild } : {}),
								authorize: async () => {
									if (!canWrite) return { ok: false, reason: "repository-forbidden" };
									let session = await auth.sessions.forUser(caller.user.id);
									return {
										ok: true,
										user: caller.user,
										repository,
										...(session ? { session } : {}),
									};
								},
								openDocument: openViaMcp,
							},
							{
								sourceId: source.id,
								creator: { userId: caller.user.id, handle: caller.user.login },
								arguments: args,
								announce: async () => {},
								index: writeMcpIndex,
								...(caller.signal ? { signal: caller.signal } : {}),
							},
						);
					},
				},
				planSources: {
					async record(caller: HostedCaller, input: RecordPlanSourceInput) {
						let access = await writableChannel(caller, input.id);
						if (access.kind !== "allowed") return access;
						let { channel } = access;
						if (channel.archivedAt) return { kind: "archived" as const };
						let { revision, branch, commit } = input;
						let owner = channel.repositoryOwner;
						let name = channel.repositoryName;
						let present = caller.launch
							? await caller.launch.hasCommit(owner, name, commit)
							: await auth.github.hasCommit?.(caller.oauthToken, owner, name, commit);
						if (!present) return { kind: "unavailable-commit" as const };
						return serializeDocument(channel.id, () =>
							withPlan(channel.id, async plan => {
								if (revision > plan.revision) {
									return { kind: "revision-conflict" as const, revision: plan.revision };
								}
								let source = { revision, branch, commit };
								let next = withPlanSource(plan.planSources, source);
								if (next.changed) {
									let previous = plan.planSources;
									plan.planSources = next.sources;
									try {
										await Plan.persistExclusive(plan);
									} catch (err) {
										plan.planSources = previous;
										throw err;
									}
								}
								return { kind: "recorded" as const, source };
							}));
					},
				},
				implementations: {
					async readImplementation(caller: HostedCaller, id: string) {
						let located = await locatedChannel(caller, id);
						if (located === "forbidden") return "forbidden" as const;
						if (!located) return undefined;
						let { channel } = located;
						let live = Rooms.get(channel.id)?.plan;
						if (live) {
							return Plan.exclusive(live, async () =>
								exposed(channel, {
									source: Plan.source(live),
									revision: live.revision,
									records: [...live.records.values()],
									...(live.creation ? { creation: live.creation } : {}),
									...(live.graph ? { graph: live.graph } : {}),
									...(live.execution ? { execution: live.execution } : {}),
									lifecycle: live.lifecycle,
									planSources: live.planSources,
								}));
						}
						let stored = await auth.storage.collaboration.load(channel.id, auth.clock());
						return stored ? exposed(channel, await Plan.readStored(stored)) : undefined;
					},
					async startImplementation(caller: HostedCaller, input: ImplementationInput) {
						return serializeDocument(input.id, async () => {
							let access = await writableChannel(caller, input.id);
							if (access.kind !== "allowed") return access;
							let channel = access.channel;
							if (`${channel.repositoryOwner}/${channel.repositoryName}` !== input.repository) {
								return { kind: "forbidden" as const };
							}
							if (channel.archivedAt) {
								return { kind: "refused" as const, reason: "document-archived" };
							}
							let claimRun = run(caller, input);
							let live = Rooms.get(input.id)?.plan;
							if (live) {
								return claimResult(
									await claimImplementation(live, {
										planRevision: input.planRevision,
										graphRevision: input.graphRevision,
										run: claimRun,
									}),
								);
							}
							for (let attempt = 0; attempt < 2; attempt++) {
								if (callbacks.isChannelDeleting?.(input.id)) {
									return { kind: "unavailable" as const };
								}
								let stored = await auth.storage.collaboration.load(input.id, auth.clock());
								if (!stored) return { kind: "unavailable" as const };
								if (stored.channel.archivedAt) {
									return { kind: "refused" as const, reason: "document-archived" };
								}
								if (!stored.snapshot) return { kind: "refused" as const, reason: "missing" };
								let prepared = Plan.claimStored(stored, {
									planRevision: input.planRevision,
									graphRevision: input.graphRevision,
									run: claimRun,
								});
								if (prepared.result.kind !== "started" || !prepared.sidecar) {
									return claimResult(prepared.result);
								}
								try {
									await auth.storage.collaboration.commit({
										channelId: input.id,
										lease: persistence.lease(),
										expectedRevision: stored.channel.revision,
										operationId: `implementation:${claimRun.id}`,
										epoch: stored.snapshot.epoch,
										sidecar: prepared.sidecar,
										events: [],
										now: auth.clock(),
									});
									return claimResult(prepared.result);
								} catch (err) {
									if (err instanceof StorageError && err.failure === "missing") {
										return { kind: "unavailable" as const };
									}
									if (!(err instanceof StorageError) || err.failure !== "conflict") throw err;
								}
							}
							return { kind: "refused" as const, reason: "conflict" };
						});
					},
					async reportLifecycle(caller: HostedCaller, input: LifecycleArguments) {
						return serializeDocument(input.id, async () => {
							let access = await writableChannel(caller, input.id);
							if (access.kind !== "allowed") return access;
							let { id: _id, ...event } = input;
							let live = Rooms.get(input.id)?.plan;
							if (live) {
								let result = await reportImplementationLifecycle(live, event);
								if (result.kind === "refused") return result;
								return {
									kind: result.kind,
									lifecycle: implementationLifecycle({
										graph: result.state.graph,
										execution: result.state.execution,
										lifecycle: result.state.lifecycle,
									}),
								};
							}
							for (let attempt = 0; attempt < 2; attempt++) {
								if (callbacks.isChannelDeleting?.(input.id)) {
									return { kind: "unavailable" as const };
								}
								let stored = await auth.storage.collaboration.load(input.id, auth.clock());
								if (!stored) return { kind: "unavailable" as const };
								if (!stored.snapshot) return { kind: "refused" as const, reason: "inactive" };
								let prepared = Plan.lifecycleStored(stored, event);
								if (prepared.result.kind === "refused") return prepared.result;
								if (prepared.result.kind === "replayed") {
									return {
										kind: "replayed" as const,
										lifecycle: implementationLifecycle({
											graph: prepared.result.state.graph,
											execution: prepared.result.state.execution,
											lifecycle: prepared.result.state.lifecycle,
										}),
									};
								}
								if (!prepared.sidecar) return { kind: "refused" as const, reason: "inactive" };
								try {
									await auth.storage.collaboration.commit({
										channelId: input.id,
										lease: persistence.lease(),
										expectedRevision: stored.channel.revision,
										operationId: `lifecycle:${input.idempotencyKey}`,
										epoch: stored.snapshot.epoch,
										sidecar: prepared.sidecar,
										events: [],
										now: auth.clock(),
										allowArchived: true,
									});
									return {
										kind: "accepted" as const,
										lifecycle: implementationLifecycle({
											graph: prepared.result.state.graph,
											execution: prepared.result.state.execution,
											lifecycle: prepared.result.state.lifecycle,
										}),
									};
								} catch (err) {
									if (err instanceof StorageError && err.failure === "missing") {
										return { kind: "unavailable" as const };
									}
									if (!(err instanceof StorageError) || err.failure !== "conflict") throw err;
								}
							}
							return { kind: "refused" as const, reason: "conflict" };
						});
					},
				},
			}
			: {}),
	};
}
