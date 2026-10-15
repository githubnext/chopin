/**
 * The GitHub token a paired machine's processes push with: its owner's own user-to-server token
 * of this server's GitHub App, as the machine's grant holds it. Chopin hands it to the machine's
 * connector only for a repository its owner can push to, through an App installation that may
 * write contents and pull requests; otherwise the machine keeps using its own `gh` or Git login.
 */

import { fail } from "./service";

import type { Machines } from "../auth/machines";
import type { GitHub } from "../github/client";
import type { StoredMachine } from "../storage/model";

/** A token closer than this to expiring is refreshed before it is handed out. */
export const GITHUB_TOKEN_FRESH_MS = 30 * 60_000;

export type MachineGitHub = {
	machines: Pick<Machines, "access" | "use">;
	github: Pick<GitHub, "installedRepository">;
	clock?: () => Date;
};

/**
 * The machine's current GitHub access token for `repository` (`owner/name`), with at least
 * `GITHUB_TOKEN_FRESH_MS` left, and when it expires, in ms. Refuses with `repository-forbidden`
 * when the owner can't push there or the App isn't installed on it, and `app-cannot-push` when the
 * installation can't write contents and pull requests. Anything GitHub doesn't answer is thrown,
 * so no token goes out unchecked. Never the refresh token.
 */
export async function machineGitHubToken(
	deps: MachineGitHub,
	machine: StoredMachine,
	repository: string,
): Promise<{ token: string; expiresAt: number }> {
	let [owner, name, extra] = repository.split("/");
	if (!owner || !name || extra !== undefined) fail("invalid-request");
	let installedRepository = deps.github.installedRepository?.bind(deps.github);
	if (!installedRepository) fail("app-cannot-push");
	let installed = await deps.machines.use(
		machine,
		token => installedRepository(token, owner, name),
	);
	if (!installed?.repository.permissions.push) fail("repository-forbidden");
	let writable = installed.installation.writable;
	if (!writable?.contents || !writable.pullRequests) {
		fail(
			"app-cannot-push",
			`The GitHub App can't push to ${installed.repository.fullName} (it needs Contents and `
				+ "Pull requests write).",
		);
	}
	let now = (deps.clock ?? (() => new Date()))().getTime();
	let access = await deps.machines.access(machine);
	if (access.expiresAt.getTime() - now < GITHUB_TOKEN_FRESH_MS) {
		access = await deps.machines.access(machine, access.token);
	}
	return { token: access.token, expiresAt: access.expiresAt.getTime() };
}
