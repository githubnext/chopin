import { describe, expect, it } from "bun:test";
import { delimiter } from "node:path";

import { describe as description } from "./config";
import { configured, LOCAL, REQUIRED } from "./testing/config";

describe("configuration", () => {
	it("loads the mandatory GitHub and PostgreSQL services without printing secrets", () => {
		let config = configured();
		expect(config.storage).toEqual({
			driver: "postgres",
			url: REQUIRED.DATABASE_URL,
		});
		expect(config.auth.origin).toBe(REQUIRED.APP_ORIGIN);
		expect(description(config)).toContain("auth: github");
		expect(description(config)).toContain("storage: postgres");
		expect(description(config)).not.toContain("secret");
		expect(description(config)).not.toContain(REQUIRED.SESSION_ENCRYPTION_KEY);
	});

	it("defaults the built-in adapter to PostgreSQL", () => {
		expect(configured({ STORAGE_DRIVER: undefined }).storage.driver).toBe("postgres");
	});

	it("keeps foreground Jev visuals opt-in and requires a Jev key", () => {
		expect(configured().plannerVisuals).toBe(false);
		expect(configured({ JEV_API_KEY: "test-key" }).plannerVisuals).toBe(false);
		expect(configured({ PLANNER_VISUALS: "on", JEV_API_KEY: "test-key" }).plannerVisuals)
			.toBe(true);
		expect(() => configured({ PLANNER_VISUALS: "on" }))
			.toThrow("JEV_API_KEY is required when PLANNER_VISUALS=on");
		expect(
			configured({ AGENT: "off", PLANNER_VISUALS: "on", JEV_API_KEY: "test-key" })
				.plannerVisuals,
		).toBe(false);
	});

	it("keeps living-document builds opt-in", () => {
		expect(configured().liveBuild).toBe(false);
		expect(configured({ LIVE_BUILD: "yes" }).liveBuild).toBe(false);
		expect(configured({ LIVE_BUILD: "on" }).liveBuild).toBe(true);
		expect(description(configured({ LIVE_BUILD: "on" }))).toContain("live build: on");
	});

	it("gates background execution and web research behind the hosted agent", () => {
		expect(configured()).toMatchObject({ agent: true, backgroundJobs: true, webResearch: true });
		expect(configured({ WEB_RESEARCH: "off" })).toMatchObject({
			agent: true,
			backgroundJobs: true,
			webResearch: false,
		});
		expect(configured({ BACKGROUND_JOBS: "off" })).toMatchObject({
			agent: true,
			backgroundJobs: false,
			webResearch: false,
		});
		expect(configured({ AGENT: "off" })).toMatchObject({
			agent: false,
			backgroundJobs: true,
			webResearch: false,
		});
	});

	it("selects a harness and retains AGENT and MODEL behavior", () => {
		expect(configured()).toMatchObject({
			harness: "copilot-sdk",
			harnessAuth: undefined,
			agent: true,
			model: "gpt-6-luna",
		});
		expect(configured({ HARNESS: "", HARNESS_AUTH: "" })).toMatchObject({
			harness: "copilot-sdk",
			harnessAuth: undefined,
		});
		let config = configured({
			HARNESS: "custom",
			HARNESS_AUTH: "direct",
			AGENT: "off",
			MODEL: "named-model",
		});
		expect(config).toMatchObject({
			harness: "custom",
			harnessAuth: "direct",
			agent: false,
			model: "named-model",
		});
		expect(description(config)).toContain("harness: custom");
		expect(description(config)).not.toContain("direct");
	});

	it("requires an explicit MODEL under the pi harness", () => {
		expect(() => configured({ HARNESS: "pi", HARNESS_AUTH: "openai" }))
			.toThrow("MODEL is required when HARNESS=pi");
		expect(configured({ HARNESS: "pi", HARNESS_AUTH: "openai", MODEL: "openai/gpt-5.6" }))
			.toMatchObject({ harness: "pi", model: "openai/gpt-5.6" });
	});

	it("requires an explicit provider/model MODEL under the atomic harness", () => {
		expect(() => configured({ HARNESS: "atomic", HARNESS_AUTH: "auto" }))
			.toThrow("MODEL is required when HARNESS=atomic");
		expect(configured({
			HARNESS: "atomic",
			HARNESS_AUTH: "ai-gateway",
			MODEL: "vercel-ai-gateway/anthropic/claude-sonnet-4.6",
		})).toMatchObject({
			harness: "atomic",
			model: "vercel-ai-gateway/anthropic/claude-sonnet-4.6",
		});
	});

	it("chooses a full Atomic Planner by harness alone, in hosted and local configuration", () => {
		let atomic = { HARNESS: "atomic", HARNESS_AUTH: "ai-gateway", MODEL: "stub/model" };
		for (let mode of [{}, LOCAL]) {
			let config = configured({ ...atomic, ...mode });
			expect(config.harness).toBe("atomic");
			expect(description(config)).toContain(
				"Planner: full Atomic session (shell and filesystem access as this process's user)",
			);
		}
		for (
			let isolated of [
				{},
				{ HARNESS: "pi", HARNESS_AUTH: "ai-gateway", MODEL: "stub/model" },
			]
		) {
			for (let mode of [{}, LOCAL]) {
				expect(description(configured({ ...isolated, ...mode }))).not.toContain("full Atomic");
			}
		}
	});

	it("splits HARNESS_EXTENSIONS on the path delimiter and names the paths at startup", () => {
		let atomic = { HARNESS: "atomic", HARNESS_AUTH: "ai-gateway", MODEL: "stub/model" };
		expect(configured(atomic).harnessExtensions).toEqual([]);
		expect(description(configured(atomic))).not.toContain("Planner extensions");
		let paths = ["/opt/first", "/opt/second"];
		let config = configured({ ...atomic, HARNESS_EXTENSIONS: paths.join(delimiter) + delimiter });
		expect(config.harnessExtensions).toEqual(paths);
		expect(description(config)).toContain("Planner extensions: /opt/first, /opt/second");
	});

	it("requires a valid PostgreSQL URL", () => {
		expect(() => configured({ DATABASE_URL: undefined })).toThrow("DATABASE_URL is required");
		expect(() => configured({ DATABASE_URL: "https://database.test" })).toThrow("PostgreSQL URL");
		expect(() => configured({ STORAGE_DRIVER: "cosmos" })).toThrow("STORAGE_DRIVER");
	});

	it("requires complete GitHub App configuration and a safe exact origin", () => {
		expect(() => configured({ GITHUB_APP_CLIENT_ID: undefined })).toThrow(
			"GITHUB_APP_CLIENT_ID",
		);
		expect(() => configured({ GITHUB_APP_SLUG: "Bad Slug" })).toThrow("GITHUB_APP_SLUG");
		expect(() => configured({ APP_ORIGIN: "http://chopin.example" })).toThrow("HTTPS");
		expect(() => configured({ APP_ORIGIN: "https://chopin.example/path" })).toThrow(
			"only an HTTP or HTTPS origin",
		);
		expect(() => configured({ APP_ORIGIN: "http://127.0.0.1:8787" })).not.toThrow();
		expect(() => configured({ SESSION_ENCRYPTION_KEY: "short" })).toThrow("32 bytes");
	});

	it("loads normalized user and organization admission lists", () => {
		let config = configured({
			GITHUB_ALLOWED_USERS: " OctoCat,hubot,octocat,managed_user ",
			GITHUB_ALLOWED_ORGANIZATIONS: " GitHubNext,github ",
		});
		expect([...config.auth.allowedUsers!]).toEqual(["octocat", "hubot", "managed_user"]);
		expect([...config.auth.allowedOrganizations!]).toEqual(["githubnext", "github"]);
		expect(description(config)).toContain("restricted: 3 users, 2 organizations");
		expect(description(config)).not.toContain("octocat");
	});

	it("keeps blank admission lists unrestricted and rejects malformed entries", () => {
		let config = configured({ GITHUB_ALLOWED_USERS: " ", GITHUB_ALLOWED_ORGANIZATIONS: "" });
		expect(config.auth.allowedUsers).toBeUndefined();
		expect(config.auth.allowedOrganizations).toBeUndefined();
		expect(description(config)).toContain("unrestricted");
		expect(() => configured({ GITHUB_ALLOWED_USERS: "octocat,,hubot" })).toThrow(
			"GITHUB_ALLOWED_USERS",
		);
		expect(() => configured({ GITHUB_ALLOWED_ORGANIZATIONS: "-githubnext" })).toThrow(
			"GITHUB_ALLOWED_ORGANIZATIONS",
		);
		expect(() => configured({ GITHUB_ALLOWED_ORGANIZATIONS: "managed_org" })).toThrow(
			"GITHUB_ALLOWED_ORGANIZATIONS",
		);
	});
	it("enables a client-secret-free local mode only at the exact loopback port", () => {
		let local = {
			AUTH_MODE: "local",
			GITHUB_APP_CLIENT_SECRET: undefined,
			APP_ORIGIN: "http://localhost:8790",
			PORT: "8790",
			SERVER_HOST: "127.0.0.1",
		};
		let config = configured(local);
		expect(config.auth.clientSecret).toBeUndefined();
		expect(config.auth.local).toMatchObject({ port: 8790 });
		expect(description(config)).toContain("github local device flow");
		expect(description(config)).not.toContain("secret");
		expect(() => configured({ ...local, SERVER_HOST: "0.0.0.0" })).toThrow("loopback");
		expect(() => configured({ ...local, APP_ORIGIN: "http://example.test:8790" }))
			.toThrow("HTTPS");
		expect(() => configured({ ...local, APP_ORIGIN: "http://localhost:8791" }))
			.toThrow("loopback");
		expect(() => configured({ ...local, APP_ORIGIN: "https://localhost:8790" }))
			.not.toThrow();
		expect(() => configured({ ...local, AUTH_MODE: "bad" })).toThrow("AUTH_MODE");
		expect(() => configured({ GITHUB_APP_CLIENT_SECRET: undefined })).toThrow(
			"GITHUB_APP_CLIENT_SECRET",
		);
	});
});
