/**
 * The Chat composer's `/` commands and `@` mentions, under `HARNESS=remote`: the commands come from
 * the client attached to the document, so this file starts a server of its own against a database
 * of its own and attaches a scripted client over the real agent connection, as the model picker's
 * spec does. A mention of a file reads the repository's tree through the fake GitHub.
 */
import { spawn } from "node:child_process";

import AxeBuilder from "@axe-core/playwright";
import { SQL } from "bun";

import { connectAgent } from "../packages/agent-link/src/client";
import { finishTurn } from "../apps/server/src/testing/agent-link";
import { storedQuestion } from "../apps/server/src/testing/plan";
import { chatInput, expectChatValue, fillChat } from "./chat-input";
import {
	createChannel,
	registerTestDatabase,
	seedChannel,
	seedPendingLegacyResearchWorkspace,
} from "./database";
import { e2eDatabaseName, e2ePort } from "./ports";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";
import { authenticate, expect, ready, roomPath, test } from "./room";
import { HOST, ROOT } from "./servers";

import type { Browser, Page } from "@playwright/test";
import type { CapabilityCatalog } from "../packages/agent-link/src/protocol";

const PORT = e2ePort(8804);
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = e2eDatabaseName("chopin_agent_commands");
const HANDLE = "mona";
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = {
	hasTouch: true,
	isMobile: true,
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 3,
};
/** Set to a directory to keep the screenshots a pull request shows. */
const SHOTS = process.env.CHOPIN_SHOTS;

const COMMANDS: NonNullable<CapabilityCatalog["commands"]> = [
	{ name: "review", kind: "prompt", description: "Review the current diff" },
	{
		name: "skill:release-notes",
		kind: "skill",
		description: "Draft release notes from merged pull requests",
	},
	{ name: "skill:notes", kind: "skill" },
	{ name: "ship", kind: "workflow", description: "Ship a branch through the release workflow" },
];

const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8C0";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3C0";
const CANARY = "01K0N4W3B7P27CBAEC7A8C8WC1";
const BLUE = "01K0N4W3B7P27CBAEC7A8C8WC2";

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

// One server and database for the file; each test makes a document of its own.
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
			throw new Error(`commands server exited with ${child.exitCode}: ${errors.slice(-800)}`);
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

/** What the attached scripted client was asked to run, turn by turn. */
type Asked = { prompt: string };

async function attachClient(room: string, capabilities?: CapabilityCatalog, handle = HANDLE) {
	let asked: Asked[] = [];
	let client = await connectAgent({
		url: ORIGIN,
		token: `ghu_e2e_${handle}_1`,
		document: room,
		resumable: false,
		...(capabilities ? { capabilities } : {}),
		handlers: {
			async turn(context) {
				asked.push({ prompt: context.message.prompt });
				context.emit({ type: "stream-start", modelId: "scripted" });
				context.emit({ type: "text-start", id: "reply" });
				context.emit({ type: "text-delta", id: "reply", delta: "Done." });
				context.emit({ type: "text-end", id: "reply" });
				finishTurn(context);
			},
		},
	});
	return { client, asked };
}

/** What the pages threw, so a control that crashes is told as a crash and not as a missing element. */
let thrown: string[] = [];
test.afterEach(() => {
	let errors = thrown.splice(0);
	expect(errors).toEqual([]);
});

async function open(browser: Browser, handle: string, room: string, options: object) {
	let context = await browser.newContext(options);
	let page = await context.newPage();
	page.on("pageerror", error => thrown.push(error.message));
	await authenticate(page, handle, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	return page;
}

async function newRoom() {
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	return room;
}

function chat(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function menu(page: Page, name: "Commands" | "Mentions") {
	return chat(page).getByRole("listbox", { name, exact: true });
}

async function shoot(page: Page, name: string) {
	if (!SHOTS) return;
	await new Promise(resolve => setTimeout(resolve, 500));
	await chat(page).screenshot({ path: `${SHOTS}/${name}.png` });
}

async function expectAccessible(page: Page, selector: string) {
	let result = await new AxeBuilder({ page }).include(selector).analyze();
	expect(result.violations.map(violation => `${violation.id}: ${violation.help}`)).toEqual([]);
}

test("lists Chat's own command and the commands the attached client reports, grouped by where they come from and filtered as you type", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let { client } = await attachClient(room, { commands: COMMANDS });
	let input = chatInput(chat(page));
	await input.click();
	await page.keyboard.type("/");
	let commands = menu(page, "Commands");
	await expect(commands).toBeVisible();
	await expect(input).toHaveAttribute("aria-expanded", "true");
	await expect(commands.getByRole("option")).toHaveCount(5, { timeout: 15_000 });
	// Chat's own first, then what the client reported, as it reported it. The active row, the
	// first, also shows its enter hint.
	await expect(commands.getByRole("option")).toHaveText([
		"/researchSearch the web for this document↵",
		"/reviewReview the current diff",
		"/skill:release-notesDraft release notes from merged pull requests",
		"/skill:notes",
		"/shipShip a branch through the release workflow",
	]);
	await expect(commands.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
	await shoot(page, "commands-desktop");
	await expectAccessible(page, "[data-chat-command-picker]");

	// Typing narrows it, by a name or by what follows a skill's prefix.
	await page.keyboard.type("rel");
	await expect(commands.getByRole("option")).toHaveText([
		"/skill:release-notesDraft release notes from merged pull requests↵",
	]);
	await page.keyboard.press("Backspace");
	await page.keyboard.press("Backspace");
	await page.keyboard.press("Backspace");
	await page.keyboard.type("sk");
	await expect(commands.getByRole("option")).toHaveCount(2);
	await page.keyboard.type("zzz");
	await expect(commands).toHaveCount(0);

	// Arrows move and Escape closes only the menu, keeping the draft and the focus.
	await input.fill("/");
	await page.keyboard.press("ArrowDown");
	await expect(commands.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("Escape");
	await expect(commands).toHaveCount(0);
	await expect(input).toBeFocused();
	await expectChatValue(input, "/");

	// A path is not a command.
	await input.fill("/usr/bin");
	await expect(commands).toHaveCount(0);

	// What the client reports changes the list live, and a client that leaves takes it away.
	await input.fill("/");
	client.report({ commands: [{ name: "only", kind: "skill", description: "Just this" }] });
	await expect(commands.getByRole("option")).toHaveCount(2);
	await client.detach();
	await expect(commands.getByRole("option")).toHaveText([
		"/researchSearch the web for this document↵",
	]);
});

test("runs each kind of command on the attached client as it understands it, with the command as a chip", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let { asked } = await attachClient(room, { commands: COMMANDS });
	let input = chatInput(chat(page));
	let commands = menu(page, "Commands");
	let answered = 0;
	let run = async (query: string, words: string) => {
		await input.click();
		await input.fill("");
		await page.keyboard.type(`/${query}`);
		await expect(commands).toBeVisible();
		await page.keyboard.press("Enter");
		// The command is one chip that opens the draft, and the person goes on with its words.
		let chip = input.locator('.draft-reference[data-reference="command"]');
		await expect(chip).toHaveCount(1);
		await expect(commands).toHaveCount(0);
		await page.keyboard.type(words);
		await input.press("Enter");
		answered++;
		await expect(chat(page).getByText("Done.")).toHaveCount(answered, { timeout: 20_000 });
	};

	// A background job's turn for the same document comes between, so each turn is found by its words.
	let turn = (text: string) =>
		asked.find(item => item.prompt.includes(text) && !item.prompt.startsWith("[Background"));
	await run("skill:notes", "for today");
	expect(turn("for today")!.prompt).toBe("/skill:notes for today");
	await run("review", "the diff");
	expect(turn("the diff")!.prompt).toBe("/review the diff");
	await run("ship", "the v2 branch");
	expect(turn("the v2 branch")!.prompt).toContain('Start the registered workflow "ship" now');
	expect(turn("the v2 branch")!.prompt.endsWith("the v2 branch")).toBe(true);

	// Each message shows its command as a chip, never a link, and what was typed after it.
	let sent = chat(page).locator("[data-chat-message-id]");
	await expect(sent.filter({ hasText: "the diff" }).locator('[data-chat-reference="command"]'))
		.toHaveText("/review");
	await expect(sent.filter({ hasText: "the v2 branch" })).toContainText("/ship the v2 branch");
	await expect(chat(page).locator('a[data-chat-reference="command"]')).toHaveCount(0);
	await shoot(page, "commands-sent-desktop");
});

test("a command is one chip: Backspace takes all of it, and typing never lands inside it", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	await attachClient(room, { commands: COMMANDS });
	let input = chatInput(chat(page));
	await input.click();
	await page.keyboard.type("/skill:n");
	await page.keyboard.press("Tab");
	await expectChatValue(input, "/skill:notes ");
	await page.keyboard.type("today");
	await expectChatValue(input, "/skill:notes today");
	const chip = input.locator('.draft-reference[data-reference="command"]');
	await expect(chip).toHaveText("/skill:notes");
	// Put the caret in the middle of the chip and type: it lands after the chip.
	await page.keyboard.press("Home");
	for (let step = 0; step < 4; step++) await page.keyboard.press("ArrowRight");
	await page.keyboard.type("X");
	await expectChatValue(input, "/skill:notesX today");
	await expect(chip).toHaveText("/skill:notes");
	// Backspace takes the X, and the next one, at the chip's end, takes the whole chip.
	await page.keyboard.press("Backspace");
	await expectChatValue(input, "/skill:notes today");
	await expect(chip).toHaveText("/skill:notes");
	await page.keyboard.press("Backspace");
	await expectChatValue(input, " today");
	await expect(chip).toHaveCount(0);
});

test("refuses a command the client no longer offers, on the message, with the reason", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let { client, asked } = await attachClient(room, { commands: COMMANDS });
	let input = chatInput(chat(page));
	await input.click();
	await page.keyboard.type("/review");
	await page.keyboard.press("Enter");
	await page.keyboard.type("the diff");
	await expect(input.locator('.draft-reference[data-reference="command"]')).toHaveCount(1);
	// The client stops offering it before the message is sent. Another tab seeing the list change
	// is how this one knows the server has the client's new report.
	client.report({ commands: [{ name: "skill:notes", kind: "skill" }] });
	let probe = await open(browser, HANDLE, room, DESKTOP);
	let probing = chatInput(chat(probe));
	await probing.click();
	await probe.keyboard.type("/");
	let probed = menu(probe, "Commands");
	await expect(probed.getByRole("option")).toHaveCount(2, { timeout: 15_000 });
	await expect(probed.getByRole("option").filter({ hasText: "/review" })).toHaveCount(0);
	await input.press("Enter");
	let message = chat(page).locator("[data-chat-message-id]").filter({ hasText: "the diff" });
	await expect(message.locator("[data-chat-failed]")).toContainText("Couldn't send.");
	await expect(message.locator("[data-chat-failed]")).toContainText(
		"/review is not one of the commands the Planner offers.",
	);
	expect(asked).toHaveLength(0);
	await expectChatValue(input, "");
	await shoot(page, "commands-refused-desktop");
});

test("a client that reports no commands offers only Chat's own, and another document's machine is never listed here", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let other = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let input = chatInput(chat(page));
	let commands = menu(page, "Commands");

	// An older client reports nothing at all.
	let older = await attachClient(room);
	await input.click();
	await page.keyboard.type("/");
	await expect(commands.getByRole("option")).toHaveText([
		"/researchSearch the web for this document↵",
	]);
	await page.keyboard.press("Escape");
	await older.client.detach();

	// Somebody else's machine, attached to another document, reports its own: not shown here.
	let elsewhere = await attachClient(other, { commands: COMMANDS });
	await input.fill("/");
	await expect(commands.getByRole("option")).toHaveText([
		"/researchSearch the web for this document↵",
	]);
	await elsewhere.client.detach();

	// Somebody who can only read the document is offered no command of the client's.
	let readerContext = await browser.newContext(DESKTOP);
	let reader = await readerContext.newPage();
	await authenticate(reader, `score-reader-${room.slice(0, 8)}`, ORIGIN);
	await reader.goto(`${ORIGIN}${roomPath(room)}`);
	await expect(menu(reader, "Commands")).toHaveCount(0);
});

test("on a phone the list stays inside the screen and Chat does not scroll sideways", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, PHONE);
	await attachClient(room, { commands: COMMANDS });
	await page.getByRole("navigation", { name: "Workspace view" }).getByRole("button", {
		name: /Chat/,
	})
		.click();
	let input = chatInput(chat(page));
	await input.click();
	await page.keyboard.type("/");
	let commands = menu(page, "Commands");
	await expect(commands.getByRole("option")).toHaveCount(5, { timeout: 15_000 });
	await expectInsideViewport(chat(page).locator("[data-chat-command-picker]"));
	await expectNoHorizontalOverflow(page);
	await expectAccessible(page, "[data-chat-command-picker]");
	await shoot(page, "commands-phone");
});

const SOURCE = [
	"# Overview",
	"",
	"Some prose.",
	"",
	"## Site survey",
	"",
	`<Questionnaire id="${WIDGET}">`,
	`<Question id="${QUESTION}" header="Rollout" prompt="How should we deploy?" multiple="false">`,
	`<Option id="${CANARY}" label="Canary" />`,
	`<Option id="${BLUE}" label="Blue-green" />`,
	"</Question>",
	"</Questionnaire>",
	"",
].join("\n");

async function mentionRoom(withResearch = true) {
	let room = await newRoom();
	let research = withResearch
		? await seedPendingLegacyResearchWorkspace(PORT, room, "Release Research")
		: undefined;
	let definition = {
		questions: [{
			id: QUESTION,
			header: "Rollout",
			question: "How should we deploy?",
			multiple: false,
			options: [
				{ id: CANARY, label: "Canary", description: "" },
				{ id: BLUE, label: "Blue-green", description: "" },
			],
		}],
	};
	await seedChannel(
		PORT,
		room,
		SOURCE + (research ? `\n<Research id="${research.workspaceId}" />\n` : ""),
		{
			revision: 1,
			questions: [{
				id: WIDGET,
				definition,
				status: "open" as const,
				origin: "human" as const,
				owner: "ana",
				history: [],
				optionOrigins: {},
				editors: ["ana"],
			}],
			openQuestions: [{
				definition,
				id: WIDGET,
				model: storedQuestion(definition),
				revision: 0,
				widget: WIDGET,
			}],
		},
	);
	return { room, research };
}

test("@ also lists the document's sections, Decisions and research cards and the repository's files, and sends each as a structured reference", async ({ browser }) => {
	test.setTimeout(180_000);
	let { room } = await mentionRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let { asked } = await attachClient(room);
	let input = chatInput(chat(page));
	let mentions = menu(page, "Mentions");
	await input.click();
	await page.keyboard.type("@");
	await expect(mentions).toBeVisible();
	// One list, as assistant-ui's Mentions is: Chopin, then each part of the document with its level
	// or what it is at the end of its row.
	await expect(mentions.getByRole("option")).toHaveText([
		"Chopinagent",
		"OverviewH1",
		"Site surveyH2",
		"Rolloutdecision",
		"Release Researchresearch",
		"README.mdfile",
		"docs/design.mdfile",
		"src/index.tsfile",
		"src/chat/composer.tsxfile",
	]);
	await shoot(page, "mentions-desktop");
	await expectAccessible(page, "[data-chat-mention-picker]");

	// A section: filtered by the words typed, which go on past a space.
	await page.keyboard.type("site s");
	await expect(mentions.getByRole("option")).toHaveText(["Site surveyH2"]);
	await page.keyboard.press("Enter");
	await expectChatValue(input, "@Site survey ");
	await expect(input.locator('.draft-reference[data-reference="heading"]')).toHaveText(
		"@Site survey",
	);

	// A Decision.
	await page.keyboard.type("and @roll");
	await expect(mentions.getByRole("option")).toHaveText(["Rolloutdecision"]);
	await page.keyboard.press("Enter");
	await expect(input.locator('.draft-reference[data-reference="decision"]')).toHaveText("@Rollout");

	// A research card, drawn as the research reference it is.
	await page.keyboard.type("with @release r");
	await expect(mentions.getByRole("option")).toHaveText(["Release Researchresearch"]);
	await page.keyboard.press("Enter");
	await expect(input.locator('.draft-reference[data-reference="research"]')).toHaveText(
		"%Release Research",
	);

	// A file, by the end of its name or any part of its path.
	await page.keyboard.type("in @comp");
	await expect(mentions.getByRole("option")).toHaveText(["src/chat/composer.tsxfile"]);
	await page.keyboard.press("Enter");
	await expect(input.locator('.draft-reference[data-reference="file"]')).toHaveText(
		"@src/chat/composer.tsx",
	);

	// The message goes to Chopin with each part as what it is.
	await page.keyboard.type("compare these");
	await shoot(page, "chips-draft-desktop");
	await input.press("Home");
	await page.keyboard.type("@chopin ");
	await input.press("Enter");
	// A background job's turn for the same document may come as well, so the turn is found by its words.
	await expect.poll(() => asked.some(item => item.prompt.includes("compare these")), {
		timeout: 20_000,
	}).toBe(true);
	let prompt = asked.find(item => item.prompt.includes("compare these"))!.prompt;
	expect(prompt).toContain(
		'@Site survey [heading anchor "site-survey", level 2, line 5 of this document]',
	);
	expect(prompt).toContain(`@Rollout [Decision id "${WIDGET}" of this document]`);
	expect(prompt).toContain(
		'@src/chat/composer.tsx [file path "src/chat/composer.tsx" in the repository]',
	);
	expect(prompt).toContain("%Release Research [reference id:");
	// The sent message draws each as a chip.
	let message = chat(page).locator("[data-chat-message-id]").filter({ hasText: "compare these" });
	await expect(message.locator('[data-chat-reference="heading"]')).toHaveText("@Site survey");
	await expect(message.locator('[data-chat-reference="decision"]')).toHaveText("@Rollout");
	await expect(message.locator('[data-chat-reference="research"]')).toHaveText("%Release Research");
	await expect(message.locator('[data-chat-reference="file"]')).toHaveText(
		"@src/chat/composer.tsx",
	);
	// Each is a chip, and none a link.
	await expect(message.locator("a[data-chat-reference]")).toHaveCount(0);
	await shoot(page, "chips-sent-desktop");
});

test("@ keeps Chopin and the people here, and offers no part of a document that has none", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	await attachClient(room);
	let input = chatInput(chat(page));
	let mentions = menu(page, "Mentions");
	await input.click();
	await page.keyboard.type("@ch");
	await expect(mentions.getByRole("option", { name: /^Chopin/ })).toBeVisible();
	await page.keyboard.press("Enter");
	// Chopin is the chip, not words in the draft.
	await expectChatValue(input, "");
	await expect(chat(page).getByRole("group", { name: "Asking Chopin", exact: true })).toBeVisible();
	await fillChat(input, "@");
	// A document with only its title lists that, its files and the people, and no Decision or card.
	await expect(mentions.getByRole("option").filter({ hasText: /file$/ })).toHaveCount(4);
	await expect(mentions.getByRole("option").filter({ hasText: /H\d$/ })).toHaveCount(1);
	await expect(mentions.getByRole("option").filter({ hasText: /decision$/ })).toHaveCount(0);
	await expect(mentions.getByRole("option").filter({ hasText: /research$/ })).toHaveCount(0);
	// An address in a sentence is not a mention.
	await fillChat(input, "mail a@b");
	await expect(mentions).toHaveCount(0);
});

test("on a phone the @ list stays inside the screen", async ({ browser }) => {
	test.setTimeout(120_000);
	let { room } = await mentionRoom(false);
	let page = await open(browser, HANDLE, room, PHONE);
	await attachClient(room);
	await page.getByRole("navigation", { name: "Workspace view" }).getByRole("button", {
		name: /Chat/,
	})
		.click();
	let input = chatInput(chat(page));
	await input.click();
	await page.keyboard.type("@");
	let mentions = menu(page, "Mentions");
	await expect(mentions.getByRole("option").filter({ hasText: /H\d$/ }).first()).toBeVisible({
		timeout: 15_000,
	});
	await expectInsideViewport(chat(page).locator("[data-chat-mention-picker]"));
	await expectNoHorizontalOverflow(page);
	await shoot(page, "mentions-phone");
});

test("a person who cannot read the document is refused its mentions", async ({ browser }) => {
	test.setTimeout(120_000);
	let { room } = await mentionRoom(false);
	let context = await browser.newContext(DESKTOP);
	let stranger = await context.newPage();
	await authenticate(stranger, `score-outsider-${room.slice(0, 8)}`, ORIGIN);
	let denied = await stranger.request.get(`${ORIGIN}/api/channels/${room}/mentions?query=`);
	expect(denied.status()).toBe(404);
	let anonymous = await (await browser.newContext()).request.get(
		`${ORIGIN}/api/channels/${room}/mentions?query=`,
	);
	expect(anonymous.status()).toBe(401);
	let reader = await context.newPage();
	await authenticate(reader, `score-reader-${room.slice(0, 8)}`, ORIGIN);
	let allowed = await reader.request.get(`${ORIGIN}/api/channels/${room}/mentions?query=site`);
	expect(allowed.status()).toBe(200);
	expect((await allowed.json()).headings).toEqual([
		{ anchor: "site-survey", text: "Site survey", level: 2 },
	]);
});
