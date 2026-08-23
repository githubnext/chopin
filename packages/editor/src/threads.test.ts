/**
 * What the sidecar believes, as frames arrive.
 *
 * Two sources feed the store and they arrive separately: what a thread says
 * comes over `comment:*`, where it points comes over `plan:anchors`. Joining
 * them by id is the whole job, and the cases worth pinning are the ones where
 * only one of them has turned up, or where the same fact turns up twice.
 *
 * Resolution and painting are not tested here. Both need a bound editor and
 * real layout, and happy-dom returns zero for every measurement.
 */

import { describe, expect, it } from "bun:test";

import { ThreadStore } from "./threads";

import type { Comment, Plan } from "@chopin/protocol";

function note(handle: string, text: string, id = `${handle}-${text}`): Comment.Note {
	return { id, handle, text, ts: 1 };
}

function thread(over: Partial<Comment.Thread> = {}): Comment.Thread {
	return {
		id: "01K0N4TR8K7JGM4R1J7PW4R8YJ",
		status: "open",
		notes: [note("ana", "Too long.")],
		...over,
	};
}

/** An anchors entry, with the shape the server sends but no live positions. */
function anchors(id: string, over: Partial<Plan.ThreadAnchors> = {}): Plan.ThreadAnchors {
	return {
		thread: id,
		subject: {
			blocks: [],
			start: "",
			end: "",
			quote: "caches tiles for 60 seconds",
			offset: 0,
			length: 27,
		},
		result: { anchors: [], pending: false },
		...over,
	};
}

function store(): ThreadStore {
	return new ThreadStore();
}

describe("holding what threads say", () => {
	it("shows a thread before its passage has arrived", () => {
		let subject = store();
		subject.sync([thread()]);

		// The card renders on the next frame either way; waiting for the
		// anchors snapshot would leave a gap where the comment does not exist.
		expect(subject.snapshot().threads).toHaveLength(1);
		expect(subject.snapshot().threads[0]?.quote).toBe("");
	});

	it("takes the quote from the passage until the thread freezes its own", () => {
		let subject = store();
		let value = thread();
		subject.sync([value]);
		subject.anchors([anchors(value.id)]);

		expect(subject.snapshot().threads[0]?.quote).toBe("caches tiles for 60 seconds");

		// Resolving freezes it: from here the record says what was discussed,
		// and the passage is free to keep moving.
		subject.resolved({
			kind: "comment:resolved",
			ts: 0,
			id: value.id,
			status: "accepted",
			resolver: "kris",
			at: 2,
			quote: "caches tiles for 60 seconds",
		});
		subject.anchors([anchors(value.id, {
			subject: { ...anchors(value.id).subject, quote: "caches tiles for 10 seconds" },
		})]);

		expect(subject.snapshot().threads[0]?.quote).toBe("caches tiles for 60 seconds");
	});

	it("adds what somebody said", () => {
		let subject = store();
		let value = thread();
		subject.sync([value]);
		subject.said(value.id, note("kris", "Agreed."));

		expect(subject.snapshot().threads[0]?.thread.notes.map(each => each.handle))
			.toEqual(["ana", "kris"]);
	});

	/**
	 * The author adds a note from its own reply, and the broadcast arrives
	 * afterwards carrying the same one. Without this it appears twice.
	 */
	it("does not say the same thing twice", () => {
		let subject = store();
		let value = thread();
		subject.sync([value]);

		let said = note("kris", "Agreed.", "n1");
		subject.said(value.id, said);
		subject.said(value.id, said);

		expect(subject.snapshot().threads[0]?.thread.notes).toHaveLength(2);
	});

	it("ignores a note for a thread it has never heard of", () => {
		let subject = store();
		subject.said("missing", note("kris", "Hello?"));

		expect(subject.snapshot().threads).toHaveLength(0);
	});

	it("never shows a dismissed thread", () => {
		let subject = store();
		let value = thread();
		subject.sync([value]);
		subject.resolved({
			kind: "comment:resolved",
			ts: 0,
			id: value.id,
			status: "dismissed",
			resolver: "kris",
			at: 2,
			quote: "q",
		});

		expect(subject.snapshot().threads).toHaveLength(0);
	});

	it("replaces everything on a fresh sync", () => {
		let subject = store();
		subject.sync([thread({ id: "a" }), thread({ id: "b" })]);
		subject.sync([thread({ id: "b" })]);

		expect(subject.snapshot().threads.map(each => each.thread.id)).toEqual(["b"]);
	});
});

describe("what an accepted thread still owes", () => {
	function accepted() {
		let subject = store();
		let value = thread({ id: "t1", status: "accepted", resolver: "kris", at: 2, quote: "q" });
		subject.sync([value]);
		return { subject, value };
	}

	/**
	 * Derived from the result anchor rather than tracked separately: `pending`
	 * already means "nobody has reviewed this since the last change", which is
	 * exactly the question the card asks.
	 */
	it("reads as unapplied until the agent has anchored what it produced", () => {
		let { subject, value } = accepted();
		subject.anchors([anchors(value.id, {
			result: { anchors: [], pending: true, reason: "missing" },
		})]);

		expect(subject.snapshot().threads[0]?.applied).toBe(false);
	});

	it("reads as applied once it has", () => {
		let { subject, value } = accepted();
		subject.anchors([anchors(value.id)]);

		expect(subject.snapshot().threads[0]?.applied).toBe(true);
	});

	/** An empty list is a real answer: reviewed, deliberately unrelated. */
	it("counts a deliberate nothing as applied", () => {
		let { subject, value } = accepted();
		subject.anchors([anchors(value.id, { result: { anchors: [], pending: false } })]);

		expect(subject.snapshot().threads[0]?.applied).toBe(true);
	});

	it("asks the Planner to retry an unapplied accepted comment without composer syntax", () => {
		let sent: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
		let subject = store();
		subject.listen({
			on: () => () => {},
			send: () => {},
			ask: async <T>(kind: string, payload?: Record<string, unknown>) => {
				sent.push({ kind, payload });
				return { kind: "chat:send", ts: 0, id: "entry", queued: false } as T;
			},
		});
		subject.sync([thread({ id: "t1", status: "accepted", quote: "shorten this" })]);

		subject.retry("t1");

		expect(sent).toEqual([{
			kind: "chat:send",
			payload: {
				requestId: expect.stringMatching(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
				),
				text: 'apply the accepted comment on "shorten this" — it has not been actioned yet.',
				to: "planner",
			},
		}]);
	});
});

describe("who is writing", () => {
	it("collects them per thread, and forgets them when they stop", () => {
		let subject = store();
		let value = thread();
		subject.sync([value]);

		subject.typing({
			kind: "comment:typing",
			ts: 0,
			id: value.id,
			writing: true,
			client: "c1",
			handle: "kris",
		});
		expect(subject.snapshot().writing[value.id]).toEqual(["kris"]);

		subject.typing({
			kind: "comment:typing",
			ts: 0,
			id: value.id,
			writing: false,
			client: "c1",
			handle: "kris",
		});
		expect(subject.snapshot().writing[value.id]).toBeUndefined();
	});

	/** One person in two tabs is one name, not two. */
	it("names a person once however many tabs they have open", () => {
		let subject = store();
		let value = thread();
		subject.sync([value]);

		for (let client of ["c1", "c2"]) {
			subject.typing({
				kind: "comment:typing",
				ts: 0,
				id: value.id,
				writing: true,
				client,
				handle: "kris",
			});
		}

		expect(subject.snapshot().writing[value.id]).toEqual(["kris"]);
	});

	it("stops showing anybody once the thread is resolved", () => {
		let subject = store();
		let value = thread();
		subject.sync([value]);
		subject.typing({
			kind: "comment:typing",
			ts: 0,
			id: value.id,
			writing: true,
			client: "c1",
			handle: "kris",
		});

		subject.resolved({
			kind: "comment:resolved",
			ts: 0,
			id: value.id,
			status: "accepted",
			resolver: "ana",
			at: 2,
			quote: "q",
		});

		expect(subject.snapshot().writing[value.id]).toBeUndefined();
	});
});

describe("drafting", () => {
	it("holds the passage that was selected, so losing the selection costs nothing", () => {
		let subject = store();
		subject.draft({ blocks: [1], quote: "the phrase", offset: 3, length: 10 });

		expect(subject.snapshot().draft).toMatchObject({ quote: "the phrase", blocks: [1] });
	});

	it("puts the draft away once the thread it became arrives", () => {
		let subject = store();
		subject.draft({ blocks: [1], quote: "the phrase", offset: 3, length: 10 });
		subject.opened(thread());

		expect(subject.snapshot().draft).toBeUndefined();
		expect(subject.snapshot().threads).toHaveLength(1);
	});
});

/** Silence the log the guards produce, so a pass does not look like a failure. */
function quietly<T>(run: () => T): T {
	let complain = console.error;
	console.error = () => {};
	try {
		return run();
	} finally {
		console.error = complain;
	}
}

describe("when resolution goes wrong", () => {
	/**
	 * A passage that cannot be worked out is a highlight nobody gets, not a
	 * sidecar nobody gets. The card still carries the conversation, which is
	 * the durable part of a comment; the anchor was only ever a convenience.
	 *
	 * `refresh` also runs as a Lexical update listener, and Lexical runs those
	 * in one unisolated loop — so a throw escaping here would skip the listener
	 * that syncs the document and cost the room its collaboration.
	 */
	/**
	 * A snapshot entry the client cannot read.
	 *
	 * A missing `result` is the realistic shape: the two halves of a
	 * relationship are written at different times by different actors, so a
	 * partial one is a protocol skew rather than an impossibility.
	 */
	function malformed(id: string): Plan.ThreadAnchors {
		return { thread: id, subject: anchors(id).subject } as Plan.ThreadAnchors;
	}

	it("still shows a thread whose relationship it cannot read", () => {
		let subject = store();
		let value = thread();
		subject.sync([value]);

		quietly(() => subject.anchors([malformed(value.id)]));

		let view = subject.snapshot().threads[0];
		expect(view?.thread.notes).toHaveLength(1);
		// Unplaceable, so it reads the way a passage whose prose moved does.
		expect(view?.drifted).toBe(true);
	});

	it("does not let one unreadable relationship hide the others", () => {
		let subject = store();
		subject.sync([thread({ id: "a" }), thread({ id: "b" }), thread({ id: "c" })]);

		quietly(() => subject.anchors([anchors("a"), malformed("b"), anchors("c")]));

		expect(subject.snapshot().threads.map(each => each.thread.id)).toEqual(["a", "b", "c"]);
		expect(subject.snapshot().threads[0]?.drifted).toBe(false);
		expect(subject.snapshot().threads[1]?.drifted).toBe(true);
	});

	/**
	 * `refresh` runs as a Lexical update listener, and Lexical runs those in
	 * one loop with no isolation: the first to throw skips every listener after
	 * it, including the one that syncs the document. Nothing it does may
	 * escape, whatever the editor is doing.
	 */
	it("never throws out of refresh, whatever the editor does", () => {
		let subject = store();
		subject.sync([thread()]);
		subject.attach({
			getEditorState() {
				throw new Error("the editor is gone");
			},
		} as never);
		subject.bind({} as never);

		quietly(() => {
			expect(() => subject.refresh()).not.toThrow();
		});
	});
});

describe("publishing", () => {
	it("tells nobody when nothing changed", () => {
		let subject = store();
		let value = thread();
		subject.sync([value]);

		let seen = 0;
		subject.subscribe(() => seen++);
		subject.sync([value]);

		// Every keystroke in the plan re-runs this. Publishing regardless is
		// what would re-render the pane on every character typed in the prose.
		expect(seen).toBe(0);
	});

	it("tells subscribers when something did", () => {
		let subject = store();
		let value = thread();
		subject.sync([value]);

		let seen = 0;
		subject.subscribe(() => seen++);
		subject.said(value.id, note("kris", "Agreed."));

		expect(seen).toBe(1);
	});
});
