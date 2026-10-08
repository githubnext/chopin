import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, lockWorkspace, prepareWorkspace, workspace } from "./workspace";

test("isolates exact source without stashing dirty work and never executes an accepted run twice", async () => {
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
		expect(await readFile(join(prepared.path, "source.txt"), "utf8")).toBe("committed");
		expect(await readFile(join(root, "source.txt"), "utf8")).toBe("user work");
		await expect(prepareWorkspace(root, state, input)).rejects.toThrow("already accepted");
		await release();
		git(root, "worktree", "remove", prepared.path);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});
