/**
 * Where a channel's Atomic Planner works.
 *
 * A checkout is only ever supplied through `invoke_planner`, verified against
 * the channel's repository, and remembered for the channel until the process
 * exits. Every later Planner session for that channel re-verifies it before use.
 * Without one, the session works in a directory Chopin keeps for that channel
 * alone under its per-user state directory, so files a paused or resumed
 * workflow wrote survive server restarts instead of filling the shared tmp.
 */

import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { verifiedCheckout } from "./checkout";

export type PlannerWorkspace = {
	cwd: string;
	/** True when `cwd` is a verified checkout rather than the channel's own directory. */
	checkout: boolean;
};

let checkouts = new Map<string, string>();

export function rememberCheckout(channelId: string, checkout: string): void {
	checkouts.set(channelId, checkout);
}

export async function plannerWorkspace(
	channelId: string,
	repository: { owner: string; name: string },
): Promise<PlannerWorkspace> {
	let remembered = checkouts.get(channelId);
	let checkout = remembered === undefined
		? undefined
		: await verifiedCheckout(repository, remembered);
	if (checkout) return { cwd: checkout, checkout: true };
	return { cwd: await directory(channelId), checkout: false };
}

/** The platform's per-user state directory for Chopin. */
export function stateDirectory(): string {
	if (process.platform === "win32") {
		return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Chopin");
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support", "Chopin");
	}
	return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "chopin");
}

/**
 * A stable directory per channel, private to the server's user. It lives in a
 * per-user directory rather than the shared tmp, so a predictable name is safe;
 * a symlink or file planted at that name is refused rather than followed.
 */
async function directory(channelId: string): Promise<string> {
	if (!/^[\w-]+$/.test(channelId)) throw new Error("Planner workspace needs a plain channel id");
	let path = join(stateDirectory(), "planner", channelId);
	await mkdir(path, { recursive: true, mode: 0o700 });
	let found = await lstat(path);
	if (!found.isDirectory() || found.isSymbolicLink()) {
		throw new Error(`Planner workspace ${path} is not a directory`);
	}
	await chmod(path, 0o700);
	return path;
}

/** Forget remembered checkouts. Channel directories persist across restarts. */
export function forgetWorkspaces(): void {
	checkouts.clear();
}
