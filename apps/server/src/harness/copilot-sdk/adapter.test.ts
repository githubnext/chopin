import { describe, expect, it } from "bun:test";

import { createSummaryAgent } from "../agents";
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
		output?: Record<string, unknown>;
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
				await target.handler!(overrides.output ?? { answer: "yes" }, toolCall(target.name));
				emit({ type: "session.idle", data: {} });
			} else if (prompt === "abort") {
				// Never resolves on its own; only the adapter's own abort handling ends the turn.
			} else if (prompt === "error") {
				emit({ type: "session.error", data: { message: "native turn failed" } });
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

	it("uses each turn's MODEL and releases previous unlimited turns", async () => {
		let source = stubRuntimeSource();
		let disconnected = 0;
		let original = source.client.createSession.bind(source.client);
		source.client.createSession = async config => {
			let session = await original(config);
			source.sessions.at(-1)!.disconnect = async () => {
				disconnected++;
			};
			return session;
		};
		let harness = createCopilotSdk({ credentials: () => "ghu_test", connect: () => source });
		let session = await harness.doStart({
			sessionId: "s1",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		for (let model of ["first-model", "second-model"]) {
			let control = await session.doPromptTurn({
				prompt: "hello",
				model,
				tools: [],
				skills: [],
				emit: () => {},
			});
			await control.done;
		}
		expect(source.sessions.map(value => value.config.model)).toEqual([
			"first-model",
			"second-model",
		]);
		expect(disconnected).toBe(1);
		await session.doDestroy();
		expect(disconnected).toBe(2);
	});

	it("discards an unlimited turn before refusing a lost credential", async () => {
		let source = stubRuntimeSource();
		let token: string | undefined = "ghu_test";
		let disconnected = 0;
		let original = source.client.createSession.bind(source.client);
		source.client.createSession = async config => {
			let session = await original(config);
			source.sessions.at(-1)!.disconnect = async () => {
				disconnected++;
			};
			return session;
		};
		let harness = createCopilotSdk({ credentials: () => token, connect: () => source });
		let session = await harness.doStart({
			sessionId: "s1",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		let first = await session.doPromptTurn({
			prompt: "hello",
			tools: [],
			skills: [],
			emit: () => {},
		});
		await first.done;
		token = undefined;
		await expect(session.doPromptTurn({
			prompt: "hello",
			tools: [],
			skills: [],
			emit: () => {},
		})).rejects.toThrow(MissingCredentialsError);
		expect(disconnected).toBe(1);
		expect(source.sessions).toHaveLength(1);
		await session.doDestroy();
	});

	it("keeps one 64-credit Copilot session across structured turns and rebinds output", async () => {
		let source = stubRuntimeSource();
		let sends = 0;
		let disconnects = 0;
		let original = source.client.createSession.bind(source.client);
		source.client.createSession = async config => {
			let session = await original(config);
			let fake = source.sessions.at(-1)!;
			let send = fake.send.bind(fake);
			fake.send = input => {
				sends++;
				return send(input);
			};
			fake.disconnect = async () => {
				disconnects++;
			};
			return session;
		};
		let harness = createCopilotSdk({
			credentials: () => "ghu_test",
			limits: () => ({ maxAiCredits: 64 }),
			connect: () => source,
		});
		let session = await harness.doStart({
			sessionId: "limited",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		let first: unknown[] = [];
		let second: unknown[] = [];
		let options = {
			prompt: "output",
			model: "fixed-model",
			instructions: "same instructions",
			tools: [],
			skills: [],
			responseFormat: { type: "json" as const, schema: { type: "object" } },
		};
		try {
			for (let emitted of [first, second]) {
				let control = await session.doPromptTurn({ ...options, emit: part => emitted.push(part) });
				await control.done;
			}
			expect(source.sessions).toHaveLength(1);
			expect(source.sessions[0]!.config.sessionLimits?.maxAiCredits).toBe(64);
			expect(sends).toBe(2);
			expect(first.filter(part => (part as { type: string }).type === "text-delta")).toHaveLength(
				1,
			);
			expect(second.filter(part => (part as { type: string }).type === "text-delta")).toHaveLength(
				1,
			);
			expect(disconnects).toBe(0);
		} finally {
			await session.doDestroy();
		}
		expect(disconnects).toBe(1);
	});

	it("routes host tool calls to each turn when one limited session is reused", async () => {
		let source = stubRuntimeSource();
		let harness = createCopilotSdk({
			credentials: () => "ghu_test",
			limits: () => ({ maxAiCredits: 64 }),
			connect: () => source,
		});
		let session = await harness.doStart({
			sessionId: "limited",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		let settings = { prompt: "tools", tools: [{ name: "read_plan" }], skills: [] };
		try {
			for (let index of [1, 2]) {
				let parts: Array<{ type: string; toolCallId?: string }> = [];
				let control = await session.doPromptTurn({ ...settings, emit: part => parts.push(part) });
				let call = parts.find(part => part.type === "tool-call");
				expect(call?.toolCallId).toBeTruthy();
				await control.submitToolResult({ toolCallId: call!.toolCallId!, output: `turn-${index}` });
				await control.done;
				expect(parts.find(part => part.type === "tool-result")).toMatchObject({
					toolCallId: call!.toolCallId,
					result: `turn-${index}`,
				});
			}
			expect(source.sessions).toHaveLength(1);
		} finally {
			await session.doDestroy();
		}
	});

	it("does not reuse a limited session after owner token rotation", async () => {
		let source = stubRuntimeSource();
		let token = "first";
		let harness = createCopilotSdk({
			credentials: () => token,
			limits: () => ({ maxAiCredits: 64 }),
			connect: () => source,
		});
		let session = await harness.doStart({
			sessionId: "limited",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		let settings = {
			prompt: "output",
			tools: [],
			skills: [],
			responseFormat: { type: "json" as const, schema: { type: "object" } },
			emit: () => {},
		};
		try {
			let first = await session.doPromptTurn(settings);
			await first.done;
			token = "rotated";
			await expect(session.doPromptTurn(settings)).rejects.toThrow("cannot change settings");
			expect(source.sessions).toHaveLength(1);
		} finally {
			await session.doDestroy();
		}
	});

	it("refuses a concurrent limited turn without a second native session", async () => {
		let source = stubRuntimeSource();
		let harness = createCopilotSdk({
			credentials: () => "ghu_test",
			limits: () => ({ maxAiCredits: 64 }),
			connect: () => source,
		});
		let session = await harness.doStart({
			sessionId: "limited",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		let settings = { prompt: "abort", tools: [], skills: [], emit: () => {} };
		let controller = new AbortController();
		try {
			let first = await session.doPromptTurn({ ...settings, abortSignal: controller.signal });
			await expect(session.doPromptTurn(settings)).rejects.toThrow("already has an active turn");
			expect(source.sessions).toHaveLength(1);
			controller.abort();
			await first.done;
		} finally {
			await session.doDestroy();
		}
	});

	it("refuses a later limited turn after a native session error", async () => {
		let source = stubRuntimeSource();
		let harness = createCopilotSdk({
			credentials: () => "ghu_test",
			limits: () => ({ maxAiCredits: 64 }),
			connect: () => source,
		});
		let session = await harness.doStart({
			sessionId: "limited",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		let settings = { prompt: "error", tools: [], skills: [], emit: () => {} };
		try {
			let first = await session.doPromptTurn(settings);
			await expect(first.done).rejects.toThrow("native turn failed");
			await expect(session.doPromptTurn({ ...settings, prompt: "hello" })).rejects.toThrow(
				"cannot continue after a failed turn",
			);
			expect(source.sessions).toHaveLength(1);
		} finally {
			await session.doDestroy();
		}
	});

	it("refuses configuration drift without reopening a limited credit window", async () => {
		for (
			let change of [
				{ model: "other" },
				{ instructions: "other" },
				{ tools: [{ name: "extra" }] },
				{ responseFormat: { type: "json" as const, schema: { type: "array" } } },
			]
		) {
			let source = stubRuntimeSource();
			let harness = createCopilotSdk({
				credentials: () => "ghu_test",
				limits: () => ({ maxAiCredits: 64 }),
				connect: () => source,
			});
			let session = await harness.doStart({
				sessionId: "limited",
				sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
				sessionWorkDir: "/tmp",
			});
			let settings = {
				prompt: "output",
				model: "fixed",
				instructions: "fixed",
				tools: [],
				skills: [],
				responseFormat: { type: "json" as const, schema: { type: "object" } },
				emit: () => {},
			};
			try {
				let first = await session.doPromptTurn(settings);
				await first.done;
				await expect(session.doPromptTurn({ ...settings, ...change })).rejects.toThrow(
					"credit-limited Copilot session cannot change settings between turns",
				);
				expect(source.sessions).toHaveLength(1);
			} finally {
				await session.doDestroy();
			}
		}
	});

	it("refuses a later limited turn after abort instead of resetting the credit window", async () => {
		let source = stubRuntimeSource();
		let harness = createCopilotSdk({
			credentials: () => "ghu_test",
			limits: () => ({ maxAiCredits: 64 }),
			connect: () => source,
		});
		let session = await harness.doStart({
			sessionId: "limited",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		let controller = new AbortController();
		let settings = {
			prompt: "abort",
			tools: [],
			skills: [],
			abortSignal: controller.signal,
			emit: () => {},
		};
		try {
			let control = await session.doPromptTurn(settings);
			controller.abort();
			await control.done;
			await expect(session.doPromptTurn({ ...settings, prompt: "hello" })).rejects.toThrow(
				"credit-limited Copilot session cannot continue after a failed turn",
			);
			expect(source.sessions).toHaveLength(1);
		} finally {
			await session.doDestroy();
		}
	});

	it("parses two summaryAgent outputs on one limited native session", async () => {
		let source = stubRuntimeSource({ output: { description: "RFC about harnesses" } });
		let harness = createCopilotSdk({
			credentials: () => "ghu_test",
			limits: () => ({ maxAiCredits: 64 }),
			connect: () => source,
		});
		let agent = createSummaryAgent(harness);
		let session = await agent.createSession({
			sandboxSession: {
				defaultWorkingDirectory: "/tmp",
				run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
				destroy: async () => {},
			} as never,
		});
		try {
			for (let prompt of ["output", "output"]) {
				let result = await agent.generate({
					session,
					prompt,
					options: {
						model: "fixed",
						instructions: "Describe the document.",
					},
				});
				expect(result.output).toEqual({ description: "RFC about harnesses" });
			}
			expect(source.sessions).toHaveLength(1);
			expect(source.sessions[0]!.config.sessionLimits?.maxAiCredits).toBe(64);
		} finally {
			await session.destroy();
			await harness.shutdown();
		}
	});
	it("does not send a turn aborted while the Copilot session opens", async () => {
		let source = stubRuntimeSource();
		let createSession = source.client.createSession.bind(source.client);
		let opening = Promise.withResolvers<void>();
		let continueOpening = Promise.withResolvers<void>();
		let sends = 0;
		let aborts = 0;
		let disconnects = 0;
		source.client.createSession = async config => {
			let session = await createSession(config);
			let fake = source.sessions.at(-1)!;
			let send = fake.send.bind(fake);
			fake.send = input => {
				sends++;
				return send(input);
			};
			fake.abort = async () => {
				aborts++;
			};
			fake.disconnect = async () => {
				disconnects++;
			};
			opening.resolve();
			await continueOpening.promise;
			return session;
		};
		let harness = createCopilotSdk({ credentials: () => "ghu_test", connect: () => source });
		let session = await harness.doStart({
			sessionId: "s1",
			sandboxSession: { defaultWorkingDirectory: "/tmp" } as never,
			sessionWorkDir: "/tmp",
		});
		let controller = new AbortController();
		let turn = session.doPromptTurn({
			prompt: "hello",
			tools: [],
			skills: [],
			abortSignal: controller.signal,
			emit: () => {},
		});
		await opening.promise;
		controller.abort();
		continueOpening.resolve();
		let control = await turn;
		await control.done;
		await session.doDestroy();
		expect(sends).toBe(0);
		expect(aborts).toBe(1);
		expect(disconnects).toBe(1);
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
