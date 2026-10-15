import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectorError } from "./mcp";
import { createOutput } from "./output";
import { checkouts } from "./checkouts";
import { runWork } from "./run";
import { git, prepareWorkspace } from "./workspace";

test("an authorized retry starts despite an older receipt and reports why its agent submitted no result", async () => {
	let root = await mkdtemp(join(tmpdir(), "chopin-missing-result-"));
	let directory = await mkdtemp(join(tmpdir(), "chopin-missing-result-state-"));
	try {
		git(root, "init");
		git(root, "config", "user.name", "Fixture");
		git(root, "config", "user.email", "fixture@example.test");
		git(root, "remote", "add", "origin", "git@github.com:org/repo.git");
		await writeFile(join(root, "source.txt"), "committed");
		git(root, "add", ".");
		git(root, "commit", "-m", "fixture");
		let id = crypto.randomUUID();
		let source = {
			repositoryId: "R_repo",
			repository: "org/repo",
			commit: git(root, "rev-parse", "HEAD"),
		};
		await prepareWorkspace(root, directory, { id, source });
		let calls: Array<[string, Record<string, unknown>]> = [];
		let terminal = "";
		let output = createOutput(
			{ write: () => {} },
			{ write: text => terminal += text },
			{},
		);
		await runWork(
			{
				async call(name, args = {}) {
					calls.push([name, args]);
					if (name === "complete_experiment") {
						throw new ConnectorError("missing-result", "missing-result: missing-result");
					}
					return {};
				},
			},
			"experiment",
			{
				input: {
					id,
					documentId: crypto.randomUUID(),
					brief: "Prototype a header",
					source,
					context: "",
					requester: "alice",
					authorizer: "alice",
				},
				generation: 2,
				runToken: "run-token",
			},
			{
				checkouts: checkouts({ directory, registered: { "org/repo": root } }),
				directory,
				command: [
					process.execPath,
					new URL("./testing/fake-agent.ts", import.meta.url).pathname,
					"--no-result",
				],
				url: "http://127.0.0.1:1",
				signal: new AbortController().signal,
				output,
			},
		);
		let reported = calls.find(([name]) => name === "fail_experiment")?.[1];
		expect(reported).toMatchObject({ id, generation: 2 });
		expect(reported?.error).toContain("The Chopin MCP tools are unavailable in this session.");
		expect(terminal).toContain("The Chopin MCP tools are unavailable in this session.");
		expect(terminal).not.toContain("missing-result: missing-result");
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(directory, { recursive: true, force: true });
	}
});
