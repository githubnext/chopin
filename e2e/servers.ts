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

/** The repository root, from this file rather than from the current directory. */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
