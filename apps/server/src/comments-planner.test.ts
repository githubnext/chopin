/**
 * Sending a comment to the Planner.
 *
 * What matters: the note is durable and the room has it before any turn is
 * asked for; a full queue refuses before anything is saved; one thread never
 * queues two turns; the Planner may only speak in the thread its turn was sent;
 * and when it forgets to, its last word in Chat is posted there for it.
 */

import { afterEach, describe, expect, it } from "bun:test";

import * as Chat from "./chat/service";
import * as Comments from "./comments/service";
import * as Service from "./plan/service";
import * as room from "./plan/room";
import { openPlan } from "./testing/plan";

import type { Config } from "./config";
import type { Plan } from "./plan/service";
import type { Socket } from "./wire";

const SOURCE = `# Title

The renderer caches tiles for 60 seconds.

The second paragraph.
`;

const QUOTE = "caches tiles for 60 seconds";

type Sent = { kind: string; [key: string]: unknown };

let opens: Plan[] = [];

afterEach(async () => {
	for (let plan of opens) await Service.close(plan);
	opens = [];
});

/** A room whose Planner is busy, so instructions queue rather than open a session. */
async function opened(options: { agent?: boolean; busy?: boolean } = {}) {
	let fixture = await openPlan(SOURCE);
	let { broadcasts, plan, server } = fixture;
	opens.push(plan);
	plan.chat.busy = options.busy ?? true;
	let context: Chat.Room = {
		chat: plan.chat,
		config: { agent: options.agent ?? true } as Config,
		plan,
		room: "test",
		server,
		auth: {} as Chat.Room["auth"],
		claimantSessionId: "session",
		repository: { id: "repo", owner: "owner", name: "repo", defaultBranch: "main" },
		persist: chat => Service.persist(plan, chat),
	};
	return { broadcasts: broadcasts as Sent[], context, plan, server, storage: fixture.storage };
}

function member(handle: string) {
	let replies: Sent[] = [];
	let relayed: Sent[] = [];
	let socket = {
		data: { handle, client: `client-${handle}`, room: "test" },
		send(raw: string) {
			replies.push(JSON.parse(raw) as Sent);
		},
		publish(_topic: string, raw: string) {
			relayed.push(JSON.parse(raw) as Sent);
		},
	} as unknown as Socket;
	return { relayed, replies, socket };
}

let rid = 0;
function ask<T extends object>(payload: T) {
	return { ts: 0, rid: `r${++rid}`, ...payload } as T & { ts: number; rid: string };
}

async function start(
	context: Chat.Room,
	who: ReturnType<typeof member>,
	text = "Rephrase this.",
	to: "planner" | null = "planner",
) {
	await Comments.start(
		context.plan,
		context.server,
		"test",
		who.socket,
		ask({
			kind: "comment:start" as const,
			blocks: [1],
			quote: QUOTE,
			offset: 0,
			length: QUOTE.length,
			text,
			...(to ? { to } : {}),
		}),
		to ? context : undefined,
	);
	return who.replies.findLast(frame => frame.kind === "comment:start");
}

async function reply(
	context: Chat.Room,
	who: ReturnType<typeof member>,
	id: string,
	text: string,
	to: "planner" | null = "planner",
) {
	await Comments.respond(
		context.plan,
		who.socket,
		ask({ kind: "comment:reply" as const, id, text, ...(to ? { to } : {}) }),
		to ? context : undefined,
	);
	return who.replies.findLast(frame => frame.kind === "comment:reply");
}

/** The thread a successful `comment:start` reply carries. */
function idOf(answered: Sent | undefined): string {
	let thread = answered?.thread as { id: string } | undefined;
	if (!thread) throw new Error(`no thread was started: ${JSON.stringify(answered)}`);
	return thread.id;
}

function working(broadcasts: Sent[]) {
	return broadcasts.filter(frame => frame.kind === "comment:working");
}

describe("sending a new comment to the Planner", () => {
	it("saves the note, tells the room, then queues a turn about the thread", async () => {
		let { broadcasts, context, plan, storage } = await opened();
		let ana = member("ana");

		let answered = await start(context, ana);

		expect(answered).toMatchObject({ ok: true, planner: "queued" });
		let thread = answered?.thread as { id: string; notes: unknown[] };
		expect(thread.notes[0]).toMatchObject({
			author: "member",
			handle: "ana",
			to: "planner",
			text: "Rephrase this.",
		});
		expect(ana.relayed[0]).toMatchObject({ kind: "comment:opened" });

		// Durable before the turn is asked for.
		let saved = await storage.collaboration.load(plan.id, new Date());
		expect(JSON.stringify(saved?.sidecar)).toContain("Rephrase this.");

		let waiting = plan.chat.waiting.find(item => item.thread === thread.id);
		expect(waiting?.text).toContain("Rephrase this.");
		expect(waiting?.text).toContain(`thread ${thread.id}`);
		expect(waiting?.handle).toBe("ana");

		let notice = plan.chat.entries.at(-1);
		expect(notice).toMatchObject({
			author: { kind: "system" },
			text: `Comment on “${QUOTE}” sent to Chopin`,
			comment: { thread: thread.id, excerpt: QUOTE, note: "Rephrase this." },
		});
		expect(working(broadcasts)).toEqual([
			expect.objectContaining({ id: thread.id, working: true }),
		]);
	});

	it("never reads a mention out of the text: only the destination addresses the Planner", async () => {
		let { context, plan } = await opened();
		let ana = member("ana");

		let answered = await start(context, ana, "@chopin rephrase this", null);

		expect(answered).toMatchObject({ ok: true });
		expect(answered).not.toHaveProperty("planner");
		expect((answered!.thread as { notes: Array<{ to?: string }> }).notes[0]?.to)
			.toBeUndefined();
		expect(plan.chat.waiting).toHaveLength(0);
	});

	it("refuses before saving anything when the Planner's queue is full", async () => {
		let { context, plan } = await opened();
		for (let i = 0; i < 20; i++) plan.chat.waiting.push({ id: `w${i}`, handle: "kris", text: "x" });
		let ana = member("ana");

		let answered = await start(context, ana);

		expect(answered).toMatchObject({ ok: false, reason: "busy" });
		expect(plan.threads.size).toBe(0);
		expect(plan.chat.waiting).toHaveLength(20);
	});

	it("saves the note but says so when no Planner is running", async () => {
		let { broadcasts, context, plan } = await opened({ agent: false });
		let ana = member("ana");

		let answered = await start(context, ana);

		expect(answered).toMatchObject({ ok: true, planner: "off" });
		expect(plan.threads.size).toBe(1);
		expect(plan.chat.waiting).toHaveLength(0);
		expect(plan.chat.entries).toHaveLength(0);
		expect(working(broadcasts)).toEqual([
			expect.objectContaining({ working: false, reason: "off" }),
		]);
	});

	it("says the turn failed when no session could be opened for it", async () => {
		let { broadcasts, context } = await opened({ busy: false });
		let ana = member("ana");

		let answered = await start(context, ana);
		expect(answered).toMatchObject({ ok: true, planner: "running" });
		let id = idOf(answered);
		await context.chat.running;

		expect(working(broadcasts).at(-1)).toEqual(
			expect.objectContaining({ id, working: false, reason: "failed" }),
		);
		expect(context.plan.threads.get(id)?.notes).toHaveLength(1);
	});
});

describe("one thread, one turn", () => {
	it("folds a later note into the turn already waiting for its thread", async () => {
		let { context, plan } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));

		let answered = await reply(context, member("kris"), id, "And shorten it.");

		expect(answered).toMatchObject({ ok: true, planner: "queued" });
		let queued = plan.chat.waiting.filter(item => item.thread === id);
		expect(queued).toHaveLength(1);
		expect(queued[0]?.text).toContain("And shorten it.");
		expect(queued[0]?.handle).toBe("kris");
		// Folding is not refused by a full queue: it adds nothing to it.
		expect(Chat.admission(context, id)).toBe("queued");
	});

	it("queues one follow-up while a turn for the thread is running", async () => {
		let { context, plan } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));
		// The queued turn starts: it leaves the queue and becomes the running one.
		plan.chat.waiting = [];
		plan.chat.acting = id;

		await reply(context, ana, id, "One more thing.");
		await reply(context, ana, id, "And another.");

		let queued = plan.chat.waiting.filter(item => item.thread === id);
		expect(queued).toHaveLength(1);
		expect(queued[0]?.text).toContain("And another.");
	});

	it("drops a waiting turn once its thread is resolved, and stops working", async () => {
		let { broadcasts, context, plan, server } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));

		await Comments.resolve(
			plan,
			server,
			"test",
			ana.socket,
			ask({
				kind: "comment:resolve" as const,
				id,
			}),
		);
		expect(Comments.working(plan, id)).toBe(false);
		expect(Chat.pending(plan.chat)).toBeUndefined();
		await Bun.sleep(0);

		expect(working(broadcasts).at(-1)).toEqual(
			expect.objectContaining({ id, working: false }),
		);
	});
});

describe("how a turn ends on its thread", () => {
	async function ending(status: Chat.Ended["status"], text?: string) {
		let fixture = await opened();
		let ana = member("ana");
		let id = idOf(await start(fixture.context, ana));
		let waiting = fixture.plan.chat.waiting.shift()!;
		fixture.plan.chat.acting = id;
		return {
			...fixture,
			ana,
			end: () => waiting.ended!({ status, ...(text ? { text } : {}) }),
			id,
		};
	}

	it("posts the Planner's last word in Chat when it never replied in the thread", async () => {
		let { broadcasts, end, id, plan, storage } = await ending("done", "Shortened it to 30s.");

		await end();

		let notes = plan.threads.get(id)!.notes;
		expect(notes.at(-1)).toMatchObject({ author: "planner", text: "Shortened it to 30s." });
		expect(broadcasts).toContainEqual(expect.objectContaining({ kind: "comment:said", id }));
		let saved = await storage.collaboration.load(plan.id, new Date());
		expect(JSON.stringify(saved?.sidecar)).toContain("Shortened it to 30s.");
		expect(working(broadcasts).at(-1)).toEqual(
			expect.objectContaining({ id, working: false }),
		);
		expect(working(broadcasts).at(-1)).not.toHaveProperty("reason");
	});

	it("does not repeat itself when the Planner already replied", async () => {
		let { end, id, plan, server } = await ending("done", "Shortened it.");

		expect(await Comments.answer(plan, server, "test", id, "Done — 30s now.")).toMatchObject({
			ok: true,
		});
		await end();

		let notes = plan.threads.get(id)!.notes;
		expect(notes.filter(note => note.author === "planner")).toHaveLength(1);
	});

	it("says why it stopped", async () => {
		for (let status of ["stopped", "failed"] as const) {
			let { broadcasts, end, id, plan } = await ending(status, "Half a thought");
			await end();
			expect(plan.threads.get(id)!.notes).toHaveLength(1);
			expect(working(broadcasts).at(-1)).toEqual(
				expect.objectContaining({ id, working: false, reason: status }),
			);
		}
	});
});

describe("a note that arrives while Chopin is working", () => {
	it("is answered by its own turn, not by the running turn's last word", async () => {
		let { broadcasts, context, plan } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));
		let running = plan.chat.waiting.shift()!;
		plan.chat.acting = id;
		running.started?.();

		await reply(context, ana, id, "Also, what about tunnels?");
		expect(Chat.queuedFor(plan.chat, id)).toBeDefined();
		await running.ended!({ status: "done", text: "Unrelated chatter about the header." });

		expect(plan.threads.get(id)!.notes.some(note => note.author === "planner")).toBe(false);
		expect(working(broadcasts).at(-1)).toEqual(expect.objectContaining({ id, working: true }));
	});

	it("does not count notes the turn never saw", async () => {
		let { context, plan, server } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));
		let running = plan.chat.waiting.shift()!;
		plan.chat.acting = id;
		running.started?.();
		await Comments.answer(plan, server, "test", id, "Shortened it.");
		await reply(context, ana, id, "And the next one?");
		// The follow-up is withdrawn, so nothing is queued when the first turn ends.
		let follow = Chat.queuedFor(plan.chat, id)!;
		plan.chat.waiting = plan.chat.waiting.filter(item => item !== follow);
		await follow.ended!({ status: "skipped" });

		await running.ended!({ status: "done", text: "Unrelated chatter." });

		let planner = plan.threads.get(id)!.notes.filter(note => note.author === "planner");
		expect(planner.map(note => note.text)).toEqual(["Shortened it."]);
	});
});

describe("the Planner's reply", () => {
	it("is refused for any thread but the one its turn was sent", async () => {
		let { context, plan, server } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));

		expect(await Comments.answer(plan, server, "test", id, "Hello")).toMatchObject({
			ok: false,
			reason: "not-asked",
		});
		expect(plan.threads.get(id)!.notes).toHaveLength(1);
	});

	it("is refused once the thread is resolved", async () => {
		let { context, plan, server } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));
		plan.chat.acting = id;
		await Comments.resolve(
			plan,
			server,
			"test",
			ana.socket,
			ask({
				kind: "comment:resolve" as const,
				id,
			}),
		);

		expect(await Comments.answer(plan, server, "test", id, "Done")).toMatchObject({
			ok: false,
			reason: "resolved",
		});
	});

	it("tells nobody, and keeps nothing, when it cannot be saved", async () => {
		let { broadcasts, context, plan, server } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));
		plan.chat.acting = id;
		broadcasts.length = 0;

		let original = plan.persistence.storage.collaboration.commit;
		let fatal = plan.persistence.fatal;
		plan.persistence.fatal = () => {};
		plan.persistence.storage.collaboration.commit = () => Promise.reject(new Error("disk full"));
		let quiet = console.error;
		console.error = () => {};
		let outcome: unknown;
		try {
			outcome = await Comments.answer(plan, server, "test", id, "Done").catch(err => err);
		} finally {
			console.error = quiet;
			plan.persistence.storage.collaboration.commit = original;
			plan.persistence.fatal = fatal;
		}
		await Service.persist(plan);

		expect(outcome).toBeInstanceOf(Error);
		expect(broadcasts.filter(frame => frame.kind === "comment:said")).toEqual([]);
		expect(plan.threads.get(id)!.notes).toHaveLength(1);
	});
});

describe("what a thread looks like to someone joining", () => {
	it("says the Planner is working while its turn is waiting, and only then", async () => {
		let { context, plan } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));

		let joiner = member("kris");
		Comments.greet(plan, joiner.socket);
		let sync = joiner.replies.find(frame => frame.kind === "comment:sync");
		expect(sync?.threads).toEqual([expect.objectContaining({ id, working: true })]);

		plan.chat.waiting = [];
		Comments.greet(plan, joiner.socket);
		let later = joiner.replies.findLast(frame => frame.kind === "comment:sync");
		expect((later!.threads as Array<object>)[0]).not.toHaveProperty("working");
	});

	it("keeps a resolved thread that changed the plan, and drops one that did not", async () => {
		let { context, plan, server } = await opened();
		let ana = member("ana");
		let changed = idOf(await start(context, ana));
		Comments.attribute(plan, changed, [1]);
		await Comments.resolve(
			plan,
			server,
			"test",
			ana.socket,
			ask({
				kind: "comment:resolve" as const,
				id: changed,
			}),
		);

		let joiner = member("kris");
		Comments.greet(plan, joiner.socket);
		let sync = joiner.replies.find(frame => frame.kind === "comment:sync");
		expect(sync?.threads).toEqual([expect.objectContaining({ id: changed, status: "resolved" })]);
		expect(Comments.anchors(plan)).toEqual([
			expect.objectContaining({
				thread: changed,
				result: expect.objectContaining({ pending: false }),
			}),
		]);
	});

	it("gathers what each turn on an open thread anchored", async () => {
		let { context, plan } = await opened();
		let id = idOf(await start(context, member("ana")));
		let digests = room.digests(plan.document);

		expect(Comments.relate(plan, id, [{ index: 1, digest: digests[1]! }])).toBeUndefined();
		expect(Comments.relate(plan, id, [{ index: 2, digest: digests[2]! }])).toBeUndefined();
		expect(Comments.relate(plan, id, [{ index: 2, digest: digests[2]! }])).toBeUndefined();

		expect(plan.threads.get(id)?.result?.anchors).toHaveLength(2);
	});

	it("reads notes saved before notes named their author as a member's", () => {
		let record = Comments.normalize({
			id: "t",
			status: "open",
			passage: {} as never,
			notes: [{ id: "n", handle: "ana", text: "Old.", ts: 1 } as never],
		});
		expect(record.notes[0]).toEqual({
			id: "n",
			author: "member",
			handle: "ana",
			text: "Old.",
			ts: 1,
		});
	});
});
