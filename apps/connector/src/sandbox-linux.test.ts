import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
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
