import { describe, expect, it } from "bun:test";

import { describe as description, load } from "./config";

const REQUIRED = {
	STORAGE_DRIVER: "postgres",
	DATABASE_URL: "postgresql://chopin:secret@database.test/chopin",
	APP_ORIGIN: "https://chopin.example",
	GITHUB_APP_SLUG: "chopin-test",
	GITHUB_APP_CLIENT_ID: "client-id",
	GITHUB_APP_CLIENT_SECRET: "client-secret",
	SESSION_ENCRYPTION_KEY: "11".repeat(32),
};

function configured(overrides: Record<string, string | undefined> = {}) {
	let env: Record<string, string | undefined> = {
		...REQUIRED,
		AGENT: undefined,
		BACKGROUND_JOBS: undefined,
		WEB_RESEARCH: undefined,
		GITHUB_ALLOWED_USERS: undefined,
		GITHUB_ALLOWED_ORGANIZATIONS: undefined,
		...overrides,
	};
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
});
