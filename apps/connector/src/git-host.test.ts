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
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("the local transport is never allowed to the connector's git: a local repository named as a remote later, or one that was the origin from the start, is not fetched from and its upload-pack program is not run", async () => {
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
	// An origin that was a local repository when the connector first saw the checkout is no
	// different: the transport is refused, and the program the repository names for it is not run.
	let local = repository("file-local");
	let source = join(local.root, "source.git");
	plain(local.root, "init", "--bare", source);
	plain(local.repo, "remote", "set-url", "origin", source);
	plain(local.repo, "push", "origin", "main");
	program(
		join(local.evil, "uploadpack"),
		`touch '${local.ran}/uploadpack'; exec git-upload-pack "$@"`,
	);
	plain(local.repo, "config", "remote.origin.uploadpack", join(local.evil, "uploadpack"));
	for (let key of ["core.hooksPath", "core.fsmonitor", "core.sshCommand"]) {
		plain(local.repo, "config", "--unset", key);
	}
	for (let name of readdirSync(local.ran)) rmSync(join(local.ran, name));
	expect(repositoryAt(local.repo)).toBeDefined();
	let allowed = await gitAsync(["config", "--get-all", "protocol.file.allow"], {
		cwd: local.repo,
	});
	expect(String(allowed.stdout).trim().split("\n").at(-1)).toBe("never");
	let fetched = await gitAsync(["fetch", "origin"], { cwd: local.repo }).then(
		() => "",
		error => String((error as { stderr?: unknown }).stderr),
	);
	expect(fetched).toContain("transport 'file' not allowed");
	expect(local.fired()).toEqual([]);
});

test("no credential helper is asked for the connector's git's credentials, whether a repository named it or the person did, and the effective list is empty", async () => {
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
			} else {
				await gitAsync(["fetch", "origin"], { cwd: made.repo, env: shown }).catch(() => {});
				// Git forgets the helpers named before an empty one, so the list that counts follows the last.
				let named = String(
					(await gitAsync(["config", "--get-all", "credential.helper"], {
						cwd: made.repo,
						env: shown,
					})).stdout,
				).split("\n").slice(0, -1);
				helpers = named.slice(named.lastIndexOf("") + 1);
			}
			return made.fired();
		};
		let helpers: string[] | undefined;
		expect(await ask("credential-control", "plain")).toEqual(["person", "repository"]);
		expect(await ask("credential", "connector")).toEqual([]);
		expect(helpers).toEqual([]);
	} finally {
		server.stop(true);
	}
});

test("a command run with noFilters checks files out without running any filter, the person's or the repository's, and one run without it still does, as a Git LFS checkout needs", async () => {
	let made = repository("filters");
	program(join(made.evil, "smudge"), `touch '${made.ran}/smudge'; cat`);
	program(join(made.evil, "required"), `touch '${made.ran}/required'; cat`);
	program(join(made.evil, "process"), `touch '${made.ran}/process'`);
	writeFileSync(
		join(made.repo, ".gitattributes"),
		"a.txt filter=mine\nb.txt filter=theirs\nc.txt filter=lfsish\n",
	);
	writeFileSync(join(made.repo, "b.txt"), "b");
	writeFileSync(join(made.repo, "c.txt"), "c");
	plain(made.repo, "add", ".");
	plain(made.repo, "commit", "-m", "attributes");
	for (let key of ["core.hooksPath", "core.fsmonitor", "core.sshCommand"]) {
		plain(made.repo, "config", "--unset", key);
	}
	// What the fixture's own commit ran is not what is asked.
	for (let name of readdirSync(made.ran)) rmSync(join(made.ran, name));
	// One filter in the repository's configuration, one in the person's, as Git LFS is, which is
	// required, and one that names a process, as Git LFS does too, which fails a checkout that runs it.
	plain(made.repo, "config", "filter.mine.smudge", join(made.evil, "smudge"));
	plain(made.repo, "config", "filter.lfsish.process", join(made.evil, "process"));
	plain(made.repo, "config", "filter.lfsish.required", "true");
	let env = person(
		made.root,
		`[filter "theirs"]\n\tsmudge = ${join(made.evil, "required")}\n\trequired = true\n`,
	);
	let add = (name: string, options: { noFilters?: boolean }) =>
		gitAsync(["worktree", "add", "--detach", join(made.root, name)], {
			cwd: made.repo,
			env,
			...options,
		}).then(() => undefined, error => String((error as { stderr?: unknown }).stderr));
	// A checkout with filters runs all three, and the process that doesn't answer fails it.
	expect(await add("with", {})).toContain("fatal");
	expect(made.fired()).toEqual(["process", "required", "smudge"]);
	for (let name of readdirSync(made.ran)) rmSync(join(made.ran, name));
	rmSync(join(made.repo, ".git", "worktrees"), { recursive: true, force: true });
	rmSync(join(made.root, "with"), { recursive: true, force: true });
	expect(await add("without", { noFilters: true })).toBeUndefined();
	expect(made.fired()).toEqual([]);
	for (let [file, text] of [["a.txt", "a"], ["b.txt", "b"], ["c.txt", "c"]]) {
		expect(readFileSync(join(made.root, "without", file!), "utf8")).toBe(text!);
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
	// The fixture home is the person's whole configuration, whatever the runner has set.
	delete env.GIT_CONFIG_GLOBAL;
	delete env.GIT_CONFIG_SYSTEM;
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

test("every setting the connector's git is given: helpers reset and none of the person's named, the caller's entries, then the hardening, with where the repository is and which configuration is read", () => {
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
	// A count that isn't one is not trusted, and with no repository nothing says where one is.
	let bare = hostGitEnvironment({
		PATH: "/usr/bin",
		GIT_CONFIG_COUNT: "many",
		GIT_SSH_COMMAND: "ssh",
	});
	expect(bare.GIT_CONFIG_COUNT).toBe(String(HOST_GIT_CONFIG.length + 1));
	expect(bare.GIT_DIR).toBeUndefined();
	expect(bare.GIT_WORK_TREE).toBeUndefined();
});

test("the connector records a checkout's git directories once, from the directory and not from a file in it", () => {
	let made = repository("record");
	// A file an agent made before the connector first looked is not read to find the repository.
	writeFileSync(join(made.repo, ".git", "commondir"), `${join(made.root, "elsewhere")}\n`);
	let repo = repositoryAt(made.repo)!;
	expect(repo).toMatchObject({
		workTree: made.repo,
		gitDir: join(made.repo, ".git"),
		commonDir: join(made.repo, ".git"),
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
	// A folder that is no working tree has no record.
	expect(repositoryAt(join(made.root, "ran"))).toBeUndefined();
});

test("a checkout whose .git is a symbolic link, or a .git file that leads through one, is recorded by the real paths of its git directories, which git on the host is told", async () => {
	let made = repository("links");
	// A checkout made by a tool that keeps the git directory elsewhere and links it in.
	let store = join(made.root, "store", "repo.git");
	mkdirSync(dirname(store));
	renameSync(join(made.repo, ".git"), store);
	symlinkSync(join("..", "store", "repo.git"), join(made.repo, ".git"));
	let repo = repositoryAt(made.repo)!;
	expect(repo).toMatchObject({ workTree: made.repo, gitDir: store, commonDir: store });
	// The environment git on the host is given names the real directory, not the link in the
	// folder an agent writes, and the link pointed elsewhere later changes nothing.
	let hardened = hostGitEnvironment(process.env, repo);
	expect(hardened.GIT_DIR).toBe(store);
	expect(hardened.GIT_COMMON_DIR).toBe(store);
	rmSync(join(made.repo, ".git"));
	symlinkSync(made.evil, join(made.repo, ".git"));
	expect(repositoryAt(made.repo)).toBe(repo);
	await gitAsync(["worktree", "add", "--detach", join(made.root, "wt")], { cwd: made.repo });
	expect(readdirSync(join(store, "worktrees"))).toEqual(["wt"]);
	// A worktree whose `.git` file names its entry through a link is recorded by the real paths too.
	let through = join(made.root, "through");
	symlinkSync(store, through);
	let linked = join(made.root, "linked");
	plain(store, "worktree", "add", "--detach", linked);
	writeFileSync(join(linked, ".git"), `gitdir: ${join(through, "worktrees", "linked")}\n`);
	expect(repositoryAt(linked)).toMatchObject({
		workTree: linked,
		gitDir: join(store, "worktrees", "linked"),
		commonDir: store,
	});
});

/** A repository with a submodule that is initialized, one that is not, and one in a folder, as a checkout has them. */
function withSubmodules(name: string) {
	let made = repository(name);
	let library = join(made.root, "library");
	mkdirSync(library);
	plain(library, "init", "-b", "main");
	writeFileSync(join(library, "lib.txt"), "a library\n");
	plain(library, "add", ".");
	plain(library, "commit", "-m", "library");
	let add = (path: string) =>
		plain(made.repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, path);
	// Neither of the configuration's programs is wanted while the fixture is made.
	let configuration = readFileSync(join(made.repo, ".git", "config"), "utf8");
	plain(made.repo, "config", "--unset", "core.hooksPath");
	plain(made.repo, "config", "--unset", "core.fsmonitor");
	plain(made.repo, "config", "--unset", "core.sshCommand");
	add("vendor");
	add("libs/tool");
	add("extra");
	plain(made.repo, "submodule", "deinit", "-f", "extra");
	plain(made.repo, "commit", "-m", "vendor the library");
	writeFileSync(join(made.repo, ".git", "config"), configuration);
	return made;
}

test("the connector's git runs nothing named by a submodule whose .git an agent pointed at a git directory of its own, which plain git does", async () => {
	let redirect = (made: ReturnType<typeof withSubmodules>) => {
		// A copy of the submodule's git directory, where the agent could write, naming programs to run.
		let copy = join(made.root, "evil", "vendor-git");
		cpSync(join(made.repo, ".git", "modules", "vendor"), copy, { recursive: true });
		let config = readFileSync(join(copy, "config"), "utf8").replace(/^\s*worktree = .*\n/m, "");
		writeFileSync(join(copy, "config"), config);
		made.configure(join(copy, "config"));
		writeFileSync(join(made.repo, "vendor", ".git"), `gitdir: ${copy}\n`);
		// A file in it that git has to look at again, so that its status is worked out and not cached.
		writeFileSync(join(made.repo, "vendor", "lib.txt"), "a library, edited\n");
	};
	let control = withSubmodules("submodule-control");
	redirect(control);
	spawnSync("git", ["-C", control.repo, "status"], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	// The fixture is live: plain git opens the submodule and runs its file-system monitor.
	expect(control.fired()).toContain("fsmonitor");
	let made = withSubmodules("submodule-connector");
	redirect(made);
	let results = [
		gitSync(["status"], { cwd: made.repo }).status,
		gitSync(["diff"], { cwd: made.repo }).status,
		gitSync(["ls-files", "--stage"], { cwd: made.repo }).status,
		gitSync(["submodule", "status"], { cwd: made.repo }).status,
		gitSync(["submodule", "foreach", "true"], { cwd: made.repo }).status,
		await gitAsync(["fetch", "origin"], { cwd: made.repo }).then(() => 0, () => 1),
		await gitAsync(["worktree", "add", "--detach", join(made.root, "next")], { cwd: made.repo })
			.then(() => 0, () => 1),
		await gitAsync(["worktree", "remove", "--force", "--force", join(made.root, "next")], {
			cwd: made.repo,
		}).then(() => 0, () => 1),
	];
	// The fetch has no remote to reach; the rest work as they do for anyone.
	expect(results.filter((_, index) => index !== 5)).toEqual([0, 0, 0, 0, 0, 0, 0]);
	expect(made.fired()).toEqual([]);
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
