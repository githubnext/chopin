import { safeSessionStorage } from "@chopin/editor/browser-storage";

// The snapshot reader and validators live in repository-snapshot.ts so the initial bundle
// can clear the cache without loading the repository picker's code.
export const ACTIVE_USER_KEY = "chopin:repositories:active-user";

export function cacheKey(userId: string): string {
	return `chopin:repositories:${encodeURIComponent(userId)}`;
}

export function clearRepositoryCache(userId?: string): void {
	let active = safeSessionStorage.getItem(ACTIVE_USER_KEY) ?? undefined;
	let target = userId ?? active;
	if (target) safeSessionStorage.removeItem(cacheKey(target));
	if (!userId || active === userId) safeSessionStorage.removeItem(ACTIVE_USER_KEY);
}
