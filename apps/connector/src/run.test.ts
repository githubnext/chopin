import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWork } from "./run";
import { git } from "./workspace";
import type { remote } from "./mcp";

/** Run one implementation claim against a fixture repository and record connector calls. */
async function run(
	build: { kind?: "rebuild"; live?: boolean },
	flags: string[],
	respond: (name: string) => unknown = () => ({}),
) {
	let root = await mkdtemp(join(tmpdir(), "chopin-rebuild-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-rebuild-state-"));
	try {
		git(root, "init");
		git(root, "config", "user.name", "Fixture");
		git(root, "config", "user.email", "fixture@example.test");
		git(root, "remote", "add", "origin", "git@github.com:org/repo.git");
		await writeFile(join(root, "source.txt"), "committed");
		git(root, "add", ".");
		git(root, "commit", "-m", "fixture");
		let calls: Array<[string, Record<string, unknown>]> = [];
		let api = {
			call: async (name: string, args: Record<string, unknown> = {}) => {
				calls.push([name, args]);
				return respond(name);
			},
		} as unknown as Awaited<ReturnType<typeof remote>>;
		let id = crypto.randomUUID();
		await runWork(api, "implementation", {
			build: {
				id,
				...(build.kind ? { kind: build.kind } : {}),
				repositoryId: "R_repo",
				checkout: { repository: "org/repo", commit: git(root, "rev-parse", "HEAD") },
			},
			live: build.live,
			runToken: "token",
		}, {
			root,
			directory: state,
			command: [
				process.execPath,
				new URL("./testing/fake-implementer.ts", import.meta.url).pathname,
				...flags,
			],
			url: "http://127.0.0.1:1",
			script: "unused",
			signal: new AbortController().signal,
			heartbeatMs: 20,
		});
		return { id, calls, branches: git(root, "branch", "--list", "chopin/*") };
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
}

test("a rebuild runs on a detached worktree with the rebuild prompt", async () => {
	let { id, calls, branches } = await run({ kind: "rebuild" }, ["--rebuild"]);
	expect(calls.filter(([name]) => name !== "renew_implementation_build")).toEqual([
		["report_implementation_build", {
			id,
			state: "running",
			session: "implementation-acp-session",
		}],
		["report_implementation_build", { id, state: "stopped" }],
	]);
	expect(branches).toBe("");
});

test("a rebuild whose report landed stops renewing and exits cleanly", async () => {
	let { id, calls } = await run(
		{ kind: "rebuild" },
		["--rebuild", "--slow"],
		name => name === "renew_implementation_build" ? { accepted: true, state: "stopped" } : {},
	);
	expect(calls.filter(([name]) => name === "renew_implementation_build")).toHaveLength(1);
	expect(calls.at(-1)).toEqual(["report_implementation_build", { id, state: "stopped" }]);
});

test("a living document's first build gets a prompt without verification or revision", async () => {
	let { id, calls } = await run({ live: true }, ["--live"]);
	expect(calls.filter(([name]) => name !== "renew_implementation_build").at(-1)).toEqual([
		"report_implementation_build",
		{ id, state: "stopped" },
	]);
});
