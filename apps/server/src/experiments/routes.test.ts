import { expect, test } from "bun:test";
import { performance } from "@chopin/experiment/fixtures";
import { Admission } from "../auth/admission";
import { Sessions } from "../auth/session";
import type { GitHub } from "../github/client";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { registerExperimentRoutes } from "./routes";
import { Connections } from "./connections";

function text(value: { result: { content: Array<{ text: string }> } }) {
	return JSON.parse(value.result.content[0].text);
}

async function setup() {
	let storage = new MemoryStorage();
	let now = new Date();
	for (let id of ["alice", "bob"]) await storage.users.put({ id, login: id, avatarUrl: "", now });
	async function document(repository = "repo") {
		let id = crypto.randomUUID();
		await storage.channels.create({
			id,
			repositoryId: repository,
			repositoryOwner: "org",
			repositoryName: repository,
			title: `Investigate ${id}`,
			createdBy: "alice",
			now,
		});
		return id;
	}
	let documentId = await document();
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
		repositoryAccess: async (_token: string, _owner: string, name: string) => ({
			id: name,
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
	async function tool(token: string, name: string, args: unknown) {
		return (await request(
			"/connector/mcp",
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
			undefined,
			token,
		)).json();
	}
	async function pair(cookie: string, repository = "org/repo") {
		let pending = await (await request("/api/connector/pairings", {
			repository,
			commit: "a".repeat(40),
			label: "Laptop",
		})).json();
		await request(`/api/connector/pairings/${pending.id}/approve`, {}, cookie);
		return {
			...pending,
			...await (await request(`/api/connector/pairings/${pending.id}/claim`, {
				secret: pending.secret,
			})).json(),
		};
	}
	return { storage, sessions, config, alice, bob, document, documentId, request, tool, pair };
}

test("work runs on the clicker's own connection; scoped claims publish", async () => {
	let { sessions, config, alice, bob, documentId, request } = await setup();
	let pair = await (await request("/api/connector/pairings", {
		repository: "org/repo",
		commit: "a".repeat(40),
		label: "Laptop",
	})).json();
	expect(
		(await request(`/api/connector/pairings/${pair.id}/claim`, { secret: "x".repeat(32) })).status,
	).toBe(403);
	let approved = await request(`/api/connector/pairings/${pair.id}/approve`, {}, alice.cookie);
	expect(approved.status).toBe(200);
	expect((await approved.json()).url).toBe("/documents/org/repo");
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
	let refused = await request(runPath, {}, bob.cookie);
	expect(refused.status).toBe(409);
	expect((await refused.json()).error).toBe("no-workspace");
	expect((await request(runPath, { connectionId: paired.connection.id }, alice.cookie)).status)
		.toBe(409);
	expect((await request(runPath, {}, alice.cookie)).status).toBe(200);
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

test("one connection serves every document in its repository and no other", async () => {
	let { alice, bob, document, documentId, request, tool, pair } = await setup();
	let second = await document();
	let elsewhere = await document("other");
	let connection = await pair(alice.cookie);
	for (let target of [documentId, second]) {
		let id = crypto.randomUUID();
		await request(`/api/documents/${target}/experiments`, { id, brief: "Measure" }, alice.cookie);
		let run = await request(`/api/documents/${target}/experiments/${id}/run`, {}, alice.cookie);
		expect((await run.json()).connectionId).toBe(connection.connection.id);
		expect(text(await tool(connection.token, "wait_for_experiment", {}))).toEqual({ id });
		let claim = text(await tool(connection.token, "claim_experiment", { id }));
		expect(claim.input.documentId).toBe(target);
		let read = text(await tool(claim.runToken, "read_experiment", {}));
		expect(read.input.documentId).toBe(target);
		await tool(connection.token, "fail_experiment", {
			id,
			generation: claim.generation,
			error: "Stopped",
		});
	}
	let id = crypto.randomUUID();
	await request(`/api/documents/${elsewhere}/experiments`, { id, brief: "Measure" }, alice.cookie);
	let refused = await request(
		`/api/documents/${elsewhere}/experiments/${id}/run`,
		{},
		alice.cookie,
	);
	expect(refused.status).toBe(409);
	expect((await refused.json()).error).toBe("no-workspace");
	let foreign = crypto.randomUUID();
	await request(`/api/documents/${second}/experiments`, { id: foreign, brief: "Bob" }, bob.cookie);
	expect(
		(await request(`/api/documents/${second}/experiments/${foreign}/run`, {}, bob.cookie))
			.status,
	).toBe(409);
	expect((await tool(connection.token, "claim_experiment", { id: foreign })).result.isError)
		.toBe(true);
});

test("expired pairing and connections cannot be revived by replay", () => {
	let now = 0;
	let connections = new Connections(() => now);
	let pending = connections.create({
		repository: "org/repo",
		commit: "a".repeat(40),
		label: "Laptop",
	});
	connections.approve(pending.id, { id: "alice", login: "alice", sessionId: "s" }, "repo");
	let result = connections.claim(pending.id, pending.secret);
	if (!("token" in result)) throw new Error("missing token");
	now = 91_000;
	expect(() => connections.lookup(result.token!)).toThrow("connection-unavailable");
	now = 301_000;
	expect(() => connections.claim(pending.id, pending.secret)).toThrow("pairing-expired");
});
