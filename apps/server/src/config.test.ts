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

	it("keeps foreground visuals opt-in and requires a decisions model", () => {
		expect(configured().plannerVisuals).toBe(false);
		expect(configured({ JEV_API_KEY: "test-key" }).plannerVisuals).toBe(false);
		expect(configured({ PLANNER_VISUALS: "on", JEV_API_KEY: "test-key" }).plannerVisuals)
			.toBe(true);
		expect(() => configured({ PLANNER_VISUALS: "on", JEV_API_KEY: undefined }))
			.toThrow("A decisions model is required when PLANNER_VISUALS=on");
		expect(
			configured({ AGENT: "off", PLANNER_VISUALS: "on", JEV_API_KEY: "test-key" })
				.plannerVisuals,
		).toBe(false);
	});

	it("recommends the bundled connector's release unless CONNECTOR_VERSION names one", async () => {
		let { version } = await Bun.file(
			new URL("../../connector/package.json", import.meta.url),
		).json() as { version: string };
		expect(configured().connectorVersion).toBe(version);
		expect(configured({ CONNECTOR_VERSION: "0.1.3" }).connectorVersion).toBe("0.1.3");
		expect(configured({ CONNECTOR_VERSION: "cli-v0.1.3" }).connectorVersion).toBe("0.1.3");
		expect(() => configured({ CONNECTOR_VERSION: "latest" }))
			.toThrow("CONNECTOR_VERSION must be a chopin release version like 0.2.0");
	});

	it("keeps living-document builds opt-in", () => {
		expect(configured().liveBuild).toBe(false);
		expect(configured({ LIVE_BUILD: "yes" }).liveBuild).toBe(false);
		expect(configured({ LIVE_BUILD: "on" }).liveBuild).toBe(true);
		expect(configured().liveSpikes).toBe(false);
		expect(configured({ LIVE_SPIKES: "on" }).liveSpikes).toBe(true);
		expect(configured({ LIVE_BUILD: "on" }).liveSpikes).toBe(false);
		expect(configured({ LIVE_SPIKES: "on" }).liveSpikesRegexJudge).toBe(false);
		expect(configured({ LIVE_SPIKES: "on", LIVE_SPIKES_REGEX_JUDGE: "on" }).liveSpikesRegexJudge)
			.toBe(true);
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
			model: "gpt-6.1-sol",
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

	it("accepts a remote Planner on a public bind with no MODEL, and only without background jobs", () => {
		let remote = { HARNESS: "remote", SERVER_HOST: "0.0.0.0", BACKGROUND_JOBS: "off" };
		let config = configured(remote);
		expect(config).toMatchObject({ harness: "remote", host: "0.0.0.0", model: "" });
		expect(description(config)).toContain("agent: chosen by the attached client");
		expect(description(config)).toContain(
			"Planner: attached client over /api/v1/agent (model and client tools run on its machine)",
		);
		expect(configured({ ...remote, MODEL: "openai/gpt-6" }).model).toBe("openai/gpt-6");
		expect(() => configured({ HARNESS: "remote" }))
			.toThrow("HARNESS=remote requires BACKGROUND_JOBS=off");
	});

	it("keeps a detached remote Planner's ownership two minutes unless PLANNER_ATTACH_GRACE_MS says otherwise", () => {
		let remote = { HARNESS: "remote", BACKGROUND_JOBS: "off" };
		expect(configured(remote).plannerAttachGraceMs).toBe(120_000);
		expect(configured({ ...remote, PLANNER_ATTACH_GRACE_MS: "0" }).plannerAttachGraceMs).toBe(0);
		expect(configured({ ...remote, PLANNER_ATTACH_GRACE_MS: "3600000" }).plannerAttachGraceMs)
			.toBe(3_600_000);
		for (let value of ["", "-1", "1.5", "3600001", "soon"]) {
			expect(() => configured({ ...remote, PLANNER_ATTACH_GRACE_MS: value }))
				.toThrow("PLANNER_ATTACH_GRACE_MS must be an integer between 0 and 3600000 milliseconds");
		}
	});

	it("pings a remote agent connection every 15 seconds and drops it after 120 silent seconds unless configured", () => {
		let remote = { HARNESS: "remote", BACKGROUND_JOBS: "off" };
		expect(configured(remote)).toMatchObject({
			agentConnectionPingMs: 15_000,
			agentConnectionTimeoutMs: 120_000,
		});
		expect(
			configured({
				...remote,
				AGENT_CONNECTION_PING_MS: "1000",
				AGENT_CONNECTION_TIMEOUT_MS: "1001",
			}),
		)
			.toMatchObject({ agentConnectionPingMs: 1_000, agentConnectionTimeoutMs: 1_001 });
		for (let value of ["", "999", "1.5", "600001", "soon"]) {
			expect(() => configured({ ...remote, AGENT_CONNECTION_PING_MS: value }))
				.toThrow(
					"AGENT_CONNECTION_PING_MS must be an integer between 1000 and 600000 milliseconds",
				);
			expect(() => configured({ ...remote, AGENT_CONNECTION_TIMEOUT_MS: value }))
				.toThrow(
					"AGENT_CONNECTION_TIMEOUT_MS must be an integer between 1000 and 600000 milliseconds",
				);
		}
		expect(() => configured({ ...remote, AGENT_CONNECTION_TIMEOUT_MS: "15000" }))
			.toThrow("AGENT_CONNECTION_TIMEOUT_MS must be longer than AGENT_CONNECTION_PING_MS");
	});

	it("caps a remote agent connection's silence at 15 minutes, however its queue drains, unless configured", () => {
		let remote = { HARNESS: "remote", BACKGROUND_JOBS: "off" };
		expect(configured(remote).agentConnectionMaxSilenceMs).toBe(900_000);
		expect(
			configured({ ...remote, AGENT_CONNECTION_TIMEOUT_MS: "600000" }).agentConnectionMaxSilenceMs,
		)
			.toBe(900_000);
		expect(
			configured({ ...remote, AGENT_CONNECTION_MAX_SILENCE_MS: "120000" })
				.agentConnectionMaxSilenceMs,
		)
			.toBe(120_000);
		expect(
			configured({ ...remote, AGENT_CONNECTION_MAX_SILENCE_MS: "3600000" })
				.agentConnectionMaxSilenceMs,
		)
			.toBe(3_600_000);
		for (let value of ["", "999", "1.5", "3600001", "soon"]) {
			expect(() => configured({ ...remote, AGENT_CONNECTION_MAX_SILENCE_MS: value }))
				.toThrow(
					"AGENT_CONNECTION_MAX_SILENCE_MS must be an integer between 1000 and 3600000 milliseconds",
				);
		}
		expect(() => configured({ ...remote, AGENT_CONNECTION_MAX_SILENCE_MS: "119999" }))
			.toThrow("AGENT_CONNECTION_MAX_SILENCE_MS must be at least AGENT_CONNECTION_TIMEOUT_MS");
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
		for (let mode of [{}, LOCAL]) {
			expect(description(configured(mode))).not.toContain("full Atomic");
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

	it("reads deployment-defined setup agents, and refuses a malformed one at startup", () => {
		expect(configured().setupAgents).toEqual([]);
		let acme = {
			id: "acme-planner",
			name: "Acme Planner",
			install: {
				linux: ["# Sign in once, then quit.", "curl -fsSL https://acme.example/install | sh"],
				macos: ["brew install acme"],
				windows: ["winget install Acme.Planner"],
			},
			command: "acme connect --server {origin} --key {key} --name {name}",
			keyless: "acme connect --server {origin}",
			default: true,
		};
		let other = {
			id: "other",
			name: "Other",
			install: ["other install"],
			command: { linux: "other {key}", macos: "other {key}", windows: "other.exe {key}" },
		};
		expect(configured({ CHOPIN_SETUP_AGENTS: JSON.stringify([acme, other]) }).setupAgents)
			.toEqual([acme, other]);
		let refused = (value: unknown, message: string) =>
			expect(() =>
				configured({
					CHOPIN_SETUP_AGENTS: typeof value === "string" ? value : JSON.stringify(value),
				})
			).toThrow(message);
		refused("[{", "CHOPIN_SETUP_AGENTS must be a JSON array");
		refused({ id: "x" }, "CHOPIN_SETUP_AGENTS must be a JSON array");
		refused([{ ...acme, id: "Acme Planner" }], "CHOPIN_SETUP_AGENTS[0].id");
		refused([{ ...acme, id: "copilot" }], "a built-in coding agent");
		refused([acme, { ...other, id: "acme-planner" }], "more than once");
		refused([{ ...acme, name: "" }], "CHOPIN_SETUP_AGENTS[0].name");
		refused([{ ...acme, command: "acme connect" }], "{key}");
		refused([{ ...acme, keyless: "acme {key}" }], "keyless");
		refused([{ ...acme, install: { linux: [], macos: [] } }], "CHOPIN_SETUP_AGENTS[0].install");
		refused([{ ...acme, command: { linux: "a {key}" } }], "CHOPIN_SETUP_AGENTS[0].command");
		refused([acme, { ...other, default: true }], "default");
		refused([{ ...acme, extra: 1 }], "CHOPIN_SETUP_AGENTS[0]");
	});
});
