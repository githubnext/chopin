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
