import {
	held,
	readScript,
	substitute,
} from "../../apps/server/src/conversation-plan/scripted-script";
import { readRevision, scriptContext } from "./scripted-context";

import type { HarnessV1, HarnessV1StreamPart } from "../../apps/server/src/harness/harness-v1";

type Result = { toolCallId: string; toolName: string; output: unknown; isError?: boolean };
type ToolResult = Extract<HarnessV1StreamPart, { type: "tool-result" }>;

/** The SDK executes tools; this test driver supplies only the scripted model side. */
export function createPromptScriptedHarness(
	dir: string,
	observe: { onResult?: (result: Result) => Promise<void> | void } = {},
) {
	let tools: string[][] = [];
	let calls: Array<{ toolCallId: string; toolName: string; input: unknown }> = [];
	let results: Result[] = [];
	let entered = Promise.withResolvers<void>();
	let released = Promise.withResolvers<void>();
	let starts = 0;
	let destroyed = 0;
	let destroyers = new Set<() => Promise<void>>();
	let shuttingDown = false;
	let shutdown: Promise<void[]> | undefined;
	let fake: HarnessV1 & { shutdown(): Promise<void> } = {
		specificationVersion: "harness-v1",
		harnessId: "prompt-scripted-jobs",
		builtinTools: {},
		async shutdown() {
			shuttingDown = true;
			await (shutdown ??= Promise.all([...destroyers].map(destroy => destroy())));
		},
		async doStart(start) {
			if (shuttingDown) throw new Error("scripted Harness is shut down");
			let turns = new Set<() => void>();
			let tasks = new Set<Promise<void>>();
			let destruction: Promise<void> | undefined;
			let track = (task: Promise<void>) => {
				tasks.add(task);
				void task.then(() => tasks.delete(task), () => tasks.delete(task));
			};
			let drain = async () => {
				while (tasks.size) await Promise.allSettled(tasks);
			};
			let destroy = () => {
				destruction ??= (async () => {
					for (let finish of turns) finish();
					await drain();
					destroyed++;
					destroyers.delete(destroy);
				})();
				return destruction;
			};
			destroyers.add(destroy);
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(options) {
					if (destruction) throw new Error("scripted Harness session is destroyed");
					starts++;
					tools.push(options.tools.map(spec => spec.name));
					let done = Promise.withResolvers<void>();
					let pending = new Map<string, {
						name: string;
						resolve: (result?: Result) => void;
					}>();
					let submissions = new Set<Promise<void>>();
					let stop = new AbortController();
					let finished = false;
					let current = () => !finished && !options.abortSignal?.aborted;
					let finish = () => {
						if (finished) return;
						finished = true;
						stop.abort();
						options.abortSignal?.removeEventListener("abort", finish);
						turns.delete(finish);
						for (let entry of pending.values()) entry.resolve();
						pending.clear();
						options.emit({
							type: "finish-step",
							finishReason: { unified: "stop", raw: undefined },
							usage: {
								inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
								outputTokens: { total: 0, text: 0, reasoning: 0 },
							},
						});
					};
					let fail = (error: unknown) => {
						if (finished) return;
						options.emit({ type: "error", error });
						finish();
					};
					turns.add(finish);
					options.abortSignal?.addEventListener("abort", finish, { once: true });
					if (options.abortSignal?.aborted) finish();
					let request = (name: string, input: unknown) => {
						let toolCallId = crypto.randomUUID();
						let returned = Promise.withResolvers<Result | undefined>();
						pending.set(toolCallId, { name, resolve: returned.resolve });
						calls.push({ toolCallId, toolName: name, input });
						options.emit({
							type: "tool-call",
							toolCallId,
							toolName: name,
							input: JSON.stringify(input),
						});
						return returned.promise;
					};
					let driving = (async () => {
						try {
							if (finished) return;
							let { kind, target } = scriptContext(options.prompt);
							let script = await readScript(dir, kind);
							if (!current()) return finish();
							entered.resolve();
							let gate = await held(dir, kind, stop.signal);
							if (gate === "timed-out") throw new Error("Scripted Planner job hold timed out.");
							if (gate !== "released" || !current()) return finish();
							released.resolve();
							for (let call of script) {
								if (!current()) return finish();
								let read = await request("read_plan", {});
								if (!read || !current()) return finish();
								let revision = readRevision(read);
								await request(call.tool, substitute(call.args, revision, target));
							}
							finish();
						} catch (error) {
							fail(error);
						} finally {
							await Promise.allSettled(submissions);
							done.resolve();
						}
					})();
					track(driving);
					return {
						done: done.promise,
						submitToolResult(value) {
							let submission = (async () => {
								let entry = pending.get(value.toolCallId);
								if (!entry || !current()) return finish();
								let result: Result = {
									toolCallId: value.toolCallId,
									toolName: entry.name,
									output: value.output,
									...(value.isError !== undefined ? { isError: value.isError } : {}),
								};
								try {
									results.push(result);
									await observe.onResult?.(result);
									if (!current()) return finish();
									options.emit({
										type: "tool-result",
										toolCallId: value.toolCallId,
										toolName: entry.name,
										result: value.output as ToolResult["result"],
										...(value.isError !== undefined ? { isError: value.isError } : {}),
									});
								} catch (error) {
									fail(error);
								} finally {
									pending.delete(value.toolCallId);
									entry.resolve(result);
								}
							})();
							submissions.add(submission);
							track(submission);
							void submission.then(
								() => submissions.delete(submission),
								() => submissions.delete(submission),
							);
							return submission;
						},
					};
				},
				doDestroy: destroy,
				async doCompact() {
					throw new Error("scripted Harness does not support compaction");
				},
				async doContinueTurn() {
					throw new Error("scripted Harness does not support continuing a turn");
				},
				async doSuspendTurn() {
					throw new Error("scripted Harness does not support suspending a turn");
				},
				async doDetach() {
					throw new Error("scripted Harness does not support detaching a turn");
				},
				async doStop() {
					for (let finish of turns) finish();
					await drain();
					return {
						type: "resume-session",
						harnessId: "prompt-scripted-jobs",
						specificationVersion: "harness-v1",
						data: null,
					};
				},
			};
		},
	};
	return {
		fake,
		tools,
		calls,
		results,
		starts: () => starts,
		destroyed: () => destroyed,
		entered: entered.promise,
		released: released.promise,
	};
}
