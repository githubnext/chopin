/**
 * Where a channel's Atomic Planner works.
 *
 * A checkout is only ever supplied through `invoke_planner`, verified against
 * the channel's repository, and remembered for the channel until the process
 * exits. Every later Planner session for that channel re-verifies it before use.
 * Without one, the session gets a directory Chopin created empty for that
 * channel alone; it keeps whatever the Planner writes there until shutdown.
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifiedCheckout } from "./checkout";

export type PlannerWorkspace = {
	cwd: string;
	/** True when `cwd` is a verified checkout rather than the empty channel directory. */
	checkout: boolean;
};

let checkouts = new Map<string, string>();
let directories = new Map<string, Promise<string>>();

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

/**
 * Chained per channel so concurrent sessions share one directory. `mkdtemp`
 * creates it with mode 0700; one removed from under a running server is
 * replaced rather than recreated at a name somebody else could have taken.
 */
function directory(channelId: string): Promise<string> {
	let previous = directories.get(channelId);
	let next = (async () => {
		let path = await previous?.catch(() => undefined);
		if (path && await stat(path).then(found => found.isDirectory(), () => false)) return path;
		return mkdtemp(join(tmpdir(), "chopin-planner-"));
	})();
	directories.set(channelId, next);
	return next;
}

export async function removeWorkspaces(): Promise<void> {
	let paths = await Promise.all(
		[...directories.values()].map(path => path.catch(() => undefined)),
	);
	directories.clear();
	checkouts.clear();
	await Promise.all(
		paths.map(path => path && rm(path, { recursive: true, force: true }).catch(() => {})),
	);
}
