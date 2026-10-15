import { afterEach, describe, expect, it } from "bun:test";
import { AGENT_VERSION, LINK_CLOSE } from "@chopin/agent-link";
import { CONNECTOR_PROTOCOL_HEADER, CONNECTOR_VERSION_HEADER } from "@chopin/protocol/connector";

import { ActiveOwnerBindings } from "../../agent/active-owner";
import { Machines } from "../../auth/machines";
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
import { agentLink } from "./endpoint";
import { MachinePlanners } from "./machine-planners";

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
			message: "The paired machine member-laptop that made member this document's Planner was "
				+ "disconnected from Chopin or must be paired again, so the Planner was released. "
				+ "Run `chopin pair` on it, then attach again.",
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
