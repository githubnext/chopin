import { chatInput } from "./chat-input";
import { persistedReview, seedPublishedResult } from "./followthrough-fixtures";
import { authenticate, expect, roomPath, test } from "./room";
import { HARNESS, HOST } from "./servers";
import { readSource } from "./database";
import {
	CONTRADICTION_MARKER,
	HUMAN_SENTINEL,
	PROVISIONAL_RECOMMENDATION,
	REVISED_RECOMMENDATION,
} from "./harness/fake-followthrough";

import type { Followthrough, Research } from "../packages/protocol/index";
import type { PublishedInvestigation } from "../packages/experiment/src/records";
import type { PublishedResult } from "./followthrough-fixtures";
import type { Page } from "@playwright/test";

function resultCard(page: Page, result: PublishedResult) {
	return page.getByRole("article", {
		name: result.kind === "research" ? "Research" : "Investigation",
		exact: true,
	}).filter({ hasText: result.title });
}

async function projectedReview(page: Page, channelId: string, result: PublishedResult) {
	let path = result.kind === "research"
		? `/api/channels/${channelId}/research-requests/${result.sourceId}`
		: `/api/documents/${channelId}/experiments/${result.sourceId}`;
	let response = await page.request.get(path);
	expect(response.ok()).toBe(true);
	return (await response.json() as Research.RequestView | PublishedInvestigation).followthrough;
}

const STATES: Array<[Followthrough.Status, string]> = [
	["pending", "Waiting for the Planner"],
	["running", "Reviewing findings"],
	["done", "Findings reviewed"],
	["failed", "Review interrupted"],
];

for (let [state, label] of STATES) {
	test(
		`published result cards project ${state} review receipts and open their evidence`,
		async ({ baseURL, join, room, seed }, testInfo) => {
			let port = Number(new URL(baseURL!).port);
			let research = crypto.randomUUID();
			let investigation = crypto.randomUUID();
			await seed(
				`# Test ${
					room.slice(0, 8)
				}\n\nThe cache recommendation is provisional.\n\n<Research id="${research}" />\n\n<Investigation id="${investigation}" />\n`,
			);
			let results = [
				await seedPublishedResult(port, room, "research", research, state),
				await seedPublishedResult(port, room, "investigation", investigation, state),
			];
			let page = await join("ana", { viewport: { width: 1440, height: 1000 } });
			for (let result of results) {
				let card = resultCard(page, result);
				await expect(card.getByRole("status").filter({ hasText: label })).toBeVisible();
				await expect(card.getByRole("button", { name: `Open ${result.title}`, exact: true }))
					.toBeEnabled();
				expect(await projectedReview(page, room, result)).toEqual(result.receipt);
				if (state === "running" || state === "done") {
					await expect(card.getByRole("button", { name: "Dismiss review", exact: true }))
						.toHaveCount(0);
				}
			}
			if (state === "failed") {
				let screenshot = testInfo.outputPath("followthrough-results.png");
				await page.screenshot({ path: screenshot });
				await testInfo.attach("published-result-review-controls", {
					path: screenshot,
					contentType: "image/png",
				});
			}
			for (let result of results) {
				await resultCard(page, result).getByRole("button", {
					name: `Open ${result.title}`,
					exact: true,
				}).click();
				await expect(page).toHaveURL(url => url.pathname === result.child.path);
				let child = page.getByRole("region", {
					name: `Child document: ${result.title}`,
					exact: true,
				});
				await expect(child.getByRole("heading", { name: result.title, exact: true })).toBeVisible();
				await expect(child).toContainText("The captured large workload benefits less");
				await page.goBack();
				await expect(resultCard(page, result)).toContainText(label);
			}
		},
	);
}

for (let kind of ["research", "investigation"] as const) {
	test(`a writer retries and dismisses ${kind} review through its real controls`, async ({ baseURL, join, room, seed }) => {
		let port = Number(new URL(baseURL!).port);
		let id = crypto.randomUUID();
		await seed(
			`# Test ${room.slice(0, 8)}\n\n<${
				kind === "research" ? "Research" : "Investigation"
			} id="${id}" />\n`,
		);
		let result = await seedPublishedResult(port, room, kind, id, "failed");
		let page = await join("ana");
		let card = resultCard(page, result);
		await expect(card).toContainText("Review interrupted");
		let path = `/api/channels/${room}/followthrough/${result.receipt.id}`;
		let retried = page.waitForResponse(response => response.url().endsWith(`${path}/retry`));
		await card.getByRole("button", { name: "Retry review", exact: true }).click();
		expect((await retried).ok()).toBe(true);
		await expect(card).toContainText("Waiting to review findings");
		await expect(card.getByRole("button", { name: "Retry review", exact: true })).toHaveCount(0);
		expect(await persistedReview(port, room, result.receipt.id)).toMatchObject({
			status: "pending",
			revision: 1,
		});
		let dismissed = page.waitForResponse(response => response.url().endsWith(`${path}/dismiss`));
		await card.getByRole("button", { name: "Dismiss review", exact: true }).click();
		expect((await dismissed).ok()).toBe(true);
		await expect(card).toContainText("Review dismissed");
		await expect(page).not.toHaveURL(url => url.pathname.includes("/children/"));
		expect(await persistedReview(port, room, result.receipt.id)).toMatchObject({
			status: "skipped",
			revision: 2,
			reason: "dismissed",
		});
		await page.reload();
		await expect(resultCard(page, result)).toContainText("Review dismissed");
		await expect(
			resultCard(page, result).getByRole("button", { name: `Open ${result.title}`, exact: true }),
		).toBeEnabled();
	});
}

test("a reader sees review status but cannot retry or dismiss it", async ({ baseURL, page, room, seed }) => {
	let port = Number(new URL(baseURL!).port);
	let id = crypto.randomUUID();
	await seed(`# Test ${room.slice(0, 8)}\n\n<Investigation id="${id}" />\n`);
	let result = await seedPublishedResult(port, room, "investigation", id, "failed");
	await authenticate(page, "readonly", baseURL!);
	await page.goto(roomPath(room));
	let card = resultCard(page, result);
	await expect(card).toContainText("Review interrupted");
	await expect(card.getByRole("button", { name: "Retry review", exact: true })).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Dismiss review", exact: true })).toHaveCount(0);
	for (let action of ["retry", "dismiss"]) {
		let response = await page.request.post(
			`/api/channels/${room}/followthrough/${result.receipt.id}/${action}`,
			{
				headers: { origin: new URL(baseURL!).origin },
				data: { revision: 0 },
			},
		);
		expect(response.status()).toBe(403);
	}
	expect(await persistedReview(port, room, result.receipt.id)).toMatchObject({
		status: "failed",
		revision: 0,
	});
	await card.getByRole("button", { name: `Open ${result.title}`, exact: true }).click();
	await expect(page).toHaveURL(url => url.pathname === result.child.path);
});

test.describe("automatic result review with the existing scripted Planner", () => {
	test.use({ baseURL: `http://${HOST}:${HARNESS}` });
	test(
		"a scripted review incorporates contradictory evidence and preserves human prose",
		async ({ baseURL, join, room, seed }, testInfo) => {
			test.setTimeout(90_000);
			let port = Number(new URL(baseURL!).port);
			let id = crypto.randomUUID();
			await seed(
				`# Test ${
					room.slice(0, 8)
				}\n\n${PROVISIONAL_RECOMMENDATION}\n\n${HUMAN_SENTINEL}\n\n<Investigation id="${id}" />\n`,
			);
			let page = await join("ana", { viewport: { width: 1440, height: 1000 } });
			let chat = page.getByRole("complementary", { name: "Chat", exact: true });
			await chatInput(chat).fill("@chopin Read this document and the latest pull request.");
			await chat.getByRole("button", { name: "Send message", exact: true }).click();
			await expect(chat.getByText(/Latest pull request: Restring the harp section/)).toBeVisible({
				timeout: 20_000,
			});
			let before = await readSource(port, room);
			let result = await seedPublishedResult(
				port,
				room,
				"investigation",
				id,
				"pending",
				CONTRADICTION_MARKER,
				"Choose the cache scope from the captured startup comparison.",
			);
			await page.reload();
			let card = resultCard(page, result);
			await expect(card).toContainText("Findings reviewed", { timeout: 45_000 });
			await expect.poll(() => readSource(port, room)).toBe(
				before.replace(PROVISIONAL_RECOMMENDATION, REVISED_RECOMMENDATION),
			);
			let parent = page.locator(`[data-workspace-room="${room}"]`);
			await expect(parent.getByText(REVISED_RECOMMENDATION, { exact: true })).toBeVisible();
			await expect(parent.getByText(HUMAN_SENTINEL, { exact: true })).toBeVisible();
			let details = await page.request.get(`/api/documents/${room}/experiments/${id}`);
			expect(details.ok()).toBe(true);
			let investigation = await details.json() as PublishedInvestigation;
			expect(investigation.buildBlocker).toBeUndefined();
			expect(investigation.revision).toBe(2);
			await expect(card).not.toContainText("Required before building");
			let explanation = chat.getByText(
				"The captured large-workload finding contradicts caching every query.",
				{ exact: false },
			);
			await expect(explanation).toBeVisible();
			let link = chat.getByRole("link", { name: "Read startup evidence", exact: true });
			await expect(link).toHaveAttribute("href", result.child.path);
			let completed = await persistedReview(port, room, result.receipt.id);
			expect(completed).toMatchObject({ status: "done", attempts: 1 });
			let screenshot = testInfo.outputPath("followthrough-contradiction.png");
			await page.screenshot({ path: screenshot });
			await testInfo.attach("scripted-investigation-followthrough", {
				path: screenshot,
				contentType: "image/png",
			});
			await link.click();
			await expect(page).toHaveURL(url => url.pathname === result.child.path);
			await expect(
				page.getByRole("region", { name: `Child document: ${result.title}`, exact: true }),
			).toBeVisible();
			await page.goBack();
			await page.reload();
			await expect(resultCard(page, result)).toContainText("Findings reviewed");
			await expect(chat.getByRole("link", { name: "Read startup evidence", exact: true }))
				.toHaveCount(1);
			expect(await persistedReview(port, room, result.receipt.id)).toEqual(completed);
		},
	);
	test("room recovery reviews one published result once under the existing owner", async ({ baseURL, join, room, seed }) => {
		test.setTimeout(90_000);
		let port = Number(new URL(baseURL!).port);
		let id = crypto.randomUUID();
		await seed(
			`# Test ${
				room.slice(0, 8)
			}\n\nThe cache recommendation is provisional.\n\n<Investigation id="${id}" />\n`,
		);
		let page = await join("ana");
		let chat = page.getByRole("complementary", { name: "Chat", exact: true });
		await chatInput(chat).fill("@chopin Read this document and the latest pull request.");
		await chat.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(chat.getByText(/Latest pull request: Restring the harp section/)).toBeVisible({
			timeout: 20_000,
		});
		let result = await seedPublishedResult(
			port,
			room,
			"investigation",
			id,
			"pending",
			"SLOW-LIVE compare the startup evidence.",
		);
		await page.reload();
		let card = resultCard(page, result);
		await expect(card.getByRole("status").filter({ hasText: "Reviewing findings" })).toBeVisible({
			timeout: 45_000,
		});
		expect(await persistedReview(port, room, result.receipt.id)).toMatchObject({
			status: "running",
			attempts: 1,
		});
		await expect(card).toContainText("Findings reviewed", { timeout: 20_000 });
		let completed = await persistedReview(port, room, result.receipt.id);
		expect(completed).toMatchObject({ status: "done", attempts: 1 });
		await page.reload();
		await expect(resultCard(page, result)).toContainText("Findings reviewed");
		expect(await persistedReview(port, room, result.receipt.id)).toEqual(completed);
	});
});
