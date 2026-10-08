import { defineConfig } from "@playwright/test";
import normal from "./playwright.config";
import { ROOT } from "./servers";

let application = (Array.isArray(normal.webServer) ? normal.webServer : [normal.webServer!])[0]!;
let appOrigin = "http://127.0.0.1:8840";
let previewOrigin = "http://localhost:8841";

export default defineConfig({
	...normal,
	testMatch: "**/visual-decision*.e2e.ts",
	fullyParallel: false,
	workers: 1,
	projects: [{
		name: "visual-decision",
		use: { ...normal.projects![0]!.use, baseURL: appOrigin },
	}],
	webServer: [
		{
			...application,
			url: `${appOrigin}/`,
			reuseExistingServer: false,
			env: {
				...application.env,
				PORT: "8840",
				APP_ORIGIN: appOrigin,
				E2E_VISUAL_DECISIONS: "1",
				VISUAL_PREVIEW_ORIGIN: previewOrigin,
			},
		},
		{
			command: "bun e2e/visual-decision-fixtures/server.ts",
			cwd: ROOT,
			url: `${previewOrigin}/health`,
			env: {
				VISUAL_PREVIEW_PORT: "8841",
				VISUAL_PREVIEW_ORIGIN: previewOrigin,
				VISUAL_PREVIEW_APP_ORIGIN: appOrigin,
			},
			reuseExistingServer: false,
			gracefulShutdown: { signal: "SIGTERM", timeout: 2_000 },
		},
	],
});
