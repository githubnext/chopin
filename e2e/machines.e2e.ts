import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "./room";
import { ROOT } from "./servers";

import type { Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const PAIRING = /http:\/\/[^\s]+\/connect\?pairing=[\w-]+/;

/** Each test pairs for its own person, so their machine lists start empty. */
function person() {
	return `mia-${crypto.randomUUID().slice(0, 8)}`;
}

function machinesEntry(page: Page, name: string) {
	return page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name, exact: true });
}

/** A checkout of octo-org/score and `chopin connect` running in it, from source. */
async function connector(baseURL: string) {
	let root = await mkdtemp(join(tmpdir(), "chopin-machines-e2e-"));
	let state = await mkdtemp(join(tmpdir(), "chopin-machines-state-"));
	let git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
	git("init");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.test");
	git("remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "sample.txt"), "sample");
	git("add", ".");
	git("commit", "-m", "fixture");
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
	return {
		output: () => output,
		async stop() {
			child.kill("SIGKILL");
			await rm(root, { recursive: true, force: true });
			await rm(state, { recursive: true, force: true });
		},
	};
}

test("the Machines entry leads to setup, and the new machine appears there as it pairs", async ({ baseURL, join: enter }) => {
	let handle = person();
	let page = await enter(handle);
	let entry = machinesEntry(page, "Machines, none connected");
	await expect(entry).toBeVisible();
	await entry.focus();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/connect$/);
	await expect(page.getByRole("heading", { level: 1, name: "Machines", exact: true }))
		.toBeVisible();

	// With nothing paired, setup leads, filled in with this server's own origin.
	let origin = new URL(baseURL!).origin;
	let setup = page.getByRole("region", { name: "Add your first machine", exact: true });
	let steps = setup.getByRole("listitem");
	await expect(steps).toHaveCount(3);
	// The browser's own system is chosen first; either can be picked.
	await setup.getByRole("button", { name: "Linux and macOS", exact: true }).click();
	await expect(steps.nth(0)).toContainText("install.sh | sh");
	await expect(steps.nth(1)).toContainText(
		`CHOPIN_URL=${origin} chopin connect . --install-service -- copilot --acp --allow-all`,
	);
	await setup.getByRole("button", { name: "Windows", exact: true }).click();
	await expect(steps.nth(0)).toContainText("install.ps1 | iex");
	await expect(steps.nth(1)).toContainText(`$env:CHOPIN_URL="${origin}"; chopin connect .`);
	await expect(page.getByText("Waiting for your machine…", { exact: true })).toBeVisible();

	let machine = await connector(baseURL!);
	try {
		await expect.poll(() => machine.output().match(PAIRING)).toBeTruthy();
		let pairing = await page.context().newPage();
		await pairing.goto(machine.output().match(PAIRING)![0]);
		await expect(pairing.getByRole("heading", { level: 1, name: "Connect this machine?" }))
			.toBeVisible();
		await pairing.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(pairing.getByRole("status")).toHaveText("Connected.");
		await expect.poll(machine.output).toContain("✓ Connected.");
		await pairing.close();

		// The waiting page turns into the machine's row without a reload.
		let row = page.getByRole("table", { name: "Your machines" })
			.getByRole("row", { name: new RegExp(hostname()) });
		await expect(row).toContainText("Connected");
		await expect(setup).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Add a machine", exact: true })).toBeVisible();

		await page.goto("/");
		let counted = machinesEntry(page, "Machines, 1 connected");
		await expect(counted).toContainText("1");
		await counted.click();
		await expect(page).toHaveURL(/\/connect$/);

		// A phone finds the same entry in its documents sheet.
		let phone = await enter(handle, PHONE);
		await phone.locator(".phone-top-bar").getByRole("button", { name: "Documents", exact: true })
			.click();
		await expect(
			phone.getByRole("dialog", { name: "Documents" })
				.getByRole("link", { name: "Machines, 1 connected", exact: true }),
		).toBeVisible();
	} finally {
		await machine.stop();
	}
});
