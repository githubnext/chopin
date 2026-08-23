import { researchWorkspacePath } from "@chopin/protocol/document-url";

import { isChannelId } from "../channels/id";
import { GitHubError } from "../github/client";
import { JobServiceError } from "../jobs/service";
import { StorageError } from "../storage/errors";
import { ResearchWorkspaceError } from "./service";

import type { HostedAuth } from "../auth/routes";
import type { AuthenticatedSession } from "../auth/session";
import type { Repository } from "../github/client";
import type { Router } from "../http/router";
import type { ChannelRecord } from "../storage/model";
import type { ResearchWorkspaceService } from "./service";

export type ResearchWorkspaceRouteOptions = {
	service: ResearchWorkspaceService;
	ensureOwner: (
		channel: ChannelRecord,
		session: AuthenticatedSession,
		repository: Repository,
	) => void | Promise<void>;
};

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const BODY_LIMIT = 32 * 1024;

function json(
	value: unknown,
	status = 200,
	options: { cookie?: string; location?: string } = {},
): Response {
	let headers = new Headers({
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
	});
	if (options.cookie) headers.append("set-cookie", options.cookie);
	if (options.location) headers.set("location", options.location);
	return Response.json(value, { status, headers });
}

function repository(value: Repository) {
	return {
		id: value.id,
		owner: value.owner,
		...(value.ownerAvatarUrl ? { ownerAvatarUrl: value.ownerAvatarUrl } : {}),
		name: value.name,
		fullName: value.fullName,
		private: value.private,
		url: value.url,
		defaultBranch: value.defaultBranch,
		permissions: value.permissions,
	};
}

async function body(
	request: Request,
	fields: string[],
): Promise<Record<string, unknown> | undefined> {
	let length = Number(request.headers.get("content-length") || "0");
	if (Number.isFinite(length) && length > BODY_LIMIT) return undefined;
	let source = await request.text();
	if (new TextEncoder().encode(source).length > BODY_LIMIT) return undefined;
	try {
		let value = JSON.parse(source) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		let record = value as Record<string, unknown>;
		let keys = Object.keys(record).sort();
		let expected = [...fields].sort();
		return keys.length === expected.length && keys.every((key, index) => key === expected[index])
			? record
			: undefined;
	} catch {
		return undefined;
	}
}

async function authorizedRepository(
	auth: HostedAuth,
	session: AuthenticatedSession,
	owner: string,
	name: string,
): Promise<{ repository: Repository; session: AuthenticatedSession } | undefined> {
	if (!OWNER.test(owner) || !REPOSITORY.test(name)) return undefined;
	let result = await auth.sessions.use(
		session,
		token => auth.github.repositoryAccess(token, owner, name),
	);
	return result.value ? { repository: result.value, session: result.authenticated } : undefined;
}

async function channelAccess(
	auth: HostedAuth,
	session: AuthenticatedSession,
	channelId: string,
): Promise<
	{ channel: ChannelRecord; repository: Repository; session: AuthenticatedSession } | undefined
> {
	if (!isChannelId(channelId)) return undefined;
	let channel = await auth.storage.channels.get(channelId);
	if (!channel) return undefined;
	let resolved = await authorizedRepository(
		auth,
		session,
		channel.repositoryOwner,
		channel.repositoryName,
	);
	if (
		!resolved || resolved.repository.id !== channel.repositoryId
		|| !resolved.repository.permissions.pull
	) {
		return undefined;
	}
	return { channel, repository: resolved.repository, session: resolved.session };
}

function canWrite(value: Repository): boolean {
	return value.permissions.push || value.permissions.admin;
}

function location(channel: ChannelRecord, repository: Repository, workspaceId: string): string {
	return researchWorkspacePath(
		repository.owner,
		repository.name,
		channel.slug,
		workspaceId,
	);
}

function origin(request: Request, auth: HostedAuth): Response | undefined {
	return request.headers.get("origin") === auth.config.origin
		? undefined
		: json({ error: "origin is not allowed" }, 403);
}

function failure(err: unknown, auth: HostedAuth): Response {
	if (err instanceof ResearchWorkspaceError) {
		let status = err.code === "invalid-request"
			? 400
			: err.code === "not-found"
			? 404
			: err.code === "not-ready" || err.code === "active-turn"
			? 409
			: 500;
		let error = err.code === "not-found"
			? "research workspace not found"
			: err.code === "not-ready"
			? "research workspace is not ready"
			: err.code === "active-turn"
			? "another research turn is active"
			: err.code === "invalid-request"
			? "invalid research workspace request"
			: "research workspace state is invalid";
		return json({ error }, status);
	}
	if (err instanceof JobServiceError) {
		return err.code === "invalid-request"
			? json({ error: "invalid research job request" }, 400)
			: json({ error: "research jobs are unavailable" }, 503);
	}
	if (err instanceof StorageError) {
		let status = err.failure === "missing"
			? 404
			: err.failure === "conflict"
			? 409
			: err.failure === "unavailable"
			? 503
			: 500;
		let error = status === 404
			? "research workspace not found"
			: status === 409
			? "research workspace request conflicts with durable state"
			: status === 503
			? "storage is unavailable"
			: "research workspace storage failed";
		return json({ error }, status);
	}
	if (err instanceof GitHubError) {
		if (err.status === 401) {
			return json(
				{ error: "GitHub authorization expired" },
				401,
				{ cookie: auth.sessions.clearCookie() },
			);
		}
		if (err.status === 404) return json({ error: "repository not found" }, 404);
		if (err.status === 403) return json({ error: "repository access is required" }, 403);
		if (err.status === 429 || err.status >= 500) {
			return json({ error: "repository access is temporarily unavailable" }, 503);
		}
		return json({ error: "repository access failed" }, 502);
	}
	return json({ error: "research workspace request failed" }, 500);
}

/** Authenticated HTTP surface for document-attached research workspaces. */
export function registerResearchWorkspaceRoutes(
	router: Router,
	auth: HostedAuth,
	options: ResearchWorkspaceRouteOptions,
): void {
	let service = options.service;

	router.on(
		"GET",
		"/api/repositories/:owner/:repository/research-workspaces",
		async (request, _url, params) => {
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let resolved = await authorizedRepository(
					auth,
					session,
					params.owner!,
					params.repository!,
				);
				if (!resolved) return json({ error: "repository not found" }, 404);
				if (!resolved.repository.permissions.pull) {
					return json({ error: "repository read access is required" }, 403);
				}
				let listed = await service.listRepository(resolved.repository.id);
				return json({
					repository: repository(resolved.repository),
					canEdit: canWrite(resolved.repository),
					channels: listed.channels,
					truncated: listed.truncated,
				});
			} catch (err) {
				return failure(err, auth);
			}
		},
	);

	router.on(
		"POST",
		"/api/channels/:channelId/research-workspaces",
		async (request, _url, params) => {
			let denied = origin(request, auth);
			if (denied) return denied;
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let access = await channelAccess(auth, session, params.channelId!);
				if (!access) return json({ error: "channel not found" }, 404);
				if (!canWrite(access.repository)) {
					return json({ error: "repository write access is required" }, 403);
				}
				let input = await body(request, ["question", "requestId"]);
				if (!input) return json({ error: "question and requestId are required" }, 400);
				let created = await service.createDraft({
					channelId: access.channel.id,
					question: input.question as string,
					requestId: input.requestId as string,
					origin: "sidebar",
					createdBy: session.user.id,
				});
				return json(
					created,
					created.repeated ? 200 : 201,
					{ location: location(access.channel, access.repository, created.workspace.id) },
				);
			} catch (err) {
				return failure(err, auth);
			}
		},
	);

	router.on(
		"GET",
		"/api/channels/:channelId/research-workspaces/:workspaceId",
		async (request, _url, params) => {
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let access = await channelAccess(auth, session, params.channelId!);
				if (!access) return json({ error: "research workspace not found" }, 404);
				let workspace = await service.get(access.channel.id, params.workspaceId!);
				return workspace
					? json(workspace)
					: json({ error: "research workspace not found" }, 404);
			} catch (err) {
				return failure(err, auth);
			}
		},
	);

	router.on(
		"POST",
		"/api/channels/:channelId/research-workspaces/:workspaceId/confirm",
		async (request, _url, params) => {
			let denied = origin(request, auth);
			if (denied) return denied;
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let access = await channelAccess(auth, session, params.channelId!);
				if (!access) return json({ error: "research workspace not found" }, 404);
				if (!canWrite(access.repository)) {
					return json({ error: "repository write access is required" }, 403);
				}
				let input = await body(request, ["query", "requestId"]);
				if (!input) return json({ error: "query and requestId are required" }, 400);
				let existing = await service.get(access.channel.id, params.workspaceId!);
				if (!existing) return json({ error: "research workspace not found" }, 404);
				let workspace = await service.confirm({
					channelId: access.channel.id,
					workspaceId: existing.workspace.id,
					query: input.query as string,
					requestId: input.requestId as string,
					confirmedBy: session.user.id,
					confirmedByHandle: session.user.login,
					beforeStart: () => options.ensureOwner(access.channel, access.session, access.repository),
				});
				return json(workspace, 200, {
					location: location(access.channel, access.repository, workspace.workspace.id),
				});
			} catch (err) {
				return failure(err, auth);
			}
		},
	);

	router.on(
		"POST",
		"/api/channels/:channelId/research-workspaces/:workspaceId/turns",
		async (request, _url, params) => {
			let denied = origin(request, auth);
			if (denied) return denied;
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let access = await channelAccess(auth, session, params.channelId!);
				if (!access) return json({ error: "research workspace not found" }, 404);
				if (!canWrite(access.repository)) {
					return json({ error: "repository write access is required" }, 403);
				}
				let input = await body(request, ["kind", "question", "requestId"]);
				if (
					!input || (input.kind !== "follow-up" && input.kind !== "search-more")
				) return json({ error: "kind, question and requestId are required" }, 400);
				let existing = await service.get(access.channel.id, params.workspaceId!);
				if (!existing) return json({ error: "research workspace not found" }, 404);
				let workspace = await service.appendTurn({
					channelId: access.channel.id,
					workspaceId: existing.workspace.id,
					kind: input.kind,
					question: input.question as string,
					requestId: input.requestId as string,
					requestedBy: session.user.id,
					requestedByHandle: session.user.login,
					beforeStart: () => options.ensureOwner(access.channel, access.session, access.repository),
				});
				return json(workspace, 200, {
					location: location(access.channel, access.repository, workspace.workspace.id),
				});
			} catch (err) {
				return failure(err, auth);
			}
		},
	);

	router.on(
		"POST",
		"/api/channels/:channelId/research-workspaces/:workspaceId/turns/:turnId/cancel",
		async (request, _url, params) => {
			let denied = origin(request, auth);
			if (denied) return denied;
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let access = await channelAccess(auth, session, params.channelId!);
				if (!access) return json({ error: "research workspace not found" }, 404);
				if (!canWrite(access.repository)) {
					return json({ error: "repository write access is required" }, 403);
				}
				let workspace = await service.cancelTurn({
					channelId: access.channel.id,
					workspaceId: params.workspaceId!,
					turnId: params.turnId!,
				});
				return json(workspace, 200, {
					location: location(access.channel, access.repository, workspace.workspace.id),
				});
			} catch (err) {
				return failure(err, auth);
			}
		},
	);
}
