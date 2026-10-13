import { z } from "zod";
import { capabilities, ExperimentError, limits, sourceSchema } from "@chopin/experiment";
import { publicInvestigation } from "@chopin/experiment/records";
import type { Investigation, InvestigationProvenance } from "@chopin/experiment/records";
import type { HostedAuth } from "../auth/routes";
import { MachineError } from "../auth/machines";
import type { GitHubTokenGrant } from "../github/client";
import type { StoredMachine } from "../storage/model";
import type { AuthenticatedSession } from "../auth/session";
import type { Router } from "../http/router";
import { canonical as canonicalReport } from "../mcp/create";
import { parse } from "@chopin/dialect";
import {
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_UPDATE_REQUIRED,
	CONNECTOR_VERSION_HEADER,
} from "@chopin/protocol/connector";
import { documentsPath } from "@chopin/protocol/document-url";
import { documentUrl } from "../channels/document-url";
import type { MachinePlanners } from "../harness/remote/machine-planners";
import { Connections } from "./connections";
import type { Connection } from "./connections";
import { Experiments, fail } from "./service";
import { datasetCsv } from "./export";
import { investigationSummary } from "./document";
import { implementationSchemas } from "../tasks/connector";
import type { ImplementationConnector } from "../tasks/connector";
import { connectorSchemas } from "./mcp-schema";
import type { Lease } from "../storage/model";
import { createHash } from "node:crypto";
import { imagePath } from "../images/format";
import { MAX_IMAGE_REQUEST_BYTES, prepareImage } from "../mcp/image";
import { spikeReport, spikeSubmissionSchema } from "./spikes";

export type ExperimentRuntime = ReturnType<typeof registerExperimentRoutes>;
type Options = {
	implementations?: () => ImplementationConnector | undefined;
	lease: () => Lease;
	context: (id: string) => Promise<{ source: string; revision: number } | undefined>;
	changed: (id: string) => void;
	canMutate?: (id: string) => Promise<boolean>;
	/** One of an owner's paired machines connected a checkout of a repository. */
	connected?: (repositoryId: string, owner: string) => void;
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
};
const label = z.string().trim().min(1).max(100);
/** `chopin pair` names a checkout only when it runs inside one. */
const pairingSchema = z.object({
	label,
	repository: sourceSchema.shape.repository.optional(),
	commit: sourceSchema.shape.commit.optional(),
	branch: sourceSchema.shape.branch,
}).strict().refine(value => !value.repository === !value.commit, "invalid checkout");
const checkoutSchema = sourceSchema.omit({ repositoryId: true }).extend({ label }).strict();

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
 * The connector protocols this server speaks; a connector outside them must update first.
 * Protocol 2 pairs a machine once and connects checkouts with its stored token.
 */
export const CONNECTOR_PROTOCOLS: { min: number; max: number } = { min: 2, max: 3 };

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
	// Only a release version is echoed; a script or source run has none.
	let version = request.headers.get(CONNECTOR_VERSION_HEADER) ?? "";
	let release = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version);
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
		`${release ? `chopin ${version}` : "This connector"} speaks connector protocol ${protocol}, `
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

export function registerExperimentRoutes(router: Router, auth: HostedAuth, options: Options) {
	let connections = new Connections();
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
		let live = connections.candidates(repositoryId, owner, documentId);
		if (!live.length) fail("no-workspace");
		for (let connection of live) if (!await busy(connection)) return connection;
		return live[0];
	}
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
					code === "authentication-required" || code.startsWith("machine-")
						? 401
						: code.includes("forbidden")
						? 403
						: code === "not-found"
						? 404
						: code === "unavailable"
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
		let created = connections.create(pairingSchema.parse(await body(request)));
		return json({ ...created, url: `${auth.config.origin}/connect?pairing=${created.id}` });
	});
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
		return `/connect?pairing=${id}`;
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
	/** A paired machine connects one checkout; the connection's token lives only in memory. */
	route("POST", "/api/connector/connections", async request => {
		compatible(request, auth.config.origin, options.connectorVersion);
		let machine = await machineRefusal(() => auth.machines.authenticate(bearer(request)));
		let input = checkoutSchema.parse(await body(request));
		let caller = await machineCaller(machine);
		let repository = await repositoryWrite(caller, input.repository);
		let user = await auth.storage.users.get(machine.userId);
		let { label, ...checkout } = input;
		let { connection, token } = connections.open(
			{
				id: machine.id,
				owner: machine.userId,
				login: user?.login ?? machine.userId,
				autoRun: machine.autoRun,
			},
			label,
			{ ...checkout, repositoryId: repository.id },
		);
		await auth.machines.seen(machine);
		connections.wake(repository.id);
		options.connected?.(repository.id, machine.userId);
		return json({
			token,
			connection: { id: connection.id, source: connection.source },
			machine: machine.id,
		});
	});
	/**
	 * `chopin connect --planner`: a short-lived credential with which the machine's Planner backend
	 * attaches one document over `/planner-link`, checked with the machine's own GitHub token. Under
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
		return json({ ...planners.issue(machine, channel.id), document: { id: channel.id, url } });
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
		return json({
			machines: machines.map(machine => ({
				id: machine.id,
				label: machine.label,
				repositories: [
					...new Set([
						...machine.repositories.map(value => value.repository),
						...connections.machine(machine.id).map(value => value.source.repository),
					]),
				],
				autoRun: machine.autoRun,
				createdAt: machine.createdAt.getTime(),
				lastSeenAt: machine.lastSeenAt.getTime(),
				connected: connections.machine(machine.id).length > 0,
				reauthorize: !!machine.reauthorizeAt,
			})),
		});
	});
	route("POST", "/api/connector/machines/:id/revoke", async (request, params) => {
		let session = await auth.sessions.authenticate(request);
		if (!session) fail("authentication-required");
		z.object({}).strict().parse(await body(request));
		if (!await auth.machines.revoke(params.id, session.user.id)) fail("not-found");
		await disconnectMachine(params.id);
		return json({ revoked: true });
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
			source: value.input?.source ?? connection.source,
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
	 * Re-authorize a connection's machine and its owner for its repository, and for a run's
	 * document, with the machine's own GitHub authorization rather than a browser login.
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
		let repository = await repositoryWrite(caller, found.connection.source.repository)
			.catch(async error => {
				if (error instanceof ExperimentError && error.code.startsWith("machine-")) {
					await disconnectMachine(machine.id, error.code);
				}
				throw error;
			});
		if (repository.id !== found.connection.source.repositoryId) fail("repository-forbidden");
		if (found.grant.run) await target(caller, found.connection, found.grant.run.documentId);
		if (!connections.get(found.connection.id)) fail("connection-unavailable");
		await auth.machines.seen(machine);
		let stale = !connections.fresh(found.connection);
		connections.touch(found.connection);
		// Work held back from a silent connection can go to it again now it is heard from.
		if (stale) {
			options.connected?.(found.connection.source.repositoryId, found.connection.owner);
		}
		return { ...found, caller };
	}
	/** Write access to a run's document, which must belong to the connection's repository. */
	async function target(caller: Caller, connection: Connection, documentId: string) {
		let { channel } = await documentAccess(caller, documentId, true);
		if (channel.repositoryId !== connection.source.repositoryId) fail("repository-forbidden");
		return channel;
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
					await connections.wait(connection.source.repositoryId, request.signal);
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
					await connections.wait(connection.source.repositoryId, request.signal);
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
	return { service, connections, access, mutationAllowed, route, body, json, sweep };
}
