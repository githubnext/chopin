import { afterEach, describe, expect, it } from "bun:test";
import { AGENT_VERSION, LINK_CLOSE } from "@chopin/agent-link";
import { CONNECTOR_PROTOCOL_HEADER, CONNECTOR_VERSION_HEADER } from "@chopin/protocol/connector";

import { ActiveOwnerBindings } from "../../agent/active-owner";
import { Machines } from "../../auth/machines";
import { Sessions } from "../../auth/session";
import { CONNECTOR_PROTOCOLS, registerExperimentRoutes } from "../../experiments/routes";
import { Router } from "../../http/router";
import {
	attach,
	GUEST_TOKEN,
	linkAuth,
	linkServer,
	machineToken,
	MEMBER_TOKEN,
	rawLink,
	scriptedPlanner,
	upgradeRequest,
} from "../../testing/agent-link";
import { hostInputRoom } from "../../testing/decisions";
import { createHumanInput } from "../atomic/human-input";
import { untilUnpaused } from "../atomic/full";
import { createRemoteAdapter } from "./adapter";
import { agentLink } from "./endpoint";
import { MachinePlanners } from "./machine-planners";
import { PlannerAttachments } from "./attachments";

import type { RemotePlanner } from "./registry";

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * A server running HARNESS=remote whose accounts can pair machines: the connector routes, the
 * agent connection, and the machines' own GitHub tokens, which GitHub knows as their account's. With
 * `local`, as under AUTH_MODE=local, there is no machine key, so machines keep no GitHub tokens.
 */
async function machineServer(options: { revalidateEveryMs?: number; local?: boolean } = {}) {
	let linked = await linkAuth();
	let { auth, storage, sessions } = linked;
	let machines = new Machines(storage, () => new Date(), {
		...(options.local ? {} : { key: new Uint8Array(32).fill(7) }),
		origin: auth.config.origin,
		clientId: "client",
		authorize: async (userId, token) => (await auth.admission.user(token)).id === userId,
	});
	let time = { offsetMs: 0 };
	let planners = new MachinePlanners({
		machines,
		sessions,
		storage,
		github: auth.github,
		config: auth.config,
		clock: () => new Date(Date.now() + time.offsetMs),
	});
	let server = linkServer(auth, 2_000, options.revalidateEveryMs, 2_000, undefined, planners);
	cleanups.push(server.stop);
	linked.revocations.add(id => server.attachments.sessionRevoked(id));
	let router = new Router();
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	registerExperimentRoutes(router, { ...auth, machines, pairings: {} } as never, {
		lease: () => lease,
		changed: () => {},
		context: async () => ({ source: "# Context", revision: 0 }),
		planners,
	});
	async function pair(login: string, userId: string) {
		let { machine, token } = await machines.pair({
			userId,
			label: `${login}-laptop`,
			repositories: [],
			autoRun: false,
			grant: {
				accessToken: machineToken(login),
				accessExpiresIn: 28_800,
				refreshToken: `${login}-refresh`,
				refreshExpiresIn: 15_897_600,
			},
		});
		return { machine, token };
	}
	/** `chopin connect --planner`: the machine asks for a Planner credential for one document. */
	async function credential(token: string, document: string) {
		let response = await router.handle(
			new Request(`${auth.config.origin}/api/connector/planner`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
					[CONNECTOR_VERSION_HEADER]: "dev",
					[CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOLS.max),
				},
				body: JSON.stringify({ document }),
			}),
			new URL(`${auth.config.origin}/api/connector/planner`),
		);
		return { status: response!.status, body: await response!.json() as Record<string, any> };
	}
	async function owner(channelId: string) {
		return (await storage.channels.readAgent(channelId, new Date()))?.agent;
	}
	return { ...linked, machines, planners, server, pair, credential, owner, time };
}

describe("a paired machine's Planner", () => {
	it("gets a short-lived credential only for a document whose repository its owner can write", async () => {
		let { pair, credential, channel, machines } = await machineServer();
		let member = await pair("member", "U_member");
		let issued = await credential(member.token, channel.id);
		expect(issued.status).toBe(200);
		expect(issued.body.token).toMatch(/^chopin_p_[A-Za-z0-9_-]{43}$/);
		expect(issued.body.document).toEqual({
			id: channel.id,
			url: expect.stringContaining("https://chopin.test/"),
			// Which of the machine's checkouts its Planner runs in.
			repository: "octo-org/score",
		});
		let lifetime = issued.body.expiresAt - Date.now();
		expect(lifetime).toBeGreaterThan(14 * 60_000);
		expect(lifetime).toBeLessThanOrEqual(15 * 60_000);

		let viewer = await pair("viewer", "U_viewer");
		expect(await credential(viewer.token, channel.id))
			.toMatchObject({ status: 403, body: { error: "repository-forbidden" } });
		expect(await credential(member.token, crypto.randomUUID()))
			.toMatchObject({ status: 404, body: { error: "not-found" } });
		expect(await credential("chopin_m_" + "x".repeat(43), channel.id))
			.toMatchObject({ status: 401, body: { error: "machine-revoked" } });
		await machines.revoke(member.machine.id, "U_member");
		expect(await credential(member.token, channel.id))
			.toMatchObject({ status: 401, body: { error: "machine-revoked" } });
	});

	it("is refused when the server does not run the remote Planner", async () => {
		let { auth, storage, channel } = await linkAuth();
		let machines = new Machines(storage, () => new Date(), {
			key: new Uint8Array(32).fill(7),
			origin: auth.config.origin,
			clientId: "client",
		});
		let router = new Router();
		let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
		registerExperimentRoutes(router, { ...auth, machines, pairings: {} } as never, {
			lease: () => lease,
			changed: () => {},
			context: async () => ({ source: "", revision: 0 }),
		});
		let { token } = await machines.pair({
			userId: "U_member",
			label: "laptop",
			repositories: [],
			autoRun: false,
			grant: {
				accessToken: machineToken("member"),
				accessExpiresIn: 28_800,
				refreshToken: "refresh",
				refreshExpiresIn: 15_897_600,
			},
		});
		let response = await router.handle(
			new Request(`${auth.config.origin}/api/connector/planner`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
					[CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOLS.max),
				},
				body: JSON.stringify({ document: channel.id }),
			}),
			new URL(`${auth.config.origin}/api/connector/planner`),
		);
		expect(response!.status).toBe(404);
	});

	it("is refused under AUTH_MODE=local, where machines hold no GitHub authorization", async () => {
		let { pair, credential, channel } = await machineServer({ local: true });
		let member = await pair("member", "U_member");
		expect(await credential(member.token, channel.id))
			.toMatchObject({ status: 404, body: { error: "not-found" } });
	});

	it("attaches with no browser sign-in, and its repository tools use the machine's token", async () => {
		let { pair, credential, channel, server, owner, auth, logins, storage } = await machineServer();
		// The guest can push but has never signed in to Chopin in a browser.
		let guest = await pair("guest", "U_guest");
		let { body } = await credential(guest.token, channel.id);
		let client = await attach(server.url, channel.id, scriptedPlanner().handlers, body.token);
		cleanups.push(() => client.detach());
		expect(client.document).toMatchObject({ id: channel.id, repository: "octo-org/score" });
		expect(server.attachments.attached(channel.id)).toBe(true);
		expect(server.attachments.holder(channel.id)).toBe("guest");
		let held = await owner(channel.id);
		expect(held?.ownerSessionId).toBeDefined();
		expect([...logins.values()]).not.toContain(held!.ownerSessionId);
		let binding = await new ActiveOwnerBindings(auth as never).resolve(channel.id);
		expect(binding?.token).toBe(machineToken("guest"));
		binding?.release();
		// The machine's login is not a browser sign-in: the guest's own bearer still needs one.
		let other = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Other document",
			createdBy: "U_member",
			now: new Date(),
		});
		let raw = await rawLink(server.url, GUEST_TOKEN);
		raw.send({ type: "attach", version: AGENT_VERSION, document: other.id });
		expect(await raw.next("refused")).toMatchObject({ code: "sign-in-required" });
	});

	it("stays attached when its owner signs out of the browser", async () => {
		let { pair, credential, channel, server, signOut, logins } = await machineServer({
			revalidateEveryMs: 20,
		});
		let member = await pair("member", "U_member");
		let { body } = await credential(member.token, channel.id);
		let raw = await rawLink(server.url, body.token);
		raw.send({ type: "attach", version: AGENT_VERSION, document: channel.id });
		await raw.next("attached");
		expect(await signOut("member")).toBe(logins.get("member"));
		await Bun.sleep(200);
		expect(raw.messages.filter(message => message.type === "refused")).toEqual([]);
		expect(server.attachments.attached(channel.id)).toBe(true);
		raw.socket.close();
	});

	it("is closed with access-revoked as soon as the machine is disconnected", async () => {
		let { pair, credential, channel, server, machines, owner } = await machineServer();
		let member = await pair("member", "U_member");
		let { body } = await credential(member.token, channel.id);
		let raw = await rawLink(server.url, body.token);
		raw.send({ type: "attach", version: AGENT_VERSION, document: channel.id });
		await raw.next("attached");
		await machines.revoke(member.machine.id, "U_member");
		expect(await raw.next("refused")).toEqual({
			type: "refused",
			code: "access-revoked",
			message: "The paired machine member-laptop that connected member to this document was "
				+ "disconnected from Chopin or must be paired again, so the connection was released. "
				+ "Run `chopin pair` on it, then connect again.",
		});
		expect((await raw.closed).code).toBe(LINK_CLOSE.forbidden);
		expect(server.attachments.attached(channel.id)).toBe(false);
		expect((await owner(channel.id))?.ownerSessionId).toBeUndefined();
		// The credential it still holds no longer opens a link.
		let upgrade = await upgradeRequest(server.url, { authorization: `Bearer ${body.token}` });
		expect(upgrade.status).toBe(401);
	});

	it("attaches only the document its credential names, while a bearer client attaches another", async () => {
		let { pair, credential, channel, server, storage } = await machineServer();
		let other = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Other document",
			createdBy: "U_member",
			now: new Date(),
		});
		let member = await pair("member", "U_member");
		let { body } = await credential(member.token, channel.id);
		let raw = await rawLink(server.url, body.token);
		raw.send({ type: "attach", version: AGENT_VERSION, document: other.id });
		expect(await raw.next("refused")).toMatchObject({ code: "repository-forbidden" });
		expect((await raw.closed).code).toBe(LINK_CLOSE.forbidden);
		expect(server.attachments.attached(other.id)).toBe(false);

		let bearer = await attach(server.url, other.id, scriptedPlanner().handlers, MEMBER_TOKEN);
		cleanups.push(() => bearer.detach());
		expect(server.attachments.attached(other.id)).toBe(true);
	});

	it("opens links with a credential until it expires, then refuses it before upgrading", async () => {
		let { pair, credential, channel, server, time, planners } = await machineServer();
		let member = await pair("member", "U_member");
		let { body } = await credential(member.token, channel.id);
		let upgrade = (token: string) =>
			upgradeRequest(server.url, { authorization: `Bearer ${token}` });
		expect((await upgrade("chopin_p_" + "x".repeat(43))).status).toBe(401);
		// A backend whose socket dropped reattaches with the same credential.
		expect(await planners.redeem(body.token)).toMatchObject({ channelId: channel.id });
		expect(await planners.redeem(body.token)).toMatchObject({ channelId: channel.id });
		time.offsetMs = 15 * 60_000 + 1;
		expect((await upgrade(body.token)).status).toBe(401);
		expect(await planners.redeem(body.token)).toBeUndefined();
	});

	it("accepts a credential in a process that starts after it was issued, with no wait for a renewal", async () => {
		let { pair, credential, channel, machines, sessions, storage, auth } = await machineServer();
		let member = await pair("member", "U_member");
		let { body } = await credential(member.token, channel.id);
		let restarted = new MachinePlanners({
			machines,
			sessions,
			storage,
			github: auth.github,
			config: auth.config,
		});
		let next = linkServer(auth, 2_000, undefined, 2_000, undefined, restarted);
		cleanups.push(next.stop);
		// The new process holds nothing in memory: the credential is known only by its digest in storage.
		expect(await restarted.redeem(body.token)).toMatchObject({
			channelId: channel.id,
			machine: { id: member.machine.id },
		});
		let client = await attach(next.url, channel.id, scriptedPlanner().handlers, body.token);
		cleanups.push(() => client.detach());
		expect(next.attachments.attached(channel.id)).toBe(true);
		expect(next.attachments.holder(channel.id)).toBe("member");
	});

	it("is shown as attached through its window by the process that takes over a cut, and its backend takes it back with its credential and no browser", async () => {
		let { pair, credential, channel, machines, storage, auth, sessions: browserSessions } =
			await machineServer();
		let member = await pair("guest", "U_guest");
		let { body } = await credential(member.token, channel.id);
		let planners = (sessions: Sessions) =>
			new MachinePlanners({
				machines,
				sessions,
				storage,
				github: auth.github,
				config: auth.config,
			});
		let leaseA = (await storage.leases.acquire("chopin:writer", "first", 60_000))!;
		let first = linkServer(auth, 2_000, undefined, 2_000, undefined, planners(browserSessions), {
			options: {
				store: {
					put: hold => storage.plannerHolds.put(leaseA, hold),
					delete: async id => void await storage.plannerHolds.delete(leaseA, id),
				},
			},
		});
		cleanups.push(first.stop);
		let raw = await rawLink(first.url, body.token, "resumable-sessions, restart-notice");
		raw.send({ type: "attach", version: AGENT_VERSION, document: channel.id });
		await raw.next("attached");
		let planner: RemotePlanner = { channelId: channel.id, isolated: false };
		let sessionId = crypto.randomUUID();
		let opening = createRemoteAdapter(() => ({ link: first.links.at(-1)!, planner })).doStart({
			sessionId,
			sandboxSession: {
				defaultWorkingDirectory: "/tmp",
				async run() {
					return { exitCode: 0, stdout: "", stderr: "" };
				},
				async destroy() {},
			} as never,
			sessionWorkDir: "/tmp",
		});
		raw.send({ type: "started", session: (await raw.next("start")).session });
		cleanups.push(() => void opening.then(session => session.doDestroy()));
		await opening;
		raw.send({
			type: "runs",
			session: sessionId,
			active: ["run"],
			paused: [],
			cards: [{
				id: "run",
				name: "plan",
				status: "running",
				started: 1,
				updated: 1,
				stages: [],
				waiting: 0,
			}],
		});
		for (let deadline = Date.now() + 2_000; !planner.runs && Date.now() < deadline;) {
			await Bun.sleep(5);
		}
		let oldLogin =
			(await storage.channels.readAgent(channel.id, new Date()))!.agent!.ownerSessionId;

		// The cut: state kept, lease released, the links closed with 1012.
		first.attachments.shutdown();
		await first.attachments.persist(first.attachments.freeze(10_000));
		for (let link of first.links) link.restart(10_000);
		await storage.leases.release(leaseA);
		let [row] = await storage.plannerHolds.list();
		expect(row).toMatchObject({ machine: "guest-laptop", login: "guest" });
		// A machine's delegated login lasts one process, so the row names the machine and no login.
		expect(row!.ownerSessionId).toBeUndefined();

		// The next process: nothing in memory, and the machine's login ended by the startup reset.
		let leaseB = (await storage.leases.acquire("chopin:writer", "second", 60_000))!;
		await storage.sessions.reset(new Date(), leaseB, 60_000);
		expect((await storage.channels.readAgent(channel.id, new Date()))?.agent?.ownerSessionId)
			.toBeUndefined();
		let sessions = new Sessions(storage, false);
		let restartedPlanners = planners(sessions);
		let attachments = new PlannerAttachments({ ...auth, sessions } as never, 2_000, {
			store: {
				put: hold => storage.plannerHolds.put(leaseB, hold),
				delete: async id => void await storage.plannerHolds.delete(leaseB, id),
			},
		});
		await attachments.restore(await storage.plannerHolds.list());
		expect(attachments.status(channel.id)).toEqual({ state: "attached", login: "guest" });
		expect(attachments.attached(channel.id)).toBe(false);
		let second = linkServer(
			{ ...auth, sessions } as never,
			2_000,
			undefined,
			2_000,
			undefined,
			restartedPlanners,
			{
				attachments,
			},
		);
		cleanups.push(second.stop);

		// Its backend reconnects with the credential it was issued, which the connector need not renew.
		let backend = await rawLink(second.url, body.token, "resumable-sessions, restart-notice");
		backend.send({ type: "attach", version: AGENT_VERSION, document: channel.id });
		await backend.next("attached");
		backend.send({ type: "resume", sessions: [{ session: sessionId, requests: [] }] });
		expect(await backend.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: sessionId, requests: [] }],
		});
		expect(attachments.attached(channel.id)).toBe(true);
		let owner = (await storage.channels.readAgent(channel.id, new Date()))!.agent!.ownerSessionId;
		expect(owner).toBeDefined();
		expect(owner).not.toBe(oldLogin);
		expect(await sessions.resolve(owner!)).toBeDefined();
		for (
			let deadline = Date.now() + 2_000;
			(await storage.plannerHolds.get(channel.id)) && Date.now() < deadline;
		) {
			await Bun.sleep(5);
		}
		expect(await storage.plannerHolds.get(channel.id)).toBeUndefined();
		backend.socket.close();
	});

	it("keeps no token, only the digest of a credential, and writes it before handing the credential out", async () => {
		let { pair, credential, channel, storage, planners } = await machineServer();
		let member = await pair("member", "U_member");
		let { body } = await credential(member.token, channel.id);
		let digest = new Uint8Array(new Bun.CryptoHasher("sha256").update(body.token).digest());
		expect(await storage.plannerCredentials.find(digest, new Date())).toMatchObject({
			machineId: member.machine.id,
			channelId: channel.id,
		});
		expect(await storage.plannerCredentials.find(new TextEncoder().encode(body.token), new Date()))
			.toBeUndefined();

		let put = storage.plannerCredentials.put.bind(storage.plannerCredentials);
		storage.plannerCredentials.put = async () => {
			throw new Error("the database is unavailable");
		};
		try {
			await expect(planners.issue(member.machine, channel.id)).rejects.toThrow("unavailable");
			let refused = await credential(member.token, channel.id);
			expect(refused.status).toBe(503);
			expect(refused.body.token).toBeUndefined();
		} finally {
			storage.plannerCredentials.put = put;
		}
	});

	it("refuses, in a new process too, a credential that expired, was withdrawn, or whose machine ended", async () => {
		let { pair, credential, channel, machines, sessions, storage, auth, planners, time } =
			await machineServer();
		let member = await pair("member", "U_member");
		let other = await pair("member", "U_member");
		let process = () =>
			new MachinePlanners({
				machines,
				sessions,
				storage,
				github: auth.github,
				config: auth.config,
				clock: () => new Date(Date.now() + time.offsetMs),
			});
		let expired = (await credential(member.token, channel.id)).body.token;
		let withdrawn = (await credential(member.token, channel.id)).body.token;
		let revoked = (await credential(other.token, channel.id)).body.token;
		let live = (await credential(member.token, channel.id)).body.token;

		await planners.withdraw(member.machine.id, crypto.randomUUID());
		expect(await process().redeem(withdrawn)).toMatchObject({ channelId: channel.id });
		await planners.withdraw(member.machine.id, channel.id);
		expect(await process().redeem(withdrawn)).toBeUndefined();
		expect(await process().redeem(live)).toBeUndefined();
		// A credential names the machine that was given it and no other.
		expect(await process().redeem(revoked)).toMatchObject({ machine: { id: other.machine.id } });

		await machines.revoke(other.machine.id, "U_member");
		expect(await process().redeem(revoked)).toBeUndefined();
		await Bun.sleep(20);
		expect(
			await storage.plannerCredentials.find(
				new Uint8Array(new Bun.CryptoHasher("sha256").update(revoked).digest()),
				new Date(),
			),
		).toBeUndefined();

		time.offsetMs = 15 * 60_000 + 1;
		expect(await process().redeem(expired)).toBeUndefined();
	});

	it("releases every document when a machine whose login expired, then reattached at once, is revoked", async () => {
		let {
			pair,
			credential,
			channel,
			server,
			machines,
			planners,
			storage,
			sessions,
			clock,
			owner,
			auth,
		} = await machineServer();
		let other = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_score",
			repositoryOwner: "octo-org",
			repositoryName: "score",
			title: "Other document",
			createdBy: "U_member",
			now: new Date(),
		});
		let member = await pair("member", "U_member");
		/** Both documents' backends attach, their attach frames handled in the same turn. */
		async function reattach() {
			let links = await Promise.all([channel.id, other.id].map(async id => {
				let { body } = await credential(member.token, id);
				let grant = await planners.redeem(body.token);
				let frames: Array<Record<string, any>> = [];
				let closes: number[] = [];
				let link = agentLink(
					{ oauthToken: "", user: { id: "U_member", login: "member", avatarUrl: "" } },
					auth,
					{
						send: text => void frames.push(JSON.parse(text)),
						close: code => void closes.push(code),
					},
					{ attachments: server.attachments },
					{ ...grant!, planners },
				);
				return { id, link, frames, closes };
			}));
			for (let { id, link } of links) {
				link.receive(
					JSON.stringify({ type: "attach", version: AGENT_VERSION, document: id }),
				);
			}
			for (let deadline = Date.now() + 4_000; Date.now() < deadline; await Bun.sleep(10)) {
				if (links.every(({ frames }) => frames.some(frame => frame.type === "attached"))) break;
			}
			expect(links.map(({ frames }) => frames.some(frame => frame.type === "attached")))
				.toEqual([true, true]);
			return links;
		}
		await reattach();
		// The machine's login reaches its 30-day expiry while the machine stays paired.
		clock.skewMs = 31 * 24 * 60 * 60_000;
		await sessions.cleanupExpired();
		let links = await reattach();
		let logins = [
			(await owner(channel.id))?.ownerSessionId,
			(await owner(other.id))?.ownerSessionId,
		];
		expect(logins[0]).toBeDefined();
		// One login per machine at a time: the documents reattached together share the new one.
		expect(logins[1]).toBe(logins[0]);

		await machines.revoke(member.machine.id, "U_member");
		for (let deadline = Date.now() + 4_000; Date.now() < deadline; await Bun.sleep(10)) {
			if (links.every(({ closes }) => closes.length > 0)) break;
		}
		expect(links.map(({ closes }) => closes)).toEqual([[LINK_CLOSE.forbidden], [
			LINK_CLOSE.forbidden,
		]]);
		expect([server.attachments.attached(channel.id), server.attachments.attached(other.id)])
			.toEqual([false, false]);
		expect(logins.map(id => sessions.isLive(id!))).toEqual([false, false]);
	});
});

/** The status an agent connection's upgrade gets with `credential`: 101 when it opens. */
async function upgrade(url: string, credential: string) {
	return (await upgradeRequest(url, { authorization: `Bearer ${credential}` })).status;
}

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
 * A paired machine's Planner backend, attached with its credential and offering
 * `resumable-sessions`, with a run and a question open, whose link then drops.
 */
async function parkedMachine() {
	let m = await machineServer();
	let member = await m.pair("member", "U_member");
	let issued = await m.credential(member.token, m.channel.id);
	let f = await hostInputRoom();
	cleanups.push(f.close);
	let raw = await rawLink(m.server.url, issued.body.token, "resumable-sessions");
	raw.send({ type: "attach", version: AGENT_VERSION, document: m.channel.id });
	await raw.next("attached");
	let planner: RemotePlanner = { channelId: m.channel.id, isolated: false };
	planner.humanInput = report =>
		createHumanInput(f.room, (runId, signal) => untilUnpaused(planner, runId, signal), report);
	let sessionId = crypto.randomUUID();
	let opening = createRemoteAdapter(() => ({ link: m.server.links.at(-1)!, planner })).doStart({
		sessionId,
		sandboxSession: {
			defaultWorkingDirectory: "/tmp",
			async run() {
				return { exitCode: 0, stdout: "", stderr: "" };
			},
			async destroy() {},
		} as never,
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
	raw.send({ type: "runs", session: sessionId, active: ["run"], paused: [], cards: [run] });
	await until(() => planner.runs?.active.length === 1);
	raw.socket.close();
	await raw.closed;
	await until(() => m.server.links.length === 0);
	expect(m.server.attachments.status(m.channel.id)).toEqual({
		state: "disconnected",
		login: "member",
	});
	return {
		...m,
		member,
		f,
		sessionId,
		card: card!,
		status: () => f.plan.records.get(card!.id)?.status,
		runStatus: () => planner.runs?.cards[0]?.status,
		token: issued.body.token,
	};
}

describe("a paired machine's Planner whose link dropped with its work kept", () => {
	it("resumes with a fresh credential long after the first one expired, and receives the answer given meanwhile", async () => {
		let p = await parkedMachine();
		await p.f.answer(p.card.id, [0]);
		// 16 minutes on: the credential the backend was launched with no longer opens a link.
		p.time.offsetMs = 16 * 60_000;
		expect(await upgrade(p.server.url, p.token)).toBe(401);
		// The connector replaced it in the token file; the backend reads that and attaches again.
		let fresh = await p.credential(p.member.token, p.channel.id);
		expect(fresh.status).toBe(200);
		expect(fresh.body.token).not.toBe(p.token);
		let next = await rawLink(p.server.url, fresh.body.token, "resumable-sessions");
		cleanups.push(() => next.socket.close());
		next.send({ type: "attach", version: AGENT_VERSION, document: p.channel.id });
		expect((await next.next("attached")).features).toEqual(["resumable-sessions"]);
		next.send({ type: "resume", sessions: [{ session: p.sessionId, requests: ["ask-1"] }] });
		expect(await next.next("resumed")).toEqual({
			type: "resumed",
			sessions: [{ session: p.sessionId, requests: ["ask-1"] }],
		});
		expect(await next.next("input-result")).toMatchObject({ request: "ask-1", status: "answered" });
		expect(p.runStatus()).toBe("running");
	});

	it("ends when its owner chooses another machine for the document", async () => {
		let p = await parkedMachine();
		await p.server.attachments.stopMachine(
			p.channel.id,
			p.member.machine.id,
			"chose another machine",
		);
		await until(() => p.status() === "cancelled");
		expect(p.runStatus()).toBe("stopped");
		expect(p.server.attachments.status(p.channel.id)).toEqual({ state: "none" });
	});

	it("ends when the machine is unpaired, and neither its old credential nor a new one is accepted", async () => {
		let p = await parkedMachine();
		await p.machines.revoke(p.member.machine.id, "U_member");
		await until(() => p.status() === "cancelled");
		expect(p.runStatus()).toBe("stopped");
		expect(p.server.attachments.status(p.channel.id)).toEqual({ state: "none" });
		expect(await upgrade(p.server.url, p.token)).toBe(401);
		expect(await p.credential(p.member.token, p.channel.id))
			.toMatchObject({ status: 401, body: { error: "machine-revoked" } });
	});

	it("ends when the same account attaches with its browser sign-in, which cannot resume a machine's work", async () => {
		let p = await parkedMachine();
		let browser = await rawLink(p.server.url, MEMBER_TOKEN, "resumable-sessions");
		cleanups.push(() => browser.socket.close());
		browser.send({ type: "attach", version: AGENT_VERSION, document: p.channel.id });
		await browser.next("attached");
		await until(() => p.status() === "cancelled");
		expect(p.runStatus()).toBe("stopped");
	});
});
