import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { findAgent } from "../apps/web/src/experiments/agents";
import {
	agentCommand,
	connectCommand,
	installCommand,
} from "../apps/web/src/experiments/setup-commands";
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
	// The page sits inside the navigation, with Machines marked as the current page.
	await expect(entry).toHaveAttribute("aria-current", "page");

	// With nothing paired, setup leads, filled in with this server's own origin.
	let origin = new URL(baseURL!).origin;
	let setup = page.getByRole("region", { name: "Add your first machine", exact: true });
	let steps = setup.getByRole("listitem");
	await expect(steps).toHaveCount(5);
	// The browser's own system is chosen first; either can be picked. Each command keeps its own
	// line breaks, each with the shell's continuation.
	let install = steps.nth(0).locator("pre code");
	let agentSteps = steps.nth(1).locator("pre code");
	let command = steps.nth(2).locator("pre code");
	await setup.getByRole("button", { name: "Linux and macOS", exact: true }).click();
	await expect.poll(() => install.innerText()).toBe(installCommand("sh"));
	await expect.poll(() => command.innerText()).toBe(connectCommand(origin, "sh"));
	expect(await command.innerText()).toContain(`CHOPIN_URL=${origin} chopin connect .`);
	await setup.getByRole("button", { name: "Windows", exact: true }).click();
	await expect.poll(() => install.innerText()).toBe(installCommand("powershell"));
	await expect.poll(() => command.innerText()).toBe(connectCommand(origin, "powershell"));
	await expect(page.getByText("Waiting for your machine…", { exact: true })).toBeVisible();
	// The connect step says it installs the background service, and the next that it takes over.
	await expect(steps.nth(2).locator("p").first()).toHaveText(
		"In a checkout of your repository, run this. It pairs the machine and installs a background service, so it keeps running after you close the terminal or SSH.",
	);
	await expect(steps.nth(3).locator("p")).toHaveText(
		"Open the link it prints, check that the code matches, and choose Connect. GitHub may ask you to authorize the machine first. Then the service takes over; chopin status shows it.",
	);
	await expect(steps.nth(3).locator("code")).toHaveText("chopin status");

	// GitHub Copilot CLI is picked first. Picking another coding agent changes only its install and
	// connect steps, and says what to know about it; the pick outlasts a reload.
	let picker = setup.getByRole("combobox", { name: "Coding agent", exact: true });
	await expect(picker).toHaveValue("copilot");
	await expect(picker).toHaveAccessibleDescription("Tested with Chopin.");
	// The list puts the agents Chopin has been tried with first.
	expect(
		await picker.locator("optgroup").evaluateAll(groups =>
			groups.map(group => [
				group.getAttribute("label"),
				[...group.querySelectorAll("option")].map(option => option.textContent),
			])
		),
	).toEqual([
		["Tested with Chopin", ["GitHub Copilot CLI", "Atomic"]],
		["Not yet tested", ["Claude Code", "OpenAI Codex", "Gemini CLI"]],
	]);
	await expect(steps.nth(1)).toContainText("Install GitHub Copilot CLI and sign in.");
	await expect.poll(() => agentSteps.innerText()).toBe(
		agentCommand(findAgent("copilot"), "powershell"),
	);
	// Under the connect command, what its approval flag lets the agent do, and why.
	let approval = steps.nth(2).locator(".machines-detail");
	await expect(approval).toHaveText(
		"--allow-all lets GitHub Copilot CLI use its tools without asking, because nobody can answer a prompt in the background.",
	);
	await picker.selectOption({ label: "Atomic" });
	await expect(steps.nth(1)).toContainText("Install Atomic and sign in.");
	await expect.poll(() => agentSteps.innerText()).toBe(
		agentCommand(findAgent("atomic"), "powershell"),
	);
	await expect.poll(() => command.innerText())
		.toBe(connectCommand(origin, "powershell", findAgent("atomic")));
	await expect.poll(() => install.innerText()).toBe(installCommand("powershell"));
	await expect(approval).toHaveText(
		"Atomic doesn't ask before it uses its tools, so nothing waits on a prompt in the background.",
	);
	// Claude Code asks in the terminal, so it runs there instead of as the service: the connect
	// step says to leave that terminal open, and the steps don't mention the service.
	await picker.selectOption({ label: "Claude Code" });
	await expect(picker).toHaveAccessibleDescription("Not yet tested with Chopin.");
	await expect(steps.nth(2).locator("p").first())
		.toHaveText("In a checkout of your repository, connect this machine.");
	await expect(steps.nth(2).locator("p").last()).toHaveText(
		"Leave this terminal open: Claude Code asks for permission here, so closing it disconnects the machine. Coding agents in the setup guide has the setting that lets it run as a service.",
	);
	await expect(steps.nth(2).getByRole("link", { name: "Coding agents", exact: true }))
		.toHaveAttribute("href", /docs\/chopin-cli\.md#coding-agents$/);
	await expect(steps.nth(3)).not.toContainText("service");
	await page.reload();
	await expect(picker).toHaveValue("claude-code");
	await setup.getByRole("button", { name: "Linux and macOS", exact: true }).click();
	await expect.poll(() => command.innerText())
		.toBe(connectCommand(origin, "sh", findAgent("claude-code")));
	await picker.selectOption({ label: "GitHub Copilot CLI" });
	await expect(picker).toHaveAccessibleDescription("Tested with Chopin.");

	let machine = await connector(baseURL!);
	try {
		await expect.poll(() => machine.output().match(PAIRING)).toBeTruthy();
		let pairing = await page.context().newPage();
		await pairing.goto(machine.output().match(PAIRING)![0]);
		await expect(pairing.getByRole("heading", { level: 1, name: "Connect this machine?" }))
			.toBeVisible();
		await expect(machinesEntry(pairing, "Machines, none connected"))
			.toHaveAttribute("aria-current", "page");
		await expect(pairing.getByText("Check that your terminal shows this code", { exact: true }))
			.toBeVisible();
		await expect(pairing.getByRole("link", { name: "Not my machine", exact: true }))
			.toHaveAttribute("href", "/connect");
		// The page names the account approving, and what automatic work would change.
		await expect(pairing.getByText(`@${handle}`, { exact: true })).toBeVisible();
		await expect(
			pairing.getByRole("checkbox", {
				name: "Let Chopin build and prototype automatically on this machine",
			}),
		).toHaveAccessibleDescription(/^Off: work runs here only when you press Build or Run\./);
		await pairing.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(pairing.getByRole("status").filter({ hasText: "Connected" }))
			.toHaveText("Connected");
		await expect(pairing.getByText(`${hostname()} now runs work for octo-org/score.`))
			.toBeVisible();
		await expect.poll(machine.output).toContain("✓ Connected.");
		await pairing.close();

		// The waiting step ticks and says so, then the setup folds away above the machine's new row.
		await expect(page.getByRole("status").filter({ hasText: `${hostname()} connected` }))
			.toHaveText(`${hostname()} connected`);
		let row = page.getByRole("table", { name: "Your machines" })
			.getByRole("row", { name: new RegExp(hostname()) });
		await expect(row).toContainText("Connected");
		await expect(row).toContainText("New");
		await expect(setup).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Add a machine", exact: true })).toBeVisible();

		// Its actions open from the keyboard, as the document actions menu does.
		let actions = row.getByRole("button", { name: /^Actions for / });
		await actions.focus();
		await page.keyboard.press("ArrowDown");
		await expect(page.getByRole("menuitem", { name: "Disconnect machine", exact: true }))
			.toBeFocused();
		await page.keyboard.press("Escape");
		await expect(actions).toBeFocused();

		await page.goto("/");
		let counted = machinesEntry(page, "Machines, 1 connected");
		// Connected out of paired.
		await expect(counted).toContainText("1/1");
		await counted.click();
		await expect(page).toHaveURL(/\/connect$/);

		// A phone finds the same entry in its documents sheet, marked current on /connect.
		let phone = await enter(handle, PHONE);
		await phone.locator(".phone-top-bar").getByRole("button", { name: "Documents", exact: true })
			.click();
		let sheetEntry = phone.getByRole("dialog", { name: "Documents" })
			.getByRole("link", { name: "Machines, 1 connected", exact: true });
		await expect(sheetEntry).toBeVisible();
		await sheetEntry.click();
		await expect(phone).toHaveURL(/\/connect$/);
		await expect(
			phone.getByRole("table", { name: "Your machines" })
				.getByRole("row", { name: new RegExp(hostname()) }),
		).toContainText("Connected");
		await phone.getByRole("button", { name: "Show sidebar", exact: true }).click();
		await expect(
			phone.getByRole("dialog", { name: "Documents" })
				.getByRole("link", { name: "Machines, 1 connected", exact: true }),
		).toHaveAttribute("aria-current", "page");
	} finally {
		await machine.stop();
	}
});
