import { authenticate, expect, openIsolatedRoom, ready, roomPath, test } from "./room";
import { seedChildChannel } from "./database";
import {
	offerSources,
	researchWorkCounts,
	saveConversationState,
	seedRequest,
} from "./research-offer-fixtures";

import type { Research } from "../packages/protocol/index";
import type { BrowserContext, Page } from "@playwright/test";
import type { OfferSpec } from "./research-offer-fixtures";

type SocketFrame = { kind: string; [key: string]: unknown };

function port(baseURL: string): number {
	return Number(new URL(baseURL).port);
}

function offerCard(page: Page, offerId: string) {
	return page.locator(`[data-research-offer="${offerId}"]`);
}

async function routeResearchNotification(
	context: BrowserContext,
	holdInitialLinkResponse = true,
	executionAvailable = false,
): Promise<{
	frames: SocketFrame[];
	initialLinkHeld: () => boolean;
	resumeReplyHeld: () => boolean;
	notify: (workspaceId: string) => void;
	releaseInitialLink: () => void;
	failHeldResume: () => void;
}> {
	// These test-only timing controls exercise the real observer and a delayed failure handler;
	// neither frame is evidence of research publication.
	let frames: SocketFrame[] = [];
	let send: ((frame: unknown) => void) | undefined;
	let initialLinkReply: string | undefined;
	let initialLinkCaptured = false;
	let resumeRequestId: string | undefined;
	let heldResumeReply = false;
	let failResume: ((frame: { kind: string; rid: string; message: string }) => void) | undefined;
	await context.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		send = frame => route.send(JSON.stringify(frame));
		route.onMessage(message => {
			if (typeof message === "string") {
				try {
					let frame = JSON.parse(message) as SocketFrame;
					if (frame.kind === "conversation-plan:research" && frame.choice === "resume") {
						resumeRequestId = typeof frame.rid === "string" ? frame.rid : undefined;
					}
				} catch {
					// Preserve unrelated binary or non-JSON wire frames.
				}
			}
			server.send(message);
		});
		server.onMessage(message => {
			if (typeof message === "string") {
				try {
					let frame = JSON.parse(message) as SocketFrame;
					frames.push(frame);
					if (executionAvailable && frame.kind === "session:hello") {
						// Expose Resume to exercise its delayed-refusal UI; server execution stays disabled.
						route.send(JSON.stringify({ ...frame, webResearch: true }));
						return;
					}
					if (
						holdInitialLinkResponse
						&& frame.kind === "conversation-plan:research-link"
						&& !initialLinkCaptured
					) {
						initialLinkCaptured = true;
						initialLinkReply = message;
						return;
					}
					if (typeof frame.rid === "string" && frame.rid === resumeRequestId) {
						heldResumeReply = true;
						return;
					}
				} catch {
					// Preserve unrelated binary or non-JSON wire frames.
				}
			}
			route.send(message);
		});
		failResume = frame => route.send(JSON.stringify(frame));
	});
	return {
		frames,
		initialLinkHeld: () => initialLinkReply !== undefined,
		resumeReplyHeld: () => heldResumeReply,
		notify(workspaceId) {
			if (!send) throw new Error("research notification route is not connected");
			send({ kind: "research:changed", ts: 0, revision: 1, workspaceId });
		},
		releaseInitialLink() {
			if (!initialLinkReply) throw new Error("initial research-link reply is not held");
			let reply = initialLinkReply;
			initialLinkReply = undefined;
			if (!send) throw new Error("research notification route is not connected");
			// The route forwards this held correlated reply as a test-only wire frame.
			send(JSON.parse(reply));
		},
		failHeldResume() {
			if (!resumeRequestId || !heldResumeReply || !failResume) {
				throw new Error("resume reply is not held");
			}
			failResume({
				kind: "session:error",
				rid: resumeRequestId,
				message: "synthetic delayed failure after link",
			});
		},
	};
}

test("writers can dismiss offers while execution is disabled; viewers only read them", async ({ baseURL, browser, join, room, seed }) => {
	let specs: OfferSpec[] = [
		{
			id: "ui-accept",
			brief: "Review this synthetic cache-retention request exactly as written.",
			status: "offered",
		},
		{
			id: "ui-dismiss",
			brief: "Consider this synthetic maintenance-window request.",
			status: "offered",
		},
	];
	let { state, transcript } = offerSources(specs, "source-author");
	await seed("# Research offer controls fixture\n", { transcript });
	await saveConversationState(room, state);
	let writerCountsBefore = await researchWorkCounts(room);
	expect(writerCountsBefore).toEqual({ jobs: 0, owners: 0, workspaces: 0 });
	let writerA = await join("writer-a");
	let acceptedCardA = offerCard(writerA, "ui-accept");
	let sourceMessageA = writerA.locator('[data-chat-message-id="source-ui-accept"]');
	await expect(sourceMessageA).toContainText(specs[0]!.brief);
	await expect(acceptedCardA.getByText(specs[0]!.brief, { exact: true })).toBeVisible();
	await expect(acceptedCardA.getByRole("button", { name: "Start research", exact: true }))
		.toBeDisabled();
	await expect(acceptedCardA.getByRole("button", { name: "Dismiss", exact: true }))
		.toBeVisible();
	expect(await researchWorkCounts(room)).toEqual(writerCountsBefore);

	let writerB = await join("writer-b");
	let acceptedCardB = offerCard(writerB, "ui-accept");
	await expect(acceptedCardB).toContainText(specs[0]!.brief);
	await expect(acceptedCardB.getByRole("button", { name: "Start research", exact: true }))
		.toBeDisabled();
	await writerB.reload();
	await ready(writerB);
	acceptedCardB = offerCard(writerB, "ui-accept");
	await expect(acceptedCardB).toContainText(specs[0]!.brief);
	await expect(acceptedCardB.getByRole("button", { name: "Start research", exact: true }))
		.toBeDisabled();

	let countsBeforeDismiss = await researchWorkCounts(room);
	let dismissedCardA = offerCard(writerA, "ui-dismiss");
	let dismissButton = dismissedCardA.getByRole("button", { name: "Dismiss", exact: true });
	await dismissButton.focus();
	await dismissButton.press("Space");
	await expect(dismissedCardA).toContainText("Research suggestion dismissed");
	expect(await researchWorkCounts(room)).toEqual(countsBeforeDismiss);
	await writerB.reload();
	await ready(writerB);
	let dismissedCardB = offerCard(writerB, "ui-dismiss");
	await expect(dismissedCardB).toContainText("Research suggestion dismissed");
	await expect(dismissedCardB.getByRole("button", { name: "Start research", exact: true }))
		.toHaveCount(0);
	await expect(dismissedCardB.getByRole("button", { name: "Dismiss", exact: true }))
		.toHaveCount(0);
	await expect(offerCard(writerB, "ui-accept")).toContainText(specs[0]!.brief);

	let viewerContext = await browser.newContext({ baseURL });
	try {
		let readonly = await viewerContext.newPage();
		await authenticate(readonly, "readonly", baseURL!);
		await readonly.goto(roomPath(room));
		for (let offerId of ["ui-accept", "ui-dismiss"]) {
			let card = offerCard(readonly, offerId);
			await expect(card).toBeVisible();
			await expect(card.getByRole("button", { name: "Start research", exact: true }))
				.toHaveCount(0);
			await expect(card.getByRole("button", { name: "Dismiss", exact: true }))
				.toHaveCount(0);
			await expect(card.getByRole("button", { name: "Resume", exact: true }))
				.toHaveCount(0);
		}
		await readonly.reload();
		await expect(offerCard(readonly, "ui-accept")).toContainText(specs[0]!.brief);
		await expect(offerCard(readonly, "ui-dismiss")).toContainText("Research suggestion dismissed");
	} finally {
		await viewerContext.close();
	}
});

test("an accepted link arrives from the room event, reloads, and opens its ready child", async ({ baseURL, browser, room, seed }) => {
	let spec: OfferSpec = {
		id: "ui-link-ready",
		brief: "Inspect this synthetic accepted research request.",
		status: "accepted",
	};
	let handle = "link-writer";
	let { state, transcript } = offerSources([spec], handle);
	await seed("# Research offer linked-state fixture\n", { transcript });
	await saveConversationState(room, state);
	let socket: Awaited<ReturnType<typeof routeResearchNotification>> | undefined;
	let isolated = await openIsolatedRoom(
		browser,
		baseURL!,
		room,
		handle,
		{},
		async context => {
			socket = await routeResearchNotification(context, true, true);
		},
	);
	try {
		let page = isolated.page;
		let card = offerCard(page, spec.id);
		await expect(card).toContainText("Waiting to start");
		await expect.poll(() => socket?.initialLinkHeld()).toBe(true);
		await expect(card.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
		socket!.releaseInitialLink();
		await expect.poll(() =>
			socket?.frames.some(frame =>
				frame.kind === "conversation-plan:research-link"
				&& frame.offerId === spec.id
				&& frame.status === "pending"
			)
		).toBe(true);
		await expect(card.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
		await card.getByRole("button", { name: "Resume", exact: true }).click();
		await expect.poll(() => socket?.resumeReplyHeld()).toBe(true);

		let workspaceId = await seedRequest(room, spec, "linked", handle);
		let child = await seedChildChannel(
			port(baseURL!),
			room,
			crypto.randomUUID(),
			"Synthetic ready research child",
			"# Synthetic report\n\nThis is a transport fixture, not published research.\n",
		);
		let requestReads = 0;
		let readyView: Research.RequestView = {
			id: workspaceId,
			channelId: room,
			question: spec.brief,
			sources: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			state: "completed",
			stage: "ready",
			child: {
				id: child.id,
				slug: child.slug,
				sourceCount: 0,
				summary: "Synthetic ready-child fixture.",
				title: "Synthetic ready research child",
			},
		};
		// The ID/link is read from the real server; this scripted ready response and child are
		// mechanical store/navigation fixtures, not evidence of research publication.
		await page.route(`**/api/channels/${room}/research-requests/**`, async route => {
			let request = route.request();
			let path = new URL(request.url()).pathname;
			if (
				request.method() === "GET"
				&& path === `/api/channels/${room}/research-requests/${workspaceId}`
			) {
				requestReads++;
				await route.fulfill({ json: readyView });
				return;
			}
			await route.continue();
		});
		if (!socket) throw new Error("research notification route was not installed");
		socket.notify(workspaceId);
		await expect.poll(() =>
			socket?.frames.some(frame =>
				frame.kind === "conversation-plan:research-link"
				&& frame.offerId === spec.id
				&& frame.status === "linked"
				&& frame.researchRequestId === workspaceId
			)
		).toBe(true);
		let open = () =>
			card.getByRole("button", { name: "Open Synthetic ready research child", exact: true });
		await expect(card.getByText("Synthetic ready research child", { exact: true })).toBeVisible();
		await expect(open()).toBeVisible();
		await expect.poll(() => requestReads).toBeGreaterThan(0);
		await expect(card.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
		await expect(card).toHaveAttribute("aria-busy", "true");
		// The actual Resume request reached the server; only its reply is delayed until the
		// authoritative linked state has rendered, then a test-only error exercises the race.
		socket!.failHeldResume();
		await expect(card).toHaveAttribute("aria-busy", "false");
		await expect(card.getByRole("alert")).toHaveCount(0);
		await expect(open()).toBeVisible();

		await page.reload();
		await ready(page);
		card = offerCard(page, spec.id);
		await expect(open()).toBeVisible();
		await expect.poll(() => requestReads).toBeGreaterThan(1);
		await open().click();
		await expect(page).toHaveURL(`${baseURL}${child.path}`);
	} finally {
		await isolated.close();
	}
});

test(
	"a read-only viewer can retry an exhausted link check without starting research",
	async ({ baseURL, browser, room, seed }, testInfo) => {
		let spec: OfferSpec = {
			id: "ui-retry-link",
			brief: "Inspect the existing research link.",
			status: "accepted",
		};
		let { state, transcript } = offerSources([spec], "source-author");
		await seed("# Research link retry fixture\n", { transcript });
		await saveConversationState(room, state);
		let before = await researchWorkCounts(room);
		let viewer = await browser.newContext({ baseURL });
		let linkReads = 0;
		let linkReplies = 0;
		let researchActions = 0;
		try {
			await viewer.routeWebSocket("**/ws?**", route => {
				let server = route.connectToServer();
				route.onMessage(message => {
					if (typeof message === "string") {
						let frame = JSON.parse(message) as SocketFrame;
						if (frame.kind === "conversation-plan:research") researchActions++;
						if (frame.kind === "conversation-plan:research-link") {
							linkReads++;
							if (linkReads <= 4) {
								route.send(JSON.stringify({
									kind: "session:error",
									rid: frame.rid,
									message: "scripted temporary link read failure",
								}));
								return;
							}
						}
					}
					server.send(message);
				});
				server.onMessage(message => {
					if (typeof message === "string") {
						let frame = JSON.parse(message) as SocketFrame;
						if (frame.kind === "conversation-plan:research-link") linkReplies++;
					}
					route.send(message);
				});
			});
			let page = await viewer.newPage();
			await page.clock.install();
			await authenticate(page, "readonly", baseURL!);
			await page.goto(roomPath(room));
			let card = offerCard(page, spec.id);
			await expect(card).toBeVisible();
			await expect.poll(() => linkReads).toBe(1);
			await page.clock.pauseAt(Date.now() + 100);
			for (let [delay, count] of [[2_000, 2], [5_000, 3], [10_000, 4]] as const) {
				await page.clock.runFor(delay);
				await expect.poll(() => linkReads).toBe(count);
			}
			let retry = card.getByRole("button", { name: "Retry link check", exact: true });
			await expect(retry).toBeVisible();
			await expect(card.getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
			await page.screenshot({ path: testInfo.outputPath("research-link-retry.png") });
			await retry.click();
			await expect.poll(() => linkReads).toBe(5);
			await expect.poll(() => linkReplies).toBe(1);
			await expect(retry).toHaveCount(0);
			expect(researchActions).toBe(0);
			expect(await researchWorkCounts(room)).toEqual(before);
		} finally {
			await viewer.close();
		}
	},
);
