import { defineConfig } from "@playwright/test";
import visual from "./playwright.config";
import type { DesignOptions } from "./fixture";

export default defineConfig<DesignOptions>({
	...visual,
	testMatch: ["interactions.e2e.ts", "responsive.e2e.ts"],
	workers: 2,
	outputDir: "../test-results/design-behavior",
	reporter: [
		["list"],
		["html", { outputFolder: "../playwright-report/design-behavior", open: "never" }],
	],
	use: { ...visual.use, visualReview: false },
});
