import { afterEach, describe, expect, test } from "bun:test";

import { connectAgent } from "@chopin/agent-link/client";
import { ActiveOwnerBindings } from "../agent/active-owner";
import { decideReplying } from "../conversation-plan/decisions.test-fixtures";
import { createPlannerAgent } from "../harness/agents";
import { createAtomicAdapter } from "../harness/atomic/adapter";
import { registerFullPlanner } from "../harness/atomic/full";
import { startStubModelServer } from "../harness/atomic/model-stub";
import { createRemoteAdapter } from "../harness/remote/adapter";
import { openPlannerSession } from "../harness/session";
import * as Plan from "../plan/service";
import { finishTurn, linkAuth, linkServer, MEMBER_TOKEN } from "../testing/agent-link";
import { configured } from "../testing/config";
import * as Chat from "./service";
import * as Threads from "./threads";

import type { ServerMessageOf } from "@chopin/agent-link";
import type { Chat as Wire } from "@chopin/protocol";
import type { Server } from "bun";
import type { HostedAuth } from "../auth/routes";
import type { PlannerSession } from "../harness/session";
import type { Socket, SocketData } from "../wire";

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function buildWorld() {
	let { auth, storage, channel, logins } = await linkAuth();
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let broadcasts: Array<Wire.Outgoing> = [];
	let publisher = {
		publish(_topic: string, message: string) {
			broadcasts.push(JSON.parse(message) as Wire.Outgoing);
		},
	} as unknown as Server<SocketData>;
	let plan = await Plan.open(
		channel.id,
		{
			storage,
			lease: () => lease,
			fatal: error => {
				throw error;
			},
		},
		publisher,
	);
	let owners = new ActiveOwnerBindings(auth as unknown as HostedAuth);
	let prompts: Array<{ instructions: string; prompt: string }> = [];
	let emitExtra:
		| ((emit: (part: Record<string, unknown>) => void) => Promise<void> | void)
		| undefined;

	let fakeOpen: typeof openPlannerSession = async (_binding, options) => {
		let instructions = typeof options.instructions === "function"
			? options.instructions(undefined)
			: options.instructions;
		let session: PlannerSession = {
			stream: (prompt, _signal) => {
				prompts.push({ instructions, prompt });
				async function* parts() {
					if (emitExtra) {
						let extraParts: Array<Record<string, unknown>> = [];
						await emitExtra(part => extraParts.push(part));
						for (let part of extraParts) yield part as never;
					}
					let id = crypto.randomUUID();
					yield { type: "text-start", id } as never;
					yield {
						type: "text-delta",
						id,
						text: `Answer to: ${prompt.split("\n").at(-1)}`,
					} as never;
					yield { type: "text-end", id } as never;
					yield {
						type: "finish",
						finishReason: { unified: "stop", raw: undefined },
						totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					} as never;
				}
				return { fullStream: parts() } as never;
			},
			destroy: async () => {},
		};
		return { ok: true, value: session };
	};

	let context = Threads.bindTopLevel({
		decide: decideReplying({ input: { type: "noul", noul: 0 } }),
		chat: plan.chat,
		plan,
		room: channel.id,
		server: publisher,
		auth: auth as unknown as HostedAuth,
		repository: { id: "R_score", owner: "octo-org", name: "score", defaultBranch: "main" },
		config: configured({ BACKGROUND_JOBS: "off" }),
		claimantSessionId: logins.get("member"),
		activeOwner: () => owners.resolve(channel.id),
		persist: () => Plan.persist(plan),
		openPlannerSession: fakeOpen,
	});

	cleanups.push(async () => {
		owners.revokeAll();
		await Chat.close(plan.chat);
		await Plan.close(plan);
	});

	function makeSocket(handle: string, principalId: string, canEdit = true) {
		let frames: Array<Record<string, unknown>> = [];
		let ws = {
			data: {
				handle,
				principalId,
				sessionId: logins.get("member"),
				canEdit,
			},
			send(raw: string) {
				frames.push(JSON.parse(raw));
			},
		} as unknown as Socket;
		return { ws, frames };
	}

	return {
		auth,
		storage,
		lease,
		channel,
		logins,
		plan,
		owners,
		context,
		broadcasts,
		prompts,
		setEmitExtra: (fn: typeof emitExtra) => {
			emitExtra = fn;
		},
		makeSocket,
	};
}

describe("Chat threads server", () => {
	test("forks context up to the root, accumulates in the thread, isolates from main Chat, and supports Also send to Chat", async () => {
		let w = await buildWorld();
		let alice = w.makeSocket("alice", "U_alice");
		let bob = w.makeSocket("bob", "U_bob");

		let rootReq = crypto.randomUUID();
		await Threads.sendMessage(w.context, alice.ws, {
			kind: "chat:send",
			rid: "r1",
			requestId: rootReq,
			to: "room",
			text: "Root: let us use PostgreSQL.",
			ts: 0,
		});
		await Threads.sendMessage(w.context, bob.ws, {
			kind: "chat:send",
			rid: "r2",
			requestId: crypto.randomUUID(),
			to: "room",
			text: "Later main message after root.",
			ts: 0,
		});

		// Start a thread at `rootReq` and ask the Planner a side question.
		let threadReq1 = crypto.randomUUID();
		await Threads.sendMessage(w.context, alice.ws, {
			kind: "chat:send",
			rid: "t1",
			requestId: threadReq1,
			to: "planner",
			thread: rootReq,
			text: "@chopin what index do we need?",
			ts: 0,
		});
		let threadChat = w.plan.chat.childChats?.get(rootReq);
		expect(threadChat).toBeDefined();
		await threadChat!.running;

		// 1. Thread turn 1 sees the root message and NOT "Later main message after root."
		expect(w.prompts).toHaveLength(1);
		expect(w.prompts[0]!.instructions).toContain("Root: let us use PostgreSQL.");
		expect(w.prompts[0]!.instructions).not.toContain("Later main message after root.");

		// 2. Thread turn 2 accumulates the earlier thread question & Planner reply.
		await Threads.sendMessage(w.context, bob.ws, {
			kind: "chat:send",
			rid: "t2",
			requestId: crypto.randomUUID(),
			to: "planner",
			thread: rootReq,
			text: "@chopin and what about composite keys?",
			ts: 0,
		});
		await threadChat!.running;
		expect(w.prompts).toHaveLength(2);
		expect(w.prompts[1]!.instructions).toContain("Root: let us use PostgreSQL.");
		expect(w.prompts[1]!.instructions).toContain("what index do we need?");
		expect(w.prompts[1]!.instructions).toContain("Answer to:");
		expect(w.prompts[1]!.instructions).not.toContain("Later main message after root.");

		// 3. Top-level Chat turn sees main messages and NONE of the thread's replies.
		await Threads.sendMessage(w.context, alice.ws, {
			kind: "chat:send",
			rid: "m3",
			requestId: crypto.randomUUID(),
			to: "planner",
			text: "@chopin summarize main chat",
			ts: 0,
		});
		await w.plan.chat.running;
		expect(w.prompts).toHaveLength(3);
		expect(w.prompts[2]!.instructions).toContain("Root: let us use PostgreSQL.");
		expect(w.prompts[2]!.instructions).toContain("Later main message after root.");
		expect(w.prompts[2]!.instructions).not.toContain("what index do we need?");
		expect(w.prompts[2]!.instructions).not.toContain("composite keys?");

		// 4. "Also send to Chat" posts into both the thread and top-level Chat (idempotent on retry).
		let sharedReq = crypto.randomUUID();
		let sharedMsg = {
			kind: "chat:send" as const,
			rid: "t3",
			requestId: sharedReq,
			to: "room" as const,
			thread: rootReq,
			alsoToChat: true,
			text: "Agreed in thread: add composite index on (channel_id, forked_at).",
			ts: 0,
		};
		await Threads.sendMessage(w.context, alice.ws, sharedMsg);
		await Threads.sendMessage(w.context, alice.ws, { ...sharedMsg, rid: "t3-retry" });
		expect(
			w.plan.chat.entries.filter(entry => entry.text.includes("Agreed in thread:")),
		).toHaveLength(1);

		await Threads.sendMessage(w.context, bob.ws, {
			kind: "chat:send",
			rid: "m4",
			requestId: crypto.randomUUID(),
			to: "planner",
			text: "@chopin check latest agreement",
			ts: 0,
		});
		await w.plan.chat.running;
		expect(w.prompts[3]!.prompt + "\n" + w.prompts[3]!.instructions).toContain(
			"Agreed in thread: add composite index",
		);

		// 5. Summary updates and read-only viewer access + reload persistence.
		let summaryBroadcasts = w.broadcasts.filter(
			(item): item is Wire.ThreadSummaryUpdated => item.kind === "chat:thread-summary",
		);
		expect(summaryBroadcasts.at(-1)?.summary).toMatchObject({
			rootId: rootReq,
			replyCount: 5,
		});
		expect(summaryBroadcasts.at(-1)?.summary.participants).toEqual([
			{ kind: "member", handle: "alice" },
			{ kind: "agent" },
			{ kind: "member", handle: "bob" },
		]);

		let viewer = w.makeSocket("reader", "U_reader", false);
		await Threads.openThread(
			w.context,
			viewer.ws,
			{ kind: "chat:thread", rid: "open-1", rootId: rootReq, create: true, ts: 0 },
			false,
		);
		expect(viewer.frames[0]).toMatchObject({
			kind: "chat:thread",
			rid: "open-1",
			rootId: rootReq,
		});
		expect((viewer.frames[0] as Wire.ThreadOpened).entries).toHaveLength(5);

		// Reload into a fresh Chat instance from storage: summaries and thread entries survive.
		let freshChat = Chat.restore(w.plan.chat.entries);
		let reloadedContext = Threads.bindTopLevel({ ...w.context, chat: freshChat });
		let joiner = w.makeSocket("carol", "U_carol", false);
		await Threads.greetThreads(reloadedContext, joiner.ws);
		expect(joiner.frames[0]).toMatchObject({
			kind: "chat:threads",
			summaries: [expect.objectContaining({ rootId: rootReq, replyCount: 5 })],
		});
		await Chat.close(freshChat);
	});

	test("records context usage and compactions without triggering tool boundary failures, and persists them", async () => {
		let w = await buildWorld();
		let alice = w.makeSocket("alice", "U_alice");
		let compactionCallId = `harness-compaction-${crypto.randomUUID()}`;
		w.setEmitExtra(emit => {
			emit({ type: "raw", rawValue: { type: "compacting" } });
			emit({
				type: "tool-call",
				toolCallId: compactionCallId,
				toolName: "compaction",
				input: {},
				dynamic: true,
				providerExecuted: true,
			});
			emit({
				type: "tool-result",
				toolCallId: compactionCallId,
				toolName: "compaction",
				input: {},
				output: {
					trigger: "auto",
					summary: "Summarized initial discussion.",
					tokensBefore: 44_541,
					tokensAfter: 12_100,
				},
				dynamic: true,
				providerExecuted: true,
			});
			emit({
				type: "raw",
				rawValue: { type: "context-window", contextWindow: 128_000 },
			});
			emit({
				type: "finish-step",
				finishReason: { unified: "stop", raw: undefined },
				usage: {
					inputTokens: { total: 12_100, noCache: 8_100, cacheRead: 4_000, cacheWrite: 0 },
					outputTokens: { total: 900, text: 900, reasoning: 0 },
				},
			});
		});

		let rootId = crypto.randomUUID();
		await Threads.sendMessage(w.context, alice.ws, {
			kind: "chat:send",
			rid: "c1",
			requestId: rootId,
			to: "planner",
			text: "@chopin compact and report usage",
			ts: 0,
		});
		await w.plan.chat.running;

		expect(w.plan.chat.compacting).toBe(false);
		expect(w.plan.chat.compactions).toHaveLength(1);
		expect(w.plan.chat.compactions![0]).toMatchObject({
			summary: "Summarized initial discussion.",
			tokensBefore: 44_541,
			tokensAfter: 12_100,
			trigger: "auto",
		});
		expect(w.plan.chat.usage).toMatchObject({
			inputTokens: 12_100,
			outputTokens: 900,
			cachedTokens: 4_000,
			totalTokens: 13_000,
			contextWindow: 128_000,
		});

		let compactionFrames = w.broadcasts.filter(f => f.kind === "chat:compaction");
		expect(compactionFrames.map(f => (f as Wire.CompactionState).status)).toEqual([
			"compacting",
			"compacted",
		]);
	});

	test("Atomic adapter natively branches SessionManager at the root leafId with tool results preserved", async () => {
		let toolTurnDone = false;
		let stub = startStubModelServer((prompt, hasPriorToolResult) => {
			if (prompt.includes("first-turn") && !hasPriorToolResult && !toolTurnDone) {
				toolTurnDone = true;
				return { kind: "tool", name: "read_plan", arguments: "{}" };
			}
			return { kind: "text", text: `stub-reply:${prompt}:priorTool=${hasPriorToolResult}` };
		});
		cleanups.push(stub.stop);

		let adapter = createAtomicAdapter({
			auth: "ai-gateway",
			model: "vercel-ai-gateway/stub-model",
			providers: {
				"vercel-ai-gateway": {
					baseUrl: stub.baseUrl,
					apiKey: "stub-key",
					api: "openai-completions",
					models: [{
						id: "stub-model",
						name: "Stub Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128_000,
						maxTokens: 4_096,
					}],
				},
			},
		});
		cleanups.push(() => adapter.shutdown());

		let savedEntries: unknown[] | undefined;
		let rootLeafId: string | null = null;
		let finalLeafId: string | null = null;

		let sessionId1 = crypto.randomUUID();
		let unregister1 = registerFullPlanner(sessionId1, {
			cwd: "/tmp",
			humanInput: null as never,
			onSessionEntries: (entries, leafId) => {
				savedEntries = entries;
				finalLeafId = leafId;
			},
		});
		let session1 = await adapter.doStart({
			sessionId: sessionId1,
			sandboxSession: {} as never,
			sessionWorkDir: "/tmp",
		});
		try {
			let turn1Calls: string[] = [];
			let c1 = await session1.doPromptTurn({
				prompt: "first-turn",
				skills: [],
				tools: [{ name: "read_plan", inputSchema: { type: "object" } }],
				emit: part => {
					if (part.type === "tool-call") turn1Calls.push(part.toolCallId);
				},
			});
			while (turn1Calls.length === 0) await Bun.sleep(10);
			await c1.submitToolResult({ toolCallId: turn1Calls[0]!, output: '{"source":"# Plan"}' });
			await c1.done;
			rootLeafId = finalLeafId;
			expect(rootLeafId).toBeTruthy();

			// Run a second turn on the main session AFTER the root point.
			let c2 = await session1.doPromptTurn({
				prompt: "later-main-turn",
				skills: [],
				tools: [{ name: "read_plan", inputSchema: { type: "object" } }],
				emit: () => {},
			});
			await c2.done;
			expect(finalLeafId).not.toBe(rootLeafId);
		} finally {
			await session1.doDestroy();
			unregister1();
		}

		// Now fork a thread session at `rootLeafId`!
		let threadEntries: unknown[] | undefined;
		let threadLeafId: string | null = null;
		let forkedSessionId = crypto.randomUUID();
		let unregisterFork = registerFullPlanner(forkedSessionId, {
			cwd: "/tmp",
			humanInput: null as never,
			sessionEntries: savedEntries,
			branchLeafId: rootLeafId,
			onSessionEntries: (entries, leafId) => {
				threadEntries = entries;
				threadLeafId = leafId;
			},
		});
		let forkedSession = await adapter.doStart({
			sessionId: forkedSessionId,
			sandboxSession: {} as never,
			sessionWorkDir: "/tmp",
		});
		try {
			let forkedText = "";
			let cf = await forkedSession.doPromptTurn({
				prompt: "side-thread-question",
				skills: [],
				tools: [{ name: "read_plan", inputSchema: { type: "object" } }],
				emit: part => {
					if (part.type === "text-delta") forkedText += part.delta;
				},
			});
			await cf.done;
			// The forked session saw the prior tool result from `first-turn`!
			expect(forkedText).toContain("priorTool=true");
			expect(threadEntries?.length).toBeGreaterThan(0);
			expect(threadLeafId).not.toBe(rootLeafId);
		} finally {
			await forkedSession.doDestroy();
			unregisterFork();
		}
	});

	test("HARNESS=remote sends fork to session-forks clients, multiplexes turns, and falls back to start for older or refusing clients", async () => {
		let { auth, storage, channel, logins } = await linkAuth();
		let server = linkServer(auth);
		cleanups.push(server.stop);
		let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
		let publisher = { publish() {} } as unknown as Server<SocketData>;
		let plan = await Plan.open(
			channel.id,
			{
				storage,
				lease: () => lease,
				fatal: error => {
					throw error;
				},
			},
			publisher,
		);
		let owners = new ActiveOwnerBindings(auth as unknown as HostedAuth);
		let agent = createPlannerAgent(createRemoteAdapter());
		let context = Threads.bindTopLevel({
			decide: decideReplying({ input: { type: "noul", noul: 0 } }),
			chat: plan.chat,
			plan,
			room: channel.id,
			server: publisher,
			auth: auth as unknown as HostedAuth,
			repository: { id: "R_score", owner: "octo-org", name: "score", defaultBranch: "main" },
			config: configured({ HARNESS: "remote", BACKGROUND_JOBS: "off" }),
			claimantSessionId: logins.get("member"),
			activeOwner: () => owners.resolve(channel.id),
			persist: () => Plan.persist(plan),
			openPlannerSession: (binding, options) =>
				openPlannerSession(binding, options, {
					githubTools: async () => ({ ok: true, value: {} }),
					createSandbox: async () =>
						({
							defaultWorkingDirectory: "/tmp",
							run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
							destroy: async () => {},
						}) as never,
					registerCredential: () => () => {},
					agent,
				}),
		});
		cleanups.push(async () => {
			owners.revokeAll();
			await Chat.close(plan.chat);
			await Plan.close(plan);
		});

		let forksReceived: Array<ServerMessageOf<"fork">> = [];
		let startsReceived: Array<ServerMessageOf<"start">> = [];
		let refuseFork = false;
		let client = await connectAgent({
			url: server.url,
			token: MEMBER_TOKEN,
			document: channel.id,
			handlers: {
				start(msg) {
					startsReceived.push(msg);
				},
				fork(msg) {
					forksReceived.push(msg);
					if (refuseFork) throw new Error("source session evicted");
				},
				turn(turn) {
					let id = crypto.randomUUID();
					turn.emit({ type: "text-start", id });
					turn.emit({
						type: "text-delta",
						id,
						delta: `Remote reply (${turn.message.session.slice(0, 6)})`,
					});
					turn.emit({ type: "text-end", id });
					finishTurn(turn);
				},
			},
		});
		cleanups.push(() => client.detach());

		let ws = {
			data: {
				handle: "member",
				principalId: "U_member",
				sessionId: logins.get("member"),
				canEdit: true,
			},
			send() {},
		} as unknown as Socket;

		// 1. Run a top-level remote turn so a fork source `{ session, turn }` is recorded.
		let rootReq = crypto.randomUUID();
		await Threads.sendMessage(context, ws, {
			kind: "chat:send",
			rid: "rm1",
			requestId: rootReq,
			to: "planner",
			text: "@chopin initial remote turn",
			ts: 0,
		});
		await plan.chat.running;
		expect(startsReceived).toHaveLength(1);
		let topSessionId = startsReceived[0]!.session;

		// 2. Start a thread on `rootReq`: client receives `fork` naming `from.session = topSessionId`!
		await Threads.sendMessage(context, ws, {
			kind: "chat:send",
			rid: "rt1",
			requestId: crypto.randomUUID(),
			to: "planner",
			thread: rootReq,
			text: "@chopin remote thread question 1",
			ts: 0,
		});
		let threadChat = plan.chat.childChats!.get(rootReq)!;
		await threadChat.running;
		expect(forksReceived).toHaveLength(1);
		expect(forksReceived[0]!.from.session).toBe(topSessionId);
		expect(forksReceived[0]!.from.turn).toBeTruthy();

		// 3. If the client later refuses `fork` (`start-failed`), Chopin falls back to `start`!
		refuseFork = true;
		await Threads.sendMessage(context, ws, {
			kind: "chat:send",
			rid: "rt2",
			requestId: crypto.randomUUID(),
			to: "planner",
			thread: rootReq,
			text: "@chopin remote thread question 2 after eviction",
			ts: 0,
		});
		await threadChat.running;
		expect(forksReceived).toHaveLength(2);
		expect(startsReceived).toHaveLength(2);
		expect(threadChat.entries.filter(e => e.author.kind === "agent")).toHaveLength(2);

		// 4. An older client without `session-forks` never receives `fork`, only `start` with transcript context.
		await client.detach();
		let legacyStarts: Array<ServerMessageOf<"start">> = [];
		let legacyInstructions: string[] = [];
		let legacyClient = await connectAgent({
			url: server.url,
			token: MEMBER_TOKEN,
			document: channel.id,
			sessionForks: false,
			handlers: {
				start(msg) {
					legacyStarts.push(msg);
				},
				turn(turn) {
					legacyInstructions.push(turn.message.instructions ?? "");
					let id = crypto.randomUUID();
					turn.emit({ type: "text-start", id });
					turn.emit({ type: "text-delta", id, delta: "Legacy remote thread reply" });
					turn.emit({ type: "text-end", id });
					finishTurn(turn);
				},
			},
		});
		cleanups.push(() => legacyClient.detach());

		await Threads.sendMessage(context, ws, {
			kind: "chat:send",
			rid: "rt3",
			requestId: crypto.randomUUID(),
			to: "planner",
			thread: rootReq,
			text: "@chopin legacy client thread turn",
			ts: 0,
		});
		await threadChat.running;
		expect(legacyStarts).toHaveLength(1);
		expect(forksReceived).toHaveLength(2);
		expect(legacyInstructions[0]).toContain("initial remote turn");
	});
});
