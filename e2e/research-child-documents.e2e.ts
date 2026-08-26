import { countChildChannels, readSource, seedChildChannel } from "./database";
import { content, expect, test } from "./room";

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

test("inline research publishes one ordinary child and opens it", async ({ baseURL, join, page, room, seed }) => {
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
	await expect(card.getByRole("complementary", { name: "Chat" })).toHaveCount(0);
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

	let open = readyCard.getByRole("button", { name: `Open ${childTitle}`, exact: true });
	await open.focus();
	await open.click();
	let surface = opened.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(opened).toHaveURL(url => url.pathname === child.path);
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	await surface.getByRole("button", { name: `Close ${childTitle}`, exact: true }).click();
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
