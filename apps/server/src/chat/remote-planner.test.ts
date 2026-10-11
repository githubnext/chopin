import { afterEach, expect, test } from "bun:test";

import { ActiveOwnerBindings } from "../agent/active-owner";
import { createPlannerAgent } from "../harness/agents";
import { createRemoteAdapter } from "../harness/remote/adapter";
import { notAttachedMessage } from "../harness/remote/attachments";
import { openPlannerSession } from "../harness/session";
import * as Plan from "../plan/service";
import { configured } from "../testing/config";
import { attach, finishTurn, linkAuth, linkServer, scriptedPlanner } from "../testing/planner-link";
import * as Chat from "./service";

import type { Server } from "bun";
import type { PlannerLinkClient } from "@chopin/planner-link/client";
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
 * with a real Planner link server. The rival sends from a browser with a
 * login of their own; only the attached member may own the Planner.
 */
async function remoteRoom() {
	let { auth, storage, channel, logins } = await linkAuth();
	let server = linkServer(auth);
	cleanups.push(server.stop);
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
		chat: plan.chat,
		plan,
		room: channel.id,
		server: publisher,
		auth: auth as unknown as HostedAuth,
		repository: { id: "R_score", owner: "octo-org", name: "score", defaultBranch: "main" },
		config: configured(REMOTE),
		claimantSessionId: logins.get("rival"),
		plannerNotAttached: async () =>
			server.attachments.attached(channel.id)
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
	return { context, server, channel, logins, url, ws, send, owner, events };
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
	let message = "No Planner is attached to this document. To attach one, connect a Planner client to "
		+ `${room.url} over the Planner link from a session in a checkout of octo-org/score; `
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
	let client: PlannerLinkClient;
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
