import { existsSync } from "node:fs";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

import { FIXTURES, HOST, PLAIN, ROOT, scratch } from "./servers";

/**
 * An already-running server to use instead of starting one, e.g. `bun run dev`
 * on 8787. Skips the build and the supervision, which is what makes iterating
 * on a single test bearable; the sidecar suite needs `DEV_QUESTIONS` and
 * `DEV_COMMENTS` set on whatever is listening there.
 */
let external = process.env.E2E_BASE_URL;

/*
 * Refuse a client that is not there, here rather than in a global setup.
 *
 * The web servers are started *before* `globalSetup` runs, so a check there is
 * too late to be read: the server answers 404 for a `dist` it cannot find,
 * Playwright polls it for a minute and then reports a timeout against a URL,
 * and the setup that would have explained why never runs at all.
 *
 * Nothing here builds it either. A build racing servers already answering
 * would put the suite on the previous bundle — green, about code nobody
 * changed — so `bun run e2e` builds first and this only insists on the result.
 */
if (!external && !existsSync(join(ROOT, "apps/web/dist/index.html"))) {
	throw new Error(
		"chopin: no built client to test. Run `bun run e2e`, which builds first,"
			+ " or `bun run build` before invoking Playwright directly.",
	);
}

function server(port: number, extra: Record<string, string>) {
	return {
		/*
		 * Spawned directly rather than through `bun run start`, for the reason
		 * `scripts/dev.ts` gives: the wrapper does not exit when the thing it
		 * started dies, so Playwright would end up supervising nothing.
		 */
		command: "bun apps/server/src/main.ts",
		cwd: ROOT,
		url: `http://${HOST}:${port}/`,
		env: {
			PORT: String(port),
			SERVER_HOST: HOST,
			// No token, no CLI probe, no turns.
			AGENT: "off",
			DATA_DIR: scratch(port),
			// Named even when off, so an exported flag in somebody's shell
			// cannot quietly put a questionnaire in every room.
			DEV_QUESTIONS: "",
			DEV_COMMENTS: "",
			...extra,
		},
		reuseExistingServer: !process.env.CI,
		gracefulShutdown: { signal: "SIGTERM" as const, timeout: 2_000 },
	};
}

export default defineConfig({
	testDir: ".",

	/*
	 * Bun's test runner claims `*.test.*` and `*.spec.*`. A Playwright file
	 * under either name would be collected by `bun test` and fail there, so
	 * these are named for the runner that can actually run them.
	 */
	testMatch: "**/*.e2e.ts",

	outputDir: "test-results",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI
		? [["github"], ["html", { open: "never", outputFolder: "playwright-report" }]]
		: [["list"]],

	expect: {
		// A websocket round trip, a 5ms edit batch and a 500ms save debounce
		// all sit under some of these assertions.
		timeout: 10_000,
	},

	use: {
		trace: process.env.CI ? "on-first-retry" : "retain-on-failure",
	},

	// Clears the previous run's rooms. On the way in, because a teardown runs
	// while the servers are still up and their debounced saves land after it.
	globalSetup: "./setup.ts",

	projects: [
		{
			name: "chromium",
			testIgnore: "**/sidecar.e2e.ts",
			use: { ...devices["Desktop Chrome"], baseURL: external ?? `http://${HOST}:${PLAIN}` },
		},
		{
			name: "fixtures",
			testMatch: "**/sidecar.e2e.ts",
			use: { ...devices["Desktop Chrome"], baseURL: external ?? `http://${HOST}:${FIXTURES}` },
		},
	],

	webServer: external
		? undefined
		: [server(PLAIN, {}), server(FIXTURES, { DEV_QUESTIONS: "1", DEV_COMMENTS: "1" })],
});
