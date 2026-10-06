import { readFile, writeFile } from "node:fs/promises";
import { join as path } from "node:path";
import { content, expect, ready, test, written } from "../room";
import { installProbe } from "./probes";

test("populated chat renders Markdown before and after a live presentation edit", async ({ context, join, page, room }) => {
	test.setTimeout(180_000);
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await context.addInitScript(installProbe);
	await join("ana");
	let integrated = process.env.LIVEAPP_TEST_INTEGRATED === "1";
	if (integrated) await page.getByRole("button", { name: "Collapse developer widget" }).click();
	let composer = page.getByRole("combobox", { name: /^Use @/ });
	await composer.fill(
		"A **formatted message** with [documentation](https://example.org/docs) and `code`.",
	);
	await composer.press("Enter");
	let message = page.locator("[data-chat-markdown]").filter({ hasText: "formatted message" });
	await expect(message.locator("strong")).toHaveText("formatted message");
	await expect(message.getByRole("link", { name: "documentation" })).toHaveAttribute(
		"href",
		"https://example.org/docs",
	);
	await expect(message.locator("code")).toHaveText("code");
	// Exercise the saved transcript on initial rendering, as well as new messages.
	await page.reload();
	await ready(page);
	await expect(message.locator("strong")).toHaveText("formatted message");
	await composer.fill("Unsent chat draft");
	await content(page).click();
	await page.keyboard.type("Kept document text.");
	await written(page, room, /Kept document text\./);
	await page.keyboard.press("Shift+ArrowLeft");
	let snapshot = () => page.evaluate(() => Reflect.get(globalThis, "__frontendProbe").snapshot());
	let before = await snapshot();
	if (integrated) {
		let root = process.env.LIVEAPP_TEST_ROOT!;
		let file = "apps/web/src/chat/markdown.tsx";
		let original = await readFile(path(root, file), "utf8");
		let updated = original.replace(
			"<ReactMarkdown",
			"<span>Live message preview</span>\n\t\t\t<ReactMarkdown",
		);
		expect(updated).not.toBe(original);
		await writeFile(path(root, file), updated);
		await expect.poll(async () => {
			let saved = JSON.parse(await readFile(path(root, ".liveapp/project.json"), "utf8"));
			return saved.records.find((record: { id: string }) => record.id === saved.revision.id)
				.files[file];
		}, { timeout: 120_000 }).toBe(updated);
		await expect(message.getByText("Live message preview", { exact: true })).toBeVisible();
		expect(await page.evaluate(() => getSelection()?.toString())).toBe(".");
		await page.getByRole("button", { name: "Open LiveApp Developer" }).click();
		await expect(page.getByRole("dialog", { name: "LiveApp Developer" })).toBeVisible();
		expect(
			await page.evaluate(() =>
				Reflect.get(globalThis, "__liveappAutomaticClient").store.snapshot().error ?? ""
			),
		).toBe("");
	}
	await expect(message.locator("strong")).toHaveText("formatted message");
	await expect(message.getByRole("link", { name: "documentation" })).toHaveAttribute(
		"href",
		"https://example.org/docs",
	);
	await expect(composer).toHaveValue("Unsent chat draft");
	await expect(content(page)).toHaveText("Kept document text.");
	expect(await snapshot()).toEqual(before);
	expect(errors).toEqual([]);
});
