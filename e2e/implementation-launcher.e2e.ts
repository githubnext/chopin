import { content, expect, test } from "./room";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./servers";
import type { Graph } from "../apps/server/src/tasks/graphs";

function preparedGraph(): Graph {
	return {
		versions: [{
			number: 1,
			revision: 1,
			planRevision: 0,
			state: "draft",
			definition: {
				tasks: [{
					id: "connect",
					title: "Connect the local agent",
					context: "An isolated tracer.",
					goal: "Read the approved graph and report a task blocker through MCP.",
					acceptance: ["The agent can read the graph.", "Its blocker appears in Chopin."],
					dependsOn: [],
				}, {
					id: "review",
					title: "Review the connection",
					context: "Wait for the connection.",
					goal: "Verify progress survives refresh.",
					acceptance: ["The progress persists.", "The dependency is visible."],
					dependsOn: ["connect"],
				}],
			},
		}],
	};
}

async function connector(baseURL: string, command: string[]) {
	let root = await mkdtemp(join(tmpdir(), "chopin-implementation-checkout-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-implementation-state-"));
	let git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
	git("init", "-b", "main");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.test");
	git("remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "sample.txt"), "committed source");
	git("add", ".");
	git("commit", "-m", "fixture");
	await writeFile(join(root, "sample.txt"), "uncommitted local edit");
	let child = spawn("bun", [
		join(ROOT, "apps/connector/src/main.ts"),
		"connect",
		root,
		"--",
		...command,
	], {
		cwd: ROOT,
		env: { ...process.env, CHOPIN_URL: baseURL, CHOPIN_CONNECTOR_STATE_DIR: state },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	let pairing = new Promise<string>((resolve, reject) => {
		let timer = setTimeout(() => reject(new Error(`Pairing timed out: ${output}`)), 15_000);
		child.stderr.on("data", chunk => {
			output += String(chunk);
			let match = output.match(/http:\/\/[^\s]+\/connect\?pairing=[\w-]+/);
			if (match) {
				clearTimeout(timer);
				resolve(match[0]);
			}
		});
		child.once("error", reject);
		child.once("exit", code => {
			clearTimeout(timer);
			reject(new Error(`Connector exited ${code}: ${output}`));
		});
	});
	return {
		pairing,
		output: () => output,
		localEdit: () => readFile(join(root, "sample.txt"), "utf8"),
		close: async () => {
			child.kill("SIGINT");
			await new Promise<void>(resolve => {
				if (child.exitCode !== null) return resolve();
				let timer = setTimeout(() => {
					child.kill("SIGKILL");
					resolve();
				}, 5000);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		},
	};
}

for (let mode of ["block", "complete", "live"] as const) {
	test(`the paired ACP connector implements a browser plan (${mode})`, async ({ seed, join: enter, room, baseURL }) => {
		test.skip(
			mode === "live" && !process.env.CHOPIN_TEST_ACP_COMMAND,
			"Opt-in ACP credentials and model usage",
		);
		test.setTimeout(mode === "live" ? 180_000 : 60_000);
		let graph = preparedGraph();
		if (mode === "live") {
			graph.versions[0].definition.tasks[0].context =
				"Connectivity tracer only: start this task through MCP, then block it with reason exactly Choose the next tracer and stop. Do not edit files, run checks or create PRs. The human must choose further work.";
		}
		await seed("# Local implementation tracer\n\nValidate the local agent connection.\n", {
			graph,
		});
		let local = await connector(
			baseURL!,
			mode === "live"
				? JSON.parse(process.env.CHOPIN_TEST_ACP_COMMAND!)
				: [
					"bun",
					join(ROOT, "apps/connector/src/testing/fake-implementer.ts"),
					...(mode === "complete" ? ["--complete", "--http"] : []),
				],
		);
		try {
			let page = await enter("ana");
			await page.goto(await local.pairing);
			await page.getByRole("combobox", { name: "Document", exact: true }).selectOption(room);
			await page.getByRole("button", { name: "Connect", exact: true }).click();
			await page.getByRole("link", { name: "Open document", exact: true }).click();
			let panel = page.getByRole("region", { name: "Implementation", exact: true });
			let build = panel.getByRole("button", { name: "Approve and build this plan", exact: true });
			await expect(build).toBeEnabled();
			await build.click();
			await expect.poll(async () => {
				let snapshot = await (await page.request.get(`/api/channels/${room}/implementation`))
					.json();
				return snapshot.build?.state;
			}, { timeout: mode === "live" ? 150_000 : 30_000 }).toMatch(/^(failed|stopped)$/);
			let snapshot = await (await page.request.get(`/api/channels/${room}/implementation`)).json();
			expect(snapshot.build.state, local.output()).toBe("stopped");
			expect(snapshot.build.session).toBeTruthy();
			if (mode === "complete") {
				await expect(panel).toContainText("Implementation complete");
				await expect(panel.getByRole("link", { name: "Open pull request", exact: true }))
					.toHaveCount(2);
				await expect(panel).toContainText("2 of 2 tasks complete");
			} else {
				await expect(panel).toContainText("Blocked: Choose the next tracer");
				await expect(panel).toContainText("Needs attention");
				await expect(content(page)).toHaveAttribute("contenteditable", "false");
			}
			await expect(panel).toContainText("After Connect the local agent");
			expect(await local.localEdit()).toBe("uncommitted local edit");
			await page.reload();
			await expect(panel).toContainText(
				mode === "complete" ? "Implementation complete" : "Blocked: Choose the next tracer",
			);
			if (
				process.env.CHOPIN_LAUNCHER_SCREENSHOT
				&& mode === (process.env.CHOPIN_TEST_ACP_COMMAND ? "live" : "block")
			) {
				await panel.screenshot({ path: process.env.CHOPIN_LAUNCHER_SCREENSHOT });
			}
		} finally {
			await local.close();
		}
	});
}
