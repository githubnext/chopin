import { seedCompletedResearchJob, seedRunningResearchJob } from "./database";
import { expect, test } from "./room";

const QUESTION_ID = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "What changed in the API?";
const SOURCE = `<ResearchQuestion id="${QUESTION_ID}">\n\n${QUESTION}\n\n</ResearchQuestion>\n`;

test("completed background research is readable inline and in Tasks", async ({ baseURL, join, room, seed }) => {
	await seed(SOURCE);
	await seedCompletedResearchJob(Number(new URL(baseURL!).port), room, QUESTION_ID, QUESTION);
	let page = await join("ana");

	await page.getByRole("button", { name: /Tasks & Progress/ }).click();
	await expect(page.getByRole("heading", { name: "Tasks & Progress" })).toBeVisible();
	await expect(page.getByText(`Research question: ${QUESTION}`)).toBeVisible();
	await page.getByRole("button", { name: `Read result for Research question: ${QUESTION}` })
		.click();
	await expect(page.getByText("The preview report is visible outside Conversation.")).toBeVisible();

	await page.getByRole("button", { name: "Document", exact: true }).click();
	await expect(page.getByText("Research: completed")).toBeVisible();
	await page.getByRole("button", { name: "Read report" }).click();
	await expect(page.getByRole("heading", { name: "Preview research report" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Example source" })).toHaveAttribute(
		"href",
		"https://example.com/source",
	);
});

test("compact navigation exposes task activity without horizontal overflow", async ({ baseURL, join, room, seed }) => {
	await seed(SOURCE);
	await seedCompletedResearchJob(Number(new URL(baseURL!).port), room, QUESTION_ID, QUESTION);
	let page = await join("ana");
	await page.setViewportSize({ width: 390, height: 844 });
	let tasks = page.getByRole("button", { name: /Tasks & Progress/ });
	await expect(tasks).toBeVisible();
	await tasks.click();
	await expect(page.getByRole("heading", { name: "Tasks & Progress" })).toBeFocused();
	let overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
	expect(overflow).toBe(false);
});

test("running research shows durable stage progress", async ({ baseURL, join, room, seed }) => {
	await seed(SOURCE);
	await seedRunningResearchJob(Number(new URL(baseURL!).port), room, QUESTION_ID, QUESTION);
	let page = await join("ana");
	await page.getByRole("button", { name: /Tasks & Progress/ }).click();
	let progress = page.getByRole("list", { name: `Progress for Research question: ${QUESTION}` });
	await expect(progress.getByText("Public web research")).toHaveCount(2);
	await expect(progress.getByText("Search results had no verifiable source metadata"))
		.toBeVisible();
	await expect(progress.getByText("Completed")).toBeVisible();
	await expect(progress.getByText("Private document analysis")).toBeVisible();
	await expect(progress.getByText("In progress")).toBeVisible();
	await page.reload();
	await expect(page.getByRole("heading", { name: "Tasks & Progress" })).toBeVisible();
	await expect(page.getByText("Private document analysis")).toBeVisible();
	await expect(page.getByText("In progress")).toBeVisible();
});
