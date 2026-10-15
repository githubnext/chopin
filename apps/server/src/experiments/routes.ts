import { z } from "zod";
import { capabilities, ExperimentError, limits, sourceSchema } from "@chopin/experiment";
import { publicInvestigation } from "@chopin/experiment/records";
import type { Investigation, InvestigationProvenance } from "@chopin/experiment/records";
import type { HostedAuth } from "../auth/routes";
import { AdmissionDenied } from "../auth/admission";
import { MachineError } from "../auth/machines";
import type { GitHubTokenGrant } from "../github/client";
import type { ChannelRecord, StoredMachine } from "../storage/model";
import type { AuthenticatedSession } from "../auth/session";
import type { Router } from "../http/router";
import { canonical as canonicalReport } from "../mcp/create";
import { parse } from "@chopin/dialect";
import {
	CONNECTOR_AGENT_HEADER,
	CONNECTOR_AGENT_VERSION_HEADER,
	CONNECTOR_HOST_HEADER,
	CONNECTOR_PLANNER_COMMAND_HEADER,
	CONNECTOR_PLANNER_HEADER,
	CONNECTOR_PLATFORM_HEADER,
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_SERVICE_HEADER,
	CONNECTOR_UPDATE_REQUIRED,
	CONNECTOR_VERSION_HEADER,
} from "@chopin/protocol/connector";
import type { PlannerAssignment, PlannerControl } from "@chopin/protocol/connector";
import { documentsPath } from "@chopin/protocol/document-url";
import { documentUrl } from "../channels/document-url";
import type { PlannerAttachments } from "../harness/remote/attachments";
import type { MachinePlanners } from "../harness/remote/machine-planners";
import { ANY_REPOSITORY_PROTOCOL, checkoutOf, Connections, serves } from "./connections";
import { machineGitHubToken } from "./machine-github";
import type { About, Connection } from "./connections";
import type { Source } from "@chopin/experiment";
import { PairingKeys } from "./pairing-keys";
import { Experiments, fail } from "./service";
import { datasetCsv } from "./export";
import { investigationSummary } from "./document";
import { implementationSchemas } from "../tasks/connector";
import type { ImplementationConnector } from "../tasks/connector";
import { connectorSchemas } from "./mcp-schema";
import type { Lease } from "../storage/model";
import { createHash } from "node:crypto";
import { imagePath } from "../images/format";
import { MACHINES_PATH } from "../http/machines-path";
import { MAX_IMAGE_REQUEST_BYTES, prepareImage } from "../mcp/image";
import { spikeReport, spikeSubmissionSchema } from "./spikes";

export type ExperimentRuntime = ReturnType<typeof registerExperimentRoutes>;
type Options = {
	implementations?: () => ImplementationConnector | undefined;
	lease: () => Lease;
	context: (id: string) => Promise<{ source: string; revision: number } | undefined>;
	changed: (id: string) => void;
	canMutate?: (id: string) => Promise<boolean>;
	/**
	 * One of an owner's paired machines connected for a repository, or for every repository they
	 * can push to (undefined).
	 */
	connected?: (repositoryId: string | undefined, owner: string) => void;
	place?: (
		documentId: string,
		experiment: string,
		view: string,
		decision: string,
		remove: boolean,
	) => Promise<void>;
	/** The chopin release this server recommends, which `chopin update` installs by default. */
	connectorVersion?: string;
	/** Planner credentials for paired machines; set only under HARNESS=remote with AGENT on. */
	planners?: MachinePlanners;
	/** Who holds each document's Planner under HARNESS=remote, which a chosen machine's backend joins. */
	attachments?: () => PlannerAttachments | undefined;
	/** A person chose a machine for a document, or went back to automatic. */
	chosen?: (documentId: string, userId: string) => void;
	/** Whether someone has a document open in Chopin now, or one of its children. */
	documentOpen?: (documentId: string) => boolean;
	/** Who may start a document's Planner changed, so what Chat says about it may have. */
	plannerStatus?: (documentId: string) => void;
};

/** What a person is told when the machine they chose for a document cannot take its work. */
export function offlineMessage(label = "The machine you chose") {
	return `${label} is offline. Start chopin connect on it, or choose another machine.`;
}

/** What a person is told while their machine choices cannot be read; their work is refused. */
export const CHOICE_UNAVAILABLE = "Can't read your machine choice right now. Try again.";
/** Reads of the stored machine choices one request makes before refusing, and their spacing. */
const CHOICE_READS = 3;
const CHOICE_RETRY_MS = 100;

const OSES = new Set(["linux", "darwin", "win32"]);
const ARCHES = new Set(["x64", "arm64"]);
const agentSchema = z.object({
	name: z.string().trim().min(1).max(100).regex(/^[\x20-\x7e]+$/),
	version: z.string().trim().min(1).max(50).regex(/^[\w.+-]+$/).optional(),
}).strict();

/** What a connector says about its machine as it connects; anything unexpected is dropped. */
function aboutMachine(request: Request): About {
	let header = (name: string) => request.headers.get(name) ?? undefined;
	let hostname = header(CONNECTOR_HOST_HEADER);
	let [os, arch, extra] = (header(CONNECTOR_PLATFORM_HEADER) ?? "").split(" ");
	let agent = agentSchema.safeParse({
		name: header(CONNECTOR_AGENT_HEADER),
		version: header(CONNECTOR_AGENT_VERSION_HEADER),
	});
	return {
		...(hostname && /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(hostname) ? { hostname } : {}),
		...(os && arch && !extra && OSES.has(os) && ARCHES.has(arch) ? { platform: { os, arch } } : {}),
		service: header(CONNECTOR_SERVICE_HEADER) === "1",
		planner: header(CONNECTOR_PLANNER_HEADER) === "1",
		plannerCommand: header(CONNECTOR_PLANNER_COMMAND_HEADER) === "1",
		...(agent.success ? { agent: agent.data } : {}),
	};
}
const label = z.string().trim().min(1).max(100);
/** A name a person gives a machine: one line of at most 64 characters. */
const machineLabel = z.string().trim().min(1).max(64).regex(/^[^\p{Cc}]+$/u);
/**
 * `chopin pair` names a checkout only when it runs inside one. With a pairing key it pairs at
 * once, as the key's owner.
 */
const pairingSchema = z.object({
	label,
	repository: sourceSchema.shape.repository.optional(),
	commit: sourceSchema.shape.commit.optional(),
	branch: sourceSchema.shape.branch,
	key: z.string().max(100).optional(),
}).strict().refine(value => !value.repository === !value.commit, "invalid checkout");
const checkoutSchema = sourceSchema.omit({ repositoryId: true });
/**
 * What a connector says as it connects: its machine's label and the checkouts it has. Protocol 5
 * names any number of checkouts, none included; an older connector names its one checkout.
 */
const connectionSchema = z.union([
	checkoutSchema.extend({ label }).strict().transform(({ label, ...checkout }) => ({
		label,
		checkouts: [checkout],
	})),
	z.object({ label, checkouts: z.array(checkoutSchema.strict()).max(100) }).strict(),
]);

/** Whoever a GitHub repository check runs for: a browser login or a paired machine. */
type Caller = {
	userId: string;
	use: <T>(operation: (token: string) => Promise<T>) => Promise<T>;
};

function bearer(request: Request) {
	return (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
}

const MAX_BODY_BYTES = limits.resultBytes + 64 * 1024;
/** A spike is a quick prototype; one still running this long after its claim is interrupted. */
export const SPIKE_DEADLINE_MS = 20 * 60_000;
/** Screenshots an investigation may upload; distinct images, so a repeated upload is free. */
export const MAX_INVESTIGATION_IMAGES = 3;
/**
 * A document on Default machine has its Planner run on its creator's machine while someone uses
 * it: it is open in Chopin, or was within this long.
 */
export const PLANNER_IDLE_MS = 30 * 60_000;
/**
 * The connector protocols this server speaks; a connector outside them must update first.
 * Protocol 2 pairs a machine once and connects checkouts with its stored token. Protocol 4 polls
 * `wait_for_work` with the Planners it runs, and is answered with the ones its owner chose it for
 * and those Default machine gives it.
 * Protocol 5 connects the machine rather than one checkout: it takes work in any repository its
 * owner can push to. An older connector still connects, for its one checkout's repository.
 */
export const CONNECTOR_PROTOCOLS: { min: number; max: number } = { min: 2, max: 5 };

/** The chopin release a connector says it runs; a script or source run has none. */
function releaseVersion(request: Request): string | undefined {
	let version = request.headers.get(CONNECTOR_VERSION_HEADER) ?? "";
	return /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version) ? version : undefined;
}

/** The connector protocol a compatible request says it speaks; one without the header speaks 1. */
function protocolOf(request: Request): number {
	let header = request.headers.get(CONNECTOR_PROTOCOL_HEADER);
	return header && /^\d{1,9}$/.test(header) ? Number(header) : 1;
}

/**
 * Refuse a connector speaking a protocol outside CONNECTOR_PROTOCOLS, naming what fixes it. One
 * without the header is a `/connector.js` from before the check, which speaks protocol 1.
 */
function compatible(
	request: Request,
	origin: string,
	recommended: string | undefined,
	agent = false,
) {
	let header = request.headers.get(CONNECTOR_PROTOCOL_HEADER);
	// A coding agent reaches its run over HTTP MCP with only the run token, which a connector
	// speaking a supported protocol claimed for it.
	if (header === null && agent) return;
	header ??= "1";
	if (!/^\d{1,9}$/.test(header)) fail("invalid-request");
	let protocol = Number(header);
	let { min, max } = CONNECTOR_PROTOCOLS;
	if (protocol >= min && protocol <= max) return;
	// Only a release version is echoed.
	let release = releaseVersion(request);
	let fix = !release
		? "Download the connector again: mkdir -p ~/.chopin && curl -fsSL "
			+ `${origin}/connector.js -o ~/.chopin/connector.js`
		: recommended
		? `Run \`chopin update ${recommended}\`, then connect again.`
		: protocol < min
		? "Run `chopin update` to install the newest chopin, then connect again."
		: "Install an older chopin with `chopin update <version>`, or ask whoever runs this Chopin "
			+ "server to update it.";
	fail(
		CONNECTOR_UPDATE_REQUIRED,
		`${release ? `chopin ${release}` : "This connector"} speaks connector protocol ${protocol}, `
			+ `but ${origin} needs protocol ${min === max ? min : `${min} to ${max}`}. ${fix}`,
	);
}

async function raw(request: Request, max: number) {
	let size = 0;
	let chunks: Uint8Array[] = [];
	if (!request.body) fail("invalid-request");
	for await (let chunk of request.body) {
		size += chunk.length;
		if (size > max) fail("request-too-large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}
async function body(request: Request, max = MAX_BODY_BYTES) {
	return JSON.parse((await raw(request, max)).toString("utf8"));
}
function json(value: unknown, status = 200) {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
	});
}

/** A machine's newest connection's account of it; null where none said. */
function described(live: Connection[]) {
	let about = live.at(-1)?.about ?? {};
	return {
		hostname: about.hostname ?? null,
		platform: about.platform ?? null,
		agent: live.map(value => value.about?.agent).findLast(Boolean) ?? null,
		service: live.some(value => value.about?.service),
		planner: live.some(value => value.about?.planner),
	};
}

export function registerExperimentRoutes(router: Router, auth: HostedAuth, options: Options) {
	let connections = new Connections();
	/**
	 * The stored machine choices, read before any work is routed. A read that fails is retried a
	 * few times, then refuses the work with `machine-choice-unavailable`; it is never taken to mean
	 * nobody chose a machine. The next request, connection or sweep reads again.
	 */
	let reading: Promise<void> | undefined;
	function readChoices(): Promise<void> {
		if (connections.choicesRead) return Promise.resolve();
		reading ??= (async () => {
			for (let attempt = 1;; attempt++) {
				try {
					connections.restore(
						await auth.storage.machines.choices(),
						await auth.storage.machines.favorites(),
					);
					return;
				} catch (error) {
					if (attempt >= CHOICE_READS) {
						console.error("chopin: could not read machine choices -", error);
						fail("machine-choice-unavailable", CHOICE_UNAVAILABLE);
					}
					await Bun.sleep(CHOICE_RETRY_MS * attempt);
				}
			}
		})().finally(() => {
			reading = undefined;
		});
		return reading;
	}
	connections.unread();
	void readChoices().catch(() => {});
	let keys = new PairingKeys(() => auth.clock().getTime());
	auth.pairings.authorized = (userId, sessionId, grant) => keys.authorize(userId, sessionId, grant);
	auth.pairings.ended = sessionId => keys.ended(sessionId);
	let changed = (id: string) => {
		void auth.storage.channels.get(id).then(
			channel => channel && connections.wake(channel.repositoryId),
			() => {},
		);
		options.changed(id);
	};
	let service = new Experiments(auth.storage.experiments, options.lease, changed);
	/** Image hashes each spike run uploaded; a run may only cite its own screenshots. */
	let uploads = new Map<string, Set<string>>();
	function browser(session: AuthenticatedSession): Caller {
		return {
			userId: session.user.id,
			use: async operation => (await auth.sessions.use(session, operation)).value,
		};
	}
	/**
	 * A paired machine checks repositories with its own GitHub authorization. Under
	 * AUTH_MODE=local machines hold none, so they borrow the owner's live login.
	 */
	async function machineCaller(machine: StoredMachine): Promise<Caller> {
		if (auth.machines.durable) {
			return {
				userId: machine.userId,
				use: operation => machineRefusal(() => auth.machines.use(machine, operation)),
			};
		}
		let session = await auth.sessions.forUser(machine.userId);
		if (!session) fail("owner-sign-in-required");
		return browser(session);
	}
	async function machineRefusal<T>(action: () => Promise<T>): Promise<T> {
		try {
			return await action();
		} catch (error) {
			if (error instanceof MachineError) fail(error.code);
			throw error;
		}
	}
	async function access(session: AuthenticatedSession | undefined, id: string, write: boolean) {
		if (!session) fail("authentication-required");
		return { ...await documentAccess(browser(session), id, write), session };
	}
	async function documentAccess(caller: Caller, id: string, write: boolean) {
		let channel = await auth.storage.channels.get(id);
		if (!channel) fail("not-found");
		let repository = await caller.use(
			token => auth.github.repositoryAccess(token, channel.repositoryOwner, channel.repositoryName),
		);
		if (
			!repository || repository.id !== channel.repositoryId || !repository.permissions.pull
			|| write && !(repository.permissions.push || repository.permissions.admin)
		) fail("repository-forbidden");
		if (write && channel.archivedAt) fail("document-archived");
		return { channel, repository };
	}
	/** Push or admin on a repository named by a checkout. */
	async function repositoryWrite(caller: Caller, fullName: string) {
		let [owner, name] = fullName.split("/");
		let repository = await caller.use(token => auth.github.repositoryAccess(token, owner, name));
		if (!repository || !(repository.permissions.push || repository.permissions.admin)) {
			fail("repository-forbidden");
		}
		return repository;
	}
	/** Work only ever runs on the clicker's own live connection for the document's repository. */
	async function busy(connection: Connection) {
		return (await service.store.active()).some(item =>
			item.connectionId === connection.id && ["running", "publishing"].includes(item.state)
		) || !!await options.implementations?.()?.busy(connection);
	}
	/**
	 * The clicker's idle connection, preferring the one last used for this document. When every
	 * connection is busy the work queues behind the first.
	 */
	async function choose(owner: string, repositoryId: string, documentId: string) {
		await readChoices();
		let live = connections.candidates(repositoryId, owner, documentId);
		if (!live.length) await refuseOffline(owner, documentId);
		for (let connection of live) if (!await busy(connection)) return connection;
		return live[0];
	}
	/**
	 * Nothing can take the work: `machine-offline`, naming the machine, when the person chose one,
	 * else `no-workspace`; `machine-choice-unavailable` while their choice cannot be read. A chosen
	 * machine is never silently replaced by another.
	 */
	async function refuseOffline(owner: string, documentId: string): Promise<never> {
		await readChoices();
		let chosen = connections.chosen(documentId, owner);
		if (!chosen) fail("no-workspace");
		fail("machine-offline", offlineMessage((await auth.storage.machines.get(chosen))?.label));
	}
	/**
	 * The documents whose Planner each paired machine was told to run, by machine id, each with its
	 * repository. A document leaves only once the machine's credentials for it are withdrawn, so a
	 * backend it was told to stop cannot attach later. Forgotten with a restart, which also forgets
	 * every credential and releases every Planner.
	 */
	let dispatched = new Map<string, Map<string, string>>();
	/**
	 * Whether a connection can run its owner's Planners on request: it has a Planner command, speaks
	 * protocol 4, and this server runs the remote Planner with machines' own GitHub authorization.
	 */
	function runsPlanners(connection: Connection) {
		return !!options.planners && auth.machines.durable && !!connection.about?.plannerCommand
			&& (connection.protocol ?? 1) >= 4;
	}
	/** Whether a machine has a connection that can run Planners in a repository now. */
	function plannerReady(machineId: string, repositoryId: string) {
		return connections.machine(machineId).some(value =>
			serves(value, repositoryId) && runsPlanners(value)
		);
	}
	/**
	 * Documents someone uses, by id, with when they last were seen in use: open in Chopin, or
	 * their Planner asked for. On Default machine their creator's machine runs their Planner until
	 * one goes PLANNER_IDLE_MS unused. Forgotten with a restart.
	 */
	let inUse = new Map<string, number>();
	/**
	 * The machine Default machine gave each document's Planner to, kept while that machine can run
	 * it, so a working Planner never moves just because another machine came online.
	 */
	let defaults = new Map<string, string>();
	/**
	 * The machine Default machine runs a document's Planner on, while someone uses it and its
	 * creator chose no machine for it: the creator's machine it already runs on while that one can,
	 * else the machine their builds would go to (their favorite, then the one last used for the
	 * document, then any of theirs), counting only machines that can run Planners.
	 */
	function defaultMachine(channel: ChannelRecord): string | undefined {
		if (
			!inUse.has(channel.id) || channel.archivedAt || channel.parentChannelId
			|| !connections.choicesRead || connections.chosen(channel.id, channel.createdBy)
		) {
			defaults.delete(channel.id);
			return undefined;
		}
		let kept = defaults.get(channel.id);
		if (kept && plannerReady(kept, channel.repositoryId)) return kept;
		let next = connections.candidates(channel.repositoryId, channel.createdBy, channel.id, null)
			.find(runsPlanners)?.machineId;
		if (next) defaults.set(channel.id, next);
		else defaults.delete(channel.id);
		return next;
	}
	/** The machine that runs a document's Planner for `userId`: the one they chose, else Default's. */
	function plannerMachine(channel: ChannelRecord, userId: string) {
		return connections.chosen(channel.id, userId)
			?? (userId === channel.createdBy ? defaultMachine(channel) : undefined);
	}
	/**
	 * The documents whose Planner a connection should run, in the repositories it serves: those its
	 * owner chose its machine for, and those of theirs Default machine gives it, except one whose
	 * Planner another account holds, which is never taken over.
	 */
	async function plannerDocuments(connection: Connection): Promise<PlannerAssignment[]> {
		if (!runsPlanners(connection)) return [];
		await readChoices();
		let documents: Array<PlannerAssignment & { repositoryId: string }> = [];
		let add = async (channel: ChannelRecord) =>
			documents.push({
				id: channel.id,
				url: new URL(await documentUrl(channel, auth.storage.channels), auth.config.origin).href,
				repositoryId: channel.repositoryId,
			});
		for (let { documentId, owner } of connections.choosing(connection.machineId)) {
			if (owner !== connection.owner) continue;
			let channel = await auth.storage.channels.get(documentId);
			if (!channel || channel.archivedAt || !serves(connection, channel.repositoryId)) continue;
			let holder = options.attachments?.()?.holding(documentId);
			if (holder && holder.userId !== connection.owner) continue;
			await add(channel);
		}
		for (let documentId of inUse.keys()) {
			let channel = await auth.storage.channels.get(documentId);
			if (
				!channel || channel.createdBy !== connection.owner
				|| !serves(connection, channel.repositoryId)
				|| defaultMachine(channel) !== connection.machineId
			) continue;
			// Nor one its owner's Planner is attached to elsewhere, until that one lets go.
			let holder = options.attachments?.()?.holding(documentId);
			if (
				holder
				&& (holder.userId !== connection.owner
					|| holder.attached && holder.machineId !== connection.machineId)
			) continue;
			await add(channel);
		}
		let told = new Map(dispatched.get(connection.machineId));
		let wanted = new Set(documents.map(document => document.id));
		for (let [documentId, repositoryId] of told) {
			if (!serves(connection, repositoryId) || wanted.has(documentId)) continue;
			// No longer asked, as another account now holds it: a credential it got stops working.
			options.planners?.withdraw(connection.machineId, documentId);
			told.delete(documentId);
		}
		for (let document of documents) told.set(document.id, document.repositoryId);
		if (told.size) dispatched.set(connection.machineId, told);
		else dispatched.delete(connection.machineId);
		return documents.map(({ id, url }) => ({ id, url }));
	}
	/**
	 * Someone uses a document: they opened it, or asked its Planner for something. On Default
	 * machine its creator's machine is asked to run its Planner, if none is yet. A child's Planner
	 * is its root's.
	 */
	async function plannerUsed(documentId: string) {
		if (!options.planners || !auth.machines.durable) return;
		let channel = await auth.storage.channels.get(documentId);
		if (channel?.parentChannelId) {
			channel = await auth.storage.channels.get(channel.parentChannelId);
		}
		if (!channel || channel.archivedAt) return;
		let fresh = !inUse.has(channel.id);
		inUse.set(channel.id, auth.clock().getTime());
		if (!fresh) return;
		await readChoices().catch(() => {});
		connections.wake(channel.repositoryId);
		options.plannerStatus?.(channel.id);
	}
	/**
	 * Whose machine is about to run a document's Planner, when nothing holds it yet: one chosen for
	 * it, or Default machine's, that can run Planners now. Undefined when no machine will.
	 */
	async function plannerStarting(documentId: string): Promise<{ login: string } | undefined> {
		if (!options.planners || !auth.machines.durable) return undefined;
		if (options.attachments?.()?.holding(documentId)) return undefined;
		let channel = await auth.storage.channels.get(documentId);
		if (!channel || channel.archivedAt) return undefined;
		await readChoices().catch(() => {});
		let fallback = defaultMachine(channel);
		for (let machineId of [...connections.chosenFor(documentId), ...fallback ? [fallback] : []]) {
			let live = connections.machine(machineId).find(value =>
				serves(value, channel.repositoryId) && runsPlanners(value)
			);
			if (live) return { login: live.login };
		}
		return undefined;
	}
	/**
	 * A document stops being used once nobody has had it open for PLANNER_IDLE_MS: the machine
	 * Default machine gave its Planner stops running it.
	 */
	async function plannersIdle() {
		let now = auth.clock().getTime();
		for (let [documentId, seen] of inUse) {
			if (options.documentOpen?.(documentId)) {
				inUse.set(documentId, now);
				continue;
			}
			if (now - seen < PLANNER_IDLE_MS) continue;
			inUse.delete(documentId);
			let machineId = defaults.get(documentId);
			defaults.delete(documentId);
			if (!machineId) continue;
			await stopPlanners(
				machineId,
				label =>
					`Nobody has used this document for ${
						PLANNER_IDLE_MS / 60_000
					} minutes, so ${label} stopped running its Planner.`,
				id => id !== documentId,
				documentId,
			);
		}
	}
	/**
	 * Ask a document's Planner of Default machine again, after its creator's favorite or choice
	 * changed: where it ran stops, unless that is where it runs now.
	 */
	async function redefault(channel: ChannelRecord, message: (label: string) => string) {
		let before = defaults.get(channel.id);
		defaults.delete(channel.id);
		let after = plannerMachine(channel, channel.createdBy);
		if (before && before !== after) {
			await stopPlanners(before, message, id => id !== channel.id, channel.id);
		}
		connections.wake(channel.repositoryId);
		options.plannerStatus?.(channel.id);
	}
	/** The documents in use whose Planner `owner`'s machines may run on Default machine. */
	async function created(owner: string) {
		let found: ChannelRecord[] = [];
		for (let documentId of inUse.keys()) {
			let channel = await auth.storage.channels.get(documentId);
			if (channel?.createdBy === owner) found.push(channel);
		}
		return found;
	}
	/**
	 * Stop the Planner backends `machineId` was told to run, except where `keep` says otherwise:
	 * its credentials are withdrawn, then its attached link is refused with `message` and closed.
	 * Its connector, asked again, no longer runs them either. The credentials for `documentId` are
	 * withdrawn even when nothing tracks the machine for it any more.
	 */
	async function stopPlanners(
		machineId: string,
		message: (label: string) => string,
		keep: (documentId: string, repositoryId: string) => boolean = () => false,
		documentId?: string,
	) {
		if (documentId) options.planners?.withdraw(machineId, documentId);
		let told = dispatched.get(machineId);
		if (!told) return;
		let label = (await auth.storage.machines.get(machineId))?.label ?? "The machine";
		for (let [documentId, repositoryId] of told) {
			if (keep(documentId, repositoryId)) continue;
			options.planners?.withdraw(machineId, documentId);
			told.delete(documentId);
			await options.attachments?.()?.stopMachine(documentId, machineId, message(label));
		}
		if (!told.size) dispatched.delete(machineId);
	}
	/**
	 * One of `owner`'s machines connected or disconnected: the documents it may run the Planner of,
	 * chosen for it or on Default machine, are asked again and say who starts their Planner now.
	 */
	async function plannersMoved(machineId: string, owner: string) {
		let documents = new Set(
			connections.choosing(machineId).map(value => value.documentId),
		);
		for (let channel of await created(owner)) documents.add(channel.id);
		for (let documentId of documents) {
			let channel = await auth.storage.channels.get(documentId);
			if (channel) connections.wake(channel.repositoryId);
			options.plannerStatus?.(documentId);
		}
	}
	/**
	 * A connection ended: its machine's Planners stop in each repository it served that none of the
	 * machine's other connections able to run Planners serves, and Default machine's move on.
	 */
	connections.onEnded = connection => {
		let others = connections.machine(connection.machineId).filter(runsPlanners);
		void stopPlanners(
			connection.machineId,
			label => `${label} disconnected from Chopin, so it stopped running this document's Planner.`,
			(_documentId, repositoryId) =>
				!serves(connection, repositoryId) || others.some(value => serves(value, repositoryId)),
		).then(() => plannersMoved(connection.machineId, connection.owner)).catch(error =>
			console.error("chopin: could not stop a disconnected machine's Planner -", error)
		);
	};
	async function mutationAllowed(id: string) {
		if (options.canMutate && !await options.canMutate(id)) fail("document-locked");
	}
	/** A published investigation's views and decisions are also reachable from its child. */
	async function owned(id: string, documentId: string) {
		let value = await service.store.get(id);
		if (!value || value.documentId !== documentId && value.childId !== documentId) {
			fail("not-found");
		}
		return value;
	}
	/** A child's evidence decisions belong to the parent's record, so its build lock applies too. */
	async function parentAllowed(value: Investigation, documentId: string) {
		if (value.documentId !== documentId) await mutationAllowed(value.documentId);
	}
	async function published(value: Investigation) {
		let child = value.childId ? await auth.storage.channels.get(value.childId) : undefined;
		let locked = !!options.canMutate && !await options.canMutate(value.documentId);
		return {
			...publicInvestigation(value),
			...(locked ? { locked } : {}),
			...(child && value.result
				? {
					child: {
						id: child.id,
						title: child.title,
						slug: child.slug,
						summary: investigationSummary(value.brief, value.result),
					},
				}
				: {}),
		};
	}
	function route(
		method: string,
		path: string,
		action: (request: Request, params: Readonly<Record<string, string>>) => Promise<Response>,
	) {
		router.on(method, path, async (request, _url, params) => {
			try {
				if (request.headers.has("origin") && request.headers.get("origin") !== auth.config.origin) {
					fail("origin-forbidden");
				}
				if (
					method !== "GET" && request.headers.has("cookie")
					&& request.headers.get("origin") !== auth.config.origin
				) fail("origin-forbidden");
				return await action(request, params);
			} catch (error) {
				let code = error instanceof ExperimentError
					? error.code
					: error instanceof z.ZodError || error instanceof SyntaxError
					? "invalid-request"
					: "unavailable";
				return json(
					{
						error: code,
						...(error instanceof ExperimentError && error.message !== code
							? { message: error.message }
							: {}),
						...(code === CONNECTOR_UPDATE_REQUIRED ? versions : {}),
					},
					code === "authentication-required"
						|| code.startsWith("machine-") && code !== "machine-offline"
							&& code !== "machine-choice-unavailable"
						? 401
						: code.includes("forbidden") || code === "pairing-key-invalid"
						? 403
						: code === "not-found"
						? 404
						: code === "pairing-key-rate-limited"
						? 429
						: code === "unavailable" || code === "machine-choice-unavailable"
						? 503
						: 409,
				);
			}
		});
	}
	/** What a connector should run: the protocols spoken here and the recommended release. */
	let versions = { protocol: CONNECTOR_PROTOCOLS, version: options.connectorVersion ?? null };
	route("GET", "/api/connector/version", async () => json(versions));
	route("POST", "/api/connector/pairings", async request => {
		compatible(request, auth.config.origin, options.connectorVersion);
		let { key, ...input } = pairingSchema.parse(await body(request));
		if (key !== undefined) return json(await keyed(key, input));
		let created = connections.create(input);
		return json({ ...created, url: `${auth.config.origin}${MACHINES_PATH}?pairing=${created.id}` });
	});
	/**
	 * A signed-in person mints a single-use key that pairs one machine as them, as approving its
	 * pairing would. Where machines hold their own GitHub authorization, GitHub authorizes the next
	 * machine first, in the browser, and the key carries that authorization to the machine. The
	 * key also carries the person's choice of automatic work, as the pairing card's checkbox does.
	 */
	route("POST", "/api/connector/pairing-keys", async request => {
		let { autoRun } = z.object({ autoRun: z.boolean().optional() }).strict().parse(
			await body(request),
		);
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		if (auth.machines.durable && !keys.authorized(session.user.id, session.session.id)) {
			return json({ authorize: "/auth/github/connector?key" });
		}
		return json(keys.mint(session.user.id, session.session.id, autoRun));
	});
	/**
	 * Pair a machine with a key: approved at once as the key's owner, with automatic work as they
	 * chose when minting it (off unless they turned it on), and
	 * a checkout only one the owner can push to, all as approving in the browser would. The key is
	 * spent only once those checks pass, or at once if its owner is no longer admitted here.
	 */
	async function keyed(key: string, input: z.infer<typeof pairingSchema>) {
		let { userId, grant } = keys.peek(key);
		let caller: Caller;
		if (auth.machines.durable) {
			if (!grant) fail("pairing-key-invalid");
			// The allowed users and organizations, as now rather than as when the key was minted.
			if (!await admitted(userId, grant.accessToken)) {
				keys.take(key);
				fail("pairing-account-forbidden");
			}
			caller = { userId, use: operation => operation(grant.accessToken) };
		} else {
			let session = await auth.sessions.forUser(userId);
			if (!session) fail("owner-sign-in-required");
			caller = browser(session);
		}
		let repository = input.repository
			? await repositoryWrite(caller, input.repository)
			: undefined;
		let spent = keys.take(key);
		let { token } = await auth.machines.pair({
			userId,
			label: input.label,
			repositories: repository && input.repository && input.commit
				? [{
					repositoryId: repository.id,
					repository: input.repository,
					commit: input.commit,
					...(input.branch ? { branch: input.branch } : {}),
				}]
				: [],
			autoRun: spent.autoRun,
			...(spent.grant && auth.machines.durable ? { grant: spent.grant } : {}),
		});
		return { token };
	}
	async function admitted(userId: string, token: string) {
		try {
			return (await auth.admission.user(token)).id === userId;
		} catch (error) {
			if (error instanceof AdmissionDenied) return false;
			throw error;
		}
	}
	/** Where the pairing page sends the person once the machine is paired. */
	function landing(input: { repository?: string }) {
		let [owner, name] = input.repository?.split("/") ?? [];
		return owner && name ? documentsPath(owner, name) : "/";
	}
	route("GET", "/api/connector/pairings/:id", async (request, params) => {
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		let pending = connections.pending(params.id);
		if (pending.input.repository) await repositoryWrite(browser(session), pending.input.repository);
		return json({
			input: pending.input,
			owner: session.user.login,
			code: pending.code,
			// Approving hands off to GitHub to authorize the machine, as approve below does.
			authorize: auth.machines.durable,
			...(pending.machineId && pending.approval?.owner === session.user.id
				? { connected: landing(pending.input) }
				: {}),
		});
	});
	/** Pair a machine for the account that approved it, with that machine's own GitHub grant. */
	async function complete(id: string, userId: string, grant?: GitHubTokenGrant) {
		let pending = connections.pending(id);
		let approval = pending.approval;
		if (!approval || approval.owner !== userId) fail("pairing-forbidden");
		if (!pending.machineId) {
			let { machine, token } = await auth.machines.pair({
				userId,
				label: pending.input.label,
				repositories: approval.repositoryId && pending.input.repository && pending.input.commit
					? [{
						repositoryId: approval.repositoryId,
						repository: pending.input.repository,
						commit: pending.input.commit,
						...(pending.input.branch ? { branch: pending.input.branch } : {}),
					}]
					: [],
				autoRun: approval.autoRun,
				...(grant ? { grant } : {}),
			});
			connections.paired(id, machine.id, token);
		}
		return `${MACHINES_PATH}?pairing=${id}`;
	}
	auth.pairings.complete = complete;
	route("POST", "/api/connector/pairings/:id/approve", async (request, params) => {
		// Automatic work is opt-in, once, as the machine is paired; it is off unless asked for.
		let { autoRun } = z.object({ autoRun: z.boolean().optional() }).strict().parse(
			await body(request),
		);
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		let pending = connections.pending(params.id);
		let repository = pending.input.repository
			? await repositoryWrite(browser(session), pending.input.repository)
			: undefined;
		connections.approve(params.id, {
			owner: session.user.id,
			login: session.user.login,
			autoRun: autoRun ?? false,
			...(repository ? { repositoryId: repository.id } : {}),
		});
		// GitHub refresh tokens are single-use, so the machine needs its own authorization.
		if (auth.machines.durable) {
			return json({ authorize: `/auth/github/connector?pairing=${params.id}` });
		}
		await complete(params.id, session.user.id);
		return json({ url: landing(pending.input) });
	});
	route("POST", "/api/connector/pairings/:id/claim", async (request, params) => {
		compatible(request, auth.config.origin, options.connectorVersion);
		let { secret } = z.object({ secret: z.string().min(32).max(100) }).strict().parse(
			await body(request),
		);
		return json(connections.claim(params.id, secret));
	});
	/**
	 * A paired machine connects with the checkouts it has; the connection's token lives only in
	 * memory. Its owner must be able to push to each checkout's repository: protocol 5 leaves out
	 * one they can't and says so in `refused`, while an older connector, whose one checkout is the
	 * only repository it serves, is refused.
	 */
	route("POST", "/api/connector/connections", async request => {
		compatible(request, auth.config.origin, options.connectorVersion);
		let machine = await machineRefusal(() => auth.machines.authenticate(bearer(request)));
		let input = connectionSchema.parse(await body(request));
		let protocol = protocolOf(request);
		let anyRepository = protocol >= ANY_REPOSITORY_PROTOCOL;
		if (!anyRepository && input.checkouts.length !== 1) fail("invalid-request");
		let caller = await machineCaller(machine);
		let checkouts: Source[] = [];
		let refused: string[] = [];
		for (let checkout of input.checkouts) {
			let repository;
			try {
				repository = await repositoryWrite(caller, checkout.repository);
			} catch (error) {
				if (
					!anyRepository
					|| !(error instanceof ExperimentError && error.code === "repository-forbidden")
				) throw error;
				refused.push(checkout.repository);
				continue;
			}
			if (checkouts.some(value => value.repositoryId === repository.id)) continue;
			checkouts.push({ ...checkout, repositoryId: repository.id });
		}
		let user = await auth.storage.users.get(machine.userId);
		let { connection, token } = connections.open(
			{
				id: machine.id,
				owner: machine.userId,
				login: user?.login ?? machine.userId,
				autoRun: machine.autoRun,
				version: releaseVersion(request),
				protocol,
			},
			input.label,
			checkouts,
			aboutMachine(request),
		);
		await auth.machines.seen(machine);
		// Remembered, so `chopin status` and the Machines page can say which checkouts it has.
		for (let checkout of checkouts) {
			if (machine.repositories.some(value => value.repositoryId === checkout.repositoryId)) {
				continue;
			}
			await auth.storage.machines.serve(machine.id, {
				repositoryId: checkout.repositoryId,
				repository: checkout.repository,
				commit: checkout.commit,
				...(checkout.branch ? { branch: checkout.branch } : {}),
			});
		}
		// A connection is a good moment to read choices that could not be read before; its work
		// waits for them either way.
		await readChoices().catch(() => {});
		connections.wakeConnection(connection);
		options.connected?.(anyRepository ? undefined : checkouts[0]!.repositoryId, machine.userId);
		// A machine that can run Planners may be the one to start a document's now.
		if (runsPlanners(connection)) {
			void plannersMoved(machine.id, machine.userId).catch(error =>
				console.error("chopin: could not ask a connected machine for Planners -", error)
			);
		}
		return json({
			token,
			connection: {
				id: connection.id,
				checkouts,
				...(anyRepository ? {} : { source: checkouts[0] }),
			},
			...(refused.length ? { refused } : {}),
			machine: machine.id,
		});
	});
	/** The coding agent a connection runs, as it answered ACP initialize at its first job. */
	route("POST", "/api/connector/agent", async request => {
		compatible(request, auth.config.origin, options.connectorVersion);
		let { connection } = connections.lookup(bearer(request));
		connection.about = { ...connection.about, agent: agentSchema.parse(await body(request)) };
		return json({ ok: true });
	});
	/**
	 * `chopin connect --planner`: a short-lived credential with which the machine's Planner backend
	 * attaches one document over `/api/v1/agent`, checked with the machine's own GitHub token. Under
	 * AUTH_MODE=local machines hold no GitHub token, so there is no such credential to issue.
	 */
	route("POST", "/api/connector/planner", async request => {
		let planners = options.planners;
		if (!planners || !auth.machines.durable) fail("not-found");
		compatible(request, auth.config.origin, options.connectorVersion);
		let machine = await machineRefusal(() => auth.machines.authenticate(bearer(request)));
		let { document } = z.object({ document: z.string().min(1).max(2048) }).strict().parse(
			await body(request),
		);
		let located = await machineRefusal(() => planners.locate(machine, document));
		if (located === "forbidden") fail("repository-forbidden");
		if (!located) fail("not-found");
		let { channel } = await documentAccess(await machineCaller(machine), located.channel.id, true);
		await auth.machines.seen(machine);
		let url = new URL(await documentUrl(channel, auth.storage.channels), auth.config.origin).href;
		// The repository says which of the machine's checkouts the Planner runs in.
		return json({
			...planners.issue(machine, channel.id),
			document: {
				id: channel.id,
				url,
				repository: `${channel.repositoryOwner}/${channel.repositoryName}`,
			},
		});
	});
	/**
	 * A paired machine's own GitHub token, for its Planner commands and runs to push to
	 * `repository` and open draft pull requests as its owner (see `machineGitHubToken`). Under
	 * AUTH_MODE=local machines hold no GitHub token, so there is none to give.
	 */
	route("POST", "/api/connector/github-token", async request => {
		if (!auth.machines.durable) fail("not-found");
		compatible(request, auth.config.origin, options.connectorVersion);
		let machine = await machineRefusal(() => auth.machines.authenticate(bearer(request)));
		let { repository } = z.object({ repository: z.string().min(3).max(256) }).strict().parse(
			await body(request),
		);
		let issued = await machineRefusal(() =>
			machineGitHubToken({ machines: auth.machines, github: auth.github }, machine, repository)
		);
		await auth.machines.seen(machine);
		return json(issued);
	});
	/**
	 * `chopin status`: whether Chopin still accepts this machine's token, without registering a
	 * connection or asking GitHub anything.
	 */
	route("GET", "/api/connector/machine", async request => {
		compatible(request, auth.config.origin, options.connectorVersion);
		let machine = await machineRefusal(() => auth.machines.authenticate(bearer(request)));
		let user = await auth.storage.users.get(machine.userId);
		return json({ id: machine.id, label: machine.label, login: user?.login ?? null });
	});
	/** `chopin unpair`: the machine revokes itself with its own token. */
	route("POST", "/api/connector/machine/revoke", async request => {
		compatible(request, auth.config.origin, options.connectorVersion);
		let machine = await auth.storage.machines.byToken(
			new Uint8Array(createHash("sha256").update(bearer(request)).digest()),
		);
		if (!machine || machine.revokedAt) fail("machine-revoked");
		await auth.machines.revoke(machine.id, machine.userId);
		await disconnectMachine(machine.id);
		return json({ revoked: true });
	});
	route("GET", "/api/connector/machines", async request => {
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		let machines = await auth.machines.list(session.user.id);
		// The star shows only once the favorite is known; the list itself never waits on it.
		await readChoices().catch(() => {});
		let favorite = connections.choicesRead ? connections.favorite(session.user.id) : undefined;
		return json({
			machines: machines.map(machine => ({
				id: machine.id,
				label: machine.label,
				favorite: machine.id === favorite,
				// The checkouts it said it has; it serves every repository its owner can push to.
				repositories: [
					...new Set([
						...machine.repositories.map(value => value.repository),
						...connections.machine(machine.id).flatMap(value =>
							value.checkouts.map(checkout => checkout.repository)
						),
					]),
				],
				autoRun: machine.autoRun,
				createdAt: machine.createdAt.getTime(),
				lastSeenAt: machine.lastSeenAt.getTime(),
				connected: connections.machine(machine.id).length > 0,
				version: connections.machine(machine.id).find(value => value.version)?.version ?? null,
				...described(connections.machine(machine.id)),
				reauthorize: !!machine.reauthorizeAt,
			})),
		});
	});
	/** The owner renames a machine: the name shown in Chopin and by `chopin status`. */
	route("POST", "/api/connector/machines/:id/label", async (request, params) => {
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		let { label } = z.object({ label: machineLabel }).strict().parse(await body(request));
		if (!await auth.machines.rename(params.id, session.user.id, label)) fail("not-found");
		return json({ label });
	});
	/**
	 * The owner sets one of their machines as their favorite, which Automatic prefers, or clears
	 * it. Only one machine is a person's favorite.
	 */
	route("POST", "/api/connector/machines/:id/favorite", async (request, params) => {
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		let { favorite } = z.object({ favorite: z.boolean() }).strict().parse(await body(request));
		let userId = session.user.id;
		// Replacing the favorite needs the stored one known first.
		await readChoices();
		if (!(await auth.machines.list(userId)).some(machine => machine.id === params.id)) {
			fail("not-found");
		}
		if (favorite || connections.favorite(userId) === params.id) {
			let machineId = favorite ? params.id : undefined;
			let changed = connections.favorite(userId) !== machineId;
			await auth.storage.machines.favor(
				{ userId, ...(machineId ? { machineId } : {}) },
				auth.clock(),
			);
			connections.favor(userId, machineId);
			// Default machine's Planners of the person's documents follow the new favorite.
			for (let channel of changed ? await created(userId) : []) {
				await redefault(
					channel,
					label =>
						`${session.user.login} changed their favorite machine, so ${label} stopped running `
						+ "this document's Planner.",
				);
			}
		}
		return json({ favorite: connections.favorite(userId) ?? null });
	});
	route("POST", "/api/connector/machines/:id/revoke", async (request, params) => {
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		z.object({}).strict().parse(await body(request));
		if (!await auth.machines.revoke(params.id, session.user.id)) fail("not-found");
		await disconnectMachine(params.id);
		return json({ revoked: true });
	});
	/**
	 * The caller's own machines, whatever repositories they have checkouts of, the one they chose
	 * for a document (null for automatic), and the machine automatic would use now. A machine is
	 * connected for the document when one of its live connections serves its repository. Only ever
	 * the caller's own.
	 */
	async function machineChoice(userId: string, channel: ChannelRecord) {
		let { id: documentId, repositoryId } = channel;
		await readChoices();
		let serving = await auth.machines.list(userId);
		let chosen = connections.chosen(documentId, userId);
		// What Automatic would use now, shown beside it even while a machine is chosen.
		let automatic: Connection | undefined;
		let live = connections.candidates(repositoryId, userId, documentId, null);
		for (let connection of live) {
			if (!await busy(connection)) {
				automatic = connection;
				break;
			}
		}
		automatic ??= live[0];
		let label = (id: string) => serving.find(machine => machine.id === id)?.label ?? null;
		let favorite = connections.favorite(userId);
		let capable = (machineId: string) => {
			let live = connections.machine(machineId);
			return live.length
				? live.some(value => serves(value, repositoryId) && runsPlanners(value))
				: !!options.planners && auth.machines.durable
					&& !!connections.about(machineId)?.plannerCommand;
		};
		return {
			choice: chosen ?? null,
			/** The caller's favorite machine, which Automatic prefers where it serves the repository. */
			favorite: favorite ?? null,
			planner: plannerState(userId, channel, serving),
			automatic: automatic
				? {
					id: automatic.machineId,
					label: label(automatic.machineId),
					favorite: automatic.machineId === favorite,
				}
				: null,
			machines: serving.map(machine => {
				let live = connections.machine(machine.id);
				return {
					id: machine.id,
					label: machine.label,
					connected: live.some(value => serves(value, repositoryId)),
					reauthorize: !!machine.reauthorizeAt,
					lastSeenAt: machine.lastSeenAt.getTime(),
					version: live.find(value => value.version)?.version ?? null,
					...described(live),
					// An offline machine keeps its server or computer icon.
					service: live.length
						? live.some(value => value.about?.service)
						: !!connections.about(machine.id)?.service,
					// Whether it can run the document's Planner when chosen: it has a Planner command.
					runsPlanners: capable(machine.id),
				};
			}),
		};
	}
	/**
	 * Who runs the document's Planner, as its chooser sees it, or null when Chopin does not run
	 * Planners on machines: `held` by another account (named), `attached` through the caller's own
	 * account (with which of their machines, if one), `starting` while the machine chosen for it,
	 * or Default machine's for its creator, has yet to attach, else `none`.
	 */
	function plannerState(userId: string, channel: ChannelRecord, serving: Array<{ id: string }>) {
		if (!options.planners || !auth.machines.durable) return null;
		let holder = options.attachments?.()?.holding(channel.id);
		if (holder && holder.userId !== userId) {
			return { state: "held" as const, login: holder.login, machine: null };
		}
		if (holder?.attached) {
			let machine = serving.some(value => value.id === holder.machineId) ? holder.machineId! : null;
			return { state: "attached" as const, login: holder.login, machine };
		}
		let machine = plannerMachine(channel, userId);
		if (machine && plannerReady(machine, channel.repositoryId)) {
			return { state: "starting" as const, login: null, machine };
		}
		return { state: "none" as const, login: null, machine: null };
	}
	route("GET", "/api/documents/:id/machine", async (request, params) => {
		let { session, channel } = await access(
			await auth.sessions.authenticate(request),
			params.id,
			false,
		);
		return json(await machineChoice(session.user.id, channel));
	});
	/** Choose one of the caller's machines for a document's work, or null for automatic. */
	route("POST", "/api/documents/:id/machine", async (request, params) => {
		let { session, channel } = await access(
			await auth.sessions.authenticate(request),
			params.id,
			true,
		);
		let { machine } = z.object({ machine: z.string().min(1).max(100).nullable() }).strict().parse(
			await body(request),
		);
		let userId = session.user.id;
		// Choosing replaces a stored choice, so the stored ones must be known first.
		await readChoices();
		if (machine !== null) {
			let current = await machineChoice(userId, channel);
			if (!current.machines.some(value => value.id === machine)) {
				let owned = (await auth.machines.list(userId)).some(value => value.id === machine);
				fail(owned ? "repository-unserved" : "not-found");
			}
		}
		await auth.storage.machines.choose(
			{ channelId: channel.id, userId, ...(machine ? { machineId: machine } : {}) },
			auth.clock(),
		);
		// Where the person's Planner of the document runs now, chosen or Default machine's.
		let previous = plannerMachine(channel, userId);
		connections.choose(channel.id, userId, machine ?? undefined);
		// Default machine picks again for its creator, as for any change of choice.
		if (userId === channel.createdBy) defaults.delete(channel.id);
		let next = plannerMachine(channel, userId);
		// The machine that ran it stops, unless it is the one that runs it now; the new one starts.
		if (previous && previous !== next) {
			await stopPlanners(
				previous,
				label =>
					`${session.user.login} chose ${
						machine ? "another machine" : "Default machine"
					} for this document, so ${label} stopped running its Planner.`,
				documentId => documentId !== channel.id,
				channel.id,
			);
		}
		connections.wake(channel.repositoryId);
		options.chosen?.(channel.id, userId);
		options.plannerStatus?.(channel.id);
		return json(await machineChoice(userId, channel));
	});
	route("GET", "/api/documents/:id/experiments", async (request, params) => {
		await access(await auth.sessions.authenticate(request), params.id, false);
		let source = await service.store.published(params.id);
		return json({
			// A spike's callout under its passage is its record in the document.
			experiments: [
				...(await service.store.list(params.id)).filter(value => !value.spike),
				...(source ? [source] : []),
			].map(value => ({
				id: value.id,
				brief: value.brief,
				buildBlocker: value.buildBlocker,
				state: value.state,
				revision: value.revision,
				requester: value.requester,
				decisionCount: value.decisions.length,
				progress: value.progress,
				createdAt: value.createdAt,
			})),
		});
	});
	route("POST", "/api/documents/:id/experiments", async (request, params) => {
		let { session, channel } = await access(
			await auth.sessions.authenticate(request),
			params.id,
			true,
		);
		// Like Research, investigations start only in a top-level document.
		if (channel.parentChannelId) fail("child-document");
		await mutationAllowed(params.id);
		let input = z.object({
			id: z.string().uuid(),
			brief: z.string().min(1).max(limits.brief),
		}).strict().parse(await body(request));
		return json(
			publicInvestigation(
				await service.create(params.id, session.user.id, input.brief, input.id),
			),
		);
	});
	route("GET", "/api/documents/:id/experiments/:experiment", async (request, params) => {
		await access(await auth.sessions.authenticate(request), params.id, false);
		return json(await published(await owned(params.experiment, params.id)));
	});
	route("GET", "/api/documents/:id/investigation-provenance", async (request, params) => {
		await access(await auth.sessions.authenticate(request), params.id, false);
		let value = await service.store.published(params.id);
		if (!value) fail("not-found");
		let user = await auth.storage.users.get(value.requester);
		return json(
			{
				investigationId: value.id,
				parentChannelId: value.documentId,
				brief: value.brief,
				viewCount: value.result?.views.length ?? 0,
				...(user ? { startedBy: user.login } : {}),
			} satisfies InvestigationProvenance,
		);
	});
	route("POST", "/api/documents/:id/experiments/:experiment/run", async (request, params) => {
		let { session, channel } = await access(
			await auth.sessions.authenticate(request),
			params.id,
			true,
		);
		await mutationAllowed(params.id);
		z.object({}).strict().parse(await body(request));
		let value = await service.store.get(params.experiment);
		if (!value || value.documentId !== params.id) fail("not-found");
		let context = await options.context(params.id);
		if (!context) fail("not-found");
		let connection = await choose(session.user.id, channel.repositoryId, params.id);
		let result = await service.authorize(value.id, connection.id, {
			id: value.id,
			documentId: params.id,
			requester: value.requester,
			authorizer: session.user.id,
			brief: value.brief,
			source: value.input?.source ?? await sourceFor(connection, channel.id),
			context: `Document revision ${context.revision}\n${context.source}`,
		});
		connections.use(params.id, connection.id);
		return json(publicInvestigation(result));
	});
	route("POST", "/api/documents/:id/experiments/:experiment/retry", async (request, params) => {
		await access(await auth.sessions.authenticate(request), params.id, true);
		await mutationAllowed(params.id);
		z.object({}).strict().parse(await body(request));
		let value = await service.store.get(params.experiment);
		if (!value || value.documentId !== params.id) fail("not-found");
		return json(publicInvestigation(await service.retry(value.id)));
	});
	route("POST", "/api/documents/:id/experiments/:experiment/cancel", async (request, params) => {
		let { session } = await access(await auth.sessions.authenticate(request), params.id, true);
		let value = await service.store.get(params.experiment);
		if (!value || value.documentId !== params.id) fail("not-found");
		// Withdrawing a ready card runs nothing, so any writer may; running work is its runner's.
		// Checked on the record being written: a stale "Ready to run" must not stop someone's run.
		let stopped = await service.stop(value.id, "cancelled", "Cancelled by owner.", current => {
			if (
				current.state !== "requested"
				&& (current.input?.authorizer ?? current.requester) !== session.user.id
			) fail("connection-forbidden");
		});
		return json(publicInvestigation(stopped));
	});

	/** End a revoked machine's live connections, as a connector disconnecting does. */
	async function disconnectMachine(machineId: string, code?: string) {
		let live = connections.machine(machineId);
		connections.revokeMachine(machineId, code);
		await stopPlanners(
			machineId,
			label =>
				`${label} was disconnected from Chopin, so it stopped running this document's Planner.`,
		);
		// Storage forgets a revoked machine's choices with it.
		if (code === undefined) connections.unchoose(machineId);
		for (let connection of live) await interrupt(connection);
	}
	async function disconnect(connection: Connection) {
		connections.revoke(connection.id);
		await interrupt(connection);
	}
	async function interrupt(connection: Connection) {
		for (let active of await work(connection, ["queued", "running", "publishing"])) {
			await service.stop(active.id, "interrupted", "Workspace disconnected.");
		}
		await options.implementations?.()?.disconnected(connection.id);
	}
	/**
	 * Re-authorize a connection's machine, its owner for an older connector's one repository, and
	 * for a run's document, with the machine's own GitHub authorization rather than a browser login.
	 * A connection that serves any repository is checked per document, as its work is claimed.
	 */
	async function connector(token: string) {
		let found = connections.lookup(token);
		let machine: StoredMachine;
		try {
			machine = await auth.machines.current(found.connection.machineId);
		} catch (error) {
			if (error instanceof MachineError) {
				await disconnectMachine(found.connection.machineId, error.code);
			}
			throw error;
		}
		let caller = await machineCaller(machine);
		let refused = async (error: unknown, repositoryId?: string): Promise<never> => {
			if (error instanceof ExperimentError && error.code.startsWith("machine-")) {
				await disconnectMachine(machine.id, error.code);
			}
			// Without push access the machine's owner can no longer run its Planners there.
			if (
				repositoryId && error instanceof ExperimentError && error.code === "repository-forbidden"
			) {
				await stopPlanners(
					machine.id,
					label =>
						`${found.connection.login} can no longer push to this document's repository, so `
						+ `${label} stopped running its Planner.`,
					(_documentId, repository) => repository !== repositoryId,
				);
			}
			throw error;
		};
		let single = found.connection.anyRepository ? undefined : found.connection.checkouts[0];
		if (single) {
			let repository = await repositoryWrite(caller, single.repository)
				.catch(error => refused(error, single.repositoryId));
			if (repository.id !== single.repositoryId) fail("repository-forbidden");
		}
		if (found.grant.run) {
			await target(caller, found.connection, found.grant.run.documentId)
				.catch(error => refused(error));
		} else if (!single) {
			// Its authorization is still renewed and its owner still admitted, as a repository check
			// would, without asking GitHub about any repository.
			await caller.use(async () => {}).catch(error => refused(error));
		}
		if (!connections.get(found.connection.id)) fail("connection-unavailable");
		await auth.machines.seen(machine);
		let stale = !connections.fresh(found.connection);
		connections.touch(found.connection);
		// Work held back from a silent connection can go to it again now it is heard from.
		if (stale) options.connected?.(single?.repositoryId, found.connection.owner);
		return { ...found, caller };
	}
	/**
	 * Write access to a run's document, as the machine's owner, in a repository the connection
	 * serves.
	 */
	async function target(caller: Caller, connection: Connection, documentId: string) {
		let { channel } = await documentAccess(caller, documentId, true);
		if (!serves(connection, channel.repositoryId)) fail("repository-forbidden");
		return channel;
	}
	/**
	 * The checkout a connection's work on a document starts from: the one it said it has of the
	 * document's repository, else the head of the repository's default branch on GitHub, read with
	 * the machine's own authorization, which its connector clones or fetches.
	 */
	async function sourceFor(connection: Connection, documentId: string): Promise<Source> {
		let channel = await auth.storage.channels.get(documentId);
		if (!channel) fail("not-found");
		let repository = {
			id: channel.repositoryId,
			owner: channel.repositoryOwner,
			name: channel.repositoryName,
		};
		let checkout = checkoutOf(connection, repository.id);
		if (checkout) return checkout;
		if (!connection.anyRepository) fail("repository-forbidden");
		let caller = await machineCaller(
			await machineRefusal(() => auth.machines.current(connection.machineId)),
		);
		let found = await caller.use(token =>
			auth.github.repositoryAccess(token, repository.owner, repository.name)
		);
		if (!found || found.id !== repository.id) fail("repository-forbidden");
		let github = auth.github;
		if (!github.branchHead) fail("no-workspace");
		let commit = await caller.use(token =>
			github.branchHead!(token, repository.owner, repository.name, found.defaultBranch)
		);
		return {
			repositoryId: repository.id,
			repository: found.fullName,
			commit,
			branch: found.defaultBranch,
		};
	}
	/** The connection's queued, running, or publishing investigations across its repository. */
	/** A connection's work in creation order, so queued runs are dispatched first come first served. */
	async function work(connection: Connection, states: string[]) {
		return (await service.store.active()).filter(item =>
			item.connectionId === connection.id && states.includes(item.state)
		).sort((a, b) => a.createdAt - b.createdAt);
	}
	route(
		"GET",
		"/api/documents/:id/experiments/:experiment/export/:dataset",
		async (request, params) => {
			await access(await auth.sessions.authenticate(request), params.id, false);
			let value = await owned(params.experiment, params.id);
			let dataset = value.result?.datasets.find(item => item.key === params.dataset);
			if (!dataset) fail("not-found");
			let csv = new URL(request.url).searchParams.get("format") === "csv";
			return new Response(csv ? datasetCsv(dataset) : JSON.stringify(dataset, null, 2), {
				headers: {
					"content-type": csv ? "text/csv; charset=utf-8" : "application/json",
					"content-disposition": `attachment; filename="${dataset.key}.${csv ? "csv" : "json"}"`,
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
				},
			});
		},
	);
	route("POST", "/api/documents/:id/experiments/:experiment/decision", async (request, params) => {
		let { session } = await access(await auth.sessions.authenticate(request), params.id, true);
		await mutationAllowed(params.id);
		let value = await owned(params.experiment, params.id);
		await parentAllowed(value, params.id);
		return json(await published(await service.decide(value.id, session.user, await body(request))));
	});
	route("POST", "/api/documents/:id/experiments/:experiment/placement", async (request, params) => {
		await access(await auth.sessions.authenticate(request), params.id, true);
		await mutationAllowed(params.id);
		let input = z.object({
			view: z.string().min(1).max(64),
			decision: z.string().uuid().optional(),
			remove: z.boolean().optional(),
		}).strict().parse(await body(request));
		let value = await owned(params.experiment, params.id);
		await parentAllowed(value, params.id);
		if (!value.result?.views.some(view => view.key === input.view)) fail("not-found");
		if (
			input.decision
			&& !value.decisions.some(decision =>
				decision.id === input.decision && decision.view === input.view
			)
		) fail("not-found");
		if (!options.place) fail("unavailable");
		await options.place(
			params.id,
			value.id,
			input.view,
			input.decision ?? "",
			input.remove ?? false,
		);
		return json(await published(value));
	});
	route("POST", "/api/documents/:id/experiments/:experiment/state", async (request, params) => {
		let { session } = await access(await auth.sessions.authenticate(request), params.id, true);
		let value = await owned(params.experiment, params.id);
		let input = z.object({ view: z.string().max(64), patch: z.unknown() }).strict().parse(
			await body(request),
		);
		return json(
			await published(await service.select(value.id, session.user.id, input.view, input.patch)),
		);
	});
	route("GET", "/connector/mcp", async () => new Response(null, { status: 405 }));
	route("DELETE", "/connector/mcp", async request => {
		compatible(
			request,
			auth.config.origin,
			options.connectorVersion,
			connections.run(bearer(request)),
		);
		let { connection, grant } = await connector(bearer(request));
		if (!grant.run) connections.revoke(connection.id);
		return new Response(null, { status: 204 });
	});
	route("POST", "/connector/mcp", async request => {
		let token = bearer(request);
		compatible(request, auth.config.origin, options.connectorVersion, connections.run(token));
		let { connection, grant, caller } = await connector(token);
		let implementation = options.implementations?.();
		let implementationRun = grant.run?.kind === "implementation" || grant.run?.kind === "rebuild";
		let spikeRun = !!grant.run && !implementationRun
			&& !!(await service.store.get(grant.run.id))?.spike;
		let schemas = implementationRun ? implementationSchemas(true, grant.run?.kind === "rebuild") : {
			...connectorSchemas(!!grant.run, spikeRun),
			...(!grant.run && implementation ? implementationSchemas(false) : {}),
		};
		// Only a run-scoped investigation's image upload may exceed the ordinary body limit.
		let bytes = await raw(
			request,
			grant.run && !implementationRun
				? Math.max(MAX_BODY_BYTES, MAX_IMAGE_REQUEST_BYTES)
				: MAX_BODY_BYTES,
		);
		let call = z.object({
			jsonrpc: z.literal("2.0"),
			id: z.union([z.string(), z.number()]).optional(),
			method: z.string(),
			params: z.record(z.string(), z.unknown()).optional(),
		}).parse(JSON.parse(bytes.toString("utf8")));
		if (
			bytes.length > MAX_BODY_BYTES
			&& (call.method !== "tools/call" || call.params?.name !== "upload_investigation_image")
		) fail("request-too-large");
		let respond = (result: unknown) => json({ jsonrpc: "2.0", id: call.id, result });
		if (call.method.startsWith("notifications/")) return new Response(null, { status: 202 });
		if (call.method === "initialize") {
			return respond({
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "chopin-connector", version: "0.1.0" },
			});
		}
		if (call.method === "ping") return respond({});
		if (call.method === "tools/list") {
			return respond({
				tools: Object.entries(schemas).map(([name, schema]) => ({
					name,
					description: name.replaceAll("_", " "),
					inputSchema: z.toJSONSchema(schema, { unrepresentable: "any" }),
				})),
			});
		}
		if (call.method !== "tools/call") {
			return json({
				jsonrpc: "2.0",
				id: call.id,
				error: { code: -32601, message: "Unknown method" },
			});
		}
		try {
			let name = String(call.params?.name);
			if (!Object.hasOwn(schemas, name)) fail("tool-forbidden");
			let args = schemas[name].parse(call.params?.arguments ?? {});
			if (name === "read_investigation") name = "read_experiment";
			if (name === "submit_investigation_result") name = "submit_experiment_result";
			let value: unknown;
			if (name === "disconnect_workspace") {
				// The connection ends; the paired machine stays paired.
				await disconnect(connection);
				value = { disconnected: true };
			} else if (name === "wait_for_work" && args.planners) {
				// A protocol 4 connector's Planner poll: what it should run, once that differs from what
				// it runs. Never work, which its own poll without `planners` waits for.
				let running = new Set(args.planners as string[]);
				let changed = async (): Promise<PlannerControl | undefined> => {
					let planners = await plannerDocuments(connection);
					return planners.length === running.size && planners.every(value => running.has(value.id))
						? undefined
						: { kind: "planners", planners };
				};
				value = await changed();
				if (!value) {
					await connections.wait(connection, request.signal);
					await connector(token);
					value = await changed();
				}
				value ??= { waiting: true };
			} else if (name === "wait_for_work") {
				// A build in an archived document cannot be claimed; its expiry fails it in the sweep.
				let build = async () => {
					let offered = await implementation!.waiting(connection);
					let documentId = connections.assigned(connection.id);
					let channel = offered && documentId
						? await auth.storage.channels.get(documentId)
						: undefined;
					return channel && !channel.archivedAt ? offered : undefined;
				};
				let queued = async () =>
					await build()
						?? (await implementation!.busy(connection)
							? undefined
							: (await work(connection, ["queued"])).map(item => ({
								id: item.id,
								kind: "experiment",
							}))[0]);
				value = await queued();
				if (!value) {
					await connections.wait(connection, request.signal);
					await connector(token);
					value = await queued();
				}
				value ??= { waiting: true };
			} else if (implementationRun || Object.hasOwn(implementationSchemas(false), name)) {
				if (!implementation) fail("tool-forbidden");
				let documentId = grant.run?.documentId ?? connections.assigned(connection.id);
				let channel = documentId ? await target(caller, connection, documentId) : undefined;
				if (name === "claim_implementation_build") {
					value = await connections.locked(connection.id, async () => {
						if ((await work(connection, ["running", "publishing"])).length) {
							fail("workspace-busy");
						}
						return implementation.call(connection, grant, name, args);
					});
					// The connector names the document in its terminal.
					if (channel?.title) value = { ...value as object, title: channel.title };
				} else value = await implementation.call(connection, grant, name, args);
			} else if (name === "wait_for_experiment") {
				let queued = async () => (await work(connection, ["queued"]))[0];
				value = await queued();
				if (!value) {
					await connections.wait(connection, request.signal);
					await connector(token);
					value = await queued();
				}
				value = value ? { id: (value as { id: string }).id } : { waiting: true };
			} else if (name === "claim_experiment") {
				let id = z.string().uuid().parse(args.id);
				value = await connections.locked(connection.id, async () => {
					let active = (await work(connection, ["running", "publishing"]))[0];
					if (active && active.id !== id || await implementation?.busy(connection)) {
						fail("workspace-busy");
					}
					let offered = await service.store.get(id);
					if (!offered || offered.connectionId !== connection.id) fail("connection-forbidden");
					let channel;
					try {
						channel = await target(caller, connection, offered.documentId);
						await mutationAllowed(offered.documentId);
					} catch (error) {
						// One archived or building document must not stall the repository's connector.
						if (
							!(error instanceof ExperimentError)
							|| !["document-archived", "document-locked"].includes(error.code)
						) throw error;
						await service.stop(
							id,
							"interrupted",
							"The document changed before your local agent started. Propose a retry.",
						);
						fail("invalid-state");
					}
					let claimed = await service.claim(id, connection.id);
					return {
						input: claimed.input,
						generation: claimed.generation,
						...(claimed.spike ? { spike: true, passage: claimed.spike.passage } : {}),
						...(channel.title ? { title: channel.title } : {}),
						runToken: connections.runToken(
							connection.id,
							claimed.documentId,
							id,
							claimed.generation,
						),
					};
				});
			} else {
				let id = grant.run?.id ?? z.string().uuid().parse(args.id);
				let generation = grant.run?.generation
					?? z.number().int().positive().parse(args.generation);
				let current = await service.store.get(id);
				if (
					!current || current.connectionId !== connection.id
					|| grant.run && current.documentId !== grant.run.documentId
				) fail("connection-forbidden");
				if (!grant.run) await target(caller, connection, current.documentId);
				// A spike's result is only ever its own short report, through submit_spike_result.
				if (
					current.spike
					&& ["submit_experiment_result", "submit_investigation_result"].includes(name)
				) fail("tool-forbidden");
				if (name === "complete_experiment") {
					value = await service.complete(id, connection.id, generation);
				} else if (name === "fail_experiment") {
					// Checked inside the write, so a report retried after a lost answer lands once and a
					// report delayed past a retry is refused rather than failing the next attempt.
					value = await service.failClaim(
						id,
						connection.id,
						generation,
						z.string().max(2000).parse(args.error),
					);
				} else {
					service.assertClaim(current, connection.id, generation);
					if (name === "read_experiment") value = { input: current.input, capabilities };
					else if (name === "renew_experiment") {
						value = await service.renew(
							id,
							connection.id,
							generation,
							args.progress === undefined ? undefined : z.string().max(2000).parse(args.progress),
						);
					} else if (name === "upload_investigation_image") {
						let prepared = prepareImage({ id: current.documentId, ...args });
						if (!prepared) fail("invalid-image");
						if ("refusal" in prepared) fail(prepared.refusal);
						let { bytes, mimeType } = prepared.input;
						let sha256 = createHash("sha256").update(bytes).digest("hex");
						// Parallel uploads share one set and reserve their slot before awaiting storage,
						// so neither overwrites the other's record nor slips past the cap.
						let uploaded = uploads.get(id);
						if (!uploaded) uploads.set(id, uploaded = new Set<string>());
						let reserved = !uploaded.has(sha256);
						if (reserved && uploaded.size >= MAX_INVESTIGATION_IMAGES) {
							fail(
								"image-limit",
								`An investigation may upload at most ${MAX_INVESTIGATION_IMAGES} images.`,
							);
						}
						uploaded.add(sha256);
						try {
							await auth.storage.images.put({
								channelId: current.documentId,
								sha256,
								mimeType,
								bytes,
								uploadedBy: connection.owner,
								now: new Date(),
							});
						} catch (err) {
							if (reserved) uploaded.delete(sha256);
							throw err;
						}
						value = { path: imagePath(sha256, mimeType) };
					} else if (name === "submit_spike_result") {
						if (!current.spike) fail("tool-forbidden");
						let input = spikeSubmissionSchema.parse(args);
						for (let path of input.images) {
							let sha256 = path.slice("/images/".length).split(".")[0];
							if (
								!uploads.get(id)?.has(sha256)
								|| !await auth.storage.images.get(current.documentId, sha256)
							) fail("missing-image", `Upload ${path} with upload_investigation_image first.`);
						}
						let report = canonicalReport(spikeReport(input));
						if ("issues" in report) {
							fail("invalid-report", report.issues.map(issue => issue.message).join("; "));
						}
						value = await service.candidate(id, connection.id, generation, {
							schemaVersion: 1,
							report: report.source,
							datasets: [],
							views: [],
							evidence: [],
							provenance: {
								environment: "Throwaway prototype by the editor's local coding agent.",
								checks: [],
								limitations: [],
							},
						});
					} else if (name === "submit_experiment_result") {
						let result = args.result as { report?: unknown };
						if (!result || typeof result.report !== "string") fail("invalid-result");
						let source = canonicalReport(result.report);
						if ("issues" in source) {
							fail(
								"invalid-report",
								source.issues.map(issue => issue.message).join("; ").slice(0, 4000),
							);
						}
						if (
							JSON.stringify(parse(source.source)).match(
								/"name":"(Questionnaire|Question|Decision|Research|Investigation|Experiment)"/,
							)
						) fail("protected-report");
						value = await service.candidate(id, connection.id, generation, {
							...result,
							report: source.source,
						});
					} else fail("unknown-tool");
				}
				value = {
					accepted: true,
					state: (value as { state?: string }).state,
					...(name === "read_experiment" || name === "upload_investigation_image"
						? value as object
						: {}),
				};
			}
			return respond({ content: [{ type: "text", text: JSON.stringify(value) }] });
		} catch (error) {
			return respond({
				isError: true,
				content: [{
					type: "text",
					text: error instanceof ExperimentError
						? `${error.code}: ${error.message}`
						: error instanceof z.ZodError
						? error.message.slice(0, 4000)
						: "invalid-request",
				}],
			});
		}
	});
	async function sweep() {
		connections.sweep();
		await plannersIdle().catch(error =>
			console.error("chopin: could not stop an unused document's Planner -", error)
		);
		// Automatic work (rebuilds, prototypes) resumes once the stored choices can be read.
		await readChoices().catch(() => {});
		keys.sweep();
		await service.recover();
		await options.implementations?.()?.sweep();
		let active = await service.store.active();
		for (let id of uploads.keys()) {
			if (!active.some(value => value.id === id)) uploads.delete(id);
		}
		for (let value of active) {
			let started = value.spike?.startedAt;
			if (
				started !== undefined && ["running", "publishing"].includes(value.state)
				&& Date.now() - started > SPIKE_DEADLINE_MS
			) {
				await service.stop(
					value.id,
					"interrupted",
					"The prototype ran past its 20-minute limit, so Chopin stopped it.",
				);
				continue;
			}
			if (value.connectionId && !connections.get(value.connectionId)) {
				await service.stop(
					value.id,
					"interrupted",
					"Workspace connection expired. Propose a new attempt to retry.",
				);
			}
		}
	}
	/** A document's Planner attached, detached or was released: its chosen machines are asked again. */
	function plannerChanged(channelId: string) {
		void auth.storage.channels.get(channelId).then(
			channel => channel && connections.wake(channel.repositoryId),
			() => {},
		);
	}
	return {
		service,
		connections,
		access,
		mutationAllowed,
		route,
		body,
		json,
		sweep,
		refuseOffline,
		machineChoices: readChoices,
		plannerChanged,
		plannerUsed,
		plannerStarting,
		/** Whether this server runs Planners on people's machines: HARNESS=remote, machines' own GitHub. */
		plannerMachines: !!options.planners && auth.machines.durable,
		sourceFor,
	};
}
