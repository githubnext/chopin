import { afterEach, describe, expect, it } from "bun:test";
import { AGENT_VERSION, LINK_CLOSE } from "@chopin/agent-link";
import {
	CONNECTOR_PLANNER_COMMAND_HEADER,
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_VERSION_HEADER,
} from "@chopin/protocol/connector";

import { Machines } from "../../auth/machines";
import {
	offlineMessage,
	PLANNER_IDLE_MS,
	registerExperimentRoutes,
	unavailableMessage,
} from "../../experiments/routes";
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
import { disconnectedMessage, notAttachedMessage, startingMessage } from "./attachments";
import { MachinePlanners } from "./machine-planners";

import type { RepositoryPage } from "../../github/client";
import type { RemotePlanner } from "./registry";

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * A HARNESS=remote server whose accounts pair machines that connect checkouts of octo-org/score,
 * choose them for the linked document, and run its Planner on them over the agent connection.
 */
async function dispatchServer(
	/** `planners: false` is a server that runs no Planner on machines, as with AGENT=off. */
	{ planners: runsPlanners = true }: { planners?: boolean } = {},
) {
	let linked = await linkAuth();
	let { auth, storage, sessions, cookies, channel } = linked;
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	/** Documents open in Chopin now, as `main.ts` says from its rooms; and how far the clock moved. */
	let open = new Set<string>();
	let skew = { ms: 0 };
	let clock = () => new Date(Date.now() + skew.ms);
	let machines!: Machines;
	let planners!: MachinePlanners;
	let server!: ReturnType<typeof linkServer>;
	let router!: Router;
	let runtime!: ReturnType<typeof registerExperimentRoutes>;
	/**
	 * One server process over the same storage: its machines' credentials, agent connection and
	 * routes, and everything they keep in memory. `restart()` starts another, as a deploy does.
	 */
	function start() {
		machines = new Machines(storage, () => new Date(), {
			key: new Uint8Array(32).fill(7),
			origin: auth.config.origin,
			clientId: "client",
			authorize: async (userId, token) => (await auth.admission.user(token)).id === userId,
		});
		planners = new MachinePlanners({
			machines,
			sessions,
			storage,
			github: auth.github,
			config: auth.config,
		});
		server = linkServer(auth, 2_000, undefined, 300, undefined, planners);
		cleanups.push(server.stop);
		router = new Router();
		runtime = registerExperimentRoutes(
			router,
			{ ...auth, clock, machines, pairings: {} } as never,
			{
				lease: () => lease,
				changed: () => {},
				context: async () => ({ source: "# Context", revision: 0 }),
				...runsPlanners ? { planners } : {},
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
	}
	start();
	/** The server process ends and another starts: every machine connects again, as its connector does. */
	async function restart() {
		await server.stop();
		start();
	}

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
		connector: {
			protocol?: number;
			plannerCommand?: boolean;
			shared?: boolean;
			/** Connect with no checkout, as a protocol 5 connector does where it clones what it needs. */
			bare?: boolean;
			/** The chopin release it says it runs. */
			version?: string;
		} = {},
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
		let protocol = connector.protocol ?? (connector.bare ? 5 : 4);
		/** `chopin connect` on the machine: a connection of its own, as after a restart. */
		async function connect() {
			let opened = await send("/api/connector/connections", {
				bearer: token,
				body: connector.bare
					? { label: "score", checkouts: [] }
					: { repository: "octo-org/score", commit: "a".repeat(40), label: "score" },
				headers: {
					[CONNECTOR_VERSION_HEADER]: connector.version ?? "dev",
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
		async function backend(feature?: string) {
			let raw = await rawLink(server.url, await credential(), feature);
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
	/** `GET /api/connector/machines` as a signed-in person: their own and their teammates'. */
	let listing = async (login: string) =>
		(await (await send("/api/connector/machines", { login })).json()).machines as Array<
			Record<string, unknown>
		>;
	/** Someone opens the document in Chopin; closing it starts its idle time. */
	let visit = async (id = channel.id) => {
		open.add(id);
		await runtime.plannerUsed(id);
	};
	let url = expect.stringContaining(`https://chopin.test/`);
	return {
		...linked,
		// The current process's: another after `restart()`.
		get machines() {
			return machines;
		},
		get planners() {
			return planners;
		},
		get server() {
			return server;
		},
		get runtime() {
			return runtime;
		},
		restart,
		open,
		skew,
		send,
		machine,
		choose,
		choice,
		favor,
		share,
		listing,
		visit,
		url,
	};
}

/** The status an agent connection's upgrade gets with `credential`: 101 when it opens. */
async function upgrade(url: string, credential: string) {
	let response = await upgradeRequest(url, { authorization: `Bearer ${credential}` });
	return response.status;
}

/**
 * Count the GitHub calls each token makes: repository checks (`asked`), and the installation and
 * repository listings that make up a list of what someone can push to (`listed`); and how many
 * repository checks run at once.
 */
function counting(github: {
	repositoryAccess: (token: string, owner: string, name: string) => Promise<unknown>;
	installations: (token: string, page: number) => Promise<unknown>;
	installationRepositories: (token: string, installation: string, page: number) => Promise<unknown>;
}) {
	let asked = new Map<string, number>();
	let listed = new Map<string, number>();
	let running = { now: 0, most: 0 };
	let access = github.repositoryAccess;
	github.repositoryAccess = async (token, owner, name) => {
		asked.set(token, (asked.get(token) ?? 0) + 1);
		running.now++;
		running.most = Math.max(running.most, running.now);
		try {
			await Bun.sleep(5);
			return await access(token, owner, name);
		} finally {
			running.now--;
		}
	};
	let installations = github.installations;
	github.installations = async (token, page) => {
		listed.set(token, (listed.get(token) ?? 0) + 1);
		await Bun.sleep(5);
		return installations(token, page);
	};
	let repositories = github.installationRepositories;
	github.installationRepositories = async (token, installation, page) => {
		listed.set(token, (listed.get(token) ?? 0) + 1);
		await Bun.sleep(5);
		return repositories(token, installation, page);
	};
	return {
		asked: (token: string) => asked.get(token) ?? 0,
		listed: (token: string) => listed.get(token) ?? 0,
		running,
	};
}

/**
 * What GitHub lists of the App's one installation: for each token the repositories of octo-org
 * `names` gives, all of them pushable, a hundred to a page; for a token it names none, what the
 * account can really do.
 */
function installed(
	github: {
		installationRepositories: (
			token: string,
			installation?: string,
			page?: number,
		) => Promise<RepositoryPage>;
	},
	names: (token: string) => string[] | undefined,
) {
	let original = github.installationRepositories;
	github.installationRepositories = async (token, installation, page = 1) => {
		let all = names(token);
		if (!all) return original(token, installation, page);
		let first = (page - 1) * 100;
		return {
			repositories: all.slice(first, first + 100).map(name => ({
				id: `R_${name}`,
				owner: "octo-org",
				name,
				fullName: `octo-org/${name}`,
				private: true,
				url: `https://github.test/octo-org/${name}`,
				defaultBranch: "main",
				permissions: { pull: true, push: true, admin: false },
			})),
			nextPage: first + 100 < all.length ? page + 1 : undefined,
		};
	};
}

/** GitHub failing to list installations for the tokens that start with `prefix`, while `down.now`. */
function unavailable(
	github: { installations: (token: string, page: number) => Promise<unknown> },
	prefix: string,
) {
	let down = { now: true };
	let listed = github.installations;
	github.installations = async (token, page) => {
		if (down.now && token.startsWith(prefix)) throw new Error("GitHub is unavailable");
		return listed(token, page);
	};
	return down;
}

/** `count` repositories, `repo-0` on, then the ones named in `last`. */
function others(count: number, ...last: string[]) {
	return [...Array.from({ length: count }, (_, index) => `repo-${index}`), ...last];
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

		// One launch that exited is a transient failure: the document still just says starting, and
		// counts the launch it waits on, the second.
		expect((await laptop.report(failing(channel.id, 1))).status).toBe(200);
		expect(await runtime.plannerStarting(channel.id)).toEqual({
			login: "member",
			machineId: laptop.id,
			attempt: 2,
		});

		// The second in a row is not.
		let reason = "unsafe-checkout: ~/src/score's own git configuration sets a credential helper";
		let before = Date.now();
		expect(await (await laptop.report(failing(channel.id, 2, reason))).json())
			.toEqual({ recorded: true });
		expect(await runtime.plannerStarting(channel.id)).toEqual({
			login: "member",
			machineId: laptop.id,
			attempt: 3,
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
			"Still connecting to @mona's machine. Try again in a moment.",
		);
		expect(
			startingMessage("mona", {
				attempts: 3,
				reason: "unsafe-checkout: refused",
				at: "2026-11-04T02:00:00.000Z",
			}),
		).toBe(
			"Can't connect to @mona's machine: unsafe-checkout: refused "
				+ "(3 attempts in a row). It keeps trying; try again once that is fixed.",
		);
	});

	it("refuses in plain words that name none of Chopin's own terms, only a machine and the person's work", () => {
		let internal = /planner|attach|\bheld\b|\bdecisions?\b|@chopin/i;
		let at = "2026-11-04T02:00:00.000Z";
		let messages = [
			notAttachedMessage(
				"https://chopin.test/documents/octo-org/score/plan",
				"octo-org/score",
				true,
			),
			notAttachedMessage("https://chopin.test/documents/octo-org/score/plan", "octo-org/score"),
			disconnectedMessage("mona"),
			disconnectedMessage(undefined),
			startingMessage("mona"),
			// The reason is the machine's own words, kept as reported, so a neutral one is used here.
			startingMessage("mona", { attempts: 3, reason: "exit 127", at }),
		];
		for (let message of messages) expect(internal.test(message), message).toBe(false);
		expect(notAttachedMessage("u", "r", true)).toStartWith("Connect a machine to get a reply.");
		expect(notAttachedMessage("u", "r")).toStartWith("Connect a machine to get a reply.");
		expect(disconnectedMessage("mona")).toBe(
			"@mona's machine is offline, so it can't reply now. Your work is kept and picks up when it's back.",
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
		let { machine, choose, choice, visit, channel, server, url } = await dispatchServer();
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

		// The creator chose no machine now, so the member's stored choice counts again: it is asked
		// once the Planner on Default machine has ended, and Default machine no more.
		mine.send({ type: "detach" });
		for (let deadline = Date.now() + 4_000; server.attachments.holder(channel.id);) {
			expect(Date.now()).toBeLessThan(deadline);
			await Bun.sleep(50);
		}
		expect(await rivals.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		expect(await laptop.poll([channel.id])).toEqual({ kind: "planners", planners: [] });
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

	it("keeps naming the machine whose backend holds the Planner, and listing it connected, while a new process has yet to hear from its connector", async () => {
		let dispatch = await dispatchServer();
		let { machine, favor, visit, choice, channel, url, listing } = dispatch;
		let desk = await machine("member", "U_member", "desk");
		await favor("member", desk.id);
		await visit();
		expect(await desk.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		let first = await desk.backend();
		await first.next("attached");
		expect((await choice("member")).automatic).toMatchObject({ id: desk.id, label: "desk" });

		// A deploy: every connection is forgotten, and the connector has not asked again.
		await dispatch.restart();
		expect((await choice("member")).machines[0]).toMatchObject({ id: desk.id, connected: false });
		expect((await choice("member")).automatic).toBeNull();

		// Its backend, with the credential it was given, is back first: the machine is running.
		let second = await desk.backend();
		await second.next("attached");
		let after = await choice("member");
		expect(after.planner).toEqual({ state: "attached", login: "member", machine: desk.id });
		expect(after.automatic).toMatchObject({ id: desk.id, label: "desk" });
		expect(after.machines[0]).toMatchObject({ id: desk.id, connected: true });
		expect((await listing("member")).find(value => value.id === desk.id)).toMatchObject({
			connected: true,
		});
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
	async function unwatched(resumable = false) {
		let dispatch = await dispatchServer();
		let { machine, visit, channel, server, runtime, open } = dispatch;
		let laptop = await machine("member", "U_member", "laptop");
		await visit();
		await laptop.poll([]);
		let link = await laptop.backend(resumable ? "resumable-sessions" : undefined);
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

	it("keeps a Planner whose machine went quiet, with its work, however long it stays away, and offers its document to no other machine", async () => {
		let { link, laptop, idle, machine, channel, runtime, server, url, choice } = await unwatched(
			true,
		);
		link.send({
			type: "runs",
			session: "planner-session",
			active: ["root"],
			paused: [],
			cards: [],
		});
		await Bun.sleep(50);
		let desk = await machine("member", "U_member", "desk");
		// The machine sleeps: its backend's link and its connector's connection both end.
		link.socket.close();
		await link.closed;
		await laptop.disconnect();
		await Bun.sleep(100);
		expect(server.attachments.status(channel.id)).toEqual({
			state: "disconnected",
			login: "member",
		});
		// What the document's machine menu reads says the same, not that a Planner is starting.
		expect((await choice("member")).planner)
			.toEqual({ state: "disconnected", login: "member", machine: laptop.id });
		// Hours past the idle period, with nobody viewing: nothing stops it, and no other machine
		// of its owner is asked to take the document over.
		for (let ms of [PLANNER_IDLE_MS + 60_000, PLANNER_IDLE_MS * 4, PLANNER_IDLE_MS * 40]) {
			await runtime.sweep();
			expect(await idle(ms)).toBe(false);
			expect(await desk.poll([])).toEqual({ waiting: true });
			expect(server.attachments.status(channel.id)).toEqual({
				state: "disconnected",
				login: "member",
			});
		}
		// It wakes: its connector is asked for the document again, and its backend resumes.
		await laptop.reconnect();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let back = await laptop.backend("resumable-sessions");
		await back.next("attached");
		back.send({ type: "resume", sessions: [{ session: "planner-session", requests: [] }] });
		expect(await back.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: "planner-session", requests: [] }],
		});
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

describe("a teammate's shared machine, listed read-only", () => {
	/** rival's shared build-box, with no checkout, and member who can push to octo-org/score. */
	async function teammates() {
		let dispatch = await dispatchServer();
		let box = await dispatch.machine("rival", "U_rival", "build-box", {
			bare: true,
			shared: true,
			version: "0.1.5",
		});
		return { ...dispatch, box };
	}

	it("shows a machine with no checkouts to a teammate for the repositories its owner and they can push to", async () => {
		let { listing, box } = await teammates();
		let [row, ...rest] = await listing("member");
		expect(rest).toEqual([]);
		expect(row).toEqual({
			id: box.id,
			label: "build-box",
			teammate: true,
			owner: { login: "rival", avatarUrl: "" },
			repositories: ["octo-org/score"],
			connected: true,
			version: "0.1.5",
			service: false,
			// Whether it is the viewer's own favorite, which no one else sees.
			favorite: false,
			// When it was paired: the order the person's own machines are listed in, newest first.
			createdAt: expect.any(Number),
			lastSeenAt: expect.any(Number),
		});
	});

	it("gives a teammate's machine the creation time the person's own are listed by, in the Machines list and in the document's menu", async () => {
		let { listing, choice, storage, machine, box } = await teammates();
		let laptop = await machine("member", "U_member", "laptop", { bare: true });
		let created = async (id: string) => (await storage.machines.get(id))!.createdAt.getTime();
		let rows = await listing("member");
		expect(rows.find(value => value.id === box.id)).toMatchObject({
			teammate: true,
			createdAt: await created(box.id),
		});
		expect(rows.find(value => value.id === laptop.id)).toMatchObject({
			teammate: false,
			createdAt: await created(laptop.id),
		});
		let menu = (await choice("member")).machines as Array<{ id: string; createdAt: number }>;
		expect(menu.find(value => value.id === box.id)?.createdAt).toBe(await created(box.id));
		expect(menu.find(value => value.id === laptop.id)?.createdAt).toBe(await created(laptop.id));
	});

	it("lists a shared machine once to its owner, as theirs, never as a teammate's", async () => {
		let { listing, choice, box } = await teammates();
		// rival can push to the repository too, so the machine would qualify for them as a teammate's.
		let own = (await listing("rival")).filter(value => value.id === box.id);
		expect(own).toHaveLength(1);
		expect(own[0]).toMatchObject({ teammate: false, shared: true });
		let menu = (await choice("rival")).machines.filter((value: { id: string }) =>
			value.id === box.id
		);
		expect(menu).toHaveLength(1);
		expect(menu[0]).toMatchObject({ teammate: false });
	});

	it("leaves out what only the owner may see or change", async () => {
		let { listing, box } = await teammates();
		let [row] = await listing("member");
		for (
			let owned of [
				"autoRun",
				"reauthorize",
				"finishing",
				"shared",
				"hostname",
				"platform",
				"agent",
			]
		) {
			expect(row).not.toHaveProperty(owned);
		}
		// The owner's own row has them all, and says it is theirs.
		expect((await listing("rival")).find(value => value.id === box.id)).toMatchObject({
			teammate: false,
			autoRun: false,
			shared: true,
			reauthorize: false,
			finishing: 0,
			favorite: false,
		});
	});

	it("never shows a machine that is not shared, or whose owner can't push to the repository", async () => {
		let { machine, listing, share, box } = await teammates();
		// Not shared: nobody but its owner sees it.
		let plain = await machine("rival", "U_rival", "private", { bare: true });
		expect((await listing("member")).map(value => value.id)).toEqual([box.id]);
		expect((await listing("rival")).map(value => value.id).sort())
			.toEqual([box.id, plain.id].sort());
		// Shared by an owner who can only pull: it serves nothing a teammate could push to.
		let viewers = await machine("viewer", "U_viewer", "viewer-box", { bare: true, shared: true });
		expect((await listing("member")).map(value => value.id)).toEqual([box.id]);
		expect((await listing("viewer")).map(value => value.id)).toEqual([viewers.id]);
		expect(await share("rival", plain.id)).toBe(200);
		expect((await listing("member")).map(value => value.id).sort())
			.toEqual([box.id, plain.id].sort());
	});

	it("shows nothing to someone who can't push to any repository the machine serves", async () => {
		let { listing } = await teammates();
		// A reader can pull from the repository, but can't push to it.
		expect(await listing("viewer")).toEqual([]);
	});

	it("says whether a teammate's machine is online, and keeps listing it offline", async () => {
		let { listing, box } = await teammates();
		expect((await listing("member"))[0]).toMatchObject({ connected: true, version: "0.1.5" });
		await box.disconnect();
		let [row] = await listing("member");
		expect(row).toMatchObject({ id: box.id, connected: false, version: null, teammate: true });
	});

	it("takes a machine back off the list when its owner stops sharing it", async () => {
		let { listing, share, box } = await teammates();
		expect(await listing("member")).toHaveLength(1);
		expect(await share("rival", box.id, false)).toBe(200);
		expect(await listing("member")).toEqual([]);
		expect(await listing("rival")).toHaveLength(1);
		expect(await share("rival", box.id)).toBe(200);
		expect(await listing("member")).toHaveLength(1);
	});

	it("never offers a revoked machine", async () => {
		let { listing, send, box } = await teammates();
		let revoked = await send(`/api/connector/machines/${box.id}/revoke`, {
			login: "rival",
			body: {},
		});
		expect(revoked.status).toBe(200);
		expect(await listing("member")).toEqual([]);
	});

	it("never lets a teammate rename, share, stop sharing or disconnect it", async () => {
		let { send, listing, box } = await teammates();
		for (
			let [action, body] of [
				["label", { label: "mine now" }],
				["shared", { shared: false }],
				["revoke", {}],
			] as const
		) {
			let refused = await send(`/api/connector/machines/${box.id}/${action}`, {
				login: "member",
				body,
			});
			expect(refused.status).toBe(404);
		}
		let [row] = await listing("member");
		expect(row).toMatchObject({ id: box.id, label: "build-box", connected: true });
		expect((await listing("rival"))[0]).toMatchObject({ shared: true, favorite: false });
	});

	it("shows a machine with no checkouts for the repositories both can push to, with no project opened", async () => {
		let { machine, listing } = await dispatchServer();
		let box = await machine("rival", "U_rival", "build-box", { bare: true, shared: true });
		// Neither member nor rival has opened a document in octo-org/score, which both can push to.
		expect(await listing("member")).toEqual([
			expect.objectContaining({ id: box.id, teammate: true, repositories: ["octo-org/score"] }),
		]);
	});

	it("lists a machine for the repositories it has checkouts of even when GitHub can't list the person's installations", async () => {
		let { auth, machine, listing } = await dispatchServer();
		auth.github.installations = async () => {
			throw new Error("GitHub is unavailable");
		};
		// A checkout of octo-org/score, as the connector registers it.
		let box = await machine("rival", "U_rival", "build-box", { shared: true });
		expect(await listing("member")).toEqual([
			expect.objectContaining({ id: box.id, repositories: ["octo-org/score"] }),
		]);
	});

	it("never names a repository the person can't push to, even one the machine has a checkout of", async () => {
		let { machine, listing } = await dispatchServer();
		// The checkout is of octo-org/score, which viewer can only pull.
		await machine("rival", "U_rival", "build-box", { shared: true });
		expect(await listing("viewer")).toEqual([]);
	});

	it("lists every repository both can push to for a machine with no checkouts, however many their installations list", async () => {
		let { auth, machine, listing } = await dispatchServer();
		// member's installation lists 250 repositories over three pages, octo-org/score the last;
		// rival's lists three of them, octo-org/score too.
		installed(auth.github, token =>
			token.startsWith("rival")
				? ["repo-3", "score", "repo-120"]
				: others(249, "score"));
		await machine("rival", "U_rival", "build-box", { bare: true, shared: true });
		let [row] = await listing("member");
		expect(row!.repositories).toEqual(["octo-org/repo-3", "octo-org/repo-120", "octo-org/score"]);
	});

	it("lists a machine with no checkouts for someone with no projects whose only repository both can push to comes after their first fifty", async () => {
		let { auth, machine, listing } = await dispatchServer();
		installed(auth.github, token => token.startsWith("rival") ? ["score"] : others(50, "score"));
		let box = await machine("rival", "U_rival", "build-box", { bare: true, shared: true });
		expect(await listing("member")).toEqual([
			expect.objectContaining({ id: box.id, repositories: ["octo-org/score"] }),
		]);
	});

	it("asks GitHub for the machine owner's repositories once for everyone and every poll, a pass held ten minutes", async () => {
		let { auth, machine, listing, skew } = await dispatchServer();
		// Both signed-in teammates can push to 120 repositories, the owner to octo-org/score alone,
		// so a check of each of theirs with the owner's token would ask 120 times.
		installed(auth.github, token => token.startsWith("guest") ? ["score"] : others(120, "score"));
		let box = await machine("guest", "U_guest", "build-box", { bare: true, shared: true });
		let github = counting(auth.github);
		let polled = async () => {
			for (let poll = 0; poll < 20; poll++) {
				for (let login of ["member", "rival"]) {
					expect((await listing(login)).map(value => value.id)).toEqual([box.id]);
				}
			}
		};
		await polled();
		// The owner's installations and one repository listing, each person's and no more.
		expect(github.listed("guest-machine-1")).toBe(2);
		expect(github.asked("guest-machine-1")).toBe(0);
		for (let login of ["member", "rival"]) {
			expect(github.listed(`${login}-browser-login`)).toBe(3);
			expect(github.asked(`${login}-browser-login`)).toBe(0);
		}
		// A minute on, the people's lists are asked for again, not the owner's.
		skew.ms = 61_000;
		await polled();
		expect(github.listed("guest-machine-1")).toBe(2);
		for (let login of ["member", "rival"]) {
			expect(github.listed(`${login}-browser-login`)).toBe(6);
		}
		skew.ms = 9 * 60_000;
		await polled();
		expect(github.listed("guest-machine-1")).toBe(2);
		skew.ms = 11 * 60_000;
		await polled();
		expect(github.listed("guest-machine-1")).toBe(4);
		expect(github.asked("guest-machine-1")).toBe(0);
	});

	it("asks for the machine owner's repositories once, not per machine of theirs", async () => {
		let { auth, machine, listing } = await dispatchServer();
		installed(auth.github, token => token.startsWith("guest") ? ["score"] : others(60, "score"));
		let first = await machine("guest", "U_guest", "build-box", { bare: true, shared: true });
		let second = await machine("guest", "U_guest", "desk", { bare: true, shared: true });
		let github = counting(auth.github);
		for (let poll = 0; poll < 5; poll++) {
			expect((await listing("member")).map(value => value.id).sort())
				.toEqual([first.id, second.id].sort());
		}
		expect(github.listed("guest-machine-1")).toBe(2);
	});

	it("lists the machines of an owner whose other machine needs its GitHub authorization renewed, from the machine that can ask", async () => {
		let { auth, storage, machine, listing, choice } = await dispatchServer();
		installed(auth.github, token => token.startsWith("guest") ? ["score"] : others(60, "score"));
		let stale = await machine("guest", "U_guest", "stale-box", { bare: true, shared: true });
		let fresh = await machine("guest", "U_guest", "fresh-box", { bare: true, shared: true });
		await storage.machines.reauthorize(stale.id, 1, new Date());
		let github = counting(auth.github);
		expect((await listing("member")).map(value => value.id)).toEqual([fresh.id]);
		expect((await choice("member")).machines.map((value: { id: string }) => value.id))
			.toEqual([fresh.id]);
		expect(github.listed("guest-machine-1")).toBe(2);
	});

	it("holds a refusal of the machine owner's repositories for a minute, however often it is asked, then asks again", async () => {
		let { auth, machine, listing, skew } = await dispatchServer();
		let box = await machine("guest", "U_guest", "build-box", { bare: true, shared: true });
		let down = unavailable(auth.github, "guest");
		let github = counting(auth.github);
		for (let poll = 0; poll < 10; poll++) expect(await listing("member")).toEqual([]);
		expect(github.listed("guest-machine-1")).toBe(1);
		down.now = false;
		expect(await listing("member")).toEqual([]);
		skew.ms = 61_000;
		expect((await listing("member")).map(value => value.id)).toEqual([box.id]);
		expect(github.listed("guest-machine-1")).toBe(3);
	});

	it("never lists a machine whose owner can only pull, whatever the person can push to", async () => {
		let { auth, machine, listing } = await dispatchServer();
		installed(auth.github, token => token.startsWith("viewer") ? undefined : others(60, "score"));
		await machine("viewer", "U_viewer", "viewer-box", { bare: true, shared: true });
		expect(await listing("member")).toEqual([]);
	});

	it("remembers a refusal of the person's own push check between listings, and asks again a minute on", async () => {
		let { auth, machine, listing, skew } = await dispatchServer();
		// viewer can only pull octo-org/score, which the machine has a checkout of.
		await machine("rival", "U_rival", "build-box", { shared: true });
		let github = counting(auth.github);
		for (let poll = 0; poll < 5; poll++) expect(await listing("viewer")).toEqual([]);
		expect(github.asked("viewer-browser-login")).toBe(1);
		skew.ms = 61_000;
		expect(await listing("viewer")).toEqual([]);
		expect(await listing("viewer")).toEqual([]);
		expect(github.asked("viewer-browser-login")).toBe(2);
	});

	it("remembers that the person can push to a repository their installations don't list for ten minutes", async () => {
		let { auth, machine, listing, skew } = await dispatchServer();
		// Their installations list nothing of the machine's checkout, so they are asked with their own login.
		auth.github.installationRepositories = async () => ({ repositories: [], nextPage: undefined });
		let box = await machine("rival", "U_rival", "build-box", { shared: true });
		let github = counting(auth.github);
		let listed = async () => (await listing("member")).map(value => value.id);
		for (let poll = 0; poll < 5; poll++) expect(await listed()).toEqual([box.id]);
		expect(github.asked("member-browser-login")).toBe(1);
		skew.ms = 9 * 60_000;
		expect(await listed()).toEqual([box.id]);
		expect(github.asked("member-browser-login")).toBe(1);
		skew.ms = 11 * 60_000;
		expect(await listed()).toEqual([box.id]);
		expect(github.asked("member-browser-login")).toBe(2);
	});

	it("asks GitHub once for listings that overlap, for the person and for the machine's owner", async () => {
		let { auth, machine, listing } = await dispatchServer();
		let box = await machine("rival", "U_rival", "build-box", { bare: true, shared: true });
		let github = counting(auth.github);
		let lists = await Promise.all(Array.from({ length: 5 }, () => listing("member")));
		for (let list of lists) expect(list.map(value => value.id)).toEqual([box.id]);
		expect(github.listed("member-browser-login")).toBe(2);
		expect(github.listed("rival-machine-1")).toBe(2);
	});

	it("checks the repositories a machine has checkouts of a few at a time", async () => {
		let { auth, storage, machine, listing } = await dispatchServer();
		installed(auth.github, () => others(40));
		let box = await machine("rival", "U_rival", "build-box", { bare: true, shared: true });
		for (let name of others(40)) {
			await storage.machines.serve(box.id, {
				repositoryId: `R_${name}`,
				repository: `octo-org/${name}`,
				commit: "a".repeat(40),
			});
		}
		let github = counting(auth.github);
		let [row] = await listing("member");
		expect(row!.repositories).toHaveLength(40);
		expect(github.asked("rival-machine-1")).toBe(40);
		expect(github.running.most).toBeGreaterThan(1);
		expect(github.running.most).toBeLessThan(40);
		// Polled again, nothing is asked again of either.
		expect((await listing("member"))[0]!.repositories).toHaveLength(40);
		expect(github.asked("rival-machine-1")).toBe(40);
		expect(github.asked("member-browser-login")).toBe(0);
	});

	it("lists shared machines where Chopin runs no Planners on machines", async () => {
		let { machine, listing, choice } = await dispatchServer({ planners: false });
		let box = await machine("rival", "U_rival", "build-box", { bare: true, shared: true });
		expect((await listing("member")).map(value => value.id)).toEqual([box.id]);
		expect((await choice("member")).machines).toEqual([
			expect.objectContaining({ id: box.id, teammate: true, connected: true, runsPlanners: false }),
		]);
	});
});

describe("favoriting a teammate's shared machine", () => {
	/** rival's shared build-box and member's own desk, both with a Planner command and online. */
	async function favorites() {
		let dispatch = await dispatchServer();
		let box = await dispatch.machine("rival", "U_rival", "build-box", { bare: true, shared: true });
		let desk = await dispatch.machine("member", "U_member", "desk");
		let favor = async (login: string, machine: string, favorite = true) => {
			let response = await dispatch.send(`/api/connector/machines/${machine}/favorite`, {
				login,
				body: { favorite },
			});
			return { status: response.status, body: await response.json() };
		};
		let starred = async (login: string) =>
			(await dispatch.listing(login)).filter(value => value.favorite).map(value => value.id);
		return { ...dispatch, box, desk, favor, starred };
	}

	it("lets a person make an eligible shared machine their favorite, shown on its row for them alone", async () => {
		let { favor, starred, listing, choice, box } = await favorites();
		expect(await favor("member", box.id)).toEqual({ status: 200, body: { favorite: box.id } });
		expect(await starred("member")).toEqual([box.id]);
		expect((await listing("member")).find(value => value.id === box.id)).toMatchObject({
			teammate: true,
			favorite: true,
		});
		expect((await choice("member")).favorite).toBe(box.id);
		// Its owner's own favorite is their own; they have none, and member's doesn't change that.
		expect(await starred("rival")).toEqual([]);
		expect((await choice("rival")).favorite).toBeNull();
		expect(await favor("member", box.id, false)).toEqual({ status: 200, body: { favorite: null } });
		expect(await starred("member")).toEqual([]);
	});

	it("refuses a machine that is not shared, whose owner can't push, or that the person can't use", async () => {
		let { favor, machine, share, starred, box } = await favorites();
		let plain = await machine("rival", "U_rival", "plain", { bare: true });
		let readers = await machine("viewer", "U_viewer", "reader-box", { bare: true, shared: true });
		expect((await favor("member", plain.id)).status).toBe(404);
		expect((await favor("member", readers.id)).status).toBe(404);
		// viewer can only pull, so rival's machine serves them nothing they could push to.
		expect((await favor("viewer", box.id)).status).toBe(404);
		expect((await favor("member", "no-such-machine")).status).toBe(404);
		expect(await starred("member")).toEqual([]);
		// Shared, it is theirs to favor.
		expect(await share("rival", plain.id)).toBe(200);
		expect((await favor("member", plain.id)).status).toBe(200);
	});

	it("keeps one favorite per person, across their own machines and teammates'", async () => {
		let { favor, starred, box, desk } = await favorites();
		await favor("member", desk.id);
		expect(await starred("member")).toEqual([desk.id]);
		await favor("member", box.id);
		expect(await starred("member")).toEqual([box.id]);
		await favor("member", desk.id);
		expect(await starred("member")).toEqual([desk.id]);
	});

	it("keeps the owner's favorite apart from a teammate's, and clears only the teammate's when sharing stops", async () => {
		let { favor, share, starred, choice, listing, box } = await favorites();
		await favor("rival", box.id);
		await favor("member", box.id);
		expect(await share("rival", box.id, false)).toBe(200);
		expect(await starred("rival")).toEqual([box.id]);
		expect(await starred("member")).toEqual([]);
		// Shared again, it is no longer anyone's favorite but its owner's.
		expect(await share("rival", box.id)).toBe(200);
		expect((await choice("member")).favorite).toBeNull();
		expect((await listing("member")).find(value => value.id === box.id)).toMatchObject({
			favorite: false,
		});
		expect(await starred("rival")).toEqual([box.id]);
	});

	it("clears every favorite of a machine when its owner disconnects it", async () => {
		let { favor, send, share, starred, choice, box } = await favorites();
		await favor("member", box.id);
		let revoked = await send(`/api/connector/machines/${box.id}/revoke`, {
			login: "rival",
			body: {},
		});
		expect(revoked.status).toBe(200);
		expect((await choice("member")).favorite).toBeNull();
		expect(await starred("member")).toEqual([]);
		expect(await share("rival", box.id)).toBe(404);
		expect((await favor("member", box.id)).status).toBe(404);
	});

	it("clears only a favorite the person has, of a teammate's machine", async () => {
		let { favor, starred, box } = await favorites();
		// Clearing a favorite that is not the person's is a refusal, as for any machine that isn't theirs.
		expect((await favor("member", box.id, false)).status).toBe(404);
		await favor("member", box.id);
		expect((await favor("member", box.id, false)).status).toBe(200);
		expect(await starred("member")).toEqual([]);
	});

	it("is what Automatic uses for the document while it is connected, ahead of the person's own", async () => {
		let { favor, choice, box, desk } = await favorites();
		expect((await choice("member")).automatic)
			.toEqual({ id: desk.id, label: "desk", favorite: false });
		await favor("member", box.id);
		expect((await choice("member")).automatic)
			.toEqual({ id: box.id, label: "build-box", favorite: true });
		// Offline, it falls back as Automatic does without it, and the choice still says it is theirs.
		await box.disconnect();
		let fallen = await choice("member");
		expect(fallen.automatic).toEqual({ id: desk.id, label: "desk", favorite: false });
		expect(fallen.favorite).toBe(box.id);
	});

	it("keeps rename, share and disconnect with the owner for a machine a teammate favored", async () => {
		let { send, favor, box } = await favorites();
		await favor("member", box.id);
		for (
			let [action, body] of [
				["label", { label: "mine now" }],
				["shared", { shared: false }],
				["revoke", {}],
			] as const
		) {
			expect(
				(await send(`/api/connector/machines/${box.id}/${action}`, { login: "member", body }))
					.status,
			).toBe(404);
		}
	});
});

describe("a document on Default machine whose creator's favorite is a teammate's shared machine", () => {
	/** member's laptop, rival's shared build-box, and member's favorite: build-box. */
	async function preferring() {
		let dispatch = await dispatchServer();
		let { machine, favor } = dispatch;
		let laptop = await machine("member", "U_member", "laptop");
		let box = await machine("rival", "U_rival", "build-box", { bare: true, shared: true });
		await favor("member", box.id);
		return { ...dispatch, laptop, box };
	}

	it("runs its Planner there, as its owner, rather than on the creator's own machine", async () => {
		let { visit, choice, laptop, box, channel, runtime, url } = await preferring();
		await visit();
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		expect(await laptop.poll([])).toEqual({ waiting: true });
		expect((await choice("member")).planner)
			.toEqual({ state: "starting", login: "rival", machine: box.id });
		expect(await runtime.plannerStarting(channel.id)).toEqual({
			login: "rival",
			machineId: box.id,
		});
	});

	it("falls back to the creator's own machine while the favorite is offline", async () => {
		let { visit, laptop, box, channel, url } = await preferring();
		await visit();
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		expect((await box.disconnect()).status).toBe(200);
		expect(await laptop.poll([], 1_000)).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		// Back online, it does not take a Planner that works elsewhere back.
		await box.reconnect();
		expect(await box.poll([])).toEqual({ waiting: true });
		expect(await laptop.poll([channel.id])).toEqual({ waiting: true });
	});

	it("falls back to the creator's own machine when its owner stops sharing it", async () => {
		let { visit, share, laptop, box, channel, url } = await preferring();
		await visit();
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		expect(await share("rival", box.id, false)).toBe(200);
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		expect(await box.poll([channel.id])).toEqual({
			kind: "planners",
			planners: [],
			stopped: { [channel.id]: expect.stringContaining("stopped sharing build-box") },
		});
	});

	it("falls back to the creator's own machine where the owner can no longer push to the repository", async () => {
		let { auth, visit, laptop, box, channel, skew, url } = await preferring();
		await visit();
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		let access = auth.github.repositoryAccess;
		auth.github.repositoryAccess = async (token, owner, name) => {
			let found = await access(token, owner, name);
			return token.startsWith("rival") && found
				? { ...found, permissions: { pull: true, push: false, admin: false } }
				: found;
		};
		// Its owner's push check is asked again once its ten minutes are up.
		skew.ms = 11 * 60_000;
		await visit();
		expect(await laptop.poll([], 1_000)).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		expect(await box.poll([channel.id])).toEqual({ kind: "planners", planners: [] });
	});

	it("moves the Planner from the creator's own machine when they favor a teammate's, and back when they favor their own", async () => {
		let { visit, favor, laptop, box, channel, url } = await dispatchServer().then(
			async dispatch => {
				let laptop = await dispatch.machine("member", "U_member", "laptop");
				let box = await dispatch.machine("rival", "U_rival", "build-box", {
					bare: true,
					shared: true,
				});
				return { ...dispatch, laptop, box };
			},
		);
		await visit();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let link = await laptop.backend();
		await link.next("attached");

		await favor("member", box.id);
		expect(await link.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		let theirs = await box.backend();
		await theirs.next("attached");

		await favor("member", laptop.id);
		expect(await theirs.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(await laptop.poll([], 1_000)).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
	});
});

/** The machine with an id in a listing of machines. */
function teammate(list: Array<Record<string, unknown>>, id: string) {
	return list.find(value => value.id === id);
}

describe("a teammate's shared machine, in a document's machine menu", () => {
	async function menu() {
		let dispatch = await dispatchServer();
		let box = await dispatch.machine("rival", "U_rival", "build-box", {
			bare: true,
			shared: true,
			version: "0.1.5",
		});
		let desk = await dispatch.machine("member", "U_member", "desk", { plannerCommand: false });
		return { ...dispatch, box, desk };
	}

	it("lists it beside the person's own, under its owner, without what only its owner sees", async () => {
		let { choice, box, desk } = await menu();
		let { machines } = await choice("member");
		expect(machines.map((value: Record<string, unknown>) => value.id).sort())
			.toEqual([box.id, desk.id].sort());
		expect(teammate(machines, box.id)).toEqual({
			id: box.id,
			label: "build-box",
			teammate: true,
			owner: { login: "rival", avatarUrl: "" },
			connected: true,
			createdAt: expect.any(Number),
			lastSeenAt: expect.any(Number),
			version: "0.1.5",
			service: false,
			runsPlanners: true,
		});
		expect(teammate(machines, desk.id)).toMatchObject({ teammate: false, reauthorize: false });
	});

	it("serves any repository its owner can push to, with no checkout of it", async () => {
		let { choice, box } = await menu();
		// The machine connected with no checkouts at all, and still serves the document's repository.
		expect(teammate((await choice("member")).machines, box.id)).toMatchObject({ connected: true });
	});

	it("is listed offline, and nothing else changes", async () => {
		let { choice, box } = await menu();
		await box.disconnect();
		expect(teammate((await choice("member")).machines, box.id)).toMatchObject({
			connected: false,
			teammate: true,
			version: null,
		});
	});

	it("is never listed unless it is shared, and goes when its owner stops sharing it", async () => {
		let { choice, share, machine, box } = await menu();
		let plain = await machine("rival", "U_rival", "plain", { bare: true });
		expect(teammate((await choice("member")).machines, plain.id)).toBeUndefined();
		expect(await share("rival", box.id, false)).toBe(200);
		expect(teammate((await choice("member")).machines, box.id)).toBeUndefined();
		// The owner still lists it, as their own.
		expect(teammate((await choice("rival")).machines, box.id)).toMatchObject({ teammate: false });
	});

	it("is never listed when its owner can't push to the document's repository", async () => {
		let { choice, machine } = await menu();
		let readers = await machine("viewer", "U_viewer", "reader-box", { bare: true, shared: true });
		expect(teammate((await choice("member")).machines, readers.id)).toBeUndefined();
	});

	it("is never listed to someone who can only read the document", async () => {
		let { choice, box } = await menu();
		let read = await choice("viewer");
		expect(teammate(read.machines, box.id)).toBeUndefined();
		expect(read.machines).toEqual([]);
	});
});

describe("choosing a teammate's shared machine for a document", () => {
	/** guest's shared build-box, with no checkout, for a document member created and rival edits. */
	async function chosen() {
		let dispatch = await dispatchServer();
		let box = await dispatch.machine("guest", "U_guest", "build-box", { bare: true, shared: true });
		let path = `/api/documents/${dispatch.channel.id}/machine`;
		return { ...dispatch, box, path };
	}

	it("lets anyone who can edit the document choose it, and runs the Planner there, as its owner", async () => {
		let { choose, choice, box, channel, server, url } = await chosen();
		// rival neither created the document nor owns the machine.
		let picked = await choose("rival", box.id);
		expect(picked.choice).toBe(box.id);
		expect(picked.planner).toEqual({ state: "starting", login: "guest", machine: box.id });
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		let link = await box.backend();
		await link.next("attached");
		expect(server.attachments.holder(channel.id)).toBe("guest");
		expect((await choice("rival")).choice).toBe(box.id);
		expect((await choice("rival")).planner)
			.toEqual({ state: "held", login: "guest", machine: null });
	});

	it("lets the document's creator choose it, and runs the Planner there", async () => {
		let { choose, box, channel, url } = await chosen();
		let picked = await choose("member", box.id);
		expect(picked.planner).toEqual({ state: "starting", login: "guest", machine: box.id });
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
	});

	it("refuses someone who can only read the document", async () => {
		let { send, box, path, runtime } = await chosen();
		let refused = await send(path, { login: "viewer", body: { machine: box.id } });
		expect(refused.status).toBe(403);
		expect(runtime.connections.choosing(box.id)).toEqual([]);
	});

	it("refuses a machine that is not shared, or whose owner can't push, as one that is not there", async () => {
		let { send, machine, share, path, box } = await chosen();
		let plain = await machine("rival", "U_rival", "plain", { bare: true });
		let readers = await machine("viewer", "U_viewer", "reader-box", { bare: true, shared: true });
		for (let target of [plain.id, readers.id]) {
			let refused = await send(path, { login: "member", body: { machine: target } });
			expect(refused.status).toBe(404);
		}
		// Shared at first, then not: choosing it is refused like any machine that isn't theirs.
		expect(await share("rival", plain.id)).toBe(200);
		expect((await send(path, { login: "member", body: { machine: plain.id } })).status).toBe(200);
		expect(await share("rival", plain.id, false)).toBe(200);
		expect((await send(path, { login: "member", body: { machine: plain.id } })).status).toBe(404);
		expect(box.id).toBeString();
	});

	it("lets the creator's own choice still decide where the Planner runs", async () => {
		let { choose, choice, machine, box, channel, server, url } = await chosen();
		let laptop = await machine("member", "U_member", "laptop");
		// rival chose the teammate's machine first, and its Planner attached.
		await choose("rival", box.id);
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		let theirs = await box.backend();
		await theirs.next("attached");
		expect(server.attachments.holding(channel.id)?.machineId).toBe(box.id);

		// The creator chooses their own machine: the teammate's Planner stops, rival's choice goes.
		let picked = await choose("member", laptop.id);
		expect(picked.planner).toEqual({ state: "starting", login: null, machine: laptop.id });
		expect(await theirs.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(await box.poll([channel.id])).toEqual({
			kind: "planners",
			planners: [],
			stopped: { [channel.id]: expect.stringContaining("member chose another machine") },
		});
		expect((await choice("rival")).choice).toBeNull();
	});

	it("says why a Planner stopped to a machine that asks while its credentials are still being forgotten", async () => {
		let { choose, machine, box, channel, planners, url } = await chosen();
		let laptop = await machine("member", "U_member", "laptop");
		await choose("rival", box.id);
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });

		// Forgetting a credential waits on storage. The choice has taken effect by then, so the
		// machine's next question already has to be answered with the reason.
		let reached = Promise.withResolvers<void>();
		let proceed = Promise.withResolvers<void>();
		let withdraw = planners.withdraw.bind(planners);
		planners.withdraw = async (machineId, channelId) => {
			reached.resolve();
			await proceed.promise;
			return withdraw(machineId, channelId);
		};
		let picked = choose("member", laptop.id);
		await reached.promise;
		expect(await box.poll([channel.id], 500)).toEqual({
			kind: "planners",
			planners: [],
			stopped: { [channel.id]: expect.stringContaining("member chose another machine") },
		});
		proceed.resolve();
		await picked;
	});

	it("never asks it for an editor's choice while the creator chose another machine", async () => {
		let { choose, choice, machine, box, channel, url } = await chosen();
		let laptop = await machine("member", "U_member", "laptop");
		await choose("member", laptop.id);
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let theirs = await choose("rival", box.id);
		expect(theirs.choice).toBe(box.id);
		expect(theirs.planner).toEqual({ state: "none", login: null, machine: null });
		expect(await box.poll([])).toEqual({ waiting: true });
		expect((await choice("member")).planner)
			.toEqual({ state: "starting", login: null, machine: laptop.id });
	});

	it("offers it no more, and stops asking it, once its owner can no longer push", async () => {
		let { auth, choose, choice, box, skew, channel, runtime } = await chosen();
		await choose("rival", box.id);
		expect(await box.poll([])).toMatchObject({ kind: "planners" });
		expect(await runtime.plannerStarting(channel.id)).toEqual({
			login: "guest",
			machineId: box.id,
		});
		expect((await choice("rival")).machines.map((value: { id: string }) => value.id))
			.toEqual([box.id]);
		// GitHub now refuses its owner's token, which Chopin finds out when it next asks.
		let github = auth.github;
		let asked = github.repositoryAccess;
		github.repositoryAccess = async (token, owner, name) =>
			token.startsWith("guest-machine") ? undefined : asked(token, owner, name);
		skew.ms = 11 * 60_000;
		let after = await choice("rival");
		expect(after.machines).toEqual([]);
		expect(after.planner).toEqual({ state: "none", login: null, machine: null });
		expect(await runtime.plannerStarting(channel.id)).toBeUndefined();
		// Its connector, still running the Planner, is told to stop.
		expect(await box.poll([channel.id])).toMatchObject({ kind: "planners", planners: [] });
	});

	it("runs the chooser's investigation there, and refuses it once the machine is offline or no longer takes their work", async () => {
		let { auth, choose, send, box, channel, runtime, skew } = await chosen();
		await choose("member", box.id);
		let run = async () => {
			let id = crypto.randomUUID();
			let created = await send(`/api/documents/${channel.id}/experiments`, {
				login: "member",
				body: { id, brief: "Measure startup" },
			});
			expect(created.status).toBe(200);
			let started = await send(`/api/documents/${channel.id}/experiments/${id}/run`, {
				login: "member",
				body: {},
			});
			return { id, started };
		};
		// Online: the run is the chooser's, on the teammate's machine.
		let first = await run();
		expect(first.started.status).toBe(200);
		let stored = await runtime.service.store.get(first.id);
		expect(stored).toMatchObject({ connectionId: box.connectionId, requester: "U_member" });
		expect(stored?.input?.authorizer).toBe("U_member");
		// Offline: the machine's own words, never another machine.
		await box.disconnect();
		let offline = await run();
		expect(offline.started.status).toBe(409);
		expect(await offline.started.json()).toEqual({
			error: "machine-offline",
			message: offlineMessage("build-box"),
		});
		expect((await runtime.service.store.get(offline.id))?.connectionId).toBeUndefined();
		// Back online, but its owner can no longer push to the repository.
		await box.reconnect();
		let github = auth.github;
		let asked = github.repositoryAccess;
		github.repositoryAccess = async (token, owner, name) =>
			token.startsWith("guest-machine") ? undefined : asked(token, owner, name);
		skew.ms = 11 * 60_000;
		let unavailable = await run();
		expect(unavailable.started.status).toBe(409);
		expect(await unavailable.started.json()).toEqual({
			error: "machine-unavailable",
			message: unavailableMessage("build-box"),
		});
		expect((await runtime.service.store.get(unavailable.id))?.connectionId).toBeUndefined();
	});

	it("takes the choice back when its owner stops sharing the machine, and stops its Planner", async () => {
		let dispatch = await dispatchServer();
		let { machine, choose, choice, share, channel, url } = dispatch;
		let box = await machine("rival", "U_rival", "build-box", { bare: true, shared: true });
		await choose("member", box.id);
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });

		expect(await share("rival", box.id, false)).toBe(200);
		// The teammate's choice goes with the sharing, so their own work is never held for it.
		expect((await choice("member")).choice).toBeNull();
		expect(await box.poll([channel.id])).toEqual({
			kind: "planners",
			planners: [],
			stopped: { [channel.id]: expect.stringContaining("stopped sharing build-box") },
		});
	});

	it("keeps a teammate's Planner through its reply when sharing stops, then stops it", async () => {
		let dispatch = await dispatchServer();
		let { machine, choose, share, channel, server, url } = dispatch;
		let box = await machine("rival", "U_rival", "build-box", { bare: true, shared: true });
		await choose("member", box.id);
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
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
		let turn = session.doPromptTurn({
			prompt: "outline the plan",
			skills: [],
			tools: [],
			emit: () => {},
		});
		let { turn: id } = await link.next("turn");
		await turn;
		let stillRuns = async () => {
			await dispatch.runtime.sweep();
			return "waiting" in await box.poll([channel.id]);
		};
		expect(await share("rival", box.id, false)).toBe(200);
		expect(await stillRuns()).toBe(true);
		link.send({ type: "turn-end", session: "planner-session", turn: id, status: "finished" });
		await Bun.sleep(50);
		expect(await stillRuns()).toBe(false);
		expect(await link.next("refused")).toMatchObject({ code: "access-revoked" });
	});

	/**
	 * member created the document and runs Default machine's Planners on their desk; nobody has it
	 * open. rival's shared build-box is the machine member chooses for it.
	 */
	async function chosenByCreator(connector: { plannerCommand?: boolean } = {}) {
		let dispatch = await dispatchServer();
		let box = await dispatch.machine("rival", "U_rival", "build-box", {
			bare: true,
			shared: true,
			...connector,
		});
		let desk = await dispatch.machine("member", "U_member", "desk");
		return { ...dispatch, box, desk };
	}

	it("starts nothing on Default machine for a document whose Planner it never ran, when sharing stops", async () => {
		let { choose, choice, share, box, desk } = await chosenByCreator({ plannerCommand: false });
		// A choice for the person's builds only: the machine runs no Planners, and nobody opened it.
		await choose("member", box.id);
		expect(await desk.poll([], 200)).toEqual({ waiting: true });

		expect(await share("rival", box.id, false)).toBe(200);
		expect((await choice("member")).choice).toBeNull();
		expect(await desk.poll([], 200)).toEqual({ waiting: true });
		expect((await choice("member")).planner).toEqual({ state: "none", login: null, machine: null });
	});

	it("hands the document to Default machine when sharing stops, if the machine ran its Planner or was about to", async () => {
		let { choose, share, box, desk, channel, url } = await chosenByCreator();
		await choose("member", box.id);
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		expect(await desk.poll([], 200)).toEqual({ waiting: true });

		expect(await share("rival", box.id, false)).toBe(200);
		expect(await desk.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		expect(await box.poll([channel.id])).toEqual({
			kind: "planners",
			planners: [],
			stopped: { [channel.id]: expect.stringContaining("stopped sharing build-box") },
		});

		// Chosen and able to run it, but its connector had not asked yet: the same.
		let other = await chosenByCreator();
		await other.choose("member", other.box.id);
		expect(await other.share("rival", other.box.id, false)).toBe(200);
		expect(await other.desk.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: other.channel.id, url }],
		});
	});

	it("hands a document someone has open to Default machine when sharing stops, whatever the machine ran", async () => {
		let { choose, share, visit, box, desk, channel, url } = await chosenByCreator({
			plannerCommand: false,
		});
		await visit();
		// The creator's own choice keeps the document off Default machine while it stands.
		await choose("member", box.id);
		expect(await desk.poll([], 200)).toEqual({ waiting: true });

		// The desk's connector is already waiting for work when sharing stops, and is told at once.
		let waiting = desk.poll([], 5_000);
		await Bun.sleep(50);
		expect(await share("rival", box.id, false)).toBe(200);
		expect(await waiting).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
	});
});

describe("an editor's choice of a teammate's shared machine, on a document on Default machine", () => {
	/**
	 * member created the document and their laptop runs its Planner on Default machine; guest's shared
	 * build-box is the machine rival, who can edit it, chooses.
	 */
	async function contested(connector: { plannerCommand?: boolean } = {}) {
		let dispatch = await dispatchServer();
		let box = await dispatch.machine("guest", "U_guest", "build-box", {
			bare: true,
			shared: true,
			...connector,
		});
		let laptop = await dispatch.machine("member", "U_member", "laptop");
		await dispatch.visit();
		return { ...dispatch, box, laptop };
	}
	/** Wait until nobody holds the document's Planner, as after its backend detached. */
	async function released(
		server: { attachments: { holder(id: string): string | undefined } },
		id: string,
	) {
		for (let deadline = Date.now() + 4_000; server.attachments.holder(id);) {
			expect(Date.now()).toBeLessThan(deadline);
			await Bun.sleep(50);
		}
	}

	it("takes the Planner from an attached Default machine, which stops, and asks only the chosen machine", async () => {
		let { choose, choice, visit, box, laptop, channel, server, url } = await contested();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let mine = await laptop.backend();
		await mine.next("attached");
		expect(server.attachments.holding(channel.id)?.machineId).toBe(laptop.id);

		let picked = await choose("rival", box.id);
		expect(picked.planner).toEqual({ state: "starting", login: "guest", machine: box.id });
		expect(await mine.next("refused")).toMatchObject({ code: "access-revoked" });
		expect(await laptop.poll([channel.id])).toEqual({
			kind: "planners",
			planners: [],
			stopped: { [channel.id]: expect.stringContaining("rival chose another machine") },
		});
		// Only the chosen machine is asked, and the document staying in use does not ask the other.
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		await visit();
		expect(await laptop.poll([], 200)).toEqual({ waiting: true });
		expect((await choice("member")).planner)
			.toEqual({ state: "starting", login: "guest", machine: box.id });
		let theirs = await box.backend();
		await theirs.next("attached");
		expect(server.attachments.holder(channel.id)).toBe("guest");
		expect((await choice("rival")).choice).toBe(box.id);
	});

	it("takes it from a Default machine that was asked but has not attached, and withdraws its credential", async () => {
		let { choose, box, laptop, channel, server, url } = await contested();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let credential = await laptop.credential();

		await choose("rival", box.id);
		expect(await laptop.poll([channel.id])).toMatchObject({ kind: "planners", planners: [] });
		expect(await upgrade(server.url, credential)).toBe(401);
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
	});

	it("asks only the chosen machine for a Default machine that would have attached", async () => {
		let { choose, box, laptop, channel, url } = await contested();
		// The laptop's connector has not polled yet; the choice comes first.
		await choose("rival", box.id);
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		expect(await laptop.poll([], 200)).toEqual({ waiting: true });
	});

	it("goes back to Default machine when the choice is cleared", async () => {
		let { choose, choice, box, laptop, channel, url } = await contested();
		await choose("rival", box.id);
		expect(await laptop.poll([], 200)).toEqual({ waiting: true });
		let cleared = await choose("rival", null);
		expect(cleared.choice).toBeNull();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		expect((await choice("member")).planner)
			.toEqual({ state: "starting", login: null, machine: laptop.id });
	});

	it("never takes it from a machine the creator chose", async () => {
		let { choose, choice, box, laptop, channel, server } = await contested();
		await choose("member", laptop.id);
		let mine = await laptop.backend();
		await mine.next("attached");
		expect((await choose("rival", box.id)).planner)
			.toEqual({ state: "held", login: "member", machine: null });
		expect(await box.poll([], 200)).toEqual({ waiting: true });
		expect(server.attachments.holder(channel.id)).toBe("member");
		expect((await choice("member")).planner)
			.toEqual({ state: "attached", login: "member", machine: laptop.id });
	});

	it("keeps an attached Default machine Planner when the chosen machine runs no Planners", async () => {
		let { choose, choice, box, laptop, channel, server, url } = await contested({
			plannerCommand: false,
		});
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let mine = await laptop.backend();
		await mine.next("attached");

		// A builds-only machine cannot run the Planner, so choosing it stops nothing.
		let picked = await choose("rival", box.id);
		expect(picked.choice).toBe(box.id);
		expect(picked.planner).toEqual({ state: "held", login: "member", machine: null });
		expect(server.attachments.holding(channel.id)).toMatchObject({
			machineId: laptop.id,
			attached: true,
		});
		expect(await laptop.poll([channel.id], 200)).toEqual({ waiting: true });
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		expect(await box.poll([], 200)).toEqual({ waiting: true });
		expect((await choice("member")).planner)
			.toEqual({ state: "attached", login: "member", machine: laptop.id });
		// The editor's choice stands for their own builds and runs.
		expect((await choice("rival")).choice).toBe(box.id);
	});

	it("never interrupts a Default machine Planner mid-reply for a choice that cannot take over", async () => {
		let { choose, box, laptop, channel, server, url } = await contested({ plannerCommand: false });
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
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
		let turn = session.doPromptTurn({
			prompt: "outline the plan",
			skills: [],
			tools: [],
			emit: () => {},
		});
		let { turn: id } = await link.next("turn");
		await turn;
		expect(server.attachments.busy(channel.id)).toBe(true);

		await choose("rival", box.id);
		expect(server.attachments.busy(channel.id)).toBe(true);
		expect(server.attachments.holding(channel.id)).toMatchObject({
			machineId: laptop.id,
			attached: true,
		});
		expect(await laptop.poll([channel.id], 200)).toEqual({ waiting: true });
		// The reply ends as it would have, and the Planner is still its.
		link.send({ type: "turn-end", session: "planner-session", turn: id, status: "finished" });
		await Bun.sleep(50);
		expect(server.attachments.busy(channel.id)).toBe(false);
		expect(server.attachments.attached(channel.id)).toBe(true);
	});

	it("keeps an attached Default machine Planner when the chosen machine is offline, and the machine takes it once it is back and the Planner is no longer attached", async () => {
		let { choose, choice, box, laptop, channel, server, url } = await contested();
		await box.disconnect();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let mine = await laptop.backend();
		await mine.next("attached");

		let picked = await choose("rival", box.id);
		expect(picked.choice).toBe(box.id);
		expect(picked.planner).toEqual({ state: "held", login: "member", machine: null });
		expect(server.attachments.holding(channel.id)).toMatchObject({
			machineId: laptop.id,
			attached: true,
		});
		expect(await laptop.poll([channel.id], 200)).toEqual({ waiting: true });

		// It comes back and can run the Planner, but never interrupts the one attached.
		await box.reconnect();
		expect(await box.poll([], 200)).toEqual({ waiting: true });
		expect(await laptop.poll([channel.id], 200)).toEqual({ waiting: true });
		expect(server.attachments.attached(channel.id)).toBe(true);

		// Once that Planner ends, the machine the editor chose runs it and Default machine is not asked.
		mine.send({ type: "detach" });
		await released(server, channel.id);
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		expect(await laptop.poll([], 200)).toEqual({ waiting: true });
		expect((await choice("member")).planner)
			.toEqual({ state: "starting", login: "guest", machine: box.id });
	});

	it("keeps a Default machine Planner that was only asked when the chosen machine is offline", async () => {
		let { choose, choice, box, laptop, channel, server, url } = await contested();
		await box.disconnect();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		let credential = await laptop.credential();
		expect((await choose("rival", box.id)).choice).toBe(box.id);
		expect(await laptop.poll([channel.id], 200)).toEqual({ waiting: true });
		expect((await choice("member")).planner)
			.toEqual({ state: "starting", login: null, machine: laptop.id });
		// Its backend can still attach with the credential it was given.
		expect(await upgrade(server.url, credential)).toBe(101);
	});

	it("asks only the chosen machine after a restart, and Default machine again once it can't run the Planner", async () => {
		let dispatch = await contested();
		let { choose, choice, box, laptop, channel, url } = dispatch;
		await choose("rival", box.id);
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });

		// The deploy forgets what Default machine gave the document, but the editor's choice is stored.
		await dispatch.restart();
		await laptop.reconnect();
		await box.reconnect();
		await dispatch.visit();
		expect(await laptop.poll([], 200)).toEqual({ waiting: true });
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		expect((await choice("rival")).choice).toBe(box.id);
		expect((await choice("member")).planner)
			.toEqual({ state: "starting", login: "guest", machine: box.id });

		// The chosen machine goes away: the document is not left without a Planner.
		await box.disconnect();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		expect((await choice("member")).planner)
			.toEqual({ state: "starting", login: null, machine: laptop.id });
		// And back to the chosen machine when it returns.
		await box.reconnect();
		await dispatch.visit();
		expect(await laptop.poll([channel.id])).toEqual({ kind: "planners", planners: [] });
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
	});

	it("never asks both machines after a restart, whichever one connects first", async () => {
		let dispatch = await contested();
		let { choose, box, laptop, channel, url } = dispatch;
		await choose("rival", box.id);
		await dispatch.restart();
		// Default machine's machine is back first and is asked, as nothing yet says otherwise.
		await laptop.reconnect();
		await dispatch.visit();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		// Then the chosen machine, which can run it: Default machine's is no longer asked.
		await box.reconnect();
		expect(await box.poll([])).toEqual({ kind: "planners", planners: [{ id: channel.id, url }] });
		expect(await laptop.poll([channel.id])).toEqual({ kind: "planners", planners: [] });
		expect(await laptop.poll([], 200)).toEqual({ waiting: true });
	});

	it("keeps the creator's own choice ahead of the editor's after a restart", async () => {
		let dispatch = await contested();
		let { choose, choice, box, laptop, channel, url } = dispatch;
		await choose("member", laptop.id);
		await choose("rival", box.id);
		await dispatch.restart();
		await laptop.reconnect();
		await box.reconnect();
		await dispatch.visit();
		expect(await box.poll([], 200)).toEqual({ waiting: true });
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
		expect((await choice("rival")).choice).toBe(box.id);
	});

	it("lets the creator take it back with Default machine from a choice no machine was asked for yet", async () => {
		let { choose, choice, box, laptop, channel, url } = await contested();
		// The chosen machine can run it, but its connector has not polled yet.
		await choose("rival", box.id);
		let back = await choose("member", null);
		expect(back.planner).toEqual({ state: "starting", login: null, machine: laptop.id });
		expect((await choice("rival")).choice).toBeNull();
		expect(await box.poll([], 200)).toEqual({ waiting: true });
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
	});

	it("lets the creator's own machine, or Default machine, take it back from the editor's choice", async () => {
		let { choose, choice, box, laptop, channel, server, url } = await contested();
		let take = async () => {
			await choose("rival", box.id);
			expect(await box.poll([])).toMatchObject({ kind: "planners" });
			let theirs = await box.backend();
			await theirs.next("attached");
			return theirs;
		};
		let theirs = await take();
		// The creator's own machine.
		let own = await choose("member", laptop.id);
		expect(own.planner).toEqual({ state: "starting", login: null, machine: laptop.id });
		expect(await theirs.next("refused")).toMatchObject({ code: "access-revoked" });
		expect((await choice("rival")).choice).toBeNull();
		let mine = await laptop.backend();
		await mine.next("attached");
		expect(server.attachments.holder(channel.id)).toBe("member");

		// And again, with Default machine, once the editor chooses it anew.
		mine.send({ type: "detach" });
		for (let deadline = Date.now() + 4_000; server.attachments.holder(channel.id);) {
			expect(Date.now()).toBeLessThan(deadline);
			await Bun.sleep(50);
		}
		await choose("member", null);
		theirs = await take();
		let back = await choose("member", null);
		expect(back.planner).toEqual({ state: "starting", login: null, machine: laptop.id });
		expect(await theirs.next("refused")).toMatchObject({ code: "access-revoked" });
		expect((await choice("rival")).choice).toBeNull();
		expect(await laptop.poll([])).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
		});
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

describe("a person asking for a Planner that is not there", () => {
	it("asks the machines again even though the document was already in use, which opening it again does not", async () => {
		let { machine, choose, runtime, channel, visit } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		await choose("member", laptop.id);
		expect((await laptop.poll([])).kind).toBe("planners");
		await visit();
		// How long a poll that has nothing new to hear waits, once `act` has happened to it.
		let waited = async (act: () => Promise<unknown>) => {
			let began = Date.now();
			let polling = laptop.poll([channel.id], 1_500);
			await Bun.sleep(150);
			await act();
			await polling;
			return Date.now() - began;
		};
		expect(await waited(() => runtime.plannerUsed(channel.id))).toBeGreaterThan(1_200);
		expect(await waited(() => runtime.plannerUsed(channel.id, true))).toBeLessThan(900);
	});

	it("tells the machine that will start it, once, in its next Planner poll, and tells a machine nobody asked nothing", async () => {
		let { machine, choose, runtime, channel, visit, url } = await dispatchServer();
		let laptop = await machine("member", "U_member", "laptop");
		let desk = await machine("member", "U_member", "desk");
		await choose("member", laptop.id);
		expect((await laptop.poll([])).kind).toBe("planners");
		await visit();
		// Opening it again is not asking: the poll hears nothing.
		let polling = laptop.poll([channel.id], 600);
		await Bun.sleep(100);
		await runtime.plannerUsed(channel.id);
		expect(await polling).toEqual({ waiting: true });
		// Asking for it lists it, with the same list it already runs, in the poll that is waiting.
		polling = laptop.poll([channel.id], 3_000);
		await Bun.sleep(100);
		await runtime.plannerUsed(channel.id, true);
		expect(await polling).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
			retry: [channel.id],
		});
		// Said once: the next poll hears nothing more of it.
		expect(await laptop.poll([channel.id], 400)).toEqual({ waiting: true });
		// Asked while no poll waits: the first poll after hears it at once.
		await runtime.plannerUsed(channel.id, true);
		expect(await laptop.poll([channel.id], 3_000)).toEqual({
			kind: "planners",
			planners: [{ id: channel.id, url }],
			retry: [channel.id],
		});
		// A machine that was not the one asked is told nothing.
		await runtime.plannerUsed(channel.id, true);
		expect(await desk.poll([], 400)).not.toHaveProperty("retry");
	});
});
