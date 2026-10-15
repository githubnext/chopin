import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redacted } from "./connection";
import { gitCredentials, type GitHubToken } from "./github-token";
import { segment, workspace } from "./workspace";

const exec = promisify(execFile);

/** The checkouts `chopin connect` registered, by GitHub repository (`owner/name`) to their root. */
export type Registered = Record<string, string>;

/** What the work in a repository runs from, and how its git commands reach GitHub, if they must. */
export type Resolved = {
	root: string;
	/** Credential configuration for git through the environment; empty for a registered checkout. */
	env: Record<string, string>;
};

/**
 * Validate each path as a GitHub checkout, by its toplevel, keyed by its origin's repository.
 * Two checkouts of one repository are refused, as the work would not know which to use.
 */
export async function registerCheckouts(paths: string[]): Promise<Registered> {
	let registered: Registered = {};
	for (let path of paths) {
		let info = await workspace(path);
		let same = Object.keys(registered).find(key =>
			key.toLowerCase() === info.repository.toLowerCase()
		);
		if (same && registered[same] !== info.root) {
			throw new Error(
				`${registered[same]} and ${info.root} are both checkouts of ${info.repository}. Give `
					+ "only one of them with --checkout.",
			);
		}
		registered[same ?? info.repository] = info.root;
	}
	return registered;
}

/** Where an on-demand clone of `repository` lives: `<base>/repos/<owner>/<repo>`, lowercase. */
export function clonePath(directory: string, repository: string) {
	let [owner = "", name = ""] = repository.toLowerCase().split("/");
	return join(directory, "repos", segment(owner), segment(name));
}

/** The clones in `<base>/repos/<owner>/<repo>`, with their repository as their folders name it. */
export async function clones(directory: string) {
	let found: Array<{ repository: string; path: string }> = [];
	let folders = async (path: string) =>
		(await readdir(path, { withFileTypes: true }).catch(() => []))
			.filter(entry => entry.isDirectory() && !entry.name.endsWith(".tmp"))
			.map(entry => entry.name).sort();
	let base = join(directory, "repos");
	for (let owner of await folders(base)) {
		for (let name of await folders(join(base, owner))) {
			let path = join(base, owner, name);
			if (existsSync(join(path, ".git"))) found.push({ repository: `${owner}/${name}`, path });
		}
	}
	return found;
}

/** Said when work arrives for a repository this machine can't get a checkout of. */
export function noCheckout(repository: string) {
	return `This machine has no checkout of ${repository}, and Chopin gave it no GitHub token to `
		+ `clone one. Run chopin connect --checkout <path> with a clone of ${repository}, then start `
		+ "the work again.";
}

const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/**
 * Where a machine's work runs: the registered checkout of the work's repository, else a clone of
 * it in `<base>/repos/<owner>/<repo>`, made on demand over HTTPS and fetched again before each
 * piece of work. The machine's GitHub token, asked for only when a clone is needed, reaches git
 * through a credential helper in the environment that reads its 0600 file, never through a
 * command line or the clone's own configuration. One repository is cloned or fetched at a time.
 */
export function checkouts(options: { directory: string; registered: Registered }) {
	let locks = new Map<string, Promise<unknown>>();
	let locked = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
		let next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
		locks.set(key, next);
		try {
			return await next;
		} finally {
			if (locks.get(key) === next) locks.delete(key);
		}
	};
	return {
		registered: options.registered,
		/**
		 * The checkout for work in `repository`; `token` gives the machine's GitHub token for it,
		 * asked for only when there is no registered checkout.
		 */
		async resolve(
			repository: string,
			token?: () => Promise<GitHubToken | undefined>,
		): Promise<Resolved> {
			let key = Object.keys(options.registered).find(name =>
				name.toLowerCase() === repository.toLowerCase()
			);
			if (key) return { root: options.registered[key]!, env: {} };
			let [owner = "", name = ""] = repository.split("/");
			if (!REPOSITORY.test(repository) || /^\.+$/.test(owner) || /^\.+$/.test(name)) {
				throw new Error(`Chopin named an invalid repository, ${repository}.`);
			}
			let path = clonePath(options.directory, repository);
			return locked(path, async () => {
				let github = await token?.();
				if (!github) throw new Error(noCheckout(repository));
				let env = gitCredentials(github.file);
				let run = async (args: string[], cwd?: string) => {
					try {
						await exec("git", args, {
							...(cwd ? { cwd } : {}),
							env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
							timeout: 30 * 60_000,
							maxBuffer: 16 * 1024 * 1024,
						});
					} catch (error) {
						let stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
						let lines = stderr.split("\n");
						let detail = redacted(
							lines.find(line => line.startsWith("fatal:")) ?? (lines.at(-1)
								|| (error as Error).message),
						);
						throw new Error(
							`Couldn't ${args[0] === "clone" ? "clone" : "fetch"} ${repository} (${detail}).`,
							{ cause: error },
						);
					}
				};
				if (existsSync(join(path, ".git"))) {
					await run(["fetch", "--quiet", "--prune", "origin"], path);
				} else {
					await mkdir(dirname(path), { recursive: true, mode: 0o700 });
					// Cloned beside where it goes, then moved there, so a clone cut short is never used.
					let temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
					try {
						await run([
							"clone",
							"--quiet",
							"--",
							`https://github.com/${owner}/${name}.git`,
							temporary,
						]);
						await rm(path, { recursive: true, force: true });
						await rename(temporary, path);
					} finally {
						await rm(temporary, { recursive: true, force: true });
					}
				}
				return { root: await realpath(path), env };
			});
		},
	};
}

export type Checkouts = ReturnType<typeof checkouts>;
