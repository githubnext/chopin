import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plantedRedirects, removePlantedRedirects } from "./git-directories";

let scratch = realpathSync(mkdtempSync(join(tmpdir(), "chopin-git-directories-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]) {
	let result = spawnSync("git", [
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"-c",
		"commit.gpgsign=false",
		...args,
	], { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
}

function checkout(name: string) {
	let root = join(scratch, name);
	mkdirSync(root, { recursive: true });
	git(root, "init", "-b", "main");
	writeFileSync(join(root, "a.txt"), "a");
	git(root, "add", ".");
	git(root, "commit", "-m", "init");
	return root;
}

test("a checkout's git directory never has a commondir, and one an agent made there is found and removed", () => {
	let root = checkout("plain");
	expect(plantedRedirects(root)).toEqual([]);
	let file = join(root, ".git", "commondir");
	writeFileSync(file, `${join(scratch, "elsewhere")}\n`);
	expect(plantedRedirects(root)).toEqual([file]);
	expect(removePlantedRedirects(root)).toEqual([file]);
	expect(existsSync(file)).toBe(false);
	expect(plantedRedirects(root)).toEqual([]);
});

test("a linked worktree's own commondir is the repository's doing and stays, while one in the repository's git directory is found from the worktree too", () => {
	let root = checkout("linked");
	let worktree = join(scratch, "linked-worktree");
	git(root, "worktree", "add", "--detach", worktree);
	let own = join(root, ".git", "worktrees", "linked-worktree", "commondir");
	expect(existsSync(own)).toBe(true);
	expect(plantedRedirects(worktree)).toEqual([]);
	expect(plantedRedirects(root)).toEqual([]);
	let planted = join(root, ".git", "commondir");
	writeFileSync(planted, `${join(scratch, "elsewhere")}\n`);
	expect(plantedRedirects(worktree)).toEqual([planted]);
	expect(removePlantedRedirects(worktree)).toEqual([planted]);
	expect(existsSync(own)).toBe(true);
});

test("a submodule's git directory is a main one too, nested ones included", () => {
	let root = checkout("modules");
	let gitDirectory = (...parts: string[]) => {
		let path = join(...parts);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "HEAD"), "ref: refs/heads/main\n");
		return path;
	};
	let lib = gitDirectory(root, ".git", "modules", "lib");
	let deep = gitDirectory(lib, "modules", "deep");
	writeFileSync(join(lib, "commondir"), "..\n");
	writeFileSync(join(deep, "commondir"), "..\n");
	expect(plantedRedirects(root).sort()).toEqual(
		[join(deep, "commondir"), join(lib, "commondir")].sort(),
	);
	expect(removePlantedRedirects(root)).toHaveLength(2);
	expect(plantedRedirects(root)).toEqual([]);
});

test("a folder that is no checkout, or has no git directory yet, has nothing planted", () => {
	let folder = join(scratch, "nothing");
	mkdirSync(folder);
	expect(plantedRedirects(folder)).toEqual([]);
	expect(removePlantedRedirects(join(scratch, "missing"))).toEqual([]);
	writeFileSync(join(folder, ".git"), "not a pointer\n");
	expect(plantedRedirects(folder)).toEqual([]);
});
