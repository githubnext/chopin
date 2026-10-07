// The snapshot reader and validators live in repository-snapshot.ts so the initial bundle
// can clear the cache without loading the repository picker's code.
export const ACTIVE_USER_KEY = "chopin:repositories:active-user";

export function cacheKey(userId: string): string {
	return `chopin:repositories:${encodeURIComponent(userId)}`;
}

export function storage(): Storage | undefined {
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
