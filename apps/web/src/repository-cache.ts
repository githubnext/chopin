import * as Api from "./api";

const ACTIVE_USER_KEY = "chopin:repositories:active-user";
const CACHE_VERSION = 1;
const FRESH_MS = 30_000;
const MAX_LIST_PAGES = 100;

type CachedPage<T> = {
	page: number;
	etag?: string;
	value: T;
};

export type RepositorySnapshot = {
	version: typeof CACHE_VERSION;
	userId: string;
	validatedAt: number;
	installationPages: CachedPage<Api.InstallationPage>[];
	repositoryPages: Record<string, CachedPage<Api.RepositoryPage>[]>;
};

export type InstalledRepositoryGroup = {
	installation: Api.GitHubInstallation;
	repositories: Api.Repository[];
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function nextPage(value: unknown): boolean {
	return value === undefined || (Number.isSafeInteger(value) && Number(value) > 0);
}

function repository(value: unknown): value is Api.Repository {
	let item = record(value);
	let permissions = record(item?.permissions);
	return !!item
		&& typeof item.id === "string"
		&& typeof item.owner === "string"
		&& (item.ownerAvatarUrl === undefined || typeof item.ownerAvatarUrl === "string")
		&& typeof item.name === "string"
		&& typeof item.fullName === "string"
		&& typeof item.private === "boolean"
		&& typeof item.url === "string"
		&& typeof item.defaultBranch === "string"
		&& !!permissions
		&& typeof permissions.pull === "boolean"
		&& typeof permissions.push === "boolean"
		&& typeof permissions.admin === "boolean";
}

function installation(value: unknown): value is Api.GitHubInstallation {
	let item = record(value);
	let account = record(item?.account);
	let permissions = record(item?.permissions);
	return !!item
		&& typeof item.id === "string"
		&& !!account
		&& typeof account.login === "string"
		&& typeof account.avatarUrl === "string"
		&& (account.type === "user" || account.type === "organization")
		&& (item.repositorySelection === "all" || item.repositorySelection === "selected")
		&& typeof item.configureUrl === "string"
		&& typeof item.suspended === "boolean"
		&& !!permissions
		&& typeof permissions.contents === "boolean"
		&& typeof permissions.pullRequests === "boolean"
		&& typeof permissions.checks === "boolean"
		&& typeof permissions.statuses === "boolean";
}

function installationPage(value: unknown): value is Api.InstallationPage {
	let item = record(value);
	return !!item
		&& Array.isArray(item.installations)
		&& item.installations.every(installation)
		&& nextPage(item.nextPage);
}

function repositoryPage(value: unknown): value is Api.RepositoryPage {
	let item = record(value);
	return !!item
		&& Array.isArray(item.repositories)
		&& item.repositories.every(repository)
		&& nextPage(item.nextPage);
}

function cachedPages<T extends { nextPage?: number }>(
	value: unknown,
	valid: (value: unknown) => value is T,
): CachedPage<T>[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_PAGES) {
		return undefined;
	}
	let pages: CachedPage<T>[] = [];
	for (let candidate of value) {
		let item = record(candidate);
		if (
			!item
			|| !Number.isSafeInteger(item.page)
			|| Number(item.page) < 1
			|| (item.etag !== undefined && typeof item.etag !== "string")
			|| !valid(item.value)
		) return undefined;
		pages.push({
			page: Number(item.page),
			...(typeof item.etag === "string" ? { etag: item.etag } : {}),
			value: item.value,
		});
	}
	let expected = 1;
	let visited = new Set<number>();
	for (let [index, page] of pages.entries()) {
		if (page.page !== expected || visited.has(page.page)) return undefined;
		visited.add(page.page);
		if (!page.value.nextPage) return index === pages.length - 1 ? pages : undefined;
		expected = page.value.nextPage;
	}
	return undefined;
}

function cacheKey(userId: string): string {
	return `chopin:repositories:${encodeURIComponent(userId)}`;
}

function storage(): Storage | undefined {
	try {
		return globalThis.sessionStorage;
	} catch {
		return undefined;
	}
}

export function clearRepositoryCache(userId?: string): void {
	let store = storage();
	if (!store) return;
	try {
		let active = store.getItem(ACTIVE_USER_KEY) ?? undefined;
		let target = userId ?? active;
		if (target) store.removeItem(cacheKey(target));
		if (!userId || active === userId) store.removeItem(ACTIVE_USER_KEY);
	} catch {
		// Storage may be disabled; repository loading still works in memory.
	}
}

export function readRepositoryCache(userId: string): RepositorySnapshot | undefined {
	let store = storage();
	if (!store) return undefined;
	let key = cacheKey(userId);
	try {
		let active = store.getItem(ACTIVE_USER_KEY);
		if (active && active !== userId) store.removeItem(cacheKey(active));
		store.setItem(ACTIVE_USER_KEY, userId);
		let serialized = store.getItem(key);
		if (!serialized) return undefined;
		let item = record(JSON.parse(serialized));
		let installations = cachedPages(item?.installationPages, installationPage);
		let storedRepositories = record(item?.repositoryPages);
		if (
			!item
			|| item.version !== CACHE_VERSION
			|| item.userId !== userId
			|| typeof item.validatedAt !== "number"
			|| !Number.isFinite(item.validatedAt)
			|| item.validatedAt < 0
			|| !installations
			|| !storedRepositories
		) throw new Error("invalid repository cache");
		let repositories: Record<string, CachedPage<Api.RepositoryPage>[]> = {};
		for (let [installationId, value] of Object.entries(storedRepositories)) {
			if (!/^\d+$/.test(installationId)) throw new Error("invalid repository cache");
			let pages = cachedPages(value, repositoryPage);
			if (!pages) throw new Error("invalid repository cache");
			repositories[installationId] = pages;
		}
		let snapshot: RepositorySnapshot = {
			version: CACHE_VERSION,
			userId,
			validatedAt: item.validatedAt,
			installationPages: installations,
			repositoryPages: repositories,
		};
		let expected = new Set(
			installationsFor(snapshot)
				.filter(value => !value.suspended && value.permissions.contents)
				.map(value => value.id),
		);
		if (
			[...expected].some(installationId => !Object.hasOwn(repositories, installationId))
			|| Object.keys(repositories).some(installationId => !expected.has(installationId))
		) throw new Error("invalid repository cache");
		return snapshot;
	} catch {
		try {
			store.removeItem(key);
		} catch {
			// Ignore storage failures and load from the network.
		}
		return undefined;
	}
}

export function writeRepositoryCache(snapshot: RepositorySnapshot): void {
	let store = storage();
	if (!store) return;
	try {
		store.setItem(ACTIVE_USER_KEY, snapshot.userId);
		store.setItem(cacheKey(snapshot.userId), JSON.stringify(snapshot));
	} catch {
		// Quota or privacy restrictions should not break repository selection.
	}
}

export function repositoryCacheIsStale(snapshot: RepositorySnapshot, now = Date.now()): boolean {
	return now - snapshot.validatedAt >= FRESH_MS;
}

async function pages<T extends { nextPage?: number }>(
	previous: CachedPage<T>[] | undefined,
	request: (page: number, etag?: string) => Promise<Api.ValidatedPage<T>>,
	publish?: (pages: CachedPage<T>[]) => void,
): Promise<CachedPage<T>[]> {
	let result: CachedPage<T>[] = [];
	let page = 1;
	let visited = new Set<number>();
	while (!visited.has(page)) {
		if (visited.size >= MAX_LIST_PAGES) {
			throw new Error("Repository listing exceeded its safety limit.");
		}
		visited.add(page);
		let known = previous?.find(value => value.page === page);
		let response = await request(page, known?.etag);
		let loaded: CachedPage<T>;
		if ("notModified" in response) {
			if (!known) throw new Error("GitHub returned an unexpected not-modified response.");
			loaded = { ...known, etag: response.etag ?? known.etag };
		} else {
			loaded = {
				page,
				...(response.etag ? { etag: response.etag } : {}),
				value: response.page,
			};
		}
		result.push(loaded);
		publish?.([...result]);
		if (!loaded.value.nextPage) return result;
		page = loaded.value.nextPage;
	}
	throw new Error("Repository listing returned a pagination cycle.");
}

function installationsFor(snapshot: RepositorySnapshot): Api.GitHubInstallation[] {
	let result: Api.GitHubInstallation[] = [];
	let known = new Set<string>();
	for (let installation of snapshot.installationPages.flatMap(page => page.value.installations)) {
		if (known.has(installation.id)) continue;
		known.add(installation.id);
		result.push(installation);
	}
	return result;
}

export function installedRepositoryGroups(
	snapshot: RepositorySnapshot,
): InstalledRepositoryGroup[] {
	return installationsFor(snapshot).map(installation => {
		let repositories: Api.Repository[] = [];
		let known = new Set<string>();
		for (
			let repository of (snapshot.repositoryPages[installation.id] ?? [])
				.flatMap(page => page.value.repositories)
		) {
			if (known.has(repository.id)) continue;
			known.add(repository.id);
			repositories.push(repository);
		}
		return { installation, repositories };
	});
}

export async function loadRepositorySnapshot(
	userId: string,
	previous?: RepositorySnapshot,
	publish?: (snapshot: RepositorySnapshot) => void,
): Promise<RepositorySnapshot> {
	let installationPages = await pages(
		previous?.installationPages,
		(page, etag) => Api.installations(page, etag),
	);
	let repositoryPages: Record<string, CachedPage<Api.RepositoryPage>[]> = {};
	let partial = (): RepositorySnapshot => ({
		version: CACHE_VERSION,
		userId,
		validatedAt: 0,
		installationPages,
		repositoryPages,
	});
	publish?.(partial());
	let failure: unknown;
	for (let installed of installationsFor(partial())) {
		if (installed.suspended || !installed.permissions.contents) continue;
		try {
			let loaded = await pages(
				previous?.repositoryPages[installed.id],
				(page, etag) => Api.installationRepositories(installed.id, page, etag),
				value => {
					repositoryPages[installed.id] = value;
					publish?.(partial());
				},
			);
			repositoryPages[installed.id] = loaded;
		} catch (reason) {
			if (reason instanceof Api.ApiError && (reason.status === 401 || reason.status === 429)) {
				throw reason;
			}
			failure ??= reason ?? new Error("Could not load all repositories.");
		}
	}
	// Never replace a complete cached snapshot with a partially refreshed one.
	if (failure) throw failure;
	return { ...partial(), validatedAt: Date.now() };
}
