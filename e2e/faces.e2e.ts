/**
 * Every person is drawn with the picture GitHub's API returned when they signed in.
 *
 * `github.com/<login>.png` is only a guess, and for an account such as an Enterprise Managed User
 * (`name_company`) it names no picture, so a face that guessed gave them an initial or GitHub's
 * default. The fake GitHub answers each sign-in with `https://example.invalid/<login>.png`, which is
 * not what the guess would be, so a face showing it was told the stored picture by the server.
 * github.com is not reachable from the harness: the guess is answered with a different tile and
 * recorded, so a face that reached for it is caught.
 */

import { chatInput } from "./chat-input";
import { expect, openIsolatedRoom, test } from "./room";

import type { BrowserContext, Locator, Page } from "@playwright/test";

function tile(fill: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${fill}"/></svg>`;
}

/** Answer the stored pictures with a tile, the guesses with another, and count every guess. */
async function stubPictures(
	context: BrowserContext,
	guessed: string[],
	failing: readonly string[] = [],
): Promise<void> {
	await context.route("https://example.invalid/*.png", route => {
		let login = new URL(route.request().url()).pathname.slice(1, -".png".length);
		if (failing.includes(login)) return route.abort();
		return route.fulfill({ contentType: "image/svg+xml", body: tile("#2f6f3e") });
	});
	await context.route("https://github.com/*.png*", route => {
		guessed.push(new URL(route.request().url()).pathname.slice(1, -".png".length));
		return route.fulfill({ contentType: "image/svg+xml", body: tile("#a33") });
	});
}

function chat(page: Page): Locator {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

/** A face's photograph: it counts as drawn only once the browser has decoded it. */
async function drawn(photograph: Locator, source: string): Promise<void> {
	await expect(photograph).toHaveAttribute("src", source);
	await expect.poll(() => photograph.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(
		40,
	);
}

function inHeader(page: Page, login: string): Locator {
	return page.getByRole("group", { name: /^People here:/ }).getByRole("img", { name: login })
		.locator("img");
}

function inChat(page: Page, said: string): Locator {
	return chat(page).locator("[data-chat-entry]").filter({ hasText: said }).locator("img");
}

test("a person's stored GitHub picture is drawn in Chat and in presence, for them and for the others", async ({ baseURL, browser, room }) => {
	let guessed: string[] = [];
	let opened = [] as Array<{ close: () => Promise<void> }>;
	let join = async (login: string) => {
		let person = await openIsolatedRoom(
			browser,
			baseURL!,
			room,
			login,
			{},
			context => stubPictures(context, guessed),
		);
		opened.push(person);
		return person.page;
	};
	try {
		let mona = await join("mona_acme");
		let hubot = await join("hubot_acme");

		await chatInput(chat(mona)).fill("Morning, both.");
		await chat(mona).getByRole("button", { name: "Send message" }).click();
		await expect(chat(hubot).getByText("Morning, both.")).toBeVisible();

		await chatInput(chat(hubot)).fill("Morning, Mona.");
		await chat(hubot).getByRole("button", { name: "Send message" }).click();
		await expect(chat(mona).getByText("Morning, Mona.")).toBeVisible();

		for (let page of [mona, hubot]) {
			await expect(page.getByRole("group", { name: /^People here:/ })).toHaveAccessibleName(
				"People here: hubot_acme, mona_acme",
			);
			await drawn(inHeader(page, "mona_acme"), "https://example.invalid/mona_acme.png");
			await drawn(inHeader(page, "hubot_acme"), "https://example.invalid/hubot_acme.png");
			await drawn(inChat(page, "Morning, both."), "https://example.invalid/mona_acme.png");
			await drawn(inChat(page, "Morning, Mona."), "https://example.invalid/hubot_acme.png");
		}
		expect(guessed).toEqual([]);
	} finally {
		await Promise.all(opened.map(person => person.close()));
	}
});

test("an author who has left is still drawn as themselves for whoever opens the document after", async ({ baseURL, browser, room }) => {
	let guessed: string[] = [];
	let join = (login: string) =>
		openIsolatedRoom(browser, baseURL!, room, login, {}, context => stubPictures(context, guessed));
	let leaving = await join("mona_acme");
	// Seeing the message is what shows the server has it: the sender's own page draws it while it
	// still waits to be sent, and closing that page then would take the message with it.
	let witness = await join("hubot_acme");
	let arriving: Awaited<ReturnType<typeof join>> | undefined;
	try {
		await chatInput(chat(leaving.page)).fill("I was here first.");
		await chat(leaving.page).getByRole("button", { name: "Send message" }).click();
		await expect(chat(witness.page).getByText("I was here first.")).toBeVisible();
		await leaving.close();
		await expect(witness.page.getByRole("group", { name: /^People here:/ })).toHaveAccessibleName(
			"People here: hubot_acme",
		);

		arriving = await join("cy_acme");
		let page = arriving.page;
		await expect(page.getByRole("group", { name: /^People here:/ })).toHaveAccessibleName(
			"People here: cy_acme, hubot_acme",
		);
		await expect(chat(page).getByText("I was here first.")).toBeVisible();
		await drawn(inChat(page, "I was here first."), "https://example.invalid/mona_acme.png");
		expect(guessed).toEqual([]);
	} finally {
		await arriving?.close();
		await witness.close();
		await leaving.close().catch(() => {});
	}
});

test("a stored picture that will not load gives way to the guess from the login, then to the initial", async ({ baseURL, browser, room }) => {
	let guessed: string[] = [];
	let person = await openIsolatedRoom(
		browser,
		baseURL!,
		room,
		"gone_acme",
		{},
		context => stubPictures(context, guessed, ["gone_acme"]),
	);
	try {
		let page = person.page;
		await drawn(inHeader(page, "gone_acme"), "https://github.com/gone_acme.png?size=48");
		expect(guessed).toContain("gone_acme");

		// With the guess gone too, only the initial is left.
		await page.context().unroute("https://github.com/*.png*");
		await page.context().route("https://github.com/*.png*", route => route.abort());
		await page.reload();
		let face = page.getByRole("group", { name: /^People here:/ }).getByRole("img", {
			name: "gone_acme",
		});
		await expect(face).toHaveText("g");
		await expect(face.locator("img")).toHaveCount(0);
	} finally {
		await person.close();
	}
});
