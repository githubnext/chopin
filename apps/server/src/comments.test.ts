/**
 * Commenting on the plan.
 *
 * The properties worth holding onto: a thread is frozen while it is resolved,
 * reopening undoes that completely, neither changes the document, and the room
 * hears about either only once it is durable. Threads accepted under the
 * earlier lifecycle still load and still owe the agent a review.
 */

import { afterEach, describe, expect, it } from "bun:test";

import * as Comments from "./comments/service";
import * as room from "./plan/room";
import * as Service from "./plan/service";
import * as Store from "./comments/store";
import { openPlan } from "./testing/plan";

import type { Server } from "bun";
import type { Document } from "./plan/room";
import type { Record } from "./comments/service";
import type { Plan } from "./plan/service";
import type { SeedState } from "./testing/plan";
import type { Socket, SocketData } from "./wire";

const SOURCE = `# Title

The renderer caches tiles for 60 seconds.

The second paragraph.
`;

const QUOTE = "caches tiles for 60 seconds";

async function document(source = SOURCE): Promise<Document> {
	return room.create(source);
}

/** A thread on a real passage, the way `comment:start` builds one. */
function thread(doc: Document, handle = "ana"): { records: Store.Records; record: Record } {
	let passage = room.passageAt(doc, [1], QUOTE, 0, QUOTE.length);

	let record: Record = {
		id: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
		status: "open",
		passage,
		notes: [Store.note(handle, "60s is too long.")],
	};

	return { records: new Map([[record.id, record]]), record };
}

// -- a room, for the parts that need the service rather than the store -------

let opens: Plan[] = [];

afterEach(async () => {
	for (let plan of opens) await Service.close(plan);
	opens = [];
});

/** Frames the room sent, and to whom. */
type Sent = { kind: string; [key: string]: unknown };

async function opened(source = SOURCE, state?: SeedState) {
	let fixture = await openPlan(source, state ?? {});
	let { broadcasts, plan, server } = fixture;
	opens.push(plan);
	return {
		broadcasts,
		plan,
		server,
		/**
		 * Make one kind of frame fail to relay.
		 *
		 * One kind rather than all of them: Bun's pub/sub does not throw for a
		 * topic nobody is on, so breaking everything would be simulating a
		 * failure that cannot happen and armouring the code against it. What
		 * can be reasoned about is what happens if a particular relay is lost.
		 */
		breakRelay: (kind: string) => {
			fixture.breakRelay(kind);
		},
	};
}

/** A socket that records what was said to it, and what was said past it. */
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

/** A thread accepted under the earlier lifecycle, as storage still holds some. */
function accept(plan: Plan, id: string): void {
	let record = plan.threads.get(id)!;
	plan.threads.set(id, { ...record, status: "accepted", resolver: "ana", at: 1, quote: QUOTE });
}

/** Resolve over the wire, the way a client's `comment:resolve` does. */
function resolve(
	plan: Plan,
	server: Server<SocketData>,
	who: ReturnType<typeof member>,
	id: string,
) {
	return Comments.resolve(
		plan,
		server,
		"test",
		who.socket,
		ask({ kind: "comment:resolve" as const, id }),
	);
}

function reopen(
	plan: Plan,
	server: Server<SocketData>,
	who: ReturnType<typeof member>,
	id: string,
) {
	return Comments.reopen(
		plan,
		server,
		"test",
		who.socket,
		ask({ kind: "comment:reopen" as const, id }),
	);
}

/** Mark the sentence, the way a client's `comment:start` does. */
async function mark(
	plan: Plan,
	server: Server<SocketData>,
	who: ReturnType<typeof member>,
	text = "Too long.",
): Promise<string> {
	await Comments.start(
		plan,
		server,
		"test",
		who.socket,
		ask({
			kind: "comment:start" as const,
			blocks: [1],
			quote: QUOTE,
			offset: 0,
			length: QUOTE.length,
			text,
		}),
	);

	let reply = who.replies.findLast(frame => frame.kind === "comment:start");
	let thread = reply?.thread as { id: string } | undefined;
	if (!thread) throw new Error(`no thread was started: ${JSON.stringify(reply)}`);
	return thread.id;
}

describe("a thread while it is open", () => {
	it("collects what people say, in order", async () => {
		let { records, record } = thread(await document());
		let threads = Store.create();

		expect(Store.reply(threads, records, record.id, "kris", "Agreed.").ok).toBe(true);

		expect(records.get(record.id)!.notes.map(note => note.handle)).toEqual(["ana", "kris"]);
	});

	it("refuses a thread nobody started", async () => {
		let { records } = thread(await document());
		let outcome = Store.reply(Store.create(), records, "nope", "kris", "Hello?");

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe("missing");
	});

	it("stops taking comments once a thread is long enough to be a conversation", async () => {
		let { records, record } = thread(await document());
		let threads = Store.create();

		for (let i = record.notes.length; i < Store.MAX_NOTES; i++) {
			Store.reply(threads, records, record.id, "kris", `note ${i}`);
		}
		let outcome = Store.reply(threads, records, record.id, "kris", "one more");

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.reason).toBe("full");
	});

	/** Fifty unresolved threads says the room has stopped resolving things. */
	it("refuses a new thread once too many are unresolved", async () => {
		let { records } = thread(await document());
		let sample = records.values().next().value!;
		// One short of the cap, counting the thread already there.
		for (let i = 1; i < Store.MAX_OPEN - 1; i++) {
			records.set(`extra-${i}`, { ...sample, id: `extra-${i}` });
		}

		expect(Store.room(records)).toBeUndefined();
		records.set("one-more", { ...sample, id: "one-more" });
		expect(Store.room(records)?.reason).toBe("full");
	});
});

describe("resolving a thread", () => {
	it("freezes it, and refuses anything said afterwards", async () => {
		let { records, record } = thread(await document());
		let threads = Store.create();

		expect(Store.resolve(threads, records, record.id, "kris", QUOTE).ok).toBe(true);

		expect(records.get(record.id)!.status).toBe("resolved");
		expect(records.get(record.id)!.quote).toBe(QUOTE);

		let late = Store.reply(threads, records, record.id, "ana", "Actually…");
		expect(late.ok).toBe(false);
		if (!late.ok) expect(late.reason).toBe("resolved");
	});

	/**
	 * Arriving second is not a failure. The thing the caller wanted to know is
	 * already decided, so they are told the outcome rather than an error.
	 */
	it("tells the loser of a race what happened, not that it failed", async () => {
		let { records, record } = thread(await document());
		let threads = Store.create();

		Store.resolve(threads, records, record.id, "kris", QUOTE);
		let second = Store.resolve(threads, records, record.id, "ana", QUOTE);

		expect(second).toMatchObject({
			ok: false,
			reason: "resolved",
			status: "resolved",
			resolver: "kris",
		});
	});

	/**
	 * The tombstone answers before the record does, so one left behind would
	 * keep refusing replies to a thread that is open again.
	 */
	it("takes replies again once reopened, tombstone and all", async () => {
		let { records, record } = thread(await document());
		let threads = Store.create();

		Store.resolve(threads, records, record.id, "kris", QUOTE);
		expect(threads.closed.has(record.id)).toBe(true);

		let reopened = Store.reopen(threads, records, record.id);
		expect(reopened.ok).toBe(true);
		expect(threads.closed.has(record.id)).toBe(false);
		expect(records.get(record.id)).not.toHaveProperty("resolver");
		expect(records.get(record.id)).not.toHaveProperty("quote");
		expect(Store.reply(threads, records, record.id, "ana", "Still talking.").ok).toBe(true);
	});

	it("will not reopen past the ceiling on unresolved threads", async () => {
		let { records, record } = thread(await document());
		let threads = Store.create();
		Store.resolve(threads, records, record.id, "kris", QUOTE);
		for (let i = 0; i < Store.MAX_OPEN; i++) {
			records.set(`open-${i}`, { ...record, id: `open-${i}`, status: "open" });
		}

		expect(Store.reopen(threads, records, record.id)).toMatchObject({ ok: false, reason: "full" });
		expect(records.get(record.id)!.status).toBe("resolved");
		expect(threads.closed.has(record.id)).toBe(true);
	});

	it("reopens only what was resolved", async () => {
		let { records, record } = thread(await document());
		let threads = Store.create();

		expect(Store.reopen(threads, records, record.id)).toMatchObject({ ok: false, reason: "open" });
		records.set(record.id, { ...record, status: "accepted" });
		expect(Store.reopen(threads, records, record.id)).toMatchObject({
			ok: false,
			reason: "settled",
		});
		expect(Store.reopen(threads, records, "nope")).toMatchObject({ ok: false, reason: "missing" });
	});
});

describe("projecting a decision", () => {
	it("puts an accepted thread into the plan, and leaves a dismissed one out", async () => {
		let doc = await document();
		let { record } = thread(doc);

		room.insertDecision(doc, {
			id: record.id,
			quote: QUOTE,
			by: "kris",
			at: "2026-07-28T10:14:00Z",
			notes: record.notes.map(note => ({ by: note.handle, text: note.text })),
		});

		let source = room.project(doc);
		expect(source).toContain(`<Decision id="${record.id}"`);
		expect(source).toContain('by="kris"');
		expect(source).toContain("60s is too long.");
		// And the prose it marks is untouched: a decision is recorded beside
		// the plan, not written into the sentence it concerns.
		expect(source).toContain("The renderer caches tiles for 60 seconds.");
	});

	it("survives the round trip back off disk", async () => {
		let doc = await document();
		let { record } = thread(doc);

		room.insertDecision(doc, {
			id: record.id,
			quote: QUOTE,
			by: "kris",
			at: "2026-07-28T10:14:00Z",
			notes: [{ by: "ana", text: "Line one.\nLine two." }],
		});

		// What `plan.mdx` would hold, read back as the server reads it on boot.
		expect(() => room.validate(room.project(doc))).not.toThrow();
	});
});

describe("a thread across a restart", () => {
	/**
	 * A restart is an epoch rotation: every stored position was expressed in a
	 * history the new document does not have. The quote is the only way back,
	 * and it has to happen before anybody joins — a client that resolves
	 * nothing shows a thread with no highlight and no way to tell why.
	 */
	it("recovers its passage against a document it has never seen", async () => {
		let doc = await document();
		let { record } = thread(doc);

		// The same source, under a fresh epoch, as `open` rebuilds it on boot.
		let restarted = await room.replace(room.project(doc));
		expect(room.locate(restarted, record.passage)).toBeUndefined();

		let carried = room.rebasePassage(restarted, record.passage);
		expect(carried.drifted).toBeUndefined();
		expect(room.locate(restarted, carried)).toBeDefined();
		expect(carried.quote).toBe(QUOTE);
	});
});

describe("marking a passage over the wire", () => {
	it("mints the thread and tells the rest of the room where it points", async () => {
		let { broadcasts, plan, server } = await opened();
		let ana = member("ana");
		let id = await mark(plan, server, ana);

		expect(ana.replies[0]).toMatchObject({ kind: "comment:start", ok: true });
		expect(ana.relayed[0]).toMatchObject({ kind: "comment:opened" });

		// The passage never rides with the thread; it comes on plan:anchors,
		// which has to follow immediately or the card has nothing to highlight.
		expect(ana.replies[0]?.thread).not.toHaveProperty("passage");
		let anchors = broadcasts.findLast(frame => frame.kind === "plan:anchors");
		let pointed = (anchors?.threads as Array<{ thread: string }> | undefined)
			?.find(each => each.thread === id);
		expect(pointed).toMatchObject({ subject: { quote: QUOTE } });
	});

	/**
	 * Finding the quote is the concurrency check. Naming a block that no longer
	 * holds the phrase has to be refused rather than marking whatever is there.
	 */
	it("refuses a selection the plan has moved out from under", async () => {
		let { plan, server } = await opened();
		let ana = member("ana");

		Comments.start(
			plan,
			server,
			"test",
			ana.socket,
			ask({
				kind: "comment:start" as const,
				blocks: [0],
				quote: QUOTE,
				offset: 0,
				length: QUOTE.length,
				text: "Too long.",
			}),
		);

		expect(ana.replies[0]).toMatchObject({ ok: false, reason: "invalid" });
		expect(plan.threads.size).toBe(0);
	});

	it("refuses a comment with nothing in it", async () => {
		let { plan, server } = await opened();
		let ana = member("ana");

		Comments.start(
			plan,
			server,
			"test",
			ana.socket,
			ask({
				kind: "comment:start" as const,
				blocks: [1],
				quote: QUOTE,
				offset: 0,
				length: QUOTE.length,
				text: "   ",
			}),
		);

		expect(ana.replies[0]).toMatchObject({ ok: false, reason: "invalid" });
		expect(plan.threads.size).toBe(0);
	});

	it("keeps a resolved thread off the wire for whoever joins next", async () => {
		let { plan, server } = await opened();
		let ana = member("ana");
		let id = await mark(plan, server, ana);
		await resolve(plan, server, ana, id);

		let joiner = member("kris");
		Comments.greet(plan, joiner.socket);

		let sync = joiner.replies.find(frame => frame.kind === "comment:sync");
		expect(sync?.threads).toEqual([]);
		// The record survives; it is only hidden.
		expect(plan.threads.get(id)?.status).toBe("resolved");
	});
});

describe("resolving and reopening, as the service orders it", () => {
	it("answers, tells the room, and drops the thread from the anchors", async () => {
		let { broadcasts, plan, server } = await opened();
		let ana = member("ana");
		let id = await mark(plan, server, ana);
		let source = room.project(plan.document);
		broadcasts.length = 0;

		await resolve(plan, server, ana, id);

		expect(ana.replies.at(-1)).toMatchObject({
			kind: "comment:resolve",
			ok: true,
			resolver: "ana",
		});
		expect(broadcasts[0]).toMatchObject({
			kind: "comment:resolved",
			id,
			status: "resolved",
			quote: QUOTE,
		});
		let anchors = broadcasts.findLast(frame => frame.kind === "plan:anchors");
		expect(anchors?.threads).toEqual([]);
		expect(room.project(plan.document)).toBe(source);
	});

	it("brings a reopened thread back with its passage", async () => {
		let { broadcasts, plan, server } = await opened();
		let ana = member("ana");
		let kris = member("kris");
		let id = await mark(plan, server, ana);
		await resolve(plan, server, ana, id);
		broadcasts.length = 0;

		await reopen(plan, server, kris, id);

		expect(kris.replies.at(-1)).toMatchObject({ kind: "comment:reopen", ok: true });
		expect(broadcasts[0]).toMatchObject({
			kind: "comment:reopened",
			thread: { id, status: "open" },
		});
		expect(broadcasts[0]?.thread).not.toHaveProperty("resolver");
		let anchors = broadcasts.findLast(frame => frame.kind === "plan:anchors");
		let pointed = (anchors?.threads as Array<{ thread: string }> | undefined)
			?.find(each => each.thread === id);
		expect(pointed).toMatchObject({ subject: { quote: QUOTE } });

		Comments.respond(plan, kris.socket, ask({ kind: "comment:reply" as const, id, text: "Back." }));
		await Bun.sleep(0);
		expect(kris.replies.at(-1)).toMatchObject({ kind: "comment:reply", ok: true });
	});

	/** Persistence precedes publication: a failed write is told to nobody but the sender. */
	for (let action of ["resolve", "reopen"] as const) {
		it(`tells nobody about a ${action} that could not be saved`, async () => {
			let { broadcasts, plan, server } = await opened();
			let ana = member("ana");
			let id = await mark(plan, server, ana);
			if (action === "reopen") await resolve(plan, server, ana, id);
			let before = plan.threads.get(id)!.status;
			broadcasts.length = 0;
			ana.replies.length = 0;

			let original = plan.persistence.storage.collaboration.commit;
			let fatal = plan.persistence.fatal;
			plan.persistence.fatal = () => {};
			plan.persistence.storage.collaboration.commit = () => Promise.reject(new Error("disk full"));
			let quiet = console.error;
			console.error = () => {};
			try {
				await (action === "resolve" ? resolve : reopen)(plan, server, ana, id);
			} finally {
				console.error = quiet;
				plan.persistence.storage.collaboration.commit = original;
				plan.persistence.fatal = fatal;
			}
			// So closing the room afterwards does not inherit the failed write.
			await Service.persist(plan);

			expect(ana.replies).toEqual([expect.objectContaining({ kind: "session:error" })]);
			expect(broadcasts).toEqual([]);
			expect(plan.threads.get(id)?.status).toBe(before);
			expect(plan.comments.closed.has(id)).toBe(action === "reopen");
		});
	}

	it("refuses to reopen a thread accepted under the earlier lifecycle", async () => {
		let { plan, server } = await opened();
		let ana = member("ana");
		let id = await mark(plan, server, ana);
		accept(plan, id);

		await reopen(plan, server, ana, id);

		expect(ana.replies.at(-1)).toMatchObject({ ok: false, reason: "settled" });
		expect(plan.threads.get(id)?.status).toBe("accepted");
	});

	it("still loads accepted, dismissed and resolved threads from storage", async () => {
		let doc = await document();
		let { record } = thread(doc);
		let stored = [
			{ ...record, id: "accepted", status: "accepted", resolver: "ana", at: 1, quote: QUOTE },
			{ ...record, id: "dismissed", status: "dismissed", resolver: "ana", at: 1, quote: QUOTE },
			{ ...record, id: "resolved", status: "resolved", resolver: "ana", at: 1, quote: QUOTE },
		];
		let { plan } = await opened(SOURCE, { threads: JSON.parse(JSON.stringify(stored)) });

		expect([...plan.threads.keys()]).toEqual(["accepted", "dismissed", "resolved"]);
		let joiner = member("kris");
		Comments.greet(plan, joiner.socket);
		let sync = joiner.replies.find(frame => frame.kind === "comment:sync");
		expect((sync?.threads as Array<{ id: string }>).map(each => each.id)).toEqual(["accepted"]);
		expect(Comments.anchors(plan).map(each => each.thread)).toEqual(["accepted"]);
	});
});

describe("what a thread owes the agent", () => {
	async function accepted() {
		let { plan, server } = await opened();
		let ana = member("ana");
		let id = await mark(plan, server, ana);
		accept(plan, id);
		return { id, plan };
	}

	/** An open thread asks nothing of the agent; there is no decision yet. */
	it("owes nothing while it is still being discussed", async () => {
		let { plan, server } = await opened();
		let ana = member("ana");
		await mark(plan, server, ana);

		expect(Comments.outstanding(plan)).toEqual([]);
		expect(Comments.anchors(plan)[0]?.result.pending).toBe(false);
	});

	it("owes a review the moment it is accepted, and stops when it is anchored", async () => {
		let { id, plan } = await accepted();

		expect(Comments.outstanding(plan)).toEqual([{ thread: id, reason: "missing" }]);
		expect(Comments.applied(plan, id)).toBe(false);

		let digest = room.digests(plan.document)[1]!;
		expect(Comments.relate(plan, id, [{ index: 1, digest }])).toBeUndefined();

		expect(Comments.outstanding(plan)).toEqual([]);
		expect(Comments.applied(plan, id)).toBe(true);
	});

	/** An empty list is a real answer: reviewed, deliberately related to nothing. */
	it("accepts that a revision produced nothing worth pointing at", async () => {
		let { id, plan } = await accepted();

		expect(Comments.relate(plan, id, [])).toBeUndefined();
		expect(Comments.applied(plan, id)).toBe(true);
	});

	it("refuses to anchor against a block that has changed", async () => {
		let { id, plan } = await accepted();

		expect(Comments.relate(plan, id, [{ index: 1, digest: "sha256:stale" }]))
			.toContain("has changed");
	});

	it("refuses to anchor a thread nobody accepted", async () => {
		let { plan, server } = await opened();
		let ana = member("ana");
		let id = await mark(plan, server, ana);

		expect(Comments.relate(plan, id, [])).toContain("was not accepted");
	});

	/**
	 * The agent is told to say what its revision produced, and when it does
	 * that answer is the better one. But a thread whose result is never
	 * anchored points at nothing for good — and by then the prose it was about
	 * is gone, because rewriting it is what acceptance asked for.
	 */
	it("takes the blocks a turn wrote when the agent does not say", async () => {
		let { id, plan } = await accepted();
		expect(Comments.applied(plan, id)).toBe(false);

		Comments.attribute(plan, id, [1, 2]);

		expect(Comments.applied(plan, id)).toBe(true);
		expect(plan.threads.get(id)?.result?.anchors).toHaveLength(2);
	});

	it("does not coarsen an answer the agent already gave", async () => {
		let { id, plan } = await accepted();
		let digest = room.digests(plan.document)[1]!;
		Comments.relate(plan, id, [{ index: 1, digest }]);

		// The agent picked one block; a later guess must not widen it to two.
		Comments.attribute(plan, id, [1, 2]);

		expect(plan.threads.get(id)?.result?.anchors).toHaveLength(1);
	});

	/** Once an edit has invalidated it, there is nothing left to preserve. */
	it("takes over again once the plan has moved under the agent's answer", async () => {
		let { id, plan } = await accepted();
		let digest = room.digests(plan.document)[1]!;
		Comments.relate(plan, id, [{ index: 1, digest }]);
		Comments.invalidate(plan, "plan_changed");

		Comments.attribute(plan, id, [1, 2]);

		expect(Comments.applied(plan, id)).toBe(true);
		expect(plan.threads.get(id)?.result?.anchors).toHaveLength(2);
	});

	it("attributes nothing to a thread nobody accepted", async () => {
		let { plan, server } = await opened();
		let ana = member("ana");
		let id = await mark(plan, server, ana);

		Comments.attribute(plan, id, [1]);

		expect(plan.threads.get(id)?.result).toBeUndefined();
	});

	it("attributes nothing when a turn wrote nothing", async () => {
		let { id, plan } = await accepted();

		Comments.attribute(plan, id, []);

		expect(plan.threads.get(id)?.result).toBeUndefined();
	});

	/**
	 * The prose a decision produced is the thing most likely to have been
	 * rewritten, so an edit puts it back on the agent's list rather than
	 * leaving a link to where it used to be.
	 */
	it("owes it again once the plan moves underneath", async () => {
		let { id, plan } = await accepted();
		let digest = room.digests(plan.document)[1]!;
		Comments.relate(plan, id, [{ index: 1, digest }]);

		Comments.invalidate(plan, "plan_changed");

		expect(Comments.outstanding(plan)).toEqual([{ thread: id, reason: "plan_changed" }]);
	});
});
