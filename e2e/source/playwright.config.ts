import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: ["source-highlight.native.ts", "question-actions.native.ts"],
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 15_000,
	reporter: "list",
	outputDir: "../../test-results/source-native",
	use: { browserName: "chromium", headless: true },
});
