import { mkdir } from "node:fs/promises";
import { setupAgentCommand, setupAgentInstall } from "../apps/web/src/experiments/setup-commands";
import { expect, test } from "./room";
import { SETUP_AGENTS } from "./servers";

import type { Page } from "@playwright/test";
import type { SetupAgent } from "../packages/protocol/agents";

/** The fixtures server's CHOPIN_SETUP_AGENTS: a default with a keyless command, and one without. */
const ACME = SETUP_AGENTS[0] as SetupAgent;
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const KEY = /chopin_k_[A-Za-z0-9_-]{43}/;
/** Set to a directory to keep the screenshots a pull request shows. */
const SHOTS = process.env.CHOPIN_SHOTS;

async function shot(page: Page, name: string) {
	if (!SHOTS) return;
	await mkdir(SHOTS, { recursive: true });
	await new Promise(resolve => setTimeout(resolve, 400));
	await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

function person() {
	return `sam-${crypto.randomUUID().slice(0, 8)}`;
}

async function addMachine(page: Page, kind: "Your computer" | "Server or VM") {
	await page.goto("/connect");
	await page.getByRole("main").getByRole("button", { name: "Add machine", exact: true }).first()
		.click();
	await page.getByRole("menu", { name: "Add machine", exact: true })
		.getByRole("menuitem", { name: new RegExp(`^${kind}`) }).click();
}

async function options(page: Page) {
	return page.getByRole("combobox", { name: "Coding agent", exact: true }).locator("option")
		.allTextContents();
}

/** The command a page shows, as Copy takes it, and the key in it. */
async function shown(page: Page) {
	let text = await page.locator(".machines-run pre code").innerText();
	return { text, key: text.match(KEY)?.[0] };
}

for (let [device, use] of [["desktop", DESKTOP], ["phone", PHONE]] as const) {
	test(`server or VM on a ${device}: the deployment's setup agent comes first and preselected, its command filled with a real key`, async ({ baseURL, join: enter }) => {
		test.setTimeout(120_000);
		let page = await enter(person(), use);
		await addMachine(page, "Server or VM");
		await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add a server");
		let picker = page.getByRole("combobox", { name: "Coding agent", exact: true });
		await expect(picker).toHaveValue("acme-planner");
		expect(await options(page)).toEqual([
			"Acme Planner",
			"Acme Runner",
			"GitHub Copilot CLI",
			"Atomic",
		]);
		// Its own command installs whatever runs in the background; automatic work travels with the key.
		await expect(page.getByRole("switch", { name: "Run in the background", exact: true }))
			.toHaveCount(0);
		let automatic = page.getByRole("switch", {
			name: "Build and prototype automatically",
			exact: true,
		});
		await automatic.click();
		await expect(automatic).toHaveAttribute("aria-checked", "true");
		await page.getByRole("button", { name: "Linux", exact: true }).click();
		await page.getByRole("button", { name: "Show install steps", exact: true }).click();
		await expect(
			page.locator(".machines-needs-command pre code"),
		).toHaveText(setupAgentInstall(ACME, "linux").split("\n").join(""));
		await page.getByRole("textbox", { name: "Machine name", exact: true }).fill("Jo's box");

		let made: Array<Record<string, unknown>> = [];
		page.on("request", request => {
			if (new URL(request.url()).pathname === "/api/connector/pairing-keys") {
				made.push(request.postDataJSON() ?? {});
			}
		});
		await page.getByRole("button", { name: "Generate install script", exact: true }).click();
		await expect(page.getByRole("button", { name: "Copy install script", exact: true }))
			.toBeVisible({ timeout: 30_000 });
		let { text, key } = await shown(page);
		expect(key).toBeTruthy();
		let origin = new URL(baseURL!).origin;
		expect(text).toBe(setupAgentCommand(ACME, "linux", { origin, key, name: "Jo's box" }));
		expect(text).toContain("--name 'Jo'\\''s box'");
		expect(made.at(-1)).toMatchObject({ autoRun: true });
		await page.getByRole("button", { name: "Windows", exact: true }).click();
		await expect.poll(async () => (await shown(page)).text)
			.toBe(setupAgentCommand(ACME, "windows", { origin, key, name: "Jo's box" }));
		// The key stays out of the address and the browser's storage.
		expect(page.url()).not.toContain(key!);
		let stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
		expect(stored).not.toContain(key!);
		await page.getByRole("button", { name: "Linux", exact: true }).click();
		// Every command wraps in its well rather than scrolling sideways.
		for (let well of await page.locator(".machines-command pre").all()) {
			expect(await well.evaluate(pre => pre.scrollWidth - pre.clientWidth)).toBe(0);
		}
		await shot(page, `server-${device}`);

		if (device === "phone") return;
		// A person's own pick wins over the default, here and next time.
		await picker.selectOption({ label: "GitHub Copilot CLI" });
		await expect(page.getByRole("switch", { name: "Run in the background", exact: true }))
			.toBeVisible();
		await page.reload();
		await expect(page.getByRole("combobox", { name: "Coding agent", exact: true }))
			.toHaveValue("copilot");
	});

	test(`your computer on a ${device}: a setup agent with a keyless command comes first, the others are left out`, async ({ baseURL, join: enter }) => {
		let page = await enter(person(), use);
		await addMachine(page, "Your computer");
		let dialog = page.getByRole("dialog", { name: "Add your computer", exact: true });
		await expect(dialog.getByRole("combobox", { name: "Coding agent", exact: true }))
			.toHaveValue("acme-planner");
		expect(await options(page)).toEqual(["Acme Planner", "GitHub Copilot CLI", "Atomic"]);
		await dialog.getByRole("button", { name: "Linux", exact: true }).click();
		await expect(dialog.locator(".machines-run pre code"))
			.toHaveText(setupAgentCommand(ACME, "linux", { origin: new URL(baseURL!).origin })!);
		await dialog.getByRole("button", { name: "Show install steps", exact: true }).click();
		for (let well of await dialog.locator(".machines-command pre").all()) {
			expect(await well.evaluate(pre => pre.scrollWidth - pre.clientWidth)).toBe(0);
		}
		await shot(page, `computer-${device}`);
	});
}
