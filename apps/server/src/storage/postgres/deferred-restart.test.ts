import { afterEach, describe, expect, it } from "bun:test";

import * as Chat from "../../chat/service";
import { cleanups, memberEntry, tick, waitFor, world } from "../../chat/deferred.test-fixtures";
import { PostgresStorage } from "./adapter";

let url = process.env.TEST_DATABASE_URL;

afterEach(async () => {
	Chat.holdStarts(false);
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * Saved Planner requests across processes' worth of PostgreSQL: each "process" has its own
 * connections and writer lease, and the next finds only what was committed.
 */
describe.skipIf(!url)("PostgreSQL saved Planner requests", () => {
	let processes = async (extra: { away?: boolean } = {}) => {
		let opened: PostgresStorage[] = [];
		let connect = async () => {
			let storage = new PostgresStorage(url!);
			await storage.migrate();
			opened.push(storage);
			return storage;
		};
		let lease = `chopin:test-deferred-${crypto.randomUUID()}`;
		// Registered before the world's own cleanup, which runs first: a Chat still saving a turn is
		// closed while its database is open, not left to fail on a connection that was closed under it.
		cleanups.push(async () => {
			for (let storage of opened) await storage.close().catch(() => {});
		});
		return world({ ...extra, storage: await connect(), reopen: connect, lease });
	};

	it("keep a message, an automatic follow-up, a task draft and a comment note that waited behind a running turn through a kill, and start each once, in order, afterwards", async () => {
		let w = await processes();
		w.planner.hold();
		await w.send("running");
		await waitFor(() => w.planner.running === 1);
		await w.send("a message");
		await Chat.invoke(
			w.context,
			{ id: w.ana.id, login: "ana" },
			"follow up quietly",
			undefined,
			undefined,
			undefined,
			"Automatic follow-up requested by @ana.",
		);
		await Chat.draftTasks(w.context, "ana", 4, "draft the tasks", "ana asked for tasks");
		await Chat.instruct(w.context, "ana", "the first prompt", "Comment on “x” sent to Chopin", {
			thread: "thread-1",
			defer: { kind: "comment", userId: w.ana.id },
		});
		expect((await w.rows(["waiting"])).map(row => row.kind)).toEqual([
			"composer",
			"invoke_system",
			"draft",
			"comment",
		]);

		w.planner.hold(false);
		let restarted = await w.restart();
		restarted.deferred!.restoreComment = async row => ({
			id: "ignored",
			handle: row.handle,
			text: "the thread as it reads now",
			thread: row.threadId,
		});
		await Chat.recover(restarted);
		await w.turns(5);
		let given = w.prompts.slice(1);
		expect(
			given.map(prompt =>
				["a message", "follow up", "draft the", "as it reads now"].findIndex(part =>
					prompt.includes(part)
				)
			),
		).toEqual([0, 1, 2, 3]);
		// The turn that was running, as a row too, ended in the process that ran it.
		expect((await w.rows()).map(row => row.state)).toEqual([
			"ended",
			"ended",
			"ended",
			"ended",
			"ended",
		]);
		expect(memberEntry(restarted, "a message")?.deliveryState).toBe("delivered");
		await Chat.recover(restarted);
		await tick();
		expect(w.prompts).toHaveLength(5);
	});

	it("mark a row a dead process had started as interrupted, with its notice, and never run it again", async () => {
		let w = await processes();
		w.planner.hold();
		await w.send("running");
		await waitFor(() => w.planner.running === 1);
		await w.send("queued");
		let [row] = await w.rows(["waiting"]);
		await w.storage.deferredTurns.transition(w.lease, {
			id: row!.id,
			from: "waiting",
			to: "started",
			at: new Date(),
		});
		w.planner.hold(false);
		let restarted = await w.restart();
		await Chat.recover(restarted);
		await tick();
		expect((await w.rows()).find(value => value.id === row!.id)).toMatchObject({
			state: "interrupted",
		});
		expect(restarted.chat.entries.filter(entry => entry.id === `interrupted:${row!.id}`))
			.toHaveLength(1);
		expect(w.prompts).toHaveLength(1);
	});

	it("accept a message for a machine that is away as a saved request, and send it exactly once when the next process finds the machine back", async () => {
		let w = await processes({ away: true });
		let answer = await w.send("while the machine was away");
		expect(answer).toMatchObject({ kind: "chat:send", queued: true });
		let restarted = await w.restart();
		await Chat.recover(restarted);
		await tick();
		expect(w.prompts).toEqual([]);
		expect(memberEntry(restarted, "while the machine was away")?.deliveryState).toBe("sent");
		await w.attach();
		await w.turns(1);
		await w.attach();
		await tick();
		expect(w.prompts).toHaveLength(1);
		expect(memberEntry(restarted, "while the machine was away")?.deliveryState).toBe("delivered");
		expect((await w.rows())[0]!.state).toBe("ended");
	});
});
