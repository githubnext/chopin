/**
 * Chopin's Atomic `HarnessV1` adapter.
 *
 * Embeds Atomic in-process through its headless SDK. Each harness session owns
 * one Atomic `AgentSession` with every shipped builtin package off, no Atomic
 * coding tools, an inert resource loader, and in-memory session, settings, and
 * credential stores. The model is offered only the host tools `HarnessAgent`
 * passes for the turn, plus a terminating result tool on structured turns. The
 * tool set is checked before every prompt and before every model request, and a
 * mismatch fails the turn.
 */

import { HarnessCapabilityUnsupportedError } from "@ai-sdk/harness";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	FileAuthStorageBackend,
	getAgentConfigPaths,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@bastani/atomic";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	HarnessV1,
	HarnessV1PromptControl,
	HarnessV1PromptTurnOptions,
	HarnessV1ResponseFormat,
	HarnessV1ResumeSessionState,
	HarnessV1Session,
	HarnessV1StartOptions,
	HarnessV1StreamPart,
	HarnessV1ToolSpec,
} from "@ai-sdk/harness";
import type {
	AgentSession,
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionFactory,
	ToolDefinition,
} from "@bastani/atomic";

export const ATOMIC_AUTH_MODES = ["auto", "ai-gateway"] as const;

export type AtomicAuthMode = (typeof ATOMIC_AUTH_MODES)[number];

export const ATOMIC_RESULT_TOOL_NAME = "chopin_submit_atomic_result";

export const ATOMIC_RESULT_INSTRUCTION =
	`When you have the final answer for this turn, call the ${ATOMIC_RESULT_TOOL_NAME} tool exactly `
	+ "once with the required fields instead of replying in plain text.";

/** Replaces Atomic's coding-agent preamble on turns that bring no instructions. */
export const ATOMIC_DEFAULT_SYSTEM_PROMPT =
	"Respond to the user's message. Use only the tools this turn provides.";

const GATEWAY_PROVIDER = "vercel-ai-gateway";
const OPERATION_TIMEOUT_MS = 10_000;
const BUILTINS_OFF = {
	workflows: false,
	subagents: false,
	mcp: false,
	"web-access": false,
	intercom: false,
};
const SETTINGS = {
	compaction: { enabled: false },
	sessionSummary: { enabled: false },
	cacheWarming: "off" as const,
};
const ZERO_USAGE = {
	inputTokens: {
		total: undefined,
		noCache: undefined,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

type ProviderConfig = Parameters<ModelRuntime["registerProvider"]>[1];
type Model = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
type ToolOutcome = { output: unknown; isError?: boolean };

export type AtomicSettings = {
	auth: AtomicAuthMode;
	/** Model, as `provider/model`, for turns that name none. */
	model?: string;
	/** Providers registered by code rather than discovered from the host. */
	providers?: Record<string, ProviderConfig>;
};

export class ToolBoundaryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolBoundaryError";
	}
}

/** What the turn extension enforces; the adapter rewrites it before each turn. */
export type TurnPolicy = {
	hostNames: string[];
	structured: boolean;
	systemPrompt: string;
	result?: { value: unknown };
};

/**
 * Registers the terminating result tool and applies the per-turn policy: the
 * active tools and the exact system prompt. `structured` comes only from the
 * turn's response format, never from prompt text, so quoted chat cannot switch
 * the result tool on.
 */
export function atomicTurnExtension(policy: TurnPolicy): ExtensionFactory {
	return (atomic: ExtensionAPI): void => {
		atomic.registerTool({
			name: ATOMIC_RESULT_TOOL_NAME,
			label: "Submit result",
			description: "Submit the final structured result for this turn.",
			parameters: { type: "object", additionalProperties: true } as ToolDefinition["parameters"],
			maxResultSizeChars: Infinity,
			async execute(_toolCallId, params) {
				policy.result = { value: params };
				return {
					content: [{ type: "text", text: "Result received." }],
					details: params,
					terminate: true,
				};
			},
		});
		atomic.on("before_agent_start", () => {
			atomic.setActiveTools(activeNames(policy));
			return { systemPrompt: policy.systemPrompt };
		});
		atomic.on("tool_call", event => {
			if (activeNames(policy).includes(event.toolName)) return;
			return { block: true, reason: `${event.toolName} is not available in this turn.` };
		});
	};
}

function activeNames(policy: TurnPolicy): string[] {
	return policy.structured ? [...policy.hostNames, ATOMIC_RESULT_TOOL_NAME] : [...policy.hostNames];
}

export function turnSystemPrompt(
	instructions: string | undefined,
	responseFormat: HarnessV1ResponseFormat | undefined,
): string {
	let result = responseFormat?.type === "json"
		? [
			ATOMIC_RESULT_INSTRUCTION,
			responseFormat.description,
			`The ${ATOMIC_RESULT_TOOL_NAME} arguments must match this JSON schema: ${
				JSON.stringify(responseFormat.schema ?? { type: "object" })
			}`,
		].filter(Boolean).join("\n")
		: undefined;
	return [instructions, result].filter(Boolean).join("\n\n") || ATOMIC_DEFAULT_SYSTEM_PROMPT;
}

/** Looks up `provider/model` without letting Atomic substitute a default. */
export function resolveModel(
	runtime: Pick<ModelRuntime, "getModel">,
	settings: Pick<AtomicSettings, "auth" | "providers">,
	requested: string | undefined,
): Model {
	if (!requested) throw new Error("Atomic needs a model named as provider/model.");
	let slash = requested.indexOf("/");
	let provider = requested.slice(0, slash);
	let model = slash > 0 ? runtime.getModel(provider, requested.slice(slash + 1)) : undefined;
	if (!model) throw new Error(`Atomic does not recognize model ${requested}`);
	if (
		settings.auth === "ai-gateway" && provider !== GATEWAY_PROVIDER
		&& !Object.hasOwn(settings.providers ?? {}, provider)
	) {
		throw new Error(
			`HARNESS_AUTH ai-gateway allows only ${GATEWAY_PROVIDER} models, not ${requested}`,
		);
	}
	return model;
}

/**
 * Credentials live only in memory. `auto` copies the host's Atomic login once,
 * read without a lock file, so a token refresh can never be written back.
 */
async function createRuntime(settings: AtomicSettings): Promise<ModelRuntime> {
	let login = {};
	if (settings.auth === "auto") {
		let paths = getAgentConfigPaths("auth.json");
		let content = new FileAuthStorageBackend(paths[0], paths).read();
		if (content) login = JSON.parse(content);
	}
	let runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(login),
		modelsPath: null,
		allowModelNetwork: false,
	});
	for (let [id, config] of Object.entries(settings.providers ?? {})) {
		runtime.registerProvider(id, config);
	}
	return runtime;
}

function unsupported(capability: string): HarnessCapabilityUnsupportedError {
	return new HarnessCapabilityUnsupportedError({
		harnessId: "atomic",
		message: `Atomic adapter does not support ${capability}.`,
	});
}

function bounded<T>(operation: Promise<T>, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		operation,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), OPERATION_TIMEOUT_MS);
		}),
	]).finally(() => clearTimeout(timer));
}

function promptText(prompt: HarnessV1PromptTurnOptions["prompt"]): string {
	if (typeof prompt === "string") return prompt;
	if (typeof prompt.content === "string") return prompt.content;
	return prompt.content.map(part => {
		if (part.type !== "text") throw unsupported(`${part.type} prompt parts`);
		return part.text;
	}).join("\n\n");
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
	let left = [...actual].sort();
	let right = [...expected].sort();
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

/** What a freshly built session exposes beyond the turn extension and the host tools, if anything. */
export function hostLeak(
	session: Pick<AgentSession, "getAllTools" | "resourceLoader">,
	extensions: number,
	hostNames: readonly string[],
): string | undefined {
	let resources = session.resourceLoader;
	let tools = session.getAllTools().map(tool => tool.name);
	let found = [
		extensions !== 1 && `${extensions} extensions`,
		!sameNames(tools, [...hostNames, ATOMIC_RESULT_TOOL_NAME]) && `tools ${tools.join(", ")}`,
		resources.getAgentsFiles().agentsFiles.length > 0 && "context files",
		resources.getSkills().skills.length > 0 && "skills",
		resources.getPrompts().prompts.length > 0 && "prompt templates",
		resources.getAppendSystemPrompt().length > 0 && "appended system prompts",
		resources.getSystemPrompt() !== ATOMIC_DEFAULT_SYSTEM_PROMPT && "a host system prompt",
	].filter(Boolean);
	return found.length > 0 ? found.join("; ") : undefined;
}

function serialize(output: unknown): string {
	return typeof output === "string" ? output : JSON.stringify(output ?? null);
}

type Run = {
	emit: (part: HarnessV1StreamPart) => void;
	pending: Map<string, (outcome: ToolOutcome) => void>;
	blocks: Map<number, { id: string; kind: "text" | "reasoning" }>;
	stopped: boolean;
	failure?: Error;
	last?: { stopReason: string; errorMessage?: string };
	stop: () => void;
	done: Promise<void>;
};

function control(run: Run): HarnessV1PromptControl {
	return {
		async submitToolResult({ toolCallId, output, isError }) {
			run.pending.get(toolCallId)?.({ output, isError });
		},
		async submitToolApproval() {
			// The adapter emits no approval requests; there is nothing to answer.
		},
		done: run.done,
	};
}

function listen(run: Run, signal: AbortSignal | undefined): void {
	if (!signal) return;
	if (signal.aborted) run.stop();
	else signal.addEventListener("abort", run.stop, { once: true });
	void run.done.catch(() => {}).finally(() => signal.removeEventListener("abort", run.stop));
}

/** Host-process `HarnessV1` implementation over `@bastani/atomic`. */
export function createAtomicAdapter(
	settings: AtomicSettings,
): HarnessV1 & { shutdown(): Promise<void> } {
	if (!ATOMIC_AUTH_MODES.includes(settings.auth)) {
		throw new Error(`HARNESS_AUTH ${settings.auth} is not a supported atomic authentication mode`);
	}
	let runtime: Promise<ModelRuntime> | undefined;
	let open = new Set<HarnessV1Session>();

	return {
		specificationVersion: "harness-v1",
		harnessId: "atomic",
		builtinTools: {},
		supportsBuiltinToolFiltering: true,

		async doStart(startOptions: HarnessV1StartOptions): Promise<HarnessV1Session> {
			if (startOptions.resumeFrom || startOptions.continueFrom) {
				throw unsupported("resuming an in-memory session");
			}
			let directory: string | undefined;
			let sessionManager: SessionManager | undefined;
			let settingsManager = SettingsManager.inMemory(SETTINGS);
			let policy: TurnPolicy = {
				hostNames: [],
				structured: false,
				systemPrompt: ATOMIC_DEFAULT_SYSTEM_PROMPT,
			};
			let live: { session: AgentSession; signature: string; release: () => void } | undefined;
			let current: Run | undefined;
			let closed: Promise<void> | undefined;

			function hostTool(spec: HarnessV1ToolSpec): ToolDefinition {
				return {
					name: spec.name,
					label: spec.name,
					description: spec.description ?? "",
					parameters: (spec.inputSchema ?? { type: "object" }) as ToolDefinition["parameters"],
					maxResultSizeChars: Infinity,
					async execute(toolCallId, params, signal) {
						let run = current;
						if (!run || run.stopped || signal?.aborted) throw new Error("The turn was aborted.");
						let settled = Promise.withResolvers<ToolOutcome>();
						let abort = () => settled.resolve({ output: "The turn was aborted.", isError: true });
						run.pending.set(toolCallId, settled.resolve);
						signal?.addEventListener("abort", abort, { once: true });
						run.emit({
							type: "tool-call",
							toolCallId,
							toolName: spec.name,
							input: JSON.stringify(params ?? {}),
						});
						let outcome = await settled.promise;
						signal?.removeEventListener("abort", abort);
						run.pending.delete(toolCallId);
						if (run.stopped || signal?.aborted) throw new Error("The turn was aborted.");
						run.emit({
							type: "tool-result",
							toolCallId,
							toolName: spec.name,
							result: (outcome.output ?? null) as NonNullable<unknown>,
							isError: outcome.isError,
						});
						if (outcome.isError) throw new Error(serialize(outcome.output));
						return { content: [{ type: "text", text: serialize(outcome.output) }], details: {} };
					},
				};
			}

			function observe(session: AgentSession, event: AgentSessionEvent): void {
				let run = current;
				if (!run) return;
				if (event.type === "turn_start") {
					let offered = session.agent.state.tools.map(tool => tool.name);
					if (!sameNames(offered, activeNames(policy))) {
						run.failure ??= new ToolBoundaryError(
							`Atomic offered unexpected tools: ${offered.join(", ") || "none"}.`,
						);
						run.stop();
					}
					if (run.stopped) session.agent.abort();
					return;
				}
				if (!("message" in event) || event.message.role !== "assistant") return;
				if (event.type === "message_start") {
					run.blocks.clear();
				} else if (event.type === "message_end") {
					for (let block of run.blocks.values()) {
						run.emit({ type: `${block.kind}-end`, id: block.id });
					}
					run.blocks.clear();
					run.last = event.message;
				} else if (event.type === "message_update" && !policy.structured) {
					let update = event.assistantMessageEvent;
					let kind = update.type.startsWith("text_")
						? "text" as const
						: update.type.startsWith("thinking_")
						? "reasoning" as const
						: undefined;
					if (!kind || !("contentIndex" in update)) return;
					let block = run.blocks.get(update.contentIndex);
					if (!block) {
						block = { id: crypto.randomUUID(), kind };
						run.blocks.set(update.contentIndex, block);
						run.emit({ type: `${kind}-start`, id: block.id });
					}
					if (update.type === "text_delta" || update.type === "thinking_delta") {
						run.emit({ type: `${kind}-delta`, id: block.id, delta: update.delta });
					} else if (update.type === "text_end" || update.type === "thinking_end") {
						run.emit({ type: `${kind}-end`, id: block.id });
						run.blocks.delete(update.contentIndex);
					}
				}
			}

			async function prepare(turn: HarnessV1PromptTurnOptions): Promise<AgentSession> {
				if (turn.skills.length > 0) throw unsupported("skills");
				let hostNames = turn.tools.map(spec => spec.name);
				if (hostNames.includes(ATOMIC_RESULT_TOOL_NAME)) {
					throw new Error(
						`Host tool name ${ATOMIC_RESULT_TOOL_NAME} is reserved for structured output.`,
					);
				}
				let models = await (runtime ??= createRuntime(settings));
				let model = resolveModel(models, settings, turn.model ?? settings.model);
				let signature = JSON.stringify(turn.tools);
				if (live && live.signature !== signature) {
					live.release();
					await live.session.dispose();
					live = undefined;
				}
				policy.hostNames = hostNames;
				policy.structured = false;
				if (!live) {
					directory ??= await mkdtemp(join(tmpdir(), "chopin-atomic-planner-"));
					sessionManager ??= SessionManager.inMemory(directory);
					let loader = new DefaultResourceLoader({
						cwd: directory,
						agentDir: directory,
						settingsManager,
						noExtensions: true,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
						systemPrompt: ATOMIC_DEFAULT_SYSTEM_PROMPT,
						appendSystemPrompt: [],
						extensionFactories: [atomicTurnExtension(policy)],
					});
					await loader.reload();
					let created = await createAgentSession({
						cwd: directory,
						agentDir: directory,
						modelRuntime: models,
						model,
						fallbackModels: [],
						sessionManager,
						settingsManager,
						resourceLoader: loader,
						builtins: BUILTINS_OFF,
						tools: [...hostNames, ATOMIC_RESULT_TOOL_NAME],
						customTools: turn.tools.map(hostTool),
					});
					let session = created.session;
					let leak = hostLeak(session, created.extensionsResult.extensions.length, hostNames);
					if (leak || closed) {
						try {
							await session.dispose();
						} finally {
							// Closing during setup ran cleanup before this directory existed.
							if (closed && directory) {
								await rm(directory, { recursive: true, force: true });
								directory = undefined;
							}
						}
						throw leak
							? new ToolBoundaryError(`Atomic session is not isolated: ${leak}.`)
							: new Error("Atomic session is closed.");
					}
					let registered = session.getAllTools().map(tool => tool.name);
					console.log(`[agent] ${registered.length} tools: ${registered.sort().join(", ")}`);
					live = {
						session,
						signature,
						release: session.subscribe(event => observe(session, event)),
					};
				} else if (
					live.session.model?.provider !== model.provider || live.session.model.id !== model.id
				) {
					await live.session.setModel(model);
				}
				return live.session;
			}

			async function close(): Promise<void> {
				open.delete(handle);
				let run = current;
				if (run) {
					run.stop();
					await bounded(run.done, "Atomic turn did not stop.").catch(() => {});
				}
				try {
					if (live) {
						live.release();
						await bounded(live.session.dispose(), "Atomic session disposal timed out.");
					}
				} finally {
					live = undefined;
					if (directory) await rm(directory, { recursive: true, force: true });
				}
			}

			async function stopped(): Promise<HarnessV1ResumeSessionState> {
				await (closed ??= close());
				return {
					type: "resume-session",
					harnessId: "atomic",
					specificationVersion: "harness-v1",
					data: {},
				};
			}

			let handle: HarnessV1Session = {
				sessionId: startOptions.sessionId,
				isResume: false,

				async doPromptTurn(turn: HarnessV1PromptTurnOptions): Promise<HarnessV1PromptControl> {
					if (closed) throw new Error("Atomic session is closed.");
					if (current) throw new Error("Atomic session already has an active turn.");
					let text = promptText(turn.prompt);
					let agent = await prepare(turn);
					let structured = turn.responseFormat?.type === "json";
					let expected = structured
						? [...policy.hostNames, ATOMIC_RESULT_TOOL_NAME]
						: policy.hostNames;
					agent.setActiveToolsByName(expected);
					if (!sameNames(agent.getActiveToolNames(), expected)) {
						throw new ToolBoundaryError(
							`Atomic active tools do not match the turn: ${
								agent.getActiveToolNames().join(", ")
							}.`,
						);
					}
					policy.structured = structured;
					policy.systemPrompt = turnSystemPrompt(turn.instructions, turn.responseFormat);
					policy.result = undefined;

					let run: Run = {
						emit: turn.emit,
						pending: new Map(),
						blocks: new Map(),
						stopped: false,
						stop: () => {
							if (run.stopped) return;
							run.stopped = true;
							for (let resolve of run.pending.values()) {
								resolve({ output: "The turn was aborted.", isError: true });
							}
							run.pending.clear();
							void bounded(agent.abort(), "Atomic abort timed out.").catch(() => {});
						},
						done: Promise.resolve(),
					};
					current = run;
					run.done = (async () => {
						try {
							if (!run.stopped) {
								run.emit({ type: "stream-start", modelId: agent.model?.id });
								await agent.prompt(text, { expandPromptTemplates: false });
							}
							if (run.failure) throw run.failure;
							if (run.stopped) return;
							if (run.last?.stopReason === "error" || run.last?.stopReason === "aborted") {
								throw new Error(run.last.errorMessage ?? "Atomic turn failed.");
							}
							if (structured) {
								if (!policy.result) {
									throw new Error("Atomic turn ended without a structured result.");
								}
								let id = crypto.randomUUID();
								run.emit({ type: "text-start", id });
								run.emit({ type: "text-delta", id, delta: JSON.stringify(policy.result.value) });
								run.emit({ type: "text-end", id });
							}
							run.emit({
								type: "finish-step",
								finishReason: { unified: "stop", raw: undefined },
								usage: ZERO_USAGE,
							});
							run.emit({
								type: "finish",
								finishReason: { unified: "stop", raw: undefined },
								totalUsage: ZERO_USAGE,
							});
						} finally {
							if (current === run) current = undefined;
						}
					})();
					listen(run, turn.abortSignal);
					return control(run);
				},

				async doContinueTurn(turn): Promise<HarnessV1PromptControl> {
					let run = current;
					if (!run) throw unsupported("continuing a turn that is no longer running");
					run.emit = turn.emit;
					listen(run, turn.abortSignal);
					return control(run);
				},

				async doCompact() {
					throw unsupported("compaction");
				},
				async doSuspendTurn() {
					throw unsupported("suspending a turn");
				},
				doDetach: stopped,
				doStop: stopped,
				async doDestroy() {
					await (closed ??= close());
				},
			};
			open.add(handle);
			return handle;
		},

		async shutdown() {
			await Promise.allSettled([...open].map(session => session.doDestroy()));
		},
	};
}
