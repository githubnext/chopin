/**
 * The agent, as a peer with a cursor.
 *
 * Every failure here is invisible at the other end: a state Lexical will not
 * draw, an update a peer discards, or a cursor left standing after the turn
 * that put it there has finished. So these assert against a second `Awareness`
 * fed the encoded bytes, which is exactly what a browser does with them —
 * checking the state we set would only prove we set it.
 */

import { describe, expect, it } from "bun:test";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import * as presence from "./presence";

import type { Attention, Presence } from "./presence";

/** A position of the kind an anchor decodes to. */
function somewhere(): Y.RelativePosition {
	let doc = new Y.Doc();
	return Y.createRelativePositionFromTypeIndex(doc.getText("t"), 0, -1);
}

function attention(): Attention {
	let at = somewhere();
	return {
		name: "ai",
		color: "#475569",
		focusing: true,
		agent: true,
		anchorPos: at,
		focusPos: at,
		awarenessData: {},
	};
}

/** A client receiving what the server sends, and what it makes of it. */
function peer(subject: Presence) {
	let remote = new Awareness(new Y.Doc());
	remote.setLocalState(null);
	return {
		apply: (update: Uint8Array) => applyAwarenessUpdate(remote, update, "server"),
		state: () => remote.getStates().get(subject.awareness.clientID),
		clock: () => remote.meta.get(subject.awareness.clientID)?.clock,
		seen: () => remote.meta.get(subject.awareness.clientID)?.lastUpdated,
	};
}

describe("the agent's cursor", () => {
	it("reaches a peer as something Lexical will draw", () => {
		let subject = presence.create();
		let client = peer(subject);

		client.apply(presence.attend(subject, attention()));

		// All four are required: Lexical destroys the caret of a state that is
		// not focusing, and skips a colour the browser cannot parse.
		expect(client.state()).toMatchObject({
			name: "ai",
			color: "#475569",
			focusing: true,
			agent: true,
		});
		expect(client.state()?.anchorPos).toBeDefined();
	});

	/** The row of faces is for people, and the agent has no avatar to show. */
	it("marks itself as not being a member", () => {
		let subject = presence.create();
		let client = peer(subject);

		client.apply(presence.attend(subject, attention()));

		expect(client.state()?.agent).toBe(true);
	});

	it("carries a position that survives the trip as JSON", () => {
		let subject = presence.create();
		let client = peer(subject);

		client.apply(presence.attend(subject, attention()));

		// Awareness states are JSON on the wire, so what arrives is a plain
		// object rather than a RelativePosition. Yjs reads it structurally,
		// which is the only reason any cursor works at all.
		expect(client.state()?.anchorPos).toMatchObject({ assoc: -1 });
	});

	it("moves rather than accumulating when the agent edits again", () => {
		let subject = presence.create();
		let client = peer(subject);

		client.apply(presence.attend(subject, attention()));
		client.apply(presence.attend(subject, attention()));

		expect([...subject.awareness.getStates().keys()]).toHaveLength(1);
	});
});

describe("keeping the cursor alive", () => {
	/**
	 * The one that fails in silence.
	 *
	 * A peer drops a state it has not heard about for thirty seconds, and
	 * `applyAwarenessUpdate` ignores an update whose clock has not advanced —
	 * without refreshing its timer either. So a renewal that merely re-encoded
	 * the same state would be discarded, and the cursor would disappear
	 * partway through a long turn with nothing anywhere to say why.
	 */
	it("advances the clock, so a peer treats the repeat as news", () => {
		let subject = presence.create();
		let client = peer(subject);

		client.apply(presence.attend(subject, attention()));
		let before = client.clock();

		let renewed = presence.renew(subject);
		expect(renewed).toBeDefined();
		client.apply(renewed!);

		expect(client.clock()).toBeGreaterThan(before!);
	});

	it("has nothing to repeat when the agent is not anywhere", () => {
		let subject = presence.create();
		expect(presence.renew(subject)).toBeUndefined();
	});
});

describe("taking the cursor down", () => {
	it("clears it at the peer rather than leaving it to time out", () => {
		let subject = presence.create();
		let client = peer(subject);

		client.apply(presence.attend(subject, attention()));
		expect(client.state()).toBeDefined();

		client.apply(presence.release(subject)!);

		expect(client.state()).toBeUndefined();
	});

	it("says nothing when there was no cursor to take down", () => {
		let subject = presence.create();
		expect(presence.release(subject)).toBeUndefined();
	});

	/**
	 * The agent has no socket, so nothing it owns can be attributed to one.
	 * Were it in `owners`, the first member to close a tab would take the
	 * agent's cursor with them.
	 */
	it("is not carried off by a member disconnecting", () => {
		let subject = presence.create();
		let socket = {};

		let member = new Awareness(new Y.Doc());
		member.setLocalState({ name: "kris", color: "#e06c75", focusing: true });
		presence.track(subject, socket, encodeAwarenessUpdate(member, [member.clientID]));
		presence.attend(subject, attention());

		presence.drop(subject, socket);

		expect(subject.awareness.getLocalState()).not.toBeNull();
	});
});
