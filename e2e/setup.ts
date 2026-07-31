/**
 * Take the previous run's rooms off disk, on the way in.
 *
 * Not on the way out, which is where this obviously belongs and where it does
 * not work: `globalTeardown` runs before the web servers are stopped, and the
 * snapshot sink writes on a 500ms idle timer, so a room touched by the last
 * test is saved *after* the wipe. The result was a teardown that removed most
 * of the tree and left a handful of directories behind — reliably enough to
 * look deliberate and never quite empty.
 *
 * Here it is exact. Global setup runs after the servers have started but
 * before any test, and a server writes nothing until a room is opened, so at
 * this moment the directory holds only what an earlier run left.
 *
 * It also means a failed run's plan survives beside the trace that failed on
 * it, which is the reason the scratch directory is under `e2e/` rather than in
 * the system temporary directory.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";

import { ROOT } from "./servers";

export default async function setup(): Promise<void> {
	await rm(join(ROOT, "e2e", ".scratch"), { recursive: true, force: true });
}
