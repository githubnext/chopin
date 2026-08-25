import { countChildChannels, readSource, seedChildChannel } from "./database";
import { authenticate, content, expect, test } from "./room";

import type { Research } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

const PARENT_SOURCE = `# Parent document

${Array.from({ length: 36 }, (_, index) => `Parent passage ${index + 1}.`).join("\n\n")}
`;

const CHILD_SOURCE = `# Source review

This ordinary child has its own editable document, Decisions, and Conversation.
`;

function port(baseURL: string): number {
	return Number(new URL(baseURL).port);
}

type ScriptedRequest = {
	child?: Research.ReadyChild;
	error?: string;
	id: string;
	question: string;
	sources: Research.Source[];
	stage: Research.RequestStage;
};

function requestView(room: string, request: ScriptedRequest): Research.RequestView {
	let state: Research.RequestState = request.stage === "ready"
		? "completed"
		: request.stage === "failed"
		? "failed"
		: request.stage === "cancelled"
		? "cancelled"
		: request.stage === "queued"
		? "pending"
		: "running";
	return {
		id: request.id,
		channelId: room,
		question: request.question,
		state,
		stage: request.stage,
		error: request.error,
		sources: request.sources,
		child: request.child,
		createdAt: "2026-08-24T09:00:00.000Z",
		updatedAt: new Date().toISOString(),
	};
}

async function scriptResearch(page: Page, room: string, databasePort: number) {
	let requests = new Map<string, ScriptedRequest>();
	let retries: string[] = [];
	let cancellations: string[] = [];
	let reads: string[] = [];
	let sendToClient: ((frame: Research.Changed) => void) | undefined;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		sendToClient = frame => route.send(JSON.stringify(frame));
		route.onMessage(message => server.send(message));
		server.onMessage(message => route.send(message));
	});
	let prefix = `/api/channels/${room}/research-workspaces`;
	await page.route("**/api/channels/*/research-workspaces**", async route => {
		let request = route.request();
		let path = new URL(request.url()).pathname;
		if (!path.startsWith(prefix)) {
			await route.continue();
			return;
		}
		let suffix = path.slice(prefix.length);
		if (request.method() === "POST" && suffix === "") {
			let body = request.postDataJSON() as { question: string; requestId: string };
			let created: ScriptedRequest = {
				id: body.requestId,
				question: body.question,
				sources: [],
				stage: "queued",
			};
			requests.set(created.id, created);
			await route.fulfill({
				json: { repeated: false, request: requestView(room, created) },
				status: 201,
			});
			return;
		}
		let match = /^\/([^/]+)(?:\/(retry|cancel))?$/.exec(suffix);
		let current = match ? requests.get(decodeURIComponent(match[1]!)) : undefined;
		if (!current) {
			await route.fulfill({ json: { error: "research workspace not found" }, status: 404 });
			return;
		}
		if (request.method() === "POST" && match?.[2] === "retry") {
			retries.push(current.id);
			current.stage = "queued";
			current.error = undefined;
			current.sources = [];
			current.child = undefined;
			await route.fulfill({ json: requestView(room, current) });
			return;
		}
		if (request.method() === "POST" && match?.[2] === "cancel") {
			cancellations.push(current.id);
			current.stage = "cancelled";
			current.error = undefined;
			await route.fulfill({ json: requestView(room, current) });
			return;
		}
		if (request.method() === "GET" && match?.[2] === undefined) {
			reads.push(current.id);
			await route.fulfill({ json: requestView(room, current) });
			return;
		}
		await route.fulfill({ json: { error: "unsupported research fixture request" }, status: 405 });
	});

	let byQuestion = (question: string) => {
		let found = [...requests.values()].find(request => request.question === question);
		if (!found) throw new Error(`missing scripted research request for ${question}`);
		return found;
	};
	return {
		cancellations,
		reads,
		requests,
		retries,
		advance(
			question: string,
			stage: Research.RequestStage,
			overrides: Partial<ScriptedRequest> = {},
		) {
			Object.assign(byQuestion(question), overrides, { stage });
		},
		invalidate(question: string) {
			let request = byQuestion(question);
			if (!sendToClient) throw new Error("research socket is not connected");
			sendToClient({
				kind: "research:changed",
				revision: 1,
				ts: 0,
				workspaceId: request.id,
			});
		},
		async publish(question: string, title: string) {
			let request = byQuestion(question);
			let child = await seedChildChannel(
				databasePort,
				room,
				crypto.randomUUID(),
				title,
				CHILD_SOURCE,
			);
			request.stage = "ready";
			request.error = undefined;
			request.child = {
				id: child.id,
				slug: child.slug,
				sourceCount: request.sources.length,
				summary: "A complete report grounded in the discovered sources.",
				title,
			};
			return child;
		},
	};
}

async function startInlineResearch(page: Page, question: string) {
	let editor = content(page);
	await editor.click();
	await page.keyboard.press("Meta+End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("/research");
	await page.getByRole("listbox", { name: "Insert block" })
		.getByRole("option", { name: "Research" })
		.click();
	await page.getByRole("textbox", { name: "Research question", exact: true }).fill(question);
	await page.getByRole("button", { name: "Start research", exact: true }).click();
	let card = page.getByRole("article", { name: "Research" }).filter({ hasText: question });
	await expect(card.getByText("Queued", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Place research here", exact: true }))
		.toHaveCount(0);
	await expect(page.getByRole("button", { name: "Search public web", exact: true }))
		.toHaveCount(0);
	return card;
}

test("inline research publishes one ordinary child and opens its isolated workspace", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let databasePort = port(baseURL!);
	let research = await scriptResearch(page, room, databasePort);
	let catalogueReads = 0;
	let staleCatalogue = Promise.withResolvers<void>();
	let staleCatalogueStarted = Promise.withResolvers<void>();
	let heldCatalogue = false;
	await page.route("**/api/repositories/octo-org/score/channels**", async route => {
		let url = new URL(route.request().url());
		if (heldCatalogue || url.searchParams.get("includeArchived") === "true") {
			await route.continue();
			return;
		}
		heldCatalogue = true;
		let response = await route.fetch();
		staleCatalogueStarted.resolve();
		await staleCatalogue.promise;
		await route.fulfill({ response });
	});
	page.on("request", request => {
		if (
			request.method() === "GET"
			&& new URL(request.url()).pathname === "/api/repositories/octo-org/score/channels"
		) catalogueReads++;
	});
	let opening = join("ana");
	await staleCatalogueStarted.promise;
	let opened = await opening;
	let parent = opened.locator(`[data-workspace-room="${room}"]`);
	let sidebar = opened.getByRole("complementary", { name: "Projects" });
	let brief = "Compare the public evidence for deterministic child publication.";
	let childTitle = `Lifecycle evidence ${room.slice(0, 8)}`;
	let card = await startInlineResearch(opened, brief);

	await expect(card.getByText("Queued", { exact: true })).toBeVisible();
	await expect(card).toContainText(brief);
	await expect(card.getByRole("button", { name: "Decisions", exact: true })).toHaveCount(0);
	await expect(card.getByRole("complementary", { name: "Conversation" })).toHaveCount(0);
	await expect(sidebar.getByRole("link", { name: childTitle, exact: true })).toHaveCount(0);
	await expect(opened).toHaveURL(url => !url.pathname.includes("/children/"));

	research.advance(brief, "searching");
	await expect(card.getByText("Searching", { exact: true })).toBeVisible();
	research.advance(brief, "analyzing", {
		sources: [{ title: "Primary public source", url: "https://example.com/source" }],
	});
	await expect(card.getByText("Analyzing", { exact: true })).toBeVisible();
	await expect(card.getByRole("link", { name: "Primary public source", exact: true }))
		.toBeVisible();
	await expect(card).not.toContainText("A complete report grounded in the discovered sources.");
	research.advance(brief, "writing");
	await expect(card.getByText("Writing", { exact: true })).toBeVisible();
	await expect(sidebar.getByRole("link", { name: childTitle, exact: true })).toHaveCount(0);

	let readsBeforePublication = catalogueReads;
	let child = await research.publish(brief, childTitle);
	let readyCard = opened.getByRole("article", { name: "Research" })
		.filter({ hasText: childTitle });
	await expect(readyCard.getByText("Research ready", { exact: true })).toBeVisible();
	await expect(readyCard).toContainText("A complete report grounded in the discovered sources.");
	await expect(readyCard).toContainText("1 source");
	await expect(readyCard).toContainText("Researched by Planner");
	expect(catalogueReads).toBe(readsBeforePublication);
	staleCatalogue.resolve();
	let childLink = sidebar.getByRole("link", { name: childTitle, exact: true });
	await expect(childLink).toBeVisible();
	await expect(childLink).toHaveAttribute("href", child.path);
	expect(catalogueReads).toBe(readsBeforePublication + 1);
	await expect.poll(() => countChildChannels(databasePort, room)).toBe(1);

	let parentScroll = parent.locator("[data-plan-scroll]");
	await parentScroll.evaluate(element => element.scrollTop = 180);
	let parentScrollTop = await parentScroll.evaluate(element => element.scrollTop);
	let open = readyCard.getByRole("button", { name: `Open ${childTitle}`, exact: true });
	await open.focus();
	await open.click();
	let surface = opened.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(opened).toHaveURL(url => url.pathname === child.path);
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	await expect(surface.getByRole("button", { name: "Show conversation pane" })).toBeVisible();
	await surface.getByRole("button", { name: "Show conversation pane" }).click();
	let childConversation = surface.getByRole("complementary", { name: "Conversation" });
	let childMessage = `Child-only message ${room.slice(0, 8)}`;
	await childConversation.getByPlaceholder("Use @chopin to ask Chopin").fill(childMessage);
	await childConversation.getByRole("button", { name: "Send message" }).click();
	await expect(childConversation.getByText(childMessage, { exact: true })).toBeVisible();
	await expect(parent.getByText(childMessage, { exact: true })).toHaveCount(0);
	await surface.getByRole("button", { name: "Decisions", exact: true }).click();
	await expect(surface.locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(parent).toContainText("Parent passage 36.");

	await surface.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCount(0);
	await expect(open).toBeFocused();
	await expect.poll(() => parentScroll.evaluate(element => element.scrollTop)).toBe(
		parentScrollTop,
	);

	await open.click();
	await expect(surface).toBeVisible();
	await opened.keyboard.press("Escape");
	await expect(surface).toHaveCount(0);
	await expect(open).toBeFocused();

	await open.click();
	await expect(surface).toBeVisible();
	await opened.goBack();
	await expect(surface).toHaveCount(0);
	await expect(open).toBeFocused();
});

test("failed research retries by identity while cancelled research never publishes", async ({ baseURL, join, page, room, seed }) => {
	await seed("# Recovery parent\n");
	let databasePort = port(baseURL!);
	let research = await scriptResearch(page, room, databasePort);
	let opened = await join("ana");
	let sidebar = opened.getByRole("complementary", { name: "Projects" });
	let failedBrief = "Retry this exact failed research brief.";
	let failedCard = await startInlineResearch(opened, failedBrief);
	await expect(failedCard.getByText("Queued", { exact: true })).toBeVisible();
	research.advance(failedBrief, "failed", {
		error: "Research could not be completed safely.",
	});
	await expect(failedCard.getByText("Research failed", { exact: true })).toBeVisible();
	await expect(failedCard).toContainText("Research could not be completed safely.");
	await expect.poll(() => countChildChannels(databasePort, room)).toBe(0);

	let cancelledBrief = "Cancel this exact research brief.";
	let cancelledCard = await startInlineResearch(opened, cancelledBrief);
	await expect(cancelledCard.getByText("Queued", { exact: true })).toBeVisible();
	let cancelledId =
		[...research.requests.values()].find(request => request.question === cancelledBrief)!.id;
	await cancelledCard.getByText("Queued", { exact: true }).click();
	await opened.keyboard.press("Backspace");
	await expect(cancelledCard).toBeVisible();
	await expect.poll(async () =>
		(await readSource(databasePort, room)).match(/<Research\s+id=/g)?.length ?? 0
	).toBe(2);
	await cancelledCard.getByRole("button", { name: "Cancel research" }).click();
	await expect(cancelledCard.getByText("Research cancelled", { exact: true })).toBeVisible();
	expect(research.cancellations).toEqual([cancelledId]);

	let failedId =
		[...research.requests.values()].find(request => request.question === failedBrief)!.id;
	await failedCard.getByRole("button", { name: "Retry research" }).click();
	await expect(failedCard.getByText("Queued", { exact: true })).toBeVisible();
	expect(research.retries).toEqual([failedId]);
	research.advance(failedBrief, "writing", {
		sources: [{ title: "Recovery source", url: "https://example.com/recovery" }],
	});
	await expect(failedCard.getByText("Writing", { exact: true })).toBeVisible();
	let recoveredTitle = `Recovered evidence ${room.slice(0, 8)}`;
	await research.publish(failedBrief, recoveredTitle);
	await expect(sidebar.getByRole("link", { name: recoveredTitle, exact: true })).toBeVisible();
	await expect.poll(() => countChildChannels(databasePort, room)).toBe(1);
	let source = await readSource(databasePort, room);
	expect(source.match(/<Research\s+id=/g)).toHaveLength(2);

	// A late worker-shaped update is fetched after a real socket invalidation but remains unobservable.
	research.advance(cancelledBrief, "ready", {
		child: {
			id: crypto.randomUUID(),
			slug: "late-cancelled-child",
			sourceCount: 0,
			summary: "Late output",
			title: "Late cancelled child",
		},
	});
	let readsBeforeInvalidation = research.reads.filter(id => id === cancelledId).length;
	research.invalidate(cancelledBrief);
	await expect.poll(() => research.reads.filter(id => id === cancelledId).length)
		.toBe(readsBeforeInvalidation + 1);
	await expect(cancelledCard.getByText("Research cancelled", { exact: true })).toBeVisible();
	await expect(sidebar.getByRole("link", { name: "Late cancelled child", exact: true }))
		.toHaveCount(0);
	await expect.poll(() => countChildChannels(databasePort, room)).toBe(1);
	await expect.poll(async () =>
		(await readSource(databasePort, room)).match(/<Research\s+id=/g)?.length ?? 0
	).toBe(2);
	source = await readSource(databasePort, room);
	expect(source.match(/<Research\s+id=/g)).toHaveLength(2);
	await expect(sidebar.getByRole("link", { name: recoveredTitle, exact: true })).toHaveCount(1);
	await cancelledCard.getByRole("button", { name: "Remove research reference" }).click();
	await expect(cancelledCard).toHaveCount(0);
	await expect.poll(async () =>
		(await readSource(databasePort, room)).match(/<Research\s+id=/g)?.length ?? 0
	).toBe(1);
});

test("an in-app child preserves and restores its mounted parent", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Source review ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	await page.addInitScript(() => {
		localStorage.setItem("chopin:pane:chat:open", "true");
		localStorage.setItem("chopin:pane:chat", "384");
	});
	await join("ana");

	let parent = page.locator(`[data-workspace-room="${room}"]`);
	await expect(parent.getByRole("button", { name: "Background Work", exact: true })).toHaveCount(
		0,
	);
	let parentScroll = parent.locator("[data-plan-scroll]");
	await expect(parent.getByRole("separator", { name: "Resize the conversation" }))
		.toHaveAttribute("aria-valuenow", "384");
	await page.evaluate(() => localStorage.setItem("chopin:view:document", "decisions"));
	await parent.evaluate(element => element.setAttribute("data-mount-token", "preserved"));
	await parentScroll.evaluate(element => element.scrollTop = 240);
	let originalScroll = await parentScroll.evaluate(element => element.scrollTop);
	await page.evaluate(() => history.replaceState({ navigation: 4 }, "", "?view=plan#note"));
	let childLink = page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true });
	await childLink.focus();
	await childLink.click();

	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(page).toHaveURL(url => url.pathname === child.path);
	await expect(surface).toBeVisible();
	await expect(surface).toBeFocused();
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");
	await expect(parent.locator("..")).toHaveAttribute("inert", "");
	await expect(parent.locator("..")).toHaveAttribute("aria-hidden", "true");
	await expect(surface.getByRole("button", { name: "Show conversation pane" })).toBeVisible();
	await expect(surface.getByRole("button", { name: "Decisions", exact: true })).toBeVisible();
	await expect(surface.getByRole("button", { name: "Background Work", exact: true })).toHaveCount(
		0,
	);
	await expect(surface.getByRole("button", { name: "Tasks & Progress", exact: true })).toHaveCount(
		0,
	);
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	await expect(surface.locator('[data-document-view="plan"]')).toBeVisible();
	await expect(surface.locator('[data-document-view="decisions"]')).toBeHidden();

	await surface.getByRole("button", { name: "Decisions", exact: true }).click();
	await expect(surface.locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(parent.locator('[data-document-view="decisions"]')).toBeHidden();
	await surface.getByRole("button", { name: "Document", exact: true }).click();
	await surface.getByRole("button", { name: "Show conversation pane" }).click();
	await expect(surface.getByRole("button", { name: "Hide conversation pane" })).toBeVisible();
	let childResize = surface.getByRole("separator", { name: "Resize the conversation" });
	await expect(childResize).toHaveAttribute("aria-valuenow", "304");
	await childResize.press("ArrowRight");
	await expect.poll(() => page.evaluate(() => localStorage.getItem("chopin:pane:chat")))
		.toBe("384");
	await expect(parent.locator('button[aria-label^="Hide conversation pane"]')).toHaveCount(1);
	await surface.getByRole("button", { name: "Hide conversation pane" }).click();
	await expect(surface.getByRole("button", { name: "Show conversation pane" })).toBeVisible();
	await surface.getByRole("button", { name: `Actions for ${childTitle}` }).click();
	await expect(page.getByRole("menu", { name: `Actions for ${childTitle}` })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(surface).toBeVisible();
	await expect(page.getByRole("menu", { name: `Actions for ${childTitle}` })).toHaveCount(0);

	await page.keyboard.press("Escape");
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === "?view=plan"
		&& url.hash === "#note"
	);
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
	await expect.poll(() => parentScroll.evaluate(element => element.scrollTop)).toBe(originalScroll);

	await childLink.click();
	await expect(surface).toBeVisible();
	await page.goBack();
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();

	await childLink.click();
	await expect(surface).toBeVisible();
	await surface.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
});

test("a delayed sibling route removes the previous editable child immediately", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let firstTitle = `First source ${room.slice(0, 8)}`;
	let secondTitle = `Second source ${room.slice(0, 8)}`;
	let first = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		firstTitle,
		CHILD_SOURCE,
	);
	let second = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		secondTitle,
		CHILD_SOURCE,
	);
	await join("ana");
	await page.evaluate(() => history.replaceState({ navigation: 9 }, "", "?view=plan#siblings"));
	let childLink = (title: string) =>
		page.getByRole("complementary", { name: "Projects" })
			.getByRole("link", { name: title, exact: true });
	await childLink(firstTitle).click();
	await expect(page.locator(`[data-workspace-room="${first.id}"]`)).toBeVisible();

	let release!: () => void;
	let gate = new Promise<void>(resolve => release = resolve);
	await page.route(
		`**/api/repositories/octo-org/score/documents/${second.slug}`,
		async route => {
			let response = await route.fetch();
			await gate;
			await route.fulfill({ response });
		},
	);
	await childLink(secondTitle).click();
	await expect(page).toHaveURL(url => url.pathname === second.path);
	await expect(page.locator(`[data-workspace-room="${first.id}"]`)).toHaveCount(0);
	await expect(page.locator(".anchored-child-surface")).toContainText("Opening child document...");

	release();
	let secondSurface = page.getByRole("region", { name: `Child document: ${secondTitle}` });
	await expect(secondSurface.locator(`[data-workspace-room="${second.id}"]`)).toBeVisible();
	await expect(secondSurface).toBeFocused();
	await secondSurface.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }).click();
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === "?view=plan"
		&& url.hash === "#siblings"
	);
	await expect(secondSurface).toHaveCount(0);
	await expect(childLink(secondTitle)).toBeFocused();

	await childLink(firstTitle).click();
	await childLink(secondTitle).click();
	await expect(secondSurface.locator(`[data-workspace-room="${second.id}"]`)).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === "?view=plan"
		&& url.hash === "#siblings"
	);
	await expect(childLink(secondTitle)).toBeFocused();

	await childLink(firstTitle).click();
	await childLink(secondTitle).click();
	await expect(secondSurface.locator(`[data-workspace-room="${second.id}"]`)).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === "?view=plan"
		&& url.hash === "#siblings"
	);
	await expect(page.locator(`[data-workspace-room="${first.id}"]`)).toHaveCount(0);
	await expect(childLink(secondTitle)).toBeFocused();
});

test("a direct child keeps direct-entry history when opening a sibling", async ({ baseURL, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let firstTitle = `Direct first ${room.slice(0, 8)}`;
	let secondTitle = `Direct second ${room.slice(0, 8)}`;
	let first = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		firstTitle,
		CHILD_SOURCE,
	);
	let second = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		secondTitle,
		CHILD_SOURCE,
	);
	await authenticate(page, "ana", baseURL!);
	await page.goto(first.path);
	await expect(page.locator(`[data-workspace-room="${first.id}"]`)).toBeVisible();
	let historyLength = await page.evaluate(() => history.length);
	let secondLink = page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: secondTitle, exact: true });

	await secondLink.click();
	let secondSurface = page.getByRole("region", { name: `Child document: ${secondTitle}` });
	await expect(secondSurface.locator(`[data-workspace-room="${second.id}"]`)).toBeVisible();
	expect(await page.evaluate(() => history.length)).toBe(historyLength);
	await secondSurface.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }).click();
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === ""
		&& url.hash === ""
	);
	await expect(secondSurface).toHaveCount(0);
	await expect(secondLink).toBeFocused();
});

test("a child load failure preserves its mounted parent through back and retry", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Unreliable source ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	await join("ana");
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	await parent.evaluate(element => element.setAttribute("data-mount-token", "preserved"));
	let attempts = 0;
	await page.route(
		`**/api/repositories/octo-org/score/documents/${child.slug}`,
		async route => {
			attempts += 1;
			if (attempts <= 2) {
				await route.fulfill({
					body: JSON.stringify({ error: "Child temporarily unavailable" }),
					contentType: "application/json",
					status: 503,
				});
				return;
			}
			await route.continue();
		},
	);
	let childLink = page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true });

	await childLink.click();
	let surface = page.locator(".anchored-child-surface");
	await expect(surface).toContainText("Cannot open Chopin");
	await expect(surface).toContainText("Child temporarily unavailable");
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");
	await expect(parent.locator("..")).toHaveAttribute("inert", "");
	await surface.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCount(0);
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");

	await childLink.click();
	await expect(surface).toContainText("Child temporarily unavailable");
	await surface.getByRole("button", { name: "Try again" }).click();
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");
});

test("a direct compact child fills the canvas and reduces motion to a crossfade", async ({ baseURL, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Source review ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await authenticate(page, "ana", baseURL!);
	await page.goto(child.path);

	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(surface).toBeVisible();
	await expect(surface).toBeFocused();
	let geometry = await surface.evaluate(element => {
		let style = getComputedStyle(element);
		let box = element.getBoundingClientRect();
		return {
			animationName: style.animationName,
			left: box.left,
			right: innerWidth - box.right,
			transform: style.transform,
		};
	});
	expect(geometry).toEqual({
		animationName: "anchored-child-fade",
		left: 0,
		right: 0,
		transform: "none",
	});

	await surface.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }).click();
	await expect(page).toHaveURL(url => url.pathname.endsWith(`/test-${room.slice(0, 8)}`));
});
