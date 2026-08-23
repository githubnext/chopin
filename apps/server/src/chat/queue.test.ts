/**
 * Turns that something other than a message started.
 *
 * Accepting a comment is an instruction, so it starts a turn the same way a
 * message does — through the same queue, with the same ceiling. What differs is
 * that a button press is not a thing anybody said, so the transcript has to be
 * told why the agent began moving, and that the work may already be done by the
 * time the turn comes up.
 */

import { describe, expect, it } from "bun:test";
import { ulid } from "@chopin/dialect";

import * as Chat from "./service";

import type { Server } from "bun";
import type { Chat as Wire, Request } from "@chopin/protocol";
import type { Config } from "../config";
import type { Plan } from "../plan/service";
import type { Socket } from "../wire";
import type { SocketData } from "../wire";
import type { ReferenceService } from "./references";

type Sent = {
	kind: string;
	id?: string;
	message?: string;
	queued?: boolean;
	rid?: string;
	[key: string]: unknown;
};

function room(options: { agent?: boolean; busy?: boolean } = {}) {
	let sent: Sent[] = [];
	let chat = Chat.create();
	chat.busy = options.busy ?? false;

	let server = {
		publish(_topic: string, data: string) {
			sent.push(JSON.parse(data) as Sent);
		},
	} as unknown as Server<SocketData>;

	let context: Chat.Room = {
		chat,
		config: { agent: options.agent ?? true } as Config,
		plan: { chat } as Plan,
		room: "test",
		server,
		auth: {} as Chat.Room["auth"],
		claimantSessionId: "session",
		repository: { id: "repo", owner: "owner", name: "repo", defaultBranch: "main" },
		persist: async () => {},
	};

	return { chat, context, sent };
}

/** What the transcript gained, in order. */
function said(sent: Sent[]): string[] {
	return sent
		.filter(frame => frame.kind === "chat:message")
		.map(frame => (frame.entry as { text: string }).text);
}

function sender(handle = "ana", userId = `U_${handle}`, frames: Sent[] = []): Socket {
	return {
		data: { handle, principalId: userId },
		send(value: string) {
			frames.push(JSON.parse(value) as Sent);
		},
	} as unknown as Socket;
}

function message(
	text: string,
	to: Wire.Destination,
	references?: Wire.ReferenceRequest[],
	rid = "request",
	requestId: string = crypto.randomUUID(),
): Request<Wire.Send> {
	return {
		kind: "chat:send",
		rid,
		requestId,
		text,
		to,
		ts: 0,
		...(references ? { references } : {}),
	};
}

function resolvedReference(text = "#release"): Wire.DocumentReference {
	return {
		id: ulid(),
		kind: "document",
		start: 0,
		end: text.length,
		label: "#Release",
		href: "/documents/owner/repo/release",
		repositoryId: "repo",
		observedRevision: 1,
		channelId: crypto.randomUUID(),
		observedSourceHash: `sha256:${"0".repeat(64)}`,
	};
}

function referenceResolver(reference: Wire.Reference): ReferenceService {
	return {
		resolve: async () => ({
			text: reference.label,
			references: [reference],
		}),
	} as unknown as ReferenceService;
}

describe("sending to a named destination", () => {
	it("keeps a planner message in the queue until its turn begins", async () => {
		let { chat, context } = room({ busy: true });

		await Chat.send(context, sender(), message("draft the migration", "planner"));

		expect(chat.entries).toHaveLength(0);
		expect(chat.waiting).toMatchObject([{
			handle: "ana",
			text: "draft the migration",
			userId: "U_ana",
		}]);
	});

	it("sends to the room even when the prose contains the typing shortcut", async () => {
		let { chat, context } = room({ busy: true });

		await Chat.send(context, sender(), message("ask @chopin about this later", "room"));

		expect(chat.waiting).toHaveLength(0);
		expect(chat.entries[0]).toMatchObject({
			author: { kind: "member", handle: "ana" },
			text: "ask @chopin about this later",
		});
	});

	it("persists room references and retains them in Planner backscroll", async () => {
		let { chat, context } = room({ busy: true });
		let reference = resolvedReference();
		context.references = referenceResolver(reference);
		await Chat.send(
			context,
			sender(),
			message("#release", "room", [{
				kind: "document",
				channelId: reference.channelId,
				start: 0,
				end: 8,
			}]),
		);
		expect(chat.entries[0]?.references).toEqual([reference]);
		expect(chat.backscroll[0]?.references).toEqual([reference]);
	});

	it("persists references on an immediate Planner member entry", async () => {
		let { chat, context } = room({ agent: false });
		let reference = resolvedReference();
		let replies: Sent[] = [];
		context.references = referenceResolver(reference);
		await Chat.send(
			context,
			sender("ana", "U_ana", replies),
			message("#release", "planner", [{
				kind: "document",
				channelId: reference.channelId,
				start: 0,
				end: 8,
			}]),
		);
		expect(chat.entries[0]).toMatchObject({
			author: { kind: "member" },
			references: [reference],
		});
		expect(replies[0]).toMatchObject({
			kind: "chat:send",
			id: chat.entries[0]?.id,
			queued: false,
		});
	});

	it("carries references on the visible queue and persists them when the turn starts", async () => {
		let { chat, context, sent } = room({ busy: true });
		let reference = resolvedReference();
		context.references = referenceResolver(reference);
		await Chat.send(
			context,
			sender(),
			message("#release", "planner", [{
				kind: "document",
				channelId: reference.channelId,
				start: 0,
				end: 8,
			}]),
		);
		expect(chat.entries).toEqual([]);
		expect(chat.waiting[0]?.references).toEqual([reference]);
		expect(sent.findLast(frame => frame.kind === "chat:queue")?.waiting).toEqual([
			expect.objectContaining({ references: [reference] }),
		]);
		Chat.pending(chat);
		expect(chat.entries[0]?.references).toEqual([reference]);
	});

	it("rejects an unresolvable reference before changing transcript, queue, or backscroll", async () => {
		let { chat, context } = room({ busy: true });
		let replies: Sent[] = [];
		context.references = {
			resolve: async () => {
				throw new Error("target moved");
			},
		} as unknown as ReferenceService;
		await Chat.send(
			context,
			sender("ana", "U_ana", replies),
			message("#release", "planner", [{
				kind: "document",
				channelId: crypto.randomUUID(),
				start: 0,
				end: 8,
			}]),
		);
		expect(chat.entries).toEqual([]);
		expect(chat.waiting).toEqual([]);
		expect(chat.backscroll).toEqual([]);
		expect(replies).toEqual([
			expect.objectContaining({
				kind: "session:error",
				message: "invalid or unavailable chat reference",
			}),
		]);
	});

	it("removes the typing shortcut from a queued planner message", async () => {
		let { chat, context } = room({ busy: true });

		await Chat.send(context, sender(), message("@chopin draft the migration", "planner"));

		expect(chat.waiting[0]?.text).toBe("draft the migration");
	});

	it("keeps queued member identity and session provenance off the wire", async () => {
		let { context, sent } = room({ busy: true });
		await Chat.send(context, sender("ana", "U_private"), message("research this", "planner"));

		let queue = sent.findLast(frame => frame.kind === "chat:queue");
		expect(queue?.waiting).toEqual([{
			id: expect.any(String),
			handle: "ana",
			text: "research this",
		}]);
	});

	it("moves a queued message into the transcript when it becomes pending", () => {
		let { chat } = room();
		chat.waiting.push({
			id: "w1",
			handle: "ana",
			text: "draft the migration",
			message: true,
			userId: "U_ana",
		});

		let pending = Chat.pending(chat);

		expect(pending?.userId).toBe("U_ana");
		expect(chat.entries).toMatchObject([{
			id: "w1",
			author: { kind: "member", handle: "ana" },
			text: "draft the migration",
		}]);
	});

	it("ignores a destination the protocol does not name", async () => {
		let { chat, context } = room({ busy: true });

		await Chat.send(context, sender(), message("draft the migration", "later" as Wire.Destination));

		expect(chat.entries).toHaveLength(0);
		expect(chat.waiting).toHaveLength(0);
	});

	it("keeps planner requests out of a queue when the agent is off", async () => {
		let { chat, context, sent } = room({ agent: false });

		await Chat.send(context, sender(), message("draft the migration", "planner"));

		expect(chat.busy).toBe(false);
		expect(chat.waiting).toHaveLength(0);
		expect(said(sent)).toEqual([
			"draft the migration",
			"The agent is not running, so the plan has not been revised.",
		]);
	});

	it("replies only after a room message is durably persisted", async () => {
		let { chat, context, sent } = room({ busy: true });
		let entered = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		context.persist = async () => {
			entered.resolve();
			await release.promise;
		};
		let replies: Sent[] = [];
		let sending = Chat.send(context, sender("ana", "U_ana", replies), message("first", "room"));
		await entered.promise;
		expect(replies).toEqual([]);
		expect(sent).toEqual([]);
		release.resolve();
		await sending;
		expect(replies).toEqual([
			expect.objectContaining({ kind: "chat:send", rid: "request", queued: false }),
		]);
		expect(replies[0]?.id).toBe(chat.entries[0]?.id);
		expect(sent[0]).toMatchObject({ kind: "chat:message", entry: { id: replies[0]?.id } });
		expect(sent[0]?.entry).not.toHaveProperty("delivery");
		expect(chat.entries[0]).toHaveProperty("delivery");
	});

	it("accepts a legacy send without a request id during rollout", async () => {
		let { chat, context } = room({ busy: true });
		let replies: Sent[] = [];
		let legacy = { ...message("legacy", "room") } as
			& Omit<
				Request<Wire.Send>,
				"requestId"
			>
			& { requestId?: string };
		delete legacy.requestId;

		await Chat.send(context, sender("ana", "U_ana", replies), legacy as Request<Wire.Send>);

		expect(replies[0]).toMatchObject({ kind: "chat:send", queued: false });
		expect(chat.entries[0]?.text).toBe("legacy");
		expect(chat.entries[0]?.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("acknowledges a queued entry with its durable future entry id", async () => {
		let { chat, context } = room({ busy: true });
		let replies: Sent[] = [];
		await Chat.send(context, sender("ana", "U_ana", replies), message("next", "planner"));
		expect(replies).toEqual([
			expect.objectContaining({ kind: "chat:send", rid: "request", queued: true }),
		]);
		let id = replies[0]?.id;
		if (!id) throw new Error("queued send reply has no id");
		expect(id).toBe(chat.waiting[0]?.id);
		Chat.pending(chat);
		expect(chat.entries[0]?.id).toBe(id);
	});

	it("serializes resolution and acceptance in arrival order", async () => {
		let { chat, context } = room({ busy: true });
		let entered = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let resolving: string[] = [];
		context.references = {
			resolve: async (input: { text: string }) => {
				resolving.push(input.text);
				if (input.text === "first") {
					entered.resolve();
					await release.promise;
				}
				return { text: input.text };
			},
		} as unknown as ReferenceService;
		let firstReplies: Sent[] = [];
		let secondReplies: Sent[] = [];
		let first = Chat.send(
			context,
			sender("ana", "U_ana", firstReplies),
			message("first", "room", undefined, "first-rid"),
		);
		let second = Chat.send(
			context,
			sender("bob", "U_bob", secondReplies),
			message("second", "room", undefined, "second-rid"),
		);
		await entered.promise;
		expect(resolving).toEqual(["first"]);
		expect(chat.entries).toEqual([]);
		release.resolve();
		await Promise.all([first, second]);
		expect(resolving).toEqual(["first", "second"]);
		expect(chat.entries.map(entry => entry.text)).toEqual(["first", "second"]);
		expect(firstReplies[0]).toMatchObject({ rid: "first-rid", queued: false });
		expect(secondReplies[0]).toMatchObject({ rid: "second-rid", queued: false });
	});

	it("fails closed, full, and persistence-rejected sends without success replies", async () => {
		let closed = room({ busy: true });
		closed.chat.closed = true;
		let closedReplies: Sent[] = [];
		await Chat.send(
			closed.context,
			sender("ana", "U_ana", closedReplies),
			message("closed", "room"),
		);
		expect(closedReplies).toEqual([
			expect.objectContaining({ kind: "session:error", message: "conversation is closed" }),
		]);

		let full = room({ busy: true });
		for (let index = 0; index < 20; index++) {
			full.chat.waiting.push({ id: `waiting-${index}`, handle: "ana", text: `${index}` });
		}
		let fullReplies: Sent[] = [];
		await Chat.send(full.context, sender("ana", "U_ana", fullReplies), message("full", "planner"));
		expect(fullReplies).toEqual([
			expect.objectContaining({ kind: "session:error", message: "the Planner queue is full" }),
		]);
		expect(full.chat.waiting).toHaveLength(20);

		let failed = room({ busy: true });
		failed.context.persist = async () => {
			throw new Error("storage unavailable");
		};
		let failedReplies: Sent[] = [];
		await Chat.send(
			failed.context,
			sender("ana", "U_ana", failedReplies),
			message("not saved", "room"),
		);
		expect(failedReplies).toEqual([
			expect.objectContaining({ kind: "session:error", message: "could not save message" }),
		]);
		expect(failed.chat.entries).toEqual([]);
	});

	it("replays a lost room acknowledgement without resolving or persisting twice", async () => {
		let { chat, context } = room({ busy: true });
		let resolutions = 0;
		let persists = 0;
		context.references = {
			resolve: async (input: { text: string }) => {
				resolutions++;
				return { text: input.text };
			},
		} as unknown as ReferenceService;
		context.persist = async () => {
			persists++;
		};
		let requestId = crypto.randomUUID();
		let firstReplies: Sent[] = [];
		let retryReplies: Sent[] = [];
		await Chat.send(
			context,
			sender("ana", "U_ana", firstReplies),
			message("durable once", "room", undefined, "first", requestId),
		);
		await Chat.send(
			context,
			sender("ana", "U_ana", retryReplies),
			message("durable once", "room", undefined, "retry", requestId),
		);
		expect(chat.entries).toHaveLength(1);
		expect(chat.entries[0]?.id).toBe(requestId);
		expect(resolutions).toBe(1);
		expect(persists).toBe(1);
		expect(firstReplies[0]).toMatchObject({ id: requestId, queued: false });
		expect(retryReplies[0]).toMatchObject({ id: requestId, queued: false, rid: "retry" });
	});

	it("replays a lost immediate Planner acknowledgement without starting a duplicate entry", async () => {
		let { chat, context } = room({ agent: false });
		let persists = 0;
		context.persist = async () => {
			persists++;
		};
		let requestId = crypto.randomUUID();
		await Chat.send(
			context,
			sender(),
			message("plan once", "planner", undefined, "first", requestId),
		);
		let replies: Sent[] = [];
		await Chat.send(
			context,
			sender("ana", "U_ana", replies),
			message("plan once", "planner", undefined, "retry", requestId),
		);
		expect(chat.entries).toHaveLength(2);
		expect(chat.entries.filter(entry => entry.id === requestId)).toHaveLength(1);
		expect(persists).toBe(1);
		expect(replies[0]).toMatchObject({ id: requestId, queued: false });
	});

	it("replays a process-local queued request and preserves its id when it becomes an entry", async () => {
		let { chat, context } = room({ busy: true });
		let requestId = crypto.randomUUID();
		await Chat.send(
			context,
			sender(),
			message("queue once", "planner", undefined, "first", requestId),
		);
		let replies: Sent[] = [];
		await Chat.send(
			context,
			sender("ana", "U_ana", replies),
			message("queue once", "planner", undefined, "retry", requestId),
		);
		expect(chat.waiting).toHaveLength(1);
		expect(replies[0]).toMatchObject({ id: requestId, queued: true });
		Chat.pending(chat);
		expect(chat.entries).toHaveLength(1);
		expect(chat.entries[0]?.id).toBe(requestId);
		let startedReplies: Sent[] = [];
		await Chat.send(
			context,
			sender("ana", "U_ana", startedReplies),
			message("queue once", "planner", undefined, "started-retry", requestId),
		);
		expect(chat.entries).toHaveLength(1);
		expect(startedReplies[0]).toMatchObject({ id: requestId, queued: false });
	});

	it("rejects conflicting reuse of a request id before another resolution", async () => {
		let { chat, context } = room({ busy: true });
		let resolutions = 0;
		context.references = {
			resolve: async (input: { text: string }) => {
				resolutions++;
				return { text: input.text };
			},
		} as unknown as ReferenceService;
		let requestId = crypto.randomUUID();
		await Chat.send(
			context,
			sender(),
			message("first payload", "room", undefined, "first", requestId),
		);
		let replies: Sent[] = [];
		await Chat.send(
			context,
			sender("ana", "U_ana", replies),
			message("different payload", "room", undefined, "conflict", requestId),
		);
		expect(chat.entries).toHaveLength(1);
		expect(resolutions).toBe(1);
		expect(replies[0]).toMatchObject({
			kind: "session:error",
			message: "chat request id was reused with different content",
		});
		let referenceConflict: Sent[] = [];
		await Chat.send(
			context,
			sender("ana", "U_ana", referenceConflict),
			message(
				"first payload",
				"room",
				[{
					kind: "document",
					channelId: crypto.randomUUID(),
					start: 0,
					end: 1,
				}],
				"reference-conflict",
				requestId,
			),
		);
		expect(referenceConflict[0]).toMatchObject({
			kind: "session:error",
			message: "chat request id was reused with different content",
		});
		expect(resolutions).toBe(1);
	});

	it("bounds pending FIFO work while a resolver is slow", async () => {
		let { context } = room({ busy: true });
		let entered = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let resolutions = 0;
		context.references = {
			resolve: async (input: { text: string }) => {
				resolutions++;
				if (resolutions === 1) {
					entered.resolve();
					await release.promise;
				}
				return { text: input.text };
			},
		} as unknown as ReferenceService;
		let accepted = Array.from(
			{ length: 20 },
			(_, index) => Chat.send(context, sender(), message(`message ${index}`, "room")),
		);
		await entered.promise;
		let overflow: Sent[] = [];
		await Chat.send(context, sender("ana", "U_ana", overflow), message("overflow", "room"));
		expect(overflow[0]).toMatchObject({
			kind: "session:error",
			message: "too many chat messages are waiting to be processed",
		});
		expect(context.chat.pendingSends).toBe(20);
		release.resolve();
		await Promise.all(accepted);
		expect(resolutions).toBe(20);
		expect(context.chat.pendingSends).toBe(0);
	});

	it("rejects invalid request ids and UTF-8 messages above 64 KiB before resolution", async () => {
		let { context } = room({ busy: true });
		let resolutions = 0;
		context.references = {
			resolve: async (input: { text: string }) => {
				resolutions++;
				return { text: input.text };
			},
		} as unknown as ReferenceService;
		let invalid: Sent[] = [];
		await Chat.send(
			context,
			sender("ana", "U_ana", invalid),
			message("text", "room", undefined, "invalid", "not-a-uuid"),
		);
		expect(invalid[0]).toMatchObject({
			kind: "session:error",
			message: "chat request id must be a UUIDv4",
		});
		let oversized: Sent[] = [];
		await Chat.send(
			context,
			sender("ana", "U_ana", oversized),
			message("😀".repeat(16_385), "room"),
		);
		expect(oversized[0]).toMatchObject({
			kind: "session:error",
			message: "chat message exceeds the 64 KiB limit",
		});
		expect(resolutions).toBe(0);
	});
});

describe("instructing the agent without a message", () => {
	/**
	 * An agent that starts editing for no visible reason is worse than a noisy
	 * log, so the reason goes in the one place the room reads chronologically.
	 */
	it("says why the turn started", async () => {
		let { context, sent } = room({ busy: true });
		await Chat.instruct(context, "ana", "do the thing", '@ana accepted a comment on "x".');

		expect(said(sent)[0]).toBe('@ana accepted a comment on "x".');
	});

	it("queues behind a running turn rather than interrupting it", async () => {
		let { chat, context, sent } = room({ busy: true });
		await Chat.instruct(context, "ana", "do the thing", "@ana accepted a comment.");

		expect(chat.waiting).toHaveLength(1);
		expect(chat.waiting[0]).toMatchObject({ handle: "ana", text: "do the thing" });
		expect(sent.some(frame => frame.kind === "chat:queue")).toBe(true);
	});

	it("refuses to grow a queue nobody is going to read", async () => {
		let { chat, context, sent } = room({ busy: true });
		for (let i = 0; i < 25; i++) {
			await Chat.instruct(context, "ana", `turn ${i}`, `notice ${i}`);
		}

		expect(chat.waiting.length).toBeLessThanOrEqual(20);
		expect(said(sent)).toContain("The queue is full. Wait for the current turn to finish.");
	});

	/**
	 * `AGENT=off` runs the room without one. The decision that got here is
	 * already recorded; only the turn is impossible. Saying so beats a session
	 * failing to open — which is what happened before this check existed,
	 * because `chat:send` was gated and a button press was not.
	 */
	it("records the decision but does not reach for an agent that is off", async () => {
		let { chat, context, sent } = room({ agent: false, busy: false });
		await Chat.instruct(context, "ana", "do the thing", "@ana accepted a comment.");

		expect(chat.busy).toBe(false);
		expect(chat.waiting).toHaveLength(0);
		expect(said(sent)).toEqual([
			"@ana accepted a comment.",
			"The agent is not running, so the plan has not been revised.",
		]);
	});

	it("still says nothing was revised when the agent is off and busy", async () => {
		let { chat, context, sent } = room({ agent: false, busy: true });
		await Chat.instruct(context, "ana", "do the thing", "@ana accepted a comment.");

		// The gate comes before the queue: queueing a turn that can never run
		// would leave it there until someone withdrew it.
		expect(chat.waiting).toHaveLength(0);
		expect(said(sent)).toHaveLength(2);
	});
});

/** Queue some turns, as `instruct` would have while another was running. */
function waiting(chat: Chat.Chat, entries: Array<{ text: string; spent?: () => boolean }>): void {
	for (let [index, entry] of entries.entries()) {
		chat.waiting.push({ id: `w${index}`, handle: "ana", ...entry });
	}
}

describe("what a turn is acting on", () => {
	/**
	 * `edit_plan` reads this to record the prose a turn wrote as what the
	 * decision that started it produced. A turn nobody started by accepting a
	 * comment is acting on nothing, and must attribute nothing.
	 */
	it("carries the thread through the queue to the turn", async () => {
		let { chat, context } = room({ busy: true });
		await Chat.instruct(context, "ana", "do the thing", "notice", { thread: "t1" });

		expect(chat.waiting[0]).toMatchObject({ thread: "t1" });
	});

	it("keeps the thread off the wire", async () => {
		let { context, sent } = room({ busy: true });
		await Chat.instruct(context, "ana", "do the thing", "notice", { thread: "t1" });

		let queue = sent.findLast(frame => frame.kind === "chat:queue");
		expect(queue?.waiting).toEqual([{
			id: expect.any(String),
			handle: "ana",
			text: "do the thing",
		}]);
	});

	it("says a room with no turn running is acting on nothing", () => {
		let { chat } = room();
		expect(chat.acting).toBeUndefined();
	});
});

describe("draining the queue", () => {
	it("takes them in the order they arrived", () => {
		let { chat } = room();
		waiting(chat, [{ text: "first" }, { text: "second" }]);

		expect(Chat.pending(chat)?.text).toBe("first");
		expect(Chat.pending(chat)?.text).toBe("second");
		expect(Chat.pending(chat)).toBeUndefined();
	});

	/**
	 * Four accepted comments should not cost four passes over the plan when the
	 * agent dealt with all of them in the first. Only something that queued
	 * behind a turn can be spent, which is why the question is asked here.
	 */
	it("drops a turn whose work another one already did", () => {
		let { chat } = room();
		waiting(chat, [
			{ text: "thread one", spent: () => true },
			{ text: "thread two", spent: () => true },
			{ text: "thread three", spent: () => false },
		]);

		expect(Chat.pending(chat)?.text).toBe("thread three");
		expect(chat.waiting).toHaveLength(0);
	});

	it("drops the whole queue when everything in it is spent", () => {
		let { chat } = room();
		waiting(chat, [{ text: "one", spent: () => true }, { text: "two", spent: () => true }]);

		expect(Chat.pending(chat)).toBeUndefined();
	});

	/** An ordinary message is never spent: nobody else can have said it for you. */
	it("keeps a message, which has no work anybody else could have done", () => {
		let { chat } = room();
		waiting(chat, [{ text: "what about auth?" }]);

		expect(Chat.pending(chat)?.text).toBe("what about auth?");
	});

	/**
	 * `spent` is a function, so it is asked at the moment the turn would run
	 * rather than when it was queued — which is the only moment the answer is
	 * knowable. It also means `JSON.stringify` drops it, keeping the wire shape
	 * exactly what clients expect.
	 */
	it("asks when the turn would run, not when it was queued", () => {
		let { chat } = room();
		let done = false;
		waiting(chat, [{ text: "thread", spent: () => done }]);

		done = true;
		expect(Chat.pending(chat)).toBeUndefined();
	});

	it("keeps `spent` off the wire", async () => {
		let { context, sent } = room({ busy: true });
		await Chat.instruct(context, "ana", "do the thing", "notice", { spent: () => false });

		let queue = sent.findLast(frame => frame.kind === "chat:queue");
		expect(queue?.waiting).toEqual([{
			id: expect.any(String),
			handle: "ana",
			text: "do the thing",
		}]);
	});
});
