/** Browser coverage for prose navigation around hidden discarded cards. */

import { content, expect, test } from "./room";
import { storedQuestion } from "../apps/server/src/testing/plan";

import type { Page } from "@playwright/test";

const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";
const OPEN_DEFINITION = {
	questions: [{
		id: QUESTION,
		header: "Rollout",
		question: "How should we deploy?",
		multiple: false,
		options: [{ id: OPTION, label: "Canary", description: "" }],
	}],
};
const DISCARDED_CARD = `<Questionnaire id="${WIDGET}" by="ana" status="discarded">
<Question id="${QUESTION}" header="Rollout" prompt="How should we deploy?" multiple="false">
<Option id="${OPTION}" label="Canary" />
</Question>
</Questionnaire>`;
const DISCARDED_RECORD = {
	id: WIDGET,
	definition: OPEN_DEFINITION,
	status: "discarded",
	answers: { [QUESTION]: "Canary" },
	choices: [OPTION],
	resolver: "ana",
	owner: "ana",
	decidedAt: 1_790_000_000,
	history: [],
	optionOrigins: {},
	editors: [],
};
const OPEN_CARD = `<Questionnaire id="${WIDGET}" by="ana">
<Question id="${QUESTION}" header="Rollout" prompt="How should we deploy?" multiple="false">
<Option id="${OPTION}" label="Canary" />
</Question>
</Questionnaire>`;

function discardedHost(page: Page) {
	return content(page).locator(`[data-plan-questionnaire="${WIDGET}"]`);
}

async function placeCaretAtEnd(page: Page, sentence: string) {
	return content(page).evaluate((root, before) => {
		let paragraph = [...root.querySelectorAll("p")].find(item => item.textContent === before);
		let text = paragraph?.querySelector("[data-lexical-text]")?.firstChild;
		if (!(text instanceof Text)) throw new Error("the target paragraph has no text node");
		let selection = getSelection();
		if (!selection) throw new Error("selection unavailable");
		(root as HTMLElement).focus();
		let range = document.createRange();
		range.setStart(text, text.data.length);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
		return {
			active: document.activeElement === root,
			anchor: selection.anchorNode === text,
			paragraph: paragraph?.textContent ?? null,
			contentEditable: (root as HTMLElement).contentEditable,
		};
	}, sentence);
}

async function placeCaretAtStart(page: Page, sentence: string) {
	return content(page).evaluate((root, textContent) => {
		let paragraph = [...root.querySelectorAll("p")].find(item => item.textContent === textContent);
		let text = paragraph?.querySelector("[data-lexical-text]")?.firstChild;
		if (!(text instanceof Text)) throw new Error("the target paragraph has no text node");
		let selection = getSelection();
		if (!selection) throw new Error("selection unavailable");
		(root as HTMLElement).focus();
		let range = document.createRange();
		range.setStart(text, 0);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);
		return {
			active: document.activeElement === root,
			anchor: selection.anchorNode === text,
			paragraph: paragraph?.textContent ?? null,
			contentEditable: (root as HTMLElement).contentEditable,
		};
	}, sentence);
}

async function caretState(page: Page) {
	return page.evaluate(() => {
		let selection = getSelection();
		let node = selection?.anchorNode;
		let element = node instanceof Element ? node : node?.parentElement;
		let active = document.activeElement;
		return {
			active: active?.tagName ?? null,
			activeContentEditable: active instanceof HTMLElement ? active.contentEditable : null,
			anchorNode: node?.nodeName ?? null,
			anchorText: node?.textContent ?? null,
			offset: selection?.anchorOffset ?? null,
			paragraph: element?.closest("p")?.textContent ?? null,
		};
	});
}

test("arrowing between ordinary paragraphs moves to the next paragraph", async ({ join, seed }) => {
	await seed("Before hidden decision.\n\nAfter hidden decision.");
	let page = await join("ana");
	let editor = content(page);
	let originalParagraphs = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	let initial = await placeCaretAtEnd(page, "Before hidden decision.");
	expect(initial).toEqual({
		active: true,
		anchor: true,
		paragraph: "Before hidden decision.",
		contentEditable: "true",
	});
	await page.keyboard.press("ArrowRight");
	let caret = await caretState(page);
	let afterRightParagraphs = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.type("X");
	let afterRightTyping = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.press("Backspace");

	initial = await placeCaretAtStart(page, "After hidden decision.");
	expect(initial.paragraph).toBe("After hidden decision.");
	await page.keyboard.press("ArrowLeft");
	let afterLeftParagraphs = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.type("Y");
	let afterLeftTyping = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.press("Backspace");
	let restoredParagraphs = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	if (
		caret.paragraph !== "After hidden decision."
		|| JSON.stringify(afterRightParagraphs) !== JSON.stringify(originalParagraphs)
		|| !afterRightTyping.includes("XAfter hidden decision.")
		|| JSON.stringify(afterLeftParagraphs) !== JSON.stringify(originalParagraphs)
		|| !afterLeftTyping.includes("Before hidden decision.Y")
		|| JSON.stringify(restoredParagraphs) !== JSON.stringify(originalParagraphs)
	) {
		throw new Error(`Ordinary paragraph traversal: ${
			JSON.stringify({
				caret,
				afterRightParagraphs,
				afterRightTyping,
				afterLeftParagraphs,
				afterLeftTyping,
				restoredParagraphs,
			})
		}`);
	}
});

test("a hidden discarded node has no layout footprint or keyboard stop", async ({ join, seed }) => {
	await seed(`Before hidden decision.\n\n${DISCARDED_CARD}\n\nAfter hidden decision.`, {
		questions: [DISCARDED_RECORD],
	});
	let page = await join("ana");
	let editor = content(page);
	let host = editor.locator(`[data-plan-questionnaire="${WIDGET}"]`);
	await expect(host).toBeAttached();
	await expect(host).toBeHidden();
	let documentOrder = await editor.evaluate((root, widgetId) => {
		let paragraphs = [...root.querySelectorAll("p")];
		let hidden = root.querySelector(`[data-plan-questionnaire="${widgetId}"]`);
		return {
			hiddenBetweenProse: Boolean(
				paragraphs[0] && hidden && paragraphs.at(-1)
					&& paragraphs[0]!.compareDocumentPosition(hidden) & Node.DOCUMENT_POSITION_FOLLOWING
					&& hidden.compareDocumentPosition(paragraphs.at(-1)!)
						& Node.DOCUMENT_POSITION_FOLLOWING,
			),
		};
	}, WIDGET);
	expect(documentOrder.hiddenBetweenProse).toBe(true);
	let layout = await host.evaluate(element => {
		let style = getComputedStyle(element);
		let bounds = element.getBoundingClientRect();
		return {
			display: style.display,
			marginBottom: style.marginBottom,
			marginTop: style.marginTop,
			width: bounds.width,
			height: bounds.height,
		};
	});
	expect(layout).toEqual({
		display: "none",
		marginBottom: "0px",
		marginTop: "0px",
		width: 0,
		height: 0,
	});
	await expect(host.locator("button, input, select, textarea, [tabindex]:not([tabindex='-1'])"))
		.toHaveCount(0);
	let initial = await placeCaretAtStart(page, "After hidden decision.");
	expect(initial).toEqual({
		active: true,
		anchor: true,
		paragraph: "After hidden decision.",
		contentEditable: "true",
	});
	let originalParagraphs = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	initial = await placeCaretAtEnd(page, "Before hidden decision.");
	await page.keyboard.press("ArrowRight");
	let afterNaturalRight = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.press("ArrowLeft");
	let afterNaturalLeft = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.type("R");
	let afterNaturalLeftTyping = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.press("Backspace");
	let afterNaturalRestore = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);

	initial = await placeCaretAtStart(page, "After hidden decision.");
	await page.keyboard.press("ArrowLeft");
	let afterLeft = await caretState(page);
	let afterLeftParagraphs = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.type("Y");
	let afterLeftTyping = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.press("Backspace");
	let afterLeftRestore = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);

	initial = await placeCaretAtEnd(page, "Before hidden decision.");
	expect(initial.paragraph).toBe("Before hidden decision.");
	await page.keyboard.press("ArrowRight");
	let afterRight = await caretState(page);
	let afterRightParagraphs = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.type("X");
	let paragraphs = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	if (
		JSON.stringify(afterNaturalRight) !== JSON.stringify(originalParagraphs)
		|| JSON.stringify(afterNaturalLeft) !== JSON.stringify(originalParagraphs)
		|| !afterNaturalLeftTyping.includes("Before hidden decision.R")
		|| JSON.stringify(afterNaturalRestore) !== JSON.stringify(originalParagraphs)
		|| JSON.stringify(afterLeftParagraphs) !== JSON.stringify(originalParagraphs)
		|| JSON.stringify(afterRightParagraphs) !== JSON.stringify(originalParagraphs)
		|| !afterLeftTyping.includes("Before hidden decision.Y")
		|| JSON.stringify(afterLeftRestore) !== JSON.stringify(originalParagraphs)
		|| !paragraphs.includes("XAfter hidden decision.")
	) {
		throw new Error(`Discarded traversal state: ${
			JSON.stringify({
				afterNaturalRight,
				afterNaturalLeft,
				afterNaturalLeftTyping,
				afterNaturalRestore,
				afterLeft,
				afterLeftParagraphs,
				afterLeftTyping,
				afterLeftRestore,
				afterRight,
				afterRightParagraphs,
				paragraphs,
			})
		}`);
	}
});

test("a discarded first block does not create a prose gap before the first paragraph", async ({ join, seed }) => {
	await seed(`${DISCARDED_CARD}\n\nOnly visible paragraph.`, {
		questions: [DISCARDED_RECORD],
	});
	let page = await join("ana");
	let editor = content(page);
	let host = editor.locator(`[data-plan-questionnaire="${WIDGET}"]`);
	await expect(host).toBeHidden();
	let order = await editor.evaluate((root, widgetId) => {
		let hidden = root.querySelector(`[data-plan-questionnaire="${widgetId}"]`);
		let visible = [...root.querySelectorAll("p")].find(
			paragraph => paragraph.textContent === "Only visible paragraph.",
		);
		return Boolean(
			hidden && visible
				&& hidden.compareDocumentPosition(visible) & Node.DOCUMENT_POSITION_FOLLOWING,
		);
	}, WIDGET);
	expect(order).toBe(true);
	let original = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await placeCaretAtStart(page, "Only visible paragraph.");
	await page.keyboard.press("ArrowLeft");
	let afterArrow = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.type("X");
	let afterTyping = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.press("Backspace");
	let restored = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	if (
		JSON.stringify(afterArrow) !== JSON.stringify(original)
		|| !afterTyping.includes("XOnly visible paragraph.")
		|| JSON.stringify(restored) !== JSON.stringify(original)
	) {
		throw new Error(`Discarded leading block traversal: ${
			JSON.stringify({
				original,
				afterArrow,
				afterTyping,
				restored,
			})
		}`);
	}
});

test("a discarded final block routes Right into the existing blank continuation", async ({ join, seed }) => {
	await seed(`Only visible paragraph.\n\n${DISCARDED_CARD}`, {
		questions: [{ ...DISCARDED_RECORD, status: "discarded", resolver: "ana" }],
	});
	let page = await join("ana");
	let editor = content(page);
	let host = editor.locator(`[data-plan-questionnaire="${WIDGET}"]`);
	await expect(host).toBeHidden();
	let original = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	let order = await editor.evaluate((root, widgetId) => {
		let paragraphs = [...root.querySelectorAll("p")];
		let hidden = root.querySelector(`[data-plan-questionnaire="${widgetId}"]`);
		return Boolean(
			paragraphs[0] && paragraphs.at(-1) && hidden
				&& paragraphs[0]!.compareDocumentPosition(hidden) & Node.DOCUMENT_POSITION_FOLLOWING
				&& hidden.compareDocumentPosition(paragraphs.at(-1)!)
					& Node.DOCUMENT_POSITION_FOLLOWING
				&& paragraphs.at(-1)!.textContent === "",
		);
	}, WIDGET);
	expect(order).toBe(true);
	let initial = await placeCaretAtEnd(page, "Only visible paragraph.");
	await page.keyboard.press("ArrowRight");
	let afterArrowState = await caretState(page);
	let afterArrow = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.type("X");
	let afterTyping = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	await page.keyboard.press("Backspace");
	let restored = await editor.evaluate(root =>
		[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
	);
	if (
		JSON.stringify(afterArrow) !== JSON.stringify(original)
		|| afterTyping.length !== original.length
		|| afterTyping.at(-1) !== "X"
		|| JSON.stringify(restored) !== JSON.stringify(original)
	) {
		throw new Error(`Discarded trailing block traversal: ${
			JSON.stringify({
				initial,
				afterArrowState,
				original,
				afterArrow,
				afterTyping,
				restored,
			})
		}`);
	}
});

test("metadata-only discard hides a stale node and routes Right into the next prose block", async ({ join, page, seed }) => {
	await seed(`Before metadata discard.\n\n${OPEN_CARD}\n\nAfter metadata discard.`, {
		revision: 1,
		questions: [{
			id: WIDGET,
			definition: OPEN_DEFINITION,
			status: "open",
			origin: "planner",
			history: [],
			optionOrigins: {},
			editors: [],
		}],
		openQuestions: [{
			id: WIDGET,
			definition: OPEN_DEFINITION,
			model: storedQuestion(OPEN_DEFINITION),
			revision: 0,
			widget: WIDGET,
		}],
	});
	let holdPlanUpdates = false;
	let heldUpdates: string[] = [];
	let didHoldUpdate!: () => void;
	let updateHeld = new Promise<void>(resolve => didHoldUpdate = resolve);
	let didDiscard!: () => void;
	let discarded = new Promise<void>(resolve => didDiscard = resolve);
	let serverSender: { send: (message: string) => void } | undefined;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		serverSender = { send: message => route.send(message) };
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as {
				kind?: string;
				id?: string;
				meta?: { status?: string };
			};
			if (holdPlanUpdates && frame.kind === "plan:update") {
				heldUpdates.push(message);
				didHoldUpdate();
				return;
			}
			if (
				frame.id === WIDGET && frame.kind === "question:meta" && frame.meta?.status === "discarded"
			) {
				didDiscard();
			}
			route.send(message);
		});
	});

	let ben = await join("ben");
	let ana = await join("ana");
	let host = discardedHost(ben);
	await expect(host).toBeVisible();
	holdPlanUpdates = true;
	await ana.getByRole("button", { name: /^Decisions/ }).click();
	let anaCard = ana.locator(
		`[data-document-view="decisions"] article[data-plan-sidecar-questionnaire="${WIDGET}"]`,
	);
	await anaCard.getByRole("button", { name: "Discard", exact: true }).click();
	await expect(anaCard.getByText("Discard this decision?", { exact: true })).toBeVisible();
	await anaCard.getByRole("button", { name: "Discard", exact: true }).click();
	await Promise.all([updateHeld, discarded]);

	try {
		await expect(host).toBeHidden();
		let editor = content(ben);
		let original = await editor.evaluate(root =>
			[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
		);
		let initial = await placeCaretAtEnd(ben, "Before metadata discard.");
		await ben.keyboard.press("ArrowRight");
		let afterArrow = await editor.evaluate(root =>
			[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
		);
		await ben.keyboard.type("X");
		let afterTyping = await editor.evaluate(root =>
			[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
		);
		await ben.keyboard.press("Backspace");
		let restored = await editor.evaluate(root =>
			[...root.querySelectorAll("p")].map(paragraph => paragraph.textContent)
		);
		if (
			!initial.anchor
			|| JSON.stringify(afterArrow) !== JSON.stringify(original)
			|| !afterTyping.includes("XAfter metadata discard.")
			|| JSON.stringify(restored) !== JSON.stringify(original)
			|| heldUpdates.length === 0
		) {
			throw new Error(`Metadata-only discarded navigation: ${
				JSON.stringify({
					original,
					afterArrow,
					afterTyping,
					restored,
					heldUpdateCount: heldUpdates.length,
				})
			}`);
		}
	} finally {
		if (serverSender) {
			for (let update of heldUpdates) serverSender.send(update);
		}
		heldUpdates = [];
	}
});
