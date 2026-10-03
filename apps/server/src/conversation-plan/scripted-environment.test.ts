import { expect, it } from "bun:test";
import { join } from "node:path";

import {
	requireScriptedServer,
	SCRIPTED_HARNESS,
} from "../../../../e2e/harness/scripted-environment";

let root = "/offline/chopin";
let approved: Record<string, string | undefined> = {
	E2E_CONVERSATION_PLAN: "1",
	SERVER_HOST: "127.0.0.1",
	PORT: "8788",
	APP_ORIGIN: "http://127.0.0.1:8788",
	AGENT: "on",
	CONVERSATION_PLAN: "on",
	HARNESS: SCRIPTED_HARNESS,
	HARNESS_AUTH: "direct",
	JEV_API_KEY: "e2e-jev-only",
	JEV_MODEL: "jev-e2e",
	TYPESAFE_API_KEY: "",
	HTTP_PROXY: "",
	HTTPS_PROXY: "",
	ALL_PROXY: "",
	http_proxy: "",
	https_proxy: "",
	all_proxy: "",
	NO_PROXY: "*",
	no_proxy: "*",
	E2E_PLANNER_JOBS_DIR: join(root, "e2e", "test-results", "planner-jobs"),
	E2E_JEV_CONTROL_DIR: join(root, "e2e", "test-results", "jev-control"),
	STORAGE_DRIVER: "postgres",
	DATABASE_URL: "postgresql://test:fake-password@127.0.0.1:5433/chopin?sslmode=disable",
	SESSION_ENCRYPTION_KEY: "a".repeat(64),
};

it("accepts the explicitly selected local test environment without changing its input", () => {
	let env = Object.freeze({ ...approved });
	expect(() => requireScriptedServer(env, root)).not.toThrow();
	expect(env).toEqual(approved);
});

let rejected: Array<[string, string | undefined]> = [
	["E2E_CONVERSATION_PLAN", undefined],
	["E2E_CONVERSATION_PLAN", "true"],
	["SERVER_HOST", "0.0.0.0"],
	["SERVER_HOST", "localhost"],
	["PORT", "8792"],
	["PORT", "08788"],
	["APP_ORIGIN", "http://localhost:8788"],
	["APP_ORIGIN", "http://127.0.0.1:8788/"],
	["AGENT", "off"],
	["CONVERSATION_PLAN", "off"],
	["HARNESS", "e2e-fake"],
	["HARNESS_AUTH", "auto"],
	["JEV_API_KEY", "real-provider-secret"],
	["JEV_MODEL", "real-model"],
	["TYPESAFE_API_KEY", "real-provider-secret"],
	["TYPESAFE_API_KEY", undefined],
	["E2E_PLANNER_JOBS_DIR", "/tmp/planner-jobs"],
	["E2E_PLANNER_JOBS_DIR", `${approved.E2E_PLANNER_JOBS_DIR}/`],
	["E2E_JEV_CONTROL_DIR", "/tmp/jev-control"],
	["STORAGE_DRIVER", "memory"],
	["SESSION_ENCRYPTION_KEY", undefined],
	["SESSION_ENCRYPTION_KEY", ""],
	["SESSION_ENCRYPTION_KEY", "  "],
	["SESSION_ENCRYPTION_KEY", "a".repeat(63)],
	["SESSION_ENCRYPTION_KEY", "z".repeat(64)],
	["DATABASE_URL", undefined],
	["DATABASE_URL", "not-a-url"],
	["DATABASE_URL", "https://127.0.0.1/chopin"],
	["DATABASE_URL", "postgresql://test:fake-password@remote.example/chopin"],
	["DATABASE_URL", "postgresql://test:fake-password@127.0.0.1/"],
	["DATABASE_URL", "postgresql://test:fake-password@127.0.0.1/chopin?host=remote.example"],
	["DATABASE_URL", "postgresql://test:fake-password@127.0.0.1/chopin?hostaddr=192.0.2.1"],
	["DATABASE_URL", "postgresql://test:fake-password@127.0.0.1/chopin?service=production"],
];

for (let [index, [name, value]] of rejected.entries()) {
	it(`refuses invalid ${name} (${index}) before caller effects`, () => {
		let effects = 0;
		let env = { ...approved, [name]: value };
		expect(() => {
			requireScriptedServer(env, root);
			effects++;
		}).toThrow(name);
		expect(effects).toBe(0);
	});
}

it("never includes supplied database or provider secrets in refusal messages", () => {
	for (let name of ["DATABASE_URL", "JEV_API_KEY", "TYPESAFE_API_KEY"]) {
		let failure: unknown;
		try {
			requireScriptedServer({ ...approved, [name]: "confidential-test-value" }, root);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toContain("confidential-test-value");
	}
});

it("accepts supplied local PostgreSQL URLs without contacting their database", () => {
	for (let host of ["127.0.0.1", "localhost", "[::1]"]) {
		for (let protocol of ["postgres", "postgresql"]) {
			expect(() =>
				requireScriptedServer({
					...approved,
					DATABASE_URL: `${protocol}://test:fake-password@${host}:5433/chopin`,
				}, root)
			).not.toThrow();
		}
	}
});

let proxyNames = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
];
for (let name of proxyNames) {
	for (
		let value of [undefined, " ", "http://proxy-user:confidential-proxy-secret@proxy.invalid:8080"]
	) {
		it(`refuses transport proxy ${name} (${value === undefined ? "missing" : value === " " ? "blank" : "set"}) before caller effects`, () => {
			let effects = 0;
			expect(() => {
				requireScriptedServer({ ...approved, [name]: value }, root);
				effects++;
			}).toThrow(name);
			expect(effects).toBe(0);
		});
	}
}

for (let name of ["NO_PROXY", "no_proxy"]) {
	for (let [index, value] of [undefined, "", "127.0.0.1", " * "].entries()) {
		it(`requires universal transport proxy bypass ${name} (${index}) before caller effects`, () => {
			let effects = 0;
			expect(() => {
				requireScriptedServer({ ...approved, [name]: value }, root);
				effects++;
			}).toThrow(name);
			expect(effects).toBe(0);
		});
	}
}

it("never includes supplied transport proxy secrets in refusal messages", () => {
	for (let name of [...proxyNames, "NO_PROXY", "no_proxy"]) {
		let failure: unknown;
		try {
			requireScriptedServer({
				...approved,
				[name]: "http://proxy-user:confidential-proxy-secret@proxy.invalid:8080",
			}, root);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain(name);
		expect((failure as Error).message).not.toContain("proxy-user");
		expect((failure as Error).message).not.toContain("confidential-proxy-secret");
		expect((failure as Error).message).not.toContain("proxy.invalid");
	}
});
