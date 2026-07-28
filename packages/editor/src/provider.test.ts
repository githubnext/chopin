/**
 * Opening the document, when something beside it is broken.
 *
 * A plan is the point of the room; anchors decorate it. Resolving them used to
 * happen between applying the document and declaring it synced, so anything
 * that threw while working out where a decision pointed skipped the emit — and
 * because `connect` is started and forgotten, the editor stayed locked for the
 * rest of the session with nothing said about it anywhere.
 *
 * These pin the ordering and the guard. Painting is not tested: it needs real
 * layout, and happy-dom returns zero for every measurement.
 */

import { describe, expect, it } from "bun:test";
import * as Y from "yjs";

import { PlanProvider } from "./provider";

import type { Plan } from "@chopin/protocol";
import type { Transport, Unsubscribe } from "./transport";

/** base64 of an empty Yjs update, which is what an empty plan opens with. */
function emptyUpdate(): string {
	let update = Y.encodeStateAsUpdate(new Y.Doc());
	let binary = "";
	for (let byte of update) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function reply(): Plan.Open.Reply {
	return {
		kind: "plan:open",
		ts: 0,
		epoch: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
		seq: 1,
		update: emptyUpdate(),
		revision: 1,
		anchors: [],
		threads: [],
		limits: { source: 1_000, update: 1_000, depth: 10 },
	};
}

/**
 * A transport that answers `plan:open` and records what was asked of it.
 *
 * `connected` is settable, because the thing being tested is what happens when
 * a socket has not finished its handshake by the time something mounts against
 * it — and refuses the request the way the real one does.
 */
function wire(open = true): Transport & { sent: string[]; asked: object[]; up: boolean } {
	let sent: string[] = [];
	let asked: object[] = [];

	return {
		sent,
		asked,
		up: open,
		get connected(): boolean {
			return this.up;
		},
		on(): Unsubscribe {
			return () => {};
		},
		send(kind: string) {
			sent.push(kind);
		},
		ask<T>(kind: string, payload: Record<string, unknown> = {}): Promise<T> {
			if (!this.up) return Promise.reject(new Error("not connected"));
			sent.push(kind);
			asked.push(payload);
			if (kind === "plan:open") return Promise.resolve(reply() as T);
			return Promise.resolve(undefined as T);
		},
	};
}

function quietly<T>(run: () => T): T {
	let complain = console.error;
	console.error = () => {};
	try {
		return run();
	} finally {
		console.error = complain;
	}
}

describe("opening the plan", () => {
	it("declares the document synced", async () => {
		let synced: boolean[] = [];
		let provider = new PlanProvider({ wire: wire(), doc: new Y.Doc() });
		provider.on("sync", value => synced.push(value));

		await provider.connect();

		expect(synced).toContain(true);
	});

	/**
	 * The ordering that matters: a throw from anchors resolution must arrive
	 * after the document is usable, not instead of it.
	 */
	it("stays usable when working out where decisions point throws", async () => {
		let synced: boolean[] = [];
		let provider = new PlanProvider({
			wire: wire(),
			doc: new Y.Doc(),
			onAnchors() {
				throw new Error("could not resolve");
			},
		});
		provider.on("sync", value => synced.push(value));

		await quietly(async () => {
			await expect(provider.connect()).resolves.toBeUndefined();
		});

		expect(synced).toContain(true);
	});

	it("hands over the anchors it was given", async () => {
		let seen: Array<{ widgets: unknown[]; threads: unknown[] }> = [];
		let provider = new PlanProvider({
			wire: wire(),
			doc: new Y.Doc(),
			onAnchors: snapshot => seen.push(snapshot),
		});

		await provider.connect();

		expect(seen).toHaveLength(1);
	});

	/**
	 * `connect` is started and forgotten, so a rejection has nowhere to go.
	 * Whoever started it says so instead, and the chrome stops claiming the
	 * plan is still loading.
	 */
	/**
	 * The bug this exists for.
	 *
	 * A socket comes up on its own schedule and the editor mounts on React's;
	 * nothing makes the two coincide. Opening against a handshake that has not
	 * finished used to reject once and never be tried again, leaving the editor
	 * locked for the session with the chrome still claiming to be loading.
	 */
	it("waits rather than failing when the socket is not up yet", async () => {
		let transport = wire(false);
		let synced: boolean[] = [];
		let provider = new PlanProvider({ wire: transport, doc: new Y.Doc() });
		provider.on("sync", value => synced.push(value));

		await expect(provider.connect()).resolves.toBeUndefined();

		expect(transport.sent).toEqual([]);
		expect(synced).not.toContain(true);
	});

	it("opens as soon as the socket comes up", async () => {
		let transport = wire(false);
		let synced: boolean[] = [];
		let provider = new PlanProvider({ wire: transport, doc: new Y.Doc() });
		provider.on("sync", value => synced.push(value));
		await provider.connect();

		transport.up = true;
		await provider.resume();

		expect(transport.sent).toEqual(["plan:open"]);
		expect(synced).toContain(true);
	});

	it("stays quiet on a connection that never comes up", async () => {
		let transport = wire(false);
		let provider = new PlanProvider({ wire: transport, doc: new Y.Doc() });
		await provider.connect();

		await provider.resume();
		await provider.resume();

		expect(transport.sent).toEqual([]);
	});

	/**
	 * The second half of the same gap. `#open` is the only thing that asks for
	 * what was missed and the only thing that replays the outbox, so a
	 * reconnect that does not re-open leaves the editor unlocked over a
	 * document quietly short of everybody else's edits.
	 */
	it("asks again after a reconnect, for only what it missed", async () => {
		let transport = wire();
		let provider = new PlanProvider({ wire: transport, doc: new Y.Doc() });
		await provider.connect();

		await provider.resume();

		expect(transport.sent).toEqual(["plan:open", "plan:open"]);
		// The second carries what it already has, so the server replies with
		// the difference rather than the whole document.
		expect(transport.asked[1]).toMatchObject({
			epoch: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
			vector: expect.any(String),
		});
	});

	it("does not ask twice while an open is already in flight", async () => {
		let transport = wire();
		let provider = new PlanProvider({ wire: transport, doc: new Y.Doc() });
		await provider.connect();
		transport.sent.length = 0;

		await Promise.all([provider.resume(), provider.resume(), provider.resume()]);

		expect(transport.sent).toEqual(["plan:open"]);
	});

	it("can be told it failed, so the chrome does not say loading forever", () => {
		let states: Array<{ status: string; message?: string }> = [];
		let provider = new PlanProvider({ wire: wire(), doc: new Y.Doc() });
		provider.on("status", value => states.push(value));

		provider.fail("the plan could not be opened");

		expect(states).toContainEqual({
			status: "failed",
			message: "the plan could not be opened",
		});
	});
});
