import { expect, test } from "bun:test";
import { performance } from "@chopin/experiment/fixtures";
import { Admission } from "../auth/admission";
import { Sessions } from "../auth/session";
import type { GitHub } from "../github/client";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { registerExperimentRoutes } from "./routes";
import { Connections } from "./connections";

test("pairing binds the browser owner; only that owner dispatches and scoped claims publish", async () => {
	let storage = new MemoryStorage();
	let documentId = crypto.randomUUID();
	let now = new Date();
	for (let id of ["alice", "bob"]) await storage.users.put({ id, login: id, avatarUrl: "", now });
	await storage.channels.create({
		id: documentId,
		repositoryId: "repo",
		repositoryOwner: "org",
		repositoryName: "repo",
		title: "Investigate",
		createdBy: "alice",
		now,
	});
	let lease = (await storage.leases.acquire("writer", "test", 60_000))!;
	let sessions = new Sessions(storage, true);
	let grant = {
		accessToken: "token",
		accessExpiresIn: 3600,
		refreshToken: "refresh",
		refreshExpiresIn: 7200,
	};
	let alice = await sessions.issue("alice", grant);
	let bob = await sessions.issue("bob", grant);
	let github = {
		repositoryAccess: async () => ({
			id: "repo",
			permissions: { pull: true, push: true, admin: false },
		}),
	} as unknown as GitHub;
	let config = {
		origin: "https://chopin.test",
		appSlug: "test",
		clientId: "test",
		clientSecret: "secret",
		encryptionKey: new Uint8Array(32),
	};
	let router = new Router();
	registerExperimentRoutes(router, {
		storage,
		sessions,
		github,
		config,
		admission: new Admission(config, github),
		clock: () => new Date(),
	}, {
		lease: () => lease,
		changed: () => {},
		context: async () => ({ source: "# Context", revision: 0 }),
	});
	async function request(path: string, body?: unknown, cookie?: string, token?: string) {
		return (await router.handle(
			new Request(`https://chopin.test${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: {
					"content-type": "application/json",
					origin: config.origin,
					...(cookie ? { cookie: cookie.split(";")[0] } : {}),
					...(token ? { authorization: `Bearer ${token}` } : {}),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		))!;
	}
	let pair = await (await request("/api/connector/pairings", {
		repository: "org/repo",
		commit: "a".repeat(40),
		label: "Laptop",
	})).json();
	expect(
		(await request(`/api/connector/pairings/${pair.id}/claim`, { secret: "x".repeat(32) })).status,
	).toBe(403);
	expect(
		(await request(`/api/connector/pairings/${pair.id}/approve`, { documentId }, alice.cookie))
			.status,
	).toBe(200);
	let paired =
		await (await request(`/api/connector/pairings/${pair.id}/claim`, { secret: pair.secret }))
			.json();
	let id = crypto.randomUUID();
	await request(
		`/api/documents/${documentId}/experiments`,
		{ id, brief: "Measure startup" },
		bob.cookie,
	);
	let runPath = `/api/documents/${documentId}/experiments/${id}/run`;
	expect((await request(runPath, { connectionId: paired.connection.id }, bob.cookie)).status).toBe(
		403,
	);
	expect((await request(runPath, { connectionId: paired.connection.id }, alice.cookie)).status)
		.toBe(200);
	async function tool(name: string, args: unknown, token = paired.token) {
		return (await request(
			"/connector/mcp",
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
			undefined,
			token,
		)).json();
	}
	let claim = JSON.parse((await tool("claim_experiment", { id })).result.content[0].text);
	expect(claim.input.requester).toBe("bob");
	expect(claim.input.authorizer).toBe("alice");
	expect((await tool("claim_experiment", { id }, claim.runToken)).result.isError).toBe(true);
	expect(
		(await tool("submit_experiment_result", { result: performance }, claim.runToken)).result
			.isError,
	).not.toBe(true);
	expect(
		(await request(`/api/documents/${documentId}/experiments/${id}`, undefined, bob.cookie)).status,
	).toBe(200);
	let completion = await tool("complete_experiment", { id, generation: claim.generation });
	expect(completion.result.isError).not.toBe(true);
	let value =
		await (await request(`/api/documents/${documentId}/experiments/${id}`, undefined, bob.cookie))
			.json();
	expect(value.state).toBe("completed");
	expect(value.result.datasets[0].key).toBe("startup");
	expect(value.candidate).toBeUndefined();
	await sessions.revoke(
		new Request(config.origin, { headers: { cookie: alice.cookie.split(";")[0] } }),
	);
	expect(
		(await request(
			"/connector/mcp",
			{ jsonrpc: "2.0", id: 2, method: "ping" },
			undefined,
			paired.token,
		)).status,
	).toBe(401);
});

test("expired pairing and connections cannot be revived by replay", () => {
	let now = 0;
	let connections = new Connections(() => now);
	let pending = connections.create({
		repository: "org/repo",
		commit: "a".repeat(40),
		label: "Laptop",
	});
	connections.approve(pending.id, { id: "alice", login: "alice", sessionId: "s" }, "d", "repo");
	let result = connections.claim(pending.id, pending.secret);
	if (!("token" in result)) throw new Error("missing token");
	now = 91_000;
	expect(() => connections.lookup(result.token!)).toThrow("connection-unavailable");
	now = 301_000;
	expect(() => connections.claim(pending.id, pending.secret)).toThrow("pairing-expired");
});
