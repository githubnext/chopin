import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./room";
import { ROOT } from "./servers";

for (let transport of ["stdio", "http"] as const) {
	test(`the connector executes an ACP turn and publishes through ${transport} MCP`, async ({ baseURL, join: enter, room, seed }) => {
		await seed("# Local investigation\n\nInspect startup evidence.\n");
		let root = await mkdtemp(join(tmpdir(), "chopin-connector-e2e-"));
		let state = await mkdtemp(join(tmpdir(), "chopin-connector-state-"));
		let git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
		git("init");
		git("config", "user.name", "Fixture");
		git("config", "user.email", "fixture@example.test");
		git("remote", "add", "origin", "https://github.com/octo-org/score.git");
		await writeFile(join(root, "sample.txt"), "sample");
		git("add", ".");
		git("commit", "-m", "fixture");
		let connector = spawn("bun", [
			join(ROOT, "apps/connector/src/main.ts"),
			"connect",
			root,
			"--",
			"bun",
			join(ROOT, "apps/connector/src/testing/fake-agent.ts"),
			...(transport === "http" ? ["--http"] : []),
		], {
			cwd: ROOT,
			env: { ...process.env, CHOPIN_URL: baseURL, CHOPIN_CONNECTOR_STATE_DIR: state },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let pairing = new Promise<string>((resolve, reject) => {
			let timeout = setTimeout(
				() => reject(new Error(`Connector did not offer pairing: ${output}`)),
				15_000,
			);
			connector.stderr.on("data", chunk => {
				output += String(chunk);
				let match = output.match(/http:\/\/[^\s]+\/connect\?pairing=[\w-]+/);
				if (match) {
					clearTimeout(timeout);
					resolve(match[0]);
				}
			});
			connector.once("error", reject);
			connector.once("exit", code => {
				clearTimeout(timeout);
				reject(new Error(`Connector exited ${code}: ${output}`));
			});
		});
		try {
			let page = await enter("ana");
			await page.goto(await pairing);
			await page.getByRole("combobox", { name: "Document", exact: true }).selectOption(room);
			await page.getByRole("button", { name: "Connect", exact: true }).click();
			await page.getByRole("link", { name: "Open document", exact: true }).click();
			await page.getByRole("button", { name: "Investigations", exact: true }).click();
			await page.getByRole("textbox", { name: "Investigation brief", exact: true }).fill(
				"Produce the captured startup fixture",
			);
			await page.getByRole("button", { name: "Propose investigation", exact: true }).click();
			await page.getByRole("button", { name: "Run on my workspace", exact: true }).click();
			await expect(page.getByRole("table", { name: "Median startup time", exact: true }))
				.toContainText("183", { timeout: 30_000 });
			expect(output).toContain("Running");
		} finally {
			connector.kill("SIGINT");
			await new Promise<void>(resolve => {
				if (connector.exitCode !== null) return resolve();
				let timer = setTimeout(() => {
					connector.kill("SIGKILL");
					resolve();
				}, 5000);
				connector.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		}
	});
}
