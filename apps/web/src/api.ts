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
	title: string;
	createdBy: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
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

export type ChannelPage = {
	repository: Repository;
	canEdit: boolean;
	channels: Channel[];
	nextCursor?: string;
};

export type ChannelDetail = {
	repository: Repository;
	canEdit: boolean;
	channel: Channel;
};

export class ApiError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}

async function response<T>(path: string, init?: RequestInit): Promise<T> {
	let result = await fetch(path, init);
	let value: unknown;
	try {
		value = await result.json();
	} catch {
		value = undefined;
	}
	if (!result.ok) {
		if (result.status === 401 && typeof location !== "undefined") location.assign("/");
		let message = value && typeof value === "object" && "error" in value
				&& typeof value.error === "string"
			? value.error
			: `request failed (${result.status})`;
		throw new ApiError(message, result.status);
	}
	return value as T;
}

export function session(): Promise<Session> {
	return response("/api/session");
}

export function installations(page = 1): Promise<InstallationPage> {
	return response(`/api/github/installations?page=${page}`);
}

export function installationRepositories(
	installationId: string,
	page = 1,
): Promise<RepositoryPage> {
	return response(
		`/api/github/installations/${encodeURIComponent(installationId)}/repositories?page=${page}`,
	);
}

export function channels(
	owner: string,
	repository: string,
	cursor?: string,
	query?: string,
): Promise<ChannelPage> {
	let parameters = new URLSearchParams();
	if (cursor) parameters.set("cursor", cursor);
	if (query) parameters.set("query", query);
	let suffix = parameters.size ? `?${parameters}` : "";
	return response(
		`/api/repositories/${encodeURIComponent(owner)}/${
			encodeURIComponent(repository)
		}/channels${suffix}`,
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

export function channel(id: string): Promise<ChannelDetail> {
	return response(`/api/channels/${encodeURIComponent(id)}`);
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
