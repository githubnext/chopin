import { expect, test } from "bun:test";
import { createProcessor } from "./service";
import { deferred, entry, harness, unlinked, until } from "./service.test-fixtures";
import type { ResearchInterpretation } from "./research-interpreter";

function result(
	messageId: string,
	status: "unlinked" | "failed" = "unlinked",
): ResearchInterpretation {
	return {
		analysis: {
			messageId,
			status,
			questionSetVersion: "conversation-research-1",
			modelVersion: "fixture",
			answers: {},
			policyGate: status === "failed" ? "research classification failed" : "no clear research need",
			latencyMs: 1,
		},
	};
}

test("research completes durably while decision analysis is still waiting", async () => {
	let waiting = deferred<ReturnType<typeof unlinked>>();
	let setup = harness(() => waiting.promise);
	setup.dependencies.researchInterpret = async input => result(input.message.id);
	let processor = createProcessor(setup.dependencies);
	await processor.accept(entry("one", "Investigate alternatives."));
	expect(setup.durable.state.queue).toHaveLength(1);
	expect(setup.durable.state.research?.queue).toHaveLength(1);
	processor.afterMessage();
	await until(() => setup.durable.state.research!.analysis.length === 1);
	expect(setup.durable.state.analysis).toHaveLength(0);
	waiting.resolve(unlinked());
	await processor.idle();
	expect(setup.durable.state.analysis).toHaveLength(1);
	processor.stop();
});

test("a failed research lane retries without rerunning completed decision work", async () => {
	let calls = 0;
	let attempts = 0;
	let setup = harness(async () => {
		calls++;
		return unlinked();
	});
	setup.dependencies.researchInterpret = async input =>
		result(input.message.id, attempts++ ? "unlinked" : "failed");
	let processor = createProcessor(setup.dependencies);
	await processor.accept(entry("one", "Investigate alternatives."));
	processor.afterMessage();
	await processor.idle();
	expect(setup.durable.state.research?.queue[0]?.status).toBe("failed");
	await processor.retryResearch("retry-1", "one", { kind: "member", handle: "ana" });
	await processor.idle();
	expect(calls).toBe(1);
	expect(attempts).toBe(2);
	expect(setup.durable.state.research?.queue).toEqual([]);
	await processor.retryResearch("retry-1", "one", { kind: "member", handle: "ana" });
	expect(attempts).toBe(2);
	processor.stop();
});
