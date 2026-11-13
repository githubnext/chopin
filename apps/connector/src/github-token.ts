import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	errorCode,
	GITHUB_REFUSALS,
	type GitHubAccount,
	type GitHubGrantRequest,
	machineGitHubToken,
} from "./machine";

/** Chopin hands out a token with at least 30 minutes left; this one is replaced 25 before. */
export const RENEW_BEFORE_MS = 25 * 60_000;
/** How soon a renewal that failed is tried again, until the token expires. */
const RETRY_MS = 60_000;

/**
 * Why a launch got no GitHub token from Chopin, said so the person knows which repository and what
 * fixes it. Nothing starts after one: the machine never falls back to its own GitHub login.
 */
export class GitHubRefused extends Error {
	constructor(readonly code: string, readonly repository: string) {
		super(githubRefusal(code, repository));
		this.name = "GitHubRefused";
	}
}

/** What the connector says when Chopin refuses a launch a GitHub token for `repository`. */
export function githubRefusal(code: string, repository: string) {
	switch (code) {
		case "repository-forbidden":
			return `Chopin gave this machine no GitHub token for ${repository}: its owner can't push `
				+ `there, so nothing ran. Ask for write access to ${repository}, or choose another machine.`;
		case "app-cannot-push":
			return `Chopin's GitHub App can't write to ${repository}; it needs Contents and Pull requests `
				+ "write, which an admin of the repository must grant. This machine won't use its own GitHub "
				+ "login, so nothing ran.";
		case "starter-cannot-push":
			return `Whoever started this can't push to ${repository}, so Chopin gave it no GitHub token `
				+ `and nothing ran. Ask for write access to ${repository}, then start it again.`;
		case "run-unknown":
			return `Chopin no longer knows this work, so it gave no GitHub token for ${repository} and `
				+ "nothing ran.";
		case "no-grant":
			return `This Chopin has no GitHub App to give this machine a token for ${repository}, so `
				+ "nothing ran. This machine won't use its own GitHub login.";
		default:
			return `Chopin refused this machine a GitHub token for ${repository} (${code}), so nothing ran.`;
	}
}

/** Said when a token lapsed because Chopin couldn't renew it, and what used it was stopped. */
export function githubExpired(repository: string) {
	return `The GitHub token for ${repository} expired and Chopin couldn't renew it, so this stopped.`;
}

export type GitHubToken = {
	/** The token as first handed out, and when it expires (ms). */
	token: string;
	expiresAt: number;
	/** The 0600 file that always holds the current token and a newline. */
	file: string;
	/** gh's configuration folder for the launch, whose `hosts.yml` holds the current token. */
	config: string;
	/** The account commits are made as: Chopin's GitHub App. */
	identity: GitHubAccount;
	/** The person the work is for, when Chopin names one. */
	starter?: GitHubAccount;
	/** Aborted, with `githubExpired`, once the token lapsed without a renewal. */
	expired: AbortSignal;
	/** Every token handed out so far, to mask wherever they might be printed. */
	secrets(): string[];
	/** Stops renewing and deletes the file and gh's configuration. */
	stop(): Promise<void>;
};

/** A YAML double-quoted scalar, as JSON writes a string. */
let yaml = (text: string) => JSON.stringify(text);

/**
 * gh's configuration for one account: `hosts.yml` in the layout gh 2.40 and later reads (its
 * `users` map, and the active user's token beside it), and `config.yml` saying that layout is
 * already in use, so gh never migrates it or looks in a keyring.
 */
function ghHosts(token: string, login: string) {
	return [
		"github.com:",
		"    users:",
		`        ${yaml(login)}:`,
		`            oauth_token: ${yaml(token)}`,
		"    git_protocol: https",
		`    oauth_token: ${yaml(token)}`,
		`    user: ${yaml(login)}`,
		"",
	].join("\n");
}
const GH_CONFIG = ['version: "1"', "git_protocol: https", "prompt: disabled", ""].join("\n");

/**
 * Chopin's GitHub token for one Planner command or run, asked for with what it is for: written to
 * `github` in `folder` (mode 0600) and to gh's configuration in `gh/`, and replaced in both
 * `renewBeforeMs` before it expires for as long as it lasts. A refusal rejects with
 * `GitHubRefused`; any other failure rejects as it came. Once a token expires without a renewal,
 * both are removed and `expired` aborts, so what used it stops instead of failing on its own.
 */
export async function githubToken(
	options: GitHubGrantRequest & {
		url: string;
		machine: string;
		folder: string;
		renewBeforeMs?: number;
	},
): Promise<GitHubToken> {
	let { folder, repository } = options;
	let request: GitHubGrantRequest = {
		repository,
		purpose: options.purpose,
		...(options.run ? { run: options.run } : {}),
		...(options.document ? { document: options.document } : {}),
	};
	let ask = async () => {
		try {
			return await machineGitHubToken(options.url, options.machine, request);
		} catch (error) {
			let code = errorCode(error);
			if (code && GITHUB_REFUSALS.has(code)) throw new GitHubRefused(code, repository);
			throw error;
		}
	};
	let first = await ask();
	let file = join(folder, "github");
	let config = join(folder, "gh");
	let seen = [first.token];
	let put = async (path: string, text: string) => {
		let temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, text, { mode: 0o600 });
		await rename(temporary, path);
	};
	let save = async (token: string) => {
		await put(file, `${token}\n`);
		await put(join(config, "hosts.yml"), ghHosts(token, first.identity.login));
	};
	await mkdir(config, { recursive: true, mode: 0o700 });
	await put(join(config, "config.yml"), GH_CONFIG);
	await save(first.token);
	let lapsed = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let renewing: Promise<void> | undefined;
	let stopped = false;
	let remove = async () => {
		await rm(file, { force: true });
		await rm(config, { recursive: true, force: true });
	};
	let schedule = (expiresAt: number, delay?: number) => {
		if (stopped) return;
		let wait = delay ?? expiresAt - Date.now() - (options.renewBeforeMs ?? RENEW_BEFORE_MS);
		timer = setTimeout(
			() => renewing = renew(expiresAt),
			Math.min(Math.max(wait, 0), 2 ** 31 - 1),
		);
		timer.unref?.();
	};
	let renew = async (expiresAt: number) => {
		try {
			let next = await ask();
			if (stopped) return;
			seen.push(next.token);
			await save(next.token);
			schedule(next.expiresAt);
		} catch (error) {
			if (stopped) return;
			// A refusal is final, and once the token has expired a stale one would only fail: what
			// used it is stopped rather than left to fail on its own.
			if (error instanceof GitHubRefused || Date.now() >= expiresAt) {
				await remove();
				lapsed.abort(new Error(githubExpired(repository)));
			} else schedule(expiresAt, Math.min(RETRY_MS, expiresAt - Date.now()));
		}
	};
	schedule(first.expiresAt);
	return {
		token: first.token,
		expiresAt: first.expiresAt,
		file,
		config,
		identity: first.identity,
		...(first.starter ? { starter: first.starter } : {}),
		expired: lapsed.signal,
		secrets: () => [...seen],
		async stop() {
			stopped = true;
			clearTimeout(timer);
			// A renewal still writing the file finishes before it goes.
			await renewing;
			await remove();
		},
	};
}

/**
 * What a launch inherits that would reach GitHub or an SSH key as someone other than Chopin's App:
 * gh's own variables and tokens, git's askpass, SSH agent and command, and any Git configuration
 * through the environment. Removed from the connector's environment and the `--env` values before
 * a launch is given its own (see `githubEnvironment`).
 */
export function inheritsGitHub(name: string) {
	let key = name.toUpperCase();
	return key.startsWith("GH_") || key.startsWith("GIT_SSH") || key.startsWith("GIT_CONFIG_")
		|| [
			"GITHUB_TOKEN",
			"GITHUB_ENTERPRISE_TOKEN",
			"GIT_ASKPASS",
			"SSH_ASKPASS",
			"SSH_AUTH_SOCK",
			"GIT_CONFIG",
			"GIT_AUTHOR_NAME",
			"GIT_AUTHOR_EMAIL",
			"GIT_COMMITTER_NAME",
			"GIT_COMMITTER_EMAIL",
		].includes(key);
}

/** `env` without what `inheritsGitHub` names. */
export function withoutGitHub<T extends string | undefined>(
	env: Record<string, T>,
): Record<string, T> {
	return Object.fromEntries(Object.entries(env).filter(([name]) => !inheritsGitHub(name)));
}

/**
 * Everything a launch gets to reach GitHub with Chopin's token, and nothing of the machine's:
 *
 * - **gh** reads `GH_CONFIG_DIR`, the launch's own configuration, rewritten with each renewed
 *   token, never the person's `~/.config/gh`. No `GH_TOKEN` or `GITHUB_TOKEN` is set: either would
 *   win over the configuration and go stale at the first renewal.
 * - **git** has one credential helper for github.com, which reads the token file, and the
 *   repository's SSH URLs map to https (`gitCredentials`); `GIT_SSH_COMMAND` is `false`, so no SSH
 *   key or agent is ever used.
 * - **Commits** are made as Chopin's App (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`), never as whoever the
 *   machine's Git configuration names (`user.useConfigOnly`), and are not signed with the machine's
 *   keys (`commit.gpgsign`, `tag.gpgsign`).
 * - **The person it is for**, when Chopin names one, in `CHOPIN_STARTER_LOGIN`, `_NAME` and
 *   `_EMAIL`, for a pull request's "Requested by" and a commit's `Co-authored-by`.
 * - `CHOPIN_GITHUB_TOKEN_FILE` names the token file, for a backend's own use of the token.
 *
 * It goes on top of an environment `withoutGitHub` cleared.
 */
export function githubEnvironment(
	github: GitHubToken,
	repository?: string,
): Record<string, string> {
	return {
		...githubPaths(github.file, github.config, repository),
		...githubIdentity(github),
	};
}

/**
 * The part of `githubEnvironment` that doesn't depend on the token or whose it is: where gh's
 * configuration and the token file will be, git's credential helper reading that file, and the
 * repository's URL rules. A spare Planner starts with it before it has a token (see
 * `planner-spare.ts`); the files it names appear later.
 */
export function githubPaths(
	file: string,
	config: string,
	repository?: string,
): Record<string, string> {
	return {
		GH_CONFIG_DIR: config,
		GH_PROMPT_DISABLED: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_SSH_COMMAND: "false",
		CHOPIN_GITHUB_TOKEN_FILE: file,
		...gitCredentials(file, repository, [
			["user.useConfigOnly", "true"],
			["commit.gpgsign", "false"],
			["tag.gpgsign", "false"],
		]),
	};
}

/** Who a launch's commits are made as, and the person its work is for (see `githubEnvironment`). */
export function githubIdentity(github: Pick<GitHubToken, "identity" | "starter">) {
	let { identity, starter } = github;
	return {
		GIT_AUTHOR_NAME: identity.name,
		GIT_AUTHOR_EMAIL: identity.email,
		GIT_COMMITTER_NAME: identity.name,
		GIT_COMMITTER_EMAIL: identity.email,
		...(starter
			? {
				CHOPIN_STARTER_LOGIN: starter.login,
				CHOPIN_STARTER_NAME: starter.name,
				CHOPIN_STARTER_EMAIL: starter.email,
			}
			: {}),
	};
}

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/**
 * The Git configuration that keeps `repository`'s github.com URLs on https, where the machine's
 * token applies, whatever the person's own Git configuration says. A `url.<base>.insteadOf` rule
 * rewrites the longest prefix that matches, and the first of two equally long ones wins, which is
 * the person's. So the rule here maps the repository's own URL to itself, for fetches and pushes:
 * it is longer than any rule for `https://github.com/` or for the owner, which is what people
 * write. The SSH forms of the URL map to https, so a checkout whose origin is `git@github.com:…`
 * reaches GitHub with the token too, and a service has no SSH agent. Its spelling and its
 * lowercase are both covered, as prefixes match by case. Other repositories are left as they are.
 */
export function githubUrlRules(repository: string): Array<[string, string]> {
	if (!REPOSITORY.test(repository)) return [];
	let rules: Array<[string, string]> = [];
	let spellings = [...new Set([repository, repository.toLowerCase()])];
	for (let spelling of spellings) {
		let https = `https://github.com/${spelling}`;
		rules.push([`url.${https}.insteadOf`, https], [`url.${https}.pushInsteadOf`, https]);
		for (let ssh of [`git@github.com:${spelling}`, `ssh://git@github.com/${spelling}`]) {
			rules.push([`url.${https}.insteadOf`, ssh], [`url.${https}.pushInsteadOf`, ssh]);
		}
	}
	return rules;
}

/**
 * Git configuration, through the environment, whose only credential helper for github.com reads
 * the token in `file`, so a renewed token is used as soon as it is written and the token itself is
 * never on a command line or in a repository's configuration. With `repository`, its URLs also
 * stay on https whatever `url.<base>.insteadOf` the person has (see `githubUrlRules`). The rest of
 * the person's Git configuration applies as it is.
 */
export function gitCredentials(
	file: string,
	repository?: string,
	more: Array<[string, string]> = [],
): Record<string, string> {
	let quoted = `'${file.replaceAll("'", "'\\''")}'`;
	let entries: Array<[string, string]> = [
		["credential.https://github.com.helper", ""],
		[
			"credential.https://github.com.helper",
			`!f() { test "$1" = get || exit 0; echo username=x-access-token; printf password=; cat ${quoted}; }; f`,
		],
		...repository ? githubUrlRules(repository) : [],
		...more,
	];
	let env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
	entries.forEach(([key, value], index) => {
		env[`GIT_CONFIG_KEY_${index}`] = key;
		env[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	return env;
}
