import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sandboxLabel } from "@chopin/protocol/connector";
import { runAgent } from "./acp";
import { checkouts } from "./checkouts";
import { createOutput } from "./output";
import { servePlanners } from "./planner";
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
	let remote = join(root, "remote.git");
	let state = join(root, "state");
	mkdirSync(join(home, ".ssh"), { recursive: true });
	mkdirSync(join(home, ".aws"), { recursive: true });
	writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE KEY");
	writeFileSync(join(home, ".aws", "credentials"), "aws_secret_access_key=secret");
	mkdirSync(checkout, { recursive: true });
	git(root, "init", "--bare", remote);
	git(checkout, "init", "-b", "main");
	writeFileSync(join(checkout, "README.md"), "the repository\n");
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

sandboxTest(
	"a Planner backend in the sandbox makes its own worktree and reads its checkout, with the same limits",
	async () => {
		let made = world("planner");
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
				registered: { "octo-org/score": made.checkout },
			}),
			directory: made.state,
			output: createOutput(quiet, quiet, {}),
			signal: abort.signal,
			env: {
				SANDBOX_CHECKS: JSON.stringify({
					...plan(made, origin + "/", extra.url, github),
					// A Planner runs in its checkout, which it may write, and makes its own worktree.
					notWritable: [join(home, "escaped.txt")],
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
			expect(result).toHaveProperty("ownWorktree");
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
	},
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
 * reads that directory and runs what it names: `core.hooksPath` and `core.fsmonitor`, a hook, a
 * filter, the git directory a worktree points at. So the agent here tries to name its own
 * programs in each place git looks, with `git config` and by writing the files, and then the
 * host's own git commands run, as the connector's next `git worktree add` and a person's
 * `git status` do. Whatever the agent was allowed to write, the host then ran.
 */
const GIT_ATTEMPTS = String.raw`
common=$(git rev-parse --path-format=absolute --git-common-dir)
mine=$(git rev-parse --path-format=absolute --git-dir)
evil="$PWD/evil"
mkdir -p "$evil"
for name in post-checkout reference-transaction pre-commit fsmonitor; do
	printf '#!/bin/sh\ntouch "%s/%s"\n' "$RAN" "$name" > "$evil/$name"
	chmod +x "$evil/$name"
done
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
if [ -n "$WT" ]; then try ownWorktree git worktree add -q --detach "$WT"; fi

# What it must not: naming programs for git to run, in every place git reads them.
try hooksPath git config core.hooksPath "$evil"
try fsmonitor git config core.fsmonitor "$evil/fsmonitor"
try sshCommand git config core.sshCommand "$evil/fsmonitor"
try alias git config alias.sync "!touch \"$RAN/alias\""
try configAppend sh -c 'printf "[core]\n\thooksPath = %s\n" "$2" >> "$1/config"' sh "$common" "$evil"
try configReplace sh -c 'cp "$1/config" "$1/config.new" && printf "[core]\n\tfsmonitor = %s\n" "$2" >> "$1/config.new" && mv -f "$1/config.new" "$1/config"' sh "$common" "$evil/fsmonitor"
rm -f "$common/config.new"
try ownConfigWorktree sh -c 'printf "[core]\n\tfsmonitor = %s\n" "$2" > "$1/config.worktree"' sh "$mine" "$evil/fsmonitor"
try commonConfigWorktree sh -c 'printf "[core]\n\tfsmonitor = %s\n" "$2" > "$1/config.worktree"' sh "$common" "$evil/fsmonitor"
try hookReplace cp "$evil/post-checkout" "$common/hooks/post-checkout"
try hookNew cp "$evil/reference-transaction" "$common/hooks/reference-transaction"
try attributes sh -c 'echo "* filter=evil" >> "$1/info/attributes"' sh "$common"
try exclude sh -c 'echo evil >> "$1/info/exclude"' sh "$common"
# A submodule's git directory is read the same way, when git runs in it.
try submoduleConfig sh -c 'printf "[core]\n\tfsmonitor = %s\n" "$2" >> "$1/modules/vendor/config"' sh "$common" "$evil/fsmonitor"
try submoduleHook cp "$evil/post-checkout" "$common/modules/vendor/hooks/post-checkout"
# A git directory of its own, with a configuration that names a program, for git to be sent to.
mkdir -p "$evil/fake" && cp -r "$common/." "$evil/fake/" && git config --file "$evil/fake/config" core.fsmonitor "$evil/fsmonitor"
# A new file in the top level of the repository's git directory: a commondir sends git to the
# configuration of the directory it names.
try commonCommondir sh -c 'printf "%s\n" "$2" > "$1/commondir"' sh "$common" "$evil/fake"
if [ "$mine" != "$common" ]; then
	# A linked worktree: the file in it, and the one in its git directory, say where its git
	# directory and its configuration are, and the repository's own HEAD is the checkout's.
	try commonHead sh -c 'echo "ref: refs/heads/evil" > "$1/HEAD"' sh "$common"
	try worktreeFile sh -c 'printf "gitdir: %s\n" "$1" > .git' sh "$evil/fake"
	try worktreeFileReplace sh -c 'rm -f .git && mkdir .git'
	try commondir sh -c 'printf "%s\n" "$2" > "$1/commondir"' sh "$mine" "$evil/fake"
else
	try gitDirMove sh -c 'mv .git .git.moved'
fi
echo finished=done
`;

async function gitAttempts(layout: "run" | "planner") {
	let made = world(`git-${layout}`);
	let ran = join(made.root, "ran");
	mkdirSync(ran);
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
	let worktree = join(made.state, "runs", "mine");
	let planned = join(made.state, "planners", "octo", "score", "D_1");
	if (layout === "run") git(made.checkout, "worktree", "add", "--detach", worktree);
	let cwd = layout === "run" ? worktree : made.checkout;
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
		let child = sandbox.spawn({
			command: ["sh", script],
			cwd,
			env: { ...process.env, RAN: ran, WT: layout === "planner" ? planned : "" },
			stdin: "ignore",
			...(layout === "planner" ? { writable: [planned] } : {}),
			own: [layout === "run" ? worktree : planned],
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
		// Then git on the host, with nothing of the sandbox about it: what the connector does for
		// the next run, what a person does in the checkout, and a hook-driven ref update.
		let next = join(made.state, "runs", "next");
		let hostGit = (directory: string, ...args: string[]) =>
			spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" }).status;
		let host = [
			hostGit(made.checkout, "worktree", "add", "--detach", next),
			hostGit(made.checkout, "status"),
			hostGit(next, "status"),
			...(layout === "run" ? [hostGit(worktree, "status")] : []),
			hostGit(made.checkout, "branch", "-f", "after-sandbox", "main"),
			hostGit(made.checkout, "worktree", "prune"),
			// And the connector's own, as prepareWorkspace and the end of a run make them.
			await gitAsync([
				"-C",
				made.checkout,
				"worktree",
				"add",
				"--detach",
				join(made.state, "runs", "next-by-connector"),
			]).then(() => 0, () => 1),
			gitSync(["-C", made.checkout, "status"]).status,
			await gitAsync(["-C", made.checkout, "worktree", "prune"]).then(() => 0, () => 1),
		];
		return {
			checkout: made.checkout,
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
			plannerWorktree: existsSync(join(planned, ".git")),
			planted,
			redirect: existsSync(join(made.checkout, ".git", "commondir")),
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
];

async function expectGitUntouched(layout: "run" | "planner") {
	let result = await gitAttempts(layout);
	let linked = layout === "run";
	// What was refused, and that nothing the agent wrote ran when git did on the host (each program
	// it wrote leaves a file if it runs), with the config as it was.
	expect({ attempts: result.attempts, ran: result.ran, configChanged: result.configChanged })
		.toEqual({
			attempts: {
				...Object.fromEntries(PERMITTED.map(name => [name, "done"])),
				...(layout === "planner" ? { ownWorktree: "done" } : {}),
				...Object.fromEntries(REFUSED.map(name => [name, "refused"])),
				...(linked
					? {
						worktreeFile: "refused",
						worktreeFileReplace: "refused",
						commondir: "refused",
						commonHead: "refused",
						// A run in a linked worktree can't make a file in the repository's git directory.
						commonCommondir: "refused",
					}
					// A Planner writes its checkout's git directory whole, so it can make one. The
					// connector removes it, and says so, when the launch ends, before anyone runs git.
					: { gitDirMove: "refused", commonCommondir: "done" }),
				finished: "done",
			},
			ran: [],
			configChanged: false,
		});
	expect(result.planted).toEqual(linked ? [] : [join(result.checkout, ".git", "commondir")]);
	expect(result.redirect).toBe(false);
	// Git on the host works as it did.
	expect(result.host.every(status => status === 0)).toBe(true);
	// What git is for happened: its branches and refs, on both sides. An upstream, which is
	// recorded in the config, is not.
	expect(result.remote).toEqual(
		expect.arrayContaining(["fresh", "main", "pushed", "pushed-u"]),
	);
	expect(result.local).toEqual(expect.arrayContaining(["from-sandbox", "topic", "tracked"]));
	expect(result.upstream).toBe("");
	expect(result.plannerWorktree).toBe(layout === "planner");
}

sandboxTest(
	"in a run's worktree an agent can commit, branch, fetch, check out and push, and can't name programs for git to run: config, hooks, attributes and the worktree's own git files are refused, and git on the host then runs nothing of its",
	() => expectGitUntouched("run"),
	120_000,
);

sandboxTest(
	"in a Planner's checkout the same: its git directory takes commits, branches and pushes, but the configuration, hooks and attributes in it are refused, and git on the host runs nothing of the agent's",
	() => expectGitUntouched("planner"),
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
