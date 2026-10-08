import { createChannel, createChildChannel, testChannelSlug } from "./database";
import { authenticate, content, expect, ready, roomPath, test } from "./room";
import { installPointerMedia } from "./pointer-media";

import type { Browser, BrowserContext, Locator, Page, WebSocketRoute } from "@playwright/test";

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

const LIVE_COUNTS = new Set(["sidebar:decisions", "sidebar:snapshot"]);
const SIDEBAR_SOCKET = "**/ws/sidebar";

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
	await page.routeWebSocket(SIDEBAR_SOCKET, route => {
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
	let childRow = projects.getByRole("link", {
		name: "Fencing tokens, 1 unanswered decision",
		exact: true,
	}).locator("..");
	let parentActions = projects.getByRole("button", { name: "Actions for Postgres writer lease" });
	let childActions = projects.getByRole("button", { name: "Actions for Fencing tokens" });
	let disclosure = projects.getByRole("button", {
		name: "score, 10 unanswered decisions",
		exact: true,
	});
	let projectRow = disclosure.locator("..");
	let newDocument = projects.getByRole("button", { name: "New document in score", exact: true });

	await expect(page.locator(":root")).toHaveAttribute("data-plan-coarse-pointer", "");
	await expect(parentActions).toBeVisible();
	await expect(childActions).toBeVisible();
	await expect(count(parentRow)).toHaveText("4");
	await expect(count(childRow)).toHaveText("1");
	await expect(newDocument).toBeVisible();
	await expect(count(projectRow)).toHaveText("10");
	expect(await right(count(parentRow))).toBeLessThanOrEqual(
		(await parentActions.boundingBox())!.x + 1,
	);
	expect(await right(count(childRow))).toBeLessThanOrEqual(
		(await childActions.boundingBox())!.x + 1,
	);
	let edge = await right(count(projectRow));
	expect(Math.abs(await right(count(parentRow)) - edge)).toBeLessThanOrEqual(1);
	expect(Math.abs(await right(count(childRow)) - edge)).toBeLessThanOrEqual(1);

	await parentLink.evaluate(element =>
		element.addEventListener("click", event => event.preventDefault())
	);
	await parentLink.tap();
	await expect(count(parentRow)).toHaveText("4");
	await expect(parentActions).toBeVisible();
});

type FakeSidebar = {
	/** Repositories listed by each `sidebar:watch` the client sent. */
	watches: Array<Array<{ repositoryId: string; channelIds: string[] }>>;
	/** The score total the fake server reports in each snapshot. */
	total: number;
	send(frame: Record<string, unknown>): void;
};

/** Answer the sidebar socket without a server, snapshotting score at `total`. */
async function fakeSidebar(page: Page, total: number): Promise<FakeSidebar> {
	let socket: WebSocketRoute | undefined;
	let fake: FakeSidebar = {
		watches: [],
		total,
		send: frame => socket!.send(JSON.stringify({ ts: 0, ...frame })),
	};
	await page.routeWebSocket(SIDEBAR_SOCKET, route => {
		socket = route;
		route.onMessage(message => {
			let frame = JSON.parse(String(message));
			if (frame.kind === "session:ping") return fake.send({ kind: "session:ping", rid: frame.rid });
			if (frame.kind !== "sidebar:watch") return;
			let repositories = frame.repositories as FakeSidebar["watches"][number];
			fake.watches.push(repositories);
			fake.send({
				kind: "sidebar:watched",
				rid: frame.rid,
				watched: repositories.map(item => item.repositoryId),
				refused: [],
				unavailable: [],
			});
			if (!repositories.some(item => item.repositoryId === "R_score")) return;
			fake.send({
				kind: "sidebar:snapshot",
				repositoryId: "R_score",
				repositoryUnanswered: fake.total,
				documents: [],
			});
		});
	});
	return fake;
}

function scoreResyncs(fake: FakeSidebar): number {
	return fake.watches.filter(frame =>
		frame.some(item => item.repositoryId === "R_score" && item.channelIds.length === 0)
	).length;
}

test("a project total that conflicts with a live frame converges on a fresh snapshot", async ({ join, page }) => {
	await page.route("**/api/repositories/octo-org/score/channels*", route =>
		route.fulfill({
			json: {
				canEdit: true,
				channels: [PARENT, CHILD, QUIET],
				repository,
				unansweredDecisions: 10,
			},
		}));
	let archiving = Promise.withResolvers<void>();
	let archiveRequested = false;
	await page.route(`**/api/channels/${QUIET.id}/archive`, async route => {
		archiveRequested = true;
		await archiving.promise;
		await route.fulfill({
			json: {
				canEdit: true,
				canManage: true,
				channel: { ...QUIET, archivedAt: "2026-08-20T12:00:00.000Z", revision: 2 },
				repository,
				unansweredDecisions: 10,
			},
		});
	});
	let fake = await fakeSidebar(page, 10);
	page = await join("ana");
	let projects = sidebar(page);
	let projectRow = projects.getByRole("button", { name: /^score\b/ }).locator("..");
	let parentLink = projects.getByRole("link", { name: /^Postgres writer lease/ });
	await expect(count(projectRow)).toHaveText("10");
	await expect(parentLink).toHaveAccessibleName("Postgres writer lease, 4 unanswered decisions");

	// A frame read before the archive response's total lands while the archive is in flight.
	await projects.getByRole("link", { name: "Settled plan", exact: true }).locator("..").hover();
	await projects.getByRole("button", { name: "Actions for Settled plan" }).click();
	await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
	await expect.poll(() => archiveRequested).toBe(true);
	let resyncs = scoreResyncs(fake);
	fake.send({
		kind: "sidebar:decisions",
		channelId: PARENT.id,
		repositoryId: "R_score",
		unanswered: 4,
		repositoryUnanswered: 12,
		revision: 2,
	});
	await expect(count(projectRow)).toHaveText("12");
	archiving.resolve();
	await expect(projects.getByRole("link", { name: "Settled plan", exact: true })).toHaveCount(0);
	await expect.poll(() => scoreResyncs(fake)).toBe(resyncs + 1);
	await expect(count(projectRow)).toHaveText("10");

	// A frame older than the row it describes is dropped, so its total is resynchronized too.
	fake.total = 9;
	fake.send({
		kind: "sidebar:decisions",
		channelId: PARENT.id,
		repositoryId: "R_score",
		unanswered: 7,
		repositoryUnanswered: 13,
		revision: 1,
	});
	await expect.poll(() => scoreResyncs(fake)).toBe(resyncs + 2);
	await expect(count(projectRow)).toHaveText("9");
	await expect(parentLink).toHaveAccessibleName("Postgres writer lease, 4 unanswered decisions");
});

function roomChannels(urls: string[]): Array<string | null> {
	return urls.filter(url => new URL(url).pathname === "/ws")
		.map(url => new URL(url).searchParams.get("channel"));
}

function sidebarSockets(urls: string[]): string[] {
	return urls.filter(url => new URL(url).pathname === "/ws/sidebar");
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
	expect(sidebarSockets(sockets).length).toBeGreaterThan(0);
	expect(roomChannels(sockets).every(channel => channel === room)).toBe(true);
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
	expect(sidebarSockets(sockets).length).toBeGreaterThan(0);
	expect(roomChannels(sockets).every(channel => channel === room)).toBe(true);
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
	expect(sidebarSockets(sockets).length).toBeGreaterThan(0);
	expect(roomChannels(sockets).every(channel => channel === room)).toBe(true);
});

test("sidebar counts catch up on decisions answered while the sidebar was disconnected", async ({ baseURL, join, page: first }) => {
	let other = crypto.randomUUID();
	await createChannel(Number(new URL(baseURL!).port), other);
	let dropping = false;
	let connections: Array<{ page: WebSocketRoute; server: WebSocketRoute }> = [];
	await first.routeWebSocket(SIDEBAR_SOCKET, route => {
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
	await expect.poll(() => connections.length).toBeGreaterThan(1);
	await expect(link).toHaveAccessibleName(`${title}, 1 unanswered decision`);
	await expect(count(row)).toHaveText("1");
});

const CATALOGUE = { id: "R_archive_9", owner: "octo-org", name: "archive-9" };
const ARCHIVED_CHILD = { id: "R_archive_8", owner: "octo-org", name: "archive-8" };

function documentPath(repository: { owner: string; name: string }, id: string): string {
	return `/documents/${repository.owner}/${repository.name}/${testChannelSlug(id)}`;
}

async function openAs(
	browser: Browser,
	baseURL: string,
	handle: string,
	path: string,
): Promise<{ context: BrowserContext; page: Page }> {
	let context = await browser.newContext({ baseURL });
	let page = await context.newPage();
	await authenticate(page, handle, baseURL);
	await page.goto(path);
	await ready(page);
	return { context, page };
}

async function addProject(
	page: Page,
	baseURL: string,
	repository: { owner: string; name: string },
) {
	let added = await page.request.post("/api/navigation/projects", {
		data: { owner: repository.owner, repository: repository.name },
		headers: { origin: baseURL },
	});
	expect(added.status()).toBe(201);
}

test("project and document counts follow decisions while no document is open", async ({ baseURL, browser, join, room }) => {
	let other = crypto.randomUUID();
	await createChannel(Number(new URL(baseURL!).port), other, CATALOGUE);
	let editor = await openAs(
		browser,
		baseURL!,
		`document-creator-${crypto.randomUUID()}`,
		documentPath(CATALOGUE, other),
	);
	try {
		await expect.poll(() => storedCount(editor.page, CATALOGUE.name, other)).toBe(2);
		let sockets: string[] = [];
		let viewer = await join(`catalogue-viewer-${room.slice(0, 8)}`);
		viewer.on("websocket", socket => sockets.push(socket.url()));
		await addProject(viewer, baseURL!, CATALOGUE);
		await viewer.goto(`/documents/${CATALOGUE.owner}/${CATALOGUE.name}`);
		await expect(viewer.getByRole("heading", { name: "No document open" })).toBeVisible();
		let baseline = await catalogueTotal(viewer, CATALOGUE.name);
		let projects = sidebar(viewer);
		let title = `Test ${other.slice(0, 8)}`;
		let link = projects.getByRole("link", { name: new RegExp(`^${title}`) });
		await expect(link).toHaveAccessibleName(`${title}, 2 unanswered decisions`);
		await expect(
			projects.getByRole("button", { name: countLabel(CATALOGUE.name, baseline), exact: true }),
		).toBeVisible();

		await answerFirstDecision(editor.page);
		await expect.poll(() => storedCount(viewer, CATALOGUE.name, other)).toBe(1);
		await expect(link).toHaveAccessibleName(`${title}, 1 unanswered decision`);
		await expect(count(link.locator(".."))).toHaveText("1");
		await expect(
			projects.getByRole("button", {
				name: countLabel(CATALOGUE.name, baseline - 1),
				exact: true,
			}),
		).toBeVisible();
		await expect(viewer.getByRole("heading", { name: "No document open" })).toBeVisible();
		expect(roomChannels(sockets)).toEqual([]);
	} finally {
		await editor.context.close();
	}
});

test("a document row loaded after the first watch reconciles a decision answered in between", async ({ baseURL, browser, join, page: first }) => {
	let other = crypto.randomUUID();
	await createChannel(Number(new URL(baseURL!).port), other);
	let editor = await openAs(browser, baseURL!, "bob", roomPath(other));
	try {
		await expect.poll(() => storedCount(editor.page, "score", other)).toBe(2);

		let listing = Promise.withResolvers<void>();
		let listed = false;
		let held = true;
		await first.route("**/api/repositories/octo-org/score/channels*", async route => {
			if (!held) return route.fallback();
			held = false;
			let response = await route.fetch();
			listed = true;
			await listing.promise;
			await route.fulfill({ response });
		});
		let watches: string[] = [];
		let holdingWatches = true;
		let routes: Array<{ server: WebSocketRoute; held: string[] }> = [];
		let snapshots = 0;
		await first.routeWebSocket(SIDEBAR_SOCKET, route => {
			let server = route.connectToServer();
			let connection = { server, held: [] as string[] };
			routes.push(connection);
			route.onMessage(message => {
				if (typeof message === "string" && JSON.parse(message).kind === "sidebar:watch") {
					watches.push(message);
					if (holdingWatches) {
						connection.held.push(message);
						return;
					}
				}
				server.send(message);
			});
			server.onMessage(message => {
				if (typeof message === "string" && JSON.parse(message).kind === "sidebar:snapshot") {
					snapshots++;
				}
				route.send(message);
			});
		});

		let viewer = await join("ana");
		await expect.poll(() => listed).toBe(true);
		await expect.poll(() => watches.length).toBeGreaterThan(0);
		expect(watches.some(message => message.includes(other))).toBe(false);

		await answerFirstDecision(editor.page);
		await expect.poll(() => storedCount(editor.page, "score", other)).toBe(1);

		holdingWatches = false;
		for (let connection of routes) {
			for (let message of connection.held.splice(0)) connection.server.send(message);
		}
		await expect.poll(() => snapshots).toBeGreaterThan(0);
		listing.resolve();

		let title = `Test ${other.slice(0, 8)}`;
		let link = sidebar(viewer).getByRole("link", { name: new RegExp(`^${title}`) });
		await expect(link).toHaveAccessibleName(`${title}, 1 unanswered decision`);
		await expect(count(link.locator(".."))).toHaveText("1");
		expect(watches.some(message => message.includes(other))).toBe(true);
	} finally {
		await editor.context.close();
	}
});

test("deleting an archived child updates the project total for a viewer in its parent", async ({ baseURL, browser, join, room }) => {
	let port = Number(new URL(baseURL!).port);
	let parent = crypto.randomUUID();
	let child = crypto.randomUUID();
	await createChannel(port, parent, ARCHIVED_CHILD);
	await createChildChannel(port, parent, child, ARCHIVED_CHILD);
	let parentPath = documentPath(ARCHIVED_CHILD, parent);
	let editor = await openAs(
		browser,
		baseURL!,
		`document-creator-${crypto.randomUUID()}`,
		parentPath,
	);
	try {
		await editor.page.goto(`${parentPath}/children/${testChannelSlug(child)}`);
		await ready(editor.page);
		await expect.poll(() => storedCount(editor.page, ARCHIVED_CHILD.name, parent)).toBe(2);
		await expect.poll(() => storedCount(editor.page, ARCHIVED_CHILD.name, child)).toBe(2);

		let viewer = await join(`parent-viewer-${room.slice(0, 8)}`);
		await addProject(viewer, baseURL!, ARCHIVED_CHILD);
		await viewer.goto(parentPath);
		await expect(content(viewer)).toHaveAttribute("aria-readonly", "true");
		await expect(viewer).toHaveURL(new RegExp(`${parentPath}$`));
		let baseline = await catalogueTotal(viewer, ARCHIVED_CHILD.name);
		let projects = sidebar(viewer);
		let disclosure = (total: number) =>
			projects.getByRole("button", { name: countLabel(ARCHIVED_CHILD.name, total), exact: true });
		await expect(disclosure(baseline)).toBeVisible();

		let headers = { origin: baseURL! };
		let archived = await editor.page.request.post(`/api/channels/${child}/archive`, { headers });
		expect(archived.ok()).toBe(true);
		expect(await catalogueTotal(viewer, ARCHIVED_CHILD.name)).toBe(baseline);
		await expect(disclosure(baseline)).toBeVisible();

		let deleted = await editor.page.request.delete(`/api/channels/${child}`, { headers });
		expect(deleted.status()).toBe(204);
		await expect.poll(() => catalogueTotal(viewer, ARCHIVED_CHILD.name)).toBe(baseline - 2);
		await expect(disclosure(baseline - 2)).toBeVisible();
	} finally {
		await editor.context.close();
	}
});
