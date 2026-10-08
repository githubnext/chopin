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

import { afterEach, describe, expect, it, jest } from "bun:test";
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

const EPOCH = "01K0N4TR8K7JGM4R1J7PW4R8YJ";

function reply(epoch = EPOCH): Plan.Open.Reply {
	return {
		kind: "plan:open",
		ts: 0,
		epoch,
		seq: 1,
		update: emptyUpdate(),
		revision: 1,
		anchors: [],
		threads: [],
		prose: [],
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
function wire(open = true): Transport & {
	sent: string[];
	asked: object[];
	up: boolean;
	epoch: string;
	emit: (kind: string, frame: unknown) => void;
} {
	let sent: string[] = [];
	let asked: object[] = [];
	let handlers = new Map<string, Set<(frame: never) => void>>();

	return {
		sent,
		asked,
		up: open,
		epoch: EPOCH,
		get connected(): boolean {
			return this.up;
		},
		on<T>(kind: string, handler: (frame: T) => void): Unsubscribe {
			let set = handlers.get(kind);
			if (!set) handlers.set(kind, set = new Set());
			set.add(handler as (frame: never) => void);
			return () => set!.delete(handler as (frame: never) => void);
		},
		emit(kind: string, frame: unknown) {
			for (let handler of handlers.get(kind) ?? []) handler(frame as never);
		},
		send(kind: string) {
			sent.push(kind);
		},
		ask<T>(kind: string, payload: Record<string, unknown> = {}): Promise<T> {
			if (!this.up) return Promise.reject(new Error("not connected"));
			sent.push(kind);
			asked.push(payload);
			if (kind === "plan:open") return Promise.resolve(reply(this.epoch) as T);
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
		let seen: Array<{ widgets: unknown[]; threads: unknown[]; prose: unknown[] }> = [];
		let provider = new PlanProvider({
			wire: wire(),
			doc: new Y.Doc(),
			onAnchors: snapshot => seen.push(snapshot),
		});

		await provider.connect();

		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({ widgets: [], threads: [], prose: [] });
	});

	it("passes current-epoch prose snapshots through and drops stale ones", async () => {
		let transport = wire();
		let seen: Array<{ widgets: unknown[]; threads: unknown[]; prose: unknown[] }> = [];
		let provider = new PlanProvider({
			wire: transport,
			doc: new Y.Doc(),
			onAnchors: snapshot => seen.push(snapshot),
		});
		await provider.connect();
		let prose: Plan.ProseAnchors = {
			widget: "card-a",
			anchors: [],
			orphaned: true,
		};
		transport.emit(
			"plan:anchors",
			{
				kind: "plan:anchors",
				ts: 0,
				epoch: "old-epoch",
				widgets: [],
				threads: [],
				prose: [prose],
			} satisfies Plan.Anchors,
		);
		expect(seen).toHaveLength(1);
		transport.emit(
			"plan:anchors",
			{
				kind: "plan:anchors",
				ts: 0,
				epoch: reply().epoch,
				widgets: [],
				threads: [],
				prose: [prose],
			} satisfies Plan.Anchors,
		);
		expect(seen.at(-1)?.prose).toEqual([prose]);
	});

	it("treats a pre-prose anchors frame as an empty prose snapshot", async () => {
		let transport = wire();
		let seen: Array<{ prose: Plan.ProseAnchors[] }> = [];
		let provider = new PlanProvider({
			wire: transport,
			doc: new Y.Doc(),
			onAnchors: snapshot => seen.push(snapshot),
		});
		await provider.connect();

		transport.emit("plan:anchors", {
			kind: "plan:anchors",
			ts: 0,
			epoch: reply().epoch,
			widgets: [],
			threads: [],
		} as unknown as Plan.Anchors);

		expect(seen.at(-1)?.prose).toEqual([]);
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

	/*
	 * The server rebuilt the document while this client was away, so it never
	 * heard the reset. Merging the new state into the old document kept edits
	 * nobody else had, and every later edit was acknowledged but never applied.
	 */
	it("rebuilds rather than merges when the epoch rotated while it was away", async () => {
		let transport = wire();
		let doc = new Y.Doc();
		let resets: Array<[string, boolean]> = [];
		let provider = new PlanProvider({
			wire: transport,
			doc,
			onReset: (reason, lost) => resets.push([reason, lost]),
		});
		await provider.connect();

		transport.up = false;
		doc.getText("plan").insert(0, "typed during a blip");
		transport.up = true;
		transport.epoch = "01K0N4TR8K7JGM4R1J7PW4R8Z0";
		transport.sent.length = 0;
		await provider.resume();

		expect(resets).toEqual([["replaced", true]]);
		// Nothing from the old history is replayed into the new one.
		expect(transport.sent).toEqual(["plan:open"]);
		expect(provider.synced).toBe(false);
	});

	it("says nothing was lost when a rotated epoch finds the outbox empty", async () => {
		let transport = wire();
		let resets: boolean[] = [];
		let provider = new PlanProvider({
			wire: transport,
			doc: new Y.Doc(),
			onReset: (_, lost) => resets.push(lost),
		});
		await provider.connect();

		transport.epoch = "01K0N4TR8K7JGM4R1J7PW4R8Z0";
		await provider.resume();

		expect(resets).toEqual([false]);
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

/**
 * A server that applies, acknowledges and relays updates, and drops some
 * without a word, as the real one does past its rate limit.
 *
 * The plan service accepts at most 200 updates a second from one socket and
 * silently ignores the rest. A dropped update also strands every later one
 * from the same client, because Yjs holds an update whose predecessor never
 * arrived instead of integrating it.
 */
function server(drop: (index: number) => boolean) {
	let doc = new Y.Doc();
	let transport = wire();
	let received: Array<{ id: string; bytes: number }> = [];
	let delivered = 0;
	let send = transport.send;
	let room = {
		doc,
		transport,
		received,
		drop,
		get delivered() {
			return delivered;
		},
	};
	transport.send = (kind: string, payload: Record<string, unknown> = {}) => {
		send.call(transport, kind);
		if (kind !== "plan:update") return;
		let binary = atob(payload.update as string);
		let update = Uint8Array.from(binary, char => char.charCodeAt(0));
		received.push({ id: payload.id as string, bytes: update.byteLength });
		if (room.drop(received.length - 1)) return;
		delivered++;
		Y.applyUpdate(doc, update);
		transport.emit("plan:ack", { kind: "plan:ack", id: payload.id });
	};
	return room;
}

function typing(doc: Y.Doc, count: number) {
	let text = doc.getText("typed");
	for (let i = 0; i < count; i++) text.insert(text.length, "x");
}

describe("delivering local edits", () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	it("does not send faster than the server accepts", async () => {
		jest.useFakeTimers();
		// Past 200 a second the real server drops the rest.
		let room = server(() => room.delivered >= 200);
		let doc = new Y.Doc();
		let provider = new PlanProvider({ wire: room.transport, doc });
		await provider.connect();

		typing(doc, 300);
		jest.advanceTimersByTime(1_000);

		expect(room.doc.getText("typed").toString()).toBe("x".repeat(300));
		expect(room.delivered).toBeLessThan(200);
	});

	it("resends an edit the server never acknowledged", async () => {
		jest.useFakeTimers();
		let room = server(index => index === 0);
		let doc = new Y.Doc();
		let provider = new PlanProvider({ wire: room.transport, doc });
		await provider.connect();

		typing(doc, 1);
		jest.advanceTimersByTime(100);
		typing(doc, 1);
		jest.advanceTimersByTime(100);
		// The second keystroke arrived but cannot be applied without the first.
		expect(room.doc.getText("typed").toString()).toBe("");

		jest.advanceTimersByTime(10_000);
		expect(room.doc.getText("typed").toString()).toBe("xx");
	});

	it("leaves acknowledged edits alone", async () => {
		jest.useFakeTimers();
		let room = server(() => false);
		let doc = new Y.Doc();
		let provider = new PlanProvider({ wire: room.transport, doc });
		await provider.connect();

		typing(doc, 1);
		jest.advanceTimersByTime(10_000);

		expect(room.delivered).toBe(1);
	});

	it("backs off and then stops resending an edit nobody acknowledges", async () => {
		jest.useFakeTimers();
		let room = server(() => true);
		let doc = new Y.Doc();
		let provider = new PlanProvider({ wire: room.transport, doc });
		await provider.connect();

		typing(doc, 1);
		// Sent at once, resent at 4s, then at 8s, 16s and 32s.
		jest.advanceTimersByTime(7_000);
		expect(room.received).toHaveLength(2);
		jest.advanceTimersByTime(7_000);
		expect(room.received).toHaveLength(3);

		jest.advanceTimersByTime(10 * 60_000);
		expect(room.received).toHaveLength(5);
	});

	it("does not repeat an edit the server refused", async () => {
		jest.useFakeTimers();
		let room = server(() => true);
		let doc = new Y.Doc();
		let provider = new PlanProvider({ wire: room.transport, doc });
		await provider.connect();

		typing(doc, 1);
		room.transport.emit("session:error", {
			kind: "session:error",
			message: "implementation is active",
		});
		typing(doc, 1);
		// Too large, in the real server: refused without rotating the epoch.
		jest.advanceTimersByTime(100);
		room.transport.emit("plan:reset", {
			kind: "plan:reset",
			epoch: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
			reason: "rebuilt",
		});
		jest.advanceTimersByTime(10 * 60_000);

		expect(room.received).toHaveLength(2);
	});

	it("stops resending once the epoch is replaced", async () => {
		jest.useFakeTimers();
		let room = server(() => true);
		let doc = new Y.Doc();
		let provider = new PlanProvider({ wire: room.transport, doc });
		await provider.connect();

		typing(doc, 1);
		room.transport.emit("plan:reset", {
			kind: "plan:reset",
			epoch: "01K0N4TR8K7JGM4R1J7PW4R8YK",
			reason: "rebuilt",
		});
		jest.advanceTimersByTime(10 * 60_000);

		expect(room.received).toHaveLength(1);
	});

	it("keeps a merged resend outstanding when the old ids are acknowledged late", async () => {
		jest.useFakeTimers();
		let room = server(() => true);
		let doc = new Y.Doc();
		let provider = new PlanProvider({ wire: room.transport, doc });
		await provider.connect();

		typing(doc, 1);
		jest.advanceTimersByTime(100);
		typing(doc, 1);
		jest.advanceTimersByTime(4_000);
		let [first, second, merged] = room.received.map(entry => entry.id);
		expect(merged).toStartWith("merged-");

		for (let id of [first, second]) {
			room.transport.emit("plan:ack", { kind: "plan:ack", id });
		}
		room.drop = () => false;
		jest.advanceTimersByTime(60_000);

		expect(room.received.at(-1)?.id).toBe(merged);
		expect(room.doc.getText("typed").toString()).toBe("xx");
	});

	it("replays a large backlog in chunks the server accepts", async () => {
		jest.useFakeTimers();
		let room = server(() => true);
		let doc = new Y.Doc();
		let provider = new PlanProvider({ wire: room.transport, doc });
		await provider.connect();
		let text = doc.getText("typed");
		for (let i = 0; i < 64; i++) {
			text.insert(text.length, "y".repeat(4_096));
			jest.advanceTimersByTime(20);
		}

		room.drop = () => false;
		let before = room.received.length;
		await provider.resume();
		let replayed = room.received.slice(before);

		expect(replayed.length).toBeGreaterThan(1);
		for (let entry of replayed) expect(entry.bytes).toBeLessThanOrEqual(64 * 1024);
		expect(room.doc.getText("typed").length).toBe(64 * 4_096);
	});
});
