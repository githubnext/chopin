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
import { createRemoteAdapter } from "./adapter";
import { testLease } from "../../storage/contract-support";

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

async function until(check: () => boolean, ms = 4_000) {
	for (let deadline = Date.now() + ms; Date.now() < deadline; await Bun.sleep(5)) {
		if (check()) return;
	}
	throw new Error("the condition did not hold in time");
}

/**
 * A client attached as a document's Planner that offers `resumable-sessions`, with one Planner
 * session waiting on one question a member has not answered.
 */
async function held(
	options: {
		graceMs?: number;
		feature?: boolean;
		/** The whole `Chopin-Agent-Features` header, where the test offers more than the one. */
		offer?: string;
		proxied?: boolean;
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
	planner.humanInput = report => createHumanInput(f.room, report);
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
	it("keeps its open question however long its client is away, and gives it back to the same account", async () => {
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

		let plain = await h.reattach(MEMBER_TOKEN, false);
		expect((await plain.next("attached")).features).toBeUndefined();
		// It cannot claim them, so what the earlier link held ends as it always did.
		await until(() => h.status() === "cancelled");
		expect(h.planner.suspended).toBe(false);
	});

	it("keeps nothing once its question is answered and the answer acknowledged: the drop runs the grace period", async () => {
		let h = await held();
		await h.f.answer(h.card.id, [0]);
		await h.raw.next("input-result");
		h.raw.send({ type: "input-received", request: "ask-1" });
		await until(() => h.heldInputs.open === 0);
		await h.drop();
		expect(h.server.attachments.status(h.channel.id)).toMatchObject({
			state: "held",
			login: "member",
		});
		expect(h.planner.suspended).not.toBe(true);
	});

	it("ends what the client does not claim, and what it no longer waits on", async () => {
		let omitted = await held();
		await omitted.drop();
		let first = await omitted.reattach();
		await first.next("attached");
		first.send({ type: "resume", sessions: [] });
		expect(await first.next("resumed")).toEqual({ type: "resumed", sessions: [] });
		await until(() => omitted.status() === "cancelled");

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
	});

	it("keeps an answer given before the server noticed the drop, and gives it to the client that returns", async () => {
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
		h.raw.send({ type: "control-result", request: "unknown", ok: true });
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
		silent.send({ type: "control-result", request: "unknown", ok: true });
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
		expect(h.planner.suspended).not.toBe(true);
	});

	it("does not make a link that waited for its first message the Planner of a document archived meanwhile", async () => {
		let h = await held();
		let next = await h.reattach();
		await next.next("attached");
		// The document is archived as main.ts does: storage first, then the attachments.
		await h.auth.storage.channels.archive({
			id: h.channel.id,
			now: new Date(),
			lease: await testLease(h.auth.storage),
		});
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
});
