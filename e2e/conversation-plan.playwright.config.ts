import { existsSync } from "node:fs";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { requireScriptedServer, SCRIPTED_HARNESS } from "./harness/scripted-environment";
import { registerScriptedHarness } from "./harness/scripted-register";
import { JEV_CONTROL_DIR, resetJevControl } from "./jev-control";
import { PLANNER_JOBS_DIR, resetPlannerJobs } from "./planner-jobs";
import { HOST, PLAIN, ROOT } from "./servers";

// Loading this explicitly selected config may reset fixtures and start a server.
if (process.env.E2E_CONVERSATION_PLAN !== "1") {
	throw new Error("chopin: conversation-plan tests require E2E_CONVERSATION_PLAN=1");
}

let database = process.env.E2E_DATABASE_URL_0;
let sessionKey = process.env.SESSION_ENCRYPTION_KEY;
if (!database?.trim()) {
	throw new Error("chopin: conversation-plan tests require a supplied E2E_DATABASE_URL_0");
}
if (!sessionKey?.trim()) {
	throw new Error("chopin: conversation-plan tests require a supplied SESSION_ENCRYPTION_KEY");
}

let origin = `http://${HOST}:${PLAIN}`;
let serverEnvironment = {
	PORT: String(PLAIN),
	SERVER_HOST: HOST,
	APP_ORIGIN: origin,
	AGENT: "on",
	CONVERSATION_PLAN: "on",
	HARNESS: SCRIPTED_HARNESS,
	HARNESS_AUTH: "direct",
	MODEL: "e2e-prompt-scripted-model",
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
	E2E_CONVERSATION_PLAN: "1",
	E2E_PLANNER_JOBS_DIR: PLANNER_JOBS_DIR,
	E2E_JEV_CONTROL_DIR: JEV_CONTROL_DIR,
	BACKGROUND_JOBS: "off",
	WEB_RESEARCH: "off",
	STORAGE_DRIVER: "postgres",
	DATABASE_URL: database,
	GITHUB_APP_SLUG: "chopin-e2e",
	GITHUB_APP_CLIENT_ID: "e2e",
	GITHUB_APP_CLIENT_SECRET: "e2e",
	GITHUB_ALLOWED_USERS: "",
	GITHUB_ALLOWED_ORGANIZATIONS: "githubnext",
	SESSION_ENCRYPTION_KEY: sessionKey,
	DEV_QUESTIONS: "",
	DEV_COMMENTS: "",
};
requireScriptedServer(serverEnvironment, ROOT);
await registerScriptedHarness(process.env, ROOT);

if (!existsSync(join(ROOT, "apps/web/dist/index.html"))) {
	throw new Error("chopin: conversation-plan tests require an existing built client");
}

// These checks cannot establish database disposability, client freshness or network containment.
await resetPlannerJobs();
await resetJevControl();

export default defineConfig({
	testDir: ".",
	testMatch: [
		join(ROOT, "e2e/conversation-plan-heading.e2e.ts"),
		join(ROOT, "e2e/conversation-plan-jobs.e2e.ts"),
		join(ROOT, "e2e/conversation-plan-layout.e2e.ts"),
		join(ROOT, "e2e/conversation-plan-runtime.e2e.ts"),
		join(ROOT, "e2e/conversation-plan-prompts.e2e.ts"),
		join(ROOT, "e2e/conversation-plan-stress.e2e.ts"),
		join(ROOT, "e2e/conversation-plan-ui.e2e.ts"),
		join(ROOT, "e2e/decision-anchor-stress.e2e.ts"),
		join(ROOT, "e2e/decision-evidence.e2e.ts"),
		join(ROOT, "e2e/decision-prose.e2e.ts"),
		join(ROOT, "e2e/research-child-recovery.e2e.ts"),
		join(ROOT, "e2e/research-offers.e2e.ts"),
		join(ROOT, "e2e/research-offers-ui.e2e.ts"),
	],
	outputDir: "test-results/conversation-plan",
	fullyParallel: false,
	workers: 1,
	forbidOnly: true,
	retries: 0,
	reporter: [["list"]],
	expect: { timeout: 10_000 },
	use: { trace: "retain-on-failure" },
	projects: [{
		name: "conversation-plan",
		use: { ...devices["Desktop Chrome"], baseURL: origin },
	}],
	webServer: {
		command: "bun --preload ./e2e/harness/scripted-network-preload.ts"
			+ " --preload ./e2e/github.ts --preload ./e2e/jev.ts"
			+ " --preload ./e2e/harness/scripted-preload.ts apps/server/src/main.ts",
		cwd: ROOT,
		url: `${origin}/`,
		env: serverEnvironment,
		reuseExistingServer: false,
		gracefulShutdown: { signal: "SIGTERM", timeout: 2_000 },
	},
});
