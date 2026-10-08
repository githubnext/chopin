import { chatInput, expectChatValue } from "./chat-input";
import { expect, test } from "./room";
import { textContrast } from "./rendered-contrast";

test("a failed lazy dialog retains keyboard reload recovery", async ({ join, page }) => {
	await page.route(/\/assets\/document-search-dialog-[^/]+\.js$/, route => route.abort());
	await join("ana");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	let error = page.getByRole("alert");
	await expect(error).toContainText("Could not load this dialog.");
	await error.getByRole("button", { name: "Reload", exact: true }).focus();
	await page.keyboard.press("Enter");
	await expect(error).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
});

test("Projects explains its first lazy load and remains dismissible", async ({ join, page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	let release = Promise.withResolvers<void>();
	await page.route(/\/assets\/project-sidebar-[^/]+\.js$/, async route => {
		await release.promise;
		await route.continue();
	});
	try {
		await join("ana");
		let opener = page.getByRole("button", { name: "Show sidebar" });
		await opener.click();
		let drawer = page.getByRole("dialog", { name: "Projects", exact: true });
		let loading = drawer.getByRole("status").filter({ hasText: "Loading projects" });
		await expect(loading).toBeVisible();
		await drawer.getByRole("button", { name: "Hide sidebar" }).click();
		await expect(drawer).toBeHidden();
		await expect(opener).toBeFocused();
		await opener.click();
		await expect(drawer.getByRole("button", { name: "Hide sidebar" })).toBeFocused();
		release.resolve();
		await expect(drawer.getByRole("navigation", { name: "Projects" })).toBeVisible();
		await expect(loading).toHaveCount(0);
		await expect.poll(() => drawer.evaluate(element => element.contains(document.activeElement)))
			.toBe(true);
		await page.keyboard.press("Escape");
		await expect(drawer).toBeHidden();
		await expect(opener).toBeFocused();
	} finally {
		release.resolve();
	}
});

for (let width of [1280, 390]) {
	test(`delete confirmation contains an unbroken title at ${width}px`, async ({ join, page, room }) => {
		await page.setViewportSize({ width, height: 844 });
		await join("ana");
		let actions = page.getByRole("banner").getByRole("button", { name: /^Actions for / });
		await actions.click();
		await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
		let rename = page.getByRole("textbox", { name: "Document title" });
		let title = `${"ReleaseHandoff".repeat(8)}${room.slice(0, 8)}`;
		await rename.fill(title);
		await rename.press("Enter");
		await expect(rename).toBeHidden();
		await expect.poll(() =>
			page.getByRole("banner").locator("svg").evaluateAll(icons =>
				Math.min(...icons.map(icon => icon.getBoundingClientRect().width))
			)
		).toBeGreaterThanOrEqual(14);
		await actions.click();
		await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
		await actions.click();
		await page.getByRole("menuitem", { name: "Delete permanently", exact: true }).click();
		let dialog = page.getByRole("dialog", { name: "Delete document permanently?" });
		let name = dialog.getByText(title, { exact: true });
		await expect(name).toBeVisible();
		await expect.poll(() =>
			name.evaluate(element => {
				let paragraph = element.parentElement!;
				return paragraph.scrollWidth - paragraph.clientWidth;
			})
		).toBeLessThanOrEqual(1);
		await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
	});

	test(`chat send errors stay readable and preserve the draft at ${width}px`, async ({ join, page }) => {
		await page.setViewportSize({ width, height: 844 });
		await page.routeWebSocket("**/ws?**", route => {
			let server = route.connectToServer();
			route.onMessage(message => {
				if (typeof message === "string") {
					let frame = JSON.parse(message) as { kind?: string; rid?: string };
					if (frame.kind === "chat:send") {
						route.send(JSON.stringify({
							kind: "session:error",
							ts: 0,
							rid: frame.rid,
							message: "The message could not be saved. Check the connection and try again.",
						}));
						return;
					}
				}
				server.send(message);
			});
			server.onMessage(message => route.send(message));
		});
		await join("ana");
		if (width < 600) {
			await page.getByRole("navigation", { name: "Workspace view" })
				.getByRole("button", { name: /^Chat/ }).click();
		}
		let chat = page.getByRole("complementary", { name: "Chat", exact: true });
		let draft = chatInput(chat);
		await draft.fill("Keep this draft until the message is saved.");
		await chat.getByRole("button", { name: "Send message" }).click();
		let error = chat.getByRole("alert");
		await expect(error).toContainText("Check the connection and try again.");
		await expect.poll(() => error.evaluate(element => element.scrollWidth - element.clientWidth))
			.toBeLessThanOrEqual(1);
		await expectChatValue(draft, "Keep this draft until the message is saved.");
		await expect(draft).toBeFocused();
		await expect.poll(() =>
			draft.evaluate(element => {
				let style = getComputedStyle(element);
				return element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
					- parseFloat(style.lineHeight);
			})
		).toBeGreaterThanOrEqual(0);
		await expect(chat.getByRole("button", { name: "Send message" })).toBeEnabled();
	});
}

test("queued messages retain their state label and withdrawal control", async ({ join, page }) => {
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as { kind?: string };
			route.send(
				frame.kind !== "chat:history" ? message : JSON.stringify({
					...frame,
					busy: true,
					entries: [],
					queued: [{ id: "contrast-queue", handle: "ana", text: "Check the rollback path." }],
				}),
			);
		});
	});
	await join("ana");
	let queue = page.locator('[data-chat-state="queued"]');
	for (let text of ["Ana", "queued", "Check the rollback path."]) {
		let target = queue.getByText(text, { exact: true });
		await expect(target).toBeVisible();
	}
	await expect(queue.getByRole("button", { name: "Withdraw queued message" })).toBeEnabled();
});

test("destructive confirmation retains its reviewed color states", async ({ join, page }) => {
	await join("ana");
	let actions = page.getByRole("banner").getByRole("button", { name: /^Actions for / });
	await actions.click();
	await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
	await actions.click();
	await page.getByRole("menuitem", { name: "Delete permanently", exact: true }).click();
	let button = page.getByRole("dialog", { name: "Delete document permanently?" })
		.getByRole("button", { name: "Delete permanently", exact: true });
	await expect(button).toBeVisible();
	// The original red is an intentional contrast exception documented in DESIGN.md.
	await expect(button).toHaveCSS("background-color", "oklch(0.60513 0.17178 24.175)");
	await button.focus();
	await expect(button).toHaveCSS("background-color", "oklch(0.60513 0.17178 24.175)");
	await button.hover();
	expect(await textContrast(button), "hover").toBeGreaterThanOrEqual(4.5);
	await page.mouse.down();
	try {
		expect(await button.evaluate(element => element.matches(":active"))).toBe(true);
		expect(await textContrast(button), "pressed").toBeGreaterThanOrEqual(4.5);
	} finally {
		await page.mouse.move(0, 0);
		await page.mouse.up();
	}
});

test("delete keeps keyboard focus inside the dialog while pending and after failure", async ({ join, page, room }) => {
	let release = Promise.withResolvers<void>();
	await page.route(`**/api/channels/${room}`, async route => {
		if (route.request().method() !== "DELETE") return route.continue();
		await release.promise;
		await route.fulfill({ status: 503, json: { error: "Temporarily unavailable" } });
	});
	try {
		await join("ana");
		let actions = page.getByRole("banner").getByRole("button", { name: /^Actions for / });
		await actions.click();
		await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
		await actions.click();
		await page.getByRole("menuitem", { name: "Delete permanently", exact: true }).click();
		let dialog = page.getByRole("dialog", { name: "Delete document permanently?" });
		await dialog.getByRole("button", { name: "Delete permanently", exact: true }).click();
		await expect(dialog.getByRole("button", { name: "Deleting...", exact: true })).toBeDisabled();
		await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement)))
			.toBe(true);
		await page.keyboard.press("Tab");
		await expect(dialog).toBeFocused();
		release.resolve();
		await expect(dialog.getByRole("alert")).toContainText("Temporarily unavailable");
		await page.keyboard.press("Tab");
		await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
	} finally {
		release.resolve();
	}
});
