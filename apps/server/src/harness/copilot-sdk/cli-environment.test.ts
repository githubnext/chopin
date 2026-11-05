import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultConnect } from "./adapter";

const FORWARDED = [
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"NO_PROXY",
	"https_proxy",
	"http_proxy",
	"no_proxy",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
];

const touched = [
	...FORWARDED,
	"COPILOT_CLI_PATH",
	"GITHUB_TOKEN",
	"CHOPIN_TEST_SECRET",
	"COPILOT_ENABLE_BUILTIN_GITHUB_MCP",
];

let saved = new Map<string, string | undefined>();
let scratch: string[] = [];

function setEnv(values: Record<string, string>): void {
	for (let name of touched) {
		if (!saved.has(name)) saved.set(name, process.env[name]);
		delete process.env[name];
	}
	for (let [name, value] of Object.entries(values)) process.env[name] = value;
}

afterEach(() => {
	for (let [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	saved.clear();
	for (let dir of scratch) rmSync(dir, { recursive: true, force: true });
	scratch = [];
});

/** A CLI stand-in that runs `body` under Bun with exactly the environment the SDK gives it. */
function fakeCli(body: string): string {
	let dir = mkdtempSync(join(tmpdir(), "chopin-fake-cli-"));
	scratch.push(dir);
	writeFileSync(join(dir, "cli.ts"), body);
	let path = join(dir, "cli");
	writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "cli.ts")}"\n`);
	chmodSync(path, 0o755);
	return path;
}

async function spawnCli(): Promise<void> {
	let source = defaultConnect();
	try {
		await source.client.start();
	} catch {
		// The stand-in exits without speaking the protocol; its side effects are what is checked.
	} finally {
		await source.client.forceStop();
		source.cleanup();
	}
}

async function cliEnvironment(): Promise<Record<string, string>> {
	let out = join(mkdtempSync(join(tmpdir(), "chopin-cli-env-")), "env.json");
	scratch.push(join(out, ".."));
	process.env.COPILOT_CLI_PATH = fakeCli(
		`import { writeFileSync } from "node:fs";\n`
			+ `writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));\n`,
	);
	await spawnCli();
	return JSON.parse(readFileSync(out, "utf8"));
}

describe("the Copilot CLI's environment", () => {
	it("carries the proxy and certificate variables the server has set, verbatim", async () => {
		let values: Record<string, string> = {};
		for (let name of FORWARDED) values[name] = `${name} value`;
		values.NO_PROXY = "";
		setEnv(values);
		let env = await cliEnvironment();
		for (let name of FORWARDED) expect(env[name]).toBe(values[name]);
		expect(env.COPILOT_PLUGIN_DIR_ONLY).toBe("true");
	});

	it("adds no variable the server has not set", async () => {
		setEnv({ HTTPS_PROXY: "http://proxy.test:3128" });
		let env = await cliEnvironment();
		expect(env.HTTPS_PROXY).toBe("http://proxy.test:3128");
		for (let name of FORWARDED.filter(name => name !== "HTTPS_PROXY")) {
			expect(name in env).toBe(false);
		}
	});

	it("passes nothing else from the server, secrets and the built-in GitHub MCP switch included", async () => {
		setEnv({
			HTTPS_PROXY: "http://proxy.test:3128",
			GITHUB_TOKEN: "ghp_not-for-the-cli",
			CHOPIN_TEST_SECRET: "not-for-the-cli",
			COPILOT_ENABLE_BUILTIN_GITHUB_MCP: "true",
		});
		let env = await cliEnvironment();
		expect(env.GITHUB_TOKEN).toBeUndefined();
		expect(env.CHOPIN_TEST_SECRET).toBeUndefined();
		expect(env.COPILOT_ENABLE_BUILTIN_GITHUB_MCP).toBeUndefined();
		expect(env.COPILOT_PLUGIN_DIR_ONLY).toBe("true");
		expect(JSON.stringify(env)).not.toContain("not-for-the-cli");
	});

	it("sends the CLI's own HTTPS requests through the proxy the server runs behind", async () => {
		let connects = Promise.withResolvers<string>();
		let proxy = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				data(socket, data) {
					let request = Buffer.from(data).toString("latin1");
					connects.resolve(request.split("\r\n")[0] ?? "");
					socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
				},
			},
		});
		try {
			setEnv({ HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` });
			process.env.COPILOT_CLI_PATH = fakeCli(
				`await fetch("https://api.github.com/copilot_internal/user").catch(() => {});\n`,
			);
			let timer: Timer | undefined;
			let timeout = new Promise<string>(resolve => {
				timer = setTimeout(() => resolve("no request reached the proxy"), 10_000);
			});
			let [, line] = await Promise.all([spawnCli(), Promise.race([connects.promise, timeout])]);
			clearTimeout(timer);
			expect(line).toBe("CONNECT api.github.com:443 HTTP/1.1");
		} finally {
			proxy.stop(true);
		}
	}, 20_000);
});
