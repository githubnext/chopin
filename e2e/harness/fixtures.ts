/**
 * Fixed values shared between the harness preload (running inside the spawned
 * server process) and the Playwright test (running in a separate process).
 *
 * Playwright cannot see in-process state from the server it spawned, so the
 * fake GitHub MCP server exposes its captured calls over its own fixed local
 * port instead. Clear of #157's 8790/8791 and of the 8898-8971 band the unit
 * suites use.
 */
export const FAKE_MCP_PORT = 8797;

export const PULL_REQUESTS = [
	{ number: 42, title: "Restring the harp section", state: "open" },
];
