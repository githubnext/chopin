import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
import { preparePlannerWorktree, prepareWorkspace } from "./workspace";
import { gitAsync, gitSync } from "./git-host";
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
				// A Planner runs in its checkout, whose files it may write but not its git directory,
				// and finds its own worktree there, made by the connector.
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
	"a Planner backend in the sandbox finds its own worktree made, reads its checkout and writes and commits in that worktree, with the same limits, and can't add or alter any other worktree",
	() => plannerBackend(false),
	150_000,
);

sandboxTest(
	"a Planner backend whose checkout is a linked worktree of the person's finds its own worktree made, and can't write that worktree's git entry, plant a rebase in it or commit there",
	() => plannerBackend(true),
	150_000,
);

/**
 * An agent starts first and a run, a Planner and a token file start after it, as they do on a
 * machine that has served for a while. What it can see of the connector's state directory is
 * settled when it starts, so nothing made later may be in its sight, and what it was given
 * (its own worktree and the folder of its tokens, one of which is renewed) still is.
 */
async function startedLater(layout: "run" | "planner") {
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
	let cwd = layout === "run" ? worktree : made.checkout;
	if (layout === "run") git(made.checkout, "worktree", "add", "--detach", worktree);
	else mkdirSync(worktree, { recursive: true });
	mkdirSync(tokens, { recursive: true });
	writeFileSync(join(tokens, "github"), "first\n");
	let later = [
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
				own: { [join(tokens, "github")]: "second\n" },
				hiddenIn: [runs, planners],
			}),
		},
		stdin: "ignore",
		...(layout === "planner" ? { writable: [worktree] } : {}),
		own: [worktree, tokens],
	});
	let said = "";
	child.stderr.on("data", chunk => said += chunk);
	try {
		for (let deadline = Date.now() + 60_000; !existsSync(join(cwd, "up")); await Bun.sleep(50)) {
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
		writeFileSync(join(cwd, "go"), "");
		for (
			let deadline = Date.now() + 60_000;
			!existsSync(join(cwd, "report.json"));
			await Bun.sleep(50)
		) {
			if (Date.now() > deadline) {
				throw new Error(`The process in the sandbox never reported: ${said.slice(0, 2000)}`);
			}
		}
		let result = JSON.parse(readFileSync(join(cwd, "report.json"), "utf8")) as CheckResult;
		return Object.entries(result).filter(([, value]) => !value.ok).map(([name, value]) =>
			`${name}: ${value.detail}`
		);
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
try commonHead sh -c 'echo "ref: refs/heads/evil" > "$1/HEAD"' sh "$common"
try commonPackedRefs sh -c 'echo > "$1/packed-refs"' sh "$common"
try entryCommondir sh -c 'printf "%s\n" "$2" > "$1/commondir"' sh "$mine" "$fake"
try entryGitdir sh -c 'printf "%s\n" "$2" > "$1/gitdir"' sh "$mine" "$fake/.git"
try entryRename sh -c 'mv "$1" "$1.moved" && mv "$1.moved" "$1"' sh "$mine"
try entryRecreate sh -c 'mv "$1" "$1.moved" && mkdir "$1" && cp -r "$1.moved/." "$1/" && rm -f "$1/commondir" && printf "%s\n" "$2" > "$1/commondir"' sh "$mine" "$fake"
try newEntry sh -c 'mkdir "$1/worktrees/made-up" && printf "%s\n" "$2" > "$1/worktrees/made-up/commondir"' sh "$common" "$fake"
try otherEntryCommondir sh -c 'printf "%s\n" "$2" > "$1/worktrees/persons-other/commondir"' sh "$common" "$fake"
try otherEntryRename sh -c 'mv "$1/worktrees/persons-other" "$1/worktrees/persons-other.moved"' sh "$common"
try worktreeAdd git worktree add -q --detach "$evil/second"
try worktreeFile sh -c 'printf "gitdir: %s\n" "$1" > .git' sh "$fake"
try worktreeFileReplace sh -c 'rm -f .git && mkdir .git'
if [ -n "$MAIN" ]; then
	# A Planner's working directory is its person's checkout, which it writes but for its .git.
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
	// As a sparse checkout leaves a repository: per-worktree configuration is read, and there is
	// no such file yet.
	git(made.checkout, "config", "extensions.worktreeConfig", "true");
	// Another worktree of the person's, which no agent has any business with.
	git(made.checkout, "worktree", "add", "--detach", join(made.root, "persons-other"));
	return made;
}

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
		await gitAsync(["fetch", "origin"], { cwd: made.checkout }).then(() => 0, () => 1),
		gitSync(["ls-remote", "origin"], { cwd: made.checkout }).status,
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
	"commonHead",
	"commonPackedRefs",
	"entryCommondir",
	"entryGitdir",
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
				...(linked ? {} : {
					// Its files, but not where `.git` is a link, which can't be held: that checkout is read.
					checkoutWrite: layout === "symlinked" ? "refused" : "done",
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
	expect(result.checkoutWritten).toBe(layout === "planner" || layout === "linked");
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
	"a Planner in its checkout and its own worktree can do the same in that worktree, writes the checkout's files but not its .git, and git on the host runs nothing of the agent's",
	() => expectGitUntouched("planner"),
	120_000,
);

sandboxTest(
	"a Planner whose checkout is a linked worktree of the person's can't write that worktree's git entry, plant a rebase with an exec line in it or commit there, and its own worktree still commits and pushes",
	() => expectGitUntouched("linked"),
	120_000,
);

sandboxTest(
	"a Planner starts when its checkout's .git is a symbolic link to a git directory kept elsewhere, reads and commits in its own worktree, and can't write that checkout, replace the link or write the git directory",
	() => expectGitUntouched("symlinked"),
	120_000,
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
