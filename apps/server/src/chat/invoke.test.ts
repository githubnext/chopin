import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActiveOwnerBindings } from "../agent/active-owner";
import { Admission } from "../auth/admission";
import { Sessions } from "../auth/session";
import { fullPlanner } from "../harness/atomic/full";
import { forgetWorkspaces } from "../harness/atomic/workspace";
import { openPlannerSession } from "../harness/session";
import * as Plan from "../plan/service";
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
};

/** The real session opener, over a harness stub that records what each turn runs with. */
function observe(context: Chat.Room): Seen[] {
	let seen: Seen[] = [];
	context.openPlannerSession = (owner, channel) =>
		openPlannerSession(owner, channel, {
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
					});
					return { fullStream: (async function*() {})() };
				},
			} as never,
		});
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
			[{ HARNESS: "pi", HARNESS_AUTH: "ai-gateway", MODEL: "stub/model", ...LOCAL }, false],
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
			expect(turn.instructions.includes("proceed on your best judgement")).toBe(full);
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
	let said = () => context.chat.entries.at(-1)?.text;
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
	expect(said()).toBe("@ana stopped the Planner and paused its workflows.");
	planner.set({ active: [], paused: ["run-1"], cards: [card("paused")] });
	await tick();
	expect(runs()?.map(run => run.status)).toEqual(["paused"]);
	expect(planner.calls).not.toContain("destroy");

	await Chat.resume(context, ws);
	expect(planner.calls.at(-1)).toBe("resume");
	expect(said()).toBe("@ana resumed the Planner's workflows.");
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
			entry.text === "@ana stopped the Planner and paused its workflows."
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
			entry.text === "@ana stopped the Planner and paused its workflows."
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
		"@ana stopped the turn.",
		"@ana stopped the Planner and paused its workflows.",
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
