import { expect, spyOn, test } from "bun:test";
import * as Permission from "./permission";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { serveWork } from "./connection";
import { createOutput } from "./output";
import { processesIn } from "./processes";
import { runWork, STOPPED } from "./run";
import { git } from "./workspace";
import { ConnectorError, remote } from "./mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Run one implementation claim against a fixture repository and record connector calls. */
async function run(
	build: { kind?: "rebuild"; live?: boolean },
	flags: string[],
	respond: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => unknown =
		() => ({}),
	signal = new AbortController().signal,
	options: Partial<Parameters<typeof runWork>[3]> = {},
) {
	let root = await mkdtemp(join(tmpdir(), "chopin-rebuild-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-rebuild-state-"));
	try {
		git(root, "init");
		git(root, "config", "user.name", "Fixture");
		git(root, "config", "user.email", "fixture@example.test");
		git(root, "remote", "add", "origin", "git@github.com:org/repo.git");
		await writeFile(join(root, "source.txt"), "committed");
		git(root, "add", ".");
		git(root, "commit", "-m", "fixture");
		/** Calls as sent, and without their report keys, which are random. */
		let sent: Array<[string, Record<string, unknown>]> = [];
		let calls: Array<[string, Record<string, unknown>]> = [];
		let api = {
			call: async (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
				sent.push([name, args]);
				let { idempotencyKey: _key, ...rest } = args;
				calls.push([name, rest]);
				return respond(name, args, signal);
			},
		} as unknown as Awaited<ReturnType<typeof remote>>;
		let id = crypto.randomUUID();
		await runWork(api, "implementation", {
			build: {
				id,
				...(build.kind ? { kind: build.kind } : {}),
				repositoryId: "R_repo",
				checkout: { repository: "org/repo", commit: git(root, "rev-parse", "HEAD") },
			},
			live: build.live,
			title: "Margin landing page",
			runToken: "token",
		}, {
			root,
			directory: state,
			command: [
				process.execPath,
				new URL("./testing/fake-implementer.ts", import.meta.url).pathname,
				...flags,
			],
			url: "http://127.0.0.1:1",
			signal,
			heartbeatMs: 20,
			...options,
		});
		return { id, calls, sent, branches: git(root, "branch", "--list", "chopin/*") };
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
}

test("a rebuild runs on a detached worktree with the rebuild prompt", async () => {
	let { id, calls, branches } = await run({ kind: "rebuild" }, ["--rebuild"]);
	expect(calls.filter(([name]) => name !== "renew_implementation_build")).toEqual([
		["report_implementation_build", {
			id,
			state: "running",
			session: "implementation-acp-session",
		}],
		["report_implementation_build", { id, state: "stopped" }],
	]);
	expect(branches).toBe("");
});

test("a rebuild whose report landed stops renewing and exits cleanly", async () => {
	let { id, calls } = await run(
		{ kind: "rebuild" },
		["--rebuild", "--slow"],
		name => name === "renew_implementation_build" ? { accepted: true, state: "stopped" } : {},
	);
	expect(calls.filter(([name]) => name === "renew_implementation_build")).toHaveLength(1);
	expect(calls.at(-1)).toEqual(["report_implementation_build", { id, state: "stopped" }]);
});

test("a living document's first build gets a prompt without verification or revision", async () => {
	let { id, calls } = await run({ live: true }, ["--live"]);
	expect(calls.filter(([name]) => name !== "renew_implementation_build").at(-1)).toEqual([
		"report_implementation_build",
		{ id, state: "stopped" },
	]);
});

test.skipIf(process.platform === "win32")(
	"the agent runs with the --env connect saved",
	async () => {
		let file = join(await mkdtemp(join(tmpdir(), "chopin-env-")), "seen");
		let implementer = new URL("./testing/fake-implementer.ts", import.meta.url).pathname;
		let { calls } = await run({ live: true }, [], undefined, undefined, {
			command: [
				"/bin/sh",
				"-c",
				'printf %s "$SOME_FLAG" > "$0"; exec "$1" "$2" --live',
				file,
				process.execPath,
				implementer,
			],
			env: { SOME_FLAG: "from connect" },
		});
		expect(calls.findLast(([name]) => name !== "renew_implementation_build")?.[1])
			.toMatchObject({ state: "stopped" });
		expect(await readFile(file, "utf8")).toBe("from connect");
	},
);

test.each([true, false])(
	"an investigation (spike=%s) serves image tools through an authenticated local bridge",
	async spike => {
		let root = await mkdtemp(join(tmpdir(), "chopin-spike-"));
		let state = await mkdtemp(join(tmpdir(), "chopin-spike-state-"));
		let received: Array<[string, Record<string, unknown>]> = [];
		let terminal = captured();
		let chopin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.headers.get("authorization") !== "Bearer run-token") {
					return new Response(null, { status: 401 });
				}
				let server = new Server({ name: "fake-chopin", version: "1" }, {
					capabilities: { tools: {} },
				});
				server.setRequestHandler(ListToolsRequestSchema, () => ({
					tools: [
						"upload_investigation_image",
						spike ? "submit_spike_result" : "submit_investigation_result",
					].map(name => ({
						name,
						inputSchema: { type: "object" as const },
					})),
				}));
				server.setRequestHandler(CallToolRequestSchema, request => {
					received.push([request.params.name, request.params.arguments ?? {}]);
					return { content: [{ type: "text", text: "{}" }] };
				});
				let transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
				});
				await server.connect(transport);
				return transport.handleRequest(request);
			},
		});
		try {
			git(root, "init");
			git(root, "config", "user.name", "Fixture");
			git(root, "config", "user.email", "fixture@example.test");
			git(root, "remote", "add", "origin", "git@github.com:org/repo.git");
			await writeFile(join(root, "source.txt"), "committed");
			git(root, "add", ".");
			git(root, "commit", "-m", "fixture");
			let calls: string[] = [];
			let api = {
				call: async (name: string) => {
					calls.push(name);
					return {};
				},
			} as unknown as Awaited<ReturnType<typeof remote>>;
			let id = crypto.randomUUID();
			await runWork(api, "experiment", {
				spike,
				passage: "We are not sure a CSS-only fade-in on the heading works without JavaScript.",
				generation: 1,
				runToken: "run-token",
				input: {
					id,
					documentId: crypto.randomUUID(),
					brief: "Prototype the passage",
					source: {
						repositoryId: "R_repo",
						repository: "org/repo",
						commit: git(root, "rev-parse", "HEAD"),
					},
					context: "",
					requester: "a",
					authorizer: "a",
				},
			}, {
				root,
				directory: state,
				command: [
					process.execPath,
					new URL("./testing/fake-agent.ts", import.meta.url).pathname,
					"--http",
					spike ? "--spike" : "--images",
				],
				url: `http://127.0.0.1:${chopin.port}`,
				signal: new AbortController().signal,
				output: terminal.output,
			});
			expect(terminal.out()).toContain(
				spike
					? "› Prototyping We are not sure a CSS-only fade-in on the heading works without JavaScript.\n"
					: "› Investigating Prototype the passage\n",
			);
			expect(calls.filter(name => name !== "renew_experiment"), terminal.err()).toEqual([
				"complete_experiment",
			]);
			expect(received.map(([name]) => name)).toEqual([
				"upload_investigation_image",
				spike ? "submit_spike_result" : "submit_investigation_result",
			]);
			expect(received[0][1]).toEqual({ data: "iVBORw0KGgo=", mimeType: "image/png" });
			// The bridge closes with the run.
			let submitted = received[1][1];
			let bridgeUrl = spike
				? submitted.url
				: (submitted.result as { provenance: { environment: string } }).provenance.environment;
			await expect(fetch(bridgeUrl as string, { method: "POST" })).rejects.toThrow();
		} finally {
			await chopin.stop(true);
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	},
);

test("Ctrl-C reports the build stopped from the terminal before the run ends", async () => {
	let controller = new AbortController();
	let { id, calls } = await run({}, ["--hang"], name => {
		// Abort once the agent session is reported running, as Ctrl-C mid-turn does.
		if (name === "report_implementation_build" && !controller.signal.aborted) {
			setTimeout(() => controller.abort(), 50);
		}
		return {};
	}, controller.signal);
	expect(calls.filter(([name]) => name !== "renew_implementation_build").at(-1)).toEqual([
		"report_implementation_build",
		{ id, state: "failed", error: STOPPED },
	]);
});

/**
 * A fake Chopin connector endpoint over MCP, whose tools may take as long as they like. While
 * `forgot` says so, it refuses every request as a restarted server refuses a connection it forgot.
 */
function chopin(tool: (name: string) => unknown, forgot = () => false) {
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (forgot()) return Response.json({ error: "connection-unavailable" }, { status: 409 });
			let mcp = new Server({ name: "fake-chopin", version: "1" }, { capabilities: { tools: {} } });
			mcp.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
			mcp.setRequestHandler(CallToolRequestSchema, async request => ({
				content: [{ type: "text", text: JSON.stringify(await tool(request.params.name) ?? {}) }],
			}));
			let transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			await mcp.connect(transport);
			return transport.handleRequest(request);
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

test("Ctrl-C ends a run at once while its heartbeat hangs on the server", async () => {
	let release = Promise.withResolvers<void>();
	let server = chopin(name => name === "renew_implementation_build" ? release.promise : {});
	let api = await remote(server.url, "token");
	let controller = new AbortController();
	let interrupted = 0;
	try {
		let { id, calls } = await run(
			{},
			["--hang"],
			(name, args, signal) => {
				if (name === "renew_implementation_build" && !interrupted) {
					interrupted = performance.now() + 100;
					setTimeout(() => controller.abort(), 100);
				}
				return api.call(name, args, signal);
			},
			controller.signal,
			{ heartbeatMs: 20 },
		);
		expect(performance.now() - interrupted).toBeLessThan(1000);
		expect(calls.at(-1)).toEqual(["report_implementation_build", {
			id,
			state: "failed",
			error: STOPPED,
		}]);
	} finally {
		release.resolve();
		await api.close();
		await server.stop();
	}
});

test("Ctrl-C ends a run at once while a report waits on Chopin", async () => {
	let controller = new AbortController();
	let interrupted = 0;
	let { id, calls } = await run(
		{},
		["--hang"],
		(name, args, signal) => {
			if (name === "report_implementation_build" && args.state === "running") {
				interrupted = performance.now() + 50;
				setTimeout(() => controller.abort(), 50);
				return hanging(signal);
			}
			return {};
		},
		controller.signal,
		{ heartbeatMs: 10_000 },
	);
	expect(performance.now() - interrupted).toBeLessThan(1000);
	expect(calls.at(-1)).toEqual(["report_implementation_build", {
		id,
		state: "failed",
		error: STOPPED,
	}]);
});

test("Ctrl-C ends a run at once while its agent is still starting", async () => {
	let file = join(await mkdtemp(join(tmpdir(), "chopin-starting-")), "started");
	process.env.CHOPIN_TEST_STARTING = file;
	let controller = new AbortController();
	try {
		let settled = false;
		let running = run({}, ["--slow-start"], () => ({}), controller.signal, {
			heartbeatMs: 10_000,
		}).finally(() => settled = true);
		// The agent has the connector's initialize request and will not answer it.
		while (!settled && !await Bun.file(file).exists()) await Bun.sleep(10);
		let interrupted = performance.now();
		controller.abort();
		let { id, calls } = await running;
		expect(performance.now() - interrupted).toBeLessThan(1000);
		expect(calls.at(-1)).toEqual(["report_implementation_build", {
			id,
			state: "failed",
			error: STOPPED,
		}]);
	} finally {
		delete process.env.CHOPIN_TEST_STARTING;
		await rm(dirname(file), { recursive: true, force: true });
	}
});

test("Ctrl-C waits at most five seconds for its stop report to reach Chopin", async () => {
	let controller = new AbortController();
	let interrupted = 0;
	await run(
		{},
		["--hang"],
		(name, args, signal) => {
			if (args.state === "running") {
				interrupted = performance.now() + 50;
				setTimeout(() => controller.abort(), 50);
			}
			return args.state === "failed" ? hanging(signal) : {};
		},
		controller.signal,
		{ heartbeatMs: 10_000 },
	);
	expect(performance.now() - interrupted).toBeGreaterThanOrEqual(4900);
	expect(performance.now() - interrupted).toBeLessThan(6500);
}, 10_000);

function captured() {
	let out = "";
	let err = "";
	let output = createOutput({ write: text => out += text }, { write: text => err += text }, {});
	return { output, out: () => out, err: () => err };
}

test("a rebuild's job line says it builds changes for the document", async () => {
	let terminal = captured();
	await run({ kind: "rebuild" }, ["--rebuild"], () => ({}), undefined, { output: terminal.output });
	expect(terminal.out()).toContain("› Building changes for Margin landing page\n");
});

test("Ctrl-C prints that the run stopped from the connector terminal, not a failure", async () => {
	let controller = new AbortController();
	let terminal = captured();
	await run(
		{},
		["--hang"],
		name => {
			if (name === "report_implementation_build" && !controller.signal.aborted) {
				setTimeout(() => controller.abort(), 50);
			}
			return {};
		},
		controller.signal,
		{ output: terminal.output },
	);
	expect(terminal.out()).toContain("› Building Margin landing page\n");
	expect(terminal.out()).toContain("✗ Stopped from the connector terminal.");
	expect(terminal.err()).toBe("");
});

test("an agent that cancelled its own turn reads as stopped, not as a failure", async () => {
	let terminal = captured();
	let { id, calls } = await run({}, ["--self-cancel"], () => ({}), undefined, {
		output: terminal.output,
	});
	expect(calls.filter(([name]) => name !== "renew_implementation_build").at(-1)).toEqual([
		"report_implementation_build",
		{ id, state: "failed", error: STOPPED },
	]);
	expect(terminal.out()).toContain("✗ Stopped from the connector terminal.");
	expect(terminal.err()).not.toContain("Agent stopped: cancelled");
});

test("servers the agent left running in its worktree end with the run", async () => {
	let file = join(await mkdtemp(join(tmpdir(), "chopin-orphan-")), "pid");
	process.env.CHOPIN_TEST_ORPHAN_PID = file;
	try {
		await run({}, ["--orphan"]);
		let pid = Number(await readFile(file, "utf8"));
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		delete process.env.CHOPIN_TEST_ORPHAN_PID;
		await rm(dirname(file), { recursive: true, force: true });
	}
});

/** What fetch rejects with when Chopin cannot be reached. */
function unreachable() {
	return Object.assign(new TypeError("Unable to connect."), { code: "ConnectionRefused" });
}

test("a network drop mid-run keeps the agent running and delivers its completion once back", async () => {
	let renewals = 0;
	let reports = 0;
	let { id, sent } = await run(
		{ kind: "rebuild" },
		["--rebuild", "--slow"],
		(name, args) => {
			// Chopin is unreachable for the first three heartbeats and the first completion report.
			if (name === "renew_implementation_build" && ++renewals <= 3) throw unreachable();
			if (name === "report_implementation_build" && args.state === "stopped" && ++reports <= 1) {
				throw unreachable();
			}
			return {};
		},
		undefined,
		{ random: () => 0.01 },
	);
	expect(renewals).toBeGreaterThan(3);
	let reported = sent.filter(([name]) => name === "report_implementation_build");
	expect(reported).toEqual([
		["report_implementation_build", {
			id,
			state: "running",
			session: "implementation-acp-session",
			idempotencyKey: expect.any(String),
		}],
		["report_implementation_build", { id, state: "stopped", idempotencyKey: expect.any(String) }],
		["report_implementation_build", { id, state: "stopped", idempotencyKey: expect.any(String) }],
	]);
	// The retry is the same report, so Chopin can tell it from a second one.
	let [running, stopped, retried] = reported.map(([, args]) => args.idempotencyKey);
	expect(retried).toBe(stopped);
	expect(stopped).not.toBe(running);
});

test("a run out of reach for its whole grace period stops its agent", async () => {
	let { id, calls } = await run(
		{},
		["--hang"],
		name => {
			if (name === "renew_implementation_build") throw unreachable();
			return {};
		},
		undefined,
		{ random: () => 0.01, graceMs: 150 },
	);
	expect(calls.at(-1)).toEqual(["report_implementation_build", {
		id,
		state: "failed",
		error: "Chopin was out of reach for 0 seconds.",
	}]);
});

/** A call that never answers, as a request to a server that went away mid-response; only aborts. */
function hanging(signal?: AbortSignal) {
	return new Promise((_, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

/**
 * A fake Chopin that goes out of reach at the run's first heartbeat, which it refuses as an
 * unreachable server does, and stays out of reach for every later call but the run's failure
 * report: each gets `during`. The agent's session report may arrive during the outage, and
 * answering it would rightly tell the run Chopin is back and clear the grace period being timed.
 */
function outage(during: (signal?: AbortSignal) => unknown) {
	let times = { lost: 0, failed: 0 };
	let respond = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
		if (args.state === "failed") {
			times.failed = performance.now();
			return {};
		}
		if (times.lost) return during(signal);
		if (name !== "renew_implementation_build") return {};
		times.lost = performance.now();
		throw unreachable();
	};
	return { times, respond };
}

test("the grace period stops the agent on time while a retry waits longer than it", async () => {
	let { times, respond } = outage(() => {
		throw unreachable();
	});
	await run({}, ["--hang"], respond, undefined, { random: () => 0.999, graceMs: 100 });
	// The first retry would wait about a second; the agent stops when the grace period ends.
	expect(times.failed - times.lost).toBeGreaterThanOrEqual(90);
	expect(times.failed - times.lost).toBeLessThan(400);
});

test("the grace period stops the agent on time while a heartbeat hangs in flight", async () => {
	let { times, respond } = outage(hanging);
	let { calls } = await run({}, ["--hang"], respond, undefined, {
		random: () => 0.01,
		graceMs: 100,
	});
	// Timed from the loss, which is when the grace period starts, to the end of the run.
	expect(performance.now() - times.lost).toBeLessThan(1500);
	expect(calls.at(-1)?.[1]).toMatchObject({
		state: "failed",
		error: "Chopin was out of reach for 0 seconds.",
	});
});

test("a run Chopin has ended stops its agent at once", async () => {
	let { id, calls } = await run({}, ["--hang"], name => {
		if (name === "renew_implementation_build") {
			throw new ConnectorError("build-inactive", "build-inactive: build-inactive");
		}
		return {};
	});
	expect(calls.filter(([name]) => name === "renew_implementation_build")).toHaveLength(1);
	expect(calls.at(-1)).toEqual(["report_implementation_build", {
		id,
		state: "failed",
		error: "Chopin ended this run (build-inactive).",
	}]);
});

test(
	"a build carries agent activity on its heartbeat and stops when Chopin cancels it",
	async () => {
		let abort = new AbortController();
		let timer = setTimeout(() => abort.abort(), 15_000);
		try {
			let { calls } = await run({}, ["--hang", "--activity"], (name, args) => {
				if (name === "renew_implementation_build" && args.progress === "Running server tests") {
					throw new ConnectorError("build-inactive", "build-inactive");
				}
				return {};
			}, abort.signal);
			expect(
				calls.some(([name, args]) =>
					name === "renew_implementation_build" && args.progress === "Running server tests"
				),
			).toBe(true);
			expect(calls.at(-1)?.[1].error).toBe("Chopin ended this run (build-inactive).");
		} finally {
			clearTimeout(timer);
		}
	},
	20_000,
);

test("activity follows tool updates after a permission is answered", async () => {
	let descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
	let question = spyOn(Permission, "ask").mockResolvedValue("1");
	let abort = new AbortController();
	let timer = setTimeout(() => abort.abort(), 15_000);
	try {
		let { calls } = await run(
			{},
			["--hang", "--activity", "--permission-activity"],
			(name, args) => {
				if (name === "renew_implementation_build" && args.progress === "Checking test results") {
					throw new ConnectorError("build-inactive", "build-inactive");
				}
				return {};
			},
			abort.signal,
		);
		expect(question).toHaveBeenCalledTimes(1);
		expect(
			calls.some(([name, args]) =>
				name === "renew_implementation_build" && args.progress === "Checking test results"
			),
		).toBe(true);
	} finally {
		clearTimeout(timer);
		question.mockRestore();
		if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
		else Reflect.deleteProperty(process.stdin, "isTTY");
	}
}, 20_000);

test("a run whose connection a restarted server forgot stops its agent and the connector", async () => {
	let root = await mkdtemp(join(tmpdir(), "chopin-forgotten-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-forgotten-state-"));
	let id = crypto.randomUUID();
	let offered = false;
	let restartedAt = 0;
	let server = chopin(name => {
		if (name === "wait_for_work") {
			if (offered) return new Promise(() => {});
			offered = true;
			return { id, kind: "implementation" };
		}
		if (name === "claim_implementation_build") {
			return {
				build: {
					id,
					repositoryId: "R_repo",
					checkout: { repository: "org/repo", commit: git(root, "rev-parse", "HEAD") },
				},
				runToken: "run-token",
			};
		}
		// The server restarts after the first heartbeat and forgets this connection's token.
		if (name === "renew_implementation_build") restartedAt ||= performance.now();
		return {};
	}, () => restartedAt > 0);
	try {
		git(root, "init");
		git(root, "config", "user.name", "Fixture");
		git(root, "config", "user.email", "fixture@example.test");
		git(root, "remote", "add", "origin", "git@github.com:org/repo.git");
		await writeFile(join(root, "source.txt"), "committed");
		git(root, "add", ".");
		git(root, "commit", "-m", "fixture");
		let stream = { isTTY: false, write: () => {} };
		let output = createOutput(stream, stream, {});
		let signal = new AbortController().signal;
		await expect(serveWork({
			connect: () => remote(server.url, "token"),
			signal,
			output,
			random: () => 0.01,
			run: (api, kind, claim) =>
				runWork(api, kind, claim, {
					root,
					directory: state,
					command: [
						process.execPath,
						new URL("./testing/fake-implementer.ts", import.meta.url).pathname,
						"--hang",
					],
					url: server.url,
					signal,
					output,
					heartbeatMs: 20,
					random: () => 0.01,
					forgetMs: 300,
				}),
		})).rejects.toThrow("Chopin no longer recognizes this connection (it may have restarted).");
		expect(performance.now() - restartedAt).toBeLessThan(1500);
		expect(await processesIn(join(state, "runs", id))).toEqual([]);
	} finally {
		await server.stop();
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});
