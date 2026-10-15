import { describe, expect, it } from "bun:test";
import { MemoryStorage } from "../storage/memory/adapter";
import { Router } from "../http/router";
import { AgendaService } from "./service";
import { registerAgendaRoutes } from "./routes";
import type { HostedAuth } from "../auth/routes";
import type { AuthenticatedSession } from "../auth/session";
import type { Repository } from "../github/client";
import type { ResearchWorkspaceService } from "../research/service";

async function fixture() {
	let storage = new MemoryStorage();
	let now = new Date();
	let channelId = crypto.randomUUID();
	await storage.users.put({ id: "writer", login: "writer", avatarUrl: "avatar", now });
	await storage.channels.create({
		id: channelId,
		title: "Document",
		repositoryId: "node-1",
		repositoryOwner: "owner",
		repositoryName: "repo",
		createdBy: "writer",
		now,
	});
	let lease = await storage.leases.acquire("chopin:writer", "tests", 60000);
	if (!lease) throw new Error("No lease");
	let owner = {
		userId: "writer",
		userHandle: "writer",
		sessionId: "private-session",
		generation: 1,
		credentialRevision: 1,
	};
	let session = { user: { id: "writer", login: "writer" } } as AuthenticatedSession;
	let repository = {
		id: "node-1",
		owner: "owner",
		name: "repo",
		permissions: { pull: true, push: true, admin: false },
	} as Repository;
	let authenticated = true;
	let admitted = true;
	let available = true;
	let grants = 0;
	let auth = {
		config: { origin: "https://chopin.test" },
		storage,
		sessions: {
			authenticate: async () => authenticated ? session : undefined,
			use: async (_session: AuthenticatedSession, action: (token: string) => Promise<unknown>) => ({
				value: await action("token"),
				authenticated: session,
			}),
			clearCookie: () => "session=; Max-Age=0",
		},
		admission: { allowed: async () => admitted },
		github: { repositoryAccess: async () => repository },
	} as unknown as HostedAuth;
	let service = new AgendaService({
		storage,
		research: {} as ResearchWorkspaceService,
		lease: () => lease,
		available: () => available,
		current: async () => undefined,
		resolveOwner: async () => ({
			owner,
			token: () => "token",
			signal: new AbortController().signal,
			authorize: async () => true,
			release: () => {},
		}),
		assessor: {
			generate: async () => [],
			assess: async () => ({ decision: "stop", questionId: "", reason: "No work." }),
		},
	});
	service.wake = () => {};
	let router = new Router();
	registerAgendaRoutes(router, auth, {
		service,
		authorize: async () => {
			grants++;
			return owner;
		},
	});
	return {
		service,
		channelId,
		repository,
		grants: () => grants,
		authenticated: (value: boolean) => {
			authenticated = value;
		},
		admitted: (value: boolean) => {
			admitted = value;
		},
		available: (value: boolean) => {
			available = value;
		},
		async request(method = "GET", suffix = "", body?: unknown, origin = "https://chopin.test") {
			return (await router.handle(
				new Request(`https://chopin.test/api/channels/${channelId}/research-agenda${suffix}`, {
					method,
					headers: { origin, "content-type": "application/json" },
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			))!;
		},
	};
}
const save = {
	expectedRevision: 0,
	scope: "Public examples of decision onboarding",
	questions: [],
};

describe("agenda HTTP consent boundary", () => {
	it("allows read access but requires current admission, node identity and writer role to change", async () => {
		let context = await fixture();
		context.authenticated(false);
		expect((await context.request()).status).toBe(401);
		context.authenticated(true);
		context.admitted(false);
		expect((await context.request()).status).toBe(404);
		context.admitted(true);
		context.repository.id = "recreated-repository-node";
		expect((await context.request()).status).toBe(404);
		context.repository.id = "node-1";
		context.repository.permissions.push = false;
		expect((await context.request()).status).toBe(200);
		expect((await context.request("PUT", "", save)).status).toBe(403);
	});

	it("rejects cross-origin controls and model-supplied authority fields", async () => {
		let context = await fixture();
		expect((await context.request("PUT", "", save, "https://attacker.test")).status).toBe(403);
		expect((await context.request("PUT", "", { ...save, maxSessions: 999999 })).status).toBe(400);
		expect((await context.request("PUT", "", save)).status).toBe(200);
		expect(
			(await context.request("POST", "/activate", { expectedRevision: 1, owner: "model" })).status,
		).toBe(400);
		expect(context.grants()).toBe(0);
	});

	it("never claims ownership for an unavailable activation", async () => {
		let context = await fixture();
		await context.request("PUT", "", save);
		context.available(false);
		expect((await context.request("POST", "/activate", { expectedRevision: 1 })).status).toBe(503);
		expect(context.grants()).toBe(0);
	});

	it("saves paused, requires an explicit grant, redacts owner credentials, and rejects stale controls", async () => {
		let context = await fixture();
		let saved = await context.request("PUT", "", save);
		expect(saved.headers.get("cache-control")).toBe("no-store");
		expect((await saved.json()).agenda.state).toBe("paused");
		let activated = await context.request("POST", "/activate", { expectedRevision: 1 });
		expect(activated.status).toBe(200);
		let body = await activated.text();
		expect(body).not.toContain("private-session");
		expect(body).not.toContain("credentialRevision");
		expect(JSON.parse(body).agenda.state).toBe("active");
		expect(context.grants()).toBe(1);
		expect((await context.request("POST", "/pause", { expectedGeneration: 1 })).status).toBe(409);
		expect((await context.request("POST", "/pause", { expectedGeneration: 2 })).status).toBe(200);
	});
});

it("Pause follows consent generation across harmless status revisions", async () => {
	let context = await fixture();
	await context.request("PUT", "", save);
	await context.request("POST", "/activate", { expectedRevision: 1 });
	// A normal scheduler tick changes revision and settles no-work, but does not replace the grant.
	await context.service.tick(context.channelId);
	let before = await context.service.get(context.channelId);
	expect(before!.revision).toBeGreaterThan(2);
	let response = await context.request("POST", "/pause", { expectedGeneration: 2 });
	expect(response.status).toBe(200);
	expect((await response.json()).agenda.stopReason).toBe("human-paused");
});
