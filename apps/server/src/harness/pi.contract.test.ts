import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";
import { afterAll } from "bun:test";

import { harnessContract } from "./contract";
import { createPiAdapter, PI_RESULT_TOOL_NAME } from "./pi/adapter";
import { startStubModelServer } from "./pi/model-stub";

import type { StubTurn } from "./pi/model-stub";

let stub = startStubModelServer((prompt, hasPriorToolResult): StubTurn => {
	if (hasPriorToolResult) return { kind: "text", text: "Done." };
	if (prompt === "output") {
		return { kind: "tool", name: PI_RESULT_TOOL_NAME, arguments: '{"answer":"yes"}' };
	}
	if (prompt === "abort") return { kind: "hold" };
	return { kind: "text", text: "The Pi stub model answered." };
});
afterAll(stub.stop);

harnessContract(
	"pi",
	() =>
		createPiAdapter({
			auth: {},
			providers: {
				stub: {
					baseUrl: stub.baseUrl,
					apiKey: "stub-key",
					api: "openai-completions",
					models: [{
						id: "stub-model",
						name: "Stub Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 4_096,
					}],
				},
			},
		}),
	createJustBashNetworkSandboxSession,
);
