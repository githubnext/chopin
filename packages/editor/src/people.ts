export type FaceProfile = { name: string; avatar: string };

const DEMO_PREFIX = "demo:";
export let profiles = new Map<string, FaceProfile>();

/** Server-owned roster profiles, keyed by their IDs; `handle` is the ID for a demo actor. */
export function setFaceProfiles(list: readonly (FaceProfile & { id: string })[]): void {
	profiles = new Map(list.map(({ id, ...profile }) => [id, profile]));
}

/** A roster ID is never a GitHub login, so it must never reach github.com. */
export function isDemoHandle(handle: string): boolean {
	return handle.startsWith(DEMO_PREFIX);
}

/** What a person is called: a roster name for a demo actor, otherwise the handle. */
export function personName(handle: string): string {
	let profile = profiles.get(handle);
	if (profile) return profile.name;
	return isDemoHandle(handle) ? handle.slice(DEMO_PREFIX.length) || handle : handle;
}
