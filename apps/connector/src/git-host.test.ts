import { afterAll, expect, test } from "bun:test";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
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
import { gitAsync, gitSync, HOST_GIT_CONFIG, hostGitEnvironment, repositoryAt } from "./git-host";

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

/** A global configuration file of a person, and the environment git finds it by. */
function person(root: string, text: string) {
	let home = join(root, "home");
	mkdirSync(home, { recursive: true });
	let file = join(home, "gitconfig");
	writeFileSync(file, text);
	let env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: file };
	delete env.GIT_SSH_COMMAND;
	return env;
}

test("a remote that is a command, in a repository's configuration, is not run by the connector's git, which plain git runs", async () => {
	let control = repository("ext-control");
	let made = repository("ext");
	for (let item of [control, made]) {
		program(join(item.evil, "ext"), `touch '${item.ran}/ext'; exit 1`);
		plain(item.repo, "config", "protocol.ext.allow", "always");
		plain(item.repo, "config", "remote.origin.url", `ext::${join(item.evil, "ext")} %S`);
	}
	await plainSteps(control.repo, control.root);
	expect(control.fired()).toContain("ext");
	await connectorSteps(made.repo, made.root, (args, options) => gitAsync(args, options));
	expect(made.fired()).toEqual([]);
});

test("a local repository named as a remote after the connector first saw the checkout is not fetched from, and its upload-pack program is not run; a local origin the person had is", async () => {
	let control = repository("file-control");
	let made = repository("file");
	for (let item of [control, made]) {
		let other = join(item.root, "other.git");
		plain(item.root, "init", "--bare", other);
		program(
			join(item.evil, "uploadpack"),
			`touch '${item.ran}/uploadpack'; exec git-upload-pack "$@"`,
		);
		if (item === made) {
			// The connector saw the checkout before any agent had worked in it.
			expect(gitSync(["status"], { cwd: item.repo }).status).toBe(0);
		}
		plain(item.repo, "config", "remote.origin.url", other);
		plain(item.repo, "config", "remote.origin.uploadpack", join(item.evil, "uploadpack"));
	}
	await plainSteps(control.repo, control.root);
	expect(control.fired()).toContain("uploadpack");
	await connectorSteps(made.repo, made.root, (args, options) => gitAsync(args, options));
	expect(made.fired()).not.toContain("uploadpack");
	// A person whose origin is a local repository, as it was when the connector first saw it.
	let local = repository("file-local");
	let source = join(local.root, "source.git");
	plain(local.root, "init", "--bare", source);
	plain(local.repo, "remote", "set-url", "origin", source);
	plain(local.repo, "push", "origin", "main");
	for (let key of ["core.hooksPath", "core.fsmonitor", "core.sshCommand"]) {
		plain(local.repo, "config", "--unset", key);
	}
	await gitAsync(["fetch", "origin"], { cwd: local.repo });
});

test("a credential helper in a repository's configuration is not asked for the connector's git's credentials, and the person's own is", async () => {
	let server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			new Response("no", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="x"' } }),
	});
	try {
		let ask = async (name: string, run: "plain" | "connector") => {
			let made = repository(name);
			let env = person(
				made.root,
				`[credential]\n\thelper = "!f() { touch '${made.ran}/person'; echo username=u; echo password=p; }; f"\n`,
			);
			plain(made.repo, "config", "remote.origin.url", `http://127.0.0.1:${server.port}/o/r.git`);
			plain(
				made.repo,
				"config",
				"credential.helper",
				`!f() { touch '${made.ran}/repository'; }; f`,
			);
			for (let key of ["core.hooksPath", "core.fsmonitor", "core.sshCommand"]) {
				plain(made.repo, "config", "--unset", key);
			}
			let shown = { ...env, GIT_TERMINAL_PROMPT: "0" };
			if (run === "plain") {
				await promisify(execFile)("git", ["-C", made.repo, "fetch", "origin"], { env: shown })
					.catch(
						() => undefined,
					);
			} else await gitAsync(["fetch", "origin"], { cwd: made.repo, env: shown }).catch(() => {});
			return made.fired();
		};
		expect(await ask("credential-control", "plain")).toEqual(["person", "repository"]);
		expect(await ask("credential", "connector")).toEqual(["person"]);
	} finally {
		server.stop(true);
	}
});

test("the connector's git reads of the person's own configuration only what a fetch and a checkout need of it", async () => {
	let made = repository("person");
	let env = person(
		made.root,
		"[user]\n\tname = Someone\n[alias]\n\tsync = !touch nothing\n[core]\n\tautocrlf = true\n\teditor = vi\n"
			+ '[url "https://mirror.example/"]\n\tinsteadOf = https://github.com/\n'
			+ "[http]\n\tproxy = http://proxy.example:3128\n",
	);
	let ask = async (key: string) =>
		String(
			(await gitAsync(["config", "--get", key], { cwd: made.repo, env }).catch(() => ({
				stdout: "",
			}))).stdout,
		).trim();
	expect(await ask("user.name")).toBe("");
	expect(await ask("alias.sync")).toBe("");
	expect(await ask("core.editor")).toBe("");
	expect(await ask("core.autocrlf")).toBe("true");
	expect(await ask("url.https://mirror.example/.insteadof")).toBe("https://github.com/");
	expect(await ask("http.proxy")).toBe("http://proxy.example:3128");
});

test("a commondir made after the connector first saw the checkout sends its git nowhere: it reads the checkout's own configuration, runs no filter of the redirect's, and plain git, which follows the file, does", async () => {
	let redirected = (name: string) => {
		let made = repository(name);
		writeFileSync(join(made.repo, ".gitattributes"), "a.txt filter=evil\n");
		plain(made.repo, "add", ".gitattributes");
		plain(made.repo, "commit", "-m", "attributes");
		program(join(made.evil, "smudge"), `touch '${made.ran}/smudge'; cat`);
		let common = join(made.root, "common");
		cpSync(join(made.repo, ".git"), common, { recursive: true });
		made.configure(join(common, "config"));
		plain(
			made.root,
			"config",
			"--file",
			join(common, "config"),
			"filter.evil.smudge",
			join(made.evil, "smudge"),
		);
		plain(made.root, "config", "--file", join(common, "config"), "redirect.marker", "yes");
		for (let key of ["core.hooksPath", "core.fsmonitor", "core.sshCommand"]) {
			plain(made.repo, "config", "--unset", key);
		}
		// What the fixture's own commits, made under its configuration, ran is not what is asked.
		for (let name of readdirSync(made.ran)) rmSync(join(made.ran, name));
		return {
			made,
			plant: () => writeFileSync(join(made.repo, ".git", "commondir"), `${common}\n`),
		};
	};
	let control = redirected("redirect-control");
	control.plant();
	expect(plain(control.made.repo, "config", "--get", "redirect.marker").stdout.trim()).toBe("yes");
	plain(control.made.repo, "worktree", "add", "--detach", join(control.made.root, "wt"));
	expect(control.made.fired()).toContain("smudge");
	let { made, plant } = redirected("redirect");
	// The connector saw the checkout, then an agent made the file, then the connector ran git.
	expect(gitSync(["status"], { cwd: made.repo }).status).toBe(0);
	plant();
	let asked = await gitAsync(["config", "--get", "redirect.marker"], { cwd: made.repo }).catch(
		() => ({ stdout: "" }),
	);
	expect(String(asked.stdout).trim()).toBe("");
	await gitAsync(["worktree", "add", "--detach", join(made.root, "wt")], { cwd: made.repo }).catch(
		() => undefined,
	);
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

/** The `GIT_CONFIG_*` entries an environment holds, in order. */
function entries(given: NodeJS.ProcessEnv) {
	return Array.from({ length: Number(given.GIT_CONFIG_COUNT) }, (_, index) => [
		given[`GIT_CONFIG_KEY_${index}`],
		given[`GIT_CONFIG_VALUE_${index}`],
	]);
}

test("every setting the connector's git is given: helpers reset and the person's named again, the caller's entries, then the hardening, with where the repository is and which configuration is read", () => {
	let made = repository("settings");
	let env: NodeJS.ProcessEnv = {
		...person(made.root, "[credential]\n\thelper = store\n[user]\n\tname = Someone\n"),
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
		GIT_CONFIG_VALUE_0: "",
		GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
		GIT_CONFIG_VALUE_1: "!f() { :; }; f",
		GIT_SSH_COMMAND: "ssh -i key",
	};
	let repo = repositoryAt(made.repo)!;
	let hardened = hostGitEnvironment(env, repo);
	expect(entries(hardened)).toEqual([
		["credential.helper", ""],
		["credential.helper", "store"],
		["credential.https://github.com.helper", ""],
		["credential.https://github.com.helper", "!f() { :; }; f"],
		["core.hooksPath", "/dev/null"],
		["core.fsmonitor", "false"],
		["core.sshCommand", ""],
		["core.attributesFile", "/dev/null"],
		["protocol.ext.allow", "never"],
		["protocol.file.allow", "never"],
	]);
	expect(hardened).toMatchObject({
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_SSH_COMMAND: "ssh -i key",
		GIT_DIR: join(made.repo, ".git"),
		GIT_COMMON_DIR: join(made.repo, ".git"),
		GIT_WORK_TREE: made.repo,
	});
	// The person's own file is set aside for one the connector made, which holds none of its user.
	expect(hardened.GIT_CONFIG_GLOBAL).not.toBe(env.GIT_CONFIG_GLOBAL);
	expect(readFileSync(hardened.GIT_CONFIG_GLOBAL!, "utf8")).not.toContain("Someone");
	// A checkout whose origin was local when it was first seen may use the local transport.
	let local = hostGitEnvironment(env, { ...repo, localOrigin: true });
	expect(entries(local).at(-1)).toEqual(["protocol.file.allow", "user"]);
	// A count that isn't one is not trusted, and with no repository nothing says where one is.
	let bare = hostGitEnvironment({
		PATH: "/usr/bin",
		GIT_CONFIG_COUNT: "many",
		GIT_SSH_COMMAND: "ssh",
	});
	expect(bare.GIT_CONFIG_COUNT).toBe(String(HOST_GIT_CONFIG.length + 2));
	expect(bare.GIT_DIR).toBeUndefined();
	expect(bare.GIT_WORK_TREE).toBeUndefined();
});

test("the connector records a checkout's git directories once, from the directory and not from a file in it, and says whether its origin was a local repository", () => {
	let made = repository("record");
	// A file an agent made before the connector first looked is not read to find the repository.
	writeFileSync(join(made.repo, ".git", "commondir"), `${join(made.root, "elsewhere")}\n`);
	let repo = repositoryAt(made.repo)!;
	expect(repo).toMatchObject({
		workTree: made.repo,
		gitDir: join(made.repo, ".git"),
		commonDir: join(made.repo, ".git"),
		localOrigin: false,
	});
	// Asked again, it is the same record, whatever changed since.
	rmSync(join(made.repo, ".git", "commondir"));
	plain(made.repo, "remote", "set-url", "origin", made.evil);
	expect(repositoryAt(made.repo)).toBe(repo);
	// A linked worktree's `.git` is a file, so git is asked, once.
	let linked = join(made.root, "linked");
	plain(made.repo, "worktree", "add", "--detach", linked);
	expect(repositoryAt(linked)).toMatchObject({
		workTree: linked,
		gitDir: join(made.repo, ".git", "worktrees", "linked"),
		commonDir: join(made.repo, ".git"),
	});
	// A local origin is seen as one: a path, a file URL, a relative path or a drive.
	for (
		let [name, url, local] of [
			["path", "/srv/git/score.git", true],
			["file", "file:///srv/git/score.git", true],
			["relative", "../score.git", true],
			["drive", "C:\\git\\score.git", true],
			["https", "https://github.com/octo/score.git", false],
			["scp", "git@github.com:octo/score.git", false],
			["ssh", "ssh://git@github.com/octo/score.git", false],
		] as const
	) {
		let seen = repository(`origin-${name}`);
		plain(seen.repo, "remote", "set-url", "origin", url);
		expect(repositoryAt(seen.repo)!.localOrigin).toBe(local);
	}
	// A folder that is no working tree has no record.
	expect(repositoryAt(join(made.root, "ran"))).toBeUndefined();
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
