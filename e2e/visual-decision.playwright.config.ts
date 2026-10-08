import { defineConfig } from "@playwright/test";
import normal from "./playwright.config";
import { ROOT } from "./servers";

let application = (Array.isArray(normal.webServer) ? normal.webServer : [normal.webServer!])[0]!;

export default defineConfig({
	...normal,
	testMatch: "**/visual-decision*.e2e.ts",
	fullyParallel: false,
	workers: 1,
	projects: [{ name: "visual-decision", use: normal.projects![0]!.use }],
	webServer: [
		{
			...application,
			reuseExistingServer: false,
			env: { ...application.env, VISUAL_PREVIEW_ORIGIN: "http://localhost:8793" },
		},
		{
			command: "bun apps/server/src/visual-preview/server.ts",
			cwd: ROOT,
			url: "http://localhost:8793/health",
			env: {
				VISUAL_PREVIEW_PORT: "8793",
				VISUAL_PREVIEW_ORIGIN: "http://localhost:8793",
				VISUAL_PREVIEW_APP_ORIGIN: "http://127.0.0.1:8788",
			},
			reuseExistingServer: false,
			gracefulShutdown: { signal: "SIGTERM", timeout: 2_000 },
		},
	],
});
