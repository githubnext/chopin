import { expect, test } from "bun:test";
import type { HarnessV1 } from "@ai-sdk/harness";
import { createDocumentDevelopmentAgent } from "../harness/agents";

test("the private structured agent offers zero tools even with ambient harness capabilities", async () => {
	let observed: string[][] = [];
	let destroyed = 0;
	let fake: HarnessV1 = {
		specificationVersion: "harness-v1",
		harnessId: "development-fake",
		supportsBuiltinToolFiltering: true,
		supportsBuiltinToolApprovals: true,
		builtinTools: {
			bash: { description: "ambient shell", inputSchema: { type: "object" } },
		} as never,
		async doStart(start) {
			expect(start.builtinToolFiltering).toEqual({ mode: "allow", toolNames: [] });
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(turn) {
					observed.push(turn.tools.map(tool => tool.name));
					expect(turn.responseFormat).toMatchObject({ type: "json" });
					let done = Promise.withResolvers<void>();
					queueMicrotask(() => {
						turn.emit({ type: "text-start", id: "output" });
						turn.emit({
							type: "text-delta",
							id: "output",
							delta: JSON.stringify({ changes: [], removals: [] }),
						});
						turn.emit({ type: "text-end", id: "output" });
						turn.emit({
							type: "finish-step",
							finishReason: { unified: "stop", raw: undefined },
							usage: {
								inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
								outputTokens: { total: 0, text: 0, reasoning: 0 },
							},
						});
						done.resolve();
					});
					return { done: done.promise, async submitToolResult() {}, async submitToolApproval() {} };
				},
				async doDestroy() {
					destroyed++;
				},
				async doCompact() {},
				async doContinueTurn() {
					throw new Error("unused");
				},
				async doSuspendTurn() {
					throw new Error("unused");
				},
				async doDetach() {
					throw new Error("unused");
				},
				async doStop() {
					throw new Error("unused");
				},
			};
		},
	};
	let agent = createDocumentDevelopmentAgent(fake);
	let session = await agent.createSession({
		sandboxSession: {
			defaultWorkingDirectory: "/tmp",
			run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
			destroy: async () => {},
		} as never,
	});
	try {
		let result = await agent.generate({
			session,
			prompt: "material",
			options: { model: "fixture", instructions: "private development" },
		});
		expect(result.output).toEqual({ changes: [], removals: [] });
		expect(observed).toEqual([[]]);
	} finally {
		await session.destroy();
	}
	expect(destroyed).toBe(1);
});
