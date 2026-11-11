import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkoutFiles, matchFiles, RepositoryFiles } from "./repository-files";

import type { FileListing, RepositoryTarget } from "./repository-files";

let REPOSITORY: RepositoryTarget = {
	id: "R_score",
	owner: "octo-org",
	name: "score",
	defaultBranch: "main",
};

let directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("the files a person can mention", () => {
	it("are the repository's, as GitHub lists them for the sender's session, kept for a minute", async () => {
		let calls: string[] = [];
		let now = 1_000;
		let files = new RepositoryFiles({
			remote: async (session, repository) => {
				calls.push(`${session}:${repository.id}`);
				return { paths: ["README.md", "src/index.ts"], truncated: false };
			},
			clock: () => now,
		});
		expect(await files.list("room", REPOSITORY, "s1")).toEqual({
			paths: ["README.md", "src/index.ts"],
			truncated: false,
		});
		await files.list("room", REPOSITORY, "s2");
		expect(calls).toEqual(["s1:R_score"]);
		now += 61_000;
		await files.list("room", REPOSITORY, "s2");
		expect(calls).toEqual(["s1:R_score", "s2:R_score"]);
	});

	it("are the checkout's where the document has one, and its changes show within seconds", async () => {
		let dir = await mkdtemp(join(tmpdir(), "chopin-files-"));
		directories.push(dir);
		await Bun.spawn(["git", "init", "-q"], { cwd: dir }).exited;
		await mkdir(join(dir, "docs"));
		await writeFile(join(dir, "docs", "a.md"), "a");
		await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
		await writeFile(join(dir, "ignored.txt"), "x");
		let now = 0;
		let remote = 0;
		let files = new RepositoryFiles({
			checkout: async () => dir,
			remote: async () => {
				remote++;
				return undefined;
			},
			clock: () => now,
		});
		expect(await files.list("room", REPOSITORY, "s1")).toEqual({
			paths: [".gitignore", "docs/a.md"],
			truncated: false,
		});
		await writeFile(join(dir, "docs", "b.md"), "b");
		expect((await files.list("room", REPOSITORY, "s1"))?.paths).toEqual([
			".gitignore",
			"docs/a.md",
		]);
		now += 11_000;
		expect((await files.list("room", REPOSITORY, "s1"))?.paths).toEqual([
			".gitignore",
			"docs/a.md",
			"docs/b.md",
		]);
		expect(remote).toBe(0);
		expect(await checkoutFiles(join(dir, "missing"))).toBeUndefined();
	});

	it("are none when neither a checkout nor GitHub can list them, or GitHub fails", async () => {
		expect(await new RepositoryFiles({}).list("room", REPOSITORY, "s1")).toBeUndefined();
		let failing = new RepositoryFiles({
			remote: async () => {
				throw new Error("rate limited");
			},
		});
		let logged = console.error;
		console.error = () => {};
		try {
			expect(await failing.list("room", REPOSITORY, "s1")).toBeUndefined();
			expect(await failing.has("room", REPOSITORY, "s1", "a.ts")).toBeUndefined();
		} finally {
			console.error = logged;
		}
	});

	it("tell whether a path is one of them", async () => {
		let listing: FileListing = { paths: ["src/index.ts"], truncated: false };
		let files = new RepositoryFiles({ remote: async () => listing });
		expect(await files.has("room", REPOSITORY, "s1", "src/index.ts")).toBe(true);
		expect(await files.has("room", REPOSITORY, "s1", "src/other.ts")).toBe(false);
		expect(await files.has("room", REPOSITORY, "s1", "src")).toBe(false);
	});
});

describe("matching a typed query to files", () => {
	let paths = [
		"README.md",
		"apps/web/src/index.ts",
		"apps/server/src/index.ts",
		"docs/reading-list.md",
		"src/chat/composer.tsx",
	];
	it("puts a file whose name starts with the query first, then its path, then names and paths that hold it", () => {
		expect(matchFiles(paths, "read", 8)).toEqual(["README.md", "docs/reading-list.md"]);
		expect(matchFiles(paths, "index", 8)).toEqual([
			"apps/web/src/index.ts",
			"apps/server/src/index.ts",
		]);
		expect(matchFiles(paths, "apps/s", 8)).toEqual(["apps/server/src/index.ts"]);
		expect(matchFiles(paths, "compos", 8)).toEqual(["src/chat/composer.tsx"]);
		expect(matchFiles(paths, "SRC/CH", 8)).toEqual(["src/chat/composer.tsx"]);
		expect(matchFiles(paths, "zzz", 8)).toEqual([]);
	});

	it("is the first files, in order, for an empty query, no more than the limit", () => {
		expect(matchFiles(paths, "", 2)).toEqual(["README.md", "apps/web/src/index.ts"]);
	});
});
