/**
 * Questionnaires and comment threads, without an agent.
 *
 * `DEV_QUESTIONS` and `DEV_COMMENTS` exist so that the whole question and
 * passage path can be exercised by a room opening rather than by a model
 * deciding to ask something. They are read from the environment on every room
 * open, so this file runs against a second server — one with them on would put
 * a question and a thread into every other suite's room.
 *
 * A comment needs prose to mark, and a new room seeds from nothing, so every
 * test here writes the plan before anybody opens it.
 */

import { authenticate, content, expect, test } from "./room";
import { storedQuestion } from "../apps/server/src/testing/plan";

import type { Page } from "@playwright/test";

/** Long enough to be marked: the injector wants twenty characters. */
const PROSE = "Room state lives on disk as MDX beside the transcript.\n";
const TWO_BLOCKS = `${PROSE}\nA second block remains after the marked passage.\n`;
const TALL_PASSAGE = `${
	Array.from({ length: 160 }, () => "A selected passage keeps going.").join(" ")
}\n`;
const LONG_PLAN = Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");
const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";
const SECOND_QUESTION = "01K0N4W3B7P27CBAEC7A8C8WEB";
const SECOND_OPTION = "01K0N4W3B7P27CBAEC7A8C8WEC";
const ANCHORED_DEFINITION = {
	questions: [{
		id: QUESTION,
		header: "Rollout",
		question: "How should we deploy?",
		multiple: false,
		options: [{ id: OPTION, label: "Canary", description: "" }],
	}],
};
const ANCHORED = `Anchored paragraph.

<Questionnaire id="${WIDGET}" by="ana">
<Question id="${QUESTION}" header="Rollout" prompt="How should we deploy?" multiple="false">
<Option id="${OPTION}" label="Canary" />
</Question>
</Questionnaire>
`;
const ANCHORED_DIGEST = "sha256:3ccc3e648811df8180799f8b012c6934bcf44a306f5eb8b8c9d2676b0493ccf4";
const MULTI_QUESTIONNAIRE = `Multi-step decision.

<Questionnaire id="${WIDGET}" by="ana">
<Question id="${QUESTION}" header="Rollout" prompt="How should we deploy?" multiple="false">
<Option id="${OPTION}" label="Canary" />
</Question>
<Question id="${SECOND_QUESTION}" header="Scope" prompt="What belongs in the first cut?" multiple="false">
<Option id="${SECOND_OPTION}" label="Anchors" />
</Question>
</Questionnaire>
`;

/** What the injector will quote: the first forty-eight characters. */
const QUOTED = "Room state lives on disk as MDX beside the trans";

function questionnaire(page: import("@playwright/test").Page) {
	return page.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]');
}

function documentEditor(page: Page) {
	return page.locator('[data-document-view="plan"]')
		.getByRole("textbox", { includeHidden: true, name: "editable markdown" });
}

function commentButton(page: import("@playwright/test").Page) {
	return page.getByRole("button", { name: /Comment on “/ });
}

test("the desktop document view switches through its segmented control", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let control = page.getByRole("group", { name: "Document view" });
	let plan = control.getByRole("button", { name: "Document", exact: true });
	let decisions = control.getByRole("button", { name: /^Decisions, 2 unanswered$/ });

	await expect(control).toBeVisible();
	await expect(plan).toHaveAttribute("aria-pressed", "true");
	await expect(decisions).toHaveAttribute("aria-pressed", "false");

	await decisions.click();
	await expect(page.locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(decisions).toHaveAttribute("aria-pressed", "true");
	await plan.click();
	await expect(page.locator('[data-document-view="plan"]')).toBeVisible();
	await expect(plan).toHaveAttribute("aria-pressed", "true");
});

test("question step swaps overlap only for pointer input", async ({ join, seed }) => {
	await seed(MULTI_QUESTIONNAIRE);
	let page = await join("ana");
	let card = page.locator(
		`[data-document-view="plan"] article[data-plan-sidecar-questionnaire="${WIDGET}"]`,
	);
	let stack = card.locator("[data-question-step-swap]");
	let visible = stack.locator(":scope > [data-content-swap-state]:not([hidden])");
	let outgoing = stack.locator(
		':scope > [data-content-swap-state="outgoing"]:not([hidden])',
	);
	let scope = card.getByRole("tab", { name: "Scope" });

	await scope.click();
	await expect(visible).toHaveCount(2);
	await expect(stack.locator(":scope > [data-content-swap-state]:not([hidden]):not([inert])"))
		.toHaveCount(1);
	await expect(outgoing).toHaveCount(1);
	await expect(outgoing).toHaveAttribute("aria-hidden", "true");
	await expect(outgoing).toHaveAttribute("inert", "");
	await expect(visible).toHaveCount(1);

	await scope.focus();
	await page.keyboard.press("ArrowLeft");
	await expect(visible).toHaveCount(1);
	await expect(outgoing).toHaveCount(0);
	await expect(card.getByRole("tab", { name: "Rollout" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
});

async function rewriteFirstBlock(page: import("@playwright/test").Page, value: string) {
	let block = content(page).locator("p").first();
	await block.selectText();
	await page.keyboard.type(value);
}

async function thread(page: import("@playwright/test").Page) {
	await commentButton(page).click();
	return page.getByRole("dialog", { name: "Comment thread" });
}

async function secondThread(page: import("@playwright/test").Page) {
	await content(page).locator("p").nth(1).selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let draft = page.getByRole("dialog", { name: "New comment" });
	await draft.getByPlaceholder("Comment on this passage…").fill("Keep this block as well.");
	await draft.getByRole("button", { name: "Comment" }).click();
	await expect.poll(() => commentButton(page).count()).toBe(2);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toHaveCount(0);
}

test(
	"prose opens Plan while injected questions preserve its position and selection",
	async ({ join, seed }) => {
		await seed(LONG_PLAN);
		let page = await join("ana");

		let plan = page.getByRole("button", { name: "Document", exact: true });
		let decisions = page.getByRole("button", { name: /^Decisions/ });
		let scroller = page.locator("[data-plan-scroll]");
		let selected = content(page).getByText("Paragraph 9.", { exact: true });
		await selected.selectText();
		await scroller.evaluate(element => {
			element.scrollTop = 160;
			element.dispatchEvent(new Event("scroll"));
		});
		let selection = await page.evaluate(() => getSelection()?.toString());
		let scrollTop = await scroller.evaluate(element => element.scrollTop);

		await expect(questionnaire(page)).toHaveCount(2);
		await expect(plan).toHaveAttribute("aria-pressed", "true");
		await expect(decisions).toHaveAttribute("aria-pressed", "false");
		await expect(page.locator('[data-document-view="decisions"]')).toBeHidden();
		await expect(decisions).toContainText("2");
		await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(scrollTop);
		expect(await page.evaluate(() => getSelection()?.toString())).toBe(selection);

		await decisions.click();
		await expect(questionnaire(page)).toHaveCount(2);
		await expect(questionnaire(page).getByRole("heading", { name: "Storage" })).toBeVisible();
		await expect(page.locator('[data-document-view="decisions"] [data-plan-sidecar-thread]'))
			.toHaveCount(0);
	},
);

test(
	"an unseeded room opens Decisions with the injected unanswered questions",
	async ({ baseURL, page, room }) => {
		await authenticate(page, "ana", baseURL!);
		await page.goto(`/channels/${room}`);

		await expect(page.getByRole("button", { name: /^Decisions/ }))
			.toHaveAttribute("aria-pressed", "true");
		let card = questionnaire(page);
		await expect(card).toHaveCount(2);
		await expect(card.getByRole("heading", { name: "Storage" })).toBeVisible();
		await expect(card.getByRole("heading", { name: "Scope" })).toBeVisible();
		await expect(card.getByRole("tablist")).toHaveCount(0);
	},
);

test("questions leave the chat pane free of a waiting row", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");

	await expect(questionnaire(page)).toHaveCount(2);
	await expect(
		page.getByRole("complementary", { includeHidden: true, name: "Conversation" })
			.getByRole("button", { name: "Answer" }),
	).toHaveCount(0);

	await page.getByRole("button", { name: /^Decisions/ }).click();
	await expect(page.getByRole("button", { name: /^Decisions/ }))
		.toHaveAttribute("aria-pressed", "true");
	await expect(questionnaire(page).first()).toBeInViewport();
});

test("switching views restores the plan scroll position", async ({ join, seed }) => {
	await seed(LONG_PLAN);
	let page = await join("ana");
	let scroller = page.locator("[data-plan-scroll]");

	await scroller.evaluate(element => {
		element.scrollTop = 160;
		element.dispatchEvent(new Event("scroll"));
	});
	await page.getByRole("button", { name: /^Decisions/ }).click();
	await page.getByRole("button", { name: "Document", exact: true }).click();
	await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(160);
});

async function expectCompactDestinationStatePreserved(page: Page): Promise<void> {
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	let planScroller = page.locator("[data-plan-scroll]");
	let draft = page.getByPlaceholder("Use @chopin to ask Chopin");
	await planScroller.evaluate(element => {
		element.scrollTop = 160;
		element.dispatchEvent(new Event("scroll"));
	});
	await draft.evaluate(textarea => {
		let plan = document.querySelector("[data-plan-scroll]")!;
		let tracker = {
			plan,
			textarea,
			removed: false,
			observer: undefined as MutationObserver | undefined,
		};
		tracker.observer = new MutationObserver(records => {
			for (let record of records) {
				for (let node of record.removedNodes) {
					if (node === plan || node === textarea) tracker.removed = true;
					if (node instanceof Element && (node.contains(plan) || node.contains(textarea))) {
						tracker.removed = true;
					}
				}
			}
		});
		tracker.observer.observe(document.body, { childList: true, subtree: true });
		(window as typeof window & { __workspaceTracker?: typeof tracker }).__workspaceTracker =
			tracker;
	});

	await nav.getByRole("button", { name: /Conversation/ }).click();
	await draft.fill("unfinished compact thought");

	await nav.getByRole("button", { name: /^Decisions/ }).click();
	let decisionScroller = page.locator("[data-plan-decisions-scroll]");
	await decisionScroller.evaluate(element => {
		element.scrollTop = element.scrollHeight;
		element.dispatchEvent(new Event("scroll"));
	});
	let decisionScroll = await decisionScroller.evaluate(element => element.scrollTop);
	await nav.getByRole("button", { name: "Document" }).click();

	await expect(draft).toHaveValue("unfinished compact thought");
	await expect.poll(() => planScroller.evaluate(element => element.scrollTop)).toBe(160);
	await nav.getByRole("button", { name: /^Decisions/ }).click();
	await expect.poll(() => decisionScroller.evaluate(element => element.scrollTop)).toBe(
		decisionScroll,
	);
	await nav.getByRole("button", { name: "Document" }).click();
	expect(decisionScroll).toBeGreaterThan(0);
	let identity = await draft.evaluate(textarea => {
		let tracker = (window as typeof window & {
			__workspaceTracker?: {
				plan: Element;
				textarea: Element;
				removed: boolean;
				observer: MutationObserver;
			};
		}).__workspaceTracker!;
		tracker.observer.disconnect();
		return {
			plan: tracker.plan === document.querySelector("[data-plan-scroll]"),
			textarea: tracker.textarea === textarea,
			removed: tracker.removed,
		};
	});
	expect(identity).toEqual({ plan: true, textarea: true, removed: false });
}

for (
	let viewport of [
		{ height: 568, width: 320 },
		{ height: 844, width: 390 },
	]
) {
	test(`${viewport.width}×${viewport.height} compact destinations preserve draft, scroll, and mounted identity`, async ({ join, seed }) => {
		await seed(LONG_PLAN);
		let page = await join("ana", { hasTouch: true, viewport });
		await expectCompactDestinationStatePreserved(page);
	});
}

test("automatic Decisions changes reconcile after compact Conversation closes", async ({ baseURL, browser, page: ana, room }) => {
	await ana.setViewportSize({ width: 390, height: 844 });
	await authenticate(ana, "ana", baseURL!);
	await ana.goto(`/channels/${room}`);
	await expect(ana.locator('[aria-label="editable markdown"]')).toHaveAttribute(
		"contenteditable",
		"true",
		{ timeout: 20_000 },
	);
	let nav = ana.getByRole("navigation", { name: "Workspace view" });
	await expect(nav.getByRole("button", { name: /^Decisions/ })).toHaveAttribute(
		"aria-current",
		"page",
	);
	await nav.getByRole("button", { name: /Conversation/ }).click();

	let boContext = await browser.newContext({ baseURL, viewport: { width: 1280, height: 800 } });
	try {
		let bo = await boContext.newPage();
		await authenticate(bo, "bo", baseURL!);
		await bo.goto(`/channels/${room}`);
		await expect(bo.locator('[aria-label="editable markdown"]')).toHaveAttribute(
			"contenteditable",
			"true",
			{ timeout: 20_000 },
		);
		await bo.getByRole("group", { name: "Document view" })
			.getByRole("button", { name: "Document", exact: true })
			.click();
		await expect(documentEditor(bo)).toBeVisible();
		await documentEditor(bo).fill("Collaborative prose arrived.");
		await expect(documentEditor(ana)).toContainText(
			"Collaborative prose arrived.",
		);
	} finally {
		await boContext.close();
	}

	await ana.locator("#workspace-conversation-heading").press("Escape");
	await expect(ana.locator('[data-document-view="plan"]')).toBeVisible();
	await expect(nav.getByRole("button", { name: "Document" })).toHaveAttribute(
		"aria-current",
		"page",
	);
});

test("an edit received while compact Plan is hidden appears when it returns", async ({ join, seed }) => {
	await seed(TWO_BLOCKS);
	let ana = await join("ana", { viewport: { width: 390, height: 844 } });
	let bo = await join("bo", { viewport: { width: 1280, height: 800 } });
	let nav = ana.getByRole("navigation", { name: "Workspace view" });
	await nav.getByRole("button", { name: /Conversation/ }).click();

	await rewriteFirstBlock(bo, "The hidden plan still receives collaborative edits.");
	await nav.getByRole("button", { name: "Document" }).click();
	await expect(content(ana)).toContainText("The hidden plan still receives collaborative edits.");
});

for (
	let example of [
		{ compact: true, name: "compact", width: 768 },
		{ compact: false, name: "desktop", width: 1280 },
	]
) {
	test(`${example.name} Decisions navigation follows the active presentation`, async ({ join, page: browser, seed }) => {
		await browser.setViewportSize({ width: example.width, height: 360 });
		await seed(LONG_PLAN);
		let page = await join("ana");
		let decisions = page.getByRole("button", { name: /^Decisions/ });
		let plan = page.getByRole("button", { name: "Document", exact: true });
		let stack = page.locator("[data-plan-decisions-scroll]");
		let first = questionnaire(page).first();

		await decisions.click();
		if (example.compact) await expect(page.locator("#workspace-decisions-heading")).toBeFocused();
		else await expect(first).toBeFocused();

		await stack.evaluate(element => {
			element.scrollTop = element.scrollHeight;
			element.dispatchEvent(new Event("scroll"));
		});
		let scrolled = await stack.evaluate(element => element.scrollTop);
		expect(scrolled).toBeGreaterThan(0);

		await plan.click();
		await decisions.click();
		if (example.compact) {
			await expect.poll(() => stack.evaluate(element => element.scrollTop)).toBe(scrolled);
			await expect(page.locator("#workspace-decisions-heading")).toBeFocused();
		} else {
			await expect.poll(() => stack.evaluate(element => element.scrollTop)).toBeLessThan(scrolled);
			await expect(first).toBeFocused();
		}
	});
}

test("an unanswered inline decision is also shown in Decisions and can be focused in Plan", async ({ join, seed }) => {
	await seed(ANCHORED, {
		revision: 1,
		questions: [{
			id: WIDGET,
			status: "open",
			definition: ANCHORED_DEFINITION,
			anchors: {
				widget: WIDGET,
				questions: {
					[QUESTION]: {
						anchors: [{ epoch: "stale", position: "", digest: ANCHORED_DIGEST }],
						pending: false,
					},
				},
			},
		}],
		openQuestions: [{
			id: WIDGET,
			definition: ANCHORED_DEFINITION,
			widget: WIDGET,
			model: storedQuestion(ANCHORED_DEFINITION),
			revision: 0,
		}],
	});
	let page = await join("ana");
	let inline = page.locator(
		`[data-document-view="plan"] article[data-plan-sidecar-questionnaire="${WIDGET}"]`,
	);

	await expect(content(page).getByText("Anchored paragraph.", { exact: true })).toBeVisible();
	await expect(inline).toHaveCount(1);
	await expect(inline).toBeVisible();
	await expect(inline).toContainText("How should we deploy?");

	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(page).filter({ hasText: "How should we deploy?" });
	await expect(card).toHaveCount(1);
	await card.getByRole("button", { name: /How should we deploy.*show in plan/ }).click();

	await expect(page.getByRole("button", { name: "Document", exact: true }))
		.toHaveAttribute("aria-pressed", "true");
	await expect(
		page.locator(
			`[data-document-view="plan"] article[data-plan-sidecar-questionnaire="${WIDGET}"]`,
		),
	).toBeFocused();
});

test("decision cards save independently with progressive custom answers", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let storage = questionnaire(page).filter({ has: page.getByRole("heading", { name: "Storage" }) });
	let scope = questionnaire(page).filter({ has: page.getByRole("heading", { name: "Scope" }) });
	let saveStorage = storage.getByRole("button", { name: "Save answer" });

	await expect(storage.getByRole("textbox", { name: /Custom answer for/ })).toHaveCount(0);
	await expect(scope.getByRole("textbox", { name: /Custom answer for/ })).toHaveCount(0);
	let check = saveStorage.locator('svg[data-plan-icon="check"]');
	await expect(check).toHaveCount(1);
	await expect(check).toHaveAttribute("aria-hidden", "true");

	await storage.getByRole("radio", { name: /On disk as MDX/ }).check();
	await saveStorage.click();
	await expect(scope).toBeVisible();
	await expect(scope).toBeFocused();
	await expect(scope.getByRole("button", { name: "Save answer" })).toBeVisible();
	await expect(scope).not.toContainText("Answered by");
	await expect(scope.getByRole("checkbox", { name: "Anchors" })).not.toBeChecked();

	let history = page.getByRole("button", { name: "1 resolved" });
	await history.focus();
	await page.keyboard.press("Space");
	let historyContent = page.locator('[data-motion-disclosure="decision-history"]');
	await expect(historyContent).toBeVisible();
	let historyId = await historyContent.getAttribute("id");
	expect(historyId).toBeTruthy();
	await expect(history).toHaveAttribute("aria-controls", historyId!);
	await expect(historyContent).not.toHaveClass(/is-closing/);
	let resolved = questionnaire(page).filter({ hasText: "Where should room state live?" });
	await expect(resolved).toContainText("On disk as MDX");
	await expect(resolved).toContainText("Answered by @ana");
	await expect(resolved.getByRole("button", { name: "Save answer" })).toHaveCount(0);
	await page.keyboard.press("Space");
	await expect(history).not.toHaveAttribute("aria-controls");
	await expect(historyContent).toHaveCount(0);

	let customChoice = scope.getByRole("checkbox", { name: "Write a custom answer" });
	await customChoice.focus();
	await page.keyboard.press("Space");
	let custom = scope.getByRole("textbox", { name: "Custom answer for Scope" });
	await expect(custom).toBeFocused();
	await scope.getByRole("button", { name: "Save answer" }).click();
	await expect(scope.getByRole("alert")).toBeVisible();
	await custom.fill("Only collaborative anchors");
	await scope.getByRole("checkbox", { name: "Anchors" }).check();
	await expect(custom).toHaveCount(0);
	await customChoice.check();
	custom = scope.getByRole("textbox", { name: "Custom answer for Scope" });
	await expect(custom).toHaveValue("Only collaborative anchors");
	await expect(custom).toBeFocused();
	await scope.getByRole("button", { name: "Save answer" }).click();
	await expect(questionnaire(page).filter({ hasText: "Which of these belong in the first cut?" }))
		.toContainText("Only collaborative anchors");
});

test("an unanswered decision reports its own validation error", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(page).filter({ has: page.getByRole("heading", { name: "Scope" }) });

	await card.getByRole("button", { name: "Save answer" }).click();

	await expect(card.getByRole("alert")).toBeVisible();
	await expect(card).not.toContainText("Answered by");
});

test("cancelling asks first", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(page).filter({ has: page.getByRole("heading", { name: "Scope" }) });

	await card.getByRole("button", { name: "Cancel" }).click();

	let keep = card.getByRole("button", { name: "Keep it" });
	await expect(keep).toBeVisible();
	await keep.click();
	await expect(card.getByRole("button", { name: "Save answer" })).toBeVisible();
});

test("a compact new-comment sheet blocks navigation and restores editor focus", async ({ join, seed }) => {
	await seed(TWO_BLOCKS);
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	let editor = content(page);
	let plan = page.getByRole("button", { name: "Document", exact: true });
	let decisions = page.getByRole("button", { name: /^Decisions/ });

	let openDraft = async () => {
		await editor.locator("p").nth(1).selectText();
		await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
		let sheet = page.getByRole("dialog", { name: "New comment" });
		await expect(sheet).toHaveAttribute("aria-modal", "true");
		await expect(sheet.getByPlaceholder("Comment on this passage…")).toBeFocused();
		return sheet;
	};

	let sheet = await openDraft();
	let destination = await decisions.boundingBox();
	expect(destination).not.toBeNull();
	await page.mouse.click(
		destination!.x + destination!.width / 2,
		destination!.y + destination!.height / 2,
	);
	await expect(sheet).toBeVisible();
	await expect(plan).toHaveAttribute("aria-pressed", "true");
	await sheet.getByRole("button", { name: "Cancel" }).click();
	await expect(sheet).toHaveCount(0);
	await expect(editor).toBeFocused();

	sheet = await openDraft();
	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);
	await expect(editor).toBeFocused();
});

test("submitting a compact new comment restores editor focus", async ({ join, seed }) => {
	await seed(TWO_BLOCKS);
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	let editor = content(page);
	await editor.locator("p").nth(1).selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let sheet = page.getByRole("dialog", { name: "New comment" });
	await sheet.getByPlaceholder("Comment on this passage…").fill("Keep this block as well.");
	await sheet.getByRole("button", { name: "Comment" }).click();

	await expect(sheet).toHaveCount(0);
	await expect(editor).toBeFocused();
});

for (let resolution of ["Accept", "Dismiss"] as const) {
	test(`${resolution.toLowerCase()}ing a compact comment restores editor focus`, async ({ join, seed }) => {
		await seed(PROSE);
		let page = await join("ana", {
			hasTouch: true,
			isMobile: true,
			viewport: { width: 390, height: 844 },
		});
		let editor = content(page);
		let sheet = await thread(page);
		await sheet.getByRole("button", { name: resolution }).click();
		await sheet.getByRole("button", { name: "Sure?" }).click();

		await expect(sheet).toHaveCount(0);
		await expect(editor).toBeFocused();
	});
}

test("an unavailable comment position keeps its compact sheet mounted until geometry recovers", async ({ join, seed }) => {
	await seed(TALL_PASSAGE);
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 300 },
	});
	let editor = content(page);
	await editor.locator("p").first().selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let draft = page.getByRole("dialog", { name: "New comment" });
	await draft.getByPlaceholder("Comment on this passage…").fill("Keep the whole passage.");
	await draft.getByRole("button", { name: "Comment" }).click();

	let marker = commentButton(page).last();
	await expect(marker).toBeAttached();
	await marker.click();
	let sheet = page.getByRole("dialog", { name: "Comment thread" });
	let close = sheet.getByRole("button", { name: "Close comment" });
	await expect(close).toBeFocused();

	// No 44px point can fit inside this host. The marker moves beyond the passage,
	// but the open sheet and its focus must not be unmounted while geometry changes.
	await page.setViewportSize({ width: 32, height: 300 });
	await expect(marker).toBeAttached();
	await expect(sheet).toBeVisible();
	await expect(close).toBeFocused();
	let markerBox = await marker.boundingBox();
	let documentBox = await page.locator("[data-plan-scroll]").boundingBox();
	expect(markerBox).not.toBeNull();
	expect(documentBox).not.toBeNull();
	expect(markerBox!.y).toBeGreaterThanOrEqual(documentBox!.y + documentBox!.height);

	await page.setViewportSize({ width: 390, height: 700 });
	await expect(sheet).toBeVisible();
	await expect(close).toBeFocused();
	await expect(marker).toBeAttached();
	await expect.poll(async () => {
		markerBox = await marker.boundingBox();
		documentBox = await page.locator("[data-plan-scroll]").boundingBox();
		return !!markerBox && !!documentBox
			&& markerBox.y < documentBox.y + documentBox.height
			&& markerBox.y + markerBox.height > documentBox.y;
	}).toBe(true);
});

test("a touch comment opens as a modal sheet and restores its marker", async ({ join, seed }) => {
	await seed(TWO_BLOCKS);
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	await secondThread(page);
	let marker = commentButton(page).first();
	let markerBox = await marker.boundingBox();
	expect(markerBox).not.toBeNull();
	expect(markerBox!.width).toBeGreaterThanOrEqual(44);
	expect(markerBox!.height).toBeGreaterThanOrEqual(44);
	let markerBoxes = await commentButton(page).evaluateAll(buttons =>
		buttons.map(button => {
			let box = button.getBoundingClientRect();
			return { bottom: box.bottom, left: box.left, right: box.right, top: box.top };
		})
	);
	expect(
		markerBoxes.every((box, index) =>
			markerBoxes.slice(index + 1).every(other =>
				box.right <= other.left || other.right <= box.left
				|| box.bottom <= other.top || other.bottom <= box.top
			)
		),
	).toBe(true);
	let passages = await page.locator("[data-plan-comment-hit]").evaluateAll(hits =>
		hits.map(hit => {
			let box = hit.getBoundingClientRect();
			return { bottom: box.bottom, left: box.left, right: box.right, top: box.top };
		})
	);
	expect(passages.every(passage =>
		markerBox!.x >= passage.right
		|| markerBox!.x + markerBox!.width <= passage.left
		|| markerBox!.y >= passage.bottom
		|| markerBox!.y + markerBox!.height <= passage.top
	)).toBe(true);

	await marker.tap();
	let sheet = page.getByRole("dialog", { name: "Comment thread" });
	await expect(sheet).toBeVisible();
	await expect(sheet.getByRole("button", { name: "Close comment" })).toBeFocused();
	await expect(content(page)).toHaveAttribute("inert", "");
	await expect.poll(async () => {
		let sheetBox = await sheet.boundingBox();
		let documentBox = await page.locator("[data-plan-scroll]").boundingBox();
		if (!sheetBox || !documentBox) return Number.POSITIVE_INFINITY;
		return Math.abs(
			sheetBox.y + sheetBox.height - documentBox.y - documentBox.height,
		);
	}).toBeLessThan(0.5);
	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);
	await expect(marker).toBeFocused();
	await expect(content(page)).not.toHaveAttribute("inert", "");
});

test("a wrapped passage opens its comment without intercepting text selection", async ({ join, page: browser, seed }) => {
	// The compact document forces the injected quote across two lines.
	await browser.setViewportSize({ width: 390, height: 600 });
	await seed(PROSE);
	let page = await join("ana");
	let hits = page.locator("[data-plan-comment-hit]");

	await expect.poll(() => hits.count()).toBeGreaterThan(1);
	let hit = await hits.first().boundingBox();
	expect(hit).not.toBeNull();
	let point = { x: hit!.x + hit!.width / 2, y: hit!.y + hit!.height / 2 };

	await page.mouse.move(point.x, point.y);
	let preview = page.getByRole("tooltip");
	await expect(preview).toContainText(QUOTED);
	let pageBox = await page.locator("[data-plan-scroll]").boundingBox();
	let previewBox = await preview.boundingBox();
	expect(pageBox).not.toBeNull();
	expect(previewBox).not.toBeNull();
	expect(previewBox!.x).toBeGreaterThanOrEqual(pageBox!.x);
	expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(pageBox!.x + pageBox!.width);

	await page.mouse.click(point.x, point.y);
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toBeVisible();
	await page.keyboard.press("Escape");

	// The hit region observes clicks at the document host; it cannot become a
	// glass pane that eats the native drag Lexical uses to select prose.
	await page.mouse.move(hit!.x + 3, point.y);
	await page.mouse.down();
	await page.mouse.move(hit!.x + hit!.width - 3, point.y, { steps: 8 });
	await page.mouse.up();
	expect(await page.evaluate(() => getSelection()?.toString().length ?? 0)).toBeGreaterThan(0);
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toHaveCount(0);
});

test("leaving a second comment gutter clears its preview", async ({ join, seed }) => {
	await seed(TWO_BLOCKS);
	let page = await join("ana");
	await secondThread(page);

	let hit = await page.locator("[data-plan-comment-hit]").first().boundingBox();
	expect(hit).not.toBeNull();
	await page.mouse.move(hit!.x + hit!.width / 2, hit!.y + hit!.height / 2);
	await expect(page.getByRole("tooltip")).toBeVisible();

	await commentButton(page).nth(1).hover();
	await expect(page.getByRole("tooltip")).toBeVisible();
	let blank = await content(page).locator("p").nth(1).boundingBox();
	expect(blank).not.toBeNull();
	await page.mouse.move(blank!.x + blank!.width - 4, blank!.y + blank!.height / 2);
	await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("clicking a comment button pins its document card and preserves the related wash", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = await thread(page);
	await expect(card).toContainText("@dev");
	await expect(card.getByPlaceholder("Reply…")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toHaveCount(0);
	card = await thread(page);

	await expect.poll(() => washed(page)).toBeGreaterThan(0);
	await content(page).hover();
	await expect.poll(() => washed(page)).toBeGreaterThan(0);
});

test("a live text edit preserves its document comment", async ({ join, seed }) => {
	await seed(TWO_BLOCKS);
	let page = await join("ana");

	await rewriteFirstBlock(page, "The room has a new persistence rule.");
	await expect(content(page)).toContainText("The room has a new persistence rule.");
	await expect.poll(() => washed(page)).toBeGreaterThan(0);
	await expect(commentButton(page)).toBeVisible();
});

test("a removed subject block moves its comment to document orphan chrome", async ({ join, seed }) => {
	await seed(TWO_BLOCKS);
	let page = await join("ana");

	let first = content(page).locator("p").first();
	await first.selectText();
	await page.keyboard.press("Backspace");
	await page.keyboard.press("Backspace");

	let orphaned = page.getByRole("button", { name: "1 orphaned comments" });
	await expect(orphaned).toBeVisible();
	await orphaned.click();
	await expect(page.getByRole("dialog", { name: "Orphaned comments" })).toContainText(QUOTED);
});

test("a compact orphan sheet owns focus and restores its opener", async ({ join, seed }) => {
	await seed(TWO_BLOCKS);
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	let first = content(page).locator("p").first();
	await first.selectText();
	await page.keyboard.press("Backspace");
	await page.keyboard.press("Backspace");

	let opener = page.getByRole("button", { name: "1 orphaned comments" });
	await opener.tap();
	let sheet = page.getByRole("dialog", { name: "Orphaned comments" });
	await expect(sheet).toHaveAttribute("aria-modal", "true");
	await expect(sheet.getByRole("button", { name: "Close comment" })).toBeFocused();
	await expect(content(page)).toHaveAttribute("inert", "");
	await page.keyboard.press("Shift+Tab");
	await expect(sheet.getByRole("button", { name: "Dismiss" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(sheet).toHaveCount(0);
	await expect(opener).toBeFocused();
	await expect(content(page)).not.toHaveAttribute("inert", "");
});

test("a remotely orphaned compact comment closes its sheet and restores editor focus", async ({ join, seed }) => {
	await seed(TWO_BLOCKS);
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	let editor = content(page);
	let sheet = await thread(page);
	await expect(sheet.getByRole("button", { name: "Close comment" })).toBeFocused();

	let collaborator = await join("bo");
	let subject = content(collaborator).locator("p").first();
	await subject.selectText();
	await collaborator.keyboard.press("Backspace");
	await collaborator.keyboard.press("Backspace");

	await expect(sheet).toHaveCount(0);
	await expect(editor).toBeFocused();
	await expect(editor).not.toHaveAttribute("inert", "");
	await expect(page.getByRole("button", { name: "1 orphaned comments" })).toBeVisible();
});

function washed(page: import("@playwright/test").Page): Promise<number> {
	return page.evaluate(() => CSS.highlights.get("plan-related")?.size ?? 0);
}

test("a reply joins the thread, and the quote counts it", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = await thread(page);

	await expect(card.getByText(/repl(y|ies)$/)).toHaveCount(0);
	await card.getByPlaceholder("Reply…").fill("Still right, but say why.");
	await card.getByRole("button", { name: "Reply" }).click();
	await expect(card).toContainText("Still right, but say why.");
	await expect(card).toContainText("@ana");
	await expect(card.getByText("1 reply")).toBeVisible();
	await expect(commentButton(page)).toHaveAccessibleDescription("1 reply waiting.");
});

test("accepting asks twice, and says so in the transcript", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = await thread(page);

	await card.getByRole("button", { name: "Accept" }).click();
	await expect(card.getByRole("button", { name: "Sure?" })).toBeVisible();
	await card.getByRole("button", { name: "Sure?" }).click();
	await expect(page.getByText(/accepted a comment on/)).toBeVisible();
	await expect(
		page.getByText("The agent is not running, so the plan has not been revised."),
	).toBeVisible();
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toHaveCount(0);
	await expect(commentButton(page)).toHaveCount(0);
	await expect(content(page).locator("article").filter({ hasText: QUOTED })).toContainText(QUOTED);
});

test("a dismissed thread removes its document button", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let card = await thread(page);

	await card.getByRole("button", { name: "Dismiss" }).click();
	await card.getByRole("button", { name: "Sure?" }).click();
	await expect(commentButton(page)).toHaveCount(0);
});
