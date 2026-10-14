import { afterEach, expect, test } from "bun:test";
import { userAndChannel } from "../storage/contract-support";
import { MemoryStorage } from "../storage/memory/adapter";
import { FollowthroughCoordinator } from "./coordinator";
import type { Instruction } from "../chat/service";
import type { Followthrough } from "../storage/followthrough";
import type { ReviewScope } from "./coordinator";

let coordinators: FollowthroughCoordinator[] = [];
afterEach(() => {
	for (let coordinator of coordinators) coordinator.close();
	coordinators = [];
});

async function fixture(count = 1) {
	let storage = new MemoryStorage();
	let { channelId, repositoryId, userId, lease } = await userAndChannel(storage);
	let receipts: Followthrough[] = [];
	for (let index = 0; index < count; index++) {
		let childId = crypto.randomUUID();
		await storage.channels.create({
			id: childId,
			repositoryId,
			repositoryOwner: "octo-org",
			repositoryName: "score",
			parentChannelId: channelId,
			title: `Evidence ${index}`,
			createdBy: userId,
			now: new Date(),
		});
		storage.followthrough.prepare({
			channelId,
			childId,
			kind: "research",
			sourceId: `research-${index}`,
			resultKey: `answer-${index}`,
			now: new Date(index),
		})();
		receipts.push(
			(await storage.followthrough.forSource(channelId, "research", `research-${index}`))[0]!,
		);
	}
	let queue: Instruction[] = [];
	let changed: Followthrough[] = [];
	let errors: unknown[] = [];
	let scope: ReviewScope = {
		status: "ready",
		context: { planRevision: 7, sourceHash: "current" },
		text: "Fresh context",
	};
	let refusal: string | undefined;
	let blocked: string | undefined;
	let clockOffset = 0;
	let coordinator = new FollowthroughCoordinator({
		store: storage.followthrough,
		lease: () => lease,
		inspect: async () => scope,
		blocked: () => blocked,
		start: async (_receipt, instruction) => {
			if (refusal) return refusal;
			queue.push(instruction);
			return true;
		},
		changed: value => changed.push(value),
		error: error => errors.push(error),
		clock: () => Date.now() + clockOffset,
	});
	coordinators.push(coordinator);
	let queued = async (index = 0) => {
		for (let wait = 0; !queue[index] && wait < 100; wait++) await Bun.sleep(1);
		expect(queue[index]).toBeDefined();
		return queue[index]!;
	};
	return {
		storage,
		channelId,
		lease,
		receipts,
		coordinator,
		changed,
		errors,
		queue,
		queued,
		scope: (value: ReviewScope) => scope = value,
		refuse: (value?: string) => refusal = value,
		block: (value?: string) => blocked = value,
		advance: (ms: number) => clockOffset += ms,
		read: (index = 0) => storage.followthrough.get(channelId, receipts[index]!.id),
	};
}

test("duplicate wakes admit once; pending becomes running only at preparation, then never replays", async () => {
	let f = await fixture();
	let work = f.coordinator.wake(f.channelId);
	expect(f.coordinator.wake(f.channelId)).toBe(work);
	let instruction = await f.queued();
	expect((await f.read())?.status).toBe("pending");
	expect(f.changed).toHaveLength(0);
	let prepared = await instruction.prepare!();
	expect(prepared).toMatchObject({ status: "ready", text: "Fresh context" });
	expect(await f.read()).toMatchObject({
		status: "running",
		attempts: 1,
		context: { planRevision: 7 },
	});
	await instruction.ended!({ status: "done", text: "The evidence changes the recommendation." });
	await work;
	expect((await f.read())?.status).toBe("done");
	await f.coordinator.wake(f.channelId, true);
	expect(f.queue).toHaveLength(1);
	expect(f.changed.map(value => value.status)).toEqual(["running", "done"]);
});

test("queued work reads current scope and respects dismissal before model execution", async () => {
	let f = await fixture();
	let work = f.coordinator.wake(f.channelId);
	let instruction = await f.queued();
	await f.storage.followthrough.dismiss(f.channelId, f.receipts[0]!.id, 0, f.lease);
	expect(await instruction.prepare!()).toEqual({ status: "skipped" });
	await instruction.ended!({ status: "skipped" });
	await work;
	expect(await f.read()).toMatchObject({ status: "skipped", reason: "dismissed", attempts: 0 });
});

test("an invalidated result scope is skipped without a model claim", async () => {
	let f = await fixture();
	let work = f.coordinator.wake(f.channelId);
	let instruction = await f.queued();
	f.scope({ status: "skipped", reason: "scope-changed" });
	expect(await instruction.prepare!()).toEqual({ status: "skipped" });
	await instruction.ended!({ status: "skipped" });
	await work;
	expect(await f.read()).toMatchObject({ status: "skipped", attempts: 0 });
});

test("owner and capability refusals stay pending without repeated admission or attempts", async () => {
	let f = await fixture();
	f.refuse("owner-unavailable");
	await f.coordinator.wake(f.channelId);
	expect(await f.read()).toMatchObject({
		status: "pending",
		reason: "owner-unavailable",
		attempts: 0,
	});
	f.refuse();
	await f.coordinator.wake(f.channelId);
	expect(f.queue).toHaveLength(0);
	let work = f.coordinator.wake(f.channelId, true);
	let instruction = await f.queued();
	f.scope({ status: "deferred", reason: "remote-unavailable" });
	expect(await instruction.prepare!()).toEqual({ status: "deferred" });
	await instruction.ended!({ status: "skipped" });
	await work;
	expect(await f.read()).toMatchObject({
		status: "pending",
		reason: "remote-unavailable",
		attempts: 0,
	});
});

test("started failures need an explicit retry and keep one result identity", async () => {
	let f = await fixture();
	let work = f.coordinator.wake(f.channelId);
	let instruction = await f.queued();
	await instruction.prepare!();
	await instruction.ended!({ status: "failed" });
	await work;
	let failed = (await f.read())!;
	expect(failed).toMatchObject({ status: "failed", reason: "review-failed", attempts: 1 });
	await f.coordinator.wake(f.channelId, true);
	expect(f.queue).toHaveLength(1);
	await f.storage.followthrough.retry(f.channelId, failed.id, failed.revision, f.lease);
	work = f.coordinator.wake(f.channelId, true);
	instruction = await f.queued(1);
	await instruction.prepare!();
	await instruction.ended!({ status: "done", text: "The evidence changes the recommendation." });
	await work;
	expect(await f.read()).toMatchObject({ id: failed.id, status: "done", attempts: 2 });
});

test("multiple results serialize through the same parent queue", async () => {
	let f = await fixture(2);
	let work = f.coordinator.wake(f.channelId);
	let first = await f.queued();
	await first.prepare!();
	expect(f.queue).toHaveLength(1);
	await first.ended!({ status: "done", text: "The evidence changes the recommendation." });
	let second = await f.queued(1);
	expect((await f.read())?.status).toBe("done");
	expect((await f.read(1))?.status).toBe("pending");
	await second.prepare!();
	await second.ended!({ status: "done", text: "The evidence changes the recommendation." });
	await work;
	expect((await f.read(1))?.status).toBe("done");
});

test("claim failure cannot permit model execution; a failed finish cannot repeat effects", async () => {
	let f = await fixture();
	let work = f.coordinator.wake(f.channelId);
	let instruction = await f.queued();
	let claim = f.storage.followthrough.claim.bind(f.storage.followthrough);
	f.storage.followthrough.claim = async () => {
		throw new Error("commit unavailable");
	};
	await expect(instruction.prepare!()).rejects.toThrow("commit unavailable");
	await instruction.ended!({ status: "failed" });
	await work;
	expect(await f.read()).toMatchObject({ status: "pending", attempts: 0 });
	f.storage.followthrough.claim = claim;
	work = f.coordinator.wake(f.channelId, true);
	instruction = await f.queued(1);
	await instruction.prepare!();
	f.storage.followthrough.finish = async () => {
		throw new Error("finish unavailable");
	};
	await expect(
		Promise.resolve(
			instruction.ended!({ status: "done", text: "The evidence changes the recommendation." }),
		),
	).rejects.toThrow("finish unavailable");
	await work;
	expect((await f.read())?.status).toBe("running");
	await f.coordinator.wake(f.channelId, true);
	expect(f.queue).toHaveLength(2);
	await f.storage.followthrough.recoverInterrupted(f.lease);
	expect(await f.read()).toMatchObject({ status: "failed", reason: "interrupted", attempts: 1 });
});

test("an availability event during cooldown is retained until it can run", async () => {
	let f = await fixture();
	f.refuse("owner-unavailable");
	await f.coordinator.wake(f.channelId);
	f.refuse();
	f.advance(29_990);
	await f.coordinator.wake(f.channelId);
	let instruction = await f.queued();
	await instruction.prepare!();
	await instruction.ended!({ status: "done", text: "The evidence changes the recommendation." });
	await f.coordinator.wake(f.channelId);
	expect((await f.read())?.status).toBe("done");
});

test("an unlock during a deferred turn's finalization is not lost", async () => {
	let f = await fixture();
	let work = f.coordinator.wake(f.channelId);
	let instruction = await f.queued();
	f.scope({ status: "deferred", reason: "document-locked" });
	await instruction.prepare!();
	f.scope({
		status: "ready",
		context: { planRevision: 8, sourceHash: "unlocked" },
		text: "Current unlocked plan",
	});
	void f.coordinator.wake(f.channelId, true);
	await instruction.ended!({ status: "skipped" });
	await work;
	instruction = await f.queued(1);
	expect(await instruction.prepare!()).toMatchObject({
		status: "ready",
		text: "Current unlocked plan",
	});
	await instruction.ended!({ status: "done", text: "The evidence changes the recommendation." });
	await f.coordinator.wake(f.channelId);
	expect((await f.read())?.status).toBe("done");
});

test("an empty model turn is an incomplete review requiring explicit retry", async () => {
	let f = await fixture();
	let work = f.coordinator.wake(f.channelId);
	let instruction = await f.queued();
	expect(instruction.readiness).toBe(true);
	await instruction.prepare!();
	await instruction.ended!({ status: "done" });
	await work;
	expect(await f.read()).toMatchObject({
		status: "failed",
		reason: "review-incomplete",
		attempts: 1,
	});
	await f.coordinator.wake(f.channelId, true);
	expect(f.queue).toHaveLength(1);
});

test("a build locking after claim defers only the proven unstarted attempt", async () => {
	let f = await fixture();
	let work = f.coordinator.wake(f.channelId);
	let instruction = await f.queued();
	let first = await instruction.prepare!();
	f.block("document-locked");
	expect(await instruction.beforeStream!()).toBe(false);
	expect(await f.read()).toMatchObject({
		status: "pending",
		reason: "document-locked",
		attempts: 1,
	});
	await instruction.ended!({ status: "skipped" });
	await work;
	f.block();
	work = f.coordinator.wake(f.channelId, true);
	instruction = await f.queued(1);
	let second = await instruction.prepare!();
	expect(second).not.toEqual(first);
	expect(instruction.beforeStream!()).toBe(true);
	// Once streaming starts, a later build cannot release/replay possible model effects.
	f.block("document-locked");
	await instruction.ended!({ status: "done", text: "The evidence changes the recommendation." });
	await work;
	expect(await f.read()).toMatchObject({ status: "done", attempts: 2 });
});

test("failed release persistence keeps an unstarted attempt uncertain without replay", async () => {
	let f = await fixture();
	let work = f.coordinator.wake(f.channelId);
	let instruction = await f.queued();
	await instruction.prepare!();
	f.block("document-locked");
	f.storage.followthrough.releaseUnstarted = async () => {
		throw new Error("release unavailable");
	};
	await expect(Promise.resolve(instruction.beforeStream!())).rejects.toThrow("release unavailable");
	expect((await f.read())?.status).toBe("running");
	await instruction.ended!({ status: "failed" });
	await work;
	await f.coordinator.wake(f.channelId, true);
	expect(await f.read()).toMatchObject({ status: "failed", attempts: 1 });
	expect(f.queue).toHaveLength(1);
});
