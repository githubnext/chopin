import { afterEach, expect, test } from "bun:test";

import { ActiveOwnerBindings } from "../agent/active-owner";
import { createPlannerAgent } from "../harness/agents";
import { createRemoteAdapter } from "../harness/remote/adapter";
import {
	disconnectedMessage,
	notAttachedMessage,
	PlannerAttachments,
} from "../harness/remote/attachments";
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
	machineToken,
	MEMBER_TOKEN,
	RIVAL_TOKEN,
	scriptedPlanner,
} from "../testing/agent-link";
import { Machines } from "../auth/machines";
import { MachinePlanners } from "../harness/remote/machine-planners";
import { tool } from "ai";
import { GITHUB_TOOL_SCHEMAS } from "../harness/github-tools";
import { AgentRefused, connectAgent } from "@chopin/agent-link/client";
import { GitHubError } from "../github/client";
import { laterTimers } from "../testing/decisions";
import { expectPlainStatusLines } from "../testing/plain-words";
import * as Chat from "./service";
import { ReferenceService } from "./references";
import { sessionContextOf } from "./session-context";
import { plannerCommands } from "../harness/harnesses";
import { attachedLink } from "../harness/remote/registry";
import * as Question from "@chopin/question";
import { answerTurns, plannerToActOn } from "../questions/answer-turns";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { member } from "../questions/text-response.test-fixtures";

import type { Server } from "bun";
import type { Chat as Wire } from "@chopin/protocol";
import type { CapabilityCatalog, InputCall } from "@chopin/agent-link";
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
				: server.attachments.unavailable(channel.id)
					?? notAttachedMessage(url, "octo-org/score"),
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

test("a message to a machine whose link dropped is refused saying it was not sent and to send it again, never that it is kept, and nothing is posted", async () => {
	let down = await resumablePlanner({ graceMs: GRACE_MS });
	let { context } = down;
	await down.drop();
	let entries = context.chat.entries.length;
	let saves = 0;
	let persist = context.persist;
	context.persist = async chat => {
		saves++;
		await persist(chat);
	};

	let refused = await down.send("@chopin and then this");
	expect(refused).toMatchObject({
		kind: "session:error",
		code: "planner-not-attached",
		message: "@member's machine is offline, so this message wasn't sent. "
			+ "Send it again when it's back.",
	});
	expect(String(refused?.message)).not.toMatch(/kept|picks up/);
	// The machine's own work is another matter: it is kept, and the refusal does not touch it.
	expect(context.chat.entries).toHaveLength(entries);
	expect(context.chat.waiting).toEqual([]);
	expect(saves).toBe(0);
	expect(context.chat.retained).toBeDefined();
});

test("a message sent in the hand-over window before the machine resumes is refused saying still connecting, and nothing is posted", async () => {
	let room = await remoteRoom();
	let { channel, context, server } = room;
	let member = await attach(server.url, channel.id, scriptedPlanner().handlers);
	cleanups.push(() => member.detach());
	let rows = server.attachments.freeze(GRACE_MS);
	let next = new PlannerAttachments(context.auth as never, GRACE_MS);
	cleanups.push(() => next.close());
	await next.restore(rows.map(row => ({ ...row, fencing: 1 })));
	context.plannerNotAttached = async () =>
		await next.confirmed(channel.id)
			? undefined
			: next.unavailable(channel.id) ?? disconnectedMessage(next.holder(channel.id));
	expect(next.status(channel.id)).toEqual({ state: "attached", login: "member" });
	let refused = await room.send("@chopin outline the plan");
	expect(refused).toMatchObject({
		kind: "session:error",
		code: "planner-not-attached",
		message: "Still connecting to @member's machine, so this message wasn't sent. "
			+ "Send it again in a moment.",
	});
	expect(context.chat.entries).toEqual([]);
	expect(context.chat.waiting).toEqual([]);
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

test("an attached Planner receives @chopin and invoke_planner turns as their owner", async () => {
	let room = await remoteRoom();
	let { context } = room;
	let script = scriptedPlanner();
	let client = await attach(room.server.url, room.channel.id, script.handlers);
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
	// Nothing was left open, so no session outlives its turn.
	expect(context.chat.retained).toBeUndefined();
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
 * A resumable client that took one turn and, unless told not to, asked one question. `drop()` is
 * the network failing, with no detach and no revocation; `reconnect()` is the same account's next
 * link, which resumes what the dropped one held. `graceMs` is how long the server keeps a dropped
 * link and `operationMs` how long it waits for the client to answer.
 */
async function resumablePlanner(
	options: {
		/** Asks a question nobody answers, the work its session keeps; true unless told not to. */
		ask?: boolean;
		graceMs?: number;
		operationMs?: number;
		/** The question's caller can withdraw it with `withdraw()`, as a client that cancels it does. */
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
	let withdrawal = new AbortController();
	let asked: Promise<{ status: string; value?: unknown }> | undefined;
	let first: AgentClient | undefined;
	let held: Awaited<AgentClient["resumption"]>;
	let sessionId: string | undefined;
	let handlers: Partial<AgentHandlers> = {
		...script.handlers,
		async turn(turn) {
			sessionId = turn.message.session;
			if (options.ask !== false && !asked) {
				asked = first!.ask(turn.message.session, {
					method: "confirm",
					title: "Ship?",
					message: "Now.",
				}, options.withdrawable ? { signal: withdrawal.signal } : {});
			}
			finishTurn(turn);
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
	if (options.ask !== false) {
		await until(() => [...context.plan.records.values()][0]?.status === "open");
		await until(() => context.chat.retained !== undefined);
	}
	return {
		...room,
		handlers,
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

test("with its link connected, an attached Planner's open question stays open for hours, through its owner's credential renewals, ending only when the owner signs out", async () => {
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
		expect(server.attachments.status(live.channel.id)).toEqual({
			state: "attached",
			login: "member",
		});
		expect(live.said().some(text => text.includes("was stopped"))).toBe(false);
	}
	// The owner's GitHub credential, which the fixture's browser login issued for eight hours, is
	// renewed as it expires: the session takes the renewed one and the question stays open.
	await clock.pass(2 * HOUR);
	await clock.pass(2 * HOUR);
	expect(context.plan.records.get(id)?.status).toBe("open");
	expect(context.chat.retained).toBeDefined();
	// The one bound is the owner: signing out releases the retained session and detaches its
	// waiter while leaving the open Decision in the document for durable handoff.
	await live.signOut("member");
	await until(() => context.chat.retained === undefined);
	expect(context.plan.records.get(id)?.status).toBe("open");
	expect(Store.get(context.plan.questions, id)?.awaited).toBeUndefined();
	expect(plannerToActOn(
		context.plan.records.get(id)!,
		Store.get(context.plan.questions, id)!,
	)).toBe(true);
});

test("a question an attached Planner asks while its turn runs keeps the turn going through its owner's credential renewals, and the reply finishes once it is answered", async () => {
	let clock = laterTimers();
	cleanups.push(() => clock.restore());
	let room = await remoteRoom();
	let { context, server } = room;
	let script = scriptedPlanner();
	let client: Awaited<ReturnType<typeof connectAgent>> | undefined;
	let answered: unknown;
	client = await connectAgent({
		url: server.url,
		token: MEMBER_TOKEN,
		document: room.channel.id,
		handlers: {
			...script.handlers,
			async turn(turn) {
				let result = await client!.ask(turn.message.session, {
					method: "confirm",
					title: "Ship?",
					message: "Now.",
				});
				answered = result.value;
				finishTurn(turn);
			},
		} as AgentHandlers,
		resumable: true,
	});
	cleanups.push(() => client!.detach());
	expect(await Chat.invoke(context, RIVAL, "Run the review")).toBeUndefined();
	await until(() => [...context.plan.records.values()][0]?.status === "open");
	let id = [...context.plan.records.keys()][0]!;
	// The fixture's browser login issued the owner's credential for eight hours; it is renewed twice.
	for (let passed of [3 * HOUR, 3 * HOUR, 3 * HOUR]) {
		await clock.pass(passed);
		expect(context.plan.records.get(id)?.status).toBe("open");
		expect(context.chat.busy).toBe(true);
	}
	await answerChoice(context, id, 0);
	await context.chat.running;
	expect(answered).toBe(true);
	expect(context.chat.entries.some(entry => entry.turnFailure !== undefined)).toBe(false);
});

test("a question an attached Planner asked stays open in Decisions when its turn fails, and its answer reaches the client", async () => {
	let room = await remoteRoom();
	let { context, server } = room;
	let script = scriptedPlanner();
	let client: Awaited<ReturnType<typeof connectAgent>> | undefined;
	let answer = Promise.withResolvers<unknown>();
	client = await connectAgent({
		url: server.url,
		token: MEMBER_TOKEN,
		document: room.channel.id,
		handlers: {
			...script.handlers,
			async turn(turn) {
				void client!.ask(turn.message.session, {
					method: "confirm",
					title: "Ship?",
					message: "Now.",
				}).then(result => answer.resolve(result.value), answer.reject);
				await until(() => [...context.plan.records.values()][0]?.status === "open");
				throw new Error("The model failed.");
			},
		} as AgentHandlers,
		resumable: true,
	});
	cleanups.push(() => client!.detach());
	expect(await Chat.invoke(context, RIVAL, "Run the review")).toBeUndefined();
	await until(() => !context.chat.busy);
	let id = [...context.plan.records.keys()][0]!;
	expect(context.plan.records.get(id)?.status).toBe("open");
	expect(context.chat.retained).toBeDefined();
	await answerChoice(context, id, 0);
	expect(await answer.promise).toBe(true);
});

test("a dropped link's open question stays open and answerable for as long as its client is away, and Chat says nothing of the machine", async () => {
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
	// The machine's state lives on the machine button: Chat says nothing of it.
	expect(down.said()).toEqual(lines);

	// The owner's GitHub credential of eight hours is renewed meanwhile, and a day goes by: past
	// the configured grace, the one-hour maximum and every other timer, nothing ends.
	for (let passed of [GRACE_MS, 31 * MINUTE, 3 * HOUR, 5 * HOUR, 16 * HOUR]) {
		await clock.pass(passed);
		expect(context.plan.records.get(id)?.status).toBe("open");
		expect(context.chat.retained).toBeDefined();
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
	await down.reconnect();
	expect(context.plan.records.size).toBe(1);
	await until(() => server.attachments.status(down.channel.id).state === "attached");
	// Nothing confirms its return either.
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
	let down = await resumablePlanner({ graceMs: GRACE_MS });
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
	expect(down.said().at(-1)).toBe("@rival stopped chopin and withdrew its open question.");
	await until(() => server.attachments.status(down.channel.id).state === "held");
	// The machine stepped away: a message to it is refused as one to a machine that is offline.
	expect(await context.plannerNotAttached!()).toBe(
		"@member's machine is offline, so this message wasn't sent. Send it again when it's back.",
	);
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

test("a drop of an attached Planner that did not ask for resumable sessions ends its session and detaches its waiter while keeping the Decision open", async () => {
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
	let [id] = [...context.plan.records.keys()];
	expect(context.plan.records.get(id!)?.status).toBe("open");
	expect(Store.get(context.plan.questions, id!)?.awaited).toBeUndefined();
	expect(plannerToActOn(
		context.plan.records.get(id!)!,
		Store.get(context.plan.questions, id!)!,
	)).toBe(true);
});

test("a Stop pressed while the attached Planner's link is down withdraws a question it only waits on, as when connected", async () => {
	let down = await resumablePlanner({});
	await down.drop();
	let { context, said } = down;
	let id = [...context.plan.records.keys()][0]!;
	expect(context.plan.records.get(id)?.status).toBe("open");
	await Chat.abort(context, down.ws);
	expect(said().at(-1)).toBe("@rival stopped chopin and withdrew its open question.");
	expect(context.chat.retained).toBeUndefined();
	await until(() => context.plan.records.get(id)?.status === "cancelled");

	await down.reconnect();
	expect(await down.asked()).toMatchObject({ status: "cancelled" });
	expect(context.plan.records.size).toBe(1);
});

test("answering the only question of an attached Planner delivers the answer to its client before the session is let go", async () => {
	let lone = await resumablePlanner({});
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
	let down = await resumablePlanner({});
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

test("a question omitted from resume after a drop detaches its waiter while keeping the Decision open in Chopin", async () => {
	let down = await resumablePlanner({ ask: true, withdrawable: true });
	let { context } = down;
	let id = [...context.plan.records.keys()][0]!;
	await down.drop();
	// The link is down, so the client stops waiting locally and omits the request from resume.
	down.withdraw();
	expect(await down.asked()).toMatchObject({ status: "cancelled" });
	expect(context.plan.records.get(id)?.status).toBe("open");

	await down.reconnect();
	await until(() => Store.get(context.plan.questions, id)?.awaited === undefined);
	expect(context.plan.records.get(id)?.status).toBe("open");
	expect(plannerToActOn(
		context.plan.records.get(id)!,
		Store.get(context.plan.questions, id)!,
	)).toBe(true);
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
	let down = await resumablePlanner({ proxied: true });
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
	let down = await resumablePlanner({ proxied: true, operationMs: 150 });
	let { context, server } = down;
	let id = [...context.plan.records.keys()][0]!;
	down.proxy!.hold();
	await answerChoice(context, id, 0);
	// The client's own frame reaches the server after the answer was written, but never the answer.
	down.proxy!.hearClient();
	down.first().send({ type: "control-result", request: "unknown", ok: true });
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

test("a graceful shutdown leaves a remote Planner's open Decisions open and says nothing about its link, whether its link was attached when the shutdown began or had dropped before it", async () => {
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
	}
});

test("a drop in the middle of a reply keeps the question, and Chat does not invite a retry that would be refused", async () => {
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
	expect(down.said().some(text => /try again/i.test(text))).toBe(false);
	expect(down.said()).toContain(
		"The machine's connection dropped during this reply. Its open questions are kept; ask again once it has reconnected.",
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

	await down.reconnect();
	await answerChoice(context, id, 0);
	expect(await down.asked()).toMatchObject({ status: "answered", value: true });
	expect(context.plan.records.get(id)?.status).toBe("answered");
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
	).toMatchObject({ kind: "chat:send" });
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

	// A prompt template, then a command of a kind Chopin does not know, each as its own invocation.
	await room.send("/review the diff", "planner", [command("review", "prompt", 0)]);
	await context.chat.running;
	expect(turns.at(-1)!.prompt).toBe("/review the diff");
	await room.send("/ship the v2 branch", "planner", [command("ship", "workflow", 0)]);
	await context.chat.running;
	expect(turns.at(-1)!.prompt).toBe("/ship the v2 branch");

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

test("each turn's fresh session gets the same instructions, and what the room said comes before its prompt, so the model's cache of the instructions holds", async () => {
	let room = await remoteRoom();
	let { context } = room;
	let script = scriptedPlanner();
	let client = await attach(room.server.url, room.channel.id, {
		...script.handlers,
		async turn(turn) {
			script.turns.push(turn.message);
			turn.emit({ type: "text-start", id: "reply" });
			turn.emit({ type: "text-delta", id: "reply", delta: `Reply ${script.turns.length}.` });
			turn.emit({ type: "text-end", id: "reply" });
			finishTurn(turn);
		},
	});
	cleanups.push(() => client.detach());

	await room.send("we should write release notes", "room");
	await room.send("@chopin draft the plan");
	await context.chat.running;
	await room.send("@chopin now the risks");
	await context.chat.running;

	let [first, second] = script.turns;
	expect(script.turns).toHaveLength(2);
	expect(first!.session).not.toBe(second!.session);
	expect(second!.instructions).toBe(first!.instructions);
	expect(first!.instructions).not.toContain("Durable conversation context");
	let told = [first, second].map(turn => sessionContextOf(turn!.prompt));
	expect(told[0]!.context).toStartWith("A fresh Planner session starts for each turn.");
	expect(told[0]!.context).toContain("@rival: we should write release notes");
	expect(told[0]!.turn).toEndWith("draft the plan");
	expect(told[0]!.turn).not.toContain("release notes");
	expect(told[1]!.context).toContain("Planner: Reply 1.");
	expect(told[1]!.turn).toEndWith("now the risks");
	expect(told[1]!.turn).not.toContain("draft the plan");
});

test("an attached Planner's reply reaches Chat as it is written, before its message or turn ends", async () => {
	let room = await remoteRoom();
	let { context } = room;
	let script = scriptedPlanner();
	let release = Promise.withResolvers<void>();
	let client = await attach(room.server.url, room.channel.id, {
		...script.handlers,
		async turn(turn) {
			turn.emit({ type: "text-start", id: "reply" });
			turn.emit({ type: "text-delta", id: "reply", delta: "First words" });
			await release.promise;
			turn.emit({ type: "text-delta", id: "reply", delta: ", then the rest." });
			turn.emit({ type: "text-end", id: "reply" });
			finishTurn(turn);
		},
	});
	cleanups.push(() => client.detach());

	await room.send("@chopin draft the plan");
	let reply = () => context.chat.entries.find(entry => entry.author.kind === "agent");
	await until(() => reply()?.text === "First words");
	expect(context.chat.busy).toBe(true);
	expect(reply()!.streaming).toBe(true);
	release.resolve();
	await context.chat.running;
	expect(reply()!.text).toBe("First words, then the rest.");
	expect(reply()!.streaming).toBeUndefined();
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
			message: "A command runs in the Planner's turn, so it goes to chopin.",
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

function pixels(width: number, height: number, seed: number): string {
	let size = [width, height].flatMap(value => [
		value >>> 24,
		value >>> 16 & 255,
		value >>> 8 & 255,
		value & 255,
	]);
	let signature = [
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		0,
		0,
		0,
		13,
		0x49,
		0x48,
		0x44,
		0x52,
	];
	return Buffer.from([...signature, ...size, 8, 6, 0, 0, 0, seed]).toString("base64");
}

test("a Stop while an attached Planner's image is uploading waits for it, keeps it with that turn, and the next turn's images go on the next turn", async () => {
	let room = await remoteRoom();
	let { context, storage } = room;
	let started = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let put = storage.images.put.bind(storage.images);
	storage.images.put = async image => {
		if (image.bytes[image.bytes.length - 1] === 1) {
			started.resolve();
			await release.promise;
		}
		await put(image);
	};
	let client = await attach(
		room.server.url,
		room.channel.id,
		scriptedPlanner({
			async turn(turn) {
				if (turn.message.prompt.includes("draw it")) {
					turn.offerTools(["draw"]);
					turn.emit({
						type: "tool-call",
						toolCallId: "draw-1",
						toolName: "draw",
						input: "{}",
						providerExecuted: true,
					});
					turn.emit({
						type: "tool-result",
						toolCallId: "draw-1",
						toolName: "draw",
						result: {
							content: [{ type: "text", text: "Drew it" }, {
								type: "image",
								data: pixels(800, 600, 2),
								mimeType: "image/png",
								alt: "Ground floor",
							}],
						},
					});
					finishTurn(turn);
					return;
				}
				void turn.callHostTool("upload_plan_image", {
					data: pixels(40, 30, 1),
					mimeType: "image/png",
					alt: "Stopped mid-upload",
				});
				await new Promise(resolve => {
					turn.signal.addEventListener("abort", resolve, { once: true });
				});
			},
		}).handlers,
	);
	cleanups.push(() => client.detach());

	expect(await room.send("@chopin upload one")).toMatchObject({ kind: "chat:send" });
	await started.promise;
	await Chat.abort(context, room.ws);
	release.resolve();
	await context.chat.running;
	expect(await room.send("@chopin draw it")).toMatchObject({ kind: "chat:send" });
	await context.chat.running;

	let holders = context.chat.entries.filter(entry => entry.images);
	expect(holders.map(entry => ({
		author: entry.author,
		tools: entry.tools?.map(tool => [tool.name, tool.result]),
		images: entry.images?.map(({ alt, width, height, generated }) => ({
			alt,
			width,
			height,
			generated,
		})),
	}))).toEqual([
		{
			author: { kind: "agent" },
			tools: [["upload_plan_image", "Turn stopped."]],
			images: [{ alt: "Stopped mid-upload", width: 40, height: 30, generated: true }],
		},
		{
			author: { kind: "agent" },
			tools: [["draw", "Drew it\n1 image"]],
			images: [{ alt: "Ground floor", width: 800, height: 600, generated: true }],
		},
	]);
	let stopped = context.chat.entries.findIndex(entry => entry.text === "@rival stopped the turn.");
	let next = context.chat.entries.findIndex(entry => entry.text.includes("draw it"));
	expect(context.chat.entries.indexOf(holders[0]!)).toBeLessThan(stopped);
	expect(context.chat.entries.indexOf(holders[1]!)).toBeGreaterThan(next);
	let saved = (context.plan.persistence.committedSidecar as { transcript: Chat.Chat["entries"] })
		.transcript.filter(entry => entry.images);
	expect(saved.map(entry => [entry.id, entry.images])).toEqual(
		holders.map(entry => [entry.id, entry.images]),
	);
	for (let image of holders.flatMap(entry => entry.images!)) {
		expect(await storage.images.get(room.channel.id, image.src.slice(8, 72))).toMatchObject({
			mimeType: "image/png",
			uploadedBy: RIVAL.id,
		});
	}
});

test("a turn that ends while its tool's image is still being stored waits for it, then saves the image with the turn", async () => {
	let room = await remoteRoom();
	let { context, storage } = room;
	let started = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let put = storage.images.put.bind(storage.images);
	storage.images.put = async image => {
		if (image.bytes[image.bytes.length - 1] === 3) {
			started.resolve();
			await release.promise;
		}
		await put(image);
	};
	let image = (seed: number, alt: string) => ({
		type: "image",
		data: pixels(640, 480, seed),
		mimeType: "image/png",
		alt,
	});
	let client = await attach(
		room.server.url,
		room.channel.id,
		scriptedPlanner({
			async turn(turn) {
				let next = turn.message.prompt.includes("next");
				turn.offerTools(["draw"]);
				let toolCallId = next ? "draw-2" : "draw-1";
				turn.emit({
					type: "tool-call",
					toolCallId,
					toolName: "draw",
					input: "{}",
					providerExecuted: true,
				});
				turn.emit({
					type: "tool-result",
					toolCallId,
					toolName: "draw",
					result: { content: [next ? image(4, "Next floor") : image(3, "Slow floor")] },
				});
				finishTurn(turn);
			},
		}).handlers,
	);
	cleanups.push(() => client.detach());

	expect(await room.send("@chopin draw it")).toMatchObject({ kind: "chat:send" });
	await started.promise;
	let ended = false;
	let running = context.chat.running!.then(() => (ended = true));
	await Bun.sleep(50);
	expect(ended).toBe(false);
	expect(context.chat.busy).toBe(true);
	release.resolve();
	await running;

	let saved = () =>
		(context.plan.persistence.committedSidecar as { transcript: Chat.Chat["entries"] })
			.transcript.filter(entry => entry.images)
			.map(entry => [entry.id, entry.images!.map(item => item.alt)]);
	let first = context.chat.entries.find(entry => entry.images);
	expect(first?.tools?.map(tool => tool.result)).toEqual(["1 image"]);
	expect(saved()).toEqual([[first!.id, ["Slow floor"]]]);

	expect(await room.send("@chopin the next one")).toMatchObject({ kind: "chat:send" });
	await context.chat.running;
	let holders = context.chat.entries.filter(entry => entry.images);
	expect(holders.map(entry => entry.images!.map(item => item.alt))).toEqual([
		["Slow floor"],
		["Next floor"],
	]);
	expect(saved()).toEqual(holders.map(entry => [entry.id, entry.images!.map(item => item.alt)]));
});

test("a remote client that reuses a tool call id in a later turn keeps each turn's image and tool result on that turn's message", async () => {
	let room = await remoteRoom();
	let { context } = room;
	let image = (seed: number, alt: string) => ({
		type: "image",
		data: pixels(640, 480, seed),
		mimeType: "image/png",
		alt,
	});
	let client = await attach(
		room.server.url,
		room.channel.id,
		scriptedPlanner({
			async turn(turn) {
				let next = turn.message.prompt.includes("next");
				turn.offerTools(["draw"]);
				turn.emit({
					type: "tool-call",
					toolCallId: "draw-1",
					toolName: "draw",
					input: "{}",
					providerExecuted: true,
				});
				turn.emit({
					type: "tool-result",
					toolCallId: "draw-1",
					toolName: "draw",
					result: { content: [next ? image(4, "Next floor") : image(3, "Slow floor")] },
				});
				finishTurn(turn);
			},
		}).handlers,
	);
	cleanups.push(() => client.detach());

	expect(await room.send("@chopin draw it")).toMatchObject({ kind: "chat:send" });
	await context.chat.running;
	expect(await room.send("@chopin the next one")).toMatchObject({ kind: "chat:send" });
	await context.chat.running;

	let holders = context.chat.entries.filter(entry => entry.images);
	expect(holders.map(entry => entry.images!.map(item => item.alt))).toEqual([
		["Slow floor"],
		["Next floor"],
	]);
	expect(holders.map(entry => entry.tools!.map(tool => [tool.id, tool.status, tool.result])))
		.toEqual([
			[["draw-1", "done", "1 image"]],
			[["draw-1", "done", "1 image"]],
		]);
	let kinds = context.chat.entries.map(entry => entry.author.kind);
	expect(kinds.indexOf("member")).toBeLessThan(context.chat.entries.indexOf(holders[0]!));
	expect(context.chat.entries.indexOf(holders[0]!)).toBeLessThan(
		context.chat.entries.findLastIndex(entry => entry.author.kind === "member"),
	);
	expect(context.chat.entries.findLastIndex(entry => entry.author.kind === "member")).toBeLessThan(
		context.chat.entries.indexOf(holders[1]!),
	);
});

test("a refused reply's repair attempt may reuse a tool call id, and both attempts' images stay on the turn's message, each once", async () => {
	let room = await remoteRoom();
	let { context } = room;
	context.decide = async ({ state }) => ({
		model: "test/classifier",
		answers: {
			input: { type: "noul", noul: (state as { reply: string }).reply.includes("?") ? 1 : 0 },
		},
		usage: { input_tokens: 0, output_tokens: 0 },
		latencyMs: 0,
	});
	let attempts = 0;
	let client = await attach(
		room.server.url,
		room.channel.id,
		scriptedPlanner({
			async turn(turn) {
				let repair = ++attempts > 1;
				turn.offerTools(["draw"]);
				turn.emit({
					type: "tool-call",
					toolCallId: "draw-1",
					toolName: "draw",
					input: "{}",
					providerExecuted: true,
				});
				let result = {
					type: "tool-result" as const,
					toolCallId: "draw-1",
					toolName: "draw",
					result: {
						content: [{
							type: "image",
							data: pixels(640, 480, repair ? 6 : 5),
							mimeType: "image/png",
							alt: repair ? "Second try" : "First try",
						}],
					},
				};
				turn.emit(result);
				if (repair) turn.emit(result);
				turn.emit({ type: "text-start", id: "answer" });
				turn.emit({
					type: "text-delta",
					id: "answer",
					delta: repair ? "Drew it." : "Which floor should I draw?",
				});
				turn.emit({ type: "text-end", id: "answer" });
				finishTurn(turn);
			},
		}).handlers,
	);
	cleanups.push(() => client.detach());

	expect(await room.send("@chopin draw it")).toMatchObject({ kind: "chat:send" });
	await context.chat.running;

	expect(attempts).toBe(2);
	let holders = context.chat.entries.filter(entry => entry.images);
	expect(holders.map(entry => entry.images!.map(item => item.alt))).toEqual([
		["First try", "Second try"],
	]);
	expect(holders[0]!.tools!.map(tool => [tool.id, tool.status, tool.result])).toEqual([
		["draw-1", "done", "1 image"],
	]);
	expect(context.chat.entries.map(entry => entry.text)).toContain("Drew it.");
	let saved = (context.plan.persistence.committedSidecar as { transcript: Chat.Chat["entries"] })
		.transcript.filter(entry => entry.images);
	expect(saved.map(entry => [entry.id, entry.images!.map(item => item.alt)])).toEqual([
		[holders[0]!.id, ["First try", "Second try"]],
	]);
});

test("a refused reply's first attempt image that finishes storing after the repair attempt began stays with its own tool's message", async () => {
	let room = await remoteRoom();
	let { context, storage } = room;
	let release = Promise.withResolvers<void>();
	let put = storage.images.put.bind(storage.images);
	storage.images.put = async image => {
		if (image.bytes[image.bytes.length - 1] === 8) await release.promise;
		await put(image);
	};
	context.decide = async ({ state }) => ({
		model: "test/classifier",
		answers: {
			input: { type: "noul", noul: (state as { reply: string }).reply.includes("?") ? 1 : 0 },
		},
		usage: { input_tokens: 0, output_tokens: 0 },
		latencyMs: 0,
	});
	let attempts = 0;
	let client = await attach(
		room.server.url,
		room.channel.id,
		scriptedPlanner({
			async turn(turn) {
				let repair = ++attempts > 1;
				if (!repair) {
					turn.offerTools(["draw"]);
					turn.emit({
						type: "tool-call",
						toolCallId: "draw-1",
						toolName: "draw",
						input: "{}",
						providerExecuted: true,
					});
					turn.emit({
						type: "tool-result",
						toolCallId: "draw-1",
						toolName: "draw",
						result: {
							content: [{
								type: "image",
								data: pixels(640, 480, 8),
								mimeType: "image/png",
								alt: "Slow first try",
							}],
						},
					});
				}
				turn.emit({ type: "text-start", id: "answer" });
				turn.emit({
					type: "text-delta",
					id: "answer",
					delta: repair ? "Drew it." : "Which floor should I draw?",
				});
				turn.emit({ type: "text-end", id: "answer" });
				finishTurn(turn);
			},
		}).handlers,
	);
	cleanups.push(() => client.detach());

	expect(await room.send("@chopin draw it")).toMatchObject({ kind: "chat:send" });
	while (!context.chat.entries.some(entry => entry.text === "Drew it.")) await Bun.sleep(5);
	release.resolve();
	await context.chat.running;

	expect(attempts).toBe(2);
	let holders = context.chat.entries.filter(entry => entry.images);
	expect(holders.map(entry => [
		entry.tools?.map(tool => [tool.id, tool.status, tool.result]),
		entry.images!.map(item => item.alt),
	])).toEqual([[[["draw-1", "done", "1 image"]], ["Slow first try"]]]);
	let saved = (context.plan.persistence.committedSidecar as { transcript: Chat.Chat["entries"] })
		.transcript.filter(entry => entry.images);
	expect(saved.map(entry => [entry.id, entry.images!.map(item => item.alt)])).toEqual([
		[holders[0]!.id, ["Slow first try"]],
	]);
});

/**
 * An attached Planner whose turn asks which store to use and waits for the Decision before it
 * replies with the answer, as a model asking through `ask_user_question` does. Like a real client
 * it runs one turn at a time in a session. `steers` offers `steer-turn`. A client that does not
 * `endOnAbort` leaves its question waiting when Chopin stops the turn, and only the server's own
 * withdrawal of the question ends it.
 */
async function decidingPlanner(options: { steers: boolean; endOnAbort?: boolean }) {
	let room = await remoteRoom();
	let { context, channel } = room;
	// As `main.ts` asks the selected harness.
	context.steers = () => attachedLink(channel.id)?.steers === true;
	let steered: string[] = [];
	let results: Array<{ status: string; value?: unknown }> = [];
	let working = new Set<string>();
	let late: Promise<{ status: string; value?: unknown }>[] = [];
	let asking: string | undefined;
	let client: AgentClient | undefined;
	let reply = (turn: Parameters<AgentHandlers["turn"]>[0], text: string) => {
		let id = crypto.randomUUID();
		turn.emit({ type: "text-start", id });
		turn.emit({ type: "text-delta", id, delta: text });
		turn.emit({ type: "text-end", id });
		finishTurn(turn);
	};
	let handlers: Partial<AgentHandlers> = {
		async turn(turn) {
			let { session, prompt } = turn.message;
			turn.emit({ type: "stream-start", modelId: "scripted" });
			if (working.has(session)) {
				turn.emit({ type: "error", error: "This session is still working on a turn." });
				return;
			}
			working.add(session);
			try {
				if (!prompt.endsWith("which store?")) return reply(turn, "Done.");
				let question = client!.ask(
					session,
					{ method: "select", title: "Which store?", choices: ["Postgres", "Redis"] },
					options.endOnAbort === false ? {} : { signal: turn.signal },
				);
				asking = session;
				let result = await question;
				results.push(result);
				for (let question of late) results.push(await question);
				if (turn.signal.aborted) return;
				reply(turn, `Going with ${String(result.value)}.`);
			} finally {
				working.delete(session);
			}
		},
		...(options.steers ? { steer: message => void steered.push(message.prompt) } : {}),
	};
	client = await attach(room.server.url, channel.id, handlers as AgentHandlers);
	cleanups.push(() => client!.detach());
	let decision = async () => {
		await until(() => [...context.plan.records.values()].some(record => record.status === "open"));
		return [...context.plan.records.values()].find(record => record.status === "open")!.id;
	};
	return {
		...room,
		steered,
		results,
		decision,
		askAgain: (input: InputCall) => void late.push(client!.ask(asking!, input)),
		said: () => context.chat.entries.map(entry => entry.text),
		failures: () => context.chat.entries.filter(entry => entry.turnFailure),
	};
}

test("a message sent while the attached Planner's turn waits on its open decision is given to that turn, the answer still reaches it, and the next message starts a turn", async () => {
	let room = await decidingPlanner({ steers: true });
	let { context } = room;
	expect(await room.send("@chopin which store?")).toMatchObject({ kind: "chat:send" });
	let id = await room.decision();

	expect(await room.send("@chopin also cover the rollback")).toMatchObject({ kind: "chat:send" });
	await until(() => room.steered.length === 1);
	expect(room.steered).toEqual(["@rival: also cover the rollback"]);
	expect(context.chat.busy).toBe(true);
	expect(context.plan.records.get(id)?.status).toBe("open");

	await answerChoice(context, id, 0);
	await until(() => !context.chat.busy);
	expect(room.results).toEqual([
		expect.objectContaining({ status: "answered", value: "Postgres" }),
	]);
	expect(room.said()).toEqual(["which store?", "also cover the rollback", "Going with Postgres."]);

	expect(await room.send("@chopin and then?")).toMatchObject({ kind: "chat:send" });
	await until(() => !context.chat.busy && room.said().at(-1) === "Done.");
	expect(room.failures()).toEqual([]);
});

test("a client that takes no message mid-turn refuses one sent while its turn waits on an open decision, saving nothing, and once the decision is answered the next message starts a turn", async () => {
	let room = await decidingPlanner({ steers: false });
	let { context } = room;
	await room.send("@chopin which store?");
	let id = await room.decision();

	expect(await room.send("@chopin also cover the rollback")).toMatchObject({
		kind: "session:error",
		code: "planner-busy",
		message: "chopin can't take messages while it works on this machine. Stop it to ask now.",
	});
	expect(room.said()).toEqual(["which store?"]);

	await answerChoice(context, id, 0);
	await until(() => !context.chat.busy);
	expect(room.said()).toEqual(["which store?", "Going with Postgres."]);
	expect(await room.send("@chopin also cover the rollback")).toMatchObject({ kind: "chat:send" });
	await until(() => !context.chat.busy && room.said().at(-1) === "Done.");
	expect(room.failures()).toEqual([]);
});

for (let steers of [false, true]) {
	test(
		`Stop while the turn waits on its own open decision withdraws the decision with the turn, even from a client that leaves its question waiting, and the next message starts a turn without a Retry (${
			steers ? "a client that takes messages mid-turn" : "a client that takes none"
		})`,
		async () => {
			let room = await decidingPlanner({ steers, endOnAbort: false });
			let { context } = room;
			await room.send("@chopin which store?");
			let id = await room.decision();
			// What the refusal tells a person to do, or a message the turn takes, then Stop.
			await room.send("@chopin also cover the rollback");
			await Chat.abort(context, room.ws);

			// Well within the 10 seconds the server would otherwise wait for the client to end the turn.
			await until(() => !context.chat.busy);
			expect(context.plan.records.get(id)?.status).toBe("cancelled");
			expect(room.results).toEqual([expect.objectContaining({ status: "cancelled" })]);
			expect(context.chat.retained).toBeUndefined();

			expect(await room.send("@chopin and then?")).toMatchObject({ kind: "chat:send" });
			await until(() => !context.chat.busy && room.said().at(-1) === "Done.");
			expect(await room.send("@chopin one more")).toMatchObject({ kind: "chat:send" });
			await until(() => !context.chat.busy && room.said().at(-1) === "Done.");
			expect(room.failures()).toEqual([]);
		},
	);
}

for (
	let [input, value] of [
		[{ method: "select", title: "Which cache?", choices: ["Redis", "None"] }, null],
		[{ method: "confirm", title: "Add a cache?", message: "Redis in front." }, false],
		[
			{
				method: "questionnaire",
				params: {
					questions: [{
						header: "Cache",
						question: "Which cache?",
						options: [{ label: "Redis", description: "" }, { label: "None", description: "" }],
					}],
				},
			},
			{ answers: [], cancelled: true },
		],
	] satisfies Array<[InputCall, unknown]>
) {
	test(`a ${input.method} the attached Planner's turn asks just as Stop withdraws its open decision is cancelled too with its method's withdrawn value, and the next message starts a turn`, async () => {
		let room = await decidingPlanner({ steers: false, endOnAbort: false });
		let { context } = room;
		await room.send("@chopin which store?");
		let id = await room.decision();
		room.askAgain(input);
		await Chat.abort(context, room.ws);

		await until(() => !context.chat.busy);
		expect(context.plan.records.get(id)?.status).toBe("cancelled");
		expect([...context.plan.records.values()].filter(record => record.status === "open")).toEqual(
			[],
		);
		expect(room.results).toEqual([
			expect.objectContaining({ status: "cancelled" }),
			expect.objectContaining({ status: "cancelled", value }),
		]);
		expect(context.chat.retained).toBeUndefined();

		expect(await room.send("@chopin and then?")).toMatchObject({ kind: "chat:send" });
		await until(() => !context.chat.busy && room.said().at(-1) === "Done.");
		expect(room.failures()).toEqual([]);
	});
}

/**
 * An attached client, with or without `steer-turn`, whose turn for "which store?" asks a question
 * and waits for its answer before it ends, even once stopped: that turn ends when the server stops
 * waiting for its `turn-end`.
 */
async function waitingPlanner(steers: boolean) {
	let room = await remoteRoom(undefined, 500);
	room.context.steers = () => attachedLink(room.channel.id)?.steers === true;
	let script = scriptedPlanner();
	let steered: string[] = [];
	let answers: Array<{ status: string; value?: unknown }> = [];
	let reading = Promise.withResolvers<void>();
	let client: AgentClient;
	client = await attach(room.server.url, room.channel.id, {
		...script.handlers,
		async turn(turn) {
			script.turns.push(turn.message);
			if (turn.message.prompt.endsWith("which store?")) {
				let answer = await client.ask(turn.message.session, {
					method: "confirm",
					title: "Postgres?",
					message: "Use Postgres for the store.",
				});
				answers.push(answer);
				if (answer.status !== "answered") await new Promise(() => {});
			}
			// A model that is still working when a message is given to its turn.
			if (steers && turn.message.prompt.endsWith("keep it short")) await reading.promise;
			finishTurn(turn);
		},
		...(steers
			? {
				steer: (message: { prompt: string }) => {
					steered.push(message.prompt);
					reading.resolve();
				},
			}
			: {}),
	});
	cleanups.push(() => client.detach());
	expect(attachedLink(room.channel.id)?.steers).toBe(steers);
	let decision = async () => {
		await until(() =>
			[...room.context.plan.records.values()].some(record => record.status === "open")
		);
		return [...room.context.plan.records.values()].find(record => record.status === "open")!.id;
	};
	return {
		...room,
		script,
		steered,
		answers,
		decision,
		said: () => room.context.chat.entries.map(entry => entry.text),
	};
}

for (let steers of [true, false]) {
	let client = steers ? "a client that takes messages mid-turn" : "a client that takes none";
	test(`while ${client} waits on its open decision, a message ends in a stated state, the answer reaches the turn, and the next message is not held`, async () => {
		let room = await waitingPlanner(steers);
		let { context } = room;
		expect(await room.send("@chopin which store?")).toMatchObject({ kind: "chat:send" });
		let id = await room.decision();

		let first = await room.send("@chopin also cover the rollback");
		if (steers) {
			expect(first).toMatchObject({ kind: "chat:send" });
			await until(() => room.steered.length === 1);
			expect(room.steered[0]).toContain("also cover the rollback");
		} else {
			expect(first).toMatchObject({ kind: "session:error", code: "planner-busy" });
			expect(room.said()).not.toContain("also cover the rollback");
		}

		await answerChoice(context, id, 0);
		await until(() => room.answers.length === 1);
		expect(room.answers[0]).toMatchObject({ status: "answered", value: true });
		await until(() => !context.chat.busy);

		expect(await room.send("@chopin and then?")).toMatchObject({ kind: "chat:send" });
		await until(() => room.script.turns.length === 2);
		expect(room.script.turns[1]!.prompt).toContain("and then?");
		await until(() => !context.chat.busy);
		expect(context.chat.entries.filter(entry => entry.turnFailure)).toEqual([]);
	});

	test(
		`while ${client} has not ended a stopped turn, a message is kept and starts the next turn, and the one after it is ${
			steers ? "given to that turn" : "refused for good"
		}, never held`,
		async () => {
			let room = await waitingPlanner(steers);
			let { context } = room;
			expect(await room.send("@chopin which store?")).toMatchObject({ kind: "chat:send" });
			await room.decision();
			await Chat.abort(context, room.ws);
			expect(context.chat.busy).toBe(true);

			expect(await room.send("@chopin keep it short")).toMatchObject({ kind: "chat:send" });
			let second = await room.send("@chopin and name an owner");
			if (steers) expect(second).toMatchObject({ kind: "chat:send" });
			else expect(second).toMatchObject({ kind: "session:error", code: "planner-starting" });
			expect(room.script.turns).toHaveLength(1);

			await until(() => room.script.turns.length === 2);
			expect(room.script.turns[1]!.prompt).toContain("keep it short");
			if (steers) {
				await until(() => room.steered.length === 1);
				expect(room.steered[0]).toContain("and name an owner");
			} else {
				expect(room.said()).not.toContain("and name an owner");
			}
			await until(() => !context.chat.busy);
			expect(room.said().some(text => /did not read/.test(text))).toBe(false);
			expect(context.chat.entries.filter(entry => entry.turnFailure)).toEqual([]);
		},
	);
}

test("an unplanned disconnect mid-turn with no open input-request keeps the Retry failure banner", async () => {
	let room = await remoteRoom();
	let { context, server } = room;
	let turning = Promise.withResolvers<void>();
	let client = await connectAgent({
		url: server.url,
		token: MEMBER_TOKEN,
		document: room.channel.id,
		resumable: true,
		handlers: {
			async turn() {
				turning.resolve();
				await new Promise(() => {});
			},
		},
	});
	cleanups.push(() => client.detach());
	expect(await room.send("@chopin outline the plan")).toMatchObject({ kind: "chat:send" });
	await turning.promise;
	for (let socket of server.sockets) socket.close(1001, "network failed");
	await context.chat.running;
	let failed = context.chat.entries.filter(entry => entry.turnFailure);
	expect(failed).toHaveLength(1);
	expect(failed[0]!.turnFailure).toMatchObject({
		kind: "error",
		detail: "The machine disconnected during the turn.",
	});
});

test("a fast reconnect that clears suspended before turn catch runs still classifies the interrupted turn as dropped", async () => {
	let down = await resumablePlanner({ ask: true });
	let { context, server } = down;
	let id = [...context.plan.records.keys()][0]!;
	let turning = Promise.withResolvers<void>();
	let streamRelease = Promise.withResolvers<void>();
	let origOpen = context.openPlannerSession!;
	let retained = context.chat.retained!;
	let origStream = retained.session.stream.bind(retained.session);
	retained.session.stream = async (...args) => {
		let res = await origStream(...args);
		let inner = res.fullStream;
		return {
			...res,
			fullStream: (async function*() {
				try {
					for await (let part of inner) yield part;
				} finally {
					// Hold stream teardown until after the client has reconnected and cleared suspended.
					await streamRelease.promise;
				}
			})() as never,
		};
	};
	context.openPlannerSession = origOpen;
	(down.handlers as any).turn = async () => {
		turning.resolve();
		await new Promise(() => {});
	};
	let invoked = Chat.invoke(context, RIVAL, "Keep going");
	await turning.promise;
	await down.drop();
	// Client reconnects and resumes (clearing suspended = false) BEFORE turn catch executes.
	await down.reconnect();
	await until(() => server.attachments.status(down.channel.id).state === "attached");
	expect(retained.session.suspended?.()).toBe(false);
	streamRelease.resolve();
	await invoked;
	await context.chat.running;
	let failed = context.chat.entries.filter(entry => entry.turnFailure);
	expect(failed).toHaveLength(1);
	expect(failed[0]!.turnFailure).toMatchObject({ kind: "dropped" });
	expect(context.plan.records.get(id)?.status).toBe("open");
});

test("a retained session whose owner credential rotated to a new login and generation while suspended rebinds cleanly for the same owner and repository", async () => {
	let down = await resumablePlanner({ ask: true });
	let { context } = down;
	let id = [...context.plan.records.keys()][0]!;
	let retained = context.chat.retained!;
	let originalSession = retained.session;
	let originalBinding = retained.binding;
	await down.drop();

	// Simulate credential expiry while suspended AND a freshly minted owner session/generation
	// for the same user + repository when the machine reconnects.
	let expired = new AbortController();
	let previous = {
		...originalBinding,
		signal: expired.signal,
		release: () => expired.abort(new Error("released")),
	};
	retained.binding = previous;
	expired.abort(new Error("credential-expired"));

	let rotatedController = new AbortController();
	let rotatedBinding = {
		...originalBinding,
		ownerSessionId: "delegated-login-rotated",
		ownerGeneration: originalBinding.ownerGeneration + 1,
		credentialRevision: originalBinding.credentialRevision + 1,
		ownerUserId: originalBinding.ownerUserId,
		signal: rotatedController.signal,
		revalidate: async () => true,
		release: () => rotatedController.abort(new Error("released")),
	};
	context.activeOwner = async () => rotatedBinding;

	await down.reconnect();
	expect(await Chat.invoke(context, RIVAL, "Continue after rebind")).toBeUndefined();
	await context.chat.running;
	expect(context.chat.retained?.session).toBe(originalSession);
	expect(context.chat.retained?.binding).toBe(rotatedBinding);
	expect(context.plan.records.get(id)?.status).toBe("open");
	await answerChoice(context, id, 0);
	expect(await down.asked()).toMatchObject({ status: "answered", value: true });
});

test("when a retained session cannot rebind because another owner took over, releasing it detaches the waiter without withdrawing open Decisions", async () => {
	let down = await resumablePlanner({ ask: true });
	let { context } = down;
	let id = [...context.plan.records.keys()][0]!;
	let retained = context.chat.retained!;
	let originalBinding = retained.binding;
	await down.drop();

	let expired = new AbortController();
	retained.binding = { ...originalBinding, signal: expired.signal };
	expired.abort(new Error("credential-expired"));

	let otherController = new AbortController();
	context.activeOwner = async () => ({
		...originalBinding,
		ownerSessionId: "other-user-login",
		ownerGeneration: originalBinding.ownerGeneration + 1,
		ownerUserId: "U_other",
		signal: otherController.signal,
		revalidate: async () => true,
		release: () => otherController.abort(new Error("released")),
	});

	await down.reconnect();
	await retained.release();
	expect(context.chat.retained).toBeUndefined();
	expect(context.plan.records.get(id)?.status).toBe("open");
	expect(Store.get(context.plan.questions, id)?.awaited).toBeUndefined();
	expect(plannerToActOn(
		context.plan.records.get(id)!,
		Store.get(context.plan.questions, id)!,
	)).toBe(true);
});

test("rebinds a running remote Planner turn across consecutive GitHub credential rotations, including host tools during the refresh window, while session revocation still aborts", async () => {
	let refreshGate:
		| ReturnType<
			typeof Promise.withResolvers<{
				accessToken: string;
				accessExpiresIn: number;
				refreshToken: string;
				refreshExpiresIn: number;
			}>
		>
		| undefined;
	let { auth, storage, sessions, channel, logins, revocations, rotations, signOut } =
		await linkAuth(undefined, {
			refresh: async () => {
				refreshGate = Promise.withResolvers();
				return refreshGate.promise;
			},
		});
	let server = linkServer(auth);
	cleanups.push(server.stop);
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let publisher = { publish() {} } as unknown as Server<SocketData>;
	let plan = await Plan.open(channel.id, {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	}, publisher);
	let owners = new ActiveOwnerBindings(auth as unknown as HostedAuth);
	let revokedTokens = new Set<string>();
	rotations.add(async (sessionId, revision) => {
		let stale = revision === 1 ? "member-browser-login" : `member-browser-login-${revision}`;
		revokedTokens.add(stale);
		owners.revokeCredential(sessionId, revision);
		await Chat.resetAgent(
			plan.chat,
			sessionId,
			revision,
			"GitHub credentials refreshed, so chopin's session was restarted. Ask it to continue.",
		);
	});
	revocations.add(async sessionId => {
		owners.revokeSession(sessionId);
		server.attachments.sessionRevoked(sessionId);
		await Chat.resetAgent(plan.chat, sessionId, undefined, "Your GitHub sign-in ended.");
	});

	let repoTokens: string[] = [];
	let originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		let url = String(input);
		if (url.startsWith("https://api.github.com/repos/octo-org/score/")) {
			let header = new Headers(init?.headers).get("authorization") ?? "";
			let bearer = header.replace(/^Bearer /, "");
			expect(revokedTokens.has(bearer)).toBe(false);
			repoTokens.push(bearer);
			return Response.json({
				type: "file",
				encoding: "base64",
				content: Buffer.from(`read-with:${bearer}`).toString("base64"),
			});
		}
		return originalFetch(input, init);
	}) as typeof fetch;
	cleanups.push(() => {
		globalThis.fetch = originalFetch;
	});

	let prTokens: string[] = [];
	let agent = createPlannerAgent(createRemoteAdapter());
	let url = `https://chopin.test/documents/octo-org/score/${channel.slug}`;
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
				: server.attachments.unavailable(channel.id)
					?? notAttachedMessage(url, "octo-org/score"),
		activeOwner: () => owners.resolve(channel.id),
		persist: () => Plan.persist(plan),
		openPlannerSession: (binding, options) =>
			openPlannerSession(binding, options, {
				githubTools: async active => {
					expect(revokedTokens.has(active.token)).toBe(false);
					prTokens.push(active.token);
					return {
						ok: true,
						value: {
							list_pull_requests: tool({
								inputSchema: GITHUB_TOOL_SCHEMAS.list_pull_requests.inputSchema,
								execute: async () => ({ prToken: active.token }),
							}),
							pull_request_read: tool({
								inputSchema: GITHUB_TOOL_SCHEMAS.pull_request_read.inputSchema,
								execute: async () => ({}),
							}),
						},
					};
				},
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

	let turnNumber = 0;
	let read1Done = Promise.withResolvers<void>();
	let duringRotation1 = Promise.withResolvers<void>();
	let rotation1ToolsStarted = Promise.withResolvers<void>();
	let rotation1Done = Promise.withResolvers<void>();
	let rotation2Done = Promise.withResolvers<void>();
	let turn2Started = Promise.withResolvers<void>();
	let turn2Ended = Promise.withResolvers<void>();
	let outputs: unknown[] = [];

	let client = await connectAgent({
		url: server.url,
		token: MEMBER_TOKEN,
		document: channel.id,
		handlers: {
			...scriptedPlanner().handlers,
			async turn(turn) {
				turnNumber++;
				if (turnNumber === 1) {
					outputs.push((await turn.callHostTool("read_repository_file", { path: "a.ts" })).output);
					let drafted = JSON.parse(
						String(
							(await turn.callHostTool("edit_plan", {
								revision: 0,
								operations: [{
									op: "replace_root",
									source: "# Plan\n\nProvisional storage choice.\n",
								}],
							})).output,
						),
					) as { revision: number; blocks: Array<{ index: number; digest: string }> };
					read1Done.resolve();
					await duringRotation1.promise;
					let read2 = turn.callHostTool("read_repository_file", { path: "b.ts" });
					let pr2 = turn.callHostTool("list_pull_requests", {});
					let decision = turn.callHostTool("open_decisions", {
						revision: drafted.revision,
						questions: [{
							key: "pick_store_db",
							header: "Storage",
							question: "Which store?",
							response: "text",
							options: [],
							multiple: false,
							blocks: [{ index: drafted.blocks[1]!.index, digest: drafted.blocks[1]!.digest }],
						}],
					});
					rotation1ToolsStarted.resolve();
					outputs.push((await read2).output, (await pr2).output, (await decision).output);
					rotation1Done.resolve();
					await rotation2Done.promise;
					outputs.push((await turn.callHostTool("read_repository_file", { path: "c.ts" })).output);
					finishTurn(turn);
					return;
				}
				turn2Started.resolve();
				await turn2Ended.promise;
			},
			stop() {
				turn2Ended.resolve();
			},
		} as AgentHandlers,
		resumable: true,
	});
	cleanups.push(() => client.detach());

	let memberSessionId = logins.get("member")!;
	expect(await Chat.invoke(context, RIVAL, "Inspect repository")).toBeUndefined();
	await read1Done.promise;
	expect(context.chat.owner?.revision).toBe(1);

	// Rotation 1 -> 2 while turn 1 is actively running (triggered by a 401 before expiry).
	let snap1 = (await sessions.resolve(memberSessionId))!;
	let rotate1 = sessions.use(snap1, async token => {
		if (token === "member-browser-login") throw new GitHubError("expired", 401);
		return token;
	});
	await until(() => refreshGate !== undefined);
	duringRotation1.resolve();
	await rotation1ToolsStarted.promise;
	await Bun.sleep(10);
	expect(context.chat.turnController?.signal.aborted).toBe(false);
	refreshGate!.resolve({
		accessToken: "member-browser-login-2",
		accessExpiresIn: 28_800,
		refreshToken: "refresh-2",
		refreshExpiresIn: 86_400,
	});
	expect((await rotate1).value).toBe("member-browser-login-2");
	await rotation1Done.promise;
	expect(context.chat.owner?.revision).toBe(2);

	// Rotation 2 -> 3 (consecutive rotation on the same running turn).
	refreshGate = undefined;
	let snap2 = (await sessions.resolve(memberSessionId))!;
	let rotate2 = sessions.use(snap2, async token => {
		if (token === "member-browser-login-2") throw new GitHubError("expired", 401);
		return token;
	});
	await until(() => refreshGate !== undefined);
	refreshGate!.resolve({
		accessToken: "member-browser-login-3",
		accessExpiresIn: 28_800,
		refreshToken: "refresh-3",
		refreshExpiresIn: 86_400,
	});
	expect((await rotate2).value).toBe("member-browser-login-3");
	await until(() => context.chat.owner?.revision === 3);
	rotation2Done.resolve();

	await context.chat.running;
	expect(context.chat.entries.some(entry => entry.turnFailure !== undefined)).toBe(false);
	expect(repoTokens).toEqual([
		"member-browser-login",
		"member-browser-login-2",
		"member-browser-login-3",
	]);
	expect(prTokens).toEqual(["member-browser-login-2"]);
	expect(String(outputs[0])).toContain("read-with:member-browser-login");
	expect(String(outputs[1])).toContain("read-with:member-browser-login-2");
	expect(outputs[2]).toEqual({ prToken: "member-browser-login-2" });
	expect(String(outputs[4])).toContain("read-with:member-browser-login-3");
	expect([...context.plan.records.values()].some(record => record.status === "open")).toBe(true);

	// Full session revocation still aborts an active rebindable turn.
	expect(await Chat.invoke(context, RIVAL, "Second turn")).toBeUndefined();
	await turn2Started.promise;
	await signOut("member");
	await context.chat.running;
	expect(
		context.chat.entries.some(entry => entry.text.includes("Your GitHub sign-in ended.")),
	).toBe(true);
});

test("keeps host tools working through a delegated machine-token rotation before beforeRefresh fires", async () => {
	let { auth, storage, sessions, channel, logins, rotations } = await linkAuth();
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let sourceGate:
		| ReturnType<
			typeof Promise.withResolvers<{
				accessToken: string;
				accessExpiresIn: number;
				refreshToken: string;
				refreshExpiresIn: number;
			}>
		>
		| undefined;
	let machines = new Machines(storage, () => new Date(), {
		key: new Uint8Array(32).fill(7),
		origin: auth.config.origin,
		clientId: "client",
		authorize: async (userId, token) => (await auth.admission.user(token)).id === userId,
		refresh: async () => {
			sourceGate = Promise.withResolvers();
			return sourceGate.promise;
		},
		lease: () => lease,
	});
	let planners = new MachinePlanners({
		machines,
		sessions,
		storage,
		github: auth.github,
		config: auth.config,
		clock: () => new Date(),
	});
	let server = linkServer(auth, 2_000, undefined, 2_000, undefined, planners);
	cleanups.push(server.stop);
	let publisher = { publish() {} } as unknown as Server<SocketData>;
	let plan = await Plan.open(channel.id, {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	}, publisher);
	let owners = new ActiveOwnerBindings(auth as unknown as HostedAuth);
	rotations.add(async (sessionId, revision) => {
		owners.revokeCredential(sessionId, revision);
		await Chat.resetAgent(
			plan.chat,
			sessionId,
			revision,
			"GitHub credentials refreshed, so chopin's session was restarted. Ask it to continue.",
		);
	});

	let repoTokens: string[] = [];
	let originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		let url = String(input);
		if (url.startsWith("https://api.github.com/repos/octo-org/score/")) {
			let bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
			repoTokens.push(bearer);
			return Response.json({
				type: "file",
				encoding: "base64",
				content: Buffer.from(`delegated:${bearer}`).toString("base64"),
			});
		}
		return originalFetch(input, init);
	}) as typeof fetch;
	cleanups.push(() => {
		globalThis.fetch = originalFetch;
	});

	let agent = createPlannerAgent(createRemoteAdapter());
	let url = `https://chopin.test/documents/octo-org/score/${channel.slug}`;
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
				: server.attachments.unavailable(channel.id)
					?? notAttachedMessage(url, "octo-org/score"),
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

	let { machine } = await machines.pair({
		userId: "U_member",
		label: "member-laptop",
		repositories: [],
		autoRun: false,
		grant: {
			accessToken: machineToken("member", 1),
			accessExpiresIn: 28_800,
			refreshToken: "member-machine-refresh-1",
			refreshExpiresIn: 15_897_600,
		},
	});
	let issued = await planners.issue(machine, channel.id);

	let turnStarted = Promise.withResolvers<void>();
	let callDuringSource = Promise.withResolvers<void>();
	let toolStarted = Promise.withResolvers<void>();
	let toolOutput: unknown;
	let revisionAfterTool: number | undefined;
	let client = await connectAgent({
		url: server.url,
		token: issued.token,
		document: channel.id,
		handlers: {
			...scriptedPlanner().handlers,
			async turn(turn) {
				turnStarted.resolve();
				await callDuringSource.promise;
				let pending = turn.callHostTool("read_repository_file", { path: "delegated.ts" });
				toolStarted.resolve();
				toolOutput = (await pending).output;
				revisionAfterTool = context.chat.owner?.revision;
				finishTurn(turn);
			},
		} as AgentHandlers,
		resumable: true,
	});
	cleanups.push(() => client.detach());

	expect(await Chat.invoke(context, RIVAL, "Read delegated file")).toBeUndefined();
	await turnStarted.promise;
	let delegatedId = (await storage.channels.readAgent(channel.id, new Date()))!.agent!
		.ownerSessionId!;

	// Trigger delegated rotation: machine.access() -> machines.refresh() is pending and
	// beforeRefresh has NOT fired yet.
	let snap = (await sessions.resolve(delegatedId))!;
	let rotating = sessions.use(snap, async token => {
		if (token === machineToken("member", 1)) throw new GitHubError("expired", 401);
		return token;
	});
	await until(() => sourceGate !== undefined);
	expect(sessions.token(delegatedId, 1)).toBeUndefined();

	// Invoke read_repository_file right inside the pre-beforeRefresh delegated source() window.
	callDuringSource.resolve();
	await toolStarted.promise;
	await Bun.sleep(10);
	sourceGate!.resolve({
		accessToken: machineToken("member", 2),
		accessExpiresIn: 28_800,
		refreshToken: "member-machine-refresh-2",
		refreshExpiresIn: 15_897_600,
	});
	expect((await rotating).value).toBe(machineToken("member", 2));
	await context.chat.running;

	expect(context.chat.entries.some(entry => entry.turnFailure !== undefined)).toBe(false);
	expect(repoTokens).toEqual([machineToken("member", 2)]);
	expect(String(toolOutput)).toContain(`delegated:${machineToken("member", 2)}`);
	expect(revisionAfterTool).toBe(2);
});

test("keeps a retained session alive when its credential finishes rebinding between repositorySession and ownerSignal or mid-revalidate", async () => {
	let revision = 1;
	let { auth, storage, sessions, channel, logins, rotations } = await linkAuth(undefined, {
		refresh: async () => {
			revision++;
			return {
				accessToken: `member-browser-login-${revision}`,
				accessExpiresIn: 28_800,
				refreshToken: `refresh-${revision}`,
				refreshExpiresIn: 86_400,
			};
		},
	});
	let server = linkServer(auth);
	cleanups.push(server.stop);
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let publisher = { publish() {} } as unknown as Server<SocketData>;
	let plan = await Plan.open(channel.id, {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	}, publisher);
	let owners = new ActiveOwnerBindings(auth as unknown as HostedAuth);
	rotations.add(async (sessionId, rev) => {
		owners.revokeCredential(sessionId, rev);
		await Chat.resetAgent(
			plan.chat,
			sessionId,
			rev,
			"GitHub credentials refreshed, so chopin's session was restarted. Ask it to continue.",
		);
	});
	let agent = createPlannerAgent(createRemoteAdapter());
	let url = `https://chopin.test/documents/octo-org/score/${channel.slug}`;
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
				: server.attachments.unavailable(channel.id)
					?? notAttachedMessage(url, "octo-org/score"),
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

	let asked: Promise<{ status: string; value?: unknown }> | undefined;
	let client: AgentClient | undefined;
	client = await connectAgent({
		url: server.url,
		token: MEMBER_TOKEN,
		document: channel.id,
		handlers: {
			...scriptedPlanner().handlers,
			async turn(turn) {
				if (!asked) {
					asked = client!.ask(turn.message.session, {
						method: "confirm",
						title: "Ship?",
						message: "Now.",
					});
				}
				finishTurn(turn);
			},
		} as AgentHandlers,
		resumable: true,
	});
	cleanups.push(() => client!.detach());

	expect(await Chat.invoke(context, RIVAL, "Open decision")).toBeUndefined();
	await context.chat.running;
	await until(() => [...context.plan.records.values()][0]?.status === "open");
	await until(() => context.chat.retained !== undefined);
	let id = [...context.plan.records.keys()][0]!;
	let retained = context.chat.retained!;
	let originalSession = retained.session;
	let memberSessionId = logins.get("member")!;

	let triggerRotation = async (expectedToken: string) => {
		let snap = (await sessions.resolve(memberSessionId))!;
		await sessions.use(snap, async token => {
			if (token === expectedToken) throw new GitHubError("expired", 401);
			return token;
		});
	};

	// Case 1: rotation finishes rebinding retained.binding to rev 2 inside takeNotes, AFTER
	// repositorySession returned rev 1 and BEFORE ownerSignal attaches.
	context.sessionForks = {
		prepareTurn: () => ({}),
		finishTurn: async () => {},
		takeNotes: async () => {
			await triggerRotation("member-browser-login");
			await until(() => retained.binding.credentialRevision === 2);
			return undefined;
		},
	};
	expect(await Chat.invoke(context, RIVAL, "Continue after pre-ownerSignal rebind"))
		.toBeUndefined();
	await context.chat.running;
	expect(context.chat.entries.some(entry => entry.turnFailure !== undefined)).toBe(false);
	expect(context.chat.retained?.session).toBe(originalSession);
	expect(context.chat.retained?.binding.credentialRevision).toBe(2);
	expect(context.chat.owner?.revision).toBe(2);
	expect(context.plan.records.get(id)?.status).toBe("open");

	// Case 2: rotation finishes rebinding retained.binding to rev 3 mid-revalidate() inside
	// repositorySession before revalidate() resolves false.
	context.sessionForks = undefined;
	let rev2Binding = retained.binding;
	let origRevalidate = rev2Binding.revalidate;
	rev2Binding.revalidate = async () => {
		await triggerRotation("member-browser-login-2");
		await until(() => retained.binding.credentialRevision === 3);
		return origRevalidate();
	};
	expect(await Chat.invoke(context, RIVAL, "Continue after mid-revalidate rebind")).toBeUndefined();
	await context.chat.running;
	expect(context.chat.entries.some(entry => entry.turnFailure !== undefined)).toBe(false);
	expect(context.chat.retained?.session).toBe(originalSession);
	expect(context.chat.retained?.binding.credentialRevision).toBe(3);
	expect(context.chat.owner?.revision).toBe(3);
	expect(context.plan.records.get(id)?.status).toBe("open");
	await answerChoice(context, id, 0);
	expect(await asked!).toMatchObject({ status: "answered", value: true });
});
