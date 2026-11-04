import { afterEach, describe, expect, it } from "bun:test";
import { AGENT_VERSION, LINK_CLOSE } from "@chopin/agent-link";
import {
	CONNECTOR_PLANNER_COMMAND_HEADER,
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_VERSION_HEADER,
} from "@chopin/protocol/connector";

import { Machines } from "../../auth/machines";
import { PLANNER_IDLE_MS, registerExperimentRoutes } from "../../experiments/routes";
import { Router } from "../../http/router";
import {
	linkAuth,
	linkServer,
	machineToken,
	rawLink,
	upgradeRequest,
} from "../../testing/agent-link";
import { createHumanInput } from "../atomic/human-input";
import { hostInputRoom } from "../../testing/decisions";
import { startingMessage } from "./attachments";
import { MachinePlanners } from "./machine-planners";

import type { RemotePlanner } from "./registry";

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * A HARNESS=remote server whose accounts pair machines that connect checkouts of octo-org/score,
 * choose them for the linked document, and run its Planner on them over the agent connection.
 */
async function dispatchServer() {
	let linked = await linkAuth();
	let { auth, storage, sessions, cookies, channel } = linked;
	let machines = new Machines(storage, () => new Date(), {
		key: new Uint8Array(32).fill(7),
		origin: auth.config.origin,
		clientId: "client",
		authorize: async (userId, token) => (await auth.admission.user(token)).id === userId,
	});
	let planners = new MachinePlanners({
		machines,
		sessions,
		storage,
		github: auth.github,
		config: auth.config,
	});
	let server = linkServer(auth, 2_000, undefined, 300, undefined, planners);
	cleanups.push(server.stop);
	let router = new Router();
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	/** Documents open in Chopin now, as `main.ts` says from its rooms; and how far the clock moved. */
	let open = new Set<string>();
	let skew = { ms: 0 };
	let clock = () => new Date(Date.now() + skew.ms);
	let runtime = registerExperimentRoutes(
		router,
		{ ...auth, clock, machines, pairings: {} } as never,
		{
			lease: () => lease,
			changed: () => {},
			context: async () => ({ source: "# Context", revision: 0 }),
			planners,
			attachments: () => server.attachments,
			documentOpen: id => open.has(id),
			// No builds wait anywhere; only the Planner poll is exercised.
			implementations: () =>
				({
					waiting: async () => undefined,
					busy: async () => false,
					disconnected: async () => {},
					sweep: async () => {},
					call: async () => ({}),
				}) as never,
		},
	);
	server.attachments.onChange(channelId => runtime.plannerChanged(channelId));

	async function send(
		path: string,
		options: { body?: unknown; bearer?: string; login?: string; headers?: Record<string, string> },
		signal?: AbortSignal,
	) {
		let url = `${auth.config.origin}${path}`;
		let response = await router.handle(
			new Request(url, {
				method: options.body === undefined ? "GET" : "POST",
				headers: {
					"content-type": "application/json",
					...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
					...(options.login
						? { cookie: cookies.get(options.login)!, origin: auth.config.origin }
						: {}),
					...options.headers,
				},
				...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
				...(signal ? { signal } : {}),
			}),
			new URL(url),
		);
		return response!;
	}
	/** Pair a machine for `login` and connect its checkout, as `chopin connect` does. */
	async function machine(
		login: string,
		userId: string,
		label: string,
		connector: { protocol?: number; plannerCommand?: boolean; shared?: boolean } = {},
	) {
		let { machine, token } = await machines.pair({
			userId,
			label,
			repositories: [],
			autoRun: false,
			...(connector.shared ? { shared: true } : {}),
			grant: {
				accessToken: machineToken(login),
				accessExpiresIn: 28_800,
				refreshToken: `${login}-${label}-refresh`,
				refreshExpiresIn: 15_897_600,
			},
		});
		let protocol = connector.protocol ?? 4;
		/** `chopin connect` on the machine: a connection of its own, as after a restart. */
		async function connect() {
			let opened = await send("/api/connector/connections", {
				bearer: token,
				body: { repository: "octo-org/score", commit: "a".repeat(40), label: "score" },
				headers: {
					[CONNECTOR_VERSION_HEADER]: "dev",
					[CONNECTOR_PROTOCOL_HEADER]: String(protocol),
					...(connector.plannerCommand ?? true ? { [CONNECTOR_PLANNER_COMMAND_HEADER]: "1" } : {}),
				},
			});
			expect(opened.status).toBe(200);
			return (await opened.json()).token as string;
		}
		let connection = await connect();
		/**
		 * One `wait_for_work` long poll on the connection: with `planners`, the Planner poll a
		 * protocol 4 connector makes naming the documents whose Planners it runs. A poll with no
		 * change gives up after `waitMs`.
		 */
		async function poll(planners?: string[], waitMs = 300) {
			let response = await send("/connector/mcp", {
				bearer: connection,
				headers: {
					[CONNECTOR_VERSION_HEADER]: "dev",
					[CONNECTOR_PROTOCOL_HEADER]: String(protocol),
				},
				body: {
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "wait_for_work", arguments: planners ? { planners } : {} },
				},
			}, AbortSignal.timeout(waitMs));
			let answer = await response.json();
			// A connection Chopin refuses outright answers with the HTTP error, not a tool result.
			if (answer.error) return { error: answer.error as string };
			let result = answer.result;
			let text = result.content[0].text as string;
			return result.isError ? { error: text } : JSON.parse(text);
		}
		/** The Planner credential the connector asks for before it starts a backend. */
		async function credential() {
			let issued = await send("/api/connector/planner", {
				bearer: token,
				headers: {
					[CONNECTOR_VERSION_HEADER]: "dev",
					[CONNECTOR_PROTOCOL_HEADER]: String(protocol),
				},
				body: { document: channel.id },
			});
			expect(issued.status).toBe(200);
			return (await issued.json()).token as string;
		}
		/** The backend the connector starts: a credential for the document, then a link that attaches. */
		async function backend() {
			let raw = await rawLink(server.url, await credential());
			raw.send({ type: "attach", version: AGENT_VERSION, document: channel.id });
			return raw;
		}
		/** What the connector tells Chopin about its Planner backend's failing to start. */
		async function report(body: unknown) {
			return send("/api/connector/planner/failure", {
				bearer: token,
				headers: {
					[CONNECTOR_VERSION_HEADER]: "dev",
					[CONNECTOR_PROTOCOL_HEADER]: String(protocol),
				},
				body,
			});
		}
		let disconnect = () =>
			send("/connector/mcp", {
				bearer: connection,
				headers: {
					[CONNECTOR_VERSION_HEADER]: "dev",
					[CONNECTOR_PROTOCOL_HEADER]: String(protocol),
				},
				body: {
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: { name: "disconnect_workspace", arguments: {} },
				},
			});
		let connectionId = runtime.connections.lookup(connection).connection.id;
		let reconnect = async () => {
			connection = await connect();
		};
		return {
			id: machine.id,
			token,
			connectionId,
			poll,
			credential,
			backend,
			report,
			disconnect,
			reconnect,
		};
	}
	let path = `/api/documents/${channel.id}/machine`;
	let choose = async (login: string, machine: string | null) => {
		let response = await send(path, { login, body: { machine } });
		expect(response.status).toBe(200);
		return response.json();
	};
	let choice = async (login: string) => (await send(path, { login })).json();
	/** Star a machine as its owner's favorite, which Default machine prefers, or clear it. */
	let favor = async (login: string, machine: string, favorite = true) => {
		let response = await send(`/api/connector/machines/${machine}/favorite`, {
			login,
			body: { favorite },
		});
		expect(response.status).toBe(200);
	};
	/** Share a machine with teammates as its owner, or stop. */
	let share = async (login: string, machine: string, shared = true) => {
		let response = await send(`/api/connector/machines/${machine}/shared`, {
			login,
			body: { shared },
		});
		return response.status;
	};
	/** Someone opens the document in Chopin; closing it starts its idle time. */
	let visit = async (id = channel.id) => {
		open.add(id);
		await runtime.plannerUsed(id);
	};
	let url = expect.stringContaining(`https://chopin.test/`);
	return {
		...linked,
		machines,
		planners,
		server,
		runtime,
		open,
		skew,
		send,
		machine,
		choose,
		choice,
		favor,
		share,
		visit,
		url,
	};
}

/** The status an agent connection's upgrade gets with `credential`: 101 when it opens. */
async function upgrade(url: string, credential: string) {
	let response = await upgradeRequest(url, { authorization: `Bearer ${credential}` });
	return response.status;
}

/** What a connector says when its backend exited before attaching `attempts` times in a row. */
function failing(document: string, attempts: number, reason = "unsafe-checkout: refused") {
	return { document, failure: { attempts, how: "exit 1", reason, at: Date.now() } };
}

describe("a Planner backend that keeps failing to start", () => {
	it("is told to the document's people from the second launch in a row, and goes once the Planner attaches", async () => {
		let { machine, choose, runtime, channel, server } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		await choose("member", laptop.id);
		await laptop.poll([]);
		expect(await runtime.plannerStarting(channel.id)).toEqual({
			login: "member",
			machineId: laptop.id,
		});

		// One launch that exited is a transient failure: the document still just says starting.
		expect((await laptop.report(failing(channel.id, 1))).status).toBe(200);
		expect(await runtime.plannerStarting(channel.id)).toEqual({
			login: "member",
			machineId: laptop.id,
		});

		// The second in a row is not.
		let reason = "unsafe-checkout: ~/src/score's own git configuration sets a credential helper";
		let before = Date.now();
		expect(await (await laptop.report(failing(channel.id, 2, reason))).json())
			.toEqual({ recorded: true });
		expect(await runtime.plannerStarting(channel.id)).toEqual({
			login: "member",
			machineId: laptop.id,
			failure: {
				attempts: 2,
				reason,
				at: expect.any(String),
			},
		});
		let { failure } = (await runtime.plannerStarting(channel.id))!;
		// The time is the server's own, so a connector's clock cannot skew what people read.
		expect(Date.parse(failure!.at)).toBeGreaterThanOrEqual(before);

		// It attaches at last; once it lets go and the grace period ends, nothing old is told.
		let link = await laptop.backend();
		await link.next("attached");
		link.send({ type: "detach" });
		for (let deadline = Date.now() + 4_000; server.attachments.holding(channel.id);) {
			if (Date.now() > deadline) throw new Error("the Planner was never released");
			await Bun.sleep(50);
		}
		expect(await runtime.plannerStarting(channel.id)).toEqual({
			login: "member",
			machineId: laptop.id,
		});
	});

	it("goes when the connector says its backend stays up, or the machine stops being asked for the document", async () => {
		let { machine, choose, runtime, channel } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		let desk = await machine("member", "U_member", "desk");
		await choose("member", laptop.id);
		await laptop.poll([]);
		await laptop.report(failing(channel.id, 3));
		expect((await runtime.plannerStarting(channel.id))?.failure?.attempts).toBe(3);
		// A launch that stays up: no failure to report any more.
		expect(await (await laptop.report({ document: channel.id })).json())
			.toEqual({ recorded: true });
		expect((await runtime.plannerStarting(channel.id))?.failure).toBeUndefined();

		// A failure of the laptop does not follow the document to the desk, or back again.
		await laptop.report(failing(channel.id, 2));
		await choose("member", desk.id);
		expect((await runtime.plannerStarting(channel.id))?.failure).toBeUndefined();
		await choose("member", laptop.id);
		await laptop.poll([]);
		expect(await runtime.plannerStarting(channel.id)).toEqual({
			login: "member",
			machineId: laptop.id,
		});
	});

	it("is taken only from a machine Chopin asked to run the document's Planner, for its people to read", async () => {
		let { machine, choose, runtime, channel, send } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		let desk = await machine("member", "U_member", "desk");
		let rival = await machine("rival", "U_rival", "rival-box");
		await choose("member", laptop.id);
		await laptop.poll([]);

		// Not asked: the desk was never chosen, and the rival's machine cannot touch the document.
		for (let other of [desk, rival]) {
			let answer = await other.report(failing(channel.id, 4, "not for you"));
			expect(answer.status).toBe(200);
			expect(await answer.json()).toEqual({ recorded: false });
		}
		expect((await runtime.plannerStarting(channel.id))?.failure).toBeUndefined();

		// Nor anyone who is not a paired machine.
		let stranger = await send("/api/connector/planner/failure", {
			bearer: `chopin_m_${"x".repeat(43)}`,
			headers: { [CONNECTOR_VERSION_HEADER]: "dev", [CONNECTOR_PROTOCOL_HEADER]: "4" },
			body: failing(channel.id, 2),
		});
		expect(stranger.status).toBe(401);
		expect((await runtime.plannerStarting(channel.id))?.failure).toBeUndefined();
	});

	it("is what an @chopin request is told while the Planner cannot start, instead of to try again in a moment", () => {
		expect(startingMessage("mona")).toBe(
			"This document's Planner is still starting on @mona's machine. Try again in a moment.",
		);
		expect(
			startingMessage("mona", {
				attempts: 3,
				reason: "unsafe-checkout: refused",
				at: "2026-11-04T02:00:00.000Z",
			}),
		).toBe(
			"This document's Planner can't start on @mona's machine: unsafe-checkout: refused "
				+ "(3 attempts in a row). It keeps trying; try again once that is fixed.",
		);
	});

	it("keeps what is told short and plain", async () => {
		let { machine, choose, runtime, channel } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		await choose("member", laptop.id);
		await laptop.poll([]);
		await laptop.report(failing(channel.id, 2, `\u001b[31m${"x".repeat(1_500)}\u0007\r\nend`));
		let reason = (await runtime.plannerStarting(channel.id))!.failure!.reason;
		expect(reason).toHaveLength(300);
		expect([...reason].some(character => character.charCodeAt(0) < 32)).toBe(false);
		// A report that says nothing about why still says how it ended.
		await laptop.report({
			document: channel.id,
			failure: { attempts: 2, how: "signal SIGKILL", at: Date.now() },
		});
		expect((await runtime.plannerStarting(channel.id))!.failure).toEqual({
			attempts: 2,
			reason: "signal SIGKILL",
			at: expect.any(String),
		});
		// Malformed ones are refused.
		for (
			let body of [{ document: channel.id, failure: { attempts: 0, how: "x", at: 1 } }, {
				failure: {},
			}]
		) {
			expect((await laptop.report(body)).status).toBe(409);
		}
	});
});

describe("choosing a machine for a document", () => {
	it("tells that machine to run the document's Planner, and stops it when another is chosen", async () => {
		let { machine, choose, choice, channel, server, url } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		let desk = await machine("member", "U_member", "desk");
		// Automatic runs no Planner anywhere.
		expect(await laptop.poll([])).toEqual({ waiting: true });

		let chosen = await choose("member", laptop.id);
		expect(chosen.planner).toEqual({ state: "starting", login: null, machine: laptop.id });
		expect(chosen.machines.map((item: { runsPlanners: boolean }) => item.runsPlanners))
			.toEqual([true, true]);
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		// Nothing changed for a connector already running it, or for the machine not chosen.
		expect(await laptop.poll([channel.id])).toEqual({ waiting: true });
		expect(await desk.poll([])).toEqual({ waiting: true });

		let first = await laptop.backend();
		await first.next("attached");
		expect((await choice("member")).planner)
			.toEqual({ state: "attached", login: "member", machine: laptop.id });

		// Choosing the desk closes the laptop's link at once and tells each connector.
		await choose("member", desk.id);
		expect(await first.next("refused")).toMatchObject({ code: "access-revoked" });
		expect((await first.closed).code).toBe(LINK_CLOSE.forbidden);
		expect(await laptop.poll([channel.id])).toEqual({
			kind: "planners",
			planners: [],
			stopped: { [channel.id]: expect.stringContaining("stopped running its Planner") },
		});
		expect(await desk.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		let second = await desk.backend();
		await second.next("attached");
		expect(server.attachments.holder(channel.id)).toBe("member");

		// Automatic stops it too.
		expect((await choose("member", null)).planner).toEqual({
			state: "none",
			login: null,
			machine: null,
		});
		expect(await second.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(await desk.poll([channel.id])).toMatchObject({ kind: "planners", planners: [] });
		expect(server.attachments.attached(channel.id)).toBe(false);
	});

	it("tells the machine a renamed document's current address, once", async () => {
		let { machine, choose, channel, storage } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		await choose("member", laptop.id);
		let told = await laptop.poll([]);
		expect(told.planners[0].url).toEndWith(`/${channel.slug}`);
		let renamed = await storage.channels.rename({
			id: channel.id,
			title: "Renamed document",
			now: new Date(),
		});
		expect(renamed.channel.slug).not.toBe(channel.slug);
		// The same document, so a connector running it hears only its new address.
		expect(await laptop.poll([channel.id])).toEqual({
			kind: "planners",
			planners: [{
				id: channel.id,
				url: expect.stringMatching(new RegExp(`/${renamed.channel.slug}$`)),
			}],
		});
		expect(await laptop.poll([channel.id])).toEqual({ waiting: true });
	});

	it("never takes over a Planner another account holds", async () => {
		let { machine, choose, choice, channel, server, url } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		let rivals = await machine("rival", "U_rival", "rival-box");
		let held = await rivals.backend();
		await held.next("attached");

		let chosen = await choose("member", laptop.id);
		expect(chosen.planner).toEqual({ state: "held", login: "rival", machine: null });
		expect(await laptop.poll([])).toEqual({ waiting: true });
		expect(server.attachments.holder(channel.id)).toBe("rival");

		// Once the rival lets go and its grace period ends, the member's machine is asked.
		held.send({ type: "detach" });
		let answer;
		for (let deadline = Date.now() + 4_000; Date.now() < deadline;) {
			// Each change wakes the poll, which waits again while the rival still holds it.
			answer = await laptop.poll([], 1_000);
			if (answer.kind) break;
		}
		expect(answer).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		expect((await choice("member")).planner.state).toBe("starting");
	});

	it("lets the creator's choice take the Planner from a machine another member chose", async () => {
		let { machine, choose, choice, channel, server, url } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		let rivals = await machine("rival", "U_rival", "rival-box");
		// The other member chose their machine first, and its Planner attached.
		await choose("rival", rivals.id);
		expect(await rivals.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let theirs = await rivals.backend();
		await theirs.next("attached");
		expect(server.attachments.holding(channel.id)?.machineId).toBe(rivals.id);

		// The creator chooses their own machine: the other member's Planner stops and their choice goes.
		let chosen = await choose("member", laptop.id);
		expect(chosen.planner).toEqual({ state: "starting", login: null, machine: laptop.id });
		expect(await theirs.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(await rivals.poll([channel.id])).toEqual({
			kind: "planners",
			planners: [],
			stopped: { [channel.id]: expect.stringContaining("member chose another machine") },
		});
		expect((await choice("rival")).choice).toBeNull();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let mine = await laptop.backend();
		await mine.next("attached");
		expect(server.attachments.holder(channel.id)).toBe("member");
		expect((await choice("member")).planner)
			.toEqual({ state: "attached", login: "member", machine: laptop.id });
	});

	it("never lets another member's choice keep the Planner from the creator's chosen machine", async () => {
		let { machine, choose, choice, channel, server, url } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		let rivals = await machine("rival", "U_rival", "rival-box");
		await choose("member", laptop.id);
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});

		// Chosen after the creator's, the other member's machine is never asked.
		let theirs = await choose("rival", rivals.id);
		expect(theirs.choice).toBe(rivals.id);
		expect(theirs.planner).toEqual({ state: "none", login: null, machine: null });
		expect(await rivals.poll([])).toEqual({ waiting: true });
		let mine = await laptop.backend();
		await mine.next("attached");
		expect(server.attachments.holder(channel.id)).toBe("member");
		expect((await choice("rival")).planner).toEqual({
			state: "held",
			login: "member",
			machine: null,
		});
	});

	it("lets the creator take the Planner back with Default machine from a member's choice", async () => {
		let { machine, choose, choice, visit, channel, server, url } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		let rivals = await machine("rival", "U_rival", "rival-box");
		await visit();
		await choose("rival", rivals.id);
		expect(await rivals.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let theirs = await rivals.backend();
		await theirs.next("attached");
		expect(server.attachments.holding(channel.id)?.machineId).toBe(rivals.id);

		// The creator has chosen no machine, yet asking for Default machine claims the document.
		let back = await choose("member", null);
		expect(back.planner).toEqual({ state: "starting", login: null, machine: laptop.id });
		expect(await theirs.next("refused")).toMatchObject({ code: "access-revoked" });
		expect((await choice("rival")).choice).toBeNull();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let mine = await laptop.backend();
		await mine.next("attached");
		expect(server.attachments.holder(channel.id)).toBe("member");
	});

	it("keeps the creator's Planner when they go back to Default machine after a member chose", async () => {
		let { machine, choose, choice, visit, channel, server } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		let rivals = await machine("rival", "U_rival", "rival-box");
		await visit();
		await choose("member", laptop.id);
		let mine = await laptop.backend();
		await mine.next("attached");
		// Inert while the creator's choice stands, and still stored for the member's own builds.
		await choose("rival", rivals.id);
		expect(await rivals.poll([], 300)).toEqual({ waiting: true });

		// Default machine gives the Planner to the same machine, so it stays; the member's choice
		// does not revive and take the document.
		expect((await choose("member", null)).planner.state).toBe("attached");
		expect(await rivals.poll([], 300)).toEqual({ waiting: true });
		expect(server.attachments.holder(channel.id)).toBe("member");
		expect((await choice("rival")).choice).toBe(rivals.id);
	});

	it("withdraws a machine's credential once it is no longer asked, so it never attaches after Automatic", async () => {
		let { machine, choose, channel, server, url } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		let rivals = await machine("rival", "U_rival", "rival-box");
		await choose("member", laptop.id);
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		// The laptop's backend has its credential, and has yet to attach when the rival's does.
		let credential = await laptop.credential();
		let held = await rivals.backend();
		await held.next("attached");
		// So the laptop is no longer asked to run it; then its owner chooses Automatic.
		expect(await laptop.poll([channel.id])).toMatchObject({ kind: "planners", planners: [] });
		await choose("member", null);
		held.send({ type: "detach" });
		for (let deadline = Date.now() + 4_000; server.attachments.holder(channel.id);) {
			expect(Date.now()).toBeLessThan(deadline);
			await Bun.sleep(50);
		}
		// With the document free, the laptop's old credential still opens no link.
		expect(await upgrade(server.url, credential)).toBe(401);
		expect(server.attachments.attached(channel.id)).toBe(false);
	});

	it("withdraws the credential a machine got for the document when its owner chooses another, asked or not", async () => {
		let { machine, choose, server } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		await choose("member", laptop.id);
		// A credential got before the laptop's connector was ever asked to run the Planner.
		let credential = await laptop.credential();
		await choose("member", null);
		expect(await upgrade(server.url, credential)).toBe(401);
	});

	it("asks one machine for the Planners of documents in several repositories", async () => {
		let { machine, choose, channel, send, storage, url } = await dispatchServer();
		let notes = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_notes",
			repositoryOwner: "octo-org",
			repositoryName: "notes",
			title: "Notes document",
			createdBy: "U_member",
			now: new Date(),
		});
		// Both connected with a checkout of octo-org/score only.
		let laptop = await machine("member", "U_member", "laptop", { protocol: 5 });
		let older = await machine("member", "U_member", "older", { protocol: 4 });
		let chooseNotes = async (machineId: string) => {
			let response = await send(`/api/documents/${notes.id}/machine`, {
				login: "member",
				body: { machine: machineId },
			});
			expect(response.status).toBe(200);
			return response.json();
		};
		await choose("member", laptop.id);
		let chosen = await chooseNotes(laptop.id);
		expect(chosen.planner).toEqual({ state: "starting", login: null, machine: laptop.id });
		let asked = await laptop.poll([]);
		expect(asked.kind).toBe("planners");
		expect(asked.planners.map((item: { id: string }) => item.id).sort())
			.toEqual([channel.id, notes.id].sort());
		expect(asked.planners).toContainEqual({ id: notes.id, url });
		// Its credential says which repository's checkout the Planner runs in.
		let issued = await send("/api/connector/planner", {
			bearer: laptop.token,
			headers: {
				[CONNECTOR_VERSION_HEADER]: "dev",
				[CONNECTOR_PROTOCOL_HEADER]: "5",
			},
			body: { document: notes.id },
		});
		expect(issued.status).toBe(200);
		expect((await issued.json()).document).toMatchObject({
			id: notes.id,
			repository: "octo-org/notes",
		});
		// An older connector connected for octo-org/score is never asked for octo-org/notes.
		expect((await chooseNotes(older.id)).planner)
			.toEqual({ state: "none", login: null, machine: null });
		expect(await older.poll([])).toEqual({ waiting: true });
	});

	it("never asks a machine without a Planner command or an older connector", async () => {
		let { machine, choose } = await dispatchServer();
		let plain = await machine("member", "U_member", "plain", { plannerCommand: false });
		let older = await machine("member", "U_member", "older", { protocol: 3 });
		let chosen = await choose("member", plain.id);
		expect(chosen.planner).toEqual({ state: "none", login: null, machine: null });
		expect(
			chosen.machines.map((item: { label: string; runsPlanners: boolean }) => [
				item.label,
				item.runsPlanners,
			]).sort(),
		).toEqual([["older", false], ["plain", false]]);
		expect(await plain.poll([])).toEqual({ waiting: true });
		await choose("member", older.id);
		// An older connector's poll for work never carries the message.
		expect(await older.poll()).toEqual({ waiting: true });
	});

	it("stops the Planner when the chosen machine disconnects, is revoked, or loses push access", async () => {
		let { machine, choose, choice, channel, server, send, auth } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		await choose("member", laptop.id);
		expect((await laptop.poll([])).planners).toHaveLength(1);
		let link = await laptop.backend();
		await link.next("attached");
		expect((await laptop.disconnect()).status).toBe(200);
		expect(await link.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(server.attachments.attached(channel.id)).toBe(false);

		let desk = await machine("member", "U_member", "desk");
		await choose("member", desk.id);
		expect((await desk.poll([])).planners).toHaveLength(1);
		link = await desk.backend();
		await link.next("attached");
		let revoked = await send(`/api/connector/machines/${desk.id}/revoke`, {
			login: "member",
			body: {},
		});
		expect(revoked.status).toBe(200);
		expect(await link.next("refused")).toMatchObject({ code: "access-revoked" });
		expect((await choice("member")).choice).toBeNull();

		let tower = await machine("member", "U_member", "tower");
		await choose("member", tower.id);
		expect((await tower.poll([])).planners).toHaveLength(1);
		link = await tower.backend();
		await link.next("attached");
		let access = auth.github.repositoryAccess;
		auth.github.repositoryAccess = async (token, owner, name) => {
			let repository = await access(token, owner, name);
			return repository && token.includes("-machine-")
				? { ...repository, permissions: { ...repository.permissions, push: false } }
				: repository;
		};
		expect((await tower.poll([channel.id])).error).toStartWith("repository-forbidden");
		expect(await link.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(server.attachments.attached(channel.id)).toBe(false);
	});
});

describe("a document on Default machine", () => {
	it("runs its Planner on its creator's favorite machine without anyone choosing it", async () => {
		let { machine, favor, visit, choice, channel, runtime, url } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		let desk = await machine("member", "U_member", "desk");
		await favor("member", desk.id);
		// Nobody has opened it yet, so no machine runs its Planner.
		expect(await desk.poll([])).toEqual({ waiting: true });
		expect(await runtime.plannerStarting(channel.id)).toBeUndefined();

		await visit();
		expect(await desk.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		expect(await laptop.poll([])).toEqual({ waiting: true });
		expect((await choice("member")).planner)
			.toEqual({ state: "starting", login: null, machine: desk.id });
		expect(await runtime.plannerStarting(channel.id)).toEqual({
			login: "member",
			machineId: desk.id,
		});

		let link = await desk.backend();
		await link.next("attached");
		expect((await choice("member")).planner)
			.toEqual({ state: "attached", login: "member", machine: desk.id });
		expect(await runtime.plannerStarting(channel.id)).toBeUndefined();
	});

	it("falls back to the machine last used for the document, then any machine that can run Planners", async () => {
		let { machine, favor, visit, channel, runtime, url } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		let desk = await machine("member", "U_member", "desk");
		// The favorite can't run Planners, so it is passed over.
		let plain = await machine("member", "U_member", "plain", { plannerCommand: false });
		await favor("member", plain.id);
		runtime.connections.use(channel.id, laptop.connectionId);
		await visit();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		expect(await desk.poll([])).toEqual({ waiting: true });
		expect(await plain.poll([])).toEqual({ waiting: true });

		// Another document nobody built anywhere goes to any machine that can run Planners.
		let other = await dispatchServer();
		let tower = await other.machine("member", "U_member", "tower");
		let box = await other.machine("member", "U_member", "box", { plannerCommand: false });
		await other.visit();
		expect(await tower.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: other.channel.id, url }],
		});
		expect(await box.poll([])).toEqual({ waiting: true });
	});

	it("runs nowhere when none of its creator's machines can run Planners, nor on anyone else's", async () => {
		let { machine, visit, choice, channel, runtime } = await dispatchServer();
		let plain = await machine("member", "U_member", "plain", { plannerCommand: false });
		let rivals = await machine("rival", "U_rival", "rival-box");
		await visit();
		expect(await plain.poll([])).toEqual({ waiting: true });
		expect(await rivals.poll([])).toEqual({ waiting: true });
		expect((await choice("member")).planner).toEqual({ state: "none", login: null, machine: null });
		expect(await runtime.plannerStarting(channel.id)).toBeUndefined();
	});

	it("keeps the Planner on its machine when another comes online, and moves it when that machine disconnects", async () => {
		let { machine, favor, visit, choice, channel, server, url } = await dispatchServer();
		// The creator's favorite is offline, so their other machine takes the Planner.
		let desk = await machine("member", "U_member", "desk");
		await favor("member", desk.id);
		expect((await desk.disconnect()).status).toBe(200);
		let laptop = await machine("member", "U_member", "laptop");
		await visit();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let first = await laptop.backend();
		await first.next("attached");

		// The favorite comes back online, and another machine connects: the Planner stays where it is.
		await desk.reconnect();
		let tower = await machine("member", "U_member", "tower");
		expect(await desk.poll([])).toEqual({ waiting: true });
		expect(await tower.poll([])).toEqual({ waiting: true });
		expect(await laptop.poll([channel.id])).toEqual({ waiting: true });
		expect(server.attachments.holding(channel.id)?.machineId).toBe(laptop.id);

		// Its machine disconnects: the creator's favorite is asked, and nothing else.
		expect((await laptop.disconnect()).status).toBe(200);
		expect(await first.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(await desk.poll([], 1_000)).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		expect(await tower.poll([])).toEqual({ waiting: true });
		let second = await desk.backend();
		await second.next("attached");
		expect((await choice("member")).planner)
			.toEqual({ state: "attached", login: "member", machine: desk.id });
	});

	it("moves the Planner when its creator's favorite changes, and keeps it when they choose the machine it runs on", async () => {
		let { machine, favor, visit, choose, choice, channel, url } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		let desk = await machine("member", "U_member", "desk");
		await favor("member", laptop.id);
		await visit();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let link = await laptop.backend();
		await link.next("attached");

		// Choosing the machine it already runs on, then Default machine again, never restarts it.
		await choose("member", laptop.id);
		await choose("member", null);
		expect(await laptop.poll([channel.id])).toEqual({ waiting: true });
		expect((await choice("member")).planner)
			.toEqual({ state: "attached", login: "member", machine: laptop.id });

		// A new favorite takes it over.
		await favor("member", desk.id);
		expect(await link.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(await laptop.poll([channel.id])).toEqual({
			kind: "planners",
			planners: [],
			stopped: { [channel.id]: expect.stringContaining("changed their favorite machine") },
		});
		expect(await desk.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
	});

	it("stops the Planner once nobody has used the document for a while", async () => {
		let { machine, visit, channel, runtime, open, skew, url } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		await visit();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let link = await laptop.backend();
		await link.next("attached");

		// Open, it keeps its Planner however long it stays open.
		skew.ms = PLANNER_IDLE_MS * 2;
		await runtime.sweep();
		expect(await laptop.poll([channel.id])).toEqual({ waiting: true });

		// Closed, it keeps it a while longer, then the Planner stops.
		open.delete(channel.id);
		await runtime.sweep();
		skew.ms += PLANNER_IDLE_MS - 1_000;
		await runtime.sweep();
		expect(await laptop.poll([channel.id])).toEqual({ waiting: true });
		skew.ms += 2_000;
		await runtime.sweep();
		expect(await link.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(await laptop.poll([channel.id])).toEqual({
			kind: "planners",
			planners: [],
			stopped: { [channel.id]: expect.stringContaining("Nobody has used this document") },
		});
	});

	/** A Default machine Planner, attached and running a session, on a document nobody has open. */
	async function unwatched() {
		let dispatch = await dispatchServer();
		let { machine, visit, channel, server, runtime, open } = dispatch;
		let laptop = await machine("member", "U_member", "laptop");
		await visit();
		await laptop.poll([]);
		let link = await laptop.backend();
		await link.next("attached");
		let room = await hostInputRoom();
		cleanups.push(room.close);
		let planner: RemotePlanner = {
			channelId: channel.id,
			isolated: false,
			humanInput: report => createHumanInput(room.room, undefined, report),
		};
		let started = link.next("start").then(start => {
			link.send({ type: "started", session: start.session });
		});
		let session = await server.links.at(-1)!.startSession("planner-session", planner);
		cleanups.push(() => session.doDestroy?.());
		await started;
		open.delete(channel.id);
		await runtime.sweep();
		/** Lets `ms` go by on the server's clock with nobody viewing, and whether it still runs. */
		let idle = async (ms: number) => {
			dispatch.skew.ms += ms;
			await runtime.sweep();
			let answer = await laptop.poll([channel.id]);
			return "waiting" in answer;
		};
		return { ...dispatch, laptop, link, room, session, idle };
	}

	it("keeps the Planner while it waits on a question, and stops it once that has been answered for a while", async () => {
		let { link, room, idle } = await unwatched();
		link.send({
			type: "input-request",
			request: "ship",
			session: "planner-session",
			input: { method: "confirm", title: "Ship?", message: "Now." },
		});
		let [card] = await room.cards(1);
		expect(await idle(PLANNER_IDLE_MS + 60_000)).toBe(true);
		expect(await idle(PLANNER_IDLE_MS * 4)).toBe(true);
		expect(room.plan.records.get(card!.id)?.status).toBe("open");

		await room.answer(card!.id, [0]);
		expect(await link.next("input-result")).toMatchObject({ status: "answered", value: true });
		expect(await idle(PLANNER_IDLE_MS - 1_000)).toBe(true);
		expect(await idle(2_000)).toBe(false);
		expect(await link.next("refused")).toMatchObject({ code: "access-revoked" });
	});

	it("keeps the Planner through a reply that runs past the idle threshold, and counts idle time only from its end", async () => {
		let { link, session, idle } = await unwatched();
		let turn = session.doPromptTurn({
			prompt: "outline the plan",
			skills: [],
			tools: [],
			emit: () => {},
		});
		let { turn: id } = await link.next("turn");
		await turn;
		expect(await idle(PLANNER_IDLE_MS + 60_000)).toBe(true);
		expect(await idle(PLANNER_IDLE_MS * 4)).toBe(true);

		link.send({ type: "turn-end", session: "planner-session", turn: id, status: "finished" });
		await Bun.sleep(50);
		expect(await idle(PLANNER_IDLE_MS - 1_000)).toBe(true);
		expect(await idle(2_000)).toBe(false);
		expect(await link.next("refused")).toMatchObject({ code: "access-revoked" });
	});

	it("keeps the Planner while one of its workflow runs is live or paused", async () => {
		let { link, idle } = await unwatched();
		let runs = async (active: string[], paused: string[]) => {
			link.send({ type: "runs", session: "planner-session", active, paused, cards: [] });
			await Bun.sleep(50);
		};
		await runs(["root"], []);
		expect(await idle(PLANNER_IDLE_MS + 60_000)).toBe(true);
		await runs([], ["root"]);
		expect(await idle(PLANNER_IDLE_MS + 60_000)).toBe(true);
		await runs([], []);
		expect(await idle(PLANNER_IDLE_MS - 1_000)).toBe(true);
		expect(await idle(2_000)).toBe(false);
	});
});

describe("a teammate's machine shared with teammates", () => {
	it("runs the Planner of a document whose creator has no machine, as its owner", async () => {
		let { machine, share, visit, choice, channel, runtime, url } = await dispatchServer();
		// The creator's own machine can't run Planners, so it doesn't count as theirs here.
		let plain = await machine("member", "U_member", "plain", { plannerCommand: false });
		let box = await machine("rival", "U_rival", "build-box");
		// Not shared: a teammate's machine is never anyone else's Default machine.
		await visit();
		expect(await box.poll([])).toEqual({ waiting: true });
		expect((await choice("member")).planner).toEqual({ state: "none", login: null, machine: null });

		expect(await share("rival", box.id)).toBe(200);
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		expect((await choice("member")).planner)
			.toEqual({ state: "starting", login: "rival", machine: box.id });
		expect(await runtime.plannerStarting(channel.id)).toEqual({
			login: "rival",
			machineId: box.id,
		});

		expect(await plain.poll([])).toEqual({ waiting: true });

		let link = await box.backend();
		await link.next("attached");
		expect((await choice("member")).planner)
			.toEqual({ state: "held", login: "rival", machine: null });
	});

	it("takes a machine shared as it pairs, and finds it for a document opened before it connected", async () => {
		let { machine, machines, visit, channel, url } = await dispatchServer();
		await visit();
		// Shared from the start, as the pairing page's switch pairs it, and connected only now.
		let box = await machine("rival", "U_rival", "build-box", { shared: true });
		expect((await machines.current(box.id)).shared).toBe(true);
		expect(await box.poll([], 1_000)).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
	});

	it("stops the Planner when its owner stops sharing, and tells the machine why", async () => {
		let { machine, share, visit, choice, channel, url } = await dispatchServer();
		let box = await machine("rival", "U_rival", "build-box");
		await share("rival", box.id);
		await visit();
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		let link = await box.backend();
		await link.next("attached");

		expect(await share("rival", box.id, false)).toBe(200);
		expect(await link.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(await box.poll([channel.id])).toEqual({
			kind: "planners",
			planners: [],
			stopped: { [channel.id]: expect.stringContaining("stopped sharing build-box") },
		});
		expect((await choice("member")).planner).toEqual({ state: "none", login: null, machine: null });
	});

	it("prefers the creator's own machine, and moves there from a teammate's while not attached", async () => {
		let { machine, share, visit, channel, url } = await dispatchServer();
		let box = await machine("rival", "U_rival", "build-box");
		await share("rival", box.id);
		let laptop = await machine("member", "U_member", "laptop");
		await visit();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		expect(await box.poll([])).toEqual({ waiting: true });

		// Another document starts on the teammate's machine while the creator has none online.
		let other = await dispatchServer();
		let otherBox = await other.machine("rival", "U_rival", "build-box");
		await other.share("rival", otherBox.id);
		await other.visit();
		expect(await otherBox.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: other.channel.id, url }],
		});
		// The creator's own machine comes online before it attached: the Planner moves there.
		let desk = await other.machine("member", "U_member", "desk");
		expect(await desk.poll([], 1_000)).toEqual({
			kind: "planners",
			planners: [{ id: other.channel.id, url }],
		});
		expect(await otherBox.poll([other.channel.id])).toEqual({ kind: "planners", planners: [] });
	});

	it("keeps an attached Planner on the teammate's machine when the creator's own comes online", async () => {
		let { machine, share, visit, channel, server, url } = await dispatchServer();
		let box = await machine("rival", "U_rival", "build-box");
		await share("rival", box.id);
		await visit();
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		let link = await box.backend();
		await link.next("attached");
		let laptop = await machine("member", "U_member", "laptop");
		expect(await laptop.poll([])).toEqual({ waiting: true });
		expect(await box.poll([channel.id])).toEqual({ waiting: true });
		expect(server.attachments.holding(channel.id)?.machineId).toBe(box.id);
	});

	it("passes over a shared machine whose owner can't push to the repository", async () => {
		let { machine, share, visit, choice } = await dispatchServer();
		// A protocol 5 machine connects for any repository, whatever its owner can push to.
		let box = await machine("viewer", "U_viewer", "viewer-box", { protocol: 5 });
		expect(await share("viewer", box.id)).toBe(200);
		await visit();
		expect(await box.poll([])).toEqual({ waiting: true });
		expect((await choice("member")).planner).toEqual({ state: "none", login: null, machine: null });
	});

	/** rival's shared build-box runs the member's document's Planner, attached with a live session. */
	async function sharedAndAttached() {
		let dispatch = await dispatchServer();
		let { machine, share, visit, channel, server } = dispatch;
		let box = await machine("rival", "U_rival", "build-box");
		await share("rival", box.id);
		await visit();
		await box.poll([]);
		let link = await box.backend();
		await link.next("attached");
		let room = await hostInputRoom();
		cleanups.push(room.close);
		let planner: RemotePlanner = {
			channelId: channel.id,
			isolated: false,
			humanInput: report => createHumanInput(room.room, undefined, report),
		};
		let started = link.next("start").then(start => {
			link.send({ type: "started", session: start.session });
		});
		let session = await server.links.at(-1)!.startSession("planner-session", planner);
		cleanups.push(() => session.doDestroy?.());
		await started;
		/** What build-box is told about the document's Planner after a sweep. */
		let afterSweep = async () => {
			await dispatch.runtime.sweep();
			return box.poll([channel.id]);
		};
		let stillRuns = async () => "waiting" in await afterSweep();
		let finishing = async () =>
			(await (await dispatch.send("/api/connector/machines", { login: "rival" })).json())
				.machines[0].finishing as number;
		return { ...dispatch, box, link, room, session, afterSweep, stillRuns, finishing };
	}

	it("keeps a teammate's Planner through an open question when sharing stops, then stops it", async () => {
		let { share, box, link, room, afterSweep, stillRuns, finishing, choice, channel } =
			await sharedAndAttached();
		link.send({
			type: "input-request",
			request: "ship",
			session: "planner-session",
			input: { method: "confirm", title: "Ship?", message: "Now." },
		});
		let [card] = await room.cards(1);
		expect(await share("rival", box.id, false)).toBe(200);
		expect(await stillRuns()).toBe(true);
		expect(await finishing()).toBe(1);
		expect((await choice("member")).planner)
			.toEqual({ state: "held", login: "rival", machine: null });

		await room.answer(card!.id, [0]);
		expect(await link.next("input-result")).toMatchObject({ status: "answered", value: true });
		expect(await afterSweep()).toEqual({
			kind: "planners",
			planners: [],
			stopped: { [channel.id]: expect.stringContaining("stopped sharing build-box") },
		});
		expect(await link.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(await finishing()).toBe(0);
	});

	it("keeps a teammate's Planner through its reply when sharing stops, then stops it", async () => {
		let { share, box, link, session, stillRuns } = await sharedAndAttached();
		let turn = session.doPromptTurn({
			prompt: "outline the plan",
			skills: [],
			tools: [],
			emit: () => {},
		});
		let { turn: id } = await link.next("turn");
		await turn;
		expect(await share("rival", box.id, false)).toBe(200);
		expect(await stillRuns()).toBe(true);
		link.send({ type: "turn-end", session: "planner-session", turn: id, status: "finished" });
		await Bun.sleep(50);
		expect(await stillRuns()).toBe(false);
		expect(await link.next("refused")).toMatchObject({ code: "access-revoked" });
	});

	it("keeps it through a live run, not a paused one, and keeps it when shared again meanwhile", async () => {
		let { share, box, link, stillRuns, finishing } = await sharedAndAttached();
		let runs = async (active: string[], paused: string[]) => {
			link.send({ type: "runs", session: "planner-session", active, paused, cards: [] });
			await Bun.sleep(50);
		};
		await runs(["root"], []);
		expect(await share("rival", box.id, false)).toBe(200);
		expect(await stillRuns()).toBe(true);
		// Shared again before it finished: nothing is stopped later.
		expect(await share("rival", box.id)).toBe(200);
		expect(await finishing()).toBe(0);
		await runs([], ["root"]);
		expect(await stillRuns()).toBe(true);

		// A paused run waits on people, not on the machine: sharing off stops the Planner at once.
		expect(await share("rival", box.id, false)).toBe(200);
		expect(await link.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(await stillRuns()).toBe(false);
	});

	it("lets only the owner share a machine", async () => {
		let { machine, share } = await dispatchServer();
		let box = await machine("rival", "U_rival", "build-box");
		expect(await share("member", box.id)).toBe(404);
	});
});

describe("a machine's GitHub token", () => {
	it("goes only to the owner's machine, for a repository its owner can push to", async () => {
		let { machine, machines, send } = await dispatchServer();
		let ask = (bearer: string, repository: string) =>
			send("/api/connector/github-token", {
				bearer,
				headers: { [CONNECTOR_VERSION_HEADER]: "dev", [CONNECTOR_PROTOCOL_HEADER]: "4" },
				body: { repository },
			});
		let member = await machine("member", "U_member", "box");
		let issued = await ask(member.token, "octo-org/score");
		expect(issued.status).toBe(200);
		let body = await issued.json();
		// The machine's own access token, never its refresh token.
		expect(body).toEqual({ token: machineToken("member"), expiresAt: expect.any(Number) });
		expect(JSON.stringify(body)).not.toContain("refresh");
		// A viewer can't push, so its machine gets none; neither does a bearer that isn't a machine.
		let viewer = await machines.pair({
			userId: "U_viewer",
			label: "box",
			repositories: [],
			autoRun: false,
			grant: {
				accessToken: machineToken("viewer"),
				accessExpiresIn: 28_800,
				refreshToken: "viewer-refresh",
				refreshExpiresIn: 15_897_600,
			},
		});
		expect((await ask(viewer.token, "octo-org/score")).status).toBe(403);
		expect((await ask("chopin_m_unknown", "octo-org/score")).status).toBe(401);
	});
});
