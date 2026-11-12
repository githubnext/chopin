/**
 * A thread's replies to an attached Planner, watched by two people: one in the thread and one in
 * the top-level Chat. A reply to `@chopin` is answered in the thread, in a session forked from the
 * one that answered the thread's root when the client offers `session-forks`, and in an ordinary
 * session told the conversation up to the root when it does not. A reply sent with Also send to
 * Chat has its answer stream into both places, fail in both, and run again in both, while the
 * turn stays the thread's: the top-level Planner reads the reply and its answer only as two lines
 * of Chat, and never a reply that stayed in the thread.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

import { SQL } from "bun";

import { connectAgent } from "../packages/agent-link/src/client";
import { finishTurn } from "../apps/server/src/testing/agent-link";
import { chatInput, fillChat } from "./chat-input";
import { createChannel, registerTestDatabase } from "./database";
import { e2eDatabaseName, e2ePort } from "./ports";
import { authenticate, expect, ready, roomPath, test } from "./room";
import { HOST, ROOT } from "./servers";

import type { Browser, Locator, Page } from "@playwright/test";
import type { ServerMessageOf } from "../packages/agent-link/src/protocol";

const PORT = e2ePort(8806);
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = e2eDatabaseName("chopin_thread_replies");
const DESKTOP = { viewport: { width: 1600, height: 900 } };
/** Set to a directory to keep the screenshots a pull request shows. */
const SHOTS = process.env.CHOPIN_SHOTS;

async function shoot(page: Page, name: string) {
	if (!SHOTS) return;
	await mkdir(SHOTS, { recursive: true });
	await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

function databaseUrls() {
	let cluster = new URL(
		process.env.E2E_DATABASE_URL_3
			|| "postgresql://chopin:chopin@127.0.0.1:5436/chopin?sslmode=disable",
	);
	let own = new URL(cluster);
	own.pathname = `/${DATABASE}`;
	return { cluster: cluster.href, own: own.href };
}

const ENV = {
	SERVER_HOST: HOST,
	PORT: String(PORT),
	APP_ORIGIN: ORIGIN,
	STORAGE_DRIVER: "postgres",
	JEV_API_KEY: "e2e-jev-only",
	GITHUB_APP_SLUG: "chopin-e2e",
	GITHUB_APP_CLIENT_ID: "e2e",
	GITHUB_APP_CLIENT_SECRET: "e2e",
	GITHUB_ALLOWED_USERS: "",
	GITHUB_ALLOWED_ORGANIZATIONS: "githubnext",
	SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY!,
};

let server: ReturnType<typeof spawn> | undefined;

test.describe.configure({ mode: "default" });

test.beforeAll(async () => {
	let { cluster, own } = databaseUrls();
	let admin = new SQL(cluster);
	try {
		await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
		await admin.unsafe(`CREATE DATABASE ${DATABASE}`);
	} finally {
		await admin.close();
	}
	let migrated = Bun.spawn(["bun", "apps/server/src/storage/migrate.ts"], {
		cwd: ROOT,
		env: { ...process.env, ...ENV, DATABASE_URL: own },
		stdout: "ignore",
		stderr: "pipe",
	});
	if (await migrated.exited !== 0) {
		throw new Error(
			`migration failed: ${(await new Response(migrated.stderr).text()).slice(-800)}`,
		);
	}
	let child = spawn(process.execPath, [
		"--preload",
		"./e2e/github.ts",
		"--preload",
		"./e2e/jev.ts",
		"apps/server/src/main.ts",
	], {
		cwd: ROOT,
		detached: true,
		env: {
			...process.env,
			...ENV,
			DATABASE_URL: own,
			AGENT: "on",
			HARNESS: "remote",
			DECISIONS_MODEL: "typesafe/jev-latest",
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
	server = child;
	for (let index = 0; index < 150; index++) {
		if (child.exitCode !== null) {
			throw new Error(`thread replies server exited with ${child.exitCode}: ${errors.slice(-800)}`);
		}
		try {
			if ((await fetch(`${ORIGIN}/api/session`)).ok) break;
		} catch { /* Not bound yet. */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	registerTestDatabase(PORT, own);
});

test.afterAll(async () => {
	let child = server;
	server = undefined;
	if (!child || child.exitCode !== null || child.pid === undefined) return;
	let exit = new Promise<void>(resolve => child.once("close", () => resolve()));
	process.kill(-child.pid, "SIGTERM");
	await exit;
});

type Turn = ServerMessageOf<"turn">;

/**
 * A scripted Planner on its own link. It answers "Main answer." to the first top-level message,
 * "Done." to anything else, answers a prompt saying SLOW in two messages with `release` between
 * them, and fails the first prompt saying FAIL after a partial reply. Chopin shows each message of
 * a reply once it is whole and checked, so the first shows while the turn still runs. With `forks`
 * it offers `session-forks` and accepts every fork.
 */
async function attachPlanner(room: string, forks: boolean) {
	let turns: Turn[] = [];
	let opened: Array<ServerMessageOf<"start"> | ServerMessageOf<"fork">> = [];
	let held = Promise.withResolvers<void>();
	let failed = false;
	let text = (
		context: Parameters<Parameters<typeof connectAgent>[0]["handlers"]["turn"]>[0],
		delta: string,
		id = "reply",
	) => {
		context.emit({ type: "text-delta", id, delta });
	};
	let client = await connectAgent({
		url: ORIGIN,
		token: "ghu_e2e_mona_1",
		document: room,
		resumable: false,
		retryTurns: true,
		sessionForks: forks,
		handlers: {
			start(message) {
				opened.push(message);
			},
			...(forks
				? {
					fork(message: ServerMessageOf<"fork">) {
						opened.push(message);
					},
				}
				: {}),
			async turn(context) {
				let { prompt } = context.message;
				turns.push(context.message);
				context.emit({ type: "stream-start", modelId: "scripted" });
				context.emit({ type: "text-start", id: "reply" });
				if (prompt.includes("FAIL") && !failed) {
					failed = true;
					text(context, "Half an answer");
					context.emit({ type: "text-end", id: "reply" });
					context.end("failed", "The provider went away.");
					return;
				}
				if (prompt.includes("SLOW")) {
					text(context, "Partial thread answer.");
					context.emit({ type: "text-end", id: "reply" });
					await held.promise;
					context.emit({ type: "text-start", id: "more" });
					text(context, "Finished thread answer.", "more");
					context.emit({ type: "text-end", id: "more" });
					finishTurn(context);
					return;
				} else if (prompt.includes("FAIL")) {
					text(context, "Recovered answer.");
				} else {
					text(context, turns.length === 1 ? "Main answer." : "Done.");
				}
				context.emit({ type: "text-end", id: "reply" });
				finishTurn(context);
			},
		},
	});
	return { client, turns, opened, release: () => held.resolve() };
}

async function open(browser: Browser, handle: string, room: string) {
	let context = await browser.newContext(DESKTOP);
	let page = await context.newPage();
	await authenticate(page, handle, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	return page;
}

function main(page: Page): Locator {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" })
		.locator(".chat-split-main");
}

function thread(page: Page): Locator {
	return page.locator("[data-thread-panel]");
}

function message(scope: Locator, text: string | RegExp): Locator {
	return scope.locator(".chat-message-body", { hasText: text });
}

async function say(scope: Locator, text: string): Promise<void> {
	let input = chatInput(scope);
	await fillChat(input, text);
	await scope.getByRole("button", { name: "Send message" }).click();
}

/** The turn that answered `text`, and the session it ran in. */
function turnFor(turns: Turn[], text: string): Turn {
	// A background job's turn for the same document quotes the conversation too.
	let found = turns.findLast(turn =>
		turn.prompt.includes(text) && !turn.prompt.startsWith("[Background")
	);
	if (!found) throw new Error(`no turn answered ${text}`);
	return found;
}

for (let forks of [true, false]) {
	let client = forks ? "a client with session-forks" : "a client without session-forks";
	test(`with ${client}, a thread reply sent to Chat streams its answer in both places, fails and is retried in both, and the top-level Planner reads only what was sent to Chat`, async ({ browser }) => {
		test.setTimeout(120_000);
		let room = crypto.randomUUID();
		await createChannel(PORT, room);
		// The machine attaches as mona, who has signed in to Chopin in a browser.
		let mona = await open(browser, "mona", room);
		let bo = await open(browser, "bo", room);
		let planner = await attachPlanner(room, forks);
		try {
			await say(main(mona), "@chopin Main question");
			await expect(message(main(bo), "Main answer.")).toBeVisible();
			let mainSession = turnFor(planner.turns, "Main question").session;

			let root = message(main(mona), "Main answer.");
			await root.hover();
			await root.getByRole("button", { name: "Reply in thread" }).click();
			await expect(thread(mona)).toBeVisible();

			// Sent to Chat: the answer streams into the thread and into bo's Chat at once, each of its
			// messages as soon as it is shown in the thread, while the turn still runs.
			await thread(mona).getByLabel("Also send to Chat").check();
			await say(thread(mona), "@chopin SLOW also question");
			await expect(message(thread(mona), "Partial thread answer.")).toBeVisible();
			let mode = forks ? "forks" : "no-forks";
			await shoot(mona, `${mode}-thread-streaming`);
			await shoot(bo, `${mode}-chat-streaming`);
			await expect(message(main(bo), "SLOW also question")).toBeVisible();
			await expect(message(main(bo), "Partial thread answer.")).toBeVisible();
			await expect(message(main(bo), "Finished thread answer.")).toHaveCount(0);
			planner.release();
			await expect(message(thread(mona), "Finished thread answer.")).toBeVisible();
			await expect(message(main(bo), "Finished thread answer.")).toBeVisible();
			let reply = (scope: Locator) =>
				scope.locator("[data-chat-message-text]", { hasText: /thread answer/ }).allInnerTexts();
			expect(await reply(main(bo))).toEqual(await reply(thread(mona)));

			// The turn ran in the thread's session: forked from the main session's, or started.
			let also = turnFor(planner.turns, "SLOW also question");
			expect(also.session).not.toBe(mainSession);
			let threadOpened = planner.opened.find(value => value.session === also.session)!;
			expect(threadOpened.type).toBe(forks ? "fork" : "start");
			if (threadOpened.type === "fork") expect(threadOpened.from.session).toBe(mainSession);

			// Not sent to Chat: answered in the thread alone.
			await say(thread(mona), "@chopin SECRET thread only");
			await expect(message(thread(mona), "SECRET thread only")).toBeVisible();
			await expect.poll(() => planner.turns.some(turn => turn.prompt.includes("SECRET"))).toBe(
				true,
			);
			await expect(thread(mona).locator(".chat-message-body", { hasText: "Done." })).toHaveCount(1);
			let secret = turnFor(planner.turns, "SECRET thread only");

			// Sent to Chat and failed: the failure shows in both, and its sender retries it in the thread.
			await thread(mona).getByLabel("Also send to Chat").check();
			await say(thread(mona), "@chopin FAIL once please");
			let threadFailure = thread(mona).locator('[data-slot="error-state"]');
			await expect(threadFailure).toContainText("The provider went away.");
			await expect(message(main(bo), "Half an answer")).toBeVisible();
			let mainFailure = bo.locator('.chat-composer [data-slot="error-state"]').first();
			await expect(mainFailure).toContainText("The provider went away.");
			await expect(mainFailure.getByRole("button", { name: "Retry" })).toHaveCount(0);
			await shoot(mona, `${mode}-thread-failed`);
			await shoot(bo, `${mode}-chat-failed`);
			let failedTurn = turnFor(planner.turns, "FAIL once please");
			await threadFailure.getByRole("button", { name: "Retry", exact: true }).click();
			await expect(message(thread(mona), "Recovered answer.")).toBeVisible();
			await expect(message(main(bo), "Recovered answer.")).toBeVisible();
			await expect(message(thread(mona), "Half an answer")).toHaveCount(0);
			await expect(message(main(bo), "Half an answer")).toHaveCount(0);
			await expect(threadFailure).toHaveCount(0);
			await expect(mainFailure).toHaveCount(0);
			await shoot(mona, `${mode}-thread-retried`);
			await shoot(bo, `${mode}-chat-retried`);
			let retried = planner.turns.findLast(turn => turn.retry === true)!;
			expect(retried.retry).toBe(true);
			expect(retried.message).toBe(failedTurn.message);
			let retriedOpened = planner.opened.find(value => value.session === retried.session)!;
			if (forks) {
				// The Retry forks where the thread stood before the failed attempt.
				expect(retriedOpened.type).toBe("fork");
				expect(retriedOpened.type === "fork" && retriedOpened.from.turn).toBe(secret.turn);
			}

			// A reaction on the copy in Chat is Chat's like any other.
			let copy = main(bo).locator("[data-chat-message-id]", { hasText: "Recovered answer." });
			await copy.hover();
			await copy.getByRole("toolbar", { name: "Reactions and actions" })
				.getByRole("button", { name: "Add reaction" }).click();
			let picker = bo.getByRole("dialog", { name: "Add reaction" });
			await picker.getByRole("textbox", { name: "Search emoji, or paste one" }).fill("tada");
			await picker.getByRole("button", { name: "🎉" }).first().click();
			await expect(copy.getByRole("button", { name: "You reacted with 🎉" })).toBeVisible();

			// The top-level Planner reads what was sent to Chat as Chat, and nothing else of the thread.
			await say(main(bo), "@chopin Main next");
			await expect(message(main(bo), "Done.")).toBeVisible();
			let next = turnFor(planner.turns, "Main next");
			expect(next.session).not.toBe(also.session);
			expect(planner.opened.find(value => value.session === next.session)?.type).toBe("start");
			expect(next.instructions).toContain("SLOW also question");
			expect(next.instructions).toContain("Finished thread answer.");
			expect(next.instructions).toContain("Recovered answer.");
			expect(next.instructions).not.toContain("SECRET");
			expect(next.instructions).not.toContain("Half an answer");
		} finally {
			planner.release();
			await planner.client.detach();
			await mona.context().close();
			await bo.context().close();
		}
	});
}
