import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createRequest } from "./actions.mjs";
import { createStateStore, sealState } from "./state-store.mjs";
import { validateState } from "./state.mjs";

export async function provisionState(repository, key, request) {
	let store = createStateStore(repository, key, request);
	let prefix = `/repos/${repository}`;
	try {
		await request("GET", `${prefix}/git/ref/heads/automation/pr-maintenance-state`);
	} catch (error) {
		if (error.status !== 404) throw new Error("State branch lookup failed", { cause: error });
		let main = await request("GET", `${prefix}/git/ref/heads/main`);
		if (!/^[a-f0-9]{40}$/.test(main.object?.sha)) throw new Error("Invalid main reference", { cause: error });
		let payload = { schemaVersion: 1, repository, revision: 0, prs: {} };
		let content = Buffer.from(JSON.stringify(sealState(payload, key))).toString("base64");
		await request("POST", `${prefix}/git/refs`, {
			ref: "refs/heads/automation/pr-maintenance-state",
			sha: main.object.sha,
		});
		await request("PUT", `${prefix}/contents/state.json`, {
			branch: "automation/pr-maintenance-state",
			message: "Initialize authenticated PR maintenance state",
			content,
		});
		return { created: true };
	}
	// An existing branch must authenticate; never replace missing or invalid state.
	let loaded = await store.load();
	for (let [number, state] of Object.entries(loaded.payload.prs)) {
		validateState(state);
		if (String(state.number) !== number) throw new Error("State PR identity mismatch");
	}
	return { created: false };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	if (process.argv[2] !== "initialize") throw new Error("Explicit initialize command required");
	try {
		let result = await provisionState(
			process.env.GITHUB_REPOSITORY,
			process.env.PR_MAINTENANCE_STATE_KEY,
			createRequest(process.env.GH_TOKEN),
		);
		console.log(result.created ? "Authenticated state initialized" : "Existing state verified");
	} catch {
		console.error("State provisioning failed; existing state was not reset");
		process.exitCode = 1;
	}
}
