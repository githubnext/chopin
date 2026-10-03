import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ROOT } from "./servers";

/** Files are a test-process-to-preload latch, never an application route. */
export const JEV_CONTROL_DIR = join(ROOT, "e2e", "test-results", "jev-control");

export async function resetJevControl(): Promise<void> {
	await rm(JEV_CONTROL_DIR, { recursive: true, force: true });
	await mkdir(JEV_CONTROL_DIR, { recursive: true });
}

export async function releaseJev(name: "delayed-question"): Promise<void> {
	await writeFile(join(JEV_CONTROL_DIR, name), "release");
}
