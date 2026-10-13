import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "@chopin/experiment/fixtures";
import {
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_UPDATE_REQUIRED,
	CONNECTOR_VERSION_HEADER,
} from "@chopin/protocol/connector";
import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import { GitHubTokenError } from "../github/client";
import type { GitHub } from "../github/client";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { CONNECTOR_PROTOCOLS, registerExperimentRoutes } from "./routes";
import { Connections } from "./connections";
import type { ImplementationConnector } from "../tasks/connector";

function text(value: { result: { content: Array<{ text: string }> } }) {
	return JSON.parse(value.result.content[0].text);
}

function error(value: { result: { isError?: boolean; content: Array<{ text: string }> } }) {
	return value.result.isError ? value.result.content[0].text : "";
}

/** What a current connector sends with every request; browser routes ignore it. */
const CURRENT = {
	[CONNECTOR_VERSION_HEADER]: "dev",
	[CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOLS.max),
};

async function setup(
	shared?: { storage: MemoryStorage; lease: unknown },
	extra: { implementations?: () => ImplementationConnector | undefined } = {},
) {
	let storage = shared?.storage ?? new MemoryStorage();
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
	let lease = (shared?.lease as Awaited<ReturnType<typeof storage.leases.acquire>>)
		?? (await storage.leases.acquire("writer", "test", 60_000))!;
	let sessions = new Sessions(storage, true);
	let grant = {
		accessToken: "token",
		accessExpiresIn: 3600,
		refreshToken: "refresh",
		refreshExpiresIn: 7200,
	};
	let alice = await sessions.issue("alice", grant);
	let bob = await sessions.issue("bob", grant);
	/** The GitHub tokens repository checks were made with, most recent last. */
	let checked: string[] = [];
	let github = {
		repositoryAccess: async (token: string, owner: string, name: string) => {
			checked.push(token);
			return { id: name, owner, name, permissions: { pull: true, push: true, admin: false } };
		},
	} as unknown as GitHub;
	let config = {
		origin: "https://chopin.test",
		appSlug: "test",
		clientId: "test",
		clientSecret: "secret",
		encryptionKey: new Uint8Array(32).fill(3),
	};
	let refresh = { refuse: false, count: 0 };
	let clock = { offset: 0 };
	let machines = new Machines(storage, () => new Date(Date.now() + clock.offset), {
		key: config.encryptionKey,
		origin: config.origin,
		clientId: config.clientId,
		refresh: async () => {
			if (refresh.refuse) {
				throw new GitHubTokenError("GitHub rejected the token refresh", 401, true);
			}
			refresh.count++;
			return {
				accessToken: `ghu_machine_${refresh.count + 1}`,
				accessExpiresIn: 28_800,
				refreshToken: `ghr_machine_${refresh.count + 1}`,
				refreshExpiresIn: 15_897_600,
			};
		},
	});
	let router = new Router();
	let lock = { locked: false, documents: new Set<string>() };
	let auth = {
		storage,
		sessions,
		github,
		config,
		admission: new Admission(config, github),
		clock: () => new Date(),
		machines,
		pairings: {} as {
			complete?: (pairing: string, userId: string, grant: never) => Promise<string>;
		},
	};
	let runtime = registerExperimentRoutes(router, auth as never, {
		lease: () => lease,
		changed: () => {},
		context: async () => ({ source: "# Context", revision: 0 }),
		canMutate: async id => !lock.locked && !lock.documents.has(id),
		connectorVersion: "0.1.3",
		...extra,
	});
	async function request(
		path: string,
		body?: unknown,
		cookie?: string,
		token?: string,
		extra: Record<string, string> = CURRENT,
	) {
		return (await router.handle(
			new Request(`https://chopin.test${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: {
					"content-type": "application/json",
					origin: config.origin,
					...(cookie ? { cookie: cookie.split(";")[0] } : {}),
					...(token ? { authorization: `Bearer ${token}` } : {}),
					...extra,
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
	/** GitHub authorizes the machine's own token pair, as the OAuth callback does. */
	function authorized(pairing: string, userId: string) {
		return auth.pairings.complete!(pairing, userId, {
			accessToken: "ghu_machine_1",
			accessExpiresIn: 28_800,
			refreshToken: "ghr_machine_1",
			refreshExpiresIn: 15_897_600,
		} as never);
	}
	/** Register a checkout with a paired machine's token, as `chopin connect` does. */
	async function open(machineToken: string, repository = "org/repo") {
		return request(
			"/api/connector/connections",
			{
				repository,
				commit: "a".repeat(40),
				label: "Laptop",
			},
			undefined,
			machineToken,
		);
	}
	async function pair(
		cookie: string,
		repository = "org/repo",
		user = cookie === bob.cookie ? "bob" : "alice",
	) {
		let pending = await (await request("/api/connector/pairings", {
			repository,
			commit: "a".repeat(40),
			label: "Laptop",
		})).json();
		await request(`/api/connector/pairings/${pending.id}/approve`, {}, cookie);
		await authorized(pending.id, user);
		let claimed = await (await request(`/api/connector/pairings/${pending.id}/claim`, {
			secret: pending.secret,
		})).json();
		let opened = await (await open(claimed.token, repository)).json();
		return { ...pending, machineToken: claimed.token as string, ...opened };
	}
	return {
		router,
		storage,
		lease,
		sessions,
		config,
		alice,
		bob,
		document,
		documentId,
		request,
		tool,
		pair,
		open,
		authorized,
		checked,
		refresh,
		clock,
		lock,
		runtime,
	};
}

test("work runs on the clicker's own connection; scoped claims publish", async () => {
	let { alice, bob, documentId, request, lock, authorized, open } = await setup();
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
	expect((await approved.json()).authorize).toBe(`/auth/github/connector?pairing=${pair.id}`);
	expect(
		await (await request(`/api/connector/pairings/${pair.id}/claim`, { secret: pair.secret }))
			.json(),
	).toEqual({ waiting: true });
	expect(await authorized(pair.id, "alice")).toBe(`/connect?pairing=${pair.id}`);
	let shown = await (await request(`/api/connector/pairings/${pair.id}`, undefined, alice.cookie))
		.json();
	expect(shown.connected).toBe("/documents/org/repo");
	let machine =
		await (await request(`/api/connector/pairings/${pair.id}/claim`, { secret: pair.secret }))
			.json();
	expect(machine.token).toMatch(/^chopin_m_/);
	let paired = await (await open(machine.token)).json();
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
	expect(claim.title).toBe(`Investigate ${documentId}`);
	expect((await tool("claim_experiment", { id }, claim.runToken)).result.isError).toBe(true);
	let smuggled = await tool("submit_investigation_result", {
		result: { ...performance, report: `# Report\n\n<Investigation id="${id}" />\n` },
	}, claim.runToken);
	expect(error(smuggled)).toStartWith("protected-report");
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
	expect(value.child).toMatchObject({
		title: "Startup comparison",
		summary: "Caching reduced median startup time in the captured workload.",
	});
	let child = value.child.id;
	let reached = await request(`/api/documents/${child}/experiments/${id}`, undefined, bob.cookie);
	expect((await reached.json()).id).toBe(id);
	let listed = await (await request(`/api/documents/${child}/experiments`, undefined, bob.cookie))
		.json();
	expect(listed.experiments.map((item: { id: string }) => item.id)).toEqual([id]);
	expect(
		await (await request(`/api/documents/${child}/investigation-provenance`, undefined, bob.cookie))
			.json(),
	).toEqual({
		investigationId: id,
		parentChannelId: documentId,
		brief: "Measure startup",
		viewCount: 1,
		startedBy: "bob",
	});
	expect(
		(await request(`/api/documents/${documentId}/investigation-provenance`, undefined, bob.cookie))
			.status,
	).toBe(404);
	// The child's evidence belongs to the parent's record, so the parent's build lock applies.
	lock.documents.add(documentId);
	for (
		let [action, input] of [
			["decision", {
				id: crypto.randomUUID(),
				view: "comparison",
				revision: 0,
				conclusion: "Use cached startup",
				rationale: "",
			}],
			["placement", { view: "comparison" }],
		] as const
	) {
		let refused = await request(
			`/api/documents/${child}/experiments/${id}/${action}`,
			input,
			bob.cookie,
		);
		expect(refused.status).toBe(409);
		expect((await refused.json()).error).toBe("document-locked");
	}
	expect(
		(await (await request(`/api/documents/${child}/experiments/${id}`, undefined, bob.cookie))
			.json()).locked,
	).toBe(true);
	lock.documents.delete(documentId);
	expect((await tool("complete_experiment", { id, generation: claim.generation })).result.isError)
		.not.toBe(true);
	expect(
		(await (await request(`/api/documents/${documentId}/experiments/${id}`, undefined, bob.cookie))
			.json()).child.id,
	).toBe(child);
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

test("a failure report retried after its answer was lost lands once, and another is still refused", async () => {
	let { alice, documentId, request, tool, pair } = await setup();
	let connection = await pair(alice.cookie);
	let id = crypto.randomUUID();
	await request(`/api/documents/${documentId}/experiments`, { id, brief: "Measure" }, alice.cookie);
	await request(`/api/documents/${documentId}/experiments/${id}/run`, {}, alice.cookie);
	let claim = text(await tool(connection.token, "claim_experiment", { id }));
	let report = { id, generation: claim.generation, error: "The agent stopped." };
	expect(error(await tool(connection.token, "fail_experiment", report))).toBe("");
	// The connector never saw that answer, so it sends the same report again.
	expect(error(await tool(connection.token, "fail_experiment", report))).toBe("");
	expect(error(await tool(connection.token, "fail_experiment", { ...report, error: "Other" })))
		.toStartWith("stale-claim");
	expect(
		error(
			await tool(connection.token, "complete_experiment", { id, generation: claim.generation }),
		),
	).toStartWith("stale-claim");
	let stored = await request(
		`/api/documents/${documentId}/experiments/${id}`,
		undefined,
		alice.cookie,
	);
	expect(await stored.json()).toMatchObject({ state: "failed", progress: "The agent stopped." });
});

test("a failure report delayed past a retry leaves the next attempt running", async () => {
	let { alice, documentId, request, tool, pair, storage } = await setup();
	let connection = await pair(alice.cookie);
	let id = crypto.randomUUID();
	let path = `/api/documents/${documentId}/experiments/${id}`;
	await request(`/api/documents/${documentId}/experiments`, { id, brief: "Measure" }, alice.cookie);
	await request(`${path}/run`, {}, alice.cookie);
	let first = text(await tool(connection.token, "claim_experiment", { id }));
	// Hold the first failure's write until the run has been retried and claimed again.
	let save = storage.experiments.save.bind(storage.experiments);
	let held = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let holding = true;
	storage.experiments.save = async (value, revision, lease) => {
		if (holding && value.id === id && value.state === "failed") {
			holding = false;
			held.resolve();
			await release.promise;
		}
		return save(value, revision, lease);
	};
	let report = { id, generation: first.generation, error: "The first attempt failed." };
	let delayed = tool(connection.token, "fail_experiment", report);
	await held.promise;
	// The same report, sent again, lands while the first copy is still in flight.
	expect(error(await tool(connection.token, "fail_experiment", report))).toBe("");
	await request(`${path}/retry`, {}, alice.cookie);
	await request(`${path}/run`, {}, alice.cookie);
	let second = text(await tool(connection.token, "claim_experiment", { id }));
	expect(second.generation).toBe(first.generation + 1);
	release.resolve();
	expect(error(await delayed)).toStartWith("stale-claim");
	expect(await storage.experiments.get(id)).toMatchObject({
		state: "running",
		generation: second.generation,
		progress: "",
	});
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

test("signing out of the browser leaves a paired machine and its run connected", async () => {
	let { alice, documentId, request, tool, pair, sessions, config, checked } = await setup();
	let connection = await pair(alice.cookie);
	let id = crypto.randomUUID();
	await request(`/api/documents/${documentId}/experiments`, { id, brief: "Measure" }, alice.cookie);
	await request(`/api/documents/${documentId}/experiments/${id}/run`, {}, alice.cookie);
	let claim = text(await tool(connection.token, "claim_experiment", { id }));
	await sessions.revoke(
		new Request(config.origin, { headers: { cookie: alice.cookie.split(";")[0] } }),
	);
	checked.length = 0;
	expect(text(await tool(claim.runToken, "read_experiment", {})).input.id).toBe(id);
	let ping = await request(
		"/connector/mcp",
		{ jsonrpc: "2.0", id: 2, method: "ping" },
		undefined,
		connection.token,
	);
	expect(ping.status).toBe(200);
	// Repository access is rechecked with the machine's own GitHub token, not the browser login's.
	expect(checked.length).toBeGreaterThan(0);
	expect(new Set(checked)).toEqual(new Set(["ghu_machine_1"]));
});

test("a paired machine connects again after a server restart without pairing", async () => {
	let first = await setup();
	let paired = await first.pair(first.alice.cookie);
	// A new process: new routes, memory and credential cache over the same storage.
	let restarted = await setup({ storage: first.storage, lease: first.lease });
	let stale = await restarted.request(
		"/connector/mcp",
		{ jsonrpc: "2.0", id: 1, method: "ping" },
		undefined,
		paired.token,
	);
	expect((await stale.json()).error).toBe("connection-unavailable");
	let opened = await restarted.open(paired.machineToken);
	expect(opened.status).toBe(200);
	let { token } = await opened.json();
	let ping = await restarted.request(
		"/connector/mcp",
		{ jsonrpc: "2.0", id: 1, method: "ping" },
		undefined,
		token,
	);
	expect(ping.status).toBe(200);
	expect(restarted.checked.at(-1)).toBe("ghu_machine_1");
});

test(
	"a waiting connector registers again with its machine token after a server restart and runs the next work",
	async () => {
		// The routes' long poll asks the implementation connector first; this server has no builds.
		let builds = {
			implementations: () =>
				({
					waiting: async () => undefined,
					busy: async () => false,
					disconnected: async () => {},
				}) as unknown as ImplementationConnector,
		};
		let first = await setup(undefined, builds);
		let paired = await first.pair(first.alice.cookie);
		let scratch = await mkdtemp(join(tmpdir(), "chopin-restart-"));
		let root = join(scratch, "repo");
		let git = (...args: string[]) => {
			let result = Bun.spawnSync(["git", "-C", root, ...args]);
			if (result.exitCode) throw new Error(result.stderr.toString());
		};
		await mkdir(root);
		git("init");
		git("config", "user.name", "Fixture");
		git("config", "user.email", "fixture@example.test");
		git("remote", "add", "origin", "https://github.com/org/repo.git");
		await writeFile(join(root, "README.md"), "fixture");
		git("add", ".");
		git("commit", "-m", "fixture");
		/** The paths the connector asked for, so a second pairing would show. */
		let paths: string[] = [];
		let handler = first.router;
		let serve = (port = 0) =>
			Bun.serve({
				hostname: "127.0.0.1",
				port,
				idleTimeout: 0,
				async fetch(request) {
					paths.push(new URL(request.url).pathname);
					return await handler.handle(request) ?? new Response(null, { status: 404 });
				},
			});
		let server = serve();
		let url = `http://127.0.0.1:${server.port}`;
		// The machine was paired once and its token stored, as `chopin pair` leaves it.
		let home = join(scratch, "home");
		await mkdir(home);
		await writeFile(
			join(home, "machine.json"),
			JSON.stringify({ servers: { [url]: { token: paired.machineToken, label: "Laptop" } } }),
		);
		let connector = Bun.spawn([
			process.execPath,
			"--no-env-file",
			join(import.meta.dir, "../../../connector/src/main.ts"),
			"connect",
			root,
			"--",
			"false",
		], {
			env: { ...process.env, CHOPIN_URL: url, CHOPIN_HOME: home, NO_COLOR: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		let output = "";
		for (let stream of [connector.stdout, connector.stderr]) {
			void (async () => {
				for await (let chunk of stream) output += new TextDecoder().decode(chunk);
			})();
		}
		let until = async (done: () => boolean | Promise<boolean>, what: string) => {
			for (let start = Date.now(); !await done();) {
				if (Date.now() - start > 15_000) {
					throw new Error(`Timed out waiting for ${what}:\n${output}`);
				}
				await Bun.sleep(25);
			}
		};
		try {
			await until(() => output.includes("Connected."), "the connector to connect");
			await until(() => paths.at(-1) === "/connector/mcp", "the long poll");
			// A new process: new routes, connections and credential cache over the same storage, on the
			// same address. Stopping the old one drops the connector's long poll.
			let restarted = await setup({ storage: first.storage, lease: first.lease }, builds);
			let port = server.port;
			await server.stop(true);
			handler = restarted.router;
			paths.length = 0;
			server = serve(port);
			await until(() => output.includes("Reconnected."), "the connector to reconnect");
			let id = crypto.randomUUID();
			let { documentId, request, alice, runtime } = restarted;
			await request(
				`/api/documents/${documentId}/experiments`,
				{ id, brief: "Measure" },
				alice.cookie,
			);
			expect(
				(await request(`/api/documents/${documentId}/experiments/${id}/run`, {}, alice.cookie))
					.status,
			)
				.toBe(200);
			await until(
				async () => (await runtime.service.store.get(id))?.state !== "queued",
				"the connector to claim the run",
			);
			// Claimed through the connection registered after the restart.
			let claimed = await runtime.service.store.get(id);
			expect(claimed?.state).toBe("running");
			expect(claimed?.connectionId).not.toBe(paired.connection.id);
			expect(paths).toContain("/api/connector/connections");
			expect(paths.filter(path => path.startsWith("/api/connector/pairings"))).toEqual([]);
			expect(output).not.toContain("/connect?pairing=");
		} finally {
			connector.kill("SIGKILL");
			await connector.exited;
			await server.stop(true);
			await rm(scratch, { recursive: true, force: true });
		}
	},
	30_000,
);

test("disconnecting a machine in the browser ends it with machine-revoked", async () => {
	let { alice, bob, request, pair, open } = await setup();
	let paired = await pair(alice.cookie);
	let listed = await (await request("/api/connector/machines", undefined, alice.cookie)).json();
	expect(listed.machines).toEqual([expect.objectContaining({
		id: paired.machine,
		label: "Laptop",
		repositories: ["org/repo"],
		autoRun: false,
		connected: true,
	})]);
	expect(JSON.stringify(listed)).not.toContain(paired.machineToken);
	expect((await (await request("/api/connector/machines", undefined, bob.cookie)).json()).machines)
		.toEqual([]);
	let foreign = await request(`/api/connector/machines/${paired.machine}/revoke`, {}, bob.cookie);
	expect(foreign.status).toBe(404);
	let revoked = await request(`/api/connector/machines/${paired.machine}/revoke`, {}, alice.cookie);
	expect(revoked.status).toBe(200);
	let refused = await request(
		"/connector/mcp",
		{ jsonrpc: "2.0", id: 1, method: "ping" },
		undefined,
		paired.token,
	);
	expect(refused.status).toBe(401);
	let reopened = await open(paired.machineToken);
	expect(reopened.status).toBe(401);
	expect((await reopened.json()).error).toBe("machine-revoked");
	expect(
		(await (await request("/api/connector/machines", undefined, alice.cookie)).json()).machines,
	)
		.toEqual([]);
});

test("unpairing with the machine's own token revokes it", async () => {
	let { alice, request, pair, open } = await setup();
	let paired = await pair(alice.cookie);
	let unpaired = await request("/api/connector/machine/revoke", {}, undefined, paired.machineToken);
	expect(unpaired.status).toBe(200);
	let reopened = await open(paired.machineToken);
	expect((await reopened.json()).error).toBe("machine-revoked");
	let again = await request("/api/connector/machine/revoke", {}, undefined, paired.machineToken);
	expect(again.status).toBe(401);
	expect((await again.json()).error).toBe("machine-revoked");
});

test("GitHub refusing a machine's authorization asks for pairing again", async () => {
	let { alice, request, pair, open, refresh, clock } = await setup();
	let paired = await pair(alice.cookie);
	refresh.refuse = true;
	clock.offset = 8 * 60 * 60 * 1000;
	let refused = await request(
		"/connector/mcp",
		{ jsonrpc: "2.0", id: 1, method: "ping" },
		undefined,
		paired.token,
	);
	expect(refused.status).toBe(401);
	expect((await refused.json()).error).toBe("machine-reauthorize");
	expect((await (await open(paired.machineToken)).json()).error).toBe("machine-reauthorize");
	let again = await request(
		"/connector/mcp",
		{ jsonrpc: "2.0", id: 2, method: "ping" },
		undefined,
		paired.token,
	);
	expect((await again.json()).error).toBe("machine-reauthorize");
	let listed = await (await request("/api/connector/machines", undefined, alice.cookie)).json();
	expect(listed.machines).toEqual([
		expect.objectContaining({ id: paired.machine, reauthorize: true, connected: false }),
	]);
});

test("a pairing completes only for the GitHub account that approved it", async () => {
	let { alice, request, authorized } = await setup();
	let pending = await (await request("/api/connector/pairings", {
		repository: "org/repo",
		commit: "a".repeat(40),
		label: "Laptop",
	})).json();
	await request(`/api/connector/pairings/${pending.id}/approve`, {}, alice.cookie);
	expect(await authorized(pending.id, "bob").catch(err => err.code)).toBe("pairing-forbidden");
	expect(
		await (await request(`/api/connector/pairings/${pending.id}/claim`, {
			secret: pending.secret,
		})).json(),
	).toEqual({ waiting: true });
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
	let result = connections.open(
		{ id: "machine", owner: "alice", login: "alice", autoRun: false },
		"Laptop",
		{ repository: "org/repo", repositoryId: "repo", commit: "a".repeat(40) },
	);
	now = 91_000;
	expect(() => connections.lookup(result.token)).toThrow("connection-unavailable");
	now = 301_000;
	expect(() => connections.claim(pending.id, pending.secret)).toThrow("pairing-expired");
});

test("a child document refuses new investigations", async () => {
	let { storage, documentId, request, alice } = await setup();
	let child = crypto.randomUUID();
	await storage.channels.create({
		id: child,
		repositoryId: "repo",
		repositoryOwner: "org",
		repositoryName: "repo",
		parentChannelId: documentId,
		title: "Child",
		createdBy: "alice",
		now: new Date(),
	});
	let refused = await request(
		`/api/documents/${child}/experiments`,
		{ id: crypto.randomUUID(), brief: "Measure startup" },
		alice.cookie,
	);
	expect(refused.status).toBe(409);
	expect((await refused.json()).error).toBe("child-document");
});

test("a stale Ready to run cannot cancel another person's queued run", async () => {
	let { documentId, request, alice, bob, pair, runtime } = await setup();
	await pair(alice.cookie);
	let id = crypto.randomUUID();
	await request(`/api/documents/${documentId}/experiments`, { id, brief: "Measure" }, alice.cookie);
	let ready = await runtime.service.store.get(id);
	expect(
		(await request(`/api/documents/${documentId}/experiments/${id}/run`, {}, alice.cookie))
			.status,
	).toBe(200);
	// Bob's request reads the record before Alice's Run lands, then writes after it.
	let get = runtime.service.store.get.bind(runtime.service.store);
	let stale = true;
	runtime.service.store.get = async (value: string) => {
		if (stale && value === id) {
			stale = false;
			return structuredClone(ready);
		}
		return get(value);
	};
	let refused = await request(
		`/api/documents/${documentId}/experiments/${id}/cancel`,
		{},
		bob.cookie,
	);
	expect(refused.status).toBe(403);
	expect((await refused.json()).error).toBe("connection-forbidden");
	expect((await get(id))?.state).toBe("queued");
});

test("builds queued behind a connection's build take its place in the order they queued", () => {
	let connections = new Connections(() => 0);
	let { id } = connections.open(
		{ id: "machine", owner: "alice", login: "alice", autoRun: false },
		"Laptop",
		{ repository: "org/repo", repositoryId: "repo", commit: "a".repeat(40) },
	).connection;
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
	await runtime.service.create(documentId, "alice", "Spike brief", id, {
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
	let names = tools.result.tools.map((item: { name: string }) => item.name);
	expect(names).toContain("submit_spike_result");
	// A spike reports only its short structured result, never a full investigation result.
	expect(names).not.toContain("submit_investigation_result");
	expect(names).not.toContain("submit_experiment_result");
	for (let name of ["submit_investigation_result", "submit_experiment_result"]) {
		expect(error(await tool(claim.runToken, name, { result: { report: "# Hi\n" } })))
			.toContain("tool-forbidden");
	}
	expect((await runtime.service.store.get(id))?.spike?.startedAt).toBeNumber();
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
	await runtime.service.create(documentId, "alice", "Spike brief", id, {
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

test("a spike still running 20 minutes after its claim is interrupted", async () => {
	let { alice, documentId, tool, pair, runtime } = await setup();
	let paired = await pair(alice.cookie);
	let id = crypto.randomUUID();
	await runtime.service.create(documentId, "alice", "Spike brief", id, {
		digest: "sha256:y",
		passage: "Unsure whether this works.",
		callout: "01JBBBBBBBBBBBBBBBBBBBBBBB",
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
	text(await tool(paired.token, "claim_experiment", { id }));
	await runtime.sweep();
	expect((await runtime.service.store.get(id))?.state).toBe("running");
	await runtime.service.mutate(id, value => {
		value.spike!.startedAt = Date.now() - 21 * 60_000;
	});
	await runtime.sweep();
	let value = await runtime.service.store.get(id);
	expect(value?.state).toBe("interrupted");
	expect(value?.progress).toContain("20-minute limit");
});

test("a connector outside the supported protocol range is refused with the command that fixes it", async () => {
	let context = await setup();
	let { alice, request, pair, authorized } = context;
	let { min, max } = CONNECTOR_PROTOCOLS;
	let headers = (version: string, protocol: number) => ({
		[CONNECTOR_VERSION_HEADER]: version,
		[CONNECTOR_PROTOCOL_HEADER]: String(protocol),
	});
	let source = { repository: "org/repo", commit: "a".repeat(40), label: "Laptop" };
	let initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
	let mcp = (token: string, extra: Record<string, string>) =>
		request("/connector/mcp", initialize, undefined, token, extra);
	// A /connector.js from before the check sends neither header. It speaks protocol 1, which
	// pairs a checkout rather than a machine, so it must download this server's connector again.
	let paired = await pair(alice.cookie);
	for (
		let legacy of [
			await request("/api/connector/pairings", source, undefined, undefined, {}),
			await mcp(paired.token, {}),
		]
	) {
		expect(legacy.status).toBe(409);
		let body = await legacy.json();
		expect(body.error).toBe(CONNECTOR_UPDATE_REQUIRED);
		expect(body.message).toContain("connector protocol 1");
		expect(body.message).toContain(
			"curl -fsSL https://chopin.test/connector.js -o ~/.chopin/connector.js",
		);
	}

	// In range: pairing, claiming and connector calls all go through.
	let current = headers("0.2.0", max);
	let created = await request("/api/connector/pairings", source, undefined, undefined, current);
	expect(created.status).toBe(200);
	let pending = await created.json();
	await request(`/api/connector/pairings/${pending.id}/approve`, {}, alice.cookie);
	await authorized(pending.id, "alice");
	let claimed = await request(
		`/api/connector/pairings/${pending.id}/claim`,
		{ secret: pending.secret },
		undefined,
		undefined,
		current,
	);
	expect(claimed.status).toBe(200);
	let machine = (await claimed.json()).token;
	let opened = await request("/api/connector/connections", source, undefined, machine, current);
	expect(opened.status).toBe(200);
	let { token } = await opened.json();
	expect((await mcp(token, current)).status).toBe(200);

	// Too old or too new: each connector route refuses, even with a valid token, and says why.
	for (
		let [version, protocol, fix] of [
			// Both directions name the exact release this server recommends, a downgrade if need be.
			["0.0.1", min - 1, "Run `chopin update 0.1.3`"],
			["9.0.0", max + 1, "Run `chopin update 0.1.3`"],
			// A script without a release version is fixed by downloading this server's connector again.
			["dev", min - 1, "curl -fsSL https://chopin.test/connector.js -o ~/.chopin/connector.js"],
		] as const
	) {
		let refused = [
			await request(
				"/api/connector/pairings",
				source,
				undefined,
				undefined,
				headers(version, protocol),
			),
			await request(
				`/api/connector/pairings/${pending.id}/claim`,
				{ secret: pending.secret },
				undefined,
				undefined,
				headers(version, protocol),
			),
			await request(
				"/api/connector/connections",
				source,
				undefined,
				machine,
				headers(version, protocol),
			),
			await request(
				"/api/connector/machine/revoke",
				{},
				undefined,
				machine,
				headers(version, protocol),
			),
			await mcp(token, headers(version, protocol)),
		];
		for (let response of refused) {
			expect(response.status).toBe(409);
			let body = await response.json();
			expect(body).toMatchObject({
				error: CONNECTOR_UPDATE_REQUIRED,
				protocol: { min, max },
				version: "0.1.3",
			});
			expect(body.message).toContain(`connector protocol ${protocol}`);
			expect(body.message).toContain(`protocol ${min === max ? min : `${min} to ${max}`}`);
			expect(body.message).toContain(fix);
		}
	}
	// The refusals left the paired machine and its connection alone.
	expect((await mcp(token, current)).status).toBe(200);

	// The agent itself reaches a run over HTTP MCP with the run token and no connector headers.
	let { documentId } = context;
	let id = crypto.randomUUID();
	await request(`/api/documents/${documentId}/experiments`, { id, brief: "Measure" }, alice.cookie);
	await request(`/api/documents/${documentId}/experiments/${id}/run`, {}, alice.cookie);
	let claim = await (await request(
		"/connector/mcp",
		{
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "claim_experiment", arguments: { id } },
		},
		undefined,
		token,
	)).json();
	let { runToken } = JSON.parse(claim.result.content[0].text);
	expect((await mcp(runToken, {})).status).toBe(200);
});

test("the connector versions this server wants are public", async () => {
	let { request } = await setup();
	let response = await request("/api/connector/version");
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ protocol: CONNECTOR_PROTOCOLS, version: "0.1.3" });
});
