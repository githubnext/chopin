import { displayTitle } from "@chopin/dialect";
import * as Plan from "../plan/service";
import { documentPath } from "@chopin/protocol/document-url";
import { MAX_GITHUB_REFERENCES, parseGitHubReferenceKey } from "@chopin/protocol/github-reference";

import { GitHubError } from "../github/client";
import { StorageError } from "../storage/errors";

import { documentTitles } from "./document-title";
import { isChannelId, newChannelId } from "./id";
import { documentSlug } from "./slug";
import { normalizedTitle } from "./title";

import type { HostedAuth } from "../auth/routes";
import type { AuthenticatedSession } from "../auth/session";
import type { GitHubReference, GitHubReferencesResponse } from "@chopin/protocol/github-reference";
import type { Repository } from "../github/client";
import type { GitHubReferences } from "../github/references";
import type { Router } from "../http/router";
import type {
	ChannelArchiveResult,
	ChannelCursor,
	ChannelRecord,
	RenameResult,
} from "../storage/model";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

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
		...(channel.parentChannelId ? { parentChannelId: channel.parentChannelId } : {}),
		title: channel.title,
		slug: channel.slug,
		createdBy: channel.createdBy,
		revision: channel.revision,
		createdAt: channel.createdAt.toISOString(),
		updatedAt: channel.updatedAt.toISOString(),
		descriptionRevision: channel.description?.revision ?? 0,
		...(channel.description ? { description: channel.description.value } : {}),
		...(channel.archivedAt ? { archivedAt: channel.archivedAt.toISOString() } : {}),
		unansweredDecisions: channel.unansweredDecisions,
	};
}

function repository(value: Repository) {
	return {
		id: value.id,
		owner: value.owner,
		ownerAvatarUrl: value.ownerAvatarUrl,
		name: value.name,
		fullName: value.fullName,
		private: value.private,
		url: value.url,
		defaultBranch: value.defaultBranch,
		permissions: value.permissions,
	};
}

function encoded(cursor: ChannelCursor, query: string, includeArchived: boolean): string {
	return Buffer.from(JSON.stringify({
		v: 3,
		updatedAt: cursor.updatedAt.toISOString(),
		id: cursor.id,
		query,
		includeArchived,
	})).toString("base64url");
}

function decoded(
	value: string | null,
): { cursor: ChannelCursor; query: string; includeArchived: boolean } | undefined | false {
	if (value === null) return undefined;
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
	try {
		let parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return false;
		let item = parsed as Record<string, unknown>;
		if (
			item.v !== 3
			|| typeof item.updatedAt !== "string"
			|| typeof item.id !== "string"
			|| typeof item.query !== "string"
			|| typeof item.includeArchived !== "boolean"
		) {
			return false;
		}
		let updatedAt = new Date(item.updatedAt);
		if (Number.isNaN(updatedAt.getTime()) || !isChannelId(item.id)) return false;
		return {
			cursor: { updatedAt, id: item.id },
			query: item.query,
			includeArchived: item.includeArchived,
		};
	} catch {
		return false;
	}
}

function query(url: URL): string | false {
	let values = url.searchParams.getAll("query");
	if (values.length > 1) return false;
	let value = values[0]?.trim().toLowerCase() ?? "";
	return value.length <= 120 ? value : false;
}

function limit(url: URL): number | undefined {
	let values = url.searchParams.getAll("limit");
	if (values.length === 0) return 50;
	if (values.length !== 1 || !/^\d+$/.test(values[0]!)) return undefined;
	let parsed = Number(values[0]);
	return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined;
}

function archived(url: URL): boolean | undefined {
	let values = url.searchParams.getAll("includeArchived");
	if (values.length === 0) return false;
	if (values.length !== 1 || values[0] !== "true") return undefined;
	return true;
}

async function requestedTitle(
	request: Request,
	optional: boolean,
): Promise<{ title?: string; valid: boolean }> {
	let length = Number(request.headers.get("content-length") || "0");
	if (Number.isFinite(length) && length > 4_096) return { valid: false };
	let source = await request.text();
	if (new TextEncoder().encode(source).length > 4_096) return { valid: false };
	try {
		let value = JSON.parse(source) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false };
		let raw = (value as Record<string, unknown>).title;
		if (raw === undefined) return { valid: optional };
		let title = normalizedTitle(raw);
		return title !== undefined ? { valid: true, title } : { valid: false };
	} catch {
		return { valid: false };
	}
}

async function failure(err: unknown, _request: Request, auth: HostedAuth): Promise<Response> {
	if (err instanceof GitHubError) {
		if (err.status === 401) {
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
	session: AuthenticatedSession,
	owner: string,
	name: string,
): Promise<Repository> {
	if (!OWNER.test(owner) || !REPOSITORY.test(name)) {
		throw new GitHubError("repository not found", 404);
	}
	let result = await auth.sessions.use(
		session,
		token => auth.github.repositoryAccess(token, owner, name),
	);
	let repository = result.value;
	if (!repository) throw new GitHubError("repository not found", 404);
	return repository;
}

/** Enough editing sessions to cover a document's recent life without paging. */
const VERSION_LIMIT = 200;

/** The newest sessions History asks summaries for; the version-summary job accepts no more. */
const MAX_SUMMARIZED_VERSIONS = 20;

function versionAuthor(login: string, avatarUrl?: string) {
	return { login, ...(avatarUrl ? { avatarUrl } : {}) };
}

/** A channel the caller may read, or the response that refuses it. */
async function readableChannel(
	auth: HostedAuth,
	request: Request,
	id: string,
): Promise<ChannelRecord | Response> {
	let session = await auth.sessions.authenticate(request);
	if (!session) return json({ error: "authentication required" }, 401);
	if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
	let channel = await auth.storage.channels.get(id);
	if (!channel) return json({ error: "channel not found" }, 404);
	let repo = await authorizedRepository(
		auth,
		session,
		channel.repositoryOwner,
		channel.repositoryName,
	);
	return openedDocument(repo, channel) ? channel : json({ error: "channel not found" }, 404);
}

/** Opens a document only after its current repository identity has been revalidated. */
function openedDocument(
	repo: Repository,
	channel: ChannelRecord,
) {
	if (repo.id !== channel.repositoryId || !repo.permissions.pull) return undefined;
	let canManage = repo.permissions.push || repo.permissions.admin;
	return {
		repository: repository(repo),
		canEdit: canManage && !channel.archivedAt,
		canManage,
		channel: serialized(channel),
	};
}

/** Authenticated metadata routes; live collaboration is still the following stage. */
export function registerChannelRoutes(
	router: Router,
	auth: HostedAuth,
	options: {
		onAgentReset?: (channelId: string) => Promise<void>;
		onChannelArchived?: (channelId: string, now: Date) => Promise<ChannelArchiveResult>;
		onChannelDeleted?: (channelId: string) => Promise<boolean>;
		onChannelRenamed?: (channel: ChannelRecord) => void;
		renameChannel?: (id: string, title: string) => Promise<RenameResult>;
		onChannelRestored?: (channelId: string, now: Date) => Promise<ChannelArchiveResult>;
		/** Restores an earlier version's prose as a new edit by `author` (a user id). */
		onVersionRestore?: (
			channelId: string,
			source: string,
			author: string,
		) => Promise<
			| { kind: "restored"; revision: number }
			| { kind: "locked" }
			| { kind: "invalid"; message: string }
		>;
		/**
		 * Asks for one-line summaries of these sessions; "unavailable" when no Planner owner can
		 * write them now. Absent when the hosted agent or background jobs are off.
		 */
		onVersionSummaries?: (
			channelId: string,
			versions: { id: string; sourceHash: string }[],
		) => Promise<"pending" | "unavailable">;
		random?: () => number;
		references?: GitHubReferences;
	} = {},
): void {
	router.on(
		"GET",
		"/api/repositories/:owner/:repository/channels",
		async (request, url, params) => {
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let repo = await authorizedRepository(
					auth,
					session,
					params.owner!,
					params.repository!,
				);
				if (!repo.permissions.pull) {
					return json({ error: "repository read access is required" }, 403);
				}
				let requestedLimit = limit(url);
				let requestedQuery = query(url);
				let includeArchived = archived(url);
				let cursorValues = url.searchParams.getAll("cursor");
				let cursor = cursorValues.length <= 1 ? decoded(cursorValues[0] ?? null) : false;
				if (
					!requestedLimit || requestedQuery === false || includeArchived === undefined
					|| cursor === false
				) {
					return json({ error: "invalid channel pagination" }, 400);
				}
				if (
					cursor
					&& (cursor.query !== requestedQuery || cursor.includeArchived !== includeArchived)
				) {
					return json({ error: "invalid channel pagination" }, 400);
				}
				let activeCatalogue = !requestedQuery && !includeArchived;
				let [page, unansweredDecisions] = await Promise.all([
					auth.storage.channels.list(
						repo.id,
						requestedLimit,
						cursor?.cursor,
						requestedQuery || undefined,
						includeArchived,
					),
					activeCatalogue ? auth.storage.channels.unansweredDecisions(repo.id) : undefined,
				]);
				let canManage = repo.permissions.push || repo.permissions.admin;
				return json({
					repository: repository(repo),
					canEdit: canManage,
					channels: page.channels.map(serialized),
					nextCursor: page.next
						? encoded(page.next, requestedQuery, includeArchived)
						: undefined,
					...(unansweredDecisions === undefined ? {} : { unansweredDecisions }),
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
					session,
					params.owner!,
					params.repository!,
				);
				if (!repo.permissions.push && !repo.permissions.admin) {
					return json({ error: "repository write access is required" }, 403);
				}
				let title = await requestedTitle(request, true);
				if (!title.valid) {
					return json({ error: "title must be a string" }, 400);
				}
				let channel: ChannelRecord | undefined;
				let candidates = title.title === undefined
					? documentTitles(options.random)
					: [title.title];
				for (let candidate of candidates) {
					try {
						channel = await auth.storage.channels.create({
							id: newChannelId(repo.id),
							repositoryId: repo.id,
							repositoryOwner: repo.owner,
							repositoryName: repo.name,
							title: displayTitle(candidate),
							initial: await Plan.initial("", undefined, candidate),
							createdBy: session.user.id,
							now: auth.clock(),
						});
						break;
					} catch (err) {
						if (
							title.title !== undefined || !(err instanceof StorageError)
							|| err.failure !== "conflict"
						) {
							throw err;
						}
					}
				}
				if (!channel) throw new StorageError("conflict", "could not reserve a generated title");
				return json(
					{
						repository: repository(repo),
						canEdit: true,
						canManage: true,
						channel: serialized(channel),
					},
					201,
					undefined,
					documentPath(repo.owner, repo.name, channel.slug),
				);
			} catch (err) {
				return failure(err, request, auth);
			}
		},
	);

	router.on(
		"GET",
		"/api/repositories/:owner/:repository/documents/:slug",
		async (request, _url, params) => {
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let repo = await authorizedRepository(
					auth,
					session,
					params.owner!,
					params.repository!,
				);
				if (!repo.permissions.pull) return json({ error: "channel not found" }, 404);
				let channel = await auth.storage.channels.resolve(repo.id, documentSlug(params.slug!));
				if (!channel) return json({ error: "channel not found" }, 404);
				let opened = openedDocument(repo, channel);
				return opened ? json(opened) : json({ error: "channel not found" }, 404);
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
			if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
			let channel = await auth.storage.channels.get(id);
			if (!channel) return json({ error: "channel not found" }, 404);
			let repo = await authorizedRepository(
				auth,
				session,
				channel.repositoryOwner,
				channel.repositoryName,
			);
			let opened = openedDocument(repo, channel);
			return opened ? json(opened) : json({ error: "channel not found" }, 404);
		} catch (err) {
			return failure(err, request, auth);
		}
	});

	/** The document's editing sessions, newest first, for its Activity panel. */
	router.on("GET", "/api/channels/:channelId/versions", async (request, _url, params) => {
		try {
			let readable = await readableChannel(auth, request, params.channelId!);
			if (readable instanceof Response) return readable;
			let channel = readable;
			let [versions, creator] = await Promise.all([
				auth.storage.versions.list(channel.id, VERSION_LIMIT),
				auth.storage.users.get(channel.createdBy),
			]);
			return json({
				created: {
					at: channel.createdAt.toISOString(),
					...(creator ? { author: versionAuthor(creator.login, creator.avatarUrl) } : {}),
				},
				versions: versions.map(version => ({
					id: version.id,
					revision: version.revision,
					startedAt: version.startedAt.toISOString(),
					updatedAt: version.updatedAt.toISOString(),
					...(version.summary ? { summary: version.summary } : {}),
					...(version.authorLogin
						? { author: versionAuthor(version.authorLogin, version.authorAvatarUrl) }
						: {}),
				})),
			});
		} catch (err) {
			return failure(err, request, auth);
		}
	});

	router.on(
		"GET",
		"/api/channels/:channelId/versions/:versionId",
		async (request, _url, params) => {
			try {
				let readable = await readableChannel(auth, request, params.channelId!);
				if (readable instanceof Response) return readable;
				let version = await auth.storage.versions.get(readable.id, params.versionId!);
				if (!version) return json({ error: "version not found" }, 404);
				return json({
					id: version.id,
					revision: version.revision,
					updatedAt: version.updatedAt.toISOString(),
					source: version.source,
				});
			} catch (err) {
				return failure(err, request, auth);
			}
		},
	);

	/**
	 * Requests summaries for the newest sessions on show that have none, so History can fill its
	 * rows in. Any reader may ask: it changes no document, and one request per sessions-and-sources
	 * runs once.
	 */
	router.on(
		"POST",
		"/api/channels/:channelId/version-summaries",
		async (request, _url, params) => {
			if (request.headers.get("origin") !== auth.config.origin) {
				return json({ error: "origin is not allowed" }, 403);
			}
			try {
				let readable = await readableChannel(auth, request, params.channelId!);
				if (readable instanceof Response) return readable;
				if (!options.onVersionSummaries) return json({ state: "unavailable" });
				let wanted = (await auth.storage.versions.list(readable.id, MAX_SUMMARIZED_VERSIONS))
					.filter(version => !version.summary)
					.map(version => ({ id: version.id, sourceHash: version.sourceHash }));
				if (wanted.length === 0) return json({ state: "complete" });
				return json({ state: await options.onVersionSummaries(readable.id, wanted) });
			} catch (err) {
				return failure(err, request, auth);
			}
		},
	);

	router.on(
		"POST",
		"/api/channels/:channelId/versions/:versionId/restore",
		async (request, _url, params) => {
			if (request.headers.get("origin") !== auth.config.origin) {
				return json({ error: "origin is not allowed" }, 403);
			}
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let id = params.channelId!;
				if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
				let channel = await auth.storage.channels.get(id);
				if (!channel) return json({ error: "channel not found" }, 404);
				let repo = await authorizedRepository(
					auth,
					session,
					channel.repositoryOwner,
					channel.repositoryName,
				);
				if (!openedDocument(repo, channel)) return json({ error: "channel not found" }, 404);
				if (!repo.permissions.push && !repo.permissions.admin) {
					return json({ error: "repository write access is required" }, 403);
				}
				if (channel.archivedAt) return json({ error: "the document is archived" }, 409);
				if (!options.onVersionRestore) return json({ error: "restore is unavailable" }, 503);
				let version = await auth.storage.versions.get(channel.id, params.versionId!);
				if (!version) return json({ error: "version not found" }, 404);
				let result = await options.onVersionRestore(channel.id, version.source, session.user.id);
				if (result.kind === "locked") {
					return json({ error: "the document is locked by an active build" }, 409);
				}
				if (result.kind === "invalid") return json({ error: result.message }, 422);
				return json({ revision: result.revision });
			} catch (err) {
				return failure(err, request, auth);
			}
		},
	);

	let references = options.references;
	if (references) {
		router.on(
			"GET",
			"/api/channels/:channelId/github-references",
			async (request, url, params) => {
				try {
					let session = await auth.sessions.authenticate(request);
					if (!session) return json({ error: "authentication required" }, 401);
					let keys = [...new Set(url.searchParams.getAll("ref"))];
					let parsed = keys.map(parseGitHubReferenceKey);
					if (
						keys.length === 0 || keys.length > MAX_GITHUB_REFERENCES
						|| parsed.includes(undefined)
					) {
						return json({ error: "invalid GitHub references" }, 400);
					}
					let id = params.channelId!;
					if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
					let channel = await auth.storage.channels.get(id);
					if (!channel) return json({ error: "channel not found" }, 404);
					let repo = await authorizedRepository(
						auth,
						session,
						channel.repositoryOwner,
						channel.repositoryName,
					);
					if (repo.id !== channel.repositoryId || !repo.permissions.pull) {
						return json({ error: "channel not found" }, 404);
					}
					let { value } = await auth.sessions.use(
						session,
						token => references.resolve(token, parsed as GitHubReference[]),
					);
					let body: GitHubReferencesResponse = {
						references: Object.fromEntries(keys.map((key, index) => [key, value[index]!])),
					};
					return json(body);
				} catch (err) {
					return failure(err, request, auth);
				}
			},
		);
	}

	router.on("PATCH", "/api/channels/:channelId", async (request, _url, params) => {
		if (request.headers.get("origin") !== auth.config.origin) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let id = params.channelId!;
			if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
			let channel = await auth.storage.channels.get(id);
			if (!channel) return json({ error: "channel not found" }, 404);
			let repo = await authorizedRepository(
				auth,
				session,
				channel.repositoryOwner,
				channel.repositoryName,
			);
			if (repo.id !== channel.repositoryId || !repo.permissions.pull) {
				return json({ error: "channel not found" }, 404);
			}
			if (!repo.permissions.push && !repo.permissions.admin) {
				return json({ error: "repository write access is required" }, 403);
			}
			let requested = await requestedTitle(request, false);
			if (!requested.valid || requested.title === undefined) {
				return json({ error: "title must be a string" }, 400);
			}
			if (!options.renameChannel) {
				throw new StorageError("unavailable", "document rename is unavailable");
			}
			let renamed = await options.renameChannel(id, requested.title);
			if (renamed.changed) options.onChannelRenamed?.(renamed.channel);
			return json({
				repository: repository(repo),
				canEdit: true,
				canManage: true,
				channel: serialized(renamed.channel),
			});
		} catch (err) {
			if (err instanceof Plan.ImplementationActiveError) {
				return json({ error: "document editing is locked during implementation" }, 409);
			}
			if (err instanceof StorageError && err.failure === "conflict") {
				return json({ error: "document cannot be renamed in its current state" }, 409);
			}
			return failure(err, request, auth);
		}
	});

	let registerArchiveTransition = (
		path: string,
		action: "archive" | "restore",
	) => {
		router.on("POST", path, async (request, _url, params) => {
			if (request.headers.get("origin") !== auth.config.origin) {
				return json({ error: "origin is not allowed" }, 403);
			}
			try {
				let session = await auth.sessions.authenticate(request);
				if (!session) return json({ error: "authentication required" }, 401);
				let id = params.channelId!;
				if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
				let channel = await auth.storage.channels.get(id);
				if (!channel) return json({ error: "channel not found" }, 404);
				let repo = await authorizedRepository(
					auth,
					session,
					channel.repositoryOwner,
					channel.repositoryName,
				);
				if (repo.id !== channel.repositoryId || !repo.permissions.pull) {
					return json({ error: "channel not found" }, 404);
				}
				if (!repo.permissions.push && !repo.permissions.admin) {
					return json({ error: "repository write access is required" }, 403);
				}
				let now = auth.clock();
				let result = action === "archive"
					? await (options.onChannelArchived
						? options.onChannelArchived(id, now)
						: auth.storage.channels.archive({ id, now }))
					: await (options.onChannelRestored
						? options.onChannelRestored(id, now)
						: auth.storage.channels.restore({ id, now }));
				let opened = openedDocument(repo, result.channel);
				if (!opened) return json({ error: "channel not found" }, 404);
				let unansweredDecisions = await auth.storage.channels.unansweredDecisions(repo.id);
				return json({ ...opened, unansweredDecisions });
			} catch (err) {
				return failure(err, request, auth);
			}
		});
	};
	registerArchiveTransition("/api/channels/:channelId/archive", "archive");
	registerArchiveTransition("/api/channels/:channelId/restore", "restore");

	router.on("DELETE", "/api/channels/:channelId", async (request, _url, params) => {
		if (request.headers.get("origin") !== auth.config.origin) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let id = params.channelId!;
			if (!isChannelId(id)) return json({ error: "channel not found" }, 404);
			let channel = await auth.storage.channels.get(id);
			if (!channel) return json({ error: "channel not found" }, 404);
			let repo = await authorizedRepository(
				auth,
				session,
				channel.repositoryOwner,
				channel.repositoryName,
			);
			if (repo.id !== channel.repositoryId || !repo.permissions.pull) {
				return json({ error: "channel not found" }, 404);
			}
			if (!repo.permissions.push && !repo.permissions.admin) {
				return json({ error: "repository write access is required" }, 403);
			}
			if (!channel.archivedAt) {
				return json({ error: "document must be archived before deletion" }, 409);
			}
			let deleted = options.onChannelDeleted
				? await options.onChannelDeleted(id)
				: await auth.storage.channels.delete(id);
			return deleted
				? new Response(null, { status: 204, headers: { "cache-control": "no-store" } })
				: json({ error: "channel not found" }, 404);
		} catch (err) {
			return failure(err, request, auth);
		}
	});

	router.on("POST", "/api/channels/:channelId/agent/reset", async (request, _url, params) => {
		if (request.headers.get("origin") !== auth.config.origin) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let channel = await auth.storage.channels.get(params.channelId!);
			if (!channel) return json({ error: "channel not found" }, 404);
			let repo = await authorizedRepository(
				auth,
				session,
				channel.repositoryOwner,
				channel.repositoryName,
			);
			if (
				repo.id !== channel.repositoryId
				|| (!repo.permissions.push && !repo.permissions.admin)
			) return json({ error: "repository write access is required" }, 403);
			let stored = await auth.storage.collaboration.load(channel.id, auth.clock());
			let owner = stored?.agent;
			if (owner?.ownerSessionId) {
				await auth.storage.channels.clearAgentOwner(
					channel.id,
					owner.ownerSessionId,
					owner.generation,
					auth.clock(),
				);
			}
			await options.onAgentReset?.(channel.id);
			return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
		} catch (err) {
			return failure(err, request, auth);
		}
	});
}
