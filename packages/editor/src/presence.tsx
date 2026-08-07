/**
 * Who else has this plan open.
 *
 * Read straight from the collaboration awareness rather than from room
 * membership: this answers "who is looking at the plan right now", which is a
 * narrower question than who is connected, and it is already travelling over
 * the wire for the cursors.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { Count } from "./count";
import { Face } from "./face";

import type { PlanProvider } from "./provider";

const CAP = 3;

function names(people: string[]): string {
	let shown = people.slice(0, CAP);
	let more = people.length - shown.length;
	return [...shown, ...more > 0 ? [`+${more}`] : []].join(", ");
}

/**
 * Peers, excluding this client and the agent.
 *
 * Deduplicated by handle: someone with the plan open in two windows is one
 * person, and showing them twice reads as two colleagues.
 *
 * The agent has a cursor in here too, and it is not a member. Every face is
 * built into a github.com avatar URL, and `github.com/ai` is somebody — so
 * without this the room would show a stranger's photograph, and the usual
 * fallback to initials would never fire because the image loads perfectly
 * well. That the agent is working is already said beside the plan.
 */
function peers(provider: PlanProvider | undefined): string[] {
	if (!provider) return [];
	let found = new Set<string>();
	for (let [client, state] of provider.awareness.getStates()) {
		if (client === provider.awareness.clientID) continue;
		if (state?.agent) continue;
		let name = state?.name;
		if (typeof name === "string" && name) found.add(name);
	}
	return [...found].sort();
}

function usePeers(provider: PlanProvider | undefined): string[] {
	let subscribe = useCallback((listener: () => void) => {
		provider?.awareness.on("update", listener);
		return () => provider?.awareness.off("update", listener);
	}, [provider]);

	// getStates is a live map, so a fresh array every read would never settle.
	// The joined handles are the only part that affects what is drawn.
	let snapshot = useCallback(() => peers(provider).join("\u0000"), [provider]);
	let key = useSyncExternalStore(subscribe, snapshot, () => "");

	return useMemo(() => (key ? key.split("\u0000") : []), [key]);
}

export function PlanPresence({ provider }: { provider: PlanProvider | undefined }) {
	let people = usePeers(provider);
	if (people.length === 0) return null;

	let label = names(people);

	return (
		<div aria-label={`Also here: ${label}`} className="plan-presence" title={label}>
			{people.slice(0, CAP).map(handle => <Face handle={handle} key={handle} ring />)}
			{people.length > CAP && <Count ring>+{people.length - CAP}</Count>}
		</div>
	);
}
