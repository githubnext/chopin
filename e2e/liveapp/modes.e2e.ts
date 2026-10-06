import { content, expect, ready, test, written } from "../room";
import { createChannel, testChannelPath } from "../database";
import { installProbe } from "./probes";

test("the asynchronous entry selects the audit route once", async ({ page }) => {
	let requests: string[] = [];
	page.on("request", request => requests.push(request.url()));
	await page.addInitScript(installProbe);
	await page.goto("/design-audit");
	await expect(page.getByRole("heading", { name: "Chopin design audit", exact: true }))
		.toBeVisible();
	expect(
		await page.evaluate(() =>
			Reflect.get(globalThis, "__frontendProbe").snapshot().counts.reactRoot
		),
	).toBe(1);
	if (process.env.LIVEAPP_TEST_INTEGRATED === "1") {
		await expect(page.getByRole("dialog", { name: "LiveApp Developer" })).toBeVisible();
		expect(requests.some(url => url.includes("/@vite/client"))).toBe(false);
	} else {
		await expect(page.locator("[data-liveapp-widget]")).toHaveCount(0);
		expect(requests.some(url => url.includes("/@vite/client"))).toBe(true);
		expect(requests.some(url => /liveapp|__liveapp/.test(new URL(url).pathname))).toBe(false);
	}
});

test("ordinary document navigation disposes resources and keeps the original root", async ({ baseURL, context, join, room, page }) => {
	let other = crypto.randomUUID();
	await createChannel(Number(new URL(baseURL!).port), other);
	await context.addInitScript(installProbe);
	await join("ana");
	if (process.env.LIVEAPP_TEST_INTEGRATED === "1") {
		await page.getByRole("button", { name: "Collapse developer widget" }).click();
	}
	await content(page).click();
	await page.keyboard.type("Navigation persists this document.");
	await written(page, room, /Navigation persists this document\./);
	let before = await page.evaluate(() => Reflect.get(globalThis, "__frontendProbe").snapshot());
	await page.getByRole("link", { name: `Test ${other.slice(0, 8)}`, exact: true }).click();
	await expect(page).toHaveURL(baseURL + testChannelPath(other));
	await ready(page);
	let after = await page.evaluate(() => Reflect.get(globalThis, "__frontendProbe").snapshot());
	expect(after.ids["reactRoot.value"]).toBe(before.ids["reactRoot.value"]);
	expect(after.ids["editor.doc"]).not.toBe(before.ids["editor.doc"]);
	expect(after.releases.editor).toBeGreaterThan(before.releases.editor ?? 0);
	expect(after.releases.room).toBeGreaterThan(before.releases.room ?? 0);
	let internal = await page.request.get(process.env.LIVEAPP_TEST_WEB_ORIGIN + "/api/session");
	expect(internal.headers()["content-type"]).toContain("text/html");
	expect((await page.request.get("/api/session").then(response => response.json())).user)
		.toBeTruthy();
});
