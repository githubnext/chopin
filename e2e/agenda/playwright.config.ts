import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "agenda.native.ts",
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 20_000,
	reporter: "list",
	outputDir: "../test-results/agenda-native",
	use: { browserName: "chromium", headless: true },
});
