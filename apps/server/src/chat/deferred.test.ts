/**
 * Planner requests that were acknowledged and have not started, kept as rows: written before the
 * acknowledgement, started once and in order under the start rule, and never lost by a restart.
 */
import { afterEach, expect, spyOn, test } from "bun:test";

import { configured, LOCAL } from "../testing/config";
import { expectPlain } from "../testing/plain-words";
import { cancelledNotice, interruptedNotice, keepsRequests } from "./deferred";
import * as Chat from "./service";
import { cleanups, memberEntry, tick, waitFor, world } from "./deferred.test-fixtures";
import { JOB } from "./job.test-fixtures";

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
	// The one that was running was a row too, from its acceptance.
	expect((await w.rows()).map(value => value.state)).toEqual(["ended", "ended"]);
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
	expect(await w.rows()).toHaveLength(2);

	// The same request with other words is a different request, not a retry.
	let other = await w.send("something else", "ana", { requestId });
	expect(other.kind).toBe("session:error");
	expect(await w.rows()).toHaveLength(2);

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

	// The process ends mid-turn: the running turn's row is left started, the other two wait.
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
	// The turn that was running finished, as did the two that waited, each once.
	expect((await w.rows()).map(row => row.state)).toEqual(["ended", "ended", "ended"]);
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

	expect((await w.rows()).find(value => value.id === row!.id)).toMatchObject({
		state: "interrupted",
	});
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

test("a message the machine cannot open a session for stays sent and waiting, never marked delivered, and goes through once, in order, when the machine is next available", async () => {
	let w = await world({ away: true });
	let log = spyOn(console, "error").mockImplementation(() => {});
	await w.send("first");
	await w.send("second");
	w.planner.failOpens(1);
	await w.attach();
	await waitFor(() => w.planner.opens === 1);
	await tick();
	await tick();
	expect(w.prompts).toEqual([]);
	expect(memberEntry(w.context, "first")?.deliveryState).toBe("sent");
	expect(memberEntry(w.context, "second")?.deliveryState).toBe("sent");
	expect((await w.rows()).map(row => row.state)).toEqual(["waiting", "waiting"]);
	// Still in order at the head of the queue, and no failure notice for what will be retried.
	expect(w.context.chat.waiting.map(item => item.text)).toEqual(["first", "second"]);
	expect(w.context.chat.entries.filter(entry => entry.author.kind === "system")).toEqual([]);
	// It is not tried again until something says the machine may be there.
	await new Promise(resolve => setTimeout(resolve, 60));
	expect(w.planner.opens).toBe(1);

	await w.attach();
	await w.turns(2);
	expect(w.prompts[0]).toContain("first");
	expect(w.prompts[1]).toContain("second");
	expect(w.prompts).toHaveLength(2);
	expect(memberEntry(w.context, "first")?.deliveryState).toBe("delivered");
	expect((await w.rows()).map(row => row.state)).toEqual(["ended", "ended"]);
	await w.attach();
	await tick();
	expect(w.prompts).toHaveLength(2);
	log.mockRestore();
});

test("a message sent while the machine is there is marked sent, and delivered only once its prompt is on its way", async () => {
	let w = await world({ away: false });
	let log = spyOn(console, "error").mockImplementation(() => {});
	w.planner.failOpens(1);
	await w.send("it fails to open");
	await waitFor(() => w.planner.opens === 1);
	await waitFor(() => !w.context.chat.busy);
	expect(w.prompts).toEqual([]);
	// The prompt never went anywhere, so the mark does not say it did, and it is not lost: its row
	// waits, with no failure said in the Chat.
	expect(memberEntry(w.context, "it fails to open")?.deliveryState).toBe("sent");
	expect((await w.rows()).map(row => row.state)).toEqual(["waiting"]);
	expect(w.context.chat.entries.filter(entry => entry.author.kind === "system")).toEqual([]);

	// The next request says the machine may be there, and the earlier message goes first, once.
	await w.send("it opens");
	await w.turns(2);
	expect(w.prompts[0]).toContain("it fails to open");
	expect(w.prompts[1]).toContain("it opens");
	expect(w.prompts).toHaveLength(2);
	expect(memberEntry(w.context, "it fails to open")?.deliveryState).toBe("delivered");
	expect(memberEntry(w.context, "it opens")?.deliveryState).toBe("delivered");
	expect((await w.rows()).map(row => row.state)).toEqual(["ended", "ended"]);
	log.mockRestore();
});

test("a message to a machine that is there, sent as the process stops before its turn starts, is not lost, and starts once in the next process", async () => {
	let w = await world({ away: false });
	Chat.holdStarts();
	let answer = await w.send("just before the stop");
	expect(answer).toMatchObject({ kind: "chat:send", queued: true });
	await tick();
	expect(w.prompts).toEqual([]);
	expect(memberEntry(w.context, "just before the stop")?.deliveryState).toBe("sent");
	expect((await w.rows(["waiting"])).map(row => row.text)).toEqual(["just before the stop"]);

	Chat.holdStarts(false);
	let restarted = await w.restart();
	await Chat.recover(restarted);
	await w.turns(1);
	await Chat.recover(restarted);
	await tick();
	expect(w.prompts).toHaveLength(1);
	expect(w.prompts[0]).toContain("just before the stop");
	expect(memberEntry(restarted, "just before the stop")?.deliveryState).toBe("delivered");
	expect((await w.rows()).map(row => row.state)).toEqual(["ended"]);
});

test("a message being saved when the process begins to stop is saved and acknowledged, never refused as closed, and starts once in the next process", async () => {
	let w = await world({ away: true });
	let release = w.slowCheck();
	let sent = w.send("as it stops");
	await tick();
	// The cut has begun and the document closes while the message is still being accepted.
	Chat.holdStarts();
	let closing = Chat.close(w.context.chat);
	release();
	let answer = await sent;
	await closing;
	expect(answer).toMatchObject({ kind: "chat:send", queued: true });
	expect((await w.rows(["waiting"])).map(row => row.text)).toEqual(["as it stops"]);

	Chat.holdStarts(false);
	let restarted = await w.restart();
	await Chat.recover(restarted);
	await w.attach();
	await w.turns(1);
	expect(w.prompts).toHaveLength(1);
	expect(w.prompts[0]).toContain("as it stops");
	expect((await w.rows()).map(row => row.state)).toEqual(["ended"]);
});

test("a message that reaches a Chat closed by a stopping process gets no answer, not a refusal, so its browser sends it again to the next process, which keeps it once", async () => {
	let w = await world({ away: true });
	Chat.holdStarts();
	await Chat.close(w.context.chat);
	let requestId = crypto.randomUUID();
	let sender = w.socket();
	await Chat.send(
		{ ...w.context, claimantSessionId: w.logins.ana.id },
		sender.ws,
		{ kind: "chat:send", rid: "r1", requestId, to: "planner", text: "too late", ts: 0 } as never,
	);
	expect(sender.frames).toEqual([]);
	expect(await w.rows()).toEqual([]);

	Chat.holdStarts(false);
	await w.restart();
	// What the browser does once it is connected again: the same request, once more.
	let again = await w.send("too late", "ana", { requestId });
	expect(again).toMatchObject({ kind: "chat:send", queued: true });
	expect((await w.rows(["waiting"])).map(row => row.requestId)).toEqual([requestId]);
});

test("an MCP call and a task draft being saved when the process begins to stop are each saved as a row and answered, none refused as closed", async () => {
	let w = await world({ away: true });
	let user = { id: w.ana.id, login: "ana" };
	let release = w.slowCheck();
	let invoked = Chat.invoke(w.context, user, "an agent's request");
	let drafted = Chat.draftTasks(w.context, "ana", 3, "draft the tasks", "ana asked for tasks");
	await tick();
	Chat.holdStarts();
	let closing = Chat.close(w.context.chat);
	release();
	expect(await invoked).toBeUndefined();
	expect(await drafted).toMatchObject({ ok: true, state: "queued" });
	await closing;
	expect((await w.rows(["waiting"])).map(row => row.kind).sort()).toEqual([
		"draft",
		"invoke_planner",
	]);
});

test("a machine that is away keeps every message a person sends however many wait, each saved and marked sent, never refused as a full queue, and delivers each once, in order, when it is back", async () => {
	let w = await world({ away: true });
	let total = 130;
	let said = (number: number) => `message ${number} of ${total}`;
	for (let number = 1; number <= total; number++) {
		expect(await w.send(said(number))).toMatchObject({ kind: "chat:send", queued: true });
	}
	expect((await w.rows(["waiting"])).map(row => row.text)).toEqual(
		Array.from({ length: total }, (_, index) => said(index + 1)),
	);
	expect(memberEntry(w.context, said(total))?.deliveryState).toBe("sent");
	// Saying nothing in the Chat about it: the message's own mark is the only sign.
	expect(w.context.chat.entries.filter(entry => entry.author.kind !== "member")).toEqual([]);

	await w.attach();
	await w.turns(total);
	expect(w.prompts).toHaveLength(total);
	w.prompts.forEach((prompt, index) => expect(prompt).toContain(said(index + 1)));
	expect((await w.rows()).every(row => row.state === "ended")).toBe(true);
	await w.attach();
	await tick();
	expect(w.prompts).toHaveLength(total);
});

test("whatever is waiting for a machine that is away, an MCP call, an automatic follow-up, a comment note and a task draft are each kept, never refused as a full queue", async () => {
	let w = await world({ away: true });
	for (let number = 1; number <= 120; number++) await w.send(`message ${number}`);
	let user = { id: w.ana.id, login: "ana" };
	expect(await Chat.invoke(w.context, user, "invoked by an agent")).toBeUndefined();
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
	expect(Chat.admission(w.context, "thread-1", undefined, true)).toBe("queued");
	await Chat.instruct(
		w.context,
		"ana",
		"a note on the thread",
		"Comment on “a passage” sent to Chopin",
		{
			thread: "thread-1",
			defer: { kind: "comment", userId: w.ana.id },
		},
	);
	expect(await Chat.draftTasks(w.context, "ana", 3, "draft the tasks", "ana asked for tasks"))
		.toMatchObject({ ok: true, state: "queued", existing: false });
	expect((await w.rows(["waiting"])).map(row => row.kind).slice(120)).toEqual([
		"invoke_planner",
		"invoke_system",
		"comment",
		"draft",
	]);
});

test("a background job that arrives while a saved request is being started waits behind the saved requests, so turns never overlap and they start in order", async () => {
	let w = await world({ away: true });
	w.planner.hold();
	await w.send("first");
	await w.send("second");
	// The job arrives in the middle of the first request's start, as one woken by the machine's
	// return does.
	let job: Promise<unknown> | undefined;
	let persist = w.context.persist;
	w.context.persist = (...args) => {
		job ??= Chat.job(w.context, JOB, "the job's prompt", undefined);
		return persist(...args);
	};
	await w.attach();
	await waitFor(() => w.prompts.length >= 1);
	await new Promise(resolve => setTimeout(resolve, 100));
	expect(w.prompts).toHaveLength(1);
	expect(w.prompts[0]).toContain("first");
	expect(w.planner.running).toBe(1);

	w.context.persist = persist;
	w.planner.hold(false);
	w.planner.release();
	await w.turns(3);
	await job;
	expect(w.prompts[1]).toContain("second");
	expect(w.prompts[2]).toContain("the job's prompt");
	expect(w.context.chat.busy).toBe(false);
});

test("a background job waiting in the queue takes no place from a person's messages: twenty still fit, and the twenty-first is the one refused", async () => {
	let w = await world({ away: false });
	w.planner.hold();
	await w.send("first");
	await waitFor(() => w.planner.running === 1);
	let job = Chat.job(w.context, JOB, "the job's prompt", undefined);
	expect(w.context.chat.waiting.some(item => item.job)).toBe(true);
	for (let number = 1; number <= 20; number++) {
		expect(await w.send(`message ${number}`)).toMatchObject({ kind: "chat:send", queued: true });
	}
	// Refused as a full queue the sender's browser tries again, not as a message that cannot be sent.
	expect(await w.send("one too many")).toMatchObject({
		kind: "session:error",
		code: "planner-queue-full",
	});
	w.planner.hold(false);
	for (let turn = 0; turn < 22; turn++) w.planner.release();
	await w.turns(22);
	await job;
});

test("a message sent while its machine is still starting its Planner is acknowledged at once, not after the wait, and starts when the Planner arrives", async () => {
	let arrives = Promise.withResolvers<void>();
	let w = await world({ away: true, starting: arrives.promise });
	let answer = await w.send("while it starts");
	expect(answer).toMatchObject({ kind: "chat:send", queued: true });
	expect(memberEntry(w.context, "while it starts")?.deliveryState).toBe("sent");
	expect(w.prompts).toEqual([]);
	arrives.resolve();
	await w.attach();
	await w.turns(1);
	expect(w.prompts).toHaveLength(1);
	expect(memberEntry(w.context, "while it starts")?.deliveryState).toBe("delivered");
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
	// The server's last word: it can never be taken back by this person, so the browser stops asking.
	expect(other.frames.find(frame => frame.rid === "bob")).toMatchObject({
		kind: "session:error",
		code: "message-not-deletable",
	});

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
	expect(taken.frames.find(frame => frame.rid === "late")).toMatchObject({
		kind: "session:error",
		code: "message-not-deletable",
	});
	expect(memberEntry(w.context, "keep this")?.deliveryState).toBe("delivered");
});

test("a delete that reaches the next process after a restart takes the message back: the row it was saved under is cancelled and the machine never gets it, however the page was reloaded meanwhile", async () => {
	let w = await world({ away: true });
	let wanted = await w.send("changed my mind after the restart");
	let kept = await w.send("keep this one");
	let restarted = await w.restart();
	// What a tab's reconnect does before it asks for anything: the saved requests rejoin the queue.
	await Chat.recover(restarted);
	expect(restarted.chat.waiting.map(item => item.id)).toEqual([
		wanted.id as string,
		kept.id as string,
	]);

	let sender = w.socket();
	await Chat.remove(
		restarted,
		sender.ws,
		{ kind: "chat:delete", rid: "after", id: wanted.id as string } as never,
	);
	expect(sender.frames.find(frame => frame.rid === "after")?.kind).toBe("chat:delete");
	expect(memberEntry(restarted, "changed my mind after the restart")).toBeUndefined();
	expect((await w.rows()).find(row => row.requestId === wanted.id)?.state).toBe("cancelled");
	// Asked again, as a page that did not hear the answer does, it is still taken back.
	await Chat.remove(
		restarted,
		sender.ws,
		{ kind: "chat:delete", rid: "twice", id: wanted.id as string } as never,
	);
	expect(sender.frames.find(frame => frame.rid === "twice")?.kind).toBe("chat:delete");

	await w.attach();
	await w.turns(1);
	await tick();
	expect(w.prompts).toHaveLength(1);
	expect(w.prompts[0]).toContain("keep this one");
	expect(w.prompts.join("\n")).not.toContain("changed my mind");
});

test("a delete the server could not carry out for a passing reason is not its last word: the message stays, waiting, and a delete asked again takes it back", async () => {
	let w = await world({ away: true });
	let wanted = await w.send("changed my mind");
	let sender = w.socket();
	// Storage fails as the delete is being saved: the person is told it did not happen, no more.
	await Chat.remove(
		{ ...w.context, persist: () => Promise.reject(new Error("storage is busy")) },
		sender.ws,
		{ kind: "chat:delete", rid: "busy", id: wanted.id as string } as never,
	);
	let refusal = sender.frames.find(frame => frame.rid === "busy");
	expect(refusal?.kind).toBe("session:error");
	expect(refusal?.code).toBeUndefined();
	expect(memberEntry(w.context, "changed my mind")?.deliveryState).toBe("sent");
	expect(w.context.chat.waiting.map(item => item.id)).toEqual([wanted.id as string]);

	await Chat.remove(
		w.context,
		sender.ws,
		{ kind: "chat:delete", rid: "again", id: wanted.id as string } as never,
	);
	expect(sender.frames.find(frame => frame.rid === "again")?.kind).toBe("chat:delete");
	await w.attach();
	await tick();
	expect(w.prompts).toEqual([]);
});

test("a delete that arrives as the machine is taking the message is not final either: if the start falls through the message waits again, and the delete asked again takes it back", async () => {
	let w = await world({ away: true });
	let wanted = await w.send("taken just now");
	let sender = w.socket();
	// Out of the queue while its turn is being opened, as it is for a moment before it is delivered.
	let item = w.context.chat.waiting.splice(0);
	await Chat.remove(
		w.context,
		sender.ws,
		{ kind: "chat:delete", rid: "mid", id: wanted.id as string } as never,
	);
	let refusal = sender.frames.find(frame => frame.rid === "mid");
	expect(refusal?.kind).toBe("session:error");
	expect(refusal?.code).toBeUndefined();
	w.context.chat.waiting.push(...item);
	await Chat.remove(
		w.context,
		sender.ws,
		{ kind: "chat:delete", rid: "later", id: wanted.id as string } as never,
	);
	expect(sender.frames.find(frame => frame.rid === "later")?.kind).toBe("chat:delete");
	expect(memberEntry(w.context, "taken just now")).toBeUndefined();
});

test("a message the server kept but answered as a passing trouble, because the commit's acknowledgement was lost, is taken back by its request id: its row is cancelled, a late send of it is refused as deleted, and the machine never gets it", async () => {
	let logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		let w = await world({ away: true });
		let persist = w.context.persist;
		let lost = true;
		w.context.persist = async (...args) => {
			let saved = await persist(...args);
			if (lost) {
				lost = false;
				throw new Error("the commit's acknowledgement was lost");
			}
			return saved;
		};
		let requestId = crypto.randomUUID();
		expect(await w.send("taken back", "ana", { requestId })).toMatchObject({
			kind: "session:error",
			code: "temporarily-unavailable",
		});
		// The row is committed though the sender was told it could not be kept.
		expect((await w.rows(["waiting"])).map(row => row.requestId)).toEqual([requestId]);

		let sender = w.socket();
		await Chat.remove(
			w.context,
			sender.ws,
			{ kind: "chat:delete", rid: "delete", id: requestId } as never,
		);
		expect(sender.frames.find(frame => frame.rid === "delete")).toMatchObject({
			kind: "chat:delete",
			id: requestId,
		});
		expect((await w.rows()).map(row => [row.requestId, row.state])).toEqual([
			[requestId, "cancelled"],
		]);
		// Deleting again leaves it deleted, and a send that was still on its way cannot bring it back.
		await Chat.remove(
			w.context,
			sender.ws,
			{ kind: "chat:delete", rid: "again", id: requestId } as never,
		);
		expect(sender.frames.find(frame => frame.rid === "again")?.kind).toBe("chat:delete");
		let late = await w.send("taken back", "ana", { requestId });
		expect(late).toMatchObject({ kind: "session:error", message: "this message was deleted" });
		expect(late.code).toBeUndefined();

		await w.attach();
		await tick();
		expect(w.prompts).toEqual([]);
		expect((await w.rows()).map(row => row.state)).toEqual(["cancelled"]);
	} finally {
		logged.mockRestore();
	}
});

test("a delete that arrives before the send it takes back keeps the message gone: the late send is refused and nothing of it is kept or delivered", async () => {
	let w = await world({ away: true });
	let requestId = crypto.randomUUID();
	let sender = w.socket();
	await Chat.remove(
		w.context,
		sender.ws,
		{ kind: "chat:delete", rid: "early", id: requestId } as never,
	);
	// Nothing to delete is not a failure: the send was lost, and taking it back is done.
	expect(sender.frames.find(frame => frame.rid === "early")?.kind).toBe("chat:delete");

	let late = await w.send("too late", "ana", { requestId });
	expect(late).toMatchObject({ kind: "session:error" });
	expect(memberEntry(w.context, "too late")).toBeUndefined();
	expect(await w.rows()).toEqual([]);
	// Other messages are not affected.
	expect(await w.send("a different one")).toMatchObject({ kind: "chat:send", queued: true });
	await w.attach();
	await w.turns(1);
	expect(w.prompts).toHaveLength(1);
	expect(w.prompts[0]).toContain("a different one");
});

test("a delete sent right behind its send takes the message back even while the send is still being saved", async () => {
	let w = await world({ away: true });
	let requestId = crypto.randomUUID();
	let sender = w.socket();
	// Both are on the wire before the first has been answered, as when a person deletes at once.
	let sending = w.send("quick change of mind", "ana", { requestId });
	let removing = Chat.remove(
		w.context,
		sender.ws,
		{ kind: "chat:delete", rid: "quick", id: requestId } as never,
	);
	await Promise.all([sending, removing]);
	expect(sender.frames.find(frame => frame.rid === "quick")?.kind).toBe("chat:delete");
	expect(memberEntry(w.context, "quick change of mind")).toBeUndefined();
	expect((await w.rows()).map(row => row.state)).toEqual(["cancelled"]);
	await w.attach();
	await tick();
	expect(w.prompts).toEqual([]);
});

test("deleting a message that sits ahead of the running turn's first entry moves the turn's start up with it, so the turn still begins at its own first entry", async () => {
	let w = await world({ away: true });
	w.planner.hold();
	await w.send("one");
	let dropped = await w.send("two");
	await w.attach();
	await waitFor(() => w.planner.running === 1);
	let turn = w.context.chat.turn!;
	let before = turn.entryOffset;
	expect(w.context.chat.entries.findIndex(entry => entry.id === dropped.id)).toBeLessThan(before);

	let sender = w.socket();
	await Chat.remove(
		w.context,
		sender.ws,
		{ kind: "chat:delete", rid: "ahead", id: dropped.id as string } as never,
	);
	expect(sender.frames.find(frame => frame.rid === "ahead")?.kind).toBe("chat:delete");
	expect(w.context.chat.turn!.entryOffset).toBe(before - 1);
	expect(w.context.chat.entries.slice(w.context.chat.turn!.entryOffset)).toEqual([]);
	w.planner.hold(false);
	w.planner.release();
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
	// The first turn has ended; the second one's row is the one under way.
	let [, row] = await w.rows();
	expect(row!.state).toBe("started");

	Chat.holdStarts();
	Chat.interrupt(w.context.chat, "A restart interrupted this reply, and it was not run again.");
	await Chat.settled(w.context.chat);
	expect((await w.rows())[1]).toMatchObject({ state: "interrupted" });
	expect(w.texts()).toContain("A restart interrupted this reply, and it was not run again.");
	expect(w.prompts).toHaveLength(2);

	// The next process finds nothing left to run.
	Chat.holdStarts(false);
	let restarted = await w.restart();
	await Chat.recover(restarted);
	await tick();
	expect(w.prompts).toHaveLength(2);
	expect((await w.rows())[1]!.state).toBe("interrupted");
	replies.mockRestore();
});

test("a message that waits says nothing about why in Chat, however long it waits: its own mark is the only sign, and the machine's state is not said there", async () => {
	let w = await world({ away: true });
	let before = w.context.chat.entries.length;
	await w.send("is anyone there");
	// Only the message itself joined the Chat, and it is marked sent.
	expect(w.context.chat.entries).toHaveLength(before + 1);
	expect(memberEntry(w.context, "is anyone there")?.deliveryState).toBe("sent");
	await Bun.sleep(120);
	await Chat.kick(w.context);
	expect(w.context.chat.entries).toHaveLength(before + 1);
	expect(w.context.chat.entries.some(entry => entry.author.kind === "system")).toBe(false);

	// The same when no machine is involved and nobody who could claim the document is signed in.
	let owned = await world();
	owned.planner.hold();
	await owned.send("running");
	await waitFor(() => owned.planner.running === 1);
	await owned.send("early");
	let agent = (await owned.storage.channels.readAgent(owned.channel.id, new Date()))!.agent!;
	await owned.storage.channels.clearAgentOwner(
		owned.channel.id,
		agent.ownerSessionId!,
		agent.generation,
		new Date(),
	);
	owned.planner.hold(false);
	let restarted = await owned.restart(false);
	await Chat.recover(restarted);
	await Bun.sleep(120);
	await Chat.kick(restarted);
	expect(await owned.rows(["waiting"])).toHaveLength(1);
	expect(restarted.chat.entries.some(entry => entry.author.kind === "system")).toBe(false);
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

for (
	let { reason, shown } of [
		{ reason: "agent", shown: "machine-removed" },
		{ reason: "unavailable", shown: "document-unavailable" },
	] as const
) {
	test(`a message cancelled while its document was closed, because of ${reason}, reads as one that could not be sent for that reason when the document opens again`, async () => {
		let w = await world({ away: true });
		await w.send("sent into a document that closed");
		let [row] = await w.rows(["waiting"]);
		await w.storage.deferredTurns.transition(w.lease, {
			id: row!.id,
			from: "waiting",
			to: "cancelled",
			at: new Date(),
			reason,
		});
		let restarted = await w.restart();
		await Chat.recover(restarted);
		await tick();
		expect(memberEntry(restarted, "sent into a document that closed")).toMatchObject({
			deliveryState: "failed",
			deliveryFailure: shown,
		});
	});
}

test("under AUTH_MODE=local with a machine running the Planner, as the server's own wiring configures it, a message to the machine while it is away is saved, shown as sent, and delivered once when it attaches", async () => {
	let config = configured({ ...LOCAL, AGENT: "on", HARNESS: "remote" });
	let w = await world({ away: true, config });
	// What the server hands the document's Chat for this configuration, from the function it calls.
	expect(w.context.deferred).toBeDefined();
	expect(w.context.plannerReady).toBeDefined();
	let answer = await w.send("sent from a laptop to a machine that is off");
	expect(answer).toMatchObject({ kind: "chat:send", queued: true });
	expect(answer.kind).not.toBe("session:error");
	expect(memberEntry(w.context, "sent from a laptop to a machine that is off")?.deliveryState)
		.toBe("sent");
	expect((await w.rows(["waiting"])).map(row => row.text)).toEqual([
		"sent from a laptop to a machine that is off",
	]);
	expect(w.prompts).toEqual([]);

	await w.attach();
	await w.turns(1);
	await w.attach();
	await tick();
	expect(w.prompts).toHaveLength(1);
	expect(memberEntry(w.context, "sent from a laptop to a machine that is off")?.deliveryState)
		.toBe("delivered");
	expect((await w.rows()).map(row => row.state)).toEqual(["ended"]);
});

test("under AUTH_MODE=local with a Planner on the same computer, the server's wiring keeps no rows and the queue stays in memory", async () => {
	let config = configured({ ...LOCAL, AGENT: "on", HARNESS: "copilot-sdk" });
	let w = await world({ config });
	expect(w.context.deferred).toBeUndefined();
	expect(w.context.plannerReady).toBeUndefined();
	await w.send("on this computer");
	await w.turns(1);
	expect(await w.rows()).toEqual([]);
});

test("a message to a machine's Planner is kept while the machine is away in local mode too, and a local Planner that is never away keeps its queue in memory", () => {
	// Hosted mode, and the local mode that runs its Planner on a machine, save every request.
	expect(keepsRequests(configured({ AGENT: "on", HARNESS: "remote" }))).toBe(true);
	expect(keepsRequests(configured({ ...LOCAL, AGENT: "on", HARNESS: "remote" }))).toBe(true);
	expect(keepsRequests(configured({ AGENT: "on", HARNESS: "copilot-sdk" }))).toBe(true);
	// Local mode with a Planner on the same machine is never handed over and nothing is away.
	expect(keepsRequests(configured({ ...LOCAL, AGENT: "on", HARNESS: "copilot-sdk" }))).toBe(false);
});

test("every line a saved request writes into Chat is in plain words", () => {
	for (let kind of ["composer", "invoke_planner", "invoke_system", "comment", "draft"] as const) {
		let row = { kind, handle: "ana" };
		expectPlain(interruptedNotice(row), `the ${kind} request a restart stopped`);
		for (let why of ["agent", "unavailable", "access"] as const) {
			expectPlain(cancelledNotice(row, why), `the ${kind} request cancelled for ${why}`);
		}
	}
});

/**
 * Every place a send can fail for a reason that has nothing to do with its message, as the server
 * can be made to reach it: the answer says it passes, and the same request id is then taken once.
 */
const PASSING_FAILURES: Array<{
	name: string;
	inject: (w: Awaited<ReturnType<typeof world>>, child: string) => void;
	focused?: boolean;
}> = [
	{
		name: "storage failing while a reference is looked up",
		inject: w => {
			let first = true;
			w.context.references = {
				resolve: async ({ text }: { text: string }) => {
					if (first) {
						first = false;
						throw new Error("storage unavailable");
					}
					return { text: text.trim() };
				},
			} as never;
		},
	},
	{
		name: "storage failing while the open child is looked up",
		focused: true,
		inject: (w, child) => {
			let first = true;
			w.context.children = {
				list: async () => [],
				resolve: async id => {
					if (first) {
						first = false;
						throw new Error("storage unavailable");
					}
					return { id, title: "Child", createdAt: "" };
				},
				open: async () => {
					throw new Error("not used");
				},
			};
			void child;
		},
	},
	{
		name: "the commit that keeps the message failing",
		inject: w => {
			let persist = w.context.persist;
			let first = true;
			w.context.persist = async (...args) => {
				if (first) {
					first = false;
					throw new Error("storage unavailable");
				}
				return persist(...args);
			};
		},
	},
	{
		name: "storage failing while a retried send is looked up among the rows",
		inject: w => {
			spyOn(w.storage.deferredTurns, "get").mockRejectedValueOnce(
				new Error("storage unavailable"),
			);
		},
	},
	{
		name: "the check of whether the machine is there failing",
		inject: w => {
			let ready = w.context.plannerReady!;
			let first = true;
			w.context.plannerReady = async () => {
				if (first) {
					first = false;
					throw new Error("link unavailable");
				}
				return ready();
			};
		},
	},
];

for (let failure of PASSING_FAILURES) {
	test(`a message refused because of ${failure.name} is answered as a passing trouble, and the same request is then kept once and delivered once`, async () => {
		let logged = spyOn(console, "error").mockImplementation(() => {});
		try {
			let w = await world({ away: true });
			let child = crypto.randomUUID();
			failure.inject(w, child);
			let requestId = crypto.randomUUID();
			let extra = { requestId, ...(failure.focused ? { focus: child } : {}) };

			let refused = await w.send("kept once", "ana", extra);
			expect(refused).toMatchObject({
				kind: "session:error",
				code: "temporarily-unavailable",
			});
			expectPlain(String(refused.message), "a refused send");
			// Nothing of it was kept, so nothing is acknowledged ahead of what survives.
			expect(await w.rows()).toEqual([]);
			expect(memberEntry(w.context, "kept once")).toBeUndefined();

			let taken = await w.send("kept once", "ana", extra);
			expect(taken).toMatchObject({ kind: "chat:send", id: requestId, queued: true });
			// Asked again once more, it gets that answer back, not a second row.
			expect(await w.send("kept once", "ana", extra)).toMatchObject({
				kind: "chat:send",
				id: requestId,
			});
			expect((await w.rows()).filter(row => row.requestId === requestId)).toHaveLength(1);
			expect(w.context.chat.entries.filter(entry => entry.id === requestId)).toHaveLength(1);

			await w.attach();
			await w.turns(1);
			expect(w.prompts.filter(prompt => prompt.includes("kept once"))).toHaveLength(1);
			expect(memberEntry(w.context, "kept once")?.deliveryState).toBe("delivered");
		} finally {
			logged.mockRestore();
		}
	});
}

test("a delete that fails for storage's sake is answered, not left unanswered, without the code that ends the asking, and asked again takes the message back", async () => {
	let logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		let w = await world({ away: true });
		let sent = await w.send("take this back");
		let sender = w.socket();
		let persist = w.context.persist;
		let failing = true;
		w.context.persist = async (...args) => {
			if (failing) throw new Error("storage unavailable");
			return persist(...args);
		};
		await Chat.remove(
			w.context,
			sender.ws,
			{ kind: "chat:delete", rid: "first", id: sent.id as string } as never,
		);
		// Not the server's last word: only `message-not-deletable` ends a page's asking.
		let first = sender.frames.find(frame => frame.rid === "first");
		expect(first?.kind).toBe("session:error");
		expect(first?.code).toBeUndefined();
		expect(memberEntry(w.context, "take this back")).toBeDefined();

		// A lookup of the row that throws is answered too, not left for the page to wait on.
		let lookup = spyOn(w.storage.deferredTurns, "get").mockRejectedValueOnce(new Error("down"));
		await Chat.remove(
			w.context,
			sender.ws,
			{ kind: "chat:delete", rid: "lookup", id: crypto.randomUUID() } as never,
		);
		lookup.mockRestore();
		let looked = sender.frames.find(frame => frame.rid === "lookup");
		expect(looked?.kind).toBe("session:error");
		expect(looked?.code).toBeUndefined();

		failing = false;
		await Chat.remove(
			w.context,
			sender.ws,
			{ kind: "chat:delete", rid: "second", id: sent.id as string } as never,
		);
		expect(sender.frames.find(frame => frame.rid === "second")).toMatchObject({
			kind: "chat:delete",
			id: sent.id,
		});
		expect(memberEntry(w.context, "take this back")).toBeUndefined();
		await w.attach();
		await tick();
		expect(w.prompts).toEqual([]);
	} finally {
		logged.mockRestore();
	}
});

test("a message sent again that fails for storage's sake is answered, and pressed again goes through once", async () => {
	let logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		let w = await world({ away: true });
		let sent = await w.send("write access will go");
		w.writable = false;
		await w.attach();
		await waitFor(() => memberEntry(w.context, "write access will go")?.deliveryState === "failed");
		w.writable = true;
		let author = w.socket();
		let persist = w.context.persist;
		let failing = true;
		w.context.persist = async (...args) => {
			if (failing) throw new Error("storage unavailable");
			return persist(...args);
		};
		await Chat.retry(
			w.context,
			author.ws,
			{ kind: "chat:retry", rid: "first", id: sent.id as string } as never,
		);
		expect(author.frames.find(frame => frame.rid === "first")?.kind).toBe("session:error");
		expect(memberEntry(w.context, "write access will go")?.deliveryState).toBe("failed");
		failing = false;
		await Chat.retry(
			w.context,
			author.ws,
			{ kind: "chat:retry", rid: "second", id: sent.id as string } as never,
		);
		expect(author.frames.find(frame => frame.rid === "second")).toMatchObject({
			kind: "chat:retry",
		});
		await w.turns(1);
		expect(w.prompts.filter(prompt => prompt.includes("write access will go"))).toHaveLength(1);
	} finally {
		logged.mockRestore();
	}
});

/** The commit of a send's row goes through, and what answers it is lost, as a connection that drops after COMMIT does. */
function losingTheNextAcknowledgement(w: Awaited<ReturnType<typeof world>>) {
	let persist = w.context.persist;
	let lost = true;
	w.context.persist = async (...args) => {
		let saved = await persist(...args);
		if (lost && args[1]?.length) {
			lost = false;
			throw new Error("the commit's acknowledgement was lost");
		}
		return saved;
	};
}

const promptsOf = (w: Awaited<ReturnType<typeof world>>) =>
	w.prompts.map(prompt => ["first", "second"].find(word => prompt.includes(word)));

test("a message whose commit went through but whose acknowledgement was lost is kept and delivered once, ahead of one sent after it, when it is sent again", async () => {
	let logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		let w = await world({ away: true });
		losingTheNextAcknowledgement(w);
		let requestId = crypto.randomUUID();
		expect(await w.send("first", "ana", { requestId })).toMatchObject({
			kind: "session:error",
			code: "temporarily-unavailable",
		});
		expect(await w.send("second", "bob")).toMatchObject({ kind: "chat:send", queued: true });
		// Sent again, it is answered as kept, and is back in the queue ahead of the later one.
		expect(await w.send("first", "ana", { requestId })).toMatchObject({
			kind: "chat:send",
			id: requestId,
			queued: true,
		});
		expect(w.context.chat.entries.filter(entry => entry.id === requestId)).toHaveLength(1);
		expect(w.context.chat.entries.map(entry => entry.text)).toEqual(["first", "second"]);

		await w.attach();
		await w.turns(2);
		expect(promptsOf(w)).toEqual(["first", "second"]);
		expect((await w.rows()).map(row => [row.text, row.state])).toEqual([
			["first", "ended"],
			["second", "ended"],
		]);
		expect(memberEntry(w.context, "first")?.deliveryState).toBe("delivered");
		// Sent once more, it is the answer it had, not a second delivery.
		expect(await w.send("first", "ana", { requestId })).toMatchObject({ kind: "chat:send" });
		await tick();
		expect(w.prompts).toHaveLength(2);
	} finally {
		logged.mockRestore();
	}
});

test("a message whose commit went through but whose acknowledgement was lost is delivered once, ahead of a later one, when its sender never sends it again and the machine comes back", async () => {
	let logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		let w = await world({ away: true });
		losingTheNextAcknowledgement(w);
		await w.send("first");
		await w.send("second", "bob");
		await w.attach();
		await w.turns(2);
		expect(promptsOf(w)).toEqual(["first", "second"]);
		expect(
			w.context.chat.entries.filter(entry => entry.author.kind === "member").map(entry =>
				entry.text
			),
		).toEqual(["first", "second"]);
		expect((await w.rows()).map(row => row.state)).toEqual(["ended", "ended"]);
	} finally {
		logged.mockRestore();
	}
});

test("a message whose commit went through but whose acknowledgement was lost is still waiting after a restart, in its place, and is delivered once", async () => {
	let logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		let w = await world({ away: true });
		losingTheNextAcknowledgement(w);
		await w.send("first");
		await w.send("second", "bob");
		expect((await w.rows(["waiting"])).map(row => row.text)).toEqual(["first", "second"]);

		let restarted = await w.restart();
		await Chat.recover(restarted);
		expect((await w.rows(["waiting"])).map(row => row.text)).toEqual(["first", "second"]);
		expect(restarted.chat.entries.map(entry => entry.text)).toEqual(["first", "second"]);
		await w.attach();
		await w.turns(2);
		expect(promptsOf(w)).toEqual(["first", "second"]);
		expect((await w.rows()).map(row => row.state)).toEqual(["ended", "ended"]);
	} finally {
		logged.mockRestore();
	}
});

test("a message kept by a commit whose acknowledgement was lost and then deleted stays deleted: it is not brought back by a send again, by the machine's return or by a restart", async () => {
	let logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		let w = await world({ away: true });
		losingTheNextAcknowledgement(w);
		let requestId = crypto.randomUUID();
		await w.send("first", "ana", { requestId });
		let sender = w.socket();
		await Chat.remove(
			w.context,
			sender.ws,
			{ kind: "chat:delete", rid: "delete", id: requestId } as never,
		);
		expect(sender.frames.find(frame => frame.rid === "delete")?.kind).toBe("chat:delete");
		expect(await w.send("first", "ana", { requestId })).toMatchObject({
			kind: "session:error",
			message: "this message was deleted",
		});
		await w.send("second", "bob");
		await w.attach();
		await w.turns(1);
		let restarted = await w.restart();
		await Chat.recover(restarted);
		await w.attach();
		await tick();
		expect(promptsOf(w)).toEqual(["second"]);
		expect((await w.rows()).map(row => [row.text, row.state])).toEqual([
			["first", "cancelled"],
			["second", "ended"],
		]);
	} finally {
		logged.mockRestore();
	}
});

test("simultaneous MCP calls to a machine that is away, with the check of whether it is there slow, are each kept in the order they came, none refused as a full queue", async () => {
	let w = await world({ away: true });
	let user = { id: w.ana.id, login: "ana" };
	let answered = w.slowCheck();
	let calls = Array.from(
		{ length: 40 },
		(_, index) => Chat.invoke(w.context, user, `call ${index}`),
	);
	await tick();
	answered();
	expect(await Promise.all(calls)).toEqual(Array.from({ length: 40 }, () => undefined));
	expect((await w.rows(["waiting"])).map(row => row.text)).toEqual(
		Array.from({ length: 40 }, (_, index) => `call ${index}`),
	);
	await w.attach();
	await w.turns(40);
	w.prompts.forEach((prompt, index) => expect(prompt).toContain(`call ${index}`));
});

test("simultaneous messages and task drafts for a machine that is away, with the check slow, are each kept, none turned away for how many are being saved", async () => {
	let w = await world({ away: true });
	let answered = w.slowCheck();
	let sends = Array.from({ length: 40 }, (_, index) => w.send(`message ${index}`));
	let drafts = Array.from(
		{ length: 25 },
		() => Chat.draftTasks(w.context, "ana", 3, "draft the tasks", "ana asked for tasks"),
	);
	await tick();
	answered();
	for (let sent of await Promise.all(sends)) {
		expect(sent).toMatchObject({ kind: "chat:send", queued: true });
	}
	for (let draft of await Promise.all(drafts)) expect(draft.ok).toBe(true);
	expect((await w.rows(["waiting"])).filter(row => row.kind === "composer").map(row => row.text))
		.toEqual(Array.from({ length: 40 }, (_, index) => `message ${index}`));
});

test("for a machine that is there, too many requests being saved at once are still turned away, as they were", async () => {
	let logged = spyOn(console, "error").mockImplementation(() => {});
	try {
		let w = await world({ away: false });
		let user = { id: w.ana.id, login: "ana" };
		let answered = w.slowCheck();
		let calls = Array.from(
			{ length: 25 },
			(_, index) => Chat.invoke(w.context, user, `call ${index}`),
		);
		let sends = Array.from({ length: 25 }, (_, index) => w.send(`message ${index}`));
		await tick();
		answered();
		let results = await Promise.all(calls);
		expect(results.filter(result => result === "planner-queue-full").length).toBeGreaterThan(0);
		let sent = await Promise.all(sends);
		expect(sent.filter(frame => frame.kind === "session:error").length).toBeGreaterThan(0);
	} finally {
		logged.mockRestore();
	}
});
