import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkouts, clonePath, clones, noCheckout, registerCheckouts } from "./checkouts";
import { gitCredentials, type GitHubToken } from "./github-token";
import { git } from "./workspace";

const TOKEN = "ghu_MachineToken0123456789";

/** A repository with one commit whose origin is github.com/`repository`. */
async function repository(
	parent: string,
	name: string,
	origin: string,
	url = `https://github.com/${origin}.git`,
) {
	let root = join(parent, name);
	await mkdir(root, { recursive: true });
	git(root, "init", "--quiet", "--initial-branch=main");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "user.email", "fixture@example.test");
	git(root, "remote", "add", "origin", url);
	await writeFile(join(root, "README.md"), `${origin}\n`);
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "fixture");
	return root;
}

/**
 * A machine whose GitHub is local: a global git config sends github.com to bare repositories
 * here, and a `git` first on PATH logs every command line and the credential configuration in
 * its environment before running the real git.
 */
async function localGitHub() {
	let scratch = await realpath(await mkdtemp(join(tmpdir(), "chopin-checkouts-")));
	let remotes = join(scratch, "remotes");
	// GitHub's names are case-insensitive; these bare repositories aren't, so both spellings.
	for (let name of ["org/repo", "org/other", "Org/Other"]) {
		let source = await repository(join(scratch, "sources"), name, name);
		spawnSync("git", ["clone", "--quiet", "--bare", source, join(remotes, `${name}.git`)]);
	}
	let global = join(scratch, "gitconfig");
	await writeFile(global, `[url "file://${remotes}/"]\n\tinsteadOf = https://github.com/\n`);
	let bin = join(scratch, "bin");
	let log = join(scratch, "git.log");
	await mkdir(bin);
	let real = Bun.which("git")!;
	await writeFile(
		join(bin, "git"),
		`#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' "$*" "$GIT_CONFIG_KEY_1" "$GIT_TERMINAL_PROMPT" >> '${log}'\n`
			+ `exec '${real}' "$@"\n`,
	);
	await chmod(join(bin, "git"), 0o755);
	let file = join(scratch, "token");
	await writeFile(file, `${TOKEN}\n`, { mode: 0o600 });
	let token: GitHubToken = {
		token: TOKEN,
		expiresAt: Date.now() + 3_600_000,
		file,
		secrets: () => [TOKEN],
		stop: async () => {},
	};
	let saved = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
	process.env.PATH = `${bin}:${process.env.PATH}`;
	process.env.GIT_CONFIG_GLOBAL = global;
	return {
		scratch,
		token,
		log: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n"),
		async [Symbol.asyncDispose]() {
			process.env.PATH = saved.PATH;
			if (saved.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = saved.GIT_CONFIG_GLOBAL;
			await rm(scratch, { recursive: true, force: true });
		},
	};
}

test.skipIf(process.platform === "win32")(
	"work runs in a registered checkout, and a repository without one is cloned with the token in the environment",
	async () => {
		await using fixture = await localGitHub();
		// By SSH, which the local GitHub's HTTPS rewrite leaves alone.
		let local = await repository(
			join(fixture.scratch, "work"),
			"score",
			"Org/Repo",
			"git@github.com:Org/Repo.git",
		);
		let base = join(fixture.scratch, "base");
		let registered = await registerCheckouts([join(local, ".")]);
		expect(registered).toEqual({ "Org/Repo": local });
		let asked: string[] = [];
		let machine = checkouts({ directory: base, registered });
		let token = async () => {
			asked.push("token");
			return fixture.token;
		};
		// A registered checkout, matched whatever the case, needs no token and no git at all.
		expect(await machine.resolve("org/repo", token)).toEqual({ root: local, env: {} });
		expect(asked).toEqual([]);

		// Another repository is cloned into <base>/repos/<owner>/<repo>, lowercase.
		let cloned = await machine.resolve("Org/Other", token);
		expect(cloned.root).toBe(clonePath(base, "org/other"));
		expect(cloned.root).toBe(join(base, "repos", "org", "other"));
		expect(asked).toEqual(["token"]);
		expect(await readFile(join(cloned.root, "README.md"), "utf8")).toBe("Org/Other\n");
		expect(git(cloned.root, "config", "--get", "remote.origin.url")).toBe(
			"https://github.com/Org/Other.git",
		);
		// The token reached git only through its environment: never a command line, never the
		// clone's own configuration.
		let log = await fixture.log();
		expect(log.join("\n")).not.toContain(TOKEN);
		let [clone] = log.filter(line => line.startsWith("clone "));
		expect(clone).toBeDefined();
		expect(clone!.split("\t").slice(1)).toEqual(["credential.https://github.com.helper", "0"]);
		let config = await readFile(join(cloned.root, ".git", "config"), "utf8");
		expect(config).not.toContain(TOKEN);
		expect(config).not.toMatch(/credential|extraheader|insteadOf|\[http/i);
		expect(cloned.env).toEqual(gitCredentials(fixture.token.file));
		// The helper in that environment answers with the token from its file.
		let fill = spawnSync("git", ["credential", "fill"], {
			input: "protocol=https\nhost=github.com\n\n",
			env: { ...process.env, ...cloned.env, GIT_TERMINAL_PROMPT: "0" },
			encoding: "utf8",
		});
		expect(fill.stdout).toContain(`password=${TOKEN}`);

		// Before each later piece of work the clone is fetched again, not cloned.
		let before = (await fixture.log()).length;
		await machine.resolve("org/other", token);
		let after = (await fixture.log()).slice(before);
		expect(after.map(line => line.split(" ")[0])).toEqual(["fetch"]);
		expect(await clones(base)).toEqual([{ repository: "org/other", path: cloned.root }]);
	},
);

test.skipIf(process.platform === "win32")(
	"one repository is cloned once while work for it arrives at the same time",
	async () => {
		await using fixture = await localGitHub();
		let base = join(fixture.scratch, "base");
		let machine = checkouts({ directory: base, registered: {} });
		let token = async () => fixture.token;
		let resolved = await Promise.all([
			machine.resolve("org/repo", token),
			machine.resolve("org/repo", token),
			machine.resolve("org/other", token),
		]);
		expect(resolved.map(value => value.root)).toEqual([
			join(base, "repos", "org", "repo"),
			join(base, "repos", "org", "repo"),
			join(base, "repos", "org", "other"),
		]);
		let commands = (await fixture.log()).map(line => line.split(" ")[0]);
		// One clone of each repository; the second request for org/repo waited, then fetched.
		expect(commands.filter(command => command === "clone")).toHaveLength(2);
		expect(commands.filter(command => command === "fetch")).toHaveLength(1);
	},
);

test("work for a repository with no checkout and no GitHub token fails naming --checkout", async () => {
	let base = await mkdtemp(join(tmpdir(), "chopin-checkouts-"));
	try {
		let machine = checkouts({ directory: base, registered: {} });
		await expect(machine.resolve("org/repo", async () => undefined)).rejects.toThrow(
			noCheckout("org/repo"),
		);
		expect(noCheckout("org/repo")).toContain("chopin connect --checkout <path>");
		await expect(machine.resolve("../repo")).rejects.toThrow("invalid repository");
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("two checkouts of one repository are refused", async () => {
	let scratch = await realpath(await mkdtemp(join(tmpdir(), "chopin-checkouts-")));
	try {
		let one = await repository(scratch, "one", "org/repo");
		let two = await repository(scratch, "two", "org/repo");
		await expect(registerCheckouts([one, two])).rejects.toThrow(
			`${one} and ${two} are both checkouts of org/repo.`,
		);
		expect(await registerCheckouts([one, one])).toEqual({ "org/repo": one });
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});
