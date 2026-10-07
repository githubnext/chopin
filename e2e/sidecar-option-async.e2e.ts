import { expect, test } from "./room";

import type { Page } from "@playwright/test";

/** Long enough to be marked: the injector wants twenty characters. */
const PROSE = "Room state lives on disk as MDX beside the transcript.\n";

function questionnaire(page: Page) {
	return page.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]');
}

async function holdOptionReply(page: Page, holdDefinition = false) {
	let questionId: string | undefined;
	let rid: string | undefined;
	let reply: (() => void) | undefined;
	let definition: (() => void) | undefined;
	let receivedReply!: () => void;
	let receivedDefinition!: () => void;
	let replyReceived = new Promise<void>(resolve => receivedReply = resolve);
	let definitionReceived = new Promise<void>(resolve => receivedDefinition = resolve);
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind?: string; id?: string; rid?: string };
				if (frame.kind === "question:option" && frame.id === questionId) rid = frame.rid;
			}
			server.send(message);
		});
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as { kind?: string; id?: string; rid?: string };
			if (frame.kind === "question:option" && frame.id === questionId && frame.rid === rid) {
				reply = () => route.send(message);
				receivedReply();
				return;
			}
			if (holdDefinition && frame.kind === "question:option-added" && frame.id === questionId) {
				definition = () => route.send(message);
				receivedDefinition();
				return;
			}
			route.send(message);
		});
	});
	return {
		setQuestion: (id: string) => questionId = id,
		replyReceived,
		definitionReceived,
		releaseReply: () => {
			if (!reply) throw new Error("question:option reply was not held");
			reply();
		},
		releaseDefinition: () => {
			if (!definition) throw new Error("question:option-added was not held");
			definition();
		},
	};
}

async function openOption(
	page: Page,
	held: Awaited<ReturnType<typeof holdOptionReply>>,
	label: string,
) {
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(page).filter({
		has: page.getByRole("heading", { name: "Where should room state live?" }),
	});
	let id = await card.getAttribute("data-plan-sidecar-questionnaire");
	if (!id) throw new Error("questionnaire has no ID");
	held.setQuestion(id);
	let trigger = card.getByRole("button", { name: "Add an option", exact: true });
	await trigger.click();
	let field = card.getByRole("textbox", { name: "New option" });
	await field.fill(label);
	await page.keyboard.press("Enter");
	await held.replyReceived;
	return { card, field, trigger };
}

test("adding an option keeps focus through a delayed definition update", async ({ join, page, seed }) => {
	await seed(PROSE);
	let held = await holdOptionReply(page, true);
	let ana = await join("ana");
	let { card, field, trigger } = await openOption(ana, held, "A delayed refresh option");
	await held.definitionReceived;
	await expect(field).toBeFocused();
	await expect(field).toHaveAttribute("aria-disabled", "true");
	await expect(field).toHaveJSProperty("readOnly", true);

	held.releaseDefinition();
	await expect(card.getByRole("radio", { name: "A delayed refresh option", exact: true }))
		.toBeVisible();
	await expect(field).toBeFocused();
	await expect(field).toHaveJSProperty("readOnly", true);
	held.releaseReply();
	await expect(field).toHaveCount(0);
	await expect(trigger).toBeFocused();
});

test("Escape during a delayed option reply restores focus and respects moving away", async ({ join, page, seed }) => {
	await seed(PROSE);
	let held = await holdOptionReply(page, true);
	let ana = await join("ana");
	let { card, field, trigger } = await openOption(ana, held, "Escape during refresh");
	await held.definitionReceived;
	await expect(field).toHaveAttribute("aria-disabled", "true");
	await expect(field).toHaveJSProperty("readOnly", true);
	await ana.keyboard.press("Escape");
	await expect(field).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await ana.getByRole("button", { name: "Hide chat" }).click();
	let chatOpener = ana.getByRole("button", { name: "Show chat" });
	await expect(chatOpener).toHaveAttribute("aria-expanded", "false");
	await expect(chatOpener).toBeFocused();

	held.releaseDefinition();
	held.releaseReply();
	await expect(card.getByRole("radio", { name: "Escape during refresh", exact: true }))
		.toBeVisible();
	await expect(trigger).toBeEnabled();
	await expect(chatOpener).toBeFocused();
});

test("Escape during a duplicate request clears its late error", async ({ join, page, seed }) => {
	await seed(PROSE);
	let held = await holdOptionReply(page);
	let ana = await join("ana");
	let { card, field, trigger } = await openOption(ana, held, "in sqlite");
	await expect(field).toHaveAttribute("aria-disabled", "true");
	await expect(field).toHaveJSProperty("readOnly", true);
	await ana.keyboard.press("Escape");
	await expect(field).toHaveCount(0);
	held.releaseReply();

	await expect(trigger).toBeEnabled();
	await trigger.click();
	await expect(field).toHaveValue("");
	await expect(card.getByRole("alert")).toHaveCount(0);
});

test("a late add reply does not steal focus after reopening and tabbing away", async ({ join, page, seed }) => {
	await seed(PROSE);
	let held = await holdOptionReply(page);
	let ana = await join("ana");
	let { card, field, trigger } = await openOption(ana, held, "in sqlite");
	await ana.keyboard.press("Escape");
	await expect(field).toHaveCount(0);
	await expect(trigger).toBeEnabled();
	await trigger.click();
	await expect(field).toHaveJSProperty("readOnly", true);
	await field.focus();
	await ana.keyboard.press("Tab");
	let discard = card.getByRole("button", { name: "Discard", exact: true });
	await expect(discard).toBeFocused();
	held.releaseReply();

	await expect(field).toHaveJSProperty("readOnly", false);
	await expect(discard).toBeFocused();
	await expect(card.getByRole("alert")).toHaveCount(0);
});

test("a successful delayed reply does not steal focus after tabbing away", async ({ join, page, seed }) => {
	await seed(PROSE);
	let held = await holdOptionReply(page);
	let ana = await join("ana");
	let { card, field } = await openOption(ana, held, "Keep focus outside the composer");
	await expect(field).toBeFocused();
	await ana.keyboard.press("Tab");
	let discard = card.getByRole("button", { name: "Discard", exact: true });
	await expect(discard).toBeFocused();
	held.releaseReply();

	await expect(field).toHaveCount(0);
	await expect(card.getByRole("radio", { name: "Keep focus outside the composer", exact: true }))
		.toBeVisible();
	await expect(discard).toBeFocused();
});
