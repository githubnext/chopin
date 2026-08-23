import { seedCompletedResearchAnswerJob, seedRunningResearchAnswerJob } from "./database";
import { expect, test } from "./room";

const QUESTION = "What changed in the API?";
const SOURCE = "# Research parent\n";

test("completed workspace research is summarized in Background Work", async ({ baseURL, join, room, seed }) => {
	await seed(SOURCE);
	await seedCompletedResearchAnswerJob(Number(new URL(baseURL!).port), room, QUESTION);
	let page = await join("ana");

	await page.getByRole("button", { name: /Background Work/ }).click();
	await expect(page.getByRole("heading", { name: "Background Work" })).toBeVisible();
	await expect(page.getByText(`Research answer: ${QUESTION}`)).toBeVisible();
	await page.getByRole("button", { name: `Read result for Research answer: ${QUESTION}` })
		.click();
	await expect(page.getByText("The preview report is visible outside Conversation.")).toBeVisible();
	await expect(page.getByRole("heading", { name: "Preview research report" })).toBeVisible();
});

test("compact navigation exposes background activity without horizontal overflow", async ({ baseURL, join, room, seed }) => {
	await seed(SOURCE);
	await seedCompletedResearchAnswerJob(Number(new URL(baseURL!).port), room, QUESTION);
	let page = await join("ana");
	await page.setViewportSize({ width: 390, height: 844 });
	let backgroundWork = page.getByRole("button", { name: /Background Work/ });
	await expect(backgroundWork).toBeVisible();
	await backgroundWork.click();
	await expect(page.getByRole("heading", { name: "Background Work" })).toBeFocused();
	let overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
	expect(overflow).toBe(false);
});

test("running research shows durable stage progress", async ({ baseURL, join, room, seed }) => {
	await seed(SOURCE);
	await seedRunningResearchAnswerJob(Number(new URL(baseURL!).port), room, QUESTION);
	let page = await join("ana");
	await page.getByRole("button", { name: /Background Work/ }).click();
	let progress = page.getByRole("list", { name: `Progress for Research answer: ${QUESTION}` });
	await expect(progress.getByText("Private document analysis", { exact: true })).toHaveCount(2);
	await expect(progress.getByText("Private document analysis failed"))
		.toBeVisible();
	await expect(progress.getByText("Completed")).toBeVisible();
	await expect(progress.getByText("Research report synthesis")).toBeVisible();
	await expect(progress.getByText("In progress")).toBeVisible();
	await page.reload();
	await expect(page.getByRole("heading", { name: "Background Work" })).toBeVisible();
	await expect(page.getByText("Research report synthesis")).toBeVisible();
	await expect(page.getByText("In progress")).toBeVisible();
});
