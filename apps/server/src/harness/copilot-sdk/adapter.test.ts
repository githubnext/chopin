import { describe, expect, it } from "bun:test";

import { harnessContract } from "../contract";
import { createCopilotSdk, MissingCredentialsError, ToolMetadataMismatchError } from "./adapter";

import type { CurrentToolMetadata, SessionConfig, Tool } from "@github/copilot-sdk";
import type { RuntimeClient, RuntimeSource } from "./runtime";

type Listener = (event: unknown) => void;

type FakeSession = {
	sessionId: string;
	config: SessionConfig;
	rpc: {
		tools: {
			initializeAndValidate: () => Promise<unknown>;
			getCurrentMetadata: () => Promise<{ tools: CurrentToolMetadata[] }>;
		};
		mcp: {
			list: () => Promise<{ servers: { name: string }[] }>;
			listTools: () => Promise<{ tools: unknown[] }>;
		};
	};
	on: (handler: Listener) => () => void;
	send: (input: { prompt: string }) => Promise<void>;
	abort: () => Promise<void>;
	disconnect: () => Promise<void>;
};

function metadataFor(tools: Tool[]): CurrentToolMetadata[] {
	return tools.map(tool => ({
		name: tool.name,
		namespacedName: `custom:${tool.name}`,
	} as CurrentToolMetadata));
}

function toolCall(name: string): Parameters<NonNullable<Tool["handler"]>>[1] {
	return {
		toolCallId: crypto.randomUUID(),
		toolName: name,
		arguments: {},
		sessionId: "call-session",
	};
}

function fakeSession(
	config: SessionConfig,
	sessionId: string,
	overrides: {
		metadata?: (tools: Tool[]) => CurrentToolMetadata[];
		servers?: { name: string }[];
	} = {},
): FakeSession {
	let listeners = new Set<Listener>();
	let emit = (event: unknown) => {
		for (let listener of listeners) listener(event);
	};
	let tools = config.tools ?? [];
	return {
		sessionId,
		config,
		rpc: {
			tools: {
				async initializeAndValidate() {
					return {};
				},
				async getCurrentMetadata() {
					return { tools: (overrides.metadata ?? metadataFor)(tools) };
				},
			},
			mcp: {
				async list() {
					return { servers: overrides.servers ?? [] };
				},
				async listTools() {
					return { tools: [] };
				},
			},
		},
		on(handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		async send({ prompt }) {
			if (prompt === "tools") {
				let target = tools.find(tool => !tool.isTerminal)!;
				await target.handler!({}, toolCall(target.name));
				emit({ type: "assistant.message", data: { messageId: "m1", content: "done" } });
				emit({ type: "session.idle", data: {} });
			} else if (prompt === "output") {
				let target = tools.find(tool => tool.isTerminal)!;
				await target.handler!({ answer: "yes" }, toolCall(target.name));
				emit({ type: "session.idle", data: {} });
			} else if (prompt === "abort") {
				// Never resolves on its own; only the adapter's own abort handling ends the turn.
			} else if (prompt === "pending-tool-then-abort") {
				let target = tools.find(tool => !tool.isTerminal)!;
				// Fire-and-forget: this host tool call is left in flight when the turn aborts. The
				// adapter's own abort path resolves it as an error, which the handler then throws;
				// that rejection is expected here and must not become an unhandled rejection.
				Promise.resolve(target.handler!({}, toolCall(target.name))).catch(() => {});
			} else {
				emit({ type: "assistant.message", data: { messageId: "m0", content: prompt } });
				emit({ type: "session.idle", data: {} });
			}
		},
		async abort() {},
		async disconnect() {},
	};
}

function stubRuntimeSource(
	overrides: Parameters<typeof fakeSession>[2] = {},
): RuntimeSource & { sessions: FakeSession[] } {
	let sessions: FakeSession[] = [];
	let counter = 0;
	let client: RuntimeClient = {
		async start() {},
		async stop() {
			return [];
		},
		async forceStop() {},
		async createSession(config: SessionConfig) {
			let session = fakeSession(config, `session-${++counter}`, overrides);
			sessions.push(session);
			return session as unknown as Parameters<RuntimeClient["createSession"]>[0] extends never
				? never
				: Awaited<ReturnType<RuntimeClient["createSession"]>>;
		},
		async deleteSession() {},
	};
	return { client, cleanup: () => {}, sessions };
}

harnessContract("copilot-sdk", () =>
	createCopilotSdk({
		credentials: () => "ghu_test",
		connect: stubRuntimeSource,
	}));

describe("copilot-sdk adapter", () => {
	it("requires a token from the per-session credentials resolver", async () => {
		let harness = createCopilotSdk({ credentials: () => undefined, connect: stubRuntimeSource });
		let session = await harness.doStart({
			sessionId: "s1",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		await expect(
			session.doPromptTurn({
				prompt: "tools",
				tools: [],
				skills: [],
				emit: () => {},
			}),
		).rejects.toThrow(MissingCredentialsError);
	});

	it("fails closed when the live session reports an extra tool", async () => {
		let harness = createCopilotSdk({
			credentials: () => "ghu_test",
			connect: () =>
				stubRuntimeSource({
					metadata: tools => [
						...metadataFor(tools),
						{ name: "leaked", namespacedName: "builtin:leaked" } as CurrentToolMetadata,
					],
				}),
		});
		let session = await harness.doStart({
			sessionId: "s1",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		await expect(
			session.doPromptTurn({
				prompt: "tools",
				tools: [{ name: "read_plan" }],
				skills: [],
				emit: () => {},
			}),
		).rejects.toThrow(ToolMetadataMismatchError);
	});

	it("fails closed when the live session reports an MCP tool alias", async () => {
		let harness = createCopilotSdk({
			credentials: () => "ghu_test",
			connect: () =>
				stubRuntimeSource({
					metadata: tools =>
						tools.map(tool => ({
							name: tool.name,
							namespacedName: `custom:${tool.name}`,
							mcpServerName: "github",
							mcpToolName: tool.name,
						} as CurrentToolMetadata)),
				}),
		});
		let session = await harness.doStart({
			sessionId: "s1",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		await expect(
			session.doPromptTurn({
				prompt: "tools",
				tools: [{ name: "read_plan" }],
				skills: [],
				emit: () => {},
			}),
		).rejects.toThrow(ToolMetadataMismatchError);
	});

	it("accepts Copilot's live host metadata without a namespace alias", async () => {
		let harness = createCopilotSdk({
			credentials: () => "ghu_test",
			connect: () =>
				stubRuntimeSource({
					metadata: tools => tools.map(tool => ({ name: tool.name } as CurrentToolMetadata)),
				}),
		});
		let session = await harness.doStart({
			sessionId: "s1",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		let control = await session.doPromptTurn({
			prompt: "hello",
			tools: [{ name: "read_plan" }],
			skills: [],
			emit: () => {},
		});
		await control.done;
		await session.doDestroy();
	});

	it("rejects a same-named builtin alias instead of treating it as a host tool", async () => {
		let harness = createCopilotSdk({
			credentials: () => "ghu_test",
			connect: () =>
				stubRuntimeSource({
					metadata: tools =>
						tools.map(tool => ({
							name: tool.name,
							namespacedName: `builtin:${tool.name}`,
						} as CurrentToolMetadata)),
				}),
		});
		let session = await harness.doStart({
			sessionId: "s1",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		await expect(session.doPromptTurn({
			prompt: "hello",
			tools: [{ name: "read_plan" }],
			skills: [],
			emit: () => {},
		})).rejects.toThrow(ToolMetadataMismatchError);
	});

	it("rejects duplicate metadata in place of another host tool", async () => {
		let harness = createCopilotSdk({
			credentials: () => "ghu_test",
			connect: () =>
				stubRuntimeSource({
					metadata: () => [
						{ name: "read_plan" } as CurrentToolMetadata,
						{ name: "read_plan" } as CurrentToolMetadata,
					],
				}),
		});
		let session = await harness.doStart({
			sessionId: "s1",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		await expect(session.doPromptTurn({
			prompt: "hello",
			tools: [{ name: "read_plan" }, { name: "read_reference" }],
			skills: [],
			emit: () => {},
		})).rejects.toThrow(ToolMetadataMismatchError);
	});

	it("fails closed when the live session reports a connected MCP server", async () => {
		let harness = createCopilotSdk({
			credentials: () => "ghu_test",
			connect: () => stubRuntimeSource({ servers: [{ name: "github" }] }),
		});
		let session = await harness.doStart({
			sessionId: "s1",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		await expect(
			session.doPromptTurn({
				prompt: "tools",
				tools: [{ name: "read_plan" }],
				skills: [],
				emit: () => {},
			}),
		).rejects.toThrow(ToolMetadataMismatchError);
	});

	it("sets the session's tools and availableTools to exactly the host names, plus the result tool", async () => {
		let source = stubRuntimeSource();
		let harness = createCopilotSdk({ credentials: () => "ghu_test", connect: () => source });
		let session = await harness.doStart({
			sessionId: "s1",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		let control = await session.doPromptTurn({
			prompt: "output",
			tools: [{ name: "read_plan" }],
			skills: [],
			responseFormat: { type: "json", schema: { type: "object" } },
			emit: () => {},
		});
		await control.done;
		let config = source.sessions[0]!.config;
		expect(config.availableTools).toEqual(["custom:read_plan", "custom:chopin_submit_result"]);
		expect(config.tools?.map(tool => tool.name)).toEqual(["read_plan", "chopin_submit_result"]);
		expect(config.mcpServers).toEqual({});
	});

	it("ends the turn on abort even with a host tool call still in flight", async () => {
		let harness = createCopilotSdk({ credentials: () => "ghu_test", connect: stubRuntimeSource });
		let session = await harness.doStart({
			sessionId: "s1",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		let controller = new AbortController();
		let control = await session.doPromptTurn({
			prompt: "pending-tool-then-abort",
			tools: [{ name: "read_plan" }],
			skills: [],
			abortSignal: controller.signal,
			emit: () => {},
		});
		controller.abort();
		await expect(control.done).resolves.toBeUndefined();
	});
});
