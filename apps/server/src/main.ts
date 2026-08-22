/**
 * The server.
 *
 * One process: the WebSocket every room talks over, and — in production — the
 * built client alongside it. In development Vite serves the client and proxies
 * `/ws` here, so the browser sees one origin either way and the client never
 * needs to know which mode it is in.
 */

import { join } from "node:path";

import * as Agent from "./agent/client";
import { ActiveOwnerBindings } from "./agent/active-owner";
import { registerAuthRoutes } from "./auth/routes";
import * as Chat from "./chat/service";
import { registerChannelRoutes } from "./channels/routes";
import * as Comments from "./comments/service";
import { proxy, serve } from "./client";
import { describe, load } from "./config";
import { GitHubError } from "./github/client";
import { Router } from "./http/router";
import { JobRegistry } from "./jobs/registry";
import * as JobBrowser from "./jobs/browser";
import { documentSummaryDefinition } from "./jobs/document-summary";
import { JobRunner } from "./jobs/runner";
import { researchQuestionDefinition, researchQuestionSnapshot } from "./jobs/research-question";
import { JobService } from "./jobs/service";
import { DocumentSummaryCoordinator } from "./jobs/summary-coordinator";
import { registerMcpRoutes } from "./mcp/routes";
import { registerNavigationRoutes } from "./navigation/routes";
import * as Service from "./plan/service";
import * as Inject from "./questions/inject";
import * as Marks from "./comments/inject";
import * as Questions from "./questions/service";
import * as Rooms from "./rooms";
import { admit } from "./socket/admission";
import { StorageError } from "./storage/errors";
import { createStorage } from "./storage/registry";
import { broadcast, fail, relay, reply, tell, topic } from "./wire";

import type { Server } from "bun";
import type { Incoming } from "@chopin/protocol";
import type { DocumentSummaryInput } from "./jobs/document-summary";
import type { JobDefinition } from "./jobs/registry";
import type { ChannelRecord, Lease } from "./storage/model";
import type { AuthorizationResult, Socket, SocketData } from "./wire";

const config = load();
const storage = createStorage(config.storage);
const router = new Router();

/** Where the built client lands. Used only when there is no dev client. */
const CLIENT = join(import.meta.dir, "../../web/dist");

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
const SESSION_CLEANUP_MS = 5 * 60_000;
const ACCESS_RECHECK_MS = 60_000;

let server: Server<SocketData>;
let heldLease: Lease | undefined;
let leaseRenewal: ReturnType<typeof setInterval> | undefined;
let leaseWatchdog: ReturnType<typeof setTimeout> | undefined;
let renewingLease: Promise<void> | undefined;
let sessionCleanup: ReturnType<typeof setInterval> | undefined;
let cleaningSessions: Promise<void> | undefined;
let ownerBindings: ActiveOwnerBindings | undefined;
let jobRunner: JobRunner | undefined;
let summaryCoordinator: DocumentSummaryCoordinator | undefined;
let documentLocks = new Map<string, Promise<void>>();

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

function presence(server: Server<SocketData>, room: Rooms.Room): void {
	broadcast(server, room.id, {
		kind: "session:presence",
		ts: 0,
		members: Rooms.members(room),
	});
}

/**
 * Attach the document to a room, once.
 *
 * Two clients opening at the same moment must not build two documents, so the
 * first stores its promise and the second waits on it.
 */
function plan(room: Rooms.Room, server: Server<SocketData>): Promise<Service.Plan> {
	if (room.plan) return Promise.resolve(room.plan);
	let backend: Service.Backend = {
		storage,
		lease: () => {
			if (!heldLease) throw new Error("storage writer lease is unavailable");
			return heldLease;
		},
		fatal: err => {
			console.error("chopin: plan persistence failed -", err);
			signal();
		},
		onDocumentPersisted: target => summaryCoordinator?.schedule(target),
	};
	return room.opening ??= withDocumentLock(room.id, () => Service.open(room.id, backend, server))
		.then(async opened => {
			room.plan = opened;
			room.opening = undefined;
			if (summaryCoordinator) void summaryCoordinator.ensure(room.id).catch(() => {});
			if (Inject.enabled()) Inject.ask(opened, server, room.id);
			if (Marks.enabled()) await Marks.mark(opened);
			return opened;
		})
		.catch(err => {
			room.opening = undefined;
			throw err;
		});
}

/** A room's conversation, with everything it needs to run a turn. */
function conversation(room: Rooms.Room, ws: Socket): Chat.Room {
	return {
		chat: room.plan!.chat,
		plan: room.plan!,
		server,
		room: room.id,
		config,
		auth: hostedAuth,
		claimantSessionId: ws.data.sessionId,
		repository: {
			id: ws.data.repositoryId,
			owner: ws.data.repositoryOwner,
			name: ws.data.repositoryName,
			defaultBranch: ws.data.repositoryDefaultBranch,
		},
		persist: () => Service.persist(room.plan!),
		ownerAvailable: () => jobRunner?.ownerAvailable(room.id) ?? Promise.resolve(),
		jobs: config.backgroundJobs ? jobService : undefined,
	};
}

function evict(room: Rooms.Room): void {
	if (room.eviction || room.members.size > 0) return;
	room.eviction = setTimeout(() => {
		if (room.members.size > 0) return;
		let held = room.plan;
		Rooms.forget(room);
		if (held) void Service.close(held);
	}, EVICT_MS);
}

async function receive(ws: Socket, raw: string): Promise<void> {
	let frame: Incoming;
	try {
		frame = JSON.parse(raw) as Incoming;
	} catch {
		return;
	}

	let room = Rooms.get(ws.data.room);
	if (!room) return;
	if (!VIEWER_ALLOWED.has(frame.kind)) {
		let access = await refreshAccess(ws);
		if (access === "unavailable") {
			if (frame.rid) fail(ws, frame.rid, "authorization is temporarily unavailable");
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
				Service.greet(opened, ws, frame);
				// Anything still unanswered, so a joiner sees the sidecar the
				// others are already looking at, and everything said so far.
				Questions.greet(opened, ws);
				Comments.greet(opened, ws);
				Chat.greet(opened.chat, ws);
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

		case "plan:close":
			if (room.plan) Service.departed(room.plan, ws);
			return;

		case "chat:send":
			if (room.plan) await Chat.send(conversation(room, ws), ws, frame);
			return;

		case "chat:abort":
			if (room.plan) await Chat.abort(conversation(room, ws), ws);
			return;

		case "chat:unqueue":
			if (room.plan) Chat.unqueue(conversation(room, ws), ws, frame);
			return;

		case "question:open":
			if (room.plan) Questions.open(room.plan, ws, frame);
			return;

		case "question:edit":
			if (room.plan) await Questions.edit(room.plan, ws, frame);
			return;

		case "question:presence":
			if (room.plan) Questions.focus(room.plan, ws, frame);
			return;

		case "question:submit":
			if (room.plan) await Questions.submit(room.plan, server, room.id, ws, frame);
			return;

		case "question:cancel":
			if (room.plan) await Questions.cancel(room.plan, server, room.id, ws, frame);
			return;

		case "comment:start":
			if (room.plan) await Comments.start(room.plan, server, room.id, ws, frame);
			return;

		case "comment:reply":
			if (room.plan) await Comments.respond(room.plan, ws, frame);
			return;

		case "comment:typing":
			if (room.plan) Comments.typing(room.plan, ws, frame);
			return;

		case "comment:accept":
			if (room.plan) await Comments.accept(conversation(room, ws), ws, frame);
			return;

		case "comment:dismiss":
			if (room.plan) await Comments.dismiss(conversation(room, ws), ws, frame);
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

		case "job:assign":
			try {
				if (!config.webResearch) throw new Error("web research is disabled");
				if (!room.plan) throw new Error("document is not open");
				reply(
					ws,
					frame.rid,
					await JobBrowser.assignResearchQuestion(
						jobService,
						room.plan,
						frame.questionId,
						frame.requestId,
					),
				);
			} catch (err) {
				fail(ws, frame.rid, err instanceof Error ? err.message : "cannot assign research");
			}
			return;

		case "job:cancel":
			try {
				if (!config.backgroundJobs) throw new Error("background jobs are disabled");
				reply(
					ws,
					frame.rid,
					await JobBrowser.cancelResearchJob(
						jobService,
						room.id,
						frame.id,
						frame.expectedRevision,
					),
				);
			} catch (err) {
				fail(ws, frame.rid, err instanceof Error ? err.message : "cannot cancel job");
			}
			return;
	}
}

const VIEWER_ALLOWED = new Set(["session:ping", "plan:open", "plan:close", "job:list", "job:get"]);

async function refreshAccess(ws: Socket, forceGitHub = false): Promise<AuthorizationResult> {
	let data = ws.data;
	if (data.closed) return "denied";
	if (data.authorizationRefresh) {
		let result = await data.authorizationRefresh;
		if (
			result !== "allowed"
			|| !forceGitHub
			|| Date.now() - (data.accessCheckedAt ?? 0) < ACCESS_RECHECK_MS
		) {
			return result;
		}
	}
	let refresh = checkAccess(ws, forceGitHub);
	data.authorizationRefresh = refresh;
	try {
		return await refresh;
	} finally {
		if (data.authorizationRefresh === refresh) data.authorizationRefresh = undefined;
	}
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
		if (!forceGitHub && Date.now() - (data.accessCheckedAt ?? 0) < ACCESS_RECHECK_MS) {
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
		let canEdit = repository.permissions.push || repository.permissions.admin;
		if (canEdit !== data.canEdit && !data.closed) {
			tell(ws, { kind: "session:access", ts: 0, canEdit });
		}
		data.canEdit = canEdit;
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
			if (result === "denied") ws.close(4403, "authorization expired");
			else scheduleAuthorization(ws);
		});
	}, ACCESS_RECHECK_MS);
}

async function refreshChannelMetadata(ws: Socket, room: Rooms.Room): Promise<void> {
	try {
		let channel = await storage.channels.get(room.id);
		if (!channel || channel.updatedAt <= new Date(ws.data.channelUpdatedAt)) return;
		if (ws.data.closed) return;
		tell(ws, {
			kind: "session:channel",
			ts: 0,
			channelId: channel.id,
			title: channel.title,
			slug: channel.slug,
			updatedAt: channel.updatedAt.toISOString(),
		});
	} catch {
		// Hello already carried the admission snapshot; a later rename event can supersede it.
	}
}

function listen(): Server<SocketData> {
	return Bun.serve<SocketData>({
		hostname: config.host,
		port: config.port,

		async fetch(req, self) {
			let url = new URL(req.url);

			if (url.pathname === "/ws") {
				let outcome = await admit(req, url, hostedAuth);
				if ("status" in outcome) {
					return new Response(outcome.reason, { status: outcome.status });
				}
				if (
					req.headers.get("x-chopin-socket-probe") === "1"
					&& req.headers.get("upgrade")?.toLowerCase() !== "websocket"
				) return new Response(null, { status: 204 });
				if (self.upgrade(req, { data: outcome.data })) return undefined;
				return new Response("upgrade failed", { status: 400 });
			}
			let routed = await router.handle(req, url);
			if (routed) return routed;

			return config.devClient ? proxy(req, url, config.devClient) : serve(url, CLIENT);
		},

		websocket: {
			open(ws: Socket) {
				ws.subscribe(topic(ws.data.room));
				let room = Rooms.join(ws);
				tell(ws, {
					kind: "session:hello",
					ts: 0,
					channelId: room.id,
					title: ws.data.channelTitle,
					slug: ws.data.channelSlug,
					updatedAt: ws.data.channelUpdatedAt,
					you: { handle: ws.data.handle, client: ws.data.client },
					members: Rooms.members(room),
					canEdit: ws.data.canEdit,
					backgroundJobs: config.backgroundJobs,
					webResearch: config.webResearch,
				});
				void refreshChannelMetadata(ws, room);
				relay(ws, { kind: "session:presence", ts: 0, members: Rooms.members(room) });
				scheduleAuthorization(ws);
			},

			message(ws: Socket, raw) {
				if (typeof raw === "string") void receive(ws, raw);
			},

			close(ws: Socket) {
				ws.data.closed = true;
				if (ws.data.authorizationTimer) clearTimeout(ws.data.authorizationTimer);
				let room = Rooms.leave(ws);
				ws.unsubscribe(topic(ws.data.room));
				if (!room) return;
				if (room.plan) {
					Service.departed(room.plan, ws);
					Questions.away(room.plan, ws);
					Comments.away(room.plan, ws);
				}
				if (room.members.size > 0) presence(server, room);
				else evict(room);
			},
		},
	});
}

/** Nothing in memory is worth losing to a Ctrl-C. */
let draining: Promise<void> | undefined;

function drain(): Promise<void> {
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
		await attempt(() => server.stop(true));
		if (sessionCleanup) clearInterval(sessionCleanup);
		for (let result of await Promise.allSettled([cleaningSessions])) {
			if (result.status === "rejected") record(result.reason);
		}
		let rooms = await Promise.allSettled(
			Rooms.all().map(room => room.plan && Service.close(room.plan)),
		);
		for (let result of rooms) {
			if (result.status === "rejected") record(result.reason);
		}
		if (summaryCoordinator) await attempt(() => summaryCoordinator!.flush());
		summaryCoordinator?.close();
		let stoppingJobs = jobRunner?.shutdown();
		ownerBindings?.revokeAll();
		for (let result of await Promise.allSettled([stoppingJobs])) {
			if (result.status === "rejected") record(result.reason);
		}
		await attempt(() => Agent.shutdown());
		if (leaseRenewal) clearInterval(leaseRenewal);
		if (leaseWatchdog) clearTimeout(leaseWatchdog);
		for (let result of await Promise.allSettled([renewingLease])) {
			if (result.status === "rejected") record(result.reason);
		}
		let lease = heldLease;
		if (lease) await attempt(() => storage.leases.release(lease));
		await attempt(() => storage.close());
		if (errors.length > 0) throw new AggregateError(errors, "Chopin shutdown failed.");
	})();
}

function signal(): void {
	void drain().then(
		() => process.exit(0),
		err => {
			console.error("chopin: shutdown failed -", err);
			process.exit(1);
		},
	);
}

function renewLease(): void {
	if (!heldLease || renewingLease) return;
	renewingLease = storage.leases.renew(heldLease, LEASE_TTL_MS).then(renewed => {
		if (renewed) {
			heldLease = renewed;
			armLeaseWatchdog();
		} else {
			console.error("chopin: lost the storage writer lease");
			heldLease = undefined;
			signal();
		}
	}, err => {
		console.error("chopin: could not renew the storage writer lease -", err);
		heldLease = undefined;
		signal();
	}).finally(() => {
		renewingLease = undefined;
	});
}

function armLeaseWatchdog(): void {
	if (leaseWatchdog) clearTimeout(leaseWatchdog);
	leaseWatchdog = setTimeout(() => {
		console.error("chopin: storage writer lease was not renewed before its safety deadline");
		heldLease = undefined;
		signal();
	}, LEASE_TTL_MS - LEASE_SAFETY_MS);
}

function cleanSessions(): void {
	if (cleaningSessions) return;
	cleaningSessions = hostedAuth.sessions.cleanupExpired().then(() => {}, err => {
		console.error("chopin: could not delete expired login sessions -", err);
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

function announceChannelRename(channel: ChannelRecord): void {
	broadcast(server, channel.id, {
		kind: "session:channel",
		ts: 0,
		channelId: channel.id,
		title: channel.title,
		slug: channel.slug,
		updatedAt: channel.updatedAt.toISOString(),
	});
}

async function announceJobsChanged(channelId: string): Promise<void> {
	if (draining) return;
	let page = await jobService.list(channelId, 1);
	if (!page) return;
	broadcast(server, channelId, { kind: "job:changed", ts: 0, revision: page.revision });
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

async function commitCurrentResearch(
	channelId: string,
	questionId: string,
	questionHash: string,
	documentRevision: number,
	documentSourceHash: string,
	commit: () => Promise<void>,
): Promise<boolean> {
	return withDocumentLock(channelId, async () => {
		let active = Rooms.get(channelId);
		let source: string;
		if (active?.plan) {
			let plan = active.plan;
			return Service.exclusive(plan, async () => {
				source = Service.source(plan);
				let question = researchQuestionSnapshot(source, questionId);
				if (
					plan.revision !== documentRevision
					|| Service.sourceHash(source) !== documentSourceHash
					|| question?.questionHash !== questionHash
				) return false;
				await commit();
				return true;
			});
		}
		let stored = await storage.collaboration.load(channelId, new Date());
		if (!stored) return false;
		let projected = await Service.readStored(stored);
		source = projected.source;
		let question = researchQuestionSnapshot(source, questionId);
		if (
			projected.revision !== documentRevision
			|| Service.sourceHash(source) !== documentSourceHash
			|| question?.questionHash !== questionHash
		) return false;
		await commit();
		return true;
	});
}

async function sessionRevoked(sessionId: string): Promise<void> {
	let jobs = jobRunner?.ownerRevoked(sessionId);
	ownerBindings?.revokeSession(sessionId);
	await Promise.all([resetOpenAgents(() => true, sessionId), jobs]);
}

async function credentialsWillRotate(sessionId: string, revision: number): Promise<void> {
	let jobs = jobRunner?.credentialsWillRotate(sessionId, revision);
	ownerBindings?.revokeCredential(sessionId, revision);
	await Promise.all([
		resetOpenAgents(
			() => true,
			sessionId,
			revision,
			"GitHub credentials refreshed, so the Planner session was restarted. Ask it to continue.",
		),
		jobs,
	]);
}

async function channelOwnerReset(channelId: string): Promise<void> {
	let jobs = jobRunner?.channelOwnerReset(channelId);
	ownerBindings?.revokeChannel(channelId);
	await Promise.all([resetOpenAgents(room => room.id === channelId), jobs]);
}

let hostedAuth = registerAuthRoutes(router, {
	config: config.auth,
	storage,
	agent: config.agent,
	onSessionRevoked: sessionRevoked,
	onCredentialsWillRotate: credentialsWillRotate,
});
ownerBindings = new ActiveOwnerBindings(hostedAuth);
let definitions: JobDefinition[] = [];
if (config.backgroundJobs) {
	definitions.push(documentSummaryDefinition({
		config,
		current: currentDocumentTarget,
		refresh: target => summaryCoordinator?.enqueueNow(target) ?? Promise.resolve(),
		commitCurrent: commitCurrentSummary,
	}));
}
if (config.webResearch) {
	definitions.push(researchQuestionDefinition({
		config,
		current: currentDocumentTarget,
		commitCurrent: commitCurrentResearch,
	}));
}
let jobRegistry = new JobRegistry(definitions);
let jobService = new JobService({
	storage,
	registry: jobRegistry,
	lease() {
		if (!heldLease) throw new Error("storage writer lease is unavailable");
		return heldLease;
	},
	onChange: job => jobRunner?.notify(job),
	publish: announceJobsChanged,
});
if (config.agent && config.backgroundJobs) {
	summaryCoordinator = new DocumentSummaryCoordinator({
		service: jobService,
		current: currentDocumentTarget,
		error: err => console.error("chopin: document summary scheduling failed -", err),
	});
}
jobRunner = new JobRunner({
	storage,
	service: jobService,
	registry: jobRegistry,
	lease() {
		if (!heldLease) throw new Error("storage writer lease is unavailable");
		return heldLease;
	},
	resolveActivePlanner: async job => {
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
	fatal: err => console.error("chopin: background job runner failed -", err),
});
registerMcpRoutes(router, hostedAuth, {
	lease() {
		if (!heldLease) throw new Error("storage writer lease is unavailable");
		return heldLease;
	},
}, {
	onChannelRenamed: announceChannelRename,
	onDocumentPersisted: target => {
		if (summaryCoordinator) void summaryCoordinator.enqueueNow(target).catch(() => {});
	},
});
registerChannelRoutes(router, hostedAuth, {
	onAgentReset: channelOwnerReset,
	onChannelRenamed: announceChannelRename,
});
registerNavigationRoutes(router, hostedAuth, { storage });

try {
	await storage.health();
} catch (err) {
	await storage.close().catch(() => {});
	let reason = err instanceof Error ? err.message : String(err);
	console.error(`chopin: storage could not start - ${reason}`);
	process.exit(1);
}

try {
	heldLease = await storage.leases.acquire(
		"chopin:writer",
		crypto.randomUUID(),
		LEASE_TTL_MS,
	);
	if (!heldLease) throw new Error("another Chopin instance owns the database");
	let reset = await storage.sessions.deleteAll(new Date(), heldLease, LEASE_TTL_MS);
	heldLease = reset.lease;
} catch (err) {
	await Agent.shutdown();
	if (heldLease) await storage.leases.release(heldLease).catch(() => {});
	await storage.close().catch(() => {});
	let reason = err instanceof Error ? err.message : String(err);
	console.error(`chopin: storage writer lease could not start - ${reason}`);
	process.exit(1);
}
armLeaseWatchdog();
leaseRenewal = setInterval(renewLease, LEASE_RENEW_MS);
cleanSessions();
sessionCleanup = setInterval(cleanSessions, SESSION_CLEANUP_MS);

try {
	server = listen();
	jobRunner.start();
} catch (err) {
	if (sessionCleanup) clearInterval(sessionCleanup);
	if (leaseRenewal) clearInterval(leaseRenewal);
	if (leaseWatchdog) clearTimeout(leaseWatchdog);
	await cleaningSessions;
	await renewingLease;
	summaryCoordinator?.close();
	let stoppingJobs = jobRunner.shutdown();
	ownerBindings.revokeAll();
	await stoppingJobs.catch(() => {});
	await Agent.shutdown();
	if (heldLease) await storage.leases.release(heldLease).catch(() => {});
	await storage.close().catch(() => {});
	throw err;
}
process.on("SIGINT", signal);
process.on("SIGTERM", signal);

console.log(describe(config));
