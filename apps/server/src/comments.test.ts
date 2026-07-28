/**
 * Commenting on the plan, and deciding about it.
 *
 * The properties worth holding onto: a thread is frozen the moment it resolves,
 * only one resolution wins, accepting reaches both the record that owns the
 * decision and the plan that shows it — or neither — and dismissing changes the
 * plan not at all.
 */

import { describe, expect, it } from "bun:test";

import * as room from "./plan/room";
import * as Store from "./comments/store";
import { compose } from "./comments/prompt";

import type { Document } from "./plan/room";
import type { Record } from "./comments/service";

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
