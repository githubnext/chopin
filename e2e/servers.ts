/**
 * Where the servers under test live.
 *
 * Shared by the config and the database-backed test fixtures.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST = "127.0.0.1";

/**
 * Clear of 8787, which `bun run dev` binds, and of the 8898–8971 band the unit
 * suites spawn servers on. Somebody with the app already running is the normal
 * case, not a conflict worth resolving.
 */
export const PLAIN = 8788;

/**
 * A second server, because `DEV_QUESTIONS` and `DEV_COMMENTS` are read from the
 * environment on every room open. One server would put a questionnaire and a
 * comment thread into every other suite's room.
 */
export const FIXTURES = 8789;

/**
 * A third, isolated server: `AGENT=on` with a fake harness and fake GitHub MCP,
 * so a scripted Planner turn can run without touching the other two projects'
 * `AGENT=off` servers or ports. Clear of #157's 8790/8791.
 */
export const HARNESS = 8792;

/** The repository root, from this file rather than from the current directory. */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The deployment-defined setup agents the fixtures server offers on its Machines page
 * (CHOPIN_SETUP_AGENTS). The other servers set none, so their pages stay as they are.
 */
export const SETUP_AGENTS = [
	{
		id: "acme-planner",
		name: "Acme Planner",
		install: {
			linux: [
				"# Sign in once with acme login, then quit.",
				"curl -fsSL https://acme.example/install.sh | sh",
			],
			macos: ["brew install acme-example/tap/acme"],
			windows: ["winget install AcmeExample.Planner"],
		},
		command: "acme connect --server {origin} --key {key} --name {name}",
		keyless: "acme connect --server {origin}",
		default: true,
	},
	{
		id: "acme-runner",
		name: "Acme Runner",
		install: ["npm install -g acme-runner"],
		command: {
			linux: "acme-runner {key}",
			macos: "acme-runner {key}",
			windows: "acme-runner.exe {key}",
		},
	},
];
