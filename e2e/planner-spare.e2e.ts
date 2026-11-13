/**
 * A new document's Planner on a paired machine: `chopin connect` keeps a spare Planner ready for its
 * checkout's repository, so the document's model selector shows about a second after New document; a
 * Planner command from before spare mode still starts its Planner cold. The machine is a real
 * connector (`apps/connector/src/main.ts connect`, no sandbox) with the backend in
 * spare-planner-backend.ts, against a server of its own under `HARNESS=remote` with a GitHub App.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQL } from "bun";

import { registerTestDatabase } from "./database";
import { GITHUB_APP_ENV } from "./github-app";
import { e2eDatabaseName, e2ePort } from "./ports";
import { authenticate, expect, test } from "./room";
import { HOST, ROOT } from "./servers";

import type { ChildProcess } from "node:child_process";
import type { Page } from "@playwright/test";

const PORT = e2ePort(8807);
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = e2eDatabaseName("chopin_planner_spare");
const BACKEND = join(ROOT, "e2e/spare-planner-backend.ts");

test.describe.configure({ mode: "serial" });

let processes: ChildProcess[] = [];
let scratch: string[] = [];
test.afterEach(async () => {
	for (let child of processes.splice(0)) {
		if (child.exitCode !== null || child.pid === undefined) continue;
		let exit = new Promise<void>(resolve => child.once("close", () => resolve()));
		process.kill(-child.pid, "SIGTERM");
		await exit;
	}
	for (let path of scratch.splice(0)) await rm(path, { recursive: true, force: true });
});

async function server() {
	let cluster = new URL(
		process.env.E2E_DATABASE_URL_3
			|| "postgresql://chopin:chopin@127.0.0.1:5436/chopin?sslmode=disable",
	);
	let own = new URL(cluster);
	own.pathname = `/${DATABASE}`;
	let admin = new SQL(cluster.href);
	try {
		await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
		await admin.unsafe(`CREATE DATABASE ${DATABASE}`);
	} finally {
		await admin.close();
	}
	let env = {
		...process.env,
		SERVER_HOST: HOST,
		PORT: String(PORT),
		APP_ORIGIN: ORIGIN,
		STORAGE_DRIVER: "postgres",
		DATABASE_URL: own.href,
		JEV_API_KEY: "e2e-jev-only",
		GITHUB_APP_SLUG: "chopin-e2e",
		GITHUB_APP_CLIENT_ID: "e2e",
		GITHUB_APP_CLIENT_SECRET: "e2e",
		GITHUB_ALLOWED_USERS: "",
		GITHUB_ALLOWED_ORGANIZATIONS: "githubnext",
		...GITHUB_APP_ENV,
		AGENT: "on",
		HARNESS: "remote",
		BACKGROUND_JOBS: "off",
		WEB_RESEARCH: "off",
		CONVERSATION_PLAN: "off",
		DEV_QUESTIONS: "",
		DEV_COMMENTS: "",
	};
	let migrated = Bun.spawn(["bun", "apps/server/src/storage/migrate.ts"], {
		cwd: ROOT,
		env,
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
		env,
		stdio: ["ignore", "ignore", "pipe"],
	});
	let errors = "";
	child.stderr?.on("data", chunk => {
		errors = (errors + String(chunk)).slice(-2_000);
	});
	processes.push(child);
	for (let index = 0; index < 150; index++) {
		if (child.exitCode !== null) throw new Error(`server exited: ${errors}`);
		try {
			if ((await fetch(`${ORIGIN}/api/session`)).ok) break;
		} catch { /* Not bound yet. */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	registerTestDatabase(PORT, own.href);
}

/** A checkout of octo-org/score, as a person registers with `chopin connect`. */
async function checkout() {
	let root = await mkdtemp(join(tmpdir(), "chopin-spare-e2e-"));
	scratch.push(root);
	let git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
	git("init");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.test");
	git("remote", "add", "origin", "https://github.com/octo-org/score.git");
	await writeFile(join(root, "sample.txt"), "sample");
	git("add", ".");
	git("-c", "commit.gpgsign=false", "commit", "-m", "fixture");
	return root;
}

/**
 * Pair a machine for the person on `page` with a pairing key and run `chopin connect` for a
 * checkout with the Planner command, its backend writing what it did to `log`.
 */
async function connect(page: Page, log: string, stub?: string) {
	await page.goto(`${ORIGIN}/auth/github/connector?key`);
	let minted = await (await page.request.post(`${ORIGIN}/api/connector/pairing-keys`, {
		data: {},
		headers: { origin: ORIGIN },
	})).json() as { key: string };
	let root = await checkout();
	let state = await mkdtemp(join(tmpdir(), "chopin-spare-state-"));
	scratch.push(state);
	let child = spawn(process.execPath, [
		join(ROOT, "apps/connector/src/main.ts"),
		"connect",
		root,
		"--no-sandbox",
		"--key",
		minted.key,
		"--planner-command",
		`${process.execPath} ${BACKEND}`,
		"--",
		process.execPath,
		join(ROOT, "apps/connector/src/testing/fake-agent.ts"),
	], {
		cwd: ROOT,
		detached: true,
		env: {
			...process.env,
			CHOPIN_URL: ORIGIN,
			CHOPIN_CONNECTOR_STATE_DIR: state,
			CHOPIN_SPARE_STUB_LOG: log,
			...(stub ? { CHOPIN_SPARE_STUB: stub } : {}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout!.on("data", chunk => output += String(chunk));
	child.stderr!.on("data", chunk => output += String(chunk));
	processes.push(child);
	/** The connector's spare Planner for octo-org/score, as `chopin status` reads it. */
	let spare = async () => {
		for (let name of await readdir(state).catch(() => [] as string[])) {
			if (!name.endsWith(".spares.json")) continue;
			let states = JSON.parse(await readFile(join(state, name), "utf8").catch(() => "[]"));
			return states[0]?.state as string | undefined;
		}
		return undefined;
	};
	return { spare, output: () => output };
}

async function events(log: string): Promise<Array<{ event: string; document?: string }>> {
	let text = await readFile(log, "utf8").catch(() => "");
	return text.split("\n").filter(Boolean).map(line => JSON.parse(line));
}

/** Press New document in the Projects sidebar; resolves with how long until Chat's model selector. */
async function newDocument(page: Page) {
	await page.goto(ORIGIN);
	let create = page.getByRole("complementary", { name: "Projects", exact: true })
		.getByRole("button", { name: "New document", exact: true });
	await create.waitFor();
	await expect(page.getByRole("button", { name: /^Model: / })).toHaveCount(0);
	// The selector's first frame on screen, timed in the page: a locator's polling is coarser.
	await page.evaluate(() => {
		let w = window as unknown as { __pill?: number; __clicked?: number };
		w.__pill = undefined;
		new MutationObserver(() => {
			if (w.__pill === undefined && document.querySelector("button[aria-label^='Model: ']")) {
				w.__pill = performance.now();
			}
		}).observe(document.body, { subtree: true, childList: true, attributes: true });
		addEventListener("click", () => w.__clicked ??= performance.now(), { capture: true });
	});
	await create.click();
	let pill = page.getByRole("complementary", { name: "Chat", exact: true })
		.getByRole("button", { name: /^Model: / });
	await expect(pill).toBeVisible({ timeout: 30_000 });
	return await page.evaluate(() => {
		let w = window as unknown as { __pill: number; __clicked: number };
		return w.__pill - w.__clicked;
	});
}

async function signedIn(page: Page) {
	await authenticate(page, "mona", ORIGIN);
	let added = await page.request.post(`${ORIGIN}/api/navigation/projects`, {
		data: { owner: "octo-org", repository: "score" },
		headers: { origin: ORIGIN },
	});
	expect([200, 201]).toContain(added.status());
}

test("a new document's Planner starts on the machine's spare, and its model selector shows within about a second", async ({ browser }) => {
	test.setTimeout(180_000);
	await server();
	let page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
	await signedIn(page);
	let log = join(await mkdtemp(join(tmpdir(), "chopin-spare-log-")), "backend.jsonl");
	scratch.push(join(log, ".."));
	let machine = await connect(page, log);
	await expect.poll(machine.spare, { timeout: 60_000 }).toBe("ready");

	let shown = await newDocument(page);
	console.log(`New document → model selector: ${Math.round(shown)} ms`);
	// About 0.6 to 0.75 s on a developer machine, most of it the page's own navigation; the margin is
	// for a slower runner.
	expect(shown).toBeLessThan(1_500);
	// It was the spare: told the document over its stdin, nothing started cold.
	let done = await events(log);
	expect(done.filter(entry => entry.event === "spare").length).toBeGreaterThanOrEqual(1);
	expect(done.filter(entry => entry.event === "assign")).toHaveLength(1);
	expect(done.filter(entry => entry.event === "cold")).toHaveLength(0);
	expect(done.find(entry => entry.event === "attached")?.document)
		.toBe(done.find(entry => entry.event === "assign")?.document);
});

test("a Planner command from before spare mode still starts a new document's Planner cold", async ({ browser }) => {
	test.setTimeout(180_000);
	await server();
	let page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
	await signedIn(page);
	let log = join(await mkdtemp(join(tmpdir(), "chopin-spare-log-")), "backend.jsonl");
	scratch.push(join(log, ".."));
	let machine = await connect(page, log, "old");
	await expect.poll(machine.spare, { timeout: 90_000 }).toBe("unsupported");
	expect(machine.output()).toContain("didn't start as a spare");

	await newDocument(page);
	let done = await events(log);
	expect(done.filter(entry => entry.event === "assign")).toHaveLength(0);
	expect(done.filter(entry => entry.event === "cold")).toHaveLength(1);
});
