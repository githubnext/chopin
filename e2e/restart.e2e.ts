/**
 * A deploy under an open tab: the server stops and a new one starts while a person is typing, and
 * the tab shows nothing, loses nothing and goes on. Restarting needs a server of its own, so this
 * file starts one against a database of its own.
 */
import { spawn } from "node:child_process";

import { SQL } from "bun";

import { RESTART_QUIET_MS } from "../packages/protocol/restart";
import { RESTART_JITTER_MS } from "../apps/web/src/wire-loss";
import { chatInput, expectChatValue } from "./chat-input";
import {
	createChannel,
	readSource,
	registerTestDatabase,
	seedChannel,
	testChannelPath,
} from "./database";
import { authenticate, content, expect, ready, status, test } from "./room";
import { e2eDatabaseName, e2ePort } from "./ports";
import { HOST, ROOT } from "./servers";

import type { Page } from "@playwright/test";

const PORT = e2ePort(8796);
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = e2eDatabaseName("chopin_restart_quiet");

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
	JEV_API_KEY: "e2e-jev-only",
	GITHUB_APP_SLUG: "chopin-e2e",
	GITHUB_APP_CLIENT_ID: "e2e",
	GITHUB_APP_CLIENT_SECRET: "e2e",
	GITHUB_ALLOWED_USERS: "",
	GITHUB_ALLOWED_ORGANIZATIONS: "githubnext",
	SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY!,
	AGENT: "off",
	BACKGROUND_JOBS: "off",
	WEB_RESEARCH: "off",
	CONVERSATION_PLAN: "off",
	DEV_QUESTIONS: "",
	DEV_COMMENTS: "",
};

/** `startedIn` is how long it took from spawning the process to its saying it is ready. */
type Running = { child: ReturnType<typeof spawn>; log: { text: string }; startedIn: number };

/**
 * The longest a restart may leave the page without a server and still be found before the page's
 * quiet period is over. That period runs from the 1012 the page sees, which the old process sends
 * as it releases its lease and exits: until then it serves everything and the page has its socket,
 * and the zero-downtime design's budget counts from the release too. The tests count the outage
 * from that 1012, as the page does, not from the old process's exit, which the test may see
 * later than the page saw the 1012. From the 1012 the page tries at once or within
 * `RESTART_JITTER_MS` and again within a second of each failure, so a server that is back with
 * that much of the period to spare is found while it is still running.
 */
const SILENT_OUTAGE_MS = RESTART_QUIET_MS - RESTART_JITTER_MS;
/** A blip, which the page waits out in 1.5 s with no quiet period: a restart must outlast it. */
const BLIP_MS = 1_500;
/** What a restart is made to take, well inside both bounds whatever the runner's speed. */
const AIMED_OUTAGE_MS = 2_500;

/**
 * How long to leave the server away once the old one has gone, as a platform leaves a gap between
 * stopping one container and starting the next. The new process takes 1.4 s to start on a quick
 * machine and 2.6 to 2.9 s on two cores shared with busy loops, which is where a CI runner measured
 * 4.4 s with a fixed second of gap and the cut's 0.4 s counted in. The 1012 the outage is counted
 * from comes as the old process exits, so the gap and the start are what the outage is made of.
 * No fixed gap keeps a restart over `BLIP_MS` and under `SILENT_OUTAGE_MS` on both, so it is what
 * makes up the difference between the aim and what the first server took to start, which the next
 * takes too.
 */
function gapAfter(first: Running): number {
	return Math.max(0, AIMED_OUTAGE_MS - first.startedIn);
}

let processes: Running[] = [];

// One disposable database and application port for the file.
test.describe.configure({ mode: "default" });

/** SIGTERM, as a deploy sends it, and what the process exited with. */
async function stop(running: Running): Promise<number | null> {
	processes = processes.filter(value => value !== running);
	let { child } = running;
	if (child.exitCode !== null || child.pid === undefined) return child.exitCode;
	let exit = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
	process.kill(-child.pid, "SIGTERM");
	return exit;
}

async function health(path: string): Promise<[number, string]> {
	let response = await fetch(`${ORIGIN}${path}`);
	return [response.status, await response.text()];
}

/** Start Chopin on the file's database and wait until it says it is ready for traffic. */
async function server(database: string): Promise<Running> {
	let child = spawn(process.execPath, ["--preload", "./e2e/github.ts", "apps/server/src/main.ts"], {
		cwd: ROOT,
		detached: true,
		env: { ...process.env, ...ENV, DATABASE_URL: database },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = { text: "" };
	let read = (chunk: Buffer) => {
		log.text = (log.text + String(chunk)).slice(-20_000);
	};
	child.stdout?.on("data", read);
	child.stderr?.on("data", read);
	let spawned = Date.now();
	let running = { child, log, startedIn: 0 };
	processes.push(running);
	for (let index = 0; index < 300; index++) {
		if (child.exitCode !== null) {
			throw new Error(`server exited with ${child.exitCode}: ${log.text.slice(-800)}`);
		}
		try {
			let [code, word] = await health("/api/health/ready");
			if (code === 200 && word === "ready") {
				running.startedIn = Date.now() - spawned;
				return running;
			}
		} catch { /* Not bound yet. */ }
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error("server did not become ready");
}

async function migrated(database: string) {
	let migration = Bun.spawn(["bun", "apps/server/src/storage/migrate.ts"], {
		cwd: ROOT,
		env: { ...process.env, ...ENV, DATABASE_URL: database },
		stdout: "ignore",
		stderr: "pipe",
	});
	if (await migration.exited !== 0) {
		throw new Error(
			`migration failed: ${(await new Response(migration.stderr).text()).slice(-800)}`,
		);
	}
}

type Probe = {
	closes: number[];
	violations: string[];
	timeline: string[];
	watching: boolean;
	/** Whether the page may say it is offline, as it does once a restart has outlasted its quiet. */
	allowOffline: boolean;
	/** When, by `performance.now()`, the first 1012 arrived, the first thing said and the notice. */
	lostAt?: number;
	/** When the first 1012 arrived by `Date.now()`, a clock the test shares with the page. */
	lostAtWall?: number;
	saidAt?: number;
	noticeAt?: number;
};

/**
 * Record, in the page itself, every code a socket closes with and anything the page says about
 * the connection while watching: sampled every 25 ms, so no notice can come and go unseen. The
 * document's one offline notice and its polite word once it has gone are among what is watched.
 */
async function watch(page: Page) {
	await page.addInitScript(() => {
		let probe: Probe = {
			closes: [],
			violations: [],
			timeline: [],
			watching: false,
			allowOffline: false,
		};
		let at = () => Math.round(performance.now());
		(window as unknown as { probe: Probe }).probe = probe;
		let Native = window.WebSocket;
		window.WebSocket = class extends Native {
			constructor(url: string | URL, protocols?: string | string[]) {
				super(url, protocols);
				this.addEventListener("open", () => probe.timeline.push(`${at()} open`));
				this.addEventListener("close", event => {
					probe.closes.push(event.code);
					probe.timeline.push(`${at()} close ${event.code}`);
					if (event.code === 1012) {
						probe.lostAt ??= at();
						probe.lostAtWall ??= Date.now();
					}
				});
			}
		} as typeof WebSocket;
		setInterval(() => {
			if (!probe.watching) return;
			let say = (what: string) => {
				probe.violations.push(what);
				probe.saidAt ??= at();
				probe.timeline.push(`${at()} ${what}`);
			};
			let level = document.querySelector(".plan-status")?.getAttribute("data-level");
			if (level && level !== "hidden") say(`status ${level}`);
			// The error line, such as "Message not sent", as opposed to the composer's quiet notes.
			let failure = document.querySelector(".composer-notice.motion-feedback, [data-error-banner]")
				?.textContent?.trim();
			if (failure) say(`composer error ${failure}`);
			if (document.querySelector(".plan[data-plan-offline]")) say("locked");
			if (document.querySelector(".plan-content")?.getAttribute("contenteditable") === "false") {
				say("not editable");
			}
			// The one banner for a lost connection, and the words said as its phases change.
			if (document.querySelector("[data-connection-banner]")) {
				probe.noticeAt ??= at();
				if (!probe.allowOffline) say("offline notice");
			}
			let spoken = document.querySelector("[data-connection-status]")?.textContent?.trim();
			if (spoken && !probe.allowOffline) say(`offline status ${spoken}`);
		}, 25);
	});
}

function probe(page: Page) {
	return page.evaluate(() => (window as unknown as { probe: Probe }).probe);
}

/**
 * How long the page was without a server: from the 1012 it saw, its first sign of the loss, to
 * `readyAt`, when the test saw the new server ready. Both are `Date.now()` of one machine.
 */
async function outageFrom1012(page: Page, readyAt: number): Promise<number> {
	let { lostAtWall } = await probe(page);
	expect(lostAtWall, "the page saw no 1012").toBeDefined();
	return readyAt - lostAtWall!;
}

/** Every error the page raises, as it fills. */
function collectErrors(page: Page) {
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	return errors;
}

/**
 * A deploy, as a tab can tell: it asks the server for its page, and the page names another entry
 * script than the one the tab runs. Only that answer is changed, never the page the tab loads, and
 * a server that does not answer is not made to.
 */
async function deployed(page: Page) {
	await page.route(`${ORIGIN}/**`, async route => {
		let request = route.request();
		let own = new URL(page.url());
		own.hash = "";
		if (request.resourceType() !== "fetch" || request.url() !== own.href) return route.fallback();
		try {
			let response = await route.fetch();
			let html = (await response.text()).replace(
				/(<script[^>]*type="module"[^>]*src=")[^"]+/,
				"$1/assets/index-NextBuild1.js",
			);
			await route.fulfill({ response, body: html });
		} catch {
			await route.abort();
		}
	});
}

test.afterEach(async () => {
	for (let running of [...processes].toReversed()) await stop(running);
});

test("a restart under an open tab shows nothing, loses no edit and keeps the draft", async ({ page }) => {
	test.setTimeout(120_000);
	let database = await freshDatabase();
	await migrated(database);
	let first = await server(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	await seedChannel(PORT, room, "# Restart tracer\n\nSteady text.\n");

	let loads = 0;
	let errors = collectErrors(page);
	page.on("load", () => loads++);
	await watch(page);
	await authenticate(page, `ana-${crypto.randomUUID().slice(0, 8)}`, ORIGIN);
	await page.goto(`${ORIGIN}${testChannelPath(room)}`);
	await ready(page);
	expect(await health("/api/health/live")).toEqual([200, "live"]);
	expect(await health("/api/health/ready")).toEqual([200, "ready"]);

	let chat = page.getByRole("complementary", { name: "Chat", exact: true });
	let draft = "A message for the team, not sent yet";
	await chatInput(chat).fill(draft);
	await content(page).click();
	await content(page).press("ControlOrMeta+End");
	await page.evaluate(() => {
		(window as unknown as { tab: string }).tab = "kept";
		(window as unknown as { probe: Probe }).probe.watching = true;
	});

	// Typing goes on all the while: numbered words, each of which must arrive exactly once.
	const WORDS = 50;
	let typing = (async () => {
		for (let word = 0; word < WORDS; word++) {
			await page.keyboard.type(`w${word} `);
			await page.waitForTimeout(100);
		}
	})();
	await page.waitForTimeout(1_000);
	let code = await stop(first);
	await new Promise(resolve => setTimeout(resolve, gapAfter(first)));
	let second = await server(database);
	let readyAt = Date.now();
	await typing;

	expect(code, first.log.text).toBe(0);
	expect(await health("/api/health/ready")).toEqual([200, "ready"]);
	let outage = await outageFrom1012(page, readyAt);
	// Longer than a blip, which the page waits out in 1.5 s, and quicker than it waits for a restart.
	expect(outage, second.log.text).toBeGreaterThan(BLIP_MS);
	expect(outage, second.log.text).toBeLessThan(SILENT_OUTAGE_MS);

	await expect(status(page)).toHaveAttribute("data-level", "hidden");
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
	let seen = await probe(page);
	// The server said it was restarting, in so many words, rather than going away.
	expect(seen.closes).toContain(1012);
	expect(seen.closes).not.toContain(1001);
	expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
	expect(errors).toEqual([]);
	expect(loads).toBe(1);
	expect(await page.evaluate(() => (window as unknown as { tab?: string }).tab)).toBe("kept");
	await expectChatValue(chatInput(chat), draft);

	await expect.poll(() => readSource(PORT, room), { timeout: 20_000 }).toContain(`w${WORDS - 1}`);
	let words = [...(await readSource(PORT, room)).matchAll(/\bw(\d+)\b/g)].map(match =>
		Number(match[1])
	);
	expect(words).toEqual(Array.from({ length: WORDS }, (_, index) => index));
});

test("a restart that outlasts its quiet period is then told as any other lost connection, and that goes when the server is back", async ({ page }) => {
	test.setTimeout(120_000);
	let database = await freshDatabase();
	await migrated(database);
	let first = await server(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	await seedChannel(PORT, room, "# A long restart\n\nSteady text.\n");

	await watch(page);
	await authenticate(page, `ana-${crypto.randomUUID().slice(0, 8)}`, ORIGIN);
	await page.goto(`${ORIGIN}${testChannelPath(room)}`);
	await ready(page);
	await content(page).click();
	await content(page).press("ControlOrMeta+End");
	await page.evaluate(() => {
		let { probe } = window as unknown as { probe: Probe };
		probe.allowOffline = true;
		probe.watching = true;
	});

	let code = await stop(first);
	expect(code, first.log.text).toBe(0);

	// Nothing is said for the quiet period, and after it the one banner, as for any other loss,
	// once its own moment of grace has passed.
	let notice = page.locator("[data-connection-banner]");
	await expect(notice).toBeVisible({ timeout: 20_000 });
	let seen = await probe(page);
	expect(seen.closes).toContain(1012);
	expect(seen.lostAt).toBeDefined();
	expect(seen.saidAt! - seen.lostAt!, seen.timeline.join("\n")).toBeGreaterThanOrEqual(
		RESTART_QUIET_MS,
	);
	expect(seen.noticeAt! - seen.lostAt!, seen.timeline.join("\n")).toBeLessThan(
		RESTART_QUIET_MS + 4_000,
	);

	// It says it is back, once, for the few seconds the banner stays, and then it is gone.
	let second = await server(database);
	await expect(page.locator("[data-connection-status]")).toHaveText(
		"Back online. Your changes are synced",
		{ timeout: 20_000 },
	);
	await expect(notice).toHaveCount(0, { timeout: 20_000 });
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
	expect(await health("/api/health/ready"), second.log.text).toEqual([200, "ready"]);
});

/** How many times `text` is in what the room has stored, chat included. */
async function stored(database: string, room: string, text: string): Promise<number> {
	let connection = new SQL(database);
	try {
		let [row] = await connection<{ body: string }[]>`
			SELECT sidecar::text AS body FROM channel_state WHERE channel_id = ${room}
		`;
		return row ? row.body.split(text).length - 1 : 0;
	} finally {
		await connection.close();
	}
}

for (let reached of [true, false]) {
	test(`a message being sent as the server restarts, ${reached ? "one it had already taken" : "one it never read"}, is sent again once it is back and arrives once`, async ({ page }) => {
		test.setTimeout(120_000);
		let database = await freshDatabase();
		await migrated(database);
		let first = await server(database);
		registerTestDatabase(PORT, database);
		let room = crypto.randomUUID();
		await createChannel(PORT, room);
		await seedChannel(PORT, room, "# In flight\n\nSteady text.\n");

		// Between the page and the server: while `cut` holds, a send either goes unread, or is
		// taken and its answer is lost with the connection, as when the server stops mid-request.
		let cut = { on: false };
		let sent: Array<{ requestId?: string }> = [];
		let lost = 0;
		await page.routeWebSocket("**/ws?**", socket => {
			let upstream = socket.connectToServer();
			socket.onMessage(message => {
				let frame = typeof message === "string"
					? JSON.parse(message) as { kind?: string; requestId?: string }
					: {};
				if (frame.kind === "chat:send") {
					sent.push(frame);
					if (cut.on && !reached) return;
				}
				upstream.send(message);
			});
			upstream.onMessage(message => {
				let kind = typeof message === "string"
					? (JSON.parse(message) as { kind?: string }).kind
					: "";
				if (cut.on && reached && kind === "chat:send") {
					lost++;
					return;
				}
				socket.send(message);
			});
			socket.onClose((code, reason) => void upstream.close({ code, reason }));
			upstream.onClose((code, reason) => void socket.close({ code, reason }));
		});

		let loads = 0;
		let errors = collectErrors(page);
		page.on("load", () => loads++);
		await watch(page);
		await authenticate(page, `ana-${crypto.randomUUID().slice(0, 8)}`, ORIGIN);
		await page.goto(`${ORIGIN}${testChannelPath(room)}`);
		await ready(page);

		let chat = page.getByRole("complementary", { name: "Chat", exact: true });
		let message = `Sent as the server restarted ${crypto.randomUUID().slice(0, 8)}`;
		await page.evaluate(() => {
			(window as unknown as { probe: Probe }).probe.watching = true;
		});
		cut.on = true;
		await chatInput(chat).fill(message);
		await chatInput(chat).press("Enter");
		await expect.poll(() => reached ? lost : sent.length, { timeout: 10_000 }).toBe(1);
		if (reached) expect(await stored(database, room, message)).toBe(1);

		let code = await stop(first);
		cut.on = false;
		await new Promise(resolve => setTimeout(resolve, gapAfter(first)));
		let second = await server(database);
		let readyAt = Date.now();

		// The message is sent again, under the same request, and the draft goes once it is taken.
		await expectChatValue(chatInput(chat), "");
		await expect(chat.getByText(message, { exact: true })).toHaveCount(1);
		expect(code, first.log.text).toBe(0);
		expect(await outageFrom1012(page, readyAt), second.log.text).toBeLessThan(SILENT_OUTAGE_MS);
		expect(sent).toHaveLength(2);
		expect(sent[1]!.requestId).toBeTruthy();
		expect(sent[1]!.requestId).toBe(sent[0]!.requestId);
		expect(await stored(database, room, message)).toBe(1);

		await expect(status(page)).toHaveAttribute("data-level", "hidden");
		let seen = await probe(page);
		expect(seen.closes).toContain(1012);
		expect(seen.closes).not.toContain(1001);
		expect(seen.violations, seen.timeline.join("\n")).toEqual([]);
		expect(errors).toEqual([]);
		expect(loads).toBe(1);
	});
}

test("an asset of a build that is gone answers 404, and a tab reloads for it only when it holds nothing", async ({ page }) => {
	test.setTimeout(90_000);
	let database = await freshDatabase();
	await migrated(database);
	await server(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	await seedChannel(PORT, room, "# Old build\n\nSteady text.\n");

	let gone = await page.request.get(`${ORIGIN}/assets/old-chunk-Ab12Cd34.js`);
	expect(gone.status()).toBe(404);
	expect(gone.headers()["content-type"]).not.toContain("text/html");
	let entry = (await (await page.request.get(ORIGIN)).text()).match(/\/assets\/[^"]+\.js/)![0];
	let present = await page.request.get(`${ORIGIN}${entry}`);
	expect(present.status()).toBe(200);
	expect(present.headers()["cache-control"]).toContain("immutable");

	let loads = 0;
	page.on("load", () => loads++);
	await authenticate(page, `ana-${crypto.randomUUID().slice(0, 8)}`, ORIGIN);
	await page.goto(`${ORIGIN}${testChannelPath(room)}`);
	await ready(page);
	await page.evaluate(() => {
		(window as unknown as { tab: string }).tab = "kept";
	});
	let preloadError = () =>
		page.evaluate(() => {
			window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
		});

	// With the same build still served there is nothing to fetch, so a failure is left to the
	// page's own recovery, whatever the reason for it.
	await preloadError();
	await page.waitForTimeout(1_000);
	expect(loads).toBe(1);

	// An unsent message is work a reload would lose, so the failure is left to run its course.
	await deployed(page);
	let chat = page.getByRole("complementary", { name: "Chat", exact: true });
	await chatInput(chat).fill("A message not sent yet");
	await preloadError();
	await page.waitForTimeout(1_000);
	expect(loads).toBe(1);
	expect(await page.evaluate(() => (window as unknown as { tab?: string }).tab)).toBe("kept");

	// Once nothing is held, the next failure reloads the tab onto the new build.
	await chatInput(chat).fill("");
	let reloaded = page.waitForEvent("load");
	await preloadError();
	await reloaded;
	await ready(page);
	expect(loads).toBe(2);
	expect(await page.evaluate(() => (window as unknown as { tab?: string }).tab)).toBeUndefined();

	// A failure straight after is not answered with another reload, which would never end.
	await preloadError();
	await page.waitForTimeout(1_000);
	expect(loads).toBe(2);
});

test("a tab holding a reply or a research question typed into the document is not reloaded for a chunk that is gone", async ({ page }) => {
	test.setTimeout(90_000);
	let database = await freshDatabase();
	await migrated(database);
	await server(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	await seedChannel(PORT, room, "# Held\n\nThe rollout goes team by team.\n");

	let loads = 0;
	page.on("load", () => loads++);
	await authenticate(page, `ana-${crypto.randomUUID().slice(0, 8)}`, ORIGIN);
	await page.goto(`${ORIGIN}${testChannelPath(room)}`);
	await ready(page);
	await deployed(page);
	let preloadError = () =>
		page.evaluate(() => {
			window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
		});

	// A comment, and a reply to it begun and not sent.
	await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
	await content(page).locator("p", { hasText: "team by team" }).first().selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let card = page.getByRole("dialog", { name: "New comment" });
	await card.getByRole("textbox", { name: "Comment" }).fill("Who goes first?");
	await card.getByRole("button", { name: "Post comment", exact: true }).click();
	await expect(card).toHaveCount(0);
	await page.getByRole("button", { name: /^Comment on “The rollout goes team by team/ }).click();
	let thread = page.getByRole("dialog", { name: "Comment thread" });
	let reply = thread.getByRole("textbox", { name: "Reply", exact: true });
	await expect(thread).toContainText("Who goes first?");
	await reply.fill("The docs team, I think.");
	await preloadError();
	await page.waitForTimeout(1_000);
	expect(loads).toBe(1);

	// Sent, it is the server's, and the field holds nothing.
	await reply.press("Enter");
	await expect(thread).toContainText("The docs team, I think.");
	await expect(reply).toHaveValue("");

	// A research question typed into the document and not started.
	await content(page).focus();
	await page.keyboard.press("ControlOrMeta+End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("/research");
	await page.getByRole("listbox", { name: "Insert block" })
		.getByRole("option", { name: "Research", exact: true })
		.click();
	let question = page.getByRole("region", { name: "Research question", exact: true })
		.getByRole("textbox", { name: "Research question", exact: true });
	await question.fill("Which teams have shipped this before?");
	await preloadError();
	await page.waitForTimeout(1_000);
	expect(loads).toBe(1);

	// Put away, nothing is held and the next failure reloads the tab onto the new build.
	await question.press("Escape");
	await expect(question).toHaveCount(0);
	let reloaded = page.waitForEvent("load");
	await preloadError();
	await reloaded;
	expect(loads).toBe(2);
});

test("a chunk that fails while the server is away does not reload the tab into the outage", async ({ page }) => {
	test.setTimeout(90_000);
	let database = await freshDatabase();
	await migrated(database);
	let first = await server(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	await seedChannel(PORT, room, "# Away\n\nSteady text.\n");

	let loads = 0;
	page.on("load", () => loads++);
	await authenticate(page, `ana-${crypto.randomUUID().slice(0, 8)}`, ORIGIN);
	await page.goto(`${ORIGIN}${testChannelPath(room)}`);
	await ready(page);
	await page.evaluate(() => {
		(window as unknown as { tab: string }).tab = "kept";
	});

	// Nothing is unsent and another build would be served, but the server is gone: a reload now
	// would land on the browser's error page.
	await deployed(page);
	await stop(first);
	await page.evaluate(() => {
		window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
	});
	await page.waitForTimeout(2_000);
	expect(loads).toBe(1);
	expect(await page.evaluate(() => (window as unknown as { tab?: string }).tab)).toBe("kept");

	await server(database);
	await expect(status(page)).toHaveAttribute("data-level", "hidden", { timeout: 20_000 });
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
	expect(loads).toBe(1);
});

test("a chunk a deploy removed reloads the tab once and not for ever", async ({ page }) => {
	test.setTimeout(90_000);
	let database = await freshDatabase();
	await migrated(database);
	await server(database);
	registerTestDatabase(PORT, database);

	// What the server answers for a file of the build before it, which this one does not carry.
	await deployed(page);
	await page.route(
		"**/assets/project-sidebar-*.js",
		route => route.fulfill({ status: 404, contentType: "text/plain", body: "not found" }),
	);
	let loads = 0;
	page.on("load", () => loads++);
	await authenticate(page, `ana-${crypto.randomUUID().slice(0, 8)}`, ORIGIN);
	await page.goto(ORIGIN);
	await expect.poll(() => loads, { timeout: 15_000 }).toBe(2);
	await page.waitForTimeout(3_000);
	expect(loads).toBe(2);
});
