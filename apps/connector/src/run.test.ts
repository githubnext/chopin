import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWork } from "./run";
import { git } from "./workspace";
import type { remote } from "./mcp";

test("a rebuild runs on a detached worktree with the rebuild prompt", async () => {
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
				return {};
			},
		} as unknown as Awaited<ReturnType<typeof remote>>;
		let id = crypto.randomUUID();
		await runWork(api, "implementation", {
			build: {
				id,
				kind: "rebuild",
				repositoryId: "R_repo",
				checkout: { repository: "org/repo", commit: git(root, "rev-parse", "HEAD") },
			},
			runToken: "token",
		}, {
			root,
			directory: state,
			command: [
				process.execPath,
				new URL("./testing/fake-implementer.ts", import.meta.url).pathname,
				"--rebuild",
			],
			url: "http://127.0.0.1:1",
			script: "unused",
			signal: new AbortController().signal,
		});
		expect(calls).toEqual([
			["report_implementation_build", {
				id,
				state: "running",
				session: "implementation-acp-session",
			}],
			["report_implementation_build", { id, state: "stopped" }],
		]);
		expect(git(root, "branch", "--list", "chopin/*")).toBe("");
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});
