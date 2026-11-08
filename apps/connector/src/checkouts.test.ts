import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { checkouts, clonePath, clones, noCheckout, registerCheckouts, sshCause } from "./checkouts";
import { gitCredentials, githubEnvironment, type GitHubToken } from "./github-token";
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
 * A machine whose GitHub is local. A `git` first on PATH logs every command line and the credential
 * configuration in its environment, and the URL git would use for each github.com address it is
 * given, under the configuration it runs with. It then does the work against bare repositories
 * here: a clone of an https github.com address, and a fetch of an origin that is one, go to them.
 * The global Git configuration is the person's: `global` is added to it.
 */
async function localGitHub(global = "") {
	let scratch = await realpath(await mkdtemp(join(tmpdir(), "chopin-checkouts-")));
	let remotes = join(scratch, "remotes");
	// GitHub's names are case-insensitive; these bare repositories aren't, so both spellings.
	for (let name of ["org/repo", "org/other", "Org/Other"]) {
		let source = await repository(join(scratch, "sources"), name, name);
		spawnSync("git", ["clone", "--quiet", "--bare", source, join(remotes, `${name}.git`)]);
	}
	let globalFile = join(scratch, "gitconfig");
	await writeFile(globalFile, `[user]\n\tname = Global Person\n${global}`);
	let bin = join(scratch, "bin");
	let log = join(scratch, "git.log");
	let urls = join(scratch, "urls.log");
	await mkdir(bin);
	let real = Bun.which("git")!;
	let github = "https://github.com/";
	await writeFile(
		join(bin, "git"),
		`#!/bin/sh\nprintf '%s\\t%s\\t%s\\n' "$*" "$GIT_CONFIG_KEY_1" "$GIT_TERMINAL_PROMPT" >> '${log}'\n`
			+ `for a in "$@"; do case "$a" in ${github}*) `
			+ `printf '%s\\t%s\\n' "$a" "$('${real}' ls-remote --get-url "$a")" >> '${urls}';; esac; done\n`
			+ `if [ "$1" = clone ]; then\n`
			+ `  n=$#; orig=; while [ $n -gt 0 ]; do a="$1"; shift; case "$a" in ${github}*) orig="$a"; `
			+ `a="file://${remotes}/\${a#${github}}";; esac; set -- "$@" "$a"; n=$((n-1)); done\n`
			+ `  eval "dest=\\\${$#}"; '${real}' "$@" || exit $?\n`
			+ `  [ -z "$orig" ] || '${real}' -C "$dest" remote set-url origin "$orig"\n`
			+ `  exit 0\n`
			+ `elif [ "$1" = fetch ]; then\n`
			+ `  raw=$('${real}' config --get remote.origin.url); case "$raw" in ${github}*) `
			+ `printf 'origin\\t%s\\n' "$('${real}' remote get-url origin)" >> '${urls}'; `
			+ `n=$#; while [ $n -gt 0 ]; do a="$1"; shift; [ "$a" != origin ] || a="file://${remotes}/\${raw#${github}}"; `
			+ `set -- "$@" "$a"; n=$((n-1)); done;; esac\n`
			+ `fi\n`
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
	let saved = {
		PATH: process.env.PATH,
		GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
		GIT_ALLOW_PROTOCOL: process.env.GIT_ALLOW_PROTOCOL,
	};
	process.env.PATH = `${bin}:${process.env.PATH}`;
	process.env.GIT_CONFIG_GLOBAL = globalFile;
	// The remotes here are directories, which the connector's git doesn't use unless its person's
	// environment says it may, as a person's with a mirror of GitHub on disk would.
	process.env.GIT_ALLOW_PROTOCOL = "file:https:http:ssh:git";
	return {
		scratch,
		token,
		log: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n"),
		/** Each github.com address git was given, with the URL it would use for it. */
		urls: async () =>
			(await readFile(urls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
				.map(line => line.split("\t") as [string, string]),
		async [Symbol.asyncDispose]() {
			process.env.PATH = saved.PATH;
			if (saved.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = saved.GIT_CONFIG_GLOBAL;
			if (saved.GIT_ALLOW_PROTOCOL === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
			else process.env.GIT_ALLOW_PROTOCOL = saved.GIT_ALLOW_PROTOCOL;
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
		expect(cloned.env).toEqual(gitCredentials(fixture.token.file, "Org/Other"));
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

/** The person's Git configuration: GitHub over SSH, fetches and pushes both. */
const SSH_REWRITE = '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n'
	+ "\tpushInsteadOf = https://github.com/\n";

/** The URL git uses for `url`, under `env` and `config` as the person's global configuration. */
function effective(config: string, env: Record<string, string>, ...args: string[]) {
	let file = join(
		tmpdir(),
		`chopin-gitconfig-${process.pid}-${Math.random().toString(36).slice(2)}`,
	);
	writeFileSync(file, config);
	try {
		let asked = spawnSync("git", args, {
			env: { ...process.env, GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: "1", ...env },
			encoding: "utf8",
		});
		return asked.stdout.trim();
	} finally {
		rmSync(file, { force: true });
	}
}

test.skipIf(process.platform === "win32")(
	"a person's rewrite of github.com to SSH, whatever its length, does not reach one repository's URL, and an SSH origin goes over https",
	() => {
		let https = "https://github.com/Org/Repo.git";
		let env = gitCredentials("/nowhere", "Org/Repo");
		let ask = (config: string, environment: Record<string, string>, url: string) =>
			effective(config, environment, "ls-remote", "--get-url", url);
		// Without the rules the person's rewrite applies, for any repository.
		expect(ask(SSH_REWRITE, {}, https)).toBe("git@github.com:Org/Repo.git");
		// A rule of the same length does not beat it: the first of equally long rules wins, and the
		// person's comes before the command's. A longer one does.
		expect(ask(SSH_REWRITE, {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "url.https://github.com/.insteadOf",
			GIT_CONFIG_VALUE_0: "https://github.com/",
		}, https)).toBe("git@github.com:Org/Repo.git");
		expect(ask(SSH_REWRITE, env, https)).toBe(https);
		// Whatever length the person's rule has, short of the repository's whole address.
		let owner = '[url "git@github.com:Org/"]\n\tinsteadOf = https://github.com/Org/\n';
		expect(ask(owner, {}, https)).toBe("git@github.com:Org/Repo.git");
		expect(ask(owner, env, https)).toBe(https);
		expect(ask(SSH_REWRITE + owner, env, https)).toBe(https);
		// Its lowercase spelling, as people write it, and an address without .git.
		expect(ask(SSH_REWRITE, env, "https://github.com/org/repo.git")).toBe(
			"https://github.com/org/repo.git",
		);
		expect(ask(SSH_REWRITE, env, "https://github.com/Org/Repo")).toBe(
			"https://github.com/Org/Repo",
		);
		// Another repository is left as the person has it: the rules name only this one.
		expect(ask(SSH_REWRITE, env, "https://github.com/Org/Else.git")).toBe(
			"git@github.com:Org/Else.git",
		);
		// A checkout whose origin is an SSH address reaches GitHub over https too, to fetch and push.
		for (let origin of ["git@github.com:Org/Repo.git", "ssh://git@github.com/Org/Repo.git"]) {
			expect(ask(SSH_REWRITE, env, origin)).toBe(https);
		}
		// Nothing changes without the repository: the credential helper alone.
		expect(ask(SSH_REWRITE, gitCredentials("/nowhere"), https)).toBe("git@github.com:Org/Repo.git");
	},
);

test.skipIf(process.platform === "win32")(
	"pushes follow the same rules: a person's pushInsteadOf does not send a push to SSH",
	() => {
		let root = mkdtempSync(join(tmpdir(), "chopin-push-"));
		try {
			git(root, "init", "--quiet");
			git(root, "remote", "add", "origin", "https://github.com/Org/Repo.git");
			let env = githubEnvironment(
				{ token: TOKEN, expiresAt: 0, file: "/nowhere", secrets: () => [], stop: async () => {} },
				"Org/Repo",
			);
			expect(env.GH_TOKEN).toBe(TOKEN);
			let url = (environment: Record<string, string>, ...args: string[]) =>
				effective(SSH_REWRITE, environment, "-C", root, "remote", "get-url", ...args);
			expect(url({}, "--push", "origin")).toBe("git@github.com:Org/Repo.git");
			expect(url(env, "--push", "origin")).toBe("https://github.com/Org/Repo.git");
			expect(url(env, "origin")).toBe("https://github.com/Org/Repo.git");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a repository without a checkout is cloned and fetched over https even when the person's Git rewrites GitHub to SSH",
	async () => {
		await using fixture = await localGitHub(SSH_REWRITE);
		let base = join(fixture.scratch, "base");
		let machine = checkouts({ directory: base, registered: {} });
		let token = async () => fixture.token;
		let cloned = await machine.resolve("Org/Other", token);
		await machine.resolve("Org/Other", token);
		let commands = (await fixture.log()).map(line => line.split(" ")[0]);
		expect(commands.filter(command => command === "clone")).toHaveLength(1);
		expect(commands.filter(command => command === "fetch")).toHaveLength(1);
		// The address git was given and the one it would use are the same: https, so the token applies.
		let urls = await fixture.urls();
		expect(urls).toEqual([
			["https://github.com/Org/Other.git", "https://github.com/Org/Other.git"],
			["origin", "https://github.com/Org/Other.git"],
		]);
		// Without the rules, the same person's configuration sends both to SSH, which a service can't use.
		expect(effective(SSH_REWRITE, {}, "ls-remote", "--get-url", "https://github.com/Org/Other.git"))
			.toBe("git@github.com:Org/Other.git");
		// The rest of the person's configuration still applies to what the connector runs.
		let name = spawnSync("git", ["config", "--get", "user.name"], {
			env: { ...process.env, ...cloned.env },
			encoding: "utf8",
		});
		expect(name.stdout.trim()).toBe("Global Person");
		// And the clone's own configuration holds none of it.
		let config = await readFile(join(cloned.root, ".git", "config"), "utf8");
		expect(config).not.toMatch(/insteadOf|credential|\[url/i);
	},
);

test.skipIf(process.platform === "win32")(
	"when git still went to SSH, the failure names the person's rewrite and what to do",
	async () => {
		let failure = "fatal: Could not read from remote repository.";
		{
			await using _rewritten = await localGitHub(SSH_REWRITE);
			let said = sshCause(failure, "Org/Other");
			expect(said).toContain(failure);
			expect(said).toContain(
				"rewrites https://github.com/Org/Other.git to git@github.com:Org/Other.git",
			);
			expect(said).toContain("url.<base>.insteadOf");
			expect(said).toContain("no SSH agent");
			expect(said).toContain("--checkout");
			expect(sshCause("fatal: Permission denied (publickey).", "Org/Other")).toContain("insteadOf");
			// A failure that is not about SSH is left as git says it.
			expect(sshCause("fatal: repository not found", "Org/Other")).toBeUndefined();
		}
		// With nothing rewriting https, there is no cause to name.
		await using _plain = await localGitHub();
		expect(sshCause(failure, "Org/Other")).toBeUndefined();
	},
);
