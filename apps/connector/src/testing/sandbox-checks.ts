import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** What the checks are told, as JSON in SANDBOX_CHECKS: the places they try and the hosts they reach. */
export type CheckPlan = {
	/** A file of the repository, read from the working directory. */
	repoFile: string;
	/** Paths a sandboxed process must not be able to write. */
	notWritable: string[];
	/** Paths it may write only in the sandbox's own memory, where the host never sees the file. */
	notPersisted?: string[];
	/** Files and directories it must not be able to read. */
	notReadable: string[];
	/** An environment variable it must still see, and its value: credentials are not hidden. */
	visible: [string, string];
	/** A bare repository it may push to, a path it was granted. */
	remote: string;
	/** Chopin's origin, which it may reach. */
	chopin: string;
	/** A host that is not on the allow list. */
	offList: string;
	/** A host the owner added to the allow list. */
	extra?: string;
	/** GitHub, when the machine running the test can reach it itself. */
	github?: string;
	/** Where it may write a new git worktree of the repository, when it is a Planner. */
	worktree?: string;
};

export type CheckResult = Record<string, { ok: boolean; detail?: string }>;

function attempt(run: () => unknown): { ok: boolean; detail?: string } {
	try {
		run();
		return { ok: true };
	} catch (error) {
		return { ok: false, detail: (error as NodeJS.ErrnoException).code ?? String(error) };
	}
}

async function reach(url: string) {
	try {
		let response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		return { ok: true, detail: String(response.status) };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

function git(cwd: string, ...args: string[]) {
	let result = spawnSync("git", [
		"-c",
		"user.name=sandbox",
		"-c",
		"user.email=sandbox@example.test",
		"-c",
		"commit.gpgsign=false",
		...args,
	], { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

/**
 * What a process in the sandbox can and can't do, tried from inside it. It runs in an agent and in
 * a Planner backend alike, from the working directory it was given.
 */
export async function sandboxChecks(plan: CheckPlan, cwd = process.cwd()): Promise<CheckResult> {
	let result: CheckResult = {};
	result.readRepository = attempt(() => {
		if (!readFileSync(join(cwd, plan.repoFile), "utf8").length) throw new Error("empty");
	});
	result.writeWorktree = attempt(() => writeFileSync(join(cwd, "written-in-sandbox.txt"), "ok"));
	result.writeTemporary = attempt(() =>
		writeFileSync(join(process.env.TMPDIR ?? "/nonexistent", "private.txt"), "ok")
	);
	for (let [index, path] of plan.notWritable.entries()) {
		let wrote = attempt(() => writeFileSync(path, "escaped"));
		result[`cannotWrite${index}`] = { ok: !wrote.ok, detail: wrote.ok ? "written" : wrote.detail };
	}
	for (let path of plan.notPersisted ?? []) attempt(() => writeFileSync(path, "escaped"));
	for (let [index, path] of plan.notReadable.entries()) {
		// A masked directory lists nothing and a masked file can't be read: neither gives a secret.
		result[`cannotRead${index}`] = (() => {
			try {
				let entries = readdirSync(path);
				return entries.length
					? { ok: false, detail: `lists ${entries.join(",")}` }
					: { ok: true };
			} catch { /* Not a readable directory; it may still be a readable file. */ }
			try {
				return readFileSync(path, "utf8").length ? { ok: false, detail: "reads" } : { ok: true };
			} catch {
				return { ok: true };
			}
		})();
	}
	result.environment = {
		ok: process.env[plan.visible[0]] === plan.visible[1],
		detail: process.env[plan.visible[0]],
	};
	result.commitAndPush = attempt(() => {
		git(cwd, "add", "written-in-sandbox.txt");
		git(cwd, "commit", "-m", "committed in the sandbox");
		git(cwd, "push", plan.remote, "HEAD:refs/heads/sandboxed");
	});
	if (plan.worktree) {
		let worktree = plan.worktree;
		result.ownWorktree = attempt(() => {
			git(cwd, "worktree", "add", "--detach", worktree);
			writeFileSync(join(worktree, "planner.txt"), "ok");
		});
	}
	result.chopin = await reach(plan.chopin);
	let off = await reach(plan.offList);
	result.offList = { ok: !off.ok, detail: off.detail };
	if (plan.extra) result.extraHost = await reach(plan.extra);
	if (plan.github) result.github = await reach(plan.github);
	return result;
}

export function planFromEnvironment(): CheckPlan {
	return JSON.parse(process.env.SANDBOX_CHECKS!) as CheckPlan;
}

/** Write the results where the test reads them, which the process was given to write. */
export function report(path: string, result: CheckResult) {
	mkdirSync(join(path, ".."), { recursive: true });
	appendFileSync(path, JSON.stringify(result) + "\n");
}
