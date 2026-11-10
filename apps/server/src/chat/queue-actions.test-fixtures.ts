/**
 * What a person can do with a message waiting in the Planner's queue, as a hosted document keeps it
 * (every request a durable row): cancel it, edit it, and lose to its turn starting first. One suite,
 * run on memory storage and on PostgreSQL.
 */
import { expect, test } from "bun:test";

import { ulid } from "@chopin/dialect";

import * as Chat from "./service";
import { memberEntry, tick, waitFor } from "./deferred.test-fixtures";

import type { world } from "./deferred.test-fixtures";

type World = Awaited<ReturnType<typeof world>>;
type Open = (extra?: { away?: boolean }) => Promise<World>;

type Frame = { kind: string; rid?: string; [key: string]: unknown };

function answer(frames: Frame[], rid: string): Frame {
	return frames.find(frame => frame.rid === rid)!;
}

async function cancelling(w: World, who: "ana" | "bob", id: string): Promise<Frame> {
	let person = w.socket(who);
	let rid = `cancel-${crypto.randomUUID()}`;
	await Chat.unqueue(
		{ ...w.context, claimantSessionId: w.logins[who].id },
		person.ws,
		{ kind: "chat:unqueue", rid, id, ts: 0 } as never,
	);
	return answer(person.frames, rid);
}

async function editing(
	w: World,
	who: "ana" | "bob",
	id: string,
	text: string,
	extra: { references?: unknown } = {},
): Promise<Frame> {
	let person = w.socket(who);
	let rid = `edit-${crypto.randomUUID()}`;
	await Chat.edit(
		{ ...w.context, claimantSessionId: w.logins[who].id },
		person.ws,
		{ kind: "chat:edit", rid, id, text, ts: 0, ...extra } as never,
	);
	return answer(person.frames, rid);
}

/** Resolves each requested range to a document reference labelled by the text it covers. */
const references = {
	resolve: async (input: {
		text: string;
		requests?: Array<{ kind: "document"; channelId: string; start: number; end: number }>;
	}) => {
		let text = input.text.trim();
		return {
			text,
			references: (input.requests ?? []).map(request => ({
				id: ulid(),
				kind: "document" as const,
				start: request.start,
				end: request.end,
				label: text.slice(request.start, request.end),
				href: "/documents/octo-org/score/other",
				repositoryId: "R_score",
				observedRevision: 0,
				channelId: request.channelId,
				observedSourceHash: `sha256:${"a".repeat(64)}`,
			})),
		};
	},
};

const queueOf = (w: World) =>
	(w.events.findLast(event => event.kind === "chat:queue") as unknown as {
		waiting: Array<{ id: string; handle: string; text: string; kind?: string }>;
	}).waiting;

const texts = async (w: World, states?: Parameters<World["rows"]>[0]) =>
	(await w.rows(states)).map(row => row.text);

export function queueActions(open: Open, options: { interleavings?: number } = {}) {
	let interleavings = options.interleavings ?? 8;
	test("the author cancels a waiting message: it leaves the queue and the Chat for everyone, in the commit that cancels its row, and the others keep their order", async () => {
		let w = await open({ away: true });
		let first = await w.send("first");
		let second = await w.send("second");
		let third = await w.send("third");
		expect(queueOf(w).map(item => item.text)).toEqual(["first", "second", "third"]);

		let answered = await cancelling(w, "ana", second.id as string);
		expect(answered).toMatchObject({ kind: "chat:unqueue", id: second.id });
		expect(queueOf(w).map(item => item.text)).toEqual(["first", "third"]);
		expect(memberEntry(w.context, "second")).toBeUndefined();
		expect(w.events.some(event => event.kind === "chat:removed" && event.id === second.id)).toBe(
			true,
		);
		let rows = await w.rows();
		expect(rows.map(row => [row.text, row.state])).toEqual([
			["first", "waiting"],
			["second", "cancelled"],
			["third", "waiting"],
		]);
		// No reason: the sender took it back.
		expect(rows[1]!.cancelReason).toBeUndefined();

		// Cancelling again leaves it cancelled.
		expect(await cancelling(w, "ana", second.id as string)).toMatchObject({
			kind: "chat:unqueue",
			id: second.id,
		});

		// It is never delivered; the rest are, in order.
		await w.attach();
		await w.turns(2);
		expect(w.prompts).toHaveLength(2);
		expect(w.prompts[0]).toContain("first");
		expect(w.prompts[1]).toContain("third");
		expect(w.prompts.join("\n")).not.toContain("second");
		expect(first.queued && third.queued).toBe(true);
	});

	test("only its author may cancel or edit a waiting message, and everyone else sees it unchanged", async () => {
		let w = await open({ away: true });
		let mine = await w.send("ana's message");
		let before = await w.rows(["waiting"]);

		for (
			let attempt of [
				await cancelling(w, "bob", mine.id as string),
				await editing(w, "bob", mine.id as string, "bob rewrote it"),
			]
		) {
			expect(attempt).toMatchObject({ kind: "session:error" });
			// A final refusal: no code says it can be sent again, and `already-started` would be false.
			expect(attempt.code).toBeUndefined();
			expect(String(attempt.message)).toMatch(/author/);
		}
		expect(await w.rows(["waiting"])).toEqual(before);
		expect(memberEntry(w.context, "ana's message")?.deliveryState).toBe("sent");
		expect(queueOf(w)).toEqual([{ id: mine.id as string, handle: "ana", text: "ana's message" }]);

		await w.attach();
		await w.turns(1);
		expect(w.prompts[0]).toContain("ana's message");
		expect(w.prompts[0]).not.toContain("bob rewrote it");
	});

	test("the author edits a waiting message: the row, the entry and the queue read the new text at the same place, and the turn is given it", async () => {
		let w = await open({ away: true });
		let first = await w.send("first");
		let second = await w.send("second");
		let rowIds = (await w.rows()).map(row => row.id);

		let answered = await editing(w, "ana", second.id as string, "second, but sharper");
		expect(answered).toMatchObject({
			kind: "chat:edit",
			id: second.id,
			text: "second, but sharper",
		});
		expect(queueOf(w).map(item => item.text)).toEqual(["first", "second, but sharper"]);
		expect(memberEntry(w.context, "second, but sharper")?.deliveryState).toBe("sent");
		expect(memberEntry(w.context, "second")).toBeUndefined();
		expect(w.events.findLast(event => event.kind === "chat:message")).toMatchObject({
			entry: { id: second.id, text: "second, but sharper" },
		});
		// Same rows, same order, nothing but the text moved; durable before it was shown.
		expect((await w.rows()).map(row => row.id)).toEqual(rowIds);
		expect(await texts(w, ["waiting"])).toEqual(["first", "second, but sharper"]);
		let stored = await w.storage.collaboration.load(w.channel.id, new Date());
		expect(JSON.stringify(stored!.sidecar)).toContain("second, but sharper");
		expect(JSON.stringify(stored!.sidecar)).not.toContain('"second"');

		// A message to the Planner is edited by the rules of one: its mention is not content.
		await editing(w, "ana", first.id as string, "@chopin  first,   tightened ");
		expect(queueOf(w)[0]!.text).toBe("first, tightened");

		await w.attach();
		await w.turns(2);
		expect(w.prompts[0]).toContain("first, tightened");
		expect(w.prompts[1]).toContain("second, but sharper");
		expect(w.prompts.join("\n")).not.toMatch(/second(?!,)/);
		expect(memberEntry(w.context, "second, but sharper")?.deliveryState).toBe("delivered");
		expect((await w.rows()).map(row => row.state)).toEqual(["ended", "ended"]);
	});

	test("an edit takes what a send takes, and refuses what a send refuses", async () => {
		let w = await open({ away: true });
		let sent = await w.send("keep me");
		for (let blank of ["", "   \n ", "@chopin"]) {
			let refused = await editing(w, "ana", sent.id as string, blank);
			expect(refused).toMatchObject({ kind: "session:error", message: "message text is empty" });
		}
		let oversize = await editing(w, "ana", sent.id as string, "x".repeat(64 * 1024 + 1));
		expect(oversize).toMatchObject({
			kind: "session:error",
			message: "chat message exceeds the 64 KiB limit",
		});
		// What a send takes: exactly the largest message, in any words.
		let largest = "y".repeat(64 * 1024);
		expect(await editing(w, "ana", sent.id as string, largest)).toMatchObject({
			kind: "chat:edit",
		});
		expect(await texts(w, ["waiting"])).toEqual([largest]);
		// A reference nobody can resolve is refused as it is on a send, and changes nothing.
		let refused = await editing(w, "ana", sent.id as string, "see #Elsewhere", {
			references: [{
				kind: "document",
				channelId: crypto.randomUUID(),
				start: 4,
				end: 14,
			}],
		});
		expect(refused).toMatchObject({ kind: "session:error" });
		expect(await texts(w, ["waiting"])).toEqual([largest]);
	});

	test("a message whose turn started is already started: an edit and a cancel are refused plainly and change nothing", async () => {
		let w = await open({ away: true });
		let sent = await w.send("on its way");
		await w.attach();
		await w.turns(1);
		let before = await w.rows();
		expect(before[0]!.state).toBe("ended");

		for (
			let attempt of [
				await editing(w, "ana", sent.id as string, "too late"),
				await cancelling(w, "ana", sent.id as string),
				// An id nothing waits under is the same answer, whatever it names.
				await cancelling(w, "ana", crypto.randomUUID()),
				await editing(w, "ana", crypto.randomUUID(), "nothing here"),
			]
		) {
			expect(attempt).toMatchObject({ kind: "session:error", code: "already-started" });
			expect(String(attempt.message)).toMatch(/started/);
		}
		expect(await w.rows()).toEqual(before);
		expect(memberEntry(w.context, "on its way")?.deliveryState).toBe("delivered");
		expect(memberEntry(w.context, "too late")).toBeUndefined();
		expect(w.prompts).toHaveLength(1);
	});

	test("an edit saved while the start of its turn is waiting on its check is the text the turn reads", async () => {
		let w = await open({ away: false });
		w.planner.hold();
		await w.send("running");
		await waitFor(() => w.planner.running === 1);
		let second = await w.send("second");
		let release = w.slowCheck();
		w.planner.hold(false);
		w.planner.release();
		// The running turn ends and the queue asks whether the machine is there; the answer waits.
		await tick();
		expect((await w.rows(["waiting"])).map(row => row.text)).toEqual(["second"]);
		expect(await editing(w, "ana", second.id as string, "second, edited")).toMatchObject({
			kind: "chat:edit",
		});
		release();
		await w.turns(2);
		expect(w.prompts[1]).toContain("second, edited");
		expect(w.prompts[1]).not.toMatch(/second(?!,)/);
	});

	test("the queue does not start a message while its edit is being saved, and then reads the edit", async () => {
		let w = await open({ away: false });
		w.planner.hold();
		await w.send("running");
		await waitFor(() => w.planner.running === 1);
		let second = await w.send("second");

		// The edit's commit is held, as a slow database holds it.
		let saving = Promise.withResolvers<void>();
		let context = w.context;
		let persist = context.persist;
		context.persist = async (...args) => {
			await saving.promise;
			return persist(...args);
		};
		let edited = editing(w, "ana", second.id as string, "second, edited");
		await tick();
		context.persist = persist;

		// The running turn ends while the edit is unsaved: the queue must wait for it.
		w.planner.hold(false);
		w.planner.release();
		await tick();
		await tick();
		expect(w.prompts).toHaveLength(1);
		saving.resolve();
		expect(await edited).toMatchObject({ kind: "chat:edit", text: "second, edited" });
		await w.turns(2);
		expect(w.prompts[1]).toContain("second, edited");
		expect((await w.rows()).map(row => row.state)).toEqual(["ended", "ended"]);
	});

	test("an edit and the start of its turn, however they interleave, agree: the turn reads the edit exactly when the edit was answered", async () => {
		for (let offset = 0; offset < interleavings; offset++) {
			let w = await open({ away: false });
			w.planner.hold();
			await w.send("running");
			await waitFor(() => w.planner.running === 1);
			let second = await w.send("second");
			w.planner.hold(false);
			w.planner.release();
			for (let step = 0; step < offset; step++) await Promise.resolve();
			let answered = await editing(w, "ana", second.id as string, "second, edited");
			await w.turns(2);
			let row = (await w.rows()).find(value => value.requestId === second.id)!;
			let entry = w.context.chat.entries.find(value => value.id === second.id)!;
			let read = w.prompts[1]!.includes("second, edited");
			if (answered.kind === "chat:edit") {
				expect({ offset, read, row: row.text, entry: entry.text }).toEqual({
					offset,
					read: true,
					row: "second, edited",
					entry: "second, edited",
				});
			} else {
				expect({ offset, code: answered.code, read, row: row.text, entry: entry.text }).toEqual({
					offset,
					code: "already-started",
					read: false,
					row: "second",
					entry: "second",
				});
			}
		}
	});

	test("an edit is not shown to the room before it is saved, and a commit that fails leaves everything as it was", async () => {
		let w = await open({ away: false });
		w.planner.hold();
		await w.send("running");
		await waitFor(() => w.planner.running === 1);
		let second = await w.send("second");
		let rowsBefore = await w.rows();

		// The edit's commit is held, then fails, as a database that goes away does.
		let saving = Promise.withResolvers<void>();
		let context = w.context;
		let persist = context.persist;
		context.persist = async () => {
			await saving.promise;
			throw new Error("commit failed");
		};
		let edited = editing(w, "ana", second.id as string, "UNSAVED EDIT");
		await tick();
		context.persist = persist;

		// Other work reaches the queue while the commit is pending; the room is shown what is saved.
		void Chat.job(
			context,
			{
				id: "j",
				kind: "heading",
				target: "t",
				trigger: "x",
				status: "pending",
				attempts: 0,
				at: "",
			} as never,
			"prompt",
			undefined,
		);
		expect(JSON.stringify(w.events)).not.toContain("UNSAVED EDIT");
		saving.resolve();
		expect(await edited).toMatchObject({
			kind: "session:error",
			code: "temporarily-unavailable",
		});
		expect(JSON.stringify(w.events)).not.toContain("UNSAVED EDIT");
		expect(queueOf(w).map(item => item.text)).toContain("second");
		expect(context.chat.waiting.find(item => item.id === second.id)!.text).toBe("second");
		expect(memberEntry(context, "second")?.deliveryState).toBe("sent");
		expect(await w.rows()).toEqual(rowsBefore);
		w.planner.hold(false);
		w.planner.release();
	});

	test("a cancel whose commit fails changes nothing and tells nobody; the same cancel then goes through", async () => {
		let w = await open({ away: true });
		let first = await w.send("first");
		let second = await w.send("second");
		let context = w.context;
		let persist = context.persist;
		context.persist = async () => {
			throw new Error("commit failed");
		};
		let seen = w.events.length;

		let refused = await cancelling(w, "ana", second.id as string);
		context.persist = persist;

		expect(refused).toMatchObject({ kind: "session:error", code: "temporarily-unavailable" });
		expect(w.events.length).toBe(seen);
		expect(queueOf(w).map(item => item.text)).toEqual(["first", "second"]);
		expect(memberEntry(context, "second")?.deliveryState).toBe("sent");
		expect((await w.rows()).map(row => row.state)).toEqual(["waiting", "waiting"]);

		expect(await cancelling(w, "ana", second.id as string)).toMatchObject({
			kind: "chat:unqueue",
		});
		expect(queueOf(w).map(item => item.text)).toEqual(["first"]);
		expect(first.queued).toBe(true);
	});

	test("every cancel ends in cancelQueuedJobs: whoever waits on the turn is told it was skipped", async () => {
		let w = await open({ away: true });
		let sent = await w.send("to cancel");
		let skipped: unknown[] = [];
		w.context.chat.waiting.find(item => item.id === sent.id)!.ended = outcome =>
			void skipped.push(outcome);

		expect(await cancelling(w, "ana", sent.id as string)).toMatchObject({
			kind: "chat:unqueue",
		});
		await tick();
		expect(skipped).toEqual([{ status: "skipped" }]);
		expect(w.context.chat.waiting).toEqual([]);
		expect(queueOf(w)).toEqual([]);
	});

	test("a message whose turn is being started is not yet started: it is told to try again, and once the turn has started it is refused as started", async () => {
		let w = await open({ away: false });
		w.planner.hold();
		await w.send("running");
		await waitFor(() => w.planner.running === 1);
		let second = await w.send("second");

		// The commit that starts the next turn is slow, as a busy database makes it.
		let collaboration = w.storage.collaboration;
		let commit = collaboration.commit.bind(collaboration);
		let starting = Promise.withResolvers<void>();
		let entered = Promise.withResolvers<void>();
		collaboration.commit = async input => {
			if (
				input.deferredTurns?.some(change =>
					change.action === "transition" && change.to === "started"
				)
			) {
				entered.resolve();
				await starting.promise;
			}
			return commit(input);
		};
		w.planner.hold(false);
		w.planner.release();
		await entered.promise;
		// Taken from the queue, and its row still waiting: nothing has been decided yet.
		expect(w.context.chat.waiting.some(item => item.id === second.id)).toBe(false);
		expect((await w.rows(["waiting"])).map(row => row.text)).toEqual(["second"]);

		let edit = await editing(w, "ana", second.id as string, "second, edited");
		let cancel = await cancelling(w, "ana", second.id as string);
		for (let attempt of [edit, cancel]) {
			expect(attempt).toMatchObject({ kind: "session:error", code: "temporarily-unavailable" });
		}
		expect((await w.rows(["waiting"])).map(row => row.text)).toEqual(["second"]);

		starting.resolve();
		await w.turns(2);
		collaboration.commit = commit;
		// Now it has started: the answer is final, and the turn read what was sent.
		for (
			let attempt of [
				await editing(w, "ana", second.id as string, "second, edited"),
				await cancelling(w, "ana", second.id as string),
			]
		) {
			expect(attempt).toMatchObject({ kind: "session:error", code: "already-started" });
		}
		expect(w.prompts[1]).toContain("second");
		expect(w.prompts[1]).not.toContain("edited");
	});

	test("a message the system cancelled is cancelled: cancelling it again is done and editing it says so, and nobody else is told anything of it", async () => {
		let w = await open({ away: true });
		let sent = await w.send("reset away");
		await Chat.cancelQueued(w.context, "agent");
		expect((await w.rows())[0]!.state).toBe("cancelled");

		expect(await cancelling(w, "ana", sent.id as string)).toMatchObject({
			kind: "chat:unqueue",
		});
		let edit = await editing(w, "ana", sent.id as string, "too late");
		expect(edit).toMatchObject({ kind: "session:error", message: "this message was cancelled" });
		expect(edit.code).toBeUndefined();
		// Somebody else's message is theirs, whatever became of it.
		let other = await cancelling(w, "bob", sent.id as string);
		expect(other).toMatchObject({ kind: "session:error" });
		expect(other.code).toBeUndefined();
	});

	test("what waits for the Planner in plain words is shown to everyone and changed by no one: a comment, a task draft and an automatic follow-up", async () => {
		let w = await open();
		w.planner.hold();
		await w.send("running");
		await waitFor(() => w.planner.running === 1);
		await w.send("a message");
		await Chat.invoke(
			w.context,
			{ id: w.ana.id, login: "ana" },
			"SECRET follow-up prompt",
			undefined,
			undefined,
			undefined,
			"Automatic follow-up requested by @ana.",
		);
		await Chat.draftTasks(w.context, "ana", 4, "SECRET draft prompt", "ana asked for tasks");
		await Chat.instruct(
			w.context,
			"ana",
			"SECRET comment prompt",
			"Comment on “x” sent to Chopin",
			{
				thread: "thread-1",
				defer: { kind: "comment", userId: w.ana.id },
			},
		);

		let shown = queueOf(w);
		expect(shown.map(item => [item.kind, item.text, item.handle])).toEqual([
			[undefined, "a message", "ana"],
			["followup", "Automatic follow-up", "ana"],
			["draft", "Draft of the build tasks", "ana"],
			["comment", "Reply to a comment", "ana"],
		]);
		expect(JSON.stringify(w.events.filter(event => event.kind === "chat:queue"))).not.toContain(
			"SECRET",
		);
		let before = await w.rows(["waiting"]);
		for (let item of shown.slice(1)) {
			expect(await cancelling(w, "ana", item.id)).toMatchObject({ kind: "session:error" });
			expect(await editing(w, "ana", item.id, "rewritten")).toMatchObject({
				kind: "session:error",
			});
		}
		expect(await w.rows(["waiting"])).toEqual(before);
		expect(queueOf(w)).toEqual(shown);
		w.planner.hold(false);
		for (let turn = 0; turn < 5; turn++) w.planner.release();
		await w.turns(5);
		expect(queueOf(w)).toEqual([]);
	});

	test("the references of an edited message are kept with its row: they still point where its text says, after a restart too", async () => {
		let w = await open({ away: true });
		w.context.references = references as never;
		let target = crypto.randomUUID();
		let requestId = crypto.randomUUID();
		await Chat.send(
			w.context,
			w.socket().ws,
			{
				kind: "chat:send",
				rid: "send",
				requestId,
				to: "planner",
				text: "fix #Other",
				references: [{ kind: "document", channelId: target, start: 4, end: 10 }],
				ts: 0,
			} as never,
		);
		expect((await w.rows())[0]!.references).toMatchObject([{ start: 4, end: 10 }]);

		// Words added before it: the reference moves with its text, in the entry and in the row.
		let moved = await editing(w, "ana", requestId, "please fix #Other");
		expect(moved).toMatchObject({ kind: "chat:edit", references: [{ start: 11, end: 17 }] });
		expect((await w.rows())[0]!.references).toMatchObject([{
			start: 11,
			end: 17,
			label: "#Other",
		}]);
		let restarted = await w.restart();
		await Chat.recover(restarted);
		await tick();
		let [kept] = restarted.chat.waiting;
		expect(kept!.text).toBe("please fix #Other");
		expect(kept!.references).toMatchObject([{ start: 11, end: 17, label: "#Other" }]);
		expect(queueOf(w)[0]).toMatchObject({ references: [{ start: 11, end: 17 }] });

		// Touched by the edit, it is dropped everywhere, and the text stays the person's.
		restarted.references = references as never;
		let touched = await editing(w, "ana", requestId, "please fix #Othe");
		expect(touched.kind).toBe("chat:edit");
		expect(touched.references).toBeUndefined();
		expect((await w.rows())[0]!.references).toEqual([]);
		// References the edit names itself are resolved as a send resolves them, and kept the same way.
		let named = await editing(w, "ana", requestId, "see #Other and #More", {
			references: [
				{ kind: "document", channelId: target, start: 4, end: 10 },
				{ kind: "document", channelId: crypto.randomUUID(), start: 15, end: 20 },
			],
		});
		expect(named).toMatchObject({ kind: "chat:edit", references: [{ start: 4 }, { start: 15 }] });
		let again = await w.restart();
		await Chat.recover(again);
		await tick();
		expect(again.chat.waiting[0]!.references).toMatchObject([
			{ start: 4, end: 10, label: "#Other" },
			{ start: 15, end: 20, label: "#More" },
		]);
		await w.attach();
		await w.turns(1);
		// The Planner is given each reference by the id its row kept, so a stale range would lose it.
		expect(w.prompts[0]).toMatch(
			/see #Other \[reference id: \w+\] and #More \[reference id: \w+\]/,
		);
	});

	test("an edit is kept through a restart: the next process starts the message with the edited text", async () => {
		let w = await open({ away: true });
		let sent = await w.send("before the restart");
		await editing(w, "ana", sent.id as string, "after the edit");
		let restarted = await w.restart();
		await Chat.recover(restarted);
		await tick();
		expect(restarted.chat.waiting.map(item => item.text)).toEqual(["after the edit"]);
		expect(memberEntry(restarted, "after the edit")?.deliveryState).toBe("sent");
		expect(queueOf(w).map(item => item.text)).toEqual(["after the edit"]);
		await w.attach();
		await w.turns(1);
		expect(w.prompts[0]).toContain("after the edit");
		expect(w.prompts[0]).not.toContain("before the restart");
	});
}
