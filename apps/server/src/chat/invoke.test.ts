import { Machines } from "../auth/machines";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActiveOwnerBindings } from "../agent/active-owner";
import { documentTools } from "../agent/tools";
import { decideReplying } from "../conversation-plan/decisions.test-fixtures";
import { Admission } from "../auth/admission";
import { Sessions } from "../auth/session";
import { fullPlanner } from "../harness/atomic/full";
import { ToolBoundaryError } from "../harness/remote/link";
import { createHumanInput, PendingInputs } from "../harness/atomic/human-input";
import { forgetWorkspaces } from "../harness/atomic/workspace";
import { openPlannerSession } from "../harness/session";
import * as Plan from "../plan/service";
import * as Questions from "../questions/service";
import { member } from "../questions/text-response.test-fixtures";
import { MemoryStorage } from "../storage/memory/adapter";
import { configured, LOCAL } from "../testing/config";
import { expectPlainStatusLines } from "../testing/plain-words";
import * as Chat from "./service";

import type { Server } from "bun";
import type { ActiveOwnerBinding } from "../agent/active-owner";
import type { Chat as Wire } from "@chopin/protocol";
import type { HostedAuth } from "../auth/routes";
import type { Config } from "../config";
import type { GitHub } from "../github/client";
import type { Socket, SocketData } from "../wire";

const ATOMIC = { HARNESS: "atomic", HARNESS_AUTH: "ai-gateway", MODEL: "stub/model" };

let cleanups: Array<() => Promise<void>> = [];
let previousState = process.env.XDG_STATE_HOME;
beforeEach(async () => {
	let state = await mkdtemp(join(tmpdir(), "chopin-invoke-state-"));
	process.env.XDG_STATE_HOME = state;
	cleanups.push(() => rm(state, { recursive: true, force: true }));
});
afterEach(async () => {
	for (let cleanup of cleanups.splice(0)) await cleanup();
	forgetWorkspaces();
	if (previousState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = previousState;
});

function grant(accessToken: string) {
	return {
		accessToken,
		accessExpiresIn: 28_800,
		refreshToken: "refresh-token",
		refreshExpiresIn: 86_400,
	};
}

async function setup(config: Config = { agent: true } as Config) {
	let now = new Date();
	let storage = new MemoryStorage();
	let user = { id: "U_ana", login: "ana", avatarUrl: "" };
	let bob = { id: "U_bob", login: "bob", avatarUrl: "" };
	for (let person of [user, bob]) await storage.users.put({ ...person, now });
	let sessions = new Sessions(storage, false);
	let login = await sessions.issue(user.id, grant("browser-token"));
	let repository = { id: "R_score", owner: "octo-org", name: "score", defaultBranch: "main" };
	let github = {
		repositoryAccess: async () => ({
			...repository,
			permissions: { push: true, pull: true, admin: false },
		}),
	} as unknown as GitHub;
	let authConfig = {
		origin: "http://localhost:8795",
		appSlug: "test",
		clientId: "test",
		encryptionKey: new Uint8Array(32),
	};
	let auth: HostedAuth = {
		config: authConfig,
		github,
		storage,
		sessions,
		clock: () => new Date(),
		admission: new Admission(authConfig, github),
		machines: new Machines(storage, () => new Date(), {
			origin: "https://chopin.test",
			clientId: "test",
		}),
		pairings: {},
	};
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: repository.id,
		repositoryOwner: repository.owner,
		repositoryName: repository.name,
		title: "Document",
		createdBy: user.id,
		now,
	});
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let events: Array<{ kind: string; [key: string]: unknown }> = [];
	let server = {
		publish(_topic: string, message: string) {
			events.push(JSON.parse(message));
		},
	} as unknown as Server<SocketData>;
	let backend: Plan.Backend = {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	};
	let plan = await Plan.open(channel.id, backend, server);
	let owners = new ActiveOwnerBindings(auth);
	let context: Chat.Room = {
		chat: plan.chat,
		plan,
		room: channel.id,
		server,
		auth,
		repository,
		config,
		claimantSessionId: login.id,
		activeOwner: () => owners.resolve(channel.id),
		persist: () => Plan.persist(plan),
	};
	let closed = false;
	let fixture = {
		context,
		events,
		user,
		bob,
		login,
		backend,
		/** The session that owns the channel's Planner, if any. */
		owner: async () =>
			(await storage.channels.readAgent(channel.id, new Date()))?.agent?.ownerSessionId,
		async close() {
			if (closed) return;
			closed = true;
			owners.revokeAll();
			await Plan.close(plan);
		},
	};
	cleanups.push(fixture.close);
	return fixture;
}

type Seen = {
	owner: string;
	full: ReturnType<typeof fullPlanner>;
	instructions: string;
	prompt: string;
	visual: boolean;
	tools: readonly string[];
};

test("withholds a fragmented Chat question and repairs within the same Planner session", async () => {
	let { context, events } = await setup();
	let prompts: string[] = [];
	let checked: string[] = [];
	context.decide = async request => {
		let text = (request.state as { reply: string }).reply;
		checked.push(text);
		return {
			model: "test/classifier",
			answers: { input: { type: "noul", noul: checked.length === 1 ? 1 : 0 } },
			usage: { input_tokens: 0, output_tokens: 0 },
			latencyMs: 0,
		};
	};
	let session = {
		async stream(prompt: string) {
			prompts.push(prompt);
			return {
				fullStream: (async function*() {
					yield { type: "text-start", id: "reply" };
					for (
						let text of prompts.length === 1
							? ["What are you ", "trying to accomplish?"]
							: ["I updated the document."]
					) {
						yield { type: "text-delta", id: "reply", text };
					}
					yield { type: "text-end", id: "reply" };
				})(),
			} as never;
		},
		async destroy() {},
	};
	context.openPlannerSession = async () => ({ ok: true, value: session });
	await browserTurn(context, "Help me draft a new plan.");
	expect(events.some(event => JSON.stringify(event).includes("trying to accomplish"))).toBe(false);
	expect(
		context.chat.entries.filter(entry => entry.author.kind === "agent").map(entry => entry.text),
	)
		.toContain("I updated the document.");
	expect(checked).toEqual(["What are you trying to accomplish?", "I updated the document."]);
	expect(prompts).toHaveLength(2);
	expect(prompts[1]).toContain("inline decision cards");
});

test.each(["new", "existing", "unanchored", "replayed", "changed", "discarded", "discarded-new"])(
	"a rejected reply reports only durable captures the turn made or repeated (%s)",
	async kind => {
		let { context } = await setup();
		let options = {
			context: { room: Chat.documentRoom(context) },
			toolCallId: "capture",
			messages: [],
		} as never;
		let saved = JSON.parse(
			await documentTools.edit_plan.execute!({
				revision: 0,
				operations: [{ op: "insert_root", source: "Today remains provisional." }],
			}, options) as string,
		);
		let block = saved.blocks[0];
		let capture = () =>
			documentTools.open_decisions.execute!({
				revision: context.plan.revision,
				questions: [{
					key: "today-value",
					header: "Useful curation",
					question: "What makes a Today suggestion useful?",
					response: "text",
					options: [],
					multiple: false,
					blocks: [{ index: block.index, digest: block.digest }],
				}],
			}, options);
		let discard = async (output: unknown) => {
			let { decisions } = JSON.parse(output as string);
			await Questions.discard(context.plan, context.server, context.room, member().ws, {
				kind: "question:discard",
				ts: 0,
				rid: "discard",
				id: decisions[0].id,
			});
		};
		if (kind === "existing" || kind === "replayed" || kind === "changed") await capture();
		// A person discarded the card the Planner is about to repeat.
		if (kind === "discarded") await discard(await capture());
		context.decide = decideReplying({ input: { type: "noul", noul: 0.19 } });
		let turns = 0;
		context.openPlannerSession = async () => ({
			ok: true,
			value: {
				async destroy() {},
				async stream() {
					if (turns++ === 0) {
						if (kind === "new" || kind === "replayed" || kind === "discarded") await capture();
						if (kind === "discarded-new") await discard(await capture());
						if (kind === "changed") {
							// The same key for another question: the new one must not be lost silently.
							await documentTools.open_decisions.execute!({
								revision: context.plan.revision,
								questions: [{
									key: "today-value",
									header: "Useful curation",
									question: "Which sources should Today draw from?",
									response: "text",
									options: [],
									multiple: false,
									blocks: [{ index: block.index, digest: block.digest }],
								}],
							}, options);
						}
						if (kind === "unanchored") {
							await documentTools.open_decision.execute!({
								revision: context.plan.revision,
								key: "today-value",
								question: "What makes a Today suggestion useful?",
							}, options);
						}
					}
					return {
						fullStream: (async function*() {
							yield { type: "text-delta", id: "reply", text: "Decisions await Save." };
						})(),
					} as never;
				},
			},
		});
		await browserTurn(context, "Help me draft Today.");
		expect(turns).toBe(2);
		let entries = context.chat.entries.map(entry => entry.text);
		expect(entries).not.toContain("Decisions await Save.");
		if (kind === "new") {
			expect(entries).toContain("Added 1 inline decision to the document.");
			expect(entries.some(text => text?.includes("could not move"))).toBe(false);
		} else if (kind === "replayed") {
			expect(entries).toContain("1 inline decision is already in the document.");
			expect(entries.some(text => text?.includes("could not move"))).toBe(false);
			expect(context.plan.records.size).toBe(1);
		} else expect(entries.some(text => text?.includes("could not move"))).toBe(true);
		if (kind === "changed") {
			expect(entries.some(text => text?.includes("already in the document"))).toBe(false);
			expect(context.plan.records.size).toBe(1);
		}
		if (kind === "discarded" || kind === "discarded-new") {
			// The person's discard stands: nothing was recreated and nothing live holds the question.
			expect(entries.some(text => text?.includes("already in the document"))).toBe(false);
			expect(entries.some(text => text?.startsWith("Added"))).toBe(false);
			expect([...context.plan.records.values()].map(record => record.status)).toEqual([
				"discarded",
			]);
			expect(context.plan.questions.open.size).toBe(0);
		}
	},
);

/** The real session opener, over a harness stub that records what each turn runs with. */
function observe(context: Chat.Room): Seen[] {
	let seen: Seen[] = [];
	context.openPlannerSession = async (owner, channel) => {
		let result = await openPlannerSession(owner, channel, {
			githubTools: async () => ({ ok: true, value: {} }),
			createSandbox: async () => ({ destroy: async () => {} }) as never,
			registerCredential: () => () => {},
			agent: {
				createSession: async ({ sessionId }: { sessionId: string }) => ({
					sessionId,
					destroy: async () => {},
				}),
				stream: async (call: {
					session: { sessionId: string };
					prompt: string;
					options: { instructions: string };
				}) => {
					seen.push({
						owner: owner.ownerSessionId,
						full: fullPlanner(call.session.sessionId),
						instructions: call.options.instructions,
						prompt: call.prompt,
						visual: !!channel.room.visual,
						tools: context.chat.agent?.activeTools ?? [],
					});
					return { fullStream: (async function*() {})() };
				},
			} as never,
		});
		if (!result.ok) throw "cause" in result.error ? result.error.cause : result.error;
		return result;
	};
	return seen;
}

async function checkout(origin: string): Promise<string> {
	let root = await mkdtemp(join(tmpdir(), "chopin-invoke-checkout-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	for (let args of [["init", "--quiet"], ["remote", "add", "origin", origin]]) {
		let git = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
		expect(await git.exited).toBe(0);
	}
	return realpath(root);
}

/** A browser member's `@chopin` message, through the ordinary composer path. */
async function browserTurn(context: Chat.Room, text: string) {
	let ws = { data: { handle: "ana", principalId: "U_ana" }, send() {} } as unknown as Socket;
	await Chat.send(context, ws, {
		kind: "chat:send",
		rid: "send",
		requestId: crypto.randomUUID(),
		to: "planner",
		text,
		ts: 0,
	} as never);
	await context.chat.running;
}

test("visual routing only attaches to bounded member turns on disposable harnesses", async () => {
	for (let harness of ["copilot-sdk", "atomic"]) {
		let { context } = await setup(configured({
			HARNESS: harness,
			HARNESS_AUTH: "ai-gateway",
			MODEL: "stub/model",
			PLANNER_VISUALS: "on",
			JEV_API_KEY: "test-key",
		}));
		context.decide = decideReplying({});
		let seen = observe(context);
		await browserTurn(context, "Explain the process.");
		await browserTurn(context, "A".repeat(1_001));
		await Chat.instruct(context, "ana", "Apply the accepted comment.", "Comment accepted.");
		await context.chat.running;
		expect(seen).toHaveLength(3);
		for (let [index, turn] of seen.entries()) {
			let routed = harness !== "atomic" && index === 0;
			expect(turn.visual).toBe(routed);
			expect(turn.tools.includes("assess_visual")).toBe(routed);
			expect(turn.instructions.includes("call assess_visual")).toBe(routed);
		}
	}
});

test("an invoked instruction persists verbatim as a member message before publication and returns before the turn", async () => {
	let { context, events, user } = await setup();
	let saved = Promise.withResolvers<void>();
	let persist = context.persist;
	context.persist = async () => {
		await saved.promise;
		await persist();
	};
	let finished = Promise.withResolvers<void>();
	let opened = Promise.withResolvers<void>();
	let seen: string[] = [];
	context.openPlannerSession = async () => ({
		ok: true,
		value: {
			async stream(prompt) {
				seen.push(prompt);
				opened.resolve();
				return {
					fullStream: (async function*() {
						await finished.promise;
						yield { type: "finish" };
					})(),
				} as never;
			},
			destroy: async () => {},
		},
	});
	try {
		let posting = Chat.invoke(context, user, "  @chopin Plan this.\n");
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(events).toEqual([]);
		expect(seen).toEqual([]);
		saved.resolve();
		expect(await posting).toBeUndefined();
		await opened.promise;
		expect(context.chat.busy).toBe(true);
		expect(context.chat.turn?.entryOffset).toBe(1);
		expect(context.chat.entries[0]).toMatchObject({
			author: { kind: "member", handle: "ana" },
			text: "  @chopin Plan this.\n",
		});
		expect(events.some(event => event.kind === "chat:message")).toBe(true);
		expect(seen).toEqual(["@ana:   @chopin Plan this.\n"]);
		finished.resolve();
		await context.chat.running;
		expect(context.chat.busy).toBe(false);
	} finally {
		saved.resolve();
		finished.resolve();
	}
});

test("an invoking caller is introduced to the room with their picture before their message is posted", async () => {
	let { context, events, user } = await setup();
	let finished = Promise.withResolvers<void>();
	context.openPlannerSession = async () => ({
		ok: true,
		value: {
			async stream() {
				return {
					fullStream: (async function*() {
						await finished.promise;
						yield { type: "finish" };
					})(),
				} as never;
			},
			destroy: async () => {},
		},
	});
	try {
		let caller = { ...user, avatarUrl: "https://avatars.test/u/7" };
		expect(await Chat.invoke(context, caller, "Plan this.")).toBeUndefined();
		let kinds = events.map(event => event.kind);
		expect(kinds.indexOf("session:people")).toBeGreaterThanOrEqual(0);
		expect(kinds.indexOf("session:people")).toBeLessThan(kinds.indexOf("chat:message"));
		expect(events.find(event => event.kind === "session:people")).toMatchObject({
			people: [{ login: "ana", avatarUrl: "https://avatars.test/u/7" }],
		});
	} finally {
		finished.resolve();
		await context.chat.running;
	}
});

test("queued invocations post their durable message exactly once", async () => {
	let fixture = await setup();
	let { context, user } = fixture;
	let first = Promise.withResolvers<void>();
	let opened = Promise.withResolvers<void>();
	let prompts: string[] = [];
	context.openPlannerSession = async () => ({
		ok: true,
		value: {
			async stream(prompt) {
				prompts.push(prompt);
				opened.resolve();
				return {
					fullStream: (async function*() {
						await first.promise;
						yield { type: "finish" };
					})(),
				} as never;
			},
			destroy: async () => {},
		},
	});
	try {
		await Chat.invoke(context, user, "First");
		await opened.promise;
		await Chat.invoke(context, user, "Second");
		await Chat.invoke(context, user, "Second");
		expect(context.chat.waiting.map(item => item.text)).toEqual(["Second", "Second"]);
		expect(context.chat.entries.map(entry => entry.text)).toEqual(["First", "Second", "Second"]);
		expect(new Set(context.chat.entries.map(entry => entry.id)).size).toBe(3);
		first.resolve();
		await context.chat.running;
		expect(prompts).toEqual(["@ana: First", "@ana: Second", "@ana: Second"]);
		expect(context.chat.entries.map(entry => entry.text)).toEqual(["First", "Second", "Second"]);
		expect(context.chat.waiting).toEqual([]);
		expect(context.chat.busy).toBe(false);
		await fixture.close();
		let restored = await Plan.open(context.room, fixture.backend, context.server);
		expect(restored.chat.entries.map(entry => entry.text)).toEqual(["First", "Second", "Second"]);
		await Plan.close(restored);
	} finally {
		first.resolve();
	}
});

test("a child document's Planner cannot be invoked, so its Chat stays empty", async () => {
	let { context, user } = await setup();
	context.rootChannelId = crypto.randomUUID();
	expect(await Chat.invoke(context, user, "Review")).toBe("planner-unavailable");
	expect(context.chat.entries).toEqual([]);
	expect(context.chat.busy).toBe(false);
});

test("an invoked instruction with focus names the child in its turn", async () => {
	let { context, user } = await setup();
	let seen = observe(context);
	let focus = { channelId: "0f5b2c1e-8d3a-4b6f-9a21-7c4e5d6f7a8b", title: "Source review" };
	expect(await Chat.invoke(context, user, "Summarize the open findings.", undefined, focus))
		.toBeUndefined();
	await context.chat.running;
	expect(seen[0]!.prompt).toContain(`child id ${focus.channelId}`);
});

test("failed persistence, an unavailable Planner and a full queue start no invoked turn", async () => {
	let { context, events, user } = await setup();
	context.config.agent = false;
	expect(await Chat.invoke(context, user, "Review")).toBe("planner-unavailable");
	context.config.agent = true;
	context.chat.busy = true;
	context.chat.waiting = Array.from(
		{ length: 20 },
		(_, index) => ({ id: String(index), handle: "ana", text: "Waiting" }),
	);
	expect(await Chat.invoke(context, user, "Review")).toBe("planner-queue-full");
	context.chat.waiting = [];
	context.chat.busy = false;
	context.persist = async () => {
		throw new Error("storage failed");
	};
	await expect(Chat.invoke(context, user, "Review")).rejects.toThrow("storage failed");
	expect(context.chat.entries).toEqual([]);
	expect(events).toEqual([]);
	expect(context.chat.running).toBeUndefined();
});

test("an invocation runs under the channel's existing owner and is attributed to its caller", async () => {
	let fixture = await setup();
	let { context, user, bob } = fixture;
	let owner = await context.auth.sessions.issue(bob.id, grant("bob-token"));
	await Chat.resolveOwner(context.auth, context.repository, context.room, owner.id);
	let seen = observe(context);
	for (let claimant of [undefined, fixture.login.id]) {
		expect(await Chat.invoke({ ...context, claimantSessionId: claimant }, user, "Review"))
			.toBeUndefined();
		await context.chat.running;
	}
	expect(seen.map(turn => ({ owner: turn.owner, prompt: turn.prompt }))).toEqual([
		{ owner: owner.id, prompt: "@ana: Review" },
		{ owner: owner.id, prompt: "@ana: Review" },
	]);
	expect(context.chat.entries.filter(entry => entry.author.kind === "member")).toMatchObject([
		{ author: { kind: "member", handle: "ana" }, text: "Review" },
		{ author: { kind: "member", handle: "ana" }, text: "Review" },
	]);
	expect(await fixture.owner()).toBe(owner.id);
});

test("without an owner the caller's live login claims the Planner, and without either nothing starts", async () => {
	let fixture = await setup();
	let { context, events, user } = fixture;
	let seen = observe(context);
	expect(await Chat.invoke({ ...context, claimantSessionId: undefined }, user, "Review"))
		.toBe("planner-owner-unavailable");
	expect(context.chat.entries).toEqual([]);
	expect(events).toEqual([]);
	expect(context.chat.running).toBeUndefined();
	expect(await fixture.owner()).toBeUndefined();
	expect(await Chat.invoke(context, user, "Review")).toBeUndefined();
	await context.chat.running;
	expect(await fixture.owner()).toBe(fixture.login.id);
	expect(seen.map(turn => turn.owner)).toEqual([fixture.login.id]);
});

test("the atomic harness verifies a checkout before posting and every later session reuses it", async () => {
	let fixture = await setup(configured(ATOMIC));
	let { context, events, user } = fixture;
	let seen = observe(context);
	let matching = await checkout("git@github.com:octo-org/score.git");
	let other = await checkout("https://github.com/octo-org/other.git");
	for (let path of [other, join(matching, "missing")]) {
		expect(await Chat.invoke(context, user, "Review", path)).toBe("checkout-unverified");
	}
	expect(context.chat.entries).toEqual([]);
	expect(events).toEqual([]);
	expect(await fixture.owner()).toBeUndefined();

	expect(await Chat.invoke(context, user, "Review", matching)).toBeUndefined();
	await context.chat.running;
	await browserTurn(context, "@chopin Continue");
	expect(await Chat.invoke(context, user, "Again", other)).toBe("checkout-unverified");
	await browserTurn(context, "@chopin Once more");
	let offsets = events.filter(event => event.kind === "chat:state" && event.busy)
		.map(event => (event.turn as Wire.Turn).entryOffset);
	// Invoked instructions post first; browser turns reserve their prompt before it is appended.
	expect(offsets).toEqual([1, 2, 3]);
	expect(seen).toHaveLength(3);
	for (let turn of seen) {
		expect(turn.full?.cwd).toBe(matching);
		expect(turn.full?.humanInput.questionnaire).toBeFunction();
		expect(turn.instructions).toContain(`${matching}, is a local checkout of octo-org/score`);
	}
});

test("other harnesses ignore a checkout: it is neither verified, used, nor remembered", async () => {
	let { context, user } = await setup(configured());
	let seen = observe(context);
	let matching = await checkout("workgit:octo-org/score.git");
	for (let path of ["/does/not/exist", matching]) {
		expect(await Chat.invoke(context, user, "Review", path)).toBeUndefined();
		await context.chat.running;
	}
	expect(seen.map(turn => turn.full)).toEqual([undefined, undefined]);
	for (let turn of seen) expect(turn.instructions).toContain("You have no shell");
	context.config = configured(ATOMIC);
	await browserTurn(context, "@chopin Continue");
	let atomic = seen.at(-1)!.full!;
	expect(atomic.cwd).not.toBe(matching);
	expect(await readdir(atomic.cwd)).toEqual([]);
});

test("HARNESS=atomic runs every Planner session full in hosted and local configuration", async () => {
	for (
		let [overrides, full] of [
			[ATOMIC, true],
			[{ ...ATOMIC, ...LOCAL }, true],
			[{}, false],
			[{ ...LOCAL }, false],
		] as const
	) {
		let { context, user } = await setup(configured(overrides));
		let seen = observe(context);
		expect(await Chat.invoke(context, user, "Review")).toBeUndefined();
		await context.chat.running;
		await browserTurn(context, "@chopin Continue");
		expect(seen).toHaveLength(2);
		for (let turn of seen) {
			let harness = context.config.harness;
			expect({ harness, full: !!turn.full }).toEqual({ harness, full });
			expect(!!turn.full?.humanInput).toBe(full);
			expect(turn.instructions.includes("a withdrawn question is not an answer or approval")).toBe(
				full,
			);
		}
	}
});

type Runs = { active: string[]; paused: string[]; cards: Wire.Run[] };

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function card(status: Wire.Run["status"]): Wire.Run {
	let ended = status === "finished" || status === "failed" || status === "stopped";
	return {
		id: "run-1",
		name: "plan-review",
		status,
		started: 1_000,
		updated: 1_600,
		...(ended ? { ended: 1_600 } : {}),
		stages: [{
			id: "run-1:draft",
			name: "draft-1",
			status: status === "waiting" ? "awaiting_input" : ended ? "completed" : "running",
			started: 1_000,
		}],
		waiting: status === "waiting" ? 1 : 0,
	};
}

/** A Planner session that owns workflow runs, driven by the test. */
function runningSession(initial?: Runs) {
	let runs: Runs = initial ?? { active: ["run-1"], paused: [], cards: [card("running")] };
	let listeners = new Set<(runs: Runs) => void>();
	let calls: string[] = [];
	let session = {
		async stream(prompt: string) {
			calls.push(`stream ${prompt}`);
			return {
				fullStream: (async function*() {
					yield { type: "finish" };
				})(),
			} as never;
		},
		async destroy() {
			calls.push("destroy");
		},
		runs: () => runs,
		watchRuns(listener: (runs: Runs) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async pauseRuns() {
			calls.push("pause");
		},
		async resumeRuns() {
			calls.push("resume");
		},
		async pauseRun(runId: string) {
			calls.push(`pause ${runId}`);
		},
		async resumeRun(runId: string) {
			calls.push(`resume ${runId}`);
		},
	};
	return {
		session,
		calls,
		set(next: Runs) {
			runs = next;
			for (let listener of listeners) listener(next);
		},
	};
}

test("a Planner that still owns workflow runs outlives its turn, pauses, resumes, and is let go when they finish", async () => {
	let { context, events, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	let opened = 0;
	context.openPlannerSession = async () => {
		opened++;
		return { ok: true, value: planner.session };
	};
	let holds = 0;
	context.hold = () => {
		holds++;
		return () => holds--;
	};
	let ws = { data: { handle: "ana" } } as unknown as Socket;
	let said = () => {
		expectPlainStatusLines(context.chat.entries);
		return context.chat.entries.at(-1)?.text;
	};
	let runs = () => (events.findLast(event => event.kind === "chat:state")?.runs as
		| Wire.Run[]
		| undefined);

	expect(await Chat.invoke(context, user, "Run the workflow")).toBeUndefined();
	await context.chat.running;
	await tick();
	expect(planner.calls).toEqual(["stream @ana: Run the workflow"]);
	expect(context.chat.busy).toBe(false);
	expect(context.chat.runs).toEqual([card("running")]);
	expect(runs()).toEqual([card("running")]);
	expect(holds).toBe(1);

	await Chat.abort(context, ws);
	expect(planner.calls.at(-1)).toBe("pause");
	expect(said()).toBe("@ana stopped Chopin and paused its workflows.");
	planner.set({ active: [], paused: ["run-1"], cards: [card("paused")] });
	await tick();
	expect(runs()?.map(run => run.status)).toEqual(["paused"]);
	expect(planner.calls).not.toContain("destroy");

	await Chat.resume(context, ws);
	expect(planner.calls.at(-1)).toBe("resume");
	expect(said()).toBe("@ana resumed Chopin's workflows.");
	planner.set({ active: ["run-1"], paused: [], cards: [card("waiting")] });
	await tick();
	expect(runs()?.[0]).toMatchObject({
		status: "waiting",
		waiting: 1,
		stages: [{ status: "awaiting_input" }],
	});

	expect(await Chat.invoke(context, user, "How is it going?")).toBeUndefined();
	await context.chat.running;
	expect(opened).toBe(1);
	expect(planner.calls.filter(call => call.startsWith("stream"))).toHaveLength(2);
	expect(planner.calls).not.toContain("destroy");

	planner.set({ active: [], paused: [], cards: [card("finished")] });
	await tick();
	expect(context.chat.entries.some(entry => entry.text === "plan-review finished after 10 min."))
		.toBe(true);
	expect(planner.calls.at(-1)).toBe("destroy");
	expect(context.chat.retained).toBeUndefined();
	expect(context.chat.runs).toEqual([card("finished")]);
	expect(runs()?.map(run => run.status)).toEqual(["finished"]);
	expect(holds).toBe(0);

	await Chat.resume(context, ws);
	await Chat.abort(context, ws);
	expect(planner.calls.at(-1)).toBe("destroy");
});

test("a failed foreground turn aborts late work and releases a Planner with workflow runs", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	let signal: AbortSignal | undefined;
	planner.session.stream = async (_prompt: string, turnSignal?: AbortSignal) => {
		signal = turnSignal;
		throw new Error("The reply could not be verified.");
	};
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	expect(signal?.aborted).toBe(true);
	expect(planner.calls).toEqual(["destroy"]);
	expect(context.chat.retained).toBeUndefined();
	expect(context.chat.busy).toBe(false);
	expect(context.chat.entries.at(-1)?.text).toBe("The reply could not be verified.");
});

test("a reply that cannot move its questions into decisions fails the turn but keeps the workflow session, its run and its open question past 30 minutes", async () => {
	let { context, user, backend } = await setup(configured(ATOMIC));
	let began = Math.floor(Date.now() / 1000);
	let planner = runningSession({
		active: ["run-1"],
		paused: [],
		cards: [{ ...card("waiting"), started: began, updated: began }],
	});
	let withdrawn = new AbortController();
	let destroy = planner.session.destroy;
	planner.session.destroy = async () => {
		withdrawn.abort();
		await destroy();
	};
	let opened = 0;
	context.decide = decideReplying({ input: { type: "noul", noul: 1 } });
	context.openPlannerSession = async () => {
		opened++;
		return { ok: true, value: planner.session };
	};
	try {
		await Chat.invoke(context, user, "Run the workflow");
		await context.chat.running;
		let asked = createHumanInput(Chat.documentRoom(context)).questionnaire({
			questions: [{
				header: "Scope",
				question: "Which scope should the plan cover?",
				options: [{ label: "Narrow", description: "" }, { label: "Broad", description: "" }],
			}],
		}, { signal: withdrawn.signal } as never);
		let record = () =>
			[...context.plan.records.values()].find(value => value.status !== "answered");
		for (let attempt = 0; attempt < 20 && !record(); attempt++) await tick();
		expect(record()?.status).toBe("open");

		await backend.storage.leases.renew(backend.lease()!, 2 * 3_600_000);
		setSystemTime(new Date(Date.now() + 31 * 60_000));
		let stream = planner.session.stream;
		planner.session.stream = async () =>
			({
				fullStream: (async function*() {
					yield { type: "text-start", id: "reply" };
					yield { type: "text-delta", id: "reply", text: "Which scope should the plan cover?" };
					yield { type: "text-end", id: "reply" };
				})(),
			}) as never;
		await Chat.invoke(context, user, "Any news?");
		await context.chat.running;
		await tick();
		let said = () => context.chat.entries.map(entry => entry.text);
		expect(said().some(text => text.includes("could not move its questions"))).toBe(true);
		expect(said()).not.toContain("Which scope should the plan cover?");
		expect(planner.calls).not.toContain("destroy");
		expect(context.chat.retained).toBeDefined();
		expect(context.chat.runs?.map(run => run.status)).toEqual(["waiting"]);
		expect(said().some(text => text.includes("was stopped"))).toBe(false);
		expect(record()?.status).toBe("open");
		expect(withdrawn.signal.aborted).toBe(false);

		planner.session.stream = stream;
		await Chat.invoke(context, user, "Any news now?");
		await context.chat.running;
		expect(opened).toBe(1);
		expect(record()?.status).toBe("open");

		await context.chat.retained?.release();
		expect((await asked).cancelled).toBe(true);
		expect(context.chat.runs?.map(run => run.status)).toEqual(["stopped"]);
		expect(said().filter(text => text === "plan-review was stopped after 31 min.")).toHaveLength(1);
	} finally {
		setSystemTime();
	}
});

/**
 * A Planner whose only open work is a question it asked, with no workflow run reported: the
 * session's own signal ends with the session, as a host tool's does under Atomic.
 */
async function askingPlanner(kind: "refused" | "settled" = "refused") {
	let fixture = await setup(configured(ATOMIC));
	let { context } = fixture;
	let inputs = new PendingInputs();
	let planner = runningSession({ active: [], paused: [], cards: [] });
	Object.assign(planner.session, { inputs });
	let withdrawn = new AbortController();
	let destroy = planner.session.destroy;
	planner.session.destroy = async () => {
		withdrawn.abort();
		await destroy();
	};
	let asked: Promise<{ cancelled: boolean }> | undefined;
	let streams = 0;
	planner.session.stream = async () => {
		if (streams++ === 0) {
			asked = createHumanInput(Chat.documentRoom(context), undefined, undefined, inputs)
				.questionnaire({
					questions: [{
						header: "Scope",
						question: "Which scope should the plan cover?",
						options: [{ label: "Narrow", description: "" }, { label: "Broad", description: "" }],
					}],
				}, { signal: withdrawn.signal } as never);
			for (let attempt = 0; attempt < 20 && !context.plan.records.size; attempt++) await tick();
		}
		return {
			fullStream: (async function*() {
				if (kind === "settled") return;
				yield { type: "text-start", id: "reply" };
				yield { type: "text-delta", id: "reply", text: "Which scope should the plan cover?" };
				yield { type: "text-end", id: "reply" };
			})(),
		} as never;
	};
	context.decide = decideReplying({ input: { type: "noul", noul: 1 } });
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	return {
		...fixture,
		planner,
		withdrawn,
		asked: () => asked!,
		status: () => [...context.plan.records.values()].map(record => record.status),
	};
}

test("a refused reply keeps a Planner that only waits on a question it asked, however long nobody answers, and lets it go once that ends", async () => {
	let { context, user, backend, planner, withdrawn, asked, status } = await askingPlanner();
	try {
		await Chat.invoke(context, user, "Plan it");
		await context.chat.running;
		await tick();
		let said = () => context.chat.entries.map(entry => entry.text);
		expect(said().some(text => text.includes("could not move its questions"))).toBe(true);
		expect(said()).not.toContain("Which scope should the plan cover?");
		expect(planner.calls).not.toContain("destroy");
		expect(withdrawn.signal.aborted).toBe(false);
		expect(context.chat.retained).toBeDefined();
		expect(status()).toEqual(["open"]);

		await backend.storage.leases.renew(backend.lease()!, 2 * 3_600_000);
		setSystemTime(new Date(Date.now() + 31 * 60_000));
		await tick();
		expect(status()).toEqual(["open"]);
		expect(planner.calls).not.toContain("destroy");

		// Nobody ever answered: the question ends only when its own request is withdrawn.
		withdrawn.abort();
		expect((await asked()).cancelled).toBe(true);
		for (let attempt = 0; attempt < 10 && context.chat.retained; attempt++) await tick();
		expect(context.chat.retained).toBeUndefined();
		expect(planner.calls.at(-1)).toBe("destroy");
	} finally {
		setSystemTime();
	}
});

test("a Planner that ended its turn with a question still open is kept, not only after a refused reply", async () => {
	let { context, user, planner, withdrawn, status } = await askingPlanner("settled");
	await Chat.invoke(context, user, "Plan it");
	await context.chat.running;
	await tick();
	expect(planner.calls).not.toContain("destroy");
	expect(withdrawn.signal.aborted).toBe(false);
	expect(status()).toEqual(["open"]);
	expect(context.chat.retained).toBeDefined();
});

test("an explicit Stop, and the document closing, still end a Planner that waits on a question", async () => {
	for (let ending of ["stop", "close"] as const) {
		let { context, user, planner, withdrawn, asked, status } = await askingPlanner();
		await Chat.invoke(context, user, "Plan it");
		await context.chat.running;
		await tick();
		expect(context.chat.retained).toBeDefined();
		expect(status()).toEqual(["open"]);
		if (ending === "stop") {
			await Chat.abort(context, { data: { handle: "ana" } } as unknown as Socket);
			expect(context.chat.entries.at(-1)?.text).toBe(
				"@ana stopped Chopin and withdrew its open question.",
			);
		} else await Chat.close(context.chat);
		expect(withdrawn.signal.aborted).toBe(true);
		expect((await asked()).cancelled).toBe(true);
		expect(planner.calls).toContain("destroy");
		expect(context.chat.retained).toBeUndefined();
		expect(status()).toEqual(["cancelled"]);
	}
});

test("an explicit Stop leaves a Planner whose workflows are paused and whose question is open as it was, so the workflows can still resume", async () => {
	let { context, user, planner, withdrawn, status } = await askingPlanner("settled");
	let ws = { data: { handle: "ana" } } as unknown as Socket;
	await Chat.invoke(context, user, "Plan it");
	await context.chat.running;
	await tick();
	expect(status()).toEqual(["open"]);
	// A run it owns was paused, and untilUnpaused holds its question open with it.
	planner.set({ active: [], paused: ["run-1"], cards: [card("paused")] });
	await tick();
	let spoken = context.chat.entries.length;

	await Chat.abort(context, ws);
	expect(planner.calls).not.toContain("destroy");
	expect(withdrawn.signal.aborted).toBe(false);
	expect(context.chat.retained).toBeDefined();
	expect(status()).toEqual(["open"]);
	expect(context.chat.runs?.map(run => run.status)).toEqual(["paused"]);
	expect(context.chat.entries).toHaveLength(spoken);

	await Chat.resume(context, ws);
	expect(planner.calls.at(-1)).toBe("resume");
	expect(context.chat.entries.at(-1)?.text).toBe("@ana resumed Chopin's workflows.");
});

test("a turn the Planner's dropped link ended keeps the session whose client may return, and lets it go for good once the link is given up", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let began = Math.floor(Date.now() / 1000) - 31 * 60;
	let planner = runningSession({
		active: ["run-1"],
		paused: [],
		cards: [{ ...card("waiting"), started: began, updated: began }],
	});
	let suspended = true;
	Object.assign(planner.session, { suspended: () => suspended });
	planner.session.stream = async () => {
		throw new Error("The machine disconnected during the turn.");
	};
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	await tick();
	let said = () => context.chat.entries.map(entry => entry.text);
	expect(said()).toContain(
		"The machine's connection dropped during this reply. Its workflows and open questions are kept; ask again once it has reconnected.",
	);
	expect(planner.calls).not.toContain("destroy");
	expect(context.chat.retained).toBeDefined();
	expect(context.chat.runs?.map(run => run.status)).toEqual(["waiting"]);
	expect(said().some(text => text.includes("was stopped"))).toBe(false);

	// The client never came back: the link's end reports its runs stopped, and the session goes.
	suspended = false;
	let ended = Math.floor(Date.now() / 1000);
	planner.set({
		active: [],
		paused: [],
		cards: [{ ...card("stopped"), started: began, updated: ended, ended }],
	});
	for (let attempt = 0; attempt < 10 && context.chat.retained; attempt++) await tick();
	expect(context.chat.retained).toBeUndefined();
	expect(planner.calls.at(-1)).toBe("destroy");
	expect(context.chat.runs?.map(run => run.status)).toEqual(["stopped"]);
});

test("a run that outlives a refused reply still ends as finished, never as stopped", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let began = Math.floor(Date.now() / 1000) - 31 * 60;
	let planner = runningSession({
		active: ["run-1"],
		paused: [],
		cards: [{ ...card("running"), started: began, updated: began }],
	});
	context.decide = decideReplying({ input: { type: "noul", noul: 1 } });
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	planner.session.stream = async () =>
		({
			fullStream: (async function*() {
				yield { type: "text-delta", id: "reply", text: "Tell me which scope you want." };
			})(),
		}) as never;
	await Chat.invoke(context, user, "Any news?");
	await context.chat.running;
	expect(context.chat.retained).toBeDefined();
	let ended = Math.floor(Date.now() / 1000);
	planner.set({
		active: [],
		paused: [],
		cards: [{ ...card("finished"), started: began, updated: ended, ended }],
	});
	for (let attempt = 0; attempt < 10; attempt++) await tick();
	let said = context.chat.entries.map(entry => entry.text);
	expect(said).toContain("plan-review finished after 31 min.");
	expect(said.some(text => text.includes("was stopped"))).toBe(false);
	expect(context.chat.runs?.map(run => run.status)).toEqual(["finished"]);
	expect(context.chat.retained).toBeUndefined();
});

test("an explicit Stop during a reply ends the turn and pauses the workflows, and is not reported as a failed reply", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.decide = decideReplying({ input: { type: "noul", noul: 1 } });
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	let ws = { data: { handle: "ana" } } as unknown as Socket;
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	let gate = Promise.withResolvers<void>();
	let streaming = Promise.withResolvers<AbortSignal>();
	planner.session.stream = async (_prompt: string, signal?: AbortSignal) => {
		streaming.resolve(signal!);
		return {
			fullStream: (async function*() {
				yield { type: "text-start", id: "reply" };
				yield { type: "text-delta", id: "reply", text: "Which scope should the plan cover?" };
				await gate.promise;
				yield { type: "text-end", id: "reply" };
			})(),
		} as never;
	};
	await Chat.invoke(context, user, "Any news?");
	let signal = await streaming.promise;
	await Chat.abort(context, ws);
	gate.resolve();
	await context.chat.running;
	expect(signal.aborted).toBe(true);
	expect(planner.calls).toContain("pause");
	let said = context.chat.entries.map(entry => entry.text);
	expect(said).toContain("@ana stopped Chopin and paused its workflows.");
	expect(said.some(text => text.includes("could not"))).toBe(false);
	expect(said).not.toContain("Which scope should the plan cover?");
});

test("concurrent Stop requests pause a retained Planner's workflows only once", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	let pausing = Promise.withResolvers<void>();
	let entered = Promise.withResolvers<void>();
	planner.session.pauseRuns = async () => {
		planner.calls.push("pause");
		entered.resolve();
		await pausing.promise;
	};
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	let ws = { data: { handle: "ana" } } as unknown as Socket;

	expect(await Chat.invoke(context, user, "Run the workflow")).toBeUndefined();
	await context.chat.running;
	let first = Chat.abort(context, ws);
	await entered.promise;
	let second = Chat.abort(context, ws);
	let callsBeforePauseSettled = planner.calls.filter(call => call === "pause").length;
	pausing.resolve();
	await Promise.all([first, second]);

	expect(callsBeforePauseSettled).toBe(1);
	expect(
		context.chat.entries.filter(entry =>
			entry.text === "@ana stopped Chopin and paused its workflows."
		),
	).toHaveLength(1);
});

test("Stop ignores active progress and resets for resumed or new workflow runs", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	let ws = { data: { handle: "ana" } } as unknown as Socket;
	let notices = () =>
		context.chat.entries.filter(entry =>
			entry.text === "@ana stopped Chopin and paused its workflows."
		);

	expect(await Chat.invoke(context, user, "Run the workflow")).toBeUndefined();
	await context.chat.running;
	await Chat.abort(context, ws);
	await Chat.abort(context, ws);
	expect(planner.calls.filter(call => call === "pause")).toHaveLength(1);
	expect(notices()).toHaveLength(1);

	planner.set({
		active: ["run-1"],
		paused: [],
		cards: [{ ...card("running"), updated: 1_700 }],
	});
	await Chat.abort(context, ws);
	expect(planner.calls.filter(call => call === "pause")).toHaveLength(1);
	expect(notices()).toHaveLength(1);

	planner.set({ active: [], paused: ["run-1"], cards: [card("paused")] });
	planner.set({ active: ["run-1"], paused: [], cards: [card("running")] });
	await Chat.abort(context, ws);
	expect(planner.calls.filter(call => call === "pause")).toHaveLength(2);
	expect(notices()).toHaveLength(2);

	planner.set({
		active: ["run-1", "run-2"],
		paused: [],
		cards: [card("running"), { ...card("running"), id: "run-2", name: "second-workflow" }],
	});
	await Chat.abort(context, ws);
	expect(planner.calls.filter(call => call === "pause")).toHaveLength(3);
	expect(notices()).toHaveLength(3);
});

test("Stop can retry when pausing a retained Planner's workflows fails", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	let fail = true;
	planner.session.pauseRuns = async () => {
		planner.calls.push("pause");
		if (fail) {
			fail = false;
			throw new Error("pause failed");
		}
	};
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	let ws = { data: { handle: "ana" } } as unknown as Socket;

	expect(await Chat.invoke(context, user, "Run the workflow")).toBeUndefined();
	await context.chat.running;
	await Chat.abort(context, ws);
	await Chat.abort(context, ws);
	expect(planner.calls.filter(call => call === "pause")).toHaveLength(2);
	expect(context.chat.entries.map(entry => entry.text).slice(-2)).toEqual([
		"@ana asked Chopin to stop, but its workflows could not be paused.",
		"@ana stopped Chopin and paused its workflows.",
	]);
});

test("a background job while a Planner is retained runs in its own session and leaves the retained one, and its references, alone", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	let jobSession = runningSession();
	let openedFor: Array<string | undefined> = [];
	context.openPlannerSession = async () => {
		openedFor.push(context.chat.job?.kind);
		return { ok: true, value: openedFor.length === 1 ? planner.session : jobSession.session };
	};
	expect(await Chat.invoke(context, user, "Run the workflow")).toBeUndefined();
	await context.chat.running;
	await new Promise(resolve => setTimeout(resolve, 0));
	let retained = context.chat.retained;
	expect(retained?.session).toBe(planner.session);
	let mentioned = { id: "ref-1" } as never;
	context.chat.referenceCache.set("ref-1", mentioned);

	await Chat.job(
		context,
		{
			id: "refine:W1:m1",
			kind: "refine",
			target: "W1",
			trigger: "m1",
			status: "running",
			attempts: 0,
			at: "2026-09-25T10:00:00.000Z",
		},
		"JOB PROMPT",
		context.claimantSessionId ?? "session",
	);
	await new Promise(resolve => setTimeout(resolve, 0));

	expect(openedFor).toEqual([undefined, "refine"]);
	expect(planner.calls).toEqual(["stream @ana: Run the workflow"]);
	expect(jobSession.calls).toEqual(["stream JOB PROMPT", "destroy"]);
	expect(context.chat.retained).toBe(retained);
	expect(context.chat.agent).toBe(planner.session);
	expect(context.chat.referenceCache.get("ref-1")).toBe(mentioned);
});

test("a retained Planner is let go when its owner's binding ends, and sessions without runs still end with their turn", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	let bindings: ActiveOwnerBinding[] = [];
	let resolve = context.activeOwner!;
	context.activeOwner = async () => {
		let binding = await resolve();
		if (binding) bindings.push(binding);
		return binding;
	};
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	expect(await Chat.invoke(context, user, "Run the workflow")).toBeUndefined();
	await context.chat.running;
	expect(context.chat.retained).toBeDefined();
	bindings[0]!.release();
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(context.chat.retained).toBeUndefined();
	expect(planner.calls.at(-1)).toBe("destroy");

	let quiet = {
		...runningSession().session,
		runs: (): Runs => ({ active: [], paused: [], cards: [] }),
	};
	let destroyed = 0;
	quiet.destroy = async () => {
		destroyed++;
	};
	context.openPlannerSession = async () => ({ ok: true, value: quiet });
	expect(await Chat.invoke(context, user, "Just answer")).toBeUndefined();
	await context.chat.running;
	expect(destroyed).toBe(1);
	expect(context.chat.retained).toBeUndefined();
});

test("run cards keep ended runs until a new run starts, and a released session's live runs become stopped", () => {
	let live = card("running");
	let done = { ...card("finished"), id: "run-0" };
	expect(Chat.mergeRuns([done], [live], 2_000)).toEqual([live]);
	expect(Chat.mergeRuns([done, live], [card("waiting")], 2_000)).toEqual([done, card("waiting")]);
	let released = Chat.mergeRuns([done, card("waiting")], undefined, 2_000);
	expect(released.map(run => [run.id, run.status, run.waiting])).toEqual([
		["run-0", "finished", 0],
		["run-1", "stopped", 0],
	]);
	expect(released[1]?.ended).toBe(2_000);
	expect(Chat.mergeRuns([{ ...card("paused"), ended: undefined }], undefined, 2_000)[0])
		.toMatchObject({ status: "stopped", ended: 2_000 });
	expect(Chat.restoreRuns([])).toBeUndefined();
});

function longCard(count: number, status: Wire.Run["status"] = "running"): Wire.Run {
	return {
		...card(status),
		stages: Array.from({ length: count }, (_, index) => ({
			id: `run-1:s${index}`,
			name: `stage ${index}`,
			status: "completed" as const,
			started: 1_000 + index,
			ended: 1_001 + index,
		})),
	};
}

test("every stage of a run is stored while Chat's card carries only its latest ones", async () => {
	let { context, events, user, backend } = await setup(configured(ATOMIC));
	let planner = runningSession({ active: ["run-1"], paused: [], cards: [longCard(500)] });
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	let stored = async (offset = 0, limit = 1_000) =>
		await context.auth.storage.runStages.list(context.room, "run-1", { offset, limit });
	let shown = () => events.findLast(event => event.kind === "chat:state")?.runs as Wire.Run[];

	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	await tick();
	expect((await stored()).stages).toEqual(longCard(500).stages);
	expect(context.chat.runs?.[0]?.stages.map(stage => stage.name)).toEqual(
		Array.from({ length: 12 }, (_, index) => `stage ${488 + index}`),
	);
	expect(context.chat.runs?.[0]?.earlierStages).toBe(488);
	expect(shown()[0]).toEqual(context.chat.runs![0]!);

	// A failed early stage stops its unfinished descendant on the card, though it is not listed.
	let next = longCard(501);
	next.stages[3] = { ...next.stages[3]!, status: "failed" };
	next.stages[500] = {
		id: "run-1:late",
		name: "late",
		status: "running",
		parentIds: ["run-1:s3"],
	};
	planner.set({ active: ["run-1"], paused: [], cards: [next] });
	await tick();
	await tick();
	expect((await stored(3, 1)).stages[0]?.status).toBe("failed");
	expect((await stored(500, 1)).stages[0]).toEqual(next.stages[500]!);
	expect((await stored()).total).toBe(501);
	expect(context.chat.runs?.[0]?.stages.at(-1)).toEqual({
		...next.stages[500]!,
		status: "stopped",
	});
	expect(context.chat.runs?.[0]?.earlierStages).toBe(489);

	// The stored stages and the card survive closing and reopening the document.
	planner.set({ active: [], paused: [], cards: [{ ...next, status: "finished", ended: 1_600 }] });
	await tick();
	await tick();
	let reopened = await Plan.open(context.room, backend, context.server);
	expect(reopened.chat.runs?.[0]).toMatchObject({ status: "finished", earlierStages: 489 });
	expect((await stored()).total).toBe(501);
	await Plan.close(reopened);
});

test("a run that replaces an ended card takes that card's stored stages with it", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession({ active: [], paused: [], cards: [longCard(20, "finished")] });
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	await tick();
	let page = { offset: 0, limit: 100 };
	expect((await context.auth.storage.runStages.list(context.room, "run-1", page)).total).toBe(20);
	let fresh = runningSession({
		active: ["run-2"],
		paused: [],
		cards: [{ ...longCard(13), id: "run-2" }],
	});
	context.openPlannerSession = async () => ({ ok: true, value: fresh.session });
	await Chat.invoke(context, user, "Run another");
	await context.chat.running;
	await tick();
	await tick();
	expect(context.chat.runs?.map(run => run.id)).toEqual(["run-2"]);
	expect((await context.auth.storage.runStages.list(context.room, "run-1", page)).total).toBe(0);
	expect((await context.auth.storage.runStages.list(context.room, "run-2", page)).total).toBe(13);
});

test("a later session's stage-less card for a run keeps its stored stages, and a card with stages still replaces them", async () => {
	for (let reported of [undefined, 16]) {
		let { context, user, backend } = await setup(configured(ATOMIC));
		let first = runningSession({ active: [], paused: [], cards: [longCard(16, "finished")] });
		context.openPlannerSession = async () => ({ ok: true, value: first.session });
		await Chat.invoke(context, user, "Run the workflow");
		await context.chat.running;
		await tick();
		let stored = async () =>
			await context.auth.storage.runStages.list(context.room, "run-1", { offset: 0, limit: 100 });
		expect((await stored()).total).toBe(16);
		let window = context.chat.runs![0]!;
		expect(window.earlierStages).toBe(4);

		// A reattached Planner reports the ended run again without its stages.
		let bare: Wire.Run = {
			...card("stopped"),
			updated: 1_900,
			ended: 1_900,
			stages: [],
			...(reported ? { earlierStages: reported } : {}),
		};
		let again = runningSession({ active: [], paused: [], cards: [bare] });
		context.openPlannerSession = async () => ({ ok: true, value: again.session });
		await Chat.invoke(context, user, "Check on it");
		await context.chat.running;
		await tick();
		await tick();
		expect(await stored()).toEqual({ stages: longCard(16, "finished").stages, total: 16 });
		expect(context.chat.runs?.[0]).toEqual({
			...window,
			status: "stopped",
			updated: 1_900,
			ended: 1_900,
		});
		let reopened = await Plan.open(context.room, backend, context.server);
		expect(reopened.chat.runs?.[0]).toMatchObject({ status: "stopped", earlierStages: 4 });
		expect(reopened.chat.runs?.[0]?.stages).toEqual(window.stages);
		await Plan.close(reopened);

		let replaced = runningSession({ active: [], paused: [], cards: [longCard(13, "finished")] });
		context.openPlannerSession = async () => ({ ok: true, value: replaced.session });
		await Chat.invoke(context, user, "Run it again");
		await context.chat.running;
		await tick();
		await tick();
		expect((await stored()).total).toBe(13);
		expect(context.chat.runs?.[0]?.earlierStages).toBe(1);
	}
});

test("one run can be paused and resumed by name while others keep going", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	let ws = { data: { handle: "ana" } } as unknown as Socket;
	expect(await Chat.invoke(context, user, "Run the workflow")).toBeUndefined();
	await context.chat.running;

	await Chat.controlRun(context, ws, { kind: "chat:resume-run", runId: "run-1" });
	await Chat.controlRun(context, ws, { kind: "chat:pause-run", runId: "unknown" });
	await Chat.controlRun(context, ws, { kind: "chat:pause-run", runId: 7 });
	expect(planner.calls.filter(call => call.includes("run-1") || call.includes("unknown"))).toEqual(
		[],
	);

	await Chat.controlRun(context, ws, { kind: "chat:pause-run", runId: "run-1" });
	expect(planner.calls.at(-1)).toBe("pause run-1");
	expect(context.chat.entries.at(-1)?.text).toBe("@ana paused plan-review.");
	planner.set({ active: [], paused: ["run-1"], cards: [card("paused")] });
	await Chat.controlRun(context, ws, { kind: "chat:resume-run", runId: "run-1" });
	expect(planner.calls.at(-1)).toBe("resume run-1");
	expect(context.chat.entries.at(-1)?.text).toBe("@ana resumed plan-review.");
});

const finishLine = (name = "plan-review") => `${name} finished after 10 min.`;
const spoken = (context: Chat.Room, text: string) =>
	context.chat.entries.filter(entry => entry.text === text).length;

test("a workflow update that cannot be saved announces neither its card nor its finish message", async () => {
	let { context, events, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	let failing = false;
	let persist = context.persist;
	context.persist = async () => {
		if (failing) throw new Error("storage failed");
		await persist();
	};
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	await tick();
	let announced = events.length;
	failing = true;
	planner.set({ active: [], paused: [], cards: [card("finished")] });
	await tick();
	expect(events.length).toBe(announced);
	expect(spoken(context, finishLine())).toBe(0);
	expect(context.chat.runs).toEqual([card("running")]);
});

test("overlapping workflow reports whose first save fails still save and announce the finish message with its card", async () => {
	let { context, events, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	let gate: PromiseWithResolvers<void> | undefined;
	let failing = false;
	let saved: Array<{ runs: string[]; finish: number }> = [];
	let persist = context.persist;
	context.persist = async () => {
		if (gate) {
			let held = gate;
			gate = undefined;
			await held.promise;
			if (failing) throw new Error("storage failed");
		}
		await persist();
		saved.push({
			runs: (context.chat.runs ?? []).map(run => `${run.id}:${run.status}`),
			finish: spoken(context, finishLine()),
		});
	};
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	saved = [];
	let announced = events.length;
	let second = { ...card("running"), id: "run-2", name: "lint" };
	gate = Promise.withResolvers<void>();
	failing = true;
	let first = gate;
	planner.set({ active: ["run-1"], paused: [], cards: [card("finished")] });
	await tick();
	planner.set({ active: ["run-2"], paused: [], cards: [card("finished"), second] });
	await tick();
	first.resolve();
	await tick();
	await tick();
	for (let entry of saved) {
		if (entry.runs.includes("run-1:finished")) expect(entry.finish).toBe(1);
	}
	expect(spoken(context, finishLine())).toBe(1);
	expect(context.chat.runs?.map(run => `${run.id}:${run.status}`)).toEqual([
		"run-1:finished",
		"run-2:running",
	]);
	let said = events.slice(announced).filter(event =>
		event.kind === "chat:message" && (event.entry as Wire.Entry).text === finishLine()
	);
	expect(said).toHaveLength(1);
});

test("a quick job that ended before the reply finished keeps its card and one finish message", async () => {
	let { context, events, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	let quick: Runs = { active: [], paused: [], cards: [card("finished")] };
	planner.session.runs = () => quick;
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	expect(context.chat.runs).toEqual([card("finished")]);
	expect(spoken(context, finishLine())).toBe(1);
	expect(events.findLast(event => event.kind === "chat:state")?.runs).toEqual([
		card("finished"),
	]);
	expect(context.chat.retained).toBeUndefined();
	expect(planner.calls.at(-1)).toBe("destroy");
});

test("a run first reported as ended gets one finish message and never a repeat", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	let other = { ...card("failed"), id: "run-2", name: "lint" };
	planner.set({ active: ["run-1"], paused: [], cards: [other] });
	await tick();
	expect(spoken(context, "lint failed after 10 min.")).toBe(1);
	planner.set({ active: ["run-1"], paused: [], cards: [other, card("running")] });
	planner.set({ active: ["run-1"], paused: [], cards: [other, card("running")] });
	await tick();
	expect(spoken(context, "lint failed after 10 min.")).toBe(1);
});

test("a run that fails within the second it started is reported in seconds, not as a minute", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	let quick = { ...card("failed"), id: "run-2", name: "lint", updated: 1_000, ended: 1_000 };
	let short = { ...card("failed"), id: "run-3", name: "check", updated: 1_012, ended: 1_012 };
	planner.set({ active: ["run-1"], paused: [], cards: [quick, short] });
	await tick();
	expect(spoken(context, "lint failed after less than a second.")).toBe(1);
	expect(spoken(context, "check failed after 12 s.")).toBe(1);
	expect(context.chat.entries.some(entry => entry.text.endsWith("after 1 min."))).toBe(false);
});

test("a run reported finished before its root ended gets no finish message until it does", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	let { ended: _, ...early } = card("finished");
	planner.set({ active: [], paused: [], cards: [early] });
	planner.set({ active: ["run-1"], paused: [], cards: [card("running")] });
	await tick();
	await tick();
	expect(spoken(context, finishLine())).toBe(0);
	expect(context.chat.runs?.map(run => run.status)).toEqual(["running"]);
	expect(context.chat.retained).toBeDefined();
	planner.set({ active: [], paused: [], cards: [card("finished")] });
	await tick();
	expect(spoken(context, finishLine())).toBe(1);
});

const followUps = (calls: string[]) =>
	calls.filter(call => call.includes("plan-review (run-1) ended blocked"));

test("a run that ends blocked between turns starts one Planner turn about it before the kept session is let go", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	let opened = 0;
	context.openPlannerSession = async () => {
		opened++;
		return { ok: true, value: planner.session };
	};
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	expect(context.chat.retained).toBeDefined();
	planner.set({ active: [], paused: [], cards: [card("blocked")] });
	while (!planner.calls.includes("destroy")) await tick();
	expect(followUps(planner.calls)).toHaveLength(1);
	expect(planner.calls.indexOf(followUps(planner.calls)[0]!)).toBeLessThan(
		planner.calls.indexOf("destroy"),
	);
	expect(opened).toBe(1);
	expect(spoken(context, "plan-review ended blocked after 10 min.")).toBe(1);
	expect(context.chat.retained).toBeUndefined();
});

test("a run that ends blocked during the Planner's own turn starts no follow-up turn", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	let stream = planner.session.stream;
	planner.session.stream = async (prompt: string) => {
		planner.set({ active: [], paused: [], cards: [card("blocked")] });
		return stream(prompt);
	};
	await Chat.invoke(context, user, "Check on it");
	await context.chat.running;
	while (!planner.calls.includes("destroy")) await tick();
	expect(followUps(planner.calls)).toHaveLength(0);
	expect(spoken(context, "plan-review ended blocked after 10 min.")).toBe(1);
});

test("a remote Planner's run that ends blocked between turns starts no turn nobody asked for", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	let remote = Object.assign(planner.session, { followsUpRuns: false });
	context.openPlannerSession = async () => ({ ok: true, value: remote });
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	expect(context.chat.retained).toBeDefined();
	planner.set({ active: [], paused: [], cards: [card("blocked")] });
	while (!planner.calls.includes("destroy")) await tick();
	expect(followUps(planner.calls)).toHaveLength(0);
	expect(spoken(context, "plan-review ended blocked after 10 min.")).toBe(1);
});

test("the last job finishing while a reply is still being saved still lets the Planner go afterwards", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	let gate: PromiseWithResolvers<void> | undefined;
	let persist = context.persist;
	context.persist = async () => {
		await gate?.promise;
		await persist();
	};
	await Chat.invoke(context, user, "Run the workflow");
	gate = Promise.withResolvers<void>();
	while (!context.chat.retained) await tick();
	expect(context.chat.busy).toBe(true);
	planner.set({ active: [], paused: [], cards: [card("finished")] });
	gate.resolve();
	await context.chat.running;
	await tick();
	expect(planner.calls).toContain("destroy");
	expect(context.chat.retained).toBeUndefined();
	expect(context.chat.agent).toBeUndefined();
	expect(context.chat.owner).toBeUndefined();
});

const shown = (frames: Array<{ [key: string]: unknown }>) =>
	JSON.stringify(frames).includes("finished");

test("a finished card and its message are not shown to anyone while their save is pending, and never if it fails", async () => {
	let { context, events, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	let gate: PromiseWithResolvers<void> | undefined;
	let persist = context.persist;
	let broken = false;
	context.persist = async (...args: Parameters<typeof persist>) => {
		if (gate) {
			let held = gate;
			gate = undefined;
			await held.promise;
		}
		if (broken && args.length) throw new Error("storage failed");
		await persist(...args);
	};
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	await tick();
	let held = Promise.withResolvers<void>();
	gate = held;
	broken = true;
	let announced = events.length;
	planner.set({ active: [], paused: [], cards: [card("finished")] });
	await tick();
	let joined: Array<{ kind: string; [key: string]: unknown }> = [];
	let ws = {
		data: { handle: "ana" },
		send: (message: string) => joined.push(JSON.parse(message)),
	} as unknown as Socket;
	Chat.greet(context.chat, ws);
	await Chat.invoke(context, user, "Any news?");
	expect(shown(joined)).toBe(false);
	expect(shown(events.slice(announced))).toBe(false);
	held.resolve();
	for (let attempt = 0; attempt < 10; attempt++) await tick();
	broken = false;
	expect(shown(events.slice(announced))).toBe(false);
	expect(spoken(context, finishLine())).toBe(0);
	expect(context.chat.runs).toEqual([card("running")]);
});

test("a transient failure saving the last run's finish report still ends with the finished card and one finish message", async () => {
	let { context, events, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	let failing = false;
	let persist = context.persist;
	context.persist = async (...args: Parameters<typeof persist>) => {
		if (failing) {
			failing = false;
			throw new Error("storage failed");
		}
		await persist(...args);
	};
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	await tick();
	failing = true;
	planner.set({ active: [], paused: [], cards: [card("finished")] });
	for (let attempt = 0; attempt < 10; attempt++) await tick();
	expect(context.chat.runs).toEqual([card("finished")]);
	expect(spoken(context, finishLine())).toBe(1);
	expect(spoken(context, "plan-review was stopped after 10 min.")).toBe(0);
	expect(context.chat.entries.some(entry => entry.text.includes("was stopped"))).toBe(false);
	expect(events.findLast(event => event.kind === "chat:state")?.runs).toEqual([
		card("finished"),
	]);
	expect(planner.calls).toContain("destroy");
	expect(context.chat.retained).toBeUndefined();
});

const stoppedLines = (context: Chat.Room) =>
	context.chat.entries.filter(entry =>
		/^plan-review was stopped after \d+ min\.$/.test(entry.text)
	);

test("releasing the helper after a failed save of a still-active report stops its card with one message", async () => {
	let { context, events, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	let failing = false;
	let persist = context.persist;
	context.persist = async (...args: Parameters<typeof persist>) => {
		if (failing) {
			failing = false;
			throw new Error("storage failed");
		}
		await persist(...args);
	};
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	await tick();
	failing = true;
	planner.set({ active: ["run-1"], paused: [], cards: [card("waiting")] });
	await tick();
	await tick();
	expect(context.chat.runs?.map(run => run.status)).toEqual(["running"]);
	await context.chat.retained?.release();
	expect(context.chat.runs?.map(run => run.status)).toEqual(["stopped"]);
	expect(stoppedLines(context)).toHaveLength(1);
	expect(context.chat.entries.filter(entry => entry.text.includes("was stopped"))).toHaveLength(1);
	expect(events.findLast(event => event.kind === "chat:state")?.runs).toEqual(context.chat.runs);
	expect(planner.calls).toContain("destroy");
	expect(context.chat.retained).toBeUndefined();
});

test("a finish report whose save and release retry both fail announces nothing, and the next report stops the orphaned card", async () => {
	let { context, events, user } = await setup(configured(ATOMIC));
	let planner = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	let failures = 0;
	let persist = context.persist;
	context.persist = async (...args: Parameters<typeof persist>) => {
		if (failures > 0) {
			failures--;
			throw new Error("storage failed");
		}
		await persist(...args);
	};
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	await tick();
	let announced = events.length;
	failures = 2;
	planner.set({ active: [], paused: [], cards: [card("finished")] });
	for (let attempt = 0; attempt < 10; attempt++) await tick();
	expect(planner.calls).toContain("destroy");
	expect(context.chat.retained).toBeUndefined();
	expect(events.length).toBe(announced);
	expect(context.chat.entries.some(entry => entry.text.includes("after 10 min."))).toBe(false);
	expect(context.chat.runs).toEqual([card("running")]);
	let idle = {
		async stream() {
			return {
				fullStream: (async function*() {
					yield { type: "finish" };
				})(),
			} as never;
		},
		async destroy() {},
		runs: () => ({ active: [], paused: [] }),
	};
	context.openPlannerSession = async () => ({ ok: true, value: idle as never });
	await Chat.invoke(context, user, "Anything new?");
	await context.chat.running;
	for (let attempt = 0; attempt < 10; attempt++) await tick();
	expect(context.chat.runs?.map(run => run.status)).toEqual(["stopped"]);
	expect(stoppedLines(context)).toHaveLength(1);
});

test("an old helper whose slow release outlasts a newer helper's whole turn still stops its own running card once", async () => {
	let { context, events, user } = await setup(configured(ATOMIC));
	let old = runningSession();
	let slow = Promise.withResolvers<void>();
	let destroy = old.session.destroy;
	old.session.destroy = async () => {
		await slow.promise;
		await destroy();
	};
	context.openPlannerSession = async () => ({ ok: true, value: old.session });
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	await tick();
	expect(context.chat.runs?.map(run => run.status)).toEqual(["running"]);
	let releasing = context.chat.retained!.release();
	expect(context.chat.retained).toBeUndefined();
	let destroyed = 0;
	let newer = {
		async stream() {
			return {
				fullStream: (async function*() {
					yield { type: "finish" };
				})(),
			} as never;
		},
		async destroy() {
			destroyed++;
		},
	};
	context.openPlannerSession = async () => ({ ok: true, value: newer as never });
	await Chat.invoke(context, user, "Any news?");
	await context.chat.running;
	await tick();
	expect(destroyed).toBe(1);
	expect(context.chat.agent).toBeUndefined();
	expect(context.chat.retained).toBeUndefined();
	expect(context.chat.runs?.map(run => run.status)).toEqual(["running"]);
	slow.resolve();
	await releasing;
	await tick();
	expect(context.chat.runs?.map(run => run.status)).toEqual(["stopped"]);
	expect(stoppedLines(context)).toHaveLength(1);
	expect(context.chat.entries.filter(entry => entry.text.includes("was stopped"))).toHaveLength(1);
	expect(context.chat.owner).toBeUndefined();
	expect(context.chat.agent).toBeUndefined();
	expect(events.findLast(event => event.kind === "chat:state")?.runs).toEqual(context.chat.runs);
});

const lint = { ...card("running"), id: "run-2", name: "lint" };
type Newer = "none" | "run-less turn" | "own runs" | "run-less turn after a failed save";
const NEWER: Newer[] = ["none", "run-less turn", "own runs", "run-less turn after a failed save"];

test.each(NEWER)(
	"releasing an old helper after %s stops exactly its own cards once",
	async newer => {
		let { context, events, user } = await setup(configured(ATOMIC));
		let old = runningSession();
		let slow = Promise.withResolvers<void>();
		let destroy = old.session.destroy;
		old.session.destroy = async () => {
			await slow.promise;
			await destroy();
		};
		context.openPlannerSession = async () => ({ ok: true, value: old.session });
		let failing = false;
		let persist = context.persist;
		context.persist = async (...args: Parameters<typeof persist>) => {
			if (failing) {
				failing = false;
				throw new Error("storage failed");
			}
			await persist(...args);
		};
		await Chat.invoke(context, user, "Run the workflow");
		await context.chat.running;
		await tick();
		if (newer.includes("failed save")) {
			failing = true;
			old.set({ active: ["run-1"], paused: [], cards: [card("waiting")] });
			await tick();
			await tick();
		}
		let releasing = context.chat.retained!.release();
		let successor = runningSession({ active: ["run-2"], paused: [], cards: [lint] });
		if (newer !== "none") {
			let helper = newer === "own runs" ? successor.session : {
				async stream() {
					return {
						fullStream: (async function*() {
							yield { type: "finish" };
						})(),
					} as never;
				},
				async destroy() {},
			};
			context.openPlannerSession = async () => ({ ok: true, value: helper as never });
			await Chat.invoke(context, user, "Any news?");
			await context.chat.running;
			await tick();
		}
		let owner = newer === "none" ? undefined : context.chat.owner;
		let agent = newer === "none" ? undefined : context.chat.agent;
		if (newer === "own runs") {
			expect(context.chat.runs?.map(run => `${run.id}:${run.status}`)).toEqual([
				"run-1:running",
				"run-2:running",
			]);
		}
		slow.resolve();
		await releasing;
		await tick();
		expect(context.chat.runs?.find(run => run.id === "run-1")?.status).toBe("stopped");
		expect(stoppedLines(context)).toHaveLength(1);
		expect(context.chat.entries.filter(entry => entry.text.includes("was stopped"))).toHaveLength(
			1,
		);
		expect(context.chat.owner).toEqual(owner);
		expect(context.chat.agent).toBe(agent);
		if (newer === "own runs") {
			expect(context.chat.runs?.find(run => run.id === "run-2")).toEqual(lint);
			expect(context.chat.runs).toHaveLength(2);
			expect(context.chat.retained?.session).toBe(successor.session as never);
			expect(owner).toBeDefined();
		} else {
			expect(context.chat.runs?.map(run => run.id)).toEqual(["run-1"]);
			expect(context.chat.owner).toBeUndefined();
		}
		expect(events.findLast(event => event.kind === "chat:state")?.runs).toEqual(context.chat.runs);
	},
);

test("an old helper's card still gets its stop message when its release could not be saved and a newer helper starts a run", async () => {
	let { context, events, user } = await setup(configured(ATOMIC));
	let old = runningSession();
	context.openPlannerSession = async () => ({ ok: true, value: old.session });
	let failing = false;
	let persist = context.persist;
	context.persist = async (...args: Parameters<typeof persist>) => {
		if (failing) {
			failing = false;
			throw new Error("storage failed");
		}
		await persist(...args);
	};
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	await tick();
	expect(context.chat.runs?.map(run => `${run.id}:${run.status}`)).toEqual(["run-1:running"]);

	failing = true;
	await context.chat.retained!.release();
	await tick();
	expect(stoppedLines(context)).toHaveLength(0);

	let successor = runningSession({ active: ["run-2"], paused: [], cards: [lint] });
	context.openPlannerSession = async () => ({ ok: true, value: successor.session });
	await Chat.invoke(context, user, "Run the lint workflow");
	await context.chat.running;
	await tick();

	expect(stoppedLines(context)).toHaveLength(1);
	expect(context.chat.runs?.find(run => run.id === "run-2")).toEqual(lint);
	expect(context.chat.runs?.some(run => run.id === "run-1" && run.status === "running")).toBe(
		false,
	);
	expect(events.findLast(event => event.kind === "chat:state")?.runs).toEqual(context.chat.runs);
});

test("a focused member turn names the child before the member's words", async () => {
	let { context } = await setup();
	let child = "0f5b2c1e-8d3a-4b6f-9a21-7c4e5d6f7a8b";
	context.children = {
		list: async () => [],
		resolve: async id => id === child ? { id, title: "Source review", createdAt: "" } : undefined,
		open: async () => {
			throw new Error("not used");
		},
	};
	let seen = observe(context);
	let ws = { data: { handle: "ana", principalId: "U_ana" }, send() {} } as unknown as Socket;
	await Chat.send(context, ws, {
		kind: "chat:send",
		rid: "send",
		requestId: crypto.randomUUID(),
		to: "planner",
		text: "@chopin shorten the summary",
		focus: child,
		ts: 0,
	} as never);
	await context.chat.running;
	expect(seen).toHaveLength(1);
	let prompt = seen[0]!.prompt;
	expect(prompt.indexOf(`child id ${child}`)).toBeGreaterThanOrEqual(0);
	expect(prompt.indexOf(`child id ${child}`)).toBeLessThan(prompt.indexOf("shorten the summary"));
	expect(context.chat.entries.find(entry => entry.author.kind === "member")?.text)
		.toBe("shorten the summary");
});

test("a focused message queued behind a busy turn still names the child when it drains", async () => {
	let { context } = await setup();
	let child = "0f5b2c1e-8d3a-4b6f-9a21-7c4e5d6f7a8b";
	context.children = {
		list: async () => [],
		resolve: async id => id === child ? { id, title: "Source review", createdAt: "" } : undefined,
		open: async () => {
			throw new Error("not used");
		},
	};
	let first = Promise.withResolvers<void>();
	let opened = Promise.withResolvers<void>();
	let prompts: string[] = [];
	context.openPlannerSession = async () => ({
		ok: true,
		value: {
			async stream(prompt) {
				prompts.push(prompt);
				opened.resolve();
				return {
					fullStream: (async function*() {
						if (prompts.length === 1) await first.promise;
						yield { type: "finish" };
					})(),
				} as never;
			},
			destroy: async () => {},
		},
	});
	let ws = { data: { handle: "ana", principalId: "U_ana" }, send() {} } as unknown as Socket;
	let send = (text: string, focus?: string) =>
		Chat.send(context, ws, {
			kind: "chat:send",
			rid: crypto.randomUUID(),
			requestId: crypto.randomUUID(),
			to: "planner",
			text,
			...(focus ? { focus } : {}),
			ts: 0,
		} as never);
	await send("@chopin first");
	await opened.promise;
	await send("@chopin shorten the summary", child);
	expect(context.chat.waiting).toHaveLength(1);
	first.resolve();
	await context.chat.running;
	expect(prompts).toHaveLength(2);
	expect(prompts[0]).not.toContain(child);
	let drained = prompts[1]!;
	expect(drained.indexOf(`child id ${child}`)).toBeGreaterThanOrEqual(0);
	expect(drained.indexOf(`child id ${child}`)).toBeLessThan(drained.indexOf("shorten the summary"));
});

function failingMemberTurn(
	context: Chat.Room,
	stream: (prompt: string) => Promise<never> | AsyncGenerator<unknown>,
) {
	let planner = runningSession();
	planner.session.stream = (async (prompt: string) => {
		let made = stream(prompt);
		return made instanceof Promise ? made : { fullStream: made };
	}) as never;
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	return planner;
}

test("a failed turn's notice says why it ended, for the member message and child that began it, and keeps saying so after a restore", async () => {
	let { context, backend } = await setup(configured(ATOMIC));
	let child = "0f5b2c1e-8d3a-4b6f-9a21-7c4e5d6f7a8b";
	context.children = {
		list: async () => [],
		resolve: async id => id === child ? { id, title: "Source review", createdAt: "" } : undefined,
		open: async () => {
			throw new Error("not used");
		},
	};
	failingMemberTurn(context, async () => {
		throw new Error("429 Too Many Requests");
	});
	let ws = { data: { handle: "ana", principalId: "U_ana" }, send() {} } as unknown as Socket;
	let requestId = crypto.randomUUID();
	await Chat.send(context, ws, {
		kind: "chat:send",
		rid: "send",
		requestId,
		to: "planner",
		text: "@chopin shorten the summary",
		focus: child,
		ts: 0,
	} as never);
	await context.chat.running;
	let notice = context.chat.entries.at(-1)!;
	expect(notice.text).toBe("429 Too Many Requests");
	expect(notice.turnFailure).toEqual({
		kind: "error",
		detail: "429 Too Many Requests",
		request: requestId,
		focus: child,
	});

	await context.persist();
	let reopened = await Plan.open(context.room, backend, context.server);
	try {
		expect(reopened.chat.entries.at(-1)?.turnFailure).toEqual(notice.turnFailure);
	} finally {
		await Plan.close(reopened);
	}
});

test("a turn the Planner's link dropped under says dropped, which a client leaves to the connection to tell", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = failingMemberTurn(context, async () => {
		throw new Error("The machine disconnected during the turn.");
	});
	Object.assign(planner.session, { suspended: () => true });
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	let notice = context.chat.entries.at(-1)!;
	expect(notice.text).toContain("connection dropped during this reply");
	expect(notice.turnFailure?.kind).toBe("dropped");
});

test("a tool that failed inside a turn that went on is no failure of the turn", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	failingMemberTurn(context, async function*() {
		yield { type: "tool-call", toolCallId: "t1", toolName: "read_plan", input: {} };
		yield { type: "tool-error", toolCallId: "t1", toolName: "read_plan", error: new Error("no") };
		yield { type: "finish" };
	} as never);
	await Chat.invoke(context, user, "Read it");
	await context.chat.running;
	expect(context.chat.entries.filter(entry => entry.turnFailure)).toEqual([]);
});

test("a tool the turn was refused ends it as refused, once, whatever else ends with it", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	failingMemberTurn(context, async function*() {
		yield { type: "tool-approval-request", approvalId: "a1", toolCall: { toolName: "bash" } };
		await new Promise(resolve => setTimeout(resolve, 20));
	} as never);
	await Chat.invoke(context, user, "Run a command");
	await context.chat.running;
	let refused = context.chat.entries.filter(entry => entry.turnFailure);
	expect(refused.map(entry => entry.turnFailure?.kind)).toEqual(["refused"]);
	expect(refused[0]!.text).toBe("Chopin's tool approval was denied.");
});

test("a tool the remote Planner used without declaring it ends the turn as a tool failure, with no boundary words in what the room is told", async () => {
	for (
		let ending of [
			async function*() {
				yield {
					type: "error",
					error: new ToolBoundaryError("Chopin's tool boundary failure: bash"),
				};
			},
			async () => {
				throw new ToolBoundaryError("Chopin's tool boundary failure: bash");
			},
		]
	) {
		let { context, user } = await setup(configured(ATOMIC));
		failingMemberTurn(context, ending as never);
		await Chat.invoke(context, user, "Run a command");
		await context.chat.running;
		let failed = context.chat.entries.filter(entry => entry.turnFailure);
		expect(failed.map(entry => entry.turnFailure?.kind)).toEqual(["tool"]);
		expect(failed[0]!.turnFailure?.detail).toBeUndefined();
		expect(failed[0]!.text).not.toMatch(/boundary|Chopin's tool/i);
		expect(failed[0]!.text).toBe("The reply stopped: a tool it needed isn't available.");
	}
});

test("an error the model's stream reports ends the turn with the words it gave, in one entry, not Chopin's own generic line", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	failingMemberTurn(context, async function*() {
		yield { type: "text-delta", id: "m", text: "Which" };
		yield { type: "error", error: new Error("429 Too Many Requests") };
	} as never);
	await Chat.invoke(context, user, "Shorten the summary");
	await context.chat.running;
	let failed = context.chat.entries.filter(entry => entry.turnFailure);
	expect(failed).toHaveLength(1);
	expect(failed[0]!.text).toBe("429 Too Many Requests");
	expect(failed[0]!.turnFailure).toMatchObject({ kind: "error", detail: "429 Too Many Requests" });
});

test("a stream that timed out ends the turn as timed out, however the harness names it, with none of its words", async () => {
	let timeout = new Error("The operation was aborted due to timeout");
	timeout.name = "TimeoutError";
	let { context, user } = await setup(configured(ATOMIC));
	failingMemberTurn(context, async function*() {
		yield { type: "error", error: timeout };
	} as never);
	await Chat.invoke(context, user, "Shorten the summary");
	await context.chat.running;
	let failed = context.chat.entries.filter(entry => entry.turnFailure);
	expect(failed.map(entry => entry.turnFailure?.kind)).toEqual(["timed-out"]);
	expect(failed[0]!.turnFailure?.detail).toBeUndefined();
});

test("a stream that stopped without saying why is a failed reply with no words repeating the banner's own", async () => {
	for (let part of [{ type: "abort" }, { type: "error", error: undefined }]) {
		let { context, user } = await setup(configured(ATOMIC));
		failingMemberTurn(context, async function*() {
			yield part;
		} as never);
		await Chat.invoke(context, user, "Shorten the summary");
		await context.chat.running;
		let failed = context.chat.entries.filter(entry => entry.turnFailure);
		expect(failed).toHaveLength(1);
		expect(failed[0]!.turnFailure?.kind).toBe("error");
		expect(failed[0]!.turnFailure?.detail).toBeUndefined();
		expect(failed[0]!.text).toBe("Chopin's reply failed. Try again.");
	}
});
