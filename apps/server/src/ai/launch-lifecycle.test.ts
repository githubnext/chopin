/**
 * What a launch is given, and when it stops working, decided against everything that can change
 * while it is prepared or used: a key its provider refuses, a machine that must be paired again,
 * and the run or session it was handed to ending.
 */
import { afterEach, expect, test } from "bun:test";

import { AI_LAUNCH_HEADER, AI_PROXY_PATH } from "@chopin/protocol/ai-credentials";

import { testLease } from "../storage/contract-support";
import { machine } from "../storage/machine-contract";
import { MemoryStorage } from "../storage/memory/adapter";
import { AiCredentials } from "./credentials";
import { endLaunch } from "./launches";
import { aiProxy } from "./proxy";

import type { AiProvider } from "@chopin/protocol/ai-credentials";
import type { AiCredentialsOptions, AiLaunch, AiLaunchGrants } from "./credentials";
import type { AiTransport } from "./proxy";
import type { Lease } from "../storage/model";

const ORIGIN = "https://chopin.test";
const OPENAI_KEY = "sk-mona-openai-key-0123456789";
const ANTHROPIC_KEY = "sk-ant-mona-anthropic-key-0123456789";
const NEW_OPENAI_KEY = "sk-mona-new-openai-key-0123456789";

let servers: Array<{ stop: (force: boolean) => void }> = [];
afterEach(() => {
	for (let server of servers.splice(0)) server.stop(true);
});

/**
 * A provider standing in for OpenAI and Anthropic: it accepts every key it is asked to check, and
 * answers a model request as `answer` says, recording each it was sent.
 */
function provider() {
	let state = { answer: "ok" as "ok" | "invalid" | "throttled", sent: 0 };
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			let path = new URL(request.url).pathname;
			if (path === "/v1/models") return Response.json({ data: [] });
			state.sent++;
			if (state.answer === "invalid") {
				return Response.json(
					{ error: { message: "Incorrect API key provided", code: "invalid_api_key" } },
					{ status: 401 },
				);
			}
			if (state.answer === "throttled") {
				return Response.json({ error: { message: "Rate limit reached" } }, { status: 429 });
			}
			return Response.json({ choices: [{ message: { content: "hello" } }] });
		},
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}`, state };
}

/** A world with mona, her document and a machine of hers, and her keys connected. */
async function world(options: Partial<AiCredentialsOptions> = {}) {
	let storage = new MemoryStorage();
	let now = new Date();
	await storage.users.put({ id: "U_mona", login: "mona", avatarUrl: "", now });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release plan",
		createdBy: "U_mona",
		now,
	});
	let paired = machine("U_mona");
	await storage.machines.create(paired);
	let lease = await testLease(storage);
	let upstream = provider();
	let credentials = new AiCredentials({
		storage,
		lease: () => lease,
		key: new Uint8Array(32).fill(7),
		origin: ORIGIN,
		githubToken: async () => undefined,
		copilotToken: async () => undefined,
		upstreams: { openai: upstream.url, anthropic: upstream.url },
		...options,
	});
	let launch = (overrides: Partial<AiLaunch> = {}) =>
		credentials.launch({
			userId: "U_mona",
			machineId: paired.id,
			channelId: channel.id,
			expiresAt: new Date(Date.now() + 60 * 60_000),
			...overrides,
		});
	return { storage, channel, machine: paired, lease, upstream, credentials, launch };
}

/** Sends one model request through the proxy with `launched`'s stand-in for `provider`. */
async function ask(
	proxy: ReturnType<typeof aiProxy>,
	launched: AiLaunchGrants,
	provider: AiProvider,
	body: BodyInit = JSON.stringify({ model: "m", messages: [] }),
) {
	let grant = launched.grants.find(value => value.provider === provider)!;
	let path = provider === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
	let url = new URL(`${ORIGIN}${AI_PROXY_PATH}/${provider}${path}`);
	let request = new Request(url, {
		method: "POST",
		headers: {
			...(provider === "anthropic"
				? { "x-api-key": grant.placeholder }
				: { authorization: `Bearer ${grant.placeholder}` }),
			[AI_LAUNCH_HEADER]: launched.launchToken,
			"content-type": "application/json",
		},
		body,
		...(typeof body === "string" ? {} : { duplex: "half" }),
	} as RequestInit);
	return proxy(request, url);
}

/** Holds the next call of `method` on `target` until released, saying when it was called. */
function pause<T extends object, K extends keyof T>(target: T, method: K) {
	let original = target[method] as (...args: unknown[]) => Promise<unknown>;
	let reached = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let paused = false;
	(target[method] as unknown) = async (...args: unknown[]) => {
		if (!paused) {
			paused = true;
			reached.resolve();
			await release.promise;
		}
		return original.apply(target, args);
	};
	return { reached: reached.promise, release: () => release.resolve() };
}

/** Holds `list` the `nth` time it is called, the final read of a launch's credentials. */
function pauseList(storage: MemoryStorage, nth: number) {
	let store = storage.aiCredentials;
	let list = store.list.bind(store);
	let calls = 0;
	let reached = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	store.list = async userId => {
		calls++;
		if (calls === nth) {
			reached.resolve();
			await release.promise;
		}
		return list(userId);
	};
	return { reached: reached.promise, release: () => release.resolve() };
}

test("a key its provider refuses while a launch is handed out is left out of it, and the other is given", async () => {
	let { storage, credentials, launch, upstream } = await world();
	await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
	await credentials.connect("U_mona", "anthropic", { kind: "api-key", secret: ANTHROPIC_KEY });
	let proxy = aiProxy({
		credentials,
		upstreams: { openai: upstream.url, anthropic: upstream.url },
	});
	let first = await launch();
	expect(first.grants.map(grant => grant.provider)).toEqual(["openai", "anthropic"]);

	// The next launch is paused once its placeholders are stored, before its final reads.
	let held = pause(storage.aiPlaceholders, "put");
	let second = launch();
	await held.reached;
	upstream.state.answer = "invalid";
	expect((await ask(proxy, first, "openai")).status).toBe(401);
	held.release();
	expect((await second).grants.map(grant => grant.provider)).toEqual(["anthropic"]);
});

test("a rate limit while a launch is handed out leaves both keys in it", async () => {
	let { storage, credentials, launch, upstream } = await world();
	await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
	await credentials.connect("U_mona", "anthropic", { kind: "api-key", secret: ANTHROPIC_KEY });
	let proxy = aiProxy({
		credentials,
		upstreams: { openai: upstream.url, anthropic: upstream.url },
	});
	let first = await launch();
	let held = pause(storage.aiPlaceholders, "put");
	let second = launch();
	await held.reached;
	upstream.state.answer = "throttled";
	expect((await ask(proxy, first, "openai")).status).toBe(429);
	held.release();
	expect((await second).grants.map(grant => grant.provider)).toEqual(["openai", "anthropic"]);
});

test("a refusal of a key already replaced while a launch is handed out leaves the new key in it", async () => {
	let { storage, credentials, launch } = await world();
	await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
	await credentials.connect("U_mona", "anthropic", { kind: "api-key", secret: ANTHROPIC_KEY });
	let old = (await storage.aiCredentials.get("U_mona", "openai"))!;
	let held = pause(storage.aiPlaceholders, "put");
	let second = launch();
	await held.reached;
	await credentials.connect("U_mona", "openai", { kind: "api-key", secret: NEW_OPENAI_KEY });
	await credentials.rejected(old, OPENAI_KEY);
	held.release();
	expect((await second).grants.map(grant => grant.provider)).toEqual(["openai", "anthropic"]);
	expect((await storage.aiCredentials.get("U_mona", "openai"))?.rejectedAt).toBeUndefined();
});

test("a machine that must be paired again while a launch is prepared on it reports no provider ready without its stored grant", async () => {
	let { storage, credentials, launch, machine: paired } = await world();
	await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
	// The first read of her credentials admits the key; the second is the launch's final read.
	let held = pauseList(storage, 2);
	let launching = launch();
	await held.reached;
	await storage.machines.reauthorize(paired.id, 1, new Date());
	// As `Machines` tells its listeners, which end the machine's launches without revoking it.
	await credentials.machineEnded(paired.id);
	held.release();
	let launched = await launching;
	for (let grant of launched.grants) {
		let found = await storage.aiPlaceholders.find(
			new Uint8Array(new Bun.CryptoHasher("sha256").update(grant.placeholder).digest()),
			new Date(),
		);
		expect(found, grant.provider).toBeDefined();
	}
	expect(launched.grants).toEqual([]);
	expect(launched.ended).toBe(true);
});

test("a machine revoked while a launch is prepared on it gives the launch nothing", async () => {
	let { storage, credentials, launch, machine: paired, lease } = await world();
	await credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
	let held = pauseList(storage, 2);
	let launching = launch();
	await held.reached;
	await storage.machines.revoke(lease, paired.id, "U_mona", new Date());
	await credentials.machineEnded(paired.id);
	held.release();
	let launched = await launching;
	expect(launched.grants).toEqual([]);
	expect(launched.ended).toBe(true);
});

/**
 * A world whose launches belong to runs and sessions, as `main.ts` keeps them, with a transport
 * that records what it was handed to send and sends nothing.
 */
async function owned() {
	let runs = new Set<string>(["run:run-1"]);
	let sessions = new Set<string>();
	let ownerLive = ({ launchId, owner }: { launchId: string; owner?: string }) =>
		owner?.startsWith("run:") ? runs.has(owner) : sessions.has(launchId);
	let made = await world({ ownerLive });
	await made.credentials.connect("U_mona", "openai", { kind: "api-key", secret: OPENAI_KEY });
	let submitted: string[] = [];
	let transport: AiTransport = (_target, init) => {
		submitted.push(String((init.headers as Headers).get("authorization")));
		return { sent: Promise.resolve(Response.json({ ok: true })), at: Date.now() };
	};
	let proxy = aiProxy({
		credentials: made.credentials,
		transport,
		upstreams: { openai: made.upstream.url },
	});
	return { ...made, runs, sessions, ownerLive, submitted, proxy, transport };
}

/** A request whose body arrives only once `release` is called: held before its final check. */
function heldBody() {
	let release!: () => void;
	let body = new ReadableStream<Uint8Array>({
		async start(controller) {
			await new Promise<void>(resolve => release = resolve);
			controller.enqueue(new TextEncoder().encode("{}"));
			controller.close();
		},
	});
	return { body, release: () => release() };
}

/** Holds each call of `method` on `target` until released, saying when the first came. */
function delay<T extends object, K extends keyof T>(target: T, method: K) {
	let original = target[method] as (...args: unknown[]) => Promise<unknown>;
	let reached = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	(target[method] as unknown) = async (...args: unknown[]) => {
		reached.resolve();
		await release.promise;
		return original.apply(target, args);
	};
	return {
		reached: reached.promise,
		release: () => release.resolve(),
		restore: () => (target[method] as unknown) = original,
	};
}

test("a request waiting when its run's end is asked is never sent, though storage has not ended the launch yet", async () => {
	let { credentials, launch, proxy, submitted, storage, machine: paired } = await owned();
	let launched = await launch({ owner: "run:run-1" });
	let held = heldBody();
	let asking = ask(proxy, launched, "openai", held.body);
	await Bun.sleep(10);
	let deleting = delay(storage.aiPlaceholders, "deleteHeldLaunch");
	let ending = credentials.endHeld(launched.launchToken, paired.id);
	await deleting.reached;
	held.release();
	let answer = await asking;
	expect(answer.status).toBe(401);
	expect(await answer.json()).toMatchObject({ error: { code: "launch-ended" } });
	expect(submitted).toEqual([]);
	deleting.release();
	expect(await ending).toBe(true);
});

test("a request waiting when its Planner session closes, or its launch is replaced, is never sent on the launch that ended", async () => {
	for (let how of ["closed", "replaced"] as const) {
		let { credentials, launch, proxy, submitted, storage, sessions } = await owned();
		let launched = await launch({ owner: "session:session-1" });
		sessions.add(launched.launchId);
		let held = heldBody();
		let asking = ask(proxy, launched, "openai", held.body);
		await Bun.sleep(10);
		let deleting = delay(storage.aiPlaceholders, "deleteLaunch");
		let next: AiLaunchGrants | undefined;
		if (how === "replaced") {
			deleting.restore();
			next = await launch({ owner: "session:session-1" });
			sessions.add(next.launchId);
			deleting = delay(storage.aiPlaceholders, "deleteLaunch");
		}
		// As a session does: it no longer holds the launch, and asks for its end.
		sessions.delete(launched.launchId);
		endLaunch(credentials, launched.launchId);
		await deleting.reached;
		held.release();
		expect((await asking).status, how).toBe(401);
		expect(submitted, how).toEqual([]);
		deleting.release();
		if (next) {
			deleting.restore();
			expect((await ask(proxy, next, "openai")).status, how).toBe(200);
			expect(submitted, how).toHaveLength(1);
		}
	}
});

test("a run that ended without its end reaching Chopin sends nothing more, and its launch is ended for it", async () => {
	let { credentials, launch, proxy, submitted, runs, storage } = await owned();
	let launched = await launch({ owner: "run:run-1" });
	let held = heldBody();
	let asking = ask(proxy, launched, "openai", held.body);
	await Bun.sleep(10);
	// The run ended in Chopin; the connector's end call never came.
	runs.delete("run:run-1");
	held.release();
	expect((await asking).status).toBe(401);
	expect(submitted).toEqual([]);
	expect(await credentials.retire()).toBe(0);
	// Moments later, once the launch is no longer one being taken up, the lease holder ends it.
	let later = new AiCredentials({
		storage,
		lease: (await testLeaseOf(storage))!,
		key: new Uint8Array(32).fill(7),
		origin: ORIGIN,
		githubToken: async () => undefined,
		copilotToken: async () => undefined,
		ownerLive: ({ owner }) => runs.has(owner!),
	});
	expect(await later.retire()).toBe(1);
	expect(await storage.aiPlaceholders.owned(new Date())).toEqual([]);
});

test("an end storage refuses leaves the launch ended in this process, and is tried again", async () => {
	let { credentials, launch, proxy, submitted, storage } = await owned();
	let launched = await launch({ owner: "run:run-1" });
	let store = storage.aiPlaceholders;
	let deleteLaunch = store.deleteLaunch.bind(store);
	let refusals = 1;
	store.deleteLaunch = async (lease, launchId) => {
		if (refusals-- > 0) throw new Error("connection reset");
		return deleteLaunch(lease, launchId);
	};
	await expect(credentials.end(launched.launchId)).rejects.toThrow("connection reset");
	expect((await ask(proxy, launched, "openai")).status).toBe(401);
	expect(submitted).toEqual([]);
	expect(await store.owned(new Date())).toHaveLength(1);
	await credentials.retire();
	expect(await store.owned(new Date())).toEqual([]);
});

test("after a hand-over, the next process admits nothing for a run that ended or a session it does not hold, and ends their launches; a session it holds keeps working", async () => {
	let { launch, storage, runs } = await owned();
	let ran = await launch({ owner: "run:run-1" });
	let dropped = await launch({ owner: "session:session-1" });
	let kept = await launch({ owner: "session:session-2" });
	// The first process stopped with its ends unwritten: the run ended in Chopin, one session went.
	runs.delete("run:run-1");
	let next = new Set([kept.launchId]);
	let submitted: string[] = [];
	let credentials = new AiCredentials({
		storage,
		lease: (await testLeaseOf(storage))!,
		key: new Uint8Array(32).fill(7),
		origin: ORIGIN,
		githubToken: async () => undefined,
		copilotToken: async () => undefined,
		ownerLive: ({ launchId, owner }) =>
			owner!.startsWith("run:") ? runs.has(owner!) : next.has(launchId),
	});
	let proxy = aiProxy({
		credentials,
		transport: (_target, init) => {
			submitted.push(String((init.headers as Headers).get("authorization")));
			return { sent: Promise.resolve(Response.json({ ok: true })), at: Date.now() };
		},
	});
	expect((await ask(proxy, ran, "openai")).status).toBe(401);
	expect((await ask(proxy, dropped, "openai")).status).toBe(401);
	expect(submitted).toEqual([]);
	expect((await ask(proxy, kept, "openai")).status).toBe(200);
	expect(submitted).toEqual([`Bearer ${OPENAI_KEY}`]);
	expect(await credentials.retire()).toBe(2);
	expect((await storage.aiPlaceholders.owned(new Date())).map(value => value.launchId)).toEqual([
		kept.launchId,
	]);
});

/** The writer lease the process that takes over holds: the same lease, for this one database. */
async function testLeaseOf(storage: MemoryStorage): Promise<() => Lease> {
	let lease = await testLease(storage);
	return () => lease;
}
