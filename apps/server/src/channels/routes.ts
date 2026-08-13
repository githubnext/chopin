import { GitHubError } from "../github/client";
import { StorageError } from "../storage/errors";

import type { HostedAuth } from "../auth/routes";
import type { Repository } from "../github/client";
import type { Router } from "../http/router";
import type { ChannelCursor, ChannelRecord } from "../storage/model";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const CHANNEL = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function json(value: unknown, status = 200, cookie?: string, location?: string): Response {
	let headers = new Headers({
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"x-content-type-options": "nosniff",
	});
	if (cookie) headers.append("set-cookie", cookie);
	if (location) headers.set("location", location);
	return Response.json(value, { status, headers });
}

function serialized(channel: ChannelRecord) {
	return {
		id: channel.id,
		repositoryId: channel.repositoryId,
		repositoryOwner: channel.repositoryOwner,
		repositoryName: channel.repositoryName,
		title: channel.title,
		createdBy: channel.createdBy,
		revision: channel.revision,
		createdAt: channel.createdAt.toISOString(),
		updatedAt: channel.updatedAt.toISOString(),
	};
}

function repository(value: Repository) {
	return {
		id: value.id,
		owner: value.owner,
		name: value.name,
		fullName: value.fullName,
		private: value.private,
		url: value.url,
		defaultBranch: value.defaultBranch,
		permissions: value.permissions,
	};
}

function encoded(cursor: ChannelCursor): string {
	return Buffer.from(JSON.stringify({
		v: 1,
		updatedAt: cursor.updatedAt.toISOString(),
		id: cursor.id,
	})).toString("base64url");
}

function decoded(value: string | null): ChannelCursor | undefined | false {
	if (value === null) return undefined;
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
	try {
		let parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return false;
		let item = parsed as Record<string, unknown>;
		if (item.v !== 1 || typeof item.updatedAt !== "string" || typeof item.id !== "string") {
			return false;
		}
		let updatedAt = new Date(item.updatedAt);
		if (Number.isNaN(updatedAt.getTime()) || !CHANNEL.test(item.id)) return false;
		return { updatedAt, id: item.id };
	} catch {
		return false;
	}
}

function limit(url: URL): number | undefined {
	let values = url.searchParams.getAll("limit");
	if (values.length === 0) return 50;
	if (values.length !== 1 || !/^\d+$/.test(values[0]!)) return undefined;
	let parsed = Number(values[0]);
	return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined;
}

async function title(request: Request): Promise<string | undefined> {
	let length = Number(request.headers.get("content-length") || "0");
	if (Number.isFinite(length) && length > 4_096) return undefined;
	let source = await request.text();
	if (new TextEncoder().encode(source).length > 4_096) return undefined;
	try {
		let value = JSON.parse(source) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		let raw = (value as Record<string, unknown>).title;
		if (typeof raw !== "string") return undefined;
		let result = raw.trim();
		return result.length >= 1 && result.length <= 120 ? result : undefined;
	} catch {
		return undefined;
	}
}

async function failure(err: unknown, request: Request, auth: HostedAuth): Promise<Response> {
	if (err instanceof GitHubError) {
		if (err.status === 401) {
			await auth.sessions.revoke(request).catch(() => {});
			return json({ error: "GitHub authorization expired" }, 401, auth.sessions.clearCookie());
		}
		return json({ error: err.message }, err.status);
	}
	if (err instanceof StorageError) {
		let status = err.failure === "missing"
			? 404
			: err.failure === "conflict"
			? 409
			: err.failure === "unavailable"
			? 503
			: 500;
		return json(
			{ error: status === 503 ? "storage is unavailable" : "channel storage failed" },
			status,
		);
	}
	return json({ error: "request failed" }, 500);
}

async function authorizedRepository(
	auth: HostedAuth,
	token: string,
	owner: string,
	name: string,
): Promise<Repository> {
	if (!OWNER.test(owner) || !REPOSITORY.test(name)) {
		throw new GitHubError("repository not found", 404);
	}
	let repository = await auth.github.repositoryAccess(token, owner, name);
	if (!repository) throw new GitHubError("repository not found", 404);
	return repository;
}

/** Authenticated metadata routes; live collaboration is still the following stage. */
export function registerChannelRoutes(router: Router, auth: HostedAuth | undefined): void {
	if (!auth) return;

	router.on(
		"GET",
		"/api/repositories/:owner/:repository/channels",
		async (request, url, params) => {
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let repo = await authorizedRepository(
					auth,
					session.oauthToken,
					params.owner!,
					params.repository!,
				);
				if (!repo.permissions.pull) {
					return json({ error: "repository read access is required" }, 403);
				}
				let requestedLimit = limit(url);
				let cursorValues = url.searchParams.getAll("cursor");
				let cursor = cursorValues.length <= 1 ? decoded(cursorValues[0] ?? null) : false;
				if (!requestedLimit || cursor === false) {
					return json({ error: "invalid channel pagination" }, 400);
				}
				let page = await auth.storage.channels.list(repo.id, requestedLimit, cursor);
				return json({
					repository: repository(repo),
					canEdit: repo.permissions.push || repo.permissions.admin,
					channels: page.channels.map(serialized),
					nextCursor: page.next ? encoded(page.next) : undefined,
				});
			} catch (err) {
				return failure(err, request, auth);
			}
		},
	);

	router.on(
		"POST",
		"/api/repositories/:owner/:repository/channels",
		async (request, _url, params) => {
			if (request.headers.get("origin") !== auth.config.origin) {
				return json({ error: "origin is not allowed" }, 403);
			}
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let repo = await authorizedRepository(
					auth,
					session.oauthToken,
					params.owner!,
					params.repository!,
				);
				if (!repo.permissions.push && !repo.permissions.admin) {
					return json({ error: "repository write access is required" }, 403);
				}
				let requestedTitle = await title(request);
				if (!requestedTitle) {
					return json({ error: "title must be between 1 and 120 characters" }, 400);
				}
				let channel = await auth.storage.channels.create({
					id: crypto.randomUUID(),
					repositoryId: repo.id,
					repositoryOwner: repo.owner,
					repositoryName: repo.name,
					title: requestedTitle,
					createdBy: session.user.id,
					now: auth.clock(),
				});
				return json(
					{ repository: repository(repo), canEdit: true, channel: serialized(channel) },
					201,
					undefined,
					`/channels/${channel.id}`,
				);
			} catch (err) {
				return failure(err, request, auth);
			}
		},
	);

	router.on("GET", "/api/channels/:channelId", async (request, _url, params) => {
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let id = params.channelId!;
			if (!CHANNEL.test(id)) return json({ error: "channel not found" }, 404);
			let channel = await auth.storage.channels.get(id);
			if (!channel) return json({ error: "channel not found" }, 404);
			let repo = await authorizedRepository(
				auth,
				session.oauthToken,
				channel.repositoryOwner,
				channel.repositoryName,
			);
			if (repo.id !== channel.repositoryId || !repo.permissions.pull) {
				return json({ error: "channel not found" }, 404);
			}
			return json({
				repository: repository(repo),
				canEdit: repo.permissions.push || repo.permissions.admin,
				channel: serialized(channel),
			});
		} catch (err) {
			return failure(err, request, auth);
		}
	});
}
