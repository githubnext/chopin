import { authenticate, expect, roomPath, test } from "./room";

test("empty decisions remain reachable in a short viewport", async ({ join }) => {
	let page = await join("ana", { viewport: { width: 320, height: 260 } });
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Decisions/ }).click();
	let view = page.locator('[data-document-view="decisions"]:visible');
	await expect(page.locator(".workspace-document-layer.is-open").filter({ has: view }))
		.toHaveCSS("opacity", "1");
	let scroller = view.locator("[data-plan-decisions-scroll]");
	let panel = scroller.locator(".plan-decisions-empty");
	await expect(panel).toBeVisible();
	let top = await scroller.evaluate(element => ({
		viewport: element.getBoundingClientRect().top,
		panel: element.querySelector(".plan-decisions-empty")!.getBoundingClientRect().top,
	}));
	expect(top.panel).toBeGreaterThanOrEqual(top.viewport);
	await scroller.evaluate(element => element.scrollTop = element.scrollHeight);
	let bottom = await scroller.evaluate(element => ({
		viewport: element.getBoundingClientRect().bottom,
		panel: element.querySelector(".plan-decisions-empty")!.getBoundingClientRect().bottom,
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
	await expect(decisions.getByText("Loading decisions")).toBeVisible();
	await expect(decisions.getByText("No decisions yet")).toHaveCount(0);
	release?.();
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
