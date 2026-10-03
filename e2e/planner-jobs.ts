import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ROOT } from "./servers";

type Kind = "heading" | "refine" | "suggest" | "prose";
type Call = { tool: string; args: Record<string, unknown> };

/** Test-process-to-server script directory, used only by the conversation-plan project. */
export const PLANNER_JOBS_DIR = join(ROOT, "e2e", "test-results", "planner-jobs");

export async function resetPlannerJobs(): Promise<void> {
	await rm(PLANNER_JOBS_DIR, { recursive: true, force: true });
	await mkdir(PLANNER_JOBS_DIR, { recursive: true });
}

export async function scriptJob(kind: Kind, calls: Call[], options: { hold?: boolean } = {}) {
	await mkdir(PLANNER_JOBS_DIR, { recursive: true });
	await rm(join(PLANNER_JOBS_DIR, `${kind}.release`), { force: true });
	await rm(join(PLANNER_JOBS_DIR, `${kind}.hold`), { force: true });
	await writeFile(join(PLANNER_JOBS_DIR, `${kind}.json`), JSON.stringify(calls));
	if (options.hold) await writeFile(join(PLANNER_JOBS_DIR, `${kind}.hold`), "hold");
}

export async function releasePlannerJob(kind: Kind): Promise<void> {
	await writeFile(join(PLANNER_JOBS_DIR, `${kind}.release`), "release");
}
