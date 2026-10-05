import { expect, test } from "bun:test";
import * as Chat from "./service";
import * as Plan from "../plan/service";
import * as Room from "../plan/room";
import { openPlan } from "../testing/plan";
import { authenticatedMemory } from "./job-authenticated-memory.test-fixtures";
import { createPlannerAgent } from "../harness/agents";
import { openPlannerSession } from "../harness/session";

import type { HarnessV1 } from "@ai-sdk/harness";
import type { Socket } from "../wire";

for (let destroyThrows of [false, true]) {
	test(`stopping a Planner ask drains the next turn when teardown ${destroyThrows ? "fails" : "succeeds"}`, async () => {
		let opened = await openPlan("Related prose.\n");
		let identity = await authenticatedMemory(opened);
		let asked = Promise.withResolvers<void>();
		let secondStarted = Promise.withResolvers<void>();
		let originalPublish = opened.server.publish.bind(opened.server);
		opened.server.publish = (topic, body, ...rest) => {
			if (typeof body === "string") {
				let frame = JSON.parse(body) as { kind: string };
				if (frame.kind === "question:asked") asked.resolve();
			}
			return originalPublish(topic, body, ...rest);
		};
		let calls = 0;
		let destroys = 0;
		let args = {
			revision: opened.plan.revision,
			questions: [{
				header: "Rollout",
				question: "How should we deploy?",
				multiple: false,
				options: [{ label: "Canary", description: "Limit exposure." }],
				blocks: [{ index: 0, digest: Room.digests(opened.plan.document)[0]! }],
			}],
		};
		let fake: HarnessV1 = {
			specificationVersion: "harness-v1",
			harnessId: "chat-stuck-turn",
			builtinTools: {},
			async doStart(start) {
				return {
					sessionId: start.sessionId,
					isResume: false,
					async doPromptTurn(options) {
						calls++;
						let done = Promise.withResolvers<void>();
						let finish = () => {
							options.emit({
								type: "finish-step",
								finishReason: { unified: "stop", raw: undefined },
								usage: {
									inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
									outputTokens: { total: 0, text: 0, reasoning: 0 },
								},
							});
							done.resolve();
						};
						if (calls === 1) {
							queueMicrotask(() =>
								options.emit({
									type: "tool-call",
									toolCallId: "pending-question",
									toolName: "ask",
									input: JSON.stringify(args),
								})
							);
						} else {
							secondStarted.resolve();
							queueMicrotask(() => {
								options.emit({ type: "text-start", id: "reply" });
								options.emit({ type: "text-delta", id: "reply", delta: "I can respond now." });
								options.emit({ type: "text-end", id: "reply" });
								finish();
							});
						}
						return {
							done: done.promise,
							async submitToolResult(value) {
								options.emit({
									type: "tool-result",
									toolCallId: value.toolCallId,
									toolName: "ask",
									result: value.output as string,
								});
								finish();
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
		identity.context.openPlannerSession = (owner, channel) =>
			openPlannerSession(owner, channel, {
				agent: createPlannerAgent(fake),
				githubTools: async () => ({ ok: true, value: {} }),
				createSandbox: async () =>
					({
						defaultWorkingDirectory: "/tmp",
						async run() {
							return { exitCode: 0, stdout: "", stderr: "" };
						},
						async destroy() {
							destroys++;
							if (destroyThrows && destroys === 1) throw new Error("sandbox destroy failed");
						},
					}) as never,
				registerCredential: () => () => {},
			});
		let socket = {
			data: { handle: "ana", principalId: "U_test" },
			send() {},
		} as unknown as Socket;
		try {
			await Chat.send(identity.context, socket, {
				kind: "chat:send",
				rid: "first",
				requestId: crypto.randomUUID(),
				text: "Draft a rollout plan",
				to: "planner",
				ts: 0,
			});
			let running = opened.plan.chat.running;
			expect(running).toBeDefined();
			await Promise.race([
				asked.promise,
				Bun.sleep(1_500).then(() => {
					throw new Error("Planner ask did not publish a question");
				}),
			]);
			await Chat.send(identity.context, socket, {
				kind: "chat:send",
				rid: "second",
				requestId: crypto.randomUUID(),
				text: "Try again",
				to: "planner",
				ts: 0,
			});
			expect(opened.plan.chat.waiting).toHaveLength(1);
			await Chat.abort(identity.context, socket);
			await Chat.abort(identity.context, socket);
			await Promise.race([
				running,
				Bun.sleep(3_000).then(() => {
					throw new Error("Planner turn did not settle");
				}),
			]);
			await Promise.race([
				secondStarted.promise,
				Bun.sleep(3_000).then(() => {
					throw new Error("Queued Planner turn did not start");
				}),
			]);
			expect(opened.plan.chat.entries.filter(entry => entry.text === "@ana stopped the turn."))
				.toHaveLength(1);
			expect([...opened.plan.records.values()].map(record => record.status)).toEqual(["cancelled"]);
			expect(opened.plan.questions.open.size).toBe(0);
			expect(opened.plan.chat.entries.flatMap(entry => entry.tools ?? []).map(tool => tool.status))
				.toEqual(["failed"]);
			expect(opened.plan.chat.busy).toBe(false);
			expect(opened.plan.chat.turn).toBeUndefined();
			expect(opened.plan.chat.waiting).toEqual([]);
			expect(opened.plan.chat.entries.some(entry => entry.text === "I can respond now.")).toBe(
				true,
			);
			expect(calls).toBe(2);
			expect(destroys).toBe(2);
		} finally {
			identity.revokeAll();
			await Plan.close(opened.plan);
		}
	});
}
