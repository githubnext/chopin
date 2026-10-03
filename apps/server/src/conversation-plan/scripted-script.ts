/** Test-only script parsing and hold gates shared by deterministic Planner fixtures. */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import type { Job } from "./jobs";

export type Call = { tool: string; args: Record<string, unknown> };
export const MAX_SCRIPT_BYTES = 64 * 1024;
const MAX_CALLS = 16;

export function reason(value: unknown): string {
	return (value instanceof Error ? value.message : String(value)).trim().slice(0, 500)
		|| "Scripted Planner job failed.";
}

export function substitute(value: unknown, revision: number, target: string, depth = 0): unknown {
	if (depth > 16) throw new Error("scripted Planner job arguments are too deep");
	if (value === "$revision") return revision;
	if (value === "$target") return target;
	if (Array.isArray(value)) return value.map(item => substitute(item, revision, target, depth + 1));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map((
				[key, item],
			) => [key, substitute(item, revision, target, depth + 1)]),
		);
	}
	return value;
}

export function calls(value: unknown): Call[] {
	if (
		!Array.isArray(value) || value.length > MAX_CALLS
		|| value.some(item =>
			!item || typeof item !== "object" || Array.isArray(item)
			|| Object.keys(item).some(key => key !== "tool" && key !== "args")
			|| typeof item.tool !== "string" || !/^[a-z_]{1,80}$/.test(item.tool)
			|| !item.args || typeof item.args !== "object" || Array.isArray(item.args)
		)
	) throw new Error("scripted Planner job calls are invalid");
	return value as Call[];
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function held(
	dir: string,
	kind: Job["kind"],
	signal?: AbortSignal,
): Promise<"released" | "stopped" | "timed-out"> {
	if (!await exists(join(dir, `${kind}.hold`))) return "released";
	let deadline = Date.now() + 30_000;
	for (;;) {
		if (signal?.aborted) return "stopped";
		if (Date.now() >= deadline) return "timed-out";
		if (await exists(join(dir, `${kind}.release`))) return "released";
		try {
			await setTimeout(25, undefined, { signal });
		} catch {
			return "stopped";
		}
	}
}

export async function readScript(dir: string, kind: Job["kind"]): Promise<Call[]> {
	let data = await readFile(join(dir, `${kind}.json`), "utf8");
	if (data.length > MAX_SCRIPT_BYTES) throw new Error("scripted Planner job is too large");
	return calls(JSON.parse(data));
}
