import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { compiledChopin } from "./testing/binary";
import { git } from "./workspace";

let scratch = await mkdtemp(join(tmpdir(), "chopin-binary-"));
let binary = await compiledChopin(scratch);
let { version } = await Bun.file(join(import.meta.dir, "../package.json")).json() as {
	version: string;
};

afterAll(() => rm(scratch, { recursive: true, force: true }));

/** A committed checkout whose origin is github.com/octo-org/score. */
async function checkout() {
	let root = await mkdtemp(join(scratch, "checkout-"));
	git(root, "init");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "user.email", "fixture@example.test");
	git(root, "remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "sample.txt"), "sample");
	git(root, "add", ".");
	git(root, "commit", "-m", "fixture");
	return root;
}

test.skipIf(!binary)("the compiled binary prints its version", () => {
	for (let flag of ["--version", "version"]) {
		let result = Bun.spawnSync([binary!, flag], { stdout: "pipe", stderr: "pipe" });
		expect(result.stderr.toString()).toBe("");
		expect(result.stdout.toString()).toBe(`chopin ${version}\n`);
		expect(result.exitCode).toBe(0);
	}
	let help = Bun.spawnSync([binary!, "help"], { stdout: "pipe" });
	expect(help.stdout.toString()).toContain("Usage: chopin <command>");
	expect(help.exitCode).toBe(0);
});

test.skipIf(!binary)(
	"service install uses the server chopin connect saved, and refuses a different CHOPIN_URL",
	async () => {
		let directory = await mkdtemp(join(scratch, "state-"));
		let saved = "https://chopin.example";
		let install = (url?: string) => {
			let env: Record<string, string | undefined> = {
				...process.env,
				CHOPIN_CONNECTOR_STATE_DIR: directory,
				CHOPIN_URL: url,
			};
			if (!url) delete env.CHOPIN_URL;
			let result = Bun.spawnSync([binary!, "service", "install"], {
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			return { code: result.exitCode, stderr: result.stderr.toString() };
		};
		expect(install()).toEqual({
			code: 1,
			stderr: "Run chopin connect once in your checkout first, then chopin service install.\n",
		});
		let settings = { server: saved, checkout: scratch, command: ["agent"], planners: [] };
		await writeFile(
			join(directory, "config.json"),
			JSON.stringify({ connect: { ...settings, plannerCommand: [] } }),
		);
		expect(install("https://other.example")).toEqual({
			code: 1,
			stderr: `CHOPIN_URL is https://other.example, but chopin connect saved ${saved}. Nothing `
				+ "was installed. Run chopin connect again with the server you want, then chopin "
				+ "service install.\n",
		});
		// With CHOPIN_URL unset, or naming the saved server, install goes on with the saved server
		// as far as the pairing it checks before touching the service manager.
		for (let url of [undefined, `${saved}/`]) {
			expect(install(url)).toEqual({
				code: 1,
				stderr: `This machine is not paired with ${saved}. Run \`chopin pair\` first, then `
					+ "install the service.\n",
			});
		}
	},
	60_000,
);

test.skipIf(!binary)(
	"the compiled binary runs an investigation through its own stdio bridge",
	async () => {
		let root = await checkout();
		let state = await mkdtemp(join(scratch, "state-"));
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
			read_investigation: () => ({ input }),
			upload_investigation_image: () => ({ path: `/images/${"a".repeat(64)}.png` }),
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
					return Response.json({ token: `chopin_m_${"M".repeat(43)}` });
				}
				if (path === "/api/connector/connections") {
					return Response.json({ token: "connection-token" });
				}
				let token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
				if (path !== "/connector/mcp" || !["connection-token", "run-token"].includes(token)) {
					return new Response(null, { status: 401 });
				}
				let server = new Server({ name: "fake-chopin", version: "1" }, {
					capabilities: { tools: {} },
				});
				server.setRequestHandler(ListToolsRequestSchema, () => ({
					tools: [
						"read_investigation",
						"upload_investigation_image",
						"submit_investigation_result",
					].map(name => ({ name, inputSchema: { type: "object" as const } })),
				}));
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
			"--stdio-images",
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
				["run-token", "read_investigation"],
				["run-token", "upload_investigation_image"],
				["run-token", "submit_investigation_result"],
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

test.skipIf(!binary)(
	"the compiled binary ignores the .env and bunfig.toml of the checkout it runs in",
	async () => {
		let root = await checkout();
		// Where the checkout's .env would send the pairing request.
		let captured: string[] = [];
		let capture = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				captured.push(`${request.method} ${new URL(request.url).pathname}`);
				return new Response(null, { status: 500 });
			},
		});
		// With CHOPIN_URL unset the binary uses its default origin; this proxy keeps that request
		// on the machine and records where it was going.
		let proxied: string[] = [];
		let proxy = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					proxied.push(data.toString().split("\r\n")[0]!);
					socket.end();
				},
			},
		});
		let marker = join(scratch, `preloaded-${crypto.randomUUID()}`);
		await writeFile(join(root, ".env"), `CHOPIN_URL=http://127.0.0.1:${capture.port}\n`);
		await writeFile(join(root, "bunfig.toml"), `preload = ["./preload.js"]\n`);
		await writeFile(
			join(root, "preload.js"),
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
		);
		let env: Record<string, string | undefined> = {
			...process.env,
			CHOPIN_CONNECTOR_STATE_DIR: await mkdtemp(join(scratch, "state-")),
			HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
		};
		let proxies = ["HTTP_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];
		for (let name of ["CHOPIN_URL", "NO_PROXY", "no_proxy", ...proxies]) delete env[name];
		let connector = Bun.spawn([binary!, "connect", ".", "--", "agent"], {
			cwd: root,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			let code = await Promise.race([connector.exited, Bun.sleep(30_000).then(() => "timed out")]);
			let output = await new Response(connector.stdout).text()
				+ await new Response(connector.stderr).text();
			expect(code, output).toBe(1);
			expect(captured).toEqual([]);
			expect(proxied).toEqual(["CONNECT chopin.githubnext.com:443 HTTP/1.1"]);
			expect(existsSync(marker)).toBe(false);
		} finally {
			connector.kill("SIGKILL");
			await capture.stop(true);
			proxy.stop(true);
		}
	},
	60_000,
);
