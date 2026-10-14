import { z } from "zod";
import { isChannelId } from "../channels/id";
import { GitHubError } from "../github/client";
import { StorageError } from "../storage/errors";
import { AGENDA_LIMITS, AgendaError } from "./service";
import { saveSchema } from "./domain";
import type { HostedAuth } from "../auth/routes";
import type { AuthenticatedSession } from "../auth/session";
import type { Repository } from "../github/client";
import type { Router } from "../http/router";
import type { ChannelRecord } from "../storage/model";
import type { AgendaOwner, AgendaService } from "./service";

export type AgendaRouteOptions = {
	service: AgendaService;
	/** An explicit human activation may establish an owner; scheduling never does. */
	authorize: (
		channel: ChannelRecord,
		session: AuthenticatedSession,
		repository: Repository,
	) => Promise<AgendaOwner>;
};
const pauseSchema = z.object({ expectedGeneration: z.number().int().min(1) }).strict();
const revisionSchema = z.object({ expectedRevision: z.number().int().min(1) }).strict();
const BODY_LIMIT = 16 * 1024;

function json(value: unknown, status = 200, cookie?: string) {
	let headers = new Headers({
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
	});
	if (cookie) headers.set("set-cookie", cookie);
	return Response.json(value, { status, headers });
}

function failure(error: unknown, auth: HostedAuth) {
	if (error instanceof AgendaError) {
		return json(
			{ error: error.message },
			error.code === "invalid" ? 400 : error.code === "conflict" ? 409 : 503,
		);
	}
	if (error instanceof StorageError) {
		return json(
			{ error: "The agenda could not be saved. Refresh and try again." },
			error.failure === "conflict" ? 409 : error.failure === "missing" ? 404 : 503,
		);
	}
	if (error instanceof GitHubError) {
		if (error.status === 401) {
			return json({ error: "Sign in again to continue." }, 401, auth.sessions.clearCookie());
		}
		return json(
			{ error: "Repository access could not be verified." },
			error.status === 403 ? 403 : 503,
		);
	}
	return json({ error: "The research agenda is temporarily unavailable." }, 500);
}

export function registerAgendaRoutes(
	router: Router,
	auth: HostedAuth,
	options: AgendaRouteOptions,
) {
	let service = options.service;
	for (let action of ["read", "save", "activate", "pause"] as const) {
		let method = action === "read" ? "GET" : action === "save" ? "PUT" : "POST";
		let suffix = action === "activate" || action === "pause" ? `/${action}` : "";
		router.on(
			method,
			`/api/channels/:channelId/research-agenda${suffix}`,
			async (request, _url, params) => {
				if (method !== "GET" && request.headers.get("origin") !== auth.config.origin) {
					return json({ error: "Origin is not allowed." }, 403);
				}
				try {
					let session = await auth.sessions.authenticate(request);
					if (!session) return json({ error: "Sign in to continue." }, 401);
					let channelId = params.channelId!;
					if (!isChannelId(channelId)) return json({ error: "Document not found." }, 404);
					let channel = await auth.storage.channels.get(channelId);
					if (!channel || channel.parentChannelId) {
						return json({ error: "Document not found." }, 404);
					}
					let access = await auth.sessions.use(session, async token => {
						if (!await auth.admission.allowed(token, session.user.id)) {
							return undefined;
						}
						return auth.github.repositoryAccess(
							token,
							channel.repositoryOwner,
							channel.repositoryName,
						);
					});
					let repository = access.value;
					if (
						!repository || repository.id !== channel.repositoryId || !repository.permissions.pull
					) {
						return json({ error: "Document not found." }, 404);
					}
					let canEdit = !!(repository.permissions.push || repository.permissions.admin)
						&& !channel.archivedAt;
					if (method !== "GET") {
						if (!canEdit) return json({ error: "Repository write access is required." }, 403);
						if (Number(request.headers.get("content-length") ?? 0) > BODY_LIMIT) {
							return json({ error: "Agenda request is too large." }, 400);
						}
						let source = await request.text();
						if (Buffer.byteLength(source) > BODY_LIMIT) {
							return json({ error: "Agenda request is too large." }, 400);
						}
						let body: unknown;
						try {
							body = JSON.parse(source);
						} catch {
							return json({ error: "Invalid agenda request." }, 400);
						}
						if (action === "save") {
							let parsed = saveSchema.safeParse(body);
							if (!parsed.success) {
								return json(
									{ error: "Provide a public scope and up to six bounded questions." },
									400,
								);
							}
							await service.save(channelId, parsed.data);
						} else if (action === "pause") {
							let parsed = pauseSchema.safeParse(body);
							if (!parsed.success) {
								return json({ error: "The current agenda generation is required." }, 400);
							}
							await service.pause(channelId, parsed.data.expectedGeneration);
						} else {
							let parsed = revisionSchema.safeParse(body);
							if (!parsed.success) {
								return json({ error: "The current agenda revision is required." }, 400);
							}
							{
								if (!service.available()) {
									throw new AgendaError("unavailable", "Bounded public research is unavailable.");
								}
								await service.activate(
									channelId,
									parsed.data.expectedRevision,
									await options.authorize(channel, access.authenticated, repository),
								);
							}
						}
					}
					let available = service.available() && !channel.archivedAt;
					return json({
						agenda: await service.get(channelId),
						canEdit,
						available,
						limits: AGENDA_LIMITS,
						...(!available
							? {
								unavailableReason: channel.archivedAt
									? "Restore this document to delegate research."
									: "Public research requires enabled background workers and a harness with enforced AI credit limits.",
							}
							: {}),
					});
				} catch (error) {
					return failure(error, auth);
				}
			},
		);
	}
}
