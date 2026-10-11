import { afterEach, describe, expect, it } from "bun:test";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { tool } from "ai";
import { z } from "zod";
import { LINK_CLOSE, MAX_LINK_MESSAGE_BYTES, PLANNER_LINK_VERSION } from "@chopin/planner-link";
import { PlannerLinkRefused } from "@chopin/planner-link/client";

import { GitHubError } from "../../github/client";
import * as Store from "../../questions/store";
import { createHumanInput } from "../atomic/human-input";
import { untilUnpaused } from "../atomic/full";
import { hostInputRoom } from "../../testing/decisions";
import {
	attach,
	DENIED_TOKEN,
	finishTurn,
	linkAuth,
	linkServer,
	OUTSIDER_TOKEN,
	rawLink,
	READER_TOKEN,
	scriptedPlanner,
} from "../../testing/planner-link";
import { createRemoteAdapter } from "./adapter";

import type { PlannerLinkClient, PlannerLinkHandlers } from "@chopin/planner-link/client";
import type { RemotePlanner } from "./registry";

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function setup(handlers?: Partial<PlannerLinkHandlers>) {
	let { auth, storage, channel } = await linkAuth();
	let server = linkServer(auth, 300);
	cleanups.push(server.stop);
	let script = scriptedPlanner();
	let client: PlannerLinkClient | undefined;
	if (handlers !== undefined) {
		client = await attach(server.url, channel.id, { ...script.handlers, ...handlers });
		cleanups.push(() => client!.detach());
	}
	return { auth, storage, channel, server, script, client: client! };
}

function adapterFor(server: ReturnType<typeof linkServer>, planner: RemotePlanner) {
	return createRemoteAdapter(() => ({ link: server.links.at(-1)!, planner }));
}

const sandboxSession = {
	defaultWorkingDirectory: "/tmp",
	async run() {
		return { exitCode: 0, stdout: "", stderr: "" };
	},
	async destroy() {},
} as never;

function agentFor(harness: ReturnType<typeof createRemoteAdapter>) {
	return new HarnessAgent({
		harness,
		tools: { read_plan: tool({ inputSchema: z.object({}), execute: async () => "the plan" }) },
		activeTools: ["read_plan"],
		permissionMode: "allow-reads",
	});
}

/** Streams one turn to its end, returning its parts and any error it ended with. */
async function streamTurn(harness: ReturnType<typeof createRemoteAdapter>, prompt: string) {
	let agent = agentFor(harness);
	let session = await agent.createSession({ sandboxSession });
	cleanups.push(() => session.destroy());
	let parts: { type: string; [key: string]: unknown }[] = [];
	let failure: unknown;
	try {
		let result = await agent.stream({ session, prompt });
		for await (let part of result.fullStream) parts.push(part as never);
	} catch (error) {
		failure = error;
	}
	let errors = parts.filter(part => part.type === "error").map(part => String(part.error));
	if (failure) errors.push(String(failure));
	return { parts, errors, session };
}

function upgradeRequest(url: string, headers: Record<string, string> = {}) {
	return fetch(`${url}/planner-link`, {
		headers: {
			connection: "Upgrade",
			upgrade: "websocket",
			"sec-websocket-version": "13",
			"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			...headers,
		},
	});
}

describe("Planner link admission", () => {
	it("checks the bearer as hosted MCP does and upgrades nothing it refuses", async () => {
		let { server, channel } = await setup();
		let missing = await upgradeRequest(server.url);
		expect(missing.status).toBe(401);
		expect(missing.headers.get("www-authenticate")).toBe("Bearer");
		expect((await upgradeRequest(server.url, { authorization: "Bearer bad-token" })).status)
			.toBe(401);
		expect((await upgradeRequest(server.url, { authorization: `Bearer ${DENIED_TOKEN}` })).status)
			.toBe(403);
		expect(
			(await upgradeRequest(server.url, {
				authorization: `Bearer ${READER_TOKEN}`,
				origin: "https://elsewhere.test",
			})).status,
		).toBe(403);
		await expect(attach(server.url, channel.id, scriptedPlanner().handlers, "bad-token"))
			.rejects.toThrow("closed before attaching");
		expect(server.links).toEqual([]);
	});

	it("refuses a repository the caller cannot read, a missing or archived document, and another version", async () => {
		let { server, channel, storage } = await setup();
		let before = await storage.channels.get(channel.id);
		let refusal = (token: string, document: string) =>
			attach(server.url, document, scriptedPlanner().handlers, token).then(
				() => undefined,
				(error: PlannerLinkRefused) => error.code,
			);
		expect(await refusal(OUTSIDER_TOKEN, channel.id)).toBe("repository-forbidden");
		expect(await refusal(READER_TOKEN, crypto.randomUUID())).toBe("document-unavailable");
		let raw = await rawLink(server.url);
		raw.send({ type: "attach", version: PLANNER_LINK_VERSION + 1, document: channel.id });
		expect(await raw.next("refused")).toMatchObject({ code: "unsupported-version" });
		expect((await raw.closed).code).toBe(LINK_CLOSE.unsupportedVersion);
		expect(await storage.channels.get(channel.id)).toEqual(before);
		await storage.channels.archive({ id: channel.id, now: new Date() });
		expect(await refusal(READER_TOKEN, channel.id)).toBe("document-archived");
		expect(server.links).toEqual([]);
	});

	it("attaches a reader to the document by id or URL", async () => {
		let { server, channel } = await setup();
		let client = await attach(server.url, channel.id, scriptedPlanner().handlers);
		expect(client.document).toEqual({
			id: channel.id,
			title: "Linked document",
			repository: "octo-org/score",
			url: `https://chopin.test/documents/octo-org/score/${channel.slug}`,
		});
		let byUrl = await attach(server.url, client.document.url!, scriptedPlanner().handlers);
		expect(byUrl.document.id).toBe(channel.id);
		expect(server.links.map(link => link.channelId)).toEqual([channel.id, channel.id]);
		await byUrl.detach();
		await client.detach();
		expect(server.links).toEqual([]);
	});
});

describe("Planner link protocol", () => {
	it("closes the link on malformed or out-of-order messages", async () => {
		let { server, channel } = await setup();
		for (
			let [frames, code] of [
				[["not json"], "malformed-message"],
				[[{ type: "attach", version: 1, document: channel.id, extra: true }], "malformed-message"],
				[[{ type: "started", session: "s" }], "protocol"],
				[[
					{ type: "attach", version: 1, document: channel.id },
					{ type: "attach", version: 1, document: channel.id },
				], "protocol"],
			] as const
		) {
			let raw = await rawLink(server.url);
			for (let frame of frames) raw.send(frame);
			expect(await raw.next("error")).toMatchObject({ code });
			expect((await raw.closed).code).toBe(LINK_CLOSE.malformed);
		}
		expect(server.links).toEqual([]);
	});

	it("closes the link on an oversized message", async () => {
		let { server } = await setup();
		let raw = await rawLink(server.url);
		raw.send(JSON.stringify({ type: "detach", padding: "x".repeat(MAX_LINK_MESSAGE_BYTES) }));
		expect(await raw.next("error")).toMatchObject({ code: "message-too-large" });
		expect((await raw.closed).code).toBe(LINK_CLOSE.tooLarge);
	});

	it("ends the turn with an error when the client disconnects mid-turn", async () => {
		let { server, channel } = await setup();
		let raw = await rawLink(server.url);
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let planner: RemotePlanner = { channelId: channel.id, isolated: false };
		let harness = adapterFor(server, planner);
		let started = (async () => {
			let start = await raw.next("start");
			raw.send({ type: "started", session: start.session });
			await raw.next("turn");
			raw.socket.close();
		})();
		let outcome = await streamTurn(harness, "hang");
		await started;
		expect(outcome.errors.join("\n")).toContain("disconnected during the turn");
		expect(outcome.session.hasUnfinishedTurn()).toBe(false);
		expect(server.links).toEqual([]);
	});

	it("stops the runs a dropped link reported, so nothing waits on them", async () => {
		let { server, channel, client } = await setup({});
		let planner: RemotePlanner = { channelId: channel.id, isolated: false };
		let reports: unknown[] = [];
		planner.onRuns = runs => reports.push(runs);
		let session = await adapterFor(server, planner).doStart({
			sessionId: "runs",
			sandboxSession,
			sessionWorkDir: "/tmp",
		});
		cleanups.push(() => session.doDestroy());
		let card = {
			id: "run",
			name: "plan",
			status: "running" as const,
			started: 1,
			updated: 1,
			stages: [],
			waiting: 0,
		};
		let done = { ...card, id: "done", status: "finished" as const, ended: 2 };
		client.reportRuns("runs", { active: ["run"], paused: [], cards: [card, done] });
		await Bun.sleep(20);
		expect(planner.runs?.active).toEqual(["run"]);
		await client.detach();
		await Bun.sleep(20);
		expect(planner.runs).toEqual({
			active: [],
			paused: [],
			cards: [{ ...card, status: "stopped" }, done],
		});
		expect(reports).toHaveLength(2);
	});

	it("runs Chopin's tools in the server and the client's own tools only once declared", async () => {
		let reports: unknown[] = [];
		let { server, channel } = await setup({
			async turn(context) {
				let host = await context.callHostTool("read_plan", {});
				let undeclared = context.message.prompt === "undeclared";
				if (!undeclared) context.offerTools(["bash"]);
				context.emit({
					type: "tool-call",
					toolCallId: "own-1",
					toolName: "bash",
					input: "{}",
					providerExecuted: true,
				});
				context.emit({
					type: "tool-result",
					toolCallId: "own-1",
					toolName: "bash",
					result: host.output as string,
				});
				finishTurn(context);
			},
		});
		let planner: RemotePlanner = {
			channelId: channel.id,
			isolated: false,
			toolReport: (...report) => reports.push(report),
		};
		let declared = await streamTurn(adapterFor(server, planner), "declared");
		expect(declared.errors).toEqual([]);
		expect(declared.parts.filter(part => part.type === "tool-result").map(part => part.output))
			.toEqual(["the plan", "the plan"]);
		expect(planner.activeTools).toEqual(["read_plan", "bash"]);
		expect(reports).toEqual([["own-1", "the plan", "done"]]);
		let undeclared = await streamTurn(adapterFor(server, planner), "undeclared");
		expect(undeclared.errors.join("\n")).toContain("Planner tool boundary failure: bash");
		let isolated = await streamTurn(
			adapterFor(server, { channelId: channel.id, isolated: true }),
			"declared",
		);
		expect(isolated.errors.join("\n")).toContain("An isolated Planner turn cannot offer bash");
	});

	it("fails a session the client refuses or never starts, and tells it to let go", async () => {
		let destroyed: string[] = [];
		let { server, channel } = await setup({
			async start(message) {
				if (message.session === "refused") throw new Error("busy elsewhere");
				await Bun.sleep(1_000);
			},
			destroy(message) {
				destroyed.push(message.session);
			},
		});
		let harness = adapterFor(server, { channelId: channel.id, isolated: false });
		let start = (sessionId: string) =>
			harness.doStart({ sessionId, sandboxSession, sessionWorkDir: "/tmp" });
		await expect(start("refused")).rejects.toThrow("refused the session: busy elsewhere");
		await expect(start("silent")).rejects.toThrow("did not start the session");
		await Bun.sleep(20);
		expect(destroyed).toEqual(["refused", "silent"]);
	});

	it("carries Stop and Resume to the client and reports a refusal", async () => {
		let controls: unknown[] = [];
		let { server, channel } = await setup({
			control(message) {
				controls.push({ type: message.type, run: message.run });
				if (message.type === "resume") throw new Error("nothing to resume");
			},
		});
		let planner: RemotePlanner = { channelId: channel.id, isolated: false };
		let session = await adapterFor(server, planner).doStart({
			sessionId: crypto.randomUUID(),
			sandboxSession,
			sessionWorkDir: "/tmp",
		});
		cleanups.push(() => session.doDestroy());
		await planner.control!("stop", "run-1");
		await expect(planner.control!("resume")).rejects.toThrow("nothing to resume");
		expect(controls).toEqual([{ type: "stop", run: "run-1" }, { type: "resume", run: undefined }]);
		await session.doDestroy();
		expect(planner.control).toBeUndefined();
	});

	it("rechecks the caller's access before every session and detaches one that lost it", async () => {
		let { server, channel, auth } = await setup({});
		let planner: RemotePlanner = { channelId: channel.id, isolated: false };
		let harness = adapterFor(server, planner);
		let first = await harness.doStart({
			sessionId: "first",
			sandboxSession,
			sessionWorkDir: "/tmp",
		});
		await first.doDestroy();
		auth.github.repository = async () => {
			throw new GitHubError("Not Found", 404);
		};
		await expect(harness.doStart({ sessionId: "second", sandboxSession, sessionWorkDir: "/tmp" }))
			.rejects.toThrow("can no longer read this document");
		expect(server.links).toEqual([]);
	});
});

describe("Planner link questions", () => {
	async function questions(options: { expiresInMs?: number; isolated?: boolean } = {}) {
		let f = await hostInputRoom(options.expiresInMs);
		cleanups.push(f.close);
		let { server, channel, client } = await setup({});
		let planner: RemotePlanner = { channelId: channel.id, isolated: options.isolated ?? false };
		if (!options.isolated) {
			planner.humanInput = report =>
				createHumanInput(
					f.room,
					options.expiresInMs,
					(runId, signal) => untilUnpaused(planner, runId, signal),
					report,
				);
		}
		let sessionId = crypto.randomUUID();
		let session = await adapterFor(server, planner).doStart({
			sessionId,
			sandboxSession,
			sessionWorkDir: "/tmp",
		});
		cleanups.push(() => session.doDestroy());
		return { f, client, sessionId, planner, session };
	}

	let params = {
		questions: [{
			header: "Choice",
			question: "  Which store?  ",
			options: [
				{ label: " Postgres ", description: "  durable  ", preview: "create table" },
				{ label: "Memory", description: "fast" },
			],
		}],
	};

	it("asks the client's question as a Decision, verbatim, and returns the member's answer", async () => {
		let { f, client, sessionId } = await questions();
		let asked = client.ask(sessionId, { method: "questionnaire", params });
		let [card] = await f.cards(1);
		expect(card!.definition.questions[0]).toMatchObject({
			header: "Choice",
			question: "  Which store?  ",
			options: [
				{ label: " Postgres ", description: "  durable  \n\ncreate table" },
				{ label: "Memory", description: "fast" },
			],
		});
		await f.answer(card!.id, [0]);
		expect(await asked).toMatchObject({
			status: "answered",
			value: {
				cancelled: false,
				answers: [{
					questionIndex: 0,
					question: "  Which store?  ",
					kind: "option",
					answer: " Postgres ",
					preview: "create table",
				}],
			},
		});
		let confirm = client.ask(sessionId, { method: "confirm", title: "Ship?", message: "Now." });
		let [prompt] = await f.cards(1);
		await f.answer(prompt!.id, [0]);
		expect(await confirm).toMatchObject({ status: "answered", value: true });
	});

	it("expires an unanswered question and leaves its card in Decisions marked expired", async () => {
		let { f, client, sessionId } = await questions({ expiresInMs: 30 });
		let asked = await client.ask(sessionId, { method: "questionnaire", params });
		expect(asked).toMatchObject({ status: "expired", value: { answers: [], cancelled: true } });
		let records = [...f.plan.records.values()];
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ status: "expired", resolver: "chopin" });
	});

	it("withdraws the cards when the client cancels or the session ends", async () => {
		let { f, client, sessionId, session } = await questions();
		let controller = new AbortController();
		let asked = client.ask(sessionId, { method: "questionnaire", params }, {
			signal: controller.signal,
		});
		let [card] = await f.cards(1);
		controller.abort();
		expect(await asked).toMatchObject({ status: "cancelled" });
		expect(f.plan.records.get(card!.id)).toMatchObject({ status: "cancelled" });
		let pending = client.ask(sessionId, { method: "select", title: "Pick", choices: ["a", "b"] });
		let [second] = await f.cards(1);
		await session.doDestroy();
		expect(await pending).toMatchObject({ status: "cancelled" });
		expect(f.plan.records.get(second!.id)).toMatchObject({ status: "cancelled" });
		expect(Store.outstanding(f.plan.questions)).toHaveLength(0);
	});

	it("holds a workflow answer until the client reports its root run unpaused", async () => {
		let { f, client, sessionId, planner } = await questions();
		client.reportRuns(sessionId, { active: [], paused: ["root"], cards: [] });
		await Bun.sleep(20);
		expect(planner.runs?.paused).toEqual(["root"]);
		let settled = false;
		let asked = client.ask(sessionId, { method: "questionnaire", params }, {
			workflowRunId: "stage-run",
			rootRunId: "root",
		}).then(result => {
			settled = true;
			return result;
		});
		let [card] = await f.cards(1);
		await f.answer(card!.id, [1]);
		await Bun.sleep(30);
		expect(settled).toBe(false);
		client.reportRuns(sessionId, { active: ["root"], paused: [], cards: [] });
		expect(await asked).toMatchObject({
			status: "answered",
			value: { answers: [{ kind: "option", answer: "Memory" }] },
		});
	});

	it("gives an isolated session no Decisions", async () => {
		let { f, client, sessionId } = await questions({ isolated: true });
		expect(await client.ask(sessionId, { method: "questionnaire", params })).toMatchObject({
			status: "failed",
			message: "Decisions are not available to this session.",
		});
		expect(Store.outstanding(f.plan.questions)).toHaveLength(0);
	});
});
