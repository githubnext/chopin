import { afterEach, expect, test } from "bun:test";

import { createPlannerAgent } from "../harness/agents";
import { openPlannerSession } from "../harness/session";
import * as Plan from "../plan/service";
import { openPlan } from "../testing/plan";
import { authenticatedMemory } from "./job-authenticated-memory.test-fixtures";
import * as Chat from "./service";

import type { HarnessV1 } from "@ai-sdk/harness";
import type { Socket } from "../wire";

afterEach(() => Chat.holdStarts(false));

/** A Planner whose turns end only when the test lets them, or when they are aborted. */
function planner() {
	let turns: Array<{ release(): void; aborted: boolean }> = [];
	let fake: HarnessV1 = {
		specificationVersion: "harness-v1",
		harnessId: "chat-stopping-turns",
		builtinTools: {},
		async doStart(start) {
			return {
				sessionId: start.sessionId,
				isResume: false,
				async doPromptTurn(options) {
					let done = Promise.withResolvers<void>();
					let turn = { release: () => finish(), aborted: false };
					turns.push(turn);
					options.abortSignal?.addEventListener("abort", () => {
						turn.aborted = true;
						done.resolve();
					}, { once: true });
					let finish = () => {
						options.emit({ type: "text-start", id: "reply" });
						options.emit({ type: "text-delta", id: "reply", delta: `reply ${turns.length}` });
						options.emit({ type: "text-end", id: "reply" });
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
					return { done: done.promise, async submitToolResult() {} };
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
	return { fake, turns };
}

async function room() {
	let opened = await openPlan("Related prose.\n");
	let identity = await authenticatedMemory(opened);
	let { fake, turns } = planner();
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
					async destroy() {},
				}) as never,
			registerCredential: () => () => {},
		});
	let socket = {
		data: { handle: "ana", principalId: "U_test" },
		send() {},
	} as unknown as Socket;
	let send = (text: string) =>
		Chat.send(identity.context, socket, {
			kind: "chat:send",
			rid: crypto.randomUUID(),
			requestId: crypto.randomUUID(),
			text,
			to: "planner",
			ts: 0,
		});
	let finish = async () => {
		identity.revokeAll();
		await Plan.close(opened.plan);
	};
	return { opened, send, turns, finish };
}

async function until(check: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 300 && !check(); attempt++) await Bun.sleep(10);
	if (!check()) throw new Error(`timed out waiting for ${what}`);
}

test("a turn that ends while the process is stopping leaves the next queued request waiting, unstarted", async () => {
	let { opened, send, turns, finish } = await room();
	try {
		await send("first");
		await until(() => turns.length === 1, "the first turn to start");
		await send("second");
		expect(opened.plan.chat.waiting).toHaveLength(1);
		Chat.holdStarts();
		turns[0]!.release();
		await opened.plan.chat.running;
		expect(turns).toHaveLength(1);
		expect(opened.plan.chat.busy).toBe(false);
		expect(opened.plan.chat.waiting).toHaveLength(1);
	} finally {
		await finish();
	}
});

test("a request that arrives while the process is stopping is acknowledged as queued, and starts no turn", async () => {
	let { opened, send, turns, finish } = await room();
	try {
		Chat.holdStarts();
		await send("hello");
		await Bun.sleep(50);
		expect(turns).toHaveLength(0);
		expect(opened.plan.chat.busy).toBe(false);
		expect(opened.plan.chat.waiting).toMatchObject([{ text: "hello" }]);
	} finally {
		await finish();
	}
});

test("a running turn that is cut off says so in the Chat, once, and the process then closes it", async () => {
	let { opened, send, turns, finish } = await room();
	try {
		await send("a long one");
		await until(() => turns.length === 1, "the turn to start");
		Chat.interrupt(opened.plan.chat, "A restart interrupted this reply.");
		await Chat.settled(opened.plan.chat);
		let notices = opened.plan.chat.entries.filter(entry =>
			entry.author.kind === "system" && entry.text === "A restart interrupted this reply."
		);
		expect(notices).toHaveLength(1);
		expect(opened.plan.chat.busy).toBe(false);
	} finally {
		await finish();
	}
});
