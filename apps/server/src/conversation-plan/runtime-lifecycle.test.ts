import { expect, test } from "bun:test";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { applyInference, initialState } from "./domain";
import { createConversationRuntime } from "./runtime";
import { until } from "./service.test-fixtures";
import type { Room } from "../rooms";

/** Two replay-valid openings exercise real card consumers, with the first card commit held. */
async function heldInsert() {
	let opened = await openPlan();
	let plan = opened.plan;
	let room: Room = { id: plan.id, plan, members: new Map() };
	plan.conversationPlan = initialState();
	for (let index = 1; index <= 2; index++) {
		let entry = {
			id: `m${index}`,
			author: { kind: "member" as const, handle: "test" },
			text: `Which approach ${index}?`,
			ts: index,
		};
		plan.chat.entries.push(entry);
		plan.conversationPlan = applyInference(plan.conversationPlan, {
			id: `open${index}`,
			type: "thread.opened",
			threadId: `t${index}`,
			observedThreadVersion: 0,
			origin: "classifier",
			actor: { kind: "classifier" },
			at: index,
			question: entry.text,
			source: {
				messageId: entry.id,
				author: entry.author,
				quote: entry.text,
				start: 0,
				end: entry.text.length,
				role: "question",
			},
		}, entry);
	}
	plan.conversationPlanPendingEffects = plan.conversationPlan.threads.map((thread, index) => ({
		key: `insert:${thread.id}`,
		kind: "insert-card",
		threadId: thread.id,
		header: "Decision",
		question: thread.question,
		options: [],
		trigger: `m${index + 1}`,
	}));
	await Plan.persist(plan);
	let entered = false;
	let closed = false;
	let commitsAfterClose = 0;
	let publicationsAfterClose = 0;
	let release!: () => void;
	let gate = new Promise<void>(resolve => release = resolve);
	let commit = opened.storage.collaboration.commit;
	opened.storage.collaboration.commit = async input => {
		let questions = (input.sidecar as { questions?: unknown[] } | undefined)?.questions;
		if (!entered && questions?.length === 1) {
			entered = true;
			await gate;
		}
		if (closed) commitsAfterClose++;
		return commit(input);
	};
	let publish = opened.server.publish.bind(opened.server);
	opened.server.publish = (...args) => {
		if (closed) publicationsAfterClose++;
		return publish(...args);
	};
	let errors: unknown[] = [];
	let runtime = createConversationRuntime({
		config: { agent: false, conversationPlan: true },
		server: () => opened.server,
		unavailable: () => false,
		onError: error => errors.push(error),
	});
	await runtime.attach(room, plan, false);
	await until(() => entered);
	return {
		...opened,
		room,
		runtime,
		release,
		errors,
		closed: () => closed = true,
		late: () => ({ commits: commitsAfterClose, publications: publicationsAfterClose }),
	};
}

test("runtime stop drains a held real card insertion before document close", async () => {
	let fixture = await heldInsert();
	let stopped = false;
	let stopping = fixture.runtime.stop(fixture.plan).then(() => stopped = true);
	try {
		await Bun.sleep(10);
		expect(stopped).toBe(false);
		fixture.release();
		await stopping;
		await Plan.close(fixture.plan);
		fixture.closed();
		await Bun.sleep(10);
		expect(fixture.plan.records.size).toBe(2);
		expect(fixture.late()).toEqual({ commits: 0, publications: 0 });
		let restored = await Plan.open(fixture.channel.id, fixture.backend, fixture.server);
		try {
			expect(restored.records.size).toBe(2);
			expect(restored.conversationPlanPendingEffects).toHaveLength(2);
		} finally {
			await Plan.close(restored);
		}
	} finally {
		fixture.release();
		await stopping;
		if (!fixture.plan.persistence.closing) await Plan.close(fixture.plan);
	}
});

test("replacement attachment waits for the old real effect drain and recovers without duplicate cards", async () => {
	let fixture = await heldInsert();
	let previous = fixture.runtime.processor(fixture.plan);
	let attached = false;
	let attaching = Promise.resolve(fixture.runtime.attach(fixture.room, fixture.plan, false))
		.then(() => attached = true);
	try {
		await Bun.sleep(10);
		expect(attached).toBe(false);
		fixture.release();
		await attaching;
		expect(fixture.runtime.processor(fixture.plan)).not.toBe(previous);
		await until(() => fixture.plan.conversationPlanPendingEffects.length === 0);
		expect(fixture.plan.records.size).toBe(2);
		expect(fixture.plan.conversationPlan.threads.every(thread => !!thread.questionnaireId)).toBe(
			true,
		);
		expect(fixture.broadcasts.filter(frame => frame.kind === "question:asked")).toHaveLength(2);
		expect(fixture.errors).toEqual([]);
	} finally {
		fixture.release();
		await attaching;
		await fixture.runtime.stop(fixture.plan);
		await Plan.close(fixture.plan);
	}
});

test("overlapping stops and replacement attachment share the held real effect drain", async () => {
	let fixture = await heldInsert();
	let previous = fixture.runtime.processor(fixture.plan);
	let firstDone = false;
	let secondDone = false;
	let attached = false;
	let first = fixture.runtime.stop(fixture.plan);
	let second = fixture.runtime.stop(fixture.plan);
	let firstSettled = first.then(() => firstDone = true);
	let secondSettled = second.then(() => secondDone = true);
	let attaching = fixture.runtime.attach(fixture.room, fixture.plan, false)
		.then(() => attached = true);
	try {
		await Bun.sleep(10);
		expect(firstDone).toBe(false);
		expect(secondDone).toBe(false);
		expect(attached).toBe(false);
		expect(second).toBe(first);
		fixture.release();
		await Promise.all([firstSettled, secondSettled, attaching]);
		expect(fixture.runtime.processor(fixture.plan)).not.toBe(previous);
		await until(() => fixture.plan.conversationPlanPendingEffects.length === 0);
		expect(fixture.plan.records.size).toBe(2);
		expect(fixture.broadcasts.filter(frame => frame.kind === "question:asked")).toHaveLength(2);
		expect(fixture.errors).toEqual([]);
	} finally {
		fixture.release();
		await Promise.all([firstSettled, secondSettled, attaching]);
		await fixture.runtime.stop(fixture.plan);
		await Plan.close(fixture.plan);
	}
});
