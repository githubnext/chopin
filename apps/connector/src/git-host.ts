import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/**
 * Every git command the connector runs itself, on the host and outside any sandbox, against a
 * repository an agent has worked in, goes through here. Git runs what a repository's configuration
 * names, and finds that configuration through files an agent that could write them would own. So
 * the connector gives git nothing to find:
 *
 * - **Where the repository is** is said, not looked for. `GIT_DIR`, `GIT_COMMON_DIR` and
 *   `GIT_WORK_TREE` name the git directories the connector recorded the first time it saw the
 *   working tree (see `repositoryAt`), before any agent had worked in it, so a `commondir` or a
 *   `.git` file made later is not read for the configuration, hooks and attributes. A command has
 *   no moment between a check and the git it checks for at which an agent could change what git
 *   finds.
 * - **What the person's own configuration says** reaches git as a copy the connector made, of
 *   the settings a fetch and a checkout need and no others (see `personConfig`), in a file of its
 *   own: `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL` set aside the system's and the person's.
 * - **What a repository's configuration may set** for the programs git runs is replaced in the
 *   environment (`GIT_CONFIG_COUNT`, after any entries the caller gave, where they win over every
 *   configuration file as `-c` does): the hooks, the file-system monitor, the ssh command (also
 *   pinned in `GIT_SSH_COMMAND` to the person's own, which wins over any configuration), the
 *   global attributes file, remotes that are commands (`protocol.ext.allow`) and the local
 *   transport (`protocol.file.allow`), which is never allowed. Every credential helper any
 *   configuration named is reset and none is named again: what a command needs to authenticate,
 *   its caller gives in the environment (`GIT_CONFIG_*`, as `gitCredentials` does).
 *
 * What this does not do: a repository's configuration is still read, so a filter, a proxy or
 * another setting a repository carries applies to the connector's commands as it would to anyone's.
 * It is the sandbox's policy that keeps an agent from writing that configuration, and this keeps
 * what an agent might have written elsewhere from being found.
 */
export const HOST_GIT_CONFIG: Array<[string, string]> = [
	["core.hooksPath", "/dev/null"],
	["core.fsmonitor", "false"],
	["core.sshCommand", ""],
	["core.attributesFile", "/dev/null"],
	["protocol.ext.allow", "never"],
	["protocol.file.allow", "never"],
];

/** What the connector knows of a working tree and its git directories. */
export type Repository = {
	/** The working tree, by its real path; none for a repository only its git directory is known of. */
	workTree?: string;
	/** Its git directory: a checkout's `.git`, or a linked worktree's entry in `<common>/worktrees`. */
	gitDir: string;
	/** The repository's own git directory, which holds its configuration, hooks, objects and refs. */
	commonDir: string;
};

let records = new Map<string, Repository>();

function real(path: string) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function kindOf(path: string) {
	try {
		return statSync(path).isDirectory() ? "directory" as const : "file" as const;
	} catch {
		return undefined;
	}
}

/**
 * The connector's record of the git directories of the working tree at `path`, made the first time
 * it is asked for and kept: the checkout's `.git` where that is a directory, which no file in
 * it is read to find, else what git says once for a working tree whose `.git` is a file (a linked
 * worktree, a separate git directory). They are
 * recorded by their real paths, which are what the sandbox's policy names too: a `.git` that is a
 * symbolic link, as some tools leave one, or a `.git` file that leads through one, is a link in a
 * folder an agent writes, and neither git nor a sandbox should find the repository through it
 * again. It is asked for when a checkout is registered or cloned and when a run's worktree has
 * just been made, before any agent works there. Undefined where `path` is no working tree.
 */
export function repositoryAt(path: string): Repository | undefined {
	let workTree = real(path);
	let known = records.get(workTree);
	if (known && existsSync(known.gitDir)) return known;
	let dot = join(workTree, ".git");
	let kind = kindOf(dot);
	let gitDir: string;
	let commonDir: string;
	if (kind === "directory") {
		gitDir = commonDir = real(dot);
	} else if (kind === "file") {
		let result = spawnSync("git", [
			"rev-parse",
			"--path-format=absolute",
			"--git-dir",
			"--git-common-dir",
		], { cwd: workTree, encoding: "utf8", env: hostGitEnvironment(process.env), timeout: 10_000 });
		let [own, common] = result.status === 0 ? result.stdout.trim().split("\n") : [];
		if (!own || !common) return undefined;
		gitDir = real(own);
		commonDir = real(common);
	} else return undefined;
	let repository: Repository = { workTree, gitDir, commonDir };
	records.set(workTree, repository);
	return repository;
}

/** The settings of a person's own git configuration that the connector's commands are given. */
type Person = {
	/** A file in the connector's own temporary directory: what a fetch and a checkout need. */
	file: string;
	/** The ssh command git would use without a repository's say. */
	ssh: string;
};

/**
 * What a checkout and a fetch need of a person's configuration: where to fetch from and how to
 * reach it (`url.*`, `http.*`, `ssh.*`, `transfer.*`, `fetch.*`, `safe.*`), how files are written (line endings, symlinks and names,
 * `core.*` of those kinds) and their own filters (`filter.*`, `lfs.*`), which is what a Git LFS
 * checkout needs. The rest, a person's aliases, editor, pager, hooks and monitor among it, is not.
 */
const SECTIONS = new Set([
	"url",
	"http",
	"https",
	"ssh",
	"safe",
	"transfer",
	"fetch",
	"filter",
	"lfs",
]);
const CORE = new Set([
	"core.autocrlf",
	"core.eol",
	"core.safecrlf",
	"core.symlinks",
	"core.longpaths",
	"core.fscache",
	"core.protectntfs",
	"core.protecthfs",
	"core.precomposeunicode",
]);

/** A value as a git configuration file quotes it. */
function quote(text: string) {
	return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")
		.replaceAll("\t", "\\t");
}

let directory: string | undefined;
let people = new Map<string, Person>();

/** The connector's own temporary directory, private to it, removed when it exits. */
function privateDirectory() {
	if (!directory) {
		let made = mkdtempSync(join(tmpdir(), "chopin-git-"));
		directory = made;
		process.once("exit", () => rmSync(made, { recursive: true, force: true }));
	}
	return directory;
}

function entriesOf(
	scope: "--system" | "--global",
	env: NodeJS.ProcessEnv,
): Array<[string, string]> {
	let result = spawnSync("git", ["config", scope, "--list", "-z", "--includes"], {
		cwd: tmpdir(),
		encoding: "utf8",
		env,
		timeout: 10_000,
	});
	if (result.status !== 0) return [];
	return result.stdout.split("\0").filter(Boolean).map(entry => {
		let at = entry.indexOf("\n");
		return (at < 0 ? [entry, "true"] : [entry.slice(0, at), entry.slice(at + 1)]) as [
			string,
			string,
		];
	});
}

/**
 * The system's and the person's configuration, read once for each environment and repository (a
 * person's `includeIf "gitdir:"` blocks depend on which), reduced to what `SECTIONS` and `CORE`
 * allow.
 */
function personConfig(env: NodeJS.ProcessEnv, repository?: Repository): Person {
	let key = [
		env.HOME,
		env.USERPROFILE,
		env.XDG_CONFIG_HOME,
		env.GIT_CONFIG_GLOBAL,
		env.GIT_CONFIG_SYSTEM,
		env.GIT_SSH,
		repository?.gitDir,
	].join("\0");
	let known = people.get(key);
	if (known) return known;
	let reading: NodeJS.ProcessEnv = { ...env };
	delete reading.GIT_CONFIG_NOSYSTEM;
	if (repository) reading.GIT_DIR = repository.gitDir;
	else delete reading.GIT_DIR;
	let entries = [...entriesOf("--system", reading), ...entriesOf("--global", reading)];
	let file = join(privateDirectory(), `gitconfig-${people.size}`);
	let kept: string[] = [];
	let ssh = "";
	for (let [name, value] of entries) {
		let first = name.indexOf(".");
		let last = name.lastIndexOf(".");
		let section = name.slice(0, Math.max(first, 0));
		if (name === "core.sshcommand") ssh = value;
		if (first > 0 && (SECTIONS.has(section) || CORE.has(name))) {
			// A section with its subsection, as git writes them, and the value quoted.
			let subsection = first === last ? "" : ` "${quote(name.slice(first + 1, last))}"`;
			kept.push(`[${section}${subsection}]\n\t${name.slice(last + 1)} = "${quote(value)}"\n`);
		}
	}
	writeFileSync(file, kept.join(""), { mode: 0o600 });
	let person = { file, ssh: ssh || env.GIT_SSH || "ssh" };
	people.set(key, person);
	return person;
}

/**
 * The environment for a host git command: `env`, with the settings above after its own
 * `GIT_CONFIG_*` entries, the person's configuration as the connector copied it, and, for a
 * working tree the connector has recorded, where its git directories are.
 */
export function hostGitEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	repository?: Repository,
	after: Array<[string, string]> = [],
): NodeJS.ProcessEnv {
	let person = personConfig(env, repository);
	let count = Number(env.GIT_CONFIG_COUNT ?? 0);
	if (!Number.isInteger(count) || count < 0) count = 0;
	let hardened: NodeJS.ProcessEnv = { ...env };
	// Credential helpers any configuration named are reset first, and none is named again.
	let entries: Array<[string, string]> = [["credential.helper", ""]];
	for (let index = 0; index < count; index++) {
		let name = env[`GIT_CONFIG_KEY_${index}`];
		if (name !== undefined) entries.push([name, env[`GIT_CONFIG_VALUE_${index}`] ?? ""]);
		delete hardened[`GIT_CONFIG_KEY_${index}`];
		delete hardened[`GIT_CONFIG_VALUE_${index}`];
	}
	entries.push(...HOST_GIT_CONFIG, ...after);
	hardened.GIT_CONFIG_COUNT = String(entries.length);
	entries.forEach(([name, value], index) => {
		hardened[`GIT_CONFIG_KEY_${index}`] = name;
		hardened[`GIT_CONFIG_VALUE_${index}`] = value;
	});
	hardened.GIT_CONFIG_NOSYSTEM = "1";
	hardened.GIT_CONFIG_GLOBAL = person.file;
	hardened.GIT_ATTR_NOSYSTEM = "1";
	if (!env.GIT_SSH_COMMAND) hardened.GIT_SSH_COMMAND = person.ssh;
	if (repository) {
		hardened.GIT_DIR = repository.gitDir;
		hardened.GIT_COMMON_DIR = repository.commonDir;
		if (repository.workTree) hardened.GIT_WORK_TREE = repository.workTree;
	}
	return hardened;
}

/**
 * Settings that leave every filter any configuration defines with no command: a smudge, a clean
 * and a process that are empty run nothing, and none is required. A `.gitattributes` that selects
 * one then has git copy the file as it is stored.
 */
function withoutFilters(env: NodeJS.ProcessEnv, repository?: Repository): Array<[string, string]> {
	let listed = spawnSync("git", ["config", "--name-only", "--get-regexp", "^filter\\."], {
		cwd: repository?.workTree ?? tmpdir(),
		encoding: "utf8",
		env: hostGitEnvironment(env, repository),
		timeout: 10_000,
	});
	let drivers = new Set(
		(listed.status === 0 ? listed.stdout.split("\n") : []).filter(Boolean).map(name =>
			name.slice("filter.".length, name.lastIndexOf("."))
		),
	);
	return [...drivers].flatMap(driver => [
		[`filter.${driver}.smudge`, ""],
		[`filter.${driver}.clean`, ""],
		[`filter.${driver}.process`, ""],
		[`filter.${driver}.required`, "false"],
	]);
}

type Options = {
	/** Where the command runs; for a working tree the connector has recorded, that is the repository. */
	cwd?: string;
	timeout?: number;
	env?: NodeJS.ProcessEnv;
	maxBuffer?: number;
	repository?: Repository;
	/** Run no filter, as a checkout of files the person has not asked to see converted needs. */
	noFilters?: boolean;
};

function prepared(options: Options) {
	let repository = options.repository ?? (options.cwd ? repositoryAt(options.cwd) : undefined);
	let env = options.env ?? process.env;
	return hostGitEnvironment(
		env,
		repository,
		options.noFilters ? withoutFilters(env, repository) : [],
	);
}

/** Run git to its end, as `spawnSync` does. */
export function gitSync(args: string[], options: Omit<Options, "maxBuffer"> = {}) {
	let { repository: _repository, noFilters: _noFilters, ...rest } = options;
	return spawnSync("git", args, { encoding: "utf8", ...rest, env: prepared(options) });
}

const execFileAsync = promisify(execFile);

/** Run git to its end, as `execFile` does, resolving with its output and rejecting as it fails. */
export function gitAsync(args: string[], options: Options = {}) {
	let { repository: _repository, noFilters: _noFilters, ...rest } = options;
	return execFileAsync("git", args, { ...rest, env: prepared(options) });
}
