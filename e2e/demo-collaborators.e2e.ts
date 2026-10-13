import { chatInput, expectChatValue } from "./chat-input";
import { expect, ORIGIN, test } from "./demo-server";
import { content, ready, roomPath, written } from "./room";

import type { Page, WebSocketRoute } from "@playwright/test";

test.use({ actionTimeout: 10_000 });

async function launch(presenter: Page, name = "Lily"): Promise<Page> {
	await presenter.getByRole("button", { name: /^Actions for Test/ }).click();
	let opened = presenter.context().waitForEvent("page");
	await presenter.getByRole("menuitem", { name: `Open as collaborator: ${name}` }).click();
	let persona = await opened;
	await ready(persona);
	expect(persona.context()).toBe(presenter.context());
	await expect(persona.getByLabel(`Acting as ${name}, a demo collaborator`)).toBeVisible();
	await expect(persona).toHaveTitle(new RegExp(`^${name} · `));
	expect(new URL(persona.url()).searchParams.has("persona")).toBe(false);
	return persona;
}

async function people(page: Page, names: string[]) {
	let group = page.getByRole("group", { name: /^People here:/ });
	await expect(group.getByRole("img")).toHaveCount(names.length);
	for (let name of names) {
		await expect(group.getByRole("img", { name, exact: true })).toHaveCount(1);
	}
}

async function append(page: Page, text: string) {
	let paragraph = content(page).locator("p").first();
	await paragraph.click();
	// ArrowRight after selectText can cross into the next paragraph and escape the leading space.
	await paragraph.evaluate(element => {
		let range = document.createRange();
		range.selectNodeContents(element);
		range.collapse(false);
		let selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
	});
	await page.keyboard.type(text);
}

async function say(page: Page, text: string) {
	let input = chatInput(page);
	await input.fill(text);
	await input.press("Enter");
	await expectChatValue(input, "");
}

function message(page: Page, text: string) {
	return page.locator("[data-chat-entry]").filter({ hasText: text });
}

function lilyCursor(page: Page) {
	return page.locator(".plan-cursor").filter({ hasText: /^Lily$/ });
}

async function authorship(page: Page) {
	await expect(message(page, "Lily message").getByText("Lily", { exact: true })).toBeVisible();
	await expect(message(page, "Presenter message").getByText("Octocat", { exact: true }))
		.toBeVisible();
	await page.getByRole("button", { name: "Document", exact: true }).click();
	await page.getByRole("button", { name: /Comment on “A second paragraph/ }).click();
	let thread = page.getByRole("dialog", { name: "Comment thread" });
	await expect(thread.getByText("Lily(@demo:lily)", { exact: true })).toBeVisible();
	await expect(thread.getByText("Octocat(@octocat)", { exact: true })).toBeVisible();
	await expect(thread).toContainText("Presenter reply");
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let resolved = page.getByRole("button", { name: "2 resolved", exact: true });
	if (await resolved.getAttribute("aria-expanded") !== "true") await resolved.click();
	await expect(page.locator('[data-document-view="decisions"]')).toContainText("Answered by Lily");
	await expect(page.locator('[data-document-view="decisions"]')).toContainText(
		"Answered by @octocat",
	);
}

test("shared-cookie tabs keep distinct presence, edits and durable authorship", async ({ demo, page, room }) => {
	test.setTimeout(120_000);
	await demo.login(page);
	await page.goto(roomPath(room));
	await ready(page);
	let lily = await launch(page);
	await people(page, ["octocat", "Lily"]);
	await people(lily, ["octocat", "Lily"]);
	await expect(page.getByLabel("Acting as Lily, a demo collaborator")).toHaveCount(0);
	await expect(page).not.toHaveTitle(/^Lily/);
	let face = page.getByRole("group", { name: /^People here:/ })
		.getByRole("img", { name: "Lily", exact: true }).locator("img");
	await expect(face).toHaveAttribute("src", "/demo/lily.svg");
	await expect.poll(() => face.evaluate(image => (image as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(0);

	await append(page, " From the presenter.");
	await expect(content(lily)).toContainText("From the presenter.");
	await append(lily, " From Lily.");
	await expect(content(page)).toContainText("From Lily.");
	await expect(lilyCursor(page)).toHaveCount(1);
	await expect(lilyCursor(page)).toBeVisible();
	await expect(lily.locator(".plan-cursor").filter({ hasText: /^octocat$/ })).toBeVisible();
	await expect(page.locator(".plan-cursor").getByText("octocat", { exact: true })).toHaveCount(0);
	await expect(lily.locator(".plan-cursor").getByText("Lily", { exact: true })).toHaveCount(0);

	await chatInput(page).fill("Presenter draft");
	await chatInput(lily).fill("Lily draft");
	await expectChatValue(chatInput(page), "Presenter draft");
	await say(page, "Presenter message");
	await say(lily, "Lily message");
	for (let peer of [page, lily]) {
		await expect(message(peer, "Presenter message").getByText("Octocat", { exact: true }))
			.toBeVisible();
		await expect(message(peer, "Lily message").getByText("Lily", { exact: true })).toBeVisible();
	}

	await content(lily).locator("p").nth(1).click();
	await content(lily).locator("p").nth(1).selectText();
	await expect(lily.getByRole("button", { name: "Comment on this passage", exact: true }))
		.toBeVisible();
	await lily.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let draft = lily.getByRole("dialog", { name: "New comment" });
	await draft.getByPlaceholder("Add a comment").fill("Lily's comment");
	await draft.getByRole("button", { name: /^(Comment|Post comment)$/ }).click();
	await expect(draft).toHaveCount(0);
	await lily.keyboard.press("Escape");
	await expect(page.getByRole("button", { name: /Comment on “A second paragraph/ })).toBeVisible();
	await page.getByRole("button", { name: /Comment on “A second paragraph/ }).click();
	await expect(page.getByRole("dialog", { name: "Comment thread" }))
		.toContainText("Lily's comment");
	let thread = page.getByRole("dialog", { name: "Comment thread" });
	await expect(thread.getByText("Lily(@demo:lily)", { exact: true })).toBeVisible();
	await thread.getByRole("textbox", { name: "Reply", exact: true }).fill("Presenter reply");
	await thread.getByRole("button", { name: "Send reply", exact: true }).click();
	await expect(thread.getByText("Octocat(@octocat)", { exact: true })).toBeVisible();
	await page.keyboard.press("Escape");

	await lily.getByRole("button", { name: /^Decisions/ }).click();
	let card = lily.locator('[data-document-view="decisions"] article')
		.filter({ has: lily.getByRole("heading", { name: "Where should room state live?" }) });
	await card.getByRole("radio", { name: /On disk as MDX/ }).check();
	await card.getByRole("button", { name: "Save", exact: true }).click();
	await expect(lily.locator('[data-document-view="decisions"]'))
		.toContainText("Answered by Lily");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let scope = page.locator('[data-document-view="decisions"] article')
		.filter({
			has: page.getByRole("heading", { name: "Which of these belong in the first cut?" }),
		});
	await scope.getByRole("checkbox", { name: /^Anchors / }).check();
	await scope.getByRole("button", { name: "Save", exact: true }).click();
	await page.getByRole("button", { name: "2 resolved", exact: true }).click();
	await expect(page.locator('[data-document-view="decisions"]')).toContainText(
		"Answered by @octocat",
	);
	await page.getByRole("button", { name: "Document", exact: true }).click();
	await written(page, room, "From Lily.");

	await lily.close();
	await people(page, ["octocat"]);
	lily = await launch(page);
	await people(page, ["octocat", "Lily"]);
	await authorship(lily);
	await demo.restart();
	await page.reload();
	await lily.reload();
	await ready(page);
	await ready(lily);
	await people(page, ["octocat", "Lily"]);
	await authorship(page);
	await page.evaluate(async () => {
		await document.fonts.ready;
		await Promise.all(
			document.getAnimations().filter(animation =>
				animation.effect?.getTiming().iterations !== Infinity
			)
				.map(animation => animation.finished.catch(() => {})),
		);
	});
	let screenshot = test.info().outputPath("shared-context-authorship.png");
	await page.screenshot({ path: screenshot });
	await test.info().attach("shared-context-authorship", {
		path: screenshot,
		contentType: "image/png",
	});
});

test("a persona reclaims its actor after transport loss and reload without stale presence", async ({ demo, page, room }) => {
	test.setTimeout(90_000);
	await demo.login(page);
	await page.goto(roomPath(room));
	await ready(page);
	let lily = await launch(page);
	let sockets: WebSocketRoute[] = [];
	let claims: (string | null)[] = [];
	let offline = false;
	await lily.routeWebSocket("**/ws?**", socket => {
		claims.push(new URL(socket.url()).searchParams.get("actor"));
		if (offline) return socket.close();
		socket.connectToServer();
		sockets.push(socket);
	});
	await lily.reload();
	await ready(lily);
	await append(lily, " Lily before disconnect.");
	await expect(lilyCursor(page)).toHaveCount(1);
	await people(page, ["octocat", "Lily"]);
	await chatInput(page).fill("Presenter unsent");
	await chatInput(lily).fill("Lily unsent");

	for (let reload of [false, true]) {
		let before = sockets.length;
		offline = true;
		await sockets.at(-1)!.close();
		await people(page, ["octocat"]);
		await expect(lilyCursor(page)).toHaveCount(0);
		await expect(content(lily)).toHaveAttribute("contenteditable", "false");
		let text = reload ? " Written during reload." : " Written during transport loss.";
		await append(page, text);
		await written(page, room, text);
		if (reload) await lily.reload();
		offline = false;
		await lily.evaluate(() => dispatchEvent(new Event("online")));
		await ready(lily);
		await expect.poll(() => sockets.length).toBeGreaterThan(before);
		await expect(content(lily)).toContainText(text.trim());
		await people(page, ["octocat", "Lily"]);
		await people(lily, ["octocat", "Lily"]);
		await expectChatValue(chatInput(lily), "Lily unsent");
		await expectChatValue(chatInput(page), "Presenter unsent");
		await append(lily, reload ? " Lily after reload." : " Lily after transport.");
		await expect(content(page)).toContainText(
			reload ? "Lily after reload." : "Lily after transport.",
		);
		await expect(lilyCursor(page)).toHaveCount(1);
		await expect(lilyCursor(page)).toBeVisible();
	}
	expect(claims.length).toBeGreaterThanOrEqual(3);
	expect(claims.every(actor => actor === "demo:lily")).toBe(true);
	await say(lily, "Lily after reconnect");
	await expect(message(page, "Lily after reconnect").getByText("Lily", { exact: true }))
		.toBeVisible();
	await lily.close();
	await people(page, ["octocat"]);
	await expect(page.locator(".plan-cursor")).toHaveCount(0);
});

test("unknown actors are refused and disabling personas restores ordinary shared-cookie tabs", async ({ demo, page, room }) => {
	await demo.login(page);
	await page.goto(roomPath(room));
	await ready(page);
	let probe = async (actor: string) =>
		page.request.get(
			`${ORIGIN}/ws?channel=${room}&actor=${encodeURIComponent(actor)}`,
			{ headers: { "x-chopin-socket-probe": "1" } },
		);
	expect((await probe("demo:unknown")).status()).toBe(403);
	let lily = await launch(page);
	await demo.restart(false);
	await page.reload();
	await lily.reload();
	await ready(page);
	await ready(lily);
	expect((await probe("demo:lily")).status()).toBe(403);
	await people(page, ["octocat"]);
	await expect(lily.getByLabel("Acting as Lily, a demo collaborator")).toHaveCount(0);
	expect(await lily.evaluate(() => sessionStorage.getItem("chopin:demo-actor"))).toBeNull();
	await page.getByRole("button", { name: /^Actions for Test/ }).click();
	await expect(page.getByRole("menuitem", { name: /Open as collaborator/ })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await append(lily, " Ordinary actor after disabling.");
	await expect(content(page)).toContainText("Ordinary actor after disabling.");
	await say(lily, "Ordinary Chat after disabling");
	await expect(message(page, "Ordinary Chat after disabling")).toContainText("Octocat");
	await lily.close();
	await people(page, ["octocat"]);
});
