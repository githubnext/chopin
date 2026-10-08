import { createChannel, testChannelSlug } from "./database";
import { content, expect, ready, roomPath, test } from "./room";
import { installPointerMedia } from "./pointer-media";

import type { Locator, Page, WebSocketRoute } from "@playwright/test";

const repository = {
	defaultBranch: "main",
	fullName: "octo-org/score",
	id: "R_score",
	name: "score",
	owner: "octo-org",
	ownerAvatarUrl: "https://example.invalid/octo-org.png",
	permissions: { admin: false, pull: true, push: true },
	private: true,
	url: "https://github.com/octo-org/score",
};

function channel(id: string, title: string, unansweredDecisions: number, parentChannelId?: string) {
	return {
		createdAt: "2026-08-19T12:00:00.000Z",
		createdBy: "U_ana",
		id,
		repositoryId: "R_score",
		repositoryName: "score",
		repositoryOwner: "octo-org",
		revision: 1,
		descriptionRevision: 0,
		slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
		title,
		updatedAt: "2026-08-19T12:00:00.000Z",
		unansweredDecisions,
		...(parentChannelId ? { parentChannelId } : {}),
	};
}

const PARENT = channel("cccccccc-0000-4000-8000-000000000001", "Postgres writer lease", 4);
const CHILD = channel("cccccccc-0000-4000-8000-000000000002", "Fencing tokens", 1, PARENT.id);
const QUIET = channel("cccccccc-0000-4000-8000-000000000003", "Settled plan", 0);
const LATER = channel("cccccccc-0000-4000-8000-000000000004", "Later page", 5);

const LIVE_COUNTS = new Set(["session:decisions", "session:decisions-snapshot"]);

function sidebar(page: Page) {
	return page.getByRole("complementary", { name: "Projects" });
}

function count(row: Locator) {
	return row.locator(":scope > [data-sidebar-decision-count]");
}

async function mockCatalogue(page: Page) {
	await page.route("**/api/repositories/octo-org/score/channels*", async route => {
		let later = new URL(route.request().url()).searchParams.get("cursor") === "later";
		await route.fulfill({
			json: later
				? { canEdit: true, channels: [LATER], repository, unansweredDecisions: 10 }
				: {
					canEdit: true,
					channels: [PARENT, CHILD, QUIET],
					nextCursor: "later",
					repository,
					unansweredDecisions: 10,
				},
		});
	});
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string" && LIVE_COUNTS.has(JSON.parse(message).kind)) return;
			route.send(message);
		});
	});
}

async function movePointerAway(page: Page) {
	await page.mouse.move(900, 700);
}

async function right(locator: Locator): Promise<number> {
	let box = await locator.boundingBox();
	if (!box) throw new Error("element has no box");
	return box.x + box.width;
}

test("sidebar counts share one trailing slot with the hover and focus actions", async ({ join, page }) => {
	await mockCatalogue(page);
	page = await join("ana");
	let projects = sidebar(page);
	let disclosure = projects.getByRole("button", {
		name: "score, 10 unanswered decisions",
		exact: true,
	});
	let parentLink = projects.getByRole("link", {
		name: "Postgres writer lease, 4 unanswered decisions",
		exact: true,
	});
	let childLink = projects.getByRole("link", {
		name: "Fencing tokens, 1 unanswered decision",
		exact: true,
	});
	let quietLink = projects.getByRole("link", { name: "Settled plan", exact: true });
	let projectRow = disclosure.locator("..");
	let parentRow = parentLink.locator("..");
	let childRow = childLink.locator("..");
	let quietRow = quietLink.locator("..");
	let newDocument = projects.getByRole("button", { name: "New document in score", exact: true });
	let parentActions = projects.getByRole("button", { name: "Actions for Postgres writer lease" });
	let childActions = projects.getByRole("button", { name: "Actions for Fencing tokens" });

	await expect(disclosure).toBeVisible();
	await expect(count(projectRow)).toHaveText("10");
	await expect(count(parentRow)).toHaveText("4");
	await expect(count(childRow)).toHaveText("1");
	await expect(count(quietRow)).toHaveCount(0);
	await expect(newDocument).toBeHidden();
	await expect(parentActions).toBeHidden();
	await expect(count(parentRow)).toHaveAttribute("aria-hidden", "true");

	let edge = await right(count(projectRow));
	expect(Math.abs(await right(count(parentRow)) - edge)).toBeLessThanOrEqual(1);
	expect(Math.abs(await right(count(childRow)) - edge)).toBeLessThanOrEqual(1);

	await parentRow.hover();
	await expect(count(parentRow)).toBeHidden();
	await expect(parentActions).toBeVisible();
	expect(Math.abs(await right(parentActions) - edge)).toBeLessThanOrEqual(1);
	await expect(count(projectRow)).toBeVisible();
	await expect(count(childRow)).toBeVisible();
	await expect(parentLink).toHaveAccessibleName("Postgres writer lease, 4 unanswered decisions");

	await childRow.hover();
	await expect(count(childRow)).toBeHidden();
	await expect(childActions).toBeVisible();
	await expect(count(parentRow)).toBeVisible();
	expect(Math.abs(await right(childActions) - edge)).toBeLessThanOrEqual(1);

	await projectRow.hover();
	await expect(count(projectRow)).toBeHidden();
	await expect(newDocument).toBeVisible();
	expect(Math.abs(await right(newDocument) - edge)).toBeLessThanOrEqual(1);

	await movePointerAway(page);
	await expect(count(projectRow)).toHaveText("10");
	await expect(count(parentRow)).toHaveText("4");
	await expect(count(childRow)).toHaveText("1");
	await expect(newDocument).toBeHidden();

	await disclosure.click();
	await expect(disclosure).toHaveAttribute("aria-expanded", "false");
	await expect(disclosure).toBeFocused();
	await movePointerAway(page);
	await expect(count(projectRow)).toHaveText("10");
	await expect(newDocument).toBeHidden();
	await disclosure.click();
	await expect(parentLink).toBeVisible();
	await movePointerAway(page);
	await expect(disclosure).toBeFocused();
	await expect(count(projectRow)).toHaveText("10");
	await expect(newDocument).toBeHidden();

	await page.keyboard.press("Tab");
	await expect(newDocument).toBeFocused();
	await expect(count(projectRow)).toBeHidden();
	await page.keyboard.press("Shift+Tab");
	await expect(disclosure).toBeFocused();
	await expect(count(projectRow)).toBeHidden();
	await expect(newDocument).toBeVisible();
	await expect(count(parentRow)).toBeVisible();

	await parentLink.focus();
	await expect(count(parentRow)).toBeHidden();
	await expect(parentActions).toBeVisible();
	await expect(count(projectRow)).toHaveText("10");
	await page.keyboard.press("Tab");
	await expect(parentActions).toBeFocused();
	await expect(count(parentRow)).toBeHidden();
	await expect(parentLink).toHaveAccessibleName("Postgres writer lease, 4 unanswered decisions");

	await disclosure.focus();
	await expect(count(projectRow)).toBeHidden();
	await expect(newDocument).toBeVisible();
	await expect(count(parentRow)).toBeVisible();
	await disclosure.press("Enter");
	await expect(disclosure).toHaveAttribute("aria-expanded", "false");
	await expect(parentLink).toBeHidden();
	await expect(disclosure).toHaveAccessibleName("score, 10 unanswered decisions");
	await disclosure.press("Enter");
	await expect(parentLink).toBeVisible();

	await projects.getByRole("button", { name: "Load more documents in score" }).click();
	await expect(projects.getByRole("link", { name: "Later page, 5 unanswered decisions" }))
		.toBeVisible();
	await movePointerAway(page);
	await expect(count(projectRow)).toHaveText("10");
	await expect(newDocument).toBeHidden();
});

test("touch keeps each count visible beside its always-shown action", async ({ join }) => {
	let page = await join("ana", { hasTouch: true, viewport: { width: 1180, height: 820 } });
	await installPointerMedia(page.context(), { coarse: true, primaryCoarse: true });
	await mockCatalogue(page);
	await page.reload();
	let projects = sidebar(page);
	let parentLink = projects.getByRole("link", {
		name: "Postgres writer lease, 4 unanswered decisions",
		exact: true,
	});
	let parentRow = parentLink.locator("..");
	let parentActions = projects.getByRole("button", { name: "Actions for Postgres writer lease" });
	let disclosure = projects.getByRole("button", {
		name: "score, 10 unanswered decisions",
		exact: true,
	});
	let newDocument = projects.getByRole("button", { name: "New document in score", exact: true });

	await expect(page.locator(":root")).toHaveAttribute("data-plan-coarse-pointer", "");
	await expect(parentActions).toBeVisible();
	await expect(count(parentRow)).toHaveText("4");
	await expect(newDocument).toBeVisible();
	await expect(count(disclosure.locator(".."))).toHaveText("10");
	expect(await right(count(parentRow))).toBeLessThanOrEqual(
		(await parentActions.boundingBox())!.x + 1,
	);

	await parentLink.evaluate(element =>
		element.addEventListener("click", event => event.preventDefault())
	);
	await parentLink.tap();
	await expect(count(parentRow)).toHaveText("4");
	await expect(parentActions).toBeVisible();
});

function socketChannel(url: string): string | null {
	return new URL(url).searchParams.get("channel");
}

test("a document's sidebar count follows decisions as they are asked and answered", async ({ join, page: first, room }) => {
	let sockets: string[] = [];
	first.on("websocket", socket => sockets.push(socket.url()));
	let page = await join("ana");
	let projects = sidebar(page);
	let title = `Test ${room.slice(0, 8)}`;
	let link = projects.getByRole("link", { name: new RegExp(`^${title}`) });
	let row = link.locator("..");

	await expect(link).toHaveAccessibleName(`${title}, 2 unanswered decisions`);
	await expect(count(row)).toHaveText("2");
	await expect(projects.getByRole("button", { name: /^score, \d+ unanswered decisions?$/ }))
		.toBeVisible();

	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = page.locator(
		'[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]',
	)
		.filter({ hasText: "Where should room state live?" });
	await card.getByText("In SQLite", { exact: true }).click();
	await card.getByRole("button", { name: "Save", exact: true }).click();

	await expect(link).toHaveAccessibleName(`${title}, 1 unanswered decision`);
	await expect(count(row)).toHaveText("1");
	let listed = await page.request.get("/api/repositories/octo-org/score/channels?limit=100");
	let catalogue = await listed.json() as {
		channels: Array<{ id: string; unansweredDecisions: number }>;
		unansweredDecisions: number;
	};
	expect(catalogue.channels.find(item => item.id === room)?.unansweredDecisions).toBe(1);
	expect(catalogue.unansweredDecisions).toBeGreaterThanOrEqual(1);
	expect(sockets.length).toBeGreaterThan(0);
	expect(sockets.map(socketChannel).every(channel => channel === room)).toBe(true);
});

test("another document's count follows its decisions while the viewer stays elsewhere", async ({ baseURL, join, page: first, room }) => {
	let other = crypto.randomUUID();
	await createChannel(Number(new URL(baseURL!).port), other);
	let sockets: string[] = [];
	first.on("websocket", socket => sockets.push(socket.url()));
	let viewer = await join("ana");
	let projects = sidebar(viewer);
	let title = `Test ${other.slice(0, 8)}`;
	let link = projects.getByRole("link", { name: new RegExp(`^${title}`) });
	let row = link.locator("..");
	await expect(link).toHaveAccessibleName(title);
	await expect(count(row)).toHaveCount(0);

	let editor = await join("bob");
	await editor.goto(roomPath(other));
	await ready(editor);
	await expect(link).toHaveAccessibleName(`${title}, 2 unanswered decisions`);
	await expect(count(row)).toHaveText("2");

	await editor.getByRole("button", { name: /^Decisions/ }).click();
	let card = editor.locator(
		'[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]',
	)
		.filter({ hasText: "Where should room state live?" });
	await card.getByText("In SQLite", { exact: true }).click();
	await card.getByRole("button", { name: "Save", exact: true }).click();

	await expect(link).toHaveAccessibleName(`${title}, 1 unanswered decision`);
	await expect(count(row)).toHaveText("1");
	expect(sockets.map(socketChannel).every(channel => channel === room)).toBe(true);
});

const ARCHIVE = { id: "R_archive_1", owner: "octo-org", name: "archive-1" };

function countLabel(name: string, unanswered: number): string {
	if (unanswered === 0) return name;
	return `${name}, ${unanswered} unanswered decision${unanswered === 1 ? "" : "s"}`;
}

async function catalogueTotal(page: Page, repository: string): Promise<number> {
	let listed = await page.request.get(`/api/repositories/octo-org/${repository}/channels`);
	expect(listed.ok()).toBe(true);
	return (await listed.json() as { unansweredDecisions: number }).unansweredDecisions;
}

async function storedCount(
	page: Page,
	repository: string,
	id: string,
): Promise<number | undefined> {
	let listed = await page.request.get(
		`/api/repositories/octo-org/${repository}/channels?limit=100`,
	);
	let catalogue = await listed.json() as {
		channels: Array<{ id: string; unansweredDecisions: number }>;
	};
	return catalogue.channels.find(item => item.id === id)?.unansweredDecisions;
}

async function answerFirstDecision(page: Page) {
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = page.locator(
		'[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]',
	)
		.filter({ hasText: "Where should room state live?" });
	await card.getByText("In SQLite", { exact: true }).click();
	await card.getByRole("button", { name: "Save", exact: true }).click();
}

test("a project in another repository follows its decisions while the viewer stays elsewhere", async ({ baseURL, join, page: first, room }) => {
	let other = crypto.randomUUID();
	await createChannel(Number(new URL(baseURL!).port), other, ARCHIVE);
	let sockets: string[] = [];
	first.on("websocket", socket => sockets.push(socket.url()));
	let viewer = await join(`watcher-${room.slice(0, 8)}`);
	let added = await viewer.request.post("/api/navigation/projects", {
		data: { owner: ARCHIVE.owner, repository: ARCHIVE.name },
		headers: { origin: baseURL! },
	});
	expect(added.status()).toBe(201);
	let baseline = await catalogueTotal(viewer, ARCHIVE.name);
	await viewer.reload();
	await ready(viewer);
	let projects = sidebar(viewer);
	let title = `Test ${other.slice(0, 8)}`;
	let link = projects.getByRole("link", { name: new RegExp(`^${title}`) });
	let row = link.locator("..");
	await expect(link).toHaveAccessibleName(title);
	await expect(
		projects.getByRole("button", { name: countLabel(ARCHIVE.name, baseline), exact: true }),
	)
		.toBeVisible();

	let editor = await join(`document-creator-${crypto.randomUUID()}`);
	await editor.goto(`/documents/${ARCHIVE.owner}/${ARCHIVE.name}/${testChannelSlug(other)}`);
	await ready(editor);
	await expect(link).toHaveAccessibleName(`${title}, 2 unanswered decisions`);
	await expect(count(row)).toHaveText("2");
	await expect(
		projects.getByRole("button", { name: countLabel(ARCHIVE.name, baseline + 2), exact: true }),
	).toBeVisible();

	await answerFirstDecision(editor);
	await expect(link).toHaveAccessibleName(`${title}, 1 unanswered decision`);
	await expect(count(row)).toHaveText("1");
	await expect(
		projects.getByRole("button", { name: countLabel(ARCHIVE.name, baseline + 1), exact: true }),
	).toBeVisible();
	expect(sockets.length).toBeGreaterThan(0);
	expect(sockets.map(socketChannel).every(channel => channel === room)).toBe(true);
});

test("sidebar counts catch up on decisions answered while the viewer was disconnected", async ({ baseURL, join, page: first }) => {
	let other = crypto.randomUUID();
	await createChannel(Number(new URL(baseURL!).port), other);
	let dropping = false;
	let connections: Array<{ page: WebSocketRoute; server: WebSocketRoute }> = [];
	await first.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		connections.push({ page: route, server });
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (dropping && typeof message === "string" && LIVE_COUNTS.has(JSON.parse(message).kind)) {
				return;
			}
			route.send(message);
		});
	});
	let viewer = await join("ana");
	let projects = sidebar(viewer);
	let title = `Test ${other.slice(0, 8)}`;
	let link = projects.getByRole("link", { name: new RegExp(`^${title}`) });
	let row = link.locator("..");

	let editor = await join("bob");
	await editor.goto(roomPath(other));
	await ready(editor);
	await expect(link).toHaveAccessibleName(`${title}, 2 unanswered decisions`);
	await expect(count(row)).toHaveText("2");

	dropping = true;
	await answerFirstDecision(editor);
	await expect.poll(() => storedCount(editor, "score", other)).toBe(1);
	await expect(link).toHaveAccessibleName(`${title}, 2 unanswered decisions`);

	dropping = false;
	let dropped = connections.at(-1)!;
	await dropped.page.close();
	await dropped.server.close();
	await expect(content(viewer)).toHaveAttribute("contenteditable", "false");
	await ready(viewer);
	await expect(link).toHaveAccessibleName(`${title}, 1 unanswered decision`);
	await expect(count(row)).toHaveText("1");
	expect(connections.length).toBeGreaterThan(1);
});
