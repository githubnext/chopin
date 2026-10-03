import { requireScriptedServer, SCRIPTED_HARNESS } from "./scripted-environment";

/** Register the model fixture without listeners or fetch wrappers in discovery processes. */
export async function registerScriptedHarness(
	env: Record<string, string | undefined>,
	root: string,
) {
	requireScriptedServer(env, root);
	let { harnesses } = await import("../../apps/server/src/harness/harnesses");
	let { createPromptScriptedHarness } = await import("./scripted-planner");
	let scriptDir = env.E2E_PLANNER_JOBS_DIR!;
	Object.assign(harnesses, {
		[SCRIPTED_HARNESS]: () => createPromptScriptedHarness(scriptDir).fake,
	});
}
