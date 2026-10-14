import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { findAgent } from "../packages/protocol/agents";
import {
	CONNECTOR_AGENT_HEADER,
	CONNECTOR_AGENT_VERSION_HEADER,
	CONNECTOR_HOST_HEADER,
	CONNECTOR_PLATFORM_HEADER,
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_SERVICE_HEADER,
	CONNECTOR_VERSION_HEADER,
} from "../packages/protocol/connector";
import { CONNECTOR_PROTOCOL } from "../apps/connector/src/version";
import { compiledChopin } from "../apps/connector/src/testing/binary";
import { assets, fakeRelease } from "../apps/connector/src/testing/release";
import { agentCommand, setupCommand } from "../apps/web/src/experiments/setup-commands";
import { expect, test } from "./room";
import { ROOT } from "./servers";

import type { Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
/** Set to a directory to keep the screenshots a pull request shows. */
const SHOTS = process.env.CHOPIN_SHOTS;

async function shot(page: Page, name: string) {
	if (!SHOTS) return;
	await mkdir(SHOTS, { recursive: true });
	await new Promise(resolve => setTimeout(resolve, 400));
	await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
const RELEASES = "https://github.com/githubnext/chopin/releases/latest/download";
const KEY = /chopin_k_[A-Za-z0-9_-]{43}/;

/** Each test sets up machines for its own person, so their machine lists start empty. */
function person() {
	return `mia-${crypto.randomUUID().slice(0, 8)}`;
}

function machinesEntry(page: Page, name: string) {
	return page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name, exact: true });
}

/**
 * A machine to paste the setup command into: a checkout of octo-org/score, a home of its own,
 * the GitHub Copilot CLI (the fake ACP agent), and systemctl and loginctl that stand in for
 * systemd, whose `enable --now` starts the service's connect as systemd would. Its install.sh
 * downloads a compiled chopin from a local release.
 */
async function machine() {
	let home = await mkdtemp(join(tmpdir(), "chopin-machines-home-"));
	let root = join(home, "score");
	let bin = join(home, "bin");
	await mkdir(root);
	await mkdir(bin);
	await mkdir(join(home, "build"));
	let git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
	git("init");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.test");
	git("remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "sample.txt"), "sample");
	git("add", ".");
	git("commit", "-m", "fixture");
	let shim = async (name: string, body: string) => {
		await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
		await chmod(join(bin, name), 0o755);
	};
	let agent = join(ROOT, "apps/connector/src/testing/fake-agent.ts");
	await shim("copilot", `exec ${process.execPath} ${agent}`);
	await shim("loginctl", "echo yes");
	await shim(
		"systemctl",
		[
			`echo "systemctl $*" >> "$HOME/systemctl.log"`,
			'case "$*" in',
			"  *show*) echo Version=255 ;;",
			"  *is-active*) echo inactive; exit 3 ;;",
			`  *enable*) "$HOME/.local/bin/chopin" connect --service > "$HOME/service.log" 2>&1 &`,
			`    echo $! > "$HOME/service.pid" ;;`,
			"esac",
		].join("\n"),
	);
	let binary = await compiledChopin(join(home, "build"));
	if (!binary) throw new Error("The setup command test needs `bun build --compile`.");
	let { version } = await Bun.file(join(ROOT, "apps/connector/package.json")).json() as {
		version: string;
	};
	let release = fakeRelease({
		[version]: assets(basename(binary), await Bun.file(binary).bytes()),
		latest: {
			"install.sh": await Bun.file(join(ROOT, "apps/connector/install/install.sh")).text(),
		},
	});
	let origin = release.env.CHOPIN_RELEASE_BASE_URL;
	let output = "";
	return {
		home,
		output: () => output,
		/** Paste `command` into bash in the checkout, with the installer's URL on this machine. */
		run(command: string) {
			output = "";
			let child = spawn("bash", ["-c", command.replace(RELEASES, `${origin}/latest`)], {
				cwd: root,
				env: {
					HOME: home,
					PATH: `${bin}:/usr/bin:/bin`,
					CHOPIN_VERSION: version,
					CHOPIN_VERIFY_ATTESTATION: "0",
					...release.env,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout.on("data", chunk => output += String(chunk));
			child.stderr.on("data", chunk => output += String(chunk));
			return new Promise<number | null>(resolve => child.on("exit", resolve));
		},
		async stop() {
			let pid = Number(await readFile(join(home, "service.pid"), "utf8").catch(() => ""));
			if (pid) {
				try {
					process.kill(pid, "SIGKILL");
				} catch { /* Already gone. */ }
			}
			release[Symbol.dispose]();
			await rm(home, { recursive: true, force: true });
		},
	};
}

/** The menu Add machine opens, on the page header or the empty page's banner. */
async function addMachine(page: Page, kind: "Your computer" | "Server or VM", banner = false) {
	let scope = banner
		? page.getByRole("region", { name: "Add your first machine", exact: true })
		: page.getByRole("main");
	await scope.getByRole("button", { name: "Add machine", exact: true }).first().click();
	let menu = page.getByRole("menu", { name: "Add machine", exact: true });
	await menu.getByRole("menuitem", { name: new RegExp(`^${kind}`) }).click();
}

/** Every request the page makes for a pairing key, to show none is made unasked. */
function keyRequests(page: Page) {
	let made: string[] = [];
	page.on("request", request => {
		if (new URL(request.url()).pathname === "/api/connector/pairing-keys") made.push(request.url());
	});
	return made;
}

const PAIRING_LINK = /http:\/\/[^\s]+\/connect\?pairing=[\w-]+/;

test("your computer: one copied command installs chopin, prints a link, and pairs once approved here", async ({ baseURL, join: enter }) => {
	test.setTimeout(240_000);
	let handle = person();
	let page = await enter(handle);
	let minted = keyRequests(page);
	let entry = machinesEntry(page, "Machines, none connected");
	await entry.click();
	await expect(page).toHaveURL(/\/connect$/);
	await expect(entry).toHaveAttribute("aria-current", "page");
	await expect(page.getByRole("link", { name: "Learn more", exact: true }))
		.toHaveAttribute("href", /docs\/chopin-cli\.md$/);
	// With no machine yet, the page is its heading and a banner offering the same menu: no search,
	// count, table or footer until there is a machine.
	await expect(page.getByRole("region", { name: "Add your first machine", exact: true }))
		.toBeVisible();
	await expect(page.getByRole("searchbox", { name: "Search machines" })).toHaveCount(0);
	await expect(page.getByRole("table", { name: "Your machines" })).toHaveCount(0);
	await expect(page.getByText(/^0 machines$|Connect more machines/)).toHaveCount(0);

	await addMachine(page, "Your computer", true);
	let dialog = page.getByRole("dialog", { name: "Add your computer", exact: true });
	await expect(dialog).toContainText(`connect as @${handle}.`);
	let origin = new URL(baseURL!).origin;
	let command = () => dialog.locator(".machines-run pre code").innerText();
	await dialog.getByRole("button", { name: "Linux", exact: true }).click();
	let picker = dialog.getByRole("combobox", { name: "Coding agent", exact: true });
	await expect(picker).toHaveValue("copilot");
	await expect.poll(command).toBe(setupCommand(origin, "sh", findAgent("copilot")));
	await dialog.getByRole("button", { name: "Windows", exact: true }).click();
	await expect.poll(command).toBe(setupCommand(origin, "powershell", findAgent("copilot")));
	await picker.selectOption({ label: "Claude Code" });
	await expect(dialog.getByText(/Keep the terminal open\./)).toBeVisible();
	await expect.poll(command).toBe(setupCommand(origin, "powershell", findAgent("claude-code")));
	await picker.selectOption({ label: "GitHub Copilot CLI" });
	await dialog.getByRole("button", { name: "macOS", exact: true }).click();
	await expect.poll(command).toBe(setupCommand(origin, "sh", findAgent("copilot")));

	// What the agent needs reads as one line; its install command shows on request.
	await expect(dialog.getByText("Needs GitHub Copilot CLI, signed in, and Node.js 22 or newer."))
		.toBeVisible();
	await dialog.getByRole("button", { name: "Show install command", exact: true }).click();
	await expect.poll(() => dialog.locator(".machines-needs pre code").innerText())
		.toBe(agentCommand(findAgent("copilot"), "sh"));
	await expect(dialog.getByText(/^If npm stops with EACCES, don't use sudo/)).toBeVisible();
	await dialog.getByRole("button", { name: "Hide install command", exact: true }).click();
	// The dialog ends at the command, as Tailscale's does: no wait for the machine.
	await expect(dialog.getByText("It prints a link; open it here and approve.")).toBeVisible();
	await expect(dialog.getByText(/Waiting/)).toHaveCount(0);

	let laptop = await machine();
	try {
		// Pasted on the machine as it is: it installs chopin, which prints a link and a code.
		let exited = laptop.run(await command());
		await expect.poll(() => laptop.output().match(PAIRING_LINK)?.[0], { timeout: 60_000 })
			.toBeTruthy();
		let code = laptop.output().match(/Check the page shows:\s+([A-Z2-9]{4}-[A-Z2-9]{4})/)?.[1];
		expect(code).toBeTruthy();
		let approval = await page.context().newPage();
		await approval.goto(laptop.output().match(PAIRING_LINK)![0]);
		await expect(approval.getByText(code!, { exact: true })).toBeVisible();
		await approval.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(approval.getByRole("status").filter({ hasText: "Connected" }))
			.toHaveText("Connected");
		await approval.close();

		// Approved, it connects, then installs the service and leaves it running.
		expect(await exited, laptop.output()).toBe(0);
		expect(laptop.output()).toContain("Installed the chopin service");
		expect(await readFile(join(laptop.home, "systemctl.log"), "utf8"))
			.toContain("systemctl --user enable --now chopin.service");

		// Closed, the dialog leaves the table, where the machine appears as it connects.
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		let row = page.getByRole("table", { name: "Your machines" })
			.getByRole("row", { name: new RegExp(hostname()) });
		await expect(row).toContainText("Connected", { timeout: 30_000 });
		await expect(row).not.toContainText("New");
		await expect(page.getByText("1 machine", { exact: true })).toBeVisible();
		await expect(page.getByRole("region", { name: "Add your first machine" })).toHaveCount(0);
		// No key was made on the way.
		expect(minted).toEqual([]);
	} finally {
		await laptop.stop();
	}
});

test("server or VM: a generated script pairs with its single-use key, automatic work as chosen", async ({ baseURL, join: enter }) => {
	test.setTimeout(240_000);
	let page = await enter(person());
	let minted = keyRequests(page);
	await page.goto("/connect");
	await addMachine(page, "Server or VM");
	await expect(page).toHaveURL(/\/connect\?server$/);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add a server");
	await expect(page.getByText("Choose settings, then generate an install script.")).toBeVisible();
	// Opening the page makes no key; Generate does.
	expect(minted).toEqual([]);
	let background = page.getByRole("switch", { name: "Run in the background", exact: true });
	let automatic = page.getByRole("switch", {
		name: "Build and prototype automatically",
		exact: true,
	});
	await expect(background).toHaveAttribute("aria-checked", "true");
	await expect(automatic).toHaveAttribute("aria-checked", "false");
	// An agent that asks permission in the terminal runs there.
	let picker = page.getByRole("combobox", { name: "Coding agent", exact: true });
	await picker.selectOption({ label: "Claude Code" });
	await expect(background).toBeDisabled();
	await expect(background).toHaveAttribute("aria-checked", "false");
	await expect(page.getByText(/^Claude Code asks for permission in the terminal/)).toBeVisible();
	await picker.selectOption({ label: "GitHub Copilot CLI" });
	await expect(background).toHaveAttribute("aria-checked", "true");
	await automatic.click();
	await expect(automatic).toHaveAttribute("aria-checked", "true");
	await page.getByRole("button", { name: "Linux", exact: true }).click();

	// GitHub authorizes the next machine and comes straight back, and the page makes the key.
	await page.getByRole("button", { name: "Generate install script", exact: true }).click();
	let copy = page.getByRole("button", { name: "Copy install script", exact: true });
	await expect(copy).toBeVisible({ timeout: 30_000 });
	await expect(page).toHaveURL(/\/connect\?server$/);
	await expect(automatic).toHaveAttribute("aria-checked", "true");
	await expect(page.getByText(/^Single use · expires in 10 min$/)).toBeVisible();
	let shown = async () => {
		let text = await page.locator(".machines-run pre code").innerText();
		return { text, key: text.match(KEY)?.[0] };
	};
	let first = (await shown()).key;
	expect(first).toBeTruthy();
	await page.getByRole("button", { name: "Re-generate install script", exact: true }).click();
	await expect.poll(async () => (await shown()).key).not.toBe(first);
	let { text: command, key } = await shown();
	let origin = new URL(baseURL!).origin;
	expect(command).toBe(setupCommand(origin, "sh", findAgent("copilot"), { key: key! }));
	await page.getByRole("button", { name: "Windows", exact: true }).click();
	await expect.poll(async () => (await shown()).text)
		.toBe(setupCommand(origin, "powershell", findAgent("copilot"), { key: key! }));
	await page.getByRole("button", { name: "Linux", exact: true }).click();
	// The key stays out of the address and the browser's storage.
	expect(page.url()).not.toContain(key!);
	let stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
	expect(stored).not.toContain(key!);
	// The page ends at the command, as Tailscale's does: no wait for the machine.
	await expect(page.getByText(/Waiting/)).toHaveCount(0);

	let server = await machine();
	try {
		// Pasted on the machine as it is: it pairs at once, with nothing opened in a browser.
		expect(await server.run(command), server.output()).toBe(0);
		expect(server.output()).not.toContain(key!);
		expect(server.output()).not.toContain("/connect?pairing=");
		expect(server.output()).toContain("Installed the chopin service");

		await expect(page.getByText(hostname())).toHaveCount(0);
		await expect.poll(
			() =>
				page.evaluate(async () => (await (await fetch("/api/connector/machines")).json()).machines),
		).toMatchObject([{ label: hostname(), autoRun: true }]);

		// Back on Machines, the machine is in the table.
		await page.getByRole("link", { name: "Back to Machines", exact: true }).click();
		await expect(page).toHaveURL(/\/connect$/);
		let row = page.getByRole("table", { name: "Your machines" })
			.getByRole("row", { name: new RegExp(hostname()) });
		await expect(row).toContainText("Connected", { timeout: 30_000 });
		await expect(row).not.toContainText("New");

		// The key worked once: on a machine not yet paired, the same command is refused.
		await rm(join(server.home, ".local/state"), { recursive: true, force: true });
		expect(await server.run(command)).toBe(1);
		expect(server.output()).toContain("Chopin refused the pairing key");
	} finally {
		await server.stop();
	}
});

test("a phone wraps every command in view", async ({ join: enter }) => {
	let page = await enter(person(), PHONE);
	await page.goto("/connect");
	await addMachine(page, "Your computer", true);
	let dialog = page.getByRole("dialog", { name: "Add your computer", exact: true });
	await expect(dialog.getByRole("button", { name: "Copy setup command", exact: true }))
		.toBeVisible();

	// No command scrolls sideways; each wraps inside its well and still reads as what Copy takes.
	await dialog.getByRole("button", { name: "Show install command", exact: true }).click();
	for (let system of ["Linux", "Windows"]) {
		await dialog.getByRole("button", { name: system, exact: true }).click();
		for (let id of ["copilot", "atomic", "claude-code", "codex", "gemini"]) {
			await dialog.getByRole("combobox", { name: "Coding agent", exact: true }).selectOption(id);
			for (let well of await dialog.locator(".machines-command pre").all()) {
				expect(await well.evaluate(pre => pre.scrollWidth - pre.clientWidth)).toBe(0);
			}
		}
	}
	await dialog.getByRole("button", { name: "Close", exact: true }).click();
	await expect(dialog).toHaveCount(0);
});

const CONNECTOR = {
	[CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL),
	[CONNECTOR_VERSION_HEADER]: "0.0.5",
};

/**
 * Pair a machine for the person signed in on `page` with a key, as Add a server's script would,
 * and, given `about`, connect a checkout with what its connector says about it.
 */
async function pairedMachine(page: Page, label: string, about?: Record<string, string>) {
	let origin = new URL(page.url()).origin;
	await page.goto("/auth/github/connector?key");
	await expect(page).toHaveURL(/\/connect\?server$/);
	let minted = await (await page.request.post("/api/connector/pairing-keys", {
		data: {},
		headers: { origin },
	})).json() as { key: string };
	let checkout = { repository: "octo-org/score", commit: "a".repeat(40), label };
	// As a machine would: no browser cookies, so no browser origin either.
	let post = (path: string, body: unknown, headers: Record<string, string>) =>
		fetch(new URL(path, origin), {
			method: "POST",
			headers: { "content-type": "application/json", ...CONNECTOR, ...headers },
			body: JSON.stringify(body),
		});
	let paired = await (await post("/api/connector/pairings", { ...checkout, key: minted.key }, {}))
		.json() as { token: string };
	if (about) {
		let opened = await post("/api/connector/connections", checkout, {
			...about,
			authorization: `Bearer ${paired.token}`,
		});
		expect(opened.status, await opened.text()).toBe(200);
	}
}

/** Three machines: a Linux server running as the service, a Mac, and one never connected. */
async function threeMachines(page: Page) {
	await pairedMachine(page, "build-box", {
		[CONNECTOR_HOST_HEADER]: "build-box.internal",
		[CONNECTOR_PLATFORM_HEADER]: "linux arm64",
		[CONNECTOR_SERVICE_HEADER]: "1",
		[CONNECTOR_AGENT_HEADER]: "GitHub Copilot CLI",
		[CONNECTOR_AGENT_VERSION_HEADER]: "1.0.97",
	});
	await pairedMachine(page, "studio", {
		[CONNECTOR_HOST_HEADER]: "studio.local",
		[CONNECTOR_PLATFORM_HEADER]: "darwin arm64",
		[CONNECTOR_AGENT_HEADER]: "Claude Code",
		[CONNECTOR_AGENT_VERSION_HEADER]: "0.12.3",
	});
	await pairedMachine(page, "old-laptop");
	await page.goto("/connect");
}

test("the machines table: search, Tailscale's columns, a row's menu and renaming", async ({ join: enter }) => {
	let page = await enter(person());
	await threeMachines(page);
	let table = page.getByRole("table", { name: "Your machines" });
	await expect(page.getByText("3 machines", { exact: true })).toBeVisible();
	for (let heading of ["Machine", "Host", "Version", "Agent", "Last seen"]) {
		await expect(table.getByRole("columnheader", { name: heading, exact: true })).toBeVisible();
	}
	// A row's name starts with its favorite star's.
	let row = (name: string) =>
		table.getByRole("row", { name: new RegExp(`^(Favorite |Remove )?${name}`) });
	await expect(row("build-box")).toContainText("Service");
	await expect(row("build-box")).toContainText("build-box.internal");
	await expect(row("build-box")).toContainText("chopin 0.0.5");
	await expect(row("build-box")).toContainText("Linux arm64");
	await expect(row("build-box")).toContainText("GitHub Copilot CLI 1.0.97");
	await expect(row("build-box")).toContainText("Connected");
	// Where a machine connected from is not shown.
	await expect(row("build-box").getByRole("button", { name: /^Copy / })).toHaveCount(0);
	await expect(row("studio")).toContainText("macOS arm64");
	await expect(row("old-laptop")).toContainText(/Last seen/);

	// Search narrows the table, by name, repository, system or agent alike.
	let search = page.getByRole("searchbox", { name: "Search machines" });
	await search.fill("claude");
	await expect(page.getByText("1 of 3 machines", { exact: true })).toBeVisible();
	await expect(table.getByRole("row")).toHaveCount(2);
	await search.fill("");

	// The row menu renames the machine.
	await row("build-box").getByRole("button", { name: "Actions for build-box" }).click();
	let menu = page.getByRole("menu", { name: "Actions for build-box" });
	await expect(menu.getByRole("menuitem")).toHaveText([
		"Edit machine name…",
		"Set as favorite",
		"Disconnect machine…",
	]);
	await menu.getByRole("menuitem", { name: "Edit machine name…" }).click();
	let dialog = page.getByRole("dialog", { name: "Edit machine name for build-box" });
	await expect(dialog).toContainText("This name is shown in Chopin and in chopin status.");
	let field = dialog.getByRole("textbox", { name: "Machine name" });
	await expect(field).toBeFocused();
	await field.fill("Build box");
	await dialog.getByRole("button", { name: "Update name", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	await expect(row("Build box")).toContainText("build-box.internal");

	// Under the table, a quiet way to add another.
	await page.getByRole("main").getByRole("button", { name: "Add machine", exact: true }).last()
		.click();
	await expect(page.getByRole("menu", { name: "Add machine" })).toBeVisible();
});

test("on a phone, machines are rows that open their own view, where they rename", async ({ join: enter }) => {
	let page = await enter(person(), PHONE);
	await page.goto("/connect");
	await expect(page.getByRole("region", { name: "Add your first machine", exact: true }))
		.toBeVisible();
	await expect(page.getByRole("searchbox", { name: "Search machines" })).toHaveCount(0);
	await threeMachines(page);
	let rows = page.getByRole("region", { name: /^@mia-/ });
	await expect(rows.locator(".machines-row")).toHaveCount(3);
	await expect(rows.getByRole("img", { name: "Connected" })).toHaveCount(2);
	await expect(rows.getByRole("img", { name: /^Last seen/ })).toHaveCount(1);
	await expect(rows.locator(".machines-row").filter({ hasText: "build-box" }))
		.toContainText("build-box.internal · chopin 0.0.5 · Linux");
	await page.getByRole("searchbox", { name: "Search machines" }).fill("studio");
	await expect(rows.locator(".machines-row")).toHaveCount(1);
	await page.getByRole("searchbox", { name: "Search machines" }).fill("");

	await rows.locator(".machines-row").filter({ hasText: "build-box" }).click();
	await expect(page).toHaveURL(/\/connect\?machine=/);
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("build-box");
	// The state shows once, in the Status row, not again under the name.
	await expect(page.locator(".machines-description")).toHaveCount(0);
	await expect(page.getByRole("main").getByText("Connected", { exact: true })).toHaveCount(1);
	await expect(page.getByRole("main")).toContainText("build-box.internal");
	await expect(page.getByRole("main")).toContainText("Linux arm64");
	await expect(page.getByRole("main")).not.toContainText("Address");
	await page.getByRole("button", { name: "Edit machine name…" }).click();
	let dialog = page.getByRole("dialog", { name: "Edit machine name for build-box" });
	await dialog.getByRole("textbox", { name: "Machine name" }).fill("Build box");
	await dialog.getByRole("button", { name: "Update name", exact: true }).click();
	await expect(page.getByRole("heading", { level: 1 })).toHaveText("Build box");

	await page.getByRole("button", { name: "Machines", exact: true }).click();
	await expect(page).toHaveURL(/\/connect$/);
	await expect(rows.locator(".machines-row").filter({ hasText: "Build box" })).toBeVisible();
});

test("a favorite machine: its star in the table and the row menu, one at a time", async ({ join: enter }) => {
	let page = await enter(person());
	await threeMachines(page);
	let table = page.getByRole("table", { name: "Your machines" });
	let row = (name: string) =>
		table.getByRole("row", { name: new RegExp(`^(Favorite |Remove )?${name}`) });
	let star = row("studio").getByRole("button", { name: "Favorite studio" });
	await expect(star).toHaveAttribute("aria-pressed", "false");
	// The outline waits for the row's hover or focus.
	expect(await star.evaluate(item => getComputedStyle(item).opacity)).toBe("0");
	await row("studio").hover();
	expect(await star.evaluate(item => getComputedStyle(item).opacity)).toBe("1");
	await star.click();
	await expect(row("studio").getByRole("button", { name: "Remove studio as favorite" }))
		.toHaveAttribute("aria-pressed", "true");
	// The row menu sets another, and only one is ever the favorite.
	await row("build-box").getByRole("button", { name: "Actions for build-box" }).click();
	await page.getByRole("menu", { name: "Actions for build-box" })
		.getByRole("menuitem", { name: "Set as favorite" }).click();
	await expect(row("build-box").getByRole("button", { name: "Remove build-box as favorite" }))
		.toHaveAttribute("aria-pressed", "true");
	await expect(row("studio").getByRole("button", { name: "Favorite studio" }))
		.toHaveAttribute("aria-pressed", "false");
	await expect(table.locator(".favorite-star[aria-pressed=true]")).toHaveCount(1);
	await page.reload();
	await expect(row("build-box").getByRole("button", { name: "Remove build-box as favorite" }))
		.toBeAttached();
	await row("build-box").getByRole("button", { name: "Actions for build-box" }).click();
	await expect(
		page.getByRole("menu", { name: "Actions for build-box" })
			.getByRole("menuitem", { name: "Remove favorite" }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await row("studio").hover();
	await shot(page, "machines-table-favorite");
});

test("on a phone, a machine's row has its star, and its view sets the favorite", async ({ join: enter }) => {
	let page = await enter(person(), PHONE);
	await threeMachines(page);
	let rows = page.getByRole("region", { name: /^@mia-/ });
	let star = rows.getByRole("button", { name: "Favorite studio" });
	await expect(star).toBeVisible();
	// A 44px target.
	let box = (await star.boundingBox())!;
	let reach = await page.evaluate(
		([x, y]) => !!document.elementFromPoint(x!, y!)?.closest(".favorite-star"),
		[
			box.x + box.width / 2,
			box.y + box.height / 2 + 21,
		],
	);
	expect(reach).toBe(true);
	await star.tap();
	await expect(rows.getByRole("button", { name: "Remove studio as favorite" }))
		.toHaveAttribute("aria-pressed", "true");
	await expect(page).toHaveURL(/\/connect$/);
	await shot(page, "phone-machines-favorite");
	await rows.locator(".machines-row").filter({ hasText: "build-box" }).click();
	await expect(page).toHaveURL(/\/connect\?machine=/);
	let set = page.getByRole("button", { name: "Set as favorite" });
	await expect(set).toHaveAttribute("aria-pressed", "false");
	await set.click();
	await expect(page.getByRole("button", { name: "Remove favorite" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await shot(page, "phone-machine-detail-favorite");
	await page.getByRole("button", { name: "Machines", exact: true }).click();
	await expect(rows.getByRole("button", { name: "Remove build-box as favorite" })).toBeVisible();
	await expect(rows.getByRole("button", { name: "Favorite studio" })).toBeVisible();
});
