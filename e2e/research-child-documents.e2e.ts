import { countChildChannels, readSource, seedChildChannel } from "./database";
import { installPointerMedia } from "./pointer-media";
import { authenticate, content, expect, test } from "./room";

import type { Chat, Research } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

const PARENT_SOURCE = `# Parent document

${Array.from({ length: 36 }, (_, index) => `Parent passage ${index + 1}.`).join("\n\n")}
`;

const CHILD_SOURCE = `# Source review

This ordinary child has its own editable document, Decisions, and inline comments.
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
	let base: Research.RequestViewBase = {
		id: request.id,
		channelId: room,
		question: request.question,
		sources: request.sources,
		createdAt: "2026-08-24T09:00:00.000Z",
		updatedAt: new Date().toISOString(),
	};
	if (request.stage === "ready") {
		if (!request.child) throw new Error("ready scripted research requires a child");
		return { ...base, state: "completed", stage: "ready", child: request.child };
	}
	if (request.stage === "failed") {
		return {
			...base,
			state: "failed",
			stage: "failed",
			error: request.error ?? "Research could not be completed.",
		};
	}
	if (request.stage === "cancelled") {
		return { ...base, state: "cancelled", stage: "cancelled" };
	}
	let state: Research.ActiveRequestState = request.stage === "queued" ? "pending" : "running";
	return { ...base, state, stage: request.stage };
}

async function scriptResearch(
	page: Page,
	room: string,
	databasePort: number,
	options: { planner?: boolean } = {},
) {
	let requests = new Map<string, ScriptedRequest>();
	let retries: string[] = [];
	let cancellations: string[] = [];
	let reads: string[] = [];
	let chatSends: { channelId: string; text: string; to: Chat.Destination }[] = [];
	let sendToClient: ((frame: Research.Changed) => void) | undefined;
	if (options.planner) {
		await page.route("**/api/session", async route => {
			let response = await route.fetch();
			let session = await response.json() as Record<string, unknown>;
			await route.fulfill({ response, json: { ...session, agent: true } });
		});
	}
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		let channelId = new URL(route.url()).searchParams.get("channel");
		sendToClient = frame => route.send(JSON.stringify(frame));
		route.onMessage(message => {
			if (typeof message === "string" && channelId) {
				try {
					let frame = JSON.parse(message) as Partial<Chat.Send>;
					if (
						frame.kind === "chat:send"
						&& typeof frame.text === "string"
						&& (frame.to === "room" || frame.to === "planner")
					) chatSends.push({ channelId, text: frame.text, to: frame.to });
				} catch {
					// The real server remains authoritative for malformed and non-chat frames.
				}
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	let prefix = `/api/channels/${room}/research-requests`;
	await page.route("**/api/channels/*/research-requests**", async route => {
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
		chatSends: (): readonly { channelId: string; text: string; to: Chat.Destination }[] =>
			chatSends.map(send => ({ ...send })),
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
	await page.keyboard.press("Enter");
	let composer = page.getByRole("region", { name: "Research question", exact: true });
	await composer.getByRole("textbox", { name: "Research question", exact: true }).fill(question);
	let authoredOrder = await page.locator("[data-research-draft-anchor]").evaluate(anchor => {
		let editor = anchor.closest('[role="textbox"][aria-label="editable markdown"]')!;
		let block = anchor;
		while (block.parentElement !== editor) block = block.parentElement!;
		let next = block.nextElementSibling;
		while (next && !next.textContent?.trim()) next = next.nextElementSibling;
		let previous: Element | null = block;
		while (previous && !previous.textContent?.trim()) previous = previous.previousElementSibling!;
		return {
			next: next?.textContent?.trim() || null,
			previous: previous?.textContent?.trim() || null,
		};
	});
	await page.keyboard.press("Enter");
	await expect(composer).toHaveCount(0);
	let card = page.getByRole("article", { name: "Research" }).filter({ hasText: question });
	await expect(card).toHaveCount(1);
	expect(
		await card.evaluate(article => {
			let editor = article.closest('[role="textbox"][aria-label="editable markdown"]')!;
			let block = article;
			while (block.parentElement !== editor) block = block.parentElement!;
			let neighbor = (direction: "nextElementSibling" | "previousElementSibling") => {
				let sibling = block[direction];
				while (sibling && !sibling.textContent?.trim()) sibling = sibling[direction];
				return sibling?.textContent?.trim() || null;
			};
			return { next: neighbor("nextElementSibling"), previous: neighbor("previousElementSibling") };
		}),
	).toEqual(authoredOrder);
	await expect(card.getByText("Queued", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Place research here", exact: true }))
		.toHaveCount(0);
	await expect(page.getByRole("button", { name: "Search public web", exact: true }))
		.toHaveCount(0);
	return card;
}

test("inline research publishes one ordinary child and opens its isolated workspace", async ({ baseURL, join, page, room, seed }) => {
	test.slow();
	await seed(PARENT_SOURCE);
	let databasePort = port(baseURL!);
	let research = await scriptResearch(page, room, databasePort, { planner: true });
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
	let childHrefs = () =>
		sidebar.getByRole("link").evaluateAll(links =>
			links
				.map(link => (link as HTMLAnchorElement).href)
				.filter(href => new URL(href).pathname.includes("/children/"))
		);
	let brief = "Compare the public evidence for deterministic child publication.";
	let childTitle = `Lifecycle evidence ${room.slice(0, 8)}`;
	let card = await startInlineResearch(opened, brief);

	await expect(card.getByText("Queued", { exact: true })).toBeVisible();
	await expect(card).toContainText(brief);
	await expect(card.getByRole("button", { name: "Decisions", exact: true })).toHaveCount(0);
	await expect(card.getByRole("complementary", { name: "Conversation" })).toHaveCount(0);
	await expect.poll(childHrefs).toEqual([]);
	expect(await countChildChannels(databasePort, room)).toBe(0);
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
	await expect.poll(childHrefs).toEqual([]);
	expect(await countChildChannels(databasePort, room)).toBe(0);

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

	let parentConversation = parent.getByRole("complementary", {
		name: "Conversation",
		includeHidden: true,
	});
	let parentRoomMessage = `Parent room message ${room.slice(0, 8)}`;
	let parentDraft = parentConversation.getByPlaceholder("Use @chopin to ask Chopin");
	await parentDraft.fill(parentRoomMessage);
	await parentConversation.getByRole("button", { name: "Send message" }).click();
	await expect(parentConversation.getByText(parentRoomMessage, { exact: true })).toBeVisible();

	let parentScroll = parent.locator("[data-plan-scroll]");
	await parentScroll.evaluate(element => element.scrollTop = 180);
	let parentScrollTop = await parentScroll.evaluate(element => element.scrollTop);
	let open = readyCard.getByRole("button", { name: `Open ${childTitle}`, exact: true });
	await open.focus();
	await opened.setViewportSize({ width: 1920, height: 1080 });
	await open.click();
	let surface = opened.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(opened).toHaveURL(url => url.pathname === child.path);
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	let parentHeader = parent.locator(".room-header");
	let parentPaper = parent.locator(".workspace-frame");
	await expect(opened.locator(".room-header:visible")).toHaveCount(1);
	await expect(parentHeader.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }))
		.toHaveCount(0);
	await expect(parentHeader.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }))
		.toBeVisible();
	await expect(parentHeader.getByText(childTitle, { exact: true })).toBeVisible();
	await expect(parentHeader.getByRole("group", { name: /People here:/ })).toBeVisible();
	await expect(parentPaper).toHaveAttribute("inert", "");
	await expect(parentPaper).toHaveAttribute("aria-hidden", "true");
	await expect(parentPaper).toHaveCSS("filter", "blur(3px)");
	await expect(parentPaper).toHaveCSS("opacity", "0.68");
	await expect(surface.locator(".room-header")).toBeHidden();
	await surface.evaluate(async element => {
		await Promise.all(element.getAnimations().map(animation => animation.finished));
	});
	let parentBox = await parentPaper.boundingBox();
	let childBox = await surface.boundingBox();
	let headerBox = await parentHeader.boundingBox();
	expect(parentBox).not.toBeNull();
	expect(childBox).not.toBeNull();
	expect(headerBox).not.toBeNull();
	expect(childBox!.x).toBeGreaterThan(parentBox!.x);
	expect(childBox!.y).toBeGreaterThan(parentBox!.y);
	expect(childBox!.x + childBox!.width).toBeLessThan(parentBox!.x + parentBox!.width);
	expect(childBox!.y + childBox!.height).toBeLessThan(parentBox!.y + parentBox!.height);
	expect(childBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height + 12);
	expect(await surface.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe("none");
	let childClose = surface.getByRole("button", {
		name: `Close ${childTitle}`,
		exact: true,
	});
	let childConversationToggle = surface.getByRole("button", {
		name: "Show conversation pane",
		exact: true,
	});
	let childConversation = surface.getByRole("complementary", { name: "Conversation" });
	await expect(childConversationToggle).toBeVisible();
	await expect(childConversation).toBeHidden();
	let closeHandle = await childClose.elementHandle();
	expect(closeHandle).not.toBeNull();
	expect(
		await childConversationToggle.evaluate(
			(toggle, close) => toggle.nextElementSibling === close,
			closeHandle,
		),
	).toBe(true);
	let conversationToggleBox = await childConversationToggle.boundingBox();
	let childCloseBox = await childClose.boundingBox();
	expect(conversationToggleBox).not.toBeNull();
	expect(childCloseBox).not.toBeNull();
	expect(conversationToggleBox!.x + conversationToggleBox!.width)
		.toBeLessThanOrEqual(childCloseBox!.x);

	await childConversationToggle.click();
	await expect(childConversation).toBeVisible();
	await expect(childConversation).not.toContainText(parentRoomMessage);
	await expect(parentConversation).toContainText(parentRoomMessage);
	let childRoomMessage = `Child room message ${room.slice(0, 8)}`;
	let childPlannerMessage = `@chopin Child Planner message ${room.slice(0, 8)}`;
	let childPlannerTranscript = childPlannerMessage.replace("@chopin ", "");
	let childDraft = childConversation.getByPlaceholder("Use @chopin to ask Chopin");
	await childDraft.fill(childRoomMessage);
	await childConversation.getByRole("button", { name: "Send message" }).click();
	await expect(childConversation.getByText(childRoomMessage, { exact: true })).toBeVisible();
	await expect.poll(() => research.chatSends()).toContainEqual({
		channelId: child.id,
		text: childRoomMessage,
		to: "room",
	});
	await childDraft.fill(childPlannerMessage);
	await childConversation.getByRole("button", { name: "Send message" }).click();
	await expect(childConversation.getByText(childPlannerTranscript, { exact: true })).toBeVisible();
	await expect.poll(() => research.chatSends()).toContainEqual({
		channelId: child.id,
		text: childPlannerMessage,
		to: "planner",
	});
	await expect(parentConversation).not.toContainText(childRoomMessage);
	await expect(parentConversation).not.toContainText(childPlannerTranscript);
	await childConversation.getByRole("button", {
		name: "Hide conversation pane",
		exact: true,
	}).click();
	await expect(childConversation).toBeHidden();

	let childEditor = surface.getByRole("textbox", { name: "editable markdown" });
	await childEditor.locator("p").first().selectText();
	await opened.getByRole("button", { name: "Comment on this passage", exact: true })
		.evaluate(button => (button as HTMLButtonElement).click());
	let commentDraft = opened.getByRole("dialog", { name: "New comment" });
	await expect(commentDraft.getByPlaceholder("Comment on this passage…")).toBeFocused();
	await commentDraft.getByRole("button", { name: "Cancel" }).click();
	await expect(commentDraft).toHaveCount(0);
	await surface.getByRole("button", { name: "Decisions", exact: true }).click();
	await expect(surface.locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(parent).toContainText("Parent passage 36.");
	let resize = opened.getByRole("separator", { name: "Resize Projects sidebar" });
	let resizeBox = await resize.boundingBox();
	let sidebarWidth = Number(await resize.getAttribute("aria-valuenow"));
	expect(resizeBox).not.toBeNull();
	await opened.mouse.move(resizeBox!.x + resizeBox!.width - 0.5, resizeBox!.y + 80);
	await opened.mouse.down();
	await opened.mouse.move(resizeBox!.x + resizeBox!.width + 31.5, resizeBox!.y + 80);
	await opened.mouse.up();
	await expect(resize).toHaveAttribute("aria-valuenow", String(sidebarWidth + 32));
	await expect(surface).toBeVisible();

	await childClose.evaluate(button => {
		(button as HTMLButtonElement).click();
		(button as HTMLButtonElement).click();
	});
	await expect(surface).toHaveCount(0);
	await expect(open).toBeFocused();
	await opened.waitForTimeout(250);
	await expect(opened).toHaveURL(url => url.pathname === child.path.replace(/\/children\/.*$/, ""));
	await expect.poll(() => parentScroll.evaluate(element => element.scrollTop)).toBe(
		parentScrollTop,
	);
	await expect(parentConversation).toContainText(parentRoomMessage);

	await open.click();
	await expect(surface).toBeVisible();
	await expect(childConversationToggle).toBeVisible();
	await expect(childConversation).toBeHidden();
	await childConversationToggle.click();
	await expect(childConversation).not.toContainText(parentRoomMessage);
	await expect(parentConversation).toContainText(parentRoomMessage);
	await expect(childConversation.getByText(childRoomMessage, { exact: true })).toBeVisible();
	await expect(childConversation.getByText(childPlannerTranscript, { exact: true })).toBeVisible();
	await childConversation.getByRole("button", {
		name: "Hide conversation pane",
		exact: true,
	}).click();
	await parentHeader.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCount(0);
	await expect(open).toBeFocused();

	await open.click();
	await expect(surface).toBeVisible();
	await parentHeader.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCount(0);
	await expect(open).toBeFocused();

	await open.click();
	await expect(surface).toBeVisible();
	await surface.getByRole("button", { name: "Document", exact: true }).click();
	await expect(surface).toBeVisible();
	let surfaceBox = await surface.boundingBox();
	let backdrop = opened.locator("[data-child-backdrop]");
	let backdropBox = await backdrop.boundingBox();
	let sidebarBox = await sidebar.boundingBox();
	expect(surfaceBox).not.toBeNull();
	expect(backdropBox).not.toBeNull();
	expect(sidebarBox).not.toBeNull();
	expect(backdropBox!.x).toBeGreaterThanOrEqual(sidebarBox!.x + sidebarBox!.width);
	expect(backdropBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
	await opened.mouse.click(surfaceBox!.x - 6, surfaceBox!.y + 20);
	await expect(surface).toHaveCount(0);
	await expect(open).toBeFocused();

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
	let parentConversation = parent.getByRole("complementary", {
		name: "Conversation",
		includeHidden: true,
	});
	await expect(parent.getByRole("button", { name: "Background Work", exact: true })).toHaveCount(
		0,
	);
	let parentScroll = parent.locator("[data-plan-scroll]");
	await expect(parent.getByRole("separator", { name: "Resize the conversation" }))
		.toHaveAttribute("aria-valuenow", "384");
	await expect(parentConversation).toBeVisible();
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
	await expect(parent.locator(".workspace-frame")).toHaveAttribute("inert", "");
	await expect(parent.locator(".workspace-frame")).toHaveAttribute("aria-hidden", "true");
	let childConversationToggle = surface.getByRole("button", {
		name: "Show conversation pane",
		exact: true,
	});
	let childConversation = surface.getByRole("complementary", { name: "Conversation" });
	await expect(childConversationToggle).toBeVisible();
	await expect(childConversation).toBeHidden();
	await expect(parentConversation).toBeVisible();
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
	await childConversationToggle.click();
	await expect(childConversation).toBeVisible();
	await expect(parentConversation).toBeVisible();
	await childConversation.getByRole("button", {
		name: "Hide conversation pane",
		exact: true,
	}).click();
	await expect(childConversation).toBeHidden();
	await expect(parentConversation).toBeVisible();

	await surface.getByRole("button", { name: "Decisions", exact: true }).click();
	await expect(surface.locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(parent.locator('[data-document-view="decisions"]')).toBeHidden();
	await surface.getByRole("button", { name: "Document", exact: true }).click();
	await expect(childConversationToggle).toBeVisible();

	await page.keyboard.press("Escape");
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === "?view=plan"
		&& url.hash === "#note"
	);
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
	await expect.poll(() => parentScroll.evaluate(element => element.scrollTop)).toBe(originalScroll);
	await expect(parentConversation).toBeVisible();

	await childLink.click();
	await expect(surface).toBeVisible();
	await expect(childConversationToggle).toBeVisible();
	await expect(childConversation).toBeHidden();
	await expect(parentConversation).toBeVisible();
	await page.goBack();
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();

	await childLink.click();
	await expect(surface).toBeVisible();
	await parent.locator(".room-header")
		.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
});

test("an in-app child opens and submits its own comment composer", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Commentable child ${room.slice(0, 8)}`;
	await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	await join("ana");

	await page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true })
		.click();
	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	let passage = "This ordinary child has its own editable document, Decisions, and Conversation.";
	await surface.getByRole("textbox", { name: "editable markdown" })
		.getByText(passage, { exact: true })
		.selectText();
	await surface.getByRole("button", { name: "Comment on this passage", exact: true }).click();

	let draft = surface.getByRole("dialog", { name: "New comment" });
	await draft.getByPlaceholder("Comment on this passage…").fill("Keep this child passage.");
	await draft.getByRole("button", { name: "Comment", exact: true }).click();
	await expect(surface.getByRole("button", { name: /Comment on “This ordinary child/ }))
		.toBeVisible();
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
	await page.locator(`[data-workspace-room="${room}"] .room-header`)
		.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
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
	await page.evaluate(() => {
		let held = new Map<number, FrameRequestCallback>();
		let next = 1;
		let state = window as typeof window & {
			__chopinHeldFrames?: {
				cancel: typeof cancelAnimationFrame;
				held: Map<number, FrameRequestCallback>;
				request: typeof requestAnimationFrame;
			};
		};
		state.__chopinHeldFrames = {
			cancel: window.cancelAnimationFrame,
			held,
			request: window.requestAnimationFrame,
		};
		window.requestAnimationFrame = callback => {
			let id = next++;
			held.set(id, callback);
			return id;
		};
		window.cancelAnimationFrame = id => held.delete(id);
	});
	await page.keyboard.press("Escape");
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === "?view=plan"
		&& url.hash === "#siblings"
	);
	await expect(secondSurface).toHaveCount(0);
	expect(
		await page.evaluate(() => {
			let state = window as typeof window & {
				__chopinHeldFrames?: { held: Map<number, FrameRequestCallback> };
			};
			return state.__chopinHeldFrames?.held.size ?? 0;
		}),
	).toBeGreaterThan(0);
	await childLink(firstTitle).click();
	let firstSurface = page.getByRole("region", { name: `Child document: ${firstTitle}` });
	await expect(firstSurface.locator(`[data-workspace-room="${first.id}"]`)).toBeVisible();
	await page.evaluate(() => {
		let state = window as typeof window & {
			__chopinHeldFrames?: {
				cancel: typeof cancelAnimationFrame;
				held: Map<number, FrameRequestCallback>;
				request: typeof requestAnimationFrame;
			};
		};
		let frames = state.__chopinHeldFrames!;
		window.requestAnimationFrame = frames.request;
		window.cancelAnimationFrame = frames.cancel;
		for (let callback of frames.held.values()) callback(performance.now());
		delete state.__chopinHeldFrames;
	});
	await expect(firstSurface).toBeFocused();
	await expect(childLink(secondTitle)).not.toBeFocused();
	await page.keyboard.press("Escape");
	await expect(firstSurface).toHaveCount(0);
	await expect(childLink(firstTitle)).toBeFocused();

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
	await page.locator(`[data-workspace-room="${room}"] .room-header`)
		.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === ""
		&& url.hash === ""
	);
	await expect(secondSurface).toHaveCount(0);
	await expect(secondLink).toBeFocused();
});

test("a recovered child id enters the canonical anchored child workspace", async ({ baseURL, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Recovered source ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	await authenticate(page, "ana", baseURL!);
	await page.goto(`/channels/${child.id}`);

	await expect(page).toHaveURL(url => url.pathname === child.path);
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(parent).toBeVisible();
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	await expect(surface.getByRole("button", {
		name: "Show conversation pane",
		exact: true,
	})).toBeVisible();
	await expect(surface.getByRole("complementary", { name: "Conversation" })).toBeHidden();
	let close = surface.getByRole("button", { name: `Close ${childTitle}`, exact: true });
	await expect(close).toBeVisible();
	await expect(
		parent.locator(".room-header").getByRole("button", {
			name: `Return to Test ${room.slice(0, 8)}`,
			exact: true,
		}),
	).toBeVisible();

	let editor = surface.getByRole("textbox", { name: "editable markdown", exact: true });
	await editor.click();
	await page.keyboard.press("Meta+End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("/research");
	await expect(surface.getByRole("button", { name: "Search public web", exact: true }))
		.toHaveCount(0);

	await close.click();
	await expect(page).toHaveURL(url => url.pathname.endsWith(`/test-${room.slice(0, 8)}`));
	await expect(surface).toHaveCount(0);
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
	await expect(parent.locator(".workspace-frame")).toHaveAttribute("inert", "");
	await parent.locator(".room-header")
		.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
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
	let childTitle = `A substantially longer source review title ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await installPointerMedia(page, { coarse: true, primaryCoarse: true });
	await authenticate(page, "ana", baseURL!);
	await page.goto(child.path);

	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(surface).toBeVisible();
	await expect(surface).toBeFocused();
	let navigation = surface.getByRole("navigation", { name: "Workspace view" });
	let destinations = navigation.getByRole("button");
	await expect(destinations).toHaveCount(3);
	await expect(navigation.getByRole("button", { name: /^Conversation/ })).toBeVisible();
	await expect(navigation.getByRole("button", { name: "Document", exact: true })).toBeVisible();
	await expect(navigation.getByRole("button", { name: /^Decisions/ })).toBeVisible();
	await navigation.getByRole("button", { name: /^Conversation/ }).click();
	await expect(surface.getByRole("complementary", { name: "Conversation" })).toBeVisible();
	await expect(surface.locator('[data-document-view="plan"]')).toBeHidden();
	await navigation.getByRole("button", { name: "Document", exact: true }).click();
	await expect(surface.getByRole("complementary", { name: "Conversation" })).toBeHidden();
	await expect(surface.locator('[data-document-view="plan"]')).toBeVisible();
	let projects = page.getByRole("button", { name: "Open Projects sidebar" });
	await projects.click();
	let drawer = page.getByRole("dialog", { name: "Projects" });
	await expect(drawer).toBeVisible();
	await drawer.getByRole("link", { name: childTitle, exact: true }).click();
	await expect(drawer).toBeHidden();
	await expect(surface).toBeVisible();
	let parentHeader = page.locator('[data-workspace-surface="document"] .room-header');
	await expect(page.locator(".room-header:visible")).toHaveCount(1);
	await expect(parentHeader.getByText(childTitle, { exact: true })).toBeVisible();
	await expect(surface.locator(".room-header")).toBeHidden();
	await expect(parentHeader.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }))
		.toHaveCount(0);
	await expect(parentHeader.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }))
		.toBeVisible();
	let childCrumb = parentHeader.getByText(childTitle, { exact: true });
	let members = parentHeader.getByRole("group", { name: /People here:/ });
	await expect(childCrumb).toHaveCSS("text-overflow", "ellipsis");
	let crumbBox = await childCrumb.boundingBox();
	let membersBox = await members.boundingBox();
	expect(crumbBox).not.toBeNull();
	expect(membersBox).not.toBeNull();
	expect(crumbBox!.x + crumbBox!.width).toBeLessThanOrEqual(membersBox!.x);
	let parentPaper = page.locator('[data-workspace-surface="document"] .workspace-frame');
	await expect(parentPaper).toHaveCSS("transform", "none");
	await expect(parentPaper).toHaveCSS("transition-property", "none");
	let headerBox = await parentHeader.boundingBox();
	let childBox = await surface.boundingBox();
	expect(headerBox).not.toBeNull();
	expect(childBox).not.toBeNull();
	expect(Math.round(childBox!.y)).toBe(Math.round(headerBox!.y + headerBox!.height));
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

	await parentHeader.getByRole("button", { name: `Return to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCSS("animation-name", "anchored-child-fade-out");
	await expect(page).toHaveURL(url => url.pathname.endsWith(`/test-${room.slice(0, 8)}`));
});
