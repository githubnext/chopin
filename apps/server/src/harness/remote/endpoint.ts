/**
 * `/api/v1/agent`: where a client attaches as a document's Planner.
 *
 * The upgrade must offer the `chopin.agent.v1` WebSocket subprotocol, which the
 * server echoes; any other request is refused with 426 before anything else is
 * checked. The bearer is a GitHub token checked as hosted MCP checks it, before
 * the socket upgrades. The `attach` that follows names a document whose
 * repository its account can push to or administer, and makes that account the
 * document's Planner owner. Nothing is posted to the document by attaching or
 * refusing.
 *
 * The bearer may instead be a paired machine's Planner credential, which
 * attaches only the document it was issued for, with the machine's own GitHub
 * token and no browser sign-in (see `machine-planners.ts`).
 */

import { AGENT_SUBPROTOCOL, LINK_CLOSE } from "@chopin/agent-link";

import { AdmissionDenied } from "../../auth/admission";
import { documentUrl } from "../../channels/document-url";
import { GitHubError } from "../../github/client";
import {
	DEFAULT_LINK_MAX_SILENCE_MS,
	DEFAULT_LINK_PING_MS,
	DEFAULT_LINK_TIMEOUT_MS,
} from "../../config";
import { MachineError } from "../../auth/machines";
import { locateDocument } from "../../mcp/hosted";
import { forbiddenMessage } from "./attachments";
import { AgentLink } from "./link";
import { MachinePlanners } from "./machine-planners";

import type { ServerWebSocket } from "bun";
import type { HostedAuth } from "../../auth/routes";
import type { HostedCaller } from "../../mcp/hosted";
import type { PlannerAttachments } from "./attachments";
import type { AttachOutcome, LinkOptions, LinkSocket } from "./link";
import type { MachineGrant } from "./machine-planners";

export type AgentAuth = Pick<HostedAuth, "admission" | "config" | "github" | "storage">;

function writable(repository: { permissions: { push: boolean; admin: boolean } }): boolean {
	return repository.permissions.push || repository.permissions.admin;
}

export type AgentSocketData = {
	agentLink: true;
	sidebar?: undefined;
	caller: HostedCaller;
	/** Set when the bearer was a paired machine's Planner credential rather than a GitHub token. */
	machine?: MachineGrant & { planners: MachinePlanners };
	link?: AgentLink;
	/** The link's liveness: any frame from the client is `heard`; `stop` ends its pings. */
	alive?: { heard(): void; stop(): void };
};

export type AgentHooks = {
	/** One Planner per document, and its ownership. */
	attachments: PlannerAttachments;
	/** A document being deleted cannot be attached. */
	unavailable?: (channelId: string) => boolean;
	/** Observes attached links. */
	register?: LinkOptions["register"];
	timeoutMs?: number;
	revalidateEveryMs?: number;
	/** How often the link is sent a protocol ping. */
	pingEveryMs?: number;
	/**
	 * How long the link may send nothing, not even a pong, and read none of what the
	 * server queued for it, before it is closed as dropped.
	 */
	pongTimeoutMs?: number;
	/**
	 * How long the link may send nothing at all, however much of the server's
	 * queue drains meanwhile, before it is closed as dropped. 15 minutes by default.
	 */
	maxSilenceMs?: number;
};

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

function refusal(status: number, text: string): Response {
	let headers = new Headers({
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	if (status === 401) headers.set("www-authenticate", "Bearer");
	return new Response(text, { status, headers });
}

function revoked(err: unknown): boolean {
	return err instanceof AdmissionDenied || err instanceof MachineError
		|| err instanceof GitHubError && err.status === 401;
}

/**
 * The headers an admitted upgrade is answered with. Bun would otherwise echo the
 * first subprotocol the client offered, whatever it is.
 */
export const AGENT_UPGRADE_HEADERS = { "sec-websocket-protocol": AGENT_SUBPROTOCOL };

/** Whether `request` offers the agent subprotocol, among any others. */
function offersSubprotocol(request: Request): boolean {
	let offered = request.headers.get("sec-websocket-protocol") ?? "";
	return offered.split(",").some(protocol => protocol.trim() === AGENT_SUBPROTOCOL);
}

function subprotocolRequired(): Response {
	return Response.json(
		{ code: "subprotocol-required", supported: [AGENT_SUBPROTOCOL] },
		{
			status: 426,
			headers: {
				"cache-control": "no-store",
				"x-content-type-options": "nosniff",
				upgrade: "websocket",
			},
		},
	);
}

/**
 * The caller for an upgrade request, or the HTTP refusal; nothing is upgraded on refusal.
 * A server that does not run the remote Planner answers 404 rather than its web client.
 * Upgrade an admitted request with `AGENT_UPGRADE_HEADERS`.
 */
export async function admitAgent(
	request: Request,
	auth: AgentAuth,
	enabled = true,
	planners?: MachinePlanners,
): Promise<Response | AgentSocketData> {
	if (!enabled) return refusal(404, "This Chopin does not accept agent connections.");
	if (!offersSubprotocol(request)) return subprotocolRequired();
	let origin = request.headers.get("origin");
	if (origin !== null && origin !== auth.config.origin) {
		return refusal(403, "origin is not allowed");
	}
	let token = request.headers.get("authorization")?.match(BEARER)?.[1];
	if (!token) return refusal(401, "unauthorized");
	try {
		if (MachinePlanners.claims(token)) {
			let grant = await planners?.redeem(token);
			if (!grant) return refusal(401, "unauthorized");
			let user = await auth.storage.users.get(grant.machine.userId);
			return {
				agentLink: true,
				caller: {
					oauthToken: "",
					user: { id: grant.machine.userId, login: user?.login ?? "", avatarUrl: "" },
				},
				machine: { ...grant, planners: planners! },
			};
		}
		return {
			agentLink: true,
			caller: { oauthToken: token, user: await auth.admission.user(token) },
		};
	} catch (err) {
		if (err instanceof MachineError) return refusal(401, "unauthorized");
		if (err instanceof AdmissionDenied) return refusal(403, "forbidden");
		if (err instanceof GitHubError) {
			if (err.status === 401) return refusal(401, "unauthorized");
			if (err.status === 429 || err.status >= 500) {
				return refusal(503, "GitHub access is temporarily unavailable");
			}
		}
		console.error("[agent] admission failed:", err);
		return refusal(500, "Agent connection request failed");
	}
}

/**
 * A link for one admitted caller, attaching only documents whose repository it can write. A
 * machine's link reads GitHub with the machine's own token and attaches only its grant's document.
 */
export function agentLink(
	caller: HostedCaller,
	auth: AgentAuth,
	socket: LinkSocket,
	hooks: AgentHooks,
	machine?: AgentSocketData["machine"],
): AgentLink {
	let channelId: string | undefined;
	let link: AgentLink;
	let locate = (document: string) =>
		machine
			? machine.planners.locate(machine.machine, document)
			: locateDocument(auth, caller, document);
	async function attach(message: { document: string }): Promise<AttachOutcome> {
		let located = await locate(message.document);
		if (located === "forbidden") {
			return {
				ok: false,
				code: "repository-forbidden",
				message: "Your GitHub account cannot read this document's repository.",
			};
		}
		if (!located || hooks.unavailable?.(located.channel.id)) {
			return {
				ok: false,
				code: "document-unavailable",
				message: "No document matches that id or URL.",
			};
		}
		let { channel, repository } = located;
		if (machine && channel.id !== machine.channelId) {
			return {
				ok: false,
				code: "repository-forbidden",
				message: "This Planner credential was issued for another document.",
			};
		}
		if (channel.archivedAt) {
			return { ok: false, code: "document-archived", message: "This document is archived." };
		}
		let fullName = `${repository.owner}/${repository.name}`;
		if (!writable(repository)) {
			return { ok: false, code: "repository-forbidden", message: forbiddenMessage(fullName) };
		}
		let url = new URL(await documentUrl(channel, auth.storage.channels), auth.config.origin).href;
		let login = machine ? await machine.planners.login(machine.machine) : undefined;
		let granted = await hooks.attachments.attach({
			channelId: channel.id,
			repository: { id: repository.id, owner: repository.owner, name: repository.name },
			user: { id: caller.user.id, login: caller.user.login },
			...(login
				? { login, machine: machine!.machine.label, machineId: machine!.machine.id }
				: {}),
		}, link);
		if (!granted.ok) return granted;
		channelId = channel.id;
		return {
			ok: true,
			document: { id: channel.id, title: channel.title, repository: fullName, url },
			detach: granted.detach,
		};
	}
	async function revalidate(): Promise<boolean> {
		if (!channelId) return false;
		try {
			if (machine) await machine.planners.current(machine.machine);
			else await auth.admission.user(caller.oauthToken);
			let located = await locate(channelId);
			return typeof located === "object" && located.channel.id === channelId
				&& writable(located.repository)
				&& !located.channel.archivedAt && !hooks.unavailable?.(channelId)
				&& await hooks.attachments.verify(channelId, link);
		} catch (err) {
			if (revoked(err)) return false;
			throw err;
		}
	}
	link = new AgentLink(socket, {
		attach,
		revalidate,
		register: hooks.register,
		timeoutMs: hooks.timeoutMs,
		revalidateEveryMs: hooks.revalidateEveryMs,
	});
	return link;
}

export function isAgentSocket(
	ws: ServerWebSocket<unknown>,
): ws is ServerWebSocket<AgentSocketData> {
	return (ws.data as { agentLink?: unknown } | undefined)?.agentLink === true;
}

/**
 * Opens the link and starts its protocol pings. The socket's `message` and
 * `pong` handlers call `alive.heard()`, and its `close` handler `alive.stop()`.
 */
export function openAgentSocket(
	ws: ServerWebSocket<AgentSocketData>,
	auth: AgentAuth,
	hooks: AgentHooks,
): void {
	let link = agentLink(
		ws.data.caller,
		auth,
		{
			send: text => void ws.send(text),
			close: (code, reason) => ws.close(code, reason),
		},
		hooks,
		ws.data.machine,
	);
	ws.data.link = link;
	// A network that silently goes away sends no FIN or RST. Bun's server-wide
	// idle timeout is two minutes and every send resets it, so a link the server
	// keeps writing to would stay attached and its document's turns go nowhere.
	//
	// A client slow to read leaves the server's frames queued, and Bun drops
	// control frames, pings included, while that queue is over its limit; an
	// empty ping returns the same whether it was sent or dropped. So a ping goes
	// out only once the queue is empty, and a queue that shrank since it was last
	// looked at defers the close by another timeout.
	//
	// A shrinking queue does not prove the client reads it: the kernel's buffers
	// or a proxy in front of it may be what drains it. So that deferral never runs
	// past `maxSilenceMs` after the client last sent anything; a client reading a
	// long backlog must send something, such as the pongs that follow it, by then.
	let timeoutMs = hooks.pongTimeoutMs ?? DEFAULT_LINK_TIMEOUT_MS;
	let maxSilenceMs = hooks.maxSilenceMs ?? DEFAULT_LINK_MAX_SILENCE_MS;
	let heard = Date.now();
	let progressed = heard;
	let backlog = 0;
	function reading(): void {
		let previous = backlog;
		backlog = ws.getBufferedAmount();
		if (backlog < previous) progressed = Date.now();
	}
	let pinging = setInterval(() => {
		reading();
		if (backlog === 0) ws.ping();
	}, hooks.pingEveryMs ?? DEFAULT_LINK_PING_MS);
	let deadline: ReturnType<typeof setTimeout>;
	function expire(): void {
		reading();
		let due = Math.min(progressed + timeoutMs, heard + maxSilenceMs);
		let left = due - Date.now();
		if (left > 0) deadline = setTimeout(expire, left);
		else link.close(LINK_CLOSE.unresponsive, "unresponsive");
	}
	deadline = setTimeout(expire, Math.min(timeoutMs, maxSilenceMs));
	ws.data.alive = {
		heard() {
			heard = progressed = Date.now();
		},
		stop() {
			clearInterval(pinging);
			clearTimeout(deadline);
		},
	};
}
