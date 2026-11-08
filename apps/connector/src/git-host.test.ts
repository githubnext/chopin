import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitAsync, gitSync, hostGitEnvironment } from "./git-host";

let scratch = realpathSync(mkdtempSync(join(tmpdir(), "chopin-git-host-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Git as a person runs it, with no say of the connector's. */
function plain(cwd: string, ...args: string[]) {
	return spawnSync("git", [
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"-c",
		"commit.gpgsign=false",
		...args,
	], { cwd, encoding: "utf8" });
}

function program(path: string, body: string) {
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

/**
 * A repository whose configuration names a program for every place git runs one in the
 * connector's commands, as an agent that got a line of it in would: a hooks directory, a
 * file-system monitor and an ssh command. Each program leaves a file in `ran` when git runs it.
 */
function repository(name: string) {
	let root = join(scratch, name);
	let repo = join(root, "repo");
	let ran = join(root, "ran");
	let evil = join(root, "evil");
	mkdirSync(repo, { recursive: true });
	mkdirSync(ran);
	mkdirSync(evil);
	plain(repo, "init", "-b", "main");
	writeFileSync(join(repo, "a.txt"), "a");
	plain(repo, "add", ".");
	plain(repo, "commit", "-m", "init");
	for (let hook of ["post-checkout", "reference-transaction"]) {
		program(join(evil, hook), `touch '${ran}/${hook}'`);
	}
	program(join(evil, "fsmonitor"), `touch '${ran}/fsmonitor'`);
	program(join(evil, "ssh"), `touch '${ran}/ssh'; exit 1`);
	plain(repo, "remote", "add", "origin", "ssh://git@127.0.0.1:1/octo/score.git");
	let configure = (file: string) => {
		for (
			let [key, value] of [
				["core.hooksPath", evil],
				["core.fsmonitor", join(evil, "fsmonitor")],
				["core.sshCommand", join(evil, "ssh")],
			] as const
		) {
			plain(root, "config", "--file", file, key, value);
		}
	};
	configure(join(repo, ".git", "config"));
	return { root, repo, ran, evil, configure, fired: () => readdirSync(ran).sort() };
}

/** What the connector's own commands do in a repository: a worktree, its status, a branch and a fetch. */
async function connectorSteps(
	repo: string,
	root: string,
	run: (args: string[], options: { cwd: string }) => Promise<unknown>,
) {
	let attempt = (...args: string[]) => run(args, { cwd: repo }).catch(() => undefined);
	await attempt("worktree", "add", "--detach", join(root, "wt"));
	await attempt("status");
	await attempt("branch", "doomed");
	await attempt("branch", "-D", "doomed");
	await attempt("fetch", "origin");
}

/** The same steps with plain git, which is how a person's would run. */
async function plainSteps(repo: string, root: string) {
	await connectorSteps(repo, root, async (args, options) => {
		let result = plain(options.cwd, ...args);
		if (result.status !== 0) throw new Error(result.stderr);
	});
}

test("the connector's git runs none of the programs a repository's configuration names, which plain git does", async () => {
	let control = repository("control");
	await plainSteps(control.repo, control.root);
	// The fixture is live: plain git runs the file-system monitor, both hooks and the ssh command.
	expect(control.fired()).toEqual(["fsmonitor", "post-checkout", "reference-transaction", "ssh"]);
	let made = repository("connector");
	await connectorSteps(made.repo, made.root, (args, options) => gitAsync(args, options));
	let hostSteps = gitSync(["-C", made.repo, "status"]);
	expect(hostSteps.status).toBe(0);
	expect(made.fired()).toEqual([]);
});

test("a `commondir` an agent planted in a checkout's git directory sends plain git to a configuration it wrote, and the connector's git runs none of it", async () => {
	let control = repository("planted-control");
	let make = (made: ReturnType<typeof repository>) => {
		let common = join(made.root, "common");
		cpSync(join(made.repo, ".git"), common, { recursive: true });
		made.configure(join(common, "config"));
		// The checkout's own configuration is clean; only the directory it is sent to is not.
		plain(made.repo, "config", "--unset", "core.hooksPath");
		plain(made.repo, "config", "--unset", "core.fsmonitor");
		plain(made.repo, "config", "--unset", "core.sshCommand");
		writeFileSync(join(made.repo, ".git", "commondir"), `${common}\n`);
	};
	make(control);
	plain(control.repo, "status");
	expect(control.fired()).toContain("fsmonitor");
	let made = repository("planted");
	make(made);
	await connectorSteps(made.repo, made.root, (args, options) => gitAsync(args, options));
	expect(made.fired()).toEqual([]);
});

test("the ssh command a person chose is kept over the one a repository names, and a person's GIT_SSH_COMMAND over both", async () => {
	let made = repository("ssh");
	let home = join(made.root, "home");
	mkdirSync(home);
	program(join(made.root, "person-ssh"), `touch '${made.ran}/person'; exit 1`);
	writeFileSync(
		join(home, ".gitconfig"),
		`[core]\n\tsshCommand = ${join(made.root, "person-ssh")}\n`,
	);
	let env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
	};
	delete env.GIT_SSH_COMMAND;
	await gitAsync(["-C", made.repo, "fetch", "origin"], { env }).catch(() => undefined);
	expect(made.fired()).toEqual(["person"]);
	program(join(made.root, "environment-ssh"), `touch '${made.ran}/environment'; exit 1`);
	await gitAsync(["-C", made.repo, "fetch", "origin"], {
		env: { ...env, GIT_SSH_COMMAND: join(made.root, "environment-ssh") },
	}).catch(() => undefined);
	expect(made.fired()).toEqual(["environment", "person"]);
});

test("the settings go after any a caller gave, so the credential helper the connector adds keeps its place", () => {
	let env = hostGitEnvironment({
		PATH: "/usr/bin",
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
		GIT_CONFIG_VALUE_0: "",
		GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
		GIT_CONFIG_VALUE_1: "!f() { :; }; f",
		GIT_SSH_COMMAND: "ssh -i key",
	});
	expect(env).toMatchObject({
		GIT_CONFIG_COUNT: "4",
		GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
		GIT_CONFIG_VALUE_1: "!f() { :; }; f",
		GIT_CONFIG_KEY_2: "core.hooksPath",
		GIT_CONFIG_VALUE_2: "/dev/null",
		GIT_CONFIG_KEY_3: "core.fsmonitor",
		GIT_CONFIG_VALUE_3: "false",
		GIT_SSH_COMMAND: "ssh -i key",
	});
	// A count that isn't one is not trusted.
	expect(hostGitEnvironment({ PATH: "/usr/bin", GIT_CONFIG_COUNT: "many", GIT_SSH_COMMAND: "ssh" }))
		.toMatchObject({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.hooksPath" });
});

test("no git command the connector runs on the host bypasses the hardened helper", () => {
	let directory = import.meta.dir;
	let spawning = /\b(spawn|spawnSync|execFile|execFileSync|exec)\(\s*(\[\s*)?["'`]git["'`]/;
	let bare = /Bun\.(spawn|spawnSync)\(\s*\[\s*["'`]git["'`]/;
	let offenders = readdirSync(directory).filter(name =>
		name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "git-host.ts"
	).filter(name => {
		let text = readFileSync(join(directory, name), "utf8");
		return spawning.test(text) || bare.test(text);
	});
	expect(offenders).toEqual([]);
});
