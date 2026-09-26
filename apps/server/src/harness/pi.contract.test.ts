import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";
import { Output } from "ai";
import { afterAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { harnessContract } from "./contract";
import { createPiAdapter, PI_RESULT_TOOL_NAME } from "./pi/adapter";
import { startStubModelServer } from "./pi/model-stub";

import type { StubTurn } from "./pi/model-stub";

let stub = startStubModelServer((prompt, hasPriorToolResult): StubTurn => {
	if (hasPriorToolResult) return { kind: "text", text: "Done." };
	if (prompt === "output" || prompt === "rogue") {
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

describe("pi structured-output result tool", () => {
	async function run(
		prompt: string,
		options: { structured: boolean },
	): Promise<{ output?: unknown; text: string; resultToolParts: number }> {
		let agent = new HarnessAgent({
			harness: createStubPi(),
			activeTools: [],
			...(options.structured
				? { output: Output.object({ schema: z.object({ answer: z.string() }) }) }
				: {}),
		});
		let session = await agent.createSession({
			sandboxSession: await createJustBashNetworkSandboxSession(),
		});
		try {
			let result = await agent.stream({ session, prompt });
			let resultToolParts = 0;
			for await (let part of result.fullStream) {
				if ("toolName" in part && part.toolName === PI_RESULT_TOOL_NAME) resultToolParts++;
			}
			return {
				output: options.structured ? await result.output : undefined,
				text: await result.text,
				resultToolParts,
			};
		} finally {
			await session.destroy();
		}
	}

	it("ends a structured turn on the terminating tool without a follow-up model request", async () => {
		stub.requests.length = 0;
		let result = await run("output", { structured: true });
		expect(result.output).toEqual({ answer: "yes" });
		expect(result.resultToolParts).toBe(0);
		let requests = stub.requests.filter(request => request.prompt === "output");
		expect(requests).toHaveLength(1);
		expect(requests[0]!.toolNames).toContain(PI_RESULT_TOOL_NAME);
	});

	it("does not offer the result tool on a plain turn", async () => {
		stub.requests.length = 0;
		let result = await run("plain", { structured: false });
		expect(result.text).toBe("The Pi stub model answered.");
		let requests = stub.requests.filter(request => request.prompt === "plain");
		expect(requests).toHaveLength(1);
		expect(requests[0]!.toolNames).not.toContain(PI_RESULT_TOOL_NAME);
	});

	it("blocks a result-tool call on a plain turn and keeps it out of the stream", async () => {
		stub.requests.length = 0;
		let result = await run("rogue", { structured: false });
		expect(result.text).toBe("Done.");
		expect(result.resultToolParts).toBe(0);
		let requests = stub.requests.filter(request => request.prompt === "rogue");
		expect(requests.map(request => request.hasPriorToolResult)).toEqual([false, true]);
	});
});

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
