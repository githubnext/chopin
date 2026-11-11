/**
 * Images and files sent to the Planner, under `HARNESS=remote`: the models come from the client
 * attached to the document, so this file starts a server of its own and attaches a scripted client
 * over the real agent connection. An image goes only where the model the catalog names reads images;
 * a text file always goes. The client is sent them in the turn if it offered the feature, and told in
 * words if it did not.
 */
import { spawn } from "node:child_process";

import { SQL } from "bun";

import { connectAgent } from "../packages/agent-link/src/client";
import { finishTurn } from "../apps/server/src/testing/agent-link";
import { chat, chip, choose, composer, NOTES, plus, PNG, SHOT, strip } from "./chat-attachments";
import { chatInput, fillChat } from "./chat-input";
import { createChannel, registerTestDatabase } from "./database";
import { e2eDatabaseName, e2ePort } from "./ports";
import { authenticate, expect, ready, roomPath, test } from "./room";
import { HOST, ROOT } from "./servers";

import type { Page } from "@playwright/test";
import type { CapabilityCatalog } from "../packages/agent-link/src/protocol";
import type { TurnContext } from "../packages/agent-link/src/client";

const PORT = e2ePort(8805);
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = e2eDatabaseName("chopin_chat_attachments");
const HANDLE = "mona";

const SEES = {
	id: "acme/sees",
	name: "Sees",
	provider: { id: "acme", name: "Acme" },
	description: "Reads pictures too.",
	inputTypes: ["text", "image"],
};
const READS = {
	id: "acme/reads",
	name: "Reads",
	provider: { id: "acme", name: "Acme" },
	description: "Text only.",
	inputTypes: ["text"],
};
const SEEING: CapabilityCatalog = {
	models: { available: [SEES, READS], default: { id: SEES.id } },
};
const TEXT_ONLY: CapabilityCatalog = {
	models: { available: [SEES, READS], default: { id: READS.id } },
};

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
			throw new Error(`attachments server exited with ${child.exitCode}: ${errors.slice(-800)}`);
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

type Asked = TurnContext["message"];

/** The turn that answered `text`: a background job's turn for the same document comes between. */
function turnFor(asked: Asked[], text: string): Asked | undefined {
	return asked.findLast(turn =>
		turn.prompt.includes(text) && !turn.prompt.startsWith("[Background")
	);
}

/** A scripted client of the document, with the catalog it reports, and every turn it was asked to run. */
async function attachClient(room: string, catalog: CapabilityCatalog, attachments: boolean) {
	let asked: Asked[] = [];
	let client = await connectAgent({
		url: ORIGIN,
		token: `ghu_e2e_${HANDLE}_1`,
		document: room,
		resumable: false,
		capabilities: catalog,
		attachments,
		handlers: {
			async turn(context) {
				asked.push(context.message);
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

async function open(
	browser: import("@playwright/test").Browser,
	room: string,
	options: object = {},
) {
	let context = await browser.newContext(options);
	let page = await context.newPage();
	await authenticate(page, HANDLE, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	return page;
}

async function newRoom() {
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	return room;
}

/** The sparkle button that puts the @Chopin chip on, the chip that says so, and its cross. */
function ask(page: Page) {
	return chat(page).getByRole("button", { name: "Ask Chopin", exact: true });
}

function asking(page: Page) {
	return chat(page).getByRole("group", { name: "Asking Chopin", exact: true });
}

function remove(page: Page) {
	return chat(page).getByRole("button", { name: "Remove Chopin", exact: true });
}

const REASON = "This model can't read images, so only text files can be sent to it.";

test("a model that cannot read images is not sent one: the + says why, and an image is refused with the reason", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, room);
	let { client, asked } = await attachClient(room, TEXT_ONLY, true);
	await expect(chat(page)).toBeVisible();
	await expect(ask(page)).toBeVisible();

	// To the room, anyone reads an image: nothing is said.
	await expect(plus(page)).toHaveAttribute("title", "Add files");
	await ask(page).click();
	await expect(asking(page)).toBeVisible();
	await expect(plus(page)).toHaveAttribute("title", `Add files. ${REASON}`);
	await expect(plus(page)).toHaveAccessibleDescription(REASON);
	// The picker offers text, which is what can be sent.
	await expect(composer(page).locator("[data-chat-file-input]")).toHaveAttribute(
		"accept",
		/^text\/\*/,
	);

	await choose(page, SHOT);
	let refused = chip(page, "shot.png");
	await expect(refused).toHaveAttribute("data-state", "error");
	await expect(refused).toContainText(
		"This model can't read images. Send it as text, or to the room.",
	);
	await expect(
		composer(page).getByRole("alert").filter({
			hasText: "This model can't read images. Send it as text, or to the room.",
		}),
	).toHaveCount(1);
	await expect(refused.getByRole("button", { name: /again/ })).toHaveCount(0);
	await expect(composer(page).getByRole("button", { name: "Send message" })).toBeDisabled();

	// For the room it is fine again: the file was never touched, only the message's address changed.
	await remove(page).click();
	await expect(refused).toHaveAttribute("data-state", "done");
	await expect(plus(page)).toHaveAttribute("title", "Add files");
	await ask(page).click();
	await expect(refused).toHaveAttribute("data-state", "error");
	await refused.getByRole("button", { name: "Remove shot.png" }).click();

	// A text file goes, as a file, and no image does.
	await choose(page, NOTES);
	await expect(chip(page, "notes.md")).toHaveAttribute("data-state", "done");
	let input = chatInput(chat(page));
	await fillChat(input, "Read the notes");
	await input.press("Enter");
	await expect.poll(() => turnFor(asked, "Read the notes"), { timeout: 20_000 }).toBeDefined();
	let notesTurn = turnFor(asked, "Read the notes")!;
	expect(notesTurn.attachments).toEqual([
		{
			id: expect.any(String),
			name: "notes.md",
			kind: "file",
			mediaType: "text/plain",
			size: NOTES.buffer.byteLength,
			data: NOTES.buffer.toString("base64"),
		},
	]);
	await expect(chat(page).getByText("Done.")).toBeVisible();
	await client.detach();
});

test("a model that reads images is sent the image as its bytes, with the text file, in the turn", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, room);
	let { client, asked } = await attachClient(room, SEEING, true);
	await ask(page).click();
	await expect(plus(page)).toHaveAttribute("title", "Add files");
	await expect(composer(page).locator("[data-chat-file-input]")).not.toHaveAttribute(
		"accept",
		/.+/,
	);

	await choose(page, SHOT, NOTES);
	await expect(chip(page, "shot.png")).toHaveAttribute("data-state", "done");
	await expect(chip(page, "notes.md")).toHaveAttribute("data-state", "done");
	let input = chatInput(chat(page));
	await fillChat(input, "What is this?");
	await input.press("Enter");

	// It shows at once, as the person's own with its files, and the turn runs.
	let message = chat(page).locator("[data-chat-message-id]").filter({ hasText: "What is this?" });
	await expect(message.getByRole("group", { name: "Files sent with this message" })).toBeVisible();
	await expect.poll(() => turnFor(asked, "What is this?"), { timeout: 20_000 }).toBeDefined();
	let seen = turnFor(asked, "What is this?")!;
	expect(seen.attachments).toHaveLength(2);
	let [image, notes] = seen.attachments!;
	expect(image).toMatchObject({
		name: "shot.png",
		kind: "image",
		mediaType: "image/png",
		size: PNG.byteLength,
	});
	expect(Buffer.compare(Buffer.from(image!.data, "base64"), PNG)).toBe(0);
	expect(notes).toMatchObject({ name: "notes.md", kind: "file", mediaType: "text/plain" });
	await expect(strip(page)).toHaveCount(0);

	// The catalog changing under the composer changes what it offers, live.
	client.report(TEXT_ONLY);
	await expect(plus(page)).toHaveAttribute("title", `Add files. ${REASON}`);
	client.report(SEEING);
	await expect(plus(page)).toHaveAttribute("title", "Add files");
	await client.detach();
});

test("a client that did not ask for files is told of them in words, never sent a field it does not know", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, room);
	let { client, asked } = await attachClient(room, SEEING, false);
	await ask(page).click();
	await choose(page, SHOT, NOTES);
	await expect(chip(page, "shot.png")).toHaveAttribute("data-state", "done");
	await expect(chip(page, "notes.md")).toHaveAttribute("data-state", "done");
	let input = chatInput(chat(page));
	await fillChat(input, "What is this?");
	await input.press("Enter");
	await expect.poll(() => turnFor(asked, "What is this?"), { timeout: 20_000 }).toBeDefined();
	let told = turnFor(asked, "What is this?")!;
	expect(told).not.toHaveProperty("attachments");
	expect(told.prompt).toContain(
		"(An image, shot.png, was sent with this message, but this client can't be given images.)",
	);
	expect(told.prompt).toContain(
		'<file name="notes.md">\n# Notes\n\nThe cap is 100.\n\n</file>',
	);
	await client.detach();
});

test("a catalog that names no input types is text only, so a client from before them is never sent an image", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, room);
	let { client } = await attachClient(room, {
		models: { available: [{ id: "acme/old", name: "Old" }], default: { id: "acme/old" } },
	}, true);
	await ask(page).click();
	await expect(plus(page)).toHaveAttribute("title", `Add files. ${REASON}`);
	await client.detach();
});

test("a message to the Planner shows its files at once for a second person too", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, room);
	let other = await open(browser, room);
	let { client, asked } = await attachClient(room, SEEING, true);
	await ask(page).click();
	await choose(page, SHOT);
	await expect(chip(page, "shot.png")).toHaveAttribute("data-state", "done");
	await fillChat(chatInput(chat(page)), "Look");
	await chatInput(chat(page)).press("Enter");
	for (let viewer of [page, other]) {
		let message = chat(viewer).locator("[data-chat-message-id]").filter({ hasText: "Look" });
		await expect(message.getByRole("button", { name: /^shot\.png/ })).toBeVisible();
	}
	await expect.poll(() => turnFor(asked, "Look"), { timeout: 20_000 }).toBeDefined();
	await client.detach();
});
