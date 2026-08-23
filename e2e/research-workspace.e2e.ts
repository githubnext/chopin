import {
	readResearchWorkspaceState,
	seedCompletedResearchWorkspace,
	testChannelPath,
} from "./database";
import { expectNoHorizontalOverflow } from "./responsive";
import { authenticate, expect, ready, test } from "./room";

import type { Page } from "@playwright/test";

const SOURCE = `# Research parent

The parent document contains private implementation context for the report.
`;
const REPORT = {
	title: "Durable research report",
	summary: "The completed report remains attached to its parent document.",
	finding: "The first-class workspace preserves cited findings across reloads.",
	caveat: "Public evidence should still be reviewed by a repository member.",
	source: {
		title: "Canonical public research source",
		url: "https://example.com/research/provenance/first-class-workspace",
	},
};

function port(baseURL: string): number {
	return Number(new URL(baseURL).port);
}

function parentTitle(room: string): string {
	return `Test ${room.slice(0, 8)}`;
}

function question(room: string): string {
	return `How does workspace ${room.slice(0, 8)} preserve research provenance?`;
}

function projects(page: Page) {
	return page.getByRole("complementary", { name: "Projects" });
}

async function createPrivateDraft(
	page: Page,
	room: string,
	researchQuestion: string,
): Promise<{ workspaceId: string; path: string }> {
	let title = parentTitle(room);
	await projects(page).getByRole("button", {
		name: `New research in ${title}`,
		exact: true,
	}).click();
	let dialog = page.getByRole("dialog", { name: `New research in ${title}`, exact: true });
	let input = dialog.getByRole("textbox", { name: "Research question", exact: true });
	await expect(dialog).toBeVisible();
	await expect(input).toBeFocused();
	await input.fill(researchQuestion);
	let createdResponse = page.waitForResponse(response =>
		response.request().method() === "POST"
		&& new URL(response.url()).pathname === `/api/channels/${room}/research-workspaces`
	);
	await dialog.getByRole("button", { name: "Create private draft", exact: true }).click();
	let response = await createdResponse;
	expect(response.status()).toBe(201);
	let location = response.headers().location;
	expect(location).toBeTruthy();
	let path = new URL(location!, page.url()).pathname;
	let workspaceId = decodeURIComponent(path.split("/").at(-1)!);
	expect(path).toBe(`${testChannelPath(room)}/research/${encodeURIComponent(workspaceId)}`);
	await expect(page).toHaveURL(url => url.pathname === path);
	return { workspaceId, path };
}

async function expectCompletedReport(page: Page): Promise<void> {
	await expect(page.getByRole("heading", { name: REPORT.title, exact: true, level: 2 }))
		.toBeVisible();
	await expect(page.getByText(REPORT.summary, { exact: true })).toBeVisible();
	await expect(page.getByText(REPORT.finding, { exact: true })).toBeVisible();
	await expect(page.getByText(REPORT.caveat, { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: REPORT.source.title, exact: true })).toHaveAttribute(
		"href",
		REPORT.source.url,
	);
	await expect(page.getByText(
		"Document revision 0 was analyzed privately and separately from public web evidence.",
		{ exact: true },
	)).toBeVisible();
}

test("the sidebar creates a private research draft before any public search", async ({ baseURL, join, room }) => {
	let page = await join("ana");
	let researchQuestion = question(room);
	let created = await createPrivateDraft(page, room, researchQuestion);

	let proposedQuestion = page.getByRole("textbox", {
		name: "Research question",
		exact: true,
	});
	await expect(page.getByRole("heading", { name: researchQuestion, exact: true, level: 1 }))
		.toBeVisible();
	await expect(proposedQuestion).toBeEditable();
	await expect(proposedQuestion).toHaveValue(researchQuestion);
	await expect(page.getByText(
		"The exact text you submit is disclosed to public web search. Private document context is analyzed separately and is not sent as search input.",
		{ exact: true },
	)).toBeVisible();
	await expect(page.getByRole("button", { name: "Search public web", exact: true })).toBeDisabled();
	await expect(page.getByText("Research execution is unavailable in this deployment.", {
		exact: true,
	})).toBeVisible();

	let state = await readResearchWorkspaceState(port(baseURL!), room, created.workspaceId);
	expect(state).toEqual({
		confirmed: false,
		revision: 0,
		nextTurnOrdinal: 1,
		nextMessageSequence: 1,
		turns: 0,
		messages: 0,
		jobs: 0,
	});
});

test("a completed workspace is a durable nested child with immutable report provenance", async ({ baseURL, page, room, seed }) => {
	await seed(SOURCE);
	let researchQuestion = question(room);
	let fixture = await seedCompletedResearchWorkspace(port(baseURL!), room, {
		question: researchQuestion,
		report: REPORT,
	});
	await authenticate(page, "ana", baseURL!);
	await page.goto(fixture.path);

	await expectCompletedReport(page);
	let sidebar = projects(page);
	let parent = sidebar.getByRole("link", { name: parentTitle(room), exact: true });
	let child = sidebar.getByRole("link", { name: researchQuestion, exact: true });
	await expect(child).toBeVisible();
	await expect(child).toHaveAttribute("href", fixture.path);
	await expect(child).toHaveAttribute("aria-current", "page");
	await expect(sidebar.locator('[aria-current="page"]')).toHaveCount(1);
	await expect(parent).not.toHaveAttribute("aria-current", "page");
	await expect(parent.locator("..")).toHaveClass(/project-sidebar-document-ancestor/);

	await page.reload();
	await expect(page).toHaveURL(url => url.pathname === fixture.path);
	await expectCompletedReport(page);
	await expect(projects(page).getByRole("link", { name: researchQuestion, exact: true }))
		.toHaveAttribute("aria-current", "page");
});

test("collaborators receive a newly created research child without reloading", async ({ join, room, seed }) => {
	await seed(SOURCE);
	let ana = await join("ana");
	let bo = await join("bo");
	let researchQuestion = question(room);
	await bo.evaluate(() =>
		Object.defineProperty(window, "__researchWorkspaceNoReload", {
			configurable: true,
			value: true,
		})
	);

	let created = await createPrivateDraft(ana, room, researchQuestion);
	let sharedChild = projects(bo).getByRole("link", { name: researchQuestion, exact: true });
	await expect(sharedChild).toBeVisible();
	await expect(sharedChild).toHaveAttribute("href", created.path);
	expect(await bo.evaluate(() => "__researchWorkspaceNoReload" in window)).toBe(true);

	await sharedChild.click();
	await expect(bo).toHaveURL(url => url.pathname === created.path);
	await expect(bo.getByRole("textbox", { name: "Research question", exact: true }))
		.toHaveValue(researchQuestion);
});

test("read-only repository members can read reports without mutation controls", async ({ baseURL, page, room, seed }) => {
	await seed(SOURCE);
	let researchQuestion = question(room);
	let fixture = await seedCompletedResearchWorkspace(port(baseURL!), room, {
		question: researchQuestion,
		report: REPORT,
	});
	await authenticate(page, "readonly", baseURL!);
	await page.goto(fixture.path);

	await expectCompletedReport(page);
	let sidebar = projects(page);
	await expect(sidebar.getByRole("button", { name: "New document", exact: true }))
		.toBeDisabled();
	await expect(sidebar.getByRole("button", {
		name: `New research in ${parentTitle(room)}`,
		exact: true,
	})).toHaveCount(0);
	await expect(sidebar.getByRole("button", {
		name: `Rename ${parentTitle(room)}`,
		exact: true,
	})).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Continue the research", exact: true }))
		.toHaveJSProperty("readOnly", true);
	await expect(page.getByRole("button", { name: "Ask from research", exact: true }))
		.toBeDisabled();
	await expect(page.getByRole("button", { name: "Search more", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Cancel active research turn", exact: true }))
		.toHaveCount(0);
});

test("a compact research route contains overflow and keeps drawer and parent navigation usable", async ({ baseURL, page, room, seed }) => {
	await seed(SOURCE);
	let researchQuestion = question(room);
	let fixture = await seedCompletedResearchWorkspace(port(baseURL!), room, {
		question: researchQuestion,
		report: REPORT,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await authenticate(page, "ana", baseURL!);
	await page.goto(fixture.path);

	await expectCompletedReport(page);
	await expectNoHorizontalOverflow(page);
	let researchOverflow = await page.locator(".research-scroll").evaluate(element =>
		element.scrollWidth > element.clientWidth
	);
	expect(researchOverflow).toBe(false);

	let opener = page.getByRole("button", { name: "Open Projects sidebar", exact: true });
	await opener.click();
	let drawer = page.getByRole("dialog", { name: "Projects", exact: true });
	await expect(drawer).toBeVisible();
	await expect(drawer.getByRole("link", { name: researchQuestion, exact: true }))
		.toHaveAttribute("aria-current", "page");
	await page.keyboard.press("Escape");
	await expect(drawer).toBeHidden();
	await expect(opener).toBeFocused();

	await page.getByRole("link", { name: `Back to ${parentTitle(room)}`, exact: true }).click();
	await expect(page).toHaveURL(url => url.pathname === testChannelPath(room));
	await ready(page);
});
