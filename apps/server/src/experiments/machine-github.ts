/**
 * The GitHub token a paired machine's processes push with. A connector that names what the token
 * is for (protocol 7) gets one of this server's GitHub App installation tokens, for one repository,
 * acting as the App's bot and crediting the person who started the work (`launchGitHubToken`).
 * An older connector still gets its owner's own user-to-server token (`machineGitHubToken`), for a
 * repository its owner can push to, through an App installation that may write contents and pull
 * requests.
 */

import { fail } from "./service";

import type { Machines } from "../auth/machines";
import type { AppPermissions, GitHubAccount, GitHubApp } from "../github/app";
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

/** What a paired machine asks a token for: a run it claimed, its Planner, or only whether it could. */
export type LaunchRequest = {
	repository: string;
	purpose: "run" | "planner" | "check";
	run?: string;
	document?: string;
};

/** A run Chopin gave a machine, as the token for it needs it. */
export type LaunchRun = {
	kind: "build" | "investigation" | "spike";
	/** `owner/name`. */
	repository: string;
	/** The user ID of the person who started it. */
	starter: string;
	/** The paired machine it went to, when Chopin knows. */
	machineId?: string;
};

/** A GitHub account as a commit and a pull request name it. */
export type GitHubIdentity = { login: string; id: number; name: string; email: string };

export type LaunchGrant = {
	token: string;
	expiresAt: number;
	kind: "installation";
	permissions: Record<string, string>;
	/** The App's bot, which commits, pushes and opens pull requests with the token. */
	identity: GitHubIdentity;
	/** Who started the run, or the machine's owner for its Planner: credited, never the author. */
	starter: GitHubIdentity;
};

export type LaunchGitHub = MachineGitHub & {
	/** The App acting as itself; without it no installation token can be minted. */
	app?: GitHubApp;
	/** The App's slug, whose bot `<slug>[bot]` the tokens act as. */
	slug: string;
	run(id: string, document: string | undefined): Promise<LaunchRun | undefined>;
	user(id: string): Promise<{ id: string; login: string } | undefined>;
	/** Hears who each token went out for, by user ID. */
	remember?: (userId: string, identity: GitHubIdentity) => void;
	log?: (line: string) => void;
};

const RUN_WRITE: AppPermissions = { contents: "write", pull_requests: "write", metadata: "read" };
/** A prototype never pushes: its token only fetches the commit it starts from. */
const RUN_READ: AppPermissions = { contents: "read", metadata: "read" };

function covers(granted: Record<string, string>, wanted: AppPermissions) {
	return Object.entries(wanted).every(([name, level]) =>
		granted[name] === "write" || (level === "read" && granted[name] === "read")
	);
}

function identity(account: GitHubAccount): GitHubIdentity {
	return {
		login: account.login,
		id: account.id,
		name: account.name ?? account.login,
		email: `${account.id}+${account.login}@users.noreply.github.com`,
	};
}

let bots = new WeakMap<GitHubApp, Promise<GitHubAccount | undefined>>();
/** The App's bot account, read once per App with any token that can read users. */
function bot(app: GitHubApp, token: string, slug: string) {
	let known = bots.get(app);
	if (!known) {
		known = app.account(token, `${slug}[bot]`);
		bots.set(app, known);
		known.catch(() => bots.delete(app));
	}
	return known;
}

/**
 * A token of this server's GitHub App for one launch on a paired machine, limited to `repository`
 * and to what the launch does: a build, rebuild or investigation and a Planner may push and open
 * pull requests, a prototype only reads. It acts as the App's bot. Before one goes out, GitHub is
 * asked each time whether the person it is for can push there: whoever started the run, or the
 * machine's owner for its Planner. `check` asks the same and mints nothing. Every refusal names the
 * repository; anything GitHub doesn't answer is thrown.
 */
export async function launchGitHubToken(
	deps: LaunchGitHub,
	machine: StoredMachine,
	request: LaunchRequest,
): Promise<LaunchGrant | { ok: true }> {
	let [owner, name, extra] = request.repository.split("/");
	if (!owner || !name || extra !== undefined) fail("invalid-request");
	let repository = `${owner}/${name}`;
	let app = deps.app;
	if (!app) {
		fail(
			"no-grant",
			`This Chopin has no GitHub App key, so it gives no machine a token for ${repository}.`,
		);
	}
	let run: LaunchRun | undefined;
	if (request.purpose === "run") {
		if (!request.run) fail("invalid-request");
		run = await deps.run(request.run, request.document);
		if (
			!run || run.repository.toLowerCase() !== repository.toLowerCase()
			|| (run.machineId !== undefined && run.machineId !== machine.id)
		) fail("run-unknown", `Chopin has no run ${request.run} of this machine in ${repository}.`);
	}
	let wanted = run?.kind === "spike" ? RUN_READ : RUN_WRITE;
	let installation = await app.installation(owner, name);
	if (!installation || installation.suspended) {
		fail("app-cannot-push", `Chopin's GitHub App isn't installed on ${repository}.`);
	}
	if (!covers(installation.permissions, wanted)) {
		fail(
			"app-cannot-push",
			wanted === RUN_READ
				? `Chopin's GitHub App can't read ${repository} (it needs Contents read).`
				: `Chopin's GitHub App can't push to ${repository} (it needs Contents and Pull requests `
					+ "write).",
		);
	}
	let starterId = run?.starter ?? machine.userId;
	let starter = await deps.user(starterId);
	if (!starter) {
		fail("starter-cannot-push", `Chopin doesn't know who started this in ${repository}.`);
	}
	let login = starter.login;
	function cannotPush(): never {
		fail(
			"starter-cannot-push",
			run
				? `${login} can't push to ${repository}, so their run there gets no token.`
				: `${login} can't push to ${repository}, so this machine gets no token for it.`,
		);
	}
	if (!run) {
		// The machine's owner, asked with their own grant as the machine's other GitHub calls are.
		let installedRepository = deps.github.installedRepository?.bind(deps.github);
		if (!installedRepository) fail("app-cannot-push", `Chopin can't check ${repository}.`);
		let installed = await deps.machines.use(
			machine,
			token => installedRepository(token, owner, name),
		);
		if (!installed) fail("repository-forbidden", `${starter.login} can't see ${repository}.`);
		if (!installed.repository.permissions.push && !installed.repository.permissions.admin) {
			cannotPush();
		}
	}
	if (request.purpose === "check") return { ok: true };
	// Workflow files can be pushed only with the Workflows permission, which the App asks for.
	let asked = wanted !== RUN_READ && installation.permissions.workflows === "write"
		? { ...wanted, workflows: "write" as const }
		: wanted;
	let minted = await app.token(installation.id, name, asked);
	try {
		if (run && !await app.canPush(minted.token, owner, name, starter.login)) cannotPush();
		let account = await app.account(minted.token, starter.login);
		// A login can change hands; the stored GitHub node ID is who started it.
		if (!account || account.nodeId !== starter.id) cannotPush();
		let actor = await bot(app, minted.token, deps.slug);
		if (!actor) {
			fail("app-cannot-push", `Chopin can't find its GitHub App's bot for ${repository}.`);
		}
		(deps.log ?? console.info)(
			`chopin: GitHub App token (${request.purpose}${run ? ` ${run.kind}` : ""}) for machine `
				+ `${machine.id} in ${repository}`
				+ `${request.run ? `, run ${request.run}` : ""}`
				+ `${request.document ? `, document ${request.document}` : ""}, for ${account.login}`,
		);
		let credited = identity(account);
		deps.remember?.(starterId, credited);
		return {
			token: minted.token,
			expiresAt: minted.expiresAt,
			kind: "installation",
			permissions: minted.permissions,
			identity: identity(actor),
			starter: credited,
		};
	} catch (error) {
		await app.revoke(minted.token).catch(() => {});
		throw error;
	}
}
