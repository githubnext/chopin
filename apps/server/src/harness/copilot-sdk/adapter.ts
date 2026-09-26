/**
 * Chopin's Copilot SDK `HarnessV1` adapter.
 *
 * Runs the Copilot CLI as its own process over stdio, hardened the same way
 * today's Planner session is, but declares no built-ins and registers only
 * the host tools `HarnessAgent` passes for the turn. Copilot's own GitHub MCP
 * stays disabled: GitHub reads arrive as host tools instead, bound to one
 * repository upstream of this adapter. Structured `output` has no native
 * Copilot SDK path, so it is implemented with an internal terminal tool that
 * is never surfaced to the framework as an ordinary tool call.
 */

import { HarnessCapabilityUnsupportedError } from "@ai-sdk/harness";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { locate } from "../../agent/cli";
import { Runtime } from "./runtime";

import type {
	HarnessV1,
	HarnessV1PromptControl,
	HarnessV1PromptTurnOptions,
	HarnessV1Session,
	HarnessV1StartOptions,
} from "@ai-sdk/harness";
import type { CopilotSession, SessionConfig, Tool } from "@github/copilot-sdk";
import type { RuntimeSource } from "./runtime";

const RESULT_TOOL_NAME = "chopin_submit_result";
const OPERATION_TIMEOUT_MS = 10_000;

export type CopilotSdkSettings = {
	/** Per-session credential resolver, keyed by the harness session id. */
	credentials: (sessionId: string) => string | undefined;
	connect?: () => RuntimeSource;
	model?: string;
};

export class MissingCredentialsError extends Error {
	constructor(sessionId: string) {
		super(`No Copilot credentials are available for session ${sessionId}.`);
		this.name = "MissingCredentialsError";
	}
}

export class ToolMetadataMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolMetadataMismatchError";
	}
}

function bounded<T>(
	operation: Promise<T>,
	message: string,
	timeoutMs = OPERATION_TIMEOUT_MS,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		operation.then(
			value => {
				clearTimeout(timer);
				resolve(value);
			},
			err => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

function defaultConnect(): RuntimeSource {
	let cli = locate();
	if (!cli.ok) throw new Error(cli.reason);
	let home = mkdtempSync(join(tmpdir(), "chopin-copilot-planner-"));
	try {
		let client = new CopilotClient({
			mode: "empty",
			workingDirectory: home,
			baseDirectory: home,
			connection: RuntimeConnection.forStdio({ path: cli.path }),
			useLoggedInUser: false,
			// Deliberately omits COPILOT_ENABLE_BUILTIN_GITHUB_MCP: GitHub tools
			// reach the Planner as host tools instead.
			env: { COPILOT_PLUGIN_DIR_ONLY: "true" },
			logLevel: "info",
		});
		return { client, cleanup: () => rmSync(home, { recursive: true, force: true }) };
	} catch (err) {
		rmSync(home, { recursive: true, force: true });
		throw err;
	}
}

/**
 * Fail closed on the live session's own report of what it can call: exactly
 * the host tool names, none of them MCP or built-in, and no connected MCP
 * server. A model that could reach one more tool than we handed it is worth
 * stopping the turn for, not logging around.
 */
async function assertHostOnly(session: CopilotSession, expectedNames: string[]): Promise<void> {
	await session.rpc.tools.initializeAndValidate();
	let { tools } = await session.rpc.tools.getCurrentMetadata();
	let expected = new Set(expectedNames);
	let values = tools ?? [];
	let names = values.map(tool => tool.namespacedName ?? `custom:${tool.name}`).sort();
	let matches = values.length === expectedNames.length
		&& new Set(values.map(tool => tool.name)).size === expected.size
		&& expected.size === expectedNames.length
		&& values.every(tool =>
			expected.has(tool.name)
			&& !tool.mcpServerName
			&& !tool.mcpToolName
			&& (!tool.namespacedName || tool.namespacedName === `custom:${tool.name}`)
		);
	if (!matches) {
		throw new ToolMetadataMismatchError(
			`Copilot session tool metadata does not match the host tool set. Expected ${
				[...expected].map(name => `custom:${name}`).sort().join(", ")
			}; received ${names.length > 0 ? names.join(", ") : "none"}.`,
		);
	}
	let mcp = await session.rpc.mcp.list();
	if (mcp.servers.length > 0) {
		throw new ToolMetadataMismatchError(
			`Copilot session reports connected MCP servers: ${
				mcp.servers.map(server => server.name).join(", ")
			}.`,
		);
	}
	console.log(`[agent] ${names.length} tools: ${names.join(", ")}`);
}

function unsupported(capability: string): () => Promise<never> {
	return async () => {
		throw new HarnessCapabilityUnsupportedError({
			harnessId: "copilot-sdk",
			message: `Copilot SDK adapter does not support ${capability}.`,
		});
	};
}

function promptText(prompt: HarnessV1PromptTurnOptions["prompt"]): string {
	if (typeof prompt === "string") return prompt;
	if (typeof prompt.content === "string") return prompt.content;
	return prompt.content
		.map(part => (part.type === "text" ? part.text : ""))
		.join("");
}

/** Host-process `HarnessV1` implementation over `@github/copilot-sdk`. */
export function createCopilotSdk(
	settings: CopilotSdkSettings,
): HarnessV1 & { shutdown(): Promise<void> } {
	let runtime = new Runtime(settings.connect ?? defaultConnect);

	async function open(
		sessionId: string,
		turn: HarnessV1PromptTurnOptions,
		output: { received: boolean },
	): Promise<{
		session: CopilotSession;
		pending: Map<string, (result: { output: unknown; isError?: boolean }) => void>;
	}> {
		let token = settings.credentials(sessionId);
		if (!token) throw new MissingCredentialsError(sessionId);

		let hostNames = turn.tools.map(spec => spec.name);
		if (hostNames.includes(RESULT_TOOL_NAME)) {
			throw new Error(`Host tool name ${RESULT_TOOL_NAME} is reserved for structured output.`);
		}

		let pending = new Map<string, (result: { output: unknown; isError?: boolean }) => void>();

		let tools: Tool[] = turn.tools.map(spec => ({
			name: spec.name,
			description: spec.description,
			parameters: spec.inputSchema as Record<string, unknown> | undefined,
			skipPermission: true,
			defer: "never",
			async handler(args: unknown) {
				let toolCallId = crypto.randomUUID();
				let settled = Promise.withResolvers<{ output: unknown; isError?: boolean }>();
				pending.set(toolCallId, settled.resolve);
				turn.emit({
					type: "tool-call",
					toolCallId,
					toolName: spec.name,
					input: JSON.stringify(args ?? {}),
				});
				let result = await settled.promise;
				pending.delete(toolCallId);
				turn.emit({
					type: "tool-result",
					toolCallId,
					toolName: spec.name,
					result: (result.output ?? null) as NonNullable<unknown>,
					isError: result.isError,
				});
				if (result.isError) {
					throw new Error(
						typeof result.output === "string" ? result.output : "Host tool call failed.",
					);
				}
				return result.output;
			},
		}));

		if (turn.responseFormat?.type === "json") {
			tools.push({
				name: RESULT_TOOL_NAME,
				description: "Submit the final structured result for this turn.",
				parameters: turn.responseFormat.schema as Record<string, unknown> | undefined,
				skipPermission: true,
				defer: "never",
				isTerminal: true,
				handler(args: unknown) {
					let id = crypto.randomUUID();
					turn.emit({ type: "text-start", id });
					turn.emit({ type: "text-delta", id, delta: JSON.stringify(args ?? {}) });
					turn.emit({ type: "text-end", id });
					output.received = true;
					return "Result received.";
				},
			});
		}

		let config: SessionConfig = {
			model: settings.model,
			gitHubToken: token,
			streaming: true,
			largeOutput: { enabled: false },
			enableConfigDiscovery: false,
			skipCustomInstructions: true,
			enableOnDemandInstructionDiscovery: false,
			enableFileHooks: false,
			enableHostGitOperations: false,
			enableSessionStore: false,
			enableSkills: false,
			skillDirectories: [],
			pluginDirectories: [],
			infiniteSessions: { enabled: false },
			skipEmbeddingRetrieval: true,
			embeddingCacheStorage: "in-memory",
			mcpOAuthTokenStorage: "in-memory",
			enableSessionTelemetry: false,
			remoteSession: "off",
			availableTools: tools.map(tool => `custom:${tool.name}`),
			tools,
			mcpServers: {},
			systemMessage: turn.instructions
				? { mode: "append", content: turn.instructions }
				: undefined,
			onPermissionRequest: async () => ({
				kind: "reject",
				feedback: "The Copilot SDK adapter grants no ambient capabilities.",
			}),
		} as SessionConfig;

		let session = await runtime.open(config);
		try {
			await assertHostOnly(session, tools.map(tool => tool.name));
		} catch (err) {
			await runtime.discard(session).catch(() => {});
			throw err;
		}
		return { session, pending };
	}

	return {
		specificationVersion: "harness-v1",
		harnessId: "copilot-sdk",
		builtinTools: {},
		supportsBuiltinToolFiltering: true,

		async doStart(startOptions: HarnessV1StartOptions): Promise<HarnessV1Session> {
			let copilot: CopilotSession | undefined;

			return {
				sessionId: startOptions.sessionId,
				isResume: false,

				async doPromptTurn(turn: HarnessV1PromptTurnOptions): Promise<HarnessV1PromptControl> {
					let output = { received: false };
					let expectingOutput = turn.responseFormat?.type === "json";
					let { session, pending } = await open(startOptions.sessionId, turn, output);
					copilot = session;
					let settled = Promise.withResolvers<void>();
					let currentTextId: string | undefined;
					let currentTextMessageId: string | undefined;

					let finishTurn = () => {
						turn.emit({
							type: "finish-step",
							finishReason: { unified: "stop", raw: undefined },
							usage: {
								inputTokens: {
									total: undefined,
									noCache: undefined,
									cacheRead: undefined,
									cacheWrite: undefined,
								},
								outputTokens: { total: undefined, text: undefined, reasoning: undefined },
							},
						});
						turn.emit({
							type: "finish",
							finishReason: { unified: "stop", raw: undefined },
							totalUsage: {
								inputTokens: {
									total: undefined,
									noCache: undefined,
									cacheRead: undefined,
									cacheWrite: undefined,
								},
								outputTokens: { total: undefined, text: undefined, reasoning: undefined },
							},
						});
						settled.resolve();
					};

					let release = session.on(event => {
						if (expectingOutput) {
							// Structured output must come only from the terminal result tool;
							// any assistant prose alongside it is not the model's answer.
							if (event.type === "session.idle") {
								if (!output.received) {
									settled.reject(new Error("Copilot turn ended without a structured result."));
								} else {
									finishTurn();
								}
							} else if (event.type === "session.error") {
								turn.emit({ type: "error", error: new Error(event.data.message) });
								settled.reject(new Error(event.data.message));
							}
							return;
						}
						if (event.type === "assistant.message_delta") {
							let messageId = event.data.messageId;
							if (currentTextMessageId !== messageId) {
								if (currentTextId) turn.emit({ type: "text-end", id: currentTextId });
								currentTextId = crypto.randomUUID();
								currentTextMessageId = messageId;
								turn.emit({ type: "text-start", id: currentTextId });
							}
							turn.emit({ type: "text-delta", id: currentTextId!, delta: event.data.deltaContent });
						} else if (event.type === "assistant.message") {
							if (currentTextMessageId === event.data.messageId && currentTextId) {
								turn.emit({ type: "text-end", id: currentTextId });
								currentTextId = undefined;
								currentTextMessageId = undefined;
							} else if (event.data.content) {
								let id = crypto.randomUUID();
								turn.emit({ type: "text-start", id });
								turn.emit({ type: "text-delta", id, delta: event.data.content });
								turn.emit({ type: "text-end", id });
							}
						} else if (event.type === "session.idle") {
							finishTurn();
						} else if (event.type === "session.error") {
							turn.emit({ type: "error", error: new Error(event.data.message) });
							settled.reject(new Error(event.data.message));
						}
					});

					let onAbort = () => {
						bounded(
							Promise.resolve().then(() => session.abort()),
							`Copilot session ${session.sessionId} abort timed out.`,
						).catch(() => {}).finally(() => {
							for (let resolve of pending.values()) {
								resolve({ output: "The turn was aborted.", isError: true });
							}
							pending.clear();
							settled.resolve();
						});
					};
					turn.abortSignal?.addEventListener("abort", onAbort, { once: true });

					if (turn.abortSignal?.aborted) onAbort();
					else session.send({ prompt: promptText(turn.prompt) }).catch(err => settled.reject(err));

					return {
						async submitToolResult({ toolCallId, output: result, isError }) {
							pending.get(toolCallId)?.({ output: result, isError });
						},
						async submitToolApproval() {
							// No built-ins and no host approval requests are ever emitted, so the
							// framework never actually calls back through this path.
						},
						done: settled.promise.finally(() => {
							turn.abortSignal?.removeEventListener("abort", onAbort);
							release();
						}),
					};
				},

				doCompact: unsupported("compaction"),
				doContinueTurn: unsupported("continuing a suspended turn"),
				doSuspendTurn: unsupported("suspending a turn"),
				doDetach: unsupported("detaching from a live session"),
				doStop: unsupported("stopping with resumable state"),
				async doDestroy() {
					if (copilot) await runtime.discard(copilot).catch(() => {});
				},
			};
		},

		async shutdown() {
			await runtime.shutdown();
		},
	};
}
