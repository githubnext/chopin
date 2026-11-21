import { afterAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compiledChopin } from "./testing/binary";
import { machineReport } from "./sandbox";
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

test.skipIf(!binary)(
	"the compiled binary says where this machine's agents run: each in its own microVM, or why it can't",
	() => {
		let result = Bun.spawnSync([binary!, "status", "--json"], {
			env: {
				...process.env,
				CHOPIN_CONNECTOR_STATE_DIR: scratch,
				CHOPIN_URL: "http://127.0.0.1:9",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.stderr.toString()).toBe("");
		// It reads this machine as this process does: the same user, the same hypervisor device.
		expect(JSON.parse(result.stdout.toString()).sandbox).toEqual(machineReport());
	},
);

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
			stderr: "Run chopin connect once first, then chopin service install.\n",
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
		// `update` asks the server which chopin to install before anything else, wherever it runs.
		let connector = Bun.spawn([binary!, "update", "--yes"], {
			cwd: root,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			let code = await Promise.race([connector.exited, Bun.sleep(30_000).then(() => "timed out")]);
			let output = await new Response(connector.stdout).text()
				+ await new Response(connector.stderr).text();
			expect(code, output).not.toBe(0);
			expect(captured).toEqual([]);
			// It asks the default server first, never the one the checkout's .env names.
			expect(proxied[0]).toBe("CONNECT chopin.githubnext.com:443 HTTP/1.1");
			expect(existsSync(marker)).toBe(false);
		} finally {
			connector.kill("SIGKILL");
			await capture.stop(true);
			proxy.stop(true);
		}
	},
	60_000,
);
