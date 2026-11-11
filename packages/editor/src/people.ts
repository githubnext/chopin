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

/**
 * The pictures GitHub gave real people, which the server stored when they signed in, by login.
 *
 * One map for the whole page, filled from every place the server names a person, so any face for
 * any login finds its picture without asking. It only ever grows: a person who left the room is
 * still the author of what they said. Logins compare case-insensitively, as GitHub's do. A demo
 * actor is never here; its picture is the roster's.
 */
const avatars = new Map<string, string>();
const listeners = new Set<() => void>();

/** A person as the server names them; a login with no stored picture teaches nothing. */
export type KnownPerson = { login: string; avatarUrl?: string | null | undefined };

export function rememberAvatars(people: readonly KnownPerson[]): void {
	let learned = false;
	for (let { login, avatarUrl } of people) {
		if (!avatarUrl || isDemoHandle(login)) continue;
		let key = login.toLowerCase();
		if (avatars.get(key) === avatarUrl) continue;
		avatars.set(key, avatarUrl);
		learned = true;
	}
	if (learned) { for (let listener of listeners) listener(); }
}

/** The picture the server stored for this login, if it has told this page. */
export function avatarOf(login: string): string | undefined {
	return avatars.get(login.toLowerCase());
}

/** For `useSyncExternalStore`: called whenever a picture is learned or replaced. */
export function subscribeAvatars(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
