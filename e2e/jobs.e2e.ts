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

test("keyboard-opened research waits for its result and settles immediately after retry", async ({ baseURL, join, page, room, seed }) => {
	await seed(SOURCE);
	let jobId = await seedCompletedResearchAnswerJob(Number(new URL(baseURL!).port), room, QUESTION);
	let rejectDetail: (() => void) | undefined;
	let detailRequestedResolve: (() => void) | undefined;
	let detailRequested = new Promise<void>(resolve => detailRequestedResolve = resolve);
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { id?: string; kind: string; rid?: string };
				if (frame.kind === "job:get" && frame.id === jobId && !rejectDetail) {
					rejectDetail = () =>
						route.send(JSON.stringify({
							kind: "session:error",
							message: "Research detail is temporarily unavailable",
							rid: frame.rid,
							ts: 0,
						}));
					detailRequestedResolve?.();
					return;
				}
			}
			server.send(message);
		});
	});
	page = await join("ana");
	await page.getByRole("button", { name: /Background Work/ }).click();
	let trigger = page.getByRole("button", { name: `Read result for Research answer: ${QUESTION}` });

	await trigger.focus();
	await trigger.press("Enter");
	await detailRequested;
	expect(await trigger.getAttribute("aria-expanded")).toBe("false");
	expect(await trigger.getAttribute("aria-controls")).toBeNull();
	await expect(trigger).toHaveAttribute("aria-busy", "true");
	rejectDetail?.();
	await expect(trigger).not.toHaveAttribute("aria-busy");
	await page.evaluate(() => {
		let state = window as typeof window & { firstResearchResultClass?: string };
		let observer = new MutationObserver(() => {
			let result = document.querySelector<HTMLElement>(
				'[data-motion-disclosure="research-result"]',
			);
			if (!result) return;
			state.firstResearchResultClass = result.className;
			observer.disconnect();
		});
		observer.observe(document.body, { childList: true, subtree: true });
	});
	await trigger.press("Enter");
	expect(await page.evaluate(() => document.documentElement.dataset.motionInput)).toBe("keyboard");

	let result = page.locator('[data-motion-disclosure="research-result"]');
	await expect.poll(() =>
		page.evaluate(() =>
			(window as typeof window & { firstResearchResultClass?: string })
				.firstResearchResultClass
		)
	).toContain("is-open");
	await expect(result).toHaveClass(/is-open/);
});

test("research results settle immediately and retain an inert pointer exit", async ({ baseURL, join, room, seed }) => {
	await seed(SOURCE);
	await seedCompletedResearchAnswerJob(Number(new URL(baseURL!).port), room, QUESTION);
	let page = await join("ana");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.getByRole("button", { name: /Background Work/ }).click();
	let trigger = page.getByRole("button", { name: `Read result for Research answer: ${QUESTION}` });
	let result = page.locator('[data-motion-disclosure="research-result"]');
	await expect(trigger).not.toHaveAttribute("aria-controls");

	await trigger.click();
	await expect(result).toHaveClass(/is-open/);
	await expect(result).toHaveCSS("transition-duration", "0s");
	let resultId = await result.getAttribute("id");
	expect(resultId).toBeTruthy();
	trigger = page.getByRole("button", { name: `Hide result for Research answer: ${QUESTION}` });
	await expect(trigger).toHaveAttribute("aria-controls", resultId!);

	await page.emulateMedia({ reducedMotion: "no-preference" });
	await trigger.click();
	trigger = page.getByRole("button", { name: `Read result for Research answer: ${QUESTION}` });
	await expect(trigger).not.toHaveAttribute("aria-controls");
	await expect(result).toHaveClass(/is-closing/);
	await expect(result).toHaveAttribute("aria-hidden", "true");
	await expect(result).toHaveAttribute("inert", "");

	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(result).toHaveCount(0, { timeout: 100 });
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
