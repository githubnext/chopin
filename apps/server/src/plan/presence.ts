/**
 * Server-side mirror of collaboration awareness.
 *
 * Awareness is ephemeral and stays unpersisted, but a client joining a plan
 * other people are already editing has to learn they are there. Peers only
 * re-announce themselves every fifteen seconds, so without a snapshot an
 * arriving client watches an apparently empty document while two other cursors
 * move through it.
 *
 * This only ever mirrors what it relays. It never originates state, it is not
 * consulted for anything but the join snapshot, and it is discarded with the
 * epoch it describes.
 */

import {
	applyAwarenessUpdate,
	Awareness,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";

export type Presence = {
	/** Stands in for the room's document; only the client registry is used. */
	doc: Y.Doc;
	awareness: Awareness;
	/**
	 * Which connection announced which Yjs client.
	 *
	 * A socket carries no Yjs identity of its own, so the mapping is learned
	 * from the updates it relays. Without it a disconnect could not be turned
	 * into the removal that clears someone's cursor.
	 *
	 * Weak because it is only ever addressed by socket: a connection that
	 * vanishes without a disconnect takes its entry with it rather than
	 * pinning it here.
	 */
	owners: WeakMap<object, Set<number>>;
};

export function create(): Presence {
	let doc = new Y.Doc();
	let awareness = new Awareness(doc);
	let owners = new WeakMap<object, Set<number>>();

	// The mirror is a bystander. Announcing a state of its own would put a
	// phantom cursor belonging to the server in everyone's editor.
	awareness.setLocalState(null);

	awareness.on("update", (
		{ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) => {
		if (!origin || typeof origin !== "object") return;
		let owned = owners.get(origin) ?? new Set<number>();
		for (let client of [...added, ...updated]) owned.add(client);
		for (let client of removed) owned.delete(client);
		if (owned.size > 0) owners.set(origin, owned);
		else owners.delete(origin);
	});

	return { doc, awareness, owners };
}

/** Record presence relayed by one connection. */
export function track(presence: Presence, ws: object, update: Uint8Array): void {
	try {
		applyAwarenessUpdate(presence.awareness, update, ws);
	} catch {
		// A malformed payload costs that client its presence, nothing more.
	}
}

/** Everyone currently known, for a joining client. */
export function snapshot(presence: Presence): Uint8Array | undefined {
	let states = presence.awareness.getStates();
	if (states.size === 0) return undefined;
	return encodeAwarenessUpdate(presence.awareness, [...states.keys()]);
}

/**
 * Forget a departed connection.
 *
 * Returns the update that clears its cursors, for relaying. Peers would
 * otherwise hold the ghost for the thirty seconds awareness takes to time it
 * out, which is long enough to reply to someone who has gone.
 */
export function drop(presence: Presence, ws: object): Uint8Array | undefined {
	let owned = presence.owners.get(ws);
	if (!owned || owned.size === 0) return undefined;

	let clients = [...owned];
	presence.owners.delete(ws);
	removeAwarenessStates(presence.awareness, clients, null);
	// Encoded after removal, so each client carries a null state and a bumped
	// clock — which is what a peer reads as "they left".
	return encodeAwarenessUpdate(presence.awareness, clients);
}

/** Discard everything. Presence describes an epoch and does not outlive it. */
export function destroy(presence: Presence): void {
	presence.awareness.destroy();
	presence.doc.destroy();
}
