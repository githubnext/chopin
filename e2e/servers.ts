/**
 * Where the servers under test live.
 *
 * Shared by the config, which starts them, and by the tests, which have to
 * find a room's plan on disk. Both must agree on the data directory, and the
 * config is re-evaluated in every worker process — so the path is derived from
 * the port rather than generated. A timestamp here would give each worker a
 * different answer and the seeding tests would write somewhere nobody reads.
 */

import { dirname, join } from "node:path";
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

/** The repository root, from this file rather than from the current directory. */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * A server's `DATA_DIR`.
 *
 * Under `e2e/` rather than the system temporary directory so that a failed run
 * leaves the room's plan beside the trace that failed on it. Cleared by the
 * next run rather than by this one, for the reason `setup.ts` gives.
 */
export function scratch(port: number): string {
	return join(ROOT, "e2e", ".scratch", String(port));
}
