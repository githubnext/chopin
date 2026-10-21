import { chatInput } from "./chat-input";
import { content, expect, ready, test, written } from "./room";
import type { Page } from "@playwright/test";
import type { ConversationPlan } from "../packages/protocol/index";

async function send(page: Page, text: string) {
	let chat = page.getByRole("complementary", { name: "Chat" });
	await chatInput(chat).fill(text);
	await chat.getByRole("button", { name: "Send message", exact: true }).click();
}

async function surfaces(page: Page, title: string) {
	await expect(content(page).getByRole("heading", { name: title, exact: true })).toBeVisible();
	await expect(page.getByRole("group", { name: `Document: ${title}`, exact: true })).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Projects" })
			.locator('[aria-current="page"]'),
	).toHaveAccessibleName(title);
}

test(
	"saved Chat maintains titles with analysis off across peers, refinement and historical URLs",
	async ({ join, seed, page, room }, info) => {
		await seed(
			"# quiet-river\n\nGoal: Keep the existing goal.\n\nPreserved body prose.\n\n# Body section\n",
		);
		let jobs: ConversationPlan.Job[] = [];
		page.on("websocket", socket =>
			socket.on("framereceived", ({ payload }) => {
				if (typeof payload !== "string") return;
				let frame = JSON.parse(payload) as { kind: string; jobs?: ConversationPlan.Job[] };
				if (frame.kind === "conversation-plan:jobs") jobs = frame.jobs ?? [];
			}));
		let ana = await join("ana");
		let bo = await join("bo");
		let historical = ana.url();
		await send(ana, "Hello everyone.");
		await expect.poll(() => jobs.at(-1)?.status).toBe("done");
		await surfaces(ana, "quiet-river");
		await send(ana, "TITLE-TOPIC: Authentication choices");
		for (let peer of [ana, bo]) {
			await surfaces(peer, "Authentication choices");
			await expect(content(peer)).toContainText("Goal: Keep the existing goal.");
			await expect(content(peer)).toContainText("Preserved body prose.");
			await expect(content(peer).getByRole("heading", { name: "Body section", exact: true }))
				.toBeVisible();
			await expect(peer).toHaveURL(/authentication-choices/);
		}
		await send(ana, "@chopin TITLE-TOPIC: Offline retries");
		for (let peer of [ana, bo]) await surfaces(peer, "Offline retries");
		await expect.poll(() => jobs.at(-1)?.status).toBe("done");
		await expect(ana.getByRole("complementary", { name: "Chat" }))
			.toContainText("TITLE-TOPIC: Offline retries");
		await bo.goto(historical);
		await ready(bo);
		await surfaces(bo, "Offline retries");
		await expect(bo).toHaveURL(/offline-retries/);
		await bo.reload();
		await ready(bo);
		await surfaces(bo, "Offline retries");
		expect(jobs.map(job => job.kind)).toEqual(["heading", "heading", "heading"]);
		await written(
			bo,
			room,
			/^# Offline retries\n\nGoal: Keep the existing goal\.\n\nPreserved body prose\.\n\n# Body section\n$/,
		);
		await expect(bo.locator(".plan-cursor[data-plan-agent]")).toHaveCount(0);
		await bo.screenshot({ path: info.outputPath("automatic-title.png") });
	},
);

test("a heading job keeps the title a person chose", async ({ join, seed, page, room }) => {
	await seed("# E2E5 verify login resume\n\nExisting body.\n");
	let jobs: ConversationPlan.Job[] = [];
	page.on("websocket", socket =>
		socket.on("framereceived", ({ payload }) => {
			if (typeof payload !== "string") return;
			let frame = JSON.parse(payload) as { kind: string; jobs?: ConversationPlan.Job[] };
			if (frame.kind === "conversation-plan:jobs") jobs = frame.jobs ?? [];
		}));
	let ana = await join("ana");
	await send(ana, "TITLE-TOPIC: Verify login logic in auth.rs");
	await expect.poll(() => jobs.at(-1)?.status).toBe("done");
	await surfaces(ana, "E2E5 verify login resume");
	await written(ana, room, "# E2E5 verify login resume\n\nExisting body.\n");
	await ana.reload();
	await ready(ana);
	await surfaces(ana, "E2E5 verify login resume");
});

function doneJobs(page: Page): () => number {
	let jobs: ConversationPlan.Job[] = [];
	page.on("websocket", socket =>
		socket.on("framereceived", ({ payload }) => {
			if (typeof payload !== "string") return;
			let frame = JSON.parse(payload) as { kind: string; jobs?: ConversationPlan.Job[] };
			if (frame.kind === "conversation-plan:jobs") jobs = frame.jobs ?? [];
		}));
	return () => jobs.filter(job => job.status === "done").length;
}

test("a person typing a title keeps it while the Planner drafts one", async ({ join, seed, page, room }) => {
	await seed("# quiet-river\n\nExisting body.\n");
	let done = doneJobs(page);
	let ana = await join("ana");
	let bo = await join("bo");
	await ana.getByRole("group", { name: "Document: quiet-river", exact: true })
		.getByRole("button", { name: "Rename quiet-river", exact: true }).click();
	let field = ana.getByRole("textbox", { name: "Document title", exact: true });
	await field.fill("Login resume");
	await send(bo, "TITLE-TOPIC: Authentication choices");
	await expect.poll(done).toBe(1);
	await surfaces(bo, "quiet-river");
	await expect(field).toHaveValue("Login resume");
	await field.press("Enter");
	for (let peer of [ana, bo]) await surfaces(peer, "Login resume");
	// Later conversation does not redraft a title a person renamed.
	await send(bo, "TITLE-TOPIC: Offline retries");
	await expect.poll(done).toBe(2);
	for (let peer of [ana, bo]) await surfaces(peer, "Login resume");
	await written(bo, room, "# Login resume\n\nExisting body.\n");
});

test("a person with the caret in the document's title keeps it from a drafted title", async ({ join, seed, page, room }) => {
	await seed("# quiet-river\n\nExisting body.\n");
	let done = doneJobs(page);
	let ana = await join("ana");
	let bo = await join("bo");
	let heading = content(ana).getByRole("heading", { name: "quiet-river", exact: true });
	await heading.click();
	await send(bo, "TITLE-TOPIC: Authentication choices");
	await expect.poll(done).toBe(1);
	await surfaces(bo, "quiet-river");
	await ana.keyboard.press("End");
	await ana.keyboard.press("Shift+Home");
	await ana.keyboard.type("Login resume");
	await written(bo, room, "# Login resume\n\nExisting body.\n");
	await content(ana).getByText("Existing body.").click();
	await send(bo, "TITLE-TOPIC: Offline retries");
	await expect.poll(done).toBe(2);
	for (let peer of [ana, bo]) await surfaces(peer, "Login resume");
	await written(bo, room, "# Login resume\n\nExisting body.\n");
});
