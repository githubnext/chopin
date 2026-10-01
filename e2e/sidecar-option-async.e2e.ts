import { expect, test } from "./room";

/** Long enough to be marked: the injector wants twenty characters. */
const PROSE = "Room state lives on disk as MDX beside the transcript.\n";

function questionnaire(page: import("@playwright/test").Page) {
	return page.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]');
}

test("adding an option keeps focus through a delayed definition refresh", async ({ join, page, seed }) => {
	await seed(PROSE);
	let questionId: string | undefined;
	let reopenRid: string | undefined;
	let heldChanged: (() => void) | undefined;
	let heldOpen: (() => void) | undefined;
	let holdRefreshOpen = false;
	let didReceiveChanged!: () => void;
	let changedReceived = new Promise<void>(resolve => didReceiveChanged = resolve);
	let didReceiveOpen!: () => void;
	let openReceived = new Promise<void>(resolve => didReceiveOpen = resolve);

	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (holdRefreshOpen && typeof message === "string") {
				let frame = JSON.parse(message) as { kind?: string; id?: string; rid?: string };
				if (frame.kind === "question:open" && frame.id === questionId) {
					reopenRid = frame.rid;
				}
			}
			server.send(message);
		});
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as { kind?: string; id?: string; rid?: string };
			if (frame.kind === "question:changed" && frame.id === questionId) {
				heldChanged = () => route.send(message);
				didReceiveChanged();
				return;
			}
			if (holdRefreshOpen && frame.kind === "question:open" && frame.rid === reopenRid) {
				heldOpen = () => route.send(message);
				didReceiveOpen();
				return;
			}
			route.send(message);
		});
	});

	let ana = await join("ana");
	await ana.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(ana).filter({
		has: ana.getByRole("heading", { name: "Where should room state live?" }),
	});
	questionId = await card.getAttribute("data-plan-sidecar-questionnaire") ?? undefined;
	let field = card.getByRole("textbox", { name: "New option" });
	await card.getByRole("button", { name: "Add another option" }).click();
	await field.fill("A delayed refresh option");
	await ana.keyboard.press("Enter");

	await changedReceived;
	await expect(field).toBeFocused();
	holdRefreshOpen = true;
	if (!heldChanged) throw new Error("question:changed was not held");
	heldChanged();
	await openReceived;
	await expect(field).toHaveAttribute("aria-disabled", "true");
	await expect(field).toHaveJSProperty("readOnly", true);
	await ana.evaluate(() =>
		new Promise<void>(resolve => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		})
	);
	if (!heldOpen) throw new Error("refresh question:open was not held");
	heldOpen();
	await expect(field).toBeEnabled();
	await expect(field).not.toHaveAttribute("aria-disabled", "true");
	await expect(field).toHaveJSProperty("readOnly", false);
	await expect(field).toBeFocused();
});

test("Escape during a delayed refresh restores focus and respects moving away", async ({ join, page, seed }) => {
	await seed(PROSE);
	let questionId: string | undefined;
	let reopenRid: string | undefined;
	let heldChanged: (() => void) | undefined;
	let heldOpen: (() => void) | undefined;
	let holdRefreshOpen = false;
	let didReceiveChanged!: () => void;
	let changedReceived = new Promise<void>(resolve => didReceiveChanged = resolve);
	let didReceiveOpen!: () => void;
	let openReceived = new Promise<void>(resolve => didReceiveOpen = resolve);

	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (holdRefreshOpen && typeof message === "string") {
				let frame = JSON.parse(message) as { kind?: string; id?: string; rid?: string };
				if (frame.kind === "question:open" && frame.id === questionId) reopenRid = frame.rid;
			}
			server.send(message);
		});
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as { kind?: string; id?: string; rid?: string };
			if (frame.kind === "question:changed" && frame.id === questionId) {
				heldChanged = () => route.send(message);
				didReceiveChanged();
				return;
			}
			if (holdRefreshOpen && frame.kind === "question:open" && frame.rid === reopenRid) {
				heldOpen = () => route.send(message);
				didReceiveOpen();
				return;
			}
			route.send(message);
		});
	});

	let ana = await join("ana");
	await ana.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(ana).filter({
		has: ana.getByRole("heading", { name: "Where should room state live?" }),
	});
	questionId = await card.getAttribute("data-plan-sidecar-questionnaire") ?? undefined;
	let trigger = card.getByRole("button", { name: "Add another option" });
	await trigger.click();
	let field = card.getByRole("textbox", { name: "New option" });
	await field.fill("Escape during refresh");
	await ana.keyboard.press("Enter");

	await changedReceived;
	holdRefreshOpen = true;
	if (!heldChanged) throw new Error("question:changed was not held");
	heldChanged();
	await openReceived;
	await expect(field).toHaveAttribute("aria-disabled", "true");
	await expect(field).toHaveJSProperty("readOnly", true);
	await ana.keyboard.press("Escape");
	await expect(field).toHaveCount(0);
	await expect(trigger).toBeFocused();
	let chatToggle = ana.getByRole("button", { name: /^(Show|Hide) chat pane/ });
	await chatToggle.click();
	await expect(chatToggle).toHaveAttribute("aria-expanded", "false");
	await expect(chatToggle).toBeFocused();
	if (!heldOpen) throw new Error("refresh question:open was not held");
	heldOpen();

	await expect(trigger).toBeEnabled();
	await expect(chatToggle).toBeFocused();
});

test("Escape during a duplicate request clears its late error", async ({ join, page, seed }) => {
	await seed(PROSE);
	let questionId: string | undefined;
	let addOptionRid: string | undefined;
	let heldFailure: (() => void) | undefined;
	let didReceiveFailure!: () => void;
	let failureReceived = new Promise<void>(resolve => didReceiveFailure = resolve);

	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind?: string; id?: string; rid?: string };
				if (frame.kind === "question:add-option" && frame.id === questionId) {
					addOptionRid = frame.rid;
				}
			}
			server.send(message);
		});
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as {
				kind?: string;
				id?: string;
				rid?: string;
				ok?: boolean;
			};
			if (
				frame.kind === "question:add-option"
				&& frame.id === questionId
				&& frame.rid === addOptionRid
				&& frame.ok === false
			) {
				heldFailure = () => route.send(message);
				didReceiveFailure();
				return;
			}
			route.send(message);
		});
	});

	let ana = await join("ana");
	await ana.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(ana).filter({
		has: ana.getByRole("heading", { name: "Where should room state live?" }),
	});
	questionId = await card.getAttribute("data-plan-sidecar-questionnaire") ?? undefined;
	let trigger = card.getByRole("button", { name: "Add another option" });
	await trigger.click();
	let field = card.getByRole("textbox", { name: "New option" });
	await field.fill("in sqlite");
	await ana.keyboard.press("Enter");

	await failureReceived;
	await expect(field).toHaveAttribute("aria-disabled", "true");
	await expect(field).toHaveJSProperty("readOnly", true);
	await ana.keyboard.press("Escape");
	await expect(field).toHaveCount(0);
	if (!heldFailure) throw new Error("duplicate question:add-option reply was not held");
	heldFailure();

	await expect(trigger).toBeEnabled();
	await trigger.click();
	field = card.getByRole("textbox", { name: "New option" });
	await expect(field).toHaveValue("");
	await expect(card.getByRole("alert")).toHaveCount(0);
});

test("a late add reply does not steal focus after reopening and tabbing away", async ({ join, page, seed }) => {
	await seed(PROSE);
	let questionId: string | undefined;
	let addOptionRid: string | undefined;
	let heldFailure: (() => void) | undefined;
	let didReceiveFailure!: () => void;
	let failureReceived = new Promise<void>(resolve => didReceiveFailure = resolve);

	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind?: string; id?: string; rid?: string };
				if (frame.kind === "question:add-option" && frame.id === questionId) {
					addOptionRid = frame.rid;
				}
			}
			server.send(message);
		});
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as {
				kind?: string;
				id?: string;
				rid?: string;
				ok?: boolean;
			};
			if (
				frame.kind === "question:add-option"
				&& frame.id === questionId
				&& frame.rid === addOptionRid
				&& frame.ok === false
			) {
				heldFailure = () => route.send(message);
				didReceiveFailure();
				return;
			}
			route.send(message);
		});
	});

	let ana = await join("ana");
	await ana.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(ana).filter({
		has: ana.getByRole("heading", { name: "Where should room state live?" }),
	});
	questionId = await card.getAttribute("data-plan-sidecar-questionnaire") ?? undefined;
	let trigger = card.getByRole("button", { name: "Add another option" });
	await trigger.click();
	let field = card.getByRole("textbox", { name: "New option" });
	await field.fill("in sqlite");
	await ana.keyboard.press("Enter");

	await failureReceived;
	await ana.keyboard.press("Escape");
	await expect(field).toHaveCount(0);
	await expect(trigger).toBeEnabled();
	await trigger.click();
	field = card.getByRole("textbox", { name: "New option" });
	await expect(field).toHaveJSProperty("readOnly", true);
	await field.focus();
	await ana.keyboard.press("Tab");
	let discard = card.getByRole("button", { name: "Discard", exact: true });
	await expect(discard).toBeFocused();
	if (!heldFailure) throw new Error("duplicate question:add-option reply was not held");
	heldFailure();

	await expect(field).toHaveJSProperty("readOnly", false);
	await expect(discard).toBeFocused();
});
