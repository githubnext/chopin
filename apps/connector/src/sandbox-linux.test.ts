import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sandboxLabel } from "@chopin/protocol/connector";
import { runAgent } from "./acp";
import { checkouts } from "./checkouts";
import { createOutput } from "./output";
import { servePlanners } from "./planner";
import { discardWorkspace, preparePlannerWorktree, prepareWorkspace } from "./workspace";
import { gitAsync, gitSync, repositoryAt } from "./git-host";
import { createSandbox, inspectSandbox } from "./sandbox";
import type { CheckPlan, CheckResult } from "./testing/sandbox-checks";

/**
 * The sandbox on a real Linux machine, with a real MXC executor: an ACP agent and a Planner
 * backend started through it, trying from inside what the policy allows and forbids. These skip,
 * saying why, where the machine has no working sandbox: `chopin status` names what it lacks.
 * Everything lives under /var/tmp, because /tmp is private to each sandbox.
 */
let linux = process.platform === "linux";
let scratch = linux ? realpathSync(mkdtempSync("/var/tmp/chopin-sandbox-linux-")) : "";
let home = join(scratch, "home");
let realHome = process.env.HOME;
let inspected = linux
	? await inspectSandbox({ directory: join(scratch, "inspect") })
	: undefined;
let usable = inspected?.report.engine === "bubblewrap";
if (!usable) {
	console.warn(
		`Skipping the Linux sandbox tests: ${
			inspected ? sandboxLabel(inspected.report) : `this is ${process.platform}, not Linux.`
		}`,
	);
}
let sandboxTest = test.skipIf(!usable);
if (usable) {
	mkdirSync(home, { recursive: true });
	process.env.HOME = home;
}
afterAll(() => {
	process.env.HOME = realHome;
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const MACHINE = `chopin_m_${"M".repeat(43)}`;

function git(cwd: string, ...args: string[]) {
	let result = spawnSync("git", [
		"-c",
		"user.name=fixture",
		"-c",
		"user.email=fixture@example.test",
		"-c",
		"commit.gpgsign=false",
		...args,
	], { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

/** A server standing in for a host: it answers every request. */
function server(name: string) {
	let listening = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(name),
	});
	return { url: `http://127.0.0.1:${listening.port}/`, stop: () => listening.stop(true) };
}

/** Whether this machine reaches GitHub itself, which the sandbox's own reach is judged against. */
async function githubReachable() {
	try {
		return (await fetch("https://api.github.com/", { signal: AbortSignal.timeout(5000) })).ok;
	} catch {
		return false;
	}
}

/** A fresh world: a home with credentials, a repository and its remote, and a connector's state directory. */
function world(name: string) {
	let root = join(scratch, name);
	let checkout = join(root, "checkout");
	// Named as GitHub's are, so the connector takes it for a checkout of octo-org/score.
	let remote = join(root, "github.com", "octo-org", "score.git");
	let state = join(root, "state");
	mkdirSync(join(home, ".ssh"), { recursive: true });
	mkdirSync(join(home, ".aws"), { recursive: true });
	writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY");
	writeFileSync(join(home, ".aws", "credentials"), "aws_secret_access_key=secret");
	mkdirSync(checkout, { recursive: true });
	mkdirSync(dirname(remote), { recursive: true });
	git(root, "init", "--bare", remote);
	git(checkout, "init", "-b", "main");
	writeFileSync(join(checkout, "README.md"), "the repository\n");
	// Selects a filter nobody has defined, which does nothing until a configuration defines one.
	writeFileSync(join(checkout, ".gitattributes"), "README.md filter=evil\n");
	git(checkout, "add", ".");
	git(checkout, "commit", "-m", "initial");
	git(checkout, "remote", "add", "origin", remote);
	mkdirSync(join(state, "runs", "other-run"), { recursive: true });
	writeFileSync(join(state, "runs", "other-run", "secret.txt"), "another run's file");
	writeFileSync(
		join(state, "machine.json"),
		JSON.stringify({ servers: { x: { token: MACHINE } } }),
	);
	return { root, checkout, remote, state };
}

function plan(
	made: ReturnType<typeof world>,
	chopin: string,
	extra: string,
	github: boolean,
): CheckPlan {
	return {
		repoFile: "README.md",
		// The main checkout and the home are on the host, read-only. The folders above the state
		// directory are not: the sandbox builds them in its own memory to hold the paths it was
		// given, so a write there succeeds and is gone with the process, and the host never has it.
		notWritable: [join(made.checkout, "outside.txt"), join(home, "escaped.txt")],
		notPersisted: [join(made.root, "outside.txt"), join(made.state, "planted.txt")],
		notReadable: [
			join(home, ".ssh"),
			join(home, ".aws", "credentials"),
			join(made.state, "machine.json"),
			join(made.state, "runs", "other-run", "secret.txt"),
		],
		visible: ["CHOPIN_TEST_CREDENTIAL", "a-credential-the-agent-keeps"],
		remote: made.remote,
		chopin,
		offList: "https://example.org/",
		extra,
		...(github ? { github: "https://api.github.com/" } : {}),
	};
}

function expectAllOk(result: CheckResult, github: boolean) {
	let failed = Object.entries(result).filter(([, value]) => !value.ok).map(([name, value]) =>
		`${name}: ${value.detail}`
	);
	expect(failed).toEqual([]);
	for (
		let name of [
			"readRepository",
			"writeWorktree",
			"writeTemporary",
			"cannotWrite0",
			"cannotWrite1",
			"cannotRead0",
			"cannotRead1",
			"cannotRead2",
			"cannotRead3",
			"environment",
			"commitAndPush",
			"chopin",
			"offList",
			"extraHost",
		]
	) {
		expect(result, name).toHaveProperty(name);
	}
	expect(result).toHaveProperty("github", github ? expect.anything() : undefined);
}

sandboxTest(
	"an ACP agent in the sandbox reads the repository and writes its worktree, and can't write outside it, read credentials or other runs, or reach a host off the list",
	async () => {
		let made = world("agent");
		let chopin = server("chopin");
		let extra = server("owner-added");
		let refused: string[] = [];
		let github = await githubReachable();
		let worktree = join(made.state, "runs", "mine");
		git(made.checkout, "worktree", "add", "--detach", worktree);
		let sandbox = await createSandbox({
			directory: made.state,
			home,
			server: new URL(chopin.url).origin,
			// The owner adds a host and the bare remote this test pushes to.
			settings: { hosts: [new URL(extra.url).host], writable: [made.remote] },
			refused: (host, port) => refused.push(`${host}:${port}`),
		});
		try {
			expect(sandbox.report).toEqual({ engine: "bubblewrap" });
			let reported = join(worktree, "sandbox-report.jsonl");
			let stop = await runAgent({
				command: [process.execPath, join(import.meta.dir, "testing/sandbox-agent.ts")],
				cwd: worktree,
				prompt: "Try the sandbox.",
				mcpServers: [],
				signal: new AbortController().signal,
				onUpdate: () => {},
				permission: async () => undefined,
				env: {
					SANDBOX_CHECKS: JSON.stringify(plan(made, chopin.url, extra.url, github)),
					SANDBOX_REPORT: reported,
					CHOPIN_TEST_CREDENTIAL: "a-credential-the-agent-keeps",
				},
				sandbox,
				own: [worktree],
			});
			expect(stop).toBe("end_turn");
			let result = JSON.parse(readFileSync(reported, "utf8").trim()) as CheckResult;
			expectAllOk(result, github);
			if (github) expect(result.github!.detail).toBe("200");
			// What it wrote is on the host, where the run's worktree is; what it was refused is not.
			expect(readFileSync(join(worktree, "written-in-sandbox.txt"), "utf8")).toBe("ok");
			expect(git(made.remote, "branch", "--list", "sandboxed")).toContain("sandboxed");
			expect(existsSync(join(made.root, "outside.txt"))).toBe(false);
			expect(existsSync(join(made.checkout, "outside.txt"))).toBe(false);
			expect(existsSync(join(home, "escaped.txt"))).toBe(false);
			expect(existsSync(join(made.state, "planted.txt"))).toBe(false);
			// Chopin hears of the host it was refused, so its owner can allow it.
			expect(refused).toContain("example.org:443");
		} finally {
			await sandbox.close();
			chopin.stop();
			extra.stop();
		}
	},
	120_000,
);

/**
 * A Planner backend started as `servePlanners` starts it, in a checkout the person registered:
 * their repository's own, or, with `linked`, a linked worktree of it.
 */
async function plannerBackend(linked: boolean) {
	let made = world(linked ? "planner-linked" : "planner");
	// Another worktree, the person's own.
	git(made.checkout, "worktree", "add", "--detach", join(made.root, "persons-other"));
	let checkout = linked ? join(made.root, "persons-checkout") : made.checkout;
	if (linked) git(made.checkout, "worktree", "add", "--detach", checkout);
	let chopin = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === "/api/connector/planner") {
				return Response.json({
					token: `chopin_p_${"P".repeat(43)}`,
					expiresAt: Date.now() + 15 * 60_000,
					document: {
						id: "D_1",
						repository: "octo-org/score",
						url: `${new URL(request.url).origin}/octo-org/score/plan`,
					},
				});
			}
			return new Response("chopin");
		},
	});
	let extra = server("owner-added");
	let github = await githubReachable();
	let origin = chopin.url.origin;
	let sandbox = await createSandbox({
		directory: made.state,
		home,
		server: origin,
		settings: { hosts: [new URL(extra.url).host], writable: [made.remote] },
	});
	let abort = new AbortController();
	let quiet = { write: () => true };
	let worktree = join(made.state, "planners", "octo-org", "score", "D_1");
	let reported = join(worktree, "report.json");
	let serving = servePlanners({
		url: origin,
		machine: MACHINE,
		documents: ["D_1"],
		command: [process.execPath, join(import.meta.dir, "testing/sandbox-planner.ts")],
		checkouts: checkouts({
			directory: made.state,
			registered: { "octo-org/score": checkout },
		}),
		directory: made.state,
		output: createOutput(quiet, quiet, {}),
		signal: abort.signal,
		env: {
			SANDBOX_CHECKS: JSON.stringify({
				...plan(made, origin + "/", extra.url, github),
				// A Planner runs in its checkout, which it reads and doesn't write, and finds its own
				// worktree, made by the connector, where it writes.
				notWritable: [
					join(home, "escaped.txt"),
					join(made.checkout, ".git", "config"),
					join(made.checkout, ".git", "commondir"),
				],
				otherEntry: join(made.checkout, ".git", "worktrees", "persons-other"),
				// Where the checkout is a linked worktree, its git directory is the person's own entry.
				...(linked
					? { personsEntry: git(checkout, "rev-parse", "--path-format=absolute", "--git-dir") }
					: {}),
			}),
			CHOPIN_TEST_CREDENTIAL: "a-credential-the-agent-keeps",
		},
		sandbox,
	});
	try {
		for (let deadline = Date.now() + 90_000; !existsSync(reported); await Bun.sleep(100)) {
			if (Date.now() > deadline) throw new Error("The Planner backend never reported.");
		}
		let result = JSON.parse(readFileSync(reported, "utf8").trim()) as CheckResult;
		let failed = Object.entries(result).filter(([, value]) => !value.ok).map(([name, value]) =>
			`${name}: ${value.detail}`
		);
		expect(failed).toEqual([]);
		for (
			let name of [
				"ownWorktree",
				"cannotWriteCheckout",
				"cannotAddWorktree",
				"cannotAlterOtherCommondir",
				"cannotMoveOtherWorktree",
				...linked ? ["cannotWritePersonsHead", "cannotPlantRebase", "cannotCommitInCheckout"] : [],
			]
		) {
			expect(result, name).toHaveProperty(name);
		}
		expect(result).toHaveProperty("readRepository");
		expect(result).toHaveProperty("commitAndPush");
		expect(result).toHaveProperty("chopin");
		expect(result).toHaveProperty("offList");
		expect(readFileSync(join(worktree, "planner.txt"), "utf8")).toBe("ok");
		expect(readFileSync(join(worktree, "written-in-sandbox.txt"), "utf8")).toBe("ok");
		// The person's checkout has nothing of what the Planner wrote.
		expect(existsSync(join(checkout, "written-in-sandbox.txt"))).toBe(false);
		expect(existsSync(join(checkout, "planner.txt"))).toBe(false);
		expect(git(made.remote, "branch", "--list", "sandboxed")).toContain("sandboxed");
		expect(existsSync(join(made.root, "outside.txt"))).toBe(false);
		expect(existsSync(join(made.state, "planted.txt"))).toBe(false);
	} finally {
		abort.abort();
		await serving;
		await sandbox.close();
		await chopin.stop(true);
		extra.stop();
	}
}

sandboxTest(
	"a Planner backend in the sandbox finds its own worktree made, reads its checkout, writes and commits in that worktree and not in the checkout, with the same limits, and can't add or alter any other worktree",
	() => plannerBackend(false),
	150_000,
);

sandboxTest(
	"a Planner backend whose checkout is a linked worktree of the person's finds its own worktree made, and can't write that checkout, its git entry, plant a rebase in it or commit there",
	() => plannerBackend(true),
	150_000,
);

/**
 * An agent starts first and a run, a Planner and a token file start after it, as they do on a
 * machine that has served for a while. What it can see of the connector's state directory is
 * settled when it starts, so nothing made later may be in its sight, and what it was given
 * (its own worktree and the folder of its tokens, one of which is renewed) still is.
 */
async function startedLater(layout: "run" | "planner" | "ancestor") {
	let made = world(`late-${layout}`);
	let chopin = server("chopin");
	let sandbox = await createSandbox({
		directory: made.state,
		home,
		server: new URL(chopin.url).origin,
	});
	let runs = join(made.state, "runs");
	let planners = join(made.state, "planners", "octo", "score");
	let worktree = join(layout === "run" ? runs : planners, layout === "run" ? "mine" : "D_1");
	let tokens = `${worktree}.tokens`;
	// An "ancestor" is a Planner whose checkout holds the state directory, as a home does.
	let cwd = layout === "run" ? worktree : layout === "ancestor" ? made.root : made.checkout;
	writeFileSync(join(made.root, "notes.txt"), "around");
	if (layout === "run") git(made.checkout, "worktree", "add", "--detach", worktree);
	else mkdirSync(worktree, { recursive: true });
	mkdirSync(tokens, { recursive: true });
	writeFileSync(join(tokens, "github"), "first\n");
	let later = [
		// What was there before it started is out of its sight as much.
		join(made.state, "machine.json"),
		join(runs, "other-run", "secret.txt"),
		join(runs, "later", "secret.txt"),
		join(runs, "later.github-token"),
		join(runs, "later.tokens", "github"),
		join(runs, "later.json"),
		join(planners, "D_later", "secret.txt"),
		join(planners, "D_later.planner-token"),
		join(planners, "D_later.tokens", "planner"),
		join(made.state, "planners", "octo", "other", "D_x", "secret.txt"),
		join(made.state, "repos", "octo", "other", "README.md"),
		join(made.state, "machine.json.123.tmp"),
	];
	let child = sandbox.spawn({
		command: [process.execPath, join(import.meta.dir, "testing/sandbox-watcher.ts")],
		cwd,
		env: {
			...process.env,
			SANDBOX_WATCH: JSON.stringify({
				later,
				own: {
					[join(tokens, "github")]: "second\n",
					// What is around the state directory, in the folder that holds it, is read.
					...(layout === "ancestor" ? { [join(made.root, "notes.txt")]: "around" } : {}),
				},
				hiddenIn: [runs, planners],
				dir: worktree,
				...(layout !== "run" ? { personsCheckout: true } : {}),
			}),
		},
		stdin: "ignore",
		...(layout !== "run" ? { writable: [worktree] } : {}),
		own: [worktree, tokens],
	});
	let said = "";
	child.stderr.on("data", chunk => said += chunk);
	try {
		for (
			let deadline = Date.now() + 60_000;
			!existsSync(join(worktree, "up"));
			await Bun.sleep(50)
		) {
			if (Date.now() > deadline) {
				throw new Error(`The process in the sandbox never started: ${said.slice(0, 2000)}`);
			}
		}
		for (let path of later) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "SECRET");
		}
		// The connector renews a token by replacing its file, which the sandbox must see.
		writeFileSync(join(tokens, "github.new"), "second\n");
		renameSync(join(tokens, "github.new"), join(tokens, "github"));
		writeFileSync(join(worktree, "go"), "");
		for (
			let deadline = Date.now() + 60_000;
			!existsSync(join(worktree, "report.json"));
			await Bun.sleep(50)
		) {
			if (Date.now() > deadline) {
				throw new Error(`The process in the sandbox never reported: ${said.slice(0, 2000)}`);
			}
		}
		let result = JSON.parse(readFileSync(join(worktree, "report.json"), "utf8")) as CheckResult;
		let failed = Object.entries(result).filter(([, value]) => !value.ok).map(([name, value]) =>
			`${name}: ${value.detail}`
		);
		// A folder that holds the state directory is built in the sandbox's memory, as every folder
		// above it is, so a write there succeeds and is gone with the process: it never reaches the disk.
		if (layout === "ancestor") {
			failed = failed.filter(line => !line.startsWith("cannotWriteCheckout"));
			if (existsSync(join(made.root, "written"))) failed.push("written reached the host");
		}
		return failed;
	} finally {
		try {
			process.kill(-child.pid!, "SIGKILL");
		} catch { /* It had already gone. */ }
		await sandbox.close();
		chopin.stop();
	}
}

sandboxTest(
	"a run, a Planner and their tokens made after an agent started are out of its sight, and its own worktree and renewed token are in it",
	async () => {
		expect(await startedLater("run")).toEqual([]);
		expect(await startedLater("planner")).toEqual([]);
	},
	180_000,
);

sandboxTest(
	"a Planner whose checkout holds the connector's state directory, as a home does, reads what is around it and not the machine token, another run's files or what is made there later, and still has its own worktree and renewed token",
	async () => {
		expect(await startedLater("ancestor")).toEqual([]);
	},
	120_000,
);

/**
 * What an agent tries in its repository's git directory, from inside the sandbox. Git on the host
 * reads what is there and runs what it names: `core.hooksPath` and `core.fsmonitor`, a hook, a
 * filter, a remote that is a command (`ext::`), the git directory a worktree points at. So the
 * agent here tries to name its own programs in every place git looks, with `git config` and by
 * writing the files; tries to send git somewhere else, with a `commondir`, a worktree entry
 * renamed away and made again, a new one and a replaced `.git`; and then the host's own git runs,
 * as a person's `git status` and the connector's `fetch` and `worktree add` do. Each program the
 * agent names leaves a file in $RAN when it runs, and only git on the host, outside the sandbox,
 * can write there.
 */
const GIT_ATTEMPTS = String.raw`
cd "$WORK"
common=$(git rev-parse --path-format=absolute --git-common-dir)
mine=$(git rev-parse --path-format=absolute --git-dir)
evil="$WORK/evil"
mkdir -p "$evil"
for name in post-checkout reference-transaction pre-commit fsmonitor ext; do
	printf '#!/bin/sh\ntouch "%s/%s"\n' "$RAN" "$name" > "$evil/$name"
	chmod +x "$evil/$name"
done
printf '#!/bin/sh\ntouch "%s/smudge"\ncat\n' "$RAN" > "$evil/smudge"
chmod +x "$evil/smudge"
try() { name=$1; shift; if "$@" > /dev/null 2>&1; then echo "$name=done"; else echo "$name=refused"; fi; }

# What git is for: committing, branching, fetching, checking out and pushing.
try commit sh -c 'echo changed > changed.txt && git add changed.txt && git -c user.name=agent -c user.email=agent@example.test -c commit.gpgsign=false commit -qm "in the sandbox"'
# Git LFS stores an object in the repository's lfs directory, by its hash, through a temporary file.
try lfsObject sh -c 'mkdir -p "$1/lfs/objects/ab/cd" "$1/lfs/tmp" && echo object > "$1/lfs/tmp/part" && mv "$1/lfs/tmp/part" "$1/lfs/objects/ab/cd/abcd"' sh "$common"
try branch git branch from-sandbox
try switch sh -c 'git checkout -q from-sandbox && git checkout -q -b topic'
# Starting a branch from a remote one and pushing with -u both ask git to record an upstream in
# the config, which it can't write: the branch and the push still happen.
git checkout -q -b tracked origin/main > /dev/null 2>&1
git push -q -u origin HEAD:refs/heads/pushed-u > /dev/null 2>&1
try push git push -q origin HEAD:refs/heads/pushed
try fetch git fetch -q origin
try detach git checkout -q --detach origin/fresh

# A git directory of its own, whose configuration names a program for each place git runs one:
# where a commondir, a worktree entry made again or a new one would send git.
fake="$evil/fake"
mkdir -p "$fake" && cp -r "$common/." "$fake/"
git config --file "$fake/config" core.fsmonitor "$evil/fsmonitor"
git config --file "$fake/config" core.hooksPath "$evil"
git config --file "$fake/config" protocol.ext.allow always
git config --file "$fake/config" remote.origin.url "ext::$evil/ext %S"
git config --file "$fake/config" filter.evil.smudge "$evil/smudge"
git config --file "$fake/config" filter.evil.clean cat

# Naming programs for git to run, in every place it reads them.
try hooksPath git config core.hooksPath "$evil"
try fsmonitor git config core.fsmonitor "$evil/fsmonitor"
try sshCommand git config core.sshCommand "$evil/fsmonitor"
try alias git config alias.sync "!touch \"$RAN/alias\""
try filterDefinition git config filter.evil.smudge "$evil/smudge"
try extAllowed git config protocol.ext.allow always
try remoteCommand git config remote.origin.url "ext::$evil/ext %S"
try configAppend sh -c 'printf "[core]\n\thooksPath = %s\n" "$2" >> "$1/config"' sh "$common" "$evil"
try configReplace sh -c 'cp "$1/config" "$1/config.new" && printf "[core]\n\tfsmonitor = %s\n" "$2" >> "$1/config.new" && mv -f "$1/config.new" "$1/config"' sh "$common" "$evil/fsmonitor"
try ownConfigWorktree sh -c 'printf "[core]\n\tfsmonitor = %s\n" "$2" > "$1/config.worktree"' sh "$mine" "$evil/fsmonitor"
try commonConfigWorktree sh -c 'printf "[core]\n\tfsmonitor = %s\n" "$2" > "$1/config.worktree"' sh "$common" "$evil/fsmonitor"
try hookReplace cp "$evil/post-checkout" "$common/hooks/post-checkout"
try hookNew cp "$evil/reference-transaction" "$common/hooks/reference-transaction"
try attributes sh -c 'echo "* filter=evil" >> "$1/info/attributes"' sh "$common"
try exclude sh -c 'echo evil >> "$1/info/exclude"' sh "$common"
# A submodule's git directory is read the same way, when git runs in it.
try submoduleConfig sh -c 'printf "[core]\n\tfsmonitor = %s\n" "$2" >> "$1/modules/vendor/config"' sh "$common" "$evil/fsmonitor"
try submoduleHook cp "$evil/post-checkout" "$common/modules/vendor/hooks/post-checkout"

# Sending git somewhere else.
try commonCommondir sh -c 'printf "%s\n" "$2" > "$1/commondir"' sh "$common" "$fake"
try commonNewFile sh -c 'echo x > "$1/new-file"' sh "$common"
# Names beside the one place LFS may write are not that place.
try lfsSibling sh -c 'mkdir "$1/lfs-x" && echo x > "$1/lfs-x/object"' sh "$common"
try lfsLock sh -c 'echo x > "$1/lfs.lock"' sh "$common"
try commonHead sh -c 'echo "ref: refs/heads/evil" > "$1/HEAD"' sh "$common"
try commonPackedRefs sh -c 'echo > "$1/packed-refs"' sh "$common"
try entryCommondir sh -c 'printf "%s\n" "$2" > "$1/commondir"' sh "$mine" "$fake"
try entryGitdir sh -c 'printf "%s\n" "$2" > "$1/gitdir"' sh "$mine" "$fake/.git"
# Names the repository's own git directory holds read-only are held in the launch's entry too,
# and an entry's own, which git never reads there as hooks or pointers, is not a place for them.
try entryHooksFile sh -c 'mkdir -p "$1/hooks" && echo x > "$1/hooks/file"' sh "$mine"
try entryHooksReplace sh -c 'mv "$1/hooks" "$1/hooks.moved" && mkdir "$1/hooks" && echo x > "$1/hooks/file"' sh "$mine"
try entryInfoFile sh -c 'mkdir -p "$1/info" && echo x > "$1/info/sparse-checkout"' sh "$mine"
try entryModulesFile sh -c 'mkdir -p "$1/modules/x" && echo x > "$1/modules/x/config"' sh "$mine"
# What cannot be refused: git takes the locks of its own HEAD and index by creating a file beside
# each, so a name made at the top of the entry is made.
try entryNewName sh -c 'echo x > "$1/future-pointer"' sh "$mine"
# More of the same: an unfinished rebase whose todo runs a program, a lock, and executables named like
# hooks. None is a pointer, configuration or a program git runs from there; git run inside the
# worktree would run the rebase's exec line on a rebase --continue, which nothing here does.
try entryRebaseTodo sh -c 'mkdir "$1/rebase-merge" && printf "exec touch \"%s/rebase-exec\"\n" "$2" > "$1/rebase-merge/git-rebase-todo"' sh "$mine" "$RAN"
try entryLocked sh -c 'echo planted > "$1/locked"' sh "$mine"
try entryHookNames sh -c 'for n in post-checkout post-commit reference-transaction pre-commit fsmonitor; do printf "#!/bin/sh\ntouch \"%s/entry-%s\"\n" "$2" "$n" > "$1/$n" && chmod +x "$1/$n"; done' sh "$mine" "$RAN"
try entryRename sh -c 'mv "$1" "$1.moved" && mv "$1.moved" "$1"' sh "$mine"
try entryRecreate sh -c 'mv "$1" "$1.moved" && mkdir "$1" && cp -r "$1.moved/." "$1/" && rm -f "$1/commondir" && printf "%s\n" "$2" > "$1/commondir"' sh "$mine" "$fake"
try newEntry sh -c 'mkdir "$1/worktrees/made-up" && printf "%s\n" "$2" > "$1/worktrees/made-up/commondir"' sh "$common" "$fake"
try otherEntryCommondir sh -c 'printf "%s\n" "$2" > "$1/worktrees/persons-other/commondir"' sh "$common" "$fake"
try otherEntryRename sh -c 'mv "$1/worktrees/persons-other" "$1/worktrees/persons-other.moved"' sh "$common"
try worktreeAdd git worktree add -q --detach "$evil/second"
try worktreeFile sh -c 'printf "gitdir: %s\n" "$1" > .git' sh "$fake"
try worktreeFileReplace sh -c 'rm -f .git && mkdir .git'
if [ -n "$MAIN" ]; then
	# A Planner's working directory is its person's checkout, which it reads and writes none of.
	try checkoutWrite sh -c 'echo ok > "$1/agent-wrote.txt"' sh "$MAIN"
	try checkoutGitMove sh -c 'mv "$1/.git" "$1/.git.moved"' sh "$MAIN"
	try checkoutGitReplace sh -c 'mv "$1/.git" "$1/.git.moved" && mkdir "$1/.git"' sh "$MAIN"
	try checkoutGitRelink sh -c 'rm -f "$1/.git" && ln -s "$2" "$1/.git"' sh "$MAIN" "$evil/fake"
	try checkoutCommit sh -c 'cd "$1" && echo more > more.txt && git add more.txt && git -c user.name=agent -c user.email=agent@example.test -c commit.gpgsign=false commit -qm "in the checkout"' sh "$MAIN"
	if [ -f "$MAIN/.git" ]; then
		# The checkout is a linked worktree of the person's, so its git directory is the person's
		# entry in worktrees/: what their own git reads, and runs from an unfinished rebase.
		person=$(git -C "$MAIN" rev-parse --path-format=absolute --git-dir)
		try personRebaseMerge sh -c 'mkdir "$1/rebase-merge" && printf "exec touch \"%s/rebase-exec\"\n" "$2" > "$1/rebase-merge/git-rebase-todo"' sh "$person" "$RAN"
		try personRebaseApply sh -c 'mkdir "$1/rebase-apply"' sh "$person"
		try personSequencer sh -c 'mkdir "$1/sequencer" && printf "pick 0000000\n" > "$1/sequencer/todo"' sh "$person"
		try personHead sh -c 'echo "ref: refs/heads/evil" > "$1/HEAD"' sh "$person"
		try personOrigHead sh -c 'echo 0123456789abcdef0123456789abcdef01234567 > "$1/ORIG_HEAD"' sh "$person"
		try personIndex sh -c 'printf x >> "$1/index"' sh "$person"
		try personLogs sh -c 'echo x >> "$1/logs/HEAD"' sh "$person"
		try personConfigWorktree sh -c 'printf "[core]\n\tfsmonitor = %s\n" "$2" > "$1/config.worktree"' sh "$person" "$evil/fsmonitor"
		try personCommondir sh -c 'printf "%s\n" "$2" > "$1/commondir"' sh "$person" "$fake"
		try personRename sh -c 'mv "$1" "$1.moved"' sh "$person"
		try personRecreate sh -c 'mv "$1" "$1.moved" && mkdir "$1"' sh "$person"
	else
		try checkoutConfig sh -c 'printf "[core]\n\tfsmonitor = %s\n" "$2" >> "$1/.git/config"' sh "$MAIN" "$evil/fsmonitor"
	fi
fi
echo finished=done
`;

/** A repository with a submodule, a remote and a branch only the remote has, as the attempts need. */
function gitWorld(name: string) {
	let made = world(name);
	// A submodule, whose git directory is in the repository's.
	let vendor = join(made.root, "vendor");
	mkdirSync(vendor);
	git(vendor, "init", "-b", "main");
	writeFileSync(join(vendor, "lib.txt"), "a library\n");
	git(vendor, "add", ".");
	git(vendor, "commit", "-m", "library");
	git(
		made.checkout,
		"-c",
		"protocol.file.allow=always",
		"submodule",
		"add",
		"-q",
		vendor,
		"vendor",
	);
	git(made.checkout, "commit", "-m", "vendor the library");
	git(made.checkout, "push", "-q", "origin", "main");
	// A branch only the remote has, for the agent to fetch.
	git(made.remote, "branch", "fresh", "main");
	// Where Git LFS keeps its objects, which a checkout has once LFS has been used in it.
	mkdirSync(join(made.checkout, ".git", "lfs"));
	// As a sparse checkout leaves a repository: per-worktree configuration is read, and there is
	// no such file yet.
	git(made.checkout, "config", "extensions.worktreeConfig", "true");
	// Another worktree of the person's, which no agent has any business with.
	git(made.checkout, "worktree", "add", "--detach", join(made.root, "persons-other"));
	return made;
}

/**
 * The fixture's origin is a bare repository on this disk, which the connector's git never fetches
 * from unless its person allows the transport, as they would for a mirror on disk.
 */
const LOCAL_REMOTE = { ...process.env, GIT_ALLOW_PROTOCOL: "file" };

/** What git on the host does after an agent ran: the person's own git and the connector's. */
async function afterwards(made: ReturnType<typeof world>, worktree: string, linked: boolean) {
	let next = join(made.state, "runs", "next");
	let plain = (directory: string, ...args: string[]) =>
		spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
	let statuses = [
		plain(made.checkout, "worktree", "add", "--detach", next).status,
		plain(made.checkout, "status").status,
		plain(next, "status").status,
		...(linked ? [plain(worktree, "status").status] : []),
		plain(made.checkout, "branch", "-f", "after-sandbox", "main").status,
		plain(made.checkout, "worktree", "prune").status,
		// And the connector's own, as a run's start and end make them.
		await gitAsync(["worktree", "add", "--detach", join(made.state, "runs", "next-by-connector")], {
			cwd: made.checkout,
		}).then(() => 0, () => 1),
		await gitAsync(["fetch", "origin"], { cwd: made.checkout, env: LOCAL_REMOTE }).then(
			() => 0,
			() => 1,
		),
		gitSync(["ls-remote", "origin"], { cwd: made.checkout, env: LOCAL_REMOTE }).status,
		gitSync(["status"], { cwd: made.checkout }).status,
		await gitAsync(["worktree", "prune"], { cwd: made.checkout }).then(() => 0, () => 1),
	];
	return {
		statuses,
		commonDirectory: linked
			? plain(worktree, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.trim()
			: undefined,
	};
}

/**
 * `run`: an agent in the worktree the connector made for its run. `planner`: a Planner in the
 * person's checkout, with its own worktree. `linked`: the same, where the person's checkout is
 * itself a linked worktree of their repository. `symlinked`: the same as `planner`, where the
 * checkout's `.git` is a symbolic link to a git directory kept elsewhere.
 */
type Layout = "run" | "planner" | "linked" | "symlinked";

async function gitAttempts(layout: Layout) {
	let made = gitWorld(`git-${layout}`);
	let store = join(made.root, "store", "checkout.git");
	if (layout === "symlinked") {
		// As a tool that keeps git directories in a store of its own leaves a checkout.
		mkdirSync(dirname(store));
		renameSync(join(made.checkout, ".git"), store);
		symlinkSync(store, join(made.checkout, ".git"));
		// The submodule's git directory names its working tree relative to where it was.
		git(
			made.checkout,
			"config",
			"--file",
			join(store, "modules", "vendor", "config"),
			"core.worktree",
			join(made.checkout, "vendor"),
		);
	}
	let ran = join(made.root, "ran");
	mkdirSync(ran);
	let run = layout === "run";
	let worktree = run
		? join(made.state, "runs", "mine")
		: join(made.state, "planners", "octo-org", "score", "D_1");
	// What the Planner runs in: the person's checkout, which is a linked worktree of the repository
	// in the third layout.
	let checkout = layout === "linked" ? join(made.root, "persons-checkout") : made.checkout;
	if (layout === "linked") git(made.checkout, "worktree", "add", "--detach", checkout);
	let entry = layout === "linked"
		? git(checkout, "rev-parse", "--path-format=absolute", "--git-dir")
		: undefined;
	let entryBefore = entry ? readdirSync(entry).sort() : [];
	let headBefore = entry ? readFileSync(join(entry, "HEAD"), "utf8") : "";
	// A Planner's worktree is made by the connector, on the host, before the backend starts.
	mkdirSync(dirname(worktree), { recursive: true });
	if (run) git(made.checkout, "worktree", "add", "--detach", worktree);
	else await preparePlannerWorktree(checkout, worktree);
	let script = join(made.root, "attempts.sh");
	writeFileSync(script, GIT_ATTEMPTS);
	let before = readFileSync(join(made.checkout, ".git", "config"), "utf8");
	let planted: string[] = [];
	let sandbox = await createSandbox({
		directory: made.state,
		home,
		server: "http://127.0.0.1:9",
		settings: { writable: [made.remote] },
		planted: files => planted.push(...files),
	});
	try {
		expect(sandbox.report).toEqual({ engine: "bubblewrap" });
		// As `run.ts` and `planner.ts` start them: a run's own worktree is where it works; a
		// Planner works in the checkout and has its own worktree beside it.
		let child = sandbox.spawn({
			command: ["sh", script],
			cwd: run ? worktree : checkout,
			env: { ...process.env, RAN: ran, WORK: worktree, MAIN: run ? "" : checkout },
			stdin: "ignore",
			...(run ? {} : { writable: [worktree] }),
			own: [worktree],
		});
		let said = "";
		let output = "";
		child.stdout.on("data", chunk => output += chunk);
		child.stderr.on("data", chunk => said += chunk);
		await new Promise(done => child.once("close", done));
		let attempts = Object.fromEntries(
			output.trim().split("\n").filter(line => /^\w+=/.test(line)).map(line => line.split("=")),
		);
		if (attempts.finished !== "done") {
			throw new Error(`The script in the sandbox didn't finish: ${output} ${said.slice(0, 2000)}`);
		}
		let host = await afterwards(made, worktree, run);
		return {
			made,
			checkout,
			// What the person's own git finds in their linked checkout's entry afterwards.
			person: entry
				? {
					names: readdirSync(entry).sort(),
					before: entryBefore,
					head: readFileSync(join(entry, "HEAD"), "utf8") === headBefore,
					status: spawnSync("git", ["-C", checkout, "status"], { encoding: "utf8" }).stdout,
				}
				: undefined,
			attempts,
			host,
			// What the agent's programs did when git ran them, which is to leave a file here.
			ran: readdirSync(ran).sort(),
			configChanged: readFileSync(join(made.checkout, ".git", "config"), "utf8") !== before,
			upstream: spawnSync("git", ["-C", made.checkout, "config", "--get-regexp", "^branch\\."], {
				encoding: "utf8",
			}).stdout.trim(),
			remote: git(made.remote, "branch", "--list").split("\n").map(line =>
				line.trim().replace(/^\* /, "")
			).sort(),
			local: git(made.checkout, "branch", "--list", "--format=%(refname:short)").split("\n").sort(),
			checkoutWritten: existsSync(join(checkout, "agent-wrote.txt")),
			// Whether the link is as it was.
			link: layout === "symlinked"
				? lstatSync(join(made.checkout, ".git")).isSymbolicLink()
					&& readlinkSync(join(made.checkout, ".git")) === store
				: undefined,
			planted,
			redirect: existsSync(join(made.checkout, ".git", "commondir")),
			entries: readdirSync(join(made.checkout, ".git", "worktrees")).sort(),
		};
	} finally {
		await sandbox.close();
	}
}

const PERMITTED = [
	"lfsObject",
	"commit",
	"branch",
	"switch",
	"push",
	"fetch",
	"detach",
];
const REFUSED = [
	"hooksPath",
	"fsmonitor",
	"sshCommand",
	"alias",
	"filterDefinition",
	"extAllowed",
	"remoteCommand",
	"configAppend",
	"configReplace",
	"ownConfigWorktree",
	"commonConfigWorktree",
	"hookReplace",
	"hookNew",
	"attributes",
	"exclude",
	"submoduleConfig",
	"submoduleHook",
	"commonCommondir",
	"commonNewFile",
	"lfsSibling",
	"lfsLock",
	"commonHead",
	"commonPackedRefs",
	"entryCommondir",
	"entryGitdir",
	"entryHooksFile",
	"entryHooksReplace",
	"entryInfoFile",
	"entryModulesFile",
	"entryRename",
	"entryRecreate",
	"newEntry",
	"otherEntryCommondir",
	"otherEntryRename",
	"worktreeAdd",
	"worktreeFile",
	"worktreeFileReplace",
];

/** What a Planner may not do in its person's checkout when that is a linked worktree of theirs. */
const PERSONS_ENTRY = [
	"personRebaseMerge",
	"personRebaseApply",
	"personSequencer",
	"personHead",
	"personOrigHead",
	"personIndex",
	"personLogs",
	"personConfigWorktree",
	"personCommondir",
	"personRename",
	"personRecreate",
];

async function expectGitUntouched(layout: Layout) {
	let result = await gitAttempts(layout);
	let linked = layout === "run";
	expect({ attempts: result.attempts, ran: result.ran, configChanged: result.configChanged })
		.toEqual({
			attempts: {
				...Object.fromEntries(PERMITTED.map(name => [name, "done"])),
				...Object.fromEntries(REFUSED.map(name => [name, "refused"])),
				// The names that are made, in the launch's own entry: see the script. Nothing runs them.
				entryNewName: "done",
				entryRebaseTodo: "done",
				entryLocked: "done",
				entryHookNames: "done",
				...(linked ? {} : {
					// The person's checkout is read-only whole, whatever its `.git` is: its files are not
					// written either.
					checkoutWrite: "refused",
					checkoutGitMove: "refused",
					checkoutGitReplace: "refused",
					// The index and HEAD are in its git directory, which is read-only to it.
					checkoutCommit: "refused",
					...(layout === "linked"
						? Object.fromEntries(PERSONS_ENTRY.map(name => [name, "refused"]))
						: { checkoutConfig: "refused" }),
					checkoutGitRelink: "refused",
				}),
				finished: "done",
			},
			// Each program the agent named leaves a file when git runs it; none ran.
			ran: [],
			configChanged: false,
		});
	// Nothing was planted, so nothing was found and removed, and the git directory is as it was.
	expect(result.planted).toEqual([]);
	expect(result.redirect).toBe(false);
	expect(result.entries).not.toContain("made-up");
	expect(result.entries).toContain("persons-other");
	// Git on the host works as it did, and the worktree still leads to the repository it came from.
	expect(result.host.statuses).toEqual(result.host.statuses.map(() => 0));
	if (linked) expect(result.host.commonDirectory).toBe(join(result.made.checkout, ".git"));
	// What git is for happened: its branches and refs, on both sides. An upstream, which is
	// recorded in the config, is not.
	expect(result.remote).toEqual(
		expect.arrayContaining(["fresh", "main", "pushed", "pushed-u"]),
	);
	expect(result.local).toEqual(expect.arrayContaining(["from-sandbox", "topic", "tracked"]));
	expect(result.upstream).toBe("");
	expect(result.checkoutWritten).toBe(false);
	// A link in the checkout is as it was, and git on the host reads the repository through it.
	if (layout === "symlinked") expect(result.link).toBe(true);
	if (result.person) {
		// The person's own git finds their checkout as it was: no rebase, no merge, nothing added
		// to the entry or taken from it, and its HEAD is the same.
		expect(result.person.names).toEqual(result.person.before);
		expect(result.person.head).toBe(true);
		expect(result.person.status).not.toMatch(/rebas|merg|cherry|revert|bisect/i);
	}
}

sandboxTest(
	"in a run's worktree an agent can commit, branch, fetch, check out and push, and can't rename or remake its worktree's git directory, add another, name programs for git to run or send git elsewhere, and git on the host then runs nothing of its",
	() => expectGitUntouched("run"),
	120_000,
);

sandboxTest(
	"a Planner in its checkout and its own worktree can do the same in that worktree, writes nothing of the checkout, and git on the host runs nothing of the agent's",
	() => expectGitUntouched("planner"),
	120_000,
);

sandboxTest(
	"a Planner whose checkout is a linked worktree of the person's can't write that checkout, its git entry, plant a rebase with an exec line in it or commit there, and its own worktree still commits and pushes",
	() => expectGitUntouched("linked"),
	120_000,
);

sandboxTest(
	"a Planner starts when its checkout's .git is a symbolic link to a git directory kept elsewhere, reads and commits in its own worktree, and can't write that checkout, replace the link or write the git directory, as it can't write any checkout",
	() => expectGitUntouched("symlinked"),
	120_000,
);

/**
 * A repository whose checkout has every kind of submodule: one that is initialized and has a
 * submodule of its own, which is initialized too, and one that is not initialized, as `git clone`
 * leaves them. Git on the host recurses into the first two when it runs `git status` in the
 * checkout, through the `.git` file in each, and reads and runs the configuration it leads to.
 */
function submoduleWorld(name: string) {
	let made = world(name);
	let allow = ["-c", "protocol.file.allow=always"];
	let library = (folder: string, file: string) => {
		let path = join(made.root, folder);
		mkdirSync(path);
		git(path, "init", "-b", "main");
		writeFileSync(join(path, file), `the ${folder} library\n`);
		git(path, "add", ".");
		git(path, "commit", "-m", folder);
		return path;
	};
	let inner = library("inner", "inner.txt");
	let vendor = library("vendor", "lib.txt");
	git(vendor, ...allow, "submodule", "add", "-q", inner, "deps/inner");
	git(vendor, "commit", "-m", "vendor the inner library");
	let extra = library("extra", "extra.txt");
	git(made.checkout, ...allow, "submodule", "add", "-q", vendor, "vendor");
	git(made.checkout, ...allow, "submodule", "update", "--init", "--recursive", "-q");
	git(made.checkout, ...allow, "submodule", "add", "-q", extra, "extra");
	git(made.checkout, "submodule", "deinit", "-f", "extra");
	git(made.checkout, "commit", "-m", "vendor the libraries");
	git(made.checkout, "push", "-q", "origin", "main");
	return made;
}

/**
 * Where a Planner could make the person's own git run a program of its choice through a
 * submodule: `git status`, `git diff` and the commands that use them open each submodule of the
 * person's checkout, and read the git directory its `.git` file names, where `core.fsmonitor` is a
 * program to run. So the Planner copies a submodule's git directory to where it may write (its
 * own worktree), names a program in the copy's configuration, and tries to point a `.git` in the
 * checkout at the copy, in each kind of submodule and by each way it can think of: rewriting the
 * file, removing it, making it where there is none, renaming the folder away and making it again,
 * and writing files in the submodule or the checkout around it. It may read the checkout, and it
 * writes, commits and pushes in its own worktree.
 */
const SUBMODULE_ATTEMPTS = String.raw`
cd "$MAIN"
common=$(git rev-parse --path-format=absolute --git-common-dir)
evil="$WORK/.evil"
mkdir -p "$evil/vendor-git"
printf '#!/bin/sh\ntouch "%s/fsmonitor"\n' "$RAN" > "$evil/fsmonitor"
chmod +x "$evil/fsmonitor"
try() { name=$1; shift; if "$@" > /dev/null 2>&1; then echo "$name=done"; else echo "$name=refused"; fi; }

try present sh -c 'test -f "$1/vendor/.git" && test -f "$1/vendor/deps/inner/.git" && test -d "$1/extra" && test ! -e "$1/extra/.git" && test -d "$2/vendor" && test -d "$2/extra"' sh "$MAIN" "$WORK"
# What it may do: read the checkout and its submodules, and the git directory it copies.
try readSubmodule sh -c 'cat "$1/vendor/lib.txt" "$1/vendor/deps/inner/inner.txt"' sh "$MAIN"
try readSubmoduleHistory git -C "$MAIN/vendor" log --oneline
try copyGitDirectory sh -c 'cp -r "$1/modules/vendor/." "$2/" && sed -i "/worktree/d" "$2/config" && printf "[core]\n\tfsmonitor = %s\n" "$3" >> "$2/config"' sh "$common" "$evil/vendor-git" "$evil/fsmonitor"
# What it may not: write the checkout, which is the person's.
try checkoutFile sh -c 'echo ok > "$1/agent-wrote.txt"' sh "$MAIN"
try checkoutFolder mkdir "$MAIN/docs"
try checkoutCopy cp -r "$common/modules/vendor" "$MAIN/.evil"
# An initialized submodule.
try initializedRedirect sh -c 'printf "gitdir: %s\n" "$2" > "$1/vendor/.git"' sh "$MAIN" "$evil/vendor-git"
try initializedRemove rm -f "$MAIN/vendor/.git"
try initializedEdit sh -c 'echo x >> "$1/vendor/lib.txt"' sh "$MAIN"
try initializedAdd sh -c 'echo x > "$1/vendor/new.txt"' sh "$MAIN"
try initializedRename sh -c 'mv "$1/vendor" "$1/vendor.moved"' sh "$MAIN"
try initializedReplace sh -c 'rm -rf "$1/vendor" && mkdir "$1/vendor" && printf "gitdir: %s\n" "$2" > "$1/vendor/.git"' sh "$MAIN" "$evil/vendor-git"
# One that is not initialized: an empty folder, where git takes a new .git for a submodule to open.
try uninitializedRedirect sh -c 'printf "gitdir: %s\n" "$2" > "$1/extra/.git"' sh "$MAIN" "$evil/vendor-git"
try uninitializedDirectory mkdir "$MAIN/extra/.git"
try uninitializedAdd sh -c 'echo x > "$1/extra/new.txt"' sh "$MAIN"
try uninitializedReplace sh -c 'rm -rf "$1/extra" && mkdir "$1/extra" && printf "gitdir: %s\n" "$2" > "$1/extra/.git"' sh "$MAIN" "$evil/vendor-git"
# A submodule of a submodule.
try nestedRedirect sh -c 'printf "gitdir: %s\n" "$2" > "$1/vendor/deps/inner/.git"' sh "$MAIN" "$evil/vendor-git"
try nestedReplace sh -c 'rm -rf "$1/vendor/deps" && mkdir -p "$1/vendor/deps/inner" && printf "gitdir: %s\n" "$2" > "$1/vendor/deps/inner/.git"' sh "$MAIN" "$evil/vendor-git"
# Its own worktree is where it works.
try worktreeCommit sh -c 'cd "$1" && echo ok > agent-wrote.txt && git add agent-wrote.txt && git -c user.name=agent -c user.email=agent@example.test -c commit.gpgsign=false commit -qm "in its own worktree"' sh "$WORK"
try worktreePush git -C "$WORK" push -q origin HEAD:refs/heads/pushed
echo finished=done
`;

/** What the person's own git is run as: with no configuration of theirs, and with some that opens submodules. */
function personsGit(directory: string, ...args: string[]) {
	return [
		spawnSync("git", ["-C", directory, ...args], {
			encoding: "utf8",
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
		}),
		spawnSync("git", [
			"-C",
			directory,
			"-c",
			"submodule.recurse=true",
			"-c",
			"status.submoduleSummary=true",
			"-c",
			"diff.submodule=log",
			...args,
		], { encoding: "utf8" }),
	];
}

sandboxTest(
	"a Planner reads a checkout with submodules and its own worktree commits and pushes, but it can't write the checkout, a submodule's .git or any file under it, initialized, not initialized or inside another, so the person's own git opens nothing of the agent's",
	async () => {
		let made = submoduleWorld("submodules-planner");
		let ran = join(made.root, "ran");
		mkdirSync(ran);
		let worktree = join(made.state, "planners", "octo-org", "score", "D_1");
		mkdirSync(dirname(worktree), { recursive: true });
		await preparePlannerWorktree(made.checkout, worktree);
		let script = join(made.root, "submodules.sh");
		writeFileSync(script, SUBMODULE_ATTEMPTS);
		let pointers = () =>
			["vendor", "vendor/deps/inner", "extra"].map(folder => {
				try {
					return readFileSync(join(made.checkout, folder, ".git"), "utf8");
				} catch {
					return undefined;
				}
			});
		let before = pointers();
		let sandbox = await createSandbox({
			directory: made.state,
			home,
			server: "http://127.0.0.1:9",
			settings: { writable: [made.remote] },
		});
		try {
			expect(sandbox.report).toEqual({ engine: "bubblewrap" });
			let child = sandbox.spawn({
				command: ["sh", script],
				cwd: made.checkout,
				env: { ...process.env, RAN: ran, WORK: worktree, MAIN: made.checkout },
				stdin: "ignore",
				writable: [worktree],
				own: [worktree],
			});
			let said = "";
			let output = "";
			child.stdout.on("data", chunk => output += chunk);
			child.stderr.on("data", chunk => said += chunk);
			await new Promise(done => child.once("close", done));
			let attempts = Object.fromEntries(
				output.trim().split("\n").filter(line => /^\w+=/.test(line)).map(line => line.split("=")),
			);
			if (attempts.finished !== "done") {
				throw new Error(
					`The script in the sandbox didn't finish: ${output} ${said.slice(0, 2000)}`,
				);
			}
			// The person's own git, as they would run it in their checkout afterwards.
			let statuses = ["status", "diff", "submodule"].flatMap(command =>
				personsGit(made.checkout, ...command === "submodule" ? [command, "status"] : [command])
			);
			expect({ attempts, ran: readdirSync(ran).sort() }).toEqual({
				attempts: {
					present: "done",
					readSubmodule: "done",
					readSubmoduleHistory: "done",
					copyGitDirectory: "done",
					checkoutFile: "refused",
					checkoutFolder: "refused",
					checkoutCopy: "refused",
					initializedRedirect: "refused",
					initializedRemove: "refused",
					initializedEdit: "refused",
					initializedAdd: "refused",
					initializedRename: "refused",
					initializedReplace: "refused",
					uninitializedRedirect: "refused",
					uninitializedDirectory: "refused",
					uninitializedAdd: "refused",
					uninitializedReplace: "refused",
					nestedRedirect: "refused",
					nestedReplace: "refused",
					worktreeCommit: "done",
					worktreePush: "done",
					finished: "done",
				},
				// Each program the agent named leaves a file when git runs it; none ran.
				ran: [],
			});
			expect(statuses.map(result => result.status)).toEqual(statuses.map(() => 0));
			// The checkout is as it was: its submodules' pointers, its folders, and nothing added.
			expect(pointers()).toEqual(before);
			expect(before[0]).toContain("modules/vendor");
			expect(before[2]).toBeUndefined();
			for (let name of ["vendor.moved", "extra.moved", ".evil", "docs", "agent-wrote.txt"]) {
				expect(existsSync(join(made.checkout, name)), name).toBe(false);
			}
			expect(readFileSync(join(made.checkout, "vendor", "lib.txt"), "utf8")).toBe(
				"the vendor library\n",
			);
			expect(statuses[0]!.stdout).toContain("nothing to commit, working tree clean");
			// What it wrote is in its own worktree, and what it committed there reached the remote.
			expect(readFileSync(join(worktree, "agent-wrote.txt"), "utf8")).toBe("ok\n");
			expect(git(made.remote, "branch", "--list", "pushed")).toContain("pushed");
		} finally {
			await sandbox.close();
		}
	},
	120_000,
);

/** What a Planner tries in the person's checkout, which the owner has granted a path of or around. */
const EXTRA_ATTEMPTS = String.raw`
try() { name=$1; shift; if "$@" > /dev/null 2>&1; then echo "$name=done"; else echo "$name=refused"; fi; }
try submoduleGit sh -c 'printf "redirected\n" > "$1/vendor/.git"' sh "$MAIN"
try nestedGit sh -c 'printf "redirected\n" > "$1/vendor/deps/inner/.git"' sh "$MAIN"
try submoduleFile sh -c 'echo x >> "$1/vendor/lib.txt"' sh "$MAIN"
try checkoutFile sh -c 'echo x > "$1/agent-wrote.txt"' sh "$MAIN"
try checkoutHook sh -c 'echo x > "$1/.git/hooks/post-checkout"' sh "$MAIN"
try checkoutConfig sh -c 'echo x >> "$1/.git/config"' sh "$MAIN"
try granted sh -c 'echo ok > "$1/ok.txt"' sh "$GRANTED"
echo finished=done
`;

/**
 * An owner's `--sandbox-write` path is the one grant the policy takes as given, so it must never
 * reopen the person's checkout: a path that is the checkout, or inside it (a submodule's folder,
 * the git directory), is not granted, and one that holds it is granted with the checkout still
 * read-only.
 */
async function extraWrite(
	name: string,
	extra: (made: ReturnType<typeof world>) => string[],
	launch: "planner" | "run" = "planner",
) {
	let made = submoduleWorld(name);
	let granted = join(made.root, "granted");
	mkdirSync(granted);
	let sandbox = await createSandbox({
		directory: made.state,
		home,
		server: "http://127.0.0.1:9",
		settings: { writable: extra(made).concat(granted) },
	});
	try {
		expect(sandbox.report).toEqual({ engine: "bubblewrap" });
		let main = existsSync(join(made.root, "src", "proj"))
			? join(made.root, "src", "proj")
			: made.checkout;
		// A run works in a worktree the connector made, and the person's checkout is where it came from.
		let worktree = join(made.state, "runs", "mine");
		if (launch === "run") {
			git(main, "worktree", "add", "--detach", worktree);
			repositoryAt(worktree);
		}
		let script = join(made.root, "extra.sh");
		writeFileSync(script, EXTRA_ATTEMPTS);
		let child = sandbox.spawn({
			command: ["sh", script],
			cwd: launch === "run" ? worktree : main,
			env: { ...process.env, MAIN: main, GRANTED: granted },
			stdin: "ignore",
			...launch === "run" ? { own: [worktree] } : {},
		});
		let said = "";
		let output = "";
		child.stdout.on("data", chunk => output += chunk);
		child.stderr.on("data", chunk => said += chunk);
		await new Promise(done => child.once("close", done));
		let attempts = Object.fromEntries(
			output.trim().split("\n").filter(line => /^\w+=/.test(line)).map(line => line.split("=")),
		);
		if (attempts.finished !== "done") {
			throw new Error(`The script in the sandbox didn't finish: ${output} ${said.slice(0, 2000)}`);
		}
		expect(attempts).toEqual({
			submoduleGit: "refused",
			nestedGit: "refused",
			submoduleFile: "refused",
			checkoutFile: "refused",
			checkoutHook: "refused",
			checkoutConfig: "refused",
			// What the owner meant to give is given.
			granted: "done",
			finished: "done",
		});
		expect(readFileSync(join(granted, "ok.txt"), "utf8")).toBe("ok\n");
		expect(readFileSync(join(main, "vendor", ".git"), "utf8")).toContain("modules/vendor");
		expect(existsSync(join(main, "agent-wrote.txt"))).toBe(false);
	} finally {
		await sandbox.close();
	}
}

sandboxTest(
	"a path the owner grants inside the person's checkout, a submodule's folder or its git directory, is not granted, so a Planner can't rewrite a submodule's .git there",
	async () => {
		await extraWrite("extra-inside", made => [join(made.checkout, "vendor")]);
		await extraWrite("extra-git", made => [join(made.checkout, ".git", "hooks")]);
	},
	120_000,
);

sandboxTest(
	"the person's checkout given as a path to write is not granted, and a folder that holds it is granted with the checkout still read-only",
	async () => {
		await extraWrite("extra-is", made => [made.checkout]);
		let under = (made: ReturnType<typeof world>) => {
			// The checkout moves under a folder the owner grants, which holds no state directory.
			let src = join(made.root, "src");
			mkdirSync(src);
			renameSync(made.checkout, join(src, "proj"));
			return [src];
		};
		await extraWrite("extra-holds", under);
		// A run's worktree is the agent's, and the checkout it came from is still the person's.
		await extraWrite("extra-holds-run", under, "run");
		await extraWrite("extra-is-run", made => [made.checkout], "run");
	},
	120_000,
);

/**
 * What an agent does in the worktree the connector made for its run, which is its own and which it
 * writes whole, the index included: it makes a `.git` in each submodule's folder, which git leaves
 * empty, pointing at a git directory of its own whose configuration names programs, and adds a
 * submodule of its own with one. The connector's git, and its removal of the worktree, then run.
 */
const RUN_SUBMODULE_ATTEMPTS = String.raw`
cd "$WORK"
common=$(git rev-parse --path-format=absolute --git-common-dir)
evil="$WORK/.evil"
fake="$evil/fake"
mkdir -p "$fake"
cp -r "$common/." "$fake/"
for hook in fsmonitor post-checkout; do
	printf '#!/bin/sh\ntouch "%s/%s"\n' "$RAN" "$hook" > "$evil/$hook"
	chmod +x "$evil/$hook"
done
git config --file "$fake/config" core.fsmonitor "$evil/fsmonitor"
git config --file "$fake/config" core.hooksPath "$evil"
try() { name=$1; shift; if "$@" > /dev/null 2>&1; then echo "$name=done"; else echo "$name=refused"; fi; }

try present sh -c 'test -d "$1/vendor" && test -d "$1/extra" && test ! -e "$1/vendor/.git" && test ! -e "$1/extra/.git"' sh "$WORK"
try readTracked cat README.md .gitmodules
try writeWorktree sh -c 'mkdir -p docs && echo ok > docs/note.txt'
try redirect sh -c 'printf "gitdir: %s\n" "$2" > "$1/vendor/.git"' sh "$WORK" "$fake"
# A submodule of its own, in its own worktree.
try newGitlink sh -c 'cd "$1" && git update-index --add --cacheinfo 160000,"$(git rev-parse HEAD)",agent-sub && mkdir agent-sub && printf "gitdir: %s\n" "$2" > agent-sub/.git' sh "$WORK" "$fake"
try commit sh -c 'git add docs && git -c user.name=agent -c user.email=agent@example.test -c commit.gpgsign=false commit -qm "in the sandbox"'
try push git push -q origin HEAD:refs/heads/pushed
# The person's checkout, which is not its to write.
try checkoutRedirect sh -c 'printf "gitdir: %s\n" "$2" > "$1/vendor/.git"' sh "$MAIN" "$fake"
echo finished=done
`;

sandboxTest(
	"in a run's worktree an agent that points a submodule's .git at a git directory of its own, and adds a submodule with one, gets nothing run by the connector's git or its removal of the worktree, and can't do the same in the person's checkout",
	async () => {
		let made = submoduleWorld("submodules-run");
		let ran = join(made.root, "ran");
		mkdirSync(ran);
		let worktree = join(made.state, "runs", "mine");
		git(made.checkout, "worktree", "add", "--detach", worktree);
		repositoryAt(worktree);
		let script = join(made.root, "run-submodules.sh");
		writeFileSync(script, RUN_SUBMODULE_ATTEMPTS);
		let sandbox = await createSandbox({
			directory: made.state,
			home,
			server: "http://127.0.0.1:9",
			settings: { writable: [made.remote] },
		});
		let attempts: Record<string, string>;
		try {
			let child = sandbox.spawn({
				command: ["sh", script],
				cwd: worktree,
				env: { ...process.env, RAN: ran, WORK: worktree, MAIN: made.checkout },
				stdin: "ignore",
				own: [worktree],
			});
			let said = "";
			let output = "";
			child.stdout.on("data", chunk => output += chunk);
			child.stderr.on("data", chunk => said += chunk);
			await new Promise(done => child.once("close", done));
			attempts = Object.fromEntries(
				output.trim().split("\n").filter(line => /^\w+=/.test(line)).map(line => line.split("=")),
			);
			if (attempts.finished !== "done") {
				throw new Error(
					`The script in the sandbox didn't finish: ${output} ${said.slice(0, 2000)}`,
				);
			}
		} finally {
			await sandbox.close();
		}
		expect(attempts).toEqual({
			present: "done",
			readTracked: "done",
			writeWorktree: "done",
			// Its own worktree is its own: what it makes there is its to make.
			redirect: "done",
			newGitlink: "done",
			commit: "done",
			push: "done",
			// The person's is not.
			checkoutRedirect: "refused",
			finished: "done",
		});
		expect(readFileSync(join(made.checkout, "vendor", ".git"), "utf8")).toContain("modules/vendor");
		// The connector's own git, as a run and a Planner make it, in that worktree.
		let hostile = [
			gitSync(["status", "--short"], { cwd: worktree }).status,
			gitSync(["diff"], { cwd: worktree }).status,
			gitSync(["ls-files", "--stage"], { cwd: worktree }).status,
			await gitAsync(["fetch", "origin"], { cwd: worktree, env: LOCAL_REMOTE }).then(
				() => 0,
				() => 1,
			),
		];
		expect(hostile).toEqual(hostile.map(() => 0));
		// `git submodule status` stops at a gitlink the repository's .gitmodules doesn't name, as it
		// does for anyone, but it runs nothing either.
		gitSync(["submodule", "status"], { cwd: worktree });
		expect(readdirSync(ran)).toEqual([]);
		// The redirect is real: git without the connector's settings runs what it names, so that
		// it ran nothing above is the connector's doing and not an attempt that went nowhere.
		spawnSync("git", ["-C", worktree, "status"], {
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
		});
		expect(readdirSync(ran)).toContain("fsmonitor");
		for (let name of readdirSync(ran)) rmSync(join(ran, name));
		// And its removal of the worktree, as a finished spike's is.
		await discardWorkspace(made.checkout, worktree, "no-such-branch");
		expect(existsSync(worktree)).toBe(false);
		expect(readdirSync(ran)).toEqual([]);
		// The person's own git in their checkout, which the agent never wrote, runs nothing.
		for (let result of personsGit(made.checkout, "status")) expect(result.status).toBe(0);
		expect(readdirSync(ran)).toEqual([]);
	},
	120_000,
);

/**
 * What Git LFS does when it stores an object: its clean filter, run by `git add`, writes the
 * object under the repository's `lfs` directory, which is the one name in the git directory beside
 * `objects`, `refs` and `logs` that a launch may write.
 */
const LFS = String.raw`
cd "$WORK"
printf '*.bin filter=lfs diff=lfs merge=lfs -text
' > .gitattributes
head -c 4096 /dev/zero | tr '\0' x > big.bin
git -c user.name=a -c user.email=a@a -c commit.gpgsign=false 	-c 'filter.lfs.clean=git-lfs clean -- %f' -c filter.lfs.required=true 	add .gitattributes big.bin && echo added=done
git -c user.name=a -c user.email=a@a -c commit.gpgsign=false commit -qm "a pointer" && echo committed=done
`;

test.skipIf(!usable || !Bun.which("git-lfs"))(
	"Git LFS in a run's worktree stores its object in the repository's lfs directory, and the commit holds the pointer",
	async () => {
		let made = world("lfs");
		let worktree = join(made.state, "runs", "mine");
		git(made.checkout, "worktree", "add", "--detach", worktree);
		// LFS has been used in this checkout, so its storage is there, as the policy requires.
		mkdirSync(join(made.checkout, ".git", "lfs"));
		let script = join(made.root, "lfs.sh");
		writeFileSync(script, LFS);
		let sandbox = await createSandbox({
			directory: made.state,
			home,
			server: "http://127.0.0.1:9",
		});
		try {
			let child = sandbox.spawn({
				command: ["sh", script],
				cwd: worktree,
				env: { ...process.env, WORK: worktree },
				stdin: "ignore",
				own: [worktree],
			});
			let output = "";
			child.stdout.on("data", chunk => output += chunk);
			child.stderr.on("data", chunk => output += chunk);
			await new Promise(done => child.once("close", done));
			expect(output).toContain("added=done");
			expect(output).toContain("committed=done");
			let oid = createHash("sha256").update("x".repeat(4096)).digest("hex");
			expect(
				existsSync(
					join(made.checkout, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid),
				),
			).toBe(true);
			expect(git(worktree, "show", "HEAD:big.bin")).toContain(`oid sha256:${oid}`);
		} finally {
			await sandbox.close();
		}
	},
	60_000,
);

/**
 * The agent makes `.git/commondir` in the person's checkout, pointing at a git directory of its own
 * whose configuration names a remote that is a command, and removes it again, over and over, while
 * the connector starts runs in that checkout: the one moment a check that came before the connector's
 * git might have missed. The command writes a file the sandbox can't, so it shows if it ran.
 */
const RACE = String.raw`
cd "$WORK"
common=$(git rev-parse --path-format=absolute --git-common-dir)
fake="$WORK/.fake"
mkdir -p "$fake" && cp -r "$common/." "$fake/"
git config --file "$fake/config" protocol.ext.allow always
git config --file "$fake/config" remote.origin.url "ext::$WORK/.fake-hooks/ext %S"
git config --file "$fake/config" core.fsmonitor "$WORK/.fake-hooks/fsmonitor"
git config --file "$fake/config" core.hooksPath "$WORK/.fake-hooks"
mkdir -p "$WORK/.fake-hooks"
for hook in post-checkout reference-transaction fsmonitor ext; do
	printf '#!/bin/sh\ntouch "%s/%s"\n' "$RAN" "$hook" > "$WORK/.fake-hooks/$hook"
	chmod +x "$WORK/.fake-hooks/$hook"
done
echo ready > "$WORK/ready"
while :; do
	printf '%s\n' "$fake" > "$MAIN/.git/commondir" 2> /dev/null
	rm -f "$MAIN/.git/commondir" 2> /dev/null
done
`;

sandboxTest(
	"an agent making and removing .git/commondir while the connector starts runs in the checkout gets nothing run on the host",
	async () => {
		let made = gitWorld("race");
		let ran = join(made.root, "ran");
		mkdirSync(ran);
		let worktree = join(made.state, "planners", "octo-org", "score", "D_1");
		mkdirSync(dirname(worktree), { recursive: true });
		git(made.checkout, "worktree", "add", "--detach", worktree);
		let script = join(made.root, "race.sh");
		writeFileSync(script, RACE);
		let commit = git(made.checkout, "rev-parse", "HEAD");
		let sandbox = await createSandbox({
			directory: made.state,
			home,
			server: "http://127.0.0.1:9",
		});
		let child = sandbox.spawn({
			command: ["sh", script],
			cwd: made.checkout,
			env: { ...process.env, RAN: ran, WORK: worktree, MAIN: made.checkout },
			stdin: "ignore",
			writable: [worktree],
			own: [worktree],
		});
		let said = "";
		child.stderr.on("data", chunk => said += chunk);
		try {
			for (
				let deadline = Date.now() + 60_000;
				!existsSync(join(worktree, "ready"));
				await Bun.sleep(50)
			) {
				if (Date.now() > deadline) {
					throw new Error(`The agent never got going: ${said.slice(0, 2000)}`);
				}
			}
			let outcomes: string[] = [];
			// Runs of a commit the checkout has, which are added as a worktree, and of one it hasn't,
			// which is fetched first: the two places the connector's git reads configuration and runs.
			for (let index = 0, stop = Date.now() + 20_000; Date.now() < stop; index++) {
				let input = {
					id: `race-${index}`,
					source: {
						repository: "octo-org/score",
						commit: index % 2 ? commit : "0123456789abcdef0123456789abcdef01234567",
					},
				};
				outcomes.push(
					await prepareWorkspace(made.checkout, made.state, input as never).then(
						() => "ready",
						error => (error as Error).message.split("\n")[0]!.slice(0, 80),
					),
				);
			}
			process.kill(-child.pid!, "SIGKILL");
			await new Promise(done => child.once("close", done));
			expect(outcomes.length).toBeGreaterThan(10);
			// Nothing the agent named ran, whichever way each run ended.
			expect(readdirSync(ran)).toEqual([]);
			expect(existsSync(join(made.checkout, ".git", "commondir"))).toBe(false);
			// And the runs that could go ahead did.
			expect(outcomes).toContain("ready");
		} finally {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch { /* It had already gone. */ }
			await sandbox.close();
		}
	},
	120_000,
);

let atomic = Bun.which("atomic-acp") && Bun.which("atomic");
test.skipIf(!usable || !atomic)(
	"Atomic, through atomic-acp with a scripted model, runs its tools in the sandbox",
	async () => {
		let made = world("atomic");
		let chopin = server("chopin");
		let worktree = join(made.state, "runs", "mine");
		git(made.checkout, "worktree", "add", "--detach", worktree);
		let script = join(made.root, "command.sh");
		writeFileSync(
			script,
			`{
cat README.md > /dev/null 2>&1 && echo readRepository=ok || echo readRepository=FAILED
(echo ok > written.txt) 2>/dev/null && echo writeWorktree=ok || echo writeWorktree=FAILED
(echo x > ${home}/escaped.txt) 2>/dev/null && echo writeOutside=LEAKED || echo writeOutside=blocked
cat ${home}/.ssh/id_ed25519 > /dev/null 2>&1 && echo readSsh=LEAKED || echo readSsh=blocked
cat ${made.state}/machine.json > /dev/null 2>&1 && echo readToken=LEAKED || echo readToken=blocked
git add written.txt && git -c user.name=a -c user.email=a@a -c commit.gpgsign=false commit -qm scripted && git push ${made.remote} HEAD:refs/heads/scripted > /dev/null 2>&1 && echo push=ok || echo push=FAILED
curl -sS -m 10 -o /dev/null https://example.org/ > /dev/null 2>&1 && echo offList=LEAKED || echo offList=blocked
curl -sS -m 10 -o /dev/null ${chopin.url} > /dev/null 2>&1 && echo chopin=ok || echo chopin=FAILED
} > probe.log 2>&1
`,
		);
		let sandbox = await createSandbox({
			directory: made.state,
			home,
			server: new URL(chopin.url).origin,
			settings: { writable: [made.remote] },
		});
		try {
			expect(sandbox.report.engine).toBe("bubblewrap");
			let stop = await runAgent({
				command: ["atomic-acp"],
				cwd: worktree,
				prompt: "Run the script.",
				mcpServers: [],
				signal: new AbortController().signal,
				onUpdate: () => {},
				permission: async () => undefined,
				env: {
					ATOMIC_ACP_HEADLESS: "1",
					SCRIPTED_COMMAND_FILE: script,
					ATOMIC_ACP_ATOMIC_ARGS: JSON.stringify([
						"-e",
						join(import.meta.dir, "testing/scripted-atomic.mjs"),
						"--provider",
						"scripted",
						"--model",
						"scripted-1",
					]),
				},
				sandbox,
				own: [worktree],
			});
			expect(stop).toBe("end_turn");
			let lines = readFileSync(join(worktree, "probe.log"), "utf8").trim().split("\n").sort();
			let expected = [
				"chopin=ok",
				"offList=blocked",
				"push=ok",
				"readRepository=ok",
				"readSsh=blocked",
				"readToken=blocked",
				"writeOutside=blocked",
				"writeWorktree=ok",
			];
			// curl may be missing where the test runs; the network lines are then left out.
			let hasCurl = Bun.which("curl") !== null;
			expect(lines).toEqual(
				hasCurl ? expected : expected.filter(line => !/^(chopin|offList)=/.test(line)),
			);
			expect(existsSync(join(home, "escaped.txt"))).toBe(false);
			expect(git(made.remote, "branch", "--list", "scripted")).toContain("scripted");
		} finally {
			await sandbox.close();
			chopin.stop();
		}
	},
	180_000,
);
