import { authenticate, expect, roomPath, test } from "./room";
import { storedQuestion } from "../apps/server/src/testing/plan";

import type { WebSocketRoute } from "@playwright/test";

const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";
const DEFINITION = {
	questions: [{
		id: QUESTION,
		header: "Rollout",
		question: "How should we deploy?",
		multiple: false,
		options: [{ id: OPTION, label: "Canary", description: "" }],
	}],
};
const CARD = `<Questionnaire id="${WIDGET}" by="ana">
<Question id="${QUESTION}" header="Rollout" prompt="How should we deploy?" multiple="false">
<Option id="${OPTION}" label="Canary" />
</Question>
</Questionnaire>`;

test("empty decisions remain reachable in a short viewport", async ({ join }) => {
	let page = await join("ana", { viewport: { width: 320, height: 260 } });
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Decisions/ }).click();
	let view = page.locator('[data-document-view="decisions"]:visible');
	await expect(page.locator(".workspace-document-layer.is-open").filter({ has: view }))
		.toHaveCSS("opacity", "1");
	let scroller = view.locator("[data-plan-decisions-scroll]");
	let panel = scroller.locator('[data-slot="empty-state"]');
	await expect(panel).toBeVisible();
	let top = await scroller.evaluate(element => ({
		viewport: element.getBoundingClientRect().top,
		panel: element.querySelector('[data-slot="empty-state"]')!.getBoundingClientRect().top,
	}));
	expect(top.panel).toBeGreaterThanOrEqual(top.viewport);
	await scroller.evaluate(element => element.scrollTop = element.scrollHeight);
	let bottom = await scroller.evaluate(element => ({
		viewport: element.getBoundingClientRect().bottom,
		panel: element.querySelector('[data-slot="empty-state"]')!.getBoundingClientRect().bottom,
	}));
	expect(bottom.panel).toBeLessThanOrEqual(bottom.viewport);
});

test("a remembered Decisions view waits for the document before claiming it is empty", async ({ baseURL, page, room }) => {
	let opened = Promise.withResolvers<void>();
	let release: (() => void) | undefined;
	await page.addInitScript(() => localStorage.setItem("chopin:view:document", "decisions"));
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string" && JSON.parse(message).kind === "plan:open" && !release) {
				release = () => route.send(message);
				opened.resolve();
				return;
			}
			route.send(message);
		});
	});
	await authenticate(page, "ana", baseURL!);
	await page.goto(roomPath(room));
	await opened.promise;
	let decisions = page.locator('[data-document-view="decisions"]:visible');
	let announcement = decisions.getByRole("status");
	await expect(announcement).toHaveText("Loading decisions");
	let liveNode = await announcement.elementHandle();
	await expect(decisions.getByText("Loading decisions…")).toBeVisible();
	await expect(decisions.getByText("No decisions yet")).toHaveCount(0);
	release?.();
	await expect(decisions.getByRole("heading", { name: "No decisions yet" })).toBeVisible();
	await expect(announcement).toHaveText("No decisions yet");
	expect(await announcement.evaluate((node, prior) => node === prior, liveNode)).toBe(true);
});

test("an epoch reset hides stale cards until the replacement document is confirmed", async ({ baseURL, page, room, seed }) => {
	await seed(CARD, {
		revision: 1,
		questions: [{
			id: WIDGET,
			definition: DEFINITION,
			status: "open",
			origin: "planner",
			history: [],
			optionOrigins: {},
			editors: [],
		}],
		openQuestions: [{
			definition: DEFINITION,
			id: WIDGET,
			model: storedQuestion(DEFINITION),
			revision: 0,
			widget: WIDGET,
		}],
	});
	let browserRoute: WebSocketRoute | undefined;
	let holdNextOpen = false;
	let opened = Promise.withResolvers<void>();
	let release: (() => void) | undefined;
	await page.routeWebSocket("**/ws?**", route => {
		browserRoute = route;
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string" && JSON.parse(message).kind === "plan:open" && holdNextOpen) {
				holdNextOpen = false;
				release = () => route.send(message);
				opened.resolve();
				return;
			}
			route.send(message);
		});
	});
	await authenticate(page, "ana", baseURL!);
	await page.goto(roomPath(room));
	await page.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: /^Decisions/ }).click();
	let decisions = page.locator('[data-document-view="decisions"]:visible');
	let card = decisions.locator(`[data-plan-sidecar-questionnaire="${WIDGET}"]`);
	await expect(card).toBeVisible();

	holdNextOpen = true;
	browserRoute?.send(JSON.stringify({
		kind: "plan:reset",
		ts: 0,
		epoch: "fixture-replacement",
		reason: "replaced",
	}));
	await opened.promise;
	await expect(card).toHaveCount(0);
	await expect(decisions.getByRole("status")).toHaveText("Loading decisions");
	release?.();
	await expect(card).toBeVisible();
});

test("a rejected document open explains the failure and retries", async ({ baseURL, page, room }) => {
	let failed = false;
	await page.addInitScript(() => localStorage.setItem("chopin:view:document", "decisions"));
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string; rid?: string };
				if (frame.kind === "plan:open" && !failed) {
					failed = true;
					route.send(JSON.stringify({
						kind: "session:error",
						ts: 0,
						rid: frame.rid,
						message: "temporary fixture failure",
					}));
					return;
				}
			}
			route.send(message);
		});
	});
	await authenticate(page, "ana", baseURL!);
	await page.goto(roomPath(room));
	let decisions = page.locator('[data-document-view="decisions"]:visible');
	await expect(decisions.getByRole("heading", { name: "Decisions unavailable" })).toBeVisible();
	await expect(decisions.getByRole("status")).toHaveText("Decisions unavailable");
	await decisions.getByRole("button", { name: "Try again" }).click();
	await expect(decisions.getByRole("heading", { name: "No decisions yet" })).toBeVisible();
});

test("a read-only reader reaches the confirmed empty state", async ({ baseURL, page, room }) => {
	await authenticate(page, "readonly", baseURL!);
	await page.goto(roomPath(room));
	await page.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: /^Decisions/ }).click();
	let decisions = page.locator('[data-document-view="decisions"]:visible');
	await expect(decisions.getByRole("heading", { name: "No decisions yet" })).toBeVisible();
});
