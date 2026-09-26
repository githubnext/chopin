import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { ROOT } from "./servers";

const ORIGIN = "http://127.0.0.1:8791";
const BASE_ENV = {
	...process.env,
	AUTH_MODE: "local",
	APP_ORIGIN: ORIGIN,
	SERVER_HOST: "127.0.0.1",
	PORT: "8791",
	DATABASE_URL: process.env.E2E_DATABASE_URL_2!,
	GITHUB_APP_SLUG: "chopin-e2e",
	GITHUB_APP_CLIENT_ID: "e2e",
	GITHUB_APP_CLIENT_SECRET: "",
	GITHUB_ALLOWED_USERS: "",
	GITHUB_ALLOWED_ORGANIZATIONS: "",
	SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY!,
	AGENT: "off",
};

let processes: ReturnType<typeof spawn>[] = [];
let directories: string[] = [];

async function stop(child: ReturnType<typeof spawn>) {
	if (child.exitCode !== null) return;
	let exit = new Promise<void>(resolve => child.once("close", () => resolve()));
	process.kill(-child.pid!, "SIGTERM");
	await exit;
	processes = processes.filter(value => value !== child);
}

async function server(directory: string, unavailable = false) {
	let child = spawn("mise", [
		"exec",
		"--",
		"bun",
		"--preload",
		"./e2e/secrets.ts",
		"--preload",
		"./e2e/github.ts",
		"apps/server/src/main.ts",
	], {
		cwd: ROOT,
		detached: true,
		env: {
			...BASE_ENV,
			CHOPIN_LOCAL_CREDENTIALS_DIR: join(directory, "config"),
			E2E_FAKE_VAULT_DIR: join(directory, "fake-vault"),
			E2E_DEVICE_APPROVAL_FILE: join(directory, "approval"),
			E2E_FAKE_VAULT_UNAVAILABLE: unavailable ? "1" : "0",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	let errors = "";
	child.stderr?.on("data", chunk => {
		errors += String(chunk).slice(-2_000);
	});
	processes.push(child);
	for (let index = 0; index < 150; index++) {
		if (child.exitCode !== null) {
			let safe = errors.replace(/(?:ghu_|ghr_)[A-Za-z0-9_-]+/g, "<redacted>")
				.replace(/postgres(?:ql)?:\/\/[^\s]+/g, "<database-url>");
			throw new Error(`local server exited with ${child.exitCode}: ${safe.slice(-800)}`);
		}
		try {
			let response = await fetch(`${ORIGIN}/api/session`);
			if (response.ok) return child;
		} catch { /* Server has not bound yet. */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error("local server did not become ready");
}

test.afterEach(async () => {
	for (let child of processes) await stop(child);
	for (let directory of directories) await rm(directory, { recursive: true, force: true });
	processes = [];
	directories = [];
});

test("local device approval, backend fallback, restart and logout", async ({ page, browser, request }) => {
	test.setTimeout(120_000);
	let directory = await mkdtemp(join(tmpdir(), "chopin-local-e2e-"));
	directories.push(directory);
	let child = await server(directory);
	await page.goto(ORIGIN);
	await expect(page.getByText("Open your workspace")).toBeVisible();
	await expect(page.getByRole("checkbox")).toHaveCount(0);
	await page.getByRole("button", { name: /sign in|device|github/i }).first().click();
	let instruction = page.getByText(/Enter one-time code:/);
	await expect(instruction).toBeVisible();
	await expect(page.getByRole("checkbox")).toHaveCount(0);
	let code = (await instruction.textContent())!.match(/E2E-\d{4}/)![0]!;
	await expect(page.getByRole("link", { name: "https://github.com/login/device" })).toBeVisible();
	let cookies = await page.context().cookies();
	let attempt = cookies.find(value => value.name.startsWith("chopin_local_attempt"))!;
	expect(attempt.httpOnly).toBe(true);
	let outsider = await browser.newContext();
	let outsiderResponse = await outsider.request.post(`${ORIGIN}/auth/device/complete`, {
		headers: { origin: ORIGIN },
	});
	expect(await outsiderResponse.json()).toMatchObject({ status: "cancelled" });
	let outsiderConsent = await outsider.request.post(`${ORIGIN}/auth/device/consent`, {
		headers: { origin: ORIGIN },
		data: { accept: true },
	});
	expect(await outsiderConsent.json()).toMatchObject({ status: "cancelled" });
	let wrongOrigin = await request.post(`${ORIGIN}/auth/device/complete`, {
		headers: { origin: "http://attacker.invalid", cookie: `${attempt.name}=${attempt.value}` },
	});
	expect(wrongOrigin.status()).toBe(403);
	let wrongConsent = await request.post(`${ORIGIN}/auth/device/consent`, {
		headers: { origin: "http://attacker.invalid", cookie: `${attempt.name}=${attempt.value}` },
		data: { accept: true },
	});
	expect(wrongConsent.status()).toBe(403);
	await page.evaluate(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: {
				writeText: async () => {
					throw new Error("clipboard denied");
				},
			},
		});
		window.open = () => null;
	});
	await page.getByRole("button", { name: "Copy code and open GitHub" }).click();
	await expect(page.getByText(
		`Failed to open browser. Please visit https://github.com/login/device and enter the code ${code} manually.`,
	)).toBeVisible();
	await page.evaluate(() => {
		window.open = () => ({ opener: null }) as Window;
	});
	await page.getByRole("button", { name: "Copy code and open GitHub" }).click();
	await expect(page.getByText(
		`Failed to copy to clipboard. Please visit https://github.com/login/device and enter the code ${code} manually.`,
	)).toBeVisible();
	await expect(page.getByText("Waiting for authorization...")).toBeVisible();
	await page.goto("about:blank");
	await writeFile(join(directory, "approval"), code);
	await page.waitForTimeout(1_500);
	await page.goto(ORIGIN);
	await expect(page.getByRole("button", { name: "octocat", exact: true }))
		.toBeVisible({ timeout: 20_000 });
	let session = await page.request.get(`${ORIGIN}/api/session`);
	expect((await session.json()).user.login).toBe("octocat");
	expect(await (await outsider.request.get(`${ORIGIN}/api/session`)).json())
		.toMatchObject({ user: null });
	await outsider.close();
	let mcp = await page.request.get(`${ORIGIN}/mcp`);
	expect(mcp.status()).toBe(401);
	expect(
		(await page.context().cookies()).filter(value => value.name.startsWith("chopin_"))
			.every(value => value.httpOnly),
	).toBe(true);
	expect(
		await page.evaluate(() =>
			[...Object.values(localStorage), ...Object.values(sessionStorage)]
				.some(value => /gh[ur]_[A-Za-z0-9_-]+/.test(value))
		),
	).toBe(false);
	expect((await readdir(directory)).sort()).toEqual(["approval", "fake-vault"]);
	expect(await readdir(join(directory, "fake-vault"))).toHaveLength(1);
	await stop(child);
	child = await server(directory);
	await page.reload();
	await expect(page.getByRole("button", { name: "octocat", exact: true }))
		.toBeVisible({ timeout: 20_000 });
	await expect(page.getByText("Enter one-time code:")).toHaveCount(0);
	if (await page.getByRole("button", { name: "Close Add Project" }).isVisible()) {
		await page.keyboard.press("Escape");
		await expect(page.getByRole("button", { name: "Close Add Project" })).toHaveCount(0);
	}
	await page.getByRole("button", { name: "octocat", exact: true }).click();
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page.getByText("Open your workspace")).toBeVisible();
	expect(await readdir(join(directory, "fake-vault"))).toHaveLength(0);
	await stop(child);
	child = await server(directory, true);
	await page.reload();
	await page.getByRole("button", { name: /sign in|device|github/i }).first().click();
	await expect(instruction).toBeVisible();
	let firstCode = (await instruction.textContent())!.match(/E2E-\d{4}/)![0]!;
	await writeFile(join(directory, "approval"), firstCode);
	await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 20_000 });
	await expect(page.getByText("System vault not available")).toBeVisible();
	await expect(page.getByText(join(directory, "config"), { exact: false })).toBeVisible();
	await expect(page.getByRole("checkbox")).toHaveCount(0);
	await page.getByRole("button", { name: "No, cancel sign-in" }).click();
	await expect(page.getByText("Open your workspace")).toBeVisible();
	expect((await readdir(directory)).sort()).toEqual(["approval", "fake-vault"]);
	await page.getByRole("button", { name: /sign in|device|github/i }).first().click();
	await expect(instruction).toBeVisible();
	let dismissedCode = (await instruction.textContent())!.match(/E2E-\d{4}/)![0]!;
	expect(dismissedCode).not.toBe(firstCode);
	await writeFile(join(directory, "approval"), dismissedCode);
	await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 20_000 });
	await page.keyboard.press("Escape");
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	await expect(page.getByText("Open your workspace")).toBeVisible();
	expect((await readdir(directory)).sort()).toEqual(["approval", "fake-vault"]);
	await page.getByRole("button", { name: /sign in|device|github/i }).first().click();
	await expect(instruction).toBeVisible();
	let nextCode = (await instruction.textContent())!.match(/E2E-\d{4}/)![0]!;
	expect(nextCode).not.toBe(dismissedCode);
	await writeFile(join(directory, "approval"), nextCode);
	await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 20_000 });
	await page.getByRole("button", { name: "Yes, store in plain text (insecure)" }).click();
	await expect(page.getByRole("button", { name: "octocat", exact: true }))
		.toBeVisible({ timeout: 20_000 });
	let files = await readdir(join(directory, "config"));
	expect(files).toHaveLength(1);
	expect((await stat(join(directory, "config"))).mode & 0o777).toBe(0o700);
	expect((await stat(join(directory, "config", files[0]!))).mode & 0o777).toBe(0o600);
	await stop(child);
	child = await server(directory, true);
	await page.reload();
	await expect(page.getByRole("button", { name: "octocat", exact: true }))
		.toBeVisible({ timeout: 20_000 });
	await expect(page.getByRole("alertdialog")).toHaveCount(0);
	if (await page.getByRole("button", { name: "Close Add Project" }).isVisible()) {
		await page.keyboard.press("Escape");
		await expect(page.getByRole("button", { name: "Close Add Project" })).toHaveCount(0);
	}
	await page.getByRole("button", { name: "octocat", exact: true }).click();
	await page.getByRole("menuitem", { name: "Sign out" }).click();
	await expect(page.getByText("Open your workspace")).toBeVisible();
	expect(await readdir(join(directory, "config"))).toHaveLength(0);
});
