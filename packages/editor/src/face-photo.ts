/**
 * Where a face's photograph comes from, and what becomes of one that will not load.
 *
 * The sources are tried best first: the roster's picture for a demo actor, else the picture GitHub's
 * API returned when the person signed in (always right, including for accounts whose
 * `github.com/<login>.png` does not resolve, such as Enterprise Managed Users), else the guess
 * from the login, else nothing, and the face is the person's initial. Which have failed is
 * remembered by source rather than by position, so a stored picture that arrives after the guess
 * was tried is tried in its turn.
 */

import { avatarOf, isDemoHandle, profiles } from "./people";

/** Retina-sharp at the rendered size. */
function photograph(handle: string, size: number): string {
	return `https://github.com/${encodeURIComponent(handle)}.png?size=${size * 2}`;
}

export function faceSources(
	handle: string,
	size: number,
	stored: string | undefined = avatarOf(handle),
): string[] {
	let local = profiles.get(handle)?.avatar;
	if (local) return [local];
	if (isDemoHandle(handle)) return [];
	return stored ? [stored, photograph(handle, size)] : [photograph(handle, size)];
}

export type Photo = { failed: readonly string[]; loaded?: string | undefined };

export type PhotoEvent = { kind: "failed" | "loaded"; source: string };

export function nextPhoto(photo: Photo, event: PhotoEvent): Photo {
	if (event.kind === "loaded") return { ...photo, loaded: event.source };
	return photo.failed.includes(event.source)
		? photo
		: { ...photo, failed: [...photo.failed, event.source] };
}

/** The first source that has not failed; none means the face stays its initial. */
export function photoSource(sources: readonly string[], photo: Photo): string | undefined {
	return sources.find(source => !photo.failed.includes(source));
}

/** A source is shown only once it has loaded itself, so a half-fetched one never covers the initial. */
export function photoShown(photo: Photo, source: string | undefined): boolean {
	return source !== undefined && photo.loaded === source;
}
