/**
 * Server-side mirror of collaboration awareness.
 *
 * Awareness is ephemeral and stays unpersisted, but a client joining a plan
 * other people are already editing has to learn they are there. Peers only
 * re-announce themselves every fifteen seconds, so without a snapshot an
 * arriving client watches an apparently empty document while two other cursors
 * move through it.
 *
 * It mirrors what it relays, and originates exactly one state of its own: the
 * agent's. Everything else here is a reflection of somebody's socket, which is
 * why a disconnect can clear it; the agent has no socket to disconnect, so its
 * cursor is put in the mirror's own local slot and taken down deliberately
 * when the turn ends. Riding in that slot is also what puts it in the join
 * snapshot, so somebody arriving mid-turn sees where the agent is working.
 *
 * Otherwise it is not consulted for anything but that snapshot, and it is
 * discarded with the epoch it describes.
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

/**
 * The agent, as a peer.
 *
 * Lexical refuses to draw a cursor without all four of these: a state that is
 * not `focusing` has its caret destroyed, and a colour it cannot parse paints
 * nothing. The extra field is what keeps the agent out of the row of faces —
 * it is not somebody with a GitHub avatar.
 */
export type Attention = {
	name: string;
	color: string;
	focusing: true;
	agent: true;
	anchorPos: Y.RelativePosition;
	focusPos: Y.RelativePosition;
	awarenessData: object;
};

export function create(): Presence {
	let doc = new Y.Doc();
	let awareness = new Awareness(doc);
	let owners = new WeakMap<object, Set<number>>();

	// Empty until the agent edits something. The mirror originates nothing on
	// anyone else's behalf: every other state here belongs to a socket.
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

/**
 * Put the agent's cursor somewhere, and say so.
 *
 * Returns the update to broadcast. Moving it is the same call again: awareness
 * has no notion of a cursor moving, only of a state being replaced.
 */
export function attend(presence: Presence, at: Attention): Uint8Array {
	presence.awareness.setLocalState(at);
	return encodeAwarenessUpdate(presence.awareness, [presence.awareness.clientID]);
}

/**
 * Say the agent is still there.
 *
 * Peers drop a state they have not heard about for thirty seconds, so a cursor
 * that outlives that has to be repeated. Repeating is not enough on its own:
 * `applyAwarenessUpdate` ignores an update whose clock has not moved, and
 * ignoring it means not refreshing the timer either — so a re-encode of an
 * unchanged state would be discarded in silence and the cursor would vanish
 * mid-turn. Setting the state again is what advances the clock.
 *
 * Nothing to say when the agent is not anywhere.
 */
export function renew(presence: Presence): Uint8Array | undefined {
	let held = presence.awareness.getLocalState();
	if (!held) return undefined;
	return attend(presence, held as Attention);
}

/**
 * Take the agent's cursor down.
 *
 * A null state with a bumped clock, which is what a peer reads as "they left"
 * — the same shape `drop` sends for a member who disconnected. Waiting for the
 * timeout instead would leave the agent apparently mid-edit for half a minute
 * after it had finished.
 */
export function release(presence: Presence): Uint8Array | undefined {
	if (!presence.awareness.getLocalState()) return undefined;
	presence.awareness.setLocalState(null);
	return encodeAwarenessUpdate(presence.awareness, [presence.awareness.clientID]);
}

/** Discard everything. Presence describes an epoch and does not outlive it. */
export function destroy(presence: Presence): void {
	presence.awareness.destroy();
	presence.doc.destroy();
}
