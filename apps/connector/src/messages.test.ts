import { afterAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { CONNECTOR_UPDATE_REQUIRED } from "@chopin/protocol/connector";
import { git } from "./workspace";

/**
 * Each way the one-command setup can fail before the machine connects, as `chopin connect`
 * reports it: what is wrong, then the command that fixes it. Never the key.
 */
let scratch = await mkdtemp(join(tmpdir(), "chopin-messages-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const KEY = `chopin_k_${"K".repeat(43)}`;
const MACHINE = `chopin_m_${"M".repeat(43)}`;

async function checkout(origin = "https://github.com/octo-org/score.git") {
	let root = await mkdtemp(join(scratch, "checkout-"));
	git(root, "init");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "user.email", "fixture@example.test");
	git(root, "remote", "add", "origin", origin);
	await writeFile(join(root, "sample.txt"), "sample");
	git(root, "add", ".");
	git(root, "commit", "-m", "fixture");
	return root;
}

/** A directory of programs, first on PATH: a stand-in `agent`, git, and whatever a case adds. */
async function programs(extra: Record<string, string> = {}) {
	let bin = await mkdtemp(join(scratch, "bin-"));
	let files = { agent: "#!/bin/sh\n", ...extra };
	for (let [name, body] of Object.entries(files)) {
		await writeFile(join(bin, name), body);
		await chmod(join(bin, name), 0o755);
	}
	return [bin, dirname(Bun.which("git")!)].join(delimiter);
}

/** `chopin connect` against a fake Chopin answering pairing with `pairing`. */
async function connect(
	options: {
		args?: (root: string) => string[];
		cwd?: string;
		path?: string;
		pairing?: () => Response;
		paired?: boolean;
		url?: string;
		origin?: string;
	} = {},
) {
	let requests: string[] = [];
	let chopin = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			let path = new URL(request.url).pathname;
			requests.push(path);
			if (path === "/api/connector/pairings") {
				return options.pairing?.() ?? Response.json({ token: MACHINE });
			}
			// Every case stops before it connects; a stored token is refused, as when revoked.
			return Response.json({ error: "machine-revoked" }, { status: 401 });
		},
	});
	let home = await mkdtemp(join(scratch, "home-"));
	let url = options.url ?? `http://127.0.0.1:${chopin.port}`;
	if (options.paired) {
		await writeFile(
			join(home, "machine.json"),
			JSON.stringify({ servers: { [url]: { token: MACHINE, label: "box" } } }),
		);
	}
	let root = options.cwd ?? await checkout(options.origin);
	let child = Bun.spawn([
		process.execPath,
		join(import.meta.dir, "main.ts"),
		"connect",
		...(options.args?.(root) ?? [root, "--", "agent"]),
	], {
		cwd: root,
		env: {
			HOME: home,
			CHOPIN_HOME: home,
			CHOPIN_URL: url,
			CHOPIN_PAIRING_KEY: KEY,
			NO_COLOR: "1",
			PATH: options.path ?? await programs(),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		let code = await Promise.race([child.exited, Bun.sleep(20_000).then(() => "timed out")]);
		let output = await new Response(child.stdout).text() + await new Response(child.stderr).text();
		return { code, output, requests };
	} finally {
		child.kill("SIGKILL");
		await chopin.stop(true);
	}
}

let refused = (status: number, body: Record<string, unknown>) => () =>
	Response.json(body, { status });

const CASES: Array<{
	name: string;
	run: () => ReturnType<typeof connect>;
	says: string[];
}> = [
	{
		name: "the agent isn't installed",
		run: async () =>
			connect({ args: root => [root, "--", "copilot", "--acp"], path: await programs() }),
		says: [
			"copilot isn't installed",
			"needs Node.js 22 or newer",
			"  npm install -g @github/copilot",
			"  copilot login",
			"Then run this command again.",
		],
	},
	{
		name: "the agent isn't installed, nor is npm",
		run: async () => connect({ args: root => [root, "--", "gemini"], path: await programs() }),
		says: ["gemini isn't installed", "npm comes with Node.js", "https://nodejs.org"],
	},
	{
		name: "the agent's Node.js is too old",
		run: async () =>
			connect({
				args: root => [root, "--", "atomic-acp"],
				path: await programs({
					"atomic-acp": "#!/usr/bin/env node\n",
					node: "#!/bin/sh\necho v21.7.3\n",
				}),
			}),
		says: [
			"Atomic needs Node.js 22.19 or newer; this machine has 21.7.3",
			"https://nodejs.org",
			"Then run this command again.",
		],
	},
	{
		name: "not inside a git checkout",
		run: async () => {
			let empty = await mkdtemp(join(scratch, "plain-"));
			return connect({ cwd: empty, args: () => [".", "--", "agent"] });
		},
		says: [
			"isn't inside a git checkout",
			"cd into your repository's folder",
			"run this command again",
		],
	},
	{
		name: "the origin isn't on github.com",
		run: () => connect({ origin: "https://gitlab.com/octo-org/score.git" }),
		says: ["isn't a github.com repository", "git remote -v"],
	},
	{
		name: "Chopin can't be reached",
		run: () => connect({ url: "http://127.0.0.1:9" }),
		says: ["Can't reach Chopin at http://127.0.0.1:9", "CHOPIN_URL", "run this command again"],
	},
	{
		name: "the key was used, replaced, expired, or is for another server",
		run: () => connect({ pairing: refused(403, { error: "pairing-key-invalid" }) }),
		says: ["Chopin refused the pairing key", "Machines → Add a machine"],
	},
	{
		name: "the key's account can't push to the checkout",
		run: () => connect({ pairing: refused(403, { error: "repository-forbidden" }) }),
		says: ["can't push to octo-org/score", "run this command again"],
	},
	{
		name: "the server needs a newer chopin",
		run: () =>
			connect({
				pairing: refused(409, {
					error: CONNECTOR_UPDATE_REQUIRED,
					message: "chopin 0.0.1 speaks connector protocol 1, but this server needs protocol 2. "
						+ "Run `chopin update 0.2.0`, then connect again.",
				}),
			}),
		says: ["chopin update 0.2.0"],
	},
	{
		name: "a program the Machines page doesn't offer is missing",
		run: () => connect({ args: root => [root, "--", "missing-for-sure"] }),
		says: ["missing-for-sure isn't on your PATH", "give its full path"],
	},
];

for (let { name, run, says } of CASES) {
	test(`when ${name}, connect says what to run next`, async () => {
		let result = await run();
		expect(result.code, result.output).toBe(1);
		for (let words of says) expect(result.output).toContain(words);
		expect(result.output).not.toContain(KEY);
	}, 30_000);
}

test("a machine paired already says how to pair it for the key's account instead", async () => {
	let result = await connect({ paired: true });
	// It connects with the stored token, which the fake refuses, so it stops; the note came first.
	expect(result.output).toContain("so the pairing key wasn't used");
	expect(result.output).toMatch(/run `[^`]* unpair`, then this command again/);
	expect(result.requests).not.toContain("/api/connector/pairings");
}, 30_000);

test("each case leaves the key unsent unless pairing itself refused it", async () => {
	let missing = await connect({ args: root => [root, "--", "copilot"], path: await programs() });
	expect(missing.requests).toEqual([]);
	let notCheckout = await connect({
		cwd: await mkdtemp(join(scratch, "plain-")),
		args: () => [".", "--", "agent"],
	});
	expect(notCheckout.requests).toEqual([]);
});

test("the setup guide's troubleshooting table names each of these messages", async () => {
	let guide = await Bun.file(join(import.meta.dir, "../../../docs/chopin-cli.md")).text();
	let table = guide.slice(guide.indexOf("| Message starts with"));
	for (
		let fragment of [
			"isn't installed",
			"needs Node.js",
			"isn't inside a git checkout",
			"isn't a github.com repository",
			"Can't reach Chopin at",
			"Chopin refused the pairing key",
			"can't push to",
			"speaks connector protocol",
			"didn't answer ACP initialize",
			"asks for permission in the terminal",
			"This machine is already paired with",
		]
	) {
		expect(table).toContain(fragment);
		expect(
			CASES.some(item => item.says.some(says => says.includes(fragment))) || [
				"speaks connector protocol",
				"didn't answer ACP initialize",
				"asks for permission in the terminal",
				"This machine is already paired with",
			].includes(fragment),
		).toBe(true);
	}
});
