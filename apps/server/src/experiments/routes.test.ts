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

function error(value: { result: { isError?: boolean; content: Array<{ text: string }> } }) {
	return value.result.isError ? value.result.content[0].text : "";
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
		repositoryAccess: async (_token: string, owner: string, name: string) => ({
			id: name,
			owner,
			name,
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
	let lock = { locked: false };
	let runtime = registerExperimentRoutes(router, {
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
		canMutate: async () => !lock.locked,
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
	return {
		storage,
		sessions,
		config,
		alice,
		bob,
		document,
		documentId,
		request,
		tool,
		pair,
		lock,
		runtime,
	};
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
	let claimed = await tool(connection.token, "claim_experiment", { id: foreign });
	expect(claimed.result.isError).toBe(true);
	expect(claimed.result.content[0].text).toStartWith("connection-forbidden");
});

test("a claim refuses a document in another repository and interrupts archived or locked ones", async () => {
	let { alice, document, documentId, request, tool, pair, lock, runtime, storage } = await setup();
	let connection = await pair(alice.cookie);
	async function queued(target: string) {
		let id = crypto.randomUUID();
		await request(`/api/documents/${target}/experiments`, { id, brief: "Measure" }, alice.cookie);
		expect(
			(await request(`/api/documents/${target}/experiments/${id}/run`, {}, alice.cookie))
				.status,
		).toBe(200);
		return id;
	}

	// A record bound to this connection in another repository is never claimable through it.
	let elsewhere = await document("other");
	let foreign = crypto.randomUUID();
	await runtime.service.create(elsewhere, "alice", "Foreign", foreign);
	await runtime.service.authorize(foreign, connection.connection.id, {
		id: foreign,
		documentId: elsewhere,
		requester: "alice",
		authorizer: "alice",
		brief: "Foreign",
		source: { repositoryId: "other", repository: "org/other", commit: "a".repeat(40) },
		context: "Document revision 0",
	});
	expect(error(await tool(connection.token, "claim_experiment", { id: foreign })))
		.toStartWith("repository-forbidden");
	await runtime.service.stop(foreign, "cancelled");

	let locked = await queued(documentId);
	lock.locked = true;
	expect(error(await tool(connection.token, "claim_experiment", { id: locked })))
		.toStartWith("invalid-state");
	expect((await runtime.service.store.get(locked))?.state).toBe("interrupted");
	lock.locked = false;

	let second = await document();
	let archived = await queued(second);
	await storage.channels.archive({ id: second, now: new Date() });
	expect(error(await tool(connection.token, "claim_experiment", { id: archived })))
		.toStartWith("invalid-state");
	expect((await runtime.service.store.get(archived))?.state).toBe("interrupted");
});

test("logging out revokes a run already in progress", async () => {
	let { alice, documentId, request, tool, pair, sessions, config } = await setup();
	let connection = await pair(alice.cookie);
	let id = crypto.randomUUID();
	await request(`/api/documents/${documentId}/experiments`, { id, brief: "Measure" }, alice.cookie);
	await request(`/api/documents/${documentId}/experiments/${id}/run`, {}, alice.cookie);
	let claim = text(await tool(connection.token, "claim_experiment", { id }));
	expect(text(await tool(claim.runToken, "read_experiment", {})).input.id).toBe(id);
	await sessions.revoke(
		new Request(config.origin, { headers: { cookie: alice.cookie.split(";")[0] } }),
	);
	let refused = await request(
		"/connector/mcp",
		{
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "read_experiment", arguments: {} },
		},
		undefined,
		claim.runToken,
	);
	expect(refused.status).toBe(401);
});

test("a pairing carries a confirmation code the page can show", async () => {
	let { alice, request } = await setup();
	let pending = await (await request("/api/connector/pairings", {
		repository: "org/repo",
		commit: "a".repeat(40),
		label: "Laptop",
	})).json();
	expect(pending.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
	expect(pending.url).not.toContain(pending.code);
	let shown =
		await (await request(`/api/connector/pairings/${pending.id}`, undefined, alice.cookie))
			.json();
	expect(shown.code).toBe(pending.code);
	expect(shown.documents).toBeUndefined();
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

test("builds queued behind a connection's build take its place in the order they queued", () => {
	let connections = new Connections(() => 0);
	let pending = connections.create({
		repository: "org/repo",
		commit: "a".repeat(40),
		label: "Laptop",
	});
	let { id } = connections.approve(
		pending.id,
		{ id: "alice", login: "alice", sessionId: "s" },
		"repo",
	);
	connections.assign(id, "one");
	connections.enqueue(id, "two");
	connections.enqueue(id, "three");
	connections.enqueue(id, "two");
	connections.enqueue(id, "one");
	expect(connections.queued(id)).toEqual(["two", "three"]);
	// A queued document that gives up leaves its place without moving the current build.
	connections.release(id, "three");
	connections.enqueue(id, "three");
	connections.release(id, "one");
	expect(connections.assigned(id)).toBe("two");
	expect(connections.queued(id)).toEqual(["three"]);
	connections.release(id, "two");
	expect(connections.assigned(id)).toBe("three");
	connections.release(id, "three");
	expect(connections.assigned(id)).toBeUndefined();
	expect(connections.queued(id)).toEqual([]);
});

test("a spike runs with an image upload and a structured report, and stays out of the list", async () => {
	let { alice, documentId, request, tool, pair, runtime } = await setup();
	let paired = await pair(alice.cookie);
	let id = crypto.randomUUID();
	await runtime.service.create(documentId, "alice", "Spike brief", id, undefined, {
		digest: "sha256:x",
		passage: "Unsure whether this works.",
		callout: "01JAAAAAAAAAAAAAAAAAAAAAAA",
		login: "alice",
		placed: true,
	});
	await runtime.service.authorize(id, paired.connection.id, {
		id,
		documentId,
		requester: "alice",
		authorizer: "alice",
		brief: "Spike brief",
		source: paired.connection.source,
		context: "# Context",
	});
	let listed =
		await (await request(`/api/documents/${documentId}/experiments`, undefined, alice.cookie))
			.json();
	expect(listed.experiments).toEqual([]);
	let claim = text(await tool(paired.token, "claim_experiment", { id }));
	expect(claim.spike).toBe(true);
	let tools = await (await request(
		"/connector/mcp",
		{ jsonrpc: "2.0", id: 1, method: "tools/list" },
		undefined,
		claim.runToken,
	)).json();
	expect(tools.result.tools.map((item: { name: string }) => item.name)).toContain(
		"submit_spike_result",
	);
	let png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
	let uploaded = text(
		await tool(claim.runToken, "upload_investigation_image", {
			data: png.toString("base64"),
			mimeType: "image/png",
		}),
	);
	expect(uploaded.path).toMatch(/^\/images\/[0-9a-f]{64}\.png$/);
	let missing = `/images/${"b".repeat(64)}.png`;
	expect(
		error(
			await tool(claim.runToken, "submit_spike_result", {
				headline: "It works",
				findings: ["Yes."],
				recommendation: "Ship.",
				images: [missing],
			}),
		),
	).toContain("missing-image");
	expect(
		error(
			await tool(claim.runToken, "submit_spike_result", {
				headline: "It works",
				findings: ["Pointer events fire.", "Latency is fine."],
				recommendation: "Ship it.",
				images: [uploaded.path],
			}),
		),
	).toBe("");
	await tool(paired.token, "complete_experiment", { id, generation: claim.generation });
	let value = await runtime.service.store.get(id);
	expect(value?.state).toBe("completed");
	expect(value?.result?.report).toContain("**It works**");
	expect(value?.result?.report).toContain(uploaded.path);
});

test("an ordinary run cannot upload images or send an image-sized body", async () => {
	let { alice, documentId, request, tool, pair } = await setup();
	let paired = await pair(alice.cookie);
	let id = crypto.randomUUID();
	await request(`/api/documents/${documentId}/experiments`, { id, brief: "Measure" }, alice.cookie);
	await request(`/api/documents/${documentId}/experiments/${id}/run`, {}, alice.cookie);
	let claim = text(await tool(paired.token, "claim_experiment", { id }));
	let tools = await (await request(
		"/connector/mcp",
		{ jsonrpc: "2.0", id: 1, method: "tools/list" },
		undefined,
		claim.runToken,
	)).json();
	let names = tools.result.tools.map((item: { name: string }) => item.name);
	expect(names).not.toContain("upload_investigation_image");
	expect(names).not.toContain("submit_spike_result");
	let png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
	expect(
		error(
			await tool(claim.runToken, "upload_investigation_image", {
				data: png.toString("base64"),
				mimeType: "image/png",
			}),
		),
	).toContain("tool-forbidden");
	let large = await request(
		"/connector/mcp",
		{
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "read_experiment", arguments: { padding: "x".repeat(1_200_000) } },
		},
		undefined,
		claim.runToken,
	);
	expect((await large.json()).error).toBe("request-too-large");
});

test("a spike uploads at most three images and cites only its own", async () => {
	let { alice, documentId, tool, pair, runtime, storage } = await setup();
	let paired = await pair(alice.cookie);
	let id = crypto.randomUUID();
	await runtime.service.create(documentId, "alice", "Spike brief", id, undefined, {
		digest: "sha256:x",
		passage: "Unsure whether this works.",
		callout: "01JAAAAAAAAAAAAAAAAAAAAAAA",
		login: "alice",
		placed: true,
	});
	await runtime.service.authorize(id, paired.connection.id, {
		id,
		documentId,
		requester: "alice",
		authorizer: "alice",
		brief: "Spike brief",
		source: paired.connection.source,
		context: "# Context",
	});
	let claim = text(await tool(paired.token, "claim_experiment", { id }));
	let upload = (seed: number) =>
		tool(claim.runToken, "upload_investigation_image", {
			data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed]).toString("base64"),
			mimeType: "image/png",
		});
	// Parallel uploads in one run must all count, and the cap must hold across them.
	let results = await Promise.all([1, 2, 3, 4].map(upload));
	expect(results.filter(result => error(result).includes("image-limit"))).toHaveLength(1);
	let seeds = [1, 2, 3, 4].filter((_seed, index) => !error(results[index]));
	let paths: string[] = seeds.map(seed => text(results[seed - 1]).path);
	expect(paths).toHaveLength(3);
	expect(text(await upload(seeds[0])).path).toBe(paths[0]);
	expect(error(await upload(5))).toContain("image-limit");
	let foreign = "c".repeat(64);
	await storage.images.put({
		channelId: documentId,
		sha256: foreign,
		mimeType: "image/png",
		bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		uploadedBy: "bob",
		now: new Date(),
	});
	let submit = (images: string[]) =>
		tool(claim.runToken, "submit_spike_result", {
			headline: "It works",
			findings: ["Yes."],
			recommendation: "Ship.",
			images,
		});
	expect(error(await submit([`/images/${foreign}.png`]))).toContain("missing-image");
	expect(error(await submit(paths))).toBe("");
});
