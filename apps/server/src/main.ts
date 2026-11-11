import { registerImplementationRoutes } from "./tasks/routes";
import { draftInstruction, draftRefusal } from "./tasks/draft";
import { planningReadiness } from "./tasks/plan-graphs";
import { READINESS_INSTRUCTION } from "./tasks/readiness-instruction";
import { ReadinessReviews } from "./tasks/readiness-review";
/**
 * The server.
 *
 * One process: the WebSocket every room talks over, and — in production — the
 * built client alongside it. In development Vite serves the client and proxies
 * `/ws` here, so the browser sees one origin either way and the client never
 * needs to know which mode it is in.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { displayTitle, parse, ulid } from "@chopin/dialect";

import {
	harnessFor,
	plannerCatalog,
	plannerCommands,
	plannerOfferKnown,
	plannerRanWithoutOffer,
	shutdownHarnesses,
} from "./harness/harnesses";
import { chooseModel, publishModelState, turnModel, turnReadsImages } from "./chat/model-choice";
import type { ModelChoiceDeps } from "./chat/model-choice";
import {
	admitAgent,
	AGENT_UPGRADE_HEADERS,
	isAgentSocket,
	openAgentSocket,
} from "./harness/remote/endpoint";
import {
	disconnectedMessage,
	notAttachedMessage,
	PlannerAttachments,
	startingMessage,
} from "./harness/remote/attachments";
import type { PlannerAttachment } from "./harness/remote/attachments";
import { MachinePlanners } from "./harness/remote/machine-planners";
import { documentUrl } from "./channels/document-url";
import { ActiveOwnerBindings } from "./agent/active-owner";
import { registerAuthRoutes } from "./auth/routes";
import { registerExperimentRoutes } from "./experiments/routes";
import { attachmentLimits } from "./attachments/limits";
import { registerAttachmentRoutes } from "./attachments/routes";
import { registerImageRoutes } from "./images/routes";
import type { ExperimentRuntime } from "./experiments/routes";
import type { Instruction, ServerInstructionDeps } from "./chat/server-instruction";
import { fingerprint } from "./experiments/service";
import * as Chat from "./chat/service";
import { answerWake } from "./chat/wake";
import { plannerAttachment } from "./chat/planner-attachment";
import * as Initiative from "./chat/initiative";
import { deferralWiring, keepsRequests } from "./chat/deferred";
import { createChildDocuments } from "./chat/children";
import { createRootChat } from "./chat/root";
import { serverInstruction as runServerInstruction } from "./chat/server-instruction";
import { resolveChild } from "./chat/children";
import { CHAT_CAPABILITIES, incomingFrame, sidebarFrame } from "./chat/incoming";
import { registerMentionRoutes } from "./chat/mention-routes";
import { ReferenceService } from "./chat/references";
import { RepositoryFiles } from "./chat/repository-files";
import { createConversationRuntime } from "./conversation-plan/runtime";
import { createEditingUnlocked } from "./plan/editing-unlocked";
import { researchBriefDefinition } from "./jobs/research-brief";
import {
	greetJoinedPlan,
	prepareOpenedPlan,
	readyPlan,
	recoverAttachedPlan,
} from "./conversation-plan/service-opening";
import { handleConversationCommand } from "./conversation-plan/commands";
import { handleResearchCommand } from "./conversation-plan/research-commands";
import { startAcceptedResearch } from "./conversation-plan/accepted-research";
import { registerChannelRoutes } from "./channels/routes";
import { DocumentHistory } from "./channels/history";
import * as Comments from "./comments/service";
import { clientBuild, proxy, serve } from "./client";
import { describe, load } from "./config";
import { GitHubClient, GitHubError } from "./github/client";
import { plannerWorkspace } from "./harness/atomic/workspace";
import { GitHubReferences } from "./github/references";
import { builders, named, pictures, present } from "./people";
import { registerConnectorScript } from "./http/connector-script";
import { cut } from "./handover/cut";
import { acquireWhenFree } from "./handover/lease-wait";
import { abandonable, Requests } from "./handover/requests";
import { finishTurns } from "./handover/turns";
import { Readiness, registerHealthRoutes } from "./http/health";
import { registerMachinesPath } from "./http/machines-path";
import { Router } from "./http/router";
import { JobExecutionError, JobRegistry } from "./jobs/registry";
import * as JobBrowser from "./jobs/browser";
import { DocumentDescriptionProjector } from "./jobs/document-description";
import { documentSummaryDefinition } from "./jobs/document-summary";
import { versionSummaryDefinition, versionSummaryKey } from "./jobs/version-summary";
import { JobRunner } from "./jobs/runner";
import { researchAnswerDefinition, researchEvidenceDefinition } from "./jobs/research-workspace";
import { JobService } from "./jobs/service";
import { DocumentSummaryCoordinator } from "./jobs/summary-coordinator";
import { invokeRouted, SystemTurns } from "./mcp/invoke";
import { liveClassifier } from "./tasks/live-gate";
import { LiveSyncCoordinator } from "./tasks/live-sync";
import { heuristicJudge, jevJudge, SpikeScout } from "./experiments/spike-scout";
import { spikeHost } from "./experiments/spike-host";
import { spikeSettler, startSettle } from "./experiments/spike-settle";
import { resolveInstruction } from "./experiments/spikes";
import { openDecisions } from "./conversation-plan/decisions";
import { createVisualAdmission } from "./agent/visual-admission";
import { locksEditing, requestBuild } from "./tasks/builds";
import { pendingLinks, relinkInstruction } from "./tasks/relink";
import { BuildReadiness } from "./tasks/readiness";
import { MCP_SESSION_IDLE_MS } from "./mcp/hosted";
import { registerMcpRoutes } from "./mcp/routes";
import { registerNavigationRoutes } from "./navigation/routes";
import * as Edit from "./plan/edit";
import * as Service from "./plan/service";
import * as Inject from "./questions/inject";
import * as Marks from "./comments/inject";
import * as Questions from "./questions/service";
import * as Explore from "./questions/explore";
import { runningFindingRefs } from "./questions/service-findings";
import { answerTurns } from "./questions/answer-turns";
import { decisionGeneration } from "./questions/card-actions";
import { rejoinInput } from "./harness/atomic/human-input";
import type { RejoinHost } from "./harness/remote/link";
import { deterministicChannelId } from "./channels/id";
import type { Research as ResearchWire } from "@chopin/protocol";
import { investigationFinding } from "./experiments/document";
import { backfillPlannerAskThreads } from "./questions/backfill";
import { registerResearchWorkspaceRoutes } from "./research/routes";
import { demoRoster } from "./demo/roster";
import {
	researchJobSettles,
	ResearchWorkspaceError,
	ResearchWorkspaceService,
} from "./research/service";
import { placeResearchReference as placeResearch } from "./research/placement";
import * as Rooms from "./rooms";
import { admit, admitSidebar, refused } from "./socket/admission";
import { refreshAuthorization } from "./socket/authorization";
import {
	recheckDecisionWatch,
	releaseDecisionWatch,
	repositoryReader,
	unwatchDecisions,
	unwatchRequest,
	watchDecisions,
	watchRequest,
} from "./socket/decision-watch";
import { OpenSockets } from "./socket/open-sockets";
import { SessionSockets } from "./socket/session-sockets";
import { StorageError } from "./storage/errors";
import { createStorage } from "./storage/registry";
import { WriterLease } from "./storage/writer-lease";
import {
	broadcast,
	broadcastRepository,
	fail,
	PASSING,
	relay,
	reply,
	repositoryTopic,
	tell,
	topic,
} from "./wire";

import { AGENT_PATH, LINK_CLOSE } from "@chopin/agent-link";
import { SERVICE_RESTART } from "@chopin/protocol/restart";

import type { Server, ServerWebSocket } from "bun";
import type { AgentSocketData } from "./harness/remote/endpoint";
import type { RepositoryAuthorizer, WatchTopics } from "./socket/decision-watch";
import type { DocumentSummaryInput } from "./jobs/document-summary";
import type { JobDefinition } from "./jobs/registry";
import type { InvestigationPlacement } from "./plan/room";
import type { ChannelRecord, DeferredTurn, Lease, PlannerLinkHold } from "./storage/model";
import type {
	AuthorizationResult,
	SidebarSocket,
	SidebarSocketData,
	Socket,
	SocketData,
} from "./wire";

type ResearchRequestView = ResearchWire.RequestView;

const config = load();
/** What a message may carry in force now; none where the server takes no files. */
const chatAttachmentLimits = attachmentLimits(config);
/** The one decisions boundary, checked against Atomic's registry before anything starts. */
const decide = await openDecisions(config);
const visualAdmission = createVisualAdmission(decide);
harnessFor(config);
const storage = createStorage(config.storage);
const documentHistory = new DocumentHistory(storage);
const router = new Router();

/** Where the built client lands. Used only when there is no dev client. */
const CLIENT = config.clientDir ?? join(import.meta.dir, "../../web/dist");
/** What `session:hello` names as this server's client build; none in development. */
const CLIENT_BUILD = clientBuild(CLIENT);

/**
 * How long an empty room is kept before its document is released.
 *
 * A reload is a departure followed by an arrival, and discarding the document
 * in between would cost the epoch and everyone's undo history for a keypress.
 */
const EVICT_MS = 30_000;
const LEASE_TTL_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
const LEASE_SAFETY_MS = 5_000;
const LEASE_RETRY_MS = 1_000;
/** How often a process waiting for the writer lease reads it. */
const LEASE_POLL_MS = 100;
const SESSION_CLEANUP_MS = 5 * 60_000;
const ACCESS_RECHECK_MS = 60_000;
const RESEARCH_RECOVERY_RETRY_MS = 10_000;
/** How long `@chopin` and `invoke_planner` wait for a Planner a machine is starting. */
const PLANNER_START_MS = 30_000;

let server: Server<SocketData>;
const writerLease = new WriterLease(storage.leases, {
	ttlMs: LEASE_TTL_MS,
	renewMs: LEASE_RENEW_MS,
	safetyMs: LEASE_SAFETY_MS,
	retryMs: LEASE_RETRY_MS,
}, () => abandon());
const readiness = new Readiness(() => writerLease.held !== undefined, {
	standby: config.handover.wait,
});
/** The paths that need no lease, so a process waiting for it answers them at once. */
const HEALTH_PATHS = new Set(["/api/health/live", "/api/health/ready"]);
const requests = new Requests({
	holdMs: config.handover.holdMs,
	exempt: async (request, url) => {
		if (HEALTH_PATHS.has(url.pathname)) return true;
		if (request.method !== "GET" && request.method !== "HEAD") return false;
		if (url.pathname === "/" || url.pathname.startsWith("/assets/")) return !config.devClient;
		return !config.devClient && await Bun.file(join(CLIENT, url.pathname)).exists();
	},
});
let experiments: ExperimentRuntime | undefined;
let implementations: ReturnType<typeof registerImplementationRoutes> | undefined;
let experimentTimer: ReturnType<typeof setInterval> | undefined;
let sessionCleanup: ReturnType<typeof setInterval> | undefined;
let cleaningSessions: Promise<void> | undefined;
let ownerBindings: ActiveOwnerBindings | undefined;
let plannerAttachments: PlannerAttachments | undefined;
/** Each document's recent automatic follow-ups through `invoke_planner`, for their hourly limit. */
let systemTurns = new SystemTurns();
/** Browser sockets by login, so a login that ends closes them before another broadcast. */
let sessionSockets = new SessionSockets(sessionId => hostedAuth.sessions.isLive(sessionId));
const openSockets = new OpenSockets();
let jobRunner: JobRunner | undefined;
let researchService: ResearchWorkspaceService | undefined;
let researchRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
let recoveringResearch: Promise<void> | undefined;
let referenceService: ReferenceService | undefined;
/**
 * The files a person can mention: a checkout the Planner works in, where the document has one,
 * and else what GitHub lists for the default branch, read as the person's own session.
 */
const repositoryFiles = new RepositoryFiles({
	checkout: async (channelId, repository) => {
		if (config.harness !== "atomic") return undefined;
		let workspace = await plannerWorkspace(channelId, repository);
		return workspace.checkout ? workspace.cwd : undefined;
	},
	remote: async (sessionId, repository) => {
		let github = hostedAuth.github;
		if (!(github instanceof GitHubClient)) return undefined;
		let session = await hostedAuth.sessions.resolve(sessionId);
		if (!session) return undefined;
		let { value } = await hostedAuth.sessions.use(
			session,
			token =>
				github.repositoryFiles(token, repository.owner, repository.name, repository.defaultBranch),
		);
		return value;
	},
});
let summaryCoordinator: DocumentSummaryCoordinator | undefined;
let liveSync: LiveSyncCoordinator | undefined;
let buildReadiness: BuildReadiness | undefined;
let readinessReviews = new ReadinessReviews({
	list: id => experiments!.service.store.list(id),
	start: (channelId, about) =>
		startSettle(
			{
				instruction: serverInstructionDeps(),
				channel: id => storage.channels.get(id),
				attached: plannerAttachments ? id => plannerAttachments!.confirmed(id) : undefined,
			},
			channelId,
			current => {
				if (Service.implementationActive(current) || current.chat?.busy) return;
				return {
					handle: "Chopin",
					said: "Checking decisions and investigations needed before building",
					text: READINESS_INSTRUCTION,
					about,
				};
			},
		),
});
let spikeScout: SpikeScout | undefined;
let descriptionProjector: DocumentDescriptionProjector | undefined;
let researchBriefJobs: JobService | undefined;
let documentLocks = new Map<string, Promise<void>>();
let documentTransitions = new Map<string, Promise<void>>();
let archivingChannels = new Set<string>();
let deletingChannels = new Set<string>();
let conversationRuntime = createConversationRuntime({
	config,
	decide,
	server: () => server,
	unavailable: id => archivingChannels.has(id) || deletingChannels.has(id),
	researchJobs: () => researchBriefJobs,
});

function heldLease(): Lease {
	if (!writerLease.held) throw new Error("storage writer lease is unavailable");
	return writerLease.held;
}

function withDocumentLock<T>(channelId: string, action: () => Promise<T>): Promise<T> {
	let previous = documentLocks.get(channelId) ?? Promise.resolve();
	let operation = previous.then(action, action);
	let settled = operation.then(() => {}, () => {});
	documentLocks.set(channelId, settled);
	void settled.finally(() => {
		if (documentLocks.get(channelId) === settled) documentLocks.delete(channelId);
	});
	return operation;
}

function withDocumentTransition<T>(channelId: string, action: () => Promise<T>): Promise<T> {
	let previous = documentTransitions.get(channelId) ?? Promise.resolve();
	let operation = previous.then(action, action);
	let settled = operation.then(() => {}, () => {});
	documentTransitions.set(channelId, settled);
	void settled.finally(() => {
		if (documentTransitions.get(channelId) === settled) documentTransitions.delete(channelId);
	});
	return operation;
}

/**
 * Hold a child's room open for a root Planner tool.
 *
 * The child's document transition serializes this with archive and delete; the
 * edit itself still queues behind the child's own browser batches through
 * `Service.exclusive` inside the tool.
 */
function withChildPlan<T>(
	childId: string,
	action: (opened: Service.Plan) => Promise<T>,
): Promise<T> {
	return withDocumentTransition(childId, async () => {
		if (deletingChannels.has(childId) || archivingChannels.has(childId)) {
			throw new Error("child document is unavailable");
		}
		await Rooms.get(childId)?.closing;
		let held = Rooms.hold(childId);
		try {
			return await action(await plan(held.room, server));
		} finally {
			held.release();
			evict(held.room);
		}
	});
}

function presence(server: Server<SocketData>, room: Rooms.Room): void {
	broadcast(server, room.id, {
		kind: "session:presence",
		ts: 0,
		members: Rooms.members(room),
	});
}

function documentBackend(): Service.Backend {
	return {
		documentTitles: true,
		plannerKeepsRuns: id => plannerAttachments?.restoredWork(id),
		rejoinPlannerQuestions: (plan, server) =>
			plannerAttachments?.rejoinInputs(plan.id, plannerQuestions(plan, server)),
		onChannelRenamed: announceChannel,
		storage,
		lease: () => {
			if (!writerLease.held) throw new Error("storage writer lease is unavailable");
			return writerLease.held;
		},
		fatal: err => {
			console.error("chopin: plan persistence failed -", err);
			abandon();
		},
		onDocumentPersisted: target => {
			void documentHistory.record(target);
			summaryCoordinator?.schedule(target);
			liveSync?.schedule(target);
			buildReadiness?.schedule(target);
			spikeScout?.schedule(target);
		},
		liveBuild: !!config.liveBuild,
		onBuildStopped: id => liveSync?.stopped(id),
		onEditingUnlocked: createEditingUnlocked({
			withDocumentLock,
			opened: id => Rooms.get(id)?.plan,
			wake: opened => conversationRuntime.wake(opened),
			relink: config.liveBuild ? relinkDecisions : undefined,
			refreshSpikes: id => spikeScout?.refresh(id),
			onError: (message, err) => console.error(message, err),
		}),
	};
}

/**
 * Re-attempt decision links a first build's lock refused, under the existing Planner owner.
 * Never claims ownership: without an owner the cards stay pending until the next Planner turn.
 */
async function relinkDecisions(channelId: string): Promise<void> {
	// Under the remote harness only an attached Planner can take the turn.
	if (plannerAttachments && !await plannerAttachments.confirmed(channelId)) return;
	await serverInstruction(channelId, current => {
		let pending = pendingLinks(current);
		if (pending.length === 0) return;
		return {
			handle: "Chopin",
			text: relinkInstruction(pending),
			said: "Linking decisions to the document after the build",
		};
	});
}

/**
 * A spike's result landed: have the Planner settle the passage it answered. Runs only under the
 * existing Planner owner, and under the remote harness only while a Planner is attached; it never
 * claims ownership, since nobody asked for this turn. A build that has since locked the document
 * skips it. Until Chat accepts the turn, `spike.settle` stays set, and an owner appearing or a
 * Planner attaching retries it. A child document's settle is dropped. Under `HARNESS=atomic` the
 * turn is a full Atomic session reading the callout, whose text is collaborators' data.
 */
const spikeSettlement = spikeSettler({
	get: id => experiments!.service.store.get(id),
	list: id => experiments!.service.store.list(id),
	mutate: (id, action) => experiments!.service.mutate(id, action),
	start: (channelId, value) =>
		startSettle(
			{
				instruction: serverInstructionDeps(),
				channel: id => storage.channels.get(id),
				attached: plannerAttachments
					? id => plannerAttachments!.confirmed(id)
					: undefined,
			},
			channelId,
			current => {
				if (Service.implementationActive(current)) return;
				let { text, said } = resolveInstruction(value);
				return { handle: value.spike!.login, text, said };
			},
		),
});

/**
 * Hand saved answers to decisions the Planner left open to the Planner, as one turn it acts on
 * for the answers saved close together. Like other server-authored turns it runs only under the
 * existing owner, and under the remote harness only while a Planner is attached; answers that
 * found no Planner wait in storage and start once one is, after a restart too.
 */
const decisionAnswers = answerTurns({
	store: storage.decisionAnswers,
	start: async (channelId, compose) => {
		if (!config.agent) return "drop";
		let channel = await storage.channels.get(channelId);
		if (!channel || channel.parentChannelId) return "drop";
		if (plannerAttachments && !await plannerAttachments.confirmed(channelId)) return false;
		return serverInstruction(channelId, compose);
	},
	// Answers saved while a Planner turn runs or waits join the turn after it.
	busy: channelId => {
		let chat = Rooms.get(channelId)?.plan?.chat;
		if (!chat || chat.closed || (!chat.busy && chat.waiting.length === 0)) return undefined;
		return chat.running ?? Bun.sleep(1_000);
	},
});

function answerDecision(channelId: string, id: string, generation: number): void {
	void decisionAnswers.answered(channelId, id, generation).catch(err =>
		console.error("chopin: could not keep a saved decision for the Planner -", err)
	);
}

/**
 * What a remote Planner's rebuilt hold needs from a document that has opened, to wait again for
 * the answers to the questions its client left open before a restart: it asks them of the
 * members again, and an answer its client can never be given becomes a turn of its own.
 */
function plannerQuestions(plan: Service.Plan, server: Server<SocketData>): RejoinHost {
	return {
		join: (asked, signal) => rejoinInput({ id: plan.id, plan, server }, asked, signal),
		unsent: decisions => {
			for (let id of decisions) {
				let record = plan.records.get(id);
				if (record?.status !== "answered" || record.origin !== "planner") continue;
				answerDecision(plan.id, id, decisionGeneration(record));
			}
		},
	};
}

function settlePendingSpikes(channelId: string): void {
	if (!config.agent || !config.liveSpikes || !experiments) return;
	void spikeSettlement.pending(channelId).catch(err =>
		console.error("chopin: could not settle a prototyped passage -", err)
	);
}

/** Wake owner-bound work: background jobs and spike settlements that waited for an owner. */
function ownerAvailable(channelId: string): Promise<void> {
	let opened = Rooms.get(channelId)?.plan;
	if (opened) conversationRuntime.wake(opened);
	settlePendingSpikes(channelId);
	void decisionAnswers.pending(channelId).catch(err =>
		console.error("chopin: could not hand saved decisions to the Planner -", err)
	);
	void reviewCompletedInvestigations(channelId);
	void currentDocumentTarget(channelId).then(target => {
		if (target) buildReadiness?.schedule(target);
	});
	return jobRunner?.ownerAvailable(channelId) ?? Promise.resolve();
}

function serverInstructionDeps(): ServerInstructionDeps {
	return {
		agent: !!config.agent,
		unavailable: id => deletingChannels.has(id),
		owner: async id => await ownerBindings?.resolve(id),
		transition: withDocumentTransition,
		open: room => plan(room, server),
		conversation,
		instruct: async (context, { handle, text, said, about }) => {
			// This runs inside the document transition, after any archive has committed.
			if (about?.readiness && (await storage.channels.get(context.room))?.archivedAt) return;
			return Chat.instruct(context, handle, text, said, about);
		},
		evict,
	};
}

/** Start a Planner turn nobody typed, under the existing owner only; true once Chat accepted it. */
function serverInstruction(
	channelId: string,
	compose: (plan: Service.Plan) => Instruction | undefined,
): Promise<boolean> {
	return runServerInstruction(serverInstructionDeps(), channelId, compose);
}

function placeResearchReference(
	channelId: string,
	workspaceId: string,
): Promise<"placed" | "deferred"> {
	return placeResearch(channelId, workspaceId, {
		get: Rooms.get,
		exclusive: withDocumentLock,
		detached: async (id, action) => {
			let detached = await Service.open(id, documentBackend(), server);
			try {
				return await action(detached);
			} finally {
				await Service.close(detached);
			}
		},
	});
}

/**
 * Put a Planner-proposed investigation's card in its open document. Closing waits for Chat
 * while holding the document lock, so a host tool skips placement rather than wait behind it.
 */
async function placeInvestigationReference(
	channelId: string,
	id: string,
	after?: { index: number; digest: string },
): Promise<InvestigationPlacement | "closing" | "unopened"> {
	if (Rooms.get(channelId)?.closing) return "closing";
	return withDocumentLock(channelId, async () => {
		let active = Rooms.get(channelId)?.plan;
		if (Rooms.get(channelId)?.closing || active?.persistence.closing) return "closing";
		if (!active) return "unopened";
		return Service.placeInvestigationReference(active, id, after);
	});
}

function scheduleResearchRecovery(deferred: number): void {
	if (deferred === 0 || researchRecoveryTimer || draining) return;
	researchRecoveryTimer = setTimeout(() => {
		researchRecoveryTimer = undefined;
		if (draining) return;
		recoveringResearch = researchService!.recoverPendingPlannerInline(placeResearchReference).then(
			result => {
				scheduleResearchRecovery(result.deferred);
			},
			err => {
				console.error("chopin: research reference recovery failed -", err);
				abandon();
			},
		).finally(() => {
			recoveringResearch = undefined;
		});
	}, RESEARCH_RECOVERY_RETRY_MS);
}

/**
 * Attach the document to a room, once.
 *
 * Two clients opening at the same moment must not build two documents, so the
 * first stores its promise and the second waits on it.
 */
async function plan(room: Rooms.Room, server: Server<SocketData>): Promise<Service.Plan> {
	if (room.closing) await room.closing;
	if (deletingChannels.has(room.id)) throw new Error("document is unavailable");
	if (room.opening) {
		let opened = await room.opening;
		conversationRuntime.wake(opened);
		return opened;
	}
	if (room.plan) {
		conversationRuntime.wake(room.plan);
		return room.plan;
	}
	let backend = documentBackend();
	let opening = room.opening ??= withDocumentLock(room.id, async () => {
		if (deletingChannels.has(room.id)) throw new Error("document is unavailable");
		if (room.plan) return room.plan;
		let opened = await Service.open(room.id, backend, server);
		let channel: ChannelRecord | undefined;
		await prepareOpenedPlan(room, opened, async () => {
			channel = await storage.channels.get(room.id);
			room.parentChannelId = channel?.parentChannelId;
			if (room.closing) throw new Error("document is unavailable");
			if (config.conversationPlan && !channel?.archivedAt && !channel?.parentChannelId) {
				await backfillPlannerAskThreads(opened);
			}
		});
		await conversationRuntime.attach(
			room,
			opened,
			!!channel?.archivedAt,
			!!channel && !channel.parentChannelId,
		);
		if (!channel?.archivedAt) {
			if (summaryCoordinator) void summaryCoordinator.ensure(room.id).catch(() => {});
			if (Inject.enabled(opened)) Inject.ask(opened, server, room.id);
			if (Marks.enabled(opened)) await Marks.mark(opened);
			// A lock that released while the room was closed left spike callouts deferred.
			// Retrying only when unlocked keeps the retry's own room open from looping.
			if (spikeScout && !Service.implementationActive(opened)) void spikeScout.refresh(room.id);
			settlePendingSpikes(room.id);
			// Work that ended while the document was closed, or whose commit failed, settles now.
			if (!opened.parentChannelId) {
				void Explore.sweep(opened, server, room.id, exploreDeps)
					.catch(error => console.error("[questions] finding sweep failed:", error));
			}
		}
		return opened;
	});
	try {
		let opened = await opening;
		opened.chat.initiativeEnabled = config.agent && !opened.parentChannelId;
		conversationRuntime.wake(opened);
		return opened;
	} finally {
		if (room.opening === opening) room.opening = undefined;
	}
}

function chat(room: Rooms.Room, ws: Socket): Chat.Room {
	return conversation(room, ws.data.sessionId, {
		id: ws.data.repositoryId,
		owner: ws.data.repositoryOwner,
		name: ws.data.repositoryName,
		defaultBranch: ws.data.repositoryDefaultBranch,
	});
}

/** A room's Chat, shared by browser messages and MCP handoffs. */
function conversation(
	room: Rooms.Room,
	claimantSessionId: string | undefined,
	repository: Chat.Room["repository"],
): Chat.Room {
	let opened = room.plan!;
	let context: Chat.Room = conversationRuntime.bind({
		chat: opened.chat,
		plan: opened,
		server,
		room: room.id,
		config,
		decide,
		visualAdmission,
		auth: hostedAuth,
		claimantSessionId,
		repository,
		initiativePresent: (sessionId, actor) => {
			return Rooms.get(room.id) === room && room.plan === opened && !room.closing
				&& !archivingChannels.has(room.id) && !deletingChannels.has(room.id)
				&& [...room.members.values()].some(member =>
					!member.data.closed && member.data.canEdit && member.data.sessionId === sessionId
					&& Initiative.actor(member) === actor
				);
		},
		initiativeAuthorize: async (sessionId, actor) => {
			let member = [...room.members.values()].find(member =>
				!member.data.closed && member.data.sessionId === sessionId
				&& Initiative.actor(member) === actor
			);
			if (!member || await refreshAccess(member, true) !== "allowed") return false;
			return !member.data.closed && member.data.canEdit
				&& room.members.get(member.data.client) === member
				&& Rooms.get(room.id) === room && room.plan === opened && !room.closing
				&& !archivingChannels.has(room.id) && !deletingChannels.has(room.id);
		},
		plannerNotAttached: plannerAttachments
			? async () => {
				if (await plannerAttachments!.confirmed(room.id)) return undefined;
				let channel = await storage.channels.get(room.id);
				let path = channel
					? await documentUrl(channel, storage.channels)
					: `/channels/${room.id}`;
				return plannerNotAttached(
					room.id,
					new URL(path, hostedAuth.config.origin).href,
					`${repository.owner}/${repository.name}`,
				);
			}
			: undefined,
		plannerStarting: plannerAttachments ? () => plannerStarting(room.id) : undefined,
		// A person's request that cannot start is kept as a row, except under `AUTH_MODE=local`,
		// which is never handed over and keeps its queue in memory.
		...deferralWiring(config, {
			plannerReady: plannerAttachments ? () => plannerAttachments!.confirmed(room.id) : undefined,
			restoreComment: row => restoreComment(context, row),
			threadEnded: row =>
				Comments.failed(server, row.threadChannelId ?? row.documentId, row.threadId!),
		}),
		persist: (chat, deferred) => Service.persistDeferred(opened, chat, deferred),
		...(room.parentChannelId
			? {
				rootChannelId: room.parentChannelId,
				root: rootChat(room, room.parentChannelId, claimantSessionId, repository),
			}
			: {
				children: createChildDocuments({
					rootId: room.id,
					repositoryId: repository.id,
					channels: storage.channels,
					server,
					withChildPlan,
				}),
			}),
		modelChoice: () => turnModel(modelChoices, room.id),
		commands: () => modelChoices.commands?.(room.id) ?? Promise.resolve(undefined),
		fileExists: (path, sessionId) => repositoryFiles.has(room.id, repository, sessionId, path),
		readsImages: () => turnReadsImages(modelChoices, room.id),
		activeOwner: () => ownerBindings!.resolve(room.id),
		ownerAvailable: () => ownerAvailable(room.id),
		jobs: config.backgroundJobs ? jobService : undefined,
		references: referenceService,
		investigations: experiments
			? {
				async list() {
					return {
						investigations: (await experiments!.service.store.list(room.id))
							.filter(value => !value.spike)
							.sort((a, b) => Number(!!b.buildBlocker) - Number(!!a.buildBlocker))
							.map(
								value => ({
									id: value.id,
									brief: value.brief.slice(0, 400),
									state: value.state,
									revision: value.revision,
									buildBlocker: value.buildBlocker,
								}),
							),
					};
				},
				async read(id, dataset, offset = 0) {
					let value = await experiments!.service.store.get(id);
					if (!value || value.documentId !== room.id) throw new Error("Investigation unavailable");
					if (dataset) {
						let data = value.result?.datasets.find(item => item.key === dataset);
						if (!data) throw new Error("Dataset unavailable");
						let rows: typeof data.rows = [];
						for (let row of data.rows.slice(offset, offset + 50)) {
							if (JSON.stringify([...rows, row]).length > 40_000) break;
							rows.push(row);
						}
						if (!rows.length && offset < data.rows.length) {
							throw new Error(
								"This row exceeds the tool response limit. Inspect the dataset download or request a later offset.",
							);
						}
						return {
							...data,
							rows,
							totalRows: data.rows.length,
							nextOffset: offset + rows.length < data.rows.length
								? offset + rows.length
								: undefined,
						};
					}
					return {
						id: value.id,
						revision: value.revision,
						buildBlocker: value.buildBlocker,
						state: value.state,
						source: value.input?.source,
						report: value.result?.report.slice(0, 16_000),
						reportTruncated: (value.result?.report.length ?? 0) > 16_000,
						datasets: value.result?.datasets.map(data => ({
							key: data.key,
							title: data.title,
							rows: data.rows.length,
						})),
						decisions: value.decisions.slice(-10).map(decision => ({
							...decision,
							rationale: decision.rationale.slice(0, 2000),
							rationaleTruncated: decision.rationale.length > 2000,
						})),
					};
				},
				async propose(request) {
					// Like Research, investigations start only in a top-level document.
					if (room.parentChannelId) {
						throw new Error("Investigations start only in a top-level document, not a child.");
					}
					await experiments!.access(
						await hostedAuth.sessions.forUser(request.userId),
						room.id,
						true,
					);
					await experiments!.mutationAllowed(room.id);
					let hash = fingerprint([room.id, request.entryId, request.key]);
					let id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${
						hash.slice(17, 20)
					}-${hash.slice(20, 32)}`;
					let value = await experiments!.service.create(
						room.id,
						request.userId,
						request.brief,
						id,
						undefined,
						request.buildBlocker,
					);
					let placed: InvestigationPlacement | "closing" | "unopened" | "locked";
					try {
						placed = await placeInvestigationReference(room.id, value.id, request.after);
					} catch (error) {
						if (!(error instanceof Service.ImplementationActiveError)) throw error;
						placed = "locked";
					}
					if (placed !== "closing" && placed !== "unopened" && placed !== "locked") {
						return {
							id: value.id,
							state: value.state,
							placement: placed,
							message: placed === "present"
								? "Its card is already in the document. A person selects Run on it to execute."
								: placed === "anchored"
								? "Its card is now under the related block. A person selects Run on it to execute."
								: `Its card is at the end of the document${
									request.after ? " because the related block changed or repeats" : ""
								}. A person selects Run on it to execute.`,
						};
					}
					// A record without a card has nowhere to run from, so withdraw it.
					let withdrawn = await experiments!.service.stop(
						value.id,
						"cancelled",
						"Its card could not be placed.",
					).catch(() => value);
					return {
						id: value.id,
						state: withdrawn.state,
						placement: placed,
						message: placed === "locked"
							? "A build locked the document before its card was placed, so the proposal was withdrawn. Propose it again after the build."
							: placed === "closing"
							? "The document is closing, so its card was not placed and the proposal was withdrawn. Propose it again once the document is open."
							: "The document was not open to place its card, so the proposal was withdrawn. Propose it again while the document is open.",
					};
				},
				async setBuildBlocker(request) {
					await experiments!.access(
						await hostedAuth.sessions.forUser(request.userId),
						room.id,
						true,
					);
					if (
						deletingChannels.has(room.id) || archivingChannels.has(room.id)
						|| Rooms.get(room.id)?.closing
					) throw new Error("The document is closing");
					return withDocumentLock(room.id, async () => {
						await experiments!.mutationAllowed(room.id);
						let plan = Rooms.get(room.id)?.plan;
						if (!plan) throw new Error("The document is not open");
						return Service.exclusive(plan, async () => {
							if (
								request.reason
								&& !parse(Service.source(plan)).children.some(node =>
									node.type === "mdxJsxFlowElement" && node.name === "Investigation"
									&& node.attributes.some(attribute =>
										"name" in attribute && attribute.name === "id" && attribute.value === request.id
									)
								)
							) {
								throw new Error(
									"Place its investigation card in the document before requiring it for Build",
								);
							}
							return experiments!.service.setBuildBlocker(
								room.id,
								request.id,
								request.revision,
								request.reason,
							);
						});
					});
				},
			}
			: undefined,
		hold: () => {
			let held = Rooms.hold(room.id);
			return () => {
				held.release();
				evict(held.room);
			};
		},
		createResearch: config.agent
			? async request => {
				let service = researchService;
				if (!service) throw new Error("research workspaces are unavailable");
				let created;
				try {
					created = await service.startPlannerInline({
						channelId: room.id,
						question: request.question,
						originMessageId: request.entryId,
						requestedBy: request.userId,
						requestedByHandle: request.handle,
						beforeStart: () => ownerAvailable(room.id),
						placeReference: id => placeResearchReference(room.id, id),
					});
				} catch (err) {
					if (err instanceof ResearchWorkspaceError && err.code === "not-ready") {
						scheduleResearchRecovery(1);
					}
					throw err;
				}
				return {
					workspaceId: created.request.id,
					state: created.request.state,
					stage: created.request.stage,
				};
			}
			: undefined,
	});
	return context;
}

/**
 * The queue item of a comment sent to Chopin that a restart left waiting, built again from its
 * thread. A thread in a child is read through that child, which stays open until the turn ends.
 */
async function restoreComment(context: Chat.Room, row: DeferredTurn): Promise<unknown> {
	if (!row.threadId) return undefined;
	if (!row.threadChannelId) return Comments.restore(context, row.threadId, row.handle);
	let child = await resolveChild(
		storage.channels,
		context.room,
		context.repository.id,
		row.threadChannelId,
	);
	if (!child) return undefined;
	let held = Rooms.hold(child.id);
	let release = () => {
		held.release();
		evict(held.room);
	};
	try {
		await plan(held.room, server);
		let restored = Comments.restore(
			conversation(held.room, undefined, context.repository),
			row.threadId,
			row.handle,
		);
		if (!restored) {
			release();
			return undefined;
		}
		let ended = restored.ended;
		restored.ended = async outcome => {
			try {
				await ended?.(outcome);
			} finally {
				release();
			}
		};
		return {
			...restored,
			threadChannel: child.id,
			focus: { channelId: child.id, title: child.title },
		};
	} catch (err) {
		release();
		throw err;
	}
}

/**
 * Saved Planner requests of a document, started if they may start: the document is opened and held
 * while a turn runs, and what a restart cut off is marked. Who may start them is Chat's start
 * rule; this only needs a repository to open the document under, from the owner or from a
 * waiting request's sender whose login is live.
 */
async function startDeferred(channelId: string): Promise<void> {
	if (!config.agent || !keepsRequests(config)) return;
	if (deletingChannels.has(channelId) || archivingChannels.has(channelId)) return;
	let channel = await storage.channels.get(channelId);
	if (!channel || channel.parentChannelId || channel.archivedAt) return;
	let repository: Chat.Room["repository"] | undefined;
	let binding = await ownerBindings?.resolve(channelId);
	if (binding) {
		repository = binding.repository;
		binding.release();
	} else {
		let rows = await storage.deferredTurns.list(channelId, ["waiting", "started"]);
		let claimants = new Set(
			rows.flatMap(row => [row.claimantSessionId, row.ownerSessionIdAtAccept]).filter(
				(id): id is string => !!id,
			),
		);
		for (let id of claimants) {
			let session = await hostedAuth.sessions.resolve(id);
			if (!session) continue;
			let checked = await hostedAuth.sessions.use(
				session,
				token =>
					hostedAuth.github.repositoryAccess(
						token,
						channel.repositoryOwner,
						channel.repositoryName,
					),
			);
			if (checked.value?.id === channel.repositoryId) {
				repository = checked.value;
				break;
			}
		}
	}
	if (!repository) return;
	let found = repository;
	await withDocumentTransition(channelId, async () => {
		await Rooms.get(channelId)?.closing;
		let held = Rooms.hold(channelId);
		let release = () => {
			held.release();
			evict(held.room);
		};
		let running = false;
		try {
			await plan(held.room, server);
			let context = conversation(held.room, undefined, found);
			await Chat.recover(context);
			if (context.chat.running) {
				running = true;
				void context.chat.running.finally(release).catch(() => {});
			}
		} finally {
			if (!running) release();
		}
	});
}

let startingDeferred: Promise<void> | undefined;
let startAgain = false;

/** Tries every document with saved requests; calls that overlap run one more pass, not many. */
function startAllDeferred(): Promise<void> {
	if (startingDeferred) {
		startAgain = true;
		return startingDeferred;
	}
	let pass = (async () => {
		do {
			startAgain = false;
			for (let id of await storage.deferredTurns.documents(["waiting", "started"])) {
				await startDeferred(id).catch(err =>
					console.error("chopin: could not start a document's saved requests -", err)
				);
			}
		} while (startAgain);
	})().finally(() => {
		startingDeferred = undefined;
	});
	startingDeferred = pass;
	return pass;
}

/**
 * Open a root's room and its Chat, holding it, and `alsoHold`, until `release`.
 *
 * Refuses a root being archived or deleted rather than reopening it.
 */
async function openRootChat(
	rootId: string,
	claimantSessionId: string | undefined,
	repository: Chat.Room["repository"],
	alsoHold?: string,
): Promise<{ context: Chat.Room; release: () => void }> {
	if (deletingChannels.has(rootId) || archivingChannels.has(rootId)) {
		throw new Error("the root document is unavailable");
	}
	await Rooms.get(rootId)?.closing;
	let holds = [Rooms.hold(rootId), ...alsoHold ? [Rooms.hold(alsoHold)] : []];
	let release = () => {
		for (let hold of holds) {
			hold.release();
			evict(hold.room);
		}
	};
	try {
		await plan(holds[0]!.room, server);
		return { context: conversation(holds[0]!.room, claimantSessionId, repository), release };
	} catch (err) {
		release();
		throw err;
	}
}

/**
 * A child room's way to its root's Chat.
 *
 * Opening the root holds both rooms, so the root's turn and the child's thread
 * it answers stay loaded until that instruction's own turn has ended. The
 * turn runs under the root's Planner owner or the sender's session, exactly as
 * a comment in the root does; the sender's write access was checked on the child.
 */
function rootChat(
	child: Rooms.Room,
	rootId: string,
	claimantSessionId: string | undefined,
	repository: Chat.Room["repository"],
): Chat.RootChat {
	return createRootChat({
		rootId,
		childId: child.id,
		repositoryId: repository.id,
		channels: storage.channels,
		open: () => openRootChat(rootId, claimantSessionId, repository, child.id),
		live: () => Rooms.get(rootId)?.plan?.chat,
	});
}

async function closeRoom(room: Rooms.Room, force = false): Promise<void> {
	if (room.closing) return room.closing;
	let closing = withDocumentLock(room.id, async () => {
		if (!force && (room.members.size > 0 || room.holds)) return;
		let held = room.plan;
		room.plan = undefined;
		if (held) {
			let stopped = conversationRuntime.stop(held);
			await stopped;
			await Service.close(held);
		}
		if (force || room.members.size === 0) {
			Rooms.forget(room);
			buildReadiness?.forget(room.id);
		}
	});
	room.closing = closing;
	try {
		await closing;
	} finally {
		if (room.closing === closing) room.closing = undefined;
	}
}

/**
 * What a Planner request is told while the document has no Planner attached: that a machine is
 * still starting it, or how to get one.
 */
async function plannerNotAttached(channelId: string, url: string, repository: string) {
	if (plannerAttachments?.status(channelId).state === "disconnected") {
		return disconnectedMessage(plannerAttachments.holder(channelId));
	}
	let starting = await experiments?.plannerStarting(channelId);
	if (starting) return startingMessage(starting.login, starting.failure);
	return notAttachedMessage(url, repository, !!experiments?.plannerMachines);
}

/**
 * An `@chopin` message or `invoke_planner` call: the document is in use, so a machine starts its
 * Planner if none runs it, and the request waits a bounded time for it to attach.
 */
async function plannerStarting(channelId: string): Promise<void> {
	// A Planner a cut closed is shown as attached through its window and is on its way back.
	if (!plannerAttachments || plannerAttachments.attached(channelId) || !experiments) return;
	if (plannerAttachments.status(channelId).state === "attached") return;
	await experiments.plannerUsed(channelId);
	if (await experiments.plannerStarting(channelId)) {
		await plannerAttachments.attachedWithin(channelId, PLANNER_START_MS);
	}
}

/** Who holds the document's Planner, or whose machine is starting it when nobody does. */
async function plannerStatus(channelId: string): Promise<PlannerAttachment> {
	let status = plannerAttachments!.status(channelId);
	if (status.state !== "none") return status;
	return plannerAttachment(status, await experiments?.plannerStarting(channelId));
}

/**
 * A document's Planner model choice: the catalog its harness reports (an attached client's own
 * under `HARNESS=remote`) and the choice stored for it. Nothing is offered with `AGENT=off`.
 */
const modelChoices: ModelChoiceDeps = {
	catalog: async channelId =>
		config.agent ? plannerCatalog(config.harness, channelId, config.model || undefined) : undefined,
	commands: async channelId => {
		if (!config.agent) return undefined;
		let channel = await storage.channels.get(channelId);
		if (!channel) return undefined;
		return plannerCommands(config.harness, channelId, {
			owner: channel.repositoryOwner,
			name: channel.repositoryName,
		});
	},
	known: channelId => plannerOfferKnown(config.harness, channelId),
	fellBack: channelId => {
		if (plannerRanWithoutOffer(config.harness, channelId)) announceModel(channelId);
	},
	storage,
	lease: () => {
		if (!writerLease.held) throw new Error("storage writer lease is unavailable");
		return writerLease.held;
	},
};

/**
 * Tell everyone in the document what its Planner can be set to run and what it is set to. It goes
 * through the same order as a choice, so it never tells the room an older choice after a newer one.
 */
function announceModel(channelId: string): void {
	let room = Rooms.get(channelId);
	if (!room || room.parentChannelId || cutting) return;
	void publishModelState(modelChoices, channelId, state => {
		if (server && !cutting) broadcast(server, channelId, state);
	}).catch(err => console.error("chopin: could not announce a document's model choice -", err));
}

/** Each document's latest status announcement, so an earlier one that resolves later is dropped. */
let plannerAnnouncements = new Map<string, number>();

/** Tell everyone in the document who holds its Planner now, or whose machine is starting it. */
function announcePlanner(channelId: string): void {
	if (!plannerAttachments || !Rooms.get(channelId)) return;
	let turn = (plannerAnnouncements.get(channelId) ?? 0) + 1;
	plannerAnnouncements.set(channelId, turn);
	void plannerStatus(channelId).then(planner => {
		if (plannerAnnouncements.get(channelId) !== turn) return;
		plannerAnnouncements.delete(channelId);
		if (server && !cutting) {
			broadcast(server, channelId, { kind: "session:planner", ts: 0, planner });
		}
	}, err => {
		if (plannerAnnouncements.get(channelId) === turn) plannerAnnouncements.delete(channelId);
		console.error("chopin: could not announce a document's Planner -", err);
	});
}

function evict(room: Rooms.Room): void {
	if (room.eviction || room.members.size > 0 || room.holds) return;
	room.eviction = setTimeout(() => {
		room.eviction = undefined;
		if (room.members.size > 0 || room.holds) return;
		void closeRoom(room).catch(err => {
			console.error("chopin: room close failed -", err);
		});
	}, EVICT_MS);
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Whether this socket may start Planner work in this room now.
 *
 * A Planner turn spends the claimant's entitlement and can edit the document,
 * so access is rechecked at the moment of asking rather than trusted from the
 * upgrade, and the room must still be the one the socket joined.
 */
async function plannerWritable(
	room: Rooms.Room,
	ws: Socket,
	rid: string,
): Promise<boolean> {
	let opened = await readyPlan(room);
	if (!opened) {
		fail(ws, rid, "document is unavailable", deletingChannels.has(room.id) ? undefined : PASSING);
		return false;
	}
	let access = await refreshAccess(ws);
	if (access === "unavailable") {
		fail(ws, rid, "authorization is temporarily unavailable", PASSING);
		return false;
	}
	if (access === "denied") {
		fail(ws, rid, "authorization expired");
		ws.close(4403, "authorization expired");
		return false;
	}
	if (!ws.data.canEdit) {
		fail(ws, rid, "repository write access is required");
		return false;
	}
	if (
		Rooms.get(room.id) !== room || room.plan !== opened
		|| room.closing || archivingChannels.has(room.id) || deletingChannels.has(room.id)
		|| ws.data.closed || ws.data.room !== room.id
		|| room.members.get(ws.data.client) !== ws
	) {
		// An archived or deleted document is final; a room that is only being replaced is not.
		let final = archivingChannels.has(room.id) || deletingChannels.has(room.id);
		fail(ws, rid, "document is unavailable", final ? undefined : PASSING);
		return false;
	}
	return true;
}

async function receive(ws: Socket, raw: string): Promise<void> {
	let frame = incomingFrame(raw);
	if (!frame) return;
	// The cut has begun: an edit, a message or a request is neither applied nor answered. The
	// client keeps what it sent until a server acknowledges it, and sends it to the next one.
	if (cutting && frame.kind !== "session:ping") return;

	let room = Rooms.get(ws.data.room);
	if (!room) return;
	if (deletingChannels.has(room.id)) {
		if (frame.rid) fail(ws, frame.rid, "document is unavailable");
		return;
	}
	if (!VIEWER_ALLOWED.has(frame.kind)) {
		let access = await refreshAccess(ws);
		if (access === "unavailable") {
			if (frame.rid) fail(ws, frame.rid, "authorization is temporarily unavailable", PASSING);
			return;
		}
		if (access === "denied") {
			if (frame.rid) fail(ws, frame.rid, "authorization expired");
			ws.close(4403, "authorization expired");
			return;
		}
	}
	if (!ws.data.canEdit && !VIEWER_ALLOWED.has(frame.kind)) {
		if (frame.rid) fail(ws, frame.rid, "repository write access is required");
		return;
	}

	switch (frame.kind) {
		case "session:ping":
			return tell(ws, { kind: "session:ping", ts: 0, rid: frame.rid });

		case "plan:open": {
			try {
				let opened = await plan(room, server);
				if (!room.parentChannelId) {
					// What a restart left, before the history is sent: notices and the queue.
					await Chat.recover(chat(room, ws)).catch(err =>
						console.error("chopin: could not restore saved requests -", err)
					);
				}
				let currentChannel = await storage.channels.get(room.id);
				if (currentChannel) applyChannelAccess(ws, currentChannel, ws.data.canManage);
				implementations?.track(room.id);
				let parent = room.parentChannelId;
				// Who the document names but the room does not hold, ahead of the frames that name them.
				let people = await pictures(storage.users, {
					logins: named(opened),
					ids: builders(opened),
				}).catch(err => {
					console.error("chopin: could not read the pictures of a document's people -", err);
					return [];
				});
				if (!ws.data.closed && room.members.get(ws.data.client) === ws) present(ws, people);
				await greetJoinedPlan(
					opened,
					ws,
					frame,
					!!config.conversationPlan,
					() =>
						Rooms.get(room.id) === room && room.plan === opened
						&& !room.closing && !deletingChannels.has(room.id)
						&& !ws.data.closed && ws.data.room === room.id
						&& room.members.get(ws.data.client) === ws,
					// A child's threads are worked on by its root's Chat.
					parent
						? { working: thread => Chat.workingFor(Rooms.get(parent)?.plan?.chat, thread, room.id) }
						: undefined,
				);
				// What the Planner can be set to run, and what it is set to, for the composer.
				if (!parent) {
					void publishModelState(modelChoices, room.id, state => {
						if (!ws.data.closed && room.members.get(ws.data.client) === ws) tell(ws, state);
					}).catch(err => console.error("chopin: could not send a model choice -", err));
				}
				// A reload while the room stays open settles a finding whose event was missed.
				if (!parent) {
					void Explore.sweep(opened, server, room.id, exploreDeps)
						.catch(error => console.error("[questions] finding sweep failed:", error));
				}
			} catch (err) {
				fail(ws, frame.rid, err instanceof Error ? err.message : "cannot open plan");
			}
			return;
		}

		case "plan:update":
			if (room.plan) Service.submit(room.plan, ws, frame);
			return;

		case "plan:awareness":
			if (room.plan) Service.awareness(room.plan, ws, frame);
			return;

		case "plan:titling":
			if (room.plan && typeof frame.active === "boolean") {
				Service.titling(room.plan, ws, { active: frame.active, edited: frame.edited === true });
			}
			return;

		case "plan:close":
			if (room.plan) Service.departed(room.plan, ws);
			return;

		case "chat:typing": {
			if (!room.plan || room.plan.parentChannelId || typeof frame.active !== "boolean") return;
			if (archivingChannels.has(room.id) || room.closing || ws.data.closed) return;
			Initiative.initiative(chat(room, ws))?.typing(
				ws.data.client,
				Initiative.actor(ws),
				frame.active,
			);
			return;
		}

		case "chat:participation":
			if (!await plannerWritable(room, ws, frame.rid)) return;
			await Initiative.setParticipation(chat(room, ws), ws, frame);
			return;

		case "chat:model":
			if (!await plannerWritable(room, ws, frame.rid)) return;
			await chooseModel(modelChoices, {
				server,
				ws,
				channelId: room.id,
				userId: ws.data.principalId,
				child: !!room.plan?.parentChannelId,
			}, frame);
			return;

		case "chat:send":
			try {
				if (!await plannerWritable(room, ws, frame.rid)) return;
				await Chat.send(chat(room, ws), ws, frame);
			} catch (error) {
				// Nothing it threw says the message is at fault: it is sent again.
				fail(
					ws,
					frame.rid,
					error instanceof Error ? error.message : "cannot send message",
					PASSING,
				);
			}
			return;

		case "chat:wake":
			await answerWake(
				ws,
				frame.rid,
				room.plan!,
				() => plannerWritable(room, ws, frame.rid),
				{ attachments: plannerAttachments, experiments },
			);
			return;

		case "implementation:draft":
			try {
				if (
					typeof frame.requestId !== "string" || !REQUEST_ID.test(frame.requestId)
					|| !Number.isInteger(frame.planRevision) || frame.planRevision < 0
					|| frame.build !== undefined && frame.build !== true
				) {
					fail(ws, frame.rid, "invalid task draft request");
					return;
				}
				let channel = await storage.channels.get(room.id);
				if (!channel || channel.parentChannelId) {
					fail(ws, frame.rid, "this document cannot be built");
					return;
				}
				if (!await plannerWritable(room, ws, frame.rid)) return;
				let opened = room.plan!;
				let refusal = draftRefusal(opened);
				if (refusal) {
					fail(ws, frame.rid, refusal);
					return;
				}
				let readiness = await planningReadiness(opened, opened.revision);
				if (!readiness.ok) {
					fail(ws, frame.rid, `Resolve ${readiness.blockers.join(" and ")} first`);
					return;
				}
				let { text, said } = draftInstruction(opened, ws.data.handle, frame.build);
				let result = await Chat.draftTasks(
					chat(room, ws),
					ws.data.handle,
					opened.revision,
					text,
					said,
					ws.data.principalId,
				);
				if (!result.ok) {
					fail(ws, frame.rid, result.reason, result.code);
					return;
				}
				if (frame.build) requestBuild(opened, ws.data.principalId);
				reply(ws, frame.rid, {
					kind: "implementation:draft",
					ts: 0,
					id: result.draft.id,
					planRevision: result.draft.planRevision,
					state: result.state,
					existing: result.existing,
				});
			} catch (error) {
				fail(ws, frame.rid, error instanceof Error ? error.message : "cannot draft tasks");
			}
			return;

		case "chat:abort":
		case "chat:resume":
		case "chat:pause-run":
		case "chat:resume-run":
		case "chat:unqueue":
		case "chat:delete":
		case "chat:retry":
			if (!room.plan) return;
			if (room.plan.parentChannelId) {
				if (frame.rid) fail(ws, frame.rid, "this document's Chat is on its root document");
				return;
			}
			if (frame.kind === "chat:abort") await Chat.abort(chat(room, ws), ws);
			else if (frame.kind === "chat:resume") await Chat.resume(chat(room, ws), ws);
			else if (frame.kind === "chat:unqueue") Chat.unqueue(chat(room, ws), ws, frame);
			else if (frame.kind === "chat:delete") await Chat.remove(chat(room, ws), ws, frame);
			else if (frame.kind === "chat:retry") await Chat.retry(chat(room, ws), ws, frame);
			else await Chat.controlRun(chat(room, ws), ws, frame);
			return;

		case "conversation-plan:correct":
		case "conversation-plan:scoped-choice-save":
		case "conversation-plan:retry":
		case "conversation-plan:retry-job":
			await handleConversationCommand(frame, room, ws, {
				enabled: !!config.conversationPlan,
				runtime: conversationRuntime,
				unavailable: id => archivingChannels.has(id) || deletingChannels.has(id),
				refreshAccess: () => refreshAccess(ws),
				chat: () => chat(room, ws),
			});
			return;

		case "conversation-plan:research":
		case "conversation-plan:research-link":
		case "conversation-plan:research-edit":
		case "conversation-plan:research-presence":
			await handleResearchCommand(frame, room, ws, {
				enabled: !!config.conversationPlan,
				canExecute: config.webResearch,
				eligible: async () => {
					let channel = await storage.channels.get(room.id);
					return !!channel && !channel.parentChannelId && !channel.archivedAt;
				},
				runtime: conversationRuntime,
				research: () => researchService,
				unavailable: id => archivingChannels.has(id) || deletingChannels.has(id),
				refreshAccess,
				start: (current, socket, opened, offer) =>
					startAcceptedResearch(current, socket, opened, offer, {
						research: () => researchService,
						auth: hostedAuth,
						refreshAccess,
						unavailable: id => archivingChannels.has(id) || deletingChannels.has(id),
						ownerAvailable,
						claimsOwnership: !plannerAttachments,
						placeReference: placeResearchReference,
						scheduleRecovery: scheduleResearchRecovery,
					}),
			});
			return;

		case "question:create":
			if (room.plan) await Questions.createDecision(room.plan, server, room.id, ws, frame);
			return;

		case "question:open":
			if (room.plan) Questions.open(room.plan, ws, frame);
			return;

		case "question:edit":
			if (room.plan) await Questions.edit(room.plan, ws, frame);
			return;

		case "question:discard":
			if (room.plan) await Questions.discard(room.plan, server, room.id, ws, frame);
			return;

		case "question:reopen":
			if (room.plan) await Questions.reopen(room.plan, server, room.id, ws, frame);
			return;

		case "question:presence":
			if (room.plan) Questions.focus(room.plan, ws, frame);
			return;

		case "question:submit":
			if (room.plan) {
				let opened = room.plan;
				let claimant = chat(room, ws);
				await Questions.submit(
					opened,
					server,
					room.id,
					ws,
					frame,
					intent => conversationRuntime.contexts.remember(opened, intent.trigger, claimant),
					(id, generation) => answerDecision(room.id, id, generation),
				);
			}
			return;

		case "question:cancel":
			if (room.plan) await Questions.cancel(room.plan, server, room.id, ws, frame);
			return;

		case "question:why":
			if (room.plan) await Questions.setWhy(room.plan, server, room.id, ws, frame);
			return;

		case "question:option":
			if (room.plan) await Questions.addOption(room.plan, server, room.id, ws, frame);
			return;

		case "question:criterion":
			if (room.plan) await Questions.addCriterion(room.plan, server, room.id, ws, frame);
			return;

		case "question:explore":
			if (room.plan) await Explore.explore(room.plan, server, room.id, ws, frame, exploreDeps);
			return;

		case "question:explore-stop":
			if (room.plan) await Explore.stop(room.plan, server, room.id, ws, frame, exploreDeps);
			return;

		case "question:take":
			if (room.plan) await Explore.take(room.plan, server, room.id, ws, frame);
			return;

		case "question:page":
			if (room.plan) await Explore.page(room.plan, server, room.id, ws, frame, createQuestionPage);
			return;

		// A note sent to the Planner starts a turn on the sender's entitlement, so
		// their authority to do that is rechecked first, exactly as for Chat; the
		// sender's session is the turn's claimant.
		case "comment:start":
			if (!room.plan) return;
			if (frame.to === "planner" && !await plannerWritable(room, ws, frame.rid)) return;
			await Comments.start(
				room.plan,
				server,
				room.id,
				ws,
				frame,
				frame.to === "planner" ? chat(room, ws) : undefined,
			);
			return;

		case "comment:reply":
			if (!room.plan) return;
			if (frame.to === "planner" && !await plannerWritable(room, ws, frame.rid)) return;
			await Comments.respond(
				room.plan,
				ws,
				frame,
				frame.to === "planner" ? chat(room, ws) : undefined,
			);
			return;

		case "comment:typing":
			if (room.plan) Comments.typing(room.plan, ws, frame);
			return;

		case "comment:resolve":
			if (room.plan) await Comments.resolve(room.plan, server, room.id, ws, frame);
			return;

		case "comment:reopen":
			if (room.plan) await Comments.reopen(room.plan, server, room.id, ws, frame);
			return;

		case "job:list":
			try {
				if (!config.backgroundJobs) throw new Error("background jobs are disabled");
				reply(ws, frame.rid, await JobBrowser.listJobs(jobService, room.id));
			} catch (err) {
				fail(ws, frame.rid, err instanceof Error ? err.message : "cannot list jobs");
			}
			return;

		case "job:get":
			try {
				if (!config.backgroundJobs) throw new Error("background jobs are disabled");
				reply(ws, frame.rid, await JobBrowser.getJob(jobService, room.id, frame.id));
			} catch (err) {
				fail(ws, frame.rid, err instanceof Error ? err.message : "cannot read job");
			}
			return;

		case "job:cancel":
			try {
				if (!config.backgroundJobs) throw new Error("background jobs are disabled");
				reply(
					ws,
					frame.rid,
					await JobBrowser.cancelResearchWorkspaceJob(
						jobService,
						room.id,
						frame.id,
					),
				);
			} catch (err) {
				fail(ws, frame.rid, err instanceof Error ? err.message : "cannot cancel job");
			}
			return;
	}
}

const VIEWER_ALLOWED = new Set([
	"session:ping",
	"plan:open",
	"plan:close",
	"job:list",
	"job:get",
	"conversation-plan:research-link",
]);

type AnySocket = ServerWebSocket<SocketData | SidebarSocketData | AgentSocketData>;

function isSidebarSocket(ws: AnySocket): ws is SidebarSocket {
	return ws.data.sidebar === true;
}

function decisionTopics(ws: SidebarSocket): WatchTopics {
	return {
		subscribe: repositoryId => ws.subscribe(repositoryTopic(repositoryId)),
		unsubscribe: repositoryId => ws.unsubscribe(repositoryTopic(repositoryId)),
	};
}

function watchingRepository(ws: SidebarSocket, repositoryId: string): boolean {
	return !ws.data.closed && ws.data.decisionWatch.repositories.has(repositoryId);
}

async function sidebarRepositoryReader(
	ws: SidebarSocket,
): Promise<RepositoryAuthorizer | undefined> {
	let data = ws.data;
	if (data.closed || data.authorizedUntil <= Date.now()) return undefined;
	let request = new Request(hostedAuth.config.origin, { headers: { cookie: data.credential } });
	let session = await hostedAuth.sessions.authenticate(request);
	if (!session || session.user.id !== data.principalId) return undefined;
	data.authorizedUntil = session.session.expiresAt.getTime();
	return repositoryReader(async (owner, name) => {
		let access = await hostedAuth.sessions.use(
			session,
			token => hostedAuth.github.repositoryAccess(token, owner, name),
		);
		return access.value;
	});
}

function expireSidebar(ws: SidebarSocket): void {
	if (!ws.data.closed) ws.close(4403, "authorization expired");
}

async function receiveSidebar(ws: SidebarSocket, raw: string): Promise<void> {
	let frame = sidebarFrame(raw);
	if (!frame) return;
	switch (frame.kind) {
		case "session:ping":
			return tell(ws, { kind: "session:ping", ts: 0, rid: frame.rid });

		case "sidebar:watch":
			return watchSidebarDecisions(ws, frame.rid, frame.repositories);

		case "sidebar:unwatch": {
			let repositoryIds = unwatchRequest(frame.repositoryIds);
			if (!repositoryIds) return fail(ws, frame.rid, "invalid decision unwatch");
			unwatchDecisions(ws.data.decisionWatch, repositoryIds, decisionTopics(ws));
			return;
		}

		default:
			return fail(ws, (frame as { rid: string }).rid, "unsupported sidebar request");
	}
}

async function watchSidebarDecisions(
	ws: SidebarSocket,
	rid: string,
	value: unknown,
): Promise<void> {
	let requested = watchRequest(value);
	if (!requested) return fail(ws, rid, "invalid decision watch");
	let authorize: RepositoryAuthorizer | undefined;
	try {
		authorize = await sidebarRepositoryReader(ws);
	} catch {
		return fail(ws, rid, "authorization is temporarily unavailable", PASSING);
	}
	if (!authorize) {
		fail(ws, rid, "authorization expired");
		return expireSidebar(ws);
	}
	let outcome = await watchDecisions(
		ws.data.decisionWatch,
		requested,
		authorize,
		decisionTopics(ws),
	);
	if (ws.data.closed) return;
	reply(ws, rid, {
		kind: "sidebar:watched",
		ts: 0,
		watched: outcome.watched.map(repository => repository.repositoryId),
		refused: outcome.refused,
		unavailable: outcome.unavailable,
	});
	for (let { repositoryId, channelIds } of outcome.watched) {
		void Service.tellRepositoryUnanswered(
			storage,
			ws,
			repositoryId,
			channelIds,
			() => watchingRepository(ws, repositoryId),
		).catch(err => {
			if (!ws.data.closed) console.warn("chopin: could not send decision snapshot -", err);
		});
	}
}

async function recheckSidebar(ws: SidebarSocket): Promise<void> {
	if (ws.data.closed) return;
	let authorize = await sidebarRepositoryReader(ws);
	if (ws.data.closed) return;
	if (!authorize) return expireSidebar(ws);
	await recheckDecisionWatch(ws.data.decisionWatch, authorize, decisionTopics(ws));
}

function scheduleSidebarRecheck(ws: SidebarSocket): void {
	if (ws.data.closed) return;
	ws.data.recheckTimer = setTimeout(() => {
		void recheckSidebar(ws).catch(err => {
			if (!ws.data.closed) console.warn("chopin: could not recheck sidebar repositories -", err);
		}).finally(() => scheduleSidebarRecheck(ws));
	}, ACCESS_RECHECK_MS);
}

async function refreshAccess(ws: Socket, forceGitHub = false): Promise<AuthorizationResult> {
	return refreshAuthorization(ws.data, forceGitHub, forced => checkAccess(ws, forced));
}

function applyChannelAccess(
	ws: Socket,
	channel: ChannelRecord,
	canManage: boolean,
	publish = true,
): void {
	let data = ws.data;
	let archivedAt = channel.archivedAt?.toISOString();
	let description = channel.description?.value;
	let descriptionRevision = channel.description?.revision ?? 0;
	let canEdit = canManage && !archivedAt && !archivingChannels.has(data.room);
	if (
		(channel.updatedAt.toISOString() !== data.channelUpdatedAt
			|| archivedAt !== data.channelArchivedAt
			|| descriptionRevision !== data.channelDescriptionRevision)
		&& !data.closed && publish
	) {
		tell(ws, {
			kind: "session:channel",
			ts: 0,
			channelId: channel.id,
			title: channel.title,
			slug: channel.slug,
			updatedAt: channel.updatedAt.toISOString(),
			descriptionRevision,
			...(description ? { description } : {}),
			canManage,
			...(archivedAt ? { archivedAt } : {}),
		});
	}
	if ((canEdit !== data.canEdit || canManage !== data.canManage) && !data.closed && publish) {
		tell(ws, { kind: "session:access", ts: 0, canEdit, canManage });
	}
	data.channelTitle = channel.title;
	data.channelSlug = channel.slug;
	data.channelUpdatedAt = channel.updatedAt.toISOString();
	data.channelDescription = description;
	data.channelDescriptionRevision = descriptionRevision;
	data.channelArchivedAt = archivedAt;
	data.canEdit = canEdit;
	data.canManage = canManage;
}

async function checkAccess(ws: Socket, forceGitHub: boolean): Promise<AuthorizationResult> {
	if (ws.data.closed) return "denied";
	let data = ws.data;
	if (
		!data.credential
		|| !data.principalId
		|| !data.repositoryId
		|| !data.repositoryOwner
		|| !data.repositoryName
		|| (data.authorizedUntil ?? 0) <= Date.now()
	) return "denied";
	try {
		let request = new Request(hostedAuth.config.origin, { headers: { cookie: data.credential } });
		let session = await hostedAuth.sessions.authenticate(request);
		if (!session || session.user.id !== data.principalId) return "denied";
		let channel = deletingChannels.has(data.room)
			? undefined
			: await storage.channels.get(data.room);
		if (!channel || channel.repositoryId !== data.repositoryId) return "denied";
		if (!forceGitHub && Date.now() - (data.accessCheckedAt ?? 0) < ACCESS_RECHECK_MS) {
			applyChannelAccess(ws, channel, data.canManage);
			return "allowed";
		}
		let access = await hostedAuth.sessions.use(
			session,
			token =>
				hostedAuth.github.repositoryAccess(
					token,
					data.repositoryOwner!,
					data.repositoryName!,
				),
		);
		let repository = access.value;
		if (!repository || repository.id !== data.repositoryId || !repository.permissions.pull) {
			return "denied";
		}
		if (channel.repositoryId !== repository.id) return "denied";
		let canManage = repository.permissions.push || repository.permissions.admin;
		applyChannelAccess(ws, channel, canManage);
		data.accessCheckedAt = Date.now();
		data.authorizedUntil = access.authenticated.session.expiresAt.getTime();
		data.repositoryDefaultBranch = repository.defaultBranch;
		return "allowed";
	} catch (err) {
		if (
			(err instanceof GitHubError
				&& (err.status === 429 || err.status === 502 || err.status === 503))
			|| (err instanceof StorageError && err.failure === "unavailable")
		) return "unavailable";
		return "denied";
	}
}

function scheduleAuthorization(ws: Socket): void {
	if (ws.data.closed) return;
	ws.data.authorizationTimer = setTimeout(() => {
		void refreshAccess(ws, true).then(result => {
			if (ws.data.closed) return;
			if (result === "denied") {
				ws.close(4403, "authorization expired");
				return;
			}
			scheduleAuthorization(ws);
		});
	}, ACCESS_RECHECK_MS);
}

async function validateOpenedSocket(ws: Socket): Promise<void> {
	let channel = deletingChannels.has(ws.data.room)
		? undefined
		: await storage.channels.get(ws.data.room);
	if (
		!channel || channel.repositoryId !== ws.data.repositoryId || deletingChannels.has(channel.id)
	) {
		tell(ws, { kind: "session:deleted", ts: 0, channelId: ws.data.room });
		ws.close(4404, "document deleted");
		return;
	}
	if (ws.data.closed) return;
	applyChannelAccess(ws, channel, ws.data.canManage);
}

function openRoomSocket(ws: Socket): void {
	// Every mutation revalidates document state; the admission snapshot keeps startup stable.
	ws.data.canEdit = ws.data.canEdit
		&& !archivingChannels.has(ws.data.room)
		&& !deletingChannels.has(ws.data.room);
	ws.subscribe(topic(ws.data.room));
	let room = Rooms.join(ws);
	tell(ws, {
		kind: "session:hello",
		ts: 0,
		channelId: room.id,
		title: ws.data.channelTitle,
		slug: ws.data.channelSlug,
		updatedAt: ws.data.channelUpdatedAt,
		descriptionRevision: ws.data.channelDescriptionRevision,
		...(ws.data.channelDescription
			? { description: ws.data.channelDescription }
			: {}),
		you: Rooms.member(ws),
		members: Rooms.members(room),
		canEdit: ws.data.canEdit,
		canManage: ws.data.canManage,
		...(ws.data.channelArchivedAt ? { archivedAt: ws.data.channelArchivedAt } : {}),
		backgroundJobs: config.backgroundJobs,
		webResearch: config.webResearch,
		...CHAT_CAPABILITIES,
		...(chatAttachmentLimits ? { attachments: chatAttachmentLimits } : {}),
		...(CLIENT_BUILD && !config.devClient ? { build: CLIENT_BUILD } : {}),
	});
	if (plannerAttachments) {
		tell(ws, { kind: "session:planner", ts: 0, planner: plannerAttachments.status(room.id) });
		// Opening a document on Default machine asks its creator's machine to start its Planner.
		void (async () => {
			await experiments?.plannerUsed(room.id);
			let planner = await plannerStatus(room.id);
			if (!ws.data.closed && planner.state === "starting") {
				tell(ws, { kind: "session:planner", ts: 0, planner });
			}
		})().catch(err => console.error("chopin: could not start a document's Planner -", err));
	}
	relay(ws, { kind: "session:presence", ts: 0, members: Rooms.members(room) });
	scheduleAuthorization(ws);
	void validateOpenedSocket(ws).catch(err => {
		console.error("chopin: WebSocket open failed -", err);
		ws.close(1011, "cannot open document");
	});
}

function closeRoomSocket(ws: Socket): void {
	ws.data.closed = true;
	if (ws.data.authorizationTimer) clearTimeout(ws.data.authorizationTimer);
	let room = Rooms.leave(ws);
	ws.unsubscribe(topic(ws.data.room));
	if (!room) return;
	if (room.plan) {
		room.plan.chat.initiative?.depart(ws.data.client);
		if (!room.members.size) room.plan.chat.initiative?.cancel();
		Service.departed(room.plan, ws);
		Questions.away(room.plan, ws);
		conversationRuntime.processor(room.plan)?.leaveResearch(ws.data.client);
		Comments.away(room.plan, ws);
	}
	if (room.members.size > 0) presence(server, room);
	else evict(room);
}

function closeSidebarSocket(ws: SidebarSocket): void {
	ws.data.closed = true;
	if (ws.data.recheckTimer) clearTimeout(ws.data.recheckTimer);
	releaseDecisionWatch(ws.data.decisionWatch, decisionTopics(ws));
}

function upgraded(
	req: Request,
	self: Server<SocketData | SidebarSocketData | AgentSocketData>,
	data: SocketData | SidebarSocketData | AgentSocketData,
	headers?: HeadersInit,
): Response | undefined {
	if (
		req.headers.get("x-chopin-socket-probe") === "1"
		&& req.headers.get("upgrade")?.toLowerCase() !== "websocket"
	) return new Response(null, { status: 204 });
	if (self.upgrade(req, { data, headers })) return undefined;
	return new Response("upgrade failed", { status: 400 });
}

async function route(
	req: Request,
	self: Server<SocketData | SidebarSocketData | AgentSocketData>,
	abandoned: AbortSignal,
): Promise<Response | undefined> {
	let url = new URL(req.url);

	if (url.pathname === "/ws") {
		let outcome = await admit(req, url, hostedAuth, {
			deleting: channelId => deletingChannels.has(channelId),
			readOnly: channelId => archivingChannels.has(channelId),
		});
		if ("status" in outcome) return refused(outcome);
		return upgraded(req, self, outcome.data);
	}
	if (url.pathname === AGENT_PATH) {
		let outcome = await admitAgent(
			req,
			hostedAuth,
			!!plannerAttachments,
			machinePlanners,
		);
		if (outcome instanceof Response) return outcome;
		return upgraded(req, self, outcome, AGENT_UPGRADE_HEADERS);
	}
	if (url.pathname === "/ws/sidebar") {
		let outcome = await admitSidebar(req, hostedAuth);
		if ("status" in outcome) return refused(outcome);
		return upgraded(req, self, outcome.data);
	}
	// An MCP call stops its tool work when its caller goes away; a request the cut abandons is
	// the same to it.
	let routed = await router.handle(
		url.pathname === "/mcp" ? abandonable(req, abandoned) : req,
		url,
	);
	if (routed) return routed;
	// No other path takes a WebSocket; the web client's fallback page is no answer to one.
	if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
		return new Response("not found", { status: 404 });
	}

	return config.devClient ? proxy(req, url, config.devClient) : serve(url, CLIENT);
}

function listen(): Server<SocketData> {
	return Bun.serve<SocketData | SidebarSocketData | AgentSocketData>({
		hostname: config.host,
		port: config.port,

		fetch(req, self) {
			return requests.handle(req, abandoned => route(req, self, abandoned));
		},

		websocket: {
			open(ws: AnySocket) {
				openSockets.opened(ws);
				if (isAgentSocket(ws)) {
					if (!plannerAttachments) return ws.close(LINK_CLOSE.failed, "unavailable");
					openAgentSocket(ws, hostedAuth, {
						attachments: plannerAttachments,
						unavailable: channelId => deletingChannels.has(channelId),
						pingEveryMs: config.agentConnectionPingMs,
						pongTimeoutMs: config.agentConnectionTimeoutMs,
						maxSilenceMs: config.agentConnectionMaxSilenceMs,
						catalogChanged: announceModel,
					});
					return;
				}
				// Before any subscription or frame: a login that ended since admission gets 4401.
				if (!sessionSockets.opened(ws as Socket | SidebarSocket)) return;
				if (isSidebarSocket(ws)) scheduleSidebarRecheck(ws);
				else openRoomSocket(ws as Socket);
			},

			message(ws: AnySocket, raw) {
				if (isAgentSocket(ws)) {
					ws.data.alive?.heard();
					return ws.data.link?.receive(raw);
				}
				if (typeof raw !== "string") return;
				let received = isSidebarSocket(ws) ? receiveSidebar(ws, raw) : receive(ws as Socket, raw);
				void received.catch(err => {
					console.error("chopin: WebSocket receive failed -", err);
				});
			},

			// Only agent connections are pinged by the server itself; see openAgentSocket.
			pong(ws: AnySocket) {
				if (isAgentSocket(ws)) ws.data.alive?.heard();
			},

			close(ws: AnySocket) {
				openSockets.closed(ws);
				if (isAgentSocket(ws)) {
					ws.data.alive?.stop();
					return ws.data.link?.disconnected();
				}
				sessionSockets.closed(ws as Socket | SidebarSocket);
				if (isSidebarSocket(ws)) closeSidebarSocket(ws);
				else closeRoomSocket(ws as Socket);
			},
		},
	}) as Server<SocketData>;
}

/** Nothing in memory is worth losing to a Ctrl-C. */
let draining: Promise<void> | undefined;
/**
 * The cut has begun: the process no longer announces changes, admits edits or answers a message,
 * because everything it still holds is being committed for the next process.
 */
let cutting = false;
/** What the cut took from each remote Planner hold, for the next process to rebuild. */
let frozenHolds: PlannerLinkHold[] = [];
/** Startup's session reset, which replaces the held writer lease with a re-fenced one. */
let resettingLease: Promise<unknown> | undefined;
/** Ends the wait for the writer lease, if this process is still in it. */
let leaseWait: AbortController | undefined;

/**
 * What a person reads when a restart ends a reply that was running, and what Chat records.
 * It does not say who the reply was from, and it says what to do.
 */
const INTERRUPTED_REPLY =
	"A restart interrupted this reply, and it was not run again. Ask again if you still want it.";

/** The agent link a socket carries, if it carries one. */
function agentLinkOf(ws: ServerWebSocket<unknown>) {
	let socket = ws as AnySocket;
	return isAgentSocket(socket) ? socket.data.link : undefined;
}

/** The chats with a turn running now. */
function busyChats(): Chat.Chat[] {
	return Rooms.all().flatMap(room => room.plan?.chat?.busy ? [room.plan.chat] : []);
}

function drain(graceful: boolean): Promise<void> {
	return draining ??= (async () => {
		let errors: Error[] = [];
		let record = (reason: unknown) => {
			errors.push(reason instanceof Error ? reason : new Error(String(reason)));
		};
		let attempt = async (operation: () => Promise<unknown>) => {
			try {
				await operation();
			} catch (err) {
				record(err);
			}
		};
		let { handover } = config;
		// Whether anyone is being served: a process still waiting for the lease or starting has no
		// turn to wait for, no proxy to tell and no request to finish.
		let serving = graceful && readiness.status() === "ready";
		if (!serving) readiness.draining();
		leaseWait?.abort();
		requests.close();
		hostedAuth.sessions.stopRefreshing();
		Chat.holdStarts();
		if (researchRecoveryTimer) clearTimeout(researchRecoveryTimer);
		if (experimentTimer) clearInterval(experimentTimer);
		if (recoveringResearch) await attempt(() => recoveringResearch!);
		if (sessionCleanup) clearInterval(sessionCleanup);
		for (let result of await Promise.allSettled([cleaningSessions])) {
			if (result.status === "rejected") record(result.reason);
		}
		if (serving) {
			// Still serving, so no one notices: turns finish, and every document is committed and
			// checkpointed while edits go on arriving, which leaves the cut little to write.
			await attempt(() =>
				finishTurns({
					busy: busyChats,
					interrupt: chat => Chat.interrupt(chat, INTERRUPTED_REPLY),
					settled: Chat.settled,
					// So the link a turn runs through withdraws no question when the turn is cut off.
					beforeInterrupt: () => plannerAttachments?.shutdown(),
				}, { waitMs: handover.turnWaitMs })
			);
			let settling = await Promise.allSettled(
				Rooms.all().flatMap(room => room.plan ? [Service.settle(room.plan)] : []),
			);
			for (let result of settling) {
				if (result.status === "rejected") record(result.reason);
			}
			let stoppingJobs = jobRunner?.shutdown();
			for (let result of await Promise.allSettled([stoppingJobs])) {
				if (result.status === "rejected") record(result.reason);
			}
		}
		let report = await cut({
			unready: () => readiness.draining(),
			refused: () => readiness.refusedWhileDraining,
			stopListening: async () => {
				// Not awaited: it ends when every connection has, and the sockets stay open until the
				// last step.
				if (server) void server.stop(false);
			},
			finishRequests: async bound => {
				experiments?.connections.stopWaiting();
				return requests.finish(bound);
			},
			commit: async () => {
				cutting = true;
				// Before any link closes, so none withdraws a question it asked on its way out.
				plannerAttachments?.shutdown();
				let rooms = await Promise.allSettled(
					Rooms.all().map(async room => {
						let opened = room.plan;
						if (!opened) return;
						await Service.drain(opened);
						let stopped = conversationRuntime.stop(opened);
						await stopped;
						await Service.close(opened);
					}),
				);
				for (let result of rooms) {
					if (result.status === "rejected") record(result.reason);
				}
				if (summaryCoordinator) await attempt(() => summaryCoordinator!.flush());
				summaryCoordinator?.close();
				await attempt(() => documentHistory.flush());
				liveSync?.close();
				buildReadiness?.close();
				spikeScout?.close();
				// Answers still collecting stay stored; the next process delivers them.
				decisionAnswers.close();
				let stoppingJobs = jobRunner?.shutdown();
				ownerBindings?.revokeAll();
				// After every room has closed, so what a link keeps is what its client still holds.
				frozenHolds = plannerAttachments?.freeze(handover.plannerWindowMs) ?? [];
				for (let result of await Promise.allSettled([stoppingJobs])) {
					if (result.status === "rejected") record(result.reason);
				}
			},
			// What a remote Planner's link holds is persisted here, ahead of the release.
			persistLinkState: async () => {
				await plannerAttachments?.persist(frozenHolds);
			},
			release: async () => {
				await attempt(() => writerLease.stop());
				if (resettingLease) await attempt(() => resettingLease!);
				let lease = writerLease.held;
				if (lease) await attempt(() => storage.leases.release(lease));
			},
			closeClients: async () => {
				if (server) {
					openSockets.announceRestart(handover.plannerWindowMs, agentLinkOf);
					await attempt(() => openSockets.stopForRestart(server));
				}
			},
		}, {
			unreadyMs: serving ? handover.unreadyMs : 0,
			requestWaitMs: serving ? handover.requestWaitMs : 0,
		});
		for (let error of report.errors) record(error);
		console.info(
			`chopin: cut finished (${
				Object.entries(report.phases).map(([name, ms]) => `${name} ${ms} ms`).join(", ")
			})`,
		);
		await attempt(() => shutdownHarnesses());
		await attempt(() => storage.close());
		if (errors.length > 0) throw new AggregateError(errors, "Chopin shutdown failed.");
	})();
}

/** The process was asked to stop: it hands over, which lets running turns finish first. */
function signal(): void {
	stop(true);
}

/**
 * The process cannot go on (it lost the writer lease, or storage failed): it stops now, with no
 * turn waited for and no window kept, because what it would serve meanwhile could not be saved.
 */
function abandon(): void {
	stop(false);
}

function stop(graceful: boolean): void {
	void drain(graceful).then(
		() => process.exit(0),
		err => {
			console.error("chopin: shutdown failed -", err);
			process.exit(1);
		},
	);
}

function cleanSessions(): void {
	if (cleaningSessions) return;
	cleaningSessions = hostedAuth.sessions.cleanupExpired().then(() => {}, err => {
		console.error("chopin: could not delete expired login sessions -", err);
	}).then(async () => {
		let now = hostedAuth.clock();
		await storage.mcpSessions.deleteIdle(new Date(now.getTime() - MCP_SESSION_IDLE_MS));
		await storage.plannerCredentials.deleteExpired(now);
	}).catch(err => {
		console.error("chopin: could not delete idle MCP sessions or expired credentials -", err);
	}).finally(() => {
		cleaningSessions = undefined;
	});
}

async function resetOpenAgents(
	filter: (room: Rooms.Room) => boolean,
	sessionId?: string,
	revision?: number,
	reason?: string,
): Promise<void> {
	await Promise.all(
		Rooms.all().filter(filter).map(room =>
			room.plan ? Chat.resetAgent(room.plan.chat, sessionId, revision, reason) : Promise.resolve()
		),
	);
}

/** Tell every sidebar watching the document's repository that its documents changed. */
function announceCatalogue(channel: Pick<ChannelRecord, "id" | "repositoryId">): void {
	if (!server || cutting) return;
	broadcastRepository(server, channel.repositoryId, {
		kind: "sidebar:catalogue",
		ts: 0,
		repositoryId: channel.repositoryId,
		channelId: channel.id,
	});
}

function announceChannel(channel: ChannelRecord): void {
	// A machine running its Planner hears a new address on its next Planner poll; wake that poll.
	experiments?.connections.wake(channel.repositoryId);
	announceCatalogue(channel);
	let room = Rooms.get(channel.id);
	if (!room) return;
	for (let ws of room.members.values()) {
		ws.data.channelTitle = channel.title;
		ws.data.channelSlug = channel.slug;
		ws.data.channelUpdatedAt = channel.updatedAt.toISOString();
		ws.data.channelDescription = channel.description?.value;
		ws.data.channelDescriptionRevision = channel.description?.revision ?? 0;
		ws.data.channelArchivedAt = channel.archivedAt?.toISOString();
		ws.data.canEdit = ws.data.canManage && !channel.archivedAt;
		tell(ws, {
			kind: "session:channel",
			ts: 0,
			channelId: channel.id,
			title: channel.title,
			slug: channel.slug,
			updatedAt: channel.updatedAt.toISOString(),
			descriptionRevision: channel.description?.revision ?? 0,
			...(channel.description ? { description: channel.description.value } : {}),
			canManage: ws.data.canManage,
			...(channel.archivedAt ? { archivedAt: channel.archivedAt.toISOString() } : {}),
		});
		tell(ws, {
			kind: "session:access",
			ts: 0,
			canEdit: ws.data.canEdit,
			canManage: ws.data.canManage,
		});
	}
}

async function archiveChannelLocked(channelId: string, now: Date) {
	if (deletingChannels.has(channelId)) {
		throw new StorageError("missing", `channel ${channelId} is being deleted`);
	}
	archivingChannels.add(channelId);
	let room = Rooms.get(channelId);
	for (let ws of room?.members.values() ?? []) ws.data.canEdit = false;
	try {
		await summaryCoordinator?.suspend(channelId);
		let result = await withDocumentLock(channelId, async () => {
			let active = Rooms.get(channelId)?.plan;
			if (active) {
				let stopped = conversationRuntime.stop(active);
				await Chat.resetAgent(active.chat, undefined, undefined, "This document was archived.");
				await stopped;
				await conversationRuntime.interrupt(active);
				await Service.drain(active);
				await Service.persist(active);
			}
			return storage.channels.archive({ id: channelId, now });
		});
		// An archived document keeps no Planner, not even one whose connection dropped.
		await plannerAttachments?.documentEnded(channelId);
		await cancelSaved(channelId, "unavailable");
		announceChannel(result.channel);
		void Service.announceCatalogueUnanswered(server, storage, result.channel);
		return result;
	} catch (err) {
		summaryCoordinator?.resume(channelId);
		for (let ws of room?.members.values() ?? []) ws.data.canEdit = ws.data.canManage;
		throw err;
	} finally {
		archivingChannels.delete(channelId);
		let current = Rooms.get(channelId);
		let opened = await recoverAttachedPlan(current);
		if (current && opened) {
			let channel = await storage.channels.get(channelId);
			if (
				Rooms.get(channelId) === current && current.plan === opened
				&& !current.closing && !deletingChannels.has(channelId)
			) {
				await conversationRuntime.attach(
					current,
					opened,
					!!channel?.archivedAt,
					!!channel && !channel.parentChannelId,
				);
			}
		}
	}
}

function archiveChannel(channelId: string, now: Date) {
	return withDocumentTransition(channelId, () => archiveChannelLocked(channelId, now)).finally(() =>
		buildReadiness?.forget(channelId)
	);
}

async function restoreChannelLocked(channelId: string, now: Date) {
	if (deletingChannels.has(channelId)) {
		throw new StorageError("missing", `channel ${channelId} is being deleted`);
	}
	let result = await withDocumentLock(
		channelId,
		() => storage.channels.restore({ id: channelId, now }),
	);
	let recovery = await researchService?.recoverPendingPlannerInline(
		placeResearchReference,
		channelId,
	);
	scheduleResearchRecovery(recovery?.deferred ?? 0);
	summaryCoordinator?.resume(channelId);
	let current = Rooms.get(channelId);
	if (current?.plan) {
		let opened = current.plan;
		await withDocumentLock(
			channelId,
			() => Service.exclusive(opened, () => Service.activateTitles(opened)),
		);
		result.channel = await storage.channels.get(channelId) ?? result.channel;
		await conversationRuntime.attach(current, current.plan, false, !result.channel.parentChannelId);
	}
	announceChannel(result.channel);
	void Service.announceCatalogueUnanswered(server, storage, result.channel);
	if (summaryCoordinator) void summaryCoordinator.ensure(channelId).catch(() => {});
	return result;
}

function restoreChannel(channelId: string, now: Date) {
	return withDocumentTransition(channelId, () => restoreChannelLocked(channelId, now));
}

async function deleteChannelLocked(channelId: string): Promise<boolean> {
	if (deletingChannels.has(channelId)) return false;
	let channel = await storage.channels.get(channelId);
	if (!channel) return false;
	if (!channel.archivedAt) {
		throw new StorageError("conflict", `channel ${channelId} must be archived before deletion`);
	}
	deletingChannels.add(channelId);
	let room = Rooms.get(channelId);
	for (let ws of room?.members.values() ?? []) ws.data.canEdit = false;
	try {
		await summaryCoordinator?.suspend(channelId);
		await jobRunner?.cancelChannel(channelId);
		ownerBindings?.revokeChannel(channelId);
		let deleted = await withDocumentLock(channelId, async () => {
			let activeRoom = Rooms.get(channelId);
			let active = activeRoom?.plan;
			if (activeRoom) activeRoom.plan = undefined;
			if (active) {
				let stopped = conversationRuntime.stop(active);
				await stopped;
				await Service.close(active);
			}
			return storage.channels.delete(channelId);
		});
		if (!deleted) throw new StorageError("missing", `channel ${channelId} does not exist`);
		for (let ws of room?.members.values() ?? []) {
			tell(ws, { kind: "session:deleted", ts: 0, channelId });
			ws.close(4404, "document deleted");
		}
		if (room) Rooms.forget(room);
		buildReadiness?.forget(channelId);
		void Service.announceDeletedUnanswered(server, storage, channel);
		announceCatalogue(channel);
		summaryCoordinator?.resume(channelId);
		return true;
	} catch (err) {
		deletingChannels.delete(channelId);
		summaryCoordinator?.resume(channelId);
		jobRunner?.unblockChannel(channelId);
		let channel: ChannelRecord | undefined;
		try {
			channel = await storage.channels.get(channelId);
		} catch {
			for (let ws of room?.members.values() ?? []) {
				ws.close(SERVICE_RESTART, "document state is temporarily unavailable");
			}
			throw err;
		}
		if (channel) {
			let survivingRoom = Rooms.get(channelId);
			if (survivingRoom?.members.size) {
				try {
					await plan(survivingRoom, server);
				} catch {
					for (let ws of survivingRoom.members.values()) {
						ws.close(SERVICE_RESTART, "document reload required");
					}
				}
			}
			announceChannel(channel);
		} else {
			for (let ws of room?.members.values() ?? []) {
				tell(ws, { kind: "session:deleted", ts: 0, channelId });
				ws.close(4404, "document deleted");
			}
			if (room) Rooms.forget(room);
		}
		throw err;
	} finally {
		deletingChannels.delete(channelId);
		jobRunner?.unblockChannel(channelId);
	}
}

function deleteChannel(channelId: string): Promise<boolean> {
	return withDocumentTransition(channelId, () => deleteChannelLocked(channelId));
}

async function announceJobsChanged(channelId: string): Promise<void> {
	if (cutting) return;
	let page = await jobService.list(channelId, 1);
	if (!page) return;
	broadcast(server, channelId, { kind: "job:changed", ts: 0, revision: page.revision });
	let opened = Rooms.get(channelId)?.plan;
	if (opened) conversationRuntime.refreshBriefs(opened);
}

function announceResearchChanged(channelId: string, workspaceId: string, revision: number): void {
	if (cutting) return;
	broadcast(server, channelId, {
		kind: "research:changed",
		ts: 0,
		workspaceId,
		revision,
	});
}

function announceResearchTerminal(channelId: string, id: string, text: string): Promise<void> {
	return withDocumentLock(channelId, async () => {
		let active = Rooms.get(channelId)?.plan;
		if (active) {
			let existing = active.chat.entries.find(entry => entry.id === id);
			await Chat.noticeOnce(
				{ chat: active.chat, plan: active, server, room: channelId },
				id,
				existing?.text ?? text,
			);
			return;
		}
		let detached = await Service.open(channelId, documentBackend(), server);
		try {
			let existing = detached.chat.entries.find(entry => entry.id === id);
			await Chat.noticeOnce(
				{ chat: detached.chat, plan: detached, server, room: channelId },
				id,
				existing?.text ?? text,
			);
		} finally {
			await Service.close(detached);
		}
	});
}

/** Run `action` on a document's live plan, or open it detached for the duration. */
function withDecisionPlan(channelId: string, action: (plan: Service.Plan) => Promise<void>) {
	return withDocumentLock(channelId, async () => {
		let active = Rooms.get(channelId)?.plan;
		if (active) return action(active);
		let detached = await Service.open(channelId, documentBackend(), server);
		try {
			await action(detached);
		} finally {
			await Service.close(detached);
		}
	});
}

function decisionNotice(
	plan: Service.Plan,
	roomId: string,
	id: string,
	text: string,
	label: string,
) {
	return Chat.notice(
		{ chat: plan.chat, plan, server, room: roomId },
		{ text, decision: { questionnaireId: id, kind: "activity", label } },
	).then(() => {});
}

const exploreDeps: Explore.ExploreDeps = {
	research: (roomId, ref) =>
		researchService?.request(roomId, ref).catch(() => undefined)
			?? Promise.resolve(undefined),
	async spike(roomId, ref) {
		let value = await experiments?.service.store.get(ref).catch(() => undefined);
		return value?.documentId === roomId ? spikeSnapshot(value) : undefined;
	},
	async stop(roomId, finding) {
		if (finding.kind === "research") {
			await researchService?.cancelRequest({ channelId: roomId, workspaceId: finding.ref });
		} else if (finding.kind === "spike") {
			await experiments?.service.stop(finding.ref, "cancelled");
		}
	},
	demo: id => demoRoster(config.auth).get(id) !== undefined,
	notice: decisionNotice,
};

/** The child document a decision opens as, created once under its deterministic id. */
async function createQuestionPage(
	input: { roomId: string; recordId: string; title: string; by: string },
): Promise<string> {
	let parent = await storage.channels.get(input.roomId);
	if (!parent || parent.parentChannelId || parent.archivedAt) {
		throw new Error("Only an open top-level document's decisions can open as pages");
	}
	let id = deterministicChannelId(parent.repositoryId, `question:${input.recordId}`);
	let existing = await storage.channels.get(id);
	if (existing) {
		if (existing.parentChannelId !== parent.id) throw new Error("cannot open page");
		return id;
	}
	let title = displayTitle(input.title);
	let created = await storage.channels.create({
		id,
		repositoryId: parent.repositoryId,
		repositoryOwner: parent.repositoryOwner,
		repositoryName: parent.repositoryName,
		parentChannelId: parent.id,
		title,
		initial: await Service.initial("", undefined, title, { recordId: input.recordId }),
		createdBy: input.by,
		now: new Date(),
	}).catch(async error => {
		// A concurrent open created it first.
		if (await storage.channels.get(id)) return undefined;
		throw error;
	});
	if (created) announceChannel(created);
	return id;
}

/** A research request reached ready or failed: settle the findings that follow it. */
function researchSettled(channelId: string, request: ResearchRequestView): Promise<void> {
	return withDecisionPlan(channelId, async plan => {
		if (![...plan.records.values()].some(record => record.findings?.length)) return;
		await Explore.settleResearch(plan, server, channelId, request, decisionNotice);
	});
}

/** Whether a decision's research finding follows `workspaceId`, whatever its status. */
async function researchFollowed(channelId: string, workspaceId: string): Promise<boolean> {
	let followed = false;
	await withDecisionPlan(channelId, async plan => {
		followed = [...plan.records.values()].some(record =>
			record.findings?.some(finding => finding.kind === "research" && finding.ref === workspaceId)
		);
	});
	return followed;
}

/** An investigation as its finding follows it. */
function spikeSnapshot(
	value: NonNullable<
		Awaited<ReturnType<NonNullable<typeof experiments>["service"]["store"]["get"]>>
	>,
): Explore.SpikeSnapshot {
	let summary = value.result ? investigationFinding(value.brief, value.result.report) : {};
	return {
		id: value.id,
		state: value.state,
		...summary,
		...(value.input?.source.branch ? { branch: value.input.source.branch } : {}),
		...(value.childId ? { childId: value.childId } : {}),
	};
}

/**
 * An investigation changed: settle the spike findings that follow a finished one. A document that
 * is not open is loaded only when its stored records show a running spike finding.
 */
async function spikesChanged(documentId: string): Promise<void> {
	let live = Rooms.get(documentId)?.plan;
	let running: Set<string>;
	if (live) {
		running = new Set();
		for (let record of live.records.values()) {
			for (let finding of record.findings ?? []) {
				if (finding.kind === "spike" && finding.status === "running") running.add(finding.ref);
			}
		}
	} else {
		let stored = await storage.collaboration.load(documentId, new Date());
		running = runningFindingRefs(stored?.sidecar as { questions?: unknown } | undefined, "spike");
	}
	if (running.size === 0) return;
	let finished = (await experiments?.service.store.list(documentId) ?? []).filter(value =>
		running.has(value.id)
		&& ["completed", "failed", "cancelled", "interrupted"].includes(value.state)
	);
	if (finished.length === 0) return;
	await withDecisionPlan(documentId, async plan => {
		for (let value of finished) {
			await Explore.settleSpike(plan, server, documentId, spikeSnapshot(value), decisionNotice);
		}
	});
}

/** Open a document for implementation work, under its transition and document locks. */
function withImplementationPlan<T>(id: string, action: (plan: Service.Plan) => Promise<T>) {
	return withDocumentTransition(id, async () => {
		if (deletingChannels.has(id)) throw new Error("document is unavailable");
		await Rooms.get(id)?.closing;
		let held = Rooms.hold(id);
		try {
			let opened = await plan(held.room, server);
			return await withDocumentLock(id, () => action(opened));
		} finally {
			held.release();
			evict(held.room);
		}
	});
}

export type VersionRestore =
	| { kind: "restored"; revision: number }
	| { kind: "locked" }
	| { kind: "invalid"; message: string };

/**
 * Restores an earlier version's prose as a new edit by `author`, keeping today's decision,
 * questionnaire and research projections, which their records own. Runs in the document's queue
 * like any server edit, so it persists before it is published.
 */
function restoreDocumentVersion(
	channelId: string,
	earlier: string,
	author: string,
): Promise<VersionRestore> {
	return withImplementationPlan(channelId, async opened => {
		await Service.drain(opened);
		return Service.exclusive(opened, async (): Promise<VersionRestore> => {
			if (Service.implementationActive(opened)) return { kind: "locked" };
			let merged = Edit.restoration(Service.source(opened), earlier);
			let outcome = await Service.rewrite(opened, merged, undefined, author);
			if (!outcome.ok) {
				return {
					kind: "invalid",
					message: outcome.reason === "invalid" ? outcome.message : "The document changed.",
				};
			}
			Service.changes(opened, server, channelId, outcome.changes, { cursor: false });
			Service.anchors(opened, server, channelId);
			return { kind: "restored", revision: opened.revision };
		});
	});
}

async function currentDocumentTarget(
	channelId: string,
): Promise<Service.DocumentTarget | undefined> {
	let active = Rooms.get(channelId);
	if (active?.opening) await active.opening.catch(() => undefined);
	if (active?.plan) return Service.readCurrentDocument(active.plan);
	let stored = await storage.collaboration.load(channelId, new Date());
	if (!stored) return undefined;
	let projected = await Service.readStored(stored);
	active = Rooms.get(channelId);
	if (active?.opening) await active.opening.catch(() => undefined);
	if (active?.plan) return Service.readCurrentDocument(active.plan);
	return {
		channelId,
		revision: projected.revision,
		source: projected.source,
		sourceHash: Service.sourceHash(projected.source),
	};
}

async function commitCurrentSummary(
	channelId: string,
	expected: DocumentSummaryInput,
	commit: () => Promise<void>,
): Promise<boolean> {
	return withDocumentLock(channelId, async () => {
		let active = Rooms.get(channelId);
		if (active?.plan) {
			let plan = active.plan;
			return Service.exclusive(plan, async () => {
				let source = Service.source(plan);
				if (
					plan.revision !== expected.revision
					|| Service.sourceHash(source) !== expected.sourceHash
				) return false;
				await commit();
				return true;
			});
		}
		let stored = await storage.collaboration.load(channelId, new Date());
		if (!stored) return false;
		let projected = await Service.readStored(stored);
		if (
			projected.revision !== expected.revision
			|| Service.sourceHash(projected.source) !== expected.sourceHash
		) return false;
		await commit();
		return true;
	});
}

async function sessionRevoked(sessionId: string): Promise<void> {
	// First, so nothing the rest of the revocation announces reaches the ended login.
	sessionSockets.revoke(sessionId);
	let jobs = jobRunner?.ownerRevoked(sessionId);
	ownerBindings?.revokeSession(sessionId);
	await Promise.all([
		resetOpenAgents(() => true, sessionId),
		jobs,
		plannerAttachments?.sessionRevoked(sessionId),
	]);
}

async function credentialsWillRotate(sessionId: string, revision: number): Promise<void> {
	let jobs = jobRunner?.credentialsWillRotate(sessionId, revision);
	ownerBindings?.revokeCredential(sessionId, revision);
	await Promise.all([
		resetOpenAgents(
			() => true,
			sessionId,
			revision,
			"GitHub credentials refreshed, so Chopin's session was restarted. Ask it to continue.",
		),
		jobs,
	]);
}

async function channelOwnerReset(channelId: string): Promise<void> {
	Rooms.get(channelId)?.plan?.chat.initiative?.cancel();
	let jobs = jobRunner?.channelOwnerReset(channelId);
	ownerBindings?.revokeChannel(channelId);
	plannerAttachments?.ownerReset(channelId);
	await Promise.all([resetOpenAgents(room => room.id === channelId), jobs]);
	await cancelSaved(channelId, "agent");
}

/**
 * Ends a document's saved Planner requests without running them, because its agent was reset or
 * it was archived. In an open document each says so in Chat; the rest are cancelled in storage.
 */
async function cancelSaved(channelId: string, why: "agent" | "unavailable"): Promise<void> {
	if (!keepsRequests(config)) return;
	let channel = await storage.channels.get(channelId);
	let room = Rooms.get(channelId);
	if (channel && room?.plan && !room.plan.parentChannelId) {
		await Chat.cancelQueued(
			conversation(room, undefined, {
				id: channel.repositoryId,
				owner: channel.repositoryOwner,
				name: channel.repositoryName,
				defaultBranch: "",
			}),
			why,
		).catch(err => console.error("chopin: could not cancel saved requests -", err));
	}
	let lease = writerLease.held;
	if (!lease) return;
	for (let row of await storage.deferredTurns.list(channelId, ["waiting"])) {
		await storage.deferredTurns.transition(lease, {
			id: row.id,
			from: "waiting",
			to: "cancelled",
			at: new Date(),
			reason: why,
		});
	}
}

let hostedAuth = registerAuthRoutes(router, {
	config: config.auth,
	storage,
	agent: config.agent,
	liveBuild: !!config.liveBuild,
	setupAgents: config.setupAgents,
	onSessionRevoked: sessionRevoked,
	// A login that is live again may be the one a saved request was waiting for.
	onSessionRestored: () => {
		if (server && !cutting) {
			void startAllDeferred().catch(err =>
				console.error("chopin: could not start saved requests after a sign-in returned -", err)
			);
		}
	},
	onCredentialsWillRotate: credentialsWillRotate,
});
// A paired machine's Planner backend attaches with a credential from the connector routes.
let machinePlanners = config.agent && config.harness === "remote"
	? new MachinePlanners(hostedAuth)
	: undefined;
experiments = registerExperimentRoutes(router, hostedAuth, {
	planners: machinePlanners,
	attachments: () => plannerAttachments,
	documentOpen: id => Rooms.all().some(room => room.id === id || room.parentChannelId === id),
	plannerStatus: announcePlanner,
	implementations: () => implementations,
	connectorVersion: config.connectorVersion,
	lease() {
		if (!writerLease.held) throw new Error("storage writer lease is unavailable");
		return writerLease.held;
	},
	context: currentDocumentTarget,
	connected: (repositoryId, owner) => {
		liveSync?.connected(repositoryId, owner);
		spikeScout?.connected(repositoryId, owner);
	},
	place: (id, experiment, view, decision, remove) =>
		withDocumentTransition(id, async () => {
			await Rooms.get(id)?.closing;
			await Rooms.get(id)?.opening;
			return withDocumentLock(id, async () => {
				let active = Rooms.get(id)?.plan;
				if (active) {
					return Service.placeExperimentReference(active, experiment, view, decision, remove);
				}
				let detached = await Service.open(id, documentBackend(), server);
				try {
					await Service.placeExperimentReference(detached, experiment, view, decision, remove);
				} finally {
					await Service.close(detached);
				}
			});
		}),
	changed(documentId) {
		if (server && !cutting) {
			broadcast(server, documentId, { kind: "experiment:changed", ts: 0, documentId });
		}
		void spikeScout?.refresh(documentId);
		void reviewCompletedInvestigations(documentId);
		void spikesChanged(documentId)
			.catch(err => console.error("chopin: could not settle spike findings -", err));
		void liveSync?.blockersChanged(documentId)
			.catch(err => console.error("chopin: investigation build scheduling failed -", err));
	},
	async canMutate(id) {
		let active = Rooms.get(id)?.plan;
		if (active) return !Service.implementationActive(active);
		let stored = await storage.collaboration.load(id, new Date());
		let sidecar = stored?.sidecar as
			| { execution?: unknown; builds?: Array<{ state: string; kind?: string }> }
			| undefined;
		return !sidecar?.execution && !sidecar?.builds?.some(locksEditing);
	},
});
ownerBindings = new ActiveOwnerBindings(hostedAuth);
if (config.agent && config.harness === "remote") {
	plannerAttachments = new PlannerAttachments(hostedAuth, config.plannerAttachGraceMs, {
		// Under `AUTH_MODE=local`, which is never handed over, holds stay in memory.
		...(config.auth.local ? {} : {
			store: {
				put: hold => storage.plannerHolds.put(heldLease(), hold),
				delete: async channelId => {
					await storage.plannerHolds.delete(heldLease(), channelId);
				},
			},
		}),
		restoredRuns: (channelId, outcome) => {
			let room = Rooms.get(channelId);
			let opened = room?.plan;
			if (!room || !opened) return;
			void Chat.restoredRuns({
				chat: opened.chat,
				room: channelId,
				server,
				persist: (chat, deferred) => Service.persistDeferred(opened, chat, deferred),
			}, outcome).catch(err =>
				console.error("chopin: could not update the workflow runs a restart kept -", err)
			);
		},
	});
	hostedAuth.machines.onEnded(machineId => {
		void plannerAttachments?.machineEnded(machineId).catch(err =>
			console.error("chopin: could not end a machine's Planner hold -", err)
		);
	});
	plannerAttachments.onChange((channelId, planner) => {
		// A machine chosen for the document may start its Planner, or stop waiting to.
		experiments?.plannerChanged(channelId);
		announcePlanner(channelId);
		// A client that attaches or leaves brings or takes its models.
		announceModel(channelId);
		// Settlements that waited for a Planner can run now.
		if (planner.state === "attached") {
			void startDeferred(channelId).catch(err =>
				console.error("chopin: could not start saved requests after a Planner attached -", err)
			);
			void ownerAvailable(channelId).catch(err =>
				console.error("chopin: could not wake work after a Planner attached -", err)
			);
			void relinkDecisions(channelId).catch(err =>
				console.error("chopin: could not re-link decisions after a Planner attached -", err)
			);
		}
	});
}
let definitions: JobDefinition[] = [];
if (config.backgroundJobs) {
	definitions.push(researchBriefDefinition({ config }));
	definitions.push(documentSummaryDefinition({
		config,
		current: currentDocumentTarget,
		refresh: target => summaryCoordinator?.enqueueNow(target) ?? Promise.resolve(),
		commitCurrent: commitCurrentSummary,
	}));
}
if (config.backgroundJobs && config.agent) {
	definitions.push(researchAnswerDefinition({ config }));
	definitions.push(versionSummaryDefinition({ config, versions: storage.versions }));
}
if (config.webResearch) {
	definitions.push(researchEvidenceDefinition({ config }));
}
let jobRegistry = new JobRegistry(definitions);
let jobService = new JobService({
	storage,
	registry: jobRegistry,
	lease() {
		if (!writerLease.held) throw new Error("storage writer lease is unavailable");
		return writerLease.held;
	},
	onChange: job => {
		jobRunner?.notify(job);
		if (job.state === "completed") {
			void descriptionProjector?.jobChanged(job).catch(err => {
				console.error("chopin: document description reconciliation failed -", err);
			});
		}
		// A failed job ends a request too; only completion used to reach the research service.
		if (researchJobSettles(job)) {
			void researchService?.jobChanged(job).catch(err => {
				console.error("chopin: research workspace reconciliation failed -", err);
			});
		}
	},
	publish: announceJobsChanged,
});
if (config.agent && config.backgroundJobs) researchBriefJobs = jobService;
if (config.backgroundJobs) {
	descriptionProjector = new DocumentDescriptionProjector({
		storage,
		lease() {
			if (!writerLease.held) throw new Error("storage writer lease is unavailable");
			return writerLease.held;
		},
		publish: announceChannel,
	});
}
researchService = new ResearchWorkspaceService({
	storage,
	jobs: jobService,
	lease() {
		if (!writerLease.held) throw new Error("storage writer lease is unavailable");
		return writerLease.held;
	},
	current: currentDocumentTarget,
	publish: announceResearchChanged,
	terminalNotice: announceResearchTerminal,
	settled: researchSettled,
	followedByDecision: researchFollowed,
});
referenceService = new ReferenceService({
	storage,
	current: currentDocumentTarget,
	research: researchService,
	id: ulid,
});
// Existing visible decisions and active work do not need another readiness turn.
function pastReadiness(channelId: string): boolean {
	let held = Rooms.get(channelId)?.plan;
	return !!held && (Service.implementationActive(held) || !!held.chat?.busy
		|| [...held.records.values()].some(record => record.status === "open"));
}

async function reviewCompletedInvestigations(channelId: string): Promise<void> {
	if (!config.agent || !experiments || draining) return;
	try {
		await readinessReviews.evidence(channelId);
	} catch (err) {
		console.error("chopin: investigation evidence review failed -", err);
	}
}

if (config.liveBuild) {
	buildReadiness = new BuildReadiness({
		current: currentDocumentTarget,
		skip: pastReadiness,
		review: id => readinessReviews.review(id),
		ask: decide,
		error: err => console.error("chopin: build readiness failed -", err),
	});
}
if (config.agent && config.backgroundJobs) {
	summaryCoordinator = new DocumentSummaryCoordinator({
		service: jobService,
		current: currentDocumentTarget,
		completed: job => descriptionProjector?.jobChanged(job) ?? Promise.resolve(),
		error: err => console.error("chopin: document description scheduling failed -", err),
	});
}
jobRunner = new JobRunner({
	storage,
	service: jobService,
	registry: jobRegistry,
	lease() {
		if (!writerLease.held) throw new Error("storage writer lease is unavailable");
		return writerLease.held;
	},
	resolveActivePlanner: async job => {
		// A remote document's workers run in its attached Planner client; without one, work waits.
		if (plannerAttachments && !plannerAttachments.attached(job.channelId)) return undefined;
		let binding = await ownerBindings!.resolve(job.channelId);
		if (!binding) return undefined;
		return {
			credential: {
				kind: "active-planner",
				token: binding.token,
				ownerSessionId: binding.ownerSessionId,
				ownerGeneration: binding.ownerGeneration,
				credentialRevision: binding.credentialRevision,
				expiresAt: new Date(binding.expiresAt),
				signal: binding.signal,
				authorize: binding.revalidate,
			},
			ownerKey: binding.ownerSessionId,
			binding: {
				kind: "active-planner",
				ownerSessionId: binding.ownerSessionId,
				ownerGeneration: binding.ownerGeneration,
				credentialRevision: binding.credentialRevision,
				repositoryId: binding.repository.id,
			},
			signal: binding.signal,
			active: binding.revalidate,
			release: binding.release,
		};
	},
	enabled: config.agent && config.backgroundJobs,
	globalConcurrency: 2,
	ownerConcurrency: 1,
	changed: announceJobsChanged,
	attemptProgress(job, diagnostic) {
		console.info(
			`chopin: background job ${job.type} ${job.id} attempt ${job.attempts} progress ${
				JSON.stringify(diagnostic)
			}`,
		);
	},
	attemptFailed(job, err, latestDiagnostic) {
		let reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		let detail = err instanceof JobExecutionError && err.diagnostic
			? err.diagnostic
			: latestDiagnostic;
		let diagnostic = detail
			? ` diagnostic=${JSON.stringify(detail)}`
			: "";
		console.warn(
			`chopin: background job ${job.type} ${job.id} attempt ${job.attempts} failed - ${reason}${diagnostic}`,
		);
	},
	fatal: err => console.error("chopin: background job runner failed -", err),
});
registerMcpRoutes(router, hostedAuth, {
	lease() {
		if (!writerLease.held) throw new Error("storage writer lease is unavailable");
		return writerLease.held;
	},
}, {
	// A child's instruction runs on its root's Chat with the child as focus.
	visualAdmission,
	invokePlanner: input =>
		invokeRouted({
			channels: storage.channels,
			deleting: id => deletingChannels.has(id) || archivingChannels.has(id),
			transition: withDocumentTransition,
			open: rootId => openRootChat(rootId, input.session?.session.id, input.repository),
			plannerAccount: rootId => plannerAttachments?.holding(rootId)?.userId,
			systemTurns,
		}, input),
	plannerNotAttached,
	archiveChannel,
	isChannelDeleting: channelId => deletingChannels.has(channelId),
	onChannelRenamed: announceChannel,
	onChannelCreated: announceCatalogue,
	onDocumentPersisted: target => {
		void documentHistory.record(target);
		if (summaryCoordinator) void summaryCoordinator.enqueueNow(target).catch(() => {});
		liveSync?.schedule(target);
		buildReadiness?.schedule(target);
	},
	restoreChannel,
	serializeDocument: (channelId, action) =>
		withDocumentTransition(channelId, () => withDocumentLock(channelId, action)),
});
implementations = registerImplementationRoutes(router, hostedAuth, {
	assess: buildReadiness && ((id, revision) => {
		buildReadiness!.ready(id, revision);
	}),
	liveBuild: !!config.liveBuild,
	resumeMs: config.buildResumeMs,
	connections: experiments.connections,
	refuseOffline: experiments.refuseOffline,
	takers: experiments.takers,
	mayTake: experiments.mayTake,
	machineChoices: experiments.machineChoices,
	sourceFor: experiments.sourceFor,
	busy: async connectionId =>
		(await experiments!.service.store.active()).some(item =>
			item.connectionId === connectionId && ["running", "publishing"].includes(item.state)
		),
	withPlan: withImplementationPlan,
});
if (config.liveBuild) {
	let runtime = experiments;
	liveSync = new LiveSyncCoordinator({
		withPlan: withImplementationPlan,
		connections: runtime.connections,
		classifier: liveClassifier(decide),
		queued: (id, build) => {
			implementations?.track(id);
			runtime.connections.wake(build.repositoryId);
		},
		error: err => console.error("chopin: living-document rebuild failed -", err),
	});
}
if (config.liveSpikes) {
	spikeScout = new SpikeScout({
		host: spikeHost({
			service: experiments.service,
			connections: experiments.connections,
			sourceFor: experiments.sourceFor,
			withPlan: withImplementationPlan,
			landed: (channelId, value) => {
				void spikeSettlement.settle(channelId, value.id).catch(err =>
					console.error("chopin: could not settle a prototyped passage -", err)
				);
			},
		}),
		// Without a decisions model nothing is spiked unless the operator opts into the regex judge.
		judge: decide
			? jevJudge(request => decide(request))
			: config.liveSpikesRegexJudge
			? heuristicJudge
			: undefined,
		error: err => console.error("chopin: living-document spike failed -", err),
	});
}
registerChannelRoutes(router, hostedAuth, {
	onAgentReset: channelOwnerReset,
	onChannelArchived: archiveChannel,
	onChannelDeleted: deleteChannel,
	onChannelCreated: announceCatalogue,
	renameChannel: (id, title) =>
		withImplementationPlan(
			id,
			opened => Service.exclusive(opened, () => Service.rename(opened, title)),
		),
	onChannelRestored: restoreChannel,
	onVersionRestore: restoreDocumentVersion,
	onVersionSummaries: config.backgroundJobs && config.agent
		? async (channelId, versions) => {
			let { job } = await jobService.enqueueScheduler({
				channelId,
				type: "version-summary",
				targetKey: "history",
				idempotencyKey: versionSummaryKey(versions),
				input: { generatorVersion: 1, versions },
			});
			jobRunner?.wake();
			// A finished job with the same key will not run again, so its missing rows stay plain.
			return job.state === "pending" || job.state === "running" ? "pending" : "unavailable";
		}
		: undefined,
	references: hostedAuth.github instanceof GitHubClient
		? new GitHubReferences(hostedAuth.github)
		: undefined,
});
registerMentionRoutes(router, hostedAuth, {
	current: currentDocumentTarget,
	research: async channelId =>
		(await storage.research.list(channelId, 100, true)).map(({ id, title }) => ({ id, title })),
	files: repositoryFiles,
});
registerResearchWorkspaceRoutes(router, hostedAuth, {
	service: researchService,
	async ensureOwner(channel, session, repository) {
		await Chat.resolveOwner(
			hostedAuth,
			{
				id: channel.repositoryId,
				owner: channel.repositoryOwner,
				name: channel.repositoryName,
				defaultBranch: repository.defaultBranch,
			},
			channel.id,
			plannerAttachments ? undefined : session.session.id,
		);
		await ownerAvailable(channel.id);
	},
});
registerNavigationRoutes(router, hostedAuth, { storage });
registerImageRoutes(router, hostedAuth);
registerAttachmentRoutes(router, hostedAuth, { limits: chatAttachmentLimits });
registerConnectorScript(router, {
	bundle: join(import.meta.dir, "../../connector/dist/connector.js"),
	source: join(import.meta.dir, "../../connector/src/main.ts"),
});
registerMachinesPath(router);
registerHealthRoutes(router, readiness);

try {
	await storage.health();
} catch (err) {
	await storage.close().catch(() => {});
	let reason = err instanceof Error ? err.message : String(err);
	console.error(`chopin: storage could not start - ${reason}`);
	process.exit(1);
}

/** Where the time went from taking the lease to being ready, for the hand-over budget. */
let startup: Record<string, number> = {};
let timed = async <T>(name: string, step: () => Promise<T>): Promise<T> => {
	let started = performance.now();
	try {
		return await step();
	} finally {
		startup[name] = Math.round(performance.now() - started);
	}
};

let listening: Server<SocketData> | undefined;
if (config.handover.wait) {
	// Before the wait, so a stop that arrives in standby leaves at once with nothing to release.
	process.on("SIGINT", signal);
	process.on("SIGTERM", signal);
	requests.hold();
	server = listening = listen();
	console.log(
		`chopin: standby on ${config.host}:${config.port}, waiting for the writer lease`,
	);
}

let acquiredAt = 0;
try {
	let owner = crypto.randomUUID();
	let acquired: Lease | undefined;
	if (config.handover.wait) {
		leaseWait = new AbortController();
		acquired = await acquireWhenFree(storage.leases, {
			name: "chopin:writer",
			owner,
			ttlMs: LEASE_TTL_MS,
			pollMs: LEASE_POLL_MS,
			signal: leaseWait.signal,
			waiting: holder =>
				console.log(
					`chopin: the writer lease is held until ${holder.expiresAt.toISOString()}; waiting for its release`,
				),
			failed: err => console.warn("chopin: could not read the writer lease; trying again -", err),
		});
		if (!acquired && draining) {
			// A stop arrived in standby: its drain ends the process, with nothing here to undo.
			await draining.catch(() => {});
			await new Promise<never>(() => {});
		}
	} else {
		acquired = await storage.leases.acquire("chopin:writer", owner, LEASE_TTL_MS);
	}
	if (!acquired) throw new Error("another Chopin instance owns the database");
	acquiredAt = performance.now();
	readiness.acquired();
	writerLease.hold(acquired);
	if (!config.handover.wait) {
		// A stop that arrives while startup still runs must release the lease, or the next start finds it held.
		process.on("SIGINT", signal);
		process.on("SIGTERM", signal);
	}
	let resetting = timed(
		"reset",
		() => storage.sessions.reset(new Date(), acquired!, LEASE_TTL_MS),
	).then(reset => {
		writerLease.held = reset.lease;
		return reset;
	});
	resettingLease = resetting;
	let reset = await resetting;
	// Before any room opens, so no child Conversation is ever loaded or served.
	let children = await timed(
		"children",
		() => storage.collaboration.dropChildConversations(reset.lease),
	);
	if (children.cleared.length) {
		console.info(`chopin: cleared ${children.cleared.length} child conversation(s)`);
	}
	if (children.kept.length) {
		console.warn(
			`chopin: kept ${children.kept.length} child conversation(s) cited by decisions: ${
				children.kept.join(", ")
			}`,
		);
	}
} catch (err) {
	await shutdownHarnesses();
	if (writerLease.held) await storage.leases.release(writerLease.held).catch(() => {});
	if (listening) await listening.stop(true).catch(() => {});
	await storage.close().catch(() => {});
	let reason = err instanceof Error ? err.message : String(err);
	console.error(`chopin: storage writer lease could not start - ${reason}`);
	process.exit(1);
}
writerLease.start();
cleanSessions();
sessionCleanup = setInterval(cleanSessions, SESSION_CLEANUP_MS);

try {
	// Before anything attaches or is served, so a client that returns finds its hold.
	if (plannerAttachments && !config.auth.local) {
		await timed("holds", async () => {
			let rows = await storage.plannerHolds.list();
			await plannerAttachments!.restore(rows);
			// A document already open has had its chance to ask the rebuilt holds' questions again.
			for (let row of rows) {
				let opened = Rooms.get(row.channelId)?.plan;
				if (opened) {
					plannerAttachments!.rejoinInputs(row.channelId, plannerQuestions(opened, server));
				}
			}
			// Which documents are in use lived in the process that has gone, and a machine is asked to
			// run only the Planners of documents in use: one told it runs none stops its backend.
			for (let row of rows) if (row.machineId) await experiments!.plannerUsed(row.channelId);
		});
	}
	await timed("experiments", () => experiments!.service.recover(true));
	server = listening ??= listen();
	experimentTimer = setInterval(() => {
		void experiments!.sweep().catch(error =>
			console.error("chopin: experiment recovery failed", error)
		);
	}, 15_000);
	experimentTimer.unref();
	jobRunner.start();
	// Ready is decided here, once, from state the process already holds, so a check never
	// runs a query: the lease, a finished start, a transaction that completes and the client.
	await storage.health();
	let index = join(CLIENT, "index.html");
	if (!config.devClient && !existsSync(index)) {
		console.error(`chopin: ${index} does not exist, so this process stays not ready`);
	} else {
		readiness.started();
		// Saved requests start only after route-ready, off the readiness path.
		void startAllDeferred().catch(err =>
			console.error("chopin: could not start saved requests -", err)
		);
		let held = requests.release();
		console.log(
			`chopin: ready ${
				Math.round(performance.now() - acquiredAt)
			} ms after taking the writer lease (${
				Object.entries(startup).map(([name, ms]) => `${name} ${ms} ms`).join(", ")
			})${
				held.held
					? `; held ${held.held} request(s) while waiting, longest ${held.longestMs} ms, ${held.expired} answered 503`
					: ""
			}`,
		);
		// After readiness, because it grows with the work a document left unfinished and a
		// proxy must not wait for that. A failure stops the process, as it did before readiness.
		let recovering: Promise<void> = (async () => {
			let recovery = await researchService.recoverPendingPlannerInline(placeResearchReference);
			scheduleResearchRecovery(recovery.deferred);
			await researchService.recoverTerminalPlannerInline();
		})().catch(err => {
			console.error("chopin: research recovery failed -", err);
			abandon();
		}).finally(() => {
			if (recoveringResearch === recovering) recoveringResearch = undefined;
		});
		recoveringResearch = recovering;
	}
} catch (err) {
	if (listening) await listening.stop(true).catch(() => {});
	if (researchRecoveryTimer) clearTimeout(researchRecoveryTimer);
	if (sessionCleanup) clearInterval(sessionCleanup);
	let stoppingLease = writerLease.stop();
	await cleaningSessions;
	await stoppingLease;
	summaryCoordinator?.close();
	liveSync?.close();
	buildReadiness?.close();
	spikeScout?.close();
	let stoppingJobs = jobRunner.shutdown();
	ownerBindings.revokeAll();
	await stoppingJobs.catch(() => {});
	await shutdownHarnesses();
	if (writerLease.held) await storage.leases.release(writerLease.held).catch(() => {});
	await storage.close().catch(() => {});
	throw err;
}

console.log(describe(config));
