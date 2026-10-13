import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test as base } from "@playwright/test";

import { createChannel, registerTestDatabase, seedChannel } from "./database";
import { ROOT } from "./servers";

import type { Page } from "@playwright/test";

export const ORIGIN = "http://127.0.0.1:8791";

type DemoServer = {
	login(page: Page): Promise<void>;
	restart(enabled?: boolean): Promise<void>;
};

export const test = base.extend<{ demo: DemoServer; room: string }>({
	demo: async ({ baseURL }, use) => {
		let directory = await mkdtemp(join(tmpdir(), "chopin-demo-e2e-"));
		let child: ReturnType<typeof spawn> | undefined;
		let enabled = true;
		let errors = "";
		let stop = async () => {
			let running = child;
			child = undefined;
			if (!running || running.exitCode !== null || running.signalCode !== null || !running.pid) {
				return;
			}
			let exit = new Promise<void>(resolve => running.once("close", () => resolve()));
			let signal = (value: NodeJS.Signals) => {
				try {
					process.kill(-running.pid!, value);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			};
			signal("SIGTERM");
			let force = setTimeout(() => signal("SIGKILL"), 2_000);
			try {
				await exit;
			} finally {
				clearTimeout(force);
			}
		};
		let start = async () => {
			errors = "";
			child = spawn(process.execPath, [
				"--preload",
				"./e2e/secrets.ts",
				"--preload",
				"./e2e/github.ts",
				"apps/server/src/main.ts",
			], {
				cwd: ROOT,
				detached: true,
				env: {
					...process.env,
					AUTH_MODE: "local",
					DEMO_PERSONAS: enabled ? "on" : "off",
					APP_ORIGIN: ORIGIN,
					SERVER_HOST: "127.0.0.1",
					PORT: "8791",
					DATABASE_URL: process.env.E2E_DATABASE_URL_3!,
					GITHUB_APP_SLUG: "chopin-e2e",
					GITHUB_APP_CLIENT_ID: "e2e",
					GITHUB_APP_CLIENT_SECRET: "",
					GITHUB_ALLOWED_USERS: "",
					GITHUB_ALLOWED_ORGANIZATIONS: "",
					SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY!,
					CHOPIN_LOCAL_CREDENTIALS_DIR: join(directory, "config"),
					E2E_FAKE_VAULT_DIR: join(directory, "vault"),
					E2E_DEVICE_APPROVAL_FILE: join(directory, "approval"),
					E2E_FAKE_VAULT_UNAVAILABLE: "0",
					AGENT: "off",
					CONVERSATION_PLAN: "off",
					BACKGROUND_JOBS: "off",
					DEV_QUESTIONS: "1",
					DEV_COMMENTS: "",
				},
				stdio: ["ignore", "ignore", "pipe"],
			});
			child.stderr?.on("data", chunk => {
				errors = (errors + String(chunk)).slice(-4_000);
			});
			await expect.poll(async () => {
				if (child?.exitCode !== null) {
					let safe = errors.replace(/(?:ghu_|ghr_)[A-Za-z0-9_-]+/g, "<redacted>")
						.replace(/postgres(?:ql)?:\/\/[^\s]+/g, "<database-url>");
					throw new Error(`demo server exited: ${safe}`);
				}
				return fetch(`${ORIGIN}/api/session`).then(response => response.ok, () => false);
			}, { timeout: 20_000 }).toBe(true);
		};
		try {
			await start();
			await use({
				login: async page => {
					await page.goto(baseURL!);
					await page.getByRole("button", { name: /sign in|device|github/i }).first().click();
					let instruction = page.getByText(/Enter one-time code:/);
					await expect(instruction).toBeVisible();
					let code = (await instruction.textContent())!.match(/E2E-\d{4}/)![0]!;
					await writeFile(join(directory, "approval"), code);
					await expect(page.getByRole("button", { name: "octocat", exact: true }))
						.toBeVisible({ timeout: 20_000 });
				},
				restart: async (next = enabled) => {
					await stop();
					enabled = next;
					await start();
				},
			});
		} finally {
			try {
				await stop();
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	},
	room: async ({ demo }, use) => {
		void demo;
		registerTestDatabase(8791, process.env.E2E_DATABASE_URL_3!);
		let room = crypto.randomUUID();
		await createChannel(8791, room);
		await seedChannel(8791, room, "A shared passage for the local demo.\n\nA second paragraph.\n");
		await use(room);
	},
});

export { expect };
