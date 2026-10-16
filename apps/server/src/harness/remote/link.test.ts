import { afterEach, describe, expect, it } from "bun:test";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { tool } from "ai";
import { z } from "zod";
import {
	AGENT_PATH,
	AGENT_SUBPROTOCOL,
	AGENT_VERSION,
	LINK_CLOSE,
	MAX_LINK_MESSAGE_BYTES,
} from "@chopin/agent-link";
import { AgentRefused } from "@chopin/agent-link/client";

import { GitHubError } from "../../github/client";
import * as Store from "../../questions/store";
import * as Plan from "../../plan/service";
import { createPlannerAgent } from "../agents";
import { createHumanInput } from "../atomic/human-input";
import { openPlannerSession } from "../session";
import { untilUnpaused } from "../atomic/full";
import { hostInputRoom, laterTimers } from "../../testing/decisions";
import {
	attach,
	DENIED_TOKEN,
	finishTurn,
	GUEST_TOKEN,
	holdingProxy,
	linkAuth,
	linkServer,
	MEMBER_TOKEN,
	OUTSIDER_TOKEN,
	rawLink,
	RIVAL_TOKEN,
	scriptedPlanner,
	silentLink,
	slowUplink,
	upgradeRequest,
	VIEWER_TOKEN,
} from "../../testing/agent-link";
import { createRemoteAdapter } from "./adapter";
import { admitAgent } from "./endpoint";
import { remotePlanner } from "./registry";

import type { AgentClient, AgentHandlers } from "@chopin/agent-link/client";
import type { ActiveOwnerBinding } from "../../agent/active-owner";
import type { RemotePlanner } from "./registry";

let cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (let cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function setup(handlers?: Partial<AgentHandlers>) {
	let { auth, storage, channel } = await linkAuth();
	let server = linkServer(auth, 300);
	cleanups.push(server.stop);
	let script = scriptedPlanner();
	let client: AgentClient | undefined;
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

let readPlanRuns = 0;

function agentFor(harness: ReturnType<typeof createRemoteAdapter>) {
	return new HarnessAgent({
		harness,
		tools: {
			read_plan: tool({
				inputSchema: z.object({}),
				execute: async () => {
					readPlanRuns++;
					return "the plan";
				},
			}),
		},
		activeTools: ["read_plan"],
		permissionMode: "allow-reads",
	});
}

type Agent = ReturnType<typeof agentFor>;

/** Streams one turn of an open session to its end, returning its parts and any error it ended with. */
async function streamOn(
	agent: Agent,
	session: Awaited<ReturnType<Agent["createSession"]>>,
	prompt: string,
) {
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

/** Streams one turn of a new session to its end. */
async function streamTurn(harness: ReturnType<typeof createRemoteAdapter>, prompt: string) {
	let agent = agentFor(harness);
	let session = await agent.createSession({ sandboxSession });
	cleanups.push(() => session.destroy());
	return streamOn(agent, session, prompt);
}

/** Attaches a raw link and answers the next `start`, returning the session it names. */
async function rawAttached(server: ReturnType<typeof linkServer>, document: string) {
	let raw = await rawLink(server.url);
	raw.send({ type: "attach", version: 1, document });
	await raw.next("attached");
	let started = raw.next("start").then(start => {
		raw.send({ type: "started", session: start.session });
		return start.session as string;
	});
	return { raw, started };
}

/** Waits until `condition` holds, for at most `withinMs`. */
async function until(condition: () => boolean, withinMs: number) {
	for (let deadline = Date.now() + withinMs; !condition() && Date.now() < deadline;) {
		await Bun.sleep(10);
	}
}

describe("Agent connection admission", () => {
	it("upgrades only with the chopin.agent.v1 subprotocol, and echoes it", async () => {
		let { server } = await setup();
		let member = { authorization: `Bearer ${MEMBER_TOKEN}` };
		for (
			let headers of [
				{ "sec-websocket-protocol": "" },
				{ ...member, "sec-websocket-protocol": "" },
				{ ...member, "sec-websocket-protocol": "chopin.agent.v2, graphql-ws" },
			]
		) {
			let refused = await upgradeRequest(server.url, headers);
			expect(refused.status).toBe(426);
			expect(refused.headers.get("content-type")).toStartWith("application/json");
			expect(refused.headers.get("sec-websocket-protocol")).toBeNull();
			expect(await refused.json()).toEqual({
				code: "subprotocol-required",
				supported: ["chopin.agent.v1"],
			});
		}
		let accepted = await upgradeRequest(server.url, {
			...member,
			"sec-websocket-protocol": "chopin.agent.v2, chopin.agent.v1",
		});
		expect(accepted.status).toBe(101);
		expect(accepted.headers.get("sec-websocket-protocol")).toBe("chopin.agent.v1");
		let raw = await rawLink(server.url);
		expect(raw.socket.protocol).toBe("chopin.agent.v1");
		raw.socket.close();
		expect((await upgradeRequest(server.url, member, "/planner-link")).status).toBe(404);
		expect(server.links).toEqual([]);
	});

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
				authorization: `Bearer ${MEMBER_TOKEN}`,
				origin: "https://elsewhere.test",
			})).status,
		).toBe(403);
		await expect(attach(server.url, channel.id, scriptedPlanner().handlers, "bad-token"))
			.rejects.toThrow("closed before attaching");
		expect(server.links).toEqual([]);
	});

	it("answers 404 where the server does not run the remote Planner", async () => {
		let { auth } = await linkAuth();
		let request = new Request(`https://chopin.test${AGENT_PATH}`, {
			headers: {
				authorization: `Bearer ${MEMBER_TOKEN}`,
				upgrade: "websocket",
				"sec-websocket-protocol": AGENT_SUBPROTOCOL,
			},
		});
		let refused = await admitAgent(request, auth, false);
		expect(refused).toBeInstanceOf(Response);
		expect((refused as Response).status).toBe(404);
		expect(await admitAgent(request, auth, true)).toMatchObject({ agentLink: true });
	});

	it("refuses a repository the caller cannot read, a missing or archived document, and another version", async () => {
		let { server, channel, storage } = await setup();
		let before = await storage.channels.get(channel.id);
		let refusal = (token: string, document: string) =>
			attach(server.url, document, scriptedPlanner().handlers, token).then(
				() => undefined,
				(error: AgentRefused) => error.code,
			);
		expect(await refusal(OUTSIDER_TOKEN, channel.id)).toBe("repository-forbidden");
		expect(await refusal(MEMBER_TOKEN, crypto.randomUUID())).toBe("document-unavailable");
		let raw = await rawLink(server.url);
		raw.send({ type: "attach", version: AGENT_VERSION + 1, document: channel.id });
		expect(await raw.next("refused")).toMatchObject({ code: "unsupported-version" });
		expect((await raw.closed).code).toBe(LINK_CLOSE.unsupportedVersion);
		expect(await storage.channels.get(channel.id)).toEqual(before);
		await storage.channels.archive({ id: channel.id, now: new Date() });
		expect(await refusal(MEMBER_TOKEN, channel.id)).toBe("document-archived");
		expect(server.links).toEqual([]);
	});

	it("attaches a member to the document by id or URL", async () => {
		let { server, channel } = await setup();
		let client = await attach(server.url, channel.id, scriptedPlanner().handlers);
		expect(client.document).toEqual({
			id: channel.id,
			title: "Linked document",
			repository: "octo-org/score",
			url: `https://chopin.test/documents/octo-org/score/${channel.slug}`,
		});
		await client.detach();
		let byUrl = await attach(server.url, client.document.url!, scriptedPlanner().handlers);
		expect(byUrl.document.id).toBe(channel.id);
		expect(server.links.map(link => link.channelId)).toEqual([channel.id]);
		await byUrl.detach();
		expect(server.links).toEqual([]);
	});
});

describe("Agent connection ownership", () => {
	/** The code, message, and close code an attach is refused with. */
	async function refused(url: string, document: string, token: string) {
		let raw = await rawLink(url, token);
		raw.send({ type: "attach", version: AGENT_VERSION, document });
		let refusal = await raw.next("refused");
		return { code: refusal.code, message: refusal.message, close: (await raw.closed).code };
	}

	async function owner(
		storage: Awaited<ReturnType<typeof linkAuth>>["storage"],
		channelId: string,
	) {
		return (await storage.channels.readAgent(channelId, new Date()))?.agent;
	}

	it("makes the attaching member the owner through their browser login, replacing an unattached owner", async () => {
		let { auth, storage, channel, logins } = await linkAuth();
		let server = linkServer(auth);
		cleanups.push(server.stop);
		let stale = await storage.channels.claimAgentOwner(
			channel.id,
			logins.get("rival")!,
			new Date(),
		);
		expect(stale).toMatchObject({ ownerSessionId: logins.get("rival"), generation: 1 });
		let client = await attach(server.url, channel.id, scriptedPlanner().handlers);
		cleanups.push(() => client.detach());
		expect(await owner(storage, channel.id))
			.toMatchObject({ ownerSessionId: logins.get("member"), generation: 2, status: "ready" });
		expect(server.attachments.attached(channel.id)).toBe(true);
		expect(server.attachments.holder(channel.id)).toBe("member");
	});

	it("refuses a second attach while a Planner is attached, naming the holder", async () => {
		let { auth, storage, channel, logins } = await linkAuth();
		let server = linkServer(auth);
		cleanups.push(server.stop);
		let client = await attach(server.url, channel.id, scriptedPlanner().handlers);
		cleanups.push(() => client.detach());
		let held = await owner(storage, channel.id);
		expect(held).toMatchObject({ ownerSessionId: logins.get("member"), generation: 1 });
		for (let token of [RIVAL_TOKEN, MEMBER_TOKEN]) {
			expect(await refused(server.url, channel.id, token)).toEqual({
				code: "planner-attached",
				message: "member is attached as this document's Planner. "
					+ "A document has one Planner at a time.",
				close: LINK_CLOSE.attached,
			});
		}
		expect(await owner(storage, channel.id)).toEqual(held);
		expect(server.links).toHaveLength(1);
	});

	it("refuses an account that cannot push or has no browser login, and takes no ownership", async () => {
		let { auth, storage, channel } = await linkAuth();
		let server = linkServer(auth);
		cleanups.push(server.stop);
		expect(await refused(server.url, channel.id, VIEWER_TOKEN)).toEqual({
			code: "repository-forbidden",
			message: "Attaching as this document's Planner needs push or administration access to "
				+ "octo-org/score.",
			close: LINK_CLOSE.forbidden,
		});
		expect(await refused(server.url, channel.id, GUEST_TOKEN)).toEqual({
			code: "sign-in-required",
			message: "Sign in to Chopin at https://chopin.test in a browser as guest, then attach "
				+ "again. The Planner's repository tools act with that sign-in.",
			close: LINK_CLOSE.unauthorized,
		});
		expect((await owner(storage, channel.id))?.ownerSessionId).toBeUndefined();
		expect(server.links).toEqual([]);
	});

	it("keeps ownership through the grace period for the same member, then releases it", async () => {
		let { auth, storage, channel, logins } = await linkAuth();
		let server = linkServer(auth, 2_000, undefined, 400);
		cleanups.push(server.stop);
		let first = await attach(server.url, channel.id, scriptedPlanner().handlers);
		await first.detach();
		expect(await owner(storage, channel.id))
			.toMatchObject({ ownerSessionId: logins.get("member"), generation: 1 });
		let refusal = await refused(server.url, channel.id, RIVAL_TOKEN);
		expect(refusal).toMatchObject({ code: "planner-attached", close: LINK_CLOSE.attached });
		expect(refusal.message).toStartWith(
			"member detached from this document's Planner and holds it until ",
		);

		let dropped = await rawLink(server.url);
		dropped.send({ type: "attach", version: AGENT_VERSION, document: channel.id });
		await dropped.next("attached");
		expect(await owner(storage, channel.id))
			.toMatchObject({ ownerSessionId: logins.get("member"), generation: 1 });
		dropped.socket.close();
		await dropped.closed;
		await Bun.sleep(100);
		expect((await owner(storage, channel.id))?.ownerSessionId).toBe(logins.get("member"));
		for (let deadline = Date.now() + 3_000; Date.now() < deadline;) {
			if (!(await owner(storage, channel.id))?.ownerSessionId) break;
			await Bun.sleep(25);
		}
		expect(await owner(storage, channel.id))
			.toMatchObject({ ownerSessionId: undefined, generation: 1, status: "unavailable" });

		let rival = await attach(server.url, channel.id, scriptedPlanner().handlers, RIVAL_TOKEN);
		cleanups.push(() => rival.detach());
		expect(await owner(storage, channel.id))
			.toMatchObject({ ownerSessionId: logins.get("rival"), generation: 2 });
	});

	it("detaches a link whose account loses push access while it stays attached", async () => {
		let { auth, channel } = await linkAuth();
		let server = linkServer(auth, 300, 20);
		cleanups.push(server.stop);
		let client = await attach(server.url, channel.id, scriptedPlanner().handlers);
		let repository = auth.github.repository;
		auth.github.repository = async (token, owner, name) => ({
			...await repository(token, owner, name),
			permissions: { pull: true, push: false, admin: false },
		});
		expect(await client.closed).toEqual({ code: LINK_CLOSE.forbidden, reason: "access-revoked" });
		expect(server.links).toEqual([]);
	});

	/** A member's raw link attached to the document, with ended logins reaching `attachments`. */
	async function attachedMember(revalidateEveryMs?: number) {
		let linked = await linkAuth();
		let server = linkServer(linked.auth, 2_000, revalidateEveryMs, 2_000);
		cleanups.push(server.stop);
		linked.revocations.add(id => server.attachments.sessionRevoked(id));
		let raw = await rawLink(server.url);
		raw.send({ type: "attach", version: AGENT_VERSION, document: linked.channel.id });
		await raw.next("attached");
		expect(server.attachments.attached(linked.channel.id)).toBe(true);
		return { ...linked, server, raw };
	}

	async function rivalAttaches(
		url: string,
		channelId: string,
		storage: Awaited<ReturnType<typeof linkAuth>>["storage"],
		rival: string,
	) {
		let client = await attach(url, channelId, scriptedPlanner().handlers, RIVAL_TOKEN);
		cleanups.push(() => client.detach());
		expect(await owner(storage, channelId)).toMatchObject({ ownerSessionId: rival });
	}

	it("releases the Planner at once when its owner signs out of the browser", async () => {
		let { server, raw, channel, storage, logins, signOut } = await attachedMember();
		expect(await signOut("member")).toBe(logins.get("member"));
		expect(await raw.next("refused")).toEqual({
			type: "refused",
			code: "sign-in-required",
			message: "The Chopin browser sign-in that made member this document's Planner ended, so "
				+ "the Planner was released. Sign in to Chopin at https://chopin.test in a browser as "
				+ "member, then attach again.",
		});
		expect((await raw.closed).code).toBe(LINK_CLOSE.unauthorized);
		expect(server.attachments.attached(channel.id)).toBe(false);
		expect(server.attachments.holder(channel.id)).toBeUndefined();
		expect((await owner(storage, channel.id))?.ownerSessionId).toBeUndefined();
		await rivalAttaches(server.url, channel.id, storage, logins.get("rival")!);
	});

	it("releases the Planner when its owner's browser sign-in expires", async () => {
		let { server, raw, channel, storage, sessions, clock } = await attachedMember();
		clock.skewMs = 31 * 24 * 60 * 60 * 1_000;
		await sessions.cleanupExpired();
		expect(await raw.next("refused")).toMatchObject({ code: "sign-in-required" });
		expect((await raw.closed).code).toBe(LINK_CLOSE.unauthorized);
		expect(server.attachments.attached(channel.id)).toBe(false);
		expect((await owner(storage, channel.id))?.ownerSessionId).toBeUndefined();
	});

	it("notices an expired owner sign-in on its periodic recheck when nothing revoked it", async () => {
		let { server, raw, channel, storage, clock } = await attachedMember(20);
		clock.skewMs = 31 * 24 * 60 * 60 * 1_000;
		expect(await raw.next("refused")).toMatchObject({ code: "sign-in-required" });
		expect((await raw.closed).code).toBe(LINK_CLOSE.unauthorized);
		expect(server.attachments.attached(channel.id)).toBe(false);
		expect((await owner(storage, channel.id))?.ownerSessionId).toBeUndefined();
	});

	it("releases the Planner as sign-in-required when storage already sees its owner's sign-in expired", async () => {
		let { auth, server, raw, channel, storage, clock } = await attachedMember(20);
		let held = (await owner(storage, channel.id))!;
		auth.clock = () => new Date(Date.now() + clock.skewMs);
		clock.skewMs = 31 * 24 * 60 * 60 * 1_000;
		expect(await raw.next("refused")).toMatchObject({
			code: "sign-in-required",
			message: expect.stringContaining("The Chopin browser sign-in that made member"),
		});
		expect((await raw.closed).code).toBe(LINK_CLOSE.unauthorized);
		expect(server.attachments.attached(channel.id)).toBe(false);
		clock.skewMs = 0;
		expect(await owner(storage, channel.id)).toMatchObject({
			ownerSessionId: undefined,
			generation: held.generation,
			status: "unavailable",
		});
	});

	/** Holds the next attach's ownership read until `resume`, once `reading` says it started. */
	function pauseOwnerRead(storage: Awaited<ReturnType<typeof linkAuth>>["storage"]) {
		let readAgent = storage.channels.readAgent;
		let reading = Promise.withResolvers<void>();
		let resume = Promise.withResolvers<void>();
		storage.channels.readAgent = async (channelId, now) => {
			storage.channels.readAgent = readAgent;
			let snapshot = await readAgent(channelId, now);
			reading.resolve();
			await resume.promise;
			return snapshot;
		};
		return { reading: reading.promise, resume: () => resume.resolve() };
	}

	/** A member detached within the grace period, reattaching on a raw link paused at its ownership read. */
	async function reattachingMember() {
		let linked = await linkAuth();
		let server = linkServer(linked.auth, 2_000, undefined, 2_000);
		cleanups.push(server.stop);
		linked.revocations.add(id => server.attachments.sessionRevoked(id));
		let first = await attach(server.url, linked.channel.id, scriptedPlanner().handlers);
		await first.detach();
		let held = (await owner(linked.storage, linked.channel.id))!;
		let paused = pauseOwnerRead(linked.storage);
		let raw = await rawLink(server.url);
		raw.send({ type: "attach", version: AGENT_VERSION, document: linked.channel.id });
		await paused.reading;
		return { ...linked, server, raw, held, resume: paused.resume };
	}

	it("refuses a grace reattach whose ownership a reset released while it was attaching", async () => {
		let { server, raw, channel, storage, logins, held, resume } = await reattachingMember();
		await storage.channels.clearAgentOwner(
			channel.id,
			held.ownerSessionId!,
			held.generation,
			new Date(),
		);
		server.attachments.ownerReset(channel.id);
		resume();
		expect(await raw.next("refused")).toEqual({
			type: "refused",
			code: "access-revoked",
			message: "A repository writer reset this document's Planner, so member is no longer "
				+ "attached. Attach again to resume.",
		});
		expect((await raw.closed).code).toBe(LINK_CLOSE.forbidden);
		expect(server.attachments.attached(channel.id)).toBe(false);
		expect(server.attachments.holder(channel.id)).toBeUndefined();
		expect(server.links).toEqual([]);
		expect((await owner(storage, channel.id))?.ownerSessionId).toBeUndefined();
		await rivalAttaches(server.url, channel.id, storage, logins.get("rival")!);
	});

	it("refuses a grace reattach whose owner signed out while it was attaching", async () => {
		let { server, raw, channel, storage, logins, signOut, resume } = await reattachingMember();
		expect(await signOut("member")).toBe(logins.get("member"));
		resume();
		expect(await raw.next("refused")).toMatchObject({
			code: "sign-in-required",
			message: expect.stringContaining("The Chopin browser sign-in that made member"),
		});
		expect((await raw.closed).code).toBe(LINK_CLOSE.unauthorized);
		expect(server.attachments.attached(channel.id)).toBe(false);
		expect(server.links).toEqual([]);
		expect((await owner(storage, channel.id))?.ownerSessionId).toBeUndefined();
		await rivalAttaches(server.url, channel.id, storage, logins.get("rival")!);
	});

	/** A member's fresh attach on a raw link, paused while GitHub checks its repository access. */
	async function checkingMember() {
		let linked = await linkAuth();
		let server = linkServer(linked.auth);
		cleanups.push(server.stop);
		linked.revocations.add(id => server.attachments.sessionRevoked(id));
		let { github } = linked.auth;
		let repositoryAccess = github.repositoryAccess;
		let checking = Promise.withResolvers<void>();
		let resume = Promise.withResolvers<void>();
		github.repositoryAccess = async (token, repositoryOwner, name) => {
			github.repositoryAccess = repositoryAccess;
			checking.resolve();
			await resume.promise;
			return repositoryAccess(token, repositoryOwner, name);
		};
		let raw = await rawLink(server.url);
		raw.send({ type: "attach", version: AGENT_VERSION, document: linked.channel.id });
		await checking.promise;
		return { ...linked, server, raw, resume: () => resume.resolve() };
	}

	async function refusedSignIn(
		attempt: Awaited<ReturnType<typeof checkingMember>>,
	) {
		let { server, raw, channel, storage } = attempt;
		expect(await raw.next("refused")).toEqual({
			type: "refused",
			code: "sign-in-required",
			message: "Sign in to Chopin at https://chopin.test in a browser as member, then attach "
				+ "again. The Planner's repository tools act with that sign-in.",
		});
		expect(await raw.closed).toEqual({ code: LINK_CLOSE.unauthorized, reason: "sign-in-required" });
		expect(server.attachments.attached(channel.id)).toBe(false);
		expect(server.attachments.holder(channel.id)).toBeUndefined();
		expect(server.links).toEqual([]);
		expect((await owner(storage, channel.id))?.ownerSessionId).toBeUndefined();
	}

	it("refuses a fresh attach whose owner signed out while its repository access was checked", async () => {
		let attempt = await checkingMember();
		expect(await attempt.signOut("member")).toBe(attempt.logins.get("member"));
		attempt.resume();
		await refusedSignIn(attempt);
		let { server, channel, storage, logins } = attempt;
		await rivalAttaches(server.url, channel.id, storage, logins.get("rival")!);
	});

	it("refuses a fresh attach whose sign-in storage saw expire before it claimed ownership", async () => {
		let attempt = await checkingMember();
		attempt.auth.clock = () => new Date(Date.now() + attempt.clock.skewMs);
		attempt.clock.skewMs = 31 * 24 * 60 * 60 * 1_000;
		attempt.resume();
		await refusedSignIn(attempt);
	});

	it("releases the attachment when a repository writer resets the document's Planner", async () => {
		let { server, raw, channel, storage, logins } = await attachedMember();
		let held = (await owner(storage, channel.id))!;
		await storage.channels.clearAgentOwner(
			channel.id,
			held.ownerSessionId!,
			held.generation,
			new Date(),
		);
		server.attachments.ownerReset(channel.id);
		expect(await raw.next("refused")).toEqual({
			type: "refused",
			code: "access-revoked",
			message: "A repository writer reset this document's Planner, so member is no longer "
				+ "attached. Attach again to resume.",
		});
		expect((await raw.closed).code).toBe(LINK_CLOSE.forbidden);
		expect(server.attachments.attached(channel.id)).toBe(false);
		await rivalAttaches(server.url, channel.id, storage, logins.get("rival")!);
	});

	it("closes a link whose stored ownership was released elsewhere on its next recheck", async () => {
		let { server, raw, channel, storage, logins } = await attachedMember(20);
		let held = (await owner(storage, channel.id))!;
		await storage.channels.clearAgentOwner(
			channel.id,
			held.ownerSessionId!,
			held.generation,
			new Date(),
		);
		expect(await raw.next("refused")).toEqual({
			type: "refused",
			code: "access-revoked",
			message: "This document's Planner ownership was released, so member is no longer "
				+ "attached. Attach again to resume.",
		});
		expect((await raw.closed).code).toBe(LINK_CLOSE.forbidden);
		expect(server.attachments.attached(channel.id)).toBe(false);
		await rivalAttaches(server.url, channel.id, storage, logins.get("rival")!);
	});

	describe("liveness", () => {
		const liveness = { pingEveryMs: 50, pongTimeoutMs: 300 };

		it("closes a link that stops answering pings within the timeout, ending its turn as a drop does", async () => {
			let { auth, channel } = await linkAuth();
			let server = linkServer(auth, 2_000, undefined, 2_000, liveness);
			cleanups.push(server.stop);
			let silent = await silentLink(server.url);
			cleanups.push(silent.end);
			silent.send({ type: "attach", version: AGENT_VERSION, document: channel.id });
			await silent.next("attached");
			expect(server.attachments.attached(channel.id)).toBe(true);
			let started = silent.next("start").then(start => {
				silent.send({ type: "started", session: start.session });
				return silent.next("turn");
			});
			let outcome = streamTurn(
				adapterFor(server, { channelId: channel.id, isolated: false }),
				"hang",
			);
			let turn = await started;
			let quiet = Date.now();
			expect(turn).toMatchObject({ type: "turn", prompt: "hang" });
			expect(await silent.closed).toEqual({
				code: LINK_CLOSE.unresponsive,
				reason: "unresponsive",
			});
			let elapsed = Date.now() - quiet;
			expect(elapsed).toBeGreaterThan(liveness.pongTimeoutMs - 100);
			expect(elapsed).toBeLessThan(liveness.pongTimeoutMs + 500);
			expect(silent.pings).toBeGreaterThanOrEqual(3);
			let { errors, session } = await outcome;
			expect(errors.join("\n")).toContain("disconnected during the turn");
			expect(session.hasUnfinishedTurn()).toBe(false);
			expect(server.links).toEqual([]);
			expect(server.attachments.attached(channel.id)).toBe(false);
		});

		it("holds a silent link's ownership through the grace period, then releases it", async () => {
			let { auth, storage, channel, logins } = await linkAuth();
			let server = linkServer(auth, 2_000, undefined, 400, liveness);
			cleanups.push(server.stop);
			let silent = await silentLink(server.url);
			cleanups.push(silent.end);
			silent.send({ type: "attach", version: AGENT_VERSION, document: channel.id });
			await silent.next("attached");
			expect((await silent.closed).code).toBe(LINK_CLOSE.unresponsive);
			expect(server.attachments.attached(channel.id)).toBe(false);
			expect(await owner(storage, channel.id))
				.toMatchObject({ ownerSessionId: logins.get("member"), generation: 1 });
			let refusal = await refused(server.url, channel.id, RIVAL_TOKEN);
			expect(refusal).toMatchObject({ code: "planner-attached", close: LINK_CLOSE.attached });
			expect(refusal.message).toStartWith(
				"member detached from this document's Planner and holds it until ",
			);
			for (let deadline = Date.now() + 3_000; Date.now() < deadline;) {
				if (!(await owner(storage, channel.id))?.ownerSessionId) break;
				await Bun.sleep(25);
			}
			expect(await owner(storage, channel.id))
				.toMatchObject({ ownerSessionId: undefined, generation: 1, status: "unavailable" });
			await rivalAttaches(server.url, channel.id, storage, logins.get("rival")!);
		});

		it("keeps a client that answers pings attached across several timeouts", async () => {
			let { auth, channel } = await linkAuth();
			let server = linkServer(auth, 2_000, undefined, 2_000, liveness);
			cleanups.push(server.stop);
			let script = scriptedPlanner();
			let client = await attach(server.url, channel.id, script.handlers);
			cleanups.push(() => client.detach());
			await Bun.sleep(liveness.pongTimeoutMs * 4);
			expect(server.links).toHaveLength(1);
			expect(server.attachments.attached(channel.id)).toBe(true);
			let { errors } = await streamTurn(
				adapterFor(server, { channelId: channel.id, isolated: false }),
				"turn",
			);
			expect(errors).toEqual([]);
			expect(script.turns).toHaveLength(1);
		});

		/** Writes valid host results until the server's outbound queue passes Bun's 16 MiB limit. */
		function flood(server: ReturnType<typeof linkServer>) {
			let [socket] = server.sockets;
			let result = JSON.stringify({
				type: "host-tool-result",
				session: "session",
				turn: "turn",
				toolCallId: "call",
				output: "x".repeat(MAX_LINK_MESSAGE_BYTES - 200),
				isError: false,
			});
			for (let count = 0; count < 15; count++) socket!.send(result);
			expect(socket!.getBufferedAmount()).toBeGreaterThan(16 * 1024 * 1024);
			return socket!;
		}

		/** Bun's client socket, which can stop reading from the network. */
		type Readable = WebSocket & { pause(): boolean; resume(): boolean; terminate(): void };

		// Bun drops control frames, pings included, while the queue is over its limit.
		const backlogged = { pingEveryMs: 200, pongTimeoutMs: 600 };

		it(
			"keeps a client that stopped reading under a flood once it reads again and drains",
			async () => {
				let { auth, channel } = await linkAuth();
				let server = linkServer(auth, 2_000, undefined, 2_000, backlogged);
				cleanups.push(server.stop);
				let raw = await rawLink(server.url);
				let client = raw.socket as Readable;
				cleanups.push(() => client.close());
				raw.send({ type: "attach", version: AGENT_VERSION, document: channel.id });
				await raw.next("attached");
				client.pause();
				let socket = flood(server);
				await Bun.sleep(backlogged.pingEveryMs * 2.4);
				client.resume();
				await until(() => socket.getBufferedAmount() === 0, 3_000);
				expect(socket.getBufferedAmount()).toBe(0);
				await Bun.sleep(backlogged.pongTimeoutMs * 3);
				expect(client.readyState).toBe(WebSocket.OPEN);
				expect(server.attachments.attached(channel.id)).toBe(true);
				expect(server.links).toHaveLength(1);
			},
			10_000,
		);

		it(
			"closes a client that stops reading under a flood and never drains within about the timeout",
			async () => {
				let { auth, channel } = await linkAuth();
				let server = linkServer(auth, 2_000, undefined, 2_000, backlogged);
				cleanups.push(server.stop);
				let raw = await rawLink(server.url);
				let client = raw.socket as Readable;
				cleanups.push(() => client.terminate());
				raw.send({ type: "attach", version: AGENT_VERSION, document: channel.id });
				await raw.next("attached");
				client.pause();
				let quiet = Date.now();
				flood(server);
				await until(() => !server.attachments.attached(channel.id), 3_000);
				let elapsed = Date.now() - quiet;
				expect(server.attachments.attached(channel.id)).toBe(false);
				expect(server.links).toEqual([]);
				expect(elapsed).toBeGreaterThan(backlogged.pongTimeoutMs - 100);
				expect(elapsed).toBeLessThan(backlogged.pongTimeoutMs + 500);
			},
			10_000,
		);

		it(
			"closes a silent client by about the silence cap although a proxy keeps draining its queue",
			async () => {
				// Bun hands the proxy its queue in steps about half a second apart at this pace.
				let capped = { pingEveryMs: 100, pongTimeoutMs: 800, maxSilenceMs: 1_600 };
				let { auth, channel } = await linkAuth();
				let server = linkServer(auth, 2_000, undefined, 2_000, capped);
				cleanups.push(server.stop);
				let proxy = await holdingProxy(server.url, 100);
				cleanups.push(proxy.stop);
				let raw = await rawLink(proxy.url);
				cleanups.push(() => (raw.socket as Readable).terminate());
				raw.send({ type: "attach", version: AGENT_VERSION, document: channel.id });
				await raw.next("attached");
				let quiet = Date.now();
				proxy.hold();
				let socket = flood(server);
				let queued = socket.getBufferedAmount();
				let drainedPastTimeout = false;
				setTimeout(() => {
					drainedPastTimeout = socket.getBufferedAmount() < queued;
				}, capped.pongTimeoutMs + 300);
				await until(() => !server.attachments.attached(channel.id), 6_000);
				let elapsed = Date.now() - quiet;
				expect(server.attachments.attached(channel.id)).toBe(false);
				expect(server.links).toEqual([]);
				expect(elapsed).toBeGreaterThan(capped.maxSilenceMs - 100);
				expect(elapsed).toBeLessThan(capped.maxSilenceMs + 500);
				// The queue was still draining past the timeout, which defers the close only up to the cap.
				expect(drainedPastTimeout).toBe(true);
			},
			10_000,
		);

		it(
			"keeps a live client through an upload that outlasts several pings but not the timeout",
			async () => {
				let slow = { pingEveryMs: 100, pongTimeoutMs: 1_500 };
				let { auth, channel } = await linkAuth();
				let server = linkServer(auth, 2_000, undefined, 2_000, slow);
				cleanups.push(server.stop);
				let uplink = await slowUplink(server.url, 4_096, 10);
				cleanups.push(uplink.stop);
				let raw = await rawLink(uplink.url);
				cleanups.push(() => raw.socket.close());
				raw.send({ type: "attach", version: AGENT_VERSION, document: channel.id });
				await raw.next("attached");
				// One unfragmented frame: the client's pongs queue behind it until it is through.
				let frame = JSON.stringify({
					type: "part",
					session: "session",
					turn: "turn",
					part: { type: "text-delta", id: "text", delta: "x".repeat(256 * 1024) },
				});
				let before = uplink.uploaded;
				let started = Date.now();
				raw.send(frame);
				await until(() => uplink.uploaded - before >= frame.length, slow.pongTimeoutMs);
				let took = Date.now() - started;
				expect(uplink.uploaded - before).toBeGreaterThanOrEqual(frame.length);
				expect(took).toBeGreaterThan(slow.pingEveryMs * 3);
				expect(took).toBeLessThan(slow.pongTimeoutMs);
				await Bun.sleep(slow.pongTimeoutMs);
				expect(raw.socket.readyState).toBe(WebSocket.OPEN);
				expect(server.attachments.attached(channel.id)).toBe(true);
			},
			10_000,
		);
	});
});

describe("Agent connection protocol", () => {
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

	it("gives the server and the client the same error when a host result cannot cross the link", async () => {
		let seen: unknown[] = [];
		let { server, channel } = await setup({
			async turn(context) {
				seen.push(await context.callHostTool("read_plan", {}));
				finishTurn(context);
			},
		});
		let agent = new HarnessAgent({
			harness: adapterFor(server, { channelId: channel.id, isolated: false }),
			tools: {
				read_plan: tool({
					inputSchema: z.object({}),
					execute: async () => "x".repeat(MAX_LINK_MESSAGE_BYTES),
				}),
			},
			activeTools: ["read_plan"],
			permissionMode: "allow-reads",
		});
		let session = await agent.createSession({ sandboxSession });
		cleanups.push(() => session.destroy());
		let outcome = await streamOn(agent, session, "large");
		let failure = { error: "read_plan returned more than the agent connection can carry." };
		expect(seen).toEqual([{ output: failure, isError: true }]);
		expect(outcome.parts.filter(part => part.type === "tool-result" || part.type === "tool-error"))
			.toMatchObject([{ toolName: "read_plan" }]);
		expect(JSON.stringify(outcome.parts)).not.toContain("x".repeat(1_000));
		expect(JSON.stringify(outcome.parts)).toContain(failure.error);
	});

	it("reports an own tool's structured error as a failure and returns host results unredacted", async () => {
		let secret = `token=ghp_${"A".repeat(30)}\npassword: hunter2`;
		let envelope = {
			error: { code: "no-repository-credential", kind: "NoRepositoryCredential", message: "Nope." },
		};
		let seen: unknown[] = [];
		let reports: unknown[] = [];
		let { server, channel } = await setup({
			async turn(context) {
				seen.push(await context.callHostTool("read_plan", {}));
				context.offerTools(["fetch_repository"]);
				context.emit({
					type: "tool-call",
					toolCallId: "own-1",
					toolName: "fetch_repository",
					input: "{}",
					providerExecuted: true,
				});
				context.emit({
					type: "tool-result",
					toolCallId: "own-1",
					toolName: "fetch_repository",
					result: envelope,
					isError: true,
				});
				finishTurn(context);
			},
		});
		let agent = new HarnessAgent({
			harness: adapterFor(server, {
				channelId: channel.id,
				isolated: false,
				toolReport: (...report) => reports.push(report),
			}),
			tools: { read_plan: tool({ inputSchema: z.object({}), execute: async () => secret }) },
			activeTools: ["read_plan"],
			permissionMode: "allow-reads",
		});
		let session = await agent.createSession({ sandboxSession });
		cleanups.push(() => session.destroy());
		let outcome = await streamOn(agent, session, "structured");
		expect(outcome.errors).toEqual([]);
		expect(seen).toEqual([{ output: secret, isError: false }]);
		expect(reports).toEqual([["own-1", envelope, "failed"]]);
		expect(outcome.parts.filter(part => part.type === "tool-error")).toMatchObject([
			{ toolCallId: "own-1", error: envelope },
		]);
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
			.rejects.toThrow("can no longer act for this document");
		expect(server.links).toEqual([]);
	});

	it("rechecks the caller's access before every turn of a kept session", async () => {
		let { server, channel, auth } = await setup({});
		let agent = agentFor(adapterFor(server, { channelId: channel.id, isolated: false }));
		let session = await agent.createSession({ sandboxSession });
		cleanups.push(() => session.destroy());
		expect((await streamOn(agent, session, "first")).errors).toEqual([]);
		auth.github.repository = async () => {
			throw new GitHubError("Not Found", 404);
		};
		let revoked = await streamOn(agent, session, "second");
		expect(revoked.errors.join("\n")).toContain("can no longer act for this document");
		expect(server.links).toEqual([]);
	});

	it("detaches a link whose access is lost while it stays attached", async () => {
		let { auth, channel } = await linkAuth();
		let server = linkServer(auth, 300, 20);
		cleanups.push(server.stop);
		let client = await attach(server.url, channel.id, scriptedPlanner().handlers);
		await Bun.sleep(60);
		expect(server.links).toHaveLength(1);
		auth.github.repository = async () => {
			throw new GitHubError("Not Found", 404);
		};
		expect(await client.closed).toEqual({ code: LINK_CLOSE.forbidden, reason: "access-revoked" });
		expect(server.links).toEqual([]);
	});

	it("detaches a link whose token GitHub rejects while admission is still cached", async () => {
		let { server, channel, auth, client } = await setup({});
		let agent = agentFor(adapterFor(server, { channelId: channel.id, isolated: false }));
		let session = await agent.createSession({ sandboxSession });
		cleanups.push(() => session.destroy());
		auth.github.repository = async () => {
			throw new GitHubError("Bad credentials", 401);
		};
		let revoked = await streamOn(agent, session, "second");
		expect(revoked.errors.join("\n")).toContain("can no longer act for this document");
		expect(await client.closed).toEqual({ code: LINK_CLOSE.forbidden, reason: "access-revoked" });
		expect(server.links).toEqual([]);
	});

	it("detaches on a rejected token at the periodic check but stays attached through an outage", async () => {
		let { auth, channel } = await linkAuth();
		let server = linkServer(auth, 300, 20);
		cleanups.push(server.stop);
		let client = await attach(server.url, channel.id, scriptedPlanner().handlers);
		auth.github.repository = async () => {
			throw new GitHubError("Service Unavailable", 503);
		};
		await Bun.sleep(80);
		expect(server.links).toHaveLength(1);
		auth.github.repository = async () => {
			throw new GitHubError("Bad credentials", 401);
		};
		expect(await client.closed).toEqual({ code: LINK_CLOSE.forbidden, reason: "access-revoked" });
		expect(server.links).toEqual([]);
	});

	it("refuses a host call id the turn already used, even after that call finished", async () => {
		let { server, channel } = await setup();
		let { raw, started } = await rawAttached(server, channel.id);
		let driving = (async () => {
			let session = await started;
			let turn = (await raw.next("turn")).turn;
			let call = {
				type: "host-tool-call",
				session,
				turn,
				toolCallId: "same",
				toolName: "read_plan",
				input: "{}",
			};
			raw.send(call);
			expect(await raw.next("host-tool-result")).toMatchObject({ output: "the plan" });
			raw.send(call);
			await raw.next("abort");
		})();
		readPlanRuns = 0;
		let outcome = await streamTurn(
			adapterFor(server, { channelId: channel.id, isolated: false }),
			"repeat",
		);
		await driving;
		expect(outcome.errors.join("\n")).toContain("Tool call same was repeated");
		expect(readPlanRuns).toBe(1);
	});

	it("fails a turn that reuses a refused host call id or its own finished tool call id", async () => {
		let { server, channel } = await setup();
		let harness = adapterFor(server, { channelId: channel.id, isolated: false });
		async function reuse(
			script: (
				send: (message: object) => void,
				raw: Awaited<ReturnType<typeof rawLink>>,
			) => Promise<void>,
		) {
			let { raw, started } = await rawAttached(server, channel.id);
			let driving = (async () => {
				let session = await started;
				let turn = (await raw.next("turn")).turn;
				await script(message => raw.send({ session, turn, ...message }), raw);
				raw.send({ type: "turn-end", session, turn, status: "finished" });
				await raw.next("abort");
			})();
			let outcome = await streamTurn(harness, "reuse");
			await driving;
			raw.socket.close();
			await raw.closed;
			return outcome.errors.join("\n");
		}
		readPlanRuns = 0;
		let refused = await reuse(async (send, raw) => {
			let call = { type: "host-tool-call", toolCallId: "refused", input: "{}" };
			send({ ...call, toolName: "write_plan" });
			expect(await raw.next("host-tool-result")).toMatchObject({
				toolCallId: "refused",
				output: { error: "write_plan is not available in this turn." },
				isError: true,
			});
			send({ ...call, toolName: "read_plan" });
		});
		expect(refused).toContain("Tool call refused was repeated");
		expect(readPlanRuns).toBe(0);
		let own = await reuse(async send => {
			let call = { toolCallId: "own", toolName: "bash" };
			send({ type: "tools", names: ["bash"] });
			send({
				type: "part",
				part: { type: "tool-call", ...call, input: "{}", providerExecuted: true },
			});
			send({ type: "part", part: { type: "tool-result", ...call, result: "done" } });
			send({
				type: "part",
				part: { type: "tool-call", ...call, input: "{}", providerExecuted: true },
			});
		});
		expect(own).toContain("Tool call own was repeated");
	});

	it("answers a host call for a session that has ended with an error result", async () => {
		let { server, channel } = await setup();
		let { raw, started } = await rawAttached(server, channel.id);
		let opened = await adapterFor(server, { channelId: channel.id, isolated: false }).doStart({
			sessionId: crypto.randomUUID(),
			sandboxSession,
			sessionWorkDir: "/tmp",
		});
		let session = await started;
		await opened.doDestroy();
		await raw.next("destroy");
		raw.send({
			type: "host-tool-call",
			session,
			turn: "gone",
			toolCallId: "late",
			toolName: "read_plan",
			input: "{}",
		});
		expect(await raw.next("host-tool-result")).toEqual({
			type: "host-tool-result",
			session,
			turn: "gone",
			toolCallId: "late",
			output: { error: "The session has ended." },
			isError: true,
		});
	});
});

describe("Agent connection questions", () => {
	async function questions(options: { isolated?: boolean } = {}) {
		let f = await hostInputRoom();
		cleanups.push(f.close);
		let { server, channel, client } = await setup({});
		let planner: RemotePlanner = { channelId: channel.id, isolated: options.isolated ?? false };
		if (!options.isolated) {
			planner.humanInput = report =>
				createHumanInput(
					f.room,
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

	it("keeps a client's question open past half an hour until a member answers it", async () => {
		let { f, client, sessionId } = await questions();
		let clock = laterTimers();
		try {
			let settled = false;
			let asked = client.ask(sessionId, { method: "confirm", title: "Ship?", message: "Now." })
				.finally(() => {
					settled = true;
				});
			let [card] = await f.cards(1);
			await clock.pass(31 * 60 * 1_000);
			expect(settled).toBe(false);
			expect(f.plan.records.get(card!.id)?.status).toBe("open");
			await f.answer(card!.id, [0]);
			expect(await asked).toMatchObject({ status: "answered", value: true });
		} finally {
			clock.restore();
		}
	});

	it("withdraws a question open past half an hour when the link closes", async () => {
		let { f, client, sessionId } = await questions();
		let clock = laterTimers();
		try {
			void client.ask(sessionId, { method: "confirm", title: "Ship?", message: "Now." })
				.catch(() => {});
			let [card] = await f.cards(1);
			await clock.pass(31 * 60 * 1_000);
			expect(f.plan.records.get(card!.id)?.status).toBe("open");
			await client.detach();
			await until(() => Store.outstanding(f.plan.questions).length === 0, 2_000);
			expect(f.plan.records.get(card!.id)).toMatchObject({ status: "cancelled" });
			expect(Plan.source(f.plan)).not.toContain(card!.id);
		} finally {
			clock.restore();
		}
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

	it("closes the link when an answered input-request id is reused", async () => {
		let f = await hostInputRoom();
		cleanups.push(f.close);
		let { server, channel } = await setup();
		let { raw, started } = await rawAttached(server, channel.id);
		let opened = await adapterFor(server, {
			channelId: channel.id,
			isolated: false,
			humanInput: report => createHumanInput(f.room, undefined, report),
		}).doStart({ sessionId: crypto.randomUUID(), sandboxSession, sessionWorkDir: "/tmp" });
		cleanups.push(() => opened.doDestroy());
		let request = {
			type: "input-request",
			request: "asked",
			session: await started,
			input: { method: "confirm", title: "Ship?", message: "" },
		};
		raw.send(request);
		let [card] = await f.cards(1);
		await f.answer(card!.id, [0]);
		expect(await raw.next("input-result")).toMatchObject({ request: "asked", status: "answered" });
		raw.send(request);
		expect(await raw.next("error")).toMatchObject({
			code: "protocol",
			message: "Input request asked was repeated.",
		});
		expect((await raw.closed).code).toBe(LINK_CLOSE.malformed);
		expect(Store.outstanding(f.plan.questions)).toHaveLength(0);
		expect(f.plan.records.size).toBe(1);
	});

	it("refuses a failed input-request id again until 1024 later ids have been used", async () => {
		let { server, channel } = await setup();
		let raw = await rawLink(server.url);
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let ask = (request: string) =>
			raw.send({
				type: "input-request",
				request,
				session: "none",
				input: { method: "confirm", title: "Ship?", message: "" },
			});
		let ids = ["first", ...Array.from({ length: 1_024 }, (_, index) => `later-${index}`)];
		for (let id of ids) ask(id);
		for (let id of ids) {
			expect(await raw.next("input-result")).toMatchObject({ request: id, status: "failed" });
		}
		ask("first");
		expect(await raw.next("input-result")).toMatchObject({ request: "first", status: "failed" });
		ask("later-1");
		expect(await raw.next("error")).toMatchObject({
			code: "protocol",
			message: "Input request later-1 was repeated.",
		});
		expect((await raw.closed).code).toBe(LINK_CLOSE.malformed);
	});

	it("withdraws a question asked while a session starts when the start fails or times out", async () => {
		let f = await hostInputRoom();
		cleanups.push(f.close);
		let asks: Promise<{ status: string }>[] = [];
		let client: AgentClient | undefined;
		let linked = await setup({
			async start(message) {
				asks.push(client!.ask(message.session, { method: "confirm", title: "Ship?", message: "" }));
				await f.cards(1);
				if (message.session === "refused") throw new Error("busy elsewhere");
				await Bun.sleep(1_000);
			},
		});
		client = linked.client;
		let planner: RemotePlanner = {
			channelId: f.room.id,
			isolated: false,
			humanInput: report => createHumanInput(f.room, undefined, report),
		};
		let harness = adapterFor(linked.server, planner);
		let start = (sessionId: string) =>
			harness.doStart({ sessionId, sandboxSession, sessionWorkDir: "/tmp" });
		await expect(start("refused")).rejects.toThrow("refused the session: busy elsewhere");
		expect(await asks[0]).toMatchObject({ status: "cancelled" });
		expect(Store.outstanding(f.plan.questions)).toHaveLength(0);
		await expect(start("silent")).rejects.toThrow("did not start the session");
		expect(await asks[1]).toMatchObject({ status: "cancelled" });
		expect(Store.outstanding(f.plan.questions)).toHaveLength(0);
		expect([...f.plan.records.values()].map(record => record.status))
			.toEqual(["cancelled", "cancelled"]);
	});

	/** Opens a real remote Planner session over the link whose turn waits in a host `ask`. */
	async function askingTurn(ending: "detach" | "violation" | "destroy" | "turn-end") {
		let f = await hostInputRoom();
		cleanups.push(f.close);
		let { server, client } = await setup({
			async turn(context) {
				let asked = context.callHostTool("ask", {
					revision: f.plan.revision,
					questions: [{
						header: "Store",
						question: "Which store?",
						options: [{ label: "Postgres", description: "durable" }],
						multiple: false,
						blocks: [],
					}],
				});
				if (ending !== "turn-end") return void await asked;
				await f.cards(1);
				context.end("failed", "The client gave up.");
			},
		});
		let agent = createPlannerAgent(
			createRemoteAdapter(sessionId => ({
				link: server.links.at(-1)!,
				planner: remotePlanner(sessionId)!,
			})),
		);
		let toolSignal: AbortSignal | undefined;
		let owner = {
			channelId: f.room.id,
			token: "test-token",
			repository: { id: "R_test", owner: "org", name: "repo", defaultBranch: "main" },
			signal: new AbortController().signal,
			currentToken: () => "test-token",
			revalidate: async () => true,
			release() {},
		} as unknown as ActiveOwnerBinding;
		let opened = await openPlannerSession(owner, {
			room: f.room,
			repository: owner.repository,
			instructions: "Plan.",
			harness: "remote",
		}, {
			githubTools: async () => ({ ok: true, value: {} }),
			createSandbox: async () => sandboxSession,
			registerCredential: () => () => {},
			agent: {
				createSession: options => agent.createSession(options),
				stream: call => {
					toolSignal = (call.options as { toolSignal?: AbortSignal }).toolSignal;
					return agent.stream(call);
				},
			} as typeof agent,
		});
		if (!opened.ok) throw new Error("Planner unavailable");
		let session = opened.value;
		cleanups.push(() => session.destroy());
		let caller = new AbortController();
		let parts: { type: string; error?: unknown }[] = [];
		let streaming = (async () => {
			let result = await session.stream("ask", caller.signal);
			for await (let part of result.fullStream) parts.push(part);
		})();
		let [card] = await f.cards(1);
		if (ending === "detach") await client.detach();
		if (ending === "violation") client.send({ type: "attach", version: 1, document: "again" });
		if (ending === "destroy") void session.destroy();
		await streaming;
		expect(parts.some(part => part.type === "abort")).toBe(false);
		expect(caller.signal.aborted).toBe(false);
		expect(toolSignal?.aborted).toBe(true);
		expect(Store.outstanding(f.plan.questions)).toHaveLength(0);
		expect(f.plan.records.get(card!.id)).toMatchObject({ status: "cancelled" });
		return parts.filter(part => part.type === "error").map(part => String(part.error));
	}

	it("stops a host ask, withdraws its Decision and fails the turn when the link drops mid-tool", async () => {
		let disconnected = ["Error: The attached Planner disconnected during the turn."];
		expect(await askingTurn("detach")).toEqual(disconnected);
		expect(await askingTurn("violation")).toEqual(disconnected);
	});

	it("stops a host ask and withdraws its Decision when its turn ends before the tool does", async () => {
		expect(await askingTurn("turn-end")).toEqual(["Error: The client gave up."]);
		await askingTurn("destroy");
	});
});
