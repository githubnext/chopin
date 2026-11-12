import { chromium } from "@playwright/test";

import type { FullConfig } from "@playwright/test";

const COLD_COMPILE_LIMIT = 120_000;

export default async function compileAuditPageBeforeTests(config: FullConfig) {
	let baseURL = config.projects[0]?.use.baseURL;
	if (!baseURL) return;
	let browser = await chromium.launch();
	try {
		let page = await browser.newPage();
		await page.goto(`${baseURL}/design-audit`, { timeout: COLD_COMPILE_LIMIT });
		await page
			.getByRole("heading", { name: "Chopin design audit", exact: true })
			.waitFor({ timeout: COLD_COMPILE_LIMIT });
	} finally {
		await browser.close();
	}
}
