import { afterEach, describe, expect, it } from "bun:test";
import { AGENT_VERSION, LINK_CLOSE } from "@chopin/agent-link";
import {
	CONNECTOR_PLANNER_COMMAND_HEADER,
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_VERSION_HEADER,
} from "@chopin/protocol/connector";

import { Machines } from "../../auth/machines";
import { registerExperimentRoutes } from "../../experiments/routes";
import { Router } from "../../http/router";
import {
	linkAuth,
	linkServer,
	machineToken,
	rawLink,
	upgradeRequest,
} from "../../testing/agent-link";
import { MachinePlanners } from "./machine-planners";

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
	let runtime = registerExperimentRoutes(router, { ...auth, machines, pairings: {} } as never, {
		lease: () => lease,
		changed: () => {},
		context: async () => ({ source: "# Context", revision: 0 }),
		planners,
		attachments: () => server.attachments,
		// No builds wait anywhere; only the Planner poll is exercised.
		implementations: () =>
			({
				waiting: async () => undefined,
				busy: async () => false,
				disconnected: async () => {},
				sweep: async () => {},
				call: async () => ({}),
			}) as never,
	});
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
		connector: { protocol?: number; plannerCommand?: boolean } = {},
	) {
		let { machine, token } = await machines.pair({
			userId,
			label,
			repositories: [],
			autoRun: false,
			grant: {
				accessToken: machineToken(login),
				accessExpiresIn: 28_800,
				refreshToken: `${login}-${label}-refresh`,
				refreshExpiresIn: 15_897_600,
			},
		});
		let protocol = connector.protocol ?? 4;
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
		let connection = (await opened.json()).token as string;
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
		return { id: machine.id, token, poll, credential, backend, disconnect };
	}
	let path = `/api/documents/${channel.id}/machine`;
	let choose = async (login: string, machine: string | null) => {
		let response = await send(path, { login, body: { machine } });
		expect(response.status).toBe(200);
		return response.json();
	};
	let choice = async (login: string) => (await send(path, { login })).json();
	let url = expect.stringContaining(`https://chopin.test/`);
	return { ...linked, machines, planners, server, send, machine, choose, choice, url };
}

/** The status an agent connection's upgrade gets with `credential`: 101 when it opens. */
async function upgrade(url: string, credential: string) {
	let response = await upgradeRequest(url, { authorization: `Bearer ${credential}` });
	return response.status;
}

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
		expect(await laptop.poll([channel.id])).toEqual({ kind: "planners", planners: [] });
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
		expect(await desk.poll([channel.id])).toEqual({ kind: "planners", planners: [] });
		expect(server.attachments.attached(channel.id)).toBe(false);
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
		expect(await laptop.poll([channel.id])).toEqual({ kind: "planners", planners: [] });
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
