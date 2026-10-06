import { content, expect, ready, test, written } from "../room";
import { installProbe } from "./probes";

test("the real authenticated editor has observable resource and editing continuity", async ({ context, join, room }) => {
	await context.addInitScript(installProbe);
	let page = await join("ana");
	let editor = content(page);
	await ready(page);
	if (process.env.LIVEAPP_TEST_INTEGRATED === "1") {
		await page.getByRole("button", { name: "Collapse developer widget" }).click();
	}
	let snapshot = () => page.evaluate(() => Reflect.get(globalThis, "__frontendProbe").snapshot());
	let before = await snapshot();
	expect(Object.keys(before.ids)).toEqual(expect.arrayContaining([
		"editor.editor",
		"editor.binding",
		"editor.provider",
		"editor.doc",
		"room.socket",
	]));
	let session = await page.request.get("/api/session").then(response => response.json());
	expect(session.user).toBeTruthy();
	await editor.click();
	await page.keyboard.type("An editable frontend baseline.");
	await written(page, room, /An editable frontend baseline\./);
	await page.keyboard.press("Shift+ArrowLeft");
	await page.keyboard.press("Shift+ArrowLeft");
	expect(await page.evaluate(() => getSelection()?.toString())).toBe("e.");
	expect(await snapshot()).toEqual(before);
	await page.getByRole("combobox", { name: /^Use @/ }).fill("An unsent message");
	expect(await snapshot()).toEqual(before);
	await expect(editor).toContainText("An editable frontend baseline.");
	await expect(page.getByRole("combobox", { name: /^Use @/ })).toHaveValue("An unsent message");
	expect(await page.request.get("/api/session").then(response => response.json())).toEqual(session);
});
