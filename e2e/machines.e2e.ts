import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { findAgent } from "../packages/protocol/agents";
import { compiledChopin } from "../apps/connector/src/testing/binary";
import { assets, fakeRelease } from "../apps/connector/src/testing/release";
import { agentCommand, setupCommand } from "../apps/web/src/experiments/setup-commands";
import { expect, test } from "./room";
import { ROOT } from "./servers";

import type { Locator, Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
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

/** The setup command as the card shows it, and the key in it. */
async function shown(setup: Locator) {
	let text = await setup.locator(".machines-run pre code").innerText();
	return { text, key: text.match(KEY)?.[0] };
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

test("one copied command installs chopin and pairs the machine, with no browser step", async ({ baseURL, join: enter }) => {
	test.setTimeout(240_000);
	let page = await enter(person());
	let entry = machinesEntry(page, "Machines, none connected");
	await entry.click();
	await expect(page).toHaveURL(/\/connect$/);

	// The card has GitHub authorize the next machine, which returns at once, then mints a key.
	let setup = page.getByRole("region", { name: "Add your first machine", exact: true });
	await expect(setup.getByRole("button", { name: "Copy setup command", exact: true }))
		.toBeVisible();
	await expect(page).toHaveURL(/\/connect$/);
	await expect(entry).toHaveAttribute("aria-current", "page");
	await expect(setup.getByRole("link", { name: "Docs", exact: true }))
		.toHaveAttribute("href", /docs\/chopin-cli\.md$/);
	await expect(setup.getByText(/^Expires in 10 min$/)).toBeVisible();
	await expect(setup.getByText("Waiting for your machine…", { exact: true })).toBeVisible();
	// The key stays out of the address and the browser's storage.
	let { key } = await shown(setup);
	expect(key).toBeTruthy();
	expect(page.url()).not.toContain(key!);
	let stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
	expect(stored).not.toContain(key!);

	// One command per system and agent, built around the same key.
	let origin = new URL(baseURL!).origin;
	await setup.getByRole("button", { name: "Linux and macOS", exact: true }).click();
	let picker = setup.getByRole("combobox", { name: "Coding agent", exact: true });
	await expect(picker).toHaveValue("copilot");
	await expect.poll(async () => (await shown(setup)).text)
		.toBe(setupCommand(origin, "sh", findAgent("copilot"), key!));
	await setup.getByRole("button", { name: "Windows", exact: true }).click();
	await expect.poll(async () => (await shown(setup)).text)
		.toBe(setupCommand(origin, "powershell", findAgent("copilot"), key!));
	await picker.selectOption({ label: "Claude Code" });
	await expect(setup.getByText("Keep this terminal open.", { exact: true })).toBeVisible();
	await expect.poll(async () => (await shown(setup)).text)
		.toBe(setupCommand(origin, "powershell", findAgent("claude-code"), key!));
	await picker.selectOption({ label: "GitHub Copilot CLI" });
	await setup.getByRole("button", { name: "Linux and macOS", exact: true }).click();
	await expect(setup.getByText("Keep this terminal open.", { exact: true })).toHaveCount(0);

	// What the agent needs reads as one line; its install command shows on request.
	await expect(setup.getByText("Needs GitHub Copilot CLI, signed in, and Node.js 22 or newer."))
		.toBeVisible();
	await setup.getByRole("button", { name: "Show install command", exact: true }).click();
	await expect.poll(() => setup.locator(".machines-needs pre code").innerText())
		.toBe(agentCommand(findAgent("copilot"), "sh"));
	await setup.getByRole("button", { name: "Hide install command", exact: true }).click();

	let command = (await shown(setup)).text;
	let laptop = await machine();
	try {
		// Pasted on the machine as it is, with nothing opened in a browser.
		expect(await laptop.run(command), laptop.output()).toBe(0);
		expect(laptop.output()).not.toContain(key!);
		expect(laptop.output()).not.toContain("/connect?pairing=");
		expect(laptop.output()).toContain("Installed the chopin service");
		expect(await readFile(join(laptop.home, "systemctl.log"), "utf8"))
			.toContain("systemctl --user enable --now chopin.service");

		// The service connects; the card ticks, then folds away above the machine's new row.
		await expect(page.getByRole("status").filter({ hasText: `${hostname()} connected` }))
			.toHaveText(`${hostname()} connected`, { timeout: 30_000 });
		let row = page.getByRole("table", { name: "Your machines" })
			.getByRole("row", { name: new RegExp(hostname()) });
		await expect(row).toContainText("Connected");
		await expect(row).toContainText("New");
		await expect(setup).toHaveCount(0);

		// The key worked once: on a machine not yet paired, the same command is refused.
		await rm(join(laptop.home, ".local/state"), { recursive: true, force: true });
		expect(await laptop.run(command)).toBe(1);
		expect(laptop.output()).toContain("Chopin refused the pairing key");

		// Adding another machine makes a new key.
		await page.getByRole("button", { name: "Add a machine", exact: true }).click();
		let again = page.getByRole("region", { name: "Add a machine", exact: true });
		let copy = again.getByRole("button", { name: "Copy setup command", exact: true });
		let github = again.getByRole("button", { name: "Continue with GitHub", exact: true });
		await expect(copy.or(github)).toBeVisible();
		if (await github.isVisible()) await github.click();
		await expect(copy).toBeVisible();
		expect((await shown(again)).key).not.toBe(key);
	} finally {
		await laptop.stop();
	}
});

test("a wait past a minute links to troubleshooting, and a phone wraps the command in view", async ({ join: enter }) => {
	let page = await enter(person(), PHONE);
	await page.clock.install();
	await page.goto("/connect");
	let setup = page.getByRole("region", { name: "Add your first machine", exact: true });
	await expect(setup.getByRole("button", { name: "Copy setup command", exact: true }))
		.toBeVisible();
	let help = setup.getByRole("link", { name: "Troubleshooting", exact: true });
	await expect(setup.getByText("Waiting for your machine…", { exact: true })).toBeVisible();
	await page.clock.fastForward(30_000);
	await expect(help).toHaveCount(0);
	await page.clock.fastForward(31_000);
	await expect(help).toHaveAttribute("href", /docs\/chopin-cli\.md#troubleshooting$/);

	// No command scrolls sideways; each wraps inside its well and still reads as what Copy takes.
	await setup.getByRole("button", { name: "Show install command", exact: true }).click();
	for (let id of ["copilot", "atomic", "claude-code", "codex", "gemini"]) {
		await setup.getByRole("combobox", { name: "Coding agent", exact: true }).selectOption(id);
		for (let well of await setup.locator(".machines-command pre").all()) {
			expect(await well.evaluate(pre => pre.scrollWidth - pre.clientWidth)).toBe(0);
		}
	}

	// Past ten minutes the key is replaced by itself while the page is in view.
	let { key } = await shown(setup);
	await page.clock.fastForward(10 * 60_000);
	await expect.poll(async () => (await shown(setup)).key).not.toBe(key);
});
