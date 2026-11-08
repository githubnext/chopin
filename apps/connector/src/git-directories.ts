import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

function isDirectory(path: string) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** The git directories of the submodules under `folder` (`<git dir>/modules`), the nested ones too. */
export function moduleDirectories(folder: string, depth = 0): string[] {
	if (depth > 4) return [];
	let found: string[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(folder);
	} catch { /* No submodules. */ }
	for (let name of names) {
		let path = join(folder, name);
		if (!isDirectory(path)) continue;
		// A submodule named with a slash lives in a folder of that name, which is not itself one.
		if (existsSync(join(path, "HEAD"))) {
			found.push(path, ...moduleDirectories(join(path, "modules")));
		} else found.push(...moduleDirectories(path, depth + 1));
	}
	return found;
}

/**
 * The git directories of the repository `root` belongs to that no linked worktree's git directory
 * is: its own, as the checkout's `.git` is, or the one a linked worktree's `.git` file leads to
 * through `commondir`, and the git directory of each of its submodules. Read from the files, never
 * through git, which follows the very redirect this looks for.
 */
function mainGitDirectories(root: string): string[] {
	let dot = join(root, ".git");
	let main: string | undefined;
	if (isDirectory(dot)) main = dot;
	else {
		try {
			let line = readFileSync(dot, "utf8").split("\n")[0] ?? "";
			if (!line.startsWith("gitdir:")) return [];
			let admin = resolve(root, line.slice("gitdir:".length).trim());
			try {
				main = resolve(admin, readFileSync(join(admin, "commondir"), "utf8").trim());
			} catch {
				main = admin;
			}
		} catch {
			return [];
		}
	}
	return [main, ...moduleDirectories(join(main, "modules"))];
}

/**
 * The `commondir` files in the repository's main git directories. Git reads one from any git
 * directory that has it and takes the configuration, hooks and objects of the directory it
 * names, so one in a checkout's own git directory would send every git command run there by a
 * person to a configuration an agent wrote. Only a linked worktree's git directory has one, so
 * none of these is anyone's but an agent's. The sandbox's policy leaves no way to make one, and the
 * connector's own git is told where the repository is and never looks for one; this is a cheap
 * check for what an agent of a release without that policy left, or one that was not sandboxed.
 */
export function plantedRedirects(root: string): string[] {
	return mainGitDirectories(root).map(directory => join(directory, "commondir")).filter(file =>
		existsSync(file)
	);
}

/** Remove what `plantedRedirects` finds, and say what it removed. */
export function removePlantedRedirects(root: string): string[] {
	let removed: string[] = [];
	for (let file of plantedRedirects(root)) {
		try {
			rmSync(file, { force: true });
			removed.push(file);
		} catch { /* Left where it is, and found again. */ }
	}
	return removed;
}

function real(path: string) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * The directory in `<common>/worktrees` that belongs to the linked worktree at `place`: the one
 * whose `gitdir` file, which git wrote when the worktree was made, names `<place>/.git`. Found
 * from the repository's side, never from the `.git` file in the worktree, which an agent that
 * works there can write.
 */
export function worktreeEntry(common: string, place: string): string | undefined {
	let wanted = real(place);
	let folder = join(common, "worktrees");
	let names: string[] = [];
	try {
		names = readdirSync(folder);
	} catch { /* No linked worktrees. */ }
	for (let name of names) {
		let entry = join(folder, name);
		try {
			let line = readFileSync(join(entry, "gitdir"), "utf8").split("\n")[0]?.trim() ?? "";
			if (!line || basename(line) !== ".git") continue;
			if (real(dirname(isAbsolute(line) ? line : resolve(entry, line))) === wanted) return entry;
		} catch { /* Not an entry, or one without a gitdir. */ }
	}
	return undefined;
}
