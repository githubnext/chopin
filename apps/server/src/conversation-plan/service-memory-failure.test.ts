import { expect, test } from "bun:test";
import { entry, until } from "./service.test-fixtures";
import { memoryProcessor, opening } from "./service-memory.test-fixtures";

test("real memory acceptance failure rolls back transcript and queue without publication", async () => {
	let setup = await memoryProcessor();
	try {
		let processor = setup.start(opening);
		setup.failNextCommit();
		await expect(processor.accept(entry("memory-rejected", "Which auth system?"))).rejects.toThrow(
			"memory commit rejected",
		);
		expect(setup.plan.chat.entries).toEqual([]);
		expect(setup.plan.conversationPlan.queue).toEqual([]);
		expect(setup.publications).toEqual([]);
		let saved = await setup.saved();
		expect(saved.transcript).toEqual([]);
		expect(saved.conversationPlan).toBeUndefined();
		expect(setup.fatals).toHaveLength(1);
		await setup.reopen();
		expect(setup.plan.chat.entries).toEqual([]);
		expect(setup.plan.conversationPlan.queue).toEqual([]);
	} finally {
		await setup.close();
	}
});

test("real memory completion failure preserves pending work and a reopened processor delivers its outbox", async () => {
	let setup = await memoryProcessor();
	try {
		let processor = setup.start(opening);
		await processor.accept(entry("memory-completion", "Which auth system?"));
		setup.failNextCommit();
		processor.afterMessage();
		await until(() => setup.errors.length === 1);
		expect(setup.publications).toHaveLength(1);
		expect(setup.publications[0]!.analysis).toEqual([]);
		expect(setup.plan.conversationPlan.queue[0]?.status).toBe("pending");
		expect(setup.plan.conversationPlanPendingEffects).toEqual([]);
		let failed = await setup.saved();
		expect(failed.conversationPlan.analysis).toEqual([]);
		expect(failed.conversationPlan.queue[0]?.status).toBe("pending");
		await setup.reopen();
		processor = setup.start(opening);
		processor.setEffects(setup.sink);
		await until(() => setup.plan.conversationPlanEffects.includes("insert:thread-a"));
		let resumed = await setup.saved();
		expect(resumed.conversationPlan.queue).toEqual([]);
		expect(resumed.conversationPlan.analysis[0]?.status).toBe("applied");
		expect(resumed.conversationPlanEffects).toEqual(["insert:thread-a"]);
		expect(setup.calls).toEqual(["insert", "link"]);
		expect(setup.fatals).toHaveLength(1);
	} finally {
		await setup.close();
	}
});

test("real memory receipt failure retains the effect key for callback replay after open", async () => {
	let setup = await memoryProcessor();
	try {
		let processor = setup.start(opening);
		await processor.accept(entry("memory-receipt", "Which auth system?"));
		processor.afterMessage();
		await until(() => setup.publications.some(state => state.analysis[0]?.status === "applied"));
		setup.failNextCommit();
		processor.setEffects(setup.sink);
		await until(() => setup.errors.length === 1);
		expect(setup.calls).toEqual(["insert", "link"]);
		expect(setup.plan.conversationPlanPendingEffects).toMatchObject([{ key: "insert:thread-a" }]);
		expect(setup.plan.conversationPlanEffects).toEqual([]);
		let rejected = await setup.saved();
		expect(rejected.conversationPlanPendingEffects).toMatchObject([{ key: "insert:thread-a" }]);
		expect(rejected.conversationPlanEffects).toBeUndefined();
		expect(setup.fatals).toHaveLength(1);
		await setup.reopen();
		expect(setup.plan.conversationPlanPendingEffects).toMatchObject([{ key: "insert:thread-a" }]);
		processor = setup.start();
		processor.setEffects(setup.sink);
		await until(() => setup.plan.conversationPlanEffects.includes("insert:thread-a"));
		expect(setup.calls).toEqual(["insert", "link", "insert", "link"]);
		let delivered = await setup.saved();
		expect(delivered.conversationPlanPendingEffects).toBeUndefined();
		expect(delivered.conversationPlanEffects).toEqual(["insert:thread-a"]);
	} finally {
		await setup.close();
	}
});
