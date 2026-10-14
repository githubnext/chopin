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
} from "../../apps/server/src/harness/harness-v1";
import { HEADING_TOOL_NAMES } from "../../apps/server/src/harness/tool-names";
import { nameDocument } from "./fake-heading";

type FakeHarnessSettings = {
	credentials: (id: string) => string | undefined;
	limits: (id: string) => { maxAiCredits: number } | undefined;
	auth?: string;
};

const SCRIPTED_TOOLS = ["read_plan", "list_pull_requests"] as const;
const SLOW_PROMPT = "SLOW-LIVE";
/** A comment turn's prompt names its thread; this finds it. */
const COMMENT_THREAD = /using thread ([0-9A-HJKMNP-TV-Z]{26})/;
/** A comment saying this is answered only in Chat, so the server's backstop posts it. */
const BACKSTOP_PROMPT = "COMMENT-BACKSTOP";
/** Makes the fake Planner ask three decisions, appended without linked prose. */
const ASK_PROMPT = "ASK-DECISIONS";
/** With the ask, writes up and links the answered decisions before the turn ends. */
const WRITE_PROMPT = "THEN-WRITE";
const ASKED = [
	{ header: "Storage", question: "Where should room state live?" },
	{ header: "Scope", question: "What belongs in the first cut?" },
	{ header: "Rollout", question: "How should we deploy?" },
];
/** A member message asking the root's Planner to edit the child the member has open. */
const CHILD_PROMPT = "CHILD-EDIT";
const CHILD_TOOLS = ["list_children", "read_child", "edit_child"] as const;
/** The focus line `focusContext()` writes ahead of the member's words. */
const CHILD_FOCUS = /child id ([0-9a-f-]{36})/;
const STEP_MS = 2_500;
/** Proposes an investigation after the block that mentions this phrase. */
const INVESTIGATE_PROMPT = "INVESTIGATE-ANCHOR";
const INVESTIGATE_TARGET = "Cold start";

function promptText(prompt: HarnessV1PromptTurnOptions["prompt"]): string {
	if (typeof prompt === "string") return prompt;
	if (typeof prompt.content === "string") return prompt.content;
	return prompt.content.map(part => part.type === "text" ? part.text : "").join("");
}

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
					let prompt = promptText(turn.prompt);
					let heading = prompt.startsWith("[Background job: heading]\n");
					if (heading && available.size !== HEADING_TOOL_NAMES.length) {
						throw new Error("e2e-fake heading job received tools outside its scope");
					}
					for (let toolName of heading ? HEADING_TOOL_NAMES : SCRIPTED_TOOLS) {
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

					let callTool = (
						toolName: string,
						toolCallId: string = crypto.randomUUID(),
						input: Record<string, unknown> = {},
					): Promise<{ output: unknown; isError?: boolean }> => {
						let outcome = Promise.withResolvers<{ output: unknown; isError?: boolean }>();
						pending.set(toolCallId, { toolName, resolve: outcome.resolve });
						turn.emit({ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) });
						return outcome.promise;
					};

					let usage = {
						inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
						outputTokens: { total: 0, text: 0, reasoning: 0 },
					};
					let pause = () => new Promise<void>(resolve => setTimeout(resolve, STEP_MS));

					let thread = COMMENT_THREAD.exec(prompt)?.[1];
					let focused = CHILD_FOCUS.exec(prompt)?.[1];
					let finish = () => {
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
					};

					// Writes a paragraph per answered decision and links each, as a real Planner
					// does after its ask returns. Paused first, so the wait is observable.
					let writeUp = async () => {
						await pause();
						let read = await callTool("read_plan");
						let current = (JSON.parse(String(read.output)) as { revision: number }).revision;
						let edited = await callTool("edit_plan", undefined, {
							revision: current,
							operations: [{
								op: "insert",
								index: 1,
								source: ASKED.map(item => `${item.header}: we chose the first option.`)
									.join("\n\n"),
							}],
						});
						let result = JSON.parse(String(edited.output)) as {
							revision: number;
							blocks: Array<{ index: number; type: string; digest: string }>;
							anchors_pending: Array<{ widget: string; question: string }>;
						};
						let paragraphs = result.blocks.filter(block => block.type === "paragraph");
						let anchored = await callTool("anchor_plan", undefined, {
							revision: result.revision,
							anchors: result.anchors_pending.map((item, index) => ({
								widget: item.widget,
								question: item.question,
								blocks: [{ index: paragraphs[index]!.index, digest: paragraphs[index]!.digest }],
							})),
						});
						if (anchored.isError || !(JSON.parse(String(anchored.output)) as { ok: boolean }).ok) {
							throw new Error(`anchor_plan failed: ${String(anchored.output)}`);
						}
					};

					if (heading) {
						void (async () => {
							try {
								await nameDocument(prompt, callTool);
								finish();
								settled.resolve();
							} catch (err) {
								turn.emit({ type: "error", error: err });
								settled.reject(err);
							} finally {
								turn.abortSignal?.removeEventListener("abort", onAbort);
							}
						})();
					} else if (thread && !prompt.includes(SLOW_PROMPT)) {
						// A comment sent to Chopin: answer in the thread, unless the comment
						// asks to be answered only in Chat so the server's backstop is exercised.
						void (async () => {
							try {
								await pause();
								if (turn.abortSignal?.aborted) return;
								// A thread in a child is read through the child, which the turn has as focus.
								let read = focused
									? await callTool("read_child", undefined, { child: focused })
									: await callTool("read_plan");
								if (read.isError || String(read.output).startsWith("Error")) {
									throw new Error(`reading the commented document failed: ${String(read.output)}`);
								}
								let backstop = prompt.includes(BACKSTOP_PROMPT);
								if (!backstop) {
									let replied = await callTool("reply_comment", undefined, {
										thread,
										text: "Done. I tightened the passage you marked.",
									});
									if (replied.isError || String(replied.output).startsWith("Error")) {
										throw new Error(`reply_comment failed: ${String(replied.output)}`);
									}
								}
								let id = crypto.randomUUID();
								turn.emit({ type: "text-start", id });
								turn.emit({
									type: "text-delta",
									id,
									delta: backstop ? "Answered from Chat " : "I replied ",
								});
								turn.emit({
									type: "text-delta",
									id,
									delta: backstop ? "only." : "in the comment thread.",
								});
								turn.emit({ type: "text-end", id });
								finish();
								settled.resolve();
							} catch (err) {
								turn.emit({ type: "error", error: err });
								settled.reject(err);
							} finally {
								turn.abortSignal?.removeEventListener("abort", onAbort);
							}
						})();
					} else if (prompt.includes(ASK_PROMPT)) {
						void (async () => {
							try {
								if (!available.has("ask")) throw new Error("e2e-fake harness expected ask");
								let plan = await callTool("read_plan");
								let revision = (JSON.parse(String(plan.output)) as { revision: number }).revision;
								// The turn stays open until people answer, as a real ask does.
								await callTool("ask", crypto.randomUUID(), {
									revision,
									questions: ASKED.map(item => ({
										...item,
										multiple: false,
										blocks: [],
										options: [
											{ label: "First option", description: "" },
											{ label: "Second option", description: "" },
										],
									})),
								});
								if (prompt.includes(WRITE_PROMPT)) await writeUp();
								finish();
								settled.resolve();
							} catch (err) {
								turn.emit({ type: "error", error: err });
								settled.reject(err);
							} finally {
								turn.abortSignal?.removeEventListener("abort", onAbort);
							}
						})();
					} else if (prompt.includes(CHILD_PROMPT)) {
						void (async () => {
							try {
								for (let toolName of CHILD_TOOLS) {
									if (!available.has(toolName)) {
										throw new Error(`e2e-fake harness expected host tool ${toolName}`);
									}
								}
								if (!focused) throw new Error("CHILD-EDIT turn had no focused child");
								let listed = await callTool("list_children");
								let children = JSON.parse(String(listed.output)) as {
									children: { id: string; focused?: boolean }[];
								};
								if (!children.children.some(item => item.id === focused && item.focused)) {
									throw new Error("list_children did not mark the focused child");
								}
								let read = await callTool("read_child", undefined, { child: focused });
								let view = JSON.parse(String(read.output)) as {
									revision: number;
									blocks: unknown[];
								};
								let edited = await callTool("edit_child", undefined, {
									child: focused,
									revision: view.revision,
									operations: [{
										op: "insert",
										index: view.blocks.length - 1,
										source: "Planner note from the root Chat.",
									}],
								});
								if (!String(edited.output).includes('"ok": true')) {
									throw new Error(`edit_child failed: ${String(edited.output)}`);
								}
								let id = crypto.randomUUID();
								turn.emit({ type: "text-start", id });
								turn.emit({ type: "text-delta", id, delta: "I edited " });
								turn.emit({ type: "text-delta", id, delta: "the open child." });
								turn.emit({ type: "text-end", id });
								finish();
								settled.resolve();
							} catch (err) {
								turn.emit({ type: "error", error: err });
								settled.reject(err);
							} finally {
								turn.abortSignal?.removeEventListener("abort", onAbort);
							}
						})();
					} else if (prompt.includes("REQUIRE-REMOVED-INVESTIGATION")) {
						void (async () => {
							try {
								let listed = await callTool("list_investigations");
								let { investigations } = JSON.parse(String(listed.output)) as {
									investigations: { id: string; revision: number; state: string }[];
								};
								let value = investigations.find(item => item.state === "cancelled");
								if (!value) throw new Error("No withdrawn investigation");
								let result = await callTool("set_investigation_build_blocker", undefined, {
									id: value.id,
									revision: value.revision,
									reason: "Choose a cache",
								});
								let id = crypto.randomUUID();
								turn.emit({ type: "text-start", id });
								turn.emit({ type: "text-delta", id, delta: String(result.output) });
								turn.emit({ type: "text-end", id });
								finish();
								settled.resolve();
							} catch (err) {
								turn.emit({ type: "error", error: err });
								settled.reject(err);
							}
						})();
					} else if (prompt.includes(INVESTIGATE_PROMPT)) {
						void (async () => {
							try {
								let plan = await callTool("read_plan");
								if (plan.isError) throw new Error(`read_plan failed: ${String(plan.output)}`);
								let { blocks } = JSON.parse(String(plan.output)) as {
									blocks: { index: number; preview: string; digest: string }[];
								};
								let block = blocks.find(item => item.preview.includes(INVESTIGATE_TARGET));
								if (!block) throw new Error("read_plan has no block to investigate");
								let proposed = await callTool("propose_investigation", undefined, {
									brief: "Measure cold start time on a local checkout.",
									...(prompt.includes("REQUIRED")
										? {
											buildBlocker: "Choose the cache approach from measured cold start times.",
										}
										: {}),
									key: "anchor",
									after: { index: block.index, digest: block.digest },
								});
								let output = String(proposed.output);
								if (proposed.isError || output.startsWith("Error")) {
									throw new Error(`propose_investigation failed: ${output}`);
								}
								let placement = (JSON.parse(output) as { placement?: string }).placement;
								let id = crypto.randomUUID();
								turn.emit({ type: "text-start", id });
								turn.emit({ type: "text-delta", id, delta: "Proposed an investigation, " });
								turn.emit({ type: "text-delta", id, delta: `${placement}.` });
								turn.emit({ type: "text-end", id });
								finish();
								settled.resolve();
							} catch (err) {
								turn.emit({ type: "error", error: err });
								settled.reject(err);
							} finally {
								turn.abortSignal?.removeEventListener("abort", onAbort);
							}
						})();
					} else if (prompt.includes(SLOW_PROMPT)) {
						void (async () => {
							try {
								let toolCallId = crypto.randomUUID();
								turn.emit({ type: "reasoning-start", id: "slow-thinking" });
								turn.emit({
									type: "reasoning-delta",
									id: "slow-thinking",
									delta: "Considering the plan.",
								});
								turn.emit({ type: "reasoning-end", id: "slow-thinking" });
								turn.emit({ type: "tool-input-start", id: toolCallId, toolName: "read_plan" });
								await pause();
								if (turn.abortSignal?.aborted) return;
								await callTool("read_plan", toolCallId);
								let id = crypto.randomUUID();
								turn.emit({ type: "text-start", id });
								turn.emit({ type: "text-delta", id, delta: "Streaming " });
								await pause();
								turn.emit({ type: "text-delta", id, delta: "slowly" });
								await pause();
								turn.emit({ type: "text-delta", id, delta: " now." });
								turn.emit({ type: "text-end", id });
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
					} else {void (async () => {
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
						})();}

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
