import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, writeFileSync as writeFileSyncNow } from "node:fs";
import {
	connectors,
	endWorkspace,
	git,
	lockWorkspace,
	prepareWorkspace,
	processStart,
	pruneRuns,
	workspace,
} from "./workspace";
import { CONNECTOR_PROTOCOL, VERSION } from "./version";

test("isolates exact source and allows an authorized retry without executing an attempt twice", async () => {
	let root = await mkdtemp(join(tmpdir(), "chopin-workspace-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-state-"));
	try {
		git(root, "init");
		git(root, "config", "user.name", "Fixture");
		git(root, "config", "user.email", "fixture@example.test");
		git(root, "remote", "add", "origin", "git@github.com:org/repo.git");
		await writeFile(join(root, "source.txt"), "committed");
		git(root, "add", ".");
		git(root, "commit", "-m", "fixture");
		await writeFile(join(root, "source.txt"), "user work");
		let info = await workspace(root);
		expect(info.repository).toBe("org/repo");
		let release = await lockWorkspace(root, state);
		await expect(lockWorkspace(root, state)).rejects.toThrow("already locked");
		let input = {
			id: crypto.randomUUID(),
			documentId: crypto.randomUUID(),
			brief: "Inspect",
			context: "",
			requester: "u",
			authorizer: "u",
			source: { repositoryId: "r", repository: info.repository, commit: info.commit },
		};
		let prepared = await prepareWorkspace(root, state, input);
		// No worktree is made on the host: the run's microVM clones the checkout's git directory.
		expect(prepared.source).toBe(await realpath(join(root, ".git")));
		expect(prepared.commit).toBe(info.commit);
		expect(existsSync(prepared.path)).toBe(false);
		expect(await readFile(join(root, "source.txt"), "utf8")).toBe("user work");
		await expect(prepareWorkspace(root, state, input)).rejects.toThrow("already accepted");
		let retried = await prepareWorkspace(root, state, input, 2);
		expect(retried.path).not.toBe(prepared.path);
		expect(retried.journalPath).not.toBe(prepared.journalPath);
		await expect(prepareWorkspace(root, state, input, 2)).rejects.toThrow("already accepted");
		await release();
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

/** A checkout of octo-org/score whose commit is the run's source, as `prepareWorkspace` is given it. */
async function scoreCheckout() {
	let root = await mkdtemp(join(tmpdir(), "chopin-hardened-root-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-hardened-state-"));
	git(root, "init");
	git(root, "config", "user.name", "Fixture");
	git(root, "config", "user.email", "fixture@example.test");
	git(root, "remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "file.txt"), "base");
	git(root, "add", ".");
	git(root, "commit", "-m", "base");
	let source = {
		repositoryId: "R_1",
		repository: "octo-org/score",
		commit: git(root, "rev-parse", "HEAD"),
	};
	return { root, state, source };
}

test("a run whose commit can't be fetched fails naming the commit, branch and repository", async () => {
	let { root, state, source } = await scoreCheckout();
	try {
		let missing = { ...source, commit: "f".repeat(40), branch: "plans/one" };
		// GitHub is sent to a local path, which the connector's git never fetches from: no network.
		let env = {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: `url.${join(state, "nowhere")}.insteadOf`,
			GIT_CONFIG_VALUE_0: "https://github.com/",
		};
		await expect(prepareWorkspace(root, state, { id: "f1", source: missing }, 1, undefined, env))
			.rejects.toThrow(
				`Couldn't fetch commit ${
					"f".repeat(40)
				} (plans/one) of octo-org/score to start from (fatal:`,
			);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("a run isn't started in a checkout whose git directory an agent gave a commondir: it is removed, and the run goes on once it is asked again", async () => {
	let { root, state, source } = await scoreCheckout();
	try {
		let planted = join(root, ".git", "commondir");
		writeFileSyncNow(planted, `${join(state, "elsewhere")}\n`);
		await expect(prepareWorkspace(root, state, { id: "r1", source })).rejects.toThrow(
			`an agent had made ${planted}`,
		);
		expect(existsSync(planted)).toBe(false);
		// Nothing of the refused run was begun, so the same run is accepted when it is sent again.
		expect(existsSync(join(state, "runs", "r1.json"))).toBe(false);
		let prepared = await prepareWorkspace(root, state, { id: "r1", source });
		expect(prepared.commit).toBe(source.commit);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("replaces a lock left by a connector whose process is gone, and keeps a live one", async () => {
	let state = await mkdtemp(join(tmpdir(), "chopin-state-"));
	try {
		let root = "/fixture/checkout";
		let release = await lockWorkspace(root, state);
		let [lock] = (await readdir(state)).filter(name => name.endsWith(".lock"));
		let path = join(state, lock);
		await release();

		// A live process, even when it is not this one, still holds the workspace.
		await writeFile(path, JSON.stringify({ pid: process.ppid, root }));
		await expect(lockWorkspace(root, state)).rejects.toThrow("already locked");

		// An exited process's lock is stale.
		let child = Bun.spawn(["true"]);
		await child.exited;
		await writeFile(path, JSON.stringify({ pid: child.pid, root }));
		let replaced = await lockWorkspace(root, state);
		expect(JSON.parse(await readFile(path, "utf8")).pid).toBe(process.pid);
		await replaced();

		// A lock that does not name a process is left for a person to check.
		await writeFile(path, "");
		await expect(lockWorkspace(root, state)).rejects.toThrow("already locked");
	} finally {
		await rm(state, { recursive: true, force: true });
	}
});

test("a lock whose pid now belongs to another process is stale, and can be replaced", async () => {
	let state = await mkdtemp(join(tmpdir(), "chopin-state-"));
	try {
		let root = "/fixture/reused";
		let release = await lockWorkspace(root, state);
		let lock = (await readdir(state)).find(name => name.endsWith(".lock"));
		let path = join(state, lock!);
		// The lock records when the process holding it started.
		let recorded = JSON.parse(await readFile(path, "utf8")).processStart;
		expect(recorded).toBe((await processStart()(process.pid))!.id);
		expect((await connectors(state)).map(item => item.running)).toEqual([true]);
		await release();

		// The pid is this process's now, but the connector that wrote the lock started at another
		// time: that connector is gone.
		await writeFile(path, JSON.stringify({ pid: process.pid, root, processStart: "1" }));
		expect((await connectors(state)).map(item => item.running)).toEqual([false]);
		let replaced = await lockWorkspace(root, state);
		expect(JSON.parse(await readFile(path, "utf8")).processStart).toBe(recorded);
		await replaced();

		// A lock without a start time is stale once it is older than its pid's process.
		await writeFile(path, JSON.stringify({ pid: process.pid, root, started: 1 }));
		expect((await connectors(state)).map(item => item.running)).toEqual([false]);
		await writeFile(path, JSON.stringify({ pid: process.pid, root, started: Date.now() }));
		expect((await connectors(state)).map(item => item.running)).toEqual([true]);
	} finally {
		await rm(state, { recursive: true, force: true });
	}
});

test("on macOS and Windows a process's start time is read through the runner", async () => {
	let at = Date.UTC(2026, 9, 13, 9, 30, 5);
	let filetime = String((BigInt(at) + 11644473600000n) * 10000n);
	let calls: string[] = [];
	let answer = "";
	let run = async (command: string, args: string[]) => {
		calls.push([command, ...args].join(" "));
		return { code: 0, stdout: answer, stderr: "" };
	};
	answer = "Tue Oct 13 09:30:05 2026\n";
	expect(await processStart("darwin", run)(4242)).toEqual({
		id: "Tue Oct 13 09:30:05 2026",
		at,
	});
	// The same answer whatever the locale or time zone of the process that asks.
	expect(calls.at(-1)).toBe("/usr/bin/env -i LC_ALL=C TZ=UTC /bin/ps -o lstart= -p 4242");
	answer = `${filetime}\r\n`;
	expect(await processStart("win32", run)(4242)).toEqual({ id: filetime, at });
	expect(calls.at(-1)).toContain("powershell.exe -NoProfile -NonInteractive -Command ");
	expect(calls.at(-1)).toContain("Get-Process -Id 4242");
	// No answer, as for a process that is gone, is no start time.
	answer = "";
	expect(await processStart("darwin", run)(4242)).toBeUndefined();
	expect(await processStart("win32", run)(4242)).toBeUndefined();

	// connectors() asks through the same runner: a different start time is a stale lock.
	let state = await mkdtemp(join(tmpdir(), "chopin-state-"));
	try {
		let lock = join(state, `${"c".repeat(64)}.lock`);
		await writeFile(
			lock,
			JSON.stringify({ pid: process.pid, root: "/r", processStart: "Mon Oct 12 08:00:00 2026" }),
		);
		answer = "Tue Oct 13 09:30:05 2026\n";
		let probe = processStart("darwin", run);
		expect((await connectors(state, probe)).map(item => item.running)).toEqual([false]);
		answer = "Mon Oct 12 08:00:00 2026\n";
		expect((await connectors(state, probe)).map(item => item.running)).toEqual([true]);
	} finally {
		await rm(state, { recursive: true, force: true });
	}
});

test("lists the connectors running for a state directory, and those whose process is gone", async () => {
	let state = await mkdtemp(join(tmpdir(), "chopin-state-"));
	try {
		expect(await connectors(join(state, "missing"))).toEqual([]);
		let planners = ["https://chopin.example/d/one"];
		let release = await lockWorkspace("/fixture/served", state, { service: true, planners });
		let child = Bun.spawn(["true"]);
		await child.exited;
		await writeFile(
			join(state, `${"a".repeat(64)}.lock`),
			JSON.stringify({ pid: child.pid, root: "/fixture/crashed" }),
		);
		// machine.json's own lock and a lock still being written are not connectors.
		await writeFile(join(state, "machine.json.lock"), JSON.stringify({ pid: process.pid }));
		await writeFile(join(state, `${"b".repeat(64)}.lock`), "");
		let listed = await connectors(state);
		expect(listed.sort((a, b) => (a.root ?? "").localeCompare(b.root ?? ""))).toEqual([
			{ pid: child.pid, root: "/fixture/crashed", running: false, service: false },
			{
				pid: process.pid,
				root: "/fixture/served",
				running: true,
				service: true,
				planners,
				version: VERSION,
				protocol: CONNECTOR_PROTOCOL,
				started: expect.any(Number),
			},
		]);
		await release();
	} finally {
		await rm(state, { recursive: true, force: true });
	}
});

test("retention keeps the most recent finished runs, never one running or queued, nor a Planner's folder, and removes an earlier release's worktrees", async () => {
	let root = await mkdtemp(join(tmpdir(), "chopin-keep-root-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-keep-state-"));
	try {
		git(root, "init");
		git(root, "config", "user.name", "Fixture");
		git(root, "config", "user.email", "fixture@example.test");
		git(root, "remote", "add", "origin", "https://github.com/octo-org/score.git");
		await writeFile(join(root, "file.txt"), "base");
		git(root, "add", ".");
		git(root, "commit", "-m", "base");
		let commit = git(root, "rev-parse", "HEAD");
		let source = { repositoryId: "R_1", repository: "octo-org/score", commit };
		let prepare = (id: string) => prepareWorkspace(root, state, { id, source });
		let runs = join(state, "runs");

		// A run of an earlier release, which worked in a worktree on the host, and a connector that
		// crashed mid-run left unfinished.
		let crashed = await prepare("crashed");
		git(root, "worktree", "add", "--detach", crashed.path, commit);
		let gone = Bun.spawn(["true"]);
		await gone.exited;
		let journal = JSON.parse(await readFile(crashed.journalPath, "utf8"));
		await writeFile(crashed.journalPath, JSON.stringify({ ...journal, pid: gone.pid }));
		// Its GitHub token, in its folder of tokens, which a run that ended would have deleted.
		await mkdir(join(runs, "crashed.tokens"));
		await writeFile(join(runs, "crashed.tokens", "github"), "ghu_left\n", { mode: 0o600 });
		// This connector's run in progress, then one it accepted but has yet to start.
		await prepare("running");
		await writeFile(
			join(runs, "queued.json"),
			JSON.stringify({
				id: "queued",
				state: "accepted",
				pid: process.pid,
				processStart: (await processStart()(process.pid))!.id,
			}),
		);
		for (let id of ["a", "b", "c", "d"]) {
			await endWorkspace(await prepare(id));
			await mkdir(join(runs, `${id}.tokens`));
			await Bun.sleep(5);
		}
		let planner = join(state, "planners", "octo-org", "score", "D_1");
		await mkdir(planner, { recursive: true });
		await writeFile(`${planner}.disk`, "the Planner's disk");

		// 0 keeps every run.
		expect(await pruneRuns(state, 0)).toEqual([]);
		expect((await pruneRuns(state, 2)).sort()).toEqual(["a", "b", "crashed"]);
		expect((await readdir(runs)).sort()).toEqual([
			"c.json",
			"c.tokens",
			"d.json",
			"d.tokens",
			"queued.json",
			"running.json",
		]);
		// The earlier release's worktree is gone, and git no longer lists it.
		let listed = git(root, "worktree", "list", "--porcelain").split("\n")
			.filter(line => line.startsWith("worktree "));
		expect(listed).toHaveLength(1);
		expect(existsSync(`${planner}.disk`)).toBe(true);
		// The oldest kept goes next; the run in progress never does.
		expect(await pruneRuns(state, 1)).toEqual(["c"]);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});
