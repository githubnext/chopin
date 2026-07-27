/**
 * Finding the Copilot CLI.
 *
 * The SDK drives a CLI process rather than talking to an API, so something has
 * to say which one. Left to itself it resolves the bundled JavaScript entry and
 * spawns `node` to run it — and under Bun that is the literal string "node",
 * which is not on every machine and is not on ours.
 *
 * The npm package ships a native executable per platform as an optional
 * dependency, so there is a binary pinned by the lockfile sitting in
 * node_modules. Pointing the SDK at it removes the runtime from the equation
 * entirely: no Node, and the CLI version is whatever the lockfile says rather
 * than whatever happens to be installed globally.
 */

import { createRequire } from "node:module";

/**
 * Which build to ask for.
 *
 * Musl needs its own and reports itself as plain linux, so it is distinguished
 * the way the CLI's own launcher does: by whether the runtime admits to a
 * glibc version.
 */
function platform(): string {
	if (process.platform !== "linux") return process.platform;
	try {
		let report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
		return report?.header?.glibcVersionRuntime ? "linux" : "linuxmusl";
	} catch {
		return "linux";
	}
}

export type Resolution =
	| { ok: true; path: string; source: "override" | "bundled" }
	| { ok: false; reason: string };

/**
 * The executable to drive, or why there is not one.
 *
 * `COPILOT_CLI_PATH` wins so a newer or locally built CLI can be tried without
 * touching the lockfile.
 */
export function locate(): Resolution {
	let override = process.env.COPILOT_CLI_PATH;
	if (override) return { ok: true, path: override, source: "override" };

	let target = `@github/copilot-${platform()}-${process.arch}`;

	try {
		// Anchored at the CLI package, because the platform build is its
		// optional dependency and is not hoisted to where we are.
		let anchor = createRequire(import.meta.url).resolve("@github/copilot/package.json");
		return { ok: true, path: createRequire(anchor).resolve(target), source: "bundled" };
	} catch {
		return {
			ok: false,
			reason: `no Copilot CLI for this platform (${target} is not installed). `
				+ "Set COPILOT_CLI_PATH to a copilot executable, or reinstall dependencies.",
		};
	}
}
