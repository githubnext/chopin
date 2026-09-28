import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function createStubPi() {
	return createPiAdapter({
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
	});
}

harnessContract("pi", createStubPi, createJustBashNetworkSandboxSession);

describe("pi host isolation and model resolution", () => {
	async function turn(options: { model: string; workingDirectory?: string }) {
		let sandbox = await createJustBashNetworkSandboxSession();
		let sandboxSession = options.workingDirectory
			? new Proxy(sandbox, {
				get: (target, key, receiver) =>
					key === "defaultWorkingDirectory"
						? options.workingDirectory
						: Reflect.get(target, key, receiver),
			})
			: sandbox;
		let agent = new HarnessAgent({
			harness: createStubPi(),
			activeTools: [],
			prepareCall: call => ({ ...call, model: options.model }),
		});
		let session = await agent.createSession({ sandboxSession });
		try {
			let result = await agent.generate({ session, prompt: "plain" });
			return result.text;
		} finally {
			await session.destroy();
		}
	}

	it("keeps host AGENTS.md files out of Pi's system prompt", async () => {
		let directory = await mkdtemp(join(tmpdir(), "chopin-pi-agents-"));
		try {
			await writeFile(join(directory, "AGENTS.md"), "HOST-INSTRUCTION-MARKER");
			stub.requests.length = 0;
			expect(await turn({ model: "stub/stub-model", workingDirectory: directory }))
				.toBe("The Pi stub model answered.");
			expect(stub.requests).toHaveLength(1);
			expect(stub.requests[0]!.system).not.toContain("HOST-INSTRUCTION-MARKER");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("fails the turn when Pi does not recognize the requested model", async () => {
		stub.requests.length = 0;
		await expect(turn({ model: "gpt-6-luna" })).rejects.toThrow(
			"Pi does not recognize model gpt-6-luna",
		);
		expect(stub.requests).toHaveLength(0);
	});
});
