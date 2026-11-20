/**
 * Who is writing, as presence: shown to everyone who can read the document but themselves, in the
 * order they began, from an edit until the connection says it stopped, sends, closes, or its last
 * edit is five seconds old, whatever order its reports arrive in and however often they repeat.
 */
import { expect, test } from "bun:test";

import { ManualClock } from "./initiative.test-fixtures";
import {
	createTypingPresence,
	TYPING_IDLE_MS,
	TYPING_START_INTERVAL_MS,
	TYPING_TRANSIT_MS,
} from "./typing";

import type { Chat as Wire } from "@chopin/protocol";
import type { Socket } from "../wire";

type Tab = { ws: Socket; frames: Wire.Typists[]; seq: number };

const LEASE = TYPING_IDLE_MS + TYPING_TRANSIT_MS;

function room(threads: string[] = ["root-a", "root-b"], clock = new ManualClock()) {
	let members: Tab[] = [];
	let lapsed = new Set<string>();
	let presence = createTypingPresence({
		clock,
		threadExists: rootId => threads.includes(rootId),
		members: () => members.map(member => member.ws),
		reads: member => !lapsed.has(member.data.client),
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
	/** A report from `member`, numbered after its last unless `seq` says otherwise. */
	let report = (
		member: Tab,
		active: boolean,
		options: { thread?: unknown; seq?: number; ago?: number } = {},
	) => {
		let seq = options.seq ?? ++member.seq;
		member.seq = Math.max(member.seq, seq);
		presence.type(member.ws.data.client, member.ws.data.principalId, member.ws.data.handle, {
			active,
			seq,
			...(options.thread === undefined ? {} : { thread: options.thread }),
			...(options.ago === undefined ? {} : { ago: options.ago }),
		});
		return seq;
	};
	let leave = (member: Tab) => {
		(member.ws.data as { closed: boolean }).closed = true;
		presence.depart(member.ws.data.client);
	};
	return { clock, presence, members, join, report, leave, lapsed };
}

let names = (frame: Wire.Typists | undefined) =>
	(frame?.typists ?? []).map(typist =>
		`${typist.author.kind === "agent" ? "chopin" : typist.author.handle}${
			typist.thread ? `@${typist.thread}` : ""
		}`
	);
let seen = (member: Tab) => names(member.frames.at(-1));

test("everyone in the room is told, readers included, nobody sees themself, and a closed socket hears nothing", () => {
	let r = room();
	let ana = r.join("ana");
	let bo = r.join("bo");
	let rae = r.join("rae", "rae-tab", false);
	let gone = r.join("cy");
	(gone.ws.data as { closed: boolean }).closed = true;

	r.report(ana, true);

	expect(seen(bo)).toEqual(["ana"]);
	expect(seen(rae)).toEqual(["ana"]);
	expect(seen(ana)).toEqual([]);
	expect(gone.frames).toEqual([]);
	expect(r.presence.frame("ana").typists).toEqual([]);
});

test("a joining reader is told who is writing now, and an empty room as empty", async () => {
	let r = room();
	let ana = r.join("ana");
	expect(r.presence.frame("bo")).toMatchObject({ kind: "chat:typists", typists: [] });
	r.report(ana, true);
	await r.clock.advance(1_000);
	expect(names(r.presence.frame("bo"))).toEqual(["ana"]);
});

test("a room opened again outranks every frame of the one before", () => {
	let clock = new ManualClock();
	let first = room(undefined, clock);
	let ana = first.join("ana");
	first.join("bo");
	first.report(ana, true);
	let old = first.presence.frame("bo");
	first.presence.close();
	let second = room(undefined, clock);
	let fresh = second.presence.frame("bo");
	expect(fresh.generation).toBeGreaterThan(old.generation);
	expect(fresh.typists).toEqual([]);
});

test("each place is its own: a thread's writing names it, and stopping one place leaves the others", () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");

	r.report(ana, true, { thread: "root-a" });
	r.report(ana, true, { thread: "root-b" });
	r.report(ana, true);
	expect(seen(bo)).toEqual(["ana@root-a", "ana@root-b", "ana"]);

	r.report(ana, false, { thread: "root-a" });
	expect(seen(bo)).toEqual(["ana@root-b", "ana"]);
	r.presence.sent(ana.ws.data.client, undefined);
	expect(seen(bo)).toEqual(["ana@root-b"]);
});

test("a thread that is not a message of Chat, or a report with no number, is ignored", () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	for (let thread of ["unknown", "", 7, "x".repeat(129), null]) r.report(ana, true, { thread });
	r.presence.type("ana-tab", "ana", "ana", { active: true });
	r.presence.type("ana-tab", "ana", "ana", { active: true, seq: "9" });
	expect(bo.frames).toEqual([]);
});

test("a person is shown once while any tab of theirs writes there; stopping or closing one leaves the other", async () => {
	let r = room();
	let bo = r.join("bo");
	let phone = r.join("ana", "ana-phone");
	let laptop = r.join("ana", "ana-laptop");

	r.report(phone, true, { thread: "root-a" });
	await r.clock.advance(100);
	r.report(laptop, true, { thread: "root-a" });
	expect(seen(bo)).toEqual(["ana@root-a"]);

	r.report(phone, false, { thread: "root-a" });
	r.leave(phone);
	expect(seen(bo)).toEqual(["ana@root-a"]);
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	r.report(laptop, true, { thread: "root-a" });
	await r.clock.advance(LEASE - 1);
	expect(seen(bo)).toEqual(["ana@root-a"]);
	r.leave(laptop);
	expect(seen(bo)).toEqual([]);
});

test("a tab's first edit just inside its person's interval keeps its own deadline once their other tab stops", async () => {
	let r = room();
	let bo = r.join("bo");
	let phone = r.join("ana", "ana-phone");
	let laptop = r.join("ana", "ana-laptop");

	r.report(phone, true);
	await r.clock.advance(TYPING_START_INTERVAL_MS - 1);
	r.report(laptop, true);
	r.report(phone, false);
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
		for (let index of order) r.report(ana, intents[index]!.active, { seq: intents[index]!.seq });
		await r.clock.advance(TYPING_START_INTERVAL_MS);
		expect(seen(bo)).toEqual(["ana"]);
	}
	for (let order of [[0, 1], [1, 0], [0, 1, 0, 1]]) {
		let r = room();
		let bo = r.join("bo");
		let ana = r.join("ana");
		for (let index of order) r.report(ana, intents[index]!.active, { seq: intents[index]!.seq });
		await r.clock.advance(TYPING_START_INTERVAL_MS);
		expect(seen(bo)).toEqual([]);
	}

	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	r.report(ana, true, { seq: 5 });
	r.report(ana, true, { seq: 5 });
	r.report(ana, true, { seq: 4 });
	expect(bo.frames).toHaveLength(1);
});

test("a report delivered again neither keeps its writer past their edit nor brings them back", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	let first = r.report(ana, true);

	await r.clock.advance(2_000);
	r.report(ana, true, { seq: first });
	await r.clock.advance(LEASE - 2_001);
	expect(seen(bo)).toEqual(["ana"]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual([]);
	r.report(ana, true, { seq: first });
	await r.clock.advance(10_000);
	expect(seen(bo)).toEqual([]);
});

test("a later report carrying the last edit keeps its writer until five seconds after that edit", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");

	r.report(ana, true);
	await r.clock.advance(2_000);
	r.report(ana, true, { ago: 500 });
	await r.clock.advance(4_499);
	expect(seen(bo)).toEqual(["ana"]);
	r.report(ana, false);
	expect(seen(bo)).toEqual([]);
});

test("a report early by jitter still keeps its writer five seconds after the edit it carries", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");

	r.report(ana, true);
	await r.clock.advance(1_400);
	r.report(ana, true, { ago: 100 });
	await r.clock.advance(LEASE - 101);
	expect(seen(bo)).toEqual(["ana"]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual([]);
});

test("a client that falls silent is dropped when the last edit it told of is five seconds old, plus transit", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");

	r.report(ana, true);
	await r.clock.advance(2_000);
	r.report(ana, true, { ago: 500 });
	await r.clock.advance(1_500 + LEASE - 2_001);
	expect(seen(bo)).toEqual(["ana"]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual([]);

	let cy = r.join("cy");
	r.report(cy, true);
	await r.clock.advance(LEASE - 1);
	expect(seen(bo)).toEqual(["cy"]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual([]);
});

test("an `ago` past what a composer may hold back is taken as two seconds", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	r.report(ana, true, { ago: -50_000 });
	await r.clock.advance(LEASE - 1);
	expect(seen(bo)).toEqual(["ana"]);
	await r.clock.advance(1);
	expect(seen(bo)).toEqual([]);
});

test("a quick stop and start is shown again only when the person's interval is up, and is never lost", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");

	r.report(ana, true);
	await r.clock.advance(50);
	r.report(ana, false);
	await r.clock.advance(50);
	r.report(ana, true);
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
	r.report(before, true);
	await r.clock.advance(300);
	r.leave(before);
	expect(seen(bo)).toEqual([]);

	let after = r.join("ana", "ana-after");
	await r.clock.advance(200);
	r.report(after, true);
	await r.clock.advance(TYPING_START_INTERVAL_MS - 500);
	expect(seen(bo)).toEqual(["ana"]);
});

test("one person's flood of reports changes what readers see at most twice an interval, and spends nobody else's", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");
	let cy = r.join("cy");

	for (let index = 0; index < 50; index++) {
		r.report(ana, true);
		r.report(ana, false);
		await r.clock.advance(20);
	}
	expect(bo.frames.length).toBeLessThanOrEqual(2);
	r.report(cy, true);
	r.report(ana, true, { thread: "root-a" });
	expect(seen(bo)).toEqual(["cy", "ana@root-a"]);
});

test("readers are told only when who is writing changes, each time with a larger number", async () => {
	let r = room();
	let bo = r.join("bo");
	let ana = r.join("ana");

	r.report(ana, true);
	for (let step = 0; step < 3; step++) {
		await r.clock.advance(2_000);
		r.report(ana, true);
	}
	expect(bo.frames).toHaveLength(1);
	r.report(ana, false);
	r.report(ana, false);
	expect(bo.frames).toHaveLength(2);
	expect(bo.frames[1]!.seq).toBeGreaterThan(bo.frames[0]!.seq);
});

test("people are listed in the order they began", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let bo = r.join("bo");
	let ana = r.join("ana");
	r.report(bo, true);
	await r.clock.advance(10);
	r.report(ana, true);
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	r.report(bo, true);
	expect(seen(viewer)).toEqual(["bo", "ana"]);
});

test("at most 64 connections are shown writing at once", () => {
	let r = room();
	let viewer = r.join("viewer");
	for (let index = 0; index < 70; index++) r.report(r.join(`p${index}`), true);
	expect(viewer.frames.at(-1)!.typists).toHaveLength(64);
});

/** Fills the room with 64 connections that wrote and stopped, so what is no longer shown is reclaimed. */
function crowd(r: ReturnType<typeof room>) {
	for (let index = 0; index < 64; index++) {
		let other = r.join(`p${index}`);
		r.report(other, true);
		r.report(other, false);
	}
}

test("reclaiming what is no longer shown never lets an old report bring back a stopped writer or silence a newer one", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let ana = r.join("ana");

	let started = r.report(ana, true);
	let stopped = r.report(ana, false);
	crowd(r);
	await r.clock.advance(2_000);
	r.report(ana, true, { seq: started });
	r.report(ana, false, { seq: stopped });
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	expect(seen(viewer)).toEqual([]);

	let expired = r.report(ana, true);
	await r.clock.advance(LEASE);
	expect(seen(viewer)).toEqual([]);
	crowd(r);
	r.report(ana, true, { seq: expired });
	r.report(ana, true, { seq: started });
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	expect(seen(viewer)).toEqual([]);

	r.report(ana, true);
	expect(seen(viewer)).toEqual(["ana"]);
	crowd(r);
	r.report(ana, false, { seq: stopped });
	r.report(ana, false, { seq: expired });
	await r.clock.advance(LEASE - 1);
	expect(seen(viewer)).toEqual(["ana"]);
});

test("with every slot shown writing, a stop's number still stands, so an older start never brings its writer back", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let ana = r.join("ana");
	let others = Array.from({ length: 64 }, (_, index) => r.join(`p${index}`));
	for (let other of others) r.report(other, true);

	r.report(ana, false, { seq: 2 });
	r.report(ana, true, { seq: 3 });
	expect(seen(viewer)).not.toContain("ana");
	r.leave(others[0]!);
	r.report(ana, true, { seq: 1 });
	r.report(ana, true, { seq: 3 });
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	expect(seen(viewer)).not.toContain("ana");

	r.report(ana, true, { seq: 4 });
	expect(seen(viewer)).toContain("ana");
});

test("a connection that writes in more places than are kept still refuses an old report in the first", async () => {
	let threads = Array.from({ length: 70 }, (_, index) => `root-${index}`);
	let r = room(threads);
	let viewer = r.join("viewer");
	let ana = r.join("ana");

	let started = r.report(ana, true, { thread: "root-0" });
	r.report(ana, false, { thread: "root-0" });
	for (let thread of threads.slice(1)) r.report(ana, false, { thread });
	crowd(r);
	r.report(ana, true, { thread: "root-0", seq: started });
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	expect(seen(viewer)).toEqual([]);

	r.report(ana, true, { thread: "root-0" });
	expect(seen(viewer)).toEqual(["ana@root-0"]);
});

test("a connection that closed is forgotten: its next connection is numbered afresh", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let ana = r.join("ana");
	r.report(ana, true, { seq: 9 });
	r.leave(ana);
	let again = r.join("ana");
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	r.report(again, true, { seq: 1 });
	expect(seen(viewer)).toEqual(["ana"]);
});

test("a member whose access has lapsed is told nothing, while a reader whose access holds still is", () => {
	let r = room();
	let rae = r.join("rae", "rae-tab", false);
	let bo = r.join("bo");
	let ana = r.join("ana");
	r.lapsed.add(bo.ws.data.client);

	r.report(ana, true);
	expect(seen(rae)).toEqual(["ana"]);
	expect(bo.frames).toEqual([]);
});

test("a writer who can no longer write stops writing in every place at once, and an old report stays refused", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let ana = r.join("ana");
	let phone = r.join("ana", "ana-phone");
	let started = r.report(ana, true);
	r.report(ana, true, { thread: "root-a" });
	r.report(phone, true, { thread: "root-b" });
	expect(seen(viewer)).toEqual(["ana", "ana@root-a", "ana@root-b"]);

	r.presence.retire(ana.ws.data.client);
	expect(seen(viewer)).toEqual(["ana@root-b"]);
	r.report(ana, true, { seq: started });
	await r.clock.advance(TYPING_START_INTERVAL_MS);
	expect(seen(viewer)).toEqual(["ana@root-b"]);
});

test("a preempted turn's late end clears neither its replacement nor the people writing beside it", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let ana = r.join("ana");
	r.report(ana, true, { thread: "root-a" });
	r.presence.composing("root-a", "preempted", true);
	r.presence.composing("root-a", "replacement", true);
	r.presence.composing("root-a", "preempted", false);
	expect(seen(viewer)).toEqual(["ana@root-a", "chopin@root-a"]);
	r.presence.composing("root-a", "replacement", false);
	expect(seen(viewer)).toEqual(["ana@root-a"]);
});

test("chopin is shown writing in a place for its turn; an earlier turn's end never clears a later one", () => {
	let r = room();
	let viewer = r.join("viewer");

	r.presence.composing("root-a", "turn-1", true);
	r.presence.composing("root-a", "turn-1", true);
	expect(seen(viewer)).toEqual(["chopin@root-a"]);
	expect(viewer.frames).toHaveLength(1);

	r.presence.composing("root-a", "turn-2", true);
	r.presence.composing("root-a", "turn-1", false);
	expect(seen(viewer)).toEqual(["chopin@root-a"]);

	r.presence.composing(undefined, "turn-3", true);
	expect(seen(viewer)).toEqual(["chopin@root-a", "chopin"]);
	r.presence.composing("root-a", "turn-2", false);
	r.presence.composing(undefined, "turn-3", false);
	expect(seen(viewer)).toEqual([]);
});

test("closed, it tells nothing and keeps no timer", async () => {
	let r = room();
	let viewer = r.join("viewer");
	let ana = r.join("ana");
	r.report(ana, true);
	r.presence.close();
	r.report(ana, true, { thread: "root-a" });
	r.presence.composing(undefined, "turn", true);
	await r.clock.advance(LEASE * 2);
	expect(viewer.frames).toHaveLength(1);
});
