/**
 * Refusing to start, comprehensibly.
 *
 * The working directory is handed to the agent's CLI as its own, so a path
 * that is not there kills that process the instant it spawns. What surfaces
 * from the SDK is a failure to write to a stream that is already gone, which
 * says nothing about paths and sends you looking in the wrong place. Checking
 * first costs a `stat`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe as description, load, problem } from "./config";

import type { Subprocess } from "bun";

let scratch: string[] = [];
let running: Subprocess[] = [];

afterEach(async () => {
	for (let server of running) server.kill();
	running = [];
	for (let dir of scratch) await rm(dir, { recursive: true, force: true });
	scratch = [];
});

async function temporary(): Promise<string> {
	let dir = await mkdtemp(join(tmpdir(), "chopin-config-"));
	scratch.push(dir);
	return dir;
}

/** Load configuration as it would be with these variables set. */
function configured(env: Record<string, string | undefined>) {
	let previous = { ...process.env };
	for (let [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return load();
	} finally {
		for (let key of Object.keys(env)) delete process.env[key];
		Object.assign(process.env, previous);
	}
}

describe("the working directory", () => {
	it("accepts one that is there", async () => {
		let dir = await temporary();
		expect(problem(configured({ WORKING_DIR: dir }))).toBeUndefined();
	});

	it("names the path when it is not there", () => {
		let missing = join(tmpdir(), "chopin-does-not-exist-9f3a");
		let complaint = problem(configured({ WORKING_DIR: missing }));

		expect(complaint).toContain("WORKING_DIR does not exist");
		// The resolved path, because the relative one the user typed is not
		// what went wrong — where it landed is.
		expect(complaint).toContain(missing);
	});

	it("refuses a file, which would spawn just as badly as a missing one", async () => {
		let dir = await temporary();
		let file = join(dir, "notes.md");
		await writeFile(file, "hello");

		expect(problem(configured({ WORKING_DIR: file }))).toContain("not a directory");
	});

	it("resolves a relative path against the current directory", () => {
		let config = configured({ WORKING_DIR: "." });
		expect(config.workingDir).toBe(process.cwd());
	});

	it("defaults to the installation rather than wherever it was started", () => {
		// Two levels up from `apps/server/src`, whatever the current directory is.
		expect(load().workingDir).toBe(join(import.meta.dir, "../../.."));
	});
});

describe("storage", () => {
	it("keeps the prototype filesystem unless a driver is selected", () => {
		let config = configured({ STORAGE_DRIVER: undefined, DATABASE_URL: undefined });
		expect(config.storage).toEqual({ driver: "legacy" });
	});

	it("accepts an explicit PostgreSQL database", () => {
		let config = configured({
			STORAGE_DRIVER: "postgres",
			DATABASE_URL: "postgresql://chopin:secret@database.test/chopin",
		});
		expect(config.storage).toEqual({
			driver: "postgres",
			url: "postgresql://chopin:secret@database.test/chopin",
		});
		expect(description(config)).toContain("storage: postgres");
		expect(description(config)).not.toContain("secret");
	});

	it("requires a database URL for PostgreSQL", () => {
		expect(() => configured({ STORAGE_DRIVER: "postgres", DATABASE_URL: undefined })).toThrow(
			"DATABASE_URL is required",
		);
	});

	it("refuses unsupported drivers and URL schemes", () => {
		expect(() => configured({ STORAGE_DRIVER: "cosmos" })).toThrow("STORAGE_DRIVER");
		expect(() => configured({ STORAGE_DRIVER: "postgres", DATABASE_URL: "https://database.test" }))
			.toThrow("PostgreSQL URL");
	});
});

describe("hosted authentication", () => {
	let key = "11".repeat(32);

	it("is deliberately off by default", () => {
		expect(configured({ AUTH_DRIVER: undefined }).auth).toEqual({ driver: "off" });
	});

	it("loads GitHub OAuth without exposing its secrets", () => {
		let config = configured({
			AUTH_DRIVER: "github",
			APP_ORIGIN: "https://chopin.example",
			GITHUB_OAUTH_CLIENT_ID: "client-id",
			GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
			SESSION_ENCRYPTION_KEY: key,
		});
		expect(config.auth.driver).toBe("github");
		expect(config.auth.driver === "github" && config.auth.origin).toBe("https://chopin.example");
		expect(description(config)).toContain("auth: github");
		expect(description(config)).not.toContain("client-secret");
		expect(description(config)).not.toContain(key);
	});

	it("requires complete secrets and an exact safe origin", () => {
		expect(() => configured({ AUTH_DRIVER: "github" })).toThrow("GITHUB_OAUTH_CLIENT_ID");
		let base = {
			AUTH_DRIVER: "github",
			GITHUB_OAUTH_CLIENT_ID: "client-id",
			GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
			SESSION_ENCRYPTION_KEY: key,
		};
		expect(() => configured({ ...base, APP_ORIGIN: "http://chopin.example" })).toThrow("HTTPS");
		expect(() => configured({ ...base, APP_ORIGIN: "https://chopin.example/path" })).toThrow(
			"only an HTTP or HTTPS origin",
		);
		expect(() => configured({ ...base, APP_ORIGIN: "http://127.0.0.1:8787" })).not.toThrow();
		expect(() =>
			configured({ ...base, APP_ORIGIN: "https://chopin.example", SESSION_ENCRYPTION_KEY: "short" })
		)
			.toThrow("32 bytes");
	});

	it("requires a durable adapter", () => {
		let config = configured({
			AUTH_DRIVER: "github",
			APP_ORIGIN: "https://chopin.example",
			GITHUB_OAUTH_CLIENT_ID: "client-id",
			GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
			SESSION_ENCRYPTION_KEY: key,
			STORAGE_DRIVER: "legacy",
		});
		expect(problem(config)).toContain("requires durable storage");
	});
});

describe("starting", () => {
	/**
	 * The failure this exists for, end to end: the server must refuse, say
	 * which variable and which path, and not leave the operator reading about
	 * destroyed streams.
	 */
	it("exits with the reason when the working directory is wrong", async () => {
		let missing = join(tmpdir(), "chopin-nowhere-4c21");

		let server = Bun.spawn(["bun", join(import.meta.dir, "main.ts")], {
			env: {
				...process.env,
				PORT: "8971",
				WORKING_DIR: missing,
				AGENT: "off",
				AUTH_DRIVER: "off",
				STORAGE_DRIVER: "legacy",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		running.push(server);

		let code = await server.exited;
		let said = await new Response(server.stderr as ReadableStream).text();

		expect(code).toBe(1);
		expect(said).toContain("WORKING_DIR does not exist");
		expect(said).toContain(missing);
	});
});
