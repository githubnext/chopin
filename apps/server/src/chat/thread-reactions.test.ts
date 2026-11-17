import { afterEach, expect, test } from "bun:test";

import { ActiveOwnerBindings } from "../agent/active-owner";
import { decideReplying } from "../conversation-plan/decisions.test-fixtures";
import * as Plan from "../plan/service";
import { linkAuth } from "../testing/agent-link";
import { configured } from "../testing/config";
import { until } from "./job.test-fixtures";
import { createResponder } from "./reaction-reply";
import { sessionContextOf } from "./session-context";
import * as Chat from "./service";
import { copiedFrom, reactInChat, reactInThread } from "./thread-reactions";
import * as Threads from "./threads";

import type { Chat as Wire } from "@chopin/protocol";
import type { Server } from "bun";
import type { HostedAuth } from "../auth/routes";
import type { openPlannerSession, PlannerSession } from "../harness/session";
import type { Socket, SocketData } from "../wire";

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A room whose Planner answers every prompt with its last line, and whose frames are kept. */
async function world() {
	let { auth, storage, channel, logins } = await linkAuth();
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let broadcasts: Wire.Outgoing[] = [];
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
	let open: typeof openPlannerSession = async (_binding, options) => {
		let instructions = typeof options.instructions === "function"
			? options.instructions(undefined)
			: options.instructions;
		let session: PlannerSession = {
			stream: prompt => {
				prompts.push({ instructions, prompt });
				async function* parts() {
					let id = crypto.randomUUID();
					yield { type: "text-start", id } as never;
					yield { type: "text-delta", id, text: `Answer to: ${prompt.split("\n")[0]}` } as never;
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
	let context: Chat.Room = Threads.bindTopLevel({
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
		openPlannerSession: open,
		initiativeAuthorize: async () => true,
		reactionAuthorize: async () => true,
	});
	plan.chat.reactions = createResponder({ delayMs: 1 });
	cleanups.push(async () => {
		owners.revokeAll();
		await Chat.close(plan.chat);
		await Plan.close(plan);
	});
	let socket = (handle: string) => {
		let frames: Array<Record<string, unknown>> = [];
		let ws = {
			data: { handle, principalId: `U_${handle}`, sessionId: logins.get("member"), canEdit: true },
			send(raw: string) {
				frames.push(JSON.parse(raw));
			},
		} as unknown as Socket;
		return { ws, frames };
	};
	let send = async (ws: Socket, text: string, extra: Partial<Wire.Send> = {}) => {
		let requestId = crypto.randomUUID();
		await Threads.sendMessage(context, ws, {
			kind: "chat:send",
			rid: crypto.randomUUID(),
			requestId,
			to: text.startsWith("@chopin") ? "planner" : "room",
			text,
			ts: 0,
			...extra,
		});
		return requestId;
	};
	let react = (ws: Socket, thread: string, id: string, emoji: string, on = true) =>
		reactInThread(context, ws, {
			kind: "chat:react",
			rid: crypto.randomUUID(),
			ts: 0,
			id,
			emoji,
			on,
			thread,
		});
	let reactInChatAs = (ws: Socket, id: string, emoji: string) =>
		reactInChat(context, ws, {
			kind: "chat:react",
			rid: crypto.randomUUID(),
			ts: 0,
			id,
			emoji,
			on: true,
		});
	return { broadcasts, context, plan, prompts, react, reactInChatAs, send, socket, storage };
}

function plannerRoot(w: Awaited<ReturnType<typeof world>>, id = "planner-root") {
	w.plan.chat.entries.push({
		id,
		author: { kind: "agent" },
		text: "I moved the cache key into the router.",
		ts: 1,
	});
	return id;
}

let agents = (chat: Chat.Chat | undefined) =>
	(chat?.entries ?? []).filter(entry => entry.author.kind === "agent");

test("a reaction to a thread's reply is saved in the thread and told as the thread's, never Chat's", async () => {
	let w = await world();
	let ana = w.socket("ana");
	let root = await w.send(ana.ws, "Root: should we index forked_at?");
	let reply = await w.send(ana.ws, "Yes, a composite index.", { thread: root });
	let thread = w.plan.chat.childChats!.get(root)!;
	let before = w.broadcasts.length;

	await w.react(ana.ws, root, reply, "🎉");

	expect(ana.frames.at(-1)).toMatchObject({ kind: "chat:react", id: reply, emoji: "🎉", on: true });
	expect(thread.entries.find(entry => entry.id === reply)?.reactions).toEqual([
		{ emoji: "🎉", handles: ["ana"] },
	]);
	let told = w.broadcasts.slice(before);
	expect(told).toEqual([
		expect.objectContaining({
			kind: "chat:in-thread",
			rootId: root,
			frame: expect.objectContaining({
				kind: "chat:reactions",
				id: reply,
				reactions: [{ emoji: "🎉", handles: ["ana"] }],
			}),
		}),
	]);
	expect(w.plan.chat.entries.some(entry => entry.id === reply)).toBe(false);
	let stored = (await w.storage.chatThreads.listThreads(w.context.room)).find(record =>
		record.rootId === root
	)!;
	expect(stored.entries.find(entry => entry.id === reply)?.reactions).toEqual([
		{ emoji: "🎉", handles: ["ana"] },
	]);

	await w.react(ana.ws, root, reply, "🎉", false);
	expect(thread.entries.find(entry => entry.id === reply)?.reactions).toBeUndefined();
	stored = (await w.storage.chatThreads.listThreads(w.context.room)).find(record =>
		record.rootId === root
	)!;
	expect(stored.entries.find(entry => entry.id === reply)?.reactions).toBeUndefined();
});

test("the root, reacted to in its thread, keeps the reaction on Chat's message and tells Chat", async () => {
	let w = await world();
	let ana = w.socket("ana");
	let root = await w.send(ana.ws, "Root: should we index forked_at?");
	await w.send(ana.ws, "A reply.", { thread: root });
	let before = w.broadcasts.length;

	await w.react(ana.ws, root, root, "👀");

	expect(w.plan.chat.entries.find(entry => entry.id === root)?.reactions).toEqual([
		{ emoji: "👀", handles: ["ana"] },
	]);
	expect(w.broadcasts.slice(before)).toEqual([
		expect.objectContaining({ kind: "chat:reactions", id: root }),
	]);
});

test("a message not in the thread named, or a thread nobody started, takes no reaction there", async () => {
	let w = await world();
	let ana = w.socket("ana");
	let root = await w.send(ana.ws, "Root.");
	let other = await w.send(ana.ws, "Another Chat message.");

	await w.react(ana.ws, root, other, "👍");
	expect(ana.frames.at(-1)).toMatchObject({
		kind: "session:error",
		message: "thread was not found",
	});

	await w.send(ana.ws, "A reply.", { thread: root });
	await w.react(ana.ws, root, other, "👍");
	expect(ana.frames.at(-1)).toMatchObject({
		kind: "session:error",
		message: "this message cannot take reactions",
	});
	expect(w.plan.chat.entries.find(entry => entry.id === other)?.reactions).toBeUndefined();

	await w.react(ana.ws, "x".repeat(129), other, "👍");
	expect(ana.frames.at(-1)).toMatchObject({
		kind: "session:error",
		message: "invalid thread root id",
	});
});

test("a person holds at most 20 different reactions to a thread's reply, as in Chat", async () => {
	let w = await world();
	let ana = w.socket("ana");
	let root = await w.send(ana.ws, "Root.");
	let reply = await w.send(ana.ws, "A reply.", { thread: root });
	let emoji = [..."😀😁😂🤣😃😄😅😆😉😊😋😎😍😘🥰😗😙🥲😚🙂"];
	for (let one of emoji) await w.react(ana.ws, root, reply, one);
	await w.react(ana.ws, root, reply, "🤔");
	expect(ana.frames.at(-1)).toMatchObject({
		kind: "session:error",
		message: "you can react to a message with at most 20 different emoji",
	});
});

test("❓ on the Planner's reply in a thread is answered in that thread, by its session, and not in Chat", async () => {
	let w = await world();
	let ana = w.socket("ana");
	let root = await w.send(ana.ws, "Root: use expand-only tables.");
	await w.send(ana.ws, "Later main message after the root.");
	await w.send(ana.ws, "@chopin which index?", { thread: root });
	let thread = w.plan.chat.childChats!.get(root)!;
	await until(() => agents(thread).length === 1 && !thread.busy);
	let answer = agents(thread)[0]!;
	let mainAgents = agents(w.plan.chat).length;
	let asked = w.prompts.length;

	await w.react(ana.ws, root, answer.id, "\u2753");

	await until(() => agents(thread).length === 2 && !thread.busy);
	let reply = agents(thread)[1] as Wire.Entry & { viaReaction?: true };
	expect(reply.viaReaction).toBe(true);
	expect(w.prompts).toHaveLength(asked + 1);
	let { context, turn } = sessionContextOf(w.prompts.at(-1)!.prompt);
	expect(turn).toContain("A person reacted to one of your messages in this thread.");
	expect(turn).toContain(JSON.stringify(answer.id));
	// The thread's session: it is told the root and the thread, and nothing said in Chat after it.
	expect(context).toContain("Root: use expand-only tables.");
	expect(context).toContain("which index?");
	expect(context).not.toContain("Later main message after the root.");
	expect(turn).not.toContain("Later main message after the root.");
	expect(agents(w.plan.chat)).toHaveLength(mainAgents);
	expect((answer as { answeredIntents?: string[] }).answeredIntents).toEqual(["confused"]);
	expect(
		w.broadcasts.some(frame =>
			frame.kind === "chat:message" && (frame as Wire.Message).entry.id === reply.id
		),
	).toBe(false);
	expect(
		w.broadcasts.some(frame =>
			frame.kind === "chat:in-thread" && frame.frame.kind === "chat:message"
			&& frame.frame.entry.id === reply.id
		),
	).toBe(true);
});

test("❓ on a Planner's root in its thread is answered in the thread, started for it if nobody had", async () => {
	let w = await world();
	let ana = w.socket("ana");
	let root = "planner-root";
	w.plan.chat.entries.push({
		id: root,
		author: { kind: "agent" },
		text: "I moved the cache key into the router.",
		ts: 1,
	});

	await w.react(ana.ws, root, root, "👎");

	expect(w.plan.chat.entries.find(entry => entry.id === root)?.reactions).toEqual([
		{ emoji: "👎", handles: ["ana"] },
	]);
	await until(() => agents(w.plan.chat.childChats?.get(root)).length === 1);
	let thread = w.plan.chat.childChats!.get(root)!;
	await until(() => !thread.busy);
	expect(sessionContextOf(w.prompts.at(-1)!.prompt).turn).toContain("in this thread");
	expect(agents(thread)[0]).toMatchObject({ viaReaction: true });
	expect(agents(w.plan.chat).map(entry => entry.id)).toEqual([root]);
	expect(
		(w.plan.chat.entries.find(entry => entry.id === root) as { answeredIntents?: string[] })
			.answeredIntents,
	).toEqual(["disagree"]);
	let stored = await w.storage.chatThreads.listThreads(w.context.room);
	expect(stored.map(record => record.rootId)).toEqual([root]);
});

test("✅ on the Planner's reply in a thread is an approval and starts no turn, as in Chat", async () => {
	let w = await world();
	let ana = w.socket("ana");
	let root = await w.send(ana.ws, "Root.");
	await w.send(ana.ws, "@chopin which index?", { thread: root });
	let thread = w.plan.chat.childChats!.get(root)!;
	await until(() => agents(thread).length === 1 && !thread.busy);
	let asked = w.prompts.length;
	await w.react(ana.ws, root, agents(thread)[0]!.id, "✅");
	await Bun.sleep(50);
	expect(w.prompts).toHaveLength(asked);
	expect(agents(thread)).toHaveLength(1);
});

test("a reply also sent to Chat is one message: its reactions, made in either place, are saved and told in both", async () => {
	let w = await world();
	let ana = w.socket("ana");
	let root = await w.send(ana.ws, "Root.");
	let shared = await w.send(ana.ws, "Agreed in thread: add the index.", {
		thread: root,
		alsoToChat: true,
	});
	expect(copiedFrom(w.context, shared)).toBe(root);
	expect(copiedFrom(w.context, root)).toBeUndefined();
	let before = w.broadcasts.length;

	await w.react(ana.ws, root, shared, "🎉");
	let reactions = [{ emoji: "🎉", handles: ["ana"] }];
	expect(w.plan.chat.entries.find(entry => entry.id === shared)?.reactions).toEqual(reactions);
	let told = w.broadcasts.slice(before);
	expect(told).toContainEqual(
		expect.objectContaining({
			kind: "chat:in-thread",
			frame: expect.objectContaining({ kind: "chat:reactions", id: shared }),
		}),
	);
	expect(told).toContainEqual(expect.objectContaining({ kind: "chat:reactions", id: shared }));

	// From Chat, which names no thread, the message is routed to its thread as main.ts does.
	let cy = w.socket("cy");
	await reactInThread(w.context, cy.ws, {
		kind: "chat:react",
		rid: crypto.randomUUID(),
		ts: 0,
		id: shared,
		emoji: "🎉",
		on: true,
		thread: copiedFrom(w.context, shared)!,
	});
	let both = [{ emoji: "🎉", handles: ["ana", "cy"] }];
	expect(w.plan.chat.childChats!.get(root)!.entries.find(entry => entry.id === shared)?.reactions)
		.toEqual(both);
	expect(w.plan.chat.entries.find(entry => entry.id === shared)?.reactions).toEqual(both);
	let stored = (await w.storage.chatThreads.listThreads(w.context.room))[0]!;
	expect(stored.entries.find(entry => entry.id === shared)?.reactions).toEqual(both);
});

test("❓ on a Planner's message in Chat starts its thread, saved first, and is answered there, not in Chat", async () => {
	let w = await world();
	let ana = w.socket("ana");
	let root = plannerRoot(w);
	let order: string[] = [];
	let put = w.storage.chatThreads.putThread.bind(w.storage.chatThreads);
	w.storage.chatThreads.putThread = async (lease, record) => {
		await put(lease, record);
		order.push(`saved ${record.rootId}`);
	};
	let publish = w.context.server.publish.bind(w.context.server);
	w.context.server.publish = ((topic: string, message: string) => {
		let frame = JSON.parse(message) as Wire.Outgoing;
		if (frame.kind === "chat:in-thread") order.push(`told ${frame.frame.kind}`);
		return publish(topic, message);
	}) as typeof w.context.server.publish;
	let before = w.broadcasts.length;

	await w.reactInChatAs(ana.ws, root, "\u2753");

	expect(w.plan.chat.entries.find(entry => entry.id === root)?.reactions).toEqual([
		{ emoji: "\u2753", handles: ["ana"] },
	]);
	await until(() => agents(w.plan.chat.childChats?.get(root)).length === 1);
	let thread = w.plan.chat.childChats!.get(root)!;
	await until(() => !thread.busy);
	let answer = agents(thread)[0]!;
	expect(answer).toMatchObject({ viaReaction: true });
	let { turn } = sessionContextOf(w.prompts.at(-1)!.prompt);
	expect(turn).toContain("A person reacted to one of your messages in this thread.");
	expect(turn).toContain(JSON.stringify(root));
	expect(order[0]).toBe(`saved ${root}`);
	expect(order).toContain("told chat:message");
	expect(agents(w.plan.chat).map(entry => entry.id)).toEqual([root]);
	expect(
		(w.plan.chat.entries.find(entry => entry.id === root) as { answeredIntents?: string[] })
			.answeredIntents,
	).toEqual(["confused"]);
	let told = w.broadcasts.slice(before);
	expect(told.some(frame => frame.kind === "chat:message")).toBe(false);
	expect(told).toContainEqual(
		expect.objectContaining({
			kind: "chat:thread-summary",
			summary: expect.objectContaining({ rootId: root, replyCount: 1 }),
		}),
	);
	let stored = await w.storage.chatThreads.listThreads(w.context.room);
	expect(stored.map(record => record.rootId)).toEqual([root]);
	expect(typeof answer.seq).toBe("number");
	expect(stored[0]!.lastSeq).toBe(answer.seq);
	expect(stored[0]!.entries.find(entry => entry.id === answer.id)).toMatchObject({
		id: answer.id,
		seq: answer.seq,
		viaReaction: true,
	});
	let followUp = await w.send(ana.ws, "Thanks, that clears it up.", { thread: root });
	expect(thread.entries.map(entry => entry.id)).toEqual([answer.id, followUp]);
	expect(thread.entries[1]!.seq).toBeGreaterThan(answer.seq!);
});

test("❓ on a Chat message whose thread exists adds the answer to that thread", async () => {
	let w = await world();
	let ana = w.socket("ana");
	let root = plannerRoot(w);
	await w.send(ana.ws, "Which router?", { thread: root });
	let thread = w.plan.chat.childChats!.get(root)!;
	let forkedAt = (await w.storage.chatThreads.listThreads(w.context.room))[0]!.forkedAt;

	await w.reactInChatAs(ana.ws, root, "👎");

	await until(() => agents(thread).length === 1 && !thread.busy);
	expect(thread.entries.map(entry => entry.author.kind)).toEqual(["member", "agent"]);
	expect(agents(thread)[0]).toMatchObject({ viaReaction: true });
	expect(agents(w.plan.chat).map(entry => entry.id)).toEqual([root]);
	let stored = await w.storage.chatThreads.listThreads(w.context.room);
	expect(stored).toHaveLength(1);
	expect(stored[0]!.forkedAt).toBe(forkedAt);
});

test("a Chat reaction nobody may have answered starts no thread", async () => {
	let w = await world();
	let ana = w.socket("ana");
	let root = plannerRoot(w);
	w.context.initiativeAuthorize = async () => false;
	w.context.reactionAuthorize = async () => false;

	await w.reactInChatAs(ana.ws, root, "\u2753");
	await Bun.sleep(50);

	expect(w.plan.chat.childChats?.get(root)).toBeUndefined();
	expect(await w.storage.chatThreads.listThreads(w.context.room)).toEqual([]);
	expect(w.prompts).toHaveLength(0);
});

test("an answer to a Chat reaction is still not answered again after a reload", async () => {
	let w = await world();
	let ana = w.socket("ana");
	let root = plannerRoot(w);
	await w.reactInChatAs(ana.ws, root, "\u2753");
	await until(() => agents(w.plan.chat.childChats?.get(root)).length === 1);
	let thread = w.plan.chat.childChats!.get(root)!;
	await until(() => !thread.busy);
	let answer = agents(thread)[0]!;
	let stored = (await w.storage.chatThreads.listThreads(w.context.room))[0]!;
	expect(stored.entries.find(entry => entry.id === answer.id)).toMatchObject({ viaReaction: true });
	let prompts = w.prompts.length;

	let freshChat = Chat.restore(w.plan.chat.entries);
	freshChat.reactions = createResponder({ delayMs: 1 });
	cleanups.push(() => Chat.close(freshChat));
	let reloaded = Threads.bindTopLevel({ ...w.context, chat: freshChat });
	await reactInThread(reloaded, ana.ws, {
		kind: "chat:react",
		rid: crypto.randomUUID(),
		ts: 0,
		id: answer.id,
		emoji: "\u2753",
		on: true,
		thread: root,
	});
	let restored = freshChat.childChats!.get(root)!;
	expect(restored.entries.find(entry => entry.id === answer.id)).toMatchObject({
		viaReaction: true,
		reactions: [{ emoji: "\u2753", handles: ["ana"] }],
	});
	await Bun.sleep(100);

	expect(w.prompts).toHaveLength(prompts);
	expect(agents(restored)).toHaveLength(1);
});
