/**
 * Fails the turn (rather than falling back to a placeholder reply) if either
 * scripted tool is missing from `turn.tools`, so a broken host tool wiring
 * shows up as a failed turn instead of a quietly hollow one.
 */
import type {
	HarnessV1,
	HarnessV1PromptControl,
	HarnessV1PromptTurnOptions,
	HarnessV1Session,
	HarnessV1StartOptions,
} from "../../apps/server/node_modules/@ai-sdk/harness";

type FakeHarnessSettings = {
	credentials: (id: string) => string | undefined;
	limits: (id: string) => { maxAiCredits: number } | undefined;
	auth?: string;
};

const SCRIPTED_TOOLS = ["read_plan", "list_pull_requests"] as const;

function unsupported(capability: string): () => Promise<never> {
	return async () => {
		throw new Error(`e2e-fake harness does not support ${capability}.`);
	};
}

/** Chunked so a real turn always has at least one `text-delta` broadcast after the
 * message-creating first chunk (`translate()` in `chat/service.ts` folds the
 * first `text-delta` into the message it creates, and only broadcasts `chat:delta`
 * for chunks after that). */
function deriveReply(results: Map<string, { output: unknown; isError?: boolean }>): string[] {
	let plan = results.get("read_plan")!;
	if (plan.isError) throw new Error(`read_plan failed: ${String(plan.output)}`);
	let parsedPlan = JSON.parse(String(plan.output)) as { source?: string };
	let firstLine = parsedPlan.source?.split("\n").find(line => line.trim().length > 0);
	if (!firstLine) throw new Error("read_plan returned no source");
	let planHeading = firstLine.replace(/^#+\s*/, "").trim();

	let pulls = results.get("list_pull_requests")!;
	if (pulls.isError) throw new Error(`list_pull_requests failed: ${String(pulls.output)}`);
	let content = (pulls.output as { content?: { type: string; text?: string }[] }).content;
	let text = content?.find(part => part.type === "text")?.text;
	let parsedPulls = text ? JSON.parse(text) as { title?: string }[] : [];
	if (!parsedPulls[0]?.title) throw new Error("list_pull_requests returned no titles");

	return ["Plan: ", `${planHeading}.`, " Latest pull request: ", `${parsedPulls[0].title}.`];
}

export function createFakeHarness(
	_settings: FakeHarnessSettings,
): HarnessV1 & { shutdown(): Promise<void> } {
	return {
		specificationVersion: "harness-v1",
		harnessId: "e2e-fake",
		builtinTools: {},
		supportsBuiltinToolFiltering: true,

		async doStart(startOptions: HarnessV1StartOptions): Promise<HarnessV1Session> {
			return {
				sessionId: startOptions.sessionId,
				isResume: false,

				async doPromptTurn(turn: HarnessV1PromptTurnOptions): Promise<HarnessV1PromptControl> {
					let available = new Set(turn.tools.map(spec => spec.name));
					for (let toolName of SCRIPTED_TOOLS) {
						if (!available.has(toolName)) {
							throw new Error(`e2e-fake harness expected host tool ${toolName}`);
						}
					}
					if (available.has("search_code")) {
						throw new Error("e2e-fake harness received a tool outside the GitHub allowlist");
					}

					let pending = new Map<string, {
						toolName: string;
						resolve: (result: { output: unknown; isError?: boolean }) => void;
					}>();
					let results = new Map<string, { output: unknown; isError?: boolean }>();
					let settled = Promise.withResolvers<void>();
					let onAbort = () => {
						for (let [toolCallId, entry] of pending) {
							entry.resolve({ output: "The turn was aborted.", isError: true });
							pending.delete(toolCallId);
						}
						settled.resolve();
					};
					turn.abortSignal?.addEventListener("abort", onAbort, { once: true });

					let callTool = (toolName: string): Promise<{ output: unknown; isError?: boolean }> => {
						let toolCallId = crypto.randomUUID();
						let outcome = Promise.withResolvers<{ output: unknown; isError?: boolean }>();
						pending.set(toolCallId, { toolName, resolve: outcome.resolve });
						turn.emit({ type: "tool-call", toolCallId, toolName, input: "{}" });
						return outcome.promise;
					};

					void (async () => {
						try {
							for (let toolName of SCRIPTED_TOOLS) {
								if (turn.abortSignal?.aborted) return;
								results.set(toolName, await callTool(toolName));
							}
							if (turn.abortSignal?.aborted) return;
							let chunks = deriveReply(results);
							let id = crypto.randomUUID();
							turn.emit({ type: "text-start", id });
							for (let chunk of chunks) turn.emit({ type: "text-delta", id, delta: chunk });
							turn.emit({ type: "text-end", id });
							let usage = {
								inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
								outputTokens: { total: 0, text: 0, reasoning: 0 },
							};
							turn.emit({
								type: "finish-step",
								finishReason: { unified: "stop", raw: undefined },
								usage,
							});
							turn.emit({
								type: "finish",
								finishReason: { unified: "stop", raw: undefined },
								totalUsage: usage,
							});
							settled.resolve();
						} catch (err) {
							turn.emit({ type: "error", error: err });
							settled.reject(err);
						} finally {
							turn.abortSignal?.removeEventListener("abort", onAbort);
						}
					})();

					return {
						async submitToolResult({ toolCallId, output, isError }) {
							let entry = pending.get(toolCallId);
							if (!entry) return;
							pending.delete(toolCallId);
							turn.emit({
								type: "tool-result",
								toolCallId,
								toolName: entry.toolName,
								result: (output ?? null) as NonNullable<unknown>,
								isError,
							});
							entry.resolve({ output, isError });
						},
						async submitToolApproval() {},
						done: settled.promise,
					};
				},

				doCompact: unsupported("compaction"),
				doContinueTurn: unsupported("continuing a suspended turn"),
				doSuspendTurn: unsupported("suspending a turn"),
				doDetach: unsupported("detaching from a live session"),
				doStop: unsupported("stopping with resumable state"),
				async doDestroy() {},
			};
		},

		async shutdown() {},
	};
}
