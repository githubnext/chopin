import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { Sessions } from "../../auth/session";
import * as Store from "../../questions/store";
import { hostInputRoom } from "../../testing/decisions";
import { expectPlainStatus } from "../../testing/plain-words";
import {
	LINK_PERSISTENCE,
	linkAuth,
	linkServer,
	MEMBER_TOKEN,
	rawLink,
} from "../../testing/agent-link";
import { createHumanInput, rejoinInput } from "../atomic/human-input";
import { untilUnpaused } from "../atomic/full";
import { createRemoteAdapter } from "./adapter";
import { PlannerAttachments } from "./attachments";

import type { Lease } from "../../storage/model";
import type { PlannerAttachment } from "./attachments";
import type { RemotePlanner } from "./registry";

const OFFER = "resumable-sessions, restart-notice";
const WINDOW_MS = 10_000;
const HOUR_MS = 3_600_000;

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const sandboxSession = {
	defaultWorkingDirectory: "/tmp",
	async run() {
		return { exitCode: 0, stdout: "", stderr: "" };
	},
	async destroy() {},
} as never;

const run = {
	id: "run",
	name: "plan",
	status: "running" as const,
	started: 1,
	updated: 1,
	stages: [],
	waiting: 0,
};

async function until(check: () => boolean | Promise<boolean>, ms = 4_000) {
	for (let deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(5)) {
		if (await check()) return;
	}
	throw new Error("the condition did not hold in time");
}

/**
 * Two processes over one database, as a deploy leaves them: the first serves a remote Planner with
 * a run under way and a question nobody has answered, and cuts; the second starts with none of its
 * memory, not even the owner's browser sign-in, until that browser sends its cookie.
 */
const ASK_CONFIRM = { method: "confirm", title: "Ship?", message: "Now." } as const;

async function deploy(input: Record<string, unknown> = ASK_CONFIRM, asked = 1) {
	let f = await hostInputRoom();
	let closed = { first: false };
	cleanups.push(() => (closed.first ? undefined : f.close()));
	let linked = await linkAuth(undefined, { persistent: true });
	let { auth, channel, storage } = linked;
	// The attachments' clock, which a test moves to say time went by in a step of the cut, and stops
	// (`frozen`) to read the window at an instant, so the real time a reading takes moves nothing.
	let skew: { ms: number; frozen?: number } = { ms: 0 };
	auth.clock = () => new Date(skew.frozen ?? Date.now() + skew.ms);
	let events: Array<[string, unknown]> = [];
	let leaseA = (await storage.leases.acquire("chopin:writer", "first", 60_000))!;
	let first = linkServer(auth, 300, undefined, 60_000, undefined, undefined, {
		options: {
			store: {
				put: hold => storage.plannerHolds.put(leaseA, hold),
				delete: async id => void await storage.plannerHolds.delete(leaseA, id),
			},
		},
	});
	cleanups.push(first.stop);
	linked.revocations.add(id => first.attachments.sessionRevoked(id));

	let raw = await rawLink(first.url, MEMBER_TOKEN, OFFER);
	raw.send({ type: "attach", version: 1, document: channel.id });
	await raw.next("attached");
	let planner: RemotePlanner = { channelId: channel.id, isolated: false };
	planner.holdInput = () => () => {};
	planner.humanInput = report =>
		createHumanInput(f.room, (runId, signal) => untilUnpaused(planner, runId, signal), report);
	let sessionId = crypto.randomUUID();
	let opening = createRemoteAdapter(() => ({ link: first.links.at(-1)!, planner })).doStart({
		sessionId,
		sandboxSession,
		sessionWorkDir: "/tmp",
	});
	let start = await raw.next("start");
	raw.send({ type: "started", session: start.session });
	let session = await opening;
	cleanups.push(() => session.doDestroy());
	raw.send({
		type: "input-request",
		request: "ask-1",
		session: sessionId,
		input,
	});
	let [card, ...others] = await f.cards(asked);
	raw.send({ type: "runs", session: sessionId, active: ["run"], paused: [], cards: [run] });
	await until(() => planner.runs?.active.length === 1);

	/**
	 * What `main.ts` does at its cut, in its order, and then the second process starting. `spent`
	 * is time the clock says went by in a step: before the hold is written, before the lease is
	 * released, and before the second process took the lease.
	 */
	async function cut(
		windowMs = WINDOW_MS,
		spent: { beforeWrite?: number; beforeRelease?: number; beforeTakeover?: number } = {},
		takeover: { failWrites?: boolean } = {},
	) {
		first.attachments.shutdown();
		let rows = first.attachments.freeze(windowMs);
		skew.ms += spent.beforeWrite ?? 0;
		await first.attachments.persist(rows);
		for (let link of first.links) link.restart(windowMs);
		skew.ms += spent.beforeRelease ?? 0;
		await storage.leases.release(leaseA);
		let releasedAt = Date.now() + skew.ms;
		skew.ms += spent.beforeTakeover ?? 0;
		let leaseB = (await storage.leases.acquire("chopin:writer", "second", 60_000))!;
		await storage.sessions.reset(new Date(), leaseB, 60_000);
		let sessions = new Sessions(storage, false, auth.clock, { persistence: LINK_PERSISTENCE });
		let secondAuth = { ...auth, sessions } as typeof auth;
		let attachments = new PlannerAttachments(secondAuth, 60_000, {
			store: {
				put: hold =>
					takeover.failWrites
						? Promise.reject(new Error("the database is not there"))
						: storage.plannerHolds.put(leaseB, hold),
				delete: async id => void await storage.plannerHolds.delete(leaseB, id),
			},
			restoredRuns: (id, outcome) => events.push([`runs:${outcome}`, id]),
			missed: (id, cause) => events.push([`missed:${cause}`, id]),
		});
		let changes: PlannerAttachment[] = [];
		attachments.onChange((_id, status) => changes.push(status));
		await attachments.restore(await storage.plannerHolds.list());
		let second = linkServer(secondAuth, 300, undefined, 60_000, undefined, undefined, {
			attachments,
		});
		cleanups.push(second.stop);
		return {
			second,
			attachments,
			changes,
			/** Stops the clock `ms` after the lease was released. */
			at(ms: number) {
				skew.frozen = releasedAt + ms;
			},
			sessions,
			leaseB: leaseB as Lease,
			/** The owner's browser sends its cookie to the new process. */
			async browserReturns() {
				let cookie = linked.cookies.get("member")!;
				await sessions.authenticate(
					new Request(`${auth.config.origin}/api/session`, { headers: { cookie } }),
				);
			},
		};
	}
	return {
		...linked,
		f,
		closed,
		first,
		raw,
		session,
		sessionId,
		card: card!,
		others,
		events,
		cut,
		storage,
	};
}

/**
 * The second process opens the document again from what the first stored, as the first request
 * for it does, so the questions its rebuilt hold's client left open are asked of the members again.
 */
async function reopen(
	d: Awaited<ReturnType<typeof deploy>>,
	next: Awaited<ReturnType<Awaited<ReturnType<typeof deploy>>["cut"]>>,
) {
	await d.f.close();
	d.closed.first = true;
	let unsent: string[] = [];
	let g = await hostInputRoom(undefined, {
		storage: d.f.storage,
		channelId: d.f.channelId,
		lease: d.f.lease,
		backend: {
			rejoinPlannerQuestions: (plan, server) =>
				next.attachments.rejoinInputs(d.channel.id, {
					join: (asked, signal) => rejoinInput({ id: plan.id, plan, server }, asked, signal),
					unsent: decisions => unsent.push(...decisions),
				}),
		},
	});
	cleanups.push(g.close);
	return { g, unsent };
}

async function returns(
	d: Awaited<ReturnType<typeof deploy>>,
	next: Awaited<ReturnType<Awaited<ReturnType<typeof deploy>>["cut"]>>,
) {
	await next.browserReturns();
	let client = await rawLink(next.second.url, MEMBER_TOKEN, OFFER);
	client.send({ type: "attach", version: 1, document: d.channel.id });
	await client.next("attached");
	return client;
}

/**
 * A process that starts after the one the cut handed over to has crashed, with no cut of its own:
 * it rebuilds what storage still holds, and serves nothing until a test starts it.
 */
async function afterCrash(d: Awaited<ReturnType<typeof deploy>>) {
	let attachments = new PlannerAttachments({ ...d.auth }, 60_000, {});
	cleanups.push(() => attachments.close());
	await attachments.restore(await d.storage.plannerHolds.list());
	return attachments;
}

describe("a session whose client still has work when the cut closes Chat", () => {
	it("is not destroyed on the client nor forgotten by its link, so the hold the cut writes gives it back", async () => {
		let d = await deploy();
		d.first.attachments.shutdown();
		await d.session.doDestroy();
		await Bun.sleep(50);
		expect(d.raw.messages.some(message => message.type === "destroy")).toBe(false);
		await d.cut();
		let [row] = await d.storage.plannerHolds.list();
		expect(row!.sessions.map(session => session.id)).toEqual([d.sessionId]);
	});

	it("is destroyed as ever when the server is not going down", async () => {
		let d = await deploy();
		await d.session.doDestroy();
		expect(await d.raw.next("destroy")).toMatchObject({ session: d.sessionId });
	});
});

describe("a remote Planner whose link a cut closed", () => {
	it("is shown as attached to everyone through its window, though no link is attached yet", async () => {
		let d = await deploy();
		let next = await d.cut();
		expect(await d.raw.closed).toEqual({ code: 1012, reason: "server restarting" });
		expect(next.attachments.status(d.channel.id)).toEqual({ state: "attached", login: "member" });
		expect(next.attachments.holding(d.channel.id)).toEqual({
			userId: "U_member",
			login: "member",
			attached: true,
			disconnected: false,
		});
		// Not an attached link: nothing is started on it, and a request still waits as a saved row.
		expect(next.attachments.attached(d.channel.id)).toBe(false);
		expect(await next.attachments.confirmed(d.channel.id)).toBe(false);
		// Chat's stored workflow runs stay live, not stopped, until the window is over.
		expect(next.attachments.restoredWork(d.channel.id)).toBe("live");
		expect(next.changes).toEqual([]);
	});

	it("tells the client the window it has", async () => {
		let d = await deploy();
		await d.cut();
		expect(await d.raw.next("restarting")).toEqual({
			type: "restarting",
			reconnectWithinMs: WINDOW_MS,
		});
	});

	it("writes the window's length with the hold at the cut, and keeps nothing a person typed or a secret in storage", async () => {
		let d = await deploy();
		d.first.attachments.shutdown();
		await d.first.attachments.persist(d.first.attachments.freeze(WINDOW_MS));
		let [row] = await d.storage.plannerHolds.list();
		expect(row).toMatchObject({
			channelId: d.channel.id,
			login: "member",
			sessions: [{
				id: d.sessionId,
				waiting: ["ask-1"],
				owed: [],
				stops: [],
				asked: [{ request: "ask-1", method: "confirm", decisions: [d.card.id] }],
			}],
		});
		expect(row!.handoverUntil!.getTime()).toBeGreaterThan(Date.now() + WINDOW_MS - 2_000);
		expect(row!.handoverUntil!.getTime()).toBeLessThanOrEqual(Date.now() + WINDOW_MS);
		expect(JSON.stringify(row)).not.toContain("browser-login");
	});

	for (
		let [slow, spent, lateBy] of [
			["writing what the cut keeps", { beforeWrite: 2_000 }, 0],
			["releasing the lease", { beforeRelease: 2_000 }, 0],
			["the next process taking the lease", { beforeTakeover: 2_000 }, 2_000],
			["releasing the lease and the next process taking it together", {
				beforeRelease: 2_000,
				beforeTakeover: WINDOW_MS - 1_000,
			}, WINDOW_MS - 1_000],
			["releasing the lease, for longer than the window itself", {
				beforeRelease: WINDOW_MS + 1,
			}, 0],
			["writing what the cut keeps and releasing the lease, each for most of a window", {
				beforeWrite: WINDOW_MS - 500,
				beforeRelease: WINDOW_MS - 500,
				beforeTakeover: WINDOW_MS - 500,
			}, WINDOW_MS - 500],
		] as const
	) {
		it(`has the whole window its client was told, counted from the release, however long ${slow} took, and is never disconnected inside it`, async () => {
			let d = await deploy();
			let next = await d.cut(WINDOW_MS, spent);
			expect(await d.raw.next("restarting")).toEqual({
				type: "restarting",
				reconnectWithinMs: WINDOW_MS,
			});
			// Every moment of the window the client was told, counted from the release.
			for (let ms of [1, WINDOW_MS / 2, WINDOW_MS - 1, lateBy + 500]) {
				next.at(ms);
				expect(next.attachments.status(d.channel.id)).toEqual({
					state: "attached",
					login: "member",
				});
				expect(next.attachments.holding(d.channel.id)).toMatchObject({
					attached: true,
					disconnected: false,
				});
				expect(next.attachments.restoredWork(d.channel.id)).toBe("live");
			}
			// The window ends a window after the next process rebuilt the hold, which was after the
			// release, and not at all later than that.
			next.at(WINDOW_MS + lateBy + 1_000);
			expect(next.attachments.status(d.channel.id)).toEqual({
				state: "disconnected",
				login: "member",
			});
			expect(next.attachments.holding(d.channel.id)).toMatchObject({
				attached: false,
				disconnected: true,
			});
			expect(next.changes).toEqual([]);
		});
	}

	it("has no window for a process that takes the hold back more than an hour after the cut wrote it, which no deploy's hand-over lasts: it is disconnected at once, as when no process was there", async () => {
		let d = await deploy();
		let next = await d.cut(WINDOW_MS, { beforeTakeover: HOUR_MS + 1_000 });
		expect(next.attachments.status(d.channel.id)).toEqual({
			state: "disconnected",
			login: "member",
		});
		expect(next.attachments.holding(d.channel.id)).toMatchObject({
			attached: false,
			disconnected: true,
		});
		expect(next.attachments.restoredWork(d.channel.id)).toBe("down");
	});

	it("turns disconnected, announced and logged as a miss, when its window ends with no resume", async () => {
		let d = await deploy();
		let next = await d.cut(150);
		expect(next.attachments.status(d.channel.id).state).toBe("attached");
		await until(() => next.changes.length > 0);
		expect(next.changes).toEqual([{ state: "disconnected", login: "member" }]);
		// The owner's browser never came back, so that is what was missing.
		expect(d.events).toEqual([
			["runs:down", d.channel.id],
			["missed:login", d.channel.id],
		]);
		expect(next.attachments.holding(d.channel.id)).toMatchObject({
			attached: false,
			disconnected: true,
		});
		expect(next.attachments.restoredWork(d.channel.id)).toBe("down");
		// It stays disconnected, with no deadline, for its client's return.
		await Bun.sleep(100);
		expect(next.changes).toHaveLength(1);
	});

	it("gives a window to the process that rebuilds what the cut wrote and to no process after it: one that starts after the first crashed, its window over, finds the hold disconnected", async () => {
		let d = await deploy();
		let next = await d.cut(150);
		await until(() => next.changes.length > 0);
		expect(next.changes).toEqual([{ state: "disconnected", login: "member" }]);
		let later = await afterCrash(d);
		expect(later.status(d.channel.id)).toEqual({ state: "disconnected", login: "member" });
		expect(later.holding(d.channel.id)).toMatchObject({ attached: false, disconnected: true });
		expect(later.restoredWork(d.channel.id)).toBe("down");
	});

	it("gives a window to the process that rebuilds what the cut wrote and to no process after it: one that starts after the first crashed inside its window finds the hold disconnected, while the first's window carries on", async () => {
		let d = await deploy();
		let next = await d.cut();
		let kept = await d.storage.plannerHolds.get(d.channel.id);
		expect(kept?.handoverUntil).toBeUndefined();
		expect(kept?.sessions.map(session => session.id)).toEqual([d.sessionId]);
		let later = await afterCrash(d);
		expect(later.status(d.channel.id)).toEqual({ state: "disconnected", login: "member" });
		expect(later.holding(d.channel.id)).toMatchObject({ attached: false, disconnected: true });
		expect(later.restoredWork(d.channel.id)).toBe("down");
		expect(next.attachments.status(d.channel.id)).toEqual({ state: "attached", login: "member" });
		expect(next.attachments.restoredWork(d.channel.id)).toBe("live");
	});

	it("still gives its client its sessions and the question it waits on, when it resumes with a process that started after the first crashed", async () => {
		let d = await deploy();
		await d.cut();
		let later = await afterCrash(d);
		let server = linkServer({ ...d.auth }, 300, undefined, 60_000, undefined, undefined, {
			attachments: later,
		});
		cleanups.push(server.stop);
		let client = await rawLink(server.url, MEMBER_TOKEN, OFFER);
		client.send({ type: "attach", version: 1, document: d.channel.id });
		await client.next("attached");
		client.send({ type: "resume", sessions: [{ session: d.sessionId, requests: ["ask-1"] }] });
		expect(await client.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: d.sessionId, requests: ["ask-1"] }],
		});
		expect(later.attached(d.channel.id)).toBe(true);
	});

	it("is given the window again by the process after it when the process that took it is itself cut inside the window", async () => {
		let d = await deploy();
		let next = await d.cut();
		next.attachments.shutdown();
		await next.attachments.persist(next.attachments.freeze(WINDOW_MS));
		let third = await afterCrash(d);
		expect(third.status(d.channel.id)).toEqual({ state: "attached", login: "member" });
		expect(third.holding(d.channel.id)).toMatchObject({ attached: true, disconnected: false });
		expect(third.restoredWork(d.channel.id)).toBe("live");
	});

	it("has the whole window its client was told, and logs it, when the row it is given from cannot be rewritten", async () => {
		let errors = spyOn(console, "error").mockImplementation(() => {});
		cleanups.push(() => errors.mockRestore());
		let d = await deploy();
		let next = await d.cut(WINDOW_MS, {}, { failWrites: true });
		for (let ms of [1, WINDOW_MS / 2, WINDOW_MS - 1]) {
			next.at(ms);
			expect(next.attachments.status(d.channel.id)).toEqual({ state: "attached", login: "member" });
			expect(next.attachments.restoredWork(d.channel.id)).toBe("live");
		}
		next.at(WINDOW_MS + 1_000);
		expect(next.attachments.status(d.channel.id)).toEqual({
			state: "disconnected",
			login: "member",
		});
		expect(errors).toHaveBeenCalledWith(
			expect.stringContaining("link state"),
			expect.any(Error),
		);
	});

	it("names the client, not the sign-in, as what was missing once the owner's browser is back", async () => {
		let d = await deploy();
		let next = await d.cut(200);
		await next.browserReturns();
		await until(() => next.changes.length > 0);
		expect(d.events.map(([name]) => name)).toEqual(["runs:down", "missed:client"]);
	});

	it("holds a resume that comes inside the window before the owner's browser is back, refusing nothing and showing the machine attached, and takes the sessions back when the browser is", async () => {
		let d = await deploy();
		let next = await d.cut();
		let client = await rawLink(next.second.url, MEMBER_TOKEN, OFFER);
		client.send({ type: "attach", version: 1, document: d.channel.id });
		await client.next("attached");
		client.send({ type: "resume", sessions: [{ session: d.sessionId, requests: ["ask-1"] }] });
		await Bun.sleep(400);
		// Neither refused nor closed, and the machine is attached throughout, never connecting.
		expect(client.messages).toEqual([]);
		expect(client.socket.readyState).toBe(WebSocket.OPEN);
		expect(next.attachments.status(d.channel.id)).toEqual({ state: "attached", login: "member" });
		expect(next.attachments.holding(d.channel.id)).toMatchObject({
			attached: true,
			disconnected: false,
		});
		expect(await d.storage.plannerHolds.get(d.channel.id)).toBeDefined();

		await next.browserReturns();
		expect(await client.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: d.sessionId, requests: ["ask-1"] }],
		});
		expect(client.messages.some(message => message.type === "refused")).toBe(false);
		expect(next.attachments.attached(d.channel.id)).toBe(true);
		expect(next.attachments.status(d.channel.id)).toEqual({ state: "attached", login: "member" });
		expect(next.changes.every(status => status.state === "attached")).toBe(true);
		expect(d.events).toEqual([["runs:up", d.channel.id]]);
	});

	it("refuses a resume held when the window ends with the owner's browser still not back, as a resume after the window is, and the hold turns disconnected", async () => {
		let d = await deploy();
		let next = await d.cut(1_500);
		let client = await rawLink(next.second.url, MEMBER_TOKEN, OFFER);
		client.send({ type: "attach", version: 1, document: d.channel.id });
		await client.next("attached");
		client.send({ type: "resume", sessions: [{ session: d.sessionId, requests: ["ask-1"] }] });
		await Bun.sleep(100);
		expect(client.messages).toEqual([]);
		let refusal = await client.next("refused");
		expect(refusal).toEqual({
			type: "refused",
			code: "unavailable",
			message: "Chopin has not restored the sign-in this connection runs under yet.",
			retry: true,
		});
		expectPlainStatus(String(refusal.message), "a refusal to a returning client");
		// Never sign-in-required, which closes the link for good and ends the hold.
		expect((await client.closed).code).toBe(1011);
		expect(next.changes).toEqual([{ state: "disconnected", login: "member" }]);
		expect(d.events).toEqual([["runs:down", d.channel.id], ["missed:login", d.channel.id]]);
		expect(await d.storage.plannerHolds.get(d.channel.id)).toBeDefined();
	});

	it("hands the sessions back to the client that resumes once the owner is back, with the answer given meanwhile, and ends the window", async () => {
		let d = await deploy();
		// The question was answered while the link was down, so the first process owes it.
		d.raw.socket.close();
		await d.raw.closed;
		await until(() => d.first.links.length === 0);
		await d.f.answer(d.card.id, [0]);
		await until(() =>
			d.first.attachments.waiting(d.channel.id)
			&& d.f.plan.records.get(d.card.id)?.status === "answered"
		);
		await Bun.sleep(50);
		let next = await d.cut();
		await next.browserReturns();

		let client = await rawLink(next.second.url, MEMBER_TOKEN, OFFER);
		client.send({ type: "attach", version: 1, document: d.channel.id });
		await client.next("attached");
		client.send({ type: "resume", sessions: [{ session: d.sessionId, requests: ["ask-1"] }] });
		expect(await client.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: d.sessionId, requests: ["ask-1"] }],
		});
		expect(await client.next("input-result")).toMatchObject({
			request: "ask-1",
			status: "answered",
			value: true,
		});
		await Bun.sleep(50);
		expect(client.messages.filter(message => message.type === "input-result")).toEqual([]);
		expect(next.attachments.attached(d.channel.id)).toBe(true);
		expect(await next.attachments.confirmed(d.channel.id)).toBe(true);
		expect(next.attachments.status(d.channel.id)).toEqual({ state: "attached", login: "member" });
		// Resumed in time: members saw no change, and the hold's row goes while a link backs it.
		expect(next.changes.every(status => status.state === "attached")).toBe(true);
		expect(d.events).toEqual([["runs:up", d.channel.id]]);
		await until(async () => (await d.storage.plannerHolds.get(d.channel.id)) === undefined);
		// The window is over: nothing turns it disconnected later.
		await Bun.sleep(50);
		expect(next.attachments.status(d.channel.id).state).toBe("attached");
	});

	it("gives the client that resumes its own question back, and sends it the answer a member gives after, once", async () => {
		let d = await deploy();
		let next = await d.cut();
		let { g, unsent } = await reopen(d, next);
		// The member who answers it finds it open, and the answer is the asker's, not a turn's.
		expect(Store.get(g.plan.questions, d.card.id)?.awaited).toBe(true);
		let client = await returns(d, next);
		client.send({ type: "resume", sessions: [{ session: d.sessionId, requests: ["ask-1"] }] });
		expect(await client.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: d.sessionId, requests: ["ask-1"] }],
		});
		await g.answer(d.card.id, [0]);
		expect(await client.next("input-result")).toMatchObject({
			request: "ask-1",
			status: "answered",
			value: true,
		});
		await Bun.sleep(50);
		// The one it was given is read; no second one follows.
		expect(client.messages.filter(message => message.type === "input-result")).toEqual([]);
		expect(unsent).toEqual([]);
		expect(g.plan.records.get(d.card.id)?.status).toBe("answered");
	});

	it("gives the client the answer given before it was back, once it resumes, and keeps it from becoming a turn", async () => {
		let d = await deploy();
		let next = await d.cut();
		let { g, unsent } = await reopen(d, next);
		await g.answer(d.card.id, [1]);
		let client = await returns(d, next);
		client.send({ type: "resume", sessions: [{ session: d.sessionId, requests: ["ask-1"] }] });
		expect(await client.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: d.sessionId, requests: ["ask-1"] }],
		});
		expect(await client.next("input-result")).toMatchObject({
			request: "ask-1",
			status: "answered",
			value: false,
		});
		client.send({ type: "input-received", request: "ask-1" });
		await Bun.sleep(50);
		// The one it was given is read; no second one follows.
		expect(client.messages.filter(message => message.type === "input-result")).toEqual([]);
		expect(unsent).toEqual([]);
	});

	it("hands an answer to the Planner as a turn when its client comes back with nothing to take it", async () => {
		let d = await deploy();
		let next = await d.cut();
		let { g, unsent } = await reopen(d, next);
		await g.answer(d.card.id, [0]);
		expect(unsent).toEqual([]);
		let client = await returns(d, next);
		client.send({ type: "resume", sessions: [] });
		expect(await client.next("resumed")).toEqual({ type: "resumed", sessions: [] });
		await until(() => unsent.length > 0);
		expect(unsent).toEqual([d.card.id]);
		expect(client.messages.filter(message => message.type === "input-result")).toEqual([]);
	});

	it("hands an answer to the Planner as a turn when a client attaches that holds nothing to resume", async () => {
		let d = await deploy();
		let next = await d.cut();
		let { g, unsent } = await reopen(d, next);
		await g.answer(d.card.id, [0]);
		let client = await returns(d, next);
		client.send({ type: "input-received", request: "unrelated" });
		await until(() => unsent.length > 0);
		expect(unsent).toEqual([d.card.id]);
		expect(client.messages.filter(message => message.type === "input-result")).toEqual([]);
	});

	it("withdraws the Decision of a question its client resumes without, and gives it nothing", async () => {
		let d = await deploy();
		let next = await d.cut();
		let { g, unsent } = await reopen(d, next);
		let client = await returns(d, next);
		client.send({ type: "resume", sessions: [{ session: d.sessionId, requests: [] }] });
		expect(await client.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: d.sessionId, requests: [] }],
		});
		await until(() => g.plan.records.get(d.card.id)?.status !== "open");
		expect(g.plan.records.get(d.card.id)?.status).toBe("cancelled");
		expect(unsent).toEqual([]);
	});

	it("leaves a question open for a turn when the document opens only after its client has resumed without it", async () => {
		let d = await deploy();
		let next = await d.cut();
		let client = await returns(d, next);
		client.send({ type: "resume", sessions: [{ session: d.sessionId, requests: [] }] });
		await client.next("resumed");
		let { g, unsent } = await reopen(d, next);
		await Bun.sleep(50);
		// Nobody waits on it, so its answer is the Planner's to hear of as a turn.
		expect(Store.get(g.plan.questions, d.card.id)?.awaited).toBeUndefined();
		expect(g.plan.records.get(d.card.id)?.status).toBe("open");
		expect(unsent).toEqual([]);
	});

	it("gives a questionnaire its result when some of its decisions were answered before the cut and the rest after", async () => {
		let two = {
			method: "questionnaire",
			params: {
				questions: [
					{
						header: "A",
						question: "First?",
						options: [{ label: "x", description: "" }, { label: "y", description: "" }],
					},
					{
						header: "B",
						question: "Second?",
						options: [{ label: "p", description: "" }, { label: "q", description: "" }],
					},
				],
			},
		};
		let d = await deploy(two, 2);
		await d.f.answer(d.card.id, [1]);
		let next = await d.cut();
		let { g } = await reopen(d, next);
		let client = await returns(d, next);
		client.send({ type: "resume", sessions: [{ session: d.sessionId, requests: ["ask-1"] }] });
		await client.next("resumed");
		await g.answer(d.others[0]!.id, [0]);
		let result = await client.next("input-result");
		expect(result).toMatchObject({ request: "ask-1", status: "answered" });
		expect(result.value).toMatchObject({
			cancelled: false,
			answers: [
				{ questionIndex: 0, question: "First?", kind: "option", answer: "y" },
				{ questionIndex: 1, question: "Second?", kind: "option", answer: "p" },
			],
		});
	});

	it("ends the hold, and its row, for a client that returns with nothing to resume", async () => {
		let d = await deploy();
		let next = await d.cut();
		await next.browserReturns();
		let client = await rawLink(next.second.url, MEMBER_TOKEN, OFFER);
		client.send({ type: "attach", version: 1, document: d.channel.id });
		await client.next("attached");
		client.send({ type: "resume", sessions: [] });
		expect(await client.next("resumed")).toEqual({ type: "resumed", sessions: [] });
		expect(next.attachments.attached(d.channel.id)).toBe(true);
		expect(d.events).toEqual([["runs:ended", d.channel.id]]);
		await until(async () => (await d.storage.plannerHolds.get(d.channel.id)) === undefined);
	});

	it("ends the hold and its row when the owner signs out, a writer resets the Planner, or the document is archived", async () => {
		for (let ending of ["sign-out", "reset", "archive"] as const) {
			let d = await deploy();
			let next = await d.cut();
			let before = await d.storage.plannerHolds.get(d.channel.id);
			expect(before).toBeDefined();
			if (ending === "sign-out") await next.attachments.sessionRevoked(before!.ownerSessionId!);
			else if (ending === "reset") next.attachments.ownerReset(d.channel.id);
			else await next.attachments.documentEnded(d.channel.id);
			expect(next.attachments.status(d.channel.id)).toEqual({ state: "none" });
			await until(async () => (await d.storage.plannerHolds.get(d.channel.id)) === undefined);
			expect(d.events.at(-1)).toEqual(["runs:ended", d.channel.id]);
		}
	});

	it("is not rebuilt when its stored owner is no longer the login it named", async () => {
		let d = await deploy();
		await d.first.attachments.persist(d.first.attachments.freeze(WINDOW_MS));
		let held = (await d.storage.channels.readAgent(d.channel.id, new Date()))!.agent!;
		await d.storage.channels.clearAgentOwner(
			d.channel.id,
			held.ownerSessionId!,
			held.generation,
			new Date(),
		);
		let next = await d.cut();
		expect(next.attachments.status(d.channel.id)).toEqual({ state: "none" });
		await until(async () => (await d.storage.plannerHolds.get(d.channel.id)) === undefined);
	});

	it("keeps no state at the cut for a hold in its grace period, which the deploy did not cause", async () => {
		let d = await deploy();
		d.raw.send({ type: "detach" });
		await d.raw.closed;
		await until(() => d.first.attachments.status(d.channel.id).state === "held");
		let rows = d.first.attachments.freeze(WINDOW_MS);
		expect(rows).toEqual([]);
	});
});
