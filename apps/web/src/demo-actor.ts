/**
 * The demo collaborator this tab acts as, if any.
 *
 * The actor lives only in this tab's sessionStorage, so a second tab, a plain
 * document link, and the presenter's own tab never inherit it. A launch carries
 * a one-time, non-secret persona hint in the URL; it is consumed and removed
 * before any socket opens. The server still validates the claim against its
 * roster at every admission, so nothing here is authority.
 */

import { setFaceProfiles } from "@chopin/editor/people";

import { showCollaboratorBadge } from "./collaborator-badge";
import { ACTOR_STORAGE_KEY, PERSONA_HINT, setActiveActor } from "./active-actor";

import type { DemoActor } from "./active-actor";

export { ACTOR_STORAGE_KEY, PERSONA_HINT };
export type { DemoActor };

type Resolution = {
	actor: DemoActor | undefined;
	/** The query to put back in the address bar when a hint was present. */
	strippedSearch?: string;
};

function remembered(storage: Pick<Storage, "getItem">): string | null {
	try {
		return storage.getItem(ACTOR_STORAGE_KEY);
	} catch {
		return null;
	}
}

function write(storage: Pick<Storage, "setItem" | "removeItem">, id: string | undefined): void {
	try {
		if (id) storage.setItem(ACTOR_STORAGE_KEY, id);
		else storage.removeItem(ACTOR_STORAGE_KEY);
	} catch {
		// Blocked storage: the persona lasts until this page reloads.
	}
}

/**
 * Decide this tab's actor from a launch hint or the stored persona.
 * Anything absent from the server roster is dropped, which also clears a stored
 * persona once the flag is turned off.
 */
export function resolveActor(
	search: string,
	roster: readonly DemoActor[],
	storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): Resolution {
	let parameters = new URLSearchParams(search);
	let hints = parameters.getAll(PERSONA_HINT);
	let hinted = hints.length === 1 ? roster.find(actor => actor.id === hints[0]) : undefined;
	let strippedSearch: string | undefined;
	if (hints.length) {
		parameters.delete(PERSONA_HINT);
		let query = parameters.toString();
		strippedSearch = query ? `?${query}` : "";
	}
	let actor = hinted ?? roster.find(candidate => candidate.id === remembered(storage));
	write(storage, actor?.id);
	return { actor, ...(strippedSearch === undefined ? {} : { strippedSearch }) };
}

/** The address a collaborator tab opens; only this URL carries a hint. */
export function launchUrl(href: string, actorId: string): string {
	let url = new URL(href);
	url.searchParams.set(PERSONA_HINT, actorId);
	return url.href;
}

let roster: readonly DemoActor[] = [];

/** The server roster the menu offers; empty unless demo personas are enabled. */
export function activeActorRoster(): readonly DemoActor[] {
	return roster;
}

export function setActorRoster(list: readonly DemoActor[]): void {
	roster = list;
}

/** The title a collaborator tab shows, so it is never mistaken for the presenter's. */
export function actorTitle(base: string, actor: DemoActor | undefined): string {
	return actor ? `${actor.name} · ${base}` : base;
}

/** Chat drafts are private to whoever is typing, so an actor's never mixes with another's. */
export function chatDraftKey(room: string, actorId: string | undefined): string {
	return actorId ? `chopin:chat-draft:${room}:${actorId}` : `chopin:chat-draft:${room}`;
}

/** Adopt this tab's actor before any socket opens; the hint never reaches the router. */
export function adoptActor(roster: readonly DemoActor[]): void {
	let { actor, strippedSearch } = resolveActor(location.search, roster, sessionStorage);
	setFaceProfiles(roster);
	setActiveActor(actor);
	setActorRoster(roster);
	if (actor && !document.title.startsWith(`${actor.name} · `)) {
		document.title = actorTitle(document.title, actor);
	}
	if (strippedSearch !== undefined) {
		history.replaceState(null, "", `${location.pathname}${strippedSearch}${location.hash}`);
	}
	if (actor) showCollaboratorBadge(actor);
}
