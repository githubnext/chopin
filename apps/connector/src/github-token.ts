import { rename, rm, writeFile } from "node:fs/promises";
import { errorCode, machineGitHubToken } from "./machine";

/** Chopin hands out a token with at least 30 minutes left; this one is replaced 25 before. */
export const RENEW_BEFORE_MS = 25 * 60_000;
/** How soon a renewal that failed is tried again, until the token expires. */
const RETRY_MS = 60_000;

/** What the connector says, once for each, when the GitHub App can't push to a repository. */
export function appCannotPush(repository: string) {
	return `The GitHub App can't push to ${repository} (it needs Contents and Pull requests write), `
		+ "so this machine uses its own GitHub login for it.";
}

export type GitHubToken = {
	/** The token as first handed out, and when it expires (ms). */
	token: string;
	expiresAt: number;
	/** The 0600 file that always holds the current token and a newline. */
	file: string;
	/** Every token handed out so far, to mask wherever they might be printed. */
	secrets(): string[];
	/** Stops renewing and deletes the file. */
	stop(): Promise<void>;
};

/**
 * The machine's GitHub token for `repository`, for one Planner command or run: written to `file`
 * (mode 0600), and replaced there `renewBeforeMs` before it expires for as long as it lasts. Any
 * refusal or failure gives undefined, so nothing gets a token Chopin didn't check; `refused` hears
 * the line to say when the reason is that the GitHub App can't push there.
 */
export async function githubToken(options: {
	url: string;
	machine: string;
	repository: string;
	file: string;
	refused?: (message: string, repository: string) => void;
	renewBeforeMs?: number;
}): Promise<GitHubToken | undefined> {
	let { file } = options;
	let ask = () => machineGitHubToken(options.url, options.machine, options.repository);
	let first;
	try {
		first = await ask();
	} catch (error) {
		if (errorCode(error) === "app-cannot-push") {
			options.refused?.(appCannotPush(options.repository), options.repository);
		}
		return undefined;
	}
	let seen = [first.token];
	let save = async (token: string) => {
		let temporary = `${file}.${process.pid}.tmp`;
		await writeFile(temporary, `${token}\n`, { mode: 0o600 });
		await rename(temporary, file);
	};
	try {
		await save(first.token);
	} catch {
		return undefined;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	let renewing: Promise<void> | undefined;
	let stopped = false;
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
		} catch {
			if (stopped) return;
			// Once it has expired, a stale token in the file would only fail; better none.
			if (Date.now() >= expiresAt) await rm(file, { force: true });
			else schedule(expiresAt, Math.min(RETRY_MS, expiresAt - Date.now()));
		}
	};
	schedule(first.expiresAt);
	return {
		token: first.token,
		expiresAt: first.expiresAt,
		file,
		secrets: () => [...seen],
		async stop() {
			stopped = true;
			clearTimeout(timer);
			// A renewal still writing the file finishes before it goes.
			await renewing;
			await rm(file, { force: true });
		},
	};
}

/**
 * What a run's agent gets to push and open pull requests with the machine's token: `GH_TOKEN` and
 * `GITHUB_TOKEN` for gh and other tools, and Git configuration, through the environment, whose
 * credential helper for github.com reads the token file, so a renewed token is used as soon as it
 * is written. Earlier helpers for github.com are cleared, so the agent's own login doesn't win;
 * nothing goes into the repository's own configuration.
 */
export function githubEnvironment(github: GitHubToken): Record<string, string> {
	return { GH_TOKEN: github.token, GITHUB_TOKEN: github.token, ...gitCredentials(github.file) };
}

/**
 * Git configuration, through the environment, whose only credential helper for github.com reads
 * the token in `file`, so a renewed token is used as soon as it is written and the token itself is
 * never on a command line or in a repository's configuration.
 */
export function gitCredentials(file: string): Record<string, string> {
	let quoted = `'${file.replaceAll("'", "'\\''")}'`;
	return {
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
		GIT_CONFIG_VALUE_0: "",
		GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
		GIT_CONFIG_VALUE_1:
			`!f() { test "$1" = get || exit 0; echo username=x-access-token; printf password=; cat ${quoted}; }; f`,
	};
}
