import { GitHubError } from "../github/client";
import { StorageError } from "../storage/errors";

import type { HostedAuth } from "../auth/routes";
import type { AuthenticatedSession } from "../auth/session";
import type { Repository } from "../github/client";
import type { Router } from "../http/router";
import type { UserProject } from "../storage/model";
import type { StorageAdapter } from "../storage/port";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const BODY_LIMIT = 4_096;

export type NavigationProject = {
	repositoryId: string;
	repositoryOwner: string;
	repositoryName: string;
	position: number;
	available: boolean;
	repository?: {
		id: string;
		owner: string;
		name: string;
		fullName: string;
		ownerAvatarUrl?: string;
		permissions: { pull: boolean; push: boolean; admin: boolean };
	};
};

export type NavigationResponse = {
	projects: NavigationProject[];
	lastDocumentId?: string;
};

function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "application/json; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

function empty(status: number): Response {
	return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

function failure(err: unknown): Response {
	if (err instanceof GitHubError) {
		if (err.status === 401) {
			return json({ error: "GitHub authorization expired" }, 401);
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
			{ error: status === 503 ? "storage is unavailable" : "navigation storage failed" },
			status,
		);
	}
	return json({ error: "request failed" }, 500);
}

function serialized(project: UserProject, repository?: Repository): NavigationProject {
	return {
		repositoryId: project.repositoryId,
		repositoryOwner: project.repositoryOwner,
		repositoryName: project.repositoryName,
		position: project.position,
		available: Boolean(repository),
		...(repository
			? {
				repository: {
					id: repository.id,
					owner: repository.owner,
					name: repository.name,
					fullName: repository.fullName,
					...(repository.ownerAvatarUrl
						? { ownerAvatarUrl: repository.ownerAvatarUrl }
						: {}),
					permissions: repository.permissions,
				},
			}
			: {}),
	};
}

async function body(request: Request): Promise<Record<string, unknown> | undefined> {
	let length = Number(request.headers.get("content-length") || "0");
	if (Number.isFinite(length) && length > BODY_LIMIT) return undefined;
	let source = await request.text();
	if (new TextEncoder().encode(source).length > BODY_LIMIT) return undefined;
	try {
		let value = JSON.parse(source) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? value as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

async function accessible(
	auth: HostedAuth,
	session: AuthenticatedSession,
	project: UserProject,
): Promise<Repository | undefined> {
	let result = await auth.sessions.use(
		session,
		token => auth.github.repositoryAccess(token, project.repositoryOwner, project.repositoryName),
	);
	let repository = result.value;
	return repository && repository.id === project.repositoryId && repository.permissions.pull
		? repository
		: undefined;
}

async function response(
	auth: HostedAuth,
	storage: StorageAdapter,
	session: AuthenticatedSession,
): Promise<NavigationResponse> {
	let stored = await storage.navigation.projects(session.user.id);
	let available = new Map<string, Repository>();
	let resolved = await Promise.all(stored.map(async project => ({
		project,
		repository: await accessible(auth, session, project),
	})));
	let projects = resolved.map(({ project, repository }) => {
		if (repository) available.set(project.repositoryId, repository);
		return serialized(project, repository);
	});

	let navigation = await storage.navigation.get(session.user.id);
	let selected = navigation?.lastDocumentId;
	if (selected) {
		let channel = await storage.channels.get(selected);
		if (!channel || !available.has(channel.repositoryId)) selected = undefined;
	}
	if (!selected) {
		for (let project of stored) {
			if (!available.has(project.repositoryId)) continue;
			let first = await storage.channels.list(project.repositoryId, 1);
			if (first.channels[0]) {
				selected = first.channels[0].id;
				break;
			}
		}
	}
	if (selected !== navigation?.lastDocumentId) {
		await storage.navigation.setLastDocument(session.user.id, selected, auth.clock());
	}
	return { projects, ...(selected ? { lastDocumentId: selected } : {}) };
}

/** Persistent user navigation, revalidated against GitHub on every read. */
export function registerNavigationRoutes(
	router: Router,
	auth: HostedAuth,
	options: { storage?: StorageAdapter } = {},
): void {
	let storage = options.storage ?? auth.storage;

	router.on("GET", "/api/navigation", async request => {
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			return json(await response(auth, storage, session));
		} catch (err) {
			return failure(err);
		}
	});

	router.on("POST", "/api/navigation/projects", async request => {
		if (request.headers.get("origin") !== auth.config.origin) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let input = await body(request);
			let owner = input?.owner;
			let name = input?.repository;
			if (
				typeof owner !== "string" || typeof name !== "string" || !OWNER.test(owner)
				|| !REPOSITORY.test(name)
			) return json({ error: "owner and repository are required" }, 400);
			let result = await auth.sessions.use(
				session,
				token => auth.github.repositoryAccess(token, owner, name),
			);
			let repository = result.value;
			if (!repository) return json({ error: "repository not found" }, 404);
			if (!repository.permissions.pull) {
				return json({ error: "repository read access is required" }, 403);
			}
			let added = await storage.navigation.addProject({
				userId: session.user.id,
				repositoryId: repository.id,
				repositoryOwner: repository.owner,
				repositoryName: repository.name,
				now: auth.clock(),
			});
			return json(serialized(added.project, repository), added.added ? 201 : 200);
		} catch (err) {
			return failure(err);
		}
	});

	router.on("PATCH", "/api/navigation", async request => {
		if (request.headers.get("origin") !== auth.config.origin) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let input = await body(request);
			let documentId = input?.documentId;
			if (typeof documentId !== "string" || documentId.length === 0) {
				return json({ error: "documentId is required" }, 400);
			}
			let channel = await storage.channels.get(documentId);
			if (!channel) return json({ error: "document not found" }, 404);
			let project = (await storage.navigation.projects(session.user.id))
				.find(value => value.repositoryId === channel.repositoryId);
			if (!project) return json({ error: "document not found" }, 404);
			let repository = await accessible(auth, session, project);
			if (!repository) return json({ error: "document not found" }, 404);
			await storage.navigation.setLastDocument(session.user.id, channel.id, auth.clock());
			return empty(204);
		} catch (err) {
			return failure(err);
		}
	});
}
