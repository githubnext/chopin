import { afterEach, expect, it } from "bun:test";
import { AgentRefused, connectAgent } from "@chopin/agent-link/client";

import {
	cuttableProxy,
	linkAuth,
	linkServer,
	MEMBER_TOKEN,
	RIVAL_TOKEN,
} from "../../testing/agent-link";
import { hostInputRoom } from "../../testing/decisions";
import { createHumanInput } from "../atomic/human-input";
import { untilUnpaused } from "../atomic/full";
import { createRemoteAdapter } from "./adapter";

import type { AgentHandlers } from "@chopin/agent-link/client";
import type { RemotePlanner } from "./registry";

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
 * The package client attached through a proxy, with one question open. The server notices a
 * silent link after 600 ms here, where production waits 120 s.
 */
async function waiting() {
	let f = await hostInputRoom();
	cleanups.push(f.close);
	let { auth, channel, revocations } = await linkAuth();
	let server = linkServer(auth, 300, undefined, 150, { pingEveryMs: 100, pongTimeoutMs: 600 });
	cleanups.push(server.stop);
	revocations.add(id => server.attachments.sessionRevoked(id));
	let proxy = await cuttableProxy(server.url);
	cleanups.push(() => proxy.stop());
	let handlers = { turn() {} } as AgentHandlers;
	let client = await connectAgent({
		url: proxy.url,
		token: MEMBER_TOKEN,
		document: channel.id,
		handlers,
	});
	let planner: RemotePlanner = { channelId: channel.id, isolated: false };
	planner.humanInput = report =>
		createHumanInput(f.room, (runId, signal) => untilUnpaused(planner, runId, signal), report);
	let sessionId = crypto.randomUUID();
	let opening = createRemoteAdapter(() => ({ link: server.links.at(-1)!, planner })).doStart({
		sessionId,
		sandboxSession,
		sessionWorkDir: "/tmp",
	});
	let session = await opening;
	cleanups.push(() => session.doDestroy());
	let outcome: { status: string; value?: unknown } | undefined;
	let asked = client.ask(sessionId, { method: "confirm", title: "Ship?", message: "Now." });
	void asked.then(value => outcome = value);
	let [card] = await f.cards(1);
	let connect = (resume: Awaited<typeof client.resumption>) =>
		connectAgent({ url: server.url, token: MEMBER_TOKEN, document: channel.id, handlers, resume });
	return {
		f,
		server,
		proxy,
		client,
		channel,
		card: card!,
		sessionId,
		connect,
		outcome: () => outcome,
	};
}

it("takes the work of a link whose client noticed the drop first, when it reconnects at once, and delivers an answer given after", async () => {
	let w = await waiting();
	w.proxy.cut();
	let resumption = await w.client.resumption;
	expect(resumption).toBeDefined();
	// The server still counts the dead link as attached: it cannot tell the client left.
	expect(w.server.attachments.attached(w.channel.id)).toBe(true);
	let back = await w.connect(resumption);
	cleanups.push(() => back.detach());
	expect(w.server.attachments.status(w.channel.id)).toEqual({ state: "attached", login: "member" });
	expect(w.f.plan.records.get(w.card.id)?.status).toBe("open");
	await w.f.answer(w.card.id, [0]);
	await until(() => w.outcome() !== undefined);
	expect(w.outcome()).toMatchObject({ status: "answered", value: true });
});

it("delivers an answer given while the client was reconnecting after the server noticed the drop", async () => {
	let w = await waiting();
	w.proxy.cut();
	let resumption = await w.client.resumption;
	await until(() => w.server.attachments.status(w.channel.id).state === "disconnected", 5_000);
	await w.f.answer(w.card.id, [0]);
	let back = await w.connect(resumption);
	cleanups.push(() => back.detach());
	await until(() => w.outcome() !== undefined);
	expect(w.outcome()).toMatchObject({ status: "answered", value: true });
});

it("settles the questions of a client that another account's hold refuses, and does not tell it to retry", async () => {
	let w = await waiting();
	w.proxy.cut();
	let resumption = await w.client.resumption;
	await until(() => w.server.attachments.status(w.channel.id).state === "disconnected", 5_000);
	// The owner's work was ended on purpose, and another account took the document.
	w.server.attachments.ownerReset(w.channel.id);
	await until(() => w.f.plan.records.get(w.card.id)?.status === "cancelled");
	let rival = await connectAgent({
		url: w.server.url,
		token: RIVAL_TOKEN,
		document: w.channel.id,
		handlers: { turn() {} },
	});
	cleanups.push(() => rival.detach());
	let refusal = await w.connect(resumption).then(() => undefined, (error: unknown) => error);
	expect(refusal).toBeInstanceOf(AgentRefused);
	expect(refusal).toMatchObject({ code: "planner-attached", retry: false });
	await until(() => w.outcome() !== undefined);
	expect(w.outcome()).toMatchObject({ status: "cancelled" });
});
