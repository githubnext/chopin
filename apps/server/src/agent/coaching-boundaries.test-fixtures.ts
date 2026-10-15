import { createPlannerAgent } from "../harness/agents";
import { openPlannerSession } from "../harness/session";
import * as Plan from "../plan/service";
import { hostInputRoom } from "../testing/decisions";
import { plannerInstructions } from "./planner";

import type { HarnessV1 } from "@ai-sdk/harness";
import type { ActiveOwnerBinding } from "./active-owner";
import type { DocumentRoom } from "./tools";
import type { Block } from "../plan/edit";

export type View = { revision: number; source: string; blocks: Block[] };
export type Call = { tool: string; input: unknown };
export type Step = (output: unknown) => Call | string | Promise<Call | string>;

export function decoded<T>(output: unknown): T {
	if (typeof output !== "string") throw new Error("Expected a text tool result");
	return JSON.parse(output) as T;
}

export function address(view: View, text: string) {
	let block = view.blocks.find(block => block.preview.includes(text));
	if (!block) throw new Error(`Missing block: ${text}`);
	return { index: block.index, digest: block.digest };
}

/** Scripted turns exercise host execution; they do not evaluate a model's coaching judgment. */
export async function coachingFixture(steps: Step[], authorized = true) {
	let host = await hostInputRoom();
	let room: DocumentRoom = {
		...host.room,
		exclusive: action => Plan.exclusive(host.plan, action),
		persist: () => Plan.persist(host.plan),
		publish: mutation => Plan.publish(host.plan, host.server, host.plan.id, mutation),
		changes() {},
	};
	let calls: Call[] = [];
	let results: Array<{ tool: string; output: unknown; isError?: boolean }> = [];
	let names: string[] = [];
	let texts: string[] = [];
	let starts = 0;
	let sandboxes = 0;
	let stops = new Set<() => void>();
	let fake: HarnessV1 = {
		specificationVersion: "harness-v1",
		harnessId: "coaching-boundaries",
		builtinTools: {},
		async doStart(start) {
			starts++;
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(turn) {
					names = turn.tools.map(spec => spec.name);
					let done = Promise.withResolvers<void>();
					let finished = false;
					let pending: Call | undefined;
					let callId = "";
					let finish = () => {
						if (finished) return;
						finished = true;
						stops.delete(finish);
						turn.abortSignal?.removeEventListener("abort", finish);
						turn.emit({
							type: "finish-step",
							finishReason: { unified: "stop", raw: undefined },
							usage: {
								inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
								outputTokens: { total: 0, text: 0, reasoning: 0 },
							},
						});
						done.resolve();
					};
					let advance = async (output?: unknown) => {
						if (finished || turn.abortSignal?.aborted) return finish();
						try {
							let step = steps.shift();
							if (!step) throw new Error("Script ended without a response");
							let next = await step(output);
							if (finished || turn.abortSignal?.aborted) return finish();
							if (typeof next === "string") {
								texts.push(next);
								turn.emit({ type: "text-start", id: "coaching" });
								turn.emit({ type: "text-delta", id: "coaching", delta: next });
								turn.emit({ type: "text-end", id: "coaching" });
								return finish();
							}
							pending = next;
							calls.push(next);
							callId = `coach-${calls.length}`;
							turn.emit({
								type: "tool-call",
								toolCallId: callId,
								toolName: next.tool,
								input: JSON.stringify(next.input),
							});
						} catch (error) {
							turn.emit({ type: "error", error });
							finish();
						}
					};
					stops.add(finish);
					turn.abortSignal?.addEventListener("abort", finish, { once: true });
					queueMicrotask(() => void advance());
					return {
						done: done.promise,
						async submitToolResult(value) {
							if (finished || !pending) return;
							results.push({ tool: pending.tool, output: value.output, isError: value.isError });
							turn.emit({
								type: "tool-result",
								toolCallId: callId,
								toolName: pending.tool,
								result: value.output as string,
								...(value.isError === undefined ? {} : { isError: value.isError }),
							});
							await advance(value.output);
						},
					};
				},
				async doDestroy() {
					for (let stop of stops) stop();
				},
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
	let controller = new AbortController();
	let owner: ActiveOwnerBinding = {
		channelId: room.id,
		token: "coaching-test-token",
		repository: { id: "R_test", owner: "org", name: "repo", defaultBranch: "main" },
		ownerSessionId: "coaching-owner",
		ownerGeneration: 1,
		credentialRevision: 1,
		expiresAt: new Date(Date.now() + 60_000),
		signal: controller.signal,
		currentToken: () => "coaching-test-token",
		revalidate: async () => authorized,
		release() {},
	};
	let opened = await openPlannerSession(owner, {
		room,
		repository: owner.repository,
		instructions: plannerInstructions("org/repo"),
	}, {
		agent: createPlannerAgent(fake),
		githubTools: async () => ({ ok: true, value: {} }),
		createSandbox: async () => {
			sandboxes++;
			return {
				defaultWorkingDirectory: "/tmp",
				async run() {
					return { exitCode: 0, stdout: "", stderr: "" };
				},
				async destroy() {},
			} as never;
		},
		registerCredential: () => () => {},
	});
	return {
		host,
		room,
		owner,
		controller,
		opened,
		calls,
		results,
		texts,
		names: () => names,
		allocations: () => ({ starts, sandboxes }),
		async saved() {
			let stored = await host.storage.collaboration.load(room.id, new Date());
			if (!stored) throw new Error("Missing saved document");
			return { ...await Plan.readStored(stored), sidecar: stored.sidecar };
		},
		async run(signal = controller.signal) {
			if (!opened.ok) throw new Error(`Planner did not open: ${opened.error.kind}`);
			let stream = await opened.value.stream("Help us understand this decision workflow.", signal);
			let parts = [];
			for await (let part of stream.fullStream) {
				if (part.type === "error") throw part.error;
				parts.push(part);
			}
			return parts;
		},
		async close() {
			if (opened.ok) await opened.value.destroy();
			await host.close();
		},
	};
}
