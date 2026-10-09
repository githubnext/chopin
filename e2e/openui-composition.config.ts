import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

let root = fileURLToPath(new URL("../", import.meta.url));
let database = process.env.E2E_DATABASE_URL_0;
if (!database) throw new Error("Supply E2E_DATABASE_URL_0 for the isolated composition database");
let port = process.env.E2E_OPENUI_PORT || "8818";

export default defineConfig({
	testDir: fileURLToPath(new URL("./", import.meta.url)),
	testMatch: "openui-composition.e2e.ts",
	outputDir: fileURLToPath(new URL("./test-results/openui-composition/", import.meta.url)),
	workers: 1,
	reporter: "list",
	use: {
		...devices["Desktop Chrome"],
		baseURL: `http://127.0.0.1:${port}`,
		trace: "retain-on-failure",
	},
	webServer: {
		command: "bun --preload ./e2e/github.ts apps/server/src/main.ts",
		cwd: root,
		url: `http://127.0.0.1:${port}/`,
		reuseExistingServer: false,
		env: {
			PORT: port,
			SERVER_HOST: "127.0.0.1",
			AGENT: "off",
			CONVERSATION_PLAN: "off",
			BACKGROUND_JOBS: "off",
			STORAGE_DRIVER: "postgres",
			DATABASE_URL: database,
			APP_ORIGIN: `http://127.0.0.1:${port}`,
			GITHUB_APP_SLUG: "chopin-e2e",
			GITHUB_APP_CLIENT_ID: "e2e",
			GITHUB_APP_CLIENT_SECRET: "e2e",
			GITHUB_ALLOWED_USERS: "",
			GITHUB_ALLOWED_ORGANIZATIONS: "githubnext",
			SESSION_ENCRYPTION_KEY: "33".repeat(32),
			DEV_QUESTIONS: "",
			DEV_COMMENTS: "",
		},
	},
});
