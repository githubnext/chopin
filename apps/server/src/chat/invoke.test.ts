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

test("streams a fragmented Chat question, then repairs it within the same Planner session", async () => {
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
	// The question was shown as it streamed; the check found it after it ended.
	expect(events.some(event => JSON.stringify(event).includes("trying to accomplish"))).toBe(true);
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

test("invocations while a turn runs are given to it and post their durable message exactly once", async () => {
	let fixture = await setup();
	let { context, user } = fixture;
	let first = Promise.withResolvers<void>();
	let opened = Promise.withResolvers<void>();
	let prompts: string[] = [];
	let steered: string[] = [];
	context.steers = () => true;
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
			steer: async text => {
				steered.push(text);
			},
			destroy: async () => {},
		},
	});
	try {
		await Chat.invoke(context, user, "First");
		await opened.promise;
		await Chat.invoke(context, user, "Second");
		await Chat.invoke(context, user, "Second");
		await until(() => steered.length === 2);
		expect(context.chat.waiting).toEqual([]);
		expect(context.chat.entries.map(entry => entry.text)).toEqual(["First", "Second", "Second"]);
		expect(new Set(context.chat.entries.map(entry => entry.id)).size).toBe(3);
		first.resolve();
		await context.chat.running;
		expect(prompts).toEqual(["@ana: First"]);
		expect(steered).toEqual(["@ana: Second", "@ana: Second"]);
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

/** Waits for what a detached delivery has yet to do. */
async function until(done: () => boolean): Promise<void> {
	for (let deadline = Date.now() + 2_000; !done(); await Bun.sleep(5)) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
	}
}

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

test("failed persistence, an unavailable Planner and a busy one that takes no message mid-run start no invoked turn", async () => {
	let { context, events, user } = await setup();
	context.config.agent = false;
	expect(await Chat.invoke(context, user, "Review")).toBe("planner-unavailable");
	context.config.agent = true;
	context.chat.busy = true;
	expect(await Chat.invoke(context, user, "Review")).toBe("planner-busy");
	expect(context.chat.waiting).toEqual([]);
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
		// The second turn's fresh session is told the first message before its own prompt.
		{
			owner: owner.id,
			prompt: expect.stringMatching(
				/^A fresh Planner session[\s\S]*@ana: Review\n\nThe conversation so far ends here\. The current turn follows\.\n\n@ana: Review$/,
			),
		},
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
	let busy = events.filter(event => event.kind === "chat:state" && event.busy)
		.map(event => event.turn as Wire.Turn);
	// Invoked instructions post first; browser turns reserve their prompt before it is appended.
	expect(busy.filter(turn => !turn.quiet).map(turn => turn.entryOffset)).toEqual([1, 2, 3]);
	// Each turn goes quiet once its words are all out, the same turn at the same offset.
	expect(busy.filter(turn => turn.quiet).map(turn => turn.entryOffset)).toEqual([1, 2, 3]);
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

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * A Planner session driven by the test, which waits on `open` questions it asked, the work that
 * keeps it past its turn, until `settle()` ends them.
 */
function plannerSession(open = 1) {
	let calls: string[] = [];
	let watchers = new Set<() => void>();
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
		inputs: {
			open: () => open,
			held: () => 0,
			watch(listener: () => void) {
				watchers.add(listener);
				return () => watchers.delete(listener);
			},
		},
	};
	return {
		session,
		calls,
		/** Its questions end: answered, withdrawn or given up. */
		settle() {
			open = 0;
			for (let watcher of watchers) watcher();
		},
	};
}

test("a failed foreground turn aborts late work and keeps a Planner that waits on a question until it settles", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = plannerSession();
	let signal: AbortSignal | undefined;
	planner.session.stream = async (_prompt: string, turnSignal?: AbortSignal) => {
		signal = turnSignal;
		throw new Error("The reply could not be verified.");
	};
	context.openPlannerSession = async () => ({ ok: true, value: planner.session });
	await Chat.invoke(context, user, "Run the workflow");
	await context.chat.running;
	expect(signal?.aborted).toBe(true);
	expect(planner.calls).toEqual([]);
	expect(context.chat.retained?.session).toBe(planner.session as never);
	expect(context.chat.busy).toBe(false);
	expect(context.chat.entries.at(-1)?.text).toBe("The reply could not be verified.");
	planner.settle();
	await until(() => context.chat.retained === undefined);
	expect(planner.calls).toEqual(["destroy"]);
});

test("a reply that cannot move its questions into decisions fails the turn but keeps the session and its open question past 30 minutes", async () => {
	let { context, user, backend } = await setup(configured(ATOMIC));
	let planner = plannerSession();
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
		// Both replies were shown as they streamed; the turn says it could not move the question.
		expect(said().filter(text => text === "Which scope should the plan cover?")).toHaveLength(2);
		expect(planner.calls).not.toContain("destroy");
		expect(context.chat.retained).toBeDefined();
		expect(record()?.status).toBe("open");
		expect(withdrawn.signal.aborted).toBe(false);

		planner.session.stream = stream;
		await Chat.invoke(context, user, "Any news now?");
		await context.chat.running;
		expect(opened).toBe(1);
		expect(record()?.status).toBe("open");

		await context.chat.retained?.release();
		expect((await asked).cancelled).toBe(true);
	} finally {
		setSystemTime();
	}
});

/**
 * A Planner whose only open work is a question it asked: the session's own signal ends with the
 * session, as a host tool's does under Atomic.
 */
async function askingPlanner(kind: "refused" | "settled" = "refused") {
	let fixture = await setup(configured(ATOMIC));
	let { context } = fixture;
	let inputs = new PendingInputs();
	let planner = plannerSession(0);
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
			asked = createHumanInput(Chat.documentRoom(context), undefined, inputs)
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
		// Both replies were shown as they streamed; the turn says it could not move the question.
		expect(said().filter(text => text === "Which scope should the plan cover?")).toHaveLength(2);
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
				"@ana stopped chopin and withdrew its open question.",
			);
		} else await Chat.close(context.chat);
		expect(withdrawn.signal.aborted).toBe(true);
		expect((await asked()).cancelled).toBe(true);
		expect(planner.calls).toContain("destroy");
		expect(context.chat.retained).toBeUndefined();
		expect(status()).toEqual(["cancelled"]);
	}
});

test("a turn the Planner's dropped link ended keeps the session whose client may return, and lets it go for good once the link is given up", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = plannerSession();
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
		"The machine's connection dropped during this reply. Its open questions are kept; ask again once it has reconnected.",
	);
	expect(planner.calls).not.toContain("destroy");
	expect(context.chat.retained).toBeDefined();

	// The client never came back: the link's end withdraws its question, and the session goes.
	suspended = false;
	planner.settle();
	for (let attempt = 0; attempt < 10 && context.chat.retained; attempt++) await tick();
	expect(context.chat.retained).toBeUndefined();
	expect(planner.calls.at(-1)).toBe("destroy");
});

test("an explicit Stop during a reply ends the turn, and is not reported as a failed reply", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = plannerSession();
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
	let said = context.chat.entries.map(entry => entry.text);
	expect(said).toContain("@ana stopped the turn.");
	expect(said.some(text => text.includes("could not"))).toBe(false);
	expect(said).not.toContain("Which scope should the plan cover?");
});

test("a background job while a Planner is retained runs in its own session and leaves the retained one, and its references, alone", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = plannerSession();
	let jobSession = plannerSession(0);
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

test("a retained Planner is let go when its owner's binding ends, and sessions with nothing open still end with their turn", async () => {
	let { context, user } = await setup(configured(ATOMIC));
	let planner = plannerSession();
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

	let quiet = plannerSession(0).session;
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

test("a focused message given to a running turn still names the child", async () => {
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
	let steered: string[] = [];
	context.steers = () => true;
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
			steer: async text => {
				steered.push(text);
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
	await until(() => steered.length === 1);
	expect(context.chat.waiting).toHaveLength(0);
	first.resolve();
	await context.chat.running;
	expect(prompts).toHaveLength(1);
	expect(prompts[0]).not.toContain(child);
	let given = steered[0]!;
	expect(given.indexOf(`child id ${child}`)).toBeGreaterThanOrEqual(0);
	expect(given.indexOf(`child id ${child}`)).toBeLessThan(given.indexOf("shorten the summary"));
});

function failingMemberTurn(
	context: Chat.Room,
	stream: (prompt: string) => Promise<never> | AsyncGenerator<unknown>,
) {
	let planner = plannerSession(0);
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
		expect(failed[0]!.text).toBe("chopin's reply failed. Try again.");
	}
});
