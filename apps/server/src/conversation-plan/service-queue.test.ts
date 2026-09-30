import { expect, test } from "bun:test";

import { applyInference, initialState, restoreState } from "./domain";

import { createProcessor } from "./service";

import { deferred, entry, harness, opened, unlinked, until } from "./service.test-fixtures";

// Whole callbacks from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, service.test.ts.
test("acceptance persists transcript and queue together, then runs FIFO with prior context", async () => {
	let seen: Array<{ id: string; recent: string[] }> = [];
	let first = deferred<ReturnType<typeof unlinked>>();
	let setup = harness(async input => {
		seen.push({ id: input.message.id, recent: input.recent.map(item => item.id) });
		return input.message.id === "one" ? first.promise : unlinked();
	});
	let processor = createProcessor(setup.dependencies);
	await processor.accept(entry("one", "First proposal."));
	await processor.accept(entry("two", "Second proposal."));
	expect(setup.durable.entries.map(item => item.id)).toEqual(["one", "two"]);
	expect(setup.durable.state.queue.map(item => item.messageId)).toEqual(["one", "two"]);
	expect(setup.publications).toHaveLength(0);
	processor.afterMessage();
	await until(() => seen.length === 1);
	first.resolve(unlinked());
	await until(() => setup.durable.state.queue.length === 0);
	expect(seen).toEqual([
		{ id: "one", recent: [] },
		{ id: "two", recent: ["one"] },
	]);
	expect(setup.publications.at(-1)).toEqual(setup.durable.state);
});

test("failed acceptance rolls back both values and never publishes", async () => {
	let setup = harness();
	let processor = createProcessor(setup.dependencies);
	setup.fail();
	await expect(processor.accept(entry("one", "Should we use an outline?")))
		.rejects.toThrow("storage failed");
	expect(setup.plan.chat.entries).toEqual([]);
	expect(setup.plan.conversationPlan).toEqual(initialState());
	expect(setup.durable.entries).toEqual([]);
	expect(setup.publications).toEqual([]);
});

test("failed completion keeps pending work for the next open and publishes nothing new", async () => {
	let response = deferred<ReturnType<typeof unlinked>>();
	let started = false;
	let setup = harness(async () => {
		started = true;
		return response.promise;
	});
	let processor = createProcessor(setup.dependencies);
	await processor.accept(entry("one", "An option."));
	processor.afterMessage();
	await until(() => started);
	let published = setup.publications.length;
	setup.fail();
	response.resolve(unlinked());
	await until(() => setup.errors.length === 1);
	expect(setup.plan.conversationPlan.queue[0]?.status).toBe("pending");
	expect(setup.durable.state.queue[0]?.status).toBe("pending");
	expect(setup.publications).toHaveLength(published);
});

test("stale inference reruns after a correction without losing a later enqueue", async () => {
	let pending = deferred<ReturnType<typeof unlinked>>();
	let calls = 0;
	let setup = harness(async () => {
		calls++;
		return calls === 1 ? pending.promise : unlinked();
	});
	let seed = entry("seed", "Should we use an outline?");
	setup.plan.chat.entries.push(seed);
	setup.plan.conversationPlan = applyInference(initialState(), opened(seed), seed);
	let processor = createProcessor(setup.dependencies);
	await processor.accept(entry("one", "Maybe make it optional."));
	processor.afterMessage();
	await until(() => calls === 1);
	await processor.accept(entry("two", "I agree with optional."));
	await processor.correct({
		actionId: "edit-1",
		threadId: "thread-a",
		expectedVersion: 1,
		change: { kind: "edit", field: "question", text: "Which outline should we use?" },
	}, { kind: "member", handle: "ana" });
	pending.resolve(unlinked());
	await until(() => setup.plan.conversationPlan.queue.length === 0);
	expect(calls).toBe(3);
	expect(setup.plan.conversationPlan.threads[0]?.question).toBe(
		"Which outline should we use?",
	);
	expect(setup.plan.conversationPlan.analysis.map(item => item.messageId)).toEqual([
		"one",
		"two",
	]);
});

test("stop leaves in-flight work durable and a restored processor resumes it", async () => {
	let pending = deferred<ReturnType<typeof unlinked>>();
	let started = false;
	let setup = harness(async () => {
		started = true;
		return pending.promise;
	});
	let processor = createProcessor(setup.dependencies);
	await processor.accept(entry("one", "Use an outline."));
	processor.afterMessage();
	await until(() => started);
	processor.stop();
	pending.resolve(unlinked());
	await Bun.sleep(2);
	expect(setup.durable.state.queue[0]?.status).toBe("pending");
	let restored = harness();
	restored.plan.chat.entries = structuredClone(setup.durable.entries);
	restored.plan.conversationPlan = restoreState(
		setup.durable.state,
		restored.plan.chat.entries,
	);
	let resumed = createProcessor(restored.dependencies);
	resumed.wake();
	await until(() => restored.plan.conversationPlan.queue.length === 0);
	expect(restored.plan.conversationPlan.analysis[0]?.messageId).toBe("one");
});

test("failed analysis is durable; retry keys are idempotent and collision checked", async () => {
	let calls = 0;
	let setup = harness(async () => {
		calls++;
		return calls === 1
			? {
				events: [],
				analysis: {
					questionSetVersion: "test",
					modelVersion: "fake",
					status: "failed",
					passes: [],
					error: "temporary failure",
				},
			}
			: unlinked();
	});
	let processor = createProcessor(setup.dependencies);
	await processor.accept(entry("one", "An option."));
	processor.afterMessage();
	await until(() => setup.durable.state.queue[0]?.status === "failed");
	expect(setup.durable.state.analysis[0]?.error).toBe("temporary failure");
	await processor.retry("retry-1", "one", { kind: "member", handle: "ana" });
	await until(() => setup.durable.state.queue.length === 0);
	expect(calls).toBe(2);
	expect(await processor.retry("retry-1", "one", { kind: "member", handle: "ana" }))
		.toEqual({ messageId: "one", queued: false });
	await expect(processor.retry("retry-1", "other", { kind: "member", handle: "ana" }))
		.rejects.toThrow("collision");
	expect(setup.durable.retries).toEqual([{ id: "human:ana:retry-1", messageId: "one" }]);
});

test("a full analysis queue skips new work without rejecting chat", async () => {
	let setup = harness();
	setup.plan.conversationPlan = {
		...initialState(),
		queue: Array.from({ length: 128 }, (_, index) => ({
			messageId: `old-${index}`,
			status: "failed" as const,
			attempts: 0,
		})),
	};
	let processor = createProcessor(setup.dependencies);
	await processor.accept(entry("new", "A new question."));
	expect(setup.durable.entries.at(-1)?.id).toBe("new");
	expect(setup.durable.state.analysis.at(-1)).toMatchObject({
		messageId: "new",
		status: "unlinked",
		policyGate: "queue full; skipped",
	});
	expect(setup.durable.state.queue).toHaveLength(128);
});

test("inactive and forged human actions cannot mutate the sidecar", async () => {
	let setup = harness();
	let seed = entry("seed", "Should we use an outline?");
	setup.plan.chat.entries.push(seed);
	setup.plan.conversationPlan = applyInference(initialState(), opened(seed), seed);
	let processor = createProcessor(setup.dependencies);
	await expect(processor.correct({
		actionId: "bad",
		threadId: "thread-a",
		expectedVersion: 1,
		change: { kind: "edit", field: "question", text: "Forged" },
	}, { kind: "classifier" } as never)).rejects.toThrow("member");
	setup.active = false;
	await expect(processor.correct({
		actionId: "archived",
		threadId: "thread-a",
		expectedVersion: 1,
		change: { kind: "edit", field: "question", text: "Archived" },
	}, { kind: "member", handle: "ana" })).rejects.toThrow("unavailable");
	await expect(processor.retry("retry", "seed", { kind: "member", handle: "ana" }))
		.rejects.toThrow("unavailable");
	expect(setup.plan.conversationPlan.threads[0]?.question).toBe(seed.text);
});

test("failed correction commit restores the previous card and emits no change", async () => {
	let setup = harness();
	let seed = entry("seed", "Should we use an outline?");
	setup.plan.chat.entries.push(seed);
	setup.plan.conversationPlan = applyInference(initialState(), opened(seed), seed);
	let processor = createProcessor(setup.dependencies);
	setup.fail();
	await expect(processor.correct({
		actionId: "edit-failed",
		threadId: "thread-a",
		expectedVersion: 1,
		change: { kind: "edit", field: "question", text: "Different question" },
	}, { kind: "member", handle: "ana" })).rejects.toThrow("storage failed");
	expect(setup.plan.conversationPlan.threads[0]?.question).toBe(seed.text);
	expect(setup.publications).toEqual([]);
});
