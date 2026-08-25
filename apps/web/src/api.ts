import type { Research } from "@chopin/protocol";

export type User = {
	id: string;
	login: string;
	avatarUrl: string;
};

export type Session = {
	user: User | null;
	agent: boolean;
	installUrl?: string;
	expiresAt?: string;
};

export type Repository = {
	id: string;
	owner: string;
	ownerAvatarUrl?: string;
	name: string;
	fullName: string;
	private: boolean;
	url: string;
	defaultBranch: string;
	permissions: { pull: boolean; push: boolean; admin: boolean };
};

export type Channel = {
	id: string;
	repositoryId: string;
	repositoryOwner: string;
	repositoryName: string;
	parentChannelId?: string;
	title: string;
	slug: string;
	createdBy: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	descriptionRevision: number;
	description?: string;
	archivedAt?: string;
};

export type RepositoryPage = {
	repositories: Repository[];
	nextPage?: number;
};

export type GitHubInstallation = {
	id: string;
	account: {
		login: string;
		avatarUrl: string;
		type: "user" | "organization";
	};
	repositorySelection: "all" | "selected";
	configureUrl: string;
	suspended: boolean;
	permissions: {
		contents: boolean;
		pullRequests: boolean;
		checks: boolean;
		statuses: boolean;
	};
};

export type InstallationPage = {
	installations: GitHubInstallation[];
	nextPage?: number;
};

export type ValidatedPage<T> =
	| { page: T; etag?: string }
	| { notModified: true; etag?: string };

export type ChannelPage = {
	repository: Repository;
	canEdit: boolean;
	channels: Channel[];
	nextCursor?: string;
};

export type ChannelDetail = {
	repository: Repository;
	canEdit: boolean;
	canManage: boolean;
	channel: Channel;
};

export type ChannelListOptions = {
	cursor?: string;
	query?: string;
	includeArchived?: boolean;
	signal?: AbortSignal;
};

export type ResearchParentChannel = Pick<
	Channel,
	"id" | "repositoryId" | "repositoryOwner" | "repositoryName" | "title" | "slug"
>;

export type NavigationRepository = Pick<
	Repository,
	"id" | "owner" | "name" | "fullName" | "ownerAvatarUrl" | "permissions"
>;

export type NavigationProject = {
	repositoryId: string;
	repositoryOwner: string;
	repositoryName: string;
	position: number;
	available: boolean;
	repository?: NavigationRepository;
};

export type Navigation = {
	projects: NavigationProject[];
	lastDocumentId?: string;
};

export class ApiError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

async function decoded<T>(result: Response): Promise<T> {
	let value: unknown;
	try {
		value = await result.json();
	} catch {
		value = undefined;
	}
	if (!result.ok) {
		if (result.status === 401 && typeof location !== "undefined") location.reload();
		let message = value && typeof value === "object" && "error" in value
				&& typeof value.error === "string"
			? value.error
			: `request failed (${result.status})`;
		throw new ApiError(message, result.status);
	}
	return value as T;
}

async function response<T>(path: string, init?: RequestInit): Promise<T> {
	return decoded(await fetch(path, init));
}

async function validatedPage<T>(path: string, ifNoneMatch?: string): Promise<ValidatedPage<T>> {
	let result = await fetch(path, {
		headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : undefined,
	});
	let etag = result.headers.get("etag") ?? undefined;
	if (result.status === 304) return { notModified: true, ...(etag ? { etag } : {}) };
	return { page: await decoded<T>(result), ...(etag ? { etag } : {}) };
}

export function session(): Promise<Session> {
	return response("/api/session");
}

export function navigation(): Promise<Navigation> {
	return response("/api/navigation");
}

export function addProject(owner: string, repository: string): Promise<NavigationProject> {
	return response("/api/navigation/projects", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ owner, repository }),
	});
}

export function installations(
	page = 1,
	ifNoneMatch?: string,
): Promise<ValidatedPage<InstallationPage>> {
	return validatedPage(`/api/github/installations?page=${page}`, ifNoneMatch);
}

export function installationRepositories(
	installationId: string,
	page = 1,
	ifNoneMatch?: string,
): Promise<ValidatedPage<RepositoryPage>> {
	return validatedPage(
		`/api/github/installations/${encodeURIComponent(installationId)}/repositories?page=${page}`,
		ifNoneMatch,
	);
}

export function channels(
	owner: string,
	repository: string,
	options: ChannelListOptions = {},
): Promise<ChannelPage> {
	let parameters = new URLSearchParams();
	if (options.cursor) parameters.set("cursor", options.cursor);
	if (options.query) parameters.set("query", options.query);
	if (options.includeArchived) parameters.set("includeArchived", "true");
	let suffix = parameters.size ? `?${parameters}` : "";
	return response(
		`/api/repositories/${encodeURIComponent(owner)}/${
			encodeURIComponent(repository)
		}/channels${suffix}`,
		{ signal: options.signal },
	);
}

export function createChannel(
	owner: string,
	repository: string,
	title?: string,
): Promise<ChannelDetail> {
	return response(
		`/api/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/channels`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(title === undefined ? {} : { title }),
		},
	);
}

export function channel(id: string, signal?: AbortSignal): Promise<ChannelDetail> {
	return response(`/api/channels/${encodeURIComponent(id)}`, { signal });
}

export function document(
	owner: string,
	repository: string,
	slug: string,
	signal?: AbortSignal,
): Promise<ChannelDetail> {
	return response(
		`/api/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/documents/${
			encodeURIComponent(slug)
		}`,
		{ signal },
	);
}

export function visitDocument(documentId: string): Promise<void> {
	return response("/api/navigation", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ documentId }),
		keepalive: true,
	});
}

function researchRequestPath(channelId: string, requestId?: string): string {
	let path = `/api/channels/${encodeURIComponent(channelId)}/research-requests`;
	return requestId ? `${path}/${encodeURIComponent(requestId)}` : path;
}

export function createResearchRequest(
	channelId: string,
	question: string,
	requestId: string,
): Promise<{ request: Research.RequestView; repeated: boolean }> {
	return response(researchRequestPath(channelId), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ question, requestId }),
	});
}

export function researchRequest(
	channelId: string,
	requestId: string,
	signal?: AbortSignal,
): Promise<Research.RequestView> {
	return response(researchRequestPath(channelId, requestId), { signal });
}

export function cancelResearchRequest(
	channelId: string,
	requestId: string,
): Promise<Research.RequestView> {
	return response(`${researchRequestPath(channelId, requestId)}/cancel`, { method: "POST" });
}

export function retryResearchRequest(
	channelId: string,
	requestId: string,
): Promise<Research.RequestView> {
	return response(`${researchRequestPath(channelId, requestId)}/retry`, { method: "POST" });
}

export function renameChannel(id: string, title: string): Promise<ChannelDetail> {
	return response(`/api/channels/${encodeURIComponent(id)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ title }),
	});
}

export function archiveChannel(id: string): Promise<ChannelDetail> {
	return response(`/api/channels/${encodeURIComponent(id)}/archive`, { method: "POST" });
}

export function restoreChannel(id: string): Promise<ChannelDetail> {
	return response(`/api/channels/${encodeURIComponent(id)}/restore`, { method: "POST" });
}

export function deleteChannel(id: string): Promise<void> {
	return response(`/api/channels/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function resetAgent(id: string): Promise<void> {
	let result = await fetch(`/api/channels/${encodeURIComponent(id)}/agent/reset`, {
		method: "POST",
	});
	if (!result.ok) throw new ApiError(`agent reset failed (${result.status})`, result.status);
}

export async function logout(): Promise<void> {
	let result = await fetch("/auth/logout", { method: "POST" });
	if (!result.ok) throw new ApiError(`logout failed (${result.status})`, result.status);
}
