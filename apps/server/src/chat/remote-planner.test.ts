import { afterEach, expect, test } from "bun:test";

import { ActiveOwnerBindings } from "../agent/active-owner";
import { createPlannerAgent } from "../harness/agents";
import { createRemoteAdapter } from "../harness/remote/adapter";
import { disconnectedMessage, notAttachedMessage } from "../harness/remote/attachments";
import { openPlannerSession } from "../harness/session";
import * as Plan from "../plan/service";
import { configured } from "../testing/config";
import { decideReplying } from "../conversation-plan/decisions.test-fixtures";
import {
	attach,
	finishTurn,
	holdingProxy,
	linkAuth,
	linkServer,
	MEMBER_TOKEN,
	RIVAL_TOKEN,
	scriptedPlanner,
} from "../testing/agent-link";
import { AgentRefused, connectAgent } from "@chopin/agent-link/client";
import { GitHubError } from "../github/client";
import { laterTimers } from "../testing/decisions";
import { expectPlainStatusLines } from "../testing/plain-words";
import * as Chat from "./service";
import { ReferenceService } from "./references";
import { plannerCommands } from "../harness/harnesses";
import { attachedLink } from "../harness/remote/registry";
import * as Question from "@chopin/question";
import { answerTurns } from "../questions/answer-turns";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { member } from "../questions/text-response.test-fixtures";

import type { Server } from "bun";
import type { Chat as Wire } from "@chopin/protocol";
import type { CapabilityCatalog } from "@chopin/agent-link";
import type { AgentClient, AgentHandlers } from "@chopin/agent-link/client";
import type { HostedAuth } from "../auth/routes";
import type { Socket, SocketData } from "../wire";

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const REMOTE = { HARNESS: "remote", BACKGROUND_JOBS: "off" };
/** How long a deployment keeps a dropped link by default (`PLANNER_ATTACH_GRACE_MS`). */
const GRACE_MS = configured(REMOTE).plannerAttachGraceMs;
const RIVAL = { id: "U_rival", login: "rival" };

function card(status: "running" | "paused") {
	return {
		id: "run-1",
		name: "plan-review",
		status,
		started: 1,
		updated: 1,
		stages: [],
		waiting: 0,
	};
}

/**
 * A document's Chat under `HARNESS=remote`, served as `main.ts` serves it,
 * with a real agent connection server. The rival sends from a browser with a
 * login of their own; only the attached member may own the Planner.
 */
async function remoteRoom(graceMs?: number, operationMs?: number) {
	let { auth, storage, channel, logins, revocations, signOut, clock } = await linkAuth();
	let server = linkServer(auth, operationMs, undefined, graceMs);
	cleanups.push(server.stop);
	revocations.add(id => server.attachments.sessionRevoked(id));
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let events: Array<{ kind: string; [key: string]: unknown }> = [];
	let publisher = {
		publish(_topic: string, message: string) {
			events.push(JSON.parse(message));
		},
	} as unknown as Server<SocketData>;
	let plan = await Plan.open(channel.id, {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	}, publisher);
	let owners = new ActiveOwnerBindings(auth as unknown as HostedAuth);
	let url = `https://chopin.test/documents/octo-org/score/${channel.slug}`;
	let agent = createPlannerAgent(createRemoteAdapter());
	let context: Chat.Room = {
		decide: decideReplying({ input: { type: "noul", noul: 0 } }),
		chat: plan.chat,
		plan,
		room: channel.id,
		server: publisher,
		auth: auth as unknown as HostedAuth,
		repository: { id: "R_score", owner: "octo-org", name: "score", defaultBranch: "main" },
		config: configured(REMOTE),
		claimantSessionId: logins.get("rival"),
		plannerNotAttached: async () =>
			await server.attachments.confirmed(channel.id)
				? undefined
				: server.attachments.status(channel.id).state === "disconnected"
				? disconnectedMessage(server.attachments.holder(channel.id))
				: notAttachedMessage(url, "octo-org/score"),
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
	};
	cleanups.push(async () => {
		owners.revokeAll();
		await Chat.close(plan.chat);
		await Plan.close(plan);
	});
	let replies: Array<{ kind: string; rid?: string; [key: string]: unknown }> = [];
	let ws = {
		data: { handle: RIVAL.login, principalId: RIVAL.id, sessionId: logins.get("rival") },
		send(text: string) {
			replies.push(JSON.parse(text));
		},
	} as unknown as Socket;
	let send = async (
		text: string,
		to: "planner" | "room" = "planner",
		references?: Wire.ReferenceRequest[],
	) => {
		let rid = crypto.randomUUID();
		await Chat.send(context, ws, {
			kind: "chat:send",
			rid,
			requestId: crypto.randomUUID(),
			to,
			text,
			...(references ? { references } : {}),
			ts: 0,
		} as never);
		return replies.find(reply => reply.rid === rid);
	};
	let owner = async () =>
		(await storage.channels.readAgent(channel.id, new Date()))?.agent?.ownerSessionId;
	return {
		context,
		server,
		storage,
		channel,
		logins,
		url,
		ws,
		send,
		owner,
		events,
		signOut,
		clock,
	};
}

/**
 * The room with the member attached as its Planner and every browser sign-in
 * expired, before the link's periodic recheck or any cleanup has noticed,
 * counting what Chat saves from then on.
 */
async function expiredOwnerRoom() {
	let room = await remoteRoom();
	let member = await attach(room.server.url, room.channel.id, scriptedPlanner().handlers);
	cleanups.push(() => member.detach());
	expect(await room.owner()).toBe(room.logins.get("member"));
	room.clock.skewMs = 31 * 24 * 60 * 60 * 1_000;
	let saves = 0;
	let persist = room.context.persist;
	room.context.persist = async chat => {
		saves++;
		await persist(chat);
	};
	return { ...room, member, saves: () => saves };
}

test("with no attached Planner, @chopin and invoke_planner are refused with how to attach one, and nothing is posted or queued", async () => {
	let room = await remoteRoom();
	let { context } = room;
	let saves = 0;
	let persist = context.persist;
	context.persist = async chat => {
		saves++;
		await persist(chat);
	};
	let message = "Connect a machine to get a reply. Connect an agent client to "
		+ `${room.url} over the agent connection from a session in a checkout of octo-org/score.`;

	expect(await room.send("@chopin draft the plan")).toMatchObject({
		kind: "session:error",
		code: "planner-not-attached",
		message,
	});
	context.chat.busy = true;
	expect(await room.send("@chopin and then this")).toMatchObject({ code: "planner-not-attached" });
	context.chat.busy = false;
	expect(await Chat.invoke(context, RIVAL, "Draft the plan")).toBe("planner-not-attached");
	expect(context.chat.entries).toEqual([]);
	expect(context.chat.waiting).toEqual([]);
	expect(saves).toBe(0);
	expect(await room.owner()).toBeUndefined();

	expect(await room.send("Just talking", "room")).toMatchObject({ kind: "chat:send" });
	expect(context.chat.entries.map(entry => entry.text)).toEqual(["Just talking"]);
});

/** Keeps a person's requests as rows, as `main.ts` does in hosted mode. */
function withRows(room: Awaited<ReturnType<typeof remoteRoom>>) {
	let { context, server, channel } = room;
	context.deferred = {};
	context.plannerReady = () => server.attachments.confirmed(channel.id);
	context.persist = (chat, deferred) => Plan.persistDeferred(context.plan, chat, deferred);
}

test("with rows, a message sent while no Planner is attached is saved as sent, never refused, and the client that attaches afterwards receives it once, as the owner, in order", async () => {
	let room = await remoteRoom();
	let { context } = room;
	withRows(room);
	let first = await room.send("@chopin draft the plan");
	let second = await room.send("@chopin and then this");
	expect(first).toMatchObject({ kind: "chat:send", queued: true });
	expect(second).toMatchObject({ kind: "chat:send", queued: true });
	expect(context.chat.entries.map(entry => entry.deliveryState)).toEqual(["sent", "sent"]);
	expect(await room.owner()).toBeUndefined();
	expect(await room.storage.deferredTurns.list(room.channel.id, ["waiting"])).toHaveLength(2);

	let script = scriptedPlanner();
	let member = await attach(room.server.url, room.channel.id, script.handlers);
	cleanups.push(() => member.detach());
	// What `main.ts` does when a Planner attaches.
	await Chat.kick(context);
	await context.chat.running;
	expect(script.turns.map(turn => turn.prompt)).toEqual([
		expect.stringContaining("draft the plan"),
		expect.stringContaining("and then this"),
	]);
	expect(await room.owner()).toBe(room.logins.get("member"));
	expect(
		context.chat.entries.filter(entry => entry.author.kind === "member").map(entry =>
			entry.deliveryState
		),
	).toEqual(["delivered", "delivered"]);
	expect((await room.storage.deferredTurns.list(room.channel.id)).map(row => row.state)).toEqual([
		"ended",
		"ended",
	]);
	// Another attach finds nothing left to send.
	await Chat.kick(context);
	await Bun.sleep(20);
	expect(script.turns).toHaveLength(2);
});

test("other harnesses keep claiming ownership for the sender as before", async () => {
	let room = await remoteRoom();
	let { context } = room;
	context.config = configured({});
	context.plannerNotAttached = undefined;
	let started: string[] = [];
	context.openPlannerSession = async () => ({
		ok: true,
		value: {
			stream: async (prompt: string) => {
				started.push(prompt);
				return { fullStream: (async function*() {})() };
			},
			destroy: async () => {},
		} as never,
	});
	expect(await room.send("@chopin draft the plan")).toMatchObject({ kind: "chat:send" });
	await context.chat.running;
	expect(started).toHaveLength(1);
	expect(await room.owner()).toBe(room.logins.get("rival"));
});

test("an attached Planner receives @chopin and invoke_planner turns as their owner, and Stop and Resume reach it", async () => {
	let room = await remoteRoom();
	let { context } = room;
	let script = scriptedPlanner();
	let controls: Array<{ type: string; run?: string }> = [];
	let client: AgentClient;
	client = await attach(room.server.url, room.channel.id, {
		...script.handlers,
		async turn(turn) {
			script.turns.push(turn.message);
			if (turn.message.prompt.includes("Run the review")) {
				client.reportRuns(turn.message.session, {
					active: ["run-1"],
					paused: [],
					cards: [card("running")],
				});
			}
			finishTurn(turn);
		},
		control(message) {
			controls.push({ type: message.type, run: message.run });
			client.reportRuns(
				message.session,
				message.type === "stop"
					? { active: [], paused: ["run-1"], cards: [card("paused")] }
					: { active: ["run-1"], paused: [], cards: [card("running")] },
			);
		},
	});
	cleanups.push(() => client.detach());
	expect(await room.owner()).toBe(room.logins.get("member"));

	expect(await room.send("@chopin draft the plan")).toMatchObject({ kind: "chat:send" });
	await context.chat.running;
	expect(await Chat.invoke(context, RIVAL, "Run the review")).toBeUndefined();
	await context.chat.running;
	expect(script.turns.map(turn => turn.prompt)).toEqual([
		expect.stringContaining("draft the plan"),
		expect.stringContaining("Run the review"),
	]);
	expect(await room.owner()).toBe(room.logins.get("member"));
	expect(context.chat.retained).toBeDefined();

	await Chat.abort(context, room.ws);
	await Bun.sleep(20);
	await Chat.resume(context, room.ws);
	expect(controls).toEqual([{ type: "stop", run: undefined }, { type: "resume", run: undefined }]);
	expect(context.chat.entries.map(entry => entry.text)).toContain(
		"@rival stopped Chopin and paused its workflows.",
	);
	expect(context.chat.entries.map(entry => entry.text)).toContain(
		"@rival resumed Chopin's workflows.",
	);
});

test("once the attached Planner's owner sign-in expires, @chopin is refused with how to attach one before its periodic recheck, and nothing is posted or queued", async () => {
	let room = await expiredOwnerRoom();
	let { context } = room;
	expect(await room.send("@chopin draft the plan")).toMatchObject({
		kind: "session:error",
		code: "planner-not-attached",
		message: "Connect a machine to get a reply. Connect an agent client to "
			+ `${room.url} over the agent connection from a session in a checkout of octo-org/score.`,
	});
	expect(context.chat.entries).toEqual([]);
	expect(context.chat.waiting).toEqual([]);
	expect(room.saves()).toBe(0);
	expect(room.events).toEqual([]);
	expect(await room.member.closed).toEqual({ code: 4401, reason: "sign-in-required" });
	expect(room.server.attachments.attached(room.channel.id)).toBe(false);
	expect(await room.owner()).toBeUndefined();
});

test("once the attached Planner's owner sign-in expires, invoke_planner is refused as planner-not-attached before its periodic recheck", async () => {
	let room = await expiredOwnerRoom();
	let { context } = room;
	expect(await Chat.invoke(context, RIVAL, "Draft the plan")).toBe("planner-not-attached");
	expect(context.chat.entries).toEqual([]);
	expect(context.chat.waiting).toEqual([]);
	expect(room.saves()).toBe(0);
	expect(await room.member.closed).toEqual({ code: 4401, reason: "sign-in-required" });
	expect(await room.owner()).toBeUndefined();
});

test("once the attached Planner's owner signs out or is reset, @chopin and invoke_planner are refused again, and another member can attach", async () => {
	let room = await remoteRoom();
	let { context } = room;
	let refusals = async () => {
		expect(await room.send("@chopin draft the plan")).toMatchObject({
			kind: "session:error",
			code: "planner-not-attached",
		});
		expect(await Chat.invoke(context, RIVAL, "Draft the plan")).toBe("planner-not-attached");
		expect(context.chat.entries).toEqual([]);
		expect(context.chat.waiting).toEqual([]);
	};

	let member = await attach(room.server.url, room.channel.id, scriptedPlanner().handlers);
	expect(await room.owner()).toBe(room.logins.get("member"));
	await room.signOut("member");
	expect(await member.closed).toEqual({ code: 4401, reason: "sign-in-required" });
	expect(await room.owner()).toBeUndefined();
	await refusals();

	let script = scriptedPlanner();
	let rival = await attach(room.server.url, room.channel.id, script.handlers, RIVAL_TOKEN);
	expect(await room.owner()).toBe(room.logins.get("rival"));
	let held = (await room.storage.channels.readAgent(room.channel.id, new Date()))!.agent!;
	await room.storage.channels.clearAgentOwner(
		room.channel.id,
		held.ownerSessionId!,
		held.generation,
		new Date(),
	);
	room.server.attachments.ownerReset(room.channel.id);
	expect(await rival.closed).toEqual({ code: 4403, reason: "access-revoked" });
	await refusals();
	expect(script.turns).toEqual([]);

	let again = await attach(room.server.url, room.channel.id, script.handlers, RIVAL_TOKEN);
	cleanups.push(() => again.detach());
	expect(await room.send("@chopin draft the plan")).toMatchObject({ kind: "chat:send" });
	await context.chat.running;
	expect(script.turns.map(turn => turn.prompt)).toEqual([
		expect.stringContaining("draft the plan"),
	]);
});

test("@chopin and invoke_planner wait for a Planner that is starting, then run on it", async () => {
	let room = await remoteRoom();
	let { context } = room;
	let script = scriptedPlanner();
	let started = 0;
	// A machine is starting the document's Planner, which attaches a moment after it is asked for.
	context.plannerStarting = async () => {
		started++;
		if (started === 1) {
			setTimeout(() => {
				void attach(room.server.url, room.channel.id, script.handlers).then(client =>
					cleanups.push(() => client.detach())
				);
			}, 50);
		}
		await room.server.attachments.attachedWithin(room.channel.id, 5_000);
	};
	expect(await room.send("@chopin draft the plan")).toMatchObject({ kind: "chat:send" });
	await context.chat.running;
	expect(await Chat.invoke(context, RIVAL, "Run the review")).toBeUndefined();
	await context.chat.running;
	expect(script.turns.map(turn => turn.prompt)).toEqual([
		expect.stringContaining("draft the plan"),
		expect.stringContaining("Run the review"),
	]);
	// A message to the room never waits for the Planner.
	expect(await room.send("Just talking", "room")).toMatchObject({ kind: "chat:send" });
	expect(started).toBe(2);
});

test("saving a decision the Planner left open starts one turn on the attached Planner carrying the answer", async () => {
	let room = await remoteRoom();
	let { context } = room;
	let script = scriptedPlanner();
	let client = await attach(room.server.url, room.channel.id, script.handlers);
	cleanups.push(() => client.detach());
	let id = await Questions.capture(context.plan, context.server, context.room, {
		key: "blocked-run-next-step",
		question: "How should the wrong sentence be fixed?",
	}, { revision: context.plan.revision });
	let turns = answerTurns({
		store: room.storage.decisionAnswers,
		// Sent when the test asks, as when a Planner attaches.
		window: { quietMs: 60_000, longestMs: 60_000 },
		start: async (_channelId, compose) => {
			let instruction = compose(context.plan);
			if (!instruction) return false;
			await Chat.instruct(
				context,
				instruction.handle,
				instruction.text,
				instruction.said,
				instruction.about,
			);
			return true;
		},
	});
	let handing: Promise<void>[] = [];
	let save = async () => {
		let actor = member("ana");
		let entry = Store.get(context.plan.questions, id)!;
		let question = entry.definition.questions[0]!;
		let fork = entry.model.fork() as Question.Model;
		fork.api.str([question.id, "custom"]).ins(0, "Start a new run for it.");
		await Questions.edit(context.plan, actor.ws, {
			kind: "question:edit",
			ts: 0,
			rid: "edit",
			id,
			patch: [...fork.api.flush().toBinary()],
		});
		await Questions.submit(
			context.plan,
			context.server,
			context.room,
			actor.ws,
			{
				kind: "question:submit",
				ts: 0,
				rid: "save",
				id,
				revision: Store.get(context.plan.questions, id)!.revision,
			},
			undefined,
			(answered, generation) => {
				handing.push(turns.answered(context.room, answered, generation));
				handing.push(turns.answered(context.room, answered, generation));
			},
		);
		expect(actor.frames.at(-1)).toMatchObject({ kind: "question:submit", ok: true });
	};

	await save();
	await Promise.all(handing);
	await turns.pending(context.room);
	turns.close();
	await context.chat.running;

	expect(script.turns.map(turn => turn.prompt)).toEqual([
		expect.stringContaining(JSON.stringify("Start a new run for it.")),
	]);
	expect(script.turns[0]!.prompt).toContain(
		JSON.stringify("How should the wrong sentence be fixed?"),
	);
	expect(context.chat.entries.map(entry => entry.text)).toContain(
		'@ana answered "How should the wrong sentence be fixed?"',
	);
});

/** A member's Save of an open choice card, as the Decisions surface sends it. */
async function answerChoice(context: Chat.Room, id: string, index: number) {
	let opened = Store.snapshot(context.plan.questions, id);
	if (!opened.open) throw new Error("question closed");
	let definition = Store.get(context.plan.questions, id)!.definition;
	let model = Question.restore(opened.model, definition);
	let question = definition.questions[0]!;
	model.api.val([question.id, "mode"]).set("choices");
	model.api.val([question.id, "choice"]).set(question.options[index]!.id);
	let patch = model.api.flush();
	let actor = member("ana");
	if (patch) {
		await Questions.edit(context.plan, actor.ws, {
			kind: "question:edit",
			ts: 0,
			rid: "edit",
			id,
			patch: [...patch.toBinary()],
		});
	}
	await Questions.submit(context.plan, context.server, context.room, actor.ws, {
		kind: "question:submit",
		ts: 0,
		rid: "save",
		id,
		revision: Store.get(context.plan.questions, id)!.revision,
	});
	expect(actor.frames.at(-1)).toMatchObject({ kind: "question:submit", ok: true });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

async function until(check: () => boolean, ms = 3_000) {
	for (let deadline = Date.now() + ms; Date.now() < deadline && !check(); await Bun.sleep(5));
	expect(check()).toBe(true);
}

/**
 * A resumable client that took one turn, reported `run-1` live and, if told to, asked one
 * question. `drop()` is the network failing, with no detach and no revocation; `reconnect()` is
 * the same account's next link, which resumes what the dropped one held; `controls` is what the
 * client was told to do with its runs. `graceMs` is how long the server keeps a dropped link and
 * `operationMs` how long it waits for the client to answer a control. A `silent` client takes
 * every control and never answers it, as one whose network is failing does, until `answering()`.
 */
async function resumablePlanner(
	options: {
		run?: boolean;
		ask?: boolean;
		graceMs?: number;
		operationMs?: number;
		silent?: boolean;
		/** The question's caller can withdraw it with `withdraw()`, as an aborted workflow stage does. */
		withdrawable?: boolean;
		/** The client reaches the server through a proxy that can go silent without closing. */
		proxied?: boolean;
	} = {},
) {
	let room = await remoteRoom(options.graceMs, options.operationMs);
	let { context, server } = room;
	let proxy = options.proxied ? await holdingProxy(server.url, 10) : undefined;
	if (proxy) cleanups.push(proxy.stop);
	let script = scriptedPlanner();
	let controls: string[] = [];
	let silent = options.silent === true;
	let withdrawal = new AbortController();
	let asked: Promise<{ status: string; value?: unknown }> | undefined;
	let first: AgentClient | undefined;
	let held: Awaited<AgentClient["resumption"]>;
	let sessionId: string | undefined;
	let handlers: Partial<AgentHandlers> = {
		...script.handlers,
		async turn(turn) {
			sessionId = turn.message.session;
			if (options.run !== false) {
				first!.reportRuns(turn.message.session, {
					active: ["run-1"],
					paused: [],
					cards: [card("running")],
				});
			}
			if (options.ask && !asked) {
				asked = first!.ask(turn.message.session, {
					method: "confirm",
					title: "Ship?",
					message: "Now.",
				}, options.withdrawable ? { signal: withdrawal.signal } : {});
			}
			finishTurn(turn);
		},
		control(message) {
			controls.push(message.run ? `${message.type} ${message.run}` : message.type);
			if (silent) return new Promise<void>(() => {});
		},
	};
	let connect = (resume?: typeof held) =>
		connectAgent({
			url: resume === undefined && proxy ? proxy.url : server.url,
			token: MEMBER_TOKEN,
			document: room.channel.id,
			handlers: handlers as AgentHandlers,
			resumable: true,
			...(resume ? { resume } : {}),
		});
	first = await connect();
	expect(first.features).toContain("resumable-sessions");
	expect(await Chat.invoke(context, RIVAL, "Run the review")).toBeUndefined();
	await context.chat.running;
	if (options.ask) await until(() => [...context.plan.records.values()][0]?.status === "open");
	await until(() => context.chat.retained !== undefined);
	// Chat shows the run card, so a person's Stop or pause has a run to act on.
	if (options.run !== false) await until(() => context.chat.runs?.[0]?.status === "running");
	return {
		...room,
		handlers,
		controls,
		/** The client answers the controls it is given from now on. */
		answering() {
			silent = false;
		},
		asked: () => asked!,
		sessionId: () => sessionId!,
		proxy,
		first: () => first!,
		/** The client's own resumption, once its link has closed some other way than `drop()`. */
		setHeld(value: typeof held) {
			held = value;
		},
		/** The caller of the question stops waiting for it. */
		withdraw: () => withdrawal.abort(),
		said: () => {
			expectPlainStatusLines(context.chat.entries);
			return context.chat.entries.map(entry => entry.text);
		},
		async drop() {
			for (let socket of server.sockets) socket.close(1001, "network failed");
			held = await first!.resumption;
			expect(held).toBeDefined();
			await until(() => server.links.length === 0);
		},
		/** The session the dropped link held, to report its runs on once the client is back. */
		session: () => [...held!.sessions][0]!,
		async reconnect() {
			let client = await connect(held);
			cleanups.push(() => client.detach());
			return client;
		},
	};
}

test("with its link connected, an attached Planner's open question and live run stay open for hours, ending only with its owner's sign-in credential", async () => {
	let clock = laterTimers();
	cleanups.push(() => clock.restore());
	let live = await resumablePlanner({ ask: true });
	let { context, server } = live;
	let id = [...context.plan.records.keys()][0]!;
	// Half an hour, then two hours, then four: no wall-clock limit ends a connected Planner's work.
	for (let passed of [31 * MINUTE, 2 * HOUR, 4 * HOUR]) {
		await clock.pass(passed);
		expect(context.plan.records.get(id)?.status).toBe("open");
		expect(context.chat.retained).toBeDefined();
		expect(context.chat.runs?.map(run => run.status)).toEqual(["running"]);
		expect(server.attachments.status(live.channel.id)).toEqual({
			state: "attached",
			login: "member",
		});
		expect(live.said().some(text => text.includes("was stopped"))).toBe(false);
	}
	// The one bound is authorization: the owner's GitHub credential, which the fixture's browser
	// login issued for eight hours, is what the Planner acts under, and it cannot outlive it.
	await clock.pass(2 * HOUR);
	await until(() => context.plan.records.get(id)?.status === "cancelled");
	await until(() => context.chat.retained === undefined);
});

test("a dropped link's run card says disconnected, not stopped, and its open question stays open and answerable for as long as its client is away", async () => {
	// Installed before anything is created, so every timer the server and Chat arm is on it.
	let clock = laterTimers();
	cleanups.push(() => clock.restore());
	let down = await resumablePlanner({ ask: true, graceMs: GRACE_MS });
	let { context, server } = down;
	let id = [...context.plan.records.keys()][0]!;
	let lines = down.said();
	await down.drop();
	expect(server.attachments.status(down.channel.id)).toEqual({
		state: "disconnected",
		login: "member",
	});
	// The card keeps its last reported status and says only that its Planner is away.
	expect(context.chat.runs?.map(run => [run.status, run.disconnected])).toEqual([[
		"running",
		true,
	]]);
	// The machine's state lives on the machine button and the run cards: Chat says nothing of it.
	expect(down.said()).toEqual(lines);

	// The owner's GitHub credential of eight hours is renewed meanwhile, and a day goes by: past
	// the configured grace, the one-hour maximum and every other timer, nothing ends.
	for (let passed of [GRACE_MS, 31 * MINUTE, 3 * HOUR, 5 * HOUR, 16 * HOUR]) {
		await clock.pass(passed);
		expect(context.plan.records.get(id)?.status).toBe("open");
		expect(context.chat.retained).toBeDefined();
		expect(context.chat.runs?.map(run => [run.status, run.disconnected])).toEqual([[
			"running",
			true,
		]]);
		expect(down.said().some(text => text.includes("was stopped"))).toBe(false);
		expect(server.attachments.status(down.channel.id)).toEqual({
			state: "disconnected",
			login: "member",
		});
	}
	// Nobody else can take the Planner while its account's client may return.
	expect(await Chat.invoke(context, RIVAL, "Anything?")).toBe("planner-not-attached");
	expect(await context.plannerNotAttached!()).toContain("machine is offline");

	lines = down.said();
	let client = await down.reconnect();
	expect(context.plan.records.size).toBe(1);
	client.reportRuns(down.session(), { active: ["run-1"], paused: [], cards: [card("running")] });
	await until(() => context.chat.runs?.[0]?.disconnected === undefined);
	expect(context.chat.runs?.map(run => run.status)).toEqual(["running"]);
	// Nothing confirms its return either: the card's mark going is all there is.
	expect(down.said()).toEqual(lines);
	// The renewed credential serves the session when it is next used, and nothing was reopened.
	expect(context.chat.retained).toBeDefined();
	expect(await Chat.invoke(context, RIVAL, "Carry on")).toBeUndefined();
	await context.chat.running;
	expect(context.plan.records.size).toBe(1);
	expect(context.plan.records.get(id)?.status).toBe("open");
	await clock.pass(4 * HOUR);
	await answerChoice(context, id, 0);
	expect(await down.asked()).toMatchObject({ status: "answered", value: true });
	expect(context.plan.records.size).toBe(1);
	expect(down.said().some(text => text.includes("was stopped"))).toBe(false);
});

test("an answer given hours into a drop reaches the client that returns, which takes the open question's answer, not a cancellation", async () => {
	let clock = laterTimers();
	cleanups.push(() => clock.restore());
	let down = await resumablePlanner({ ask: true });
	let { context } = down;
	let id = [...context.plan.records.keys()][0]!;
	await down.drop();
	await clock.pass(6 * HOUR);
	await answerChoice(context, id, 0);
	await clock.pass(20 * HOUR);
	await down.reconnect();
	expect(await down.asked()).toMatchObject({ status: "answered", value: true });
	expect(context.plan.records.get(id)?.status).toBe("answered");
	expect(context.plan.records.size).toBe(1);
});

test("a dropped link's grace period only leases ownership: a Stop that ends a question-only Planner starts it, and a successor attaches once it runs out", async () => {
	let clock = laterTimers();
	cleanups.push(() => clock.restore());
	let down = await resumablePlanner({ run: false, ask: true, graceMs: GRACE_MS });
	let { context, server } = down;
	let id = [...context.plan.records.keys()][0]!;
	await down.drop();
	await clock.pass(2 * GRACE_MS);
	expect(context.plan.records.get(id)?.status).toBe("open");
	await expect(attach(server.url, down.channel.id, scriptedPlanner().handlers, RIVAL_TOKEN))
		.rejects.toMatchObject({ code: "planner-attached" });

	// Someone presses Stop: the question is withdrawn explicitly, Chat says so, and with nothing
	// left to keep, the account's ownership is leased for the grace period as a detach's is.
	await Chat.abort(context, down.ws);
	await until(() => context.plan.records.get(id)?.status === "cancelled");
	expect(down.said().at(-1)).toBe("@rival stopped Chopin and withdrew its open question.");
	await until(() => server.attachments.status(down.channel.id).state === "held");
	await clock.pass(GRACE_MS - 1);
	expect(server.attachments.status(down.channel.id)).toMatchObject({ state: "held" });
	await clock.pass(1);
	await until(() => server.attachments.status(down.channel.id).state === "none");
	let successor = await attach(
		server.url,
		down.channel.id,
		scriptedPlanner().handlers,
		RIVAL_TOKEN,
	);
	cleanups.push(() => successor.detach());
	expect(await down.owner()).toBe(down.logins.get("rival"));
});

test("the same drop of an attached Planner that did not ask for resumable sessions ends its run and question as before", async () => {
	let room = await remoteRoom();
	let { context, server } = room;
	let script = scriptedPlanner();
	let asked: Promise<{ status: string }> | undefined;
	let client: AgentClient | undefined;
	client = await connectAgent({
		url: server.url,
		token: MEMBER_TOKEN,
		document: room.channel.id,
		resumable: false,
		handlers: {
			...script.handlers,
			async turn(turn) {
				client!.reportRuns(turn.message.session, {
					active: ["run-1"],
					paused: [],
					cards: [card("running")],
				});
				asked = client!.ask(turn.message.session, {
					method: "confirm",
					title: "Ship?",
					message: "Now.",
				});
				finishTurn(turn);
			},
		},
	});
	await Chat.invoke(context, RIVAL, "Run the review");
	await context.chat.running;
	for (let socket of server.sockets) socket.close(1001, "network failed");
	expect(await asked).toMatchObject({ status: "cancelled" });
	expect(await client.resumption).toBeUndefined();
	for (let attempt = 0; attempt < 100 && context.chat.retained; attempt++) await Bun.sleep(5);
	expect(context.chat.retained).toBeUndefined();
	expect(context.chat.runs?.map(run => run.status)).toEqual(["stopped"]);
	expect([...context.plan.records.values()].map(record => record.status)).toEqual(["cancelled"]);
});

test("a Stop pressed while the attached Planner's link is down says it is pending, and reaches the client first, once, when it returns", async () => {
	let down = await resumablePlanner();
	await down.drop();
	let { context, said } = down;
	await Chat.abort(context, down.ws);
	await Chat.abort(context, down.ws);
	// Nothing has stopped: the run card stays as last reported, and the notice does not say otherwise.
	expect(context.chat.runs?.map(run => run.status)).toEqual(["running"]);
	expect(said().at(-1)).toBe(
		"@rival asked Chopin to stop. Its machine is disconnected, so its workflows will pause when it reconnects.",
	);

	let client = await down.reconnect();
	await until(() => down.controls.length > 0).catch(() => {});
	await Bun.sleep(50);
	expect(down.controls).toEqual(["stop"]);
	client.reportRuns(down.session(), { active: [], paused: ["run-1"], cards: [card("paused")] });
	await until(() => context.chat.runs?.[0]?.status === "paused");
	expect(down.controls).toEqual(["stop"]);
	expect(said().some(text => text.includes("was stopped"))).toBe(false);
});

test("pausing one run while the attached Planner's link is down is held for its client too, and the notice says it is pending", async () => {
	let down = await resumablePlanner();
	await down.drop();
	let { context, said } = down;
	await Chat.controlRun(context, down.ws, { kind: "chat:pause-run", runId: "run-1" });
	expect(context.chat.runs?.map(run => run.status)).toEqual(["running"]);
	expect(said().at(-1)).toBe(
		"@rival asked to pause plan-review. It will pause when the machine reconnects.",
	);

	await down.reconnect();
	await until(() => down.controls.length > 0).catch(() => {});
	await Bun.sleep(50);
	expect(down.controls).toEqual(["stop run-1"]);
});

test("a Stop pressed while the attached Planner's link is down withdraws a question it only waits on, as when connected", async () => {
	let down = await resumablePlanner({ run: false, ask: true });
	await down.drop();
	let { context, said } = down;
	let id = [...context.plan.records.keys()][0]!;
	expect(context.plan.records.get(id)?.status).toBe("open");
	await Chat.abort(context, down.ws);
	expect(said().at(-1)).toBe("@rival stopped Chopin and withdrew its open question.");
	expect(context.plan.records.get(id)?.status).toBe("cancelled");
	expect(context.chat.retained).toBeUndefined();

	await down.reconnect();
	expect(await down.asked()).toMatchObject({ status: "cancelled" });
	await Bun.sleep(50);
	expect(down.controls).toEqual([]);
	expect(context.plan.records.size).toBe(1);
});

test("a Stop the client had not answered when its link dropped is held, says it is pending, and reaches the client first, once, when it returns", async () => {
	let down = await resumablePlanner({ silent: true });
	let { context, said } = down;
	// The client takes the Stop and the network fails before it answers.
	let stopping = Chat.abort(context, down.ws);
	await until(() => down.controls.length === 1);
	await down.drop();
	await stopping;
	// Nothing has stopped, and the notice does not say so.
	expect(context.chat.runs?.map(run => run.status)).toEqual(["running"]);
	expect(said().at(-1)).toBe(
		"@rival asked Chopin to stop. Its machine is disconnected, so its workflows will pause when it reconnects.",
	);

	down.answering();
	let client = await down.reconnect();
	await until(() => down.controls.length === 2);
	await Bun.sleep(50);
	// The client has the original, which it never answered, and now the Stop the server owed it, once.
	expect(down.controls).toEqual(["stop", "stop"]);
	client.reportRuns(down.session(), { active: [], paused: ["run-1"], cards: [card("paused")] });
	await until(() => context.chat.runs?.[0]?.status === "paused");
	expect(down.controls).toEqual(["stop", "stop"]);
	expect(said().some(text => text.includes("was stopped"))).toBe(false);
});

test("pausing one run the client had not answered when its link dropped is held too, says it is pending, and reaches the client once when it returns", async () => {
	let down = await resumablePlanner({ silent: true });
	let { context, said } = down;
	let pausing = Chat.controlRun(context, down.ws, { kind: "chat:pause-run", runId: "run-1" });
	await until(() => down.controls.length === 1);
	await down.drop();
	await pausing;
	expect(context.chat.runs?.map(run => run.status)).toEqual(["running"]);
	expect(said().at(-1)).toBe(
		"@rival asked to pause plan-review. It will pause when the machine reconnects.",
	);

	down.answering();
	await down.reconnect();
	await until(() => down.controls.length === 2);
	await Bun.sleep(50);
	expect(down.controls).toEqual(["stop run-1", "stop run-1"]);
});

test("a Stop the attached Planner did not answer in time is not lost when its link then drops: the client hears it when it returns", async () => {
	let down = await resumablePlanner({ silent: true, operationMs: 150 });
	let { context, said } = down;
	// The link is still attached, and the client never answers.
	await Chat.abort(context, down.ws);
	expect(down.controls).toEqual(["stop"]);
	expect(context.chat.runs?.map(run => run.status)).toEqual(["running"]);
	expect(said().at(-1)).not.toContain("paused its workflows");

	// The link is only noticed to be dead later.
	await down.drop();
	down.answering();
	await down.reconnect();
	await until(() => down.controls.length === 2);
	await Bun.sleep(50);
	expect(down.controls).toEqual(["stop", "stop"]);
});

test("answering the only question of an attached Planner that has no run delivers the answer to its client before the session is let go", async () => {
	let lone = await resumablePlanner({ run: false, ask: true });
	let { context } = lone;
	let id = [...context.plan.records.keys()][0]!;
	expect(context.chat.retained).toBeDefined();
	await answerChoice(context, id, 0);
	expect(await lone.asked()).toMatchObject({ status: "answered", value: true });
	expect(context.plan.records.get(id)?.status).toBe("answered");
	// With nothing left to wait on, the session is let go once its client has the answer.
	await until(() => context.chat.retained === undefined);
});

test("an answer given while the attached Planner's link is down is held for its client and delivered once when it returns, and only then is a session with nothing else let go", async () => {
	let down = await resumablePlanner({ run: false, ask: true });
	let { context } = down;
	let id = [...context.plan.records.keys()][0]!;
	await down.drop();
	await answerChoice(context, id, 0);
	expect(context.plan.records.get(id)?.status).toBe("answered");
	// The client has not got its answer, so the session that owes it stays.
	await Bun.sleep(100);
	expect(context.chat.retained).toBeDefined();

	await down.reconnect();
	expect(await down.asked()).toMatchObject({ status: "answered", value: true });
	await until(() => context.chat.retained === undefined);
	expect(context.plan.records.get(id)?.status).toBe("answered");
});

test("a question its client withdraws while the Planner's link is down ends its wait at once and is withdrawn in Chopin when the client resumes", async () => {
	let down = await resumablePlanner({ ask: true, withdrawable: true });
	let { context } = down;
	let id = [...context.plan.records.keys()][0]!;
	await down.drop();
	// The link is down, so the server cannot hear the withdrawal yet; the caller's wait is over.
	down.withdraw();
	expect(await down.asked()).toMatchObject({ status: "cancelled" });
	expect(context.plan.records.get(id)?.status).toBe("open");

	await down.reconnect();
	await until(() => context.plan.records.get(id)?.status === "cancelled");
	expect(context.plan.records.size).toBe(1);
});

test("an answer given while the link was down stays the person's answer when the client had withdrawn the question meanwhile, and is not asked or answered twice", async () => {
	let down = await resumablePlanner({ ask: true, withdrawable: true });
	let { context } = down;
	let id = [...context.plan.records.keys()][0]!;
	await down.drop();
	await answerChoice(context, id, 0);
	down.withdraw();
	expect(await down.asked()).toMatchObject({ status: "cancelled" });

	await down.reconnect();
	await Bun.sleep(100);
	expect(context.plan.records.get(id)?.status).toBe("answered");
	expect(context.plan.records.size).toBe(1);
});

test("an answer given before the server notices the link died reaches the client once it resumes, for a Planner with only that question, and the document stays disconnected", async () => {
	let down = await resumablePlanner({ run: false, ask: true, proxied: true });
	let { context, server } = down;
	let id = [...context.plan.records.keys()][0]!;
	// The client's network goes away, and the server has not noticed yet.
	down.proxy!.hold();
	await answerChoice(context, id, 0);
	await Bun.sleep(150);
	expect(context.chat.retained).toBeDefined();
	expect(context.plan.records.get(id)?.status).toBe("answered");
	// The server now notices, and the client, which noticed first, returns.
	await down.proxy!.stop();
	down.setHeld(await down.first().resumption);
	await until(() => server.links.length === 0);
	expect(server.attachments.status(down.channel.id)).toEqual({
		state: "disconnected",
		login: "member",
	});
	await down.reconnect();
	expect(await down.asked()).toMatchObject({ status: "answered", value: true });
	await until(() => context.chat.retained === undefined);
	expect(context.plan.records.get(id)?.status).toBe("answered");
});

test("an answer the client never acknowledged is kept through a frame that crossed it, and reaches the client that resumes, for a Planner with only that question", async () => {
	let down = await resumablePlanner({ run: false, ask: true, proxied: true, operationMs: 150 });
	let { context, server } = down;
	let id = [...context.plan.records.keys()][0]!;
	down.proxy!.hold();
	await answerChoice(context, id, 0);
	// The client's own frame reaches the server after the answer was written, but never the answer.
	down.proxy!.hearClient();
	down.first().reportRuns(down.sessionId(), { active: [], paused: [], cards: [] });
	await Bun.sleep(600);
	expect(context.chat.retained).toBeDefined();
	await down.proxy!.stop();
	down.setHeld(await down.first().resumption);
	await until(() => server.links.length === 0);
	expect(server.attachments.status(down.channel.id)).toEqual({
		state: "disconnected",
		login: "member",
	});
	expect(context.chat.retained).toBeDefined();
	await down.reconnect();
	expect(await down.asked()).toMatchObject({ status: "answered", value: true });
	await until(() => context.chat.retained === undefined);
	expect(context.plan.records.get(id)?.status).toBe("answered");
});

test("a Stop pressed before the server notices the link died says it was not confirmed, and Chat says no more once the drop is noticed", async () => {
	let down = await resumablePlanner({ proxied: true, operationMs: 150 });
	let { context, server } = down;
	down.proxy!.hold();
	await Chat.abort(context, down.ws);
	let stop = "@rival asked Chopin to stop its workflows. It has not confirmed yet, and if its "
		+ "machine is disconnected they will pause when it reconnects.";
	expect(down.said().at(-1)).toBe(stop);
	expect(context.chat.runs?.map(run => run.status)).toEqual(["running"]);
	await down.proxy!.stop();
	down.setHeld(await down.first().resumption);
	await until(() => server.links.length === 0);
	await until(() => context.chat.runs?.[0]?.disconnected === true);
	expect(down.said().at(-1)).toBe(stop);
	expect(down.said().some(text => text === "@rival stopped the turn.")).toBe(false);
	await down.reconnect();
	await until(() => down.controls.length >= 1);
	expect(down.controls).toEqual(["stop"]);
});

test("a pause of one run the client did not confirm in time is reported as not confirmed, not as paused", async () => {
	let down = await resumablePlanner({ proxied: true, operationMs: 150 });
	let { context } = down;
	down.proxy!.hold();
	await Chat.controlRun(context, down.ws, { kind: "chat:pause-run", runId: "run-1" });
	expect(down.said().at(-1)).toBe(
		"@rival asked to pause plan-review. Chopin has not confirmed yet, and if its "
			+ "machine is disconnected it will pause when it reconnects.",
	);
});

test("a Stop of every run that a Resume of another run partly undid is still reported as held when the link drops", async () => {
	let down = await resumablePlanner({ silent: true });
	let { context } = down;
	(down.handlers as any).turn = async (turn: any) => {
		down.first().reportRuns(turn.message.session, {
			active: ["run-1"],
			paused: ["run-2"],
			cards: [card("running"), { ...card("paused"), id: "run-2", name: "second" }],
		});
		finishTurn(turn);
	};
	await Chat.invoke(context, RIVAL, "Two runs");
	await context.chat.running;
	await until(() => context.chat.runs?.length === 2);
	let stopping = Chat.abort(context, down.ws);
	await until(() => down.controls.length === 1);
	down.answering();
	await Chat.controlRun(context, down.ws, { kind: "chat:resume-run", runId: "run-2" });
	await down.drop();
	await stopping;
	expect(down.said().some(text => text === "@rival stopped the turn.")).toBe(false);
	expect(down.said().some(text => text.startsWith("@rival asked Chopin to stop."))).toBe(true);
	await down.reconnect();
	await until(() => down.controls.includes("stop run-1"));
});

test("a graceful shutdown leaves a remote Planner's open Decisions open and says nothing about its link or its runs, whether its link was attached when the shutdown began or had dropped before it", async () => {
	for (let order of ["attached", "dropped before"] as const) {
		let down = await resumablePlanner({ ask: true });
		let { context, server } = down;
		let id = [...context.plan.records.keys()][0]!;
		// main.ts drain: the attachments are told, the sockets close, then each room closes.
		if (order === "dropped before") await down.drop();
		let before = down.said().length;
		server.attachments.shutdown();
		if (order === "attached") {
			for (let socket of server.sockets) socket.close(1001, "server shutting down");
			await until(() => server.links.length === 0);
		}
		await Chat.close(context.chat);
		server.attachments.close();
		await Bun.sleep(100);
		expect(context.plan.records.get(id)?.status, order).toBe("open");
		expect(
			down.said().slice(before).filter(text => /disconnected|was stopped|nothing ends/.test(text)),
			order,
		).toEqual([]);
		expect(context.chat.runs?.map(run => run.status), order).not.toContain("stopped");
	}
});

test("a drop in the middle of a reply keeps the run and question, and Chat does not invite a retry that would be refused", async () => {
	let down = await resumablePlanner({ ask: true });
	let { context } = down;
	let id = [...context.plan.records.keys()][0]!;
	let turning = Promise.withResolvers<void>();
	(down.handlers as any).turn = async () => {
		turning.resolve();
		await new Promise(() => {});
	};
	let invoked = Chat.invoke(context, RIVAL, "Keep going");
	await turning.promise;
	await down.drop();
	await invoked;
	await context.chat.running;
	expect(context.plan.records.get(id)?.status).toBe("open");
	expect(context.chat.runs?.map(run => [run.status, run.disconnected])).toEqual([[
		"running",
		true,
	]]);
	expect(down.said().some(text => /try again/i.test(text))).toBe(false);
	expect(down.said()).toContain(
		"The machine's connection dropped during this reply. Its workflows and open questions are kept; ask again once it has reconnected.",
	);
});

test("a transient failure while Chopin checks the account during a resume ends nothing, and the retry resumes and delivers the answer", async () => {
	let down = await resumablePlanner({ ask: true });
	let { context, server } = down;
	let id = [...context.plan.records.keys()][0]!;
	await down.drop();
	let github =
		(context.auth as unknown as { github: { repositoryAccess: (...args: unknown[]) => unknown } })
			.github;
	let original = github.repositoryAccess;
	let failures = 1;
	github.repositoryAccess = async (...args: unknown[]) => {
		if (failures-- > 0) throw new GitHubError("Service Unavailable", 503);
		return original(...args);
	};
	let refusal = await down.reconnect().then(() => undefined, (error: unknown) => error);
	expect(refusal).toBeInstanceOf(AgentRefused);
	expect(refusal).toMatchObject({ code: "unavailable", retry: true });
	// The client's question is still pending, and Chopin still holds everything it kept.
	expect(await Promise.race([down.asked(), Bun.sleep(200).then(() => "pending")])).toBe("pending");
	expect(server.attachments.status(down.channel.id)).toEqual({
		state: "disconnected",
		login: "member",
	});
	expect(context.plan.records.get(id)?.status).toBe("open");
	expect(context.chat.runs?.map(run => [run.status, run.disconnected])).toEqual([[
		"running",
		true,
	]]);

	await down.reconnect();
	await answerChoice(context, id, 0);
	expect(await down.asked()).toMatchObject({ status: "answered", value: true });
	expect(context.plan.records.get(id)?.status).toBe("answered");
});

test("a Stop the client confirms after the wait for it ended is not sent again when the link later drops", async () => {
	let down = await resumablePlanner({ operationMs: 150 });
	let { context } = down;
	(down.handlers as AgentHandlers).control = async message => {
		down.controls.push(message.run ? `${message.type} ${message.run}` : message.type);
		await Bun.sleep(400);
	};
	await Chat.abort(context, down.ws);
	expect(down.said().at(-1)).toContain("It has not confirmed yet");
	// The client paused and said so, after the server stopped waiting.
	await Bun.sleep(600);
	await down.drop();
	await until(() => context.chat.runs?.[0]?.disconnected === true);
	await down.reconnect();
	await Bun.sleep(300);
	expect(down.controls).toEqual(["stop"]);
});

const COMMANDS: NonNullable<CapabilityCatalog["commands"]> = [
	{ name: "skill:notes", kind: "skill", description: "Take notes" },
	{ name: "review", kind: "prompt" },
	{ name: "ship", kind: "workflow", description: "Ship it" },
];

function command(name: string, commandKind: string, start: number): Wire.CommandRequest {
	return { kind: "command", name, commandKind, start, end: start + name.length + 1 };
}

/** A remote room that checks commands against what its attached client reports, as main.ts does. */
async function commandRoom(source = "") {
	let room = await remoteRoom();
	room.context.references = new ReferenceService({
		storage: room.storage,
		current: async channelId => ({
			channelId,
			revision: 2,
			source,
			sourceHash: Plan.sourceHash(source),
		}),
		research: {} as never,
	});
	room.context.commands = () =>
		plannerCommands("remote", room.channel.id, { owner: "octo-org", name: "score" });
	return room;
}

async function reportingClient(
	room: Awaited<ReturnType<typeof commandRoom>>,
	catalog: CapabilityCatalog | undefined,
) {
	let script = scriptedPlanner();
	let client = await connectAgent({
		url: room.server.url,
		token: MEMBER_TOKEN,
		document: room.channel.id,
		handlers: script.handlers,
		resumable: false,
		...(catalog ? { capabilities: catalog } : {}),
	});
	cleanups.push(() => client.detach());
	return { client, turns: script.turns };
}

test("a command the attached client reports runs on that client as its own /name args, and one it does not report is refused where the person reads it", async () => {
	let room = await commandRoom();
	let { turns } = await reportingClient(room, { commands: COMMANDS });
	await until(() => attachedLink(room.channel.id)?.catalog?.commands?.length === 3);
	let { context } = room;

	// A skill: Atomic's own invocation opens the prompt, with nothing in front of it.
	await room.send("we should write release notes", "room");
	expect(
		await room.send("@chopin /skill:notes for today", "planner", [
			command("skill:notes", "skill", "@chopin ".length),
		]),
	).toMatchObject({ kind: "chat:send", queued: false });
	await context.chat.running;
	expect(turns.map(turn => turn.prompt)).toEqual(["/skill:notes for today"]);
	let said = context.chat.entries.findLast(entry => entry.author.kind === "member");
	expect(said).toMatchObject({
		text: "/skill:notes for today",
		delivery: { destination: "planner" },
		references: [{ kind: "command", name: "skill:notes", commandKind: "skill", start: 0, end: 12 }],
	});

	// The prompt is the command alone, and the Planner still has what the room said: a fresh
	// session is told it in its instructions.
	expect((turns[0] as { instructions?: string }).instructions).toContain(
		"Durable conversation context follows:\n@rival: we should write release notes",
	);

	// A prompt template, then a workflow, which is asked for by name.
	await room.send("/review the diff", "planner", [command("review", "prompt", 0)]);
	await context.chat.running;
	expect(turns.at(-1)!.prompt).toBe("/review the diff");
	await room.send("/ship the v2 branch", "planner", [command("ship", "workflow", 0)]);
	await context.chat.running;
	expect(turns.at(-1)!.prompt).toContain('Start the registered workflow "ship" now');
	expect(turns.at(-1)!.prompt.endsWith("the v2 branch")).toBe(true);

	// An unknown command is refused, says so, and posts and runs nothing.
	let before = context.chat.entries.length;
	let ran = turns.length;
	expect(await room.send("/deploy now", "planner", [command("deploy", "workflow", 0)]))
		.toMatchObject({
			kind: "session:error",
			message: "/deploy is not one of the commands the Planner offers.",
		});
	// The same name as another kind is not the command either.
	expect(await room.send("/review", "planner", [command("review", "skill", 0)])).toMatchObject({
		message: "/review is not one of the commands the Planner offers.",
	});
	expect(context.chat.entries).toHaveLength(before);
	expect(turns).toHaveLength(ran);
});

test("a command is refused while the attached client reports none, and again once it has left", async () => {
	let room = await commandRoom();
	let { client } = await reportingClient(room, undefined);
	let { context } = room;
	await until(() => attachedLink(room.channel.id) !== undefined);
	let said = "The Planner has not reported any commands, so /review cannot run.";
	expect(await room.send("/review", "planner", [command("review", "prompt", 0)])).toMatchObject({
		kind: "session:error",
		message: said,
	});
	await client.detach();
	expect(await room.send("/review", "planner", [command("review", "prompt", 0)])).toMatchObject({
		message: expect.stringContaining("cannot run"),
	});
	expect(context.chat.entries.filter(entry => entry.author.kind === "member")).toHaveLength(0);
});

test("a command goes only to the Planner, and not to the people in the room", async () => {
	let room = await commandRoom();
	await reportingClient(room, { commands: COMMANDS });
	await until(() => attachedLink(room.channel.id)?.catalog?.commands?.length === 3);
	expect(await room.send("/review the diff", "room", [command("review", "prompt", 0)]))
		.toMatchObject({
			kind: "session:error",
			message: "A command runs in the Planner's turn, so it goes to Chopin.",
		});
	expect(room.context.chat.entries).toHaveLength(0);
});

test("a heading, a Decision and a file mentioned in a message reach the attached client as structured references, and a part that has gone is refused", async () => {
	let source = [
		"# Overview",
		"",
		'<Questionnaire id="01HQ0000000000000000000000">',
		'<Question id="q1" header="Rollout" prompt="How?" multiple="false">',
		'<Option id="o1" label="Canary" />',
		"</Question>",
		"</Questionnaire>",
		"",
	].join("\n");
	let room = await commandRoom(source);
	room.context.fileExists = async (path, session) =>
		session === room.logins.get("rival") ? path === "src/index.ts" : undefined;
	let { turns } = await reportingClient(room, undefined);
	let { context } = room;
	let text = "@chopin compare @ov with @ro in @idx";
	let at = (token: string) => text.indexOf(token);
	let mention = [
		{ kind: "heading", anchor: "overview", start: at("@ov"), end: at("@ov") + 3 },
		{
			kind: "decision",
			decisionId: "01HQ0000000000000000000000",
			start: at("@ro"),
			end: at("@ro") + 3,
		},
		{ kind: "file", path: "src/index.ts", start: at("@idx"), end: at("@idx") + 4 },
	] as Wire.ReferenceRequest[];
	expect(await room.send(text, "planner", mention)).toMatchObject({ kind: "chat:send" });
	await context.chat.running;
	let said = context.chat.entries.find(entry => entry.author.kind === "member");
	expect(said?.text).toBe("compare @Overview with @Rollout in @src/index.ts");
	expect(said?.references?.map(reference => reference.kind)).toEqual([
		"heading",
		"decision",
		"file",
	]);
	expect(turns.at(-1)!.prompt).toBe(
		'@rival: compare @Overview [heading anchor "overview", level 1, line 1 of this document] with '
			+ '@Rollout [Decision id "01HQ0000000000000000000000" of this document] in '
			+ '@src/index.ts [file path "src/index.ts" in the repository]',
	);

	let before = context.chat.entries.length;
	expect(
		await room.send("@chopin see @x", "planner", [
			{ kind: "heading", anchor: "removed", start: 12, end: 14 },
		]),
	).toMatchObject({
		kind: "session:error",
		message: "That heading is no longer in the document.",
	});
	expect(
		await room.send("@chopin see @x", "planner", [
			{ kind: "file", path: "../etc/passwd", start: 12, end: 14 },
		]),
	).toMatchObject({ kind: "session:error", message: "invalid or unavailable chat reference" });
	// A file the sender's session cannot list is not one it can mention.
	expect(
		await room.send("@chopin see @x", "planner", [
			{ kind: "file", path: "src/other.ts", start: 12, end: 14 },
		]),
	).toMatchObject({ kind: "session:error", message: "That file is not in the repository." });
	expect(context.chat.entries).toHaveLength(before);
});
