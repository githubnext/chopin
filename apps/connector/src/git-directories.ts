import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

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
 * names, so one in a checkout's own git directory sends every git command run there, by a person
 * or by the connector, to a configuration an agent wrote and the programs it names. Only a
 * linked worktree's git directory has one, so none of these is anyone's but an agent's. A sandbox
 * can't hold back a file that doesn't exist, and can't hold back its creation in a directory that
 * must be written whole, a checkout's own.
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
