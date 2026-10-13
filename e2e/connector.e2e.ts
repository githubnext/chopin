import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { authenticate, content, expect, test } from "./room";
import { ROOT } from "./servers";
import { testChannelPath } from "./database";

/** A connection serves every document in its repository, so each pairing test is its own person. */
function person() {
	return `ana-${crypto.randomUUID().slice(0, 8)}`;
}

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
		// The stdio run uses the bundle people download, run from the checkout like the UI command;
		// its MCP bridge re-executes that file. The HTTP run keeps the contributor source path.
		let script = join(ROOT, "apps/connector/src/main.ts");
		if (transport === "stdio") {
			let download = await fetch(new URL("/connector.js", baseURL));
			expect(download.headers.get("content-type")).toContain("text/javascript");
			script = join(state, "connector.js");
			await writeFile(script, await download.text());
		}
		let connector = spawn("bun", [
			script,
			"connect",
			transport === "stdio" ? "." : root,
			"--",
			"bun",
			join(ROOT, "apps/connector/src/testing/fake-agent.ts"),
			...(transport === "http" ? ["--http"] : []),
		], {
			cwd: transport === "stdio" ? root : ROOT,
			env: { ...process.env, CHOPIN_URL: baseURL, CHOPIN_CONNECTOR_STATE_DIR: state },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let pairing = new Promise<string>((resolve, reject) => {
			let timeout = setTimeout(
				() => reject(new Error(`Connector did not offer pairing: ${output}`)),
				15_000,
			);
			let read = (chunk: Buffer) => {
				output += String(chunk);
				let match = output.match(/http:\/\/[^\s]+\/connect\?pairing=[\w-]+/);
				if (match) {
					clearTimeout(timeout);
					resolve(match[0]);
				}
			};
			// Pairing instructions are on stdout; failures and agent output on stderr.
			connector.stdout.on("data", read);
			connector.stderr.on("data", read);
			connector.once("error", reject);
			connector.once("exit", code => {
				clearTimeout(timeout);
				reject(new Error(`Connector exited ${code}: ${output}`));
			});
		});
		try {
			let page = await enter(person());
			await page.goto(await pairing);
			let printed = () => output.match(/Check the page shows:\s+([A-Z2-9]{4}-[A-Z2-9]{4})/)?.[1];
			await expect.poll(printed).toBeTruthy();
			let code = printed();
			await expect(page.getByText(code!, { exact: true })).toBeVisible();
			await page.getByRole("button", { name: "Connect", exact: true }).click();
			await expect(page.getByRole("status")).toHaveText("Connected.");
			await page.goto(testChannelPath(room));
			await content(page).click();
			await page.keyboard.press("ControlOrMeta+End");
			await page.keyboard.press("Enter");
			await page.keyboard.type("/investigate");
			await page.getByRole("listbox", { name: "Insert block" })
				.getByRole("option", { name: "Investigate", exact: true })
				.click();
			await page.getByRole("textbox", { name: "Investigation brief", exact: true }).fill(
				"Produce the captured startup fixture",
			);
			await page.getByRole("button", { name: "Propose investigation", exact: true }).click();
			await page.getByRole("article", { name: "Investigation", exact: true })
				.getByRole("button", { name: "Run", exact: true })
				.click();
			// The published result opens as a child document; repeated runs number its title.
			await expect(page.getByRole("button", { name: /^Open Startup comparison/ }))
				.toBeVisible({ timeout: 30_000 });
			expect(output).toContain("› Investigating Produce the captured startup fixture");
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
			expect(connector.exitCode, output).toBe(0);
		}
	});
}

/** Start `connect` for a checkout and collect its output until it exits. */
function start(baseURL: string, root: string, state: string) {
	let child = spawn("bun", [
		join(ROOT, "apps/connector/src/main.ts"),
		"connect",
		root,
		"--",
		"bun",
		join(ROOT, "apps/connector/src/testing/fake-agent.ts"),
	], {
		cwd: ROOT,
		env: { ...process.env, CHOPIN_URL: baseURL, CHOPIN_CONNECTOR_STATE_DIR: state },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", chunk => output += String(chunk));
	child.stderr.on("data", chunk => output += String(chunk));
	let exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
	return { child, output: () => output, exited };
}

test("a paired machine reconnects without pairing, until it is disconnected in the browser", async ({ baseURL, join: enter }) => {
	let root = await mkdtemp(join(tmpdir(), "chopin-machine-e2e-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-machine-state-"));
	let git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
	git("init");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.test");
	git("remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "sample.txt"), "sample");
	git("add", ".");
	git("commit", "-m", "fixture");
	let first = start(baseURL!, root, state);
	let second: ReturnType<typeof start> | undefined;
	try {
		await expect.poll(() => first.output().match(/http:\/\/[^\s]+\/connect\?pairing=[\w-]+/))
			.toBeTruthy();
		let handle = person();
		let page = await enter(handle);
		// Connect goes through the machine's own GitHub authorization and back.
		await page.goto(first.output().match(/http:\/\/[^\s]+\/connect\?pairing=[\w-]+/)![0]);
		await expect(
			page.getByRole("checkbox", {
				name: "Let Chopin build and prototype automatically on this machine",
				exact: true,
			}),
		).not.toBeChecked();
		await page.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(page.getByRole("status")).toHaveText("Connected.");
		await expect.poll(first.output).toContain("✓ Connected.");
		first.child.kill("SIGINT");
		expect(await first.exited, first.output()).toBe(0);

		// Signing out of the browser does not end the machine; it reconnects without pairing.
		await page.request.post("/auth/logout", { headers: { origin: new URL(baseURL!).origin } });
		second = start(baseURL!, root, state);
		await expect.poll(second.output, { timeout: 15_000 }).toContain("✓ Connected.");
		expect(second.output()).not.toContain("/connect?pairing=");

		await authenticate(page, handle, baseURL!);
		await page.goto("/connect");
		await expect(page.getByRole("heading", { name: "Your machines", exact: true })).toHaveCount(1);
		let machines = page.getByRole("table", { name: "Your machines" });
		await expect(machines.getByText(hostname(), { exact: true })).toBeVisible();
		await expect(machines).toContainText("Connected");
		// Disconnecting is in the machine's menu and asks first, naming the machine; cancelling keeps
		// it connected.
		let disconnect = async () => {
			await machines.getByRole("button", { name: `Actions for ${hostname()}`, exact: true })
				.click();
			await page.getByRole("menuitem", { name: "Disconnect machine", exact: true }).click();
		};
		let confirm = page.getByRole("dialog", { name: `Disconnect ${hostname()}?`, exact: true });
		await disconnect();
		await expect(confirm).toContainText(`The connector on ${hostname()} stops`);
		await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(confirm).toHaveCount(0);
		await expect(machines).toContainText("Connected");
		expect(second.child.exitCode).toBeNull();
		await disconnect();
		await confirm.getByRole("button", { name: "Disconnect machine", exact: true }).click();
		await expect(machines).toHaveCount(0);
		await expect(page.getByText("Waiting for your machine…", { exact: true })).toBeVisible();
		expect(await second.exited, second.output()).toBe(1);
		expect(second.output()).toContain("no longer paired");
		// The refused token is forgotten, so the next connect pairs again.
		expect(JSON.parse(await readFile(join(state, "machine.json"), "utf8"))).toEqual({
			servers: {},
		});
		for (let secret of second.output().match(/chopin_m_[\w-]+/g) ?? []) {
			throw new Error(`The connector printed its machine token: ${secret.slice(0, 12)}…`);
		}
	} finally {
		first.child.kill("SIGKILL");
		second?.child.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});
