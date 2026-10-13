import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runWork, STOPPED } from "./run";
import { git } from "./workspace";
import { ConnectorError } from "./mcp";
import type { remote } from "./mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Run one implementation claim against a fixture repository and record connector calls. */
async function run(
	build: { kind?: "rebuild"; live?: boolean },
	flags: string[],
	respond: (name: string, args: Record<string, unknown>) => unknown = () => ({}),
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
			call: async (name: string, args: Record<string, unknown> = {}) => {
				sent.push([name, args]);
				let { idempotencyKey: _key, ...rest } = args;
				calls.push([name, rest]);
				return respond(name, args);
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

test("a spike run serves connector-local tools to an HTTP agent over an authenticated loopback bridge", async () => {
	let root = await mkdtemp(join(tmpdir(), "chopin-spike-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-spike-state-"));
	let received: Array<[string, Record<string, unknown>]> = [];
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
				tools: ["upload_investigation_image", "submit_spike_result"].map(name => ({
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
			spike: true,
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
				"--spike",
			],
			url: `http://127.0.0.1:${chopin.port}`,
			signal: new AbortController().signal,
		});
		expect(calls.filter(name => name !== "renew_experiment")).toEqual(["complete_experiment"]);
		expect(received.map(([name]) => name)).toEqual([
			"upload_investigation_image",
			"submit_spike_result",
		]);
		expect(received[0][1]).toEqual({ data: "iVBORw0KGgo=", mimeType: "image/png" });
		// The bridge closes with the run.
		await expect(fetch(received[1][1].url as string, { method: "POST" })).rejects.toThrow();
	} finally {
		await chopin.stop(true);
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

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
