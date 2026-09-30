import { createPlannerAgent } from "../harness/agents";
import type { HarnessV1 } from "@ai-sdk/harness";
import type { toolbox } from "./scoped-tools.test-bridge";

let offered: string[] = [];
let fake: HarnessV1 = {
	specificationVersion: "harness-v1",
	harnessId: "scoped-metadata",
	builtinTools: {},
	async doStart(start) {
		return {
			sessionId: start.sessionId,
			isResume: false,
			async doPromptTurn(turn) {
				offered = turn.tools.map(spec => spec.name);
				queueMicrotask(() =>
					turn.emit({
						type: "finish-step",
						finishReason: { unified: "stop", raw: undefined },
						usage: {
							inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
							outputTokens: { total: 0, text: 0, reasoning: 0 },
						},
					})
				);
				return { done: Promise.resolve(), async submitToolResult() {} };
			},
			async doDestroy() {},
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
let agent = createPlannerAgent(fake);
let session = await agent.createSession({
	sessionId: "scoped-metadata",
	sandboxSession: {
		defaultWorkingDirectory: "/tmp",
		async run() {
			return { exitCode: 0, stdout: "", stderr: "" };
		},
		async destroy() {},
	} as never,
});
try {
	let result = await agent.stream({
		session,
		prompt: "Observe tool registration",
		options: {
			room: { id: "metadata", plan: { chat: {} } } as never,
			repository: {} as never,
			owner: {} as never,
			githubTools: {},
			instructions: "Observe only",
		},
	});
	for await (let _part of result.fullStream) {}
} finally {
	await session.destroy();
}

/** Legacy assertion shape, derived only from a real current Harness turn's offered tools. */
export function plannerConfiguration(
	_config: { model: string },
	options: { tools: ReturnType<typeof toolbox> },
	_owner: unknown,
) {
	return {
		availableTools: offered.length ? ["custom:*"] : [],
		tools: options.tools.filter(value => offered.includes(value.name)).map(value => ({
			...value,
			skipPermission: agent.tools[value.name]?.metadata?.skipPermission === true,
		})),
	};
}
