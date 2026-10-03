import { expect, test } from "bun:test";
import { entry, until } from "./service.test-fixtures";
import { memoryProcessor, opening } from "./service-memory.test-fixtures";

test("real memory storage commits transcript and queue, then resumes analysis and receipts across opens", async () => {
	let setup = await memoryProcessor();
	try {
		let processor = setup.start(opening);
		let message = entry("memory-open", "Which auth system?");
		await processor.accept(message);
		let accepted = await setup.saved();
		expect(accepted.transcript).toEqual([message]);
		expect(accepted.conversationPlan.queue).toEqual([{
			messageId: message.id,
			status: "pending",
			attempts: 0,
		}]);
		expect(setup.publications).toEqual([]);
		await setup.reopen();
		expect(setup.plan.chat.entries).toEqual([message]);
		processor = setup.start(opening);
		processor.wake();
		await until(() => setup.publications.some(state => state.analysis[0]?.status === "applied"));
		let analyzed = await setup.saved();
		expect(analyzed.conversationPlan.queue).toEqual([]);
		expect(analyzed.conversationPlan.events.map(event => event.id)).toEqual(["open:memory-open"]);
		expect(analyzed.conversationPlanPendingEffects).toMatchObject([{ key: "insert:thread-a" }]);
		expect(analyzed.conversationPlanEffects).toBeUndefined();
		await setup.reopen();
		expect(setup.plan.conversationPlanPendingEffects).toMatchObject([{ key: "insert:thread-a" }]);
		processor = setup.start();
		processor.setEffects(setup.sink);
		await until(() => setup.plan.conversationPlanEffects.includes("insert:thread-a"));
		let delivered = await setup.saved();
		expect(delivered.conversationPlanPendingEffects).toBeUndefined();
		expect(delivered.conversationPlanEffects).toEqual(["insert:thread-a"]);
		expect(setup.calls).toEqual(["insert", "link"]);
		await setup.reopen();
		processor = setup.start();
		processor.setEffects(setup.sink);
		await Bun.sleep(10);
		expect(setup.plan.conversationPlanEffects).toEqual(["insert:thread-a"]);
		expect(setup.calls).toEqual(["insert", "link"]);
		expect(setup.errors).toEqual([]);
	} finally {
		await setup.close();
	}
});

test("real memory storage keeps failed inference and durable retry identity across open", async () => {
	let setup = await memoryProcessor();
	try {
		let processor = setup.start(async () => {
			throw new Error("injected interpreter failure");
		});
		await processor.accept(entry("memory-retry", "Which auth system?"));
		processor.afterMessage();
		await until(() => setup.publications.some(state => state.queue[0]?.status === "failed"));
		let failed = await setup.saved();
		expect(failed.conversationPlan.analysis[0]).toMatchObject({
			status: "failed",
			error: "Jev interpretation failed",
		});
		await setup.reopen();
		expect(setup.plan.conversationPlan.queue[0]?.status).toBe("failed");
		processor = setup.start(opening);
		await processor.retry("memory-retry-action", "memory-retry", { kind: "member", handle: "ana" });
		await until(() => setup.publications.some(state => state.analysis[0]?.status === "applied"));
		let retried = await setup.saved();
		expect(retried.conversationPlanRetries).toEqual([{
			id: "human:ana:memory-retry-action",
			messageId: "memory-retry",
		}]);
		expect(retried.conversationPlan.queue).toEqual([]);
		await setup.reopen();
		processor = setup.start();
		expect(
			await processor.retry("memory-retry-action", "memory-retry", {
				kind: "member",
				handle: "ana",
			}),
		).toEqual({ messageId: "memory-retry", queued: false });
		expect(setup.plan.conversationPlanRetries).toEqual(retried.conversationPlanRetries!);
	} finally {
		await setup.close();
	}
});
