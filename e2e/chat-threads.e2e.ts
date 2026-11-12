import AxeBuilder from "@axe-core/playwright";

import { chatInput } from "./chat-input";
import { expectNoHorizontalOverflow } from "./responsive";
import { expect, ready, test } from "./room";

import type { Locator, Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

function chatPane(page: Page): Locator {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

function mainColumn(page: Page): Locator {
	return chatPane(page).locator(".chat-split-main");
}

function threadPanel(page: Page): Locator {
	return page.locator("[data-thread-panel]");
}

async function sendInScope(scope: Locator, text: string): Promise<void> {
	let input = chatInput(scope);
	await input.fill(text);
	await scope.getByRole("button", { name: "Send message" }).click();
}

/** A finger held on a message, which brings up its toolbar on a touch screen. */
async function longPress(page: Page, target: Locator): Promise<void> {
	let box = (await target.boundingBox())!;
	let point = { x: box.x + 24, y: box.y + Math.min(8, box.height / 2) };
	let session = await page.context().newCDPSession(page);
	await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
	await page.waitForTimeout(700);
	await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await session.detach();
}

async function openPhoneChat(page: Page): Promise<void> {
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	await expect(chatInput(chatPane(page))).toBeVisible();
	await expect.poll(async () => (await chatPane(page).boundingBox())?.x).toBe(0);
}

test("opens a thread, syncs replies and summary rows to a second collaborator, passes axe, and returns focus on Escape", async ({ join, seed }) => {
	await seed("# Thread collaboration\nKeep side questions focused.\n");

	let ana = await join("ana", { viewport: { width: 1600, height: 900 } });
	let cy = await join("cy", { viewport: { width: 1440, height: 900 } });

	let anaMain = mainColumn(ana);
	let cyMain = mainColumn(cy);

	await sendInScope(anaMain, "Root: should we index forked_at?");
	let rootMessage = anaMain.locator(".chat-message-body", {
		hasText: "Root: should we index forked_at?",
	});
	await expect(rootMessage).toBeVisible();
	await expect(
		cyMain.locator(".chat-message-body", { hasText: "Root: should we index forked_at?" }),
	).toBeVisible();

	await rootMessage.hover();
	await rootMessage.getByRole("button", { name: "Reply in thread" }).click();

	let panel = threadPanel(ana);
	await expect(panel).toBeVisible();
	await expect(panel.locator("[data-thread-provenance]")).toContainText(
		"chopin remembers everything up to here.",
	);
	await expect(rootMessage).toHaveAttribute("data-thread-root-open", "true");
	await expect(chatInput(panel)).toBeFocused();

	await sendInScope(panel, "Yes, composite (channel_id, forked_at) keeps listing ordered.");
	await expect(
		panel.getByText("Yes, composite (channel_id, forked_at) keeps listing ordered."),
	).toBeVisible();

	// Main Chat updates with "1 reply", and the second collaborator sees it live.
	await expect(rootMessage.locator("[data-thread-summary]")).toContainText("1 reply");
	let cySummary = cyMain
		.locator(".chat-message-body", { hasText: "Root: should we index forked_at?" })
		.locator("[data-thread-summary]");
	await expect(cySummary).toContainText("1 reply");

	// Second collaborator opens the thread from the summary row and replies.
	await cySummary.click();
	let cyPanel = threadPanel(cy);
	await expect(
		cyPanel.getByText("Yes, composite (channel_id, forked_at) keeps listing ordered."),
	).toBeVisible();
	await sendInScope(cyPanel, "Agreed, adding that index to migration 037.");

	await expect(panel.getByText("Agreed, adding that index to migration 037.")).toBeVisible();
	await expect(rootMessage.locator("[data-thread-summary]")).toContainText("2 replies");

	// Accessibility check on the thread panel and main Chat's summary row (excluding the existing
	// contenteditable combobox, as chat-attachments.e2e.ts does).
	let axe = await new AxeBuilder({ page: ana })
		.include("[data-thread-panel]")
		.include("[data-thread-summary]")
		.exclude(".composer-draft-input")
		.analyze();
	expect(axe.violations.map(v => `${v.id}: ${v.help}`)).toEqual([]);

	// Escape closes the thread panel and restores focus to the root message's thread control/summary.
	await chatInput(panel).focus();
	await ana.keyboard.press("Escape");
	await expect(panel).toHaveCount(0);
	await expect(rootMessage).not.toHaveAttribute("data-thread-root-open", "true");
	await expect.poll(() =>
		ana.evaluate(() => {
			let active = document.activeElement;
			return !!active?.closest("[data-thread-summary], [data-thread-trigger]");
		})
	).toBe(true);
});

test("forks the Planner session at the root message without leaking into main Chat, and supports Also send to Chat", async ({ join, seed }) => {
	await seed("# Session fork plan\nVerify exact fork point.\n");

	let ana = await join("ana", { viewport: { width: 1600, height: 900 } });
	let cy = await join("cy", { viewport: { width: 1440, height: 900 } });
	let anaMain = mainColumn(ana);
	let cyMain = mainColumn(cy);

	await sendInScope(anaMain, "Root context before fork: use expand-only tables.");
	await expect(
		anaMain.locator(".chat-message-body", {
			hasText: "Root context before fork: use expand-only tables.",
		}),
	).toBeVisible();

	await sendInScope(anaMain, "Later main message after fork point.");
	await expect(
		anaMain.locator(".chat-message-body", {
			hasText: "Later main message after fork point.",
		}),
	).toBeVisible();

	// Start a thread at the root message (before the later main message).
	let rootMsg = anaMain.locator(".chat-message-body", {
		hasText: "Root context before fork: use expand-only tables.",
	});
	await rootMsg.hover();
	await rootMsg.getByRole("button", { name: "Reply in thread" }).click();

	let panel = threadPanel(ana);
	await sendInScope(panel, "@chopin THREAD-ECHO side question one");

	await expect(
		panel.getByText("Context seen:", { exact: false }),
	).toBeVisible();
	let firstReplyText = await panel
		.locator(".chat-message-body", { hasText: "Context seen:" })
		.first()
		.innerText();
	expect(firstReplyText).toContain("Root context before fork: use expand-only tables.");
	expect(firstReplyText).not.toContain("Later main message after fork point.");

	// Second Planner turn in the thread accumulates the first side question and answer.
	await sendInScope(panel, "@chopin THREAD-ECHO side question two");
	await expect(panel.locator(".chat-message-body", { hasText: "Context seen:" })).toHaveCount(2);
	let secondReplyText = await panel
		.locator(".chat-message-body", { hasText: "Context seen:" })
		.nth(1)
		.innerText();
	expect(secondReplyText).toContain("side question one");
	expect(secondReplyText).not.toContain("Later main message after fork point.");

	// Top-level Chat never saw the side thread's messages.
	await expect(anaMain.getByText("side question one")).toHaveCount(0);

	// Check "Also send to Chat" and post a conclusion: appears in both the thread and main Chat.
	let alsoCheckbox = panel.getByLabel("Also send to Chat");
	await alsoCheckbox.check();
	await expect(alsoCheckbox).toBeChecked();
	await sendInScope(panel, "Thread conclusion: keep sidecar keys untouched.");

	await expect(
		panel.getByText("Thread conclusion: keep sidecar keys untouched."),
	).toBeVisible();
	await expect(
		anaMain.getByText("Thread conclusion: keep sidecar keys untouched."),
	).toBeVisible();
	await expect(
		cyMain.getByText("Thread conclusion: keep sidecar keys untouched."),
	).toBeVisible();
	await expect(alsoCheckbox).not.toBeChecked();
});

test("renders harness context ring and expandable compaction divider", async ({ join, seed }) => {
	await seed("# Compaction and context\nTrack token window and compactions.\n");
	let ana = await join("ana", { viewport: { width: 1600, height: 900 } });
	let anaMain = mainColumn(ana);

	await sendInScope(anaMain, "@chopin COMPACT-TURN");
	await expect(
		anaMain.getByText("Compacted context and ready to continue."),
	).toBeVisible();

	let divider = anaMain.locator("[data-chat-compaction]");
	await expect(divider).toContainText("Earlier messages were summarized");
	await expect(divider).toContainText("32,441 tokens saved");
	await divider.getByRole("button").click();
	await expect(divider.locator("[data-chat-compaction-summary]")).toContainText(
		"Summarized earlier goals and storage trade-offs.",
	);

	let ring = anaMain.locator('[data-slot="composer-context"] > button');
	await expect(ring).toBeVisible();
	await ring.focus();
	await expect(
		anaMain.locator('[data-slot="composer-context"]'),
	).toContainText("42k / 128k");

	let axe = await new AxeBuilder({ page: ana })
		.include("[data-chat-compaction]")
		.include('[data-slot="composer-context"]')
		.analyze();
	expect(axe.violations.map(v => `${v.id}: ${v.help}`)).toEqual([]);
});

test("balances Chat, Thread and Document at 1600, collapses Document cleanly at 1280, and drags Resize thread", async ({ join, seed }) => {
	await seed("# Balanced split\nSlack-style split proportions.\n");

	let page = await join("ana", { viewport: { width: 1600, height: 900 } });
	let main = mainColumn(page);
	await sendInScope(main, "Check the split geometry.");
	let rootMsg = main.locator(".chat-message-body", { hasText: "Check the split geometry." });
	await expect(rootMsg).toBeVisible();
	await rootMsg.hover();
	await rootMsg.getByRole("button", { name: "Reply in thread" }).click();

	let panel = threadPanel(page);
	await expect(panel).toBeVisible();

	// At 1600x900: all three panes (Chat >= 420, Thread 360..560, Document >= 480) stay open.
	let docPanel = page.locator(".workspace-document-panel");
	await expect(docPanel).toBeVisible();
	await expect(page.locator("[data-collapsed-document-bar]")).toHaveCount(0);

	let [mainBox1600, threadBox1600, docBox1600] = await Promise.all([
		main.boundingBox(),
		page.locator(".chat-split-thread").boundingBox(),
		docPanel.boundingBox(),
	]);
	expect(mainBox1600!.width).toBeGreaterThanOrEqual(420);
	expect(threadBox1600!.width).toBeGreaterThanOrEqual(360);
	expect(threadBox1600!.width).toBeLessThanOrEqual(560);
	expect(docBox1600!.width).toBeGreaterThanOrEqual(480);

	// Drag the thread divider (`Resize thread`) left to widen the thread (at 1760px where there is headroom).
	await page.setViewportSize({ width: 1760, height: 900 });
	let handle = page.getByRole("separator", { name: "Resize thread" });
	let beforeThread = (await page.locator(".chat-split-thread").boundingBox())!.width;
	let handleBox = (await handle.boundingBox())!;
	await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(handleBox.x - 70, handleBox.y + handleBox.height / 2, { steps: 5 });
	await page.mouse.up();
	let afterThread = (await page.locator(".chat-split-thread").boundingBox())!.width;
	expect(afterThread).toBeGreaterThan(beforeThread + 40);

	// Reset custom thread width and resize to 1280x900: Document collapses to its top bar and Chat/Thread split ~60/40.
	await page.evaluate(() => localStorage.removeItem("chopin:pane:thread"));
	await page.reload();
	await ready(page);
	await page.setViewportSize({ width: 1280, height: 900 });
	let reloadedRoot = mainColumn(page).locator(".chat-message-body", {
		hasText: "Check the split geometry.",
	});
	await reloadedRoot.hover();
	await reloadedRoot.getByRole("button", { name: "Reply in thread" }).click();

	let collapsedBar = page.locator("[data-collapsed-document-bar]");
	await expect(collapsedBar).toBeVisible();
	await expect(docPanel).toBeHidden();

	let [mainBox1280, threadBox1280] = await Promise.all([
		mainColumn(page).boundingBox(),
		page.locator(".chat-split-thread").boundingBox(),
	]);
	expect(mainBox1280!.width).toBeGreaterThanOrEqual(420);
	expect(threadBox1280!.width).toBeGreaterThanOrEqual(360);
	let ratio = threadBox1280!.width / (mainBox1280!.width + threadBox1280!.width);
	expect(ratio).toBeGreaterThan(0.35);
	expect(ratio).toBeLessThan(0.45);

	// Clicking "Show document" in the collapsed strip closes the thread and restores the document.
	await page.locator("[data-collapsed-document-open]").click();
	await expect(threadPanel(page)).toHaveCount(0);
	await expect(docPanel).toBeVisible();
});

test("opens threads as a full-height sheet on phones with Back to Chat and no horizontal overflow", async ({ join, seed }) => {
	await seed("# Phone threads\nMobile full-height thread sheet.\n");

	let page = await join("ana", PHONE);
	await openPhoneChat(page);

	let chat = chatPane(page);
	await sendInScope(chat, "Phone root message");
	let rootMsg = chat.locator(".chat-message-body", { hasText: "Phone root message" });
	await expect(rootMsg).toBeVisible();

	// On a touch screen Reply in thread is in the toolbar a long press brings up.
	await longPress(page, rootMsg);
	await rootMsg.getByRole("button", { name: "Reply in thread" }).tap();
	let sheet = page.locator("[data-thread-panel][data-thread-sheet]");
	await expect(sheet).toBeVisible();
	let sheetBox = (await sheet.boundingBox())!;
	expect(sheetBox.width).toBeCloseTo(390, 1);
	expect(sheetBox.height).toBeCloseTo(844, 1);

	await sendInScope(sheet, "Reply from phone sheet");
	await expect(sheet.getByText("Reply from phone sheet")).toBeVisible();
	await expectNoHorizontalOverflow(page);

	await sheet.getByRole("button", { name: "Back to Chat" }).click();
	await expect(sheet).toHaveCount(0);
	await expect(rootMsg.locator("[data-thread-summary]")).toContainText("1 reply");
});
