/**
 * Sending a comment to the Planner.
 *
 * What matters: the note is durable and the room has it before any turn is
 * asked for; a turn that is running refuses before anything is saved (nothing is
 * held for the next one); the Planner may only speak in the thread its turn was
 * sent; and when it forgets to, its last word in Chat is posted there for it.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { documentTools } from "./agent/tools";
import { authenticatedMemory } from "./chat/job-authenticated-memory.test-fixtures";
import { createRootChat } from "./chat/root";
import * as Chat from "./chat/service";
import * as Comments from "./comments/service";
import { decideReplying } from "./conversation-plan/decisions.test-fixtures";
import * as Service from "./plan/service";
import * as room from "./plan/room";
import { openPlan } from "./testing/plan";
import { rooted } from "./testing/rooted";
import * as Wire from "./wire";

import type { Config } from "./config";
import type { Plan } from "./plan/service";
import type { Socket } from "./wire";

const SOURCE = `# Title

The renderer caches tiles for 60 seconds.

The second paragraph.
`;

const QUOTE = "caches tiles for 60 seconds";

type Sent = { kind: string; [key: string]: unknown };

let opens: Plan[] = [];
let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (let cleanup of cleanups.splice(0)) await cleanup();
	for (let plan of opens) await Service.close(plan);
	opens = [];
});

/** One turn the Planner was asked for, held open until the test lets it end. */
type Turn = {
	prompt: string;
	/** Ends the turn after the Planner says `parts`. */
	finish(parts?: unknown[]): void;
	/** Fails the turn as a model's error would. */
	fail(error: Error): void;
};

/**
 * A room whose Planner takes each turn on a session the test holds open. With `busy`, a turn is
 * already running, so a note sent to Chopin is refused.
 */
async function opened(options: { agent?: boolean; busy?: boolean } = {}) {
	let fixture = await openPlan(SOURCE);
	let { broadcasts, plan, server } = fixture;
	opens.push(plan);
	let identity = await authenticatedMemory(fixture);
	cleanups.push(async () => {
		for (let turn of turns) turn.finish();
		await plan.chat.running?.catch(() => {});
		identity.revokeAll();
	});
	let turns: Turn[] = [];
	let context: Chat.Room = {
		...identity.context,
		config: { agent: options.agent ?? true } as Config,
		openPlannerSession: async () => ({
			ok: true,
			value: {
				async stream(prompt: string, signal: AbortSignal) {
					let gate = Promise.withResolvers<unknown[]>();
					turns.push({
						prompt,
						finish: (parts = []) => gate.resolve(parts),
						fail: error => gate.reject(error),
					});
					signal.addEventListener("abort", () => gate.resolve([]), { once: true });
					return {
						fullStream: (async function*() {
							yield* await gate.promise;
							yield { type: "finish" };
						})(),
					} as never;
				},
				async destroy() {},
			},
		}),
	};
	plan.chat.busy = options.busy ?? false;
	return {
		broadcasts: broadcasts as Sent[],
		context,
		plan,
		server,
		storage: fixture.storage,
		turns,
		/** Settles once `count` turns have reached the model. */
		async started(count = 1) {
			for (let deadline = Date.now() + 2_000; turns.length < count; await Bun.sleep(2)) {
				if (Date.now() > deadline) throw new Error("the turn did not reach the model");
			}
		},
	};
}

function member(handle: string) {
	let replies: Sent[] = [];
	let relayed: Sent[] = [];
	let socket = {
		data: { handle, client: `client-${handle}`, room: "test" },
		send(raw: string) {
			replies.push(JSON.parse(raw) as Sent);
		},
		publish(_topic: string, raw: string) {
			relayed.push(JSON.parse(raw) as Sent);
		},
	} as unknown as Socket;
	return { relayed, replies, socket };
}

let rid = 0;
function ask<T extends object>(payload: T) {
	return { ts: 0, rid: `r${++rid}`, ...payload } as T & { ts: number; rid: string };
}

async function start(
	context: Chat.Room,
	who: ReturnType<typeof member>,
	text = "Rephrase this.",
	to: "planner" | null = "planner",
) {
	await Comments.start(
		context.plan,
		context.server,
		"test",
		who.socket,
		ask({
			kind: "comment:start" as const,
			blocks: [1],
			quote: QUOTE,
			offset: 0,
			length: QUOTE.length,
			text,
			...(to ? { to } : {}),
		}),
		to ? context : undefined,
	);
	return who.replies.findLast(frame => frame.kind === "comment:start");
}

async function reply(
	context: Chat.Room,
	who: ReturnType<typeof member>,
	id: string,
	text: string,
	to: "planner" | null = "planner",
) {
	await Comments.respond(
		context.plan,
		who.socket,
		ask({ kind: "comment:reply" as const, id, text, ...(to ? { to } : {}) }),
		to ? context : undefined,
	);
	return who.replies.findLast(frame => frame.kind === "comment:reply");
}

/** The thread a successful `comment:start` reply carries. */
function idOf(answered: Sent | undefined): string {
	let thread = answered?.thread as { id: string } | undefined;
	if (!thread) throw new Error(`no thread was started: ${JSON.stringify(answered)}`);
	return thread.id;
}

function working(broadcasts: Sent[]) {
	return broadcasts.filter(frame => frame.kind === "comment:working");
}

describe("sending a new comment to the Planner", () => {
	it("saves the note, tells the room, then starts a turn about the thread", async () => {
		let { broadcasts, context, plan, started, storage, turns } = await opened();
		let ana = member("ana");

		let answered = await start(context, ana);

		expect(answered).toMatchObject({ ok: true, planner: "running" });
		let thread = answered?.thread as { id: string; notes: unknown[] };
		expect(thread.notes[0]).toMatchObject({
			author: "member",
			handle: "ana",
			to: "planner",
			text: "Rephrase this.",
		});
		expect(ana.relayed[0]).toMatchObject({ kind: "comment:opened" });

		// Durable before the turn is asked for.
		let saved = await storage.collaboration.load(plan.id, new Date());
		expect(JSON.stringify(saved?.sidecar)).toContain("Rephrase this.");

		await started();
		expect(turns[0]?.prompt).toContain("Rephrase this.");
		expect(turns[0]?.prompt).toContain(`thread ${thread.id}`);
		expect(turns[0]?.prompt).toStartWith("@ana:");
		expect(plan.chat.acting).toBe(thread.id);
		expect(plan.chat.waiting).toEqual([]);

		let notice = plan.chat.entries.at(-1);
		expect(notice).toMatchObject({
			author: { kind: "system" },
			text: `Comment on “${QUOTE}” sent to Chopin`,
			comment: { thread: thread.id, excerpt: QUOTE, note: "Rephrase this." },
		});
		expect(working(broadcasts)).toEqual([
			expect.objectContaining({ id: thread.id, working: true }),
		]);
	});

	it("never reads a mention out of the text: only the destination addresses the Planner", async () => {
		let { context, plan } = await opened();
		let ana = member("ana");

		let answered = await start(context, ana, "@chopin rephrase this", null);

		expect(answered).toMatchObject({ ok: true });
		expect(answered).not.toHaveProperty("planner");
		expect((answered!.thread as { notes: Array<{ to?: string }> }).notes[0]?.to)
			.toBeUndefined();
		expect(plan.chat.waiting).toHaveLength(0);
	});

	it("refuses before saving anything while a turn runs, and holds nothing for the next one", async () => {
		let { context, plan } = await opened({ busy: true });
		let ana = member("ana");

		let answered = await start(context, ana);

		expect(answered).toMatchObject({
			ok: false,
			reason: "busy",
			message: "Chopin is working on something else. Try again when it has finished.",
		});
		expect(plan.threads.size).toBe(0);
		expect(plan.chat.waiting).toHaveLength(0);
		expect(plan.chat.entries).toEqual([]);
	});

	it("refuses before saving anything when no remote Planner is attached", async () => {
		let { broadcasts, context, plan } = await opened({ busy: false });
		context.plannerNotAttached = async () => "Attach a Planner to this document first.";
		let ana = member("ana");

		let answered = await start(context, ana);
		expect(answered).toMatchObject({
			ok: false,
			reason: "busy",
			code: "planner-not-attached",
			message: "Attach a Planner to this document first.",
		});
		expect(plan.threads.size).toBe(0);
		expect(working(broadcasts)).toHaveLength(0);

		let open = idOf(await start(context, ana, "Plain note.", null));
		let replied = await reply(context, ana, open, "Now you, Chopin.");
		expect(replied).toMatchObject({ ok: false, code: "planner-not-attached" });
		expect(plan.threads.get(open)?.notes).toHaveLength(1);
		expect(plan.chat.waiting).toHaveLength(0);

		// An ordinary comment is not the Planner's business, attached or not.
		expect(await reply(context, ana, open, "Just us.", null)).toMatchObject({ ok: true });
	});

	it("saves the note but says so when no Planner is running", async () => {
		let { broadcasts, context, plan } = await opened({ agent: false });
		let ana = member("ana");

		let answered = await start(context, ana);

		expect(answered).toMatchObject({ ok: true, planner: "off" });
		expect(plan.threads.size).toBe(1);
		expect(plan.chat.waiting).toHaveLength(0);
		expect(plan.chat.entries).toHaveLength(0);
		expect(working(broadcasts)).toEqual([
			expect.objectContaining({ working: false, reason: "off" }),
		]);
	});

	it("says the turn failed when no session could be opened for it", async () => {
		let { broadcasts, context } = await opened({ busy: false });
		context.openPlannerSession = async () => {
			throw new Error("no session could be opened");
		};
		let ana = member("ana");

		let answered = await start(context, ana);
		expect(answered).toMatchObject({ ok: true, planner: "running" });
		let id = idOf(answered);
		await context.chat.running;

		expect(working(broadcasts).at(-1)).toEqual(
			expect.objectContaining({ id, working: false, reason: "failed" }),
		);
		expect(context.plan.threads.get(id)?.notes).toHaveLength(1);
	});
});

describe("one thread, one turn", () => {
	it("refuses a later note to Chopin while the turn for its thread runs, and keeps the thread as it was", async () => {
		let { context, plan, started } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));
		await started();

		let answered = await reply(context, member("kris"), id, "And shorten it.");

		expect(answered).toMatchObject({
			ok: false,
			reason: "busy",
			message: "Chopin is working on something else. Try again when it has finished.",
		});
		expect(plan.threads.get(id)?.notes).toHaveLength(1);
		expect(plan.chat.waiting).toEqual([]);
		// A plain note is still welcome: it is not asked of Chopin.
		expect(await reply(context, member("kris"), id, "Just us.", null)).toMatchObject({ ok: true });
		expect(Chat.admission(context)).toBe("busy");
	});

	it("takes a later note to Chopin once the turn for the thread has ended", async () => {
		let { context, plan, started, turns } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));
		await started();
		turns[0]!.finish();
		await context.chat.running;

		let answered = await reply(context, ana, id, "One more thing.");

		expect(answered).toMatchObject({ ok: true, planner: "running" });
		await started(2);
		expect(turns[1]!.prompt).toContain("One more thing.");
		expect(plan.chat.acting).toBe(id);
	});

	it("stops working on a thread once it is resolved", async () => {
		let { broadcasts, context, plan, server, started } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));
		await started();
		expect(Comments.working(plan, id)).toBe(true);

		await Comments.resolve(
			plan,
			server,
			"test",
			ana.socket,
			ask({
				kind: "comment:resolve" as const,
				id,
			}),
		);
		expect(Comments.working(plan, id)).toBe(false);
		expect(broadcasts).toContainEqual(expect.objectContaining({ kind: "comment:resolved", id }));
	});
});

/** What the Planner says in Chat, as stream parts. */
let said = (text: string) => [
	{ type: "text-start", id: "m" },
	{ type: "text-delta", id: "m", text },
	{ type: "text-end", id: "m" },
];

describe("how a turn ends on its thread", () => {
	async function ending() {
		let fixture = await opened();
		let ana = member("ana");
		let id = idOf(await start(fixture.context, ana));
		await fixture.started();
		return { ...fixture, ana, id, turn: fixture.turns[0]! };
	}

	it("posts the Planner's last word in Chat when it never replied in the thread", async () => {
		let { broadcasts, context, id, plan, storage, turn } = await ending();

		turn.finish(said("Shortened it to 30s."));
		await context.chat.running;

		let notes = plan.threads.get(id)!.notes;
		expect(notes.at(-1)).toMatchObject({ author: "planner", text: "Shortened it to 30s." });
		expect(broadcasts).toContainEqual(expect.objectContaining({ kind: "comment:said", id }));
		let saved = await storage.collaboration.load(plan.id, new Date());
		expect(JSON.stringify(saved?.sidecar)).toContain("Shortened it to 30s.");
		expect(working(broadcasts).at(-1)).toEqual(
			expect.objectContaining({ id, working: false }),
		);
		expect(working(broadcasts).at(-1)).not.toHaveProperty("reason");
	});

	it("does not repeat itself when the Planner already replied", async () => {
		let { context, id, plan, server, turn } = await ending();

		expect(await Comments.answer(plan, server, "test", id, "Done — 30s now.", plan.chat.acting))
			.toMatchObject({
				ok: true,
			});
		turn.finish(said("Shortened it."));
		await context.chat.running;

		let notes = plan.threads.get(id)!.notes;
		expect(notes.filter(note => note.author === "planner")).toHaveLength(1);
	});

	it("says why it stopped", async () => {
		let quiet = console.error;
		console.error = () => {};
		try {
			let stopped = await ending();
			await Chat.abort(stopped.context, stopped.ana.socket);
			await stopped.context.chat.running;
			expect(stopped.plan.threads.get(stopped.id)!.notes).toHaveLength(1);
			expect(working(stopped.broadcasts).at(-1)).toEqual(
				expect.objectContaining({ id: stopped.id, working: false, reason: "stopped" }),
			);

			let failed = await ending();
			failed.turn.fail(new Error("The model stopped answering."));
			await failed.context.chat.running;
			expect(failed.plan.threads.get(failed.id)!.notes).toHaveLength(1);
			expect(working(failed.broadcasts).at(-1)).toEqual(
				expect.objectContaining({ id: failed.id, working: false, reason: "failed" }),
			);
		} finally {
			console.error = quiet;
		}
	});
});

describe("the Planner's reply", () => {
	it("is refused for any thread but the one its turn was sent", async () => {
		let { context, plan, server, started } = await opened();
		let ana = member("ana");
		let sent = idOf(await start(context, ana));
		await started();
		let other = idOf(await start(context, ana, "Plain note.", null));

		expect(await Comments.answer(plan, server, "test", other, "Hello", plan.chat.acting))
			.toMatchObject({
				ok: false,
				reason: "not-asked",
			});
		expect(plan.threads.get(other)!.notes).toHaveLength(1);
		expect(await Comments.answer(plan, server, "test", sent, "Hello", plan.chat.acting))
			.toMatchObject({ ok: true });
	});

	it("is refused once the thread is resolved", async () => {
		let { context, plan, server, started } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));
		await started();
		await Comments.resolve(
			plan,
			server,
			"test",
			ana.socket,
			ask({
				kind: "comment:resolve" as const,
				id,
			}),
		);

		expect(await Comments.answer(plan, server, "test", id, "Done", plan.chat.acting)).toMatchObject(
			{
				ok: false,
				reason: "resolved",
			},
		);
	});

	it("tells nobody, and keeps nothing, when it cannot be saved", async () => {
		let { broadcasts, context, plan, server, started } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));
		await started();
		broadcasts.length = 0;

		let original = plan.persistence.storage.collaboration.commit;
		let fatal = plan.persistence.fatal;
		plan.persistence.fatal = () => {};
		plan.persistence.storage.collaboration.commit = () => Promise.reject(new Error("disk full"));
		let quiet = console.error;
		console.error = () => {};
		let outcome: unknown;
		try {
			outcome = await Comments.answer(plan, server, "test", id, "Done", plan.chat.acting).catch(
				err => err,
			);
		} finally {
			console.error = quiet;
			plan.persistence.storage.collaboration.commit = original;
			plan.persistence.fatal = fatal;
		}
		await Service.persist(plan);

		expect(outcome).toBeInstanceOf(Error);
		expect(broadcasts.filter(frame => frame.kind === "comment:said")).toEqual([]);
		expect(plan.threads.get(id)!.notes).toHaveLength(1);
	});
});

describe("what a thread looks like to someone joining", () => {
	it("says the Planner is working while its turn runs, and only then", async () => {
		let { context, plan, started, turns } = await opened();
		let ana = member("ana");
		let id = idOf(await start(context, ana));
		await started();

		let joiner = member("kris");
		Comments.greet(plan, joiner.socket);
		let sync = joiner.replies.find(frame => frame.kind === "comment:sync");
		expect(sync?.threads).toEqual([expect.objectContaining({ id, working: true })]);

		turns[0]!.finish();
		await context.chat.running;
		Comments.greet(plan, joiner.socket);
		let later = joiner.replies.findLast(frame => frame.kind === "comment:sync");
		expect((later!.threads as Array<object>)[0]).not.toHaveProperty("working");
	});

	it("keeps a resolved thread that changed the plan, and drops one that did not", async () => {
		let { context, plan, server } = await opened();
		let ana = member("ana");
		let changed = idOf(await start(context, ana));
		Comments.attribute(plan, changed, [1]);
		await Comments.resolve(
			plan,
			server,
			"test",
			ana.socket,
			ask({
				kind: "comment:resolve" as const,
				id: changed,
			}),
		);

		let joiner = member("kris");
		Comments.greet(plan, joiner.socket);
		let sync = joiner.replies.find(frame => frame.kind === "comment:sync");
		expect(sync?.threads).toEqual([expect.objectContaining({ id: changed, status: "resolved" })]);
		expect(Comments.anchors(plan)).toEqual([
			expect.objectContaining({
				thread: changed,
				result: expect.objectContaining({ pending: false }),
			}),
		]);
	});

	it("gathers what each turn on an open thread anchored", async () => {
		let { context, plan } = await opened();
		let id = idOf(await start(context, member("ana")));
		let digests = room.digests(plan.document);

		expect(Comments.relate(plan, id, [{ index: 1, digest: digests[1]! }])).toBeUndefined();
		expect(Comments.relate(plan, id, [{ index: 2, digest: digests[2]! }])).toBeUndefined();
		expect(Comments.relate(plan, id, [{ index: 2, digest: digests[2]! }])).toBeUndefined();

		expect(plan.threads.get(id)?.result?.anchors).toHaveLength(2);
	});

	it("reads notes saved before notes named their author as a member's", () => {
		let record = Comments.normalize({
			id: "t",
			status: "open",
			passage: {} as never,
			notes: [{ id: "n", handle: "ana", text: "Old.", ts: 1 } as never],
		});
		expect(record.notes[0]).toEqual({
			id: "n",
			author: "member",
			handle: "ana",
			text: "Old.",
			ts: 1,
		});
	});
});

// -- a comment inside a child document -----------------------------------------

/** A root and its child sharing one store, wired as `main.ts` wires them. */
async function rootAndChild() {
	let fixture = await rooted({ root: SOURCE, child: SOURCE });
	cleanups.push(fixture.close);
	let { root, child, turns, repository } = fixture;
	root.context.decide = decideReplying({ input: { type: "noul", noul: 0 } });
	let committedAtBroadcast: string[] = [];
	fixture.listen((topic, frame) => {
		if (topic === Wire.topic(child.channel.id) && frame.kind === "comment:said") {
			committedAtBroadcast.push(JSON.stringify(child.plan.persistence.committedSidecar));
		}
	});
	let holds = { opened: 0, released: 0 };
	child.context.root = createRootChat({
		rootId: root.channel.id,
		childId: child.channel.id,
		repositoryId: repository.id,
		channels: fixture.storage.channels,
		open: async () => {
			holds.opened++;
			return {
				context: root.context,
				release: () => {
					holds.released++;
				},
			};
		},
		live: () => root.plan.chat,
	});
	let owner = { signal: new AbortController().signal, revalidate: async () => true };
	let replyAs = async (thread: string, text: string) =>
		JSON.parse(
			String(
				await documentTools.reply_comment.execute!({ thread, text } as never, {
					context: { room: Chat.documentRoom(root.context), owner, repository },
					toolCallId: "call",
					messages: [],
				} as never),
			),
		);
	let ana = member("ana");
	/** Sends a comment in the child to Chopin; the thread id, or the refusal. */
	let sendToChopin = async (text: string) => {
		let answered = await start(child.context, ana, text);
		if (!answered?.ok) return answered as Sent;
		await turns.started();
		return idOf(answered);
	};
	return {
		root: { prompts: turns.prompts, plan: root.plan, channel: root.channel },
		rootChat: root.plan.chat,
		child: {
			channel: child.channel,
			plan: child.plan,
			root: child.context.root,
			committedAtBroadcast,
			sendToChopin,
		},
		events: fixture.events,
		holds,
		turns,
		user: fixture.user,
		rootContext: root.context,
		childContext: child.context,
		async startChildComment(text: string, _options: { to: "planner" }) {
			return sendToChopin(text) as Promise<string>;
		},
		replyFromRootTurn: replyAs,
		async replyWithWrongTarget(
			which: "root-thread-while-child-acting" | "child-thread-while-root-acting",
		) {
			let rootThread = idOf(await start(root.context, member("kris"), "Root note.", null));
			let childThread = idOf(await start(child.context, member("kris"), "Child note.", null));
			if (which === "root-thread-while-child-acting") {
				root.plan.chat.acting = childThread;
				root.plan.chat.actingChannel = child.channel.id;
				return replyAs(rootThread, "Wrong place.");
			}
			root.plan.chat.acting = rootThread;
			root.plan.chat.actingChannel = undefined;
			return replyAs(childThread, "Wrong place.");
		},
		async busyRoot() {
			root.plan.chat.busy = true;
		},
		async endRootTurnWithChatOnly(text: string) {
			await turns.finish([
				{ type: "text-start", id: "m" },
				{ type: "text-delta", id: "m", text },
				{ type: "text-end", id: "m" },
				{ type: "finish" },
			]);
			await root.plan.chat.running;
		},
	};
}

describe("a comment sent to Chopin inside a child document", () => {
	it("runs on the root's Chat with the child as focus", async () => {
		let { root, child, rootChat, startChildComment } = await rootAndChild();
		let thread = await startChildComment("@ana: tighten this", { to: "planner" });

		// Notice in the root's transcript, linking back to the child thread.
		let notice = rootChat.entries.find(entry => entry.comment?.thread === thread);
		expect(notice?.comment?.channelId).toBe(child.channel.id);
		// The child's own Chat never gains an entry or a turn.
		expect(child.plan.chat.entries).toHaveLength(0);
		expect(child.plan.chat.busy).toBe(false);
		// The root turn names the child and knows which thread it acts on.
		expect(root.prompts.at(-1)).toContain(`child id ${child.channel.id}`);
		expect(root.prompts.at(-1)).toContain("`edit_child`");
		expect(rootChat.acting).toBe(thread);
		expect(rootChat.actingChannel).toBe(child.channel.id);
	});

	it("tells the child room the root's Planner is working on the thread", async () => {
		let { child, events, startChildComment } = await rootAndChild();
		let thread = await startChildComment("tighten this", { to: "planner" });
		expect(events).toContainEqual({
			topic: Wire.topic(child.channel.id),
			frame: expect.objectContaining({ kind: "comment:working", id: thread, working: true }),
		});
		let joiner = member("kris");
		Comments.greet(child.plan, joiner.socket, child.root);
		expect(joiner.replies.find(frame => frame.kind === "comment:sync")?.threads).toEqual([
			expect.objectContaining({ id: thread, working: true }),
		]);
	});

	it("reply_comment from the root turn answers the child's thread, persisted before broadcast", async () => {
		let { child, replyFromRootTurn } = await rootAndChild();
		let thread = await child.sendToChopin("tighten this") as string;
		let reply = await replyFromRootTurn(thread, "Done in the child.");
		expect(reply).toMatchObject({ ok: true });
		let record = child.plan.threads.get(thread)!;
		expect(record.notes.at(-1)).toMatchObject({ author: "planner", text: "Done in the child." });
		expect(child.committedAtBroadcast.at(-1)).toContain("Done in the child.");
	});

	it("reply_comment refuses a root thread while the turn acts on a child thread, and the reverse", async () => {
		let { replyWithWrongTarget } = await rootAndChild();
		expect(await replyWithWrongTarget("root-thread-while-child-acting")).toMatchObject({
			ok: false,
			reason: "not-asked",
		});
		expect(await replyWithWrongTarget("child-thread-while-root-acting")).toMatchObject({
			ok: false,
			reason: "not-asked",
		});
	});

	it("a busy root refuses the child comment before saving it", async () => {
		let { child, busyRoot } = await rootAndChild();
		await busyRoot();
		let refused = await child.sendToChopin("tighten this");
		expect(refused).toMatchObject({ ok: false, reason: "busy" });
		expect(child.plan.threads.size).toBe(0);
	});

	it("the backstop posts the root turn's last Chat word into the child thread", async () => {
		let { child, endRootTurnWithChatOnly } = await rootAndChild();
		let thread = await child.sendToChopin("tighten this") as string;
		await endRootTurnWithChatOnly("Answered in Chat only.");
		expect(child.plan.threads.get(thread)!.notes.at(-1)).toMatchObject({
			author: "planner",
			text: "Answered in Chat only.",
		});
	});

	it("keeps the root and child rooms held until the child's turn has itself ended", async () => {
		let { child, childContext, events, holds, rootChat, turns } = await rootAndChild();
		let answered = await start(childContext, member("ana"), "tighten this");
		expect(answered).toMatchObject({ ok: true, planner: "running" });
		let thread = idOf(answered);
		await turns.started();
		// Admission released its hold; the running turn's is still held.
		expect(holds).toEqual({ opened: 2, released: 1 });
		expect(rootChat.acting).toBe(thread);

		await turns.finish();
		await rootChat.running;
		expect(holds.released).toBe(2);
		expect(events.findLast(event => event.frame.kind === "comment:working")).toEqual({
			topic: Wire.topic(child.channel.id),
			frame: expect.objectContaining({ id: thread, working: false }),
		});
	});

	it("releases the rooms and says the turn stopped when the root closes mid-turn", async () => {
		let { child, events, holds, rootChat, startChildComment, turns } = await rootAndChild();
		let thread = await startChildComment("tighten this", { to: "planner" });
		expect(rootChat.acting).toBe(thread);
		expect(holds).toEqual({ opened: 2, released: 1 });

		let closing = Chat.close(rootChat);
		await turns.finish();
		await closing;
		await Bun.sleep(0);

		expect(holds.released).toBe(2);
		expect(events.findLast(event => event.frame.kind === "comment:working")).toEqual({
			topic: Wire.topic(child.channel.id),
			frame: expect.objectContaining({ id: thread, working: false, reason: "stopped" }),
		});
	});

	it("refuses a later note in the child while its thread's turn runs, and holds nothing more", async () => {
		let { child, childContext, holds, rootChat, turns } = await rootAndChild();
		let thread = idOf(await start(childContext, member("ana"), "tighten this"));
		await turns.started();
		expect(holds).toEqual({ opened: 2, released: 1 });
		let refused = await reply(childContext, member("kris"), thread, "And shorten it.");
		expect(refused).toMatchObject({ ok: false, reason: "busy" });
		// Admission opened the root again and let it go; nothing waits for the turn to end.
		expect(holds).toEqual({ opened: 3, released: 2 });
		expect(rootChat.waiting).toEqual([]);
		expect(child.plan.threads.get(thread)?.notes).toHaveLength(1);
		await turns.finish();
		await rootChat.running;
	});

	it("says the turn failed when the root cannot take it after the note is saved", async () => {
		let { child, childContext, events } = await rootAndChild();
		let root = child.root!;
		childContext.root = {
			...root,
			instruct: async () => {
				throw new Error("the root document is unavailable");
			},
		};
		let quiet = console.error;
		console.error = () => {};
		let answered = await start(childContext, member("ana"), "tighten this").finally(() => {
			console.error = quiet;
		});
		let thread = idOf(answered);
		expect(child.plan.threads.get(thread)?.notes).toHaveLength(1);
		expect(events.findLast(event => event.frame.kind === "comment:working")).toEqual({
			topic: Wire.topic(child.channel.id),
			frame: expect.objectContaining({ id: thread, working: false, reason: "failed" }),
		});
	});

	it("refuses the note when the child no longer belongs to the root", async () => {
		let { child } = await rootAndChild();
		await child.plan.persistence.storage.channels.archive({
			id: child.channel.id,
			now: new Date(),
		});
		let quiet = console.error;
		console.error = () => {};
		let refused = await child.sendToChopin("tighten this").finally(() => {
			console.error = quiet;
		});
		expect(refused).toMatchObject({ ok: false });
		expect(child.plan.threads.size).toBe(0);
	});
});

describe("a comment sent to Chopin while its machine is away", () => {
	it("is refused before it is saved, with the connection's own words, and nothing is held", async () => {
		let { broadcasts, context, plan } = await opened({ busy: false });
		context.plannerNotAttached = async () => "No machine is connected.";
		let ana = member("ana");
		let answered = await start(context, ana, "Rephrase this.");
		expect(answered).toMatchObject({
			ok: false,
			code: "planner-not-attached",
			message: "No machine is connected.",
		});
		expect(plan.threads.size).toBe(0);
		expect(plan.chat.waiting).toEqual([]);
		expect(plan.chat.entries).toEqual([]);
		expect(working(broadcasts)).toHaveLength(0);
	});
});
