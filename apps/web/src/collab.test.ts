/**
 * Two clients, one plan.
 *
 * The provider is the most intricate thing in the editor and the least
 * observable: it is only exercised when a real socket, a real server and a
 * real Y.Doc are all present. This puts two of them against the actual server
 * and checks the properties a person would otherwise have to notice by
 * watching two browser windows.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";

import { PlanProvider } from "@chopin/editor";

import type { Subprocess } from "bun";
import type { Transport, Unsubscribe } from "@chopin/editor";

const SERVER = join(import.meta.dir, "../../server/src/main.ts");

let running: Subprocess[] = [];
let dirs: string[] = [];
let sockets: WebSocket[] = [];

afterEach(async () => {
	for (let socket of sockets) socket.close();
	sockets = [];
	for (let server of running) server.kill();
	running = [];
	for (let dir of dirs) await rm(dir, { recursive: true, force: true });
	dirs = [];
});

async function serve(port: number): Promise<void> {
	let dir = join(tmpdir(), `chopin-collab-${crypto.randomUUID().slice(0, 8)}`);
	dirs.push(dir);

	running.push(Bun.spawn(["bun", SERVER], {
		env: {
			...process.env,
			PORT: String(port),
			DATA_DIR: dir,
			SERVER_HOST: "127.0.0.1",
			AGENT: "off",
		},
		stdout: "ignore",
		stderr: "inherit",
	}));

	for (let i = 0; i < 200; i++) {
		try {
			await fetch(`http://127.0.0.1:${port}/`);
			return;
		} catch {
			await Bun.sleep(20);
		}
	}
	throw new Error("server did not start");
}

/** The three verbs the editor needs, over a real socket. */
async function transport(port: number, room: string, as: string): Promise<Transport> {
	let socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}&as=${as}`);
	sockets.push(socket);

	let listeners = new Map<string, Set<(frame: never) => void>>();
	let pending = new Map<string, (frame: never) => void>();

	socket.addEventListener("message", event => {
		let frame = JSON.parse(String(event.data)) as { kind: string; rid?: string };
		if (frame.rid) {
			let waiting = pending.get(frame.rid);
			if (waiting) {
				pending.delete(frame.rid);
				waiting(frame as never);
			}
		}
		for (let listener of listeners.get(frame.kind) ?? []) listener(frame as never);
	});

	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("refused")));
	});

	let counter = 0;
	return {
		on<T>(kind: string, handler: (frame: T) => void): Unsubscribe {
			let set = listeners.get(kind);
			if (!set) listeners.set(kind, set = new Set());
			set.add(handler as (frame: never) => void);
			return () => set.delete(handler as (frame: never) => void);
		},
		send(kind, payload = {}) {
			socket.send(JSON.stringify({ ...payload, kind, ts: 0, rid: `s${counter++}` }));
		},
		ask<T>(kind: string, payload: Record<string, unknown> = {}): Promise<T> {
			let rid = `a${counter++}`;
			let task = Promise.withResolvers<T>();
			pending.set(rid, task.resolve as (frame: never) => void);
			socket.send(JSON.stringify({ ...payload, kind, ts: 0, rid }));
			return task.promise;
		},
	};
}

/** A client: provider, document and the Lexical editor bound to it. */
async function client(port: number, room: string, as: string) {
	let doc = new Y.Doc();
	let provider = new PlanProvider({ doc, wire: await transport(port, room, as) });
	await provider.connect();
	return { doc, provider };
}

async function until(check: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (check()) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${label}`);
}

describe("two clients", () => {
	it("both sync to the server's document", async () => {
		let port = 8930;
		await serve(port);

		let alice = await client(port, "sync", "alice");
		let bob = await client(port, "sync", "bob");

		expect(alice.provider.synced).toBe(true);
		expect(bob.provider.synced).toBe(true);
		expect(alice.provider.epoch).toBe(bob.provider.epoch);
	});

	it("carries an edit from one to the other", async () => {
		let port = 8931;
		await serve(port);

		let alice = await client(port, "edits", "alice");
		let bob = await client(port, "edits", "bob");

		// Written into the shared root the binding uses, which is what the
		// provider observes and sends. Structure is the dialect's business and
		// is covered where it lives; what matters here is that bytes travel.
		let shared = alice.doc.get("plan", Y.XmlText) as Y.XmlText;
		alice.doc.transact(() => shared.insert(0, "Hello from Alice"));

		await until(
			() => (bob.doc.get("plan", Y.XmlText) as Y.XmlText).toString().includes("Hello from Alice"),
			"bob to receive the edit",
		);
	});

	it("tells each client who else is present", async () => {
		let port = 8932;
		await serve(port);

		let alice = await client(port, "presence", "alice");
		let bob = await client(port, "presence", "bob");

		alice.provider.awareness.setLocalState({ name: "alice", color: "#e06c75", focusing: false });
		bob.provider.awareness.setLocalState({ name: "bob", color: "#56b6c2", focusing: false });

		await until(
			() => [...bob.provider.awareness.getStates().values()].some(state => state?.name === "alice"),
			"bob to see alice",
		);
		await until(
			() => [...alice.provider.awareness.getStates().values()].some(state => state?.name === "bob"),
			"alice to see bob",
		);
	});

	/**
	 * A client that arrives after the fact must be told who is already there.
	 * Peers only re-announce every fifteen seconds, so without the server's
	 * snapshot a joiner watches an apparently empty document.
	 */
	it("gives a late joiner the presence that predates them", async () => {
		let port = 8933;
		await serve(port);

		let alice = await client(port, "late", "alice");
		alice.provider.awareness.setLocalState({ name: "alice", color: "#e06c75", focusing: false });
		await Bun.sleep(100);

		let bob = await client(port, "late", "bob");

		await until(
			() => [...bob.provider.awareness.getStates().values()].some(state => state?.name === "alice"),
			"bob to inherit alice's presence",
		);
	});
});
