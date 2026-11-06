/**
 * Planner requests that were acknowledged and have not started, kept as rows: written before the
 * acknowledgement, started once and in order under the start rule, and never lost by a restart.
 */
import { afterEach, expect, spyOn, test } from "bun:test";

import { expectPlain, expectPlainStatus } from "../testing/plain-words";
import {
	cancelledNotice,
	interruptedNotice,
	WAITING_NOTICE,
	WAITING_NOTICE_REMOTE,
} from "./deferred";
import * as Chat from "./service";
import { cleanups, memberEntry, tick, waitFor, world } from "./deferred.test-fixtures";

afterEach(async () => {
	Chat.holdStarts(false);
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

test("a message that waits behind a running turn is saved as a row before it is acknowledged, shows as sent, and starts once the turn ends", async () => {
	let w = await world();
	w.planner.hold();
	await w.send("first");
	await waitFor(() => w.planner.running === 1);

	let answer = await w.send("second");
	expect(answer).toMatchObject({ kind: "chat:send", queued: true });
	let [row] = await w.rows(["waiting"]);
	expect(row).toMatchObject({
		kind: "composer",
		requestId: answer.id,
		text: "second",
		handle: "ana",
	});
	// In the transcript at once, marked sent, and not twice in the queue's own listing.
	expect(memberEntry(w.context, "second")?.deliveryState).toBe("sent");
	let queue = w.events.findLast(event => event.kind === "chat:queue") as unknown as
		| { waiting: unknown[] }
		| undefined;
	expect(queue?.waiting ?? []).toEqual([]);
	// What the commit saved already holds the message: nothing was acknowledged ahead of it.
	let stored = await w.storage.collaboration.load(w.channel.id, new Date());
	expect(JSON.stringify(stored!.sidecar)).toContain('"second"');

	w.planner.hold(false);
	w.planner.release();
	await w.turns(2);
	expect(w.prompts.filter(prompt => prompt.includes("second"))).toHaveLength(1);
	expect(memberEntry(w.context, "second")?.deliveryState).toBe("delivered");
	expect((await w.rows()).map(value => value.state)).toEqual(["ended"]);
});

test("a retried send gets its first acknowledgement back, from memory and from the rows after a restart, and starts no second turn", async () => {
	let w = await world();
	w.planner.hold();
	await w.send("first");
	await waitFor(() => w.planner.running === 1);
	let requestId = crypto.randomUUID();
	let first = await w.send("second", "ana", { requestId });
	let again = await w.send("second", "ana", { requestId });
	expect(again).toMatchObject({ id: first.id, queued: true });
	expect(await w.rows()).toHaveLength(1);

	// The same request with other words is a different request, not a retry.
	let other = await w.send("something else", "ana", { requestId });
	expect(other.kind).toBe("session:error");
	expect(await w.rows()).toHaveLength(1);

	w.planner.hold(false);
	w.planner.release();
	await w.turns(2);
	let restarted = await w.restart();
	// Taken since: the row says so, and the retry is told it is no longer waiting.
	let late = await w.send("second", "ana", { requestId });
	expect(late).toMatchObject({ id: first.id, queued: false });
	expect(restarted.chat.waiting).toEqual([]);
	expect(w.prompts.filter(prompt => prompt.includes("second"))).toHaveLength(1);
});

test("requests waiting behind a running turn survive a restart in order and start under the same owner, once", async () => {
	let w = await world();
	w.planner.hold();
	await w.send("running");
	await waitFor(() => w.planner.running === 1);
	await w.send("one");
	await w.send("two", "bob");
	expect((await w.rows(["waiting"])).map(row => row.text)).toEqual(["one", "two"]);

	// The process ends mid-turn: the running turn's request has no row, the other two do.
	let restarted = await w.restart();
	expect(restarted.chat.waiting).toEqual([]);
	w.planner.hold(false);
	await Chat.recover(restarted);
	await w.turns(3);
	let given = w.prompts.slice(1);
	expect(given).toHaveLength(2);
	expect(given.findIndex(prompt => prompt.includes("one"))).toBeLessThan(
		given.findIndex(prompt => prompt.includes("two")),
	);
	expect((await w.rows()).map(row => row.state)).toEqual(["ended", "ended"]);
	expect(memberEntry(restarted, "one")?.deliveryState).toBe("delivered");
	// Recovering again finds nothing left to run.
	await Chat.recover(restarted);
	await tick();
	expect(w.prompts).toHaveLength(3);
});

test("a row a turn had started under an earlier writer is marked interrupted, says so once, and is never run again", async () => {
	let w = await world();
	w.planner.hold();
	await w.send("running");
	await waitFor(() => w.planner.running === 1);
	await w.send("queued");
	let [row] = await w.rows(["waiting"]);
	// Its turn had begun when the process stopped.
	await w.storage.deferredTurns.transition(w.lease, {
		id: row!.id,
		from: "waiting",
		to: "started",
		at: new Date(),
	});
	w.planner.hold(false);
	let restarted = await w.restart();
	await Chat.recover(restarted);
	await Chat.recover(restarted);
	await tick();

	expect((await w.rows())[0]).toMatchObject({ state: "interrupted" });
	let notices = restarted.chat.entries.filter(entry => entry.id === `interrupted:${row!.id}`);
	expect(notices).toHaveLength(1);
	expect(notices[0]!.text).toContain("was not run again");
	expect(w.prompts).toHaveLength(1);
});

test("with no owner, nothing starts until the login of someone who asked is live, and an earlier request starts first under the writer who comes back", async () => {
	let w = await world();
	w.planner.hold();
	await w.send("running");
	await waitFor(() => w.planner.running === 1);
	await w.send("early");
	// The process restarts, and nobody who was signed in is any more; no owner remains.
	let [agent] = [(await w.storage.channels.readAgent(w.channel.id, new Date()))!.agent!];
	await w.storage.channels.clearAgentOwner(
		w.channel.id,
		agent.ownerSessionId!,
		agent.generation,
		new Date(),
	);
	w.planner.hold(false);
	let restarted = await w.restart(false);
	await Chat.recover(restarted);
	await tick();
	expect(w.prompts).toHaveLength(1);
	expect((await w.storage.channels.readAgent(w.channel.id, new Date()))!.agent?.ownerSessionId)
		.toBeUndefined();
	expect(await w.rows(["waiting"])).toHaveLength(1);

	// Another writer asks: theirs joins the queue behind the earlier request, which starts first.
	let answer = await w.send("late", "bob");
	expect(answer).toMatchObject({ queued: true });
	await w.turns(3);
	let given = w.prompts.slice(1);
	expect(given[0]).toContain("early");
	expect(given[1]).toContain("late");
	let owner = (await w.storage.channels.readAgent(w.channel.id, new Date()))!.agent!.ownerSessionId;
	expect(owner).toBe(w.logins.bob.id);
});

test("when the machine is away a person's message is accepted and saved as sent, never refused, and goes through once, in order, when it is back", async () => {
	let w = await world({ away: true });
	let refusals = spyOn(console, "error").mockImplementation(() => {});
	let first = await w.send("while you were out");
	let second = await w.send("and another");
	expect(first).toMatchObject({ kind: "chat:send", queued: true });
	expect(second).toMatchObject({ kind: "chat:send", queued: true });
	expect(w.prompts).toEqual([]);
	expect(memberEntry(w.context, "while you were out")?.deliveryState).toBe("sent");
	expect((await w.rows(["waiting"])).map(row => row.text)).toEqual([
		"while you were out",
		"and another",
	]);

	await w.attach();
	await w.turns(2);
	expect(w.prompts[0]).toContain("while you were out");
	expect(w.prompts[1]).toContain("and another");
	expect(memberEntry(w.context, "while you were out")?.deliveryState).toBe("delivered");
	expect((await w.rows()).map(row => row.state)).toEqual(["ended", "ended"]);
	// A second return finds nothing to send again.
	await w.attach();
	await tick();
	expect(w.prompts).toHaveLength(2);
	refusals.mockRestore();
});

test("the sender can delete a message the machine has not taken; it leaves the Chat for everyone and is never sent", async () => {
	let w = await world({ away: true });
	let kept = await w.send("keep this");
	let dropped = await w.send("drop this");
	let sender = w.socket();
	let rid = "delete-1";
	await Chat.remove(
		w.context,
		sender.ws,
		{ kind: "chat:delete", rid, id: dropped.id as string } as never,
	);
	expect(sender.frames.find(frame => frame.rid === rid)).toMatchObject({
		kind: "chat:delete",
		id: dropped.id,
	});
	expect(w.events.some(event => event.kind === "chat:removed" && event.id === dropped.id)).toBe(
		true,
	);
	expect(memberEntry(w.context, "drop this")).toBeUndefined();
	expect(w.context.chat.waiting.map(item => item.id)).toEqual([kept.id as string]);
	let cancelled = (await w.rows()).find(row => row.requestId === dropped.id);
	expect(cancelled?.state).toBe("cancelled");
	// Deleting again leaves it deleted.
	await Chat.remove(
		w.context,
		sender.ws,
		{ kind: "chat:delete", rid: "again", id: dropped.id as string } as never,
	);
	expect(sender.frames.find(frame => frame.rid === "again")?.kind).toBe("chat:delete");

	// Someone else's message cannot be deleted.
	let other = w.socket("bob");
	await Chat.remove(
		w.context,
		other.ws,
		{ kind: "chat:delete", rid: "bob", id: kept.id as string } as never,
	);
	expect(other.frames.find(frame => frame.rid === "bob")?.kind).toBe("session:error");

	await w.attach();
	await w.turns(1);
	expect(w.prompts).toHaveLength(1);
	expect(w.prompts[0]).toContain("keep this");
	expect(w.prompts.join("\n")).not.toContain("drop this");

	// One the machine took cannot be deleted.
	let taken = w.socket();
	await Chat.remove(
		w.context,
		taken.ws,
		{ kind: "chat:delete", rid: "late", id: kept.id as string } as never,
	);
	expect(taken.frames.find(frame => frame.rid === "late")?.kind).toBe("session:error");
	expect(memberEntry(w.context, "keep this")?.deliveryState).toBe("delivered");
});

test("a message that can never be delivered is marked failed with its reason, can be sent again, and then goes through once", async () => {
	let w = await world({ away: true });
	let sent = await w.send("write access will go");
	w.writable = false;
	await w.attach();
	await tick();
	await waitFor(() => memberEntry(w.context, "write access will go")?.deliveryState === "failed");
	let entry = memberEntry(w.context, "write access will go")!;
	expect(entry.deliveryFailure).toBe("access-lost");
	expect(w.prompts).toEqual([]);
	expect((await w.rows())[0]!.state).toBe("cancelled");
	expect(w.context.chat.waiting).toEqual([]);

	// Someone else's cannot retry it; its author can, once they can write again.
	let other = w.socket("bob");
	await Chat.retry(
		w.context,
		other.ws,
		{ kind: "chat:retry", rid: "no", id: sent.id as string } as never,
	);
	expect(other.frames.find(frame => frame.rid === "no")?.kind).toBe("session:error");
	w.writable = true;
	let author = w.socket();
	await Chat.retry(
		w.context,
		author.ws,
		{ kind: "chat:retry", rid: "yes", id: sent.id as string } as never,
	);
	expect(author.frames.find(frame => frame.rid === "yes")).toMatchObject({ kind: "chat:retry" });
	await w.turns(1);
	expect(w.prompts).toHaveLength(1);
	expect(memberEntry(w.context, "write access will go")).toMatchObject({
		deliveryState: "delivered",
	});
	expect(memberEntry(w.context, "write access will go")!.deliveryFailure).toBeUndefined();
	// A message that is not failed cannot be sent again.
	await Chat.retry(
		w.context,
		author.ws,
		{ kind: "chat:retry", rid: "twice", id: sent.id as string } as never,
	);
	expect(author.frames.find(frame => frame.rid === "twice")?.kind).toBe("session:error");
});

test("a request whose child document is gone when it starts ends as failed rather than answering in the wrong document", async () => {
	let w = await world({ away: true });
	let child = crypto.randomUUID();
	let context = w.context;
	let present = true;
	context.children = {
		list: async () => [],
		resolve: async id =>
			present && id === child ? { id, title: "Child", createdAt: "" } : undefined,
		open: async () => {
			throw new Error("not used");
		},
	};
	await w.send("about the child", "ana", { focus: child });
	expect((await w.rows())[0]).toMatchObject({ focusChannelId: child, state: "waiting" });
	present = false;
	await w.attach();
	await waitFor(() => memberEntry(context, "about the child")?.deliveryState === "failed");
	expect(memberEntry(context, "about the child")!.deliveryFailure).toBe("document-unavailable");
	expect((await w.rows())[0]!.state).toBe("cancelled");
	expect(w.prompts).toEqual([]);
});

test("a message an MCP caller invokes, an automatic follow-up, and a task draft are each kept as a row when the machine is away, and start once it is back", async () => {
	let w = await world({ away: true });
	let user = { id: w.ana.id, login: "ana" };
	let settled = 0;
	expect(
		await Chat.invoke(
			w.context,
			user,
			"invoked by an agent",
			undefined,
			undefined,
			() => settled++,
		),
	).toBeUndefined();
	expect(
		await Chat.invoke(
			w.context,
			user,
			"follow up quietly",
			undefined,
			undefined,
			undefined,
			"Automatic follow-up requested by @ana.",
		),
	).toBeUndefined();
	let draft = await Chat.draftTasks(w.context, "ana", 3, "draft the tasks", "ana asked for tasks");
	expect(draft).toMatchObject({ ok: true, state: "queued", existing: false });
	// Pressing Build again returns the draft that waits.
	let second = await Chat.draftTasks(w.context, "ana", 3, "draft the tasks", "ana asked again");
	expect(second).toMatchObject({ ok: true, existing: true, state: "queued" });

	let rows = await w.rows(["waiting"]);
	expect(rows.map(row => row.kind)).toEqual(["invoke_planner", "invoke_system", "draft"]);
	expect(rows[1]!.requestId).toBe(
		w.context.chat.entries.find(entry => entry.text === "Automatic follow-up requested by @ana.")!
			.id,
	);
	expect(rows[2]).toMatchObject({ requestId: draft.ok ? draft.draft.id : "", planRevision: 3 });
	expect(memberEntry(w.context, "invoked by an agent")?.deliveryState).toBe("sent");
	expect(
		w.events.some(event => event.kind === "implementation:drafting" && event.state === "queued"),
	)
		.toBe(true);
	expect(w.prompts).toEqual([]);

	await w.attach();
	await w.turns(3);
	expect(
		w.prompts.map(prompt =>
			["invoked", "follow up", "draft the"].findIndex(part => prompt.includes(part))
		),
	)
		.toEqual([0, 1, 2]);
	expect((await w.rows()).map(row => row.state)).toEqual(["ended", "ended", "ended"]);
	expect(
		w.events.some(event => event.kind === "implementation:drafting" && event.state === "ended"),
	)
		.toBe(true);
	expect(settled).toBe(1);
});

test("a task draft that waited through a restart is the live draft again, still queued, and runs once", async () => {
	let w = await world({ away: true });
	await Chat.draftTasks(w.context, "ana", 7, "draft the tasks", "ana asked for tasks");
	let restarted = await w.restart();
	expect(restarted.chat.draft).toBeUndefined();
	await Chat.recover(restarted);
	expect(restarted.chat.draft).toMatchObject({ planRevision: 7, state: "queued" });
	let again = await Chat.draftTasks(
		restarted,
		"bob",
		7,
		"draft the tasks",
		"bob asked too",
		w.bob.id,
	);
	expect(again).toMatchObject({ ok: true, existing: true, state: "queued" });
	expect(await w.rows()).toHaveLength(1);

	await w.attach();
	await w.turns(1);
	expect(w.prompts).toHaveLength(1);
	expect(restarted.chat.draft).toBeUndefined();
});

test("a comment note and an automatic follow-up wait as rows, a note folds into its thread's waiting row, and a resolved thread cancels its row without a word", async () => {
	let w = await world({ away: true });
	let resolved = false;
	let outcomes: string[] = [];
	let note = (text: string) =>
		Chat.instruct(w.context, "ana", text, "Comment on “a passage” sent to Chopin", {
			thread: "thread-1",
			spent: () => resolved,
			ended: outcome => {
				outcomes.push(outcome.status);
			},
			defer: { kind: "comment", userId: w.ana.id },
		});
	await note("the thread as it first read");
	await note("the thread with a newer note");
	// One waiting row for the thread, and the newer note replaces the prompt.
	let rows = await w.rows(["waiting"]);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ kind: "comment", threadId: "thread-1", text: "" });
	expect(w.context.chat.waiting.map(item => item.text)).toEqual(["the thread with a newer note"]);
	expect(Chat.workingFor(w.context.chat, "thread-1")).toBe(true);

	resolved = true;
	let before = w.context.chat.entries.length;
	await w.attach();
	await waitFor(async () => (await w.rows())[0]!.state === "cancelled");
	expect(outcomes).toEqual(["skipped"]);
	expect(w.prompts).toEqual([]);
	// Resolving is what members see; nothing is added to the Chat.
	expect(w.context.chat.entries.length).toBe(before);
	expect(Chat.workingFor(w.context.chat, "thread-1")).toBe(false);
});

test("a comment note that waited through a restart is built again from its thread by the hook, and one whose thread is gone ends quietly", async () => {
	let w = await world({ away: true });
	await Chat.instruct(w.context, "ana", "the first prompt", "Comment on “x” sent to Chopin", {
		thread: "thread-1",
		defer: { kind: "comment", userId: w.ana.id },
	});
	await Chat.instruct(w.context, "ana", "another", "Comment on “y” sent to Chopin", {
		thread: "thread-gone",
		defer: { kind: "comment", userId: w.ana.id },
	});
	let restarted = await w.restart();
	let built: string[] = [];
	restarted.deferred!.restoreComment = async row => {
		built.push(row.threadId!);
		return row.threadId === "thread-1"
			? {
				id: "ignored",
				handle: row.handle,
				text: "the thread as it reads now",
				thread: "thread-1",
			}
			: undefined;
	};
	await Chat.recover(restarted);
	expect(built.toSorted()).toEqual(["thread-1", "thread-gone"]);
	expect(restarted.chat.waiting.map(item => item.text)).toEqual(["the thread as it reads now"]);
	expect((await w.rows()).map(row => row.state)).toEqual(["waiting", "cancelled"]);
	await w.attach();
	await w.turns(1);
	expect(w.prompts[0]).toContain("the thread as it reads now");
	expect((await w.rows()).map(row => row.state)).toEqual(["ended", "cancelled"]);
});

test("a turn cut off at the restart's turn wait ends its row as interrupted, with the notice, and is not run again", async () => {
	let w = await world();
	let replies = spyOn(console, "error").mockImplementation(() => {});
	w.planner.hold();
	await w.send("first");
	await waitFor(() => w.planner.running === 1);
	await w.send("second");
	w.planner.release();
	await waitFor(() => w.planner.running === 1 && w.prompts.length === 2);
	let [row] = await w.rows();
	expect(row!.state).toBe("started");

	Chat.holdStarts();
	Chat.interrupt(w.context.chat, "A restart interrupted this reply, and it was not run again.");
	await Chat.settled(w.context.chat);
	expect((await w.rows())[0]).toMatchObject({ state: "interrupted" });
	expect(w.texts()).toContain("A restart interrupted this reply, and it was not run again.");
	expect(w.prompts).toHaveLength(2);

	// The next process finds nothing left to run.
	Chat.holdStarts(false);
	let restarted = await w.restart();
	await Chat.recover(restarted);
	await tick();
	expect(w.prompts).toHaveLength(2);
	expect((await w.rows())[0]!.state).toBe("interrupted");
	replies.mockRestore();
});

test("a request that cannot start says once, after the notice delay, what it waits for, and says nothing when it starts in time", async () => {
	let w = await world({ away: true, noticeDelayMs: 25 });
	await w.send("is anyone there");
	await waitFor(() =>
		w.texts().some(text => text?.startsWith("Waiting for this document's machine"))
	);
	await tick();
	expect(w.texts().filter(text => text?.startsWith("Waiting for")).length).toBe(1);
	expect(w.texts().join("\n")).not.toMatch(/Planner|attach|detach|held|@chopin/i);

	let quick = await world({ away: true, noticeDelayMs: 200 });
	await quick.send("back soon");
	await quick.attach();
	await quick.turns(1);
	await Bun.sleep(260);
	expect(quick.texts().some(text => text?.startsWith("Waiting for"))).toBe(false);
});

test("a message is not acknowledged when its row cannot be saved, and leaves nothing in the transcript", async () => {
	let w = await world({ away: true });
	let context = w.context;
	let persist = context.persist;
	context.persist = async (chat, deferred) => {
		if (deferred?.length) throw new Error("storage is down");
		return persist(chat, deferred);
	};
	let answer = await w.send("lost?");
	expect(answer.kind).toBe("session:error");
	expect(memberEntry(context, "lost?")).toBeUndefined();
	expect(context.chat.waiting).toEqual([]);
	expect(await w.rows()).toEqual([]);
});

test("a row cancelled behind the queue's back is not started and the refusal is logged, never silently ignored", async () => {
	let w = await world({ away: true });
	let logged = spyOn(console, "error").mockImplementation(() => {});
	await w.send("withdrawn elsewhere");
	let [row] = await w.rows(["waiting"]);
	await w.storage.deferredTurns.transition(w.lease, {
		id: row!.id,
		from: "waiting",
		to: "cancelled",
		at: new Date(),
	});
	await w.attach();
	await tick();
	expect(w.prompts).toEqual([]);
	expect(logged.mock.calls.some(call => String(call[0]).includes("not moved"))).toBe(true);
	expect((await w.rows())[0]!.state).toBe("cancelled");
	logged.mockRestore();
});

test("every line a saved request writes into Chat is in plain words", () => {
	expectPlainStatus(WAITING_NOTICE_REMOTE, "the notice that waits for the machine");
	expectPlain(WAITING_NOTICE, "the notice that waits for a sender");
	for (let kind of ["composer", "invoke_planner", "invoke_system", "comment", "draft"] as const) {
		let row = { kind, handle: "ana" };
		expectPlain(interruptedNotice(row), `the ${kind} request a restart stopped`);
		for (let why of ["agent", "unavailable", "access"] as const) {
			expectPlain(cancelledNotice(row, why), `the ${kind} request cancelled for ${why}`);
		}
	}
});
