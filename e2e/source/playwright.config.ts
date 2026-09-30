import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: [
		"source-highlight.native.ts",
		"question-actions.native.ts",
		"transcript-source.native.ts",
		"excerpt-correction-lifecycle.native.ts",
		"excerpt-correction-retry.native.ts",
		"evidence-hover.native.ts",
		"room-source.native.ts",
		"analysis-host.native.ts",
		"analysis-host-retries.native.ts",
		"decision-reader.native.ts",
	],
	workers: 1,
	fullyParallel: false,
	retries: 0,
	timeout: 15_000,
	reporter: "list",
	outputDir: "../../test-results/source-native",
	use: { browserName: "chromium", headless: true },
});
