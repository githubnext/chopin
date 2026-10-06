import { defineConfig } from "@playwright/test";

if (!process.env.LIVEAPP_TEST_ORIGIN) throw new Error("Run bun run test:liveapp:baseline");

export default defineConfig({
	testDir: ".",
	testMatch: "*.e2e.ts",
	workers: 1,
	outputDir: "../test-results/liveapp",
	timeout: 60_000,
	expect: { timeout: 15_000 },
	use: { baseURL: process.env.LIVEAPP_TEST_ORIGIN, trace: "retain-on-failure" },
});
