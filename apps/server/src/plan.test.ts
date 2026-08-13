/**
 * The plan, over a real socket.
 *
 * Covers the contract a browser depends on: that opening returns a document,
 * that an accepted update is acknowledged to its sender and relayed to
 * everyone else, and that what was typed is still there after a restart.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHeadlessEditor } from "@lexical/headless";
import { createYjsBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from "@lexical/yjs";
import { $getRoot } from "lexical";
import * as Y from "yjs";

import { $importPlan, registry } from "@chopin/dialect";

import type { Subprocess } from "bun";
import type { Binding, Provider } from "@lexical/yjs";
import type { LexicalEditor } from "lexical";

const REGISTRY = registry();

const PROVIDER = {
	awareness: {
		getLocalState: () => null,
		getStates: () => new Map(),
		off() {},
		on() {},
		setLocalState() {},
		setLocalStateField() {},
	},
	connect() {},
	disconnect() {},
	off() {},
	on() {},
} as unknown as Provider;

type Frames = Array<Record<string, unknown>>;

let running: Subprocess[] = [];
let dirs: string[] = [];

afterEach(async () => {
	for (let server of running) server.kill();
	running = [];
	for (let dir of dirs) await rm(dir, { recursive: true, force: true });
	dirs = [];
});

async function serve(port: number, dataDir: string): Promise<void> {
	let server = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
		env: {
			...process.env,
			PORT: String(port),
			DATA_DIR: dataDir,
			SERVER_HOST: "127.0.0.1",
			AGENT: "off",
			AUTH_DRIVER: "off",
			STORAGE_DRIVER: "legacy",
		},
		stdout: "ignore",
		stderr: "inherit",
	});
	running.push(server);

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

async function connect(port: number, room: string, as: string) {
	let socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}&as=${as}`);
	let frames: Frames = [];
	socket.addEventListener("message", event => {
		frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("refused")));
	});
	return { socket, frames };
}

async function until<T>(read: () => T | undefined, label: string): Promise<T> {
	for (let i = 0; i < 300; i++) {
		let value = read();
		if (value !== undefined) return value;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function seen(frames: Frames, kind: string) {
	return () => frames.find(item => item.kind === kind);
}

/** A browser's half of the document. */
function client(): { editor: LexicalEditor; doc: Y.Doc; binding: Binding } {
	let editor = createHeadlessEditor({
		nodes: REGISTRY.nodes,
		onError(err) {
			throw err;
		},
	});
	let doc = new Y.Doc();
	let binding = createYjsBinding({ editor, id: "plan", doc, docMap: new Map([["plan", doc]]) });

	editor.registerUpdateListener(
		({ dirtyElements, dirtyLeaves, editorState, normalizedNodes, prevEditorState, tags }) => {
			if (tags.has("skip-collab")) return;
			syncLexicalUpdateToYjs(
				binding,
				PROVIDER,
				prevEditorState,
				editorState,
				dirtyElements,
				dirtyLeaves,
				normalizedNodes,
				tags,
			);
		},
	);
	binding.root.getSharedType().observeDeep((events, transaction) => {
		if (transaction.origin !== binding) syncYjsChangesToLexical(binding, PROVIDER, events, false);
	});

	return { editor, doc, binding };
}

async function open(socket: WebSocket, frames: Frames, rid: string) {
	socket.send(JSON.stringify({ kind: "plan:open", ts: 0, rid }));
	return until(
		() => frames.find(item => item.kind === "plan:open" && item.rid === rid),
		"plan:open reply",
	);
}

function scratch(): string {
	let dir = join(tmpdir(), `chopin-test-${crypto.randomUUID().slice(0, 8)}`);
	dirs.push(dir);
	return dir;
}

/** Write `source` into a peer's document and return the update to send. */
async function edit(peer: ReturnType<typeof client>, source: string): Promise<string> {
	let before = Y.encodeStateVector(peer.doc);
	peer.editor.update(() => {
		$importPlan(source, { registry: REGISTRY, validate: false });
	}, { discrete: true });
	await Bun.sleep(10);
	return Buffer.from(Y.encodeStateAsUpdate(peer.doc, before)).toString("base64");
}

describe("opening", () => {
	it("hands back an epoch, a revision and the limits it will enforce", async () => {
		let port = 8910;
		await serve(port, scratch());

		let { socket, frames } = await connect(port, "open", "octocat");
		let reply = await open(socket, frames, "r1");

		expect(typeof reply.epoch).toBe("string");
		expect(reply.seq).toBe(0);
		expect(reply.revision).toBe(0);
		expect(reply.limits).toMatchObject({ source: 262144, depth: 20 });

		socket.close();
	});

	it("gives two members the same epoch", async () => {
		let port = 8911;
		await serve(port, scratch());

		let first = await connect(port, "shared", "octocat");
		let second = await connect(port, "shared", "hubot");

		let one = await open(first.socket, first.frames, "a");
		let two = await open(second.socket, second.frames, "b");

		expect(two.epoch).toBe(one.epoch);

		first.socket.close();
		second.socket.close();
	});
});

describe("updates", () => {
	it("acknowledges the sender and relays to everyone else", async () => {
		let port = 8912;
		await serve(port, scratch());

		let author = await connect(port, "edits", "octocat");
		let reader = await connect(port, "edits", "hubot");
		let hello = await open(author.socket, author.frames, "a");
		await open(reader.socket, reader.frames, "b");

		let peer = client();
		Y.applyUpdate(peer.doc, new Uint8Array(Buffer.from(String(hello.update), "base64")), "remote");
		await Bun.sleep(20);

		let update = await edit(peer, "# Written by a test\n");
		author.socket.send(JSON.stringify({
			kind: "plan:update",
			ts: 0,
			rid: "u1",
			epoch: hello.epoch,
			id: "update-1",
			update,
		}));

		let ack = await until(seen(author.frames, "plan:ack"), "ack");
		expect(ack.id).toBe("update-1");
		expect(ack.epoch).toBe(hello.epoch);

		let relayed = await until(seen(reader.frames, "plan:update"), "relay");
		expect(relayed.update).toBe(update);
		// The sender applied it locally already; echoing wastes a round trip.
		expect(author.frames.find(item => item.kind === "plan:update")).toBeUndefined();

		author.socket.close();
		reader.socket.close();
	});

	it("ignores an update aimed at an epoch that no longer exists", async () => {
		let port = 8913;
		await serve(port, scratch());

		let { socket, frames } = await connect(port, "stale", "octocat");
		let hello = await open(socket, frames, "a");

		let peer = client();
		Y.applyUpdate(peer.doc, new Uint8Array(Buffer.from(String(hello.update), "base64")), "remote");
		await Bun.sleep(20);

		socket.send(JSON.stringify({
			kind: "plan:update",
			ts: 0,
			rid: "u1",
			epoch: "01JQQQQQQQQQQQQQQQQQQQQQQQ",
			id: "update-1",
			update: await edit(peer, "# Ignored\n"),
		}));

		await Bun.sleep(200);
		expect(frames.find(item => item.kind === "plan:ack")).toBeUndefined();

		socket.close();
	});
});

describe("durability", () => {
	it("writes canonical MDX and reports itself saved", async () => {
		let port = 8914;
		let dir = scratch();
		await serve(port, dir);

		let { socket, frames } = await connect(port, "saved", "octocat");
		let hello = await open(socket, frames, "a");

		let peer = client();
		Y.applyUpdate(peer.doc, new Uint8Array(Buffer.from(String(hello.update), "base64")), "remote");
		await Bun.sleep(20);

		socket.send(JSON.stringify({
			kind: "plan:update",
			ts: 0,
			rid: "u1",
			epoch: hello.epoch,
			id: "update-1",
			update: await edit(peer, "# Durable\n\nStill here.\n"),
		}));

		await until(
			() => frames.find(item => item.kind === "plan:status" && item.state === "saved"),
			"saved",
		);

		let written = await Bun.file(join(dir, "saved", "plan.mdx")).text();
		expect(written).toBe("# Durable\n\nStill here.\n");

		socket.close();
	});

	/**
	 * The point of snapshotting at all. Yjs history is not persisted, so this
	 * comes back under a new epoch — which is a boundary clients already know
	 * how to handle.
	 */
	it("still has the plan after a restart", async () => {
		let dir = scratch();

		await serve(8915, dir);
		let first = await connect(8915, "restart", "octocat");
		let hello = await open(first.socket, first.frames, "a");

		let peer = client();
		Y.applyUpdate(peer.doc, new Uint8Array(Buffer.from(String(hello.update), "base64")), "remote");
		await Bun.sleep(20);

		first.socket.send(JSON.stringify({
			kind: "plan:update",
			ts: 0,
			rid: "u1",
			epoch: hello.epoch,
			id: "update-1",
			update: await edit(peer, "# Survives\n"),
		}));
		await until(
			() => first.frames.find(item => item.kind === "plan:status" && item.state === "saved"),
			"saved",
		);
		first.socket.close();
		for (let server of running) server.kill();
		running = [];

		await serve(8916, dir);
		let second = await connect(8916, "restart", "octocat");
		let resumed = await open(second.socket, second.frames, "b");

		let reader = client();
		Y.applyUpdate(
			reader.doc,
			new Uint8Array(Buffer.from(String(resumed.update), "base64")),
			"remote",
		);
		await Bun.sleep(50);

		let text = "";
		reader.editor.getEditorState().read(() => {
			text = $getRoot().getTextContent();
		});
		expect(text).toContain("Survives");
		expect(resumed.epoch).not.toBe(hello.epoch);

		second.socket.close();
	});

	it("leaves no directory behind for a room nobody wrote in", async () => {
		let port = 8917;
		let dir = scratch();
		await serve(port, dir);

		let { socket, frames } = await connect(port, "untouched", "octocat");
		await open(socket, frames, "a");
		await Bun.sleep(300);

		expect(await Bun.file(join(dir, "untouched", "plan.mdx")).exists()).toBe(false);

		socket.close();
	});
});
