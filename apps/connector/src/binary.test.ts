import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildBinaries, hostTarget } from "../scripts/build-binaries";
import { git } from "./workspace";

/**
 * The compiled `chopin` binary, as people install it. CI passes the release build through
 * CHOPIN_BINARY; otherwise this compiles one for the host into a temporary directory.
 */
let scratch = await mkdtemp(join(tmpdir(), "chopin-binary-"));
let binary = process.env.CHOPIN_BINARY ? resolve(process.env.CHOPIN_BINARY) : undefined;
if (!binary) {
	try {
		[binary] = await buildBinaries([hostTarget()], scratch);
	} catch (error) {
		console.warn(
			"Skipping the compiled chopin binary tests: `bun build --compile` is unavailable here.\n"
				+ (error instanceof Error ? error.message : String(error)),
		);
	}
}
let { version } = await Bun.file(join(import.meta.dir, "../package.json")).json() as {
	version: string;
};

afterAll(() => rm(scratch, { recursive: true, force: true }));

test.skipIf(!binary)("the compiled binary prints its version and connector protocol", () => {
	for (let flag of ["--version", "version"]) {
		let result = Bun.spawnSync([binary!, flag], { stdout: "pipe", stderr: "pipe" });
		expect(result.stderr.toString()).toBe("");
		expect(result.stdout.toString()).toBe(`chopin ${version} (connector protocol 1)\n`);
		expect(result.exitCode).toBe(0);
	}
	let help = Bun.spawnSync([binary!, "help"], { stdout: "pipe" });
	expect(help.stdout.toString()).toContain("Usage: chopin <command>");
	expect(help.exitCode).toBe(0);
});

test.skipIf(!binary)(
	"the compiled binary runs an investigation through its own stdio bridge",
	async () => {
		let root = await mkdtemp(join(scratch, "checkout-"));
		let state = await mkdtemp(join(scratch, "state-"));
		git(root, "init");
		git(root, "config", "user.name", "Fixture");
		git(root, "config", "user.email", "fixture@example.test");
		git(root, "remote", "add", "origin", "https://github.com/octo-org/score.git");
		await writeFile(join(root, "sample.txt"), "sample");
		git(root, "add", ".");
		git(root, "commit", "-m", "fixture");
		let input = {
			id: crypto.randomUUID(),
			documentId: crypto.randomUUID(),
			brief: "Produce the captured startup fixture",
			source: {
				repositoryId: "R_repo",
				repository: "octo-org/score",
				commit: git(root, "rev-parse", "HEAD"),
			},
			context: "",
			requester: "a",
			authorizer: "a",
		};
		// Who called which connector tool: the connection's token, or the run token the bridge holds.
		let calls: Array<[string, string]> = [];
		let offered = false;
		let finished = Promise.withResolvers<string>();
		let results: Record<string, () => unknown> = {
			wait_for_work: async () => {
				if (offered) return await Bun.sleep(100), {};
				offered = true;
				return { id: input.id, kind: "experiment" };
			},
			claim_experiment: () => ({ input, generation: 1, runToken: "run-token" }),
			read_experiment: () => ({ input }),
			complete_experiment: () => finished.resolve("complete_experiment"),
			fail_experiment: () => finished.resolve("fail_experiment"),
		};
		let chopin = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request): Promise<Response> {
				let path = new URL(request.url).pathname;
				if (path === "/api/connector/pairings") {
					return Response.json({
						id: "pairing",
						secret: "secret",
						url: `http://127.0.0.1:${chopin.port}/connect?pairing=pairing`,
						code: "ABCD-EFGH",
					});
				}
				if (path === "/api/connector/pairings/pairing/claim") {
					return Response.json({ token: "connection-token" });
				}
				let token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
				if (path !== "/connector/mcp" || !["connection-token", "run-token"].includes(token)) {
					return new Response(null, { status: 401 });
				}
				let server = new Server({ name: "fake-chopin", version: "1" }, {
					capabilities: { tools: {} },
				});
				server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
				server.setRequestHandler(CallToolRequestSchema, async request => {
					calls.push([token, request.params.name]);
					let result = await results[request.params.name]?.();
					return { content: [{ type: "text", text: JSON.stringify(result ?? {}) }] };
				});
				let transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: undefined,
					enableJsonResponse: true,
				});
				await server.connect(transport);
				return transport.handleRequest(request);
			},
		});
		// The agent is the stdio fixture: it starts whatever bridge command the connector offers.
		let connector = Bun.spawn([
			binary!,
			"connect",
			root,
			"--",
			process.execPath,
			join(import.meta.dir, "testing/fake-agent.ts"),
		], {
			env: {
				...process.env,
				CHOPIN_URL: `http://127.0.0.1:${chopin.port}`,
				CHOPIN_CONNECTOR_STATE_DIR: state,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			let outcome = await Promise.race([
				finished.promise,
				connector.exited.then(code => `connector exited ${code}`),
				Bun.sleep(30_000).then(() => "timed out"),
			]);
			connector.kill("SIGINT");
			let code = await connector.exited;
			let output = await new Response(connector.stdout).text()
				+ await new Response(connector.stderr).text();
			expect(outcome, output).toBe("complete_experiment");
			expect(calls.filter(([token]) => token === "run-token")).toEqual([
				["run-token", "read_experiment"],
				["run-token", "submit_experiment_result"],
			]);
			expect(calls.at(-1)).toEqual(["connection-token", "disconnect_workspace"]);
			expect(code, output).toBe(0);
		} finally {
			connector.kill("SIGKILL");
			await chopin.stop(true);
		}
	},
	60_000,
);
