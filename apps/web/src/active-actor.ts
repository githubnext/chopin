/**
 * The state the initial bundle needs about the demo collaborator, kept apart from
 * `demo-actor.ts` so that module loads only when a roster or launch hint exists.
 */

export type DemoActor = { id: string; name: string; avatar: string };

export const PERSONA_HINT = "persona";
export const ACTOR_STORAGE_KEY = "chopin:demo-actor";

let current: DemoActor | undefined;

export function activeActor(): DemoActor | undefined {
	return current;
}

export function setActiveActor(actor: DemoActor | undefined): void {
	current = actor;
}

/** Whether a roster, a launch hint, or a stored persona makes resolution necessary. */
export function actorResolutionNeeded(
	search: string,
	rosterSize: number,
	storage: Pick<Storage, "getItem">,
): boolean {
	try {
		return rosterSize > 0 || search.includes(PERSONA_HINT)
			|| storage.getItem(ACTOR_STORAGE_KEY) !== null;
	} catch {
		return true;
	}
}
