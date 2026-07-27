/**
 * The connection, end to end.
 *
 * Spawns the real server rather than importing its parts, because the things
 * worth checking here — that a refused upgrade says why, that two sockets see
 * each other, that a reply finds the request that asked for it — only exist
 * once an actual socket is involved.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { Subprocess } from "bun";

const PORT = 8899;
const KEY = "test-key";
const ORIGIN = `127.0.0.1:${PORT}`;

let server: Subprocess;

function url(params: Record<string, string>): string {
	let query = new URLSearchParams(params).toString();
	return `ws://${ORIGIN}/ws?${query}`;
}

/** Open a socket and collect frames as they arrive. */
async function connect(params: Record<string, string>) {
	let socket = new WebSocket(url(params));
	let frames: Array<Record<string, unknown>> = [];
	socket.addEventListener("message", event => {
		frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
	});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("refused")));
	});
	return { socket, frames };
}

/** Frames arrive on their own schedule; wait for the one being asserted on. */
async function until<T>(read: () => T | undefined, label: string): Promise<T> {
	for (let i = 0; i < 100; i++) {
		let value = read();
		if (value !== undefined) return value;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function frame(frames: Array<Record<string, unknown>>, kind: string) {
	return () => frames.find(item => item.kind === kind);
}

beforeAll(async () => {
	server = Bun.spawn(["bun", `${import.meta.dir}/main.ts`], {
		env: { ...process.env, PORT: String(PORT), ACCESS_KEY: KEY, SERVER_HOST: "127.0.0.1" },
		stdout: "ignore",
		stderr: "inherit",
	});

	for (let i = 0; i < 100; i++) {
		try {
			await fetch(`http://${ORIGIN}/`);
			return;
		} catch {
			await Bun.sleep(20);
		}
	}
	throw new Error("server did not start");
});

afterAll(() => {
	server.kill();
});

describe("upgrade", () => {
	it("refuses a missing or wrong access key, and says so", async () => {
		let response = await fetch(`http://${ORIGIN}/ws?room=main&as=octocat`);
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("access key required");
	});

	it("refuses a handle that is not a GitHub handle", async () => {
		let response = await fetch(`http://${ORIGIN}/ws?room=main&as=not+a+handle&key=${KEY}`);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("bad handle");
	});

	it("refuses a room name that would not survive being a directory", async () => {
		let response = await fetch(`http://${ORIGIN}/ws?room=../escape&as=octocat&key=${KEY}`);
		expect(response.status).toBe(400);
		expect(await response.text()).toBe("bad room");
	});
});

describe("session", () => {
	it("greets a joining socket with itself and the room", async () => {
		let { socket, frames } = await connect({ room: "greet", as: "octocat", key: KEY });
		let hello = await until(frame(frames, "session:hello"), "hello");

		expect(hello.room).toBe("greet");
		expect(hello.you).toMatchObject({ handle: "octocat" });
		expect(hello.members).toHaveLength(1);

		socket.close();
	});

	it("shows two tabs of one handle as two members", async () => {
		let first = await connect({ room: "tabs", as: "octocat", key: KEY });
		await until(frame(first.frames, "session:hello"), "hello");

		let second = await connect({ room: "tabs", as: "octocat", key: KEY });
		let hello = await until(frame(second.frames, "session:hello"), "hello");

		expect(hello.members).toHaveLength(2);
		// One person, two seats: the client id is what tells them apart.
		let members = hello.members as Array<{ handle: string; client: string }>;
		expect(new Set(members.map(member => member.client)).size).toBe(2);

		first.socket.close();
		second.socket.close();
	});

	it("tells the room when someone arrives and when they leave", async () => {
		let first = await connect({ room: "presence", as: "octocat", key: KEY });
		await until(frame(first.frames, "session:hello"), "hello");

		let second = await connect({ room: "presence", as: "hubot", key: KEY });
		let arrival = await until(frame(first.frames, "session:presence"), "arrival");
		expect((arrival.members as unknown[]).length).toBe(2);

		first.frames.length = 0;
		second.socket.close();

		let departure = await until(frame(first.frames, "session:presence"), "departure");
		let remaining = departure.members as Array<{ handle: string }>;
		expect(remaining.map(member => member.handle)).toEqual(["octocat"]);

		first.socket.close();
	});

	it("keeps rooms apart", async () => {
		let here = await connect({ room: "here", as: "octocat", key: KEY });
		await until(frame(here.frames, "session:hello"), "hello");

		let elsewhere = await connect({ room: "elsewhere", as: "hubot", key: KEY });
		let hello = await until(frame(elsewhere.frames, "session:hello"), "hello");

		expect(hello.members).toHaveLength(1);
		expect(here.frames.find(item => item.kind === "session:presence")).toBeUndefined();

		here.socket.close();
		elsewhere.socket.close();
	});

	it("answers a request on the rid that asked", async () => {
		let { socket, frames } = await connect({ room: "ping", as: "octocat", key: KEY });
		await until(frame(frames, "session:hello"), "hello");

		socket.send(JSON.stringify({ kind: "session:ping", ts: 0, rid: "abc123" }));
		let pong = await until(
			() => frames.find(item => item.kind === "session:ping" && item.rid === "abc123"),
			"ping reply",
		);

		expect(pong.rid).toBe("abc123");
		socket.close();
	});
});
