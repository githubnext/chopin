/**
 * Commenting on the plan, and deciding about it.
 *
 * The properties worth holding onto: a thread is frozen the moment it resolves,
 * only one resolution wins, accepting reaches both the record that owns the
 * decision and the plan that shows it — or neither — and dismissing changes the
 * plan not at all.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Comments from "./comments/service";
import * as room from "./plan/room";
import * as Service from "./plan/service";
import * as Store from "./comments/store";
import { compose } from "./comments/prompt";

import type { Server } from "bun";
import type * as Chat from "./chat/service";
import type { Document } from "./plan/room";
import type { Record } from "./comments/service";
import type { Plan } from "./plan/service";
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

let rooms: string[] = [];
let opens: Plan[] = [];

afterEach(async () => {
	// Sinks are on a timer. Left running they write, and log, after the test
	// that made them has finished and put `console.error` back.
	for (let plan of opens) await Service.close(plan);
	opens = [];
	for (let dir of rooms) await rm(dir, { recursive: true, force: true });
	rooms = [];
});

/** Frames the room sent, and to whom. */
type Sent = { kind: string; [key: string]: unknown };

/**
 * A room with a plan on disk.
 *
 * Built through `Service.open` rather than by hand: restoring, rebasing on
 * open and the snapshot sink are all part of what the service does, and a
 * stubbed plan would test the parts around them instead of them.
 */
async function opened(source = SOURCE, state?: object) {
	let dir = await mkdtemp(join(tmpdir(), "chopin-comments-"));
	rooms.push(dir);
	await writeFile(join(dir, "plan.mdx"), source);
	if (state) await writeFile(join(dir, "state.json"), JSON.stringify(state));

	let broadcasts: Sent[] = [];
	let broken: string | undefined;
	let server = {
		publish(_topic: string, data: string) {
			let frame = JSON.parse(data) as Sent;
			if (frame.kind === broken) throw new Error("nobody is listening");
			broadcasts.push(frame);
		},
	} as unknown as Server<SocketData>;

	let plan = await Service.open("test", dir, server);
	opens.push(plan);
	return {
		broadcasts,
		dir,
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
			broken = kind;
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

/** Enough of a room for the handlers that start a turn. `AGENT=off` throughout. */
function context(plan: Plan, server: Server<SocketData>): Chat.Room {
	return { chat: plan.chat, config: { agent: false }, plan, room: "test", server } as Chat.Room;
}

/** Mark the sentence, the way a client's `comment:start` does. */
function mark(
	plan: Plan,
	server: Server<SocketData>,
	who: ReturnType<typeof member>,
	text = "Too long.",
): string {
	Comments.start(
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

		let claimed = Store.claim(threads, records, record.id, "accept", "kris", QUOTE);
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) return;
		Store.commit(threads, records, claimed.claim);

		expect(records.get(record.id)!.status).toBe("accepted");
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

		let first = Store.claim(threads, records, record.id, "accept", "kris", QUOTE);
		if (!first.ok) throw new Error("expected a claim");
		Store.commit(threads, records, first.claim);

		let second = Store.claim(threads, records, record.id, "dismiss", "ana", QUOTE);
		expect(second.ok).toBe(false);
		if (!second.ok && second.reason === "resolved") {
			expect(second.status).toBe("accepted");
			expect(second.resolver).toBe("kris");
		} else {
			throw new Error("expected the outcome, not an error");
		}
	});

	it("refuses a rival while a resolution is in flight", async () => {
		let { records, record } = thread(await document());
		let threads = Store.create();

		Store.claim(threads, records, record.id, "accept", "kris", QUOTE);
		let rival = Store.claim(threads, records, record.id, "dismiss", "ana", QUOTE);

		expect(rival.ok).toBe(false);
		if (!rival.ok) expect(rival.reason).toBe("resolving");
	});

	/**
	 * The durable half is the `<Decision>` node. If it cannot be written the
	 * decision is not final, and the thread has to be left in a state every
	 * client already knows how to render — which is the one it was in.
	 */
	it("leaves the thread open when the plan could not be told", async () => {
		let { records, record } = thread(await document());
		let threads = Store.create();

		let claimed = Store.claim(threads, records, record.id, "accept", "kris", QUOTE);
		if (!claimed.ok) throw new Error("expected a claim");
		Store.rollback(threads, claimed.claim);

		expect(records.get(record.id)!.status).toBe("open");
		expect(Store.reply(threads, records, record.id, "ana", "Still talking.").ok).toBe(true);
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

describe("opening a room whose sidecar is damaged", () => {
	/**
	 * `plan.mdx` is a file a person can edit between runs, and `state.json` sits
	 * beside it. A record that cannot be carried onto the rebuilt document is a
	 * decision nobody can point at — not a room nobody can open. Letting it
	 * throw would fail `plan:open`, and a client whose open is refused sits
	 * there locked with the chrome saying it is still loading.
	 */
	it("still opens when a thread record cannot be carried forward", async () => {
		let damaged = {
			revision: 1,
			questions: [],
			threads: [{
				id: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
				status: "accepted",
				// No blocks, no positions: whatever wrote this, it is not a passage.
				passage: null,
				notes: [{ id: "n1", handle: "ana", text: "Too long.", ts: 1 }],
				quote: QUOTE,
				resolver: "ana",
				at: 2,
			}],
		};

		let complain = console.error;
		console.error = () => {};
		try {
			let { plan, server } = await opened(SOURCE, damaged);

			// The room is open and usable: a new thread can still be marked.
			let ana = member("ana");
			expect(() => mark(plan, server, ana)).not.toThrow();
			expect(room.project(plan.document)).toContain(QUOTE);

			// The damaged record would be carried forward again on the way out,
			// logging after this test has put `console.error` back.
			plan.sink.cancel();
		} finally {
			console.error = complain;
		}
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
		let id = mark(plan, server, ana);

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

	it("keeps a dismissed thread off the wire for whoever joins next", async () => {
		let { plan, server } = await opened();
		let ana = member("ana");
		let id = mark(plan, server, ana);
		await Comments.dismiss(
			context(plan, server),
			ana.socket,
			ask({ kind: "comment:dismiss" as const, id }),
		);

		let joiner = member("kris");
		Comments.greet(plan, joiner.socket);

		let sync = joiner.replies.find(frame => frame.kind === "comment:sync");
		expect(sync?.threads).toEqual([]);
		// The record survives; it is only hidden.
		expect(plan.threads.get(id)?.status).toBe("dismissed");
	});
});

describe("accepting, as the service orders it", () => {
	async function accepted(options: { failPublish?: boolean } = {}) {
		let { breakRelay, broadcasts, plan, server } = await opened();
		let ana = member("ana");
		let id = mark(plan, server, ana);
		ana.replies.length = 0;

		// The document delta, which is what carries the new node to clients.
		if (options.failPublish) breakRelay("plan:update");
		await Comments.accept(
			context(plan, server),
			ana.socket,
			ask({ kind: "comment:accept" as const, id }),
		);
		return { ana, broadcasts, id, plan };
	}

	it("reaches the record and the plan together", async () => {
		let { ana, id, plan } = await accepted();

		expect(ana.replies.at(-1)).toMatchObject({ kind: "comment:accept", ok: true, resolver: "ana" });
		expect(plan.threads.get(id)?.status).toBe("accepted");
		expect(plan.threads.get(id)?.quote).toBe(QUOTE);
		expect(room.project(plan.document)).toContain(`<Decision id="${id}"`);
	});

	/**
	 * Once the document holds the decision, committing is no longer optional.
	 * Rolling back on a failed relay would leave a `<Decision>` in a plan whose
	 * record says the thread is open — and the next accept would append a
	 * second node carrying the same id. A relay nobody received is recoverable.
	 */
	it("stands even when the room could not be told", async () => {
		// The relay failing is the point, and it logs. Quietened so the run
		// does not print a stack trace that reads like a real one.
		let complain = console.error;
		console.error = () => {};
		let { id, plan } = await accepted({ failPublish: true }).finally(() => {
			console.error = complain;
		});

		expect(plan.threads.get(id)?.status).toBe("accepted");
		let source = room.project(plan.document);
		expect(source.split(`id="${id}"`)).toHaveLength(2);
	});

	it("says nothing more can be added, and nobody can resolve it twice", async () => {
		let { id, plan } = await accepted();
		let kris = member("kris");

		Comments.respond(plan, kris.socket, ask({ kind: "comment:reply" as const, id, text: "Wait." }));
		expect(kris.replies.at(-1)).toMatchObject({ ok: false, reason: "resolved" });

		let after = context(plan, {} as Server<SocketData>);
		await Comments.dismiss(after, kris.socket, ask({ kind: "comment:dismiss" as const, id }));
		expect(kris.replies.at(-1)).toMatchObject({
			ok: false,
			reason: "resolved",
			status: "accepted",
			resolver: "ana",
		});
	});

	it("leaves the plan alone when the thread is dismissed instead", async () => {
		let { plan, server } = await opened();
		let ana = member("ana");
		let id = mark(plan, server, ana);
		await Comments.dismiss(
			context(plan, server),
			ana.socket,
			ask({ kind: "comment:dismiss" as const, id }),
		);

		expect(plan.threads.get(id)?.status).toBe("dismissed");
		expect(room.project(plan.document)).not.toContain("<Decision");
	});
});

describe("what a thread owes the agent", () => {
	async function accepted() {
		let { plan, server } = await opened();
		let ana = member("ana");
		let id = mark(plan, server, ana);
		await Comments.accept(
			context(plan, server),
			ana.socket,
			ask({ kind: "comment:accept" as const, id }),
		);
		return { id, plan };
	}

	/** An open thread asks nothing of the agent; there is no decision yet. */
	it("owes nothing while it is still being discussed", async () => {
		let { plan, server } = await opened();
		let ana = member("ana");
		mark(plan, server, ana);

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
		let id = mark(plan, server, ana);

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
		let id = mark(plan, server, ana);

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

describe("what the agent is told", () => {
	it("quotes the passage and the whole thread", async () => {
		let { record } = thread(await document());
		let prompt = compose(record, QUOTE);

		expect(prompt.startsWith("accepted a comment")).toBe(true);
		expect(prompt).toContain(`> ${QUOTE}`);
		expect(prompt).toContain("@ana: 60s is too long.");
		expect(prompt).toContain(record.id);
	});

	/** A rewritten passage is more information, not less. */
	it("says so when the prose has moved on, and quotes both", async () => {
		let { record } = thread(await document());
		let prompt = compose(record, QUOTE, "caches tiles for 10 seconds");

		expect(prompt).toContain("has since been rewritten");
		expect(prompt).toContain("> caches tiles for 10 seconds");
	});
});
