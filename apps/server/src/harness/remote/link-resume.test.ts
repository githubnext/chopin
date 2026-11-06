import { afterEach, describe, expect, it } from "bun:test";

import { hostInputRoom, laterTimers } from "../../testing/decisions";
import { expectPlainStatus } from "../../testing/plain-words";
import {
	holdingProxy,
	linkAuth,
	linkServer,
	MEMBER_TOKEN,
	rawLink,
	RIVAL_TOKEN,
} from "../../testing/agent-link";
import { createHumanInput } from "../atomic/human-input";
import { untilUnpaused } from "../atomic/full";
import { createRemoteAdapter } from "./adapter";

import type { RemotePlanner } from "./registry";

const FEATURE = "resumable-sessions";
const MINUTE = 60_000;
/** The longest `PLANNER_ATTACH_GRACE_MS` a deployment can configure. */
const LONGEST_GRACE = 60 * MINUTE;

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

async function until(check: () => boolean, ms = 4_000) {
	for (let deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(5)) {
		if (check()) return;
	}
	throw new Error("the condition did not hold in time");
}

/**
 * A client attached as a document's Planner that offers `resumable-sessions`, with one Planner
 * session running a workflow run and waiting on one question a member has not answered.
 */
async function held(
	options: {
		graceMs?: number;
		feature?: boolean;
		/** The whole `Chopin-Agent-Features` header, where the test offers more than the one. */
		offer?: string;
		proxied?: boolean;
		runs?: boolean;
	} = {},
) {
	let f = await hostInputRoom();
	cleanups.push(f.close);
	let { auth, channel, signOut, revocations } = await linkAuth();
	let server = linkServer(auth, 300, undefined, options.graceMs ?? LONGEST_GRACE);
	cleanups.push(server.stop);
	revocations.add(id => server.attachments.sessionRevoked(id));
	let feature = options.feature === false ? undefined : options.offer ?? FEATURE;
	let proxy = options.proxied ? await holdingProxy(server.url, 10) : undefined;
	if (proxy) cleanups.push(proxy.stop);
	let raw = await rawLink(proxy?.url ?? server.url, MEMBER_TOKEN, feature);
	raw.send({ type: "attach", version: 1, document: channel.id });
	let attached = await raw.next("attached");
	let planner: RemotePlanner = { channelId: channel.id, isolated: false };
	let heldInputs = { open: 0, released: 0 };
	planner.holdInput = () => {
		heldInputs.open++;
		return () => {
			heldInputs.open--;
			heldInputs.released++;
		};
	};
	planner.humanInput = report =>
		createHumanInput(
			f.room,
			(runId, signal) => untilUnpaused(planner, runId, signal),
			report,
		);
	let sessionId = crypto.randomUUID();
	let opening = createRemoteAdapter(() => ({ link: server.links.at(-1)!, planner })).doStart({
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
		input: { method: "confirm", title: "Ship?", message: "Now." },
	});
	let [card] = await f.cards(1);
	if (options.runs !== false) {
		raw.send({ type: "runs", session: sessionId, active: ["run"], paused: [], cards: [run] });
		await until(() => planner.runs?.active.length === 1);
	}
	let status = () => f.plan.records.get(card!.id)?.status;
	return {
		proxy,
		heldInputs,
		f,
		auth,
		channel,
		server,
		raw,
		attached,
		planner,
		sessionId,
		card: card!,
		status,
		runStatus: () => planner.runs?.cards[0]?.status,
		signOut,
		/** The link drops with no `detach`, as a network failure ends it. */
		async drop() {
			raw.socket.close();
			await raw.closed;
			await until(() => server.links.length === 0);
		},
		/** A new link from the same account, offering the feature unless it is told not to. */
		async reattach(token = MEMBER_TOKEN, offer = true) {
			let next = await rawLink(server.url, token, offer ? FEATURE : undefined);
			next.send({ type: "attach", version: 1, document: channel.id });
			cleanups.push(() => next.socket.close());
			return next;
		},
	};
}

/** What Chat's Stop and a run's pause call on the session, as `remoteRunControl` does. */
function controlOf(planner: RemotePlanner) {
	return (action: "stop" | "resume", run?: string) => {
		if (!planner.control) throw new Error("The Planner has no attached session to control.");
		return planner.control(action, run);
	};
}

describe("a link the server closes because it is restarting", () => {
	it("tells a client that offered restart-notice when to expect the new process, closes with 1012, and keeps its work for a resume", async () => {
		let h = await held({ offer: `${FEATURE}, restart-notice` });
		expect(h.attached.features).toEqual([FEATURE, "restart-notice"]);
		h.server.links.at(-1)!.restart(10_000);
		expect(await h.raw.next("restarting")).toEqual({
			type: "restarting",
			reconnectWithinMs: 10_000,
		});
		expect(await h.raw.closed).toEqual({ code: 1012, reason: "server restarting" });
		await until(() => h.server.links.length === 0);
		expect(h.planner.suspended).toBe(true);
		expect(h.status()).toBe("open");

		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		expect(await next.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: h.sessionId, requests: ["ask-1"] }],
		});
	});

	it("only closes with 1012 for a client that did not offer restart-notice, and still keeps its work", async () => {
		let h = await held();
		h.server.links.at(-1)!.restart(10_000);
		expect(await h.raw.closed).toEqual({ code: 1012, reason: "server restarting" });
		expect(h.raw.messages.some(message => message.type === "restarting")).toBe(false);
		await until(() => h.server.links.length === 0);
		expect(h.planner.suspended).toBe(true);
		expect(h.status()).toBe("open");
	});

	it("ends everything for a client that never offered resumable-sessions, as any close does", async () => {
		let h = await held({ feature: false });
		h.server.links.at(-1)!.restart(10_000);
		await h.raw.closed;
		await until(() => h.server.links.length === 0);
		expect(h.planner.suspended).not.toBe(true);
	});

	it("is not kept for a link the server ends any other deliberate way, 1012 being the only close of its own", async () => {
		let h = await held({ offer: `${FEATURE}, restart-notice` });
		h.server.links.at(-1)!.close(1000, "done");
		expect((await h.raw.closed).code).toBe(1000);
		await until(() => h.server.links.length === 0);
		expect(h.planner.suspended).not.toBe(true);
	});
});

describe("a resumable link that drops", () => {
	it("keeps its open question and live run however long its client is away, and gives them back to the same account", async () => {
		// Installed first, so every timer the server arms is on this clock.
		let clock = laterTimers();
		try {
			let h = await held({ graceMs: 150 });
			expect(h.attached.features).toEqual([FEATURE]);
			await h.drop();
			expect(h.server.attachments.status(h.channel.id)).toEqual({
				state: "disconnected",
				login: "member",
			});
			expect(h.server.attachments.holding(h.channel.id)).toMatchObject({
				attached: false,
				disconnected: true,
			});
			expect(h.server.attachments.waiting(h.channel.id)).toBe(true);
			expect(h.planner.suspended).toBe(true);
			// Real time past the grace period the operator configured, then hours, then a day.
			await Bun.sleep(400);
			for (let passed of [31 * MINUTE, 3 * 60 * MINUTE, 25 * 60 * MINUTE]) {
				await clock.pass(passed);
				expect(h.status()).toBe("open");
				expect(h.runStatus()).toBe("running");
				expect(h.planner.runs?.active).toEqual(["run"]);
				expect(h.planner.suspended).toBe(true);
				expect(h.server.attachments.status(h.channel.id)).toEqual({
					state: "disconnected",
					login: "member",
				});
			}

			let next = await h.reattach();
			await next.next("attached");
			next.send({
				type: "resume",
				sessions: [{ session: h.sessionId, requests: ["ask-1"] }],
			});
			expect(await next.next("resumed")).toEqual({
				type: "resumed",
				sessions: [{ session: h.sessionId, requests: ["ask-1"] }],
			});
			expect(h.planner.suspended).toBe(false);
			expect(h.server.attachments.status(h.channel.id)).toEqual({
				state: "attached",
				login: "member",
			});
			// The same question, not a second card, answers the same request.
			expect(h.f.plan.records.size).toBe(1);
			await h.f.answer(h.card.id, [0]);
			expect(await next.next("input-result")).toEqual({
				type: "input-result",
				request: "ask-1",
				status: "answered",
				value: true,
			});
			next.send({
				type: "runs",
				session: h.sessionId,
				active: [],
				paused: [],
				cards: [{ ...run, status: "finished", ended: 2 }],
			});
			await until(() => h.runStatus() === "finished");
			expect(h.f.plan.records.size).toBe(1);
		} finally {
			clock.restore();
		}
	});

	it("delivers an answer given while the link was down once, when the client resumes", async () => {
		let h = await held();
		await h.drop();
		await h.f.answer(h.card.id, [0]);
		expect(h.status()).toBe("answered");
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		expect(await next.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: h.sessionId, requests: ["ask-1"] }],
		});
		expect(await next.next("input-result")).toMatchObject({
			request: "ask-1",
			status: "answered",
			value: true,
		});
		await Bun.sleep(50);
		expect(next.messages.filter(message => message.type === "input-result")).toEqual([]);
		expect(h.f.plan.records.size).toBe(1);
	});

	it("keeps nothing for another account or for a client that did not ask for the feature", async () => {
		let h = await held();
		await h.drop();
		let rival = await h.reattach(RIVAL_TOKEN);
		let refusal = await rival.next("refused");
		expect(refusal).toMatchObject({
			code: "planner-attached",
			message: "member is connected to this document, and its connection dropped. "
				+ "Its work is kept until it reconnects. A document has one agent connected at a time.",
		});
		expectPlainStatus(String(refusal.message), "a refusal to a client");
		expect(h.status()).toBe("open");
		expect(h.runStatus()).toBe("running");

		let plain = await h.reattach(MEMBER_TOKEN, false);
		expect((await plain.next("attached")).features).toBeUndefined();
		// It cannot claim them, so what the earlier link held ends as it always did.
		await until(() => h.status() === "cancelled");
		expect(h.runStatus()).toBe("stopped");
		expect(h.planner.suspended).toBe(false);
	});

	it("ends what the client does not claim, and what it no longer waits on", async () => {
		let omitted = await held();
		await omitted.drop();
		let first = await omitted.reattach();
		await first.next("attached");
		first.send({ type: "resume", sessions: [] });
		expect(await first.next("resumed")).toEqual({ type: "resumed", sessions: [] });
		await until(() => omitted.status() === "cancelled");
		expect(omitted.runStatus()).toBe("stopped");

		let gaveUp = await held();
		await gaveUp.drop();
		let second = await gaveUp.reattach();
		await second.next("attached");
		second.send({ type: "resume", sessions: [{ session: gaveUp.sessionId, requests: [] }] });
		expect(await second.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: gaveUp.sessionId, requests: [] }],
		});
		await until(() => gaveUp.status() === "cancelled");
		expect(gaveUp.runStatus()).toBe("running");
	});

	it("keeps an answer given before the server noticed the drop, and gives it to the client that returns, with a run", async () => {
		let h = await held({ proxied: true });
		// The client's network is gone and the server has not noticed: the answer goes nowhere.
		h.proxy!.hold();
		await h.f.answer(h.card.id, [0]);
		expect(h.status()).toBe("answered");
		await Bun.sleep(100);
		expect(h.heldInputs.open).toBe(1);
		await h.proxy!.stop();
		await until(() => h.server.links.length === 0);
		expect(h.server.attachments.status(h.channel.id)).toEqual({
			state: "disconnected",
			login: "member",
		});
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		expect(await next.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: h.sessionId, requests: ["ask-1"] }],
		});
		expect(await next.next("input-result")).toMatchObject({
			request: "ask-1",
			status: "answered",
			value: true,
		});
		expect(h.heldInputs.open).toBe(1);
		next.send({ type: "input-received", request: "ask-1" });
		await until(() => h.heldInputs.open === 0);
	});

	it("sends an answer again to the next link when the link it was written to dropped before the client acknowledged it", async () => {
		let h = await held();
		await h.drop();
		await h.f.answer(h.card.id, [0]);
		let second = await h.reattach();
		await second.next("attached");
		second.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await second.next("resumed");
		await second.next("input-result");
		// The network fails before the client reads it, so it never acknowledges.
		second.socket.close();
		await second.closed;
		await until(() => h.server.links.length === 0);
		expect(h.server.attachments.status(h.channel.id)).toEqual({
			state: "disconnected",
			login: "member",
		});
		let third = await h.reattach();
		await third.next("attached");
		third.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await third.next("resumed");
		expect(await third.next("input-result")).toMatchObject({
			request: "ask-1",
			status: "answered",
		});
	});

	it("does not send an answer again to a client that no longer names its request, as one that acknowledged it on a link that then dropped", async () => {
		let h = await held();
		await h.f.answer(h.card.id, [0]);
		expect(await h.raw.next("input-result")).toMatchObject({ request: "ask-1" });
		await h.drop();
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: [] }] });
		expect(await next.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: h.sessionId, requests: [] }],
		});
		await Bun.sleep(80);
		expect(next.messages.filter(message => message.type === "input-result")).toEqual([]);
		await until(() => h.heldInputs.open === 0);
	});

	it("keeps the session of an answer until its client acknowledges it, and ignores an acknowledgement it was not waiting for", async () => {
		let h = await held();
		await h.f.answer(h.card.id, [0]);
		await h.raw.next("input-result");
		await Bun.sleep(100);
		expect(h.heldInputs.open).toBe(1);
		h.raw.send({ type: "input-received", request: "unknown" });
		h.raw.send({ type: "input-received", request: "ask-1" });
		await until(() => h.heldInputs.open === 0);
		h.raw.send({ type: "input-received", request: "ask-1" });
		await Bun.sleep(50);
		expect(h.server.links).toHaveLength(1);
	});

	it("keeps an answer a client never acknowledged, however much it sent after it, and delivers it once to the link that resumes", async () => {
		let h = await held();
		await h.f.answer(h.card.id, [0]);
		await h.raw.next("input-result");
		// A frame that crossed the answer on the wire, or the client's last before its network died.
		h.raw.send({ type: "runs", session: h.sessionId, active: ["run"], paused: [], cards: [run] });
		await Bun.sleep(900);
		expect(h.heldInputs.open).toBe(1);
		expect(h.heldInputs.released).toBe(0);
		await h.drop();
		expect(h.server.attachments.status(h.channel.id)).toEqual({
			state: "disconnected",
			login: "member",
		});
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		expect(await next.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: h.sessionId, requests: ["ask-1"] }],
		});
		expect(await next.next("input-result")).toMatchObject({ request: "ask-1", status: "answered" });
		await Bun.sleep(100);
		expect(next.messages.filter(message => message.type === "input-result")).toEqual([]);
		next.send({ type: "input-received", request: "ask-1" });
		await until(() => h.heldInputs.open === 0);
	});

	it("refuses an acknowledgement from a client that did not offer the feature", async () => {
		let h = await held({ feature: false });
		h.raw.send({ type: "input-received", request: "ask-1" });
		expect(await h.raw.next("error")).toMatchObject({ code: "protocol" });
	});

	it("takes a same-account link's work over when its client returns before the server noticed the drop", async () => {
		let h = await held({ proxied: true });
		h.proxy!.hold();
		await h.f.answer(h.card.id, [0]);
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		expect(await next.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: h.sessionId, requests: ["ask-1"] }],
		});
		expect(await next.next("input-result")).toMatchObject({ request: "ask-1", status: "answered" });
		expect(h.server.attachments.status(h.channel.id)).toEqual({
			state: "attached",
			login: "member",
		});
		expect(h.server.links).toHaveLength(1);
		expect(h.runStatus()).toBe("running");
		expect(h.planner.suspended).toBe(false);
	});

	it("does not take a link over for a resume that names nothing it holds, another first message, or another account", async () => {
		let h = await held();
		let nothing = await h.reattach();
		await nothing.next("attached");
		nothing.send({ type: "resume", sessions: [{ session: "unknown", requests: ["ask-1"] }] });
		expect(await nothing.next("refused")).toMatchObject({ code: "planner-attached" });
		let silent = await h.reattach();
		await silent.next("attached");
		silent.send({ type: "runs", session: h.sessionId, active: [], paused: [], cards: [] });
		expect(await silent.next("refused")).toMatchObject({ code: "planner-attached" });
		let rival = await h.reattach(RIVAL_TOKEN);
		expect(await rival.next("refused")).toMatchObject({ code: "planner-attached" });
		let plain = await h.reattach(MEMBER_TOKEN, false);
		expect(await plain.next("refused")).toMatchObject({ code: "planner-attached" });
		// The link that held it is untouched.
		expect(h.server.attachments.status(h.channel.id)).toEqual({
			state: "attached",
			login: "member",
		});
		expect(h.status()).toBe("open");
		expect(h.runStatus()).toBe("running");
		expect(h.planner.suspended).not.toBe(true);
	});

	it("does not make a link that waited for its first message the Planner of a document archived meanwhile", async () => {
		let h = await held();
		let next = await h.reattach();
		await next.next("attached");
		// The document is archived as main.ts does: storage first, then the attachments.
		await h.auth.storage.channels.archive({ id: h.channel.id, now: new Date() });
		await h.server.attachments.documentEnded(h.channel.id);
		await until(() => h.status() === "cancelled");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		expect(await next.next("refused")).toMatchObject({ code: "document-archived" });
		expect(h.server.attachments.status(h.channel.id)).toEqual({ state: "none" });
	});

	it("leaves a question open and answerable when the server shuts down, as a crash does, whether the link was attached or had dropped before", async () => {
		for (let order of ["shutdown first", "drop first"] as const) {
			let h = await held();
			if (order === "drop first") await h.drop();
			h.server.attachments.shutdown();
			if (order === "shutdown first") await h.drop();
			await h.f.close();
			expect(h.status(), order).toBe("open");
			expect(h.runStatus(), order).toBe("running");
			if (order === "shutdown first") expect(h.planner.suspended).not.toBe(true);
		}
	});

	it("announces a dropped link as disconnected, with no deadline, and its return as attached", async () => {
		let h = await held();
		let changes: string[] = [];
		cleanups.push(
			h.server.attachments.onChange((_, planner) =>
				changes.push(
					planner.state === "held" ? `held until ${planner.until}` : planner.state,
				)
			),
		);
		await h.drop();
		expect(changes).toEqual(["disconnected"]);
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await next.next("resumed");
		expect(changes).toEqual(["disconnected", "attached"]);
	});

	it("is still resumable long after the account's grace period would have ended", async () => {
		let h = await held({ graceMs: 150 });
		await h.drop();
		// Real waiting, well past the configured grace: it bounds a detached link's ownership only.
		await Bun.sleep(500);
		expect(h.status()).toBe("open");
		expect(h.runStatus()).toBe("running");
		expect(h.server.attachments.status(h.channel.id)).toEqual({
			state: "disconnected",
			login: "member",
		});
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		expect(await next.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: h.sessionId, requests: ["ask-1"] }],
		});
		expect(h.status()).toBe("open");
	});

	it("keeps what a link kept when the next link drops before it resumes, still with no deadline", async () => {
		let clock = laterTimers();
		try {
			let h = await held({ graceMs: 150 });
			await h.drop();
			let early = await h.reattach();
			await early.next("attached");
			early.socket.close();
			await early.closed;
			await Bun.sleep(400);
			await clock.pass(25 * 60 * MINUTE);
			expect(h.status()).toBe("open");
			expect(h.runStatus()).toBe("running");
			expect(h.server.attachments.status(h.channel.id)).toEqual({
				state: "disconnected",
				login: "member",
			});
			let next = await h.reattach();
			await next.next("attached");
			next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
			expect((await next.next("resumed")).sessions).toHaveLength(1);
		} finally {
			clock.restore();
		}
	});

	it("is ended by archiving the document, and the Planner it held is released", async () => {
		let h = await held();
		await h.drop();
		await h.server.attachments.documentEnded(h.channel.id);
		await until(() => h.status() === "cancelled");
		expect(h.runStatus()).toBe("stopped");
		expect(h.server.attachments.status(h.channel.id)).toEqual({ state: "none" });
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		expect(await next.next("resumed")).toEqual({ type: "resumed", sessions: [] });
	});

	it("finds nothing to resume on a server that restarted", async () => {
		let h = await held();
		await h.drop();
		// A restarted server has no sessions, hold or ownership; the same account attaches afresh.
		let restarted = linkServer(h.auth, 300, undefined, LONGEST_GRACE);
		cleanups.push(restarted.stop);
		let next = await rawLink(restarted.url, MEMBER_TOKEN, FEATURE);
		next.send({ type: "attach", version: 1, document: h.channel.id });
		cleanups.push(() => next.socket.close());
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		expect(await next.next("resumed")).toEqual({ type: "resumed", sessions: [] });
		expect(restarted.attachments.status(h.channel.id)).toEqual({
			state: "attached",
			login: "member",
		});
		// The client reports its runs again, as after any attach, for a session the server no
		// longer has: the report is ignored, so the stored cards stay as they were restored.
		next.send({ type: "runs", session: h.sessionId, active: ["run"], paused: [], cards: [run] });
		await Bun.sleep(100);
		expect(restarted.links).toHaveLength(1);
		expect(next.messages.filter(message => message.type === "error" || message.type === "refused"))
			.toEqual([]);
	});

	it("is ended at once by a sign-out, a Planner reset, or the client's own detach", async () => {
		for (let ending of ["sign-out", "reset", "detach"] as const) {
			let h = await held();
			if (ending === "detach") h.raw.send({ type: "detach" });
			else await h.drop();
			if (ending === "sign-out") await h.signOut("member");
			if (ending === "reset") h.server.attachments.ownerReset(h.channel.id);
			await until(() => h.status() === "cancelled", 1_500).catch(() => {
				throw new Error(`${ending}: the question stayed ${h.status()}`);
			});
			expect(h.runStatus()).toBe("stopped");
			let next = await h.reattach();
			if (ending === "sign-out") {
				expect(await next.next("refused")).toMatchObject({ code: "sign-in-required" });
				continue;
			}
			await next.next("attached");
			next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
			expect(await next.next("resumed")).toEqual({ type: "resumed", sessions: [] });
		}
	});

	it("holds a Stop made while the link is down and sends it to the client first, once, when it resumes", async () => {
		let h = await held();
		let control = controlOf(h.planner);
		await h.drop();
		// Stop Planner, pressed twice, and one run's pause that Stop Planner already covers.
		await control("stop");
		await control("stop");
		await control("stop", "run");
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		expect(await next.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: h.sessionId, requests: ["ask-1"] }],
		});
		let stop = await next.next("stop");
		expect(stop).toEqual({ type: "stop", request: expect.any(String), session: h.sessionId });
		next.send({ type: "control-result", request: stop.request, ok: true });
		await Bun.sleep(50);
		expect(next.messages.filter(message => message.type === "stop")).toEqual([]);
		// Held no longer: a Stop now goes straight to the client that is back.
		let live = control("stop", "run");
		let direct = await next.next("stop");
		expect(direct).toMatchObject({ session: h.sessionId, run: "run" });
		next.send({ type: "control-result", request: direct.request, ok: true });
		await live;
	});

	it("holds the pause of each named run once, and refuses a Resume it cannot deliver", async () => {
		let h = await held();
		let control = controlOf(h.planner);
		await h.drop();
		await control("stop", "run");
		await control("stop", "run");
		await control("stop", "other");
		await expect(control("resume")).rejects.toThrow();
		await expect(control("resume", "run")).rejects.toThrow();
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await next.next("resumed");
		let first = await next.next("stop");
		let second = await next.next("stop");
		expect([first.run, second.run]).toEqual(["run", "other"]);
		await Bun.sleep(50);
		expect(next.messages.filter(message => ["stop", "resume"].includes(message.type))).toEqual([]);
	});

	it("drops a held Stop with the session when the client does not take the session back", async () => {
		let h = await held();
		await h.drop();
		await controlOf(h.planner)("stop");
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [] });
		expect(await next.next("resumed")).toEqual({ type: "resumed", sessions: [] });
		await Bun.sleep(50);
		expect(next.messages.filter(message => message.type === "stop")).toEqual([]);
		expect(() => controlOf(h.planner)("stop")).toThrow();
	});

	it("sends a Stop again to the next link when the client never answered it before dropping once more", async () => {
		let h = await held();
		await h.drop();
		await controlOf(h.planner)("stop", "run");
		let second = await h.reattach();
		await second.next("attached");
		second.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await second.next("resumed");
		expect(await second.next("stop")).toMatchObject({ session: h.sessionId, run: "run" });
		// The network fails again before `control-result`: the Stop is still owed.
		second.socket.close();
		await second.closed;
		await until(() => h.server.links.length === 0);
		expect(h.planner.suspended).toBe(true);
		let third = await h.reattach();
		await third.next("attached");
		third.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await third.next("resumed");
		let again = await third.next("stop");
		expect(again).toMatchObject({ session: h.sessionId, run: "run" });
		third.send({ type: "control-result", request: again.request, ok: true });
		await Bun.sleep(50);
		expect(third.messages.filter(message => message.type === "stop")).toEqual([]);
	});

	it("holds a Stop the client had not answered when the link dropped, and sends it first, once, when the client resumes", async () => {
		let h = await held();
		let control = controlOf(h.planner);
		// The client has the Stop, and the network fails before it answers.
		let stopping = control("stop").then(outcome => outcome, error => error);
		let original = await h.raw.next("stop");
		await h.drop();
		// Not lost, and not reported as done: the caller learns the Stop waits for the client's return.
		expect(await stopping).toBe("held");
		// The same Stop pressed again while the link is down is one Stop, not two.
		expect(await control("stop")).toBe("held");
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await next.next("resumed");
		let again = await next.next("stop");
		expect(again).toEqual({ type: "stop", request: expect.any(String), session: h.sessionId });
		expect(again.request).not.toBe(original.request);
		next.send({ type: "control-result", request: again.request, ok: true });
		await Bun.sleep(50);
		expect(next.messages.filter(message => message.type === "stop")).toEqual([]);
	});

	it("holds the pause of a run the client had not answered, once, with the pauses made while the link is down", async () => {
		let h = await held();
		let control = controlOf(h.planner);
		let pausing = control("stop", "run").then(outcome => outcome, error => error);
		await h.raw.next("stop");
		await h.drop();
		expect(await pausing).toBe("held");
		expect(await control("stop", "run")).toBe("held");
		expect(await control("stop", "other")).toBe("held");
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await next.next("resumed");
		let first = await next.next("stop");
		let second = await next.next("stop");
		expect([first.run, second.run]).toEqual(["run", "other"]);
		await Bun.sleep(50);
		expect(next.messages.filter(message => message.type === "stop")).toEqual([]);
	});

	it("keeps a Stop the client did not answer in time for a link that drops after it, and sends it when the client resumes", async () => {
		let h = await held();
		// The link is attached and the client silent, so the wait for its answer runs out.
		expect(await controlOf(h.planner)("stop", "run")).toBe("unconfirmed");
		await h.raw.next("stop");
		await h.drop();
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await next.next("resumed");
		expect(await next.next("stop")).toMatchObject({ session: h.sessionId, run: "run" });
	});

	it("does not keep a Stop the client answered after the wait for it ended, nor send it again after a drop", async () => {
		let h = await held();
		let stopping = controlOf(h.planner)("stop");
		let stop = await h.raw.next("stop");
		expect(await stopping).toBe("unconfirmed");
		h.raw.send({ type: "control-result", request: stop.request, ok: true });
		await Bun.sleep(100);
		await h.drop();
		expect(h.planner.keptStop).toBe(false);
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await next.next("resumed");
		await Bun.sleep(150);
		expect(next.messages.filter(message => message.type === "stop")).toEqual([]);
	});

	it("does not keep a Stop the client refused after the wait for it ended", async () => {
		let h = await held();
		let stopping = controlOf(h.planner)("stop", "run");
		let stop = await h.raw.next("stop");
		expect(await stopping).toBe("unconfirmed");
		h.raw.send({ type: "control-result", request: stop.request, ok: false, message: "ended" });
		await Bun.sleep(100);
		await h.drop();
		expect(h.planner.keptStop).toBe(false);
	});

	it("does not keep the Stops split from a Stop of every run once the client answers it, after a Resume of another run", async () => {
		let h = await held();
		h.raw.send({
			type: "runs",
			session: h.sessionId,
			active: ["run"],
			paused: ["run-2"],
			cards: [run, { ...run, id: "run-2", name: "second", status: "paused" as const }],
		});
		await until(() => h.planner.runs?.paused.length === 1);
		let control = controlOf(h.planner);
		let stopping = control("stop");
		let stop = await h.raw.next("stop");
		let resuming = control("resume", "run-2");
		let resume = await h.raw.next("resume");
		h.raw.send({ type: "control-result", request: resume.request, ok: true });
		await resuming;
		h.raw.send({ type: "control-result", request: stop.request, ok: true });
		expect(await stopping).toBeUndefined();
		await h.drop();
		expect(h.planner.keptStop).toBe(false);
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await next.next("resumed");
		await Bun.sleep(150);
		expect(next.messages.filter(message => message.type === "stop")).toEqual([]);
	});

	it("does not send again a Stop the client answered, or refused because its run had ended", async () => {
		let h = await held();
		let control = controlOf(h.planner);
		let answered = control("stop", "answered");
		let sent = await h.raw.next("stop");
		h.raw.send({ type: "control-result", request: sent.request, ok: true });
		await answered;
		let refused = control("stop", "refused").then(outcome => outcome, error => error);
		sent = await h.raw.next("stop");
		h.raw.send({ type: "control-result", request: sent.request, ok: false, message: "ended" });
		expect(await refused).toMatchObject({ message: "ended" });

		await h.drop();
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await next.next("resumed");
		await Bun.sleep(100);
		expect(next.messages.filter(message => message.type === "stop")).toEqual([]);
	});

	it("does not send again a Stop the client never answered once it has answered a Resume sent after it", async () => {
		let h = await held();
		let control = controlOf(h.planner);
		expect(await control("stop", "undone")).toBe("unconfirmed");
		await h.raw.next("stop");
		let resuming = control("resume", "undone");
		let sent = await h.raw.next("resume");
		h.raw.send({ type: "control-result", request: sent.request, ok: true });
		await resuming;

		await h.drop();
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await next.next("resumed");
		await Bun.sleep(100);
		expect(next.messages.filter(message => ["stop", "resume"].includes(message.type))).toEqual([]);
	});

	it("keeps an unanswered Stop of one run when a Resume of a different run is answered", async () => {
		let h = await held();
		let control = controlOf(h.planner);
		expect(await control("stop", "stopped-run")).toBe("unconfirmed");
		await h.raw.next("stop");
		let resuming = control("resume", "resumed-run");
		let sent = await h.raw.next("resume");
		h.raw.send({ type: "control-result", request: sent.request, ok: true });
		await resuming;

		await h.drop();
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await next.next("resumed");
		expect(await next.next("stop")).toMatchObject({ session: h.sessionId, run: "stopped-run" });
		await Bun.sleep(100);
		expect(next.messages.filter(message => message.type === "stop")).toEqual([]);
	});

	it("keeps an unanswered Stop of every run for the runs a Resume of one run did not cover", async () => {
		let h = await held();
		h.raw.send({
			type: "runs",
			session: h.sessionId,
			active: ["run", "other"],
			paused: [],
			cards: [run, { ...run, id: "other", name: "other" }],
		});
		await until(() => h.planner.runs?.active.length === 2);
		let control = controlOf(h.planner);
		expect(await control("stop")).toBe("unconfirmed");
		await h.raw.next("stop");
		let resuming = control("resume", "run");
		let sent = await h.raw.next("resume");
		h.raw.send({ type: "control-result", request: sent.request, ok: true });
		await resuming;

		await h.drop();
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await next.next("resumed");
		// The Stop stands for the run still running, and no longer for the one a person resumed.
		expect(await next.next("stop")).toMatchObject({ session: h.sessionId, run: "other" });
		await Bun.sleep(100);
		expect(next.messages.filter(message => message.type === "stop")).toEqual([]);
	});

	it("does not hold a Resume the client had not answered when the link dropped, which cannot be promised", async () => {
		let h = await held();
		let resuming = controlOf(h.planner)("resume").then(outcome => outcome, error => error);
		await h.raw.next("resume");
		await h.drop();
		expect(await resuming).toMatchObject({ message: "The agent connection closed." });
		let next = await h.reattach();
		await next.next("attached");
		next.send({ type: "resume", sessions: [{ session: h.sessionId, requests: ["ask-1"] }] });
		await next.next("resumed");
		await Bun.sleep(100);
		expect(next.messages.filter(message => ["stop", "resume"].includes(message.type))).toEqual([]);
	});
});
