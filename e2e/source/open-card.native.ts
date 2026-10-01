import { expect, test } from "@playwright/test";
import {
	assertOpenCardErrors,
	card,
	loadOpenCard,
	openMeta,
	prepareOpenCard,
	sourceAction,
} from "./open-card-native";
test.beforeAll(prepareOpenCard);
test.afterEach(async ({ page }) => {
	await assertOpenCardErrors(page);
});

test("actual read-only inline card keeps durable people and Source without allowing draft writes", async ({ page }) => {
	await loadOpenCard(page);
	let people = card(page).getByRole("group", { name: "In this decision: ana, ben", exact: true });
	await expect(people).toBeVisible();
	await expect(people.getByRole("img")).toHaveCount(2);
	await expect(sourceAction(page)).toBeEnabled();
	await expect(card(page).getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
	await expect(card(page).getByRole("radio")).toHaveCount(2);
	for (let radio of await card(page).getByRole("radio").all()) await expect(radio).toBeDisabled();
	expect(await page.evaluate(() => window.openCardProbe.opens)).toEqual([]);
	expect(await page.evaluate(() => window.openCardProbe.snapshot().ids)).toEqual(["card-1"]);
});

test("durable and live people merge uniquely with three faces and accessible overflow", async ({ page }) => {
	await loadOpenCard(page, { canEdit: true });
	await expect.poll(() => page.evaluate(() => window.openCardProbe.opens)).toEqual(["card-1"]);
	let durable = ["ana", "ben", "cara", "dee", "eli", "fay", "gia", "hal"];
	await page.evaluate(
		({ meta, durable }) => window.openCardProbe.meta("card-1", { ...meta, involved: durable }),
		{ meta: openMeta, durable },
	);
	await page.evaluate(() => window.openCardProbe.peers(["ben", "ivy", "jay", "ivy"]));
	let people = card(page).getByRole("group", {
		name: "In this decision: ana, ben, cara, dee, eli, fay, gia, hal, ivy, jay",
		exact: true,
	});
	await expect(people).toBeVisible();
	await expect(people.getByRole("img")).toHaveCount(3);
	await expect(people).toContainText("+7");
	await expect(people.getByRole("img", { name: "ben", exact: true })).toHaveCount(1);
	await page.evaluate(() => window.openCardProbe.peers([]));
	let durablePeople = card(page).getByRole("group", {
		name: "In this decision: ana, ben, cara, dee, eli, fay, gia, hal",
		exact: true,
	});
	await expect(durablePeople).toBeVisible();
	await expect(durablePeople.getByRole("img")).toHaveCount(3);
	await expect(durablePeople).toContainText("+5");
	await expect(durablePeople.getByText("+7", { exact: true })).toHaveCount(0);
});

test("actual inline Source routes the current card to the first saved question source in real Room Chat", async ({ page }) => {
	await loadOpenCard(page);
	await sourceAction(page).click();
	await expect(page.locator('[data-chat-message-id="m1"]')).toHaveAttribute(
		"data-source-exact",
		"true",
	);
	let first = await page.evaluate(() => window.roomSourceProbe.snapshot().destination!);
	expect(first.itemId).toBe("thread-1");
	expect(first.source.messageId).toBe("m1");
	expect(first.source.quote).toBe("pilot");
	await page.evaluate(meta => {
		window.openCardProbe.meta("card-2", { ...meta, thread: "thread-2", involved: ["cara"] });
		window.openCardProbe.mountCard("card-2");
	}, openMeta);
	await expect.poll(() => page.evaluate(() => window.openCardProbe.snapshot().ids)).toEqual([
		"card-2",
	]);
	await expect(card(page).getByRole("group", { name: "In this decision: cara", exact: true }))
		.toBeVisible();
	await sourceAction(page).click();
	await expect(page.locator('[data-chat-message-id="m2"]')).toHaveAttribute(
		"data-source-exact",
		"true",
	);
	await expect(page.locator('[data-chat-message-id="m1"]')).not.toHaveAttribute(
		"data-source-exact",
		"true",
	);
	let second = await page.evaluate(() => window.roomSourceProbe.snapshot().destination!);
	expect(second.itemId).toBe("thread-2");
	expect(second.source.messageId).toBe("m2");
	expect(second.source.quote).toBe("broad");
	expect(second.token).toBeGreaterThan(first.token);
	expect(await page.evaluate(() => window.openCardProbe.opens)).toEqual([]);
});

test("actual inline Source is absent without authoritative thread or real callback", async ({ page }) => {
	await loadOpenCard(page);
	await page.evaluate(
		meta => window.openCardProbe.meta("card-1", { ...meta, thread: undefined }),
		openMeta,
	);
	await expect(sourceAction(page)).toHaveCount(0);
	await expect(card(page).getByRole("group", { name: "In this decision: ana, ben", exact: true }))
		.toBeVisible();
	await page.evaluate(meta => {
		window.openCardProbe.meta("card-1", meta);
		window.openCardProbe.mountCard("card-1", false);
	}, openMeta);
	await expect.poll(() => page.evaluate(() => window.openCardProbe.ready())).toBe(true);
	await expect(sourceAction(page)).toHaveCount(0);
	expect(await page.evaluate(() => window.roomSourceProbe.snapshot().destination)).toBeUndefined();
});
