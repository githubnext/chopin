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

/** A Planner session that owns workflow runs, driven by the test. */
function runningSession() {
	let runs = { active: ["run-1"], paused: [] as string[] };
	let listeners = new Set<(runs: { active: string[]; paused: string[] }) => void>();
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
		watchRuns(listener: (runs: { active: string[]; paused: string[] }) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async pauseRuns() {
			calls.push("pause");
		},
		async resumeRuns() {
			calls.push("resume");
		},
	};
	return {
		session,
		calls,
		set(next: { active: string[]; paused: string[] }) {
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
	let runs = () => events.filter(event => event.kind === "chat:state").at(-1)?.runs;

	expect(await Chat.invoke(context, user, "Run the workflow")).toBeUndefined();
	await context.chat.running;
	expect(planner.calls).toEqual(["stream @ana: Run the workflow"]);
	expect(context.chat.busy).toBe(false);
	expect(context.chat.runs).toEqual({ active: 1, paused: 0 });
	expect(runs()).toEqual({ active: 1, paused: 0 });
	expect(holds).toBe(1);

	await Chat.abort(context, ws);
	expect(planner.calls.at(-1)).toBe("pause");
	expect(said()).toBe("@ana stopped the Planner and paused its workflows.");
	planner.set({ active: [], paused: ["run-1"] });
	expect(runs()).toEqual({ active: 0, paused: 1 });
	expect(planner.calls).not.toContain("destroy");

	await Chat.resume(context, ws);
	expect(planner.calls.at(-1)).toBe("resume");
	expect(said()).toBe("@ana resumed the Planner's workflows.");
	planner.set({ active: ["run-1"], paused: [] });

	expect(await Chat.invoke(context, user, "How is it going?")).toBeUndefined();
	await context.chat.running;
	expect(opened).toBe(1);
	expect(planner.calls.filter(call => call.startsWith("stream"))).toHaveLength(2);
	expect(planner.calls).not.toContain("destroy");

	planner.set({ active: [], paused: [] });
	await new Promise(resolve => setTimeout(resolve, 0));
	expect(planner.calls.at(-1)).toBe("destroy");
	expect(context.chat.retained).toBeUndefined();
	expect(context.chat.runs).toBeUndefined();
	expect(runs()).toBeUndefined();
	expect(holds).toBe(0);

	await Chat.resume(context, ws);
	await Chat.abort(context, ws);
	expect(planner.calls.at(-1)).toBe("destroy");
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

	let quiet = { ...runningSession().session, runs: () => ({ active: [], paused: [] }) };
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
