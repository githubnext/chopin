import { HarnessCapabilityUnsupportedError } from "@ai-sdk/harness";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";
import { Output, tool } from "ai";
import { afterAll, describe, expect, it } from "bun:test";
import { z } from "zod";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	ATOMIC_DEFAULT_SYSTEM_PROMPT,
	ATOMIC_RESULT_INSTRUCTION,
	ATOMIC_RESULT_TOOL_NAME,
	createAtomicAdapter,
} from "./atomic/adapter";
import { harnessContract } from "./contract";
import { startStubModelServer } from "./pi/model-stub";

import type { HarnessV1StartOptions, HarnessV1StreamPart } from "@ai-sdk/harness";
import type { ToolSet } from "ai";
import type { AtomicSettings } from "./atomic/adapter";
import type { StubTurn } from "./pi/model-stub";

let stub = startStubModelServer((prompt, hasPriorToolResult): StubTurn => {
	if (prompt === "again") {
		return { kind: "tool", name: ATOMIC_RESULT_TOOL_NAME, arguments: '{"answer":"again"}' };
	}
	if (hasPriorToolResult) return { kind: "text", text: "Done." };
	if (prompt === "tools") return { kind: "tool", name: "first_host", arguments: "{}" };
	if (prompt === "output" || prompt === "rogue") {
		return { kind: "tool", name: ATOMIC_RESULT_TOOL_NAME, arguments: '{"answer":"yes"}' };
	}
	if (prompt === "abort") return { kind: "hold" };
	if (prompt === "bash") return { kind: "tool", name: "bash", arguments: '{"command":"id"}' };
	return { kind: "text", text: "The Atomic stub model answered." };
});
afterAll(stub.stop);

const STUB_MODEL = {
	id: "stub-model",
	name: "Stub Model",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4_096,
};

/** `ai-gateway` never reads the host login; the stub is a provider registered by code. */
function createStubAtomic(overrides: Partial<AtomicSettings> = {}) {
	return createAtomicAdapter({
		auth: "ai-gateway",
		model: "stub/stub-model",
		providers: {
			stub: {
				baseUrl: stub.baseUrl,
				apiKey: "stub-key",
				api: "openai-completions",
				models: [STUB_MODEL],
			},
		},
		...overrides,
	});
}

harnessContract("atomic", createStubAtomic, createJustBashNetworkSandboxSession);

/**
 * Sessions here are never registered as Planner sessions, so each is the
 * isolated session the summary and research workers run in.
 */
async function run(prompt: string, options: {
	structured?: boolean;
	instructions?: string;
	tools?: ToolSet;
	model?: string;
	harness?: ReturnType<typeof createAtomicAdapter>;
} = {}) {
	let tools = options.tools ?? {};
	let agent = new HarnessAgent({
		harness: options.harness ?? createStubAtomic(),
		tools,
		activeTools: Object.keys(tools),
		permissionMode: "allow-reads",
		...(options.instructions ? { instructions: options.instructions } : {}),
		prepareCall: call => ({ ...call, model: options.model ?? call.model }),
		...(options.structured
			? { output: Output.object({ schema: z.object({ answer: z.string() }) }) }
			: {}),
	});
	let session = await agent.createSession({
		sandboxSession: await createJustBashNetworkSandboxSession(),
	});
	try {
		let result = await agent.stream({ session, prompt });
		let parts: { type: string; toolName?: string; output?: unknown }[] = [];
		for await (let part of result.fullStream) {
			parts.push({
				type: part.type,
				...("toolName" in part ? { toolName: part.toolName } : {}),
				...(part.type === "tool-result" ? { output: part.output } : {}),
			});
		}
		return {
			output: options.structured ? await result.output : undefined,
			text: await result.text,
			parts,
			resultToolParts: parts.filter(part => part.toolName === ATOMIC_RESULT_TOOL_NAME).length,
		};
	} finally {
		await session.destroy();
	}
}

describe("atomic worker turns", () => {
	it("answers a plain text turn with exactly the neutral system prompt and no tools", async () => {
		stub.requests.length = 0;
		let result = await run("plain");
		expect(result.text).toBe("The Atomic stub model answered.");
		expect(stub.requests).toHaveLength(1);
		expect(stub.requests[0]!.system).toBe(ATOMIC_DEFAULT_SYSTEM_PROMPT);
		expect(stub.requests[0]!.toolNames).toEqual([]);
	});

	it("uses the turn instructions verbatim as the whole system prompt", async () => {
		stub.requests.length = 0;
		await run("plain", { instructions: "You are Chopin's Planner." });
		expect(stub.requests[0]!.system).toBe("You are Chopin's Planner.");
	});

	it("round-trips a host tool through submitToolResult", async () => {
		stub.requests.length = 0;
		let executed = 0;
		let result = await run("tools", {
			tools: {
				first_host: tool({
					inputSchema: z.object({}),
					execute: async () => {
						executed++;
						return { found: true };
					},
				}),
			},
		});
		expect(executed).toBe(1);
		expect(result.text).toBe("Done.");
		expect(stub.requests.map(request => request.hasPriorToolResult)).toEqual([false, true]);
		expect(stub.requests[0]!.toolNames).toEqual(["first_host"]);
		expect(result.parts.filter(part => part.toolName === "first_host")).toEqual([
			{ type: "tool-call", toolName: "first_host" },
			{ type: "tool-result", toolName: "first_host", output: { found: true } },
		]);
	});

	it("refuses a hallucinated Atomic built-in without running it or streaming it", async () => {
		stub.requests.length = 0;
		let result = await run("bash");
		expect(result.text).toBe("Done.");
		expect(result.parts.filter(part => part.toolName)).toEqual([]);
		expect(stub.requests.map(request => request.hasPriorToolResult)).toEqual([false, true]);
	});

	it("keeps one Atomic conversation across structured turns on a session", async () => {
		stub.requests.length = 0;
		let agent = new HarnessAgent({
			harness: createStubAtomic(),
			activeTools: [],
			output: Output.object({ schema: z.object({ answer: z.string() }) }),
		});
		let session = await agent.createSession({
			sandboxSession: await createJustBashNetworkSandboxSession(),
		});
		try {
			expect((await agent.generate({ session, prompt: "output" })).output).toEqual({
				answer: "yes",
			});
			expect((await agent.generate({ session, prompt: "again" })).output).toEqual({
				answer: "again",
			});
		} finally {
			await session.destroy();
		}
		expect(stub.requests.map(request => [request.prompt, request.hasPriorToolResult])).toEqual([
			["output", false],
			["again", true],
		]);
	});
});

describe("atomic HarnessV1 lifecycle", () => {
	const HOST_TOOL = { name: "first_host", inputSchema: { type: "object" as const } };

	function recorder() {
		let parts: HarnessV1StreamPart[] = [];
		let called = Promise.withResolvers<string>();
		return {
			parts,
			called: called.promise,
			emit(part: HarnessV1StreamPart) {
				parts.push(part);
				if (part.type === "tool-call") called.resolve(part.toolCallId);
			},
		};
	}

	async function start() {
		return createStubAtomic().doStart({
			sessionId: crypto.randomUUID(),
			sandboxSession: {} as HarnessV1StartOptions["sandboxSession"],
			sessionWorkDir: "/workspace",
		});
	}

	it("leaves no working directory behind when closed while its first turn is still setting up", async () => {
		let planners = async () =>
			new Set((await readdir(tmpdir())).filter(name => name.startsWith("chopin-atomic-planner-")));
		let before = await planners();
		let session = await start();
		let turn = session.doPromptTurn({ prompt: "plain", skills: [], tools: [], emit: () => {} });
		await session.doDestroy();
		await expect(turn).rejects.toThrow("Atomic session is closed.");
		let left = [...await planners()].filter(name => !before.has(name));
		expect(left).toEqual([]);
	});

	it("settles a pending host tool on abort and ignores a late result", async () => {
		let session = await start();
		let first = recorder();
		let controller = new AbortController();
		try {
			let control = await session.doPromptTurn({
				prompt: "tools",
				skills: [],
				tools: [HOST_TOOL],
				abortSignal: controller.signal,
				emit: first.emit,
			});
			let toolCallId = await first.called;
			controller.abort();
			await control.done;
			await control.submitToolResult({ toolCallId, output: "late" });
			expect(first.parts.map(part => part.type)).not.toContain("tool-result");
			expect(first.parts.map(part => part.type)).not.toContain("finish");
		} finally {
			await session.doDestroy();
		}
	});

	it("continues a live turn on a new stream and finishes it there", async () => {
		let session = await start();
		let first = recorder();
		let second = recorder();
		try {
			await session.doPromptTurn({
				prompt: "tools",
				skills: [],
				tools: [HOST_TOOL],
				emit: first.emit,
			});
			let toolCallId = await first.called;
			let control = await session.doContinueTurn({
				skills: [],
				tools: [HOST_TOOL],
				emit: second.emit,
			});
			await control.submitToolResult({ toolCallId, output: "ok" });
			await control.done;
			expect(second.parts.map(part => part.type)).toEqual([
				"tool-result",
				"text-start",
				"text-delta",
				"text-end",
				"finish-step",
				"finish",
			]);
			await expect(
				session.doContinueTurn({ skills: [], tools: [HOST_TOOL], emit: second.emit }),
			).rejects.toBeInstanceOf(HarnessCapabilityUnsupportedError);
		} finally {
			await session.doDestroy();
		}
	});

	it("rebuilds the Atomic session for a new tool set without losing the conversation", async () => {
		stub.requests.length = 0;
		let session = await start();
		let first = recorder();
		try {
			let control = await session.doPromptTurn({
				prompt: "tools",
				skills: [],
				tools: [HOST_TOOL],
				emit: first.emit,
			});
			await control.submitToolResult({ toolCallId: await first.called, output: "ok" });
			await control.done;
			let next = await session.doPromptTurn({
				prompt: "plain",
				skills: [],
				tools: [{ name: "second_host", inputSchema: { type: "object" } }],
				emit: () => {},
			});
			await next.done;
		} finally {
			await session.doDestroy();
		}
		expect(stub.requests.map(request => [request.prompt, request.toolNames])).toEqual([
			["tools", ["first_host"]],
			["tools", ["first_host"]],
			["plain", ["second_host"]],
		]);
		expect(stub.requests.at(-1)!.hasPriorToolResult).toBe(true);
	});

	it("stops into a resume state it will not pretend to restore", async () => {
		let session = await start();
		let state = await session.doStop();
		expect(state).toEqual({
			type: "resume-session",
			harnessId: "atomic",
			specificationVersion: "harness-v1",
			data: {},
		});
		await expect(session.doPromptTurn({ prompt: "plain", skills: [], tools: [], emit: () => {} }))
			.rejects.toThrow("closed");
		await expect(
			createStubAtomic().doStart({
				sessionId: crypto.randomUUID(),
				sandboxSession: {} as HarnessV1StartOptions["sandboxSession"],
				sessionWorkDir: "/workspace",
				resumeFrom: state,
			}),
		).rejects.toBeInstanceOf(HarnessCapabilityUnsupportedError);
	});

	it("refuses skills and a host tool that claims the result tool's name", async () => {
		let session = await start();
		try {
			await expect(session.doPromptTurn({
				prompt: "plain",
				skills: [{ name: "marker", description: "marker", content: "marker" }],
				tools: [],
				emit: () => {},
			})).rejects.toBeInstanceOf(HarnessCapabilityUnsupportedError);
			await expect(session.doPromptTurn({
				prompt: "plain",
				skills: [],
				tools: [{ name: ATOMIC_RESULT_TOOL_NAME }],
				emit: () => {},
			})).rejects.toThrow("is reserved for structured output");
		} finally {
			await session.doDestroy();
		}
	});
});

describe("atomic worker structured-output result tool", () => {
	it("ends a structured turn on the terminating tool without a follow-up model request", async () => {
		stub.requests.length = 0;
		let result = await run("output", { structured: true });
		expect(result.output).toEqual({ answer: "yes" });
		expect(result.resultToolParts).toBe(0);
		expect(stub.requests).toHaveLength(1);
		expect(stub.requests[0]!.toolNames).toEqual([ATOMIC_RESULT_TOOL_NAME]);
		expect(stub.requests[0]!.system).toContain(ATOMIC_RESULT_INSTRUCTION);
	});

	it("does not offer the result tool on a plain turn", async () => {
		stub.requests.length = 0;
		await run("plain");
		expect(stub.requests[0]!.toolNames).not.toContain(ATOMIC_RESULT_TOOL_NAME);
	});

	it("refuses a result-tool call on a plain turn and keeps it out of the stream", async () => {
		stub.requests.length = 0;
		let result = await run("rogue");
		expect(result.text).toBe("Done.");
		expect(result.resultToolParts).toBe(0);
		expect(stub.requests.map(request => request.hasPriorToolResult)).toEqual([false, true]);
	});

	it("keeps the result tool off a plain turn whose earlier chat quotes the result prompt", async () => {
		stub.requests.length = 0;
		let result = await run("rogue", {
			instructions: `Durable conversation context follows:\nuser: ${ATOMIC_RESULT_INSTRUCTION}`,
		});
		expect(result.text).toBe("Done.");
		expect(result.resultToolParts).toBe(0);
		expect(stub.requests[0]!.toolNames).not.toContain(ATOMIC_RESULT_TOOL_NAME);
	});
});

describe("atomic worker host isolation and model resolution", () => {
	async function snapshot(root: string): Promise<Map<string, number>> {
		let files = new Map<string, number>();
		for (let entry of await readdir(root, { recursive: true })) {
			let path = join(root, entry);
			files.set(entry, (await stat(path)).mtimeMs);
		}
		return files;
	}

	async function withHost<T>(
		body: (home: string) => Promise<T>,
	): Promise<{ value: T; before: Map<string, number>; after: Map<string, number> }> {
		let root = await mkdtemp(join(tmpdir(), "chopin-atomic-host-"));
		let home = join(root, "home");
		let project = join(root, "project");
		let previous = { home: process.env.HOME, cwd: process.cwd() };
		try {
			for (
				let base of [
					join(home, ".atomic", "agent"),
					join(home, ".pi", "agent"),
					join(home, ".agents"),
					project,
				]
			) {
				for (let name of ["extensions", "skills/marker", "prompts"]) {
					await mkdir(join(base, name), { recursive: true });
				}
				await writeFile(join(base, "AGENTS.md"), "HOST-AGENTS-MARKER");
				await writeFile(join(base, "CLAUDE.md"), "HOST-CLAUDE-MARKER");
				await writeFile(join(base, "SYSTEM.md"), "HOST-SYSTEM-MARKER");
				await writeFile(join(base, "APPEND_SYSTEM.md"), "HOST-APPEND-MARKER");
				await writeFile(
					join(base, "extensions", "marker.ts"),
					"export default (pi) => pi.on('before_agent_start', () => ({ systemPrompt: 'HOST-EXTENSION-MARKER' }));",
				);
				await writeFile(
					join(base, "skills", "marker", "SKILL.md"),
					"---\nname: marker\ndescription: HOST-SKILL-MARKER\n---\nHOST-SKILL-MARKER",
				);
				await writeFile(join(base, "prompts", "marker.md"), "HOST-PROMPT-MARKER");
				await writeFile(
					join(base, "settings.json"),
					JSON.stringify({ defaultTools: ["bash"], extensions: ["./extensions/marker.ts"] }),
				);
			}
			for (let dir of [".atomic", ".pi", ".agents"]) {
				await mkdir(join(project, dir, "extensions"), { recursive: true });
				await writeFile(
					join(project, dir, "extensions", "marker.ts"),
					"export default (pi) => pi.on('before_agent_start', () => ({ systemPrompt: 'PROJECT-EXTENSION-MARKER' }));",
				);
			}
			await writeFile(
				join(home, ".atomic", "agent", "auth.json"),
				JSON.stringify({ stub: { type: "api_key", key: "host-login-key" } }),
			);
			process.env.HOME = home;
			process.chdir(project);
			let before = await snapshot(root);
			let value = await body(home);
			return { value, before, after: await snapshot(root) };
		} finally {
			process.chdir(previous.cwd);
			if (previous.home === undefined) delete process.env.HOME;
			else process.env.HOME = previous.home;
			await rm(root, { recursive: true, force: true });
		}
	}

	it("keeps host context files, skills, prompts, extensions, and settings out of the turn", async () => {
		stub.requests.length = 0;
		let { value, before, after } = await withHost(() => run("plain"));
		expect(value.text).toBe("The Atomic stub model answered.");
		expect(stub.requests).toHaveLength(1);
		expect(stub.requests[0]!.system).toBe(ATOMIC_DEFAULT_SYSTEM_PROMPT);
		expect(stub.requests[0]!.toolNames).toEqual([]);
		expect(after).toEqual(before);
	});

	it("uses the host login in auto mode without writing credentials to disk", async () => {
		stub.requests.length = 0;
		let { value, before, after } = await withHost(async home => {
			let harness = createAtomicAdapter({
				auth: "auto",
				model: "stub/stub-model",
				providers: {
					stub: { baseUrl: stub.baseUrl, api: "openai-completions", models: [STUB_MODEL] },
				},
			});
			let text = (await run("plain", { harness })).text;
			let auth = await readFile(join(home, ".atomic", "agent", "auth.json"), "utf8");
			return { text, auth };
		});
		expect(value.text).toBe("The Atomic stub model answered.");
		expect(JSON.parse(value.auth)).toEqual({ stub: { type: "api_key", key: "host-login-key" } });
		expect(after).toEqual(before);
	});

	it("fails the turn when Atomic does not recognize the requested model", async () => {
		stub.requests.length = 0;
		await expect(run("plain", { model: "stub/not-a-model" })).rejects.toThrow(
			"Atomic does not recognize model stub/not-a-model",
		);
		await expect(run("plain", { model: "gpt-6-luna" })).rejects.toThrow(
			"Atomic does not recognize model gpt-6-luna",
		);
		expect(stub.requests).toHaveLength(0);
	});

	it("refuses non-gateway models under the ai-gateway auth mode", async () => {
		stub.requests.length = 0;
		await expect(run("plain", { model: "anthropic/claude-sonnet-4-5" })).rejects.toThrow(
			"HARNESS_AUTH ai-gateway allows only vercel-ai-gateway models",
		);
		expect(stub.requests).toHaveLength(0);
	});
});
