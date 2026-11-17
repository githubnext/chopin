/**
 * Messages to a full Atomic Planner while its turn waits on a Decision it opened, or while a turn
 * that was stopped there winds down: each is kept at once and read, none waits behind another, and
 * an answer still reaches the turn that asked. Runs the real Atomic adapter against a local model
 * stub.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Question from "@chopin/question";
import { ActiveOwnerBindings } from "../agent/active-owner";
import { decideReplying } from "../conversation-plan/decisions.test-fixtures";
import { createPlannerAgent } from "../harness/agents";
import { createAtomicAdapter } from "../harness/atomic/adapter";
import { startStubModelServer } from "../harness/atomic/model-stub";
import { openPlannerSession } from "../harness/session";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import * as Store from "../questions/store";
import { member } from "../questions/text-response.test-fixtures";
import { linkAuth } from "../testing/agent-link";
import { configured } from "../testing/config";
import * as Chat from "./service";
import * as Threads from "./threads";

import type { Server } from "bun";
import type { HostedAuth } from "../auth/routes";
import type { Socket, SocketData } from "../wire";

const ASKS = "which store?";

let stub = startStubModelServer((prompt, answered) =>
	prompt.endsWith(ASKS) && !answered
		? {
			kind: "tool",
			name: "ask_user_question",
			arguments: JSON.stringify({
				questions: [{
					header: "Store",
					question: "Which store?",
					options: [
						{ label: "Postgres", description: "Relational" },
						{ label: "Redis", description: "In memory" },
					],
				}],
			}),
		}
		: { kind: "text", text: `Read: ${prompt.split("\n").at(-1)}` }
);

let root = "";
let previous: Record<string, string | undefined> = {};
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "chopin-busy-turn-"));
	for (
		let [name, value] of [
			["ATOMIC_CODING_AGENT_DIR", join(root, "agent")],
			["XDG_STATE_HOME", join(root, "state")],
		] as const
	) {
		previous[name] = process.env[name];
		process.env[name] = value;
	}
});
afterAll(async () => {
	stub.stop();
	for (let [name, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await rm(root, { recursive: true, force: true });
});

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function until(check: () => boolean, ms = 8_000) {
	for (let deadline = Date.now() + ms; Date.now() < deadline && !check(); await Bun.sleep(5));
	expect(check()).toBe(true);
}

/** A document's Chat served as `main.ts` serves it under `HARNESS=atomic`, with its Decisions. */
async function atomicRoom() {
	let { auth, storage, channel, logins } = await linkAuth();
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let server = { publish() {} } as unknown as Server<SocketData>;
	let plan = await Plan.open(channel.id, {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	}, server);
	let owners = new ActiveOwnerBindings(auth as unknown as HostedAuth);
	let adapter = createAtomicAdapter({
		auth: "ai-gateway",
		model: "stub/model",
		providers: {
			stub: {
				baseUrl: stub.baseUrl,
				apiKey: "stub",
				api: "openai-completions",
				models: [{
					id: "model",
					name: "Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 4096,
				}],
			},
		},
	});
	let agent = createPlannerAgent(adapter);
	let context = Threads.bindTopLevel({
		decide: decideReplying({ input: { type: "noul", noul: 0 } }),
		chat: plan.chat,
		plan,
		room: channel.id,
		server,
		auth: auth as unknown as HostedAuth,
		repository: { id: "R_score", owner: "octo-org", name: "score", defaultBranch: "main" },
		config: configured({ HARNESS: "atomic", MODEL: "stub/model", BACKGROUND_JOBS: "off" }),
		claimantSessionId: logins.get("member"),
		activeOwner: () => owners.resolve(channel.id),
		persist: () => Plan.persist(plan),
		// An Atomic Planner takes a message while its turn runs.
		steers: () => true,
		openPlannerSession: (binding, options) =>
			openPlannerSession(binding, options, {
				githubTools: async () => ({ ok: true, value: {} }),
				createSandbox: async () =>
					({
						defaultWorkingDirectory: root,
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
		await adapter.shutdown();
	});
	let replies: Array<{ kind: string; rid?: string; [key: string]: unknown }> = [];
	let ws = {
		data: { handle: "member", principalId: "U_member", sessionId: logins.get("member") },
		send(text: string) {
			replies.push(JSON.parse(text));
		},
	} as unknown as Socket;
	let send = async (text: string) => {
		let rid = crypto.randomUUID();
		await Chat.send(context, ws, {
			kind: "chat:send",
			rid,
			requestId: crypto.randomUUID(),
			to: "planner",
			text,
			ts: 0,
		} as never);
		return replies.find(reply => reply.rid === rid);
	};
	let decision = async () => {
		await until(() => [...plan.records.values()].some(record => record.status === "open"));
		return [...plan.records.values()].find(record => record.status === "open")!.id;
	};
	/** A member's Save of the decision's first option, as the Decisions surface sends it. */
	let answer = async (id: string) => {
		let opened = Store.snapshot(plan.questions, id);
		if (!opened.open) throw new Error("question closed");
		let definition = Store.get(plan.questions, id)!.definition;
		let model = Question.restore(opened.model, definition);
		let question = definition.questions[0]!;
		model.api.val([question.id, "mode"]).set("choices");
		model.api.val([question.id, "choice"]).set(question.options[0]!.id);
		let actor = member("ana");
		await Questions.edit(plan, actor.ws, {
			kind: "question:edit",
			ts: 0,
			rid: "edit",
			id,
			patch: [...model.api.flush()!.toBinary()],
		});
		await Questions.submit(plan, server, channel.id, actor.ws, {
			kind: "question:submit",
			ts: 0,
			rid: "save",
			id,
			revision: Store.get(plan.questions, id)!.revision,
		});
		expect(actor.frames.at(-1)).toMatchObject({ kind: "question:submit", ok: true });
	};
	let replied = () =>
		plan.chat.entries.filter(entry => entry.author.kind === "agent" && entry.text)
			.map(entry => entry.text);
	return {
		context,
		plan,
		ws,
		send,
		decision,
		answer,
		replied,
		failures: () => plan.chat.entries.filter(entry => entry.turnFailure),
	};
}

test(
	"a message sent while a full Atomic Planner's turn waits on its open decision is read by that turn with the answer, and the next message starts a turn",
	async () => {
		let room = await atomicRoom();
		stub.requests.length = 0;
		expect(await room.send(`@chopin ${ASKS}`)).toMatchObject({ kind: "chat:send" });
		let id = await room.decision();

		expect(await room.send("@chopin also cover the rollback")).toMatchObject({ kind: "chat:send" });
		await room.answer(id);
		await until(() => !room.plan.chat.busy);
		let next = stub.requests[1]!;
		expect(next.toolResults.join("\n")).toContain("Postgres");
		expect(next.prompt).toBe("@member: also cover the rollback");

		expect(await room.send("@chopin and then?")).toMatchObject({ kind: "chat:send" });
		await until(() => !room.plan.chat.busy && room.replied().length === 2);
		expect(room.replied().at(-1)).toBe("Read: @member: and then?");
		expect(room.failures()).toEqual([]);
	},
	30_000,
);

test(
	"messages sent while a full Atomic Planner's stopped turn winds down are kept at once, and each is read without waiting behind the other",
	async () => {
		let room = await atomicRoom();
		stub.requests.length = 0;
		await room.send(`@chopin ${ASKS}`);
		await room.decision();
		await Chat.abort(room.context, room.ws);
		expect(room.plan.chat.busy).toBe(true);
		let [first, second] = await Promise.all([
			room.send("@chopin keep it short"),
			room.send("@chopin and name an owner"),
		]);
		expect(first).toMatchObject({ kind: "chat:send" });
		expect(second).toMatchObject({ kind: "chat:send" });

		await until(() => !room.plan.chat.busy && room.replied().length === 2);
		expect(stub.requests.map(request => request.prompt).slice(1)).toEqual([
			"@member: keep it short",
			"@member: and name an owner",
		]);
		expect(room.replied()).toEqual([
			"Read: @member: keep it short",
			"Read: @member: and name an owner",
		]);
		expect(room.plan.chat.entries.some(entry => /did not read/.test(entry.text))).toBe(false);
		expect(room.failures()).toEqual([]);
	},
	30_000,
);
