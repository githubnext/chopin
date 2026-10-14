import { defineConfig } from "@playwright/test";

let port = Number(process.env.STARTUP_PORT ?? "5431");

export default defineConfig({
	testDir: ".",
	testMatch: "*.e2e.ts",
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	timeout: 60_000,
	outputDir: "../test-results/startup",
	reporter: [["list"]],
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		browserName: "chromium",
		viewport: { width: 1440, height: 1000 },
		trace: "retain-on-failure",
	},
	webServer: {
		command: `CHOPIN_DEV_WEB_PORT=${port} bun run --cwd apps/web dev`,
		cwd: "../..",
		url: `http://127.0.0.1:${port}`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
