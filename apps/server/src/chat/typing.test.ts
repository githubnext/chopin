/**
 * Who is writing, as presence: shown to everyone who can read the document now but themselves, in
 * the order they began, from an edit until the connection says it stopped, sends, closes, can no
 * longer write, or its last edit is five seconds old on the server's clock, whatever order its
 * reports arrive in, however late and however often they repeat.
 */
import { expect, test } from "bun:test";

import { flush, ManualClock } from "./initiative.test-fixtures";
import {
	createTypingPresence,
	TYPING_IDLE_MS,
	TYPING_RECHECK_MS,
	TYPING_SKEW_MS,
	TYPING_START_INTERVAL_MS,
} from "./typing";

import type { Chat as Wire } from "@chopin/protocol";
import type { AuthorizationResult, Socket } from "../wire";

type Tab = { ws: Socket; frames: Wire.Typists[]; seq: number };

const LEASE = TYPING_IDLE_MS;

function room(threads: string[] = ["root-a", "root-b"], clock = new ManualClock()) {
	let members: Tab[] = [];
	/** Connections a fresh check of their access finds can no longer read the document. */
	let revoked = new Set<string>();
	/** Connections a fresh check finds can still read the document but no longer write it. */
	let readOnly = new Set<string>();
	/** Connections whose access a check can't confirm for now (GitHub or storage failing). */
	let unconfirmed = new Set<string>();
	/** While set, every check of a reader's access waits for it. */
	let gate: Promise<void> | undefined;
	let access = (client: string): AuthorizationResult =>
		revoked.has(client) ? "denied" : unconfirmed.has(client) ? "unavailable" : "allowed";
	let presence = createTypingPresence({
		clock,
		threadExists: rootId => threads.includes(rootId),
		members: () => members.map(member => member.ws),
		reads: async member => {
			await gate;
			return access(member.data.client);
		},
		writes: async client => {
			let read = access(client);
			return read === "allowed" && readOnly.has(client) ? "denied" : read;
		},
	});
	let join = (principalId: string, client = `${principalId}-tab`, canEdit = true) => {
		let frames: Wire.Typists[] = [];
		let ws = {
			data: { principalId, client, handle: principalId, canEdit, closed: false },
			send(raw: string) {
				frames.push(JSON.parse(raw) as Wire.Typists);
			},
		} as unknown as Socket;
		let member = { ws, frames, seq: 0 };
		members.push(member);
		return member;
	};
	/**
	 * A report from `member`, numbered after its last unless `seq` says otherwise, of an edit made
	 * `at` on the server's clock (now, unless it says otherwise), once what it changes has been told.
	 */
	let report = async (
		member: Tab,
		active: boolean,
		options: { thread?: unknown; seq?: number; at?: number } = {},
	) => {
		let seq = options.seq ?? ++member.seq;
		member.seq = Math.max(member.seq, seq);
		presence.type(member.ws.data.client, member.ws.data.principalId, member.ws.data.handle, {
			active,
			seq,
			...(options.thread === undefined ? {} : { thread: options.thread }),
			...(active ? { at: options.at ?? clock.now() } : {}),
		});
		await flush();
		return seq;
	};
	let leave = async (member: Tab) => {
		(member.ws.data as { closed: boolean }).closed = true;
		presence.depart(member.ws.data.client);
		await flush();
	};
	let greet = async (member: Tab) => {
		presence.greet(member.ws);
		await flush();
	};
	/** Hold every check of a reader's access until the returned function is called. */
	let hold = () => {
		let held = Promise.withResolvers<void>();
		gate = held.promise;
		return async () => {
			gate = undefined;
			held.resolve();
			await flush();
		};
	};
	return {
		clock,
		presence,
		members,
		join,
		report,
		leave,
		greet,
		hold,
		revoked,
		readOnly,
		unconfirmed,
	};
}

let names = (frame: Wire.Typists | undefined) =>
	(frame?.typists ?? []).map(typist =>
		`${typist.author.kind === "agent" ? "chopin" : typist.author.handle}${
			typist.thread ? `@${typist.thread}` : ""
		}`
	);
let seen = (member: Tab) => names(member.frames.at(-1));

test("everyone in the room is told, readers included, nobody sees themself, and a closed socket hears nothing", async () => {
	let r = room();
	let ana = r.join("ana");
	let bo = r.join("bo");
	let rae = r.join("rae", "rae-tab", false);
	let gone = r.join("cy");
	(gone.ws.data as { closed: boolean }).closed = true;

	await r.report(ana, true);

	expect(seen(bo)).toEqual(["ana"]);
	expect(seen(rae)).toEqual(["ana"]);
	expect(seen(ana)).toEqual([]);
	expect(gone.frames).toEqual([]);
});

test("a joining member is told who is writing now, and an empty room as empty", async () => {
	let r = room();
	let ana = r.join("ana");
	let bo = r.join("bo");
	await r.greet(bo);
	expect(bo.frames).toMatchObject([{ kind: "chat:typists", typists: [] }]);
	await r.report(ana, true);
	await r.clock.advance(1_000);
	let cy = r.join("cy");
	await r.greet(cy);
	expect(cy.frames).toHaveLength(1);
	expect(seen(cy)).toEqual(["ana"]);
});

test("a room opened again outranks every frame of the one before", async () => {
	let clock = new ManualClock();
	let first = room(undefined, clock);
	let ana = first.join("ana");
	let bo = first.join("bo");
	await first.report(ana, true);
	let old = bo.frames.at(-1)!;
	first.presence.close();
	let second = room(undefined, clock);
	let again = second.join("bo");
	await second.greet(again);
	let fresh = again.frames.at(-1)!;
	expect(fresh.generation).toBeGreaterThan(old.generation);
	expect(fresh.typists).toEqual([]);
});

test("each place is its own: a thread's writing names it, and stopping one place leaves the others", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");

	await r.report(ana, true, { thread: "root-a" });
	await r.report(ana, true, { thread: "root-b" });
	await r.report(ana, true);
	expect(seen(bo)).toEqual(["ana@root-a", "ana@root-b", "ana"]);

	await r.report(ana, false, { thread: "root-a" });
	expect(seen(bo)).toEqual(["ana@root-b", "ana"]);
	r.presence.sent(ana.ws.data.client, undefined);
	await flush();
	expect(seen(bo)).toEqual(["ana@root-b"]);
});

test("a thread that is not a message of Chat, or a report with no number or no edit time, is ignored", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	for (let thread of ["unknown", "", 7, "x".repeat(129), null]) {
		await r.report(ana, true, { thread });
	}
	let now = r.clock.now();
	r.presence.type("ana-tab", "ana", "ana", { active: true, at: now });
	r.presence.type("ana-tab", "ana", "ana", { active: true, seq: "9", at: now });
	r.presence.type("ana-tab", "ana", "ana", { active: true, seq: 50 });
	r.presence.type("ana-tab", "ana", "ana", { active: true, seq: 51, at: String(now) });
	r.presence.type("ana-tab", "ana", "ana", { active: true, seq: 52, at: Number.NaN });
	await flush();
	expect(bo.frames).toEqual([]);
});

test("a person is shown once while any tab of theirs writes there; stopping or closing one leaves the other", async () => {
	let r = room();
	let bo = r.join("bo");
	let phone = r.join("ana", "ana-phone");
	let laptop = r.join("ana", "ana-laptop");

	await r.report(phone, true, { thread: "root-a" });
	await r.clock.advance(100);
	await r.report(laptop, true, { thread: "root-a" });
	expect(seen(bo)).toEqual(["ana@root-a"]);

	await r.report(phone, false, { thread: "root-a" });
	await r.leave(phone);
	expect(seen(bo)).toEqual(["ana@root-a"]);
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	await r.report(laptop, true, { thread: "root-a" });
	await r.clock.advance(LEASE - 1);
	expect(seen(bo)).toEqual(["ana@root-a"]);
	await r.leave(laptop);
	expect(seen(bo)).toEqual([]);
});

test("a tab's first edit just inside its person's interval keeps its own deadline once their other tab stops", async () => {
	let r = room();
	let bo = r.join("bo");
	let phone = r.join("ana", "ana-phone");
	let laptop = r.join("ana", "ana-laptop");

	await r.report(phone, true);
	await r.clock.advance(TYPING_START_INTERVAL_MS - 1);
	await r.report(laptop, true);
	await r.report(phone, false);
	expect(seen(bo)).toEqual(["ana"]);
	await r.clock.advance(LEASE - 1);
	expect(seen(bo)).toEqual(["ana"]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual([]);
	expect(bo.frames).toHaveLength(2);
});

test("the newest report of a connection wins whatever order they arrive in, and a repeat says nothing", async () => {
	let intents = [
		{ seq: 1, active: true },
		{ seq: 2, active: false },
		{ seq: 3, active: true },
	];
	let orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0], [
		0,
		1,
		2,
		2,
		1,
		0,
	]];
	for (let order of orders) {
		let r = room();
		let bo = r.join("bo");
		let ana = r.join("ana");
		for (let index of order) {
			await r.report(ana, intents[index]!.active, { seq: intents[index]!.seq });
		}
		await r.clock.advance(TYPING_START_INTERVAL_MS);
		expect(seen(bo)).toEqual(["ana"]);
	}
	for (let order of [[0, 1], [1, 0], [0, 1, 0, 1]]) {
		let r = room();
		let bo = r.join("bo");
		let ana = r.join("ana");
		for (let index of order) {
			await r.report(ana, intents[index]!.active, { seq: intents[index]!.seq });
		}
		await r.clock.advance(TYPING_START_INTERVAL_MS);
		expect(seen(bo)).toEqual([]);
	}

	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	await r.report(ana, true, { seq: 5 });
	await r.report(ana, true, { seq: 5 });
	await r.report(ana, true, { seq: 4 });
	expect(bo.frames).toHaveLength(1);
});

test("a report delivered again neither keeps its writer past their edit nor brings them back", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	let edited = r.clock.now();
	let first = await r.report(ana, true, { at: edited });

	await r.clock.advance(2_000);
	await r.report(ana, true, { seq: first, at: edited });
	await r.clock.advance(LEASE - 2_001);
	expect(seen(bo)).toEqual(["ana"]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual([]);
	await r.report(ana, true, { seq: first, at: edited });
	await r.clock.advance(10_000);
	expect(seen(bo)).toEqual([]);
});

test("a later report carrying the last edit keeps its writer until five seconds after that edit", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");

	await r.report(ana, true);
	await r.clock.advance(2_000);
	await r.report(ana, true, { at: r.clock.now() - 500 });
	await r.clock.advance(4_499);
	expect(seen(bo)).toEqual(["ana"]);
	await r.report(ana, false);
	expect(seen(bo)).toEqual([]);
});

test("a report early by jitter still keeps its writer five seconds after the edit it carries", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");

	await r.report(ana, true);
	await r.clock.advance(1_400);
	await r.report(ana, true, { at: r.clock.now() - 100 });
	await r.clock.advance(LEASE - 101);
	expect(seen(bo)).toEqual(["ana"]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual([]);
});

test("a client that falls silent is dropped when the last edit it told of is five seconds old", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");

	await r.report(ana, true);
	await r.clock.advance(2_000);
	await r.report(ana, true, { at: r.clock.now() - 500 });
	await r.clock.advance(1_500 + LEASE - 2_001);
	expect(seen(bo)).toEqual(["ana"]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual([]);

	let cy = r.join("cy");
	await r.report(cy, true);
	await r.clock.advance(LEASE - 1);
	expect(seen(bo)).toEqual(["cy"]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual([]);
});

test("a first report held five seconds or more after its edit is never shown, though no stop follows it", async () => {
	for (let held of [TYPING_IDLE_MS, TYPING_IDLE_MS + 1, 10_000]) {
		let r = room();
		let bo = r.join("bo");
		let ana = r.join("ana");
		let edited = r.clock.now();
		await r.clock.advance(held);
		await r.report(ana, true, { at: edited });
		await r.clock.advance(TYPING_IDLE_MS * 2);
		expect(bo.frames, `held ${held} ms`).toEqual([]);
	}
});

test("a first report held a while shows its writer only for what is left of the five seconds after its edit", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	let edited = r.clock.now();
	await r.clock.advance(3_000);
	await r.report(ana, true, { at: edited });
	expect(seen(bo)).toEqual(["ana"]);
	await r.clock.advance(1_999);
	expect(seen(bo)).toEqual(["ana"]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual([]);
});

test("a trailing report whose edit is five seconds old or more changes nothing", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	await r.report(ana, true);
	await r.clock.advance(2_000);
	let told = bo.frames.length;

	await r.report(ana, true, { at: r.clock.now() - TYPING_IDLE_MS });
	await r.report(ana, true, { at: r.clock.now() - 60_000 });
	expect(bo.frames).toHaveLength(told);
	expect(seen(bo)).toEqual(["ana"]);
	await r.clock.advance(LEASE - 2_001);
	expect(seen(bo)).toEqual(["ana"]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual([]);
});

test("an edit placed past the server's clock by more than the skew is refused, and one within it counts from now", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	let cy = r.join("cy");
	await r.report(ana, true, { at: r.clock.now() + TYPING_SKEW_MS + 1 });
	await r.report(cy, true, { at: r.clock.now() + TYPING_SKEW_MS });
	expect(seen(bo)).toEqual(["cy"]);
	await r.clock.advance(LEASE - 1);
	expect(seen(bo)).toEqual(["cy"]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual([]);
	expect(bo.frames.flatMap(names)).not.toContain("ana");
});

test("a quick stop and start is shown again only when the person's interval is up, and is never lost", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");

	await r.report(ana, true);
	await r.clock.advance(50);
	await r.report(ana, false);
	await r.clock.advance(50);
	await r.report(ana, true);
	expect(seen(bo)).toEqual([]);
	await r.clock.advance(TYPING_START_INTERVAL_MS - 101);
	expect(seen(bo)).toEqual([]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual(["ana"]);
	expect(bo.frames).toHaveLength(3);
});

test("a connection that closes and comes back is shown again from its first edit, within the interval", async () => {
	let r = room();
	let bo = r.join("bo");
	let before = r.join("ana", "ana-before");
	await r.report(before, true);
	await r.clock.advance(300);
	await r.leave(before);
	expect(seen(bo)).toEqual([]);

	let after = r.join("ana", "ana-after");
	await r.clock.advance(200);
	await r.report(after, true);
	await r.clock.advance(TYPING_START_INTERVAL_MS - 500);
	expect(seen(bo)).toEqual(["ana"]);
});

test("one person's flood of reports changes what readers see at most twice an interval, and spends nobody else's", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	let cy = r.join("cy");

	for (let index = 0; index < 50; index++) {
		await r.report(ana, true);
		await r.report(ana, false);
		await r.clock.advance(20);
	}
	expect(bo.frames.length).toBeLessThanOrEqual(2);
	await r.report(cy, true);
	await r.report(ana, true, { thread: "root-a" });
	expect(seen(bo)).toEqual(["cy", "ana@root-a"]);
});

test("readers are told only when who is writing changes, each time with a larger number", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");

	await r.report(ana, true);
	for (let step = 0; step < 3; step++) {
		await r.clock.advance(2_000);
		await r.report(ana, true);
	}
	expect(bo.frames).toHaveLength(1);
	await r.report(ana, false);
	await r.report(ana, false);
	expect(bo.frames).toHaveLength(2);
	expect(bo.frames[1]!.seq).toBeGreaterThan(bo.frames[0]!.seq);
});

test("people are listed in the order they began", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let bo = r.join("bo");
	let ana = r.join("ana");
	await r.report(bo, true);
	await r.clock.advance(10);
	await r.report(ana, true);
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	await r.report(bo, true);
	expect(seen(viewer)).toEqual(["bo", "ana"]);
});

test("at most 64 connections are shown writing at once", async () => {
	let r = room();
	let viewer = r.join("viewer");
	for (let index = 0; index < 70; index++) await r.report(r.join(`p${index}`), true);
	expect(viewer.frames.at(-1)!.typists).toHaveLength(64);
});

/** Fills the room with 64 connections that wrote and stopped, so what is no longer shown is reclaimed. */
async function crowd(r: ReturnType<typeof room>) {
	for (let index = 0; index < 64; index++) {
		let other = r.join(`p${index}`);
		await r.report(other, true);
		await r.report(other, false);
	}
}

test("reclaiming what is no longer shown never lets an old report bring back a stopped writer or silence a newer one", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let ana = r.join("ana");

	let first = r.clock.now();
	let started = await r.report(ana, true, { at: first });
	let stopped = await r.report(ana, false);
	await crowd(r);
	await r.clock.advance(2_000);
	await r.report(ana, true, { seq: started, at: first });
	await r.report(ana, false, { seq: stopped });
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	expect(seen(viewer)).toEqual([]);

	let edited = r.clock.now();
	let expired = await r.report(ana, true, { at: edited });
	await r.clock.advance(LEASE);
	expect(seen(viewer)).toEqual([]);
	await crowd(r);
	await r.report(ana, true, { seq: expired, at: edited });
	await r.report(ana, true, { seq: started, at: first });
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	expect(seen(viewer)).toEqual([]);

	await r.report(ana, true);
	expect(seen(viewer)).toEqual(["ana"]);
	await crowd(r);
	await r.report(ana, false, { seq: stopped });
	await r.report(ana, false, { seq: expired });
	await r.clock.advance(LEASE - 1);
	expect(seen(viewer)).toEqual(["ana"]);
});

test("with every slot shown writing, a stop's number still stands, so an older start never brings its writer back", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let ana = r.join("ana");
	let others = Array.from({ length: 64 }, (_, index) => r.join(`p${index}`));
	for (let other of others) await r.report(other, true);

	await r.report(ana, false, { seq: 2 });
	await r.report(ana, true, { seq: 3 });
	expect(seen(viewer)).not.toContain("ana");
	await r.leave(others[0]!);
	await r.report(ana, true, { seq: 1 });
	await r.report(ana, true, { seq: 3 });
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	expect(seen(viewer)).not.toContain("ana");

	await r.report(ana, true, { seq: 4 });
	expect(seen(viewer)).toContain("ana");
});

test("a connection that writes in more places than are kept still refuses an old report in the first", async () => {
	let threads = Array.from({ length: 70 }, (_, index) => `root-${index}`);
	let r = room(threads);
	let viewer = r.join("viewer");
	let ana = r.join("ana");

	let edited = r.clock.now();
	let started = await r.report(ana, true, { thread: "root-0", at: edited });
	await r.report(ana, false, { thread: "root-0" });
	for (let thread of threads.slice(1)) await r.report(ana, false, { thread });
	await crowd(r);
	await r.report(ana, true, { thread: "root-0", seq: started, at: edited });
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	expect(seen(viewer)).toEqual([]);

	await r.report(ana, true, { thread: "root-0" });
	expect(seen(viewer)).toEqual(["ana@root-0"]);
});

test("a connection that closed is forgotten: its next connection is numbered afresh", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let ana = r.join("ana");
	await r.report(ana, true, { seq: 9 });
	await r.leave(ana);
	let again = r.join("ana");
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	await r.report(again, true, { seq: 1 });
	expect(seen(viewer)).toEqual(["ana"]);
});

test("a reader whose access is taken back after joining is told nothing, on joining or after, while a reader who keeps it is", async () => {
	let r = room();
	let rae = r.join("rae", "rae-tab", false);
	let cy = r.join("cy", "cy-tab", false);
	let ana = r.join("ana");
	r.revoked.add(rae.ws.data.client);

	await r.greet(rae);
	await r.report(ana, true);
	await r.report(ana, true, { thread: "root-a" });
	await r.clock.advance(LEASE);
	expect(rae.frames).toEqual([]);
	expect(cy.frames.map(names)).toEqual([["ana"], ["ana", "ana@root-a"], []]);
});

test("a roster on its way to a reader whose access is taken back while it is checked never reaches them", async () => {
	let r = room();
	let rae = r.join("rae", "rae-tab", false);
	let cy = r.join("cy", "cy-tab", false);
	let ana = r.join("ana");
	let release = r.hold();
	await r.report(ana, true);
	expect(rae.frames).toEqual([]);
	r.revoked.add(rae.ws.data.client);
	await release();
	expect(rae.frames).toEqual([]);
	expect(seen(cy)).toEqual(["ana"]);
});

test("a writer who can no longer write is never shown for a report made since", async () => {
	let r = room();
	let bo = r.join("bo");
	let rae = r.join("rae", "rae-tab", false);
	let ana = r.join("ana");
	r.readOnly.add(ana.ws.data.client);

	await r.report(ana, true);
	await r.report(ana, true, { thread: "root-a" });
	await r.clock.advance(LEASE);
	expect(bo.frames.flatMap(names)).toEqual([]);
	expect(rae.frames.flatMap(names)).toEqual([]);
});

test("a writer who can no longer write is named in no roster told after, and what they were writing ends", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	let cy = r.join("cy");
	await r.report(ana, true);
	await r.report(ana, true, { thread: "root-a" });
	expect(seen(bo)).toEqual(["ana", "ana@root-a"]);
	let before = bo.frames.length;

	r.readOnly.add(ana.ws.data.client);
	await r.report(cy, true);
	expect(seen(bo)).toEqual(["cy"]);
	// Given write access back, nothing ana wrote before returns: only a new edit shows her again.
	r.readOnly.delete(ana.ws.data.client);
	await r.report(cy, false);
	await r.clock.advance(LEASE);
	expect(bo.frames.slice(before).map(names)).toEqual([["cy"], []]);
});

test("a member whose access can't be confirmed for now is told the newest roster once it can be", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	r.unconfirmed.add(bo.ws.data.client);
	await r.report(ana, true);
	expect(bo.frames).toEqual([]);
	await r.report(ana, false);
	await r.clock.advance(TYPING_RECHECK_MS - 1);
	expect(bo.frames).toEqual([]);

	r.unconfirmed.delete(bo.ws.data.client);
	await r.clock.advance(1);
	expect(bo.frames).toHaveLength(1);
	expect(seen(bo)).toEqual([]);
	expect(bo.frames[0]!.seq).toBe(2);
});

test("a writer who can no longer write stops writing in every place at once, and an old report stays refused", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let ana = r.join("ana");
	let phone = r.join("ana", "ana-phone");
	let edited = r.clock.now();
	let started = await r.report(ana, true, { at: edited });
	await r.report(ana, true, { thread: "root-a" });
	await r.report(phone, true, { thread: "root-b" });
	expect(seen(viewer)).toEqual(["ana", "ana@root-a", "ana@root-b"]);

	r.presence.retire(ana.ws.data.client);
	await flush();
	expect(seen(viewer)).toEqual(["ana@root-b"]);
	await r.report(ana, true, { seq: started, at: edited });
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	expect(seen(viewer)).toEqual(["ana@root-b"]);
});

test("a preempted turn's late end clears neither its replacement nor the people writing beside it", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let ana = r.join("ana");
	await r.report(ana, true, { thread: "root-a" });
	r.presence.composing("root-a", "preempted", true);
	r.presence.composing("root-a", "replacement", true);
	r.presence.composing("root-a", "preempted", false);
	await flush();
	expect(seen(viewer)).toEqual(["ana@root-a", "chopin@root-a"]);
	r.presence.composing("root-a", "replacement", false);
	await flush();
	expect(seen(viewer)).toEqual(["ana@root-a"]);
});

test("chopin is shown writing in a place for its turn; an earlier turn's end never clears a later one", async () => {
	let r = room();
	let viewer = r.join("viewer");

	r.presence.composing("root-a", "turn-1", true);
	r.presence.composing("root-a", "turn-1", true);
	await flush();
	expect(seen(viewer)).toEqual(["chopin@root-a"]);
	expect(viewer.frames).toHaveLength(1);

	r.presence.composing("root-a", "turn-2", true);
	r.presence.composing("root-a", "turn-1", false);
	await flush();
	expect(seen(viewer)).toEqual(["chopin@root-a"]);

	r.presence.composing(undefined, "turn-3", true);
	await flush();
	expect(seen(viewer)).toEqual(["chopin@root-a", "chopin"]);
	r.presence.composing("root-a", "turn-2", false);
	r.presence.composing(undefined, "turn-3", false);
	await flush();
	expect(seen(viewer)).toEqual([]);
});

test("closed, it tells nothing and keeps no timer", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let ana = r.join("ana");
	await r.report(ana, true);
	r.presence.close();
	await r.report(ana, true, { thread: "root-a" });
	r.presence.composing(undefined, "turn", true);
	await r.greet(viewer);
	await r.clock.advance(LEASE * 2);
	expect(viewer.frames).toHaveLength(1);
});
