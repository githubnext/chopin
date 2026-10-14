/**
 * Chat's machine button says who runs the document's Planner under `HARNESS=remote`: the person's
 * own machine, "Starting…" while its backend has yet to attach, an offline machine, or "Held by
 * @someone" (read-only); a machine without a Planner command can't be chosen in Chat's menu.
 * `HARNESS=remote` needs its own server, so this file starts one against a database of its own.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

import { SQL } from "bun";

import { connectPlannerLink } from "../packages/planner-link/src/client";
import {
	CONNECTOR_PLANNER_COMMAND_HEADER,
	CONNECTOR_PLATFORM_HEADER,
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_VERSION_HEADER,
} from "../packages/protocol/connector";
import { CONNECTOR_PROTOCOL } from "../apps/connector/src/version";
import { createChannel, registerTestDatabase } from "./database";
import { authenticate, expect, ready, roomPath, test } from "./room";
import { RELEASE } from "./release";
import { HOST, ROOT } from "./servers";

import type { Browser, Page } from "@playwright/test";

const PORT = 8794;
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = "chopin_planner_picker";
const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
const PHONE = {
	hasTouch: true,
	isMobile: true,
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 3,
};
/** Set to a directory to keep the screenshots a pull request shows. */
const SHOTS = process.env.CHOPIN_SHOTS;

function databaseUrls() {
	let cluster = new URL(
		process.env.E2E_DATABASE_URL_3
			|| "postgresql://chopin:chopin@127.0.0.1:5436/chopin?sslmode=disable",
	);
	let own = new URL(cluster);
	own.pathname = `/${DATABASE}`;
	return { cluster: cluster.href, own: own.href };
}

async function freshDatabase(): Promise<string> {
	let { cluster, own } = databaseUrls();
	let admin = new SQL(cluster);
	try {
		await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
		await admin.unsafe(`CREATE DATABASE ${DATABASE}`);
	} finally {
		await admin.close();
	}
	return own;
}

const ENV = {
	SERVER_HOST: HOST,
	PORT: String(PORT),
	APP_ORIGIN: ORIGIN,
	STORAGE_DRIVER: "postgres",
	GITHUB_APP_SLUG: "chopin-e2e",
	GITHUB_APP_CLIENT_ID: "e2e",
	GITHUB_APP_CLIENT_SECRET: "e2e",
	GITHUB_ALLOWED_USERS: "",
	GITHUB_ALLOWED_ORGANIZATIONS: "githubnext",
	SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY!,
};

let processes: ReturnType<typeof spawn>[] = [];

// One disposable database and application port for the file.
test.describe.configure({ mode: "default" });

async function remoteServer() {
	let database = await freshDatabase();
	let migrated = Bun.spawn(["bun", "apps/server/src/storage/migrate.ts"], {
		cwd: ROOT,
		env: { ...process.env, ...ENV, DATABASE_URL: database },
		stdout: "ignore",
		stderr: "pipe",
	});
	if (await migrated.exited !== 0) {
		throw new Error(
			`migration failed: ${(await new Response(migrated.stderr).text()).slice(-800)}`,
		);
	}
	let child = spawn(process.execPath, ["--preload", "./e2e/github.ts", "apps/server/src/main.ts"], {
		cwd: ROOT,
		detached: true,
		env: {
			...process.env,
			...ENV,
			DATABASE_URL: database,
			AGENT: "on",
			HARNESS: "remote",
			BACKGROUND_JOBS: "off",
			WEB_RESEARCH: "off",
			CONVERSATION_PLAN: "off",
			DEV_QUESTIONS: "",
			DEV_COMMENTS: "",
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
			throw new Error(`remote Planner server exited with ${child.exitCode}: ${errors.slice(-800)}`);
		}
		try {
			if ((await fetch(`${ORIGIN}/api/session`)).ok) break;
		} catch { /* Not bound yet. */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	return room;
}

test.afterEach(async () => {
	for (let child of processes.splice(0)) {
		if (child.exitCode !== null || child.pid === undefined) continue;
		let exit = new Promise<void>(resolve => child.once("close", () => resolve()));
		process.kill(-child.pid, "SIGTERM");
		await exit;
	}
});

/**
 * Pair a machine for the person signed in on `page` with a pairing key and connect a checkout of
 * octo-org/score, as `chopin connect` does; with `planner`, as `--planner-command` does.
 */
async function machine(page: Page, label: string, planner: boolean) {
	let back = page.url();
	await page.goto(`${ORIGIN}/auth/github/connector?key`);
	await expect(page).toHaveURL(/\/connect\?server$/);
	let minted = await (await page.request.post(`${ORIGIN}/api/connector/pairing-keys`, {
		data: {},
		headers: { origin: ORIGIN },
	})).json() as { key: string };
	let checkout = { repository: "octo-org/score", commit: "a".repeat(40), label };
	let post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
		fetch(new URL(path, ORIGIN), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL),
				[CONNECTOR_VERSION_HEADER]: RELEASE,
				...extra,
			},
			body: JSON.stringify(body),
		});
	let paired = await (await post("/api/connector/pairings", { ...checkout, key: minted.key }))
		.json() as { token: string };
	let opened = await post("/api/connector/connections", checkout, {
		[CONNECTOR_PLATFORM_HEADER]: "linux x64",
		...(planner ? { [CONNECTOR_PLANNER_COMMAND_HEADER]: "1" } : {}),
		authorization: `Bearer ${paired.token}`,
	});
	expect(opened.status, await opened.clone().text()).toBe(200);
	let { token } = await opened.json() as { token: string };
	await page.goto(back);
	return {
		/** The Planner backend Chopin asked the connector to start: a credential, then the link. */
		backend: async (document: string) => {
			let issued = await post("/api/connector/planner", { document }, {
				authorization: `Bearer ${paired.token}`,
			});
			expect(issued.status, await issued.clone().text()).toBe(200);
			let { token: credential } = await issued.json() as { token: string };
			return connectPlannerLink({
				url: ORIGIN,
				token: credential,
				document,
				handlers: { turn() {} },
			});
		},
		/**
		 * The connector's Planner poll, naming the Planners it runs; Chopin answers with the ones
		 * it should run once they differ.
		 */
		poll: async (planners: string[]) => {
			let answer = await (await post("/connector/mcp", {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "wait_for_work", arguments: { planners } },
			}, { authorization: `Bearer ${token}` })).json() as {
				result: { content: Array<{ text: string }> };
			};
			return JSON.parse(answer.result.content[0]!.text);
		},
		/** Ctrl-C in chopin connect. */
		disconnect: () =>
			post("/connector/mcp", {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "disconnect_workspace", arguments: {} },
			}, { authorization: `Bearer ${token}` }),
	};
}

async function open(browser: Browser, handle: string, room: string, options: object) {
	let context = await browser.newContext(options);
	let page = await context.newPage();
	await authenticate(page, handle, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	return page;
}

async function shoot(page: Page, name: string, target?: ReturnType<Page["locator"]>) {
	if (!SHOTS) return;
	await mkdir(SHOTS, { recursive: true });
	await new Promise(resolve => setTimeout(resolve, 400));
	await (target ?? page).screenshot({ path: `${SHOTS}/${name}.png` });
}

test("Chat's machine button says who runs the Planner, and starts it on the machine chosen", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	let page = await open(browser, "mona", room, DESKTOP);
	let studio = await machine(page, "studio", true);
	await machine(page, "desk", false);
	await page.reload();
	await ready(page);
	let composer = page.locator(".chat-composer");
	let chat = composer.getByRole("button", { name: /^Machine: / });
	await expect(chat).toHaveAccessibleName(/^Machine: Automatic/);

	// In Chat's menu, a machine without a Planner command can't be chosen, and says why.
	await chat.click();
	let menu = page.getByRole("menu", { name: "Machine for this document" });
	let desk = menu.getByRole("menuitemradio", { name: /^desk/ });
	await expect(desk).toHaveAttribute("aria-disabled", "true");
	await expect(desk).toContainText("Can't run a Planner");
	await expect(menu.getByRole("menuitemradio", { name: /^studio/ })).not.toHaveAttribute(
		"aria-disabled",
		"true",
	);
	await shoot(page, "planner-chat-menu");

	// Choosing studio asks its connector to start the Planner: Starting…, then studio.
	await menu.getByRole("menuitemradio", { name: /^studio/ }).click();
	await expect(chat).toHaveAccessibleName("Machine: studio, starting the Planner");
	await expect(chat).toContainText("Starting…");
	await shoot(page, "planner-chat-starting", composer);
	// studio's connector is told to start it.
	expect(await studio.poll([])).toEqual({
		kind: "planners",
		planners: [{ id: room, url: expect.stringContaining(ORIGIN) }],
	});
	let link = await studio.backend(room);
	await expect(chat).toHaveAccessibleName("Machine: studio, runs the Planner");
	await expect(chat).toContainText("studio");
	await shoot(page, "planner-chat-attached", composer);

	// studio goes offline: its Planner stops, and the button dims as an offline machine's does.
	await studio.disconnect();
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(chat).toHaveAccessibleName("Machine: studio, offline");
	await expect(chat).toHaveClass(/\bmachine-offline\b/);
	await shoot(page, "planner-chat-offline", composer);
	await link.detach().catch(() => {});

	// Another account attaches its own Planner: Chat's button says who, and opens nothing.
	await authenticate(await (await browser.newContext()).newPage(), "rival", ORIGIN);
	let rival = await connectPlannerLink({
		url: ORIGIN,
		token: "ghu_e2e_rival_1",
		document: room,
		handlers: { turn() {} },
	});
	try {
		let held = composer.getByRole("button", { name: "Planner held by @rival" });
		await expect(held).toHaveAttribute("aria-disabled", "true");
		await expect(held).toContainText("Held by @rival");
		await held.click({ force: true });
		await expect(menu).toHaveCount(0);
		await shoot(page, "planner-chat-held", composer);
		await shoot(page, "planner-desktop-held");
	} finally {
		await rival.detach();
	}
});

test("on a phone, Chat's machine icon names who runs the Planner", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	let page = await open(browser, "mona", room, PHONE);
	let studio = await machine(page, "studio", true);
	await machine(page, "desk", false);
	await page.reload();
	await ready(page);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: "Chat", exact: true }).tap();
	let composer = page.locator(".chat-composer");
	let button = composer.getByRole("button", { name: /^Machine: / });
	await button.tap();
	let sheet = page.getByRole("dialog", { name: "Machine for this document" });
	await expect(sheet.getByRole("menuitemradio", { name: /^desk/ })).toContainText(
		"Can't run a Planner",
	);
	await shoot(page, "planner-phone-sheet");
	await sheet.getByRole("menuitemradio", { name: /^studio/ }).tap();
	await expect(sheet).toBeHidden();
	await expect(button).toHaveAccessibleName("Machine: studio, starting the Planner");
	await page.waitForTimeout(800);
	await shoot(page, "planner-phone-starting");
	expect((await studio.poll([])).planners).toHaveLength(1);
	let link = await studio.backend(room);
	await expect(button).toHaveAccessibleName("Machine: studio, runs the Planner");
	await shoot(page, "planner-phone-attached");
	await link.detach();
});
