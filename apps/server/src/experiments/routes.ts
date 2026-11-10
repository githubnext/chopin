import { z } from "zod";
import { capabilities, ExperimentError, limits, sourceSchema } from "@chopin/experiment";
import { publicInvestigation } from "@chopin/experiment/records";
import type { Investigation, InvestigationProvenance } from "@chopin/experiment/records";
import type { HostedAuth } from "../auth/routes";
import { AdmissionDenied } from "../auth/admission";
import { ownOrigin } from "../auth/config";
import { MachineError } from "../auth/machines";
import type {
	GitHubInstallation,
	GitHubTokenGrant,
	InstallationPage,
	Repository,
	RepositoryPage,
} from "../github/client";
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
	parseSandboxReport,
} from "@chopin/protocol/connector";
import type { Session } from "@chopin/protocol";
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

/**
 * What a person is told when the teammate's shared machine they chose for a document no longer
 * takes their builds, runs or investigations: its owner stopped sharing it or can't push to the
 * repository.
 */
export function unavailableMessage(label: string) {
	return `${label} no longer takes this work: its owner stopped sharing it or can't push to this `
		+ "repository. Choose another machine.";
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
	let sandbox = parseSandboxReport(header);
	return {
		...(hostname && /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(hostname) ? { hostname } : {}),
		...(os && arch && !extra && OSES.has(os) && ARCHES.has(arch) ? { platform: { os, arch } } : {}),
		service: header(CONNECTOR_SERVICE_HEADER) === "1",
		planner: header(CONNECTOR_PLANNER_HEADER) === "1",
		plannerCommand: header(CONNECTOR_PLANNER_COMMAND_HEADER) === "1",
		...(agent.success ? { agent: agent.data } : {}),
		...(sandbox ? { sandbox } : {}),
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

/** A repository as GitHub names it, for the checks of whether someone can push to it. */
type ReachRepository = { id: string; owner: string; name: string };

/** The key of a held push check: who was asked, a machine or `viewer:` and a person, and what. */
function reachKey(who: string, repositoryId: string) {
	return `${who}\n${repositoryId}`;
}

/** The repository as GitHub names it when `access` lets its account push to it, else none. */
function pushing(access: Repository | undefined, repository: ReachRepository) {
	return access && access.id === repository.id && access.permissions.pull
			&& (access.permissions.push || access.permissions.admin)
		? { id: access.id, owner: access.owner, name: access.name }
		: undefined;
}

/** The repository a checkout names as `owner/name`, with its id; none when it names no owner. */
function named(repository: string, id: string): ReachRepository[] {
	let [owner, name] = repository.split("/");
	return owner && name ? [{ id, owner, name }] : [];
}

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
 * it: it is open in Chopin, its Planner waits on a question or a live or paused workflow run, or
 * either was so within this long.
 */
export const PLANNER_IDLE_MS = 30 * 60_000;
/**
 * How long a check that a shared machine's owner can push to a document's repository holds: a
 * pass for this long, a refusal for a minute, before Default machine asks GitHub again.
 */
export const SHARED_REACH_MS = 10 * 60_000;
const SHARED_RETRY_MS = 60_000;
/** How many of a machine's checkouts the Machines page checks with GitHub at once. */
const SHARED_CHECKED_AT_ONCE = 8;
/** How long the Machines page remembers the repositories a person can push to. */
const SHARED_VIEWER_MS = 60_000;
/** The pages of installations, and of repositories in each, a list of what someone can push to reads. */
const LISTED_PAGES = 100;
/** Why a machine that is no longer shared stopped a teammate's Planner, told to its connector. */
function stoppedSharing(login: string) {
	return (label: string) =>
		`${login} stopped sharing ${label} with teammates, so it stopped running this document's Planner.`;
}
/**
 * The connector protocols this server speaks; a connector outside them must update first.
 * Protocol 2 pairs a machine once and connects checkouts with its stored token. Protocol 4 polls
 * `wait_for_work` with the Planners it runs, and is answered with the ones its owner chose it for
 * and those Default machine gives it.
 * Protocol 5 connects the machine rather than one checkout: it takes work in any repository its
 * owner can push to. An older connector still connects, for its one checkout's repository.
 * Protocol 6 keeps the claimed document ID on build renewals and reports after assignment cleanup.
 */
export const CONNECTOR_PROTOCOLS: { min: number; max: number } = { min: 2, max: 6 };

/** A document's people read why a Planner backend keeps failing from this launch in a row on. */
export const PLANNER_FAILURE_SHOWN_AT = 2;
/** The longest reason shown, in characters. */
const START_REASON_CHARS = 300;

/** What a machine's connector last said about its Planner backend failing to start. */
type StartFailure = { attempts: number; reason: string; at: number };

/** Text from a connector, safe to show: no control characters, one line, short. */
function plainText(text: string): string {
	let line = text
		// oxlint-disable-next-line no-control-regex
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		// oxlint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return line.length > START_REASON_CHARS ? `${line.slice(0, START_REASON_CHARS - 1)}…` : line;
}

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
		sandbox: about.sandbox ?? null,
	};
}

export function registerExperimentRoutes(router: Router, auth: HostedAuth, options: Options) {
	let connections = new Connections(undefined, auth.config.encryptionKey);
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
	/**
	 * Changes to a machine's favorites run one at a time per machine: setting or clearing one,
	 * stopping sharing the machine and revoking it. Each is stored and then published to
	 * `connections` without another in between, so the favorite a request stored cannot be
	 * published after the unshare or revoke that cleared it, and memory never outlives storage.
	 */
	let favoriteChanges = new Map<string, Promise<void>>();
	function changingFavorites<T>(machineId: string, change: () => Promise<T>): Promise<T> {
		let result = (favoriteChanges.get(machineId) ?? Promise.resolve()).then(change);
		let settled = result.then(() => {}, () => {});
		favoriteChanges.set(machineId, settled);
		void settled.then(() => {
			if (favoriteChanges.get(machineId) === settled) favoriteChanges.delete(machineId);
		});
		return result;
	}
	/** Revoke a machine, and forget everyone's favorite of it with the revocation. */
	function revokeMachine(machineId: string, userId: string) {
		return changingFavorites(machineId, async () => {
			let revoked = await auth.machines.revoke(machineId, userId);
			if (revoked) connections.unfavor(machineId);
			return revoked;
		});
	}
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
	/**
	 * Whether a machine its owner shares may take a document's work: its owner can push to the
	 * repository, as Default machine requires.
	 */
	async function sharedReaches(machineId: string, documentId: string) {
		let channel = await auth.storage.channels.get(documentId);
		return !!channel && await ownerReaches(machineId, {
			id: channel.repositoryId,
			owner: channel.repositoryOwner,
			name: channel.repositoryName,
		});
	}
	/**
	 * Whether a connection may take `person`'s work on a document now: one of their own machines,
	 * or the teammate's shared machine they chose, or made their favorite where they chose none,
	 * while its owner still shares it and can push.
	 */
	async function mayTake(connection: Connection, person: string, documentId: string) {
		if (connection.owner === person) return true;
		return !!connection.shared
			&& (connections.chosen(documentId, person) ?? connections.favorite(person))
				=== connection.machineId
			&& await sharedReaches(connection.machineId, documentId);
	}
	/**
	 * The live connections that may take the work `owner` asks for on a document: their own, and the
	 * teammate's shared machine they chose or favor. Work Chopin starts by itself never reaches a
	 * teammate's machine.
	 */
	async function takers(owner: string, repositoryId: string, documentId: string) {
		let found: Connection[] = [];
		for (let connection of connections.requested(repositoryId, owner, documentId)) {
			if (await mayTake(connection, owner, documentId)) found.push(connection);
		}
		return found;
	}
	/** Work only ever runs on a live connection of the machine the clicker chose, or their own. */
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
		let live = await takers(owner, repositoryId, documentId);
		if (!live.length) await refuseOffline(owner, documentId);
		for (let connection of live) if (!await busy(connection)) return connection;
		return live[0];
	}
	/**
	 * Nothing can take the work: `machine-offline`, naming the machine, when the person chose one,
	 * `machine-unavailable` when it is a teammate's that is online but no longer takes their work,
	 * else `no-workspace`; `machine-choice-unavailable` while their choice cannot be read. A chosen
	 * machine is never silently replaced by another.
	 */
	async function refuseOffline(owner: string, documentId: string): Promise<never> {
		await readChoices();
		let chosen = connections.chosen(documentId, owner);
		if (!chosen) fail("no-workspace");
		let machine = await auth.storage.machines.get(chosen);
		if (machine && machine.userId !== owner && connections.machine(machine.id).length) {
			fail("machine-unavailable", unavailableMessage(machine.label));
		}
		fail("machine-offline", offlineMessage(machine?.label));
	}
	/**
	 * The documents whose Planner each paired machine was told to run, by machine id, each with its
	 * repository. A document leaves only once the machine's credentials for it are withdrawn, so a
	 * backend it was told to stop cannot attach later. Forgotten with a restart, which also forgets
	 * every credential and releases every Planner.
	 */
	let dispatched = new Map<string, Map<string, string>>();
	/** Why each machine stopped running a document's Planner, told to its connector once. */
	let stopReasons = new Map<string, Map<string, string>>();
	/**
	 * The address each connection was last told for each document whose Planner it runs, by
	 * connection id, so a rename reaches the connector: its Planner poll names documents by id.
	 */
	let toldUrls = new Map<string, Map<string, string>>();
	/**
	 * The documents whose Planner a person asked a machine to start again now, by machine id, with
	 * when. The next answer to that machine's Planner poll lists them, once, and one nobody polled
	 * for within `RETRY_FRESH_MS` is forgotten: it was asked for then, not now. Forgotten with a
	 * restart.
	 */
	let retryAsked = new Map<string, Map<string, number>>();
	const RETRY_FRESH_MS = 60_000;
	function takeRetries(machineId: string, listed: Set<string>) {
		let asked = retryAsked.get(machineId);
		if (!asked) return [];
		let now = auth.clock().getTime();
		let ids: string[] = [];
		for (let [id, at] of asked) {
			if (now - at > RETRY_FRESH_MS) asked.delete(id);
			else if (listed.has(id)) {
				ids.push(id);
				asked.delete(id);
			}
		}
		if (!asked.size) retryAsked.delete(machineId);
		return ids;
	}
	/**
	 * Whether a connection can run its owner's Planners on request: it has a Planner command, speaks
	 * protocol 4, and this server runs the remote Planner with machines' own GitHub authorization.
	 */
	function runsPlanners(connection: Connection) {
		return !!options.planners && auth.machines.durable && !!connection.about?.plannerCommand
			&& (connection.protocol ?? 1) >= 4;
	}
	/**
	 * Documents someone uses, by id, with when they last were seen in use: open in Chopin, their
	 * Planner asked for, or their Planner waiting on a question or workflow run. On Default machine
	 * their creator's machine runs their Planner until one goes PLANNER_IDLE_MS unused. Forgotten
	 * with a restart.
	 */
	let inUse = new Map<string, number>();
	/**
	 * The machine Default machine gave each document's Planner to, kept while that machine can run
	 * it, so a working Planner never moves just because another machine came online.
	 */
	let defaults = new Map<string, string>();
	/**
	 * Why each machine's Planner backend keeps failing to start, as its connector last said, by
	 * document id and then machine id. A document's people read it from the second launch in a
	 * row, while the connector is still trying; the backend attaching, the connector saying it
	 * stays up, or the machine no longer being asked for the document forgets it. Forgotten with a
	 * restart.
	 */
	let startFailures = new Map<string, Map<string, StartFailure>>();
	function forgetStartFailure(documentId: string, machineId?: string) {
		let failures = startFailures.get(documentId);
		if (!failures) return;
		if (machineId === undefined) failures.clear();
		else failures.delete(machineId);
		if (!failures.size) startFailures.delete(documentId);
	}
	/**
	 * Whether someone can push to a repository, by who was asked and the repository id, as GitHub
	 * last said: each shared machine's owner, with the machine's own token (a machine shared with
	 * teammates runs only the Planners of documents its owner could work on themselves), and a
	 * person the Machines page asks about with their own login, with the repository's name.
	 */
	let reach = new Map<string, { ok: boolean; until: number; repository?: ReachRepository }>();
	let reaching = new Map<string, Promise<ReachRepository | undefined>>();
	/**
	 * Machines whose owner stopped sharing them while teammates' Planners on them were mid-work, by
	 * machine id: who stopped, and those documents. Each keeps its Planner there until its work
	 * finishes (a reply, an open question, a live run), then stops; no new teammate document
	 * comes to the machine meanwhile. Forgotten with a restart, which ends every Planner anyway.
	 */
	let finishing = new Map<string, { login: string; documents: Set<string> }>();
	/** The creator's own machine that can run the document's Planner now: the one builds would use. */
	function ownPlannerMachine(channel: ChannelRecord) {
		return connections.candidates(channel.repositoryId, channel.createdBy, channel.id, null)
			.find(runsPlanners)?.machineId;
	}
	/** A teammate's shared machine that can run the document's Planner now, and whose owner can push. */
	function sharedPlannerMachine(channel: ChannelRecord) {
		return connections.shared(channel.repositoryId, channel.createdBy).find(value =>
			runsPlanners(value) && reach.get(reachKey(value.machineId, channel.repositoryId))?.ok
		)?.machineId;
	}
	/** The teammate's shared machine the creator favors, when it can run the document's Planner now and its owner can push. */
	function favoritePlannerMachine(channel: ChannelRecord) {
		let favorite = connections.favorite(channel.createdBy);
		return connections.shared(channel.repositoryId, channel.createdBy).find(value =>
			value.machineId === favorite && runsPlanners(value)
			&& reach.get(reachKey(value.machineId, channel.repositoryId))?.ok
		)?.machineId;
	}
	/**
	 * Whether a machine can run a document's Planner for `user` (its creator unless said): their
	 * own, one shared with them, or one that stopped being shared while finishing this document's
	 * work.
	 */
	function readyFor(machineId: string, channel: ChannelRecord, user = channel.createdBy) {
		let finishes = !!finishing.get(machineId)?.documents.has(channel.id);
		return connections.machine(machineId).some(value =>
			serves(value, channel.repositoryId) && runsPlanners(value)
			&& (value.owner === user || finishes
				|| !!value.shared && !!reach.get(reachKey(machineId, channel.repositoryId))?.ok)
		);
	}
	/**
	 * Stop the teammates' Planners a machine that is no longer shared kept while they were mid-work,
	 * once each has finished or no longer runs there.
	 */
	async function finishShared() {
		for (let [machineId, { login, documents }] of finishing) {
			for (let documentId of documents) {
				let runsThere = defaults.get(documentId) === machineId;
				if (runsThere && options.attachments?.()?.busy(documentId)) continue;
				documents.delete(documentId);
				let channel = runsThere ? await auth.storage.channels.get(documentId) : undefined;
				if (channel) await redefault(channel, stoppedSharing(login));
			}
			if (!documents.size) finishing.delete(machineId);
		}
	}
	/**
	 * The machine Default machine runs a document's Planner on, while someone uses it and its
	 * creator chose no machine for it: the machine it already runs on while that one can, else the
	 * machine the creator's builds would go to (their favorite, then the one last used for the
	 * document, then any of theirs), counting only machines that can run Planners; a teammate's
	 * shared machine the creator favors comes before all of them while it can run it. A creator
	 * with none gets a teammate's machine shared with teammates, its owner's favorite first. Once
	 * the creator has a machine of their own, a Planner on a teammate's machine other than their
	 * favorite moves to it unless it is attached there. None while a member's stored choice places
	 * it on a machine that can run it now (see placesElsewhere()).
	 */
	function defaultMachine(channel: ChannelRecord): string | undefined {
		if (
			!inUse.has(channel.id) || channel.archivedAt || channel.parentChannelId
			|| !connections.choicesRead || connections.chosen(channel.id, channel.createdBy)
			|| placesElsewhere(channel)
		) {
			defaults.delete(channel.id);
			return undefined;
		}
		// A Planner whose connection dropped with its work kept stays on its machine, however long
		// that machine is away: another machine taking the document over would end that work.
		let disconnected = options.attachments?.()?.holding(channel.id);
		if (disconnected?.disconnected && disconnected.machineId) {
			defaults.set(channel.id, disconnected.machineId);
			return disconnected.machineId;
		}
		let own = ownPlannerMachine(channel);
		let kept = defaults.get(channel.id);
		if (kept && readyFor(kept, channel)) {
			let teammates = connections.machine(kept)[0]?.owner !== channel.createdBy;
			if (!teammates || !own || options.attachments?.()?.holding(channel.id)) return kept;
		}
		let next = favoritePlannerMachine(channel) ?? own ?? sharedPlannerMachine(channel);
		if (next) defaults.set(channel.id, next);
		else defaults.delete(channel.id);
		return next;
	}
	/**
	 * What GitHub last said of `key`'s push check (the repository as it names it, when they can),
	 * asked again once SHARED_REACH_MS (a pass) or a minute (a refusal, a failed check included) is
	 * up; however many ask at once, it is asked once.
	 */
	async function reached(
		key: string,
		ask: () => Promise<ReachRepository | undefined>,
	): Promise<ReachRepository | undefined> {
		let known = reach.get(key);
		let now = auth.clock().getTime();
		if (known && known.until > now) return known.repository;
		let pending = reaching.get(key);
		if (pending) return pending;
		let asked = ask().then(repository => {
			reach.set(key, {
				ok: !!repository,
				until: now + (repository ? SHARED_REACH_MS : SHARED_RETRY_MS),
				...repository ? { repository } : {},
			});
			return repository;
		}).finally(() => reaching.delete(key));
		reaching.set(key, asked);
		return asked;
	}
	/**
	 * Whether a shared machine's owner can push to a repository, as GitHub last said with the
	 * machine's own token.
	 */
	async function ownerReaches(
		machineId: string,
		repository: ReachRepository,
	): Promise<boolean> {
		return !!await reached(reachKey(machineId, repository.id), async () => {
			try {
				let machine = await auth.machines.current(machineId);
				return pushing(
					await (await machineCaller(machine)).use(token =>
						auth.github.repositoryAccess(token, repository.owner, repository.name)
					),
					repository,
				);
			} catch (error) {
				if (!(error instanceof ExperimentError || error instanceof MachineError)) {
					console.error("chopin: could not check a shared machine's repository access -", error);
				}
				return undefined;
			}
		});
	}
	/**
	 * Ask GitHub, with each shared machine's own token, whether its owner can push to a document's
	 * repository, for a document whose creator has no machine of their own that can run its
	 * Planner, and for a machine someone chose for it or its creator favors. Whether any answer
	 * changed.
	 */
	async function reachShared(channel: ChannelRecord): Promise<boolean> {
		if (!options.planners || !auth.machines.durable || channel.parentChannelId) return false;
		let chosen = new Set(connections.chosenFor(channel.id));
		let favorite = connections.favorite(channel.createdBy);
		let own = !!ownPlannerMachine(channel);
		let changed = false;
		let asked = new Set<string>();
		for (let connection of connections.shared(channel.repositoryId, channel.createdBy)) {
			if (!runsPlanners(connection) || asked.has(connection.machineId)) continue;
			if (own && !chosen.has(connection.machineId) && connection.machineId !== favorite) continue;
			asked.add(connection.machineId);
			let known = reach.get(reachKey(connection.machineId, channel.repositoryId));
			let ok = await ownerReaches(connection.machineId, {
				id: channel.repositoryId,
				owner: channel.repositoryOwner,
				name: channel.repositoryName,
			});
			if (ok !== known?.ok) changed = true;
		}
		return changed;
	}
	/**
	 * The machines their owners share with teammates that are not `viewer`'s: those a person may
	 * see and choose, for their builds and runs wherever Chopin has machines, and for their Planner
	 * where it runs Planners on them. Checking a repository takes the machine's own token, which a
	 * machine borrows from its owner's live login under AUTH_MODE=local, so one that needs its
	 * GitHub authorization renewed is none of them.
	 */
	async function sharedByOthers(viewer: string) {
		return (await auth.machines.shared()).filter(machine =>
			machine.userId !== viewer && !machine.reauthorizeAt
		);
	}
	/**
	 * Which of `machines` serve work, and where: one that is connected serves the repositories its
	 * connections say (every repository, from connector protocol 5 on, whatever checkouts it has or
	 * none), one that is not may serve any, and its owner must be able to push to the repository,
	 * as Default machine requires. A repository `candidates` names for a machine is checked with
	 * GitHub, SHARED_CHECKED_AT_ONCE at a time: `viewer`, when given, must be able to push there
	 * too and gives the repository's name. A machine that serves every repository also serves those
	 * `together` names, which both can push to already.
	 */
	async function sharedServing(
		machines: StoredMachine[],
		candidates: (machine: StoredMachine) => Promise<ReachRepository[]>,
		viewer?: (repository: ReachRepository) => Promise<ReachRepository | undefined>,
		together?: (machine: StoredMachine) => Promise<ReachRepository[]>,
	) {
		let found: Array<{ machine: StoredMachine; repositories: string[] }> = [];
		for (let machine of machines) {
			let live = connections.machine(machine.id);
			let names: string[] = [];
			let looked = await candidates(machine);
			for (let first = 0; first < looked.length; first += SHARED_CHECKED_AT_ONCE) {
				let checked = await Promise.all(
					looked.slice(first, first + SHARED_CHECKED_AT_ONCE).map(async candidate => {
						let repository = viewer ? await viewer(candidate) : candidate;
						if (!repository || live.length && !live.some(value => serves(value, repository.id))) {
							return undefined;
						}
						return await ownerReaches(machine.id, repository)
							? `${repository.owner}/${repository.name}`
							: undefined;
					}),
				);
				names.push(...checked.filter(name => name !== undefined));
			}
			if (together && (!live.length || live.some(value => value.anyRepository))) {
				names = [
					...new Set([
						...names,
						...(await together(machine)).map(value => `${value.owner}/${value.name}`),
					]),
				];
			}
			if (names.length) found.push({ machine, repositories: names });
		}
		return found;
	}
	/**
	 * What a teammate may know of a machine shared with them: its name, its owner, when it was
	 * paired (the order machines are listed in), its release and whether it is a server. Not its
	 * host, system or agent, nor anything its owner alone sets.
	 */
	async function teammateFacts(machine: StoredMachine) {
		let live = connections.machine(machine.id);
		let owner = await auth.storage.users.get(machine.userId);
		return {
			id: machine.id,
			label: machine.label,
			teammate: true as const,
			owner: { login: owner?.login ?? machine.userId, avatarUrl: owner?.avatarUrl ?? "" },
			createdAt: machine.createdAt.getTime(),
			lastSeenAt: machine.lastSeenAt.getTime(),
			version: live.find(value => value.version)?.version ?? null,
			// An offline machine keeps its server or computer icon.
			service: live.length
				? live.some(value => value.about?.service)
				: !!connections.about(machine.id)?.service,
		};
	}
	/**
	 * Whether a member's own choice places a document's Planner. A document has one Planner, so its
	 * creator's choice decides where it runs: another member's choice counts only while the creator
	 * chose no machine, and never keeps the Planner from a machine its creator chose.
	 */
	function placesPlanner(channel: ChannelRecord, userId: string) {
		return userId === channel.createdBy || !connections.chosen(channel.id, channel.createdBy);
	}
	/** The machines some member chose for a document that may run its Planner for them now. */
	function ableChoices(channel: ChannelRecord) {
		return [...new Set(connections.chosenFor(channel.id))].filter(machineId =>
			connections.choosing(machineId).some(value =>
				value.documentId === channel.id && readyFor(machineId, channel, value.owner)
			)
		);
	}
	/** Those of them that place a document's Planner: the creator's choice, else any member's. */
	function placedChoices(channel: ChannelRecord) {
		let creators = connections.chosen(channel.id, channel.createdBy);
		return ableChoices(channel).filter(machineId => !creators || machineId === creators);
	}
	/**
	 * Whether a member's stored choice places a document's Planner, while its creator chose no
	 * machine, on a machine that can run it now: Default machine is then asked for none, so the
	 * choice, which survives a restart, decides it however the machines connect afterwards. The
	 * exception is a Planner already attached (or kept with its work) on another machine: it
	 * stays there and is never interrupted by a machine that merely became able; the chosen one is
	 * asked once it ends.
	 */
	function placesElsewhere(channel: ChannelRecord) {
		let placed = placedChoices(channel);
		if (!placed.length) return false;
		let holder = options.attachments?.()?.holding(channel.id);
		return !(holder?.machineId && !placed.includes(holder.machineId));
	}
	/** The machine that runs a document's Planner for `userId`: the one they chose, else Default's. */
	function plannerMachine(channel: ChannelRecord, userId: string) {
		if (!placesPlanner(channel, userId)) return undefined;
		return connections.chosen(channel.id, userId)
			?? (userId === channel.createdBy ? defaultMachine(channel) : undefined);
	}
	/**
	 * The documents whose Planner a connection should run, in the repositories it serves: those its
	 * owner chose its machine for, and those Default machine gives it (its owner's, or a teammate's
	 * when its owner shares it), except one whose Planner another account holds, which is never
	 * taken over.
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
			let channel = await auth.storage.channels.get(documentId);
			if (!channel || channel.archivedAt || !serves(connection, channel.repositoryId)) continue;
			// A teammate's choice of this machine counts only while its owner shares it and can push.
			if (owner !== connection.owner && !readyFor(connection.machineId, channel, owner)) continue;
			// A member's choice yields to the creator's, which keeps its own machine asked instead.
			if (!placesPlanner(channel, owner)) continue;
			let holder = options.attachments?.()?.holding(documentId);
			if (holder && holder.userId !== connection.owner) continue;
			// Nor one whose Planner dropped with its work kept on another machine, until it is back.
			if (holder?.disconnected && holder.machineId !== connection.machineId) continue;
			await add(channel);
		}
		for (let documentId of inUse.keys()) {
			let channel = await auth.storage.channels.get(documentId);
			if (
				!channel || !serves(connection, channel.repositoryId)
				|| defaultMachine(channel) !== connection.machineId
			) continue;
			// Nor one its owner's Planner is attached to elsewhere, until that one lets go.
			let holder = options.attachments?.()?.holding(documentId);
			if (
				holder
				&& (holder.userId !== connection.owner
					|| (holder.attached || holder.disconnected)
						&& holder.machineId !== connection.machineId)
			) continue;
			await add(channel);
		}
		let told = new Map(dispatched.get(connection.machineId));
		let wanted = new Set(documents.map(document => document.id));
		for (let [documentId, repositoryId] of told) {
			if (!serves(connection, repositoryId) || wanted.has(documentId)) continue;
			// No longer asked, as another account now holds it: a credential it got stops working.
			await options.planners?.withdraw(connection.machineId, documentId);
			forgetStartFailure(documentId, connection.machineId);
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
	 * is its root's. `ask` asks the machines again even if this document is already in use, which
	 * is what a person pressing for a Planner that is not there is owed.
	 */
	async function plannerUsed(documentId: string, ask = false) {
		if (!options.planners || !auth.machines.durable) return;
		let channel = await auth.storage.channels.get(documentId);
		if (channel?.parentChannelId) {
			channel = await auth.storage.channels.get(channel.parentChannelId);
		}
		if (!channel || channel.archivedAt) return;
		let fresh = !inUse.has(channel.id);
		inUse.set(channel.id, auth.clock().getTime());
		await readChoices().catch(() => {});
		// A creator with no machine of their own may get a teammate's shared one, checked anew here.
		let reached = await reachShared(channel);
		if (!fresh && !reached && !ask) return;
		if (ask) {
			// Whoever asked is owed an attempt now: the machine that will start it hears so, and its
			// connector cuts the wait of a backend that exited. Nothing is said for a Planner that is
			// attached or held, which `plannerStarting` leaves out.
			let starting = await plannerStarting(channel.id);
			if (starting) {
				let asked = retryAsked.get(starting.machineId) ?? new Map<string, number>();
				asked.set(channel.id, auth.clock().getTime());
				retryAsked.set(starting.machineId, asked);
			}
		}
		connections.wake(channel.repositoryId);
		options.plannerStatus?.(channel.id);
	}
	/**
	 * Whose machine is about to run a document's Planner, when nothing holds it yet: one chosen for
	 * it, or Default machine's, that can run Planners now, which launch it waits on once one has
	 * exited before attaching (`attempt`, one more than the launches in a row that did), and why its
	 * backend keeps failing to start once it has more than once in a row. Undefined when no machine
	 * will.
	 */
	async function plannerStarting(
		documentId: string,
	): Promise<
		{
			login: string;
			machineId: string;
			attempt?: number;
			failure?: Session.PlannerStartFailure;
		} | undefined
	> {
		if (!options.planners || !auth.machines.durable) return undefined;
		if (options.attachments?.()?.holding(documentId)) return undefined;
		let channel = await auth.storage.channels.get(documentId);
		if (!channel || channel.archivedAt) return undefined;
		await readChoices().catch(() => {});
		let fallback = defaultMachine(channel);
		// A machine chosen for it starts it for whoever chose it, if that machine may run it for them.
		for (let machineId of [...placedChoices(channel), ...fallback ? [fallback] : []]) {
			let live = connections.machine(machineId).find(value =>
				serves(value, channel.repositoryId) && runsPlanners(value)
			);
			if (!live) continue;
			let failure = startFailures.get(documentId)?.get(machineId);
			return {
				login: live.login,
				machineId,
				...(failure ? { attempt: failure.attempts + 1 } : {}),
				...(failure && failure.attempts >= PLANNER_FAILURE_SHOWN_AT
					? {
						failure: {
							attempts: failure.attempts,
							reason: failure.reason,
							at: new Date(failure.at).toISOString(),
						},
					}
					: {}),
			};
		}
		return undefined;
	}
	/**
	 * A document stops being used once nobody has had it open, and its Planner has been replying
	 * to nobody and waiting on no question or workflow run, for PLANNER_IDLE_MS: the machine
	 * Default machine gave its Planner stops running it. Work under way and a question never
	 * time out by this route, however long they take.
	 */
	async function plannersIdle() {
		let now = auth.clock().getTime();
		for (let [documentId, seen] of inUse) {
			let attached = options.attachments?.();
			if (
				options.documentOpen?.(documentId) || attached?.waiting(documentId)
				|| attached?.busy(documentId)
			) {
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
	 * The machines, other than `keep`, that run a document's Planner, were asked to, or were
	 * `placing` it by a member's choice before `by` chose where it runs: the choices other members
	 * made of them go, so none takes it back, even one whose connector had not been asked yet.
	 * Those machines, to be stopped.
	 */
	async function displaced(
		channel: ChannelRecord,
		by: string,
		keep: Array<string | undefined>,
		placing: string[],
	) {
		let holder = options.attachments?.()?.holding(channel.id);
		let found = new Set([
			...dispatched.entries().filter(([, told]) => told.has(channel.id)).map(([id]) => id),
			...holder?.machineId ? [holder.machineId] : [],
			...placing,
		]);
		for (let machineId of keep) if (machineId) found.delete(machineId);
		for (let machineId of found) {
			for (let chooser of connections.choosing(machineId)) {
				if (chooser.documentId !== channel.id || chooser.owner === by) continue;
				await auth.storage.machines.choose(
					{ channelId: channel.id, userId: chooser.owner },
					auth.clock(),
				);
				connections.choose(channel.id, chooser.owner, undefined);
				options.chosen?.(channel.id, chooser.owner);
			}
		}
		return found;
	}
	/** Stop a document's Planner on `machines`, saying who chose otherwise: `chose` names them. */
	async function stopDisplaced(channel: ChannelRecord, machines: Iterable<string>, chose: string) {
		for (let machineId of machines) {
			await stopPlanners(
				machineId,
				label => `${chose} for this document, so ${label} stopped running its Planner.`,
				documentId => documentId !== channel.id,
				channel.id,
			);
		}
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
		let told = dispatched.get(machineId);
		// Why each stopped is recorded before storage is waited on: a connector that asks while its
		// credentials are being forgotten must already be told.
		let stopping: Array<[string, string]> = [];
		if (told) {
			let label = (await auth.storage.machines.get(machineId))?.label ?? "The machine";
			for (let [id, repositoryId] of told) {
				if (keep(id, repositoryId)) continue;
				told.delete(id);
				let reason = message(label);
				let reasons = stopReasons.get(machineId) ?? new Map<string, string>();
				reasons.set(id, reason);
				stopReasons.set(machineId, reasons);
				stopping.push([id, reason]);
			}
		}
		if (documentId) {
			await options.planners?.withdraw(machineId, documentId);
			forgetStartFailure(documentId, machineId);
		}
		for (let [id, reason] of stopping) {
			await options.planners?.withdraw(machineId, id);
			forgetStartFailure(id, machineId);
			await options.attachments?.()?.stopMachine(id, machineId, reason);
		}
		if (told && !told.size) dispatched.delete(machineId);
	}
	/**
	 * One of `owner`'s machines connected, disconnected, or was shared or no longer: the documents
	 * it may run the Planner of, chosen for it or on Default machine (any in use when it is
	 * `shared`), are asked again and say who starts their Planner now.
	 */
	async function plannersMoved(machineId: string, owner: string, shared = false) {
		let documents = new Set(
			connections.choosing(machineId).map(value => value.documentId),
		);
		for (let channel of await created(owner)) documents.add(channel.id);
		if (shared) {
			for (let documentId of inUse.keys()) {
				let channel = await auth.storage.channels.get(documentId);
				if (!channel || channel.createdBy === owner) continue;
				await reachShared(channel);
				documents.add(channel.id);
			}
		}
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
		toldUrls.delete(connection.id);
		let others = connections.machine(connection.machineId).filter(runsPlanners);
		void stopPlanners(
			connection.machineId,
			label => `${label} disconnected from Chopin, so it stopped running this document's Planner.`,
			// A machine that went quiet may only be asleep: a Planner with work kept for it stays.
			(documentId, repositoryId) =>
				!serves(connection, repositoryId) || others.some(value => serves(value, repositoryId))
				|| !!options.attachments?.()?.keeping(documentId),
		).then(() => plannersMoved(connection.machineId, connection.owner, !!connection.shared)).catch(
			error => console.error("chopin: could not stop a disconnected machine's Planner -", error),
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
				if (
					request.headers.has("origin") && !ownOrigin(auth.config, request.headers.get("origin"))
				) {
					fail("origin-forbidden");
				}
				if (
					method !== "GET" && request.headers.has("cookie")
					&& !ownOrigin(auth.config, request.headers.get("origin"))
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
							&& code !== "machine-unavailable" && code !== "machine-choice-unavailable"
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
		let { autoRun, shared } = z.object({
			autoRun: z.boolean().optional(),
			shared: z.boolean().optional(),
		}).strict().parse(await body(request));
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		if (auth.machines.durable && !keys.authorized(session.user.id, session.session.id)) {
			return json({ authorize: "/auth/github/connector?key" });
		}
		return json(keys.mint(session.user.id, session.session.id, autoRun, shared));
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
			...(spent.shared ? { shared: true } : {}),
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
				...(approval.shared ? { shared: true } : {}),
				...(grant ? { grant } : {}),
			});
			connections.paired(id, machine.id, token);
		}
		return `${MACHINES_PATH}?pairing=${id}`;
	}
	auth.pairings.complete = complete;
	route("POST", "/api/connector/pairings/:id/approve", async (request, params) => {
		// Automatic work and sharing are opt-in, as the machine is paired; both off unless asked for.
		let { autoRun, shared } = z.object({
			autoRun: z.boolean().optional(),
			shared: z.boolean().optional(),
		}).strict().parse(await body(request));
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
			...(shared ? { shared: true } : {}),
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
				...(machine.shared ? { shared: true } : {}),
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
			void plannersMoved(machine.id, machine.userId, !!machine.shared).catch(error =>
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
			...await planners.issue(machine, channel.id),
			document: {
				id: channel.id,
				url,
				repository: `${channel.repositoryOwner}/${channel.repositoryName}`,
			},
		});
	});
	/**
	 * A machine's connector says why its Planner backend for a document keeps exiting before it
	 * attaches, or, without `failure`, that it no longer does. Only a Planner Chopin asked the
	 * machine to run counts, since what is said here is shown to the document's people.
	 */
	route("POST", "/api/connector/planner/failure", async request => {
		let planners = options.planners;
		if (!planners || !auth.machines.durable) fail("not-found");
		compatible(request, auth.config.origin, options.connectorVersion);
		let machine = await machineRefusal(() => auth.machines.authenticate(bearer(request)));
		let { document, failure } = z.object({
			document: z.string().min(1).max(2048),
			failure: z.object({
				attempts: z.number().int().min(1).max(1_000_000),
				how: z.string().max(2000),
				reason: z.string().max(2000).optional(),
				at: z.number().int().positive(),
			}).strict().optional(),
		}).strict().parse(await body(request));
		let told = dispatched.get(machine.id);
		// The connector names the document by id once Chopin issued it a credential; an address
		// is read with the machine's own token, as that credential is.
		let documentId: string | undefined;
		if (told?.has(document)) documentId = document;
		else if (told?.size) {
			let located = await machineRefusal(() => planners.locate(machine, document))
				.catch(() => undefined);
			if (located && located !== "forbidden") documentId = located.channel.id;
		}
		if (!documentId || !told?.has(documentId)) return json({ recorded: false });
		if (!failure) forgetStartFailure(documentId, machine.id);
		else {
			let now = auth.clock().getTime();
			let reason = plainText(failure.reason ?? "") || plainText(failure.how);
			let known = startFailures.get(documentId) ?? new Map<string, StartFailure>();
			// The time is the server's own: a connector's clock is its own.
			known.set(machine.id, { attempts: failure.attempts, reason, at: now });
			startFailures.set(documentId, known);
		}
		options.plannerStatus?.(documentId);
		return json({ recorded: true });
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
		await revokeMachine(machine.id, machine.userId);
		await disconnectMachine(machine.id);
		return json({ revoked: true });
	});
	/**
	 * Add the repositories a token can push to among its GitHub App installations to `into`, as
	 * the repository picker lists them, every one of them.
	 */
	async function listPushable(token: string, into: ReachRepository[]) {
		let installations: GitHubInstallation[] = [];
		for (let page: number | undefined = 1, pages = 0; page && pages < LISTED_PAGES; pages++) {
			let listing: InstallationPage = await auth.github.installations(token, page);
			installations.push(...listing.installations);
			page = listing.nextPage;
		}
		for (let installation of installations) {
			if (installation.suspended || !installation.permissions.contents) continue;
			for (let page: number | undefined = 1, pages = 0; page && pages < LISTED_PAGES; pages++) {
				let listing: RepositoryPage = await auth.github.installationRepositories(
					token,
					installation.id,
					page,
				);
				for (let value of listing.repositories) {
					if (value.permissions.pull && (value.permissions.push || value.permissions.admin)) {
						into.push({ id: value.id, owner: value.owner, name: value.name });
					}
				}
				page = listing.nextPage;
			}
		}
	}
	/**
	 * What someone can push to among their installations, whoever's list it is: a person's own held
	 * a minute, a machine owner's, listed with the token of the machine that asked first, as long
	 * as a pass of a check is, and either a minute after a failure; asked once however many ask at
	 * once. Evicted as it runs out, as a listing begins.
	 */
	let pushable = new Map<string, { until: number; found: Promise<ReachRepository[]> }>();
	function pushableRepositories(who: string, held: number, caller: () => Caller | Promise<Caller>) {
		let now = auth.clock().getTime();
		for (let [key, entry] of pushable) if (entry.until <= now) pushable.delete(key);
		let known = pushable.get(who);
		if (known) return known.found;
		let entry = { until: Infinity, found: Promise.resolve<ReachRepository[]>([]) };
		entry.found = (async () => {
			let repositories: ReachRepository[] = [];
			let listed = false;
			try {
				await (await caller()).use(token => listPushable(token, repositories));
				listed = true;
			} catch (error) {
				if (!(error instanceof ExperimentError || error instanceof MachineError)) {
					console.error("chopin: could not list the repositories someone can push to -", error);
				}
			}
			// What GitHub said of a list it could not finish stands, and it is asked again soon.
			entry.until = auth.clock().getTime() + (listed ? held : SHARED_RETRY_MS);
			return repositories;
		})();
		pushable.set(who, entry);
		return entry.found;
	}
	function viewerRepositories(session: AuthenticatedSession) {
		return pushableRepositories(
			`viewer:${session.user.id}`,
			SHARED_VIEWER_MS,
			() => browser(session),
		);
	}
	function ownerRepositories(machine: StoredMachine) {
		return pushableRepositories(
			`owner:${machine.userId}`,
			SHARED_REACH_MS,
			() => machineCaller(machine),
		);
	}
	/**
	 * Whether a person can push to a repository, by its id with GitHub's name for it: from those
	 * they can push to among their installations, else asked with their own login, which `reach`
	 * holds like a machine owner's answer, whichever listing asks. A repository GitHub can't vouch
	 * for is left out. Answers that have run out are forgotten as a person's check begins.
	 */
	function viewerPushes(session: AuthenticatedSession) {
		let who = `viewer:${session.user.id}`;
		let now = auth.clock().getTime();
		for (let [key, value] of reach) {
			if (key.startsWith("viewer:") && value.until <= now) reach.delete(key);
		}
		return async (repository: ReachRepository) => {
			let listed = (await viewerRepositories(session)).find(value => value.id === repository.id);
			return listed ?? await reached(reachKey(who, repository.id), async () => {
				try {
					return pushing(
						await browser(session).use(token =>
							auth.github.repositoryAccess(token, repository.owner, repository.name)
						),
						repository,
					);
				} catch {
					return undefined;
				}
			});
		};
	}
	/**
	 * The repositories a machine says it has checkouts of: those it was paired with and those it
	 * connected, which the Machines page asks about one at a time.
	 */
	async function checkedOutOf(machine: StoredMachine): Promise<ReachRepository[]> {
		let candidates = [
			...machine.repositories.flatMap(value => named(value.repository, value.repositoryId)),
			...connections.machine(machine.id).flatMap(value =>
				value.checkouts.flatMap(checkout => named(checkout.repository, checkout.repositoryId))
			),
		];
		return [...new Map(candidates.map(value => [value.id, value])).values()];
	}
	/**
	 * The repositories both a person and a machine's owner can push to, from the two lists of what
	 * each can push to: no check of a repository, however many either can push to. A person who
	 * can push to none leaves the owner's list unasked.
	 */
	async function pushableTogether(session: AuthenticatedSession, machine: StoredMachine) {
		let mine = await viewerRepositories(session);
		if (!mine.length) return [];
		let theirs = new Set((await ownerRepositories(machine)).map(value => value.id));
		return mine.filter(value => theirs.has(value.id));
	}
	/**
	 * Which of `machines`, teammates' shared ones, the Machines page lists to a person, with the
	 * repositories each serves them: those both they and its owner can push to.
	 */
	function listedTo(session: AuthenticatedSession, machines: StoredMachine[]) {
		return sharedServing(
			machines,
			checkedOutOf,
			viewerPushes(session),
			machine => pushableTogether(session, machine),
		);
	}
	route("GET", "/api/connector/machines", async request => {
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		let machines = await auth.machines.list(session.user.id);
		// Teammates' machines shared with them, in the repositories both can push to.
		let others = await sharedByOthers(session.user.id);
		let teammates = others.length ? await listedTo(session, others) : [];
		// The star shows only once the favorite is known; the list itself never waits on it.
		await readChoices().catch(() => {});
		let favorite = connections.choicesRead ? connections.favorite(session.user.id) : undefined;
		return json({
			machines: [
				...machines.map(machine => ({
					id: machine.id,
					label: machine.label,
					teammate: false,
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
					shared: !!machine.shared,
					// Teammates' documents it still runs the Planner of until their work finishes.
					finishing: finishing.get(machine.id)?.documents.size ?? 0,
					createdAt: machine.createdAt.getTime(),
					lastSeenAt: machine.lastSeenAt.getTime(),
					connected: connections.machine(machine.id).length > 0 || backed(machine.id),
					version: connections.machine(machine.id).find(value => value.version)?.version ?? null,
					...described(connections.machine(machine.id)),
					reauthorize: !!machine.reauthorizeAt,
				})),
				...await Promise.all(teammates.map(async ({ machine, repositories }) => ({
					...await teammateFacts(machine),
					repositories,
					// Only the viewer's own favorite, never its owner's.
					favorite: machine.id === favorite,
					connected: connections.machine(machine.id).length > 0 || backed(machine.id),
				}))),
			],
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
	 * A person sets one of their machines, or a teammate's machine listed to them (shared, its owner
	 * and they able to push to a repository), as their favorite, which Automatic prefers, or clears
	 * it. Only one machine is a person's favorite.
	 */
	route("POST", "/api/connector/machines/:id/favorite", async (request, params) => {
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		let { favorite } = z.object({ favorite: z.boolean() }).strict().parse(await body(request));
		let userId = session.user.id;
		// Replacing the favorite needs the stored one known first.
		await readChoices();
		let own = (await auth.machines.list(userId)).some(machine => machine.id === params.id);
		let listed = own || (favorite
			? (await listedTo(
				session,
				(await sharedByOthers(userId)).filter(machine => machine.id === params.id),
			)).length > 0
			: connections.favorite(userId) === params.id);
		if (!listed) fail("not-found");
		if (favorite || connections.favorite(userId) === params.id) {
			let machineId = favorite ? params.id : undefined;
			let changed = await changingFavorites(params.id, async () => {
				let changed = connections.favorite(userId) !== machineId;
				await auth.storage.machines.favor(
					{ userId, ...(machineId ? { machineId } : {}) },
					auth.clock(),
				);
				connections.favor(userId, machineId);
				return changed;
			});
			// Default machine's Planners of the person's documents follow the new favorite.
			for (let channel of changed ? await created(userId) : []) {
				await reachShared(channel);
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
	/**
	 * The owner shares a machine with teammates, or stops. Shared, teammates can see and choose it,
	 * and it may run the Planner of a document on Default machine whose creator has no machine of
	 * their own that can, in a repository its owner can push to. Stopping takes no new teammate
	 * documents, clears the teammates' choices of it, and ends the Planners it runs for them: at
	 * once where idle, else once their current work finishes.
	 */
	route("POST", "/api/connector/machines/:id/shared", async (request, params) => {
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		let { shared } = z.object({ shared: z.boolean() }).strict().parse(await body(request));
		let userId = session.user.id;
		await readChoices();
		let found = await changingFavorites(params.id, async () => {
			let found = await auth.machines.share(params.id, userId, shared);
			// Storage forgot teammates' favorites of it with the sharing.
			if (found && !shared) connections.unfavor(params.id, userId);
			return found;
		});
		if (!found) fail("not-found");
		finishing.delete(params.id);
		let teammates: ChannelRecord[] = [];
		if (!shared) {
			// A teammate's choice of the machine ends with the sharing, so it never holds back their
			// own work; the Planner it placed there finishes and stops as Default machine's does.
			// Only a document the machine ran, was asked to run or was placing the Planner of, or
			// that someone uses, is then given to Default machine; any other just loses the choice.
			for (let { documentId, owner } of connections.choosing(params.id)) {
				if (owner === userId) continue;
				let channel = await auth.storage.channels.get(documentId);
				let ran = !!channel && (
					options.attachments?.()?.holding(documentId)?.machineId === params.id
					|| !!dispatched.get(params.id)?.has(documentId)
					|| placedChoices(channel).includes(params.id)
				);
				await auth.storage.machines.choose({ channelId: documentId, userId: owner }, auth.clock());
				connections.choose(documentId, owner, undefined);
				options.chosen?.(documentId, owner);
				if (!ran && !inUse.has(documentId)) continue;
				defaults.set(documentId, params.id);
				inUse.set(documentId, auth.clock().getTime());
			}
			for (let [documentId, machineId] of defaults) {
				if (machineId !== params.id) continue;
				let channel = await auth.storage.channels.get(documentId);
				if (channel && channel.createdBy !== userId) teammates.push(channel);
			}
			// A teammate mid-reply, mid-question or mid-run keeps the Planner until it finishes;
			// recorded before sharing ends, so no poll in between moves it.
			let busy = new Set(
				teammates.filter(channel => options.attachments?.()?.busy(channel.id)).map(value =>
					value.id
				),
			);
			if (busy.size) finishing.set(params.id, { login: session.user.login, documents: busy });
			for (let key of reach.keys()) if (key.startsWith(`${params.id}\n`)) reach.delete(key);
		}
		connections.share(params.id, shared);
		for (let channel of teammates) {
			if (!finishing.get(params.id)?.documents.has(channel.id)) {
				await redefault(channel, stoppedSharing(session.user.login));
			}
		}
		await plannersMoved(params.id, userId, shared);
		return json({ shared });
	});
	route("POST", "/api/connector/machines/:id/revoke", async (request, params) => {
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		z.object({}).strict().parse(await body(request));
		if (!await revokeMachine(params.id, session.user.id)) fail("not-found");
		await disconnectMachine(params.id);
		return json({ revoked: true });
	});
	/** Whether a Planner backend of the machine is attached, or was cut by a deploy and is expected back. */
	function backed(machineId: string): boolean {
		return !!options.attachments?.()?.machineBacked(machineId);
	}
	/**
	 * The caller's own machines, whatever repositories they have checkouts of, and the machines
	 * teammates share that serve the document's repository while their owners can push to it (for
	 * a caller who can push to it too); the one they chose for a document (null for automatic), and
	 * the machine automatic would use now. A machine is connected for the document when one of its
	 * live connections serves its repository.
	 */
	async function machineChoice(userId: string, channel: ChannelRecord, canPush: boolean) {
		let { id: documentId, repositoryId } = channel;
		await readChoices();
		let serving = await auth.machines.list(userId);
		let chosen = connections.chosen(documentId, userId);
		let others = canPush ? await sharedByOthers(userId) : [];
		let teammates = others.length
			? await sharedServing(others, async () => [{
				id: repositoryId,
				owner: channel.repositoryOwner,
				name: channel.repositoryName,
			}])
			: [];
		let favorite = connections.favorite(userId);
		// What Automatic would use now, shown beside it even while a machine is chosen: the
		// favorite where it is a teammate's machine listed here, else the person's own.
		let automatic: Connection | undefined;
		let live = [
			...connections.shared(repositoryId, userId).filter(value =>
				value.machineId === favorite && teammates.some(({ machine }) => machine.id === favorite)
			),
			...connections.candidates(repositoryId, userId, documentId, null),
		];
		for (let connection of live) {
			if (!await busy(connection)) {
				automatic = connection;
				break;
			}
		}
		automatic ??= live[0];
		// With no connection of its own yet in this process (a deploy just replaced the last), a
		// machine whose backend holds the document's Planner is still the machine it runs on.
		let carried = options.attachments?.()?.holding(documentId);
		let automaticId = automatic?.machineId
			?? (carried?.attached && carried.userId === userId ? carried.machineId : undefined);
		let label = (id: string) =>
			serving.find(machine => machine.id === id)?.label
				?? teammates.find(({ machine }) => machine.id === id)?.machine.label ?? null;
		let capable = (machineId: string) => {
			let live = connections.machine(machineId);
			return live.length
				? live.some(value => serves(value, repositoryId) && runsPlanners(value))
				: !!options.planners && auth.machines.durable
					&& !!connections.about(machineId)?.plannerCommand;
		};
		return {
			choice: chosen ?? null,
			/** The caller's favorite machine, theirs or a teammate's, which Automatic prefers where it serves the repository. */
			favorite: favorite ?? null,
			planner: plannerState(userId, channel, serving),
			automatic: automaticId
				? { id: automaticId, label: label(automaticId), favorite: automaticId === favorite }
				: null,
			machines: [
				...serving.map(machine => {
					let live = connections.machine(machine.id);
					return {
						id: machine.id,
						label: machine.label,
						teammate: false,
						connected: live.some(value => serves(value, repositoryId)) || backed(machine.id),
						reauthorize: !!machine.reauthorizeAt,
						createdAt: machine.createdAt.getTime(),
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
				...await Promise.all(teammates.map(async ({ machine }) => ({
					...await teammateFacts(machine),
					connected: connections.machine(machine.id).some(value => serves(value, repositoryId))
						|| backed(machine.id),
					runsPlanners: capable(machine.id),
				}))),
			],
		};
	}
	/**
	 * Who runs the document's Planner, as its chooser sees it, or null when Chopin does not run
	 * Planners on machines: `held` by another account (named), `attached` through the caller's own
	 * account (with which of their machines, if one), `disconnected` when that account's Planner
	 * dropped with its work kept for it, `starting` while the machine chosen for it, or Default
	 * machine's for its creator, has yet to attach, else `none`.
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
		if (holder?.disconnected) {
			let machine = serving.some(value => value.id === holder.machineId) ? holder.machineId! : null;
			return { state: "disconnected" as const, login: holder.login, machine };
		}
		// Its creator is told where a member's choice that can run it places it, as Default would.
		let machine = plannerMachine(channel, userId)
			?? (userId === channel.createdBy ? placedChoices(channel)[0] : undefined);
		if (machine && readyFor(machine, channel, userId)) {
			// A teammate's shared machine says whose it is; the caller's own is named by its id.
			let teammate = connections.machine(machine).find(value => value.owner !== userId);
			return { state: "starting" as const, login: teammate?.login ?? null, machine };
		}
		return { state: "none" as const, login: null, machine: null };
	}
	route("GET", "/api/documents/:id/machine", async (request, params) => {
		let { session, channel, repository } = await access(
			await auth.sessions.authenticate(request),
			params.id,
			false,
		);
		return json(
			await machineChoice(
				session.user.id,
				channel,
				repository.permissions.push || repository.permissions.admin,
			),
		);
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
			let current = await machineChoice(userId, channel, true);
			if (!current.machines.some(value => value.id === machine)) {
				let owned = (await auth.machines.list(userId)).some(value => value.id === machine);
				fail(owned ? "repository-unserved" : "not-found");
			}
		}
		await auth.storage.machines.choose(
			{ channelId: channel.id, userId, ...(machine ? { machineId: machine } : {}) },
			auth.clock(),
		);
		// Where the person's Planner of the document runs now, chosen or Default machine's; and the
		// machines members' choices place it on, while its creator chose none.
		let previous = plannerMachine(channel, userId);
		let placing = connections.chosen(channel.id, channel.createdBy) ? [] : ableChoices(channel);
		connections.choose(channel.id, userId, machine ?? undefined);
		// Default machine picks again for its creator, as for any change of choice.
		if (userId === channel.createdBy) defaults.delete(channel.id);
		let next = plannerMachine(channel, userId);
		// The machines that stop: the one that ran it, unless it is the one that runs it now.
		let stops = new Set(previous && previous !== next ? [previous] : []);
		// A choice that places the Planner also ends it on every other machine that runs it, was
		// asked to, or was placing it, and the other members' choices of those machines with it, so
		// none takes it back. The creator's always places it. A member's does only where its machine
		// can run it for them now; one that cannot (a machine without a Planner command, an offline
		// one, one whose owner can't push) is stored and stops nothing else: the Planner keeps
		// running where it is, a reply under way included, and the machine takes it once it can and
		// the Planner there has ended.
		let places = userId === channel.createdBy
			|| machine !== null && placesPlanner(channel, userId)
				&& placedChoices(channel).includes(machine);
		if (places) {
			for (let machineId of await displaced(channel, userId, [next, previous], placing)) {
				stops.add(machineId);
			}
		}
		// The new machine starts.
		await stopDisplaced(
			channel,
			stops,
			`${session.user.login} chose ${machine ? "another machine" : "Default machine"}`,
		);
		connections.wake(channel.repositoryId);
		options.chosen?.(channel.id, userId);
		options.plannerStatus?.(channel.id);
		return json(await machineChoice(userId, channel, true));
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
		// A build's run credential from before a restart is accepted again for the connection that
		// now holds its build, once its machine has come back.
		let durable = !connections.holds(token) ? connections.durableRun(token) : undefined;
		if (durable) await options.implementations?.()?.adopt(token, durable);
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
					let told = toldUrls.get(connection.id) ?? new Map<string, string>();
					toldUrls.set(connection.id, told);
					// A document renamed since this connection was told about it is a change too.
					let moved = planners.some(value =>
						told.has(value.id) && told.get(value.id) !== value.url
					);
					for (let value of planners) if (!told.has(value.id)) told.set(value.id, value.url);
					let asked = takeRetries(connection.machineId, new Set(planners.map(value => value.id)));
					let retry = asked.length ? { retry: asked } : {};
					if (
						!moved && planners.length === running.size
						&& planners.every(value => running.has(value.id))
					) {
						return asked.length ? { kind: "planners", planners, ...retry } : undefined;
					}
					toldUrls.set(connection.id, new Map(planners.map(value => [value.id, value.url])));
					let listed = new Set(planners.map(value => value.id));
					let reasons = stopReasons.get(connection.machineId);
					let stopped: Record<string, string> = {};
					for (let id of running) {
						let reason = reasons?.get(id);
						if (listed.has(id) || !reason) continue;
						stopped[id] = reason;
						reasons!.delete(id);
					}
					return Object.keys(stopped).length
						? { kind: "planners", planners, stopped, ...retry }
						: { kind: "planners", planners, ...retry };
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
				let documentId = implementation.document(connection, grant, name, args);
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
		await finishShared().catch(error =>
			console.error("chopin: could not stop a machine's finished teammate Planners -", error)
		);
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
		// It attached, so whatever kept it from starting is over.
		if (options.attachments?.()?.attached(channelId)) forgetStartFailure(channelId);
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
		takers,
		mayTake,
		machineChoices: readChoices,
		plannerChanged,
		plannerUsed,
		plannerStarting,
		/** Whether this server runs Planners on people's machines: HARNESS=remote, machines' own GitHub. */
		plannerMachines: !!options.planners && auth.machines.durable,
		sourceFor,
	};
}
