import { existsSync } from "node:fs";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { APP_PORT, DATABASE_PORT, loadAcceptance } from "./planner-visual-acceptance";
import { ROOT } from "./servers";

const origin = `http://127.0.0.1:${APP_PORT}`;

let acceptance = loadAcceptance();
let { cases } = acceptance;
let visualRouting = acceptance.configuration.phase === "jev-candidate";
let database = process.env.E2E_DATABASE_URL_0;
let model = process.env.E2E_VISUAL_MODEL?.trim();
let sessionKey = process.env.SESSION_ENCRYPTION_KEY;
if (
	!database || new URL(database).port !== DATABASE_PORT
	|| !new URL(database).pathname.includes("visual_acceptance")
) {
	throw new Error("Supply an isolated visual_acceptance PostgreSQL database on port 8872");
}
if (!model || !sessionKey) {
	throw new Error("E2E_VISUAL_MODEL and SESSION_ENCRYPTION_KEY are required");
}
if (!existsSync(join(ROOT, "apps/web/dist/index.html"))) {
	throw new Error("Build the web client before Planner visual acceptance");
}

export default defineConfig({
	testDir: ".",
	testMatch: "planner-visual-acceptance.e2e.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: true,
	retries: 0,
	timeout: 360_000,
	outputDir: "test-results/planner-visual-acceptance/playwright",
	reporter: [["list"]],
	use: {
		...devices["Desktop Chrome"],
		baseURL: origin,
		viewport: { width: 1440, height: 960 },
		trace: "retain-on-failure",
	},
	webServer: {
		timeout: 180_000,
		command: "bun --preload ./e2e/github.ts"
			+ " --preload ./e2e/planner-visual-acceptance.preload.ts"
			+ " apps/server/src/main.ts",
		cwd: ROOT,
		url: `${origin}/`,
		env: {
			PORT: String(APP_PORT),
			SERVER_HOST: "127.0.0.1",
			APP_ORIGIN: origin,
			AGENT: "on",
			PLANNER_VISUALS: visualRouting ? "on" : "off",
			...(visualRouting && {
				JEV_API_KEY: process.env.JEV_API_KEY!,
				JEV_MODEL: "jev-1.13.0",
				JEV_TIMEOUT_MS: "30000",
			}),
			HARNESS: "copilot-sdk",
			HARNESS_AUTH: "direct",
			MODEL: model,
			CONVERSATION_PLAN: "off",
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
		},
		reuseExistingServer: false,
		gracefulShutdown: { signal: "SIGTERM", timeout: 2_000 },
	},
});

if (cases.length === 0) throw new Error("Select at least one case");
