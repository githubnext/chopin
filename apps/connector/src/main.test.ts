import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
	+ "Run `chopin update` to install the newest chopin, then connect again.";

/**
 * `connect` against a fake Chopin that refuses the connector's version at `refuse`: the pairing
 * request or the first connector call. Records each request with the version headers it carried.
 */
async function connect(refuse: "pairing" | "connector") {
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
				return Response.json({ token: "connection-token" });
			}
			return new Response(null, { status: 404 });
		},
	});
	let connector = Bun.spawn([
		process.execPath,
		"--no-env-file",
		join(import.meta.dir, "main.ts"),
		"connect",
		await checkout(),
		"--",
		"agent",
	], {
		env: {
			...process.env,
			CHOPIN_URL: `http://127.0.0.1:${chopin.port}`,
			CHOPIN_CONNECTOR_STATE_DIR: await mkdtemp(join(scratch, "state-")),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	try {
		let code = await Promise.race([connector.exited, Bun.sleep(20_000).then(() => "timed out")]);
		return {
			code,
			stderr: await new Response(connector.stderr).text(),
			requests,
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
		["/connector/mcp", ...headers],
	]);
});
