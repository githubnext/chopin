import { afterEach, describe, expect, it } from "bun:test";

import { connectAgent } from "./client";
import { MAX_LINK_MESSAGE_BYTES, MAX_LINK_NOTE_LENGTH, parseClientMessage } from "./protocol";

import type { ServerWebSocket } from "bun";
import type { AgentHandlers, HostToolResult, TurnContext } from "./client";
import type { ClientMessage, ServerMessage } from "./protocol";

let stops: Array<() => unknown> = [];
afterEach(async () => {
	for (let stop of stops.splice(0)) await stop();
});

/** A server that speaks only the wire format, so each test drives the client frame by frame. */
function fakeServer(options: { features?: string[] } = {}) {
	let socket: ServerWebSocket<unknown> | undefined;
	let received: ClientMessage[] = [];
	let upgrades: Array<{ path: string; subprotocol: string | null; authorization: string | null }> =
		[];
	let asked: Array<string | null> = [];
	let arrivals = new Set<() => void>();
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, self) {
			let subprotocol = request.headers.get("sec-websocket-protocol");
			asked.push(request.headers.get("chopin-agent-features"));
			upgrades.push({
				path: new URL(request.url).pathname,
				subprotocol,
				authorization: request.headers.get("authorization"),
			});
			let headers = subprotocol ? { "sec-websocket-protocol": subprotocol } : undefined;
			return self.upgrade(request, { data: undefined, headers })
				? undefined
				: new Response("upgrade failed", { status: 400 });
		},
		websocket: {
			open(ws) {
				socket = ws;
			},
			message(ws, raw) {
				let parsed = parseClientMessage(String(raw));
				if (!parsed.ok) throw new Error(parsed.message);
				received.push(parsed.message);
				if (parsed.message.type === "attach") {
					ws.send(JSON.stringify({
						type: "attached",
						version: 1,
						document: { id: "d", title: "T", repository: "o/r" },
						...(options.features ? { features: options.features } : {}),
					}));
				}
				for (let wake of arrivals) wake();
			},
		},
	});
	stops.push(() => server.stop(true));
	async function next<T extends ClientMessage["type"]>(
		type: T,
	): Promise<Extract<ClientMessage, { type: T }>> {
		for (let deadline = Date.now() + 2_000; Date.now() < deadline;) {
			let index = received.findIndex(message => message.type === type);
			if (index >= 0) return received.splice(index, 1)[0] as Extract<ClientMessage, { type: T }>;
			await new Promise<void>(resolve => {
				let wake = () => {
					arrivals.delete(wake);
					resolve();
				};
				arrivals.add(wake);
				setTimeout(wake, 50);
			});
		}
		throw new Error(`no ${type} message arrived`);
	}
	return {
		url: `http://127.0.0.1:${server.port}`,
		received,
		upgrades,
		asked,
		next,
		send: (message: ServerMessage | string) =>
			socket!.send(typeof message === "string" ? message : JSON.stringify(message)),
		close: () => socket!.close(1000, "gone"),
	};
}

async function connect(server: ReturnType<typeof fakeServer>, handlers: AgentHandlers) {
	let client = await connectAgent({ url: server.url, token: "t", document: "d", handlers });
	stops.push(() => client.detach());
	return client;
}

const turn = (id: string) => ({
	type: "turn" as const,
	session: "s",
	turn: id,
	prompt: "p",
	tools: [{ name: "read_plan" }],
});

describe("Agent connection client", () => {
	it("opens /api/v1/agent offering chopin.agent.v1, with the bearer", async () => {
		let server = fakeServer();
		await connect(server, { turn() {} });
		expect(server.upgrades).toEqual([
			{ path: "/api/v1/agent", subprotocol: "chopin.agent.v1", authorization: "Bearer t" },
		]);
	});

	it("asks for stage deltas and splits a report too large for one frame across several", async () => {
		let server = fakeServer({ features: ["run-stage-deltas"] });
		let client = await connect(server, { turn() {} });
		expect(server.asked).toEqual([
			"run-stage-deltas, decision-option-previews, resumable-sessions, restart-notice",
		]);
		expect(client.features).toEqual(["run-stage-deltas"]);
		let stages = Array.from({ length: 2_000 }, (_, index) => ({
			id: `s${index}`,
			name: `${index} ${"é".repeat(MAX_LINK_NOTE_LENGTH - 8)}`,
			status: "completed" as const,
			...(index ? { parentIds: [`s${index - 1}`] } : {}),
		}));
		let big = {
			id: "big",
			name: "review",
			status: "running" as const,
			started: 1,
			updated: 2,
			waiting: 0,
			stagesDelta: true as const,
			stages,
		};
		let { stagesDelta: _, ...fields } = big;
		let small = { ...fields, id: "small", stages: stages.slice(0, 2) };
		let quiet = { ...big, id: "quiet", stages: [] };
		client.reportRuns("s", { active: ["big"], paused: ["small"], cards: [small, big, quiet] });

		let parts: Array<Extract<ClientMessage, { type: "runs" }>> = [];
		let seen = 0;
		while (seen < stages.length) {
			let part = await server.next("runs");
			parts.push(part);
			seen += part.cards.find(card => card.id === "big")!.stages.length;
		}
		expect(parts.length).toBeGreaterThan(5);
		for (let [index, part] of parts.entries()) {
			expect(new TextEncoder().encode(JSON.stringify(part)).byteLength).toBeLessThanOrEqual(
				MAX_LINK_MESSAGE_BYTES,
			);
			expect(part).toMatchObject({ session: "s", active: ["big"], paused: ["small"] });
			expect(part.cards.map(card => card.id)).toEqual(["small", "big", "quiet"]);
			let [first, , last] = part.cards;
			if (index === 0) expect(first).toEqual(small);
			else expect(first).toEqual({ ...big, id: "small", stages: [] });
			expect(last).toEqual(quiet);
		}
		expect(parts.flatMap(part => part.cards[1]!.stages)).toEqual(stages);
	});

	it("refuses a stage delta to a server that did not offer them, which gets full cards", async () => {
		let server = fakeServer();
		let client = await connect(server, { turn() {} });
		expect(client.features).toEqual([]);
		let card = {
			id: "run",
			name: "review",
			status: "running" as const,
			started: 1,
			updated: 2,
			waiting: 0,
			stages: [{ id: "a", name: "a", status: "running" as const }],
		};
		expect(() =>
			client.reportRuns("s", {
				active: ["run"],
				paused: [],
				cards: [{ ...card, stagesDelta: true }],
			})
		).toThrow("stage deltas");
		client.reportRuns("s", { active: ["run"], paused: [], cards: [card] });
		expect((await server.next("runs")).cards).toEqual([card]);
	});

	it("settles a host call the server aborts or destroys instead of answering", async () => {
		let server = fakeServer();
		let results: HostToolResult[] = [];
		await connect(server, {
			async turn(context) {
				results.push(await context.callHostTool("read_plan", {}));
			},
		});
		server.send(turn("aborted"));
		await server.next("host-tool-call");
		server.send({ type: "abort", session: "s", turn: "aborted" });
		expect(await server.next("turn-end")).toMatchObject({ turn: "aborted", status: "aborted" });
		server.send(turn("destroyed"));
		await server.next("host-tool-call");
		server.send({ type: "destroy", session: "s" });
		expect(await server.next("turn-end")).toMatchObject({ turn: "destroyed", status: "aborted" });
		expect(results).toEqual([
			{ output: { error: "The turn was aborted." }, isError: true },
			{ output: { error: "The turn was aborted." }, isError: true },
		]);
	});

	it("settles a question withdrawn while its link is down at once, and a resumed link does not name it", async () => {
		let server = fakeServer({ features: ["resumable-sessions"] });
		let attaching = connectAgent({
			url: server.url,
			token: "t",
			document: "d",
			handlers: { turn() {} },
		});
		await server.next("resume");
		server.send({ type: "resumed", sessions: [] });
		let client = await attaching;
		stops.push(() => client.detach());
		server.send({ type: "start", session: "s", mode: "planner" });
		await server.next("started");
		let controller = new AbortController();
		let withdrawn = client.ask("s", { method: "confirm", title: "Ship?", message: "Now." }, {
			signal: controller.signal,
		});
		let kept = client.ask("s", { method: "confirm", title: "Also?", message: "Now." });
		let [first, second] = [await server.next("input-request"), await server.next("input-request")];
		server.close();
		let resumption = await client.resumption;
		expect(resumption).toBeDefined();
		controller.abort();
		expect(await withdrawn).toMatchObject({ type: "input-result", status: "cancelled" });

		let again = connectAgent({
			url: server.url,
			token: "t",
			document: "d",
			handlers: { turn() {} },
			resume: resumption!,
		});
		let resume = await server.next("resume");
		expect(resume.sessions).toEqual([{ session: "s", requests: [second.request] }]);
		expect(first.request).not.toBe(second.request);
		server.send({ type: "resumed", sessions: [{ session: "s", requests: [second.request] }] });
		let next = await again;
		stops.push(() => next.detach());
		server.send({ type: "input-result", request: second.request, status: "answered", value: true });
		expect(await kept).toMatchObject({ status: "answered", value: true });
	});

	it("offers restart-notice only as a resumable client, and says when the server expects to be back", async () => {
		let server = fakeServer({ features: ["resumable-sessions", "restart-notice"] });
		let attaching = connectAgent({
			url: server.url,
			token: "t",
			document: "d",
			handlers: { turn() {} },
		});
		await server.next("resume");
		server.send({ type: "resumed", sessions: [] });
		let client = await attaching;
		server.send({ type: "restarting", reconnectWithinMs: 10_000 });
		server.send({ type: "start", session: "s", mode: "planner" });
		await server.next("started");
		server.close();
		expect(await client.closed).toMatchObject({ reconnectWithinMs: 10_000 });
		expect(await client.resumption).toBeDefined();

		let plain = fakeServer();
		let opted = await connectAgent({
			url: plain.url,
			token: "t",
			document: "d",
			handlers: { turn() {} },
			resumable: false,
		});
		stops.push(() => opted.detach());
		expect(plain.asked).toEqual(["run-stage-deltas, decision-option-previews"]);
		plain.close();
		expect(await opted.closed).not.toHaveProperty("reconnectWithinMs");
	});

	/** A resumable client with a session `s` and one question asked, after its link dropped. */
	async function dropped(handlers: AgentHandlers = { turn() {} }) {
		let server = fakeServer({ features: ["resumable-sessions"] });
		let attaching = connectAgent({ url: server.url, token: "t", document: "d", handlers });
		await server.next("resume");
		server.send({ type: "resumed", sessions: [] });
		let client = await attaching;
		stops.push(() => client.detach());
		server.send({ type: "start", session: "s", mode: "planner" });
		server.send({ type: "start", session: "gone", mode: "planner" });
		await server.next("started");
		await server.next("started");
		let controller = new AbortController();
		let asked = client.ask("s", { method: "confirm", title: "Ship?", message: "Now." }, {
			signal: controller.signal,
		});
		let { request } = await server.next("input-request");
		server.close();
		let resumption = await client.resumption;
		expect(resumption).toBeDefined();
		let again = (extra: Partial<Parameters<typeof connectAgent>[0]> = {}) =>
			connectAgent({
				url: server.url,
				token: "t",
				document: "d",
				handlers,
				resume: resumption!,
				...extra,
			});
		return { server, asked, controller, request, again };
	}

	it("acknowledges each result it is given, including one for a question it already settled", async () => {
		let server = fakeServer({ features: ["resumable-sessions"] });
		let attaching = connectAgent({
			url: server.url,
			token: "t",
			document: "d",
			handlers: { turn() {} },
		});
		await server.next("resume");
		server.send({ type: "resumed", sessions: [] });
		let client = await attaching;
		stops.push(() => client.detach());
		let asked = client.ask("s", { method: "confirm", title: "Ship?", message: "Now." });
		let { request } = await server.next("input-request");
		server.send({ type: "input-result", request, status: "answered", value: true });
		expect(await asked).toMatchObject({ status: "answered" });
		expect(await server.next("input-received")).toEqual({ type: "input-received", request });
		server.send({ type: "input-result", request, status: "answered", value: true });
		expect(await server.next("input-received")).toEqual({ type: "input-received", request });
	});

	it("sends no acknowledgement to a server that did not accept the feature", async () => {
		let server = fakeServer();
		let client = await connect(server, { turn() {} });
		let asked = client.ask("s", { method: "confirm", title: "Ship?", message: "Now." });
		let { request } = await server.next("input-request");
		server.send({ type: "input-result", request, status: "answered", value: true });
		await asked;
		await Bun.sleep(50);
		expect(server.received.filter(message => message.type === "input-received")).toEqual([]);
	});

	it("cancels in Chopin a question withdrawn while its link was being resumed", async () => {
		let { server, asked, controller, request, again } = await dropped();
		let next = again();
		expect((await server.next("resume")).sessions).toContainEqual({
			session: "s",
			requests: [request],
		});
		controller.abort();
		expect(await asked).toMatchObject({ status: "cancelled" });
		server.send({ type: "resumed", sessions: [{ session: "s", requests: [request] }] });
		stops.push(async () => (await next).detach());
		await next;
		expect(await server.next("input-cancel")).toEqual({ type: "input-cancel", request });
	});

	it("ends everything for good when the server sends what it cannot read, though it offered the feature", async () => {
		let server = fakeServer({ features: ["resumable-sessions"] });
		let attaching = connectAgent({
			url: server.url,
			token: "t",
			document: "d",
			handlers: { turn() {} },
		});
		await server.next("resume");
		server.send({ type: "resumed", sessions: [] });
		let client = await attaching;
		let asked = client.ask("s", { method: "confirm", title: "Ship?", message: "Now." });
		await server.next("input-request");
		let settled = false;
		void asked.then(() => settled = true);
		server.send("not JSON");
		expect(await client.closed).toMatchObject({ code: 4400 });
		expect(await client.resumption).toBeUndefined();
		expect(await asked).toMatchObject({ status: "cancelled" });
		expect(settled).toBe(true);
	});

	it("destroys the sessions the server does not give back, and settles their questions as cancelled", async () => {
		let destroyed: string[] = [];
		let { server, asked, request, again } = await dropped({
			turn() {},
			destroy: message => void destroyed.push(message.session),
		});
		let next = again();
		await server.next("resume");
		server.send({ type: "resumed", sessions: [{ session: "s", requests: [] }] });
		stops.push(async () => (await next).detach());
		await next;
		expect(destroyed).toEqual(["gone"]);
		expect(await asked).toMatchObject({ request, status: "cancelled" });
	});

	it("keeps its questions pending when its resume is refused with retry, because Chopin could not decide, and settles them for every other refusal", async () => {
		let { server, asked, request, again } = await dropped();
		let refused = again();
		await server.next("resume");
		server.send({ type: "refused", code: "unavailable", message: "x", retry: true });
		await expect(refused).rejects.toMatchObject({ code: "unavailable", retry: true });
		let outcome: unknown;
		void asked.then(value => outcome = value);
		await Bun.sleep(50);
		expect(outcome).toBeUndefined();
		// Chopin can be asked again, and the same resumption succeeds.
		let next = again();
		expect((await server.next("resume")).sessions).toContainEqual({
			session: "s",
			requests: [request],
		});
		server.send({ type: "resumed", sessions: [{ session: "s", requests: [request] }] });
		stops.push(async () => (await next).detach());
		await next;
		server.send({ type: "input-result", request, status: "answered", value: true });
		expect(await asked).toMatchObject({ status: "answered", value: true });

		for (
			let code of [
				"planner-attached",
				"access-revoked",
				"sign-in-required",
				"document-archived",
			] as const
		) {
			let other = await dropped();
			let denied = other.again();
			await other.server.next("resume");
			other.server.send({ type: "refused", code, message: "x" });
			await expect(denied).rejects.toMatchObject({ code, retry: false });
			expect(await other.asked).toMatchObject({ status: "cancelled" });
		}
	});

	it("withdraws a question whose signal is already aborted without asking it", async () => {
		let server = fakeServer();
		let client = await connect(server, { turn() {} });
		let controller = new AbortController();
		controller.abort();
		let asked = await client.ask("s", { method: "confirm", title: "Ship?", message: "Now." }, {
			signal: controller.signal,
		});
		expect(asked).toMatchObject({ type: "input-result", status: "cancelled" });
		client.reportRuns("s", { active: [], paused: [], cards: [] });
		await server.next("runs");
		expect(server.received.some(message => message.type === "input-request")).toBe(false);
	});

	it("cuts generated error text to the wire limit instead of breaking the link", async () => {
		let server = fakeServer();
		let long = "x".repeat(MAX_LINK_NOTE_LENGTH * 3);
		let client = await connect(server, {
			start() {
				throw new Error(long);
			},
			turn(context) {
				context.emit({ type: "error", error: long });
				throw new Error(long);
			},
			control() {
				throw new Error(long);
			},
		});
		server.send({ type: "start", session: "s", mode: "planner" });
		expect((await server.next("start-failed")).message).toHaveLength(MAX_LINK_NOTE_LENGTH);
		server.send(turn("failing"));
		let part = (await server.next("part")).part;
		expect(part.type === "error" && part.error).toHaveLength(MAX_LINK_NOTE_LENGTH);
		let ended = await server.next("turn-end");
		expect(ended).toMatchObject({ status: "failed" });
		expect(ended.message).toHaveLength(MAX_LINK_NOTE_LENGTH);
		server.send({ type: "stop", request: "r", session: "s" });
		expect((await server.next("control-result")).message).toHaveLength(MAX_LINK_NOTE_LENGTH);
		expect(client.send({ type: "runs", session: "s", active: [], paused: [], cards: [] }))
			.toBe(true);
	});

	it("settles requests made once the link has closed instead of leaving them pending", async () => {
		let server = fakeServer();
		let holding = Promise.withResolvers<TurnContext>();
		let client = await connect(server, {
			async turn(context) {
				holding.resolve(context);
				await new Promise(resolve => context.signal.addEventListener("abort", resolve));
			},
		});
		server.send(turn("open"));
		let held = await holding.promise;
		server.close();
		await client.closed;
		expect(await client.ask("s", { method: "input", title: "Name?" })).toMatchObject({
			status: "cancelled",
			message: "The agent connection closed.",
		});
		expect(await held.callHostTool("read_plan", {})).toEqual({
			output: { error: "The turn has ended." },
			isError: true,
		});
		expect(client.send({ type: "detach" })).toBe(false);
	});
});

describe("Agent connection client facing a faulty server", () => {
	/** Answers attach, then a frame no client can parse in place of the question's answer. */
	function garblingServer() {
		let closes: { code: number; reason: string }[] = [];
		let server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, self) {
				return self.upgrade(request) ? undefined : new Response("upgrade failed", { status: 400 });
			},
			websocket: {
				message(ws, raw) {
					let parsed = parseClientMessage(String(raw));
					if (!parsed.ok) throw new Error(parsed.message);
					if (parsed.message.type === "attach" && parsed.message.document === "garbled") {
						ws.send("not JSON");
					} else if (parsed.message.type === "attach") {
						ws.send(JSON.stringify({
							type: "attached",
							version: 1,
							document: { id: "d", title: "T", repository: "o/r" },
						}));
					} else if (parsed.message.type === "input-request") {
						ws.send(new Uint8Array([1, 2, 3]));
					}
				},
				close(_ws, code, reason) {
					closes.push({ code, reason });
				},
			},
		});
		stops.push(() => server.stop(true));
		return { url: `http://127.0.0.1:${server.port}`, closes };
	}

	async function faced(url: string) {
		let early = await connectAgent({
			url,
			token: "t",
			document: "garbled",
			handlers: {
				turn() {},
			},
		}).then(() => "attached", (error: Error) => error.message);
		let client = await connectAgent({
			url,
			token: "t",
			document: "d",
			handlers: {
				turn() {},
			},
		});
		let answer = await client.ask("s", { method: "input", title: "Name?" });
		return { early, answer, closed: await client.closed };
	}

	const expected = {
		early: "The agent connection closed before attaching (4400 malformed-message).",
		answer: {
			type: "input-result",
			request: expect.any(String),
			status: "cancelled",
			message: "The agent connection closed.",
		},
		closed: { code: 4400, reason: "malformed-message" },
	};

	it("closes the link and settles what waits on it", async () => {
		let server = garblingServer();
		expect(await faced(server.url) as unknown).toEqual(expected);
		await Bun.sleep(50);
		expect(server.closes).toEqual([expected.closed, expected.closed]);
	});

	it("does the same under Node.js's WebSocket", async () => {
		let node = Bun.which("node");
		let probe = node && Bun.spawnSync([node, "-p", "Boolean(process.features.typescript)"]);
		if (!probe || probe.stdout.toString().trim() !== "true") return;
		let server = garblingServer();
		let script = `
			import { connectAgent } from ${JSON.stringify(new URL("./client.ts", import.meta.url).href)};
			${faced.toString().replace("async function faced", "async function run")}
			console.log(JSON.stringify(await run(process.argv[1])));
		`;
		let child = Bun.spawn([node!, "--input-type=module", "-e", script, server.url], {
			stdout: "pipe",
			stderr: "pipe",
		});
		let [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		expect(JSON.parse(stdout)).toEqual(expected);
	});
});
