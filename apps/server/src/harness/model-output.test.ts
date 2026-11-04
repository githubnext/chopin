import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createJustBashNetworkSandboxSession } from "@ai-sdk/sandbox-just-bash";
import { tool } from "ai";
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";

import { type DocumentRoom, documentTools } from "../agent/tools";
import { readingOutput } from "../agent/reading-output";
import { READ_BYTES } from "../document-reading";
import { ATOMIC_KEEPS, atomicShows, fieldNotes, reading } from "../document-reading.test-fixtures";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import { startStubModelServer } from "./atomic/model-stub";
import { createAtomicAdapter } from "./atomic/adapter";
import { createCopilotSdk } from "./copilot-sdk/adapter";
import { harnesses } from "./harnesses";
import { withModelOutput } from "./model-output";

import type { HarnessV1, HarnessV1PromptControl } from "@ai-sdk/harness";
import type { RuntimeClient, RuntimeSource } from "./copilot-sdk/runtime";

type CopilotTool = { name: string; handler?: (args: unknown, call: unknown) => unknown };

let plans: Awaited<ReturnType<typeof Service.open>>[] = [];
afterEach(async () => {
	for (let plan of plans.splice(0)) await Service.close(plan);
});

let source = fieldNotes(170_000);
let sandboxSession = {
	defaultWorkingDirectory: "/tmp",
	async run() {
		return { exitCode: 0, stdout: "", stderr: "" };
	},
	async destroy() {},
} as never;

async function largeRoom(): Promise<DocumentRoom> {
	let fixture = await openPlan(source);
	plans.push(fixture.plan);
	return {
		id: fixture.plan.id,
		plan: fixture.plan,
		server: fixture.server,
		persist: () => Service.persist(fixture.plan),
		exclusive: action => Service.exclusive(fixture.plan, action),
		publish: async () => {},
		anchors: () => {},
		changes: () => {},
	};
}

/** The Planner's own `read_plan` tool, run by the agent harness against `harness`. */
function readerOn(harness: HarnessV1, room: DocumentRoom) {
	return new HarnessAgent({
		harness,
		tools: { read_plan: documentTools.read_plan },
		activeTools: ["read_plan"],
		toolsContext: { read_plan: { room } },
		permissionMode: "allow-reads",
	});
}

async function runTurn(agent: ReturnType<typeof readerOn>, prompt: string) {
	let session = await agent.createSession({ sandboxSession });
	try {
		let result = await agent.stream({ session, prompt });
		let parts: Array<{ type: string; [key: string]: unknown }> = [];
		for await (let part of result.fullStream) parts.push(part as never);
		return parts;
	} finally {
		await session.destroy();
	}
}

function checkModelSaw(shown: string, room: DocumentRoom) {
	let read = reading(shown);
	expect(shown).not.toStartWith("{");
	expect(shown.split("\n").length).toBeGreaterThan(100);
	expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(READ_BYTES);
	expect(atomicShows(shown)).toBe(shown);
	expect(read.fields.document).toBe(room.id);
	expect(read.outline[0]).toBe("L1 # Quarterly field notes");
	expect(read.next).toEqual({ offset: read.range[1] + 1 });
	expect(Room.project(room.plan.document).startsWith(read.source)).toBe(true);
}

describe("withModelOutput", () => {
	function recording(calls: Array<{ toolName: string; input: string }>) {
		let submissions: Array<{ toolCallId: string; output: unknown; isError?: boolean }> = [];
		let harness: HarnessV1 = {
			specificationVersion: "harness-v1",
			harnessId: "recording",
			builtinTools: {},
			async doStart(start) {
				let control = (): HarnessV1PromptControl => ({
					done: Promise.resolve(),
					async submitToolResult(value) {
						submissions.push(value);
					},
				});
				return {
					sessionId: start.sessionId,
					isResume: false,
					async doPromptTurn(turn) {
						for (let [index, call] of calls.entries()) {
							turn.emit({ type: "tool-call", toolCallId: `call-${index}`, ...call });
						}
						return control();
					},
					async doContinueTurn(turn) {
						turn.emit({
							type: "tool-call",
							toolCallId: "again",
							toolName: "read_plan",
							input: "{}",
						});
						return control();
					},
					async doDestroy() {},
					async doCompact() {},
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
		return { harness, submissions };
	}

	let session = (harness: HarnessV1) =>
		harness.doStart({ sessionId: "s", sandboxSession, sessionWorkDir: "/tmp" } as never);

	it("converts only the named tool's successful result, with the input it was called with", async () => {
		let { harness, submissions } = recording([
			{ toolName: "read_plan", input: '{"offset":2}' },
			{ toolName: "edit_plan", input: "{}" },
			{ toolName: "read_plan", input: "{}" },
			{ toolName: "read_plan", input: "not json" },
		]);
		let seen: unknown[] = [];
		let wrapped = withModelOutput(harness, ({ toolName, input, output }) => {
			seen.push([toolName, input]);
			if (toolName === "read_plan" && output === "throws") throw new Error("boom");
			return toolName === "read_plan" ? `text of ${output}` : undefined;
		});
		let opened = await session(wrapped);
		let control = await opened.doPromptTurn({
			prompt: "go",
			tools: [],
			skills: [],
			emit: () => {},
		} as never);
		let errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			await control.submitToolResult({ toolCallId: "call-0", output: "{}" });
			await control.submitToolResult({ toolCallId: "call-1", output: "{}" });
			await control.submitToolResult({
				toolCallId: "call-2",
				output: "Error: stale",
				isError: true,
			});
			await control.submitToolResult({ toolCallId: "call-3", output: "throws" });
			await control.submitToolResult({ toolCallId: "unknown", output: "left alone" });
		} finally {
			errors.mockRestore();
		}
		expect(submissions.map(item => item.output)).toEqual([
			"text of {}",
			"{}",
			"Error: stale",
			"throws",
			"left alone",
		]);
		expect(seen).toEqual([["read_plan", { offset: 2 }], ["edit_plan", {}], [
			"read_plan",
			undefined,
		]]);
	});

	it("also converts a continued turn's results and keeps the harness's own fields", async () => {
		let { harness, submissions } = recording([]);
		let wrapped = withModelOutput(
			{ ...harness, supportsBuiltinToolFiltering: true, shutdown: async () => {} },
			({ output }) => `text of ${output}`,
		);
		expect(wrapped.harnessId).toBe("recording");
		expect(wrapped.supportsBuiltinToolFiltering).toBe(true);
		expect(typeof wrapped.shutdown).toBe("function");
		let opened = await session(wrapped);
		let control = await opened.doContinueTurn({ emit: () => {} } as never);
		await control.submitToolResult({ toolCallId: "again", output: "{}" });
		expect(submissions.map(item => item.output)).toEqual(["text of {}"]);
		expect(opened.sessionId).toBe("s");
	});
});

describe("a model run by a real harness reads read_plan as text", () => {
	it(
		"through the agent harness: the structured result is converted on its way to the runtime",
		async () => {
			let room = await largeRoom();
			let { harness, submissions } = (() => {
				let submitted: Array<{ output: unknown }> = [];
				let inner: HarnessV1 = {
					specificationVersion: "harness-v1",
					harnessId: "recording",
					builtinTools: {},
					async doStart(start) {
						return {
							sessionId: start.sessionId,
							isResume: false,
							async doPromptTurn(turn) {
								let done = Promise.withResolvers<void>();
								queueMicrotask(() =>
									turn.emit({
										type: "tool-call",
										toolCallId: "r1",
										toolName: "read_plan",
										input: "{}",
									})
								);
								return {
									done: done.promise,
									async submitToolResult(value) {
										submitted.push(value);
										turn.emit({ type: "text-start", id: "a" });
										turn.emit({ type: "text-delta", id: "a", delta: "Read." });
										turn.emit({ type: "text-end", id: "a" });
										turn.emit({
											type: "finish-step",
											finishReason: { unified: "stop", raw: undefined },
											usage: {
												inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
												outputTokens: { total: 0, text: 0, reasoning: 0 },
											},
										});
										done.resolve();
									},
								};
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
				return { harness: withModelOutput(inner, readingOutput), submissions: submitted };
			})();
			await runTurn(readerOn(harness, room), "read");
			expect(submissions).toHaveLength(1);
			checkModelSaw(submissions[0]!.output as string, room);
		},
		60_000,
	);

	describe("the Copilot SDK", () => {
		function runtime(returned: unknown[]): RuntimeSource {
			let client = {
				async start() {},
				async stop() {
					return [];
				},
				async forceStop() {},
				async createSession(config: { tools?: CopilotTool[] }) {
					let listeners = new Set<(event: unknown) => void>();
					let tools = config.tools ?? [];
					return {
						sessionId: "copilot-1",
						config,
						rpc: {
							tools: {
								async initializeAndValidate() {
									return {};
								},
								async getCurrentMetadata() {
									return {
										tools: tools.map(item => ({
											name: item.name,
											namespacedName: `custom:${item.name}`,
										})),
									};
								},
							},
							mcp: {
								async list() {
									return { servers: [] };
								},
								async listTools() {
									return { tools: [] };
								},
							},
						},
						on(handler: (event: unknown) => void) {
							listeners.add(handler);
							return () => listeners.delete(handler);
						},
						async send() {
							let read = tools.find(item => item.name === "read_plan")!;
							returned.push(
								await read.handler!({}, {
									toolCallId: "t1",
									toolName: "read_plan",
									arguments: {},
									sessionId: "copilot-1",
								}),
							);
							for (let listener of listeners) listener({ type: "session.idle", data: {} });
						},
						async abort() {},
						async disconnect() {},
					};
				},
				async deleteSession() {},
			};
			return { client: client as unknown as RuntimeClient, cleanup: () => {} };
		}

		it(
			"hands the SDK, which shows it to the model, the text the production harness makes",
			async () => {
				let room = await largeRoom();
				let returned: unknown[] = [];
				let harness = harnesses["copilot-sdk"]({
					credentials: () => "ghu_test",
					limits: () => undefined,
					connect: () => runtime(returned),
				});
				await runTurn(readerOn(harness, room), "read");
				await harness.shutdown();
				expect(returned).toHaveLength(1);
				checkModelSaw(returned[0] as string, room);

				let unconverted: unknown[] = [];
				let raw = createCopilotSdk({
					credentials: () => "ghu_test",
					connect: () => runtime(unconverted),
				});
				await runTurn(readerOn(raw, room), "read");
				await raw.shutdown();
				expect(String(unconverted[0])).toStartWith("{");
				expect(Buffer.byteLength(String(unconverted[0]))).toBeGreaterThan(ATOMIC_KEEPS);
			},
			60_000,
		);
	});

	describe("Atomic", () => {
		let stub = startStubModelServer((_prompt, hasPriorToolResult) =>
			hasPriorToolResult
				? { kind: "text", text: "Done." }
				: { kind: "tool", name: "read_plan", arguments: "{}" }
		);
		afterAll(stub.stop);

		let atomic = () =>
			createAtomicAdapter({
				auth: "ai-gateway",
				model: "stub/stub-model",
				providers: {
					stub: {
						baseUrl: stub.baseUrl,
						apiKey: "stub-key",
						api: "openai-completions",
						models: [{
							id: "stub-model",
							name: "Stub Model",
							reasoning: false,
							input: ["text" as const],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128_000,
							maxTokens: 4_096,
						}],
					},
				},
			});

		it("puts the text, not the JSON view, in the request its model answers", async () => {
			let room = await largeRoom();
			stub.requests.length = 0;
			let converted = withModelOutput(atomic(), readingOutput);
			let agent = new HarnessAgent({
				harness: converted,
				tools: { read_plan: documentTools.read_plan },
				activeTools: ["read_plan"],
				toolsContext: { read_plan: { room } },
				permissionMode: "allow-reads",
			});
			let session = await agent.createSession({
				sandboxSession: await createJustBashNetworkSandboxSession(),
			});
			try {
				let result = await agent.stream({ session, prompt: "read" });
				for await (let _part of result.fullStream) {}
			} finally {
				await session.destroy();
			}
			let seen = stub.requests.at(-1)!.toolResults;
			expect(seen).toHaveLength(1);
			checkModelSaw(seen[0]!, room);

			stub.requests.length = 0;
			let rawAgent = new HarnessAgent({
				harness: atomic(),
				tools: { read_plan: documentTools.read_plan },
				activeTools: ["read_plan"],
				toolsContext: { read_plan: { room } },
				permissionMode: "allow-reads",
			});
			let rawSession = await rawAgent.createSession({
				sandboxSession: await createJustBashNetworkSandboxSession(),
			});
			try {
				let result = await rawAgent.stream({ session: rawSession, prompt: "read" });
				for await (let _part of result.fullStream) {}
			} finally {
				await rawSession.destroy();
			}
			expect(stub.requests.at(-1)!.toolResults[0]).toStartWith("{");
			expect(stub.requests.at(-1)!.toolResults[0]!.length).toBeGreaterThan(ATOMIC_KEEPS);
		}, 90_000);
	});
});

it("leaves every other host tool's result as the tool returned it", async () => {
	let submitted: unknown[] = [];
	let inner: HarnessV1 = {
		specificationVersion: "harness-v1",
		harnessId: "recording",
		builtinTools: {},
		async doStart(start) {
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(turn) {
					let done = Promise.withResolvers<void>();
					queueMicrotask(() =>
						turn.emit({ type: "tool-call", toolCallId: "e1", toolName: "echo", input: "{}" })
					);
					return {
						done: done.promise,
						async submitToolResult(value) {
							submitted.push(value.output);
							turn.emit({
								type: "finish-step",
								finishReason: { unified: "stop", raw: undefined },
								usage: {
									inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
									outputTokens: { total: 0, text: 0, reasoning: 0 },
								},
							});
							done.resolve();
						},
					};
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
	let agent = new HarnessAgent({
		harness: withModelOutput(inner, readingOutput),
		tools: { echo: tool({ inputSchema: z.object({}), execute: async () => '{"revision": 3}' }) },
		activeTools: ["echo"],
		permissionMode: "allow-reads",
	});
	let session = await agent.createSession({ sandboxSession });
	try {
		let result = await agent.stream({ session, prompt: "echo" });
		for await (let _part of result.fullStream) {}
	} finally {
		await session.destroy();
	}
	expect(submitted).toEqual(['{"revision": 3}']);
});
