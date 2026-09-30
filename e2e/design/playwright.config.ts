import { defineConfig } from "@playwright/test";

let port = Number(process.env.DESIGN_PORT ?? "5422");

export default defineConfig({
	testDir: ".",
	testMatch: "*.e2e.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	timeout: 60_000,
	outputDir: "../test-results/design",
	snapshotPathTemplate: "{testDir}/snapshots/{projectName}/{arg}{ext}",
	reporter: [["list"], ["html", { outputFolder: "../playwright-report/design", open: "never" }]],
	expect: {
		timeout: 10_000,
		toHaveScreenshot: { animations: "disabled", caret: "hide", maxDiffPixels: 0, threshold: 0.1 },
	},
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		browserName: "chromium",
		locale: "en-GB",
		timezoneId: "UTC",
		colorScheme: "light",
		contextOptions: { reducedMotion: "reduce" },
		deviceScaleFactor: 1,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{ name: "wide", use: { viewport: { width: 1440, height: 1000 } } },
		{ name: "narrow", use: { viewport: { width: 390, height: 844 } } },
	],
	webServer: {
		command: `CHOPIN_DEV_WEB_PORT=${port} bun run --cwd apps/web dev`,
		cwd: "../..",
		url: `http://127.0.0.1:${port}/design-audit`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
