/**
 * The document's Chat says who holds its remote Planner, live, as a client
 * attaches over the real agent connection, detaches into its grace period, and the
 * grace period ends. `HARNESS=remote` needs its own server, so this file starts
 * one against a database of its own, created beside local-auth's.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";

import { SQL } from "bun";

import { connectAgent } from "../packages/agent-link/src/client";
import { chatInput, fillChat } from "./chat-input";
import {
	allBanners,
	bannerEntrances,
	connectionBanner,
	RESUMED_WAIT,
	watchBanners,
} from "./banner";
import { height, inBetween } from "./motion";
import {
	address,
	announced,
	expectNoMachineWords,
	expectNoPlanner,
	expectPlannerAttached,
	expectSaidOnce,
	heard,
	listenForAnnouncements,
	NONE,
	strip,
} from "./planner-status";
import { trace } from "./motion";
import { createChannel, registerTestDatabase, seedChannel } from "./database";
import { authenticate, content, expect, ready, roomPath, test } from "./room";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";
import { e2eDatabaseName, e2ePort } from "./ports";
import { HARNESS, HOST, ROOT } from "./servers";

import type { BrowserContext, Locator, Page, WebSocketRoute } from "@playwright/test";
import type { AgentClient, AgentHandlers } from "../packages/agent-link/src/client";

const PORT = e2ePort(8793);
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = e2eDatabaseName("chopin_planner_attachment");
const GRACE_MS = 8_000;
const HANDLE = "mona";

/** Local-auth's PostgreSQL service, which this file shares under another database name. */
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
};

async function migrate(database: string): Promise<void> {
	let child = Bun.spawn(["bun", "apps/server/src/storage/migrate.ts"], {
		cwd: ROOT,
		env: { ...process.env, ...ENV, DATABASE_URL: database },
		stdout: "ignore",
		stderr: "pipe",
	});
	if (await child.exited !== 0) {
		throw new Error(`migration failed: ${(await new Response(child.stderr).text()).slice(-800)}`);
	}
}

let processes: ReturnType<typeof spawn>[] = [];

// The remote-Planner tests share one disposable database and application port.
test.describe.configure({ mode: "default" });

async function remoteServer(database: string) {
	let child = spawn(process.execPath, ["--preload", "./e2e/github.ts", "apps/server/src/main.ts"], {
		cwd: ROOT,
		detached: true,
		env: {
			...process.env,
			...ENV,
			DATABASE_URL: database,
			AGENT: "on",
			HARNESS: "remote",
			PLANNER_ATTACH_GRACE_MS: String(GRACE_MS),
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
			if ((await fetch(`${ORIGIN}/api/session`)).ok) return;
		} catch { /* Not bound yet. */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error("remote Planner server did not become ready");
}

test.afterEach(async () => {
	for (let child of processes.splice(0)) {
		if (child.exitCode !== null || child.pid === undefined) continue;
		let exit = new Promise<void>(resolve => child.once("close", () => resolve()));
		process.kill(-child.pid, "SIGTERM");
		await exit;
	}
});

test("with no machine button, the connection banner at the composer always says what is wrong with the document's remote Planner, a screen reader hears each state once, and nothing is said while it is attached", async ({ browser, page }) => {
	test.setTimeout(120_000);
	let database = await freshDatabase();
	await migrate(database);
	await remoteServer(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);

	await authenticate(page, HANDLE, ORIGIN);
	await listenForAnnouncements(page);
	await watchBanners(page);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	let status = strip(page);
	let composer = page.locator(".chat-composer");
	let surface = page.locator(".chat-composer .composer-surface");
	// This person has no machine, so no button: the banner on the composer's top edge is the one
	// place left to see it, and it is there whatever is being typed, with nothing under the composer.
	await expect(status).toHaveText(NONE);
	await expect(status).toHaveAttribute("data-layer", "planner");
	await expect(allBanners(page)).toHaveCount(1);
	await expect(status.getByRole("button")).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^Runs on/ })).toHaveCount(0);
	// It announces nothing itself: the page's one live region says it, once.
	await expect(status).not.toHaveAttribute("role");
	await expect(announced(page)).toHaveText(NONE);
	await expectSaidOnce(page, NONE);
	let field = await surface.boundingBox();
	// The composer itself is the size it was; the strip is above it, on its top edge.
	expect(await surface.boundingBox()).toMatchObject({ width: field!.width, height: field!.height });
	await snap(composer, "planner-none-desktop");

	let phone = await browser.newContext(PHONE);
	try {
		let handset = await phone.newPage();
		await authenticate(handset, HANDLE, ORIGIN);
		await handset.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(handset);
		await handset.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).click();
		// Chat slides in from the side; read it once it has settled.
		await expect.poll(async () => (await chatPane(handset).boundingBox())?.x).toBe(0);
		await expect(strip(handset)).toHaveText(NONE);
		await expectNoHorizontalOverflow(handset);
		await expectInsideViewport(strip(handset));
		await snap(handset, "planner-none-phone");

		// Attaching closes the banner. It has an entrance and no exit, so it is gone in one frame
		// rather than easing shut, and the field under it is exactly as big as it was.
		let client: AgentClient | undefined;
		let closing = await trace(composer, height, async () => {
			client = await connectAgent({
				url: ORIGIN,
				token: `ghu_e2e_${HANDLE}_1`,
				document: room,
				handlers: { turn() {} },
			});
			await expect(status).toHaveCount(0);
		});
		expect(inBetween(closing)).toEqual([]);
		expect(await surface.boundingBox()).toMatchObject({
			width: field!.width,
			height: field!.height,
		});
		await expect(strip(handset)).toHaveCount(0);
		await snap(composer, "planner-attached-desktop");
		await snap(handset, "planner-attached-phone");

		let opening = await trace(composer, height, async () => {
			await client!.detach();
			await expect(status).toHaveText(
				new RegExp(`^@${HANDLE}'s machine stepped away\\. Your work is kept until \\d{1,2}:\\d{2}`),
			);
		});
		// It comes in once, with its entrance, and does not grow a frame at a time.
		expect(inBetween(opening)).toEqual([]);
		let entered = (await bannerEntrances(page)).at(-1)!;
		expect(entered.animation).toBe("chat-banner-enter");
		expect(Math.min(...entered.opacity)).toBeLessThan(1);
		expect(await surface.boundingBox()).toMatchObject({
			width: field!.width,
			height: field!.height,
		});
		await expectInsideViewport(strip(handset));
		await expect(strip(handset)).toContainText("Your work is kept until");
		await snap(composer, "planner-held-desktop");
		await snap(handset, "planner-held-phone");

		// The grace period ends with nobody reattaching, and the room hears it without reloading.
		await expect(status).toHaveText(NONE, { timeout: GRACE_MS + 5_000 });
		// A screen reader heard each state once as it began, and nothing as the Planner attached.
		let said = await heard(page);
		expect(said).toHaveLength(3);
		expect(said[0]).toBe(NONE);
		expect(said[1]).toMatch(/^@mona's machine stepped away\. Your work is kept until /);
		expect(said[2]).toBe(NONE);

		// With reduced motion the same banner opens and shuts at once, with no frames between.
		await page.emulateMedia({ reducedMotion: "reduce" });
		let returning: AgentClient | undefined;
		let instant = await trace(composer, height, async () => {
			returning = await connectAgent({
				url: ORIGIN,
				token: `ghu_e2e_${HANDLE}_1`,
				document: room,
				handlers: { turn() {} },
			});
			await expect(status).toHaveCount(0);
		});
		expect(inBetween(instant)).toEqual([]);
		await expect(announced(page)).toHaveText("");
		expect(await heard(page)).toEqual(said);
		await returning!.detach();
	} finally {
		await phone.close();
	}
});

/** Open a new comment on the document's first paragraph. */
async function draft(page: Page, paragraph = 0) {
	await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
	await content(page).locator("p").nth(paragraph).selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	return page.getByRole("dialog", { name: "New comment" });
}

test("a new comment is sent to Chopin by default only while a Planner is attached", async ({ page }) => {
	test.setTimeout(90_000);
	let database = await freshDatabase();
	await migrate(database);
	await remoteServer(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	await seedChannel(
		PORT,
		room,
		"# Remote comments\nThe harp needs new strings.\n\nThe bridge needs a new pin.\n",
	);

	await authenticate(page, HANDLE, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	await expectNoPlanner(page);

	let card = await draft(page);
	let box = card.getByRole("checkbox", { name: "Send to Chopin" });
	await expect(box).not.toBeChecked();

	// Ticked anyway, it is not refused for the machine being away: it is posted at once, the
	// thread shows Chopin is on it, and it waits for the machine.
	await box.check();
	let field = card.getByRole("textbox", { name: "Comment" });
	await field.fill("Can you shorten this?");
	await card.getByRole("button", { name: "Post comment", exact: true }).click();
	await expect(card.getByRole("alert")).toHaveCount(0);
	await expect(card).toHaveCount(0);
	await expect(page.getByText("Can you shorten this?").first()).toBeVisible();
	await expect(page.getByText("Connect a machine to get a reply.")).toHaveCount(0);

	let client = await connectAgent({
		url: ORIGIN,
		token: `ghu_e2e_${HANDLE}_1`,
		document: room,
		handlers: { turn() {} },
	});
	try {
		await expectPlannerAttached(page);
		await expect((await draft(page, 1)).getByRole("checkbox", { name: "Send to Chopin" }))
			.toBeChecked();
	} finally {
		await client.detach();
	}
});

type Probe = { frames: string[]; closed?: { code: number; at: number } };

/** Open a bare socket from the page, so its cookie and origin are the browser's own. */
async function openProbe(page: Page, name: string, path: string): Promise<void> {
	await page.evaluate(async ({ name, url }) => {
		let probe: Probe = { frames: [] };
		((window as unknown as { probes?: Record<string, Probe> }).probes ??= {})[name] = probe;
		let socket = new WebSocket(url);
		socket.addEventListener("message", event => probe.frames.push(String(event.data)));
		socket.addEventListener("close", event => {
			probe.closed = { code: event.code, at: performance.now() };
		});
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("close", () => reject(new Error(`${name} was refused`)), {
				once: true,
			});
		});
	}, { name, url: `ws://${HOST}:${PORT}${path}` });
}

function probe(page: Page, name: string): Promise<Probe> {
	return page.evaluate(
		name => (window as unknown as { probes: Record<string, Probe> }).probes[name]!,
		name,
	);
}

test("signing out closes that login's sockets at once, and the Planner is never announced to them", async ({ browser }) => {
	test.setTimeout(90_000);
	let database = await freshDatabase();
	await migrate(database);
	await remoteServer(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);

	// Another login in the same room, whose socket must outlive the sign-out.
	let other = await browser.newContext();
	let reader = await other.newPage();
	await authenticate(reader, "review-b", ORIGIN);
	await reader.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(reader);
	await expectNoPlanner(reader);

	let leaving = await browser.newContext();
	let page = await leaving.newPage();
	await authenticate(page, "review-a", ORIGIN);
	await page.goto(`${ORIGIN}/api/session`);
	await openProbe(page, "room", `/ws?channel=${room}`);
	await openProbe(page, "sidebar", "/ws/sidebar");
	await expect.poll(async () => (await probe(page, "room")).frames.length).toBeGreaterThan(0);

	let signedOut = await page.evaluate(async () => {
		let at = performance.now();
		let response = await fetch("/auth/logout", { method: "POST" });
		return { status: response.status, at };
	});
	expect(signedOut.status).toBe(204);
	for (let name of ["room", "sidebar"]) {
		await expect.poll(async () => (await probe(page, name)).closed, { timeout: 1_000 })
			.toBeDefined();
		let closed = (await probe(page, name)).closed!;
		expect(closed.code).toBe(4401);
		expect(closed.at - signedOut.at).toBeLessThan(1_000);
	}
	let heard = (await probe(page, "room")).frames.length;

	let client = await connectAgent({
		url: ORIGIN,
		token: "ghu_e2e_review-b_1",
		document: room,
		handlers: { turn() {} },
	});
	await expectPlannerAttached(reader);
	expect((await probe(page, "room")).frames.slice(heard)).toEqual([]);
	await client.detach();
	await other.close();
	await leaving.close();
});

test("an attached Planner's Markdown question reads as a heading over a list, and its answer returns", async ({ page }) => {
	test.setTimeout(90_000);
	let database = await freshDatabase();
	await migrate(database);
	await remoteServer(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	await seedChannel(PORT, room, "# Rollout\nThe pilot plan.\n");
	await authenticate(page, HANDLE, ORIGIN);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);

	let question = [
		"Confirm the earlier answers",
		"",
		"- Storage: **PostgreSQL**",
		"  - kept for drafts",
		"- Rollout: `one team first`",
	].join("\n");
	let result = Promise.withResolvers<unknown>();
	let link: AgentClient | undefined;
	let client = await connectAgent({
		url: ORIGIN,
		token: `ghu_e2e_${HANDLE}_1`,
		document: room,
		handlers: {
			async turn(context) {
				let answered = await link!.ask(context.message.session, {
					method: "questionnaire",
					params: {
						questions: [{
							question,
							header: "Confirm",
							options: [
								{ label: "Confirm all", description: "" },
								{ label: "Change some", description: "" },
							],
						}],
					},
				});
				result.resolve(answered);
			},
		},
	});
	link = client;
	try {
		await expectPlannerAttached(page);
		let input = chatInput(page);
		await fillChat(input, "@chopin confirm the earlier answers");
		await input.press("Enter");

		let card = content(page).locator("article[data-plan-sidecar-questionnaire]");
		await expect(card.locator(".question-title")).toHaveText("Confirm the earlier answers");
		let body = card.locator(".question-body");
		await expect(body.locator(":scope > ul > li > p, :scope > ul > li").first())
			.toContainText("Storage: PostgreSQL");
		await expect(body.locator("ul ul > li")).toHaveText("kept for drafts");
		await expect(body.locator("code")).toHaveText("one team first");
		await test.info().attach("remote-planner-markdown-question", {
			body: await card.screenshot({ animations: "disabled" }),
			contentType: "image/png",
		});

		await card.getByText("Confirm all", { exact: true }).click();
		await card.getByRole("button", { name: "Save", exact: true }).click();
		expect(await result.promise).toMatchObject({
			status: "answered",
			value: {
				cancelled: false,
				answers: [{ questionIndex: 0, question, kind: "option", answer: "Confirm all" }],
			},
		});
	} finally {
		await client.detach();
	}
});

test("an attached Planner stores the images it made and shows one under each option and in the card", async ({ page }) => {
	test.setTimeout(90_000);
	let database = await freshDatabase();
	await migrate(database);
	await remoteServer(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	let other = crypto.randomUUID();
	await createChannel(PORT, room);
	await createChannel(PORT, other);
	await seedChannel(PORT, room, "# Cache\nHow writes reach it.\n");
	await authenticate(page, HANDLE, ORIGIN);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);

	let pictures = [
		{
			file: "option-write-through.png",
			alt: "Write-through: the database is written before the reply",
		},
		{
			file: "option-write-back.png",
			alt: "Write-back: the reply comes first and the database later",
		},
	];
	let stored: { path: string; markdown: string }[] = [];
	let offered: string[] = [];
	let result = Promise.withResolvers<unknown>();
	let link: AgentClient | undefined;
	let client = await connectAgent({
		url: ORIGIN,
		token: `ghu_e2e_${HANDLE}_1`,
		document: room,
		handlers: {
			async turn(context) {
				offered = context.message.tools.map(tool => tool.name);
				for (let { file, alt } of pictures) {
					let bytes = await readFile(new URL(`./fixtures/${file}`, import.meta.url));
					let uploaded = await context.callHostTool("upload_plan_image", {
						data: bytes.toString("base64"),
						mimeType: "image/png",
						alt,
					});
					expect(uploaded.isError).toBe(false);
					stored.push(JSON.parse(String(uploaded.output)));
				}
				let answered = await link!.ask(context.message.session, {
					method: "questionnaire",
					params: {
						questions: [{
							question: `How should writes reach the cache?\n\n${stored[0]!.markdown}`,
							header: "Cache",
							options: [
								{ label: "Write-through", description: "Safe.", preview: stored[0]!.markdown },
								{ label: "Write-back", description: "Fast.", preview: stored[1]!.markdown },
							],
						}],
					},
				});
				result.resolve(answered);
			},
		},
	});
	link = client;
	try {
		expect(client.features).toContain("decision-option-previews");
		await expectPlannerAttached(page);
		let input = chatInput(page);
		await fillChat(input, "@chopin compare the cache options");
		await input.press("Enter");

		let card = content(page).locator("article[data-plan-sidecar-questionnaire]");
		let write = card.getByRole("group", { name: "Preview of Write-through", exact: true });
		let back = card.getByRole("group", { name: "Preview of Write-back", exact: true });
		for (let [frame, { alt }] of [[write, pictures[0]!], [back, pictures[1]!]] as const) {
			let picture = frame.getByRole("img", { name: alt });
			await expect(picture).toBeVisible();
			await expect.poll(() =>
				picture.evaluate(element => (element as HTMLImageElement).naturalWidth)
			)
				.toBeGreaterThan(0);
		}
		// The turn was offered the tool, and the same picture it stored is also in the card's body.
		expect(offered).toContain("upload_plan_image");
		// The same picture the Planner stored is also in the card's body.
		await expect(card.locator(".question-body").getByRole("img", { name: pictures[0]!.alt }))
			.toBeVisible();
		await test.info().attach("remote-planner-option-previews", {
			body: await card.screenshot({ animations: "disabled" }),
			contentType: "image/png",
		});

		// Only this document serves what was stored in it.
		let path = stored[0]!.path;
		let own = await page.request.get(`${ORIGIN}${path}?document=${room}`);
		expect(own.status()).toBe(200);
		expect(own.headers()["content-type"]).toBe("image/png");
		expect((await page.request.get(`${ORIGIN}${path}?document=${other}`)).status()).toBe(404);

		await card.getByText("Write-back", { exact: true }).click();
		await card.getByRole("button", { name: "Save", exact: true }).click();
		expect(await result.promise).toMatchObject({
			status: "answered",
			value: {
				answers: [{ kind: "option", answer: "Write-back", preview: stored[1]!.markdown }],
			},
		});
	} finally {
		await client.detach();
	}
});

/** Set to a directory to keep the screenshots a pull request shows. */
const SHOTS = process.env.CHOPIN_SHOTS;

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

async function snap(target: Page | Locator, name: string): Promise<void> {
	if (!SHOTS) return;
	await mkdir(SHOTS, { recursive: true });
	await target.screenshot({ path: `${SHOTS}/${name}.png`, animations: "disabled" });
}

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

test("a Planner whose connection drops is shown as disconnected for longer than the grace period, never stopped, and carries on with its Decision and a held Stop when it returns", async ({ browser, page }) => {
	test.setTimeout(150_000);
	let database = await freshDatabase();
	await migrate(database);
	await remoteServer(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	await seedChannel(PORT, room, "# Release\nShip when ready.\n");
	await authenticate(page, HANDLE, ORIGIN);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);

	// The package client keeps its socket to itself; a subclass hands it to the test, which then
	// closes it as a network failure does, with no detach.
	let sockets: WebSocket[] = [];
	let Native = globalThis.WebSocket;
	globalThis.WebSocket = class extends Native {
		constructor(...args: ConstructorParameters<typeof Native>) {
			super(...args);
			sockets.push(this);
		}
	} as typeof WebSocket;
	let link: AgentClient | undefined;
	let returning: AgentClient | undefined;
	let asked: Promise<{ status: string; value?: unknown }> | undefined;
	let controls: string[] = [];
	let started = Math.floor(Date.now() / 1000) - 300;
	let card = (status: "running" | "paused") => ({
		id: "run-1",
		name: "plan-review",
		status,
		started,
		updated: started + 240,
		stages: [{
			id: "run-1:review",
			name: "review-draft",
			status: status === "running" ? ("running" as const) : ("paused" as const),
			started,
		}],
		waiting: 0,
	});
	let handlers: AgentHandlers = {
		turn(context) {
			// Turns of Chopin's own background jobs, after it attaches, ask nothing.
			if (asked) return;
			link!.reportRuns(context.message.session, {
				active: ["run-1"],
				paused: [],
				cards: [card("running")],
			});
			asked = link!.ask(context.message.session, {
				method: "confirm",
				title: "Ship it?",
				message: "Now.",
			});
		},
		control(message) {
			controls.push(message.type);
			if (message.type === "stop") {
				(returning ?? link!).reportRuns(message.session, {
					active: [],
					paused: ["run-1"],
					cards: [card("paused")],
				});
			}
		},
	};
	let phone: BrowserContext | undefined;
	try {
		link = await connectAgent({
			url: ORIGIN,
			token: `ghu_e2e_${HANDLE}_1`,
			document: room,
			handlers,
		});
		let input = chatInput(page);
		let planner = strip(page);
		await fillChat(input, "@chopin review the release");
		// Attached, there is nothing to say: the strip that said no Planner was there goes, and the
		// draft addressed to Chopin changes nothing about it.
		await expect(planner).toHaveCount(0);
		await input.press("Enter");
		let decision = content(page).locator("article[data-plan-sidecar-questionnaire]");
		await expect(decision).toBeVisible();
		let runs = chatPane(page).getByRole("region", { name: "Workflow runs" });
		await expect(runs.getByRole("button", { name: /^plan-review, running, \d+m$/ })).toBeVisible();
		await expect(chatPane(page).getByText("The machine disconnected.")).toHaveCount(0);
		await snap(page, "link-drop-connected-desktop");

		sockets[0]!.close(3000, "network failed");
		let held = await link.resumption;
		expect(held).toBeDefined();

		// Disconnected, not stopped: the run card and Chat say so, and so does the composer's banner
		// (this person has no machine button), and the work and the Decision are as they were.
		await expect(planner).toHaveText(
			`@${HANDLE}'s machine is offline. Your work is kept.`,
		);
		let away = runs.getByRole("button", {
			name: /^plan-review, disconnected, was running, 4m$/,
		});
		await expect(away).toBeVisible();
		await expect(away).toContainText("disconnected");
		await expect(runs.locator("[data-run-disconnected-note]")).toHaveText(
			"Last reported running. It carries on when the machine reconnects.",
		);
		await expect(runs).not.toContainText("stopped");
		// The machine's state is told on the run card and the composer's top edge, not again in Chat.
		await expect(chatPane(page).getByText(/The machine (disconnected|reconnected)/)).toHaveCount(0);
		await expect(decision.getByRole("button", { name: "Save", exact: true })).toBeVisible();
		await snap(page, "link-drop-disconnected-desktop");
		await snap(chatPane(page), "link-drop-disconnected-chat-desktop");

		// The same on a phone, in the Chat pane.
		phone = await browser.newContext(PHONE);
		let handset = await phone.newPage();
		await authenticate(handset, HANDLE, ORIGIN);
		await handset.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(handset);
		await handset.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).click();
		await expect.poll(async () => (await chatPane(handset).boundingBox())?.x).toBe(0);
		let handsetRuns = chatPane(handset).getByRole("region", { name: "Workflow runs" });
		await expect(handsetRuns.getByRole("button", { name: /^plan-review, disconnected/ }))
			.toBeVisible();
		await expect(strip(handset)).toContainText("is offline. Your work is kept");
		await expectNoHorizontalOverflow(handset);
		await expectInsideViewport(strip(handset));
		await expectInsideViewport(handsetRuns);
		await snap(handset, "link-drop-disconnected-phone");

		// Well past the grace period, nothing has ended: the Decision is open and the run is shown.
		await page.waitForTimeout(GRACE_MS + 4_000);
		await expect(planner).toContainText("is offline. Your work is kept");
		await expect(away).toBeVisible();
		await expect(runs).not.toContainText("stopped");

		// A reload asks the server again and hears the same: disconnected, with its work kept.
		await page.reload();
		await ready(page);
		// The server says the same again, and the composer's top edge with it.
		await expect(planner).toContainText("is offline. Your work is kept");
		await expect(away).toBeVisible();
		await expect(runs).not.toContainText("stopped");
		await expect(decision.getByRole("button", { name: "Save", exact: true })).toBeVisible();

		// The Decision stays answerable while the Planner is away; the answer is kept for it.
		await decision.getByText("Yes", { exact: true }).click();
		await decision.getByRole("button", { name: "Save", exact: true }).click();
		await expect(decision.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

		// A Stop pressed meanwhile is said to be pending, and nothing claims to have stopped.
		await page.getByRole("button", { name: "Stop generating", exact: true }).click();
		await expect(
			chatPane(page).getByText(
				"asked Chopin to stop. Its machine is disconnected, so its workflows will pause when it reconnects.",
			),
		).toBeVisible();
		await expect(away).toBeVisible();
		await expect(runs).not.toContainText("stopped");
		await expect(runs).not.toContainText("paused");
		// Pause is offered, said as pending, and Resume is not.
		await expect(
			runs.getByRole("button", { name: "Pause plan-review when the machine reconnects" }),
		)
			.toBeVisible();
		expect(controls).toEqual([]);

		returning = await connectAgent({
			url: ORIGIN,
			token: `ghu_e2e_${HANDLE}_1`,
			document: room,
			handlers,
			resume: held!,
		});
		// It says the machine is back, for a moment, and then nothing is left of it.
		await expect(planner).toContainText("The machine is back.");
		await expect(planner).toHaveCount(0, RESUMED_WAIT);
		// The held Stop reached it, and it reported the run paused; nothing is disconnected now.
		await expect.poll(() => controls).toEqual(["stop"]);
		await expect(runs.getByRole("button", { name: /^plan-review, paused, \d+m$/ })).toBeVisible();
		await expect(runs).not.toContainText("disconnected");
		await expect(runs.locator("[data-run-disconnected-note]")).toHaveCount(0);
		// Nothing confirms it: the card's mark and the composer's banner going are all there is.
		await expect(chatPane(page).getByText(/The machine (disconnected|reconnected)/)).toHaveCount(0);
		await expect(runs.getByRole("button", { name: "Resume plan-review" })).toBeVisible();
		// The answer given while it was away reached it.
		expect(await asked).toMatchObject({ status: "answered", value: true });
		await snap(page, "link-drop-reconnected-desktop");
		await snap(chatPane(page), "link-drop-reconnected-chat-desktop");
		await expect(strip(handset)).toHaveCount(0, RESUMED_WAIT);
		await expect(
			chatPane(handset).getByRole("region", { name: "Workflow runs" })
				.getByRole("button", { name: /^plan-review, paused/ }),
		).toBeVisible();
		await snap(handset, "link-drop-reconnected-phone");
	} finally {
		globalThis.WebSocket = Native;
		await phone?.close();
		await returning?.detach();
		await link?.detach();
	}
});

const OFFLINE = "You're offline. Your changes are kept and will sync when you reconnect.";
const RECONNECTING = "Reconnecting. Your changes are kept.";

/**
 * Proxies the page's document socket, so a test is what drops it and keeps it away until `back`.
 * `back(true)` also holds what the server sends on the new socket until `release`, so the page
 * has the socket open and nothing on it yet: the moment of catching up, for as long as the test
 * looks at it.
 */
async function losable(page: Page) {
	let away = false;
	let holding = false;
	let held: Array<string | Buffer> = [];
	let sockets: WebSocketRoute[] = [];
	await page.routeWebSocket("**/ws?**", socket => {
		if (away) return void socket.close();
		let server = socket.connectToServer();
		server.onMessage(message => {
			if (holding) held.push(message);
			else socket.send(message);
		});
		sockets.push(socket);
	});
	return {
		lose: async () => {
			away = true;
			await sockets.at(-1)!.close();
		},
		back: async (hold = false) => {
			away = false;
			holding = hold;
			await page.evaluate(() => dispatchEvent(new Event("online")));
		},
		release: () => {
			holding = false;
			for (let message of held.splice(0)) sockets.at(-1)!.send(message);
		},
	};
}

for (
	let [shape, options] of [
		["desktop", { viewport: { width: 1440, height: 1000 } }],
		["phone", PHONE],
	] as const
) {
	test(`a run whose machine dropped says nothing of the machine while the connection banner shows, and says it again when the connection returns, on a ${shape}`, async ({ browser }) => {
		test.setTimeout(150_000);
		let database = await freshDatabase();
		await migrate(database);
		await remoteServer(database);
		registerTestDatabase(PORT, database);
		let room = crypto.randomUUID();
		await createChannel(PORT, room);
		await seedChannel(PORT, room, "# Release\nShip when ready.\n");
		let context = await browser.newContext(options);
		let page = await context.newPage();
		await authenticate(page, HANDLE, ORIGIN);
		let wire = await losable(page);
		await listenForAnnouncements(page);
		await page.addInitScript(() => {
			// The widest jitter, so a scheduled retry cannot pass for the online event.
			Math.random = () => 0.999;
		});
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		if (shape === "phone") {
			await page.getByRole("navigation", { name: "Workspace view" })
				.getByRole("button", { name: /^Chat/ }).click();
			await expect.poll(async () => (await chatPane(page).boundingBox())?.x).toBe(0);
		}

		let sockets: WebSocket[] = [];
		let Native = globalThis.WebSocket;
		globalThis.WebSocket = class extends Native {
			constructor(...args: ConstructorParameters<typeof Native>) {
				super(...args);
				sockets.push(this);
			}
		} as typeof WebSocket;
		let link: AgentClient | undefined;
		let returning: AgentClient | undefined;
		let started = Math.floor(Date.now() / 1000) - 300;
		let handlers: AgentHandlers = {
			turn(context) {
				link!.reportRuns(context.message.session, {
					active: ["run-1"],
					paused: [],
					cards: [{
						id: "run-1",
						name: "plan-review",
						status: "running",
						started,
						updated: started + 240,
						stages: [{ id: "run-1:review", name: "review-draft", status: "running", started }],
						waiting: 0,
					}],
				});
			},
		};
		try {
			link = await connectAgent({
				url: ORIGIN,
				token: `ghu_e2e_${HANDLE}_1`,
				document: room,
				handlers,
			});
			let input = chatInput(page);
			await fillChat(input, "@chopin review the release");
			await input.press("Enter");
			let runs = chatPane(page).getByRole("region", { name: "Workflow runs" });
			await expect(runs.getByRole("button", { name: /^plan-review, running, \d+m$/ }))
				.toBeVisible();

			// Its machine drops: the card says so, as does the composer's top edge.
			sockets[0]!.close(3000, "network failed");
			let held = await link.resumption;
			expect(held).toBeDefined();
			let note = runs.locator("[data-run-disconnected-note]");
			await expect(
				runs.getByRole("button", { name: /^plan-review, disconnected, was running, \d+m$/ }),
			)
				.toBeVisible();
			await expect(note).toHaveText(
				"Last reported running. It carries on when the machine reconnects.",
			);
			await expect(strip(page)).toHaveText(`@${HANDLE}'s machine is offline. Your work is kept.`);
			// A screen reader was told once, by the page's one live region.
			await expect(announced(page)).toHaveText(
				`@${HANDLE}'s machine is offline. Your work is kept.`,
			);
			let said = await heard(page);
			expect(said).toEqual([`@${HANDLE}'s machine is offline. Your work is kept.`]);

			// Then the page's own connection is lost. Its banner is the one thing said: the card is
			// still the run, as last reported, with its controls, and says nothing of the machine
			// anywhere on the page, to the eye or to a screen reader. The banner is one status, not
			// an alert, and the room's own words are spoken once each.
			await wire.lose();
			await expect(connectionBanner(page)).toContainText(OFFLINE, { timeout: 30_000 });
			await expect(connectionBanner(page)).toHaveAttribute("data-layer", "socket");
			await expect(allBanners(page)).toHaveCount(1);
			await expect(page.getByRole("alert")).toHaveCount(0);
			await expect(runs.getByRole("button", { name: /^plan-review, running, \d+m$/ }))
				.toBeVisible();
			await expect(runs.getByRole("button", { name: "Pause plan-review", exact: true }))
				.toBeVisible();
			await expect(runs.locator("[data-run-disconnected-note], [data-run-disconnected]"))
				.toHaveCount(0);
			await expect(page.locator('[data-connection-banner][data-layer="planner"]')).toHaveCount(0);
			await expectNoMachineWords(page, OFFLINE);
			let lost = await heard(page);
			expect(lost.slice(0, said.length)).toEqual(said);
			expect(lost.slice(said.length)).toEqual([RECONNECTING, OFFLINE]);
			await expect(chatPane(page)).not.toContainText(/machine/i);
			await expectNoHorizontalOverflow(page);
			await snap(page, `run-card-offline-${shape}`);

			// It returns, and the words return with it, as the state dictates: the machine is still away.
			await wire.back(true);
			await expect(connectionBanner(page)).toHaveAttribute("data-layer", "sync");
			await expect(connectionBanner(page)).toContainText("Catching up");
			wire.release();
			await expect(connectionBanner(page)).toHaveAttribute("data-phase", "resumed");
			await expect(connectionBanner(page)).toContainText("Back online.");
			// The machine is still away, so when the connection's own words are over the banner
			// carries on with the machine's, in its own layer: one banner, one cause at a time.
			await expect(connectionBanner(page)).toHaveAttribute("data-layer", "planner", RESUMED_WAIT);
			await expect(allBanners(page)).toHaveCount(1);
			await expect(
				runs.getByRole("button", { name: /^plan-review, disconnected, was running, \d+m$/ }),
			)
				.toBeVisible();
			await expect(note).toHaveText(
				"Last reported running. It carries on when the machine reconnects.",
			);
			await expect(
				runs.getByRole("button", { name: "Pause plan-review when the machine reconnects" }),
			).toBeVisible();
			await expect(strip(page)).toHaveText(`@${HANDLE}'s machine is offline. Your work is kept.`);
			// The state carried on through the loss, so it is not said again: the live region only
			// said the connection's own words in between.
			await page.waitForTimeout(500);
			await expect(announced(page)).toHaveText("");
			let again = await heard(page);
			expect(again.slice(0, lost.length)).toEqual(lost);
			// The socket was open with nothing on it while the test held it, so catching up is said
			// once, then the return, and nothing else.
			expect(again.slice(lost.length)).toEqual([
				"Catching up",
				"Back online. Your changes are synced",
			]);
			await expectNoHorizontalOverflow(page);
			await snap(page, `run-card-online-${shape}`);

			// And the machine returns: nothing about it is left.
			returning = await connectAgent({
				url: ORIGIN,
				token: `ghu_e2e_${HANDLE}_1`,
				document: room,
				handlers,
				resume: held!,
			});
			await expect(strip(page)).toContainText("The machine is back.");
			await expect(strip(page)).toHaveCount(0, RESUMED_WAIT);
			await expect(runs.getByRole("button", { name: /^plan-review, running, \d+m$/ }))
				.toBeVisible();
			await expect(note).toHaveCount(0);
			await expect(announced(page)).toHaveText("");
			let last = await heard(page);
			expect(last.slice(0, again.length)).toEqual(again);
			expect(last.slice(again.length)).toHaveLength(1);
			expect(last.at(-1)).toMatch(/^The machine is back\./);
		} finally {
			globalThis.WebSocket = Native;
			await context.close();
			await returning?.detach();
			await link?.detach();
		}
	});
}

/** A bare WebSocket upgrade request as the member, offering `subprotocol` when given. */
function handshake(path: string, subprotocol?: string): Promise<Response> {
	return fetch(`${ORIGIN}${path}`, {
		headers: {
			connection: "Upgrade",
			upgrade: "websocket",
			"sec-websocket-version": "13",
			"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			authorization: `Bearer ghu_e2e_${HANDLE}_1`,
			...(subprotocol ? { "sec-websocket-protocol": subprotocol } : {}),
		},
	});
}

test("the agent connection opens only at /api/v1/agent, offering chopin.agent.v1", async () => {
	let database = await freshDatabase();
	await migrate(database);
	await remoteServer(database);
	for (let offered of [undefined, "chopin.agent.v2, graphql-ws"]) {
		let refused = await handshake("/api/v1/agent", offered);
		expect(refused.status).toBe(426);
		expect(refused.headers.get("sec-websocket-protocol")).toBeNull();
		expect(await refused.json()).toEqual({
			code: "subprotocol-required",
			supported: ["chopin.agent.v1"],
		});
	}
	let accepted = await handshake("/api/v1/agent", "chopin.agent.v2, chopin.agent.v1");
	expect(accepted.status).toBe(101);
	expect(accepted.headers.get("sec-websocket-protocol")).toBe("chopin.agent.v1");
	// The old path is gone: no WebSocket opens there, and the web client is no answer.
	let old = await handshake("/planner-link", "chopin.agent.v1");
	expect(old.status).toBe(404);
	expect(await old.text()).not.toContain("<html");
});

test("Chat says nothing about attachments where the Planner runs on the server", async ({ page }) => {
	let origin = `http://${HOST}:${HARNESS}`;
	let room = crypto.randomUUID();
	await createChannel(HARNESS, room);
	await authenticate(page, HANDLE, origin);
	await page.goto(`${origin}${roomPath(room)}`);
	await ready(page);
	await expect(page.getByRole("combobox", { name: "Message" })).toBeVisible();
	// Nothing is reported, so nothing is said, even addressed to Chopin.
	await address(page);
	await expect(strip(page)).toHaveCount(0);
});
