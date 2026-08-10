/**
 * Commenting, over an actual socket.
 *
 * The service tests drive the handlers directly, which says nothing about
 * whether they are reachable. This spawns the real server: the frames have to
 * be routed, a reply has to find the request that asked for it, and what one
 * member does has to arrive at the other. It is also the only place the join
 * sequence is exercised — a client learns about existing threads from
 * `plan:open`, not from connecting.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Subprocess } from "bun";

const PORT = 8898;
const ORIGIN = `127.0.0.1:${PORT}`;

const SOURCE = `# Title

The renderer caches tiles for 60 seconds.

The second paragraph.
`;

const QUOTE = "caches tiles for 60 seconds";

let server: Subprocess;
let data: string;

type Frame = { kind: string; rid?: string; [key: string]: unknown };

/** A member, with the frames it has been sent and a way to ask for a reply. */
async function member(room: string, handle: string): Promise<Member> {
	let socket = new WebSocket(`ws://${ORIGIN}/ws?room=${room}&as=${handle}`);
	let frames: Frame[] = [];
	let waiting = new Map<string, (frame: Frame) => void>();
	let n = 0;

	socket.addEventListener("message", event => {
		let frame = JSON.parse(String(event.data)) as Frame;
		frames.push(frame);
		let settle = frame.rid && waiting.get(frame.rid);
		if (settle) {
			waiting.delete(frame.rid!);
			settle(frame);
		}
	});

	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve());
		socket.addEventListener("error", () => reject(new Error("refused")));
	});

	return {
		frames,
		socket,
		ask(kind: string, payload: Record<string, unknown> = {}) {
			let rid = `${handle}-${++n}`;
			return new Promise<Frame>(resolve => {
				waiting.set(rid, resolve);
				socket.send(JSON.stringify({ kind, ts: 0, rid, ...payload }));
			});
		},
		send(kind: string, payload: Record<string, unknown> = {}) {
			socket.send(JSON.stringify({ kind, ts: 0, rid: `${handle}-${++n}`, ...payload }));
		},
	};
}

/** Frames arrive on their own schedule; wait for the one being asserted on. */
async function until<T>(read: () => T | undefined, label: string): Promise<T> {
	for (let i = 0; i < 200; i++) {
		let value = read();
		if (value !== undefined) return value;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function seen(frames: Frame[], kind: string) {
	return () => frames.findLast(frame => frame.kind === kind);
}

type Member = {
	frames: Frame[];
	socket: WebSocket;
	ask(kind: string, payload?: Record<string, unknown>): Promise<Frame>;
	send(kind: string, payload?: Record<string, unknown>): void;
};

/** Mark the sentence, and hand back the thread it made. */
async function mark(who: Member, text = "Too long.") {
	let reply = await who.ask("comment:start", {
		blocks: [1],
		quote: QUOTE,
		offset: 0,
		length: QUOTE.length,
		text,
	});
	if (!reply.ok) throw new Error(`could not mark: ${JSON.stringify(reply)}`);
	return (reply.thread as { id: string }).id;
}

beforeAll(async () => {
	data = await mkdtemp(join(tmpdir(), "chopin-wire-"));
	// Every room this file uses, seeded so there is prose worth marking.
	for (let room of ["marking", "replies", "accepting", "joining", "chatting"]) {
		await mkdir(join(data, room), { recursive: true });
		await writeFile(join(data, room, "plan.mdx"), SOURCE);
	}

	server = Bun.spawn(["bun", `${import.meta.dir}/main.ts`], {
		env: {
			...process.env,
			PORT: String(PORT),
			SERVER_HOST: "127.0.0.1",
			AGENT: "off",
			DATA_DIR: data,
		},
		stdout: "ignore",
		stderr: "inherit",
	});

	for (let i = 0; i < 200; i++) {
		try {
			await fetch(`http://${ORIGIN}/`);
			return;
		} catch {
			await Bun.sleep(20);
		}
	}
	throw new Error("server did not start");
});

describe("room messages", () => {
	it("reach both members when the agent is off", async () => {
		let ana = await member("chatting", "ana");
		let kris = await member("chatting", "kris");
		await ana.ask("plan:open", {});
		await kris.ask("plan:open", {});

		ana.send("chat:send", { text: "The room should see this.", to: "room" });

		for (let each of [ana, kris]) {
			let delivered = await until(seen(each.frames, "chat:message"), "room message");
			expect(delivered.entry).toMatchObject({
				author: { kind: "member", handle: "ana" },
				text: "The room should see this.",
			});
		}

		ana.socket.close();
		kris.socket.close();
	});
});

afterAll(async () => {
	server.kill();
	await rm(data, { recursive: true, force: true });
});

describe("marking a passage", () => {
	it("answers the request that asked, and tells the other member", async () => {
		let ana = await member("marking", "ana");
		let kris = await member("marking", "kris");
		await ana.ask("plan:open", {});
		await kris.ask("plan:open", {});

		let id = await mark(ana);

		let opened = await until(seen(kris.frames, "comment:opened"), "comment:opened");
		expect((opened.thread as { id: string }).id).toBe(id);
		// The author already has it from the reply; echoing it would be a
		// second copy of the same thread.
		expect(ana.frames.filter(frame => frame.kind === "comment:opened")).toHaveLength(0);

		ana.socket.close();
		kris.socket.close();
	});

	it("says where it points on the anchors snapshot, not with the thread", async () => {
		let ana = await member("marking", "ana");
		await ana.ask("plan:open", {});
		let id = await mark(ana);

		let anchors = await until(
			() => {
				let frame = ana.frames.findLast(each => each.kind === "plan:anchors");
				let threads = frame?.threads as Array<{ thread: string }> | undefined;
				return threads?.some(each => each.thread === id) ? frame : undefined;
			},
			"plan:anchors carrying the thread",
		);

		let pointed = (anchors.threads as Array<{ thread: string; subject: { quote: string } }>)
			.find(each => each.thread === id);
		expect(pointed?.subject.quote).toBe(QUOTE);

		ana.socket.close();
	});

	it("refuses a selection the plan no longer holds", async () => {
		let ana = await member("marking", "ana");
		await ana.ask("plan:open", {});

		let reply = await ana.ask("comment:start", {
			blocks: [0],
			quote: QUOTE,
			offset: 0,
			length: QUOTE.length,
			text: "Too long.",
		});

		expect(reply).toMatchObject({ ok: false, reason: "invalid" });
		ana.socket.close();
	});
});

describe("talking in a thread", () => {
	it("carries a reply to everyone else", async () => {
		let ana = await member("replies", "ana");
		let kris = await member("replies", "kris");
		await ana.ask("plan:open", {});
		await kris.ask("plan:open", {});
		let id = await mark(ana);

		let reply = await kris.ask("comment:reply", { id, text: "Agreed." });
		expect(reply.ok).toBe(true);

		let said = await until(seen(ana.frames, "comment:said"), "comment:said");
		expect(said.note as { handle: string; text: string }).toMatchObject({
			handle: "kris",
			text: "Agreed.",
		});

		ana.socket.close();
		kris.socket.close();
	});

	it("relays who is writing, and who has stopped", async () => {
		let ana = await member("replies", "ana");
		let kris = await member("replies", "kris");
		await ana.ask("plan:open", {});
		await kris.ask("plan:open", {});
		let id = await mark(ana);

		kris.send("comment:typing", { id, writing: true });
		let started = await until(seen(ana.frames, "comment:typing"), "typing");
		expect(started).toMatchObject({ handle: "kris", writing: true });

		kris.send("comment:typing", { id, writing: false });
		await until(
			() => {
				let last = ana.frames.findLast(frame => frame.kind === "comment:typing");
				return last?.writing === false ? last : undefined;
			},
			"typing stopped",
		);

		ana.socket.close();
		kris.socket.close();
	});
});

describe("resolving a thread", () => {
	it("tells the whole room, including whoever did it", async () => {
		let ana = await member("accepting", "ana");
		let kris = await member("accepting", "kris");
		await ana.ask("plan:open", {});
		await kris.ask("plan:open", {});
		let id = await mark(ana);

		let accepted = await kris.ask("comment:accept", { id });
		expect(accepted).toMatchObject({ ok: true, resolver: "kris" });

		// A broadcast, not a relay: the resolver's own sidecar has to freeze too.
		for (let each of [ana, kris]) {
			let resolved = await until(seen(each.frames, "comment:resolved"), "comment:resolved");
			expect(resolved).toMatchObject({ id, status: "accepted", resolver: "kris", quote: QUOTE });
		}

		ana.socket.close();
		kris.socket.close();
	});

	it("says in the transcript why the agent would have moved", async () => {
		let ana = await member("accepting", "ana");
		await ana.ask("plan:open", {});
		let id = await mark(ana, "Make it ten.");
		await ana.ask("comment:accept", { id });

		let lines = await until(
			() => {
				let said = ana.frames
					.filter(frame => frame.kind === "chat:message")
					.map(frame => (frame.entry as { author: { kind: string }; text: string }))
					.filter(entry => entry.author.kind === "system")
					.map(entry => entry.text);
				return said.length >= 2 ? said : undefined;
			},
			"system transcript lines",
		);

		expect(lines[0]).toContain("accepted a comment");
		expect(lines[0]).toContain(QUOTE);
		// `AGENT=off` in this run, so the turn is skipped and says so rather
		// than a session failing to open behind the scenes.
		expect(lines[1]).toContain("agent is not running");

		ana.socket.close();
	});

	it("refuses anything said after it is closed", async () => {
		let ana = await member("accepting", "ana");
		await ana.ask("plan:open", {});
		let id = await mark(ana);
		await ana.ask("comment:accept", { id });

		let late = await ana.ask("comment:reply", { id, text: "One more thing." });
		expect(late).toMatchObject({ ok: false, reason: "resolved" });

		ana.socket.close();
	});

	/** Arriving second is not a failure: the outcome is what was wanted. */
	it("tells the second resolver what happened rather than that it failed", async () => {
		let ana = await member("accepting", "ana");
		let kris = await member("accepting", "kris");
		await ana.ask("plan:open", {});
		await kris.ask("plan:open", {});
		let id = await mark(ana);

		await ana.ask("comment:accept", { id });
		let second = await kris.ask("comment:dismiss", { id });

		expect(second).toMatchObject({
			ok: false,
			reason: "resolved",
			status: "accepted",
			resolver: "ana",
		});

		ana.socket.close();
		kris.socket.close();
	});
});

describe("arriving late", () => {
	/**
	 * A client learns about existing threads from opening the plan, not from
	 * connecting: the sidecar has to show what everyone else is already
	 * looking at.
	 */
	it("is told about the threads already open", async () => {
		let ana = await member("joining", "ana");
		await ana.ask("plan:open", {});
		let id = await mark(ana);

		let kris = await member("joining", "kris");
		await kris.ask("plan:open", {});

		let sync = await until(seen(kris.frames, "comment:sync"), "comment:sync");
		let threads = sync.threads as Array<{ id: string; notes: unknown[] }>;
		expect(threads.map(thread => thread.id)).toContain(id);
		expect(threads[0]?.notes).toHaveLength(1);

		ana.socket.close();
		kris.socket.close();
	});

	it("is not told about one that was dismissed", async () => {
		let ana = await member("joining", "ana");
		await ana.ask("plan:open", {});
		let id = await mark(ana, "Never mind.");
		await ana.ask("comment:dismiss", { id });

		let kris = await member("joining", "kris");
		await kris.ask("plan:open", {});

		let sync = await until(seen(kris.frames, "comment:sync"), "comment:sync");
		let threads = sync.threads as Array<{ id: string }>;
		expect(threads.map(thread => thread.id)).not.toContain(id);

		ana.socket.close();
		kris.socket.close();
	});
});
