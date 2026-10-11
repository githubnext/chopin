/**
 * `/planner-link`: where a client attaches as a document's Planner.
 *
 * The bearer is a GitHub token checked as hosted MCP checks it, before the
 * socket upgrades. The `attach` that follows names a document whose repository
 * its account can push to or administer, and makes that account the document's
 * Planner owner. Nothing is posted to the document by attaching or refusing.
 */

import { AdmissionDenied } from "../../auth/admission";
import { documentUrl } from "../../channels/document-url";
import { GitHubError } from "../../github/client";
import { locateDocument } from "../../mcp/hosted";
import { forbiddenMessage } from "./attachments";
import { PlannerLink } from "./link";

import type { ServerWebSocket } from "bun";
import type { HostedAuth } from "../../auth/routes";
import type { HostedCaller } from "../../mcp/hosted";
import type { PlannerAttachments } from "./attachments";
import type { AttachOutcome, LinkOptions, LinkSocket } from "./link";

export type PlannerLinkAuth = Pick<HostedAuth, "admission" | "config" | "github" | "storage">;

function writable(repository: { permissions: { push: boolean; admin: boolean } }): boolean {
	return repository.permissions.push || repository.permissions.admin;
}

export type PlannerLinkSocketData = {
	plannerLink: true;
	sidebar?: undefined;
	caller: HostedCaller;
	link?: PlannerLink;
};

export type PlannerLinkHooks = {
	/** One Planner per document, and its ownership. */
	attachments: PlannerAttachments;
	/** A document being deleted cannot be attached. */
	unavailable?: (channelId: string) => boolean;
	/** Observes attached links. */
	register?: LinkOptions["register"];
	timeoutMs?: number;
	revalidateEveryMs?: number;
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
	return err instanceof AdmissionDenied || err instanceof GitHubError && err.status === 401;
}

/**
 * The caller for an upgrade request, or the HTTP refusal; nothing is upgraded on refusal.
 * A server that does not run the remote Planner answers 404 rather than its web client.
 */
export async function admitPlannerLink(
	request: Request,
	auth: PlannerLinkAuth,
	enabled = true,
): Promise<Response | PlannerLinkSocketData> {
	if (!enabled) return refusal(404, "This Chopin does not accept Planner links.");
	let origin = request.headers.get("origin");
	if (origin !== null && origin !== auth.config.origin) {
		return refusal(403, "origin is not allowed");
	}
	let token = request.headers.get("authorization")?.match(BEARER)?.[1];
	if (!token) return refusal(401, "unauthorized");
	try {
		return {
			plannerLink: true,
			caller: { oauthToken: token, user: await auth.admission.user(token) },
		};
	} catch (err) {
		if (err instanceof AdmissionDenied) return refusal(403, "forbidden");
		if (err instanceof GitHubError) {
			if (err.status === 401) return refusal(401, "unauthorized");
			if (err.status === 429 || err.status >= 500) {
				return refusal(503, "GitHub access is temporarily unavailable");
			}
		}
		console.error("[planner-link] admission failed:", err);
		return refusal(500, "Planner link request failed");
	}
}

/** A link for one admitted caller, attaching only documents whose repository it can write. */
export function plannerLink(
	caller: HostedCaller,
	auth: PlannerLinkAuth,
	socket: LinkSocket,
	hooks: PlannerLinkHooks,
): PlannerLink {
	let channelId: string | undefined;
	let link: PlannerLink;
	async function attach(message: { document: string }): Promise<AttachOutcome> {
		let located = await locateDocument(auth, caller, message.document);
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
		if (channel.archivedAt) {
			return { ok: false, code: "document-archived", message: "This document is archived." };
		}
		let fullName = `${repository.owner}/${repository.name}`;
		if (!writable(repository)) {
			return { ok: false, code: "repository-forbidden", message: forbiddenMessage(fullName) };
		}
		let url = new URL(await documentUrl(channel, auth.storage.channels), auth.config.origin).href;
		let granted = await hooks.attachments.attach({
			channelId: channel.id,
			repository: { id: repository.id, owner: repository.owner, name: repository.name },
			user: { id: caller.user.id, login: caller.user.login },
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
			await auth.admission.user(caller.oauthToken);
			let located = await locateDocument(auth, caller, channelId);
			return typeof located === "object" && located.channel.id === channelId
				&& writable(located.repository)
				&& !located.channel.archivedAt && !hooks.unavailable?.(channelId)
				&& await hooks.attachments.verify(channelId, link);
		} catch (err) {
			if (revoked(err)) return false;
			throw err;
		}
	}
	link = new PlannerLink(socket, {
		attach,
		revalidate,
		register: hooks.register,
		timeoutMs: hooks.timeoutMs,
		revalidateEveryMs: hooks.revalidateEveryMs,
	});
	return link;
}

export function isPlannerLinkSocket(
	ws: ServerWebSocket<unknown>,
): ws is ServerWebSocket<PlannerLinkSocketData> {
	return (ws.data as { plannerLink?: unknown } | undefined)?.plannerLink === true;
}

export function openPlannerLinkSocket(
	ws: ServerWebSocket<PlannerLinkSocketData>,
	auth: PlannerLinkAuth,
	hooks: PlannerLinkHooks,
): void {
	ws.data.link = plannerLink(ws.data.caller, auth, {
		send: text => void ws.send(text),
		close: (code, reason) => ws.close(code, reason),
	}, hooks);
}
