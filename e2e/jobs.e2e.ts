import { seedCompletedResearchAnswerJob, seedRunningResearchAnswerJob } from "./database";
import { expect, test } from "./room";

const QUESTION = "What changed in the API?";
const SOURCE = "# Research parent\n";

test("seeded completed jobs stay out of the document workspace", async ({ baseURL, join, room, seed }) => {
	await seed(SOURCE);
	await seedCompletedResearchAnswerJob(Number(new URL(baseURL!).port), room, QUESTION);
	let page = await join("ana");

	await expect(page.getByRole("button", { name: /Background Work/ })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Background Work" })).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "editable markdown" })).toBeEditable();
	await expect(page.getByRole("complementary", { name: "Chat" })).toBeVisible();
});

test("seeded running jobs remain invisible after reload", async ({ baseURL, join, room, seed }) => {
	await seed(SOURCE);
	await seedRunningResearchAnswerJob(Number(new URL(baseURL!).port), room, QUESTION);
	let page = await join("ana");
	await expect(page.getByText("Research report synthesis", { exact: true })).toHaveCount(0);
	await page.reload();
	await expect(page.getByRole("button", { name: /Background Work/ })).toHaveCount(0);
	await expect(page.getByText("Research report synthesis", { exact: true })).toHaveCount(0);
});
