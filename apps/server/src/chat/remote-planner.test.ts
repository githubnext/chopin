import { afterEach, expect, test } from "bun:test";

import { ActiveOwnerBindings } from "../agent/active-owner";
import { createPlannerAgent } from "../harness/agents";
import { createRemoteAdapter } from "../harness/remote/adapter";
import { notAttachedMessage } from "../harness/remote/attachments";
import { openPlannerSession } from "../harness/session";
import * as Plan from "../plan/service";
import { configured } from "../testing/config";
import { decideReplying } from "../conversation-plan/decisions.test-fixtures";
import {
	attach,
	finishTurn,
	linkAuth,
	linkServer,
	RIVAL_TOKEN,
	scriptedPlanner,
} from "../testing/agent-link";
import * as Chat from "./service";
import * as Question from "@chopin/question";
import { answerTurns } from "../questions/answer-turns";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { member } from "../questions/text-response.test-fixtures";

import type { Server } from "bun";
import type { AgentClient } from "@chopin/agent-link/client";
import type { HostedAuth } from "../auth/routes";
import type { Socket, SocketData } from "../wire";

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const REMOTE = { HARNESS: "remote", BACKGROUND_JOBS: "off" };
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
async function remoteRoom() {
	let { auth, storage, channel, logins, revocations, signOut, clock } = await linkAuth();
	let server = linkServer(auth);
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
	let send = async (text: string, to: "planner" | "room" = "planner") => {
		let rid = crypto.randomUUID();
		await Chat.send(context, ws, {
			kind: "chat:send",
			rid,
			requestId: crypto.randomUUID(),
			to,
			text,
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
	let message =
		"No Planner is attached to this document. To attach one, connect a Planner client to "
		+ `${room.url} over the agent connection from a session in a checkout of octo-org/score; `
		+ "that session becomes this document's Planner.";

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
		"@rival stopped the Planner and paused its workflows.",
	);
	expect(context.chat.entries.map(entry => entry.text)).toContain(
		"@rival resumed the Planner's workflows.",
	);
});

test("once the attached Planner's owner sign-in expires, @chopin is refused with how to attach one before its periodic recheck, and nothing is posted or queued", async () => {
	let room = await expiredOwnerRoom();
	let { context } = room;
	expect(await room.send("@chopin draft the plan")).toMatchObject({
		kind: "session:error",
		code: "planner-not-attached",
		message: "No Planner is attached to this document. To attach one, connect a Planner client to "
			+ `${room.url} over the agent connection from a session in a checkout of octo-org/score; `
			+ "that session becomes this document's Planner.",
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
