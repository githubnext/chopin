import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_UPDATE_REQUIRED,
	CONNECTOR_VERSION_HEADER,
} from "@chopin/protocol/connector";
import { CONNECTOR_PROTOCOL, VERSION } from "./version";
import { git } from "./workspace";

let scratch = await mkdtemp(join(tmpdir(), "chopin-main-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

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

const MESSAGE = "chopin 0.0.1 speaks connector protocol 0, but this server needs protocol 1. "
	+ "Run `chopin update 0.1.3`, then connect again.";

/**
 * `connect` against a fake Chopin that refuses the connector's version at `refuse`: the pairing
 * request or the first connector call. Records each request with the version headers it carried.
 */
async function connect(
	refuse: "pairing" | "connector",
	args?: string[],
	state?: string,
) {
	let requests: Array<[string, string | null, string | null]> = [];
	let chopin = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			let path = new URL(request.url).pathname;
			requests.push([
				path,
				request.headers.get(CONNECTOR_VERSION_HEADER),
				request.headers.get(CONNECTOR_PROTOCOL_HEADER),
			]);
			if (
				refuse === "pairing" && path === "/api/connector/pairings"
				|| refuse === "connector" && path === "/connector/mcp"
			) {
				return Response.json({ error: CONNECTOR_UPDATE_REQUIRED, message: MESSAGE }, {
					status: 409,
				});
			}
			if (path === "/api/connector/pairings") {
				return Response.json({ id: "pairing", secret: "secret", url: "http://x", code: "AB" });
			}
			if (path === "/api/connector/pairings/pairing/claim") {
				return Response.json({ token: `chopin_m_${"M".repeat(43)}` });
			}
			if (path === "/api/connector/connections") {
				return Response.json({ token: "connection-token" });
			}
			return new Response(null, { status: 404 });
		},
	});
	let directory = state ?? await mkdtemp(join(scratch, "state-"));
	let connector = Bun.spawn([
		process.execPath,
		"--no-env-file",
		join(import.meta.dir, "main.ts"),
		"connect",
		...args ?? [await checkout(), "--", "agent"],
	], {
		env: {
			...process.env,
			CHOPIN_URL: `http://127.0.0.1:${chopin.port}`,
			CHOPIN_CONNECTOR_STATE_DIR: directory,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		let code = await Promise.race([connector.exited, Bun.sleep(20_000).then(() => "timed out")]);
		return {
			code,
			stdout: await new Response(connector.stdout).text(),
			stderr: await new Response(connector.stderr).text(),
			requests,
			directory,
		};
	} finally {
		connector.kill("SIGKILL");
		await chopin.stop(true);
	}
}

test("connect sends its version and protocol, and stops on a refusal at pairing", async () => {
	let result = await connect("pairing");
	expect(result.code).toBe(1);
	expect(result.stderr).toBe(`${MESSAGE}\n`);
	expect(result.requests).toEqual([
		["/api/connector/pairings", VERSION, String(CONNECTOR_PROTOCOL)],
	]);
});

test("connect stops without retrying when the connector endpoint refuses its version", async () => {
	let result = await connect("connector");
	expect(result.code).toBe(1);
	expect(result.stderr).toBe(`${MESSAGE}\n`);
	let headers = [VERSION, String(CONNECTOR_PROTOCOL)] as const;
	expect(result.requests).toEqual([
		["/api/connector/pairings", ...headers],
		["/api/connector/pairings/pairing/claim", ...headers],
		["/api/connector/connections", ...headers],
		["/connector/mcp", ...headers],
	]);
});

test("connect saves the checkout, agent and Planner it runs, which connect --service runs", async () => {
	let root = await checkout();
	let planner = ["--planner", "https://chopin.example/d/one", "--planner-command", "planner --x"];
	let started = await connect("pairing", [root, ...planner, "--", "agent", "--acp"]);
	expect(started.stderr).toBe(`${MESSAGE}\n`);
	let file = join(started.directory, "config.json");
	expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
		connect: {
			checkout: await realpath(root),
			command: ["agent", "--acp"],
			planners: ["https://chopin.example/d/one"],
			plannerCommand: ["planner", "--x"],
		},
	});
	expect((await stat(file)).mode & 0o777).toBe(0o600);

	// The service has no terminal to pair on, so getting that far shows it read what was saved.
	let service = await connect("pairing", ["--service"], started.directory);
	expect(service.stderr).toContain("This machine is not paired with");
	expect(service.requests).toEqual([]);
	for (let args of [["--service", root], ["--service", "--", "agent"], ["--service", ...planner]]) {
		let refused = await connect("pairing", args, started.directory);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("connect --service takes no other arguments");
	}
});

test("connect --service stops until connect has saved what it runs", async () => {
	let result = await connect("pairing", ["--service"]);
	expect(result.code).toBe(1);
	expect(result.stderr).toBe(
		"Run chopin connect once in your checkout first (it saves what the service runs), then "
			+ "chopin service install.\n",
	);
	expect(result.requests).toEqual([]);
});

test("connect on a checkout the running service holds saves its settings for a restart", async () => {
	let root = await realpath(await checkout());
	let directory = await mkdtemp(join(scratch, "state-"));
	let lock = (service: boolean) =>
		writeFile(
			join(directory, `${new Bun.CryptoHasher("sha256").update(root).digest("hex")}.lock`),
			JSON.stringify({ pid: process.pid, root, ...(service ? { service } : {}) }),
		);
	// A terminal's connect holds it: refused as before, and nothing is saved.
	await lock(false);
	let refused = await connect("pairing", [root, "--", "agent"], directory);
	expect(refused.code).toBe(1);
	expect(refused.stderr).toContain("Workspace already locked");
	expect(await Bun.file(join(directory, "config.json")).exists()).toBe(false);

	await lock(true);
	let saved = await connect("pairing", [root, "--", "new-agent", "--acp"], directory);
	expect(saved.code).toBe(0);
	expect(saved.stdout).toContain(
		"The chopin service is running this checkout. Saved your settings; run chopin service "
			+ "restart to use them.",
	);
	expect(saved.requests).toEqual([]);
	expect(JSON.parse(await readFile(join(directory, "config.json"), "utf8")).connect).toEqual({
		checkout: root,
		command: ["new-agent", "--acp"],
		planners: [],
		plannerCommand: [],
	});
	// Arguments connect refuses are never saved.
	let invalid = await connect(
		"pairing",
		[root, "--planner", "https://x/d/1", "--", "a"],
		directory,
	);
	expect(invalid.code).toBe(1);
	expect(JSON.parse(await readFile(join(directory, "config.json"), "utf8")).connect.command)
		.toEqual(["new-agent", "--acp"]);
});
