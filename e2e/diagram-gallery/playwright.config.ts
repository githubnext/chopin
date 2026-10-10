import { defineConfig } from "@playwright/test";

let port = Number(process.env.DIAGRAM_GALLERY_PORT ?? "5424");

export default defineConfig({
	testDir: ".",
	testMatch: "*.e2e.ts",
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	timeout: 60_000,
	outputDir: "../test-results/diagram-gallery",
	reporter: [
		["list"],
		["html", { outputFolder: "../playwright-report/diagram-gallery", open: "never" }],
		...(process.env.CI
			? [["json", { outputFile: "../.scratch/ci-reports/gallery.json" }]] as const
			: []),
	],
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		browserName: "chromium",
		locale: "en-GB",
		colorScheme: "light",
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
		url: `http://127.0.0.1:${port}/diagram-gallery`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
