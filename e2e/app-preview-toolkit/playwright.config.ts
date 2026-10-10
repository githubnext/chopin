import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "*.e2e.ts",
	workers: 1,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	timeout: 60_000,
	retries: 0,
	outputDir: "../test-results/app-preview-toolkit",
	snapshotPathTemplate:
		"{testDir}/../test-results/app-preview-toolkit/comparison/{projectName}/{testFilePath}/{arg}{ext}",
	reporter: [["list"], ["html", {
		outputFolder: "../playwright-report/app-preview-toolkit",
		open: "never",
	}]],
	use: {
		baseURL: "http://127.0.0.1:8810",
		browserName: "chromium",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{ name: "wide", use: { viewport: { width: 1440, height: 1000 } } },
		{ name: "narrow", use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
	],
	webServer: {
		command:
			"bun e2e/app-preview-toolkit/build.ts && bun e2e/app-preview-toolkit/server.ts --built",
		cwd: "../..",
		url: "http://127.0.0.1:8810",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
