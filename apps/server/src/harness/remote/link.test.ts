import { afterEach, describe, expect, it, spyOn } from "bun:test";
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
import { AgentRefused, connectAgent } from "@chopin/agent-link/client";

import { GitHubError } from "../../github/client";
import { plannerToActOn } from "../../questions/answer-turns";
import * as Store from "../../questions/store";
import * as Plan from "../../plan/service";
import * as Edit from "../../plan/edit";
import * as Room from "../../plan/room";
import { documentTools } from "../../agent/tools";
import { readingOutput } from "../../agent/reading-output";
import { fieldNotes, reading } from "../../document-reading.test-fixtures";
import { openPlan } from "../../testing/plan";
import { expectPlainStatus } from "../../testing/plain-words";
import { createPlannerAgent, createResearchAgent } from "../agents";
import { withModelOutput } from "../model-output";
import { openWorkerSession } from "../../jobs/worker-session";
import { createHumanInput } from "../atomic/human-input";
import { openPlannerSession } from "../session";
import { hostInputRoom, laterTimers } from "../../testing/decisions";
import { REPLACED_LAUNCH_GRACE_MS } from "./link";
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
import { refusedChoice } from "@chopin/protocol/model-choice";

import { sessionModel } from "../../chat/model-choice";
import { remoteCatalog } from "../catalog";
import { plannerCatalog, plannerOffered, plannerOfferKnown } from "../harnesses";
import { createRemoteAdapter } from "./adapter";
import { admitAgent } from "./endpoint";
import type { AgentAi, AgentHooks } from "./endpoint";
import { remotePlanner } from "./registry";
import { testLease } from "../../storage/contract-support";
import { AiCredentials } from "../../ai/credentials";
import {
	AiLaunchRefused,
	catalogOnly,
	endLaunch,
	handOut,
	PLANNER_AI_LAUNCH_MS,
} from "../../ai/launches";
import { aiProxy } from "../../ai/proxy";
import { turnFailureOf } from "../../chat/turn-failure";

import type { AgentClient, AgentHandlers, TurnContext } from "@chopin/agent-link/client";
import type { ActiveOwnerBinding } from "../../agent/active-owner";
import type { PlannerChoice } from "../session";
import type { PlannerTurn } from "../turn-level";
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
		await storage.channels.archive({
			id: channel.id,
			now: new Date(),
			lease: await testLease(storage),
		});
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
		expectPlainStatus(String(refusal.message), "a refusal to a client");
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
				message: "member is connected to this document. "
					+ "A document has one agent connected at a time.",
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
			message: "Connecting to this document needs push or administration access to "
				+ "octo-org/score.",
			close: LINK_CLOSE.forbidden,
		});
		expect(await refused(server.url, channel.id, GUEST_TOKEN)).toEqual({
			code: "sign-in-required",
			message: "Sign in to Chopin at https://chopin.test in a browser as guest, then connect "
				+ "again. Repository tools act with that sign-in.",
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
			"member disconnected from this document and keeps it until ",
		);
		expect(refusal.message).toEndWith(
			" unless they connect again. A document has one agent connected at a time.",
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
			message: "The Chopin browser sign-in that connected member to this document ended, so "
				+ "the connection was released. Sign in to Chopin at https://chopin.test in a browser as "
				+ "member, then connect again.",
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
			message: expect.stringContaining("The Chopin browser sign-in that connected member"),
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
			message: "A repository writer reset this document's connection, so member is no longer "
				+ "connected. Connect again to resume.",
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
			message: expect.stringContaining("The Chopin browser sign-in that connected member"),
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
			message: "Sign in to Chopin at https://chopin.test in a browser as member, then connect "
				+ "again. Repository tools act with that sign-in.",
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
			message: "A repository writer reset this document's connection, so member is no longer "
				+ "connected. Connect again to resume.",
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
			message: "This document's connection was released, so member is no longer "
				+ "connected. Connect again to resume.",
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
				"member disconnected from this document and keeps it until ",
			);
			expect(refusal.message).toEndWith(
				" unless they connect again. A document has one agent connected at a time.",
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

	it("refuses a run report, and a question naming a workflow run, as malformed: it keeps no runs", async () => {
		let { server, channel } = await setup();
		for (
			let frame of [
				{ type: "runs", session: "s", active: [], paused: [], cards: [] },
				{
					type: "input-request",
					request: "r",
					session: "s",
					workflowRunId: "run-1",
					input: { method: "confirm", title: "Ship?", message: "Now." },
				},
			]
		) {
			let raw = await rawLink(server.url, undefined, "resumable-sessions");
			raw.send({ type: "attach", version: 1, document: channel.id });
			await raw.next("attached");
			raw.send(frame);
			expect(await raw.next("error")).toMatchObject({ code: "malformed-message" });
			expect((await raw.closed).code).toBe(LINK_CLOSE.malformed);
		}
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

	it("names the features a client asked for in attached, and nothing for a client that did not ask", async () => {
		let { server, channel } = await setup();
		for (
			let [header, features] of [
				[undefined, undefined],
				["decision-option-previews", ["decision-option-previews"]],
				["future-thing, decision-option-previews", ["decision-option-previews"]],
				["future-thing", []],
				// Run reports are gone, so a client that still asks for their feature is not given it.
				["run-stage-deltas", []],
				["resumable-sessions, restart-notice", ["resumable-sessions", "restart-notice"]],
			] as const
		) {
			let raw = await rawLink(server.url, undefined, header);
			raw.send({ type: "attach", version: 1, document: channel.id });
			let attached = await raw.next("attached");
			expect(attached.features).toEqual(features);
			expect("features" in attached).toBe(features !== undefined);
			raw.send({ type: "detach" });
			await raw.closed;
		}
	});

	it("offers upload_plan_image only to a client that asked for decision-option-previews", async () => {
		let { server, channel } = await setup();
		let both = new HarnessAgent({
			harness: adapterFor(server, { channelId: channel.id, isolated: false }),
			tools: {
				read_plan: tool({ inputSchema: z.object({}), execute: async () => "the plan" }),
				upload_plan_image: tool({ inputSchema: z.object({}), execute: async () => "stored" }),
			},
			activeTools: ["read_plan", "upload_plan_image"],
			permissionMode: "allow-reads",
		});
		for (
			let [header, offered] of [
				[undefined, ["read_plan"]],
				["steer-turn", ["read_plan"]],
				["decision-option-previews", ["read_plan", "upload_plan_image"]],
				["steer-turn, decision-option-previews", ["read_plan", "upload_plan_image"]],
			] as const
		) {
			let raw = await rawLink(server.url, undefined, header);
			raw.send({ type: "attach", version: 1, document: channel.id });
			await raw.next("attached");
			let started = raw.next("start").then(start => {
				raw.send({ type: "started", session: start.session });
				return raw.next("turn");
			});
			let session = await both.createSession({ sandboxSession });
			cleanups.push(() => session.destroy());
			let outcome = (async () => {
				let result = await both.stream({ session, prompt: "look" });
				for await (let _part of result.fullStream);
			})();
			let turn = await started;
			expect(turn.tools.map((item: { name: string }) => item.name)).toEqual(offered);
			raw.send({ type: "turn-end", session: turn.session, turn: turn.turn, status: "finished" });
			await outcome;
			raw.send({ type: "detach" });
			await raw.closed;
		}
	});

	it("names a turn's message, and a retry of it, only to a client that asked for retry-turn", async () => {
		let { server, channel } = await setup();
		for (
			let [header, answers, sent] of [
				[undefined, { id: "msg-1", retry: true }, {}],
				["steer-turn", { id: "msg-1", retry: true }, {}],
				["retry-turn", { id: "msg-1" }, { message: "msg-1" }],
				["retry-turn", { id: "msg-1", retry: true }, { message: "msg-1", retry: true }],
				["retry-turn", undefined, {}],
			] as const
		) {
			let planner: RemotePlanner = { channelId: channel.id, isolated: false };
			let agent = agentFor(adapterFor(server, planner));
			let raw = await rawLink(server.url, undefined, header);
			raw.send({ type: "attach", version: 1, document: channel.id });
			await raw.next("attached");
			let started = raw.next("start").then(start => {
				raw.send({ type: "started", session: start.session });
				return raw.next("turn");
			});
			let session = await agent.createSession({ sandboxSession });
			cleanups.push(() => session.destroy());
			planner.turnMessage = answers ? { ...answers } : undefined;
			let outcome = (async () => {
				let result = await agent.stream({ session, prompt: "@ana: hello" });
				for await (let _part of result.fullStream);
			})();
			let turn = await started;
			expect({ message: turn.message, retry: turn.retry }).toEqual({
				message: undefined,
				retry: undefined,
				...sent,
			});
			// Taken by its turn: the next one names nothing unless it is told again.
			expect(planner.turnMessage).toBeUndefined();
			raw.send({ type: "turn-end", session: turn.session, turn: turn.turn, status: "finished" });
			await outcome;
			raw.send({ type: "detach" });
			await raw.closed;
		}
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
		expect(undeclared.errors.join("\n")).toContain("Chopin's tool boundary failure: bash");
		let isolated = await streamTurn(
			adapterFor(server, { channelId: channel.id, isolated: true }),
			"declared",
		);
		expect(isolated.errors.join("\n")).toContain("An isolated Planner turn cannot offer bash");
	});

	it("sends the attached client read_plan as paged text, the way its model is to read it", async () => {
		let seen: Array<{ output: unknown; isError: boolean }> = [];
		let { server, channel } = await setup({
			async turn(context) {
				seen.push(await context.callHostTool("read_plan", { offset: 1 }));
				finishTurn(context);
			},
		});
		let fixture = await openPlan(fieldNotes(60_000));
		cleanups.push(() => Plan.close(fixture.plan));
		let agent = new HarnessAgent({
			harness: withModelOutput(
				adapterFor(server, { channelId: channel.id, isolated: false }),
				readingOutput,
			),
			tools: { read_plan: documentTools.read_plan },
			activeTools: ["read_plan"],
			toolsContext: {
				read_plan: {
					room: {
						id: fixture.plan.id,
						plan: fixture.plan,
						server: fixture.server,
						persist: () => Plan.persist(fixture.plan),
						exclusive: action => Plan.exclusive(fixture.plan, action),
						publish: async () => {},
						anchors: () => {},
						changes: () => {},
					},
				},
			},
			permissionMode: "allow-reads",
		});
		let session = await agent.createSession({ sandboxSession });
		cleanups.push(() => session.destroy());
		let outcome = await streamOn(agent as never, session as never, "read");
		expect(outcome.errors).toEqual([]);
		expect(seen).toHaveLength(1);
		let text = seen[0]!.output as string;
		expect(seen[0]!.isError).toBe(false);
		expect(text).not.toStartWith("{");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16_000);
		expect(reading(text).fields.document).toBe(fixture.plan.id);
		expect(reading(text).next).toBeDefined();
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

describe("Agent connection steering", () => {
	/** A turn that hangs until it is aborted, on a session of its own. */
	async function hanging(handlers: Partial<AgentHandlers>) {
		let running = Promise.withResolvers<void>();
		let fixture = await setup({
			async turn(context) {
				context.emit({ type: "stream-start", modelId: "scripted" });
				running.resolve();
				await new Promise(resolve => context.signal.addEventListener("abort", resolve));
			},
			...handlers,
		});
		let harness = adapterFor(fixture.server, { channelId: fixture.channel.id, isolated: false });
		let agent = agentFor(harness);
		let session = await agent.createSession({ sandboxSession });
		cleanups.push(() => session.destroy());
		let abort = new AbortController();
		let result = await agent.stream({ session, prompt: "turn", abortSignal: abort.signal });
		let drained = (async () => {
			for await (let _part of result.fullStream);
		})();
		await running.promise;
		return {
			...fixture,
			harness,
			session,
			end: async () => {
				abort.abort();
				await drained.catch(() => {});
			},
		};
	}

	it("reaches the running turn of a client that offered steer-turn, which answers it", async () => {
		let heard: Array<{ turn: string; prompt: string }> = [];
		let { session, server, channel, harness, end } = await hanging({
			steer(message) {
				heard.push({ turn: message.turn, prompt: message.prompt });
			},
		});
		expect(server.links.at(-1)!.steers).toBe(true);
		expect(harness.steers(channel.id)).toBe(true);
		await session.experimental_steerTurn("@bo: Also say what it costs.");
		expect(heard).toHaveLength(1);
		expect(heard[0]!.prompt).toBe("@bo: Also say what it costs.");
		await end();
	});

	it("is offered only to a client that asked for steer-turn, and says so for its document", async () => {
		let { server, channel, harness, session, end } = await hanging({});
		expect(server.links.at(-1)!.steers).toBe(false);
		expect(harness.steers(channel.id)).toBe(false);
		await expect(session.experimental_steerTurn("@bo: hello")).rejects.toThrow(
			/does not support steering/,
		);
		await end();
	});

	it("tells the sender when the client could not take it", async () => {
		let { session, end } = await hanging({
			steer() {
				throw new Error("The model is between steps.");
			},
		});
		await expect(session.experimental_steerTurn("@bo: hello")).rejects.toThrow(
			"The model is between steps.",
		);
		await end();
	});

	it("is refused once the turn has ended, without a frame going to the client", async () => {
		let heard: string[] = [];
		let { session, end } = await hanging({
			steer(message) {
				heard.push(message.prompt);
			},
		});
		await end();
		await expect(session.experimental_steerTurn("@bo: too late")).rejects.toThrow();
		expect(heard).toEqual([]);
	});
});

describe("Agent connection capability catalog", () => {
	let catalog = {
		models: {
			available: [
				{ id: "acme/large", name: "Large", thinkingLevels: ["off", "high"] },
				{ id: "acme/small", name: "Small" },
			],
			default: { id: "acme/small" },
		},
	};

	it("holds what the client last reported and tells the document each time, replacing it whole", async () => {
		let { auth, channel } = await linkAuth();
		let changed: string[] = [];
		let reports: unknown[] = [];
		let server = linkServer(auth, 300, undefined, undefined, undefined, undefined, {
			catalogChanged: (id, reported) => {
				changed.push(id);
				reports.push(reported);
			},
		});
		cleanups.push(server.stop);
		let raw = await rawLink(server.url, undefined, "capability-catalog");
		raw.send({ type: "attach", version: 1, document: channel.id });
		expect((await raw.next("attached")).features).toEqual(["capability-catalog"]);
		let link = server.links.at(-1)!;
		expect(link.catalog).toBeUndefined();
		raw.send({ type: "capabilities", catalog });
		await until(() => link.catalog !== undefined, 1_000);
		expect(link.catalog).toEqual(catalog);
		let next = { models: { available: [{ id: "acme/other", name: "Other" }] } };
		raw.send({ type: "capabilities", catalog: next });
		await until(() => link.catalog?.models?.available[0]?.id === "acme/other", 1_000);
		expect(link.catalog).toEqual(next);
		raw.send({ type: "capabilities", catalog: {} });
		await until(() => link.catalog?.models === undefined, 1_000);
		expect(link.catalog).toEqual({});
		expect(changed).toEqual([channel.id, channel.id, channel.id]);
		// Each report names the account the client attached for, so its list is kept for it alone.
		expect(reports).toEqual([
			{ userId: "U_member", catalog },
			{ userId: "U_member", catalog: next },
			{ userId: "U_member", catalog: {} },
		]);
		raw.send({ type: "detach" });
		await raw.closed;
	});

	it("has nothing to wait for from a client that never offered the catalog, and waits for one that did until it reports, withdrawing included", async () => {
		let { auth, channel } = await linkAuth();
		let server = linkServer(auth, 300);
		cleanups.push(server.stop);
		let older = await rawLink(server.url);
		older.send({ type: "attach", version: 1, document: channel.id });
		await older.next("attached");
		expect(server.links.at(-1)!.catalogPending).toBe(false);
		older.send({ type: "detach" });
		await older.closed;

		let raw = await rawLink(server.url, undefined, "capability-catalog");
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let link = server.links.at(-1)!;
		expect(link.catalogPending).toBe(true);
		raw.send({ type: "capabilities", catalog: {} });
		await until(() => link.catalog !== undefined, 1_000);
		// Withdrawing everything is a report: what the client offers is known, and it is nothing.
		expect(link.catalogPending).toBe(false);
		raw.send({ type: "detach" });
		await raw.closed;
	});

	it("stops waiting for a catalog its client offered once a turn has run without it, and takes the report if it comes", async () => {
		let { auth, channel } = await linkAuth();
		let server = linkServer(auth, 300);
		cleanups.push(server.stop);
		let raw = await rawLink(server.url, undefined, "capability-catalog");
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let link = server.links.at(-1)!;
		expect(link.catalogPending).toBe(true);
		link.settleWithoutCatalog();
		expect(link.catalogPending).toBe(false);
		// It is still no catalog: the client has offered nothing, and may yet.
		expect(link.catalog).toBeUndefined();
		raw.send({ type: "capabilities", catalog });
		await until(() => link.catalog !== undefined, 1_000);
		expect(link.catalog).toEqual(catalog);
		expect(link.catalogPending).toBe(false);
		raw.send({ type: "detach" });
		await raw.closed;

		// A client of its own is waited for afresh: the earlier link's turn does not settle it.
		let next = await rawLink(server.url, undefined, "capability-catalog");
		next.send({ type: "attach", version: 1, document: channel.id });
		await next.next("attached");
		expect(server.links.at(-1)!.catalogPending).toBe(true);
		next.send({ type: "detach" });
		await next.closed;
	});

	it("keeps a report of more models than a person picks from, and a field it has no use for, and stays attached", async () => {
		let { auth, channel } = await linkAuth();
		let server = linkServer(auth, 300);
		cleanups.push(server.stop);
		let raw = await rawLink(server.url, undefined, "capability-catalog");
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let link = server.links.at(-1)!;
		let grown = {
			models: {
				available: Array.from({ length: 710 }, (_, index) => ({
					id: `p/m${index}`,
					name: `M ${index}`,
					price: { input: 1 },
				})),
			},
			commands: [{ name: "release-notes", kind: "skill", description: "d".repeat(925) }],
			attachments: { images: true },
		};
		raw.send({ type: "capabilities", catalog: grown });
		await until(() => link.catalog !== undefined, 2_000);
		expect(link.catalog).toEqual(grown);
		raw.send({ type: "detach" });
		expect((await raw.closed).code).toBe(1000);
	});

	it("is reported by the test client after attached, behind a resumable link's resume", async () => {
		let { server, channel, script } = await setup();
		for (let resumable of [false, true]) {
			let client = await connectAgent({
				url: server.url,
				token: MEMBER_TOKEN,
				document: channel.id,
				handlers: script.handlers,
				resumable,
				capabilities: catalog,
			});
			let link = server.links.at(-1)!;
			await until(() => link.catalog !== undefined, 1_000);
			expect(link.catalog).toEqual(catalog);
			expect(client.features).toContain("capability-catalog");
			// A later report replaces it, and one a server never offered is not sent.
			expect(client.report({ commands: [{ name: "notes", kind: "skill" }] })).toBe(true);
			await until(() => link.catalog?.models === undefined, 1_000);
			expect(link.catalog).toEqual({ commands: [{ name: "notes", kind: "skill" }] });
			await client.detach();
		}
		let quiet = await attach(server.url, channel.id, script.handlers);
		expect(quiet.report(catalog)).toBe(false);
		await quiet.detach();
	});

	it("reaches the client in the turns of a real Planner session, one turn at a time, and only if it offered the feature", async () => {
		for (let offered of [true, false]) {
			let f = await hostInputRoom();
			cleanups.push(f.close);
			let linked = await linkAuth(f.room.id);
			let server = linkServer(linked.auth, 300);
			cleanups.push(server.stop);
			let seen: Array<{ model?: string; thinkingLevel?: string }> = [];
			let client = await connectAgent({
				url: server.url,
				token: MEMBER_TOKEN,
				document: f.room.id,
				resumable: false,
				...(offered ? { capabilities: catalog } : {}),
				handlers: {
					async turn(context) {
						seen.push({
							...(context.message.model ? { model: context.message.model } : {}),
							...(context.message.thinkingLevel
								? { thinkingLevel: context.message.thinkingLevel }
								: {}),
						});
						finishTurn(context);
					},
				},
			});
			cleanups.push(() => client.detach());
			let agent = createPlannerAgent(
				createRemoteAdapter(sessionId => ({
					link: server.links.at(-1)!,
					planner: remotePlanner(sessionId)!,
				})),
			);
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
				agent,
			});
			if (!opened.ok) throw new Error("Planner unavailable");
			let session = opened.value;
			cleanups.push(() => session.destroy());
			let run = async (choice?: { model?: string; thinkingLevel?: string }) => {
				let result = await session.stream("go", new AbortController().signal, choice);
				for await (let _part of result.fullStream);
			};
			await run({ model: "acme/large", thinkingLevel: "high" });
			await run();
			await run({ thinkingLevel: "low" });
			expect(seen).toEqual(
				offered
					? [{ model: "acme/large", thinkingLevel: "high" }, {}, { thinkingLevel: "low" }]
					: [{ model: "acme/large" }, {}, {}],
			);
		}
	});

	/** A session opened through `openPlannerSession` on a client that offered `session-choice`. */
	async function choosingSession(opens: { model?: string; choice?: PlannerChoice }) {
		let f = await hostInputRoom();
		cleanups.push(f.close);
		let linked = await linkAuth(f.room.id);
		let server = linkServer(linked.auth, 300);
		cleanups.push(server.stop);
		let starts: PlannerChoice[] = [];
		let seen: PlannerChoice[] = [];
		let client = await connectAgent({
			url: server.url,
			token: MEMBER_TOKEN,
			document: f.room.id,
			resumable: false,
			capabilities: catalog,
			sessionChoice: true,
			handlers: {
				start(message) {
					starts.push({
						...(message.model ? { model: message.model } : {}),
						...(message.thinkingLevel ? { thinkingLevel: message.thinkingLevel } : {}),
					});
				},
				async turn(context) {
					seen.push({
						...("model" in context.message ? { model: context.message.model } : {}),
						...("thinkingLevel" in context.message
							? { thinkingLevel: context.message.thinkingLevel }
							: {}),
					});
					finishTurn(context);
				},
			},
		});
		cleanups.push(() => client.detach());
		await until(() => !server.links.at(-1)!.catalogPending, 1_000);
		let agent = createPlannerAgent(
			createRemoteAdapter(sessionId => ({
				link: server.links.at(-1)!,
				planner: remotePlanner(sessionId)!,
			})),
		);
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
			...opens,
		}, {
			githubTools: async () => ({ ok: true, value: {} }),
			createSandbox: async () => sandboxSession,
			registerCredential: () => () => {},
			agent,
		});
		if (!opened.ok) throw new Error("Planner unavailable");
		let session = opened.value;
		cleanups.push(() => session.destroy());
		let run = async (choice?: PlannerChoice) => {
			let result = await session.stream("go", new AbortController().signal, choice);
			for await (let _part of result.fullStream);
		};
		return { starts, seen, run };
	}

	it("opens a session on the stored choice, and leaves out of a later turn a model or level set back to Default", async () => {
		let { starts, seen, run } = await choosingSession({
			choice: { model: "acme/large", thinkingLevel: "high" },
		});
		await run({ model: "acme/large", thinkingLevel: "high" });
		await run();
		await run({ model: "acme/large" });
		expect(starts).toEqual([{ model: "acme/large", thinkingLevel: "high" }]);
		expect(seen).toEqual([
			{ model: "acme/large", thinkingLevel: "high" },
			{},
			{ model: "acme/large" },
		]);
	});

	it("opens a session on the operator's MODEL where no model was chosen, as each such turn runs it", async () => {
		let { starts, seen, run } = await choosingSession({ model: "acme/small" });
		await run();
		await run({ model: "acme/large", thinkingLevel: "high" });
		expect(starts).toEqual([{ model: "acme/small" }]);
		expect(seen).toEqual([{ model: "acme/small" }, { model: "acme/large", thinkingLevel: "high" }]);
	});

	it("carries a message's images and files to a client that offered attachments, and as words to one that did not", async () => {
		let png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		let notes = new TextEncoder().encode("# Notes\n");
		let files = {
			readsImages: true,
			attachments: [
				{ name: "shot.png", kind: "image" as const, mimeType: "image/png", bytes: png },
				{ name: "notes.md", kind: "file" as const, mimeType: "text/plain", bytes: notes },
			],
		};
		for (let offered of [true, false]) {
			let f = await hostInputRoom();
			cleanups.push(f.close);
			let linked = await linkAuth(f.room.id);
			let server = linkServer(linked.auth, 300);
			cleanups.push(server.stop);
			let seen: Array<{ prompt: string; attachments?: unknown }> = [];
			let client = await connectAgent({
				url: server.url,
				token: MEMBER_TOKEN,
				document: f.room.id,
				resumable: false,
				attachments: offered,
				handlers: {
					async turn(context) {
						seen.push({
							prompt: context.message.prompt,
							...(context.message.attachments ? { attachments: context.message.attachments } : {}),
						});
						finishTurn(context);
					},
				},
			});
			cleanups.push(() => client.detach());
			expect(client.features.includes("attachments")).toBe(offered);
			let agent = createPlannerAgent(
				createRemoteAdapter(sessionId => ({
					link: server.links.at(-1)!,
					planner: remotePlanner(sessionId)!,
				})),
			);
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
				agent,
			});
			if (!opened.ok) throw new Error("Planner unavailable");
			let session = opened.value;
			cleanups.push(() => session.destroy());
			let run = async (sent?: typeof files) => {
				let result = await session.stream(
					"@ana: What is this?",
					new AbortController().signal,
					undefined,
					sent,
				);
				for await (let _part of result.fullStream);
			};
			await run(files);
			await run();
			if (offered) {
				expect(seen[0]!.prompt).toBe("@ana: What is this?");
				expect(seen[0]!.attachments).toEqual([
					{
						id: expect.any(String),
						name: "shot.png",
						kind: "image",
						mediaType: "image/png",
						size: png.byteLength,
						data: Buffer.from(png).toString("base64"),
					},
					{
						id: expect.any(String),
						name: "notes.md",
						kind: "file",
						mediaType: "text/plain",
						size: notes.byteLength,
						data: Buffer.from(notes).toString("base64"),
					},
				]);
			} else {
				// Nothing a client did not ask for reaches it: its files are in the prompt, as words.
				expect(seen[0]).not.toHaveProperty("attachments");
				expect(seen[0]!.prompt).toBe(
					"@ana: What is this?\n\n(An image, shot.png, was sent with this message, but this client can't be given images.)\n\n"
						+ '<file name="notes.md">\n# Notes\n\n</file>',
				);
			}
			// A turn with no files is the turn it always was.
			expect(seen[1]).toEqual({ prompt: "@ana: What is this?" });
		}
	});

	it("is a protocol violation from a client that did not offer the feature", async () => {
		let { server, channel } = await setup();
		for (let header of [undefined, "steer-turn"]) {
			let raw = await rawLink(server.url, undefined, header);
			raw.send({ type: "attach", version: 1, document: channel.id });
			await raw.next("attached");
			raw.send({ type: "capabilities", catalog });
			expect(await raw.next("error")).toMatchObject({ code: "protocol" });
			expect((await raw.closed).code).toBe(LINK_CLOSE.malformed);
		}
	});

	it("takes a catalog with odd entries as written and keeps the link, so one model cannot take the Planner offline", async () => {
		let { server, channel } = await setup();
		let raw = await rawLink(server.url, undefined, "capability-catalog");
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let link = server.links.at(-1)!;
		let odd = {
			models: {
				available: [
					{ id: "usable", name: "Usable" },
					{
						id: `acme/${"x".repeat(300)}`,
						name: "n".repeat(129),
						description: "d".repeat(4_001),
						thinkingLevels: ["extra high", "deep thought", "\u4f4e"],
					},
				],
			},
			commands: [{ name: "x", kind: "slash command" }],
		};
		raw.send({ type: "capabilities", catalog: odd });
		await until(() => link.catalog !== undefined, 1_000);
		expect(link.catalog).toEqual(odd);
		// Still attached: the next report is read, and a detach ends it as the client chose.
		raw.send({ type: "capabilities", catalog: catalog });
		await until(() => link.catalog?.models?.available.length === 2, 1_000);
		raw.send({ type: "detach" });
		expect((await raw.closed).code).toBe(LINK_CLOSE.detached);
	});

	it("skips a model reported with no id and an empty level, keeps the rest and the link, and says so in the log", async () => {
		let { server, channel } = await setup();
		let raw = await rawLink(server.url, undefined, "capability-catalog");
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let link = server.links.at(-1)!;
		let warned: string[] = [];
		let warn = spyOn(console, "warn").mockImplementation((...line) => {
			warned.push(line.join(" "));
		});
		cleanups.push(() => warn.mockRestore());
		raw.send({
			type: "capabilities",
			catalog: {
				models: {
					available: [
						{ id: "", name: "Blank", thinkingLevels: [""] },
						{ id: "valid", name: "Valid", thinkingLevels: ["", "low", "high"] },
						{ id: "other", name: "Other", description: "Plain." },
					],
					default: { id: "valid", thinkingLevel: "" },
				},
				commands: [{ name: "notes", kind: "skill" }],
			},
		});
		await until(() => link.catalog !== undefined, 1_000);
		// Only the malformed entry and the empty level are left out: the siblings stay, in order.
		expect(link.catalog).toEqual({
			models: {
				available: [
					{ id: "valid", name: "Valid", thinkingLevels: ["low", "high"] },
					{ id: "other", name: "Other", description: "Plain." },
				],
				default: { id: "valid" },
			},
			commands: [{ name: "notes", kind: "skill" }],
		});
		expect(warned.join("\n")).toContain('the model named "Blank" has no id');
		expect(warned.join("\n")).toContain("valid lists an empty thinking level");
		// So the room is offered neither, and a choice of either is refused as one nobody can make.
		let offered = remoteCatalog(link.catalog, undefined);
		expect(offered?.models.map(model => model.id)).toEqual(["valid", "other"]);
		expect(refusedChoice(offered, { model: "" })).toBe("That model isn't available.");
		expect(refusedChoice(offered, { model: "valid", thinkingLevel: "" })).toBe(
			"That model doesn't offer that level of reasoning.",
		);
		// The link is still attached: a report of nothing but a malformed model offers no choice at all.
		raw.send({
			type: "capabilities",
			catalog: { models: { available: [{ id: "", name: "Only" }] } },
		});
		await until(() => link.catalog?.models?.available.length === 0, 1_000);
		expect(remoteCatalog(link.catalog, undefined)).toBeUndefined();
		raw.send({ type: "detach" });
		expect((await raw.closed).code).toBe(LINK_CLOSE.detached);
	});

	it("closes the link on a catalog of the wrong type, and keeps the last good one before it", async () => {
		let { server, channel } = await setup();
		let raw = await rawLink(server.url, undefined, "capability-catalog");
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let link = server.links.at(-1)!;
		raw.send({ type: "capabilities", catalog });
		await until(() => link.catalog !== undefined, 1_000);
		raw.send({
			type: "capabilities",
			catalog: { models: { available: [{ id: "x", name: "X", thinkingLevels: "high" }] } },
		});
		expect(await raw.next("error")).toMatchObject({ code: "malformed-message" });
		expect((await raw.closed).code).toBe(LINK_CLOSE.malformed);
		expect(link.catalog).toEqual(catalog);
	});

	it("carries a person's model and level in the next turn only to a client that offered the feature", async () => {
		let { server, channel } = await setup();
		for (
			let [header, sent] of [
				[undefined, false],
				["steer-turn", false],
				["capability-catalog", true],
			] as const
		) {
			let raw = await rawLink(server.url, undefined, header);
			raw.send({ type: "attach", version: 1, document: channel.id });
			await raw.next("attached");
			let planner: RemotePlanner = { channelId: channel.id, isolated: false };
			let opening = adapterFor(server, planner).doStart({
				sessionId: `chosen-${header}`,
				sandboxSession,
				sessionWorkDir: "/tmp",
			});
			let start = await raw.next("start");
			raw.send({ type: "started", session: start.session });
			let opened = await opening;
			cleanups.push(() => opened.doDestroy());
			let turns: unknown[] = [];
			let running = opened.doPromptTurn({
				prompt: "go",
				skills: [],
				tools: [],
				model: "acme/large",
				thinkingLevel: "high",
				emit: part => turns.push(part),
			} as PlannerTurn);
			let turn = await raw.next("turn");
			expect(turn.model).toBe("acme/large");
			expect("thinkingLevel" in turn).toBe(sent);
			if (sent) expect(turn.thinkingLevel).toBe("high");
			raw.send({ type: "turn-end", session: turn.session, turn: turn.turn, status: "finished" });
			await (await running).done.then(() => {}, () => {});
			raw.send({ type: "detach" });
			await raw.closed;
		}
	});

	it("tells a client that offered session-choice the document's choice when it asks for a session", async () => {
		let { server, channel } = await setup();
		for (
			let [header, told] of [
				["capability-catalog", false],
				["session-choice", false],
				["capability-catalog, session-choice", true],
			] as const
		) {
			let raw = await rawLink(server.url, undefined, header);
			raw.send({ type: "attach", version: 1, document: channel.id });
			await raw.next("attached");
			let planner: RemotePlanner = {
				channelId: channel.id,
				isolated: false,
				choice: { model: "acme/large", thinkingLevel: "high" },
			};
			let opening = adapterFor(server, planner).doStart({
				sessionId: `session-choice-${header}`,
				sandboxSession,
				sessionWorkDir: "/tmp",
			});
			let start = await raw.next("start");
			if (told) expect(start).toMatchObject({ model: "acme/large", thinkingLevel: "high" });
			else {
				expect("model" in start).toBe(false);
				expect("thinkingLevel" in start).toBe(false);
			}
			raw.send({ type: "started", session: start.session });
			let opened = await opening;
			cleanups.push(() => opened.doDestroy());
			raw.send({ type: "detach" });
			await raw.closed;
		}
	});

	it("opens a session on the stored choice when the client reports its catalog only after opening began", async () => {
		let { server, channel } = await setup();
		let raw = await rawLink(server.url, undefined, "capability-catalog, session-choice");
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let deps = {
			catalog: (id: string) => plannerCatalog("remote", id, undefined),
			known: (id: string) => plannerOfferKnown("remote", id),
			offered: (id: string) => plannerOffered("remote", id, 4_000),
			storage: {
				plannerModelChoices: {
					get: async (channelId: string) => ({
						channelId,
						model: "acme/large",
						modelName: "Large",
						thinkingLevel: "high",
						userId: "U_test",
						updatedAt: new Date(),
					}),
				},
			} as never,
			lease: () => {
				throw new Error("nothing is stored here");
			},
		};
		let opening = sessionModel(deps, channel.id).then(choice =>
			adapterFor(server, { channelId: channel.id, isolated: false, choice }).doStart({
				sessionId: "opens-before-report",
				sandboxSession,
				sessionWorkDir: "/tmp",
			})
		);
		await Bun.sleep(50);
		expect(raw.messages.some(message => message.type === "start")).toBe(false);
		raw.send({ type: "capabilities", catalog });
		let start = await raw.next("start");
		expect(start).toMatchObject({ model: "acme/large", thinkingLevel: "high" });
		raw.send({ type: "started", session: start.session });
		let opened = await opening;
		cleanups.push(() => opened.doDestroy());
		raw.send({ type: "detach" });
		await raw.closed;
	});

	it("says a client's offer is settled once it reports, or once its link ends", async () => {
		let { server, channel } = await setup();
		let raw = await rawLink(server.url, undefined, "capability-catalog");
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let link = server.links.at(-1)!;
		let settled = false;
		void link.offered.then(() => settled = true);
		await Bun.sleep(20);
		expect(settled).toBe(false);
		raw.send({ type: "capabilities", catalog });
		await until(() => settled, 1_000);
		raw.send({ type: "detach" });
		await raw.closed;

		let gone = await rawLink(server.url, undefined, "capability-catalog");
		gone.send({ type: "attach", version: 1, document: channel.id });
		await gone.next("attached");
		let ended = server.links.at(-1)!;
		let waited = ended.offered;
		gone.send({ type: "detach" });
		await gone.closed;
		await waited;
	});
});

describe("Agent connection questions", () => {
	async function questions(options: { isolated?: boolean } = {}) {
		let f = await hostInputRoom();
		cleanups.push(f.close);
		let { server, channel, client } = await setup({});
		let planner: RemotePlanner = { channelId: channel.id, isolated: options.isolated ?? false };
		if (!options.isolated) {
			planner.humanInput = report => createHumanInput(f.room, report);
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
				{ label: " Postgres ", description: "  durable  ", preview: "create table" },
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

	it("places a question that names its block beside that block, linked to it", async () => {
		let { f, client, sessionId } = await questions();
		let edited = Edit.apply(f.plan, f.plan.revision, [{
			op: "replace_root",
			source: "# Existing document\n\nStorage section.\n\nDeployment section.\n",
		}]);
		if (!edited.ok) throw new Error("fixture edit failed");
		if (edited.mutation) await Plan.publish(f.plan, f.server, f.room.id, edited.mutation);
		let asked = client.ask(sessionId, { method: "questionnaire", params }, {
			block: { index: 1, digest: Room.digests(f.plan.document)[1]! },
		});
		let [card] = await f.cards(1);
		let source = Plan.source(f.plan);
		expect(source.indexOf("Storage section.")).toBeLessThan(source.indexOf("<Questionnaire"));
		expect(source.indexOf("<Questionnaire")).toBeLessThan(source.indexOf("Deployment section."));
		let record = f.plan.records.get(card!.id)!;
		expect(record.anchors?.questions[record.definition.questions[0]!.id]?.anchors).toHaveLength(1);
		await f.answer(card!.id, [1]);
		expect(await asked).toMatchObject({ status: "answered" });
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

	it("detaches the waiter and keeps a question open past half an hour when the link detaches", async () => {
		let { f, client, sessionId } = await questions();
		let clock = laterTimers();
		try {
			void client.ask(sessionId, { method: "confirm", title: "Ship?", message: "Now." })
				.catch(() => {});
			let [card] = await f.cards(1);
			await clock.pass(31 * 60 * 1_000);
			expect(f.plan.records.get(card!.id)?.status).toBe("open");
			await client.detach();
			await until(() => Store.get(f.plan.questions, card!.id)?.awaited === undefined, 2_000);
			expect(f.plan.records.get(card!.id)).toMatchObject({ status: "open" });
			expect(Plan.source(f.plan)).toContain(card!.id);
			expect(plannerToActOn(
				f.plan.records.get(card!.id)!,
				Store.get(f.plan.questions, card!.id)!,
			)).toBe(true);
		} finally {
			clock.restore();
		}
	});

	it("withdraws the card on explicit client cancel, and detaches the waiter when the session ends", async () => {
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
		expect(f.plan.records.get(second!.id)).toMatchObject({ status: "open" });
		expect(Store.get(f.plan.questions, second!.id)?.awaited).toBeUndefined();
		expect(plannerToActOn(
			f.plan.records.get(second!.id)!,
			Store.get(f.plan.questions, second!.id)!,
		)).toBe(true);
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
			humanInput: report => createHumanInput(f.room, report),
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
			humanInput: report => createHumanInput(f.room, report),
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
		let disconnected = ["Error: The machine disconnected during the turn."];
		expect(await askingTurn("detach")).toEqual(disconnected);
		expect(await askingTurn("violation")).toEqual(disconnected);
	});

	it("stops a host ask and withdraws its Decision when its turn ends before the tool does", async () => {
		expect(await askingTurn("turn-end")).toEqual(["Error: The client gave up."]);
		await askingTurn("destroy");
	});
});

describe("Agent connection background workers", () => {
	it("runs a document's research worker in its attached client as an isolated session", async () => {
		let starts: string[] = [];
		let turns: TurnContext["message"][] = [];
		let searched: unknown[] = [];
		let { channel } = await setup({
			start: message => void starts.push(message.mode),
			async turn(context) {
				turns.push(context.message);
				context.emit({ type: "stream-start", modelId: "scripted" });
				let search = await context.callHostTool("web_search", { query: "axum rate limiting" });
				let evidence = {
					findings: [`Searched: ${String(search.output)}`],
					sources: [{ title: "tower-governor", url: "https://docs.rs/tower_governor" }],
				};
				context.emit({ type: "text-start", id: "result" });
				context.emit({ type: "text-delta", id: "result", delta: JSON.stringify(evidence) });
				context.emit({ type: "text-end", id: "result" });
				finishTurn(context);
			},
		});
		let agent = createResearchAgent(createRemoteAdapter());
		let worker = await openWorkerSession(agent, {
			channelId: channel.id,
			token: () => MEMBER_TOKEN,
			maxAiCredits: 1,
			aborted: new Promise<never>(() => {}),
			openSandbox: async () => sandboxSession,
		});
		cleanups.push(() => worker.close());

		let result = await agent.generate({
			session: worker.session,
			prompt: JSON.stringify({ material: { query: "axum rate limiting" } }),
			options: {
				model: "",
				instructions: "Research only public web evidence.",
				webSearch: tool({
					inputSchema: z.object({ query: z.string() }),
					execute: async input => {
						searched.push(input);
						return "results";
					},
				}),
			},
		});

		expect(starts).toEqual(["isolated"]);
		expect(turns.map(turn => turn.tools.map(spec => spec.name))).toEqual([["web_search"]]);
		expect(turns[0]!.responseFormat?.type).toBe("json");
		expect(searched).toEqual([{ query: "axum rate limiting" }]);
		expect(result.output).toEqual({
			findings: ["Searched: results"],
			sources: [{ title: "tower-governor", url: "https://docs.rs/tower_governor" }],
		});
	});

	it("refuses a worker for a document with no attached Planner", async () => {
		let { channel } = await setup();
		let agent = createResearchAgent(createRemoteAdapter());
		await expect(openWorkerSession(agent, {
			channelId: channel.id,
			token: () => MEMBER_TOKEN,
			maxAiCredits: 1,
			aborted: new Promise<never>(() => {}),
			openSandbox: async () => sandboxSession,
		})).rejects.toThrow("No machine is connected to this document.");
	});
});

describe("Agent connection AI launches", () => {
	/** Launches as Chopin would hand them out, each with its own stand-in, recorded. */
	function launches() {
		let asked: Array<{ userId: string; machineId?: string; channelId: string; sessionId: string }> =
			[];
		let ended: string[] = [];
		let listeners = new Set<(userId: string) => void>();
		let ai: AgentAi = {
			async launch(input) {
				asked.push(input);
				let n = asked.length;
				return {
					launchId: `launch-${n}`,
					grants: {
						launch: `chopin_launch_${n}`,
						expiresAt: Date.now() + 60 * 60_000,
						providers: [{
							provider: "anthropic",
							baseUrl: "https://chopin.test/api/v1/ai/anthropic",
							placeholder: `chopin_ai_${n}`,
							keyVariable: "ANTHROPIC_API_KEY",
						}],
						withheld: [],
					},
				};
			},
			end: launchId => void ended.push(launchId),
			onChanged(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		let changed = (userId: string) => {
			for (let listener of listeners) listener(userId);
		};
		return { ai, asked, ended, changed, listeners };
	}

	async function opened(header: string | undefined) {
		let { auth, channel } = await linkAuth();
		let made = launches();
		let server = linkServer(auth, 2_000, undefined, 2_000, undefined, undefined, { ai: made.ai });
		cleanups.push(server.stop);
		let raw = await rawLink(server.url, undefined, header);
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let opening = adapterFor(server, { channelId: channel.id, isolated: false }).doStart({
			sessionId: `ai-${header}`,
			sandboxSession,
			sessionWorkDir: "/tmp",
		});
		let start = await raw.next("start");
		raw.send({ type: "started", session: start.session });
		let session = await opening;
		return { ...made, raw, start, session, channel };
	}

	it("hands a client that offered ai-credentials a launch for its account on start, and new grants when they change", async () => {
		let { raw, start, session, channel, asked, ended, changed, listeners } = await opened(
			"ai-credentials",
		);
		expect(asked).toEqual([{
			userId: "U_member",
			channelId: channel.id,
			sessionId: start.session,
		}]);
		expect(start.ai).toEqual({
			launch: "chopin_launch_1",
			expiresAt: expect.any(Number),
			providers: [{
				provider: "anthropic",
				baseUrl: "https://chopin.test/api/v1/ai/anthropic",
				placeholder: "chopin_ai_1",
				keyVariable: "ANTHROPIC_API_KEY",
			}],
			withheld: [],
		});
		// Someone else's credentials changing changes nothing here.
		changed("U_rival");
		await Bun.sleep(30);
		expect(asked).toHaveLength(1);
		changed("U_member");
		let renewed = await raw.next("ai");
		expect(renewed).toMatchObject({
			session: start.session,
			ai: { launch: "chopin_launch_2", providers: [{ placeholder: "chopin_ai_2" }] },
		});
		// The launch it replaced stays live a while, for what the client sent on it before it read the new one.
		await Bun.sleep(50);
		expect(ended).toEqual([]);
		await session.doDestroy();
		await raw.next("destroy");
		expect(ended).toEqual(["launch-2", "launch-1"]);
		expect(listeners.size).toBe(0);
		raw.send({ type: "detach" });
		await raw.closed;
	});

	it("holds a launch a renewal replaced until its grace ends, then ends it", async () => {
		let { raw, ended, changed } = await opened("ai-credentials");
		let realTimeout = globalThis.setTimeout;
		let graced: Array<{ ms: number; run: () => void }> = [];
		globalThis.setTimeout = ((run: () => void, ms?: number) => {
			if (ms === REPLACED_LAUNCH_GRACE_MS) {
				graced.push({ ms, run });
				return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
			}
			return realTimeout(run, ms);
		}) as typeof setTimeout;
		try {
			changed("U_member");
			await raw.next("ai");
			await until(() => graced.length === 1, 1_000);
		} finally {
			globalThis.setTimeout = realTimeout;
		}
		expect(ended).toEqual([]);
		graced[0]!.run();
		expect(ended).toEqual(["launch-1"]);
		raw.send({ type: "detach" });
		await raw.closed;
		await until(() => ended.length === 2, 1_000);
		expect(ended).toEqual(["launch-1", "launch-2"]);
	});

	it("ends a session's launch when its link closes for good", async () => {
		let { raw, ended } = await opened("ai-credentials");
		raw.send({ type: "detach" });
		await raw.closed;
		await until(() => ended.length === 1, 1_000);
		expect(ended).toEqual(["launch-1"]);
	});

	it("ends a launch prepared for a session whose link closed while it was being prepared, and sends it nowhere", async () => {
		let { auth, channel } = await linkAuth();
		let made = launches();
		let preparing = Promise.withResolvers<void>();
		let prepared = Promise.withResolvers<void>();
		let launch = made.ai.launch;
		made.ai.launch = async input => {
			preparing.resolve();
			await prepared.promise;
			return launch(input);
		};
		let server = linkServer(auth, 2_000, undefined, 2_000, undefined, undefined, { ai: made.ai });
		cleanups.push(server.stop);
		let raw = await rawLink(server.url, undefined, "ai-credentials");
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let opening = adapterFor(server, { channelId: channel.id, isolated: false }).doStart({
			sessionId: "ai-closed-while-preparing",
			sandboxSession,
			sessionWorkDir: "/tmp",
		});
		let failed = opening.then(() => undefined, (error: unknown) => error);
		await preparing.promise;
		raw.send({ type: "detach" });
		await raw.closed;
		prepared.resolve();
		expect(await failed).toBeInstanceOf(Error);
		await until(() => made.ended.length === 1, 1_000);
		expect(made.ended).toEqual(["launch-1"]);
		expect(raw.messages.some(message => message.type === "start")).toBe(false);
	});

	/** A link whose client offered `features` and attached, on launches that hand out catalog launches too. */
	async function attachedForCatalog(
		features: string,
		made = launches(),
		hooks: { catalogChanged?: AgentHooks["catalogChanged"] } = {},
	) {
		let { auth, channel } = await linkAuth();
		let catalogs: Array<{ userId: string; machineId?: string; channelId: string; linkId: string }> =
			[];
		let held: Array<[string, boolean]> = [];
		made.ai.catalog = async input => {
			catalogs.push(input);
			let n = catalogs.length;
			return {
				launchId: `catalog-${n}`,
				grants: {
					launch: `chopin_launch_catalog_${n}`,
					expiresAt: Date.now() + 60 * 60_000,
					providers: [{
						provider: "github-copilot",
						baseUrl: "https://chopin.test/api/v1/ai/github-copilot",
						placeholder: `chopin_ai_catalog_${n}`,
						keyVariable: "COPILOT_GITHUB_TOKEN",
					}],
					withheld: [],
				},
			};
		};
		made.ai.held = (launchId, holding) => void held.push([launchId, holding]);
		let server = linkServer(auth, 2_000, undefined, 2_000, undefined, undefined, {
			ai: made.ai,
			...hooks,
		});
		cleanups.push(server.stop);
		let raw = await rawLink(server.url, undefined, features);
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		return { ...made, raw, channel, catalogs, held, server, link: server.links.at(-1)! };
	}

	it("hands a client that asks the link's catalog launch, owned by the link, again when the person's credentials change, and ends it with the link", async () => {
		let { raw, channel, catalogs, held, ended, changed, listeners, asked } =
			await attachedForCatalog(
				"ai-credentials, ai-catalog",
			);
		await Bun.sleep(30);
		expect(raw.messages.filter(message => message.type === "ai-catalog")).toEqual([]);
		expect(catalogs).toEqual([]);

		raw.send({ type: "ai-catalog" });
		let first = await raw.next("ai-catalog");
		expect(first.ai).toEqual({
			launch: "chopin_launch_catalog_1",
			expiresAt: expect.any(Number),
			providers: [{
				provider: "github-copilot",
				baseUrl: "https://chopin.test/api/v1/ai/github-copilot",
				placeholder: "chopin_ai_catalog_1",
				keyVariable: "COPILOT_GITHUB_TOKEN",
			}],
			withheld: [],
		});
		expect(catalogs).toEqual([{
			userId: "U_member",
			channelId: channel.id,
			linkId: expect.any(String),
		}]);
		expect(held).toEqual([["catalog-1", true]]);
		expect(asked).toEqual([]);

		// Asking again changes nothing.
		raw.send({ type: "ai-catalog" });
		changed("U_rival");
		await Bun.sleep(30);
		expect(catalogs).toHaveLength(1);

		changed("U_member");
		let renewed = await raw.next("ai-catalog");
		expect(renewed.ai).toMatchObject({ launch: "chopin_launch_catalog_2" });
		expect(catalogs[1]!.linkId).toBe(catalogs[0]!.linkId);
		await until(() => ended.length === 1, 1_000);
		expect(ended).toEqual(["catalog-1"]);
		expect(held).toEqual([["catalog-1", true], ["catalog-2", true], ["catalog-1", false]]);

		raw.send({ type: "detach" });
		await raw.closed;
		await until(() => ended.length === 2, 1_000);
		expect(ended).toEqual(["catalog-1", "catalog-2"]);
		expect(held.at(-1)).toEqual(["catalog-2", false]);
		expect(listeners.size).toBe(0);
	});

	it("prepares the catalog launches of many documents attached at once side by side, none waiting on another", async () => {
		let { auth, channel } = await linkAuth();
		let documents = [channel.id];
		for (let index = 1; index < 10; index++) {
			let created = await auth.storage.channels.create({
				id: crypto.randomUUID(),
				repositoryId: "R_score",
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: `Created document ${index}`,
				createdBy: "U_member",
				now: new Date(),
			});
			documents.push(created.id);
		}
		let made = launches();
		let asked: string[] = [];
		let answer = Promise.withResolvers<void>();
		made.ai.catalog = async input => {
			asked.push(input.channelId);
			// Every launch waits on the one answer, as they all wait on GitHub's held question.
			await answer.promise;
			return {
				launchId: `catalog-${input.channelId}`,
				grants: { launch: "chopin_launch_catalog", providers: [], withheld: [] },
			};
		};
		let server = linkServer(auth, 2_000, undefined, 2_000, undefined, undefined, { ai: made.ai });
		cleanups.push(server.stop);
		let links = await Promise.all(documents.map(async document => {
			let raw = await rawLink(server.url, undefined, "ai-credentials, ai-catalog");
			raw.send({ type: "attach", version: 1, document });
			await raw.next("attached");
			return raw;
		}));
		for (let raw of links) raw.send({ type: "ai-catalog" });
		// Each link asked for its launch before any was handed out: none waits on another's.
		await until(() => asked.length === documents.length, 2_000);
		expect(new Set(asked)).toEqual(new Set(documents));
		expect(links.flatMap(raw => raw.messages.filter(message => message.type === "ai-catalog")))
			.toEqual([]);
		answer.resolve();
		for (let raw of links) {
			expect((await raw.next("ai-catalog")).ai).toMatchObject({ providers: [] });
		}
		for (let raw of links) raw.send({ type: "detach" });
	});

	it("tells an account with nothing to list so in an empty catalog grant, and ends one prepared while its link closed unsent", async () => {
		let refused = await attachedForCatalog("ai-credentials, ai-catalog");
		refused.ai.catalog = async () => {
			throw new AiLaunchRefused("no-ai-account", [{
				provider: "github-copilot",
				reason: "no-copilot-access",
			}]);
		};
		refused.raw.send({ type: "ai-catalog" });
		expect((await refused.raw.next("ai-catalog")).ai).toEqual({
			providers: [],
			withheld: [{ provider: "github-copilot", reason: "no-copilot-access" }],
		});
		refused.raw.send({ type: "detach" });
		await refused.raw.closed;

		let closing = await attachedForCatalog("ai-credentials, ai-catalog");
		let preparing = Promise.withResolvers<void>();
		let prepared = Promise.withResolvers<void>();
		let catalog = closing.ai.catalog!;
		closing.ai.catalog = async input => {
			preparing.resolve();
			await prepared.promise;
			return catalog(input);
		};
		closing.raw.send({ type: "ai-catalog" });
		await preparing.promise;
		closing.raw.send({ type: "detach" });
		await closing.raw.closed;
		prepared.resolve();
		await until(() => closing.ended.length === 1, 1_000);
		expect(closing.ended).toEqual(["catalog-1"]);
		expect(closing.held).toEqual([]);
		expect(closing.raw.messages.filter(message => message.type === "ai-catalog")).toEqual([]);
	});

	it("hands no catalog launch to a client that did not offer ai-catalog, or ai-credentials, and takes an ask without the feature as a protocol violation", async () => {
		let without = await attachedForCatalog("ai-credentials");
		without.raw.send({ type: "ai-catalog" });
		expect(await without.raw.next("error")).toMatchObject({ code: "protocol" });
		await without.raw.closed;
		expect(without.catalogs).toEqual([]);

		let noCredentials = await attachedForCatalog("ai-catalog");
		noCredentials.raw.send({ type: "ai-catalog" });
		await Bun.sleep(50);
		expect(noCredentials.raw.messages.filter(message => message.type === "ai-catalog")).toEqual([]);
		expect(noCredentials.catalogs).toEqual([]);
		noCredentials.raw.send({ type: "detach" });
		await noCredentials.raw.closed;
	});

	/** What the old account's Copilot offers, and what the token connected in its place offers. */
	const OLD = {
		models: { available: [{ id: "github-copilot/gpt-old", name: "GPT Old" }] },
		commands: [{ name: "release-notes", kind: "skill" }],
	};
	const NEW = {
		models: { available: [{ id: "github-copilot/gemini-4-neon", name: "Gemini 4 Neon" }] },
		commands: [{ name: "release-notes", kind: "skill" }],
	};

	it("counts a report only through a catalog launch of the person's accounts as they are now, with catalog-launches", async () => {
		let told: unknown[] = [];
		let { raw, link, changed, ai } = await attachedForCatalog(
			"capability-catalog, ai-credentials, ai-catalog, catalog-launches",
			launches(),
			{ catalogChanged: (_id, reported) => void told.push(reported.catalog) },
		);
		// A list told on attach names no launch: kept from accounts nobody can name now.
		raw.send({ type: "capabilities", catalog: OLD });
		raw.send({ type: "ai-catalog" });
		let first = await raw.next("ai-catalog");
		expect(first.catalogLaunch).toEqual(expect.any(String));
		expect(link.catalog).toBeUndefined();
		expect(link.catalogPending).toBe(true);
		raw.send({ type: "capabilities", catalog: OLD, catalogLaunch: first.catalogLaunch });
		await until(() => link.catalog !== undefined, 1_000);
		expect(link.catalog).toEqual(OLD);
		expect(link.catalogPending).toBe(false);

		// Someone else's accounts changing changes nothing here.
		changed("U_rival");
		expect(link.catalog).toEqual(OLD);

		// The person connects a token of another account: the next launch waits, so the old one's
		// report can arrive before it is handed.
		let preparing = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let catalog = ai.catalog!;
		ai.catalog = async input => {
			preparing.resolve();
			await release.promise;
			return catalog(input);
		};
		changed("U_member");
		// At once, before any new launch is handed: the old list is no longer what the client offers.
		expect(link.catalog).toBeUndefined();
		expect(link.catalogPending).toBe(true);
		// It names its launches, so it lists them again through the new one: it is waited for.
		expect(link.outdated).toBe(false);
		expect(told).toEqual([OLD, undefined]);
		// Its commands are the client's own, and stay.
		expect(link.lastReport).toEqual(OLD);
		let offered = false;
		void link.offered.then(() => offered = true);
		await preparing.promise;
		raw.send({ type: "capabilities", catalog: OLD, catalogLaunch: first.catalogLaunch });
		raw.send({ type: "capabilities", catalog: OLD });
		await Bun.sleep(50);
		expect(link.catalog).toBeUndefined();
		expect(offered).toBe(false);

		release.resolve();
		let second = await raw.next("ai-catalog");
		expect(second.catalogLaunch).toEqual(expect.any(String));
		expect(second.catalogLaunch).not.toBe(first.catalogLaunch);
		// A computation through the old launch that ends late still counts for nobody.
		raw.send({ type: "capabilities", catalog: OLD, catalogLaunch: first.catalogLaunch });
		raw.send({ type: "capabilities", catalog: NEW, catalogLaunch: second.catalogLaunch });
		await until(() => link.catalog !== undefined, 1_000);
		expect(link.catalog).toEqual(NEW);
		expect(offered).toBe(true);
		expect(told).toEqual([OLD, undefined, NEW]);
		raw.send({ type: "capabilities", catalog: OLD, catalogLaunch: first.catalogLaunch });
		await Bun.sleep(50);
		expect(link.catalog).toEqual(NEW);
		raw.send({ type: "detach" });
		await raw.closed;
	});

	it("counts a report of a client that names no launch only while the latest catalog launch handed is for the person's accounts as they are now", async () => {
		let { raw, link, changed, ai } = await attachedForCatalog(
			"capability-catalog, ai-credentials, ai-catalog",
		);
		// Before any launch is handed, a report can only be a list kept from earlier accounts.
		raw.send({ type: "capabilities", catalog: OLD });
		raw.send({ type: "ai-catalog" });
		let first = await raw.next("ai-catalog");
		expect("catalogLaunch" in first).toBe(false);
		expect(link.catalog).toBeUndefined();
		raw.send({ type: "capabilities", catalog: OLD });
		await until(() => link.catalog !== undefined, 1_000);
		expect(link.catalog).toEqual(OLD);

		let preparing = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let catalog = ai.catalog!;
		ai.catalog = async input => {
			preparing.resolve();
			await release.promise;
			return catalog(input);
		};
		changed("U_member");
		expect(link.catalog).toBeUndefined();
		// It may never report again: Chopin says it needs an update, and nothing waits for it.
		expect(link.outdated).toBe(true);
		expect(link.catalogPending).toBe(true);
		expect(await Promise.race([link.offered.then(() => true), Bun.sleep(50).then(() => false)]))
			.toBe(true);
		// A turn that ran without its models leaves them unknown, so the room is still told why.
		link.settleWithoutCatalog();
		expect(link.catalogPending).toBe(true);
		await preparing.promise;
		// Between the change and the launch for the new accounts, nothing counts.
		raw.send({ type: "capabilities", catalog: OLD });
		await Bun.sleep(50);
		expect(link.catalog).toBeUndefined();
		release.resolve();
		await raw.next("ai-catalog");
		raw.send({ type: "capabilities", catalog: NEW });
		await until(() => link.catalog !== undefined, 1_000);
		expect(link.catalog).toEqual(NEW);
		expect(link.outdated).toBe(false);
		expect(link.catalogPending).toBe(false);

		// Naming a launch is the feature's alone.
		raw.send({ type: "capabilities", catalog: NEW, catalogLaunch: "c-1" });
		expect(await raw.next("error")).toMatchObject({ code: "protocol" });
		await raw.closed;
	});

	it("names even an empty catalog grant, and counts the report that answers it", async () => {
		let { raw, link, ai } = await attachedForCatalog(
			"capability-catalog, ai-credentials, ai-catalog, catalog-launches",
		);
		ai.catalog = async () => {
			throw new AiLaunchRefused("no-ai-account", []);
		};
		raw.send({ type: "ai-catalog" });
		let empty = await raw.next("ai-catalog");
		expect(empty.ai).toEqual({ providers: [], withheld: [] });
		expect(empty.catalogLaunch).toEqual(expect.any(String));
		raw.send({ type: "capabilities", catalog: {}, catalogLaunch: empty.catalogLaunch });
		await until(() => link.catalog !== undefined, 1_000);
		expect(link.catalog).toEqual({});
		expect(link.catalogPending).toBe(false);
		raw.send({ type: "detach" });
		await raw.closed;
	});

	it("leaves a client that did not offer ai-credentials as it was: no launch, and no grants", async () => {
		for (let header of [undefined, "capability-catalog"]) {
			let { raw, start, session, asked, changed } = await opened(header);
			expect("ai" in start).toBe(false);
			changed("U_member");
			await Bun.sleep(30);
			expect(asked).toEqual([]);
			await session.doDestroy();
			raw.send({ type: "detach" });
			await raw.closed;
		}
	});
});

/** The providers a launch's grants name, in order. */
function providers(grants: { providers: Array<{ provider: string }> }) {
	return grants.providers.map(grant => grant.provider);
}

describe("Agent connection AI launches on the person's accounts in Chopin", () => {
	/**
	 * The member's AI accounts as Chopin keeps them, launched for sessions as `main.ts` launches
	 * them, with GitHub answering their Copilot access as `copilot` says and a provider standing in
	 * for OpenAI that answers each model request as `answer` says.
	 */
	async function accounts(storage: Parameters<typeof testLease>[0]) {
		let lease = await testLease(storage);
		let state = {
			copilot: "none" as "access" | "none" | "unreachable",
			answer: "ok" as "ok" | "invalid" | "throttled",
		};
		/** The requests that reached the provider standing in for OpenAI, by method and path. */
		let reached: string[] = [];
		let openai = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				reached.push(`${request.method} ${new URL(request.url).pathname}`);
				if (new URL(request.url).pathname === "/api.json") return Response.json({});
				if (new URL(request.url).pathname === "/v1/models") return Response.json({ data: [] });
				if (state.answer === "invalid") {
					return Response.json({ error: { code: "invalid_api_key" } }, { status: 401 });
				}
				if (state.answer === "throttled") return Response.json({}, { status: 429 });
				return Response.json({ choices: [] });
			},
		});
		cleanups.push(() => openai.stop(true));
		let upstream = `http://127.0.0.1:${openai.port}`;
		let credentials = new AiCredentials({
			storage,
			lease: () => lease,
			key: new Uint8Array(32).fill(3),
			origin: "https://chopin.test",
			githubToken: async () => "ghu_member",
			copilotToken: async () => {
				if (state.copilot === "unreachable") throw new Error("GitHub answered 502");
				return state.copilot === "access"
					? { token: "tid=member", expiresAt: Date.now() + 1_800_000 }
					: undefined;
			},
			upstreams: { openai: upstream },
			// A link's catalog launch is owned while a link of this process holds it, as in main.ts.
			ownerLive: ({ launchId, owner }) => !catalogOnly(owner) || held.has(launchId),
		});
		let held = new Set<string>();
		let ai: AgentAi = {
			launch: ({ sessionId, ...input }) =>
				handOut(credentials, {
					...input,
					owner: `session:${sessionId}`,
					expiresAt: new Date(Date.now() + PLANNER_AI_LAUNCH_MS),
				}),
			catalog: ({ linkId, ...input }) =>
				handOut(credentials, {
					...input,
					owner: `link:${linkId}`,
					expiresAt: new Date(Date.now() + PLANNER_AI_LAUNCH_MS),
				}),
			end: launchId => endLaunch(credentials, launchId),
			onChanged: listener => credentials.onChanged(listener),
			held: (launchId, holding) => void (holding ? held.add(launchId) : held.delete(launchId)),
		};
		let proxy = aiProxy({ credentials, upstreams: { openai: upstream, catalog: upstream } });
		return { credentials, state, ai, held, proxy, reached };
	}

	/** Opens a session on a raw link offering `features`, for the planner given. */
	async function starting(
		features: string | undefined,
		prepare?: (made: Awaited<ReturnType<typeof accounts>>) => Promise<void>,
		planner: Partial<RemotePlanner> = {},
	) {
		let { auth, channel, storage } = await linkAuth();
		let made = await accounts(storage);
		await prepare?.(made);
		let server = linkServer(auth, 2_000, undefined, 2_000, undefined, undefined, { ai: made.ai });
		cleanups.push(server.stop);
		let raw = await rawLink(server.url, undefined, features);
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let opening = adapterFor(server, { channelId: channel.id, isolated: false, ...planner })
			.doStart(
				{ sessionId: crypto.randomUUID(), sandboxSession, sessionWorkDir: "/tmp" },
			);
		return { ...made, raw, opening, channel, storage };
	}

	it("hands a client that asks a catalog launch of its account that lists its models through Chopin's proxy and runs none, and ends it with the link", async () => {
		let { auth, channel, storage } = await linkAuth();
		let made = await accounts(storage);
		await made.credentials.connect("U_member", "openai", {
			kind: "api-key",
			secret: "sk-member-openai-0123456789",
		});
		let server = linkServer(auth, 2_000, undefined, 2_000, undefined, undefined, { ai: made.ai });
		cleanups.push(server.stop);
		let raw = await rawLink(server.url, undefined, "ai-credentials, ai-catalog");
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		raw.send({ type: "ai-catalog" });
		let { ai } = await raw.next("ai-catalog");
		expect(providers(ai)).toEqual(["openai"]);
		let grant = ai.providers[0];
		let ask = (method: string, path: string) => {
			let url = new URL(`https://chopin.test/api/v1/ai/${path}`);
			return made.proxy(
				new Request(url, {
					method,
					headers: { authorization: `Bearer ${grant.placeholder}`, "x-chopin-launch": ai.launch },
					...(method === "POST" ? { body: "{}" } : {}),
				}),
				url,
			);
		};

		expect((await ask("GET", "openai/v1/models")).status).toBe(200);
		expect((await ask("GET", "models.dev/api.json")).status).toBe(200);
		let reached = [...made.reached];
		for (
			let [method, path] of [
				["POST", "openai/v1/chat/completions"],
				["POST", "openai/v1/responses"],
				["GET", "openai/v1/responses/resp_1"],
				["POST", "openai/v1/embeddings"],
			]
		) {
			let refused = await ask(method!, path!);
			expect(refused.status).toBe(403);
			expect((await refused.json()).error.code).toBe("catalog-only");
		}
		expect(made.reached).toEqual(reached);
		expect(reached).toContain("GET /v1/models");
		expect(reached).not.toContain("POST /v1/chat/completions");

		raw.send({ type: "detach" });
		await raw.closed;
		let after = await ask("GET", "openai/v1/models");
		expect(after.status).toBe(401);
		expect(["launch-ended", "unknown-placeholder"]).toContain((await after.json()).error.code);
		let state = new URL("https://chopin.test/api/v1/ai/launch");
		let launch = await made.proxy(
			new Request(state, { headers: { "x-chopin-launch": ai.launch } }),
			state,
		);
		expect(await launch.json()).toEqual({ state: "ended" });
		expect(made.reached).toEqual(reached);
	});

	it("starts no session, and forks none, for someone with no Copilot seat and no key, refusing it with no-ai-account", async () => {
		for (
			let [features, planner, sent] of [
				["ai-credentials", {}, "start"],
				["ai-credentials, session-forks", { forkFrom: { session: "parent" } }, "fork"],
			] as const
		) {
			let { raw, opening, state } = await starting(features, undefined, planner);
			let failed = await opening.then(() => undefined, (error: unknown) => error);
			expect(failed).toMatchObject({
				code: "no-ai-account",
				message:
					"chopin needs an AI account to answer, so it didn't start. Add one, then try again.",
			});
			expect(turnFailureOf({ error: failed, suspended: false })).toMatchObject({
				kind: "error",
				code: "no-ai-account",
			});
			await Bun.sleep(30);
			expect(raw.messages.filter(message => message.type === sent)).toEqual([]);
			expect(state.copilot).toBe("none");
			raw.send({ type: "detach" });
			await raw.closed;
		}
	});

	it("says a Copilot check that couldn't finish couldn't finish, never that there is no subscription", async () => {
		let { raw, opening } = await starting("ai-credentials", async made => {
			made.state.copilot = "unreachable";
		});
		let failed = await opening.then(() => undefined, (error: unknown) => error) as Error;
		expect(failed.message).toBe(
			"chopin couldn't finish checking your AI accounts, so it didn't start. Try again in a moment.",
		);
		expect(failed.message).not.toMatch(/subscription/i);
		expect(raw.messages.filter(message => message.type === "start")).toEqual([]);
		raw.send({ type: "detach" });
		await raw.closed;
	});

	it("starts a session on one key, and a client that did not offer ai-credentials as before", async () => {
		let withKey = await starting(
			"ai-credentials",
			made =>
				made.credentials.connect("U_member", "openai", {
					kind: "api-key",
					secret: "sk-member-openai-0123456789",
				}).then(() => {}),
		);
		let start = await withKey.raw.next("start");
		expect(start.ai.providers.map((grant: { provider: string }) => grant.provider)).toEqual([
			"openai",
		]);
		withKey.raw.send({ type: "started", session: start.session });
		await (await withKey.opening).doDestroy();

		let older = await starting(undefined);
		let plain = await older.raw.next("start");
		expect("ai" in plain).toBe(false);
		older.raw.send({ type: "started", session: plain.session });
		await (await older.opening).doDestroy();
	});

	it("takes Copilot away and back as GitHub confirms a seat lost and regained, and a key its provider refuses, but not a rate limit", async () => {
		let { raw, opening, state, credentials, proxy } = await starting(
			"ai-credentials",
			async made => {
				made.state.copilot = "access";
				await made.credentials.connect("U_member", "openai", {
					kind: "api-key",
					secret: "sk-member-openai-0123456789",
				});
			},
		);
		let start = await raw.next("start");
		raw.send({ type: "started", session: start.session });
		let session = await opening;
		expect(providers(start.ai)).toEqual(["github-copilot", "openai"]);

		state.copilot = "none";
		await credentials.check("U_member", "ghu_member");
		let lost = await raw.next("ai");
		expect(providers(lost.ai)).toEqual(["openai"]);

		state.copilot = "access";
		await credentials.check("U_member", "ghu_member");
		let back = await raw.next("ai");
		expect(providers(back.ai)).toEqual(["github-copilot", "openai"]);

		// The same answer again changes nothing.
		await credentials.check("U_member", "ghu_member");
		await Bun.sleep(50);
		expect(raw.messages.filter(message => message.type === "ai")).toEqual([]);

		let openai = back.ai.providers.find((grant: { provider: string }) =>
			grant.provider === "openai"
		);
		let ask = () => {
			let url = new URL("https://chopin.test/api/v1/ai/openai/v1/chat/completions");
			return proxy(
				new Request(url, {
					method: "POST",
					headers: {
						authorization: `Bearer ${openai.placeholder}`,
						"x-chopin-launch": back.ai.launch,
					},
					body: "{}",
				}),
				url,
			);
		};
		state.answer = "throttled";
		expect((await ask()).status).toBe(429);
		await Bun.sleep(50);
		expect(raw.messages.filter(message => message.type === "ai")).toEqual([]);

		state.answer = "invalid";
		expect((await ask()).status).toBe(401);
		let refused = await raw.next("ai");
		expect(providers(refused.ai)).toEqual(["github-copilot"]);

		await session.doDestroy();
		raw.send({ type: "detach" });
		await raw.closed;
	});

	it("hands a session the accounts as they are once it acknowledges its start, once, however often they changed while it started", async () => {
		let { auth, channel } = await linkAuth();
		let listeners = new Set<(userId: string) => void>();
		let current = ["anthropic"];
		let count = 0;
		let ai: AgentAi = {
			async launch() {
				count++;
				return {
					launchId: `launch-${count}`,
					grants: {
						launch: `chopin_launch_${count}`,
						expiresAt: Date.now() + 60 * 60_000,
						providers: current.map(provider => ({
							provider: provider as "anthropic" | "openai",
							baseUrl: `https://chopin.test/api/v1/ai/${provider}`,
							placeholder: `chopin_ai_${provider}_${count}`,
							keyVariable: "KEY",
						})),
						withheld: [],
					},
				};
			},
			end: () => {},
			onChanged(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		let changed = () => {
			for (let listener of listeners) listener("U_member");
		};
		let server = linkServer(auth, 2_000, undefined, 2_000, undefined, undefined, { ai });
		cleanups.push(server.stop);
		let raw = await rawLink(server.url, undefined, "ai-credentials");
		raw.send({ type: "attach", version: 1, document: channel.id });
		await raw.next("attached");
		let opening = adapterFor(server, { channelId: channel.id, isolated: false }).doStart({
			sessionId: "starting-while-accounts-change",
			sandboxSession,
			sessionWorkDir: "/tmp",
		});
		let start = await raw.next("start");
		current = ["anthropic", "openai"];
		changed();
		current = ["openai"];
		changed();
		await Bun.sleep(30);
		expect(raw.messages.filter(message => message.type === "ai")).toEqual([]);
		raw.send({ type: "started", session: start.session });
		let session = await opening;
		let renewed = await raw.next("ai");
		expect(renewed.ai.providers.map((grant: { provider: string }) => grant.provider)).toEqual([
			"openai",
		]);
		await Bun.sleep(50);
		expect(raw.messages.filter(message => message.type === "ai")).toEqual([]);

		// After the acknowledgement a change reaches it at once.
		current = ["anthropic"];
		changed();
		let after = await raw.next("ai");
		expect(after.ai.providers.map((grant: { provider: string }) => grant.provider)).toEqual([
			"anthropic",
		]);
		await session.doDestroy();
		raw.send({ type: "detach" });
		await raw.closed;
	});
});
