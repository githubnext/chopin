import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadAuth } from "./config";

let saved = { ...process.env };

function base(extra: Record<string, string> = {}) {
	for (let key of ["AUTH_MODE", "DEMO_PERSONAS"]) delete process.env[key];
	Object.assign(process.env, {
		GITHUB_APP_SLUG: "chopin-test",
		GITHUB_APP_CLIENT_ID: "client",
		GITHUB_APP_CLIENT_SECRET: "secret",
		APP_ORIGIN: "http://127.0.0.1:8787",
		SESSION_ENCRYPTION_KEY: "0".repeat(64),
		...extra,
	});
}

beforeEach(() => base());
afterEach(() => {
	process.env = { ...saved };
});

describe("DEMO_PERSONAS", () => {
	test("is off by default and when off", () => {
		expect(loadAuth(8787, "127.0.0.1").demoPersonas).toBeUndefined();
		base({ DEMO_PERSONAS: "off" });
		expect(loadAuth(8787, "127.0.0.1").demoPersonas).toBeUndefined();
	});

	test("on with local auth and loopback bind enables personas", () => {
		base({ AUTH_MODE: "local", DEMO_PERSONAS: "on" });
		expect(loadAuth(8787, "127.0.0.1").demoPersonas).toBe(true);
	});

	test("on without local auth refuses startup", () => {
		base({ DEMO_PERSONAS: "on" });
		expect(() => loadAuth(8787, "127.0.0.1")).toThrow("DEMO_PERSONAS=on requires AUTH_MODE=local");
	});

	test("on with a non-loopback bind refuses startup", () => {
		base({ AUTH_MODE: "local", DEMO_PERSONAS: "on" });
		expect(() => loadAuth(8787, "0.0.0.0")).toThrow("loopback");
	});

	test("other values refuse startup", () => {
		base({ AUTH_MODE: "local", DEMO_PERSONAS: "true" });
		expect(() => loadAuth(8787, "127.0.0.1")).toThrow("DEMO_PERSONAS must be on or off");
	});
});

describe("the GitHub App's own key", () => {
	let { generateKeyPairSync } = require("node:crypto") as typeof import("node:crypto");
	let pem = (type: "rsa" | "ec" = "rsa") =>
		(type === "rsa"
			? generateKeyPairSync("rsa", { modulusLength: 2048 })
			: generateKeyPairSync("ec", { namedCurve: "P-256" })).privateKey
			.export({ type: "pkcs8", format: "pem" }) as string;
	let clear = () => {
		for (let key of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_PRIVATE_KEY_FILE"]) {
			delete process.env[key];
		}
	};

	test("is optional", () => {
		clear();
		expect(loadAuth(8787, "127.0.0.1").app).toBeUndefined();
	});

	test("is read inline, with escaped newlines, or from a file", async () => {
		clear();
		let key = pem();
		base({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: key.replaceAll("\n", "\\n") });
		let inline = loadAuth(8787, "127.0.0.1").app!;
		expect(inline.id).toBe("12345");
		expect(inline.privateKey.asymmetricKeyType).toBe("rsa");
		clear();
		let file = `${require("node:os").tmpdir()}/chopin-app-key-${crypto.randomUUID()}.pem`;
		await Bun.write(file, key);
		try {
			base({ GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY_FILE: file });
			expect(loadAuth(8787, "127.0.0.1").app!.id).toBe("12345");
		} finally {
			require("node:fs").rmSync(file, { force: true });
		}
	});

	test("refuses startup when half set, ambiguous, unreadable or not an RSA key, never echoing it", () => {
		let key = pem();
		for (
			let [extra, message] of ([
				[{ GITHUB_APP_ID: "12345" }, "needs GITHUB_APP_PRIVATE_KEY"],
				[{ GITHUB_APP_PRIVATE_KEY: key }, "GITHUB_APP_ID must be"],
				[{ GITHUB_APP_ID: "app", GITHUB_APP_PRIVATE_KEY: key }, "GITHUB_APP_ID must be"],
				[
					{ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: key, GITHUB_APP_PRIVATE_KEY_FILE: "/x" },
					"not both",
				],
				[
					{ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY_FILE: "/nonexistent/key.pem" },
					"can't be read",
				],
				[{ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "not a key" }, "must be a PEM"],
				[{ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: pem("ec") }, "must be an RSA key"],
			] as [Record<string, string>, string][])
		) {
			clear();
			base(extra);
			let thrown = (() => {
				try {
					loadAuth(8787, "127.0.0.1");
				} catch (error) {
					return (error as Error).message;
				}
			})();
			expect(thrown).toContain(message);
			expect(thrown).not.toContain("PRIVATE KEY-----");
			expect(thrown).not.toContain("/nonexistent");
		}
	});
});
